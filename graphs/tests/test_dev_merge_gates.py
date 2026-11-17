"""merge-rule, merge-pr, pr-merged, clean-up, close-unmerged and close-ticket (JP-115, Task 11)."""
from __future__ import annotations

import unittest
from pathlib import Path

from dev_helpers import KEY, Case, FakeGitHub, FakeTicket, gate, make_dev_deps, scratch_repo
from lib import dev_copy, dev_git, dev_github
from lib.dev_github import Check
from lib.gate_run import GateError

T, IP, CH, RD, BL = (dev_github.TRIGGER, dev_github.IN_PROGRESS, dev_github.CHANGES, dev_github.READY, dev_github.BLOCKED)
GREEN = [Check("suite", "pass", "2026-11-17T11:00:00Z")]
URL = "https://github.com/josh/widgets/pull/7"


def commit(tree: Path, name: str = "a.txt") -> None:
    (tree / name).write_text("x\n")
    dev_git.git(tree, "add", name)
    dev_git.git(tree, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-m", "add " + name)


class MergeCase(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)
        self.tree = dev_git.add_worktree(self.clone, "JP-9002-label", "main")
        commit(self.tree)
        dev_git.push(self.tree, "JP-9002-label")
        self.github = FakeGitHub(self.origin)
        self.github.branch = "JP-9002-label"
        self.merges = "agent"
        self.ticket = FakeTicket(key=KEY)

    def deps(self):
        return make_dev_deps(self.root, ticket=self.ticket, github=self.github, clone=self.clone, merges=self.merges)

    def run_gate(self, name, **inputs):
        return gate(name).run(inputs, self.deps())

    def calls(self, kind):
        return [c for c in self.github.calls if c[0] == kind]


class MergeRule(MergeCase):
    def test_merge_rule_agent_for_josh_360_style_entry(self):
        self.assertEqual(self.run_gate("merge-rule", repo="josh/widgets")[0], "agent")

    def test_merge_rule_josh_by_default(self):
        self.merges = "josh"
        self.assertEqual(self.run_gate("merge-rule", repo="josh/widgets")[0], "josh")

    def test_merge_rule_unknown_repo_is_josh(self):
        self.assertEqual(self.run_gate("merge-rule", repo="josh/gadgets")[0], "josh")

    def test_merge_rule_unreadable_registry_is_josh(self):
        deps = self.deps()
        deps.registry_path.write_text("not json")
        self.assertEqual(gate("merge-rule").run({"repo": "josh/widgets"}, deps)[0], "josh")


class MergePr(MergeCase):
    def ready(self):
        self.github.labels = [RD]
        self.github.check_rows = list(GREEN)

    def merge(self):
        return self.run_gate("merge-pr", repo="josh/widgets", pr_number="7")

    def test_merge_pr_merges_with_ready_and_green(self):
        self.ready()
        outcome, _, _ = self.merge()
        self.assertEqual(outcome, "merged")
        self.assertEqual(self.github.state, "MERGED")
        self.assertEqual(len(self.calls("merge_squash")), 1)

    def test_merge_pr_refuses_where_agents_may_not_merge(self):
        self.ready()
        for rule in ("josh",):
            self.merges = rule
            with self.assertRaises(GateError):
                self.merge()
        with self.assertRaises(GateError):
            self.run_gate("merge-pr", repo="josh/gadgets", pr_number="7")
        self.assertEqual(self.calls("merge_squash"), [])

    def test_merge_pr_refuses_without_ready(self):
        self.github.check_rows = list(GREEN)
        with self.assertRaises(GateError):
            self.merge()
        self.assertEqual(self.calls("merge_squash"), [])

    def test_merge_pr_refuses_with_trigger_still_on(self):
        for extra in (T, IP, CH, BL):
            self.ready()
            self.github.labels.append(extra)
            with self.assertRaises(GateError, msg=extra):
                self.merge()
        self.assertEqual(self.calls("merge_squash"), [])

    def test_merge_pr_refuses_no_checks(self):
        self.github.labels = [RD]
        with self.assertRaises(GateError):
            self.merge()

    def test_merge_pr_refuses_a_red_check(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "fail", "2026-11-17T11:00:00Z")]
        with self.assertRaises(GateError):
            self.merge()

    def test_merge_pr_refuses_a_pending_check(self):
        self.github.labels = [RD]
        self.github.check_rows = [Check("suite", "pending", "2026-11-17T11:00:00Z")]
        with self.assertRaises(GateError):
            self.merge()

    def test_merge_pr_refuses_a_closed_pull_request(self):
        self.ready()
        self.github.state = "CLOSED"
        with self.assertRaises(GateError):
            self.merge()

    def test_merge_pr_already_merged_does_not_merge_again(self):
        self.github.state = "MERGED"
        self.assertEqual(self.merge()[0], "merged")
        self.assertEqual(self.calls("merge_squash"), [])

    def test_merge_pr_passes_the_head_it_read(self):
        self.ready()
        self.merge()
        self.assertEqual(self.calls("merge_squash")[0][2], dev_git.head(self.tree))

    def test_merge_pr_unconfirmed_merge_is_an_error(self):
        self.ready()
        original = self.github.merge_squash

        def silent(number, sha):
            original(number, sha)
            self.github.state = "OPEN"
        self.github.merge_squash = silent
        with self.assertRaises(GateError):
            self.merge()

    def test_merge_pr_a_failed_merge_is_an_error(self):
        self.ready()
        self.github.fail_on.add("merge_squash")
        with self.assertRaises(GateError):
            self.merge()


