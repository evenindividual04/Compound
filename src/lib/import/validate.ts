/**
 * validate.ts — Statement continuity checker.
 *
 * validateContinuity checks whether prev.balance + row.amount ≈ row.balance
 * for consecutive rows in the statement (tolerance ±0.01). It auto-detects
 * oldest-first vs newest-first orientation by testing which direction produces
 * more conforming rows.
 *
 * All arithmetic uses the `sub` / `abs` / `cmp` money helpers (string ops).
 */

import { sub, abs, cmp } from "@/lib/money";

export interface ContinuityRow {
  amount: string;
  balance?: string;
}

export interface ContinuityResult {
  checked: boolean;
  breakOrdinals: number[];
}

/** Absolute difference between two money strings. */
function absDiff(a: string, b: string): string {
  return abs(sub(a, b));
}

const TOLERANCE = "0.01";

/**
 * Test a given sequence of rows (as-is order) for balance continuity.
 * Returns ordinals (in the provided sequence) where continuity breaks.
 */
function checkDirection(rows: ContinuityRow[]): number[] {
  const breaks: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (!prev.balance || !curr.balance) continue;
    // expected: prev.balance + curr.amount = curr.balance
    const expected = sub(curr.balance, curr.amount); // = prev.balance (if consistent)
    const diff = absDiff(expected, prev.balance);
    if (cmp(diff, TOLERANCE) > 0) {
      breaks.push(i);
    }
  }
  return breaks;
}

export function validateContinuity(rows: ContinuityRow[]): ContinuityResult {
  // Require ≥2 rows with balance for a meaningful check
  const withBalance = rows.filter((r) => r.balance !== undefined);
  if (withBalance.length < 2) {
    return { checked: false, breakOrdinals: [] };
  }

  // Test oldest-first (as given)
  const forwardBreaks = checkDirection(rows);

  // Test newest-first (reversed)
  const reversedRows = [...rows].reverse();
  const reversedBreaks = checkDirection(reversedRows);

  // Majority: pick the direction with fewer breaks
  // Map reversed break ordinals back to original ordinals
  const remappedReversedBreaks = reversedBreaks.map((i) => rows.length - 1 - i);

  const useForward = forwardBreaks.length <= reversedBreaks.length;
  const breakOrdinals = useForward ? forwardBreaks : remappedReversedBreaks;

  return { checked: true, breakOrdinals };
}
