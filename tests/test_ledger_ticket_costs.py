"""JP-170: what a ticket's sessions cost, step by step, with subagents rolled into the step that started them.
Made-up sessions, tickets and runs only (JP-900 and up, sess-0001 and up)."""
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_ledger_measures as tm  # noqa: E402
from ledger_helpers import NOW  # noqa: E402
from ledger import db, measures  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class Costs(tm.Seeded):
    """A ledger with run `run-1` of graph `dev` on JP-900, and helpers to give it steps, subagents and costs."""

    def step(self, run, step, sid, attempt=1, loop=0, kind="role", started="2026-11-16T09:10:00Z", model="m-1"):
        """One step attempt done by session `sid` (None: a gate, which has no session)."""
        uid = self.uid(sid) if sid else None
        if uid and not self.rows("SELECT 1 FROM sessions WHERE session_uid = ?", (uid,)):
            self.session(sid)
        row = self.conn.execute(
            "INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, session_uid, started_at, recorded_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 't')",
            (run, step, kind, attempt, loop, "mid" if kind == "role" else None, uid, started)).lastrowid
        self.conn.execute("INSERT INTO step_results (step_run_id, outcome, model, session_uid, ended_at, recorded_by) "
                          "VALUES (?, 'done', ?, ?, ?, 't')", (row, model, uid, started))
        return uid

    def child(self, child_sid, parent_sid, kind="subagent", root_sid=None):
        for sid in (child_sid, parent_sid, root_sid):
            if sid and not self.rows("SELECT 1 FROM sessions WHERE session_uid = ?", (self.uid(sid),)):
                self.session(sid)
        self.conn.execute(
            "INSERT INTO session_lineage (child_uid, parent_uid, root_uid, kind, confidence, discovered_at, recorded_by) "
            "VALUES (?, ?, ?, ?, 'confirmed', ?, 't')",
            (self.uid(child_sid), self.uid(parent_sid), self.uid(root_sid or parent_sid), kind, NOW))

    def priced(self, sid, usd, status="priced"):
        uid = self.uid(sid)
        if not self.rows("SELECT 1 FROM sessions WHERE session_uid = ?", (uid,)):
            self.session(sid)
        self.cost(uid, usd, status)

    def home(self, sid, ticket):
        """Home session `sid` to `ticket` by its branch, whether or not it already has a row."""
        uid = self.uid(sid)
        if not self.rows("SELECT 1 FROM sessions WHERE session_uid = ?", (uid,)):
            self.session(sid)
        if not self.rows("SELECT 1 FROM session_episodes WHERE session_uid = ?", (uid,)):
            self.conn.execute(
                "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
                "folder, recorded_at, recorded_by) VALUES (?, 1, ?, ?, ?, 'quiet', '/tmp/made-up/josh_360', ?, 't')",
                (uid, tm.INSIDE, tm.INSIDE, tm.INSIDE, tm.INSIDE))
        self.conn.execute(
            "INSERT INTO session_homes (session_uid, episode, method, tracker, ticket_key, epic_key, system, priority, "
            "evidence, conventions_version, jira_read, derived_at, recorded_by) VALUES (?, 1, 'branch', 'jira', ?, "
            "'JP-94', 'josh-360', 'epicprio', 'e', 'abc', 'ok', ?, 't')", (uid, ticket, tm.INSIDE))

    def text(self, *argv):
        out = io.StringIO()
        code = measures.main(list(argv), out, self.path, now=NOW)
        return code, out.getvalue()

    def data(self, key="JP-900"):
        code, out = self.text("ticket", key, "--json")
        self.assertEqual(code, 0)
        return json.loads(out)

    def row(self, data, session):
        found = [r for r in data["rows"] if r["session"] == session]
        self.assertEqual(len(found), 1, "{} rows for {}".format(len(found), session))
        return found[0]


