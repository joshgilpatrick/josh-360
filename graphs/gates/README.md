# Gate scripts

`<gate>.py` or `<gate>.sh`. Inputs arrive as `GRAPH_INPUT_<NAME>` environment variables; the script prints one JSON line with `outcome`, and optionally `outputs` and `summary`. No model. Only gate scripts move tickets or set labels. See `graphs/CONVENTION.md`, "Gate scripts".

## How the non-development gates are written (JP-123)

Each is a `run(inputs, deps)` function and a four-line `__main__` that calls `lib/gate_run.execute`. `run` returns `(outcome, outputs, summary)` and reaches Jira, the desk mailer and the draft tool only through `deps`, so a test calls it with fakes and no network; a gate that needs no Jira (`gap-check` when it is clear, `sign-off-rule`) never builds a client. A gate that cannot finish raises `GateError`, which exits 1: the walker stops the run and never retries it. Every comment passes the patient-data screen (`lib/patient_data.py`) before it is written, and a gate run again after a crash does not repeat a comment its newest comment already says.

| File in `lib/` | What it holds |
| --- | --- |
| `gate_run.py` | `execute`, `GateError`, `Deps`, `say` (screened comment, once) |
| `ticket_port.py` | `JiraPort` (the five ticket calls over `lib/jira.py`) and the Outlook draft |
| `ticket_text.py` | a ticket's sections, search words, quote matching |
| `evidence.py` | the evidence file's front block, with the standard library only |
| `artifacts.py` | where a deliverable may live |
| `nondev_copy.py` | the graph's exact comment and email copy |

## The development gates (JP-115)

`read-dev-ticket`, `prepare-worktree`, `question-route`, `lint-spec`, `verify-build`, `cite-check`, `open-pr`, `queue-audit`, `review-state`, `after-fix`, `merge-rule`, `merge-pr`, `pr-merged`, `clean-up` and `close-unmerged` run the development graph; `return-to-triage`, `check-review`, `close-ticket` and `move-ticket` (JP-123) also serve it. Written like the non-development gates. `review-state` and `pr-merged` are the two `wait` gates: they only read, and answer `pending` until the event happens. GitHub is reached through `deps.github(repo)` (`lib/dev_github.py`, over `gh`), git through `lib/dev_git.py`. The graph's working files live in `$JOSH360_RUNS/<run>/work/`, never in a worktree.

| File in `lib/` | What it holds |
| --- | --- |
| `dev_spec.py` | reading the build spec (YAML's JSON form), its shape checks, `state.json` |
| `dev_git.py` | the git calls: clone lookup, worktrees, push, diff, removal that never forces |
| `dev_github.py` | the GitHub port: pull request, labels, checks, comments, merge |
| `dev_checks.py` | running a phase's checks with a clean environment and a time budget; feedback and evidence files |
| `dev_review.py` | the audit round: cursor, verdict, finding count, check state, staleness |
| `dev_copy.py` | the graph's exact comment copy |
| `feedback.py` | the feedback file format shared with `check-review` |

## The triage gates (JP-122)

`triageable` (entry), `ticket-facts`, `ready-check`, `route`, `check-sign-off`, `triage-verdict`, `apply-revision`, `post-question`, `send-back` and `mark-ready` run the triage graph; `ready` is the entry gate of the development and non-development graphs. They are written like the non-development gates (`run(inputs, deps)` and `execute`). The read gates never write; only `apply-revision`, `post-question`, `send-back` and `mark-ready` write to a ticket, `send-back` and `post-question` only comment, and `mark-ready` is the only status move. Their parts live in `lib/triage/`:

| File in `lib/triage/` | What it holds |
| --- | --- |
| `ticket.py` | a ticket as the checklist reads it: strict bold-label sections and the version hash |
| `checklist.py`, `gherkin.py` | the Ready checklist, one function per item |
| `route.py`, `registry.py` | the routing table and the repository registry lookup |
| `signoff.py`, `verdict.py` | the sign-off defect filter, the verdict and the return count |
| `copy.py` | every comment, word for word from the spec |
| `port.py`, `runs.py`, `times.py` | reading a ticket and its history; the run folder and the ledger; comparing times |
