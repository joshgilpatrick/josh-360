# JP-114 proof: build the walker

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every graph, ticket and answer in these tests is made up, in a temporary home with a temporary ledger and a scripted stand-in for Jira. Each file below is the output of the tests, run from the `tests/` folder.

| Scenario | Proof | Test |
| --- | --- | --- |
| The next step follows each outcome | `01-next-step-follows-outcome.txt` | `WalkingAGraph.test_a_whole_run_follows_each_outcome_to_the_end`, `test_the_ledger_has_the_scoring_fields_for_every_step` |
| A run survives a closed terminal | `02-survives-closed-terminal.txt` | `WalkingAGraph.test_a_run_survives_a_closed_terminal` (a new process picks the run up from the ledger) |
| A question parks the run and an answer resumes it | `03-park-and-resume.txt` | `Asking.test_a_parked_run_leaves_a_question_in_needs_you_and_a_flag_and_no_session` and two more |
| A loop limit ends at a human, and the run cap holds across loops | `04-loop-limit-ends-at-human.txt` | the six `Limits` tests |
| A graph the checker rejects is not run | `05-rejected-graph-not-run.txt` | `test_walker_compile`, all eight |
| The spec and evidence are saved with the run, outside the repository | `06-saved-files.txt` | `WalkingAGraph.test_the_files_a_run_made_are_saved_with_it_outside_the_repository` |
| Patient data is screened before Jira and kept out of a `phi` run's question | `07-patient-data.txt` | `TypedAnswers` and `Asking.test_a_phi_run_stores_no_question_text` |
| The whole suite passes | `08-suite.txt` | `python3 scripts/check.py` (all 40 walker tests included) |

The design is `docs/superpowers/specs/2026-11-17-walker-design.md`; the rules it holds are in `graphs/CONVENTION.md`, "The walker".

## What still needs the laptop

Nothing blocks the merge. Two things can only be seen on the laptop, and neither needs Josh:

1. Merging to `main` installs the walker there (JP-105). Check `python3 graphs/tools/walker.py status --run <id>` after the first real run (JP-117 starts runs).
2. The flag and comment scripts (`graphs/gates/set-flag.py`, `post-comment.py`) are stubs that refuse until the shared Jira library lands with JP-121, JP-122 or JP-123. Until then the walker puts the question in Needs you and reports the Jira warning.