class Listing(Costs):
    def seed(self):
        self.graph_run("run-1", "JP-900")
        self.step("run-1", "plan", "sess-0001", started="2026-11-16T09:10:00Z")
        self.step("run-1", "build", "sess-0002", started="2026-11-16T09:20:00Z")
        self.home("sess-0003", "JP-900")                              # homed by its branch, did no step
        self.priced("sess-0001", 1.20)
        self.priced("sess-0002", 3.40)
        self.priced("sess-0003", 0.75)

    def test_every_session_is_listed_with_its_step_and_cost(self):
        self.seed()
        code, out = self.text("ticket", "JP-900")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        plan = [l for l in lines if "sess-0001" in l][0]
        build = [l for l in lines if "sess-0002" in l][0]
        other = [l for l in lines if "sess-0003" in l][0]
        self.assertIn("plan", plan)
        self.assertIn("$1.20", plan)
        self.assertIn("build", build)
        self.assertIn("$3.40", build)
        self.assertIn("not a graph step", other)
        self.assertIn("$0.75", other)
        self.assertIn("$5.35 for 3 sessions", out)
        self.assertLess(out.index("sess-0001"), out.index("sess-0002"))       # steps in start order ...
        self.assertLess(out.index("sess-0002"), out.index("sess-0003"))       # ... then sessions that did no step

    def test_json_has_the_same_rows_and_the_total(self):
        self.seed()
        data = self.data()
        self.assertEqual([r["session"] for r in data["rows"]], ["sess-0001", "sess-0002", "sess-0003"])
        build = self.row(data, "sess-0002")
        self.assertEqual((build["graph"], build["step"], build["attempt"], build["model"]), ("dev", "build", 1, "m-1"))
        self.assertEqual((build["own_usd"], build["subagents_usd"], build["total_usd"]), (3.4, 0.0, 3.4))
        self.assertIsNone(self.row(data, "sess-0003")["step"])
        self.assertEqual((data["total_usd"], data["sessions"], data["not_priced"], data["partly_priced"]), (5.35, 3, 0, 0))

    def test_a_ticket_with_no_sessions_says_so(self):
        self.seed()
        code, out = self.text("ticket", "JP-999")
        self.assertEqual((code, out.strip()), (0, "No sessions recorded for JP-999"))
        empty = self.data("JP-999")
        self.assertEqual((empty["rows"], empty["sessions"], empty["total_usd"]), ([], 0, 0.0))

    def test_a_gate_has_no_session_and_is_not_listed(self):
        self.seed()
        self.step("run-1", "mark_ready", None, kind="gate")
        self.assertEqual(len(self.data()["rows"]), 3)

    def test_another_tickets_sessions_are_not_listed(self):
        self.seed()
        self.graph_run("run-2", "JP-901")
        self.step("run-2", "plan", "sess-0004")
        self.home("sess-0005", "JP-901")
        self.priced("sess-0004", 9.0)
        data = self.data()
        self.assertEqual(sorted(r["session"] for r in data["rows"]), ["sess-0001", "sess-0002", "sess-0003"])

    def test_a_session_that_did_a_step_on_another_ticket_is_listed_only_there(self):
        self.seed()
        self.graph_run("run-2", "JP-901")
        self.step("run-2", "plan", "sess-0004")
        self.priced("sess-0004", 2.0)
        self.home("sess-0004", "JP-900")          # homed here by its branch, but its step belongs to JP-901's run
        self.assertNotIn("sess-0004", [r["session"] for r in self.data()["rows"]])
        self.assertIn("sess-0004", [r["session"] for r in self.data("JP-901")["rows"]])

    def test_a_session_that_did_two_attempts_is_counted_once(self):
        self.seed()
        self.step("run-1", "build", "sess-0002", attempt=2, started="2026-11-16T09:30:00Z")
        data = self.data()
        builds = [r for r in data["rows"] if r["step"] == "build"]
        self.assertEqual([r["attempt"] for r in builds], [1, 2])
        self.assertEqual(builds[0]["total_usd"], 3.4)
        self.assertIsNone(builds[1]["total_usd"])
        self.assertEqual(builds[1]["same_session_as"], "build #1")
        self.assertEqual((data["total_usd"], data["sessions"]), (5.35, 3))
        self.assertIn("same session as build #1", self.text("ticket", "JP-900")[1])

    def test_a_key_that_is_not_a_ticket_is_refused(self):
        self.seed()
        code, _ = self.text("ticket", "not a key")
        self.assertEqual(code, 2)
        self.assertEqual(self.text("ticket")[0], 2)


