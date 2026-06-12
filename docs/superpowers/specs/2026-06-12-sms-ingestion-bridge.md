# SMS Ingestion Bridge (P1.5) — Design Spec

> Real-time transaction capture from bank/UPI/card/BNPL SMS, for the iPhone-using
> owner, via a local Mac bridge. Slots in **after the P1 UI reskin, before P3 (Gmail)**.
> Reuses the existing import pipeline end-to-end; adds no ledger logic.
>
> Companion to the master spec (`2026-06-11-personal-finance-system-design.md` §5
> Ingestion, §6 Review inbox). Created 2026-06-12.

## 1. Why this exists

The owner is on **iPhone 17** and ~99% of spend is **UPI** (plus credit card + BNPL).
iOS forbids apps from reading SMS, and banks **SMS** every small UPI/card debit but
rarely **email** them — so the planned Gmail phase (P3) would miss most real spend.
SMS is the universal real-time signal across every rail. Capturing it removes the
single biggest friction point: manual entry / waiting for month-end statements.

iOS has no app-level SMS read, but **macOS does**: with Text Message Forwarding on,
iPhone SMS mirror to the Mac's Messages app and land in `~/Library/Messages/chat.db`.
A local script can read that DB and forward parsed transactions to Compound. All local;
nothing leaves the owner's machine except structured rows posted to his own app.

Feasibility confirmed (2026-06-12): `imessage-exporter` (maintained Rust tool/library)
supports **SMS/MMS** and lists support as of **macOS Tahoe 26.5.1 / iOS 26.5.1** — the
owner's current setup — and solves the hard part (decoding the `typedstream`
`attributedBody` blob). The bridge stands on a solved, maintained foundation.

## 2. Goal & non-goals

- **Goal:** near-real-time capture of debit/spend (and credit) transactions from bank,
  credit-card, and BNPL SMS into the review inbox, deduped against later statement imports.
- **Non-goals:** money movement (never, any phase); reading SMS on the phone itself;
  100% coverage (statements remain the source of truth for completeness); cloud SMS
  processing (parsing is local on the Mac).

## 3. Architecture

```
iPhone (UPI / card / BNPL txn) → bank SMS
  └─ Text Message Forwarding → Mac Messages → ~/Library/Messages/chat.db
       └─ [Mac bridge agent]  watch → decode → parse → batch
            └─ POST /api/ingest/sms   Authorization: Bearer INGEST_SECRET
                 └─ parseSmsRows() → NormalizedRow[]
                      └─ stageImport() → commitImport()      (existing pipeline)
                           └─ entries land status=pending → Review inbox → 1-swipe accept
```

Two new pieces only: a **Mac bridge agent** (local, off-repo) and a thin **ingest
route + SMS parser** in the app. Everything downstream (staging, dedup, invariants,
inbox, accept) is the code already built.

## 4. Mac bridge agent (local, runs on the owner's Mac)

A small script (Python recommended) run by `launchd`:

1. **Cursor:** persist the last-processed `message.ROWID` (e.g. in a local JSON file).
2. **Watch:** every ~30–60s, open `~/Library/Messages/chat.db` **read-only**
   (`?mode=ro&immutable=1`) to avoid Messages' WAL lock; select new rows
   `WHERE ROWID > :cursor AND is_from_me = 0` joined to `handle` for the sender.
3. **Filter:** keep only bank/financial senders (DLT headers / shortcodes — see §6),
   discard everything else (OTPs, personal texts) **before** parsing. Personal messages
   are never read beyond the sender filter.
4. **Decode body:** prefer `message.text`; when NULL (common on recent macOS), decode
   `attributedBody` using the imessage-exporter library (do **not** hand-roll a
   typedstream decoder — that breaks on OS updates).
5. **Parse:** run per-bank templates (§6) → structured txn(s).
6. **POST** a batch to `/api/ingest/sms` with the bearer token; on 2xx advance the cursor.
7. **Discard** raw SMS text after parsing (only structured rows leave the machine).

Setup (one-time): enable **Text Message Forwarding** (iPhone → this Mac); grant the
script **Full Disk Access**; install the `launchd` agent (`StartInterval` + `KeepAlive`).
Mac-asleep behavior: no real-time capture while asleep; it backfills on wake (cursor
ensures nothing is missed). Acceptable for a daily-driver laptop.

## 5. App side — ingest route (new)

`POST /api/ingest/sms` — `src/app/api/ingest/sms/route.ts`

- **Auth:** `Authorization: Bearer ${INGEST_SECRET}` with a timing-safe compare —
  the exact pattern as `GET /api/cron/invariants`. New env var `INGEST_SECRET`
  (≥16 chars, Zod-validated at startup in `src/lib/env.ts`), revocable independently
  of `CRON_SECRET`. No browser session (machine caller).
- **Body:** `{ messages: RawSms[] }` where `RawSms = { sender, body, receivedAt }`,
  OR pre-parsed rows — **parse server-side** so templates live in the repo and are
  testable. Recommended: send `{ sender, body, receivedAt }` and parse in the route.
