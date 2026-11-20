# The real Agent Manager in the cloud (JP-186, JP-188)

## Contents

- [What it is](#what-it-is)
- [Running it](#running-it)
- [The parts](#the-parts)
- [The stand-in for Claude Code](#the-stand-in-for-claude-code)
- [Scenarios](#scenarios)
- [A whole run](#a-whole-run)
- [The clock](#the-clock)
- [In CI](#in-ci)
- [What it does not cover](#what-it-does-not-cover)

## What it is

Josh 360 starts its graph steps only through Agent Manager on Josh's laptop. This folder lets a cloud session or a CI job run that same Agent Manager, at the laptop's version (0.47.1), with no screen, and drive it through the real binding (`graphs/bindings/agent-manager/binding.py`). Claude Code is replaced by a stand-in script, so no model is called and nothing is paid per turn. The product does not change: nothing in `graphs/`, `ledger/` or `hooks/` knows about this folder.

The design and the spike behind it are in `/mnt/project-files/josh-360/cloud-e2e-testing-design.md` (the project's shared files). JP-188 added the whole-run driver (`scripts/e2e.py`, below) and the CI job on top of this.

## Running it

```bash
python3 tests/e2e/agent_manager.py install                              # once: go install of the pinned version
python3 -m unittest discover -s tests -t tests -p 'test_e2e_*.py' -v    # the tests here
```

`install` needs Go, git and tmux 3.1 or newer (`apt-get install -y tmux`). It builds into `~/.cache/josh360-e2e/agent-manager-0.47.1/` (`$JOSH360_E2E_CACHE` moves it) and does nothing when that binary is already there at the right version. Without it, `tests/test_e2e_agent_manager.py` skips every test with the install command as the reason; set `JOSH360_E2E_AM=1` to make a missing install fail instead (the CI job does). `tests/test_e2e_standin.py` needs nothing and always runs.

To drive an instance by hand:

```bash
python3 tests/e2e/agent_manager.py up --root /tmp/am-1      # make it and start its manager; prints its environment
python3 tests/e2e/agent_manager.py check --root /tmp/am-1   # installed? manager running? (exit 1 when not)
python3 tests/e2e/agent_manager.py down --root /tmp/am-1    # stop the manager and every session pane
```

## The parts

| File | What it does |
| --- | --- |
| `agent_manager.py` | Installs the pinned Agent Manager; makes an instance (its own `HOME`, `XDG_CONFIG_HOME` and `TMUX_TMPDIR`); starts the manager in a detached tmux session, because statuses only move in `state.db` while a manager runs; says when the manager is not running (`snapshot --json`'s `manager_awake`). `Instance.env()` is the environment the binding and the sessions run with: the stand-in first on the `PATH`, `JOSH360_AM_DB` at the Linux database (`$XDG_CONFIG_HOME/agent-manager/state.db`), `JOSH360_AM_BIN` at the recorder, and no credentials. |
| `am-record` | Runs the real `agent-manager` and logs each call with its exit code, standard output and standard error to `am-calls.jsonl`. The binding keeps only a short reason (`refused`); the log keeps Agent Manager's own words. |
| `standin/claude` | The stand-in for Claude Code, below. |
| `laptop-models.json` | The models the laptop's Claude Code lists (default, opus, fable, sonnet, haiku). Refresh it from the laptop when Claude Code changes there. |
| `scenarios/*.json` | What a stand-in session does. |

An instance folder holds `home/` (with `home/.claude/settings.json`, which `Instance.rails(repo)` fills with the checkout's `hooks/dispatch` for every event, as the laptop's settings do), `tmux/`, `am-calls.jsonl`, `standin.jsonl` (the stand-in's log) and `standin-plan.json` (which scenario each step plays; `Instance.plan()` writes it).

## The stand-in for Claude Code

`standin/claude` is Python 3.9, standard library only.

- **The model probe.** Agent Manager checks a model against what `claude -p --input-format stream-json ...` answers to an `initialize` control request. The stand-in answers with `laptop-models.json`, so a model the laptop would refuse is refused here with the laptop's message: `model "claude-sonnet-5-5" is not one claude lists; it lists default, opus, fable, sonnet, haiku`.
- **A session.** Agent Manager launches it in a tmux pane as `claude --model M --effort E <prompt> --session-id ID --mcp-config F --settings F`. It fires `SessionStart`, `UserPromptSubmit` (with the prompt), `PreToolUse` and `PostToolUse` for a `Write` of the step's result file, then `Stop`, with Claude Code's payload fields, from both `~/.claude/settings.json` and the `--settings` file, with their `env` blocks applied. A hook that blocks is honoured: exit 2, `decision: block`, `continue: false` or `permissionDecision: deny`. A blocked prompt ends the turn; a blocked `Write` writes nothing; a blocked `Stop` runs again with `stop_hook_active`, three passes at most. Then it waits at the prompt; each line typed into the pane (Agent Manager's `send`) is a turn that only stops. SIGHUP or SIGTERM fires `SessionEnd`.
- **Its log.** Every probe, hook (with exit code and whether it blocked), turn and write is a line in `$JOSH360_STANDIN_LOG`. Tests assert on it.

## Scenarios

The plan file maps steps to scenarios: `{"default": "example", "steps": {"build": "silent"}}`. A scenario is a name below or a path to a JSON file of the same shape.

| Scenario | What the session does |
| --- | --- |
| `example` | Writes the example result in the role's instructions (the first ```` ```json ```` block holding `outcome`), else the scenario's own `outcome` and `outputs`, else the first listed outcome with no outputs. Works for 6 seconds first, longer than the manager's 5-second poll, so `working` is seen. |
| `wrong-shape` | Writes a result with no `outcome` and its fields not under `outputs`. |
| `silent` | Writes nothing and stops, ignoring the Stop hook's nudge. |
| `silent-then-obeys` | Writes nothing, then writes the example result when the Stop hook nudges it. |
| `hang` | Starts working and never stops. |
| `question` | Calls `AskUserQuestion` instead of ending with the needs-input outcome; if no hook blocks it, waits at the dialog (`Notification` `elicitation_dialog`, which Agent Manager reads as waiting). |
| `follow-ups` | Writes the example result with two made-up follow-ups. |
| `undeclared-output.json` | Writes the example `ready` result plus an output, `made_up_extra`, that no step declares (a file scenario, JP-188). |

A scenario's `think` is how long the turn works before writing; `$JOSH360_STANDIN_THINK` overrides it (the stand-in's own tests use 0).

## A whole run

`python3 scripts/e2e.py --scenario <name>` carries a made-up ticket from its start status to an ended run on a sandbox laptop, with the real Agent Manager, the stand-in and the strict fake Jira (JP-187). `--all` runs every scenario, each into its own evidence folder; `--list` prints them. The scenarios are the files in `runs/`:

| Run | What it proves |
| --- | --- |
| `triage-happy` | The fixture JP-9116 goes through the triage graph from Not Started to Ready: the run ends `finished`, each role step had one session, the fake Jira shows Ready, and every pass the live session sat in the group for the ticket's status, with the earlier ones put away. |
| `undeclared-output` | The sign-off session writes an output its step does not declare: the run stops at `sign_off` within 25 e2e minutes and `runner.log` names `made_up_extra`. |

What it does, in order:

1. Launches a sandbox laptop with verify-josh-360's `sandbox.py` (committed `HEAD`; `--allow-dirty` while iterating).
2. Makes an Agent Manager instance whose home is the sandbox's, wires the hooks, writes the stand-in plan, installs the strict fake Jira with the scenario's fixture and made-up neighbours, and writes the scenario's starts file (handed over in `JOSH360_RUNNER_STARTS`; the laptop's own `graphs/runner/starts.json` is not touched).
3. Each pass moves the clock five minutes, runs `laptop/run_jobs.py` with Python 3.9 and a job's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`, no `~/.local/bin`), and waits until no advance holds its lock and no session is starting or working. One more pass follows the run's end, so the tick files the last session.
4. Stops when the run ends, when it stops at the scenario's `stopped_at`, or at the e2e-minute or real-time limit.
5. Copies the evidence and judges it against the scenario's `expect`.

The evidence folder (default `docs/proof/<date>/e2e/<run>/`, `--evidence` moves it) holds `verdict.json`, `passes.jsonl` (one line per pass: e2e minutes, run, Jira status, sessions), `logs/` (with `runner.log`), `run/` (the run folder), `report.txt` and `report.json`, `jira/calls.jsonl` and the fake's final state, `agent-manager/` (sessions, the binding's calls, the stand-in's log and plan) and `sandbox/`. Exit 0 when every check passed, 1 when one failed, 2 when the harness could not run (no Agent Manager, no Python 3.9, a dirty checkout). The sandbox is removed afterwards unless `--keep`.

It needs what the Agent Manager tests need, plus a Python 3.9 (`--python`, `$JOSH360_E2E_PYTHON`, `python3.9` on the `PATH`, or `uv python find 3.9`) for the laptop's jobs.

## The clock

`clock/sitecustomize.py` is on the `PYTHONPATH` of every laptop process the driver starts. With `JOSH360_E2E_CLOCK` naming a file, `time.time`, `gmtime`, `localtime`, `strftime`, `ctime` and `datetime.datetime`'s `now`, `utcnow` and `today` run that many seconds ahead; the driver writes the file between passes. Monotonic clocks stay real, so time-outs and sleeps are not shortened. Agent Manager itself (Go) keeps the real clock, which only matters for its own timestamps.

## In CI

The `e2e` job in `.github/workflows/test.yml` runs on the same events as `suite`. It installs tmux, Go and Python 3.9, restores the Agent Manager build from the cache (keyed on the pinned version), runs the Agent Manager tests with `JOSH360_E2E_AM=1`, then `scripts/e2e.py --all`, and uploads the evidence as the `e2e-evidence` artifact whether it passed or not.

## What it does not cover

Real model output, Josh's real Agent Manager state and sign-in, the macOS database path (`~/Library/Application Support/agent-manager/state.db`, which the laptop doctor checks), launchd and the keychain. Those stay laptop checks.
