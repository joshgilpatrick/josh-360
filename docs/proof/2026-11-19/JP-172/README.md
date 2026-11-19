# JP-172 proof: where is this ticket?

## Contents

- [What was proved](#what-was-proved)
- [Scenarios](#scenarios)
- [Sandbox laptop run](#sandbox-laptop-run)
- [Not proved here](#not-proved-here)

## What was proved

`runner.py where <KEY>` answers where a ticket is in its graphs, the published `graph-runner` report carries a `tickets` list and `ticket_counts` with no cost in them, and a refused start's reason is kept and shown. Made-up tickets, sessions and prices only. Run on 19 November 2026 in a cloud session.

## Scenarios

Unit test output: [`unit-tests.txt`](unit-tests.txt) (`python3 -m unittest -v test_runner_where test_runner_report_cost`, 23 tests, all ok). The fixture graph `valid` stands in for the development graph: it maps `build` to In Progress and has `approve_spec` as a question to Josh.

| Scenario | Proof |
| --- | --- |
| A ticket mid-run | `test_runner_where.Where.test_a_ticket_mid_run`: graph, step `build` (Build), Jira status In Progress, attempt 2, and the design session with its model and its $4.10 cost, in the JSON and the page. `test_a_session_on_several_steps_is_counted_once_in_the_total` checks the total. |
| A ticket waiting on Josh | `test_a_ticket_waiting_on_josh`: parked at the ask step, "Waiting on a question to Josh, since <time>". Also `test_a_waiting_run_names_what_it_waits_for` and `test_a_run_stopped_at_its_cap_says_so`. |
| A ticket with no run | `test_a_ticket_with_no_run`: "No graph has run on JP-902." and exit 0; sandbox step `where-08-no-run.json`. |
| A refused start is explained in the cloud | `test_a_refused_start_is_explained_in_the_cloud` (the published row for JP-903 carries the walker's reason, no key names a cost, and `where --from-json` prints it) and `test_the_watch_keeps_a_refusal_and_clears_it_when_a_run_starts` (the Jira watch records the reason cut to 200 characters and clears it on a start). |
| The cloud copy never carries cost | `test_the_cloud_copy_never_carries_cost` (`ticket_counts.cost_fields` is 0, no key in the snapshot names a cost, and the $4.10 is absent) and `test_runner_report_cost.ReportCost.test_a_published_snapshot_has_no_cost_and_the_report_says_so`; sandbox steps `where-10` and `where-12`. |

## Sandbox laptop run

The `verify-josh-360` sandbox (`.claude/skills/verify-josh-360/`), run `jp172b`, drove commit `JP-172 Clearer where page ...` through the real install, the doctor, the walker and the job runner. Each file in [`verify-josh-360/`](verify-josh-360/) is one step.

| Step | File | What it shows |
| --- | --- | --- |
| Install and doctor | `launch-install.json`, `doctor.json` | The sandbox laptop installed cleanly and its doctor checks passed. |
| Start a run on JP-9001 | `where-01-start.json` | A `ticket-creation` run started by the walker for the made-up ticket JP-9001, runner `agent-manager`. |
| Where, before the first step | `where-02-before-first-step.json` | "Between steps since ..." and the entry gate row. |
| Where, at a role step | `where-03-next.json`, `where-04-at-read-intake.json` | "At Read intake (`read_intake`), attempt 1, Jira status Not Started: queued", waiting on a free session slot. |
| Where, after the run ended | `where-05-record.json`, `where-06-next-ends.json`, `where-07-ended.json` | "Ended route.personal (neutral) at Route", the session with its model, and "not priced yet" for its cost. |
| Where, no run | `where-08-no-run.json` | "No graph has run on JP-9002." and exit 0. |
| The job publishes | `where-09-run-jobs.json` | `graph-runner: report pushed` to the sandbox's stand-in for GitHub. |
| Read it from the cloud | `where-10-show-graph-runner.json`, `where-11-from-json.json` | `laptop/status.py show graph-runner` has the `tickets` row for JP-9001 and `ticket_counts` `{"cost_fields": 0, "listed": 1, "refusals_readable": true, "refused": 0}`; `where --from-json` prints the same page with a dash for cost. |
| What the validation watch reads | `where-12-local-report-counts.json` | `~/.josh-360/state/reports/graph-runner.json`, the file the `report` collector reads, has the same `ticket_counts`. |

The published row in `where-10` shows `"runner": null`; the commit after the sandbox run fills it with `agent-manager` (unit tests cover it).

## Not proved here

- A refusal from a real Jira watch: the sandbox has no Jira credentials, so the watch reports `no-credentials` and refuses nothing. The unit tests drive `watch.py` against the fake Jira instead. The validation watch (Needed: yes, from JP-117 Done) checks the real report in production.
- Cost from real priced sessions: the sandbox has no cost import; the unit tests price made-up sessions.
