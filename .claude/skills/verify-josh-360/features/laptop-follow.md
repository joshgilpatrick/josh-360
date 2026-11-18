# Laptop follow and jobs

Merging to `main` is the install. Every 5 minutes the job runner runs each due job in `jobs.yaml`; its first job, `follow`, moves the laptop's copy to `main` (fast-forward only), runs the install script, and pushes the result to the `laptop-status` branch, where anyone can read it from the cloud. A pause switch stops following (JP-105).

## Sub-features

- `follow-install` `laptop/install.py` plans five steps, stops with nothing changed on a problem, and is safe to run again.
- `follow-list` `laptop/run_jobs.py --list` shows each job, its interval, whether it is due and its last exit.
- `follow-move` the `follow` job moves the copy to a new `main` and reinstalls.
- `follow-status` the result and each job's report land on `laptop-status`; `laptop/status.py show [<report>]` reads them.
- `follow-pause` `laptop/pause.py on` stops following until `off`.

## How to get to it (user POV)

- Merge a pull request to `main`. Within about 10 minutes the laptop follows it.
- On the laptop: `python3 ~/.josh-360/repo/laptop/install.py --dry-run`, `python3 ~/.josh-360/repo/laptop/run_jobs.py --list`, `python3 ~/.josh-360/repo/laptop/pause.py on|off|status`.
- From the cloud: `python3 laptop/status.py show`, `python3 laptop/status.py show <job>`; push a branch named `laptop-pause` to pause.

## Driving it with sandbox.py

Preconditions:

- A launched sandbox `<id>` whose `doctor` printed `"ok": true`.

- **Install is idempotent.** Run `$S run --run <id> --name install-again -- python3 laptop/install.py --json`. Exit code `0` and a last line `{"result": "passed", "changed": 0, ...}`.
- **Merge to main.** Put a made-up commit on the sandbox's GitHub stand-in. Run `$S advance-main --run <id>`. It prints the new `main` commit.
- **Runner pass.** Run `$S run --run <id> --name run-jobs -- python3 laptop/run_jobs.py`. Exit code `0`; stdout starts `follow: exit 0` and has one `<job>: exit 0` line per due job, with `report pushed` for each reporting job.
- **Copy moved.** Run `$S doctor --run <id>`. `"ok": true` with `"commit"` equal to the new `main`: the copy followed and the install record matches.
- **Status branch.** Run `$S run --run <id> --name status-show -- python3 laptop/status.py show`. `"result": "passed"`, `"commit"` and `"main"` equal to the new commit, and a `reports:` line naming the jobs' reports. Second view: `git -C <run>/origin.git log --oneline laptop-status` lists `report <job>` commits.
- **Job list.** Run `$S run --run <id> --name run-jobs-list -- python3 laptop/run_jobs.py --list`. Every job `not due` with `last exit 0`.
- **Pause.** Run `$S run --run <id> --name pause-on -- python3 laptop/pause.py on`, then `$S advance-main --run <id>` and the runner again. `follow` does not move the copy: `$S doctor` reports the copy behind `main`. Run `laptop/pause.py off` to resume.

## Gotchas

- `run_jobs.py` takes no flags except `--list`. Anything else, `--help` included, runs every due job, and the reporting jobs push to `origin`. Run it only inside the sandbox, whose `origin` is `origin.git`.
- `install.py` (without `--dry-run`), `run_jobs.py` and `follow.py` refuse to run anywhere but `$JOSH360_HOME/repo`. That is why the sandbox clones a copy there.
- A runner pass also runs the one-time jobs (`inventory`, the `retire-*` jobs, `ledger-backfill`). In the sandbox they act on the sandbox `HOME` only; on the laptop they are real.
- Jobs that need Jira, Azure or launchd report `not-configured`, skip or fail quietly in the sandbox; read their report with `status.py show <job>` rather than trusting `exit 0`.
- The sandbox drives committed `HEAD`. A working-tree change you forgot to commit is not in the copy.
