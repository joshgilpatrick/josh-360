"""JP-183: the runner spends retries and run caps only on failures that could change.

The fixture graph is `valid` (its `design` step is on the mid tier, model `sample-medium-model`, cap 3). Agent Manager is
the fake in tests/fakes/ and the clock is made up; no test starts a real session or reaches a model.
"""
import json
import shutil
import sys
import unittest
from unittest import mock

from runner_helpers import ROOT, RunnerCase
from runner_lib import advance, notify, paths, tick

sys.path.insert(0, str(ROOT / "laptop"))
import failure_kinds as kinds  # noqa: E402

AM = ("--runner", "agent-manager")
MINUTE = 60
MODEL = "sample-medium-model"


class FailureKinds(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-901", *AM)
        self.binding_json = self.tmp / "binding.json"
        shutil.copy(str(ROOT / "graphs" / "bindings" / "agent-manager" / "binding.json"), str(self.binding_json))
        import os
        os.environ["JOSH360_AM_BINDING_JSON"] = str(self.binding_json)

    # -- helpers -------------------------------------------------------------------------------------------------
    def status(self):
        return self.walker("status", "--run", self.run_id)

    def design_rows(self):
        return [s for s in self.status()["steps"] if s["step"] == "design"]

    def spawns(self):
        return len(self.am_calls("spawn"))

    def log_lines(self):
        path = paths.log_dir() / "runner.log"
        return path.read_text().splitlines() if path.is_file() else []

    def map_model(self, to):
        doc = json.loads(self.binding_json.read_text())
        doc["models"][MODEL] = to
        self.binding_json.write_text(json.dumps(doc))

    def needs_advance(self):
        from runner_helpers import db
        conn = db.connect(db.ledger_path())
        try:
            return tick.needs_advance(conn, {"run": self.run_id})
        finally:
            conn.close()

    # -- won't fix itself ------------------------------------------------------------------------------------------
    def test_a_bad_model_name_stops_the_run_after_one_try_and_uses_no_run(self):
        """@auto Given a step whose tier names a model Agent Manager does not list, When the runner tries to start it,
        Then it tries once, the run stops with a notice naming the model and the fix, and the step's run count is
        unchanged."""
        self.am_behaviour(refuse_model=MODEL)
        with mock.patch.object(notify, "notify") as shown:
            self.assertEqual(self.advance(self.run_id), "stopped")
            self.assertEqual(self.advance(self.run_id), "stopped")       # a second pass changes nothing
        self.assertEqual(self.spawns(), 1)
        st = self.status()
        self.assertEqual(st["runs"]["design"], 1)                          # the one open attempt; nothing was used up
        self.assertEqual([r["outcome"] for r in self.design_rows()], [None])
        stopped = st["stopped"]
        self.assertEqual((stopped["kind"], stopped["code"], stopped["step"]), ("needs-fix", "bad-model", "design"))
        self.assertIn('model "{}" is not one claude lists'.format(MODEL), stopped["reason"])
        self.assertIn("graphs/tiers.yaml", stopped["reason"])               # the fix
        self.assertEqual(len(shown.call_args_list), 1)                     # the one stop notice
        self.assertIn("needs a fix (bad-model)", shown.call_args_list[0][0][1])
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["state"], doc["failure"]["kind"]), ("stopped", "needs-fix"))

    def test_after_the_fix_the_run_carries_on_without_an_allow(self):
        """@auto Given a run stopped because the model name was bad, And the model name is fixed, When the run is
        resumed, Then the same step starts with its cap count unchanged, and no allow is needed."""
        self.am_behaviour(refuse_model=MODEL)
        self.assertEqual(self.advance(self.run_id), "stopped")
        self.assertFalse(self.needs_advance())                             # told once; nothing changed yet
        self.map_model("sonnet")                                           # the fix: binding.json maps the model
        self.assertTrue(self.needs_advance())                              # the next pass picks it up on its own
        self.assertEqual(self.advance(self.run_id), "spawned")
        st = self.status()
        self.assertIsNone(st["stopped"])
        self.assertEqual(st["runs"]["design"], 1)
        self.assertEqual([(r["attempt"], r["allowed"]) for r in self.design_rows()], [(1, 0)])
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["state"], doc["handle"]["model"]), ("started", "sonnet"))
        self.assertEqual(doc["failures"][0]["reason"], "bad-model")

    def test_resume_by_hand_works_when_nothing_the_runner_sees_changed(self):
        self.am_behaviour(spawn_fails="agent-manager: claude is not installed")
        self.assertEqual(self.advance(self.run_id), "stopped")
        self.assertEqual(self.status()["stopped"]["code"], "no-cli")
        self.am_behaviour()                                                # installed outside anything hashed
        self.assertFalse(self.needs_advance())
        from runner import main
        import io
        out = io.StringIO()
        self.assertEqual(main(["resume", "--run", self.run_id, "--graphs-root", str(self.root)], out), 0)
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.status()["runs"]["design"], 1)

    def test_a_missing_work_folder_needs_a_fix(self):
        from walker_lib import runfolder
        shutil.rmtree(str(runfolder.work_dir(self.run_id)))
        self.assertEqual(self.advance(self.run_id), "stopped")
        self.assertEqual(self.status()["stopped"]["code"], "no-folder")
        self.assertEqual(self.spawns(), 0)

    # -- might fix itself ----------------------------------------------------------------------------------------
    def test_agent_manager_not_running_is_retried_and_never_uses_the_cap(self):
        """@auto Given Agent Manager is not running, When the runner tries to start a step, Then it retries with
        growing gaps, the step's run count is unchanged, and when retries run out the run is stuck, not abandoned."""
        self.am_behaviour(spawn_fails="agent-manager: could not connect to the daemon; is it running?")
        waits = []
        for _ in range(4):
            self.assertEqual(self.advance(self.run_id), "spawn-failed")
            doc = self.session_doc(self.run_id)
            waits.append(doc["next_try_at"] - self.now)
            self.assertEqual(self.advance(self.run_id), "retry-later")
            self.later(waits[-1])
        self.assertEqual(waits, [300, 900, 1800, 3600])                   # growing gaps
        self.assertEqual(self.advance(self.run_id), "stopped")
        st = self.status()
        self.assertEqual((st["stopped"]["kind"], st["stopped"]["code"]), ("may-clear", "not-running"))
        self.assertIn("stuck (not-running) after 5 tries", st["stopped"]["reason"])
        self.assertEqual(st["runs"]["design"], 1)
        self.assertEqual([r["outcome"] for r in self.design_rows()], [None])   # not abandoned
        self.am_behaviour()
        self.walker("retry", "--run", self.run_id)                         # a plain resume
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.session_doc(self.run_id)["spawn_failures"], 0)

    def test_a_refusal_the_runner_cannot_sort_is_one_that_might_fix_itself(self):
        """@auto Given Agent Manager refuses a spawn with no explanation, When the runner handles it, Then it is retried
        as a failure that might fix itself."""
        self.am_behaviour(spawn_fails="something odd happened")
        self.assertEqual(self.advance(self.run_id), "spawn-failed")
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["failure"]["reason"], doc["failure"]["kind"]), ("refused", "may-clear"))
        self.assertIsNone(self.status()["stopped"])
        self.assertEqual(kinds.kind_of("a-code-nobody-knows"), kinds.MAY_CLEAR)

    def test_a_session_that_ended_before_it_linked_is_tried_again(self):
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.am_set("s-1", archived=1)                                     # gone, and it never linked
        self.assertEqual(self.advance(self.run_id), "spawn-failed")
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["reason"], doc["earlier"][0]["handle"]["am_session"]), ("gone-before-start", "s-1"))
        self.later(5 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.status()["runs"]["design"], 1)

    # -- the model ran -------------------------------------------------------------------------------------------
    def test_a_step_whose_model_ran_and_failed_still_counts(self):
        """@auto Given a step that started a session and ended without a result, When the attempt ends, Then it counts
        against the tier's run cap, as today."""
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.session_starts(self.run_id, "design")
        self.am_set("s-1", archived=1)
        self.assertEqual(self.advance(self.run_id), "spawned")
        first = self.session_doc(self.run_id)
        self.assertEqual((first["state"], first["reason"], first["kind"]), ("abandoned", "session-gone", "ran"))
        self.assertEqual(self.status()["runs"]["design"], 2)
        self.assertEqual([r["outcome"] for r in self.design_rows()], ["_abandoned", None])

    # -- the log ---------------------------------------------------------------------------------------------------
    def test_the_real_reason_reaches_the_log(self):
        """@auto Given Agent Manager refuses a spawn with a message, When the refusal is logged, Then runner.log holds
        the message shortened to about 200 characters, after the patient-data check, with its kind."""
        self.am_behaviour(spawn_fails="agent-manager: rate limit reached for this account " + "x" * 400)
        self.advance(self.run_id)
        line = [ln for ln in self.log_lines() if "refused (rate-limited, may-clear" in ln][-1]
        said = line.split("): ", 1)[1]
        self.assertTrue(said.startswith("agent-manager: rate limit reached"))
        self.assertLessEqual(len(said), 200)
        self.assertTrue(said.endswith("..."))

    def test_a_message_with_patient_data_is_held_back(self):
        self.am_behaviour(spawn_fails="agent-manager: refused; patient: Smith, phone 555-123-4567")
        self.advance(self.run_id)
        text = "\n".join(self.log_lines())
        self.assertNotIn("555-123-4567", text)
        self.assertNotIn("Smith", text)
        self.assertIn("message held back: the patient-data screen found", text)

    def test_the_report_shows_the_kind_and_the_reason(self):
        self.am_behaviour(refuse_model=MODEL)
        self.advance(self.run_id)
        from runner_helpers import db
        from runner_lib import status
        conn = db.connect(db.ledger_path())
        try:
            report = status.run_report(conn, self.run_id, self.root)
            snap = status.snapshot(conn, self.now, self.root)
        finally:
            conn.close()
        row = [s for s in report["steps"] if s["step"] == "design"][0]
        self.assertEqual((row["reason"], row["failure_kind"], row["kind"]), ("bad-model", "needs-fix", "role"))
        self.assertIn("bad-model (needs-fix)", status.render(report))
        self.assertEqual(snap["stopped"][0]["kind"], "needs-fix")
        self.assertIn("needs a fix: bad-model", status.text(snap))


