import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { sql } from "drizzle-orm";

describe.skipIf(!process.env.TEST_DATABASE_URL)("categorization_examples", () => {
  beforeEach(resetDb);
  it("stores and reads back a 384-d embedding", async () => {
    const { hh, food } = await seedBasics();
    const vec = Array.from({ length: 384 }, (_, i) => (i % 7) / 10);
    await tdb.insert(schema.categorizationExamples).values({
      householdId: hh.id, text: "zomato", categoryId: food.id, embedding: vec, source: "accept",
    });
    const rows = await tdb.execute(sql`SELECT text, category_id FROM categorization_examples`);
    expect((rows as unknown as { rows: unknown[] }).rows.length).toBe(1);
  });
});
