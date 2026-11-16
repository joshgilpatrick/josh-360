# Ticket creation graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Contents

- [Global Constraints](#global-constraints)
- [Review Focus](#review-focus)
- [File map](#file-map)
- [Task 1: Gate plumbing, JSON contracts and a registry the laptop can read](#task-1-gate-plumbing-json-contracts-and-a-registry-the-laptop-can-read)
- [Task 2: Entry gate and routing](#task-2-entry-gate-and-routing)
- [Task 3: Duplicate rule](#task-3-duplicate-rule)
- [Task 4: Patient-data helper and completeness gate](#task-4-patient-data-helper-and-completeness-gate)
- [Task 5: Jira client and Josh's format in Jira](#task-5-jira-client-and-joshs-format-in-jira)
- [Task 6: Writing tickets](#task-6-writing-tickets)
- [Task 7: The approval card text](#task-7-the-approval-card-text)
- [Task 8: Linking the source and the exit gate](#task-8-linking-the-source-and-the-exit-gate)
- [Task 9: Intake hand-off and a full run](#task-9-intake-hand-off-and-a-full-run)
- [Task 10: action-triage hand-offs (waits for the phase close)](#task-10-action-triage-hand-offs-waits-for-the-phase-close)

**Goal:** Build JP-121: the ticket creation graph runs, turning an intake item into a complete ticket (or a parent with children) after Josh approves the card.

**Architecture:** The graph file, roles and contracts already exist from JP-102. This plan replaces the seven refusing gate stubs with real scripts on a small shared library in `graphs/gates/lib/`, adds the card renderer the walker shows at the `approve` ask, and adds one intake entry point that sources call. The walker (JP-114) runs the graph; the Agent Manager binding (JP-117) runs the role steps.

**Tech Stack:** Python 3.9, standard library only (gate scripts run on Josh's laptop); stdlib `unittest`; Jira Cloud REST v3 over `urllib`.

**Spec:** `docs/design/ticket-creation-graph.md` (approved by Josh, 16 November 2026). Boards: none. The card has no new screen; its exact text is in the spec's "The approval card".

## Global Constraints

- Gate scripts and everything in `graphs/gates/lib/` run on the laptop: Python 3.9, standard library only, no PyYAML.
- A gate script reads `GRAPH_INPUT_<NAME>` and prints one JSON line `{"outcome", "outputs", "summary"}` (`graphs/CONVENTION.md`, "Gate scripts"). A gate that cannot decide exits non-zero with no outcome; the walker never retries it.
- No model in any gate. No role writes Jira.
- Never set Agent Status, points, assignee, dates, Jira priority, or the Ready status. Tickets are created in Not Started.
- One create per ticket. An unconfirmed create is searched for (exact summary, same space, created in the last 10 minutes), never retried blind.
- Every ticket is read back after it is written.
- Labels: the lowercase repository name only, plus `improvement` where the type calls for it.
- Every created ticket carries the issue properties `action-triage.spec` (`{"type": <work kind>}`) and `josh360.authors` (list of session ids).
- No patient data in any proposal, ticket, comment, card, log line or test fixture. Tests use made-up data.
- The open-match comment text, the card text and the stage-3 comment text are copied exactly from the spec.
- Site `https://eventuswh-analytics.atlassian.net`. Spaces JP, AD and CI; never TECH.
- Each loop limit and tier cap in the spec's "How every loop ends" stays as written in `graphs/flows/ticket-creation.yaml`.

## Review Focus

1. Jira times out on a create that actually succeeded: the retry of `write` must find it and not make a second ticket.
2. One child of three fails to create: `partial`, and the retry creates only the missing child, under the right parent.
3. An input whose text holds a patient detail reaches the drafter, which quotes it: `ticket-complete` must stop it before the card.
4. A repository written with its owner, `.git`, or underscores instead of hyphens (`eventuswh-apps/josh_projects.git`): routing must still match the registry.
5. A summary longer than Jira's 255 characters, or with a line break: `ticket-complete` must return `fixable`, not let the create fail.

Each line's test is in the task that owns the code (Tasks 6, 6, 4, 2, 4).

---

## File map

| File | Responsibility |
| --- | --- |
| `graphs/gates/lib/__init__.py` | Empty; makes `lib` importable from a gate. |
| `graphs/gates/lib/gate_io.py` | Read inputs, print the outcome line, fail without an outcome. |
| `graphs/gates/lib/contracts.py` | Load and validate an intake record and a ticket proposal. |
| `graphs/gates/lib/patient_data.py` | The patient-data scan (shared with JP-103's `ready-check`). |
| `graphs/gates/lib/jira.py` | Jira REST client: search, get, create, comment, link, properties. |
| `graphs/gates/lib/adf.py` | Josh's ticket sections as Atlassian Document Format. |
| `graphs/gates/lib/card.py` | The approval card text. |
| `graphs/gates/*.py` | The seven gates, each a thin script over `lib`. |
| `graphs/intake/submit.py` | The one entry point a source calls to start a run. |
| `scripts/conventions.py` | Changed: PyYAML imported only where YAML is read; new `export-json`. |
| `conventions/registry.json` | Generated copy of the registry for the laptop. |
| `graphs/tests/test_gate_*.py`, `graphs/tests/fixtures/ticket_creation/` | Tests and made-up fixtures. |

Each gate script inserts `Path(__file__).resolve().parent` on `sys.path` and imports from `lib`.

---

### Task 1: Gate plumbing, JSON contracts and a registry the laptop can read

**Files:**
- Create: `graphs/gates/lib/__init__.py`, `graphs/gates/lib/gate_io.py`, `graphs/gates/lib/contracts.py`, `conventions/registry.json`
- Modify: `scripts/conventions.py` (move `import yaml` into `load`; add `export-json`), `scripts/check.py` (fail when `registry.json` is stale), `graphs/contracts/intake-record.md`, `graphs/contracts/ticket-proposal.md` (YAML to JSON), `docs/decisions.md`
- Test: `graphs/tests/test_gate_lib.py`, `tests/test_conventions.py`

**Interfaces:**
- Produces: `gate_io.read_input(name: str, default: str | None = None) -> str | None`; `gate_io.read_json_input(name: str) -> object` (the input is a path to a JSON file, or inline JSON); `gate_io.emit(outcome: str, outputs: dict | None = None, summary: str = "") -> None`; `gate_io.fail(reason: str) -> NoReturn` (stderr, exit 2); `contracts.load_record(path) -> dict`, `contracts.load_proposal(path) -> dict`, `contracts.proposal_problems(p: dict) -> list[str]`; `conventions.lookup_repo` and `lookup_folder` importable without PyYAML; `conventions/registry.json`.

- [ ] **Step 1: Write the failing tests.** `test_emit_prints_one_json_line` (captures stdout; `json.loads` of the single line equals `{"outcome": "pass", "outputs": {}, "summary": ""}`); `test_fail_exits_2_without_outcome`; `test_read_json_input_accepts_path_and_inline`; `test_proposal_problems_names_missing_fields` (a proposal without `action` yields `["proposal: missing 'action'"]`); `test_lookup_works_without_yaml` (runs `python3 -c "import sys; sys.modules['yaml']=None; ..."` importing `conventions` and calling `lookup_repo(json.load(open('conventions/registry.json')), 'josh-360')`, expects `jira_space == 'JP'`); `test_registry_json_is_fresh` (`export-json --check` exits 0).
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_lib.py'` and `python3 -m unittest tests.test_conventions`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the two `lib` modules; move `import yaml` into `conventions.load`; add `python3 scripts/conventions.py export-json [--check]` (writes `conventions/registry.json` with `sort_keys=True, indent=2`; `--check` exits 1 when the file differs); add the freshness check to `scripts/check.py` as its next numbered check. Convert both contracts' examples and "YAML" wording to JSON: stdlib cannot read YAML, and every gate reads these files. Record that in `docs/decisions.md` (JP-121, "Contracts are JSON files", undo: add PyYAML to the laptop).
- [ ] **Step 4: Run** both test commands, then `python3 scripts/check.py --fast`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit** one file at a time, each message starting `JP-121:`.

### Task 2: Entry gate and routing

**Files:**
- Modify: `graphs/gates/intake-admitted.py`, `graphs/gates/route-ticket.py`
- Create: `graphs/gates/lib/sources.py`
- Test: `graphs/tests/test_gate_intake_route.py`, fixtures in `graphs/tests/fixtures/ticket_creation/`

**Interfaces:**
- Consumes: `gate_io`, `contracts.load_record`, `conventions.lookup_repo/lookup_folder`, `conventions/registry.json`.
- Produces: `sources.item_state(source: str, source_ref: str) -> dict` with keys `exists: bool`, `dismissed: bool`, `ticket_key: str | None`, `open_run: bool`. Paths come from env: `JOSH360_ACTION_ITEMS` (action-triage `action-items.json`), `DESK_DB`, `JOSH360_RUNS` (the walker's run folder, JP-114). `route-ticket` outputs `route` as `{"space", "parent", "area", "priority", "system", "labels", "rule"}` where `rule` is one of `named`, `repository`, `folder`, `fallback`.

- [ ] **Step 1: Write the failing tests.** `test_admits_new_todo` → `pass`; `test_refuses_item_with_ticket_key` → `refused`, summary names the key; `test_refuses_dismissed_item`; `test_refuses_item_with_open_run`; `test_refuses_notion_in_first_wave`; `test_named_space_wins` (`GRAPH_INPUT_NAMED_SPACE=AD`, a josh-360 record → space `AD`, rule `named`); `test_repository_routes_josh_360` → `matched`, space `JP`, parent `JP-94`, labels `["josh-360"]`, rule `repository`; `test_repository_spelling_variants` (Review Focus 4: `eventuswh-apps/josh_projects.git` → system `josh-projects`); `test_unknown_repository_is_unmatched` → `unmatched`, space `JP`, parent `null`, area `null`, labels `[]`; `test_model_named_repo_not_in_registry_is_unmatched`; `test_linear_system_is_personal` (`family_os`) → `personal`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_intake_route.py'`. Expected: FAIL (stubs exit 1).
- [ ] **Step 3: Implement** `sources.item_state` and the two gates. Routing order is exactly `conventions/tickets.md`, "Routing a ticket to a space and a parent". An empty `named_space`/`named_parent` and the default `none` count as not named.
- [ ] **Step 4: Run** the test command and `python3 graphs/tools/check_graph.py`. Expected: PASS, `check_graph: ok`.
- [ ] **Step 5: Commit** one file at a time.

### Task 3: Duplicate rule

**Files:**
- Modify: `graphs/gates/duplicate-rule.py`
- Test: `graphs/tests/test_gate_duplicate_rule.py`

**Interfaces:**
- Consumes: `GRAPH_INPUT_CANDIDATES` (JSON list from `jira-searcher`: `{"key", "summary", "status", "is_match": bool, "why"}`), the intake record's `weight`.
- Produces: outcome `open_match | new_light | new_full`; output `match_key` (string or `null`) and `match_status`.

- [ ] **Step 1: Write the failing tests.** `test_open_match` (one candidate `is_match` true, status `In Progress`) → `open_match`, `match_key` that key; `test_done_match_links` (status `Done`) → `new_<weight>` with `match_key` set; `test_cancelled_match_links`; `test_non_match_ignored` (`is_match` false, status open) → `new_light`; `test_first_open_match_wins_over_done`; `test_empty_list_full_weight` → `new_full`; `test_malformed_candidates_fails` → exit 2, no outcome.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_duplicate_rule.py'`. Expected: FAIL.
- [ ] **Step 3: Implement.** "Done or Cancelled" is the status name, compared case-insensitively; every other status is open.
- [ ] **Step 4: Run** the test command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: Patient-data helper and completeness gate

**Files:**
- Create: `graphs/gates/lib/patient_data.py`
- Modify: `graphs/gates/ticket-complete.py`
- Test: `graphs/tests/test_gate_ticket_complete.py`

**Interfaces:**
- Consumes: `contracts.load_proposal`, `contracts.proposal_problems`; JP-103's checklist as data from `graphs/gates/lib/ready_checklist.py` (`CHECKLIST: dict[str, list[dict]]`, owned by JP-122). If JP-122 has not landed, this task adds that module with the sections from `conventions/tickets.md`, "Required sections", and JP-122 extends it.
- Produces: `patient_data.scan(text: str, source_text: str | None, flagged: bool) -> list[str]` (problems; empty means clean); `ticket-complete` outcomes `pass | fixable | needs_josh` with output `problems` (list of strings).

- [ ] **Step 1: Write the failing tests.** `test_complete_single_passes`; `test_missing_section_is_fixable`; `test_gap_is_needs_josh`; `test_unclear_type_is_needs_josh`; `test_unclear_work_kind_is_needs_josh`; `test_no_parent_no_area_is_needs_josh`; `test_label_with_area_counts_as_home` (parent `null`, label `pims-services` → `pass`); `test_verbatim_source_chunk_blocked` (Review Focus 3: a 40-character run copied from the made-up source text → `fixable`, problem names the ticket ref, never the text); `test_flagged_source_never_quoted`; `test_long_summary_is_fixable` (Review Focus 5: 256 characters → `fixable`); `test_summary_with_newline_is_fixable`; `test_gherkin_block_required`; `test_comment_proposal_passes_without_tickets` (`action: comment_on_match`).
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_ticket_complete.py'`. Expected: FAIL.
- [ ] **Step 3: Implement.** The verbatim rule is action-triage's PHI guard rule (`src/core/phiGuard.ts`): any run of 10 or more characters of the source's trimmed text found in a ticket field is a problem; compare after collapsing whitespace. A problem string names the ticket ref and the field, never the matched text.
- [ ] **Step 4: Run** the test command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: Jira client and Josh's format in Jira

**Files:**
- Create: `graphs/gates/lib/jira.py`, `graphs/gates/lib/adf.py`
- Test: `graphs/tests/test_gate_jira.py`

**Interfaces:**
- Produces: `class Jira(site: str, email: str, token: str, transport=None)`, where `transport(method, url, headers, body) -> (status: int, body: bytes)` is injectable for tests; methods `search(jql: str, fields: list[str]) -> list[dict]`, `get(key: str) -> dict`, `create(fields: dict, properties: dict) -> str | None` (key, or `None` when Jira did not confirm), `comment(key: str, adf: dict) -> bool`, `link(kind: str, inward: str, outward: str) -> bool`, `set_property(key: str, name: str, value) -> bool`. `Jira.from_env()` reads `JOSH360_JIRA_SITE` (default the site above), `JOSH360_JIRA_EMAIL`, `JOSH360_JIRA_TOKEN`; it fails through `gate_io.fail` when a value is missing. `adf.ticket_description(sections: dict, ticket_type: str) -> dict` and `adf.paragraphs(text: str) -> dict`.

- [ ] **Step 1: Write the failing tests.** `test_create_returns_key_on_201`; `test_create_returns_none_on_timeout` (the transport raises `TimeoutError`); `test_429_retries_with_retry_after` (at most 3 tries, `Retry-After` clamped to 1 to 30 s; a fake sleep is injected); `test_token_never_in_error_text`; `test_missing_env_fails`; `test_description_sections_in_order` (labels bold, in the `conventions/tickets.md` order, with the type's extra sections at the right place: Bug's **Current behaviour** after **Why**); `test_gherkin_is_code_block_with_language`; `test_scope_lists_are_bullets`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_jira.py'`. Expected: FAIL.
- [ ] **Step 3: Implement** over `urllib.request` with Basic auth (`email:token`), JSON in and out, and a 30 s timeout. Writes report success only on a 2xx.
- [ ] **Step 4: Run** the test command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: Writing tickets

**Files:**
- Modify: `graphs/gates/create-tickets.py`
- Test: `graphs/tests/test_gate_create_tickets.py` (fake transport recording every call)

**Interfaces:**
- Consumes: `Jira`, `adf`, `contracts.load_proposal`, `GRAPH_INPUT_MATCH_KEY`.
- Produces: outcomes `created | commented | partial`; output `ticket_keys` (parent first) and `missing` (refs not confirmed).

- [ ] **Step 1: Write the failing tests.** `test_comment_on_open_match_only` (one comment, with the spec's exact open-match text; no create); `test_single_ticket_created_and_read_back`; `test_parent_then_children_with_parent_field`; `test_epic_children_link_with_blocks`; `test_done_match_linked_with_relates`; `test_properties_written` (`action-triage.spec` `{"type": "code"}`, `josh360.authors` the proposal's `authors`); `test_never_sets_forbidden_fields` (no `priority`, `assignee`, `duedate`, `customfield_10452`/`10453`, `story_points` in any create body); `test_unconfirmed_create_found_by_search` (Review Focus 1: create returns `None`, the search finds the exact summary → `created`, one create call); `test_partial_then_retry_creates_only_missing` (Review Focus 2: child 2 fails → `partial`, `missing: ["t3"]`; a second run with the same proposal makes one create, for `t3`, with the parent set); `test_read_back_mismatch_is_partial`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_create_tickets.py'`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before each create, search for an existing ticket with the exact summary in the same space (and under the same parent for a child) created in the last day. Use it if found; this is what makes the walker's single retry safe. Issue type ids per space are read once per run from Jira's create metadata, not hard-coded.
- [ ] **Step 4: Run** the test command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: The approval card text

**Files:**
- Create: `graphs/gates/lib/card.py`
- Test: `graphs/tests/test_card.py`

**Interfaces:**
- Consumes: a proposal, its route and the duplicate candidates.
- Produces: `card.render(proposal: dict, candidates: list[dict], proposal_link: str, precedent: dict | None = None) -> str`. The walker (JP-114) shows this text as the `approve` ask's detail in the Needs you tab. `precedent` (`{"decision", "date", "category"}`) adds the stage-2 heading. Also `card.stage3_comment(decision: str, category: str) -> str`.

- [ ] **Step 1: Write the failing tests.** Three golden tests, one per card in the spec ("One ticket", "A parent with children", "An open match"), each building the made-up proposal the spec's example describes and asserting the rendered text equals the spec's block line for line, without the button row (the Needs you tab draws the buttons); `test_stage_two_heading`; `test_stage_three_comment_text`; `test_inferred_list_names_fields`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_card.py'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 8: Linking the source and the exit gate

**Files:**
- Modify: `graphs/gates/link-source.py`, `graphs/gates/intake-closed.py`; extend `graphs/gates/lib/sources.py`
- Test: `graphs/tests/test_gate_link_close.py`

**Interfaces:**
- Consumes: `sources`, `Jira.get`, `GRAPH_INPUT_TICKET_KEYS`.
- Produces: `sources.link(source: str, source_ref: str, keys: list[str]) -> None`. A to-do or action item gets `ticket:<KEY>` (first key) in `action-items.json`, under its `.lock` the way action-triage writes it; a desk thread gets the key in `desk.db`'s `threads` row; a session gets a ledger link through the ledger's link function (JP-107). `intake-closed` outcomes `pass | open`.

- [ ] **Step 1: Write the failing tests.** `test_todo_gets_ticket_key` (on a copy of a made-up `action-items.json`); `test_desk_thread_gets_key` (a temporary SQLite file with the desk's schema version 1); `test_link_is_idempotent`; `test_closed_when_all_keys_read_back_and_linked`; `test_closed_after_comment`; `test_closed_after_drop` (no keys, the run's `approve` outcome is `drop`); `test_open_when_a_key_is_missing`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_gate_link_close.py'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 9: Intake hand-off and a full run

**Files:**
- Create: `graphs/intake/submit.py`, `graphs/intake/README.md`
- Modify: the JP-110 ticket-offer hook in `hooks/` (on "yes", call `submit.py --source session`); `graphs/flows/ticket-creation.yaml` header comment (drop "stubs"); `docs/design/ticket-creation-graph.md` (add "As built")
- Test: `graphs/tests/test_ticket_creation_run.py`; proof in `docs/proof/YYYY-MM-DD/JP-121/`

**Interfaces:**
- Consumes: the walker's start command and run folder (JP-114); every gate above.
- Produces: `python3 graphs/intake/submit.py --source email|todo|session|manual --ref <pointer> [--space KEY] [--parent KEY]`. It starts one `ticket-creation` run through the walker with those inputs and prints the run id. It never passes the input's text.

- [ ] **Step 1: Write the failing tests.** A full walk with the real walker, the real gate scripts, a fake Jira transport (`JOSH360_JIRA_FAKE=<fixture dir>`, honoured only when set) and canned role outputs from fixtures (the binding is not called). Tests: `test_light_todo_to_one_ticket` (spec scenario "A light request becomes one ticket"); `test_nothing_written_before_approval`; `test_open_duplicate_gets_comment`; `test_finished_duplicate_gets_linked_ticket`; `test_no_rule_matches_asks_for_home`; `test_same_item_not_filed_twice`; `test_created_tickets_not_ready`; `test_authors_recorded`; `test_draft_runs_capped_at_three` (the fourth draft run goes to `stuck`).
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p 'test_ticket_creation_run.py'`. Expected: FAIL.
- [ ] **Step 3: Implement** `submit.py`, and wire the JP-110 hook.
- [ ] **Step 4: Run** the full suite, `python3 scripts/check.py`. Expected: `check.py: ok`. Save the output, and one walked run's ledger rows, under `docs/proof/YYYY-MM-DD/JP-121/`.
- [ ] **Step 5: @e2e on the laptop.** After merge, run one made-up to-do through `submit.py` against JP with Josh approving the card. Confirm the ticket in Jira, then cancel it. Record the key and the cancel in the proof. This is the one step that must run on the laptop; JP-121 names it.
- [ ] **Step 6: Commit** one file at a time.

### Task 10: action-triage hand-offs (waits for the phase close)

**Files (in `Eventus-Whole-Health/action-triage`, one PR that waits for the phase close):**
- Modify: `desk/desk_watcher.py` (hand a new email to `submit.py --source email --ref <thread id>` instead of filing a ticket), the quick capture save path (`--source todo`), and `ticket create` (`--source manual`, kept as the fallback when josh-360 is missing).

**Interfaces:**
- Consumes: `graphs/intake/submit.py` at `~/.josh-360/repo/graphs/intake/submit.py` (JP-105's laptop copy).

- [ ] **Step 1: Write the failing tests** in action-triage's vitest suite (`npm test`): the watcher calls `submit.py` with `--source email` and the thread id, and never with the email text; quick capture calls it with `--source todo`; when `submit.py` is missing, both fall back to the current path and log one line.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit, push, and open the PR in draft**, with "waits for the phase 2 close" as its blocker. Its merge needs the passphrase under Josh's global rules.
