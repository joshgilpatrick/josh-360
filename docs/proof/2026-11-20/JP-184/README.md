# JP-184 proof: role sessions are told their step's output names

## Contents

- [What was wrong](#what-was-wrong)
- [The fix](#the-fix)
- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## What was wrong

On the laptop proof run for JP-116 (run `r-4400caa5965b`, 2026-11-20), triage's `revise` session wrote its result with the proposal's own fields straight under `outputs` (`action`, `tickets`, `closes`, `authors`). The step declares one output, `proposal`, so the walker refused the result: "step 'revise' does not declare the output 'action'". The run could not get past `revise`.

The session was never told the name. The prompt the Agent Manager binding builds said only `{"outcome": "...", "outputs": {...}}`, and the ticket drafter's instructions said "Return a proposal with `action: revise`" without saying it goes under an output called `proposal`. The same gap is in most role steps: 9 of the 16 role steps' instructions never name their output keys.

## The fix

- `graphs/tools/walker_lib/runner.py`: the walker's `run` answer now carries `outputs`, each declared output with its type, description and contract file.
- `graphs/bindings/agent-manager/binding.py`: every role step's prompt names those outputs and shows the exact skeleton, for example `{"outcome": "<one of them>", "outputs": {"proposal": ...}}`, and says the walker refuses any other key. An answer from an older walker keeps the old line.
- `graphs/roles/ticket-drafter/instructions.md`: a "Your result file" section and worked examples for `revised` and `needs_josh`: the proposal goes in a JSON file in the work folder, and `outputs.proposal` is its path.
- `graphs/flows/triage.yaml`: the `proposal` output gets a description (recompiled with `compile_graphs.py`).
- `graphs/tools/walker_lib/cli.py`: a refusal names what the step does declare ("it declares proposal").
- `graphs/contracts/ticket-proposal.md`, `graphs/CONVENTION.md`, the binding's README: the same rule written down. Choices: `docs/decisions/JP-184.md`.

## Scenarios

All runs use made-up tickets and a folder-backed fake Jira.

| Scenario | Proof | Test |
| --- | --- | --- |
| The prompt names the step's outputs (`@auto`) | `tests-before-fix.txt` (fails on `main`), `tests-after-fix.txt` | `tests/test_runner_binding.py`: `test_prompt_names_each_declared_output_and_the_result_skeleton`, `test_prompt_gives_an_output_its_description_and_contract_file`, `test_prompt_for_a_step_with_no_outputs_says_to_leave_them_empty`, `test_an_answer_from_an_older_walker_keeps_the_general_line` |
| A revise result in the documented shape is recorded (`@auto`) | same files | `graphs/tests/test_triage_run.py` `TheDrafterIsToldItsOutputs`: the ticket drafter's own `revised` example is read out of its instructions, recorded by the real walker and applied by the real `apply-revision` gate; the `needs_josh` example reaches `post-question` and parks at `ask_josh`; the `revise` answer names `proposal` and its contract file |
| A wrongly shaped result names what was expected (`@auto`) | same files | `test_the_proposal_fields_straight_under_outputs_are_refused_by_the_name_expected`: the proof run's shape is refused with "it declares proposal", nothing is written to Jira, and the right shape is then recorded on the same attempt |
| JP-116's revise step is recorded on the laptop (`@e2e`) | owed on the laptop | see below |

The full suite (`python3 scripts/check.py`) passes on the branch.

## What still needs the laptop

Once the merge has installed (the `follow` job), allow one more `revise` on the stopped run:

```bash
python3 ~/.josh-360/repo/graphs/tools/walker.py allow --run r-4400caa5965b --step revise
```

Then watch for a new "JP-116(…) - Revise" session, its result file in `~/.josh-360/runs/r-4400caa5965b/results/` with only `proposal` under `outputs`, and the runner log moving on to `apply_revision` (or `post_question`, then the ask to Josh).
