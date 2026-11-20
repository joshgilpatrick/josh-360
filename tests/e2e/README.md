# The real Agent Manager in the cloud (JP-186)

## Contents

- [What it is](#what-it-is)
- [Running it](#running-it)
- [The parts](#the-parts)
- [The stand-in for Claude Code](#the-stand-in-for-claude-code)
- [Scenarios](#scenarios)
- [What it does not cover](#what-it-does-not-cover)

## What it is

Josh 360 starts its graph steps only through Agent Manager on Josh's laptop. This folder lets a cloud session or a CI job run that same Agent Manager, at the laptop's version (0.47.1), with no screen, and drive it through the real binding (`graphs/bindings/agent-manager/binding.py`). Claude Code is replaced by a stand-in script, so no model is called and nothing is paid per turn. The product does not change: nothing in `graphs/`, `ledger/` or `hooks/` knows about this folder.

The design and the spike behind it are in `/mnt/project-files/josh-360/cloud-e2e-testing-design.md` (the project's shared files). JP-188 builds the whole-run driver and the CI job on top of this.

## Running it

```bash
python3 tests/e2e/agent_manager.py install                              # once: go install of the pinned version
python3 -m unittest discover -s tests -t tests -p 'test_e2e_*.py' -v    # the tests here
```

`install` needs Go, git and tmux 3.1 or newer (`apt-get install -y tmux`). It builds into `~/.cache/josh360-e2e/agent-manager-0.47.1/` (`$JOSH360_E2E_CACHE` moves it) and does nothing when that binary is already there at the right version. Without it, `tests/test_e2e_agent_manager.py` skips every test with the install command as the reason; set `JOSH360_E2E_AM=1` to make a missing install fail instead (the CI job will). `tests/test_e2e_standin.py` needs nothing and always runs.

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
| `example` | Writes the step's example result in the role's instructions (the first ```` ```json result step=<step> ```` block, read by the same code as `graphs/tools/role_examples.py check`, JP-189; else the first untagged ```` ```json ```` block holding `outcome`), else the scenario's own `outcome` and `outputs`, else the first listed outcome with no outputs. Works for 6 seconds first, longer than the manager's 5-second poll, so `working` is seen. |
| `wrong-shape` | Writes a result with no `outcome` and its fields not under `outputs`. |
| `silent` | Writes nothing and stops, ignoring the Stop hook's nudge. |
| `silent-then-obeys` | Writes nothing, then writes the example result when the Stop hook nudges it. |
| `hang` | Starts working and never stops. |
| `question` | Calls `AskUserQuestion` instead of ending with the needs-input outcome; if no hook blocks it, waits at the dialog (`Notification` `elicitation_dialog`, which Agent Manager reads as waiting). |
| `follow-ups` | Writes the example result with two made-up follow-ups. |

A scenario's `think` is how long the turn works before writing; `$JOSH360_STANDIN_THINK` overrides it (the stand-in's own tests use 0).

## What it does not cover

Real model output, Josh's real Agent Manager state and sign-in, the macOS database path (`~/Library/Application Support/agent-manager/state.db`, which the laptop doctor checks), launchd and the keychain. Those stay laptop checks.
