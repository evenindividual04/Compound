import { formatINR } from "@/lib/money";

interface SavingsRingProps {
  saved: string; // may be negative if spending > income
  income: string;
  // computed outside: rate = saved/income (0–1 range), pct display
  savingsRate: number; // number 0–1 (derived display stat — Number() safe)
  savingsPct: number; // e.g. 23 for "23%"
  hintAmount: string | null; // "₹X to close your ring" — null if rate >= 30%
  hasIncome: boolean;
}

const CIRC = 2 * Math.PI * 36; // ≈ 226.19

export function SavingsRing({
  saved,
  income,
  savingsRate,
  savingsPct,
  hintAmount,
  hasIncome,
}: SavingsRingProps) {
  const fillRatio = Math.min(savingsRate / 0.3, 1); // 30% target = full ring
  const dash = `${CIRC * fillRatio} ${CIRC}`;

  if (!hasIncome) {
    return (
      <div
        className="mx-4 bg-surface rounded-2xl border border-hairline"
        style={{ padding: "13px 15px 12px" }}
      >
        <p
          className="text-[9px] font-semibold uppercase text-soft mb-[3px]"
          style={{ letterSpacing: "0.12em" }}
        >
          Saved this month
        </p>
        <p className="text-[11px] text-soft leading-[1.45] mt-1">
          No income recorded yet. Add an income transaction to track your savings rate.
        </p>
      </div>
    );
  }

  return (
    <div
      className="mx-4 bg-surface rounded-2xl border border-hairline"
      style={{ padding: "13px 15px 12px" }}
    >
      {/* Caption */}
      <p
        className="text-[9px] font-semibold uppercase text-soft mb-[3px]"
        style={{ letterSpacing: "0.12em" }}
      >
        Saved this month
      </p>

      {/* Ring + right col */}
      <div className="flex items-center gap-[14px] mt-1">
        {/* SVG ring 88×88 */}
        <div className="relative flex-shrink-0" style={{ width: 88, height: 88 }}>
          <svg width="88" height="88" viewBox="0 0 88 88" fill="none">
            {/* Track circle */}
            <circle
              cx="44"
              cy="44"
              r="36"
              strokeWidth="7"
              stroke="var(--hairline)"
              fill="none"
            />
            {/* Progress arc */}
            <circle
              cx="44"
              cy="44"
              r="36"
              strokeWidth="7"
              stroke="var(--coral)"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={dash}
              transform="rotate(-90 44 44)"
            />
          </svg>

          {/* Center label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className="tnum font-display font-extrabold text-ink leading-none"
              style={{ fontSize: "22px" }}
            >
              {savingsPct}%
            </span>
            <span
              className="text-[9px] font-semibold uppercase text-soft mt-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              kept
            </span>
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-0.5">
          <p
            className="tnum font-display font-bold text-ink leading-none"
            style={{ fontSize: "24px" }}
          >
            {formatINR(saved)}
          </p>
          <p className="text-[11px] text-soft leading-snug">
            of {formatINR(income)} income
          </p>
          {hintAmount && (
            <p className="text-[11px] font-semibold text-coral leading-[1.4] mt-1">
              {formatINR(hintAmount)} to close your ring.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
