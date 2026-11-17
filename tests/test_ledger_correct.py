"""JP-107, Task 2: withdrawing, undoing and replacing ledger rows. Made-up rows only."""
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, ROOT, LedgerCase  # noqa: E402
from ledger import correct  # noqa: E402

SCHEMA = (ROOT / "ledger" / "schema.sql").read_text(encoding="utf-8")


class Correcting(LedgerCase):
    def seed(self):
        uid = self.session()
        return uid, self.episode(uid)

    def test_correct_writes_one_row(self):
        _, row = self.seed()
        cid = correct.correct(self.conn, "session_episodes", row, "wrong", "script", NOW)
        self.assertEqual(self.rows("SELECT table_name, row_id, reason, corrected_by, recorded_by FROM corrections "
                                   "WHERE id = ?", (cid,)),
                         [("session_episodes", row, "wrong", "script", "ledger/correct.py")])
        self.assertEqual(self.count("current_session_episodes"), 0)

    def test_correct_refuses_unknown_table_or_row(self):
        _, row = self.seed()
        for args in (("nope", row), ("session_episodes", 999), ("sqlite_master", 1)):
            with self.assertRaises(ValueError, msg=args):
                correct.correct(self.conn, args[0], args[1], "wrong", "josh", NOW)
        with self.assertRaises(ValueError):
            correct.correct(self.conn, "session_episodes", row, "boring", "josh", NOW)
        with self.assertRaises(ValueError):
            correct.correct(self.conn, "session_episodes", row, "wrong", "agent", NOW)
        self.assertEqual(self.count("corrections"), 0)

    def test_correct_refuses_a_second_correction_of_the_same_row(self):
        _, row = self.seed()
        correct.correct(self.conn, "session_episodes", row, "wrong", "josh", NOW)
        with self.assertRaisesRegex(ValueError, "already withdrawn"):
            correct.correct(self.conn, "session_episodes", row, "duplicate", "josh", NOW)
        self.assertEqual(self.count("corrections"), 1)

    def test_replacement_is_refused_for_a_versioned_table(self):
        _, row = self.seed()
        with self.assertRaisesRegex(ValueError, "next version"):
            correct.correct(self.conn, "session_episodes", row, "wrong", "josh", NOW, replacement=row)

    def test_replacement_row_must_exist_in_an_unversioned_table(self):
        uid = self.session()
        self.conn.execute("INSERT INTO session_refs (session_uid, episode, kind, repo, value, source, observed_at, "
                          "recorded_at, recorded_by) SELECT ?, 1, 'branch', '', 'a', 'hook', ?, ?, 't' WHERE 0", (uid, NOW, NOW))
        self.episode(uid)
        ids = []
        for value in ("a", "b"):
            ids.append(self.conn.execute(
                "INSERT INTO session_refs (session_uid, episode, kind, repo, value, source, observed_at, recorded_at, "
                "recorded_by) VALUES (?, 1, 'branch', '', ?, 'hook', ?, ?, 't')", (uid, value, NOW, NOW)).lastrowid)
        with self.assertRaises(ValueError):
            correct.correct(self.conn, "session_refs", ids[0], "wrong", "josh", NOW, replacement=999)
        correct.correct(self.conn, "session_refs", ids[0], "wrong", "josh", NOW, replacement=ids[1])
        self.assertEqual(self.rows("SELECT replacement_row_id FROM corrections")[0][0], ids[1])

    def test_undo_brings_the_row_back_once(self):
        _, row = self.seed()
        cid = correct.correct(self.conn, "session_episodes", row, "wrong", "josh", NOW)
        self.assertEqual(self.count("current_session_episodes"), 0)
        undo_id = correct.undo(self.conn, cid, "josh", NOW)
        self.assertEqual(self.count("current_session_episodes"), 1)
        with self.assertRaises(ValueError):
            correct.undo(self.conn, undo_id, "josh", NOW)
        with self.assertRaises(ValueError):
            correct.undo(self.conn, cid, "josh", NOW)
        # withdrawing again after an undo is a new correction
        correct.correct(self.conn, "session_episodes", row, "wrong", "josh", NOW)
        self.assertEqual(self.count("current_session_episodes"), 0)


class NextVersion(LedgerCase):
    KEY = {"session_uid": None, "episode": 1}

    def test_next_version_needs_a_withdrawal(self):
        uid = self.session()
        key = {"session_uid": uid, "episode": 1}
        self.assertEqual(correct.next_version(self.conn, "session_episodes", key), 1)
        row = self.episode(uid)
        with self.assertRaisesRegex(ValueError, "still in force"):
            correct.next_version(self.conn, "session_episodes", key)
        correct.correct(self.conn, "session_episodes", row, "wrong", "josh", NOW)
        self.assertEqual(correct.next_version(self.conn, "session_episodes", key), 2)
        self.episode(uid, version=2, title="replaced")
        self.assertEqual(self.rows("SELECT title FROM current_session_episodes")[0][0], "replaced")
        with self.assertRaises(ValueError):
            correct.next_version(self.conn, "session_episodes", key)

    def test_next_version_checks_its_arguments(self):
        with self.assertRaises(ValueError):
            correct.next_version(self.conn, "session_refs", {"x": 1})
        with self.assertRaises(ValueError):
            correct.next_version(self.conn, "session_episodes", {"session_uid": "x"})

    def test_a_trigger_refuses_a_version_the_helper_did_not_allow(self):
        uid = self.session()
        self.episode(uid)
        with self.assertRaisesRegex(Exception, "needs the version before it withdrawn"):
            self.episode(uid, version=2)

    def test_versioned_matches_the_schema(self):
        tables = [r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        with_version = {t for t in tables if t != "schema_migrations"
                        and "version" in [c[1] for c in self.conn.execute("PRAGMA table_info({})".format(t))]}
        with_trigger = set(re.findall(r"CREATE TRIGGER (\w+)_replaces_withdrawn", SCHEMA))
        self.assertEqual(with_version, set(correct.VERSIONED))
        self.assertEqual(with_trigger, set(correct.VERSIONED))


class Command(LedgerCase):
    def run_cmd(self, *args):
        env = dict(os.environ)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run([sys.executable, str(ROOT / "ledger" / "correct.py")] + list(args), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def test_correct_command_needs_a_reason(self):
        result = self.run_cmd("--table", "session_homes", "--row", "2")
        self.assertEqual(result.returncode, 2)

    def test_command_withdraws_and_undoes(self):
        uid = self.session()
        row = self.episode(uid)
        self.conn.close()
        first = self.run_cmd("--table", "session_episodes", "--row", str(row), "--reason", "test-row")
        self.assertEqual(first.returncode, 0, first.stderr)
        cid = int(first.stdout.strip())
        again = self.run_cmd("--table", "session_episodes", "--row", str(row), "--reason", "wrong")
        self.assertEqual(again.returncode, 2)
        undone = self.run_cmd("--undo", str(cid), "--by", "script")
        self.assertEqual(undone.returncode, 0, undone.stderr)
        from ledger import db
        conn = db.connect(self.path)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM current_session_episodes").fetchone()[0], 1)
        conn.close()
        self.conn = db.connect(self.path)

    def test_command_without_a_ledger_exits_2_and_creates_none(self):
        os.environ["JOSH360_HOME"] = str(self.tmp / "empty")
        result = self.run_cmd("--table", "machines", "--row", "1", "--reason", "wrong")
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.tmp / "empty").exists())


if __name__ == "__main__":
    unittest.main()
