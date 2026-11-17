"""JP-151: every branch starts with its ticket key. The rule is in the docs agents read, and the scripts that read a
branch link the key-named form to its ticket. Made-up branch names only."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers import REPO  # noqa: E402
from ledger import homes, offer  # noqa: E402

AGENT_FORM = "JP-<n>-<slug>"
RULE_FILES = ("docs/WORKFLOW.md", "AGENTS.md", ".claude/workflow.config.md",
              ".claude/skills/ticket-lifecycle/SKILL.md", ".claude/skills/workflow-roles/SKILL.md")


def text(rel):
    return (REPO / rel).read_text(encoding="utf-8")


class RulesNameTheBranchForm(unittest.TestCase):

    def test_every_rule_file_gives_the_one_form(self):
        for rel in RULE_FILES:
            self.assertIn(AGENT_FORM, text(rel), rel)

    def test_cloud_sessions_are_told_to_create_the_branch(self):
        workflow = text("docs/WORKFLOW.md")
        self.assertIn("git checkout -b JP-<n>-<slug> origin/main", workflow)
        self.assertIn("git push -u origin JP-<n>-<slug>", workflow)
        tickets = text("conventions/tickets.md")
        self.assertIn("Cloud sessions create the branch themselves", tickets)
        self.assertIn("Only when the push is refused", tickets)

    def test_the_commands_point_at_the_rule(self):
        for name in ("build", "fix", "design", "ship"):
            self.assertIn("§3.8", text(".claude/commands/{}.md".format(name)), name)

    def test_titles_start_with_the_key(self):
        self.assertIn("starts with the Jira ticket key", text("docs/WORKFLOW.md"))

    def test_the_graph_gate_makes_the_same_form(self):
        self.assertIn("<KEY>-<slug>", text("graphs/gates/prepare-worktree.py"))


class ScriptsReadTheBranch(unittest.TestCase):

    def test_both_scripts_link_both_forms_to_the_key(self):
        for branch in ("JP-150-laptop-proof", "JP-150/laptop-proof", "JP-150"):
            for pattern in (homes.TICKET_BRANCH, offer.TICKET_BRANCH):
                match = pattern.match(branch)
                self.assertIsNotNone(match, branch)
                self.assertEqual(match.group(1), "JP-150")

    def test_platform_and_fixed_branches_carry_no_key(self):
        for branch in ("claude/project-thread-abc123", "main", "laptop-status", "laptop-pause", "xJP-150-a", "jp-150-a"):
            for pattern in (homes.TICKET_BRANCH, offer.TICKET_BRANCH):
                self.assertIsNone(pattern.match(branch), branch)


if __name__ == "__main__":
    unittest.main()
