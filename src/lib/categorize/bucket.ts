import Decimal from "decimal.js-light";
/** Magnitude bucket of a money string (sign-agnostic). Never exposes the exact amount. */
export function amountBucket(amount: string): string {
  const a = new Decimal(amount).abs();
  if (a.lt(100)) return "<₹100";
  if (a.lt(1_000)) return "₹100–1k";
  if (a.lt(10_000)) return "₹1k–10k";
  if (a.lt(100_000)) return "₹10k–1L";
  return "₹1L+";
}
