# JP-198 proof: a whole development run in the cloud

## Contents

- [What was run](#what-was-run)
- [Scenario to proof](#scenario-to-proof)
- [How the old code was put back](#how-the-old-code-was-put-back)
- [What is still a laptop check](#what-is-still-a-laptop-check)

## What was run

In a cloud session on 21 November 2026, on the branch's committed `HEAD` (42f4aa8, no `--allow-dirty`): `python3 scripts/e2e.py --all --evidence <folder>`, with Agent Manager 0.47.1, the stand-in `claude`, the new stand-in `gh`, the strict fake Jira and the laptop's jobs on Python 3.9. No model was called, nothing reached GitHub or Jira, and every ticket is made up (JP-9116 and a JP-94 stub). It exited `0`, and [`after/summary.json`](after/summary.json) lists all eight runs as passed, the seven from JP-188 to JP-194 and the new `dev-happy`.

`dev-happy` took 8 passes (40 e2e minutes) and 59 real seconds. Its folder [`after/dev-happy/`](after/dev-happy/) holds `verdict.json` (each check and what it saw), `passes.jsonl` (one line per five-minute pass, with every run on the ticket), `runner.log` and the stand-in gh's `github/calls.jsonl` (its 24 calls) and `github/state.json` (the merged pull request).

Pass by pass, from `passes.jsonl`:

| Pass | Jira status | Runs on JP-9116 |
| --- | --- | --- |
| 1, 2 | Design/Planning | development, open (designer, lint, harden) |
| 3 to 5 | In Progress | development, open (builder commits; verify; plan review; PR writer) |
| 6 | Code Review | development, open (PR opened and queued; waiting for the audit) |
| 7 | Deployed | development, `finished` (audit answered, merged, cleaned up, Validation, handed to the watch) |
| 8 | Deployed | development `finished`, and a validation run, open |

Also on 42f4aa8: `python3 scripts/check.py --fast` passed with 0 problems, and `JOSH360_E2E_AM=1 python3 -m unittest discover -s tests -t tests -p 'test_e2e_*.py'` ran 60 tests, all passing (the new `tests/test_e2e_standin_gh.py` drives every `dev_github.GitHub` method and `ledger/live.py`'s reads through the stand-in). CI runs the full suite.

## Scenario to proof

| Scenario (`@auto`) | Proof |
| --- | --- |
| A ready ticket reaches Deployed through a merged pull request | [`after/dev-happy/verdict.json`](after/dev-happy/verdict.json): the run ends `finished`; the fake Jira's changelog shows Ready, Design/Planning, In Progress, Code Review, Validation, Deployed, each a move the JP snapshot allows; the stand-in gh created one pull request from `JP-9116-add-a-made-up-chores-page` and merged it onto `main`; and no gh call was one it did not know. |
| The hand-over starts a validation run | The same verdict: the development run ended in pass 7 and the validation run `r-fe441ba1d6e1` was first seen in pass 8, still open. |
| Nothing is left behind | The same verdict: no worktree, folder, local branch or stand-in GitHub branch starting `JP-9116-` remains. |
| The scenario fails on the old code | [`before/377d0a1-mutant/verdict.json`](before/377d0a1-mutant/verdict.json): exit 1. The hand-over check says `"validation_runs": "none: the missing validation run"` (the run ended in pass 9, and no validation run started), the ticket stopped at Validation instead of Deployed, and its Jira path ends at Validation. The control, [`before/377d0a1-control/verdict.json`](before/377d0a1-control/verdict.json), passes every check on the same old code with the step still in. |

## How the old code was put back

377d0a1 has no stand-in `gh`, so the scenario cannot run there as it stands. In a throwaway worktree at 377d0a1, the new harness was laid over it as one commit: `tests/e2e/standin/gh`, the stand-in `claude` with `commit`, `scripts/e2e.py`, `tests/e2e/runs/dev-happy.json` and its two scenario files. That commit is the control. The mutant is the control with the `hand_to_watch` step taken out of `graphs/flows/development.yaml` (the step itself, the last one in the file; its row in the Deployed status group; and its line in the role map, so `validation_rule`'s `watch` outcome leads nowhere) and `graphs/tools/compile_graphs.py` run again, so the compiled graph has no hand-over. Both ran `python3 scripts/e2e.py --scenario dev-happy`; the worktree was removed afterwards. Each folder under `before/` holds that run's `verdict.json`, `passes.jsonl`, `runner.log` and `github/calls.jsonl`.

## What is still a laptop check

Real model output, real GitHub (its checks and the laptop's real PR audit in action-triage, which the stand-in plays a pass after the trigger label), and Josh's `gh` sign-in. The JP-116 proof run on the laptop remains the check for those.
