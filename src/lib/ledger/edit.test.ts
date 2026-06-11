import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction } from "./write";
import { allocate, add } from "@/lib/money";
import { setSplits, makeTransferPair } from "./edit";

describe.skipIf(!process.env.TEST_DATABASE_URL)("edit: setSplits", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  it("splits a -300 expense into -100 food / -200 groceries; nulls parent category", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-300.0000",
      categoryId: s.food.id,
    });

    await setSplits(
      tdb,
      entryId,
      [
        { categoryId: s.food.id, amount: "-100.0000" },
        { categoryId: s.groceries.id, amount: "-200.0000" },
      ],
      "user",
    );

    // parent category must be nulled
    const [txn] = await tdb
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.entryId, entryId));
    expect(txn.categoryId).toBeNull();

    // splits exist
    const splits = await tdb
      .select()
      .from(schema.transactionSplits)
      .where(eq(schema.transactionSplits.entryId, entryId));
    expect(splits).toHaveLength(2);
    const amounts = splits.map((s) => s.amount).sort();
    expect(amounts).toEqual(["-200.0000", "-100.0000"].sort());
  });

  it("re-setSplits replaces the existing set", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-300.0000",
    });

    await setSplits(
      tdb,
      entryId,
      [
        { categoryId: s.food.id, amount: "-100.0000" },
        { categoryId: s.groceries.id, amount: "-200.0000" },
      ],
      "user",
    );

    // replace with a single split
    await setSplits(
      tdb,
      entryId,
      [{ categoryId: s.groceries.id, amount: "-300.0000" }],
      "user",
    );

    const splits = await tdb
      .select()
      .from(schema.transactionSplits)
      .where(eq(schema.transactionSplits.entryId, entryId));
    expect(splits).toHaveLength(1);
    expect(splits[0].categoryId).toBe(s.groceries.id);
    expect(splits[0].amount).toBe("-300.0000");
  });

  it("rejects splits that don't sum to the entry amount with a friendly message", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-300.0000",
    });

    await expect(
      setSplits(
        tdb,
        entryId,
        [
          { categoryId: s.food.id, amount: "-100.0000" },
          { categoryId: s.groceries.id, amount: "-100.0000" }, // only sums to -200, not -300
        ],
        "user",
      ),
    ).rejects.toThrow("splits must sum to the transaction amount");
  });

  it("allocate(total, n) splits sum exactly to total", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-301.0000",
    });

    const parts = allocate("-301.0000", 3);
    // verify allocate itself is exact
    const sum = parts.reduce((acc, p) => add(acc, p), "0.0000");
    expect(sum).toBe("-301.0000");

    await setSplits(
      tdb,
      entryId,
      parts.map((amount) => ({ categoryId: s.food.id, amount })),
      "user",
    );

    const splits = await tdb
      .select()
      .from(schema.transactionSplits)
      .where(eq(schema.transactionSplits.entryId, entryId));
    expect(splits).toHaveLength(3);
  });

  it("empty array clears splits", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-300.0000",
    });

    await setSplits(
      tdb,
      entryId,
      [
        { categoryId: s.food.id, amount: "-100.0000" },
        { categoryId: s.groceries.id, amount: "-200.0000" },
      ],
      "user",
    );

    await setSplits(tdb, entryId, [], "user");

    const splits = await tdb
      .select()
      .from(schema.transactionSplits)
      .where(eq(schema.transactionSplits.entryId, entryId));
    expect(splits).toHaveLength(0);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("edit: makeTransferPair", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  it("pairs a valid -5000/+5000 across different accounts and confirms the transfer", async () => {
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-5000.0000",
      description: "ATM",
    });
    const inId = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-07-01",
      amount: "5000.0000",
      description: "ATM",
    });

    const transferId = await makeTransferPair(tdb, outId, inId);
    expect(transferId).toBeTruthy();

    const [transfer] = await tdb
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transferId));
    expect(transfer.status).toBe("confirmed");
    expect(transfer.outflowEntryId).toBe(outId);
    expect(transfer.inflowEntryId).toBe(inId);
  });

  it("rejects an invalid pair (-100/+90) with a friendly error", async () => {
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-07-01",
      amount: "-100.0000",
    });
    const inId = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-07-01",
      amount: "90.0000", // not equal magnitude
    });

    await expect(makeTransferPair(tdb, outId, inId)).rejects.toThrow(
      /amounts must be equal and opposite/i,
    );
  });
});
