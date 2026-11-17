# Graph runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Contents

- [Global Constraints](#global-constraints)
- [The probe decides the host](#the-probe-decides-the-host)
- [Review Focus](#review-focus)
- [File map](#file-map)
- [Shared shapes](#shared-shapes)
- [Parallel lanes](#parallel-lanes)
- [Task 1: Read the probe and set the host](#task-1-read-the-probe-and-set-the-host)
- [Task 2: The walker's run answer says more](#task-2-the-walkers-run-answer-says-more)
- [Task 3: Runner foundations](#task-3-runner-foundations)
- [Task 4: The start rules](#task-4-the-start-rules)
- [Task 5: The Agent Manager binding](#task-5-the-agent-manager-binding)
- [Task 6: The link hook](#task-6-the-link-hook)
- [Task 7: The guard and the reflection nudge](#task-7-the-guard-and-the-reflection-nudge)
- [Task 8: The Stop hook](#task-8-the-stop-hook)
- [Task 9: Advancing a run](#task-9-advancing-a-run)
- [Task 10: The tick, the job and the terminal loop](#task-10-the-tick-the-job-and-the-terminal-loop)
- [Task 11: Status, the run report and notifications](#task-11-status-the-run-report-and-notifications)
- [Task 12: Whole runs, the JP-116 triage job and documents](#task-12-whole-runs-the-jp-116-triage-job-and-documents)
- [Task 13: The proof run on the laptop](#task-13-the-proof-run-on-the-laptop)
- [Laptop checks owed after the build](#laptop-checks-owed-after-the-build)
- [Choices this plan makes](#choices-this-plan-makes)
- [Spec coverage](#spec-coverage)

**Goal:** Build the graph runner and its Agent Manager binding, so a JP ticket that is Ready and in an open sprint gets a development run with no one starting it, every model step is a visible Agent Manager session with the safety rails on, and JP-116 is carried to a merged pull request as the proof.

**Architecture:** A script with no model in it. `runner.py tick` (every five minutes) watches Jira through `graphs/runner/starts.json`, starts at most one run through the walker, and starts one short detached `runner.py advance --run <id>` per run that has work. `advance` loops on `walker next` and does only what the answer says: start a session through the binding, record a finished one, abandon a dead one, or leave the run alone. `graphs/runner/` knows nothing about Agent Manager; `graphs/bindings/agent-manager/` knows nothing about graphs; four hooks put the rails on sessions the runner started and on no other session. Nothing holds a run in memory: the ledger has the steps, Agent Manager has the sessions, and `<run>/sessions/` links them.

**Tech Stack:** Python 3.9, standard library only (everything here runs on the laptop's `/usr/bin/python3`). Tests are stdlib `unittest` in `tests/` and `graphs/tests/`, run by `python3 scripts/check.py`. On the laptop: the `agent-manager` CLI, Claude Code, `osascript` for notifications. In tests: a fake `agent-manager`, a fake Agent Manager database, the fake Jira (`graphs/gates/lib/jira_fake.py`) and the real walker.

**Spec:** `docs/superpowers/specs/2026-11-17-graph-runner-design.md` (approved by Josh on 17 November 2026, "Approve as written": only the development start rule is on, two sessions at once, a finished step's session is archived). Read it with this plan: its tables of walker answers and safety rails, the prompt order and the ten scenarios are not repeated here. Ticket: JP-117. Proof ticket: JP-116, which is never built by a thread. Build on the latest `main`.

## Global Constraints

- **No graph logic outside the walker.** Which step is next, how outcomes branch, loop limits, run caps and when Josh is asked stay in `graphs/tools/walker_lib/` and the graph files. `graphs/runner/` and `graphs/bindings/` never read a graph's steps, `on`, `needs` or `when`.
- **The split.** Nothing under `graphs/runner/` names Agent Manager, `agent-manager`, tmux or a model. Nothing under `graphs/bindings/agent-manager/` imports the walker, the ledger or `runner_lib`. The runner loads a binding by the run's `runner` value: `graphs/bindings/<runner>/binding.py`.
- **Python 3.9, standard library only** for every file this plan creates outside `tests/`.
- **Unknown is not empty.** A failed or partial Jira search starts nothing and ends nothing. An unreadable Agent Manager database, session file or question record changes nothing this pass. A graph session whose link cannot be read is denied, not waved through.
- **One run per ticket; one session per step attempt.** A second session for the same `(run, step, attempt)` is never started, whatever was killed or restarted.
- **Nothing waits inside a job pass.** `tick` finishes in seconds. A detached child gets `/dev/null` for standard input and a log file, never a pipe, and its own process session.
- **Only gate scripts write to Jira and GitHub.** The runner writes neither. It adds no question for Josh: a stopped run is a report line, one notification and the flag the walker already sets.
- **Patient data.** The published report, the logs, the notifications and the session names hold ids, step names, outcomes, counts and times only: never a ticket's text, a comment, a gate's error text or a prompt. Tests use made-up tickets.
- **Numbers** (all in `graphs/runner/settings.json`, values from the spec): session limit 2, one new run per pass, turn cap 200 tool calls, reflection every 40, time cap 3 hours with 15 minutes' grace, link timeout 10 minutes, rest timeout 10 minutes, advance limit 2 hours, waits listed after 7 days.
- **Hooks** follow `hooks/README.md`: read the event's JSON on stdin, exit 0 to carry on, exit 2 to block with the reason on stderr, print JSON only when adding context, fast, and silent for any session that is not a graph session. A hook file is a thin wrapper; the logic is in `graphs/runner/runner_lib/hooklib.py`, where tests call it in process.
- **Compile.** After changing a fixture graph, run `python3 graphs/tools/compile_graphs.py` for the real graphs; fixture copies are compiled by the test helpers.
- **The ticket.** The build thread moves JP-117 to In Progress when it starts. It is Done only after Task 13, because one scenario runs on the laptop.
- **Commits:** one per file, messages starting `JP-117: `. Each task ends with `python3 scripts/check.py` printing `check.py: ok (0 problem(s))`. Branch `JP-117-graph-runner`, cut from `main`.

## The probe decides the host

The probe job (`agent-manager-probe`, PR #54) made its first report at 23:24 UTC on 17 November 2026, while this plan was being written (`python3 laptop/status.py show agent-manager-probe`). It answers some questions and leaves the two that pick the host open:

| Question | What the first report says |
| --- | --- |
| Is the CLI there, and does it answer a job? | Yes. `agent-manager 0.47.1` at `/opt/homebrew/bin/agent-manager`; `sessions --json` exits 0 from the job. Its help says `spawn`, `sessions`, `archive`, `kill`, `wait`, `read`, `create-group` "also run from a script outside Agent Manager". |
| Does `spawn` start a session from a job? | **Not answered.** The spawn exited 1 with `claude is not installed`: the job's PATH is `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` and Claude Code is in `~/.local/bin`. That is a PATH fault in the probe, not a refusal. The binding puts Claude Code's folder on the PATH for the call (Task 5), and the probe needs the same fix before its answer counts (Task 1). |
| Does a detached child outlive a job pass? | **Not answered yet.** The child was started; the next pass reports `detached.survived`. |
| Agent Manager's database | `sessions` has `id`, `status`, `archived`, `agent_session_id`, `model`, `effort` among its columns. Status words in use: `dead`, `finished`, `idle`, `starting`, `waiting`, `working`. |
| Archiving | `agent-manager archive <session-id> [--json]` exists. |
| Is `AGENT_MANAGER_*` in a job's environment? | No, as expected. Whether it is in a session's hook environment is a laptop check. |

The plan therefore builds both hosts behind one setting, `"host"` in `graphs/runner/settings.json`, and Task 1 sets it from the probe's final report. No other task forks.

| Probe says | `host` | What runs where |
| --- | --- | --- |
| `spawn` works from a job **and** the detached child survived | `job` | The job `graph-runner` runs `tick`; `tick` starts detached `advance` children. The design as written. |
| `spawn` is refused from a job with Claude Code on the PATH, **or** the detached child did not survive | `terminal` | `runner.py loop` runs `tick` every five minutes inside an Agent Manager terminal and writes a heartbeat. The job `graph-runner` only checks the heartbeat and publishes the loop's last report. |

The spec's third case (run `advance` inside the tick with a time budget when a detached child dies) is not built. A gate may run for ten minutes (`JOSH360_GATE_TIMEOUT`) and the job has five, so that case would still need the terminal loop for `verify-build`. One fallback is enough (see [Choices this plan makes](#choices-this-plan-makes), row 1).

Still unknown, and named as provisional in Task 5 so the build never guesses silently: the field of `spawn --json`'s reply that holds the new session's id, and what `finished` and `waiting` mean for a session that has not written its result.

## Review Focus

Failure modes the spec implies but does not test. Each has a test in the task named.

1. **The rails are not loaded.** If the hook dispatcher has no entry for one of the four events, a session would run with no guard, no cap and no link, and the runner would abandon it after ten minutes while it was still working. With an entry missing, the runner must start no session and say why in the report. Task 9.
2. **A crash between starting a session and writing it down.** The process dies after `agent-manager spawn` ran and before its reply is saved. The next pass must find the session through the link hook, or wait out the link timeout and abandon the attempt, and must never start a second session for it. Task 9.
3. **A marker line that is not the runner's.** A session that quotes this plan, or reads an old prompt, shows a `[josh360-step ...]` line. Only a line whose key matches an unlinked session file may make a session a graph session. Task 6.
4. **A result file caught half-written, or holding an outcome the step does not declare.** A file that does not parse and is under a minute old is left for the next pass. A bad one abandons the attempt and never stops the runner. Task 9.
5. **Twenty Ready tickets land in the sprint at once, and one has no route record.** One run starts per pass, in rank order; the ticket with no record is skipped with a reason and does not block the ones behind it. Task 4.
6. **Agent Manager's database changes shape or is locked.** A missing column, a locked file or a status word the binding does not know is `unknown`, which changes nothing: no abandon, no second session. Tasks 5 and 9.
7. **A tool call that reads a secret or edits the rails through Bash.** `cat .env`, `security find-generic-password`, and a redirect into the guard, the walker or another run's folder are denied in a graph session, and the same calls are untouched in any other session. Task 7.

---

## File map

| File | State | Responsibility |
| --- | --- | --- |
| `graphs/tools/walker_lib/runner.py`, `graphs/CONVENTION.md` | modify | The `run` answer gains `graph`, `ticket`, `access`, `work_dir`, `phi` |
| `graphs/runner/runner.py` | create | The command line: `tick`, `advance`, `start`, `status`, `report`, `loop` |
| `graphs/runner/tick_job.py` | create | The file the job runs (a job is a `.py` with no arguments): one tick, or the heartbeat check; prints the report |
| `graphs/runner/triage_jp116_job.py` | create | The proof's one-time start of JP-116's triage run |
| `graphs/runner/starts.json`, `settings.json`, `README.md` | create | The start rules; the numbers; how to see and stop it |
| `graphs/runner/runner_lib/paths.py` | create | Settings, folders, the off switch, the runner log |
| `graphs/runner/runner_lib/walk.py` | create | The one way the runner calls the walker |
| `graphs/runner/runner_lib/ledgerview.py` | create | Read-only ledger queries: open runs, a run's open step, a run's rows |
| `graphs/runner/runner_lib/sessionfile.py` | create | `<run>/sessions/` files; counting live sessions |
| `graphs/runner/runner_lib/locks.py` | create | `flock` locks: the tick, a run's advance, the spawn count |
| `graphs/runner/runner_lib/watch.py` | create | The start rules against Jira |
| `graphs/runner/runner_lib/advance.py` | create | The advance loop |
| `graphs/runner/runner_lib/tick.py` | create | One pass; the detached launcher; the loop and its heartbeat |
| `graphs/runner/runner_lib/status.py` | create | The snapshot behind `status` and the published report; the run report |
| `graphs/runner/runner_lib/notify.py` | create | One macOS notification, once per event |
| `graphs/runner/runner_lib/hooklib.py` | create | The four hooks' logic |
| `ledger/graph_sessions.py` | create | Where a graph session's link lives; `is_graph_session` (the ledger's hooks read it too) |
| `ledger/offer.py`, `ledger/comments.py` | modify | Their hooks stay quiet in a graph session |
| `graphs/bindings/agent-manager/binding.py`, `binding.json`, `README.md` | create | `start`, `state`, `close`, the prompt; group, status words and model names; setup notes |
| `graphs/bindings/README.md` | modify | Point at the Agent Manager binding |
| `hooks/UserPromptSubmit/20-graph-step`, `hooks/PreToolUse/20-graph-step-guard`, `hooks/PostToolUse/20-graph-step-reflect`, `hooks/Stop/20-graph-step-stop`, `hooks/README.md` | create, modify | The rails |
| `graphs/gates/lib/jira_fake.py` | modify | The fake search applies a small JQL subset when a test asks |
| `jobs.yaml` | modify | Add `graph-runner` and `jp-117-triage-jp-116`; remove `agent-manager-probe` |
| `scripts/agent_manager_probe_job.py`, `tests/test_agent_manager_probe.py` | delete | The probe, once it has answered |
| `scripts/check.py`, `scripts/doctor_lib/hook_checks.py`, `docs/platform-doctor.md` | modify | Parse the new files as Python 3.9; the doctor names the four hooks |
| `tests/fakes/agent-manager`, `tests/runner_helpers.py`, `tests/test_runner_*.py`, `tests/test_graph_step_hooks.py`, `graphs/tests/fixtures/parts/flows/runner-sample.yaml` | create | Tests |
| `tests/test_follow.py` | modify | The reports the job runner publishes |
| `AGENTS.md`, `docs/decisions/JP-117.md`, the spec's "As built", `docs/proof/<date>/JP-117/`, `docs/proof/phase-1-graphs.md` | modify or create | Documents and proof |

## Shared shapes

Every task uses these names. Times in runner files are epoch seconds (floats); only the published report turns one into text.

**The session file**, `<run folder>/sessions/<step>-<attempt>.json`, written only by the runner:

```json
{"run": "r-7f3a09c1d2e4", "step": "build", "attempt": 1, "graph": "development", "ticket": "JP-116",
 "access": "josh", "tier": "cheap", "outcomes": ["done", "needs_judgment"],
 "result_file": "<run>/results/build-1.json", "work_dir": "<run>/work", "key": "9c1f0a7b3d5e2468",
 "state": "started", "intent_at": 1795000000.0, "started_at": 1795000004.2,
 "handle": {"am_session": "s-123", "name": "JP-116 - Build (r7f3a)", "model": "claude-haiku-5-5", "effort": "high", "directory": "<worktree>"},
 "comments": "", "resting_since": null, "spawn_failures": 0, "ended_at": null, "reason": null, "closed": null}
```

`state` is one of `spawning` (written before the spawn), `started`, `spawn_failed`, `recorded`, `abandoned`. A session is **live** while its state is `spawning` or `started`.

**The link file**, `<run folder>/sessions/<step>-<attempt>.link.json`, written only by the link hook: `{"session_id": "<Claude Code session id>", "am_session": "<AGENT_MANAGER_SESSION_ID or null>", "linked_at": 1795000010.0}`.

**The graph session entry**, `~/.josh-360/state/graph-sessions/<Claude Code session id>.json`, written by the link hook and read by the other three: the session file's `run`, `step`, `attempt`, `graph`, `ticket`, `access`, `tier`, `outcomes`, `result_file`, `work_dir`, plus `run_folder`, `started_at` (the link time), `am_session` and `nudged_at` (null until the Stop hook nudges). Beside it: `<id>.calls` (one byte per tool call; its size is the count) and `<id>.reflected` (how many reflection nudges were given).

**The marker line**, first line of every step prompt: `[josh360-step run=<run id> step=<step> attempt=<n> key=<16 hex digits>]`.

**The walker's `run` answer** after Task 2: today's keys plus `graph`, `ticket` (or null), `access` (`read`, `josh` or `shared`), `work_dir`, `phi`.

## Parallel lanes

Tasks 2 and 3 come first, in that order. After Task 3 these lanes touch different files and can each go to its own subagent at the same time:

- **Lane A:** Task 4 (start rules).
- **Lane B:** Task 5 (binding). Two of its values are provisional until the probe's final report; it is built on them and corrected in Task 1.
- **Lane C:** Tasks 6, 7, 8 in order (hooks).
- **Lane D:** Task 11 (status, report, notifications).

Then Task 9 (needs 5 and 6), Task 10 (needs 4, 9 and 11) and Task 12 (needs all), one at a time. Task 1 can be done at any point once the probe has reported and must be done before Task 12 ends. Task 13 follows the merge.

---

### Task 1: Read the probe and set the host

**Files:**
- Modify: `graphs/runner/settings.json` (`host`), `graphs/bindings/agent-manager/binding.json`, `docs/decisions/JP-117.md`, `jobs.yaml`, `tests/test_follow.py`
- Delete (last): `scripts/agent_manager_probe_job.py`, `tests/test_agent_manager_probe.py`

**Interfaces:**
- Produces: the value of `host`; the final values in `binding.json` that Task 5 lists as provisional.

- [ ] **Step 1: Read the report.** `git fetch origin laptop-status && python3 laptop/status.py show agent-manager-probe`.
- [ ] **Step 2: Get a real spawn answer.** The design thread is fixing the probe on branch `JP-117-probe-path` (17 November): the spawn runs with Claude Code's folder first on the PATH, the answer that counts is the report's `spawn` entry carrying `path_first`, and the first refusal is kept as `first_spawn`. If the report's `spawn.error` still says `claude is not installed` and has no `path_first`, that fix has not reached the laptop: check its pull request, and if it was dropped, make the same fix yourself (run the spawn with the folder of `find_bin("claude", "JOSH360_CLAUDE_BIN")` first on the PATH, count the new tries under new state keys, add the test). Do the other tasks meanwhile. If no answer is in when Task 12 is otherwise done, tell the coordinator the build is waiting on the probe and stop; do not guess a host.
- [ ] **Step 3: Set `host`** from the table in [The probe decides the host](#the-probe-decides-the-host): `spawn.code == 0` and `detached.survived == true` give `job`; a spawn refused with Claude Code on the PATH, or `detached.survived == false`, gives `terminal`. A report with no `detached.survived` is not an answer: wait for the next pass.
- [ ] **Step 4: Fill `binding.json`** from the report: the reply field that holds the new session's id (`spawn.fields`), and the probe session's row (`database.probe_session`: its status once it has replied and stopped says which word means "at rest", and `filled_columns` says whether `agent_session_id` is filled). Change Task 5's tests wherever a provisional value changed.
- [ ] **Step 5: Record it.** Add one row to `docs/decisions/JP-117.md`: what the probe reported (exit codes and field names only) and the host it set. If `host` is `terminal`, the row's undo is "set `host` to `job`", and Task 13 gains the one manual step of starting the loop terminal.
- [ ] **Step 6: Remove the probe.** Delete its job entry, script and test; take `reports/agent-manager-probe.json` out of `tests/test_follow.py`. Tell Josh in the pull request that the session "JP-117 probe - safe to archive" can be archived.
- [ ] **Step 7: Run** `python3 scripts/check.py`. Expected: `check.py: ok (0 problem(s))`. Commit.

### Task 2: The walker's run answer says more

The binding builds the prompt "only from the walker's `run` answer" and the guard needs each step's access, so the answer has to carry both. Nothing else about the walker changes.

**Files:**
- Modify: `graphs/tools/walker_lib/runner.py` (`run_action`), `graphs/CONVENTION.md` ("The walker", "How a role session reports")
- Test: `tests/test_walker.py`

**Interfaces:**
- Produces: `run_action` adds to its dict `"graph": g.id`, `"ticket": run.ticket`, `"access": g.header["access"][step]`, `"work_dir": str(runfolder.work_dir(run.run_id))`, `"phi": run.phi`.

- [ ] **Step 1: Write the failing test** `test_run_answer_names_graph_ticket_access_and_work_dir`: start the `valid` graph for `JP-901`, call `next`, and assert `out["graph"] == "valid"`, `out["ticket"] == "JP-901"`, `out["access"] == "josh"` (step `design`), `out["work_dir"]` ends with `/work` and is a folder, `out["phi"] is False`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_walker -k run_answer`. Expected: FAIL with `KeyError: 'graph'`.
- [ ] **Step 3: Implement** in `run_action`. Add the five keys to the list of `run` answer fields in `CONVENTION.md`.
- [ ] **Step 4: Run** the test, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 3: Runner foundations

**Files:**
- Create: `graphs/runner/runner_lib/__init__.py`, `paths.py`, `walk.py`, `ledgerview.py`, `sessionfile.py`, `locks.py`; `graphs/runner/settings.json`; `ledger/graph_sessions.py`; `tests/runner_helpers.py`; `graphs/tests/fixtures/parts/flows/runner-sample.yaml`
- Modify: `scripts/check.py` (the Python 3.9 parse check, the loop around `ast.parse(..., feature_version=(3, 9))`, also covers `graphs/runner/**/*.py` and `graphs/bindings/**/*.py`; say so in its docstring entry)
- Test: `tests/test_runner_parts.py`

**The fixture graph `runner-sample`** (the runner's tests use it; `valid` stays as it is). Inputs: `ticket_key` (required), `system` (default `none`), `ticket_type` (default `Task`), `resume_from` (default `none`), `phi` (boolean, default false). Entry gate `ready`, exit gate `no-loose-ends`, one stretch `In Progress` holding every step. Steps: `draft` (role `designer`, access `josh`, output `note: string`, outcomes `[ready]`); `check_a` (gate `lint-spec`, access `read`, needs `draft`, outcomes `[pass]`); `check_b` (gate `check-review`, access `read`, needs `draft`, outcomes `[clean]`); `confirm` (ask, needs `check_a` and `check_b`, choices `[go, stop]`, `on: {stop: end}`); `make` (role `builder`, access `josh`, needs `confirm`, `when` `confirm` is `go`, outcomes `[done]`); `look` (role `code-reviewer`, access `read`, needs `make`, outcomes `[pass]`). `asks_josh: [confirm]`; `end_states: {finished: success, confirm.stop: needs-josh}`. What matters is the shape: two gates that do not depend on each other, between a role step and an ask, then a step that writes and a step that only reads. Change a gate's inputs or outcomes where the graph checker asks for it.

**Interfaces:**
- Produces, `paths.py`: `ROOT: Path`; `DEFAULTS: dict` (below); `settings() -> dict` (`DEFAULTS` overlaid by `graphs/runner/settings.json`, or by the JSON file `JOSH360_RUNNER_SETTINGS` names; a file that is not a JSON object raises `ValueError`); `state_dir() -> Path` (`common.state_dir() / "runner"`); `log_dir() -> Path` (`common.logs_dir() / "runner"`); `off_file() -> Path` (`common.state_dir() / "runner-off"`); `is_off() -> bool`; `log(line: str) -> None` (appends `<UTC time> <line>` to `log_dir() / "runner.log"`); `run_log(run_id: str) -> Path`; `rails_loaded(environ=None) -> bool` (True only when the Claude Code settings file, `JOSH360_CLAUDE_SETTINGS` else `~/.claude/settings.json`, has a command containing `hooks/dispatch` under each of `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`; an unreadable file is False).
- Produces, `walk.py`: `class WalkerRefused(Exception)`; `call(*argv: str, root: Optional[Path] = None) -> dict`, which runs `walker_lib.cli.main` in process with a string buffer, returns the parsed line, and raises `WalkerRefused(message)` when the walker exits 2.
- Produces, `ledgerview.py` (reads only): `open_runs(conn, runner: str) -> List[dict]` (`{"run", "graph", "ticket", "started_at"}`, runs with no row in `run_ends`, oldest first); `ticket_has_open_run(conn, ticket: str) -> bool` (any graph, any runner); `last_ended_run(conn, ticket: str, graph: str) -> Optional[str]`; `open_step(conn, run: str) -> Optional[dict]` (`{"step", "kind", "attempt", "started_at"}` of the newest step row with no result, else None); `run_rows(conn, run: str) -> List[dict]` (each step row with `step`, `kind`, `attempt`, `loop_count`, `tier`, `outcome`, `model`, `session` (the tool's session id or None), `started_at`, `ended_at`); `ended_runs(conn, since: str) -> List[dict]` (`{"run", "graph", "ticket", "end", "score", "ended_at"}`).
- Produces, `sessionfile.py`: `class Unreadable(Exception)`; `path(run, step, attempt) -> Path`; `link_path(run, step, attempt) -> Path`; `read(run, step, attempt) -> Optional[dict]` (None when missing, `Unreadable` when damaged); `write(run, step, attempt, doc: dict) -> None` (temp file, then rename); `read_link(run, step, attempt) -> Optional[dict]`; `live(run_ids: List[str]) -> List[dict]` (every session file of those runs whose state is `spawning` or `started`; an unreadable file counts as live).
- Produces, `locks.py`: `class Held(Exception)`; `held(path: Path)`, a context manager that takes a non-blocking exclusive `fcntl.flock` on `path` (created if missing) and raises `Held` when another process has it; `is_held(path: Path) -> bool`.
- Produces, `ledger/graph_sessions.py`: `folder() -> Path` (`common.state_dir() / "graph-sessions"`); `entry_path(session_id: str) -> Path` (raises `ValueError` unless the id matches `spool.SESSION_ID`); `is_graph_session(session_id: object) -> bool` (False for a bad id or no file; never raises).
- Produces, `tests/runner_helpers.py`: `class RunnerCase(WalkerCase)`, which adds to `WalkerCase.setUp` a settings file (`self.settings(**changes)` rewrites it), the fake `agent-manager` on `JOSH360_AM_BIN` with its call log and database (`JOSH360_AM_DB`), a fake Jira folder (`JOSH360_JIRA_FAKE`, with `apply_jql: true`), a made-up Claude settings file with the four dispatcher entries (`JOSH360_CLAUDE_SETTINGS`), `JOSH360_NO_NOTIFY=1`, and a clock `self.now` (a float the tests move with `self.later(seconds)`). Later tasks add its session helpers.

`DEFAULTS`, which `graphs/runner/settings.json` repeats so the numbers are in one visible file:

```json
{"host": "job", "session_limit": 2, "turn_cap": 200, "reflect_every": 40,
 "time_cap_seconds": 10800, "time_cap_grace_seconds": 900, "link_timeout_seconds": 600,
 "rest_timeout_seconds": 600, "advance_limit_seconds": 7200, "spawn_tries": 3,
 "tick_seconds": 300, "heartbeat_stale_seconds": 600, "wait_flag_days": 7,
 "result_settle_seconds": 60, "archive_finished_sessions": true, "ended_runs_days": 14}
```

- [ ] **Step 1: Write the failing tests** in `tests/test_runner_parts.py`:
  - `test_settings_file_overrides_defaults`: with `{"session_limit": 1}` in the file, `settings()["session_limit"] == 1` and `settings()["turn_cap"] == 200`.
  - `test_shipped_settings_match_defaults`: `graphs/runner/settings.json` parses to exactly `DEFAULTS`' keys.
  - `test_walk_returns_the_answer_and_raises_on_refusal`: `walk.call("start", ...)` returns a dict with `run`; `walk.call("next", "--run", "r-000000000000")` raises `WalkerRefused` whose text contains `there is no run`.
  - `test_open_runs_and_open_step`: after a start and one `next`, `open_runs(conn, "cli")` lists the run and `open_step` gives `{"step": "design", "kind": "role", "attempt": 1, ...}`; a run started with `--runner agent-manager` is not in the `cli` list.
  - `test_session_file_round_trip_and_live`: write a `spawning` doc and a `recorded` doc; `live([run])` returns the first only; a file holding `{` makes `read` raise `Unreadable` and still counts in `live`.
  - `test_lock_is_released_when_its_process_dies`: a child process that takes `held(path)` and is killed with SIGKILL leaves `is_held(path)` False.
  - `test_rails_loaded_needs_all_four_events`: the helper's made-up settings file gives True; the same file with the `Stop` entry removed, and a file holding `{`, give False.
  - `test_is_graph_session_never_raises`: `is_graph_session(None)`, `("../x")` and an unknown id are all False.
  - `test_runner_sample_passes_the_checker`: `check_graph` reports no problem for the fixture, and `walker start --graph runner-sample --ticket JP-901` returns a run.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_runner_parts`. Expected: FAIL, `No module named 'runner_lib'`.
- [ ] **Step 3: Implement** the six modules, the settings file and the helper. `runner_helpers.py` puts `graphs/runner` on `sys.path` the way `walker_helpers.py` does for `graphs/tools`.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 4: The start rules

**Files:**
- Create: `graphs/runner/starts.json`, `graphs/runner/runner_lib/watch.py`
- Modify: `graphs/gates/lib/jira_fake.py` (the search)
- Test: `tests/test_runner_watch.py`, `graphs/tests/test_gate_jira.py`

**Interfaces:**
- Consumes: `walk.call`, `ledgerview.ticket_has_open_run`, `ledgerview.last_ended_run`; `lib.jira.Jira.search`, `.read_property`; `lib.triage.port.ROUTE_PROPERTY`, `SPEC_PROPERTY`; `walker_lib.gates.jira_env`.
- Produces: `watch.load_rules(path: Path) -> dict` (raises `ValueError` naming the entry when the file is not the shape below); `watch.jira_client(environ) -> Optional[Jira]` (None when there are no credentials; never calls `gate_io.fail`); `class MissingInput(Exception)`; `watch.build_inputs(mapping: dict, issue: dict, route: dict, spec: Optional[dict], last_run: Optional[str]) -> Dict[str, str]` (raises `MissingInput(name)`); `watch.watch(conn, jira, rules: dict, root: Optional[Path] = None) -> dict`, which returns `{"<graph>": {"jira": "ok" | "unknown" | "no-credentials", "started": ["JP-1"], "skipped": {"JP-2": "<reason>"}}}` for each graph that is on.

`graphs/runner/starts.json` as shipped:

```json
{
  "per_pass": 1,
  "graphs": {
    "development": {
      "on": true,
      "jql": "project = JP AND status = Ready AND sprint in openSprints() AND issuetype in (Story, Bug, Task, Research)",
      "route": "development",
      "inputs": {"ticket_type": "issuetype", "system": "route.system", "resume_from": "last_run|none", "phi": "spec.phi_risk|true"}
    },
    "non-development": {"on": false, "note": "Same rule with route non-development; switched on by a later ticket (spec Q1)."},
    "triage": {"on": false, "note": "The five triage triggers are not designed here (spec Q1)."},
    "ticket-creation": {"on": false, "note": "Started from a session, not from Jira."}
  }
}
```

Rules:
- **An input's source** is `<source>` or `<source>|<default>`. Sources: `issuetype` (the issue type's name), `route.<field>`, `spec.<field>`, and `last_run` (the ticket's newest ended run of this graph, from the ledger, and only when the route record's `returned_from` is not empty). An empty or missing value takes the default; with no default the ticket is skipped with the reason `missing input <name>`. A boolean becomes `true` or `false`.
- **One pass, per graph that is on:** search with the rule's JQL plus ` ORDER BY Rank ASC` (unless it already has an `ORDER BY`), fields `issuetype`, `status` and the sprint field, limit 50. `None` from the search is `jira: unknown` and nothing else is done for that graph. Then, in the order returned, for each ticket until `per_pass` runs have started in this pass across all graphs: skip `has an open run` (`ticket_has_open_run`); read the route record (`unknown` skips with `route record unreadable`; unset skips with `no route record`; a `graph` that is not the rule's `route` skips with `routed elsewhere`); read the spec property (`unknown` skips with `spec unreadable`; a value that is set and is not an object skips with `spec does not parse`); build the inputs; call `walk.call("start", "--graph", g, "--ticket", key, "--runner", "agent-manager", "--input", "k=v", ...)`, adding `--phi` when the `phi` input is true. A `WalkerRefused` skips with the reason `not admitted` and the walker's message goes to `runner.log`, not to the report.
- **Reasons come from that fixed list.** No ticket text reaches the report.
- **The fake Jira.** When its state file has `"apply_jql": true`, the search splits the JQL on ` AND ` after dropping any `ORDER BY`, and applies `project = X`, `status = X` (quoted or bare), `sprint in openSprints()` (the sprint field holds an entry whose `state` is `active`) and `issuetype in (A, B)`. Any other clause answers 400, so a test can never pass on a rule the fake did not judge. Without the flag it returns every issue, as today. With `"search_fails": true` it answers 500.

- [ ] **Step 1: Write the failing tests.** `graphs/tests/test_gate_jira.py`: `test_fake_search_applies_status_sprint_and_type`, `test_fake_search_refuses_a_clause_it_cannot_judge` (status 400, so `search` returns None), `test_fake_search_without_the_flag_returns_everything`. `tests/test_runner_watch.py`, each seeding the fake Jira and using a test rules file that is the shipped `development` entry under the name `runner-sample` (`"route": "runner-sample"`, the same `jql` and `inputs`), with the fixture's scripted entry gate:
  - `test_ready_in_an_open_sprint_starts_a_run`: the result is `{"runner-sample": {"jira": "ok", "started": ["JP-901"], "skipped": {}}}`; the ledger has one run with `runner == "agent-manager"`; its `run.json` inputs are `ticket_type == "Story"`, `system == "sample"`, `resume_from == "none"`, `phi is True`, and the run row's `phi == 1`.
  - `test_ready_in_the_backlog_starts_nothing`: `started == []` and the ledger has no run.
  - `test_failed_search_starts_and_ends_nothing`: with `search_fails`, the result is `{"runner-sample": {"jira": "unknown", "started": [], "skipped": {}}}` and an open run made beforehand has the same step rows afterwards.
  - `test_build_inputs`: with the shipped mapping, an issue of type `Bug`, the route `{"system": "atlas", "returned_from": ""}`, no spec and no last run, the result is `{"ticket_type": "Bug", "system": "atlas", "resume_from": "none", "phi": "true"}`; a spec of `{"phi_risk": false}` gives `phi == "false"`; a route with no `system` raises `MissingInput("system")`.
  - `test_shipped_rule_names_only_inputs_the_development_graph_has`: every key of the shipped `development` rule's `inputs` is an input of `graphs/flows/development.yaml`, and every required input of that graph other than `ticket_key` is a key.
  - `test_one_run_per_pass_in_rank_order`: three qualifying tickets give `started == ["JP-901"]`; a second call starts `JP-902`.
  - `test_ticket_with_an_open_run_is_skipped`, `test_no_route_record_is_skipped_and_does_not_block_the_next`, `test_routed_elsewhere_is_skipped`, `test_spec_that_is_not_an_object_is_skipped`, `test_missing_input_with_no_default_is_skipped`: each asserts the exact reason string.
  - `test_returned_ticket_resumes_from_its_last_run`: with `returned_from: "10042"` on the route record and an ended `runner-sample` run `r-...` for the ticket, the new run's `resume_from` is that run id; with `returned_from` empty it is `none`.
  - `test_refused_start_is_tried_again_next_pass`: the entry gate refuses once; the first call gives `skipped == {"JP-901": "not admitted"}` and no run folder is left; the second call starts it.
  - `test_rules_file_is_checked`: an `on` entry with no `jql` raises `ValueError` naming that entry; the shipped file loads, and only `development` is on.
  - `test_no_credentials_is_not_a_crash`: `jira_client({})` is None and `watch(conn, None, rules)` gives `jira: "no-credentials"`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** the fake's search, then `watch.py`.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 5: The Agent Manager binding

**Files:**
- Create: `graphs/bindings/agent-manager/binding.py`, `binding.json`, `README.md`; `tests/fakes/agent-manager`
- Modify: `graphs/bindings/README.md`, `tests/runner_helpers.py`
- Test: `tests/test_runner_binding.py`

**Interfaces:**
- Consumes: the walker's `run` answer (Task 2). Nothing from the runner or the ledger.
- Produces: `binding.NAME = "agent-manager"`; `class SpawnRefused(Exception)`; `build_prompt(answer: dict, marker: str, comments: str) -> str`; `session_name(answer: dict) -> str`; `start(answer: dict, marker: str, comments: str) -> dict` (the handle: `{"am_session", "name", "model", "effort", "directory"}`; raises `SpawnRefused(reason)`, where the reason is one of `no-cli`, `group`, `refused`, `timeout`, `no-id`); `state(handle: dict) -> str` (`working`, `resting`, `gone` or `unknown`); `close(handle: dict) -> bool`.
- Produces, in `runner_helpers.py`: `self.am_calls(word) -> List[List[str]]` (the fake's logged argument lists that start with `word`), `self.am_set(session_id, status=None, archived=None)`.

Rules:
- **The command.** `[am, "spawn", "--name", name, "--tool", "claude", "--group", group, "--directory", directory, "--model", model, "--effort", effort, "--prompt", prompt, "--json"]`, with `stdin` from `/dev/null` and a 120 second limit. `am` is `JOSH360_AM_BIN`, else `agent-manager` on the PATH, else the first match in `~/.local/bin`, `~/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin` (a job's PATH is short). No `agent-manager` gives `SpawnRefused("no-cli")`.
- **Claude Code on the PATH.** Agent Manager refuses a spawn with `claude is not installed` when `claude` is not on the caller's PATH, and a job's PATH has no `~/.local/bin` (the probe's first report). Every `agent-manager` call the binding makes therefore runs with the folder of Claude Code put first on the PATH: `JOSH360_CLAUDE_BIN`'s folder, else where `claude` is found by the same search as above. A spawn whose error text contains `is not installed` is `SpawnRefused("no-cli")`.
- **The name** is `<KEY> - <Step Title> (<short>)`: the step id with underscores as spaces in Title Case, and `r` plus the first four characters after `r-` of the run id. Example: `JP-116 - Fix Review (r7f3a)`. A run with no ticket uses the graph id in place of the key.
- **The directory** is `answer["inputs"]["worktree"]` when that is a string naming an existing folder, else `answer["work_dir"]`.
- **Model and effort** come from `answer["models"]`, in order. Each model id is looked up in `binding.json`'s `models` map and used as it is when the map has no entry. A spawn that exits non-zero with `model` or `effort` in its error text (any case) tries the next entry; any other failure is `SpawnRefused("refused")`. The handle records the pair that worked.
- **The group** (`binding.json`'s `group`, `josh-360/graph-runs`) is made once per laptop: `create-group josh-360`, then `create-group josh-360/graph-runs`, ignoring an "already exists" answer, then the marker file `<JOSH360_HOME>/state/runner/group-ready`. Any other failure is `SpawnRefused("group")`.
- **The prompt**, in the spec's order: the marker line; `Do not run agent-manager rename; this session's name "<name>" is final.`; `Read <role_folder>/instructions.md first.` (and the agent folder's, when the answer has one); the brief; `Inputs:` with one `name: value` line each; on a rerun, `So far:` with the `so_far` values; `End with one of these outcomes: <a>, <b>.`; `When you are done, use the Write tool to write {"outcome": "<one of them>", "outputs": {...}} to <result_file>, then stop.`; `Work folder: <work_dir>`; the fixed paragraph `You are a step in a graph run. Do not ask questions in this session: end with the outcome that says you need input. Do not write to Jira or GitHub; gate scripts do that.`; and the comments text, unchanged, when there is any. When the prompt is longer than `binding.json`'s `prompt_max_bytes`, everything after the rename line is written to `<run folder>/prompts/<step>-<attempt>.md` and replaced by `Read <that file> in full before anything else; it is your task.`
- **`state`** opens the database read-only (`file:<path>?mode=ro`, 10 second busy timeout; the path is `JOSH360_AM_DB`, else `~/Library/Application Support/agent-manager/state.db`), checks that `sessions` has the columns `id`, `status` and `archived`, and reads the handle's row. No row, or `archived` set, is `gone`. The status word is looked up in `binding.json`'s three lists. A missing file, a missing column, a database error, a handle with no `am_session`, or a word in none of the lists is `unknown`.
- **`close`** runs the archive command from `binding.json` with the session id and returns whether it exited 0. It never raises.

`binding.json`. The status words and the archive command are from the probe's first report; `id_fields`, and whether `finished` and `waiting` belong under `resting`, are provisional until Task 1:

```json
{"group": "josh-360/graph-runs", "tool": "claude", "prompt_max_bytes": 60000,
 "id_fields": ["id", "session_id"],
 "status": {"working": ["working", "starting"], "resting": ["idle", "waiting", "finished"], "gone": ["dead"]},
 "archive": ["archive"],
 "models": {}}
```

`finished` and `waiting` are filed under `resting` because that is the safe side: a resting session with no result gets the rest timeout (ten minutes), where `gone` would abandon it at once.

**The fake `agent-manager`** (`tests/fakes/agent-manager`, an executable Python script): appends `sys.argv[1:]` as one JSON line to `$FAKE_AM_DIR/calls.jsonl`; `spawn` inserts a row (`id` `s-<n>`, the name, `status` `working`, `archived` 0, `group_name`, `cwd`) into `$FAKE_AM_DIR/state.db` and prints `{"id": "s-<n>"}`; `create-group <path>` records the group, or prints `already exists` and exits 1; `archive <id>` sets `archived`. `$FAKE_AM_DIR/behaviour.json` can hold `{"spawn_fails": "<text>"}`, `{"refuse_model": "<model>"}` (exits 1 with `unknown model <model>`), `{"spawn_hangs": true}` or `{"needs_claude": true}` (a spawn exits 1 with `agent-manager: claude is not installed` unless an executable named `claude` is on its PATH).

- [ ] **Step 1: Write the failing tests** in `tests/test_runner_binding.py`, each with a `run` answer taken from the real walker on the fixture graph:
  - `test_spawn_command_names_the_session_group_folder_and_tier`: the logged call has `--name "JP-901 - Design (r<4 chars>)"`, `--group josh-360/graph-runs`, `--tool claude`, the first tier entry's `--model` and `--effort`, and `--directory` equal to the work folder; the handle's `am_session` is `s-1`.
  - `test_worktree_input_wins_when_it_exists`: with `inputs.worktree` naming a real folder, `--directory` is that folder; naming a missing one, it is the work folder.
  - `test_prompt_order`: the prompt's first line matches `^\[josh360-step run=r-[0-9a-f]+ step=design attempt=1 key=[0-9a-f]{16}\]$`; the rename line, the instructions line, the outcomes line, the result file path, the work folder and the fixed paragraph appear in that order; the comments text given is the prompt's last part, byte for byte.
  - `test_long_prompt_goes_to_a_file`: with `prompt_max_bytes` 500, the `--prompt` value is under 500 bytes, keeps the marker as its first line, and names a file under `<run>/prompts/` that holds the brief.
  - `test_model_refused_falls_back_to_the_next_entry`: with the answer's `models` set to two entries and `refuse_model` naming the first, the handle's `model` is the second entry and two spawn calls were logged.
  - `test_other_spawn_failure_is_refused`: `spawn_fails: "boom"` raises `SpawnRefused` whose text is `refused`.
  - `test_spawn_puts_claude_code_on_the_path`: with `needs_claude`, a PATH that holds only the fake's folder and `/usr/bin`, and `JOSH360_CLAUDE_BIN` naming an executable `claude` in another folder, `start` returns a handle; with `JOSH360_CLAUDE_BIN` unset and no `claude` anywhere, it raises `SpawnRefused` whose text is `no-cli`.
  - `test_group_is_made_once`: two starts log `create-group` twice in all (the two levels), not four times.
  - `test_state_maps_status_words`: `working` and `starting` are `working`; `idle`, `waiting` and `finished` are `resting`; `dead`, an archived row and a missing row are `gone`; the word `purple`, a database with no `status` column, and a missing database file are `unknown`.
  - `test_close_archives`: `close(handle)` is True and the row's `archived` is 1; with the fake removed from the PATH it is False.
  - `test_binding_imports_nothing_of_the_runner`: the source of `binding.py` has no `walker`, `runner_lib` or `ledger` import.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_runner_binding`. Expected: FAIL.
- [ ] **Step 3: Implement** the fake, then the binding. `README.md` says how the binding is loaded, what `binding.json` holds, and that the group and the archive use Josh's standing approval for group changes and nothing wider.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 6: The link hook

**Files:**
- Create: `graphs/runner/runner_lib/hooklib.py` (the shared parts and `link`), `hooks/UserPromptSubmit/20-graph-step`
- Modify: `hooks/README.md` (the table), `tests/runner_helpers.py`
- Test: `tests/test_graph_step_hooks.py`

**Interfaces:**
- Consumes: `sessionfile`, `ledger.graph_sessions`, `runfolder.folder`.
- Produces, `hooklib.py`: `Result = Tuple[int, str, str]` (exit code, standard output, standard error); `MARKER = re.compile(r"^\[josh360-step run=(r-[0-9a-z]+) step=([a-z0-9_]+) attempt=([0-9]+) key=([0-9a-f]{16})\]\s*$", re.M)`; `marker(run, step, attempt, key) -> str`; `entry(session_id) -> Optional[dict]` (None when the session has no entry; raises `Unreadable` when the file is there and cannot be read); `link(payload: dict, environ: dict, now: float) -> Result`; `main(event: str) -> int`, which the four hook files call: it reads standard input, runs the function for the event, writes the result, and on any exception exits 2 when the session has an entry file and 0 when it has none.
- Produces, in `runner_helpers.py`: `self.session_starts(run, step, attempt=1, session_id="cc-1") -> dict`, which feeds `link` the prompt the fake logged for that step and returns the entry.

Rules for `link`:
- It acts only when the payload's `prompt` has a marker line, the session has no entry yet, the run folder exists, the session file for that `(run, step, attempt)` exists with state `spawning` or `started`, its `key` equals the marker's, and no link file exists for it. Anything else is `(0, "", "")` and writes nothing.
- It then writes the link file and the entry (shapes in [Shared shapes](#shared-shapes)), with `am_session` from `environ.get("AGENT_MANAGER_SESSION_ID")`, both by temp file and rename. It prints nothing.

- [ ] **Step 1: Write the failing tests** in `tests/test_graph_step_hooks.py`:
  - `test_first_prompt_with_the_marker_links_the_session`: the entry file exists with the session file's `run`, `step`, `attempt`, `access`, `outcomes`, `result_file`, `work_dir`, and `am_session == "s-1"`; the link file holds `session_id == "cc-1"`.
  - `test_marker_may_follow_text_agent_manager_adds`: a prompt with two lines before the marker still links.
  - `test_wrong_key_does_not_link`, `test_marker_for_a_recorded_step_does_not_link`, `test_second_session_with_the_same_marker_does_not_link`, `test_unknown_run_does_not_link`: no entry file is written and the result is `(0, "", "")`.
  - `test_ordinary_prompt_is_untouched`: a prompt with no marker returns `(0, "", "")` without reading any run folder (the runs folder does not exist in this test).
  - `test_hook_file_runs_through_the_dispatcher`: `hooks/dispatch UserPromptSubmit` with the payload on standard input exits 0, prints nothing, and the entry file exists.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_graph_step_hooks`. Expected: FAIL.
- [ ] **Step 3: Implement.** The hook file is the same eight-line wrapper as `hooks/UserPromptSubmit/40-ticket-comments`, calling `hooklib.main("UserPromptSubmit")` with `graphs/runner` on the path.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 7: The guard and the reflection nudge

**Files:**
- Modify: `graphs/runner/runner_lib/hooklib.py` (`guard`, `reflect`), `ledger/offer.py` (`hook_main`), `hooks/README.md`
- Create: `hooks/PreToolUse/20-graph-step-guard`, `hooks/PostToolUse/20-graph-step-reflect`
- Test: `tests/test_graph_step_hooks.py`, `tests/test_ledger_offer.py`

**Interfaces:**
- Consumes: `entry`, `paths.settings`, `ledger.graph_sessions`.
- Produces: `guard(payload: dict, environ: dict, now: float) -> Result`; `reflect(payload: dict, environ: dict, now: float) -> Result`; `calls(session_id) -> int`.

`guard`, for a session with an entry. The first rule that matches decides; a denial is `(2, "", "<message>")`:

1. The entry cannot be read: deny, `graph step guard: this session's run link cannot be read`.
2. The tool is `Write` and its `file_path` is the entry's `result_file`: allow, whatever follows.
3. Add one byte to `<id>.calls`. If the count is over `turn_cap`: deny, `turn cap reached: use the Write tool to write your result with the outcome that fits, then stop`.
4. `now - started_at` is at least `time_cap_seconds`: deny, `time cap reached: use the Write tool to write your result with the outcome that fits, then stop`.
5. The tool is `AskUserQuestion`: deny, `a step session does not ask questions: end with the outcome that says you need input`.
6. An MCP tool whose server name contains `atlassian` or `jira` (any case), unless its own name starts with `get`, `search`, `list`, `discover`, `executeRead` or `atlassian`: deny, `only gate scripts write to Jira`.
7. An MCP tool whose server name contains `github`, unless its own name starts with `get_`, `list_`, `search_` or ends with `_read`: deny, `only gate scripts write to GitHub`.
8. `Bash`, on the command text:
   - a `gh` command that is not `gh (pr|issue|repo|run|release|workflow) (view|list|diff|checks|status|watch)`, `gh search`, `gh auth status`, or `gh api` with no `-X`, `--method`, `-f`, `-F`, `--field`, `--raw-field` or `--input`: deny, `only gate scripts write to GitHub`;
   - a `jira` or `acli` command with any of the words `create`, `edit`, `update`, `transition`, `comment`, `assign`, `delete`, `link`, `move`, `archive`, `attach`: deny, `only gate scripts write to Jira`;
   - `security` followed by `find-`, `dump-` or `export`: deny, `a step session does not read the keychain`;
   - it names a secret path (below): deny, `a step session does not read secrets`;
   - it names a protected path (below) together with a redirect (`>`, `>>`), `tee`, or one of `rm`, `mv`, `cp`, `ln`, `touch`, `mkdir`, `chmod`, `truncate`, `dd`, `install`, `sed -i`, `python`, `python3`, `node`, `perl`, `ruby`: deny, `a step session does not change the runner, the ledger or another run`.
9. `Read`, `Grep` or `Glob` on a secret path: deny, as above.
10. `Write`, `Edit` or `NotebookEdit` on a protected path: deny, as above.
11. The entry's `access` is `read`: `Write`, `Edit` and `NotebookEdit` outside `work_dir` are denied; `Bash` with `git` followed by `commit`, `push`, `add`, `merge`, `rebase`, `reset`, `stash`, `tag`, `cherry-pick`, `revert`, `apply` or `am` is denied; `Bash` with a redirect or one of rule 8's write words is denied unless the command names `work_dir` or `result_file`. Message: `this step only reads: write nothing but your result and files in the work folder`.
12. Otherwise allow: `(0, "", "")`.

- **Secret paths:** a file whose name is `.env` or starts with `.env.`; a name holding `credentials`; `~/.aws/`, `~/.config/gh/hosts.yml`, `~/.netrc`, `~/Library/Keychains/`.
- **Protected paths** (`<home>` is `JOSH360_HOME`): `<home>/repo/`, `<home>/state/`, `~/.claude/settings.json`, `~/.claude/settings.local.json`, every folder under the runs folder except this run's, and this run's folder except `work/`, `prompts/` and the result file. A path is compared after `~` is expanded and symlinks are resolved, in both spellings.
- **A session with no entry** returns `(0, "", "")` before anything else is read: one `os.path.exists`.
- **`reflect`:** for a session with an entry, when `calls(id) // reflect_every` is greater than the number in `<id>.reflected`, store the new number and print `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "Josh 360 graph step: you have made <n> tool calls. Are you looping? Reassess, and if you are stuck, end with the outcome that says so."}}`. Otherwise print nothing.
- **The ticket offer** (`ledger/offer.py`, `hook_main`) returns 0 at once when `graph_sessions.is_graph_session(sid)`: a step session has its ticket by construction.
- Rule 8 and rule 11's Bash checks read the command text, so shell tricks can get past them. They narrow the obvious paths and are not a boundary; say so in `hooks/README.md`, as action-triage does for its own guard.

- [ ] **Step 1: Write the failing tests** in `tests/test_graph_step_hooks.py`. Each uses a linked session (`access` `josh` unless said) and asserts the exit code and the message's first words:
  - `test_ask_user_question_is_denied`; `test_jira_write_tool_is_denied_and_a_read_is_allowed` (`mcp__Atlassian_MCP__editJiraIssue` 2, `mcp__Atlassian_MCP__getJiraIssue` 0); `test_github_write_tool_is_denied_and_a_read_is_allowed`.
  - `test_gh_reads_pass_and_writes_do_not`: `gh pr view 5` and `gh api repos/o/r/pulls` are 0; `gh pr create`, `gh pr merge 5`, `gh api -X POST repos/o/r/issues` and `gh api repos/o/r/labels -f name=x` are 2.
  - `test_secrets_and_the_keychain_are_denied`: `Read` of `/x/.env`, `Bash` `cat ~/.aws/credentials`, and `Bash` `security find-generic-password -s jira-claude-api-key -w` are 2; `Read` of `/x/environment.md` is 0.
  - `test_the_rails_and_other_runs_are_protected`: `Edit` of `<home>/repo/hooks/PreToolUse/20-graph-step-guard`, `Write` into another run's `work/`, and `Bash` `echo x > <home>/state/ledger.db` are 2; `Write` into this run's `work/notes.md` is 0.
  - `test_read_step_writes_only_its_result_and_work_folder`: with `access` `read`, `Edit` of a worktree file, `Bash` `git commit -m x` and `Bash` `echo x > /tmp/y` are 2; `Write` to `work_dir/findings.md`, `Bash` `git diff main` and `Bash` `echo x > <work_dir>/y` are 0.
  - `test_josh_step_may_commit_and_push`: `Bash` `git commit -m x` and `git push` are 0.
  - `test_turn_cap_denies_everything_but_the_result`: with `turn_cap` 3, the fourth call (`Read`) is 2 with `turn cap reached`, and a `Write` to the result file after it is 0.
  - `test_time_cap_denies_everything_but_the_result`: three hours after the link, `Read` is 2 with `time cap reached` and the result `Write` is 0.
  - `test_unreadable_entry_is_denied`: with the entry file holding `{`, `Read` is 2.
  - `test_other_sessions_are_untouched`: a session with no entry gets `(0, "", "")` for `AskUserQuestion`, a Jira write and `cat .env`, and no `.calls` file is made.
  - `test_reflection_every_forty_calls`: with `reflect_every` 2, the second and fourth `PostToolUse` print the JSON and the first, third and fifth print nothing.
  - `test_guard_file_blocks_through_the_dispatcher`: `hooks/dispatch PreToolUse` with an `AskUserQuestion` payload for a linked session exits 2 with the message on standard error.
  - In `tests/test_ledger_offer.py`: `test_offer_is_quiet_in_a_graph_session`.
- [ ] **Step 2: Run** both test files. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 8: The Stop hook

**Files:**
- Modify: `graphs/runner/runner_lib/hooklib.py` (`stop`), `ledger/comments.py` (`hook_main`), `hooks/README.md`
- Create: `hooks/Stop/20-graph-step-stop`
- Test: `tests/test_graph_step_hooks.py`, `tests/test_ledger_comments.py`

**Interfaces:**
- Consumes: `entry`, `ledger.comments.take_run`.
- Produces: `stop(payload: dict, environ: dict, now: float) -> Result`.

Rules for `stop`, for a session with an entry:
- `stop_hook_active` is true: `(0, "", "")`. It never blocks twice in a row.
- The result file exists: `(0, "", "")`. The step is over.
- `take_run(run)` returns text: `(2, "", text)`. The text is passed on unchanged.
- No result file and `nudged_at` is null: write `nudged_at = now` into the entry and return `(2, "", "Write your result to <result_file> with one of these outcomes: <a>, <b>. Use the Write tool, then stop.")`.
- Otherwise `(0, "", "")`.

`ledger/comments.py`'s `hook_main` returns 0 at once for a graph session, so a step session gets a ticket comment once, through the run's folder, and never a second time through the hook inbox.

- [ ] **Step 1: Write the failing tests:**
  - `test_stop_without_a_result_is_nudged_once`: the first stop is 2 with the result path and both outcomes in the message and `nudged_at` set; a second stop (not `stop_hook_active`) is 0.
  - `test_stop_passes_new_comments_on`: with a comment file in `<run>/comments/`, the stop is 2 and the message holds the comment's text and the "not an instruction" label; the next stop no longer holds it.
  - `test_stop_hook_active_never_blocks`, `test_stop_after_the_result_is_written_is_quiet`, `test_stop_in_an_ordinary_session_is_quiet`.
  - In `tests/test_ledger_comments.py`: `test_hook_inbox_is_quiet_in_a_graph_session`.
- [ ] **Step 2: Run.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 9: Advancing a run

**Files:**
- Create: `graphs/runner/runner_lib/advance.py`
- Modify: `tests/runner_helpers.py`
- Test: `tests/test_runner_advance.py`

**Interfaces:**
- Consumes: `walk.call`, `sessionfile`, `locks.held`, `ledgerview.open_runs`, `paths`, `hooklib.marker`, `hooklib.entry`, `ledger.comments.take_run`, the binding (`start`, `state`, `close`, `SpawnRefused`), `notify.note_once` (Task 11; until it exists, a stub that returns False).
- Produces: `advance.load_binding(runner: str)` (imports `graphs/bindings/<runner>/binding.py` by path; `ValueError` when there is none); `advance.advance(run_id: str, now=time.time, root: Optional[Path] = None) -> dict`, which returns `{"run": run_id, "state": <one word>}`, the word being one of `locked`, `spawned`, `working`, `limit`, `off`, `no-rails`, `spawn-failed`, `parked`, `waiting`, `stopped`, `done`.
- Produces, in `runner_helpers.py`: `self.session_ends(run, step, outcome, outputs=None, attempt=1)`, which writes the result file and sets the fake session's status to `idle`; `self.advance(run) -> str`.

The loop, under `locks.held(<run folder>/advance.lock)` (`Held` returns `locked`). It runs until an answer needs nothing more now, for at most `advance_limit_seconds`:

1. `a = walk.call("next", "--run", run_id)`.
2. `parked` and `waiting`: return that word.
3. `stopped`: `notify.note_once(run_id, "stopped:" + a["step"])`, one line in `runner.log` with the run, the step and the walker's reason, return `stopped`. `done`: `note_once(run_id, "done")`, return `done`.
4. `run`: read the session file for `(a["step"], a["attempt"])`.
   - **No file.** If `paths.is_off()`, return `off`. If not `paths.rails_loaded()`, return `no-rails`. Under `locks.held(state_dir() / "spawn.lock")` (waiting up to 30 seconds for it): if `len(sessionfile.live(open run ids)) >= session_limit`, return `limit`; else write the file with state `spawning`, a new 16 hex digit `key`, `intent_at`, and the facts from the answer. Then take the comments (`take_run`), save their text in the file's `comments`, and call `binding.start(a, marker, comments)`. On success write state `started`, `started_at`, the handle; return `spawned`. On `SpawnRefused` write state `spawn_failed`, add one to `spawn_failures`, log the reason, return `spawn-failed`.
   - **`spawn_failed`.** If `spawn_failures >= spawn_tries`: abandon with reason `spawn-refused` (below) and go to 1. Else retry the spawn exactly as above, reusing the saved `key` and `comments`.
   - **`spawning`** (the process died around the spawn). If a link file exists: write state `started`, `started_at = intent_at`, a handle holding the link's `am_session`, and carry on as `started`. Else if `now - intent_at >= link_timeout_seconds`: abandon, `never-started`. Else return `working`.
   - **`started`.** In this order:
     1. The result file exists. If it does not parse as JSON and is younger than `result_settle_seconds`, return `working`. Else `walk.call("record", "--run", run_id, "--step", step, "--result-file", path, "--model", handle model, "--tool", "claude-code")`, plus `--session <link's session_id>` when there is a link. On success write state `recorded` and `ended_at`; if `archive_finished_sessions`, set `closed = binding.close(handle)`; go to 1. On `WalkerRefused`: abandon, `bad-result`.
     2. No link file and `now - started_at >= link_timeout_seconds`: abandon, `never-started`.
     3. `now - started_at >= time_cap_seconds + time_cap_grace_seconds`: abandon, `time-cap`.
     4. `s = binding.state(handle)`. `gone`: abandon, `session-gone`. `unknown`: return `working`. `working`: clear `resting_since`, return `working`. `resting`: set `resting_since = now` when it is null; the clock is the entry's `nudged_at` when set, else `resting_since`; if `now - clock >= rest_timeout_seconds`, abandon, `rested-without-result`; else return `working`.
   - **`recorded` or `abandoned`** for the attempt the walker still has open cannot happen; log it and return `working` without changing anything.
5. **Abandon** is: `walk.call("abandon", "--run", run_id)`; write state `abandoned`, `reason`, `ended_at`; one line in `runner.log`; never `close` (an abandoned session stays visible); go to 1. The walker then starts the step again as another attempt or stops the run, by its own rules.
6. **When the runner is off**, the loop still records a finished session (4, started, 1) and then returns `off` instead of going to 1, so no gate runs and no step starts.

- [ ] **Step 1: Write the failing tests** in `tests/test_runner_advance.py` (fixture graph `valid`, runs started with `--runner agent-manager`):
  - `test_first_advance_starts_one_session`: the state is `spawned`; one spawn was logged; the session file's state is `started`.
  - `test_second_advance_while_working_changes_nothing`: the state is `working` and still one spawn was logged.
  - `test_finished_session_is_recorded_and_the_run_moves_on`: after `session_starts` and `session_ends("design", "ready", {"spec_path": ...})`, `advance` records `design` with `outcome == "ready"`, a `session` equal to `cc-1`, the tier's model, runs the `lint_spec` gate, and returns `parked` at `approve_spec`; the session file's state is `recorded`, `closed is True`, and the fake's row is archived.
  - `test_archive_can_be_switched_off`: with `archive_finished_sessions` false, no `archive` call is logged.
  - `test_session_limit_holds_across_runs`: with two runs working, a third run's `advance` returns `limit` and logs no spawn; after one finishes it spawns.
  - `test_restart_does_not_start_a_second_session` (scenario "A run survives a restart"): a new process calling `advance` for a run whose session is `working` logs no spawn and returns `working`.
  - `test_crash_after_spawn_is_adopted_through_the_link`: a session file left at `spawning` plus a link file becomes `started` and no spawn is logged.
  - `test_crash_before_spawn_is_abandoned_after_the_link_timeout`: a file left at `spawning` with no link returns `working` at 9 minutes and is `abandoned` with `never-started` at 10; the walker then shows `design` at attempt 2 and one new spawn.
  - `test_rested_without_a_result_is_abandoned` (scenario "A step that never ends is bounded"): the fake's status `idle`, a `nudged_at` in the entry, eleven minutes later: `abandoned`, `rested-without-result`; the fake's row is not archived.
  - `test_resting_with_no_nudge_uses_first_seen_resting`: `idle` with `nudged_at` null is `working` on the first pass and abandoned on a pass ten minutes later.
  - `test_gone_session_is_abandoned`; `test_unknown_state_changes_nothing` (the fake database removed: `working`, the session file unchanged apart from nothing).
  - `test_time_cap_abandons_after_the_grace`: `working` at 3 hours 14 minutes, `abandoned` with `time-cap` at 3 hours 15.
  - `test_result_with_an_undeclared_outcome_abandons_the_attempt`: reason `bad-result`, and the run is at attempt 2.
  - `test_half_written_result_is_left_for_the_next_pass`: a result file holding `{"outc` that is ten seconds old returns `working`; the same file at seventy seconds is abandoned with `bad-result`.
  - `test_step_that_keeps_failing_ends_as_the_walker_says`: abandoning `design` again and again (its tier's run cap is 3 in the fixture tiers) ends with `advance` returning `stopped` and no further spawn, and `note_once` was called once for it.
  - `test_spawn_refused_three_times_abandons_the_attempt`: `spawn_fails` set; three advances return `spawn-failed`, the fourth abandons with `spawn-refused`.
  - `test_no_rails_no_session`: with the `Stop` entry missing from the made-up settings, the state is `no-rails`, no spawn is logged and no session file is written.
  - `test_off_switch_records_but_starts_nothing`: with `runner-off` present, a finished session is recorded, the state is `off`, the next gate has not run and no spawn is logged; a run with no session returns `off`.
  - `test_two_advances_never_drive_one_run`: with the run's lock held by another process, the state is `locked`.
  - `test_comments_reach_the_first_prompt`: a comment file in `<run>/comments/` appears in the logged `--prompt` and is not handed over twice.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_runner_advance`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 10: The tick, the job and the terminal loop

**Files:**
- Create: `graphs/runner/runner_lib/tick.py`, `graphs/runner/runner.py`, `graphs/runner/tick_job.py`
- Modify: `jobs.yaml`, `tests/test_follow.py`
- Test: `tests/test_runner_tick.py`

**Interfaces:**
- Consumes: `watch.watch`, `watch.load_rules`, `watch.jira_client`, `advance.advance`, `ledgerview.open_runs`, `ledgerview.open_step`, `locks`, `status.snapshot` (Task 11), `notify`.
- Produces: `tick.needs_advance(conn, run: dict) -> bool`; `tick.detached(run_id: str) -> None` (the launcher); `tick.tick(now=time.time, launcher=tick.detached, jira="default", root=None) -> dict` (the report); `tick.loop(sleep=time.sleep, turns: Optional[int] = None) -> None`; `tick.heartbeat_report(now: float) -> dict`.
- Produces, `runner.py` commands: `tick`; `advance --run <id>`; `start --graph <g> --ticket <KEY> [--input name=value ...]`; `status [--json]`; `report --run <id> [--json] [--from-json <file>]`; `loop`. Every command takes `--graphs-root` (tests). Each prints one JSON value, or text for `status` and `report`, and exits 0, or 2 with `{"error": ...}`.

Rules:
- **`tick`** takes `locks.held(state_dir() / "tick.lock")`; when it is held, it returns `{"status": "busy"}`. If the runner is off, it skips the watch. Otherwise it runs `watch.watch` with the rules file and the Jira client. Then, for every run in `open_runs(conn, "agent-manager")` with `needs_advance`, it calls `launcher(run_id)`. Last, it builds `status.snapshot`, adds the watch result under `watch`, writes it to `state_dir() / "report.json"`, and returns it.
- **`needs_advance`** reads files and the ledger only, never the walker or the binding. It is False when the run's advance lock is held; when `run.json` cannot be read; when `run.json` has `stopped` and `<run>/runner.json`'s `noted` list holds `stopped:<that step>`; and when the run's open step is an ask whose question record's state is `open`. Otherwise True.
- **`detached`** starts `[sys.executable, runner.py, "advance", "--run", run_id]` with `stdin` from `/dev/null`, standard output and error appended to `paths.run_log(run_id)`, `start_new_session=True`, `close_fds=True`, and does not wait.
- **The job.** `tick_job.py` reads `settings()["host"]`. With `job` it runs `tick()` and prints the report. With `terminal` it prints `heartbeat_report(now)`: the loop's last `report.json` plus `"loop": {"stale": <bool>}`, where stale means the heartbeat file `state_dir() / "heartbeat.json"` is missing or older than `heartbeat_stale_seconds`; when it turns stale it sends one notification (`Josh 360 runner`, `The graph runner loop has stopped. Start it again in an Agent Manager terminal.`), and no second one until the heartbeat has been fresh again. It always exits 0.
- **`loop`** refuses to start (exit 2) when `host` is not `terminal` or when another loop holds `state_dir() / "loop.lock"`. Each turn it runs `tick()`, writes `{"at": <now>, "pid": <pid>}` to the heartbeat file, and sleeps `tick_seconds`. An exception in a turn is logged and the loop goes on.
- **`start`** calls `walk.call("start", ..., "--runner", "agent-manager")` and prints its answer. It works when the runner is off: it starts no session.
- **The report holds nothing that changes on every pass** (no "generated at"), because the job runner pushes a report to `laptop-status` only when it changes.
- **`jobs.yaml`:** add

```yaml
  - id: graph-runner
    run: graphs/runner/tick_job.py
    every: 5m
    timeout: 5m
    report: true
    description: JP-117. Watches Jira for tickets that should have a graph run (Ready and in an open sprint) and moves every open run forward one step, each model step in a visible Agent Manager session. No model call of its own. The report is counts, ids, step names and times only.
```

- [ ] **Step 1: Write the failing tests** in `tests/test_runner_tick.py`. Unless said, `launcher` is a list's `append`:
  - `test_tick_starts_a_run_and_launches_its_advance` (scenario "Nobody starts the run by hand"): with a Ready ticket in an open sprint, the report's `watch.development.started == ["JP-901"]` and the launcher got that run's id.
  - `test_ready_in_the_backlog_launches_nothing` (scenario "Ready alone does not start a run").
  - `test_failed_search_leaves_open_runs_alone` (scenario "A failed Jira read starts and ends nothing"): `watch.development.jira == "unknown"`, the ledger's step rows are unchanged, and the open run is still launched.
  - `test_parked_run_is_not_launched_until_it_is_answered`: a run parked at `approve_spec` is not launched; after `answer_in_app` it is.
  - `test_stopped_run_is_launched_once`: a stopped run is launched on the first tick and, once its stop is noted, not on the second; after `walker retry` it is launched again.
  - `test_locked_run_is_not_launched`; `test_off_switch_skips_the_watch` (the report has no `watch` results and the fake Jira's call log is empty).
  - `test_two_ticks_at_once`: with the tick lock held, the result is `{"status": "busy"}`.
  - `test_report_does_not_change_between_idle_passes`: two ticks with nothing happening give equal reports.
  - `test_detached_child_does_not_hold_the_pass`: `runner.py tick` as a real subprocess, with a fixture gate that sleeps 20 seconds on the run's path, returns in under 10 seconds, and `paths.run_log(run)` exists within 5 seconds.
  - `test_terminal_host_job_reports_a_stale_loop`: with `host` `terminal` and no heartbeat, `tick_job` prints `loop.stale == true` and one notification was noted; with a fresh heartbeat it prints `false`; `tick_job` logs no spawn in either case.
  - `test_loop_refuses_under_the_job_host`; `test_loop_ticks_and_beats`: with `turns=2` and a sleep stub, two ticks ran and the heartbeat file exists.
  - `test_start_command`: `runner.py start --graph valid --ticket JP-901 --input system=sample` prints a run id and the run's `runner` is `agent-manager`.
  - `test_shipped_job_entry`: `jobs.yaml` has `graph-runner` running `graphs/runner/tick_job.py` every 300 seconds with `report: true`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_runner_tick`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `tests/test_follow.py`, add `reports/graph-runner.json` to the expected list and a clause to its comment (the runner finds no credentials and no runs in the made-up home; its report is counts and ids).
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 11: Status, the run report and notifications

**Files:**
- Create: `graphs/runner/runner_lib/status.py`, `graphs/runner/runner_lib/notify.py`
- Test: `tests/test_runner_report.py`

**Interfaces:**
- Consumes: `ledgerview`, `sessionfile`, `paths`, `runfolder`, `walker_lib.graphfile.load` (for a step's Jira status only).
- Produces: `status.snapshot(conn, now: float, root=None) -> dict`; `status.text(snapshot: dict) -> str`; `status.run_report(conn, run_id: str, root=None) -> dict`; `status.render(report: dict) -> str` (Markdown); `notify.notify(title: str, text: str) -> bool`; `notify.note_once(run_id: str, what: str) -> bool` (True the first time `what` is noted for the run).

The snapshot:

```json
{"status": "ok", "host": "job",
 "runs": {"open": 3, "working": 1, "queued": 0, "parked": 1, "waiting": 1, "stopped": 0, "between": 0},
 "open_runs": [{"run": "r-7f3a09c1d2e4", "graph": "development", "ticket": "JP-116", "step": "build", "state": "working", "since": "2026-11-18T14:02:11Z"}],
 "sessions_live": 1, "session_limit": 2, "rails": true,
 "stopped": [{"run": "r-...", "ticket": "JP-9", "step": "verify"}],
 "waiting_over_7_days": [{"run": "r-...", "ticket": "JP-7", "step": "await_merge", "since": "2026-11-09T10:00:00Z"}],
 "ended_runs": [{"run": "r-...", "graph": "development", "ticket": "JP-116", "end": "finished", "score": "success", "ended_at": "...", "steps": [...]}]}
```

Rules:
- **`status`** is `off` when `paths.is_off()`, else `ok`. `rails` is `paths.rails_loaded()`.
- **A run's state:** `stopped` (`run.json` has `stopped`); else `waiting` (`run.json` has `waiting`; `since` is its `since`); else `parked` (the open step is an ask); else `working` (an open role step whose session file is live); else `queued` (an open role step with no live session); else `between`. A run whose folder cannot be read is listed with the state `unreadable`.
- **`waiting_over_7_days`** lists every run in the `waiting` state whose `since` is at least `wait_flag_days` old.
- **`ended_runs`** holds every agent-manager run that ended in the last `ended_runs_days`, newest first, at most 10, each with its `run_report` steps. This is how the proof page reaches the cloud.
- **`run_report`** is `{"run", "graph", "ticket", "runner", "started_at", "end", "score", "steps": [{"step", "kind", "attempt", "loop_count", "tier", "model", "session", "outcome", "jira_status", "started_at", "ended_at"}]}`, the steps from `ledgerview.run_rows`. `jira_status` is the status of the step's stretch in the graph file, and null for `_entry`, `_exit` or a step the graph no longer has. No note, question or answer text.
- **`render`** prints a heading (`<ticket> · <graph> · <run>`), one line with the end and score, and a table with the columns Step, Kind, Attempt, Loops, Tier, Model, Session, Outcome, Jira status, Started, Ended.
- **`text`** prints one line per open run (`<ticket> <graph> <step> <state> since <time>`), then the stopped runs, then the long waits under the heading `Waiting more than 7 days`.
- **`notify`** runs `/usr/bin/osascript -e 'display notification "<text>" with title "<title>"'` with quotes and backslashes escaped, only on macOS and when `JOSH360_NO_NOTIFY` is not set; any failure is False. `note_once` keeps the `noted` list in `<run folder>/runner.json`; the first time, it sends `Josh 360 runner` with `<ticket or run id>: the <graph> run stopped at <step>.` or `<ticket or run id>: the <graph> run ended.`

- [ ] **Step 1: Write the failing tests** in `tests/test_runner_report.py`:
  - `test_snapshot_states`: four runs (a working session; parked at an ask; a wait that answered `pending`; stopped by a failed gate) give `runs == {"open": 4, "working": 1, "queued": 0, "parked": 1, "waiting": 1, "stopped": 1, "between": 0}`, and each `open_runs` row has the right `step` and `state`.
  - `test_waits_over_seven_days_are_listed`: a wait whose `since` is eight days back is in `waiting_over_7_days`; one six days back is not.
  - `test_run_report_has_every_step` (scenario "The whole run is in the ledger"): for a finished run of `valid`, every row has `outcome`, `loop_count` and, for a role step, `session`, `tier` and `model`; the `build` row's `jira_status` is `In Progress`.
  - `test_report_holds_no_text_from_the_run`: with a gate summary, a question and an answer that all contain the word `ZEBRA`, `json.dumps(snapshot)` and `json.dumps(run_report)` do not contain it.
  - `test_render_is_a_table`: the Markdown has the eleven column names and one row per step.
  - `test_report_from_the_published_json`: `runner.py report --run <id> --from-json <a snapshot file>` prints the same Markdown as `--run <id>` on the laptop.
  - `test_note_once`: the first `note_once(run, "stopped:build")` is True, the second False, and `note_once(run, "done")` is True.
  - `test_notify_is_off_in_tests`: `notify("a", "b")` is False with `JOSH360_NO_NOTIFY=1` and runs no process.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 12: Whole runs, the JP-116 triage job and documents

**Files:**
- Create: `tests/test_runner_runs.py`, `graphs/runner/triage_jp116_job.py`, `graphs/runner/README.md`, `docs/proof/<build date>/JP-117/README.md`
- Modify: `jobs.yaml`, `tests/test_follow.py`, `scripts/doctor_lib/hook_checks.py` (`NAMED`), `docs/platform-doctor.md`, `tests/test_doctor.py` if it counts the named hooks, `AGENTS.md` (Commands, Layout), `graphs/README.md`, `docs/decisions/JP-117.md`, the spec (an "As built" section)

**Interfaces:**
- Consumes: everything above.
- Consumes: the fixture graph `runner-sample` (Task 3).
- Produces: the job `jp-117-triage-jp-116`.

The triage job (`triage_jp116_job.py`, run hourly, always exits 0, prints one JSON value): when the ledger has any triage run for JP-116 it prints `{"status": "exists", "run": <id>}`; when `state_dir() / "report.json"` is missing (no tick has finished yet) it prints `{"status": "waiting", "why": "no tick yet"}`; when there are no Jira credentials, `{"status": "waiting", "why": "no jira credentials"}`; otherwise it calls `walk.call("start", "--graph", "triage", "--ticket", "JP-116", "--runner", "agent-manager", "--input", "reason=new")` and prints `{"status": "started", "run": <id>}`, or `{"status": "waiting", "why": "not admitted"}` with the walker's message in `runner.log`.

```yaml
  - id: jp-117-triage-jp-116
    run: graphs/runner/triage_jp116_job.py
    every: 1h
    timeout: 5m
    report: true
    description: JP-117, temporary. Starts the triage run of JP-116, the runner's proof ticket, once the runner has ticked; does nothing once that run exists. Removed with the proof page.
```

- [ ] **Step 1: Write the failing tests** in `tests/test_runner_runs.py`. A helper `drive(run, plays)` calls `tick` with an inline launcher (`advance` in process) until the run ends, playing each role step from `plays` (`session_starts`, then `session_ends`) and answering asks with `answer_in_app`:
  - `test_a_ticket_goes_from_the_sprint_to_the_end_with_no_hand_start`: a Ready ticket in an open sprint, routed to `runner-sample` by the test rules file of Task 4; `drive` ends with `finished`; three spawns were logged, named `JP-901 - Draft (...)`, `JP-901 - Make (...)`, `JP-901 - Look (...)`; all three fake sessions are archived; `graph_runs.runner == "agent-manager"`.
  - `test_josh_is_asked_only_at_the_named_points` (scenario 2): every row of `asks` for the run has a step in the graph header's `asks_josh`, and every Needs you record written is for one of those steps.
  - `test_reordering_two_gates_needs_no_runner_change` (scenario 4): a copy of the fixture with `check_b` written before `check_a` runs to `finished` with the same plays; the gate log shows the two orders differ between the copies.
  - `test_the_read_step_is_guarded_as_read_and_the_build_step_is_not`: during `look`, `guard` denies an `Edit`; during `make`, it allows one.
  - `test_a_step_session_cannot_ask_or_write_to_jira` (scenario 9): during `draft`, `guard` denies `AskUserQuestion` and `mcp__Atlassian_MCP__transitionJiraIssue`.
  - `test_run_survives_everything_being_restarted` (scenario 8): between every pair of ticks the test drops every in-process object and builds the next call from the files and the ledger alone; the run still ends `finished` with three spawns.
  - `test_triage_job_starts_once`: with a triage fixture graph, a tick report and credentials, the first call prints `started`, the second `exists`, and one run exists; with no `report.json` it prints `waiting`.
  - `test_runner_code_has_no_graph_logic`: no file under `graphs/runner/` or `graphs/bindings/` contains `max_loops`, `at_limit`, `.needs(`, `"when"` or `["on"]`; no file under `graphs/runner/` contains `agent-manager spawn` or `tmux`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_runner_runs`. Expected: FAIL.
- [ ] **Step 3: Implement** the job and its `jobs.yaml` entry; add `reports/jp-117-triage-jp-116.json` to `tests/test_follow.py`.
- [ ] **Step 4: Documents.**
  - `graphs/runner/README.md` (with Contents): what the runner is; `status`, `report`, `start`; the off switch (`touch ~/.josh-360/state/runner-off`, remove it to resume) and `laptop-pause`; turning one graph's starts off; the two hosts and how to start the loop terminal; where the logs are; `walker.py retry` and `allow` for a stopped run.
  - `AGENTS.md`: a Commands line for the runner and a Layout line for `graphs/runner/` and `graphs/bindings/agent-manager/`.
  - The doctor: add `("graph-step", "JP-117", ["UserPromptSubmit/20-graph-step", "PreToolUse/20-graph-step-guard", "PostToolUse/20-graph-step-reflect", "Stop/20-graph-step-stop"])` to `NAMED`, and the same row to `docs/platform-doctor.md`.
  - `docs/decisions/JP-117.md`: add a row for any choice the build made that this plan did not.
  - The spec: an "As built" section listing what differs from the design. Start from [Choices this plan makes](#choices-this-plan-makes).
  - `docs/proof/<build date>/JP-117/README.md`: one line per `@auto` scenario with the test that proves it and its output, and the full `check.py` tail.
- [ ] **Step 5: Run** `python3 scripts/check.py`. Expected: `check.py: ok (0 problem(s))`. Commit.
- [ ] **Step 6: Open the pull request** from `JP-117-graph-runner` (`Part of JP-117`, because the laptop scenario follows), label it `review:needs-agent-audit`, take it through the ceremony and merge on a green `suite` (`docs/WORKFLOW.md` §4 and §5). The Rollout section names what happens on the laptop at merge: the job `graph-runner` starts ticking within about 10 minutes, the hourly job starts JP-116's triage run, and, when `host` is `terminal`, Josh (or a session he asks) starts the loop once with the command in `graphs/runner/README.md`.

### Task 13: The proof run on the laptop

This task is watching and fixing, not building. It runs after Task 12's pull request has merged and the laptop has installed it (`python3 laptop/status.py show`). Josh acts twice (spec, "The proof run"); everything else is the runner's.

- [ ] **Step 1: The runner is alive.** `python3 laptop/status.py show graph-runner` shows `status: ok`, `rails: true` and the `host` Task 1 set. `rails: false` means a dispatcher entry is missing: ask Josh to run the doctor's fix (`python3 ~/.josh-360/repo/scripts/doctor.py --fix`). With `host: terminal`, `loop.stale` must be false.
- [ ] **Step 2: Ask Josh for his first act**, in the thread, once: turn sprints on for the JP project (Project settings, Features) and create and start a sprint.
- [ ] **Step 3: JP-116 is triaged.** `python3 laptop/status.py show jp-117-triage-jp-116` shows `started`, and the triage run appears in the runner's report and ends with JP-116 Ready. If triage sends the ticket back, that is triage working: answer what it asks through the ticket, as its author would.
- [ ] **Step 4: Ask Josh for his second act:** move JP-116 into the started sprint.
- [ ] **Step 5: Watch the development run** in the runner's report until it ends. For each fault, fix the graph, the gate or the runner in its own small pull request (`JP-117-<slug>`), and let the run repeat (`walker.py retry`, or a new run with `--allow-repeat` when the sixth-run rule applies). Check the two things the spec says the proof run checks: the first session started in under a minute (A16.6), and the ledger found a transcript for a linked session (A16.4).
- [ ] **Step 6: The proof page.** When the run has ended `finished`: save the published report (`python3 laptop/status.py show graph-runner`) to a file, run `python3 graphs/runner/runner.py report --run <id> --from-json <file>`, and commit its output as `docs/proof/phase-1-graphs.md` with the pull request's link and the ticket's status history. In the same pull request remove the job `jp-117-triage-jp-116` and its script, and finish the spec's "As built". Label, ceremony, merge on green.
- [ ] **Step 7: Close.** Move JP-117 to Done with a comment linking the proof page, and tell the coordinator.

## Laptop checks owed after the build

None blocks the build's pull request. Each is read from `laptop-status` or the proof run.

1. The probe's two open answers (Task 1: a spawn with Claude Code on the PATH, and the detached child), and that the session "JP-117 probe - safe to archive" was archived.
2. The real JQL (`sprint in openSprints()`, `ORDER BY Rank ASC`) returns JP-116 once it is in the sprint and nothing before (Task 13, steps 3 and 4).
3. `AGENT_MANAGER_SESSION_ID` is in a hook's environment, so the link file's `am_session` is set. If it is not, `state` uses the spawn reply's id, which the handle already holds; an adopted session (a crash around the spawn) then has no id and reads `unknown` until its result file or the time cap ends it.
4. `binding.json`'s `id_fields` matches the real `spawn --json` reply, and a session that has stopped with no result shows a status filed under `resting`.
5. A real prompt fits in one `--prompt` argument (the binding's file fallback covers a long one).
6. The first session of the proof run starts in under a minute, and its transcript is found by the ledger (the spec's checks for A16.6 and A16.4).
7. A notification appears for a stopped run (or the proof run never stops, and this is checked by stopping a throwaway run).

## Choices this plan makes

Each is recorded in `docs/decisions/JP-117.md` with its undo.

1. Both hosts are built behind one setting, and the probe picks. The "advance inside the tick" variant is not built.
2. The job runs `graphs/runner/tick_job.py`, because a job is a `.py` file with no arguments.
3. The walker's `run` answer gains `graph`, `ticket`, `access`, `work_dir` and `phi`.
4. `resume_from` is the ticket's last ended run of the graph (source `last_run`), used only when the route record's `returned_from` is set. The record holds a comment id there, and `read-dev-ticket` needs a run id to find the saved spec.
5. `starts.json` is `{"per_pass": 1, "graphs": {...}}`, so the per-pass number has a place.
6. The runner calls the walker in process, through one function.
7. A session file is written before the spawn; the link hook writes its own file beside it; the marker carries a key.
8. No rails, no session: the runner starts nothing while a dispatcher entry is missing.
9. A step whose session cannot be started three times is abandoned, so the walker's run cap ends it.
10. A result file that does not parse is left alone until it is a minute old.
11. The guard's Bash rules read the command text. They narrow the obvious paths and are not a boundary.
12. The JP-116 triage job runs hourly until the run exists, not `once`: a `once` job stops at its first exit 0, and a refusal must be tried again.
13. A run starts with `--phi` when its `phi` input is true, so the ledger keeps no text from it.
14. The published report holds no value that changes on every pass, and carries the rows of runs that ended in the last 14 days.
15. The fake Jira judges JQL only when a test asks it to.
16. The ticket offer and the hook inbox for comments stay quiet in a graph session.
17. Locks are `flock`, so a killed process never leaves one behind.
18. Agent Manager's group, status words, model names and archive command are in `graphs/bindings/agent-manager/binding.json`.
19. The binding puts Claude Code's folder on the PATH for every `agent-manager` call, because a job's PATH does not have it and Agent Manager then refuses the spawn.
20. Under the terminal host, a stopped loop is a notification and Josh (or a session) starts it again. Starting it from the job with `agent-manager terminal create` is not built.
21. `finished` and `waiting` count as resting, so a session in either state with no result is abandoned after ten minutes and not at once.

## Spec coverage

| Spec section | Task |
| --- | --- |
| No long-lived process: the tick | 3 (locks), 10 |
| Watching Jira: the start rules | 4 |
| Advancing a run | 9 |
| Sessions in Agent Manager: the binding | 5 |
| How a session is linked to its run | 6 |
| Safety rails A16.3, A16.5 | 7 |
| Safety rails A17.1, the Stop hook, ticket comments | 8, 9 |
| A16.1, A16.2, A16.4, A16.6, A17 orphan sweep (not carried, or checked in the proof run) | 13 |
| Asking Josh, and what is not a question | 9 (stopped runs), 11 (notification), 12 (test) |
| What the ledger shows | 9 (`record --session --model`), 11 |
| Seeing and stopping it | 10 (off switch, `start`), 11 (`status`, seven-day list) |
| What is carried over from action-triage (A9) | 4 (unknown reads, spec parse), existing gates |
| The probe, and the fallback | 1, 10 (`loop`, heartbeat) |
| The proof run | 12 (triage job), 13 |
| Files | File map |
| Scenario: A real ticket reaches a pull request (`@laptop`) | 13 |
| Scenario: Josh was asked only at the named points | 12 |
| Scenario: The whole run is in the ledger | 11 |
| Scenario: The binding holds no graph logic | 12 |
| Scenario: Nobody starts the run by hand | 4, 10, 12 |
| Scenario: Ready alone does not start a run | 4, 10 |
| Scenario: A failed Jira read starts and ends nothing | 4, 10 |
| Scenario: A run survives a restart | 9, 12 |
| Scenario: A step session cannot ask Josh or write to Jira | 7, 12 |
| Scenario: A step that never ends is bounded | 9 |
| Q1 development only; Q2 two sessions; Q3 archive | 4 (`starts.json`), 9 (`session_limit`), 9 (`close`) |
