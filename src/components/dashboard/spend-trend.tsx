"use client";

import { BarChart, Bar, Cell, Tooltip, XAxis, ResponsiveContainer } from "recharts";

interface Props {
  /** Pre-aggregated; value is number (converted at RSC boundary). */
  data: { month: string; value: number }[];
  /** 'YYYY-MM' for the highlighted (current) bar */
  currentMonth: string;
}

function shortMonth(yyyyMM: string): string {
  const [y, m] = yyyyMM.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(y, m - 1, 1));
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export function SpendTrend({ data, currentMonth }: Props) {
  if (data.length === 0) return null;

  return (
    <div className="h-32 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} barCategoryGap="30%">
          <XAxis
            dataKey="month"
            tickFormatter={shortMonth}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "var(--soft)" }}
          />
          <Tooltip
            cursor={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="rounded bg-popover px-2 py-1 text-xs shadow ring-1 ring-border">
                  <div className="font-medium">{shortMonth(label as string)}</div>
                  <div>{formatCurrency(payload[0].value as number)}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((entry) => (
              <Cell
                key={entry.month}
                fill={
                  entry.month === currentMonth
                    ? "var(--coral)"
                    : "var(--soft)"
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
