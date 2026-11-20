# JP-194 proof: the run cap no longer stops the re-read after a revision

## Contents

- [What broke](#what-broke)
- [What changed](#what-changed)
- [What was run](#what-was-run)
- [Before and after](#before-and-after)
- [On the laptop](#on-the-laptop)

## What broke

JP-116's triage run `r-4400caa5965b` stopped on 20 November with a question to Josh. The drafter (`revise`) had used all three runs its tier allows, and its third run did revise the ticket. Then `apply_revision` tried to loop back to `read_ticket` to check the revised ticket. The walker refused that loop because `revise` was at its cap, although the loop starts `read_ticket` and the drafter runs again only if the re-check still finds gaps. So the revised ticket was never checked, and Josh got the "after the rounds allowed" question.

## What changed

The run cap is now held at the step, not at the loop back to it (`graphs/tools/walker_lib/engine.py`; the rule is in `graphs/CONVENTION.md`, "What the walker holds", and the walker design spec):

- The loop goes ahead. The re-read and the checks run.
- The ask waits for that step. If the re-check passes, the run carries on to Ready and nobody is asked. If it sends the ticket back to `revise`, the run goes to the same `ask_at_limit` question as before, at that moment, with the run as it was before the loop.
- The loop limit (`max_loops`) is still checked when the loop fires, unchanged.
- An older run that asked straight after the loop, like JP-116's, still replays, so Josh's `one_more_round` answer on the laptop works as before.

The cloud harness gained one scenario, `triage-revise-at-cap`, which plays JP-116's run: the drafter's first two runs write the wrong shape and its third revises. The stand-in plan can now give a step one scenario per attempt (`tests/e2e/README.md`).

## What was run

In a cloud session on 20 November 2026, on committed code, with Agent Manager 0.47.1, the stand-in `claude`, the strict fake Jira and the laptop's jobs on Python 3.9. No model was called, and the ticket is the made-up JP-9116.

- `python3 scripts/e2e.py --scenario triage-revise-at-cap` on this branch: exit 0.
- The same scenario on this branch with only `engine.py` put back to `main`'s (a throwaway commit in a separate worktree): exit 1.
- `python3 -m unittest tests.test_walker_cap_rule`: 5 tests pass on this branch; on `main`'s engine 2 of them fail (the re-read case and the replay case).
- `python3 scripts/check.py` (the full suite, with Agent Manager installed): 0 problems.

Each folder holds that run's `verdict.json` (the checks and what each saw), `passes.jsonl` (one line per five-minute pass) and `report.txt` (the run's step table as JSON).

## Before and after

| | Old engine ([`before/`](before/verdict.json)) | This branch ([`after/`](after/verdict.json)) |
| --- | --- | --- |
| `revise` | 3 runs: abandoned, abandoned, revised | 3 runs: abandoned, abandoned, revised |
| After `apply_revision` | Parks at `ask_at_limit`, like JP-116's run | Loops to `read_ticket`; the ready check passes; sign-off says ready |
| End | Never ends; stopped at the 120 e2e-minute limit | `finished` at 35 e2e minutes |
| Jira | Not Started | Ready |
| A fourth drafter run | none | none |

## On the laptop

Nothing new to check by hand. The `graph-runner` job picks the new engine up after the merge. JP-116's run stays parked until Josh answers `ask_at_limit`; his `one_more_round` re-reads the ticket under the new rule.
