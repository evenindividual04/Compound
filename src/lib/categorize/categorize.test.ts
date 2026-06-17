import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTransaction } from "@/lib/ledger/write";
import { recordExample } from "./examples";
import { categorizeEntries } from "./categorize";

const v = (f: number) => Array.from({ length: 384 }, () => f);
async function pending(bankId: string, desc: string) {
  return createTransaction(tdb, { accountId: bankId, date: "2026-03-01", amount: "-642.0000", description: desc, status: "pending" });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("categorizeEntries", () => {
  beforeEach(resetDb);

  it("T1: suggests the k-NN category above threshold (unlocked)", async () => {
    const { hh, bank, food } = await seedBasics();
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" });
    const id = await pending(bank.id, "ZOMATO");
    const r = await categorizeEntries(tdb, hh.id, [id], { embed: async () => v(0.9), generate: async () => null });
    expect(r.resolved).toBe(1);
    const [t] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id));
    expect(t.categoryId).toBe(food.id);
    expect(t.categoryLocked).toBe(false);                 // still a suggestion
  });

  it("T2: falls back to the LLM when no close example, abstains on null", async () => {
    const { hh, bank, food } = await seedBasics();
    const id = await pending(bank.id, "NEWPLACE");
    // no examples → T1 misses → T2
    const hit = await categorizeEntries(tdb, hh.id, [id], { embed: async () => v(0.5), generate: async () => ({ name: "Food & Dining", confidence: 0.95 }) });
    expect(hit.resolved).toBe(1);
    const id2 = await pending(bank.id, "MYSTERY");
    const miss = await categorizeEntries(tdb, hh.id, [id2], { embed: async () => v(0.5), generate: async () => null });
    expect(miss.abstained).toBe(1);
    const [t2] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id2));
    expect(t2.categoryId).toBeNull();
  });

  it("never overwrites a locked category", async () => {
    const { hh, bank, food, groceries } = await seedBasics();
    const id = await pending(bank.id, "ZOMATO");
    await tdb.update(schema.transactions).set({ categoryId: groceries.id, categoryLocked: true }).where(eq(schema.transactions.entryId, id));
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" });
    await categorizeEntries(tdb, hh.id, [id], { embed: async () => v(0.9), generate: async () => null });
    const [t] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id));
    expect(t.categoryId).toBe(groceries.id);              // unchanged
  });
});
