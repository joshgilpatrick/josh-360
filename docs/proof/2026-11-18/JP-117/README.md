# JP-117: the graph runner for Agent Manager

## Contents

- [Scenarios and proof](#scenarios-and-proof)
- [What still needs the laptop](#what-still-needs-the-laptop)
- [Files](#files)

The runner is `graphs/runner/` and its binding is `graphs/bindings/agent-manager/`; the reference is `graphs/runner/README.md` and the design is `docs/superpowers/specs/2026-11-17-graph-runner-design.md`. It was built and tested in the cloud on made-up data: a temporary home and ledger, the real walker, the fixture graphs, a fake `agent-manager` and its database, a fake Jira folder and a made-up clock. No session was started, nothing real was read or written, and no test made a model call.

## Scenarios and proof

Each `@auto` scenario in the spec, with the test that proves it. Every line is in `01-runner-tests.txt` (`ok`).

| Scenario | Proof |
| --- | --- |
| Nobody starts the run by hand | `test_runner_tick.Ticking.test_tick_starts_a_run_and_launches_its_advance`; and from the label to the end of a graph, `test_runner_runs.Running.test_a_labelled_ticket_goes_to_the_end_with_no_hand_start` (three sessions named `JP-901 - Draft (...)`, `Make`, `Look`, all archived, the run recorded as an `agent-manager` run) |
| Ready alone does not start a run | `Ticking.test_ready_without_the_run_label_launches_nothing`; the fake Jira's search applies the label clause (`TheFakeSearch` in `graphs/tests/test_gate_jira.py`) |
| A failed Jira read starts and ends nothing | `Ticking.test_failed_search_leaves_open_runs_alone` (the report says `jira: unknown`, the ledger's step rows are unchanged, the open run is still advanced) |
| Josh was asked only at the named points | `Running.test_josh_is_asked_only_at_the_named_points` (every Needs you record and every `asks` row is for a step in the graph header's `asks_josh`) |
| The whole run is in the ledger | `test_runner_report.Reporting.test_run_report_has_every_step` (every row has an outcome and loop count; role rows have session, tier and model; `build` is `In Progress`) and `test_ended_runs_reach_the_snapshot_for_the_proof_page`; abandoned attempts keep their sessions and reason: `test_an_abandoned_attempt_names_its_sessions_and_why_it_ended`, `test_an_attempt_that_never_started_has_a_reason_and_no_session`, `test_an_unreadable_session_file_does_not_stop_the_report` |
| The binding holds no graph logic | `Running.test_reordering_two_gates_needs_no_runner_change` (two gates swapped in a copy of the graph, run to the end, no runner change, the gate order differs) and `test_runner_code_has_no_graph_logic` (no step, loop or transition logic under `graphs/runner/` or `graphs/bindings/`) |
| A run survives a restart | `test_runner_advance.Advancing.test_restart_does_not_start_a_second_session`, `test_crash_after_spawn_is_adopted_through_the_link`, `test_crash_before_spawn_is_abandoned_after_the_link_timeout`; and `Running.test_run_survives_everything_being_restarted` (every runner module reloaded between ticks, still `finished` with three sessions) |
| A step session cannot ask Josh or write to Jira | `test_graph_step_hooks.Guarding` (ask, Jira and GitHub writes, secrets, the runner's own files, other runs, the caps) and `Running.test_a_step_session_cannot_ask_or_write_to_jira`; `Running.test_the_read_step_is_guarded_as_read_and_the_build_step_is_not` |
| A step that never ends is bounded | `Advancing.test_rested_without_a_result_is_abandoned`, `test_resting_with_no_nudge_uses_first_seen_resting`, `test_an_old_nudge_does_not_use_up_the_rest_wait`, `test_working_again_restarts_the_rest_wait`, `test_time_cap_abandons_after_the_grace`, `test_step_that_keeps_failing_ends_as_the_walker_says` (the walker's run cap stops the run, one notification) |
| A real ticket reaches a pull request (`@laptop`) | not run here: the proof run on the laptop (below) |

Also covered: only one session per step attempt even after a crash (`test_two_advances_never_drive_one_run`, `test_session_limit_holds_across_runs`), the off switch (`test_off_switch_records_but_starts_nothing`, `test_off_switch_does_not_move_a_run_past_an_answered_question`), no rails no session (`test_no_rails_no_session`), a refused spawn retried with the same key (`test_a_refused_spawn_is_retried_with_the_same_key_and_comments`), a pass that never waits for a step (`test_detached_child_does_not_hold_the_pass`), the terminal host's stale-loop notice (`Hosting.test_terminal_host_job_reports_a_stale_loop`), and a report with no ticket, question or answer text in it (`test_report_holds_no_text_from_the_run`).

Suite: `02-check-tail.txt` is the end of `python3 scripts/check.py` for the whole repository on a clean copy of this branch.

## What still needs the laptop

Nothing blocks the merge. After it merges, the laptop installs within about 10 minutes (JP-105), and the plan's Task 13 is the proof run:

1. `python3 laptop/status.py show graph-runner` shows `status: ok`, `rails: true` and `host: job`. If `rails` is false, run `python3 ~/.josh-360/repo/scripts/doctor.py --fix`.
2. `python3 laptop/status.py show jp-117-triage-jp-116` shows the triage run of JP-116 started (no sprint is needed: the start signal is the label `ready-to-run`, Josh 18 November 2026).
3. Josh adds the label `ready-to-run` to JP-116 (his one act); the runner takes it from there, and its report shows the run until it ends.
4. The checks the spec names for the proof run: the first session started in under a minute, the ledger found a transcript for a linked session, the real JQL returns JP-116 once and nothing before, a notification appears for a stopped run, and `AGENT_MANAGER_SESSION_ID` reached a hook.
5. The proof page `docs/proof/phase-1-graphs.md` is then written from the published report (`runner.py report --run <id> --from-json <file>`), the job `jp-117-triage-jp-116` and its script are removed, and the spec's "As built" is finished.

The session named "JP-117 probe - safe to archive" in Agent Manager, left by the removed probe job, can be archived.

## Files

- `01-runner-tests.txt`: one line per test of the runner's modules (`test_runner_runs`, `test_runner_tick`, `test_runner_advance`, `test_runner_report`, `test_graph_step_hooks`, `test_runner_watch`), all `ok`.
- `02-check-tail.txt`: the end of the full `python3 scripts/check.py` run.
