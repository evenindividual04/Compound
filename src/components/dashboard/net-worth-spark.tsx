"use client";

import { LineChart, Line, Tooltip, ResponsiveContainer } from "recharts";
import type { NetWorthPoint } from "@/lib/ledger/dashboard";

interface Props {
  /** Pre-aggregated series; value is number (converted at RSC boundary). */
  data: { date: string; value: number }[];
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export function NetWorthSpark({ data }: Props) {
  if (data.length === 0) return null;

  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="value"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const v = payload[0].value as number;
              return (
                <div className="rounded bg-popover px-2 py-1 text-xs shadow ring-1 ring-border">
                  {formatCurrency(v)}
                </div>
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Helper to convert NetWorthPoint[] → chart-safe props at the RSC boundary
export function toSparkData(series: NetWorthPoint[]): { date: string; value: number }[] {
  return series.map((p) => ({ date: p.date, value: Number(p.netWorth) }));
}
