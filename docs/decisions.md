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
| 2026-11-16 | JP-105 | Where does Josh 360 live on the laptop? | One folder, `~/.josh-360/`: the laptop's own copy of the repo in `repo/`, plus `state/`, `logs/` and the pause file. The copy is separate from any clone Josh works in, so his edits never block an install. | Change `JOSH360_HOME` in the macbook-automations plist and the path in the claude-harness hook entries. |
| 2026-11-16 | JP-105 | How often does the laptop look for changes? | The runner every 5 minutes; `follow` every 10 minutes. | Edit `StartInterval` in the plist, or `every` in `jobs.yaml`. |
| 2026-11-16 | JP-105 | What does the laptop follow? | `main` by name, not GitHub's default branch, which still pointed at an old branch on 16 November. | Change `MAIN_BRANCH` in `laptop/common.py`. |
| 2026-11-16 | JP-105 | How are hooks loaded from josh-360? | One dispatcher entry per hook event in the claude-harness settings, which runs every executable file in `hooks/<Event>/`. A plugin was the other option; it was not chosen because Claude Code copies plugins into a cache that needs its own update step. | Remove the entries the claude-harness script added. |
| 2026-11-16 | JP-105 | What if an install fails? | The copy goes back to the last good commit and the status says `failed`. The next pass tries again. | Not needed. |
| 2026-11-16 | JP-105 | How is the laptop paused? | Either the file `~/.josh-360/PAUSED` (`laptop/pause.py on`), or a branch named `laptop-pause` on GitHub, so a cloud session can pause it too. | Delete the file or the branch. |
| 2026-11-16 | JP-105 | Does a status push happen on every pass? | No. Only when the commit, result or reason changes, or once a day as a heartbeat, so the branch does not grow by 144 commits a day. | Change `worth_pushing` in `laptop/status.py`. |
