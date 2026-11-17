"""JP-107, Task 9: the one-time backfill. A made-up Atlas database, made-up transcripts, no network."""
import calendar
import json
import sqlite3
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger_transcripts as tr  # noqa: E402
from ledger_helpers import FAKE_PHONE, NOW, LedgerCase  # noqa: E402
from test_ledger_costs import cost_ledger, message  # noqa: E402
from test_ledger_homes import CONV  # noqa: E402
from test_ledger_record import FOLDER, fake_git, jira_ok  # noqa: E402
from ledger import backfill  # noqa: E402

NOW_EPOCH = calendar.timegm(time.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ"))
ATLAS_SUMMARY = "an atlas focus summary that must never be copied"

ATLAS_DDL = """
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, parent_session_id TEXT, root_session_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'fallback',
  summary TEXT, focus_state TEXT, start_cwd TEXT, transcript_path TEXT, started_at TEXT NOT NULL);
CREATE TABLE session_lineage (child_session_id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT 'unknown', discovered_at TEXT NOT NULL);
"""


def atlas_db(rows=(), lineage=()):
    db = sqlite3.connect(":memory:")
    db.executescript(ATLAS_DDL)
    for sid, title, source, sub in rows:
        db.execute("INSERT INTO sessions (session_id, is_subagent, title, title_source, summary, focus_state, "
                   "start_cwd, started_at) VALUES (?, ?, ?, ?, ?, 'active', ?, '2026-11-01T09:00:00Z')",
                   (sid, sub, title, source, ATLAS_SUMMARY, FOLDER))
    for child, parent, root, confidence in lineage:
        db.execute("INSERT INTO session_lineage VALUES (?, ?, ?, ?, '2026-11-01T09:00:00Z')",
                   (child, parent, root, confidence))
    return db


class Backfill(LedgerCase):
    def setUp(self):
        super().setUp()
        self.projects = self.tmp / "projects"

    def tfile(self, sid):
        return self.projects / "-made-up" / (sid + ".jsonl")

    def write(self, sid, folder=FOLDER, age=7200, **kw):
        tr.write(self.tfile(sid), tr.plain(folder, session_id=sid, **kw), mtime=NOW_EPOCH - age)

    def run_it(self, atlas=None, cost_db=None, jira=jira_ok, claude_home=None):
        return backfill.backfill(self.conn, atlas=atlas, cost_db=cost_db, projects=self.projects, now=NOW,
                                 git=fake_git, jira=jira, conventions=CONV, claude_home=claude_home)

    def test_every_transcript_becomes_a_session_with_source_backfill(self):
        for sid in ("sess-0001", "sess-0002"):
            self.write(sid, created=["/tmp/made-up/%s.md" % sid])
        cdb = cost_ledger()
        cdb.execute("INSERT INTO jira_session_links VALUES ('JP-902', 'claude-code', 'sess-0001', 'worked', ?)",
                    ("2026-11-17T09:05:00Z",))
        cdb.execute("INSERT INTO session_pr_links VALUES ('claude-code', 'sess-0001', 'https://example.test/o/r/pull/9', "
                    "'o/r', '9', '2026-11-17T09:06:00Z')")
        message(cdb, 1)
        report = self.run_it(cost_db=cdb)
        self.assertEqual((report["sessions"], report["episodes"]), (2, 2))
        self.assertEqual(self.rows("SELECT DISTINCT started_by FROM sessions"), [("unknown",)])
        self.assertEqual(self.rows("SELECT DISTINCT end_reason FROM session_episodes"), [("quiet",)])
        self.assertEqual(self.rows("SELECT source FROM ticket_links WHERE ticket_key = 'JP-902'"), [("backfill",)])
        self.assertEqual(self.rows("SELECT source FROM session_refs WHERE value = 'https://example.test/o/r/pull/9'"),
                         [("backfill",)])
        self.assertEqual(self.rows("SELECT DISTINCT recorded_by FROM session_episodes"), [("ledger/backfill.py",)])
        self.assertEqual(self.count("session_costs"), 1)

    def test_atlas_lineage_is_copied(self):
        self.write("sess-0001")
        self.write("sess-0002")
        atlas = atlas_db([("sess-0001", "A", "native", 0), ("sess-0002", "B", "native", 0)],
                         [("sess-0002", "sess-0001", "sess-0001", "confirmed"),
                          ("sess-0001", "sess-0001", "sess-0001", "inferred")])
        report = self.run_it(atlas=atlas)
        self.assertEqual(report["lineage"], 1)
        self.assertEqual(self.rows("SELECT kind, confidence FROM session_lineage"), [("resume", "confirmed")])

    def test_atlas_confidence_unknown_is_recorded_as_inferred_and_subagents_as_such(self):
        self.write("sess-0001")
        atlas = atlas_db([("sess-0001", "A", "native", 0), ("agent-x", "S", "fallback", 1)],
                         [("agent-x", "sess-0001", "sess-0001", "unknown")])  # a session only Atlas knows
        self.run_it(atlas=atlas)
        self.assertEqual(self.rows("SELECT kind, confidence FROM session_lineage"), [("subagent", "inferred")])
        self.assertEqual(self.count("sessions"), 2)

    def test_lineage_pointing_at_nothing_is_skipped_and_counted(self):
        self.write("sess-0001")
        atlas = atlas_db([("sess-0001", "A", "native", 0)], [("sess-0001", "gone-parent", "gone-parent", "confirmed")])
        report = self.run_it(atlas=atlas)
        self.assertEqual(report["lineage"], 0)
        self.assertEqual(report["skipped"]["lineage-session-unknown"], 1)

    def test_atlas_focus_fields_are_not_copied(self):
        self.write("sess-0001")
        atlas = atlas_db([("sess-0001", "A title", "native", 0)], [])
        self.run_it(atlas=atlas)
        self.assertNotIn(ATLAS_SUMMARY, "\n".join(self.conn.iterdump()))

    def test_backfill_twice_adds_nothing(self):
        self.write("sess-0001")
        self.write("sess-0002")
        atlas = atlas_db([("sess-0001", "A", "native", 0), ("sess-0002", "B", "native", 0)],
                         [("sess-0002", "sess-0001", "sess-0001", "confirmed")])
        self.run_it(atlas=atlas)
        tables = ("sessions", "session_episodes", "session_refs", "session_homes", "ticket_links", "session_lineage",
                  "session_costs", "session_facts")
        before = {t: self.count(t) for t in tables}
        again = self.run_it(atlas=atlas)
        self.assertEqual(before, {t: self.count(t) for t in tables})
        self.assertEqual((again["sessions"], again["episodes"], again["lineage"]), (0, 0, 0))
        self.assertEqual(again["skipped"]["already-recorded"], 2)

    def test_backfill_keeps_titles_after_the_screen(self):
        self.write("sess-0001", folder="/tmp/nowhere/in-particular")
        self.write("sess-0002", folder="/tmp/made-up/.phi/export")
        self.write("sess-0003", folder="/Users/made-up/Dev/made-up-app/src")
        self.write("sess-0004")
        atlas = atlas_db([("sess-0001", "Unassigned title", "worker", 0), ("sess-0002", "Phi title", "native", 0),
                          ("sess-0003", "Registry title", "native", 0),
                          ("sess-0004", "Call " + FAKE_PHONE, "native", 0)], [])
        self.run_it(atlas=atlas)
        got = {self.rows("SELECT tool_session_id FROM sessions WHERE session_uid = ?", (u,))[0][0]: (t, src)
               for u, t, src in self.rows("SELECT session_uid, title, title_source FROM session_episodes")}
        self.assertEqual(got, {"sess-0001": ("Unassigned title", "ai"), "sess-0002": (None, "withheld"),
                               "sess-0003": ("Registry title", "tool"), "sess-0004": (None, "withheld")})

    def test_a_title_in_the_transcript_beats_atlas(self):
        self.write("sess-0001", title="Transcript title")
        self.run_it(atlas=atlas_db([("sess-0001", "Atlas title", "native", 0)], []))
        self.assertEqual(self.rows("SELECT title, title_source FROM session_episodes"), [("Transcript title", "ai")])

    def test_a_session_the_recorder_already_wrote_is_left_alone(self):
        self.write("sess-0001")
        uid = self.session("sess-0001", started_by="walker")
        self.episode(uid)
        report = self.run_it()
        self.assertEqual(report["episodes"], 0)
        self.assertEqual(report["skipped"]["already-recorded"], 1)
        self.assertEqual(self.rows("SELECT started_by FROM sessions"), [("walker",)])
        self.assertEqual(self.count("session_episodes"), 1)

    def test_a_started_session_with_no_episode_gets_one(self):
        self.write("sess-0001")
        self.session("sess-0001", started_by="walker")
        self.assertEqual(self.run_it()["episodes"], 1)
        self.assertEqual(self.rows("SELECT started_by FROM sessions"), [("walker",)])

    def test_a_transcript_still_being_written_is_left_for_the_recorder(self):
        self.write("sess-0001", age=60)
        report = self.run_it()
        self.assertEqual((report["episodes"], report["skipped"]["recent"]), (0, 1))

    def test_an_old_transcript_is_not_skipped_for_its_age(self):
        self.write("sess-0001", age=400 * 86400)
        self.assertEqual(self.run_it()["episodes"], 1)

    def test_jira_is_read_once_per_ticket_key(self):
        for sid in ("sess-0001", "sess-0002", "sess-0003"):
            self.write(sid)
        calls = []

        def jira(key):
            calls.append(key)
            return jira_ok(key)
        self.run_it(jira=jira)
        self.assertEqual(calls, ["JP-900"])

    def test_report_has_counts_only(self):
        self.write("sess-0001", title="A private-looking title", created=["/tmp/made-up/secret-name.md"])
        report = json.dumps(self.run_it(atlas=atlas_db([("sess-0001", "Atlas title", "native", 0)], [])))
        for text in ("sess-0001", "private-looking", "secret-name", "/tmp", "Atlas title", FOLDER):
            self.assertNotIn(text, report)
        parsed = json.loads(report)
        self.assertTrue(all(isinstance(v, int) for k, v in parsed.items() if k != "skipped"))
        self.assertTrue(all(isinstance(v, int) for v in parsed["skipped"].values()))

    def test_one_bad_transcript_does_not_stop_the_rest(self):
        self.write("sess-0001")
        self.write("sess-0002")
        state = {"n": 0}

        def git(folder, args):
            if args[0] == "rev-parse" and state["n"] == 0:
                state["n"] = 1
                raise RuntimeError("made-up git failure")
            return fake_git(folder, args)
        report = backfill.backfill(self.conn, atlas=None, cost_db=None, projects=self.projects, now=NOW, git=git,
                                   jira=jira_ok, conventions=CONV)
        self.assertEqual((report["episodes"], report["skipped"]["error"]), (1, 1))

    def test_missing_atlas_and_cost_ledger_still_backfills(self):
        self.write("sess-0001")
        self.assertEqual(self.run_it(atlas=None, cost_db=None)["episodes"], 1)
        self.assertIsNone(backfill.open_atlas(self.tmp / "no-such" / "atlas.db"))

    def test_open_atlas_is_read_only(self):
        path = self.tmp / "atlas.db"
        raw = sqlite3.connect(str(path))
        raw.executescript(ATLAS_DDL)
        raw.commit()
        raw.close()
        atlas = backfill.open_atlas(path)
        self.addCleanup(atlas.close)
        with self.assertRaises(sqlite3.OperationalError):
            atlas.execute("INSERT INTO session_lineage VALUES ('a', 'b', 'c', 'confirmed', 'x')")


if __name__ == "__main__":
    unittest.main()
