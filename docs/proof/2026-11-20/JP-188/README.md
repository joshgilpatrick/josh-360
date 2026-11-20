# JP-188 proof: a whole graph run in the cloud

## Contents

- [What was run](#what-was-run)
- [Scenario to proof](#scenario-to-proof)
- [What the run found](#what-the-run-found)

## What was run

In a cloud session on 20 November 2026, on the branch's committed `HEAD` (no `--allow-dirty`): `python3 scripts/e2e.py --all --evidence <folder>`, with Agent Manager 0.47.1 built by `tests/e2e/agent_manager.py install`, tmux 3.4, the stand-in `claude`, the strict fake Jira and the laptop's jobs on Python 3.9. No model was called; every ticket is made up (JP-9116 and a JP-94 stub). It exited `0`; [`e2e/summary.json`](e2e/summary.json) lists both scenarios as passed. Each took 4 passes: 20 minutes of e2e time and about 15 seconds of real time.

Each scenario's folder holds `verdict.json` (the checks and what each saw), `passes.jsonl` (one line per pass: e2e minutes, run, Jira status, sessions, what each job did), `logs/` (with `runner/runner.log`), `run/`, `report.txt`, `jira/calls.jsonl`, `agent-manager/` and `sandbox/`.

`python3 scripts/check.py` (the full suite: 1,423 tests, with Agent Manager installed) passed after the changes below; the driver's own tests are `tests/test_e2e_driver.py`.

## Scenario to proof

| Scenario (`@auto`) | Proof |
| --- | --- |
| triage-happy: the run ends at its end state, every role step has one session, the fake Jira shows the status the graph sets | [`e2e/triage-happy/verdict.json`](e2e/triage-happy/verdict.json): ended `finished`; one spawn and one Agent Manager session (`JP-9116(a) - Sign Off`) for the one role step `sign_off`; the fake Jira shows `Ready`, and [`jira/calls.jsonl`](e2e/triage-happy/jira/calls.jsonl) has the transition. [`report.txt`](e2e/triage-happy/report.txt) is the runner's own report. |
| The sessions follow the ticket's status | The same verdict's last check: every pass the live session sat in the group for the ticket's status at that pass ([`passes.jsonl`](e2e/triage-happy/passes.jsonl)), and at the end the finished session was killed and filed in `josh-360/completed-steps` (JP-191's design) while the ticket's group is `josh-360/tickets/Ready`. |
| An undeclared output stops the run at that step, with `runner.log` naming it | [`e2e/undeclared-output/verdict.json`](e2e/undeclared-output/verdict.json): stopped at `sign_off` after 20 e2e minutes; [`logs/runner/runner.log`](e2e/undeclared-output/logs/runner/runner.log) says three times `step 'sign_off' does not declare the output 'made_up_extra'`. The ticket asked for 10 minutes; the bound is 25, because each refused result is a run of the mid tier's cap of 3 (`docs/decisions/JP-188.md`). |
| A ready PR gets an `e2e` job that passes or fails, with its evidence uploaded | The `e2e` job in `.github/workflows/test.yml`; its run on this pull request and the `e2e-evidence` artifact are linked from the PR. |

## What the run found

Two gaps in the product, both fixed here and recorded in `docs/decisions/JP-188.md`:

- Triage's ready check (C8) refused the runner's own start label `ready-to-run`, so every labelled triage run stopped at its ready check.
- Triage's exit gate stops each run until the recorder has written the last session, and nothing tried it again (the JP-161 follow-up). The runner now retries a gate stop that may clear (exit 1, or a time-out) on growing gaps; pass 2 in [`passes.jsonl`](e2e/triage-happy/passes.jsonl) shows the stop and pass 3 the run ending.
