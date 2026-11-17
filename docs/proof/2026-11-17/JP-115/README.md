# JP-115 proof: the development graph is built

## Contents

- [What was built](#what-was-built)
- [The seven scenarios](#the-seven-scenarios)
- [Output files](#output-files)
- [Laptop checks still owed](#laptop-checks-still-owed)

## What was built

`graphs/flows/development.yaml` (with its JSON copy) now runs a Ready development ticket to a merged pull request, using the walker's new `wait` step and fifteen real gate scripts. `ready` (JP-122) and `no-loose-ends` (JP-109) are the only gates it does not own. Everything here ran in the cloud on made-up data: a fake Jira ticket, a fake GitHub and a real scratch git repository. Nothing touched Jira, GitHub or the network.

## The seven scenarios

| Scenario (spec, "Acceptance criteria") | Proved by | Output |
| --- | --- | --- |
| The graph passes the checker | `graphs/tests/test_dev_graph_file.py` `test_graph_passes_the_checker`; the checker and the compile check run on all four graphs | `03-checker-and-compile.txt`, `05-gate-tests.txt` |
| Only the named points wait on Josh | `test_dev_graph_file.py` `test_asks_josh_lists_every_ask_step`, `test_limit_asks_are_reached_only_at_a_limit`, `test_named_asks_have_exactly_these_doors` | `05-gate-tests.txt` |
| A dry run reaches the end | `tests/test_development_graph.py` `test_story_in_josh_360_is_merged_by_the_graph` (statuses Ready, Design/Planning, In Progress, Code Review, Validation, Done; one merge; ends `finished`, `success`) | `04-test-development-graph.txt` |
| A defect must cite the plan | `test_dev_build_gates.py` `test_defect_quoting_nothing_is_dropped`, `test_unknown_criterion_is_dropped`, `test_quote_from_another_criterion_is_dropped` | `05-gate-tests.txt` |
| A designer's question goes back to triage | `test_development_graph.py` `test_designers_question_on_a_story_goes_back_to_triage` (Not Started, flag on, no question parked, ends `return_question.returned`) | `04-test-development-graph.txt` |
| The working files outlive the worktree | `test_story_in_josh_360_is_merged_by_the_graph` (`saved/` holds the spec and evidence with hashes in `run_files`, worktree gone, clone clean) and `test_no_working_file_was_ever_in_the_worktree` (checked before every gate call) | `04-test-development-graph.txt` |
| The graph merges only where agents may merge | `test_development_graph.py` `test_bug_elsewhere_waits_for_joshs_merge` (waits at `await_merge`, nothing merged); `test_dev_merge_gates.py` `test_merge_rule_*`, `test_merge_pr_refuses_where_agents_may_not_merge` | `04-test-development-graph.txt`, `05-gate-tests.txt` |

The whole-run file also walks: a Research ticket (design stretch only), a build that fails three times and reaches Josh, five findings re-queueing the audit and a pull request closed unmerged, a ticket routed elsewhere, a blocked audit that Josh re-queues, and two patient-data runs whose comments hold no resolution or question text.

## Output files

- `03-checker-and-compile.txt`: the graph checker and `compile_graphs.py --check`.
- `04-test-development-graph.txt`: `python3 -m unittest discover -s tests -t tests -p "test_development_graph.py" -v` (11 tests, OK).
- `05-gate-tests.txt`: `python3 -m unittest discover -s graphs/tests -p "test_dev_*.py" -v` (261 tests, OK).
- `06-check.txt`: `python3 scripts/check.py`, ending `check.py: ok (0 problem(s))`.
- `01` and `02` are the design-time proof of the draft.

## Laptop checks still owed

None blocks the merge. Each is one command or one look.

1. `gh` with Josh's login: create a missing review label, add and remove one through `gh api`, and read `gh pr checks --json name,bucket,startedAt` on a pull request with no checks, with pending checks and with finished ones.
2. Adding `review:ready-for-human` with Josh's `gh` login starts the `suite` run in josh-360 (added through the cloud's GitHub App it did not).
3. `count_findings` against the verdict comments on three real josh-360 pull requests.
4. The Agent Status field id on a JP ticket is still `customfield_10453`.
5. One real run on a small JP ticket, once `ready` (JP-122) and `no-loose-ends` (JP-109) exist and JP-117 has bound the roles.
