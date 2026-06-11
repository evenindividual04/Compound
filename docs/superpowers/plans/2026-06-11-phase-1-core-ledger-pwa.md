# Phase 1: Core Ledger + PWA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, installable mobile-first PWA where Anmol can log an expense in ≤3 taps, import a full bank statement with zero silent drops, sweep a review inbox daily, and see a hero-number dashboard — before his first Sarvam paycheck.

**Architecture:** Immutable `entries` ledger (transaction | trade | valuation subtypes) with all derived state (balances, rollups) as pure recomputation from opening anchors. Single-entry + transfer-link pairs. All writes go through one validated write path that appends to an audit log. A nightly invariant cron buys back double-entry safety. Spec: `docs/superpowers/specs/2026-06-11-personal-finance-system-design.md` — §4.3's eight invariants are NON-NEGOTIABLE.

**Tech Stack:** Next.js (App Router, RSC) · TypeScript · Neon Postgres (Mumbai `ap-south-1`, else Singapore) · Drizzle ORM (numeric as **string**, always) · Better Auth (Google OAuth + single-user allowlist) · Tailwind v4 + shadcn/ui + Recharts · decimal.js-light · Vitest · pnpm · Vercel (crons via `vercel.ts`).

**Conventions locked for every task:**
- **Sign convention (ADR-1):** `entries.amount` is the signed delta to *that account's own balance*. Asset accounts: positive balance = you have money. Liability accounts (credit_card, loan): balance is **negative**; a card purchase is a **negative** amount (more owed), a card payment leg is **positive**. Net worth = `SUM(balance)` over included accounts. One function computes it; nothing else re-derives signs.
- **Anchors never override (ADR-2):** balances are strictly `opening + Σ entries`. Saving a reconciliation valuation computes the gap vs the derived balance and **materializes a pending adjustment transaction** for the difference (EPF interest, cash drift, loan interest). The invariant cron then asserts every anchor matches the derived balance.
- **Money never touches `Number()`** — Drizzle numeric mode `'string'`; arithmetic only via `lib/money.ts`.
- Every `pnpm vitest run` must be green before every commit. Commit messages: conventional commits, no attribution footer.

**Before writing any code:** this workspace pins a Next.js version whose conventions may differ from your training data. After Task 1 installs dependencies, **read `node_modules/next/dist/docs/`** (per repo AGENTS.md — to be created in Task 1) for routing/server-action/caching conventions, and follow what you read over what you remember.

---

## File structure (target state at end of Phase 1)

```
fin/
├── AGENTS.md                       # Next.js docs warning (mirrors pfolio's)
├── vercel.ts                       # crons: nightly invariants
├── drizzle.config.ts
├── .github/workflows/backup.yml    # nightly encrypted pg_dump
├── src/
│   ├── env.ts                      # zod-validated env (fails fast)
│   ├── middleware.ts               # auth + single-user allowlist
│   ├── db/
│   │   ├── index.ts                # neon + drizzle client
│   │   ├── schema/
│   │   │   ├── core.ts             # households, users, accounts, categories, tags
│   │   │   ├── ledger.ts           # entries, transactions, splits, valuations, transfers, entry_events
│   │   │   ├── ops.ts              # imports, import_rows, rules, budget_allocations, ledger_anomalies
│   │   │   └── index.ts            # re-exports
│   │   └── seed.ts                 # India-native category taxonomy
│   ├── lib/
│   │   ├── money.ts                # decimal ops + formatINR/formatINRCompact
│   │   ├── ledger/
│   │   │   ├── write.ts            # createTransaction/createValuation/annotate/softDelete
│   │   │   ├── dedup.ts            # import_hash with occurrence ordinal
│   │   │   ├── transfers.ts        # auto-match + confirm/reject
│   │   │   ├── derive.ts           # rebuildBalances, rebuildRollups, netWorth
│   │   │   ├── rules.ts            # rule evaluation + apply
│   │   │   └── invariants.ts       # nightly checks → ledger_anomalies
│   │   └── import/
│   │       ├── parse.ts            # CSV/XLS → raw rows
│   │       ├── mapping.ts          # column-role mapping + saved configs
│   │       ├── validate.ts         # balance-continuity checksum
│   │       └── pipeline.ts         # stage → preview → commit → undo
│   ├── app/
│   │   ├── api/auth/[...all]/route.ts
│   │   ├── api/cron/invariants/route.ts
│   │   ├── login/page.tsx
│   │   └── (app)/                  # authed shell: bottom nav + FAB
│   │       ├── layout.tsx
│   │       ├── page.tsx            # dashboard (hero number)
│   │       ├── inbox/page.tsx
│   │       ├── transactions/page.tsx
│   │       ├── accounts/…          # list/new/detail incl. valuation entry
│   │       ├── import/…            # upload → map → preview → commit
│   │       ├── budgets/page.tsx
│   │       └── settings/rules/page.tsx
│   └── components/                 # quick-entry sheet, txn row, metric card, …
└── docs/…                          # spec + this plan
```

Module boundaries: `lib/ledger/*` and `lib/money.ts` are pure (no Next.js imports) and fully unit-tested; `app/` calls them through server actions only. Nothing in `app/` touches `db` directly except via `lib`.

---

### Task 1: Scaffold, tooling, env validation

**Files:** Create: app scaffold, `src/env.ts`, `vitest.config.ts`, `AGENTS.md`. Modify: `package.json`, `.gitignore`.

- [ ] **Step 1: Scaffold** (run inside `/Users/anmolsen/Developer/fin`; the repo already has `docs/` + `.git`)

```bash
pnpm create next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack
pnpm add drizzle-orm @neondatabase/serverless better-auth decimal.js-light zod @t3-oss/env-nextjs date-fns papaparse exceljs nanoid
pnpm add -D drizzle-kit vitest @vitest/coverage-v8 @types/papaparse dotenv-cli
```

Expected: scaffold completes; `pnpm dev` serves the starter page.

- [ ] **Step 2: Read the local Next.js docs** — skim `node_modules/next/dist/docs/` for: server actions, route handlers, caching/revalidation, middleware. Note any deviation from your prior knowledge in a scratch comment in the PR description (not the code).

- [ ] **Step 3: Create `AGENTS.md`** (repo root):

```markdown
# This is NOT the Next.js you know
APIs and conventions may differ from training data. Read `node_modules/next/dist/docs/` before writing code. Money rules: amounts are NUMERIC strings end-to-end — never `Number()` a money value; use `src/lib/money.ts`. Sign convention and ledger invariants: see docs/superpowers/specs/2026-06-11-personal-finance-system-design.md §4.3.
```

