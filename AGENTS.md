# AGENTS.md

## Contents

- [Workflow](#workflow)
- [Rules every session follows](#rules-every-session-follows)
- [Commands](#commands)
- [Layout](#layout)
- [Product](#product)
- [Constraints that shape most decisions](#constraints-that-shape-most-decisions)

`CLAUDE.md` is a link to this file for Claude Code. Edit this file, never the link. New instruction files are written as `AGENTS.md`.

## Workflow

This repo follows `docs/WORKFLOW.md` (tickets, design gate, proof, review ceremony, merge). Values: `.claude/workflow.config.md`. Skills in `.claude/skills/`: `ticket-lifecycle`, `design-handoff`, `pr-proof`, `review-ceremony`, `workflow-roles`. Commands: `/design`, `/build`, `/fix`, `/review-pr`, `/ship`, `/session-end`.

Status and history live in Jira (project `JP`, epic JP-94, label `josh-360`). There is no status file in the repo.

## Rules every session follows

Josh set these on 15 November 2026 (`docs/vision-and-roadmap.md`, "How the build runs without babysitting"). `docs/WORKFLOW.md` holds the detail.

**Merge permission.** Agents may merge their own pull requests to josh-360 once the review ceremony is done and the `suite` check is green. The passphrase rule in Josh's global instructions does not apply to this repository. It still applies to every other repository, and pull requests to his other repositories wait for the close of the phase.

**Build rules.**

- A ticket is Ready before work starts: a separate agent signs it off, with no open questions.
- Work in the cloud first, on made-up sample data, never real transcripts.
- A step that must run on Josh's laptop is named in the ticket in advance.
- A separate agent reviews each pull request before it merges.
- Each part of phase 1 ends with a short proof page Josh can read in minutes.
- Permanent deletions wait in one list per phase, which Josh approves in one sitting. Retiring something means switching it off and archiving it, which needs nobody.

**Questions.**

- Design questions are collected, each with a recommendation, and put to Josh in one sitting per phase (JP-106 for phase 1). Builds that do not wait on an answer carry on.
- When a question comes up during building and the choice can be undone, take the recommended option, record it in `docs/decisions.md`, and carry on.
- Only a permanent deletion or a write to something shared stops the work to ask Josh.

**Data rule.** Reading any data Josh can access is allowed. A write to anything shared (a shared database, or an app other people use) needs Josh's confirmation in the thread, and a write that affects other users goes through the SQL write safety ceremony.

**Patient-data rule.** No patient data in the ledger, summaries, decision records, tickets, commits or logs. Refer to a file that holds it by path only. Folders that hold it are named `.phi`, which `.gitignore` ignores.

## Commands

- Install once: `pip install -r requirements.txt` (PyYAML).
- Checks: `python3 scripts/check.py`. Full suite: `python3 scripts/check.py && python3 -m unittest discover -s tests`.
- Conventions: `python3 scripts/conventions.py check`, and `python3 scripts/conventions.py lookup --folder <path>` or `--repo <name>` to find where work belongs.
- There is no app or build step yet. The ticket that adds one adds its command here and in `.claude/workflow.config.md`.

## Layout

- `README.md`: what the repository is and where things live.
- `apps/`: runnable parts (moved in from Session Atlas and action-triage later).
- `ledger/`: the ledger, the local record of every agent session.
- `graphs/`: the agent graphs and the walker.
- `conventions/`: ticket conventions (`tickets.md`), the system registry (`registry.yaml`) and the standing priorities (`priorities.yaml`). Ticket rules for all of Josh's work start here.
- `docs/surface-map.md`: every surface Josh works through, and where its configuration lives.
- `docs/vision-and-roadmap.md`: the approved vision and roadmap (the requirements source).
- `docs/decisions.md`: decisions from the question round, and default choices made while building.
- `docs/source-notes/`: Josh's notes for the four graphs and the brainstorm, unchanged.
- `docs/WORKFLOW.md`: how work is done here.
- `docs/superpowers/specs/`, `docs/superpowers/plans/`: design specs and implementation plans.
- `docs/design/`: design material; mock-up boards in `docs/design/views/`.
- `docs/inventory/`: the inventory of the work laptop, with a verdict per item.
- `docs/proof/`: proof for each ticket, by date and key.
- `.claude/`: workflow values, skills, commands and subagents.
- `scripts/check.py`: the repo's checks, run by CI as the `suite` job.
- `scripts/conventions.py`: checks and reads the registry and the priorities file.
- `tests/`: unit tests (`python3 -m unittest discover -s tests`).

## Product

Josh 360 is Josh's personal workflow platform: one data model (the ledger), one set of conventions, and agent graphs that take work from an idea to a reviewed pull request, plus a view of his priorities. Josh is the only user. Requirements: `docs/vision-and-roadmap.md`; tickets: JP-94 and its children.

## Constraints that shape most decisions

- Who merges, and what needs Josh's confirmation, is in "Rules every session follows" above and `docs/WORKFLOW.md` §5.
- Data stays on the laptop; there is no cloud database.
