import { describe, it, expect, beforeEach } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { buildHdfcCsvBuffer } from "./__fixtures__/fixture-builder";
import { parseFile } from "./parse";
import { applyMapping } from "./mapping";
import type { ColumnMapping } from "./mapping";
import { stageImport, commitImport, undoImport } from "./pipeline";

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
});
