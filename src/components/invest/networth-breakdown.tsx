"use client";

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface BreakdownPoint {
  month: string; // 'YYYY-MM'
  cash: number;
  investments: number;
  otherAssets: number;
  liabilities: number; // ≤ 0
  net: number;
}

interface Props {
  /** Pre-aggregated; all values are numbers (converted at the RSC boundary). */
  data: BreakdownPoint[];
}

function shortMonth(yyyyMM: string): string {
  const [y, m] = yyyyMM.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(y, m - 1, 1));
}

/** Compact INR for axis ticks / tooltip — numbers already at chart boundary. */
function compactINR(n: number): string {
  const a = Math.abs(n);
  let s: string;
  if (a >= 1e7) s = `₹${(a / 1e7).toFixed(1)}Cr`;
  else if (a >= 1e5) s = `₹${(a / 1e5).toFixed(1)}L`;
  else if (a >= 1e3) s = `₹${(a / 1e3).toFixed(1)}k`;
  else s = `₹${Math.round(a)}`;
  return n < 0 ? `−${s}` : s;
}

const SERIES: { key: keyof BreakdownPoint; label: string; color: string }[] = [
  { key: "cash", label: "Cash", color: "var(--money-pos)" },
  { key: "investments", label: "Investments", color: "var(--coral)" },
  { key: "otherAssets", label: "Other assets", color: "var(--soft)" },
  { key: "liabilities", label: "Liabilities", color: "var(--money-neg)" },
];

export function NetWorthBreakdown({ data }: Props) {
  if (data.length === 0) return null;

  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} stackOffset="sign" barCategoryGap="22%">
          <XAxis
            dataKey="month"
            tickFormatter={shortMonth}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "var(--soft)" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={compactINR}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 9, fill: "var(--soft)" }}
            width={44}
          />
          <ReferenceLine y={0} stroke="var(--hairline)" />
          <Tooltip
            cursor={{ fill: "var(--hairline)", opacity: 0.4 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as BreakdownPoint | undefined;
              if (!row) return null;
              return (
                <div className="rounded bg-popover px-2 py-1.5 text-xs shadow ring-1 ring-border">
                  <div className="mb-1 font-medium">{shortMonth(label as string)}</div>
                  {SERIES.map((s) => {
                    const v = row[s.key] as number;
                    if (v === 0) return null;
                    return (
                      <div key={s.key} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-2 w-2 rounded-sm"
                            style={{ backgroundColor: s.color }}
                          />
                          {s.label}
                        </span>
                        <span className="tnum">{compactINR(v)}</span>
                      </div>
                    );
                  })}
                  <div className="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-1 font-semibold">
                    <span>Net</span>
                    <span className="tnum">{compactINR(row.net)}</span>
                  </div>
                </div>
              );
            }}
          />
          {/* Assets stack above zero, liabilities (negative) below — stackOffset="sign" */}
          <Bar dataKey="cash" stackId="nw" fill="var(--money-pos)" isAnimationActive={false} />
          <Bar dataKey="investments" stackId="nw" fill="var(--coral)" isAnimationActive={false} />
          <Bar dataKey="otherAssets" stackId="nw" fill="var(--soft)" isAnimationActive={false} />
          <Bar
            dataKey="liabilities"
            stackId="nw"
            fill="var(--money-neg)"
            radius={[0, 0, 2, 2]}
            isAnimationActive={false}
          />
          {/* Total net-worth line across the points */}
          <Line
            type="monotone"
            dataKey="net"
            stroke="var(--ink)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
