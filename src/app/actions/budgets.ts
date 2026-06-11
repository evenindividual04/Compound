"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { setAllocation, copyLastMonth } from "@/lib/ledger/budgets";

// ── schemas ───────────────────────────────────────────────────────────────────

const MonthSchema = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/);
const CategoryIdSchema = z.string().uuid();
// Positive numeric string (budget amounts are non-negative)
const AssignedSchema = z.string().regex(/^\d+(\.\d{1,4})?$/);

// ── helpers ───────────────────────────────────────────────────────────────────

function revalidate() {
  revalidatePath("/budgets");
  revalidatePath("/");
}

// ── actions ───────────────────────────────────────────────────────────────────

export async function setAllocationAction(
  month: string,
  categoryId: string,
  assigned: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    MonthSchema.parse(month);
    CategoryIdSchema.parse(categoryId);
    AssignedSchema.parse(assigned);

    await setAllocation(db, householdId, month, categoryId, assigned);
    revalidate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function copyLastMonthAction(
  month: string,
): Promise<{ ok: true; copied: number } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    MonthSchema.parse(month);

    const copied = await copyLastMonth(db, householdId, month);
    revalidate();
    return { ok: true, copied };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
