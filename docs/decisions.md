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
| 2026-11-16 | JP-101 | Where do the graph checker and graph files live? | `graphs/tools/check_graph.py` (the walker will sit beside it); one graph per `graphs/flows/<graph>.yaml`, file name = graph id. `scripts/check.py` runs the checker and its tests, so CI's `suite` covers them. | Move the files and update `scripts/check.py` and `graphs/CONVENTION.md`. |
| 2026-11-16 | JP-101 | Which words name a step's three kinds and its access? | Step kinds `role`, `gate` (a gate script, as the vision says) and `ask` (Josh is asked). Access `read`, `josh`, `shared`. Josh's drafted Paseo file used `gate` for a human question and `script` for a script, so converting it renames those. Josh's own JP ticket and his repositories count as `josh`; anything other people use is `shared`. | Rename the keys in `CONVENTION.md`, the checker and the samples. |
| 2026-11-16 | JP-101 | How does a loop "end at a human"? | Every `goto` names `max_loops` and an `at_limit` ask step, written out rather than implied. An ask used only at a limit is marked `on_limit_only: true`. | Make `at_limit` optional with a graph-wide default ask. |
| 2026-11-16 | JP-101 | What counts as an orchestrator key? | A strict schema (any key it does not list is refused) plus a named list of runner keys (`model`, `mode`, `isolation`, `manager`, `providers`, `timeout` and others) that get a clearer message pointing to `graphs/bindings/<tool>/`. Models are named only in `graphs/tiers.yaml`. | Edit `ORCHESTRATOR_KEYS` and the schema in the checker. |
| 2026-11-16 | JP-101 | How is "a reviewer can only cite the plan" enforced? | A role marked `reviewer: true` must be followed by a gate step that `needs` it; that gate drops defects that do not quote the spec (as `check-review.py` in Josh's draft does). | Drop the rule from the checker. |
| 2026-11-16 | JP-101 | How is "cheapest tier" enforced? | A step may lower its role's tier but never raise it, and the `gate` tier is only for roles that only read and judge. `tiers.yaml` takes Josh's drafted defaults: Haiku 5.5 (high effort, Sonnet fallback), Sonnet 5.5, Opus 5.5 (high effort). | Edit `graphs/tiers.yaml` or the two checks. |
| 2026-11-16 | JP-101 | The checker reads YAML. Which parser? | PyYAML 6.0.3, pinned in `graphs/requirements.txt` and installed by CI. Its loader reads `on`, `off`, `yes` and `no` as words and refuses a key written twice. | Swap the loader in `check_graph.py`. |
| 2026-11-16 | JP-101 | How does the checker know a shared write runs only on a yes? (review of PR #6) | The approving ask lists `approves_on` (the choices that mean yes, never all of them); the shared step's `when` names that ask with only those choices; the ask takes no `when`, so it cannot be skipped. | Drop the `approves_on` and `when` checks from rule 6. |
| 2026-11-16 | JP-101 | The convention names four contracts (intake record, spec, evidence file, feedback files). Write them now? | No. Each is written with the first graph that uses it (JP-102, JP-103, JP-104 and the development graph's ticket). `graphs/contracts/` holds only its README until then. | Write them in `graphs/contracts/` ahead of the graphs. |
