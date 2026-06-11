import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction, annotate, getTransaction } from "./write";
import { evaluateRule, applyRulesTo } from "./rules";
import type { Rule } from "./rules";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    householdId: "00000000-0000-0000-0000-000000000002",
    name: "test rule",
    priority: 0,
    active: true,
    matchMode: "all",
    conditions: [],
    actions: [],
    ...overrides,
  };
}

// ── Pure evaluator tests (no DB required) ────────────────────────────────────

describe("evaluateRule — pure", () => {
  it("contains is case-insensitive on description", () => {
    const rule = makeRule({
      conditions: [{ field: "description", op: "contains", value: "SWIGGY" }],
      actions: [{ type: "set_category", value: "cat-food" }],
    });
    expect(evaluateRule(rule, { description: "swiggy order #12", merchant: null, amount: "-100.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "Swiggy Order", merchant: null, amount: "-100.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "blinkit", merchant: null, amount: "-100.00" })).toHaveLength(0);
  });

  it("contains is case-insensitive on merchant", () => {
    const rule = makeRule({
      conditions: [{ field: "merchant", op: "contains", value: "zomato" }],
      actions: [{ type: "set_category", value: "cat-food" }],
    });
    expect(evaluateRule(rule, { description: "x", merchant: "ZOMATO LTD", amount: "-200.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "-200.00" })).toHaveLength(0);
  });

  it("equals is case-insensitive on description", () => {
    const rule = makeRule({
      conditions: [{ field: "description", op: "equals", value: "Salary" }],
      actions: [{ type: "set_category", value: "cat-salary" }],
    });
    expect(evaluateRule(rule, { description: "SALARY", merchant: null, amount: "50000.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "salary credit", merchant: null, amount: "50000.00" })).toHaveLength(0);
  });

  it("matchMode 'all' requires every condition to be true", () => {
    const rule = makeRule({
      matchMode: "all",
      conditions: [
        { field: "description", op: "contains", value: "swiggy" },
        { field: "amount", op: "lt", value: "-500.00" },
      ],
      actions: [{ type: "set_category", value: "cat-food" }],
    });
    // both pass
    expect(evaluateRule(rule, { description: "swiggy dinner", merchant: null, amount: "-642.00" })).toHaveLength(1);
    // description fails
    expect(evaluateRule(rule, { description: "blinkit", merchant: null, amount: "-642.00" })).toHaveLength(0);
    // amount fails (−200 is NOT < −500)
    expect(evaluateRule(rule, { description: "swiggy lunch", merchant: null, amount: "-200.00" })).toHaveLength(0);
  });

  it("matchMode 'any' requires at least one condition to be true", () => {
    const rule = makeRule({
      matchMode: "any",
      conditions: [
        { field: "description", op: "contains", value: "swiggy" },
        { field: "description", op: "contains", value: "zomato" },
      ],
      actions: [{ type: "set_category", value: "cat-food" }],
    });
    expect(evaluateRule(rule, { description: "swiggy order", merchant: null, amount: "-100.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "zomato delivery", merchant: null, amount: "-200.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "blinkit", merchant: null, amount: "-50.00" })).toHaveLength(0);
  });

  it("amount lt: -642.00 lt -500.00 is TRUE (signed comparison, expenses are negative)", () => {
    // −642 < −500 → true
    const rule = makeRule({
      conditions: [{ field: "amount", op: "lt", value: "-500.00" }],
      actions: [{ type: "set_category", value: "cat-big-expense" }],
    });
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "-642.00" })).toHaveLength(1);
    // −200 is NOT < −500
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "-200.00" })).toHaveLength(0);
  });

  it("amount gt: 5000.00 gt 3000.00 is TRUE", () => {
    const rule = makeRule({
      conditions: [{ field: "amount", op: "gt", value: "3000.00" }],
      actions: [{ type: "set_category", value: "cat-salary" }],
    });
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "5000.00" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "1000.00" })).toHaveLength(0);
  });

  it("amount equals: cmp()==0 match", () => {
    const rule = makeRule({
      conditions: [{ field: "amount", op: "equals", value: "-100.00" }],
      actions: [{ type: "set_category", value: "cat" }],
    });
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "-100.0000" })).toHaveLength(1);
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "-100.01" })).toHaveLength(0);
  });

  it("zero conditions → no match", () => {
    const rule = makeRule({
      conditions: [],
      actions: [{ type: "set_category", value: "cat-food" }],
    });
    expect(evaluateRule(rule, { description: "swiggy", merchant: null, amount: "-100.00" })).toHaveLength(0);
  });

  it("null merchant never matches contains or equals on merchant field", () => {
    const rule = makeRule({
      conditions: [{ field: "merchant", op: "contains", value: "swiggy" }],
      actions: [{ type: "set_category", value: "cat-food" }],
    });
    expect(evaluateRule(rule, { description: "swiggy order", merchant: null, amount: "-100.00" })).toHaveLength(0);
  });

  it("gt/lt on description/merchant field → false (not meaningful)", () => {
    const rule = makeRule({
      conditions: [{ field: "description", op: "gt", value: "abc" }],
      actions: [{ type: "set_category", value: "cat" }],
    });
    expect(evaluateRule(rule, { description: "zzz", merchant: null, amount: "-100.00" })).toHaveLength(0);
  });

  it("contains on amount field → false (not meaningful)", () => {
    const rule = makeRule({
      conditions: [{ field: "amount", op: "contains", value: "100" }],
      actions: [{ type: "set_category", value: "cat" }],
    });
    expect(evaluateRule(rule, { description: "x", merchant: null, amount: "-100.00" })).toHaveLength(0);
  });
});

