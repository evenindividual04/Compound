# Smart Categorization (P3a) — Design Spec

> Auto-categorizes captured transactions with a *suggested* category that lands in the
> existing review inbox, learns from every correction, and **abstains rather than guesses**.
> First half of P3 (the second is Gmail ingestion, a separate spec). Improves every source
> already flowing in (P1.5 SMS, P1 CSV/XLS imports).
>
> Companion to the master spec (`2026-06-11-personal-finance-system-design.md` §6 Review
> inbox, §7 Categorizer agent + hard rules). Builds on the P1 deterministic rules engine
> (`src/lib/ledger/rules.ts`) and the existing import pipeline. Created 2026-06-17.

## 1. Why this exists

Capture is solved: SMS lands UPI/card spend in near-real-time (P1.5), CSV/XLS imports land
statements (P1), trades land via the pipeline (P2). But every captured entry arrives
**uncategorized** unless a deterministic rule happens to match — so the owner still hand-picks
a category for most entries in the review inbox. Categorization is the daily friction and the
data-quality foundation everything downstream (budgets, the eventual planning brain) reasons
over. This makes categorization *mostly automatic and self-improving* while keeping the human
as the one-tap approver.

## 2. Goal & non-goals

- **Goal:** a 3-tier categorizer (rules → local-embedding k-NN over the owner's own
  corrections → small-LLM fallback) that attaches a **suggested, unlocked** category to
  pending entries, abstaining when unsure; every accept/correction becomes a permanent
  training example; a one-time backfill over existing uncategorized entries.
- **Non-goals (explicit):**
  - **Auto-posting.** The categorizer only *suggests*; entries stay `pending` and the human
    accepts/corrects in the review inbox (§6 trust model). It never writes a posted category
    without approval, and never overwrites a manually-locked category.
  - **Gmail ingestion / template writer** — the other half of P3, separate spec.
  - **The full P4 agent substrate** (tool registry, proposal queue, MCP, run-log). The
    Categorizer runs inline in the import-commit flow; it does not require P4. Audit is via
    the existing `entry_events`.
  - **New categories.** The category set is closed (the P1 taxonomy); the LLM may only pick
    from it or abstain — never invent one.
  - **Sending PII to a cloud model** — see §6.

## 3. Architecture

A small pure-orchestration library plus one training table, hooked into the existing
commit-import path. Nothing writes to the ledger outside the validated `annotate()` path.

```
src/lib/categorize/
  embed.ts        local sentence-embedding (transformers.js/fastembed, MiniLM, 384-dim)
  examples.ts     training corpus read/write (categorization_examples + pgvector k-NN)
  redact.ts       PII stripping before any cloud call
  llm.ts          T2 fallback via Vercel AI SDK / AI Gateway (closed list, abstain)
  categorize.ts   orchestrates T0→T1→T2, confidence gates, abstain; pure + tested
  backfill.ts     one-time pass over existing uncategorized entries

integration: src/lib/import/pipeline.ts commitImport → after applyRulesTo, run the
  categorizer over the new pending entries that rules left uncategorized.
```

The cascade is deterministic orchestration around two non-deterministic edges (the local
embedder and the LLM). Those edges are injected so `categorize.ts` is unit-tested with mocks;
the thresholds, tier-escalation, and abstain logic are tested deterministically.

## 4. The 3-tier cascade

