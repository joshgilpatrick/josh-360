"""JP-109: loose ends, computed against made-up git repositories, a made-up ledger and fake Jira and GitHub answers.

The six scenarios of the ticket are the first six tests (named after them); the rest cover each kind of loose end.
"""
import io
import json
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loose_helpers import LATER, NOW, T, LaptopCase, fake_live, git  # noqa: E402
from ledger import loose_ends  # noqa: E402


class Scenarios(LaptopCase):
    def test_a_clean_session_has_none(self):
        sha = self.branch_with_commit("JP-900/clean", push=True)
        self.merge_to_main("JP-900/clean")
        git(self.repo, "branch", "-q", "-d", "JP-900/clean")
        git(self.repo, "push", "-q", "origin", "--delete", "JP-900/clean")
        git(self.repo, "fetch", "-q", "--prune")
        uid = self.seed("sess-0001", branch="JP-900/clean", commits=[sha], ticket="JP-900",
                        pr="https://example.test/o/r/pull/1")
        live = fake_live(tickets={"JP-900": ("Done", True)}, prs={"https://example.test/o/r/pull/1": "MERGED"})
        result = self.loose(live, session="sess-0001")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["unchecked"], [])
        self.assertEqual(self.loose(live)["items"], [])
        self.assertTrue(uid)

    def test_unpushed_work_is_found(self):
        self.branch_with_commit("JP-900/unpushed")
        uid = self.seed("sess-0001", branch="JP-900/unpushed")
        result = self.loose()
        (item,) = result["items"]
        self.assertEqual(item["kind"], "unpushed-branch")
        self.assertEqual(item["sessions"], [uid])
        self.assertEqual(item["root"], str(self.repo))
        self.assertEqual(item["branch"], "JP-900/unpushed")

    def test_a_branch_kept_on_purpose_is_not_listed(self):
        self.branch_with_commit("JP-900/parallel")
        self.seed("sess-0001", branch="JP-900/parallel")
        self.assertEqual(len(self.loose()["items"]), 1)
        root = loose_ends.mark(self.conn, str(self.repo), "JP-900/parallel", True, "parallel feature", NOW)
        self.assertEqual(root, str(self.repo))
        self.assertEqual(self.loose()["items"], [])
        loose_ends.mark(self.conn, str(self.repo), "JP-900/parallel", False, None, "2026-11-17T13:00:00Z")
        self.assertEqual(len(self.loose()["items"]), 1)

    def test_skipping_the_system_costs_nothing(self):
        self.branch_with_commit("JP-900/later")
        self.seed("sess-0001", branch="JP-900/later")
        first = self.loose(now=NOW)
        # Two weeks pass and nobody asks. Meanwhile Josh pushes the branch.
        git(self.repo, "push", "-q", "-u", "origin", "JP-900/later")
        git(self.repo, "checkout", "-q", "main")
        self.merge_to_main("JP-900/later")
        second = self.loose(now=LATER)
        self.assertEqual([i["kind"] for i in first["items"]], ["unpushed-branch"])
        self.assertEqual([i["kind"] for i in second["items"]], ["orphaned-branch"])  # correct for that moment
        self.assertGreaterEqual(second["items"][0]["age_days"], 14)
        self.assertEqual(self.rows("SELECT name FROM sqlite_master WHERE name LIKE '%loose%'"), [])

    def test_only_the_laptops_work_is_listed(self):
        # A pull request and a branch that no local session touched exist in git and on GitHub.
        self.branch_with_commit("cloud/only-here", push=True)
        git(self.repo, "checkout", "-q", "main")
        self.seed("sess-0001")  # a local session with nothing of the kind
        live = fake_live(prs={"https://example.test/o/r/pull/77": "OPEN"})
        self.assertEqual(self.loose(live)["items"], [])


