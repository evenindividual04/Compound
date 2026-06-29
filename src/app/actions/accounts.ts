"use server";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { accounts } from "@/db/schema/core";
import { requireHousehold } from "@/lib/current";
import { normalizeBalanceForKind } from "@/lib/ledger/signs";
import { createValuation } from "@/lib/ledger/write";
import { afterWrite } from "@/lib/ledger/derive";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateAccountInput = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum([
    "bank",
    "cash",
    "credit_card",
    "loan",
    "investment",
    "epf",
    "ppf",
    "fd",
    "property",
    "gold",
    "crypto",
    "wallet",
    "receivable",
    "other_asset",
    "other_liability",
  ]),
  openingBalanceAbs: z.string().regex(/^\d+(\.\d+)?$/, "Must be a non-negative number"),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  // Optional SMS routing key — matches the parser's acctKey (e.g. "SBI:3519",
  // "ICICI-CC:1004", "LazyPay"). Lets the SMS bridge route messages to this account.
  smsKey: z.string().trim().min(1).max(64).optional(),
});

const AddValuationInput = z.object({
  accountId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountAbs: z.string().regex(/^\d+(\.\d+)?$/, "Must be a non-negative number"),
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function createAccount(raw: unknown): Promise<void> {
  const { householdId } = await requireHousehold();
  const input = CreateAccountInput.parse(raw);

  const openingBalance = normalizeBalanceForKind(input.kind, input.openingBalanceAbs);

  const [inserted] = await db
    .insert(accounts)
    .values({
      householdId,
      name: input.name,
      kind: input.kind,
      openingBalance,
      openingDate: input.openingDate,
      metadata: input.smsKey ? { smsKey: input.smsKey } : {},
    })
    .returning({ id: accounts.id });

  // afterWrite rebuilds balances/rollups; no entries yet so it's a fast no-op.
  await afterWrite(db, {
    accountId: inserted.id,
    householdId,
    date: input.openingDate,
  });

  revalidatePath("/accounts");
}

export async function closeAccount(id: string): Promise<void> {
  const { householdId } = await requireHousehold();

  const rows = await db
    .update(accounts)
    .set({ status: "closed" })
    .where(and(eq(accounts.id, id), eq(accounts.householdId, householdId)))
    .returning({ id: accounts.id });

  if (rows.length === 0) throw new Error("account not found or unauthorized");

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${id}`);
}

export async function setExcluded(id: string, excluded: boolean): Promise<void> {
  const { householdId } = await requireHousehold();

  const rows = await db
    .update(accounts)
    .set({ excluded })
    .where(and(eq(accounts.id, id), eq(accounts.householdId, householdId)))
    .returning({ id: accounts.id });

  if (rows.length === 0) throw new Error("account not found or unauthorized");

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${id}`);
}

export async function addValuation(
  raw: unknown,
): Promise<{ adjustment: string | null }> {
  const { householdId } = await requireHousehold();
  const input = AddValuationInput.parse(raw);

  // Verify account belongs to this household
  const [account] = await db
    .select({ id: accounts.id, kind: accounts.kind })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.householdId, householdId)));

  if (!account) throw new Error("account not found or unauthorized");

  const signedAmount = normalizeBalanceForKind(account.kind, input.amountAbs);

  const { adjustmentEntryId } = await createValuation(db, {
    accountId: input.accountId,
    date: input.date,
    amount: signedAmount,
    kind: "reconciliation",
  });

  await afterWrite(db, {
    accountId: input.accountId,
    householdId,
    date: input.date,
  });

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${input.accountId}`);

  if (adjustmentEntryId === null) return { adjustment: null };

  // Compute the adjustment amount for the toast message.
  // The adjustment entry amount is the gap between anchor and derived balance.
  // We derive it by fetching the entry directly.
  const { entries } = await import("@/db/schema/ledger");
  const [adjEntry] = await db
    .select({ amount: entries.amount })
    .from(entries)
    .where(eq(entries.id, adjustmentEntryId));

  return { adjustment: adjEntry?.amount ?? null };
}
