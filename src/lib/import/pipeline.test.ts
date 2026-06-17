import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { buildHdfcCsvBuffer } from "./__fixtures__/fixture-builder";
import { parseFile } from "./parse";
import { applyMapping } from "./mapping";
import type { ColumnMapping } from "./mapping";
import { stageImport, commitImport, undoImport } from "./pipeline";
import { tradeCashAmount } from "@/lib/invest/trade";
import { computeHoldings } from "@/lib/invest/holdings";
import { acceptEntry } from "@/lib/ledger/inbox";
import { recordExample } from "@/lib/categorize/examples";
import type { CategorizeDeps } from "@/lib/categorize/categorize";

// HDFC mapping matching the fixture columns
const hdfcMapping: ColumnMapping = {
  date: "Date",
  description: "Narration",
  ref: "Chq./Ref.No.",
  debit: "Withdrawal Amt.",
  credit: "Deposit Amt.",
  balance: "Closing Balance",
  dateFormat: "dd/MM/yy",
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("import pipeline", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  // ── Helper: parse + map the HDFC fixture ─────────────────────────────────────

  async function prepareRows() {
    const buf = buildHdfcCsvBuffer();
    const { headers, rows } = await parseFile(buf, "hdfc.csv");
    const { ok, failed } = applyMapping(headers, rows, hdfcMapping);
    expect(failed).toHaveLength(0);
    return ok;
  }

  // ── stageImport ───────────────────────────────────────────────────────────────

  it("stageImport: creates import record and import rows with correct verdicts", async () => {
    const rows = await prepareRows();
    const { importId, stats } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });

    expect(importId).toBeTruthy();
    expect(stats.total).toBe(rows.length);
    expect(stats.new).toBe(rows.length);
    expect(stats.duplicates).toBe(0);

    // Check import record status
    const [imp] = await tdb
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId));
    expect(imp.status).toBe("staged");

    // Check import rows exist
    const importRows = await tdb
      .select()
      .from(schema.importRows)
      .where(eq(schema.importRows.importId, importId));
    expect(importRows).toHaveLength(rows.length);
    for (const ir of importRows) {
      expect(ir.verdict).toBe("new");
    }
  });

  // ── commitImport ──────────────────────────────────────────────────────────────

  it("commitImport: creates transactions for 'new' rows only, stamps entryIds", async () => {
    const rows = await prepareRows();
    const { importId } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });

    const { created } = await commitImport(tdb, importId, s.hh.id);
    expect(created).toBe(rows.length);

    // All import rows should have entryId stamped
    const importRows = await tdb
      .select()
      .from(schema.importRows)
      .where(eq(schema.importRows.importId, importId));
    for (const ir of importRows) {
      if (ir.verdict === "new") {
        expect(ir.entryId).toBeTruthy();
      }
    }

    // Import status should be committed
    const [imp] = await tdb
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId));
    expect(imp.status).toBe("committed");
  });

  it("commitImport is idempotent: second call returns {created:0}", async () => {
    const rows = await prepareRows();
    const { importId } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });

    await commitImport(tdb, importId, s.hh.id);
    const { created } = await commitImport(tdb, importId, s.hh.id);
    expect(created).toBe(0);
  });

  // ── Duplicate detection ───────────────────────────────────────────────────────

  it("re-staging the same file after commit → all rows are duplicates", async () => {
    const rows = await prepareRows();

    // First import committed
    const { importId: id1 } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });
    await commitImport(tdb, id1, s.hh.id);

    // Second import of the same file
    const { stats: stats2, importId: id2 } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });
    expect(stats2.duplicates).toBe(rows.length);
    expect(stats2.new).toBe(0);

    const importRows2 = await tdb
      .select()
      .from(schema.importRows)
      .where(eq(schema.importRows.importId, id2));
    for (const ir of importRows2) {
      expect(ir.verdict).toBe("duplicate");
    }
  });

  // ── undoImport ────────────────────────────────────────────────────────────────

  it("undoImport: soft-deletes committed entries, status becomes undone", async () => {
    const rows = await prepareRows();
    const { importId } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });
    await commitImport(tdb, importId, s.hh.id);

    const { deleted } = await undoImport(tdb, importId);
    expect(deleted).toBe(rows.length);

    const [imp] = await tdb
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId));
    expect(imp.status).toBe("undone");

    // Entries should be soft-deleted
    const importRows = await tdb
      .select()
      .from(schema.importRows)
      .where(eq(schema.importRows.importId, importId));
    for (const ir of importRows) {
      if (ir.entryId) {
        const [entry] = await tdb
          .select()
          .from(schema.entries)
          .where(eq(schema.entries.id, ir.entryId));
        expect(entry.deletedAt).not.toBeNull();
      }
    }
  });

  // ── Tombstones don't block re-import ─────────────────────────────────────────

  it("undo then re-stage+commit → entries re-created (tombstones don't block partial unique index)", async () => {
    const rows = await prepareRows();

    // First cycle
    const { importId: id1 } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });
    await commitImport(tdb, id1, s.hh.id);
    await undoImport(tdb, id1);

    // Second cycle — should not be flagged as duplicates
    const { stats: stats2 } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "hdfc.csv",
      rows,
    });
    expect(stats2.new).toBe(rows.length);
    expect(stats2.duplicates).toBe(0);
  });

  // ── Suspicious rows not committed ────────────────────────────────────────────

  it("suspicious rows are NOT committed", async () => {
    // Build a rows array with a continuity break to trigger 'suspicious'
    // oldest-first: start=10000
    //   row0: -500 → 9500
    //   row1: -200 → CORRUPTED(9999) ← suspicious
    //   row2: +50000 → 59999 (balance continues from corrupted)
    const brokenRows = [
      { date: "2026-07-01", amount: "-500.0000", description: "ATM", balance: "9500.0000" },
      { date: "2026-07-02", amount: "-200.0000", description: "Swiggy", balance: "9999.0000" }, // break
      { date: "2026-07-03", amount: "50000.0000", description: "Salary", balance: "59999.0000" },
    ];

    const { importId, stats } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "test.csv",
      rows: brokenRows,
    });
    expect(stats.suspicious).toBeGreaterThan(0);

    const { created } = await commitImport(tdb, importId, s.hh.id);
    // Only non-suspicious rows committed
    expect(created).toBe(stats.new);

    // Verify suspicious rows have no entryId after commit
    const importRows = await tdb
      .select()
      .from(schema.importRows)
      .where(eq(schema.importRows.importId, importId));
    for (const ir of importRows) {
      if (ir.verdict === "suspicious") {
        expect(ir.entryId).toBeNull();
      }
    }
  });

  // ── Categorizer wiring (P3a) ─────────────────────────────────────────────────

  it("commitImport: categorizer runs after rules and sets suggested (unlocked) category on matching entry", async () => {
    // Seed a categorization example for "swiggy" → food category
    // embedding dimension is 384; use a unit vector for the mock
    const exampleEmbedding = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await recordExample(tdb, {
      householdId: s.hh.id,
      text: "swiggy",
      categoryId: s.food.id,
      embedding: exampleEmbedding,
      source: "accept",
    });

    // Stage a single transaction whose normalized merchant matches the example
    const { importId } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "cat-test.csv",
      rows: [{ date: "2026-06-01", amount: "-150.0000", description: "Swiggy order" }],
    });

    // Mock embed: returns the same vector as the example → T1 will resolve
    const mockEmbed = vi.fn().mockResolvedValue(exampleEmbedding);
    const mockGenerate = vi.fn().mockResolvedValue(null); // should not be called
    const mockDeps: CategorizeDeps = { embed: mockEmbed, generate: mockGenerate, t1MinSim: 0.8 };

    await commitImport(tdb, importId, s.hh.id, { categorizeDeps: mockDeps });

    // Find the committed entry
    const rows = await tdb
      .select({ entryId: schema.importRows.entryId })
      .from(schema.importRows)
      .where(eq(schema.importRows.importId, importId));
    expect(rows).toHaveLength(1);
    const entryId = rows[0].entryId!;
    expect(entryId).toBeTruthy();

    // The transaction should have a suggested (unlocked) category
    const [txn] = await tdb
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.entryId, entryId));
    expect(txn.categoryId).toBe(s.food.id);
    expect(txn.categoryLocked).toBe(false);
  });

  // ── Trade import path (P2) ───────────────────────────────────────────────────

  it("commitImport: investment account + trade rows → trades created pending, instrument resolved, holdings reflect units after approval", async () => {
    // Investment account (seedBasics has none)
    const [invest] = await tdb
      .insert(schema.accounts)
      .values({
        householdId: s.hh.id,
        name: "Zerodha",
        kind: "investment",
        openingBalance: "0",
        openingDate: "2026-01-01",
      })
      .returning();

    // Two buys of the same equity. amount = signed cash value (the caller/test sets it).
    const tradeRows = [
      {
        date: "2026-02-01",
        amount: tradeCashAmount("buy", "10", "100.00"),
        description: "BUY INFY",
        instrumentSymbol: "INFY",
        side: "buy" as const,
        units: "10",
        price: "100.00",
        instrumentKind: "equity" as const,
      },
      {
        date: "2026-02-02",
        amount: tradeCashAmount("buy", "5", "120.00"),
        description: "BUY INFY",
        instrumentSymbol: "INFY",
        side: "buy" as const,
        units: "5",
        price: "120.00",
        instrumentKind: "equity" as const,
      },
    ];

    const { importId, stats } = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: invest.id,
      filename: "tradebook.csv",
      rows: tradeRows,
    });
    expect(stats.new).toBe(2);

    const { created } = await commitImport(tdb, importId, s.hh.id);
    expect(created).toBe(2);

    // An instrument was resolved/created (single INFY in the household)
    const insts = await tdb
      .select()
      .from(schema.instruments)
      .where(eq(schema.instruments.householdId, s.hh.id));
    expect(insts).toHaveLength(1);
    expect(insts[0].symbol).toBe("INFY");
    expect(insts[0].kind).toBe("equity");

    // Trade entries created as pending, with trades subtype rows
    const tradeEntries = await tdb
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.importId, importId));
    expect(tradeEntries).toHaveLength(2);
    for (const e of tradeEntries) {
      expect(e.entryType).toBe("trade");
      expect(e.status).toBe("pending");
    }

    // Pending trades do NOT yet appear in holdings (un-reviewed imports excluded)
    const before = await computeHoldings(tdb, s.hh.id, "2026-06-17");
    expect(before).toHaveLength(0);

    // Approve each trade through the inbox (pending → posted)
    for (const e of tradeEntries) {
      await acceptEntry(tdb, e.id, "user");
    }

    // Now holdings reflect the bought units: 10 + 5 = 15
    const after = await computeHoldings(tdb, s.hh.id, "2026-06-17");
    expect(after).toHaveLength(1);
    expect(after[0].instrumentId).toBe(insts[0].id);
    expect(after[0].units).toBe("15.000000");
  });
});
