/**
 * Pure derivation: balances are ALWAYS opening + Σ(posted transaction|trade),
 * recomputed from scratch for the affected range — never incrementally accumulated
 * (spec §4.3.5). Anchors (valuations) never override; they are assertions checked
 * by the invariant cron, met through materialized adjustment entries (ADR-2).
 */
import { sql } from "drizzle-orm";
import { addDays, format } from "date-fns";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { add } from "@/lib/money";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

const day = (d: Date) => format(d, "yyyy-MM-dd");

/** Derived balance at end of `date` (posted/reconciled deltas only). */
export async function computeBalanceAt(
  ex: Executor,
  accountId: string,
  date: string,
): Promise<string> {
  const res = await ex.execute(sql`
    SELECT (a.opening_balance + COALESCE((
      SELECT SUM(e.amount) FROM entries e
      WHERE e.account_id = a.id
        AND e.entry_type IN ('transaction', 'trade')
        AND e.status <> 'pending'
        AND e.deleted_at IS NULL
        AND e.date <= ${date}
    ), 0))::numeric(19,4)::text AS bal
    FROM accounts a WHERE a.id = ${accountId}
  `);
  const row = (res as unknown as { rows: { bal: string }[] }).rows[0];
  if (!row) throw new Error("account not found");
  return row.bal;
}

/**
 * Rebuild the daily balance series for one account from `fromDate` through
 * max(today, latest entry date). Idempotent; serialized per account via an
 * advisory transaction lock so concurrent server actions can't interleave.
 */
