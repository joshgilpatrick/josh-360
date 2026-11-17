"""JP-150: the Azure copy of the daily backups. Made-up rows and a made-up container only; no test reaches Azure."""
import datetime
import gzip
import io
import json
import sqlite3
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from azure_fake import FakeContainer  # noqa: E402
from ledger_helpers import FAKE_PHONE, NOW, LedgerCase  # noqa: E402
from ledger import azure_blob, backup, db, redact, upload  # noqa: E402

TODAY = datetime.date(2026, 11, 17)


def gunzip_db(gz: Path, plain: Path) -> sqlite3.Connection:
    with gzip.open(str(gz), "rb") as src:
        plain.write_bytes(src.read())
    return sqlite3.connect(str(plain))


class UploadCase(LedgerCase):
    def setUp(self):
        super().setUp()
        self.container = FakeContainer(self.tmp / "container")
        self.backups = db.backups_dir()

    def local_copy(self, day=TODAY):
        dest = self.backups / "ledger-{}.db.gz".format(day.isoformat())
        backup.copy_to(self.conn, dest)
        return dest


class Sync(UploadCase):
    def test_a_new_backup_is_uploaded(self):
        local = self.local_copy()
        result = upload.sync(self.container, self.backups, TODAY)
        self.assertEqual(result["uploaded"], [local.name])
        self.assertEqual((self.container.folder / local.name).read_bytes(), local.read_bytes())

    def test_a_backup_already_there_is_not_uploaded_again(self):
        self.local_copy()
        upload.sync(self.container, self.backups, TODAY)
        self.container.uploads.clear()
        result = upload.sync(self.container, self.backups, TODAY)
        self.assertEqual(result["uploaded"], [])
        self.assertEqual(self.container.uploads, [])

    def test_a_copy_that_differs_in_size_is_replaced(self):
        local = self.local_copy()
        (self.container.folder / local.name).write_bytes(b"old")
        result = upload.sync(self.container, self.backups, TODAY)
        self.assertEqual(result["uploaded"], [local.name])
        self.assertEqual((self.container.folder / local.name).read_bytes(), local.read_bytes())

    def test_only_dated_ledger_backups_go_up(self):
        self.local_copy()
        (self.backups / "pre-migration-1-2026-01-01T000000Z.db.gz").write_bytes(b"x")
        (self.backups / "notes.txt").write_bytes(b"x")
        upload.sync(self.container, self.backups, TODAY)
        self.assertEqual(sorted(self.container.list_blobs()), ["ledger-2026-11-17.db.gz"])

    def test_the_container_keeps_14_daily_and_8_weekly(self):
        for n in range(80):
            day = TODAY - datetime.timedelta(days=n)
            (self.container.folder / "ledger-{}.db.gz".format(day.isoformat())).write_bytes(b"x")
        (self.container.folder / "unrelated.txt").write_bytes(b"x")
        result = upload.sync(self.container, self.backups, TODAY)
        left = sorted(n for n in self.container.list_blobs() if n.startswith("ledger-"))
        self.assertEqual(len(left), 14 + 6)
        self.assertEqual(len(result["removed"]), 60)
        self.assertIn("unrelated.txt", self.container.list_blobs())

    def test_nothing_is_removed_when_the_container_cannot_be_listed(self):
        self.container.unreachable = True
        with self.assertRaises(azure_blob.AzureError):
            upload.sync(self.container, self.backups, TODAY)
        self.assertEqual(self.container.deletes, [])


