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
import { validateContinuity } from "./validate";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizedRow {
  date: string; // yyyy-MM-dd
  amount: string; // signed, 4dp
  description: string;
  externalId?: string;
  balance?: string;
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

// ── commitImport ──────────────────────────────────────────────────────────────

export async function commitImport(
  db: Db,
  importId: string,
  householdId: string,
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

  const createdEntryIds: string[] = [];
  const rowIdToEntryId: Map<string, string> = new Map();

  for (const ir of newRows) {
    const parsed = ir.parsed!;
    const rawData = ir.raw as {
      importHash?: string;
      externalId?: string;
    };
    const entryId = await createTransaction(db, {
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

  // Apply rules
  if (createdEntryIds.length > 0) {
    await applyRulesTo(db, householdId, createdEntryIds);
  }

  // Propose transfers
  await proposeTransfers(db, householdId);

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
