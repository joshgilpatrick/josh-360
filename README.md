# josh-360

## Contents

- [What this is](#what-this-is)
- [The parts](#the-parts)
- [Where things live](#where-things-live)
- [Running the checks](#running-the-checks)
- [Proving a feature works](#proving-a-feature-works)
- [How work is done](#how-work-is-done)
- [Where to read next](#where-to-read-next)

## What this is

Josh 360 is Josh Gilpatrick's personal workflow platform for working with AI agents. It has three parts: one local record of every agent session (the ledger), one set of conventions for tickets, and portable agent workflows (graphs) that carry a piece of work from a loose request to a reviewed pull request or a signed-off deliverable. A dashboard of his priorities comes later. Josh is the only user, and the data stays on his laptop.

The requirements are in [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md). The work is tracked in Jira under the epic JP-94.

## The parts

- **The ledger** records every Claude Code session on the laptop, every graph run and every decision, with no message text. Hooks write a spool; a job turns it into rows; agents read it with one command.
- **The conventions** say how a ticket is written, which system and Jira space each folder or repository belongs to, and Josh's standing priorities.
- **The graphs** are four agent workflows (ticket creation, triage, development, non-development). The walker runs their gate scripts and says the next step; the graph runner starts an Agent Manager session for each role step.
- **The laptop side** keeps Josh's laptop on `main`: merging is the install, background jobs run every few minutes, and their results are readable from anywhere on the `laptop-status` branch.
- **The platform doctor** checks every part and gives the one step that fixes each problem.
- **Session Atlas** is a headless service for the catalog of files sessions made, the worktree removal guard and the cost import.

How these fit together, and how a session or a ticket moves through them: [`docs/architecture.md`](docs/architecture.md).

## Where things live

Every top-level folder has a README that says what it holds.

| Path | What it holds |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | The rules and commands every agent session reads first (`CLAUDE.md` links to it). |
| [`ledger/`](ledger/README.md) | The ledger: its schema, the recorder, the read command, backups and loose ends. |
| [`conventions/`](conventions/README.md) | Ticket conventions, the system registry and the standing priorities. |
| [`graphs/`](graphs/README.md) | The agent graphs, their roles, agents, gates and contracts, the walker and the graph runner. |
| [`hooks/`](hooks/README.md) | The Claude Code hooks, loaded on the laptop through `hooks/dispatch`. |
| [`laptop/`](laptop/README.md) | How the laptop follows `main`: install script, job runner, status branch, pause switch. |
| [`jobs.yaml`](jobs.yaml) | Josh 360's background jobs on the laptop. |
| [`apps/`](apps/README.md) | Runnable apps: `apps/session-atlas` today; action-triage moves in later. |
| [`scripts/`](scripts/README.md) | The repository checks, the platform doctor, and the scripts behind several jobs. |
| [`tests/`](tests/README.md) | The tests, run by `scripts/check.py`. |
| [`docs/`](docs/README.md) | The architecture overview, vision, workflow, designs, decisions and proof. |
| [`.claude/`](.claude/workflow.config.md) | Workflow values, skills (including `verify-josh-360`), commands and subagents. |
| [`.github/`](.github/workflows/test.yml) | The CI workflow (the `suite` job) and the pull request template. |

## Running the checks

```bash
pip install -r requirements.txt   # PyYAML, once
python3 scripts/check.py          # every check, then every test (--fast skips the tests)
```

CI runs the same command as the `suite` job. Session Atlas has its own suite: `npm ci && npm test` in `apps/session-atlas` (Node 22.18 or newer).

## Proving a feature works

The `verify-josh-360` skill builds a throwaway sandbox laptop (its own home folder and a local stand-in for GitHub) and drives Josh 360's features the way the laptop uses them. Its feature map lists each user-facing feature with the exact steps that prove it: [`.claude/skills/verify-josh-360/features/README.md`](.claude/skills/verify-josh-360/features/README.md).

## How work is done

Every change runs through a JP ticket, a branch named after it, a pull request, an audit by Josh's laptop and a green `suite` check. The rules are in [`docs/WORKFLOW.md`](docs/WORKFLOW.md) and the values in [`.claude/workflow.config.md`](.claude/workflow.config.md).

## Where to read next

1. [`docs/architecture.md`](docs/architecture.md): how the parts fit together.
2. [`AGENTS.md`](AGENTS.md): the rules and every command.
3. [`docs/README.md`](docs/README.md): every document, living and historical.
4. The README of the folder you are about to change.