- **Flow:**
  1. `parseSmsRows(messages)` → `{ accountId, row: NormalizedRow }[]` (new module
     `src/lib/import/sms.ts`; pure + unit-tested against the §6 fixtures).
  2. Group by `accountId`; for each: `stageImport(db, { householdId, accountId,
     filename: "sms:<yyyy-mm-dd>", rows })` then `commitImport(db, importId,
     householdId)`. Entries land `status="pending"`, `source="import"`.
  3. Log `entry_events.source = "import:sms"` for traceability (no enum migration —
     `entries.source` stays `manual|import|system`; SMS rides as `import`).
  4. Return `{ ok, staged, committed, duplicates, unparsed }`.
- **Unparsed SMS:** never silently dropped. A financial-sender SMS that matches no
  template is recorded (e.g. an `sms_unparsed` log row / surfaced to review) so a new
  template can be added — mirrors the master spec's "parse failures detectable, routed
  to review, never silent" and the future P3 template-writer agent.
- **householdId / accountId:** single-user app — resolve `householdId` from env
  (`OWNER_HOUSEHOLD_ID`) or `SELECT id FROM households LIMIT 1`. `accountId` resolved by
  the parser from the SMS (see §6 account mapping).

`NormalizedRow` produced per SMS (matches the existing import contract):

```ts
{
  date: string         // "YYYY-MM-DD"
  amount: string       // signed, 4dp — debit/spend negative, credit positive (ADR-1)
  description: string  // normalized merchant (see §6)
  externalId?: string  // UPI Refno / UTR when present — the strong dedup key
  balance?: string     // omit for SMS (no running-balance sequence; see §7)
}
```

## 6. SMS parser (`src/lib/import/sms.ts`)

Per-template, deterministic-first (same philosophy as the master spec's per-bank email
templates). Each template: detect → extract `{ amount, direction, acctKey, merchant,
ref?, txnDate?, dueDate? }` → resolve `acctKey → accountId` → emit a `NormalizedRow`.

### Account mapping
A config map `acctKey → accountId`, where `acctKey` is the bank+last4 (or BNPL provider).
Banks/cards/BNPL are existing accounts (the app already has liability-aware accounts).
A small `GET /api/ingest/accounts` (same bearer auth) can return the live map, or the
bridge hardcodes it. **Liability rails** (credit card, LazyPay): the SMS spend lands on
that liability account at purchase time; the later **repayment** is a separate
bank→liability **transfer** (the existing transfer machinery) — the SMS ingestion must
NOT also book the repayment as a fresh expense (dedup + account scoping handle this).

### Initial templates + fixtures (the owner's real SMS)

**T1 — SBI UPI debit (bank account, has UPI Refno):**
```
Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 If not u? call-1800111109 ... -SBI
```
→ acctKey `SBI:3519` · amount `-525.0000` · date `2026-06-05` (`05Jun26`) ·
merchant `EatSure Foodcour` · **externalId `207781447224`** (gold dedup key) · direction debit.
Regex sketch: `A\/C X(\d{4}) debited by ([\d,]+\.\d{2}) on date (\d{2}[A-Za-z]{3}\d{2}) trf to (.+?) Refno (\d+)`

**T2 — ICICI credit card spend (liability account, no UPI ref):**
```
INR 631.83 spent using ICICI Bank Card XX1004 on 11-Jun-26 on PTM*ZOMATO LIMI. Avl Limit: INR 8,997.77 ...
```
→ acctKey `ICICI-CC:1004` · amount `-631.8300` · date `2026-06-11` · merchant
`PTM*ZOMATO LIMI` → normalize → `Zomato` · no externalId → hash dedup · "Avl Limit" is
NOT a balance (ignore for continuity).
Regex sketch: `INR ([\d,]+\.\d{2}) spent using ICICI Bank Card XX(\d{4}) on (\d{2}-[A-Za-z]{3}-\d{2}) on (.+?)\. Avl Limit`

**T3 — LazyPay BNPL spend (liability account + due date):**
```
Dear LazyPay Customer, your payment of Rs. 651.00 for txn TXN581372203 on Swiggy was successful. Pay by 18th June, 2026 using https://...
```
→ acctKey `LazyPay` · amount `-651.0000` · date = message `receivedAt` (no txn date in
body) · merchant `Swiggy` · txnId `TXN581372203` · **dueDate `2026-06-18`** → emits a
bill/surfaced "Pay by" reminder in addition to the spend.
Regex sketch: `payment of Rs\. ([\d,]+\.\d{2}) for txn (\w+) on (.+?) was successful\. Pay by (.+?) using`

### Merchant normalization
Strip aggregator prefixes/noise (`PTM*`, `UPI/`, trailing ` LIMI`/`LIMITED`,
`*` segments), collapse whitespace, title-case; map known aliases
(`ZOMATO→Zomato`, `EatSure→EatSure`). Messy merchant strings are expected — the review
inbox + learning loop refine categorization; the statement reconciles names.

### Date parsing
Handle `05Jun26`, `11-Jun-26`, `18th June, 2026` → `YYYY-MM-DD`. Assume IST.

## 7. Dedup & reconciliation

