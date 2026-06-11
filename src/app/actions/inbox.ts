"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { entries, accounts } from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { acceptEntry, acceptAll } from "@/lib/ledger/inbox";
import { confirmTransfer, rejectTransfer } from "@/lib/ledger/transfers";
import { transfers } from "@/db/schema/ledger";

function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/inbox");
  revalidatePath("/transactions");
}

async function assertEntryOwnership(householdId: string, entryId: string): Promise<void> {
  const [row] = await db
    .select({ accountHousehold: accounts.householdId })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .where(eq(entries.id, entryId));
  if (!row || row.accountHousehold !== householdId) {
    throw new Error("entry not found or unauthorized");
  }
}

async function assertTransferOwnership(householdId: string, transferId: string): Promise<void> {
  const [row] = await db
    .select({ outflowEntryId: transfers.outflowEntryId, inflowEntryId: transfers.inflowEntryId })
    .from(transfers)
    .where(eq(transfers.id, transferId));
  if (!row) throw new Error("transfer not found or unauthorized");

  // At least one leg must belong to this household.
  const legOwner = await db
    .select({ hh: accounts.householdId })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .where(eq(entries.id, row.outflowEntryId));
  if (!legOwner[0] || legOwner[0].hh !== householdId) {
    throw new Error("transfer not found or unauthorized");
  }
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const AcceptInput = z.object({
  entryId: z.string().uuid(),
  categoryId: z.string().uuid().optional(),
});

const AcceptBulkInput = z.object({
  entryIds: z.array(z.string().uuid()).min(1),
});

const RecategorizeInput = z.object({
  entryId: z.string().uuid(),
  categoryId: z.string().uuid(),
});

const TransferInput = z.object({
  transferId: z.string().uuid(),
});

// ── Actions ────────────────────────────────────────────────────────────────────

export async function accept(entryId: string, categoryId?: string): Promise<void> {
  const { householdId } = await requireHousehold();
  const input = AcceptInput.parse({ entryId, categoryId });
  await assertEntryOwnership(householdId, input.entryId);
  await acceptEntry(db, input.entryId, "user", input.categoryId);
  revalidateAll();
}

export async function acceptBulk(entryIds: string[]): Promise<void> {
  const { householdId } = await requireHousehold();
  const { entryIds: ids } = AcceptBulkInput.parse({ entryIds });
  // Verify all entries belong to this household.
  await Promise.all(ids.map((id) => assertEntryOwnership(householdId, id)));
  await acceptAll(db, ids, "user");
  revalidateAll();
}

export async function recategorizeAndAccept(entryId: string, categoryId: string): Promise<void> {
  const { householdId } = await requireHousehold();
  const input = RecategorizeInput.parse({ entryId, categoryId });
  await assertEntryOwnership(householdId, input.entryId);
  await acceptEntry(db, input.entryId, "user", input.categoryId);
  revalidateAll();
}

export async function confirmTransferAction(transferId: string): Promise<void> {
  const { householdId } = await requireHousehold();
  TransferInput.parse({ transferId });
  await assertTransferOwnership(householdId, transferId);
  await confirmTransfer(db, transferId, "user");
  revalidateAll();
}

export async function rejectTransferAction(transferId: string): Promise<void> {
  const { householdId } = await requireHousehold();
  TransferInput.parse({ transferId });
  await assertTransferOwnership(householdId, transferId);
  await rejectTransfer(db, transferId, "user");
  revalidateAll();
}
