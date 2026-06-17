# Phase 2 (Investments + Net Worth) — Acceptance

Date: 2026-06-17 · Branch `build/phase-2-investments` · Spec `docs/superpowers/specs/2026-06-17-phase-2-investments-net-worth-design.md` · Plan `docs/superpowers/plans/2026-06-17-phase-2-investments-net-worth.md`

## Automated gates (all green)

- **Test suite:** `pnpm test` → **225 passed** (20 P1 files + invest suites; the 2 orphaned `netWorthSeries` tests were removed when that dead function was deleted).
- **Typecheck:** `pnpm exec tsc --noEmit` → clean.
- **Production build:** `pnpm build` → succeeds; routes include `/invest`, `/api/cron/prices`, `/api/cron/invariants`.

## Data-layer acceptance (headless, real Postgres `fin_dev`, isolated household, self-cleaning)

A throwaway harness exercised the full P2 data path end-to-end and asserted:

1. **Holdings replay** — buys 100@60 + 100@80 → **200 units, avg cost ₹70** (`computeHoldings`).
2. **Market valuation** — with a price mark of ₹75, `holdingValueAt` = **₹15,000** (200 × 75), i.e. market value, **not** the −₹14,000 cost basis or the negative trade cash-flow.
3. **Net worth** — bank (₹1,000 opening − ₹200 expense = ₹800) + investments (₹15,000 market) = **₹15,800** (`netWorth`), confirming investment-kind accounts are valued by holdings, not the cash-sum path.
4. **All invariants zero** — `runInvariantChecks` returned 0 for every check, including the three P2 additions: `trade_cash_mismatch`, `oversold_holding`, `stale_price`.
5. **Rebuild-bit-identical (system invariant)** — captured net worth, deleted all `balances` + `rollups` rows, ran `rebuildBalances` + `rebuildRollups`, re-read net worth: **₹15,800 === ₹15,800**. Derived state is reproducible from the ledger.

The harness created an isolated household and tore it down (FK-safe) including any anomalies it generated; `fin_dev` left at 0 anomalies, 0 P2 rows.

### Note: `stale_price` fires correctly (verified incidentally)

During acceptance, an early data shape (only a months-old price) correctly triggered `stale_price = 1` — confirming the check detects held instruments lacking a price within 4 days. With a fresh price added, it returned to 0. The nightly `/api/cron/prices` (AMFI) keeps MF prices fresh; equity falls back visibly per spec §6.

## API routes

- **`/api/cron/invariants`** — verified live earlier this session: 401 without bearer; with `CRON_SECRET` bearer → `{ ok:true, counts:{…all zero} }`.
- **`/api/cron/prices`** — auth is byte-identical to the invariants route (timing-safe `Bearer ${CRON_SECRET}`); AMFI parse (`parseAmfiNav`) and `upsertPrices` are unit-tested. **Live AMFI fetch verification is deferred to the production deploy** (needs `CRON_SECRET` set in Vercel env; both crons registered in `vercel.json`).

## Pending owner verification (gated on the UI reskin approval)

- **Visual** rendering of the `/invest` holdings view and the dashboard net-worth **breakdown chart** has not been eyeballed by the owner. Both reuse the r7 design system, which is itself **awaiting approval before any deploy** (per `docs/HANDOFF-ui-revamp.md`). Holdings/chart render the empty state cleanly with zero holdings (confirmed headless + build).

## Outcome

Phase 2 data, ledger, pricing, invariants, ingestion, and net-worth math are **code-complete and verified**. Remaining before P2 is "done done": owner's visual sign-off on the new screens (bundled with the reskin approval) → deploy → set `CRON_SECRET` and confirm the price cron against live AMFI.
