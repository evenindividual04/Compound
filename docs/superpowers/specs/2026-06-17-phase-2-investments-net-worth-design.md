# Investments + Net Worth (P2) — Design Spec

> Adds market-priced unit holdings (mutual funds + direct equity) on top of the P1
> ledger, so net worth reflects the whole picture — bank + MF + equity + EPF/FD/gold
> − credit cards/loans — refreshed daily with near-zero manual effort.
>
> Companion to the master spec (`2026-06-11-personal-finance-system-design.md` §10 P2,
> §11 P2 success criteria, §4.2 core tables, §4.3 invariants). Created 2026-06-17.
> Builds strictly on the locked P1 architecture: immutable `entries`, derived state as
> pure recomputation, money in the string domain end-to-end (`src/lib/money.ts`).

## 1. Why this exists

P1 makes spend and bank/anchor balances correct. But the owner's net worth is dominated
over time by **invested** assets — mutual funds and direct equity — whose value changes
daily with market prices, not with transactions. P1 can hold these only as static
`appraisal` anchors (a number you type in), which goes stale immediately and carries no
units, cost basis, or return. P2 makes invested assets **first-class**: every buy/sell is
a ledger entry, holdings are replayed from those entries, and current value comes from a
daily price feed. The result is a single net-worth chart that is true today, not at the
last time you manually updated a number, plus per-holding XIRR so you can see what each
position is actually returning.

The owner is **early-stage** (first paycheck incoming; first SIP is a P5 topic), so the
holdings set is small and may be scattered across Zerodha and/or Groww. The design favors
the lightest path that meets the goal and defers anything that earns its keep only at
larger scale (notably CAS PDF parsing).

## 2. Goal & non-goals

- **Goal:** model MF + equity holdings as `trade` entries; replay holdings (units + avg
  cost) from those entries; price MF daily from AMFI and equity best-effort daily; compute
  per-holding and portfolio XIRR deterministically; surface a combined net-worth breakdown
  chart. All on the existing import pipeline and ledger invariants — no new ledger logic.
