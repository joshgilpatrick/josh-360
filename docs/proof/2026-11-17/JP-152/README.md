# JP-152: platform health check

## Contents

- [Scenarios and proof](#scenarios-and-proof)
- [What still needs the laptop](#what-still-needs-the-laptop)
- [Files](#files)

The doctor is `scripts/doctor.py`; the reference is `docs/platform-doctor.md`. It was built and tested in the cloud on made-up laptops (`tests/doctor_helpers.py`): a temporary home, a git copy of josh-360, a real ledger, and a stand-in for `launchctl`, `az`, `security` and `node`. Nothing real was touched.

## Scenarios and proof

| Scenario | Proof |
| --- | --- |
| A healthy laptop passes | `01-doctor-tests.txt`: `HealthyLaptop.test_a_healthy_laptop_passes` (every check pass or skip, exit 0), `test_every_group_the_ticket_names_is_checked`, `test_every_job_in_jobs_yaml_has_its_own_line` |
| A missing part fails with one fix step | `MissingParts.test_a_hook_missing_from_settings_fails_with_one_fix`, and 25 more cases for a missing or broken part (hooks, copy behind main, paused, jobs, ledger, triggers, backups, Atlas, Azure, Jira, graphs); `02-example-run-broken-laptop.txt` is a real report |
| The doctor changes nothing by default | `ReadOnly.test_the_doctor_changes_nothing_by_default` (every file and folder, size and time, before and after, including with `--online`), `test_nothing_is_written_even_into_the_git_copy`, `test_fix_dry_run_changes_nothing_and_says_what_it_would_do`, `Databases.test_a_missing_ledger_fails_and_is_fixable` (the doctor never creates a ledger) |
| --fix only does safe reversible things | `Fixes.test_fix_does_only_the_safe_reversible_things` (only the install and the hook entries; the Azure settings, `az login` and launchd are left alone; a backup of `settings.json` is kept), `test_fix_never_removes_a_pause_or_runs_an_install_while_paused`, `test_fix_leaves_a_failing_unfixable_check_failing`, `test_the_jira_email_is_written_only_when_given_and_valid` |
| An agent can read the result | `AgentOutput.test_json_has_status_fix_and_name_for_every_check`, `test_no_secret_reaches_the_output`; the daily job's report on `laptop-status`: `DoctorJob` tests |
| Josh runs it on the real laptop (`@manual`) | below |

Suite: `python3 scripts/check.py` passes (the whole suite, with 58 new tests for this ticket).

## What still needs the laptop

Nothing blocks the merge. After it merges (the laptop installs within about 10 minutes, JP-105):

1. On the laptop, run `python3 ~/.josh-360/repo/scripts/doctor.py` (or `/doctor` in Claude Code). Expect some `FAIL` and `WARN` lines the first time: they are the real gaps (for example the Azure container, `az login` and the Jira email that JP-107 and JP-150 left to Josh). Each has its fix step.
2. `python3 ~/.josh-360/repo/scripts/doctor.py --fix` does the safe ones.
3. The next daily run publishes `reports/doctor.json`; read it from the cloud with `python3 laptop/status.py show doctor`.

## Files

- `01-doctor-tests.txt`: the doctor's tests, one line each.
- `02-example-run-broken-laptop.txt`: the report for a made-up laptop with four problems.
