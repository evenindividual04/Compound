# Ledger + SMS Tracking — Comprehensive Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down the core money path — the immutable ledger and the SMS tracking system (Mac bridge → `/api/ingest/sms` → pipeline → review inbox → ledger) — with full-stack testing: a route-level integration test, expanded parser coverage, real-browser E2E behind a safe auth seam, and a Python test suite for the Mac bridge.

**Architecture:** The codebase already has deep lib-layer unit coverage (257 tests). This plan adds the missing layers: (1) an HTTP integration test of the SMS ingest route against the real test DB; (2) more parser edge/fixture coverage; (3) a Playwright browser E2E harness gated by a production-disabled auth-bypass seam; (4) pytest for `bridge/bridge.py`. No production behavior changes except the auth seam, which is double-gated (E2E flag AND non-production) so it is dead code in any real build.

**Tech Stack:** TypeScript · Next.js 16 (App Router) · Drizzle/Postgres (port 54329, `compound_dev`/`compound_test`; new `compound_e2e` for browser tests) · Vitest (`pnpm test`, serial, `fileParallelism:false`) · Playwright (new) · Python 3 + pytest (new, in `bridge/`) · better-auth (Google OAuth, owner allowlist).

## Global Constraints

- Money is NUMERIC **string** end-to-end; never `Number()` a money value (charts/analytics boundaries excepted, not relevant here). Use `src/lib/money.ts`.
- The auth-bypass seam MUST be inert in production: enabled only when `process.env.NODE_ENV !== "production"` **and** `process.env.E2E_AUTH_BYPASS === "1"`. Never add it to the typed `src/env.ts` schema; read `process.env` directly inside the seam.
- DB-backed Vitest suites guard with `describe.skipIf(!process.env.TEST_DATABASE_URL)`. Run only ONE `pnpm test` process at a time (shared `compound_test` → deadlocks).
- Postgres start if down: `/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D ~/.fin-pgdata -o "-p 54329 -c listen_addresses=127.0.0.1" -l ~/.fin-pgdata/log start`.
- Conventional commits, NO attribution footer. Always `cd /Users/anmolsen/Developer/fin` or use absolute paths.
- SMS ingest route is already public (bearer-guarded, in `proxy.ts` `PUBLIC_PATHS` under `/api/ingest/`); it does NOT use the auth seam. Only browser E2E uses the seam.

---

## File structure (target state)

```
src/lib/e2e-session.ts                 NEW  the production-disabled auth-bypass seam + unit test
src/lib/e2e-session.test.ts            NEW
src/proxy.ts                           MOD  use the seam before getSession
src/lib/current.ts                     MOD  use the seam before getSession (requireHousehold)
src/app/api/ingest/sms/route.test.ts   NEW  DB-backed HTTP integration test of the ingest route
src/lib/import/sms.test.ts             MOD  expanded parser coverage (append cases)
playwright.config.ts                   NEW  webServer launches app on compound_e2e with the bypass flag
e2e/global-setup.ts                    NEW  migrate + seed owner/household/account into compound_e2e
e2e/helpers.ts                         NEW  postSms() helper + DB reset between specs
e2e/sms-inbox.spec.ts                  NEW  SMS → inbox → accept → ledger
e2e/quick-add.spec.ts                  NEW  quick-add ≤3 taps → ledger
e2e/import-wizard.spec.ts              NEW  CSV import → preview → commit → inbox
bridge/tests/test_bridge.py            NEW  pytest for chat.db read, dedup, batching, post, --dry-run
bridge/tests/conftest.py               NEW  temp sqlite chat.db fixture + fake HTTP
bridge/requirements-dev.txt            NEW  pytest + requests-mock
package.json                           MOD  add "test:e2e" + "test:e2e:setup" scripts, @playwright/test devDep
```

---

### Task 1: Auth-bypass seam (production-disabled) + wiring

The one piece of production code that changes. A single helper returns a synthetic owner session ONLY in a non-production E2E context; `proxy.ts` and `current.ts` consult it before hitting better-auth. A unit test proves it is inert when `NODE_ENV==="production"`.

**Files:**
- Create: `src/lib/e2e-session.ts`, `src/lib/e2e-session.test.ts`
- Modify: `src/proxy.ts`, `src/lib/current.ts`

