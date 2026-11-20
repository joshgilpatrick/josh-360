# JP-186 proof: the real Agent Manager in the cloud

## Contents

- [What was run](#what-was-run)
- [Scenario to proof](#scenario-to-proof)

## What was run

In a cloud session on 20 November 2026: Agent Manager 0.47.1 (the laptop's version), built with `go install`, tmux 3.4, and the stand-in `claude` from `tests/e2e/standin/`. No model was called. `scripts/check.py` (the full suite, with Agent Manager installed, so the real-Agent-Manager tests ran rather than skipped) passed with 0 problems.

- [`01-tests.txt`](01-tests.txt): `install` (already built, so it only checks the version) and all 26 tests in `test_e2e_*.py` with `JOSH360_E2E_AM=1`: 6 against the real Agent Manager, 20 on the stand-in alone.
- [`02-not-installed.txt`](02-not-installed.txt): with no Agent Manager in the cache folder the 6 real-Agent-Manager tests skip with the install command as the reason, and with `JOSH360_E2E_AM=1` they fail instead.

## Scenario to proof

| Scenario (`@auto`) | Test |
| --- | --- |
| A step session runs and rests | `tests/test_e2e_agent_manager.py`: `StepSession.test_state_reads_working_then_resting_within_30_seconds` (binding.state goes working, then resting, and the database shows the stand-in's hooks moving it to `working` and then `finished`); `StepSession.test_move_and_close_change_the_group_and_archived_flag` |
| A model Agent Manager does not list is refused | `RefusedModel.test_empty_models_map_is_refused_with_agent_managers_message` (with `"models": {}` the spawn is refused and Agent Manager's own message reads `model "claude-sonnet-5-5" is not one claude lists; it lists default, opus, fable, sonnet, haiku`); also `RefusedModel.test_an_effort_the_model_does_not_take_is_refused` |
| The rails see the stand-in's hooks | `Rails.test_the_session_gets_a_graph_sessions_entry_linking_it_to_its_run` (the checkout's `hooks/dispatch` in the sandbox's Claude settings links the session to its run, with Agent Manager's session id, though Agent Manager's own note comes before the marker) |
| The manager is not running | `ManagerDown.test_status_stays_starting_and_the_harness_says_why` (the status stays `starting`; `wait_status` raises `ManagerNotRunning` and `check` reports it) |

The stand-in's own behaviour (the model probe, hook order and payloads from both settings files, every kind of blocking hook, each scenario) is in `tests/test_e2e_standin.py`.
