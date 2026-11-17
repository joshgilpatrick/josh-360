"""Tests for JP-153: per-ticket decision files, merge=union, and the workflow's synchronize trigger.

Each test named after a Gherkin scenario in JP-153 proves that scenario. Run: python3 -m unittest discover -s tests
Made-up tickets (JP-9001 and up) and made-up rows only.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import decisions  # noqa: E402

ROW = "| 2026-11-17 | {t} | A made-up question? | A made-up answer. | Not needed. |"


def decision_file(ticket: str, rows: list[str] | None = None) -> str:
    rows = [ROW.format(t=ticket)] if rows is None else rows
    return "# {} decisions\n\n| Date | Ticket | Question | Option taken | How to undo |\n| --- | --- | --- | --- | --- |\n{}\n".format(
        ticket, "\n".join(rows))


def git(cwd: Path, *args: str, check: bool = True):
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@example.com", "HOME": str(cwd), "PATH": "/usr/bin:/bin:/usr/local/bin"}
    r = subprocess.run(["git", *args], cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True)
    if check and r.returncode != 0:
        raise AssertionError("git {} failed:\n{}".format(" ".join(args), r.stdout))
    return r


class FolderCase(unittest.TestCase):
    """A made-up docs/decisions folder that the checker is pointed at."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-decisions-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / "docs" / "decisions").mkdir(parents=True)
        (self.tmp / "docs" / "decisions" / "README.md").write_text("# Decisions\n")
        (self.tmp / "docs" / "decisions.md").write_text("# Decisions\n\n## Default choices made while building\n\nPointer.\n")
        self._saved = (decisions.ROOT, decisions.FOLDER, decisions.OLD_FILE)
        decisions.ROOT, decisions.FOLDER, decisions.OLD_FILE = self.tmp, self.tmp / "docs" / "decisions", self.tmp / "docs" / "decisions.md"
        self.addCleanup(lambda: setattr_all(self._saved))

    def write(self, name: str, text: str):
        (self.tmp / "docs" / "decisions" / name).write_text(text)


def setattr_all(saved):
    decisions.ROOT, decisions.FOLDER, decisions.OLD_FILE = saved


class TestChecker(FolderCase):
    def test_the_real_decision_files_pass(self):
        decisions.ROOT, decisions.FOLDER, decisions.OLD_FILE = ROOT, ROOT / "docs" / "decisions", ROOT / "docs" / "decisions.md"
        self.assertEqual(decisions.check(), [])

    def test_a_well_formed_file_passes(self):
        self.write("JP-9001.md", decision_file("JP-9001"))
        self.assertEqual(decisions.check(), [])

    def test_a_row_for_another_ticket_is_refused_and_says_where_it_belongs(self):
        self.write("JP-9001.md", decision_file("JP-9001", [ROW.format(t="JP-9002")]))
        problems = decisions.check()
        self.assertEqual(len(problems), 1)
        self.assertIn("move it to docs/decisions/JP-9002.md", problems[0])

    def test_rows_left_in_the_old_table_are_refused_and_say_where_they_belong(self):
        (self.tmp / "docs" / "decisions.md").write_text(
            "# Decisions\n\n| 2026-11-16 | JP-106 | Josh's own answer | x | y |\n\n## Default choices made while building\n\n"
            + ROW.format(t="JP-9003") + "\n")
        problems = decisions.check()
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("docs/decisions/JP-9003.md", problems[0])

    def test_a_badly_named_or_shaped_file_is_refused(self):
        self.write("notes.md", "# notes\n")
        self.write("JP-9004.md", "# JP-9004 decisions\n\n| Date | Ticket | Question |\n| --- | --- | --- |\n| 2026-11-17 | JP-9004 | q |\n")
        self.write("JP-9005.md", decision_file("JP-9005", ["| 17 Nov | JP-9005 | q | a | u |", "| 2026-11-17 | JP-9005 | q | a |"]))
        problems = " ".join(decisions.check())
        self.assertIn("notes.md: name the file after its ticket", problems)
        self.assertIn("JP-9004.md: the table must start with the header", problems)
        self.assertIn("the date must be YYYY-MM-DD", problems)
        self.assertIn("a row needs five filled cells", problems)

    def test_an_escaped_pipe_does_not_split_a_cell(self):
        row = "| 2026-11-17 | JP-9006 | Is a bar ok? | The part before a `\\|` is the question. | Not needed. |"
        self.write("JP-9006.md", decision_file("JP-9006", [row]))
        self.assertEqual(decisions.check(), [])
        self.assertEqual(len(decisions.rows_of(self.tmp / "docs" / "decisions" / "JP-9006.md")[0][0][1]), 5)


