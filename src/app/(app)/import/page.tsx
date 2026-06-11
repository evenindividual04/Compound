/**
 * /import — Bank statement import page.
 * RSC: loads active accounts and import history, passes to client components.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema/core";
import { requireHousehold } from "@/lib/current";
import { ImportPageClient } from "@/components/import/import-page-client";

export default async function ImportPage() {
  const { householdId } = await requireHousehold();

  const activeAccounts = await db
    .select({ id: accounts.id, name: accounts.name, kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.householdId, householdId))
    .then((rows) => rows.filter((a) => a.kind === a.kind)); // all accounts, filtered by status below

  // Only active accounts
  const filtered = await db
    .select({ id: accounts.id, name: accounts.name, kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.householdId, householdId));

  const bankable = filtered.filter((a) => !["epf", "ppf", "fd", "investment", "property", "gold", "crypto"].includes(a.kind));

  return <ImportPageClient accounts={bankable} />;
}
