# Handoff: Compound UI Revamp

> For the next session. Read this fully, then run `/design-consultation` (gstack). Do NOT
> re-plan the backend; do NOT deploy. The job is a full visual redesign of the UI skin.

## What Compound is

**Compound** — Anmol Sen's personal finance system (name chosen deliberately: compounding
is the 22-year-old's superpower). Immutable-ledger PWA: expense tracking, budgets,
statement imports, review inbox, net worth — with investments (P2), Gmail ingestion (P3),
an agentic layer (P4-P5) coming later. Master spec:
`docs/superpowers/specs/2026-06-11-personal-finance-system-design.md`. Phase-1 plan:
`docs/superpowers/plans/2026-06-11-phase-1-core-ledger-pwa.md`.

## Current state (2026-06-11)

- Phase 1 tasks 1–21 **done**: full ledger chassis + all UI flows, 201 tests green,
  tsc clean, adversarial review findings fixed. Branch `build/phase-1-core-ledger`, ~35 commits.
- Auth works: Better Auth + Google OAuth (real creds in `.env.local`), allowlisted to
  **senanmol24@gmail.com** only (never use agarwal.adhik@gmail.com — retired).
- App runs locally: `pnpm dev` → http://localhost:3000.
- **T22 deploy + T23 acceptance are DEFERRED at Anmol's request.** His words: "i dont
  want to deploy this piece of shit" — meaning the UI. Nothing goes to Vercel until the
  redesign lands and he likes it. Do not deploy, do not suggest deploying mid-redesign.

## The job: full UI revamp

Anmol's verdict on the current UI (functional shadcn defaults): **"looks like shit."**
He wants a real design direction, not cosmetic tweaks.

His taste (consistent across projects): **personal, human, living, dynamic, witty.
No generic fintech slop.** He rejected multiple rounds of safe/obvious naming options
before "Compound" landed — bring actual taste, think before proposing, and expect
pushback. His portfolio (pfolio repo) uses Fraunces + Commit Mono, editorial, dark —
related taste signal, but Compound should have its own identity.

### Keep (working flows — reskin, don't rebuild)

- Quick entry: FAB → drawer, amount-first keypad, recent-category chips, ≤3 taps. Offline outbox.
- Review inbox: pending entries + transfer confirms, accept/recategorize, bulk, "All caught up ✓".
- Import wizard: upload → column mapping → preview (new/dup/suspicious chips) → commit → undo.
- Dashboard: hero number (this month's spend), net-worth spark, needs-attention strip, 6-mo trend.
- Transactions: month pager, edit drawer, splits, transfers. Accounts: liability-aware forms,
  "Update balance" valuation flow. Budgets: assigned/spent/remaining bars.

### Hard constraints

- Money formatting ONLY via `src/lib/money.ts` (`formatINR`, `formatINRCompact` — en-IN
  lakh/crore, paise dropped ≥ ₹1,000, U+2212 minus). Never `Number()` money (charts are
  the one exception, conversion at RSC boundary in `src/components/dashboard/chart-data.ts`).
- Tabular numerals on all money. Green/red strictly for money direction.
- Mobile-first PWA (bottom nav + FAB), dark-first with light mode. iOS safe areas.
- Next 16 App Router quirks: middleware is `src/proxy.ts`; read `node_modules/next/dist/docs/`
  before writing code (per AGENTS.md); RSC pages must not call client-module functions.
- Tailwind v4 + shadcn/ui installed; replacing shadcn components is allowed if the design
  warrants, but server actions and lib layer (`src/lib/**`) are off-limits to redesign.
- `xlsx` npm package is banned (CVEs) — exceljs only. Don't touch the import pipeline logic.

### UI surface map (what gets reskinned)

```
src/app/(app)/layout.tsx          bottom nav + FAB shell (components/bottom-nav.tsx)
src/app/(app)/page.tsx            dashboard + components/dashboard/*
src/app/(app)/inbox/              + components/inbox/*
src/app/(app)/transactions/       + components/txn-row, txn-edit-drawer, category-picker
src/app/(app)/accounts/           + components/accounts/*
src/app/(app)/budgets/            + components/budgets/*
src/app/(app)/import/             + components/import/* (4-step wizard)
src/app/login/page.tsx            wordmark moment — lowercase "compound"
src/app/globals.css               theme tokens live here (Tailwind v4 @theme)
public/manifest.webmanifest + icons   currently a placeholder ₹ glyph — needs real identity
```

## Environment quirks (will bite you if ignored)

- Local Postgres 18: `~/.fin-pgdata`, port **54329**, user `compound`, trust auth. Start if down:
  `/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D ~/.fin-pgdata -o "-p 54329 -c listen_addresses=127.0.0.1" -l ~/.fin-pgdata/log start`
  (System Postgres on 5432 wants a password — don't touch it.)
- Tests: `pnpm test` (loads `.env.local`; DB suites need `TEST_DATABASE_URL`; files run
  serially — don't parallelize, shared test DB). Extra DBs compound_test2–5 exist for parallel agents.
- Port 3000 must be free for OAuth (stale pfolio dev servers have squatted it before —
  `lsof -nP -iTCP:3000 -sTCP:LISTEN` and kill).
- Shell cwd drifts between tool calls in this harness — always `cd /Users/anmolsen/Developer/fin &&` or use absolute paths.
- Visual brainstorm companion sessions live under `.superpowers/brainstorm/` (gitignored);
  the superpowers brainstorming skill's HTML server worked well with Anmol — he engages
  with visual options more than text menus.

## Process notes (how Anmol works)

- He values speed; per-task subagent review ceremony annoyed him. Efficient pattern that
  worked: Fable orchestrates + judges, Sonnet subagents implement bounded slices in
  parallel, batched review checkpoints at milestones.
- Reviews DID catch real bugs (xlsx CVE, parseFloat in invariants) — keep one adversarial
  review pass before declaring the redesign done.
- UI verdicts will be blunt. Show, don't describe: mockups/previews in the browser.
- After the redesign is approved and applied: THEN deploy (T22: Neon Mumbai + Vercel +
  GitHub repo + R2 backup secrets) and run T23 acceptance per spec §11.

## Memory pointers

Cross-session memory at `~/.claude/projects/-Users-anmolsen-Developer-pfolio/memory/` —
see `fin-project-state.md`, `anmol-email.md`, `anmol-profile.md`.