class TestMerges(unittest.TestCase):
    """Two PRs that record decisions, and the append-only files, merge with no conflict."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-merge-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        git(self.tmp, "init", "-q", "-b", "main")
        shutil.copy(ROOT / ".gitattributes", self.tmp / ".gitattributes")
        (self.tmp / "docs" / "decisions").mkdir(parents=True)
        (self.tmp / "docs" / "decisions" / "README.md").write_text("# Decisions\n")
        (self.tmp / "jobs.yaml").write_text("jobs:\n  - id: follow\n    run: laptop/follow.py\n    every: 10m\n")
        (self.tmp / "docs" / "phase-1-deletion-list.md").write_text("| Item | Where |\n| --- | --- |\n| one | here |\n")
        git(self.tmp, "add", "-A")
        git(self.tmp, "commit", "-qm", "base")

    def branch(self, name: str, ticket: str, job: str, item: str):
        git(self.tmp, "checkout", "-q", "-b", name, "main")
        (self.tmp / "docs" / "decisions" / (ticket + ".md")).write_text(decision_file(ticket))
        with open(self.tmp / "jobs.yaml", "a") as f:
            f.write("\n  - id: {}\n    run: laptop/{}.py\n    every: 1h\n".format(job, job))
        with open(self.tmp / "docs" / "phase-1-deletion-list.md", "a") as f:
            f.write("| {} | there |\n".format(item))
        git(self.tmp, "add", "-A")
        git(self.tmp, "commit", "-qm", name)

    def test_two_prs_that_record_decisions_merge_cleanly(self):
        self.branch("JP-9101-a", "JP-9101", "job-a", "item a")
        self.branch("JP-9102-b", "JP-9102", "job-b", "item b")
        git(self.tmp, "checkout", "-q", "main")
        git(self.tmp, "merge", "-q", "--no-edit", "JP-9101-a")
        git(self.tmp, "checkout", "-q", "JP-9102-b")
        result = git(self.tmp, "merge", "--no-edit", "main", check=False)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue((self.tmp / "docs" / "decisions" / "JP-9101.md").is_file())
        self.assertTrue((self.tmp / "docs" / "decisions" / "JP-9102.md").is_file())
        # The union kept both sides' appended jobs and rows.
        jobs = (self.tmp / "jobs.yaml").read_text()
        self.assertIn("job-a", jobs)
        self.assertIn("job-b", jobs)
        rows = (self.tmp / "docs" / "phase-1-deletion-list.md").read_text()
        self.assertIn("item a", rows)
        self.assertIn("item b", rows)

    def test_without_the_attribute_the_same_appends_do_conflict(self):
        """The discriminator: it is merge=union that removes the conflict, not luck."""
        (self.tmp / ".gitattributes").write_text("")
        git(self.tmp, "add", "-A")
        git(self.tmp, "commit", "-qm", "no attributes")
        self.branch("JP-9103-a", "JP-9103", "job-a", "item a")
        self.branch("JP-9104-b", "JP-9104", "job-b", "item b")
        git(self.tmp, "checkout", "-q", "main")
        git(self.tmp, "merge", "-q", "--no-edit", "JP-9103-a")
        git(self.tmp, "checkout", "-q", "JP-9104-b")
        self.assertNotEqual(git(self.tmp, "merge", "--no-edit", "main", check=False).returncode, 0)


class TestWorkflow(unittest.TestCase):
    """The test workflow runs on a push to a PR that already carries a review label, and only then."""

    LABELS = ("review:ready-for-human", "review:needs-agent-audit", "review:changes-requested")

    def setUp(self):
        self.text = (ROOT / ".github" / "workflows" / "test.yml").read_text()
        self.flow = yaml.safe_load(self.text)

    def test_a_merge_main_push_reruns_the_suite(self):
        self.assertIn("synchronize", self.flow[True]["pull_request"]["types"])
        condition = self.flow["jobs"]["suite"]["if"]
        for label in self.LABELS:
            self.assertIn("contains(github.event.pull_request.labels.*.name, '{}')".format(label), condition)

    def test_a_push_to_an_unlabelled_pr_is_skipped_in_its_own_group(self):
        group = self.flow["concurrency"]["group"]
        self.assertIn("github.event.action == 'synchronize'", group)
        self.assertIn("-ignored-", group)
        for label in self.LABELS:
            self.assertIn("!contains(github.event.pull_request.labels.*.name, '{}')".format(label), group)
        self.assertTrue(self.flow["concurrency"]["cancel-in-progress"])

    def test_the_old_triggers_still_stand(self):
        self.assertEqual(self.flow[True]["push"]["branches"], ["main"])
        self.assertIn("labeled", self.flow[True]["pull_request"]["types"])
        self.assertIn("github.event.label.name == 'review:ready-for-human'", self.flow["jobs"]["suite"]["if"])


if __name__ == "__main__":
    unittest.main()
