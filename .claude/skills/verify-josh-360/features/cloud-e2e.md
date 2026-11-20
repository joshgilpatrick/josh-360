# Cloud end-to-end run

Josh no longer needs his laptop to prove a graph run. One command in the cloud, or the `e2e` check on a ready pull request, carries a made-up ticket from its start status to an ended run on a sandbox laptop, with the real Agent Manager (JP-186), a stand-in for Claude Code and the strict fake Jira (JP-187), and leaves the run's evidence behind (JP-188).

## Sub-features

- `e2e-happy` the `triage-happy` scenario: JP-9116 goes from Not Started to Ready through the triage graph, the run ends `finished`, each role step had one Agent Manager session.
- `e2e-groups` the sessions follow the ticket's status: every pass the live session sits in the group for the ticket's Jira status, and at the end the earlier ones are put away.
- `e2e-stop` the `undeclared-output` scenario: a session writes an output its step does not declare, the run stops at that step within 25 e2e minutes and `runner.log` names the output.
- `e2e-laptop-failures` one run per failure Josh found on the laptop in the week of 16 November 2026 (JP-190): `bad-model-map`, `permanent-refusal`, `triage-revise`, `ledger-record-pace`, and `triage-happy`'s `admitted` and `claude_found` checks; the map is in `tests/e2e/README.md`, "This week's laptop failures".
- `e2e-laptop-like` every run has the Jira email only in `state/jira-email` (the fake Jira refuses a client without it), `claude` only in `~/.local/bin`, and a local stand-in for the recorder's Jira reads.
- `e2e-evidence` every run leaves `verdict.json`, `passes.jsonl`, the logs, the run folder, the report, the fake Jira's calls and Agent Manager's sessions in one folder.
- `e2e-ci` the `e2e` job in `.github/workflows/test.yml` runs every scenario on the events `suite` runs on and uploads the evidence as the `e2e-evidence` artifact.

## How to get to it (user POV)

- In a cloud session: `python3 tests/e2e/agent_manager.py install` once, then `python3 scripts/e2e.py --scenario <name>` or `--all` (`--list` names the scenarios).
- On a pull request: label it `review:ready-for-human` and read the `e2e` check; its artifact `e2e-evidence` holds the folders.

## Driving it with sandbox.py

Preconditions:

- Go, tmux 3.1 or newer, git and a Python 3.9 (`python3.9` on the `PATH`, `uv python find 3.9`, or `--python`), and `python3 tests/e2e/agent_manager.py install` printed `"ok": true`.
- The change under test is committed: the driver launches its own sandbox with `sandbox.py launch` and drives committed `HEAD` (`--allow-dirty` while iterating).

- **The happy run.** Run `python3 scripts/e2e.py --scenario triage-happy --evidence <folder>`. Exit `0`; `<folder>/verdict.json` has `"ok": true` and eight checks, each `"ok": true`: a run started, it ended at its end state, the fake Jira shows the status the graph sets, every role step has one session, the sessions follow the status, every Jira call carried the credentials, the entry gate admitted the run, and Agent Manager found `claude` under a job's PATH; `passes.jsonl` shows the Jira status reaching `Ready`.
- **The stopped run.** Run `python3 scripts/e2e.py --scenario undeclared-output --evidence <folder>`. Exit `0`; `verdict.json` has five checks passing (a run started, it stopped at `sign_off`, within 25 minutes, `runner.log` names the refused output, and every Jira call carried the credentials), and `<folder>/logs/runner/runner.log` names `made_up_extra`.
- **A laptop failure.** Run `python3 scripts/e2e.py --scenario bad-model-map --evidence <folder>` (or `permanent-refusal`, `triage-revise`, `ledger-record-pace`). Exit `0`; `verdict.json` lists each check passing. `ledger-record-pace` takes about five real minutes (two passes in which ledger-record uses its whole 150-second budget); the others take under a minute.
- **Everything at once.** Run `python3 scripts/e2e.py --all --evidence <folder>`. `<folder>/summary.json` lists each scenario with `ok` and its failed checks; each scenario's evidence is in `<folder>/<scenario>/`.
- **A second look.** `<folder>/<scenario>/report.txt` is the runner's own report of the run, `jira/calls.jsonl` every Jira call the laptop made, and `agent-manager/sessions.json` the sessions as Agent Manager lists them.

## Gotchas

- A dirty checkout makes `sandbox.py launch` refuse, so the driver exits `2`; commit first or pass `--allow-dirty`, and keep the evidence folder outside the checkout when running `--all` (the second launch would see the first's files).
- The laptop's own `graphs/runner/starts.json` has the triage rule off; the scenario's `starts` block switches it on for the sandbox only, through `JOSH360_RUNNER_STARTS`.
- Only Python clocks move (`tests/e2e/clock/`); Agent Manager's own timestamps stay real.
- The sandbox's `jp-117-triage-jp-116` job fails harmlessly every pass ("JP-116 could not be read"): the fake Jira holds only made-up tickets.
- `--keep` leaves the sandbox and its Agent Manager running; `python3 tests/e2e/agent_manager.py down --root <sandbox root>` stops it.
