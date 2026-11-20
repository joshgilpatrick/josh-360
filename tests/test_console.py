"""JP-185: the live console (scripts/console.py) over a made-up home (tests/console_fixture.py)."""
import io
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import console  # noqa: E402
import console_fixture as fx  # noqa: E402
from console_lib import events as ev  # noqa: E402

ESC = "\033["


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-console-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self._env = {k: os.environ.get(k) for k in ("JOSH360_HOME", "NO_COLOR", "TZ")}
        self.addCleanup(self._restore)
        os.environ["JOSH360_HOME"] = str(self.home)
        os.environ["TZ"] = "UTC"
        os.environ.pop("NO_COLOR", None)

    def _restore(self):
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def run_console(self, *args, **kw):
        out = io.StringIO()
        code = console.main(list(args), out=out, **kw)
        self.assertEqual(code, 0)
        return out.getvalue()


class OneStream(Base):
    def setUp(self):
        super().setUp()
        fx.build(self.home)
        run_log = self.home / "logs" / "runner" / "run-{}.log".format(fx.RUN2)
        when = 1795183860  # 2026-11-20T14:11:00Z
        os.utime(str(run_log), (when, when))

    def test_every_source_in_time_order(self):
        lines = self.run_console("--once", "--since", "all", "--no-color").splitlines()
        sources = [line.split()[1] for line in lines]
        for source in ("session", "graph", "runner", "job", "hooks", "advance"):
            self.assertIn(source, sources)
        joined = "\n".join(lines)
        for text in ("run started: development on JP-901", "role build started", "role build ended: _abandoned",
                     "gate verify_build ended: passed", "question for Josh", "doctor failed, exit 1",
                     "20-graph-step-guard blocked", "walker: next step is triage", "session sess-000 started"):
            self.assertIn(text, joined)
        times = [line.split()[0] for line in lines]
        self.assertEqual(times, sorted(times))
        self.assertNotIn("report output", joined)
        self.assertIn("\u2026 more in logs/doctor.log", joined)

    def test_runner_lines_get_the_run_ticket(self):
        out = self.run_console("--once", "--since", "all", "--no-color", "--source", "runner")
        self.assertTrue(all("JP-901" in line for line in out.splitlines()))

    def test_important_lines_stand_out(self):
        lines = self.run_console("--once", "--since", "all", "--color").splitlines()

        def find(text):
            return next(line for line in lines if text in line)

        red, yellow = ESC + "1;31m", ESC + "1;33m"
        self.assertIn(red + "\u2716", find("doctor failed, exit 1"))
        self.assertIn(red + "\u2716", find("blocked (exit 2)"))
        self.assertIn(red, find("ValueError: sample"))
        self.assertIn(yellow + "\u25a0", find("_abandoned"))
        self.assertIn("NEEDS JOSH", find("question for Josh"))
        self.assertIn(ESC + "1;97;45m", find("question for Josh"))
        self.assertIn(ESC + "32m\u2714", find("verify_build ended: passed"))
        self.assertIn(ESC + "36m\u25b6", find("role build started"))
        self.assertIn(ESC + "1;4;94mJP-901", find("role build started"))

    def test_no_color(self):
        self.assertNotIn("\033", self.run_console("--once", "--since", "all", "--no-color"))
        os.environ["NO_COLOR"] = "1"
        self.assertNotIn("\033", self.run_console("--once", "--since", "all", "--color"))

    def test_no_color_when_piped(self):
        self.assertNotIn("\033", self.run_console("--once", "--since", "all"))   # StringIO is not a terminal

    def test_since_cuts_older_lines(self):
        now = 1795183800 + 30  # 2026-11-20T14:10:30Z
        out = self.run_console("--once", "--since", "2m", "--no-color", now=lambda: now)
        self.assertIn("blocked (exit 2)", out)
        self.assertNotIn("run started", out)

    def test_source_filter(self):
        out = self.run_console("--once", "--since", "all", "--no-color", "--source", "hooks")
        self.assertEqual(len(out.splitlines()), 1)


