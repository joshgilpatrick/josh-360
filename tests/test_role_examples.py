"""JP-189: every role step shows an example result that matches the step. No model is called.

The check reads the compiled graphs and the roles' instructions. The failing cases copy both into a temporary graphs
folder and break one example there, so the real files are never touched."""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPHS = ROOT / "graphs"
TOOL = GRAPHS / "tools" / "role_examples.py"
sys.path.insert(0, str(GRAPHS / "tools"))

import role_examples  # noqa: E402


def check(root: Path):
    return subprocess.run([sys.executable, str(TOOL), "check", "--root", str(root)], stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, universal_newlines=True, timeout=60)


class OnMain(unittest.TestCase):
    """@auto Scenario: Every role step has a matching example."""

    def test_the_check_passes_on_the_graphs_and_roles_here(self):
        self.assertEqual(role_examples.problems(GRAPHS), [])
        done = check(GRAPHS)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertIn("has a matching example", done.stdout)

    def test_scripts_check_runs_it(self):
        text = (ROOT / "scripts" / "check.py").read_text(encoding="utf-8")
        self.assertIn('run_quietly(["graphs/tools/role_examples.py", "check"])', text)

    def test_every_role_step_in_every_compiled_graph_is_covered(self):
        steps = role_examples.role_steps(GRAPHS)
        graphs = {graph for pairs in steps.values() for graph, _ in pairs}
        self.assertEqual(graphs, {json.loads(p.read_text())["graph"]["graph"]
                                  for p in (GRAPHS / "compiled").glob("*.json")
                                  if any("role" in s for s in json.loads(p.read_text())["graph"]["steps"])})
        for role, pairs in steps.items():
            text = (GRAPHS / "roles" / role / "instructions.md").read_text(encoding="utf-8")
            for _, step in pairs:
                self.assertIsNotNone(role_examples.example_for(text, step["id"]), step["id"])

    def test_the_revise_example_is_revises_not_drafts(self):
        text = (GRAPHS / "roles" / "ticket-drafter" / "instructions.md").read_text(encoding="utf-8")
        self.assertEqual(role_examples.example_for(text, "revise")["outcome"], "revised")
        self.assertEqual(role_examples.example_for(text, "draft")["outcome"], "drafted")


class Broken(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-role-examples-")) / "graphs"
        self.addCleanup(shutil.rmtree, str(self.tmp.parent), True)
        for folder in ("compiled", "roles"):
            shutil.copytree(str(GRAPHS / folder), str(self.tmp / folder))

    def role(self, name: str) -> Path:
        return self.tmp / "roles" / name / "instructions.md"

    def edit(self, name: str, old: str, new: str) -> None:
        path = self.role(name)
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def drop_examples(self, name: str) -> None:
        path = self.role(name)
        text = path.read_text(encoding="utf-8")
        path.write_text(re.sub(r"```json result step=[a-z_]+\n.*?```\n", "", text, flags=re.S), encoding="utf-8")

    def test_an_example_with_an_undeclared_output_fails_naming_the_step_and_the_key(self):
        """@auto Scenario: An example with an undeclared output fails."""
        self.edit("ticket-drafter", '{"outcome": "revised", "outputs": {"proposal": "<work folder>/revise-1-proposal.json"}}',
                  '{"outcome": "revised", "outputs": {"action": "revise", "proposal": "x.json"}}')
        done = check(self.tmp)
        self.assertEqual(done.returncode, 1, done.stdout)
        lines = [line for line in done.stdout.splitlines() if "'action'" in line]
        self.assertEqual(len(lines), 1, done.stdout)
        self.assertIn("step 'revise'", lines[0])
        self.assertIn("does not declare", lines[0])
        self.assertIn("it declares proposal", lines[0])

    def test_a_step_with_no_example_fails_naming_that_step(self):
        """@auto Scenario: A step with no example fails."""
        self.drop_examples("designer")
        done = check(self.tmp)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("step 'design' (development graph, role designer): no example result", done.stdout)
        self.assertEqual(len(done.stdout.strip().splitlines()), 1, done.stdout)

    def test_a_role_serving_two_steps_needs_an_example_for_each(self):
        self.edit("jira-searcher", "```json result step=find_precedent", "```json result step=find_duplicates")
        self.edit("jira-searcher", "```json result step=find_precedent", "```json result step=find_duplicates")
        found = role_examples.problems(self.tmp)
        self.assertTrue(any("step 'find_precedent'" in p and "no example result" in p for p in found), found)

    def test_an_outcome_the_step_does_not_declare_fails(self):
        self.edit("builder", '{"outcome": "done", "outputs": {}}', '{"outcome": "finished", "outputs": {}}')
        found = role_examples.problems(self.tmp)
        self.assertEqual(len(found), 1, found)
        self.assertIn("step 'build'", found[0])
        self.assertIn("'finished'", found[0])

    def test_a_declared_output_in_no_example_fails(self):
        self.edit("designer", ', "plan_path": "<worktree>/docs/design/jp-9002-chores-plan.md"', "")
        found = role_examples.problems(self.tmp)
        self.assertEqual(found, ["step 'design' (development graph, role designer): the declared output 'plan_path' "
                                 "is in none of its examples"])

    def test_outputs_that_are_not_an_object_fail(self):
        self.edit("pr-writer", '{"outcome": "written", "outputs": {', '{"outcome": "written", "result": {')
        found = role_examples.problems(self.tmp)
        self.assertTrue(any("no \"outputs\" object" in p for p in found), found)

    def test_an_example_that_is_not_json_fails(self):
        self.edit("decomposer", '{"outcome": "shaped", "outputs": {"shape": "single"}}', '{"outcome": shaped}')
        found = role_examples.problems(self.tmp)
        self.assertTrue(any("step 'decompose'" in p and "is not valid JSON" in p for p in found), found)

    def test_an_untagged_result_block_fails(self):
        self.edit("builder", "```json result step=build\n{\"outcome\": \"done\"", "```json\n{\"outcome\": \"done\"")
        found = role_examples.problems(self.tmp)
        self.assertTrue(any("role builder" in p and "names no step" in p for p in found), found)

    def test_an_example_for_a_step_the_role_does_not_serve_fails(self):
        path = self.role("builder")
        path.write_text(path.read_text() + '\n```json result step=design\n{"outcome": "ready", "outputs": {}}\n```\n')
        found = role_examples.problems(self.tmp)
        self.assertTrue(any("role builder" in p and "step 'design', which no graph gives this role" in p
                            for p in found), found)

    def test_a_contract_block_without_an_outcome_is_not_an_example(self):
        path = self.role("builder")
        path.write_text(path.read_text() + '\n```json\n{"action": "revise", "tickets": []}\n```\n')
        self.assertEqual(role_examples.problems(self.tmp), [])


if __name__ == "__main__":
    unittest.main()
