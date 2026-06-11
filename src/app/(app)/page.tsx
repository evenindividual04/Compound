import Link from "next/link";
import { ArrowUpRight, ArrowDownRight, AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { todayIST } from "@/lib/dates";
import { formatINR, formatINRCompact, sub, cmp } from "@/lib/money";
import {
  monthSpend,
  spendTrend,
  netWorthSeries,
  needsAttention,
  recentTransactions,
} from "@/lib/ledger/dashboard";
import { MetricCard } from "@/components/dashboard/metric-card";
import { NetWorthSpark, toSparkData } from "@/components/dashboard/net-worth-spark";
import { SpendTrend, toTrendData } from "@/components/dashboard/spend-trend";

// month helpers
function monthStart(ymd: string) {
  return ymd.slice(0, 7) + "-01";
}

function monthLabel(yyyyMM01: string): string {
  const [y, m] = yyyyMM01.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(y, m - 1, 1),
  );
}

function prevMonthStart(yyyyMM01: string): string {
  const [y, m] = yyyyMM01.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default async function DashboardPage() {
  const { householdId } = await requireHousehold();
  const today = todayIST();
  const thisMonthStart = monthStart(today);
  const lastMonthStart = prevMonthStart(thisMonthStart);

  // Parallel queries — all fast (rollups/balances/light)
  const [
    thisSpend,
    lastSpend,
    trend,
    nwSeries,
    attention,
    recent,
    budgetData,
    nwNow,
  ] = await Promise.all([
    monthSpend(db, householdId, thisMonthStart),
    monthSpend(db, householdId, lastMonthStart),
    spendTrend(db, householdId, 6),
    netWorthSeries(db, householdId, 30),
    needsAttention(db, householdId),
    recentTransactions(db, householdId, 5),
    // Budget: Σ assigned − Σ spent this month
    db.execute(sql`
      SELECT
        COALESCE(SUM(ba.assigned), 0)::numeric(19,4)::text AS total_assigned,
        COALESCE(ABS(SUM(CASE WHEN r.amount < 0 THEN r.amount ELSE 0 END)), 0)::numeric(19,4)::text AS total_spent,
        COUNT(ba.category_id)::int AS allocation_count
      FROM budget_allocations ba
      FULL OUTER JOIN rollups r ON r.household_id = ba.household_id
        AND r.month = ba.month
        AND r.category_id = ba.category_id
      WHERE ba.household_id = ${householdId}::uuid
        AND ba.month = ${thisMonthStart}::date
    `),
    // Latest net worth scalar
    db.execute(sql`
      SELECT COALESCE(SUM(b.balance), 0)::numeric(19,4)::text AS nw
      FROM (
        SELECT DISTINCT ON (b.account_id) b.balance
        FROM balances b
        JOIN accounts a ON a.id = b.account_id
        WHERE a.household_id = ${householdId}::uuid
          AND a.status = 'active'
          AND NOT a.excluded
          AND b.date <= ${today}
        ORDER BY b.account_id, b.date DESC
      ) b
    `),
  ]);

  // Budget calc
  const budgetRow = (
    budgetData as unknown as {
      rows: { total_assigned: string; total_spent: string; allocation_count: number }[];
    }
  ).rows[0];
  const hasAllocations = (budgetRow?.allocation_count ?? 0) > 0;
  const budgetLeft = hasAllocations
    ? sub(budgetRow.total_assigned, budgetRow.total_spent)
    : null;

  // Net worth scalar
  const netWorthNow = (nwNow as unknown as { rows: { nw: string }[] }).rows[0]?.nw ?? "0.0000";

  // Spend delta (positive = spending MORE = bad)
  const spendDiff = sub(thisSpend, lastSpend);
  const spendingMore = cmp(thisSpend, lastSpend) > 0;

  // Top category from trend data (most-spent category this month — use monthSpendByCategory implicitly)
  // We'll use the first trend point for current month; top category is from a separate fast path:
  const topCatRes = await db.execute(sql`
    SELECT
      COALESCE(c.name, 'Uncategorized') AS category_name,
      ABS(r.amount)::numeric(19,4)::text AS amount
    FROM rollups r
    LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.household_id = ${householdId}::uuid
      AND r.month = ${thisMonthStart}::date
      AND r.amount < 0
      AND (r.category_id IS NULL OR c.classification = 'expense')
    ORDER BY ABS(r.amount) DESC
    LIMIT 1
  `);
  const topCat = (topCatRes as unknown as { rows: { category_name: string; amount: string }[] })
    .rows[0] ?? null;

  // Convert to chart-safe number props at RSC boundary (display-only)
  const sparkData = toSparkData(nwSeries);
  const trendData = toTrendData(trend);
  const currentMonthKey = thisMonthStart.slice(0, 7);

  return (
    <div className="min-h-screen bg-background px-4 pt-6">
      {/* ── Hero ── */}
      <section className="flex flex-col items-start gap-1 pb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {monthLabel(thisMonthStart)}
        </p>
        <p className="text-xs text-muted-foreground">spent this month</p>
        <div className="flex items-end gap-3">
          <p className="tnum text-5xl font-semibold tracking-tight text-foreground">
            {formatINR(thisSpend)}
          </p>
          {/* Delta badge vs last month */}
          {cmp(spendDiff, "0") !== 0 && (
            <span
              className={`mb-1 flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                spendingMore
                  ? "bg-destructive/15 text-destructive"
                  : "bg-emerald-500/15 text-emerald-500"
              }`}
            >
              {spendingMore ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {formatINRCompact(spendDiff)}
            </span>
          )}
        </div>
      </section>

      {/* ── Needs attention strip ── */}
      {(attention.inbox > 0 ||
        attention.anomalies > 0 ||
        attention.staleAnchors.length > 0) && (
        <section className="mb-6 flex flex-wrap gap-2">
          {attention.inbox > 0 && (
            <Link
              href="/inbox"
              className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
            >
              <Inbox className="h-3 w-3" />
              Inbox {attention.inbox}
            </Link>
          )}
          {attention.anomalies > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              {attention.anomalies} {attention.anomalies === 1 ? "anomaly" : "anomalies"}
            </span>
          )}
          {attention.staleAnchors.map((anchor) => (
            <Link
              key={anchor.accountId}
              href={`/accounts/${anchor.accountId}`}
              className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-500"
            >
              <RefreshCw className="h-3 w-3" />
              Update {anchor.accountName}
            </Link>
          ))}
        </section>
      )}

      {/* ── Metric cards ── */}
      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Net worth */}
        <MetricCard
          label="Net Worth"
          value={formatINRCompact(netWorthNow)}
          sub={
            <div className="mt-1">
              <NetWorthSpark data={sparkData} />
            </div>
          }
        />

        {/* Budget left */}
        <MetricCard
          label="Budget left"
          value={
            hasAllocations && budgetLeft !== null ? (
              <span
                className={
                  cmp(budgetLeft, "0") >= 0 ? "text-emerald-500" : "text-destructive"
                }
              >
                {formatINRCompact(budgetLeft)}
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )
          }
          action={
            !hasAllocations ? (
              <Link
                href="/budgets"
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Set budgets
              </Link>
            ) : undefined
          }
        />

        {/* Top category */}
        <MetricCard
          label="Top category"
          value={
            topCat ? (
              <span className="truncate">{topCat.category_name}</span>
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )
          }
          sub={topCat ? formatINR(topCat.amount) : undefined}
        />
      </section>

      {/* ── Spend trend ── */}
      <section className="mb-6">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          6-month spend
        </p>
        <SpendTrend data={trendData} currentMonth={currentMonthKey} />
      </section>

      {/* ── Recent transactions ── */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent
          </p>
          <Link
            href="/transactions"
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            View all
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No transactions yet</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl ring-1 ring-foreground/10">
            {recent.map((txn) => (
              <li key={txn.entryId} className="flex items-center justify-between px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium leading-snug">
                    {txn.merchant ?? txn.description ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {txn.categoryName ?? "Uncategorized"} · {txn.date}
                  </span>
                </div>
                <span
                  className={`tnum text-sm font-medium ${
                    txn.amount.startsWith("-") ? "text-destructive" : "text-emerald-500"
                  }`}
                >
                  {formatINR(txn.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
