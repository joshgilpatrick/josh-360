"""open-pr, queue-audit, review-state, after-fix and the review helpers (JP-115, Task 10). Fakes for GitHub; real git."""
from __future__ import annotations

import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dev_helpers import (KEY, Case, FakeGitHub, FakeTicket, gate, make_dev_deps, scratch_repo, spec_copy, write_spec)
from lib import dev_copy, dev_git, dev_github, dev_review
from lib.dev_github import Check, PrComment
from lib.gate_run import GateError

T, IP, CH, RD, BL = (dev_github.TRIGGER, dev_github.IN_PROGRESS, dev_github.CHANGES, dev_github.READY, dev_github.BLOCKED)
MARK = "<!-- action-triage-audit:security -->\n"
QUEUED = "2026-11-17T10:00:00Z"


def commit(tree: Path, name: str = "a.txt", text: str = "x\n") -> None:
    (tree / name).write_text(text)
    dev_git.git(tree, "add", name)
    dev_git.git(tree, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-m", "add " + name)


class TestHelpers(unittest.TestCase):
    def test_counts_finding_headings(self):
        self.assertEqual(dev_review.count_findings(MARK + "## Finding 1: a\ntext\n### 2. b\n#### Finding 3 c"), 3)

    def test_optional_heading_not_counted(self):
        self.assertEqual(dev_review.count_findings(MARK + "## Finding 1: a\n## Finding 2 (optional): b"), 1)

    def test_counts_from_the_verdict_phrase(self):
        self.assertEqual(dev_review.count_findings("**Verdict: 1 correctness finding.**"), 1)
        self.assertEqual(dev_review.count_findings("Verdict: 3 findings."), 3)

    def test_phrases_are_added_so_a_count_is_never_low(self):
        self.assertEqual(dev_review.count_findings("Security: 1 finding. Simplification: 4 findings."), 5)

    def test_no_findings_is_zero(self):
        self.assertEqual(dev_review.count_findings("Verdict: no findings."), 0)
        self.assertEqual(dev_review.count_findings("There are no security findings."), 0)

    def test_uncountable_is_none(self):
        self.assertIsNone(dev_review.count_findings("Looks mostly fine, a few things to tidy."))
        self.assertIsNone(dev_review.count_findings(""))

    def test_check_state_latest_of_a_name_counts(self):
        rows = [Check("suite", "fail", "2026-11-17T09:00:00Z"), Check("suite", "pass", "2026-11-17T10:00:00Z")]
        self.assertEqual(dev_review.check_state(rows), "green")
        rows.append(Check("lint", "pending", "2026-11-17T10:00:00Z"))
        self.assertEqual(dev_review.check_state(rows), "pending")
        rows.append(Check("lint", "cancel", "2026-11-17T11:00:00Z"))
        self.assertEqual(dev_review.check_state(rows), "failed")
        self.assertEqual(dev_review.check_state([]), "none")
        self.assertEqual(dev_review.check_state([Check("a", "skipping", "")]), "green")

    def test_audit_bots_env_and_login_matching(self):
        self.assertIn("eventus-action-agent", dev_review.audit_bots({}))
        self.assertEqual(dev_review.audit_bots({"JOSH360_AUDIT_BOTS": "My-Bot[bot], other"}), ["my-bot", "other"])
        got = dev_review.verdict([PrComment("Eventus-Action-Agent[bot]", MARK + "x", "2026-11-17T11:00:00Z")],
                                 QUEUED, dev_review.audit_bots({}))
        self.assertIsNotNone(got)

    def test_cursor_rounds(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            self.assertIsNone(dev_review.read_cursor(work))
            first = dev_review.write_cursor(work, "o/r", 7, "abc", QUEUED)
            second = dev_review.write_cursor(work, "o/r", 7, "def", QUEUED)
            self.assertEqual((first["round"], second["round"]), (1, 2))
            self.assertEqual(dev_review.read_cursor(work)["head"], "def")


class ReviewCase(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)
        self.tree = dev_git.add_worktree(self.clone, "JP-9002-label", "main")
        self.github = FakeGitHub(self.origin)
        self.deps = make_dev_deps(self.root, ticket=FakeTicket(key=KEY), github=self.github, clone=self.clone)
        self.work = self.deps.work_dir

    def remote_branches(self):
        return dev_git.git(self.clone, "ls-remote", "--heads", "origin").split()


class OpenPr(ReviewCase):
    def setUp(self):
        super().setUp()
        self.gate = gate("open-pr")
        commit(self.tree)
        (self.work / "evidence.md").write_text(
            "---\nticket: JP-9002\nkind: development\nbase: main\nhead: x\nchecks_total: 4\nchecks_passed: 3\n---\n")

    def go(self, **over):
        args = {"ticket_key": KEY, "phi": "false", "repo": "josh/widgets", "branch": "JP-9002-label",
                "worktree": str(self.tree), "work_dir": str(self.work), "base_branch": "main",
                "pr_title": "JP-9002: Label the widget", "pr_body": "Adds the label."}
        args.update(over)
        return self.gate.run(args, self.deps)

    def test_opens_and_comments_the_spec_copy(self):
        outcome, out, _ = self.go()
        self.assertEqual(outcome, "opened")
        self.assertEqual(out, {"pr_url": "https://github.com/josh/widgets/pull/7", "pr_number": "7"})
        self.assertEqual(self.deps.ticket.posted[-1][1],
                         dev_copy.pr_opened(out["pr_url"], 3, 4, dev_git.head(self.tree)[:7]))
        self.assertIn("refs/heads/JP-9002-label", self.remote_branches())

    def test_no_evidence_file_reads_as_zero_of_zero(self):
        (self.work / "evidence.md").unlink()
        self.go()
        self.assertIn("checks 0/0", self.deps.ticket.posted[-1][1])

    def test_reuses_the_open_pull_request(self):
        self.go()
        self.go()
        self.assertEqual(sum(1 for c in self.github.calls if c[0] == "create_pr"), 1)

    def test_title_gets_the_key(self):
        self.go(pr_title="Label the widget")
        self.assertEqual(self.github.title, "JP-9002: Label the widget")
        self.go(pr_title="JP-9002 already has it")
        self.assertEqual(self.github.title, "JP-9002: Label the widget")   # the second run reused the PR

    def test_refuses_text_the_screen_flags(self):
        for over in ({"pr_body": "Fixes the label for Patient: Smith"}, {"pr_title": "Patient: Smith label"}):
            with self.assertRaises(GateError):
                self.go(phi="false", **over)
        with self.assertRaises(GateError):   # whatever phi says
            self.go(phi="true", pr_body="Patient: Smith")
        self.assertEqual(self.remote_branches().count("refs/heads/JP-9002-label"), 0)

    def test_refuses_the_base_branch(self):
        with self.assertRaises(GateError):
            self.go(branch="main")

    def test_refuses_a_dirty_worktree(self):
        (self.tree / "scrap.txt").write_text("x")
        with self.assertRaises(GateError):
            self.go()
        self.assertEqual(self.remote_branches().count("refs/heads/JP-9002-label"), 0)

    def test_refuses_nothing_to_push(self):
        fresh = dev_git.add_worktree(self.clone, "JP-9002-empty", "main")
        with self.assertRaises(GateError):
            self.go(worktree=str(fresh), branch="JP-9002-empty")

    def test_run_twice_comments_once(self):
        self.go()
        self.go()
        self.assertEqual(len(self.deps.ticket.posted), 1)

    def test_a_failed_push_is_a_gate_error(self):
        dev_git.git(self.tree, "remote", "set-url", "origin", str(self.root / "no-such-origin"))
        with self.assertRaises(GateError):
            self.go()


class QueueAudit(ReviewCase):
    def setUp(self):
        super().setUp()
        self.gate = gate("queue-audit")

    def go(self):
        return self.gate.run({"repo": "josh/widgets", "pr_number": "7", "work_dir": str(self.work)}, self.deps)

    def test_adds_trigger_and_writes_cursor(self):
        outcome, _, _ = self.go()
        self.assertEqual(outcome, "queued")
        self.assertEqual(self.github.labels, [T])
        cursor = dev_review.read_cursor(self.work)
        self.assertEqual((cursor["repo"], cursor["pr"], cursor["queued_at"], cursor["round"]),
                         ("josh/widgets", 7, "2026-11-17T12:00:00Z", 1))

    def test_removes_only_terminal_labels(self):
        self.github.labels = [CH, RD, IP, BL]
        self.go()
        self.assertEqual(sorted(self.github.labels), sorted([IP, BL, T]))
        removed = [c[2] for c in self.github.calls if c[0] == "remove_label"]
        self.assertEqual(sorted(removed), sorted([CH, RD]))

    def test_makes_the_labels_first(self):
        self.go()
        self.assertEqual(self.github.calls[0], ("ensure_labels",))

    def test_trigger_already_on_is_not_added_again(self):
        self.github.labels = [T]
        self.go()
        self.assertFalse([c for c in self.github.calls if c[0] == "add_label"])

    def test_a_second_queue_is_round_two(self):
        self.go()
        self.go()
        self.assertEqual(dev_review.read_cursor(self.work)["round"], 2)

    def test_a_failed_read_is_a_gate_error(self):
        self.github.fail_on.add("ensure_labels")
        with self.assertRaises(GateError):
            self.go()


class ReviewState(ReviewCase):
    def setUp(self):
        super().setUp()
        self.gate = gate("review-state")
        dev_review.write_cursor(self.work, "josh/widgets", 7, "abc", QUEUED)

    def go(self, now=None):
        if now:
            self.deps.now = lambda: now
        return self.gate.run({"repo": "josh/widgets", "pr_number": "7", "work_dir": str(self.work)}, self.deps)

    def verdict(self, n=2, author="eventus-action-agent[bot]", created="2026-11-17T11:00:00Z", marker=MARK):
        body = marker + "\n".join("## Finding {}: x".format(i) for i in range(1, n + 1))
        self.github.comment_rows.append(PrComment(author, body, created))

    def outcome(self, **kw):
        return self.go(**kw)[0]

    def test_merged_is_ready(self):
        self.github.state = "MERGED"
        self.assertEqual(self.outcome(), "ready")

    def test_merged_by_hand_is_ready(self):
        self.github.state, self.github.labels = "MERGED", [T]
        self.assertEqual(self.outcome(), "ready")

    def test_closed_by_hand_is_blocked(self):
        self.github.state, self.github.labels = "CLOSED", [T]
        self.assertEqual(self.outcome(), "blocked")

    def test_trigger_is_pending(self):
        self.github.labels = [T]
        self.assertEqual(self.outcome(), "pending")

    def test_blocked_label_is_blocked(self):
        self.github.labels = [BL, IP]
        self.assertEqual(self.outcome(), "blocked")

    def test_in_progress_is_pending(self):
        self.github.labels = [IP]
        self.assertEqual(self.outcome(), "pending")

    def test_changes_with_a_verdict(self):
        self.github.labels = [CH]
        self.verdict(2)
        outcome, outputs, _ = self.go()
        self.assertEqual(outcome, "changes")
        self.assertEqual(outputs["issue_count"], 2)
        self.assertIn("Finding 2", outputs["findings"])

    def test_changes_uncountable_is_four(self):
        self.github.labels = [CH]
        self.github.comment_rows.append(PrComment("eventus-action-agent[bot]", MARK + "Some things to tidy.", "2026-11-17T11:00:00Z"))
        outcome, outputs, _ = self.go()
        self.assertEqual((outcome, outputs["issue_count"]), ("changes", 4))

    def test_changes_without_a_verdict_is_pending(self):
        self.github.labels = [CH]
        self.assertEqual(self.outcome(), "pending")

    def test_marker_from_a_stranger_is_not_a_verdict(self):
        self.github.labels = [CH]
        self.verdict(2, author="someone-else")
        self.assertEqual(self.outcome(), "pending")

    def test_verdict_older_than_the_round_is_ignored(self):
        self.github.labels = [CH]
        self.verdict(2, created="2026-11-17T09:00:00Z")
        self.assertEqual(self.outcome(), "pending")

    def test_newest_verdict_wins(self):
        self.github.labels = [CH]
        self.verdict(5, created="2026-11-17T10:30:00Z")
        self.verdict(1, created="2026-11-17T11:30:00Z")
        self.assertEqual(self.go()[1]["issue_count"], 1)

    def test_ready_with_failed_checks(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "fail", "2026-11-17T11:00:00Z"), Check("lint", "pass", "2026-11-17T11:00:00Z")]
        outcome, outputs, _ = self.go()
        self.assertEqual((outcome, outputs), ("checks_failed", {"findings": "suite", "issue_count": 0}))

    def test_ready_with_green_checks(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "pass", "2026-11-17T11:00:00Z")]
        self.assertEqual(self.outcome(), "ready")

    def test_latest_check_of_a_name_counts(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "fail", "2026-11-17T09:00:00Z"), Check("suite", "pass", "2026-11-17T11:00:00Z")]
        self.assertEqual(self.outcome(), "ready")

    def test_ready_with_pending_checks(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "pending", "2026-11-17T11:00:00Z")]
        self.assertEqual(self.outcome(), "pending")

    def test_ready_with_no_checks_waits_for_the_grace(self):
        self.github.labels = [RD]
        self.assertEqual(self.outcome(now=datetime(2026, 11, 17, 10, 20, tzinfo=timezone.utc)), "pending")
        self.assertEqual(self.outcome(now=datetime(2026, 11, 17, 10, 31, tzinfo=timezone.utc)), "ready")

    def test_grace_counts_from_the_newest_verdict(self):
        self.github.labels = [RD]
        self.verdict(0, created="2026-11-17T11:50:00Z")
        self.assertEqual(self.outcome(now=datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)), "pending")

    def test_no_review_label_is_pending(self):
        self.assertEqual(self.outcome(), "pending")

    def test_stale_after_48_hours(self):
        self.github.labels = [IP]
        self.assertEqual(self.outcome(now=datetime(2026, 11, 19, 9, 0, tzinfo=timezone.utc)), "pending")
        self.assertEqual(self.outcome(now=datetime(2026, 11, 19, 11, 0, tzinfo=timezone.utc)), "stale")

    def test_a_ready_answer_is_never_stale(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "pass", "2026-11-17T11:00:00Z")]
        self.assertEqual(self.outcome(now=datetime(2026, 12, 25, tzinfo=timezone.utc)), "ready")

    def test_failed_label_read_is_pending_not_empty(self):
        self.github.fail_on.add("pr")
        outcome, _, summary = self.go()
        self.assertEqual(outcome, "pending")
        self.assertIn("could not read", summary)

    def test_failed_comment_read_is_pending(self):
        self.github.labels = [CH]
        self.github.fail_on.add("comments")
        self.assertEqual(self.outcome(), "pending")

    def test_failed_check_read_is_pending_not_ready(self):
        self.github.labels = [RD]
        self.github.fail_on.add("checks")
        self.assertEqual(self.outcome(), "pending")

    def test_no_cursor_is_pending(self):
        (self.work / "pr-cursor.json").unlink()
        self.github.labels = [CH]
        outcome, _, summary = self.go()
        self.assertEqual(outcome, "pending")
        self.assertIn("no cursor", summary)

    def test_writes_nothing(self):
        def snapshot():
            return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()
                    and ".git" not in p.parts and "worktrees" not in p.parts and "widgets" not in p.parts[-3:-1]}
        for labels in ([T], [CH], [RD], [BL], [IP], []):
            self.github.labels = labels
            self.verdict(2)
            before = snapshot()
            self.go()
            self.assertEqual(before, snapshot(), labels)
        self.assertEqual([c for c in self.github.calls if c[0] in ("comment", "add_label", "remove_label", "merge_squash")], [])


