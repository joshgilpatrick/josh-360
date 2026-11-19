"""JP-161: the `no-loose-ends` exit gate on JP-109's loose-ends finder.

Real git repositories in a temp folder, a made-up ledger with a graph run whose role steps name made-up sessions, and
fake Jira and GitHub answers (tests/loose_helpers.py). Every run, session, branch and ticket here is invented.
Run: python3 -m unittest discover -s graphs/tests (from the repository root).
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

import ticket_creation_helpers as h

sys.path.append(str(h.ROOT / "tests"))
from loose_helpers import NOW, T, LaptopCase, fake_live, git  # noqa: E402

from lib import loose_ends_gate  # noqa: E402
from lib.gate_run import GateError  # noqa: E402

RUN = "r-0123456789ab"
TICKET = "JP-900"
STARTED = "2026-11-17T09:00:00Z"   # before the sessions' last activity (T), so their episodes cover the step


class GateCase(LaptopCase):
    def setUp(self):
        super().setUp()
        self.conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
            "subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by) "
            "VALUES (?, ?, 'triage', 'graph-file', 'abc123', 'ticket', ?, 'jira', ?, 0, 'cli', ?, 'test')",
            (RUN, self.machine, TICKET, TICKET, STARTED))
        self.work = self.tmp / "runs" / RUN / "work"

    def step(self, step_id, uid=None, outcome="done", attempt=1, at_start=False, started=STARTED):
        """A role step of the run. The session goes on the result (as `walker.py record --session` writes it), or on
        the start row with `at_start`."""
        cur = self.conn.execute(
            "INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, session_uid, "
            "started_at, recorded_by) VALUES (?, ?, 'role', ?, 0, 'mid', 'builder', ?, ?, 'test')",
            (RUN, step_id, attempt, uid if at_start else None, started))
        if outcome:
            self.conn.execute(
                "INSERT INTO step_results (step_run_id, outcome, session_uid, ended_at, recorded_by) "
                "VALUES (?, ?, ?, ?, 'test')", (cur.lastrowid, outcome, None if at_start else uid, T))

    def gate(self, live=None):
        return loose_ends_gate.check(self.conn, RUN, live or fake_live(), NOW, self.work)

    def clean_branch(self, name):
        sha = self.branch_with_commit(name, push=True)
        self.merge_to_main(name)
        git(self.repo, "branch", "-q", "-d", name)
        git(self.repo, "push", "-q", "origin", "--delete", name)
        git(self.repo, "fetch", "-q", "--prune")
        return sha


class Passes(GateCase):
    def test_nothing_loose_passes_and_the_runs_own_ticket_is_not_read(self):
        sha = self.clean_branch("JP-900-clean")
        uid = self.seed("sess-0001", branch="JP-900-clean", commits=[sha], ticket=TICKET,
                        pr="https://example.test/o/r/pull/1")
        self.step("build", uid)
        # JP-900 is not in the fake Jira: reading it would be "unknown". The gate never asks about its own ticket.
        outcome, outputs, summary = self.gate(fake_live(prs={"https://example.test/o/r/pull/1": "MERGED"}))
        self.assertEqual(outcome, "pass")
        self.assertIsNone(outputs)
        self.assertIn("1 session", summary)
        self.assertFalse((self.work / "loose-ends.md").exists())

    def test_run_with_no_session_passes(self):
        self.step("build", None, outcome="_abandoned")
        outcome, _, _ = self.gate()
        self.assertEqual(outcome, "pass")

    def test_development_run_whose_ticket_is_in_deployed_passes(self):
        """JP-167: a ticket in Deployed that is not flagged is waiting for its watch, not loose."""
        uid = self.seed("sess-0001", ticket="JP-901")
        self.step("build", uid)
        self.assertEqual(self.gate(fake_live(tickets={"JP-901": ("Deployed", False, False)}))[0], "pass")
        flagged = self.gate(fake_live(tickets={"JP-901": ("Deployed", False, True)}))
        self.assertEqual(flagged[0], "loose")
        self.assertIn("ticket-not-done 1", flagged[2])

    def test_work_of_sessions_outside_the_run_is_not_counted(self):
        self.branch_with_commit("someone-else")
        self.seed("sess-0002", branch="someone-else")   # loose, but not this run's
        uid = self.seed("sess-0001")
        self.step("build", uid)
        self.assertEqual(self.gate()[0], "pass")

    def test_a_step_cut_off_before_any_session_is_skipped(self):
        uid = self.seed("sess-0001")
        self.step("build", uid)
        self.step("build", None, outcome="_abandoned", attempt=2)
        outcome, _, summary = self.gate()
        self.assertEqual(outcome, "pass")
        self.assertIn("1 cut-off step with none", summary)

    def test_a_session_named_only_when_the_step_started_counts(self):
        self.branch_with_commit("JP-900-start")
        uid = self.seed("sess-0001", branch="JP-900-start")
        self.step("build", uid, at_start=True)
        self.assertEqual(self.gate()[0], "loose")


class Fails(GateCase):
    def test_loose_work_refuses_with_the_list(self):
        self.branch_with_commit("JP-900-unpushed")
        uid = self.seed("sess-0001", branch="JP-900-unpushed", pr="https://example.test/o/r/pull/2", ticket="JP-901")
        self.step("build", uid)
        live = fake_live(tickets={"JP-901": ("In Progress", False)}, prs={"https://example.test/o/r/pull/2": "OPEN"})
        outcome, _, summary = self.gate(live)
        self.assertEqual(outcome, "loose")
        self.assertIn("3 loose ends", summary)
        self.assertIn("unpushed-branch 1, ticket-not-done 1, open-pr 1", summary)
        self.assertLessEqual(len(summary), 200)
        listed = (self.work / "loose-ends.md").read_text(encoding="utf-8")
        for text in ("Loose ends for run " + RUN, "JP-900-unpushed", "JP-901", "https://example.test/o/r/pull/2"):
            self.assertIn(text, listed)
        self.assertNotIn("JP-900-unpushed", summary)   # names and paths stay in the run folder

    def test_a_subagents_loose_work_counts(self):
        uid = self.seed("sess-0001")
        self.branch_with_commit("JP-900-sub")
        child = self.seed("sess-0002", branch="JP-900-sub")
        grandchild = self.seed("sess-0003", worktree=None)
        for parent, kid in ((uid, child), (child, grandchild)):
            self.conn.execute(
                "INSERT INTO session_lineage (child_uid, parent_uid, root_uid, kind, confidence, discovered_at, "
                "recorded_by) VALUES (?, ?, ?, 'subagent', 'confirmed', ?, 'test')", (kid, parent, uid, T))
        self.step("build", uid)
        outcome, _, summary = self.gate()
        self.assertEqual(outcome, "loose")
        self.assertIn("3 sessions", summary)

    def test_a_leftover_worktree_refuses(self):
        tree = self.tmp / "work" / "josh_360" / ".claude" / "worktrees" / "JP-900-tree"
        git(self.repo, "worktree", "add", "-q", "-b", "JP-900-tree", str(tree), "main")
        uid = self.seed("sess-0001", worktree=str(tree))
        self.step("build", uid)
        outcome, _, summary = self.gate()
        self.assertEqual(outcome, "loose")
        self.assertIn("leftover-worktree 1", summary)


class UnknownIsNotEmpty(GateCase):
    def assertStops(self, words, live=None):
        with self.assertRaises(GateError) as caught:
            self.gate(live)
        self.assertIn(words, str(caught.exception))

    def test_a_run_not_in_the_ledger_stops(self):
        with self.assertRaises(GateError) as caught:
            loose_ends_gate.check(self.conn, "r-ffffffffffff", fake_live(), NOW, self.work)
        self.assertIn("not in the ledger", str(caught.exception))

    def test_a_role_step_with_no_session_stops(self):
        self.step("build", None)
        self.assertStops("has no session recorded")

    def test_a_session_not_recorded_yet_stops(self):
        uid = self.session("sess-0001")   # started, but no episode written yet
        self.step("build", uid)
        self.assertStops("not recorded yet")

    def test_an_episode_older_than_the_step_stops(self):
        uid = self.seed("sess-0001")
        self.step("build", uid, started="2026-11-17T11:00:00Z")   # after the episode's last activity (T)
        self.assertStops("not recorded yet")

    def test_github_that_cannot_answer_stops(self):
        uid = self.seed("sess-0001", pr="https://example.test/o/r/pull/3")
        self.step("build", uid)
        self.assertStops("GitHub could not be read")

    def test_jira_that_cannot_answer_about_another_ticket_stops(self):
        uid = self.seed("sess-0001", ticket="JP-902")
        self.step("build", uid)
        self.assertStops("Jira could not be read")

    def test_a_broken_ledger_stops_the_script(self):
        home = self.tmp / "other-home"
        cases = {"missing": None, "not a database": b"this is not sqlite" * 64}
        for name, content in cases.items():
            with self.subTest(name):
                state = home / name / "state"
                state.mkdir(parents=True)
                if content is not None:
                    (state / "ledger.db").write_bytes(content)
                code, doc, err = h.run_gate("no-loose-ends", self.tmp, {},
                                            {"JOSH360_HOME": str(home / name), "JOSH360_RUN_ID": RUN})
                self.assertEqual(code, 1)
                self.assertIsNone(doc)
                self.assertIn("ledger cannot be read", err)

    def test_the_script_reads_the_real_ledger(self):
        uid = self.seed("sess-0001")
        self.step("build", uid)
        self.conn.commit()
        code, doc, err = h.run_gate("no-loose-ends", self.tmp, {},
                                    {"JOSH360_HOME": os.environ["JOSH360_HOME"], "JOSH360_RUN_ID": RUN})
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(doc["outcome"], "pass")

    def test_the_script_without_a_run_stops(self):
        code, doc, err = h.run_gate("no-loose-ends", self.tmp, {}, {"JOSH360_HOME": os.environ["JOSH360_HOME"]})
        self.assertEqual(code, 1)
        self.assertIn("JOSH360_RUN_ID", err)


if __name__ == "__main__":
    unittest.main()
