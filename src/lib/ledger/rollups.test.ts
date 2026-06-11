import { describe, it, expect, beforeEach } from "vitest";
import { eq, gte, and, isNull } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction } from "./write";
import { rebuildRollups, afterWrite } from "./derive";

describe.skipIf(!process.env.TEST_DATABASE_URL)("rollup derivation", () => {
  let seeds: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    seeds = await seedBasics();
  });

  // Helper: query rollup rows for the test household sorted for stable comparison
  async function getRollups(fromMonth?: string) {
    const rows = await tdb
      .select()
      .from(schema.rollups)
      .where(
        and(
          eq(schema.rollups.householdId, seeds.hh.id),
          fromMonth ? gte(schema.rollups.month, fromMonth) : undefined,
        ),
      )
      .orderBy(schema.rollups.month, schema.rollups.categoryId);
    return rows;
  }

  // ── Test 1: basic income + expense rollup ──────────────────────────────────
  it("aggregates food expenses and salary income into April rollup rows", async () => {
    const { bank, food, salary } = seeds;
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-10", amount: "-100.0000", categoryId: food.id });
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-20", amount: "-250.0000", categoryId: food.id });
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-25", amount: "50000.0000", categoryId: salary.id });

    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");

    const rows = await getRollups();
    // Expect a food row with -350 and a salary row with 50000 in April
    const aprilFood = rows.find((r) => r.month === "2026-04-01" && r.categoryId === food.id);
    const aprilSalary = rows.find((r) => r.month === "2026-04-01" && r.categoryId === salary.id);

    expect(aprilFood).toBeDefined();
    expect(parseFloat(aprilFood!.amount)).toBeCloseTo(-350, 2);
    expect(aprilSalary).toBeDefined();
    expect(parseFloat(aprilSalary!.amount)).toBeCloseTo(50000, 2);
  });

  // ── Test 2: transfer legs excluded ────────────────────────────────────────
  it("excludes both legs of a transfer from rollups", async () => {
    const { bank, cash } = seeds;

    const outflowEntryId = await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-04-15",
      amount: "-5000.0000",
    });
    const inflowEntryId = await createTransaction(tdb, {
      accountId: cash.id,
      date: "2026-04-15",
      amount: "5000.0000",
    });
    await tdb.insert(schema.transfers).values({ outflowEntryId, inflowEntryId });

    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");

    const rows = await getRollups("2026-04-01");
    // No rollup rows should appear (both entries are transfers, no category)
    expect(rows).toHaveLength(0);
  });

  // ── Test 3: splits ─────────────────────────────────────────────────────────
  it("uses split amounts+categories instead of parent entry", async () => {
    const { bank, food, groceries } = seeds;

    // Parent has no category (pass no categoryId)
    const parentEntryId = await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-04-12",
      amount: "-300.0000",
    });

    // Insert two splits manually
    await tdb.insert(schema.transactionSplits).values([
      { entryId: parentEntryId, categoryId: food.id, amount: "-100.0000" },
      { entryId: parentEntryId, categoryId: groceries.id, amount: "-200.0000" },
    ]);

    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");

    const rows = await getRollups("2026-04-01");

    const foodRow = rows.find((r) => r.categoryId === food.id);
    const groceriesRow = rows.find((r) => r.categoryId === groceries.id);
    // No -300 parent row at all
    const parentAsNullCat = rows.find((r) => r.categoryId === null);

    expect(foodRow).toBeDefined();
    expect(parseFloat(foodRow!.amount)).toBeCloseTo(-100, 2);
    expect(groceriesRow).toBeDefined();
    expect(parseFloat(groceriesRow!.amount)).toBeCloseTo(-200, 2);
    // Parent amount should NOT appear as an uncategorized row
    expect(parentAsNullCat).toBeUndefined();
  });

  // ── Test 4: pending excluded; soft-deleted excluded ───────────────────────
  it("excludes pending entries and soft-deleted entries", async () => {
    const { bank, food } = seeds;

    // Pending entry
    await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-04-10",
      amount: "-999.0000",
      categoryId: food.id,
      status: "pending",
    });

    // Posted entry that we'll soft-delete
    const deletedId = await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-04-11",
      amount: "-888.0000",
      categoryId: food.id,
    });
    await tdb
      .update(schema.entries)
      .set({ deletedAt: new Date() })
      .where(eq(schema.entries.id, deletedId));

    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");

    const rows = await getRollups("2026-04-01");
    expect(rows).toHaveLength(0);
  });

  // ── Test 5: fromMonth only touches months >= fromMonth ────────────────────
  it("rebuildRollups from May does not touch April rows", async () => {
    const { bank, food, salary } = seeds;

    // April data
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-10", amount: "-100.0000", categoryId: food.id });
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-20", amount: "50000.0000", categoryId: salary.id });

    // Build April + May initially
    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");

    // Capture April rows
    const aprilBefore = await tdb
      .select()
      .from(schema.rollups)
      .where(
        and(
          eq(schema.rollups.householdId, seeds.hh.id),
          eq(schema.rollups.month, "2026-04-01"),
        ),
      )
      .orderBy(schema.rollups.categoryId);

    // Add a May entry
    await createTransaction(tdb, { accountId: bank.id, date: "2026-05-05", amount: "-200.0000", categoryId: food.id });

    // Rebuild from May only
    await rebuildRollups(tdb, seeds.hh.id, "2026-05-01");

    const aprilAfter = await tdb
      .select()
      .from(schema.rollups)
      .where(
        and(
          eq(schema.rollups.householdId, seeds.hh.id),
          eq(schema.rollups.month, "2026-04-01"),
        ),
      )
      .orderBy(schema.rollups.categoryId);

    expect(aprilAfter).toEqual(aprilBefore);

    // May row should exist
    const mayRows = await tdb
      .select()
      .from(schema.rollups)
      .where(
        and(
          eq(schema.rollups.householdId, seeds.hh.id),
          eq(schema.rollups.month, "2026-05-01"),
        ),
      );
    const mayFood = mayRows.find((r) => r.categoryId === food.id);
    expect(mayFood).toBeDefined();
    expect(parseFloat(mayFood!.amount)).toBeCloseTo(-200, 2);
  });

  // ── Test 6: idempotent ────────────────────────────────────────────────────
  it("is idempotent — running twice produces identical rows", async () => {
    const { bank, food, salary } = seeds;
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-10", amount: "-150.0000", categoryId: food.id });
    await createTransaction(tdb, { accountId: bank.id, date: "2026-04-25", amount: "30000.0000", categoryId: salary.id });

    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");
    const first = await getRollups();

    await rebuildRollups(tdb, seeds.hh.id, "2026-04-01");
    const second = await getRollups();

    expect(second).toEqual(first);
  });

  // ── Test 7: afterWrite produces balance rows and rollup rows ──────────────
  it("afterWrite produces both balance rows and rollup rows for the entry month", async () => {
    const { bank, food } = seeds;

    const entryId = await createTransaction(tdb, {
      accountId: bank.id,
      date: "2026-04-15",
      amount: "-500.0000",
      categoryId: food.id,
    });

    await afterWrite(tdb, {
      accountId: bank.id,
      householdId: seeds.hh.id,
      date: "2026-04-15",
    });

    // Balance row should exist for April 15
    const balanceRows = await tdb
      .select()
      .from(schema.balances)
      .where(
        and(
          eq(schema.balances.accountId, bank.id),
          eq(schema.balances.date, "2026-04-15"),
        ),
      );
    expect(balanceRows).toHaveLength(1);
    // Bank started at 1000, spent 500 → 500
    expect(parseFloat(balanceRows[0].balance)).toBeCloseTo(500, 2);

    // Rollup row for food in April should exist
    const rollupRows = await tdb
      .select()
      .from(schema.rollups)
      .where(
        and(
          eq(schema.rollups.householdId, seeds.hh.id),
          eq(schema.rollups.month, "2026-04-01"),
          eq(schema.rollups.categoryId, food.id),
        ),
      );
    expect(rollupRows).toHaveLength(1);
    expect(parseFloat(rollupRows[0].amount)).toBeCloseTo(-500, 2);
  });
});
