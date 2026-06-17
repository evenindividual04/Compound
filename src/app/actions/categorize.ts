"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { backfillCategories } from "@/lib/categorize/backfill";
import { defaultCategorizeDeps } from "@/lib/categorize/deps";

export async function backfillCategoriesAction(): Promise<
  { ok: true; resolved: number; abstained: number; scanned: number } | { ok: false; error: string }
> {
  try {
    const { householdId } = await requireHousehold();
    const result = await backfillCategories(db, householdId, defaultCategorizeDeps());
    revalidatePath("/inbox");
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
