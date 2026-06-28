"""
conftest.py — shared fixtures for bridge.py pytest suite.

chat.db schema (minimal columns bridge.py actually reads):
  message: ROWID, text, attributedBody, date, handle_id, is_from_me
  handle:  ROWID, id  (the sender identifier / phone / shortcode)

Apple epoch: timestamps stored as nanoseconds since 2001-01-01 UTC.
APPLE_EPOCH_OFFSET_S = 978_307_200 (seconds)
"""

import json
import sqlite3
import tempfile
import time
from pathlib import Path

import pytest

# Apple nanosecond epoch offset (seconds between 1970-01-01 and 2001-01-01)
APPLE_EPOCH_OFFSET_S = 978_307_200


def _unix_to_apple_ns(unix_s: float) -> int:
    """Convert Unix timestamp (seconds) to Apple CoreData nanoseconds."""
    return int((unix_s - APPLE_EPOCH_OFFSET_S) * 1_000_000_000)


@pytest.fixture()
def chat_db(tmp_path: Path) -> Path:
    """
    Build a minimal chat.db with the columns bridge.py reads.

    Rows:
      ROWID 1 — financial sender "AD-SBIUPI", text body, is_from_me=0  → should POST
      ROWID 2 — financial sender "AD-SBIUPI", attributedBody only,       → should POST
      ROWID 3 — personal number "+919876543210", text body, is_from_me=0 → should be filtered
    """
    db_path = tmp_path / "chat.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE handle (
            ROWID       INTEGER PRIMARY KEY,
            id          TEXT NOT NULL
        );

        CREATE TABLE message (
            ROWID           INTEGER PRIMARY KEY,
            text            TEXT,
            attributedBody  BLOB,
            date            INTEGER NOT NULL,
            handle_id       INTEGER NOT NULL,
            is_from_me      INTEGER NOT NULL DEFAULT 0
        );
    """)

    # Insert handles
    conn.execute("INSERT INTO handle (ROWID, id) VALUES (1, 'AD-SBIUPI')")
    conn.execute("INSERT INTO handle (ROWID, id) VALUES (2, '+919876543210')")
    conn.commit()

    now_ns = _unix_to_apple_ns(time.time())

    # Row 1: financial, plain text
    conn.execute(
        "INSERT INTO message (ROWID, text, attributedBody, date, handle_id, is_from_me) VALUES (1, 'Your SBI account debited Rs.500', NULL, ?, 1, 0)",
        (now_ns,),
    )
    # Row 2: financial, attributedBody only (text is NULL)
    # Build a minimal typedstream blob that _decode_attributed_body can extract.
    # _decode_attributed_body does (in order):
    #   1. split(b"NSNumber")[0]   -> take before NSNumber
    #   2. split(b"NSString")[1]   -> take after NSString
    #   3. split(b"NSDictionary")[0] -> take before NSDictionary
    #   4. [6:-12]                 -> slice off 6-byte prefix and 12-byte suffix
    # So the blob must be: NSString + 6 bytes + payload + 12 bytes + NSDictionary + ... + NSNumber
    body_text = b"SBI UPI txn: Rs.200 debit"
    blob = b"NSString" + b"\x00" * 6 + body_text + b"\x00" * 12 + b"NSDictionary\x00NSNumber"
    conn.execute(
        "INSERT INTO message (ROWID, text, attributedBody, date, handle_id, is_from_me) VALUES (2, NULL, ?, ?, 1, 0)",
        (blob, now_ns + 1_000_000_000),
    )
    # Row 3: personal number — should be filtered by is_financial_sender
    conn.execute(
        "INSERT INTO message (ROWID, text, attributedBody, date, handle_id, is_from_me) VALUES (3, 'Hi, can we meet?', NULL, ?, 2, 0)",
        (now_ns + 2_000_000_000,),
    )
    conn.commit()
    conn.close()
    return db_path


@pytest.fixture()
def cursor_file(tmp_path: Path) -> Path:
    """Return a path for a cursor.json file (not yet created — caller sets it up)."""
    return tmp_path / "cursor.json"


@pytest.fixture()
def write_cursor_at(tmp_path: Path):
    """Factory: write a cursor.json with the given last_rowid."""
    def _write(rowid: int) -> Path:
        p = tmp_path / "cursor.json"
        p.write_text(json.dumps({"last_rowid": rowid}))
        return p
    return _write
