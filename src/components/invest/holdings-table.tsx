import { Badge } from "@/components/ui/badge";
import { formatINR, formatINRCompact, add, cmp } from "@/lib/money";

export interface HoldingRow {
  instrumentId: string;
  instrumentName: string;
  kind: string;
  units: string; // 6dp string
  avgCost: string; // 6dp string
  currentPrice: string | null; // money string or null when no price known
  priceDate: string | null; // YYYY-MM-DD or null
  currentValue: string; // money string (mark-to-market, or cost-basis fallback)
  unrealizedPnl: string; // money string
  xirr: string | null; // annualized rate as 6dp string (analytics ratio, NOT money)
  stale: boolean;
}

interface Props {
  rows: HoldingRow[];
}

/**
 * Format units for display: trim trailing zeros from the 6dp string, keep it readable.
 * Units are a quantity, not money — plain string handling is fine here.
 */
function formatUnits(units: string): string {
  if (!units.includes(".")) return units;
  return units.replace(/\.?0+$/, "");
}

/**
 * XIRR display percentage. The XIRR value is an analytics RATIO (e.g. "0.123456"),
 * not a money value, so Number() is the documented analytics/display boundary here —
 * the same exception charts use. Money values are NEVER passed through Number().
 */
function formatXirr(rate: string | null): string {
  if (rate === null) return "—";
  const pct = Number(rate) * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

function moneyClass(value: string): string {
  return cmp(value, "0") >= 0 ? "text-money-pos" : "text-money-neg";
}

export function HoldingsTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <>
        <Header />
        <div className="mt-16 flex flex-col items-center gap-2">
          <p className="text-sm text-soft">No holdings yet.</p>
          <p className="text-xs text-soft">
            Record a trade from <span className="font-semibold text-ink">＋</span> to start.
          </p>
        </div>
      </>
    );
  }

  // Totals — pure money-string accumulation (no Number()).
  const totalValue = rows.reduce((acc, r) => add(acc, r.currentValue), "0.0000");
  const totalPnl = rows.reduce((acc, r) => add(acc, r.unrealizedPnl), "0.0000");
  const pnlPositive = cmp(totalPnl, "0") >= 0;

  return (
    <>
      <Header />

      {/* Summary */}
      <section className="mb-6 flex items-end justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
            Current value
          </p>
          <p className="tnum font-display text-3xl font-bold tracking-tight text-ink">
            {formatINRCompact(totalValue)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
            Unrealized
          </p>
          <p className={`tnum text-sm font-semibold ${moneyClass(totalPnl)}`}>
            {pnlPositive ? "+" : ""}
            {formatINR(totalPnl)}
          </p>
        </div>
      </section>

      {/* Holdings list */}
      <ul className="overflow-hidden rounded-2xl border border-hairline bg-surface divide-y divide-hairline">
        {rows.map((r) => (
          <HoldingRowItem key={r.instrumentId} row={r} />
        ))}
      </ul>
    </>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
        Investments
      </h1>
    </header>
  );
}

function HoldingRowItem({ row }: { row: HoldingRow }) {
  const pnlPositive = cmp(row.unrealizedPnl, "0") >= 0;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        {/* Left: name + kind + units/avg */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-ink">
              {row.instrumentName}
            </span>
            <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
              {row.kind}
            </Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="tnum text-[11px] text-soft">
              {formatUnits(row.units)} units
            </span>
            <span className="tnum text-[11px] text-soft">
              avg {formatINR(row.avgCost)}
            </span>
            {row.currentPrice ? (
              <span className="tnum text-[11px] text-soft">
                @ {formatINR(row.currentPrice)}
                {row.priceDate ? ` · ${row.priceDate}` : ""}
              </span>
            ) : null}
            {row.stale && (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {row.currentPrice ? "stale price" : "no price"}
              </Badge>
            )}
          </div>
        </div>

        {/* Right: value + P&L + XIRR */}
        <div className="shrink-0 text-right">
          <p className="tnum text-sm font-medium text-ink">
            {formatINR(row.currentValue)}
          </p>
          <p
            className={`tnum text-[11px] font-medium ${
              pnlPositive ? "text-money-pos" : "text-money-neg"
            }`}
          >
            {pnlPositive ? "+" : ""}
            {formatINR(row.unrealizedPnl)}
          </p>
          <p className="tnum text-[11px] text-soft">XIRR {formatXirr(row.xirr)}</p>
        </div>
      </div>
    </li>
  );
}
