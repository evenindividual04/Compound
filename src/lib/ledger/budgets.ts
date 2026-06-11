/**
 * Budget allocation reads and writes.
 * Spending = abs(rollup.amount) for expense-classified categories (rollups accumulate negative).
 */
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { abs, add, cmp, sub } from "@/lib/money";

// ── types ──────────────────────────────────────────────────────────────────────

export interface BudgetRow {
  categoryId: string;
  categoryName: string;
  parentName: string | null;
  assigned: string;
  spent: string;
  remaining: string;
}

export interface UnbudgetedRow {
  categoryId: string;
  categoryName: string;
  spent: string;
}

export interface BudgetView {
  rows: BudgetRow[];
  totals: { assigned: string; spent: string; remaining: string };
  unbudgetedSpend: UnbudgetedRow[];
  uncategorizedSpend: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** 'YYYY-MM' → 'YYYY-MM-01' */
function toMonthDate(month: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(month)) return month;
  return `${month}-01`;
}

function prevMonthDate(month: string): string {
  const d = toMonthDate(month);
  const [y, mo] = d.slice(0, 7).split("-").map(Number);
  const prev = new Date(y, mo - 2, 1); // mo-1 = 0-based current, -1 = prev
  const py = prev.getFullYear();
  const pm = String(prev.getMonth() + 1).padStart(2, "0");
  return `${py}-${pm}-01`;
}

// ── core functions ─────────────────────────────────────────────────────────────

export async function budgetView(
  db: Db,
  householdId: string,
  month: string,
): Promise<BudgetView> {
  const monthDate = toMonthDate(month);

  // 1. All categories for this household
  const allCats = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.householdId, householdId));

  const catById = new Map(allCats.map((c) => [c.id, c]));

  // Leaf expense categories: expense classification AND no children
  const parentIds = new Set(allCats.map((c) => c.parentId).filter(Boolean) as string[]);
  const leafExpenseCats = allCats.filter(
    (c) => c.classification === "expense" && !parentIds.has(c.id),
  );

  // 2. Allocations for this month
  const allocations = await db
    .select()
    .from(schema.budgetAllocations)
    .where(
      and(
        eq(schema.budgetAllocations.householdId, householdId),
        eq(schema.budgetAllocations.month, monthDate),
      ),
    );
  const allocByCatId = new Map(allocations.map((a) => [a.categoryId, a.assigned]));

  // 3. Rollups for this month (expense categories have negative amounts)
  const rollupRows = await db
    .select()
    .from(schema.rollups)
    .where(
      and(
        eq(schema.rollups.householdId, householdId),
        eq(schema.rollups.month, monthDate),
      ),
    );

  const rollupByCatId = new Map(rollupRows.map((r) => [r.categoryId ?? "__null__", r.amount]));

  // 4. Build budget rows: leaf expense categories WITH an allocation
  const rows: BudgetRow[] = [];
  for (const cat of leafExpenseCats) {
    const assigned = allocByCatId.get(cat.id);
    if (assigned === undefined) continue;

    const rollupAmt = rollupByCatId.get(cat.id) ?? "0.0000";
    // Expense rollups are negative; spent = abs
    const spent = cmp(rollupAmt, "0") < 0 ? abs(rollupAmt) : "0.0000";
    const remaining = sub(assigned, spent);

    const parent = cat.parentId ? catById.get(cat.parentId) : null;
    rows.push({
      categoryId: cat.id,
      categoryName: cat.name,
      parentName: parent?.name ?? null,
      assigned,
      spent,
      remaining,
    });
  }

  // 5. Totals
  let totalAssigned = "0.0000";
  let totalSpent = "0.0000";
  for (const r of rows) {
    totalAssigned = add(totalAssigned, r.assigned);
    totalSpent = add(totalSpent, r.spent);
  }
  const totalRemaining = sub(totalAssigned, totalSpent);

  // 6. Unbudgeted spend: leaf expense categories with rollup spend but NO allocation
  const allocatedCatIds = new Set(allocByCatId.keys());
  const unbudgetedSpend: UnbudgetedRow[] = [];
  for (const cat of leafExpenseCats) {
    if (allocatedCatIds.has(cat.id)) continue;
    const rollupAmt = rollupByCatId.get(cat.id) ?? "0.0000";
    if (cmp(rollupAmt, "0") >= 0) continue; // no negative spend
    const spent = abs(rollupAmt);
    unbudgetedSpend.push({ categoryId: cat.id, categoryName: cat.name, spent });
  }

  // 7. Uncategorized spend: rollup row with null categoryId
  const uncatAmt = rollupByCatId.get("__null__") ?? "0.0000";
  const uncategorizedSpend = cmp(uncatAmt, "0") < 0 ? abs(uncatAmt) : "0.0000";

  return {
    rows,
    totals: { assigned: totalAssigned, spent: totalSpent, remaining: totalRemaining },
    unbudgetedSpend,
    uncategorizedSpend,
  };
}

export async function setAllocation(
  db: Db,
  householdId: string,
  month: string,
  categoryId: string,
  assigned: string,
): Promise<void> {
  const monthDate = toMonthDate(month);

  if (cmp(assigned, "0") === 0) {
    // Delete the row
    await db
      .delete(schema.budgetAllocations)
      .where(
        and(
          eq(schema.budgetAllocations.householdId, householdId),
          eq(schema.budgetAllocations.month, monthDate),
          eq(schema.budgetAllocations.categoryId, categoryId),
        ),
      );
    return;
  }

  // Upsert
  await db
    .insert(schema.budgetAllocations)
    .values({ householdId, month: monthDate, categoryId, assigned })
    .onConflictDoUpdate({
      target: [
        schema.budgetAllocations.householdId,
        schema.budgetAllocations.month,
        schema.budgetAllocations.categoryId,
      ],
      set: { assigned },
    });
}

export async function copyLastMonth(
  db: Db,
  householdId: string,
  month: string,
): Promise<number> {
  const monthDate = toMonthDate(month);
  const prevDate = prevMonthDate(month);

  // Last month's allocations
  const lastMonth = await db
    .select()
    .from(schema.budgetAllocations)
    .where(
      and(
        eq(schema.budgetAllocations.householdId, householdId),
        eq(schema.budgetAllocations.month, prevDate),
      ),
    );

  if (lastMonth.length === 0) return 0;

  // Already-allocated categories this month
  const existing = await db
    .select({ categoryId: schema.budgetAllocations.categoryId })
    .from(schema.budgetAllocations)
    .where(
      and(
        eq(schema.budgetAllocations.householdId, householdId),
        eq(schema.budgetAllocations.month, monthDate),
      ),
    );
  const existingIds = new Set(existing.map((e) => e.categoryId));

  // Only copy categories not already allocated
  const toInsert = lastMonth.filter((r) => !existingIds.has(r.categoryId));
  if (toInsert.length === 0) return 0;

  await db.insert(schema.budgetAllocations).values(
    toInsert.map((r) => ({
      householdId,
      month: monthDate,
      categoryId: r.categoryId,
      assigned: r.assigned,
    })),
  );

  return toInsert.length;
}
