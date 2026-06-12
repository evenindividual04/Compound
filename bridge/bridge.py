#!/usr/bin/env python3
"""
compound-sms-bridge  —  Read new financial SMS from macOS Messages chat.db
and POST them (raw, unparsed) to the Compound app's /api/ingest/sms endpoint.

This script does ONE tick and exits. launchd re-runs it every 60 s.
Run manually with --loop, --once, or --dry-run (see --help).

Dependencies:
  - stdlib only (no third-party imports at runtime — see FALLBACK note below)
  - Optional: `pip install imessagedb` to get the same decode logic as a
    maintained package; not required because we inline the equivalent fallback.

Decode strategy (attributedBody):
  When message.text is NULL, the full text lives in a typedstream blob in
  message.attributedBody.  We use a byte-slicing approach originally documented
  at github.com/my-other-github-account/imessage_tools and also used internally
  by imessagedb (>=1.4.7).  This works reliably for SMS/MMS bodies that contain
  only a plain NSString payload.  It is intentionally NOT a full typedstream
  parser — it targets the common case and degrades to an empty string otherwise.

Apple epoch:
  message.date stores nanoseconds since 2001-01-01 00:00:00 UTC.
  Unix epoch offset: 978307200 seconds (verified against Apple's NSDate docs).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BRIDGE_DIR = Path.home() / ".compound-sms-bridge"
CURSOR_FILE = BRIDGE_DIR / "cursor.json"
LOG_FILE = BRIDGE_DIR / "bridge.log"
CONFIG_FILE = BRIDGE_DIR / "config.json"

CHAT_DB_PATH = Path.home() / "Library" / "Messages" / "chat.db"

# Apple CoreData epoch: seconds between 1970-01-01 and 2001-01-01
APPLE_EPOCH_OFFSET_S = 978_307_200

# ---------------------------------------------------------------------------
# Sender filter  (PRIVACY-CRITICAL — runs before any decode or POST)
# ---------------------------------------------------------------------------
# Indian bank/UPI DLT headers are alphanumeric shortcodes, typically
# matching the pattern ^[A-Z]{2}-[A-Z0-9]{4,}$.  We additionally match on
# keyword substrings so common senders are caught even without the prefix.
# Personal phone numbers (10+ digits) are always dropped.
#
# Extend FINANCIAL_KEYWORDS for new issuers (case-insensitive substring match).
# ---------------------------------------------------------------------------

import re

FINANCIAL_KEYWORDS: list[str] = [
    "SBI",
    "ICICI",
    "HDFC",
    "AXIS",
    "KOTAK",
    "YESBANK",
    "IDFCFIRST",
    "LAZYPAY",
    "SIMPL",
    "ZESTMONEY",
    "BNPL",
    "UPIBANK",
    "NSDL",
    "AMEX",
    "CITI",
    "RBL",
    "INDUSIND",
    "PAYTM",
    "PHONEPE",
    "GOOGLEPAY",
    "MOBIKWIK",
    "FREECHARGE",
    "JUPITER",
    "FI",
    "SLICE",
    "ONECARD",
    "KREDITBEE",
    "NIRA",
    "MONEYVIEW",
    "CASHBEAN",
    "BAJAJFINSERV",
    "BAJAJ",
    "TVSCREDIT",
    "HDBFS",
    "TATACAP",
    "TATA",
    "DMBANK",
    "UJJIVAN",
    "AUBANK",
    "EQUITAS",
    "SURYODAY",
    "ESAF",
    "NPCI",
    "BHIM",
]

# DLT pattern: two uppercase letters, hyphen, 4+ alphanumeric chars (e.g. AD-SBIUPI)
_DLT_RE = re.compile(r"^[A-Z]{2}-[A-Z0-9]{4,}$")
# Personal number pattern: 10+ consecutive digits (bare mobile numbers)
_PERSONAL_NUMBER_RE = re.compile(r"^\+?\d{10,}$")


def is_financial_sender(sender: str) -> bool:
    """Return True if this sender looks like a bank/UPI/financial institution."""
    if not sender:
        return False
    s = sender.strip()
    # Drop personal phone numbers immediately
    if _PERSONAL_NUMBER_RE.match(s):
        return False
    # DLT header pattern gets automatic pass-through for keyword check
    su = s.upper()
    for kw in FINANCIAL_KEYWORDS:
        if kw in su:
            return True
    # Pure DLT pattern with no keyword match — still financial infrastructure
    if _DLT_RE.match(s):
        return True
    return False


# ---------------------------------------------------------------------------
# Date conversion
# ---------------------------------------------------------------------------

def apple_ns_to_iso8601(apple_ns: int) -> str:
    """Convert Apple nanosecond timestamp (since 2001-01-01 UTC) to ISO 8601."""
    unix_s = apple_ns / 1_000_000_000 + APPLE_EPOCH_OFFSET_S
    dt = datetime.fromtimestamp(unix_s, tz=timezone.utc)
    return dt.isoformat()


# ---------------------------------------------------------------------------
# attributedBody decode  (FALLBACK — pure stdlib, no third-party required)
# ---------------------------------------------------------------------------
# This replicates the byte-slicing strategy from imessagedb/_convert_attributed_body
# and the imessage_tools project.  It pulls the NSString payload from the
# typedstream blob without a full parser.  Works for all SMS/MMS bodies tested;
# degrades to empty string for edge cases (emoji-heavy, edited messages, etc.).

def _decode_attributed_body(blob: bytes) -> str:
    """Extract plain text from an attributedBody typedstream blob (best-effort)."""
    try:
        text = blob.split(b"NSNumber")[0]
        text = text.split(b"NSString")[1]
        text = text.split(b"NSDictionary")[0]
        text = text[6:-12]
        for marker in (b"\x01", b"\x02", b"\x00"):
            if marker in text:
                text = text.split(marker)[1]
        if b"\x86" in text:
            text = text.split(b"\x86")[0]
        return text.decode("utf-8", errors="replace").strip()
    except (IndexError, UnicodeDecodeError):
        return ""


# ---------------------------------------------------------------------------
# Config + cursor
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Load config from file then overlay with env vars."""
    cfg: dict = {}
    if CONFIG_FILE.exists():
        with CONFIG_FILE.open() as f:
            cfg = json.load(f)
    # Env vars always win
    cfg["ingest_url"] = os.environ.get("INGEST_URL", cfg.get("ingest_url", "http://localhost:3000"))
    cfg["ingest_secret"] = os.environ.get("INGEST_SECRET", cfg.get("ingest_secret", ""))
    return cfg