- [ ] **Step 4: `src/env.ts`** — fail-fast env validation:

```ts
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    OWNER_EMAIL: z.string().email(), // single-user allowlist
    CRON_SECRET: z.string().min(16),
  },
  client: {},
  experimental__runtimeEnv: {},
});
```

- [ ] **Step 5: `vitest.config.ts`:**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

Add scripts to `package.json`: `"test": "vitest run"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "dotenv -e .env.local -- drizzle-kit migrate"`.

- [ ] **Step 6:** Append to `.gitignore`: `.env*` already present from Task 0 — verify; add `coverage/`.
- [ ] **Step 7:** `pnpm test` → "no test files found" is OK (exit 0 with passWithNoTests? add `passWithNoTests: true` to vitest config). `pnpm build` → succeeds.
- [ ] **Step 8: Commit** — `chore: scaffold next app with tooling and env validation`

### Task 2: Money module

**Files:** Create: `src/lib/money.ts`, `src/lib/money.test.ts`.

- [ ] **Step 1: Failing tests first:**

```ts
import { describe, it, expect } from "vitest";
import { add, sub, neg, cmp, isZero, formatINR, formatINRCompact, allocate } from "./money";

describe("money arithmetic (strings in, strings out)", () => {
  it("adds without float error", () => expect(add("0.1", "0.2")).toBe("0.3000"));
  it("subtracts into negatives", () => expect(sub("100.00", "150.25")).toBe("-50.2500"));
  it("negates", () => expect(neg("45000.0000")).toBe("-45000.0000"));
  it("compares", () => { expect(cmp("2.00", "10.00")).toBe(-1); expect(isZero("0.0000")).toBe(true); });
});
describe("formatINR (en-IN, lakh/crore)", () => {
  it("groups 3-2-2", () => expect(formatINR("123456.78")).toBe("₹1,23,456.78"));
  it("drops paise ≥ ₹1,000", () => expect(formatINR("1234.56")).toBe("₹1,235"));
  it("keeps paise < ₹1,000", () => expect(formatINR("342.50")).toBe("₹342.50"));
  it("compact lakh", () => expect(formatINRCompact("234500")).toBe("₹2.3L"));
  it("compact crore", () => expect(formatINRCompact("12300000")).toBe("₹1.2Cr"));
  it("negative", () => expect(formatINR("-5000")).toBe("−₹5,000"));
});
describe("allocate (largest remainder — splits always sum exactly)", () => {
  it("splits 100 three ways with no lost paisa", () => {
    const parts = allocate("100.00", 3);
    expect(parts).toEqual(["33.3400", "33.3300", "33.3300"]);
    expect(parts.reduce((a, b) => add(a, b))).toBe("100.0000");
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/lib/money.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** with `decimal.js-light` (4dp canonical storage scale; explicit lakh/crore fallback rather than trusting `notation:'compact'` across runtimes):

```ts
import Decimal from "decimal.js-light";
Decimal.set({ precision: 38 });
const D = (v: string) => new Decimal(v);
const out = (d: Decimal) => d.toFixed(4);

export const add = (a: string, b: string) => out(D(a).plus(b));
export const sub = (a: string, b: string) => out(D(a).minus(b));
export const neg = (a: string) => out(D(a).negated());
export const mul = (a: string, b: string) => out(D(a).times(b));
export const cmp = (a: string, b: string) => D(a).comparedTo(b) as -1 | 0 | 1;
export const isZero = (a: string) => D(a).isZero();
export const abs = (a: string) => out(D(a).abs());

const inr = (min: number, max: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: min, maximumFractionDigits: max });

export function formatINR(amount: string): string {
  const d = D(amount); const a = d.abs();
  const s = a.greaterThanOrEqualTo(1000) ? inr(0, 0).format(a.toNumber()) : inr(2, 2).format(a.toNumber());
  return d.isNegative() ? `−${s}` : s; // typographic minus, Number() OK here: display only, post-abs
}
export function formatINRCompact(amount: string): string {
  const d = D(amount); const a = d.abs(); let s: string;
  if (a.gte(1e7)) s = `₹${a.div(1e7).toFixed(1)}Cr`;
  else if (a.gte(1e5)) s = `₹${a.div(1e5).toFixed(1)}L`;
  else if (a.gte(1e3)) s = `₹${a.div(1e3).toFixed(1)}k`;
  else s = inr(0, 2).format(a.toNumber());
  return d.isNegative() ? `−${s}` : s;
}
export function allocate(total: string, n: number): string[] {
  const base = D(total).div(n).toDecimalPlaces(4, Decimal.ROUND_FLOOR);
  const parts = Array(n).fill(out(base));
  const remainder = D(total).minus(base.times(n));
  if (!remainder.isZero()) parts[0] = out(base.plus(remainder)); // largest-remainder to first part
  return parts;
}
```

(If `inr().format` output disagrees with the expected strings on this Node version, fix the **test expectations** to the actual `en-IN` output — grouping must be 3-2-2 — and note it.)

- [ ] **Step 4:** `pnpm vitest run src/lib/money.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat: money module with en-IN formatting and exact allocation`

### Task 3: DB client + core schema + seed taxonomy

**Files:** Create: `drizzle.config.ts`, `src/db/index.ts`, `src/db/schema/core.ts`, `src/db/schema/index.ts`, `src/db/seed.ts`.

- [ ] **Step 1:** Create the Neon project manually (dashboard): region Mumbai `aws-ap-south-1` if offered, else Singapore. Put pooled connection string in `.env.local` as `DATABASE_URL`. Also create a `dev` branch and use its string locally; production uses `main`.

- [ ] **Step 2: `drizzle.config.ts`:**

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/db/schema/index.ts", out: "./drizzle",
  dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 3: `src/db/index.ts`:**

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/env";
import * as schema from "./schema";
export const db = drizzle(neon(env.DATABASE_URL), { schema });
```

- [ ] **Step 4: `src/db/schema/core.ts`** — note `numeric` columns use `{ mode: "string" }` ALWAYS:

