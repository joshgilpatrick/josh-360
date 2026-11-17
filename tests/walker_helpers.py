"""Made-up graph, scripted gates and a made-up Needs you folder for the walker tests (JP-114). Nothing real here."""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "graphs" / "tools"))
from ledger import _repo  # noqa: E402,F401
from ledger import db  # noqa: E402
import compile_graphs  # noqa: E402
from walker_lib import cli, questions, runfolder  # noqa: E402

NOW = "2026-11-17T12:00:00Z"
FIXTURE = ROOT / "graphs" / "tests" / "fixtures" / "parts"

# A gate whose outcomes come from a plan file: {"<gate>": ["pass", {"outcome": "x", "outputs": {...}}, ...]}; the
# last entry repeats. Every call is logged with the status it was asked to move the ticket to.
SCRIPTED = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(__file__).stem
log = os.environ.get("WALKER_TEST_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"gate": name, "status": os.environ.get("GRAPH_INPUT_TARGET_STATUS"),
                            "ticket": os.environ.get("GRAPH_INPUT_TICKET_KEY"), "run": os.environ.get("JOSH360_RUN_ID"),
                            "runs": os.environ.get("JOSH360_RUNS")}) + "\\n")
plan_path = os.environ["WALKER_TEST_PLAN"]
default = {"move-ticket": "moved", "check-review": "clean", "pr-state": "merged"}.get(name, "pass")
plan = json.load(open(plan_path)).get(name, [default])
count_path = plan_path + "." + name
n = int(open(count_path).read()) if os.path.exists(count_path) else 0
open(count_path, "w").write(str(n + 1))
entry = plan[min(n, len(plan) - 1)]
if entry == "crash":
    sys.exit("scripted crash")
print(json.dumps(entry if isinstance(entry, dict) else {"outcome": entry}))
"""
EFFECT = """#!/usr/bin/env python3
import os, sys
log = os.environ.get("WALKER_TEST_LOG")
if log:
    import json
    with open(log, "a") as f:
        f.write(json.dumps({"effect": os.path.basename(__file__), "argv": sys.argv[1:]}) + "\\n")
if os.environ.get("WALKER_TEST_EFFECT_FAILS"):
    sys.exit("scripted refusal")
"""


class WalkerCase(unittest.TestCase):
    """A fresh ledger, a copy of the sample parts with scripted gates, and a Needs you folder, all in a temp folder."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-walker-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.saved_env = dict(os.environ)
        self.addCleanup(self._restore_env)
        home = self.tmp / "home"
        os.environ.update({"JOSH360_HOME": str(home), "JOSH360_RUNS": str(self.tmp / "runs"),
                           "JOSH360_QUESTIONS_DIR": str(self.tmp / "questions"),
                           "WALKER_TEST_PLAN": str(self.tmp / "plan.json"), "WALKER_TEST_LOG": str(self.tmp / "log")})
        for var in ("JOSH360_JIRA_TOKEN", "JOSH360_JIRA_EMAIL", "ACTION_AGENT_JIRA_EMAIL", "WALKER_TEST_EFFECT_FAILS"):
            os.environ.pop(var, None)
        db.ensure(home / "state" / "ledger.db", home / "backups", NOW)
        self.root = self.tmp / "graphs"
        shutil.copytree(str(FIXTURE), str(self.root))
        for gate in ("lint-spec", "check-review", "move-ticket", "ready", "no-loose-ends", "pr-state"):
            (self.root / "gates" / (gate + ".py")).write_text(SCRIPTED)
        for effect in ("set-flag", "post-comment"):
            (self.root / "gates" / (effect + ".py")).write_text(EFFECT)
        self.plan({})
        self.compile()

    def _restore_env(self):
        os.environ.clear()
        os.environ.update(self.saved_env)

    def plan(self, plan):
        (self.tmp / "plan.json").write_text(json.dumps(plan))
        for old in self.tmp.glob("plan.json.*"):
            old.unlink()

    def compile(self):
        out = io.StringIO()
        real = sys.stdout
        sys.stdout = out
        try:
            code = compile_graphs.main(["--root", str(self.root)])
        finally:
            sys.stdout = real
        return code, out.getvalue()

    def walker(self, *argv, code=0):
        out = io.StringIO()
        got = cli.main(["--root", str(self.root)] + [str(a) for a in argv], out)
        self.assertEqual(got, code, out.getvalue())
        return json.loads(out.getvalue())

    def start(self, graph="valid", ticket="JP-901", *extra):
        return self.walker("start", "--graph", graph, "--ticket", ticket, "--input", "system=sample", *extra)["run"]

    def step_rows(self, run):
        conn = db.connect(db.ledger_path())
        try:
            return conn.execute(
                "SELECT s.step_id, s.attempt, s.loop_count, s.tier, s.allowed_by_josh, r.outcome FROM step_runs s "
                "LEFT JOIN step_results r ON r.step_run_id = s.id WHERE s.run_id = ? ORDER BY s.id", (run,)).fetchall()
        finally:
            conn.close()

    def log(self):
        path = self.tmp / "log"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def do_role(self, run, step, outcome, outputs=None, **kw):
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["step"]), ("run", step), out)
        if outputs is not None:
            rf = Path(out["result_file"])
            rf.write_text(json.dumps({"outcome": outcome, "outputs": outputs}))
            self.walker("record", "--run", run, "--step", step, "--result-file", rf, *sum(
                [["--" + k, v] for k, v in kw.items()], []))
        else:
            self.walker("record", "--run", run, "--step", step, "--outcome", outcome, *sum(
                [["--" + k, v] for k, v in kw.items()], []))
        return out

    def answer_in_app(self, run, step, text, attempt=1):
        """Answer the way the Needs you tab does: it rewrites the record's state and answers."""
        qid = questions.question_id(run, step, attempt)
        path = self.tmp / "questions" / (qid + ".json")
        record = json.loads(path.read_text())
        record["state"] = "answered"
        record["answers"] = {record["questions"][0]["question"]: text}
        path.write_text(json.dumps(record))

    def walk_happy(self, run, spec_path="spec-1"):
        """Feed the sample graph the outcomes of its happy path, up to (not including) the last `next`."""
        self.do_role(run, "design", "ready", {"spec_path": spec_path})
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        self.answer_in_app(run, "approve_spec", "build")
        self.do_role(run, "build", "done")
        self.do_role(run, "review", "pass")
        self.do_role(run, "publish", "opened", {"pr_url": "https://example.test/pr/1"})
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_note")
        self.answer_in_app(run, "approve_note", "post")
        self.do_role(run, "post_note", "posted")
