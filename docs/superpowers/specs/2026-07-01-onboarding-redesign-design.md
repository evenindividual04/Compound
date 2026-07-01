# Onboarding Redesign — Design

**Goal:** someone (Anmol, or a friend self-hosting their own instance) logs into a freshly-deployed
Compound with zero accounts and no SMS sync running, and the app itself tells them what to do next
— no README, no Terminal-first instructions, no guessing what "anomalies" means.

**Architecture:** extend the existing "surfaced action-card" system on Home (already spec'd in
DESIGN.md §10) with new onboarding-relevant cards, add one new Browse module ("Setup") as the
persistent status/resolution hub, add a lightweight heartbeat so the app can tell "never connected"
from "was working, now isn't," and ship a one-command installer for the Mac SMS bridge.

**Tech stack:** no new dependencies. Next.js App Router (existing), Drizzle (new table +
migration), the existing `bridge.py` (relocated to be served statically, logic unchanged except
heartbeat throttling).

## Scope

**In scope:**
- Home action-cards: no accounts yet, connect SMS sync, sync hasn't checked in, messages need an
  account.
- New Browse module "Setup": bridge status, accounts + SMS key list, resolvable "needs an account"
  list, informational "not recognized" list.
- Heartbeat: new `bridge_heartbeats` table, ingest route accepts empty `messages` and updates
  heartbeat on every call, bridge sends a throttled heartbeat-only ping.
- Anomaly resolution: `recordAnomaly` persists raw `sender`/`body`/`receivedAt` so a "Resolve" action
  can actually create the transaction (closing the gap hit during the real backfill, where manual
  chat.db replay was the only way to fix an unmapped batch).
- One-command Mac bridge installer: `bridge.py` + plist template served as static files from the
  app itself; Setup page renders a ready-to-paste `curl | bash` command with that deployment's own
  `INGEST_URL`/`INGEST_SECRET` filled in.
- Copy: replace "anomalies"/"bridge" jargon in all user-facing strings per DESIGN.md's dry/deadpan
  voice (§8).

**Out of scope (deferred, separate future spec):**
- Packaging the Mac bridge as a signed/notarized menu-bar `.app` (requires an Apple Developer
  Program decision — $99/year — and a code-signing/notarization pipeline). The one-command installer
  in this spec is the interim improvement; the two unavoidable manual steps (granting Full Disk
  Access, enabling Text Message Forwarding) remain regardless of packaging, since Apple requires a
  human click for both.
- Deployment automation (Vercel/Neon/env-var setup for a fresh instance). This spec assumes the app
  is already deployed and the user can already log in.
- Android SMS ingestion (see `android-sms-ingest-future` memory) — the ingest endpoint is already
  device-agnostic, so this is unaffected by anything in this spec.

## Components

### 1. Home action-cards (`src/components/home/urgent-card.tsx`, `src/lib/ledger/dashboard.ts`)

Extend `NeedsAttention` (in `dashboard.ts`) with:

```typescript
export interface NeedsAttention {
  inbox: number;
  anomalies: number;        // existing, now actually surfaced (see #4 below)
  staleAnchors: StaleAnchor[];
  hasAccounts: boolean;      // new
  bridgeStatus: "never" | "stale" | "ok"; // new — derived from bridge_heartbeats
  unmappedCount: number;     // new — ledger_anomalies WHERE kind='sms_unmapped' AND resolved_at IS NULL
}
```

`bridgeStatus` derivation: `"never"` if no heartbeat row exists for the household; `"stale"` if
`lastSeenAt` is more than 10 minutes old (generous margin over the 60s check + 5min heartbeat
throttle); `"ok"` otherwise.

The current `UrgentCards` implementation doesn't pick a single "best" card — it independently
renders every condition that's true, stacked (`hasInbox` and each stale anchor all render together
today). The new cards follow the same additive pattern, not a priority-pick mechanism:

- `!hasAccounts` → *"No accounts yet"* / *"Add your first account →"* → `/accounts/new`
- `hasAccounts && bridgeStatus === "never"` → *"Connect SMS sync"* / *"Set it up →"* → `/browse/setup`
- `hasAccounts && bridgeStatus === "stale"` → *"SMS sync hasn't checked in"* / *"Check status →"* →
  `/browse/setup`
- `unmappedCount > 0` → *"N messages need an account"* / *"Assign them →"* → `/browse/setup`

