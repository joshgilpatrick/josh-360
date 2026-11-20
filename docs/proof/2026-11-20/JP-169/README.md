# JP-169 proof: one real ticket watched from Deployed to Done

## Contents

- [Result](#result)
- [The scenario](#the-scenario)
- [Timeline](#timeline)
- [The start comment and the evidence table](#the-start-comment-and-the-evidence-table)
- [The run's step table](#the-runs-step-table)
- [Laptop checks owed after the build](#laptop-checks-owed-after-the-build)
- [What the run showed was broken or slow](#what-the-run-showed-was-broken-or-slow)
- [Sources](#sources)

## Result

The watch on JP-167 ended as **met**. Josh's laptop picked JP-167 up from Deployed, checked it on its hourly timetable, and moved it to Done with the evidence table in its last comment. Every step of the run was a gate: no step had a session or a model. Nothing needed Josh at the keyboard.

Plan task 16 of `docs/superpowers/plans/2026-11-18-post-deploy-validation.md`. Everything below was read from the cloud: Jira (comments and status history) and the `laptop-status` branch (`reports/graph-runner.json`, `reports/doctor.json`). Counts, codes and ids only.

## The scenario

```gherkin
@e2e
Scenario: One real ticket is watched to Done on the laptop
  Given a JP ticket with a Validation section, merged and in Deployed
  When the graph runner runs on Josh's laptop until the watch completes
  Then the ticket is Done with the evidence table in its last comment
  And the run made no model call
```

| Line | What showed it |
| --- | --- |
| Given | JP-167 merged (PR #73, 151ca23) and moved to Deployed at 2026-11-19 03:49:30Z. Its Validation section: Needed yes, starts at Deployed, a check every 1 hour, complete when 3 checks in a row pass, give up after 3 days; two measured criteria (`job graph-runner`: `last_exit` is 0 and `hours_since_run` at most 1; `doctor graphs.validation-watch`: `status` is pass) |
| When | Validation run `r-1e4ba9ad7579` started on the laptop at 2026-11-19 22:38:22Z and reached step `watch` at 22:38:26Z |
| Then | JP-167 moved Deployed → Done (resolution Done) at 2026-11-20 04:58:21Z; its last comment (21304, 04:58:20Z) starts `Validated in production` and holds the evidence table |
| And | Every row of the run's step table is a `gate` with no model and no session (table below) |

## Timeline

All times UTC (Pacific is 8 hours behind).

| Time | Event | Source |
| --- | --- | --- |
| 2026-11-19 03:49:30 | JP-167 moved Code Review → Deployed by its merging thread | JP-167 status history |
| 2026-11-19 04:13 to 22:22 | Every runner pass skipped JP-167 as `not admitted`: the gate scripts could not find the Jira email. JP-171 fixed that (PR #75, 68b42b2) | `graph-runner.json` at f5f59a1 and ece72ec |
| 2026-11-19 22:22:35 | The doctor's daily report: `graphs.validation-watch` pass, "rule on; 0 watches open, none overdue" | `doctor.json` |
| 2026-11-19 22:38:22 | Run `r-1e4ba9ad7579` started (`_entry` pass) | `graph-runner.json` at 4cfe9bf |
| 2026-11-19 22:38:25 | `read_criteria` → `watch`, `start_watch` → `started`; start comment 21279 posted | report, JP-167 comments |
| 2026-11-19 22:38 to 2026-11-20 04:58 | Four checks; met on check 4 of round 1 | evidence comment 21304 |
| 2026-11-20 04:58:20 | Evidence comment 21304 | JP-167 comments |
| 2026-11-20 04:58:21 | JP-167 Deployed → Done | JP-167 status history |

**Deployed to Done: 25 h 9 min.** Of that, 18 h 49 min was the wait for admission (the JP-171 defect, now fixed) and 6 h 20 min was the watch itself, from start to the move to Done.

## The start comment and the evidence table

Start comment (21279):

> Watching this change in production | 2 criteria; a check every 1 hour; complete when 3 checks in a row pass; gives up after 3 days | next gate: first check due 2026-11-19 18:38.

The due time is the laptop's local time (Eastern, 23:38Z), and the comment does not say so. Josh reads Jira in Pacific time, where 18:38 is 02:38Z the next day.

Evidence comment (21304):

> Validated in production | 3 checks in a row pass, reached on check 4 of round 1 | next gate: none.

| Criterion | Checks | Passed | Failed | Unknown | Last reading |
| --- | --- | --- | --- | --- | --- |
| The graph runner keeps running with the validation rule on | 4 | 3 | 1 | 0 | `last_exit` 0, `hours_since_run` 0.26 |
| The doctor finds the watch healthy | 4 | 4 | 0 | 0 | `status` pass |

The one failed check is on the graph-runner criterion. The runner always exits 0 (`graphs/runner/tick_job.py`), so the failing reading was `hours_since_run` above 1. The runner's report shows no pass between 22:54Z and 01:49Z, which fits a laptop asleep for about three hours: the first check after waking read a runner last seen hours earlier. That is an inference from the timestamps; the check log itself stays on the laptop. The watch did what the design asks: one failure broke the streak, it did not end the watch (fail after is 3 in a row), and three passes in a row then met it.

## The run's step table

Output of `python3 graphs/runner/runner.py report --run r-1e4ba9ad7579 --from-json <graph-runner.json at 4d7105f>`, also saved as `01-step-table.md`.

Ended: finished (success)

| Step | Kind | Attempt | Loops | Tier | Model | Session | Cost | Agent Manager session | Outcome | Why it ended | Jira status | Started | Ended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _entry | gate | 1 | 0 |  |  |  | - |  | pass |  |  | 2026-11-19T22:38:22Z | 2026-11-19T22:38:23Z |
| read_criteria | gate | 1 | 0 |  |  |  | - |  | watch |  | Deployed | 2026-11-19T22:38:23Z | 2026-11-19T22:38:24Z |
| start_watch | gate | 1 | 0 |  |  |  | - |  | started |  | Deployed | 2026-11-19T22:38:24Z | 2026-11-19T22:38:25Z |
| watch | gate | 1 | 0 |  |  |  | - |  | met |  | Deployed | 2026-11-20T04:58:19Z | 2026-11-20T04:58:19Z |
| verdict | gate | 1 | 0 |  |  |  | - |  | met |  | Deployed | 2026-11-20T04:58:19Z | 2026-11-20T04:58:19Z |
| close | gate | 1 | 0 |  |  |  | - |  | closed |  | Done | 2026-11-20T04:58:19Z | 2026-11-20T04:58:22Z |
| _exit | gate | 1 | 0 |  |  |  | - |  | pass |  |  | 2026-11-20T04:58:22Z | 2026-11-20T04:58:23Z |

Cost is not in a published snapshot; run `report --run <id>` on the laptop to see it.

Seven rows, all `gate`: no row has a model, a session or an Agent Manager session, and the run ended `finished (success)`. That is the proof of "the run made no model call". The `watch` step is a wait in the graph, but the ledger records it as one gate row, stamped at the moment the watch ended (04:58:19Z), not at 22:38 when the run started waiting. The hours in between are in the check log on the laptop.

## Laptop checks owed after the build

The table in the plan's "Laptop checks owed after the build", with what each showed.

| After | Check | What it showed |
| --- | --- | --- |
| JP-166 | A report job's local copy exists | **Yes.** The `doctor` collector read `status pass` on all 4 checks, from the doctor report's local copy |
| JP-167 | The start rule is live | **Yes.** `watch.validation.jira` is `ok` in every report since 2026-11-18 23:13 EST |
| JP-167 | The doctor knows the watch | **Yes.** `graphs.validation-watch` is `pass` in the 22:22:35Z daily report ("rule on; 0 watches open, none overdue", 16 minutes before the first run started) |
| JP-167 | Nothing was waiting in Deployed | **As expected, with a change since the plan was written.** By the first pass that admitted runs, JP-171, JP-172 and JP-175 were also in Deployed: each was moved there by its own merging thread under `docs/WORKFLOW.md` §5.1, with a Validation section. The first pass started only JP-167 (`per_pass` 1). The others started on later passes (JP-171 22:54Z, JP-172 01:49Z, JP-173 02:05Z, JP-174 02:21Z, JP-175 02:36Z), and all six went to `watch`. No ticket was swept to Done as "Nothing to watch" (`ended_runs` was empty until JP-167 finished) |
| JP-167 | The watch is off the seven-day list | **Yes.** `waiting_over_7_days` is empty in every report while JP-167 sat in `watch` |
| JP-168 | The first graph hand-over | **Not observed yet.** No development run has ended (the development rule started nothing), so no graph has handed a ticket to Deployed. All six tickets in Deployed got there by a thread. Owed to the first development run of a ticket whose section says "Needed: yes" |
| JP-165 | Old tickets at the Ready check | **Partly observed.** JP-116 (written before this build, in Jira as Not Started) went through triage run `r-4400caa5965b`: `ready_check` → `gaps`, then `revise`. The published report does not say which item failed. The run is now stopped at its cap after three `spawn-refused` attempts at `revise`, which belongs to JP-117's proof run, not to validation |

## What the run showed was broken or slow

- **The laptop runs its 5-minute jobs about every 15 minutes.** Filed as **JP-181** (Bug). Run starts and steps landed about 15.5 minutes apart. The doctor's report shows `ledger-record` (due every 5 minutes, 10-minute timeout, run before `graph-runner`) failing with exit 124, the runner's timeout code. A job that runs to its 10-minute timeout on every pass fits that spacing. JP-167's goal promises pickup within five minutes, and every step of every graph waits on these passes.
- **Pickup from Deployed is one ticket per pass.** With six tickets waiting, JP-175 (Deployed at 22:19Z) started at 02:36Z, 4 h 17 min later, about 3 h of it with the laptop asleep. `per_pass` is a JP-117 choice and is not changed here. Recommendation: once JP-181 restores 5-minute passes, check whether the queue still matters. If it does, let validation runs (no model, a few gate calls each) start outside the one-per-pass limit. That would be a new ticket for Josh to decide.
- **The start comment's due time has no time zone** (above). Recommendation: write it in UTC with a `Z`, or name the zone. Too small for its own ticket. Noted here for the next change to `graphs/gates/lib/validation_copy.py`.

## Sources

- Jira: JP-167 comments 21224, 21279 and 21304, and its status history; the status histories of JP-174 and JP-175.
- `laptop-status` branch: `reports/graph-runner.json` at f5f59a1, ece72ec, 4cfe9bf, 60a69ab, 1754808, 914b860, 04a5028, a9c68c8, 7d918de, 04b4381, fe0f584, c4925cd and 4d7105f; `reports/doctor.json` (2026-11-19 22:22:35Z).
- Step table: `python3 graphs/runner/runner.py report --run r-1e4ba9ad7579 --from-json <graph-runner.json at 4d7105f>`.
