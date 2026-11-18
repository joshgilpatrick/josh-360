"""JP-115, Task 12: whole runs of the development graph, through JP-114's real walker.

The walker, the ledger and `graphs/flows/development.yaml` are real. Each gate script's own `run` is called in-process
with a fake Jira ticket, a fake GitHub and a real scratch git repository (a gate script run for real needs a Jira
token and `gh`); a role step is played by the test, which writes the spec, commits files in the worktree and records
the role's outcome. `ready` and `no-loose-ends` are tested in their own tickets (JP-122, JP-161) and are let through here. Made-up data only, no
network.
"""
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from walker_helpers import ROOT, WalkerCase

sys.path.insert(0, str(ROOT / "graphs" / "tests"))
from dev_helpers import (DESCRIPTION, KEY, FakeGitHub, FakeTicket, gate, make_dev_deps, scratch_repo,  # noqa: E402
                         write_spec)
from lib import dev_git, dev_github  # noqa: E402
from lib.dev_github import Check, PrComment  # noqa: E402
from lib.gate_run import GateError  # noqa: E402
from lib.nondev_copy import returned  # noqa: E402
from walker_lib import gates, runfolder  # noqa: E402

GRAPHS = ROOT / "graphs"
STUBS = ("ready", "no-loose-ends")
WORKING_FILES = ("spec.yaml", "state.json", "evidence.md", "answers.md", "pr-cursor.json", "hardening.md")
MARK = "<!-- action-triage-audit:security -->\n"
GREEN = [Check("suite", "pass", "2026-11-17T11:00:00Z")]
STATUSES = ["Ready", "Design/Planning", "In Progress", "Code Review", "Validation", "Done"]
RESEARCH_DESIGN = """# Design

## Contents

- [Scenarios](#scenarios)
- [Out of scope](#out-of-scope)

## Scenarios

```gherkin
Feature: The badge

  @auto
  Scenario: The badge shows
    Given a page
    Then it shows a badge
```

## Out of scope

Colours.
"""


