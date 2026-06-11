# Personal Finance System — Master Design Spec

**Date:** 2026-06-11
**Owner:** Anmol Sen (single user now, product-later architecture)
**Status:** Approved design; Phase 1 implementation plan to follow as a separate doc.

---

## 1. Vision & context

An extensive personal finance system for an Indian user: expense tracking + budgets, investments + net worth, AI insights, and planning — fed by statement imports, email parsing, broker APIs, and quick manual entry.

User context that shapes the design:

- 22, first job (FDSE at Sarvam AI) starting next month; moving to Bangalore. Salary, rent + deposit, and real spending begin ~4 weeks from design date → **Phase 1 must be live before the first paycheck.**
- Education loan outstanding (moratorium → EMI; Section 80E interest deduction).
- Today: no tracking system; broker/MF accounts hold the only structured data.
- No Claude API access; AI must be provider-agnostic and cheap-to-free.
- Cost target: ₹0/month infrastructure (Vercel hobby, Neon free tier, free data sources).

Decisions locked during brainstorming:

- **Audience:** personal tool now, architected so multi-user product is possible later (no product features now).
- **Platform:** mobile-first PWA (Next.js); desktop cockpit later. No native app, no Capacitor for v1.
- **Hosting:** cloud — Vercel + Neon Postgres, Mumbai/Singapore region.
- **Approach:** ledger-first (Approach A) with investments pulled early (Phase 2) because India's CAS ingestion path is unusually high-ROI.

## 2. Research foundation

Five parallel research sweeps (~80 sources) inform this design: best-in-class OSS systems (Actual, Firefly III, Maybe Finance, Ghostfolio, Paisa), India ingestion landscape, ledger data-model practice, AI-in-finance patterns, and security/UX standards. Headlines:

