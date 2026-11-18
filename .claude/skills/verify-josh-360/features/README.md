# Josh 360 verification map

This folder is the maintained source for proving Josh 360's user-facing features. Read this index before driving anything, then use the matching feature file as the recipe. The harness is `scripts/sandbox.py` in the skill folder (`../SKILL.md`).

## Contents

- [Baseline preconditions](#baseline-preconditions)
- [Driving conventions](#driving-conventions)
- [Proof and skip reporting](#proof-and-skip-reporting)
- [Feature entry contract](#feature-entry-contract)
- [Features](#features)
- [Not mapped yet](#not-mapped-yet)

## Baseline preconditions

- Run from the root of a josh-360 checkout with `S=.claude/skills/verify-josh-360/scripts/sandbox.py` and `pip install -r requirements.txt` done.
- The change under test is committed. The sandbox drives committed `HEAD`.
- One sandbox per run: `$S launch --run <run-id> --evidence docs/proof/<YYYY-MM-DD>/<KEY>/verify-josh-360` printed `"ok": true`.
- `$S doctor --run <run-id>` printed `"ok": true`: the copy's origin is the sandbox's `origin.git`, the copy is at the sandbox's `main`, and the install, ledger and graph checks pass.
- Never drive the real `~/.josh-360/repo`, and never run `laptop/run_jobs.py` from a clone whose `origin` is GitHub.

## Driving conventions

- Start every recipe from a fresh sandbox unless its preconditions say otherwise. Recipes may share one sandbox when run in the order listed.
- Run josh-360 commands with `$S run --run <id> --name <step> -- <command>`. Its working folder is the sandbox copy, so paths like `ledger/ask.py` are relative to it.
- Fire hooks with `$S hook`, never by running a hook file directly: the user path is Claude Code calling `hooks/dispatch <Event>`.
- Assert on JSON keys, exit codes and stored rows, never on wording.
- Use made-up data only: `$S seed-session` sessions, `JP-9001`-style keys, the `family_os` repository for a personal route. No patient data, and no real transcript.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final output.
- Every saved step is one JSON file in the evidence folder with the command, stdout, stderr and exit code (and the stdin of a hook).
- A stored result needs a read-only second view: `$S ledger` for rows, `git -C <run>/origin.git log` for a pushed branch, a file listing for a written file.
- Record the feature file and the entry point used in the proof's `README.md`.
- A path the cloud cannot reach (Jira, Azure, launchd, a model call) is reported as "laptop only" with the command to run there, never as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the behaviour Josh sees. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behaviour.
2. `How to get to it (user POV)` lists every entry point.
3. `Driving it with sandbox.py` starts with `Preconditions:` and uses labelled bullets that pair each user action with an exact command and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Session ledger](./session-ledger.md) covers the session hooks writing the spool, the recorder writing sessions and episodes, and the read command finding them. Proved on 18 November 2026 (`docs/proof/2026-11-18/JP-158/`).
- [Ticket offer](./ticket-offer.md) covers the one-line offer at a session's first commit with no ticket, once per session, and its record in the ledger.
- [Graph walker](./graph-walker.md) covers starting a ticket creation run from intake, playing a role step, the walker running a gate and ending the run, and the run's record in the ledger.
- [Platform doctor](./platform-doctor.md) covers the health check in text and JSON, the safe `--fix` that registers the hook dispatcher, and reading the daily report from the cloud.
- [Laptop follow and jobs](./laptop-follow.md) covers the job runner, the `follow` job moving the copy to a new `main` and reinstalling, the `laptop-status` branch, and the pause switch.

## Not mapped yet

Each of these is a user-facing feature with no recipe yet. Add a file here when one is needed, in the shape above. Where it runs is in brackets.

- Ticket comments to working sessions (JP-118): the `ticket-comments` job and the `40-ticket-comments` hooks. Needs Jira reads [laptop; the hook half runs in the sandbox].
- Session summaries and debriefs (JP-108, JP-113): the `ledger-summary` job. Thin episodes make one cheap model call [laptop].
- Friction facts and measures (JP-112): written by the recorder; `ledger/measures.py` [sandbox].
- Loose ends and closeout (JP-109): `ledger/loose_ends.py`, `ledger/closeout.py`, `/closeout`. Reads GitHub and Jira live [laptop; `--json` without `--fetch` runs in the sandbox].
- Graph runner (JP-117): the `graph-runner` job, `graphs/runner/runner.py`, the Agent Manager binding and the `20-graph-step*` hooks. Needs Jira and Agent Manager [laptop].
- The triage, development and non-development graphs (JP-122, JP-115, JP-123): their entry gates read Jira [laptop; whole runs are automated in `tests/test_triage_run.py`, `tests/test_nondev_graph_run.py` and `graphs/tests/`].
- Ledger backup and Azure copy (JP-107, JP-150): the `ledger-backup` and `ledger-upload` jobs [backup in the sandbox; upload on the laptop after `az login`].
- Session Atlas (JP-111): the headless service, the worktree removal guard hook and the cost import in `apps/session-atlas` [laptop; `npm test` in that folder].
- Startup list check and retired jobs (JP-119): `laptop/check_jobs.py`, `scripts/restore_retired_job.py` [laptop, needs launchd].
- Conventions lookup and decisions (JP-98, JP-153): `scripts/conventions.py lookup`, `scripts/decisions.py list` [any clone].
- Feature tree and architecture page builds (JP-143, JP-144): `scripts/feature_tree.py`, `scripts/architecture_page.py` [any clone].
