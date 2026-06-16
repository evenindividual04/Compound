import Link from "next/link";
import { formatINR } from "@/lib/money";

interface SpendCardProps {
  thisSpend: string;
  spendingMore: boolean;
  deltaPct: number | null; // Number() safe — derived display stat only
  prevMonthLabel: string;
  topCategoryName: string | null;
  prevMonthPct: number | null; // derived display stat — Number() safe
  // Budget
  hasAllocations: boolean;
  budgetAssigned: string | null;
  budgetLeft: string | null;
  budgetSpent: string | null;
}

export function SpendCard({
  thisSpend,
  spendingMore,
  deltaPct,
  prevMonthLabel,
  topCategoryName,
  prevMonthPct,
  hasAllocations,
  budgetAssigned,
  budgetLeft,
  budgetSpent,
}: SpendCardProps) {
  // Budget bar fill ratio (0–1), clamped
  let fillRatio = 0;
  if (hasAllocations && budgetAssigned && budgetSpent) {
    const assigned = parseFloat(budgetAssigned);
    const spent = parseFloat(budgetSpent);
    if (assigned > 0) {
      fillRatio = Math.min(Math.max(spent / assigned, 0), 1);
    }
  }

  // Build dry insight copy
  let insight: string | null = null;
  if (topCategoryName && prevMonthPct !== null) {
    const sign = prevMonthPct >= 0 ? "+" : "";
    insight = `Pacing ${sign}${prevMonthPct}% vs last month. ${topCategoryName}, mostly.`;
  } else if (topCategoryName) {
    insight = `Most going to ${topCategoryName}.`;
  } else {
    insight = "Nothing stands out yet.";
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
        Spent this month
      </p>

      {/* Hero amount + delta pill */}
      <div className="flex items-end gap-2.5 mb-1.5">
        <p
          className="tnum font-display font-extrabold text-ink leading-none"
          style={{ fontSize: "46px", letterSpacing: "-0.02em" }}
        >
          {formatINR(thisSpend)}
        </p>

        {deltaPct !== null && (
          <span
            className={`mb-0.5 inline-flex items-center rounded-full px-2 py-[2px] text-[10px] font-semibold ${
              spendingMore ? "bg-warn-bg text-warn-ink" : "bg-surface text-soft border border-hairline"
            }`}
          >
            {spendingMore ? "↑" : "↓"} {Math.abs(deltaPct)}% vs {prevMonthLabel}
          </span>
        )}
      </div>

      {/* Insight line */}
      <p className="text-[11px] text-soft leading-[1.45]">{insight}</p>

      {/* Budget section */}
      <div
        className="mt-[10px] mb-[9px]"
        style={{ borderTop: "1px solid var(--hairline)" }}
      />

      {hasAllocations && budgetAssigned && budgetLeft ? (
        <>
          {/* Budget bar track */}
          <div
            className="h-[5px] rounded-[3px] overflow-hidden mb-2.5"
            style={{ background: "var(--hairline)" }}
          >
            <div
              className="h-full bg-coral rounded-[3px] transition-all"
              style={{ width: `${fillRatio * 100}%` }}
            />
          </div>

          {/* Budget footer */}
          <div className="flex items-center justify-between">
            <span className="tnum text-[11px] text-soft">
              {formatINR(budgetLeft)} left of {formatINR(budgetAssigned)}
            </span>
            <Link
              href="/budgets"
              className="text-[10px] font-semibold text-coral"
            >
              View categories →
            </Link>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-soft">No budget set</span>
          <Link href="/budgets" className="text-[10px] font-semibold text-coral">
            Set a budget →
          </Link>
        </div>
      )}
    </div>
  );
}
