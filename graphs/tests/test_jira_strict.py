"""JP-187: the folder fake Jira refuses what JP's real Jira would refuse, once it holds the JP snapshot.

The snapshot (graphs/gates/jira-snapshot/JP.json) is JP's real workflow, read-only; the ticket (JP-9116) is made up.
Nothing here reaches a network.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATES = ROOT / "graphs" / "gates"
sys.path.insert(0, str(GATES))
sys.path.insert(0, str(ROOT / "scripts"))

from lib import jira_fake, jira_strict  # noqa: E402
from lib.jira import FLAG_FIELD, Jira, JiraError  # noqa: E402
import jira_snapshot  # noqa: E402

KEY = "JP-9116"
SNAP = json.loads(jira_strict.REPO_SNAPSHOT.read_text(encoding="utf-8"))


class StrictCase(unittest.TestCase):
    strict = True

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self._tmp.name) / "jira"
        if self.strict:
            jira_strict.install(self.folder, fixtures=(KEY,))
        else:
            self.folder.mkdir()
            (self.folder / jira_fake.MARKER).write_text(json.dumps({"issues": {KEY: {"key": KEY, "fields": {
                "status": {"name": "Validation"}, "issuetype": {"name": "Task"}}}}}))
        self.jira = Jira("https://eventuswh-analytics.atlassian.net", "a@b.c", "t",
                         transport=jira_fake.FileTransport(self.folder), sleep=lambda s: None)

    def tearDown(self):
        self._tmp.cleanup()

    def state(self) -> dict:
        return json.loads((self.folder / jira_fake.MARKER).read_text())

    def edit(self, **fields):
        state = self.state()
        state["issues"][KEY]["fields"].update(fields)
        (self.folder / jira_fake.MARKER).write_text(json.dumps(state))

    def status(self) -> str:
        return self.state()["issues"][KEY]["fields"]["status"]["name"]

    def raw(self, method, path, body=None):
        """(status, parsed body) straight from the fake, as Jira would answer."""
        code, data, _ = jira_fake.FileTransport(self.folder)(
            method, "https://eventuswh-analytics.atlassian.net" + path, {}, json.dumps(body).encode() if body else None)
        return code, (json.loads(data) if data else None)

    def calls(self):
        return [json.loads(line) for line in (self.folder / jira_fake.CALLS).read_text().splitlines()]

    def run_gate(self, name, **inputs):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GRAPH_INPUT_", "JOSH360_"))}
        env["JOSH360_JIRA_FAKE"] = str(self.folder)
        for k, v in inputs.items():
            env["GRAPH_INPUT_" + k.upper()] = v
        done = subprocess.run([sys.executable, str(GATES / (name + ".py"))], env=env, capture_output=True, text=True,
                              cwd=self._tmp.name)
        return done.returncode, done.stdout, done.stderr


class AcceptanceScenarios(StrictCase):
    def test_a_known_transition_is_accepted(self):
        self.edit(status={"name": "Validation"})
        code, out, err = self.run_gate("move-ticket", ticket_key=KEY, target_status="Deployed")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.state()["issues"][KEY]["fields"]["status"],
                         {"name": "Deployed", "id": "10582", "statusCategory": {"key": "indeterminate"}})
        posts = [c for c in self.calls() if c["method"] == "POST" and c["path"].endswith("/transitions")]
        self.assertEqual([p["body"]["transition"]["id"] for p in posts], ["7"])

    def test_an_unknown_transition_is_refused(self):
        self.edit(status={"name": "Validation"})
        code, body = self.raw("POST", "/rest/api/3/issue/{}/transitions".format(KEY), {"transition": {"id": "999"}})
        self.assertEqual(code, 400)
        self.assertIn("Transition id '999' is not valid", body["errorMessages"][0])
        self.assertEqual(self.status(), "Validation")

    def test_an_unknown_field_is_refused(self):
        code, body = self.raw("PUT", "/rest/api/3/issue/" + KEY, {"fields": {"customfield_99999": "x"}})
        self.assertEqual(code, 400)
        self.assertIn("customfield_99999", body["errors"])
        with self.assertRaises(JiraError) as caught:
            self.jira._ok(self.jira._call("PUT", "/rest/api/3/issue/" + KEY, {"fields": {"customfield_99999": 1}}),
                          "edit")
        self.assertEqual(caught.exception.status, 400)


class WithoutSnapshot(StrictCase):
    strict = False

    def test_no_snapshot_keeps_the_lenient_fake(self):
        self.assertFalse((self.folder / jira_strict.SNAPSHOT).exists())
        code, _ = self.raw("PUT", "/rest/api/3/issue/" + KEY, {"fields": {"customfield_99999": "x"}})
        self.assertEqual(code, 204)
        code, _ = self.raw("POST", "/rest/api/3/issue/{}/transitions".format(KEY), {"transition": {"id": "t:Anything"}})
        self.assertEqual(code, 204)
        self.assertEqual(self.status(), "Anything")


class Transitions(StrictCase):
    def test_transitions_are_the_real_ids_and_targets(self):
        code, body = self.raw("GET", "/rest/api/3/issue/{}/transitions".format(KEY))
        self.assertEqual(code, 200)
        ids = {t["id"]: t["to"]["name"] for t in body["transitions"]}
        self.assertEqual(ids["7"], "Deployed")
        self.assertEqual(ids["21"], "In Progress")
        self.assertEqual(len(ids), 9)

    def test_every_jp_status_is_reachable_by_name(self):
        for name in ("Ready", "Design/Planning", "In Progress", "Code Review", "Validation", "Deployed", "Done",
                     "Cancelled", "Not Started"):
            self.assertTrue(self.jira.transition(KEY, name), name)
            self.assertEqual(self.status(), name)

    def test_a_status_jp_does_not_have_is_not_reached(self):
        self.assertFalse(self.jira.transition(KEY, "Shipped"))
        self.assertEqual(self.status(), "Ready")

    def test_status_cannot_be_set_as_a_field(self):
        code, body = self.raw("PUT", "/rest/api/3/issue/" + KEY, {"fields": {"status": {"name": "Done"}}})
        self.assertEqual(code, 400)
        self.assertEqual(self.status(), "Ready")

    def test_move_ticket_knows_exactly_jp_s_statuses(self):
        module = (GATES / "move-ticket.py").read_text()
        listed = re.search(r"JP_STATUSES = \(([^)]*)\)", module).group(1)
        self.assertEqual(sorted(re.findall(r'"([^"]+)"', listed)), sorted(s["name"] for s in SNAP["statuses"]))


class Fields(StrictCase):
    def test_the_flag_gate_works_with_the_real_field(self):
        env_code = subprocess.run([sys.executable, str(GATES / "set-flag.py"), "--ticket", KEY, "--on"],
                                  env=dict(os.environ, JOSH360_JIRA_FAKE=str(self.folder)), capture_output=True,
                                  text=True)
        self.assertEqual(env_code.returncode, 0, env_code.stderr)
        self.assertEqual(self.state()["issues"][KEY]["fields"][FLAG_FIELD], [{"value": "Impediment"}])

    def test_an_option_value_jp_does_not_have_is_refused(self):
        code, body = self.raw("PUT", "/rest/api/3/issue/" + KEY, {"fields": {FLAG_FIELD: [{"value": "Blocked"}]}})
        self.assertEqual(code, 400)
        self.assertIn(FLAG_FIELD, body["errors"])

    def test_agent_status_takes_its_real_options(self):
        self.assertEqual(self.raw("PUT", "/rest/api/3/issue/" + KEY,
                                  {"fields": {"customfield_10453": {"value": "Queued"}}})[0], 204)
        self.assertEqual(self.raw("PUT", "/rest/api/3/issue/" + KEY,
                                  {"fields": {"customfield_10453": {"value": "Waiting"}}})[0], 400)

    def test_the_other_projects_agent_status_field_is_not_on_jp(self):
        self.assertEqual(self.raw("PUT", "/rest/api/3/issue/" + KEY,
                                  {"fields": {"customfield_10452": {"value": "Queued"}}})[0], 400)

    def test_josh_360_is_not_a_repository_option_on_jp(self):
        """Seen on 2026-11-20: JP's Repository field has no joshgilpatrick/josh-360 option."""
        code, _ = self.raw("PUT", "/rest/api/3/issue/" + KEY,
                           {"fields": {"customfield_10487": {"value": "joshgilpatrick/josh-360"}}})
        self.assertEqual(code, 400)


