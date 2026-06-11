/**
 * The ONLY way entries enter or change in the ledger. Every mutation:
 *  - is validated (zero amounts, sign-vs-classification per ADR-1),
 *  - happens in a transaction,
 *  - appends to entry_events (the audit log is the real immutability guarantee).
 * Spec: docs/superpowers/specs/2026-06-11-personal-finance-system-design.md §4.3.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { cmp, isZero, sub } from "@/lib/money";

// Accept either the root client or a transaction handle.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export type WriteSource = "user" | "system" | `rule:${string}` | `import:${string}`;

export interface NewTransaction {
  accountId: string;
  date: string; // YYYY-MM-DD
  amount: string; // signed delta to the account's own balance (ADR-1)
  description?: string;
  categoryId?: string | null;
  merchant?: string | null;
  status?: "pending" | "posted";
  source?: "manual" | "import" | "system";
  externalId?: string | null;
  importId?: string | null;
  importHash?: string | null;
  isAdjustment?: boolean;
}

async function assertSignMatchesCategory(ex: Executor, categoryId: string, amount: string) {
  const [cat] = await ex
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId));
  if (!cat) throw new Error("category not found");
  if (cat.classification === "expense" && cmp(amount, "0") > 0)
    throw new Error("sign mismatch: expense categories require negative amounts (ADR-1)");
  if (cat.classification === "income" && cmp(amount, "0") < 0)
    throw new Error("sign mismatch: income categories require positive amounts (ADR-1)");
}

async function logEvent(
  ex: Executor,
  entryId: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  source: string,
) {
  await ex.insert(schema.entryEvents).values({ entryId, field, oldValue, newValue, source });
}

export async function createTransaction(db: Db, input: NewTransaction): Promise<string> {
  if (isZero(input.amount)) throw new Error("amount must be non-zero");
  return db.transaction(async (tx) => {
    if (input.categoryId) await assertSignMatchesCategory(tx, input.categoryId, input.amount);
    const [entry] = await tx
      .insert(schema.entries)
      .values({
        accountId: input.accountId,
        entryType: "transaction",
        date: input.date,
        amount: input.amount,
        description: input.description ?? "",
        status: input.status ?? "posted",
        source: input.source ?? "manual",
        externalId: input.externalId ?? null,
        importId: input.importId ?? null,
        importHash: input.importHash ?? null,
      })
      .returning();
    await tx.insert(schema.transactions).values({
      entryId: entry.id,
      categoryId: input.categoryId ?? null,
      merchant: input.merchant ?? null,
      isAdjustment: input.isAdjustment ?? false,
    });
    await logEvent(tx, entry.id, "created", null, input.amount, input.source ?? "manual");
    return entry.id;
  });
}

/**
 * Derived balance at end of `date`: opening + Σ posted/reconciled transaction|trade deltas.
 * Valuations are anchors, never deltas; pending entries don't count yet.
 */
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
  const row = (res as { rows: { bal: string }[] }).rows[0];
  if (!row) throw new Error("account not found");
  return row.bal;
}

export interface NewValuation {
  accountId: string;
  date: string;
  amount: string; // ABSOLUTE balance at date; liabilities negative (ADR-1)
  kind: "opening_anchor" | "reconciliation" | "appraisal";
}

/**
 * ADR-2: anchors never override. The gap between the anchor and the derived balance
 * is materialized as a PENDING adjustment transaction (review inbox) so the books
 * meet the anchor through a visible, categorizable entry — EPF/FD/loan interest,
 * cash drift. The valuation row itself is an assertion the invariant cron re-checks.
 */
