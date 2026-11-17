"""JP-112: the measures as stored queries. Made-up sessions, tickets, runs and pull requests only."""
import io
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, LedgerCase  # noqa: E402
from ledger import measures  # noqa: E402

SINCE, UNTIL = "2026-11-10T00:00:00Z", "2026-11-18T00:00:00Z"
INSIDE = "2026-11-15T10:00:00Z"


class Seeded(LedgerCase):
    def ep(self, sid, ticket, answers=0, unprompted=0, quiet=INSIDE, extra=None, episode=1):
        """A session with one episode, homed to `ticket` (or none), with Josh's messages and any other facts."""
        uid = self.uid(sid)
        fresh = not self.rows("SELECT 1 FROM sessions WHERE session_uid = ?", (uid,))
        if fresh:
            self.session(sid)
        self.conn.execute(
            "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
            "folder, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, 'quiet', '/tmp/made-up/josh_360', ?, 't')",
            (uid, episode, quiet, quiet, quiet, quiet))
        if fresh and ticket:
            self.conn.execute(
                "INSERT INTO session_homes (session_uid, episode, method, tracker, ticket_key, epic_key, system, "
                "priority, evidence, conventions_version, jira_read, derived_at, recorded_by) "
                "VALUES (?, ?, 'branch', 'jira', ?, 'JP-94', 'josh-360', 'epicprio', 'e', 'abc', 'ok', ?, 't')",
                (uid, episode, ticket, quiet))
        facts = dict(josh_messages_answer=answers, josh_messages_unprompted=unprompted, **(extra or {}))
        for fact, value in facts.items():
            if value:
                self.conn.execute("INSERT INTO session_facts (session_uid, episode, fact, value, recorded_at, "
                                  "recorded_by) VALUES (?, ?, ?, ?, ?, 't')", (uid, episode, fact, value, quiet))
        return uid

    def graph_run(self, run_id, ticket=None, previous=None, end="finished", score="success", ended="2026-11-16T10:00:00Z",
            started="2026-11-16T09:00:00Z"):
        self.conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
            "subject_ref, tracker, ticket_key, previous_run_id, phi, runner, started_at, recorded_by) "
            "VALUES (?, ?, 'dev', 'graph-file', 'abc', 'ticket', ?, 'jira', ?, ?, 0, 'cli', ?, 't')",
            (run_id, self.machine, ticket, ticket, previous, started))
        if end:
            self.conn.execute("INSERT INTO run_ends (run_id, end_name, score, ended_at, recorded_by) "
                              "VALUES (?, ?, ?, ?, 't')", (run_id, end, score, ended))

    def audit(self, run_id, pr, outcome, started, ended):
        self.conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, subject_kind, subject_ref, phi, "
            "runner, started_at, recorded_by) VALUES (?, ?, 'pr-audit', 'external', 'pr', ?, 0, 'daemon', ?, 't')",
            (run_id, self.machine, pr, started))
        step = self.conn.execute("INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, started_at, "
                                 "recorded_by) VALUES (?, 'audit', 'gate', 1, 0, ?, 't')", (run_id, started)).lastrowid
        self.conn.execute("INSERT INTO step_results (step_run_id, outcome, ended_at, recorded_by) "
                          "VALUES (?, ?, ?, 't')", (step, outcome, ended))

    def cost(self, uid, usd, status="priced"):
        self.conn.execute("INSERT INTO session_costs (session_uid, computed_at, model, cost_usd, pricing_status, "
                          "price_set, recorded_by) VALUES (?, ?, 'm', ?, ?, '1', 't')", (uid, NOW, usd, status))

    def rows(self, sql, args=()):
        return self.conn.execute(sql, args).fetchall()

    def call(self, argv, fetch=None):
        out = io.StringIO()
        code = measures.main(argv, out, self.path, fetch=fetch, now=NOW)
        return code, (json.loads(out.getvalue()) if out.getvalue() else None)