**Interfaces:**
- Produces: `e2eBypassEnabled(): boolean`; `e2eOwnerSession(): { user: { id: string; email: string } } | null` (returns a session shaped like the fields `proxy.ts`/`current.ts` read from better-auth's `getSession`: `session.user.id`, `session.user.email`). The synthetic owner id is the constant `E2E_OWNER_ID = "e2e-owner"`; email is `process.env.OWNER_EMAIL`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test** `src/lib/e2e-session.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { e2eBypassEnabled, e2eOwnerSession, E2E_OWNER_ID } from "./e2e-session";

const orig = { node: process.env.NODE_ENV, flag: process.env.E2E_AUTH_BYPASS, owner: process.env.OWNER_EMAIL };
afterEach(() => {
  process.env.NODE_ENV = orig.node;
  process.env.E2E_AUTH_BYPASS = orig.flag;
  process.env.OWNER_EMAIL = orig.owner;
});

describe("e2e auth seam", () => {
  it("is enabled only when non-production AND the flag is set", () => {
    process.env.NODE_ENV = "test"; process.env.E2E_AUTH_BYPASS = "1";
    expect(e2eBypassEnabled()).toBe(true);
  });
  it("is INERT in production even with the flag set", () => {
    process.env.NODE_ENV = "production"; process.env.E2E_AUTH_BYPASS = "1";
    expect(e2eBypassEnabled()).toBe(false);
    expect(e2eOwnerSession()).toBeNull();
  });
  it("is inert when the flag is absent", () => {
    process.env.NODE_ENV = "test"; delete process.env.E2E_AUTH_BYPASS;
    expect(e2eBypassEnabled()).toBe(false);
    expect(e2eOwnerSession()).toBeNull();
  });
  it("returns the owner session when enabled", () => {
    process.env.NODE_ENV = "test"; process.env.E2E_AUTH_BYPASS = "1"; process.env.OWNER_EMAIL = "owner@example.com";
    expect(e2eOwnerSession()).toEqual({ user: { id: E2E_OWNER_ID, email: "owner@example.com" } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/e2e-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/e2e-session.ts`:

```typescript
/**
 * Test-only auth bypass for browser E2E. DOUBLE-GATED: active only when
 * NODE_ENV !== "production" AND E2E_AUTH_BYPASS === "1". In any production
 * build this is dead code — e2eBypassEnabled() is false and e2eOwnerSession()
 * returns null, so proxy.ts / current.ts fall through to real better-auth.
 * Deliberately NOT in the typed env schema so it can never become required.
 */
export const E2E_OWNER_ID = "e2e-owner";

export function e2eBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.E2E_AUTH_BYPASS === "1";
}

export function e2eOwnerSession(): { user: { id: string; email: string } } | null {
  if (!e2eBypassEnabled()) return null;
  const email = process.env.OWNER_EMAIL;
  if (!email) return null;
  return { user: { id: E2E_OWNER_ID, email } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/e2e-session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `src/proxy.ts`** — add the import and short-circuit before the real session fetch. Replace the existing session block:

```typescript
import { e2eBypassEnabled, e2eOwnerSession } from "@/lib/e2e-session";
// ...inside proxy(), replacing `const session = await auth.api.getSession(...)`:
  const session = e2eBypassEnabled()
    ? e2eOwnerSession()
    : await auth.api.getSession({ headers: request.headers });
```

(The downstream `if (!session)` and `isAllowed(session.user.email)` checks are unchanged — the synthetic session carries `user.email = OWNER_EMAIL`, which passes `isAllowed`.)

- [ ] **Step 6: Wire into `src/lib/current.ts`** — in `requireHousehold`, replace the session fetch:

```typescript
import { e2eBypassEnabled, e2eOwnerSession } from "@/lib/e2e-session";
// ...replacing `const session = await auth.api.getSession({ headers: await headers() })`:
  const session = e2eBypassEnabled()
    ? e2eOwnerSession()
    : await auth.api.getSession({ headers: await headers() });
```

(The `users` mapping lookup by `session.user.id` then resolves the `E2E_OWNER_ID` row that Task 4's global-setup seeds.)

- [ ] **Step 7: Verify no regression + typecheck**

Run: `pnpm exec tsc --noEmit` (expect clean) then `pnpm test src/lib/e2e-session.test.ts` (expect PASS). The seam is off by default (`E2E_AUTH_BYPASS` unset), so the full suite is unaffected; a quick `pnpm test src/lib/allowlist.test.ts` should still pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/e2e-session.ts src/lib/e2e-session.test.ts src/proxy.ts src/lib/current.ts
git commit -m "feat: production-disabled E2E auth bypass seam"
```

---

### Task 2: SMS ingest route integration test

The biggest current gap: `POST /api/ingest/sms` has no automated test. Test the full HTTP contract against the real `compound_test` DB by importing the route's `POST` handler directly and passing a `Request` (no network/server needed). Covers: bearer auth, parse → resolve account via `accounts.metadata.smsKey` → stage → commit (entries land `pending`), and the never-drop anomaly paths.

**Files:**
- Create: `src/app/api/ingest/sms/route.test.ts`

**Interfaces:**
- Consumes: the route's exported `POST(req: Request)` from `./route`; `tdb`/`resetDb`/`seedBasics` from `@/lib/ledger/test-db`; `schema` from `@/db/schema`. Request body shape: `{ messages: { sender, body, receivedAt }[] }`. Auth header: `Authorization: Bearer ${process.env.INGEST_SECRET}`. Response: `{ ok, staged, committed, duplicates, unparsed, unmapped }`.

- [ ] **Step 1: Write the failing test** `src/app/api/ingest/sms/route.test.ts`. Read `src/app/api/ingest/sms/route.ts` and `src/lib/import/sms.ts` first to confirm the SBI template body + the `acctKey` format (`SBI:<last4>`). The test sets `accounts.metadata.smsKey` so resolution succeeds:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { POST } from "./route";

const SECRET = process.env.INGEST_SECRET ?? "dev_ingest_secret_change_me_01";
function req(body: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request("http://localhost/api/ingest/sms", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}
// A real SBI UPI debit body (acctKey SBI:3519). Confirm exact regex against sms.ts.
const SBI = "Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 If not u? call-1800111109 -SBI";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /api/ingest/sms", () => {
  beforeEach(resetDb);

  it("rejects a missing/wrong bearer with 401", async () => {
    const res = await POST(req({ messages: [{ sender: "x", body: "y", receivedAt: "2026-06-05T10:00:00Z" }] }, "Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await POST(req({ messages: [] }));
    expect(res.status).toBe(400);
  });

  it("parses a known SBI SMS, resolves the account by smsKey, and commits a pending entry", async () => {
    const { hh, bank } = await seedBasics();
    await tdb.update(schema.accounts).set({ metadata: { smsKey: "SBI:3519" } }).where(eq(schema.accounts.id, bank.id));

    const res = await POST(req({ messages: [{ sender: "AD-SBIUPI", body: SBI, receivedAt: "2026-06-05T10:00:00Z" }] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.committed).toBe(1);

    const entries = await tdb.select().from(schema.entries).where(eq(schema.entries.accountId, bank.id));
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("pending");
    expect(entries[0].amount).toBe("-525.0000");
    expect(entries[0].source).toBe("import");
  });

  it("records an unparsed financial SMS as a sms_unparsed anomaly (never dropped)", async () => {
    await seedBasics();
    const res = await POST(req({ messages: [{ sender: "PROMO", body: "Win a free iPhone now!", receivedAt: "2026-06-05T10:00:00Z" }] }));
    const json = await res.json();
    expect(json.unparsed).toBe(1);
    const anomalies = await tdb.select().from(schema.ledgerAnomalies).where(eq(schema.ledgerAnomalies.kind, "sms_unparsed"));
    expect(anomalies.length).toBe(1);
  });

  it("records a parsed-but-unmapped account as a sms_unmapped anomaly", async () => {
    await seedBasics(); // no account has smsKey "SBI:3519"
    const res = await POST(req({ messages: [{ sender: "AD-SBIUPI", body: SBI, receivedAt: "2026-06-05T10:00:00Z" }] }));
    const json = await res.json();
    expect(json.unmapped).toBe(1);
    expect(json.committed).toBe(0);
    const anomalies = await tdb.select().from(schema.ledgerAnomalies).where(eq(schema.ledgerAnomalies.kind, "sms_unmapped"));
    expect(anomalies.length).toBe(1);
  });

  it("dedupes a re-sent identical SMS (second post commits nothing new)", async () => {
    const { bank } = await seedBasics();
    await tdb.update(schema.accounts).set({ metadata: { smsKey: "SBI:3519" } }).where(eq(schema.accounts.id, bank.id));
    const msg = { messages: [{ sender: "AD-SBIUPI", body: SBI, receivedAt: "2026-06-05T10:00:00Z" }] };
    await POST(req(msg));
    const res2 = await POST(req(msg));
    const json2 = await res2.json();
    expect(json2.committed).toBe(0);
    expect(json2.duplicates).toBe(1);
    const entries = await tdb.select().from(schema.entries).where(eq(schema.entries.accountId, bank.id));
    expect(entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify the suite drives the route**

Run: `pnpm test src/app/api/ingest/sms/route.test.ts`
Expected: the tests run; any assertion that doesn't match the real route contract is a finding to reconcile. If `schema.ledgerAnomalies` is exported under a different name, fix the import to the real export (check `src/db/schema/ops.ts`). If the SBI body/amount differs from `sms.ts`'s regex, adjust the fixture/expected value to the parser's real output (do NOT change the parser). Goal: all 6 cases pass.

- [ ] **Step 3: Reconcile and make green**

If a case fails because the route genuinely behaves differently than asserted (e.g. dedup field name), correct the TEST to the real contract and note it. If a case reveals an actual route bug (e.g. an unparsed SMS is dropped with no anomaly), STOP and report it — do not paper over it.

- [ ] **Step 4: Confirm no regression**

Run: `pnpm test src/lib/import/sms.test.ts` (parser unit tests still pass) and `pnpm exec tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ingest/sms/route.test.ts
git commit -m "test: SMS ingest route integration (auth, parse, stage, commit, anomalies, dedup)"
```

---

### Task 3: Expanded SMS parser coverage

Harden `parseSmsRows`/`normalizeMerchant` against real-world variety. Append cases to the existing `src/lib/import/sms.test.ts` (do not rewrite existing cases).

**Files:**
- Modify: `src/lib/import/sms.test.ts`

**Interfaces:**
- Consumes: `parseSmsRows(messages: RawSms[]): { parsed: ParsedSms[]; unparsed: RawSms[] }` and `normalizeMerchant(raw: string): string` from `@/lib/import/sms`. `ParsedSms = { acctKey, template, row: { date, amount, description, externalId? }, dueDate? }`.

- [ ] **Step 1: Read `src/lib/import/sms.ts` fully** to enumerate the real templates (T1 SBI UPI debit, T2 ICICI CC, T3 LazyPay BNPL) and their exact regexes, so new cases exercise true behavior.

- [ ] **Step 2: Append a new `describe("parseSmsRows — edge & robustness")` block** with these cases (write concrete assertions matching the parser's real output observed in Step 1):

```typescript
import { parseSmsRows, normalizeMerchant } from "@/lib/import/sms";

describe("parseSmsRows — edge & robustness", () => {
  it("routes an empty body and a whitespace-only body to unparsed, never throws", () => {
    const out = parseSmsRows([
      { sender: "AD-SBIUPI", body: "", receivedAt: "2026-06-05T10:00:00Z" },
      { sender: "AD-SBIUPI", body: "   ", receivedAt: "2026-06-05T10:00:00Z" },
    ]);
    expect(out.parsed).toHaveLength(0);
    expect(out.unparsed).toHaveLength(2);
  });

  it("does not partial-match a truncated SBI SMS (missing Refno) — goes to unparsed", () => {
    const out = parseSmsRows([{ sender: "AD-SBIUPI", body: "A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure", receivedAt: "2026-06-05T10:00:00Z" }]);
    expect(out.parsed).toHaveLength(0);
    expect(out.unparsed).toHaveLength(1);
  });

  it("parses amounts with thousands separators correctly", () => {
    // Use the real SBI template with an amount like 12,345.67 → expect "-12345.6700"
    const out = parseSmsRows([{ sender: "AD-SBIUPI", body: "Dear UPI user A/C X3519 debited by 12,345.67 on date 05Jun26 trf to BigBasket Refno 207781447299 -SBI", receivedAt: "2026-06-05T10:00:00Z" }]);
    expect(out.parsed[0]?.row.amount).toBe("-12345.6700");
  });

  it("preserves a large batch order-independently and reports counts", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ sender: "PROMO", body: `noise ${i}`, receivedAt: "2026-06-05T10:00:00Z" }));
    const out = parseSmsRows(msgs);
    expect(out.unparsed).toHaveLength(20);
    expect(out.parsed).toHaveLength(0);
  });

  it("normalizeMerchant collapses whitespace and strips a trailing reference blob", () => {
    expect(normalizeMerchant("  EATSURE   FOODCOUR  ")).toBe(normalizeMerchant("EatSure Foodcour"));
  });
});
```

Adjust each expected value to the parser's actual output from Step 1 (the amount-format and normalize cases especially). If a case reveals the parser silently mis-parses (e.g. drops the thousands separator wrong), report it rather than weakening the assertion.

- [ ] **Step 3: Run**

Run: `pnpm test src/lib/import/sms.test.ts`
Expected: all existing + new cases PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/import/sms.test.ts
git commit -m "test: expand SMS parser edge/robustness coverage"
```

---

### Task 4: Playwright harness + browser E2E flows

A real-browser harness that boots the app against a dedicated `compound_e2e` DB with the auth seam on, seeds the owner, and drives the three critical flows. Read `src/app/(app)/inbox/page.tsx`, `src/components/inbox/entry-card.tsx`, the quick-entry component, and `src/app/(app)/import/` to derive real selectors (prefer role/text selectors; add `data-testid` only where a flow is otherwise unselectable).

**Files:**
- Create: `playwright.config.ts`, `e2e/global-setup.ts`, `e2e/helpers.ts`, `e2e/sms-inbox.spec.ts`, `e2e/quick-add.spec.ts`, `e2e/import-wizard.spec.ts`
- Modify: `package.json` (devDep `@playwright/test`; scripts `test:e2e:setup`, `test:e2e`)

**Interfaces:**
- Consumes: the running app; `POST /api/ingest/sms` (real HTTP) for the SMS flow; the auth seam from Task 1 (`E2E_AUTH_BYPASS=1`) and the seeded `E2E_OWNER_ID` mapping.

- [ ] **Step 1: Add the toolchain**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```
Create the `compound_e2e` database and migrate it:
```bash
psql "postgresql://compound@127.0.0.1:54329/postgres" -c "CREATE DATABASE compound_e2e OWNER compound;" 2>/dev/null || true
DATABASE_URL="postgresql://compound@127.0.0.1:54329/compound_e2e" npx drizzle-kit migrate
```
Add to `package.json` scripts:
```json
"test:e2e": "playwright test",
"test:e2e:setup": "DATABASE_URL=postgresql://compound@127.0.0.1:54329/compound_e2e npx drizzle-kit migrate"
```

- [ ] **Step 2: `playwright.config.ts`** — boots `next dev` against `compound_e2e` with the bypass flag:

```typescript
import { defineConfig } from "@playwright/test";

const E2E_DB = "postgresql://compound@127.0.0.1:54329/compound_e2e";
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false, // single shared DB
  workers: 1,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "next dev -p 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: E2E_DB,
      E2E_AUTH_BYPASS: "1",
      NODE_ENV: "development",
      INGEST_SECRET: process.env.INGEST_SECRET ?? "dev_ingest_secret_change_me_01",
      OWNER_EMAIL: process.env.OWNER_EMAIL ?? "owner@example.com",
    } as Record<string, string>,
  },
});
```

- [ ] **Step 3: `e2e/global-setup.ts`** — seed owner auth user + household mapping + one SBI-keyed bank account into `compound_e2e` (idempotent). Connect with `pg` directly (no app imports needed):

```typescript
import { Pool } from "pg";
const E2E_DB = "postgresql://compound@127.0.0.1:54329/compound_e2e";
const OWNER_ID = "e2e-owner";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "owner@example.com";

export default async function globalSetup() {
  const pool = new Pool({ connectionString: E2E_DB });
  // Clean slate, then seed household → users mapping → auth_user → SBI-keyed bank account.
  await pool.query("TRUNCATE entry_events, transaction_splits, valuations, transfers, entries, import_rows, imports, ledger_anomalies, balances, rollups, categories, accounts, users, households, auth_session, auth_account, auth_user RESTART IDENTITY CASCADE");
  const hh = (await pool.query("INSERT INTO households (name) VALUES ('e2e') RETURNING id")).rows[0];
  await pool.query("INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ($1,'E2E Owner',$2,true,now(),now()) ON CONFLICT (id) DO NOTHING", [OWNER_ID, OWNER_EMAIL]);
  await pool.query("INSERT INTO users (id, household_id, email) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [OWNER_ID, hh.id, OWNER_EMAIL]);
  await pool.query("INSERT INTO accounts (household_id, name, kind, opening_balance, opening_date, metadata) VALUES ($1,'SBI','bank','10000','2026-01-01', $2)", [hh.id, JSON.stringify({ smsKey: "SBI:3519" })]);
  // seed a couple of expense categories so quick-add/recategorize have choices
  await pool.query("INSERT INTO categories (household_id, name, classification) VALUES ($1,'Food & Dining','expense'), ($1,'Groceries','expense')", [hh.id]);
  await pool.end();
}
```
(Confirm the real `auth_user` column names against `src/db/schema/auth.ts`; adjust the INSERT to match — better-auth's required columns. If `email_verified`/timestamps differ, use the actual columns.)

- [ ] **Step 4: `e2e/helpers.ts`** — a `postSms` helper and the SBI fixture:

```typescript
export const SBI_BODY = "Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 -SBI";
export async function postSms(baseURL: string, messages: { sender: string; body: string; receivedAt: string }[]) {
  const res = await fetch(`${baseURL}/api/ingest/sms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.INGEST_SECRET ?? "dev_ingest_secret_change_me_01"}` },
    body: JSON.stringify({ messages }),
  });
  return res.json();
}
```

- [ ] **Step 5: `e2e/sms-inbox.spec.ts`** — the headline flow:

```typescript
import { test, expect } from "@playwright/test";
import { postSms, SBI_BODY } from "./helpers";

