# JP-195 proof: a limit question says what stopped the run

## Contents

- [What broke](#what-broke)
- [What changed](#what-changed)
- [What Josh now reads](#what-josh-now-reads)
- [What was run](#what-was-run)

## What broke

JP-116's run `r-4400caa5965b` asked Josh: "JP-116 is still not Ready after the rounds allowed. Its remaining gaps are on the ticket." The revision had just closed every script gap. What really stopped the run was the drafter's run cap (JP-194), and the question did not say so.

## What changed

- The walker adds one line under every limit question saying why the run is there (`limit_reason` in `graphs/tools/walker_lib/runner.py`). It covers three cases: a step at its run cap, a loop at its limit, or the outcome that sends the run to the question. An ordinary question, such as the drafter's own `ask_josh`, gets no extra line.
- Triage's `ask_at_limit` question no longer claims that gaps remain on the ticket.
- The line holds only step names and counts. It goes where the question already goes: Needs you and the ledger. Nothing new goes to Jira or GitHub.

## What Josh now reads

For a made-up ticket JP-9116, the question says "JP-9116 is not Ready yet, and triage has reached one of its limits. The reason is below." The added line depends on what stopped the run:

| What stopped the run | The added line |
| --- | --- |
| Run cap | Why you are asked: `revise` has run 5 times against a cap of 3 plus 2 you allowed, and the run needs it again. One more round allows one more run. |
| Loop limit | Why you are asked: the run has gone from `apply_revision` back to `read_ticket` 2 times, the most this graph allows (2). |
| The verdict | Why you are asked: `verdict` ended with `exhausted`. |

## What was run

In a cloud session on 20 November 2026:

- `python3 -m unittest tests.test_walker_limit_reason`: 5 tests, one per case above, plus a run recorded by the older walker and an ordinary question.
- `graphs/tests/test_triage_run.py`, "two drafter rounds then Josh": the question written to the Needs you store names the verdict and does not mention gaps on the ticket.
- `python3 scripts/check.py` (the full suite): 0 problems.
