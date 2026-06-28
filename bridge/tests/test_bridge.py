"""
pytest suite for bridge.py — the Mac SMS bridge.

Tests cover:
  (a) fetch_new_messages + build_payload: chat.db read → {sender, body, receivedAt}
  (b) dedup: cursor-based high-water mark prevents re-posting seen messages
  (c) post volume: all messages in a single POST (no MAX_BATCH_SIZE in bridge.py)
  (d) --dry-run: reads and filters but makes NO HTTP call
  (e) normal run: POSTs the correct JSON body with Bearer auth header

HTTP client: bridge.py uses stdlib urllib.request.urlopen — monkeypatched here.
No requests-mock needed.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Import the bridge module from the sibling directory.
# ---------------------------------------------------------------------------
_BRIDGE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(_BRIDGE_DIR))
import bridge as bridge_mod  # noqa: E402  (after sys.path manipulation)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _open_rw(db_path: Path) -> sqlite3.Connection:
    """Open the test chat.db in read-write mode so we can inspect it."""
    return sqlite3.connect(str(db_path))


def _make_urlopen_mock(status: int = 200, body: bytes = b'{"ok":true}'):
    """Return a context-manager mock that urllib.request.urlopen returns."""
    resp = MagicMock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# (a) fetch_new_messages + build_payload → {sender, body, receivedAt}
# ---------------------------------------------------------------------------

class TestFetchAndBuildPayload:
    def test_fetch_new_messages_returns_expected_columns(self, chat_db):
        """fetch_new_messages returns dicts with rowid/text/attributed_body/date_ns/sender."""
        conn = sqlite3.connect(f"file:{chat_db}?mode=ro&immutable=1", uri=True)
        try:
            rows = bridge_mod.fetch_new_messages(conn, cursor=0)
        finally:
            conn.close()

        assert len(rows) == 3, "should return all 3 non-from-me rows above cursor 0"
        first = rows[0]
        assert set(first.keys()) == {"rowid", "text", "attributed_body", "date_ns", "sender"}
        assert first["rowid"] == 1
        assert first["text"] == "Your SBI account debited Rs.500"
        assert first["sender"] == "AD-SBIUPI"

    def test_fetch_new_messages_cursor_filters(self, chat_db):
        """Rows with ROWID <= cursor are excluded."""
        conn = sqlite3.connect(f"file:{chat_db}?mode=ro&immutable=1", uri=True)
        try:
            rows = bridge_mod.fetch_new_messages(conn, cursor=1)
        finally:
            conn.close()

        rowids = [r["rowid"] for r in rows]
        assert 1 not in rowids, "ROWID 1 should be filtered by cursor=1"
        assert 2 in rowids
        assert 3 in rowids

    def test_build_payload_maps_to_expected_shape(self, chat_db):
        """build_payload returns dicts with exactly sender/body/receivedAt keys."""
        conn = sqlite3.connect(f"file:{chat_db}?mode=ro&immutable=1", uri=True)
        try:
            rows = bridge_mod.fetch_new_messages(conn, cursor=0)
        finally:
            conn.close()

        messages, max_rowid = bridge_mod.build_payload(rows)

        assert max_rowid == 3, "max_rowid covers ALL rows including personal ones"
        # Row 3 is personal — only rows 1 and 2 should be in messages
        assert len(messages) == 2
        for msg in messages:
            assert set(msg.keys()) == {"sender", "body", "receivedAt"}
            assert msg["sender"] == "AD-SBIUPI"
            assert msg["receivedAt"].endswith("+00:00") or "Z" in msg["receivedAt"] or "T" in msg["receivedAt"]

    def test_build_payload_row1_plain_text(self, chat_db):
        """Row with plain text field uses text directly."""
        conn = sqlite3.connect(f"file:{chat_db}?mode=ro&immutable=1", uri=True)
        try:
            rows = bridge_mod.fetch_new_messages(conn, cursor=0)
        finally:
            conn.close()
        row1 = next(r for r in rows if r["rowid"] == 1)
        messages, _ = bridge_mod.build_payload([row1])
        assert len(messages) == 1
        assert messages[0]["body"] == "Your SBI account debited Rs.500"

    def test_build_payload_personal_sender_filtered(self, chat_db):
        """Row 3 (personal phone number) is excluded from messages."""
        conn = sqlite3.connect(f"file:{chat_db}?mode=ro&immutable=1", uri=True)
        try:
            rows = bridge_mod.fetch_new_messages(conn, cursor=0)
        finally:
            conn.close()
        row3 = next(r for r in rows if r["rowid"] == 3)
        messages, _ = bridge_mod.build_payload([row3])
        assert messages == [], "personal number should be filtered out"

    def test_receivedAt_is_iso8601_utc(self, chat_db):
        """receivedAt values are parseable ISO 8601 UTC strings."""
        from datetime import datetime, timezone
        conn = sqlite3.connect(f"file:{chat_db}?mode=ro&immutable=1", uri=True)
        try:
            rows = bridge_mod.fetch_new_messages(conn, cursor=0)
        finally:
            conn.close()
        messages, _ = bridge_mod.build_payload(rows)
        for msg in messages:
            dt = datetime.fromisoformat(msg["receivedAt"])
            assert dt.tzinfo is not None, "receivedAt must be timezone-aware"
            assert dt.tzinfo == timezone.utc or dt.utcoffset().total_seconds() == 0


# ---------------------------------------------------------------------------
# (b) Dedup — cursor-based high-water mark
# ---------------------------------------------------------------------------

class TestDedup:
    def test_second_run_posts_nothing_new(self, chat_db, tmp_path, monkeypatch):
        """
        After a successful run that advances the cursor to max_rowid=3,
        a subsequent run fetches no rows and makes no POST.
        """
        # Monkeypatch file paths to tmp_path
        cursor_path = tmp_path / "cursor.json"
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        urlopen_calls: list[Any] = []

        def fake_urlopen(req, timeout=None):
            urlopen_calls.append(req)
            return _make_urlopen_mock()

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "test-secret"}

        # First run — cursor is -1 (absent), seeds itself and returns immediately
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        # After first run, cursor is seeded but no messages posted yet
        # Manually set cursor to 0 so the next run sees the 3 rows
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        urlopen_calls.clear()

        # Second run — should fetch rows, post them, advance cursor to 3
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        assert len(urlopen_calls) == 1, "first real run should POST once"
        urlopen_calls.clear()

        # Third run — cursor is now at 3, no new rows → no POST
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        assert urlopen_calls == [], "second real run with no new rows should make NO POST"

    def test_cursor_advances_to_max_rowid_including_personal(self, chat_db, tmp_path, monkeypatch):
        """
        Cursor should advance to ROWID 3 (the personal message row) even though
        it was filtered out of the POST — so it isn't reprocessed next tick.
        """
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        def fake_urlopen(req, timeout=None):
            return _make_urlopen_mock()

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "test-secret"}

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        saved = json.loads(cursor_path.read_text())
        assert saved["last_rowid"] == 3, "cursor must advance past personal message row"


# ---------------------------------------------------------------------------
# (c) POST volume — all messages sent in a single call (no batch splitting)
# ---------------------------------------------------------------------------

class TestPostVolume:
    def test_single_post_call_for_all_financial_messages(self, chat_db, tmp_path, monkeypatch):
        """
        bridge.py has no MAX_BATCH_SIZE — all financial messages go in one POST.
        With 2 financial rows in the fixture, exactly one urlopen call is made.
        """
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        urlopen_calls: list[Any] = []

        def fake_urlopen(req, timeout=None):
            urlopen_calls.append(req)
            return _make_urlopen_mock()

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "test-secret"}

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        assert len(urlopen_calls) == 1, "all messages should go in a single POST"

        # Verify the payload contains both financial messages
        req = urlopen_calls[0]
        body = json.loads(req.data.decode())
        assert "messages" in body
        assert len(body["messages"]) == 2, "both financial rows should be in the payload"


# ---------------------------------------------------------------------------
# (d) --dry-run: reads but makes NO HTTP POST
# ---------------------------------------------------------------------------

class TestDryRun:
    def test_dry_run_makes_no_http_call(self, chat_db, tmp_path, monkeypatch, capsys):
        """With dry_run=True, no urllib.request.urlopen call is made."""
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        urlopen_calls: list[Any] = []

        def fake_urlopen(req, timeout=None):
            urlopen_calls.append(req)
            return _make_urlopen_mock()

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "test-secret"}

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=True)

        assert urlopen_calls == [], "dry-run must NOT call urllib.request.urlopen"

    def test_dry_run_does_not_advance_cursor(self, chat_db, tmp_path, monkeypatch):
        """With dry_run=True, cursor.json is NOT written/modified."""
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "test-secret"}

        with patch("urllib.request.urlopen"):
            bridge_mod.run_tick(cfg, dry_run=True)

        saved = json.loads(cursor_path.read_text())
        assert saved["last_rowid"] == 0, "cursor must not advance during dry-run"

    def test_dry_run_prints_message_count(self, chat_db, tmp_path, monkeypatch, capsys):
        """dry_run prints a summary line mentioning the number of rows and messages."""
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "test-secret"}

        with patch("urllib.request.urlopen"):
            bridge_mod.run_tick(cfg, dry_run=True)

        out = capsys.readouterr().out
        assert "[dry-run]" in out


# ---------------------------------------------------------------------------
# (e) Normal run: correct JSON body and Bearer auth header
# ---------------------------------------------------------------------------

class TestNormalPost:
    def test_posts_correct_json_body(self, chat_db, tmp_path, monkeypatch):
        """POST body is {"messages": [...]} with sender/body/receivedAt per message."""
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        captured_req = []

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return _make_urlopen_mock()

        cfg = {"ingest_url": "http://localhost:3000", "ingest_secret": "supersecret"}

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        assert len(captured_req) == 1
        req = captured_req[0]

        # Check URL
        assert req.full_url == "http://localhost:3000/api/ingest/sms"

        # Check method
        assert req.method == "POST"

        # Check Content-Type
        assert req.headers.get("Content-type") == "application/json"

        # Check Authorization header (Bearer token)
        auth_header = req.headers.get("Authorization")
        assert auth_header == "Bearer supersecret"

        # Check body structure
        body = json.loads(req.data.decode())
        assert "messages" in body
        assert isinstance(body["messages"], list)
        assert len(body["messages"]) == 2

        for msg in body["messages"]:
            assert "sender" in msg
            assert "body" in msg
            assert "receivedAt" in msg
            assert msg["sender"] == "AD-SBIUPI"

    def test_post_url_uses_ingest_sms_path(self, chat_db, tmp_path, monkeypatch):
        """POST goes to <base_url>/api/ingest/sms regardless of trailing slash."""
        cursor_path = tmp_path / "cursor.json"
        cursor_path.write_text(json.dumps({"last_rowid": 0}))
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)
        monkeypatch.setattr(bridge_mod, "CHAT_DB_PATH", chat_db)

        captured_urls = []

        def fake_urlopen(req, timeout=None):
            captured_urls.append(req.full_url)
            return _make_urlopen_mock()

        # Use a base_url with a trailing slash to test the rstrip logic
        cfg = {"ingest_url": "http://my-server.local:3000/", "ingest_secret": "s"}

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            bridge_mod.run_tick(cfg, dry_run=False)

        assert len(captured_urls) == 1
        assert captured_urls[0] == "http://my-server.local:3000/api/ingest/sms"


# ---------------------------------------------------------------------------
# Unit tests for pure helper functions
# ---------------------------------------------------------------------------

class TestHelpers:
    def test_is_financial_sender_dlt_header(self):
        assert bridge_mod.is_financial_sender("AD-SBIUPI") is True

    def test_is_financial_sender_keyword_match(self):
        assert bridge_mod.is_financial_sender("ICICI-BANK") is True
        assert bridge_mod.is_financial_sender("VM-HDFCBK") is True

    def test_is_financial_sender_personal_number_rejected(self):
        assert bridge_mod.is_financial_sender("+919876543210") is False
        assert bridge_mod.is_financial_sender("9876543210") is False

    def test_is_financial_sender_empty_rejected(self):
        assert bridge_mod.is_financial_sender("") is False

    def test_apple_ns_to_iso8601_epoch_reference(self):
        """2001-01-01T00:00:00+00:00 is Apple epoch 0."""
        result = bridge_mod.apple_ns_to_iso8601(0)
        assert "2001-01-01" in result

    def test_decode_body_prefers_text_over_attributed(self):
        result = bridge_mod.decode_body("plain text", b"some blob")
        assert result == "plain text"

    def test_decode_body_falls_back_to_attributed(self):
        # Build a minimal blob matching _decode_attributed_body expectations.
        # _decode_attributed_body: split(NSNumber)[0] -> split(NSString)[1] ->
        #   split(NSDictionary)[0] -> [6:-12]
        # So layout: NSString + 6-byte-pad + payload + 12-byte-pad + NSDictionary + NSNumber
        body_text = b"fallback body"
        blob = b"NSString" + b"\x00" * 6 + body_text + b"\x00" * 12 + b"NSDictionary\x00NSNumber"
        result = bridge_mod.decode_body(None, blob)
        assert "fallback body" in result

    def test_decode_body_empty_when_both_none(self):
        result = bridge_mod.decode_body(None, None)
        assert result == ""

    def test_read_write_cursor(self, tmp_path, monkeypatch):
        cursor_path = tmp_path / "cursor.json"
        monkeypatch.setattr(bridge_mod, "CURSOR_FILE", cursor_path)
        monkeypatch.setattr(bridge_mod, "BRIDGE_DIR", tmp_path)

        # Absent cursor returns -1
        assert bridge_mod.read_cursor() == -1

        bridge_mod.write_cursor(42)
        assert bridge_mod.read_cursor() == 42
