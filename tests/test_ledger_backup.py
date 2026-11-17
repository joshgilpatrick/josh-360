"""JP-107, Task 8: the daily backup. Made-up rows only."""
import datetime
import gzip
import io
import os
import socket
import sqlite3
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, LedgerCase  # noqa: E402
from ledger import backup, db  # noqa: E402

TODAY = datetime.date(2026, 11, 17)


class Backup(LedgerCase):
    def make_copy(self, name="ledger-2026-11-17.db.gz"):
        dest = self.tmp / "home" / "backups" / name
        backup.copy_to(self.conn, dest)
        return dest

    def test_backup_is_a_readable_gzip_copy(self):
        uid = self.session()
        dest = self.make_copy()
        plain = self.tmp / "restored.db"
        with gzip.open(str(dest), "rb") as src:
            plain.write_bytes(src.read())
        copy = sqlite3.connect(str(plain))
        self.addCleanup(copy.close)
        self.assertEqual(copy.execute("SELECT session_uid FROM sessions").fetchall(), [(uid,)])
        self.assertEqual(copy.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
        self.assertEqual(oct(dest.stat().st_mode & 0o777), "0o600")
        self.assertEqual([p.name for p in dest.parent.iterdir()], [dest.name])  # no temp files left behind

    def test_a_copy_made_while_the_ledger_is_in_use_is_complete(self):
        self.session("sess-0001")
        self.conn.execute("BEGIN IMMEDIATE")
        self.conn.execute("COMMIT")
        dest = self.make_copy()
        self.assertTrue(dest.is_file())

    def test_rotation_keeps_14_daily_and_8_weekly(self):
        folder = self.tmp / "rot"
        folder.mkdir()
        days = [TODAY - datetime.timedelta(days=n) for n in range(80)]
        for d in days:
            (folder / "ledger-{}.db.gz".format(d.isoformat())).write_bytes(b"x")
        (folder / "pre-migration-1-2026-01-01T000000Z.db.gz").write_bytes(b"x")
        (folder / "notes.txt").write_bytes(b"x")
        removed = backup.rotate(folder, TODAY)
        left = sorted(p.name for p in folder.glob("ledger-*.db.gz"))
        kept_days = {datetime.date.fromisoformat(n[7:17]) for n in left}
        self.assertTrue(all(TODAY - datetime.timedelta(days=n) in kept_days for n in range(14)))  # 14 daily
        for week in range(8):  # the newest copy of each of the last 8 weeks
            newest = TODAY - datetime.timedelta(days=week * 7)
            self.assertIn(newest, kept_days)
        self.assertEqual(len(kept_days), 14 + 6)  # weeks 2 to 7 are outside the daily 14
        self.assertEqual(len(removed), 80 - 20)
        self.assertTrue((folder / "notes.txt").exists())
        self.assertTrue((folder / "pre-migration-1-2026-01-01T000000Z.db.gz").exists())

    def test_rotation_with_few_copies_removes_nothing(self):
        folder = self.tmp / "rot"
        folder.mkdir()
        for n in range(5):
            (folder / "ledger-{}.db.gz".format((TODAY - datetime.timedelta(days=n)).isoformat())).write_bytes(b"x")
        self.assertEqual(backup.rotate(folder, TODAY), [])

    def test_a_corrupt_copy_is_not_kept(self):
        dest = self.tmp / "home" / "backups" / "ledger-2026-11-17.db.gz"

        with mock.patch.object(backup, "_integrity", return_value=[("*** in database main ***",)]):
            with self.assertRaises(backup.CorruptCopy):
                backup.copy_to(self.conn, dest)
        self.assertFalse(dest.exists())
        self.assertEqual(list(dest.parent.iterdir()), [])

    def test_main_exits_1_for_a_corrupt_copy(self):
        with mock.patch.object(backup, "copy_to", side_effect=backup.CorruptCopy("bad")):
            self.assertEqual(backup.main(), 1)

    def test_main_writes_todays_copy_and_rotates(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(backup.main(), 0)
        names = [p.name for p in db.backups_dir().iterdir() if p.name.startswith("ledger-")]
        self.assertEqual(len(names), 1)
        self.assertRegex(names[0], r"^ledger-\d{4}-\d{2}-\d{2}\.db\.gz$")

    def test_main_with_no_ledger_exits_1(self):
        os.environ["JOSH360_HOME"] = str(self.tmp / "elsewhere")
        self.assertEqual(backup.main(), 1)

    def test_backup_makes_no_network_call(self):
        with mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used")), \
                mock.patch.object(socket, "create_connection", side_effect=AssertionError("network used")), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(backup.main(), 0)
        source = (Path(backup.__file__)).read_text(encoding="utf-8")
        for banned in ("urllib", "http.client", "azure", "boto", "requests"):
            self.assertNotIn("import " + banned, source)


if __name__ == "__main__":
    unittest.main()
