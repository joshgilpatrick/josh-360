# JP-101 proof: the graph convention and its checker

## Contents

- [What was built](#what-was-built)
- [Scenario to proof](#scenario-to-proof)
- [Worth knowing](#worth-knowing)

## What was built

- `graphs/CONVENTION.md`: how a graph is stored as portable parts (roles, agents, gate scripts, contracts, tiers, one neutral graph file), the header every graph opens with, and seven rules.
- `graphs/tools/check_graph.py`: the checker. It refuses a graph that breaks the convention and names the step, loop or key.
- `graphs/tiers.yaml`: the only file that names a model.
- `graphs/tests/`: 82 tests, one sample graph that passes, and eight that each break one rule.
- `python3 scripts/check.py` now runs the checker and its tests, so CI checks every graph.

## Scenario to proof

| Scenario | Proof |
| --- | --- |
| A valid sample graph passes | `01-valid-sample-passes.txt` (exit 0); test `test_a_valid_sample_graph_passes` |
| A shared write needs an approval step | `02-shared-write-needs-approval.txt`: no approval, a write that runs after a no, and an approval that can be skipped (each exit 1, naming the step); tests `test_a_shared_write_needs_an_approval_step`, `test_shared_write_without_when_runs_after_a_no`, `test_approval_ask_that_can_be_skipped` |
| A loop must end at a human | `03-loop-must-end-at-a-human.txt` (exit 1, names `loop lint_spec -> design`); test `test_a_loop_must_end_at_a_human` |
| The file stays neutral | `04-file-stays-neutral.txt` (exit 1, names key `mode`); test `test_the_file_stays_neutral` |
| Also in scope: unknown role, unknown gate, missing header field | `05-other-refusals.txt` |
| All tests | `06-checker-tests.txt` (82 tests, OK) |
| The repository suite | `08-suite.txt` (ok) |

## Worth knowing

- `07-drafted-pipeline-refused-cleanly.txt`: Josh's drafted Paseo pipeline, run as-is, is refused with 105 specific lines and no crash. That list is what converting it into the development graph will take.
- The default choices made while building are the JP-101 rows in `docs/decisions.md`.
