# Laptop

How Josh's work laptop follows josh-360 (JP-105). The design is in `docs/superpowers/specs/2026-11-16-laptop-follows-josh-360-design.md`.

## Contents

- [The chain](#the-chain)
- [Files](#files)
- [Commands](#commands)
- [Reading the status from the cloud](#reading-the-status-from-the-cloud)

## The chain

1. The macbook-automations login job loads `com.jgilpatrick.josh-360-jobs`, which runs `run_jobs.py` from `~/.josh-360/repo` every 5 minutes. On first run it clones josh-360 there.
2. `run_jobs.py` reads `jobs.yaml` at the repo root and runs each due job.
3. The first job, `follow`, moves the copy to `main` (fast-forward only), runs `install.py`, and pushes the result to the `laptop-status` branch.

Everything Josh 360 keeps on the laptop is under `~/.josh-360/`: `repo/`, `state/`, `logs/` and the pause switch `PAUSED`.

## Files

| File | What it does |
| --- | --- |
| `common.py` | Paths, the write guard (nothing outside `~/.josh-360/`), git helper, the `jobs.yaml` reader. |
| `install.py` | The install script: plan every step, stop with nothing changed on a problem, otherwise apply and print what changed. Later tickets add steps to `STEPS`. |
| `run_jobs.py` | The job runner. |
| `follow.py` | The `follow` job. |
| `status.py` | Writes the `laptop-status` branch; `show` reads it. |
| `pause.py` | The local pause switch. |
| `check_jobs.py` | JP-119: compares what launchd runs with the macbook-automations startup list and prints each difference. |
| `launchd-register.json` | JP-119: what may run beside the startup list, and why (managed by another project, retired, or waiting to move onto the list). |

## Commands

On the laptop:

- `python3 ~/.josh-360/repo/laptop/install.py --dry-run` shows what an install would change.
- `python3 ~/.josh-360/repo/laptop/run_jobs.py --list` shows each job and whether it is due.
- `python3 ~/.josh-360/repo/laptop/pause.py on` (or `off`, `status`) pauses following.
- `python3 ~/.josh-360/repo/laptop/check_jobs.py` prints any job that runs but is not on the startup list or in the register (`--json` for the report; exit 1 on a difference, 2 when launchd or the list could not be read).
- Logs: `~/.josh-360/logs/<job>.log` and `~/.josh-360/logs/hooks.log`.

## Reading the status from the cloud

From any clone of josh-360: `python3 laptop/status.py show`. It prints `status.json` from the `laptop-status` branch: the installed commit, `main` at the time, the time (UTC), `passed`, `failed` or `paused`, a short reason and the counts, plus the names of any reports. To pause from the cloud, push a branch named `laptop-pause`; delete it to resume.

`python3 laptop/status.py show <job>` prints one job's report, for example `show doctor` for the daily platform health check (JP-152, `docs/platform-doctor.md`).
