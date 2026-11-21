# The real Agent Manager in the cloud (JP-186, JP-188)

## Contents

- [What it is](#what-it-is)
- [Running it](#running-it)
- [The parts](#the-parts)
- [The stand-in for Claude Code](#the-stand-in-for-claude-code)
- [The stand-in for gh](#the-stand-in-for-gh)
- [Scenarios](#scenarios)
- [A whole run](#a-whole-run)
- [This week's laptop failures](#this-weeks-laptop-failures)
- [The clock](#the-clock)
- [In CI](#in-ci)
- [What it does not cover](#what-it-does-not-cover)

## What it is

Josh 360 starts its graph steps only through Agent Manager on Josh's laptop. This folder lets a cloud session or a CI job run that same Agent Manager, at the laptop's version (0.47.1), with no screen, and drive it through the real binding (`graphs/bindings/agent-manager/binding.py`). Claude Code is replaced by a stand-in script, so no model is called and nothing is paid per turn. The product does not change: nothing in `graphs/`, `ledger/` or `hooks/` knows about this folder.

The design and the spike behind it are in `/mnt/project-files/josh-360/cloud-e2e-testing-design.md` (the project's shared files). JP-188 added the whole-run driver (`scripts/e2e.py`, below) and the CI job on top of this; JP-190 added a run for each failure Josh found on his laptop in the week of 16 November 2026.

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
| `agent_manager.py` | Installs the pinned Agent Manager; makes an instance (its own `HOME`, `XDG_CONFIG_HOME` and `TMUX_TMPDIR`); starts the manager in a detached tmux session, because statuses only move in `state.db` while a manager runs; says when the manager is not running (`snapshot --json`'s `manager_awake`). `Instance.env()` is the environment the binding and the sessions run with: the stand-in first on the `PATH` (the whole-run driver replaces that `PATH` with a job's and puts the stand-in at `~/.local/bin/claude` instead), `JOSH360_AM_DB` at the Linux database (`$XDG_CONFIG_HOME/agent-manager/state.db`), `JOSH360_AM_BIN` at the recorder, and no credentials. |
| `am-record` | Runs the real `agent-manager` and logs each call with its exit code, standard output and standard error to `am-calls.jsonl`. The binding keeps only a short reason (`refused`); the log keeps Agent Manager's own words. |
| `standin/claude` | The stand-in for Claude Code, below. |
| `standin/gh` | The stand-in for GitHub's `gh` command (JP-198), below. |
| `laptop-models.json` | The models the laptop's Claude Code lists (default, opus, fable, sonnet, haiku). Refresh it from the laptop when Claude Code changes there. |
| `scenarios/*.json` | What a stand-in session does. |

An instance folder holds `home/` (with `home/.claude/settings.json`, which `Instance.rails(repo)` fills with the checkout's `hooks/dispatch` for every event, as the laptop's settings do), `tmux/`, `am-calls.jsonl`, `standin.jsonl` (the stand-in's log) and `standin-plan.json` (which scenario each step plays; `Instance.plan()` writes it).

## The stand-in for Claude Code

`standin/claude` is Python 3.9, standard library only.

- **The model probe.** Agent Manager checks a model against what `claude -p --input-format stream-json ...` answers to an `initialize` control request. The stand-in answers with `laptop-models.json`, so a model the laptop would refuse is refused here with the laptop's message: `model "claude-sonnet-5-5" is not one claude lists; it lists default, opus, fable, sonnet, haiku`.
- **A session.** Agent Manager launches it in a tmux pane as `claude --model M --effort E <prompt> --session-id ID --mcp-config F --settings F`. It fires `SessionStart`, `UserPromptSubmit` (with the prompt), `PreToolUse` and `PostToolUse` for a `Write` of the step's result file, then `Stop`, with Claude Code's payload fields, from both `~/.claude/settings.json` and the `--settings` file, with their `env` blocks applied. A hook that blocks is honoured: exit 2, `decision: block`, `continue: false` or `permissionDecision: deny`. A blocked prompt ends the turn; a blocked `Write` writes nothing; a blocked `Stop` runs again with `stop_hook_active`, three passes at most. Then it waits at the prompt; each line typed into the pane (Agent Manager's `send`) is a turn that only stops. SIGHUP or SIGTERM fires `SessionEnd`.
- **A commit.** A scenario's `commit` (`files` and a `message`) writes each file under the session's folder with the `Write` tool, then commits them with one `Bash` call (`git add -A && git commit`), each through `PreToolUse` and `PostToolUse`, before the result is written (JP-198). A builder's session runs in the ticket's worktree, so this is how a build lands on the ticket's branch.
- **Its log.** Every probe, hook (with exit code and whether it blocked), turn, write and Bash call is a line in `$JOSH360_STANDIN_LOG`. Tests assert on it.

## The stand-in for gh

`standin/gh` is Python 3.9, standard library only, and never reaches GitHub (JP-198). The development gates (`graphs/gates/lib/dev_github.py`) and the loose-ends reader (`ledger/live.py`) call `gh` by name, and on the laptop it is Homebrew's, on the job runner's `PATH` (`/opt/homebrew/bin`, from the startup list's plist). On a sandbox laptop the driver puts the stand-in in the sandbox's `homebrew/bin`, first on the job's `PATH`, and gives it a folder (`$JOSH360_STANDIN_GH`):

- `config.json`: the repositories it holds (`joshgilpatrick/josh-360` is the sandbox's bare `origin.git`, through a link at `repos/joshgilpatrick/josh-360.git`, so a clone's `origin` reads as that repository), the audit and the checks.
- `state.json`: its pull requests, with their labels, comments and checks.
- `calls.jsonl`: every call, with the folder it ran in, its exit code and the first line it said.

It answers every call `dev_github.GitHub` makes (`tests/test_e2e_standin_gh.py` drives each of its methods and fails when one is added): `pr view`, `pr list`, `pr create`, `pr checks` (exit 8 while one is pending, "no checks reported" before any), `pr merge --squash --match-head-commit` (a squash commit on the base branch of the bare repository, refused when the head moved), `label list` and `label create`, and `api` for comments, labels, the repository's default branch, workflow runs and deleting a branch. An open pull request follows its branch, as GitHub's does. `ledger/live.py`'s `pr list --head` with no `--repo` reads the repository from the checkout's `origin`. A call it does not know exits 1 saying `stand-in gh: unknown call`, and the verdict checks there was none.

It also plays the laptop's PR audit (action-triage): once `review:needs-agent-audit` has been on a pull request for the config's `audit.after_seconds` (300, one pass) by the e2e clock, the next call finds the trigger gone, `review:ready-for-human` on, a verdict comment from `joshgilpatrick-action-agent[bot]` with the audit marker and no findings, and each check in `checks` (`suite`, `e2e`) passed.

## Scenarios

The plan file maps steps to scenarios: `{"default": "example", "steps": {"build": "silent"}}`. A scenario is a name below or a path to a JSON file of the same shape. A list plays one scenario per attempt of the step and the last one for every later attempt, for example `{"revise": ["wrong-shape", "revise-example.json"]}` (JP-194).

| Scenario | What the session does |
| --- | --- |
| `example` | Writes the step's example result in the role's instructions (the first ```` ```json result step=<step> ```` block, read by the same code as `graphs/tools/role_examples.py check`, JP-189; else the first untagged ```` ```json ```` block holding `outcome`), else the scenario's own `outcome` and `outputs`, else the first listed outcome with no outputs. Works for 6 seconds first, longer than the manager's 5-second poll, so `working` is seen. |
| `wrong-shape` | Writes a result with no `outcome` and its fields not under `outputs`. |
| `silent` | Writes nothing and stops, ignoring the Stop hook's nudge. |
| `silent-then-obeys` | Writes nothing, then writes the example result when the Stop hook nudges it. |
| `hang` | Starts working and never stops. |
| `question` | Calls `AskUserQuestion` instead of ending with the needs-input outcome; if no hook blocks it, waits at the dialog (`Notification` `elicitation_dialog`, which Agent Manager reads as waiting). |
| `follow-ups` | Writes the example result with two made-up follow-ups. |
| `undeclared-output.json` | Writes the example `ready` result plus an output, `made_up_extra`, that no step declares (a file scenario, JP-188). |
| `design-spec.json` | `example_outcome: ready`: writes the designer's own example result (`spec_path` at `<work folder>/spec.yaml`), after first writing that spec from the scenario's `companions`: one phase whose two checks the builder's commit passes, and a row for the fixture's one acceptance scenario (JP-198). |
| `build-commit.json` | Commits a made-up chores page in the session's folder (the ticket's worktree) with `commit`, then writes the builder's example result, `done` (JP-198). |
| `revise-example.json` | `example_outcome: revised`: writes the role's own example result for that outcome (the ticket drafter's, JP-184), its `<work folder>/...` path made real and named after the result file, after first writing the file that path names from the scenario's `companions` (here JP-9116 with its Validation section back). A role with no example for the outcome writes nothing (JP-190). |

A scenario's `think` is how long the turn works before writing; `$JOSH360_STANDIN_THINK` overrides it (the stand-in's own tests use 0).

## A whole run

`python3 scripts/e2e.py --scenario <name>` carries a made-up ticket from its start status to an ended run on a sandbox laptop, with the real Agent Manager, the stand-in and the strict fake Jira (JP-187). `--all` runs every scenario, each into its own evidence folder; `--list` prints them. The scenarios are the files in `runs/`:

| Run | What it proves |
| --- | --- |
| `triage-happy` | The fixture JP-9116 goes through the triage graph from Not Started to Ready: the run ends `finished`, each role step had one session, the fake Jira shows Ready, and every pass the live session sat in the group for the ticket's status, with the earlier ones put away. |
| `undeclared-output` | The sign-off session writes an output its step does not declare: the run stops at `sign_off` within 25 e2e minutes and `runner.log` names `made_up_extra`. |
| `bad-model-map` | `binding.json`'s `models` map is empty (`binding` in the scenario): the run stops at `sign_off` after one spawn, `runner.log` carries Agent Manager's own message naming `claude-sonnet-5-5`, and two more passes spawn nothing. |
| `permanent-refusal` | The laptop's Claude Code no longer lists `opus` (`claude_lists`), the model sign-off's tier maps to: the run stops at `sign_off` after one spawn, says it needs a fix, and the step's one attempt stays open, so the walker counts no run of it against the cap. |
| `triage-revise` | The fixture lacks its Validation section, so triage sends it to `revise`; the stand-in plays `revise-example.json`; the walker records `revise` with `revised`, the revision is applied and the ticket reaches Ready. |
| `triage-revise-at-cap` | JP-116's run of 20 November (JP-194): the drafter's first two attempts write the wrong shape, each spending a run of its cap of 3, and the third revises. The loop from `apply_revision` back to `read_ticket` goes ahead although `revise` is at its cap, the ready check passes and the ticket reaches Ready with no question to Josh. The plan gives `revise` one scenario per attempt. |
| `dev-happy` | The fixture JP-9116, Ready with `ready-to-run`, routed to the development graph by a signed route record (`route_signed`) and with a Validation section saying `Needed: yes`, goes through the whole development graph (JP-198). The designer writes a spec, the builder commits, and the gates push the ticket's branch and open, queue, merge and clean up its pull request through the stand-in gh, which plays the audit a pass later. The run ends `finished`; the ticket went Ready, Design/Planning, In Progress, Code Review, Validation, Deployed with only moves the JP snapshot allows; one pull request was opened from a `JP-9116-` branch and merged onto `main`; no worktree or branch for the ticket is left in the clone or on the stand-in GitHub (JP-174); and a validation run for the ticket is open within one pass of the development run ending (JP-168's hand-over). |
| `ledger-record-pace` | The recorder has a backlog of 700 made-up sessions (`backlog`) and its Jira answers each read after 0.5 s: ledger-record uses (nearly) its whole 150-second budget in each of two passes (`passes: 2`, checked as at least 145 s), and `graph-runner` still starts within 300 s of each pass starting. |

Every run is laptop-like in the ways the laptop has bitten (JP-190): the Jira email is only in `~/.josh-360/state/jira-email`, and the fake Jira holds `credentials.json`, so a gate or the runner that does not find it the laptop's way is refused with Jira's 401 (the token stands in for the keychain as `JOSH360_JIRA_TOKEN`); the stand-in is only at `~/.local/bin/claude`, with no `JOSH360_CLAUDE_BIN`, so the binding must find it under a job's `PATH`; and the ledger recorder reads a local stand-in for Jira's REST API, never the real site. Every verdict checks that no Jira call was refused.

A scenario may also carry: `route_signed` (the route record's version set to the ticket's own, read the way the entry gate reads it, as triage's sign-off leaves it), `github` (the stand-in gh's `audit` and `checks`; with it the driver also clones the josh-360 repository where the registry looks for it, `~/Development/active/josh_360`), `binding` (keys merged over `binding.json`, handed over in `JOSH360_AM_BINDING_JSON`), `claude_lists` (the models the stand-in's probe lists, from `laptop-models.json`), `backlog` (`sessions`, `jira_delay`), `jobs_done` (once jobs marked done long ago in `jobs-state.json`), `passes` (stop after that many passes) and `after_stop_passes` (passes run after the stop, to show it holds). Its `expect` may name `admitted`, `claude_found`, `spawns`, `cap_used`, `step_outcomes`, `graph_runner_within_seconds`, `ledger_record_busy_seconds`, and (JP-198) `jira_path` (every status the ticket went through, read from the fake Jira's changelog), `pull_request` (`opened`, `merged`, `branch_prefix`, from the stand-in gh's log, plus no call it did not know), `nothing_left` and `hand_over_within_passes`, besides JP-188's checks. `collect` also saves `walker-status.json`.

What it does, in order:

1. Launches a sandbox laptop with verify-josh-360's `sandbox.py` (committed `HEAD`; `--allow-dirty` while iterating).
2. Makes an Agent Manager instance whose home is the sandbox's, wires the hooks, writes the stand-in plan, installs the strict fake Jira with the scenario's fixture and made-up neighbours, and writes the scenario's starts file (handed over in `JOSH360_RUNNER_STARTS`; the laptop's own `graphs/runner/starts.json` is not touched).
3. Each pass moves the clock five minutes, runs `laptop/run_jobs.py` with Python 3.9 and a job's `PATH` (the sandbox's `homebrew/bin`, holding only the stand-in gh, then `/usr/bin:/bin:/usr/sbin:/sbin`: no `~/.local/bin`, as on the laptop), and waits until no advance holds its lock and no session is starting or working. One more pass follows the run's end, so the tick files the last session.
4. Stops when the run ends, when it stops at the scenario's `stopped_at` (and its `after_stop_passes` have run), after the scenario's `passes`, or at the e2e-minute or real-time limit.
5. Copies the evidence and judges it against the scenario's `expect`.

The evidence folder (default `docs/proof/<date>/e2e/<run>/`, `--evidence` moves it) holds `verdict.json`, `passes.jsonl` (one line per pass: e2e minutes, run, Jira status, sessions, every run on the ticket), `github/` (the stand-in gh's calls, state and config), `logs/` (with `runner.log`), `run/` (the run folder), `report.txt` and `report.json`, `jira/calls.jsonl` and the fake's final state, `agent-manager/` (sessions, the binding's calls, the stand-in's log and plan) and `sandbox/`. Exit 0 when every check passed, 1 when one failed, 2 when the harness could not run (no Agent Manager, no Python 3.9, a dirty checkout). The sandbox is removed afterwards unless `--keep`.

It needs what the Agent Manager tests need, plus a Python 3.9 (`--python`, `$JOSH360_E2E_PYTHON`, `python3.9` on the `PATH`, or `uv python find 3.9`) for the laptop's jobs.

## This week's laptop failures

Each failure Josh found on the laptop in the week of 16 November 2026, and the run that now fails if it comes back. Each run was shown failing on the code that had the bug and passing on `main` (`docs/proof/2026-11-20/JP-190/`). `tests/test_e2e_driver.py` keeps this map.

| Failure | Run |
| --- | --- |
| `binding.json` had an empty `models` map, so every spawn was refused (fixed in 6b03062) | `bad-model-map`; `triage-happy` and every other run spawn through the real map |
| Spawn retries spent the tier cap on a refusal that could never pass, and the log said only "refused" (JP-183) | `permanent-refusal`, `bad-model-map` |
| The `revise` result was refused for an undeclared output (JP-184) | `triage-revise` |
| `ledger-record` held up the five-minute jobs (JP-181) | `ledger-record-pace` |
| Gate scripts did not find the Jira email when it was only in `state/jira-email` (JP-171) | `triage-happy`, `triage-revise` (and every run's Jira check) |
| "claude is not installed" under a job's PATH | `triage-happy` (and every run that spawns) |
| The run cap stopped the loop back to a re-read after the drafter's last run, so the revised ticket was never checked (JP-194, run r-4400caa5965b) | `triage-revise-at-cap` |
| The development graph had never been run end to end, so its hand-over to a validation watch (JP-168) was a laptop check | `dev-happy` (JP-198; shown failing on 377d0a1 with `hand_to_watch` taken out, `docs/proof/2026-11-21/JP-198/`) |

## The clock

`clock/sitecustomize.py` is on the `PYTHONPATH` of every laptop process the driver starts. With `JOSH360_E2E_CLOCK` naming a file, `time.time`, `gmtime`, `localtime`, `strftime`, `ctime` and `datetime.datetime`'s `now`, `utcnow` and `today` run that many seconds ahead; the driver writes the file between passes. Monotonic clocks stay real, so time-outs and sleeps are not shortened. Agent Manager itself (Go) keeps the real clock, which only matters for its own timestamps.

## In CI

The `e2e` job in `.github/workflows/test.yml` runs on the same events as `suite`. It installs tmux, Go and Python 3.9 (with uv, since `actions/setup-python` has no 3.9 for the current `ubuntu-latest`), restores the Agent Manager build from the cache (keyed on the pinned version), runs the Agent Manager tests with `JOSH360_E2E_AM=1`, then `scripts/e2e.py --all`, and uploads the evidence as the `e2e-evidence` artifact whether it passed or not.

## What it does not cover

Real model output, real GitHub (its checks, the laptop's real PR audit, Josh's `gh` sign-in), Josh's real Agent Manager state and sign-in, the macOS database path (`~/Library/Application Support/agent-manager/state.db`, which the laptop doctor checks), launchd and the keychain. Those stay laptop checks.
