# JP-191 proof: a graph step's session is closed once its step is done

## Contents

- [What changed](#what-changed)
- [Scenarios](#scenarios)
- [Sandbox run](#sandbox-run)
- [Not proven here](#not-proven-here)

## What changed

Before JP-191, a ticket's step session stayed open in Agent Manager after its step was finished. JP-191 closes it:

- When the runner records a step's result, the session moves to the group `josh-360/completed-steps` and is killed with `agent-manager kill <id> --json`. Agent Manager 0.47.1 keeps a killed session's row with status `dead`, so `revive` can bring it back.
- A session that is at rest is killed at once. One that is still finishing its turn is killed `kill_grace_seconds` (1800) after its result was recorded, so its hooks are not cut off.
- A session in completed-steps is archived 7 days after it was filed (`completed_keep_days`).
- When a ticket's newest run ends with the ticket in Done, its last session moves to `josh-360/tickets/Done` and the new gate `graphs/gates/close-out.py` runs once. The runner decides this from `~/.josh-360/state/runner/am-tickets.json`, never from Jira. The gate does nothing to a ticket already in Done and never moves one in Deployed (its validation watch owns it) or Cancelled. Any other status is moved to Done with one comment.
- Sessions with no ticket key are archived on their result, as before. Sessions recorded before JP-191 are left alone.
- The doctor check `graphs.agent-manager-groups` no longer counts killed or finished sessions as open.
- The new doctor check `graphs.completed-step-sessions` fails when a finished step's session is still running, or sits outside completed-steps and `josh-360/tickets/Done`.

The code is in:

- `graphs/runner/runner_lib/amgroups.py`
- `graphs/runner/runner_lib/advance.py`
- `graphs/bindings/agent-manager/binding.py` and `binding.json`
- `graphs/gates/close-out.py` (new)
- `scripts/doctor_lib/graph_checks.py`

The choices made while building are in `docs/decisions/JP-191.md`.

Every input is made up: the tickets JP-900 and JP-901, a fake `agent-manager` (`tests/fakes/agent-manager`, which now has `kill`), a folder Jira (`lib/jira_fake.py`) and a moved clock. Nothing touches the network.

The output files:

- `01-close-sessions-tests.txt`: 27 runner tests, the new ones and the JP-173 ones.
- `02-doctor-check-tests.txt`: 23 doctor tests for both checks.
- `03-close-out-gate-tests.txt`: 6 tests of the close-out gate.

## Scenarios

| Scenario | Proof |
| --- | --- |
| A finished step's session is filed and killed | `test_a_finished_steps_session_is_filed_and_killed`; sandbox steps 07 and 14 |
| A running step's session is left alone | `test_a_running_steps_session_is_left_alone`; sandbox steps 10 and 11 |
| A session still finishing its turn is killed only after the grace | `test_a_session_still_at_work_is_killed_only_after_the_grace` |
| A refused kill is tried again | `test_a_refused_kill_is_tried_again` |
| The last session of a finished ticket moves it to Done, once | `test_the_last_session_of_a_finished_ticket_moves_it_to_done`; sandbox steps 27 to 31 |
| The close-out leaves a Done ticket alone and never moves a Deployed or Cancelled one | `test_the_close_out_leaves_a_done_ticket_alone`, `test_the_close_out_never_moves_a_deployed_ticket`, `test_a_ticket_in_deployed_has_no_last_session`, and the gate tests |
| A failed close-out is tried again | `test_a_failed_close_out_is_tried_again` |
| Filed 7 days and 1 hour ago is archived; filed 6 days ago is not | `test_a_completed_steps_session_is_archived_after_7_days`; sandbox steps 15 to 17 |
| The last session leaves 7 days after Done | `test_the_last_session_leaves_7_days_after_done` |
| A result the finish missed (file busy) is closed by the next sync | `test_a_recorded_session_the_finish_missed_is_closed_by_the_sync` |
| A session recorded before JP-191 is not closed | `test_a_session_from_before_jp_191_is_not_closed` |
| A keyless session is archived on its result | `test_a_keyless_session_is_archived_on_its_result_as_before` |
| `graphs.agent-manager-groups` does not count closed sessions | `ClosedSessionsInGroups` in `tests/test_doctor.py`; sandbox step 35 |
| `graphs.completed-step-sessions` passes when every finished session is killed or archived, and fails when one is still open | `CompletedStepSessions` in `tests/test_doctor.py`; sandbox steps 35, 37, 39 and 41 |

## Sandbox run

`verify-josh-360/` holds one JSON file per step of a sandbox run of the `verify-josh-360` skill. The run used the real `walker.py`, `runner.py advance`, `runner.py tick` and `doctor.py`, with a stand-in `agent-manager`, a folder Jira, scripted gates and the fixture graph `valid`. The scripts that set up and drove it are in `standins/`.

| Step | What it showed |
| --- | --- |
| 07 | JP-900's design result recorded: `JP-900(a) - Design` is `dead` in `josh-360/completed-steps`, not archived |
| 10, 11 | A tick while the build step works: `JP-900(b) - Build` stays `working` in `josh-360/tickets/In Progress` |
| 14 | The build result recorded: (b) is `dead` in completed-steps; (c) Review is working |
| 15 to 17 | (a) and (b) aged to 7.042 and 6 days in completed-steps; after a tick (a) is archived and (b) is not |
| 18 to 24 | A second ticket, JP-901 (in Code Review in the folder Jira), runs its design step and its run ends |
| 26 | A stand-in sets the run's last Jira status to Done, because the fixture graph has no close step |
| 27, 28 | The tick: `JP-901(a) - Design` is `dead` in `josh-360/tickets/Done`, and `close-out JP-901: moved` is in the runner log (step 34) |
| 29 | The folder Jira: JP-901 moved from Code Review to Done, with 1 comment |
| 30, 31 | A second tick changes nothing: still 1 comment and 1 move |
| 32 | Every call the runner made to Agent Manager: a kill and a move for each finished session, and one archive |
| 35 | `doctor.py --only graphs`: both Agent Manager checks pass; nothing is old enough to judge yet |
| 36, 37 | With the finished times aged 1 day, `graphs.completed-step-sessions` passes: "3 finished step session(s), each killed or archived" |
| 38 to 41 | (b) revived by hand: the check fails ("JP-900's session s-2 finished its step but is still running"), and a tick does not kill it again |

`graphs.gate-jira` fails in every doctor step. That is the sandbox: it has no Jira email file, which that check looks for. The tick also reports "JP-901: no route record" for its watch, because the folder Jira returns every ticket for any search. Neither touches this change.

## Not proven here

Nothing has run on the real laptop. Laptop checks owed after this merges:

- The real `agent-manager kill <id> --json` on 0.47.1 stops a finished session and keeps its row as `dead`, and `revive` brings it back. The help text and source say so; it has not been run here.
- A kill does not cut off the session's SessionEnd hook or the ledger recorder. The 30-minute grace for a working session is meant to cover that; check one real ticket's ledger row after its step finishes.
- `python3 laptop/status.py show doctor` lists `graphs.completed-step-sessions`, as `pass`.
- The first real close-out: when a ticket's last run ends in Done, the runner log has `close-out <KEY>: already-done` (the `close` step has almost always moved it).

The validation watch reads the doctor check `graphs.completed-step-sessions` and the `graph-runner` job daily, starting at Deployed.
