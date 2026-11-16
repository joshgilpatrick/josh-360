# Decisions

## Contents

- [How to use this file](#how-to-use-this-file)
- [How the build runs](#how-the-build-runs)
- [The question round](#the-question-round)
- [The nine items once marked Proposed](#the-nine-items-once-marked-proposed)
- [Default choices made while building](#default-choices-made-while-building)

## How to use this file

This file holds Josh's decisions about Josh 360 until the ledger holds them. The first sections record the question round of 15 November 2026; `docs/vision-and-roadmap.md` states the same decisions in context and wins if the two differ.

When a question comes up while building and the choice can be undone, take the recommended option, add one row to [Default choices made while building](#default-choices-made-while-building), and carry on. Design questions that need Josh go to the phase's question sitting instead (JP-106 for phase 1). No patient data here; refer to such files by path only.

## How the build runs

Decided by Josh on 15 November 2026.

| Decision | Detail |
| --- | --- |
| Agents may merge to josh-360 on their own | The passphrase rule in Josh's global instructions does not apply to this repository, and still applies everywhere else. |
| Josh is needed only for permanent destruction | Reversible steps need nobody: files, branches, pull requests, switching a job off, archiving a store. |
| Cloud first | Most work runs in cloud sessions on made-up sample data. A laptop step runs only when it has to, and is named in its ticket in advance. |
| Five sittings with Josh | The laptop hookup, the phase 1 design questions, and the close of each of the three phases. |
| The laptop is connected once | After the hookup, an install reaches the laptop by merging to josh-360. |
| Design questions are batched | Collected with a recommendation each and put to Josh once per phase. Builds that do not wait on an answer carry on. |
| Undoable build-time choices | The agent takes its recommended option, records it in this file and carries on. Only a permanent deletion or a write to something shared stops the work. |
| What waits for the close of a phase | Merges to Josh's other repositories, deletion lists and proof pages. |
| Instruction files | Written as `AGENTS.md`. |

## The question round

Josh settled every open question on 15 November 2026.

| Question | Decision |
| --- | --- |
| Has the drafted development pipeline run on a real ticket? | No. The development graph is built new from the 22-step draft, and the sprint skill keeps running until the graph replaces it. |
| Where does the "needs you" queue appear? | The Needs you tab in action-triage, plus a Jira flag on the ticket. A question stays until Josh answers it, and the tab becomes the one place for agent decisions. |
| Where is DevEx work ticketed? | The JP space. |
| What does the Linear convention look like? | Linear keeps the using-linear convention. Personal work is designed in phase 3. |
| Where do weekly priorities live? | They are tickets or epics Josh marks in Jira. How they are marked is designed with the dashboard. |
| Does Josh approve the shape of a parent and its children first? | Yes, before anything is created. |
| How does ticket creation choose the space and the parent epic? | From written rules in the system registry. JP is used when nothing matches. |
| What does the duplicate check do with a match? | An open match gets a comment and the agent stops. A Done or Cancelled match gets a new ticket linked to the old one. A new comment notifies every session working on that ticket. |
| Which parts of Session Atlas and action-triage carry over? | Most features are kept, decided per feature in the inventory. The code of both moves into josh-360, and the old repositories are archived (not deleted) once the move is proven. |
| How do work and personal stay separate across two machines? | Each machine keeps its own ledger for now. The rest is designed in phase 3. |
| What does the dashboard show? | Deferred to the phase 3 design ticket. |
| How does the system improve itself? | As written in the vision's "How the system measures and improves itself": model-free facts per session, one small debrief call per session that earns one, a weekly review of the ledger that looks for repeats, and threshold scripts Josh can edit. The system may make itself better without Josh, and may never reduce his oversight without him. |

## The nine items once marked Proposed

All nine were accepted on 15 November 2026, so nothing in the vision is still Proposed.

1. Stop Session Atlas's per-turn summaries.
2. One header on every graph file, with a checker.
3. Design tickets use the Research type.
4. The fixes for the three pipeline gaps (one "needs you" queue, scripts move Jira status, working files are saved with the run).
5. Retiring means switch off and archive; permanent deletions go in one list per phase.
6. One startup list in macbook-automations for every background service.
7. No patient data in the ledger, the summaries or the decision records.
8. The vision and roadmap is committed to josh-360.
9. How the build runs (the section above).

## Default choices made while building

One row per choice: the date, the ticket, the question, the option taken, and how to undo it.

| Date | Ticket | Question | Option taken | How to undo |
| --- | --- | --- | --- | --- |
| 2026-11-16 | JP-95 | The ticket says not to add a `CLAUDE.md`, but JP-134 already added `CLAUDE.md` as a link to `AGENTS.md` so Claude Code reads it. Keep the link? | Keep it. It is a link, not a second instruction file, and Josh's global rules use the same pattern. | Delete the `CLAUDE.md` link. |
| 2026-11-16 | JP-95 | The vision, source notes and `docs/proof/` already existed on `main` from JP-134. Rewrite them? | No. JP-95 adds only what was missing and checks the rest. | Not needed. |
| 2026-11-16 | JP-97 | The coordinator dispatched JP-97 while it was still Not Started, with no separate Ready sign-off. Wait for one? | Start. A judgement call: the ticket's only open questions are the ones it exists to answer, and a feature list is closest to the exception `docs/WORKFLOW.md` §1.5 makes for "a ticket whose purpose is to produce a spec, design or plan". Noted on the ticket. | Move JP-97 back to Ready and have a separate agent sign it off. |
| 2026-11-16 | JP-97 | action-triage and Session Atlas both send a session to the background. Which survives? | Session Atlas's `claude --bg --resume`, the public command, over action-triage's supervisor job file (`docs/inventory/features.md`, A20 and S7). | Keep action-triage's version in JP-124 instead. |
| 2026-11-16 | JP-97 | Should Session Atlas's Needs attention list merge into action-triage's Needs you tab? | No. Needs you holds decisions for Josh; Needs attention holds system health (stuck jobs, missing folders). Its focus reasons go with the focus summaries (S6). | Merge the two lists in JP-125. |
| 2026-11-16 | JP-97 | Which copy keeps the files a session made: action-triage's archive or Session Atlas's artifact manager? | The artifact manager (S11), with the durable output folder (S12). action-triage's History tab reads it (A24). | Keep action-triage's `session-files/` archive in JP-124. |
| 2026-11-16 | JP-98 | Branch names: `KEY/slug` (Josh's global rules, `using-jira`) or `KEY-slug` (action-triage's daemon, `docs/WORKFLOW.md`)? | Both: the key comes first, then `/` or `-`. `/` for a branch made by hand. Scripts accept both. | Pick one in `conventions/tickets.md`, "Branches", and the config's Ticket ids row. |
| 2026-11-16 | JP-98 | Which priority does each system fall under, when Jira does not say? | Seeded from its Jira labels and epics; a system with no clear owner among the six is `unassigned`, not forced into one. Josh confirms the rows at JP-106. | Edit `priority` in `conventions/registry.yaml`. |
| 2026-11-16 | JP-98 | What does each priority cover in Jira? | Seeded from the open epics in AD, CI and JP and the TECH initiatives. An area is mapped only where one priority clearly owns it (EHR administration, Clinical quality programs, Automation and AI enablement); PIMS, M&A and AI scribing cover nothing yet. Josh confirms at JP-106. | Edit `covers` in `conventions/priorities.yaml`. |
| 2026-11-16 | JP-98 | Where do action-triage tickets go, given some sit in AD (AD-307, AD-309)? | JP, as DevEx, under the decision that DevEx tickets live in JP. Existing AD tickets are not moved. | Set `jira_space: AD` for action-triage in the registry. |
| 2026-11-16 | JP-98 | Which epic is a system's default parent? | Only an epic with an end. Open-ended epics the department convention retires are never defaults, so most systems have none and their tickets stand alone with their area. josh-360's default is JP-94. | Set `default_epic` in the registry. |
| 2026-11-16 | JP-98 | Where do the registry's folder paths come from? | Paths named in Josh's repositories (action-triage, claude-harness, macbook-automations), following the laptop's `~/Development/active/<name>` pattern, where a hyphenated repository has an underscored folder. The PR #5 audit, run on the laptop, corrected josh-360's folder to `josh_360` and removed athena_automations' folder, which is not there; the rest are not checked yet, and JP-105 can. | Correct `folders` in the registry. |
| 2026-11-16 | JP-98 | How do the YAML files get read? | PyYAML, installed from `requirements.txt` locally and in CI. | Replace the files with JSON and drop the requirement. |
| 2026-11-16 | JP-98 | Who moves ticket statuses before the walker exists? | The thread doing the work, at the fixed events listed in `conventions/tickets.md`, never by judgment. | Change the table in `conventions/tickets.md`, "Statuses and who moves them". |
| 2026-11-16 | JP-105 | Where does Josh 360 live on the laptop? | One folder, `~/.josh-360/`: the laptop's own copy of the repo in `repo/`, plus `state/`, `logs/` and the pause file. The copy is separate from any clone Josh works in, so his edits never block an install. | Change `JOSH360_HOME` in the macbook-automations plist and the path in the claude-harness hook entries. |
| 2026-11-16 | JP-105 | How often does the laptop look for changes? | The runner every 5 minutes; `follow` every 10 minutes. | Edit `StartInterval` in the plist, or `every` in `jobs.yaml`. |
| 2026-11-16 | JP-105 | What does the laptop follow? | `main` by name, not GitHub's default branch, which still pointed at an old branch on 16 November. | Change `MAIN_BRANCH` in `laptop/common.py`. |
| 2026-11-16 | JP-105 | How are hooks loaded from josh-360? | One dispatcher entry per hook event in the claude-harness settings, which runs every executable file in `hooks/<Event>/`. A plugin was the other option; it was not chosen because Claude Code copies plugins into a cache that needs its own update step. | Remove the entries the claude-harness script added. |
| 2026-11-16 | JP-105 | What if an install fails? | The copy goes back to the last good commit and the status says `failed`. The next pass tries again. | Not needed. |
| 2026-11-16 | JP-105 | How is the laptop paused? | Either the file `~/.josh-360/PAUSED` (`laptop/pause.py on`), or a branch named `laptop-pause` on GitHub, so a cloud session can pause it too. | Delete the file or the branch. |
| 2026-11-16 | JP-105 | Does a status push happen on every pass? | No. Only when the installed commit, `main` or the result changes, or once a day as a heartbeat, so the branch does not grow by 144 commits a day. | Change `worth_pushing` in `laptop/status.py`. |
| 2026-11-16 | JP-96 | The inventory needs one laptop run (JP-105's sitting), but JP-99 and JP-100 wait on JP-96. Hold the whole ticket for the run? | No. The cloud inventory merges now and the ticket waits in Validation; a follow-up pull request adds the run's output, after which the ticket is Done. JP-99 and JP-100 can start from the merged inventory. | Hold the merge until the run returns. |
| 2026-11-16 | JP-96 | Where does a dismantled item go? | `~/Archive/josh-360-retired/<date>/<item>/` on the laptop, with a one-line README saying how to put it back. | Pick another folder before the first item is archived. |
| 2026-11-16 | JP-96 | Several verdicts depend on Josh (Obsidian wiki, OpenCode, leftover tools). Wait for him? | No. Each verdict takes the recommended option; the six questions go to the JP-106 sitting, listed in `docs/inventory/laptop.md`. | Change the verdict when Josh answers. |
| 2026-11-16 | JP-96 | The script's tests need a runner. Add pytest? | No. The standard library's `unittest`, so CI and the laptop's Python 3.9 need nothing installed. | Switch to pytest if a later ticket wants it. |
| 2026-11-16 | JP-96 | The JP-105 sitting finished without the inventory run. Ask Josh to run it by hand? | No. It runs once as the JP-105 job `inventory` (`every: once`, `report: true`), the return path JP-105 built for it, so Josh does nothing. As a background job it skips the folders macOS may guard with a privacy prompt (iCloud, OneDrive, Desktop, Documents, Downloads), and any symlink that leads into them, since no one is there to answer one, and it does not run `brew`, which writes its own cache (found by the PR #11 audit). | Remove the job and run `python3 scripts/laptop_inventory.py --out ~/josh-360-inventory.json` by hand. |
| 2026-11-16 | JP-101 | Where do the graph checker and graph files live? | `graphs/tools/check_graph.py` (the walker will sit beside it); one graph per `graphs/flows/<graph>.yaml`, file name = graph id. `scripts/check.py` runs the checker and its tests, so CI's `suite` covers them. | Move the files and update `scripts/check.py` and `graphs/CONVENTION.md`. |
| 2026-11-16 | JP-101 | Which words name a step's three kinds and its access? | Step kinds `role`, `gate` (a gate script, as the vision says) and `ask` (Josh is asked). Access `read`, `josh`, `shared`. Josh's drafted Paseo file used `gate` for a human question and `script` for a script, so converting it renames those. Josh's own JP ticket and his repositories count as `josh`; anything other people use is `shared`. | Rename the keys in `CONVENTION.md`, the checker and the samples. |
| 2026-11-16 | JP-101 | How does a loop "end at a human"? | Every `goto` names `max_loops` and an `at_limit` ask step, written out rather than implied. An ask used only at a limit is marked `on_limit_only: true`. | Make `at_limit` optional with a graph-wide default ask. |
| 2026-11-16 | JP-101 | What counts as an orchestrator key? | A strict schema (any key it does not list is refused) plus a named list of runner keys (`model`, `mode`, `isolation`, `manager`, `providers`, `timeout` and others) that get a clearer message pointing to `graphs/bindings/<tool>/`. Models are named only in `graphs/tiers.yaml`. | Edit `ORCHESTRATOR_KEYS` and the schema in the checker. |
| 2026-11-16 | JP-101 | How is "a reviewer can only cite the plan" enforced? | A role marked `reviewer: true` must be followed by a gate step that `needs` it; that gate drops defects that do not quote the spec (as `check-review.py` in Josh's draft does). | Drop the rule from the checker. |
| 2026-11-16 | JP-101 | How is "cheapest tier" enforced? | A step may lower its role's tier but never raise it, and the `gate` tier is only for roles that only read and judge. `tiers.yaml` takes Josh's drafted defaults: Haiku 5.5 (high effort, Sonnet fallback), Sonnet 5.5, Opus 5.5 (high effort). | Edit `graphs/tiers.yaml` or the two checks. |
| 2026-11-16 | JP-101 | The checker reads YAML. Which parser? | PyYAML, from the repository's `requirements.txt` (shared with JP-98) and installed by CI. Its loader reads `on`, `off`, `yes` and `no` as words and refuses a key written twice. | Swap the loader in `check_graph.py`. |
| 2026-11-16 | JP-101 | How does the checker know a shared write runs only on a yes? (review of PR #6) | The approving ask lists `approves_on` (the choices that mean yes, never all of them); the shared step's `when` names that ask with only those choices; the ask takes no `when`, so it cannot be skipped. | Drop the `approves_on` and `when` checks from rule 6. |
| 2026-11-16 | JP-101 | The convention names four contracts (intake record, spec, evidence file, feedback files). Write them now? | No. Each is written with the first graph that uses it (JP-102, JP-103, JP-104 and the development graph's ticket). `graphs/contracts/` holds only its README until then. | Write them in `graphs/contracts/` ahead of the graphs. |
| 2026-11-16 | JP-138 | Which effort does each tier get now that every entry must name one? | Josh's rule (16 Nov): every tier and fallback gives a model and an effort. `cheap` (Haiku 5.5) stays `high` and `gate` (Opus 5.5) stays `high`. `mid` (Sonnet 5.5) is `medium`, the suggested default. The Sonnet 5.5 fallback under `cheap` is `medium` too: it replaces Haiku only when Haiku is out of tokens, and Sonnet needs less effort than Haiku for the same mechanical work. | Edit `effort` in `graphs/tiers.yaml`. |
| 2026-11-16 | JP-138 | Does a step choose its tier or effort by how hard the task is, or step up a tier after a failure? | No. Josh declined both for now; steps still choose a model by role and tier alone, and the mapping gives the effort. | Add a rule to `graphs/CONVENTION.md` and the checker in a later ticket. |
| 2026-11-16 | JP-139 | How many times may one role step run in one run of a graph? | By tier: `cheap` (Haiku) 5, `mid` (Sonnet) 3, `gate` (Opus) 2, the first run included. Josh's numbers (16 Nov), set as `max_runs` in `graphs/tiers.yaml`. | Edit `max_runs` in `graphs/tiers.yaml`; the checker reads it. |
| 2026-11-16 | JP-139 | Is the count by tier or by the model that answered? | By tier. A fallback model that answers for an out-of-tokens first model still counts against its tier's cap. | Rewrite "The run cap" in `graphs/CONVENTION.md` and the walker. |
| 2026-11-16 | JP-139 | Where does `max_runs` sit in `tiers.yaml`? | In a `max_runs` mapping beside `tiers` (tier name to number), so the lists JP-138 made stay as they are and nothing else that reads them changes. | Move it into each tier and update the checker. |
| 2026-11-16 | JP-139 | Which role steps does a loop run again, for the checker? | The `goto` target and every step that `needs` it, except the steps that need the loop's own step (they cannot have run yet). A step skipped by its `when` still counts, so the check is an upper bound and may refuse a loop that would have fitted. The checker holds each `goto` on its own; adding up several loops that share a step needs the run's outcomes, so that is the walker's rule (JP-114). | Narrow the set in `_reruns` in `graphs/tools/check_graph.py`. |
| 2026-11-16 | JP-139 | What does Josh's yes at the limit buy? | Exactly one more run of that step, counted like any other, so the cap asks again next time. Written as the walker's rule in `graphs/CONVENTION.md`; JP-114 builds it. | Change the walker rule in "The run cap". |
| 2026-11-16 | JP-140 | What is the header field called, and what is in it? | `end_states`: a mapping from each end of the graph to `success`, `neutral` or `needs-josh`. The ends are `finished` (the run ran out of steps and passed the exit gate; every graph has it) and `<step>.<outcome>` for each outcome whose `on` is `end`. Dotted names, not bare outcome names, because two steps can have an outcome of the same name. The JP-102 and JP-103 designs name their ends by outcome (`created`, `dropped`, `ready`, `parked`); each becomes `<step>.<outcome>` when its graph file is written. | Rename the field in `graphs/CONVENTION.md`, `HEADER_FIELDS` and the fixtures. |
| 2026-11-16 | JP-140 | The ticket says the exit gate's outcomes are ends too. Are they? | Not by name. A graph file does not list a gate script's outcomes, so the checker cannot check them; a passing exit gate is the one end `finished`, and a refusing exit gate ends the run as `exit_refused`, a reserved name that every graph shares: it always scores `needs-josh` and is never written in `end_states` (the checker refuses it there), so the walker has one fixed value to record (found by the review of PR #13). A graph that wants two scores for finished runs ends them in two steps before the exit gate. | Add `outcomes` to the exit gate's declaration and let `end_states` name them. |
| 2026-11-16 | JP-140 | Does adding a required header field raise `convention` to 2? | No. `graphs/flows/` held no graph file on `main`, so none became invalid; the JP-102, JP-103 and JP-104 graph files add `end_states` when they are written. | Raise `convention` and move each file across, as "Changing this convention" says. |
| 2026-11-16 | JP-140 | What is `graph_version`? | The last commit that changed `graphs/flows/<graph>.yaml`, so unrelated commits do not change it. It does not cover a change to a role, agent or gate script the graph names. | Include the parts' commits in the value when comparing runs needs it (open question for Josh at JP-106). |
| 2026-11-16 | JP-140 | Does the triage design's "any run that reached an ask counts as needing Josh" fit? | Not as an end score: an ask can come before a `success` end. "Share of runs that reach an ask" is already a measure from ledger rows (the `ask` steps), so it needs no field here. | Add a per-graph rule that scores a run `needs-josh` once it reaches an ask. |
| 2026-11-16 | JP-104 | Which kinds of non-development work come first? | `research`, `doc`, `email` and `misc` from action-triage's `spec.type` list, the four the Email Research Desk already handles; `meeting` later. A ticket with no spec property counts as `research`. | Change the agent map in `graphs/flows/non-development.yaml`. |
| 2026-11-16 | JP-104 | Where do non-development deliverables live? | `~/Development/active/.artifacts/<system>/` (flat, ticket key first in every file name; `josh-projects` with no system), beside an evidence file and saved queries. Outside every repository and worktree, and the folder Josh's rules already use for files made for his review. | Change `check-deliverable` and the researcher's instructions. |
| 2026-11-16 | JP-104 | How is a deliverable with patient data handled? | Read freely; written only to the deliverable, evidence and saved queries in that folder; ticket, email, ledger and resolution give the path only; `share` refuses. | Not expected to change; it follows Josh's patient-data rule. |
| 2026-11-16 | JP-104 | Where does the non-development spec live? | `docs/design/non-development-graph.md`, the path JP-104 and JP-123 both name, not `docs/superpowers/specs/`. | Move it and update both tickets. |
| 2026-11-16 | JP-104 | Which status does a non-development Research ticket take while worked? | In Progress, not Design/Planning, which stays for tickets whose deliverable is a spec, design or plan. The plan updates `conventions/tickets.md`. | Map the work stretch to Design/Planning. |
| 2026-11-16 | JP-104 | Where does the draft graph live? | In the real tree (`graphs/flows/non-development.yaml` with real role, agent and contract files and refusing gate stubs), as JP-103's draft does, so CI checks it. | Move it under `docs/design/` and check it with `--root`. |
| 2026-11-16 | JP-104 | May the graph email anyone but Josh? | No. After Josh's "accept and share", `share` puts a draft in his own mailbox and he presses Send; the step is still marked shared and approved. | Let `share` send after the yes. |
| 2026-11-16 | JP-104 | Does the graph work tickets outside JP? | No; CI and AD tickets are returned to triage, since writing to them is a shared write. | Allow them with an approval step before every write. |
| 2026-11-16 | JP-104 | Does the non-development graph replace the Email Research Desk's worker? (Josh's answer, question 1) | Yes: the desk keeps its watcher and its Josh-only mailer, and the graph does the research. | Keep the desk worker and route only other tickets to the graph. |
| 2026-11-16 | JP-104 | Does every deliverable wait for Josh's sign-off? (Josh's answer, question 2) | No, not an emailed ask: it closes once the answer is emailed to Josh, and his reply to the email reopens it; otherwise it stays closed. Every other ticket waits for sign-off. | Remove `pick_sign_off` and `close_emailed` from the graph. |