Input per entry: the normalized merchant/description (the SMS parser already produces a
clean merchant via `normalizeMerchant`; CSV rows use the description), the signed amount, and
the closed category list (with each category's `classification`).

- **T0 — Rules** (existing `applyRulesTo`): deterministic merchant/amount conditions. A match
  sets the category and we stop. Already runs in `commitImport`; unchanged.
- **T1 — Local-embedding k-NN over the owner's corrections.** Embed the entry text with a
  **local** model (no cloud embedding API). Query `categorization_examples` for the k nearest
  by cosine (pgvector). Accept the majority category iff: (a) the top-k share a single category
  by a margin, AND (b) the nearest cosine similarity ≥ `T1_MIN_SIM` (default 0.80). Otherwise
  escalate. This is the tier that encodes the owner's personal habits and grows over time.
- **T2 — Small-LLM fallback** (only when T0/T1 didn't resolve). Build a PII-stripped prompt
  (§6): redacted merchant text + an amount magnitude bucket + the closed category list. The
  model must return **one category from the list** plus a confidence, or the sentinel
  `UNSURE`. Accept iff in-list and confidence ≥ `T2_MIN_CONF`; else **abstain** → the entry
  stays uncategorized (a manual pick in the inbox). The model never computes and never sees
  raw amounts beyond a bucket. Provider/model is a config knob via AI Gateway.

A resolved suggestion sets `transactions.categoryId` with `categoryLocked = false`,
`source = 'categorizer:t1' | 'categorizer:t2'`, logged in `entry_events`. The sign-vs-
classification guard (ADR-1) still applies — a suggested category whose classification
contradicts the amount sign is rejected and treated as abstain.

## 5. Learning loop

New table **`categorization_examples`**:
`{ id, householdId, text, categoryId → categories.id, embedding vector(384), source: 'accept' | 'correct', createdAt }`,
with an ivfflat/hnsw index on `embedding` for cosine k-NN. A migration also runs
`CREATE EXTENSION IF NOT EXISTS vector` (Neon supports pgvector).

- When the owner **accepts** a suggested category or **corrects** to a different one in the
  review inbox, write one example: the entry's normalized text, the chosen category, and its
  embedding. Corrections are the highest-signal examples.
- T1 reads this corpus. As it grows, T1 resolves more and T2 (cloud) calls trend toward zero —
  the system gets more private and cheaper with use.
- De-dup examples by `(householdId, text, categoryId)` so repeated identical merchants don't
  bloat the corpus; keep the most recent.

This realizes the master spec's §6 rule: *every correction becomes permanent training signal.*

## 6. Privacy (hard rules, from master spec §7)

- **Embeddings are local.** Computed by an in-process model, never a cloud embedding API.
  Merchant text is embedded on the owner's own infrastructure only.
- **PII allowlist for the T2 cloud LLM.** Send: redacted merchant string, amount *bucket*
  (not the exact value), category list. **Never send:** account numbers, full amounts,
  personal names. `redact.ts` strips long digit runs / masked-account patterns and, for
  P2P-style descriptions, the counterparty token; brand merchants (Zomato, Swiggy) pass
  through. If redaction can't confidently strip a description, the entry **abstains** rather
  than risk leaking — fail closed.
- Provider-agnostic via Vercel AI SDK / AI Gateway; model is config, not architecture.
- The LLM classifies only; it performs no arithmetic and sees no balances.

## 7. Integration & backfill

- **Forward:** in `commitImport`, after `applyRulesTo` over the newly-created pending entries,
  run the categorizer on those still uncategorized (transaction entries only; trades and
  transfers are excluded). Suggestions land on the pending entries → the review inbox shows
  them. Runs within the existing commit flow; if the categorizer errors (e.g. LLM timeout),
  it is caught and the entry simply stays uncategorized — ingestion never fails because
  categorization did.
- **Backfill:** a one-time function (invokable from a small settings action) over existing
  **uncategorized, unlocked** transactions, applying T1/T2 and writing suggestions in batches.
  Local-first keeps cloud cost low; it logs how many it categorized vs left for manual review.
  Idempotent (skips already-categorized/locked entries).

## 8. Review inbox affordance (minimal)

The inbox already renders pending entries with accept/recategorize/bulk (P1). Add only a
subtle indicator of the suggestion's **source** (rule / learned / AI) so the owner can
calibrate trust at a glance. No new design direction; obeys `DESIGN.md`. Accept and correct
already exist — they additionally write the training example (§5).

## 9. Correctness & testing

- `categorize.ts` orchestration unit-tested with a mock embedder and mock LLM: T0 hit; T1 hit
  above threshold; T1 escalation below threshold; T2 accept; T2 abstain; sign-vs-classification
  rejection; locked-category never overwritten.
- `redact.ts` unit-tested: account numbers and long digit runs stripped; brand merchants kept;
  unredactable input fails closed.
- `examples.ts` integration-tested against the test DB (pgvector): insert examples, k-NN
  returns nearest by cosine, de-dup works.
- Backfill integration-tested: only uncategorized/unlocked entries touched; idempotent.
- No money value ever passes through `Number()`; the LLM receives only a bucket. Existing
  invariants and the `entry_events` audit cover the writes.

## 10. Open decisions (deferred to plan, by choice)

- **Embedding runtime placement:** in-app via transformers.js/fastembed (recommended, self-
  contained) vs computed on the Mac bridge (fallback if the model is too heavy for the Vercel
  function). Locked as a *contract* (a `embed(text) → number[384]` function); the concrete
  placement is a plan-time/deploy-time choice. Works in-app locally today.
- **Default T2 model** (small/cheap via AI Gateway) and the exact `T1_MIN_SIM` / `T2_MIN_CONF`
  thresholds — tuned during implementation against real corrections; conservative defaults
  (0.80 / high) chosen so the system abstains more than it mis-guesses early on.
- **Backfill trigger surface** — a settings button vs an automatic first-run pass; proposed a
  manual button to keep cloud cost owner-controlled.

These do not block the spec; flagged for the plan and the owner's review.
