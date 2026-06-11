/**
 * Idempotent seed: one household + India-native category taxonomy + tax tags.
 * Run: pnpm dotenv -e .env.local -- tsx src/db/seed.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "./schema";

const EXPENSE_TAXONOMY: Record<string, string[]> = {
  "Food & Dining": ["Restaurants", "Swiggy/Zomato", "Coffee & Snacks"],
  Groceries: ["Supermarket", "Quick Commerce"],
  Transport: ["Fuel", "Auto/Cab", "Metro/Bus", "Train/Flight"],
  Housing: ["Rent", "Maintenance", "Furnishing"],
  "Domestic Help": ["Cook/Maid", "Laundry"],
  Utilities: ["Electricity", "Mobile/Broadband", "Gas Cylinder", "Water"],
  "EMI & Interest": ["Education Loan Interest", "Other EMI"],
  Insurance: ["Health Insurance", "Term Insurance", "Vehicle Insurance"],
  Health: ["Doctor/Hospital", "Pharmacy", "Fitness"],
  Education: ["Courses", "Books"],
  "Festivals & Gifts": ["Gifts", "Festival Spends"],
  Donations: ["Donations"],
  Subscriptions: ["Streaming", "Software/Cloud", "News"],
  Shopping: ["Clothing", "Electronics", "Home & Misc"],
  Travel: ["Stay", "Local Travel", "Trip Food & Fun"],
  "Personal Care": ["Salon", "Cosmetics"],
  "Taxes & Charges": ["Bank Charges", "Income Tax", "Late Fees"],
};

const INCOME_TAXONOMY: Record<string, string[]> = {
  Income: ["Salary", "Interest", "Dividends", "Cashback", "Refunds", "Other Income"],
};

const TAGS = ["80C", "80D", "80E", "80G", "reimbursable"];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  // household
  let [hh] = await db.select().from(schema.households).limit(1);
  if (!hh) {
    [hh] = await db.insert(schema.households).values({ name: "Anmol" }).returning();
    console.log("created household", hh.id);
  }

  const ensureCategory = async (
    name: string,
    classification: "income" | "expense",
    parentId: string | null,
    system: string | null = null,
  ) => {
    const where = parentId
      ? and(
          eq(schema.categories.householdId, hh.id),
          eq(schema.categories.parentId, parentId),
          eq(schema.categories.name, name),
        )
      : and(
          eq(schema.categories.householdId, hh.id),
          isNull(schema.categories.parentId),
          eq(schema.categories.name, name),
        );
    const [existing] = await db.select().from(schema.categories).where(where);
    if (existing) return existing;
    const [row] = await db
      .insert(schema.categories)
      .values({ householdId: hh.id, name, classification, parentId, system })
      .returning();
    return row;
  };

  let created = 0;
  for (const [group, leaves] of Object.entries(EXPENSE_TAXONOMY)) {
    const parent = await ensureCategory(group, "expense", null);
    for (const leaf of leaves) {
      const before = await db
        .select()
        .from(schema.categories)
        .where(and(eq(schema.categories.householdId, hh.id), eq(schema.categories.name, leaf)));
      await ensureCategory(leaf, "expense", parent.id);
      if (before.length === 0) created++;
    }
  }
  for (const [group, leaves] of Object.entries(INCOME_TAXONOMY)) {
    const parent = await ensureCategory(group, "income", null);
    for (const leaf of leaves) await ensureCategory(leaf, "income", parent.id);
  }
  // reserved reconciliation category (top-level, system-managed)
  await ensureCategory("Adjustment", "expense", null, "adjustment");

  for (const t of TAGS) {
    await db
      .insert(schema.tags)
      .values({ householdId: hh.id, name: t })
      .onConflictDoNothing();
  }

  const counts = await db.select().from(schema.categories);
  console.log(`seed done: ${counts.length} categories total (${created} new leaves this run)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
