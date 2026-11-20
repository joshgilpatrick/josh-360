# JP-196 proof: the console terminal starts from a job, and the doctor notices when a job says it failed

## Contents

- [What broke](#what-broke)
- [What changed](#what-changed)
- [What was run](#what-was-run)
- [On the laptop](#on-the-laptop)

## What broke

On 20 November Josh's laptop had no `console` terminal. Every five minutes the `console-terminal` job reported `status: unknown`, with the reason "terminal list: exit 1: agent-manager: not inside an Agent Manager session or terminal". `agent-manager terminal list` acts as the caller's own pane, so it refuses a launchd job every time. The doctor still passed `jobs.console-terminal`, because the job exits 0 by design and the doctor read only the exit code.

## What changed

- `scripts/console_terminal_job.py` reads the terminals from `agent-manager snapshot --json`, which runs from a script outside Agent Manager. It keeps only the running ones. If the snapshot cannot be read, the status is still `unknown` and the job opens nothing.
- The doctor's `jobs` checks (`scripts/doctor_lib/install_checks.py`) also read each job's saved report, `state/reports/<id>.json`. If its `status` or `result` is `failed`, `error` or `unknown`, the job's line is a FAIL that names the status and the report's reason. `docs/platform-doctor.md` says so.

## What was run

In a cloud session on 20 November 2026, with the real Agent Manager 0.47.1 (built by `tests/e2e/agent_manager.py install`):

- `tests/test_e2e_console_terminal.py` runs the job as launchd would: no pane, no session id and a job's short PATH. The report says `started`, and the snapshot lists the terminal in group `josh-360`. The console in it writes its heartbeat. The next run, with that heartbeat fresh, says `running`. With the heartbeat gone and the resend window past, the job sends the command to the same terminal again (`restarted`) and opens no second one. No `terminal list` call is made.
- The same test with `main`'s job fails: `'unknown' != 'started'`. That is the laptop's failure.
- By hand, against a running Agent Manager from a plain shell, `main`'s job printed `"status": "unknown", "reason": "terminal list: exit 1: agent-manager: not inside an Agent Manager session or terminal ..."`. This branch's job printed `"status": "started", "terminal": "9a2082af"`, and a run a few seconds later printed `"status": "running"` with a heartbeat 11 seconds old.
- `tests/test_doctor.py`: the case from the laptop (a report saying `unknown` with that reason) is now a FAIL naming `status unknown (terminal list: exit 1 ...`. A `failed` report fails, and an `ok`, `running` or unreadable report passes.
- `python3 scripts/check.py` (the full suite): 0 problems.

## On the laptop

Nothing by hand. After the merge, the next `console-terminal` run opens the `console` terminal in group `josh-360`. JP-185's watch then sees a fresh heartbeat. The next daily doctor run reads job reports. If `ledger-upload` is still failing there, the doctor now shows that job as a FAIL too, which is correct.
