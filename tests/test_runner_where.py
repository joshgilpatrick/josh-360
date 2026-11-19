"""JP-172: `runner.py where <KEY>`, the published report's `tickets` list, and the refusals the Jira watch keeps.

Made-up tickets, sessions and prices only. The fixture graph `valid` maps `build` to Jira status In Progress and has
`approve_spec` as a question to Josh, so it stands in for the development graph."""
import io
import json
import time
import unittest

from runner_helpers import RunnerCase, db, runfolder
from runner_lib import refusals, status, watch, where
import runner

AM = ("--runner", "agent-manager")
NOW = "2026-11-17T12:00:00Z"
REASON = "the ticket is in Ready, not Not Started"


class Where(RunnerCase):
    def conn(self):
        return db.connect(db.ledger_path())

    def ask(self, key, *extra):
        out = io.StringIO()
        code = runner.main(["where", key, "--graphs-root", str(self.root)] + list(extra), out)
        return code, out.getvalue()

    def snap(self, now=None):
        conn = self.conn()
        try:
            return status.snapshot(conn, time.time() if now is None else now, self.root)
        finally:
            conn.close()

    def price(self, session_id, usd):
        conn = self.conn()
        try:
            uid = conn.execute("SELECT session_uid FROM sessions WHERE tool_session_id = ?", (session_id,)).fetchone()[0]
            conn.execute("INSERT INTO session_costs (session_uid, computed_at, model, cost_usd, pricing_status, price_set, "
                         "recorded_by) VALUES (?, ?, 'm', ?, 'priced', '1', 't')", (uid, NOW, usd))
            conn.commit()
        finally:
            conn.close()

    def mid_build(self, key="JP-900"):
        """A run at step build, attempt 2: design done (priced), build attempt 1 abandoned, attempt 2 asked for."""
        run = self.start("valid", key, *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"}, session="sess-0101", model="claude-opus-5-5")
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        self.answer_in_app(run, "approve_spec", "build")
        self.assertEqual(self.walker("next", "--run", run)["step"], "build")
        self.walker("abandon", "--run", run)
        out = self.walker("next", "--run", run)
        self.assertEqual((out["step"], out.get("attempt")), ("build", 2), out)
        self.price("sess-0101", 4.10)
        return run

    # -- Scenario: A ticket mid-run ------------------------------------------------------------------------------
    def test_a_ticket_mid_run(self):
        run = self.mid_build()
        code, out = self.ask("JP-900", "--json")
        self.assertEqual(code, 0, out)
        answer = json.loads(out)
        self.assertEqual(len(answer["runs"]), 1)
        got = answer["runs"][0]
        self.assertEqual((got["run"], got["graph"], got["step"], got["step_label"], got["jira_status"], got["attempt"]),
                         (run, "valid", "build", "Build", "In Progress", 2))
        design = [s for s in got["sessions"] if s["step"] == "design"][0]
        self.assertEqual((design["model"], design["session"], design["cost_usd"]), ("claude-opus-5-5", "sess-0101", 4.1))
        self.assertEqual(answer["cost_usd"], 4.1)
        code, text = self.ask("JP-900")
        self.assertIn("At Build (`build`), attempt 2, Jira status In Progress", text)
        self.assertIn("| design | 1 |", text)
        self.assertIn("claude-opus-5-5", text)
        self.assertIn("$4.10", text)
        self.assertIn("Total cost on JP-900: $4.10", text)

    def test_a_session_on_several_steps_is_counted_once_in_the_total(self):
        run = self.finished_run_one_session()
        answer = json.loads(self.ask("JP-905", "--json")[1])
        builds = [s for s in answer["runs"][0]["sessions"] if s["session"] == "sess-0001"]
        self.assertGreater(len(builds), 1)
        self.assertEqual({s["cost_usd"] for s in builds}, {2.5})
        self.assertEqual(answer["cost_usd"], 2.5)
        self.assertEqual(answer["runs"][0]["run"], run)

    def finished_run_one_session(self):
        run = self.start("valid", "JP-905", *AM)
        model = {"session": "sess-0001", "model": "claude-sonnet-5-5"}
        self.do_role(run, "design", "ready", {"spec_path": "s"}, **model)
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        self.answer_in_app(run, "approve_spec", "build")
        self.do_role(run, "build", "done", **model)
        self.price("sess-0001", 2.5)
        return run

    # -- Scenario: A ticket waiting on Josh ----------------------------------------------------------------------
    def test_a_ticket_waiting_on_josh(self):
        run = self.start("valid", "JP-901", *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        code, out = self.ask("JP-901", "--json")
        got = json.loads(out)["runs"][0]
        self.assertEqual((got["state"], got["step"]), ("parked", "approve_spec"))
        self.assertEqual(got["waits_on"]["kind"], "question")
        self.assertTrue(got["waits_on"]["since"])
        code, text = self.ask("JP-901")
        self.assertIn("Waiting on a question to Josh, since " + got["waits_on"]["since"], text)

    def test_a_waiting_run_names_what_it_waits_for(self):
        self.plan({"pr-state": [{"outcome": "pending", "summary": "waiting on a person"}]})
        run = self.start("waits", "JP-903", *AM)
        self.do_role(run, "zeta", "ready", {"note": "n"})
        self.do_role(run, "alpha", "done", {"note": "n"})
        self.assertEqual(self.walker("next", "--run", run)["action"], "waiting")
        got = json.loads(self.ask("JP-903", "--json")[1])["runs"][0]
        self.assertEqual((got["state"], got["waits_on"]["kind"], got["waits_on"]["text"]),
                         ("waiting", "check", "the pr-state check"))

    def test_a_run_stopped_at_its_cap_says_so(self):
        self.plan({"lint-spec": ["crash"]})
        run = self.start("valid", "JP-904", *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", run)["action"], "stopped")     # lint-spec crashes (scripted)
        got = json.loads(self.ask("JP-904", "--json")[1])["runs"][0]
        self.assertEqual((got["state"], got["waits_on"]["kind"]), ("stopped", "stop"))
        doc = runfolder.load(run)
        doc["stopped"]["reason"] = "step 'build' has run as often as its tier allows (2 runs) and no ..."
        runfolder.save(run, doc)
        got = json.loads(self.ask("JP-904", "--json")[1])["runs"][0]
        self.assertEqual(got["waits_on"]["kind"], "cap")

    def setUp(self):
        super().setUp()
        self.plan({"lint-spec": ["pass"]})

    # -- Scenario: A ticket with no run --------------------------------------------------------------------------
    def test_a_ticket_with_no_run(self):
        code, out = self.ask("JP-902")
        self.assertEqual(code, 0)
        self.assertEqual(out, "No graph has run on JP-902.\n")
        code, out = self.ask("JP-902", "--json")
        self.assertEqual((code, json.loads(out)["runs"]), (0, []))

    def test_a_key_that_is_not_a_ticket_key_is_refused(self):
        code, out = self.ask("jp 902; rm")
        self.assertEqual(code, 2)
        self.assertIn("not a ticket key", json.loads(out)["error"])

    def test_every_run_is_listed_newest_first(self):
        first = self.end_sample_run("JP-905")
        second = self.start("valid", "JP-905", *AM)
        runs = json.loads(self.ask("JP-905", "--json")[1])["runs"]
        self.assertEqual([r["run"] for r in runs], [second, first])
        self.assertEqual((runs[1]["state"], runs[1]["end"]), ("ended", "confirm.stop"))
        self.assertFalse(runs[1]["step"].startswith("_"))          # the step it ended at, not the exit gate

    # -- Scenario: A refused start is explained in the cloud -----------------------------------------------------
    def test_a_refused_start_is_explained_in_the_cloud(self):
        refusals.record("triage", "JP-903", REASON)
        snap = json.loads(json.dumps(self.snap()))
        rows = [r for r in snap["tickets"] if r["ticket"] == "JP-903"]
        self.assertEqual(len(rows), 1)
        self.assertEqual([(i["graph"], i["reason"]) for i in rows[0]["refused"]], [("triage", REASON)])
        self.assertFalse([k for k in rows[0] if "cost" in k])
        self.assertEqual(snap["ticket_counts"]["refused"], 1)
        self.assertIn("Refused: JP-903 triage", status.text(snap))
        path = self.tmp / "snap.json"
        path.write_text(json.dumps(snap))
        code, text = self.ask("JP-903", "--from-json", str(path))
        self.assertEqual(code, 0)
        self.assertIn("Refused: triage would not start", text)
        self.assertIn(REASON, text)

    def test_the_watch_keeps_a_refusal_and_clears_it_when_a_run_starts(self):
        self.jira_issue("JP-906")
        with unittest.mock.patch.object(watch.walk, "call", side_effect=watch.walk.WalkerRefused("x" * 300)):
            self.tick_watch()
        found = refusals.current(time.time(), "JP-906")
        self.assertEqual([(r["graph"], len(r["reason"])) for r in found], [("runner-sample", 200)])
        with unittest.mock.patch.object(watch.walk, "call", return_value={"run": "r-1"}):
            self.tick_watch()
        self.assertEqual(refusals.current(time.time(), "JP-906"), [])

    def tick_watch(self):
        rules = {"per_pass": 1, "graphs": {"runner-sample": {
            "on": True, "jql": "project = JP", "route": "runner-sample", "inputs": {"system": "route.system"}}}}
        conn = self.conn()
        try:
            from lib.jira import Jira
            return watch.watch(conn, Jira.from_env(dict(__import__("os").environ)), rules, self.root)
        finally:
            conn.close()

    def test_a_refusal_keeps_its_first_time_and_ages_out(self):
        start = time.time()
        refusals.record("triage", "JP-903", REASON, now=start)
        refusals.record("triage", "JP-903", REASON, now=start + 600)
        row = refusals.current(start + 600, "JP-903")[0]
        self.assertLess(row["first_at"], row["last_at"])
        self.assertEqual(refusals.current(start + 15 * 86400, "JP-903"), [])

    def test_an_unreadable_refusals_file_is_unknown_not_empty(self):
        refusals.path().parent.mkdir(parents=True, exist_ok=True)
        refusals.path().write_text("{not json")
        self.assertIsNone(refusals.current(time.time()))
        snap = self.snap()
        self.assertFalse(snap["ticket_counts"]["refusals_readable"])
        self.assertEqual(json.loads(self.ask("JP-903", "--json")[1])["refused"], "unreadable")

    # -- Scenario: The cloud copy never carries cost -------------------------------------------------------------
    def test_the_cloud_copy_never_carries_cost(self):
        self.mid_build()
        snap = self.snap()
        self.assertEqual(snap["ticket_counts"]["cost_fields"], 0)
        published = dict(snap, ticket_counts={k: v for k, v in snap["ticket_counts"].items() if k != "cost_fields"})
        self.assertNotIn("cost", json.dumps(published).lower())
        self.assertNotIn("4.1", json.dumps(snap))
        row = [r for r in snap["tickets"] if r["ticket"] == "JP-900"][0]
        self.assertEqual((row["step"], row["jira_status"], row["attempt"]), ("build", "In Progress", 2))
        self.assertEqual(snap["ticket_counts"]["listed"], 1)

    def test_the_cost_counter_counts_cost_keys(self):
        self.assertEqual(where.cost_fields({"a": [{"cost_usd": 1}], "ticket_counts": {"cost_fields": 0}}), 1)
        self.assertEqual(where.cost_fields({"ticket_counts": {"cost_fields": 0, "listed": 1}}), 0)

    def test_a_published_row_holds_no_text_from_the_run(self):
        run = self.start("valid", "JP-907", *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.plan({"lint-spec": ["crash"]})
        self.walker("next", "--run", run)
        doc = runfolder.load(run)
        doc["stopped"]["reason"] = "ZEBRA went wrong"
        runfolder.save(run, doc)
        self.assertNotIn("ZEBRA", json.dumps(self.snap()))
        self.assertIn("ZEBRA", self.ask("JP-907")[1])          # the laptop's own answer may show it

    def test_from_a_published_report_with_no_row(self):
        path = self.tmp / "snap.json"
        path.write_text(json.dumps(self.snap()))
        self.assertEqual(self.ask("JP-902", "--from-json", str(path))[1], "No graph has run on JP-902.\n")


import unittest.mock  # noqa: E402

if __name__ == "__main__":
    unittest.main()
