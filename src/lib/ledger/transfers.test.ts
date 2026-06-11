import { describe, it, expect, beforeEach } from "vitest";
import { eq, or } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction } from "./write";
import { proposeTransfers, confirmTransfer, rejectTransfer } from "./transfers";

describe.skipIf(!process.env.TEST_DATABASE_URL)("transfer matching", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  // 1. Basic happy-path match
  it("proposes a pending transfer for exactly opposite amounts within 2 days", async () => {
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-10",
      amount: "-5000",
      description: "ATM",
    });
    const inId = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-11",
      amount: "5000",
      description: "ATM",
    });

    const created = await proposeTransfers(tdb, s.hh.id);
    expect(created).toBe(1);

    const rows = await tdb.select().from(schema.transfers);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].outflowEntryId).toBe(outId);
    expect(rows[0].inflowEntryId).toBe(inId);
  });

  // 2. Non-matching cases
  it("does not propose for amount mismatch, same account, or date gap > 2 days", async () => {
    // amount mismatch
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-10",
      amount: "-5000",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-10",
      amount: "4000", // different absolute amount
    });

    // same account opposite
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-15",
      amount: "-1000",
    });
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-15",
      amount: "1000", // same account — should be ignored
    });

    // date gap of 4 days
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-20",
      amount: "-2000",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-24", // 4 days apart
      amount: "2000",
    });

    const created = await proposeTransfers(tdb, s.hh.id);
    expect(created).toBe(0);
    const rows = await tdb.select().from(schema.transfers);
    expect(rows).toHaveLength(0);
  });

  // 3. Reject then re-run: rejection memory prevents re-proposal
  it("does not re-propose a rejected pair", async () => {
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-10",
      amount: "-5000",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-11",
      amount: "5000",
    });

    // First run: 1 proposal
    const first = await proposeTransfers(tdb, s.hh.id);
    expect(first).toBe(1);

    // Get the transfer id
    const [transfer] = await tdb.select().from(schema.transfers);
    await rejectTransfer(tdb, transfer.id, "user");

    // Verify no transfer row remains
    const afterReject = await tdb.select().from(schema.transfers);
    expect(afterReject).toHaveLength(0);

    // Verify rejected pair is in rejected_transfers
    const rejected = await tdb.select().from(schema.rejectedTransfers);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].outflowEntryId).toBe(outId);

    // Second run: 0 proposals because pair is rejected
    const second = await proposeTransfers(tdb, s.hh.id);
    expect(second).toBe(0);
    const finalRows = await tdb.select().from(schema.transfers);
    expect(finalRows).toHaveLength(0);
  });

  // 4. Confirm: status flips and both legs get entry_events
  it("confirms a transfer and logs events on both legs", async () => {
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-10",
      amount: "-5000",
    });
    const inId = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-10",
      amount: "5000",
    });

    await proposeTransfers(tdb, s.hh.id);
    const [transfer] = await tdb.select().from(schema.transfers);

    await confirmTransfer(tdb, transfer.id, "user");

    const [updated] = await tdb
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transfer.id));
    expect(updated.status).toBe("confirmed");

    const events = await tdb
      .select()
      .from(schema.entryEvents)
      .where(
        or(
          eq(schema.entryEvents.entryId, outId),
          eq(schema.entryEvents.entryId, inId),
        ),
      );

    const transferEvents = events.filter((e) => e.field === "transfer");
    expect(transferEvents).toHaveLength(2);
    expect(transferEvents.every((e) => e.newValue === "confirmed")).toBe(true);

    const entryIds = transferEvents.map((e) => e.entryId);
    expect(entryIds).toContain(outId);
    expect(entryIds).toContain(inId);
  });

  // 5. Already-linked entries skipped on second proposeTransfers run
  it("does not duplicate proposals for already-linked entries", async () => {
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-3000",
    });
    await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-05-01",
      amount: "3000",
    });

    const first = await proposeTransfers(tdb, s.hh.id);
    expect(first).toBe(1);

    const second = await proposeTransfers(tdb, s.hh.id);
    expect(second).toBe(0);

    const rows = await tdb.select().from(schema.transfers);
    expect(rows).toHaveLength(1);
  });

  // 6. Greedy uniqueness: closer match wins when one entry could match two
  it("pairs with the closest date when multiple candidates exist (greedy)", async () => {
    // Bank outflow on Apr 10
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-10",
      amount: "-5000",
    });
    // Two cash inflows: Apr 10 (distance 0) and Apr 12 (distance 2)
    const inClose = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-10",
      amount: "5000",
    });
    const inFar = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-12",
      amount: "5000",
    });

    const created = await proposeTransfers(tdb, s.hh.id);
    expect(created).toBe(1);

    const [transfer] = await tdb.select().from(schema.transfers);
    expect(transfer.outflowEntryId).toBe(outId);
    expect(transfer.inflowEntryId).toBe(inClose); // closer one wins
    expect(transfer.inflowEntryId).not.toBe(inFar);
  });
});
