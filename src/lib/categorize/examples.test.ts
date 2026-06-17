import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import { recordExample, nearestExamples } from "./examples";

const v = (fill: number) => Array.from({ length: 384 }, () => fill);

describe.skipIf(!process.env.TEST_DATABASE_URL)("examples", () => {
  beforeEach(resetDb);
  it("records, dedups by (hh,text,category), and returns nearest by cosine", async () => {
    const { hh, food, groceries } = await seedBasics();
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" });
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" }); // dup
    await recordExample(tdb, { householdId: hh.id, text: "bigbasket", categoryId: groceries.id, embedding: v(0.1), source: "correct" });

    const near = await nearestExamples(tdb, hh.id, v(0.88), 3);
    expect(near[0].categoryId).toBe(food.id);          // closest to the 0.9 vector
    expect(near[0].sim).toBeGreaterThan(0.9);
  });
});
