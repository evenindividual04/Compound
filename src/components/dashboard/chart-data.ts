/**
 * Server-safe converters: money strings → chart-safe numbers, called at the
 * RSC boundary only. Charts are display-only — the sanctioned Number() exception.
 * (Must NOT live in a "use client" module: server pages call these as functions.)
 */
export function toTrendData(
  trend: { month: string; spend: string }[],
): { month: string; value: number }[] {
  return trend.map((p) => ({ month: p.month, value: Number(p.spend) }));
}
