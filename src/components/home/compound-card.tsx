import { formatINR } from "@/lib/money";
import type { NetWorthPoint } from "@/lib/ledger/dashboard";

interface CompoundCardProps {
  corpus: string; // current net worth (signed string)
  monthGain: string; // signed string — last − ~30d-ago value
  nwSeries: NetWorthPoint[];
  // illustrative projection target (see §14 — math not locked)
  projectionTarget: string; // formatINRCompact label
}

/**
 * Map an array of values to SVG y coordinates.
 * viewBox height = 52, with 4px padding top/bottom so usable = 44.
 */
function toY(val: number, min: number, max: number): number {
  const range = max - min || 1;
  // invert: higher val → lower y (top of SVG)
  return 4 + (1 - (val - min) / range) * 44;
}

export function CompoundCard({
  corpus,
  monthGain,
  nwSeries,
  projectionTarget,
}: CompoundCardProps) {
  // monthGain is a raw decimal string from sub() — negative if starts with "-"
  const gainPositive = !monthGain.startsWith("-") && monthGain !== "0.0000";

  // Build sparkline points from real series
  // Historical series: nwSeries items (30 days)
  const histValues = nwSeries.map((p) => parseFloat(p.netWorth));
  const histCount = histValues.length;

  // All values for global min/max (history + gentle projection)
  // Projection: illustrative — extrapolate last value + small upward curve
  const lastVal = histValues[histCount - 1] ?? 0;
  const firstVal = histValues[0] ?? 0;
  const monthlyDelta = lastVal - firstVal; // approximate monthly trend
  // Project 6 months out with illustrative simple compound (see DESIGN.md §14 — math not locked)
  // Formula: lastVal * (1 + annualReturn)^(monthsOut/12) where annualReturn = 0.10 (illustrative 10% p.a.)
  const ANNUAL_RETURN = 0.10; // illustrative — see DESIGN.md §14 (math not locked)
  const PROJ_MONTHS = 6;
  const projPoints: number[] = [];
  for (let i = 1; i <= PROJ_MONTHS; i++) {
    // compound the monthly contribution + return
    // illustrative projection — see DESIGN.md §14 (math not locked)
    const projVal = lastVal * Math.pow(1 + ANNUAL_RETURN, i / 12) + (monthlyDelta > 0 ? monthlyDelta * i : 0);
    projPoints.push(projVal);
  }

  const allValues = [...histValues, ...projPoints];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);

  // SVG width = 326, height = 52
  // History spans left 48% (~0 to 156px); projection spans 48%+ to 326px
  const SVG_W = 326;
  const HIST_X_END = Math.round(SVG_W * 0.48); // ~156

  // Build history polyline points
  const histPoints = histValues.map((v, i) => {
    const x = histCount > 1 ? Math.round((i / (histCount - 1)) * HIST_X_END) : HIST_X_END;
    const y = toY(v, minVal, maxVal);
    return `${x},${y.toFixed(1)}`;
  });
  const histPointsStr = histPoints.join(" ");

  // Junction point (last history point = first projection point)
  const junctionX = HIST_X_END;
  const junctionY = toY(lastVal, minVal, maxVal);

  // Build projection polyline points (from junction onward)
  const projPtsArr = projPoints.map((v, i) => {
    const x = Math.round(HIST_X_END + ((i + 1) / PROJ_MONTHS) * (SVG_W - HIST_X_END));
    const y = toY(v, minVal, maxVal);
    return `${x},${y.toFixed(1)}`;
  });
  const projPointsStr = `${junctionX},${junctionY.toFixed(1)} ` + projPtsArr.join(" ");

  // If series is flat/empty, draw a gentle rise so the card isn't blank
  const effectiveHistPoints =
    histValues.length < 2
      ? `0,${(52 * 0.75).toFixed(1)} ${HIST_X_END},${(52 * 0.55).toFixed(1)}`
      : histPointsStr;

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

      {/* Sparkline */}
      <div style={{ margin: "6px 0 7px" }}>
        <svg
          viewBox="0 0 326 52"
          preserveAspectRatio="none"
          width="100%"
          height="52"
          fill="none"
        >
          {/* Historical polyline — solid money-pos */}
          <polyline
            points={effectiveHistPoints}
            stroke="var(--money-pos)"
            strokeWidth="2"
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Projection polyline — dashed coral */}
          <polyline
            points={projPointsStr}
            stroke="var(--coral)"
            strokeWidth="1.6"
            strokeDasharray="4 3"
            fill="none"
            opacity="0.85"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Junction dot */}
          <circle
            cx={junctionX}
            cy={junctionY}
            r="3"
            fill="var(--money-pos)"
          />
        </svg>
      </div>

      {/* Tagline */}
      <p className="text-[11px] text-soft leading-[1.45]">
        You&apos;re early. At this pace,{" "}
        <strong className="font-semibold text-ink">≈{projectionTarget}</strong> by 39.
      </p>
    </div>
  );
}
