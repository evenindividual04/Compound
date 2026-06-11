"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { quickAdd } from "@/lib/ledger/quick-add";

const QuickAddSchema = z.object({
  accountId: z.string().uuid(),
  categoryId: z.string().uuid(),
  /** Absolute amount string (no sign) */
  amountAbs: z.string().regex(/^\d+(\.\d{1,4})?$/, "Must be a positive decimal"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  description: z.string().max(255).optional(),
  idempotencyKey: z.string().min(1).max(128),
});

export async function quickAddAction(
  raw: unknown,
): Promise<{ ok: true; deduped: boolean } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    const input = QuickAddSchema.parse(raw);

    const result = await quickAdd(db, {
      householdId,
      accountId: input.accountId,
      amountAbs: input.amountAbs,
      categoryId: input.categoryId,
      description: input.description,
      date: input.date,
      idempotencyKey: input.idempotencyKey,
    });

    revalidatePath("/");
    revalidatePath("/transactions");

    return { ok: true, deduped: result.deduped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
