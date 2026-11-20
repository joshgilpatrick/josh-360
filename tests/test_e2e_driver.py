"""JP-188: the whole-run driver's parts that need no Agent Manager: the scenario files, the stand-in plan, the clock
and the command line. The whole run itself is `python3 scripts/e2e.py --all`, which the CI job `e2e` runs."""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / "tests" / "e2e"
CLOCK = E2E / "clock"

_spec = importlib.util.spec_from_file_location("e2e_driver", str(ROOT / "scripts" / "e2e.py"))
e2e = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(e2e)

sys.path.insert(0, str(ROOT / "graphs" / "runner"))
from runner_lib import watch  # noqa: E402

CHECKS = {"end", "jira_status", "one_session_per_role_step", "sessions_follow_status", "stopped_at", "within_minutes",
          "runner_log_names"}


class Scenarios(unittest.TestCase):
    def test_there_is_a_happy_run_and_a_stopped_run(self):
        self.assertIn("triage-happy", e2e.scenarios())
        self.assertIn("undeclared-output", e2e.scenarios())

    def test_each_scenario_is_a_shape_the_driver_can_run(self):
        for name, doc in e2e.scenarios().items():
            with self.subTest(name):
                self.assertTrue(doc.get("about"))
                self.assertTrue((ROOT / "graphs" / "compiled" / "{}.json".format(doc["graph"])).is_file())
                self.assertTrue(doc["ticket"].startswith("JP-9"), "made-up keys only")
                with tempfile.TemporaryDirectory() as tmp:          # the laptop's own reader accepts the starts
                    path = Path(tmp) / "starts.json"
                    path.write_text(json.dumps(doc["starts"]), encoding="utf-8")
                    rules = watch.load_rules(path)
                self.assertTrue(rules["graphs"][doc["graph"]]["on"])
                self.assertTrue(doc["expect"])
                self.assertFalse(set(doc["expect"]) - CHECKS, "a check the driver does not know")
                self.assertGreater(float(doc.get("limit_minutes", 120)), 0)

    def test_every_scenario_file_a_plan_names_exists(self):
        for name, doc in e2e.scenarios().items():
            plan = e2e.standin_plan(doc)
            for step, value in (plan.get("steps") or {}).items():
                if value.endswith(".json"):
                    with self.subTest(name=name, step=step):
                        self.assertTrue(Path(value).is_absolute())
                        played = json.loads(Path(value).read_text(encoding="utf-8"))
                        self.assertIn("kind", played)

    def test_the_stopped_run_names_an_output_its_session_writes(self):
        doc = e2e.scenario("undeclared-output")
        played = json.loads(Path(e2e.standin_plan(doc)["steps"][doc["expect"]["stopped_at"]]).read_text())
        for name in doc["expect"]["runner_log_names"]:
            self.assertIn(name, played["outputs"])

    def test_an_unknown_scenario_is_a_harness_problem(self):
        with self.assertRaises(e2e.Problem):
            e2e.scenario("no-such-run")


class Clock(unittest.TestCase):
    PROBE = ("import time, datetime, json; "
             "print(json.dumps([time.time(), datetime.datetime.now().timestamp(), "
             "time.mktime(time.localtime()), time.monotonic()]))")

    def probe(self, offset=None, file=None):
        env = dict(os.environ, PYTHONPATH=str(CLOCK))
        env.pop("JOSH360_E2E_CLOCK", None)
        with tempfile.TemporaryDirectory() as tmp:
            if offset is not None or file is not None:
                path = Path(file) if file else Path(tmp) / "clock"
                if offset is not None:
                    path.write_text(str(offset), encoding="utf-8")
                env["JOSH360_E2E_CLOCK"] = str(path)
            import time
            before = time.time()
            out = subprocess.run([sys.executable, "-c", self.PROBE], env=env, capture_output=True, text=True,
                                 check=True).stdout
        return before, json.loads(out)

    def test_the_wall_clocks_run_ahead_by_the_offset(self):
        before, (now, dt_now, local, _mono) = self.probe(offset=86400)
        for value in (now, dt_now, local):
            self.assertAlmostEqual(value - before, 86400, delta=30)

    def test_without_the_variable_or_with_an_unreadable_file_nothing_moves(self):
        before, (now, dt_now, _local, _mono) = self.probe()
        self.assertAlmostEqual(now - before, 0, delta=30)
        self.assertAlmostEqual(dt_now - before, 0, delta=30)
        before, (now, _dt, _local, _mono) = self.probe(file="/nonexistent/clock")
        self.assertAlmostEqual(now - before, 0, delta=30)


class CommandLine(unittest.TestCase):
    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            try:
                code = e2e.main(list(argv))
            except SystemExit as stop:
                code = stop.code
        return code, out.getvalue()

    def test_list_prints_each_scenario_and_what_it_proves(self):
        code, out = self.run_main("--list")
        self.assertEqual(code, 0)
        listed = json.loads(out)
        self.assertEqual(set(listed), set(e2e.scenarios()))
        self.assertTrue(all(listed.values()))

    def test_a_scenario_or_all_is_required_and_not_both(self):
        self.assertEqual(self.run_main()[0], 2)
        self.assertEqual(self.run_main("--scenario", "triage-happy", "--all")[0], 2)

    def test_an_unknown_scenario_exits_2_before_anything_starts(self):
        code, out = self.run_main("--scenario", "no-such-run")
        self.assertEqual(code, 2)
        self.assertIn("no-such-run", json.loads(out)["error"])


if __name__ == "__main__":
    unittest.main()
