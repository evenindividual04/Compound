import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction } from "./write";
import { afterWrite } from "./derive";
import { budgetView, setAllocation, copyLastMonth } from "./budgets";

describe.skipIf(!process.env.TEST_DATABASE_URL)("budget ledger", () => {
  let seeds: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    seeds = await seedBasics();
  });

  // Helper: create a transaction and rebuild rollups
  async function spend(categoryId: string, amount: string, date: string) {
    const entryId = await createTransaction(tdb, {
      accountId: seeds.bank.id,
      date,
      amount,
      categoryId,
    });
    await afterWrite(tdb, {
      accountId: seeds.bank.id,
      householdId: seeds.hh.id,
      date,
    });
    return entryId;
  }

  // ── view math ────────────────────────────────────────────────────────────────
  it("assigned 5000, spent 342 → remaining 4658 as strings", async () => {
    const { hh, food } = seeds;
    // Set allocation for food
    await setAllocation(tdb, hh.id, "2026-05", food.id, "5000.0000");

    // Create spending
    await spend(food.id, "-200.0000", "2026-05-10");
    await spend(food.id, "-142.0000", "2026-05-15");

    const view = await budgetView(tdb, hh.id, "2026-05");

    const row = view.rows.find((r) => r.categoryId === food.id);
    expect(row).toBeDefined();
    expect(row!.assigned).toBe("5000.0000");
    expect(row!.spent).toBe("342.0000");
    expect(row!.remaining).toBe("4658.0000");
  });

  it("totals sum across all budget rows", async () => {
    const { hh, food, groceries } = seeds;
    await setAllocation(tdb, hh.id, "2026-05", food.id, "3000.0000");
    await setAllocation(tdb, hh.id, "2026-05", groceries.id, "2000.0000");

    await spend(food.id, "-500.0000", "2026-05-05");
    await spend(groceries.id, "-800.0000", "2026-05-06");

    const view = await budgetView(tdb, hh.id, "2026-05");

    expect(view.totals.assigned).toBe("5000.0000");
    expect(view.totals.spent).toBe("1300.0000");
    expect(view.totals.remaining).toBe("3700.0000");
  });

  // ── unbudgeted detection ──────────────────────────────────────────────────
  it("expense categories with spend but no allocation appear in unbudgetedSpend", async () => {
    const { hh, food, groceries } = seeds;
    // Only allocate food, not groceries
    await setAllocation(tdb, hh.id, "2026-05", food.id, "3000.0000");

    await spend(food.id, "-100.0000", "2026-05-05");
    await spend(groceries.id, "-250.0000", "2026-05-06");

    const view = await budgetView(tdb, hh.id, "2026-05");

    // food is in rows (has allocation)
    expect(view.rows.find((r) => r.categoryId === food.id)).toBeDefined();

    // groceries is in unbudgetedSpend (no allocation)
    const unbudgeted = view.unbudgetedSpend.find((r) => r.categoryId === groceries.id);
    expect(unbudgeted).toBeDefined();
    expect(unbudgeted!.spent).toBe("250.0000");

    // groceries is NOT in rows
    expect(view.rows.find((r) => r.categoryId === groceries.id)).toBeUndefined();
  });

  it("uncategorizedSpend shows abs of null-category rollup", async () => {
    const { hh, bank } = seeds;
    // Transaction with no category
    const entryId = await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-05-12",
      amount: "-999.0000",
    });
    await afterWrite(tdb, {
      accountId: bank.id,
      householdId: hh.id,
      date: "2026-05-12",
    });

    const view = await budgetView(tdb, hh.id, "2026-05");
    expect(view.uncategorizedSpend).toBe("999.0000");
  });

  it("income categories never appear in any budget section", async () => {
    const { hh, bank, salary } = seeds;
    // salary is income; even with a rollup it should not show in budget rows or unbudgeted
    await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-05-01",
      amount: "50000.0000",
      categoryId: salary.id,
    });
    await afterWrite(tdb, { accountId: bank.id, householdId: hh.id, date: "2026-05-01" });

    const view = await budgetView(tdb, hh.id, "2026-05");
    expect(view.rows.find((r) => r.categoryId === salary.id)).toBeUndefined();
    expect(view.unbudgetedSpend.find((r) => r.categoryId === salary.id)).toBeUndefined();
  });

  // ── copyLastMonth skip logic ───────────────────────────────────────────────
  it("copyLastMonth copies last month allocations to current month", async () => {
    const { hh, food, groceries } = seeds;
    // Set allocations for April
    await setAllocation(tdb, hh.id, "2026-04", food.id, "3000.0000");
    await setAllocation(tdb, hh.id, "2026-04", groceries.id, "1500.0000");

    const copied = await copyLastMonth(tdb, hh.id, "2026-05");
    expect(copied).toBe(2);

    const view = await budgetView(tdb, hh.id, "2026-05");
    const foodRow = view.rows.find((r) => r.categoryId === food.id);
    const groceriesRow = view.rows.find((r) => r.categoryId === groceries.id);
    expect(foodRow?.assigned).toBe("3000.0000");
    expect(groceriesRow?.assigned).toBe("1500.0000");
  });

  it("copyLastMonth skips categories already allocated this month", async () => {
    const { hh, food, groceries } = seeds;
    // April: both food + groceries
    await setAllocation(tdb, hh.id, "2026-04", food.id, "3000.0000");
    await setAllocation(tdb, hh.id, "2026-04", groceries.id, "1500.0000");

    // May already has food allocated (different amount)
    await setAllocation(tdb, hh.id, "2026-05", food.id, "4000.0000");

    const copied = await copyLastMonth(tdb, hh.id, "2026-05");
    // Only groceries should be copied; food already exists
    expect(copied).toBe(1);

    const view = await budgetView(tdb, hh.id, "2026-05");
    const foodRow = view.rows.find((r) => r.categoryId === food.id);
    // food stays at the May override, not overwritten
    expect(foodRow?.assigned).toBe("4000.0000");
    const groceriesRow = view.rows.find((r) => r.categoryId === groceries.id);
    expect(groceriesRow?.assigned).toBe("1500.0000");
  });

  it("copyLastMonth returns 0 when no last month allocations exist", async () => {
    const { hh } = seeds;
    const copied = await copyLastMonth(tdb, hh.id, "2026-05");
    expect(copied).toBe(0);
  });

  // ── zero-assigned deletion ────────────────────────────────────────────────
  it("setAllocation with assigned '0' deletes the row", async () => {
    const { hh, food } = seeds;
    await setAllocation(tdb, hh.id, "2026-05", food.id, "5000.0000");

    // Confirm it exists
    const before = await budgetView(tdb, hh.id, "2026-05");
    expect(before.rows.find((r) => r.categoryId === food.id)).toBeDefined();

    // Delete by setting to zero
    await setAllocation(tdb, hh.id, "2026-05", food.id, "0.0000");

    const after = await budgetView(tdb, hh.id, "2026-05");
    expect(after.rows.find((r) => r.categoryId === food.id)).toBeUndefined();
    // food now has spend but no alloc → unbudgeted? only if there's a rollup
    // (no spend seeded here, so won't appear in unbudgeted either)
  });

  it("setAllocation upserts correctly on re-set", async () => {
    const { hh, food } = seeds;
    await setAllocation(tdb, hh.id, "2026-05", food.id, "1000.0000");
    await setAllocation(tdb, hh.id, "2026-05", food.id, "2500.0000");

    const view = await budgetView(tdb, hh.id, "2026-05");
    const row = view.rows.find((r) => r.categoryId === food.id);
    expect(row?.assigned).toBe("2500.0000");
  });

  // ── over-budget detection via remaining ───────────────────────────────────
  it("remaining is negative when spent exceeds assigned", async () => {
    const { hh, food } = seeds;
    await setAllocation(tdb, hh.id, "2026-05", food.id, "200.0000");
    await spend(food.id, "-500.0000", "2026-05-10");

    const view = await budgetView(tdb, hh.id, "2026-05");
    const row = view.rows.find((r) => r.categoryId === food.id);
    expect(row?.remaining).toBe("-300.0000");
  });
});
