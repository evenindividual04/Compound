/**
 * Parse the AMFI NAVAll feed (https://www.amfiindia.com/spages/NAVAll.txt).
 * Format: semicolon-delimited rows
 *   Scheme Code;ISIN ...;ISIN ...;Scheme Name;Net Asset Value;Date
 * interleaved with fund-house names, category headers, and blank lines, which we skip.
 * Pure: fetching is the cron's job. NAV stored at 6dp; date as ISO yyyy-MM-dd.
 */
import { parse as parseDateFns, isValid, format } from "date-fns";

export interface NavRow {
  nav: string; // 6dp
  date: string; // yyyy-MM-dd
}

export function parseAmfiNav(text: string): Map<string, NavRow> {
  const out = new Map<string, NavRow>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(";");
    if (parts.length < 6) continue;
    const code = parts[0].trim();
    if (!/^\d+$/.test(code)) continue;
    const navRaw = parts[4].trim();
    if (!/^\d+(\.\d+)?$/.test(navRaw)) continue;
    const d = parseDateFns(parts[5].trim(), "dd-MMM-yyyy", new Date(2000, 0, 1));
    if (!isValid(d)) continue;
    // External-feed-parse boundary: navRaw is a feed string being normalized to a
    // fixed-precision storage string — NOT a ledger money amount, so Number() is safe here.
    out.set(code, { nav: Number(navRaw).toFixed(6), date: format(d, "yyyy-MM-dd") });
  }
  return out;
}