class Subagents(Costs):
    def seed(self):
        self.graph_run("run-1", "JP-900")
        self.step("run-1", "build", "sess-0002")
        self.priced("sess-0002", 3.40)
        self.priced("sess-0020", 0.60)                                    # the subagent S2a
        self.child("sess-0020", "sess-0002")

    def test_a_subagent_counts_toward_the_step_that_started_it(self):
        self.seed()
        data = self.data()
        build = self.row(data, "sess-0002")
        self.assertEqual((build["own_usd"], build["subagents_usd"], build["total_usd"], build["subagents"]),
                         (3.4, 0.6, 4.0, 1))
        self.assertNotIn("sess-0020", [r["session"] for r in data["rows"]])
        self.assertEqual((data["total_usd"], data["sessions"]), (4.0, 1))
        out = self.text("ticket", "JP-900")[1]
        self.assertNotIn("sess-0020", out)
        self.assertIn("$4.00", out)

    def test_a_subagent_homed_to_the_ticket_is_still_not_a_row(self):
        self.seed()
        self.home("sess-0020", "JP-900")
        data = self.data()
        self.assertEqual([r["session"] for r in data["rows"]], ["sess-0002"])
        self.assertEqual(data["total_usd"], 4.0)

    def test_a_subagent_whose_top_session_is_on_another_ticket_is_not_counted_here(self):
        self.seed()
        self.home("sess-0030", "JP-901")                                    # its top session belongs to JP-901
        self.priced("sess-0031", 5.0)
        self.child("sess-0031", "sess-0030")
        self.home("sess-0031", "JP-900")                                    # but the subagent itself is homed here
        data = self.data()
        self.assertEqual([r["session"] for r in data["rows"]], ["sess-0002"])
        self.assertEqual(data["total_usd"], 4.0)

    def test_a_nested_subagent_rolls_up_to_the_step_session_once(self):
        self.seed()
        self.priced("sess-0021", 0.25)                                    # S2b, started by S2a
        self.child("sess-0021", "sess-0020", root_sid="sess-0002")
        build = self.row(self.data(), "sess-0002")
        self.assertEqual((build["subagents"], build["subagents_usd"], build["total_usd"]), (2, 0.85, 4.25))
        self.assertEqual(self.data()["total_usd"], 4.25)

    def test_a_resume_is_a_session_of_its_own_not_a_subagent(self):
        self.seed()
        self.home("sess-0040", "JP-900")
        self.priced("sess-0040", 0.5)
        self.child("sess-0040", "sess-0002", kind="resume")
        data = self.data()
        self.assertEqual(self.row(data, "sess-0002")["total_usd"], 4.0)
        self.assertEqual(self.row(data, "sess-0040")["total_usd"], 0.5)
        self.assertEqual((data["total_usd"], data["sessions"]), (4.5, 2))

    def test_a_subagent_of_a_resume_rolls_up_to_the_resume_not_the_first_session(self):
        self.seed()
        self.home("sess-0040", "JP-900")
        self.priced("sess-0040", 0.5)
        self.child("sess-0040", "sess-0002", kind="resume")
        self.priced("sess-0041", 0.1)
        self.child("sess-0041", "sess-0040", root_sid="sess-0002")        # root_uid climbs through the resume
        data = self.data()
        self.assertEqual(self.row(data, "sess-0002")["subagents_usd"], 0.6)
        self.assertEqual(self.row(data, "sess-0040")["subagents_usd"], 0.1)

    def test_a_lineage_loop_does_not_hang(self):
        self.seed()
        self.child("sess-0002", "sess-0020")                              # a made-up cycle
        self.assertEqual(self.text("ticket", "JP-900")[0], 0)


class Pricing(Costs):
    def seed(self):
        self.graph_run("run-1", "JP-900")
        self.step("run-1", "plan", "sess-0001")
        self.priced("sess-0001", 1.20)
        self.step("run-1", "review", "sess-0004", started="2026-11-16T09:40:00Z")      # no cost rows yet

    def test_a_session_not_priced_yet_is_marked_and_counted(self):
        self.seed()
        out = self.text("ticket", "JP-900")[1]
        review = [l for l in out.splitlines() if "sess-0004" in l][0]
        self.assertIn("not priced yet", review)
        self.assertNotIn("$0", review)
        self.assertIn("$1.20 for 2 sessions", out)
        self.assertIn("1 session not priced yet", out)
        data = self.data()
        self.assertIsNone(self.row(data, "sess-0004")["total_usd"])
        self.assertEqual(self.row(data, "sess-0004")["pricing"], "unpriced")
        self.assertEqual((data["not_priced"], data["partly_priced"]), (1, 0))

    def test_an_unpriced_cost_row_is_not_priced_either(self):
        self.seed()
        self.priced("sess-0004", None, "unpriced")
        self.assertEqual(self.row(self.data(), "sess-0004")["pricing"], "unpriced")

    def test_a_partly_priced_session_shows_its_cost_with_a_mark(self):
        self.seed()
        self.priced("sess-0004", 0.8, "partly-priced")
        out = self.text("ticket", "JP-900")[1]
        self.assertIn("$0.80 (partly priced)", out)
        self.assertIn("1 partly priced", out)
        self.assertNotIn("not priced yet", out)
        data = self.data()
        self.assertEqual((data["not_priced"], data["partly_priced"], data["total_usd"]), (0, 1, 2.0))

    def test_an_unpriced_subagent_makes_its_parent_partly_priced(self):
        self.seed()
        self.priced("sess-0004", 0.8)
        self.child("sess-0050", "sess-0004")                              # a subagent with no cost rows yet
        row = self.row(self.data(), "sess-0004")
        self.assertEqual((row["pricing"], row["total_usd"], row["subagents"]), ("partly-priced", 0.8, 1))

    def test_a_priced_subagent_alone_makes_the_parent_partly_priced(self):
        self.seed()
        self.priced("sess-0050", 0.4)
        self.child("sess-0050", "sess-0004")
        row = self.row(self.data(), "sess-0004")
        self.assertEqual((row["pricing"], row["total_usd"]), ("partly-priced", 0.4))


