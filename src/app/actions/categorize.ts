"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";

export async function backfillCategoriesAction(): Promise<
  { ok: true; resolved: number; abstained: number; scanned: number } | { ok: false; error: string }
> {
  try {
    const { householdId } = await requireHousehold();
    // Lazy imports: backfill → deps → embed pulls fastembed (native ONNX). Keep it
    // off this action module's load path so the settings page renders even where the
    // native lib is absent; if the embedder can't load, the catch returns ok:false.
    const { backfillCategories } = await import("@/lib/categorize/backfill");
    const { defaultCategorizeDeps } = await import("@/lib/categorize/deps");
    const result = await backfillCategories(db, householdId, defaultCategorizeDeps());
    revalidatePath("/inbox");
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
