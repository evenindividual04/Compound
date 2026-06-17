/**
 * pipeline.ts — The import state machine: stage → commit → undo.
 *
 * stageImport: insert imports + importRows with verdicts (duplicate/suspicious/new)
 * commitImport: createTransaction for each 'new' row, apply rules, propose transfers
 * undoImport: softDelete all committed entries (skipping transfer legs)
 *
 * Duplicate detection uses LIVE entries only (partial unique indexes ignore tombstones)
 * via two checks:
 *   1. importHash match on (accountId, importHash) — same file content
 *   2. externalId+amount match on (accountId, externalId, amount) — bank reference collision
 */

import { and, eq, inArray, isNull, min as drizzleMin } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { withOccurrenceHashes } from "@/lib/ledger/dedup";
import { applyRulesTo } from "@/lib/ledger/rules";
import { proposeTransfers } from "@/lib/ledger/transfers";
import { afterWrite } from "@/lib/ledger/derive";
import { createTransaction, softDelete } from "@/lib/ledger/write";
import { createTrade } from "@/lib/invest/trade";
import { validateContinuity } from "./validate";
import type { CategorizeDeps } from "@/lib/categorize/categorize";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizedRow {
  date: string; // yyyy-MM-dd
  amount: string; // signed, 4dp (for trades: the signed cash value = tradeCashAmount)
  description: string;
  externalId?: string;
  balance?: string;
  // ── trade fields (P2) — populated only for investment-account tradebook rows.
  // Transaction imports ignore them. The signed cash `amount` above drives dedup.
  instrumentSymbol?: string;
  instrumentKind?: "mf" | "equity";
  side?: "buy" | "sell";
  units?: string;
  price?: string;
}

export interface StageInput {
  householdId: string;
  accountId: string;
  filename: string;
  rows: NormalizedRow[];
}

export interface StageResult {
  importId: string;
  stats: { total: number; new: number; duplicates: number; suspicious: number };
}

export interface CommitResult {
  created: number;
}

export interface UndoResult {
  deleted: number;
  skipped: number;
}

// ── stageImport ───────────────────────────────────────────────────────────────

export async function stageImport(db: Db, input: StageInput): Promise<StageResult> {
  const { householdId, accountId, filename, rows } = input;

  // Step 1: Hash rows for dedup
  const hashedRows = withOccurrenceHashes(accountId, rows);

  // Step 2: Continuity check to find suspicious ordinals
  const continuity = validateContinuity(rows);
  const suspiciousOrdinals = new Set(continuity.breakOrdinals);

  // Step 3: Bulk-check for live duplicates
  //   a) By importHash
  const allHashes = hashedRows.map((r) => r.importHash);
  const hashDuplicates = await db
    .select({ importHash: schema.entries.importHash })
    .from(schema.entries)
    .where(
      and(
        eq(schema.entries.accountId, accountId),
        isNull(schema.entries.deletedAt),
        inArray(schema.entries.importHash, allHashes),
      ),
    );
  const liveHashSet = new Set(hashDuplicates.map((r) => r.importHash).filter(Boolean) as string[]);

  //   b) By externalId + amount (for rows that have externalId)
  const rowsWithExtId = hashedRows.filter((r) => r.externalId);
  const extIdDuplicates: Set<string> = new Set();
  if (rowsWithExtId.length > 0) {
    const extIds = rowsWithExtId.map((r) => r.externalId!);
    const extMatches = await db
      .select({
        externalId: schema.entries.externalId,
        amount: schema.entries.amount,
      })
      .from(schema.entries)
      .where(
        and(
          eq(schema.entries.accountId, accountId),
          isNull(schema.entries.deletedAt),
          inArray(schema.entries.externalId, extIds),
        ),
      );
    // Build lookup key: externalId|amount
    const extAmountSet = new Set(
      extMatches.map((r) => `${r.externalId}|${r.amount}`).filter((k) => !k.startsWith("|")),
    );
    for (const r of rowsWithExtId) {
      if (extAmountSet.has(`${r.externalId}|${r.amount}`)) {
        extIdDuplicates.add(r.importHash);
      }
    }
  }

  // Step 4: Assign verdicts
  // Rule: duplicate takes precedence over suspicious
  let newCount = 0;
  let duplicateCount = 0;
  let suspiciousCount = 0;

  const verdictedRows = hashedRows.map((r, ordinal) => {
    let verdict: "new" | "duplicate" | "suspicious";
    if (liveHashSet.has(r.importHash) || extIdDuplicates.has(r.importHash)) {
      verdict = "duplicate";
      duplicateCount++;
    } else if (suspiciousOrdinals.has(ordinal)) {
      verdict = "suspicious";
      suspiciousCount++;
    } else {
      verdict = "new";
      newCount++;
    }
    return { ...r, ordinal, verdict };
  });

  const stats = {
    total: rows.length,
    new: newCount,
    duplicates: duplicateCount,
    suspicious: suspiciousCount,
  };

  // Step 5: Insert import record + rows in a transaction
  const importId = await db.transaction(async (tx) => {
    const [imp] = await tx
      .insert(schema.imports)
      .values({ householdId, accountId, filename, status: "staged", stats })
      .returning({ id: schema.imports.id });

    for (const r of verdictedRows) {
      await tx.insert(schema.importRows).values({
        importId: imp.id,
        ordinal: r.ordinal,
        raw: {
          date: r.date,
          amount: r.amount,
          description: r.description,
          externalId: r.externalId,
          balance: r.balance,
          importHash: r.importHash,
          occurrence: r.occurrence,
          // trade fields (P2): parsed has a fixed $type, so trade detail rides in raw
          instrumentSymbol: r.instrumentSymbol,
          instrumentKind: r.instrumentKind,
          side: r.side,
          units: r.units,
          price: r.price,
        },
        parsed: {
          date: r.date,
          amount: r.amount,
          description: r.description,
          externalId: r.externalId,
          balance: r.balance,
        },
        verdict: r.verdict,
        entryId: null,
      });
    }

    return imp.id;
  });

  return { importId, stats };
}

