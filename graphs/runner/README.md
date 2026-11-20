# Graph runner

## Contents

- [What it is](#what-it-is)
- [Seeing what it is doing](#seeing-what-it-is-doing)
- [Sessions in Agent Manager](#sessions-in-agent-manager)
- [Starting and stopping it](#starting-and-stopping-it)
- [Hosts: job or terminal](#hosts-job-or-terminal)
- [A run that stopped](#a-run-that-stopped)
- [Follow-ups and telling the leads](#follow-ups-and-telling-the-leads)
- [Where the logs and files are](#where-the-logs-and-files-are)
- [Files in this folder](#files-in-this-folder)

## What it is

The graph runner (JP-117) takes a ticket that is Ready and carries the label `ready-to-run` from there to the end of its graph, with no one starting anything by hand. The job `graph-runner` runs `tick_job.py` every five minutes. Each pass reads Jira (read-only) against the rules in `starts.json`, starts at most one new run through the walker, and launches a detached `runner.py advance --run <id>` for every run that can move. `advance` asks the walker for the next step and does what it says: a gate runs, a question goes to Needs you, and a role step starts one visible Agent Manager session through the binding in `graphs/bindings/agent-manager/`. The session writes its outcome to the step's result file; the next `advance` records it and asks the walker again. The runner holds no graph logic, writes nothing to Jira, and makes no model call of its own. Python 3.9, standard library only.

Four hooks (`hooks/*/20-graph-step*`) put rails on those sessions and on no others: they link the session to its run, cap its tool calls and time, refuse questions to Josh and writes to Jira or GitHub, refuse a second worktree or a new branch (the ticket has one of each, made by `prepare-worktree`; the message names them, JP-174, `runner_lib/gitrail.py`), and nudge it once for its result. The shell rules read command text, so they narrow the obvious paths and are not a boundary (`hooks/README.md`).

## Seeing what it is doing

- On the laptop: `python3 ~/.josh-360/repo/graphs/runner/runner.py status` (add `--json`). It lists open runs with their step and state (`working`, `queued`, `parked`, `waiting`, `stopped`, `between`), live sessions against the limit, whether the four hooks are registered (`rails`), stopped runs, and every run that has waited more than seven days, except a wait that is meant to last: `wait_flag_exempt` in `settings.json` names those as `<graph>.<step>` (the shipped one is `validation.watch`, which waits days for a change in production; the `await_fix` wait is still listed).
- From the cloud: `python3 laptop/status.py show graph-runner`. The report holds counts, ids, step names, outcomes and times only.
- One ticket, every run on it (JP-172): `runner.py where <KEY>` (add `--json`, or `--from-json <file>` for a published report): graph, step, its Jira status, state, attempt, what it waits on, every step session and its cost, and a total; with no run it says so and exits 0. The published report has a `tickets` list (one row per ticket with an open run, a run that ended in the last 14 days, or a refused start; no cost) and `ticket_counts` (`listed`, `refused`, `refusals_readable`, and `cost_fields`, which counts keys that name a cost and must be 0). When the walker refuses to start a run, the Jira watch keeps its reason (200 characters) in `~/.josh-360/state/runner/refusals.json` until a run of that graph starts on the ticket or 14 days pass. The leads' guide: `docs/leads-guide.md`.
- A stop that started no model (JP-183): `status` prints `needs a fix: <code>` or `stuck: <code>` beside it, and `where <KEY>` says what Josh does next.
- One run's step table: `runner.py report --run <id>`, or from a published report: `runner.py report --run <id> --from-json <file>` (`--json` for the data). Each step shows its cost, subagents included (`not priced yet` when its session has no price; a published report has none, JP-170). Each role attempt shows its Claude Code session, its Agent Manager session and, if the runner gave up on it, why (`never-started`, `session-gone`, `time-cap`, ...), so every session a run started is listed, including the ones it abandoned. The published report keeps the runs that ended in the last 14 days.

## Sessions in Agent Manager

JP-173. A ticket's step sessions sit in Agent Manager under `josh-360/tickets/<status>`, the Jira status of the step's stretch in the graph's `header.jira` (a `/` becomes `-`, so Design/Planning is `josh-360/tickets/Design-Planning`). Each is named `<KEY>(<letter>) - <Step>`, for example `JP-116(c) - Build`: the letter counts the ticket's sessions across all its runs and graphs, a to z, then aa, ab. Only sessions started since JP-173 are counted.

- **One in view per ticket.** When a ticket's session starts, its earlier sessions are archived; the newest stays in view after its result is recorded, so the ticket never disappears between steps. Agent Manager's archive lists all of them in letter order.
- **It follows the status.** After every answer from the walker, and on every tick, the runner reads the status the walker last set on the ticket's newest run (`jira_status` in `run.json`; never Jira) and moves the kept session to that group with `agent-manager move`.
- **Done leaves after 7 days.** When the ticket's newest run has ended with the ticket in Done, the tick archives the kept session `done_keep_days` (7) after that run ended.
- **Where it is kept:** `~/.josh-360/state/runner/am-tickets.json` (each ticket's count, status, group and sessions), written only by the runner under `am-tickets.lock`. A file that cannot be read starts no new ticket session (unknown is not empty); fix or remove it to go on. A move or archive that Agent Manager refused is tried again on the next pass.
- **Sessions with no ticket** (the ticket-creation graph's intake, decomposer and drafter) keep the old name `<graph> - <Step> (r<run>)`, sit in `josh-360/graph-runs`, and are archived when their result is recorded.
- **Check it:** `python3 ~/.josh-360/repo/scripts/doctor.py --only graphs` runs `graphs.agent-manager-groups`: pass when every ticket in view has one session, named for it, in its status group; skip when no ticket has a session in view.

## Starting and stopping it

- **Off switch:** `touch ~/.josh-360/state/runner-off` stops the Jira watch and every new session. A session already working finishes its step and is recorded; nothing after it runs. Remove the file to resume. A branch named `laptop-pause` pauses the whole job runner, this included.
- **One graph's starts off:** set its `"on": false` in `starts.json`. The shipped file has the development graph and the validation graph on and every other graph off. The validation rule (JP-167) has `"route_record": false`: it starts a run for any JP ticket in Deployed that is not flagged (`project = JP AND status = Deployed AND Flagged is EMPTY`), reads no route record or spec property, and takes only the ticket key. A rule with no route record may not name a route or an input sourced from `route.` or `spec.`; the file is refused at load if it does. Flagging a ticket in Deployed (the `hold-watch` step does it) keeps the runner from starting another run for it; clearing the flag starts a fresh watch.
- **Start a run by hand** (a repair, or a one-time job; never needed day to day): `runner.py start --graph <graph> --ticket <KEY> [--input name=value ...]`. It starts no session by itself; the next pass picks the run up, even with the off switch on.
- **How many at once:** `session_limit` in `settings.json` (2). Every number the runner uses is in that file.

## Hosts: job or terminal

`settings.json` has `host`. `job` (the shipped value, set from the probe's report) means the five-minute job does everything: a pass launches detached children that outlive it. `terminal` is the fallback for a laptop where a job cannot start sessions: start the loop once in an Agent Manager terminal with `python3 ~/.josh-360/repo/graphs/runner/runner.py loop`. The loop ticks every `tick_seconds` and writes a heartbeat; the job then only checks the heartbeat, reports `loop.stale`, and sends one notification when the loop has stopped, and again only after it has been fresh. `loop` refuses to start under host `job`, or when another loop is running.

## A run that stopped

A run stops when the walker says so (a step that ran as often as its tier allows, a gate that failed), or when the runner stops it for a failure that started no model (JP-183). The runner notifies once, the stop appears in `status` and the report, and nothing more happens to it until you act or what it needed changes. Read the reason in `~/.josh-360/logs/runner/runner.log`. To carry on: `python3 graphs/runner/runner.py resume --run <id>` (the same step again; the same as `walker.py retry`) or `walker.py allow --run <id> --step <step>` (let a step run once more than its cap). A run that stops again afterwards for another reason is a new stop and is notified again.

**Which failures use a try or a run** (the table is in `graphs/CONVENTION.md`, "The run cap"; the codes are in `laptop/failure_kinds.py`):

- **Needs a fix** (`bad-model`, `bad-effort`, `no-cli`, `no-folder`): the spawn is tried once, then the run stops with the reason, Agent Manager's own message and the fix. The attempt stays open, so the step's run count does not move. The next pass carries on by itself once the fix reaches the laptop (a merge moves the commit; a change to `binding.json`, the compiled graph or where `agent-manager` and `claude` are found does too); `resume` carries on at once.
- **May clear** (`not-running`, `timeout`, `rate-limited`, `network`, `group`, `refused`, and a session that never linked to its run: `never-started`, `gone-before-start`): tried again in the same attempt after 5, 15, 30 and 60 minutes (`spawn_gaps_seconds`), `spawn_tries` (5) tries in all, then the run is stuck. A session that never linked is kept in the session file's `earlier` list and the attempt gets a new key, so it can never link later. `resume` gives it a fresh set of tries.
- **The model ran** (`bad-result`, `time-cap`, `session-gone`, `rested-without-result`): the attempt is abandoned and uses one run of the tier's cap, as before.

Every refused spawn is one `runner.log` line with its code, kind, try number and Agent Manager's message, shortened to 200 characters and screened for patient data (a message the screen flags is held back and the line names what it found). The report's "Why it ended" column shows the code and kind, and the Agent Manager session column lists any earlier sessions of the attempt.

## Follow-ups and telling the leads

A step session that finds work outside its ticket writes it in its result as `follow_ups` (JP-175, `graphs/contracts/follow-up.md`). On the next `advance` the walker files each one through intake (a ticket-creation run, so Josh still approves it on a card, and the new ticket carries the label `graph-follow-up`). A follow-up that blocks the ticket links the new ticket as blocking it in Jira, and the run waits: `status` and `where <KEY>` show it as `waiting` on the new key, and it moves on by itself once that ticket is Done or Cancelled, or the follow-up is dropped at the card.

The runner tells the lead, by script and with no session started, when a run stops, parks a question for Josh, files or drops a follow-up, or finishes. The lead is the epic's project manager session when the ticket's epic has one running, else the sprint lead (`runner_lib/leads.py` says how it is found in the sprint skill's state files). A filed follow-up reaches a sprint lead through `sprint.py handoff`; every other message goes by `agent-manager send`. Each message is kept in the run folder's `lead-messages.json`. With no lead running nothing is sent: the message waits there and the next pass sends it once a lead runs. `runner.py messages` (add `--json`) lists every message still unsent.

## Where the logs and files are

- `~/.josh-360/logs/runner/runner.log`: one line per start, spawn, record, abandon and stop (ids, step names and reasons only).
- `~/.josh-360/logs/runner/run-<run id>.log`: the output of that run's detached `advance`.
- `~/.josh-360/state/runner/`: `report.json` (the last pass), `refusals.json` (why the walker refused a start, JP-172), the locks, the heartbeat (terminal host), `am-tickets.json` (each ticket's Agent Manager sessions, JP-173) and `groups-ready.json` (the Agent Manager groups already made).
- `~/.josh-360/runs/<run id>/`: the run folder: `run.json`, `sessions/<step>-<attempt>.json` (one per session; `.link.json` beside it is the link hook's), `results/`, `comments/`, `work/`, `follow-ups/` (one file per follow-up a step reported), `lead-messages.json` (what each lead was told, or is still to be told) and `runner.json` (what has already been notified).
- `~/.josh-360/state/graph-sessions/`: one small file per linked step session; the rails act only on a session that has one.

## Files in this folder

| Path | What |
| --- | --- |
| `runner.py` | `tick`, `advance`, `start`, `status`, `report`, `where`, `resume`, `messages`, `loop` |
| `tick_job.py` | the `graph-runner` job (always exits 0) |
| `triage_jp116_job.py` | the temporary job that starts the triage run of JP-116, the proof ticket |
| `starts.json` | which tickets get a run, per graph, and how many per pass |
| `settings.json` | every number the runner uses |
| `runner_lib/` | the Jira watch, the advance loop, the tick, locks, session files, each ticket's Agent Manager sessions (`amgroups.py`), the hook logic, status, `where` and the refusals it shows, notifications and the lead messages (`leads.py`), and how a failure that started no model is stopped and taken up again (`failures.py`, JP-183) |
