# Post-deploy validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Contents

- [Global Constraints](#global-constraints)
- [The five tickets](#the-five-tickets)
- [Review Focus](#review-focus)
- [File map](#file-map)
- [Shared shapes](#shared-shapes)
- [Parallel lanes](#parallel-lanes)
- [Tasks](#tasks)
  - [Task 1: The section parser and the collector list](#task-1-the-section-parser-and-the-collector-list)
  - [Task 2: The Ready items, the drafted ticket and J6](#task-2-the-ready-items-the-drafted-ticket-and-j6)
  - [Task 3: The ticket format documents](#task-3-the-ticket-format-documents)
  - [Task 4: Local report copies and the laptop collectors](#task-4-local-report-copies-and-the-laptop-collectors)
  - [Task 5: The ledger, Jira and GitHub collectors](#task-5-the-ledger-jira-and-github-collectors)
  - [Task 6: The timetable and the grading rules](#task-6-the-timetable-and-the-grading-rules)
  - [Task 7: The check log and one call of the watch](#task-7-the-check-log-and-one-call-of-the-watch)
  - [Task 8: The copy, the entry gate, the reader and the verdict](#task-8-the-copy-the-entry-gate-the-reader-and-the-verdict)
  - [Task 9: Starting the watch and the two waits](#task-9-starting-the-watch-and-the-two-waits)
  - [Task 10: Closing, the Bug and the hold](#task-10-closing-the-bug-and-the-hold)
  - [Task 11: The graph file and whole runs](#task-11-the-graph-file-and-whole-runs)
  - [Task 12: The start rule and the waiting list](#task-12-the-start-rule-and-the-waiting-list)
  - [Task 13: Loose ends, the doctor check and the documents](#task-13-loose-ends-the-doctor-check-and-the-documents)
  - [Task 14: The movers in the two graphs](#task-14-the-movers-in-the-two-graphs)
  - [Task 15: The movers in the workflow documents](#task-15-the-movers-in-the-workflow-documents)
  - [Task 16: The proof run on the laptop](#task-16-the-proof-run-on-the-laptop)
- [Laptop checks owed after the build](#laptop-checks-owed-after-the-build)
- [Choices this plan makes](#choices-this-plan-makes)
- [Spec coverage](#spec-coverage)

**Goal:** Every Story, Task and Bug says how it will be proven after it ships, and a graph with no model in it watches each ticket that lands in Deployed until it can move it to Done with evidence, file one linked Bug, or ask Josh one question.

**Architecture:** One parser reads a ticket's Validation section for the Ready check, the validation graph and the movers. Six read-only collectors each return a reading of numbers and short codes. A wait step's script (`watch-criteria`), called every five minutes by the graph runner, answers "not yet" from two small files until a check is due, then takes a reading per criterion, adds a line to a check log in the run's work folder, and grades the log. Nine gate scripts around it post the comments, move the ticket, file the Bug and build the one question. The development and non-development graphs gain a last step that sends a finished ticket to Deployed or Done by the same parser.

**Tech Stack:** Python 3.9, standard library only for everything that runs on the laptop (gate scripts, `graphs/gates/lib/`, `laptop/`, `ledger/`, `scripts/doctor_lib/`). PyYAML only where the repository already uses it (the graph checker and compiler). Tests are stdlib `unittest` in `tests/` and `graphs/tests/`, run by `python3 scripts/check.py`, with the fake Jira (`graphs/gates/lib/jira_fake.py`), the fake GitHub (`graphs/tests/dev_helpers.py`) and the real walker.

**Spec:** `docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md` (approved by Josh on 18 November 2026 with option A: a criterion a script cannot measure goes to Josh once, and no step uses a model). Read it with this plan: its field table, grading tables, exact copy and scenarios are quoted here only where a task needs a value. The draft graph beside it (`docs/superpowers/specs/2026-11-18-post-deploy-validation-draft/`) is the starting point for Task 11. Design ticket: JP-164. Build on the latest `main`.

## Global Constraints

- **No model anywhere.** No step has a role or a tier, no script calls a model, and nothing read from a production system is handed to one.
- **Python 3.9, standard library only** for every file this plan creates outside `tests/` and `graphs/tests/`.
- **Unknown is not a pass, not a fail and not empty.** A collector that cannot read answers unknown. A Jira read that fails changes nothing: the watch keeps waiting, the ticket is not treated as moved, cancelled or missing, and nothing is closed.
- **A collector only reads.** It never runs text from a ticket: no shell command, no SQL, no file path built from the argument outside the folders named in its task. The argument is checked against the collector's declared pattern before any reader sees it.
- **Numbers and short codes only.** A reading's values are an `int`, a finite `float`, a string matching `^[A-Za-z0-9_.-]{1,32}$`, or unknown. Everything else is dropped to unknown by `reading.take`, which every collector returns through. The check log, the tally, the evidence table, the card and the Bug are built from those values, the ticket's own criteria text and counts.
- **A wait writes only its own notes.** `watch-criteria` and `fix-closed` have access `read`. Their only writes are files in `<run>/work/watch/`. A call that answers `pending` because nothing is due writes nothing at all.
- **Rule 9.** No script moves, flags or comments on a ticket it reads as no longer in Deployed. A script that cannot read the status stops the run (`GateError`) instead of guessing.
- **Patient data.** Every comment and the Bug go through `lib.gate_run.say` or `screened`, as every gate's writes do. Tests use made-up tickets, job ids and readings.
- **Deployed is JP only.** The start rule's search names project JP, and the movers send only `JP-<n>` keys to Deployed.
- **Bounds, from the spec:** "Check every" 1 to 168 hours; "Give up after" 1 to 90 days; "Fail after" 3 when left out; a watch that has not begun 90 days after its round started ends as `no_data`; the ticket's status is looked at no more than once an hour between checks; a "Needed: no" reason has at least four words. Set by this plan: a doctor report older than 36 hours reads as unknown, and a `jira-count` search that returns more than 200 issues reads as unknown.
- **Exact copy.** The seven comments, the question and the Bug template are in the spec's "Exact copy". They live in one module (`graphs/gates/lib/validation_copy.py`), and its tests compare each against the spec's words with the values filled in.
- **Compile.** After changing a graph file, a role or an agent, run `python3 graphs/tools/compile_graphs.py` and commit the copies in `graphs/compiled/`.
- **File size.** New modules stay under 400 lines. `graphs/gates/lib/triage/checklist.py` is at 320 lines, so the V items go in their own module.
- **Commits:** one per file, messages starting with the build ticket's key (`JP-165: ` and so on). Each task ends with `python3 scripts/check.py` printing `check.py: ok (0 problem(s))`.

## The five tickets

Each ticket is one pull request from one build thread, on a branch cut from `main`, with `Fixes JP-<n>` in the body.

| Ticket | What it builds | Tasks | Branch | Waits for |
| --- | --- | --- | --- | --- |
| JP-165 | The ticket format: parser, Ready items V1 to V7, drafted tickets, J6, documents | 1, 2, 3 | `JP-165-validation-section` | nothing |
| JP-166 | The collectors, the grading rules and the watch's one call | 4, 5, 6, 7 | `JP-166-validation-collectors` | nothing |
| JP-167 | The validation graph, its gates, the start rule, loose ends, the doctor check | 8 to 13 | `JP-167-validation-graph` | JP-165, JP-166 |
| JP-168 | The movers: the two graphs' last steps and the workflow text | 14, 15 | `JP-168-validation-movers` | JP-165, JP-167 |
| JP-169 | The proof run: JP-167 watched to Done on the laptop | 16 | `JP-169-validation-proof` | all four |

**JP-167 is the ticket the first real watch proves.** Its own Validation section asks for three hourly checks in a row. The thread that merges its pull request moves it to Deployed (transition `7`), not Done, and says so in its closing comment. The other four say "Needed: no" and go to Done as usual.

## Review Focus

Inputs the spec implies but its scenarios do not exercise. Each has a test in the task named.

1. **The Validation block read as acceptance criteria.** The section sits directly after Acceptance criteria and holds a second `gherkin` block whose scenarios have no `Given` and no `@auto` tag. Nothing that reads acceptance scenarios (checklist items C4 to C6, `dev_spec.scenario_names`) may see them. Task 1 and Task 2.
2. **Text where a number should be.** A report value, a job-state field or a GitHub answer that is a sentence, a list, `true`, `NaN` or a name must become unknown, never a logged value. Task 4 and Task 5.
3. **A stale value from an earlier round.** The walker keeps the outputs of steps that did not run again, and shows Josh the card of the last step in graph order that has one. After "watch again", `verdict` must not read last round's `watch_result`, and Josh must not see last round's card. Task 8, Task 9 and Task 11.
4. **A ticket moved by hand while the run sleeps.** Between hourly looks the walker is still called every five minutes. It must not move the ticket back to Deployed, and the closing gates must write nothing once it has left. Task 10 and Task 11.
5. **A crash between two writes.** The Bug is created but not yet linked; the `end` line is written but the walker has not recorded the step; the check log's last line is torn. A second call must not file a second Bug, take a second check or fail to parse. Task 7 and Task 10.
6. **A long-closed laptop.** After days asleep, one overdue check is taken, not one per missed interval, and "Give up after" is still honoured on the first call. Task 7.
7. **Fixture tickets with no Validation section.** Every Story, Task and Bug fixture that must pass the Ready check needs the section once V1 exists. Task 2 names the helpers to change; the full suite finds the rest.

## File map

| Path | Ticket | What it is |
| --- | --- | --- |
| `graphs/gates/lib/validation_section.py` (new) | JP-165 | The one parser of the Validation section, and the rule the movers use |
| `graphs/gates/lib/collectors/__init__.py` (new) | JP-165 | The list of collectors: argument pattern, fields, whether it counts events; the comparisons |
| `graphs/gates/lib/triage/validation_items.py` (new) | JP-165 | Ready items V1 to V7 as checklist failures |
| `graphs/gates/lib/ticket_text.py`, `ready_checklist.py`, `adf.py`, `triage/checklist.py`, `triage/signoff.py` | JP-165 | The section name, the proposal check, the rendering, the item order, J6 |
| `conventions/tickets.md`, `graphs/contracts/validation-section.md` (new), `ready-checklist.md`, `ticket-proposal.md`, `sign-off-defects.md`, three role instruction files | JP-165 | The format, written down |
| `laptop/run_jobs.py` | JP-166 | Keeps a local copy of each job report |
| `graphs/gates/lib/collectors/reading.py`, `job.py`, `report.py`, `doctor.py`, `ledger_runs.py`, `jira_count.py`, `github_runs.py` (new) | JP-166 | The reading shape and the six readers |
| `graphs/gates/lib/dev_github.py`, `graphs/tests/dev_helpers.py` | JP-166 | Two read-only GitHub calls, and their fake |
| `graphs/gates/lib/watch/__init__.py`, `timetable.py`, `grading.py`, `log.py`, `tickets.py`, `round.py` (new) | JP-166 | When a watch begins and ends, how a log is graded, the check log, one call of the watch |
| `graphs/gates/lib/validation_copy.py` (new) | JP-167 | The exact copy, the evidence table, the card, the Bug template |
| `graphs/gates/deployed.py`, `read-validation.py`, `start-watch.py`, `watch-criteria.py`, `validation-verdict.py`, `close-watch.py`, `file-validation-bug.py`, `fix-closed.py`, `hold-watch.py` (new) | JP-167 | The entry gate and the eight step scripts |
| `graphs/flows/validation.yaml`, `graphs/contracts/validation-plan.md`, `watch-result.md` (moved from the draft), `graphs/compiled/` | JP-167 | The graph and its two contracts |
| `graphs/gates/move-ticket.py`, `graphs/CONVENTION.md` | JP-167 | "Deployed" is a JP status; a wait's own notes |
| `graphs/runner/starts.json`, `settings.json`, `runner_lib/watch.py`, `paths.py`, `status.py`, `graphs/gates/lib/jira_fake.py` | JP-167 | The start rule, a rule with no route record, the waiting list |
| `ledger/live.py`, `ledger/loose_ends.py` | JP-167 | A ticket in Deployed is not a loose end unless it is flagged |
| `scripts/doctor_lib/graph_checks.py` (new), `scripts/doctor.py`, `docs/platform-doctor.md` | JP-167 | The check `graphs.validation-watch` |
| `graphs/gates/validation-rule.py` (new), `close-ticket.py`, `lib/dev_copy.py`, `lib/nondev_copy.py`, `graphs/flows/development.yaml`, `non-development.yaml` | JP-168 | Deployed or Done after a merge or a sign-off |
| `docs/WORKFLOW.md`, `.claude/skills/ticket-lifecycle/SKILL.md`, `conventions/tickets.md` | JP-168 | The same rule for a thread that merges its own pull request |
| `docs/proof/<date>/JP-169/README.md` (new) | JP-169 | The proof page |

## Shared shapes

Every task uses these names. Times in files are UTC text, `2026-11-18T23:05:00Z`.

**A problem**, from the parser and the Ready check. The same four keys as `lib.triage.checklist.failure`:

```json
{"item": "V3", "where": "Validation", "found": "Check every: 'daily'", "needed": "Write '<n> hours' or '<n> days', from 1 hour to 7 days."}
```

**The parsed section**, what `validation_section.parse` returns:

```json
{"present": true, "needed": "yes", "reason": "",
 "starts": "at Deployed", "starts_kind": "deployed", "starts_date": "", "starts_ticket": "",
 "check_every_hours": 24,
 "complete_when": "7 checks in a row pass", "complete_kind": "streak", "complete_n": 7,
 "give_up_days": 21, "fail_after": 3,
 "criteria": [], "section_version": "9f2c41d07ab3e655", "problems": []}
```

`needed` is `yes`, `no`, or empty when no `Needed:` line could be read. `starts_kind` is `deployed`, `date` or `ticket`; `complete_kind` is `streak` or `events`. A field that could not be read is `null` and has a problem. With no section at all, `present` is false and `problems` holds one V1 entry.

**A criterion**, one entry of `criteria` (the contract `validation-plan`):

```json
{"id": "V1", "name": "The retirement job runs clean", "collector": "job", "argument": "retire-session-atlas",
 "checks": [{"field": "last_exit", "comparison": "is", "value": 0},
            {"field": "hours_since_run", "comparison": "is at most", "value": 2}],
 "manual": false, "statement": ""}
```

A `value` is a number when the ticket wrote one, else the word as written. A manual criterion has `collector` and `argument` empty, `checks` empty and its `statement` filled.

**A collector's entry** in `collectors.DECLARED`: `{"argument": "<regular expression>", "fields": {"last_exit": "number", "hours_since_run": "number"}, "counts_events": false}`. A field's kind is `number`, `code` (a short code) or `value` (either).

**A reading**, what every reader returns: `{"fields": {"last_exit": 0, "hours_since_run": 0.42}, "link": ""}`. It always has every declared field. A field that could not be read is `null`.

**The watch file**, `<run>/work/watch/round-<n>.json`, written once by `start-watch`: the parsed section's `starts`, `starts_kind`, `starts_date`, `starts_ticket`, `check_every_hours`, `complete_when`, `complete_kind`, `complete_n`, `give_up_days`, `fail_after`, `criteria` and `section_version`, plus `ticket_key`, `round`, `started_at`, `begins_at` and `first_check_at`. The last two are empty while `starts_kind` is `ticket`.

**The check log**, `<run>/work/watch/round-<n>.checks.jsonl`, one JSON object per line, written only by `watch-criteria`:

| `kind` | Other keys | Written when |
| --- | --- | --- |
| `began` | `at` | The ticket the Starts line names is first read in Done |
| `look` | `at`, `status` (the watched ticket's status, or `unknown`), `starts_ticket` (`done`, `open`, `cancelled`, `missing`, `unknown` or empty) | An hourly look, and before every check |
| `check` | `at`, `n` (1, 2, ...), `result` (`pass`, `fail`, `unknown`, or `waiting` in events mode), `criteria` (`{"V1": {"result": "pass", "fields": {...}, "link": ""}}`, measured criteria only) | A check is taken |
| `end` | `at`, `result` (`met`, `needs_josh`, `not_met`, `no_data`, `left_deployed`), `reason` (`streak`, `events`, `fail_after`, `gave_up`, `never_began`, `starts_cancelled`, `starts_missing`, `left`), `tally` | The watch ends; always the last line |

**A tally entry** (the contract `watch-result`): `{"id": "V1", "checks": 9, "passed": 7, "failed": 1, "unknown": 1, "streak": 7, "last": {"last_exit": 0, "hours_since_run": 0.4}, "link": ""}`.

**The card file**, `<run>/work/watch/card.md`. `validation-verdict` and `fix-closed` each rewrite this one file and return its path as their `card` output. The walker shows Josh the card of the last step in graph order that has one, and reads a card that names an existing file, so one shared file always shows the newest card. Its first line is one sentence saying what happened; `close-watch` quotes that line when Josh accepts.

## Parallel lanes

JP-165 and JP-166 touch different files and are built at the same time, each by its own build thread. Inside a ticket, the tasks in one lane go to separate subagents at the same time; each subagent gets its task and the [Shared shapes](#shared-shapes).

| Ticket | Order |
| --- | --- |
| JP-165 | Task 1, then Task 2 and Task 3 in parallel (Task 3 is documents only; it needs Task 1's names) |
| JP-166 | Tasks 4, 5 and 6 in parallel (three sets of new files), then Task 7 |
| JP-167 | Task 8 first. Then four lanes in parallel: Task 9; Task 10; Task 12; Task 13. Then Task 11, which needs every gate |
| JP-168 | Task 14 and Task 15 in parallel |
| JP-169 | Task 16, after JP-167 and JP-168 have merged and the laptop has installed them |

The two tickets that run side by side meet in one folder, `graphs/gates/lib/collectors/`. JP-165 creates only `__init__.py` there. JP-166 creates every other file and never creates `__init__.py`: until JP-165 lands, Python imports the folder as a namespace package, so JP-166's tests run on their own. Task 11 adds the test that the two halves agree.

---

## Tasks

### Task 1: The section parser and the collector list

Ticket JP-165.

**Files:**
- Create: `graphs/gates/lib/validation_section.py`, `graphs/gates/lib/collectors/__init__.py`
- Modify: `graphs/gates/lib/ticket_text.py` (`SECTION_NAMES` gains `"Validation"` after `"Acceptance criteria"`; the strict parser in `lib/triage/ticket.py` is built from the same list)
- Test: `graphs/tests/test_validation_section.py`

**Interfaces:**
- Consumes: `lib.ticket_text.parse_sections`, `lib.triage.gherkin.find_gherkin_blocks`.
- Produces, `collectors/__init__.py`: `CODE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")`; `COMPARISONS = ("is", "is not", "is at least", "is at most", "is above", "is below")`; `ORDERING = COMPARISONS[2:]`; `DECLARED: Dict[str, dict]` (below). Nothing else: no reader is imported here.
- Produces, `validation_section.py`: `parse(description: Optional[str], key: str = "") -> dict` ([the parsed section](#shared-shapes)); `parse_text(body: Optional[str], key: str = "") -> dict` (the same for a section body alone; `None` is "no section"); `route(section: dict) -> str` (`not_needed` when the section is absent or `needed` is `no`; `watch` when `needed` is `yes` and `problems` is empty; else `unreadable`); `needs_watch(description: Optional[str]) -> bool` (true only when the section is present and `needed` is `yes`, whatever else is wrong with it); `split(body: str) -> Tuple[List[str], str]` (the field lines with their list markers removed, and the `gherkin` block's text or `""`); `read_starts(value: str) -> Optional[Tuple[str, str]]` (`("deployed", "")`, `("date", "2026-12-01")` or `("ticket", "JP-170")`; `None` when the value is in none of the three forms); `read_complete_when(value: str) -> Optional[Tuple[str, int]]` (`("streak", 7)` or `("events", 20)`). `parse` uses these two itself, and `start-watch` (Task 9) uses them to turn the words it is handed back into the watch file's `*_kind` values.

`DECLARED`, from the spec's collector table:

| Name | `argument` pattern | `fields` | `counts_events` |
| --- | --- | --- | --- |
| `job` | `^[a-z0-9][a-z0-9-]{0,63}$` | `last_exit` number, `hours_since_run` number | false |
| `report` | `^[a-z0-9][a-z0-9-]{0,63} [A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$` | `value` value, `age_hours` number | false |
| `doctor` | `^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$` | `status` code | false |
| `ledger-runs` | `^[a-z][a-z0-9-]{0,63}$` | `events`, `success`, `neutral`, `needs_josh`, all number | true |
| `jira-count` | `^[^\r\n]{1,500}$` | `count` number, `events` number | true |
| `github-runs` | `^[\w.-]+/[\w.-]+ [\w.-]+\.ya?ml( [\w./-]+)?$` | `events` number, `failed` number, `last` code | true |

How the parser reads, where the spec leaves a choice:

- **A field line** is `<Field>: <value>` with an optional `-` or `*` before it, the field name matched without regard to case. The same field twice is a problem (V1 for `Needed`, V3 for the others).
- **Needed** is `yes` (a full stop after it is allowed), or `no` followed by its reason. Anything else is V1. A reason of fewer than four words is V2. With `no`, any other field line or any scenario in the section is V2 ("Needed: no carries only its reason").
- **Starts** is `at Deployed`, `on <YYYY-MM-DD>` or `after <KEY> is Done`. A date `datetime.date` refuses, or a `<KEY>` equal to `key`, is V3.
- **Check every** matches `^(\d+) (hours?|days?)$` and comes to 1 to 168 hours. **Complete when** matches `^(\d+) checks? in a row pass$` or `^after (\d+) events?$`, with a number of at least 1. **Give up after** matches `^(\d+) days?$`, 1 to 90. **Fail after** matches `^(\d+) checks? in a row fail$`, at least 1, and is 3 when the line is absent. A value outside its form or range is V3, and `found` quotes the line (`Check every: 'daily'`).
- **Scenarios** come from the section's own `gherkin` block. Every scenario there must be tagged `@validate`; one that is not is V4, because a criterion nobody watches is worse than a refused ticket. Ids are `V1`, `V2`, ... in order.
- **A measured scenario** has exactly one `When the watch reads <collector> <argument>` line and one or more `Then` or `And` lines of the form `<field> <comparison> <value>`, the comparison matched longest first. A `Given` line, a second `When`, no `When`, a collector not in `DECLARED`, or an argument that does not match the collector's pattern is V5. A field the collector does not return, a comparison not in `COMPARISONS`, a value that is neither a number nor a word matching `CODE`, or an ordering comparison used with a word or with a field of kind `code`, is V6.
- **A manual scenario** is also tagged `@manual` and has one `Then Josh confirms that <statement>` line with a statement. It needs no `When`.
- **V4:** with `yes`, at least one criterion and at least one measured. **V7:** for a streak, `give_up_days * 24 >= complete_n * check_every_hours`; for events, every measured criterion's collector has `counts_events`.
- **`section_version`** is the first 16 hex digits of the SHA-256 of the section's text with trailing spaces removed from each line.
- **The argument is kept as text.** It is never split, expanded or evaluated here.

- [ ] **Step 1: Write the failing tests** in `graphs/tests/test_validation_section.py`. `YES` is the spec's first example and `EVENTS` its second, copied into the test file as text.
  - `test_first_example_reads`: `parse(desc(YES))` has `needed == "yes"`, `len(criteria) == 2`, `check_every_hours == 24`, `complete_kind == "streak"`, `complete_n == 7`, `give_up_days == 21`, `fail_after == 3`, `starts_kind == "deployed"`, `problems == []`, and `criteria[0]` equals the criterion in [Shared shapes](#shared-shapes).
  - `test_events_example_reads`: `complete_kind == "events"`, `complete_n == 20`, one criterion with `collector == "ledger-runs"`, `argument == "non-development"`, `problems == []`.
  - `test_needed_no_reads_its_reason`: `needed == "no"`, `reason == "The change is a document; nothing runs in production."`, `route(...) == "not_needed"`.
  - `test_no_section_is_v1_and_routes_not_needed`: `present is False`, items `== ["V1"]`, `route(...) == "not_needed"`, `needs_watch(...) is False`.
  - `test_daily_is_v3_and_names_the_line_and_the_form`: the one problem has `item == "V3"`, `"Check every: 'daily'" in found`, `"<n> hours" in needed`; `route(...) == "unreadable"` and `needs_watch(...) is True`.
  - `test_unknown_collector_is_v5`: `When the watch reads weather today` gives items `== ["V5"]`.
  - `test_each_item_fails_alone`: a table of `(change to YES, expected item)`: no `Needed` line (V1); `Needed: maybe` (V1); `Needed: no. Docs only.` (V2); `Needed: no.` with a reason and a `Starts` line (V2); `Starts: on 2026-02-30` (V3); `Starts: after JP-9001 is Done` with `key="JP-9001"` (V3); `Check every: 8 days` (V3); `Give up after: 91 days` (V3); no `Complete when` line (V3); no scenario (V4); only a `@manual` scenario (V4); a scenario with no `@validate` tag (V4); `When the watch reads job Retire Job` (V5); a `Given` line (V5); `Then exit_code is 0` (V6); `Then last_exit equals 0` (V6); `Then status is at least pass` on `doctor` (V6); `Give up after: 5 days` (V7); `Complete when: after 20 events` with the `job` collector (V7). Each asserts the items found are exactly that one.
  - `test_manual_criterion_reads_its_statement`: `manual is True`, `statement == "the summaries read as plain English"`, `checks == []`.
  - `test_fail_after_line_is_read`: `Fail after: 5 checks in a row fail` gives `fail_after == 5`.
  - `test_argument_is_kept_as_text`: a `jira-count` criterion with `project = JP AND labels = "x; rm -rf" AND created >= -7d` has exactly that `argument`.
  - `test_version_follows_the_section_only`: changing the Goal leaves `section_version` the same; changing `7 checks` to `8 checks` changes it.
  - `test_validation_block_is_not_an_acceptance_scenario`: for a description with both sections, `parse_sections(d)["Acceptance criteria"]` does not contain `@validate`, and `lib.dev_spec.scenario_names(d)` holds none of the Validation scenarios' names.
  - `test_declared_is_the_specs_table`: `set(DECLARED)` is the six names, and each entry's `fields` and `counts_events` equal the table above.
  - `test_split_gives_field_lines_and_the_block`: `split` on `YES`'s section gives five field lines starting `Needed: yes` and a block containing both scenarios.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_validation_section`. Expected: FAIL, `No module named 'lib.validation_section'`.
- [ ] **Step 3: Implement** the two modules and the one-word change to `SECTION_NAMES`.
- [ ] **Step 4: Run** the test file, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`. If another suite fails because a fixture ticket now has a section it did not have, that is Task 2's fixture step: do it now.
- [ ] **Step 5: Commit** (one commit per file).

### Task 2: The Ready items, the drafted ticket and J6

Ticket JP-165.

**Files:**
- Create: `graphs/gates/lib/triage/validation_items.py`
- Modify: `graphs/gates/lib/ready_checklist.py`, `graphs/gates/lib/triage/checklist.py`, `graphs/gates/lib/adf.py`, `graphs/gates/lib/triage/signoff.py`, `graphs/tests/triage_helpers.py`, `graphs/tests/ticket_creation_helpers.py`, `graphs/tests/nondev_helpers.py`, `tests/runner_helpers.py`
- Test: `graphs/tests/test_triage_units.py`, `graphs/tests/test_triage_gates.py`, `graphs/tests/test_gate_ticket_complete.py`

**Interfaces:**
- Consumes: `validation_section.parse`, `parse_text`, `split`; `lib.triage.checklist.failure`.
- Produces: `validation_items.check_validation(ticket: Ticket) -> List[dict]` (`[]` for a Research ticket, an Epic or a Subtask; else `parse(ticket.description, key=ticket.key)["problems"]`); `ready_checklist.CHECKLIST` with `{"section": "validation", "label": "Validation", "kind": "validation"}` directly after `acceptance_criteria` for Story, Task and Bug only; `ready_checklist.validation_problems(value) -> List[str]` (one `"<item>: <found>. <needed>"` per problem of `parse_text(value)`, or `["is empty"]`); `signoff.JUDGMENTS == ("J1", "J2", "J3", "J4", "J5", "J6")`.

What changes:
- `ready_checklist`: split `_COMMON_TAIL` so the Research list is unchanged. `problems(ticket)` adds one line per entry of `validation_problems` (`"<ref>: Validation <text>"`). A proposal's `sections.validation` is the section's body as one text, field lines then the `gherkin` block.
- `triage/checklist.py`: `required_labels` puts Validation directly after Acceptance criteria, before Repository and Where it runs, for the three types; `run_checklist` adds `check_validation`'s failures after the Gherkin items; `check_open_questions` strips the code block for Validation as it does for Acceptance criteria, so a question mark inside a JQL argument is not C12. The section's presence is V1's to report, not C2's: C2 skips Validation when it is missing and still checks its place and that it appears once.
- `adf.ticket_description`: kind `validation` renders the bold label, the field lines from `split` as a bullet list, and the block as a `gherkin` code block when there is one.
- `ticket-complete.py` needs no change beyond what `ready_checklist.problems` now returns.
- **Fixtures.** `triage_helpers.description()` gains a `validation=` keyword whose default is `"- Needed: no. The change is a document; nothing runs."`; the complete proposals in `ticket_creation_helpers.py`, `nondev_helpers.DESCRIPTION` and `RunnerCase.jira_issue` gain the same section. Then run the suite and add it to any other Story, Task or Bug fixture that is meant to be Ready.

- [ ] **Step 1: Write the failing tests.**
  - `test_triage_units.py`: `test_story_with_no_validation_section_fails_v1` (items contain `V1`, and no `C2` names Validation); `test_research_ticket_needs_no_validation_section` (no V item); `test_validation_reads_after_acceptance_criteria` (a ticket with Validation placed after Repository fails `C2`); `test_question_mark_in_a_validation_argument_is_not_c12`; `test_validation_scenarios_do_not_fail_c5_or_c6` (a ticket with the spec's first example passes the whole checklist).
  - `test_triage_gates.py`: `test_daily_fails_v3_through_ready_check` and `test_unknown_collector_fails_v5_through_ready_check`: seed a Story with that section, run the `ready-check` gate, and assert its failures hold one entry with that `item`, `where == "Validation"`, and for V3 `"<n> hours" in needed`.
  - `test_gate_ticket_complete.py`: `test_proposal_without_validation_is_fixable` (the fixable list has `"<ref>: Validation is empty"`); `test_proposal_with_an_unreadable_validation_names_the_item` (a line starting `<ref>: Validation V3:`); `test_rendered_no_reads_back` (`parse(adf.to_marked(adf.ticket_description(ticket)))` has `needed == "no"` and the reason); `test_rendered_yes_reads_back` (the same round trip for the spec's first example gives the same `criteria` and timetable as `parse_text` of the proposal's text).
  - `test_triage_units.py`: `test_sign_off_takes_a_j6_defect` (a sign-off defect with `item: "J6"` is accepted by the same code that accepts `J5`).
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement**, then change the fixtures.
- [ ] **Step 4: Run** `python3 scripts/check.py`. Expected: `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 3: The ticket format documents

Ticket JP-165. Documents and role instructions only.

**Files:**
- Create: `graphs/contracts/validation-section.md`
- Modify: `conventions/tickets.md`, `graphs/contracts/ready-checklist.md`, `graphs/contracts/ticket-proposal.md`, `graphs/contracts/sign-off-defects.md`, `graphs/roles/ticket-drafter/instructions.md`, `graphs/roles/sign-off/instructions.md`, `graphs/roles/decomposer/instructions.md`, `graphs/compiled/` (recompiled)
- Test: `graphs/tests/test_validation_section.py`

**Interfaces:**
- Consumes: Task 1's `DECLARED` and `COMPARISONS`.

- [ ] **Step 1: Write the failing test** `test_contract_table_lists_every_collector_and_field`: every name in `DECLARED`, each of its fields, and every entry of `COMPARISONS` appears in `graphs/contracts/validation-section.md`.
- [ ] **Step 2: Run** it. Expected: FAIL, the file does not exist.
- [ ] **Step 3: Write `graphs/contracts/validation-section.md`:** the field table, the three examples, the two scenario forms and the comparisons, and the collector table, taken from the spec's "The Validation section of a ticket", "How a script reads the section" and "Collectors". It starts with a `## Contents` section, as every document here does.
- [ ] **Step 4: Change `conventions/tickets.md`.** "Required sections": Validation after Acceptance criteria for Story, Task and Bug, with the first example, the "Needed: no" form and the "When is the answer yes?" paragraph. "The Ready rule": items V1 to V7 from the spec's table, and J6 with the sign-off items. "Issue types": the Subtask row and the paragraph under it, from the spec's "The subtask rule". Keep the `## Contents` list in step.
- [ ] **Step 5: Change the contracts and the instructions.** `ready-checklist.md` names V1 to V7. `ticket-proposal.md` gains `sections.validation` (the section's body as text; required for Story, Task and Bug). `sign-off-defects.md` gains J6 with the spec's wording. The ticket drafter's instructions gain the section, the first example and the "when is the answer yes" guidance; the sign-off instructions gain J6; the decomposer's gain the three cases for a subtask and "never one subtask per step or per phase".
- [ ] **Step 6: Run** `python3 graphs/tools/compile_graphs.py`, then `python3 scripts/check.py`. Expected: `check.py: ok (0 problem(s))`.
- [ ] **Step 7: Commit** (one commit per file).

### Task 4: Local report copies and the laptop collectors

Ticket JP-166.

**Files:**
- Create: `graphs/gates/lib/collectors/reading.py`, `job.py`, `report.py`, `doctor.py` (not `__init__.py`: see [Parallel lanes](#parallel-lanes))
- Modify: `laptop/run_jobs.py` (`run_job`)
- Test: `tests/test_follow.py` (where `run_jobs` is tested today), `graphs/tests/test_collectors_laptop.py`

**Interfaces:**
- Produces, `reading.py`: `CODE` (the same pattern as Task 1's, repeated so this ticket stands alone); `take(raw: Optional[dict], fields: Dict[str, str], link: str = "") -> dict` ([a reading](#shared-shapes): for each declared field, the raw value when it fits the field's kind, else `None`; `raw` of `None` gives every field `None`); `state_dir(deps) -> Path` (`Path(deps.environ.get("JOSH360_HOME") or "~/.josh-360").expanduser() / "state"`, the folder `laptop.common.state_dir()` gives); `fits(value, kind: str) -> bool`.
- Produces, each reader module: `FIELDS: Dict[str, str]`, `COUNTS_EVENTS: bool`, `ARGUMENT: Pattern` and `read(argument: str, since: str, deps) -> dict`. `since` is the time the watch began. A reader never raises: any error, and an argument its own `ARGUMENT` refuses, gives a reading with every field `None`.

Rules:
- `fits`: `number` is an `int` or a finite `float` and never a `bool`; `code` is a `str` matching `CODE`; `value` is either. A JSON `true` or `false` is not a reading.
- **The local copy.** When a `report: true` job exits 0 and its output parses, `run_job` writes it to `common.state_dir() / "reports" / "<id>.json"` (temporary file, then rename) before it publishes. A failed publish leaves the copy; a job that fails leaves the previous copy.
- `job`: reads `state_dir / "jobs-state.json"` (`{"<id>": {"last_run": <epoch seconds>, "last_result": <exit code>}}`). `last_exit` is `last_result`; `hours_since_run` is `(deps.now() - last_run)` in hours, to two decimals. A job id the file does not have is unknown. `link` is empty.
- `report`: the argument is `<report id> <dotted path>`. Reads `state_dir / "reports" / "<id>.json"` and follows the path through objects only. `value` is what it finds when that fits `value`; `age_hours` is the file's age by its modification time. `link` is `reports/<id>.json on the laptop-status branch`.
- `doctor`: reads `state_dir / "reports" / "doctor.json"`. `status` is the `status` of the entry in `checks` whose `id` is the argument. The whole reading is unknown when the report's `time` is more than 36 hours before `deps.now()` or cannot be read: the doctor runs once a day, and a status with no age would otherwise pass for ever. `link` as for `report`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/test_follow.py`: `test_report_job_keeps_a_local_copy` (after a pass, `state/reports/<id>.json` parses to the job's output); `test_local_copy_survives_a_failed_publish`; `test_failed_job_leaves_the_earlier_copy`.
  - `test_collectors_laptop.py`: `test_take_keeps_numbers_and_short_codes_only`: with kinds `a: number, b: code, c: code, d: number, e: number, f: value, g: value`, `take({"a": 3, "b": "pass", "c": "Jane Doe 1970-01-01", "d": True, "e": float("nan"), "f": [1], "g": 0.5}, ...)["fields"] == {"a": 3, "b": "pass", "c": None, "d": None, "e": None, "f": None, "g": 0.5}`; `take(None, ...)` gives every field `None`.
  - `test_job_reads_exit_and_age`: `last_result: 0`, `last_run` 90 minutes before `deps.now()` gives `{"last_exit": 0, "hours_since_run": 1.5}`; `test_job_unknown_when_absent_or_unreadable` (no file, a file holding `{`, a job id not in it: every field `None`, no exception).
  - `test_report_reads_a_dotted_path`: `doctor summary.fail` on `{"summary": {"fail": 2}}` gives `value == 2`, and `age_hours` near 0; `test_report_value_that_is_text_is_unknown` (`{"summary": {"fail": "two failures in atlas"}}` gives `value is None`); `test_report_path_stays_in_the_reports_folder` (`../jobs-state x` and `doctor a..b` give unknown and open no file outside `reports/`).
  - `test_doctor_reads_a_check_status` (`pass`); `test_doctor_older_than_36_hours_is_unknown`; `test_doctor_unknown_check_id_is_unknown`.
  - `test_state_dir_is_the_laptops`: with `JOSH360_HOME` set, `reading.state_dir(deps) == laptop.common.state_dir()`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** `run_job`'s copy, then `reading.py`, then the three readers.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 5: The ledger, Jira and GitHub collectors

Ticket JP-166.

**Files:**
- Create: `graphs/gates/lib/collectors/ledger_runs.py`, `jira_count.py`, `github_runs.py`
- Modify: `graphs/gates/lib/dev_github.py` (two read-only methods on `GitHub`), `graphs/tests/dev_helpers.py` (`FakeGitHub` gains the same two)
- Test: `graphs/tests/test_collectors_remote.py`

**Interfaces:**
- Consumes: `reading.take` (Task 4; if Task 4 has not landed in the worktree yet, write against the signature above); `ledger.db` opened read-only the way `lib/triage/runs.py` opens it; `deps.jira.search(jql, fields, limit) -> Optional[List[dict]]`, `deps.jira.site`; `deps.github(repo)`.
- Produces: the three reader modules, with the same four names as Task 4's; `GitHub.default_branch() -> str`; `GitHub.workflow_runs(workflow: str, branch: str, since: str) -> List[dict]` (completed runs of that workflow file on that branch created at or after `since`, newest first, each `{"conclusion": str, "created_at": str}`, at most 100; raises `GitHubError`).

Rules:
- `ledger-runs`: counts rows of the view `current_run_ends` joined to `graph_runs` where `graph_id` is the argument and `ended_at >= since`. `events` is the count; `success`, `neutral` and `needs_josh` are the counts whose `score` is `success`, `neutral` and `needs-josh`. A ledger that cannot be opened is unknown. `link` is empty.
- `jira-count`: `deps.jira.search(argument, ["status"], 201)`. `None` is unknown. More than 200 results is unknown, because the count would be a floor and not a count. Otherwise `count` and `events` are the number returned. `link` is `deps.jira.site + "/issues/?jql=" + urllib.parse.quote(argument)`. `since` is not used: the JQL carries its own dates.
- `github-runs`: the argument is `owner/repo workflow-file` with an optional branch. With no branch it asks `default_branch()`. Of the runs returned, only conclusions `success` and `failure` count: `events` is their number, `failed` the failures, `last` the newest one's conclusion, or `None` when there are none (so `events` 0 and `failed` 0 are known while `last` is not). A `GitHubError` is unknown. `link` is `https://github.com/<owner/repo>/actions/workflows/<workflow-file>`.

- [ ] **Step 1: Write the failing tests.**
  - `test_ledger_runs_counts_ends_since_the_watch_began`: with three ended `non-development` runs after `since` (scores `success`, `success`, `needs-josh`), one before it and one `development` run, the fields are `{"events": 3, "success": 2, "neutral": 0, "needs_josh": 1}`; `test_ledger_runs_unknown_without_a_ledger`.
  - `test_jira_count_counts`, `test_jira_count_failed_search_is_unknown` (the fake's `search_fails`), `test_jira_count_over_200_is_unknown`, `test_jira_count_link_is_the_search`.
  - `test_github_runs_counts_success_and_failure_only`: conclusions `success`, `failure`, `cancelled`, `success` (newest first) give `{"events": 3, "failed": 1, "last": "success"}`; `test_github_runs_no_runs_yet` (`events == 0`, `last is None`); `test_github_runs_asks_for_the_default_branch_when_none_is_named`; `test_github_runs_error_is_unknown`.
  - `test_no_reading_carries_text`: for each of the six readers, with a source whose every text field holds `"Jane Doe, born 1 January 1970, 555-0100"`, every value in the reading is `None`, a number, or a string matching `CODE`. (This test imports Task 4's readers too; it is the spec's scenario "No reading carries text from the system it read".)
  - `test_no_reader_raises`: each reader, given a `deps` whose `jira`, `github`, `environ` and `now` raise, returns a reading with every field `None`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the two `GitHub` methods and their fake, then the three readers.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 6: The timetable and the grading rules

Ticket JP-166. Pure functions: no file, no clock, no network.

**Files:**
- Create: `graphs/gates/lib/watch/__init__.py`, `timetable.py`, `grading.py`
- Test: `graphs/tests/test_watch_grading.py`

**Interfaces:**
- Produces, `timetable.py`: `NEVER_BEGAN_DAYS = 90`; `LOOK_SECONDS = 3600`; `iso(when: datetime) -> str`; `parse(text: str) -> Optional[datetime]`; `begins_at(starts_kind: str, starts_date: str, started_at: datetime) -> Optional[datetime]` (`started_at` for `deployed`; the later of `started_at` and the start of that date by the machine's own time zone for `date`; `None` for `ticket`); `first_check_at(begins: datetime, check_every_hours: int) -> datetime`; `gave_up(begins: datetime, give_up_days: int, now: datetime) -> bool`; `never_began(started_at: datetime, now: datetime) -> bool`.
- Produces, `grading.py`: `holds(got, comparison: str, want) -> Optional[bool]`; `judge(criterion: dict, reading: dict) -> str` (`pass`, `fail`, `unknown`); `check_result(results: List[str]) -> str`; `events_ready(plan: dict, readings: Dict[str, dict]) -> bool`; `grade(lines: List[dict], plan: dict, gave_up: bool) -> Optional[Tuple[str, str]]` (`(result, reason)` or `None` for "not yet"); `tally(plan: dict, lines: List[dict]) -> List[dict]` ([tally entries](#shared-shapes)); `met_on(lines: List[dict]) -> int` (the `n` of the last check line). `plan` is [the watch file](#shared-shapes); `lines` is the check log.

Rules, from the spec's "How the watch runs":
- `holds`: `None` when `got` is `None`. `is` and `is not` compare two numbers as numbers and anything else as text. The four ordering comparisons need two numbers and are `None` otherwise.
- `judge`: `fail` when any `Then` is false; else `unknown` when any is `None`; else `pass`.
- `check_result`: `fail` when any criterion failed; else `unknown` when any is unknown; else `pass`. Manual criteria are not in the list.
- `events_ready`: every measured criterion's reading has `events` not `None` and at least `plan["complete_n"]`.
- `grade`, streak: take the check lines whose `result` is `pass` or `fail` (the known ones), in order. The last `complete_n` all `pass`: `met`, reason `streak`. The last `fail_after` all `fail`: `not_met`, reason `fail_after`. Else when `gave_up`: `not_met` if any known check failed, `no_data` if none did, reason `gave_up`. Else `None`.
- `grade`, events: the last check line's `result` is `pass`: `met`, reason `events`; `fail`: `not_met`, reason `events`; else when `gave_up`: `no_data`, reason `gave_up`; else `None`. A `waiting` or `unknown` line never ends the watch.
- `met` is returned as `needs_josh` when the plan has a manual criterion.
- `tally`: per measured criterion, from the check lines: how many it has, how many passed, failed and were unknown, the current run of passes counted back from the end skipping unknowns, the `fields` and `link` of its last entry. A manual criterion has an entry of zeros.

- [ ] **Step 1: Write the failing tests** (each builds check lines with a helper `checks("ppfu")` for pass, pass, fail, unknown):
  - `test_seven_passes_in_a_row_are_met`: `grade(checks("ppppppp"), streak(7), False) == ("met", "streak")`; six passes give `None`.
  - `test_an_unknown_neither_counts_nor_breaks`: `tally(plan, checks("pppup"))[0]["streak"] == 4`, and `grade(checks("pppup"), streak(4), False) == ("met", "streak")`.
  - `test_three_fails_end_it_early`: `grade(checks("pfff"), streak(7, fail_after=3), False) == ("not_met", "fail_after")`.
  - `test_fail_after_five_waits`: `grade(checks("fff"), streak(7, fail_after=5), False) is None`.
  - `test_a_fail_breaks_the_run_of_passes`: `grade(checks("ppfpp"), streak(3), False) is None`.
  - `test_gave_up_with_a_fail_is_not_met`: `grade(checks("pfp"), streak(7), True) == ("not_met", "gave_up")`; `test_gave_up_with_no_fail_is_no_data` (`"ppu"` and `""` and `"uuu"` each give `("no_data", "gave_up")`).
  - `test_manual_criterion_turns_met_into_needs_josh`.
  - `test_events_wait_then_compare_once`: lines `waiting, waiting, pass` give `("met", "events")`; `waiting, fail` gives `("not_met", "events")`; `waiting` with `gave_up` gives `("no_data", "gave_up")`; `waiting, unknown` gives `None`.
  - `test_events_ready_needs_every_criterion`: with `complete_n` 20, readings of `events` 20 and 19 are not ready; 20 and 25 are; `None` is not.
  - `test_holds`: `(0, "is", 0)` True; `("pass", "is", "pass")` True; `("pass", "is not", "fail")` True; `(2, "is at most", 2)` True; `(2, "is below", 2)` False; `(3, "is above", 2)` True; `(None, "is", 0)` None; `("pass", "is at least", 1)` None.
  - `test_judge_and_check_result`: a criterion with two `Then` lines, one true and one unknown, is `unknown`; one false and one unknown is `fail`; `check_result(["pass", "unknown"]) == "unknown"`; `check_result(["unknown", "fail"]) == "fail"`.
  - `test_date_start_is_local_midnight`: with `TZ=America/Los_Angeles` set and `time.tzset()` called, `begins_at("date", "2026-12-01", 2026-11-28T10:00Z)` is `2026-12-01T08:00:00Z`; a date already past gives `started_at`; `begins_at("ticket", "", t) is None`.
  - `test_first_check_and_give_up_count_from_the_beginning`: `first_check_at(b, 24) == b + 24 hours`; `gave_up(b, 21, b + 21 days)` is True and one second earlier is False; `never_began(s, s + 90 days)` is True.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_watch_grading`. Expected: FAIL, no module.
- [ ] **Step 3: Implement** the two modules.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 7: The check log and one call of the watch

Ticket JP-166.

**Files:**
- Create: `graphs/gates/lib/watch/log.py`, `tickets.py`, `round.py`
- Test: `graphs/tests/test_watch_round.py`

**Interfaces:**
- Consumes: Task 6's functions; the readers' `read(argument, since, deps)`; `deps.jira.get(key, fields) -> Optional[dict]` (with `status` and `status_category`), `deps.jira.exists(key) -> Optional[bool]`; `deps.now()`; `lib.gate_run.GateError`.
- Produces, `log.py`: `path_for(watch_file: Path) -> Path` (`round-3.json` gives `round-3.checks.jsonl` beside it); `read(path: Path) -> List[dict]` (a line that is not a JSON object is skipped); `append(path: Path, line: dict) -> None` (one `write` call of one line ending in a newline, then flush); `last(lines: List[dict], kind: str) -> Optional[dict]`.
- Produces, `tickets.py`: `status(jira, key: str) -> Optional[str]` (the status name; `None` when the read failed); `state(jira, key: str) -> str`: `done` (status `Done`, or the done category with any name but `Cancelled`), `cancelled` (status `Cancelled`), `open`, `missing` (`jira.exists` says `False`), else `unknown`.
- Produces, `round.py`: `next_round(folder: Path) -> Tuple[int, Path]` (one more than the number of `round-*.json` files there, and that file's path); `write_plan(path: Path, plan: dict) -> None` (temporary file, then rename); `newest(folder: Path) -> Optional[Path]` (the highest-numbered watch file); `ended(watch_file: Path) -> Optional[dict]` (its log's `end` line); `step(watch_file: Path, deps, readers: Optional[Dict[str, Callable]] = None) -> Tuple[str, Optional[dict], str]`. `step` returns `("pending", None, "")` or `(outcome, {"watch_result": outcome, "tally": [...]}, summary)`. `readers` maps a collector's name to its `read`; when it is `None`, the name `ledger-runs` is loaded as `lib.collectors.ledger_runs`.

**One call of `step`, in order:**

1. Read the watch file. Missing or not JSON: `GateError` (the run stops and Josh sees it; a watch with no plan cannot go on).
2. Read the log. If it has an `end` line, return that line's result and tally again and write nothing. This is what makes a crash after the `end` line harmless.
3. `now = deps.now()`. Work out whether the watch has begun: `begins_at` from the watch file, else the log's `began` line, and only once `now` has reached it.
4. Decide what is due. A **look** is due when the log has no `look` line or the last one is `LOOK_SECONDS` old. A **check** is due when the watch has begun and `now` has reached `first_check_at` (no check yet) or the last check's `at` plus `check_every_hours`. When neither is due and the watch has not given up, return `pending` having read nothing but the two files and written nothing.
5. When a look or a check is due, look first: `tickets.status` of the watched ticket, and, while `starts_kind` is `ticket` and the watch has not begun, `tickets.state` of the Starts ticket. Append the `look` line. Then:
   - the status is known and is not `Deployed`: append `end` (`left_deployed`, reason `left`) and return it. Nothing is written to the ticket.
   - the status is unknown: nothing follows from it. No check is taken on this call.
   - the Starts ticket is `done`: append `began` with `at: now`. The watch has begun now; its first check is one interval later.
   - the Starts ticket is `cancelled` or `missing`: append `end` (`no_data`, reason `starts_cancelled` or `starts_missing`) and return it.
6. Not begun, and `never_began(started_at, now)`: `end` (`no_data`, `never_began`). Not begun otherwise: `pending`.
7. A check is due and the status was read as `Deployed`: for each measured criterion call its reader with the argument, `since` (the time the watch began) and `deps`; a reader that raises, or a name with no reader, is a reading of unknowns. In events mode, when `events_ready` is false the line's `result` is `waiting`; otherwise judge each criterion and take `check_result`. Append one `check` line. One overdue check is one check: missed intervals are not made up.
8. `grade(lines, plan, gave_up(...))`. A result: append `end` with the reason and `tally`, and return it with a summary such as `7 of 9 checks passed; met on check 9`. No result: `pending`.

- [ ] **Step 1: Write the failing tests.** Each builds a watch file with a helper, a `deps` with a settable `now` and the fake Jira, and `readers` that return scripted readings and count their calls.
  - `test_not_due_answers_pending_and_touches_nothing`: with a look ten minutes old and the next check tomorrow, `step` returns `("pending", None, "")`; the Jira fake's call log is empty, no reader was called, and the log file's bytes are unchanged.
  - `test_due_check_reads_logs_and_stays_pending`: one `check` line with `n == 1`, `result == "pass"` and each criterion's `fields`; the outcome is `pending`.
  - `test_seven_passes_end_met`: seven due checks, the clock moved one interval each time, end `("met", {...}, ...)`; `watch_result == "met"`, the tally's `passed == 7`, and the log's last line has `kind == "end"`, `reason == "streak"`.
  - `test_date_start_takes_no_reading_before_it`: `starts_kind` `date` three days away: `pending`, no reader called; at the date plus one interval less a minute, still no reader; at the date plus one interval, one check.
  - `test_ticket_start_begins_when_that_ticket_is_done`: with JP-170 in Code Review, hourly calls read no collector; after JP-170 moves to Done the next look writes `began` as the log's first non-`look` line; the first check is one interval after that time; `gave_up` is counted from it (a watch file whose `started_at` is 30 days old with `give_up_days` 21 has not given up).
  - `test_cancelled_start_ticket_ends_no_data` (reason `starts_cancelled`); `test_missing_start_ticket_ends_no_data` (reason `starts_missing`); `test_unreadable_start_ticket_keeps_waiting` (the fake's read fails: `pending`, a `look` line with `starts_ticket == "unknown"`).
  - `test_ninety_days_without_beginning_ends_no_data` (reason `never_began`).
  - `test_all_unknown_until_give_up_ends_no_data`.
  - `test_ticket_moved_out_of_deployed_ends_left_deployed`: the fake's call log holds reads only, and the tally is returned.
  - `test_failed_status_read_is_not_left_deployed`: `pending`, a `look` line with `status == "unknown"`, no check taken.
  - `test_looks_at_most_once_an_hour`: twelve calls five minutes apart with no check due make one Jira read.
  - `test_overdue_check_is_taken_once`: the clock jumps three days with a one-hour interval: one new `check` line.
  - `test_give_up_is_honoured_on_the_first_call_after_a_long_sleep`: the clock jumps past "Give up after": one check, then `end`.
  - `test_end_line_is_returned_again`: a second `step` after an `end` returns the same outcome and tally and appends nothing.
  - `test_torn_last_line_is_skipped`: a log ending in `{"kind": "che` still reads, and the next due check is appended on a fresh line.
  - `test_reader_that_raises_is_unknown`.
  - `test_events_mode_waits_then_grades_once`: readings of `events` 12 then 20 give a `waiting` line then an ending.
  - `test_missing_watch_file_stops_the_run` (`GateError`).
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_watch_round`. Expected: FAIL, no module.
- [ ] **Step 3: Implement** `log.py`, `tickets.py`, then `round.py`.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 8: The copy, the entry gate, the reader and the verdict

Ticket JP-167. First task of the ticket: Tasks 9 and 10 use its copy module.

**Files:**
- Create: `graphs/gates/lib/validation_copy.py`, `graphs/gates/deployed.py`, `graphs/gates/read-validation.py`, `graphs/gates/validation-verdict.py`
- Test: `graphs/tests/test_validation_gates.py`

**Interfaces:**
- Consumes: `validation_section.parse`, `route`; `round.newest`, `round.ended`; `lib.gate_run` (`execute`, `need`, `say`, `GateError`); `deps.jira.get`, `deps.ticket.read`, `deps.work_dir`; gate inputs arrive as text, lists as JSON (`lib.ticket_text.as_list`).
- Produces, `validation_copy.py`: `start(n: int, check_every_hours: int, complete_when: str, give_up_days: int, first_check: str) -> str`; `met(complete_when: str, check: int, round_no: int) -> str`; `unwatched(reason: str) -> str`; `not_met(failed_text: str, bug_key: str) -> str`; `accepted(date: str, line: str) -> str`; `hold() -> str`; `interval(hours: int) -> str` (`1 hour`, `6 hours`, `1 day`, `3 days`: days when the hours divide by 24); `no_section() -> str` (`the ticket has no Validation section`); `says_no(reason: str) -> str` (`the ticket says "Needed: no": <reason>`); `evidence_table(criteria: List[dict], tally: List[dict]) -> str` (a Markdown table: Criterion, Checks, Passed, Failed, Unknown, Last reading, Link; a manual criterion's row reads "for Josh to confirm"); `failed_text(criteria, failed) -> str` (`<name>: <failed> of <checks> checks failed`, joined with `; `); `card(case: str, **parts) -> str`; `write_card(work_dir: Path, text: str) -> str` (writes `watch/card.md` and returns its path); `bug_ticket(key: str, system_label: str, criteria, failed) -> dict`.
- Produces, the three scripts' outcomes and outputs, exactly as the draft graph declares them: `deployed` (`pass`, `refuse`); `read-validation` (`watch`, `not_needed`, `unreadable`; outputs `needed`, `criteria`, `starts`, `check_every_hours`, `complete_when`, `give_up_days`, `fail_after`, `section_version`, `problems`); `validation-verdict` (`met`, `not_needed`, `not_met`, `undecided`; outputs `result`, `evidence`, `failed`, `card`).

Rules:
- **The copy** is the spec's "Exact copy", word for word, with `{interval}` from `interval()` and `{time}` either a local date and time (`2026-11-19 14:05`) or `one check after {KEY} is Done`.
- **The card's six cases**, one per row of the spec's "one question" table: `no_readings` (which criteria had no readings), `never_began` (the Starts line, and whether its ticket was cancelled, is missing, or 90 days passed), `manual` (each statement to confirm), `unreadable` (each problem's `found` and `needed`), `fix_cancelled` (the criteria that still fail and the Bug's key), `fix_shipped` (the counts from every failed round so far). The first line is one sentence; the whole card stays under 4,000 characters, which is what the walker shows.
- **`bug_ticket`** returns a proposal-shaped ticket for `adf.ticket_description`: type `Bug`, the summary and the six sections the spec lists under "The Bug a failed watch files", labels `validation-failure` and `system_label`.
- **`deployed`** reads the ticket through `deps.jira.get(key, fields=["status", jira.FLAG_FIELD])`: `pass` when its `status` is `Deployed` and its `flagged` is false; `refuse` with the reason otherwise; a failed read is a `GateError`, so the start is tried again next pass.
- **`read-validation`** returns `route(parse(description, key))` as its outcome. `needed` is `yes` for `watch`, `no` for `not_needed`, `unreadable` otherwise. On `unreadable` the timetable outputs are whatever was read.
- **`validation-verdict`** decides from `needed` first, because the walker still holds last round's `watch_result` when this round's `watch` did not run: `no` gives `not_needed`, with `evidence` set to `no_section()` or `says_no(reason)` read from the ticket again; `unreadable` gives `undecided` with the `unreadable` card. Only for `yes` does it read `watch_result`: `met` gives `met`; `not_met` gives `not_met`, with `failed` the tally entries whose `failed` is above 0 and whose `streak` is 0; `needs_josh` gives `undecided` with the `manual` card; `no_data` gives `undecided` with the `no_readings` or `never_began` card, chosen by the `reason` on the newest round's `end` line. `evidence` is `evidence_table`. Whenever it answers `undecided` it rewrites the card file and returns its path as `card`; otherwise `card` is empty.

- [ ] **Step 1: Write the failing tests.**
  - `test_copy_is_the_specs`: each of the seven functions equals the spec's sentence with the test's values in it, for example `start(2, 24, "7 checks in a row pass", 21, "2026-11-19 14:05") == "Watching this change in production | 2 criteria; a check every 1 day; complete when 7 checks in a row pass; gives up after 21 days | next gate: first check due 2026-11-19 14:05."` and `hold()` equals the hold comment in full.
  - `test_evidence_table_holds_counts_and_links_only`: one row per criterion; a tally whose `last` holds a long sentence cannot occur (Task 4), so the test asserts the cells are the tally's numbers and codes.
  - `test_bug_ticket_follows_the_template`: summary `JP-9001 did not meet its validation: The retirement job runs clean`; its Validation section is `- Needed: no. The watch on JP-9001 proves this fix.`; `parse` of the rendered description has `problems == []`.
  - `test_entry_gate`: Deployed and not flagged is `pass`; flagged is `refuse`; In Progress is `refuse`; a failed read raises `GateError`.
  - `test_read_validation_three_ways`: the first example gives `watch` with `check_every_hours == 24` and two criteria; no section gives `not_needed` with `needed == "no"`; `Check every: daily` gives `unreadable` with one problem.
  - `test_verdict_prefers_this_rounds_reading_of_the_section`: `needed=no` with `watch_result=met` left in the inputs gives `not_needed`.
  - `test_verdict_each_case`: met; not_met with `failed` naming only the failing criterion; needs_josh (card first line names the statement); no_data after `gave_up` (card names the criteria with no readings); no_data after `starts_cancelled` (card names the Starts line); unreadable (card quotes `Check every: 'daily'`).
  - `test_card_file_is_rewritten`: two verdicts in one work folder leave one `card.md` holding the second card, and both return the same path.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_validation_gates`. Expected: FAIL.
- [ ] **Step 3: Implement** the copy module, then the three scripts.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 9: Starting the watch and the two waits

Ticket JP-167.

**Files:**
- Create: `graphs/gates/start-watch.py`, `graphs/gates/watch-criteria.py`, `graphs/gates/fix-closed.py`
- Test: `graphs/tests/test_validation_waits.py`

**Interfaces:**
- Consumes: `validation_section.read_starts`, `read_complete_when`; `timetable.begins_at`, `first_check_at`, `iso`; `round.next_round`, `newest`, `ended`, `write_plan`, `step`; `log.read`; `tickets.status`, `state`; `validation_copy.start`, `card`, `write_card`.
- Produces: `start-watch` (outcome `started`, output `watch_file`); `watch-criteria` (`pending`, or `met`, `needs_josh`, `not_met`, `no_data`, `left_deployed`; outputs `watch_result`, `tally`); `fix-closed` (`pending`, or `shipped`, `cancelled`, `left_deployed`; output `card`).

Rules:
- **`start-watch`** builds [the watch file](#shared-shapes) in `deps.work_dir / "watch"`. `started_at` is `deps.now()`; `begins_at` and `first_check_at` come from the timetable functions and are empty for a Starts line that names a ticket. A Starts or Complete when value the two readers refuse is a `GateError`. If the newest watch file has the same `section_version`, no `end` line and no `check` line, it is this round already (the step is being run again after a crash): reuse it and write no new file. It then reads the ticket's status: Deployed posts the start comment with `say(..., once=True)`; any other known status posts nothing; an unknown status is a `GateError`.
- **`watch-criteria`** is three lines: read `watch_file`, call `round.step`, return what it returns.
- **`fix-closed`** keeps one note, `watch/fix-<bug key>.json`, holding `looked_at`. Less than an hour since: `pending`, with no Jira read and no write. Otherwise it reads the watched ticket's status and the Bug's state and rewrites the note. The ticket is known and not in Deployed: `left_deployed`. The Bug is `done`: write the `fix_shipped` card (the counts from every round whose log ended `not_met`) and answer `shipped`. The Bug is `cancelled` or `missing`: write the `fix_cancelled` card and answer `cancelled`. Anything else, an unknown included: `pending`.

- [ ] **Step 1: Write the failing tests.**
  - `test_start_writes_round_one_and_comments_once`: the file has `round == 1`, `begins_at == started_at`, `first_check_at` one interval later, the criteria and `fail_after`; the ticket has one comment equal to `validation_copy.start(...)`; running the gate again leaves one file and one comment.
  - `test_start_after_an_ended_round_writes_round_two`.
  - `test_start_on_a_date_and_after_a_ticket`: a date gives `begins_at` at that date's local midnight; a ticket gives empty `begins_at` and `first_check_at`, and the comment ends `first check due one check after JP-170 is Done.`
  - `test_start_writes_nothing_to_a_ticket_that_left_deployed`; `test_start_stops_when_the_status_cannot_be_read`.
  - `test_watch_gate_passes_the_step_through`: with a watch file whose check is not due, the gate's outcome is `pending`.
  - `test_fix_closed_waits_while_the_bug_is_open`; `test_fix_closed_looks_once_an_hour` (two calls ten minutes apart make one pair of Jira reads); `test_fix_closed_shipped_writes_the_card` (first line names the Bug and the number of failed rounds); `test_fix_closed_cancelled`; `test_fix_closed_left_deployed`; `test_fix_closed_unknown_keeps_waiting`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the three scripts.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 10: Closing, the Bug and the hold

Ticket JP-167.

**Files:**
- Create: `graphs/gates/close-watch.py`, `graphs/gates/file-validation-bug.py`, `graphs/gates/hold-watch.py`
- Test: `graphs/tests/test_validation_writes.py`

**Interfaces:**
- Consumes: `validation_copy` (Task 8); `round.newest`, `ended`; `log.read`; `grading.met_on`; `tickets.status`; `lib.adf.ticket_description`; `deps.jira.get` (its `links` and `labels`), `deps.jira.create(fields, properties) -> Optional[str]`, `deps.jira.link(kind, outward, inward)`; `deps.ticket.move`, `set_flag`; `say`, `screened`; `GRAPH_INPUT_TARGET_STATUS`.
- Produces: `close-watch` (outcome `closed`); `file-validation-bug` (outcome `filed`, output `bug_key`); `hold-watch` (outcome `held`).

Rules:
- **Rule 9, in all three.** Each first reads the ticket's status. Unknown is a `GateError`. Known and not `Deployed`: `close-watch` and `hold-watch` write nothing and still answer their one outcome, with the summary `the ticket had already left Deployed`. `file-validation-bug` is not asked the question: it runs seconds after a check that confirmed Deployed, and the wait that follows ends the run if the ticket has moved.
- **`close-watch`** serves three steps and tells them apart by `result`: `met` posts `met(...)` and the evidence table (the check number from `met_on`, the round from the newest watch file); `not_needed` posts `unwatched(evidence)`; anything else is Josh's accept and posts `accepted(today, the card file's first line)` and the evidence table when there is one. Each comment is posted with `once=True`. It then moves the ticket to `GRAPH_INPUT_TARGET_STATUS` and reads the status back; a status that is not the target is a `GateError`.
- **`file-validation-bug`**, in an order that survives a crash at any point: (1) if `watch/bug.json` names a key, use it; (2) else look through the ticket's `links` for an issue of type Bug whose status is not in the done category, read each such issue with `deps.jira.get` for its labels, and use the first labelled `validation-failure`; (3) else create the Bug from `bug_ticket` in the ticket's own project, with the ticket's system label read from its labels and the registry, and write `watch/bug.json` at once; (4) make sure the Bug is linked to the ticket (`Relates`), which is a no-op when it already is; (5) post `not_met(failed_text, bug_key)` and the evidence table with `once=True`. A create that returns `None` is a `GateError`: the run stops without a Bug and without the comment, and the retry starts at (1).
- **`hold-watch`** sets the flag, then posts `hold()` with `once=True`.

- [ ] **Step 1: Write the failing tests.**
  - `test_close_met_posts_evidence_and_moves_to_done`: the last comment starts `Validated in production | 7 checks in a row pass, reached on check 9 of round 1 | next gate: none.` and holds the table; the status is Done.
  - `test_close_unwatched_says_why`; `test_close_accepted_quotes_the_card`.
  - `test_close_leaves_a_moved_ticket_alone`: with the ticket in In Progress the fake's call log has no comment and no transition, and the outcome is `closed`.
  - `test_close_stops_when_the_move_did_not_take`.
  - `test_bug_is_filed_linked_and_announced`: one new issue of type Bug in Not Started with labels `validation-failure` and the ticket's system label; it is linked to the ticket; the ticket's comment names its key; the ticket is still in Deployed.
  - `test_open_linked_bug_is_reused`: a second call, and a call from a fresh work folder, create nothing.
  - `test_crash_after_create_does_not_file_twice`: with the fake set to fail the link call once, the first run raises, the second finishes, and Jira holds one Bug.
  - `test_bug_text_is_screened`: a criterion name holding a made-up patient name is refused by the screen and no issue is created.
  - `test_hold_flags_and_explains`; `test_hold_leaves_a_moved_ticket_alone`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the three scripts.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 11: The graph file and whole runs

Ticket JP-167. Last task of the ticket: it needs every gate, the start rule and the loose-ends rule.

**Files:**
- Create: `graphs/flows/validation.yaml`, `graphs/contracts/validation-plan.md`, `graphs/contracts/watch-result.md` (each moved from the draft folder with `git mv`), `tests/validation_helpers.py`
- Modify: `graphs/gates/move-ticket.py` (`JP_STATUSES` gains `"Deployed"` between `"Validation"` and `"Done"`), `graphs/CONVENTION.md` ("Wait steps"), `graphs/compiled/`
- Delete: `docs/superpowers/specs/2026-11-18-post-deploy-validation-draft/` (the rest of it)
- Test: `tests/test_validation_graph.py`

**Interfaces:**
- Consumes: every gate of Tasks 8 to 10; `tests/walker_helpers.WalkerCase`; the fake Jira; the readers of Tasks 4 and 5.
- Produces, `tests/validation_helpers.py`: `class ValidationCase(WalkerCase)` with `ticket(key, validation=..., status="Deployed")` (seeds the fake Jira), `job_state(job_id, exit_code, minutes_ago)` (writes `jobs-state.json` under the test's `JOSH360_HOME`), `age(run, hours)` (moves every time in that run's `work/watch/` files back by that many hours, which is how a test lets an interval pass without a clock in the gate scripts), and `walk(run)` (calls the walker's `next` until it prints something other than a finished gate).

What changes when the draft moves:
- The graph file loses its three DRAFT comment lines. Both `card` outputs are described as "the path of the card file". Nothing else about its steps, outcomes or loops changes.
- `validation-plan.md` gains the watch file's `*_kind`, `starts_date`, `starts_ticket`, `complete_n` and `ticket_key` rows and the check log's table from [Shared shapes](#shared-shapes). Both contracts gain a `## Contents` section.
- `graphs/CONVENTION.md`, "Wait steps": after "a wait never changes anything", add that a wait's only writes are its own notes in the run's work folder, which are run state in the way the walker's `run.json` is.
- The spec keeps its links to the draft folder as history; change them to the new paths where `scripts/docs_check.py` reports a dead link.

- [ ] **Step 1: Write the failing tests** in `tests/test_validation_graph.py`. Each starts the real graph with the real gates.
  - `test_met_run_ends_finished`: a ticket with a one-hour, three-in-a-row section on `job sample-job`; `age` and `walk` three times; the run's end is `finished`, the ticket is Done, and its last comment holds the evidence table.
  - `test_no_section_goes_straight_to_done`: the end is `close_unwatched.closed`; the last comment is `Nothing to watch | the ticket has no Validation section | next gate: none.`; `test_needed_no_goes_to_done_with_its_reason`.
  - `test_failed_watch_files_one_bug_and_stays_deployed`: after three failing checks the walker answers `waiting` at `await_fix`; one Bug labelled `validation-failure` is linked; the ticket is in Deployed.
  - `test_shipped_fix_reads_the_section_again`: the test edits the section (`3 checks` to `2 checks`), moves the Bug to Done, ages the fix note an hour and walks: `round-2.json` exists and holds `complete_n == 2` and a new `section_version`.
  - `test_second_shipped_fix_asks_josh`: after a second failed round and a second shipped fix the walker answers `parked` at `decide`, and the card's first line names the counts from both rounds.
  - `test_cancelled_fix_asks_josh`; `test_no_data_asks_josh_once` (a reader that is always unknown, aged past "Give up after": `parked`, the question is the spec's sentence with the key in it, the card names the criterion); `test_unreadable_section_asks_josh`; `test_manual_criterion_asks_josh_when_the_rest_is_met`.
  - `test_watch_again_shows_the_new_card`: after `watch_again` and a second `no_data` round whose missing criterion differs, the parked question's card is the second round's.
  - `test_accept_closes_on_joshs_answer` (end `close_accepted.closed`, comment starts `Closed on Josh's answer`); `test_stop_holds_the_ticket` (end `hold.held`, the flag is on, the status is Deployed).
  - `test_ticket_moved_by_hand_is_left_alone`: move the ticket to In Progress, call `next` three times within the hour, then age the look an hour and call it again: the end is `watch.left_deployed`, and from the moment of the move the fake's call log holds no transition, no comment and no flag change.
  - `test_run_passes_the_exit_gate_with_no_session`.
  - `test_no_step_has_a_role`: every step in the compiled graph is a gate, a wait or an ask.
  - `test_declared_collectors_are_the_reader_modules`: for each name in `DECLARED`, the module `lib.collectors.<name with underscores>` exists and its `FIELDS`, `COUNTS_EVENTS` and `ARGUMENT.pattern` equal the declared entry; no other reader module exists; `reading.CODE.pattern == collectors.CODE.pattern`.
  - `test_every_comparison_is_graded`: `grading.holds(1, c, 1)` is not `None` for each `c` in `COMPARISONS`.
  - `test_the_draft_folder_is_gone`.
- [ ] **Step 2: Run** the file. Expected: FAIL, `there is no graph validation`.
- [ ] **Step 3: Move** the three files, make the changes above, add `"Deployed"` to `JP_STATUSES`, write the helper, delete the draft folder.
- [ ] **Step 4: Run** `python3 graphs/tools/check_graph.py`, `python3 graphs/tools/compile_graphs.py`, the test file, then `python3 scripts/check.py`. Expected: no problems, PASS, `check.py: ok (0 problem(s))`. If the feature tree or the architecture page check asks for the new graph, add it to `docs/design/feature-tree/tree.yaml` and run the two `build` commands in `AGENTS.md`.
- [ ] **Step 5: Commit** (one commit per file; the three moves are one commit each).

### Task 12: The start rule and the waiting list

Ticket JP-167.

**Files:**
- Modify: `graphs/runner/starts.json`, `graphs/runner/settings.json`, `graphs/runner/runner_lib/watch.py` (`load_rules`, `_try_start`), `graphs/runner/runner_lib/paths.py` (`DEFAULTS`), `graphs/runner/runner_lib/status.py` (`snapshot`), `graphs/gates/lib/jira_fake.py` (`_judge`), `graphs/runner/README.md`
- Test: `tests/test_runner_watch.py`, `tests/test_runner_report.py`, `graphs/tests/test_gate_jira.py`

**Interfaces:**
- Produces: a start rule may carry `"route_record": false`; `DEFAULTS["wait_flag_exempt"] == ["validation.watch"]`.

`starts.json` gains, beside `development`:

```json
"validation": {
  "on": true,
  "jql": "project = JP AND status = Deployed AND Flagged is EMPTY",
  "route_record": false,
  "inputs": {}
}
```

Rules:
- `load_rules`: a rule that is on needs `route` unless it has `"route_record": false`. With `false`, a `route` key, or an input whose source starts `route.` or `spec.`, is a `ValueError` naming the entry.
- `_try_start`: for such a rule, skip the route-record read and the spec-property read. Everything else is as today: a ticket with an open run is skipped, one start per pass across all graphs, and a refused entry gate is `not admitted`.
- `snapshot`: a waiting run whose `<graph>.<step>` is in `wait_flag_exempt` is left out of `waiting_over_7_days`. `await_fix` is not on the list and is still shown.
- The fake Jira's search learns the clause `Flagged is EMPTY` (the issue's flag field is empty or absent).

- [ ] **Step 1: Write the failing tests.**
  - `test_gate_jira.py`: `test_fake_search_applies_flagged_is_empty`.
  - `test_runner_watch.py`: `test_deployed_ticket_starts_a_validation_run` (no route record is seeded; `started == ["JP-901"]`; the run's `run.json` inputs hold only `ticket_key`); `test_flagged_ticket_is_not_picked_up` (`started == []` and the ledger has no run); `test_deployed_ticket_with_an_open_run_is_skipped`; `test_rule_without_a_route_must_say_so` (`ValueError` naming the entry); `test_route_source_in_a_rule_with_no_route_record_is_refused`; `test_shipped_rules_load` (`development` and `validation` are on, and every key of the validation rule's `inputs` is an input of the graph).
  - `test_runner_report.py`: `test_watch_step_is_left_off_the_seven_day_list` (a validation run waiting at `watch` for eight days is absent; one waiting at `await_fix` for eight days is present); `test_shipped_settings_match_defaults` still passes with the new key.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.** The `validation` entry is tested here against a fixture graph of the same name until Task 11 lands in the worktree; Task 11's whole-run tests use the real one.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 13: Loose ends, the doctor check and the documents

Ticket JP-167.

**Files:**
- Create: `scripts/doctor_lib/graph_checks.py`
- Modify: `ledger/live.py` (`_read_ticket`), `ledger/loose_ends.py` (`_tickets`), `tests/loose_helpers.py` (`fake_live`), `scripts/doctor.py` (import the new module after `service_checks`), `docs/platform-doctor.md`, `AGENTS.md` (Layout: the collectors and the watch library; Commands: how to read a watch), `graphs/runner/README.md`
- Test: `tests/test_live.py`, `tests/test_loose_ends.py`, `graphs/tests/test_gate_no_loose_ends.py`, `tests/test_doctor.py`

**Interfaces:**
- Produces: `Live.ticket(key)` returns `{"status": str, "done": bool, "flagged": bool}`; the doctor check `graphs.validation-watch`.

Rules:
- `_read_ticket` asks for `fields=status,customfield_10021`. `flagged` is true when that field holds anything.
- `_tickets`: a ticket whose status is `Deployed` and is not flagged is not a loose end. One that is `Deployed` and flagged is listed as `ticket-not-done` with the words `<KEY> is Deployed: validation needs you`. Every other status behaves as today.
- **The doctor check** (`@check("graphs", "validation-watch")`): FAIL when the laptop's copy of `graphs/runner/starts.json` has no `validation` rule or it is off (fix: set `"on": true`). Otherwise read the open validation runs from the ledger (`graph_runs` rows with no row in `run_ends`, read-only through `ctx.sqlite_ro`). For each, take its newest watch file and log: FAIL when the watch has begun, has no `end` line, and `ctx.now` is more than one day past `begins_at` plus `give_up_days` (the day's grace is for a closed laptop), naming the run and the ticket key. PASS with `rule on; <n> watches open, none overdue`. SKIP when the ledger cannot be read. It reads files and the ledger only.

- [ ] **Step 1: Write the failing tests.**
  - `test_live.py`: `test_ticket_reads_the_flag`.
  - `test_loose_ends.py`: `test_deployed_and_not_flagged_is_not_a_loose_end`; `test_deployed_and_flagged_is_listed_as_needing_josh` (the item's text holds `validation needs you`); `test_in_progress_is_listed_as_before`.
  - `test_gate_no_loose_ends.py`: `test_run_with_no_session_passes`; `test_development_run_whose_ticket_is_in_deployed_passes`.
  - `test_doctor.py`: `test_validation_rule_off_fails`; `test_overdue_watch_fails_and_names_the_run`; `test_open_watch_inside_its_timetable_passes`; `test_watch_that_has_not_begun_passes`; `test_unreadable_ledger_skips`; `test_check_writes_nothing` (the helper's `snapshot` of the home folder is unchanged).
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement**, then add the check's row to `docs/platform-doctor.md` and the lines to `AGENTS.md` and the runner's README.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 14: The movers in the two graphs

Ticket JP-168.

**Files:**
- Create: `graphs/gates/validation-rule.py`
- Modify: `graphs/gates/close-ticket.py`, `graphs/gates/lib/dev_copy.py`, `graphs/gates/lib/nondev_copy.py`, `graphs/flows/development.yaml`, `graphs/flows/non-development.yaml`, `graphs/compiled/`
- Test: `graphs/tests/test_dev_ticket_gates.py`, `graphs/tests/test_nondev_ticket_gates.py`, `tests/test_development_graph.py`, `tests/test_nondev_graph_run.py`

**Interfaces:**
- Consumes: `validation_section.needs_watch`.
- Produces: gate `validation-rule` (inputs `ticket_key`; outcomes `done`, `watch`; read-only); `dev_copy.handed_to_watch(url: str, merge_commit: str, run_id: str) -> str`; `nondev_copy.handed_to_watch() -> str`.

Rules:
- **`validation-rule`** answers `watch` only when the key matches `^JP-\d+$` and `needs_watch(description)` is true. Everything else is `done`. A ticket that cannot be read is a `GateError`.
- **`close-ticket`** moves the ticket to `GRAPH_INPUT_TARGET_STATUS`, which must be `Done` or `Deployed` (anything else, or nothing, is `Done`, so a hand run behaves as today). For `Deployed`, the development comment is `handed_to_watch`: `Merged, now watched in production | merged {url} as {sha} · spec and evidence saved with run {run} | next gate: the validation watch starts within five minutes; the ticket is Done when its criteria are met`. The non-development path posts the same resolution comment as today, then `Delivered, now watched in production | the resolution is in the comment above | next gate: the validation watch starts within five minutes`.
- **`development.yaml`.** `clean_up` moves from the Done stretch to the Validation stretch, so the ticket is not moved to Done before the rule is read. A new step `validation_rule` (gate `validation-rule`, access `read`, needs `clean_up`, inputs `[ticket_key]`) follows it in the same stretch. `close` keeps its gate and inputs, needs `validation_rule` and runs `when` it answered `done`. A new step `hand_to_watch` has the same gate, effects and inputs as `close`, needs `validation_rule`, runs `when` it answered `watch`, and sits alone in a new stretch `{ status: Deployed, steps: [hand_to_watch] }` placed between Validation and Done. Both end the run as `finished`; `end_states` is unchanged.
- **`non-development.yaml`.** The same pair after `share_out`: `validation_rule` joins the Validation stretch, `close` runs when it answered `done`, and `hand_to_watch` in a new Deployed stretch runs when it answered `watch`. `close_emailed` is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - Gate tests: `test_rule_says_watch_for_a_jp_ticket_that_needs_one`; `test_rule_says_done_for_needed_no`, `..._for_no_section`, `..._for_a_ticket_outside_jp` (key `AD-12` with "Needed: yes"); `test_rule_says_watch_even_when_the_section_has_a_problem` (the graph, not the mover, asks Josh about it); `test_close_ticket_moves_to_deployed_when_told` (status Deployed, the comment equals `handed_to_watch(...)`); `test_close_ticket_still_moves_to_done` (no target given).
  - `test_development_graph.py`: `test_merged_ticket_that_needs_a_watch_ends_in_deployed` (the ticket is in Deployed, the run's end is `finished`, and the fake Jira's log has no move to Done); `test_merged_ticket_with_needed_no_ends_in_done`; `test_ad_ticket_is_never_sent_to_deployed`.
  - `test_nondev_graph_run.py`: `test_signed_off_ticket_that_needs_a_watch_ends_in_deployed`; `test_signed_off_ticket_with_needed_no_ends_in_done`.
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement** the gate and the copy, change `close-ticket.py`, change the two graph files.
- [ ] **Step 4: Run** `python3 graphs/tools/check_graph.py`, `python3 graphs/tools/compile_graphs.py`, the tests, then `python3 scripts/check.py`. Expected: no problems, PASS, `check.py: ok (0 problem(s))`.
- [ ] **Step 5: Commit** (one commit per file).

### Task 15: The movers in the workflow documents

Ticket JP-168. Documents only.

**Files:**
- Modify: `docs/WORKFLOW.md` (§4 and §5.1), `.claude/skills/ticket-lifecycle/SKILL.md`, `conventions/tickets.md` ("Statuses and who moves them")

- [ ] **Step 1: `docs/WORKFLOW.md`.** The status list gains Deployed between Validation and Done. §5.1: after the merge the thread reads the ticket's Validation section; "Needed: yes" moves the ticket to Deployed (transition `7`) with a `result | evidence | next gate` comment whose next gate is the validation watch; anything else moves it to Done as today. A thread never moves a ticket out of Deployed: the validation graph does, or Josh.
- [ ] **Step 2: The skill and the convention.** The `ticket-lifecycle` skill's status line and its "after merge" step say the same in two sentences. `conventions/tickets.md` gains the Deployed row (who moves a ticket in, who moves it out, from the spec's two tables) and the rule for choosing Deployed or Done.
- [ ] **Step 3: Run** `python3 scripts/docs_check.py`, then `python3 scripts/check.py`. Expected: `docs_check.py: ok (0 problem(s))`, `check.py: ok (0 problem(s))`.
- [ ] **Step 4: Commit** (one commit per file).

### Task 16: The proof run on the laptop

Ticket JP-169. Nothing is built. The watch on JP-167 is already running when this starts: JP-167's thread moved it to Deployed, and the laptop installed the merge on its own.

**Files:**
- Create: `docs/proof/<date>/JP-169/README.md`

- [ ] **Step 1: Confirm the watch started.** `git fetch origin laptop-status && python3 laptop/status.py show graph-runner` lists an open `validation` run for JP-167 at step `watch`, and JP-167 carries the start comment. If it does not within an hour of the merge, read `python3 laptop/status.py show doctor` (the checks `graphs.validation-watch` and the runner's own) before doing anything else.
- [ ] **Step 2: Wait without holding a session.** The watch needs three hourly checks after the doctor's daily report first carries `graphs.validation-watch`, so up to about a day. Set one reminder for the next morning; do not poll.
- [ ] **Step 3: Read the result.** JP-167 is Done, its last comment starts `Validated in production` and holds the evidence table. `python3 graphs/runner/runner.py report --from-json <the published report>` shows the run's steps: every row is a gate or a wait, no row has a session or a model, and the end is `finished`. That is the proof of "the run made no model call".
- [ ] **Step 4: Write the proof page:** the scenario, the start comment, the evidence table, the run's step table, the time from Deployed to Done, and the [laptop checks owed](#laptop-checks-owed-after-the-build) with what each showed. Counts, codes and ids only.
- [ ] **Step 5: If the watch ended any other way,** the page says so plainly, the Bug the graph filed (or a new Bug for a defect in the watch itself) carries the fix, and JP-169 stays open until a watch ends as met.
- [ ] **Step 6: Run** `python3 scripts/check.py`, open the pull request, and close JP-169 through the review ceremony.

## Laptop checks owed after the build

Each is read from the cloud (`python3 laptop/status.py show <report>`) unless it says otherwise. JP-169's proof page records them.

| After | Check | Good result |
| --- | --- | --- |
| JP-166 | A report job's local copy exists | The doctor's next daily run leaves `~/.josh-360/state/reports/doctor.json` (seen through the `report` and `doctor` collectors reading it in JP-167's watch) |
| JP-167 | The start rule is live | `show graph-runner` has a `validation` entry with `jira: ok` |
| JP-167 | The doctor knows the watch | `show doctor` lists `graphs.validation-watch` as `pass` |
| JP-167 | Nothing was waiting in Deployed | On 18 November 2026 no JP ticket was in Deployed, so the first pass should start only JP-167's run. Any other ticket found there with no Validation section is moved to Done with the "Nothing to watch" comment: check that each such move was expected |
| JP-167 | The watch is off the seven-day list | `show graph-runner` shows JP-167's run under open runs and not under `waiting_over_7_days` |
| JP-168 | The first graph hand-over | The first development run of a ticket with "Needed: yes" ends with the ticket in Deployed and a validation run starting within five minutes |
| JP-165 | Old tickets at the Ready check | A Story, Task or Bug written before this build fails V1 when triage next reads it and is completed like any other gap. A ticket that is already Ready is not touched: the `ready` entry gate checks the signed version, not the checklist. JP-116 is in that position and must not be edited before its own run |

## Choices this plan makes

Each can be undone. The same rows are in `docs/decisions/JP-164.md`.

| Choice | Why | How to undo |
| --- | --- | --- |
| The list of collectors lives in `collectors/__init__.py` (JP-165) and each reader repeats its own fields (JP-166), with a test that they agree | The spec puts the field list with each module, which would make the Ready check wait for the collectors. This way the two tickets are built at the same time | Have `__init__.py` build `DECLARED` from the reader modules and delete the table |
| The watch file holds the timetable as read values (`starts_kind`, `complete_kind`, `complete_n`) beside the ticket's words | The watch script then never parses ticket text, and JP-166 needs nothing from JP-165 | Pass only the words and parse them in `round.py` |
| The watch keeps no third file: what is due is worked out from the watch file and the check log on each call | Two small reads every five minutes cost nothing, and one less file is one less thing to go stale | Add a `next` file written after each look and check |
| The card is one file, `watch/card.md`, that `validation-verdict` and `fix-closed` both rewrite | The walker shows the card of the last step in graph order that has one, so two inline cards would show Josh a stale one after "watch again" | Change the walker to prefer the step that finished last |
| The check log has `began`, `look` and `end` lines as well as `check` lines | One notebook then answers when the watch began, when Jira was last read and how the round ended; the doctor check and `fix-closed` read the `end` line | Keep those in separate files |
| A doctor report older than 36 hours reads as unknown | The `doctor` collector returns a status with no age; without a bound a stale pass would count for ever | Change the number in `collectors/doctor.py` |
| `jira-count` reads as unknown above 200 results | A capped search gives a floor, not a count | Raise the cap, or page the search |
| `github-runs` takes an optional branch after the workflow file, and counts only `success` and `failure` | josh-360's default branch on GitHub is not `main`, so "the default branch" alone would watch the wrong one. Cancelled and skipped runs say nothing about the change | Drop the third word and always ask GitHub |
| A scenario in the Validation block with no `@validate` tag is V4, and an ordering comparison against a word is V6 | The spec is silent on both; refusing at Ready is safer than a criterion nobody watches or a check that can never be read | Ignore the untagged scenario; let the check read as unknown |
| "Needed: no" with any other line in the section is V2 | The spec says the section is that one line and nothing else | Ignore the extra lines |
| `file-validation-bug` keeps the new Bug's key in `watch/bug.json` | A crash between the create and the link would otherwise file a second Bug | Search Jira by summary instead |
| The doctor allows one day past "Give up after" before it fails | A laptop closed overnight should not turn the check red | Change the grace in `graph_checks.py` |
| JP-168 waits for JP-167 as well as JP-165 (the spec says the movers need only the format) | Until the graph is live nothing watches a ticket sent to Deployed, and the development graph's exit gate would list that ticket as a loose end until JP-167's rule lands | Move the loose-ends rule into JP-168 and drop the link |
| The hand-over comments (`handed_to_watch`) are worded by this plan | The spec fixes no copy for a mover | Edit the two functions |
| JP-167 is the ticket the proof run watches, with three hourly checks on the runner's job and the new doctor check | It is the first ticket whose change can only be proven by running, and a short timetable gives a proof page within a day | Give JP-169 a ticket of its own to watch |

## Spec coverage

| Spec section | Task |
| --- | --- |
| The three statuses; Who moves a ticket into and out of Deployed | 10 (out), 14 and 15 (in) |
| The Validation section of a ticket; How a script reads the section | 1, 3 |
| Collectors | 1 (the list), 4, 5 |
| The Ready check (V1 to V7, J6, the drafter) | 1, 2, 3 |
| The steps; the flow at a glance | 8, 9, 10, 11 |
| How the watch runs (when it begins, the first check, grading, a closed laptop, the check log, long waits) | 6, 7, 9, 11 (the convention sentence), 12 (the waiting list) |
| When the criteria are not met | 9 (`fix-closed`), 10 (the Bug), 11 (the loops) |
| When no data arrives, and the one question | 8 (the six cards), 11 |
| Evidence, and what the ticket shows | 7 (log, tally), 8 (table), 10 (comments) |
| Starting a run | 12 |
| Loose ends | 13 |
| The subtask rule | 3 |
| What changes outside the graph | 3, 11, 12, 13, 14, 15 (`.claude/workflow.config.md` was done with the spec) |
| How every loop ends | 11 |
| How to tell it's working | Read from the ledger rows and the check log this build writes; no task builds a view (out of scope until phase 3) |
| Exact copy | 8 |
| Rules 1 to 11 | 1 and 2 (rule 1); every task (2, 3, 4, 10); 7 (5); 10 (6, 7, 9); 12 (8, 11) |

| Spec scenario | Test | Task |
| --- | --- | --- |
| A complete Validation section is read | `test_first_example_reads` | 1 |
| A section the script cannot read names each problem | `test_daily_is_v3_and_names_the_line_and_the_form`, `test_daily_fails_v3_through_ready_check` | 1, 2 |
| A criterion naming an unknown collector is refused | `test_unknown_collector_is_v5`, `test_unknown_collector_fails_v5_through_ready_check` | 1, 2 |
| A watch that is not due does nothing | `test_not_due_answers_pending_and_touches_nothing` | 7 |
| Seven passing checks in a row end the watch as met | `test_seven_passes_in_a_row_are_met`, `test_seven_passes_end_met` | 6, 7 |
| An unreadable check neither counts nor breaks the run | `test_an_unknown_neither_counts_nor_breaks` | 6 |
| Three failing checks in a row end the watch early | `test_three_fails_end_it_early` | 6 |
| A "Fail after" line changes when a watch ends early | `test_fail_after_five_waits`, `test_fail_after_line_is_read` | 6, 1 |
| A watch that starts on a date takes no reading before it | `test_date_start_takes_no_reading_before_it` | 7 |
| A watch that waits for another ticket begins when that ticket is Done | `test_ticket_start_begins_when_that_ticket_is_done` | 7 |
| A watch whose start can never come ends as no data | `test_cancelled_start_ticket_ends_no_data`, `test_verdict_each_case` | 7, 8 |
| A watch with no readings ends as no data | `test_all_unknown_until_give_up_ends_no_data`, `test_no_data_asks_josh_once` | 7, 11 |
| A failed watch files one linked Bug and keeps the ticket in Deployed | `test_failed_watch_files_one_bug_and_stays_deployed` | 11 |
| The watch starts again when the fix ships | `test_shipped_fix_reads_the_section_again` | 11 |
| A ticket with nothing to watch goes straight to Done | `test_no_section_goes_straight_to_done` | 11 |
| A flagged ticket is not picked up | `test_flagged_ticket_is_not_picked_up` | 12 |
| A ticket Josh moved is left alone | `test_ticket_moved_by_hand_is_left_alone` | 11 |
| The development graph hands a ticket to the watch | `test_merged_ticket_that_needs_a_watch_ends_in_deployed` | 14 |
| A watched ticket is not a loose end | `test_deployed_and_not_flagged_is_not_a_loose_end` | 13 |
| No reading carries text from the system it read | `test_no_reading_carries_text` | 5 |
| One real ticket is watched to Done on the laptop (`@e2e`) | The proof page | 16 |