class Creating(StrictCase):
    def fields(self, **changes):
        doc = {"project": {"key": "JP"}, "summary": "A made-up task", "issuetype": {"name": "Task"},
               "labels": ["josh-360"]}
        doc.update(changes)
        return doc

    def test_a_real_create_starts_in_not_started(self):
        key = self.jira.create(self.fields())
        self.assertTrue(key)
        issue = self.jira.get(key)
        self.assertEqual((issue["status"], issue["status_category"], issue["issuetype"]),
                         ("Not Started", "new", "Task"))
        self.assertEqual(issue["fields"]["issuetype"]["id"], "10300")

    def test_an_issue_type_jp_does_not_have_is_refused(self):
        with self.assertRaises(JiraError) as caught:
            self.jira.create(self.fields(issuetype={"name": "Spike"}))
        self.assertEqual(caught.exception.status, 400)

    def test_a_field_off_the_create_screen_is_refused(self):
        with self.assertRaises(JiraError):
            self.jira.create(self.fields(customfield_10017="dark_blue"))   # Issue color is on Epics only
        self.assertTrue(self.jira.create(self.fields(issuetype={"name": "Epic"}, customfield_10017="dark_blue")))

    def test_a_subtask_needs_its_parent(self):
        with self.assertRaises(JiraError):
            self.jira.create(self.fields(issuetype={"name": "Subtask"}))
        self.assertTrue(self.jira.create(self.fields(issuetype={"name": "Subtask"}, parent={"key": KEY})))

    def test_another_project_is_refused(self):
        with self.assertRaises(JiraError):
            self.jira.create(self.fields(project={"key": "AD"}))

    def test_create_metadata_comes_from_the_snapshot(self):
        self.assertEqual(self.jira.create_meta("JP"), {t["name"]: t["id"] for t in SNAP["issue_types"]})


