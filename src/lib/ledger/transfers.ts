/**
 * Transfer auto-matching: links ATM withdrawals, credit-card payments, and
 * self-transfers as a transfers pair excluded from income/expense reporting.
 * Matches are proposed as 'pending'; the user confirms or rejects in the review inbox.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

interface CandidatePair {
  outflowEntryId: string;
  inflowEntryId: string;
  dateDiff: number;
  outflowDate: string;
}

/**
 * Discover candidate transfer pairs across all accounts in the household.
 * Uses a SQL self-join; greedy dedup happens in JS.
 *
 * Matching rules:
 * - Both entries: entryType = 'transaction', not deleted, status 'pending' or 'posted'
 * - Accounts belong to the same household, but are different accounts
 * - amounts exactly opposite (outflow negative, inflow positive)
 * - date difference ≤ 2 days
 * - neither entry already in transfers (either column)
 * - the (outflow, inflow) pair is not in rejected_transfers
 *
 * Returns count of new pending transfers created.
 */
export async function proposeTransfers(db: Db, householdId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      SELECT
        a.id          AS outflow_entry_id,
        b.id          AS inflow_entry_id,
        ABS(a.date::date - b.date::date) AS date_diff,
        a.date        AS outflow_date
      FROM entries a
      JOIN accounts acca ON acca.id = a.account_id
      JOIN entries b ON
            b.entry_type = 'transaction'
        AND b.deleted_at IS NULL
        AND b.status IN ('pending', 'posted')
        AND b.amount = -a.amount
        AND b.account_id <> a.account_id
        AND ABS(a.date::date - b.date::date) <= 2
      JOIN accounts accb ON accb.id = b.account_id AND accb.household_id = ${householdId}
      WHERE a.entry_type = 'transaction'
        AND a.deleted_at IS NULL
        AND a.status IN ('pending', 'posted')
        AND a.amount < 0
        AND acca.household_id = ${householdId}
        -- neither already in transfers
        AND NOT EXISTS (
          SELECT 1 FROM transfers t
          WHERE t.outflow_entry_id = a.id OR t.inflow_entry_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM transfers t
          WHERE t.outflow_entry_id = b.id OR t.inflow_entry_id = b.id
        )
        -- not rejected
        AND NOT EXISTS (
          SELECT 1 FROM rejected_transfers r
          WHERE r.outflow_entry_id = a.id AND r.inflow_entry_id = b.id
        )
      ORDER BY ABS(a.date::date - b.date::date) ASC, a.date ASC
    `);

    const rows = (res as unknown as { rows: {
      outflow_entry_id: string;
      inflow_entry_id: string;
      date_diff: number | string;
      outflow_date: string;
    }[] }).rows;

    // Greedy uniqueness: each entry may only be used once per run.
    const used = new Set<string>();
    const toInsert: CandidatePair[] = [];

    for (const row of rows) {
      const out = row.outflow_entry_id;
      const inf = row.inflow_entry_id;
      if (used.has(out) || used.has(inf)) continue;
      used.add(out);
      used.add(inf);
      toInsert.push({
        outflowEntryId: out,
        inflowEntryId: inf,
        dateDiff: Number(row.date_diff),
        outflowDate: row.outflow_date,
      });
    }

    if (toInsert.length === 0) return 0;

    for (const pair of toInsert) {
      await tx.insert(schema.transfers).values({
        outflowEntryId: pair.outflowEntryId,
        inflowEntryId: pair.inflowEntryId,
        status: "pending",
      });
    }

    return toInsert.length;
  });
}

async function logEvent(
  ex: Executor,
  entryId: string,
  field: string,
  newValue: string,
  source: string,
) {
  await ex.insert(schema.entryEvents).values({
    entryId,
    field,
    oldValue: null,
    newValue,
    source,
  });
}

async function getTransferLegs(
  ex: Executor,
  transferId: string,
): Promise<{ outflowEntryId: string; inflowEntryId: string }> {
  const res = await ex
    .select({
      outflowEntryId: schema.transfers.outflowEntryId,
      inflowEntryId: schema.transfers.inflowEntryId,
    })
    .from(schema.transfers)
    .where(sql`${schema.transfers.id} = ${transferId}`);
  if (res.length === 0) throw new Error(`transfer not found: ${transferId}`);
  return res[0];
}

/**
 * Confirm a pending transfer: flip status to 'confirmed' and append entry_events
 * to both legs.
 */
export async function confirmTransfer(
  db: Db,
  transferId: string,
  source: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { outflowEntryId, inflowEntryId } = await getTransferLegs(tx, transferId);

    await tx
      .update(schema.transfers)
      .set({ status: "confirmed" })
      .where(sql`${schema.transfers.id} = ${transferId}`);

    await logEvent(tx, outflowEntryId, "transfer", "confirmed", source);
    await logEvent(tx, inflowEntryId, "transfer", "confirmed", source);
  });
}

/**
 * Reject a pending transfer: delete the transfers row, remember the pair in
 * rejected_transfers so it is never re-proposed, and append entry_events to both legs.
 */
export async function rejectTransfer(
  db: Db,
  transferId: string,
  source: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { outflowEntryId, inflowEntryId } = await getTransferLegs(tx, transferId);

    await tx
      .delete(schema.transfers)
      .where(sql`${schema.transfers.id} = ${transferId}`);

    await tx
      .insert(schema.rejectedTransfers)
      .values({ outflowEntryId, inflowEntryId })
      .onConflictDoNothing();

    await logEvent(tx, outflowEntryId, "transfer", "rejected", source);
    await logEvent(tx, inflowEntryId, "transfer", "rejected", source);
  });
}
