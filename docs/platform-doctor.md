# Platform doctor

## Contents

- [What it is](#what-it-is)
- [Running it](#running-it)
- [What it checks](#what-it-checks)
- [What --fix does](#what---fix-does)
- [What only Josh can check](#what-only-josh-can-check)
- [Reading it from the cloud](#reading-it-from-the-cloud)
- [Adding a check](#adding-a-check)

## What it is

One read-only command that confirms every part of Josh 360 is present and configured on the work laptop (JP-152). Josh built the platform in cloud sessions, so only the laptop knows what is actually live. The doctor prints one line per check (`PASS`, `WARN`, `FAIL` or `SKIP`), and a `FAIL` or `WARN` line is followed by the one step that fixes it. It exits 1 when any check fails (with `--strict`, when any warns).

It reads only. It opens databases read-only, asks the keychain whether the Jira item exists without reading it, and prints no token, email address, session text or row. It has counts, names and paths. Code: `scripts/doctor.py`, `scripts/doctor_lib/`. Python 3.9, standard library only.

## Running it

On the laptop:

```
python3 ~/.josh-360/repo/scripts/doctor.py              # the report
python3 ~/.josh-360/repo/scripts/doctor.py --json       # one JSON document, for an agent
python3 ~/.josh-360/repo/scripts/doctor.py --online     # also ask GitHub (main, pause branch) and Jira (do the credentials work)
python3 ~/.josh-360/repo/scripts/doctor.py --only hooks # one group
python3 ~/.josh-360/repo/scripts/doctor.py --fix --dry-run   # what --fix would do
```

In a Claude Code session on the laptop, `/doctor` runs it and reports in plain words (skill `platform-doctor`). Run it from `~/.josh-360/repo`: from another clone it says so, and reads the laptop's copy for file checks.

Exit codes: 0 nothing failed, 1 something failed, 2 the command was misused. The JSON has `ok`, `summary`, `checks` (each with `id`, `group`, `status`, `detail`, `fix`, `auto_fix`), `fixes` and `manual`.

## What it checks

| Group | Checks | From |
| --- | --- | --- |
| install | Python is 3.9 or newer; `~/.josh-360` folders; the copy at `~/.josh-360/repo` is a checkout, runs the doctor, is on `main` with no local changes (offline, from the last fetch; `--online` compares with GitHub and looks for a `laptop-pause` branch); the install record matches the copy; the `follow` job ran in the last 30 minutes and passed; not paused; the runner is loaded in launchd; `jobs.yaml` parses | JP-105 |
| jobs | Every recurring job in `jobs.yaml` has its own line: ran recently, last exit 0 | JP-105, JP-107, JP-108, JP-118, JP-150, JP-111 |
| backfills | Every one-time job in `jobs.yaml` has succeeded (waiting on another is a WARN, not a FAIL), and left its evidence: sessions in the ledger, friction facts, the old Atlas archived. A one-time job whose last failure won't fix itself (JP-183) is a FAIL that says "needs a fix" with its reason and last line, and its fix line is `laptop/run_jobs.py --resume <id>` | JP-96, JP-100, JP-107, JP-111, JP-112 |
| hooks | `~/.claude/settings.json` reads; every event has a dispatcher entry that passes its own event name (FAIL for events with hook files, WARN for the rest); every hook file is executable; the ledger spool (JP-107), ticket offer (JP-110), ticket comments (JP-118), Atlas guard with Jira link (JP-111) and graph step (JP-117, four files) hooks are present and registered; no old Atlas entries remain; no hook failed in 24 hours (`hooks.log`: a failure warns; a block passes and is named with its count, and `scripts/hook_blocks.py` lists each block with its reason, JP-182) | JP-105, JP-182 and the hook tickets |
| data | `ledger.db` exists, is at the code's schema version and passes an integrity check; every table and trigger from `schema.sql` is there; `recursive_triggers` is turned on by the code and honoured by this SQLite; `cache.db` opens and has tables; a daily backup under 36 hours old; the ledger holds sessions | JP-107, JP-111 |
| evidence | Rows exist that only real use produces: ticket offers, comment deliveries, summaries, friction facts (WARN until seen; debriefs only SKIP, they need days of use) | JP-108, JP-110, JP-112, JP-113, JP-118 |
| services | The headless Session Atlas is loaded, answers `http://127.0.0.1:8770/api/health`, logs no ledger errors; the old Atlas is gone; Node 22.18 or newer exists (SKIP until `retire-session-atlas` has succeeded) | JP-111 |
| accounts | Azure backup account and container are set and hold nothing else; `az` is signed in (WARN while the backup is not set up, FAIL once it is); the last upload is under 3 days old and no redaction waits; the Jira email is set; the Jira token exists in the keychain; the `claude` command is found | JP-150, JP-107, JP-108 |
| graphs | Each compiled graph in `graphs/compiled/` matches the SHA-256 of its sources; the walker starts on this Python; the validation graph's start rule is on in `graphs/runner/starts.json` (FAIL if it is off or missing), and no open validation watch is more than a day past its give-up time (the day is for a closed laptop; FAIL names the run and ticket; SKIP when the ledger cannot be read). Check name: `graphs.validation-watch`. Each ticket with a graph session in view in Agent Manager has exactly one, named `<KEY>(<letter>) - <Step>`, in the group for the status the runner last saw (`josh-360/tickets/<status>`), and no unknown session sits in a ticket group; it reads `state/runner/am-tickets.json` and Agent Manager's database, never Jira (FAIL names the ticket and session; SKIP when nothing is in view or the database cannot be read). Check name: `graphs.agent-manager-groups`. The walker would give gate scripts both a Jira email and a token, built by the walker's own code with the keychain asked about, never read (FAIL names `~/.josh-360/state/jira-email` or the keychain item; SKIP when the keychain cannot be asked). Check name: `graphs.gate-jira`. `graphs.stale-worktrees`: WARN for each `.claude/worktrees/<KEY>-*` folder in a registered clone (the registry's `folders`) whose ticket has no open run and whose last run ended more than 7 days ago, naming the folder and its clone; a folder whose ticket never ran a graph is not counted; WARN, not PASS, when the registry or the ledger cannot be read. `graphs.tier-models` (JP-183): every model and effort the compiled graphs' tiers name is one Agent Manager lists, after the binding's `models` map (`accepts` in `graphs/bindings/agent-manager/binding.json`); FAIL names the tier and the model or effort A killed session (`dead`) or one whose step the runner recorded as finished is not counted as in view by `graphs.agent-manager-groups` (JP-191). `graphs.completed-step-sessions`: no finished step's session is still open; each ticket session the runner recorded as finished is killed or archived, and an unarchived one sits in `josh-360/completed-steps` or `josh-360/tickets/Done`, judged once `kill_grace_seconds` and two ticks have passed (FAIL names the ticket and session; PASS when nothing is old enough to judge; SKIP when Agent Manager's database cannot be read) | JP-114, JP-121, JP-167, JP-171, JP-173, JP-174, JP-183, JP-191 |
| owed | The debrief form is still provisional after 1 December 2026 | JP-113 |

## What --fix does

Only safe, reversible steps, each one that Josh 360 already does on its own, and only for a check that is failing:

- `install`: runs `laptop/install.py`, as the `follow` job does every 10 minutes. It makes missing folders, creates or migrates the ledger (after a backup) and records the install, writing only inside `~/.josh-360`. Skipped while paused.
- `hooks`: runs `~/.claude/scripts/add-josh-360-hooks.py`, which adds the dispatcher entries after copying `settings.json` to `settings.json.bak-josh-360`. `add-josh-360-hooks.py --remove` undoes it.
- `jira-email`: with `--jira-email you@example.com`, writes the one-line `~/.josh-360/state/jira-email` (owner-only, never overwritten).

It never installs software, signs in anywhere, deletes anything, removes a pause, moves the copy, or touches launchd, Azure, Jira or a git remote. Those checks stay failing, with their one fix step for Josh. It checks again afterwards and reports the new result.

## What only Josh can check

The report ends with the checks the doctor cannot see, collected from the proof pages under `docs/proof/`: the ticket offer in a real session (JP-110), a ticket comment reaching a session (JP-118), the worktree removal guard and the macOS gates (JP-111), the first `/closeout` (JP-109), the Jira flag and a made-up to-do through the ticket graph (JP-121), and the laptop tests on the Mac's own Python (JP-105). They are not counted as passes or failures; the `evidence` checks turn green once a manual step has produced its row. They are the `MANUAL` list in `scripts/doctor_lib/manual.py`.

## Reading it from the cloud

The `doctor` job (`jobs.yaml`, daily) runs `scripts/doctor_job.py`, which publishes the JSON to the `laptop-status` branch and always exits 0, so a failing laptop still reports. Read it with `python3 laptop/status.py show doctor`. It is as new as the last daily run.

## Adding a check

1. Add a function in the right file of `scripts/doctor_lib/`, decorated `@check("<group>", "<name>")`, returning a `Result("<group>.<name>", PASS|WARN|FAIL|SKIP, detail, fix)`. Give the one step that fixes it. Read only; use `ctx.sqlite_ro` for a database.
2. Add a test in `tests/test_doctor.py` on the made-up laptop in `tests/doctor_helpers.py`: one case that passes and one that fails.
3. Add a row to the table above, and its manual step to `manual.py` if only Josh can see it.
