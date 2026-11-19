"""JP-117, Task 4: the start rules (graphs/runner/starts.json) against a made-up Jira and the real walker."""
import json
import unittest
from pathlib import Path

import yaml

from runner_helpers import ROOT, RunnerCase, db, runfolder
from runner_lib import watch

SHIPPED = ROOT / "graphs" / "runner" / "starts.json"
RULE = json.loads(SHIPPED.read_text())["graphs"]["development"]
VALIDATION = json.loads(SHIPPED.read_text())["graphs"]["validation"]


class WatchBase(RunnerCase):
    def conn(self):
        return db.connect(db.ledger_path())

    def watch(self, jira="default", rules=None):
        conn = self.conn()
        try:
            client = watch.jira_client(dict(__import__("os").environ)) if jira == "default" else jira
            return watch.watch(conn, client, rules or self.rules, root=self.root)
        finally:
            conn.close()

    def runs(self):
        conn = self.conn()
        try:
            return conn.execute("SELECT run_id, runner, phi, ticket_key FROM graph_runs ORDER BY id").fetchall()
        finally:
            conn.close()



class Watching(WatchBase):
    def setUp(self):
        super().setUp()
        rule = dict(RULE, route="runner-sample")
        self.rules = {"per_pass": 1, "graphs": {"runner-sample": rule}}

    def test_ready_with_the_run_label_starts_a_run(self):
        self.jira_issue("JP-901")
        got = self.watch()
        self.assertEqual(got, {"runner-sample": {"jira": "ok", "started": ["JP-901"], "skipped": {}}})
        rows = self.runs()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0][1], rows[0][2], rows[0][3]), ("agent-manager", 1, "JP-901"))
        inputs = runfolder.load(rows[0][0])["inputs"]
        self.assertEqual((inputs["ticket_type"], inputs["system"], inputs["resume_from"], inputs["phi"]),
                         ("Story", "sample", "none", True))

    def test_ready_without_the_run_label_starts_nothing(self):
        self.jira_issue("JP-901", queued=False)
        got = self.watch()
        self.assertEqual(got["runner-sample"]["started"], [])
        self.assertEqual(self.runs(), [])

    def test_failed_search_starts_and_ends_nothing(self):
        run = self.start("runner-sample", "JP-950")
        before = self.step_rows(run)
        self.jira_issue("JP-901")
        self.jira_state(search_fails=True)
        got = self.watch()
        self.assertEqual(got, {"runner-sample": {"jira": "unknown", "started": [], "skipped": {}}})
        self.assertEqual(len(self.runs()), 1)
        self.assertEqual(self.step_rows(run), before)

    def test_build_inputs(self):
        mapping = RULE["inputs"]
        issue = {"fields": {"issuetype": {"name": "Bug"}}}
        route = {"system": "atlas", "returned_from": ""}
        self.assertEqual(watch.build_inputs(mapping, issue, route, None, None),
                         {"ticket_type": "Bug", "system": "atlas", "resume_from": "none", "phi": "true"})
        self.assertEqual(watch.build_inputs(mapping, issue, route, {"phi_risk": False}, None)["phi"], "false")
        with self.assertRaises(watch.MissingInput) as caught:
            watch.build_inputs(mapping, issue, {"returned_from": ""}, None, None)
        self.assertEqual(str(caught.exception), "system")

    def test_shipped_rule_names_only_inputs_the_development_graph_has(self):
        graph = yaml.safe_load((ROOT / "graphs" / "flows" / "development.yaml").read_text())
        have = graph["inputs"]
        self.assertTrue(set(RULE["inputs"]) <= set(have))
        required = {n for n, spec in have.items() if spec.get("required") and n != "ticket_key"}
        self.assertTrue(required <= set(RULE["inputs"]))

    def test_shipped_rule_names_the_label_the_triage_graph_knows(self):
        from lib.triage import RUN_LABEL
        self.assertIn('labels = "{}"'.format(RUN_LABEL), RULE["jql"])
        self.assertNotIn("sprint", RULE["jql"].lower())

    def test_one_run_per_pass_in_rank_order(self):
        for key in ("JP-901", "JP-902", "JP-903"):
            self.jira_issue(key)
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-901"])
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-902"])

    def test_ticket_with_an_open_run_is_skipped(self):
        self.jira_issue("JP-901")
        self.start("runner-sample", "JP-901")
        self.assertEqual(self.watch()["runner-sample"]["skipped"], {"JP-901": "has an open run"})

    def test_no_route_record_is_skipped_and_does_not_block_the_next(self):
        self.jira_issue("JP-901", route=None)
        self.jira_issue("JP-902")
        got = self.watch()["runner-sample"]
        self.assertEqual((got["started"], got["skipped"]), (["JP-902"], {"JP-901": "no route record"}))

    def test_routed_elsewhere_is_skipped(self):
        self.jira_issue("JP-901", route={"graph": "non-development", "system": "sample", "returned_from": ""})
        self.assertEqual(self.watch()["runner-sample"]["skipped"], {"JP-901": "routed elsewhere"})

    def test_spec_that_is_not_an_object_is_skipped(self):
        self.jira_issue("JP-901", spec=["not", "an", "object"])
        self.assertEqual(self.watch()["runner-sample"]["skipped"], {"JP-901": "spec does not parse"})

    def test_missing_input_with_no_default_is_skipped(self):
        self.jira_issue("JP-901", route={"graph": "runner-sample", "returned_from": ""})
        self.assertEqual(self.watch()["runner-sample"]["skipped"], {"JP-901": "missing input system"})

    def test_returned_ticket_resumes_from_its_last_run(self):
        old = self.end_sample_run("JP-901")
        self.jira_issue("JP-901", route={"graph": "runner-sample", "system": "sample", "returned_from": "10042"})
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-901"])
        new = [r for r in self.runs() if r[0] != old][0][0]
        self.assertEqual(runfolder.load(new)["inputs"]["resume_from"], old)

    def test_not_returned_starts_with_no_resume(self):
        self.end_sample_run("JP-901")
        self.jira_issue("JP-901")
        self.watch()
        new = self.runs()[-1][0]
        self.assertEqual(runfolder.load(new)["inputs"]["resume_from"], "none")

    def test_refused_start_is_tried_again_next_pass(self):
        self.jira_issue("JP-901")
        self.plan({"ready": ["no", "pass"]})
        first = self.watch()["runner-sample"]
        self.assertEqual((first["started"], first["skipped"]), ([], {"JP-901": "not admitted"}))
        self.assertEqual(self.runs(), [])
        self.assertEqual(list(Path(self.tmp / "runs").glob("r-*")), [])
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-901"])

    def test_rules_file_is_checked(self):
        bad = self.tmp / "starts.json"
        bad.write_text(json.dumps({"per_pass": 1, "graphs": {"development": {"on": True, "route": "development"}}}))
        with self.assertRaises(ValueError) as caught:
            watch.load_rules(bad)
        self.assertIn("development", str(caught.exception))
        shipped = watch.load_rules(SHIPPED)
        self.assertEqual([g for g, r in shipped["graphs"].items() if r.get("on")], ["development", "validation"])

    def test_credentials_come_from_the_email_file_and_the_keychain_when_the_environment_has_none(self):
        from types import SimpleNamespace
        from laptop import common
        common.state_dir().mkdir(parents=True, exist_ok=True)
        (common.state_dir() / "jira-email").write_text("josh@example.com\n")
        keychain = lambda *a, **k: SimpleNamespace(returncode=0, stdout="made-up-token\n")      # noqa: E731
        client = watch.jira_client({}, run=keychain)
        self.assertIsNotNone(client)
        self.assertEqual(client._auth.split()[0], "Basic")
        nothing = lambda *a, **k: SimpleNamespace(returncode=44, stdout="")                      # noqa: E731
        self.assertIsNone(watch.jira_client({}, run=nothing))

    def test_no_credentials_is_not_a_crash(self):
        from types import SimpleNamespace
        nothing = lambda *a, **k: SimpleNamespace(returncode=44, stdout="")                      # noqa: E731
        self.assertIsNone(watch.jira_client({}, run=nothing))
        self.assertEqual(self.watch(jira=None), {"runner-sample": {"jira": "no-credentials", "started": [],
                                                                   "skipped": {}}})