- **Non-goals (explicit):**
  - **NPS** — owner does not hold it. Not modeled. (The `instruments.kind` enum leaves room
    to add it later without migration churn beyond a value.)
  - **CAS PDF parsing** (CAMS/KFintech MF CAS, NSDL/CDSL demat CAS) — password-protected
    PDFs; stays deferred to **P3**, where Gmail polling + PDF tooling land anyway (per the
    P1 plan's documented deviation). P2 ingests via broker CSV/Excel + manual entry.
  - **EPF / FD / gold** — already handled by P1's anchor/valuation flow. P2 does not change
    how they are entered; it only folds their derived balances into the net-worth chart.
  - **Money movement** — never. Read-only over the owner's data, like all phases (§12).
  - **Corporate actions automation** (splits, bonuses, dividends reinvested) — handled as
    manual `trade`/`valuation` entries in P2; automated detection is out of scope.

## 3. Architecture

P2 is a strict extension of the P1 ledger. Nothing about the one rule changes: `entries`
is append-only, all derived state (now including holdings) is pure recomputation from
entries + opening anchors, every write goes through the validated write path and audit
log, and the nightly invariant cron guards correctness.

```
trade entry (entry_type='trade')        ── append-only, like a transaction
  ├─ entries.amount  = signed cash delta to the account (ADR-1; buy = negative)
  └─ trades row      = { instrumentId, side, units, price }   ← units/price live here

instruments  ── one row per scheme/stock (mf | equity), AMFI code / ISIN / symbol
prices       ── daily { instrumentId, date, nav } time series (AMFI cron + equity fetch)

derive.ts
  rebuildBalances   (P1, unchanged)  ── opening + Σ(transaction|trade) cash deltas
  rebuildHoldings   (P2, new)        ── Σ(trade) units + avg cost, per account+instrument
  netWorth          (P1, extended)   ── bank/anchor balances + Σ(holding.units × latestPrice)

lib/invest/
  xirr.ts          ── deterministic cashflow IRR (decimal math, never Number())
  amfi.ts          ── parse AMFI NAVAll feed → {amfiCode → nav}
  equity-price.ts  ── best-effort daily equity quote, last-known fallback
```

Module boundaries mirror P1: `lib/invest/*` and the new `derive.rebuildHoldings` are
**pure / DB-free where possible** and fully unit-tested; `app/` touches them only through
server actions; nothing in `app/` touches `db` except via `lib`.

## 4. Data model (new tables)

All amounts/units/prices are **numeric stored as string** (Drizzle numeric mode `'string'`),
arithmetic only via `money.ts`-style decimal ops. New tables live in `src/db/schema/ledger.ts`
(trades, instruments, prices alongside the existing ledger tables) — re-exported from
`schema/index.ts`.

- **`instruments`** — `{ id, householdId, kind: 'mf' | 'equity', name, symbol?, isin?, amfiCode? }`.
  One row per scheme/stock. `amfiCode` is the join key to the AMFI NAV feed for MF; `symbol`
  (NSE) for equity. Unique on `(householdId, kind, coalesce(isin, symbol, amfiCode))` to
  prevent duplicate instruments.
- **`trades`** — subtype detail for `entries` of `entry_type='trade'`:
  `{ entryId (pk, fk→entries), instrumentId (fk→instruments), side: 'buy' | 'sell', units, price }`.
  The signed cash delta stays on `entries.amount` (ADR-1: buy → negative to the funding
  account; sell → positive). `units × price` should reconcile to `|amount|` net of fees;
  a tolerance check (0.01) flags mismatches as anomalies (§7), it does not block the write.
- **`prices`** — `{ instrumentId (fk), date, nav }`, unique on `(instrumentId, date)`. Daily
  time series; the latest row ≤ a given date is the mark for valuation on that date.

The existing `entry_type` enum already includes `'trade'` and `derive.ts` already folds
`transaction|trade` into balances — so the cash side of trades is wired without migration
beyond the new tables.

## 5. Holdings replay (`derive.ts`)

`rebuildHoldings(ex, householdId)` mirrors `rebuildBalances`: fold all non-deleted `trade`
entries in entry order into `{ accountId, instrumentId, units, avgCost, realizedPnl }`.

- **Buy:** `units += tradeUnits`; `avgCost` = weighted average of prior cost and new lot.
- **Sell:** `units -= tradeUnits`; realized P&L = `tradeUnits × (price − avgCost)`; `avgCost`
  unchanged on partial sells; selling more units than held flags an anomaly (§7).
- Holdings are **never stored as mutable truth** — like balances/rollups they are a
  recomputation; any holdings cache can be dropped and rebuilt bit-identically (§11 System).

Holding **current value** = `units × price`, where `price` is the latest `prices` row ≤ the
valuation date for that instrument. If no price exists (new instrument, stale equity), fall
back in order: last known price → the most recent manual `appraisal` valuation on the
account → cost basis (`units × avgCost`), and surface a "stale price" chip rather than
silently showing a wrong number (§5 never-drop ethos).

## 6. Pricing (crons)

- **MF — AMFI daily NAV (authoritative, free).** A daily cron fetches AMFI's published
  `NAVAll` feed, parses `amfiCode → nav → date`, and upserts `prices` for every instrument
  with an `amfiCode`. AMFI is the canonical Indian MF NAV source; this is deterministic and
  reliable, satisfying §11's "refreshed daily, zero manual effort" for the MF sleeve.
- **Equity — best-effort daily quote with fallback.** Equity has no clean free official API;
  a daily cron fetches latest quotes for held symbols on a best-effort basis and upserts
  `prices`. On failure or staleness, valuation falls back per §5 (last known → appraisal →
  cost) and shows a stale chip. This keeps net worth honest without letting a flaky equity
  feed block the whole chart. The specific equity source is an implementation choice locked
  in the plan; the contract here is "upsert a daily `prices` row when obtainable, fall back
  visibly when not."
- Crons run via `vercel.ts` alongside the P1 invariant cron, bearer-secured the same way
  (`CRON_SECRET`). Pricing writes are idempotent (unique `(instrumentId, date)`); re-running
  a day no-ops.

> **Note:** `vercel.ts` does not yet exist in the repo. P2 introduces it (or `vercel.json`)
> to register the AMFI + equity + existing invariant crons. This is also the file the eventual
> P1 deploy needs, so P2 creates it.

## 7. Correctness & invariants

P2 extends the nightly invariant checks (`lib/ledger/invariants.ts`), it does not weaken
them. New anomaly kinds:

- **`trade_cash_mismatch`** — `|units × price − |amount||` exceeds tolerance (0.01) beyond a
  reasonable fee band: recorded, routed to review, never silently dropped.
- **`oversold_holding`** — replay drives a holding's units negative: recorded as an anomaly
  (likely a missing buy or a bad import), value falls back to zero-floor for that holding.
- **`stale_price`** — a held instrument has no fresh price within N days (MF: 4 calendar days
  to absorb weekends/holidays; equity: configurable): surfaced as a chip, drives the §5
  fallback. Not a hard error.

XIRR is computed **deterministically through decimal math, never via LLM or `Number()`** on
the cashflows, consistent with the master spec's stance that all financial arithmetic flows
through the same engine as the ledger.

## 8. Ingestion (no new parser)

Trades enter through the **existing import pipeline** (`lib/import/*`), which already does
parse → map → preview (new/dup/suspicious) → commit → undo and supports per-account saved
column mappings (`import_configs`). P2 adds:

- A **trade-shaped normalized row**: `{ date, instrumentSymbol, side, units, price, amount, ref? }`,
  alongside the existing transaction row shape.
- **Trade column roles** in the mapping step (instrument / side / units / price) reusing the
  same generic mapping UI — so Zerodha Console, Groww, or any other broker export works
  through configuration, not hardcoded parsers.
- **Prefilled mapping presets** for **Zerodha Console** and **Groww** tradebook exports
  (the platforms the owner uses), saved as `import_configs` so the first import of each is
  one click. Other platforms use the generic mapping flow.
- A **trade commit path**: resolve-or-create the `instrument` (by ISIN/symbol/AMFI code),
  write `trade` entries as **pending** into the review inbox (like statement imports), then
  `rebuildHoldings` + `afterWrite`. Dedup reuses the existing import-hash machinery.
- A **manual trade form** for one-off holdings, corrections, and corporate actions — the
  minimum needed when there is no export to import.

CAS PDF ingestion is explicitly **not** built here (see §2 non-goals).

## 9. UI surface (minimal, reuses the r7 design system)

P2 ships the smallest UI that exposes the new data; it introduces **no new design
direction** and obeys `DESIGN.md` (tabular numerals on money, `formatINR`/`formatINRCompact`
only, green/red strictly for direction, charts convert to number only at the RSC boundary).

- **Net-worth breakdown chart** — the full stack over time (bank + MF + equity + EPF/FD/gold
  − cards/loans), upgrading the P1 dashboard spark.
- **Holdings view** — per-instrument units, current value, cost, unrealized P&L, XIRR.
- **Trade entry** — the manual trade form + the trade import wizard (the existing import UI
  with trade roles).

## 10. Roadmap placement

P2 follows P1 (core ledger) and P1.5 (SMS bridge). It depends on P1's ledger, derive, and
import pipeline being live, but **does not depend on the P1 production deploy** — P2 can be
built and tested locally on the same foundation. P3 (Gmail auto-ingestion) layers on top and
is where CAS PDF parsing finally lands; P4's agent substrate and P5's planning/product-evaluator
read holdings + XIRR produced here. Net worth + XIRR are the substrate later phases query.

## 11. Success criteria (from master spec §11 P2)

- Net worth (bank + MF + equity + EPF + FD − credit card − edu loan) on **one chart**.
- **XIRR per holding**, computed deterministically.
- Refreshed **daily with zero manual effort** beyond importing a periodic broker export
  (MF NAV fully automatic via AMFI; equity best-effort with visible fallback).
- **System invariants hold:** `ledger_anomalies` stays empty in steady state; holdings and
  prices can be dropped and rebuilt bit-identically; no unexplained net-worth drift.

## 12. Open decisions (deferred to plan or to the owner, by choice)

- **Equity price source** — best-effort + fallback is locked as the *contract*; the concrete
  free source (and its reliability/rate-limit handling) is chosen in the implementation plan.
- **Net-worth chart granularity** — daily vs month-end series; proposed: daily marks stored,
  chart aggregates to a sensible cadence. To confirm at plan time.
- **Fee/brokerage modeling** — whether to split brokerage/STT/GST out of the trade amount as
  a separate expense leg, or absorb it into cost basis. Proposed: absorb into amount for P2
  (simplest, correct net worth), revisit if expense-side accuracy matters.

These do not block the spec; they are flagged for resolution during planning and the owner's
review.