class Searching(StrictCase):
    def test_a_status_jp_does_not_have_is_a_400(self):
        code, body = self.raw("POST", "/rest/api/3/search/jql", {"jql": 'project = JP AND status = "Shipped"'})
        self.assertEqual(code, 400)
        self.assertIn("'Shipped' does not exist for the field 'status'", body["errorMessages"][0])
        with self.assertRaises(JiraError):
            self.jira.search('project = JP AND issuetype in (Story, Spike)')

    def test_every_start_rule_the_runner_uses_is_valid_jql(self):
        starts = json.loads((ROOT / "graphs" / "runner" / "starts.json").read_text())
        rules = jira_strict.Rules(SNAP)
        for name, graph in starts["graphs"].items():
            if graph.get("jql"):
                self.assertIsNone(rules.check_jql(graph["jql"]), name)

    def test_a_jql_function_is_not_read_as_a_value(self):
        rules = jira_strict.Rules(SNAP)
        self.assertIsNone(rules.check_jql("project = JP AND issuetype in standardIssueTypes()"))
        self.assertIsNone(rules.check_jql("project in projectsLeadByUser() AND status = Ready"))

    def test_found_tickets_carry_their_real_status_ids(self):
        rows = self.jira.search("project = JP", ["status"])
        self.assertEqual(rows[0]["fields"]["status"]["id"], "10508")

    def test_a_seeded_status_jp_does_not_have_is_loud(self):
        self.edit(status={"name": "Shipped"})
        code, body = self.raw("GET", "/rest/api/3/issue/" + KEY)
        self.assertEqual(code, 500)
        self.assertIn("'Shipped', which JP does not have", body["errorMessages"][0])


class Links(StrictCase):
    def test_link_types_are_jp_s(self):
        other = self.jira.create({"project": {"key": "JP"}, "summary": "Another made-up task",
                                  "issuetype": {"name": "Task"}})
        self.assertTrue(self.jira.link("Blocks", KEY, other))
        self.assertFalse(self.jira.link("Precedes", KEY, other))

    def test_a_missing_ticket_is_a_404(self):
        self.assertEqual(self.raw("GET", "/rest/api/3/issue/JP-1")[0], 404)
        self.assertIsNone(self.jira.get("JP-1"))


class TheSnapshotAndFixture(unittest.TestCase):
    def test_the_snapshot_holds_the_ids_the_gates_depend_on(self):
        rules = jira_strict.Rules(SNAP)
        self.assertEqual(rules.status("Deployed")["id"], "10582")
        self.assertEqual([t["to"]["name"] for t in rules.transitions_from("Validation") if t["id"] == "7"],
                         ["Deployed"])
        self.assertEqual(SNAP["custom_fields"][FLAG_FIELD]["name"], "Flagged")
        self.assertEqual(SNAP["custom_fields"]["customfield_10020"]["name"], "Sprint")

    def test_the_route_shape_matches_what_mark_ready_writes(self):
        source = (GATES / "mark-ready.py").read_text()
        record = re.search(r"record = \{(.*?)\}\n", source, re.S).group(1)
        self.assertEqual(sorted(re.findall(r'"(\w+)":', record)),
                         sorted(SNAP["properties"]["josh360.route"]["keys"]))

    def test_the_fixture_is_made_up_and_shaped_like_the_snapshot(self):
        doc = json.loads((jira_strict.FIXTURES / (KEY + ".json")).read_text())
        self.assertEqual(sorted(doc["properties"]["josh360.route"]), sorted(SNAP["properties"]["josh360.route"]["keys"]))
        self.assertIn("made-up", doc["fields"]["summary"])
        self.assertIsNone(jira_strict.Rules(SNAP).dress(json.loads(json.dumps(doc))))