class PrMerged(MergeCase):
    def state(self):
        return self.run_gate("pr-merged", repo="josh/widgets", pr_number="7")[0]

    def test_pr_merged_three_states(self):
        self.github.state = "MERGED"
        self.assertEqual(self.state(), "merged")
        self.github.state = "CLOSED"
        self.assertEqual(self.state(), "closed")
        self.github.state = "OPEN"
        self.assertEqual(self.state(), "pending")

    def test_pr_merged_failed_read_is_pending(self):
        self.github.fail_on.add("pr")
        self.assertEqual(self.state(), "pending")

    def test_pr_merged_writes_nothing(self):
        self.github.labels = [RD]
        self.state()
        self.assertEqual([c for c in self.github.calls if c[0] != "pr"], [])


class CleanUp(MergeCase):
    def setUp(self):
        super().setUp()
        self.github.state = "MERGED"

    def clean(self):
        return self.run_gate("clean-up", repo="josh/widgets", pr_number="7", worktree=str(self.tree),
                             branch="JP-9002-label", work_dir=str(self.root / "runs" / "run-1" / "work"))

    def test_clean_up_removes_worktree_and_branches(self):
        self.assertEqual(self.clean()[0], "cleaned")
        self.assertFalse(self.tree.exists())
        self.assertEqual(dev_git.git(self.clone, "branch", "--list", "JP-9002-label"), "")
        self.assertEqual(self.calls("delete_branch"), [("delete_branch", "JP-9002-label")])

    def test_clean_up_refuses_uncommitted_and_deletes_nothing(self):
        (self.tree / "scrap.txt").write_text("x")
        with self.assertRaises(GateError):
            self.clean()
        self.assertTrue((self.tree / "scrap.txt").exists())
        self.assertEqual(self.calls("delete_branch"), [])

    def test_clean_up_refuses_a_commit_the_pull_request_lacks(self):
        commit(self.tree, "late.txt")    # committed after the push: the PR does not hold it
        with self.assertRaises(GateError):
            self.clean()
        self.assertTrue((self.tree / "late.txt").exists())
        self.assertIn("JP-9002-label", dev_git.git(self.clone, "branch", "--list", "JP-9002-label"))
        self.assertEqual(self.calls("delete_branch"), [])

    def test_clean_up_refuses_an_open_pull_request(self):
        self.github.state = "OPEN"
        with self.assertRaises(GateError):
            self.clean()
        self.assertTrue(self.tree.exists())

    def test_clean_up_twice_is_cleaned(self):
        self.clean()
        self.assertEqual(self.clean()[0], "cleaned")

    def test_clean_up_remote_branch_already_gone(self):
        self.github.delete_branch = lambda branch: None   # GitHub already deleted it: the port treats that as fine
        self.assertEqual(self.clean()[0], "cleaned")

    def test_clean_up_a_failed_delete_is_an_error(self):
        self.github.fail_on.add("delete_branch")
        with self.assertRaises(GateError):
            self.clean()


