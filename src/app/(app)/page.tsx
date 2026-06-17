import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { todayIST } from "@/lib/dates";
import { formatINRCompact, sub, cmp } from "@/lib/money";
import {
  monthSpend,
  needsAttention,
} from "@/lib/ledger/dashboard";
import { netWorth } from "@/lib/ledger/derive";
import { netWorthBreakdownSeries } from "@/lib/ledger/networth-series";
import { HomeHeader } from "@/components/home/home-header";
import { UrgentCards } from "@/components/home/urgent-card";
import { SpendCard } from "@/components/home/spend-card";
import { SavingsRing } from "@/components/home/savings-ring";
import { CompoundCard } from "@/components/home/compound-card";
import { AddCardTile } from "@/components/home/add-card-tile";

// ─── Month helpers (verbatim from original) ─────────────────────────────────

function monthStart(ymd: string): string {
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

// ─── Greeting ────────────────────────────────────────────────────────────────

function timeOfDay(hourIST: number): string {
  if (hourIST < 12) return "Morning";
  if (hourIST < 17) return "Afternoon";
  return "Evening";
}

// ─── Initials ────────────────────────────────────────────────────────────────

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return ((parts[0][0] ?? "") + (parts[1][0] ?? "")).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

// ─── Projection target (illustrative — see DESIGN.md §14, math not locked) ──

function computeProjectionTarget(
  currentNetWorth: number,
  monthlySaved: number, // approximate monthly savings (may be negative/zero)
): string {
  // illustrative projection — see DESIGN.md §14 (math not locked)
  // Assumes: current monthly saved pace continues; 10% p.a. return on accumulated corpus.
  // Target horizon: age 39. User is ~22 now → 17 years = 204 months.
  const MONTHS = 204;
  const MONTHLY_RATE = 0.10 / 12; // 10% p.a. → monthly (illustrative)

  const monthlySavedSafe = Math.max(monthlySaved, 0);

  // Future value of existing corpus compounded
  const fvCorpus = currentNetWorth * Math.pow(1 + MONTHLY_RATE, MONTHS);
  // Future value of monthly contributions (annuity formula)
  const fvContributions =
    monthlySavedSafe > 0
      ? monthlySavedSafe * ((Math.pow(1 + MONTHLY_RATE, MONTHS) - 1) / MONTHLY_RATE)
      : 0;

  const total = fvCorpus + fvContributions;

  // Format as compact string (treat as a money string for formatINRCompact)
  // Number() safe here — this is a purely illustrative display statistic
  return formatINRCompact(Math.max(total, 0).toFixed(4));
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const { householdId, email } = await requireHousehold();
  const today = todayIST();
  const thisMonthStart = monthStart(today);
  const lastMonthStart = prevMonthStart(thisMonthStart);

  // Hour in IST for greeting (computed later via toLocaleString)

  // Parallel data fetches
  const [
    thisSpend,
    lastSpend,
    nwBreakdown,
    attention,
    budgetData,
    netWorthNow,
    incomeData,
    topCatRes,
  ] = await Promise.all([
    monthSpend(db, householdId, thisMonthStart),
    monthSpend(db, householdId, lastMonthStart),
    // Net-worth-by-asset-class, monthly over 12 months. Investment accounts are
    // valued at market value (holdingValueAt) — correct for holdings, unlike the
    // balances-table-only series which would sum trade cash-flows.
    netWorthBreakdownSeries(db, householdId),
    needsAttention(db, householdId),

    // Budget: Σ assigned vs Σ |spent| this month (verbatim from original)
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

    // Latest net worth scalar — investment-aware (non-investment cash balances +
    // investment market value via holdingValueAt). Correct for holdings.
    netWorth(db, householdId, today),

    // Income for savings ring (inline — not in src/lib)
    db.execute(sql`
      SELECT COALESCE(SUM(r.amount), 0)::numeric(19,4)::text AS income
      FROM rollups r
      JOIN categories c ON c.id = r.category_id
      WHERE r.household_id = ${householdId}::uuid
        AND r.month = ${thisMonthStart}::date
        AND c.classification = 'income'
    `),

    // Top category by spend (verbatim from original)
    db.execute(sql`
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
    `),
  ]);

  // ── Budget ──────────────────────────────────────────────────────────────────
  const budgetRow = (
    budgetData as unknown as {
      rows: { total_assigned: string; total_spent: string; allocation_count: number }[];
    }
  ).rows[0];
  const hasAllocations = (budgetRow?.allocation_count ?? 0) > 0;
  const budgetLeft =
    hasAllocations && budgetRow
      ? sub(budgetRow.total_assigned, budgetRow.total_spent)
      : null;

  // ── Net worth ───────────────────────────────────────────────────────────────
  // netWorthNow is the signed NUMERIC string from netWorth() (investment-aware).

  // ── Income + savings ring ───────────────────────────────────────────────────
  const rawIncome = (incomeData as unknown as { rows: { income: string }[] }).rows[0]?.income ?? "0.0000";
  // Income from rollups comes as a positive sum (classification=income, amounts stored positive)
  const income = rawIncome;
  const hasIncome = cmp(income, "0") > 0;
  const saved = hasIncome ? sub(income, thisSpend) : "0.0000";
  // savingsRate as a display Number (% stat, derived — Number() safe)
  const savingsRate = hasIncome ? Math.max(parseFloat(saved) / parseFloat(income), 0) : 0;
  const savingsPct = Math.round(savingsRate * 100);
  // Amount needed to hit 30% target
  const targetSaved = hasIncome
    ? (parseFloat(income) * 0.3).toFixed(4)
    : null;
  const hintAmount =
    hasIncome && targetSaved && cmp(saved, targetSaved) < 0
      ? sub(targetSaved, saved)
      : null;

  // ── Spend delta pill ────────────────────────────────────────────────────────
  // deltaPct is a derived display stat — Number() safe (not a stored money value)
  const spendingMore = cmp(thisSpend, lastSpend) > 0;
  let deltaPct: number | null = null;
  const lastSpendNum = parseFloat(lastSpend);
  if (lastSpendNum > 0) {
    // Number() safe — this is a derived display percentage, not a stored money value
    deltaPct = Math.round(
      Math.abs((parseFloat(thisSpend) - lastSpendNum) / lastSpendNum) * 100,
    );
  }

  // ── Top category + pace insight ─────────────────────────────────────────────
  const topCat = (topCatRes as unknown as { rows: { category_name: string; amount: string }[] })
    .rows[0] ?? null;

  // prevMonthPct: how much we're pacing vs last month (derived stat — Number() safe)
  let prevMonthPct: number | null = null;
  if (lastSpendNum > 0) {
    // Number() safe — derived display stat only
    prevMonthPct = Math.round(((parseFloat(thisSpend) - lastSpendNum) / lastSpendNum) * 100);
  }

  // ── Net worth month gain ─────────────────────────────────────────────────────
  // Latest net minus ~one-month-ago net, from the (already-boundary) breakdown
  // series. Derived display stat — the numbers were converted at the chart
  // boundary; formatting the delta as a string here is display-only.
  const nwLatest = nwBreakdown[nwBreakdown.length - 1]?.net ?? 0;
  const nwPrior = nwBreakdown[nwBreakdown.length - 2]?.net ?? nwLatest;
  const monthGain = (nwLatest - nwPrior).toFixed(4);

  // ── Projection (illustrative — DESIGN.md §14, math not locked) ───────────────
  // Number() safe — purely illustrative display statistic
  const projectionTarget = computeProjectionTarget(
    parseFloat(netWorthNow),
    parseFloat(saved),
  );

  // ── Attention count for bell badge ───────────────────────────────────────────
  const attentionCount = attention.inbox + attention.staleAnchors.length;

  // ── Greeting ─────────────────────────────────────────────────────────────────
  // Derive IST hour directly from today string (date is IST; time we compute fresh)
  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const greeting = `${timeOfDay(nowIST.getHours())}.`;

  // ── Labels ───────────────────────────────────────────────────────────────────
  const currentMonthLabel = monthLabel(thisMonthStart).toUpperCase();
  const prevMonthName = monthLabel(lastMonthStart).split(" ")[0] ?? "last month";

  return (
    <div className="flex flex-col gap-[10px] bg-paper min-h-screen pt-1 pb-4">
      {/* Header */}
      <HomeHeader
        monthLabel={currentMonthLabel}
        greeting={greeting}
        attentionCount={attentionCount}
        avatarInitials={initials(email)}
      />

      {/* Edit summary hint */}
      <div className="flex justify-end px-4">
        <Link href="/browse" className="text-[11px] font-semibold text-coral">
          Edit summary →
        </Link>
      </div>

      {/* Urgent cards — above spend */}
      <UrgentCards attention={attention} />

      {/* Spend card */}
      <SpendCard
        thisSpend={thisSpend}
        spendingMore={spendingMore}
        deltaPct={deltaPct}
        prevMonthLabel={prevMonthName}
        topCategoryName={topCat?.category_name ?? null}
        prevMonthPct={prevMonthPct}
        hasAllocations={hasAllocations}
        budgetAssigned={budgetRow?.total_assigned ?? null}
        budgetLeft={budgetLeft}
        budgetSpent={budgetRow?.total_spent ?? null}
      />

      {/* Savings ring */}
      <SavingsRing
        saved={saved}
        income={income}
        savingsRate={savingsRate}
        savingsPct={savingsPct}
        hintAmount={hintAmount}
        hasIncome={hasIncome}
      />

      {/* Compound card */}
      <CompoundCard
        corpus={netWorthNow}
        monthGain={monthGain}
        breakdown={nwBreakdown}
        projectionTarget={projectionTarget}
      />

      {/* Investments deep-link */}
      <div className="flex justify-end px-4">
        <Link href="/invest" className="text-[11px] font-semibold text-coral">
          Investments →
        </Link>
      </div>

      {/* Add-a-card tile */}
      <AddCardTile />
    </div>
  );
}
