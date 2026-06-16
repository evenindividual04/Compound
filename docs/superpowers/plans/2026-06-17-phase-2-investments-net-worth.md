# Phase 2: Investments + Net Worth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mutual-fund and direct-equity holdings first-class in the ledger — buys/sells as `trade` entries, holdings replayed from those entries, valued daily from AMFI (MF) and a best-effort equity feed — so net worth reflects the whole portfolio with per-holding XIRR.

**Architecture:** Strict extension of the P1 immutable-ledger model. `trade` entries (the `entry_type` enum already has the value) carry the trade's signed cash value; a new `trades` subtype table holds `{instrument, side, units, price}`. Holdings are pure recomputation from trade entries (like balances). **Investment-kind accounts are valued by holdings × price, not by the cash-summing balance path** — the one change to P1's `netWorth`/balance derivation. Pricing is daily crons (AMFI for MF, best-effort for equity) upserting a `prices` time series. XIRR is deterministic cashflow IRR. Ingestion reuses the existing import pipeline with a trade-shaped row + per-broker mapping presets; no new parser, no CAS PDF.

**Tech Stack:** Next.js 16 (App Router, RSC) · TypeScript · Postgres + Drizzle (numeric mode `'string'`) · decimal.js-light · date-fns · Vitest · Recharts · pnpm. Spec: `docs/superpowers/specs/2026-06-17-phase-2-investments-net-worth-design.md`.

**Conventions inherited from P1 (do not violate):**
- Money is **string** end-to-end; arithmetic only via `src/lib/money.ts`. The single allowed `Number()` boundaries are (a) chart display props converted at the RSC boundary, and (b) inside the XIRR NPV solver (analytics, not ledger truth) — both documented at the call site.
- All writes go through a validated write path that appends to `entry_events`. Derived state is pure recomputation, never incremental.
- Every `pnpm test` must be green before each commit. Conventional commit messages, no attribution footer.
- Local Postgres: port **54329**, db `fin_dev` / `fin_test`. Start if down: `/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D ~/.fin-pgdata -o "-p 54329 -c listen_addresses=127.0.0.1" -l ~/.fin-pgdata/log start`. Tests: `pnpm test` (loads `.env.local`, needs `TEST_DATABASE_URL`; suites run serially, shared test DB — never parallelize).
- Migrations: edit `src/db/schema/*`, then `pnpm db:generate` (writes `drizzle/NNNN_*.sql`), then `pnpm db:migrate`. For the test DB, apply the same migration against `TEST_DATABASE_URL`.
- Always run from the repo root or use absolute paths (shell cwd drifts in this harness).

---

## The trade/value model (read before Task 1)

A **buy** records: a `trade` entry on the *investment account* with `entries.amount = −(units × price)` (cash value leaving, ADR-1), plus a `trades` row `{instrument, side:'buy', units, price}`. The funding bank/cash debit, if imported, is an ordinary `transaction` on the bank account (optionally transfer-linked later); it is **not** required for P2 correctness.

A **sell** records a `trade` entry with `entries.amount = +(units × price)` and a `trades` row `{side:'sell', units, price}`.

**Valuation rule (the crux):** an investment account's rupee value is **not** the sum of its trade cash flows — it is `Σ(holding.units × latest price)`. So investment-kind accounts are **excluded from the cash `Σ(amount)` balance path** and valued from holdings instead. Non-investment accounts are unchanged from P1. This is implemented once in `derive.ts` (Task 4) and nothing else re-derives it.

Units and prices use 6 decimal places (MF NAVs and fractional units need more than money's 4dp); cash amounts stay at 4dp.

---

## File structure (target state at end of P2)

```
src/db/schema/ledger.ts        + instruments, trades, prices tables (and re-export)
drizzle/NNNN_*.sql             generated migration for the three tables
src/lib/invest/
  ├── trade.ts                 createTrade write path (+ audit), validation
  ├── trade.test.ts
  ├── holdings.ts              rebuildHoldings / computeHoldings (units, avgCost, realized P&L)
  ├── holdings.test.ts
  ├── xirr.ts                  deterministic cashflow IRR
  ├── xirr.test.ts
  ├── amfi.ts                  parse AMFI NAVAll feed → {amfiCode → {nav, date}}
  ├── amfi.test.ts
  ├── price.ts                 upsertPrices, latestPriceAt, equity fetch interface + fallback
  ├── price.test.ts
  └── presets.ts               Zerodha Console / Groww column-mapping presets
src/lib/ledger/derive.ts       MODIFY: netWorth + new holdingValueAt / investment exclusion
src/lib/ledger/derive.test.ts  MODIFY: net-worth-with-holdings cases
src/lib/ledger/invariants.ts   MODIFY: trade_cash_mismatch, oversold_holding, stale_price
src/lib/ledger/invariants.test.ts  MODIFY
src/lib/import/pipeline.ts     MODIFY: trade row shape + commitImport trade branch
src/app/api/cron/prices/route.ts   new: AMFI + equity price refresh (bearer-secured)
src/app/actions/trades.ts      new: createTradeAction, manual trade form action
src/app/(app)/holdings/page.tsx    new: holdings list + XIRR
src/components/invest/*         new: holdings table, trade form, networth breakdown chart
src/app/(app)/page.tsx         MODIFY: swap dashboard spark for net-worth breakdown
vercel.ts                      new: register prices + invariants crons
```

---

### Task 1: Schema — instruments, trades, prices

**Files:**
- Modify: `src/db/schema/ledger.ts` (append three tables; they re-export automatically via `schema/index.ts`)
- Generate: `drizzle/NNNN_*.sql`
- Test: `src/lib/invest/schema.test.ts` (create)

- [ ] **Step 1: Add tables to `src/db/schema/ledger.ts`** (append after the `valuations` table; `instruments` references `households` so import it from `./core`):

```typescript
// ── P2: investments ───────────────────────────────────────────────────────────
import { households } from "./core"; // add to the existing core import if not present

export const instrumentKind = pgEnum("instrument_kind", ["mf", "equity"]);

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    kind: instrumentKind("kind").notNull(),
    name: text("name").notNull(),
    symbol: text("symbol"), // NSE symbol for equity
    isin: text("isin"),
    amfiCode: text("amfi_code"), // join key to the AMFI NAV feed (MF)
  },
  (t) => [
    // one instrument per identity within a household
    uniqueIndex("instruments_identity").on(
      t.householdId,
      t.kind,
      sql`coalesce(${t.isin}, ${t.symbol}, ${t.amfiCode})`,
    ),
  ],
);

export const trades = pgTable("trades", {
  entryId: uuid("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instruments.id),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  units: numeric("units", { precision: 24, scale: 6, mode: "string" }).notNull(),
  price: numeric("price", { precision: 24, scale: 6, mode: "string" }).notNull(),
});

export const prices = pgTable(
  "prices",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    nav: numeric("nav", { precision: 24, scale: 6, mode: "string" }).notNull(),
  },
  (t) => [uniqueIndex("prices_instrument_date").on(t.instrumentId, t.date)],
);
```

Add `sql` to the `drizzle-orm` import at the top of the file if absent: `import { sql } from "drizzle-orm";`.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/NNNN_*.sql` creating `instrument_kind` enum + `instruments`, `trades`, `prices`. Open it and confirm the three `CREATE TABLE` statements and the two unique indexes are present.

- [ ] **Step 3: Apply to dev and test DBs**

Run:
```bash
pnpm db:migrate
dotenv -e .env.local -- sh -c 'DATABASE_URL="$TEST_DATABASE_URL" pnpm drizzle-kit migrate'
```
Expected: both complete without error.

- [ ] **Step 4: Write a smoke test** `src/lib/invest/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";

describe.skipIf(!process.env.TEST_DATABASE_URL)("p2 schema", () => {
  beforeEach(resetDb);

  it("inserts an instrument and round-trips numeric strings", async () => {
    const { hh } = await seedBasics();
    const [inst] = await tdb
      .insert(schema.instruments)
      .values({ householdId: hh.id, kind: "mf", name: "Parag Parikh Flexi Cap", amfiCode: "122639" })
      .returning();
    expect(inst.kind).toBe("mf");
    expect(inst.amfiCode).toBe("122639");
  });
});
```

- [ ] **Step 5: Run it**

Run: `pnpm test src/lib/invest/schema.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/ledger.ts drizzle/ src/lib/invest/schema.test.ts
git commit -m "feat: instruments, trades, prices schema for investments (P2)"
```

---

### Task 2: Trade write path (`createTrade`)

The only way trade entries enter the ledger. Mirrors `createTransaction` in `src/lib/ledger/write.ts`: one transaction, append to `entry_events`, validate. Stores `entries.amount` as the signed cash value (buy negative, sell positive).

**Files:**
- Create: `src/lib/invest/trade.ts`, `src/lib/invest/trade.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/invest/trade.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTrade } from "./trade";

