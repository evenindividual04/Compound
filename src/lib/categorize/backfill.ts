/**
 * One-time (idempotent) backfill: categorize all existing uncategorized, unlocked
 * transaction entries for a household using the same categorizeEntries cascade.
 *
 * Filter: entry_type = 'transaction', deleted_at IS NULL,
 *         transactions.category_id IS NULL AND category_locked = false
 * Runs in batches of 200.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { categorizeEntries, type CategorizeDeps } from "./categorize";
import { defaultCategorizeDeps } from "./deps";

const BATCH_SIZE = 200;

export async function backfillCategories(
  db: Db,
  householdId: string,
  deps: CategorizeDeps = defaultCategorizeDeps(),
): Promise<{ resolved: number; abstained: number; scanned: number }> {
  // Fetch all eligible entry IDs: transaction entries in this household
  // with no category set and not locked.
  const rows = await db
    .select({ entryId: schema.entries.id })
    .from(schema.entries)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.entries.accountId))
    .innerJoin(schema.transactions, eq(schema.transactions.entryId, schema.entries.id))
    .where(
      and(
        eq(schema.accounts.householdId, householdId),
        eq(schema.entries.entryType, "transaction"),
        isNull(schema.entries.deletedAt),
        isNull(schema.transactions.categoryId),
        eq(schema.transactions.categoryLocked, false),
      ),
    );

  const entryIds = rows.map((r) => r.entryId);
  const scanned = entryIds.length;

  let resolved = 0;
  let abstained = 0;

  for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
    const batch = entryIds.slice(i, i + BATCH_SIZE);
    const result = await categorizeEntries(db, householdId, batch, deps);
    resolved += result.resolved;
    abstained += result.abstained;
  }

  return { resolved, abstained, scanned };
}
