"use server";

import { and, eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { parseFile } from "@/lib/import/parse";
import { applyMapping } from "@/lib/import/mapping";
import type { ColumnMapping } from "@/lib/import/mapping";
import { stageImport, commitImport, undoImport } from "@/lib/import/pipeline";

// ── parseUpload ───────────────────────────────────────────────────────────────

export interface ParseUploadResult {
  headers: string[];
  sampleRows: string[][];
  /** All parsed rows — returned to client so stageWithMapping can receive them back */
  allRows: string[][];
  /** Previously saved mapping for this account, if any */
  savedMapping: ColumnMapping | null;
}

/**
 * Parse the uploaded file in memory, return headers, sample rows, and all rows.
 * The raw file is NEVER persisted — the client holds the rows array until mapping.
 */
export async function parseUpload(formData: FormData): Promise<ParseUploadResult> {
  await requireHousehold(); // auth check

  const file = formData.get("file");
  const accountId = formData.get("accountId");

  if (!(file instanceof File)) throw new Error("No file provided");
  if (typeof accountId !== "string" || !accountId) throw new Error("No accountId provided");

  const buffer = Buffer.from(await file.arrayBuffer());
  const { headers, rows } = await parseFile(buffer, file.name);

  // Look up saved mapping for this account
  const [cfg] = await db
    .select()
    .from(schema.importConfigs)
    .where(eq(schema.importConfigs.accountId, accountId));

  return {
    headers,
    sampleRows: rows.slice(0, 5),
    allRows: rows,
    savedMapping: (cfg?.mapping as ColumnMapping | undefined) ?? null,
  };
}

// ── stageWithMapping ──────────────────────────────────────────────────────────

export interface StageWithMappingInput {
  accountId: string;
  filename: string;
  mapping: ColumnMapping;
  headers: string[];
  rows: string[][];
}

export interface StageWithMappingResult {
  importId: string;
  stats: { total: number; new: number; duplicates: number; suspicious: number };
  failed: { ordinal: number; reason: string }[];
}

/**
 * Apply the column mapping, run stageImport, and upsert the mapping config.
 * Receives the full rows array from the client (server actions are stateless).
 */
export async function stageWithMapping(
  input: StageWithMappingInput,
): Promise<StageWithMappingResult> {
  const { householdId } = await requireHousehold();
  const { accountId, filename, mapping, headers, rows } = input;

  // Verify the account belongs to this household
  const [account] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, accountId),
        eq(schema.accounts.householdId, householdId),
      ),
    );
  if (!account) throw new Error("Account not found or unauthorized");

  // Apply mapping
  const { ok, failed } = applyMapping(headers, rows, mapping);

  // Stage the import
  const { importId, stats } = await stageImport(db, {
    householdId,
    accountId,
    filename,
    rows: ok,
  });

  // Upsert the column mapping for future use (set-it-once UX)
  await db
    .insert(schema.importConfigs)
    .values({ accountId, mapping })
    .onConflictDoUpdate({
      target: schema.importConfigs.accountId,
      set: { mapping },
    });

  revalidatePath("/import");

  return { importId, stats, failed };
}

// ── commit ────────────────────────────────────────────────────────────────────

export async function commitImportAction(importId: string): Promise<{ created: number }> {
  const { householdId } = await requireHousehold();

  // Ownership check
  const [imp] = await db
    .select()
    .from(schema.imports)
    .where(
      and(
        eq(schema.imports.id, importId),
        eq(schema.imports.householdId, householdId),
      ),
    );
  if (!imp) throw new Error("Import not found or unauthorized");

  const result = await commitImport(db, importId, householdId);

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/inbox");
  revalidatePath("/import");

  return result;
}

// ── undo ──────────────────────────────────────────────────────────────────────

export async function undoImportAction(
  importId: string,
): Promise<{ deleted: number; skipped: number }> {
  const { householdId } = await requireHousehold();

  // Ownership check
  const [imp] = await db
    .select()
    .from(schema.imports)
    .where(
      and(
        eq(schema.imports.id, importId),
        eq(schema.imports.householdId, householdId),
      ),
    );
  if (!imp) throw new Error("Import not found or unauthorized");

  const result = await undoImport(db, importId);

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/inbox");
  revalidatePath("/import");

  return result;
}

// ── getImportHistory ──────────────────────────────────────────────────────────

export interface ImportHistoryItem {
  id: string;
  filename: string;
  status: string;
  stats: { total: number; new: number; duplicates: number; suspicious: number } | null;
  createdAt: Date;
  accountName: string;
}

export async function getImportHistory(): Promise<ImportHistoryItem[]> {
  const { householdId } = await requireHousehold();

  const rows = await db
    .select({
      id: schema.imports.id,
      filename: schema.imports.filename,
      status: schema.imports.status,
      stats: schema.imports.stats,
      createdAt: schema.imports.createdAt,
      accountName: schema.accounts.name,
    })
    .from(schema.imports)
    .leftJoin(schema.accounts, eq(schema.imports.accountId, schema.accounts.id))
    .where(eq(schema.imports.householdId, householdId))
    .orderBy(desc(schema.imports.createdAt))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    status: r.status,
    stats: r.stats ?? null,
    createdAt: r.createdAt,
    accountName: r.accountName ?? "Unknown Account",
  }));
}

// ── getImportRows (for preview) ───────────────────────────────────────────────

export interface ImportRowPreview {
  ordinal: number;
  verdict: "new" | "duplicate" | "suspicious";
  date: string;
  amount: string;
  description: string;
  balance?: string;
}

export async function getImportRows(importId: string): Promise<ImportRowPreview[]> {
  const { householdId } = await requireHousehold();

  // Auth: check import belongs to household
  const [imp] = await db
    .select({ id: schema.imports.id })
    .from(schema.imports)
    .where(
      and(
        eq(schema.imports.id, importId),
        eq(schema.imports.householdId, householdId),
      ),
    );
  if (!imp) throw new Error("Import not found or unauthorized");

  const rows = await db
    .select({
      ordinal: schema.importRows.ordinal,
      verdict: schema.importRows.verdict,
      parsed: schema.importRows.parsed,
    })
    .from(schema.importRows)
    .where(eq(schema.importRows.importId, importId))
    .orderBy(schema.importRows.ordinal);

  return rows
    .filter((r) => r.verdict !== null && r.parsed !== null)
    .map((r) => ({
      ordinal: r.ordinal,
      verdict: r.verdict as "new" | "duplicate" | "suspicious",
      date: r.parsed!.date,
      amount: r.parsed!.amount,
      description: r.parsed!.description,
      balance: r.parsed!.balance,
    }));
}
