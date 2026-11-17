# Decisions

## Contents

- [How to use this file](#how-to-use-this-file)
- [How the build runs](#how-the-build-runs)
- [The question round](#the-question-round)
- [The phase 1 sitting](#the-phase-1-sitting)
- [The feature-tree review](#the-feature-tree-review)
- [The JP-146 review questions](#the-jp-146-review-questions)
- [The nine items once marked Proposed](#the-nine-items-once-marked-proposed)
- [Default choices made while building](#default-choices-made-while-building)

## How to use this file

This file holds Josh's decisions about Josh 360 until the ledger holds them. The first sections record the question round of 15 November 2026; `docs/vision-and-roadmap.md` states the same decisions in context and wins if the two differ.

When a question comes up while building and the choice can be undone, take the recommended option, add one row to the ticket's own file in `docs/decisions/` (see [Default choices made while building](#default-choices-made-while-building)), and carry on. Design questions that need Josh go to the phase's question sitting instead (JP-106 for phase 1). No patient data here; refer to such files by path only.

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
| PR review is Josh's laptop audit (16 November 2026) | A thread labels its PR `review:needs-agent-audit` and Josh's laptop automation (the action-triage PR audit) audits it and comments. No cloud review thread and no PR review watcher; the rest of the ceremony stands (`docs/WORKFLOW.md` §4). This answers question 1 in `docs/inventory/features.md`. |
| Instruction files | Written as `AGENTS.md`. |
| All graphs are built in phase 1 (16 November 2026) | Josh: "all graphs need to be phase 1". The ticket creation, triage and sign-off, and non-development graph builds (JP-121, JP-122, JP-123) moved from phase 2 to phase 1 and now block the phase 1 close (JP-120). The gates changed with them (Josh, 17 November 2026, JP-147): the forwarded-email run joins the gate to phase 2, and the gate to phase 3 is action-triage archived with its kept features in josh-360 plus the weekly review's first improvement ticket. |

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

## The phase 1 sitting

Josh answered the fourteen phase 1 design questions on 16 November 2026 (JP-106, `docs/design/questions-phase-1.md`). Each answer is also written into the design it came from.

| Date | Ticket | Question | Option taken | How to undo |
| --- | --- | --- | --- | --- |
| 2026-11-16 | JP-106 | One ledger file or two? (Josh's answer, Q1) | Two: `ledger.db` for facts, `cache.db` for rebuildable working tables. | Merge the cache tables into `ledger.db` before JP-107 merges. |
| 2026-11-16 | JP-106 | May the ledger keep any of Josh's own words? (Josh's answer, Q2) | Yes, one line: a session summary may copy the first line of the first message, 160 characters at most, after the patient-data check. This overrides JP-99's "no message text" criterion for that one line. | Drop the copied line and write it with the model call instead. |
| 2026-11-16 | JP-106 | Backups and retention (Josh's answer, Q3) | `ledger.db` kept for ever; 14 daily and 8 weekly compressed backups; per-message cost rows removed 90 days after copying. Each backup also goes to an Azure blob storage container, not OneDrive. | Stop the upload; the laptop copies remain. |
| 2026-11-16 | JP-106 | What is one category of question? (Josh's answer, Q4) | The asking step (`<graph>/<step>`) by default, split further on the details a step names; the approval card splits by system, ticket type, shape and action. | Collapse to one category per step. |
| 2026-11-16 | JP-106 | Which priority do the unassigned systems fall under? (Josh's answer, Q5) | `charta_services` under EQuIP; `fx-app-apps-services` and `fx-app-zus-services` under a new seventh standing priority, Internal Systems & Applications; `survey-services`, `training-services` and `synapse-pipelines` stay Unassigned. | Edit `priority` in `conventions/registry.yaml`, or remove the seventh priority from `conventions/priorities.yaml` and `STANDING_IDS` in `scripts/conventions.py`. |
| 2026-11-16 | JP-106 | What do PIMS, M&A clinical data transfer and AI scribing cover in Jira? (Josh's answer, Q6) | One TECH initiative each, as standing support that never closes (Josh, 17 November): TECH-25 PIMS support, TECH-26 M&A clinical data transfer support, TECH-27 AI scribing utilization support. Their epics relate to these. | Remove the keys from `conventions/priorities.yaml`. |
| 2026-11-16 | JP-106 | Does the daemon start the walker's headless sessions? (Josh's answer, Q7) | Yes. A daemon watches Jira for tickets in a given state and launches the graph when the conditions are met (for example a Ready ticket not in the backlog goes through triage). | Run the walker from Agent Manager only. |
| 2026-11-16 | JP-106 | Which new tickets come to Josh on the approval card? (Josh's answer, Q8) | Every input gets one card at first; the card relaxes by category through the three stages. | Option 2 or 3 in `docs/design/ticket-creation-graph.md`. |
| 2026-11-16 | JP-106 | Where do meeting action items go? (Josh's answer, Q9) | The Calendar tab stays (Josh has not agreed to retire it); items also become proposed tickets through the ticket creation graph once JP-121 is built. | Retire the tab after JP-121. |
| 2026-11-16 | JP-106 | Keep the Obsidian wiki? (Josh's answer, Q10) | Archive the wiki and its skills. | Restore them from the archive. |
| 2026-11-16 | JP-106 | Does Josh still use OpenCode? (Josh's answer, Q11) | Yes. The agent sync stays, moves to Bifrost model names, and runs when `~/.claude/agents` changes instead of hourly. | Go back to the hourly schedule. |
| 2026-11-16 | JP-106 | Retire the leftover tools? (Josh's answer, Q12) | Omnara disconnected; Tactic Remote hooks and the task-manager queue retire; QuickTasks is already gone ("quick tickets" noted as an idea); agent-deck decided in the feature-tree review. | Switch any of them back on before the phase-close deletion list. |
| 2026-11-16 | JP-106 | Bring back the rclone backup? (Josh's answer, Q13) | No. | Reinstall its job. |
| 2026-11-16 | JP-106 | Archive the 131 unused skills? (Josh's answer, Q14) | Josh picked the keepers on a picker page: 67 kept (his 64, plus `control-cli`, `deslop` and `grill-with-docs`, which kept skills name), 64 archived at the phase close. The lists are in `docs/inventory/laptop.md`, appendix. | Restore from the archive. |
| 2026-11-16 | JP-106 | How do action-triage, claude-360 and the MacBook automations relate to josh-360? (Josh, Q12 note) | They are melded into one application: kept features are extracted and rebuilt in josh-360 with one consistent look and codebase, not linked or nested. | Not expected to change. |

## The feature-tree review

Josh reviewed every call on the feature-tree page on 17 November 2026 (JP-143's page, written in by JP-145). `docs/design/feature-tree/tree.yaml` holds each call, Josh's reason and the reply to his comment, by node id.

| Question | Decision |
| --- | --- |
| What does a "headless" session mean? (A16) | Every session has a surface in Agent Manager (or whichever front end the platform uses) and runs without expecting Josh, except where the graph or harness allows a question. No hidden runs that need a workaround to reach. |
| Open in terminal and Send to Background? (A20, S7) | Retired: every session already lives in Agent Manager. |
| Phone bridge? (A31) | Retired: Josh will not use the platform from a phone. |
| Bifrost request labels and cost reconciliation? (A33, S8.4) | Labels retired. From Bifrost, only a yes/no signal that the provider received each request; no matching of Bifrost's estimated costs. |
| Prompt settings? (A7) | Replaced by N1, one configuration surface for reviewing and updating graphs as well as prompts. |
| How much of the Jira pickup daemon is reused? (A9) | It is scaffolding to judge against the design, never a reason to settle: the runner design keeps what serves it and rebuilds the rest. |
| Dashboard, sessions grid and Needs attention? (S4, S5, S6) | Later: views wait until the data architecture is hardened. When they return they are designed afresh for Josh's purposes, not ported; the current views were never sufficient, so only their features may be reused. |
| Session names and PR links? (S8.5) | Kept, on the ledger's session record (S2). |
| agent-deck? (D1, D2) | Josh removes it himself on the laptop. |

## The JP-146 review questions

Josh answered the five questions of the phase 1 review (JP-146) on 17 November 2026. JP-149 wrote them into the designs, the schema, the plans and the tickets.

| Question | Josh's answer | Where it is written |
| --- | --- | --- |
| 1. Fix the five ledger findings before JP-107 starts? | "Yes, wait for the 5 ledger fixes, then start." Done by JP-148. | JP-107 is blocked by JP-148 and JP-149. |
| 2. How strict is the patient-data rule, and may the backup go to Azure? | Every system may hold patient data. Data goes only through platforms his organisation owns or has a BAA with, and every current one qualifies. Nothing that identifies a patient is written to GitHub or Jira. The ledger avoids patient names, dates of birth, social security numbers and phone numbers; unique identifiers such as record numbers are fine. "I don't want our system to be inhibited at every turn by these guardrails but I do want to be responsible." This replaces JP-148's two patient-data rows below: there is no per-system flag, every session keeps its title, notes and first line after the screen, and the Azure copy is no longer held (JP-150 builds it). Adding a new connector or platform means confirming its BAA first. | `docs/design/data-model.md`, "Patient data" and "Storage"; `graphs/gates/lib/patient_data.py`; AGENTS.md, "Patient-data rule". |
| 3. Does Ready alone start work? | No: "Ready plus not in backlog." Ready tickets wait in the backlog, and Josh moves them out of the backlog into a sprint. | Triage spec, "Ready is not started"; non-development design, rule 16; JP-114 and JP-117. |
| 4. Are cloud sessions recorded? | No, and not later either: "Josh 360 is only meant to manage data about work and sessions completed on a local machine." The platform needs no awareness of cloud sessions. | `docs/design/data-model.md`, "Summary" and rule 17; JP-109 computes loose ends from the laptop only. |
| 5. Where do questions and approval cards reach Josh in phase 1? | In the action-triage desktop app's Needs you tab, working as it does today. Later phases design a unified interface from scratch; phase 1 only makes the framework and infrastructure solid and supports the fundamental features. | JP-114, JP-124 and JP-125. |

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

Each ticket writes its own file, `docs/decisions/JP-<n>.md`, so two pull requests never edit the same lines (JP-153). The folder's README (`docs/decisions/README.md`) has the row format and the commands; `python3 scripts/decisions.py list` prints every row. Do not add rows to this file.
