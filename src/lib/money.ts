import Decimal from "decimal.js-light";

Decimal.set({ precision: 38 });

const D = (v: string | number) => new Decimal(v);
const out = (d: Decimal) => d.toFixed(4);

export const add = (a: string, b: string) => out(D(a).plus(b));
export const sub = (a: string, b: string) => out(D(a).minus(b));
export const neg = (a: string) => out(D(a).negated());
export const mul = (a: string, b: string) => out(D(a).times(b));
export const cmp = (a: string, b: string) => D(a).comparedTo(b) as -1 | 0 | 1;
export const isZero = (a: string) => D(a).isZero();
export const abs = (a: string) => out(D(a).abs());

// Paise (fractional) display rule:
//   < ₹1,000  → keep paise (2 decimal places)
//   ≥ ₹1,000  → drop paise, round to whole rupee (0 decimal places)
//
// Negative sign: we strip the sign, format the absolute value, then prepend
// a typographic minus (U+2212) so the ₹ symbol stays adjacent to the digits.
// Note: .toNumber() is safe here because these are display-only paths and the
// values have already been processed via abs().

const inr = (min: number, max: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });

const INR_FMT0 = inr(0, 0);
const INR_FMT2 = inr(2, 2);
const THOUSAND = 1_000;

export function formatINR(amount: string): string {
  const d = D(amount);
  const a = d.abs();
  const n = a.toNumber();

  const formatted = n < THOUSAND ? INR_FMT2.format(n) : INR_FMT0.format(n);

  return d.isNegative() ? `−${formatted}` : formatted;
}

export function formatINRCompact(amount: string): string {
  const d = D(amount);
  const a = d.abs();
  let s: string;

  if (a.gte(1e7)) {
    s = `₹${a.div(1e7).toFixed(1)}Cr`;
  } else if (a.gte(1e5)) {
    s = `₹${a.div(1e5).toFixed(1)}L`;
  } else if (a.gte(1e3)) {
    s = `₹${a.div(1e3).toFixed(1)}k`;
  } else {
    s = INR_FMT2.format(a.toNumber());
  }

  return d.isNegative() ? `−${s}` : s;
}

export function allocate(total: string, n: number): string[] {
  const base = D(total).div(n).toDecimalPlaces(4, Decimal.ROUND_FLOOR);
  const parts = Array<string>(n).fill(out(base));
  const remainder = D(total).minus(base.times(n));
  if (!remainder.isZero()) {
    parts[0] = out(base.plus(remainder));
  }
  return parts;
}
