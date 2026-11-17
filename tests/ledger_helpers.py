"""Shared made-up data for the ledger tests (JP-107). No real transcript, title, name or ticket appears here.

Ids look like sess-0001, folders are under a temp directory, tickets are JP-900 to JP-999, and the phone number,
date of birth and record number are the ones the screen's own tests use.
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from ledger import db  # noqa: E402

NOW = "2026-11-17T12:00:00Z"
T = "2026-11-17T10:00:00Z"
FAKE_PHONE = "555-123-4567"
FAKE_SSN = "000-00-0000"
FAKE_DOB = "DOB 03/04/1961"
FAKE_MRN = "MRN 12345678"


class LedgerCase(unittest.TestCase):
    """A fresh ledger in a temp folder, with the temp folder as JOSH360_HOME."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-ledger-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self._old_home = os.environ.get("JOSH360_HOME")
        os.environ["JOSH360_HOME"] = str(self.tmp / "home")
        self.addCleanup(self._restore_home)
        self.path = self.tmp / "home" / "state" / "ledger.db"
        db.ensure(self.path, self.tmp / "home" / "backups", NOW)
        self.conn = db.connect(self.path)
        self.addCleanup(self.conn.close)
        self.machine = db.machine_id(self.conn)

    def _restore_home(self):
        if self._old_home is None:
            os.environ.pop("JOSH360_HOME", None)
        else:
            os.environ["JOSH360_HOME"] = self._old_home

    def uid(self, tool_session_id):
        return "{}:claude-code:{}".format(self.machine, tool_session_id)

    def session(self, tool_session_id="sess-0001", started_by="josh", started_at=T):
        uid = self.uid(tool_session_id)
        self.conn.execute(
            "INSERT INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by, "
            "recorded_at, recorded_by) VALUES (?, ?, 'claude-code', ?, ?, ?, ?, 'test')",
            (uid, self.machine, tool_session_id, started_at, started_by, T))
        return uid

    def episode(self, uid, episode=1, version=1, title="A title", source="ai"):
        cur = self.conn.execute(
            "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
            "folder, branch, title, title_source, version, recorded_at, recorded_by) "
            "VALUES (?, ?, ?, ?, ?, 'quiet', '/tmp/made-up/josh_360', 'JP-900/sample', ?, ?, ?, ?, 'test')",
            (uid, episode, T, T, T, title, source, version, T))
        return cur.lastrowid

    def rows(self, sql, args=()):
        return self.conn.execute(sql, args).fetchall()

    def count(self, table):
        return self.conn.execute("SELECT COUNT(*) FROM {}".format(table)).fetchone()[0]
