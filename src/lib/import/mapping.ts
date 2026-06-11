/**
 * mapping.ts — Column mapping: header-keyed config → normalized parsed rows.
 *
 * Handles HDFC-style (single amount + Cr/Dr suffix) and ICICI-style (debit/credit pair).
 * All amounts stay as strings through parsing — never Number().
 * Dates are parsed with date-fns and emitted as yyyy-MM-dd ISO strings.
 */

import { parse as parseDateFns, isValid, format } from "date-fns";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DateFormat =
  | "dd/MM/yyyy"
  | "dd/MM/yy"
  | "dd-MM-yyyy"
  | "yyyy-MM-dd"
  | "dd MMM yyyy";

export interface ColumnMapping {
  date: string; // header name for the date column
  description: string; // header name for the description/narration column
  /** Single amount column (may carry Cr/Dr suffix). Mutually exclusive with debit/credit pair. */
  amount?: string;
  /** Separate debit column. Combined with credit to form a signed amount. */
  debit?: string;
  /** Separate credit column. Combined with debit to form a signed amount. */
  credit?: string;
  balance?: string; // optional running balance column
  ref?: string; // optional reference/cheque number → externalId
  dateFormat: DateFormat;
}

export interface ParsedRow {
  date: string; // yyyy-MM-dd
  amount: string; // signed, 4dp e.g. "-1500.0000"
  description: string;
  externalId?: string;
  balance?: string; // 4dp string if present
}

export interface FailedRow {
  ordinal: number;
  reason: string;
}

export interface MappingResult {
  ok: ParsedRow[];
  failed: FailedRow[];
}

// ── Amount cleaning ───────────────────────────────────────────────────────────

/**
 * Strip currency symbols/words, spaces, commas. Detect Cr/Dr suffix for sign.
 * Returns { value: string (always positive), sign: 1 | -1 } or null on parse failure.
 */
function cleanAmount(raw: string): { value: string; sign: 1 | -1 } | null {
  let s = raw.trim();

  // Detect and strip Cr/Dr suffix (case-insensitive)
  let sign: 1 | -1 = 1;
  if (/cr$/i.test(s)) {
    sign = 1;
    s = s.replace(/\s*cr$/i, "");
  } else if (/dr$/i.test(s)) {
    sign = -1;
    s = s.replace(/\s*dr$/i, "");
  }

  // Strip ₹, INR, spaces, commas
  s = s.replace(/[₹\s,]/g, "").replace(/^INR/i, "");

  if (s === "" || s === "-") return null;

  // Handle explicit negative sign
  const isNeg = s.startsWith("-");
  if (isNeg) {
    sign = -1;
    s = s.slice(1);
  }

  // Must be a valid decimal number
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  return { value: s, sign };
}

/** Convert a numeric string to 4dp representation without Number() for sign arithmetic. */
function toFixed4(value: string, sign: 1 | -1): string {
  // Parse the decimal parts manually to stay in string domain
  const [int, dec = ""] = value.split(".");
  const decimal = (dec + "0000").slice(0, 4);
  const unsigned = `${int}.${decimal}`;
  return sign === -1 ? `-${unsigned}` : unsigned;
}

// ── Date parsing ──────────────────────────────────────────────────────────────

function parseDate(raw: string, fmt: DateFormat): string | null {
  const referenceDate = new Date(2000, 0, 1); // needed by date-fns parse
  const d = parseDateFns(raw.trim(), fmt, referenceDate);
  if (!isValid(d)) return null;
  return format(d, "yyyy-MM-dd");
}

// ── Column lookup ─────────────────────────────────────────────────────────────

function getColIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim() === name.trim());
}

function getCell(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return "";
  return row[idx] ?? "";
}

// ── Public API ────────────────────────────────────────────────────────────────

export function applyMapping(
  headers: string[],
  rows: string[][],
  mapping: ColumnMapping,
): MappingResult {
  const dateIdx = getColIndex(headers, mapping.date);
  const descIdx = getColIndex(headers, mapping.description);
  const amountIdx = mapping.amount !== undefined ? getColIndex(headers, mapping.amount) : -1;
  const debitIdx = mapping.debit !== undefined ? getColIndex(headers, mapping.debit) : -1;
  const creditIdx = mapping.credit !== undefined ? getColIndex(headers, mapping.credit) : -1;
  const balanceIdx = mapping.balance !== undefined ? getColIndex(headers, mapping.balance) : -1;
  const refIdx = mapping.ref !== undefined ? getColIndex(headers, mapping.ref) : -1;

  const ok: ParsedRow[] = [];
  const failed: FailedRow[] = [];

  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const row = rows[ordinal];

    // ── Date ──
    const rawDate = getCell(row, dateIdx);
    const parsedDate = parseDate(rawDate, mapping.dateFormat);
    if (!parsedDate) {
      failed.push({ ordinal, reason: `Invalid date: "${rawDate}"` });
      continue;
    }

    // ── Description ──
    const description = getCell(row, descIdx).trim();

    // ── Amount ──
    let amountStr: string;

    if (amountIdx >= 0) {
      // Single amount column with optional Cr/Dr
      const rawAmount = getCell(row, amountIdx);
      const cleaned = cleanAmount(rawAmount);
      if (!cleaned) {
        failed.push({ ordinal, reason: `Cannot parse amount: "${rawAmount}"` });
        continue;
      }
      amountStr = toFixed4(cleaned.value, cleaned.sign);
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      // Debit/credit pair
      const rawDebit = debitIdx >= 0 ? getCell(row, debitIdx).trim() : "";
      const rawCredit = creditIdx >= 0 ? getCell(row, creditIdx).trim() : "";

      const debitFilled = rawDebit !== "";
      const creditFilled = rawCredit !== "";

      if (!debitFilled && !creditFilled) {
        failed.push({ ordinal, reason: "Both debit and credit are blank" });
        continue;
      }
      if (debitFilled && creditFilled) {
        failed.push({ ordinal, reason: "Both debit and credit are filled" });
        continue;
      }

      if (debitFilled) {
        const cleaned = cleanAmount(rawDebit);
        if (!cleaned) {
          failed.push({ ordinal, reason: `Cannot parse debit amount: "${rawDebit}"` });
          continue;
        }
        // Debit → outflow → negative
        amountStr = toFixed4(cleaned.value, -1);
      } else {
        const cleaned = cleanAmount(rawCredit!);
        if (!cleaned) {
          failed.push({ ordinal, reason: `Cannot parse credit amount: "${rawCredit}"` });
          continue;
        }
        // Credit → inflow → positive
        amountStr = toFixed4(cleaned.value, 1);
      }
    } else {
      failed.push({ ordinal, reason: "No amount column configured" });
      continue;
    }

    // ── Optional balance ──
    let balance: string | undefined;
    if (balanceIdx >= 0) {
      const rawBalance = getCell(row, balanceIdx).trim();
      if (rawBalance !== "") {
        const cleaned = cleanAmount(rawBalance);
        if (cleaned) {
          balance = toFixed4(cleaned.value, cleaned.sign);
        }
      }
    }

    // ── Optional ref ──
    let externalId: string | undefined;
    if (refIdx >= 0) {
      const rawRef = getCell(row, refIdx).trim();
      if (rawRef !== "") externalId = rawRef;
    }

    ok.push({ date: parsedDate, amount: amountStr, description, externalId, balance });
  }

  return { ok, failed };
}
