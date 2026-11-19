"""A made-up Jira, job state and clock for the validation graph's whole-run tests (JP-167).

The walker, the ledger, the graph file and every gate script are real: the walker runs each gate as its own process,
and Jira is a folder-backed fake (JOSH360_JIRA_FAKE). Nothing here uses a model. A gate script reads the clock itself,
so a test lets an interval pass by moving the times in the run's watch files back (`age`), not by changing a clock.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from walker_helpers import ROOT, WalkerCase, runfolder

sys.path.insert(0, str(ROOT / "graphs" / "tests"))
sys.path.insert(0, str(ROOT / "graphs" / "gates"))
import validation_gate_helpers as g  # noqa: E402
from lib import jira_fake  # noqa: E402

KEY = g.KEY
BUG = "JP-9002"
STAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


def _back(value, delta):
    """The same JSON with every time in it moved back by `delta`."""
    if isinstance(value, str) and STAMP.fullmatch(value):
        when = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) - delta
        return when.strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(value, list):
        return [_back(v, delta) for v in value]
    if isinstance(value, dict):
        return {k: _back(v, delta) for k, v in value.items()}
    return value


class ValidationCase(WalkerCase):
    def setUp(self):
        super().setUp()
        self.root = ROOT / "graphs"                      # the real graph, gates and contracts
        self.site = g.Site(self.tmp)                     # a folder-backed Jira at <tmp>/jira, and its seed helpers
        self.fake = self.site.folder
        os.environ["JOSH360_JIRA_FAKE"] = str(self.fake)

    # -- the fake Jira ---------------------------------------------------------------------------------------
    def ticket(self, key=KEY, validation=g.YES, status="Deployed", **kw):
        return self.site.seed(key, status, validation, **kw)

    def bug(self, key=BUG, status="Not Started"):
        return self.site.seed(key, status, issuetype="Bug", labels=("validation-failure",))

    def state(self):
        return json.loads((self.fake / jira_fake.MARKER).read_text())

    def status(self, key=KEY):
        return self.site.status(key)

    def comments(self, key=KEY):
        return self.site.comment_texts(key)

    def writes(self):
        return self.site.writes()

    # -- the job collector's state, under the test's JOSH360_HOME ------------------------------------------
    def job_state(self, job_id, exit_code, minutes_ago=5):
        path = Path(os.environ["JOSH360_HOME"]) / "state" / "jobs-state.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = json.loads(path.read_text()) if path.is_file() else {}
        doc[job_id] = {"last_run": time.time() - minutes_ago * 60, "last_result": exit_code}
        path.write_text(json.dumps(doc))

    # -- the run -------------------------------------------------------------------------------------------
    def begin(self, key=KEY):
        return self.walker("start", "--graph", "validation", "--ticket", key)["run"]

    def watch_folder(self, run):
        return runfolder.work_dir(run) / "watch"

    def age(self, run, hours):
        """Move every time in the run's watch files back by `hours`: an interval has passed."""
        delta = timedelta(hours=hours)
        for path in sorted(self.watch_folder(run).glob("*")):
            if path.suffix == ".json":
                path.write_text(json.dumps(_back(json.loads(path.read_text()), delta)))
            elif path.suffix == ".jsonl":
                rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
                path.write_text("".join(json.dumps(_back(r, delta)) + "\n" for r in rows))

    def walk(self, run):
        """One `next`: the walker runs every gate that is ready and answers at the first thing that is not a gate."""
        return self.walker("next", "--run", run)

    def checks(self, run, n=1):
        """Let `n` check intervals pass, one `next` after each; returns the last answer."""
        out = None
        for _ in range(n):
            self.age(run, 1)
            out = self.walk(run)
        return out

    def end_of(self, run):
        return self.walker("status", "--run", run)["ended"]

    def question(self, run, step="decide", attempt=1):
        from walker_lib import questions
        path = self.tmp / "questions" / (questions.question_id(run, step, attempt) + ".json")
        return json.loads(path.read_text())

    def bugs(self):
        return [k for k in self.site.keys() if self.site.issue(k)["issuetype"]["name"] == "Bug"]
