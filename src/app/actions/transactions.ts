"use server";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { annotate, softDelete } from "@/lib/ledger/write";
import { afterWrite } from "@/lib/ledger/derive";
import { setSplits, makeTransferPair } from "@/lib/ledger/edit";
import { recordExampleForEntry } from "@/lib/categorize/examples";
import { embed } from "@/lib/categorize/embed";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Verify entryId belongs to the authenticated household. Returns the entry + account row. */
async function requireOwnedEntry(entryId: string, householdId: string) {
  const [row] = await db
    .select({
      entryId: schema.entries.id,
      accountId: schema.entries.accountId,
      date: schema.entries.date,
      householdId: schema.accounts.householdId,
    })
    .from(schema.entries)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.entries.accountId))
    .where(
      and(
        eq(schema.entries.id, entryId),
        eq(schema.accounts.householdId, householdId),
      ),
    );
  if (!row) throw new Error("entry not found or unauthorized");
  return row;
}

function revalidate() {
  revalidatePath("/transactions");
  revalidatePath("/");
}

// ─── schemas ──────────────────────────────────────────────────────────────────

const EntryIdSchema = z.string().uuid();

const SplitItemSchema = z.object({
  categoryId: z.string().uuid().nullable(),
  amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
  note: z.string().max(255).optional(),
});

// ─── actions ──────────────────────────────────────────────────────────────────

export async function recategorize(
  entryId: string,
  categoryId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    EntryIdSchema.parse(entryId);
    if (categoryId !== null) z.string().uuid().parse(categoryId);

    const row = await requireOwnedEntry(entryId, householdId);
    await annotate(db, entryId, { categoryId }, "user");
    await afterWrite(db, { accountId: row.accountId, householdId, date: row.date });
    revalidate();

    if (categoryId) {
      try {
        await recordExampleForEntry(db, entryId, "correct", embed);
      } catch {
        // Best-effort: training write failure must never block the recategorize.
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function editDescription(
  entryId: string,
  description: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    EntryIdSchema.parse(entryId);
    z.string().max(255).parse(description);

    await requireOwnedEntry(entryId, householdId);
    await annotate(db, entryId, { description }, "user");
    revalidate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function removeTransaction(
  entryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    EntryIdSchema.parse(entryId);

    const row = await requireOwnedEntry(entryId, householdId);
    await softDelete(db, entryId, "user");
    await afterWrite(db, { accountId: row.accountId, householdId, date: row.date });
    revalidate();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // softDelete throws a friendly message for transfer legs — return it as a non-crash error.
    return { ok: false, error: msg };
  }
}

export async function saveSplits(
  entryId: string,
  splits: unknown[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    EntryIdSchema.parse(entryId);
    const parsed = z.array(SplitItemSchema).parse(splits);

    const row = await requireOwnedEntry(entryId, householdId);
    await setSplits(db, entryId, parsed, "user");
    await afterWrite(db, { accountId: row.accountId, householdId, date: row.date });
    revalidate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function pairTransfer(
  outflowEntryId: string,
  inflowEntryId: string,
): Promise<{ ok: true; transferId: string } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    EntryIdSchema.parse(outflowEntryId);
    EntryIdSchema.parse(inflowEntryId);

    // Verify both entries belong to this household.
    await requireOwnedEntry(outflowEntryId, householdId);
    await requireOwnedEntry(inflowEntryId, householdId);

    const transferId = await makeTransferPair(db, outflowEntryId, inflowEntryId);
    revalidate();
    return { ok: true, transferId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