def read_cursor() -> int:
    """Return last processed ROWID, or -1 if cursor file absent."""
    if CURSOR_FILE.exists():
        with CURSOR_FILE.open() as f:
            return int(json.load(f).get("last_rowid", -1))
    return -1


def write_cursor(rowid: int) -> None:
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
    with CURSOR_FILE.open("w") as f:
        json.dump({"last_rowid": rowid}, f)


def init_cursor_from_db(conn: sqlite3.Connection, backfill_days: Optional[int]) -> int:
    """On first run, start from current max ROWID (or N-day lookback)."""
    if backfill_days is not None and backfill_days > 0:
        cutoff_ns = (time.time() - backfill_days * 86400 - APPLE_EPOCH_OFFSET_S) * 1_000_000_000
        row = conn.execute(
            "SELECT MIN(ROWID) - 1 FROM message WHERE date >= ? AND is_from_me = 0",
            (int(cutoff_ns),),
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])
    # Default: start from current max so we only see future messages
    row = conn.execute("SELECT MAX(ROWID) FROM message").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


# ---------------------------------------------------------------------------
# Database query
# ---------------------------------------------------------------------------

def open_chat_db(db_path: Path) -> sqlite3.Connection:
    """Open chat.db read-only + immutable to avoid WAL lock issues."""
    uri = f"file:{db_path}?mode=ro&immutable=1"
    return sqlite3.connect(uri, uri=True)


def fetch_new_messages(conn: sqlite3.Connection, cursor: int) -> list[dict]:
    """Return raw rows for messages newer than cursor."""
    sql = """
        SELECT m.ROWID,
               m.text,
               m.attributedBody,
               m.date,
               h.id AS sender
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > :cursor
           AND m.is_from_me = 0
         ORDER BY m.ROWID ASC
    """
    rows = conn.execute(sql, {"cursor": cursor}).fetchall()
    results = []
    for rowid, text, attributed_body, date_ns, sender in rows:
        results.append(
            {
                "rowid": rowid,
                "text": text,
                "attributed_body": attributed_body,
                "date_ns": date_ns,
                "sender": sender or "",
            }
        )
    return results


# ---------------------------------------------------------------------------
# Decode + filter pipeline
# ---------------------------------------------------------------------------

def decode_body(text: Optional[str], attributed_body: Optional[bytes]) -> str:
    """Resolve the message body, preferring text then attributedBody fallback."""
    if text and text.strip():
        return text.strip()
    if attributed_body:
        return _decode_attributed_body(attributed_body)
    return ""


def build_payload(rows: list[dict]) -> tuple[list[dict], int]:
    """
    Apply sender filter + decode.
    Returns (messages_for_post, max_rowid_seen).
    max_rowid_seen covers ALL rows including dropped ones so the cursor always
    advances past personal messages.
    """
    messages = []
    max_rowid = 0
    for row in rows:
        max_rowid = max(max_rowid, row["rowid"])
        if not is_financial_sender(row["sender"]):
            continue
        body = decode_body(row["text"], row["attributed_body"])
        if not body:
            continue
        messages.append(
            {
                "sender": row["sender"],
                "body": body,
                "receivedAt": apple_ns_to_iso8601(row["date_ns"]),
            }
        )
    return messages, max_rowid


