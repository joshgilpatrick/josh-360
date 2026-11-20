"""JP-117, Task 12: whole runs from the label to the end, driven by real ticks with a fake Agent Manager, a fake Jira and
a made-up clock; the JP-116 triage job; and what must stay out of the runner's code."""
import io
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

from runner_helpers import ROOT, RunnerCase, db, runfolder
from runner_lib import hooklib

PLAYS = {"draft": ("ready", {"note": "a made-up note"}), "make": ("done", {}), "look": ("pass", {})}


class Running(RunnerCase):
    def setUp(self):
        super().setUp()
        rule = dict(json.loads((ROOT / "graphs" / "runner" / "starts.json").read_text())["graphs"]["development"],
                    route="runner-sample")
        starts = self.tmp / "starts.json"
        starts.write_text(json.dumps({"per_pass": 1, "graphs": {"runner-sample": rule}}))
        os.environ.update({"JOSH360_RUNNER_STARTS": str(starts), "JOSH360_GRAPHS_ROOT": str(self.root),
                           "PYTHONDONTWRITEBYTECODE": "1"})
        self.sessions = 0

    def forget_everything(self):
        """Drop every in-process object of the runner: the next call is built from the files and the ledger alone."""
        names = [n for n in sys.modules if n.startswith("runner_lib") or n.startswith("josh360_binding")]
        if not hasattr(self, "_kept_modules"):                 # put the originals back afterwards: other test files patch them
            self._kept_modules = {n: sys.modules[n] for n in names}
            self.addCleanup(lambda: sys.modules.update(self._kept_modules))
        for name in names:
            del sys.modules[name]

    def run_state(self, ticket):
        conn = db.connect(db.ledger_path())
        try:
            row = conn.execute("SELECT g.run_id, e.end_name FROM graph_runs g LEFT JOIN run_ends e ON e.run_id = g.run_id "
                               "WHERE g.ticket_key = ? ORDER BY g.id DESC", (ticket,)).fetchone()
        finally:
            conn.close()
        return tuple(row) if row else (None, None)

    def drive(self, ticket, on_step=None, fresh=False, limit=30):
        """Tick (advancing in process) until the ticket's run ends, playing each role step and answering each ask."""
        for _ in range(limit):
            if fresh:
                self.forget_everything()
            from runner_lib import advance, tick
            run, end = self.run_state(ticket)
            tick.tick(now=lambda: self.now, launcher=lambda r: advance.advance(r, now=lambda: self.now, root=self.root),
                      root=self.root)
            self.later(60)
            run, end = self.run_state(ticket)
            if end:
                return run, end
            if run is None:
                continue
            doc = self.open_session(run)
            if doc is not None:
                self.sessions += 1
                sid = "cc-{}".format(self.sessions)
                self.session_starts(run, doc["step"], attempt=doc["attempt"], session_id=sid)
                if on_step:
                    on_step(doc["step"], sid)
                outcome, outputs = PLAYS[doc["step"]]
                self.session_ends(run, doc["step"], outcome, outputs, attempt=doc["attempt"])
            self.answer_waiting(run)
        raise AssertionError("the run for {} did not end in {} ticks".format(ticket, limit))

    def open_session(self, run):
        from runner_lib import sessionfile
        for path in sorted((runfolder.folder(run) / "sessions").glob("*.json")):
            if path.name.endswith(".link.json"):
                continue
            doc = json.loads(path.read_text())
            if doc["state"] == "started" and not Path(doc["result_file"]).exists():
                return doc
        return None

    def answer_waiting(self, run):
        from walker_lib import questions
        for path in sorted(questions.questions_dir().glob("walker-{}-*.json".format(run))):
            record = json.loads(path.read_text())
            if record["state"] == "open":
                step = record["id"][len("walker-{}-".format(run)):].rsplit("-", 1)[0]
                self.answer_in_app(run, step, "go", attempt=int(record["id"].rsplit("-", 1)[1]))

    def spawn_names(self):
        return [call[call.index("--name") + 1] for call in self.am_calls("spawn")]

    def test_a_labelled_ticket_goes_to_the_end_with_no_hand_start(self):
        self.jira_issue("JP-901")
        run, end = self.drive("JP-901")
        self.assertEqual(end, "finished")
        names = self.spawn_names()
        self.assertEqual(len(names), 3)
        self.assertEqual(names, ["JP-901(a) - Draft", "JP-901(b) - Make", "JP-901(c) - Look"])
        # JP-191: each finished step's session is killed and filed in completed-steps, not archived at once
        self.assertEqual(self.am_calls("archive"), [])
        self.assertEqual([c[1] for c in self.am_calls("kill")], ["s-1", "s-2", "s-3"])
        conn = db.connect(db.ledger_path())
        try:
            self.assertEqual(conn.execute("SELECT runner FROM graph_runs WHERE run_id = ?", (run,)).fetchone()[0],
                             "agent-manager")
        finally:
            conn.close()

    def test_josh_is_asked_only_at_the_named_points(self):
        self.jira_issue("JP-901")
        run, end = self.drive("JP-901")
        header = json.loads((self.root / "compiled" / "runner-sample.json").read_text())["graph"]["header"]
        allowed = set(header["asks_josh"])
        conn = db.connect(db.ledger_path())
        try:
            asked = [r[0] for r in conn.execute("SELECT question_key FROM asks WHERE run_id = ?", (run,))]
        finally:
            conn.close()
        self.assertTrue(set(q.split("/")[-1] for q in asked) <= allowed, asked)
        from walker_lib import questions
        records = [json.loads(p.read_text()) for p in questions.questions_dir().glob("walker-{}-*.json".format(run))]
        self.assertTrue(records)
        for record in records:
            step = record["id"][len("walker-{}-".format(run)):].rsplit("-", 1)[0]
            self.assertIn(step, allowed)

    def test_reordering_two_gates_needs_no_runner_change(self):
        import shutil
        other = self.tmp / "graphs-reordered"
        shutil.copytree(str(self.root), str(other))
        path = other / "flows" / "runner-sample.yaml"
        text = path.read_text()
        a = re.search(r"  - id: check_a\n.*?\n\n", text, re.S).group(0)
        b = re.search(r"  - id: check_b\n.*?\n\n", text, re.S).group(0)
        path.write_text(text.replace(a + b, b + a))
        self.assertNotEqual(path.read_text(), text)
        self.jira_issue("JP-901")
        self.assertEqual(self.drive("JP-901")[1], "finished")
        mine = [g["gate"] for g in self.log() if g.get("ticket") == "JP-901" and g["gate"] in ("lint-spec", "check-review")]
        first_root = self.root
        self.root = other
        os.environ["JOSH360_GRAPHS_ROOT"] = str(other)
        self.assertEqual(self.compile()[0], 0)
        self.jira_issue("JP-902")
        self.assertEqual(self.drive("JP-902")[1], "finished")
        reordered = [g["gate"] for g in self.log() if g.get("ticket") == "JP-902" and g["gate"] in ("lint-spec", "check-review")]
        self.root = first_root
        self.assertEqual(sorted(mine), sorted(reordered))
        self.assertNotEqual(mine, reordered)

    def test_the_read_step_is_guarded_as_read_and_the_build_step_is_not(self):
        outside = str(self.tmp / "somewhere" / "file.txt")
        seen = {}

        def guard(step, sid):
            if step in ("make", "look"):
                seen[step] = hooklib.guard({"session_id": sid, "tool_name": "Edit", "tool_input": {"file_path": outside}},
                                           {}, self.now)

        self.jira_issue("JP-901")
        self.drive("JP-901", on_step=guard)
        self.assertEqual(seen["look"][0], 2)
        self.assertIn("this step only reads", seen["look"][2])
        self.assertEqual(seen["make"], (0, "", ""))

    def test_a_step_session_cannot_ask_or_write_to_jira(self):
        seen = {}

        def guard(step, sid):
            if step == "draft":
                for tool in ("AskUserQuestion", "mcp__Atlassian_MCP__transitionJiraIssue"):
                    seen[tool] = hooklib.guard({"session_id": sid, "tool_name": tool, "tool_input": {}}, {}, self.now)

        self.jira_issue("JP-901")
        self.drive("JP-901", on_step=guard)
        self.assertEqual(seen["AskUserQuestion"][0], 2)
        self.assertEqual(seen["mcp__Atlassian_MCP__transitionJiraIssue"][0], 2)
        self.assertIn("only gate scripts write to Jira", seen["mcp__Atlassian_MCP__transitionJiraIssue"][2])

    def test_run_survives_everything_being_restarted(self):
        self.jira_issue("JP-901")
        run, end = self.drive("JP-901", fresh=True)
        self.assertEqual(end, "finished")
        self.assertEqual(len(self.spawn_names()), 3)

    def test_triage_job_starts_once(self):
        import triage_jp116_job
        text = (self.root / "flows" / "runner-sample.yaml").read_text()
        text = text.replace("graph: runner-sample", "graph: triage").replace(
            "  phi: {", "  reason: { type: string, default: new, description: Why the ticket is being triaged }\n  phi: {")
        (self.root / "flows" / "triage.yaml").write_text(text)
        self.assertEqual(self.compile()[0], 0)

        def job():
            out = io.StringIO()
            self.assertEqual(triage_jp116_job.main(out=out), 0)
            return json.loads(out.getvalue())

        self.assertEqual(job(), {"status": "waiting", "why": "no tick yet"})
        from runner_lib import paths
        paths.state_dir().mkdir(parents=True, exist_ok=True)
        (paths.state_dir() / "report.json").write_text("{}")
        started = job()
        self.assertEqual(started["status"], "started")
        self.assertEqual(job(), {"status": "exists", "run": started["run"]})
        conn = db.connect(db.ledger_path())
        try:
            rows = conn.execute("SELECT graph_id, ticket_key, runner FROM graph_runs WHERE ticket_key = 'JP-116'").fetchall()
        finally:
            conn.close()
        self.assertEqual([tuple(r) for r in rows], [("triage", "JP-116", "agent-manager")])

    def test_triage_job_waits_without_jira_credentials(self):
        import triage_jp116_job
        from runner_lib import paths
        paths.state_dir().mkdir(parents=True, exist_ok=True)
        (paths.state_dir() / "report.json").write_text("{}")
        os.environ.pop("JOSH360_JIRA_FAKE")
        out = io.StringIO()
        with mock.patch("ledger.jira_read.credentials", return_value=None):       # not this laptop's own keychain
            self.assertEqual(triage_jp116_job.main(out=out), 0)
        self.assertEqual(json.loads(out.getvalue()), {"status": "waiting", "why": "no jira credentials"})

    def test_triage_job_waits_when_the_walker_does_not_admit_the_run(self):
        import triage_jp116_job
        from runner_lib import paths
        paths.state_dir().mkdir(parents=True, exist_ok=True)
        (paths.state_dir() / "report.json").write_text("{}")
        out = io.StringIO()                                    # there is no `triage` graph in the fixture folder
        self.assertEqual(triage_jp116_job.main(out=out), 0)
        self.assertEqual(json.loads(out.getvalue()), {"status": "waiting", "why": "not admitted"})

    def test_runner_code_has_no_graph_logic(self):
        banned = ("max_loops", "at_limit", ".needs(", '"when"', '["on"]')
        spawners = ("agent-manager spawn", "tmux")
        found = []
        for top in ("runner", "bindings"):
            for path in sorted((ROOT / "graphs" / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
                    continue
                text = path.read_text(encoding="utf-8")
                found += ["{}: {}".format(path.relative_to(ROOT), word) for word in banned if word in text]
                if top == "runner":
                    found += ["{}: {}".format(path.relative_to(ROOT), word) for word in spawners if word in text]
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