class SnapshotRest:
    """Answers the snapshot script's reads the way Jira's REST API does, built from a snapshot document."""

    def __init__(self, snap: dict):
        self.snap = snap
        self.calls = []

    def __call__(self, method, url, headers, body):
        path = url.split("atlassian.net", 1)[1].split("?")[0]
        self.calls.append((method, path))
        s = self.snap
        status = {r["id"]: {"id": r["id"], "name": r["name"], "statusCategory": {"key": r["category"]}}
                  for r in s["statuses"]}
        types = {t["id"]: t for t in s["issue_types"]}
        p = s["project"]["key"]
        if path == "/rest/api/3/project/" + p:
            return self.ok({"key": p, "id": s["project"]["id"], "simplified": s["project"]["simplified"]})
        if path == "/rest/api/3/project/{}/statuses".format(p):
            return self.ok([{"id": t["id"], "name": t["name"], "statuses": list(status.values())} for t in types.values()])
        if path == "/rest/api/3/issue/createmeta/{}/issuetypes".format(p):
            return self.ok({"issueTypes": [{"id": t["id"], "name": t["name"], "subtask": t["subtask"]}
                                           for t in types.values()]})
        if path.startswith("/rest/api/3/issue/createmeta/{}/issuetypes/".format(p)):
            t = types[path.rsplit("/", 1)[1]]
            return self.ok({"fields": [self.field(f, f in t["required"]) for f in t["create_fields"]]})
        if path == "/rest/api/3/field":
            return self.ok([{"id": k, "name": v["name"]} for k, v in s["custom_fields"].items()])
        if path == "/rest/api/3/search/jql":
            wanted = json.loads(body)["jql"].rsplit(" ", 1)[1]
            name = status[wanted]["name"]
            return self.ok({"issues": [{"key": "JP-1"}]} if name in s["transitions_observed_from"] else {"issues": []},
                           key=name)
        if path.endswith("/transitions"):
            return self.ok({"transitions": [{"id": t["id"], "name": t["name"],
                                             "to": {"name": t["to"]}} for t in s["transitions"]]})
        if path == "/rest/api/3/issueLinkType":
            return self.ok({"issueLinkTypes": s["link_types"]})
        return 404, b"{}", {}

    def field(self, name, required):
        custom = self.snap["custom_fields"].get(name) or {}
        row = {"fieldId": name, "name": custom.get("name") or name, "required": required, "schema": {"type": "string"}}
        if "options" in custom:
            row["schema"] = {"type": "array", "items": "option"} if name == FLAG_FIELD else {"type": "option"}
            row["allowedValues"] = [{"value": v} for v in custom["options"]]
        if name == "priority":
            row["allowedValues"] = [{"name": n} for n in self.snap["priorities"]]
        return row

    @staticmethod
    def ok(doc, key=None):
        return 200, json.dumps(doc).encode(), {}


class TheSnapshotScript(unittest.TestCase):
    def test_it_rebuilds_the_committed_snapshot_and_only_reads(self):
        rest = SnapshotRest(SNAP)
        jira = Jira("https://eventuswh-analytics.atlassian.net", "a@b.c", "t", transport=rest, sleep=lambda s: None)
        doc = jira_snapshot.snapshot(jira, "JP", previous=SNAP, today=SNAP["taken"])
        for name in ("taken_by",):
            doc.pop(name)
        expected = {k: v for k, v in SNAP.items() if k != "taken_by"}
        self.assertEqual(doc, expected)
        writes = [c for c in rest.calls if c[0] != "GET" and c[1] != "/rest/api/3/search/jql"]
        self.assertEqual(writes, [])

    def test_a_failed_read_writes_nothing(self):
        def down(method, url, headers, body):
            return 503, b"{}", {}
        jira = Jira("https://eventuswh-analytics.atlassian.net", "a@b.c", "t", transport=down, sleep=lambda s: None)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "JP.json"
            self.assertEqual(jira_snapshot.main(["--out", str(out)], jira=jira), 1)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
