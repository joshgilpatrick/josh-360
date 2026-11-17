# Development graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Contents

- [Global Constraints](#global-constraints)
- [Review Focus](#review-focus)
- [File map](#file-map)
- [Task 1: The wait step in the convention and the checker](#task-1-the-wait-step-in-the-convention-and-the-checker)
- [Task 2: The walker waits](#task-2-the-walker-waits)
- [Task 3: The work folder in the walker](#task-3-the-work-folder-in-the-walker)
- [Task 4: The registry says who merges](#task-4-the-registry-says-who-merges)
- [Task 5: Move the graph into place](#task-5-move-the-graph-into-place)
- [Task 6: Spec reading and the design gates](#task-6-spec-reading-and-the-design-gates)
- [Task 7: Git and GitHub ports](#task-7-git-and-github-ports)
- [Task 8: Ticket gates](#task-8-ticket-gates)
- [Task 9: Build gates](#task-9-build-gates)
- [Task 10: Pull request and review gates](#task-10-pull-request-and-review-gates)
- [Task 11: Merge and cleanup gates](#task-11-merge-and-cleanup-gates)
- [Task 12: Whole runs, proof and documents](#task-12-whole-runs-proof-and-documents)
- [Laptop checks owed after the build](#laptop-checks-owed-after-the-build)
- [Choices this plan makes](#choices-this-plan-makes)
- [Spec coverage](#spec-coverage)

**Goal:** Turn the approved draft into the real development graph: `graphs/flows/development.yaml` with a working `wait` step, fifteen real gate scripts and three extended shared ones, so a Ready development JP ticket ends with its pull request merged, the ticket Done and its working files saved with the run.

**Architecture:** The graph, roles, agents and the `spec` contract already exist as a draft (JP-115 design, PR #39). This plan adds one step kind (`wait`) to the convention, checker and walker, gives the walker a work folder with an answers file, and replaces the fifteen refusing gate stubs. Every gate is `run(inputs, deps) -> (outcome, outputs, summary)`; Jira reaches it through the existing `deps.ticket`, GitHub through a new `deps.github(repo)` port over the `gh` command, and git through plain `git` calls on real scratch repositories in tests. Nothing in the cloud tests touches Jira, GitHub or the network.

**Tech Stack:** Python 3.9, standard library only, for `graphs/gates/` and `graphs/tools/walker*` (they run on the laptop's `/usr/bin/python3`). The checker and `compile_graphs.py` use PyYAML and run in the cloud. Tests are stdlib `unittest` in `graphs/tests/` (gates, checker) and `tests/` (walker, whole runs), run by `python3 scripts/check.py`. `git` and `gh` 2.89 or later on the laptop.

**Spec:** `docs/superpowers/specs/2026-11-17-development-graph-design.md` (approved by Josh on 17 November 2026; he chose one builder run per ticket). Read it with this plan: its steps table, loop table, rules, exact copy and seven scenarios are not repeated here. Ticket: JP-115. Build on `main` at or after 9a4dcbe.

## Global Constraints

- **Reuse, never copy.** Jira is reached only through `deps.ticket` (`JiraPort` over `graphs/gates/lib/jira.py`, JP-121). `return-to-triage`, `check-review`, `close-ticket` and `move-ticket` (JP-123) are extended in place; every existing test of theirs passes unchanged.
- **Gate shape.** `from lib.gate_run import execute, need, say, GateError`; `execute(run, [input names])`; a gate that cannot finish raises `GateError`, which stops the run. The walker never retries a gate. Inputs arrive as strings or `None`.
- **Python 3.9, standard library only** under `graphs/gates/` and `graphs/tools/walker*`. No YAML reader exists there.
- **Compile.** After any change to a graph, tier, role or agent, run `python3 graphs/tools/compile_graphs.py` and commit the JSON copy in the same pull request.
- **Run caps** cheap 5, mid 3, gate 2. The draft's `max_loops` already fit them. Do not change a `max_loops`, a tier or an `at_limit`.
- **Only scripts write** (spec rule 9): tickets, labels, pushes, comments, merges and cleanup are gate work. No role instruction may tell a model to do one.
- **Patient data** (spec rule 10): every text bound for GitHub or Jira passes `lib.gate_run.screened()` first. `phi` defaults to true; when it is true a comment carries paths only. Branch names, commit messages, test fixtures and proof hold nothing that identifies a patient.
- **Working files** (spec rule 5) live in `$JOSH360_RUNS/<run id>/work/` and nowhere else. No gate writes one into a worktree.
- **Cleanup** (spec rule 13) never removes anything uncommitted or unpushed. No gate passes `--force` to `git push`, `git worktree remove` or `gh`.
- **A wait** (spec rule 15) holds no session and changes nothing: the two wait scripts only read.
- **Unknown is not empty.** A failed read of a pull request, its labels, checks or comments is never "none". A wait answers `pending` with the reason; every other gate raises `GateError`.
- **Labels and pull request comments** are written with `gh api` (REST), never `gh pr edit`, which fails on a retired GraphQL field.
- **Review labels**, with the colour and description action-triage uses, created only when missing: `review:needs-agent-audit` `5319E7` "PR requires autonomous audit session"; `review:audit-in-progress` `FBCA04` "Autonomous PR audit is running"; `review:changes-requested` `D93F0B` "Audit findings require author follow-up"; `review:ready-for-human` `0E8A16` "Audit complete; ready for human review"; `review:audit-blocked` `D93F0B` "PR-native audit session needs human input to proceed".
- **Never remove** `review:audit-in-progress` or `review:audit-blocked`. The laptop's audit reads both and clears them itself.
- **JP tickets only.** A key that does not match `^JP-\d+$` is `not_here`. The repository may be any system in the registry.
- **Exact copy** comes from the spec's "Exact copy" section, word for word, without the backticks that mark its placeholders.
- **Not built here:** `ready` (JP-122) and `no-loose-ends` (JP-109) stay refusing stubs; whole-run tests let them pass, as `tests/test_nondev_graph_run.py` does. Agent Manager's binding and the first real ticket are JP-117.
- **The ticket.** JP-115 stays in Design/Planning until the build thread starts, which moves it to In Progress (`docs/WORKFLOW.md`).
- **Commits:** one per file, messages starting `JP-115: `. Each task ends with `python3 scripts/check.py` printing `check.py: ok (0 problem(s))`.

## Review Focus

Failure modes the spec implies but does not test. Each has a test in the task named.

1. **A check command can see Josh's Jira credentials.** The walker hands them to every gate, and `verify-build` runs commands a model wrote. A check `test -z "$JOSH360_JIRA_TOKEN"` must pass with the token set. Task 9.
2. **A verdict that is not the audit's.** Anyone who can comment can paste `<!-- action-triage-audit:security -->`. A marked comment whose author is not an audit bot, or that is older than the round's queue time, must leave `review-state` at `pending`. Task 10.
3. **A check that never ends.** A check that runs past the gate's time budget must count as failed and leave a feedback file, not kill the gate and stop the run. Task 9.
4. **Someone merges or closes the pull request by hand while the run waits for the audit.** `review-state` must answer `ready` for a merged pull request and `blocked` for a closed one, and `merge-pr` must answer `merged` without merging again. Tasks 10 and 11.
5. **Cleanup with work at risk.** A worktree with an uncommitted file, or with a commit the pull request does not hold, must make `clean-up` refuse and delete nothing, and make `close-unmerged` and `return-to-triage` keep it. Tasks 8 and 11.
6. **Two steps give an output the same name.** `findings` comes from `harden`, `review_plan` and `await_review`; `card` from `design`, `build` and `fix_review`. After a reload the walker must hand a step the one that finished last, not the alphabetically last. Task 3.
7. **A dirty worktree.** A builder or fixer that left an uncommitted file must fail `verify-build`, and make `open-pr` and `after-fix` refuse to push. Tasks 9 and 10.

---

## File map

| File | State | Responsibility |
| --- | --- | --- |
| `graphs/CONVENTION.md` | modify | The `wait` kind, the walker's `waiting` answer, the work folder and answers file |
| `graphs/tools/check_graph.py` | modify | Accept and check `wait` steps |
| `graphs/tools/walker_lib/{graphfile,engine,runner,runfolder,cli}.py` | modify | Run waits; work folder; answers file; output order; saved feedback |
| `scripts/conventions.py`, `conventions/registry.yaml`, `conventions/registry.json` | modify | The `merges` field |
| `graphs/flows/development.yaml`, `graphs/compiled/development.json` | create | The graph (moved from `docs/design/development-graph/`) and its JSON copy |
| `graphs/gates/lib/feedback.py` | create | The feedback file writer, shared with `check-review` |
| `graphs/gates/lib/dev_spec.py` | create | Read and lint a spec, resolve a criterion, the phase state file |
| `graphs/gates/lib/dev_copy.py` | create | The five comments, word for word |
| `graphs/gates/lib/dev_git.py` | create | `git` calls: clone lookup, branch, worktree, clean and pushed checks, safe removal |
| `graphs/gates/lib/dev_github.py` | create | The GitHub port over `gh` |
| `graphs/gates/lib/dev_checks.py` | create | Run a spec's checks inside a time budget; write evidence and feedback |
| `graphs/gates/lib/dev_review.py` | create | The audit round: cursor file, queueing, verdict, counting N, check state |
| `graphs/gates/lib/gate_run.py`, `ticket_port.py` | modify | `Ticket` gains three fields; `Deps` gains `github`, `now`, `run_id`, `runs_dir`; `JiraPort.agent_status` |
| `graphs/gates/<15 new gates>.py` | replace stubs | See Tasks 6 and 8 to 11 |
| `graphs/gates/{return-to-triage,check-review,close-ticket}.py` | modify | A development mode beside the existing one |
| `graphs/contracts/{spec,evidence,feedback}.md`, `graphs/agents/spec-writer/instructions.md` | modify | The spec's file form; the development fields |
| `graphs/tests/dev_helpers.py`, `graphs/tests/test_dev_*.py`, `tests/test_walker_wait.py`, `tests/test_walker_workfolder.py`, `tests/test_development_graph.py` | create | Tests |
| `.github/workflows/test.yml`, `scripts/check.py` | modify | CI runs `graphs/tests/`; gate scripts are parsed as Python 3.9 |
| `docs/proof/<build date>/JP-115/`, `docs/decisions.md`, `graphs/flows/README.md`, `docs/design/feature-tree/tree.yaml`, the spec | create or modify | Proof and documents |

---

### Task 1: The wait step in the convention and the checker

**Files:**
- Modify: `graphs/CONVENTION.md`, `graphs/tools/check_graph.py`
- Create: `graphs/tests/fixtures/parts/flows/waits.yaml`, `graphs/tests/fixtures/parts/gates/pr-state.py`, and `graphs/tests/fixtures/bad/{wait-with-effects,wait-not-read,wait-declares-pending,wait-unknown-gate,wait-and-gate}.yaml`
- Test: `graphs/tests/test_check_graph.py`

**Interfaces:**
- Produces: a step may carry `wait: <gate script name>` in place of `role`, `gate` or `ask`. Tasks 2 and 3 walk the fixture graph `waits`, whose steps are, in order: `zeta` (role `designer`, output `note: string`, outcomes `[ready]`), `alpha` (role `builder`, needs `zeta`, output `note: string`, outcomes `[done]`), `hold` (`wait: pr-state`, needs `alpha`, inputs `[note]`, output `state: string`, outcomes `[merged, closed]`, `on: {closed: end}`), `confirm` (ask, needs `hold`, choices `[answered]`), `tell` (role `publisher`, needs `confirm`, inputs `[note]`, output `answer: string`, outcomes `[told]`). Graph inputs `ticket_key` (required) and `system` (default `none`), as `valid.yaml` has, because `WalkerCase.start` passes both. Header: one stretch `In Progress` holding all five, `entry_gate: ready`, `exit_gate: no-loose-ends`, `asks_josh: [confirm]`, `end_states: {finished: success, hold.closed: neutral}`, `hold` and `confirm` at access `read`.

Rules:
- Schema: add `"wait": LEAF` to `STEP`. A step has exactly one of `role`, `gate`, `ask`, `wait` (message: `must have exactly one of role, gate, ask or wait`).
- A wait names a script in `gates/` (`names unknown gate '<name>'`), lists `outcomes` like a gate, and may have `needs`, `when`, `inputs`, `outputs` and `on`.
- Refused: a wait with `effects`; a wait whose header access is not `read`; a wait that declares the outcome `pending`.
- A wait is not a gate for convention rule 5: a reviewer role still needs a `gate` step.
- `CONVENTION.md`: a `wait` row in the "Steps" table; a "Wait steps" section under "Steps" (add it to Contents) with the spec's four bullets from "Waiting without a session"; one line in "The checker"; a line in "Changing this convention" that the change is additive and the convention stays at version 1.

- [ ] **Step 1: Write the failing tests** in `graphs/tests/test_check_graph.py`: `test_wait_step_passes` (`waits.yaml` exits 0), `test_wait_with_effects_refused`, `test_wait_must_be_read`, `test_wait_may_not_declare_pending`, `test_wait_unknown_gate_refused`, `test_wait_and_gate_on_one_step_refused`. Each bad fixture is `waits.yaml` with one line changed, and its test asserts exit 1 and a message naming step `hold`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_check_graph.py"`. Expected: the six new tests FAIL.
- [ ] **Step 3: Implement** the checker rules and write the fixtures. `pr-state.py` is a refusing stub like the other fixture gates.
- [ ] **Step 4: Run** the tests, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Edit `CONVENTION.md`, then commit.**

### Task 2: The walker waits

**Files:**
- Modify: `graphs/tools/walker_lib/graphfile.py`, `engine.py`, `runner.py`, `cli.py`, `tests/walker_helpers.py` (add `pr-state` to the scripted gates), `graphs/CONVENTION.md` ("The walker")
- Test: `tests/test_walker_wait.py`

**Interfaces:**
- Consumes: Task 1's fixture graph `waits`.
- Produces: `walker.py next` may print `{"action": "waiting", "run": ..., "step": ..., "gate": ..., "summary": ..., "waiting_since": "<UTC time>"}`. `walker.py status` gains `"waiting": {"step", "since", "checked"}` or `null`.

Rules:
- `Graph.kind()` returns `wait`; `engine.decide()` returns `Action("wait", step)`; `engine.replay()` accepts it.
- In `runner.advance()`, a wait runs its script through `gates.run_gate(root, s["wait"], env, cwd, outcomes + ["pending"])` **before any ledger row is written**, after `ensure_status`.
- `pending`: write nothing to the ledger, count no loop, set no flag. Keep `run.doc["waiting"] = {"step", "since", "checked"}` (`since` is kept from the first `pending` of this visit) and print `waiting`. The summary goes through `_note`, so a `phi` run prints none.
- A declared outcome: write one row with step kind `gate` (the ledger's schema does not change), save the declared outputs, end the row, drop `run.doc["waiting"]`, carry on.
- A script error: one row ending in `error`, the run stops and the flag goes on, exactly as for a gate.
- `CONVENTION.md`, "The walker": `next` prints `run`, `parked`, `waiting`, `done` or `stopped`; a wait writes its row only when it ends.

- [ ] **Step 1: Write the failing tests** (`WalkerCase`, graph `waits`, `pr-state` scripted by `self.plan`):
  - `test_pending_prints_waiting_and_writes_no_row`: plan `["pending", "pending", "merged"]`. After `zeta` and `alpha`, `next` gives `action == "waiting"` and `step == "hold"`, and `step_rows` has no `hold`. The second `next` gives the same `waiting_since`. The third parks at `confirm`, and `hold` has one row: attempt 1, loop count 0, outcome `merged`.
  - `test_wait_outputs_are_saved`: plan `[{"outcome": "merged", "outputs": {"state": "MERGED"}}]`; `run.json` holds `outputs.hold.state == "MERGED"`.
  - `test_wait_outcome_can_end_the_run`: plan `["closed"]`; `next` gives `done` with end `hold.closed` and score `neutral`.
  - `test_wait_error_stops_the_run`: plan `["crash"]`; `next` gives `stopped`; the `hold` row's outcome is `error`.
  - `test_status_shows_waiting`: after one `pending`, `status` has `waiting.step == "hold"`; after `merged` it is `None`.
  - `test_a_finished_wait_replays`: after `merged`, a fresh `next` call does not raise `Corrupt`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests -t tests -p "test_walker_wait.py" -v` (the form `scripts/check.py` uses). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 3: The work folder in the walker

**Files:**
- Modify: `graphs/tools/walker_lib/runfolder.py`, `runner.py`, `cli.py`, `graphs/CONVENTION.md` ("The walker")
- Test: `tests/test_walker_workfolder.py`

**Interfaces:**
- Produces:
  - `runfolder.work_dir(run_id: str) -> Path` is `<run folder>/work`; `runfolder.create()` makes it.
  - `runfolder.append_answer(run_id: str, step: str, text: str, when: str) -> None` appends `## <step> · <when>`, a blank line, the text and a blank line to `work/answers.md`.
  - `runfolder.values(doc: dict, order: Optional[List[str]] = None) -> Dict[str, object]`: inputs first, then step outputs in `order`; steps not in `order` come before those that are.
  - Gates find the folder as `Path(environ["JOSH360_RUNS"]) / environ["JOSH360_RUN_ID"] / "work"`.

Rules:
- `Run.values` passes `order`: step ids by each step's newest ledger row that has an outcome, oldest first. A later finished step wins a shared output name.
- The walker appends to the answers file when: an ask is answered (`check_answer`, the answer text, whatever the choice); a role result carries a non-empty string output `answer` (`cmd_record`); a gate or wait gives a declared output `answer`.
- `files_to_save` also returns `work/hardening.md` and every `work/feedback/*.md` that exists, as `{"step": "work", "name": <file stem>, "kind": "feedback"}`. `conclude` records them with no step row.
- `CONVENTION.md`: one bullet, "The work folder", naming `work/`, the answers file and the saved feedback.

- [ ] **Step 1: Write the failing tests** (graph `waits`):
  - `test_work_folder_exists_from_start`: `<runs>/<run>/work` is a folder right after `start`.
  - `test_later_output_wins_after_reload`: `zeta` records `note: "from zeta"`, `alpha` records `note: "from alpha"`, `pr-state` answers `merged`, `confirm` is answered; the `run` answer for `tell` has `inputs["note"] == "from alpha"`.
  - `test_answers_file_collects_asks_and_answer_outputs`: `confirm` answered `use the blue one`, `tell` records `answer: "done as asked"`; `work/answers.md` holds `## confirm`, `use the blue one`, `## tell`, `done as asked`, in that order.
  - `test_feedback_files_are_saved_at_the_end`: write `work/hardening.md` and `work/feedback/p1.md` before the last `next`; `saved/` holds a copy of each, and `run_files` has two rows of kind `feedback` with a 64-character `sha256`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests -t tests -p "test_walker_workfolder.py" -v`. Expected: FAIL (`test_later_output_wins_after_reload` fails with `from zeta`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 4: The registry says who merges

**Files:**
- Modify: `scripts/conventions.py`, `conventions/registry.yaml` (the field list in its header comment, and `merges: agent` on `josh-360` only), `conventions/registry.json` (run `python3 scripts/conventions.py export-json`)
- Test: `tests/test_conventions.py`

**Interfaces:**
- Produces: a system may carry `merges: agent` or `merges: josh`. Absent means `josh`. `lookup_repo()` and `lookup_folder()` return it as `merges`.

- [ ] **Step 1: Write the failing tests**: `test_merges_agent_is_accepted`, `test_merges_other_value_is_a_problem` (`merges: anyone` gives a problem naming the system and `merges`), `test_lookup_gives_josh_by_default`, `test_only_josh_360_lets_agents_merge` (in the real registry, exactly one system has `merges: agent`, and its name is `josh-360`).
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests -t tests -p "test_conventions.py" -v`. Expected: the four new tests FAIL.
- [ ] **Step 3: Implement**: add `merges` to `SYSTEM_KEYS`, check its value in `_system_problems`, add it to both lookups, edit the YAML, export the JSON.
- [ ] **Step 4: Run** the tests and `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 5: Move the graph into place

**Files:**
- Create: `graphs/flows/development.yaml` (`git mv` from `docs/design/development-graph/development.yaml`), `graphs/compiled/development.json`
- Delete: `docs/design/development-graph/check_draft.py`, `docs/design/development-graph/dry_walk.py`
- Modify: `graphs/flows/README.md` (a `development.yaml` row)
- Test: `graphs/tests/test_dev_graph_file.py`

**Interfaces:**
- Produces: the inputs each gate is given. Replace the file's four DRAFT comment lines with one line naming the spec, and make exactly these edits (tried against the checker on 17 November; nothing else in the file changes):

| Step | Change |
| --- | --- |
| `read_ticket` | add output `reason: { type: string, description: "Why the ticket is not workable here, when the outcome is not_here" }` |
| `return_early` | inputs `[ticket_key, reason]` |
| `return_question` | inputs `[ticket_key, phi, work_dir, worktree, card]` |
| `lint` | inputs `[ticket_key, ticket_type, spec_path, plan_path, worktree, work_dir]` |
| `check_harden` | inputs `[ticket_key, spec_path, plan_path, work_dir, findings]` |
| `open_pr` | inputs `[ticket_key, phi, repo, branch, worktree, work_dir, base_branch, pr_title, pr_body]` |
| `queue_audit` | inputs `[repo, pr_number, work_dir]` |
| `after_fix` | inputs `[ticket_key, ticket_type, phi, repo, pr_number, branch, spec_path, worktree, work_dir, resolution, issue_count]` |
| `close_unmerged` | inputs `[ticket_key, repo, pr_url, worktree, branch, work_dir]` |
| `close` | inputs `[ticket_key, ticket_type, phi, pr_url, spec_path, evidence_path]` |

Rules:
- The two `wait:` steps stay as written. The gate stubs still refuse; the checker and the compile only need the files to exist.
- Keep `docs/proof/2026-11-17/JP-115/` and the history rows in `docs/decisions.md` as they are. Task 12 fixes the spec's own references to the old folder.

- [ ] **Step 1: Write the failing tests** (they load the YAML with PyYAML and run the checker's `main`):
  - `test_graph_passes_the_checker`: `check_graph.py graphs/flows/development.yaml` exits 0.
  - `test_asks_josh_lists_every_ask_step`: the header's `asks_josh` equals the set of steps with `ask`.
  - `test_limit_asks_are_reached_only_at_a_limit`: `design_stuck`, `build_stuck` and `review_stuck` have `on_limit_only: true`, and appear as an `at_limit` and never in a `needs` or as a `goto`.
  - `test_named_asks_have_exactly_these_doors`: the `when` of `ask_design` is `route_question: to_josh`; of `approve_design`, `read_ticket: design_only`; of `ask_builder`, `triage_question: escalate`; of `audit_stuck`, `await_review: [blocked, stale]`; of `ask_fixer`, `fix_review: needs_input`.
  - `test_a_build_tickets_question_never_reaches_josh`: `route_question`'s `to_triage` leads to `return_question`, whose `returned` is `end`.
  - `test_two_waits_and_both_read`: the steps with `wait` are `await_review` and `await_merge`, both `read`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_graph_file.py"`. Expected: FAIL (no file).
- [ ] **Step 3: Move and edit the file, run** `python3 graphs/tools/compile_graphs.py`, delete the two draft tools, add the README row.
- [ ] **Step 4: Run** the tests and `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 6: Spec reading and the design gates

**Files:**
- Create: `graphs/gates/lib/feedback.py`, `graphs/gates/lib/dev_spec.py`, `graphs/gates/lib/dev_copy.py`, `graphs/tests/dev_helpers.py`
- Modify: `graphs/gates/check-review.py` (use `lib.feedback`; its output does not change), `graphs/gates/lint-spec.py`, `graphs/gates/question-route.py`, `graphs/contracts/spec.md`, `graphs/contracts/evidence.md`, `graphs/contracts/feedback.md`, `graphs/agents/spec-writer/instructions.md`, `graphs/roles/designer/instructions.md`, `graphs/roles/review-fixer/instructions.md`, `graphs/compiled/development.json` (recompile: an agent and two roles changed)
- Test: `graphs/tests/test_dev_spec.py`

**Interfaces:**
- Produces:
  - `feedback.feedback_text(title: str, intro: str, rows: List[dict], fields: Sequence[str]) -> str`: the block `check-review` writes today, with the heading and field names passed in.
  - `dev_spec.SpecError(Exception)`; `dev_spec.load(path: Path) -> dict` (reads with `json`; `SpecError` when it is not a JSON object).
  - `dev_spec.problems(spec: dict, scenario_names: List[str]) -> List[str]`; `dev_spec.scenario_names(description: str) -> List[str]` (every `Scenario:` or `Scenario Outline:` line of a ticket).
  - `dev_spec.criterion_text(spec: dict, criterion: str) -> Optional[str]` for `DOD-<n>`, `<phase>.task.<n>` and `<phase>.check.<n>` (1-based).
  - `dev_spec.spec_text(spec: dict) -> str`: every string value of the spec, one per line (what a quote is matched against).
  - `dev_spec.load_state(work_dir: Path) -> dict` and `save_state(work_dir: Path, state: dict) -> None` for `state.json`: `{"review_round": 0, "phases": {"<id>": {"status": "pending" | "passed" | "failed" | "reopened", "attempts": 0, "extra_checks": []}}}`. A missing file loads as that shape with no phases.
  - `dev_copy.pr_opened(url, passed, total, head)`, `returned_question(question: Optional[str], path: str, run_id: str)`, `fixes_pushed(n: int, resolution: str, next_gate: str)`, `done_merged(url, merge_commit, run_id, research: bool)`, `cancelled(url, run_id)`, each returning `str`; `FOOTER = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_"`.
  - `dev_helpers.SPEC`: a made-up two-phase spec dict for ticket `JP-9002` (phases `p1`, `p2`, checks that are plain shell such as `test -f widget.txt`); `dev_helpers.write_spec(work_dir, spec=SPEC) -> Path`.

Rules:
- **The spec file's form.** `work/spec.yaml` is written in YAML's JSON form (every JSON document is valid YAML), because the laptop has no YAML reader. Say so in `contracts/spec.md` ("Fields": replace "YAML." and give the definition-of-done block as JSON) and in the spec-writer's instructions.
- `dev_spec.problems`, one sentence each: `ticket` and `summary` missing; no `definition_of_done` item with an id matching `DOD-<n>` and a rule; no phase; a phase whose `id` does not match `^[a-z][a-z0-9-]*$` or repeats, or with an empty `task`, no `checks`, or no `files` list; a ticket scenario missing from `scenarios` (names compared with whitespace collapsed and case folded); a scenario row whose `tag` is not `@auto`, `@e2e` or `@manual`, or whose `proved_by` is empty, or (for `@auto`) does not resolve to a phase check.
- `dev_copy` strings, with `{}` for each value:
  - `Pull request opened | {url} · checks {passed}/{total} on {head} | next gate: the PR audit`
  - `Returned to triage | the designer needs: {question} · run {run}, spec saved | next gate: triage answers it, then this run resumes`; with `question` `None` the middle reads `the designer needs: withheld: patient data, see {path}`.
  - `Review fixes pushed ({n} finding(s) addressed) | {resolution} | next gate: {next}` plus `FOOTER`, where `next` is `another audit round` or `ready for human`.
  - `Done | merged {url} as {commit} · spec and evidence saved with run {run} | next gate: none`; for a Research ticket the middle reads `design and plan merged with it, run {run}`.
  - `Cancelled | {url} was closed without merging · spec and evidence saved with run {run} | next gate: Josh reopens the ticket if he wants it built again`
- Role instructions: the designer's list of work-folder files gains `lint.md`; the review fixer gains one line, to read the work folder's `feedback/` files and `answers.md` first. Nothing else in a role changes.
- `question-route`: `to_josh` when `ticket_type` is `Research`, else `to_triage`. No Jira call.
- `lint-spec` (inputs as in Task 5; outcomes `complete`, `incomplete`):
  - Build ticket: `spec_path` must resolve inside `work_dir`; `work_dir` must be the run's own work folder (`deps.work_dir`), outside `worktree`, outside that worktree's clone, and with no `.claude/worktrees` in its path; the file loads; `problems()` is empty, with the scenario names read from the ticket through `deps.ticket.read`.
  - Research ticket: `spec_path` and `plan_path` are files inside `worktree`; the design has a `## Contents` heading, a fenced `gherkin` block with at least one `Scenario`, and a heading containing `Out of scope`.
  - `incomplete` writes the problems, one per line, to `work_dir/lint.md` for the designer's next run; `complete` removes that file. Its summary is the count, never the text.
- `contracts/evidence.md` gains "The development graph's evidence" (Task 9's file). `contracts/feedback.md` gains the plan reviewer's fields (`phase`, `criterion`, `quote`, `finding`, `required_fix`, `expected_evidence`, `expected_check`) and where the files live (`work/hardening.md`, `work/feedback/<phase>.md`, `work/withdrawn.md`). Both keep a correct `## Contents`.

- [ ] **Step 1: Write the failing tests**: `test_load_reads_json_form`, `test_load_refuses_block_yaml`, `test_sample_spec_has_no_problems`, one test per `problems` rule above (`test_phase_without_checks`, `test_missing_scenario`, `test_auto_scenario_must_name_a_check`, and so on), `test_criterion_text_resolves_three_forms`, `test_criterion_out_of_range_is_none`, `test_state_missing_file_loads_empty`, `test_copy_matches_the_spec` (each `dev_copy` function against the full string above), `test_question_route`, `test_lint_complete`, `test_lint_refuses_spec_inside_a_worktree`, `test_lint_refuses_a_work_folder_inside_the_clone`, `test_lint_refuses_a_work_folder_that_is_not_the_runs`, `test_lint_incomplete_writes_lint_md`, `test_lint_complete_removes_lint_md`, `test_lint_research_needs_contents_gherkin_out_of_scope_and_plan`, `test_check_review_file_is_byte_for_byte_the_same` (the existing mode's feedback file before and after the move to `lib.feedback`).
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_spec.py"`. Expected: FAIL.
- [ ] **Step 3: Implement**, edit the contracts and the agent, recompile.
- [ ] **Step 4: Run** all of `graphs/tests`, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 7: Git and GitHub ports

**Files:**
- Create: `graphs/gates/lib/dev_git.py`, `graphs/gates/lib/dev_github.py`
- Modify: `graphs/gates/lib/gate_run.py`, `graphs/gates/lib/ticket_port.py`, `graphs/tests/nondev_helpers.py` (`FakeTicket` takes `summary`, `issuetype`, `flagged`, `agent_status`), `graphs/tests/dev_helpers.py`
- Test: `graphs/tests/test_dev_ports.py`

**Interfaces:**
- Produces, in `gate_run.py`:
  - `Ticket` gains `summary: str = ""`, `issuetype: str = ""`, `flagged: bool = False` after `route`. `JiraPort.read` fills them.
  - `JiraPort.agent_status(key: str) -> Optional[str]`: the option value of the field named by `JOSH360_AGENT_STATUS_FIELD` (default `customfield_10453`), `None` when empty; `GateError` when the read fails.
  - `Deps.github(repo: str) -> GitHub` (built on first use, one per repo); `Deps.now() -> datetime` (UTC); `Deps.run_id` and `Deps.runs_dir` from `JOSH360_RUN_ID` and `JOSH360_RUNS`; `Deps.work_dir -> Path`.
- Produces, in `dev_git.py` (`GitError(Exception)`; every call has a timeout and never prints file content):
  - `git(cwd: Path, *args: str, check: bool = True) -> str`
  - `clone_for(registry_path: Path, repo: str, environ) -> Path`: the system whose `repositories` holds the bare name (the part after `/`), and its first `folders` entry that exists, with `~` read against `environ["HOME"]`.
  - `owner_repo(clone: Path) -> str` from `git remote get-url origin` (https and ssh forms, `.git` dropped); `clone_of(worktree: Path) -> Path`.
  - `slug(summary: str, limit: int = 40) -> str`: lower case, every run of other characters becomes `-`, cut at a word end, `work` when empty.
  - `ticket_branches(clone: Path, key: str) -> List[str]`: local and `origin` branches named `<KEY>-*`, each once, without `origin/`.
  - `add_worktree(clone: Path, branch: str, base: str) -> Path` at `<clone>/.claude/worktrees/<branch>`; an existing worktree on that branch is returned as it is.
  - `is_clean(worktree) -> bool`; `unpushed(worktree) -> int` (`git rev-list --count HEAD --not --remotes`); `head(worktree) -> str`; `ahead_of(worktree, base) -> int`; `push(worktree, branch) -> None` (`git push -u origin <branch>`).
  - `changed_files(worktree, base) -> List[str]`, `diff_stat(worktree, base) -> str`, `added_lines(worktree, base) -> List[Tuple[str, str]]`, all against `origin/<base>...HEAD`.
  - `remove_worktree(clone: Path, worktree: Path, branch: str, pushed_head: Optional[str] = None) -> Optional[str]`: `None` when the worktree and local branch are gone (also when they already were); otherwise the reason it refused, and nothing is removed. It refuses a dirty worktree, and a worktree whose head is not `pushed_head` (when given) or that has unpushed commits (when not).
- Produces, in `dev_github.py` (`GitHubError(Exception)`):
  - `PullRequest(number: int, url: str, state: str, head_sha: str, head_ref: str, base_ref: str, labels: List[str], merge_commit: str)`, with `state` one of `OPEN`, `MERGED`, `CLOSED`; `Check(name: str, bucket: str, started: str)`; `PrComment(author: str, body: str, created: str)`.
  - `class GitHub(repo: str, environ=None, runner=subprocess.run)` with `pr(number) -> PullRequest`, `open_pr_for(branch) -> Optional[PullRequest]`, `create_pr(head, base, title, body) -> PullRequest`, `comments(number) -> List[PrComment]`, `comment(number, body) -> None`, `ensure_labels() -> None`, `add_label(number, label) -> None`, `remove_label(number, label) -> None` (an absent label is fine), `checks(number) -> List[Check]`, `merge_squash(number, head_sha) -> None`, `delete_branch(branch) -> None` (an absent branch is fine).
  - Constants `TRIGGER`, `IN_PROGRESS`, `CHANGES`, `READY`, `BLOCKED` and `REVIEW_LABELS: Dict[str, Tuple[str, str]]` (Global Constraints).
  - `parse_pr_url(url: str) -> Tuple[str, int]`: the repo and the number, both from the one URL.
- Produces, in `dev_helpers.py`: `scratch_repo(tmp: Path, name: str = "widgets") -> Tuple[Path, Path]` (a bare `origin` and a clone on `main` with one commit, `user.name` and `user.email` set in the clone); `FakeGitHub(origin: Path)` with the same methods as `GitHub`, settable `state`, `labels`, `checks`, `comments` and `merge_commit`, a `head_sha` read from the scratch origin's branch so that it follows real pushes, a `fail_on` set like `FakeTicket`'s, and a `calls` list; `make_dev_deps(tmp, ticket=None, github=None, clone=None, merges="josh", now=None, environ=None)` whose registry file names the system `widgets`, repository `widgets` and the clone's folder.

Rules:
- `gh` commands: `gh pr view <n> --repo <repo> --json number,url,state,labels,headRefOid,headRefName,baseRefName,mergeCommit`; `gh pr list --repo <repo> --head <branch> --state open --json ...`; `gh pr create --repo <repo> --head <branch> --base <base> --title <t> --body-file <file>`; `gh pr checks <n> --repo <repo> --json name,bucket,startedAt` (exit 8 means some are pending and still prints the list; "no checks reported" means an empty list; any other failure is `GitHubError`); `gh pr merge <n> --repo <repo> --squash --match-head-commit <sha>`; labels and comments through `gh api repos/<repo>/issues/<n>/labels`, `.../labels/<name with : as %3A>` and `.../comments` (`--paginate` to read); `gh api -X DELETE repos/<repo>/git/refs/heads/<branch>`; `gh label create <name> --repo <repo> --color <c> --description <d>` for a missing label only.
- Every `gh` call: 60-second timeout; a non-zero exit (other than the two named) raises `GitHubError` with the first line of stderr.
- `ensure_labels` creates what `gh label list` does not show and changes no existing label.

- [ ] **Step 1: Write the failing tests.** Git tests use `scratch_repo`; `gh` tests put a fake `gh` (a script the test writes, which logs its arguments and prints canned JSON by subcommand) first on `PATH`: `test_clone_for_finds_first_existing_folder`, `test_clone_for_unknown_repo_raises`, `test_owner_repo_https_and_ssh`, `test_slug` (`"Fix: the Widget's  label!"` gives `fix-the-widget-s-label`; forty characters cut at a word end; empty gives `work`), `test_ticket_branches_local_and_remote_once`, `test_add_worktree_cuts_from_origin_base_and_leaves_the_clone_alone` (the clone's own branch and files are unchanged), `test_add_worktree_twice_returns_the_same`, `test_unpushed_counts_local_commits`, `test_remove_worktree_refuses_dirty`, `test_remove_worktree_refuses_unpushed`, `test_remove_worktree_removes_when_head_is_the_pushed_head`, `test_remove_worktree_already_gone_is_none`, `test_pr_view_parses`, `test_checks_exit_8_still_lists`, `test_checks_none_reported_is_empty`, `test_gh_failure_raises` (never an empty list), `test_remove_label_encodes_the_colon`, `test_ensure_labels_creates_only_the_missing`, `test_merge_passes_the_head_commit`, `test_parse_pr_url`, `test_ticket_defaults_keep_old_callers_working`, `test_agent_status_reads_the_option_value`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_ports.py"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all of `graphs/tests`, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 8: Ticket gates

**Files:**
- Modify: `graphs/gates/read-dev-ticket.py`, `graphs/gates/prepare-worktree.py`, `graphs/gates/return-to-triage.py`, `graphs/gates/check-review.py`
- Test: `graphs/tests/test_dev_ticket_gates.py`

**Interfaces:**
- Consumes: Tasks 6 and 7.

Rules, `read-dev-ticket` (inputs `ticket_key`, `ticket_type`, `system`, `resume_from`; outcomes `build`, `design_only`, `not_here`). The ticket is trusted over the inputs. `not_here` carries one of these fixed `reason` sentences and nothing from the ticket:

| Check, in order | `reason` |
| --- | --- |
| The key is not a JP key | `the development graph works JP tickets only` |
| The ticket cannot be read | `the ticket could not be read` |
| Its status is not Ready | `the ticket is not Ready` |
| The route record's `graph` is not `development` | `the ticket is not routed to the development graph` |
| The ticket's type is not Story, Bug, Task or Research, or differs from `ticket_type` | `the ticket type is not one the development graph builds` |
| The route record names a system that differs from `system`, or the registry has no repository for `system` | `the ticket's system has no repository in the registry` |
| The flag is on, or the description's "Open questions" section has a bullet that does not start `Answered:` | `the ticket has an open question` |
| `agent_status` is set and is not `Finished` | `another runner holds the ticket` |

- Otherwise `design_only` for Research and `build` for the rest, with `repo` (the system's first entry in `repositories` names the clone; the output is `dev_git.owner_repo` of that clone; no clone on this machine is a `GateError`, because that is the machine's fault, not the ticket's) and `prior_spec`: `$JOSH360_RUNS/<resume_from>/work/spec.yaml` when it exists, else the newest `saved/*spec_path*` file of that run, else `none`.

Rules, `prepare-worktree` (inputs `ticket_key`, `repo`, `base_branch`; outcome `ready`):
- `git fetch origin` in the clone. No branch named `<KEY>-*`: cut `<KEY>-<slug of the ticket's summary>` from `origin/<base_branch>`. One: reuse it. More than one: `GateError` naming them. A summary that the patient-data screen flags gives the slug `work`.
- Outputs `worktree`, `branch` and `work_dir` (`deps.work_dir`, made if missing). The clone's own checkout is never touched.

Rules, `return-to-triage` (new optional inputs `card`, `worktree`, `work_dir`, `phi`; the list becomes `["ticket_key", "reason", "card", "worktree", "work_dir", "phi"]`):
- With no `card` it behaves exactly as today.
- With a `card`: write it to `work_dir/question.md`; comment `dev_copy.returned_question(...)`, giving the question only when `phi` is false and the screen passes it, else the path; move to Not Started and set the flag as today. Then `dev_git.remove_worktree` (no `pushed_head`): an untouched worktree goes, one with commits or uncommitted files stays for the resumed run, and the summary says which.

Rules, `check-review` (new optional inputs `spec_path`, `plan_path`, `work_dir`):
- With `work_dir` given it is the hardening mode; with `evidence_path` given it is today's mode, unchanged.
- The source text is `dev_spec.spec_text` of a build spec (or the design file's text, plus the plan's, for a Research ticket) and the ticket's description. A finding is kept when its `quote` is in it (`ticket_text.quotes`).
- Kept findings go to `work_dir/hardening.md` through `lib.feedback` (fields `quote`, `where`, `problem`, `fix`); when none is kept an existing file is emptied. Each dropped finding is appended to `work_dir/withdrawn.md` with `quotes nothing in the spec or the ticket`.

- [ ] **Step 1: Write the failing tests**: one test per row of the `not_here` table asserting the outcome and the exact `reason`; `test_build_for_story`, `test_design_only_for_research`, `test_prior_spec_found_in_the_returned_runs_work_folder`, `test_prior_spec_none`, `test_no_clone_is_a_gate_error`; `test_prepare_cuts_branch_from_origin_base`, `test_prepare_reuses_the_one_ticket_branch`, `test_prepare_refuses_two_ticket_branches`, `test_prepare_work_dir_is_outside_the_clone`; `test_return_without_card_is_unchanged`, `test_return_with_card_comments_the_spec_copy`, `test_return_withholds_the_question_when_phi`, `test_return_removes_an_untouched_worktree`, `test_return_keeps_a_worktree_with_commits` (Review Focus 5); `test_harden_finding_quoting_the_spec_is_kept`, `test_harden_finding_quoting_the_ticket_is_kept`, `test_harden_finding_quoting_nothing_is_dropped_and_logged`, `test_harden_quote_across_json_escapes` (a quote holding `"` matches the decoded spec text), `test_harden_clean_empties_an_old_file`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_ticket_gates.py"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all of `graphs/tests` (the JP-123 tests included), then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 9: Build gates

**Files:**
- Create: `graphs/gates/lib/dev_checks.py`
- Modify: `graphs/gates/verify-build.py`, `graphs/gates/cite-check.py`
- Test: `graphs/tests/test_dev_build_gates.py`

**Interfaces:**
- Produces, in `dev_checks.py`:
  - `CheckResult(phase: str, number: int, command: str, exit_code: Optional[int], seconds: float, tail: str, extra: bool)`; `exit_code` is `None` for a check that timed out or was not run for lack of time.
  - `clean_env(environ) -> Dict[str, str]`: the environment without `JOSH360_JIRA_TOKEN`, `JOSH360_JIRA_EMAIL`, `ACTION_AGENT_JIRA_EMAIL`, `ACTION_TRIAGE_JIRA_TOKEN` and every `GRAPH_INPUT_*`.
  - `budget(environ) -> int`: `JOSH360_GATE_TIMEOUT` (default 600) minus 60, at least 5.
  - `run_all(spec: dict, state: dict, worktree: Path, environ, seconds: int) -> List[CheckResult]`: each phase's `checks` then its `extra_checks`, as `/bin/bash -c <command>` in the worktree with `clean_env`. One command string runs once and its result is given to every phase that names it. Each check's timeout is the time left. A check runs in its own process group (`start_new_session=True`), and the whole group is killed when it times out, so a hung child cannot outlive the gate.
  - `failing_phases(results) -> List[str]`; `write_feedback(work_dir: Path, results) -> None`; `write_evidence(work_dir: Path, key: str, base: str, worktree: Path, results) -> Path`.

Rules, `verify-build` (outcomes `passed`, `failed`; output `evidence_path`):
- `passed` only when every check exits 0 and the worktree is clean.
- A failing phase gets `work_dir/feedback/<phase>.md` (through `lib.feedback`: the command, the exit code or `timed out`, and the last 20 lines of output), replacing an older file; a phase that now passes has its file removed. A dirty worktree writes `work_dir/feedback/_worktree.md` listing the file names, and is `failed`.
- `state.json`: each phase's `attempts` goes up by one, and its `status` becomes `passed` or `failed`.
- `evidence.md` is written on every run: a front block `lib/evidence.py` can read (`ticket`, `kind: development`, `base`, `head`, `checks_total`, `checks_passed`), then four sections: the checks (phase, command, result, seconds; no output), the files changed (`diff_stat`), added lines that match the placeholder pattern from Josh's draft (`TODO|FIXME|XXX|NotImplemented|not implemented|placeholder|lorem ipsum|@pytest\.mark\.skip|\.skip\(|xit\(|assert True|raise NotImplementedError`), and changed files no phase names. The last two are reports for the plan reviewer and do not change the outcome.

Rules, `cite-check` (inputs `ticket_key`, `spec_path`, `work_dir`, `findings`; outcomes `clean`, `rework`):
- A finding is kept when its `criterion` resolves (`dev_spec.criterion_text`), its `quote` is in that text (whitespace collapsed, case folded, not empty), its `phase` is a phase of the spec, and `finding`, `required_fix` and `expected_evidence` are filled.
- Kept findings are written per phase to `work_dir/feedback/<phase>.md`; that phase's `status` becomes `reopened`, a filled `expected_check` is added to its `extra_checks` once, and `review_round` goes up by one. Each dropped finding is appended to `work_dir/withdrawn.md` with its reason (`no such criterion`, `the quote is not in the criterion`, `no such phase`, `a required field is empty`).

- [ ] **Step 1: Write the failing tests** (a scratch repository, `dev_helpers.SPEC`): `test_all_checks_pass`, `test_failing_check_writes_feedback_and_fails`, `test_passing_phase_clears_its_old_feedback`, `test_same_command_runs_once` (the command appends a line to a file; the file has one line), `test_extra_checks_run`, `test_check_cannot_see_jira_credentials` (Review Focus 1: `test -z "$JOSH360_JIRA_TOKEN"` passes with the token in `deps.environ`), `test_check_past_the_budget_fails_and_the_gate_returns` (Review Focus 3: `JOSH360_GATE_TIMEOUT=62` gives a 5-second budget, and the check is `sleep 30`; the outcome is `failed` in under ten seconds, the feedback says `timed out`, and no `sleep` process is left), `test_dirty_worktree_fails` (Review Focus 7), `test_evidence_front_block_reads_with_lib_evidence`, `test_evidence_lists_placeholder_lines_and_unnamed_files`, `test_evidence_holds_no_check_output`, `test_state_counts_attempts`; `test_cited_defect_is_kept_and_reopens_its_phase`, `test_defect_quoting_nothing_is_dropped` (the spec's scenario "A defect must cite the plan"), `test_unknown_criterion_is_dropped`, `test_quote_from_another_criterion_is_dropped`, `test_missing_required_fix_is_dropped`, `test_expected_check_is_added_once`, `test_no_kept_defects_is_clean`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_build_gates.py"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all of `graphs/tests`, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 10: Pull request and review gates

**Files:**
- Create: `graphs/gates/lib/dev_review.py`
- Modify: `graphs/gates/open-pr.py`, `graphs/gates/queue-audit.py`, `graphs/gates/review-state.py`, `graphs/gates/after-fix.py`
- Test: `graphs/tests/test_dev_review_gates.py`

**Interfaces:**
- Produces, in `dev_review.py`:
  - `read_cursor(work_dir: Path) -> Optional[dict]` and `write_cursor(work_dir: Path, repo: str, number: int, head: str, queued_at: str) -> dict` for `pr-cursor.json`: `{"repo", "pr", "head", "queued_at", "round"}`; each write adds one to `round`.
  - `queue(github, number: int) -> None`: `ensure_labels`; remove `CHANGES` and `READY`; add `TRIGGER` when it is not there.
  - `audit_bots(environ) -> List[str]`: `JOSH360_AUDIT_BOTS` (comma-separated) or `eventus-action-agent`, `eventuswh-apps-action-agent`, `joshgilpatrick-action-agent`. A login matches with `[bot]` and letter case ignored.
  - `verdict(comments: List[PrComment], since: str, bots: List[str]) -> Optional[PrComment]`: the newest comment that holds `<!-- action-triage-audit:`, was written by a bot in the list, and is newer than `since`.
  - `count_findings(body: str) -> Optional[int]`.
  - `check_state(checks: List[Check]) -> str`: `none`, `pending`, `failed` or `green`, counting only the latest-started check of each name; `fail` and `cancel` are failed, `pass` and `skipping` are green.
  - `STALE_HOURS = 48`; `checks_grace(environ) -> int` minutes (`JOSH360_CHECKS_GRACE`, default 30).

Rules, `count_findings`, first that applies:
1. Heading lines (`##` to `####`) that start with `Finding` or a number: the count of those that do not hold the word `optional`.
2. A phrase such as `3 findings` or `1 correctness finding` (a number, up to three words, then `finding` or `findings`): that number; `no findings` is 0.
3. Otherwise `None`. A caller treats `None` as 4, so an uncountable verdict gets another audit round, never one fewer.

Rules, `open-pr` (outcome `opened`; outputs `pr_url`, `pr_number`):
- Prefix the title with `<KEY>: ` when it does not start with the key. `screened()` the title and the body, whatever `phi` says.
- Refuse (`GateError`) when `branch` is `base_branch`, the worktree is dirty (Review Focus 7), or the branch is not ahead of `origin/<base_branch>`.
- `push`; reuse `open_pr_for(branch)` or `create_pr`; comment `dev_copy.pr_opened` on the ticket with `say(..., once=True)`. The counts come from `work_dir/evidence.md` (`0/0` when there is none, as for a Research ticket) and the head is seven characters.

Rules, `queue-audit` (outcome `queued`): `dev_review.queue`, then `write_cursor` with the pull request's head and `deps.now()`.

Rules, `review-state` (a wait; outputs `findings`, `issue_count`). Read the pull request, the cursor and what each row needs; a failed read, or no cursor, is `pending` with the reason. First row that applies:

| What it reads | Answer |
| --- | --- |
| The pull request is merged | `ready` |
| The pull request is closed | `blocked` |
| `TRIGGER` is on | `pending` |
| `BLOCKED` is on | `blocked` |
| `IN_PROGRESS` is on | `pending` |
| `CHANGES` is on and `verdict()` finds a comment | `changes`, with `findings` the comment's text and `issue_count` N (4 when it cannot be counted) |
| `CHANGES` is on and there is no such comment | `pending` |
| `READY` is on, `check_state` is `failed` | `checks_failed`, with `findings` the failing checks' names and `issue_count` 0 |
| `READY` is on, `check_state` is `green` | `ready` |
| `READY` is on, `check_state` is `pending` | `pending` |
| `READY` is on, `check_state` is `none` | `ready` when the grace has passed since the later of `queued_at` and the newest verdict comment, else `pending` |
| No review label | `pending` |

- Every `pending` with a readable cursor becomes `stale` when `deps.now()` is more than 48 hours after its `queued_at`. The script writes nothing.

Rules, `after-fix` (outcomes `requeue`, `relabel`, `checks_failed`):
- A Research ticket has no checks. Otherwise `dev_checks.run_all`; any failure writes the feedback files and answers `checks_failed`, and nothing is pushed or posted. A pass rewrites `evidence.md` for the new head.
- Refuse a dirty worktree (`GateError`). `push` when `dev_git.unpushed` is above 0.
- Read the pull request's labels now. Comment `dev_copy.fixes_pushed` on the pull request, unless its newest comment already says exactly that. The resolution is given only when `phi` is false and the screen passes it; otherwise it is saved to `work_dir/resolution.md` and the comment says `resolution withheld: patient data, see <path>`.
- `requeue` when the pull request carried `READY` (the fix was for failed checks) or `issue_count` is above 3: `dev_review.queue`, `write_cursor`. Otherwise `relabel`: remove `CHANGES`, remove and add `READY` (adding it is what starts CI), `write_cursor`.

- [ ] **Step 1: Write the failing tests** (`FakeGitHub`, a scratch repository, a fixed clock):
  - `open-pr`: `test_opens_and_comments_the_spec_copy`, `test_reuses_the_open_pull_request`, `test_title_gets_the_key`, `test_refuses_text_the_screen_flags`, `test_refuses_the_base_branch`, `test_refuses_a_dirty_worktree`, `test_refuses_nothing_to_push`, `test_run_twice_comments_once`.
  - `queue-audit`: `test_adds_trigger_and_writes_cursor`, `test_removes_only_terminal_labels` (`IN_PROGRESS` and `BLOCKED` stay), `test_creates_only_missing_labels`, `test_trigger_already_on_is_not_added_again`.
  - `review-state`: one test per row of the table; `test_stale_after_48_hours`; `test_marker_from_a_stranger_is_not_a_verdict` and `test_verdict_older_than_the_round_is_ignored` (Review Focus 2); `test_merged_by_hand_is_ready` and `test_closed_by_hand_is_blocked` (Review Focus 4); `test_failed_label_read_is_pending_not_empty`; `test_latest_check_of_a_name_counts`; `test_writes_nothing` (the work folder's files are byte-for-byte the same after each answer).
  - `count_findings`: `test_counts_finding_headings`, `test_optional_heading_not_counted`, `test_counts_from_the_verdict_phrase` (`**Verdict: 1 correctness finding.**` gives 1), `test_no_findings_is_zero`, `test_uncountable_is_none`.
  - `after-fix`: `test_three_findings_relabels_and_restarts_ci` (`READY` removed then added), `test_four_findings_requeues`, `test_uncounted_findings_requeue`, `test_checks_fix_requeues`, `test_failing_check_posts_nothing`, `test_refuses_a_dirty_worktree`, `test_resolution_withheld_when_phi`, `test_comment_ends_with_the_footer`, `test_never_removes_in_progress_or_blocked`, `test_research_ticket_runs_no_checks`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_review_gates.py"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all of `graphs/tests`, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`.
- [ ] **Step 5: Commit.**

### Task 11: Merge and cleanup gates

**Files:**
- Modify: `graphs/gates/merge-rule.py`, `graphs/gates/merge-pr.py`, `graphs/gates/pr-merged.py`, `graphs/gates/clean-up.py`, `graphs/gates/close-unmerged.py`, `graphs/gates/close-ticket.py`
- Test: `graphs/tests/test_dev_merge_gates.py`

Rules:
- `merge-rule` (input `repo`): `agent` when the registry system holding the repository's bare name has `merges: agent`; `josh` otherwise, an unknown repository included. It reads `deps.registry_path` and nothing else.
- `merge-pr` (inputs `repo`, `pr_number`; outcome `merged`): check the registry again itself and refuse a repository that is not `agent`. A merged pull request answers `merged` at once (Review Focus 4). Otherwise every one of these, read fresh, or `GateError` naming the first that fails: the pull request is open; it carries `READY` and none of `TRIGGER`, `IN_PROGRESS`, `CHANGES`, `BLOCKED`; `check_state` is `green` (at least one check). Then `merge_squash(number, head_sha)` and read the state back as `MERGED`.
- `pr-merged` (a wait; outcomes `merged`, `closed`): `MERGED` is `merged`, `CLOSED` is `closed`, anything else, a failed read included, is `pending`. It writes nothing and has no deadline.
- `clean-up` (outcome `cleaned`): the pull request must be merged. `dev_git.remove_worktree(clone, worktree, branch, pushed_head=<the pull request's head>)`; a refusal is a `GateError` with its reason, and nothing is removed. Then `delete_branch(branch)`. Run again after it worked, it answers `cleaned`.
- `close-unmerged` (outcome `cancelled`): the pull request must be closed and not merged. `remove_worktree` with the same `pushed_head`; a refusal keeps the worktree and branch and the summary says so (the run still ends). The remote branch is never deleted. Comment `dev_copy.cancelled` once, then move the ticket to Cancelled.
- `close-ticket` (new optional inputs `pr_url`, `ticket_type`; the list gains both): with `pr_url` it is the development mode, with none it is today's mode, unchanged. Development mode: `parse_pr_url`, read the pull request, refuse one that is not merged, comment `dev_copy.done_merged` (the merge commit at seven characters; `research=True` for a Research ticket) once, move to Done. `evidence_path` is not needed in this mode.

- [ ] **Step 1: Write the failing tests**: `test_merge_rule_agent_for_josh_360_style_entry`, `test_merge_rule_josh_by_default`, `test_merge_rule_unknown_repo_is_josh`; `test_merge_pr_merges_with_ready_and_green`, `test_merge_pr_refuses_where_agents_may_not_merge` (the spec's scenario "The graph merges only where agents may merge": `merge_squash` is never called), `test_merge_pr_refuses_without_ready`, `test_merge_pr_refuses_with_trigger_still_on`, `test_merge_pr_refuses_no_checks`, `test_merge_pr_refuses_a_red_check`, `test_merge_pr_already_merged_does_not_merge_again`, `test_merge_pr_passes_the_head_it_read`, `test_merge_pr_unconfirmed_merge_is_an_error`; `test_pr_merged_three_states`, `test_pr_merged_failed_read_is_pending`; `test_clean_up_removes_worktree_and_branches`, `test_clean_up_refuses_uncommitted_and_deletes_nothing`, `test_clean_up_refuses_a_commit_the_pull_request_lacks` (Review Focus 5), `test_clean_up_refuses_an_open_pull_request`, `test_clean_up_twice_is_cleaned`, `test_clean_up_remote_branch_already_gone`; `test_close_unmerged_cancels_and_keeps_the_remote_branch`, `test_close_unmerged_keeps_a_worktree_at_risk`, `test_close_unmerged_comment_is_the_spec_copy`; `test_close_ticket_old_mode_unchanged`, `test_close_ticket_development_copy`, `test_close_ticket_research_copy`, `test_close_ticket_refuses_an_unmerged_pull_request`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s graphs/tests -p "test_dev_merge_gates.py"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all of `graphs/tests`, then `python3 scripts/check.py`. Expected: PASS, `check.py: ok`. No file in `graphs/gates/` owned by JP-115 still says `not built yet`.
- [ ] **Step 5: Commit.**

### Task 12: Whole runs, proof and documents

**Files:**
- Create: `tests/test_development_graph.py`, `docs/proof/<build date>/JP-115/README.md` and its numbered `.txt` files
- Modify: `.github/workflows/test.yml`, `scripts/check.py`, `graphs/flows/README.md`, `graphs/gates/README.md` (if it lists stubs), `docs/design/feature-tree/tree.yaml` (S12), `docs/decisions.md`, `docs/superpowers/specs/2026-11-17-development-graph-design.md`

**Interfaces:**
- Consumes: every task above. The test follows `tests/test_nondev_graph_run.py`: the real walker and the real `graphs/flows/development.yaml`, with `gates.run_gate`, `gates.set_flag` and `gates.post_comment` replaced by in-process stand-ins that call each gate's `run` with `make_dev_deps` (a `FakeTicket`, a `FakeGitHub`, a scratch repository) and let `ready` and `no-loose-ends` pass.

Rules:
- Role steps are played by the test: it writes the spec to the work folder for `design`, commits a file in the worktree for `build`, and records the outcomes below.
- `test.yml` gains a step `python3 -m unittest discover -s graphs/tests` after "Fast checks" (CI skips those tests today). `scripts/check.py` parses every `graphs/gates/*.py` as Python 3.9, beside `graphs/gates/lib/`.
- Feature tree S12's `why` becomes: `Files written there outlive the worktree. The development graph keeps its working files in the run folder instead (JP-115).` Then `python3 scripts/feature_tree.py build` and `python3 scripts/architecture_page.py build`.
- The spec gains an "As built" section (and its Contents line): where the graph lives now, the input changes of Task 5, and each row of [Choices this plan makes](#choices-this-plan-makes). Its references to `docs/design/development-graph/` are put in the past tense.
- `docs/decisions.md` gains a row for any choice made while building that this plan did not make.
- The proof page is one screen: a table of the spec's seven scenarios, each with the test that proves it and the output file, then the laptop checks still owed. Output files: the checker and compile on the graph; the `test_development_graph.py` run above; `python3 -m unittest discover -s graphs/tests -p "test_dev_*.py" -v`; `scripts/check.py`.

- [ ] **Step 1: Write the failing tests** in `tests/test_development_graph.py`, the six dry walks of 17 November and four more:
  - `test_story_in_josh_360_is_merged_by_the_graph`: registry `merges: agent`; `harden` gives one kept defect, then passes; the audit asks for 2 changes, then is ready with a green check. Asserts: `next` printed `waiting` while the trigger label was on; the statuses the ticket was moved to, with repeats dropped, are Ready, Design/Planning, In Progress, Code Review, Validation, Done; `FakeGitHub` was merged once; the end is `finished`, score `success`; no question was ever parked; `saved/` holds the spec and the evidence, each with a `run_files` row and hash; the scratch repository's worktree folder is gone and `git status` in the clone shows no working file.
  - `test_bug_elsewhere_waits_for_joshs_merge`: registry `merges: josh`; `build` ends `needs_judgment`, `triage_question` answers (the answer is in `work/answers.md`), `review_plan` gives one cited defect, the build runs again. After the review is ready, `next` prints `waiting` at `await_merge` and nothing was merged; when the fake says `MERGED` the run finishes.
  - `test_research_ticket_runs_the_design_stretch_only`: `ask_design` and `approve_design` are parked and answered; no row exists for `build`, `verify`, `review_plan` or `cite_check`.
  - `test_designers_question_on_a_story_goes_back_to_triage`: the ticket is at Not Started with the flag on; the comment is the spec's copy with the question (`phi` false); no question was parked; the end is `return_question.returned`.
  - `test_builder_failing_three_times_reaches_josh`: `verify` fails three times; `build_stuck` is parked; `stop` ends the run `build_stuck.stop`, score `needs-josh`.
  - `test_five_findings_requeue_then_closed_unmerged`: 5 findings re-queue the audit; the second verdict is ready; `await_merge` sees `CLOSED`; the ticket is Cancelled; the end is `close_unmerged.cancelled`.
  - `test_ticket_routed_elsewhere_returns_early`.
  - `test_blocked_audit_asks_josh_and_requeue_goes_round_again`.
  - `test_phi_run_comments_hold_paths_only`: with `phi` true no comment on the ticket or the pull request holds the question or the resolution text.
  - `test_no_working_file_was_ever_in_the_worktree`: at every gate call the stand-in asserts that `spec.yaml`, `state.json`, `evidence.md`, `answers.md` and `pr-cursor.json` do not exist under the worktree.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests -t tests -p "test_development_graph.py" -v`. Expected: FAIL only where a gate and the graph disagree; fix the gate, not the graph.
- [ ] **Step 3: Make them pass**, then edit the workflow file, `scripts/check.py` and the documents.
- [ ] **Step 4: Run** `python3 scripts/check.py`. Expected: `check.py: ok (0 problem(s))`. Save the four outputs under `docs/proof/<build date>/JP-115/` and write its README.
- [ ] **Step 5: Commit, open the pull request** (title `JP-115 Build the development graph`, label `review:needs-agent-audit`), follow `docs/WORKFLOW.md` §4, merge on a green `suite`, and close JP-115 by mapping each scenario to its proof.

## Laptop checks owed after the build

None blocks the merge. Name them on JP-115 and on the proof page; each is one command or one look.

1. `gh` with Josh's login: creating a missing review label, adding and removing one through `gh api`, and `gh pr checks --json name,bucket,startedAt` on a pull request with no checks, with pending checks and with finished ones.
2. Adding `review:ready-for-human` with Josh's `gh` login starts the `suite` run in josh-360. (Added through the cloud's GitHub App on PR #39 it did not.)
3. `count_findings` against the verdict comments on three real josh-360 pull requests.
4. The Agent Status field id on a JP ticket is still `customfield_10453`.
5. One real run on a small JP ticket, once `ready` (JP-122) and `no-loose-ends` (JP-109) exist and JP-117 has bound the roles.

## Choices this plan makes

Each can be undone and is in `docs/decisions.md` (17 November 2026, JP-115).

| # | Choice | Why | How to undo |
| --- | --- | --- | --- |
| 1 | `work/spec.yaml` is written in YAML's JSON form | The laptop's Python has no YAML reader, and a hand-written reader for nested lists of shell commands would be fragile | Add a small YAML reader to `dev_spec.load` |
| 2 | The development graph works JP tickets only | The shared gates move and comment on JP tickets only; other spaces have their own workflows | Teach `move-ticket` the other spaces' statuses |
| 3 | A designer's question goes back as a comment and the flag, not as an edit to the ticket's Open questions | It is what JP-123 built and what triage's check C12 reads; the Jira library has no safe way to edit a description | Add a description edit to `lib/jira.py` |
| 4 | A wait writes its ledger row only when it ends, as step kind `gate` | No ledger schema change, and a wait that is still pending leaves no trace to replay | Add `wait` to the ledger's step kinds |
| 5 | An audit verdict whose findings cannot be counted is treated as 4 | The safe side is another audit round | Ask Josh instead |
| 6 | With ready-for-human and no checks reported after 30 minutes, the wait answers `ready`; `merge-pr` still refuses to merge without a green check | Most of Josh's repositories have no check that starts on the label, and the run would otherwise sit for 48 hours | Set `JOSH360_CHECKS_GRACE` higher |
| 7 | `lint-spec` writes its problems to `work/lint.md` | The designer's next run reads the work folder; a gate's summary reaches no session | Pass them as a step output |
| 8 | The repository's owner comes from the clone's `origin` remote | The registry holds bare repository names | Add owners to the registry |
| 9 | When two steps give an output the same name, the one that finished last wins | Today the walker gives the alphabetically last after a reload, which hands the fixer the hardener's findings | Give every output a unique name |
| 10 | A check that runs past the gate's time budget counts as failed | A stopped run needs Josh; a failed check goes back to the builder | Raise `JOSH360_GATE_TIMEOUT` on the laptop |

## Spec coverage

| The spec's "What the build does" | Task |
| --- | --- |
| 1. The `wait` step in the convention, the checker and the walker; the answers file | 1, 2, 3 |
| 2. Move the draft, compile it, delete the two draft tools | 5 |
| 3. Every new gate, tested on a scratch repository and a fake `gh`; the shared gates | 6 to 11 |
| 4. The registry's `merges` field; the `evidence` and `feedback` contracts | 4, 6 |
| 5. The dry run through `walker.py`, and the proof page | 12 |
| 6. The feature tree's S12 note, `graphs/flows/README.md`, the spec's "As built" | 5, 12 |

| The spec's scenario | Proved by |
| --- | --- |
| The graph passes the checker | `test_graph_passes_the_checker` (Task 5), and `scripts/check.py` in CI |
| Only the named points wait on Josh | Task 5's four ask tests; `test_story_in_josh_360_is_merged_by_the_graph` parks nothing |
| A dry run reaches the end | `test_story_in_josh_360_is_merged_by_the_graph` (Task 12) |
| A defect must cite the plan | `test_defect_quoting_nothing_is_dropped` (Task 9) |
| A designer's question on a build ticket goes back to triage | `test_designers_question_on_a_story_goes_back_to_triage` (Task 12); the question is in a comment (choice 3) |
| The working files outlive the worktree | `test_lint_refuses_spec_inside_a_worktree` (Task 6), `test_feedback_files_are_saved_at_the_end` (Task 3), `test_no_working_file_was_ever_in_the_worktree` (Task 12) |
| The graph merges only where agents may merge | `test_merge_pr_refuses_where_agents_may_not_merge` (Task 11), `test_bug_elsewhere_waits_for_joshs_merge` (Task 12) |

Rules 1 to 3 are `read-dev-ticket` and the entry gate (Task 8); 4 is Task 5's ask tests; 5 and 6 are `lint-spec` (Task 6); 7 is `check-review` and `cite-check` (Tasks 8, 9); 8 is `verify-build` (Task 9); 9 and 10 are the Global Constraints and Task 12's `phi` test; 11 is Task 10; 12 is Task 11; 13 is Review Focus 5; 14 is the checker, unchanged; 15 is Tasks 2 and 10 (`test_writes_nothing`).
