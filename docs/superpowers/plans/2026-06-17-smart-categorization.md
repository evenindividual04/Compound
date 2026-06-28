# Smart Categorization (P3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-attach a *suggested* category to captured transactions via a 3-tier cascade (deterministic rules → local-embedding k-NN over the owner's own corrections → PII-stripped small-LLM fallback that abstains when unsure), with every accept/correction becoming a training example, plus a one-time backfill.

**Architecture:** A small pure-orchestration library (`src/lib/categorize/`) with two non-deterministic edges (a local embedder and an LLM) injected so the cascade is unit-tested deterministically. Suggestions are written through the existing validated `annotate()` path with `categoryLocked=false` (so they stay suggestions, never overwrite a user's locked category) and land on `pending` entries in the existing review inbox. A `categorization_examples` table (pgvector) is the learning corpus.

**Tech Stack:** Next.js 16 · TypeScript · Postgres + Drizzle (numeric mode `string`) + **pgvector** · **fastembed** (local ONNX sentence-embeddings, 384-dim) · **Vercel AI SDK (`ai`) via AI Gateway** for the LLM tier · Vitest · pnpm. Spec: `docs/superpowers/specs/2026-06-17-smart-categorization-design.md`.

## Global Constraints

- Money is **string** end-to-end; never `Number()` a money value. The LLM receives an amount **bucket** (e.g. `"₹100–1k"`), never a raw amount; no money math in this feature.
- **Embeddings are local** — computed in-process by fastembed, never sent to a cloud embedding API.
- **PII allowlist for the LLM:** send redacted merchant text + amount bucket + category list ONLY. Never send account numbers, full amounts, or personal names. Redaction **fails closed** (abstain if it can't safely strip).
- The categorizer **only suggests** (`categoryLocked=false`); it never posts and never overwrites a locked category. Closed category list — the LLM picks from it or returns `UNSURE`.
- Categorization failure must never fail ingestion (wrap in try/catch; on error the entry stays uncategorized).
- Every `pnpm test` green before each commit. Conventional commits, no attribution footer. Local Postgres on port 54329 (`compound_dev`/`compound_test`); tests serial (`fileParallelism:false`) — never run two `pnpm test` at once. Migrations: edit schema → `pnpm db:generate` → `pnpm db:migrate` (dev) and `DATABASE_URL="$(npx dotenv -e .env.local -p TEST_DATABASE_URL)" npx drizzle-kit migrate` (test).

---

## File structure (target)

```
src/db/schema/ops.ts              + categorization_examples table (vector(384))
drizzle/NNNN_*.sql                migration: CREATE EXTENSION vector + table + hnsw index
src/lib/categorize/
  embed.ts        local fastembed embedder → embed(text): Promise<number[]>  (384)
  redact.ts       redactForLlm(text): string | null   (fail-closed PII strip)
  bucket.ts       amountBucket(amount: string): string
  examples.ts     recordExample(...), nearestExamples(...)  (pgvector k-NN + dedup)
  llm.ts          classifyWithLlm(input, deps): Promise<{categoryId,confidence}|null>
  categorize.ts   categorizeEntries(db, householdId, entryIds, deps)  — T1→T2 orchestration
  backfill.ts     backfillCategories(db, householdId, deps): {categorized, abstained}
src/lib/ledger/write.ts           MODIFY: extend WriteSource with `categorizer:${string}`
src/lib/import/pipeline.ts        MODIFY: call categorizeEntries after applyRulesTo
src/lib/ledger/inbox.ts           MODIFY: record a training example on accept/recategorize
src/app/actions/categorize.ts     new: backfill server action
src/components/inbox/*            MODIFY: subtle suggestion-source badge
```

---

### Task 1: Deps, pgvector, and the `categorization_examples` table

**Files:**
- Modify: `package.json` (add deps), `src/db/schema/ops.ts` (table)
- Generate: `drizzle/NNNN_*.sql`
- Test: `src/lib/categorize/schema.test.ts`

**Interfaces:**
- Produces: `schema.categorizationExamples` with columns `{ id, householdId, text, categoryId, embedding (vector 384), source, createdAt }`.

- [ ] **Step 1: Add dependencies**

Run: `pnpm add fastembed ai && pnpm add -D @types/node`
(`ai` is the Vercel AI SDK; `fastembed` is the local ONNX embedder. If `fastembed` install pulls onnxruntime-node, that is expected.)

- [ ] **Step 2: Add the table to `src/db/schema/ops.ts`** (append; import `vector` from drizzle-orm/pg-core and `households`/`categories` as the file already imports core tables — check and add):

```typescript
import { vector } from "drizzle-orm/pg-core";

export const categorizationExamples = pgTable(
  "categorization_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull().references(() => households.id),
    text: text("text").notNull(),               // normalized merchant/description
    categoryId: uuid("category_id").notNull().references(() => categories.id),
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
    source: text("source", { enum: ["accept", "correct"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catex_identity").on(t.householdId, t.text, t.categoryId),
    index("catex_embedding").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Open the new `drizzle/NNNN_*.sql`. It will create the table + indexes. **Prepend** `CREATE EXTENSION IF NOT EXISTS vector;` as the first statement if drizzle-kit did not emit it (it usually does not). Confirm the `vector(384)` column and the `hnsw ... vector_cosine_ops` index are present; if drizzle-kit emitted the hnsw index incorrectly, hand-write it: `CREATE INDEX "catex_embedding" ON "categorization_examples" USING hnsw ("embedding" vector_cosine_ops);`.

- [ ] **Step 4: Apply to both DBs**

```bash
pnpm db:migrate
DATABASE_URL="$(npx dotenv -e .env.local -p TEST_DATABASE_URL)" npx drizzle-kit migrate
```
Expected: both succeed; `psql "$TEST_DATABASE_URL" -c "\d categorization_examples"` shows the vector column + hnsw index.

- [ ] **Step 5: Smoke test** `src/lib/categorize/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { sql } from "drizzle-orm";

describe.skipIf(!process.env.TEST_DATABASE_URL)("categorization_examples", () => {
  beforeEach(resetDb);
  it("stores and reads back a 384-d embedding", async () => {
    const { hh, food } = await seedBasics();
    const vec = Array.from({ length: 384 }, (_, i) => (i % 7) / 10);
    await tdb.insert(schema.categorizationExamples).values({
      householdId: hh.id, text: "zomato", categoryId: food.id, embedding: vec, source: "accept",
    });
    const rows = await tdb.execute(sql`SELECT text, category_id FROM categorization_examples`);
    expect((rows as unknown as { rows: unknown[] }).rows.length).toBe(1);
  });
});
```

Add `categorization_examples` to the `resetDb` TRUNCATE list in `src/lib/ledger/test-db.ts` (before `categories`/`households`).

- [ ] **Step 6: Run**

Run: `pnpm test src/lib/categorize/schema.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/db/schema/ops.ts src/lib/ledger/test-db.ts drizzle/ src/lib/categorize/schema.test.ts
git commit -m "feat: pgvector categorization_examples table + ai/fastembed deps (P3a)"
```

---

### Task 2: Amount bucket + PII redaction (pure)

**Files:** Create `src/lib/categorize/bucket.ts`, `src/lib/categorize/redact.ts`, `src/lib/categorize/redact.test.ts`, `src/lib/categorize/bucket.test.ts`.

**Interfaces:**
- Produces: `amountBucket(amount: string): string`; `redactForLlm(text: string): string | null` (null = fail closed).

- [ ] **Step 1: Failing tests** `src/lib/categorize/bucket.test.ts` + `redact.test.ts`:

```typescript
// bucket.test.ts
import { describe, it, expect } from "vitest";
import { amountBucket } from "./bucket";
describe("amountBucket", () => {
  it("buckets by magnitude, sign-agnostic", () => {
    expect(amountBucket("-642.0000")).toBe("₹100–1k");
    expect(amountBucket("-50.0000")).toBe("<₹100");
    expect(amountBucket("12000.0000")).toBe("₹10k–1L");
  });
});
```

```typescript
// redact.test.ts
import { describe, it, expect } from "vitest";
import { redactForLlm } from "./redact";
describe("redactForLlm", () => {
  it("keeps brand merchants", () => { expect(redactForLlm("Zomato")).toBe("Zomato"); });
  it("strips long digit runs and masked account tokens", () => {
    expect(redactForLlm("UPI/9876543210/payment")).toBe("UPI/payment");
    expect(redactForLlm("ACH DR XXXXXX1234 NETFLIX")).toBe("ACH DR NETFLIX");
  });
  it("fails closed when nothing safe remains", () => {
    expect(redactForLlm("987654321098")).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `bucket.ts`:

```typescript
import Decimal from "decimal.js-light";
/** Magnitude bucket of a money string (sign-agnostic). Never exposes the exact amount. */
export function amountBucket(amount: string): string {
  const a = new Decimal(amount).abs();
  if (a.lt(100)) return "<₹100";
  if (a.lt(1_000)) return "₹100–1k";
  if (a.lt(10_000)) return "₹1k–10k";
  if (a.lt(100_000)) return "₹10k–1L";
  return "₹1L+";
}
```

`redact.ts`:

```typescript
/**
 * Strip likely-PII before sending merchant text to a cloud model (spec §6).
 * Removes digit runs ≥4, masked-account tokens (X{2,}\d+), and collapses separators.
 * Returns null (fail closed) if no non-trivial alphabetic content survives.
 */
export function redactForLlm(text: string): string | null {
  let s = text
    .replace(/\bX{2,}\d+\b/gi, " ")        // masked account tokens
    .replace(/\d{4,}\b/g, " ")              // long digit runs
    .replace(/[\/_]+/g, " ")                // separators
    .replace(/\s+/g, " ")
    .trim();
  // strip leftover short numeric-only tokens
  s = s.split(" ").filter((t) => !/^\d+$/.test(t)).join(" ").trim();
  if (!/[a-z]{2,}/i.test(s)) return null;   // nothing meaningful left → abstain
  return s;
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat: amount bucket + fail-closed PII redaction (P3a)`.

---

### Task 3: Local embedder

**Files:** Create `src/lib/categorize/embed.ts`, `src/lib/categorize/embed.test.ts`.

**Interfaces:**
- Produces: `embed(text: string): Promise<number[]>` (length 384); `type Embedder = (text: string) => Promise<number[]>`.

- [ ] **Step 1: Failing test** `embed.test.ts` (real model; downloads once, may be slow — keep it a single case):

```typescript
import { describe, it, expect } from "vitest";
import { embed } from "./embed";
describe("embed", () => {
  it("returns a 384-d vector and is stable for the same input", async () => {
    const a = await embed("zomato");
    const b = await embed("zomato");
    expect(a).toHaveLength(384);
    expect(a[0]).toBeCloseTo(b[0], 6);
  }, 60_000);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `embed.ts` using fastembed (lazy-load a singleton; `BGESmallENV15` is 384-d):

```typescript
import { FlagEmbedding, EmbeddingModel } from "fastembed";

export type Embedder = (text: string) => Promise<number[]>;

let modelP: Promise<FlagEmbedding> | null = null;
function model(): Promise<FlagEmbedding> {
  modelP ??= FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
  return modelP;
}

/** Local sentence embedding (384-d). Never calls a cloud API. */
export const embed: Embedder = async (text) => {
  const m = await model();
  const batches = m.embed([text || " "]);
  for await (const batch of batches) {
    const v = batch[0];
    return Array.from(v as ArrayLike<number>);
  }
  throw new Error("embedding produced no output");
};
```

(If the installed fastembed API differs, adapt to its real `embed` iterator shape — the contract is `(text) => Promise<number[384]>`. Verify the dimension is 384 for the chosen model; if the model yields a different dimension, switch to a 384-d model and update the schema's `dimensions` to match.)

- [ ] **Step 4: Run → PASS** (first run downloads the model).

- [ ] **Step 5: Commit** — `feat: local fastembed embedder (P3a)`.

---

### Task 4: Training corpus — record + k-NN (`examples.ts`)

**Files:** Create `src/lib/categorize/examples.ts`, `src/lib/categorize/examples.test.ts`.

**Interfaces:**
- Consumes: `schema.categorizationExamples`.
- Produces: `recordExample(db, {householdId, text, categoryId, embedding, source})`; `nearestExamples(db, householdId, embedding, k): Promise<{ categoryId: string; sim: number }[]>`.

- [ ] **Step 1: Failing test** `examples.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import { recordExample, nearestExamples } from "./examples";

const v = (fill: number) => Array.from({ length: 384 }, () => fill);

describe.skipIf(!process.env.TEST_DATABASE_URL)("examples", () => {
  beforeEach(resetDb);
  it("records, dedups by (hh,text,category), and returns nearest by cosine", async () => {
    const { hh, food, groceries } = await seedBasics();
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" });
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" }); // dup
    await recordExample(tdb, { householdId: hh.id, text: "bigbasket", categoryId: groceries.id, embedding: v(0.1), source: "correct" });

    const near = await nearestExamples(tdb, hh.id, v(0.88), 3);
    expect(near[0].categoryId).toBe(food.id);          // closest to the 0.9 vector
    expect(near[0].sim).toBeGreaterThan(0.9);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `examples.ts`:

```typescript
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface NewExample {
  householdId: string; text: string; categoryId: string;
  embedding: number[]; source: "accept" | "correct";
}

/** Idempotent on (householdId, text, categoryId) — keeps the latest embedding/source. */
export async function recordExample(ex: Executor, e: NewExample): Promise<void> {
  await ex
    .insert(schema.categorizationExamples)
    .values({ householdId: e.householdId, text: e.text, categoryId: e.categoryId, embedding: e.embedding, source: e.source })
    .onConflictDoUpdate({
      target: [schema.categorizationExamples.householdId, schema.categorizationExamples.text, schema.categorizationExamples.categoryId],
      set: { embedding: e.embedding, source: e.source },
    });
}

/** k nearest labeled examples by cosine similarity (1 - cosine_distance), descending. */
export async function nearestExamples(
  ex: Executor, householdId: string, embedding: number[], k: number,
): Promise<{ categoryId: string; sim: number }[]> {
  const lit = sql.raw(`'[${embedding.join(",")}]'::vector`);
  const res = await ex.execute(sql`
    SELECT category_id, 1 - (embedding <=> ${lit}) AS sim
    FROM categorization_examples
    WHERE household_id = ${householdId}
    ORDER BY embedding <=> ${lit}
    LIMIT ${k}
  `);
  return (res as unknown as { rows: { category_id: string; sim: number }[] }).rows.map((r) => ({
    categoryId: r.category_id, sim: Number(r.sim),
  }));
}
```

(`sim` is a similarity ratio, not money — `Number()` is fine here. The `<=>` operator is pgvector cosine distance.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat: categorization training corpus + pgvector k-NN (P3a)`.

---

### Task 5: LLM tier (`llm.ts`)

**Files:** Create `src/lib/categorize/llm.ts`, `src/lib/categorize/llm.test.ts`.

**Interfaces:**
- Consumes: `redactForLlm`, `amountBucket`.
- Produces: `classifyWithLlm(input, deps): Promise<{ categoryId: string; confidence: number } | null>` where `input = { text: string; amount: string; categories: { id: string; name: string }[] }` and `deps = { generate: GenerateFn }`; `type GenerateFn = (prompt: string, names: string[]) => Promise<{ name: string; confidence: number } | null>`.

- [ ] **Step 1: Failing test** `llm.test.ts` (inject a mock generate; no network):

```typescript
import { describe, it, expect } from "vitest";
import { classifyWithLlm } from "./llm";

const cats = [{ id: "c1", name: "Food & Dining" }, { id: "c2", name: "Groceries" }];

describe("classifyWithLlm", () => {
  it("maps an in-list name to its id", async () => {
    const r = await classifyWithLlm(
      { text: "Zomato", amount: "-642.0000", categories: cats },
      { generate: async () => ({ name: "Food & Dining", confidence: 0.95 }) },
    );
    expect(r).toEqual({ categoryId: "c1", confidence: 0.95 });
  });
  it("abstains on UNSURE / out-of-list / null", async () => {
    expect(await classifyWithLlm({ text: "Zomato", amount: "-1", categories: cats }, { generate: async () => null })).toBeNull();
    expect(await classifyWithLlm({ text: "Zomato", amount: "-1", categories: cats }, { generate: async () => ({ name: "Travel", confidence: 0.9 }) })).toBeNull();
  });
  it("fails closed when redaction strips everything", async () => {
    let called = false;
    const r = await classifyWithLlm({ text: "987654321098", amount: "-1", categories: cats }, { generate: async () => { called = true; return { name: "Food & Dining", confidence: 1 }; } });
    expect(r).toBeNull();
    expect(called).toBe(false); // never called the model with unredactable text
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `llm.ts`:

```typescript
import { redactForLlm } from "./redact";
import { amountBucket } from "./bucket";

export type GenerateFn = (prompt: string, categoryNames: string[]) => Promise<{ name: string; confidence: number } | null>;

export interface LlmInput {
  text: string; amount: string; categories: { id: string; name: string }[];
}

export async function classifyWithLlm(
  input: LlmInput, deps: { generate: GenerateFn },
): Promise<{ categoryId: string; confidence: number } | null> {
  const safe = redactForLlm(input.text);
  if (!safe) return null;                                   // fail closed (spec §6)
  const names = input.categories.map((c) => c.name);
  const prompt =
    `Merchant: ${safe}\nAmount: ${amountBucket(input.amount)}\n` +
    `Pick exactly one category from the list, or answer UNSURE. Categories: ${names.join(", ")}`;
  const out = await deps.generate(prompt, names);
  if (!out) return null;
  const match = input.categories.find((c) => c.name === out.name);
  if (!match) return null;                                  // out-of-list → abstain
  return { categoryId: match.id, confidence: out.confidence };
}
```

(The production `generate` — wired in Task 7's deps — uses the Vercel AI SDK `generateObject` with a Zod enum of the category names + `confidence` + an `unsure` boolean, model via AI Gateway. It is injected, so this module needs no network and the default model stays a config knob.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat: PII-stripped LLM categorization tier (P3a)`.

---

### Task 6: Cascade orchestration (`categorize.ts`)

**Files:** Create `src/lib/categorize/categorize.ts`, `src/lib/categorize/categorize.test.ts`. Modify `src/lib/ledger/write.ts` (extend `WriteSource`).

**Interfaces:**
- Consumes: `embed` (`Embedder`), `nearestExamples`, `classifyWithLlm` (`GenerateFn`), `annotate`.
- Produces: `categorizeEntries(db, householdId, entryIds, deps): Promise<{ resolved: number; abstained: number }>` where `deps = { embed: Embedder; generate: GenerateFn; t1MinSim?: number; t2MinConf?: number }`.

- [ ] **Step 1: Extend `WriteSource`** in `src/lib/ledger/write.ts`:

```typescript
export type WriteSource = "user" | "system" | `rule:${string}` | `import:${string}` | `categorizer:${string}`;
```

- [ ] **Step 2: Failing test** `categorize.test.ts` (mock embed + generate; real DB for entries + examples):

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTransaction } from "@/lib/ledger/write";
import { recordExample } from "./examples";
import { categorizeEntries } from "./categorize";

const v = (f: number) => Array.from({ length: 384 }, () => f);
async function pending(bankId: string, desc: string) {
  return createTransaction(tdb, { accountId: bankId, date: "2026-03-01", amount: "-642.0000", description: desc, status: "pending" });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("categorizeEntries", () => {
  beforeEach(resetDb);

  it("T1: suggests the k-NN category above threshold (unlocked)", async () => {
    const { hh, bank, food } = await seedBasics();
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" });
    const id = await pending(bank.id, "ZOMATO");
    const r = await categorizeEntries(tdb, hh.id, [id], { embed: async () => v(0.9), generate: async () => null });
    expect(r.resolved).toBe(1);
    const [t] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id));
    expect(t.categoryId).toBe(food.id);
    expect(t.categoryLocked).toBe(false);                 // still a suggestion
  });

  it("T2: falls back to the LLM when no close example, abstains on null", async () => {
    const { hh, bank, food } = await seedBasics();
    const id = await pending(bank.id, "NEWPLACE");
    // no examples → T1 misses → T2
    const hit = await categorizeEntries(tdb, hh.id, [id], { embed: async () => v(0.5), generate: async () => ({ name: "Food & Dining", confidence: 0.95 }) });
    expect(hit.resolved).toBe(1);
    const id2 = await pending(bank.id, "MYSTERY");
    const miss = await categorizeEntries(tdb, hh.id, [id2], { embed: async () => v(0.5), generate: async () => null });
    expect(miss.abstained).toBe(1);
    const [t2] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id2));
    expect(t2.categoryId).toBeNull();
  });

  it("never overwrites a locked category", async () => {
    const { hh, bank, food, groceries } = await seedBasics();
    const id = await pending(bank.id, "ZOMATO");
    await tdb.update(schema.transactions).set({ categoryId: groceries.id, categoryLocked: true }).where(eq(schema.transactions.entryId, id));
    await recordExample(tdb, { householdId: hh.id, text: "zomato", categoryId: food.id, embedding: v(0.9), source: "accept" });
    await categorizeEntries(tdb, hh.id, [id], { embed: async () => v(0.9), generate: async () => null });
    const [t] = await tdb.select().from(schema.transactions).where(eq(schema.transactions.entryId, id));
    expect(t.categoryId).toBe(groceries.id);              // unchanged
  });
});
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement** `categorize.ts`:

```typescript
/**
 * Tiers T1 (local-embedding k-NN over the household's corrections) and T2 (LLM fallback)
 * for transaction entries that deterministic rules (T0, applyRulesTo) left uncategorized.
 * Suggests via annotate() with source 'categorizer:t1'|'t2' and categoryLocked=false; never
 * overwrites a locked category; abstains otherwise. Edges (embed/generate) are injected.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { annotate } from "@/lib/ledger/write";
import { normalizeMerchant } from "@/lib/import/sms";
import type { Embedder } from "./embed";
import { nearestExamples } from "./examples";
import { classifyWithLlm, type GenerateFn } from "./llm";

export interface CategorizeDeps {
  embed: Embedder; generate: GenerateFn; t1MinSim?: number; t2MinConf?: number; k?: number;
}

export async function categorizeEntries(
  db: Db, householdId: string, entryIds: string[], deps: CategorizeDeps,
): Promise<{ resolved: number; abstained: number }> {
  const t1 = deps.t1MinSim ?? 0.8, t2 = deps.t2MinConf ?? 0.7, k = deps.k ?? 5;
  const cats = await db.select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories).where(eq(schema.categories.householdId, householdId));
  let resolved = 0, abstained = 0;

  for (const entryId of entryIds) {
    const [entry] = await db.select().from(schema.entries)
      .where(and(eq(schema.entries.id, entryId), isNull(schema.entries.deletedAt)));
    if (!entry || entry.entryType !== "transaction") continue;
    const [txn] = await db.select().from(schema.transactions).where(eq(schema.transactions.entryId, entryId));
    if (!txn || txn.categoryId || txn.categoryLocked) continue;     // already categorized / locked

    const text = normalizeMerchant(txn.merchant || entry.description || "");
    if (!text) { abstained++; continue; }
    const vec = await deps.embed(text);

    // T1 — k-NN over corrections
    const near = await nearestExamples(db, householdId, vec, k);
    let chosen: string | null = null;
    if (near.length && near[0].sim >= t1) {
      const top = near[0].categoryId;
      const agree = near.filter((n) => n.categoryId === top).length >= Math.ceil(near.length / 2);
      if (agree) chosen = top;
    }
    let tier = "t1";
    // T2 — LLM
    if (!chosen) {
      tier = "t2";
      const out = await classifyWithLlm({ text, amount: entry.amount, categories: cats }, { generate: deps.generate });
      if (out && out.confidence >= t2) chosen = out.categoryId;
    }

    if (!chosen) { abstained++; continue; }
    // annotate guards sign-vs-classification and the locked field; non-'user' source stays unlocked
    try {
      await annotate(db, entryId, { categoryId: chosen }, `categorizer:${tier}` as const);
      const [after] = await db.select().from(schema.transactions).where(eq(schema.transactions.entryId, entryId));
      if (after?.categoryId === chosen) resolved++; else abstained++;  // sign-mismatch → annotate left it null
    } catch { abstained++; }
  }
  return { resolved, abstained };
}
```

- [ ] **Step 5: Run → PASS.**

- [ ] **Step 6: Commit** — `feat: 3-tier categorizer orchestration with abstain (P3a)`.

---

### Task 7: Production deps wiring (embed + AI Gateway generate)

**Files:** Create `src/lib/categorize/deps.ts`, `src/lib/categorize/deps.test.ts`. Modify `src/env.ts` (optional gateway key).

**Interfaces:**
- Consumes: `embed`, AI SDK.
- Produces: `defaultCategorizeDeps(): CategorizeDeps` — real embedder + a `generate` backed by `generateObject` (Zod-constrained), model from `process.env.CATEGORIZER_MODEL ?? "anthropic/claude-haiku-4-5"` via AI Gateway.

- [ ] **Step 1:** Add `CATEGORIZER_MODEL` (optional, defaulted) to `src/env.ts` server schema; document that AI Gateway auth uses the platform default (`AI_GATEWAY_API_KEY` or Vercel OIDC) — no key needed for local dev if calls are mocked.

- [ ] **Step 2:** Implement `deps.ts`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";
import { embed } from "./embed";
import type { CategorizeDeps } from "./categorize";
import type { GenerateFn } from "./llm";

export function defaultCategorizeDeps(): CategorizeDeps {
  const model = process.env.CATEGORIZER_MODEL ?? "anthropic/claude-haiku-4-5";
  const generate: GenerateFn = async (prompt, names) => {
    const schema = z.object({
      category: z.enum([...names, "UNSURE"] as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
    });
    try {
      const { object } = await generateObject({ model, schema, prompt });
      if (object.category === "UNSURE") return null;
      return { name: object.category, confidence: object.confidence };
    } catch { return null; }          // LLM failure → abstain, never throw into ingestion
  };
  return { embed, generate };
}
```

- [ ] **Step 3:** Test `deps.test.ts`: assert `defaultCategorizeDeps()` returns an object with `embed` and `generate` functions and respects `CATEGORIZER_MODEL` env (no network — just shape/wiring). Do NOT call the live model in tests.

- [ ] **Step 4: Run → PASS.** `pnpm exec tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `feat: production categorizer deps via AI Gateway (P3a)`.

---

### Task 8: Wire into import commit

**Files:** Modify `src/lib/import/pipeline.ts`. Add a test to `src/lib/import/pipeline.test.ts`.

**Interfaces:**
- Consumes: `categorizeEntries`, `defaultCategorizeDeps`.

- [ ] **Step 1: Failing test** in `pipeline.test.ts`: stage+commit a transaction import for a bank account where a matching example exists; inject deps so T1 resolves; assert the committed pending entry got a suggested (unlocked) category. (Mirror the existing import test setup; pass injected deps — see Step 2 for how commit accepts them.)

- [ ] **Step 2: Implement.** In `commitImport`, after the existing `applyRulesTo(db, householdId, transactionEntryIds)` call, add (transaction entries only):

```typescript
// T1/T2 categorization for entries rules left uncategorized. Never fails ingestion.
try {
  const deps = opts?.categorizeDeps ?? defaultCategorizeDeps();
  await categorizeEntries(db, householdId, transactionEntryIds, deps);
} catch {
  // categorization is best-effort; a failure leaves entries uncategorized for manual pick
}
```

Add an optional last parameter `opts?: { categorizeDeps?: CategorizeDeps }` to `commitImport` so tests inject mocks (default = real deps). Keep the SMS ingest route (`/api/ingest/sms`) calling `commitImport` unchanged — it picks up categorization automatically.

- [ ] **Step 3: Run → PASS**, then full `pnpm test` (no regression).

- [ ] **Step 4: Commit** — `feat: run categorizer on import commit (P3a)`.

---

### Task 9: Training-example capture on accept/correct

**Files:** Modify `src/lib/ledger/inbox.ts` (`acceptEntry`, `acceptAll`) and the recategorize server action. Add a test to `src/lib/ledger/inbox.test.ts`.

**Interfaces:**
- Consumes: `embed`, `recordExample`, `normalizeMerchant`.
- Produces: `recordExampleForEntry(db, entryId, source, embedder)` helper (in `src/lib/categorize/examples.ts`).

- [ ] **Step 1:** Add to `examples.ts`:

```typescript
import { normalizeMerchant } from "@/lib/import/sms";
import type { Embedder } from "./embed";
/** Capture a labeled training example from a now-categorized entry. No-op if uncategorized. */
export async function recordExampleForEntry(
  db: Db, entryId: string, source: "accept" | "correct", embed: Embedder,
): Promise<void> {
  const [row] = await db.execute(sql`
    SELECT a.household_id, COALESCE(t.merchant, e.description) AS text, t.category_id
    FROM entries e JOIN transactions t ON t.entry_id = e.id JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ${entryId}
  `).then((r) => (r as unknown as { rows: { household_id: string; text: string; category_id: string | null }[] }).rows);
  if (!row || !row.category_id) return;
  const text = normalizeMerchant(row.text || "");
  if (!text) return;
  await recordExample(db, { householdId: row.household_id, text, categoryId: row.category_id, embedding: await embed(text), source });
}
```

- [ ] **Step 2: Failing test** in `inbox.test.ts`: accept a pending entry with a category → assert a `categorization_examples` row exists for it (inject the embedder or use the real one).

- [ ] **Step 3: Implement.** In `acceptEntry`, after the category is set and the entry posted, call `recordExampleForEntry(db, entryId, categoryId ? "correct" : "accept", embed)` (use the real `embed`; wrap in try/catch so a training-write failure never blocks the accept). Do the same in `acceptAll` (source `"accept"`) and in the recategorize action (source `"correct"`). To keep `acceptEntry` testable without the model, add an optional embedder param defaulting to the real `embed`.

- [ ] **Step 4: Run → PASS**, then full `pnpm test`.

- [ ] **Step 5: Commit** — `feat: capture training examples on accept/correct (P3a)`.

---

### Task 10: Backfill + settings action

**Files:** Create `src/lib/categorize/backfill.ts`, `src/lib/categorize/backfill.test.ts`, `src/app/actions/categorize.ts`. Modify the settings page to add a button.

**Interfaces:**
- Consumes: `categorizeEntries`, `defaultCategorizeDeps`.
- Produces: `backfillCategories(db, householdId, deps): Promise<{ resolved: number; abstained: number; scanned: number }>`; server action `backfillCategoriesAction()`.

- [ ] **Step 1: Failing test** `backfill.test.ts`: seed 2 uncategorized + 1 locked + 1 already-categorized transaction; run backfill with injected deps (T1 hit); assert only the 2 uncategorized got suggestions, scanned counts correctly, and a second run is idempotent (no double-processing of the now-categorized ones).

- [ ] **Step 2: Implement** `backfill.ts`: query all transaction entries in the household where `category_id IS NULL AND category_locked = false AND deleted_at IS NULL`, in batches of 200, calling `categorizeEntries` per batch; sum results; return totals. Log nothing sensitive.

- [ ] **Step 3:** `src/app/actions/categorize.ts`: `backfillCategoriesAction()` — `requireHousehold`, call `backfillCategories(db, householdId, defaultCategorizeDeps())`, `revalidatePath("/inbox")`, return totals. Follow the existing server-action shape.

- [ ] **Step 4:** Add a "Categorize uncategorized" button to the settings page that calls the action and toasts the result. Minimal UI per DESIGN.md.

- [ ] **Step 5: Run → PASS** (lib test), `pnpm exec tsc --noEmit` clean, `pnpm build` succeeds.

- [ ] **Step 6: Commit** — `feat: one-time categorization backfill + settings action (P3a)`.

---

### Task 11: Inbox suggestion-source badge + acceptance

**Files:** Modify the inbox query (`src/lib/ledger/inbox.ts` list query) to expose the latest categoryId source, and the inbox row component to render a subtle badge. Create `docs/runbooks/p3a-acceptance.md`.

- [ ] **Step 1:** In the inbox list query, derive a `suggestionSource` per pending entry from the most recent `entry_events` row with `field='categoryId'` (values: `rule:*` → "rule", `categorizer:t1` → "learned", `categorizer:t2` → "AI", else none). Expose it on the row shape.

- [ ] **Step 2:** In the inbox row component, render a small muted badge ("rule" / "learned" / "AI") next to the suggested category. Tokens per DESIGN.md (`text-soft`, etc.); no new design direction. Manual-verify the badge renders and accept/correct still work.

- [ ] **Step 3: Acceptance.** Run full `pnpm test` (all green), `pnpm exec tsc --noEmit`, `pnpm build`. Then a headless end-to-end against `compound_dev` in an isolated, self-cleaning household (mirror `docs/runbooks/phase-2-acceptance.md` style): seed examples, create pending entries, run `categorizeEntries` with the **real** embedder + a stubbed generate, assert T1 suggestions land unlocked; accept one and assert a training example was recorded; run backfill and assert idempotence. Record results in `docs/runbooks/p3a-acceptance.md`. Clean up the household + its `categorization_examples`.

- [ ] **Step 4: Commit** — `chore: inbox suggestion-source badge + P3a acceptance`.

---

## Self-review (done at write time)

- **Spec coverage:** §3 architecture → file structure + Tasks 2–7; §4 cascade T0/T1/T2 → T0 existing, T1/T2 Task 6 (gates + abstain), edges Tasks 3/5/7; §5 learning loop → Tasks 1 (table), 4 (record/k-NN), 9 (capture on accept/correct); §6 privacy (local embeddings, PII allowlist, fail-closed) → Tasks 2 (redact), 3 (local embed), 5 (redact-before-LLM, no money), 7 (PII-stripped prompt); §7 integration + backfill → Tasks 8, 10; §8 inbox affordance → Task 11; §9 testing → each task's TDD + Task 11 acceptance; §10 open decisions (embedder placement contract, default model + thresholds, backfill trigger) → Tasks 3/7/10. No gaps.
- **Type consistency:** `Embedder` (T3) used by T6/T7/T9; `GenerateFn` + `classifyWithLlm` (T5) used by T6/T7; `recordExample`/`nearestExamples` (T4) used by T6/T9; `categorizeEntries`/`CategorizeDeps` (T6) used by T8/T10; `defaultCategorizeDeps` (T7) used by T8/T10; `WriteSource` extended (T6) covers `categorizer:${string}` used by T6's annotate calls; `categorizationExamples` (T1) used by T4. Consistent.
- **Placeholder scan:** lib/core tasks (1–7, 9–10) carry full test + implementation code; the two real external edges (embedder model, LLM model) are injected and defaulted, with the live model never called in tests; UI/integration steps carry exact hook points + the key code and manual-verify. No "TODO"/vague-validation placeholders.
- **Money discipline:** no money value through `Number()`; the LLM gets only `amountBucket`; `sim`/`confidence` are ratios (not money). Documented at each site.
- **Numeric/extension risk flagged:** Task 1 explicitly verifies the `vector` extension + hnsw index in the generated SQL and hand-adds if drizzle-kit omits them; Task 3 verifies the model's true dimension matches the schema's 384.
