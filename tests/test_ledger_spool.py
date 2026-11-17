"""JP-107, Task 3: the hook spool. Made-up hook input only."""
import json
import os
import subprocess
import sys
import tempfile
import shutil
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import ROOT  # noqa: E402
from ledger import spool  # noqa: E402

KEYS = {"event", "at", "session_id", "transcript_path", "cwd", "source", "reason", "started_by"}
INPUT = {"session_id": "sess-0001", "transcript_path": "/tmp/made-up/sess-0001.jsonl", "cwd": "/tmp/made-up/josh_360",
         "hook_event_name": "SessionEnd", "reason": "other", "prompt": "THE MADE-UP PROMPT TEXT"}


class SpoolCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-spool-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self.env = {k: v for k, v in os.environ.items() if k not in (
            "JOSH360_RUN_ID", "ACTION_TRIAGE_TICKET_KEY", "ACTION_TRIAGE_ALLOW_ATLASSIAN_WRITES", "DESK_WORKER",
            "AGENT_MANAGER_SESSION_ID")}
        self.env["JOSH360_HOME"] = str(self.home)
        self.env["PYTHONDONTWRITEBYTECODE"] = "1"

    def run_hook(self, event, payload, env=None, via_dispatch=False):
        e = dict(env or self.env)
        args = [str(ROOT / "hooks" / "dispatch"), event] if via_dispatch else [
            sys.executable, str(ROOT / "hooks" / event / "20-ledger-spool")]
        return subprocess.run(args, input=payload if isinstance(payload, str) else json.dumps(payload), env=e,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def lines(self):
        folder = self.home / "state" / "ledger-spool"
        out = []
        for p in sorted(folder.glob("*.jsonl")) if folder.is_dir() else []:
            out += [json.loads(line) for line in p.read_text().splitlines()]
        return out


class Hook(SpoolCase):
    def test_session_end_appends_one_line_with_only_the_listed_keys(self):
        result = self.run_hook("SessionEnd", INPUT)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(set(lines[0]), KEYS)
        self.assertEqual(lines[0]["event"], "SessionEnd")
        self.assertEqual(lines[0]["reason"], "other")
        self.assertIsNone(lines[0]["source"])
        self.assertNotIn("MADE-UP PROMPT", json.dumps(lines))

    def test_session_start_records_source_and_who_started_it(self):
        env = dict(self.env, AGENT_MANAGER_SESSION_ID="am-1")
        self.run_hook("SessionStart", dict(INPUT, source="startup", hook_event_name="SessionStart"), env=env)
        line = self.lines()[0]
        self.assertEqual((line["event"], line["source"], line["reason"], line["started_by"]),
                         ("SessionStart", "startup", None, "agent-manager"))

    def test_bad_input_exits_0_and_writes_nothing(self):
        for bad in ("not json", "{}", json.dumps({"session_id": ""}), json.dumps({"session_id": "../x"}),
                    json.dumps(["session_id"]), ""):
            result = self.run_hook("SessionEnd", bad)
            self.assertEqual(result.returncode, 0, bad)
        self.assertEqual(self.lines(), [])

    def test_hook_runs_under_dispatch(self):
        result = self.run_hook("SessionEnd", INPUT, via_dispatch=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.lines()), 1)

    def test_hook_never_opens_the_database(self):
        self.run_hook("SessionEnd", INPUT)
        self.run_hook("SessionStart", dict(INPUT, source="startup"))
        self.assertFalse((self.home / "state" / "ledger.db").exists())
        self.assertEqual(sorted(p.name for p in (self.home / "state").iterdir()), ["ledger-spool"])

    def test_a_failing_spool_exits_0_and_logs_without_the_input(self):
        (self.home / "state").mkdir(parents=True)
        (self.home / "state" / "ledger-spool").write_text("a file where the folder should be")
        result = self.run_hook("SessionEnd", INPUT)
        self.assertEqual(result.returncode, 0)
        log = (self.home / "logs" / "hooks.log").read_text()
        self.assertIn("SessionEnd failed", log)
        self.assertNotIn("sess-0001", log)

    def test_long_paths_are_cut(self):
        self.run_hook("SessionEnd", dict(INPUT, cwd="/" + "a" * 5000))
        self.assertEqual(len(self.lines()[0]["cwd"]), 1000)


