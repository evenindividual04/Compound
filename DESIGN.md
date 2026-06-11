# Design System — Compound

> Single source of truth for Compound's visual and product design. Read this before
> any UI/visual change. Tokens, type, components, voice, money rules, and IA are
> defined here. Don't deviate without explicit approval; log changes in the Decisions
> Log. This is a **living document** — expect revisions as the product grows.
>
> Created via `/design-consultation` + `/brainstorming`, 2026-06-12. Grounded in the
> approved mockups under `~/.gstack/projects/fin/designs/compound-20260612/`
> (`r4-color-identities.html`, `r6-home-browse.html`, `r7-home-dedup.html`).

---

## 1. Product Context

- **What it is:** Compound is a personal-finance **platform** — not an expense tracker
  with budgets bolted on. It can hold anything→everything in personal finance:
  spending, budgets, savings, net worth, and (later) investments, goals, debt, bills,
  subscriptions, taxes, insurance, credit. Built on an immutable ledger (Phase 1 done).
- **Who it's for:** Anmol — 22, just starting his first internship, net worth near
  zero, slowly building his first corpus. The design serves the **formation years**,
  not the 35-year-old-with-a-mortgage that mainstream PFM apps (Monarch, YNAB,
  Copilot) are secretly built for.
- **Platform:** mobile-first PWA, dark-first **and** light (both first-class).
  en-IN money (lakh/crore, ₹). iOS safe areas.

## 2. The Thesis (the memorable thing)

**You're early. Early is the advantage.** Time is the one asset a beginner has that
the wealthy can't buy back. So a near-zero balance isn't an embarrassment to hide —
it's the whole point. The app's name *is* the pitch: small now, compounding does the
rest.

Every design decision serves this: Compound is **financial fitness for people just
starting out** — see your money clearly, build the habit, watch the curve start.

## 3. Aesthetic Direction & Anti-Slop Rules

- **Direction:** warm, editorial, witty, premium-but-human. A coach/mirror, not a bank.
- **Decoration:** minimal-to-intentional. Typography and one accent do the work.
- **Hard anti-slop rules (learned the hard way during design):**
  - **No blue.** Blue is the converged fintech default ("trust me, I'm a bank"). Banned.
  - **No generic grotesque** (Inter/Roboto/SF as display). Banned.
  - **No vintage/sepia/brown** — reads as a journal, not a money app.
  - **No cold mono "terminal" look.**
  - **No purple gradients, no 3-column icon-circle grids, no centered-everything, no
    uniform bubble-radius, no multicolor category coding, no rainbow charts.**
  - **No marketing-speak microcopy** ("Built for X", "Designed for Y").

## 4. Color

### The governing principle: **money is (almost) the only color**
Color carries meaning, not decoration. In Compound, chroma means one of two things:
**money direction** (green/red) or **you / your future** (the single coral accent).
Everything else is ink on a warm surface. This is the core anti-slop discipline —
never add a color "to brighten things up."

### Tokens — LIGHT (warm paper)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#FBF7F0` | app background (warm paper, never gray) |
| `--surface` | `#FFFFFF` | cards |
| `--ink` | `#1B1A17` | primary text / numbers |
| `--soft-ink` | `#6B6557` | secondary text, labels |
| `--hairline` | `#E7E0D4` | borders, dividers, chart tracks |
| `--accent` (coral) | `#FB7A3C` | FAB, active nav, ring, projection, pins, urgent edges |
| `--money-pos` | `#1F9D57` | positive money only |
| `--money-neg` | `#D8402F` | negative money only |

### Tokens — DARK (warm charcoal)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#15151B` | warm charcoal (NOT brown, NOT pure black) |
| `--surface` | `#1E1E26` | cards |
| `--text` | `#ECECF0` | primary text / numbers |
| `--dim` | `#8B8B96` | secondary text, labels |
| `--hairline` | `rgba(255,255,255,.08)` | borders, dividers, tracks |
| `--accent` (coral) | `#FF8A52` | same role, brightened for dark legibility |
| `--money-pos` | `#4FD08A` | positive money only |
| `--money-neg` | `#FF6B5C` | negative money only |

### Color rules
- **Coral is the only brand accent.** Light `#FB7A3C` / dark `#FF8A52`. Same hue family
  tuned per mode so the two themes feel like one product. Used ONLY for: FAB, active
  nav item, the savings ring, the compound **projection** (dashed future), pinned-card
  dots, and urgent/surfaced edges. **Coral is never used for a money sign.**
- **Green = money in, red = money out. Always. Only.** Never decorative. A non-money
  delta like "↑12% vs May" (more spend) is a warning tone (coral/dim), **not** green.
- **Coral must stay visibly distinct from money-red** (coral is oranger, red is
  crimson) so "red = you spent" is never ambiguous.
- Implement as CSS custom properties; `.light` / `.dark` swap the set. Theme via
  `next-themes` (already installed). NOTE: the current achromatic `oklch(L 0 0)` tokens
  in `src/app/globals.css` are fully replaced by this palette. Also fix the latent
  Recharts bug — charts currently receive `hsl(var(--primary))` strings while tokens
  are `oklch`; charts must receive resolved color values (convert at the RSC boundary
  in `src/components/dashboard/chart-data.ts`).

