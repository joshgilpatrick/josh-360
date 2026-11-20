"""JP-117, Task 9: advancing a run. The fixture graph is `valid`; every run is started with `--runner agent-manager`.
The agent-manager is a fake and the clock is made up; no test starts a real session."""
import json
import unittest
from pathlib import Path
from unittest import mock

from runner_helpers import RunnerCase, runfolder
from runner_lib import advance, ledgerview, locks, notify, paths, sessionfile

AM = ("--runner", "agent-manager")
MINUTE = 60


class Advancing(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-901", *AM)

    def spawns(self):
        return len(self.am_calls("spawn"))

    def started(self, run=None, session_id="cc-1"):
        """Advance to a started session that has linked, as it does a moment after Agent Manager starts it."""
        run = run or self.run_id
        self.assertEqual(self.advance(run), "spawned")
        self.session_starts(run, "design", session_id=session_id)
        return run

    def rows(self, run=None):
        from runner_helpers import db
        conn = db.connect(db.ledger_path())
        try:
            return ledgerview.run_rows(conn, run or self.run_id)
        finally:
            conn.close()

    def design_attempts(self):
        return [d for d in self.rows() if d["step"] == "design"]

    def test_first_advance_starts_one_session(self):
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.spawns(), 1)
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["state"], doc["started_at"], doc["handle"]["am_session"]), ("started", self.now, "s-1"))
        self.assertRegex(doc["key"], "^[0-9a-f]{16}$")

    def test_second_advance_while_working_changes_nothing(self):
        self.advance(self.run_id)
        before = self.session_doc(self.run_id)
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.spawns(), 1)
        self.assertEqual(self.session_doc(self.run_id), before)

    def test_finished_session_is_recorded_and_the_run_moves_on(self):
        self.started()
        model = self.session_doc(self.run_id)["handle"]["model"]
        self.session_ends(self.run_id, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.advance(self.run_id), "parked")
        design = self.design_attempts()[0]
        self.assertEqual((design["outcome"], design["session"], design["model"]), ("ready", "cc-1", model))
        self.assertIn("lint-spec", [l.get("gate") for l in self.log()])
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["state"], doc["closed"]), ("recorded", None))
        self.assertEqual(doc["ended_at"], self.now)
        self.assertEqual(self.am_calls("archive"), [])          # a ticket's newest session stays in view (JP-173)

    def test_archive_can_be_switched_off(self):
        self.settings(archive_finished_sessions=False)
        self.started()
        self.session_ends(self.run_id, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.advance(self.run_id), "parked")
        self.assertEqual(self.am_calls("archive"), [])
        self.assertIsNone(self.session_doc(self.run_id)["closed"])

    def test_session_limit_holds_across_runs(self):
        second = self.start("valid", "JP-902", *AM)
        third = self.start("valid", "JP-903", *AM)
        self.started(self.run_id, "cc-1")
        self.started(second, "cc-2")
        self.assertEqual(self.advance(third), "limit")
        self.assertEqual(self.spawns(), 2)
        self.assertIsNone(self.session_doc(third))
        self.session_ends(self.run_id, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.advance(self.run_id), "parked")
        self.assertEqual(self.advance(third), "spawned")
        self.assertEqual(self.spawns(), 3)

    def test_restart_does_not_start_a_second_session(self):
        self.started()
        for _ in range(3):                                    # each call is a new process's first look at the run
            self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.spawns(), 1)

    def test_crash_after_spawn_is_adopted_through_the_link(self):
        self.started()
        doc = self.session_doc(self.run_id)
        sessionfile.write(self.run_id, "design", 1, dict(doc, state="spawning", handle=None, started_at=None))
        self.assertEqual(self.advance(self.run_id), "working")
        adopted = self.session_doc(self.run_id)
        self.assertEqual((adopted["state"], adopted["started_at"], adopted["handle"]["am_session"]),
                         ("started", doc["intent_at"], "s-1"))
        self.assertEqual(self.spawns(), 1)

    def test_a_result_from_a_session_adopted_through_the_link_is_recorded(self):
        self.started()                                       # its handle, once adopted, has no model
        doc = self.session_doc(self.run_id)
        sessionfile.write(self.run_id, "design", 1, dict(doc, state="spawning", handle=None, started_at=None))
        self.assertEqual(self.advance(self.run_id), "working")
        self.session_ends(self.run_id, "design", "ready", {"spec_path": "spec-1"})
        self.advance(self.run_id)
        self.assertEqual(self.session_doc(self.run_id)["state"], "recorded")
        self.assertEqual(self.design_attempts()[0]["outcome"], "ready")

    def test_crash_before_spawn_is_tried_again_in_the_same_attempt_after_the_link_timeout(self):
        """JP-183: a session that never linked ran no model, so the attempt is kept and the spawn is tried again."""
        self.write_session(self.run_id, "spawning")
        self.later(9 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.spawns(), 0)
        self.later(MINUTE)
        self.assertEqual(self.advance(self.run_id), "spawn-failed")
        first = self.session_doc(self.run_id)
        self.assertEqual((first["state"], first["reason"], first["failure"]["kind"]),
                         ("spawn_failed", "never-started", "may-clear"))
        self.assertNotEqual(first["key"], "0123456789abcdef")          # the old session can never link to it now
        self.later(5 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.session_doc(self.run_id)["state"], "started")
        self.assertEqual([d["attempt"] for d in self.design_attempts()], [1])
        self.assertEqual(self.spawns(), 1)

    def rest(self, nudged):
        self.started()
        self.set_entry(nudged_at=nudged)
        self.am_set("s-1", status="idle")

    def test_rested_without_a_result_is_abandoned(self):
        self.rest(self.now - 30)
        self.assertEqual(self.advance(self.run_id), "working")
        self.later(10 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "spawned")
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["state"], doc["reason"]), ("abandoned", "rested-without-result"))
        self.assertEqual(self.am_calls("archive"), [["archive", "s-1"]])   # the retry's session replaces it (JP-173)

    def test_resting_with_no_nudge_uses_first_seen_resting(self):
        self.rest(None)
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id)["resting_since"], self.now)
        self.later(10 * MINUTE)
        self.advance(self.run_id)
        self.assertEqual(self.session_doc(self.run_id)["reason"], "rested-without-result")

    def test_an_old_nudge_does_not_use_up_the_rest_wait(self):
        self.rest(self.now - 7200)
        self.assertEqual(self.advance(self.run_id), "working")
        self.later(9 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id)["state"], "started")
        self.later(MINUTE)
        self.advance(self.run_id)
        self.assertEqual(self.session_doc(self.run_id)["reason"], "rested-without-result")

    def test_working_again_restarts_the_rest_wait(self):
        self.rest(None)
        self.advance(self.run_id)
        self.later(5 * MINUTE)
        self.am_set("s-1", status="working")
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertIsNone(self.session_doc(self.run_id)["resting_since"])
        self.later(MINUTE)
        self.am_set("s-1", status="idle")
        self.advance(self.run_id)
        seen = self.now
        self.later(10 * MINUTE - 1)
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id)["resting_since"], seen)
        self.later(1)
        self.advance(self.run_id)
        self.assertEqual(self.session_doc(self.run_id)["reason"], "rested-without-result")

    def test_gone_session_is_abandoned(self):
        self.started()
        self.am_set("s-1", archived=1)
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.session_doc(self.run_id)["reason"], "session-gone")

    def test_unknown_state_changes_nothing(self):
        self.started()
        before = self.session_doc(self.run_id)
        (self.am_dir / "state.db").unlink()
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id), before)
        self.assertEqual(self.spawns(), 1)

    def test_time_cap_abandons_after_the_grace(self):
        self.started()
        self.later(3 * 3600 + 14 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "working")
        self.later(MINUTE)
        self.advance(self.run_id)
        self.assertEqual(self.session_doc(self.run_id)["reason"], "time-cap")

    def test_result_with_an_undeclared_outcome_abandons_the_attempt(self):
        self.started()
        self.session_ends(self.run_id, "design", "no-such-outcome")
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.session_doc(self.run_id)["reason"], "bad-result")
        self.assertEqual([d["attempt"] for d in self.design_attempts()], [1, 2])

    def test_half_written_result_is_left_for_the_next_pass(self):
        self.started()
        path = Path(self.session_doc(self.run_id)["result_file"])
        path.write_text('{"outc')
        import os
        os.utime(str(path), (self.now - 10, self.now - 10))
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id)["state"], "started")
        self.later(60)
        self.advance(self.run_id)
        self.assertEqual(self.session_doc(self.run_id)["reason"], "bad-result")

    def test_step_that_keeps_failing_ends_as_the_walker_says(self):
        with mock.patch.object(notify, "note_once", wraps=notify.note_once) as noted:
            self.assertEqual(self.advance(self.run_id), "spawned")
            for attempt, expected in ((1, "spawned"), (2, "spawned"), (3, "stopped")):
                self.session_starts(self.run_id, "design", attempt=attempt, session_id="cc-{}".format(attempt))
                self.session_ends(self.run_id, "design", "no-such-outcome", attempt=attempt)
                self.assertEqual(self.advance(self.run_id), expected)
        self.assertEqual(self.spawns(), 3)
        self.assertEqual([c.args for c in noted.call_args_list], [(self.run_id, "stopped:design")])

    def test_spawn_refused_with_no_explanation_ends_stuck_not_abandoned(self):
        """JP-183: an unexplained refusal may clear by itself: tried after growing gaps, then the run is stuck."""
        self.am_behaviour(spawn_fails="boom")
        for failures, gap in ((1, 5), (2, 15), (3, 30), (4, 60)):
            self.assertEqual(self.advance(self.run_id), "spawn-failed")
            doc = self.session_doc(self.run_id)
            self.assertEqual((doc["state"], doc["spawn_failures"], doc["reason"]), ("spawn_failed", failures, "refused"))
            self.later(gap * MINUTE - 1)
            self.assertEqual(self.advance(self.run_id), "retry-later")
            self.later(1)
        self.assertEqual(self.advance(self.run_id), "stopped")
        doc = self.session_doc(self.run_id)
        self.assertEqual((doc["state"], doc["spawn_failures"]), ("stopped", 5))
        self.assertEqual([d["outcome"] for d in self.design_attempts()], [None])   # not abandoned: the attempt is open
        self.assertEqual(self.spawns(), 5)

    def test_a_refused_spawn_is_retried_with_the_same_key_and_comments(self):
        folder = runfolder.folder(self.run_id) / "comments"
        folder.mkdir()
        (folder / "10042.json").write_text(json.dumps({"ticket": "JP-901", "comment_id": "10042", "name": "Josh",
                                                       "created": "2026-11-17T10:00:00Z", "text": "Use the second spec."}))
        self.am_behaviour(spawn_fails="boom")
        self.assertEqual(self.advance(self.run_id), "spawn-failed")
        failed = self.session_doc(self.run_id)
        self.assertIn("Use the second spec.", failed["comments"])
        self.am_behaviour()
        self.later(5 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "spawned")
        prompt = self.logged_prompt(self.run_id, "design")
        self.assertIn("key=" + failed["key"], prompt.splitlines()[0])
        self.assertIn("Use the second spec.", prompt)

    def test_a_spawn_with_no_id_in_the_reply_is_not_spawned_again(self):
        self.am_behaviour(spawn_no_id=True)                  # the session exists; only the reply is unusable
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id)["state"], "spawning")
        self.session_starts(self.run_id, "design")
        self.am_behaviour()
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual(self.session_doc(self.run_id)["state"], "started")
        self.assertEqual(self.spawns(), 1)

    def test_a_spawn_with_no_id_and_no_link_is_tried_again_after_the_link_timeout(self):
        self.am_behaviour(spawn_no_id=True)
        self.assertEqual(self.advance(self.run_id), "working")
        self.later(10 * MINUTE)
        self.am_behaviour()
        self.assertEqual(self.advance(self.run_id), "spawn-failed")
        self.assertEqual(self.session_doc(self.run_id)["reason"], "never-started")
        self.later(5 * MINUTE)
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.spawns(), 2)
        self.assertEqual([d["attempt"] for d in self.design_attempts()], [1])

    def test_an_attempt_the_walker_ended_does_not_hold_a_session_slot(self):
        other = self.start("valid", "JP-902", *AM)
        self.started()
        self.walker("abandon", "--run", self.run_id)         # by hand, while the session file still says `started`
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.advance(other), "spawned")     # one live session is no reason to refuse a second

    def test_a_refused_spawn_that_linked_anyway_is_adopted(self):
        from runner_lib import hooklib
        doc = self.write_session(self.run_id, "spawning")
        hooklib.link({"session_id": "cc-9", "prompt": hooklib.marker(self.run_id, "design", 1, doc["key"]) + "\ntask"},
                     {"AGENT_MANAGER_SESSION_ID": "s-7"}, self.now)
        sessionfile.write(self.run_id, "design", 1, dict(doc, state="spawn_failed", spawn_failures=1))   # the late write
        self.assertEqual(self.advance(self.run_id), "working")
        self.assertEqual((self.session_doc(self.run_id)["state"], self.spawns()), ("started", 0))

    def test_no_rails_no_session(self):
        self.write_claude_settings(without="Stop")
        self.assertEqual(self.advance(self.run_id), "no-rails")
        self.assertEqual(self.spawns(), 0)
        self.assertIsNone(self.session_doc(self.run_id))

    def test_off_switch_records_but_starts_nothing(self):
        other = self.start("valid", "JP-902", *AM)
        self.started()
        self.session_ends(self.run_id, "design", "ready", {"spec_path": "spec-1"})
        paths.off_file().parent.mkdir(parents=True, exist_ok=True)
        paths.off_file().write_text("")
        self.assertEqual(self.advance(self.run_id), "off")
        self.assertEqual(self.design_attempts()[0]["outcome"], "ready")
        self.assertNotIn("lint-spec", [l.get("gate") for l in self.log()])      # the next gate has not run
        self.assertEqual(self.advance(other), "off")
        self.assertEqual(self.spawns(), 1)
        self.assertIsNone(self.session_doc(other))

    def test_off_switch_does_not_move_a_run_past_an_answered_question(self):
        self.do_role(self.run_id, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", self.run_id)["step"], "approve_spec")
        self.answer_in_app(self.run_id, "approve_spec", "build")
        paths.off_file().parent.mkdir(parents=True, exist_ok=True)
        paths.off_file().write_text("")
        self.assertEqual(self.advance(self.run_id), "off")
        self.assertNotIn("build", [r["step"] for r in self.rows()])
        paths.off_file().unlink()
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertIn("build", [r["step"] for r in self.rows()])

    def test_two_advances_never_drive_one_run(self):
        with locks.held(runfolder.folder(self.run_id) / "advance.lock"):
            self.assertEqual(self.advance(self.run_id), "locked")
        self.assertEqual(self.spawns(), 0)

    def test_comments_reach_the_first_prompt(self):
        from ledger import comments
        folder = runfolder.folder(self.run_id) / "comments"
        folder.mkdir()
        (folder / "10042.json").write_text(json.dumps({"ticket": "JP-901", "comment_id": "10042", "name": "Josh",
                                                       "created": "2026-11-17T10:00:00Z", "text": "Use the second spec."}))
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertIn("Use the second spec.", self.logged_prompt(self.run_id, "design"))
        self.assertEqual(comments.take_run(self.run_id), "")

    def test_bad_run_id_is_refused(self):
        with self.assertRaises(ValueError):
            advance.advance("../x")

    def test_load_binding_by_name(self):
        self.assertTrue(callable(advance.load_binding("agent-manager").start))
        with self.assertRaises(ValueError):
            advance.load_binding("no-such-runner")


if __name__ == "__main__":
    unittest.main()