```ts
import { pgTable, uuid, text, boolean, date, timestamp, numeric, pgEnum, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const accountKind = pgEnum("account_kind", ["bank","cash","credit_card","loan","investment","epf","ppf","fd","property","gold","crypto","wallet","receivable","other_asset","other_liability"]);
export const LIABILITY_KINDS = ["credit_card","loan","other_liability"] as const;

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const users = pgTable("users", { // Better Auth manages its own tables; this maps auth user → household
  id: text("id").primaryKey(),          // better-auth user id
  householdId: uuid("household_id").notNull().references(() => households.id),
  email: text("email").notNull().unique(),
});
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id),
  name: text("name").notNull(),
  kind: accountKind("kind").notNull(),
  currency: text("currency").notNull().default("INR"),
  status: text("status", { enum: ["active","closed"] }).notNull().default("active"),
  excluded: boolean("excluded").notNull().default(false),
  openingDate: date("opening_date"),
  openingBalance: numeric("opening_balance", { precision: 19, scale: 4, mode: "string" }).notNull().default("0"),
  metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  classification: text("classification", { enum: ["income","expense"] }).notNull().default("expense"),
  system: text("system"), // 'adjustment' | 'transfer' | null — reserved, not user-deletable
}, (t) => [uniqueIndex("categories_hh_name").on(t.householdId, t.parentId, t.name)]);
export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id),
  name: text("name").notNull(),
}, (t) => [uniqueIndex("tags_hh_name").on(t.householdId, t.name)]);
```

- [ ] **Step 5: `src/db/seed.ts`** — idempotent seed: one household ("Anmol"), category groups → leaves (India-native; from spec §4.4): Food & Dining, Groceries, Transport (Fuel, Auto/Cab, Metro), Rent & Maintenance, Domestic Help, Utilities (Electricity, Mobile/Broadband, Gas), EMI & Interest, Insurance, Health, Education, Festivals & Gifts, Donations, Subscriptions, Shopping, Travel, Personal Care, Taxes & Charges, **Adjustment (system='adjustment')**; Income group: Salary, Interest, Dividends, Cashback, Refunds, Other Income. Tags: `80C`, `80D`, `80E`, `80G`, `reimbursable`. Run with `pnpm dotenv -e .env.local -- tsx src/db/seed.ts` (add `tsx` dev dep).

- [ ] **Step 6:** `pnpm db:generate && pnpm db:migrate` → tables created. Run seed twice → second run inserts nothing (idempotent).
- [ ] **Step 7: Commit** — `feat: db client, core schema, india-native category seed`

### Task 4: Ledger schema with hardened constraints

**Files:** Create: `src/db/schema/ledger.ts`, `src/db/schema/ops.ts`; custom SQL migration.

- [ ] **Step 1: `ledger.ts`:**

```ts
import { pgTable, uuid, text, date, timestamp, numeric, pgEnum, jsonb, boolean, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { accounts, categories } from "./core";

export const entryType = pgEnum("entry_type", ["transaction","trade","valuation"]);
export const entryStatus = pgEnum("entry_status", ["pending","posted","reconciled"]);

export const entries = pgTable("entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  entryType: entryType("entry_type").notNull(),
  date: date("date").notNull(),
  amount: numeric("amount", { precision: 19, scale: 4, mode: "string" }).notNull(),
  currency: text("currency").notNull().default("INR"),
  description: text("description").notNull().default(""),
  status: entryStatus("status").notNull().default("posted"),
  externalId: text("external_id"),
  importId: uuid("import_id"),
  importHash: text("import_hash"),
  source: text("source", { enum: ["manual","import","system"] }).notNull().default("manual"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("entries_account_date").on(t.accountId, t.date),
  // partial uniques live in the custom SQL migration (Step 3)
]);

export const transactions = pgTable("transactions", {
  entryId: uuid("entry_id").primaryKey().references(() => entries.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => categories.id),
  merchant: text("merchant"),
  categoryLocked: boolean("category_locked").notNull().default(false), // typed lock, not jsonb
  isAdjustment: boolean("is_adjustment").notNull().default(false),
});
export const transactionSplits = pgTable("transaction_splits", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").notNull().references(() => entries.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => categories.id),
  amount: numeric("amount", { precision: 19, scale: 4, mode: "string" }).notNull(),
  note: text("note"),
});
export const valuations = pgTable("valuations", {
  entryId: uuid("entry_id").primaryKey().references(() => entries.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["opening_anchor","reconciliation","appraisal"] }).notNull().default("reconciliation"),
});
export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  outflowEntryId: uuid("outflow_entry_id").notNull().unique().references(() => entries.id, { onDelete: "restrict" }),
  inflowEntryId: uuid("inflow_entry_id").notNull().unique().references(() => entries.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["pending","confirmed"] }).notNull().default("pending"),
});
export const rejectedTransfers = pgTable("rejected_transfers", {
  outflowEntryId: uuid("outflow_entry_id").notNull(),
  inflowEntryId: uuid("inflow_entry_id").notNull(),
}, (t) => [uniqueIndex("rejected_pair").on(t.outflowEntryId, t.inflowEntryId)]);
export const entryEvents = pgTable("entry_events", { // append-only audit
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").notNull(),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  source: text("source").notNull(), // 'user' | 'rule:<id>' | 'import:<id>' | 'system'
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
export const entryTags = pgTable("entry_tags", {
  entryId: uuid("entry_id").notNull().references(() => entries.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull(),
}, (t) => [uniqueIndex("entry_tag_pair").on(t.entryId, t.tagId)]);

// derived caches (rebuildable)
export const balances = pgTable("balances", {
  accountId: uuid("account_id").notNull(),
  date: date("date").notNull(),
  balance: numeric("balance", { precision: 19, scale: 4, mode: "string" }).notNull(),
}, (t) => [uniqueIndex("balances_pk").on(t.accountId, t.date)]);
export const rollups = pgTable("rollups", {
  householdId: uuid("household_id").notNull(),
  month: date("month").notNull(),
  categoryId: uuid("category_id"),
  amount: numeric("amount", { precision: 19, scale: 4, mode: "string" }).notNull(),
}, (t) => [uniqueIndex("rollups_pk").on(t.householdId, t.month, t.categoryId)]);
```

- [ ] **Step 2: `ops.ts`:**

