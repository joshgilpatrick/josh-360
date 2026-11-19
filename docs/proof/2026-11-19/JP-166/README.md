# JP-166 proof: the validation collectors and the watch script

## Contents

- [What changed](#what-changed)
- [Scenarios](#scenarios)
- [Not proven here](#not-proven-here)

## What changed

JP-166 builds the middle of post-deploy validation (plan tasks 4 to 7, `docs/superpowers/plans/2026-11-18-post-deploy-validation.md`; spec `docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md`): six read-only collectors that return numbers and short codes, the rules that grade a check log, the check log itself, and one call of the watch (`graphs/gates/lib/watch/round.py`, `step`). `laptop/run_jobs.py` also keeps the newest output of each report job under `state/reports/` so the `report` and `doctor` collectors can read it. No model is called anywhere. Choices: `docs/decisions/JP-166.md`.

Every input is made up: temporary folders, a ledger with made-up runs, a Jira and a GitHub that can only be read, and a clock the test moves. Nothing here touches the network. Output: `01-tests.txt` (123 tests, the four new graph test files) and `02-local-report-copy.txt` (6 tests of the report copy in `run_jobs.py`).

## Scenarios

| Scenario | Proof |
| --- | --- |
| A watch that is not due does nothing | `test_not_due_answers_pending_and_touches_nothing`: no Jira call, no reader call, the log's bytes unchanged |
| Seven passing checks in a row end the watch as met | `test_seven_passes_in_a_row_are_met`, `test_seven_passes_end_met` |
| An unreadable check neither counts nor breaks the run | `test_an_unknown_neither_counts_nor_breaks` |
| Three failing checks in a row end the watch early | `test_three_fails_end_it_early` |
| A "Fail after" line changes when a watch ends early | `test_fail_after_five_waits` |
| A watch that starts on a date takes no reading before it | `test_date_start_takes_no_reading_before_it` |
| A watch that waits for another ticket begins when that ticket is Done | `test_ticket_start_begins_when_that_ticket_is_done` |
| A watch whose start can never come ends as no data | `test_cancelled_start_ticket_ends_no_data`, `test_missing_start_ticket_ends_no_data`, `test_ninety_days_without_beginning_ends_no_data` |
| A watch with no readings ends as no data | `test_all_unknown_until_give_up_ends_no_data` |
| No reading carries text from the system it read | `test_no_reading_carries_text`, `test_take_keeps_numbers_and_short_codes_only` |
| A check is taken once after a long sleep; give-up is still honoured | `test_overdue_check_is_taken_once`, `test_give_up_is_honoured_on_the_first_call_after_a_long_sleep` |
| A crash between two writes repeats nothing | `test_end_line_is_returned_again`, `test_torn_last_line_is_skipped` |
| A ticket moved by hand is not touched, and a failed read is not a move | `test_ticket_moved_out_of_deployed_ends_left_deployed`, `test_failed_status_read_is_not_left_deployed` |

## Not proven here

The collectors and the watch have no run on the real laptop yet: JP-167 wires the graph, and JP-169 is the proof run that watches one real ticket to Done. The test that the collector list in `collectors/__init__.py` (JP-165) agrees with each reader's `FIELDS`, `COUNTS_EVENTS` and `ARGUMENT` is plan task 11, in JP-167.
