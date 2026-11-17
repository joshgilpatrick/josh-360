# Non-development graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Contents

- [Global Constraints](#global-constraints)
- [Review Focus](#review-focus)
- [Task 1: Shared gate plumbing](#task-1-shared-gate-plumbing)
- [Task 2: read-ticket and gap-check](#task-2-read-ticket-and-gap-check)
- [Task 3: check-deliverable, pick-path and check-review](#task-3-check-deliverable-pick-path-and-check-review)
- [Task 4: Ticket moves: move-ticket, return-to-triage, close-ticket](#task-4-ticket-moves-move-ticket-return-to-triage-close-ticket)
- [Task 5: deliver, sign-off-rule and share](#task-5-deliver-sign-off-rule-and-share)
- [Task 6: Status rule, draft markers and the proof run](#task-6-status-rule-draft-markers-and-the-proof-run)
- [Task 7: Point the Email Research Desk at the graph](#task-7-point-the-email-research-desk-at-the-graph)

**Goal:** Turn the approved draft into the real non-development graph: working gate scripts behind `graphs/flows/non-development.yaml`, so a Ready non-development JP ticket ends in a saved deliverable with sources, signed off by Josh or (for an emailed ask) closed on delivery.

**Architecture:** The graph file, roles, agents and contracts already exist (JP-104). This plan replaces the eleven refusing gate stubs it owns with real scripts. Each gate is a thin script exposing `run(inputs, deps) -> dict`. Jira, the file system and the desk mailer reach it through injected `deps`, so every gate is tested in the cloud with fakes. The laptop supplies real `deps`.

**Tech Stack:** Python 3.9, standard library only (gates run on the laptop's `/usr/bin/python3`). Tests use stdlib `unittest` under `graphs/tests/`, run by `python3 scripts/check.py`.

**Spec:** `docs/design/non-development-graph.md` (approved by Josh, 16 November 2026). Ticket: JP-123 (phase 1 since 16 November 2026, JP-147). Built on the JP-104 branch's draft.

## Global Constraints

- Every gate reads `GRAPH_INPUT_<NAME>` and prints exactly one JSON line `{"outcome": ..., "outputs": {...}, "summary": "..."}`; `outcome` is one the step declares in the graph file (`graphs/CONVENTION.md`, "Gate scripts").
- Python 3.9, standard library only, for every file under `graphs/gates/`.
- Only gate scripts move tickets or set labels. No role writes Jira except comments on its own ticket.
- The graph works JP tickets only. JP transition ids: Not Started `3`, In Progress `21`, Validation `2`, Done `4` (`.claude/workflow.config.md`).
- Deliverables, evidence and saved queries live in `~/Development/active/.artifacts/<system>/`, flat, every file name starting with the ticket key; `<system>` is `josh-projects` when the input is `none`.
- When `phi` is true, nothing written to Jira, email or the ledger quotes content: the copy says `withheld: patient data` and gives paths only. `phi` defaults to true.
- Nothing is ever sent to anyone but Josh. `share` makes an Outlook draft in Josh's mailbox, never a sent email, and refuses when `phi` is true.
- Exact copy comes from the spec's "Exact copy" section, word for word, including the `result | evidence | next gate` comment shape and the `Resolution:` prefix.
- A gate that cannot complete (a failed Jira write, a mailer error) exits non-zero with its error on stderr. It is never retried by the walker (spec rule 19).
- Read every Jira write back (`conventions/tickets.md`, "Writing to Jira").
- Gates owned elsewhere are not built here: `ready` (JP-122) and `no-loose-ends` (JP-109). If `move-ticket` or `return-to-triage` already exist as real scripts when this starts (JP-121 or JP-122 may land first), use them and skip their part of Task 4.
- No patient data in tests, fixtures, commits or proof. Tests use made-up tickets (`JP-9001`) and made-up rows.

## Review Focus

1. **A path that only looks safe.** A deliverable path with `..`, a symlink into a repository, or `~` not expanded must fail `check-deliverable`. Test in Task 3.
2. **A finding that quotes the ticket loosely.** Whitespace or line breaks differ between the finding's quote and the ticket text: it must still count as a quote. Text the ticket does not contain must be dropped. Test in Task 3.
3. **Patient-data leaks through the summary.** With `phi: true` and a non-empty `summary` in the evidence file (the researcher ignored the rule), `deliver` and `close-ticket` must still post `withheld: patient data`. Test in Task 5 and Task 4.
4. **A double send.** `deliver` re-run after a crash must not email Josh twice. The desk mailer's exit `4` (already sent) counts as success, and any other non-zero exit stops the run. Test in Task 5.
5. **A ticket with no route record or the wrong space.** An AD key, a missing `josh360.route` property, or a route naming `development` must give `not_here`, never `workable`. Test in Task 2.

---

### Task 1: Shared gate plumbing

**Files:**
- Create: `graphs/gates/lib/__init__.py` (empty), `graphs/gates/lib/gate_io.py`, `graphs/gates/lib/jira.py`, `graphs/gates/lib/evidence.py`
- Test: `graphs/tests/test_gate_lib.py`

**Interfaces:**
- Produces:
  - `gate_io.read_inputs(environ: Mapping[str, str], names: list[str]) -> dict[str, str]` returns the `GRAPH_INPUT_<NAME>` values. A missing name raises `GateError`.
  - `gate_io.emit(outcome: str, outputs: dict | None = None, summary: str = "") -> str` prints and returns one JSON line.
  - `gate_io.main(run, names, environ=os.environ, deps=None) -> int` reads the inputs, calls `run(inputs, deps)`, which returns `{"outcome", "outputs"?, "summary"?}`, emits the result and returns 0. A `GateError` prints to stderr and returns 1.
  - `jira.JiraClient(site, email, token, transport=urllib_transport)` with `get_issue(key) -> dict` (fields `status`, `summary`, `description` as plain text, `properties`), `comments(key) -> list[dict]` (`author`, `body`, `created`), `add_comment(key, body) -> str` (returns the id after reading it back), `transition(key, transition_id) -> str` (returns the status read back). `transport(method, url, headers, body) -> (status, dict)` is the injection point.
  - `jira.from_env(environ) -> JiraClient` reads `ACTION_AGENT_JIRA_SITE` (default `https://eventuswh-analytics.atlassian.net`), `ACTION_AGENT_JIRA_EMAIL` and `ACTION_TRIAGE_JIRA_TOKEN`, as action-triage does.
  - `evidence.load(path: Path) -> dict` parses the YAML-like front block of the evidence contract (`graphs/contracts/evidence.md`) with a stdlib parser for that block's flat keys and list of mappings. It raises `GateError` on a missing block.
  - `gate_io.GateError(Exception)`.

If JP-121 or JP-122 has already added `graphs/gates/lib/` with equivalents, use theirs and adapt the names in later tasks instead of duplicating.

- [ ] **Step 1: Write the failing tests**: `test_read_inputs_missing_name_raises`, `test_emit_prints_one_json_line`, `test_main_returns_1_on_gate_error`, `test_jira_transition_reads_back_status` (fake transport records calls; asserts a GET follows the POST), `test_evidence_load_reads_sources_list` (fixture in a temp dir: two sources, `phi: true`, empty `summary`).
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_gate_lib -v` from the repo root. Expected: FAIL (import error).
- [ ] **Step 3: Implement** the three modules to the signatures above.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `python3 scripts/check.py`. Expected: `check.py: ok`.
- [ ] **Step 5: Commit** `JP-123: Add the shared gate plumbing (inputs, JSON line, Jira, evidence)`.

### Task 2: read-ticket and gap-check

**Files:**
- Modify: `graphs/gates/read-ticket.py`, `graphs/gates/gap-check.py` (replace the stubs)
- Test: `graphs/tests/test_nondev_intake_gates.py`

**Interfaces:**
- Consumes: Task 1 (`gate_io.main`, `JiraClient.get_issue`).
- Produces: `read-ticket` outputs `search_terms` (list of strings) and `deliverable_given` (bool). `gap-check` outputs `gap` (string).

Rules (spec, "The run, step by step" and "When it asks Josh"):
- `read-ticket` is `workable` only when all of these hold: the key starts with `JP-`; the status is `Ready`; the description has non-empty **Question:**, **Sources:** and **Deliverable format:** sections; the `josh360.route` property's `graph` is `non-development`. Anything else, or any failed read, is `not_here`.
- `search_terms` are the Question's words of four or more letters, lower-cased and deduplicated, plus the registry `description` words of the input `system` when it is listed (`conventions/registry.yaml`).
- `deliverable_given` is false when the Deliverable format section contains `(inferred)`. Before building, check JP-102's `graphs/contracts/ticket-proposal.md`: if it names a different marker, use that one and record the choice in `docs/decisions.md`.
- `gap-check` gives `gap` only when `precedent` is missing or `none` AND `deliverable_given` is false. Its `gap` output is the spec's `ping_before` copy, filled in from the ticket.

- [ ] **Step 1: Write the failing tests**: `test_workable_ticket`, `test_ad_key_is_not_here`, `test_missing_route_is_not_here`, `test_route_development_is_not_here`, `test_empty_deliverable_section_is_not_here`, `test_jira_read_failure_is_not_here`, `test_inferred_marker_sets_deliverable_given_false`, `test_gap_only_without_precedent_and_inferred` (four cases), and `test_gap_text_matches_spec_copy`, which asserts the exact string `JP-9001: before I start. Question: ... I'll deliver ..., assuming .... Is that right? One sentence is enough, or reply "go".` with the fixture's values.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_nondev_intake_gates -v`. Expected: FAIL.
- [ ] **Step 3: Implement** both gates as `run(inputs, deps)` plus `if __name__ == "__main__": sys.exit(gate_io.main(run, [...]))`. `deps` carries `jira` and `registry_path`. Load the scripts in tests with `importlib.util.spec_from_file_location`, because their names have hyphens.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit** `JP-123: Build read-ticket and gap-check`.

### Task 3: check-deliverable, pick-path and check-review

**Files:**
- Modify: `graphs/gates/check-deliverable.py`, `graphs/gates/pick-path.py`, `graphs/gates/check-review.py`
- Test: `graphs/tests/test_nondev_check_gates.py`

**Interfaces:**
- Consumes: Task 1 (`evidence.load`, `JiraClient.get_issue`, `JiraClient.comments`).
- Produces: `check-review` writes the kept findings beside the evidence file as `<KEY>-feedback.md` (contract `graphs/contracts/feedback.md`) and outputs nothing else.

Rules:
- `check-deliverable` is `complete` only when all of these hold: both paths resolve (symlinks followed, `~` expanded) to files directly inside `~/Development/active/.artifacts/<name>/`; no ancestor of the resolved path holds a `.git` entry or is a `.claude/worktrees` folder; both file names start with the ticket key; the evidence has at least one source; and every `query` source's `ref` is an existing file in the same folder. `deps.artifacts_root` replaces the real folder in tests.
- `pick-path` is `short` when (`precedent` is not `none`, or `kind` is `misc`) and the ticket has no earlier comment starting `Deliverable ready |` or `Resolution:`. Such a comment means a revision or a reopen, which is always `full`.
- `check-review` keeps a finding only when its `quote`, with whitespace collapsed, is a substring of the ticket's Question or Deliverable format with whitespace collapsed. `clean` when none is kept; otherwise `rework`.

- [ ] **Step 1: Write the failing tests**: `test_complete_deliverable`, `test_dotdot_path_is_incomplete`, `test_symlink_into_repo_is_incomplete` (temp dir with a `.git` folder), `test_worktree_path_is_incomplete`, `test_key_prefix_required`, `test_no_sources_is_incomplete`, `test_missing_query_file_is_incomplete`, `test_short_for_precedent`, `test_short_for_misc`, `test_full_after_earlier_delivery_comment`, `test_full_after_reopen_resolution_comment`, `test_finding_kept_across_line_breaks`, `test_unquoted_finding_dropped`, `test_feedback_file_written`.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_nondev_check_gates -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the three gates as in Task 2.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit** `JP-123: Build check-deliverable, pick-path and check-review`.

### Task 4: Ticket moves: move-ticket, return-to-triage, close-ticket

**Files:**
- Modify: `graphs/gates/move-ticket.py` and `graphs/gates/return-to-triage.py` (only if still stubs; see Global Constraints), `graphs/gates/close-ticket.py`
- Test: `graphs/tests/test_nondev_ticket_gates.py`

**Interfaces:**
- Consumes: Task 1 (`JiraClient.transition`, `add_comment`, `evidence.load`).
- Produces: `move-ticket` reads its target status from `GRAPH_INPUT_TARGET_STATUS`, which the walker sets from the step's stretch in the graph header. Agree this name with JP-114 (the walker) before building, and record it in `graphs/CONVENTION.md`, "Gate scripts", in the same PR.

Rules:
- `move-ticket` maps the status name to the JP transition id from Global Constraints, transitions, and reads back. A read-back that differs is an error (exit 1).
- `return-to-triage` transitions to Not Started (`3`), comments the reason as an open question (`Returned to triage | <reason> | next gate: triage`), and sets the flag (`customfield_10021` = `Impediment`). It counts nothing; triage counts returns (spec rule 17).
- `close-ticket` posts the spec's resolution copy (`Resolution: <question> | <answer> | sources: <refs> | deliverable: <path> | next gate: none`). When `phi` is true, the question and answer read `withheld: patient data`, whatever the evidence holds. It then transitions to Done (`4`).

- [ ] **Step 1: Write the failing tests**: `test_move_ticket_maps_and_reads_back`, `test_move_ticket_readback_mismatch_fails`, `test_return_comments_and_flags`, `test_close_posts_resolution_shape`, `test_close_withholds_when_phi_even_if_summary_filled`, `test_close_transition_failure_exits_1`.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_nondev_ticket_gates -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the gates.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit** `JP-123: Build the ticket-moving gates`.

### Task 5: deliver, sign-off-rule and share

**Files:**
- Modify: `graphs/gates/deliver.py`, `graphs/gates/sign-off-rule.py`, `graphs/gates/share.py`
- Test: `graphs/tests/test_nondev_delivery_gates.py`

**Interfaces:**
- Consumes: Task 1. `deps.mailer(argv: list[str]) -> int` runs the desk mailer and returns its exit code. In production: `/usr/bin/python3 <DESK_BIN>/desk_mailer.py reply --row <desk_row> --body-file <path> --kind answer`, with `DESK_BIN` defaulting to `~/.local/share/agent-services-desk/bin`, and the body file written to `~/Library/Application Support/agent-services-desk/outbox/<KEY>-<UTC timestamp>.md` (desk README and the desk-worker skill). `deps.draft_email(to: str, subject: str, body_path: Path) -> None` makes an Outlook draft in Josh's mailbox.
- Produces: nothing new.

Rules:
- `deliver` posts `Deliverable ready | <summary> · <deliverable path> · evidence <evidence path> | next gate: Josh's sign-off`, with `summary withheld: patient data` when `phi` is true. For `origin` `email`, it also sends the mailer reply, whose body is the same summary (or the withheld line) plus the paths. Exit `0` or `4` is success; any other code is an error (exit 1), and the run stops.
- `sign-off-rule` is `emailed` when `origin` is `email`, and `ask_josh` otherwise. It makes no Jira call.
- `share` is `refused` when `phi` is true, or when the evidence `recipient` is `none` or missing. A recipient that is an email address gets `deps.draft_email` and is never sent. A recipient that is a non-JP ticket key gets a comment there. Anything else is `refused`. On success it comments `Shared | <recipient> | next gate: close` on the JP ticket.
- Choosing the Outlook draft tool is a laptop step. Use the draft command of `~/Development/active/josh_projects/agent_tools/outlook_tool.py` if it has one. If it has none, `deps.draft_email` raises `GateError("no draft tool")` and `share` exits 1. Record which way it went in `docs/decisions.md`.

- [ ] **Step 1: Write the failing tests**: `test_deliver_comment_copy`, `test_deliver_withholds_summary_when_phi`, `test_deliver_email_calls_mailer_with_row`, `test_deliver_mailer_exit_4_is_success`, `test_deliver_mailer_exit_7_fails`, `test_sign_off_rule_email`, `test_sign_off_rule_ticket`, `test_share_refuses_phi`, `test_share_drafts_never_sends` (the fake records `draft_email` and asserts no send function exists on deps), `test_share_comments_on_non_jp_ticket`, `test_share_refuses_unknown_recipient`.
- [ ] **Step 2: Run** `python3 -m unittest graphs.tests.test_nondev_delivery_gates -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the gates.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit** `JP-123: Build deliver, sign-off-rule and share`.

### Task 6: Status rule, draft markers and the proof run

**Files:**
- Modify: `conventions/tickets.md` ("Statuses and who moves them"), `graphs/flows/non-development.yaml` (header comment), `graphs/flows/README.md`, `docs/design/non-development-graph.md` (add "As built")
- Create: `graphs/tests/test_nondev_graph_run.py`, `docs/proof/<date>/JP-123/`

Rules:
- `conventions/tickets.md`: replace the row "Work starts on a Research ticket | Design/Planning" with "Work starts on a ticket whose deliverable is a spec, a design or a plan | Design/Planning", and add that an answer or other non-development deliverable moves to In Progress (spec, choice 4).
- Drop `DRAFT` from the graph file's header comment and from every gate this plan built. Set the README row's State to `Built (JP-123)`.
- `test_nondev_graph_run.py` walks the graph with a minimal in-test walker. It follows `needs`, `when`, `on` and the `goto` limits from `graphs/CONVENTION.md`, "How a graph runs", and replaces it with JP-114's walker if that has landed. Gates are real and `deps` are fakes; each role step is a stub that writes a made-up deliverable and evidence file. It asserts the scenarios of the spec and of JP-123: `test_ticket_ends_in_deliverable_with_sources`, `test_email_origin_closes_without_sign_off`, `test_shared_write_waits_for_accept_and_share`, `test_deliverable_outlives_temp_workdir` (the run's temp folder is deleted; the artifacts files remain), `test_phi_ticket_comments_hold_paths_only`, and `test_do_work_runs_at_most_three_times_before_decide_stuck` (spec, "How every loop ends").

- [ ] **Step 1: Write the failing run tests**, then run `python3 -m unittest graphs.tests.test_nondev_graph_run -v`. Expected: FAIL.
- [ ] **Step 2: Implement** the in-test walker and the stubs until the tests pass. Edit the docs as listed.
- [ ] **Step 3: Run** `python3 scripts/check.py`. Expected: `check.py: ok`. Save its output and the run tests' output under `docs/proof/<date>/JP-123/`.
- [ ] **Step 4: Commit** `JP-123: Record the status rule, mark the graph built and save the proof run`.

### Task 7: Point the Email Research Desk at the graph

This changes other repositories, so its PRs wait for the phase 1 close (JP-120) (`docs/WORKFLOW.md` §5.1). It is the laptop step this ticket names.

**Files:**
- Modify (claude-harness): `skills/desk-coordinator/SKILL.md`. On a new question-path ticket, it starts a graph run (through the walker's runner, JP-117) instead of spawning a `desk-worker`. On a reply to a ticket in Done that came from the desk, it moves the ticket to Ready, comments Josh's reply on it, and starts a run. A reply to a ticket that is still open is commented only.
- Modify (claude-harness): `skills/desk-worker/SKILL.md`. Mark it retired, pointing to the graph. Do not delete it: retiring means switching off and archiving (AGENTS.md).
- Modify (action-triage): `desk/README.md`, to say where the work goes now.

Rules:
- The desk keeps its watcher and its Josh-only mailer unchanged (Josh's answer to question 1).
- Only Josh's own reply reopens a ticket. The graph's comments never start a run (spec rule 16).

- [ ] **Step 1:** Draft both skill changes and the README change on each repo's session branch, and open the PRs as drafts naming the phase 1 close (JP-120).
- [ ] **Step 2 (laptop, at the phase 1 close, JP-120):** after merge, forward one made-up question email to the desk. Check that a ticket reaches Ready, the graph delivers, the ticket closes without a sign-off, and a reply reopens it. Save the checks under `docs/proof/<date>/JP-123/`, with ticket keys and paths only.
- [ ] **Step 3: Commit** the proof: `JP-123: Prove the desk hands emailed asks to the graph`.