```ts
import { pgTable, uuid, text, timestamp, integer, jsonb, numeric, date, boolean, uniqueIndex } from "drizzle-orm/pg-core";
export const imports = pgTable("imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  accountId: uuid("account_id").notNull(),
  filename: text("filename").notNull(),
  status: text("status", { enum: ["parsing","staged","committed","undone","failed"] }).notNull().default("parsing"),
  stats: jsonb("stats").$type<{ total: number; new: number; duplicates: number; suspicious: number }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const importRows = pgTable("import_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  raw: jsonb("raw").notNull(),
  parsed: jsonb("parsed").$type<{ date: string; amount: string; description: string; externalId?: string; balance?: string }>(),
  verdict: text("verdict", { enum: ["new","duplicate","suspicious"] }),
  entryId: uuid("entry_id"),
});
export const importConfigs = pgTable("import_configs", { // saved column mappings per account
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().unique(),
  mapping: jsonb("mapping").notNull(), // ColumnMapping (Task 13)
});
export const rules = pgTable("rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(0),
  active: boolean("active").notNull().default(true),
  matchMode: text("match_mode", { enum: ["all","any"] }).notNull().default("all"),
  conditions: jsonb("conditions").$type<{ field: "description"|"merchant"|"amount"; op: "contains"|"equals"|"gt"|"lt"; value: string }[]>().notNull(),
  actions: jsonb("actions").$type<{ type: "set_category"|"set_merchant"|"add_tag"; value: string }[]>().notNull(),
});
export const budgetAllocations = pgTable("budget_allocations", {
  householdId: uuid("household_id").notNull(),
  month: date("month").notNull(),
  categoryId: uuid("category_id").notNull(),
  assigned: numeric("assigned", { precision: 19, scale: 4, mode: "string" }).notNull().default("0"),
}, (t) => [uniqueIndex("budget_pk").on(t.householdId, t.month, t.categoryId)]);
export const ledgerAnomalies = pgTable("ledger_anomalies", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  detail: jsonb("detail").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});
```

- [ ] **Step 3: Custom SQL migration** (`pnpm db:generate` then create `drizzle/00XX_hardening.sql` and register it, or append a second migration with `drizzle-kit generate --custom`):

```sql
-- partial uniques: dedup must ignore tombstones, include amount+sign (spec §4.3.1)
CREATE UNIQUE INDEX entries_external_unique ON entries (account_id, external_id, amount)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX entries_hash_unique ON entries (account_id, import_hash)
  WHERE import_hash IS NOT NULL AND deleted_at IS NULL;
-- transfer legs: different accounts, same currency legs net to zero, no soft-deleted legs (deferred, checked at COMMIT)
CREATE OR REPLACE FUNCTION check_transfer() RETURNS trigger AS $$
DECLARE o entries%ROWTYPE; i entries%ROWTYPE;
BEGIN
  SELECT * INTO o FROM entries WHERE id = NEW.outflow_entry_id;
  SELECT * INTO i FROM entries WHERE id = NEW.inflow_entry_id;
  IF o.account_id = i.account_id THEN RAISE EXCEPTION 'transfer legs on same account'; END IF;
  IF o.deleted_at IS NOT NULL OR i.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'transfer leg deleted'; END IF;
  IF o.currency = i.currency AND o.amount + i.amount <> 0 THEN RAISE EXCEPTION 'transfer legs do not net to zero'; END IF;
  IF o.amount >= 0 OR i.amount <= 0 THEN RAISE EXCEPTION 'outflow must be negative, inflow positive'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER transfer_integrity AFTER INSERT OR UPDATE ON transfers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer();
-- splits XOR parent category + exact sum (deferred)
CREATE OR REPLACE FUNCTION check_splits() RETURNS trigger AS $$
DECLARE parent_amount numeric; split_sum numeric; parent_cat uuid; eid uuid;
BEGIN
  eid := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT e.amount, t.category_id INTO parent_amount, parent_cat FROM entries e JOIN transactions t ON t.entry_id = e.id WHERE e.id = eid;
  SELECT COALESCE(SUM(amount), 0) INTO split_sum FROM transaction_splits WHERE entry_id = eid;
  IF split_sum <> 0 AND split_sum <> parent_amount THEN RAISE EXCEPTION 'splits must sum to entry amount'; END IF;
  IF split_sum <> 0 AND parent_cat IS NOT NULL THEN RAISE EXCEPTION 'split parent must have null category'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER splits_integrity AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_splits();
-- reconciled entries: financial core is frozen
CREATE OR REPLACE FUNCTION freeze_reconciled() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'reconciled' AND (NEW.amount <> OLD.amount OR NEW.date <> OLD.date OR NEW.account_id <> OLD.account_id) THEN
    RAISE EXCEPTION 'cannot modify financial core of reconciled entry';
  END IF; RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reconciled_freeze BEFORE UPDATE ON entries FOR EACH ROW EXECUTE FUNCTION freeze_reconciled();
```

- [ ] **Step 4:** `pnpm db:migrate`. Then verify in `psql`/Neon console: insert a transfer with legs `-100`/`+90` inside a transaction → COMMIT fails with "do not net to zero".
- [ ] **Step 5: Commit** — `feat: ledger schema with dedup/transfer/split/freeze constraints`

### Task 5: Ledger write path + audit log

**Files:** Create: `src/lib/ledger/write.ts`, `src/lib/ledger/write.test.ts`, `src/lib/ledger/test-db.ts`.

Tests for lib/ledger run against a real Postgres (Neon `test` branch or local docker). `test-db.ts` exports a drizzle client from `TEST_DATABASE_URL` and a `resetDb()` truncating all tables; skip suite if env missing: `describe.skipIf(!process.env.TEST_DATABASE_URL)`.

- [ ] **Step 1: Failing tests:**

