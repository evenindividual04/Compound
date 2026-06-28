/**
 * P3a Acceptance Harness
 * Run against compound_dev. Self-contained; creates + destroys an isolated household.
 * Usage (from project root):
 *   pnpm exec dotenv -e .env.local -- npx tsx src/scripts/p3a-acceptance.ts
 * OR:
 *   DATABASE_URL=... npx tsx src/scripts/p3a-acceptance.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTransaction } from "@/lib/ledger/write";
import { categorizeEntries } from "@/lib/categorize/categorize";
import { acceptEntry, inboxItems } from "@/lib/ledger/inbox";
import { backfillCategories } from "@/lib/categorize/backfill";
import { recordExample } from "@/lib/categorize/examples";
import { embed } from "@/lib/categorize/embed";
import type { GenerateFn } from "@/lib/categorize/llm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const pool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool, { schema });

// Stubbed generate: always abstains (forces T1 path from seeded examples)
const stubbedGenerate: GenerateFn = async () => null;

async function run() {
  let householdId: string | null = null;

  try {
    // ── 1. Isolated household + accounts + categories ──────────────────────────
    const [hh] = await db.insert(schema.households).values({ name: "p3a-acceptance-test" }).returning();
    householdId = hh.id;
    console.log(`✓ household ${hh.id}`);

    const [bank] = await db.insert(schema.accounts).values({
      householdId: hh.id, name: "TestBank", kind: "bank",
      openingBalance: "0", openingDate: "2026-01-01",
    }).returning();

    // Two categories for testing: food (expense), transport (expense)
    const [food] = await db.insert(schema.categories).values({
      householdId: hh.id, name: "Food & Dining", classification: "expense",
    }).returning();
    const [transport] = await db.insert(schema.categories).values({
      householdId: hh.id, name: "Transport", classification: "expense",
    }).returning();

    // ── 2. Seed training examples ──────────────────────────────────────────────
    const examplePairs: [string, string][] = [
      ["swiggy", food.id],
      ["zomato", food.id],
      ["uber eats", food.id],
      ["ola", transport.id],
      ["rapido", transport.id],
      ["metro card", transport.id],
    ];

    for (const [text, categoryId] of examplePairs) {
      const rawVec = await embed(text);
      // fastembed may return a Float32Array; convert to a plain number[] for Postgres vector column.
      const vec: number[] = Array.from(rawVec);
      await recordExample(db, { householdId: hh.id, text, categoryId, embedding: vec, source: "accept" });
    }
    console.log(`✓ seeded ${examplePairs.length} training examples`);

    // ── 3. Create pending entries ──────────────────────────────────────────────
    const entry1Id = await createTransaction(db, {
      accountId: bank.id, date: "2026-06-18", amount: "-250",
      description: "Swiggy", merchant: "swiggy", status: "pending", source: "import",
    });
    const entry2Id = await createTransaction(db, {
      accountId: bank.id, date: "2026-06-18", amount: "-120",
      description: "Ola cab", merchant: "ola", status: "pending", source: "import",
    });
    console.log(`✓ created 2 pending entries`);

    // ── 4. Run categorizeEntries with real embedder + stubbed generate ─────────
    const deps = { embed, generate: stubbedGenerate, t1MinSim: 0.5 };
    const result = await categorizeEntries(db, hh.id, [entry1Id, entry2Id], deps);
    console.log(`✓ categorizeEntries: resolved=${result.resolved}, abstained=${result.abstained}`);

    if (result.resolved < 1) throw new Error(`Expected >=1 resolved, got ${result.resolved}`);

    // ── 5. Assert T1 suggestions land unlocked ─────────────────────────────────
    const items = await inboxItems(db, hh.id);
    let unlocked = 0;
    for (const e of items.pendingEntries) {
      if (e.categoryId && !e.categoryLocked) {
        unlocked++;
        console.log(`  entry "${e.description}": category set, locked=${e.categoryLocked}, suggestionSource=${e.suggestionSource}`);
      }
    }
    console.log(`✓ ${unlocked} T1 suggestions landed unlocked`);
    if (unlocked < 1) throw new Error("Expected >=1 unlocked T1 suggestion");

    // Verify suggestionSource is populated for at least one unlocked entry
    const withSource = items.pendingEntries.filter(e => e.categoryId && !e.categoryLocked && e.suggestionSource !== null);
    if (withSource.length < 1) throw new Error("Expected suggestionSource to be set on at least one unlocked entry");
    console.log(`✓ suggestionSource correctly populated: ${withSource.map(e => e.suggestionSource).join(", ")}`);

    // ── 6. Accept one entry and assert a training example was recorded ─────────
    const beforeExamples = await db.select().from(schema.categorizationExamples)
      .where(eq(schema.categorizationExamples.householdId, hh.id));
    const beforeCount = beforeExamples.length;

    await acceptEntry(db, entry1Id, "user", food.id, embed);
    console.log(`✓ accepted entry1 (food)`);

    const afterExamples = await db.select().from(schema.categorizationExamples)
      .where(eq(schema.categorizationExamples.householdId, hh.id));
    const afterCount = afterExamples.length;

    const recorded = afterExamples.some(e => e.categoryId === food.id);
    if (!recorded) throw new Error("No training example with food category recorded after accept");
    console.log(`✓ training example recorded (examples: ${beforeCount} → ${afterCount})`);

    // ── 7. Backfill idempotence ────────────────────────────────────────────────
    // Create a posted uncategorized entry for backfill.
    await createTransaction(db, {
      accountId: bank.id, date: "2026-06-17", amount: "-80",
      description: "Rapido ride", merchant: "rapido", status: "posted", source: "import",
    });

    const r1 = await backfillCategories(db, hh.id, deps);
    console.log(`✓ backfill run 1: scanned=${r1.scanned}, resolved=${r1.resolved}, abstained=${r1.abstained}`);
    if (r1.scanned === 0) throw new Error("Expected backfill to scan at least one entry");

    const r2 = await backfillCategories(db, hh.id, deps);
    console.log(`✓ backfill run 2 (idempotence): scanned=${r2.scanned}`);
    if (r2.scanned !== 0) throw new Error("Expected second backfill to find nothing (idempotent)");

    console.log("\n✅ All P3a acceptance assertions passed");

  } finally {
    // ── 8. Cleanup (FK-safe teardown) ─────────────────────────────────────────
    if (householdId) {
      try {
        await db.execute(sql`DELETE FROM categorization_examples WHERE household_id = ${householdId}`);
        await db.execute(sql`
          DELETE FROM entry_events ev
          USING entries e JOIN accounts a ON a.id = e.account_id
          WHERE ev.entry_id = e.id AND a.household_id = ${householdId}
        `);
        await db.execute(sql`
          DELETE FROM transaction_splits ts
          USING entries e JOIN accounts a ON a.id = e.account_id
          WHERE ts.entry_id = e.id AND a.household_id = ${householdId}
        `);
        await db.execute(sql`
          DELETE FROM transactions t
          USING entries e JOIN accounts a ON a.id = e.account_id
          WHERE t.entry_id = e.id AND a.household_id = ${householdId}
        `);
        await db.execute(sql`
          DELETE FROM entries e
          USING accounts a
          WHERE e.account_id = a.id AND a.household_id = ${householdId}
        `);
        await db.execute(sql`
          DELETE FROM balances b USING accounts a
          WHERE b.account_id = a.id AND a.household_id = ${householdId}
        `);
        await db.execute(sql`DELETE FROM rollups WHERE household_id = ${householdId}`);
        await db.execute(sql`DELETE FROM categories WHERE household_id = ${householdId}`);
        await db.execute(sql`DELETE FROM accounts WHERE household_id = ${householdId}`);
        await db.execute(sql`DELETE FROM households WHERE id = ${householdId}`);
        console.log(`✓ cleaned up household ${householdId}`);
      } catch (cleanupErr) {
        console.error("Cleanup error (non-fatal):", cleanupErr);
      }
    }
    await pool.end();
  }
}

run().catch((err) => {
  console.error("ACCEPTANCE FAILED:", err);
  process.exit(1);
});
