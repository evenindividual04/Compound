import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { add, neg, cmp } from "@/lib/money";
import { confirmTransfer } from "./transfers";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export interface SplitInput {
  categoryId: string | null;
  amount: string;
  note?: string;
}

/**
 * Set (replace) splits for an entry. If splits is non-empty:
 *  - nulls the parent transaction's categoryId (and logs the change)
 *  - deletes existing splits for the entry
 *  - inserts new splits
 * Empty array: clears splits only (parent category stays null; caller may annotate after).
 * Translates the DB trigger's sum-violation into a friendly error.
 */
export async function setSplits(
  db: Db,
  entryId: string,
  splits: SplitInput[],
  source: string,
): Promise<void> {
  if (splits.length > 0) {
    // Pre-validate sum in JS so we can give a friendly error before hitting the DB trigger.
    // Fetch entry amount first (outside the inner tx since we're about to open one).
    const [entry] = await db
      .select({ amount: schema.entries.amount })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId));
    if (!entry) throw new Error("entry not found");

    const sum = splits.reduce((acc, s) => add(acc, s.amount), "0.0000");
    if (cmp(sum, entry.amount) !== 0) {
      throw new Error("splits must sum to the transaction amount");
    }
  }

  await db.transaction(async (tx) => {
    if (splits.length > 0) {
      // Null the parent category — replicate what annotate does without nesting transactions.
      const [txn] = await tx
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.entryId, entryId));
      if (!txn) throw new Error("not a transaction entry");

      if (txn.categoryId !== null) {
        await tx
          .update(schema.transactions)
          .set({ categoryId: null })
          .where(eq(schema.transactions.entryId, entryId));
        await tx.insert(schema.entryEvents).values({
          entryId,
          field: "categoryId",
          oldValue: txn.categoryId,
          newValue: null,
          source,
        });
      }
    }

    // Delete existing splits.
    await tx
      .delete(schema.transactionSplits)
      .where(eq(schema.transactionSplits.entryId, entryId));

    if (splits.length > 0) {
      try {
        await tx.insert(schema.transactionSplits).values(
          splits.map((s) => ({
            entryId,
            categoryId: s.categoryId ?? null,
            amount: s.amount,
            note: s.note ?? null,
          })),
        );
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        const cause =
          err instanceof Error && err.cause instanceof Error
            ? err.cause.message
            : "";
        if (msg.includes("sum") || cause.includes("sum")) {
          throw new Error("splits must sum to the transaction amount");
        }
        throw err;
      }
    }
  });
}

/**
 * Create a transfer pair (status 'pending') and immediately confirm it.
 * Validates that outflow amount == neg(inflow amount) before inserting.
 * Translates DB failures into friendly errors.
 */
export async function makeTransferPair(
  db: Db,
  outflowEntryId: string,
  inflowEntryId: string,
): Promise<string> {
  // Validate amounts are equal and opposite.
  const entries = await db
    .select({ id: schema.entries.id, amount: schema.entries.amount })
    .from(schema.entries)
    .where(
      sql`${schema.entries.id} IN (${outflowEntryId}, ${inflowEntryId})`,
    );

  const outEntry = entries.find((e) => e.id === outflowEntryId);
  const inEntry = entries.find((e) => e.id === inflowEntryId);

  if (!outEntry || !inEntry) throw new Error("one or both entries not found");

  if (cmp(outEntry.amount, neg(inEntry.amount)) !== 0) {
    throw new Error("amounts must be equal and opposite to form a transfer pair");
  }

  let transferId: string;

  try {
    const [transfer] = await db
      .insert(schema.transfers)
      .values({
        outflowEntryId,
        inflowEntryId,
        status: "pending",
      })
      .returning({ id: schema.transfers.id });
    transferId = transfer.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "";
    const combined = `${msg} ${cause}`.toLowerCase();
    if (combined.includes("unique") || combined.includes("already")) {
      throw new Error("one or both entries are already part of a transfer");
    }
    throw err;
  }

  try {
    await confirmTransfer(db, transferId, "user");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "";
    const combined = `${msg} ${cause}`.toLowerCase();
    if (
      combined.includes("net") ||
      combined.includes("zero") ||
      combined.includes("different account")
    ) {
      throw new Error("transfer pair is invalid: entries must be on different accounts and net to zero");
    }
    throw err;
  }

  return transferId;
}
