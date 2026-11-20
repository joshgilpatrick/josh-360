# JP-190 proof: a cloud test for each laptop failure this week

## Contents

- [What was run](#what-was-run)
- [Failure to run](#failure-to-run)
- [Scenario to proof](#scenario-to-proof)
- [How the old code was put back](#how-the-old-code-was-put-back)

## What was run

In a cloud session on 20 November 2026, on the branch's committed `HEAD` (no `--allow-dirty`): `python3 scripts/e2e.py --all --evidence <folder>`, with Agent Manager 0.47.1, the stand-in `claude`, the strict fake Jira and the laptop's jobs on Python 3.9. No model was called, and every ticket is made up (JP-9116, a JP-94 stub, and 700 quiet made-up sessions on JP-20001 and up for the ledger run). It exited `0`. [`after/summary.json`](after/summary.json) lists all six scenarios as passed. `ledger-record-pace` took about five real minutes, and the others took under a minute each.

Then each new check was run against the code that had the bug, in a throwaway worktree (see [How the old code was put back](#how-the-old-code-was-put-back)). Every one of them failed there, and the reason it failed is the failure Josh saw on the laptop.

Each folder under `after/` and `before/` holds that run's `verdict.json` (the checks and what each one saw), `passes.jsonl` (one line per five-minute pass) and `runner.log`. The two ledger folders also hold the job-log stamps (`ledger-record-stamps.txt` and `graph-runner-stamps.txt`).

`python3 scripts/check.py` (the full suite, with Agent Manager installed) passed with 0 problems.

## Failure to run

| Failure on the laptop | Run that catches it | On the code that had it (`before/`) | On this branch (`after/`) |
| --- | --- | --- | --- |
| Empty `models` map in binding.json (fixed in 6b03062) | `triage-happy`, and `bad-model-map` for how it stops | [`before/empty-map-triage-happy`](before/empty-map-triage-happy/verdict.json): one spawn is refused with `model "claude-sonnet-5-5" is not one claude lists`, the run stops at `sign_off`, and the ticket stays Not Started | [`after/triage-happy`](after/triage-happy/verdict.json): it ends `finished` with Jira at Ready |
| A refusal that can never pass spends the tier cap, and the log says only "refused" (JP-183) | `bad-model-map`, `permanent-refusal` | [`before/jp183-bad-model-map`](before/jp183-bad-model-map/verdict.json) and [`before/jp183-permanent-refusal`](before/jp183-permanent-refusal/verdict.json): nine spawns, `sign_off` abandoned three times (cap spent), the stop arrives at 50 e2e minutes, and `runner.log` lacks Agent Manager's words | [`after/bad-model-map`](after/bad-model-map/verdict.json), [`after/permanent-refusal`](after/permanent-refusal/verdict.json): one spawn, a stop at 5 minutes, no attempt ended, and the log quotes Agent Manager |
| The revise result was refused for an output it does not declare (JP-184) | `triage-revise` | [`before/jp184-triage-revise`](before/jp184-triage-revise/verdict.json): `revise` abandoned three times, the run never ends, and Jira stays Not Started | [`after/triage-revise`](after/triage-revise/verdict.json): `revise` recorded `revised`, the run ends `finished` and Jira shows Ready |
| ledger-record holds up the five-minute jobs (JP-181) | `ledger-record-pace` | [`before/jp181-ledger-record-pace`](before/jp181-ledger-record-pace/verdict.json): graph-runner starts 604 s and 601 s into the two passes, because ledger-record ran until its job timeout killed it (exit 124) | [`after/ledger-record-pace`](after/ledger-record-pace/verdict.json): graph-runner starts 151 s and 150 s in, right after ledger-record's 150-second budget |
| Gates miss the Jira email in `state/jira-email` (JP-171) | `triage-happy` (`admitted`); every run has the email only there | [`before/jp171-triage-happy`](before/jp171-triage-happy/verdict.json): `start of triage for JP-9116 refused ... Jira credentials missing`, so no run starts | [`after/triage-happy`](after/triage-happy/verdict.json): the entry gate admits the run |
| `claude is not installed` under a job's PATH | `triage-happy` (`claude_found`); every run has `claude` only in `~/.local/bin` | [`before/path-triage-happy`](before/path-triage-happy/verdict.json): Agent Manager says `claude is not installed`, and the run stops at `sign_off` | [`after/triage-happy`](after/triage-happy/verdict.json): one spawn, exit 0 |

`undeclared-output` (from JP-188) still passes too: [`after/undeclared-output`](after/undeclared-output/verdict.json).

## Scenario to proof

| Scenario (`@auto`) | Proof |
| --- | --- |
| bad-model-map: the run stops after one spawn, and runner.log carries Agent Manager's message naming the model | [`after/bad-model-map/verdict.json`](after/bad-model-map/verdict.json): exactly one spawn, refused with `agent-manager: model "claude-sonnet-5-5" is not one claude lists`. [`runner.log`](after/bad-model-map/runner.log) says `stopped at sign_off: needs a fix (bad-model)` with those words. |
| permanent-refusal: the walker's run count for that step is 0 after the stop | [`after/permanent-refusal/verdict.json`](after/permanent-refusal/verdict.json): the walker's one `sign_off` attempt has no outcome, so 0 runs ended and none was spent against the cap of 3. The walker's `runs` field still shows 1, because it counts the open attempt. JP-183 leaves that attempt open on purpose, so the check counts attempts that ended (`docs/decisions/JP-190.md`). |
| triage-revise: the walker records revise with the outcome "revised" | [`after/triage-revise/verdict.json`](after/triage-revise/verdict.json): `{"step": "revise", "attempt": 1, "outcome": "revised"}`. The run goes on to end `finished`, with the ticket at Ready. |
| Two job passes with a ledger spool that keeps ledger-record busy past 150 s: graph-runner starts within 5 minutes of e2e time in each pass | [`after/ledger-record-pace/verdict.json`](after/ledger-record-pace/verdict.json): graph-runner starts 151 s and 150 s after each pass begins, and ledger-record ran for 151 s and 150 s ([`ledger-record-stamps.txt`](after/ledger-record-pace/ledger-record-stamps.txt), [`graph-runner-stamps.txt`](after/ledger-record-pace/graph-runner-stamps.txt)). |
| triage-happy with the email only in state/jira-email: the entry gate admits the run | [`after/triage-happy/verdict.json`](after/triage-happy/verdict.json): `the entry gate admitted the run` with no refusal in `runner.log`. All 45 Jira calls carried the credentials, and the fake Jira refuses a call without them. |

## How the old code was put back

Each "before" run used this branch's harness in a throwaway worktree, with only the fix taken out:

- **Empty map:** binding.json's `models` set back to `{}`, as it was before 6b03062.
- **JP-183:** that merge is too tangled with later work to revert, so this branch's harness files were laid over the code just before it merged (`80eef5e^1`).
- **JP-184:** `git revert dc12d16`.
- **JP-181:** `git revert e5329e2`.
- **JP-171:** the gate's Jira email read from the environment only, as before the fix.
- **PATH:** the binding's PATH addition taken out.
