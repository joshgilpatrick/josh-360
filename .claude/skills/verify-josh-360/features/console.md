# Live console

Josh opens one terminal and sees what Josh 360 is doing as it happens: graph runs and steps, gate notes, questions for him, every laptop job's run, hook blocks and failures, and sessions starting and ending, one colored line each. The console only reads what Josh 360 already writes; the `console-terminal` job keeps an Agent Manager terminal named `console` running it (JP-185).

## Sub-features

- `console-ledger` graph runs, steps, gate notes, run ends and questions come from the ledger, with the run's ticket key.
- `console-logs` the runner's log, each run's advance log, every job log and `hooks.log` are followed like `tail -F`, including files that appear later.
- `console-spool` sessions starting and ending come from the hook spool.
- `console-colors` red errors and failed exits, yellow stops, a NEEDS JOSH badge, cyan starts, green clean ends; none when piped or with `NO_COLOR`.
- `console-keepalive` the `console-terminal` job reports `running`, `started`, `restarted`, `starting`, `unknown`, `off` or `failed`, and never opens a second terminal on an unknown answer.

## How to get to it (user POV)

- Open the `console` terminal in Agent Manager's `josh-360` group on the laptop.
- In any terminal: `python3 ~/.josh-360/repo/scripts/console.py` (`--since 2h`, `--source graph`, `--once`).
- From the cloud: `python3 laptop/status.py show console-terminal` for the keep-alive's report.

## Driving it with sandbox.py

Preconditions:

- A launched sandbox `<id>` whose `doctor` printed `"ok": true`, and a seeded session `verify-sess-0001` (`$S seed-session --run <id> --session verify-sess-0001 --branch JP-9001-sample --folder sample-repo`).
- The exports from `$S env --run <id>` (`HOME`, `JOSH360_HOME`) in a shell whose working folder is the sandbox copy, for the following console.

- **Start it following.** In that shell, run `timeout 120 python3 scripts/console.py --color --since 10m --poll 0.5 > <scratch>/follow.ansi &`. Its first lines are the banner and `not there yet: ...` naming the sources that do not exist yet.
- **A session starts.** Run `$S hook --run <id> --event SessionStart --payload <run>/payloads/verify-sess-0001-start.json --name session-start`. The console shows `session verify-s started by josh in sample-repo (startup)`.
- **Jobs run.** Run `$S run --run <id> --name run-jobs -- python3 laptop/run_jobs.py`. One dim `<job> ran, exit 0` line per job.
- **A graph run.** Drive the walker run in [Graph walker](./graph-walker.md) (submit, next, record, next). The console shows `run started: ticket-creation`, the entry gate, `read_intake` started and recorded, the `route` gate with its note, and `run of ticket-creation ended: route.personal (neutral)`.
- **A hook blocks.** Put an executable that prints to stderr and exits 2 in the sandbox copy's `hooks/PreToolUse/`, fire `$S hook --run <id> --event PreToolUse --payload <a Bash payload> --name hook-block`, then remove it. The console shows `PreToolUse <name> blocked (exit 2)` in red.
- **The keep-alive's report.** Read `<run>/home/.josh-360/state/reports/console-terminal.json`. In the sandbox it is `"status": "unknown"` with `agent-manager not found` and `"heartbeat_fresh": 0`; nothing was created.
- **Once mode.** Run `$S run --run <id> --name console-once -- python3 scripts/console.py --once --since 1h --no-color`. The same lines, plain text, and exit `0`.

## Gotchas

- The console reads `JOSH360_HOME`; run it with the sandbox's exports, or it reads the real `~/.josh-360`.
- `--once` with no `--since` shows only the last 30 minutes; a sandbox built earlier needs `--since 2h` or `all`.
- A clean job run shows one line; its routine output stays in its own log. Look in `logs/<job>.log` before deciding a job printed nothing.
- The walker's refused start writes no log line and no ledger row, so the console shows nothing for it.
- The sandbox has no Agent Manager, so the keep-alive can only report `unknown` there; its other states are covered by `tests/test_console_terminal_job.py`.
