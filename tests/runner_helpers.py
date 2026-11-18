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

    def later(self, seconds):
        self.now += seconds
        return self.now
