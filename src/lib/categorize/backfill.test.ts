import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTransaction } from "@/lib/ledger/write";
import { recordExample } from "./examples";
import { backfillCategories } from "./backfill";

const v = (f: number) => Array.from({ length: 384 }, () => f);

async function mkTxn(bankId: string, desc: string) {
  return createTransaction(tdb, {
    accountId: bankId,
    date: "2026-03-01",
    amount: "-100.0000",
    description: desc,
    status: "pending",
  });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("backfillCategories", () => {
  beforeEach(resetDb);

  it("categorizes only uncategorized+unlocked txns; scanned counts all eligible", async () => {
    const { hh, bank, food, groceries } = await seedBasics();

    // T1 example so the categorizer can resolve
    await recordExample(tdb, {
      householdId: hh.id,
      text: "zomato",
      categoryId: food.id,
      embedding: v(0.9),
      source: "accept",
    });

    // 1. uncategorized (should be processed)
    const id1 = await mkTxn(bank.id, "ZOMATO");
    // 2. uncategorized (should be processed)
    const id2 = await mkTxn(bank.id, "ZOMATO2");
    // 3. already categorized (should be skipped)
    const id3 = await mkTxn(bank.id, "ALREADY");
    await tdb
      .update(schema.transactions)
      .set({ categoryId: groceries.id })
      .where(eq(schema.transactions.entryId, id3));
    // 4. locked (should be skipped)
    const id4 = await mkTxn(bank.id, "LOCKED");
    await tdb
      .update(schema.transactions)
      .set({ categoryId: groceries.id, categoryLocked: true })
      .where(eq(schema.transactions.entryId, id4));

    const result = await backfillCategories(tdb, hh.id, {
      embed: async () => v(0.9),
      generate: async () => null,
    });

    // scanned = number of entries passed to categorizeEntries (only uncategorized+unlocked)
    expect(result.scanned).toBe(2);
    // both should resolve via T1
    expect(result.resolved).toBe(2);
    expect(result.abstained).toBe(0);

    // Verify actual DB state: id1 and id2 got a category, id3 and id4 unchanged
    const [t1] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id1));
    expect(t1.categoryId).toBe(food.id);

    const [t3] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id3));
    expect(t3.categoryId).toBe(groceries.id); // unchanged

    const [t4] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id4));
    expect(t4.categoryId).toBe(groceries.id); // unchanged
    expect(t4.categoryLocked).toBe(true);     // still locked
  });

  it("is idempotent: a second run does not double-process already-categorized entries", async () => {
    const { hh, bank, food } = await seedBasics();

    await recordExample(tdb, {
      householdId: hh.id,
      text: "zomato",
      categoryId: food.id,
      embedding: v(0.9),
      source: "accept",
    });

    const id = await mkTxn(bank.id, "ZOMATO");

    // First run — should categorize
    const first = await backfillCategories(tdb, hh.id, {
      embed: async () => v(0.9),
      generate: async () => null,
    });
    expect(first.resolved).toBe(1);
    expect(first.scanned).toBe(1);

    // Second run — now the entry is categorized (but unlocked), so it's excluded
    const second = await backfillCategories(tdb, hh.id, {
      embed: async () => v(0.9),
      generate: async () => null,
    });
    expect(second.scanned).toBe(0);
    expect(second.resolved).toBe(0);
  });
});
