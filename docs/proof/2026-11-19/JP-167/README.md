# JP-167 proof: the validation graph and its runner

## Contents

- [What changed](#what-changed)
- [Scenarios](#scenarios)
- [Not proven here](#not-proven-here)

## What changed

JP-167 (plan tasks 8 to 13, `docs/superpowers/plans/2026-11-18-post-deploy-validation.md`; spec `docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md`) makes post-deploy validation run: the graph `graphs/flows/validation.yaml` with no model in it, nine gate scripts, the runner's start rule for JP tickets in Deployed that are not flagged, the loose-ends rule for Deployed tickets, and the doctor check `graphs.validation-watch`. Choices: `docs/decisions/JP-167.md`.

Every input is made up: a folder-backed fake Jira, a made-up `jobs-state.json`, and watch files whose times the test moves back to let an interval pass. The walker, the ledger, the graph file and every gate script are real, and each gate runs as its own process. Nothing touches the network. Output: `01-gate-tests.txt` (81 tests of the gates), `02-graph-runner-and-loose-ends-tests.txt` (103 tests: the whole runs, the start rule, the waiting list, the ticket reader and the loose-ends finder) and `03-doctor-tests.txt` (68 tests, including the new check).

## Scenarios

| Scenario | Proof |
| --- | --- |
| Three passing checks end the run as finished, the ticket is Done and the last comment holds the evidence table | `test_met_run_ends_finished` |
| No Validation section, or "Needed: no", goes straight to Done with the stated reason | `test_no_section_goes_straight_to_done`, `test_needed_no_goes_to_done_with_its_reason` |
| A failed watch files one linked Bug and the ticket stays in Deployed | `test_failed_watch_files_one_bug_and_stays_deployed` |
| A shipped fix reads the section again and starts round 2; a second shipped fix asks Josh | `test_shipped_fix_reads_the_section_again`, `test_second_shipped_fix_asks_josh` |
| A cancelled fix, no data, an unreadable section and a manual criterion each ask Josh once, with a card that names the cause | `test_cancelled_fix_asks_josh`, `test_no_data_asks_josh_once`, `test_unreadable_section_asks_josh`, `test_manual_criterion_asks_josh_when_the_rest_is_met` |
| "Watch again" shows the new round's card, not the old one | `test_watch_again_shows_the_new_card` |
| Accept closes the ticket on Josh's answer; stop flags it and leaves it in Deployed | `test_accept_closes_on_joshs_answer`, `test_stop_holds_the_ticket` |
| A ticket moved by hand is left alone: no write after the move | `test_ticket_moved_by_hand_is_left_alone`, `test_a_ticket_that_left_deployed_gets_no_bug_and_no_comment` |
| The run passes its exit gate with no session | `test_run_passes_the_exit_gate_with_no_session`, `test_development_run_whose_ticket_is_in_deployed_passes` |
| The graph has no role step; each collector the Ready check accepts is a reader module that agrees with it | `test_no_step_has_a_role`, `test_declared_collectors_are_the_reader_modules`, `test_every_comparison_is_graded` |
| A Deployed ticket starts a run with no route record; a flagged one does not | `test_deployed_ticket_starts_a_validation_run`, `test_flagged_ticket_is_not_picked_up` |
| The watch is off the seven-day list | `test_watch_step_is_left_off_the_seven_day_list` |
| Deployed and not flagged is not a loose end; Deployed and flagged says "validation needs you" | `test_deployed_and_not_flagged_is_not_a_loose_end`, `test_deployed_and_flagged_is_listed_as_needing_josh` |
| The doctor fails when the rule is off or a watch is a day past its time, and writes nothing | `test_validation_rule_off_fails`, `test_overdue_watch_fails_and_names_the_run`, `test_check_writes_nothing` |

## Not proven here

Nothing has run on the real laptop. JP-169 is the proof run: this ticket goes to Deployed when it merges, and its own validation run watches it. The laptop checks owed after this merge are listed in the plan's "Laptop checks owed after the build": `show graph-runner` has a `validation` entry with `jira: ok`; `show doctor` lists `graphs.validation-watch` as `pass`; the first pass starts only JP-167's run; the watch is not under `waiting_over_7_days`.