```ts
// write.test.ts (excerpts — full file covers each case)
it("createTransaction writes entry + subtype and logs entry_event", async () => {
  const id = await createTransaction(db, { accountId: bank, date: "2026-07-01", amount: "-342.00", description: "Swiggy", categoryId: food, source: "manual" });
  const ev = await db.select().from(entryEvents).where(eq(entryEvents.entryId, id));
  expect(ev.map(e => e.field)).toContain("created");
});
it("annotate respects categoryLocked", async () => {
  await annotate(db, id, { categoryId: groceries }, "user");           // user sets → locks
  await annotate(db, id, { categoryId: food }, "rule:abc");            // rule tries to overwrite
  const txn = await getTransaction(db, id);
  expect(txn.categoryId).toBe(groceries);                              // user wins
});
it("createValuation materializes pending adjustment for the gap (ADR-2)", async () => {
  // EPF: opening 0, contributions +10000 ×2, passbook says 28000 → adjustment +8000 pending
  await createTransaction(db, { accountId: epf, date: "2026-04-01", amount: "10000", ... });
  await createTransaction(db, { accountId: epf, date: "2026-05-01", amount: "10000", ... });
  const { adjustmentEntryId } = await createValuation(db, { accountId: epf, date: "2026-06-01", amount: "28000.0000", kind: "reconciliation" });
  const adj = await getEntry(db, adjustmentEntryId!);
  expect(adj.amount).toBe("8000.0000"); expect(adj.status).toBe("pending"); expect(adj.source).toBe("system");
});
it("createValuation on liability accepts negative anchor (CC outstanding)", async () => {
  // card has -45000 of purchases; bank reports outstanding 45000 → caller negates → anchor -45000 → gap 0, no adjustment
  const { adjustmentEntryId } = await createValuation(db, { accountId: card, date: "2026-07-31", amount: "-45000.0000", kind: "reconciliation" });
  expect(adjustmentEntryId).toBeNull();
});
it("softDelete refuses to delete a confirmed transfer leg", async () => {
  await expect(softDelete(db, outflowId, "user")).rejects.toThrow(/transfer/);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement `write.ts`:** `createTransaction` (insert entry + transactions row + `entry_events('created')`, validating amount ≠ 0, category classification vs sign where category provided — expense ⇒ amount < 0 on asset and liability alike per ADR-1, income ⇒ amount > 0); `annotate(db, entryId, patch, source)` — when source is `user` set `categoryLocked=true`; when source starts with `rule:`/`import:` and `categoryLocked`, no-op; every applied change appends an `entry_events` row with old/new. `createValuation` — derives current balance via `computeBalanceAt` (imported from `derive.ts` in Task 7; for now implement a local `opening + SUM(entries)` SQL inline and swap in Task 7), computes `gap = anchorAmount − derived`; if nonzero, inserts a **pending** adjustment transaction (`isAdjustment: true`, system Adjustment category, `source:'system'`) dated the anchor date, then inserts the valuation entry itself (valuation entries carry `amount` = anchor value but are **excluded from balance summation** — only `transaction|trade` sum; enforce by filtering `entryType` in every SUM). `softDelete` — refuse if entry is a leg of a `confirmed` transfer; set `deletedAt`, log event.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat: validated ledger write path with audit log and anchor adjustments`

### Task 6: Dedup module

**Files:** Create: `src/lib/ledger/dedup.ts`, `src/lib/ledger/dedup.test.ts`.

- [ ] **Step 1: Failing tests:**

```ts
it("three identical same-day chai payments get distinct hashes", () => {
  const rows = [
    { date: "2026-07-02", amount: "-20.00", description: "UPI-CHAIWALA" },
    { date: "2026-07-02", amount: "-20.00", description: "UPI-CHAIWALA" },
    { date: "2026-07-02", amount: "-20.00", description: "UPI-CHAIWALA" },
  ];
  const hashes = withOccurrenceHashes(accountId, rows).map(r => r.importHash);
  expect(new Set(hashes).size).toBe(3);
});
it("same logical row across two imports of overlapping statements collides (= duplicate detected)", () => {
  const a = withOccurrenceHashes(accountId, [{ date: "2026-07-02", amount: "-20.00", description: "UPI-CHAIWALA" }]);
  const b = withOccurrenceHashes(accountId, [{ date: "2026-07-02", amount: "-20.00", description: "UPI-CHAIWALA" }]);
  expect(a[0].importHash).toBe(b[0].importHash);
});
it("normalization: case/whitespace/ref-noise insensitive", () => {
  expect(normalizeDescription("  UPI/512345/Swiggy  Bangalore ")).toBe(normalizeDescription("upi/512345/SWIGGY BANGALORE"));
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement:** `normalizeDescription` (lowercase, collapse whitespace, strip trailing reference numbers ≥6 digits); `withOccurrenceHashes(accountId, rows)` — group rows by `(date, amount, normalized)`, assign occurrence index **within the group in file order**, hash `sha256(accountId|date|amount|normalized|occurrence)` via `node:crypto`. Deterministic from file content alone (sync-safe — no server counters).
- [ ] **Step 4:** PASS. **Step 5: Commit** — `feat: occurrence-aware import dedup hashing`

### Task 7: Derivation engine — balances

**Files:** Create: `src/lib/ledger/derive.ts`, `src/lib/ledger/derive.test.ts`. Modify: `src/lib/ledger/write.ts` (swap inline balance query for `computeBalanceAt`).

- [ ] **Step 1: Failing tests** (the adversarial-review scenarios, against test DB):

```ts
it("balance = opening + Σ entries; valuations and pending excluded", async () => { /* bank: opening 1000, -342 posted, +500 pending → balanceAt = 658 */ });
it("liability runs negative; CC purchase decreases, payment increases", async () => { /* card: -4500 purchase, +4500 payment leg → 0 */ });
it("rebuildBalances writes a contiguous daily series with LOCF gaps", async () => {
  /* entries on 1st and 4th → rows for 1,2,3,4 with 2-3 carrying day-1 balance */ });
it("backdated entry invalidates from its date forward", async () => {
  /* series built to day 10; insert entry on day 3; rebuildBalances(account, day3) → days 3-10 changed, 1-2 untouched */ });
it("rebuild is idempotent: running twice produces identical rows", async () => { ... });
it("netWorth sums included accounts only, assets minus liabilities by sign", async () => {
  /* bank 658 + epf 28000 + card -45000, one excluded account ignored → "-16342.0000" */ });
