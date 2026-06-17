/**
 * Tiers T1 (local-embedding k-NN over the household's corrections) and T2 (LLM fallback)
 * for transaction entries that deterministic rules (T0, applyRulesTo) left uncategorized.
 * Suggests via annotate() with source 'categorizer:t1'|'t2' and categoryLocked=false; never
 * overwrites a locked category; abstains otherwise. Edges (embed/generate) are injected.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { annotate } from "@/lib/ledger/write";
import { normalizeMerchant } from "@/lib/import/sms";
import type { Embedder } from "./embed";
import { nearestExamples } from "./examples";
import { classifyWithLlm, type GenerateFn } from "./llm";

export interface CategorizeDeps {
  embed: Embedder; generate: GenerateFn; t1MinSim?: number; t2MinConf?: number; k?: number;
}

export async function categorizeEntries(
  db: Db, householdId: string, entryIds: string[], deps: CategorizeDeps,
): Promise<{ resolved: number; abstained: number }> {
  const t1 = deps.t1MinSim ?? 0.8, t2 = deps.t2MinConf ?? 0.7, k = deps.k ?? 5;
  const cats = await db.select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories).where(eq(schema.categories.householdId, householdId));
  let resolved = 0, abstained = 0;

  for (const entryId of entryIds) {
    const [entry] = await db.select().from(schema.entries)
      .where(and(eq(schema.entries.id, entryId), isNull(schema.entries.deletedAt)));
    if (!entry || entry.entryType !== "transaction") continue;
    const [txn] = await db.select().from(schema.transactions).where(eq(schema.transactions.entryId, entryId));
    if (!txn || txn.categoryId || txn.categoryLocked) continue;     // already categorized / locked

    const text = normalizeMerchant(txn.merchant || entry.description || "");
    if (!text) { abstained++; continue; }
    const vec = await deps.embed(text);

    // T1 — k-NN over corrections
    const near = await nearestExamples(db, householdId, vec, k);
    let chosen: string | null = null;
    if (near.length && near[0].sim >= t1) {
      const top = near[0].categoryId;
      const agree = near.filter((n) => n.categoryId === top).length >= Math.ceil(near.length / 2);
      if (agree) chosen = top;
    }
    let tier = "t1";
    // T2 — LLM
    if (!chosen) {
      tier = "t2";
      const out = await classifyWithLlm({ text, amount: entry.amount, categories: cats }, { generate: deps.generate });
      if (out && out.confidence >= t2) chosen = out.categoryId;
    }

    if (!chosen) { abstained++; continue; }
    // annotate guards sign-vs-classification and the locked field; non-'user' source stays unlocked
    try {
      await annotate(db, entryId, { categoryId: chosen }, `categorizer:${tier}` as const);
      const [after] = await db.select().from(schema.transactions).where(eq(schema.transactions.entryId, entryId));
      if (after?.categoryId === chosen) resolved++; else abstained++;  // sign-mismatch → annotate left it null
    } catch { abstained++; }
  }
  return { resolved, abstained };
}
