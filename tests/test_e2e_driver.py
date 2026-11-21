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
          "runner_log_names", "admitted", "claude_found", "spawns", "cap_used", "step_outcomes",
          "graph_runner_within_seconds", "ledger_record_busy_seconds", "jira_path", "pull_request", "nothing_left",
          "hand_over_within_passes"}
# JP-190: each failure found on the laptop in the week of 16 November 2026, and the runs that would have caught it.
LAPTOP_FAILURES = {
    "empty binding.json models map (6b03062)": ["bad-model-map", "triage-happy"],
    "a refusal that can never pass spends the tier cap (JP-183)": ["permanent-refusal", "bad-model-map"],
    "the revise result shape refused (JP-184)": ["triage-revise"],
    "ledger-record holds up the five-minute jobs (JP-181)": ["ledger-record-pace"],
    "gates miss the Jira email in state/jira-email (JP-171)": ["triage-happy", "triage-revise"],
    "claude is not installed under a job's PATH": ["triage-happy"],
    "the run cap stops the loop back to a re-read after the drafter's last run (JP-194, JP-116's run)": ["triage-revise-at-cap"],
}


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
            for step, values in (plan.get("steps") or {}).items():
                for value in values if isinstance(values, list) else [values]:   # one per attempt (JP-194)
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

    def test_the_development_run_starts_where_its_rule_and_its_gates_admit_it(self):
        """JP-198: the fixture is one the development start rule picks up, whose Validation section asks for a watch,
        and the spec the designer writes is one lint-spec passes for the fixture's own scenarios."""
        sys.path.insert(0, str(ROOT / "graphs" / "gates"))
        from lib import dev_spec, validation_section
        doc = e2e.scenario("dev-happy")
        laptop_rules = json.loads((ROOT / "graphs" / "runner" / "starts.json").read_text())["graphs"]
        for graph in ("development", "validation"):              # the laptop's own rules, word for word
            self.assertEqual(doc["starts"]["graphs"][graph], laptop_rules[graph])
        self.assertEqual(doc["fixture"]["status"], "Ready")
        self.assertTrue(doc["route_signed"])
        self.assertTrue(validation_section.needs_watch(doc["fixture"]["description"]))
        plan = e2e.standin_plan(doc)
        spec = json.loads(Path(plan["steps"]["design"]).read_text())["companions"]["spec_path"]
        names = dev_spec.scenario_names(doc["fixture"]["description"])
        self.assertEqual(names, ["The page lists this week's chores"])     # the Validation scenario is left out
        self.assertEqual(dev_spec.problems(spec, names), [])
        build = json.loads(Path(plan["steps"]["build"]).read_text())
        for check in spec["phases"][0]["checks"]:                           # the builder's commit is what they test
            self.assertTrue(any(name in check for name in build["commit"]["files"]), check)
        self.assertEqual(doc["expect"]["jira_path"][0], doc["fixture"]["status"])
        self.assertEqual(doc["expect"]["jira_path"][-1], doc["expect"]["jira_status"])

    def test_an_unknown_scenario_is_a_harness_problem(self):
        with self.assertRaises(e2e.Problem):
            e2e.scenario("no-such-run")

    def test_every_laptop_failure_this_week_has_a_run(self):
        for failure, runs in LAPTOP_FAILURES.items():
            for name in runs:
                with self.subTest(failure=failure, run=name):
                    self.assertIn(name, e2e.scenarios())
        expect = {n: d["expect"] for n, d in e2e.scenarios().items()}
        self.assertTrue(expect["triage-happy"]["admitted"] and expect["triage-happy"]["claude_found"])
        self.assertEqual(expect["bad-model-map"]["spawns"], 1)
        self.assertEqual(expect["permanent-refusal"]["cap_used"], {"sign_off": 0})
        self.assertEqual(expect["triage-revise"]["step_outcomes"], {"revise": "revised"})
        self.assertEqual(expect["ledger-record-pace"]["graph_runner_within_seconds"], 300)

    def test_the_empty_map_run_empties_only_the_models(self):
        doc = e2e.scenario("bad-model-map")
        self.assertEqual(doc["binding"], {"models": {}})

    def test_the_refusal_run_drops_the_model_sign_offs_tier_maps_to(self):
        doc = e2e.scenario("permanent-refusal")
        binding = json.loads((ROOT / "graphs" / "bindings" / "agent-manager" / "binding.json").read_text())
        compiled = json.loads((ROOT / "graphs" / "compiled" / "triage.json").read_text())
        tier = compiled["roles"]["sign-off"]["tier"]                  # the role sign_off plays
        mapped = [binding["models"][e["model"]] for e in compiled["tiers"][tier]]
        self.assertTrue(mapped, "sign_off has a tier")
        self.assertFalse(set(mapped) & set(doc["claude_lists"]), "every model the tier maps to is unlisted")

    def test_the_revise_run_starts_with_exactly_one_gap(self):
        doc = e2e.scenario("triage-revise")
        self.assertNotIn("**Validation:**", doc["fixture"]["description"])
        played = json.loads(Path(e2e.standin_plan(doc)["steps"]["revise"]).read_text())
        self.assertEqual(played["example_outcome"], "revised")
        self.assertEqual(played["companions"]["proposal"]["tickets"][0]["key"], doc["ticket"])


