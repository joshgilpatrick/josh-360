"""Tests for graphs/tools/check_graph.py (JP-101).

The first four tests are the ticket's Gherkin scenarios, by name. The rest cover every other rule in
graphs/CONVENTION.md. Each failing case starts from the valid sample graph and breaks one thing.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import copy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GRAPHS = HERE.parent
sys.path.insert(0, str(GRAPHS / "tools"))

import check_graph  # noqa: E402

PARTS = HERE / "fixtures" / "parts"
BAD = HERE / "fixtures" / "bad"
BAD_TIERS = HERE / "fixtures" / "bad-tiers"
VALID = PARTS / "flows" / "valid.yaml"
CHECKER = GRAPHS / "tools" / "check_graph.py"


def run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(CHECKER), *args], capture_output=True, text=True)


def valid_data() -> dict:
    return check_graph.load_yaml(VALID)


def step(data: dict, step_id: str) -> dict:
    return next(s for s in data["steps"] if s["id"] == step_id)


class Scenarios(unittest.TestCase):
    """The four scenarios on JP-101, run through the command line as an agent would."""

    def test_a_valid_sample_graph_passes(self):
        result = run_cli("--root", str(PARTS), str(VALID))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("ok", result.stdout)

    def test_a_shared_write_needs_an_approval_step(self):
        result = run_cli("--root", str(PARTS), str(BAD / "shared-write-no-approval.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("step 'post_note' writes something shared and no approval step comes before it",
                      result.stdout)

    def test_a_loop_must_end_at_a_human(self):
        result = run_cli("--root", str(PARTS), str(BAD / "loop-without-limit.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("loop lint_spec -> design (outcome 'incomplete') has no max_loops", result.stdout)
        self.assertIn("loop lint_spec -> design (outcome 'incomplete') has no at_limit", result.stdout)

    def test_the_file_stays_neutral(self):
        result = run_cli("--root", str(PARTS), str(BAD / "orchestrator-key.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("steps.build.mode: key 'mode' belongs to one orchestrator", result.stdout)


class RunCapScenarios(unittest.TestCase):
    """The scenarios on JP-139, by name, run through the command line as an agent would."""

    def test_the_tiers_carry_their_caps(self):
        data = check_graph.load_yaml(GRAPHS / "tiers.yaml")
        self.assertEqual(data["max_runs"], {"cheap": 5, "mid": 3, "gate": 2})
        result = run_cli()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_a_loop_that_would_pass_the_cap_is_refused(self):
        result = run_cli("--root", str(PARTS), str(BAD / "gate-loop-over-cap.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("loop check_review -> build (outcome 'rework') would run step 'review' 3 times "
                      "(max_loops 2 + 1) against a gate cap of 2", result.stdout)

    def test_a_loop_inside_the_cap_passes(self):
        # lint_spec -> design has max_loops 2 and reruns the mid-tier design step: 3 runs, cap 3.
        data = valid_data()
        self.assertEqual(step(data, "lint_spec")["on"]["incomplete"]["max_loops"], 2)
        result = run_cli("--root", str(PARTS), str(VALID))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("lint_spec -> design", result.stdout)

    def test_a_tier_with_no_cap_is_refused(self):
        root = Path(tempfile.mkdtemp())
        try:
            shutil.copytree(PARTS, root / "parts")
            shutil.copyfile(BAD_TIERS / "no-max-runs-for-mid.yaml", root / "parts" / "tiers.yaml")
            result = run_cli("--root", str(root / "parts"))
        finally:
            shutil.rmtree(root)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("tiers.yaml: tier 'mid' has no max_runs", result.stdout)


class ScoringScenarios(unittest.TestCase):
    """The scenarios on JP-140, by name, run through the command line as an agent would."""

    def test_the_new_ledger_fields_are_allowed(self):
        data = valid_data()
        self.assertIn("graph_version", data["header"]["ledger"])
        self.assertIn("model", data["header"]["ledger"])
        result = run_cli("--root", str(PARTS), str(VALID))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("header.ledger", result.stdout)

    def test_every_end_is_classified(self):
        data = valid_data()
        ends = [f"{s['id']}.{o}" for s in data["steps"] for o, then in (s.get("on") or {}).items() if then == "end"]
        self.assertEqual(ends, ["approve_spec.drop", "decide_review.stop"])  # two outcomes whose on is end
        self.assertEqual(data["header"]["end_states"]["approve_spec.drop"], "neutral")
        self.assertEqual(data["header"]["end_states"]["decide_review.stop"], "needs-josh")
        result = run_cli("--root", str(PARTS), str(VALID))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("end_states", result.stdout)

    def test_an_unclassified_end_is_refused(self):
        result = run_cli("--root", str(PARTS), str(BAD / "unclassified-end.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("header.end_states: end 'decide_review.stop' is unclassified", result.stdout)

    def test_an_unknown_classification_is_refused(self):
        result = run_cli("--root", str(PARTS), str(BAD / "unknown-end-class.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("header.end_states.finished: 'great' must be one of success, neutral, needs-josh",
                      result.stdout)

    def test_the_suite_still_passes(self):
        result = run_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class CommandLine(unittest.TestCase):
    def test_unknown_role_is_named(self):
        result = run_cli("--root", str(PARTS), str(BAD / "unknown-role.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("step 'publish' names unknown role 'releaser'", result.stdout)

    def test_unknown_gate_is_named(self):
        result = run_cli("--root", str(PARTS), str(BAD / "unknown-gate.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("step 'lint_spec' names unknown gate 'lint-the-spec'", result.stdout)

    def test_missing_header_field_is_named(self):
        result = run_cli("--root", str(PARTS), str(BAD / "missing-header-field.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("header: missing field 'exit_gate'", result.stdout)

    def test_every_bad_sample_fails(self):
        for path in sorted(BAD.glob("*.yaml")):
            with self.subTest(path.name):
                self.assertEqual(run_cli("--root", str(PARTS), str(path)).returncode, 1)

    def test_default_run_checks_every_flow_under_root(self):
        result = run_cli("--root", str(PARTS))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("1 graph(s)", result.stdout)

    def test_the_repository_graphs_folder_passes(self):
        result = run_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_root_cannot_run(self):
        result = run_cli("--root", str(HERE / "no-such-folder"))
        self.assertEqual(result.returncode, 2)

    def test_missing_file_cannot_run(self):
        result = run_cli("--root", str(PARTS), str(HERE / "no-such-graph.yaml"))
        self.assertEqual(result.returncode, 2)


class Yaml(unittest.TestCase):
    def _load(self, text: str):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "g.yaml"
            path.write_text(text)
            return check_graph.load_yaml(path)

    def test_on_yes_no_stay_words(self):
        data = self._load("on: {yes: 1, no: 2, off: 3}\n")
        self.assertEqual(data, {"on": {"yes": 1, "no": 2, "off": 3}})

    def test_true_false_stay_booleans(self):
        self.assertEqual(self._load("a: true\nb: false\n"), {"a": True, "b": False})

    def test_list_as_a_key_is_refused_not_a_crash(self):
        with self.assertRaises(check_graph.GraphYamlError):
            self._load("? [a, b]\n: 1\n")

    def test_duplicate_key_is_refused(self):
        with self.assertRaises(check_graph.GraphYamlError) as caught:
            self._load("steps: []\nsteps: []\n")
        self.assertIn("'steps' appears twice", str(caught.exception))


class Rules(unittest.TestCase):
    """Each test breaks one rule of the valid graph and expects the checker to name it."""

    @classmethod
    def setUpClass(cls):
        cls.parts = check_graph.load_parts(PARTS)

    def problems(self, data: dict, name: str = "valid") -> list[str]:
        return check_graph.check_graph_data(data, name, self.parts)

    def assertProblem(self, data: dict, text: str, name: str = "valid"):
        found = self.problems(data, name)
        self.assertTrue(any(text in p for p in found), f"{text!r} not in {found}")

    def test_valid_has_no_problems(self):
        self.assertEqual(self.problems(valid_data()), [])

    def test_valid_parts_have_no_problems(self):
        self.assertEqual(self.parts.problems, [])

    # Schema and neutrality
    def test_unknown_key_is_outside_the_schema(self):
        data = valid_data()
        step(data, "design")["colour"] = "blue"
        self.assertProblem(data, "steps.design.colour: key 'colour' is not in the convention's schema")

    def test_top_level_orchestrator_key(self):
        data = valid_data()
        data["isolation"] = "worktree"
        self.assertProblem(data, "isolation: key 'isolation' belongs to one orchestrator")

    def test_model_in_a_graph_is_refused(self):
        data = valid_data()
        step(data, "review")["model"] = "some-model"
        self.assertProblem(data, "steps.review.model: key 'model' belongs to one orchestrator")

    def test_graph_id_must_match_file_name(self):
        self.assertProblem(valid_data(), "graph 'valid' does not match the file name 'other'", name="other")

    def test_convention_version(self):
        data = valid_data()
        data["convention"] = 2
        self.assertProblem(data, "convention must be 1")

    def test_step_needs_exactly_one_kind(self):
        data = valid_data()
        step(data, "design")["gate"] = "lint-spec"
        self.assertProblem(data, "step 'design' must have exactly one of role, gate or ask")

    def test_duplicate_step_id(self):
        data = valid_data()
        data["steps"].append(copy.deepcopy(step(data, "post_note")))
        self.assertProblem(data, "step id 'post_note' is used twice")

    # Header
    def test_access_must_cover_every_step(self):
        data = valid_data()
        del data["header"]["access"]["review"]
        self.assertProblem(data, "header.access: step 'review' has no access")

    def test_access_names_unknown_step(self):
        data = valid_data()
        data["header"]["access"]["ghost"] = "read"
        self.assertProblem(data, "header.access: unknown step 'ghost'")

    def test_access_value(self):
        data = valid_data()
        data["header"]["access"]["design"] = "everyone"
        self.assertProblem(data, "header.access.design: 'everyone' is not one of read, josh, shared")

    def test_jira_stretch_misses_a_step(self):
        data = valid_data()
        data["header"]["jira"][1]["steps"] = []
        self.assertProblem(data, "header.jira: step 'build' is in no stretch")

    def test_jira_stretch_repeats_a_step(self):
        data = valid_data()
        data["header"]["jira"][1]["steps"] = ["build", "design"]
        self.assertProblem(data, "header.jira: step 'design' is in more than one stretch")

    def test_asks_josh_must_list_every_ask(self):
        data = valid_data()
        data["header"]["asks_josh"].remove("approve_note")
        self.assertProblem(data, "header.asks_josh: ask step 'approve_note' is not listed")

    def test_asks_josh_lists_only_asks(self):
        data = valid_data()
        data["header"]["asks_josh"].append("build")
        self.assertProblem(data, "header.asks_josh: 'build' is not an ask step")

    def test_ledger_vocabulary(self):
        data = valid_data()
        data["header"]["ledger"].append("transcript")
        self.assertProblem(data, "header.ledger: 'transcript' is not one of")

    # End states (JP-140)
    def test_end_states_is_a_required_header_field(self):
        result = run_cli("--root", str(PARTS), str(BAD / "missing-end-states.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("header: missing field 'end_states'", result.stdout)

    def test_an_end_the_graph_does_not_have_is_refused(self):
        result = run_cli("--root", str(PARTS), str(BAD / "unknown-end-name.yaml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("header.end_states: 'publish.opened' is not an end of this graph", result.stdout)

    def test_running_out_of_steps_is_an_end_to_classify(self):
        data = valid_data()
        del data["header"]["end_states"]["finished"]
        self.assertProblem(data, "header.end_states: end 'finished' is unclassified")

    def test_an_outcome_that_only_moves_on_is_not_an_end(self):
        data = valid_data()
        data["header"]["end_states"]["lint_spec.pass"] = "success"
        self.assertProblem(data, "header.end_states: 'lint_spec.pass' is not an end of this graph")

    def test_a_loop_is_not_an_end(self):
        data = valid_data()
        data["header"]["end_states"]["lint_spec.incomplete"] = "neutral"
        self.assertProblem(data, "header.end_states: 'lint_spec.incomplete' is not an end of this graph")

    def test_a_new_end_must_be_classified(self):
        data = valid_data()
        step(data, "decide_review")["on"]["retry"] = "end"
        self.assertProblem(data, "header.end_states: end 'decide_review.retry' is unclassified")

    def test_every_class_is_accepted(self):
        for value in ("success", "neutral", "needs-josh"):
            with self.subTest(value):
                data = valid_data()
                data["header"]["end_states"]["finished"] = value
                self.assertEqual(self.problems(data), [])

    def test_end_states_must_be_a_mapping(self):
        data = valid_data()
        data["header"]["end_states"] = ["finished"]
        self.assertProblem(data, "header.end_states: needs a mapping of each end to success, neutral, needs-josh")

    def test_exit_refused_is_reserved_and_not_written_in_end_states(self):
        for value in ("needs-josh", "success"):
            with self.subTest(value):
                data = valid_data()
                data["header"]["end_states"]["exit_refused"] = value
                found = self.problems(data)
                self.assertEqual(found, ["header.end_states: 'exit_refused' is reserved: its score is "
                                         "always needs-josh, so it is never written here"])

    def test_a_class_that_is_not_text_is_refused(self):
        data = valid_data()
        data["header"]["end_states"]["finished"] = None
        self.assertProblem(data, "header.end_states.finished: 'None' must be one of")

    def test_entry_gate_must_exist(self):
        data = valid_data()
        data["header"]["entry_gate"] = "nope"
        self.assertProblem(data, "header.entry_gate names unknown gate 'nope'")

    # References
    def test_needs_unknown_step(self):
        data = valid_data()
        step(data, "build")["needs"] = ["ghost"]
        self.assertProblem(data, "step 'build' needs unknown step 'ghost'")

    def test_needs_cycle(self):
        data = valid_data()
        step(data, "design")["needs"] = ["post_note"]
        self.assertProblem(data, "needs form a cycle")

    def test_on_outcome_not_declared(self):
        data = valid_data()
        step(data, "lint_spec")["on"]["broken"] = "end"
        self.assertProblem(data, "step 'lint_spec': on 'broken' is not one of its outcomes")

    def test_when_unknown_outcome(self):
        data = valid_data()
        step(data, "build")["when"]["outcome"] = "maybe"
        self.assertProblem(data, "step 'build': when names outcome 'maybe', which step 'approve_spec' "
                                 "does not have")

    def test_goto_unknown_step(self):
        data = valid_data()
        step(data, "lint_spec")["on"]["incomplete"]["goto"] = "ghost"
        self.assertProblem(data, "loop lint_spec -> ghost (outcome 'incomplete') goes to unknown step 'ghost'")

    def test_unknown_agent(self):
        data = valid_data()
        step(data, "build")["agent"] = "nobody"
        self.assertProblem(data, "step 'build' names unknown agent 'nobody'")

    def test_agent_must_fill_the_role(self):
        data = valid_data()
        step(data, "publish")["agent"] = "sample-builder"
        self.assertProblem(data, "step 'publish': agent 'sample-builder' fills role 'builder', not 'publisher'")

    def test_agent_rule_must_read_a_graph_input(self):
        data = valid_data()
        step(data, "build")["agent"]["by"] = "colour"
        self.assertProblem(data, "step 'build': agent rule reads 'colour', which is not a graph input")

    def test_unknown_contract(self):
        data = valid_data()
        step(data, "design")["outputs"]["spec_path"]["contract"] = "novel"
        self.assertProblem(data, "step 'design' output 'spec_path' names unknown contract 'novel'")

    # Loops end at a human
    def test_at_limit_must_be_an_ask(self):
        data = valid_data()
        step(data, "lint_spec")["on"]["incomplete"]["at_limit"] = "build"
        self.assertProblem(data, "loop lint_spec -> design (outcome 'incomplete'): at_limit 'build' is not "
                                 "an ask step, so the loop does not end at a human")

    def test_max_loops_must_be_positive(self):
        data = valid_data()
        step(data, "lint_spec")["on"]["incomplete"]["max_loops"] = 0
        self.assertProblem(data, "loop lint_spec -> design (outcome 'incomplete'): max_loops must be a "
                                 "whole number of 1 or more")

    def test_on_limit_only_ask_must_be_a_limit(self):
        data = valid_data()
        step(data, "check_review")["on"]["rework"]["at_limit"] = "approve_spec"
        step(data, "decide_review")["on"]["retry"]["at_limit"] = "approve_spec"
        self.assertProblem(data, "ask step 'decide_review' is on_limit_only but no loop ends at it")

    def test_on_limit_only_ask_has_no_needs(self):
        data = valid_data()
        step(data, "decide_review")["needs"] = ["review"]
        self.assertProblem(data, "ask step 'decide_review' is on_limit_only, so it takes no needs or when")

    # Shared writes
    def test_approval_must_come_before_the_write(self):
        data = valid_data()
        step(data, "approve_note")["needs"] = ["post_note"]
        step(data, "post_note")["needs"] = ["to_validation"]
        del step(data, "post_note")["when"]
        self.assertProblem(data, "step 'post_note' writes something shared and no approval step comes before it")

    def test_approves_unknown_step(self):
        data = valid_data()
        step(data, "approve_note")["ask"]["approves"].append("ghost")
        self.assertProblem(data, "ask step 'approve_note' approves unknown step 'ghost'")

    # Shared writes run only on Josh's yes (review of PR #6)
    def test_shared_write_without_when_runs_after_a_no(self):
        data = valid_data()
        del step(data, "post_note")["when"]
        self.assertProblem(data, "step 'post_note' writes something shared but does not run only when "
                                 "'approve_note' is answered with an approving choice")

    def test_approval_ask_that_can_be_skipped(self):
        data = valid_data()
        step(data, "approve_note")["when"] = {"step": "check_review", "outcome": "clean"}
        self.assertProblem(data, "ask step 'approve_note' approves a shared write, so it takes no when "
                                 "(a skipped approval is not a yes)")

    def test_shared_write_on_a_declining_choice(self):
        data = valid_data()
        step(data, "post_note")["when"]["outcome"] = ["post", "skip"]
        self.assertProblem(data, "step 'post_note' runs on 'skip', which is not one of approve_note's "
                                 "approves_on choices")

    def test_approves_needs_approves_on(self):
        data = valid_data()
        del step(data, "approve_note")["ask"]["approves_on"]
        self.assertProblem(data, "ask step 'approve_note' approves steps, so it needs approves_on")

    # Category split (JP-106 question 4; JP-148)
    def test_a_split_names_inputs_or_outputs_above_the_ask(self):
        data = valid_data()
        self.assertEqual(step(data, "approve_spec")["ask"]["split"], ["system", "spec_path"])
        step(data, "approve_spec")["ask"]["split"] = ["system", "defects"]
        self.assertProblem(data, "ask step 'approve_spec' splits on 'defects', which is not a graph input or an "
                                 "output of a step above it")

    def test_a_split_is_a_list_of_distinct_names(self):
        data = valid_data()
        step(data, "approve_spec")["ask"]["split"] = "system"
        self.assertProblem(data, "ask step 'approve_spec': split must be a list of names")
        step(data, "approve_spec")["ask"]["split"] = ["system", "system"]
        self.assertProblem(data, "ask step 'approve_spec': split names a detail more than once")

    def test_an_ask_without_a_split_is_one_category(self):
        data = valid_data()
        del step(data, "approve_spec")["ask"]["split"]
        self.assertEqual(self.problems(data), [])

    def test_approves_on_must_leave_a_no(self):
        data = valid_data()
        step(data, "approve_note")["ask"]["approves_on"] = ["post", "skip"]
        self.assertProblem(data, "ask step 'approve_note': approves_on must name some of its choices, "
                                 "not all of them")

    def test_approves_on_names_real_choices(self):
        data = valid_data()
        step(data, "approve_note")["ask"]["approves_on"] = ["yes"]
        self.assertProblem(data, "ask step 'approve_note': approves_on choice 'yes' is not one of its choices")

    # Step inputs (review of PR #6)
    def test_step_reads_unknown_input(self):
        data = valid_data()
        step(data, "build")["inputs"] = ["no_such_input"]
        self.assertProblem(data, "step 'build' reads unknown input 'no_such_input'")

    def test_step_reads_a_later_output(self):
        data = valid_data()
        step(data, "build")["inputs"] = ["defects"]
        self.assertProblem(data, "step 'build' reads unknown input 'defects'")

    def test_step_inputs_as_a_mapping_with_runner_keys(self):
        data = valid_data()
        step(data, "build")["inputs"] = {"model": "opus", "mode": "bypass"}
        self.assertProblem(data, "step 'build': inputs must be a list of names")
        self.assertProblem(data, "steps.build.inputs.model: key 'model' belongs to one orchestrator")
        self.assertProblem(data, "steps.build.inputs.mode: key 'mode' belongs to one orchestrator")

    def test_brief_names_unknown_input(self):
        data = valid_data()
        step(data, "design")["brief"] = "Ticket: {{ inputs.ticket_id }}."
        self.assertProblem(data, "step 'design': brief names '{{ inputs.ticket_id }}', which is not a graph input")

    def test_question_names_unknown_input(self):
        data = valid_data()
        step(data, "approve_spec")["ask"]["question"] = "Build {{ inputs.nope }}?"
        self.assertProblem(data, "step 'approve_spec': question names '{{ inputs.nope }}', which is not a graph input")

    def test_output_type(self):
        data = valid_data()
        step(data, "design")["outputs"]["spec_path"]["type"] = "path"
        self.assertProblem(data, "step 'design' output 'spec_path': type must be one of string, number, boolean, list")

    def test_effects_cannot_be_read_only(self):
        data = valid_data()
        data["header"]["access"]["to_validation"] = "read"
        self.assertProblem(data, "step 'to_validation' has effects, so its access cannot be read")

    # Habits
    def test_only_scripts_set_labels_and_move_tickets(self):
        data = valid_data()
        step(data, "publish")["effects"] = ["set_label"]
        self.assertProblem(data, "step 'publish': only a gate script may have effects (set labels, move tickets)")

    def test_effects_vocabulary(self):
        data = valid_data()
        step(data, "to_validation")["effects"] = ["send_email"]
        self.assertProblem(data, "step 'to_validation': effect 'send_email' is not one of move_ticket, set_label")

    def test_step_tier_may_not_exceed_role_tier(self):
        data = valid_data()
        step(data, "publish")["tier"] = "mid"
        self.assertProblem(data, "step 'publish': tier 'mid' is above its role's tier 'cheap'")

    def test_read_only_role_cannot_write(self):
        data = valid_data()
        data["header"]["access"]["review"] = "josh"
        self.assertProblem(data, "step 'review' writes (access 'josh') but role 'code-reviewer' may not change things")

    def test_reviewer_needs_a_citation_gate(self):
        data = valid_data()
        step(data, "check_review")["needs"] = ["build"]
        self.assertProblem(data, "step 'review' uses reviewer role 'code-reviewer' but no gate step needs it "
                                 "to drop defects that do not cite the plan")

    # Run cap by tier (JP-139)
    def test_a_loop_counts_its_own_reruns_only(self):
        # The design loop has a gate-tier reviewer further down the graph, but the reviewer waits for the
        # loop's source step, so the loop never reruns it and its cap is not touched.
        data = valid_data()
        self.assertEqual(self.problems(data), [])

    def test_a_tier_on_a_non_role_step_is_not_counted_against_a_cap(self):
        # A tier only goes on a role step; the checker says so once and adds no cap problem for that step.
        data = valid_data()
        step(data, "lint_spec")["tier"] = "gate"
        found = self.problems(data)
        self.assertIn("step 'lint_spec': tier only goes on a role step", found)
        self.assertEqual([p for p in found if "cap of" in p], [])

    def test_a_loop_one_over_a_mid_cap_is_refused(self):
        data = valid_data()
        step(data, "lint_spec")["on"]["incomplete"]["max_loops"] = 3
        self.assertProblem(data, "loop lint_spec -> design (outcome 'incomplete') would run step 'design' "
                                 "4 times (max_loops 3 + 1) against a mid cap of 3")

    def test_a_step_tier_chooses_the_cap(self):
        # build is a mid role used at tier cheap, so its cap is 5: max_loops 4 passes, 5 does not.
        data = valid_data()
        step(data, "decide_review")["on"]["retry"]["max_loops"] = 4
        for text in self.problems(data):
            self.assertNotIn("step 'build'", text)
        step(data, "decide_review")["on"]["retry"]["max_loops"] = 5
        self.assertProblem(data, "would run step 'build' 6 times (max_loops 5 + 1) against a cheap cap of 5")

    def test_every_role_step_the_loop_reruns_is_named(self):
        data = valid_data()
        step(data, "decide_review")["on"]["retry"]["max_loops"] = 2
        found = [p for p in self.problems(data) if p.startswith("loop decide_review -> build")]
        self.assertEqual(len(found), 1, found)  # review (gate, cap 2) is over; build (cheap, cap 5) is not
        self.assertIn("step 'review' 3 times", found[0])

    def test_a_loop_through_a_gate_script_still_counts_the_role_steps(self):
        data = valid_data()
        step(data, "check_review")["on"]["rework"]["max_loops"] = 2
        self.assertProblem(data, "loop check_review -> build (outcome 'rework') would run step 'review' "
                                 "3 times (max_loops 2 + 1) against a gate cap of 2")


class WrongTypes(unittest.TestCase):
    """A value of the wrong type is reported, never a crash."""

    @classmethod
    def setUpClass(cls):
        cls.parts = check_graph.load_parts(PARTS)

    def assertReported(self, data: dict, text: str):
        found = check_graph.check_graph_data(data, "valid", self.parts)
        self.assertTrue(any(text in p for p in found), f"{text!r} not in {found}")

    def test_role_as_a_mapping(self):
        data = valid_data()
        step(data, "design")["role"] = {"name": "designer"}
        self.assertReported(data, "step 'design': role must be a name")

    def test_gate_as_a_list(self):
        data = valid_data()
        step(data, "lint_spec")["gate"] = ["lint-spec"]
        self.assertReported(data, "step 'lint_spec': gate must be a name")

    def test_goto_and_at_limit_as_mappings(self):
        data = valid_data()
        step(data, "lint_spec")["on"]["incomplete"] = {"goto": {"x": 1}, "max_loops": 2, "at_limit": {"y": 2}}
        self.assertReported(data, "step 'lint_spec': on 'incomplete': goto and at_limit must be step ids")

    def test_header_gate_as_a_mapping(self):
        data = valid_data()
        data["header"]["entry_gate"] = {"run": "ready"}
        self.assertReported(data, "header.entry_gate names unknown gate")

    def test_approves_as_text_is_not_a_substring_match(self):
        data = valid_data()
        step(data, "approve_note")["ask"]["approves"] = "post_note_and_more"
        self.assertReported(data, "ask step 'approve_note': approves must be a list of step ids")
        self.assertReported(data, "step 'post_note' writes something shared and no approval step comes before it")

    def test_agent_map_value_as_a_mapping(self):
        data = valid_data()
        step(data, "build")["agent"]["map"]["sample"] = {"name": "sample-builder"}
        self.assertReported(data, "step 'build': agent rule map values must be agent names")

    def test_no_wrong_typed_value_anywhere_crashes_the_checker(self):
        base = valid_data()
        paths: list[list] = []

        def walk(node, path):
            paths.append(path)
            items = node.items() if isinstance(node, dict) else enumerate(node) if isinstance(node, list) else []
            for key, value in items:
                walk(value, path + [key])

        walk(base, [])
        for path in paths[1:]:
            for replacement in ({"x": 1}, ["x"], [{"a": 1}], 5, None, "x", True, ""):
                data = copy.deepcopy(base)
                node = data
                for key in path[:-1]:
                    node = node[key]
                node[path[-1]] = replacement
                try:
                    check_graph.check_graph_data(data, "valid", self.parts)
                except Exception as exc:  # noqa: BLE001 - any crash is the failure
                    self.fail(f"{path} = {replacement!r} crashed the checker: {exc!r}")

    def test_joshs_original_pipeline_file_is_refused_cleanly(self):
        source = GRAPHS.parent / "docs/source-notes/jira-ticket-pipeline.yaml"
        with tempfile.TemporaryDirectory() as tmp:
            copy_path = Path(tmp) / "jira-ticket-pipeline.yaml"
            shutil.copy(source, copy_path)
            result = run_cli(str(copy_path))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertIn("key 'manager' belongs to one orchestrator", result.stdout)


class Parts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "parts"
        shutil.copytree(PARTS, self.root)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def problems(self) -> list[str]:
        return check_graph.load_parts(self.root).problems

    def assertProblem(self, text: str):
        found = self.problems()
        self.assertTrue(any(text in p for p in found), f"{text!r} not in {found}")

    def test_tiers_must_define_all_three(self):
        (self.root / "tiers.yaml").write_text("convention: 1\ntiers:\n  cheap: [a]\n  mid: [b]\n")
        self.assertProblem("tiers.yaml: tier 'gate' is missing")

    def run_with_tiers(self, fixture: Path):
        shutil.copyfile(fixture, self.root / "tiers.yaml")
        return run_cli("--root", str(self.root))

    def test_an_entry_with_no_effort_is_refused(self):  # JP-138 scenario 1
        result = self.run_with_tiers(BAD_TIERS / "bare-model-name.yaml")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("tiers.mid[0] is missing an effort", result.stdout)

    def test_a_fallback_with_no_effort_is_refused(self):  # JP-138 scenario 2
        result = self.run_with_tiers(BAD_TIERS / "fallback-without-effort.yaml")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("tiers.cheap[1] is missing an effort", result.stdout)
        self.assertNotIn("tiers.cheap[0]", result.stdout)

    def test_every_bad_tiers_sample_fails(self):
        for path in sorted(BAD_TIERS.glob("*.yaml")):
            with self.subTest(path.name):
                self.assertEqual(self.run_with_tiers(path).returncode, 1)

    def test_an_effort_outside_the_levels_is_refused(self):
        (self.root / "tiers.yaml").write_text(
            "convention: 1\ntiers:\n  cheap: [a]\n  mid: [{model: b, effort: max}]\n  gate: [c]\n")
        self.assertProblem("tiers.mid[0].effort must be one of low, medium, high")

    def test_the_repository_tiers_file_names_a_model_and_an_effort_everywhere(self):  # JP-138 scenario 3
        data = check_graph.load_yaml(GRAPHS / "tiers.yaml")
        for tier, entries in data["tiers"].items():
            for i, entry in enumerate(entries):
                with self.subTest(f"{tier}[{i}]"):
                    self.assertIsInstance(entry, dict)
                    self.assertTrue(entry.get("model"))
                    self.assertIn(entry.get("effort"), check_graph.EFFORTS)

    def test_tier_entry_shape(self):
        (self.root / "tiers.yaml").write_text(
            "convention: 1\ntiers:\n  cheap: [a]\n  mid: [b]\n  gate: [{model: c, speed: 9}]\n")
        self.assertProblem("tiers.yaml: tiers.gate[0].speed: key 'speed' is not in the convention's schema")

    def test_max_runs_is_required_for_every_tier(self):
        (self.root / "tiers.yaml").write_text(
            "convention: 1\ntiers:\n  cheap: [{model: a, effort: low}]\n  mid: [{model: b, effort: low}]\n"
            "  gate: [{model: c, effort: low}]\n")
        for tier in ("cheap", "mid", "gate"):
            self.assertProblem(f"tiers.yaml: tier '{tier}' has no max_runs")

    def test_max_runs_must_be_a_whole_number_of_one_or_more(self):
        for bad in ("0", "-1", "2.5", "true", "three"):
            with self.subTest(bad):
                shutil.copyfile(PARTS / "tiers.yaml", self.root / "tiers.yaml")
                text = (self.root / "tiers.yaml").read_text().replace("mid: 3", f"mid: {bad}")
                (self.root / "tiers.yaml").write_text(text)
                self.assertProblem("tiers.yaml: max_runs.mid must be a whole number of 1 or more")

    def test_max_runs_names_only_tiers(self):
        text = (PARTS / "tiers.yaml").read_text() + "  huge: 9\n"
        (self.root / "tiers.yaml").write_text(text)
        self.assertProblem("tiers.yaml: max_runs.huge is not a tier (one of cheap, mid, gate)")

    def test_max_runs_must_be_a_mapping(self):
        text = (PARTS / "tiers.yaml").read_text().split("max_runs:")[0] + "max_runs: 3\n"
        (self.root / "tiers.yaml").write_text(text)
        self.assertProblem("tiers.yaml: max_runs must map each tier to a number of runs")

    def test_a_graph_is_not_checked_against_a_cap_that_is_not_set(self):
        # With no usable caps the tiers file reports the problem; the graph adds no second complaint per loop.
        (self.root / "tiers.yaml").write_text((PARTS / "tiers.yaml").read_text().split("max_runs:")[0])
        data = check_graph.load_yaml(BAD / "gate-loop-over-cap.yaml")
        found = check_graph.check_graph_data(data, "gate-loop-over-cap", check_graph.load_parts(self.root))
        self.assertEqual([p for p in found if "cap of" in p], [])

    def test_role_needs_instructions(self):
        (self.root / "roles/designer/instructions.md").unlink()
        self.assertProblem("roles/designer: instructions.md is missing or empty")

    def test_role_fields(self):
        (self.root / "roles/designer/role.yaml").write_text("title: Designer\ntier: mid\n")
        self.assertProblem("roles/designer/role.yaml: missing field 'may_change'")

    def test_gate_tier_only_for_a_role_that_only_reads(self):
        (self.root / "roles/builder/role.yaml").write_text("title: Builder\nmay_change: true\ntier: gate\n")
        self.assertProblem("roles/builder/role.yaml: the gate tier is for roles that only read and judge")

    def test_agent_fills_unknown_role(self):
        (self.root / "agents/sample-builder/agent.yaml").write_text("title: X\nfills: astronaut\n")
        self.assertProblem("agents/sample-builder/agent.yaml: fills unknown role 'astronaut'")

    def test_role_with_a_model_is_refused(self):
        (self.root / "roles/designer/role.yaml").write_text(
            "title: Designer\nmay_change: true\ntier: mid\nmodel: some-model\n")
        self.assertProblem("roles/designer/role.yaml: model: key 'model' belongs to one orchestrator")


if __name__ == "__main__":
    unittest.main()