class StepCostsElsewhere(Costs):
    def seed(self):
        self.graph_run("run-1", "JP-900")
        self.step("run-1", "build", "sess-0002")
        self.home("sess-0002", "JP-900")
        self.priced("sess-0002", 3.40)
        self.priced("sess-0020", 0.60)
        self.child("sess-0020", "sess-0002")

    def test_the_new_view_rolls_subagents_into_the_step_and_the_old_one_does_not(self):
        self.seed()
        rolled = self.rows("SELECT cost_usd, own_cost_usd, subagent_cost_usd FROM step_costs_rolled_up WHERE step = 'build'")
        self.assertEqual([tuple(round(v, 2) for v in r) for r in rolled], [(4.0, 3.4, 0.6)])
        self.assertEqual(round(self.rows("SELECT cost_usd FROM step_costs WHERE step = 'build'")[0][0], 2), 3.4)

    def test_spend_shows_the_step_with_its_subagents(self):
        self.seed()
        out = measures.spend_per_ticket(self.conn, tm.SINCE, tm.UNTIL)
        steps = out["rows"][0]["graph_steps"]
        self.assertEqual([(s["step"], s["cost_usd"]) for s in steps], [("build", 4.0)])

    def test_a_gate_costs_nothing_and_has_no_cost_in_the_view(self):
        self.seed()
        self.step("run-1", "mark_ready", None, kind="gate")
        self.assertIsNone(self.rows("SELECT cost_usd FROM step_costs_rolled_up WHERE step = 'mark_ready'")[0][0])


class AgentsStillCannotReadCost(Costs):
    def test_no_ask_query_returns_a_cost_figure(self):
        from ledger import ask
        self.graph_run("run-1", "JP-900")
        self.step("run-1", "build", "sess-0002")
        self.home("sess-0002", "JP-900")
        self.priced("sess-0002", 3.40)
        for argv in (["home", "--session", "sess-0002"], ["ticket", "--key", "JP-900"], ["run", "--run", "run-1"],
                     ["find", "--folder", "/tmp/made-up/josh_360"], ["changes", "--system", "josh-360"]):
            out = io.StringIO()
            ask.main(argv, out, self.path)
            self.assertNotIn("3.4", out.getvalue(), argv)
            self.assertNotIn("cost", out.getvalue().lower(), argv)

    def test_the_ticket_command_is_in_measures_not_in_ask(self):
        from ledger import ask
        self.assertNotIn("measures", Path(ask.__file__).read_text(encoding="utf-8"))
        self.assertNotIn("step_costs_rolled_up", Path(ask.__file__).read_text(encoding="utf-8"))
        self.assertNotIn("session_costs_rolled_up", Path(ask.__file__).read_text(encoding="utf-8"))


class MigrationIsAddOnly(Costs):
    def test_the_migration_only_adds_and_the_ledger_is_at_its_version(self):
        sql = (ROOT / "ledger" / "migrations" / "0002-step-costs-rolled-up.sql").read_text(encoding="utf-8")
        db.check_migration(sql)                                            # raises when it rewrites anything
        self.assertEqual(db.user_version(self.conn), db.newest_version())
        self.assertGreaterEqual(db.newest_version(), 2)

    def test_the_views_exist(self):
        names = {r[0] for r in self.rows("SELECT name FROM sqlite_master WHERE type = 'view'")}
        self.assertTrue({"session_subagent_roots", "session_costs_rolled_up", "step_costs_rolled_up", "step_costs"} <= names)


if __name__ == "__main__":
    unittest.main()
