# Workflow config

The per-project values the workflow skills read. The rules themselves are in `docs/WORKFLOW.md`.

| Value | Setting |
|---|---|
| Owner | Josh (GitHub `joshgilpatrick`) |
| Repo | joshgilpatrick/josh-360, default branch `main` |
| Tracker | Jira, site `eventuswh-analytics.atlassian.net` (cloudId `81f17c43-bda4-48e1-a18c-6074cdee729d`), project `JP` ("Josh Projects", team-managed), label `josh-360`. Every Josh 360 ticket sits under the epic JP-94. |
| Phase | The `Phase N:` prefix on the ticket summary (the JP-94 tickets already carry it). No fix versions. Current phase: Phase 1 (Phase 0 is JP-95 and JP-134). Each phase ends with its close ticket (JP-120, JP-129, JP-133). |
| Statuses | Not started = `Not Started`, then `Ready` once a separate agent signs the ticket off → design work = `Design/Planning` → building = `In Progress` → ready for review = `Code Review` (PR labelled `review:needs-agent-audit`) → ready for Josh = `Validation` (PR labelled `review:ready-for-human`) → `Done`. `Cancelled` for dropped work. |
| Transitions (any status to any, no required fields) | Not Started `3`, Ready `11`, Design `5` (to Design/Planning), In Progress `21`, Code Review `31`, Validation `2`, Done `4`, Cancel `6` |
| Words | Phase = summary prefix `Phase N:`. Feature = the Epic (JP-94 for all Josh 360 work). Ticket = Story, Task or Bug; `Research` for investigation and design tickets; Subtask for a split. Type: Bug = Bug; Feature = Story; Improvement = Story or Task plus label `improvement`. Block = issue link "Blocks" ("is blocked by"). Acceptance criteria = a `gherkin` code block in the description (JP has no acceptance-criteria field). |
| Issue type ids | Epic 10297, Story 10298, Task 10300, Bug 10299, Subtask 10296, Research 10385 |
| Ticket ids | `JP-<n>`; branches `JP-<n>-<slug>`, created by the agent even in a cloud session (the `claude/...` branch is a fallback only when the push is refused); thread, session and PR titles start with `JP-<n>`; see `conventions/tickets.md` |
| Branch names | Key first, then a short slug: `JP-151-branch-names` (`/` after the key is also read by every script). Fixed names with no ticket: `main`, `laptop-status`, `laptop-pause`. |
| Models | design and planning `claude-opus-5-5`; code and review `claude-sonnet-5-5` |
| Merges | features: the build thread, after the full review ceremony and a green `suite` check; bugs with no design call: the fix thread, the same way. This covers josh-360 only; PRs to Josh's other repos wait for the phase close. |
| Proof surfaces | None yet: josh-360 has no UI until phase 3 (JP-130, JP-131). Until then, proof is test or command output saved under `docs/proof/`. Add surfaces here (for example desktop 1440×900) when the dashboard lands. |
| Run the app | Nothing with a screen yet. The laptop side (JP-105): `python3 laptop/install.py --dry-run`, `python3 laptop/run_jobs.py --list`, and `python3 laptop/status.py show` to read what the laptop has installed. |
| Tests | full: `python3 scripts/check.py` (the checks, then every test in `tests/` with stdlib unittest); fast: `python3 scripts/check.py --fast`. Install `requirements.txt` first (PyYAML, for `scripts/conventions.py`); the laptop tests need only the standard library. Tickets that add code add tests under `tests/`; `.github/workflows/test.yml` already runs them. Session Atlas (`apps/session-atlas`, Node 22.18 or newer) has its own: `npm ci`, `npm run typecheck` and `npm test` inside that folder, which CI also runs. `scripts/check.py` also runs the graph checker (`python3 graphs/tools/check_graph.py`) and, without `--fast`, its tests (`python3 -m unittest discover -s graphs/tests`). |
| CI setup | `pip install -r requirements.txt` (PyYAML, for `scripts/conventions.py`) on Python 3.12, plus Node 22 for `apps/session-atlas` and the hook tests, `ubuntu-latest` |
| Boards | `docs/design/views/<view>/` with a README |
| Proof files | `docs/proof/YYYY-MM-DD/JP-<n>/` (not `deliverables/`, which Josh's global rules retire) |
| Decisions | Choices that can be undone take the recommended option and go in the ticket's own file, `docs/decisions/JP-<n>.md`. Design questions are batched to Josh once per phase (JP-106 for phase 1). |
| Needs Josh's confirmation in the thread | a permanent deletion (files, branches with unmerged work, tickets, data); a write to a shared database or to an app other people use |
| Never a test or deploy target | any Eventus production database or shared app (Synapse, Apps SQL, Bifrost logs, Snowflake, Jira automation, other people's repos); tests use made-up sample data |
| Deploy | Merging to `main` installs on the laptop within about 10 minutes (JP-105): the `follow` job moves `~/.josh-360/repo` to `main`, runs `laptop/install.py`, and reports on the `laptop-status` branch. Pause with a `laptop-pause` branch, or `laptop/pause.py on` on the laptop. Laptop-side code must run on Python 3.9 with the standard library only. |