class CloseUnmerged(MergeCase):
    def setUp(self):
        super().setUp()
        self.github.state = "CLOSED"

    def close(self):
        deps = self.deps()
        return gate("close-unmerged").run(
            {"ticket_key": KEY, "repo": "josh/widgets", "pr_url": URL, "worktree": str(self.tree),
             "branch": "JP-9002-label", "work_dir": str(deps.work_dir)}, deps)

    def test_close_unmerged_cancels_and_keeps_the_remote_branch(self):
        outcome, _, summary = self.close()
        self.assertEqual(outcome, "cancelled")
        self.assertEqual(self.ticket.moves, [(KEY, "Cancelled")])
        self.assertEqual(self.calls("delete_branch"), [])
        self.assertFalse(self.tree.exists())
        self.assertIn("worktree removed", summary)
        self.assertIn("refs/heads/JP-9002-label", dev_git.git(self.clone, "ls-remote", "--heads", "origin"))

    def test_close_unmerged_keeps_a_worktree_at_risk(self):
        (self.tree / "scrap.txt").write_text("x")
        outcome, _, summary = self.close()
        self.assertEqual(outcome, "cancelled")
        self.assertTrue((self.tree / "scrap.txt").exists())
        self.assertIn("worktree kept", summary)
        self.assertEqual(self.ticket.moves, [(KEY, "Cancelled")])

    def test_close_unmerged_comment_is_the_spec_copy(self):
        self.close()
        self.assertEqual(self.ticket.posted[-1][1], dev_copy.cancelled(URL, "run-1"))

    def test_close_unmerged_run_twice_comments_once(self):
        self.close()
        self.close()
        self.assertEqual(len(self.ticket.posted), 1)

    def test_close_unmerged_refuses_a_merged_or_open_pull_request(self):
        for state in ("MERGED", "OPEN"):
            self.github.state = state
            with self.assertRaises(GateError):
                self.close()
        self.assertEqual(self.ticket.moves, [])

    def test_close_unmerged_refuses_an_address_in_another_repository(self):
        deps = self.deps()
        with self.assertRaises(GateError):
            gate("close-unmerged").run({"ticket_key": KEY, "repo": "josh/widgets",
                                        "pr_url": "https://github.com/josh/other/pull/7", "worktree": str(self.tree),
                                        "branch": "JP-9002-label", "work_dir": str(deps.work_dir)}, deps)


class CloseTicket(MergeCase):
    def setUp(self):
        super().setUp()
        self.github.state = "MERGED"
        self.github.merge_commit = "abcdef0123456789"

    def close(self, **over):
        args = {"ticket_key": KEY, "ticket_type": "Story", "phi": "false", "pr_url": URL, "spec_path": None,
                "evidence_path": None, "deliverable_path": None}
        args.update(over)
        return gate("close-ticket").run(args, self.deps())

    def test_close_ticket_development_copy(self):
        outcome, _, _ = self.close()
        self.assertEqual(outcome, "closed")
        self.assertEqual(self.ticket.posted[-1][1], dev_copy.done_merged(URL, "abcdef0", "run-1", False))
        self.assertEqual(self.ticket.moves, [(KEY, "Done")])

    def test_close_ticket_research_copy(self):
        self.close(ticket_type="Research")
        self.assertIn("design and plan merged with it, run run-1", self.ticket.posted[-1][1])

    def test_close_ticket_refuses_an_unmerged_pull_request(self):
        for state in ("OPEN", "CLOSED"):
            self.github.state = state
            with self.assertRaises(GateError):
                self.close()
        self.assertEqual(self.ticket.moves, [])

    def test_close_ticket_twice_comments_once(self):
        self.close()
        self.close()
        self.assertEqual(len(self.ticket.posted), 1)

    def test_close_ticket_a_failed_read_is_an_error(self):
        self.github.fail_on.add("pr")
        with self.assertRaises(GateError):
            self.close()

    def test_close_ticket_old_mode_unchanged(self):
        # no pr_url: the non-development path, which needs the evidence file (JP-123's own tests cover its copy)
        with self.assertRaises(GateError):
            self.close(pr_url=None, evidence_path=str(self.root / "none.md"))


if __name__ == "__main__":
    unittest.main()
