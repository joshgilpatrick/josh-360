"""JP-111: the job that keeps the headless Session Atlas running under launchd. A made-up HOME, a fake `launchctl` and a fake `node`."""
from __future__ import annotations

import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import REPO

SCRIPT = REPO / "scripts" / "atlas_service.py"
LABEL = "com.josh360.session-atlas"

FAKE_LAUNCHCTL = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  print) [ "$(cat "$FAKE_STATE")" = loaded ] && exit 0 || exit 113 ;;
  bootstrap) [ -n "$FAKE_BOOTSTRAP_FAILS" ] && exit 5; echo loaded > "$FAKE_STATE"; exit 0 ;;
  kickstart) exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
"""


def executable(path: Path, body: str) -> Path:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class AtlasServiceTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-atlas-svc-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.j360 = self.home / ".josh-360"
        (self.j360 / "state").mkdir(parents=True)
        self.set_retired(0)
        self.fake = executable(self.tmp / "launchctl", FAKE_LAUNCHCTL)
        self.node = executable(self.tmp / "node", '#!/bin/sh\necho "v22.23.5"\n')
        self.state = self.tmp / "state"
        self.state.write_text("unloaded")
        self.log = self.tmp / "calls.log"
        self.log.write_text("")
        self.plist = self.home / "Library" / "LaunchAgents" / (LABEL + ".plist")

    def set_retired(self, code):
        (self.j360 / "state" / "jobs-state.json").write_text(json.dumps({"retire-session-atlas": {"last_run": 1, "last_result": code}}))

    def run_job(self, *args, **extra):
        env = dict(os.environ, HOME=str(self.home), JOSH360_HOME=str(self.j360), JOSH360_LAUNCHCTL=str(self.fake),
                   JOSH360_NODE=str(self.node), FAKE_STATE=str(self.state), FAKE_LOG=str(self.log), PYTHONDONTWRITEBYTECODE="1")
        env.update(extra)
        return subprocess.run([sys.executable, str(SCRIPT)] + list(args), env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)

    def calls(self):
        return [c.split()[0] for c in self.log.read_text().splitlines()]

    def test_installs_and_loads_it(self):
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"], "ok")
        self.assertEqual(self.state.read_text().strip(), "loaded")
        p = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(p["Label"], LABEL)
        self.assertEqual(p["ProgramArguments"][0], str(self.node))
        self.assertTrue(p["ProgramArguments"][-1].endswith("apps/session-atlas/src/service/main.ts"))
        self.assertTrue(p["KeepAlive"])
        self.assertEqual(p["EnvironmentVariables"]["JOSH360_HOME"], str(self.j360))
        self.assertIn("bootstrap", self.calls())

    def test_a_second_run_changes_nothing(self):
        self.run_job()
        self.log.write_text("")
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(set(self.calls()), {"print"})
        self.assertIn("already running on the latest code", json.loads(r.stdout)["actions"])

    def test_new_code_restarts_it(self):
        self.run_job()
        saved = self.j360 / "state" / "session-atlas-service.json"
        saved.write_text(json.dumps({"revision": "an-older-revision", "plist_sha": "x"}))
        self.log.write_text("")
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("kickstart", self.calls())
        self.assertNotEqual(json.loads(saved.read_text())["revision"], "an-older-revision")

    def test_a_service_that_was_stopped_is_loaded_again(self):
        self.run_job()
        self.state.write_text("unloaded")
        self.log.write_text("")
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("bootstrap", self.calls())

    def test_waits_until_the_old_atlas_is_retired(self):
        self.set_retired(1)
        r = self.run_job()
        self.assertEqual(r.returncode, 0)
        self.assertEqual(json.loads(r.stdout)["result"], "waiting")
        self.assertFalse(self.plist.exists())
        self.assertEqual(self.calls(), ["print"])

    def test_old_node_is_refused(self):
        executable(self.node, '#!/bin/sh\necho "v20.1.0"\n')
        r = self.run_job()
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["result"], "failed")
        self.assertFalse(self.plist.exists())

    def test_a_failed_load_is_a_failure_to_retry(self):
        r = self.run_job(FAKE_BOOTSTRAP_FAILS="1")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["result"], "failed")

    def test_dry_run_changes_nothing(self):
        r = self.run_job("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.plist.exists())
        self.assertEqual(self.calls(), ["print"])

    def test_only_that_one_label_is_ever_named(self):
        self.run_job()
        for call in self.log.read_text().splitlines():
            self.assertIn(LABEL, call)

    def test_not_a_mac_touches_nothing(self):
        r = self.run_job(JOSH360_LAUNCHCTL=str(self.tmp / "no-such-launchctl"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"], "skipped")
        self.assertFalse(self.plist.exists())


if __name__ == "__main__":
    unittest.main()
