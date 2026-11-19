"""JP-174: a graph step's session works on the ticket's one branch and one worktree and cannot make more."""
import unittest

from runner_helpers import RunnerCase  # noqa: F401  (sets up the import path)
from test_graph_step_hooks import Linked
from runner_lib import gitrail
from walker_lib import runfolder

TREE = "/Users/josh/dev/app/.claude/worktrees/JP-900-login"


class Rail(Linked):
    """A build step session for JP-900 whose run's `prepare` gate made branch JP-900-login and its worktree."""

    def setUp(self):
        super().setUp()
        doc = runfolder.load(self.run_id)
        runfolder.save_outputs(doc, "prepare", {"worktree": TREE, "branch": "JP-900-login", "work_dir": self.work})
        runfolder.save(self.run_id, doc)
        self.set_entry(ticket="JP-900")

    def test_a_second_worktree_is_refused_and_the_message_names_the_ticket_s_own(self):
        result = self.bash("git worktree add ../other")
        self.assertDenied(result, "a step session does not make a worktree")
        self.assertIn("JP-900-login", result[2])
        self.assertIn(".claude/worktrees/JP-900-login", result[2])

    def test_a_new_branch_is_refused(self):
        for command in ("git checkout -b JP-900-try2", "git switch -c JP-900-try2", "git branch JP-900-try2",
                        "cd x && git -C . checkout -B other", "git branch -m JP-900-new", "git switch --create y",
                        "git checkout --orphan z"):
            result = self.bash(command)
            self.assertDenied(result, "a step session does not make a branch")
            self.assertIn("JP-900-login", result[2], command)

    def test_the_claude_code_worktree_tool_and_flag_are_refused(self):
        self.assertDenied(self.pre("EnterWorktree", name="x"), "a step session does not make a worktree")
        self.assertDenied(self.bash("claude -p hi --worktree spare"), "a step session does not make a worktree")

    def test_committing_on_the_ticket_s_branch_is_not_refused(self):
        for command in ("git commit -m 'JP-900 add form'", "git status", "git branch", "git branch -vv",
                        "git branch --show-current", "git worktree list", "git checkout JP-900-login",
                        "git log --oneline -5", "git commit -m 'use git checkout -b next time'",
                        "git branch -d old-merged", "git checkout -- src/b.py"):
            self.assertAllowed(self.bash(command))

    def test_a_run_with_no_worktree_points_at_the_work_folder(self):
        doc = runfolder.load(self.run_id)
        doc["outputs"].pop("prepare")
        runfolder.save(self.run_id, doc)
        result = self.bash("git worktree add ../other")
        self.assertDenied(result, "a step session does not make a worktree")
        self.assertIn(self.work, result[2])

    def test_an_ordinary_session_is_untouched(self):
        self.assertAllowed(self.pre("Bash", session_id="cc-not-a-step", command="git worktree add ../other"))


class Words(unittest.TestCase):
    def test_what_each_command_makes(self):
        self.assertEqual(gitrail.refused("git worktree add ../x main"), "a worktree")
        self.assertEqual(gitrail.refused("git -c core.x=1 worktree add x"), "a worktree")
        self.assertEqual(gitrail.refused("git branch new origin/main"), "a branch")
        self.assertEqual(gitrail.refused("git branch --set-upstream-to origin/x"), None)
        self.assertEqual(gitrail.refused("git branch --format='%(refname)' --list 'JP-*'"), None)
        self.assertEqual(gitrail.refused("echo git worktree add"), None)
        self.assertEqual(gitrail.refused("git push -u origin JP-900-login"), None)


if __name__ == "__main__":
    unittest.main()