// ── instrument resolve-or-create (P2) ──────────────────────────────────────────

interface TradeRowData {
  instrumentSymbol?: string;
  instrumentKind?: "mf" | "equity";
  side?: "buy" | "sell";
  units?: string;
  price?: string;
}

/** True when a staged row carries the trade detail a trade entry needs. */
function isTradeRow(raw: TradeRowData): boolean {
  return Boolean(raw.side && raw.units && raw.price && raw.instrumentSymbol);
}

/**
 * Resolve an instrument within the household by symbol/amfiCode, creating one if
 * absent. mf identifiers live in amfiCode, equity identifiers in symbol; both are
 * matched against the row's instrumentSymbol (the only identifier a tradebook carries).
 * The mapping UI corrects mismatches at real-import time (follow-up).
 */
async function resolveOrCreateInstrument(
  db: Db,
  householdId: string,
  symbol: string,
  kind: "mf" | "equity",
): Promise<string> {
  const column = kind === "mf" ? schema.instruments.amfiCode : schema.instruments.symbol;
  const lookup = () =>
    db
      .select({ id: schema.instruments.id })
      .from(schema.instruments)
      .where(and(eq(schema.instruments.householdId, householdId), eq(column, symbol)));

  const [existing] = await lookup();
  if (existing) return existing.id;

  // Atomic upsert: a concurrent commit (bulk history import) may insert the same
  // identifier between our SELECT and INSERT. ON CONFLICT DO NOTHING swallows the
  // unique-index throw; on an empty return we re-select the row the other writer made.
  const [created] = await db
    .insert(schema.instruments)
    .values({
      householdId,
      kind,
      name: symbol,
      symbol: kind === "equity" ? symbol : null,
      amfiCode: kind === "mf" ? symbol : null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.instruments.id });
  if (created) return created.id;

  const [raced] = await lookup();
  if (!raced) throw new Error("instrument upsert failed: no row after conflict");
  return raced.id;
}

// ── commitImport ──────────────────────────────────────────────────────────────