# ---------------------------------------------------------------------------
# HTTP POST
# ---------------------------------------------------------------------------

MAX_RETRIES = 3
RETRY_DELAYS = [2, 5, 15]  # seconds
POST_TIMEOUT = 15  # seconds


def post_messages(
    base_url: str,
    secret: str,
    messages: list[dict],
) -> bool:
    """POST batch to /api/ingest/sms.  Returns True on 2xx."""
    url = base_url.rstrip("/") + "/api/ingest/sms"
    payload = json.dumps({"messages": messages}).encode()
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {secret}",
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    for attempt, delay in enumerate(RETRY_DELAYS, 1):
        try:
            with urllib.request.urlopen(req, timeout=POST_TIMEOUT) as resp:
                body = resp.read().decode()
                logging.info("POST ok: %s", body)
                return True
        except urllib.error.HTTPError as exc:
            logging.warning("POST HTTP %s (attempt %d/%d): %s", exc.code, attempt, MAX_RETRIES, exc.read().decode())
            if attempt < MAX_RETRIES:
                time.sleep(delay)
        except urllib.error.URLError as exc:
            logging.warning("POST URLError (attempt %d/%d): %s", attempt, MAX_RETRIES, exc.reason)
            if attempt < MAX_RETRIES:
                time.sleep(delay)
    return False


# ---------------------------------------------------------------------------
# Main tick
# ---------------------------------------------------------------------------

def _print_dry_run(rows: list[dict], messages: list[dict]) -> None:
    """Print filtered messages to stdout without posting."""
    print(f"[dry-run] {len(rows)} rows fetched, {len(messages)} financial messages:")
    for m in messages:
        print(f"  sender={m['sender']!r}  receivedAt={m['receivedAt']}")
        print(f"  body={m['body']!r}")


def run_tick(cfg: dict, dry_run: bool = False) -> None:
    """One processing cycle: read → filter → (post) → advance cursor."""
    if not CHAT_DB_PATH.exists():
        logging.error("chat.db not found at %s — grant Full Disk Access to Terminal", CHAT_DB_PATH)
        sys.exit(1)

    conn = open_chat_db(CHAT_DB_PATH)
    try:
        cursor = read_cursor()
        backfill_days_str = os.environ.get("BACKFILL_DAYS", "")
        backfill_days = int(backfill_days_str) if backfill_days_str.strip() else None

        if cursor == -1:
            # First run — seed cursor
            cursor = init_cursor_from_db(conn, backfill_days)
            logging.info("First run: seeding cursor at ROWID %d", cursor)
            if not dry_run:
                write_cursor(cursor)
            return

        rows = fetch_new_messages(conn, cursor)
        if not rows:
            logging.debug("No new messages since ROWID %d", cursor)
            return

        messages, max_rowid = build_payload(rows)
        logging.info(
            "Rows fetched: %d | Financial: %d | Max ROWID: %d",
            len(rows),
            len(messages),
            max_rowid,
        )

        if dry_run:
            _print_dry_run(rows, messages)
            return

        if messages:
            secret = cfg.get("ingest_secret", "")
            base_url = cfg.get("ingest_url", "http://localhost:3000")
            ok = post_messages(base_url, secret, messages)
            if not ok:
                logging.error("POST failed; cursor NOT advanced (will retry next tick)")
                return
        # Advance cursor regardless — even rows filtered as personal advance the pointer
        write_cursor(max_rowid)
        logging.info("Cursor advanced to ROWID %d", max_rowid)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def setup_logging(verbose: bool = False) -> None:
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(LOG_FILE),
            logging.StreamHandler(sys.stdout),
        ],
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compound SMS Bridge — forward financial SMS to the app."
    )
    parser.add_argument("--once", action="store_true", help="Run one tick and exit (default behaviour).")
    parser.add_argument("--loop", action="store_true", help="Loop forever (for manual testing; normally launchd handles re-runs).")
    parser.add_argument("--dry-run", action="store_true", help="Filter + decode + print; no POST, no cursor advance.")
    parser.add_argument("--interval", type=int, default=60, help="Loop interval in seconds (with --loop). Default: 60.")
    parser.add_argument("--verbose", action="store_true", help="Debug logging.")
    args = parser.parse_args()

    setup_logging(args.verbose)
    cfg = load_config()

    if not cfg.get("ingest_secret") and not args.dry_run:
        logging.warning("INGEST_SECRET is not set — POST will fail authentication.")

    if args.loop:
        logging.info("Starting loop (interval=%ds).", args.interval)
        while True:
            try:
                run_tick(cfg, dry_run=args.dry_run)
            except Exception as exc:
                logging.exception("Unhandled error in tick: %s", exc)
            time.sleep(args.interval)
    else:
        # Default: one tick (--once is the same as default; launchd re-runs the process)
        run_tick(cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
