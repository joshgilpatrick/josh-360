"""Made-up settings, a fake agent-manager and its database, a fake Jira and a made-up Claude settings file for the
graph runner's tests (JP-117). Nothing real here; no test reaches Agent Manager, Jira or a model."""
import json
import os
import sys
from pathlib import Path

from walker_helpers import ROOT, WalkerCase, db, questions, runfolder  # noqa: F401

sys.path.insert(0, str(ROOT / "graphs" / "runner"))
sys.path.insert(0, str(ROOT / "graphs" / "bindings" / "agent-manager"))
from runner_lib import paths  # noqa: E402

FAKE_AM = ROOT / "tests" / "fakes" / "agent-manager"
DISPATCH = "/x/josh-360/repo/hooks/dispatch"
START = 1795000000.0


class RunnerCase(WalkerCase):
    """WalkerCase plus the runner's settings file, the fake agent-manager, a fake Jira and a clock."""

    def setUp(self):
        super().setUp()
        self.now = START
        self.settings_path = self.tmp / "runner-settings.json"
        self.settings()
        self.am_dir = self.tmp / "am"
        self.am_dir.mkdir()
        self.jira_dir = self.tmp / "jira"
        self.jira_dir.mkdir()
        (self.jira_dir / "fake-jira.json").write_text(json.dumps({"apply_jql": True}))
        self.claude_settings = self.tmp / "claude-settings.json"
        self.write_claude_settings()
        os.environ.update({
            "JOSH360_RUNNER_SETTINGS": str(self.settings_path), "FAKE_AM_DIR": str(self.am_dir),
            "JOSH360_AM_BIN": str(FAKE_AM), "JOSH360_AM_DB": str(self.am_dir / "state.db"),
            "JOSH360_JIRA_FAKE": str(self.jira_dir), "JOSH360_CLAUDE_SETTINGS": str(self.claude_settings),
            "JOSH360_NO_NOTIFY": "1"})

    def settings(self, **changes):
        doc = dict(paths.DEFAULTS)
        doc.update(changes)
        self.settings_path.write_text(json.dumps(doc))

    def write_claude_settings(self, without=None):
        hooks = {event: [{"hooks": [{"type": "command", "command": "{} {}".format(DISPATCH, event)}]}]
                 for event in paths.EVENTS if event != without}
        self.claude_settings.write_text(json.dumps({"hooks": hooks}))

    # -- the fake Jira -----------------------------------------------------------------------------------------
    def jira_file(self):
        return self.jira_dir / "fake-jira.json"

    def jira_state(self, **changes):
        state = json.loads(self.jira_file().read_text())
        state.update(changes)
        self.jira_file().write_text(json.dumps(state))

    def jira_issue(self, key, status="Ready", sprint=True, issuetype="Story", route="default", spec=None):
        """Add a made-up ticket: in an open sprint or the backlog, with a route record (`route=None` for none)."""
        state = json.loads(self.jira_file().read_text())
        state.setdefault("issues", {})[key] = {"key": key, "fields": {
            "status": {"name": status}, "issuetype": {"name": issuetype},
            "customfield_10020": [{"state": "active"}] if sprint else []}}
        props = state.setdefault("properties", {})
        if route == "default":
            route = {"graph": "runner-sample", "system": "sample", "returned_from": ""}
        if route is not None:
            props["{}|josh360.route".format(key)] = route
        if spec is not None:
            props["{}|action-triage.spec".format(key)] = spec
        self.jira_file().write_text(json.dumps(state))

    def jira_calls(self):
        path = self.jira_dir / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def end_sample_run(self, ticket="JP-901"):
        """Walk a runner-sample run to its end (Josh says stop at `confirm`); returns the run id."""
        run = self.walker("start", "--graph", "runner-sample", "--ticket", ticket, "--runner", "agent-manager")["run"]
        self.do_role(run, "draft", "ready", {"note": "a made-up note"})
        self.assertEqual(self.walker("next", "--run", run)["step"], "confirm")
        self.answer_in_app(run, "confirm", "stop")
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        return run

    # -- the fake agent-manager --------------------------------------------------------------------------------
    def am_calls(self, word):
        path = self.am_dir / "calls.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []
        return [r for r in rows if r and r[0] == word]

    def am_set(self, session_id, status=None, archived=None):
        import sqlite3
        conn = sqlite3.connect(str(self.am_dir / "state.db"))
        try:
            if status is not None:
                conn.execute("UPDATE sessions SET status = ? WHERE id = ?", (status, session_id))
            if archived is not None:
                conn.execute("UPDATE sessions SET archived = ? WHERE id = ?", (archived, session_id))
            conn.commit()
        finally:
            conn.close()

    def am_behaviour(self, **doc):
        (self.am_dir / "behaviour.json").write_text(json.dumps(doc))

    # -- step sessions (hooks) ---------------------------------------------------------------------------------
    def fake_spawn(self, run, key="0123456789abcdef"):
        """What `advance` does for a step: write its session file, spawn through the binding, mark it started.
        Returns the session file's document. (Task 9's advance writes the same shape.)"""
        import binding
        from runner_lib import hooklib, sessionfile
        a = self.walker("next", "--run", run)
        self.assertEqual(a["action"], "run", a)
        doc = {"run": run, "step": a["step"], "attempt": a["attempt"], "graph": a["graph"], "ticket": a["ticket"],
               "access": a["access"], "tier": a["tier"], "outcomes": a["outcomes"], "result_file": a["result_file"],
               "work_dir": a["work_dir"], "key": key, "state": "spawning", "intent_at": self.now, "started_at": None,
               "handle": None, "comments": "", "resting_since": None, "spawn_failures": 0, "ended_at": None,
               "reason": None, "closed": None}
        sessionfile.write(run, a["step"], a["attempt"], doc)
        doc["handle"] = binding.start(a, hooklib.marker(run, a["step"], a["attempt"], key), "")
        doc.update(state="started", started_at=self.now)
        sessionfile.write(run, a["step"], a["attempt"], doc)
        return doc

    def logged_prompt(self, run, step, attempt=1):
        for call in self.am_calls("spawn"):
            prompt = call[call.index("--prompt") + 1]
            if "run={} step={} attempt={} ".format(run, step, attempt) in prompt.splitlines()[0]:
                return prompt
        raise AssertionError("no spawn was logged for {} {} {}".format(run, step, attempt))

    def session_starts(self, run, step, attempt=1, session_id="cc-1"):
        """The session's first prompt reaches the link hook; returns the entry it wrote (or None)."""
        from runner_lib import hooklib
        prompt = self.logged_prompt(run, step, attempt)
        am = "s-1"
        for call in self.am_calls("spawn"):
            if prompt == call[call.index("--prompt") + 1]:
                am = "s-{}".format(self.am_calls("spawn").index(call) + 1)
        hooklib.link({"session_id": session_id, "prompt": prompt}, {"AGENT_MANAGER_SESSION_ID": am}, self.now)
        return hooklib.entry(session_id)

    def later(self, seconds):
        self.now += seconds
        return self.now
