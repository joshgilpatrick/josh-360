"""JP-107, Task 8: patient-data redaction. Made-up text only."""
import gzip
import io
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import FAKE_PHONE, NOW, LedgerCase  # noqa: E402
from ledger import backup, db, redact  # noqa: E402


class Tty(io.StringIO):
    def __init__(self, text, tty=True):
        super().__init__(text)
        self._tty = tty

    def isatty(self):
        return self._tty


class Redact(LedgerCase):
    def setUp(self):
        super().setUp()
        self.uid_ = self.session()
        self.episode_id = self.episode(self.uid_, title="Call " + FAKE_PHONE + " today")
        self.other = self.episode(self.uid_, episode=2, title="An ordinary title")
        self.backups = db.backups_dir()

    def title(self, row_id, conn=None):
        return (conn or self.conn).execute("SELECT title FROM session_episodes WHERE id = ?", (row_id,)).fetchone()[0]

    def test_redact_overwrites_one_column_and_restores_the_trigger(self):
        rid = redact.redact(self.conn, "session_episodes", self.episode_id, "title", NOW)
        self.assertEqual(self.title(self.episode_id), "withheld: patient data")
        self.assertEqual(self.title(self.other), "An ordinary title")
        self.assertEqual(self.rows("SELECT id FROM redactions"), [(rid,)])
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.conn.execute("UPDATE session_episodes SET title = 'x' WHERE id = ?", (self.episode_id,))
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.conn.execute("DELETE FROM session_episodes WHERE id = ?", (self.episode_id,))

    def test_redact_records_where_not_what(self):
        redact.redact(self.conn, "session_episodes", self.episode_id, "title", NOW)
        row = self.rows("SELECT table_name, row_id, column_name, redacted_at, redacted_by FROM redactions")[0]
        self.assertEqual(row, ("session_episodes", self.episode_id, "title", NOW, "josh"))
        dump = "\n".join(self.conn.iterdump())
        self.assertNotIn(FAKE_PHONE, dump)

    def test_the_old_text_is_gone_from_the_file(self):
        redact.redact(self.conn, "session_episodes", self.episode_id, "title", NOW)
        self.conn.close()
        raw = self.path.read_bytes()
        wal = self.path.with_name(self.path.name + "-wal")
        if wal.exists():
            raw += wal.read_bytes()
        self.assertNotIn(FAKE_PHONE.encode(), raw)
        self.conn = db.connect(self.path)

    def test_redact_refuses_a_column_not_in_CAPS(self):
        with self.assertRaises(ValueError):
            redact.redact(self.conn, "sessions", 1, "tool_session_id", NOW)
        with self.assertRaises(ValueError):
            redact.redact(self.conn, "session_episodes", self.episode_id, "folder", NOW)
        self.assertEqual(self.count("redactions"), 0)

    def test_redact_refuses_a_row_that_is_not_there_and_changes_nothing(self):
        with self.assertRaises(ValueError):
            redact.redact(self.conn, "session_episodes", 9999, "title", NOW)
        self.assertEqual(self.count("redactions"), 0)
        self.assertIn("append-only", self._update_error())

    def _update_error(self):
        try:
            self.conn.execute("UPDATE session_episodes SET title = 'x'")
        except sqlite3.DatabaseError as e:
            return str(e)
        return ""

    def test_redact_needs_josh_at_a_terminal(self):
        args = ["--table", "session_episodes", "--row", str(self.episode_id), "--column", "title"]
        self.assertEqual(redact.main(args, Tty("redact\n", tty=False), self.path, self.backups), 2)
        self.assertEqual(redact.main(args, Tty("yes\n"), self.path, self.backups), 2)
        self.assertEqual(redact.main(args, Tty(""), self.path, self.backups), 2)
        self.assertIn(FAKE_PHONE, self.title(self.episode_id))
        self.assertEqual(self.count("redactions"), 0)

    def test_main_asks_for_the_word_then_redacts(self):
        args = ["--table", "session_episodes", "--row", str(self.episode_id), "--column", "title"]
        self.assertEqual(redact.main(args, Tty("redact\n"), self.path, self.backups), 0)
        self.assertEqual(self.title(self.episode_id), "withheld: patient data")

    def test_main_refuses_other_columns_and_a_missing_ledger(self):
        self.assertEqual(redact.main(["--table", "sessions", "--row", "1", "--column", "started_by"],
                                     Tty("redact\n"), self.path, self.backups), 2)
        self.assertEqual(redact.main(["--table", "session_episodes", "--row", "1", "--column", "title"],
                                     Tty("redact\n"), self.tmp / "none.db", self.backups), 2)

    def test_redact_rewrites_backups_holding_the_row(self):
        holds = self.backups / "ledger-2026-11-16.db.gz"
        backup.copy_to(self.conn, holds)
        # a backup from before the row existed
        early = self.tmp / "early"
        early.mkdir()
        fresh = db.connect(early / "x.db")
        fresh.executescript((Path(db.SCHEMA)).read_text(encoding="utf-8"))
        backup.copy_to(fresh, self.backups / "ledger-2026-11-01.db.gz")
        fresh.close()
        before_early = (self.backups / "ledger-2026-11-01.db.gz").read_bytes()
        self.assertEqual(redact.redact_backups(self.backups, "session_episodes", self.episode_id, "title"), 1)
        plain = self.tmp / "restored.db"
        with gzip.open(str(holds), "rb") as f:
            plain.write_bytes(f.read())
        self.assertNotIn(FAKE_PHONE.encode(), plain.read_bytes())
        copy = sqlite3.connect(str(plain))
        self.addCleanup(copy.close)
        self.assertEqual(copy.execute("SELECT title FROM session_episodes WHERE id = ?",
                                      (self.episode_id,)).fetchone()[0], "withheld: patient data")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            copy.execute("UPDATE session_episodes SET title = 'x'")
        self.assertEqual((self.backups / "ledger-2026-11-01.db.gz").read_bytes(), before_early)
        self.assertEqual(sorted(p.name for p in self.backups.iterdir()),
                         ["ledger-2026-11-01.db.gz", "ledger-2026-11-16.db.gz"])

    def test_main_reports_backups_rewritten(self):
        backup.copy_to(self.conn, self.backups / "ledger-2026-11-16.db.gz")
        out = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(out):
            redact.main(["--table", "session_episodes", "--row", str(self.episode_id), "--column", "title"],
                        Tty("redact\n"), self.path, self.backups)
        self.assertEqual(json.loads(out.getvalue())["backups_rewritten"], 1)


if __name__ == "__main__":
    unittest.main()
