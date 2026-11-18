# JP-161 proof: the no-loose-ends exit gate

## Contents

- [Done when](#done-when)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Done when

Every repository in these tests is real git in a temporary folder, and every run, session, branch, ticket and pull request is made up. Jira and GitHub answers are fakes.

| Done when | Proof | Tests |
| --- | --- | --- |
| The gate runs `ledger/loose_ends.py` for the run's sessions and passes when nothing is loose | `01-gate-tests.txt` | `Passes.*` in `graphs/tests/test_gate_no_loose_ends.py`; `test_the_script_reads_the_real_ledger` runs the script as the walker does |
| It fails with the list when something is loose (the list in `<run>/work/loose-ends.md`, counts in the summary) | `01-gate-tests.txt` | `Fails.*` (unpushed branch, open pull request, other ticket not Done, a subagent's branch, a leftover worktree) |
| An unreadable ledger fails (unknown is not empty), and so does anything else unknown | `01-gate-tests.txt` | `UnknownIsNotEmpty.*` (missing ledger, a file that is not a database, run not in the ledger, step with no session, session not recorded yet, `gh` or Jira not answering) |
| A triage run walked by the real walker reaches `finished` through the real gate | `02-triage-run-tests.txt` | `graphs/tests/test_triage_run.py`: the run stops at the exit until the sign-off session is recorded, then a retry finishes it |
| `graphs/gates/README.md` describes the gate, and the graphs compile | `03-checks.txt` | `compile_graphs.py --check`, `scripts/check.py` |

## What still needs the laptop

- One real triage run end to end with the runner: the gate should stop at the exit until the recorder has written the sign-off session (up to about 35 minutes), and `walker.py retry --run <id>` should then finish it.
