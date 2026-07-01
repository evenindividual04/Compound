/**
 * Test database helpers. Suites using this must guard with:
 *   describe.skipIf(!process.env.TEST_DATABASE_URL)
 * The `pnpm test` script loads .env.local, which points at the local compound_test db.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

const url = process.env.TEST_DATABASE_URL;
export const testPool = url ? new Pool({ connectionString: url, max: 2 }) : null;
export const tdb = testPool ? drizzle(testPool, { schema }) : (null as never);
export type TestDb = NonNullable<typeof tdb>;

export async function resetDb() {
  await tdb.execute(sql`
    TRUNCATE TABLE entry_events, rejected_transfers, transfers, transaction_splits,
      entry_tags, valuations, transactions, prices, trades, instruments, entries,
      import_rows, imports, import_configs,
      rules, budget_allocations, ledger_anomalies, bridge_heartbeats, balances, rollups,
      tags, categorization_examples, categories, accounts, users, households CASCADE
  `);
}

export async function seedBasics() {
  const [hh] = await tdb.insert(schema.households).values({ name: "test" }).returning();
  const mkAccount = (name: string, kind: schema.AccountKind, openingBalance = "0") =>
    tdb
      .insert(schema.accounts)
      .values({ householdId: hh.id, name, kind, openingBalance, openingDate: "2026-01-01" })
      .returning()
      .then((r) => r[0]);
  const bank = await mkAccount("HDFC", "bank", "1000");
  const cash = await mkAccount("Cash", "cash");
  const epf = await mkAccount("EPF", "epf");
  const card = await mkAccount("Card", "credit_card");

  const mkCategory = (
    name: string,
    classification: "income" | "expense",
    system: string | null = null,
  ) =>
    tdb
      .insert(schema.categories)
      .values({ householdId: hh.id, name, classification, system })
      .returning()
      .then((r) => r[0]);
  const food = await mkCategory("Food & Dining", "expense");
  const groceries = await mkCategory("Groceries", "expense");
  const salary = await mkCategory("Salary", "income");
  const adjustment = await mkCategory("Adjustment", "expense", "adjustment");

  return { hh, bank, cash, epf, card, food, groceries, salary, adjustment };
}
