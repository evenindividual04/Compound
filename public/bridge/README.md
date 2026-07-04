# Compound SMS Bridge

Reads new financial SMS from macOS Messages (`~/Library/Messages/chat.db`) and
POSTs them (raw, unparsed) to the Compound app's `/api/ingest/sms` endpoint.

The bridge does **not** parse transactions. All parsing happens server-side.

---

## Prerequisites

| Requirement | How to satisfy |
|---|---|
| macOS with iMessages | Already installed |
| iPhone with Text Message Forwarding | Settings → Messages → Text Message Forwarding → enable your Mac |
| Python 3.9+ | Ships with macOS; `python3 --version` to verify |
| Full Disk Access for Terminal | **See step 3 below** |

---

## One-time setup

### 1. Enable Text Message Forwarding on iPhone

1. On iPhone → **Settings → Messages → Text Message Forwarding**.
2. Toggle on your Mac.
3. Enter the 6-digit code that appears on the Mac.

After this, SMS (green-bubble) messages arrive in macOS Messages and land in
`~/Library/Messages/chat.db`.

### 2. Run the installer

From your Compound app's **Setup** page (Browse → Setup), copy the ready-made command
and paste it into Terminal. It looks like:

```bash
curl -fsSL https://your-instance.vercel.app/bridge/install.sh | INGEST_URL=https://your-instance.vercel.app INGEST_SECRET=<your secret> bash
```

This downloads `bridge.py`, writes `~/.compound-sms-bridge/config.json`, and installs and
loads the launchd agent — no manual file editing.

### 3. Grant Full Disk Access to Terminal (required)

macOS sandboxes `~/Library/Messages/` — only apps with **Full Disk Access**
can read `chat.db`.

1. **System Settings → Privacy & Security → Full Disk Access**.
2. Click **+**, navigate to `/Applications/Utilities/Terminal.app`, add it.
3. If running from a different terminal (iTerm2, Warp, etc.), add that app instead.
4. You may need to quit and reopen the terminal for the grant to take effect.

> **If you use a launchd-managed venv**: the Python binary itself may need Full
> Disk Access if it lives outside `/usr/bin`. Add the specific python3 binary
> path as well.

### 4. (Optional) Install imessagedb for testing

The bridge itself uses only stdlib. `imessagedb` is an optional install that
exposes the same decode logic as a maintained package — useful if you want to
inspect messages interactively.

```bash
pip3 install imessagedb>=1.4.7
```

---

## Manual test (dry run)

This prints matched financial messages without posting or advancing the cursor.

```bash
# From the repo root or the bridge directory:
python3 /Users/anmolsen/Developer/fin/bridge/bridge.py --dry-run
```

Example output:

```
[dry-run] 12 rows fetched, 3 financial messages:
  sender='AD-SBIUPI'  receivedAt='2026-06-10T09:23:11+00:00'
  body='Dear UPI user, Rs.500.00 debited from a/c XX4321...'
  sender='JM-ICICIB'  receivedAt='2026-06-11T14:05:33+00:00'
  body='ICICI Bank: INR 1,200 spent on your Credit Card XX8899...'
```

If `[dry-run] 0 rows fetched` — either no new messages since the cursor was
seeded, or Full Disk Access is missing (see step 3).

### Backfill past messages (one-time)

To process SMS from the last N days instead of only future messages:

```bash
BACKFILL_DAYS=30 python3 /Users/anmolsen/Developer/fin/bridge/bridge.py --dry-run
```

Remove `--dry-run` to actually POST them.  This only affects the very first run
(before a cursor file exists).

---

## Viewing logs

```bash
tail -f ~/.compound-sms-bridge/bridge.log
```

---

## Troubleshooting

### `chat.db not found` or `OperationalError: unable to open database`

- Full Disk Access is not granted to your terminal app.  See step 3 above.
- Verify the file exists: `ls ~/Library/Messages/chat.db`

### `POST HTTP 401`

- `INGEST_SECRET` in `~/.compound-sms-bridge/config.json` does not match
  what the server expects.

### `POST HTTP 503 / URLError`

- The Compound app isn't running.  Start it with `npm run dev` in the repo.

### All messages show `0 rows fetched` after first run

- The cursor was seeded at the current max ROWID on first run (intentional —
  avoids backfilling years of history).
- Use `BACKFILL_DAYS=N` to reprocess recent messages.
- Delete `~/.compound-sms-bridge/cursor.json` to reset fully.

### `attributedBody` decode produces garbled text

- The inline fallback decoder handles the common SMS case.  For complex
  attributed strings (heavily formatted iMessages), it may return partial or
  empty text.  SMS financial alerts are almost always plain text and work
  reliably.

### Cursor file

```
~/.compound-sms-bridge/cursor.json   # {"last_rowid": 12345}
```

Delete this file to reset the cursor.

---

## Architecture summary

```
chat.db (read-only)
    ↓  fetch rows WHERE ROWID > cursor
sender filter (financial only — drops personal numbers before decode)
    ↓  decode body (text OR attributedBody fallback)
batch POST → /api/ingest/sms
    ↓  on 2xx only
advance cursor
```

The script is intentionally stateless between runs — all state lives in
`cursor.json`.  launchd handles scheduling.
