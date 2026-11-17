"""JP-109: the closeout script proposes, acts only on reversible items, and never destroys work."""
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loose_helpers import NOW, LaptopCase, fake_live, git  # noqa: E402
from ledger import closeout, loose_ends  # noqa: E402


class Closeout(LaptopCase):
    def plans(self, live=None, session=None):
        return {p["id"].split(":", 1)[0] + ":" + (p["branch"] or p["id"].rsplit(":", 1)[-1]): p
                for p in closeout.plan_all(self.conn, live or fake_live(), session, now=NOW)["plans"]}

    def apply(self, live=None, only=None):
        live = live or fake_live()
        report = closeout.plan_all(self.conn, live, now=NOW)
        return closeout.apply(self.conn, report["plans"], live, only)

    def branches(self, where=None):
        return git(where or self.repo, "branch", "--format=%(refname:short)").split()

    def remote_branches(self):
        return git(self.origin, "branch", "--format=%(refname:short)").split()

    def worktree(self, name, branch):
        tree = self.tmp / "work" / name
        git(self.repo, "worktree", "add", "-q", "-b", branch, str(tree), "main")
        return tree

    # -- the ticket's scenario ---------------------------------------------------------------------------------

    def test_closeout_never_destroys_work(self):
        # Commits that exist nowhere else: on an unpushed branch, in a worktree, and on no branch at all.
        self.branch_with_commit("only-here")
        tree = self.worktree("wt", "wt-branch")
        self.commit(tree, "wt-work")
        git(self.repo, "checkout", "-q", "--detach")
        floating = self.commit(self.repo, "floating")
        git(self.repo, "checkout", "-q", "main")
        self.seed("sess-0001", branch="only-here")
        self.seed("sess-0002", root=self.repo, git_root=str(tree), branch="wt-branch", worktree=str(tree))
        self.seed("sess-0003", commits=[floating])
        before = closeout.plan_all(self.conn, fake_live(), now=NOW)["plans"]
        tree_plan = [p for p in before if p["kind"] == "leftover-worktree"][0]
        self.assertEqual(tree_plan["by"], "josh")  # its commit exists nowhere else
        results = self.apply()
        self.assertTrue(all(r["done"] for r in results), results)
        self.assertNotIn("worktree remove", " ".join(r["action"] for r in results))
        # Nothing was deleted: the branch, the worktree and its commit, and the floating commit all still exist.
        self.assertIn("only-here", self.branches())
        self.assertIn("only-here", self.remote_branches())  # pushed, not removed
        self.assertTrue((tree / "wt-work.txt").exists())
        self.assertEqual(git(tree, "log", "-1", "--format=%s"), "wt-work")
        self.assertEqual(git(self.repo, "cat-file", "-t", floating), "commit")
        self.assertIn("rescue/" + floating[:9], self.branches())
        # Once the push has put the worktree's commit on a remote branch, a fresh list may remove the worktree.
        after = [p for p in closeout.plan_all(self.conn, fake_live(), now=NOW)["plans"]
                 if p["kind"] == "leftover-worktree"][0]
        self.assertEqual(after["by"], "script")

    def test_every_deletion_is_left_to_josh_or_guarded(self):
        # A worktree with an uncommitted file and an ignored file is never removed by the script.
        tree = self.worktree("dirty", "dirty-branch")
        (tree / "note.txt").write_text("unsaved")
        self.seed("sess-0001", root=self.repo, git_root=str(tree), branch="dirty-branch", worktree=str(tree))
        plans = closeout.plan_all(self.conn, fake_live(), now=NOW)["plans"]
        by_kind = {p["kind"]: p for p in plans}
        self.assertEqual(by_kind["leftover-worktree"]["by"], "josh")
        self.assertIsNone(by_kind["leftover-worktree"]["argv"])
        self.assertEqual(self.apply(only=[by_kind["leftover-worktree"]["id"]]), [])
        self.assertTrue((tree / "note.txt").exists())

    # -- the reversible actions --------------------------------------------------------------------------------

    def test_a_merged_branch_is_deleted_locally_and_its_tip_is_reported(self):
        sha = self.branch_with_commit("merged-left")
        self.merge_to_main("merged-left")
        self.seed("sess-0001", branch="merged-left")
        (result,) = self.apply()
        self.assertTrue(result["done"])
        self.assertNotIn("merged-left", self.branches())
        self.assertIn(sha, result["output"])  # recoverable: git branch merged-left <sha>
        self.assertEqual(git(self.repo, "cat-file", "-t", sha), "commit")

    def test_a_pushed_unmerged_branch_is_left_to_josh(self):
        self.branch_with_commit("forgotten", push=True)
        self.seed("sess-0001", branch="forgotten")
        (plan,) = closeout.plan_all(self.conn, fake_live(), now=NOW)["plans"]
        self.assertEqual((plan["by"], plan["reversible"]), ("josh", False))
        self.assertEqual(self.apply(), [])
        self.assertIn("forgotten", self.branches())
        self.assertIn("forgotten", self.remote_branches())

    def test_a_clean_pushed_worktree_is_removed_and_its_branch_survives(self):
        tree = self.worktree("clean", "clean-branch")
        self.commit(tree, "done-work")
        git(tree, "push", "-q", "-u", "origin", "clean-branch")
        self.seed("sess-0001", root=self.repo, git_root=str(tree), branch="clean-branch", worktree=str(tree))
        (result,) = self.apply()
        self.assertTrue(result["done"], result)
        self.assertFalse(tree.exists())
        self.assertIn("clean-branch", self.branches())
        self.assertIn("clean-branch", self.remote_branches())

    def test_a_worktree_whose_folder_is_gone_is_removed_from_git_only(self):
        tree = self.worktree("vanished", "vanished-branch")
        self.seed("sess-0001", root=self.repo, git_root=str(tree), branch="vanished-branch", worktree=str(tree))
        import shutil
        shutil.rmtree(str(tree))
        plans = [p for p in closeout.plan_all(self.conn, fake_live(), now=NOW)["plans"]
                 if p["kind"] == "leftover-worktree"]
        self.assertEqual(plans[0]["by"], "script")
        results = self.apply(only=[plans[0]["id"]])
        self.assertTrue(results[0]["done"], results)
        self.assertIn("vanished-branch", self.branches())

    def test_a_phi_folder_is_left_to_josh(self):
        phi_repo = self.tmp / "work" / ".phi" / "case"
        phi_repo.parent.mkdir(parents=True)
        git(self.tmp, "clone", "-q", str(self.origin), str(phi_repo))
        git(phi_repo, "checkout", "-q", "-b", "phi-branch")
        self.commit(phi_repo, "phi-work")
        self.seed("sess-0001", root=phi_repo, branch="phi-branch")
        (plan,) = closeout.plan_all(self.conn, fake_live(), now=NOW)["plans"]
        self.assertEqual(plan["by"], "josh")
        self.assertIn(".phi", plan["why"])
        self.assertEqual(self.apply(), [])
        self.assertNotIn("phi-branch", git(self.origin, "branch", "--format=%(refname:short)").split())

    def test_apply_checks_again_just_before_acting(self):
        self.branch_with_commit("moving")
        self.seed("sess-0001", branch="moving")
        live = fake_live()
        report = closeout.plan_all(self.conn, live, now=NOW)
        git(self.repo, "push", "-q", "-u", "origin", "moving")  # Josh pushed it after the list was made
        results = closeout.apply(self.conn, report["plans"], live)
        self.assertFalse(results[0]["done"])
        self.assertIn("no longer", results[0]["output"])

    def test_a_ticket_goes_to_the_agent_and_a_pull_request_to_josh(self):
        self.seed("sess-0001", ticket="JP-905", pr="https://example.test/o/r/pull/9")
        live = fake_live(tickets={"JP-905": ("Code Review", False)}, prs={"https://example.test/o/r/pull/9": "OPEN"})
        by = {p["kind"]: p["by"] for p in closeout.plan_all(self.conn, live, now=NOW)["plans"]}
        self.assertEqual(by, {"ticket-not-done": "agent", "open-pr": "josh"})
        self.assertEqual(self.apply(live), [])

    def test_no_force_flag_in_the_script(self):
        text = (Path(closeout.__file__)).read_text()
        for flag in ('"--force"', '"-f"', '"-D"', '"--delete"', "--force-with-lease"):
            self.assertNotIn(flag, text)


class Command(LaptopCase):
    def test_dry_run_changes_nothing_and_apply_reports(self):
        self.branch_with_commit("cli-branch")
        self.seed("sess-0001", branch="cli-branch")
        out = io.StringIO()
        code = closeout.main([], out=out, path=self.path, live=fake_live(), now=NOW)
        self.assertEqual(code, 0)
        self.assertIn("I can do these (reversible) (1)", out.getvalue())
        self.assertNotIn("cli-branch", git(self.origin, "branch", "--format=%(refname:short)").split())
        out = io.StringIO()
        code = closeout.main(["--apply", "--json"], out=out, path=self.path, live=fake_live(), now=NOW)
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out.getvalue())["results"][0]["done"])
        self.assertIn("cli-branch", git(self.origin, "branch", "--format=%(refname:short)").split())


if __name__ == "__main__":
    unittest.main()
