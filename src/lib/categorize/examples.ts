import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

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
