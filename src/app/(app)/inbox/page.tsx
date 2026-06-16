import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { inboxItems } from "@/lib/ledger/inbox";
import { InboxClient } from "@/components/inbox/inbox-client";
import type { CategoryOption } from "@/components/category-picker";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { householdId } = await requireHousehold();

  const [items, allCategories] = await Promise.all([
    inboxItems(db, householdId),
    db.select().from(schema.categories).where(eq(schema.categories.householdId, householdId)),
  ]);

  const parentNameById = new Map(allCategories.map((c) => [c.id, c.name]));
  const parentIds = new Set(
    allCategories.map((c) => c.parentId).filter(Boolean) as string[],
  );
  const leafCategories: CategoryOption[] = allCategories
    .filter((c) => !parentIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      classification: c.classification as "income" | "expense",
      parentName: c.parentId ? (parentNameById.get(c.parentId) ?? null) : null,
    }));

  const count = items.pendingEntries.length + items.pendingTransfers.length;

  return (
    <div className="px-4 pb-6 pt-5">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold text-ink">Inbox</h1>
        {count > 0 && (
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
            {count}
          </span>
        )}
      </div>

      <InboxClient
        pendingEntries={items.pendingEntries}
        pendingTransfers={items.pendingTransfers}
        categories={leafCategories}
      />
    </div>
  );
}