## 5. Typography

- **Display / hero / all numbers:** **Bricolage Grotesque** — characterful, modern,
  confident. Heavy weights (700–800) for hero numbers; the big ₹ figure is the app's
  signature and should bleed editorially.
- **Body / labels / UI:** **Hanken Grotesk** — clean, warm, legible. 400–600.
- **Small labels:** UPPERCASE, letter-spaced, `--soft-ink`/`--dim`.
- **No mono, no Inter, no Geist** (replacing the current Geist setup).
- **Tabular numerals on ALL money and metrics:** `font-feature-settings: "tnum" 1,
  "lnum" 1;` (the `.tnum` utility already exists — keep and apply everywhere money
  appears). Numbers must align in columns.
- **Loading:** `next/font/google` or `@fontsource` (Bricolage Grotesque + Hanken
  Grotesk both available). Self-host for PWA reliability.
- **Scale (starting point, rem):** hero 3.0–3.5 · h1 1.75 · h2 1.375 · body 1.0 ·
  label 0.8125 (uppercase tracked) · caption 0.75.

## 6. Spacing & Radius

- **Spacing base:** 4px. Density: comfortable (generous card padding, real breathing
  room between cards). Scale: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- **Radius:** warm but not bubbly. cards `16px` · inner elements `12px` · chips/bars
  `8px` · pills & FAB `9999px`. One coherent scale, not a uniform radius on everything.

## 7. Motion

- **Approach:** intentional, never decorative. Honor `prefers-reduced-motion`.
- **Signature moments:** the savings **ring** fills on load; the **compound curve**
  draws left→right, history (green) then dashed projection (coral); cards settle in
  subtly. Durations: micro 100ms · short 200ms · medium 320ms. Easing: enter ease-out.

## 8. Voice & Microcopy

- **Register: dry / deadpan mirror.** Sparse, sharp, lets the numbers talk. The
  occasional savage one-liner. Respects the reader; never lectures, never cheerleads.
- **Warmth is rationed:** the app only gets warm/encouraging on the **compound /
  future** moments. ("You're early. At this pace, ≈₹1Cr by 39.")
- **Examples:**
  - Insight: "Pacing 12% above May. Restaurants, mostly."
  - Trend: "Eating out: up 18% on your 90-day average. Noted."
  - Ring: "₹1,500 to close your ring."
  - Empty state: "Nothing spent. Either very disciplined or the cards are home."
- **Never:** exclamation-point cheerleading, self-help saccharine, finance jargon,
  marketing-speak.

## 9. Money & Number Rules (hard constraints)

- **Format ONLY via `src/lib/money.ts`** (`formatINR`, `formatINRCompact`). Never
  `Number()` a money value (charts are the one exception — convert at the RSC boundary
  in `chart-data.ts`).
- en-IN grouping: `₹1,24,560`, `₹47,800`. Paise dropped at ≥ ₹1,000.
- Compact lakh/crore for large/forward figures: `₹48.2L`, `≈₹1Cr`.
- **Negative sign is the typographic minus U+2212 (−)**, not a hyphen: `−₹420`.
- Tabular numerals everywhere (§5).
- **Green positive / red negative / coral never a money sign** (§4).

## 10. Information Architecture

Compound = **Apple Health for your money.** The model that makes it motivating (rings,
glanceable cards) is the same one that makes it infinitely extensible.

### Two surfaces carry the platform
- **Home = a composable Summary.** A vertical stack of cards the user pins and
  reorders. Each card is one module's *glance*.
- **Browse = the module Library.** Every finance area, grouped. Tap to open the full
  module; pin to add its card to the Summary.

### The scalability rule
**Modules live in Browse, not in the nav.** The bottom nav stays small and fixed
forever — `Home · Browse · ＋ (FAB) · Trends · More` — while Compound grows to hold a
hundred finance areas. No tab explosion, no junk-drawer "More".

### Module ⇄ card
- **A module = a full screen for one finance area** (Spending, Budgets, Savings,
  Compound/Net worth, Investments, Goals, Bills, Debt, Trends, Review inbox, Import,
  Accounts…).
- **A card = that module's glance on the Summary.** Adding a finance area = a new
  module in Browse that contributes one card type. Same shape every time.

### Two kinds of cards on Home
1. **Pinned glance-cards** — *you* choose them. (Spend, Savings ring, Compound,
   Recent…) Composable: drag to reorder, remove, add. ("Edit summary →" / long-press.)
2. **Surfaced action-cards** — the app raises them automatically when time-sensitive
   (Rent due, "3 to review", an anomaly, a stale balance). They appear, you act, they
   leave. This is the smart layer — and later, the agent's home (P4–P5).

### One card, one question
A card earns its place only if it answers a question no other card does. Spend
("what did I spend"), Saved ("what did I keep"), Compound ("where's it heading") are
three different questions. **Budget is not a fourth card** — it's spend-vs-plan, so it
lives as a thin bar inside the Spend card. Don't duplicate a number across cards.

