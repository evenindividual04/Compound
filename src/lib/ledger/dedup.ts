/**
 * Occurrence-aware import dedup (spec §4.3.1).
 *
 * Hash = sha256(accountId | date | amount | normalizedDescription | occurrenceIndex)
 * where occurrenceIndex counts duplicates of the same (date, amount, description)
 * group IN FILE ORDER. Three identical chai payments in one statement are three
 * legitimate entries (distinct indices); the same row re-imported from an
 * overlapping statement produces the same index → same hash → caught as duplicate.
 * Deterministic from file content alone — no server counters (sync-safe).
 */
import { createHash } from "node:crypto";

export interface DedupableRow {
  date: string; // YYYY-MM-DD
  amount: string; // signed, as parsed
  description: string;
}

export function normalizeDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\d{6,}/g, "#") // long runs of digits are reference noise
    .replace(/\s+/g, " ")
    .trim();
}

export function withOccurrenceHashes<T extends DedupableRow>(
  accountId: string,
  rows: T[],
): (T & { importHash: string; occurrence: number })[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.date}|${row.amount}|${normalizeDescription(row.description)}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const importHash = createHash("sha256")
      .update(`${accountId}|${key}|${occurrence}`)
      .digest("hex");
    return { ...row, importHash, occurrence };
  });
}
