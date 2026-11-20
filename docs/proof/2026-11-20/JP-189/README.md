# JP-189 proof: every role shows an example result that matches its step

## Contents

- [What was wrong](#what-was-wrong)
- [The change](#the-change)
- [Scenarios](#scenarios)
- [What it cannot catch](#what-it-cannot-catch)

## What was wrong

JP-184's laptop run stopped because triage's `revise` session put its proposal's fields straight under `outputs`, and the walker refused them. JP-184 told every session its step's output names and gave the ticket drafter worked examples. Nothing checked that the other roles show a right example, and the cloud stand-in for Claude Code (JP-186) wrote the first example it found in a role's instructions, whatever the step: for `revise` it wrote the drafter's `draft` example.

On `main` (dc12d16) the new check finds all 17 role steps with no example: the other 14 roles show none, and the drafter's three examples name no step (`check-before.txt`).

## The change

- `graphs/tools/role_examples.py check` (new, run by `scripts/check.py` as check 18): for every role step in `graphs/compiled/`, the role's `instructions.md` must hold at least one ```` ```json result step=<step> ```` block. Each example's `outcome` must be one the step declares, every key under `outputs` must be declared, and together the step's examples must name every declared output. It also refuses an example for a step the role does not serve, and an untagged block holding an `outcome`.
- The other 14 roles' instructions now end with a "Your result file" section: made-up example results for each of its steps, usually one per outcome. The ticket drafter's three existing examples are tagged `draft` and `revise`.
- `tests/e2e/standin/claude`: the `example` scenario writes the session's own step's first example, read by the same code as the check.
- Docs: `graphs/CONVENTION.md` (Roles), `graphs/roles/README.md`, `graphs/README.md`, `tests/e2e/README.md`, `AGENTS.md`. Choices: `docs/decisions/JP-189.md`.

No step's declared outputs changed, and nothing calls a model.

## Scenarios

| Scenario | Proof | Test |
| --- | --- | --- |
| Every role step has a matching example (`@auto`) | `check-after.txt`: all 17 role steps pass | `tests/test_role_examples.py` `OnMain` |
| An example with an undeclared output fails (`@auto`) | `check-after.txt` | `test_an_example_with_an_undeclared_output_fails_naming_the_step_and_the_key`: `"action"` under the `revise` example's `outputs` fails with one line naming step `'revise'`, the key `'action'` and "it declares proposal" |
| A step with no example fails (`@auto`) | `check-after.txt` | `test_a_step_with_no_example_fails_naming_that_step`: the designer's examples removed, the one line names step `'design'` |
| The stand-in writes each step's own example | `standin-before.txt` (fails on `main`), `standin-after.txt` | `tests/test_e2e_standin.py`: `test_example_takes_the_example_tagged_for_its_step`, `test_every_role_step_gets_the_example_the_role_example_check_reads` (all 17 real steps) |
| The real Agent Manager tests still pass | `standin-after.txt` | `JOSH360_E2E_AM=1`, Agent Manager 0.47.1 installed in the cloud session: 29 tests |

The full suite (`python3 scripts/check.py`) passes on the branch.

## What it cannot catch

A model that ignores a right example. That needs a real model run, which stays off by default (the ticket's "Decisions already made").
