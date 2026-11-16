# The laptop follows josh-360 (JP-105)

## Contents

- [What it does](#what-it-does)
- [Where things live on the laptop](#where-things-live-on-the-laptop)
- [The parts](#the-parts)
- [Rules](#rules)
- [Acceptance criteria](#acceptance-criteria)
- [Out of scope](#out-of-scope)
- [As built](#as-built)

There is no screen, so there are no boards.

## What it does

After one sitting, every change merged to `main` in josh-360 reaches Josh's work laptop on its own:

1. The login job in macbook-automations (`com.jgilpatrick.startup`) loads one more job, `com.jgilpatrick.josh-360-jobs`. It runs every 5 minutes.
2. That job runs `laptop/run_jobs.py` from the laptop's copy of josh-360. The runner reads `jobs.yaml` and runs every job that is due.
3. The first job, `follow`, runs every 10 minutes. It fetches `main`, moves the laptop's copy to it, runs the install script, and pushes a short status to the `laptop-status` branch.
4. Claude Code runs one small dispatcher for each hook event, `hooks/dispatch <Event>`, from the laptop's copy. The dispatcher runs every executable file in `hooks/<Event>/`. A new hook is a new file in josh-360, so the harness never changes again.

## Where things live on the laptop

Everything Josh 360 owns sits under one folder, `~/.josh-360/` (`JOSH360_HOME` overrides it, which the tests use):

| Path | What it holds |
| --- | --- |
| `~/.josh-360/repo/` | The laptop's copy of josh-360. Only the `follow` job changes it. |
| `~/.josh-360/state/` | What is installed, when each job last ran, the runner's lock. |
| `~/.josh-360/logs/` | One log per job, and the hook dispatcher's log. No file contents and no patient data. |
| `~/.josh-360/PAUSED` | The pause switch. While the file exists, the laptop does not follow. |

A cloud session can pause the laptop too: while a branch named `laptop-pause` exists on GitHub, `follow` does not install. Deleting that branch, or the file, resumes it.

## The parts

| Part | File | Job |
| --- | --- | --- |
| Jobs file | `jobs.yaml` | The list of Josh 360's background jobs: `id`, `run` (a Python file in the repo), `every` (`5m`, `1h`, `1d`, or `once`), optional `timeout` and `report`. |
| Runner | `laptop/run_jobs.py` | Called by launchd every 5 minutes. Takes a lock, reads `jobs.yaml`, runs each due job, records when it ran. A job with `report: true` must print JSON; the runner puts it on the status branch as `reports/<id>.json`. |
| Follow job | `laptop/follow.py` | Checks the pause switch, fetches `main`, moves the copy forward (fast-forward only), runs the install script, publishes the status. |
| Install script | `laptop/install.py` | Plans every step first, and changes nothing if any step meets something unexpected. Then applies the steps and prints what changed. Steps today: the home folders, a check of `jobs.yaml`, a check of `hooks/`, and the record of the installed commit. Later tickets add their own steps (for example the ledger database). |
| Status | `laptop/status.py` | Builds the commit for `laptop-status` with git plumbing (no checkout, no working tree), and pushes it. It skips the push when only the time or the counts changed (a repeat run of the same install), unless the last push is a day old. |
| Pause | `laptop/pause.py` | `on`, `off` or `status` for the local switch. |
| Hook dispatcher | `hooks/dispatch` | Bash, so an empty event costs a few milliseconds. |

The status file, `status.json`, holds only: the schema number, the installed commit, the commit on `main`, the time (UTC), the result (`passed`, `failed` or `paused`), a short reason written by the code, and counts (`changed`, `unchanged`, `problems`). It never holds file contents.

## Rules

- The install script writes only inside `~/.josh-360/`. Every write goes through one guard that refuses any other path.
- The install script runs in two passes: plan, then apply. Any problem in the plan stops it with exit code 3 and nothing changed.
- Running the install script twice reports `changed: 0` the second time.
- `follow` only fast-forwards. Local changes in the laptop's copy, or a `main` that is not ahead of it, stop the job and are reported as `failed`.
- The status commit is made with a fixed author, no signing and no hooks, so Josh's own git settings cannot break it under launchd.
- The hook dispatcher fails open: a hook that crashes is logged and skipped. A hook that exits 2 (Claude Code's "block") passes its message and exit code through. When several hooks print JSON for one event, the first one wins and the others are logged.
- All Python runs on the laptop's `/usr/bin/python3` (3.9), with the standard library only. `scripts/check.py` checks the syntax against Python 3.9.

## Acceptance criteria

```gherkin
Feature: The laptop follows josh-360

  @e2e
  Scenario: A merge reaches the laptop on its own
    Given a change merged to the default branch of josh-360
    When the laptop job next runs
    Then the change is installed
    And nobody ran anything by hand

  @auto
  Scenario: The install script stays in its lane
    Given the install script
    When it runs
    Then it changes nothing outside Josh 360's own files, database and jobs

  @auto
  Scenario: Running it twice is safe
    Given an install that has just finished
    When the install script runs again
    Then it reports no changes

  @auto
  Scenario: A cloud session can see the result
    Given an install has run
    When the status branch is read
    Then it shows the commit, the time and whether the install passed
    And it holds no file contents

  @auto
  Scenario: Josh can pause it
    Given the pause switch is set
    When a change is merged
    Then the laptop does not install it
```

The `@e2e` scenario runs in the cloud against a made-up origin and a made-up laptop home (`tests/test_follow.py`), and again for real in Josh's sitting, where the first install appears on `laptop-status`.

## Out of scope

- Any other job, and switching anything off.
- The inventory script (JP-96). It is added to `jobs.yaml` as a `once` job with `report: true` when it is ready.
- Anything outside `~/.josh-360/` and the `laptop-status` branch.

## As built

Nothing differs from this design yet.