export async function commitImport(
  db: Db,
  importId: string,
  householdId: string,
  opts?: { categorizeDeps?: CategorizeDeps },
): Promise<CommitResult> {
  // Guard: idempotent
  const [imp] = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId));
  if (!imp) throw new Error("import not found");
  if (imp.status === "committed") return { created: 0 };
  if (imp.status !== "staged") throw new Error(`Cannot commit import with status: ${imp.status}`);

  // Get 'new' rows
  const newRows = await db
    .select()
    .from(schema.importRows)
    .where(
      and(
        eq(schema.importRows.importId, importId),
        eq(schema.importRows.verdict, "new"),
      ),
    );

  // Determine the target account kind once: an investment account routes rows with
  // trade detail down the trade path; everything else is a transaction.
  const [account] = await db
    .select({ kind: schema.accounts.kind })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, imp.accountId));
  if (!account) throw new Error("account not found");
  const isInvestment = account.kind === "investment";

  const createdEntryIds: string[] = [];
  const transactionEntryIds: string[] = [];
  const rowIdToEntryId: Map<string, string> = new Map();

  for (const ir of newRows) {
    const parsed = ir.parsed!;
    const rawData = ir.raw as {
      importHash?: string;
      externalId?: string;
      instrumentSymbol?: string;
      instrumentKind?: "mf" | "equity";
      side?: "buy" | "sell";
      units?: string;
      price?: string;
    };

    let entryId: string;
    if (isInvestment && isTradeRow(rawData)) {
      // Trade path: resolve/create the instrument, then write a pending trade.
      // Rules and transfer proposals are transaction concepts — skipped for trades.
      const kind = rawData.instrumentKind ?? "equity";
      const instrumentId = await resolveOrCreateInstrument(
        db,
        householdId,
        rawData.instrumentSymbol!,
        kind,
      );
      entryId = await createTrade(db, {
        accountId: imp.accountId,
        instrumentId,
        date: parsed.date,
        side: rawData.side!,
        units: rawData.units!,
        price: rawData.price!,
        description: parsed.description,
        status: "pending",
        source: "import",
        importId,
        importHash: rawData.importHash ?? null,
      });
    } else {
      // Investment accounts legitimately have non-trade rows (fees, dividends,
      // interest) with no side/units/price — those fall through to createTransaction.
      entryId = await createTransaction(db, {
        accountId: imp.accountId,
        date: parsed.date,
        amount: parsed.amount,
        description: parsed.description,
        status: "pending",
        source: "import",
        importId: importId,
        importHash: rawData.importHash ?? null,
        externalId: rawData.externalId ?? null,
      });
      transactionEntryIds.push(entryId);
    }
    createdEntryIds.push(entryId);
    rowIdToEntryId.set(ir.id, entryId);
  }

  // Stamp entryIds on importRows
  for (const [rowId, entryId] of rowIdToEntryId.entries()) {
    await db
      .update(schema.importRows)
      .set({ entryId })
      .where(eq(schema.importRows.id, rowId));
  }

  // Apply rules + propose transfers for transaction entries only (not trades)
  if (transactionEntryIds.length > 0) {
    await applyRulesTo(db, householdId, transactionEntryIds);
    // T1/T2 categorization for entries rules left uncategorized. Never fails ingestion.
    try {
      const { categorizeEntries } = await import("@/lib/categorize/categorize");
      const { defaultCategorizeDeps } = await import("@/lib/categorize/deps");
      const deps = opts?.categorizeDeps ?? defaultCategorizeDeps();
      await categorizeEntries(db, householdId, transactionEntryIds, deps);
    } catch {
      // categorization is best-effort; a failure leaves entries uncategorized for manual pick
    }
    await proposeTransfers(db, householdId);
  }

  // Rebuild balances/rollups: find earliest created date
  if (createdEntryIds.length > 0) {
    const [minDateRow] = await db
      .select({ minDate: drizzleMin(schema.entries.date) })
      .from(schema.entries)
      .where(inArray(schema.entries.id, createdEntryIds));
    const minDate = minDateRow?.minDate;
    if (minDate) {
      await afterWrite(db, { accountId: imp.accountId, householdId, date: minDate });
    }
  }

  // Update import status
  await db
    .update(schema.imports)
    .set({ status: "committed" })
    .where(eq(schema.imports.id, importId));

  return { created: createdEntryIds.length };
}

// ── undoImport ────────────────────────────────────────────────────────────────

export async function undoImport(db: Db, importId: string): Promise<UndoResult> {
  const [imp] = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId));
  if (!imp) throw new Error("import not found");

  // Get all rows with entryIds (from committed new rows)
  const rows = await db
    .select({ entryId: schema.importRows.entryId })
    .from(schema.importRows)
    .where(
      and(
        eq(schema.importRows.importId, importId),
        eq(schema.importRows.verdict, "new"),
      ),
    );

  let deleted = 0;
  let skipped = 0;

  for (const r of rows) {
    if (!r.entryId) continue;
    try {
      // Check entry still exists and is not already deleted
      const [entry] = await db
        .select({ id: schema.entries.id, deletedAt: schema.entries.deletedAt })
        .from(schema.entries)
        .where(eq(schema.entries.id, r.entryId));
      if (!entry || entry.deletedAt !== null) {
        // Already deleted (e.g. double undo)
        continue;
      }
      await softDelete(db, r.entryId, `import:${importId}`);
      deleted++;
    } catch (err) {
      // Transfer leg error → skip, continue
      if (err instanceof Error && err.message.includes("transfer")) {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  await db
    .update(schema.imports)
    .set({ status: "undone" })
    .where(eq(schema.imports.id, importId));

  return { deleted, skipped };
}