```

- [ ] **Step 2:** FAIL. **Step 3: Implement `derive.ts`:**

```ts
export async function computeBalanceAt(db: Db, accountId: string, date: string): Promise<string> {
  // opening_balance + SUM(amount) over entries WHERE entry_type IN ('transaction','trade')
  // AND status <> 'pending' AND deleted_at IS NULL AND date <= $date  — one SQL statement, numeric arithmetic in Postgres
}
export async function rebuildBalances(db: Db, accountId: string, fromDate: string): Promise<void> {
  // 1) acquire per-account lock: SELECT pg_advisory_xact_lock(hashtext(accountId)) inside the transaction
  //    (neon-http is single-statement; use db.transaction with the websocket driver OR serialize via
  //     UPDATE accounts SET id=id WHERE id=$1 row lock — choose based on what the driver supports, document choice)
  // 2) start = computeBalanceAt(accountId, dayBefore(fromDate))
  // 3) walk dates fromDate..today: balance += Σ that day's entries (LOCF when none); upsert into balances
  // 4) DELETE balances rows for this account with date > today (paranoia)
}
export async function netWorth(db: Db, householdId: string, date: string): Promise<string> {
  // Σ computeBalanceAt over active, non-excluded accounts — single SQL with GROUP BY, summed in Postgres
}
```

All SUMs happen in Postgres (`numeric` math), returned as strings. Never map rows through `Number()`.

- [ ] **Step 4:** PASS, including: re-run the Task 5 valuation test — `createValuation` now uses `computeBalanceAt`.
- [ ] **Step 5: Commit** — `feat: pure balance derivation with LOCF series and net worth`

### Task 8: Derivation engine — monthly rollups

**Files:** Modify: `src/lib/ledger/derive.ts`, `src/lib/ledger/derive.test.ts`.

- [ ] **Step 1: Failing tests:** transfer-linked entries excluded from rollups; splits roll up by split category (parent ignored); `rebuildRollups(householdId, fromMonth)` recomputes all months ≥ fromMonth and is idempotent; adjustment entries included (they're real money) under Adjustment category.
- [ ] **Step 2:** FAIL. **Step 3: Implement:** one SQL per month: `SELECT category, SUM(...)` over non-deleted, non-pending transactions LEFT JOIN splits (use split rows when present), excluding entries referenced by `transfers`. DELETE+INSERT the month's rollup rows in a transaction. Add `afterWrite(db, entry)` helper: `rebuildBalances(account, entry.date)` + `rebuildRollups(household, monthOf(entry.date))` — every server action calls this; no incremental accumulators anywhere.
- [ ] **Step 4:** PASS. **Step 5: Commit** — `feat: recompute-style monthly rollups excluding transfers`

### Task 9: Invariant checker + cron

**Files:** Create: `src/lib/ledger/invariants.ts`, `src/lib/ledger/invariants.test.ts`, `src/app/api/cron/invariants/route.ts`, `vercel.ts`.

- [ ] **Step 1: Failing tests:** seed violations directly with raw SQL (bypassing write path) and assert `runInvariantChecks` records: `orphan_transfer_leg` (soft-deleted leg), `transfer_imbalance`, `split_mismatch`, `anchor_residual` (valuation ≠ derived balance at that date beyond 0.01 tolerance), `unbalanced_sign` (expense-classified category on positive amount), `stale_series` (balances row ≠ recomputed). Resolved anomalies (`resolvedAt`) don't re-insert dupes (upsert by kind+detail hash).
- [ ] **Step 2:** FAIL. **Step 3: Implement** — ~6 SQL checks inserting into `ledgerAnomalies`. Route handler: verify `Authorization: Bearer ${env.CRON_SECRET}`, run checks, return counts JSON. `vercel.ts`:

```ts
import type { VercelConfig } from "@vercel/config/v1";
export const config: VercelConfig = { crons: [{ path: "/api/cron/invariants", schedule: "30 21 * * *" }] }; // 03:00 IST
```

- [ ] **Step 4:** PASS. **Step 5: Commit** — `feat: nightly ledger invariant checks`

### Task 10: Transfer auto-matching

**Files:** Create: `src/lib/ledger/transfers.ts`, `src/lib/ledger/transfers.test.ts`.

- [ ] **Step 1: Failing tests:** `-5000` bank / `+5000` cash within 2 days → proposes pending transfer; pair in `rejected_transfers` never re-proposed; already-linked entries skipped; equal-amount same-account pair NOT proposed; `confirmTransfer` flips status + logs events; `rejectTransfer` deletes link + records rejected pair.
- [ ] **Step 2:** FAIL. **Step 3: Implement:** `proposeTransfers(db, householdId)` — SQL self-join: opposite amounts, `|dateA − dateB| ≤ 2`, different accounts, neither leg linked nor rejected; insert `transfers(status:'pending')`. Plus `confirmTransfer`/`rejectTransfer`.
- [ ] **Step 4:** PASS. **Step 5: Commit** — `feat: transfer auto-match with rejection memory`

### Task 11: Rules engine

**Files:** Create: `src/lib/ledger/rules.ts`, `src/lib/ledger/rules.test.ts`.

- [ ] **Step 1: Failing tests:** contains-match on description sets category; `matchMode any` vs `all`; priority order (first match wins per action type); locked category untouched; `applyRulesTo(db, entryIds, source)` writes through `annotate` (so events are logged with `source:'rule:<id>'`); amount conditions compare via `cmp` (money strings, not Number).
- [ ] **Step 2:** FAIL. **Step 3: Implement:** pure `evaluateRule(rule, txn): actions[]` + `applyRulesTo` orchestrator.
- [ ] **Step 4:** PASS. **Step 5: Commit** — `feat: ordered rules engine that respects user locks`

### Task 12: Auth — Better Auth + Google + allowlist

**Files:** Create: `src/lib/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `src/middleware.ts`, `src/app/login/page.tsx`, `src/lib/auth-client.ts`.

- [ ] **Step 1:** Configure Better Auth (check its current docs via the docs-lookup flow if APIs deviate): Drizzle adapter, Google social provider, `secret: env.BETTER_AUTH_SECRET`. **Database hook on sign-in: reject any email ≠ `env.OWNER_EMAIL`** (defense layer 1). Mount handler at `api/auth/[...all]`.
- [ ] **Step 2:** `src/middleware.ts` (defense layer 2): for all routes except `/login`, `/api/auth/*`, `/api/cron/*`, require a session cookie; fetch session; if `session.user.email !== env.OWNER_EMAIL` → 403. Set security headers here: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, CSP `frame-ancestors 'none'`.
- [ ] **Step 3:** Minimal `/login` page: one "Continue with Google" button via `auth-client`. On first successful login, upsert `users` row mapped to the seeded household.
- [ ] **Step 4: Unit test** the allowlist predicate (pure function `isAllowed(email)`); manual e2e: wrong Google account → 403; right one → dashboard shell.
- [ ] **Step 5: Commit** — `feat: better-auth google sign-in locked to owner allowlist`