class Following(Base):
    def test_new_lines_and_new_run_logs_show(self):
        fx.build(self.home)
        runner = self.home / "logs" / "runner"
        sleeps = []

        def sleep(_seconds):
            sleeps.append(1)
            if len(sleeps) == 1:
                with open(str(runner / "runner.log"), "a", encoding="utf-8") as handle:
                    handle.write("2026-11-20T14:15:00Z advance {}: recorded build attempt 2\n".format(fx.RUN))
                (runner / "run-r-0000ee55ff66.log").write_text("Traceback (most recent call last):\n",
                                                               encoding="utf-8")

        out = self.run_console("--since", "all", "--no-color", "--poll", "0", sleep=sleep, polls=2)
        tail = out.split("walker: next step is triage")[-1]
        self.assertIn("recorded build attempt 2", tail)
        self.assertIn("Traceback", tail)

    def test_replaced_log_is_read_from_its_start(self):
        fx.build(self.home)
        hooks = self.home / "logs" / "hooks.log"
        sleeps = []

        def sleep(_seconds):
            sleeps.append(1)
            if len(sleeps) == 1:
                os.replace(str(hooks), str(hooks.with_name("hooks.log.1")))
                hooks.write_text("2026-11-20T14:16:00Z Stop 20-graph-step-stop failed (exit 1), skipped\n",
                                 encoding="utf-8")

        out = self.run_console("--since", "all", "--no-color", "--poll", "0", sleep=sleep, polls=2)
        self.assertIn("20-graph-step-stop failed", out)

    def test_heartbeat_written_when_asked(self):
        self.run_console("--since", "all", "--no-color", "--heartbeat", "--poll", "0", sleep=lambda s: None, polls=2)
        self.assertTrue((self.home / "state" / "console-heartbeat.json").is_file())


class MissingSources(Base):
    def test_missing_sources_are_named_once_and_the_rest_shows(self):
        (self.home / "logs").mkdir(parents=True)
        (self.home / "logs" / "hooks.log").write_text("2026-11-20T14:10:00Z PreToolUse x blocked (exit 2)\n",
                                                      encoding="utf-8")
        out = self.run_console("--since", "all", "--no-color", "--poll", "0", sleep=lambda s: None, polls=3)
        self.assertEqual(out.count("not there yet"), 1)
        self.assertIn("ledger", out.split("not there yet")[1].splitlines()[0])
        self.assertIn("runner log", out)
        self.assertEqual(out.count("x blocked"), 1)

    def test_a_damaged_ledger_does_not_stop_it(self):
        (self.home / "state").mkdir(parents=True)
        (self.home / "state" / "ledger.db").write_text("not a database", encoding="utf-8")
        (self.home / "logs").mkdir()
        (self.home / "logs" / "hooks.log").write_text("2026-11-20T14:10:00Z PreToolUse x blocked (exit 2)\n",
                                                      encoding="utf-8")
        self.assertIn("x blocked", self.run_console("--once", "--since", "all", "--no-color"))


class Classing(unittest.TestCase):
    def test_words(self):
        self.assertEqual(ev.classify("advance r-1: spawn of build refused: group"), "error")
        self.assertEqual(ev.classify("advance r-1: stopped for the time limit"), "stop")
        self.assertEqual(ev.classify("tick: started advance"), "start")
        self.assertEqual(ev.classify("run ended needs-josh"), "needs")
        self.assertEqual(ev.classify("KeyError: 'x'"), "error")
        self.assertEqual(ev.outcome_kind("_abandoned"), "stop")
        self.assertEqual(ev.outcome_kind("needs_input"), "needs")
        self.assertEqual(ev.outcome_kind("changes_requested"), "error")
        self.assertEqual(ev.outcome_kind("ready"), "ok")

    def test_one_screen_line(self):
        self.assertEqual(ev.shorten("a\nb\tc"), "a b c")
        self.assertEqual(len(ev.shorten("x" * 500)), ev.MAX_TEXT)
        self.assertTrue(re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", ev.normalise("2026-11-20 14:00:00+00:00")))


if __name__ == "__main__":
    unittest.main()
