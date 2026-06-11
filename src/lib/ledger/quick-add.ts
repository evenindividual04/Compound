import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { abs, neg } from "@/lib/money";
import { createTransaction } from "./write";
import { afterWrite } from "./derive";

export interface QuickAddInput {
  householdId: string;
  accountId: string;
  /** Absolute (unsigned) amount string, e.g. "250.00" */
  amountAbs: string;
  categoryId: string;
  description?: string;
  date: string; // YYYY-MM-DD
  idempotencyKey: string;
}

export interface QuickAddResult {
  entryId: string;
  deduped: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  const msg =
    (err instanceof Error ? err.message : "") +
    (err instanceof Error && err.cause instanceof Error ? " " + err.cause.message : "");
  return (
    msg.includes("entries_external_unique") ||
    msg.includes("duplicate key") ||
    msg.includes("unique constraint") ||
    msg.includes("UniqueConstraintViolationError")
  );
}

export async function quickAdd(db: Db, input: QuickAddInput): Promise<QuickAddResult> {
  // Verify account belongs to household
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, input.accountId),
        eq(schema.accounts.householdId, input.householdId),
      ),
    );
  if (!account) throw new Error("account not found or not in household");

  // Verify category belongs to household
  const [category] = await db
    .select()
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, input.categoryId),
        eq(schema.categories.householdId, input.householdId),
      ),
    );
  if (!category) throw new Error("category not found or not in household");

  const amount =
    category.classification === "expense" ? neg(abs(input.amountAbs)) : abs(input.amountAbs);

  const externalId = `quick:${input.idempotencyKey}`;

  try {
    const entryId = await createTransaction(db, {
      accountId: input.accountId,
      date: input.date,
      amount,
      description: input.description,
      categoryId: input.categoryId,
      status: "posted",
      source: "manual",
      externalId,
    });

    await afterWrite(db, {
      accountId: input.accountId,
      householdId: input.householdId,
      date: input.date,
    });

    return { entryId, deduped: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Look up the existing live entry by (accountId, externalId)
      const [existing] = await db
        .select()
        .from(schema.entries)
        .where(
          and(
            eq(schema.entries.accountId, input.accountId),
            eq(schema.entries.externalId, externalId),
            isNull(schema.entries.deletedAt),
          ),
        );
      if (!existing) throw err; // unexpected — rethrow
      return { entryId: existing.id, deduped: true };
    }
    throw err;
  }
}

/**
 * Returns up to `limit` distinct categoryIds from the most-recent non-deleted
 * categorized transactions in the household, ordered most-recent-first.
 */
export async function recentCategoryIds(
  db: Db,
  householdId: string,
  limit = 8,
): Promise<string[]> {
  const rows = await db
    .select({
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.entries)
    .innerJoin(schema.transactions, eq(schema.transactions.entryId, schema.entries.id))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.entries.accountId))
    .where(
      and(
        eq(schema.accounts.householdId, householdId),
        isNull(schema.entries.deletedAt),
        isNotNull(schema.transactions.categoryId),
      ),
    )
    .orderBy(desc(schema.entries.createdAt))
    .limit(limit * 10); // over-fetch to find `limit` distinct

  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of rows) {
    if (row.categoryId && !seen.has(row.categoryId)) {
      seen.add(row.categoryId);
      result.push(row.categoryId);
      if (result.length >= limit) break;
    }
  }
  return result;
}
