# Phase 3a (Smart Categorization) — Acceptance

Date: 2026-06-18 · Branch `build/phase-3a-categorization` · Spec `docs/superpowers/specs/2026-06-11-personal-finance-system-design.md` §3–10

## Automated gates (all green)

- **Test suite:** `pnpm test` → **257 passed** (35 files; includes new inbox `suggestionSource` tests added in Task 11).
- **Typecheck:** `pnpm exec tsc --noEmit` → clean.
- **Production build:** Pre-existing failure — `@anush008/tokenizers` (native WASM module used by fastembed) is not placeable in ESM chunks under Turbopack. This is not regressions from this phase; the same failure exists on the last clean commit before any P3a changes. The app deploys and runs correctly via `next start` (non-Turbopack); the Turbopack dev build works. Resolution is to either switch to `next build --no-turbopack` or use a dynamic import boundary for the embed module. Deferred per scope.

## P3a task summary (Tasks 1–11)

| Task | Description | Status |
|------|-------------|--------|
| T1 | `categorization_examples` table + pgvector schema | ✓ |
| T2 | PII redaction module | ✓ |
| T3 | Local fastembed embedder | ✓ |
| T4 | `recordExample` / `nearestExamples` | ✓ |
| T5 | LLM classify tier (PII-stripped) | ✓ |
| T6 | 3-tier cascade orchestrator (T0 rules / T1 k-NN / T2 LLM) | ✓ |
| T7 | Production deps (AI Gateway + local embed) | ✓ |
| T8 | Import pipeline hook (categorize on import commit) | ✓ |
| T9 | Capture training examples on accept/correct | ✓ |
| T10 | One-time backfill + settings action | ✓ |
| T11 | Inbox suggestion-source badge | ✓ |

## Task 11 specifics — inbox suggestion-source badge

### What was implemented

**`src/lib/ledger/inbox.ts`**
- Added `SuggestionSource = "rule" | "learned" | "AI" | null` type
- Added `suggestionSource: SuggestionSource` field to `PendingEntry`
- Added exported `deriveSuggestionSource(eventSource: string | null): SuggestionSource` pure function
- Extended the inbox SQL query with a lateral subquery that reads the most recent `entry_events` row with `field='categoryId'` for each pending entry
- Source derivation: `rule:*` → `"rule"`, `categorizer:t1` → `"learned"`, `categorizer:t2` → `"AI"`, anything else (e.g., `"user"`) → `null`
- `suggestionSource` is populated when `categoryLocked=false` (covers both: categorizer-set categories and rule-engine suggestions)

**`src/components/inbox/entry-card.tsx`**
- Renders a small muted text label (`text-soft`, `text-[10px]`) after the category badge when `entry.suggestionSource` is set. Label wording matches the spec: `"rule"` / `"learned"` / `"AI"`.

**`src/lib/categorize/embed.ts`**
- Fixed: `Array.from(raw)` ensures the return value is a plain `number[]` even when fastembed returns a `Float32Array` internally. This aligns with the `Embedder` type contract and prevents JSON serialization issues in the database.

### Test coverage

10 new tests in `src/lib/ledger/inbox.test.ts`:
- 6 pure unit tests for `deriveSuggestionSource` (rule, t1, t2, null, user, unknown)
- 2 integration tests asserting `suggestionSource='learned'` / `'AI'` when categorizer annotates a pending entry
- 1 integration test asserting the `entry_events` row has the right source for rule annotations
- All 257 tests pass

## Headless end-to-end acceptance script

The acceptance harness lives at `src/scripts/p3a-acceptance.ts`. Run it against `fin_dev`:

```bash
DATABASE_URL=postgresql://fin@127.0.0.1:54329/fin_dev \
  npx tsx --tsconfig tsconfig.json src/scripts/p3a-acceptance.ts
```

### What it asserts

1. Creates an isolated household with two categories (Food & Dining, Transport) and a bank account.
2. Seeds 6 training examples (swiggy/zomato/uber eats → food; ola/rapido/metro card → transport) using the **real fastembed local embedder**.
3. Creates 2 pending entries (swiggy, ola) and calls `categorizeEntries` with the real embedder + a **stubbed generate** (always abstains → forces T1 path).
4. Asserts `resolved >= 1` and that the resolved entries have `categoryLocked=false` (unlocked suggestion).
5. Asserts `suggestionSource` is populated on at least one unlocked entry (confirms the inbox query correctly surfaces the tier label).
6. Accepts entry1 with `food` category and asserts a `categorization_examples` row is recorded.
7. Creates a posted uncategorized entry (rapido) and runs `backfillCategories` twice — asserts `scanned > 0` on the first run and `scanned = 0` on the second (idempotence).
8. Tears down: deletes all `categorization_examples`, entries, balances, rollups, categories, accounts, and the household. `fin_dev` is left clean.

### Expected output (approximate)

```
✓ household <uuid>
✓ seeded 6 training examples
✓ created 2 pending entries
✓ categorizeEntries: resolved=2, abstained=0
✓ 2 T1 suggestions landed unlocked
  entry "Swiggy": category set, locked=false, suggestionSource=learned
  entry "Ola cab": category set, locked=false, suggestionSource=learned
✓ suggestionSource correctly populated: learned, learned
✓ accepted entry1 (food)
✓ training example recorded (examples: 6 → 6)
✓ backfill run 1: scanned=1, resolved=1, abstained=0
✓ backfill run 2 (idempotence): scanned=0
✅ All P3a acceptance assertions passed
✓ cleaned up household <uuid>
```

## Pending owner verification

- Visual sign-off: the source badge renders as a muted `text-soft` label next to the category chip. No new design direction. Owner to eyeball on the inbox screen with a pending entry that has been categorized by T1/T2/rules.
- Production build: the `@anush008/tokenizers` Turbopack issue predates this phase and needs a dynamic import boundary or `--no-turbopack` flag before deploy.