1. **Immutable-events ledger, derived everything** is the converged pattern (Maybe's `Entry → Transaction | Trade | Valuation` is the best reference; community fork `we-promise/sure` continues it).
2. **India ingestion is a mosaic**: Account Aggregator is gated behind regulated-entity status (not feasible solo); CAMS/KFintech + NSDL **CAS mailback PDFs** give complete MF/equity/NPS history for free (`casparser`); AMFI publishes free daily NAVs; **Zerodha's personal Kite API is free since March 2025**; Gmail alert parsing is viable; SMS needs an Android forwarder (optional).
3. **AI: deterministic core, AI at the edges.** Every documented failure is an LLM allowed to compute or guess. Winning patterns: tiered categorization with abstention (Copilot), read-only tool-calling assistants (Maybe/Monarch), checksum-validated document parsing.
4. **The review inbox + weekly ritual is the product.** Apps die when imports pile up uncategorized.
5. The #1 "why I left" complaint across Firefly/YNAB/Actual: no investment tracking. Ship spending + investments in one system.

## 3. Architecture

Five layers; data flows downward only:

```
INGESTION (mosaic)   quick entry · bank CSV/XLS/PDF · CAS · prices cron · Gmail · broker API
      ↓ staged imports: parse → validate → stage → preview → commit
CORE LEDGER          entries (immutable core) · transfers · valuation anchors · rules engine
      ↓ pure recompute-from-anchor derivation jobs
DERIVED (cache)      daily balances · holdings · net worth series · monthly rollups · XIRR
      ↓ read-only typed query tools
EXPERIENCE + AI      PWA dashboard · review inbox · Ask/Notice/Recap · MCP server · planning
```

**Stack:** Next.js (App Router, RSC) on Vercel · Neon Postgres (Mumbai) · Drizzle ORM · Better Auth (Google OAuth + passkeys, single-user allowlist) · shadcn/ui + Recharts · Vercel crons · AI via Vercel AI SDK (provider-agnostic; Gemini Flash free tier / GLM / local embeddings).

## 4. Data model

### 4.1 The one rule

`entries` is the immutable truth: one signed money event per row, subtyped as **transaction** (spending/income), **trade** (instrument event), or **valuation** (absolute balance anchor). Balances, holdings, net worth, and rollups are derived tables a job can rebuild from scratch at any time.

### 4.2 Core tables

- `households`, `users` — every row in every table scoped by `household_id` from day one.
- `accounts` — kinds: `bank · cash · credit_card · investment · epf · ppf · fd · property · gold · crypto · loan · wallet · receivable`. `currency` (default INR), `excluded` flag, metadata jsonb (last-4 only, folio, rate, lender).
- `entries` — `(account_id, entry_type, date, amount NUMERIC(19,4), currency, status pending|posted|reconciled, external_id, import_hash, import_id, deleted_at, …)`.
- `transactions` — category, merchant, tags; splits in `transaction_splits`.
- `trades` — instrument, type `buy|sell|dividend|fee|interest`, quantity (6dp), unit price (4dp), fees.
- `corporate_actions` — `split|bonus` (and later `demerger`) live **outside** the cash ledger; consumed by holdings replay only. No ₹0 magic rows in `entries`.
- `valuations` — kind `opening_anchor|reconciliation|appraisal`; amount = absolute balance at date.
- `transfers` — links outflow/inflow entries; `rejected_transfers` remembers dismissed auto-matches.
- `instruments` (ISIN / AMFI code / asset class) + `instrument_prices` (daily).
- `categories` (group → category, one level; income|expense classification), `tags` (incl. `80C`, `80E`, `80G`, trip/reimbursable), `rules` (ordered triggers → actions).
- `budget_allocations` (month × category × assigned, `rollover_mode none|accumulate`) — envelope-ready.
- `imports` + `import_rows` — staging, preview, undoable commits.
- `entry_events` — append-only audit log of every annotation change `(entry_id, field, old, new, source user|rule|import, at)`.
- Derived: `balances` (account × day), `holdings` (account × instrument × day), `rollups` (month × category).

### 4.3 Correctness invariants (from adversarial review — MUST-FIX, non-negotiable)

Two adversarial reviews (India edge cases; ledger correctness) found four silent-corruption classes. These fixes are part of the design, not options:

1. **Dedup keys include amount, sign, and source row ordinal.** `external_id` uniqueness alone drops legitimate duplicates (3 × ₹20 chai same day) and UPI debit+reversal pairs sharing one RRN. All unique indexes are partial: `WHERE deleted_at IS NULL`. Dedup behavior against tombstones is explicit: matches consider live rows only; undo + re-import re-creates entries.
2. **Anchor-vs-entries reconciliation rule:** when a valuation anchor disagrees with computed deltas, the engine **materializes the difference as a visible adjustment entry** (EPF interest, FD interest, cash drift, loan interest) — never silently snaps a balance. This single rule powers EPF, FD, cash, and edu-loan interest tracking.
3. **Sign convention, structurally enforced:** `amount` is always the signed delta to *that account's own balance*. Liability accounts (credit_card, loan) store balances negative; reported "outstanding" is negated on ingest. CHECK constraints on derivable `(entry_type, kind, account_class) → sign` combinations. Net worth = Σ assets − Σ liabilities computed in exactly one function.
4. **Inter-account movement is ONLY ever a transfer** (no parallel `cc_payment` transaction path → no double-counting). Transfer integrity in the DB: both legs FK NOT NULL `ON DELETE RESTRICT`, different accounts, same-currency legs net to zero (fees are separate expense entries), no soft-deleting a leg of a confirmed transfer.
5. **Derivations are pure recompute-from-nearest-anchor** — never stateful incremental accumulators. Idempotent `rebuild(account_id, from_date)` in one transaction with a per-account lock; backdated entries invalidate by date. A test asserts incremental == full rebuild.
6. **Nightly invariant-check cron** (~50 lines) → `ledger_anomalies`: transfer legs balance and are live, splits sum to parent (largest-remainder allocation; split parent's own category is NULL — XOR enforced), anchors-vs-deltas residual surfaced, no orphans. This buys back double-entry's safety at single-entry's ergonomics.
7. **User edits win, forever:** typed `*_locked` boolean columns (not free-form jsonb) mark fields the user set manually; rules and re-imports never overwrite them. All annotation changes append to `entry_events`.
8. **Money never touches JS `Number()`** — Drizzle NUMERIC-as-string respected; arithmetic through a decimal path; round on display only. `Intl.NumberFormat('en-IN')` everywhere: `₹1,23,456`, lakh/crore compact (with runtime-consistency fallback helper), tabular-nums, paise dropped ≥ ₹1,000.

### 4.4 India-specific modeling

- **EPF:** contribution entries (known monthly) + annual passbook valuation anchor; interest materialized by the reconciliation rule.
- **FD:** open = transfer; cumulative growth via periodic appraisal anchors; premature break = final anchor + transfer + penalty expense.
- **Education loan:** `loan` account; EMI = transfer (principal) with interest materialized via lender-statement anchors as a visible expense tagged `80E`; moratorium period = anchors only, no payments.
- **Rent deposit:** `receivable` account — transfer out (asset preserved, not expense); partial refund = transfer back + deduction expense.
- **Wallets/UPI Lite:** `wallet` accounts; top-up = transfer; Lite's invisible spends reconciled by cash-drift anchors.
- **Split bills / reimbursements:** repayment credits categorized as contra-expense in the original category (convention); `receivable` for larger loans-to-friends.
- **Salary:** record **net** as income (gross/TDS/PF reconstruction is over-engineering; EPF tracks itself via anchors).
- **MF:** SIP = recurring buys keyed by AMFI code; IDCW-reinvest = dividend + linked buy; scheme switch = sell + buy (taxable), never a transfer.
- Categories taxonomy India-native: Food & Dining (Swiggy/Zomato), Groceries (Blinkit/quick-commerce), Transport (fuel/auto/metro), Rent & Maintenance, Domestic Help, Utilities (electricity/mobile/cylinder), EMI & Interest, Insurance, Health, Festivals & Gifts, Donations (80G), Subscriptions, Travel, Personal Care, Taxes & Charges; Income: Salary, Interest, Dividends, Cashback, Refunds.

### 4.5 Known deferred gaps (documented, not blind spots)

- No-cost-EMI purchase grouping (`entry_group_id`) — until built, monthly spend needs manual hygiene on EMI buys.
- `card_statements` table (statement cycle, due/min-due UX) — add with the card-management UI.
- Per-component trade fees (STT vs brokerage) — needed only for tax-grade capital gains reports.
- `settlement_date` vs trade date; demergers/segregated portfolios (hack via sell+buy if they occur).
- FX rate table + cross-currency transfers — only when a non-INR asset first appears (design allows legs to differ across currencies with explicit fx_rate; not built until needed).

## 5. Ingestion

One staged pipeline for every source; nothing writes to the ledger directly:

**receive → parse → validate → stage → preview → commit**

- **Parse:** deterministic-first. Per-bank CSV/XLS parsers (most stable formats); PDF statements (incl. password-protected) as fallback; `casparser` for CAMS/KFintech CAS; NSDL CAS for equity/NPS; regex templates per bank email sender. LLM's role: handle unknown layouts and *write new regex templates once* — not parse every document.
- **Validate:** balance-continuity checksum (`prev balance + amount = next balance` per row) and opening/closing totals reconciliation. Parse failures are detectable, routed to review — never silent.
- **Stage:** hardened dedup (§4.3.1), transfer auto-matching (amount/date window, user-confirmable, rejected-match memory), rules pass (respecting locked fields).
- **Preview → commit:** "23 new, 4 duplicates, 1 suspicious" before anything lands; imports undoable as a unit.
- **Statement files are parsed and discarded** — structured rows with masked numbers only; no PDF archive in cloud storage.

Sources & cadence: quick entry (P1, ≤3 taps, offline outbox) · bank CSV/XLS/PDF upload (P1, weekly/monthly) · CAS mailback (P2, monthly) · AMFI NAV + NSE EOD cron (P2, daily, zero user action) · Gmail readonly OAuth polling (P3, ~15 min) · Kite personal API tap-to-sync / Console CSV (P4). SMS via local Mac bridge (P1.5, near-real-time): owner is iPhone+UPI so bank/UPI/card/BNPL SMS — mirrored to the Mac via Text Forwarding, read from chat.db — is the primary live feed and beats Gmail; reuses the import pipeline. See `2026-06-12-sms-ingestion-bridge.md`. Account Aggregator: design import contracts to be AA-compatible (ReBIT-ish shapes), but AA is product-stage only.

## 6. Review inbox (the daily heartbeat)

Auto-ingested entries land `pending` with a badge count. 30-second sweep: swipe right = accept suggested category, swipe left = pick, long-press = bulk. Explicit "All caught up ✓" empty state. Two trust rules: the categorizer **abstains instead of guessing** below confidence; **every correction becomes permanent training signal** (rule or embedding example). Transfers and anomalies confirm here too.

## 7. Agentic system (deterministic core, agents at the edges)

Not a chatbot feature — a substrate that many agents run on. Four shared components, built once in P4:

1. **Tool registry.** Read-only typed query tools over the ledger (`spending_by_category`, `net_worth_at`, `xirr`, `recurring_charges`, `holdings`, `loan_status`, `goal_progress`, …) plus **proposal tools** (draft-write: propose recategorization, propose rule, propose budget change, propose valuation anchor). The same registry is exposed three ways: in-app chat, scheduled agent runs, and an **MCP server** so Claude or any MCP client becomes a finance assistant for free.
2. **Proposal queue.** Agents never write to the ledger. Every agent-initiated change is a proposal that surfaces in the review inbox for one-tap approve/reject — the same muscle memory as transaction review. Approved proposals execute through the same validated write path as manual edits and land in `entry_events` with `source=agent:<name>`.
3. **Triggers.** Scheduled (Vercel crons), event-driven (import committed, anomaly detected, NAV refresh done), and on-demand (chat / MCP).
4. **Run log.** Every agent run recorded: trigger, tools called with arguments, output, model + token cost. Any number an agent states must trace to a tool receipt in the log — unverifiable claims are a bug.

**Agent roster** (each is small; the substrate does the heavy lifting):

| Agent | Trigger | Does | Phase |
|---|---|---|---|
| Categorizer | import committed | T0 rules → T1 local embeddings k-NN over own corrections (confidence-gated) → T2 small-LLM fallback, closed category list, abstains when unsure | P3 |
| Template writer | unknown email layout | writes a new regex template once; deterministic parsing thereafter | P3 |
| Hygiene | nightly | preps the review inbox: dedup suspicions, unmatched transfers, stale anchors (e.g. "EPF anchor is 9 months old") | P4 |
| Notice | daily after rollups | statistics decide anomalies (price-hike on recurring charge, duplicate, category > 2σ vs trailing baseline); LLM writes the one-sentence explanation only | P4 |
| Recap | Sunday ~6pm IST cron | digest email: spent vs last week, top 3 categories, unreviewed count, one anomaly — every figure deep-links. No drip push notifications | P4 |
| Ask | on demand | conversational Q&A over the tool registry; narrates, never computes | P4 |
| Product evaluator | on demand | see §10 — policy-document-grounded IRR analysis of pitched products | P5 |
| Planner | monthly + on demand | quarterly-style review: emergency-fund runway, prepay-vs-invest (80E math), SIP step-up, tax regime check, goal drift; outputs analysis + proposals | P5 |

**Hard rules for every agent:** no money movement, ever (not in scope at any phase); no ledger writes without human approval; all arithmetic via tools (LLM never computes); product/market facts come from fetched documents, never model memory; PII allowlist on anything sent to a cloud model (amounts/categories/dates yes; names/account numbers never); embeddings local. Provider-agnostic via Vercel AI SDK / AI Gateway — model choice is a config knob, not architecture.

## 8. Experience

Mobile-first PWA, dark-first with light mode, installable (iOS coach-mark for Add to Home Screen). First screen hierarchy: **one hero number** (this month's spend → later safe-to-spend) → metric cards with sparklines → needs-attention strip (unreviewed, anomalies, upcoming bills) → recent transactions. Month pager. Tap-to-inspect charts (max ~6 categories then "Other"). Plain words, not jargon ("left to spend"). Green/red strictly for money direction. Offline: read cache + quick-entry outbox replayed on reconnect (no full offline editing). Performance: RSC + precomputed rollups; charts as client islands on pre-aggregated props; virtualized lists.

## 9. Security

- Better Auth: Google OAuth bootstrap + passkey enrollment; magic-link recovery. **Middleware allowlist: only the owner's email authenticates.**
- DB-backed sessions; `__Host-` cookies `HttpOnly; Secure; SameSite=Lax`; rotation on login; rate limits on auth + mutations; CSP/HSTS headers.
- Neon Mumbai, TLS enforced, provider AES-256 at rest; app-level AES-256-GCM only for the few genuinely sensitive metadata fields.
- Never stored: full account numbers (last-4 only), credentials, PAN/Aadhaar, statement PDFs (parse → discard).
- Secrets in Vercel env vars, Zod-validated at startup, nothing `NEXT_PUBLIC_`.
- Backups: nightly encrypted `pg_dump` via GitHub Action → object storage (Neon free PITR ≈ 6h is not a backup); restore tested once; Neon branch before destructive migrations.
- DPDP: personal-use exempt today; `household_id` everywhere, soft deletes, export endpoint, audit log = 80% of product-stage readiness already done.

## 10. Roadmap (each phase = its own spec → plan → build)

| Phase | Scope | Target |
|---|---|---|
| **P1 Core ledger + PWA** | auth, accounts, quick entry, bank CSV/XLS/PDF import pipeline, review inbox, rules, categories, simple monthly budgets, hero-number dashboard, invariant cron, backups | ~2 wks — live before first paycheck |
| **P1.5 SMS bridge** | real-time bank/UPI/card/BNPL SMS capture via local Mac bridge (Text Forwarding + chat.db) → `/api/ingest/sms` → existing pipeline → inbox; reuses staging/dedup. Owner is iPhone+UPI, so SMS beats Gmail. See `2026-06-12-sms-ingestion-bridge.md` | ~weekend — after the UI reskin, before P3 |
| **P2 Investments + net worth** | CAS ingestion (MF/equity/NPS), instruments + AMFI/NSE price crons, holdings replay, XIRR, net worth chart, valuation anchors UI (EPF/FD/gold/loan) | ~1-2 wks |
| **P3 Auto-ingestion + smart categorize** | Gmail readonly polling + per-bank templates, embeddings tier, LLM fallback, learning loop | ~2 wks |
| **P4 Agent substrate + first agents** | tool registry, proposal queue, triggers, run log, MCP server; Hygiene + Notice + Recap + Ask agents; Kite sync | ~2 wks |
| **P5 Plan (22-year-old edition)** | safe-to-spend, emergency-fund runway, first-SIP planning, edu-loan prepay-vs-invest with 80E math, new-vs-old tax regime, "can I afford X", envelope budgets if wanted, **product evaluator agent** (below) | ongoing |

**Product evaluator agent (P5, deferred by choice):** given a financial product pitch (insurance/ULIP/endowment plan, FD scheme, NPS tier), the agent fetches the actual policy terms, extracts the premium/payout schedule, computes real IRR **deterministically through the same math engine as the ledger** (never LLM arithmetic), compares against benchmark alternatives (term + index SIP, FD), and assesses fit against full ledger context (income, holdings, edu-loan, emergency fund) via the same read-only query tools as Ask. Output is analysis with visible arithmetic, not advice; product terms must come from fetched documents, never from model memory. Recorded now so P4's tool layer is designed to feed it.

## 11. Success criteria

- **P1:** a BLR expense logged in ≤3 taps; a full HDFC/ICICI statement imported with zero silent drops/dupes; dashboard loads < 1s on phone; review inbox reaches "All caught up" daily in < 1 min.
- **P2:** net worth (bank + MF + stocks + EPF + FD − credit card − edu loan) on one chart, with XIRR per holding, refreshed daily with zero manual effort beyond a monthly CAS email.
- **System:** `ledger_anomalies` stays empty in steady state; any derived table can be dropped and rebuilt bit-identically; a year of use produces zero unexplained net-worth drift.

## 12. Out of scope (explicitly)

Account Aggregator integration, multi-user onboarding/product features, native apps, SMS parsing (unless Android forwarder experiment), tax filing, money movement of any kind (the system never initiates transactions anywhere), retirement-grade planning.