class AfterFix(ReviewCase):
    def setUp(self):
        super().setUp()
        self.gate = gate("after-fix")
        self.spec_path = write_spec(self.work, spec_copy(phases=[
            {"id": "p1", "title": "t", "task": ["do it"], "checks": ["test -f a.txt"], "files": ["a.txt"]}],
            scenarios=[]))
        commit(self.tree)    # a.txt, committed, not pushed
        self.github.branch = "JP-9002-label"
        dev_git.push(self.tree, "JP-9002-label")
        commit(self.tree, "b.txt")   # the fixer's commit: unpushed
        dev_review.write_cursor(self.work, "josh/widgets", 7, "old", QUEUED)

    def go(self, **over):
        args = {"ticket_key": KEY, "ticket_type": "Story", "phi": "false", "repo": "josh/widgets", "pr_number": "7",
                "branch": "JP-9002-label", "spec_path": str(self.spec_path), "worktree": str(self.tree),
                "work_dir": str(self.work), "resolution": "Fixed in b.txt; ran test -f a.txt: passed.", "issue_count": "3"}
        args.update(over)
        return self.gate.run(args, self.deps)

    def calls(self, kind):
        return [c for c in self.github.calls if c[0] == kind]

    def test_three_findings_relabels_and_restarts_ci(self):
        self.github.labels = [CH]
        self.assertEqual(self.go()[0], "relabel")
        order = [(c[0], c[2]) for c in self.github.calls if c[0] in ("add_label", "remove_label")]
        self.assertEqual(order, [("remove_label", CH), ("remove_label", RD), ("add_label", RD)])
        self.assertEqual(self.github.labels, [RD])
        self.assertIn("ready for human", self.calls("comment")[0][2])
        self.assertIn("3 finding(s) addressed", self.calls("comment")[0][2])
        self.assertEqual(dev_review.read_cursor(self.work)["round"], 2)

    def test_the_fix_is_pushed(self):
        self.github.labels = [CH]
        self.go()
        self.assertEqual(dev_git.git(self.tree, "rev-parse", "origin/JP-9002-label"), dev_git.head(self.tree))

    def test_four_findings_requeues(self):
        self.github.labels = [CH]
        self.assertEqual(self.go(issue_count="4")[0], "requeue")
        self.assertIn(T, self.github.labels)
        self.assertNotIn(RD, self.github.labels)
        self.assertIn("another audit round", self.calls("comment")[0][2])

    def test_uncounted_findings_requeue(self):
        self.github.labels = [CH]
        self.assertEqual(self.go(issue_count=None)[0], "requeue")

    def test_checks_fix_requeues(self):
        self.github.labels = [RD]
        self.assertEqual(self.go(issue_count="0")[0], "requeue")
        self.assertIn(T, self.github.labels)
        self.assertIn("0 finding(s) addressed", self.calls("comment")[0][2])

    def test_failing_check_posts_nothing(self):
        write_spec(self.work, spec_copy(phases=[
            {"id": "p1", "title": "t", "task": ["do it"], "checks": ["false"], "files": ["a.txt"]}], scenarios=[]))
        self.github.labels = [CH]
        outcome, _, _ = self.go()
        self.assertEqual(outcome, "checks_failed")
        self.assertEqual([c for c in self.github.calls if c[0] in ("comment", "add_label", "remove_label")], [])
        self.assertNotEqual(dev_git.git(self.tree, "rev-parse", "origin/JP-9002-label"), dev_git.head(self.tree))
        self.assertTrue((self.work / "feedback" / "p1.md").exists())

    def test_refuses_a_dirty_worktree(self):
        (self.tree / "scrap.txt").write_text("x")
        with self.assertRaises(GateError):
            self.go()
        self.assertEqual(self.github.calls, [])

    def test_resolution_withheld_when_phi(self):
        for value in ("true", None):
            self.github.comment_rows = []
            self.go(phi=value)
            text = self.github.comment_rows[-1].body
            self.assertIn("resolution withheld: patient data, see {}".format(self.work / "resolution.md"), text)
            self.assertNotIn("Fixed in b.txt", text)
        self.assertIn("Fixed in b.txt", (self.work / "resolution.md").read_text())

    def test_resolution_the_screen_flags_is_withheld(self):
        self.go(resolution="Fixed the label for Patient: Smith")
        self.assertIn("withheld", self.github.comment_rows[-1].body)
        self.assertNotIn("Smith", self.github.comment_rows[-1].body)

    def test_comment_ends_with_the_footer(self):
        self.go()
        self.assertTrue(self.github.comment_rows[-1].body.endswith(dev_copy.FOOTER))

    def test_an_identical_newest_comment_is_not_repeated(self):
        for _ in range(2):
            self.github.labels = [CH]
            self.go()
        self.assertEqual(len(self.calls("comment")), 1)

    def test_never_removes_in_progress_or_blocked(self):
        for count in ("2", "6"):
            self.github.labels = [CH, IP, BL]
            self.go(issue_count=count)
            removed = [c[2] for c in self.github.calls if c[0] == "remove_label"]
            self.assertNotIn(IP, removed)
            self.assertNotIn(BL, removed)
            self.assertIn(IP, self.github.labels)
            self.assertIn(BL, self.github.labels)

    def test_research_ticket_runs_no_checks(self):
        self.github.labels = [CH]
        outcome, _, _ = self.go(ticket_type="Research", spec_path="none")
        self.assertEqual(outcome, "relabel")
        self.assertFalse((self.work / "state.json").exists())

    def test_evidence_is_rewritten_for_the_new_head(self):
        self.github.labels = [CH]
        self.go()
        text = (self.work / "evidence.md").read_text()
        self.assertIn("head: " + dev_git.head(self.tree), text)


if __name__ == "__main__":
    unittest.main()
