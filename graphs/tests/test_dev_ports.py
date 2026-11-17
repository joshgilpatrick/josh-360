"""The git and GitHub ports and the new ticket fields (JP-115, Task 7). Scratch repositories and a fake `gh`; no network."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from dev_helpers import Case, FakeTicket, fake_gh, read_calls, scratch_repo
from lib import dev_git, dev_github
from lib.dev_git import GitError
from lib.dev_github import GitHub, GitHubError
from lib.gate_run import Deps, Ticket
from lib.ticket_port import JiraPort

REGISTRY_SYSTEM = {"name": "widgets", "repositories": ["widgets"], "folders": ["~/nowhere/widgets", "~/real/widgets"]}


class GitCase(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)

    def commit_in(self, folder: Path, name: str = "a.txt", text: str = "a\n") -> str:
        (folder / name).write_text(text)
        dev_git.git(folder, "add", name)
        dev_git.git(folder, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "add " + name)
        return dev_git.head(folder)


class TestCloneAndNames(Case):
    def registry(self, systems):
        path = self.root / "registry.json"
        path.write_text(json.dumps({"systems": systems}))
        return path

    def test_clone_for_finds_first_existing_folder(self):
        (self.root / "home" / "real" / "widgets").mkdir(parents=True)
        path = self.registry([REGISTRY_SYSTEM])
        found = dev_git.clone_for(path, "josh/widgets", {"HOME": str(self.root / "home")})
        self.assertEqual(found, self.root / "home" / "real" / "widgets")

    def test_clone_for_unknown_repo_raises(self):
        path = self.registry([REGISTRY_SYSTEM])
        with self.assertRaises(GitError):
            dev_git.clone_for(path, "josh/gadgets", {"HOME": str(self.root)})
        with self.assertRaises(GitError):   # known repository, no folder exists
            dev_git.clone_for(path, "josh/widgets", {"HOME": str(self.root / "empty")})

    def test_owner_repo_https_and_ssh(self):
        _, clone = scratch_repo(self.root, "named")
        for url in ("https://github.com/josh/widgets.git", "git@github.com:josh/widgets.git",
                    "https://github.com/josh/widgets", "ssh://git@github.com/josh/widgets.git"):
            dev_git.git(clone, "remote", "set-url", "origin", url)
            self.assertEqual(dev_git.owner_repo(clone), "josh/widgets", url)

    def test_slug(self):
        self.assertEqual(dev_git.slug("Fix: the Widget's  label!"), "fix-the-widget-s-label")
        long = dev_git.slug("add the label to the widget and then check that it reads back properly on a screen")
        self.assertLessEqual(len(long), 40)
        self.assertEqual(long, "add-the-label-to-the-widget-and-then")   # cut at a word end, not mid-word
        self.assertEqual(dev_git.slug(""), "work")
        self.assertEqual(dev_git.slug("!!!"), "work")


class TestWorktrees(GitCase):
    def test_ticket_branches_local_and_remote_once(self):
        dev_git.git(self.clone, "branch", "JP-9-one")
        dev_git.git(self.clone, "push", "origin", "JP-9-one", "JP-9-one:JP-9-two")
        dev_git.git(self.clone, "branch", "JP-90-other")
        dev_git.git(self.clone, "fetch", "origin")
        self.assertEqual(dev_git.ticket_branches(self.clone, "JP-9"), ["JP-9-one", "JP-9-two"])

    def test_add_worktree_cuts_from_origin_base_and_leaves_the_clone_alone(self):
        self.commit_in(self.clone, "local-only.txt")         # the clone's own main moves ahead of origin
        before = dev_git.git(self.clone, "status", "--porcelain"), dev_git.git(self.clone, "branch", "--show-current")
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.assertEqual(tree, self.clone / ".claude" / "worktrees" / "JP-9-label")
        self.assertFalse((tree / "local-only.txt").exists())   # cut from origin/main, not the clone's main
        self.assertTrue((tree / "README.md").exists())
        self.assertEqual(dev_git.git(tree, "branch", "--show-current"), "JP-9-label")
        after = dev_git.git(self.clone, "status", "--porcelain"), dev_git.git(self.clone, "branch", "--show-current")
        self.assertEqual(before, after)
        self.assertTrue((self.clone / "local-only.txt").exists())

    def test_add_worktree_twice_returns_the_same(self):
        first = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.commit_in(first)
        second = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.assertEqual(first, second)
        self.assertTrue((second / "a.txt").exists())   # nothing was reset

    def test_add_worktree_on_a_branch_that_exists_only_on_origin(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.commit_in(tree)
        dev_git.push(tree, "JP-9-label")
        dev_git.git(self.clone, "worktree", "remove", "--force", str(tree))
        dev_git.git(self.clone, "branch", "-D", "JP-9-label")
        again = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.assertTrue((again / "a.txt").exists())

    def test_unpushed_counts_local_commits(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.assertEqual(dev_git.unpushed(tree), 0)
        self.commit_in(tree)
        self.assertEqual(dev_git.unpushed(tree), 1)
        dev_git.push(tree, "JP-9-label")
        self.assertEqual(dev_git.unpushed(tree), 0)
        self.assertEqual(dev_git.ahead_of(tree, "main"), 1)

    def test_diff_helpers_read_against_origin_base(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.commit_in(tree, "a.txt", "one\ntwo\n")
        self.assertEqual(dev_git.changed_files(tree, "main"), ["a.txt"])
        self.assertIn("a.txt", dev_git.diff_stat(tree, "main"))
        self.assertEqual(dev_git.added_lines(tree, "main"), [("a.txt", "one"), ("a.txt", "two")])

    def test_remove_worktree_refuses_dirty(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        (tree / "scrap.txt").write_text("x")
        reason = dev_git.remove_worktree(self.clone, tree, "JP-9-label")
        self.assertIsNotNone(reason)
        self.assertTrue(tree.exists())

    def test_remove_worktree_refuses_unpushed(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.commit_in(tree)
        reason = dev_git.remove_worktree(self.clone, tree, "JP-9-label")
        self.assertIsNotNone(reason)
        self.assertTrue(tree.exists())
        self.assertIn("JP-9-label", dev_git.git(self.clone, "branch", "--list", "JP-9-label"))

    def test_remove_worktree_refuses_when_head_is_not_the_pushed_head(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        pushed = self.commit_in(tree)
        dev_git.push(tree, "JP-9-label")
        self.commit_in(tree, "b.txt")
        self.assertIsNotNone(dev_git.remove_worktree(self.clone, tree, "JP-9-label", pushed))
        self.assertTrue(tree.exists())

    def test_remove_worktree_removes_when_head_is_the_pushed_head(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        pushed = self.commit_in(tree)
        dev_git.push(tree, "JP-9-label")
        self.assertIsNone(dev_git.remove_worktree(self.clone, tree, "JP-9-label", pushed))
        self.assertFalse(tree.exists())
        self.assertEqual(dev_git.git(self.clone, "branch", "--list", "JP-9-label"), "")

    def test_remove_worktree_removes_a_pushed_clean_one_without_a_pushed_head(self):
        tree = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.commit_in(tree)
        dev_git.push(tree, "JP-9-label")
        self.assertIsNone(dev_git.remove_worktree(self.clone, tree, "JP-9-label"))

    def test_remove_worktree_already_gone_is_none(self):
        tree = self.clone / ".claude" / "worktrees" / "JP-9-label"
        self.assertIsNone(dev_git.remove_worktree(self.clone, tree, "JP-9-label"))
        made = dev_git.add_worktree(self.clone, "JP-9-label", "main")
        self.assertIsNone(dev_git.remove_worktree(self.clone, made, "JP-9-label"))
        self.assertIsNone(dev_git.remove_worktree(self.clone, made, "JP-9-label"))   # and again


def pr_json(**over):
    row = {"number": 7, "url": "https://github.com/josh/widgets/pull/7", "state": "OPEN",
           "labels": [{"name": "review:needs-agent-audit"}], "headRefOid": "abc", "headRefName": "JP-9-label",
           "baseRefName": "main", "mergeCommit": None}
    row.update(over)
    return json.dumps(row)


class TestGitHub(Case):
    def gh(self, responses):
        path, calls = fake_gh(self.root, responses)
        self.calls = calls
        return GitHub("josh/widgets", environ={"PATH": path, "HOME": str(self.root)})

    def args(self):
        return [c["args"] for c in read_calls(self.calls)]

    def test_pr_view_parses(self):
        gh = self.gh({"pr view": {"out": pr_json(state="MERGED", mergeCommit={"oid": "deadbeef"})}})
        pr = gh.pr(7)
        self.assertEqual((pr.number, pr.state, pr.head_sha, pr.head_ref, pr.base_ref, pr.labels, pr.merge_commit),
                         (7, "MERGED", "abc", "JP-9-label", "main", ["review:needs-agent-audit"], "deadbeef"))
        self.assertEqual(self.args()[0][:5], ["pr", "view", "7", "--repo", "josh/widgets"])

    def test_pr_view_without_merge_commit(self):
        self.assertEqual(self.gh({"pr view": {"out": pr_json()}}).pr(7).merge_commit, "")

    def test_open_pr_for(self):
        gh = self.gh({"pr list": {"out": "[" + pr_json() + "]"}})
        self.assertEqual(gh.open_pr_for("JP-9-label").number, 7)
        gh = self.gh({"pr list": {"out": "[]"}})
        self.assertIsNone(gh.open_pr_for("JP-9-label"))

    def test_create_pr_reads_it_back(self):
        gh = self.gh({"pr create": {"out": "https://github.com/josh/widgets/pull/7\n"}, "pr view": {"out": pr_json()}})
        pr = gh.create_pr("JP-9-label", "main", "JP-9 Label", "body text")
        self.assertEqual(pr.number, 7)
        create = [a for a in self.args() if a[:2] == ["pr", "create"]][0]
        self.assertIn("--body-file", create)
        self.assertNotIn("body text", create)   # the body goes through a file, never the command line

    def test_checks_exit_8_still_lists(self):
        rows = [{"name": "suite", "bucket": "pending", "startedAt": "2026-11-17T00:00:00Z"}]
        gh = self.gh({"pr checks": {"rc": 8, "out": json.dumps(rows)}})
        self.assertEqual([(c.name, c.bucket) for c in gh.checks(7)], [("suite", "pending")])

    def test_checks_none_reported_is_empty(self):
        gh = self.gh({"pr checks": {"rc": 1, "err": "no checks reported on the 'JP-9-label' branch"}})
        self.assertEqual(gh.checks(7), [])

    def test_gh_failure_raises(self):
        gh = self.gh({"pr checks": {"rc": 1, "err": "HTTP 502: bad gateway\nmore"}})
        with self.assertRaises(GitHubError) as caught:
            gh.checks(7)
        self.assertIn("HTTP 502", str(caught.exception))
        self.assertNotIn("more", str(caught.exception))   # first line of stderr only
        with self.assertRaises(GitHubError):
            self.gh({"pr view": {"rc": 1, "err": "boom"}}).pr(7)

    def test_checks_unreadable_output_raises(self):
        with self.assertRaises(GitHubError):
            self.gh({"pr checks": {"rc": 0, "out": "not json"}}).checks(7)

    def test_comments_reads_paginated_arrays(self):
        page = lambda n: json.dumps([{"user": {"login": "bot"}, "body": "c%d" % n, "created_at": "2026-11-17T00:0%d:00Z" % n}])
        gh = self.gh({"api --paginate": {"out": page(1) + page(2)}})
        self.assertEqual([c.body for c in gh.comments(7)], ["c1", "c2"])
        self.assertEqual(gh.comments(7)[0].author, "bot")

    def test_comment_sends_the_body_on_stdin(self):
        gh = self.gh({})
        gh.comment(7, "hello there")
        call = read_calls(self.calls)[0]
        self.assertEqual(call["args"], ["api", "repos/josh/widgets/issues/7/comments", "--input", "-"])
        self.assertEqual(json.loads(call["stdin"]), {"body": "hello there"})

    def test_add_label(self):
        gh = self.gh({})
        gh.add_label(7, "review:needs-agent-audit")
        call = read_calls(self.calls)[0]
        self.assertEqual(call["args"][:2], ["api", "repos/josh/widgets/issues/7/labels"])
        self.assertEqual(json.loads(call["stdin"]), {"labels": ["review:needs-agent-audit"]})

    def test_remove_label_encodes_the_colon(self):
        gh = self.gh({})
        gh.remove_label(7, "review:changes-requested")
        self.assertEqual(self.args()[0], ["api", "-X", "DELETE",
                                          "repos/josh/widgets/issues/7/labels/review%3Achanges-requested"])

    def test_remove_label_absent_is_fine(self):
        gh = self.gh({"api -X DELETE": {"rc": 1, "err": "gh: Label does not exist (HTTP 404)"}})
        gh.remove_label(7, "review:changes-requested")
        gh = self.gh({"api -X DELETE": {"rc": 1, "err": "gh: Server Error (HTTP 500)"}})
        with self.assertRaises(GitHubError):
            gh.remove_label(7, "review:changes-requested")

    def test_ensure_labels_creates_only_the_missing(self):
        gh = self.gh({"label list": {"out": json.dumps([{"name": dev_github.TRIGGER}, {"name": "bug"}])}})
        gh.ensure_labels()
        created = [a[2] for a in self.args() if a[:2] == ["label", "create"]]
        self.assertEqual(sorted(created), sorted(set(dev_github.REVIEW_LABELS) - {dev_github.TRIGGER}))
        for a in self.args():
            if a[:2] == ["label", "create"]:
                color, description = dev_github.REVIEW_LABELS[a[2]]
                self.assertEqual(a[a.index("--color") + 1], color)
                self.assertEqual(a[a.index("--description") + 1], description)
                self.assertNotIn("--force", a)

    def test_label_constants(self):
        self.assertEqual(dev_github.REVIEW_LABELS[dev_github.BLOCKED], ("D93F0B", "PR-native audit session needs human input to proceed"))
        self.assertEqual(dev_github.REVIEW_LABELS[dev_github.READY][0], "0E8A16")
        self.assertEqual([dev_github.TRIGGER, dev_github.IN_PROGRESS, dev_github.CHANGES, dev_github.READY, dev_github.BLOCKED],
                         ["review:needs-agent-audit", "review:audit-in-progress", "review:changes-requested",
                          "review:ready-for-human", "review:audit-blocked"])

    def test_merge_passes_the_head_commit(self):
        gh = self.gh({})
        gh.merge_squash(7, "cafe123")
        self.assertEqual(self.args()[0], ["pr", "merge", "7", "--repo", "josh/widgets", "--squash",
                                          "--match-head-commit", "cafe123"])

    def test_delete_branch(self):
        gh = self.gh({})
        gh.delete_branch("JP-9-label")
        self.assertEqual(self.args()[0], ["api", "-X", "DELETE", "repos/josh/widgets/git/refs/heads/JP-9-label"])
        gh = self.gh({"api -X DELETE": {"rc": 1, "err": "gh: Reference does not exist (HTTP 422)"}})
        gh.delete_branch("JP-9-label")   # absent is fine
        gh = self.gh({"api -X DELETE": {"rc": 1, "err": "gh: Bad credentials (HTTP 401)"}})
        with self.assertRaises(GitHubError):
            gh.delete_branch("JP-9-label")

    def test_parse_pr_url(self):
        self.assertEqual(dev_github.parse_pr_url("https://github.com/josh/widgets/pull/12"), ("josh/widgets", 12))
        self.assertEqual(dev_github.parse_pr_url("https://github.com/josh/widgets/pull/12/"), ("josh/widgets", 12))
        for bad in ("https://example.com/josh/widgets/pull/12", "https://github.com/josh/widgets/issues/12", "x"):
            with self.assertRaises(GitHubError):
                dev_github.parse_pr_url(bad)

    def test_timeout_raises(self):
        def slow(*a, **k):
            raise subprocess.TimeoutExpired("gh", 60)
        gh = GitHub("josh/widgets", environ={}, runner=slow)
        with self.assertRaises(GitHubError):
            gh.pr(7)


class FakeJira:
    def __init__(self, issue, fields=None):
        self.issue, self.fields = issue, fields

    def get(self, key, fields=None):
        if self.issue is None:
            return None
        if fields is not None:
            return dict(self.issue, fields=self.fields or {})
        return self.issue

    def get_property(self, key, name):
        return {"graph": "development"}


class TestTicketFields(Case):
    def test_ticket_defaults_keep_old_callers_working(self):
        t = Ticket("JP-1", "Ready", "d", None)
        self.assertEqual((t.summary, t.issuetype, t.flagged), ("", "", False))

    def test_read_fills_the_new_fields(self):
        issue = {"status": "Ready", "description": "d", "summary": "Label it", "issuetype": "Task", "flagged": True}
        t = JiraPort(FakeJira(issue)).read("JP-1")
        self.assertEqual((t.summary, t.issuetype, t.flagged), ("Label it", "Task", True))

    def test_agent_status_reads_the_option_value(self):
        issue = {"status": "Ready", "description": "d"}
        port = JiraPort(FakeJira(issue, {"customfield_10453": {"value": "Running", "id": "1"}}))
        self.assertEqual(port.agent_status("JP-1"), "Running")
        self.assertIsNone(JiraPort(FakeJira(issue, {"customfield_10453": None})).agent_status("JP-1"))
        self.assertIsNone(JiraPort(FakeJira(issue, {})).agent_status("JP-1"))

    def test_agent_status_uses_the_named_field_and_fails_loudly(self):
        issue = {"status": "Ready", "description": "d"}
        import os
        os.environ["JOSH360_AGENT_STATUS_FIELD"] = "customfield_99999"
        self.addCleanup(os.environ.pop, "JOSH360_AGENT_STATUS_FIELD", None)
        port = JiraPort(FakeJira(issue, {"customfield_99999": {"value": "Stuck"}}))
        self.assertEqual(port.agent_status("JP-1"), "Stuck")
        from lib.gate_run import GateError
        with self.assertRaises(GateError):
            JiraPort(FakeJira(None)).agent_status("JP-1")

    def test_fake_ticket_matches(self):
        fake = FakeTicket(summary="S", issuetype="Task", flagged=True, agent_status="Queued")
        t = fake.read("JP-9001")
        self.assertEqual((t.summary, t.issuetype, t.flagged, fake.agent_status("JP-9001")), ("S", "Task", True, "Queued"))


class TestDeps(Case):
    def test_deps_run_fields(self):
        env = {"JOSH360_RUN_ID": "r9", "JOSH360_RUNS": str(self.root / "runs"), "HOME": str(self.root)}
        deps = Deps(env)
        self.assertEqual((deps.run_id, deps.runs_dir, deps.work_dir),
                         ("r9", self.root / "runs", self.root / "runs" / "r9" / "work"))
        self.assertEqual(deps.now().utcoffset().total_seconds(), 0)
        self.assertIs(deps.github("josh/widgets"), deps.github("josh/widgets"))
        self.assertIsNot(deps.github("josh/widgets"), deps.github("josh/other"))


if __name__ == "__main__":
    unittest.main()
