---
name: design-handoff
description: Use in a design thread for a josh-360 ticket that needs Josh's design approval: opening questions, mock-up boards, spec, then the plan and the hand-off to a build thread. Not for building.
---

# Design thread

Rules: `docs/WORKFLOW.md` §2. You run on the design model in `.claude/workflow.config.md`.

1. Read the ticket, JP-94, `docs/vision-and-roadmap.md`, related specs and boards in `docs/design/views/`, and the code the work touches. Move the ticket to Design/Planning.
2. Post your reading of the ticket in plain words, the defaults you will draw on, and the **one** question that changes the build most, with your recommendation and a free-text route. Do not wait: draw on the defaults. If the phase batches design questions (JP-106 for phase 1), add the question to that batch instead of asking on its own.
3. For anything with a screen, draw the boards (one per screen and state, at the real size of each surface). Commit them to `docs/design/views/<view>/` with a README table (file, what it shows, size). Show Josh rendered images. Josh approves the boards.
4. Write the spec, `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, starting with a `## Contents` section: the screen-to-board table with "the boards win on visuals" (if there are boards), numbered rules, every exact piece of copy, the Gherkin (copied to the ticket), out of scope, open questions. Josh approves the spec.
5. Without asking again, run `superpowers:writing-plans`. The plan names the board in each task, lists global constraints and a "review focus" of failure modes no scenario names. Commit it to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`.
6. Tell the coordinator "plan complete" with the ticket, plan path and branch, comment the same on the ticket, and stop. Do not build.
