# Plan: the laptop follows josh-360 (JP-105)

## Contents

- [Tasks](#tasks)
- [The two pull requests outside josh-360](#the-two-pull-requests-outside-josh-360)

Spec: `docs/superpowers/specs/2026-11-16-laptop-follows-josh-360-design.md`. No boards (no screen). Built test first, in one cloud session.

## Tasks

1. `laptop/common.py`: paths under `JOSH360_HOME`, the write guard (`Lane`), the git helper, the strict `jobs.yaml` reader. Tests: `tests/test_install.py` (`LaneTest`, `JobsFileTest`).
2. `laptop/install.py`: plan then apply, exit 3 with nothing changed on a problem. Steps: home folders, jobs file, hooks, installed commit. Tests: `tests/test_install.py` (`InstallTest`).
3. `laptop/status.py`: the `laptop-status` commit by plumbing, skip when nothing new, daily heartbeat, `show`. Tests: `tests/test_follow.py`.
4. `laptop/follow.py` and `laptop/pause.py`: pause switch (file or branch), fast-forward only, install, roll back on failure, publish. Tests: `tests/test_follow.py`.
5. `laptop/run_jobs.py` and `jobs.yaml`: due jobs, lock, logs, `once` and `report`. Tests: `tests/test_follow.py`.
6. `hooks/dispatch`: run `hooks/<Event>/*`, exit 2 blocks, fail open, first JSON wins. Tests: `tests/test_hooks.py`.
7. `scripts/check.py`: laptop files, `bash -n`, Python 3.9 parse, run `tests/`. CI's fast step uses `--fast`.
8. Docs: AGENTS.md, README.md, WORKFLOW.md §5, workflow config, decisions, proof under `docs/proof/2026-11-16/JP-105/`.

## The two pull requests outside josh-360

- macbook-automations: `launchd/com.jgilpatrick.josh-360-jobs.plist` (every 5 minutes, at load too), `scripts/josh-360-jobs.sh` (clones josh-360 on branch `main` into `~/.josh-360/repo` the first time, then runs the runner), one line in `launchd/startup-manifest.txt`, a test, and the README and AGENTS.md rows.
- claude-harness: one dispatcher entry per hook event in `settings.example.json`, and `scripts/add-josh-360-hooks.py`, which adds the same entries to the live `~/.claude/settings.json` (backup first, safe to run twice). The live file is not tracked, so Josh runs the script once in his sitting.

Both wait for Josh to merge in his sitting.
