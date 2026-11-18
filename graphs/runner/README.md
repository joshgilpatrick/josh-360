# Graph runner

## Contents

- [What it is](#what-it-is)
- [Seeing what it is doing](#seeing-what-it-is-doing)
- [Starting and stopping it](#starting-and-stopping-it)
- [Hosts: job or terminal](#hosts-job-or-terminal)
- [A run that stopped](#a-run-that-stopped)
- [Where the logs and files are](#where-the-logs-and-files-are)
- [Files in this folder](#files-in-this-folder)

## What it is

The graph runner (JP-117) takes a ticket that is Ready and carries the label `ready-to-run` from there to the end of its graph, with no one starting anything by hand. The job `graph-runner` runs `tick_job.py` every five minutes. Each pass reads Jira (read-only) against the rules in `starts.json`, starts at most one new run through the walker, and launches a detached `runner.py advance --run <id>` for every run that can move. `advance` asks the walker for the next step and does what it says: a gate runs, a question goes to Needs you, and a role step starts one visible Agent Manager session through the binding in `graphs/bindings/agent-manager/`. The session writes its outcome to the step's result file; the next `advance` records it and asks the walker again. The runner holds no graph logic, writes nothing to Jira, and makes no model call of its own. Python 3.9, standard library only.

Four hooks (`hooks/*/20-graph-step*`) put rails on those sessions and on no others: they link the session to its run, cap its tool calls and time, refuse questions to Josh and writes to Jira or GitHub, and nudge it once for its result. The shell rules read command text, so they narrow the obvious paths and are not a boundary (`hooks/README.md`).

## Seeing what it is doing

- On the laptop: `python3 ~/.josh-360/repo/graphs/runner/runner.py status` (add `--json`). It lists open runs with their step and state (`working`, `queued`, `parked`, `waiting`, `stopped`, `between`), live sessions against the limit, whether the four hooks are registered (`rails`), stopped runs, and every run that has waited more than seven days.
- From the cloud: `python3 laptop/status.py show graph-runner`. The report holds counts, ids, step names, outcomes and times only.
- One run's step table: `runner.py report --run <id>`, or from a published report: `runner.py report --run <id> --from-json <file>` (`--json` for the data). The published report keeps the runs that ended in the last 14 days.

## Starting and stopping it

- **Off switch:** `touch ~/.josh-360/state/runner-off` stops the Jira watch and every new session. A session already working finishes its step and is recorded; nothing after it runs. Remove the file to resume. A branch named `laptop-pause` pauses the whole job runner, this included.
- **One graph's starts off:** set its `"on": false` in `starts.json`. The shipped file has the development graph on and every other graph off.
- **Start a run by hand** (a repair, or a one-time job; never needed day to day): `runner.py start --graph <graph> --ticket <KEY> [--input name=value ...]`. It starts no session by itself; the next pass picks the run up, even with the off switch on.
- **How many at once:** `session_limit` in `settings.json` (2). Every number the runner uses is in that file.

## Hosts: job or terminal

`settings.json` has `host`. `job` (the shipped value, set from the probe's report) means the five-minute job does everything: a pass launches detached children that outlive it. `terminal` is the fallback for a laptop where a job cannot start sessions: start the loop once in an Agent Manager terminal with `python3 ~/.josh-360/repo/graphs/runner/runner.py loop`. The loop ticks every `tick_seconds` and writes a heartbeat; the job then only checks the heartbeat, reports `loop.stale`, and sends one notification when the loop has stopped, and again only after it has been fresh. `loop` refuses to start under host `job`, or when another loop is running.

## A run that stopped

A run stops when the walker says so (a step that ran as often as its tier allows, a gate that failed). The runner notifies once, the stop appears in `status` and the report, and nothing more happens to it until you act. Read the reason in `~/.josh-360/logs/runner/runner.log`. To carry on: `python3 graphs/tools/walker.py retry --run <id>` (the same step again) or `allow --run <id> --step <step>` (let a step run once more than its cap). A run that stops again afterwards is a new stop and is notified again.

## Where the logs and files are

- `~/.josh-360/logs/runner/runner.log`: one line per start, spawn, record, abandon and stop (ids, step names and reasons only).
- `~/.josh-360/logs/runner/run-<run id>.log`: the output of that run's detached `advance`.
- `~/.josh-360/state/runner/`: `report.json` (the last pass), the locks, and the heartbeat (terminal host).
- `~/.josh-360/runs/<run id>/`: the run folder: `run.json`, `sessions/<step>-<attempt>.json` (one per session; `.link.json` beside it is the link hook's), `results/`, `comments/`, `work/`, and `runner.json` (what has already been told).
- `~/.josh-360/state/graph-sessions/`: one small file per linked step session; the rails act only on a session that has one.

## Files in this folder

| Path | What |
| --- | --- |
| `runner.py` | `tick`, `advance`, `start`, `status`, `report`, `loop` |
| `tick_job.py` | the `graph-runner` job (always exits 0) |
| `triage_jp116_job.py` | the temporary job that starts the triage run of JP-116, the proof ticket |
| `starts.json` | which tickets get a run, per graph, and how many per pass |
| `settings.json` | every number the runner uses |
| `runner_lib/` | the Jira watch, the advance loop, the tick, locks, session files, the hook logic, status and notifications |
