/**
 * Dashboard query helpers. All monetary return values are strings (never Number).
 * Reads only from rollups/balances/entries LIMIT 5 — no full entry scans except
 * recentTransactions.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { abs } from "@/lib/money";
import { getBridgeStatus } from "./bridge-status";

// ---------------------------------------------------------------------------
// monthSpend
// ---------------------------------------------------------------------------

/**
 * Absolute sum of NEGATIVE rollup amounts for the given month.
 * Includes uncategorized (null) rows only when they are negative.
 * Excludes income-classified categories entirely.
 */
export async function monthSpend(
  db: Db,
  householdId: string,
  month: string, // 'YYYY-MM-01'
): Promise<string> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(ABS(r.amount)), 0)::numeric(19,4)::text AS spend
    FROM rollups r
    WHERE r.household_id = ${householdId}::uuid
      AND r.month = ${month}::date
      AND r.amount < 0
      AND (
        r.category_id IS NULL
        OR EXISTS (
          SELECT 1 FROM categories c
          WHERE c.id = r.category_id
            AND c.classification = 'expense'
        )
      )
  `);
  return (res as unknown as { rows: { spend: string }[] }).rows[0].spend;
}

// ---------------------------------------------------------------------------
// monthSpendByCategory
// ---------------------------------------------------------------------------

export interface CategorySpend {
  categoryId: string | null;
  categoryName: string;
  amount: string; // positive (abs value)
}

/**
 * Top `limit` expense categories by spend desc plus an "Other" bucket for
 * the remainder. All amounts are absolute (positive) strings.
 */
export async function monthSpendByCategory(
  db: Db,
  householdId: string,
  month: string, // 'YYYY-MM-01'
  limit = 6,
): Promise<(CategorySpend & { isOther?: boolean })[]> {
  const res = await db.execute(sql`
    WITH ranked AS (
      SELECT
        r.category_id,
        COALESCE(c.name, 'Uncategorized') AS category_name,
        ABS(r.amount)::numeric(19,4)::text AS amount,
        ROW_NUMBER() OVER (ORDER BY ABS(r.amount) DESC) AS rn
      FROM rollups r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.household_id = ${householdId}::uuid
        AND r.month = ${month}::date
        AND r.amount < 0
        AND (
          r.category_id IS NULL
          OR c.classification = 'expense'
        )
    )
    SELECT
      category_id,
      category_name,
      amount,
      rn,
      false AS is_other
    FROM ranked
    WHERE rn <= ${limit}
    UNION ALL
    SELECT
      NULL AS category_id,
      'Other' AS category_name,
      COALESCE(SUM(amount::numeric), 0)::numeric(19,4)::text AS amount,
      ${limit + 1} AS rn,
      true AS is_other
    FROM ranked
    WHERE rn > ${limit}
    ORDER BY rn
  `);

  type Row = {
    category_id: string | null;
    category_name: string;
    amount: string;
    rn: number;
    is_other: boolean;
  };

  const rows = (res as unknown as { rows: Row[] }).rows;

  // Drop "Other" row if its amount is 0
  return rows
    .filter((r) => !(r.is_other && parseFloat(r.amount) === 0))
    .map((r) => ({
      categoryId: r.category_id,
      categoryName: r.category_name,
      amount: r.amount,
      ...(r.is_other ? { isOther: true } : {}),
    }));
}

// ---------------------------------------------------------------------------
// spendTrend
// ---------------------------------------------------------------------------

export interface SpendTrendPoint {
  month: string; // 'YYYY-MM'
  spend: string; // absolute (positive) string
}

/**
 * Monthly spend totals for the last `months` calendar months, oldest→newest.
 */
export async function spendTrend(
  db: Db,
  householdId: string,
  months = 6,
): Promise<SpendTrendPoint[]> {
  const res = await db.execute(sql`
    WITH months_series AS (
      SELECT
        to_char(
          date_trunc('month', CURRENT_DATE) - (gs.n || ' months')::interval,
          'YYYY-MM-01'
        )::date AS month_date
      FROM generate_series(${months - 1}, 0, -1) AS gs(n)
    ),
    spend_per_month AS (
      SELECT
        r.month,
        COALESCE(SUM(ABS(r.amount)), 0)::numeric(19,4) AS spend
      FROM rollups r
      WHERE r.household_id = ${householdId}::uuid
        AND r.amount < 0
        AND (
          r.category_id IS NULL
          OR EXISTS (
            SELECT 1 FROM categories c
            WHERE c.id = r.category_id
              AND c.classification = 'expense'
          )
        )
      GROUP BY r.month
    )
    SELECT
      to_char(ms.month_date, 'YYYY-MM') AS month,
      COALESCE(sp.spend, 0)::numeric(19,4)::text AS spend
    FROM months_series ms
    LEFT JOIN spend_per_month sp ON sp.month = ms.month_date
    ORDER BY ms.month_date
  `);

  return (res as unknown as { rows: { month: string; spend: string }[] }).rows;
}

// ---------------------------------------------------------------------------
// needsAttention
// ---------------------------------------------------------------------------

export interface StaleAnchor {
  accountId: string;
  accountName: string;
  lastAnchor: string | null; // 'YYYY-MM-DD' or null
}

export interface NeedsAttention {
  inbox: number;
  anomalies: number;
  staleAnchors: StaleAnchor[];
  hasAccounts: boolean;
  bridgeStatus: "never" | "stale" | "ok";
  unmappedCount: number;
}

/**
 * Returns counts of inbox items, open anomalies, and stale valuation anchors.
 * Inbox: pending non-deleted transaction entries for accounts in this household.
 * Stale anchors: accounts whose latest non-deleted valuation entry is > 60 days
 * old, or absent (lastAnchor = null), for epf|ppf|fd|loan|property|gold kinds.
 */
export async function needsAttention(
  db: Db,
  householdId: string,
): Promise<NeedsAttention> {
  // Inbox count: pending transaction entries in this household (not deleted)
  const inboxRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.household_id = ${householdId}::uuid
      AND e.entry_type = 'transaction'
      AND e.status = 'pending'
      AND e.deleted_at IS NULL
  `);
  const inbox = Number(
    (inboxRes as unknown as { rows: { cnt: number }[] }).rows[0].cnt,
  );

  // Anomalies: open (resolvedAt IS NULL)
  const anomaliesRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM ledger_anomalies
    WHERE resolved_at IS NULL
  `);
  const anomalies = Number(
    (anomaliesRes as unknown as { rows: { cnt: number }[] }).rows[0].cnt,
  );

  // Stale anchors — use IN (...) with raw enum values (safe: no user input)
  const staleRes = await db.execute(sql`
    SELECT
      a.id AS account_id,
      a.name AS account_name,
      latest.last_anchor
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT e.date::text AS last_anchor
      FROM entries e
      WHERE e.account_id = a.id
        AND e.entry_type = 'valuation'
        AND e.deleted_at IS NULL
      ORDER BY e.date DESC
      LIMIT 1
    ) latest ON true
    WHERE a.household_id = ${householdId}::uuid
      AND a.kind IN ('epf', 'ppf', 'fd', 'loan', 'property', 'gold')
      AND a.status = 'active'
      AND (
        latest.last_anchor IS NULL
        OR latest.last_anchor::date < CURRENT_DATE - INTERVAL '60 days'
      )
    ORDER BY a.name
  `);

  const staleAnchors: StaleAnchor[] = (
    staleRes as unknown as {
      rows: { account_id: string; account_name: string; last_anchor: string | null }[];
    }
  ).rows.map((r) => ({
    accountId: r.account_id,
    accountName: r.account_name,
    lastAnchor: r.last_anchor ?? null,
  }));

  // Accounts existence — drives the "No accounts yet" onboarding card.
  const accountsRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM accounts WHERE household_id = ${householdId}::uuid
  `);
  const hasAccounts =
    Number((accountsRes as unknown as { rows: { cnt: number }[] }).rows[0].cnt) > 0;

  // SMS sync status — drives "Connect SMS sync" / "hasn't checked in" cards.
  const { status: bridgeStatus } = await getBridgeStatus(db, householdId);

  // Open sms_unmapped anomalies specifically (the generic `anomalies` count above
  // includes sms_unparsed and any other future anomaly kind).
  const unmappedRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM ledger_anomalies
    WHERE kind = 'sms_unmapped' AND resolved_at IS NULL
  `);
  const unmappedCount = Number(
    (unmappedRes as unknown as { rows: { cnt: number }[] }).rows[0].cnt,
  );

  return { inbox, anomalies, staleAnchors, hasAccounts, bridgeStatus, unmappedCount };
}

// ---------------------------------------------------------------------------
// recentTransactions
// ---------------------------------------------------------------------------

export interface RecentTransaction {
  entryId: string;
  date: string;
  description: string;
  merchant: string | null;
  categoryName: string | null;
  accountName: string;
  amount: string; // signed
}

/**
 * Most recent `limit` posted non-deleted transaction entries for the household.
 */
export async function recentTransactions(
  db: Db,
  householdId: string,
  limit = 5,
): Promise<RecentTransaction[]> {
  const res = await db.execute(sql`
    SELECT
      e.id AS entry_id,
      e.date::text AS date,
      e.description,
      t.merchant,
      c.name AS category_name,
      a.name AS account_name,
      e.amount::numeric(19,4)::text AS amount
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.household_id = ${householdId}::uuid
      AND e.entry_type = 'transaction'
      AND e.deleted_at IS NULL
      AND e.status <> 'pending'
    ORDER BY e.date DESC, e.created_at DESC
    LIMIT ${limit}
  `);

  return (
    res as unknown as {
      rows: {
        entry_id: string;
        date: string;
        description: string;
        merchant: string | null;
        category_name: string | null;
        account_name: string;
        amount: string;
      }[];
    }
  ).rows.map((r) => ({
    entryId: r.entry_id,
    date: r.date,
    description: r.description,
    merchant: r.merchant ?? null,
    categoryName: r.category_name ?? null,
    accountName: r.account_name,
    amount: r.amount,
  }));
}