class Pace(unittest.TestCase):
    """JP-181's check reads when each job began from the job logs, on the laptop's clock."""

    def test_graph_runner_must_start_within_the_bound_of_each_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            laptop = type("L", (), {})()
            laptop.josh, laptop.evidence = Path(tmp) / "josh", Path(tmp) / "evidence"
            (laptop.josh / "logs").mkdir(parents=True)
            laptop.evidence.mkdir()
            began = [1795000000.0, 1795000300.0]
            (laptop.evidence / "passes.jsonl").write_text("".join(
                json.dumps({"pass": n + 1, "started_at": t}) + "\n" for n, t in enumerate(began)))

            def stamp(t):
                import datetime
                return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            (laptop.josh / "logs" / "ledger-record.log").write_text(
                "=== {} exit 0\n=== {} exit 0\n".format(stamp(began[0] + 5), stamp(began[1] + 5)))
            (laptop.josh / "logs" / "graph-runner.log").write_text(
                "=== {} exit 0\n=== {} exit 0\n".format(stamp(began[0] + 160), stamp(began[1] + 400)))
            checks = e2e._pace(laptop, {"graph_runner_within_seconds": 300, "ledger_record_busy_seconds": 150})
        self.assertFalse(checks[0]["ok"])                        # the second pass began graph-runner 400 s in
        self.assertEqual([r["graph_runner_after_seconds"] for r in checks[0]["detail"]], [160, 400])
        self.assertTrue(checks[1]["ok"])


class Backlog(unittest.TestCase):
    def test_the_backlog_is_quiet_made_up_sessions_each_on_its_own_ticket(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "projects" / "-made-up"
            e2e.made_up_backlog(folder, 5)
            files = sorted(folder.glob("*.jsonl"))
            self.assertEqual(len(files), 5)
            branches = {json.loads(f.read_text().splitlines()[0])["gitBranch"] for f in files}
            self.assertEqual(len(branches), 5)
            import time
            self.assertTrue(all(time.time() - f.stat().st_mtime > 600 for f in files))

    def test_the_recorders_jira_answers_reads_and_refuses_writes(self):
        import urllib.error
        import urllib.request
        server = e2e.recorder_jira(0)
        try:
            base = "http://127.0.0.1:{}".format(server.server_address[1])
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            issue = json.loads(opener.open(base + "/rest/api/3/issue/JP-20001?fields=*all").read())
            self.assertEqual(issue["fields"]["parent"]["key"], e2e.BACKLOG_EPIC)
            page = json.loads(opener.open(base + "/rest/api/3/issue/JP-20001/comment?startAt=0").read())
            self.assertEqual(page["comments"], [])
            with self.assertRaises(urllib.error.HTTPError):
                opener.open(urllib.request.Request(base + "/rest/api/3/issue/JP-1", data=b"{}", method="POST"))
        finally:
            server.shutdown()
            server.server_close()


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
