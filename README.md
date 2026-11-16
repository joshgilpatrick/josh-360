# josh-360

## Contents

- [What this is](#what-this-is)
- [Where things live](#where-things-live)
- [How work is done](#how-work-is-done)

## What this is

Josh 360 is Josh Gilpatrick's personal workflow platform for working with AI agents: one local record of every agent session (the ledger), one set of conventions for tickets, and portable agent workflows (graphs) that carry a ticket from idea to sign-off. A dashboard of his priorities comes later. Josh is the only user, and data stays on his laptop.

The requirements are in [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md). The work is tracked in Jira under the epic JP-94.

## Where things live

| Path | What it holds |
| --- | --- |
| `AGENTS.md` | The instructions every agent session reads first (`CLAUDE.md` links to it). |
| `apps/` | Runnable parts, moved in from Session Atlas and action-triage later. |
| `ledger/` | The ledger and its data model. |
| `graphs/` | The agent graphs and the walker. |
| `conventions/` | Ticket conventions, the system registry and the standing priorities. |
| `docs/vision-and-roadmap.md` | The approved vision and roadmap. |
| `docs/decisions.md` | Josh's decisions and the default choices made while building. |
| `docs/source-notes/` | Josh's original notes, unchanged. |
| `docs/WORKFLOW.md` | How work is done here. |
| `docs/superpowers/` | Design specs and implementation plans. |
| `docs/design/` | Design material and mock-up boards. |
| `docs/inventory/` | The inventory of the work laptop, with a verdict per item. |
| `docs/proof/` | Proof for each ticket, by date and key. |
| `.claude/` | Workflow values, skills, commands and subagents. |
| `scripts/check.py` | The repository's checks, run by CI as the `suite` job. |
| `tests/` | The tests, run by `scripts/check.py`. |
| `jobs.yaml` | Josh 360's background jobs on the laptop. |
| `laptop/` | How the laptop follows `main`: install script, job runner, status branch, pause switch. |
| `hooks/` | Claude Code hooks, loaded on the laptop through `hooks/dispatch`. |

## How work is done

Every change runs through a JP ticket, a pull request, a review by a separate agent and a green `suite` check. The rules are in [`docs/WORKFLOW.md`](docs/WORKFLOW.md). Run the checks with `python3 scripts/check.py`.