class Kinds(LaptopCase):
    def test_commits_on_no_branch_are_grouped_under_their_tip(self):
        git(self.repo, "checkout", "-q", "--detach")
        first = self.commit(self.repo, "detached-one")
        second = self.commit(self.repo, "detached-two")
        git(self.repo, "checkout", "-q", "main")
        self.seed("sess-0001", commits=[first, second])
        (item,) = self.loose()["items"]
        self.assertEqual((item["kind"], item["commit"], item["commits"]), ("commits-unhoused", second, 2))

    def test_commits_on_main_or_in_a_pull_request_are_not_loose(self):
        on_main = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "--detach")
        orphan = self.commit(self.repo, "squashed-away")
        git(self.repo, "checkout", "-q", "main")
        self.seed("sess-0001", commits=[on_main])
        self.seed("sess-0002", commits=[orphan], pr="https://example.test/o/r/pull/2")
        live = fake_live(prs={"https://example.test/o/r/pull/2": "MERGED"})
        self.assertEqual(self.loose(live)["items"], [])

    def test_a_commit_that_git_no_longer_has_is_unchecked_not_clean(self):
        self.seed("sess-0001", commits=["0123456789abcdef0123456789abcdef01234567"])
        result = self.loose()
        self.assertEqual(result["items"], [])
        self.assertEqual(result["unchecked"][0]["reason"], "a commit is no longer in git")

    def test_a_pushed_branch_with_more_local_commits_is_unpushed(self):
        self.branch_with_commit("JP-900/ahead", push=True)
        git(self.repo, "checkout", "-q", "JP-900/ahead")
        self.commit(self.repo, "one-more")
        git(self.repo, "checkout", "-q", "main")
        self.seed("sess-0001", branch="JP-900/ahead")
        self.assertEqual(self.kinds(self.loose()), [("unpushed-branch", "JP-900/ahead")])

    def test_orphaned_branches(self):
        self.branch_with_commit("merged-left")
        self.merge_to_main("merged-left")
        self.branch_with_commit("pushed-forgotten", push=True)
        self.branch_with_commit("pushed-open-pr", push=True)
        for sid, name in (("sess-0001", "merged-left"), ("sess-0002", "pushed-forgotten")):
            self.seed(sid, branch=name)
        self.seed("sess-0003", branch="pushed-open-pr", pr="https://example.test/o/r/pull/3")
        live = fake_live(prs={"https://example.test/o/r/pull/3": "OPEN"})
        result = self.loose(live)
        self.assertEqual(self.kinds(result), [("open-pr", "https://example.test/o/r/pull/3"),
                                              ("orphaned-branch", "merged-left"),
                                              ("orphaned-branch", "pushed-forgotten")])

    def test_a_branch_in_use_is_not_orphaned_and_main_is_never_listed(self):
        self.branch_with_commit("in-use", push=True)
        git(self.repo, "checkout", "-q", "in-use")  # the main checkout is on it
        self.seed("sess-0001", branch="in-use")
        self.seed("sess-0002", branch="main")
        self.assertEqual(self.loose()["items"], [])

    def test_an_unknown_pull_request_state_is_unchecked_not_orphaned(self):
        self.branch_with_commit("unknown-pr", push=True)
        self.seed("sess-0001", branch="unknown-pr", pr="https://example.test/o/r/pull/4")
        result = self.loose(fake_live())  # gh cannot answer
        self.assertEqual(result["items"], [])
        reasons = [u["reason"] for u in result["unchecked"]]
        self.assertEqual(reasons, ["GitHub could not be read (gh)"])

    def test_open_pull_requests_and_tickets(self):
        self.seed("sess-0001", pr="https://example.test/o/r/pull/5", ticket="JP-901")
        self.seed("sess-0002", pr="https://example.test/o/r/pull/6", ticket="JP-901")
        self.seed("sess-0003", ticket="JP-902")
        live = fake_live(tickets={"JP-901": ("Code Review", False), "JP-902": ("Done", True)},
                         prs={"https://example.test/o/r/pull/5": "OPEN", "https://example.test/o/r/pull/6": "CLOSED"})
        result = self.loose(live)
        self.assertEqual(self.kinds(result), [("open-pr", "https://example.test/o/r/pull/5"),
                                              ("ticket-not-done", "JP-901")])
        ticket = [i for i in result["items"] if i["kind"] == "ticket-not-done"][0]
        self.assertEqual(len(ticket["sessions"]), 2)  # one item, both sessions named
        self.assertEqual(ticket["status"], "Code Review")

    def test_an_unreadable_ticket_is_unchecked(self):
        self.seed("sess-0001", ticket="JP-903")
        result = self.loose(fake_live())
        self.assertEqual(result["items"], [])
        self.assertEqual(result["unchecked"][0]["reason"], "Jira could not be read")

    def test_a_leftover_worktree_resolves_to_the_main_checkout(self):
        tree = self.tmp / "work" / "josh_360" / ".claude" / "worktrees" / "JP-900" / "w"
        git(self.repo, "worktree", "add", "-q", "-b", "JP-900/w", str(tree), "main")
        self.commit(tree, "in-worktree")
        uid = self.seed("sess-0001", root=tree, branch="JP-900/w", worktree=str(tree))
        result = self.loose()
        kinds = {i["kind"]: i for i in result["items"]}
        self.assertEqual(set(kinds), {"leftover-worktree", "unpushed-branch"})
        item = kinds["leftover-worktree"]
        self.assertEqual((item["root"], item["path"], item["sessions"]), (str(self.repo), str(tree), [uid]))
        self.assertEqual(item["uncommitted"], 0)
        # Josh marks the branch kept from inside the worktree: the mark belongs to the main checkout.
        self.assertEqual(loose_ends.mark(self.conn, str(tree), "JP-900/w", True, None, NOW), str(self.repo))
        self.assertEqual([i["kind"] for i in self.loose()["items"]], ["leftover-worktree"])

    def test_a_worktree_whose_folder_is_gone_is_still_listed(self):
        tree = self.tmp / "work" / "elsewhere"
        git(self.repo, "worktree", "add", "-q", "-b", "gone-tree", str(tree), "main")
        self.seed("sess-0001", root=self.repo, git_root=str(tree), worktree=str(tree))
        shutil.rmtree(str(tree))
        (item,) = [i for i in self.loose()["items"] if i["kind"] == "leftover-worktree"]
        self.assertFalse(item["folder_exists"])

    def test_a_folder_that_is_gone_is_unchecked(self):
        self.seed("sess-0001", root=self.tmp / "deleted" / "folder", branch="x")
        result = self.loose()
        self.assertEqual(result["items"], [])
        self.assertEqual(result["unchecked"][0]["reason"], "folder is gone or not a git repository")

    def test_one_session_view_and_ordering(self):
        self.branch_with_commit("older")
        self.branch_with_commit("newer")
        self.seed("sess-0001", branch="older", quiet="2026-11-01T00:00:00Z")
        self.seed("sess-0002", branch="newer", quiet="2026-11-16T00:00:00Z")
        both = self.loose()
        self.assertEqual([i["branch"] for i in both["items"]], ["older", "newer"])  # oldest first
        self.assertEqual(both["items"][0]["age_days"], 16)
        mine = self.loose(session="sess-0002")
        self.assertEqual([i["branch"] for i in mine["items"]], ["newer"])
        with self.assertRaises(ValueError):
            self.loose(session="sess-9999")

    def test_a_retracted_ref_is_ignored(self):
        self.branch_with_commit("retracted")
        self.seed("sess-0001", branch="retracted")
        ref_id = self.rows("SELECT id FROM session_refs WHERE kind = 'branch'")[0][0]
        cols = [r[1] for r in self.rows("PRAGMA table_info(corrections)")]
        self.assertIn("table_name", cols)
        self.conn.execute(
            "INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, recorded_by) "
            "VALUES ('session_refs', ?, 'wrong', ?, 'josh', 'test')", (ref_id, T))
        self.assertEqual(self.loose()["items"], [])


