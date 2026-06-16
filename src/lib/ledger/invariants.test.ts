import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction, createValuation } from "./write";
import { runInvariantChecks } from "./invariants";

describe.skipIf(!process.env.TEST_DATABASE_URL)("invariant checks", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  // --------------------------------------------------------------------------
  // 1. Clean ledger — all checks must return 0
  // --------------------------------------------------------------------------
  it("clean ledger: no anomalies", async () => {
    // a few transactions
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-01",
      amount: "-500.00",
      categoryId: s.food.id,
      status: "posted",
    });
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-15",
      amount: "2000.00",
      categoryId: s.salary.id,
      status: "posted",
    });
    // a valuation whose pending adjustment exactly closes the gap — must NOT be flagged
    await createValuation(tdb, {
      accountId: s.bank.id,
      date: "2026-04-30",
      amount: "2500.00", // opening 1000 − 500 + 2000 = 2500 → zero gap
      kind: "reconciliation",
    });

    const counts = await runInvariantChecks(tdb);
    expect(counts.orphan_transfer_leg).toBe(0);
    expect(counts.transfer_imbalance).toBe(0);
    expect(counts.split_mismatch).toBe(0);
    expect(counts.anchor_residual).toBe(0);
    expect(counts.sign_mismatch).toBe(0);
    expect(counts.stale_series).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 2. transfer_imbalance: −100 out + +90 in ≠ 0
  // --------------------------------------------------------------------------
  it("transfer_imbalance: mismatched legs flagged", async () => {
    // build two entries without creating a transfer first so the legs are valid
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-05",
      amount: "-100.00",
      status: "posted",
    });
    const inId = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-05",
      amount: "90.00",
      status: "posted",
    });

    // disable trigger so we can insert an imbalanced transfer row
    await tdb.execute(sql`ALTER TABLE transfers DISABLE TRIGGER transfer_integrity`);
    await tdb.execute(sql`
      INSERT INTO transfers (outflow_entry_id, inflow_entry_id)
      VALUES (${outId}, ${inId})
    `);
    await tdb.execute(sql`ALTER TABLE transfers ENABLE TRIGGER transfer_integrity`);

    const counts = await runInvariantChecks(tdb);
    expect(counts.transfer_imbalance).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // 3. orphan_transfer_leg: soft-delete one leg of a real transfer
  // --------------------------------------------------------------------------
  it("orphan_transfer_leg: soft-deleted leg flagged", async () => {
    const outId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-10",
      amount: "-200.00",
      status: "posted",
    });
    const inId = await createTransaction(tdb, {
      accountId: s.cash.id,
      date: "2026-04-10",
      amount: "200.00",
      status: "posted",
    });

    // insert a balanced transfer (trigger will allow this)
    await tdb.execute(sql`ALTER TABLE transfers DISABLE TRIGGER transfer_integrity`);
    await tdb.execute(sql`
      INSERT INTO transfers (outflow_entry_id, inflow_entry_id)
      VALUES (${outId}, ${inId})
    `);
    await tdb.execute(sql`ALTER TABLE transfers ENABLE TRIGGER transfer_integrity`);

    // soft-delete one leg, bypassing the guard
    await tdb.execute(sql`ALTER TABLE entries DISABLE TRIGGER transfer_leg_delete_guard`);
    await tdb.execute(sql`
      UPDATE entries SET deleted_at = NOW() WHERE id = ${outId}
    `);
    await tdb.execute(sql`ALTER TABLE entries ENABLE TRIGGER transfer_leg_delete_guard`);

    const counts = await runInvariantChecks(tdb);
    expect(counts.orphan_transfer_leg).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // 4. split_mismatch: splits summing to wrong total
  // --------------------------------------------------------------------------
  it("split_mismatch: mismatched split sum flagged", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-20",
      amount: "-300.00",
      status: "posted",
    });

    // disable splits_integrity constraint trigger
    await tdb.execute(sql`ALTER TABLE transaction_splits DISABLE TRIGGER splits_integrity`);
    // insert splits that sum to −200 (not −300) — mismatch
    await tdb.execute(sql`
      INSERT INTO transaction_splits (entry_id, amount)
      VALUES (${entryId}, -120.00), (${entryId}, -80.00)
    `);
    await tdb.execute(sql`ALTER TABLE transaction_splits ENABLE TRIGGER splits_integrity`);

    const counts = await runInvariantChecks(tdb);
    expect(counts.split_mismatch).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // 5. anchor_residual: delete the pending adjustment after createValuation
  // --------------------------------------------------------------------------
  it("anchor_residual: residual flagged after adjustment deleted", async () => {
    // put something on the account first so the gap is non-trivial
    await createTransaction(tdb, {
      accountId: s.epf.id,
      date: "2026-04-01",
      amount: "5000.00",
      status: "posted",
    });

    // createValuation materialises a pending adjustment to cover the gap
    const { adjustmentEntryId } = await createValuation(tdb, {
      accountId: s.epf.id,
      date: "2026-04-30",
      amount: "8000.00", // gap = 8000 − (0 + 5000) = 3000
      kind: "reconciliation",
    });

    expect(adjustmentEntryId).not.toBeNull();

    // hard-delete the adjustment rows to simulate corruption
    // the audit-log FK (RESTRICT) blocks entry hard-deletes — clear events first
    await tdb.execute(sql`DELETE FROM entry_events WHERE entry_id = ${adjustmentEntryId}`);
    await tdb.execute(sql`DELETE FROM transactions WHERE entry_id = ${adjustmentEntryId}`);
    await tdb.execute(sql`DELETE FROM entries WHERE id = ${adjustmentEntryId}`);

    const counts = await runInvariantChecks(tdb);
    expect(counts.anchor_residual).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // 6. sign_mismatch: food (expense) entry forced to positive via raw SQL
  // --------------------------------------------------------------------------
  it("sign_mismatch: expense entry with positive amount flagged", async () => {
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-01",
      amount: "-250.00",
      categoryId: s.food.id,
      status: "posted",
    });

    // bypass write path — flip the sign directly
    await tdb.execute(sql`UPDATE entries SET amount = 250.00 WHERE id = ${entryId}`);

    const counts = await runInvariantChecks(tdb);
    expect(counts.sign_mismatch).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // 7. Dedup: running checks twice must not double-insert anomaly rows
  // --------------------------------------------------------------------------
  it("dedup: second run does not create duplicate anomaly rows", async () => {
    // create a sign_mismatch violation
    const entryId = await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-05-10",
      amount: "-100.00",
      categoryId: s.food.id,
      status: "posted",
    });
    await tdb.execute(sql`UPDATE entries SET amount = 100.00 WHERE id = ${entryId}`);

    await runInvariantChecks(tdb);

    const before = await tdb
      .select()
      .from(schema.ledgerAnomalies);

    await runInvariantChecks(tdb);

    const after = await tdb
      .select()
      .from(schema.ledgerAnomalies);

    expect(after.length).toBe(before.length);
  });

  // --------------------------------------------------------------------------
  // 8. oversold_holding: net units driven negative
  // --------------------------------------------------------------------------
  it("flags an oversold holding (units driven negative)", async () => {
    const { hh } = await seedBasics();
    const [acct] = await tdb.insert(schema.accounts).values({ householdId: hh.id, name: "Z", kind: "investment", openingDate: "2026-01-01" }).returning();
    const [inst] = await tdb.insert(schema.instruments).values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "1" }).returning();
    const { createTrade } = await import("@/lib/invest/trade");
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "10", price: "60" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-03-01", side: "sell", units: "25", price: "60" });
    const counts = await runInvariantChecks(tdb);
    expect(counts.oversold_holding).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 9. trade_cash_mismatch: entry.amount disagrees with units*price
  // --------------------------------------------------------------------------
  it("flags a trade whose cash amount disagrees with units*price", async () => {
    const { hh } = await seedBasics();
    const [acct] = await tdb.insert(schema.accounts).values({ householdId: hh.id, name: "Z", kind: "investment", openingDate: "2026-01-01" }).returning();
    const [inst] = await tdb.insert(schema.instruments).values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "2" }).returning();
    const { createTrade } = await import("@/lib/invest/trade");
    const entryId = await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "10", price: "60" });
    // corrupt the cash amount (should be -600): set to -999
    await tdb.update(schema.entries).set({ amount: "-999.0000" }).where(eq(schema.entries.id, entryId));
    const counts = await runInvariantChecks(tdb);
    expect(counts.trade_cash_mismatch).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 10. stale_price: held instrument with no recent price
  // --------------------------------------------------------------------------
  it("flags a held instrument with no recent price", async () => {
    const { hh } = await seedBasics();
    const [acct] = await tdb.insert(schema.accounts).values({ householdId: hh.id, name: "Z", kind: "investment", openingDate: "2026-01-01" }).returning();
    const [inst] = await tdb.insert(schema.instruments).values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "3" }).returning();
    const { createTrade } = await import("@/lib/invest/trade");
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "10", price: "60" });
    // no prices row at all → stale
    const counts = await runInvariantChecks(tdb);
    expect(counts.stale_price).toBe(1);
  });
});
