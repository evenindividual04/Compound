import { formatINR } from "@/lib/money";
import { NetWorthBreakdown } from "@/components/invest/networth-breakdown";
import type { NetWorthBreakdownPoint } from "@/lib/ledger/networth-series";

interface CompoundCardProps {
  corpus: string; // current net worth (signed string) — from netWorth() scalar
  monthGain: string; // signed string — latest − ~1mo-ago breakdown net
  breakdown: NetWorthBreakdownPoint[]; // monthly net-worth-by-class series
  // illustrative projection target (see §14 — math not locked)
  projectionTarget: string; // formatINRCompact label
}

export function CompoundCard({
  corpus,
  monthGain,
  breakdown,
  projectionTarget,
}: CompoundCardProps) {
  // monthGain is a fixed(4) decimal string (latest − prior breakdown net,
  // computed in page.tsx) — negative if it starts with "-"
  const gainPositive = !monthGain.startsWith("-") && monthGain !== "0.0000";

  return (
    <div
      className="mx-4 bg-surface rounded-2xl border border-hairline"
      style={{ padding: "13px 15px 12px" }}
    >
      {/* Header row: corpus + gain */}
      <div className="flex items-start justify-between">
        <div>
          <p
            className="text-[9px] font-semibold uppercase text-soft mb-[3px]"
            style={{ letterSpacing: "0.12em" }}
          >
            Compound
          </p>
          <p
            className="tnum font-display font-extrabold text-ink leading-none"
            style={{ fontSize: "30px" }}
          >
            {formatINR(corpus)}
          </p>
        </div>
        <div className="text-right mt-1">
          <p
            className={`tnum text-[11px] font-semibold leading-snug ${
              gainPositive ? "text-money-pos" : "text-money-neg"
            }`}
          >
            {gainPositive ? `+${formatINR(monthGain)}` : formatINR(monthGain)} this month
          </p>
        </div>
      </div>

      {/* Net-worth breakdown by asset class over the last 12 months */}
      <div style={{ margin: "6px 0 7px" }}>
        <NetWorthBreakdown data={breakdown} />
      </div>

      {/* Tagline */}
      <p className="text-[11px] text-soft leading-[1.45]">
        You&apos;re early. At this pace,{" "}
        <strong className="font-semibold text-ink">≈{projectionTarget}</strong> by 39.
      </p>
    </div>
  );
}