export async function createValuation(
  db: Db,
  input: NewValuation,
): Promise<{ valuationEntryId: string; adjustmentEntryId: string | null }> {
  return db.transaction(async (tx) => {
    const derivedPosted = await computeBalanceAt(tx, input.accountId, input.date);
    // include not-yet-approved adjustments so stacked anchors don't double-materialize
    const pendingAdj = await tx.execute(sql`
      SELECT COALESCE(SUM(e.amount), 0)::numeric(19,4)::text AS amt
      FROM entries e JOIN transactions t ON t.entry_id = e.id
      WHERE e.account_id = ${input.accountId} AND e.status = 'pending'
        AND e.deleted_at IS NULL AND t.is_adjustment AND e.date <= ${input.date}
    `);
    const pendingAmt = (pendingAdj as { rows: { amt: string }[] }).rows[0].amt;
    const derived = sub(derivedPosted, sub("0", pendingAmt)); // derivedPosted + pendingAmt
    const gap = sub(input.amount, derived);

    let adjustmentEntryId: string | null = null;
    if (!isZero(gap)) {
      const [acct] = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.accountId));
      const [adjCategory] = await tx
        .select()
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.householdId, acct.householdId),
            eq(schema.categories.system, "adjustment"),
          ),
        );
      const [adjEntry] = await tx
        .insert(schema.entries)
        .values({
          accountId: input.accountId,
          entryType: "transaction",
          date: input.date,
          amount: gap,
          description: `Reconciliation adjustment (anchor ${input.date})`,
          status: "pending",
          source: "system",
        })
        .returning();
      await tx.insert(schema.transactions).values({
        entryId: adjEntry.id,
        categoryId: adjCategory?.id ?? null,
        isAdjustment: true,
      });
      await logEvent(tx, adjEntry.id, "created", null, gap, "system");
      adjustmentEntryId = adjEntry.id;
    }

    const [valEntry] = await tx
      .insert(schema.entries)
      .values({
        accountId: input.accountId,
        entryType: "valuation",
        date: input.date,
        amount: input.amount,
        description: `Balance anchor (${input.kind})`,
        status: "posted",
        source: "manual",
      })
      .returning();
    await tx.insert(schema.valuations).values({ entryId: valEntry.id, kind: input.kind });
    await logEvent(tx, valEntry.id, "created", null, input.amount, "user");

    return { valuationEntryId: valEntry.id, adjustmentEntryId };
  });
}

export interface AnnotatePatch {
  categoryId?: string | null;
  merchant?: string | null;
  description?: string;
}

/** Annotation edits. User edits lock; rule/import sources respect locks (no-op, no event). */
export async function annotate(
  db: Db,
  entryId: string,
  patch: AnnotatePatch,
  source: WriteSource,
): Promise<void> {
  const isUser = source === "user";
  await db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.entries)
      .where(and(eq(schema.entries.id, entryId), isNull(schema.entries.deletedAt)));
    if (!entry) throw new Error("entry not found");

    if (patch.categoryId !== undefined || patch.merchant !== undefined) {
      const [txn] = await tx
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.entryId, entryId));
      if (!txn) throw new Error("not a transaction entry");

      if (patch.categoryId !== undefined && patch.categoryId !== txn.categoryId) {
        const blocked = txn.categoryLocked && !isUser;
        if (!blocked) {
          if (patch.categoryId) await assertSignMatchesCategory(tx, patch.categoryId, entry.amount);
          await tx
            .update(schema.transactions)
            .set({ categoryId: patch.categoryId, categoryLocked: isUser ? true : txn.categoryLocked })
            .where(eq(schema.transactions.entryId, entryId));
          await logEvent(tx, entryId, "categoryId", txn.categoryId, patch.categoryId, source);
        }
      }
      if (patch.merchant !== undefined && patch.merchant !== txn.merchant) {
        await tx
          .update(schema.transactions)
          .set({ merchant: patch.merchant })
          .where(eq(schema.transactions.entryId, entryId));
        await logEvent(tx, entryId, "merchant", txn.merchant, patch.merchant, source);
      }
    }
    if (patch.description !== undefined && patch.description !== entry.description) {
      await tx
        .update(schema.entries)
        .set({ description: patch.description })
        .where(eq(schema.entries.id, entryId));
      await logEvent(tx, entryId, "description", entry.description, patch.description, source);
    }
  });
}

/** Soft delete. The DB trigger rejects deleting any transfer leg — dissolve first. */
export async function softDelete(db: Db, entryId: string, source: WriteSource): Promise<void> {
  await db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.entries)
      .where(and(eq(schema.entries.id, entryId), isNull(schema.entries.deletedAt)));
    if (!entry) throw new Error("entry not found");
    try {
      await tx
        .update(schema.entries)
        .set({ deletedAt: new Date() })
        .where(eq(schema.entries.id, entryId));
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
      if (cause.includes("transfer"))
        throw new Error("cannot delete a leg of an existing transfer; dissolve the transfer first");
      throw err;
    }
    await logEvent(tx, entryId, "deleted", null, null, source);
  });
}

export async function getEntry(db: Db, id: string) {
  const [entry] = await db.select().from(schema.entries).where(eq(schema.entries.id, id));
  if (!entry) throw new Error("entry not found");
  return entry;
}

export async function getTransaction(db: Db, entryId: string) {
  const [txn] = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.entryId, entryId));
  if (!txn) throw new Error("transaction not found");
  return txn;
}