test("an SMS-captured expense appears in the inbox and accepts into the ledger", async ({ page, baseURL }) => {
  const result = await postSms(baseURL!, [{ sender: "AD-SBIUPI", body: SBI_BODY, receivedAt: "2026-06-05T10:00:00Z" }]);
  expect(result.committed).toBe(1);

  await page.goto("/inbox");
  // the pending entry shows its merchant + amount
  await expect(page.getByText(/EatSure/i)).toBeVisible();
  await expect(page.getByText("−₹525")).toBeVisible(); // U+2212 minus per money.ts

  // accept it
  await page.getByRole("button", { name: "Accept" }).first().click();
  // inbox empties → "All caught up"
  await expect(page.getByText(/All caught up/i)).toBeVisible();
});
```
(Adjust the amount text to `formatINR`'s exact output observed in `entry-card.tsx`; `formatINR("-525.0000")` is `<₹1000` so it keeps paise → likely `−₹525.00`. Use the real rendered string.)

- [ ] **Step 6: `e2e/quick-add.spec.ts`** — quick entry ≤3 taps. Read the quick-entry component for the real FAB/keypad selectors and assert a new posted transaction lands (e.g. visible on the transactions or home recent list). Keep it to the documented flow: open FAB → amount keypad → category chip → save.

- [ ] **Step 7: `e2e/import-wizard.spec.ts`** — upload a tiny CSV fixture through `/import` (pick account → map columns → preview shows "N new" → commit → inbox badge / pending entries appear). Use a 2-row inline CSV written to a temp file and the file-input upload. Read `src/app/(app)/import/` for the step selectors.

- [ ] **Step 8: Run the E2E suite**

Run: `pnpm test:e2e`
Expected: all three specs pass. If a selector misses, fix the spec (or add a minimal `data-testid` to the component) — but do not change app behavior. If a flow reveals a real bug, report it.

- [ ] **Step 9: Commit**

```bash
git add playwright.config.ts e2e/ package.json pnpm-lock.yaml
git commit -m "test: Playwright E2E for SMS→inbox, quick-add, and import flows"
```

---

### Task 5: Mac bridge (`bridge.py`) pytest suite

Test the Python bridge that reads `chat.db` and posts to the ingest endpoint. Read `bridge/bridge.py` first to learn its function boundaries (chat.db query, dedup/state, batching, HTTP post, `--dry-run`). Test against a temp SQLite DB shaped like the relevant `chat.db` columns, with the HTTP call faked.

**Files:**
- Create: `bridge/tests/conftest.py`, `bridge/tests/test_bridge.py`, `bridge/requirements-dev.txt`

**Interfaces:**
- Consumes: the functions/CLI in `bridge/bridge.py`. If `bridge.py` is a flat script, the task may need to ensure its key logic is importable (a `main()` guard under `if __name__ == "__main__"`); if it already separates functions, import them directly.

- [ ] **Step 1: Read `bridge/bridge.py`** and list its testable units: the chat.db read/query, the message→`{sender,body,receivedAt}` mapping, dedup/seen-state, batching, the POST, and the `--dry-run` switch. Note exact function names and signatures.

- [ ] **Step 2: `bridge/requirements-dev.txt`**:

```
pytest>=8
requests-mock>=1.12
```

- [ ] **Step 3: `bridge/tests/conftest.py`** — a fixture that builds a temp SQLite DB with the minimal `message`/`handle`/`chat` columns `bridge.py` reads, populated with 2–3 rows (incl. one duplicate to exercise dedup). Mirror the real column names found in Step 1.

- [ ] **Step 4: `bridge/tests/test_bridge.py`** — concrete tests against the functions from Step 1:
  - reads rows from the temp chat.db and maps them to the `{sender, body, receivedAt}` shape;
  - dedups already-seen messages (second run posts nothing new);
  - batches correctly (respects the max batch size);
  - `--dry-run` performs the read but makes NO HTTP POST (assert the faked transport was not called);
  - a normal run POSTs the expected JSON body with the bearer header.

  Use `requests-mock` (or `monkeypatch` on the HTTP client `bridge.py` actually uses) to fake the endpoint. Write the assertions against the real function names from Step 1. (If `bridge.py` uses `urllib` rather than `requests`, monkeypatch `urllib.request.urlopen` instead and drop `requests-mock`.)

- [ ] **Step 5: Run**

```bash
cd /Users/anmolsen/Developer/fin/bridge
python3 -m venv .venv-test && . .venv-test/bin/activate && pip install -q -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -v
```
Expected: all bridge tests PASS. (Deactivate after; the `.venv-test` is gitignored — add it to `bridge/.gitignore`.)

- [ ] **Step 6: Commit**

```bash
git add bridge/tests/ bridge/requirements-dev.txt bridge/.gitignore
git commit -m "test: pytest suite for the Mac SMS bridge (chat.db read, dedup, dry-run, post)"
```

---

## Self-review (done at write time)

- **Scope coverage:** the four requested layers map to Tasks 2 (route integration), 3 (parser coverage), 4 (browser E2E), 5 (bridge pytest); Task 1 is the prerequisite auth seam that makes Task 4 possible. Ledger coverage already exists at the lib layer (write/derive/invariants/dedup/inbox/rollups/transfers — 257 tests); this plan adds the SMS-path and full-stack layers that were missing rather than duplicating it.
- **Auth-seam safety:** double-gated (`NODE_ENV!=="production"` AND `E2E_AUTH_BYPASS==="1"`), unit-tested for production-inertness (Task 1 Step 1), never added to typed env, off by default so the existing 257 tests and any prod build are unaffected.
- **Placeholder scan:** test bodies are concrete; the few "confirm against the real file" notes (auth_user columns, exact `formatINR` strings, bridge.py function names, inbox selectors) are reconciliation instructions for facts that live in unchanged code the implementer must read — not deferred logic. Each names the exact file to read and the rule (adjust the test to the real contract; report a real bug rather than weaken an assertion).
- **Type/name consistency:** `e2eBypassEnabled`/`e2eOwnerSession`/`E2E_OWNER_ID` are used identically in Tasks 1 and 4; `postSms`/`SBI_BODY` defined in `e2e/helpers.ts` (Task 4 Step 4) and consumed by the specs; the ingest response fields (`committed`/`duplicates`/`unparsed`/`unmapped`) are consistent between Tasks 2 and 4.
- **DB isolation:** route/parser tests use the existing `compound_test` (serial, `skipIf`-guarded); browser E2E uses a dedicated `compound_e2e` so a long-running dev server can't collide with the Vitest suite.
