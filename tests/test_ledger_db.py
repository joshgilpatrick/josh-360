"""JP-107, Task 1: open, create and migrate the ledger. Made-up data only, in temp folders."""
import os
import re
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
NEW_TABLE = """CREATE TABLE x (id INTEGER PRIMARY KEY);
CREATE TRIGGER x_no_update BEFORE UPDATE ON x BEGIN SELECT RAISE(ABORT, 'ledger is append-only: x'); END;
CREATE TRIGGER x_no_delete BEFORE DELETE ON x BEGIN SELECT RAISE(ABORT, 'ledger is append-only: x'); END;
"""


class LedgerDbCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-ledger-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.path = self.tmp / "state" / "ledger.db"
        self.backups = self.tmp / "backups"
        self.migrations = self.tmp / "migrations"
        self.migrations.mkdir()

    def counts(self, conn):
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
        return {t: conn.execute("SELECT COUNT(*) FROM {}".format(t)).fetchone()[0] for t in tables}


class Creating(LedgerDbCase):
    def test_new_database_is_version_1_with_one_machine(self):
        self.assertEqual(db.ensure(self.path, self.backups, NOW, self.migrations), 1)
        conn = db.connect(self.path)
        self.assertEqual(db.user_version(conn), 1)
        rows = conn.execute("SELECT machine_id, label FROM machines").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertRegex(rows[0][0], r"^m-[0-9a-f]{8}$")
        self.assertEqual((self.path.parent / "machine-id").read_text().strip(), rows[0][0])
        self.assertEqual(db.machine_id(conn), rows[0][0])

    def test_header_version_matches_user_version_and_leaves_no_files(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        before = sorted(p.name for p in self.path.parent.iterdir())
        self.assertEqual(db.header_version(self.path), 1)
        self.assertEqual(sorted(p.name for p in self.path.parent.iterdir()), before)
        (self.tmp / "junk").write_bytes(b"not a database" * 20)
        with self.assertRaises(ValueError):
            db.header_version(self.tmp / "junk")

    def test_machine_label_is_not_a_person(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        label = db.connect(self.path).execute("SELECT label FROM machines").fetchone()[0]
        self.assertEqual(label, "work laptop")

    def test_ensure_twice_changes_nothing(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        conn = db.connect(self.path)
        before = self.counts(conn)
        conn.close()
        self.assertEqual(db.ensure(self.path, self.backups, NOW, self.migrations), 1)
        conn = db.connect(self.path)
        self.assertEqual(self.counts(conn), before)
        self.assertEqual(db.user_version(conn), 1)

    def test_machine_id_file_is_reused_if_the_database_is_lost(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        first = (self.path.parent / "machine-id").read_text().strip()
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                p.unlink()
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.assertEqual(db.machine_id(db.connect(self.path)), first)


class Pragmas(LedgerDbCase):
    def test_connect_sets_the_pragmas(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        conn = db.connect(self.path)
        self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        self.assertEqual(conn.execute("PRAGMA recursive_triggers").fetchone()[0], 1)
        self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.assertEqual(conn.execute("PRAGMA busy_timeout").fetchone()[0], 5000)

    def test_connect_refuses_insert_or_replace(self):
        """Review Focus 1: without recursive_triggers a replace deletes a row past its no_delete trigger."""
        db.ensure(self.path, self.backups, NOW, self.migrations)
        conn = db.connect(self.path)
        mid = db.machine_id(conn)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            conn.execute("INSERT OR REPLACE INTO machines (machine_id, label, created_at, recorded_by) "
                         "VALUES (?, 'x', ?, 't')", (mid, NOW))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM machines").fetchone()[0], 1)

    def test_transaction_rolls_back_on_error(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        conn = db.connect(self.path)
        with self.assertRaises(RuntimeError):
            with db.transaction(conn):
                conn.execute("INSERT INTO machines (machine_id, label, created_at, recorded_by) "
                             "VALUES ('m-00000000', 'x', ?, 't')", (NOW,))
                raise RuntimeError("stop")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM machines").fetchone()[0], 1)


class Migrating(LedgerDbCase):
    def migration(self, name, sql):
        (self.migrations / name).write_text(sql, encoding="utf-8")

    def test_migration_applied_in_order_after_a_backup(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.migration("0002-add-x.sql", NEW_TABLE)
        self.assertEqual(db.ensure(self.path, self.backups, "2026-11-18T01:02:03Z", self.migrations), 2)
        conn = db.connect(self.path)
        self.assertEqual(db.user_version(conn), 2)
        self.assertEqual([r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")], [1, 2])
        saved = list(self.backups.iterdir())
        self.assertEqual([p.name for p in saved], ["pre-migration-1-2026-11-18T010203Z.db.gz"])
        import gzip
        with gzip.open(str(saved[0]), "rb") as f:
            self.assertTrue(f.read(16).startswith(b"SQLite format 3"))
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            conn.execute("INSERT INTO x DEFAULT VALUES")
            conn.execute("DELETE FROM x")

    def test_two_migrations_apply_in_number_order(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.migration("0003-y.sql", NEW_TABLE.replace(" x", " y").replace("x_", "y_").replace(": x", ": y"))
        self.migration("0002-add-x.sql", NEW_TABLE)
        self.assertEqual(db.ensure(self.path, self.backups, NOW, self.migrations), 3)
        conn = db.connect(self.path)
        self.assertEqual([r[0] for r in conn.execute("SELECT name FROM schema_migrations ORDER BY version")][1:],
                         ["add-x", "y"])

    def test_migration_that_rewrites_rows_is_refused(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        for i, bad in enumerate(["UPDATE machines SET label = 'x';", "DELETE FROM machines;", "DROP TABLE machines;",
                                 "ALTER TABLE machines DROP COLUMN label;", "REPLACE INTO machines (id) VALUES (1);",
                                 "INSERT OR REPLACE INTO machines (id) VALUES (1);"]):
            self.migration("0002-bad.sql", bad)
            with self.assertRaises(ValueError, msg=bad):
                db.ensure(self.path, self.backups, NOW, self.migrations)
            conn = db.connect(self.path)
            self.assertEqual(db.user_version(conn), 1)
            conn.close()
        self.assertFalse(self.backups.exists() and list(self.backups.iterdir()))

    def test_adding_a_column_and_a_view_is_allowed(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.migration("0002-more.sql", "ALTER TABLE sessions ADD COLUMN note TEXT;\n"
                                        "CREATE VIEW v AS SELECT 1 AS one;\n")
        self.assertEqual(db.ensure(self.path, self.backups, NOW, self.migrations), 2)

    def test_new_table_without_triggers_is_refused(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.migration("0002-add-x.sql", "CREATE TABLE x (id INTEGER PRIMARY KEY);")
        with self.assertRaisesRegex(ValueError, "x_no_update"):
            db.ensure(self.path, self.backups, NOW, self.migrations)
        self.assertEqual(db.user_version(db.connect(self.path)), 1)

    def test_a_migration_that_fails_midway_is_rolled_back(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.migration("0002-add-x.sql", NEW_TABLE + "\nALTER TABLE no_such_table ADD COLUMN c TEXT;\n")
        with self.assertRaises(sqlite3.DatabaseError):
            db.ensure(self.path, self.backups, NOW, self.migrations)
        conn = db.connect(self.path)
        self.assertEqual(db.user_version(conn), 1)
        self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name = 'x'").fetchone())

    def test_a_badly_named_migration_is_refused(self):
        db.ensure(self.path, self.backups, NOW, self.migrations)
        self.migration("add-x.sql", NEW_TABLE)
        with self.assertRaises(ValueError):
            db.ensure(self.path, self.backups, NOW, self.migrations)

    def test_newest_version_reads_the_folder(self):
        self.assertEqual(db.newest_version(self.migrations), 1)
        self.migration("0002-add-x.sql", NEW_TABLE)
        self.assertEqual(db.newest_version(self.migrations), 2)


class InstallStep(LedgerDbCase):
    def test_install_step_creates_the_ledger(self):
        sys.path.insert(0, str(ROOT / "laptop"))
        from laptop import common, install
        old = os.environ.get("JOSH360_HOME")
        os.environ["JOSH360_HOME"] = str(self.tmp / "home")
        try:
            actions, problems = install.step_ledger()
            self.assertEqual(problems, [])
            self.assertEqual([a[0] for a in actions], ["create or migrate the ledger"])
            actions[0][1](common.Lane())
            self.assertTrue((self.tmp / "home" / "state" / "ledger.db").is_file())
            self.assertEqual(install.step_ledger(), ([], []))
        finally:
            if old is None:
                del os.environ["JOSH360_HOME"]
            else:
                os.environ["JOSH360_HOME"] = old

    def test_install_step_refuses_a_ledger_that_is_a_link(self):
        sys.path.insert(0, str(ROOT / "laptop"))
        from laptop import install
        home = self.tmp / "home"
        (home / "state").mkdir(parents=True)
        (home / "state" / "ledger.db").symlink_to(self.tmp / "elsewhere")
        old = os.environ.get("JOSH360_HOME")
        os.environ["JOSH360_HOME"] = str(home)
        try:
            actions, problems = install.step_ledger()
            self.assertEqual(actions, [])
            self.assertEqual(len(problems), 1)
        finally:
            if old is None:
                del os.environ["JOSH360_HOME"]
            else:
                os.environ["JOSH360_HOME"] = old


if __name__ == "__main__":
    unittest.main()