export async function rebuildBalances(db: Db, accountId: string, fromDate: string): Promise<void> {
  await db.transaction(async (tx) => {
    // namespace 1 = account locks; two-arg form avoids cross-domain hash collisions
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1, hashtext(${accountId}::text))`);

    const meta = await tx.execute(sql`
      SELECT GREATEST(CURRENT_DATE, COALESCE(MAX(e.date), CURRENT_DATE))::text AS end_date
      FROM entries e
      WHERE e.account_id = ${accountId} AND e.deleted_at IS NULL
    `);
    const endDate = (meta as unknown as { rows: { end_date: string }[] }).rows[0].end_date;
    if (fromDate > endDate) return;

    // balance at the day before the window
    const dayBefore = day(addDays(new Date(`${fromDate}T00:00:00Z`), -1));
    let running = await computeBalanceAt(tx, accountId, dayBefore);

    // per-day deltas inside the window, one SQL round trip
    const deltas = await tx.execute(sql`
      SELECT e.date::text AS d, SUM(e.amount)::numeric(19,4)::text AS delta
      FROM entries e
      WHERE e.account_id = ${accountId}
        AND e.entry_type IN ('transaction', 'trade')
        AND e.status <> 'pending'
        AND e.deleted_at IS NULL
        AND e.date >= ${fromDate} AND e.date <= ${endDate}
      GROUP BY e.date
    `);
    const deltaByDate = new Map(
      (deltas as unknown as { rows: { d: string; delta: string }[] }).rows.map((r) => [r.d, r.delta]),
    );

    const rows: { accountId: string; date: string; balance: string }[] = [];
    for (
      let cursor = new Date(`${fromDate}T00:00:00Z`);
      day(cursor) <= endDate;
      cursor = addDays(cursor, 1)
    ) {
      const d = day(cursor);
      const delta = deltaByDate.get(d);
      if (delta) running = add(running, delta);
      rows.push({ accountId, date: d, balance: running }); // no delta → LOCF
    }

    await tx.execute(
      sql`DELETE FROM balances WHERE account_id = ${accountId} AND date >= ${fromDate}`,
    );
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(schema.balances).values(rows.slice(i, i + 500));
    }
  });
}

/**
 * Market value of an investment account at `date`: Σ over instruments of
 * (units held as of date) × (latest price ≤ date). Missing price → cost basis
 * (buy_cost / buy_units) so a never-priced holding contributes its cost, never NaN.
 */
export async function holdingValueAt(ex: Executor, accountId: string, date: string): Promise<string> {
  const res = await ex.execute(sql`
    WITH lots AS (
      SELECT t.instrument_id,
             SUM(CASE WHEN t.side = 'buy' THEN t.units ELSE -t.units END) AS units,
             SUM(CASE WHEN t.side = 'buy' THEN t.units * t.price ELSE 0 END) AS buy_cost,
             SUM(CASE WHEN t.side = 'buy' THEN t.units ELSE 0 END) AS buy_units
      FROM entries e
      JOIN trades t ON t.entry_id = e.id
      WHERE e.account_id = ${accountId}
        AND e.status <> 'pending' AND e.deleted_at IS NULL AND e.date <= ${date}
      GROUP BY t.instrument_id
    ),
    priced AS (
      SELECT l.units,
             COALESCE(
               (SELECT p.nav FROM prices p WHERE p.instrument_id = l.instrument_id AND p.date <= ${date} ORDER BY p.date DESC LIMIT 1),
               CASE WHEN l.buy_units > 0 THEN l.buy_cost / l.buy_units ELSE 0 END
             ) AS mark
      FROM lots l
      WHERE l.units > 0
    )
    SELECT COALESCE(SUM(units * mark), 0)::numeric(19,4)::text AS val FROM priced
  `);
  return (res as unknown as { rows: { val: string }[] }).rows[0].val;
}

/** Net worth: non-investment accounts by cash balance, investment accounts by market value. */
export async function netWorth(ex: Executor, householdId: string, date: string): Promise<string> {
  const cash = await ex.execute(sql`
    SELECT COALESCE(SUM(a.opening_balance + COALESCE(s.total, 0)), 0)::numeric(19,4)::text AS nw
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT SUM(e.amount) AS total FROM entries e
      WHERE e.account_id = a.id
        AND e.entry_type IN ('transaction', 'trade')
        AND e.status <> 'pending' AND e.deleted_at IS NULL AND e.date <= ${date}
    ) s ON true
    WHERE a.household_id = ${householdId} AND a.status = 'active'
      AND NOT a.excluded AND a.kind <> 'investment'
  `);
  let total = (cash as unknown as { rows: { nw: string }[] }).rows[0].nw;

  const invest = await ex.execute(sql`
    SELECT a.id FROM accounts a
    WHERE a.household_id = ${householdId} AND a.status = 'active'
      AND NOT a.excluded AND a.kind = 'investment'
  `);
  for (const row of (invest as unknown as { rows: { id: string }[] }).rows) {
    total = add(total, await holdingValueAt(ex, row.id, date));
  }
  return total;
}

/**
 * Rebuild monthly category rollups for one household from `fromMonth` onward.
 * fromMonth must be 'YYYY-MM-01'. Pure recompute — never incremental.
 *
 * Entries counted: transaction type, not deleted, not pending, belonging to an
 * account in this household, NOT a leg of any transfer.
 *
 * Split handling: if an entry has transaction_splits rows, each split
 * (categoryId, amount) contributes; the parent contributes nothing.
 * Otherwise the entry itself contributes (transactions.categoryId, entries.amount).
 */
export async function rebuildRollups(
  db: Db,
  householdId: string,
  fromMonth: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // namespace 2 = household locks (see rebuildBalances for namespace 1)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(2, hashtext(${householdId}::text))`);

    // Delete existing rollup rows for this household from fromMonth onward
    await tx.execute(sql`
      DELETE FROM rollups
      WHERE household_id = ${householdId}
        AND month >= ${fromMonth}::date
    `);

    // Find the max entry month so we know the upper bound for new rows
    const meta = await tx.execute(sql`
      SELECT date_trunc('month', MAX(e.date))::date::text AS max_month
      FROM entries e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.household_id = ${householdId}
        AND e.entry_type = 'transaction'
        AND e.status <> 'pending'
        AND e.deleted_at IS NULL
        AND e.date >= ${fromMonth}::date
        AND NOT EXISTS (
            SELECT 1 FROM transfers tr
            WHERE tr.outflow_entry_id = e.id OR tr.inflow_entry_id = e.id
          )
    `);
    const maxMonthRaw = (meta as unknown as { rows: { max_month: string | null }[] }).rows[0].max_month;

    // If no entries exist from fromMonth onward, nothing to insert
    if (!maxMonthRaw) return;

    // Insert recomputed rollup rows using a single INSERT ... SELECT.
    // For entries with splits: use splits (categoryId, amount).
    // For entries without splits: use (transactions.categoryId, entries.amount).
    await tx.execute(sql`
      INSERT INTO rollups (household_id, month, category_id, amount)
      SELECT
        ${householdId}::uuid AS household_id,
        date_trunc('month', contrib.date)::date AS month,
        contrib.category_id,
        SUM(contrib.amount)::numeric(19,4) AS amount
      FROM (
        -- Entries WITHOUT splits: contribute as themselves
        SELECT e.date, t.category_id, e.amount
        FROM entries e
        JOIN accounts a ON a.id = e.account_id
        JOIN transactions t ON t.entry_id = e.id
        WHERE a.household_id = ${householdId}
          AND e.entry_type = 'transaction'
          AND e.status <> 'pending'
          AND e.deleted_at IS NULL
          AND e.date >= ${fromMonth}::date
          AND NOT EXISTS (
            SELECT 1 FROM transfers tr
            WHERE tr.outflow_entry_id = e.id OR tr.inflow_entry_id = e.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM transaction_splits ts WHERE ts.entry_id = e.id
          )

        UNION ALL

        -- Entries WITH splits: contribute each split
        SELECT e.date, ts.category_id, ts.amount
        FROM entries e
        JOIN accounts a ON a.id = e.account_id
        JOIN transaction_splits ts ON ts.entry_id = e.id
        WHERE a.household_id = ${householdId}
          AND e.entry_type = 'transaction'
          AND e.status <> 'pending'
          AND e.deleted_at IS NULL
          AND e.date >= ${fromMonth}::date
          AND NOT EXISTS (
            SELECT 1 FROM transfers tr
            WHERE tr.outflow_entry_id = e.id OR tr.inflow_entry_id = e.id
          )
      ) contrib
      GROUP BY date_trunc('month', contrib.date)::date, contrib.category_id
    `);
  });
}

/**
 * Convenience called by server actions after any ledger write.
 * Rebuilds balances for the affected account and rollups for the household
 * from the affected month onward.
 *
 * Locking contract: this runs as two transactions (account lock ns 1, then
 * household lock ns 2) in a FIXED order. rebuildRollups must only ever be
 * reached through this function (or with the household lock already held) —
 * never take the locks in the opposite order, or concurrent writes deadlock.
 */
export async function afterWrite(
  db: Db,
  args: { accountId: string; householdId: string; date: string },
): Promise<void> {
  const fromMonth = args.date.slice(0, 7) + "-01";
  await rebuildBalances(db, args.accountId, args.date);
  await rebuildRollups(db, args.householdId, fromMonth);
}
