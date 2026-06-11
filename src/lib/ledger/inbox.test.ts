import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction, createValuation } from "./write";
import { proposeTransfers, confirmTransfer } from "./transfers";
import { inboxCount, inboxItems, acceptEntry, acceptAll } from "./inbox";
import { computeBalanceAt } from "./derive";

describe.skipIf(!process.env.TEST_DATABASE_URL)("inbox", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  // ── 1. Pending entry appears in count + items ──────────────────────────────

  it("counts a pending transaction entry", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-500",
      description: "Import: Coffee",
      status: "pending",
      source: "import",
    });

    const count = await inboxCount(tdb, s.hh.id);
    expect(count).toBe(1);
  });

  it("does not count posted entries", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-500",
      description: "Posted already",
      status: "posted",
    });

    const count = await inboxCount(tdb, s.hh.id);
    expect(count).toBe(0);
  });

  it("does not count deleted pending entries", async () => {
    const id = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-500",
      description: "Deleted",
      status: "pending",
      source: "import",
    });

    await tdb.update(schema.entries).set({ deletedAt: new Date() }).where(eq(schema.entries.id, id));

    const count = await inboxCount(tdb, s.hh.id);
    expect(count).toBe(0);
  });

  it("pending entry appears in inboxItems.pendingEntries with account name", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-500",
      description: "Import: Coffee",
      status: "pending",
      source: "import",
    });

    const items = await inboxItems(tdb, s.hh.id);
    expect(items.pendingEntries).toHaveLength(1);
    expect(items.pendingEntries[0].accountName).toBe("HDFC");
    expect(items.pendingEntries[0].amount).toBe("-500.0000");
    expect(items.pendingEntries[0].description).toBe("Import: Coffee");
  });

  it("items are returned newest first", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-100",
      description: "Old",
      status: "pending",
      source: "import",
    });
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-06-01",
      amount: "-200",
      description: "New",
      status: "pending",
      source: "import",
    });

    const items = await inboxItems(tdb, s.hh.id);
    expect(items.pendingEntries[0].description).toBe("New");
    expect(items.pendingEntries[1].description).toBe("Old");
  });

  // ── 2. acceptEntry: category locked + posted + afterWrite ─────────────────

  it("acceptEntry with categoryId: sets category locked, posts entry, balance row exists", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-10",
      amount: "-300",
      description: "Dinner",
      status: "pending",
      source: "import",
    });

    await acceptEntry(tdb, entryId, "user", s.food.id);

    // entry is now posted
    const [entry] = await tdb
      .select({ status: schema.entries.status })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId));
    expect(entry.status).toBe("posted");

    // category is set and locked
    const [txn] = await tdb
      .select({ categoryId: schema.transactions.categoryId, categoryLocked: schema.transactions.categoryLocked })
      .from(schema.transactions)
      .where(eq(schema.transactions.entryId, entryId));
    expect(txn.categoryId).toBe(s.food.id);
    expect(txn.categoryLocked).toBe(true);

    // balances row exists for that date
    const [bal] = await tdb
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.accountId, s.bank.id));
    expect(bal).toBeDefined();

    // no longer in inbox
    const count = await inboxCount(tdb, s.hh.id);
    expect(count).toBe(0);
  });

  it("acceptEntry without categoryId: posts entry, no category change", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-11",
      amount: "-200",
      description: "Mystery",
      status: "pending",
      source: "import",
    });

    await acceptEntry(tdb, entryId, "user");

    const [entry] = await tdb
      .select({ status: schema.entries.status })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId));
    expect(entry.status).toBe("posted");

    const [txn] = await tdb
      .select({ categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(eq(schema.transactions.entryId, entryId));
    expect(txn.categoryId).toBeNull();
  });

  it("acceptEntry appends a status entry_event", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-12",
      amount: "-50",
      description: "Tea",
      status: "pending",
      source: "import",
    });

    await acceptEntry(tdb, entryId, "user");

    const events = await tdb
      .select()
      .from(schema.entryEvents)
      .where(eq(schema.entryEvents.entryId, entryId));

    const statusEvent = events.find((e) => e.field === "status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.oldValue).toBe("pending");
    expect(statusEvent!.newValue).toBe("posted");
    expect(statusEvent!.source).toBe("user");
  });

  // ── 3. Adjustment entry appears flagged isAdjustment ──────────────────────

  it("adjustment entry from createValuation appears in inbox flagged as isAdjustment", async () => {
    // Bank opening balance = "1000", add a posted txn then create valuation with gap
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-200",
      description: "Coffee",
      status: "posted",
    });
    // Derived balance at 2026-05-01 should be 800. Anchor at 1200 creates a +400 gap.
    const { adjustmentEntryId } = await createValuation(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "1200",
      kind: "reconciliation",
    });
    expect(adjustmentEntryId).not.toBeNull();

    const items = await inboxItems(tdb, s.hh.id);
    const adj = items.pendingEntries.find((e) => e.entryId === adjustmentEntryId);
    expect(adj).toBeDefined();
    expect(adj!.isAdjustment).toBe(true);
  });

  // ── 4. Pending transfer appears, confirm removes it ────────────────────────

  it("pending transfer appears in inboxItems.pendingTransfers", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-05",
      amount: "-1000",
      description: "Transfer out",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-05-05",
      amount: "1000",
      description: "Transfer in",
    });
    const created = await proposeTransfers(tdb, s.hh.id);
    expect(created).toBe(1);

    const items = await inboxItems(tdb, s.hh.id);
    expect(items.pendingTransfers).toHaveLength(1);
    expect(items.pendingTransfers[0].outflow.accountName).toBe("HDFC");
    expect(items.pendingTransfers[0].inflow.accountName).toBe("Cash");
  });

  it("confirming transfer removes it from pendingTransfers and increments entry count by 0", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-05",
      amount: "-1000",
      description: "Transfer out",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-05-05",
      amount: "1000",
      description: "Transfer in",
    });
    await proposeTransfers(tdb, s.hh.id);

    const itemsBefore = await inboxItems(tdb, s.hh.id);
    const transferId = itemsBefore.pendingTransfers[0].transferId;

    await confirmTransfer(tdb, transferId, "user");

    const items = await inboxItems(tdb, s.hh.id);
    expect(items.pendingTransfers).toHaveLength(0);

    const count = await inboxCount(tdb, s.hh.id);
    // Transfers had 2 posted entries; confirming removes transfer from pending list.
    // Entry count not affected (they were posted, not pending).
    expect(count).toBe(0);
  });

  // ── 5. Count math: entries + transfers ────────────────────────────────────

  it("count = pending entries + pending transfers", async () => {
    // 1 pending entry
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-500",
      status: "pending",
      source: "import",
    });

    // 1 pending transfer (both entries posted)
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-05",
      amount: "-1000",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-05-05",
      amount: "1000",
    });
    await proposeTransfers(tdb, s.hh.id);

    const count = await inboxCount(tdb, s.hh.id);
    expect(count).toBe(2); // 1 pending entry + 1 pending transfer
  });

  // ── 6. acceptAll bulk ─────────────────────────────────────────────────────

  it("acceptAll posts all given entries and clears inbox", async () => {
    const id1 = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-100",
      status: "pending",
      source: "import",
    });
    const id2 = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-05-02",
      amount: "-50",
      status: "pending",
      source: "import",
    });

    await acceptAll(tdb, [id1, id2], "user");

    const count = await inboxCount(tdb, s.hh.id);
    expect(count).toBe(0);

    for (const id of [id1, id2]) {
      const [e] = await tdb
        .select({ status: schema.entries.status })
        .from(schema.entries)
        .where(eq(schema.entries.id, id));
      expect(e.status).toBe("posted");
    }
  });

  // ── 7. Suggestion via rules ───────────────────────────────────────────────

  it("suggests category from matching rule when entry has no category", async () => {
    // Create a rule that matches "Coffee" description → food category
    await tdb.insert(schema.rules).values({
      householdId: s.hh.id,
      name: "Coffee rule",
      priority: 0,
      active: true,
      matchMode: "all",
      conditions: [{ field: "description", op: "contains", value: "coffee" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-150",
      description: "coffee shop",
      status: "pending",
      source: "import",
    });

    const items = await inboxItems(tdb, s.hh.id);
    expect(items.pendingEntries[0].suggestedCategoryId).toBe(s.food.id);
  });

  it("does not show suggestion when category is already set", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-150",
      description: "coffee shop",
      status: "pending",
      source: "import",
      categoryId: s.groceries.id,
    });

    // Even with a matching rule, no suggestion because category is already set.
    await tdb.insert(schema.rules).values({
      householdId: s.hh.id,
      name: "Coffee rule",
      priority: 0,
      active: true,
      matchMode: "all",
      conditions: [{ field: "description", op: "contains", value: "coffee" }],
      actions: [{ type: "set_category", value: s.food.id }],
    });

    const items = await inboxItems(tdb, s.hh.id);
    // category is set, so suggestedCategoryId should be null
    expect(items.pendingEntries[0].suggestedCategoryId).toBeNull();
    expect(items.pendingEntries[0].categoryId).toBe(s.groceries.id);
  });
});
