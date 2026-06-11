import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { recentCategoryIds } from "@/lib/ledger/quick-add";
import { BottomNav } from "@/components/bottom-nav";
import { InstallCoachMark } from "@/components/install-coach-mark";
import { QuickEntry } from "@/components/quick-entry";
import type { CategoryOption } from "@/components/quick-entry";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { householdId } = await requireHousehold();

  // Fetch all categories for this household (leaf + parent info)
  const allCategories = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.householdId, householdId));

  // Build a parentId→name map
  const parentNameById = new Map<string, string>(
    allCategories.map((c) => [c.id, c.name]),
  );

  // Leaf = has no children
  const parentIds = new Set(allCategories.map((c) => c.parentId).filter(Boolean) as string[]);
  const leafCategories: CategoryOption[] = allCategories
    .filter((c) => !parentIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      classification: c.classification as "income" | "expense",
      parentName: c.parentId ? (parentNameById.get(c.parentId) ?? null) : null,
    }));

  // Active accounts
  const activeAccounts = await db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.householdId, householdId),
        eq(schema.accounts.status, "active"),
      ),
    );

  // Recent category ids for chip suggestions
  const recentIds = await recentCategoryIds(db, householdId, 8);

  return (
    <>
      <main className="flex-1 pb-20">{children}</main>
      <BottomNav />
      <QuickEntry
        categories={leafCategories}
        recentIds={recentIds}
        accounts={activeAccounts}
      />
      <InstallCoachMark />
    </>
  );
}
