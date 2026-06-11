/**
 * parse.ts — Bank-statement file ingestion.
 *
 * parseFile(buffer, filename) → { headers, rows }
 *
 * Supports:
 *   .csv  — papaparse, skips fully-empty lines, autodetects header row
 *   .xlsx — exceljs, first worksheet, cells stringified
 *            (date cells → dd/MM/yyyy, number cells → plain string)
 *   .xls  — throws descriptive error (banned: CVEs)
 */

import Papa from "papaparse";
import { format } from "date-fns";

export interface ParseResult {
  headers: string[];
  rows: string[][];
}

// ── XLS detection ─────────────────────────────────────────────────────────────

/** Return true if the buffer starts with the legacy Compound Document / BIFF magic bytes. */
function isXlsMagic(buf: Buffer): boolean {
  // BIFF magic: D0 CF 11 E0 A1 B1 1A E1
  if (buf.length < 8) return false;
  return (
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0 &&
    buf[4] === 0xa1 &&
    buf[5] === 0xb1 &&
    buf[6] === 0x1a &&
    buf[7] === 0xe1
  );
}

// ── Header autodetect ─────────────────────────────────────────────────────────

/**
 * Find the first row index that has ≥3 non-empty cells.
 * Returns -1 if none found.
 */
function findHeaderRowIndex(rows: string[][]): number {
  for (let i = 0; i < rows.length; i++) {
    const nonEmpty = rows[i].filter((c) => c.trim() !== "").length;
    if (nonEmpty >= 3) return i;
  }
  return -1;
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function parseCsv(buf: Buffer): ParseResult {
  const text = buf.toString("utf8");
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: true,
    header: false,
  });

  const allRows: string[][] = result.data;

  const headerIdx = findHeaderRowIndex(allRows);
  if (headerIdx === -1) {
    return { headers: [], rows: allRows };
  }

  const headers = allRows[headerIdx].map((h) => h.trim());
  const rows = allRows.slice(headerIdx + 1);

  return { headers, rows };
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

async function parseXlsx(buf: Buffer): Promise<ParseResult> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  // exceljs declares its own Buffer = ArrayBuffer; cast through unknown to satisfy it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as unknown as any);

  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  const allRows: string[][] = [];

  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cellToString(cell));
    });
    // Skip fully-empty rows
    if (cells.every((c) => c === "")) return;
    allRows.push(cells);
  });

  const headerIdx = findHeaderRowIndex(allRows);
  if (headerIdx === -1) {
    return { headers: [], rows: allRows };
  }

  const headers = allRows[headerIdx].map((h) => h.trim());
  const rows = allRows.slice(headerIdx + 1);

  return { headers, rows };
}

/** Stringify a single ExcelJS cell value. */
function cellToString(cell: import("exceljs").Cell): string {
  const v = cell.value;

  if (v === null || v === undefined) return "";

  // ExcelJS represents Excel date serials as JS Date objects when type = Date
  if (v instanceof Date) {
    return format(v, "dd/MM/yyyy");
  }

  // Rich text
  if (typeof v === "object" && "richText" in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
  }

  // Formula result: use the cached result value
  if (typeof v === "object" && "result" in v) {
    const res = (v as { result: unknown }).result;
    if (res instanceof Date) return format(res, "dd/MM/yyyy");
    if (res === null || res === undefined) return "";
    return String(res);
  }

  // Numbers: plain string, no grouping separator
  if (typeof v === "number") {
    // Use fixed-point if the number has decimals, else integer
    return Number.isInteger(v) ? String(v) : v.toString();
  }

  return String(v);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parseFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const lower = filename.toLowerCase();

  // .xls check: filename OR magic bytes
  if (lower.endsWith(".xls") || isXlsMagic(buffer)) {
    throw new Error(
      "Legacy .xls is not supported — export CSV or XLSX from netbanking",
    );
  }

  if (lower.endsWith(".xlsx")) {
    return parseXlsx(buffer);
  }

  // Default: treat as CSV
  return parseCsv(buffer);
}
