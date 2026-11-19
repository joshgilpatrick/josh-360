"""JP-174: a remote ticket branch whose pull request was closed without merging is a loose end for /closeout.

Made-up repositories (a bare origin and its clone), sessions and pull request addresses only."""
import io
import json
import unittest

from loose_helpers import NOW, LaptopCase, fake_live, git
from ledger import closeout, loose_ends

CLOSED = [("CLOSED", "https://example.test/o/r/pull/9")]


class ClosedPullRequestBranch(LaptopCase):
    def remote_only(self, name):
        """A ticket branch a graph run pushed, whose local copy `close-unmerged` removed."""
        self.branch_with_commit(name, push=True)
        git(self.repo, "branch", "-D", name)

    # -- Scenario: A closed PR's remote branch is a loose end ----------------------------------------------------
    def test_a_closed_pull_request_s_remote_branch_is_listed_with_fetch(self):
        self.remote_only("JP-903-y")
        self.seed("sess-0001", branch="JP-903-y")
        out = io.StringIO()
        code = loose_ends.main(["--fetch", "--json"], out=out, path=self.path,
                               live=fake_live(branch_prs={"JP-903-y": CLOSED}), now=NOW)
        self.assertEqual(code, 0)
        items = json.loads(out.getvalue())["items"]
        self.assertEqual([(i["kind"], i["branch"], i["url"]) for i in items],
                         [("closed-pr-branch", "JP-903-y", "https://example.test/o/r/pull/9")])
        text = io.StringIO()
        loose_ends.main(["--fetch"], out=text, path=self.path, live=fake_live(branch_prs={"JP-903-y": CLOSED}), now=NOW)
        self.assertIn("closed-pr-branch (1)", text.getvalue())
        self.assertIn("remote branch of a pull request closed without merging", text.getvalue())

    def test_open_merged_or_no_pull_request_is_not_this_kind(self):
        for name, rows in (("JP-904-open", [("OPEN", "u1")]), ("JP-905-merged", [("MERGED", "u2")]),
                           ("JP-906-reopened", [("OPEN", "u3"), ("CLOSED", "u4")]), ("JP-907-none", [])):
            self.remote_only(name)
            self.seed("sess-" + name[3:6].zfill(4), branch=name)
        live = fake_live(branch_prs={"JP-904-open": [("OPEN", "u1")], "JP-905-merged": [("MERGED", "u2")],
                                     "JP-906-reopened": [("OPEN", "u3"), ("CLOSED", "u4")], "JP-907-none": []})
        self.assertEqual([i for i in self.loose(live)["items"] if i["kind"] == "closed-pr-branch"], [])

    def test_a_branch_that_is_not_a_ticket_branch_or_no_session_touched_is_not_listed(self):
        self.remote_only("experiment")
        self.seed("sess-0001", branch="experiment")
        self.remote_only("JP-908-untouched")
        live = fake_live(branch_prs={"experiment": CLOSED, "JP-908-untouched": CLOSED})
        self.assertEqual(self.loose(live)["items"], [])

    def test_unreadable_github_is_unchecked_not_clean(self):
        self.remote_only("JP-903-y")
        self.seed("sess-0001", branch="JP-903-y")
        result = self.loose(fake_live())
        self.assertEqual(result["items"], [])
        self.assertIn("GitHub could not be read (gh)", [u["reason"] for u in result["unchecked"]])

    def test_josh_can_keep_it_and_closeout_asks_him_before_any_deletion(self):
        self.remote_only("JP-903-y")
        self.seed("sess-0001", branch="JP-903-y")
        live = fake_live(branch_prs={"JP-903-y": CLOSED})
        plans = closeout.plan_all(self.conn, live, now=NOW)["plans"]
        plan = [p for p in plans if p["kind"] == "closed-pr-branch"][0]
        self.assertEqual((plan["by"], plan["reversible"], plan["argv"]), ("josh", False, None))
        loose_ends.mark(self.conn, str(self.repo), "JP-903-y", True, "kept for later", NOW)
        self.assertEqual(self.loose(live)["items"], [])
        self.assertIn("JP-903-y", git(self.repo, "branch", "-r"))           # nothing was removed


if __name__ == "__main__":
    unittest.main()
