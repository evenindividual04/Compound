import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { todayIST } from "@/lib/dates";
import { spendTrend } from "@/lib/ledger/dashboard";
import { toTrendData } from "@/components/dashboard/chart-data";
import { SpendTrend } from "@/components/dashboard/spend-trend";

function monthStart(ymd: string) {
  return ymd.slice(0, 7) + "-01";
}

export default async function TrendsPage() {
  const { householdId } = await requireHousehold();
  const today = todayIST();
  const currentMonthKey = monthStart(today).slice(0, 7);

  const trend = await spendTrend(db, householdId, 6);
  const trendData = toTrendData(trend);

  return (
    <div className="min-h-screen" style={{ padding: "0 0 24px" }}>
      {/* Header */}
      <header style={{ padding: "8px 20px 10px" }}>
        <h1
          className="font-display text-ink"
          style={{ fontSize: "34px", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}
        >
          Trends
        </h1>
        <p className="text-soft" style={{ fontSize: "12px", marginTop: "2px" }}>
          Your spending over time.
        </p>
      </header>

      {/* Spend trend card */}
      <div style={{ margin: "12px 16px 0" }}>
        <div
          className="bg-surface"
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: "14px",
            padding: "16px",
          }}
        >
          <p
            style={{
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--soft)",
              marginBottom: "12px",
            }}
          >
            6-month spend
          </p>
          <SpendTrend data={trendData} currentMonth={currentMonthKey} />
        </div>
      </div>
    </div>
  );
}