class Headline(Seeded):
    def seed(self):
        self.ep("sess-0001", "JP-900", answers=2, unprompted=3)     # JP-900: finished by its graph run
        self.ep("sess-0002", "JP-900", unprompted=1, episode=1)
        self.ep("sess-0003", "JP-901", answers=1, unprompted=1)     # JP-901: Done in Jira (given)
        self.ep("sess-0004", "JP-902", answers=9, unprompted=9)     # JP-902: not finished
        self.ep("sess-0005", None, unprompted=5)                    # no ticket home
        self.ep("sess-0006", "JP-900", unprompted=40, quiet="2026-10-01T10:00:00Z")   # outside the window
        self.graph_run("run-1", "JP-900")

    def test_messages_per_finished_ticket_beside_the_first_time_share(self):
        self.seed()
        self.graph_run("run-2", "JP-903", end="finished", ended="2026-11-16T11:00:00Z")   # signed off first time
        out = measures.headline(self.conn, SINCE, UNTIL, finished=["JP-901"])
        per = out["josh_messages_per_finished_ticket"]
        self.assertEqual((per["finished_tickets"], per["messages"], per["value"]), (2, 6 + 2 + 0, 4.0))
        self.assertEqual((per["answers"], per["unprompted"]), (3, 5))
        self.assertEqual(out["unattributed_messages"], 5)
        self.assertEqual(out["first_time_signoff"]["share"], 1.0)
        self.assertEqual([t["ticket"] for t in out["tickets"]], ["JP-900", "JP-901"])
        self.assertEqual(out["tickets"][0]["sessions"], 2)

    def test_a_ticket_nobody_says_is_finished_is_not_counted(self):
        self.seed()
        out = measures.headline(self.conn, SINCE, UNTIL)
        self.assertEqual([t["ticket"] for t in out["tickets"]], ["JP-900"])
        self.assertIsNone(measures.headline(self.conn, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")
                          ["josh_messages_per_finished_ticket"]["value"])

    def test_a_ticket_whose_newest_run_did_not_finish_is_not_finished(self):
        self.seed()
        self.graph_run("run-9", "JP-900", end="review.refused", score="needs-josh", started="2026-11-17T09:00:00Z",
                 ended="2026-11-17T10:00:00Z", previous="run-1")
        self.assertEqual(measures.headline(self.conn, SINCE, UNTIL)["tickets"], [])

    def test_a_withdrawn_fact_is_not_counted(self):
        self.seed()
        row = self.rows("SELECT id FROM session_facts WHERE fact = 'josh_messages_answer' ORDER BY id LIMIT 1")[0][0]
        self.conn.execute("INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, "
                          "recorded_by) VALUES ('session_facts', ?, 'wrong', ?, 'josh', 't')", (row, NOW))
        out = measures.headline(self.conn, SINCE, UNTIL)
        self.assertEqual(out["josh_messages_per_finished_ticket"]["answers"], 0)

    def test_live_status_comes_from_jira_and_an_unreadable_ticket_is_unknown(self):
        self.seed()
        statuses = {"JP-901": "done", "JP-902": "indeterminate"}

        def fetch(path):
            key = path.split("/issue/")[1].split("?")[0]
            if key == "JP-903":
                return None
            return {"fields": {"status": {"statusCategory": {"key": statuses.get(key, "new")}}}}
        self.ep("sess-0007", "JP-903", unprompted=2)
        code, out = self.call(["headline", "--since", "2026-11-10", "--until", "2026-11-17", "--live"], fetch=fetch)
        self.assertEqual(code, 0)
        self.assertEqual({t["ticket"] for t in out["tickets"]}, {"JP-900", "JP-901"})
        self.assertEqual(out["status_unknown"], ["JP-903"])

    def test_given_keys_beat_nothing_and_are_not_read_again(self):
        self.seed()
        asked = []
        code, out = self.call(["headline", "--since", "2026-11-10", "--until", "2026-11-17",
                               "--finished", "JP-901, JP-902", "--live"], fetch=lambda p: asked.append(p) or None)
        self.assertEqual({t["ticket"] for t in out["tickets"]}, {"JP-900", "JP-901", "JP-902"})
        self.assertFalse([p for p in asked if "JP-901" in p or "JP-902" in p])


class FirstTime(Seeded):
    def test_signed_off_without_being_sent_back(self):
        self.graph_run("run-a", "JP-900")                                   # first time
        self.graph_run("run-b", "JP-901")                                   # signed off, then came back
        self.graph_run("run-c", "JP-901", previous="run-b", ended="2026-11-17T09:00:00Z",
                 started="2026-11-17T08:00:00Z")                      # the return: not first time itself
        self.graph_run("run-d", "JP-902", end="finished", score="neutral")  # not a sign-off
        self.audit("au-1", "https://example.test/o/r/pull/1", "review:ready-for-human", "2026-11-16T09:00:00Z",
                   "2026-11-16T09:30:00Z")
        self.audit("au-2", "https://example.test/o/r/pull/2", "review:changes-requested", "2026-11-16T09:00:00Z",
                   "2026-11-16T09:30:00Z")
        self.audit("au-3", "https://example.test/o/r/pull/2", "review:ready-for-human", "2026-11-16T12:00:00Z",
                   "2026-11-16T12:30:00Z")
        self.audit("au-4", "https://example.test/o/r/pull/3", "review:changes-requested", "2026-11-16T09:00:00Z",
                   "2026-11-16T09:30:00Z")                            # never signed off
        out = measures.first_time_signoff(self.conn, SINCE, UNTIL)
        self.assertEqual(out["ticket_runs"], {"signed_off": 3, "first_time": 1})
        self.assertEqual(out["prs"], {"signed_off": 2, "first_time": 1})
        self.assertEqual((out["signed_off"], out["first_time"], out["share"]), (5, 2, 0.4))

    def test_nothing_signed_off_is_no_share_not_zero(self):
        self.assertIsNone(measures.first_time_signoff(self.conn, SINCE, UNTIL)["share"])

    def test_only_sign_offs_inside_the_window_count(self):
        self.graph_run("run-a", "JP-900", ended="2026-10-01T10:00:00Z", started="2026-10-01T09:00:00Z")
        self.audit("au-1", "https://example.test/o/r/pull/1", "review:ready-for-human", "2026-10-01T09:00:00Z",
                   "2026-10-01T09:30:00Z")
        self.assertEqual(measures.first_time_signoff(self.conn, SINCE, UNTIL)["signed_off"], 0)


class SpendAndInstructions(Seeded):
    def test_spend_and_time_per_ticket(self):
        a = self.ep("sess-0001", "JP-900", extra={"seconds_working": 600, "seconds_waiting_on_josh": 60})
        b = self.ep("sess-0002", "JP-900", extra={"seconds_working": 100})
        c = self.ep("sess-0003", "JP-901", extra={"seconds_working": 5})
        self.cost(a, 1.5)
        self.cost(b, 0.25, status="partly-priced")
        self.cost(c, 9.0)
        out = measures.spend_per_ticket(self.conn, SINCE, UNTIL)
        first, second = out["rows"]
        self.assertEqual((first["ticket"], first["sessions"], first["cost_usd"]), ("JP-901", 1, 9.0))
        self.assertEqual((second["ticket"], second["sessions"], second["cost_usd"], second["fully_priced"]),
                         ("JP-900", 2, 1.75, False))
        self.assertEqual((second["seconds_working"], second["seconds_waiting_on_josh"]), (700, 60))
        self.assertEqual(out["cost_usd"], 10.75)

    def test_a_session_with_two_episodes_is_costed_once(self):
        a = self.ep("sess-0001", "JP-900")
        self.ep("sess-0001", "JP-900", episode=2, quiet="2026-11-16T10:00:00Z")
        self.cost(a, 2.0)
        row = measures.spend_per_ticket(self.conn, SINCE, UNTIL)["rows"][0]
        self.assertEqual((row["sessions"], row["cost_usd"]), (1, 2.0))

    def test_the_cost_of_a_graph_step_is_listed_under_its_ticket(self):
        a = self.ep("sess-0001", "JP-900")
        self.cost(a, 3.0)
        self.graph_run("run-a", "JP-900")
        step = self.conn.execute(
            "INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, session_uid, "
            "started_at, recorded_by) VALUES ('run-a', 'build', 'role', 1, 0, 'mid', 'r', ?, ?, 't')",
            (a, "2026-11-16T09:05:00Z")).lastrowid
        self.conn.execute("INSERT INTO step_results (step_run_id, outcome, model, session_uid, ended_at, recorded_by) "
                          "VALUES (?, 'done', 'm', ?, ?, 't')", (step, a, "2026-11-16T09:50:00Z"))
        self.assertEqual(measures.spend_per_ticket(self.conn, SINCE, UNTIL)["rows"][0]["graph_steps"],
                         [{"step": "build", "runs": 1, "cost_usd": 3.0}])

    def test_instruction_size_and_what_was_loaded_but_never_used(self):
        for n, size in enumerate((100, 300, 200)):
            uid = self.ep("sess-%04d" % n, "JP-900", extra={"instruction_bytes_loaded": size})
            for kind, name, uses in (("skill", "never-used", 0), ("skill", "used-once", 1 if n == 0 else 0),
                                     ("rule-file", "~/CLAUDE.md", 0)):
                self.conn.execute("INSERT INTO session_usage (session_uid, episode, item_kind, item_name, loaded, uses, "
                                  "recorded_at, recorded_by) VALUES (?, 1, ?, ?, 1, ?, ?, 't')",
                                  (uid, kind, name, uses, NOW))
        out = measures.instruction_size(self.conn, SINCE, UNTIL)
        self.assertEqual(out["bytes"], {"mean": 200, "median": 200, "max": 300})
        self.assertEqual(out["loaded_never_used"], [{"kind": "skill", "name": "never-used", "episodes_loaded": 3}])

    def test_no_sessions_is_no_size(self):
        self.assertIsNone(measures.instruction_size(self.conn, SINCE, UNTIL)["bytes"])


class Command(Seeded):
    def test_loose_ends_say_they_wait_for_jp_109(self):
        code, out = self.call(["loose-ends"])
        self.assertEqual(code, 0)
        self.assertIn("JP-109", out["reason"])

    def test_all_runs_every_measure(self):
        code, out = self.call(["all"])
        self.assertEqual((code, sorted(out)), (0, ["headline", "instructions", "loose-ends", "spend"]))

    def test_the_default_window_is_the_last_28_days(self):
        code, out = self.call(["first-time"])
        self.assertEqual((out["since"], out["until"]), ("2026-10-20T12:00:01Z", "2026-11-17T12:00:01Z"))

    def test_bad_input_and_a_missing_ledger_exit_2(self):
        with self.assertRaises(SystemExit) as caught:
            measures.main(["headline", "--since", "yesterday"], io.StringIO(), self.path)
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(self.call(["headline", "--since", "2026-11-17", "--until", "2026-11-01"])[0], 2)
        self.assertEqual(measures.main(["first-time"], io.StringIO(), self.tmp / "none.db"), 2)

    def test_it_only_reads(self):
        conn = measures.open_read_only(self.path)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM machines")
        conn.close()

    def test_answers_hold_numbers_and_codes_not_text(self):
        Headline.seed(self)
        code, out = self.call(["headline", "--since", "2026-11-10", "--until", "2026-11-17"])
        flat = json.dumps(out)
        for needle in ("title", "message text", "command"):
            self.assertNotIn(needle, flat)


if __name__ == "__main__":
    unittest.main()