class Job(UploadCase):
    def run_job(self, client, config=True):
        out = io.StringIO()
        with redirect_stdout(out):
            code = upload.main([], client=client if config else None, today=TODAY, now=NOW)
        return code, json.loads(out.getvalue())

    def test_the_report_says_when_the_upload_worked(self):
        local = self.local_copy()
        code, report = self.run_job(self.container)
        self.assertEqual(code, 0)
        self.assertEqual(report, {"error": None, "last_success": NOW, "pending_redactions": 0,
                                  "removed": 0, "status": "ok", "uploaded": [local.name]})

    def test_a_failed_upload_is_reported_and_the_local_backup_kept(self):
        local = self.local_copy()
        self.container.unreachable = True
        code, report = self.run_job(self.container)
        self.assertEqual(code, 0)  # exit 0 so the runner still publishes the report
        self.assertEqual(report["status"], "failed")
        self.assertIn("cannot be reached", report["error"])
        self.assertTrue(local.is_file())

    def test_a_failure_keeps_the_time_of_the_last_success(self):
        self.local_copy()
        self.run_job(self.container)
        self.container.unreachable = True
        later = "2026-11-18T12:00:00Z"
        out = io.StringIO()
        with redirect_stdout(out):
            upload.main([], client=self.container, today=TODAY, now=later)
        report = json.loads(out.getvalue())
        self.assertEqual((report["status"], report["last_success"]), ("failed", NOW))

    def test_an_unset_container_is_reported_and_nothing_is_uploaded(self):
        self.local_copy()
        code, report = self.run_job(None, config=False)
        self.assertEqual(code, 0)
        self.assertEqual(report["status"], "not-configured")
        self.assertIsNone(report["last_success"])
        self.assertEqual(self.container.uploads, [])

    def test_no_ledger_backup_yet_is_ok_and_uploads_nothing(self):
        code, report = self.run_job(self.container)
        self.assertEqual((code, report["status"], report["uploaded"]), (0, "ok", []))


class Redaction(UploadCase):
    def setUp(self):
        super().setUp()
        uid = self.session()
        self.row = self.episode(uid, title="Call " + FAKE_PHONE + " today")
        self.other = self.episode(uid, episode=2, title="An ordinary title")
        self.local_copy()
        upload.sync(self.container, self.backups, TODAY)

    def remote_titles(self):
        titles = []
        for name in self.container.list_blobs():
            conn = gunzip_db(self.container.folder / name, self.tmp / "peek.db")
            titles.append(dict(conn.execute("SELECT id, title FROM session_episodes").fetchall()))
            conn.close()
        return titles

    def test_a_redaction_reaches_the_uploaded_copies(self):
        self.assertIn(FAKE_PHONE, self.remote_titles()[0][self.row])
        redact.redact(self.conn, "session_episodes", self.row, "title", NOW)
        redact.redact_backups(self.backups, "session_episodes", self.row, "title")
        result = upload.redact_uploaded(self.container, "session_episodes", self.row, "title")
        self.assertEqual(result, {"rewritten": 1, "unreadable": []})
        titles = self.remote_titles()
        self.assertEqual(titles[0][self.row], "withheld: patient data")
        self.assertEqual(titles[0][self.other], "An ordinary title")
        for blob in self.container.folder.iterdir():
            self.assertNotIn(FAKE_PHONE.encode(), gzip.decompress(blob.read_bytes()))

    def test_a_remote_only_copy_is_redacted_too(self):
        # an uploaded copy with no local twin: the local rewrite cannot reach it, the download-and-rewrite does
        (self.backups / "ledger-2026-11-17.db.gz").rename(self.tmp / "gone.db.gz")
        redact.redact(self.conn, "session_episodes", self.row, "title", NOW)
        upload.redact_uploaded(self.container, "session_episodes", self.row, "title")
        self.assertEqual(self.remote_titles()[0][self.row], "withheld: patient data")

    def test_a_copy_that_cannot_be_read_is_named_not_skipped(self):
        (self.container.folder / "ledger-2026-11-10.db.gz").write_bytes(b"not a gzip")
        result = upload.redact_uploaded(self.container, "session_episodes", self.row, "title")
        self.assertEqual(result["unreadable"], ["ledger-2026-11-10.db.gz"])

    def test_a_redaction_that_cannot_reach_the_container_is_kept_for_the_next_run(self):
        self.container.unreachable = True
        upload.queue_redaction("session_episodes", self.row, "title")
        self.assertEqual(upload.pending_redactions(), [["session_episodes", self.row, "title"]])
        self.container.unreachable = False
        out = io.StringIO()
        with redirect_stdout(out):
            upload.main([], client=self.container, today=TODAY, now=NOW)
        report = json.loads(out.getvalue())
        self.assertEqual((report["status"], report["pending_redactions"]), ("ok", 0))
        self.assertEqual(upload.pending_redactions(), [])

    def test_the_queue_holds_where_never_what(self):
        upload.queue_redaction("session_episodes", self.row, "title")
        text = upload.pending_path().read_text()
        self.assertNotIn(FAKE_PHONE, text)
        self.assertEqual(json.loads(text), [["session_episodes", self.row, "title"]])

    def test_an_unreadable_copy_keeps_the_redaction_pending(self):
        (self.container.folder / "ledger-2026-11-10.db.gz").write_bytes(b"not a gzip")
        upload.queue_redaction("session_episodes", self.row, "title")
        out = io.StringIO()
        with redirect_stdout(out):
            upload.main([], client=self.container, today=TODAY, now=NOW)
        report = json.loads(out.getvalue())
        self.assertEqual(report["pending_redactions"], 1)
        self.assertIn("ledger-2026-11-10.db.gz", report["error"])


