import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import {
  createTransaction,
  createValuation,
  annotate,
  softDelete,
  getEntry,
  getTransaction,
} from "./write";

describe.skipIf(!process.env.TEST_DATABASE_URL)("ledger write path", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;
  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  it("createTransaction writes entry + subtype and logs a created event", async () => {
    const id = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-342.00",
      description: "Swiggy",
      categoryId: s.food.id,
      source: "manual",
    });
    const entry = await getEntry(tdb, id);
    expect(entry.amount).toBe("-342.0000");
    expect(entry.status).toBe("posted");
    const txn = await getTransaction(tdb, id);
    expect(txn.categoryId).toBe(s.food.id);
    const events = await tdb
      .select()
      .from(schema.entryEvents)
      .where(eq(schema.entryEvents.entryId, id));
    expect(events.map((e) => e.field)).toContain("created");
  });

  it("rejects zero amounts and sign/classification mismatches", async () => {
    await expect(
      createTransaction(tdb, { accountId: s.bank.id, date: "2026-07-01", amount: "0" }),
    ).rejects.toThrow(/zero/i);
    await expect(
      createTransaction(tdb, {
        accountId: s.bank.id,
        date: "2026-07-01",
        amount: "500.00", // positive amount on an expense category
        categoryId: s.food.id,
      }),
    ).rejects.toThrow(/sign/i);
    await expect(
      createTransaction(tdb, {
        accountId: s.bank.id,
        date: "2026-07-01",
        amount: "-500.00", // negative amount on an income category
        categoryId: s.salary.id,
      }),
    ).rejects.toThrow(/sign/i);
  });

  it("annotate by user locks category; later rules cannot overwrite it", async () => {
    const id = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-100.00",
      description: "BLINKIT",
    });
    await annotate(tdb, id, { categoryId: s.groceries.id }, "user");
    await annotate(tdb, id, { categoryId: s.food.id }, "rule:some-rule");
    const txn = await getTransaction(tdb, id);
    expect(txn.categoryId).toBe(s.groceries.id); // user wins
    expect(txn.categoryLocked).toBe(true);

    const events = await tdb
      .select()
      .from(schema.entryEvents)
      .where(eq(schema.entryEvents.entryId, id));
    const catEvents = events.filter((e) => e.field === "categoryId");
    expect(catEvents).toHaveLength(1); // the rule's blocked attempt logs nothing
    expect(catEvents[0].source).toBe("user");
    expect(catEvents[0].newValue).toBe(s.groceries.id);
  });

  it("rules CAN categorize when the user has not locked", async () => {
    const id = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-100.00",
    });
    await annotate(tdb, id, { categoryId: s.food.id }, "rule:r1");
    const txn = await getTransaction(tdb, id);
    expect(txn.categoryId).toBe(s.food.id);
    expect(txn.categoryLocked).toBe(false);
  });

  it("createValuation materializes a pending adjustment for the gap (EPF interest)", async () => {
    await createTransaction(tdb, {
      accountId: s.epf.id,
      date: "2026-04-01",
      amount: "10000",
      description: "EPF contribution",
    });
    await createTransaction(tdb, {
      accountId: s.epf.id,
      date: "2026-05-01",
      amount: "10000",
      description: "EPF contribution",
    });
    const { adjustmentEntryId } = await createValuation(tdb, {
      accountId: s.epf.id,
      date: "2026-06-01",
      amount: "28000",
      kind: "reconciliation",
    });
    expect(adjustmentEntryId).not.toBeNull();
    const adj = await getEntry(tdb, adjustmentEntryId!);
    expect(adj.amount).toBe("8000.0000"); // 28000 − (0 opening + 20000)
    expect(adj.status).toBe("pending"); // lands in review inbox
    expect(adj.source).toBe("system");
    const adjTxn = await getTransaction(tdb, adjustmentEntryId!);
    expect(adjTxn.isAdjustment).toBe(true);
    expect(adjTxn.categoryId).toBe(s.adjustment.id);
  });

  it("createValuation with zero gap creates no adjustment (liability anchor)", async () => {
    await createTransaction(tdb, {
      accountId: s.card.id,
      date: "2026-07-10",
      amount: "-45000",
      description: "big purchase",
    });
    const { adjustmentEntryId } = await createValuation(tdb, {
      accountId: s.card.id,
      date: "2026-07-31",
      amount: "-45000", // statement outstanding ₹45,000 → stored negative per ADR-1
      kind: "reconciliation",
    });
    expect(adjustmentEntryId).toBeNull();
  });

  it("valuation entries are never summed into balances (anchor is not a delta)", async () => {
    await createValuation(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "1000", // equals opening balance → no gap
      kind: "reconciliation",
    });
    const { adjustmentEntryId } = await createValuation(tdb, {
      accountId: s.bank.id,
      date: "2026-07-02",
      amount: "1000", // still no gap — the first anchor must not have shifted the balance
      kind: "reconciliation",
    });
    expect(adjustmentEntryId).toBeNull();
  });

  it("softDelete refuses transfer legs, works otherwise, and logs", async () => {
    const out = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-03",
      amount: "-5000",
      description: "ATM",
    });
    const inn = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-07-03",
      amount: "5000",
      description: "ATM",
    });
    await tdb.insert(schema.transfers).values({ outflowEntryId: out, inflowEntryId: inn });

    await expect(softDelete(tdb, out, "user")).rejects.toThrow(/transfer/i);

    const lone = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-04",
      amount: "-50",
    });
    await softDelete(tdb, lone, "user");
    const entry = await getEntry(tdb, lone);
    expect(entry.deletedAt).not.toBeNull();
    const events = await tdb
      .select()
      .from(schema.entryEvents)
      .where(eq(schema.entryEvents.entryId, lone));
    expect(events.map((e) => e.field)).toContain("deleted");
  });
});