(Passkey enrollment is a fast-follow within P1 if Better Auth's passkey plugin installs cleanly; if it fights, ship Google-only and file it for P2 — Google OAuth alone is acceptable v1 security given the allowlist.)

### Task 13: App shell + PWA + theming

**Files:** Create: `src/app/(app)/layout.tsx`, `public/manifest.webmanifest`, icons, `src/app/(app)/page.tsx` placeholder. Modify: `src/app/layout.tsx`, `src/app/globals.css`.

- [ ] **Step 1:** `pnpm dlx shadcn@latest init` (style: default, CSS variables, dark-first) then `pnpm dlx shadcn@latest add button card sheet input select badge tabs drawer dialog skeleton sonner`.
- [ ] **Step 2:** Root layout: `<html lang="en" className="dark">`, theme-color meta, manifest link, `font-variant-numeric: tabular-nums` utility class for all money. Manifest: name "Fin", display `standalone`, dark background, 192/512 icons (generate simple ₹ glyph icons).
- [ ] **Step 3:** `(app)/layout.tsx`: bottom nav (Home, Inbox + badge, Transactions, Budgets, More), center FAB for quick entry, safe-area padding. iOS install coach-mark component (shows once, localStorage-dismissed, only on iOS Safari non-standalone).
- [ ] **Step 4:** Verify: Lighthouse PWA installable on phone (or Chrome devtools emulation); dark renders; nav works.
- [ ] **Step 5: Commit** — `feat: installable pwa shell with bottom nav and dark-first theme`

### Task 14: Accounts UI + opening balances + valuation anchor form

**Files:** Create: `src/app/(app)/accounts/page.tsx`, `accounts/new/page.tsx`, `accounts/[id]/page.tsx`, `src/app/actions/accounts.ts`.

- [ ] **Step 1:** Server actions (`zod`-validated): `createAccount` (name, kind, opening balance + date — **liability kinds: UI asks "amount owed", action stores negative opening**), `closeAccount`, `setExcluded`, `addValuation` (UI asks "current balance/outstanding"; negates for liabilities; calls `createValuation`; surfaces "adjustment of ₹X created, review it in Inbox" toast when gap ≠ 0).
- [ ] **Step 2:** Accounts list grouped Assets/Liabilities with current balance (from `computeBalanceAt(today)`), net worth header line. Detail page: balance series placeholder, "Update balance" (valuation) button — this is how EPF/FD/edu-loan stay fresh in P1.
- [ ] **Step 3:** Create his real starter set manually after deploy: HDFC Savings, cash, EPF, edu loan, etc.
- [ ] **Step 4:** Manual verify + `pnpm test` green. **Step 5: Commit** — `feat: accounts crud with liability-aware valuations`

### Task 15: Quick entry (≤3 taps)

**Files:** Create: `src/components/quick-entry.tsx`, `src/app/actions/entries.ts`.

- [ ] **Step 1:** Server action `quickAdd({ accountId, amount, categoryId, description?, date })` → `createTransaction` (sign: expense category ⇒ negative; income ⇒ positive) → `afterWrite`.
- [ ] **Step 2:** FAB → shadcn `Drawer`: amount-first numeric keypad (big digits), then horizontally scrollable **recent-categories chips** (last 8 used, from rollups), default account = last used (localStorage), date defaults today with quick "yesterday" toggle. Tap flow: FAB → digits → category chip = saved (3 taps + digits). Optimistic toast; `router.refresh()`.
- [ ] **Step 3:** Offline outbox: wrap the action call — on network failure, queue `{payload, idempotencyKey}` in IndexedDB (`idb-keyval`, add dep) and register a `online` event listener + on-app-open replay that retries with the same idempotency key (action upserts by it). This is the P1-scope offline story (no offline reads beyond browser cache).
- [ ] **Step 4:** Manual verify incl. airplane-mode test. **Step 5: Commit** — `feat: 3-tap quick entry with offline outbox`

### Task 16: Transactions list + edit

**Files:** Create: `src/app/(app)/transactions/page.tsx`, `src/components/txn-row.tsx`, `src/components/category-picker.tsx`, edit drawer.

- [ ] **Step 1:** Month pager header (swipe/arrows, `?month=2026-07`). RSC fetch: entries for month (non-deleted), paginated 100/page, joined category + transfer flag. Money right-aligned tabular-nums, `formatINR`; income green, expense default, transfers shown with ⇄ and muted (excluded-from-spend affordance).
- [ ] **Step 2:** Tap row → drawer: edit category (locks it), description, tags, splits editor (uses `allocate` for even-split helper; saves through one server action that replaces split set atomically), soft-delete (blocked for confirmed transfer legs with explanatory toast), "make transfer" pairing flow (pick counterpart entry).
- [ ] **Step 3:** Manual verify; unit-test the split-set server action against test DB (sum enforcement round-trips the DB trigger).
- [ ] **Step 4: Commit** — `feat: monthly transactions list with split and transfer editing`

### Task 17: Review inbox

**Files:** Create: `src/app/(app)/inbox/page.tsx`, `src/components/inbox-item.tsx`, `src/app/actions/inbox.ts`.

- [ ] **Step 1:** Inbox = union, newest first: (a) `pending` transactions (imported + adjustments), (b) `pending` transfers to confirm. Badge count in bottom nav (RSC count, revalidated by `afterWrite`).
- [ ] **Step 2:** Item actions: **Accept** (suggested category from rules → sets posted), **Recategorize** (picker → posted + locked), **Confirm/Reject transfer**, bulk-select accept. Adjustments display origin ("Reconciliation gap on EPF anchor 2026-06-01"). Empty state: "All caught up ✓".
- [ ] **Step 3:** Server actions thin: `acceptEntry`, `recategorizeEntry`, `confirmTransfer`, `rejectTransfer` — all via lib functions + `afterWrite`.
- [ ] **Step 4:** Manual verify the full loop: quick-add pending? (no — manual entries post immediately); import path produces pending (Task 18); valuation adjustment lands here.
- [ ] **Step 5: Commit** — `feat: review inbox with accept/recategorize/transfer confirmation`

### Task 18: Import pipeline — parse + map + validate

**Files:** Create: `src/lib/import/parse.ts`, `mapping.ts`, `validate.ts` + tests; fixtures under `src/lib/import/__fixtures__/` (hand-make HDFC-style and ICICI-style CSV/XLS samples with fake data, incl. a deliberate balance-discontinuity row and a duplicate row).

- [ ] **Step 1: Failing tests:** `parseFile(buffer, filename)` → `{ headers, rows }` for CSV (papaparse) and XLSX (exceljs `workbook.xlsx.load`, first worksheet, header-row autodetect: first row where ≥3 cells non-empty; legacy `.xls` binaries: reject with "please export as CSV or XLSX" — exceljs is XLSX-only and the xlsx npm package is banned for unpatched CVEs); `applyMapping(rows, mapping)` with `ColumnMapping = { date: string; description: string; amount?: string; debit?: string; credit?: string; balance?: string; ref?: string; dateFormat: "dd/MM/yyyy" | "dd-MM-yyyy" | "yyyy-MM-dd" | "dd MMM yyyy" }` → normalized `{date, amount(signed: debit→negative), description, externalId?, balance?}` (amounts cleaned of `₹ , Cr Dr` noise as **strings**, `date-fns/parse`); `validateContinuity(rows)` → ok with rows in either statement order (detect direction by comparing balances), flags index of first row where `prevBalance + amount ≠ balance` (tolerance 0.01), skips when no balance column (returns `{checked:false}`).
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat: csv/xls statement parsing with mapping and continuity validation`

### Task 19: Import pipeline — stage, preview, commit, undo

**Files:** Create: `src/lib/import/pipeline.ts` + tests; `src/app/(app)/import/page.tsx` (+ steps UI), `src/app/actions/import.ts`.

- [ ] **Step 1: Failing tests (lib):** `stageImport` writes `imports` + `import_rows` with verdicts — duplicate = hash already live in `entries` OR (externalId, amount) live match; suspicious = continuity break or unparseable row; stats counted. `commitImport` inserts only `new` rows as **pending** transactions (`source:'import'`, importId stamped), runs `applyRulesTo`, runs `proposeTransfers`, `afterWrite` once per affected account+month batch; idempotent (second commit no-ops). `undoImport` soft-deletes the import's entries (refusing confirmed-transfer legs → those stay with anomaly note), marks import `undone`; **re-import after undo re-creates entries** (dedup ignores tombstones — partial index proves itself here, test it).
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3: UI flow** `/import`: (1) pick account + file upload (server action receives FormData), (2) mapping step — table preview of first 5 rows, dropdown per required role, prefilled from `import_configs` for that account, saved on continue, (3) preview — stat chips "23 new · 4 duplicates · 1 suspicious" + expandable row lists, suspicious rows shown with reason, (4) Commit → toast → Inbox badge jumps. History list at bottom with per-import Undo.
- [ ] **Step 4:** End-to-end manual run with both fixtures. **Step 5: Commit** — `feat: staged statement import with preview, commit, undo`

### Task 20: Budgets (simple monthly caps)

**Files:** Create: `src/app/(app)/budgets/page.tsx`, `src/app/actions/budgets.ts`.

- [ ] **Step 1:** Page: month pager; per expense category row: assigned (tap-to-edit input → upsert `budget_allocations`), spent (that month's rollup, abs), remaining = assigned − spent with progress bar (red when over). Header: total assigned vs total spent. Unbudgeted categories listed below with spend.
- [ ] **Step 2:** Server action `setAllocation(month, categoryId, assigned)` zod-validated; copy-last-month button.
- [ ] **Step 3:** Manual verify. **Step 4: Commit** — `feat: monthly category budgets`

### Task 21: Dashboard

**Files:** Create: `src/app/(app)/page.tsx`, `src/components/metric-card.tsx`, `src/components/spend-trend.tsx` (Recharts client island).

- [ ] **Step 1:** RSC composition, all aggregates from `rollups`/`balances` (no per-request entry scans): **Hero number = this month's spend** (`formatINR`, huge, with delta-vs-last-month badge). Needs-attention strip: inbox count chip, anomaly count chip (links), accounts-with-stale-anchors chip (EPF/FD/loan anchor > 60 days). Metric cards: Net worth (`formatINRCompact` + 30-day sparkline from balances), Budget left (Σ assigned − Σ spent), Top category this month. Recent 5 transactions → /transactions.
- [ ] **Step 2:** Sparkline + 6-month spend bar chart as small client components receiving pre-aggregated `{date, value}[]` props (values as numbers ONLY at the chart boundary, converted from strings in the RSC right before render — charts are display-only).
- [ ] **Step 3:** Manual verify <1s on phone (Network tab, Fast 4G). **Step 4: Commit** — `feat: hero-number dashboard with needs-attention strip`

### Task 22: Backups + deploy

**Files:** Create: `.github/workflows/backup.yml`, `docs/runbooks/restore.md`. Modify: Vercel project settings (manual).

- [ ] **Step 1:** `backup.yml` — nightly 22:00 UTC: postgres client + `pg_dump "$DATABASE_URL" -Fc`, encrypt `age -r $AGE_PUBLIC_KEY`, upload to Cloudflare R2 (`rclone` with R2 secrets), prune > 30 days. Secrets: `DATABASE_URL` (direct, non-pooled), `AGE_PUBLIC_KEY`, R2 creds.
- [ ] **Step 2:** `docs/runbooks/restore.md`: exact `age -d | pg_restore` commands; **perform one real test restore into a scratch Neon branch and record the date in the runbook.**
- [ ] **Step 3:** Deploy: `vercel` link → set env vars (`vercel env add` each from Task 1's list) → production deploy → set `BETTER_AUTH_URL` to prod URL, update Google OAuth redirect URIs. Verify: login from phone, install PWA, cron registered (`vercel crons ls`), quick-add an expense, run an import, check `/api/cron/invariants` with the bearer secret returns zeroes.
- [ ] **Step 4: Commit** — `chore: nightly encrypted backups and production deploy config`

### Task 23: Phase-1 acceptance pass

- [ ] Walk the spec §11 success criteria end-to-end on the production deployment with real data: (1) BLR expense in ≤3 taps ✓ (2) real bank statement imported, dupes correctly flagged, zero silent drops — verify row count vs file ✓ (3) dashboard <1s ✓ (4) inbox to "All caught up" <1min ✓ (5) `ledger_anomalies` empty after a nightly run ✓. Fix anything failing before declaring Phase 1 done. Record results in `docs/runbooks/phase-1-acceptance.md`. Commit.

---

## Self-review (done at write time)

- **Spec coverage:** P1 row of §10 → auth (T12), accounts (T14), quick entry+outbox (T15), CSV/XLS/PDF import (T18-19; **PDF consciously deferred** — see below), review inbox (T17), rules (T11+17), categories seed (T3), budgets (T20), hero dashboard (T21), invariant cron (T9), backups (T22). §4.3 invariants: 1→T4/T6/T19, 2→T5/T9, 3→T4/T5/T14, 4→T4/T10/T16, 5→T7/T8, 6→T9, 7→T4/T5/T11, 8→T2 + conventions block.
- **Deviation from spec, explicit:** PDF statement parsing is **pushed to early P3** (Gmail phase, where PDF tooling is needed anyway). Rationale: netbanking CSV/XLS covers the same data with deterministic parsing; password-protected PDF parsing is high-effort/low-marginal-value against the paycheck deadline. The spec's P1 line should be read as "CSV/XLS now, PDF when email lands."
- **Placeholder scan:** code is shown for all correctness-critical logic; UI tasks specify exact components, actions, and behaviors. Derive/auth internals reference checked-at-build docs (Better Auth, local Next docs) by design.
- **Type consistency:** `createTransaction/createValuation/annotate/softDelete` (T5) used by T14-17/T19; `withOccurrenceHashes` (T6) used by T19; `computeBalanceAt/rebuildBalances/rebuildRollups/netWorth/afterWrite` (T7-8) used by T14/T21; `ColumnMapping` defined T18, stored T4 (`import_configs`), used T19. Consistent.
