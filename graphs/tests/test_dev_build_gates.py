"""verify-build and cite-check (JP-115, Task 9). Real scratch repositories and real shell commands; no network."""
from __future__ import annotations

import json
import shutil
import subprocess
import time
import unittest
from pathlib import Path

from dev_helpers import KEY, SPEC, Case, FakeTicket, gate, make_dev_deps, scratch_repo, spec_copy, write_spec
from lib import dev_git, dev_spec, evidence
from lib.gate_run import GateError


def commit(tree: Path, name: str, text: str = "x\n") -> None:
    (tree / name).parent.mkdir(parents=True, exist_ok=True)
    (tree / name).write_text(text)
    dev_git.git(tree, "add", name)
    dev_git.git(tree, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-m", "add " + name)


class BuildCase(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)
        self.tree = dev_git.add_worktree(self.clone, "JP-9002-label", "main")
        self.deps = make_dev_deps(self.root, ticket=FakeTicket(key=KEY), clone=self.clone)
        self.work = self.deps.work_dir

    def spec(self, **changes):
        return write_spec(self.work, spec_copy(**changes) if changes else None)

    def inputs(self, spec_path=None, **over):
        args = {"ticket_key": KEY, "spec_path": str(spec_path or self.work / "spec.yaml"), "worktree": str(self.tree),
                "work_dir": str(self.work), "base_branch": "main"}
        args.update(over)
        return args

    def phases(self, *entries):
        """A spec whose phases are (id, [checks], [files])."""
        phases = [{"id": pid, "title": pid, "task": ["do it"], "checks": checks, "files": files}
                  for pid, checks, files in entries]
        return self.spec(phases=phases)


class VerifyBuild(BuildCase):
    def setUp(self):
        super().setUp()
        self.gate = gate("verify-build")

    def go(self, **over):
        return self.gate.run(self.inputs(**over), self.deps)

    def state(self):
        return dev_spec.load_state(self.work)

    def test_all_checks_pass(self):
        commit(self.tree, "widget.txt", "widget label\n")
        self.spec()
        outcome, out, summary = self.go()
        self.assertEqual(outcome, "passed")
        self.assertEqual(out["evidence_path"], str(self.work / "evidence.md"))
        self.assertEqual(summary, "2/2 checks passed")

    def test_failing_check_writes_feedback_and_fails(self):
        commit(self.tree, "widget.txt", "widget\n")      # p1 passes, p2 (grep label) fails
        self.spec()
        outcome, _, _ = self.go()
        self.assertEqual(outcome, "failed")
        text = (self.work / "feedback" / "p2.md").read_text()
        self.assertIn("grep -q label widget.txt", text)
        self.assertIn("exit 1", text)
        self.assertFalse((self.work / "feedback" / "p1.md").exists())
        self.assertEqual(self.state()["phases"]["p2"]["status"], "failed")
        self.assertEqual(self.state()["phases"]["p1"]["status"], "passed")

    def test_passing_phase_clears_its_old_feedback(self):
        commit(self.tree, "widget.txt", "widget\n")
        self.spec()
        self.go()
        self.assertTrue((self.work / "feedback" / "p2.md").exists())
        commit(self.tree, "widget.txt", "widget label\n")
        self.assertEqual(self.go()[0], "passed")
        self.assertFalse((self.work / "feedback" / "p2.md").exists())

    def test_failing_output_tail_is_in_the_feedback(self):
        commit(self.tree, "a.txt")
        self.phases(("p1", ["for i in $(seq 1 30); do echo line$i; done; exit 3"], ["a.txt"]))
        self.go()
        text = (self.work / "feedback" / "p1.md").read_text()
        self.assertIn("line30", text)
        self.assertNotIn("line5\"", text)   # only the last 20 lines
        self.assertIn("exit 3", text)

    def test_same_command_runs_once(self):
        commit(self.tree, "a.txt")
        counter = self.root / "count.txt"
        cmd = "echo run >> {}".format(counter)
        self.phases(("p1", [cmd], ["a.txt"]), ("p2", [cmd], ["a.txt"]))
        self.assertEqual(self.go()[0], "passed")
        self.assertEqual(counter.read_text().splitlines(), ["run"])

    def test_extra_checks_run(self):
        commit(self.tree, "a.txt")
        self.phases(("p1", ["true"], ["a.txt"]))
        dev_spec.save_state(self.work, {"review_round": 1, "phases": {"p1": {"extra_checks": ["false"]}}})
        outcome, _, summary = self.go()
        self.assertEqual(outcome, "failed")
        self.assertEqual(summary, "1/2 checks passed")
        self.assertIn("false", (self.work / "feedback" / "p1.md").read_text())

    def test_check_cannot_see_jira_credentials(self):
        commit(self.tree, "a.txt")
        for name in ("JOSH360_JIRA_TOKEN", "JOSH360_JIRA_EMAIL", "ACTION_AGENT_JIRA_EMAIL", "ACTION_TRIAGE_JIRA_TOKEN",
                     "GRAPH_INPUT_TICKET_KEY"):
            self.deps.environ[name] = "secret"
        checks = ['test -z "$%s"' % n for n in ("JOSH360_JIRA_TOKEN", "JOSH360_JIRA_EMAIL", "ACTION_AGENT_JIRA_EMAIL",
                                                "ACTION_TRIAGE_JIRA_TOKEN", "GRAPH_INPUT_TICKET_KEY")]
        self.phases(("p1", checks, ["a.txt"]))
        self.assertEqual(self.go()[0], "passed")

    def test_check_past_the_budget_fails_and_the_gate_returns(self):
        commit(self.tree, "a.txt")
        self.deps.environ["JOSH360_GATE_TIMEOUT"] = "62"
        self.phases(("p1", ["sleep 31.7"], ["a.txt"]))
        started = time.monotonic()
        outcome, _, _ = self.go()
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(outcome, "failed")
        self.assertIn("timed out", (self.work / "feedback" / "p1.md").read_text())
        left = subprocess.run(["pgrep", "-f", "sleep 31.7"], stdout=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(left.stdout.strip(), "")

    def test_a_hung_child_does_not_outlive_the_gate(self):
        commit(self.tree, "a.txt")
        self.deps.environ["JOSH360_GATE_TIMEOUT"] = "62"
        self.phases(("p1", ["(sleep 31.8 &) ; sleep 31.9"], ["a.txt"]))
        self.go()
        left = subprocess.run(["pgrep", "-f", "sleep 31.[89]"], stdout=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(left.stdout.strip(), "")

    def test_later_checks_are_not_run_when_the_budget_is_spent(self):
        commit(self.tree, "a.txt")
        self.deps.environ["JOSH360_GATE_TIMEOUT"] = "62"
        self.phases(("p1", ["sleep 31.6", "true"], ["a.txt"]))
        self.assertEqual(self.go()[0], "failed")
        text = (self.work / "feedback" / "p1.md").read_text()
        self.assertIn("timed out", text)
        self.assertIn("true", text)   # the second check did not run: it counts as failed

    def test_dirty_worktree_fails(self):
        commit(self.tree, "widget.txt", "widget label\n")
        self.spec()
        (self.tree / "scrap.txt").write_text("x")
        outcome, _, summary = self.go()
        self.assertEqual(outcome, "failed")
        self.assertIn("scrap.txt", (self.work / "feedback" / "_worktree.md").read_text())
        (self.tree / "scrap.txt").unlink()
        self.assertEqual(self.go()[0], "passed")
        self.assertFalse((self.work / "feedback" / "_worktree.md").exists())

    def test_files_a_check_writes_do_not_make_the_worktree_dirty(self):
        commit(self.tree, "a.txt")
        self.phases(("p1", ["touch made-by-check.txt"], ["a.txt"]))
        self.assertEqual(self.go()[0], "passed")

    def test_evidence_front_block_reads_with_lib_evidence(self):
        commit(self.tree, "widget.txt", "widget label\n")
        self.spec()
        self.go()
        doc = evidence.load(self.work / "evidence.md")
        self.assertEqual(doc["ticket"], KEY)
        self.assertEqual(doc["kind"], "development")
        self.assertEqual(doc["base"], "main")
        self.assertEqual(doc["head"], dev_git.head(self.tree))
        self.assertEqual((str(doc["checks_total"]), str(doc["checks_passed"])), ("2", "2"))

    def test_evidence_lists_placeholder_lines_and_unnamed_files(self):
        commit(self.tree, "widget.txt", "widget label\n# TODO later\n")
        commit(self.tree, "other/extra.txt", "x\n")
        self.spec()
        outcome, _, _ = self.go()
        self.assertEqual(outcome, "passed")   # the two reports never change the outcome
        text = (self.work / "evidence.md").read_text()
        placeholder = text.split("## Placeholder lines")[1].split("## Files no phase names")[0]
        self.assertIn("widget.txt: `# TODO later`", placeholder)
        unnamed = text.split("## Files no phase names")[1]
        self.assertIn("other/extra.txt", unnamed)
        self.assertNotIn("widget.txt", unnamed)

    def test_evidence_holds_no_check_output(self):
        commit(self.tree, "a.txt")
        self.phases(("p1", ["echo SECRET-OUTPUT-$((1+1)); exit 2"], ["a.txt"]))
        self.go()
        self.assertNotIn("SECRET-OUTPUT-2", (self.work / "evidence.md").read_text())
        self.assertIn("SECRET-OUTPUT-2", (self.work / "feedback" / "p1.md").read_text())

    def test_state_counts_attempts(self):
        commit(self.tree, "widget.txt", "widget\n")
        self.spec()
        self.go()
        self.go()
        self.assertEqual(self.state()["phases"]["p1"]["attempts"], 2)
        self.assertEqual(self.state()["phases"]["p2"]["attempts"], 2)

    def test_state_keeps_review_fields(self):
        commit(self.tree, "a.txt")
        self.phases(("p1", ["true"], ["a.txt"]))
        dev_spec.save_state(self.work, {"review_round": 2, "phases": {"p1": {"extra_checks": ["true"], "status": "reopened"}}})
        self.go()
        state = self.state()
        self.assertEqual(state["review_round"], 2)
        self.assertEqual(state["phases"]["p1"]["extra_checks"], ["true"])
        self.assertEqual(state["phases"]["p1"]["status"], "passed")

    def test_wrong_work_dir_is_a_gate_error(self):
        self.spec()
        with self.assertRaises(GateError):
            self.go(work_dir=str(self.root / "elsewhere"))

    def test_unreadable_spec_is_a_gate_error(self):
        with self.assertRaises(GateError):
            self.go(spec_path=str(self.work / "none.yaml"))


class CiteCheck(BuildCase):
    def setUp(self):
        super().setUp()
        self.gate = gate("cite-check")
        self.spec()

    def finding(self, **over):
        row = {"phase": "p2", "criterion": "p2.task.1", "quote": "Add the label line to widget.txt",
               "finding": "The label is missing.", "required_fix": "Add it.", "expected_evidence": "grep finds it"}
        row.update(over)
        return row

    def go(self, *findings):
        return self.gate.run({"ticket_key": KEY, "spec_path": str(self.work / "spec.yaml"), "work_dir": str(self.work),
                              "findings": json.dumps(list(findings))}, self.deps)

    def state(self):
        return dev_spec.load_state(self.work)

    def withdrawn(self):
        path = self.work / "withdrawn.md"
        return path.read_text() if path.exists() else ""

    def test_cited_defect_is_kept_and_reopens_its_phase(self):
        outcome, _, summary = self.go(self.finding())
        self.assertEqual(outcome, "rework")
        self.assertEqual(summary, "1 of 1 findings kept")
        self.assertIn("Add the label line", (self.work / "feedback" / "p2.md").read_text())
        self.assertEqual(self.state()["phases"]["p2"]["status"], "reopened")
        self.assertEqual(self.state()["review_round"], 1)

    def test_defect_quoting_nothing_is_dropped(self):
        outcome, _, _ = self.go(self.finding(quote="a line nobody wrote"))
        self.assertEqual(outcome, "clean")
        self.assertIn("the quote is not in the criterion", self.withdrawn())
        self.assertFalse((self.work / "feedback" / "p2.md").exists())
        self.assertEqual(self.state()["review_round"], 0)

    def test_unknown_criterion_is_dropped(self):
        self.go(self.finding(criterion="p9.task.1"))
        self.assertIn("no such criterion", self.withdrawn())
        self.go(self.finding(criterion="p2.task.7"))
        self.assertEqual(self.withdrawn().count("no such criterion"), 2)

    def test_quote_from_another_criterion_is_dropped(self):
        self.go(self.finding(quote="Put the word widget in it"))   # that is p1.task.2
        self.assertIn("the quote is not in the criterion", self.withdrawn())

    def test_quote_match_ignores_case_and_spacing(self):
        self.assertEqual(self.go(self.finding(quote="ADD  the label\nline to widget.txt"))[0], "rework")

    def test_empty_quote_is_dropped(self):
        self.go(self.finding(quote="  "))
        self.assertIn("the quote is not in the criterion", self.withdrawn())

    def test_unknown_phase_is_dropped(self):
        self.go(self.finding(phase="p7"))
        self.assertIn("no such phase", self.withdrawn())

    def test_missing_required_fix_is_dropped(self):
        for field in ("finding", "required_fix", "expected_evidence"):
            self.go(self.finding(**{field: " "}))
        self.assertEqual(self.withdrawn().count("a required field is empty"), 3)

    def test_expected_check_is_added_once(self):
        self.go(self.finding(expected_check="test -s widget.txt"))
        self.go(self.finding(expected_check="test -s widget.txt"))
        self.assertEqual(self.state()["phases"]["p2"]["extra_checks"], ["test -s widget.txt"])
        self.assertEqual(self.state()["review_round"], 2)

    def test_no_kept_defects_is_clean(self):
        outcome, _, summary = self.go()
        self.assertEqual((outcome, summary), ("clean", "0 of 0 findings kept"))
        self.assertFalse((self.work / "state.json").exists())

    def test_definition_of_done_criterion(self):
        row = self.finding(criterion="DOD-1", quote="No placeholders", phase="p1")
        self.assertEqual(self.go(row)[0], "rework")

    def test_findings_not_a_list_is_a_gate_error(self):
        with self.assertRaises(GateError):
            self.gate.run({"ticket_key": KEY, "spec_path": str(self.work / "spec.yaml"), "work_dir": str(self.work),
                           "findings": "{"}, self.deps)


if __name__ == "__main__":
    unittest.main()
