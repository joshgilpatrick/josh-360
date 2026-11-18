# How Josh 360 fits together

One page on what the parts of josh-360 are, how work and data move between them, and where to read more. It links to the detailed documents rather than repeating them. For why Josh 360 exists and what it must never become, read [`vision-and-roadmap.md`](vision-and-roadmap.md); for the drawn picture with the salvage map and phase split, read the architecture page in [`design/architecture/`](design/architecture/README.md).

## Contents

- [The parts](#the-parts)
- [How a session is recorded](#how-a-session-is-recorded)
- [How a piece of work moves through a graph](#how-a-piece-of-work-moves-through-a-graph)
- [How a change reaches the laptop](#how-a-change-reaches-the-laptop)
- [Where data lives](#where-data-lives)
- [What stays outside this repository](#what-stays-outside-this-repository)
- [Where to read next](#where-to-read-next)

## The parts

| Part | Folder | What it is |
| --- | --- | --- |
| Ledger | [`ledger/`](../ledger/README.md) | The local, append-only record of every agent session, graph run and decision, in `~/.josh-360/state/ledger.db`. Its design is [`design/data-model.md`](design/data-model.md). |
| Conventions | [`conventions/`](../conventions/README.md) | The ticket rules for all of Josh's work, the system registry (which folder or repository belongs to which system, space and epic) and his standing priorities. |
| Graphs and the walker | [`graphs/`](../graphs/README.md) | Four agent workflows (ticket creation, triage, development, non-development) stored as neutral files, the gate scripts between their steps, and the walker that says the next step. Rules: [`graphs/CONVENTION.md`](../graphs/CONVENTION.md). |
| Graph runner | [`graphs/runner/`](../graphs/runner/README.md) | The laptop job that starts runs for Ready tickets and starts an Agent Manager session for each role step. |
| Hooks | [`hooks/`](../hooks/README.md) | The Claude Code hooks Josh 360 adds to every session on the laptop, loaded through one dispatcher. |
| Laptop side | [`laptop/`](../laptop/README.md), [`jobs.yaml`](../jobs.yaml) | How the laptop follows `main`: the install script, the job runner, the `follow` job, the `laptop-status` branch and the pause switch. |
| Platform doctor | [`scripts/doctor.py`](../scripts/README.md#the-platform-doctor) | The health check for every part above. Reference: [`platform-doctor.md`](platform-doctor.md). |
| Session Atlas | [`apps/session-atlas/`](../apps/session-atlas/README.md) | The headless service for the artifact catalog, the worktree removal guard and the cost import (Node). |
| Workflow | [`WORKFLOW.md`](WORKFLOW.md), [`../.claude/`](../.claude/workflow.config.md) | How work on this repository is done: tickets, design gate, proof, the review ceremony and merging. |

Every surface Josh works through (Jira, Agent Manager, action-triage, Claude Code and the rest), and where its configuration lives, is in [`surface-map.md`](surface-map.md).

## How a session is recorded

1. A Claude Code session starts on the laptop. Claude Code calls `hooks/dispatch SessionStart`, which runs `hooks/SessionStart/20-ledger-spool`. It appends one line to the spool in `~/.josh-360/state/ledger-spool/` and never opens the ledger.
2. While it works, other hooks act on single tool calls: the ticket offer at a first commit with no ticket, ticket comments passed in from Jira, the worktree removal guard, and the rails for a graph step's session.
3. When it ends, `SessionEnd` appends a second spool line.
4. Every 5 minutes the `ledger-record` job reads the spool and the transcript's metadata (never message text) and writes the session, its episodes, its links and its home: the ticket from the branch name, else the system from the folder through the registry, else Unassigned.
5. `ledger-summary` adds a few summary lines and, for some episodes, a debrief. Agents read the ledger only through `ledger/ask.py`.

## How a piece of work moves through a graph

1. A loose request becomes a ticket through the ticket creation graph, started by `graphs/intake/submit.py` (for example when Josh says yes to a ticket offer). Josh approves the ticket on a card in action-triage's Needs you tab before anything is written to Jira.
2. The triage graph signs a ticket Ready, or sends it back with its gaps.
3. The graph runner watches Jira and starts runs by the rules in `graphs/runner/starts.json`, which cover all four graphs. A Ready ticket carrying the `ready-to-run` label gets a development or non-development run.
4. For each step the walker either runs a gate script itself (no model) or hands a role step to the runner, which starts an Agent Manager session with the role's instructions. Questions for Josh go to the Needs you tab; no session waits.
5. Every step, outcome, question and answer is written to the ledger. A development run ends with a pull request that Josh's laptop audits; a non-development run ends with a deliverable and Josh's sign-off.

The rules each graph follows are in [`graphs/CONVENTION.md`](../graphs/CONVENTION.md); each graph's design is in [`design/`](design/README.md) and [`superpowers/specs/`](superpowers/specs/README.md).

## How a change reaches the laptop

1. A change is a pull request to `main`, made under a JP ticket and reviewed as [`WORKFLOW.md`](WORKFLOW.md) says.
2. Merging is the install. Within about 10 minutes the laptop's job runner (started by the macbook-automations startup list) runs `follow`, which fast-forwards `~/.josh-360/repo` to `main` and runs `laptop/install.py`.
3. `follow` pushes the result, and each reporting job its report, to the `laptop-status` branch. Anyone can read it from any clone with `python3 laptop/status.py show`.
4. A branch named `laptop-pause` stops installs.

## Where data lives

All of it is on Josh's laptop; there is no cloud database.

| Where | What |
| --- | --- |
| `~/.josh-360/repo` | The laptop's copy of this repository, at `main`. |
| `~/.josh-360/state/ledger.db` | The ledger. Daily backups in `~/.josh-360/backups`, copied to an Azure container Josh's organisation owns (JP-150). |
| `~/.josh-360/state/cache.db` | Session Atlas's catalog and cost tables. |
| `~/.josh-360/runs/<run id>/` | Each graph run's inputs, outputs and work folder. |
| `~/.josh-360/logs/` | Job and hook logs. |
| Jira (project JP and the work spaces) | Tickets and their status. Nothing that identifies a patient ever goes there or to GitHub. |

## What stays outside this repository

- **claude-harness** (`~/.claude`): Josh's global rules, skills and agents. It registers the hook dispatcher (`scripts/add-josh-360-hooks.py`).
- **macbook-automations**: the startup list that starts Josh 360's job runner.
- **action-triage**: the desktop app with the Needs you tab and the pull request audit, until it moves into `apps/`.
- Agent Manager, which runs the role sessions.

## Where to read next

- [`../README.md`](../README.md): the front door, with every folder.
- [`../AGENTS.md`](../AGENTS.md): the rules and commands every agent session reads first.
- [`README.md`](README.md): a map of everything under `docs/`.
- [`../.claude/skills/verify-josh-360/features/README.md`](../.claude/skills/verify-josh-360/features/README.md): how each user-facing feature is proven to work, on a sandbox laptop.
