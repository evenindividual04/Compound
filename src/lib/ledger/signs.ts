/**
 * ADR-1 sign normalisation for account balances.
 *
 * The UI always collects a positive "amount owed / amount held" number from
 * the user.  For liability accounts (credit_card, loan, other_liability) we
 * store a NEGATIVE balance internally so that net-worth arithmetic (Σ all
 * account balances) works without special-casing.
 *
 * Decision: already-negative input for liabilities
 *   We call neg(abs(value)).  abs() strips any existing minus sign before
 *   negating, so passing "-45000" for a credit card yields "-45000.0000"
 *   (idempotent for normal use), not the nonsensical "45000.0000".
 *   Callers that pre-normalise signs will not be surprised; callers that
 *   accidentally pass a negative still get the correct stored sign.
 */
import { abs, neg } from "@/lib/money";
import { LIABILITY_KINDS } from "@/db/schema/core";

/**
 * Normalise a user-entered absolute balance for storage.
 *
 * @param kind - account kind string
 * @param userEnteredAbs - the value the user typed (positive number)
 * @returns signed NUMERIC string ready for DB insertion
 */
export function normalizeBalanceForKind(kind: string, userEnteredAbs: string): string {
  if ((LIABILITY_KINDS as readonly string[]).includes(kind)) {
    return neg(abs(userEnteredAbs));
  }
  return userEnteredAbs;
}