class Sorting(unittest.TestCase):
    """The binding's reading of Agent Manager's words, and the shared table."""

    def setUp(self):
        sys.path.insert(0, str(ROOT / "graphs" / "bindings" / "agent-manager"))
        import binding
        self.binding = binding

    def test_agent_manager_messages(self):
        said = {
            'model "x" is not one claude lists; it lists default, opus, fable, sonnet, haiku': "bad-model",
            'effort "huge" is not one claude lists': "bad-effort",
            "agent-manager: claude is not installed; install it with ...": "no-cli",
            "error: the directory /x/y does not exist": "no-folder",
            "could not connect to the agent-manager daemon": "not-running",
            "429 Too Many Requests": "rate-limited",
            "network is unreachable": "network",
            "boom": "refused",
        }
        for text, code in said.items():
            self.assertEqual(self.binding.classify(text), code, text)

    def test_every_code_the_binding_gives_has_a_kind(self):
        for code, _ in self.binding._SAYS:
            self.assertIn(code, kinds.REASONS)
        for code in ("refused", "timeout", "no-id", "group"):
            self.assertIn(code, kinds.REASONS)

    def test_only_a_model_that_ran_counts(self):
        counted = sorted(c for c in kinds.REASONS if kinds.counts_against_cap(c))
        self.assertEqual(counted, ["bad-result", "rested-without-result", "session-gone", "time-cap"])

    def test_every_needs_fix_code_names_its_fix(self):
        for code, kind in kinds.REASONS.items():
            if kind == kinds.NEEDS_FIX:
                self.assertTrue(kinds.fix_for(code), code)


if __name__ == "__main__":
    unittest.main()
