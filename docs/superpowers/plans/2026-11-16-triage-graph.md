# Triage and Sign-off Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Contents

- [Global Constraints](#global-constraints)
- [Review Focus](#review-focus)
- [File map](#file-map)
- [Task 0: Prerequisites and fixtures](#task-0-prerequisites-and-fixtures)
- [Task 1: Jira client](#task-1-jira-client)
- [Task 2: Ticket model and section parser](#task-2-ticket-model-and-section-parser)
- [Task 3: Gherkin reader](#task-3-gherkin-reader)
- [Task 4: The Ready checklist](#task-4-the-ready-checklist)
- [Task 5: Route](#task-5-route)
- [Task 6: Sign-off filter](#task-6-sign-off-filter)
- [Task 7: Verdict and the return budget](#task-7-verdict-and-the-return-budget)
- [Task 8: Read-only gate scripts](#task-8-read-only-gate-scripts)
- [Task 9: Writing gate scripts](#task-9-writing-gate-scripts)
- [Task 10: The graph and its parts, final](#task-10-the-graph-and-its-parts-final)
- [Task 11: End-to-end proof](#task-11-end-to-end-proof)

**Goal:** Build every gate of the triage graph (JP-122) so the walker can carry a drafted ticket to Ready with one route, or send it back, exactly as the approved spec says.

**Architecture:** The judgment-free logic (checklist, route, defect filter, verdict) lives in pure functions in `graphs/gates/lib/triage/`, tested against made-up tickets. Each gate script in `graphs/gates/` is a thin shell: it reads `GRAPH_INPUT_<NAME>` variables, calls Jira through one small client, calls the pure functions, and prints one JSON line. Only `apply-revision`, `send-back` and `mark-ready` write to Jira.

**Tech Stack:** Python 3.9, standard library only (gates run on the laptop); stdlib `unittest`; Jira Cloud REST API v2 (wiki markup descriptions).

**Spec:** `docs/superpowers/specs/2026-11-16-triage-graph-design.md` (approved by Josh, 16 November 2026). No boards: there is no screen. Draft graph: `graphs/flows/triage.yaml`.

## Global Constraints

- Gate scripts and `graphs/gates/lib/` use Python 3.9 and the standard library only. `scripts/check.py` already parses laptop code as 3.9; add `graphs/gates/` to that check in Task 10.
- Gate contract (`graphs/CONVENTION.md`, "Gate scripts"): inputs from `GRAPH_INPUT_<NAME>`; print exactly one JSON line `{"outcome": …, "outputs": {…}, "summary": "…"}`; the outcome is one the step declares.
- An unknown read (Jira down, a field missing, a malformed body) is never read as "empty" or "pass". The gate exits non-zero with the reason on stderr, which stops the run (spec, "How every loop ends", rule: a failing gate is not retried).
- Every Jira write is read back; a write counts only when the read-back confirms it.
- No priority, rank or `conventions/priorities.yaml` value is read, output or written by any triage gate (spec rule 8). `scripts/conventions.py lookup` output is stripped of `priority` before use.
- No patient data in any output, summary, comment, record or test fixture. A patient-data failure names the item and section only.
- Comments start `Triage: ` and use the exact copy in the spec's "Exact copy" section, in the `result | evidence | next gate` shape.
- Jira site `https://eventuswh-analytics.atlassian.net`; credentials from `JOSH360_JIRA_EMAIL` and `JOSH360_JIRA_TOKEN` (never logged, never put in an error message).
- Allowed accounts: `JOSH360_JIRA_ALLOWED_ACCOUNTS` (comma-separated accountIds), else the account `GET /rest/api/2/myself` returns. Empty list admits nothing.
- Issue properties: `josh360.authors` (list of session ids), `josh360.route` (contract `graphs/contracts/route-record.md`).
- Loop limits and tier caps are the walker's job (JP-114, JP-139). Gates never count loops, except the return budget in Task 7, which lives on the ticket because it spans runs.

## Review Focus

1. **Descriptions the parser does not expect** (a table, a panel, a heading instead of a bold label, CRLF line ends, a label with no colon). Expected: the section is reported missing or empty (C2 or C3), never a crash and never a silent pass. Test in Task 2.
2. **Quotes that differ only in spacing, case or typographic quotes** (`“ ”` against `" "`, non-breaking spaces). Expected: still a verbatim match after folding, so a real defect is not dropped. Test in Task 6.
3. **A Jira read that fails half way** (issue read, changelog read fails). Expected: the gate exits non-zero and nothing is written. Test in Task 8.
4. **A ticket edited between sign-off and `mark-ready`.** Expected: outcome `changed`, no status move, no route record. Test in Task 9.
5. **A Scenario Outline with Examples, or `Background:` steps.** Expected: Background Givens count toward every scenario, and an Outline counts as one scenario. Test in Task 3.

## File map

| File | Responsibility |
| --- | --- |
| `graphs/gates/lib/__init__.py`, `graphs/gates/lib/triage/__init__.py` | Packages (the checker ignores the `lib/` folder) |
| `graphs/gates/lib/jira_rest.py` | Jira REST v2 client: reads return `None` on failure, writes return `bool` after read-back |
| `graphs/gates/lib/gate_io.py` | Reading `GRAPH_INPUT_*`, printing the one JSON line, failing with exit 2 |
| `graphs/gates/lib/triage/ticket.py` | `Ticket`, section parsing, version hash |
| `graphs/gates/lib/triage/gherkin.py` | Finding and reading the Gherkin block |
| `graphs/gates/lib/triage/checklist.py` | `CHECKLIST` data and `run_checklist` (imported by JP-102's `ticket-complete`) |
| `graphs/gates/lib/triage/route.py` | The routing table |
| `graphs/gates/lib/triage/signoff.py` | The defect filter and the author check |
| `graphs/gates/lib/triage/verdict.py` | Combining results, numbering gaps, the return budget |
| `graphs/gates/lib/triage/copy.py` | Every comment string in the spec's "Exact copy" |
| `graphs/gates/<gate>.py` | One per gate in the graph; replaces the stubs |
| `graphs/tests/test_triage_*.py` | One test file per lib module and one for the gate scripts |
| `graphs/tests/fixtures/triage/` | Made-up tickets as Jira v2 JSON, plus one real JP-103 shape capture |

---

### Task 0: Prerequisites and fixtures

**Files:**
- Create: `graphs/tests/fixtures/triage/jp-103-shape.json`, `graphs/tests/fixtures/triage/README.md`

- [ ] **Step 1: Confirm the parts this build stands on are on `main`.** Each must exist; if one does not, stop and tell the coordinator which, because the plan is then wrong:
  - JP-114 walker: how it runs a gate (environment, working folder) and how a run records `returns`-free state.
  - JP-102/JP-121: `graphs/roles/ticket-drafter/` and `graphs/contracts/ticket-proposal.md` with an `action: revise` proposal whose single ticket carries `key`. If `revise` is missing, ask the coordinator for it before Task 9.
  - `graphs/gates/lib/patient_data.py` (on `main` since JP-149): `scan(text, source_text, flagged, external=False)` returns the kinds of rule it matched. Ticket text goes to Jira, so C13 calls it with `external=True`.
  - JP-139 (`max_runs` in `graphs/tiers.yaml`) and JP-140 (`graph_version`, `model`, end-state header field).
- [ ] **Step 2: Capture the shape of a real ticket.** `GET /rest/api/2/issue/JP-103?fields=summary,description,issuetype,labels,issuelinks,creator,customfield_10021` and save it, then replace every text value except the bold section labels and the `{code:gherkin}` markers with made-up words. Note in the README which fields were kept and that it holds no patient data.
- [ ] **Step 3: Find JP's Agent Status field id** (`GET /rest/api/2/field`, the field named `Agent Status`) and put it in `graphs/gates/lib/triage/__init__.py` as `AGENT_STATUS_FIELD`, with the README noting where it came from. `triageable` reads the changelog for that field.
- [ ] **Step 4: Commit** `graphs/tests/fixtures/triage/`.

### Task 1: Jira client

**Files:**
- Create: `graphs/gates/lib/jira_rest.py` (`graphs/gates/lib/__init__.py` exists, JP-149), `graphs/gates/lib/gate_io.py`
- Test: `graphs/tests/test_triage_jira.py`

**Interfaces:**
- Produces: `JiraClient(site: str, email: str, token: str, opener=urllib.request.urlopen)` with `get_issue(key) -> dict | None`, `get_changelog(key) -> list[dict] | None` (all pages), `get_property(key, name) -> dict | None` (`{}` when absent, `None` on failure), `set_property(key, name, value) -> bool`, `add_comment(key, body) -> bool`, `update_description(key, wiki) -> bool`, `transition_to(key, status) -> bool`, `myself() -> str | None`; `client_from_env() -> JiraClient` (raises `GateError` if a variable is missing). `gate_io.inputs() -> dict[str, str]`, `gate_io.emit(outcome, outputs=None, summary="")`, `gate_io.fail(reason)` (stderr, exit 2), `class GateError(Exception)`. **GitHub and Jira are the firm guard (JP-149):** every method that writes text to Jira runs `patient_data.scan(text, None, False, external=True)` (`graphs/gates/lib/patient_data.py`, on `main`) on that text first and refuses the write on any problem, naming the kind, never the text; a test writes made-up `MRN 1234` and expects the refusal with no request sent.

- [ ] **Step 1: Write the failing tests** with a fake `opener`: `test_read_failure_is_none` (HTTP 500 → `None`), `test_missing_property_is_empty` (404 on a property → `{}`), `test_write_counts_only_after_read_back` (PUT ok, read-back differs → `False`), `test_token_never_in_error` (an exception's text never contains the token), `test_changelog_reads_every_page`.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_triage_jira` — expect import errors.
- [ ] **Step 3: Implement** with `urllib.request`, Basic auth, 10 s timeout, one retry on 429 honouring `Retry-After` (clamped 1–30 s). `transition_to` looks up the transition id by target status name from `GET …/transitions`.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit.**

### Task 2: Ticket model and section parser

**Files:**
- Create: `graphs/gates/lib/triage/__init__.py`, `graphs/gates/lib/triage/ticket.py`
- Test: `graphs/tests/test_triage_ticket.py`

**Interfaces:**
- Produces: `@dataclass Ticket(key, type, summary, description, sections: list[tuple[str, str]], labels: list[str], links: list[str], parent: str | None, flagged: bool, creator: str | None, subtasks: list["Ticket"])`; `Ticket.section(name) -> str | None`; `ticket_from_issue(issue: dict) -> Ticket`; `parse_sections(wiki: str) -> list[tuple[str, str]]`; `ticket_version(t: Ticket) -> str` (sha256 hex of summary, description, type, sorted labels and sorted link keys, joined by `\n\x1f`).

- [ ] **Step 1: Write the failing tests:** `test_sections_in_order` (the JP-103 shape fixture gives the ten labels in order), `test_label_forms` (`*Goal:*`, `*Goal*:` and `**Goal:**` all start the Goal section), `test_unexpected_markup_is_missing_not_crash` (Review Focus 1: a table and an `h2.` heading leave no section, no exception), `test_crlf`, `test_version_changes_on_any_field` and `test_version_ignores_label_order`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** A section starts at a line whose start is a bold label ending in a colon; it runs to the next such line. Code blocks (`{code…}` … `{code}`) are kept inside their section.
- [ ] **Step 4: Run** — expect PASS. **Step 5: Commit.**

### Task 3: Gherkin reader

**Files:**
- Create: `graphs/gates/lib/triage/gherkin.py`
- Test: `graphs/tests/test_triage_gherkin.py`

**Interfaces:**
- Produces: `find_gherkin_blocks(section: str) -> list[str]` (the bodies of `{code:gherkin}` and fenced ```` ```gherkin ```` blocks); `@dataclass Scenario(name, tags: list[str], givens: int, whens: int, thens: int)`; `read_feature(block: str) -> tuple[bool, list[Scenario]]` (has a `Feature:` line, the scenarios). `And`/`But` count as the keyword before them; `Background:` Givens are added to every scenario; `Scenario Outline:` is one scenario; tags are the `@words` on the lines just above a scenario.

- [ ] **Step 1: Write the failing tests:** `test_and_but_continue`, `test_background_counts` and `test_outline_is_one_scenario` (Review Focus 5), `test_tags_above_scenario`, `test_no_feature_line`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 4: The Ready checklist

**Files:**
- Create: `graphs/gates/lib/triage/checklist.py`
- Modify: `graphs/contracts/ready-checklist.md` (say the list in `checklist.py` is now the source)
- Test: `graphs/tests/test_triage_checklist.py`

**Interfaces:**
- Consumes: `Ticket` (Task 2), `find_gherkin_blocks`, `read_feature` (Task 3), `patient_data` (on `main`, JP-149).
- Produces: `CHECKLIST: list[dict]` (`id`, `types`, `text`) holding C1–C13, B1, B2, S1, R1, R2 with the spec's wording; `@dataclass Failure(item, where, found, needed)`; `run_checklist(t: Ticket, repo_known: Callable[[str], bool], send_back_after_edit: bool) -> list[Failure]`. `found` is cut to 200 characters, and is `missing` for C13.

- [ ] **Step 1: Write the failing tests**, one per item, each on a made-up ticket built from one passing base ticket per type with a single change: C1 (Epic), C2 (Why missing; sections out of order), C3 (`TBD`; `None` allowed for Not in scope), C4 (two Gherkin blocks), C5 (two Whens; no Then; zero Whens passes), C6 (no tag; two tags), C7 (unknown repository; `none` on a Story), C8 (label `security`), C9 (`Josh's laptop` with no reason), C10 (parent in another space), C11 (subtask with no Done when), C12 (Why ending in `?`; Flagged on; `send_back_after_edit` true), C13 (patient-data rule matched; `found` is `missing`), B1, B2, S1, R1, and **`test_research_keeps_open_questions`** (R2: an Open questions section on a Research ticket gives no C12 failure, from the ticket's own acceptance criteria).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `run_checklist`. Required sections and their order come from `conventions/tickets.md` "Required sections", hard-coded in `checklist.py` with a comment naming that file. C12 skips text inside Gherkin blocks and inside straight or typographic quotes.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 5: Route

**Files:**
- Create: `graphs/gates/lib/triage/route.py`
- Test: `graphs/tests/test_triage_route.py`

**Interfaces:**
- Produces: `route_for(ticket_type: str, repository: str, work_kind: str | None) -> str` returning `development`, `non_development` or `conflict`.

- [ ] **Step 1: Write the failing tests:** one per row of the spec's routing table (Bug, Story, Task with a repository → `development`; Task `none` → `non_development`; Research with a repository → `development`; Research `none` → `non_development`), `test_code_without_repository_is_conflict`, `test_code_routed_non_development_is_conflict`, `test_doc_with_repository_is_development`, `test_story_none_is_conflict`, and `test_every_ready_ticket_has_one_route` (all type × repository × work kind combinations give exactly one of the three values).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** as a lookup table. **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 6: Sign-off filter

**Files:**
- Create: `graphs/gates/lib/triage/signoff.py`
- Test: `graphs/tests/test_triage_signoff.py`

**Interfaces:**
- Produces: `fold(text: str) -> str` (lower case, typographic quotes to straight, every run of whitespace including non-breaking spaces to one space); `filter_defects(defects: list[dict], ticket_text: str) -> tuple[list[dict], list[dict]]` (kept, dropped with a `reason`); `signer_is_author(signer: str, authors: list[str]) -> bool`.

- [ ] **Step 1: Write the failing tests:** `test_quote_must_appear` (dropped, reason `quote not in ticket`), `test_item_must_be_j1_to_j5` (J6 dropped), `test_empty_problem_or_needed_dropped`, `test_quote_folding` (Review Focus 2: `“Goal”` matches `"goal"`, a non-breaking space matches a space), `test_signer_is_author`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 7: Verdict and the return budget

**Files:**
- Create: `graphs/gates/lib/triage/verdict.py`
- Test: `graphs/tests/test_triage_verdict.py`

**Interfaces:**
- Consumes: `Failure` (Task 4), kept defects (Task 6).
- Produces: `decide(author_kind: str, failures: list[dict], route: str | None, kept: list[dict] | None, returns: int) -> tuple[str, list[dict]]` returning an outcome of `ready`, `revise`, `comment` or `escalate` and the numbered gaps (failures first, then defects, each with `n`); `RETURN_BUDGET = 2`.

- [ ] **Step 1: Write the failing tests:** `test_ready_needs_everything` (no failures, a route, kept empty), `test_route_conflict_is_a_gap`, `test_own_with_gaps_revises`, `test_other_with_gaps_comments`, `test_third_return_escalates` (`returns == 3`, own ticket → `escalate`), `test_other_never_escalates` (`returns == 3`, someone else's ticket → `comment`), `test_numbering_failures_first`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 8: Read-only gate scripts

**Files:**
- Modify (replace the stubs): `graphs/gates/triageable.py`, `ticket-facts.py`, `ready-check.py`, `route.py`, `check-sign-off.py`, `triage-verdict.py`, `ready.py`
- Test: `graphs/tests/test_triage_gates.py`

**Interfaces:**
- Consumes: Tasks 1 to 7. Every script: `client_from_env()`, `inputs()`, then the pure function, then `emit`. The tests run each script with `subprocess` and point `JOSH360_JIRA_SITE` at a local `http.server` fake that serves fixtures.
- Produces (outputs exactly as declared in `graphs/flows/triage.yaml`): `ticket-facts` → `ticket_type`, `author_kind` (`own`/`other`), `authors`, `version`; `ready-check` → `failures`; `route` → `graph`, `system`, `space`; `check-sign-off` → `kept`, outcome `invalid` when `signer_is_author` or the version moved; `triage-verdict` → `gaps`, reading `returns` from `josh360.route`; `triageable` → `pass`/`refuse`; `ready` → `pass` when the status is Ready, `josh360.route.graph` equals `GRAPH_INPUT_GRAPH` and the version is unchanged.

- [ ] **Step 1: Write the failing tests:** for each script one passing and one refusing case, plus `test_unqueued_other_ticket_refused` (the spec's "nobody queued" scenario), `test_queued_by_allowed_account_admitted`, `test_epic_refused`, `test_half_read_exits_nonzero` (Review Focus 3: changelog 500 → exit 2, no output line), `test_priority_never_output` (no gate's output contains `priority`), and `test_ready_gate_refuses_edited_ticket`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** each script in under 60 lines. **Step 4: Run** — PASS. **Step 5: Commit** each script with its tests.

### Task 9: Writing gate scripts

**Files:**
- Create: `graphs/gates/lib/triage/copy.py`
- Modify (replace the stubs): `graphs/gates/apply-revision.py`, `send-back.py`, `mark-ready.py`
- Test: `graphs/tests/test_triage_write_gates.py`

**Interfaces:**
- Consumes: the `ticket-proposal` contract with `action: revise` (Task 0); `JiraClient` writes.
- Produces: `copy.ready(run, session, graph, system, starts_now) -> str`, `copy.round(n, run, closed, sections) -> str`, `copy.send_back(run, gaps) -> str`, `copy.question(run, question, recommendation, reason) -> str`, each matching the spec's "Exact copy" character for character. `apply-revision` → `applied` or `changed` (version moved since the drafter read it), writes the sections in place, appends the drafter session to `josh360.authors`, comments. `send-back` → `sent`, comment only. `mark-ready` → `moved` or `changed`; on `moved` writes `josh360.route` (graph, system, space, version, run, signed_by, returns, returned_from) before the transition, then comments.

- [ ] **Step 1: Write the failing tests:** `test_copy_matches_spec` (each string against the spec text, read from the spec file so they cannot drift), `test_send_back_never_edits` (no PUT to the issue), `test_mark_ready_changed_moves_nothing` (Review Focus 4), `test_mark_ready_writes_route_then_moves`, `test_route_record_has_no_priority`, `test_apply_revision_adds_author`, `test_failed_read_back_is_failure` (exit 2).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** each script with its tests.

### Task 10: The graph and its parts, final

**Files:**
- Modify: `graphs/flows/triage.yaml` (remove the DRAFT comment; `end_states` and the `graph_version` and `model` ledger fields are already there, so check they still match the steps), `graphs/flows/README.md` (state: built), `graphs/roles/ticket-drafter/` and `graphs/contracts/ticket-proposal.md` (take JP-102's versions from `main`; delete the placeholders), `scripts/check.py` (parse `graphs/gates/**/*.py` as Python 3.9), the spec (add "As built" listing anything that differs)
- Test: `python3 graphs/tools/check_graph.py`, `python3 scripts/check.py`

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2: Run** `python3 graphs/tools/check_graph.py` — expect `check_graph: ok`. It must also pass JP-139's cap check: `sign_off` and `revise` are `mid`, and no single loop reruns them more than twice.
- [ ] **Step 3: Run** `python3 scripts/check.py` — expect `check.py: ok (0 problem(s))`.
- [ ] **Step 4: Commit.**

### Task 11: End-to-end proof

**Files:**
- Create: `docs/proof/YYYY-MM-DD/JP-122/` (the run's output and ledger rows)

- [ ] **Step 1:** With the walker and its Agent Manager binding (JP-114, JP-117), run triage on two made-up JP tickets labelled `josh-360`: one complete Story (expect Ready, route `development`), one Story missing its test tags (expect one drafter round, then Ready). Cancel both tickets afterwards (cancel, never delete).
- [ ] **Step 2:** Save the walker output, the ticket comments and the ledger rows (all nine header fields plus `graph_version` and `model`) under the proof folder, with no patient data.
- [ ] **Step 3:** Map every Gherkin scenario in the spec to its test or proof file in the PR body, then follow the review ceremony.
