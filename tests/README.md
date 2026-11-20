# Tests

The repository's tests, standard library `unittest` only, run by `python3 scripts/check.py` (and by CI as the `suite` job). Every test works on made-up data in temporary folders: a bare repo stands in for GitHub, a temporary home for the laptop, and fakes for Jira, `launchctl`, `az` and Agent Manager. Nothing touches the real home folder, a real remote or real data.

## Contents

- [Running them](#running-them)
- [What is here](#what-is-here)
- [Other test suites](#other-test-suites)

## Running them

- Everything: `python3 scripts/check.py` (after `pip install -r requirements.txt`).
- One file: `python3 -m unittest discover -s tests -p 'test_ledger_record.py'`.
- The laptop's own Python: `cd tests && /usr/bin/python3 -B -m unittest test_install test_follow test_hooks` (on the Mac).

## What is here

- `test_<part>.py`: one file per part, named after it: `test_ledger_*` for `ledger/`, `test_install`, `test_follow`, `test_check_jobs` for `laptop/`, `test_hooks` and `test_*_hooks` for `hooks/`, `test_walker*` for the walker, `test_runner_*` for the graph runner, `test_doctor` for the platform doctor, `test_check_*` for `scripts/check.py`, and so on.
- `*_helpers.py`, `helpers.py`: shared builders for the made-up laptop, ledger, walker and runner (`helpers.py` makes the bare repo and the laptop home).
- `ledger_transcripts.py`: made-up Claude Code transcripts with no real conversation.
- `azure_fake.py`, `fakes/`: stand-ins for the Azure CLI and the `agent-manager` command.
- `e2e/` (JP-186): the real Agent Manager at the laptop's version, run with no screen, and a stand-in for Claude Code that calls no model (`e2e/README.md`). `test_e2e_agent_manager.py` drives the real binding through it and is skipped until `python3 tests/e2e/agent_manager.py install` has run; `test_e2e_standin.py` tests the stand-in on its own.

## Other test suites

- `graphs/tests/`: the graph checker's tests and every gate script's tests, run by `scripts/check.py` too.
- `apps/session-atlas/test/`: Session Atlas's own suite (`npm ci && npm test` in that folder, Node 22.18 or newer), run by CI.
- End to end on a sandbox laptop: the `verify-josh-360` skill (`.claude/skills/verify-josh-360/`).