class WatchingDeployedTickets(WatchBase):
    """The validation rule: a ticket in Deployed that is not flagged, with no route record (JP-167). The fixture graph
    `runner-sample` stands in for the real one, which the whole-run tests use."""

    def setUp(self):
        super().setUp()
        rule = dict(VALIDATION, jql="project = JP AND status = Deployed AND Flagged is EMPTY")
        self.rules = {"per_pass": 1, "graphs": {"runner-sample": rule}}

    def deployed(self, key, flagged=False, route=None):
        self.jira_issue(key, status="Deployed", route=route)
        if flagged:
            state = json.loads(self.jira_file().read_text())
            state["issues"][key]["fields"]["customfield_10021"] = [{"value": "Impediment"}]
            self.jira_file().write_text(json.dumps(state))

    def test_deployed_ticket_starts_a_validation_run(self):
        self.deployed("JP-901")
        got = self.watch()
        self.assertEqual(got, {"runner-sample": {"jira": "ok", "started": ["JP-901"], "skipped": {}}})
        rows = self.runs()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1:], ("agent-manager", 0, "JP-901"))
        inputs = runfolder.load(rows[0][0])["inputs"]
        self.assertEqual((inputs["ticket_key"], inputs["system"], inputs["phi"]), ("JP-901", "none", False))
        self.assertNotIn("josh360.route", " ".join(c["path"] for c in self.jira_calls()))

    def test_flagged_ticket_is_not_picked_up(self):
        self.deployed("JP-901", flagged=True)
        self.assertEqual(self.watch()["runner-sample"]["started"], [])
        self.assertEqual(self.runs(), [])

    def test_ticket_that_is_not_in_deployed_is_not_picked_up(self):
        self.jira_issue("JP-901", status="In Progress", route=None)
        self.assertEqual(self.watch()["runner-sample"]["started"], [])

    def test_deployed_ticket_with_an_open_run_is_skipped(self):
        self.deployed("JP-901")
        self.start("runner-sample", "JP-901")
        self.assertEqual(self.watch()["runner-sample"]["skipped"], {"JP-901": "has an open run"})

    def test_a_route_record_that_names_another_graph_does_not_matter(self):
        self.deployed("JP-901", route={"graph": "development", "system": "sample", "returned_from": ""})
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-901"])

    def test_one_start_per_pass(self):
        for key in ("JP-901", "JP-902"):
            self.deployed(key)
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-901"])
        self.assertEqual(self.watch()["runner-sample"]["started"], ["JP-902"])

    def test_refused_entry_gate_is_not_admitted(self):
        self.deployed("JP-901")
        self.plan({"ready": ["no"]})
        self.assertEqual(self.watch()["runner-sample"]["skipped"], {"JP-901": "not admitted"})

    def test_rule_without_a_route_must_say_so(self):
        bad = self.tmp / "starts.json"
        rule = {"on": True, "jql": "project = JP AND status = Deployed", "inputs": {}}
        bad.write_text(json.dumps({"per_pass": 1, "graphs": {"validation": rule}}))
        with self.assertRaises(ValueError) as caught:
            watch.load_rules(bad)
        self.assertIn("validation", str(caught.exception))
        bad.write_text(json.dumps({"per_pass": 1, "graphs": {"validation": dict(rule, route_record=False)}}))
        self.assertIn("validation", watch.load_rules(bad)["graphs"])

    def test_route_source_in_a_rule_with_no_route_record_is_refused(self):
        bad = self.tmp / "starts.json"
        for extra in ({"route": "validation"}, {"inputs": {"system": "route.system"}}, {"inputs": {"x": "spec.phi_risk"}}):
            rule = dict({"on": True, "jql": "project = JP", "route_record": False, "inputs": {}}, **extra)
            bad.write_text(json.dumps({"per_pass": 1, "graphs": {"validation": rule}}))
            with self.assertRaises(ValueError) as caught:
                watch.load_rules(bad)
            self.assertIn("validation", str(caught.exception))

    def test_a_route_record_rule_still_needs_its_route(self):
        bad = self.tmp / "starts.json"
        bad.write_text(json.dumps({"per_pass": 1, "graphs": {"x": {"on": True, "jql": "a", "route_record": True,
                                                                   "inputs": {}}}}))
        with self.assertRaises(ValueError):
            watch.load_rules(bad)

    def test_shipped_rules_load(self):
        rules = watch.load_rules(SHIPPED)["graphs"]
        self.assertTrue(rules["development"]["on"] and rules["validation"]["on"])
        self.assertIs(rules["validation"]["route_record"], False)
        self.assertEqual(rules["validation"]["jql"], "project = JP AND status = Deployed AND Flagged is EMPTY")
        graph = yaml.safe_load((ROOT / "graphs" / "flows" / "validation.yaml").read_text()) \
            if (ROOT / "graphs" / "flows" / "validation.yaml").is_file() else {"inputs": {"ticket_key": {}}}
        self.assertTrue(set(rules["validation"]["inputs"]) <= set(graph["inputs"]))


if __name__ == "__main__":
    unittest.main()