### Interaction model
- **Tap card body → opens that module's full screen.**
- **Inline deep-links jump to a spot** inside a module ("View categories →", "All
  transactions →").
- **Surfaced action-cards act in place** (Rent → Pay/Snooze; "3 to review" → opens the
  queue).
- **＋ FAB = quick-add** a transaction from anywhere (≤3 taps; amount-first keypad;
  offline outbox — the existing quick-entry flow, reskinned).

## 11. Core Components

- **Card** — surface + hairline, generous padding, radius 16. Glance + door (§10).
- **Spend (hero) card** — UPPERCASE label, big Bricolage ₹ number (bleeds), delta pill
  (warning tone, not green), one dry insight line, a thin coral **budget bar** beneath
  ("₹X left of ₹Y · View categories →").
- **Savings ring** — SVG circular progress (coral on faint track), center `27% / KEPT`
  in Bricolage, beside it `SAVED THIS MONTH · ₹12,900 · of ₹47,800 income · ₹1,500 to
  close your ring`. The "close your rings" motivation, warm-coral skin.
- **Compound card** (wide) — corpus number + "+₹X this month" (green). Inline SVG:
  solid **green** area-fill history curve rising from near-zero → **coral dashed**
  projection. Line: "You're early. At this pace, ≈₹1Cr by 39." The emotional centerpiece.
- **Surfaced action-card** — slim, coral left-edge, source tag ("FROM BILLS"), inline
  action.
- **Trends list item** — sparkline/arrow + dry headline + value (Trends module).
- **Browse row** — line icon (ink, not rainbow) + name + status; coral pin-dot if on
  the Summary; "SOON"/greyed for future modules.
- **Bottom nav** — fixed 5-slot (`Home · Browse · ＋ · Trends · More`), active = coral,
  iOS safe-area aware. FAB center, coral, circular.
- **Reskin existing primitives** (shadcn on `@base-ui/react`): Card, Button, Badge,
  Dialog, Drawer (vaul), Input, Select, Sheet, Tabs, Sonner — restyle to these tokens;
  replace where the design warrants. Server actions / `src/lib/**` are off-limits.

## 12. Reference Mockups

Approved HTML mockups (real fonts/numerals, both modes) under
`~/.gstack/projects/fin/designs/compound-20260612/`:
- `r4-color-identities.html` — the coral identity (mono/marigold/coral × light/dark).
- `r6-home-browse.html` — Home (composable Summary) + Browse (module Library).
- `r7-home-dedup.html` — **current Home** (Spend+Budget merged; the deduped reference).

## 13. Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-12 | Accent = coral `#FB7A3C`/`#FF8A52`; **no blue** | Blue is the converged fintech slop; coral is warm, non-default, energetic. |
| 2026-06-12 | "Money is (almost) the only color" | Color must mean money (green/red) or you (coral); kills decorative slop. |
| 2026-06-12 | Type = Bricolage Grotesque + Hanken Grotesk | Characterful, modern, warm; replaces achromatic Geist defaults. |
| 2026-06-12 | Dark-first warm charcoal `#15151B` + warm paper `#FBF7F0` light | Both modes first-class; warm, not brown, not clinical. |
| 2026-06-12 | Voice = dry/deadpan mirror, warm only on compound | Coach/mirror for the formation years; wit as seasoning. |
| 2026-06-12 | Net worth reframed as honest growing corpus | User is at formation (~₹0); a fake big number is wrong and demotivating. |
| 2026-06-12 | Financial-fitness model (ring + curve + trends) | Apple Health's behavior-app engine fits "see clearly, build habit, stay motivated". |
| 2026-06-12 | IA = composable Summary + Browse Library; nav fixed | Scales to "anything→everything" without tab explosion; future-proofs the agent. |
| 2026-06-12 | One card = one question; Budget merged into Spend | Removes redundancy (₹35,100 was shown twice). |

## 14. May Change Later (open / not yet locked)

- Exact savings-rate target, projection math, and how the compound projection is
  computed/labeled.
- Default set of pinned cards and the surfacing rules (which actions float up, when).
- Browse groupings and which modules ship in v1 vs later.
- Trends module detail and module-detail screens (Spending/Budgets) — not yet designed.
- Login / wordmark moment, app icon / manifest identity — not yet designed.
- Whether coral stays the single accent forever, or a second reserved hue emerges.
- Exact type scale, radii, and motion timings — refine during implementation.
- **Desktop / laptop layout — REQUIRED, but deferred for a dedicated discussion.**
  Compound is one responsive web app (not a separate desktop build). A desktop shape
  was explored — bottom-nav → left **sidebar** (wordmark + ＋Add + nav + avatar/bell),
  single-column stack → multi-column **card grid** (Spend + ring side by side, full-width
  Compound curve, Recent visible), same tokens/type/voice/money rules, both modes — see
  `~/.gstack/projects/fin/designs/compound-20260612/r8-desktop.html`. Owner's verdict:
  "okay" but not locked. Responsive breakpoint rules (mobile / tablet / desktop), max
  content width, and which screens need a desktop-specific layout (e.g. Transactions as a
  full table) are **TBD — revisit before building the shell.**