class Command(LaptopCase):
    def run_cli(self, *argv, live=None):
        out = io.StringIO()
        code = loose_ends.main(list(argv), out=out, path=self.path, live=live or fake_live(), now=NOW)
        return code, out.getvalue()

    def test_text_json_check_and_keep(self):
        self.branch_with_commit("JP-900/cli")
        self.seed("sess-0001", branch="JP-900/cli")
        code, text = self.run_cli("--check")
        self.assertEqual(code, 1)
        self.assertIn("unpushed-branch (1)", text)
        self.assertIn("JP-900/cli", text)
        code, body = self.run_cli("--json", "--session", "sess-0001")
        self.assertEqual(json.loads(body)["counts"], {"unpushed-branch": 1})
        code, text = self.run_cli("keep", "--folder", str(self.repo), "--branch", "JP-900/cli", "--note", "on purpose")
        self.assertEqual(code, 0)
        code, text = self.run_cli("--check")
        self.assertEqual((code, "Nothing is loose." in text), (0, True))
        self.assertEqual(self.rows("SELECT branch, mark, marked_by FROM branch_marks"),
                         [("JP-900/cli", "kept", "josh")])

    def test_keep_refuses_a_branch_that_does_not_exist_and_a_patient_note(self):
        code, _ = self.run_cli("keep", "--folder", str(self.repo), "--branch", "typo")
        self.assertEqual(code, 2)
        self.branch_with_commit("real")
        code, _ = self.run_cli("keep", "--folder", str(self.repo), "--branch", "real", "--note", "DOB 03/04/1961")
        self.assertEqual(code, 2)
        self.assertEqual(self.count("branch_marks"), 0)

    def test_a_missing_ledger_is_an_error_not_an_empty_list(self):
        out = io.StringIO()
        code = loose_ends.main([], out=out, path=self.tmp / "nope.db", live=fake_live())
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