class Config(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-azcfg-"))
        self.addCleanup(__import__("shutil").rmtree, str(self.tmp), True)

    def write(self, data):
        (self.tmp / "azure-backup.json").write_text(json.dumps(data))

    def test_no_file_and_no_environment_means_not_set(self):
        self.assertIsNone(azure_blob.load_config(self.tmp, {}))

    def test_the_file_names_an_account_and_a_container(self):
        self.write({"account": "stmadeup01", "container": "ledger-backups"})
        self.assertEqual(azure_blob.load_config(self.tmp, {}), ("stmadeup01", "ledger-backups"))

    def test_the_environment_wins_over_the_file(self):
        self.write({"account": "stmadeup01", "container": "ledger-backups"})
        env = {"JOSH360_AZURE_ACCOUNT": "stother02", "JOSH360_AZURE_CONTAINER": "other-box"}
        self.assertEqual(azure_blob.load_config(self.tmp, env), ("stother02", "other-box"))

    def test_a_file_holding_a_secret_is_refused(self):
        for key in ("key", "account_key", "sas", "sas_token", "connection_string", "password"):
            self.write({"account": "stmadeup01", "container": "ledger-backups", key: "x"})
            with self.assertRaisesRegex(azure_blob.AzureError, "no secret"):
                azure_blob.load_config(self.tmp, {})

    def test_bad_names_are_refused(self):
        for account, container in (("A", "ledger-backups"), ("stmadeup01", "x"), ("st/../x", "ledger-backups"),
                                   ("stmadeup01", "Ledger_Backups"), ("stmadeup01", "-bad-")):
            self.write({"account": account, "container": container})
            with self.assertRaises(azure_blob.AzureError):
                azure_blob.load_config(self.tmp, {})

    def test_half_a_setting_is_refused_not_ignored(self):
        self.write({"account": "stmadeup01"})
        with self.assertRaises(azure_blob.AzureError):
            azure_blob.load_config(self.tmp, {})


class Runner:
    def __init__(self, stdout="[]", code=0, stderr=""):
        self.calls = []
        self.result = (code, stdout, stderr)

    def __call__(self, argv, env):
        self.calls.append((argv, env))
        return self.result


class AzCli(unittest.TestCase):
    def client(self, runner):
        return azure_blob.AzCli("stmadeup01", "ledger-backups", runner=runner, az="/made/up/az")

    def test_every_call_signs_in_as_josh_and_carries_no_key(self):
        runner = Runner(stdout='[{"name": "ledger-2026-11-17.db.gz", "size": 12}]')
        client = self.client(runner)
        self.assertEqual(client.list_blobs(), {"ledger-2026-11-17.db.gz": 12})
        client.upload("ledger-2026-11-17.db.gz", Path("/tmp/x.gz"))
        client.download("ledger-2026-11-17.db.gz", Path("/tmp/y.gz"))
        client.delete("ledger-2026-11-17.db.gz")
        self.assertEqual(len(runner.calls), 4)
        for argv, env in runner.calls:
            self.assertEqual(argv[:3], ["/made/up/az", "storage", "blob"])
            self.assertEqual(argv[argv.index("--auth-mode") + 1], "login")
            self.assertEqual(argv[argv.index("--account-name") + 1], "stmadeup01")
            self.assertEqual(argv[argv.index("--container-name") + 1], "ledger-backups")
            for flag in ("--account-key", "--sas-token", "--connection-string"):
                self.assertNotIn(flag, argv)

    def test_a_key_in_the_environment_is_not_passed_on(self):
        runner = Runner()
        import os
        os.environ["AZURE_STORAGE_KEY"] = "made-up"
        self.addCleanup(os.environ.pop, "AZURE_STORAGE_KEY", None)
        self.client(runner).list_blobs()
        env = runner.calls[0][1]
        for name in ("AZURE_STORAGE_KEY", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_SAS_TOKEN",
                     "AZURE_STORAGE_ACCOUNT"):
            self.assertNotIn(name, env)

    def test_a_failed_call_raises_with_the_first_line_of_what_az_said(self):
        client = self.client(Runner(code=1, stderr="Please run 'az login' to set up an account.\nmore\n"))
        with self.assertRaisesRegex(azure_blob.AzureError, "az login"):
            client.list_blobs()

    def test_a_missing_az_is_an_error_not_a_crash(self):
        client = azure_blob.AzCli("stmadeup01", "ledger-backups", az=None)
        client._az_lookup = lambda: None
        with self.assertRaisesRegex(azure_blob.AzureError, "az"):
            client.list_blobs()

    def test_a_listing_that_is_not_json_is_an_error(self):
        with self.assertRaises(azure_blob.AzureError):
            self.client(Runner(stdout="oops")).list_blobs()


class RedactCommand(UploadCase):
    def test_the_command_also_rewrites_the_uploaded_copies(self):
        from test_ledger_redact import Tty
        uid = self.session()
        row = self.episode(uid, title="Call " + FAKE_PHONE + " today")
        self.local_copy()
        upload.sync(self.container, self.backups, TODAY)
        out = io.StringIO()
        with redirect_stdout(out):
            code = redact.main(["--table", "session_episodes", "--row", str(row), "--column", "title"],
                               stdin=Tty("redact\n"), path=self.path, backups=self.backups, client=self.container)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["uploaded_rewritten"], 1)
        for blob in self.container.folder.iterdir():
            self.assertNotIn(FAKE_PHONE.encode(), gzip.decompress(blob.read_bytes()))

    def test_an_unreachable_container_leaves_the_rest_done_and_says_so(self):
        from test_ledger_redact import Tty
        uid = self.session()
        row = self.episode(uid, title="Call " + FAKE_PHONE + " today")
        self.container.unreachable = True
        out = io.StringIO()
        with redirect_stdout(out):
            code = redact.main(["--table", "session_episodes", "--row", str(row), "--column", "title"],
                               stdin=Tty("redact\n"), path=self.path, backups=self.backups, client=self.container)
        self.assertEqual(code, 3)  # the ledger and local backups are done; the uploaded copies are still to do
        self.assertEqual(upload.pending_redactions(), [["session_episodes", row, "title"]])
        self.assertEqual(self.rows("SELECT title FROM session_episodes WHERE id = ?", (row,)),
                         [("withheld: patient data",)])

    def test_with_no_container_set_nothing_is_queued_and_the_command_is_done(self):
        from test_ledger_redact import Tty
        uid = self.session()
        row = self.episode(uid, title="Call " + FAKE_PHONE + " today")
        out = io.StringIO()
        with redirect_stdout(out):
            code = redact.main(["--table", "session_episodes", "--row", str(row), "--column", "title"],
                               stdin=Tty("redact\n"), path=self.path, backups=self.backups, client=None)
        self.assertEqual(code, 0)
        self.assertEqual(upload.pending_redactions(), [])


if __name__ == "__main__":
    unittest.main()