- **UPI Refno / UTR as `externalId`** (T1) is the strong key: `stageImport` checks
  `(accountId, externalId, amount)` against live entries, so the same txn arriving later
  in the SBI statement is marked `duplicate` and skipped.
- **No ref (T2 card, T3 BNPL):** fall back to the occurrence hash
  (`accountId|date|amount|normalizeDescription|occurrenceIndex`). Card/BNPL statement
  reconciliation is best-effort here (SMS merchant vs statement narration may differ);
  the statement remains source of truth and any SMS miss/dupe is correctable in review.
- **Idempotent:** re-POSTing the same SMS yields the same hash → `commitImport` creates
  zero new entries.
- **No continuity check for SMS:** `balance` omitted (no running-balance sequence), so
  `validateContinuity` produces no false `suspicious` verdicts. Accepted trade-off.

## 8. Security & privacy

- Raw SMS bodies are parsed **locally on the Mac and discarded**; only structured rows
  (amount, date, merchant, last4, ref) are sent — to the owner's own app, never a cloud
  model. Matches "statements parsed → discarded; last-4 only; never full account numbers".
- `INGEST_SECRET` in Vercel env, Zod-validated at startup, timing-safe compare, no
  `NEXT_PUBLIC_`. Revocable independently of cron. The endpoint only stages to the
  single owner household; it never moves money.
- Sender filter runs first — personal (non-financial) messages are never parsed or sent.

## 9. Roadmap placement

Add **P1.5 — SMS bridge** to the master roadmap, between P1 (reskin/ship) and P3
(Gmail). Rationale: highest-leverage ingestion source for a 99%-UPI iPhone user; small
because it reuses the pipeline (one route + one parser module + a local script);
removes the app's biggest daily friction. Build order: P1 reskin → **P1.5 SMS** → P2 /
P3 driven by real usage.

## 10. Build checklist (implemented 2026-06-12)

- [x] `INGEST_SECRET` in `env.ts` (Zod, `min(16)`, mirrors `CRON_SECRET`). _Vercel env still
      to set; local dev token added to gitignored `.env.local`._
- [x] `src/lib/import/sms.ts` — `parseSmsRows()` + templates T1–T3 + `normalizeMerchant`,
      pure/DB-free, unit-tested on the §6 fixtures incl. the unparsed-fallback path
      (`src/lib/import/sms.test.ts`).
- [x] `src/app/api/ingest/sms/route.ts` — bearer auth (timing-safe, same shape as
      `/api/cron/invariants`), parse → resolve account → stage → commit; added `/api/ingest/`
      to `PUBLIC_PATHS` in `src/proxy.ts` (machine caller, no session).
- [x] Unparsed capture — recorded to the **existing `ledger_anomalies`** table as
      `kind="sms_unparsed"` (hash-deduped, "never silent"), **no new table / no migration**.
      Unmapped accounts recorded as `kind="sms_unmapped"`.
- [x] `acctKey→accountId` map via **`accounts.metadata.smsKey`** (data, not schema — the
      `metadata` jsonb already exists). _Owner must set e.g. `{"smsKey":"SBI:3519"}` on the SBI
      account, `"ICICI-CC:1004"` on the card, `"LazyPay"` on the BNPL account._ The optional
      `GET /api/ingest/accounts` was not needed (route resolves live from the DB).
- [x] Mac bridge: `bridge/bridge.py` (stdlib-only chat.db reader `?mode=ro&immutable=1`,
      inlined attributedBody typedstream decoder, two-pass sender filter, ROWID cursor,
      batched POST, retry/backoff) + `bridge/com.compound.sms-bridge.plist` (launchd,
      `StartInterval 60`).
- [x] One-time setup doc: `bridge/README.md` (Text Message Forwarding + Full Disk Access +
      launchd load + `--dry-run` test).
- [x] Verify dedup: SMS-then-statement for an SBI UPI txn books once — covered by the
      DB-gated integration test in `sms.test.ts`.

**Minor deviation:** `entry_events.source="import:sms"` (§5.3) was not added — that would mean
editing `commitImport` (out of surgical scope). Traceability instead rides the `imports.filename`
`"sms:<yyyy-mm-dd>"`. `entries.source` stays `"import"` as specified.

**Still to do before live use:** set `INGEST_SECRET` in Vercel env; set `metadata.smsKey` on the
three accounts; on the Mac, enable Text Message Forwarding + grant Full Disk Access + load the plist.

## 11. Open questions

- Exact bank/sender DLT header list (build from the owner's real inbox; T1–T3 cover
  SBI / ICICI-CC / LazyPay to start).
- Should BNPL/CC due dates auto-create Bills entries, or just surface a Home reminder?
  _(Still open. The T3 parser already extracts `dueDate`; the route currently drops it —
  no Bills table yet. Wire up once the Bills/reminders surface exists.)_
- ~~Bridge language~~ **Resolved:** Python 3, stdlib-only. The `imessagedb` attributedBody
  decode strategy was inlined (zero pip installs); runs on system `python3` out of the box.
- ~~Stage-and-preview vs commit-straight-to-inbox~~ **Resolved:** commit straight to inbox —
  entries land `status="pending"`; the review inbox *is* the review step.
