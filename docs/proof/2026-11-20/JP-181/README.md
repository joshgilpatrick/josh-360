# JP-181 proof: ledger-record no longer holds up the five-minute jobs

## Contents

- [What was wrong](#what-was-wrong)
- [Scenarios](#scenarios)
- [Before and after, on made-up data](#before-and-after-on-made-up-data)
- [What still needs the laptop](#what-still-needs-the-laptop)

## What was wrong

`ledger/record.py` saved its progress mark (`~/.josh-360/state/ledger-record.json`) only once the whole run had finished. The job runner kills a job at its timeout, so a run that went past 10 minutes saved nothing, and the next run started from the same place and was killed again. The slow part was Jira: the recorder read each ticket again for every session (two reads with its epic), and once a day it re-read the home of every session from the last 30 days. That once-a-day "done" mark was part of the mark that never got saved, so after the first slow day every run repeated it.

The fix, in `ledger/record.py` and `jobs.yaml`:

- A run stops starting new work after 150 seconds and exits 0; the next run carries on (`--budget` changes the figure).
- The mark is saved after the spool is read, after every session whose mark moved, and at each step of the daily re-home, which keeps its place (`rehome` in the mark) and is marked done only when it has finished.
- Each ticket is read from Jira at most once per run, a failed read included.
- `ledger-record`'s timeout drops from 10 to 4 minutes, as a backstop only, and `graph-runner` now runs straight after it, ahead of `ledger-summary` and the daily jobs.

Choices: `docs/decisions/JP-181.md`.

## Scenarios

Every session, folder and ticket in these runs is made up; nothing calls the real Jira.

| Scenario | Proof | Test |
| --- | --- | --- |
| A slow ledger-record does not delay the graph runner (`@auto`) | `pace-tests-before-fix.txt` (fails on `main`), the suite run on the PR | `tests/test_job_pace.py` `test_a_slow_ledger_record_does_not_delay_the_graph_runner`: the real `jobs.yaml` and the real `run_jobs.one_pass` with a made-up clock, ledger-record wanting 11 minutes; graph-runner begins 245 s into the pass (640 s on `main`). `test_the_daily_jobs_do_not_delay_the_graph_runner_either` adds every daily job running to its own timeout (3915 s on `main`). |
| The recorder keeps its progress and its pace | `before-fix.txt`, `after-fix.txt` | `tests/test_ledger_record_budget.py`: a run stops at its budget and the next carries on; the daily re-home resumes where it stopped and reads no session twice; a run killed part-way keeps what it recorded and does not record a resumed session's stretch twice; one Jira read per ticket per run, a failed one included |
| ledger-record finishes on the laptop (`@e2e`) | owed on the laptop | see below |

## Before and after, on made-up data

`repro.py` builds a throwaway home with 120 quiet made-up sessions, starts a local stand-in for Jira that answers after 0.1 s, and runs `ledger/record.py` four times the way the job runner does, with a 15-second timeout standing in for the job's real one.

`before-fix.txt`, on `main`: every run is cut off (exit 124), the mark is never saved and the daily re-home never finishes, even after every episode is in the ledger.

```text
pass 3: exit 124 after 15.0s | Jira reads 147 | episodes 120 | homes failed 0 | mark saved: False | rehomed: None | (cut off at the timeout)
pass 4: exit 124 after 15.0s | Jira reads 147 | episodes 120 | homes failed 0 | mark saved: False | rehomed: None | (cut off at the timeout)
```

`after-fix.txt`, with the budget scaled to 9 seconds: with 12 tickets the first run finishes in 2.9 s with 24 Jira reads, where `main` needs 480 (two per session, twice). With every session on its own ticket (the per-run memory cannot help), each run stops at its budget, exits 0 and saves its place, and the sixth run finishes the daily re-home.

```text
pass 1: exit 0 after 9.2s | Jira reads 88 | episodes 44 | ... | mark saved: True | rehomed: None | {... "deferred": 1 ...}
pass 6: exit 0 after 3.8s | Jira reads 36 | episodes 120 | ... | mark saved: True | rehomed: 2026-11-20 | {... "deferred": 0 ...}
```

Run it again with `python3 docs/proof/2026-11-20/JP-181/repro.py` (add `--budget 9`, `--tickets 120` after the fix).

## What still needs the laptop

- The cause on the laptop itself: Josh's read-only check (`laptop-check.sh` in the project files, posted in the thread) prints the log tail, the job runner's state, the recorder's mark and the ledger's counts. The JP-181 ticket says what it showed.
- The `@e2e` scenario and the validation watch: about an hour after the merge installs, `python3 laptop/status.py show graph-runner` should show runs about five minutes apart, and the job runner's state should show `ledger-record` last exit 0. The validation run checks both every hour for six hours.
- A run that stopped at its budget writes `stopped at the 150s budget; the next run carries on` to `~/.josh-360/logs/ledger-record.log`. A handful after the install is the catch-up; one on every run for a day would mean the work keeps outgrowing 150 seconds.
