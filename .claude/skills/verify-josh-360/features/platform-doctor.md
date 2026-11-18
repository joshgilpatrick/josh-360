# Platform doctor

The platform doctor answers "is Josh 360 working on this laptop?" with one line per check and the one step that fixes each problem. It is read-only unless asked to fix, its `--fix` does only safe, reversible fixes, and the laptop runs it daily so its report can be read from the cloud (JP-152).

## Sub-features

- `doctor-text` the text report groups checks and ends with a summary line and an exit code.
- `doctor-json` `--json` prints one document with `summary`, `checks[]` (`id`, `group`, `status`, `detail`, `fix`, `auto_fix`) and `manual`.
- `doctor-only` `--only <group>` runs one group.
- `doctor-fix-dry` `--fix --dry-run` says what it would do and changes nothing.
- `doctor-fix-hooks` `--fix` registers the hook dispatcher in `~/.claude/settings.json` through claude-harness's `add-josh-360-hooks.py`, after a backup.
- `doctor-daily` the `doctor` job puts the report on `laptop-status`, read with `laptop/status.py show doctor`.

## How to get to it (user POV)

- On the laptop: `python3 ~/.josh-360/repo/scripts/doctor.py` (add `--json`, `--online`, `--fix`, `--dry-run`, `--only <group>`, `--strict`, `--no-manual`), or `/doctor` in a Claude Code session.
- From the cloud: `python3 laptop/status.py show doctor` in any clone.

## Driving it with sandbox.py

Preconditions:

- A launched sandbox `<id>` whose `doctor` printed `"ok": true`, and whose `launch` output named a `harness_hooks_script` (claude-harness was found).

- **Text report.** Run `$S run --run <id> --name doctor-text -- python3 scripts/doctor.py --no-manual`. Groups `INSTALL AND FOLLOW`, `BACKGROUND JOBS`, `CLAUDE CODE HOOKS`, `DATABASES`, `SIGNS OF REAL USE`, `SERVICES`, `ACCOUNTS AND TOOLS`, `GRAPHS AND WALKER` and `DATES OWED`, a final `Summary: N pass, ...` line, exit code `1` (a fresh sandbox has failures, such as `install.follow-ran`).
- **JSON report.** Run `$S run --run <id> --name doctor-json -- python3 scripts/doctor.py --json --only hooks`. `checks[]` with `hooks.settings` `pass` (the empty settings file exists), `hooks.files` `pass`, and `hooks.dispatch-SessionStart` and `hooks.ledger-spool` `fail`: no dispatcher entry yet.
- **Dry run.** Run `$S run --run <id> --name doctor-fix-dry -- python3 scripts/doctor.py --fix --dry-run --no-manual`. Under `FIXES`, `would-run  hooks  -B .../add-josh-360-hooks.py --settings .../settings.json (it backs settings.json up first)`. `<run>/home/.claude/settings.json` is still `{}`.
- **Fix.** Run `$S run --run <id> --name doctor-fix -- python3 scripts/doctor.py --fix --no-manual`. Under `FIXES`, `fixed hooks wrote .../settings.json (backup: .../settings.json.bak-josh-360)`.
- **Second view.** Run `$S run --run <id> --name doctor-after-fix -- python3 scripts/doctor.py --json --only hooks`. Every `hooks.dispatch-<Event>` check and `hooks.ledger-spool`, `hooks.ticket-offer`, `hooks.ticket-comments`, `hooks.atlas-guard`, `hooks.graph-step` are `pass`; `<run>/home/.claude/settings.json.bak-josh-360` exists.
- **Daily report.** Run the runner once (`$S run --run <id> --name run-jobs -- python3 laptop/run_jobs.py`), then `$S run --run <id> --name doctor-daily -- python3 laptop/status.py show doctor`. The same JSON fields, read from the sandbox's `laptop-status` branch.

## Gotchas

- The doctor checks the laptop it runs on. In a cloud clone outside the sandbox nearly every check fails; only the sandbox (or the laptop) gives a meaningful report.
- `--fix` for hooks needs `~/.claude/scripts/add-josh-360-hooks.py` from claude-harness and an existing `settings.json`. Without the script it says `skipped`; without the file it says `failed ... not found`.
- `install.follow-ran`, `accounts.jira-email` and the `jobs.*` "has not run yet" lines fail or warn in a fresh sandbox by design. Run `laptop/run_jobs.py` to clear the job lines.
- Checks that need a Mac (launchd, the Atlas service) are `skip` off a Mac, which is not a problem.
- Never paste doctor output into a ticket without reading it first. It holds names, counts and paths only, by design.