`hasAccounts` and `bridgeStatus` are naturally exclusive by construction (an account either exists
or doesn't; `bridgeStatus` is a single enum value) — no extra exclusivity logic is needed, unlike
what an earlier draft of this section implied.

### 2. Setup module (`src/app/(app)/browse/setup/page.tsx`, new)

New `ModuleRow` in `browse/page.tsx`'s "Your Money" group, next to the existing Accounts row:

```tsx
<ModuleRow
  icon={<Cable {...ICON_PROPS} />}
  label="Setup"
  href="/browse/setup"
/>
```

Page sections, top to bottom:

1. **SMS sync status** — reads `bridge_heartbeats` for the household. Renders one of:
   - *"Not connected yet"* (never) — shows the installer command (Component 4).
   - *"Hasn't checked in for {relative time}"* (stale) — same installer command, plus a note this
     usually means the Mac is off, asleep, or Full Disk Access was revoked.
   - *"Connected · last check-in {relative time}"* (ok).
2. **Your accounts** — read-only table: name, kind, SMS key (or *"—"* if none set), pulled from
   `accounts.metadata.smsKey`.
3. **"{N} messages need an account"** — one row per open `sms_unmapped` anomaly: date, amount,
   matched key (e.g. `SBI:3519`), a `<Select>` of existing accounts, and a "Resolve" button.
4. **"{N} not recognized" (collapsed by default)** — one row per open `sms_unparsed` anomaly: date,
   template guess if any, otherwise "Unknown format." No action; a `<details>`/collapsible section,
   informational only.

### 3. Anomaly resolution (`src/app/actions/anomalies.ts`, new; `src/app/api/ingest/sms/route.ts`, modified)

`recordAnomaly` in `route.ts` gains the raw fields so a later resolve action has enough data to
actually create a transaction:

```typescript
// sms_unmapped detail — was {acctKey, template, amount, date}; now also:
{ sender: string; body: string; receivedAt: string }
// sms_unparsed detail — was {sender, body, receivedAt}; unchanged (already had raw fields,
// since unparsed anomalies are recorded straight from RawSmsSchema input, not the parsed result).
```

New server action:

```typescript
export async function resolveUnmappedAnomaly(
  anomalyId: string,
  accountId: string,
): Promise<{ ok: true } | { ok: false; error: string }>
```

Implementation: loads the anomaly row, re-parses `detail.body` via the existing `parseSmsRows`
(same code path the ingest route uses — guarantees identical parsing, no drift), builds one
`NormalizedRow`, runs it through the existing `stageImport`/`commitImport` pair for the chosen
`accountId` (same dedup/invariant guarantees as normal ingestion), then sets `resolved_at = now()`
on the anomaly. If parsing fails (template changed, malformed data), returns an error and leaves the
anomaly open rather than silently dropping it — consistent with the existing "never drop" anomaly
philosophy (spec §5 referenced in `route.ts`'s header comment).

### 4. Heartbeat (`src/db/schema/ops.ts`, `src/app/api/ingest/sms/route.ts`, `bridge/bridge.py`)

New table:

```typescript
export const bridgeHeartbeats = pgTable("bridge_heartbeats", {
  householdId: uuid("household_id").primaryKey().references(() => households.id),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});
```

`BodySchema` in `route.ts` relaxes `messages` from `.min(1)` to `.min(0)`. At the top of the
try block (after resolving `householdId`, before the parse/route/commit logic), upsert:

```sql
INSERT INTO bridge_heartbeats (household_id, last_seen_at) VALUES ($1, now())
ON CONFLICT (household_id) DO UPDATE SET last_seen_at = now()
```

This runs on **every** authenticated POST, including empty-`messages` heartbeat pings, so any
successful call — whether it carries real messages or not — refreshes the status.

`bridge.py` changes:

- New local state file `~/.compound-sms-bridge/heartbeat.json` (`{"last_heartbeat_sent": <unix ts>}`),
  parallel to `cursor.json`.
- In `run_tick`, after the existing message-fetch/filter logic: if `messages` is non-empty, POST as
  today (this already refreshes the heartbeat server-side as a side effect — no separate call
  needed). If `messages` is empty (no rows, or rows but none financial), check the heartbeat file:
  if more than 5 minutes have elapsed since `last_heartbeat_sent` (or the file doesn't exist), POST
  an empty `{"messages": []}` batch and update the file; otherwise skip the network call entirely.
  This keeps the common "nothing happened" case at roughly one request every 5 minutes instead of
  every 60 seconds.

### 5. One-command installer (`public/bridge/bridge.py`, `public/bridge/install.sh`, both new;
`bridge/bridge.py` relocated)

- `bridge/bridge.py` moves to `public/bridge/bridge.py` (served as a static asset by Next.js —
  no route code needed, `public/` is served verbatim). The `bridge/` source directory is removed;
  `public/bridge/` becomes the single source of truth. `bridge/tests/test_bridge.py` and
  `conftest.py` move to `public/bridge/tests/` alongside it (pytest doesn't care about the directory
  name).
- `public/bridge/install.sh` (new):

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  BRIDGE_DIR="$HOME/.compound-sms-bridge"
  mkdir -p "$BRIDGE_DIR"
  BASE_URL="${INGEST_URL:?Set INGEST_URL}"
  SECRET="${INGEST_SECRET:?Set INGEST_SECRET}"
  curl -fsSL "$BASE_URL/bridge/bridge.py" -o "$BRIDGE_DIR/bridge.py"
  cat > "$BRIDGE_DIR/config.json" <<EOF
  {"ingest_url": "$BASE_URL", "ingest_secret": "$SECRET"}
  EOF
  curl -fsSL "$BASE_URL/bridge/com.compound.sms-bridge.plist.template" \
    | sed "s|__BRIDGE_PATH__|$BRIDGE_DIR/bridge.py|g" \
    > "$HOME/Library/LaunchAgents/com.compound.sms-bridge.plist"
  launchctl unload "$HOME/Library/LaunchAgents/com.compound.sms-bridge.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.compound.sms-bridge.plist"
  echo "Installed. Next: grant Full Disk Access to /usr/bin/python3 in System Settings"
  ```

- `public/bridge/com.compound.sms-bridge.plist.template` — same as today's
  `com.compound.sms-bridge.plist`, with the hardcoded `ProgramArguments` path replaced by the
  `__BRIDGE_PATH__` placeholder the installer substitutes.
- Setup module page (Component 2) renders:
  ```
  curl -fsSL {origin}/bridge/install.sh | INGEST_URL={origin} INGEST_SECRET={secret} bash
  ```
  with a copy button and a "reveal secret" style toggle (secret hidden by default, matching how
  other secret-bearing values are typically shown — this is the deployment's own secret, visible
  only behind auth, not a shared/multi-tenant value).
- Setup page also lists, in plain language, the two steps no script can perform: enabling Text
  Message Forwarding (iPhone → Settings → Messages) and granting Full Disk Access to
  `/usr/bin/python3` (System Settings → Privacy & Security), each with the exact click path.

## Copy changes

| Internal term | User-facing copy |
|---|---|
| "anomalies" | never shown — split by kind, see below |
| `sms_unmapped` | *"{N} messages need an account assigned"* |
| `sms_unparsed` | *"{N} not recognized — probably OTPs or offers"* |
| "bridge" (in UI strings only; code/folder names unchanged) | *"SMS sync"* |
| Full Disk Access / chat.db (Setup page explanation) | *"This lets the sync tool read your Messages app, where your bank texts land."* |

All new copy follows DESIGN.md §8 (dry/deadpan register, no exclamation points, no jargon, no
marketing-speak). `"household"` must not appear in any new user-facing string — quick grep check
during implementation, not a full existing-screen audit (out of scope here).

## Data flow

```
Mac: bridge.py (every 60s, local check)
  → chat.db read (filtered to financial senders)
  → financial messages found? POST {messages:[...]} → server upserts heartbeat, parses, routes,
    commits transactions, records unmapped/unparsed anomalies (now with raw fields)
  → nothing found? throttled heartbeat-only POST {messages:[]} at most every 5 min → server
    upserts heartbeat only

Server: Home page load
  → needsAttention() reads accounts count, bridge_heartbeats, open anomalies by kind
  → UrgentCards renders the applicable card(s)

Server: Setup module page load
  → reads bridge_heartbeats, accounts + smsKey, open sms_unmapped (with raw fields) + sms_unparsed
  → user resolves an sms_unmapped row → resolveUnmappedAnomaly action → re-parse → commit →
    resolved_at set → page revalidates, row disappears
```

## Error handling

- `resolveUnmappedAnomaly`: re-parse failure (template no longer matches, corrupted `detail.body`)
  returns `{ok: false, error}` and leaves the anomaly open — never silently drops it, matching the
  ingest route's existing "never drop" guarantee.
- Heartbeat upsert failure (should not happen under normal DB availability) must not fail the whole
  ingest request if real messages are present in the same call — wrap the upsert in the same
  best-effort spirit as categorization (try/catch, log, continue), since a missed heartbeat is
  cosmetic but a dropped transaction is not.
- `install.sh`: `set -euo pipefail` so any curl/mkdir failure stops the script with a visible error
  rather than silently leaving a half-configured bridge; required env vars use `${VAR:?message}` to
  fail fast with a clear message if the copied command was mangled.

## Testing

- Unit: `needsAttention()` new fields (`hasAccounts`, `bridgeStatus` derivation across all three
  states, `unmappedCount`) — extends existing `dashboard.ts` test file.
- Integration: ingest route accepts `{"messages": []}` and upserts heartbeat without error;
  `resolveUnmappedAnomaly` creates the correct transaction and sets `resolved_at` on success, returns
  an error and leaves the anomaly open on re-parse failure.
- E2E (Playwright): fresh household (zero accounts) sees the "No accounts yet" card; after creating
  an account, the card is gone and (once a heartbeat is seeded in the test fixture as absent) the
  "Connect SMS sync" card appears instead; resolving an `sms_unmapped` row end-to-end removes it from
  the Setup page and creates a visible transaction.
- Bridge (pytest, in `public/bridge/tests/test_bridge.py`): heartbeat throttle logic with a mocked clock —
  confirms no more than one empty-`messages` POST per 5-minute window when nothing new is found, and
  confirms a real message batch still POSTs immediately regardless of the throttle window.
