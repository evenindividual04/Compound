import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { todayIST } from "@/lib/dates";
import { budgetView } from "@/lib/ledger/budgets";
import { formatINR, cmp } from "@/lib/money";
import { BudgetAmountEditor } from "@/components/budgets/budget-row-editor";
import { CopyLastMonthButton } from "@/components/budgets/copy-last-month-button";
import { UnbudgetedRowEditor } from "@/components/budgets/unbudgeted-row-editor";

// ── month helpers (shared with /transactions) ─────────────────────────────────

function parseMonth(raw: string | undefined): string {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return todayIST().slice(0, 7);
}

function prevMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(y, mo - 1, 1),
  );
}

// ── progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ spent, assigned }: { spent: string; assigned: string }) {
  const assignedN = parseFloat(assigned);
  if (assignedN <= 0) return null;
  const spentN = parseFloat(spent);
  const pct = Math.min((spentN / assignedN) * 100, 100);
  const over = cmp(spent, assigned) > 0;
  const nearLimit = !over && spentN / assignedN > 0.8;

  const barColor = over
    ? "bg-destructive"
    : nearLimit
      ? "bg-warn-ink"
      : "bg-coral";

  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hairline">
      <div
        className={`h-full rounded-full transition-all ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<{ month?: string }>;
}

export default async function BudgetsPage({ searchParams }: PageProps) {
  const { householdId } = await requireHousehold();
  const params = await searchParams;
  const month = parseMonth(params.month);

  const view = await budgetView(db, householdId, month);

  const prev = prevMonth(month);
  const next = nextMonth(month);
  const current = todayIST().slice(0, 7);
  const isCurrentMonth = month === current;
  const hasNoAllocations = view.rows.length === 0;

  const { totals } = view;

  return (
    <div className="min-h-screen bg-background">
      {/* Page title */}
      <div className="px-4 pt-5 pb-1">
        <h1 className="font-display text-3xl font-bold text-ink">Budgets</h1>
      </div>

      {/* Month pager header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-hairline bg-background/95 px-4 py-3 backdrop-blur">
        <Link
          href={`/budgets?month=${prev}`}
          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-5 w-5 text-soft" />
        </Link>
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
          {monthLabel(month)}
        </span>
        <Link
          href={`/budgets?month=${next}`}
          className={`flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted ${isCurrentMonth ? "pointer-events-none opacity-30" : ""}`}
          aria-label="Next month"
          aria-disabled={isCurrentMonth}
        >
          <ChevronRight className="h-5 w-5 text-soft" />
        </Link>
      </header>

      <div className="px-4 py-4 space-y-4">
        {/* Totals card */}
        <div className="rounded-2xl border border-hairline bg-surface p-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span className="text-soft">
              Assigned{" "}
              <span className="tnum tabular-nums font-semibold text-ink">
                {formatINR(totals.assigned)}
              </span>
            </span>
            <span className="text-soft">
              Spent{" "}
              <span className="tnum tabular-nums font-semibold text-ink">
                {formatINR(totals.spent)}
              </span>
            </span>
            <span className="text-soft">
              Left{" "}
              <span
                className={`tnum tabular-nums font-semibold ${cmp(totals.remaining, "0") < 0 ? "text-money-neg" : "text-money-pos"}`}
              >
                {formatINR(totals.remaining)}
              </span>
            </span>
          </div>
        </div>

        {/* Copy last month — only when current month is empty */}
        {hasNoAllocations && (
          <div className="flex justify-center pt-2">
            <CopyLastMonthButton month={month} />
          </div>
        )}

        {/* Budget rows */}
        {view.rows.length > 0 && (
          <section>
            <ul className="divide-y divide-hairline rounded-2xl border border-hairline overflow-hidden">
              {view.rows.map((row) => {
                const isOver = cmp(row.remaining, "0") < 0;
                return (
                  <li key={row.categoryId} className="bg-surface px-4 py-3">
                    {/* Top line: category name + right column */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {row.parentName && (
                          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft leading-none mb-0.5">
                            {row.parentName}
                          </p>
                        )}
                        <p className="text-sm font-medium text-ink leading-snug truncate">
                          {row.categoryName}
                        </p>
                        <p className="tnum text-xs text-soft tabular-nums mt-0.5">
                          {formatINR(row.spent)} of{" "}
                          <BudgetAmountEditor
                            month={month}
                            categoryId={row.categoryId}
                            assigned={row.assigned}
                          />
                        </p>
                      </div>
                      <div
                        className={`tnum shrink-0 text-right text-sm tabular-nums font-semibold ${isOver ? "text-money-neg" : "text-ink"}`}
                      >
                        {formatINR(row.remaining)}
                      </div>
                    </div>
                    <ProgressBar spent={row.spent} assigned={row.assigned} />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Unbudgeted spending */}
        {(view.unbudgetedSpend.length > 0 || cmp(view.uncategorizedSpend, "0") > 0) && (
          <section>
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
              Unbudgeted spending
            </h2>
            <div className="rounded-2xl border border-hairline bg-surface px-4 divide-y divide-hairline overflow-hidden">
              {view.unbudgetedSpend.map((row) => (
                <UnbudgetedRowEditor
                  key={row.categoryId}
                  month={month}
                  categoryId={row.categoryId}
                  categoryName={row.categoryName}
                  spent={row.spent}
                />
              ))}
              {cmp(view.uncategorizedSpend, "0") > 0 && (
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-soft italic">Uncategorized</span>
                  <span className="tnum text-sm tabular-nums text-soft">
                    {formatINR(view.uncategorizedSpend)}
                  </span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Empty state */}
        {view.rows.length === 0 &&
          view.unbudgetedSpend.length === 0 &&
          cmp(view.uncategorizedSpend, "0") === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <p className="text-sm text-soft">Nothing budgeted for {monthLabel(month)}.</p>
            </div>
          )}
      </div>
    </div>
  );
}
