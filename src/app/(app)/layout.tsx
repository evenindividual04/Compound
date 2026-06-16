import type React from "react";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { recentCategoryIds } from "@/lib/ledger/quick-add";
import { inboxCount } from "@/lib/ledger/inbox";
import type { CategoryOption } from "@/components/quick-entry";
import { AppShell } from "@/components/app-shell";

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

  // Inbox count for badge
  const count = await inboxCount(db, householdId);

  return (
    <AppShell
      inboxCount={count}
      quickEntryProps={{
        categories: leafCategories,
        recentIds,
        accounts: activeAccounts,
      }}
    >
      {children}
    </AppShell>
  );
}
