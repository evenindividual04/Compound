/**
 * Deterministic XIRR (annualized money-weighted return) over dated cashflows.
 * Cashflow amounts are parsed from the money string domain; the root-finder itself
 * operates in `number` because IRR requires transcendental math — this is the
 * documented analytics boundary (NOT a ledger-truth path), like the charts exception.
 * Negative = money out (buy/contribution), positive = money in (sell/current value).
 */
import Decimal from "decimal.js-light";
import { differenceInCalendarDays } from "date-fns";

export interface CashFlow {
  date: string; // YYYY-MM-DD
  amount: string; // signed money string
}

const DAYS_PER_YEAR = 365;

function npv(rate: number, flows: { days: number; amount: number }[]): number {
  return flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + rate, f.days / DAYS_PER_YEAR), 0);
}
function dNpv(rate: number, flows: { days: number; amount: number }[]): number {
  return flows.reduce((sum, f) => {
    const t = f.days / DAYS_PER_YEAR;
    return sum - (t * f.amount) / Math.pow(1 + rate, t + 1);
  }, 0);
}

/** Returns the annualized rate as a 6dp string, or null if it cannot converge. */
export function xirr(cashflows: CashFlow[]): string | null {
  if (cashflows.length < 2) return null;
  const hasPos = cashflows.some((c) => new Decimal(c.amount).gt(0));
  const hasNeg = cashflows.some((c) => new Decimal(c.amount).lt(0));
  if (!hasPos || !hasNeg) return null;

  const sorted = [...cashflows].sort((a, b) => a.date.localeCompare(b.date));
  const t0 = new Date(`${sorted[0].date}T00:00:00Z`);
  const flows = sorted.map((c) => ({
    days: differenceInCalendarDays(new Date(`${c.date}T00:00:00Z`), t0),
    amount: new Decimal(c.amount).toNumber(),
  }));

  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, flows);
    const df = dNpv(rate, flows);
    if (!isFinite(f) || !isFinite(df) || df === 0) break;
    const next = rate - f / df;
    if (Math.abs(next - rate) < 1e-9) return new Decimal(next).toFixed(6);
    rate = next;
    if (rate <= -1) { rate = -0.9999; }
  }

  let lo = -0.9999, hi = 10;
  let flo = npv(lo, flows);
  if (!isFinite(flo)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid, flows);
    if (Math.abs(fmid) < 1e-7) return new Decimal(mid).toFixed(6);
    if (flo * fmid < 0) hi = mid;
    else { lo = mid; flo = fmid; }
  }
  return null;
}