class DevelopmentRun(WalkerCase):
    def setUp(self):
        super().setUp()
        self.root = GRAPHS
        self.origin, self.clone = scratch_repo(self.tmp)
        # the scratch origin is a local path; the gates see it as GitHub's josh/widgets
        patcher = mock.patch.object(dev_git, "owner_repo", lambda clone: "josh/widgets")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.clock = datetime(2026, 11, 17, 12, 0, 0, tzinfo=timezone.utc)
        self.github = FakeGitHub(self.origin)
        self.ticket = FakeTicket(key=KEY, description=DESCRIPTION, status="Ready", route={"graph": "development"},
                                 issuetype="Story", summary="Label the widget")
        self.merges = "agent"
        self.gate_calls = 0
        for target, replacement in (("run_gate", self.run_gate), ("set_flag", self.set_flag),
                                    ("post_comment", self.post_comment)):
            patcher = mock.patch.object(gates, target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    # --- the in-process stand-ins for the walker's subprocesses ----------------------------------------------
    def deps_for(self, env):
        deps = make_dev_deps(self.tmp, ticket=self.ticket, github=self.github, clone=self.clone, merges=self.merges)
        deps.run_id = env["JOSH360_RUN_ID"]
        deps.runs_dir = Path(env["JOSH360_RUNS"])
        deps.work_dir = deps.runs_dir / deps.run_id / "work"
        deps.now = lambda: self.clock
        return deps

    def assert_no_working_file_in_a_worktree(self):
        for tree in (self.clone / ".claude" / "worktrees").glob("*"):
            for name in WORKING_FILES:
                self.assertFalse((tree / name).exists(), "{} is in the worktree {}".format(name, tree.name))

    def run_gate(self, root, name, env, cwd, outcomes):
        if name in STUBS:
            return gates.GateResult("pass", {}, None, None)
        self.assert_no_working_file_in_a_worktree()
        self.gate_calls += 1
        inputs = {k[len("GRAPH_INPUT_"):].lower(): v for k, v in env.items() if k.startswith("GRAPH_INPUT_")}
        try:
            outcome, outputs, summary = gate(name).run(inputs, self.deps_for(env))
        except GateError as exc:
            return gates.GateResult(None, {}, None, "gate '{}' failed: {}".format(name, exc))
        self.assertIn(outcome, outcomes or [outcome], "gate {} printed an undeclared outcome".format(name))
        return gates.GateResult(outcome, outputs or {}, summary, None)

    def set_flag(self, root, ticket, on, env):
        return True, ""

    def post_comment(self, root, ticket, body_file, env):
        self.ticket.posted.append((ticket, Path(body_file).read_text()))
        return True, ""

    # --- helpers ---------------------------------------------------------------------------------------------
    def begin(self, ticket_type="Story", phi="false"):
        out = self.walker("start", "--graph", "development", "--ticket", KEY, "--input", "system=widgets",
                          "--input", "ticket_type=" + ticket_type, "--input", "phi=" + phi,
                          *(["--phi"] if phi == "true" else []))
        self.run_id = out["run"]
        return out["run"]

    def work(self, run):
        return runfolder.work_dir(run)

    def tree(self):
        return self.clone / ".claude" / "worktrees" / "JP-9002-label-the-widget"

    def nxt(self, run, step=None, action=None):
        out = self.walker("next", "--run", run)
        if step is not None:
            self.assertEqual(out.get("step"), step, out)
        if action is not None:
            self.assertEqual(out.get("action"), action, out)
        return out

    def role(self, run, step, outcome, outputs=None):
        out = self.nxt(run, step, "run")
        rf = Path(out["result_file"])
        rf.write_text(json.dumps({"outcome": outcome, "outputs": outputs or {}}))
        self.walker("record", "--run", run, "--step", step, "--result-file", rf)

    def commit(self, name, text, message="work"):
        tree = self.tree()
        (tree / name).write_text(text)
        dev_git.git(tree, "add", name)
        dev_git.git(tree, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-m", message)

    def design_ok(self, run):
        spec = write_spec(self.work(run))
        self.role(run, "design", "ready", {"spec_path": str(spec), "plan_path": "none"})

    def harden_pass(self, run):
        self.role(run, "harden", "pass", {"findings": []})

    def build_ok(self, run, text="widget label\n"):
        self.commit("widget.txt", text)
        self.role(run, "build", "done")

    def to_review(self, run, plan_findings=None):
        """Design, harden, build, verify, review, write the pull request, open it, queue the audit: stops at the wait."""
        self.design_ok(run)
        self.harden_pass(run)
        self.build_ok(run)
        self.role(run, "review_plan", "complete", {"findings": plan_findings or []})
        self.role(run, "write_pr", "written", {"pr_title": "Label the widget", "pr_body": "Adds the label."})
        return self.nxt(run, "await_review", "waiting")

    def audit_changes(self, n):
        self.clock += timedelta(hours=1)
        self.github.labels = [dev_github.CHANGES]
        body = MARK + "\n".join("## Finding {}: something".format(i) for i in range(1, n + 1))
        self.github.comment_rows.append(PrComment("eventus-action-agent[bot]", body, self.clock.strftime("%Y-%m-%dT%H:%M:%SZ")))
        self.clock += timedelta(minutes=5)

    def audit_ready(self):
        self.github.labels = [dev_github.READY]
        self.github.check_rows = list(GREEN)

    def fix(self, run, resolution="Fixed in fix.txt; test -f widget.txt passed."):
        self.commit("fix.txt", "fix\n", "fix")
        self.role(run, "fix_review", "fixed", {"resolution": resolution})
        return self.nxt(run, "await_review", "waiting")          # after_fix ran: it relabelled and commented

    def answer(self, run, step, text, attempt=1):
        self.answer_in_app(run, step, text, attempt)

    def statuses(self):
        out = []
        for _, status in self.ticket.moves:
            if not out or out[-1] != status:
                out.append(status)
        return out

    def parked_questions(self):
        folder = self.tmp / "questions"
        return sorted(folder.glob("*.json")) if folder.is_dir() else []

    def rows(self, run):
        return [r[0] for r in self.step_rows(run)]

    def posted(self):
        return [text for _, text in self.ticket.posted]

    # --- the scenarios ---------------------------------------------------------------------------------------
    def test_story_in_josh_360_is_merged_by_the_graph(self):
        run = self.begin()
        self.design_ok(run)
        self.role(run, "harden", "defects", {"findings": [
            {"quote": "Put the word widget in it", "where": "p1", "problem": "which word?", "fix": "name it"}]})
        self.design_ok(run)                       # check_harden sent it back to design once
        self.harden_pass(run)
        self.build_ok(run)
        self.role(run, "review_plan", "complete", {"findings": []})
        self.role(run, "write_pr", "written", {"pr_title": "Label the widget", "pr_body": "Adds the label."})
        waiting = self.nxt(run, "await_review", "waiting")
        self.assertIn("pick", waiting["summary"])                       # the trigger label is still on
        self.assertEqual(self.github.labels, [dev_github.TRIGGER])
        self.github.labels = [dev_github.IN_PROGRESS]
        self.nxt(run, "await_review", "waiting")
        self.audit_changes(2)
        self.fix(run)                                                   # after_fix set ready-for-human; CI not done
        self.audit_ready()
        done = self.nxt(run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "finished", "success"))
        self.assertEqual(self.statuses(), STATUSES)
        self.assertEqual(len([c for c in self.github.calls if c[0] == "merge_squash"]), 1)
        self.assertEqual(self.github.state, "MERGED")
        self.assertEqual(self.parked_questions(), [])
        saved = {p.name.split("-", 2)[2].split(".")[0] for p in (runfolder.folder(run) / "saved").iterdir()}
        self.assertTrue({"spec_path", "evidence_path"} <= saved, saved)
        from ledger import db
        conn = db.connect(db.ledger_path())
        try:
            kinds = dict(conn.execute("SELECT kind, sha256 FROM run_files WHERE run_id = ?", (run,)).fetchall())
        finally:
            conn.close()
        self.assertIn("spec", kinds)
        self.assertIn("evidence", kinds)
        self.assertTrue(all(len(h) == 64 for h in kinds.values()))
        self.assertFalse(self.tree().exists())
        self.assertEqual(dev_git.git(self.clone, "status", "--porcelain"), "")
        self.assertTrue(self.posted()[-1].startswith("Done | merged https://github.com/josh/widgets/pull/7 as"))

    def test_bug_elsewhere_waits_for_joshs_merge(self):
        self.merges = "josh"
        self.ticket.tickets[KEY] = self.ticket.tickets[KEY]._replace(issuetype="Bug")
        run = self.begin("Bug")
        self.design_ok(run)
        self.harden_pass(run)
        self.role(run, "build", "needs_judgment", {"card": "Which colour should the label be?"})
        self.role(run, "triage_question", "answered", {"answer": "Blue, per the ticket's decisions."})
        self.assertIn("Blue, per the ticket's decisions.", (self.work(run) / "answers.md").read_text())
        self.build_ok(run)
        self.role(run, "review_plan", "defects", {"findings": [
            {"phase": "p2", "criterion": "p2.task.1", "quote": "Add the label line to widget.txt",
             "finding": "The label line is not there.", "required_fix": "Add it.", "expected_evidence": "grep finds it"}]})
        self.commit("widget.txt", "widget label\nlabel again\n", "rework")
        self.role(run, "build", "done")
        self.role(run, "review_plan", "complete", {"findings": []})
        self.role(run, "write_pr", "written", {"pr_title": "Label the widget", "pr_body": "Adds the label."})
        self.nxt(run, "await_review", "waiting")
        self.audit_ready()
        self.assertEqual(self.nxt(run, "await_merge", "waiting")["step"], "await_merge")
        self.assertEqual([c for c in self.github.calls if c[0] == "merge_squash"], [])
        self.github.state = "MERGED"
        done = self.nxt(run)
        self.assertEqual((done["action"], done["score"]), ("done", "success"))
        self.assertEqual([c for c in self.github.calls if c[0] == "merge_squash"], [])
        self.assertEqual(self.rows(run).count("build"), 3)   # the question, the first try, the rework

    def test_research_ticket_runs_the_design_stretch_only(self):
        self.ticket.tickets[KEY] = self.ticket.tickets[KEY]._replace(issuetype="Research")
        run = self.begin("Research")
        self.role(run, "design", "needs_input", {"card": "Which badge style do you prefer?"})
        parked = self.nxt(run, "ask_design", "parked")
        self.assertEqual(parked["step"], "ask_design")
        self.answer(run, "ask_design", "answered")
        tree = self.tree()
        (tree / "design.md").write_text(RESEARCH_DESIGN)
        (tree / "plan.md").write_text("Step one: add the badge.\n")
        self.role(run, "design", "ready", {"spec_path": str(tree / "design.md"), "plan_path": str(tree / "plan.md")})
        self.harden_pass(run)
        self.assertEqual(self.nxt(run, "approve_design", "parked")["step"], "approve_design")
        self.answer(run, "approve_design", "approve")
        self.nxt(run, "write_pr", "run")
        rows = self.rows(run)
        for step in ("build", "verify", "review_plan", "cite_check"):
            self.assertNotIn(step, rows)
        self.assertIn("ask_design", rows)
        self.assertIn("approve_design", rows)

    def test_designers_question_on_a_story_goes_back_to_triage(self):
        run = self.begin()
        self.role(run, "design", "needs_input", {"card": "Which screen should the label appear on?"})
        done = self.nxt(run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "return_question.returned", "neutral"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Not Started")
        self.assertEqual(self.ticket.flags, [(KEY, True)])
        self.assertEqual(self.posted()[-1],
                         "Returned to triage | the designer needs: Which screen should the label appear on? "
                         "· run {}, spec saved | next gate: triage answers it, then this run resumes".format(run))
        self.assertEqual(self.parked_questions(), [])
        self.assertFalse(self.tree().exists())     # an untouched worktree is removed

    def test_builder_failing_three_times_reaches_josh(self):
        run = self.begin()
        self.design_ok(run)
        self.harden_pass(run)
        for _ in range(3):                         # nothing is ever committed, so verify fails each time
            self.role(run, "build", "done")
        parked = self.nxt(run, "build_stuck", "parked")
        self.assertEqual(parked["step"], "build_stuck")
        self.assertEqual(self.rows(run).count("verify"), 3)
        self.answer(run, "build_stuck", "stop")
        done = self.nxt(run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "build_stuck.stop", "needs-josh"))
        self.assertTrue((self.work(run) / "feedback" / "p1.md").exists())

    def test_five_findings_requeue_then_closed_unmerged(self):
        self.merges = "josh"
        run = self.begin()
        self.to_review(run)
        self.audit_changes(5)
        self.fix(run)
        self.assertEqual(self.github.labels, [dev_github.TRIGGER])      # five findings: queued for another round
        self.audit_ready()
        self.nxt(run, "await_merge", "waiting")
        self.github.state = "CLOSED"
        done = self.nxt(run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "close_unmerged.cancelled", "neutral"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Cancelled")
        self.assertTrue(self.posted()[-1].startswith("Cancelled | https://github.com/josh/widgets/pull/7 was closed"))
        self.assertEqual([c for c in self.github.calls if c[0] == "delete_branch"], [])

    def test_ticket_routed_elsewhere_returns_early(self):
        self.ticket.tickets[KEY] = self.ticket.tickets[KEY]._replace(route={"graph": "non-development"})
        run = self.begin()
        done = self.nxt(run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "return_early.returned", "neutral"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Not Started")
        self.assertEqual(self.posted(), [returned("the ticket is not routed to the development graph")])
        self.assertFalse((self.clone / ".claude" / "worktrees").exists())

    def test_blocked_audit_asks_josh_and_requeue_goes_round_again(self):
        run = self.begin()
        self.to_review(run)
        self.github.labels = [dev_github.BLOCKED]
        self.assertEqual(self.nxt(run, "audit_stuck", "parked")["step"], "audit_stuck")
        self.answer(run, "audit_stuck", "requeue")
        self.nxt(run, "await_review", "waiting")
        self.assertEqual(self.rows(run).count("queue_audit"), 2)
        self.assertIn(dev_github.BLOCKED, self.github.labels)           # never removed: the audit clears it
        self.github.labels = [dev_github.READY]
        self.github.check_rows = list(GREEN)
        done = self.nxt(run)
        self.assertEqual((done["action"], done["score"]), ("done", "success"))

    def test_phi_run_comments_hold_paths_only(self):
        run = self.begin(phi="true")
        self.to_review(run)
        self.audit_changes(2)
        self.fix(run, resolution="Fixed Jane Roe's label")
        everything = "\n".join(self.posted() + [c.body for c in self.github.comment_rows])
        self.assertNotIn("Jane", everything)
        self.assertIn("resolution withheld: patient data", everything)

    def test_phi_designers_question_is_withheld(self):
        run = self.begin(phi="true")
        self.role(run, "design", "needs_input", {"card": "Is Jane Roe's visit count right?"})
        self.assertEqual(self.nxt(run)["end"], "return_question.returned")
        self.assertNotIn("Jane", "\n".join(self.posted()))
        self.assertIn("withheld: patient data", self.posted()[-1])

    def test_no_working_file_was_ever_in_the_worktree(self):
        run = self.begin()
        self.to_review(run)
        self.audit_changes(1)
        self.fix(run)
        self.audit_ready()
        self.assertEqual(self.nxt(run)["action"], "done")
        self.assertGreater(self.gate_calls, 12)   # the check ran before every one of them
        self.assertTrue((self.work(run) / "spec.yaml").exists())


if __name__ == "__main__":
    unittest.main()
