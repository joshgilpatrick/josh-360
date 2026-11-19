"""JP-174: a run that ended or stopped with the ticket's worktree still on disk says so in `where` and the report.

Made-up tickets and folders only. The fixture graph `valid` stands in for the development graph; the `prepare` step's
outputs are written into run.json as `prepare-worktree` would write them."""
import io
import json
import os
import time
import unittest

from runner_helpers import RunnerCase, db, runfolder
from runner_lib import status, where
import runner

AM = ("--runner", "agent-manager")


class WorktreeKept(RunnerCase):
    def setUp(self):
        super().setUp()
        self.plan({"lint-spec": ["pass"]})
        self.tree = self.tmp / "app" / ".claude" / "worktrees" / "JP-901-login"
        self.tree.mkdir(parents=True)

    def ask(self, key, *extra):
        out = io.StringIO()
        code = runner.main(["where", key, "--graphs-root", str(self.root)] + list(extra), out)
        return code, out.getvalue()

    def snap(self):
        conn = db.connect(db.ledger_path())
        try:
            return status.snapshot(conn, time.time(), self.root)
        finally:
            conn.close()

    def with_tree(self, run, tree=None):
        doc = runfolder.load(run)
        runfolder.save_outputs(doc, "prepare", {"worktree": str(tree or self.tree), "branch": "JP-901-login"})
        runfolder.save(run, doc)

    def stopped_run(self, key="JP-901"):
        run = self.start("valid", key, *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.plan({"lint-spec": ["crash"]})
        self.assertEqual(self.walker("next", "--run", run)["action"], "stopped")
        return run

    # -- Scenario: A stopped run says it kept its worktree -------------------------------------------------------
    def test_a_stopped_run_says_it_kept_its_worktree(self):
        self.with_tree(self.stopped_run())
        code, text = self.ask("JP-901")
        self.assertEqual(code, 0, text)
        self.assertIn("Worktree kept: `{}` on branch `JP-901-login`".format(self.tree), text)
        got = json.loads(self.ask("JP-901", "--json")[1])["runs"][0]
        self.assertEqual(got["worktree_kept"], {"path": str(self.tree), "branch": "JP-901-login"})

    def test_the_published_report_and_the_cloud_answer_carry_it(self):
        self.with_tree(self.stopped_run())
        snap = self.snap()
        row = [r for r in snap["tickets"] if r["ticket"] == "JP-901"][0]
        self.assertEqual(row["worktree_kept"]["branch"], "JP-901-login")
        path = self.tmp / "snap.json"
        path.write_text(json.dumps(snap))
        self.assertIn("Worktree kept:", self.ask("JP-901", "--from-json", str(path))[1])

    def test_an_ended_run_whose_worktree_is_gone_says_nothing(self):
        run = self.end_sample_run("JP-901")
        self.with_tree(run, self.tmp / "removed-by-clean-up")
        got = json.loads(self.ask("JP-901", "--json")[1])["runs"][0]
        self.assertEqual((got["state"], got["worktree_kept"]), ("ended", None))
        self.assertNotIn("Worktree kept", self.ask("JP-901")[1])

    def test_an_ended_run_that_left_its_worktree_says_so(self):
        run = self.end_sample_run("JP-901")
        self.with_tree(run)
        got = json.loads(self.ask("JP-901", "--json")[1])["runs"][0]
        self.assertEqual(got["worktree_kept"]["path"], str(self.tree))

    def test_a_run_still_working_does_not_say_kept(self):
        run = self.start("valid", "JP-901", *AM)
        self.with_tree(run)
        got = json.loads(self.ask("JP-901", "--json")[1])["runs"][0]
        self.assertIsNone(got["worktree_kept"])

    def test_the_home_folder_is_shown_as_a_tilde(self):
        home = os.path.expanduser("~")
        self.assertEqual(where._tilde(os.path.join(home, "dev", "x")), os.path.join("~", "dev", "x"))
        self.assertEqual(where._tilde("/elsewhere/x"), "/elsewhere/x")


if __name__ == "__main__":
    unittest.main()
