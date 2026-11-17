# JP-119 proof: start every Josh 360 background job from the one startup list

## Contents

- [Scenarios](#scenarios)
- [What was switched off](#what-was-switched-off)
- [What waits for the phase 1 close](#what-waits-for-the-phase-1-close)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every test uses a made-up home folder, a made-up macbook-automations checkout and a fake `launchctl`. Nothing touches the real launchd.

| Scenario | Proof | Test |
| --- | --- | --- |
| Every Josh 360 job is on the list | `01-scenario-tests.txt`, `02-check-demo.txt` | `CheckJobsTest.test_every_running_josh_360_job_is_on_the_list`, `test_a_josh_360_job_that_is_not_on_the_list_is_reported`, `test_once_the_atlas_service_is_on_the_list_it_is_no_gap`; the register check `RegisterTest.test_every_job_in_the_laptop_inventory_is_accounted_for` (every job label in the JP-96 inventory is on the list or named with a reason) |
| A stray job is reported | `02-check-demo.txt` | `CheckJobsTest.test_a_stray_job_is_printed`, `test_a_loaded_job_with_no_plist_under_josh_s_names_is_a_stray_but_a_vendor_job_is_not`, `test_a_retired_job_that_is_still_loaded_or_installed_is_reported`; unknown is not clean: `test_an_unreadable_launchctl_is_unknown_not_clean`, `test_a_missing_startup_list_is_unknown_and_no_stray_is_guessed` |
| Josh 360 has no installers of its own | `01-scenario-tests.txt` | `NoInstallersTest`: no plist file in the repository; only `scripts/atlas_service.py` writes one, and it is the one `transitional` row in the register (the tracked exception, see below); every file that touches `~/Library/LaunchAgents` is named with a reason; jobs start only as `jobs.yaml` entries |
| Switching off can be undone | `03-retire-and-restore-made-up-home.txt` | `RetireLeftoverJobsTest.test_restoring_a_job_that_was_loaded_puts_everything_back_and_loads_it` (the plist comes back byte for byte, Omnara's folder comes back, the job is loaded again), `test_restoring_a_job_that_was_not_loaded_does_not_load_it`, `test_restore_refuses_when_something_is_already_in_the_way` |
| The suite still passes | `04-suite.txt` | `python3 scripts/check.py` |

## What was switched off

The JP-96 inventory marked nine jobs "dismantle". The laptop run showed six already gone and one switched off by JP-100 (the focus dashboard). JP-111's retirement of the old Atlas is a one-time job that is still waiting on the ledger backfill. That leaves three that JP-119 switches off, as one reversible job, `retire-leftover-jobs`: the QA waker watchdog, the ClickUp to Notion sync (never loaded) and Omnara (Josh retired it at the JP-106 sitting). Each job's plist, and Omnara's `~/.omnara/` folder (a rename, never a copy and delete), moves to `~/Archive/josh-360-retired/<date>/<name>/` with a `retired.json` and a README. `python3 scripts/restore_retired_job.py <folder>` puts it back. Nothing is deleted; four rows went on `docs/phase-1-deletion-list.md`.

The sprint waker stays until the development graph replaces the sprint skill (JP-115, JP-128). Everything else that runs beside the list is named in `laptop/launchd-register.json` with a reason: action-triage's jobs (phase 2, out of scope), the Athena and Azure work jobs, Outlook's watchdog, PostgreSQL, twg.

## What waits for the phase 1 close

One scenario is met with a stated exception. The Session Atlas service is a long-running process, so launchd has to own it, and `scripts/atlas_service.py` writes that plist today. Moving its definition onto the startup list changes macbook-automations, which waits for the phase 1 close, and switching the installer off first would leave Atlas down, which blocks every worktree removal (the guard fails closed). So it stays as the single, named, tested exception, and `laptop/check_jobs.py` prints it as a known gap. The two steps that finish the job, with the files to add to macbook-automations, are in `docs/phase-1-close-checklist.md`. The skill sync (`com.jgilpatrick.sync-client-skills`) is marked `bring-in-at-close` in the register for the same reason.

## What still needs the laptop

Nothing needs Josh. After the merge the laptop installs the change within about 10 minutes. Read the result with `python3 laptop/status.py show`, then:

1. `reports/retire-leftover-jobs.json` on `laptop-status` should say `result: ok`.
2. `reports/launchd-check.json` lists what the laptop runs that is not on the list. Expect `retired but present` for `com.eventus.claude-atlas` until `retire-session-atlas` has run, and the Atlas service as a known gap. Anything labelled `stray` is a job nobody has accounted for: put it on the list, name it in the register with a reason, or retire it.