class StartedBy(unittest.TestCase):
    def test_started_by_from_environment(self):
        self.assertEqual(spool.started_by({"AGENT_MANAGER_SESSION_ID": "am-1"}), "agent-manager")
        self.assertEqual(spool.started_by({"ACTION_TRIAGE_TICKET_KEY": "JP-900", "AGENT_MANAGER_SESSION_ID": "am-1"}), "daemon")
        self.assertEqual(spool.started_by({"ACTION_TRIAGE_ALLOW_ATLASSIAN_WRITES": "0"}), "daemon")
        self.assertEqual(spool.started_by({"JOSH360_RUN_ID": "run-1", "AGENT_MANAGER_SESSION_ID": "am-1"}), "walker")
        self.assertEqual(spool.started_by({"DESK_WORKER": "1", "AGENT_MANAGER_SESSION_ID": "am-1"}), "desk")
        self.assertEqual(spool.started_by({"DESK_WORKER": "0", "AGENT_MANAGER_SESSION_ID": "am-1"}), "agent-manager")
        self.assertEqual(spool.started_by({"JOSH360_RUN_ID": ""}), "josh")
        self.assertEqual(spool.started_by({}), "josh")

    def test_started_by_reads_codes_json(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        codes = json.loads(spool.CODES.read_text())
        codes["started_by_env"]["rules"][-1]["started_by"] = "background"
        (tmp / "codes.json").write_text(json.dumps(codes))
        self.assertEqual(spool.started_by({"AGENT_MANAGER_SESSION_ID": "am-1"}, tmp / "codes.json"), "background")
        self.assertEqual(spool.started_by({"AGENT_MANAGER_SESSION_ID": "am-1"}), "agent-manager")

    def test_module_holds_no_list_of_its_own(self):
        source = (ROOT / "ledger" / "spool.py").read_text()
        for name in ("AGENT_MANAGER_SESSION_ID", "ACTION_TRIAGE_TICKET_KEY", "JOSH360_RUN_ID", "DESK_WORKER"):
            self.assertNotIn(name, source)


class Reading(SpoolCase):
    def test_read_since_returns_only_new_lines_and_skips_a_partial_last_line(self):
        folder = self.tmp / "spool"
        spool.append("SessionStart", {"session_id": "a"}, "2026-11-17T10:00:00Z", folder)
        spool.append("SessionEnd", {"session_id": "a"}, "2026-11-17T10:30:00Z", folder)
        lines, mark = spool.read_since(folder, {})
        self.assertEqual([l["event"] for l in lines], ["SessionStart", "SessionEnd"])
        again, mark2 = spool.read_since(folder, mark)
        self.assertEqual(again, [])
        self.assertEqual(mark2, mark)
        spool.append("SessionStart", {"session_id": "b"}, "2026-11-17T11:00:00Z", folder)
        with (folder / "2026-11-17.jsonl").open("ab") as f:
            f.write(b'{"event":"SessionEnd","session_id":"b"')  # still being written: no newline
        new, mark3 = spool.read_since(folder, mark2)
        self.assertEqual([l["session_id"] for l in new], ["b"])
        with (folder / "2026-11-17.jsonl").open("ab") as f:
            f.write(b',"at":"x"}\n')
        done, mark4 = spool.read_since(folder, mark3)
        self.assertEqual([l["event"] for l in done], ["SessionEnd"])
        self.assertEqual(spool.read_since(folder, mark4)[0], [])

    def test_read_since_crosses_days_and_skips_junk(self):
        folder = self.tmp / "spool"
        spool.append("SessionStart", {"session_id": "a"}, "2026-11-17T23:59:00Z", folder)
        _, mark = spool.read_since(folder, {})
        with (folder / "2026-11-17.jsonl").open("ab") as f:
            f.write(b"not json\n")
        spool.append("SessionEnd", {"session_id": "a"}, "2026-11-18T00:01:00Z", folder)
        lines, mark2 = spool.read_since(folder, mark)
        self.assertEqual([l["event"] for l in lines], ["SessionEnd"])
        self.assertEqual(mark2["file"], "2026-11-18.jsonl")

    def test_a_missing_folder_reads_nothing(self):
        self.assertEqual(spool.read_since(self.tmp / "none", {}), ([], {"file": "", "offset": 0}))


if __name__ == "__main__":
    unittest.main()
