"""JP-198: the stand-in `gh` on its own, driven through the very code that calls it on the laptop: the development
gates' `GitHub` class (`graphs/gates/lib/dev_github.py`) and the loose-ends reader (`ledger/live.py`). A temporary bare
repository stands in for GitHub's; nothing here reaches GitHub."""
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / "tests" / "e2e"
STANDIN = E2E / "standin" / "gh"
CLOCK = E2E / "clock"
REPO = "joshgilpatrick/josh-360"
sys.path.insert(0, str(ROOT / "graphs" / "gates"))
sys.path.insert(0, str(ROOT))
from lib import dev_github, dev_review  # noqa: E402
from lib.dev_github import GitHub, GitHubError  # noqa: E402
from ledger.live import Live  # noqa: E402

# Every GitHub method the gates call. A new one fails test_every_method_the_gates_call_is_answered until the stand-in
# answers it and the flow below calls it.
COVERED = {"pr", "open_pr_for", "create_pr", "comments", "comment", "ensure_labels", "add_label", "remove_label",
           "checks", "merge_squash", "default_branch", "workflow_runs", "delete_branch"}


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@e.t"] + list(args), cwd=str(cwd), check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True).stdout.strip()


class StandInGh(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-standin-gh-")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.bare = self.tmp / "repos" / (REPO + ".git")
        self.bare.parent.mkdir(parents=True)
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        self.clone = self.tmp / "josh_360"
        git(self.tmp, "clone", "-q", str(self.bare), str(self.clone))
        git(self.clone, "commit", "-q", "--allow-empty", "-m", "start")
        git(self.clone, "push", "-q", "origin", "HEAD:main")
        self.bin = self.tmp / "homebrew" / "bin"
        self.bin.mkdir(parents=True)
        os.symlink(str(STANDIN), str(self.bin / "gh"))
        self.folder = self.tmp / "github"
        self.folder.mkdir()
        (self.folder / "config.json").write_text(json.dumps({"repos": {REPO: str(self.bare)},
                                                             "audit": {"after_seconds": 300}}))
        self.clock = self.tmp / "clock"
        self.clock.write_text("0\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("GH_", "GITHUB_", "JOSH360_"))}
        self.env.update(PATH="{}:/usr/bin:/bin".format(self.bin), JOSH360_STANDIN_GH=str(self.folder),
                        JOSH360_E2E_CLOCK=str(self.clock), PYTHONPATH=str(CLOCK), HOME=str(self.tmp))
        self.github = GitHub(REPO, environ=self.env)

    def branch(self, name="JP-901-made-up", text="made up\n"):
        git(self.clone, "checkout", "-q", "-b", name)
        (self.clone / "page.md").write_text(text)
        git(self.clone, "add", "page.md")
        git(self.clone, "commit", "-q", "-m", "made up")
        git(self.clone, "push", "-q", "origin", name)
        return git(self.clone, "rev-parse", "HEAD")

    def later(self, seconds):
        self.clock.write_text("{}\n".format(float(self.clock.read_text()) + seconds))

    def calls(self):
        return [json.loads(x) for x in (self.folder / "calls.jsonl").read_text().splitlines()]

    def gh(self, *args, cwd=None):
        return subprocess.run([str(self.bin / "gh")] + list(args), cwd=str(cwd or self.tmp), env=self.env,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True)

    def test_a_pull_request_from_open_to_merged_through_the_gates_own_calls(self):
        head = self.branch()
        self.assertEqual(self.github.default_branch(), "main")
        self.assertIsNone(self.github.open_pr_for("JP-901-made-up"))
        pr = self.github.create_pr("JP-901-made-up", "main", "JP-901: Made up", "A made-up body.")
        self.assertEqual((pr.number, pr.state, pr.head_sha, pr.head_ref, pr.base_ref, pr.labels),
                         (100, "OPEN", head, "JP-901-made-up", "main", []))
        self.assertEqual(pr.url, "https://github.com/{}/pull/100".format(REPO))
        self.assertEqual(self.github.open_pr_for("JP-901-made-up").number, 100)
        self.assertEqual(self.github.checks(100), [])                   # "no checks reported" is no checks, not an error
        dev_review.queue(self.github, 100)                               # makes the labels, drops the terminal ones
        self.assertEqual(self.github.pr(100).labels, [dev_github.TRIGGER])
        self.github.ensure_labels()                                      # the second time makes none
        self.assertEqual(len([c for c in self.calls() if c["argv"][:2] == ["label", "create"]]), 5)
        self.github.comment(100, "Made-up note from a gate.")
        self.later(299)
        self.assertEqual(self.github.pr(100).labels, [dev_github.TRIGGER])   # the audit has not answered yet
        self.later(2)
        done = self.github.pr(100)
        self.assertEqual(done.labels, [dev_github.READY])
        verdict = dev_review.verdict(self.github.comments(100), "2000-01-01T00:00:00Z",
                                     dev_review.audit_bots(self.env))
        self.assertIsNotNone(verdict)
        self.assertEqual(dev_review.count_findings(verdict.body), 0)
        self.assertEqual(dev_review.check_state(self.github.checks(100)), "green")
        self.github.remove_label(100, dev_github.CHANGES)               # absent is fine
        self.github.add_label(100, "made-up")
        self.assertIn("made-up", self.github.pr(100).labels)
        self.assertEqual(self.github.workflow_runs("test.yml", "main", "2026-11-01T00:00:00Z"), [])
        self.github.merge_squash(100, head)
        merged = self.github.pr(100)
        self.assertEqual(merged.state, "MERGED")
        main = git(self.tmp, "--git-dir", str(self.bare), "rev-parse", "main")
        self.assertEqual(merged.merge_commit, main)
        self.assertEqual(git(self.tmp, "--git-dir", str(self.bare), "show", "main:page.md"), "made up")
        self.assertEqual(git(self.tmp, "--git-dir", str(self.bare), "log", "-1", "--format=%s", "main"),
                         "JP-901: Made up (#100)")
        self.github.delete_branch("JP-901-made-up")
        self.github.delete_branch("JP-901-made-up")                     # already gone is fine
        self.assertEqual(git(self.tmp, "--git-dir", str(self.bare), "for-each-ref", "refs/heads/JP-901-*"), "")
        self.assertTrue(all("unknown call" not in " ".join(c["said"]) for c in self.calls()))

    def test_a_merge_against_an_old_head_is_refused(self):
        old = self.branch()
        self.github.create_pr("JP-901-made-up", "main", "JP-901: Made up", "body")
        (self.clone / "page.md").write_text("changed\n")
        git(self.clone, "commit", "-qam", "more")
        git(self.clone, "push", "-q", "origin", "JP-901-made-up")
        self.assertNotEqual(self.github.pr(100).head_sha, old)           # an open pull request follows its branch
        with self.assertRaises(GitHubError):
            self.github.merge_squash(100, old)
        self.assertEqual(self.github.pr(100).state, "OPEN")

    def test_a_second_open_pull_request_for_the_branch_is_refused(self):
        self.branch()
        self.github.create_pr("JP-901-made-up", "main", "t", "b")
        with self.assertRaises(GitHubError):
            self.github.create_pr("JP-901-made-up", "main", "t", "b")

    def test_the_loose_ends_reader_finds_the_branchs_pull_requests_from_the_checkout(self):
        self.branch()
        pr = self.github.create_pr("JP-901-made-up", "main", "t", "b")

        def run(argv, **kw):
            return subprocess.run([str(self.bin / "gh")] + argv[1:], env=self.env, **kw)

        live = Live(run=run, use_jira=False)
        self.assertEqual(live.branch_prs(str(self.clone), "JP-901-made-up"), [{"state": "OPEN", "url": pr.url}])
        self.assertEqual(live.branch_prs(str(self.clone), "JP-902-none"), [])
        self.assertEqual(live.pr(pr.url), "OPEN")

    def test_an_unknown_call_says_so_and_is_logged(self):
        done = self.gh("repo", "delete", REPO)
        self.assertEqual(done.returncode, 1)
        self.assertIn("unknown call", done.stderr)
        self.assertEqual(self.calls()[-1]["argv"], ["repo", "delete", REPO])

    def test_a_repository_it_does_not_hold_is_not_found(self):
        with self.assertRaises(GitHubError):
            GitHub("someone/else", environ=self.env).default_branch()

    def test_every_method_the_gates_call_is_answered(self):
        public = {name for name, _ in inspect.getmembers(GitHub, inspect.isfunction) if not name.startswith("_")}
        self.assertEqual(public, COVERED)

    def test_it_parses_as_python_39(self):
        import ast
        ast.parse(STANDIN.read_text(), filename=str(STANDIN), feature_version=(3, 9))


if __name__ == "__main__":
    unittest.main()
