"""JP-188: a gate that stopped a run because it could not tell yet (exit 1, or a time-out) is retried by the runner on
growing gaps, a few times, before the stop is told about. The end-to-end run found it: triage's exit gate stops every
run until the recorder has written the sign-off session, and nothing tried it again. Fixture graph `valid`; the gate
`lint-spec` is scripted; the agent-manager is a fake and the clock is made up."""
import unittest

from runner_helpers import RunnerCase
from runner_lib import failures, notify, paths, tick

AM = ("--runner", "agent-manager")


class GateRetry(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-901", *AM)

    def designed(self):
        """The design step's session ends with its result; the next advance runs lint-spec."""
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.session_starts(self.run_id, "design")
        self.session_ends(self.run_id, "design", "ready", {"spec_path": "spec-1"})

    def gate_calls(self):
        return [l for l in self.log() if l.get("gate") == "lint-spec"]

    def runner_log(self):
        path = paths.log_dir() / "runner.log"
        return path.read_text() if path.is_file() else ""

    def test_a_gate_that_could_not_tell_yet_is_retried_after_its_gap_and_the_run_goes_on(self):
        self.plan({"lint-spec": ["crash", "pass"]})
        self.designed()
        self.assertEqual(self.advance(self.run_id), "retry-later")        # stopped, not told about yet
        self.assertEqual(len(self.gate_calls()), 1)
        self.assertNotIn("stopped:lint", str(notify.read(self.run_id).get("noted")))
        self.later(299)
        self.assertEqual(self.advance(self.run_id), "retry-later")        # the first gap is five minutes
        self.assertEqual(len(self.gate_calls()), 1)
        self.later(2)
        self.assertEqual(self.advance(self.run_id), "parked")             # tried again, passed, on to the question
        self.assertEqual(len(self.gate_calls()), 2)
        self.assertIn("may have cleared; trying it again", self.runner_log())
        self.advance(self.run_id)                                          # a later stop gets a fresh count
        self.assertNotIn("gate_retries", notify.read(self.run_id))

    def test_the_tick_launches_an_advance_for_a_gate_stop_until_its_tries_are_spent(self):
        self.plan({"lint-spec": ["crash"]})
        self.designed()
        self.advance(self.run_id)
        from runner_helpers import db
        conn = db.connect(db.ledger_path())
        try:
            run = {"run": self.run_id}
            self.assertTrue(tick.needs_advance(conn, run))
            for gap in (300, 900, 1800, 3600):                             # the spawn gaps, then the last repeats
                self.later(gap - 1)
                self.assertEqual(self.advance(self.run_id), "retry-later")
                calls = len(self.gate_calls())
                self.later(1)
                self.assertEqual(self.advance(self.run_id), "retry-later")
                self.assertEqual(len(self.gate_calls()), calls + 1)
                self.assertTrue(tick.needs_advance(conn, run))
            self.later(3600)
            self.assertEqual(self.advance(self.run_id), "stopped")        # the fifth try failed too: told about, once
            self.assertEqual(len(self.gate_calls()), 6)
            self.assertIn("stopped:lint", " ".join(notify.read(self.run_id).get("noted")))
            self.assertFalse(tick.needs_advance(conn, run))
            self.later(3600)
            self.assertEqual(self.advance(self.run_id), "stopped")
        finally:
            conn.close()
        self.assertEqual(len(self.gate_calls()), 6)

    def test_a_gate_stop_that_needs_a_fix_is_told_about_at_once(self):
        self.plan({"lint-spec": ["no-such-outcome"]})                       # an outcome the step does not declare
        self.designed()
        self.assertEqual(self.advance(self.run_id), "stopped")
        self.assertEqual(failures.gate_retry(self.run_id, {"step": "lint", "reason": "gate 'lint-spec' printed the "
                                                           "outcome 'x', which the step does not declare"},
                                             paths.settings(), self.now), "no")

    def test_only_exit_1_and_time_outs_may_clear(self):
        for reason, may in (("gate 'no-loose-ends' failed (1): not recorded yet; retry this gate later", True),
                            ("gate 'ticket-facts' timed out after 600 s", True),
                            ("gate 'x' failed (2): usage", False),
                            ("gate script 'x' is missing", False),
                            ("gate 'x' printed no outcome as one line of JSON", False)):
            self.assertEqual(failures.gate_may_clear({"step": "s", "reason": reason}), may, reason)
        self.assertFalse(failures.gate_may_clear({"step": "s", "reason": "gate 'x' failed (1): y", "by": "runner"}))
        self.assertFalse(failures.gate_may_clear(None))


if __name__ == "__main__":
    unittest.main()
