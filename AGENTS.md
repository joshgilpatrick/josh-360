# AGENTS.md

## Contents

- [Workflow](#workflow)
- [Commands](#commands)
- [Layout](#layout)
- [Product](#product)
- [Constraints that shape most decisions](#constraints-that-shape-most-decisions)

`CLAUDE.md` is a link to this file for Claude Code. Edit this file, never the link.

## Workflow

This repo follows `docs/WORKFLOW.md` (tickets, design gate, proof, review ceremony, merge). Values: `.claude/workflow.config.md`. Skills in `.claude/skills/`: `ticket-lifecycle`, `design-handoff`, `pr-proof`, `review-ceremony`, `workflow-roles`. Commands: `/design`, `/build`, `/fix`, `/review-pr`, `/ship`, `/session-end`.

Status and history live in Jira (project `JP`, epic JP-94, label `josh-360`). There is no status file in the repo.

## Commands

- Checks (the whole suite for now): `python3 scripts/check.py`
- There is no app, build or install step yet. The ticket that adds one adds its command here and in `.claude/workflow.config.md`.

## Layout

- `docs/vision-and-roadmap.md`: the approved vision and roadmap (the requirements source).
- `docs/source-notes/`: Josh's notes for the four graphs and the brainstorm, unchanged.
- `docs/WORKFLOW.md`: how work is done here.
- `docs/superpowers/specs/`, `docs/superpowers/plans/`: design specs and implementation plans.
- `docs/design/views/`: mock-up boards.
- `docs/proof/`: proof for each ticket, by date and key.
- `.claude/`: workflow values, skills, commands and subagents.
- `scripts/check.py`: the repo's checks, run by CI as the `suite` job.

## Product

Josh 360 is Josh's personal workflow platform: one data model (the ledger), one set of conventions, and agent graphs that take work from an idea to a reviewed pull request, plus a view of his priorities. Josh is the only user. Requirements: `docs/vision-and-roadmap.md`; tickets: JP-94 and its children.

## Constraints that shape most decisions

- Who merges, and what needs Josh's confirmation, is in `docs/WORKFLOW.md` §5.
- Reading data Josh can access is allowed. No patient data in summaries, decision records, tickets, commits or logs; refer to such files by path only.
- Data stays on the laptop; there is no cloud database.
