import { describe, it, expect, beforeEach } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { quickAdd, recentCategoryIds } from "./quick-add";

describe.skipIf(!process.env.TEST_DATABASE_URL)("quick-add", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  it("expense category flips sign negative", async () => {
    const { entryId, deduped } = await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "250.00",
      categoryId: s.food.id,
      date: "2026-06-11",
      idempotencyKey: "test-expense-1",
    });
    expect(deduped).toBe(false);
    const [entry] = await tdb
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId));
    expect(entry).toBeDefined();
    // expense → negative
    expect(entry.amount.startsWith("-")).toBe(true);
    expect(parseFloat(entry.amount)).toBeCloseTo(-250, 2);
  });

  it("income category stays positive", async () => {
    const { entryId, deduped } = await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "50000.00",
      categoryId: s.salary.id,
      date: "2026-06-11",
      idempotencyKey: "test-income-1",
    });
    expect(deduped).toBe(false);
    const [entry] = await tdb
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId));
    expect(entry).toBeDefined();
    expect(parseFloat(entry.amount)).toBeCloseTo(50000, 2);
    expect(entry.amount.startsWith("-")).toBe(false);
  });

  it("same idempotencyKey twice → one entry, second returns deduped:true", async () => {
    const key = "test-dedup-key";
    const first = await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "100.00",
      categoryId: s.food.id,
      date: "2026-06-11",
      idempotencyKey: key,
    });
    expect(first.deduped).toBe(false);

    const second = await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "100.00",
      categoryId: s.food.id,
      date: "2026-06-11",
      idempotencyKey: key,
    });
    expect(second.deduped).toBe(true);
    expect(second.entryId).toBe(first.entryId);

    // Only one live entry in DB
    const entries = await tdb
      .select()
      .from(schema.entries)
      .where(
        and(
          eq(schema.entries.accountId, s.bank.id),
          eq(schema.entries.externalId, `quick:${key}`),
          isNull(schema.entries.deletedAt),
        ),
      );
    expect(entries).toHaveLength(1);
  });

  it("recentCategoryIds returns most-recent-first distinct categoryIds", async () => {
    // Insert 3 entries: food, groceries, food again (more recent)
    await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "100.00",
      categoryId: s.food.id,
      date: "2026-06-09",
      idempotencyKey: "rc-1",
    });
    await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "200.00",
      categoryId: s.groceries.id,
      date: "2026-06-10",
      idempotencyKey: "rc-2",
    });
    await quickAdd(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      amountAbs: "50.00",
      categoryId: s.food.id,
      date: "2026-06-11",
      idempotencyKey: "rc-3",
    });

    const ids = await recentCategoryIds(tdb, s.hh.id, 8);
    // Most recent food (rc-3) → then groceries (rc-2); food should appear only once
    expect(ids[0]).toBe(s.food.id);
    expect(ids[1]).toBe(s.groceries.id);
    expect(ids).toHaveLength(2);
    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
  });
});
