# Leads guide: where is a ticket?

## Contents

- [Who this is for](#who-this-is-for)
- [Where is JP-n](#where-is-jp-n)
- [What is waiting on Josh](#what-is-waiting-on-josh)
- [Why did a ticket not start](#why-did-a-ticket-not-start)
- [What did JP-n cost](#what-did-jp-n-cost)
- [Reading the answer](#reading-the-answer)
- [What this cannot answer yet](#what-this-cannot-answer-yet)

## Who this is for

Josh's sprint lead and epic leads answer Josh's questions about tickets and graph runs (Josh, 19 November 2026: the leads are the coordinators; there is no separate coordinator session and none per ticket). This page lists the commands that answer the usual questions. Every command here is read-only. JP-172 built them.

Two places to ask from:

- **On the laptop** (a lead session on Josh's MacBook): `python3 ~/.josh-360/repo/graphs/runner/runner.py ...`. It reads the ledger, so it sees every run and its cost.
- **From the cloud** (any session with the josh-360 repository): `python3 laptop/status.py show graph-runner` prints the runner's last published report from the `laptop-status` branch, about five minutes old at best and only while the laptop is on. The report carries no cost and no text from a run.

Leads may show Josh the cost (Josh: "there's nothing that needs to be hidden from the coordinator"). Cost is only on the laptop, because the published report is pushed to a branch.

## Where is JP-n

On the laptop:

```bash
python3 ~/.josh-360/repo/graphs/runner/runner.py where JP-116          # a page Josh can read
python3 ~/.josh-360/repo/graphs/runner/runner.py where JP-116 --json   # the same, as data
```

It lists every run on the ticket, newest first. For each run: the graph, the step it is at and that step's Jira status (from the graph's `header.jira`), the attempt, the state and since when, what it is waiting on, and a table of every step with its attempt, tier, model, Claude Code session, Agent Manager session, outcome and cost. A ticket no graph has touched answers "No graph has run on JP-116." and exits 0. A key that is not a ticket key exits 2.

From the cloud, save the report and ask the same question of it:

```bash
python3 laptop/status.py show graph-runner > /tmp/graph-runner.json
python3 graphs/runner/runner.py where JP-116 --from-json /tmp/graph-runner.json
```

The published report keeps one row per ticket that has an open run, a run that ended in the last 14 days, or a refused start in that time (the `tickets` list). Each row is the ticket's newest run, with `runs` saying how many runs the laptop knows about. To read it by hand, look for the ticket in `tickets`; `ticket_counts` says how many rows and refusals there are.

## What is waiting on Josh

- On the laptop: `runner.py status` lists every open run with its state; `parked` means a question to Josh is in Needs you, `stopped` means the run needs Josh to retry or allow a step.
- From the cloud: in the published report, every `tickets` row whose `waits_on.kind` is `question` (a question to Josh), `cap` (a step ran as often as its tier allows) or `stop` (a step failed and the run stopped). `waits_on.since` says since when. `waiting_over_7_days` lists runs that have waited on a check (a review, a merge) for more than a week.

`waits_on.kind` is one of:

| Kind | Means | Who moves it |
| --- | --- | --- |
| `question` | The run is parked at an ask step; the question is in Josh's Needs you tab. | Josh answers it. |
| `check` | The run waits on a wait step: `a review`, `the pull request to merge`, `the validation watch`, `the fix ticket to close`. | The world; the runner looks every five minutes. |
| `cap` | A step ran as often as its tier allows. | Josh: `walker.py allow --run <id> --step <step>`, or retry. |
| `stop` | A gate failed and the walker stopped the run. `where` on the laptop shows the reason; the published report does not. | Josh: fix the cause, then `walker.py retry --run <id>`. |
| `session` | A role step is waiting for a free Agent Manager session (the runner starts two at a time). | The runner. |

## Why did a ticket not start

When the walker refuses to start a run (the ticket is in the wrong status, an input is missing), the Jira watch keeps the walker's reason, cut to 200 characters, in `~/.josh-360/state/runner/refusals.json`. It shows:

- in `where JP-n` as "Refused: <graph> would not start, last seen <time>: <reason>";
- in `runner.py status` as "Refused: JP-n <graph> ...";
- in the published report, in that ticket's `refused` list.

A refusal disappears when a run of that graph starts on the ticket, or 14 days after it was last seen (`ended_runs_days` in `graphs/runner/settings.json`). A ticket the watch skipped for another reason (no route record, routed elsewhere, already has an open run) is in the published report's `watch` object, by graph, as a fixed word.

## What did JP-n cost

On the laptop only:

- `runner.py where JP-n` shows each step's cost, a total for each run and a total for the ticket. A session that did several steps shows its whole cost on each of its rows, and is counted once in the totals.
- `python3 ~/.josh-360/repo/ledger/measures.py ticket JP-n` (JP-170) is the full account: every session homed to the ticket, including the ones that did no graph step, with its subagents rolled in (`--json` for the data).
- `runner.py report --run <id>` is one run's step table with the cost column.

"not priced yet" means the session has no price recorded yet; the cost import fills it in later.

## Reading the answer

- **Jira status** is what the graph's header says that step's status is. The walker moves the ticket there when the step has a `move_ticket` effect; if Jira disagrees, the move failed (see the runner log).
- **State**: `working` (a session is running the step), `queued` (it waits for a session slot), `parked` (a question to Josh), `waiting` (a check), `stopped`, `between` (the next `advance` picks the next step), `ended` (with its end name and score: `success`, `neutral` or `needs-josh`), `unreadable` (the run folder is gone).
- **Attempt** counts tries of the current step; an abandoned attempt's row says why (`never-started`, `session-gone`, `time-cap`, `rested-without-result`, ...).
- Every session the run started is listed, including the abandoned ones, with both its Claude Code and its Agent Manager session id.

## What this cannot answer yet

- Agent Manager groups by Jira status and session names such as `JP-116(c) - Build` are JP-173.
- Worktrees and branches a run left behind are JP-174.
- Stopping a run, sending it back to design, or leaving it a note are JP-177.
