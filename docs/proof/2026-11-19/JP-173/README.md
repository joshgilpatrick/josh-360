# JP-173 proof: ticket sessions grouped by status in Agent Manager

## Contents

- [What changed](#what-changed)
- [Scenarios](#scenarios)
- [Sandbox run](#sandbox-run)
- [Not proven here](#not-proven-here)

## What changed

JP-173 makes a ticket findable in Agent Manager:

- Each step session of a ticket is named `<KEY>(<letter>) - <Step title>`, for example `JP-900(b) - Build`. The letter counts the ticket's sessions across all its runs. The count lives in `~/.josh-360/state/runner/am-tickets.json`.
- The ticket's newest session stays unarchived in the group `josh-360/tickets/<Jira status>`. A `/` in the status becomes `-`.
- The newest session moves with `agent-manager move` when the status the walker last set changes. Every earlier session is archived.
- A ticket whose run ended in Done has its kept session archived 7 days later.
- Sessions with no ticket key keep the old name and group, and are archived when their result is recorded.
- The doctor check `graphs.agent-manager-groups` reads the runner's file and Agent Manager's database. It never reads Jira, so the daily offline `doctor` job can run it.

The code is in `graphs/runner/runner_lib/amgroups.py` (new), `graphs/runner/runner_lib/advance.py`, `graphs/runner/runner_lib/tick.py`, `graphs/bindings/agent-manager/binding.py` and `scripts/doctor_lib/graph_checks.py`. The choices made while building are in `docs/decisions/JP-173.md`.

Every input is made up: the ticket keys JP-900 and JP-901, a fake `agent-manager` (`tests/fakes/agent-manager`, which now has `move`) and a moved clock. Nothing touches the network.

The output files:

- `01-am-groups-tests.txt`: 13 tests of the runner.
- `02-doctor-check-tests.txt`: 7 tests of the doctor check.
- `03-check-tail.txt`: the end of a full `python3 scripts/check.py` run.

## Scenarios

| Scenario | Proof |
| --- | --- |
| The first session of a ticket is named `JP-900(a) - Design` and is in `josh-360/tickets/Design-Planning` | `test_the_first_session_of_a_ticket`; sandbox step 04 |
| Letters count across runs: 3 earlier sessions and 1 in this run make the build session (e) | `test_letters_count_across_runs` |
| A retry gets its own letter, and the attempt it replaces is archived | `test_a_retry_gets_its_own_letter` |
| The newest session follows the status and stays unarchived; earlier ones are archived | `test_the_newest_session_follows_the_status`, `test_the_tick_places_sessions`; sandbox steps 10, 15 and 18 |
| Done tickets leave after 7 days; one that reached Done 6 days ago keeps its session | `test_done_tickets_leave_after_7_days` |
| A recorded result no longer archives the session at once | `test_a_recorded_result_keeps_the_session_in_view`; sandbox step 07 |
| A session with no ticket key keeps its old name | `test_a_keyless_session_keeps_the_old_name` |
| A failed move is tried again on the next pass | `test_a_failed_move_is_tried_again` |
| A status group that cannot be made falls back to `josh-360/graph-runs`, then is moved on the next pass | `test_a_status_group_that_cannot_be_made_falls_back_to_the_old_group` |
| An unreadable tickets file starts no session (unknown is not empty) | `test_an_unreadable_tickets_file_starts_no_session` |
| The doctor check passes with one session in its group | `test_one_session_in_its_group_passes`; sandbox step 21 |
| The doctor check fails on two sessions in view, the wrong group, a wrong name, an unknown session in a ticket group, or an unreadable runner file | `test_two_sessions_in_view_fail`, `test_the_wrong_group_fails`, `test_a_wrong_name_fails`, `test_an_unknown_session_in_a_ticket_group_fails`, `test_an_unreadable_runner_file_fails_and_a_missing_database_skips` |
| The doctor check skips, not passes, when nothing is in view or Agent Manager's database is missing | `test_nothing_in_view_is_a_skip`, `test_an_unreadable_runner_file_fails_and_a_missing_database_skips` |

## Sandbox run

`verify-josh-360/` holds one JSON file per step of a sandbox run of the `verify-josh-360` skill. The run used the real `walker.py`, `runner.py advance` and `doctor.py`, with a stand-in `agent-manager`, scripted gates and the fixture graph `valid`. The scripts that set up and drove it are in `standins/`. Run `r-42ad1fc8206a` for JP-900 showed:

| Step | What Agent Manager held |
| --- | --- |
| 04 | `JP-900(a) - Design` in `josh-360/tickets/Design-Planning` |
| 07 | After its result was recorded, (a) still unarchived in the same group |
| 10 | (b) Build started in `josh-360/tickets/In Progress`; (a) archived |
| 15 | (c) Review and then (d) Publish in `josh-360/tickets/Code Review`; only (d) unarchived |
| 18 | The move-ticket gate set Validation; (d) moved to `josh-360/tickets/Validation`, unarchived |
| 21 | `doctor.py --only graphs`: `graphs.agent-manager-groups` is `pass`, "1 ticket(s) in view, each with one session in its status group" |

Step 19 lists every call the runner made to Agent Manager, and step 20 is the runner's tickets file at the end.

## Not proven here

Nothing has run on the real laptop. The `@e2e` scenario, one real ticket on the laptop, rides the JP-116 proof run (JP-117). It is checked there when JP-116 moves through two Jira statuses:

- Agent Manager shows JP-116's newest session in the group for its current status.
- The archive lists JP-116(a), JP-116(b) and later sessions in order.

Laptop checks owed after this merges:

- The real Agent Manager 0.47.1 accepts a group name with a space, such as `josh-360/tickets/In Progress`. If it refuses, sessions stay in `josh-360/graph-runs` and the doctor check fails, so it is seen.
- `python3 laptop/status.py show doctor` lists `graphs.agent-manager-groups` as `skip` until the first real run, then `pass`.
