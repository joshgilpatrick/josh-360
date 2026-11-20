# JP-183 proof: retries and run caps are spent only on failures that could change

## Contents

- [Result](#result)
- [The three kinds](#the-three-kinds)
- [Every place that retries or counts](#every-place-that-retries-or-counts)
- [Scenarios and the tests that prove them](#scenarios-and-the-tests-that-prove-them)
- [Laptop check owed after the merge](#laptop-check-owed-after-the-merge)
- [Choices made while building](#choices-made-while-building)

## Result

Every failure in the graph runner's spawns, the walker's run count and the laptop's once jobs is now sorted into one of three kinds, from one table (`laptop/failure_kinds.py`). Only a failure where a model ran uses a run of the cap. A failure that won't fix itself stops the run at once, names the fix, and carries on by itself once the fix is merged (or with `runner.py resume --run <id>`), with no `allow`. A failure that may clear is tried again with growing gaps and ends as stuck, still with no run used. The real Agent Manager reason reaches `runner.log`, at most 200 characters and screened for patient data. Doctor's new check `graphs.tier-models` catches a tier model or effort Agent Manager does not accept before any run.

The JP-116 case (a tier model Agent Manager refused) is the first test: it now stops after one try and uses no run, where before it spent three tries and a run of the cap.

All the proof here ran in the cloud, on made-up runs and the fake Agent Manager (`tests/fakes/agent-manager`). The one check that needs the laptop is listed below.

## The three kinds

| Kind | Code word | What happens | Uses a run of the cap |
| --- | --- | --- | --- |
| Won't fix itself | `needs-fix` | Stops at once and names the fix. Carries on by itself when what the spawn depended on changes (the binding's settings, the run's compiled graph, the laptop copy's commit), or with `runner.py resume --run <id>` | No |
| Might fix itself | `may-clear` | Tried again in the same attempt after 5, 15, 30 and 60 minutes; after 5 tries the run stops as stuck, and resumes the same two ways | No |
| The model ran and the step failed | `ran` | Abandoned, as before | Yes |

A failure the runner cannot sort is `may-clear`. The full list of codes is `REASONS` in `laptop/failure_kinds.py`; the readable version is in `graphs/CONVENTION.md`, "The run cap".

## Every place that retries or counts

| Place | Before | Now |
| --- | --- | --- |
| Runner spawn refused (`graphs/runner/runner_lib/advance.py`, `_spawn`) | 3 tries, then the attempt was abandoned and used a run | Sorted by the binding's `classify`: `needs-fix` stops at once; `may-clear` is tried 5 times with gaps, then stuck; neither ends the attempt |
| Agent Manager's message (`graphs/bindings/agent-manager/binding.py`) | A single "refused" code; the message was dropped | `SpawnRefused(code, detail)`; codes `no-cli`, `bad-model`, `bad-effort`, `no-folder`, `not-running`, `rate-limited`, `network`, `timeout`, `refused`; a bad model stops instead of trying every tier entry |
| Session never linked, or gone before it linked (`_started`) | Abandoned, used a run | `may-clear`: tried again in the same attempt with a new key; the old session is kept in the session file's `earlier` |
| Session gone after it linked, time cap, bad result, rested without a result | Abandoned, used a run | Unchanged: `ran` |
| Walker's run count (`graphs/tools/walker_lib/engine.py`) | A run counts when a step starts | Unchanged. The runner never ends an attempt for `needs-fix` or `may-clear`; it stops the run with the new walker command `stop`, which leaves the attempt open, and resume reuses it |
| Gate steps | A failed gate stops the run, with no retry and no cap | Unchanged |
| Laptop `every: once` jobs (`laptop/run_jobs.py`) | Retried hourly forever | A job that exits 78 after a `needs-fix:` line, or fails on an import or syntax error, waits until the laptop copy, its `jobs.yaml` entry or its script changes, or `run_jobs.py --resume <id>`; other failures still retry hourly |
| Laptop jobs with a period (`every: 10m` and so on) | Run on their period | Unchanged: the period is not a retry budget |
| Doctor (`scripts/doctor_lib/`) | Did not see either case | `backfills.<job>` names a once job that needs a fix and how to resume it; `graphs.tier-models` checks every tier entry, after the binding's `models` map, against `accepts` in `binding.json` |

## Scenarios and the tests that prove them

Run with `python3 scripts/check.py` (the `suite` check). Test files: `tests/test_runner_failure_kinds.py` and `tests/test_once_jobs_and_tier_models.py`.

| Scenario | Test |
| --- | --- |
| @auto A bad model stops after one try and uses no run | `FailureKinds.test_a_bad_model_name_stops_the_run_after_one_try_and_uses_no_run` |
| @auto After the fix the run carries on without an allow | `FailureKinds.test_after_the_fix_the_run_carries_on_without_an_allow`, `test_resume_by_hand_works_when_nothing_the_runner_sees_changed` |
| @auto Agent Manager not running is retried with growing gaps, never uses the cap, and ends stuck | `FailureKinds.test_agent_manager_not_running_is_retried_and_never_uses_the_cap` |
| @auto An unexplained refusal is kind 2 | `FailureKinds.test_a_refusal_the_runner_cannot_sort_is_one_that_might_fix_itself` |
| @auto A model that ran and failed still counts | `FailureKinds.test_a_step_whose_model_ran_and_failed_still_counts` |
| @auto The real reason reaches the log | `FailureKinds.test_the_real_reason_reaches_the_log`, `test_a_message_with_patient_data_is_held_back` |
| @auto A once job that can never succeed stops retrying, and doctor names it | `OnceJobs.test_a_once_job_that_can_never_succeed_stops_retrying`, `DoctorNamesIt.test_doctor_names_a_once_job_that_needs_a_fix` |
| @auto Doctor catches a bad tier model before any run | `DoctorNamesIt.test_doctor_catches_a_bad_tier_model_before_any_run`, `test_doctor_catches_a_bad_effort` |
| @manual The JP-116 case on the laptop | Owed: below |

Also covered: a missing work folder, a session that ended before it linked, the report and `where` showing the kind, every binding code having a kind, and only `ran` counting.

## Laptop check owed after the merge

Once the merge reaches the laptop (the `follow` job installs it within about five minutes):

1. Run `python3 ~/.josh-360/repo/scripts/doctor.py --only graphs`. `graphs.tier-models` should pass. If it fails, it names the tier and model to fix in `graphs/tiers.yaml`.
2. Run `python3 ~/.josh-360/repo/laptop/run_jobs.py --list`. No once job should say `needs fix`; one that does is also named by doctor with its fix.
3. The JP-116 case: start a run whose tier names a model Agent Manager refuses (for example, a test copy of a tier with a made-up model name). Expect one spawn try, then `~/.josh-360/logs/runner.log` naming `bad-model` and Agent Manager's own words, and `runner.py where JP-116` saying the run needs a fix. `runner.py report --run <id>` should show no attempt used.
4. Put the model right and either wait for the next pass (the change is seen) or run `python3 ~/.josh-360/repo/graphs/runner/runner.py resume --run <id>`. Expect the step to start in the same attempt, with no `allow`.

Write the result as a comment on JP-183: `result | evidence | next gate`.

## Choices made while building

Nine choices, each with how to undo it: `docs/decisions/JP-183.md`. The main one: a run stopped for a fix carries on both ways, by itself once its inputs change and by `runner.py resume`.
