import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { normalizeMerchant } from "@/lib/import/sms";
import type { Embedder } from "./embed";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface NewExample {
  householdId: string; text: string; categoryId: string;
  embedding: number[]; source: "accept" | "correct";
}

/** Idempotent on (householdId, text, categoryId) — keeps the latest embedding/source. */
export async function recordExample(ex: Executor, e: NewExample): Promise<void> {
  await ex
    .insert(schema.categorizationExamples)
    .values({ householdId: e.householdId, text: e.text, categoryId: e.categoryId, embedding: e.embedding, source: e.source })
    .onConflictDoUpdate({
      target: [schema.categorizationExamples.householdId, schema.categorizationExamples.text, schema.categorizationExamples.categoryId],
      set: { embedding: e.embedding, source: e.source },
    });
}

/** Capture a labeled training example from a now-categorized entry. No-op if uncategorized. */
export async function recordExampleForEntry(
  db: Db,
  entryId: string,
  source: "accept" | "correct",
  embed: Embedder,
): Promise<void> {
  const [row] = await db.execute(sql`
    SELECT a.household_id, COALESCE(t.merchant, e.description) AS text, t.category_id
    FROM entries e JOIN transactions t ON t.entry_id = e.id JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ${entryId}
  `).then((r) => (r as unknown as { rows: { household_id: string; text: string; category_id: string | null }[] }).rows);
  if (!row || !row.category_id) return;
  const text = normalizeMerchant(row.text || "");
  if (!text) return;
  await recordExample(db, {
    householdId: row.household_id,
    text,
    categoryId: row.category_id,
    embedding: await embed(text),
    source,
  });
}

/** k nearest labeled examples by cosine similarity (1 - cosine_distance), descending. */
export async function nearestExamples(
  ex: Executor, householdId: string, embedding: number[], k: number,
): Promise<{ categoryId: string; sim: number }[]> {
  const lit = sql.raw(`'[${embedding.join(",")}]'::vector`);
  const res = await ex.execute(sql`
    SELECT category_id, 1 - (embedding <=> ${lit}) AS sim
    FROM categorization_examples
    WHERE household_id = ${householdId}
    ORDER BY embedding <=> ${lit}
    LIMIT ${k}
  `);
  return (res as unknown as { rows: { category_id: string; sim: number }[] }).rows.map((r) => ({
    categoryId: r.category_id, sim: Number(r.sim),
  }));
}