// ── DB tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.TEST_DATABASE_URL)("applyRulesTo — DB", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  type RuleCondition = NonNullable<(typeof schema.rules)["$inferInsert"]["conditions"]>[number];
  type RuleAction = NonNullable<(typeof schema.rules)["$inferInsert"]["actions"]>[number];

  async function insertRule(
    overrides: Partial<{
      name: string;
      priority: number;
      active: boolean;
      matchMode: "all" | "any";
      conditions: RuleCondition[];
      actions: RuleAction[];
    }>,
  ) {
    const [rule] = await tdb
      .insert(schema.rules)
      .values({
        householdId: s.hh.id,
        name: overrides.name ?? "rule",
        priority: overrides.priority ?? 0,
        active: overrides.active ?? true,
        matchMode: overrides.matchMode ?? "all",
        conditions: overrides.conditions ?? [],
        actions: overrides.actions ?? [],
      })
      .returning();
    return rule;
  }

  it("SWIGGY rule sets food category; entry_events row has source rule:<id>", async () => {
    const rule = await insertRule({
      name: "swiggy → food",
      conditions: [{ field: "description", op: "contains", value: "swiggy" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-15",
      amount: "-350.00",
      description: "SWIGGY ORDER #99",
    });

    await applyRulesTo(tdb, s.hh.id, [entryId]);

    const txn = await getTransaction(tdb, entryId);
    expect(txn.categoryId).toBe(s.food.id);

    const events = await tdb
      .select()
      .from(schema.entryEvents)
      .where(and(eq(schema.entryEvents.entryId, entryId), eq(schema.entryEvents.field, "categoryId")));
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe(`rule:${rule.id}`);
    expect(events[0].newValue).toBe(s.food.id);
  });

  it("priority: lower priority number wins (groceries p1 beats food p2)", async () => {
    await insertRule({
      name: "groceries",
      priority: 1,
      conditions: [{ field: "description", op: "contains", value: "blinkit" }],
      actions: [{ type: "set_category", value: s.groceries.id }],
    });
    await insertRule({
      name: "food catch-all",
      priority: 2,
      conditions: [{ field: "description", op: "contains", value: "blinkit" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-10",
      amount: "-250.00",
      description: "blinkit groceries",
    });

    await applyRulesTo(tdb, s.hh.id, [entryId]);

    const txn = await getTransaction(tdb, entryId);
    expect(txn.categoryId).toBe(s.groceries.id); // priority 1 wins
  });

  it("lock respected: user-set category is not overwritten by rule", async () => {
    await insertRule({
      name: "swiggy → food",
      conditions: [{ field: "description", op: "contains", value: "swiggy" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-20",
      amount: "-500.00",
      description: "SWIGGY delivery",
    });

    // User manually sets groceries (locks it)
    await annotate(tdb, entryId, { categoryId: s.groceries.id }, "user");

    await applyRulesTo(tdb, s.hh.id, [entryId]);

    const txn = await getTransaction(tdb, entryId);
    expect(txn.categoryId).toBe(s.groceries.id); // user wins
    expect(txn.categoryLocked).toBe(true);

    // Only one categoryId event (from the user), not two
    const catEvents = await tdb
      .select()
      .from(schema.entryEvents)
      .where(and(eq(schema.entryEvents.entryId, entryId), eq(schema.entryEvents.field, "categoryId")));
    expect(catEvents).toHaveLength(1);
    expect(catEvents[0].source).toBe("user");
  });

  it("inactive rules are skipped", async () => {
    await insertRule({
      name: "inactive rule",
      active: false,
      conditions: [{ field: "description", op: "contains", value: "swiggy" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-100.00",
      description: "SWIGGY",
    });

    await applyRulesTo(tdb, s.hh.id, [entryId]);

    const txn = await getTransaction(tdb, entryId);
    expect(txn.categoryId).toBeNull(); // no rule applied
  });

  it("add_tag: creates entryTags row; running twice does not duplicate", async () => {
    const [tag] = await tdb
      .insert(schema.tags)
      .values({ householdId: s.hh.id, name: "80E" })
      .returning();

    await insertRule({
      name: "tag 80E",
      conditions: [{ field: "description", op: "contains", value: "80e" }],
      actions: [{ type: "add_tag", value: "80E" }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-01",
      amount: "-12000.00",
      description: "LIC premium 80E",
    });

    await applyRulesTo(tdb, s.hh.id, [entryId]);

    const rows1 = await tdb
      .select()
      .from(schema.entryTags)
      .where(eq(schema.entryTags.entryId, entryId));
    expect(rows1).toHaveLength(1);
    expect(rows1[0].tagId).toBe(tag.id);

    // Run again — must not duplicate
    await applyRulesTo(tdb, s.hh.id, [entryId]);

    const rows2 = await tdb
      .select()
      .from(schema.entryTags)
      .where(eq(schema.entryTags.entryId, entryId));
    expect(rows2).toHaveLength(1);
  });

  it("unknown tag name in add_tag action is a silent no-op", async () => {
    await insertRule({
      name: "unknown tag",
      conditions: [{ field: "description", op: "contains", value: "salary" }],
      actions: [{ type: "add_tag", value: "NonExistentTag" }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-31",
      amount: "80000.00",
      description: "salary credit",
      categoryId: s.salary.id,
    });

    // Should not throw
    await expect(applyRulesTo(tdb, s.hh.id, [entryId])).resolves.toBeUndefined();

    const rows = await tdb
      .select()
      .from(schema.entryTags)
      .where(eq(schema.entryTags.entryId, entryId));
    expect(rows).toHaveLength(0);
  });

  it("deleted entries are skipped silently", async () => {
    await insertRule({
      name: "catch-all",
      conditions: [{ field: "description", op: "contains", value: "test" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-05",
      amount: "-10.00",
      description: "test entry",
    });

    // Soft-delete by setting deletedAt directly (avoid softDelete restrictions)
    await tdb
      .update(schema.entries)
      .set({ deletedAt: new Date() })
      .where(eq(schema.entries.id, entryId));

    // Should not throw, should skip
    await expect(applyRulesTo(tdb, s.hh.id, [entryId])).resolves.toBeUndefined();
  });

  it("empty entryIds array is a no-op", async () => {
    await expect(applyRulesTo(tdb, s.hh.id, [])).resolves.toBeUndefined();
  });
});