async function investAccount(hhId: string) {
  const [a] = await tdb
    .insert(schema.accounts)
    .values({ householdId: hhId, name: "Zerodha", kind: "investment", openingDate: "2026-01-01" })
    .returning();
  return a;
}
async function mfInstrument(hhId: string) {
  const [i] = await tdb
    .insert(schema.instruments)
    .values({ householdId: hhId, kind: "mf", name: "PPFC", amfiCode: "122639" })
    .returning();
  return i;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("createTrade", () => {
  beforeEach(resetDb);

  it("a buy stores a negative cash amount and a trades row", async () => {
    const { hh } = await seedBasics();
    const acct = await investAccount(hh.id);
    const inst = await mfInstrument(hh.id);

    const entryId = await createTrade(tdb, {
      accountId: acct.id,
      instrumentId: inst.id,
      date: "2026-02-01",
      side: "buy",
      units: "100.000000",
      price: "65.430000",
    });

    const [entry] = await tdb.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    const [tr] = await tdb.select().from(schema.trades).where(eq(schema.trades.entryId, entryId));
    expect(entry.entryType).toBe("trade");
    expect(entry.amount).toBe("-6543.0000"); // −(100 × 65.43), 4dp cash
    expect(tr.side).toBe("buy");
    expect(tr.units).toBe("100.000000");
    const [ev] = await tdb.select().from(schema.entryEvents).where(eq(schema.entryEvents.entryId, entryId));
    expect(ev.field).toBe("created");
  });

  it("a sell stores a positive cash amount", async () => {
    const { hh } = await seedBasics();
    const acct = await investAccount(hh.id);
    const inst = await mfInstrument(hh.id);
    const entryId = await createTrade(tdb, {
      accountId: acct.id, instrumentId: inst.id, date: "2026-03-01",
      side: "sell", units: "10.000000", price: "70.000000",
    });
    const [entry] = await tdb.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    expect(entry.amount).toBe("700.0000");
  });

  it("rejects non-positive units and price", async () => {
    const { hh } = await seedBasics();
    const acct = await investAccount(hh.id);
    const inst = await mfInstrument(hh.id);
    await expect(
      createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "0", price: "65" }),
    ).rejects.toThrow(/units must be positive/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/invest/trade.test.ts`
Expected: FAIL — `createTrade` is not defined.

- [ ] **Step 3: Implement** `src/lib/invest/trade.ts`:

```typescript
/**
 * The only way `trade` entries enter the ledger (mirrors lib/ledger/write.ts).
 * entries.amount carries the signed CASH value of the trade: buy → −(units×price),
 * sell → +(units×price) (ADR-1). Units/price live in the trades subtype.
 * Money stays in the string domain — cash value at 4dp via lib/money.ts.
 */
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { mul, neg, cmp } from "@/lib/money";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface NewTrade {
  accountId: string;
  instrumentId: string;
  date: string; // YYYY-MM-DD
  side: "buy" | "sell";
  units: string; // positive, up to 6dp
  price: string; // positive, up to 6dp
  status?: "pending" | "posted";
  source?: "manual" | "import" | "system";
  importId?: string | null;
  importHash?: string | null;
  externalId?: string | null;
}

/** Cash value of the trade, 4dp, signed by side. */
export function tradeCashAmount(side: "buy" | "sell", units: string, price: string): string {
  const gross = mul(units, price); // 4dp string
  return side === "buy" ? neg(gross) : gross;
}

export async function createTrade(db: Db, input: NewTrade): Promise<string> {
  if (cmp(input.units, "0") <= 0) throw new Error("units must be positive");
  if (cmp(input.price, "0") <= 0) throw new Error("price must be positive");
  const amount = tradeCashAmount(input.side, input.units, input.price);
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.entries)
      .values({
        accountId: input.accountId,
        entryType: "trade",
        date: input.date,
        amount,
        status: input.status ?? "posted",
        source: input.source ?? "manual",
        importId: input.importId ?? null,
        importHash: input.importHash ?? null,
        externalId: input.externalId ?? null,
      })
      .returning();
    await tx.insert(schema.trades).values({
      entryId: entry.id,
      instrumentId: input.instrumentId,
      side: input.side,
      units: input.units,
      price: input.price,
    });
    await tx
      .insert(schema.entryEvents)
      .values({ entryId: entry.id, field: "created", oldValue: null, newValue: amount, source: input.source ?? "manual" });
    return entry.id;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/invest/trade.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invest/trade.ts src/lib/invest/trade.test.ts
git commit -m "feat: createTrade write path with cash-value amount and audit (P2)"
```

---

### Task 3: Holdings replay (`rebuildHoldings`)

Pure recomputation of units + average cost per `(accountId, instrumentId)` from trade entries, in entry order. Mirrors balance replay; never stored as mutable truth.

**Files:**
- Create: `src/lib/invest/holdings.ts`, `src/lib/invest/holdings.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/invest/holdings.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { createTrade } from "./trade";
import { computeHoldings } from "./holdings";

async function setup() {
  const { hh } = await seedBasics();
  const [acct] = await tdb
    .insert(schema.accounts)
    .values({ householdId: hh.id, name: "Zerodha", kind: "investment", openingDate: "2026-01-01" })
    .returning();
  const [inst] = await tdb
    .insert(schema.instruments)
    .values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "122639" })
    .returning();
  return { hh, acct, inst };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("computeHoldings", () => {
  beforeEach(resetDb);

  it("averages cost across buys and reduces units on sells", async () => {
    const { hh, acct, inst } = await setup();
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "100", price: "60" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-10", side: "buy", units: "100", price: "80" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-03-01", side: "sell", units: "50", price: "90" });

    const holdings = await computeHoldings(tdb, hh.id, "2026-12-31");
    const h = holdings.find((x) => x.instrumentId === inst.id)!;
    expect(h.units).toBe("150.000000"); // 100 + 100 − 50
    expect(h.avgCost).toBe("70.000000"); // (6000 + 8000)/200
    expect(h.realizedPnl).toBe("1000.0000"); // 50 × (90 − 70)
  });

  it("excludes pending and deleted trades and respects asOf date", async () => {
    const { hh, acct, inst } = await setup();
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "100", price: "60" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-06-01", side: "buy", units: "999", price: "60", status: "pending" });
    const holdings = await computeHoldings(tdb, hh.id, "2026-03-01");
    const h = holdings.find((x) => x.instrumentId === inst.id)!;
    expect(h.units).toBe("100.000000"); // pending future buy excluded
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/invest/holdings.test.ts`
Expected: FAIL — `computeHoldings` is not defined.

- [ ] **Step 3: Implement** `src/lib/invest/holdings.ts`:

```typescript
/**
 * Holdings are pure recomputation from trade entries, in entry order — never stored
 * as mutable truth (mirrors balances; spec §4.3.5 discipline). Units/price at 6dp,
 * cash/cost at 4dp. Average-cost method; partial sells leave avgCost unchanged and
 * realize P&L = unitsSold × (price − avgCost).
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js-light";
import type { Db } from "@/db";

Decimal.set({ precision: 38 });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface Holding {
  accountId: string;
  instrumentId: string;
  units: string; // 6dp
  avgCost: string; // 6dp, cost per unit
  realizedPnl: string; // 4dp cash
}

interface TradeRow {
  account_id: string;
  instrument_id: string;
  side: "buy" | "sell";
  units: string;
  price: string;
}

/** All holdings for a household as of `asOf` (inclusive), posted/reconciled trades only. */
export async function computeHoldings(ex: Executor, householdId: string, asOf: string): Promise<Holding[]> {
  const res = await ex.execute(sql`
    SELECT e.account_id, t.instrument_id, t.side, t.units::text AS units, t.price::text AS price
    FROM entries e
    JOIN trades t ON t.entry_id = e.id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.household_id = ${householdId}
      AND e.status <> 'pending'
      AND e.deleted_at IS NULL
      AND e.date <= ${asOf}
    ORDER BY e.date, e.created_at
  `);
  const rows = (res as unknown as { rows: TradeRow[] }).rows;

  const acc = new Map<string, { accountId: string; instrumentId: string; units: Decimal; cost: Decimal; realized: Decimal }>();
  for (const r of rows) {
    const key = `${r.account_id}:${r.instrument_id}`;
    let h = acc.get(key);
    if (!h) {
      h = { accountId: r.account_id, instrumentId: r.instrument_id, units: new Decimal(0), cost: new Decimal(0), realized: new Decimal(0) };
      acc.set(key, h);
    }
    const u = new Decimal(r.units);
    const p = new Decimal(r.price);
    if (r.side === "buy") {
      h.cost = h.cost.plus(u.times(p));
      h.units = h.units.plus(u);
    } else {
      const avg = h.units.isZero() ? new Decimal(0) : h.cost.div(h.units);
      h.realized = h.realized.plus(u.times(p.minus(avg)));
      h.cost = h.cost.minus(u.times(avg));
      h.units = h.units.minus(u);
    }
  }

  return [...acc.values()].map((h) => {
    const avgCost = h.units.isZero() ? new Decimal(0) : h.cost.div(h.units);
    return {
      accountId: h.accountId,
      instrumentId: h.instrumentId,
      units: h.units.toFixed(6),
      avgCost: avgCost.toFixed(6),
      realizedPnl: h.realized.toFixed(4),
    };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/invest/holdings.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invest/holdings.ts src/lib/invest/holdings.test.ts
git commit -m "feat: holdings replay (units, avg cost, realized P&L) from trades (P2)"
```

---

### Task 4: Net worth with holdings valuation (`derive.ts`)

The crux change. Investment-kind accounts are valued by `Σ(units × latest price ≤ date)`; all other accounts keep the P1 cash-sum path. Add `holdingValueAt` and rewrite `netWorth` to combine the two. `prices`/`instruments` exist (Task 1); fallback for a missing price is **last known price → cost basis** (the appraisal-valuation fallback is added in the UI layer later; the lib defaults to cost basis to stay pure).

**Files:**
- Modify: `src/lib/ledger/derive.ts`
- Modify: `src/lib/ledger/derive.test.ts`

- [ ] **Step 1: Add the failing test** to `src/lib/ledger/derive.test.ts`:

```typescript
import { holdingValueAt } from "./derive";
// inside the existing describe.skipIf(!process.env.TEST_DATABASE_URL) block:

it("net worth values investment accounts by holdings × price, not cash flows", async () => {
  const { hh, bank } = await seedBasics(); // bank opens at 1000
  const [zerodha] = await tdb
    .insert(schema.accounts)
    .values({ householdId: hh.id, name: "Zerodha", kind: "investment", openingDate: "2026-01-01" })
    .returning();
  const [inst] = await tdb
    .insert(schema.instruments)
    .values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "122639" })
    .returning();
  // buy 100 units @ 60 → cash amount −6000 on the investment account
  const { createTrade } = await import("@/lib/invest/trade");
  await createTrade(tdb, { accountId: zerodha.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "100", price: "60" });
  // price rises to 75
  await tdb.insert(schema.prices).values({ instrumentId: inst.id, date: "2026-02-28", nav: "75" });

  const value = await holdingValueAt(tdb, zerodha.id, "2026-03-01");
  expect(value).toBe("7500.0000"); // 100 × 75, NOT −6000

  const nw = await netWorth(tdb, hh.id, "2026-03-01");
  expect(nw).toBe("8500.0000"); // bank 1000 + holdings 7500
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/ledger/derive.test.ts`
Expected: FAIL — `holdingValueAt` not exported, and `netWorth` still counts the −6000 trade amount.

- [ ] **Step 3: Implement.** Add to `src/lib/ledger/derive.ts`:

```typescript
/**
 * Market value of an investment account at `date`: Σ over instruments of
 * (units held as of date) × (latest price ≤ date). Missing price → cost basis
 * (units × avgCost) so a never-priced holding still contributes its cost, never NaN.
 */
export async function holdingValueAt(ex: Executor, accountId: string, date: string): Promise<string> {
  const res = await ex.execute(sql`
    WITH lots AS (
      SELECT t.instrument_id,
             SUM(CASE WHEN t.side = 'buy' THEN t.units ELSE -t.units END) AS units,
             -- cost basis tracked at average cost is approximated here by net invested;
             -- exact avgCost lives in computeHoldings. For valuation we only need units.
             SUM(CASE WHEN t.side = 'buy' THEN t.units * t.price ELSE 0 END) AS buy_cost,
             SUM(CASE WHEN t.side = 'buy' THEN t.units ELSE 0 END) AS buy_units
      FROM entries e
      JOIN trades t ON t.entry_id = e.id
      WHERE e.account_id = ${accountId}
        AND e.status <> 'pending' AND e.deleted_at IS NULL AND e.date <= ${date}
      GROUP BY t.instrument_id
    ),
    priced AS (
      SELECT l.units,
             COALESCE(
               (SELECT p.nav FROM prices p WHERE p.instrument_id = l.instrument_id AND p.date <= ${date} ORDER BY p.date DESC LIMIT 1),
               CASE WHEN l.buy_units > 0 THEN l.buy_cost / l.buy_units ELSE 0 END
             ) AS mark
      FROM lots l
      WHERE l.units > 0
    )
    SELECT COALESCE(SUM(units * mark), 0)::numeric(19,4)::text AS val FROM priced
  `);
  return (res as unknown as { rows: { val: string }[] }).rows[0].val;
}
```

Then **rewrite `netWorth`** so non-investment accounts use the cash sum and investment accounts use `holdingValueAt`:

```typescript
/** Net worth: non-investment accounts by cash balance, investment accounts by market value. */
export async function netWorth(ex: Executor, householdId: string, date: string): Promise<string> {
  // 1. Non-investment accounts: opening + Σ(transaction|trade) cash deltas (unchanged from P1).
  const cash = await ex.execute(sql`
    SELECT COALESCE(SUM(a.opening_balance + COALESCE(s.total, 0)), 0)::numeric(19,4)::text AS nw
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT SUM(e.amount) AS total FROM entries e
      WHERE e.account_id = a.id
        AND e.entry_type IN ('transaction', 'trade')
        AND e.status <> 'pending' AND e.deleted_at IS NULL AND e.date <= ${date}
    ) s ON true
    WHERE a.household_id = ${householdId} AND a.status = 'active'
      AND NOT a.excluded AND a.kind <> 'investment'
  `);
  let total = (cash as unknown as { rows: { nw: string }[] }).rows[0].nw;

  // 2. Investment accounts: market value via holdings × price.
  const invest = await ex.execute(sql`
    SELECT a.id FROM accounts a
    WHERE a.household_id = ${householdId} AND a.status = 'active'
      AND NOT a.excluded AND a.kind = 'investment'
  `);
  for (const row of (invest as unknown as { rows: { id: string }[] }).rows) {
    total = add(total, await holdingValueAt(ex, row.id, date));
  }
  return total;
}
```

(`add` and `sql` are already imported in `derive.ts`.) **Also** exclude `kind = 'investment'` from the cash path inside `rebuildBalances`/`computeBalanceAt` is **not** required — those operate per-account and investment accounts simply will not be displayed via the cash `balances` series; net worth is the only consumer that must combine the two, and it does. Leave `computeBalanceAt`/`rebuildBalances` unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/ledger/derive.test.ts`
Expected: PASS (existing cases + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger/derive.ts src/lib/ledger/derive.test.ts
git commit -m "feat: value investment accounts by holdings in net worth (P2)"
```

---

### Task 5: XIRR (`xirr.ts`)

Deterministic cashflow IRR via Newton's method with a bisection fallback. Cashflow amounts parse from strings via Decimal; the NPV/derivative solver uses `number` (analytics boundary, documented — like the charts exception). Returns an annualized rate as a 6dp string, or `null` if it can't converge (e.g., all-same-sign flows).

**Files:**
- Create: `src/lib/invest/xirr.ts`, `src/lib/invest/xirr.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/invest/xirr.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { xirr } from "./xirr";

describe("xirr", () => {
  it("computes ~10% for a one-year doubling-free flow", () => {
    // invest 1000 on day 0, worth 1100 one year later → 10%
    const r = xirr([
      { date: "2025-01-01", amount: "-1000" },
      { date: "2026-01-01", amount: "1100" },
    ]);
    expect(r).not.toBeNull();
    expect(Number(r)).toBeCloseTo(0.1, 3);
  });

  it("handles multiple contributions (SIP-like)", () => {
    const r = xirr([
      { date: "2025-01-01", amount: "-1000" },
      { date: "2025-07-01", amount: "-1000" },
      { date: "2026-01-01", amount: "2200" },
    ]);
    expect(r).not.toBeNull();
    expect(Number(r)).toBeGreaterThan(0);
  });

  it("returns null when all flows share a sign", () => {
    expect(xirr([{ date: "2025-01-01", amount: "-1000" }, { date: "2026-01-01", amount: "-500" }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/invest/xirr.test.ts`
Expected: FAIL — `xirr` not defined.

- [ ] **Step 3: Implement** `src/lib/invest/xirr.ts`:

```typescript
/**
 * Deterministic XIRR (annualized money-weighted return) over dated cashflows.
 * Cashflow amounts are parsed from the money string domain; the root-finder itself
 * operates in `number` because IRR requires transcendental math — this is the
 * documented analytics boundary (NOT a ledger-truth path), like the charts exception.
 * Negative = money out (buy/contribution), positive = money in (sell/current value).
 */
import Decimal from "decimal.js-light";
import { differenceInCalendarDays } from "date-fns";

export interface CashFlow {
  date: string; // YYYY-MM-DD
  amount: string; // signed money string
}

const DAYS_PER_YEAR = 365;

function npv(rate: number, flows: { days: number; amount: number }[]): number {
  return flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + rate, f.days / DAYS_PER_YEAR), 0);
}
function dNpv(rate: number, flows: { days: number; amount: number }[]): number {
  return flows.reduce((sum, f) => {
    const t = f.days / DAYS_PER_YEAR;
    return sum - (t * f.amount) / Math.pow(1 + rate, t + 1);
  }, 0);
}

/** Returns the annualized rate as a 6dp string, or null if it cannot converge. */
export function xirr(cashflows: CashFlow[]): string | null {
  if (cashflows.length < 2) return null;
  const hasPos = cashflows.some((c) => new Decimal(c.amount).gt(0));
  const hasNeg = cashflows.some((c) => new Decimal(c.amount).lt(0));
  if (!hasPos || !hasNeg) return null;

  const sorted = [...cashflows].sort((a, b) => a.date.localeCompare(b.date));
  const t0 = new Date(`${sorted[0].date}T00:00:00Z`);
  const flows = sorted.map((c) => ({
    days: differenceInCalendarDays(new Date(`${c.date}T00:00:00Z`), t0),
    amount: new Decimal(c.amount).toNumber(), // analytics boundary
  }));

  // Newton's method from 10%; fall back to bisection on [-0.9999, 10].
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, flows);
    const df = dNpv(rate, flows);
    if (!isFinite(f) || !isFinite(df) || df === 0) break;
    const next = rate - f / df;
    if (Math.abs(next - rate) < 1e-9) return new Decimal(next).toFixed(6);
    rate = next;
    if (rate <= -1) { rate = -0.9999; }
  }

  let lo = -0.9999, hi = 10;
  let flo = npv(lo, flows);
  if (!isFinite(flo)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid, flows);
    if (Math.abs(fmid) < 1e-7) return new Decimal(mid).toFixed(6);
    if (flo * fmid < 0) hi = mid;
    else { lo = mid; flo = fmid; }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/invest/xirr.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invest/xirr.ts src/lib/invest/xirr.test.ts
git commit -m "feat: deterministic XIRR over dated cashflows (P2)"
```

---

### Task 6: AMFI NAV parser (`amfi.ts`)

Parse AMFI's `NAVAll` feed (semicolon-delimited, with fund-house header lines and blank lines interspersed) into `{ amfiCode, nav, date }`. Pure function over a string — fetching happens in the cron (Task 7) so this is unit-testable without the network.

**Files:**
- Create: `src/lib/invest/amfi.ts`, `src/lib/invest/amfi.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/invest/amfi.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAmfiNav } from "./amfi";

const SAMPLE = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes ( Equity Scheme - Flexi Cap Fund )

PPFAS Mutual Fund

122639;INF879O01027;-;Parag Parikh Flexi Cap Fund - Regular Plan - Growth;65.4321;16-Jun-2026
122640;INF879O01035;-;Parag Parikh Flexi Cap Fund - Direct Plan - Growth;71.2345;16-Jun-2026

Some Other AMC

100001;INF000000001;-;Liquid Fund - Growth;1234.5678;16-Jun-2026
`;

describe("parseAmfiNav", () => {
  it("extracts code, nav, and ISO date for data lines and skips headers", () => {
    const out = parseAmfiNav(SAMPLE);
    expect(out.get("122639")).toEqual({ nav: "65.432100", date: "2026-06-16" });
    expect(out.get("122640")?.nav).toBe("71.234500");
    expect(out.get("100001")?.date).toBe("2026-06-16");
    expect(out.size).toBe(3);
  });

  it("ignores lines with non-numeric NAV", () => {
    const out = parseAmfiNav("999999;X;-;Broken Fund;N.A.;16-Jun-2026\n");
    expect(out.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/invest/amfi.test.ts`
Expected: FAIL — `parseAmfiNav` not defined.

- [ ] **Step 3: Implement** `src/lib/invest/amfi.ts`:

```typescript
/**
 * Parse the AMFI NAVAll feed (https://www.amfiindia.com/spages/NAVAll.txt).
 * Format: semicolon-delimited rows
 *   Scheme Code;ISIN ...;ISIN ...;Scheme Name;Net Asset Value;Date
 * interleaved with fund-house names, category headers, and blank lines, which we skip.
 * Pure: fetching is the cron's job. NAV stored at 6dp; date as ISO yyyy-MM-dd.
 */
import { parse as parseDateFns, isValid, format } from "date-fns";

export interface NavRow {
  nav: string; // 6dp
  date: string; // yyyy-MM-dd
}

export function parseAmfiNav(text: string): Map<string, NavRow> {
  const out = new Map<string, NavRow>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(";");
    if (parts.length < 6) continue; // header/blank/category line
    const code = parts[0].trim();
    if (!/^\d+$/.test(code)) continue; // first col must be a numeric scheme code
    const navRaw = parts[4].trim();
    if (!/^\d+(\.\d+)?$/.test(navRaw)) continue; // skip "N.A." etc.
    const d = parseDateFns(parts[5].trim(), "dd-MMM-yyyy", new Date(2000, 0, 1));
    if (!isValid(d)) continue;
    out.set(code, { nav: Number(navRaw).toFixed(6), date: format(d, "yyyy-MM-dd") });
  }
  return out;
}
```

(`Number(navRaw)` here is parsing an external feed string into a fixed-precision NAV string for storage — it never touches a ledger amount; documented at the call site.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/invest/amfi.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invest/amfi.ts src/lib/invest/amfi.test.ts
git commit -m "feat: AMFI NAVAll feed parser (P2)"
```

---

### Task 7: Price store + equity fetch + price cron

`price.ts` holds `upsertPrices` (idempotent on `(instrumentId, date)`), `latestPriceAt`, and an equity-fetch interface with last-known fallback. The cron route fetches AMFI + equity quotes and upserts. Equity's concrete source is injected so the cron is testable and the fragile network call is isolated.

**Files:**
- Create: `src/lib/invest/price.ts`, `src/lib/invest/price.test.ts`
- Create: `src/app/api/cron/prices/route.ts`

- [ ] **Step 1: Write the failing test** `src/lib/invest/price.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { upsertPrices, latestPriceAt } from "./price";

describe.skipIf(!process.env.TEST_DATABASE_URL)("price store", () => {
  beforeEach(resetDb);

  it("upserts idempotently and reads the latest price ≤ date", async () => {
    const { hh } = await seedBasics();
    const [inst] = await tdb.insert(schema.instruments).values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "122639" }).returning();

    await upsertPrices(tdb, [{ instrumentId: inst.id, date: "2026-06-15", nav: "65.000000" }]);
    await upsertPrices(tdb, [{ instrumentId: inst.id, date: "2026-06-15", nav: "66.000000" }]); // same day → overwrite
    await upsertPrices(tdb, [{ instrumentId: inst.id, date: "2026-06-16", nav: "67.000000" }]);

    expect(await latestPriceAt(tdb, inst.id, "2026-06-16")).toBe("67.000000");
    expect(await latestPriceAt(tdb, inst.id, "2026-06-15")).toBe("66.000000");
    expect(await latestPriceAt(tdb, inst.id, "2026-06-10")).toBeNull();
    const rows = await tdb.select().from(schema.prices);
    expect(rows.length).toBe(2); // upsert, not duplicate
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/invest/price.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/invest/price.ts`:

```typescript
/**
 * Price persistence + reads. Daily NAV/quote time series, unique on (instrument, date).
 * Equity quotes come from an injected fetcher (the concrete source — fragile, rate-limited —
 * is chosen in the cron); on failure we simply write no row and valuation falls back to the
 * last known price (spec §5/§6 "fall back visibly, never a wrong number").
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface PriceRow {
  instrumentId: string;
  date: string;
  nav: string;
}

export async function upsertPrices(ex: Executor, rows: PriceRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await ex
      .insert(schema.prices)
      .values(batch)
      .onConflictDoUpdate({ target: [schema.prices.instrumentId, schema.prices.date], set: { nav: sql`excluded.nav` } });
  }
}

export async function latestPriceAt(ex: Executor, instrumentId: string, date: string): Promise<string | null> {
  const res = await ex.execute(sql`
    SELECT nav::text AS nav FROM prices
    WHERE instrument_id = ${instrumentId} AND date <= ${date}
    ORDER BY date DESC LIMIT 1
  `);
  const row = (res as unknown as { rows: { nav: string }[] }).rows[0];
  return row ? row.nav : null;
}

/** Equity quote fetcher contract. Implementations live behind the cron; returns null on miss. */
export type EquityQuoteFetcher = (symbol: string) => Promise<string | null>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/invest/price.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Implement the cron route** `src/app/api/cron/prices/route.ts` (mirrors `api/cron/invariants/route.ts` auth exactly):

```typescript
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { parseAmfiNav } from "@/lib/invest/amfi";
import { upsertPrices, type PriceRow } from "@/lib/invest/price";

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";

export async function GET(req: Request) {
  if (!authorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // ── MF: AMFI NAVAll (authoritative, free) ──
  const mfInstruments = await db
    .select({ id: schema.instruments.id, amfiCode: schema.instruments.amfiCode })
    .from(schema.instruments)
    .where(and(eq(schema.instruments.kind, "mf"), isNotNull(schema.instruments.amfiCode)));

  let mfUpdated = 0;
  if (mfInstruments.length) {
    try {
      const text = await fetch(AMFI_URL, { cache: "no-store" }).then((r) => r.text());
      const navs = parseAmfiNav(text);
      const rows: PriceRow[] = [];
      for (const inst of mfInstruments) {
        const nav = inst.amfiCode ? navs.get(inst.amfiCode) : undefined;
        if (nav) rows.push({ instrumentId: inst.id, date: nav.date, nav: nav.nav });
      }
      if (rows.length) await upsertPrices(db, rows);
      mfUpdated = rows.length;
    } catch (e) {
      // best-effort: leave prices as-is, valuation falls back to last known (§6)
    }
  }

  // ── Equity: best-effort. Concrete source is chosen here; on miss, write nothing. ──
  // Implementation note: wire a free quote source behind a fetcher with the
  // EquityQuoteFetcher contract; until one is selected this is a no-op and equity
  // values fall back to last-known/appraisal/cost per spec §5.
  const equityUpdated = 0;

  return NextResponse.json({ ok: true, mfUpdated, equityUpdated });
}
```

- [ ] **Step 6: Manually verify the cron** (dev server running, AMFI reachable). Seed one MF instrument with a real `amfiCode` (e.g. `122639`), then:

```bash
curl -s -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" http://localhost:3000/api/cron/prices
```
Expected: `{"ok":true,"mfUpdated":1,"equityUpdated":0}` and a `prices` row for that instrument. (401 without the bearer.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/invest/price.ts src/lib/invest/price.test.ts src/app/api/cron/prices/route.ts
git commit -m "feat: price store + AMFI price refresh cron (P2)"
```

---

### Task 8: Invariant extensions

Add three checks to `src/lib/ledger/invariants.ts` (follow the existing `runInvariantChecks` structure — each check returns a count and inserts anomalies via the existing `insertAnomalies` helper; read the file first to match its exact shape).

**Files:**
- Modify: `src/lib/ledger/invariants.ts`
- Modify: `src/lib/ledger/invariants.test.ts`

- [ ] **Step 1: Write failing tests** in `src/lib/ledger/invariants.test.ts` (one per new check). Example for `oversold_holding`:

```typescript
it("flags an oversold holding (units driven negative)", async () => {
  const { hh } = await seedBasics();
  const [acct] = await tdb.insert(schema.accounts).values({ householdId: hh.id, name: "Z", kind: "investment", openingDate: "2026-01-01" }).returning();
  const [inst] = await tdb.insert(schema.instruments).values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "1" }).returning();
  const { createTrade } = await import("@/lib/invest/trade");
  await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "10", price: "60" });
  await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-03-01", side: "sell", units: "25", price: "60" });
  const counts = await runInvariantChecks(tdb);
  expect(counts.oversold_holding).toBe(1);
});
```

Add analogous tests for `trade_cash_mismatch` (a trade whose `|amount|` differs from `units×price` by > 0.01 — construct by inserting a trade entry then mutating its amount) and `stale_price` (an investment account holding an instrument with no `prices` row within 4 days of today).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test src/lib/ledger/invariants.test.ts`
Expected: FAIL — the new keys are `undefined` on the counts object.

- [ ] **Step 3: Implement.** In `runInvariantChecks`, add three checks following the existing pattern. Sketch of the SQL each runs (wrap in the file's existing count-and-insert helper):

```typescript
// trade_cash_mismatch: |entries.amount| vs units*price beyond tolerance
const cashMismatch = await ex.execute(sql`
  SELECT e.id FROM entries e JOIN trades t ON t.entry_id = e.id
  WHERE e.deleted_at IS NULL
    AND abs(abs(e.amount) - (t.units * t.price)) > 0.01
`);
// oversold_holding: running units < 0 for any (account, instrument)
const oversold = await ex.execute(sql`
  SELECT account_id, instrument_id FROM (
    SELECT e.account_id, t.instrument_id,
      SUM(CASE WHEN t.side='buy' THEN t.units ELSE -t.units END) AS net_units
    FROM entries e JOIN trades t ON t.entry_id = e.id
    WHERE e.deleted_at IS NULL AND e.status <> 'pending'
    GROUP BY e.account_id, t.instrument_id
  ) s WHERE s.net_units < 0
`);
// stale_price: held instrument with no price within 4 calendar days of today
const stale = await ex.execute(sql`
  SELECT DISTINCT t.instrument_id FROM entries e JOIN trades t ON t.entry_id = e.id
  WHERE e.deleted_at IS NULL AND e.status <> 'pending'
  GROUP BY e.account_id, t.instrument_id, t.instrument_id
  HAVING SUM(CASE WHEN t.side='buy' THEN t.units ELSE -t.units END) > 0
     AND NOT EXISTS (
       SELECT 1 FROM prices p WHERE p.instrument_id = t.instrument_id
         AND p.date >= CURRENT_DATE - INTERVAL '4 days'
     )
`);
```

For each, insert one anomaly per offending row via the file's existing `insertAnomalies(kind, detail)` helper, and return the counts under keys `trade_cash_mismatch`, `oversold_holding`, `stale_price` added to the returned object.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test src/lib/ledger/invariants.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger/invariants.ts src/lib/ledger/invariants.test.ts
git commit -m "feat: trade/holding/price invariant checks (P2)"
```

---

### Task 9: Trade import path

Extend the import pipeline to accept trade rows and commit them as `trade` entries. Read `src/lib/import/pipeline.ts` fully first; reuse its staging/preview/dedup machinery — add a trade branch, do not fork the pipeline.

**Files:**
- Modify: `src/lib/import/pipeline.ts`
- Create: `src/lib/invest/presets.ts`
- Modify/Create: `src/lib/import/pipeline.test.ts` (add trade cases)

- [ ] **Step 1: Add a trade row shape.** In `pipeline.ts`, extend the normalized row with optional trade fields (transactions ignore them):

```typescript
export interface NormalizedRow {
  date: string;
  amount: string; // signed, 4dp (for trades: the cash value, buy negative)
  description: string;
  externalId?: string;
  balance?: string;
  // trade-only:
  instrumentSymbol?: string; // resolve/create instrument by symbol/ISIN/amfiCode
  side?: "buy" | "sell";
  units?: string;
  price?: string;
}
```

- [ ] **Step 2: Write the failing test** (in `pipeline.test.ts`): staging a tradebook for an investment account, committing, and asserting `trade` entries + a resolved instrument land as `pending`. Use the existing test scaffolding for imports; assert `commitImport` created the right count and that `computeHoldings` reflects the units.

- [ ] **Step 3: Run to verify it fails** — `pnpm test src/lib/import/pipeline.test.ts` → FAIL.

- [ ] **Step 4: Implement the commit branch.** In `commitImport`, when the target account `kind = 'investment'` and a row carries `side`/`units`/`price`: resolve-or-create the instrument (match `(householdId, kind, isin|symbol|amfiCode)`; create if absent), then call `createTrade` (Task 2) with `status: 'pending'`, `source: 'import'`, `importId`, and the row's `importHash`; afterwards run `rebuildHoldings`/`afterWrite` for the account. Non-investment accounts keep the existing `createTransaction` branch unchanged.

- [ ] **Step 5: Add broker presets** `src/lib/invest/presets.ts` — column-mapping presets matching Zerodha Console and Groww tradebook export headers, shaped as `ColumnMapping` extensions (instrument/side/units/price roles). These are saved into `import_configs` so the first import of each broker is one click.

```typescript
/** Column-role presets for broker tradebook CSV/Excel exports. Saved into import_configs. */
export const TRADE_PRESETS = {
  zerodha_console: {
    label: "Zerodha Console (tradebook)",
    dateFormat: "yyyy-MM-dd" as const,
    roles: { date: "trade_date", instrumentSymbol: "symbol", side: "trade_type", units: "quantity", price: "price" },
  },
  groww: {
    label: "Groww (order history)",
    dateFormat: "dd MMM yyyy" as const,
    roles: { date: "Date", instrumentSymbol: "Stock/Scheme", side: "Type", units: "Quantity", price: "Price" },
  },
} as const;
```

(Confirm exact header strings against a real export at implementation time; the mapping UI lets the owner correct any mismatch, and the corrected mapping is what gets saved.)

- [ ] **Step 6: Run to verify it passes** — `pnpm test src/lib/import/pipeline.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/import/pipeline.ts src/lib/invest/presets.ts src/lib/import/pipeline.test.ts
git commit -m "feat: trade import via existing pipeline + broker presets (P2)"
```

---

### Task 10: Manual trade entry (server action + form)

**Files:**
- Create: `src/app/actions/trades.ts`
- Create: `src/components/invest/trade-form.tsx`
- Modify: wherever the FAB/quick-entry surface lives (`src/components/quick-entry*` / `bottom-nav`) to add a "Record trade" entry point

- [ ] **Step 1:** Server action `createTradeAction(input)` in `src/app/actions/trades.ts`: zod-validate `{ accountId, instrumentId?, newInstrument?, date, side, units, price }` (all money/units as strings; reject `Number()`), resolve-or-create the instrument, call `createTrade` (posted, source `manual`), then `afterWrite`. Return the new entry id. Follow the existing server-action shape in `src/app/actions/*` (auth/household resolution, `revalidatePath`).

- [ ] **Step 2:** `trade-form.tsx` — client form (reuse the r7 form components from `DESIGN.md`): account picker (investment-kind only), instrument typeahead (existing instruments + "add new" with kind/symbol/ISIN/amfiCode), side toggle, units + price numeric inputs, computed cash value preview via `formatINR`. Tabular numerals on all money; no `Number()` on the money strings.

- [ ] **Step 3:** Wire a "Record trade" action into the existing FAB/quick-entry surface.

- [ ] **Step 4: Manual verify** — record a buy, confirm it lands in the inbox as pending, accept it, confirm holdings update.

- [ ] **Step 5: Commit** — `feat: manual trade entry form and action (P2)`

---

### Task 11: Holdings view

**Files:**
- Create: `src/app/(app)/holdings/page.tsx`
- Create: `src/components/invest/holdings-table.tsx`
- Modify: `src/components/bottom-nav.tsx` (add Holdings, or surface under an existing tab)

- [ ] **Step 1:** RSC `holdings/page.tsx`: resolve household, call `computeHoldings(db, hh, today)`, join instruments + `latestPriceAt` for current value, compute per-holding unrealized P&L (`units × (price − avgCost)`) and XIRR (build cashflows from the instrument's trade entries + a terminal flow = current value, pass to `xirr`). Pass pre-aggregated rows to the client table.

- [ ] **Step 2:** `holdings-table.tsx`: per instrument — name, units, avg cost, current price + as-of date (stale chip if price older than 4d), current value, unrealized P&L (green/red by direction), XIRR % (or "—" if null). Money via `formatINR`/`formatINRCompact`, tabular numerals, `Number()` only at any chart boundary.

- [ ] **Step 3: Manual verify** — holdings show correct units/value/XIRR for the seeded trades; stale chip appears when no recent price.

- [ ] **Step 4: Commit** — `feat: holdings view with current value and XIRR (P2)`

---

### Task 12: Net-worth breakdown chart

**Files:**
- Create: `src/components/invest/networth-breakdown.tsx` (Recharts client island)
- Create: `src/lib/ledger/networth-series.ts` (RSC-side aggregation → `{date, value}[]` per bucket)
- Modify: `src/app/(app)/page.tsx` (replace the P1 spark with the breakdown)

- [ ] **Step 1:** `networth-series.ts`: produce a daily/monthly series combining non-investment account balances (from the `balances` table) + investment account values (`holdingValueAt` per date). Bucket by asset class (bank/cash, MF, equity, EPF/FD/gold, − liabilities). Values converted to `number` **only** in this RSC aggregation, right before handing to the chart (the documented chart boundary).

- [ ] **Step 2:** `networth-breakdown.tsx`: stacked area/bar over time, asset classes stacked, liabilities below zero. Colors from the r7 palette (`DESIGN.md`); money labels via `formatINRCompact`.

- [ ] **Step 3:** Swap into the dashboard. **Manual verify** the dashboard still loads < 1s (Network tab, Fast 4G) and net worth matches `netWorth(db, hh, today)`.

- [ ] **Step 4: Commit** — `feat: net-worth breakdown chart over time (P2)`

---

### Task 13: Register crons (`vercel.ts`)

**Files:**
- Create: `vercel.ts` (or `vercel.json` if the installed Vercel version prefers it — check `node_modules/next/dist/docs/` and the Vercel docs per AGENTS.md before writing)

- [ ] **Step 1:** Register both crons: `/api/cron/invariants` (nightly, the P1 cron that was never wired) and `/api/cron/prices` (every weekday evening IST, after Indian market close). Both are bearer-secured by `CRON_SECRET`. Example shape (confirm against current Vercel config docs):

```typescript
import type { VercelConfig } from "@vercel/config/v1";
export const config: VercelConfig = {
  crons: [
    { path: "/api/cron/invariants", schedule: "0 22 * * *" }, // 03:30 IST
    { path: "/api/cron/prices", schedule: "30 12 * * 1-5" },  // ~18:00 IST weekdays
  ],
};
```

- [ ] **Step 2:** `pnpm build` to confirm the config is valid and the app still compiles.

- [ ] **Step 3: Commit** — `chore: register invariants + prices crons (P2)`

---

### Task 14: P2 acceptance pass

- [ ] Run the full suite green: `pnpm test` (all P1 + P2 tests), `pnpm exec tsc --noEmit`, `pnpm build`.
- [ ] End-to-end manual run on the dev server: create an investment account; record (or import) a few buys for one MF (real `amfiCode`) and one equity; run `/api/cron/prices`; open Holdings (units, current value, XIRR correct, no stale chips after the cron); open the dashboard (net worth = bank + MF + equity + anchors − liabilities, matches `netWorth`); run `/api/cron/invariants` and confirm all counts — including the three new ones — are zero.
- [ ] Confirm the system invariant: drop `balances`/`rollups` (and recompute holdings) and rebuild — net worth is bit-identical.
- [ ] Record results in `docs/runbooks/phase-2-acceptance.md`. Commit: `chore: phase-2 acceptance pass`.

---

## Self-review (done at write time)

- **Spec coverage:** §3 architecture → Tasks 1–7; §4 data model → Task 1; §5 holdings replay → Task 3 + Task 4 valuation; §6 pricing crons → Tasks 6–7, 13; §7 invariants + XIRR determinism → Tasks 8, 5; §8 ingestion (no new parser) → Task 9 (+ manual entry Task 10); §9 UI (chart, holdings, trade entry) → Tasks 10–12; §11 success criteria → Task 14 acceptance. §2 non-goals (NPS, CAS PDF) → not built; explicitly out.
- **Model decision locked:** investment accounts valued by holdings, not cash sum — implemented once in `netWorth`/`holdingValueAt` (Task 4); trade `amount` = signed cash value (Task 2); the two reconcile in net worth only. Documented in "The trade/value model" preamble.
- **Type consistency:** `createTrade`/`NewTrade`/`tradeCashAmount` (T2) used by T8, T9, T10; `computeHoldings`/`Holding` (T3) used by T8, T11; `holdingValueAt`/`netWorth` (T4) used by T11, T12; `xirr`/`CashFlow` (T5) used by T11; `parseAmfiNav`/`NavRow` (T6) used by T7; `upsertPrices`/`latestPriceAt`/`PriceRow`/`EquityQuoteFetcher` (T7) used by T7 cron, T11; `NormalizedRow` trade fields (T9) consistent with `createTrade` inputs. Consistent.
- **Placeholder scan:** lib tasks (1–8) carry full test + implementation code; integration/UI tasks (9–13) carry precise interfaces, the key code, and explicit manual-verify steps (matching the P1 plan's fidelity scaling — UI tasks there were manual-verify, not auto-tested). The equity price source and exact broker CSV headers are deliberately deferred to implementation per spec §6/§8 and flagged at the call site, not silently omitted.
- **Numeric boundaries:** the only `Number()` uses are the XIRR solver (T5), AMFI feed parse (T6), and chart aggregation (T12) — each documented at the call site as an analytics/display/external-parse boundary, never a ledger amount.
