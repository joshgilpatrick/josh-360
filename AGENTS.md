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

This repo follows `docs/WORKFLOW.md` (tickets, design gate, proof, review ceremony, merge). Values: `.claude/workflow.config.md`. Skills in `.claude/skills/`: `ticket-lifecycle`, `design-handoff`, `pr-proof`, `review-ceremony`, `workflow-roles`. Commands: `/design`, `/build`, `/fix`, `/review-pr`, `/ship`, `/session-end`, `/closeout`.

Status and history live in Jira (project `JP`, epic JP-94, label `josh-360`). There is no status file in the repo.

## Rules every session follows

Josh set these on 15 November 2026 (`docs/vision-and-roadmap.md`, "How the build runs without babysitting"). `docs/WORKFLOW.md` holds the detail.

**Merge permission.** Agents may merge their own pull requests to josh-360 once the review ceremony is done and the `suite` check is green. The passphrase rule in Josh's global instructions does not apply to this repository. It still applies to every other repository, and pull requests to his other repositories wait for the close of the phase.

**Build rules.**

- A ticket is Ready before work starts: a separate agent signs it off, with no open questions.
- Work in the cloud first, on made-up sample data, never real transcripts.
- A step that must run on Josh's laptop is named in the ticket in advance.
- Branches, session and thread titles, and PR titles start with the ticket key: branch `JP-<n>-<slug>`, title `JP-<n> <name>`. A cloud session cuts and pushes the key-named branch from `main` instead of keeping its `claude/...` branch (`docs/WORKFLOW.md` §1.6 and §3.8).
- A separate agent reviews each pull request before it merges.
- Each part of phase 1 ends with a short proof page Josh can read in minutes.
- Permanent deletions wait in one list per phase, which Josh approves in one sitting. Retiring something means switching it off and archiving it, which needs nobody.

**Questions.**

- Design questions are collected, each with a recommendation, and put to Josh in one sitting per phase (JP-106 for phase 1). Builds that do not wait on an answer carry on.
- When a question comes up during building and the choice can be undone, take the recommended option, record it in `docs/decisions.md`, and carry on.
- Only a permanent deletion or a write to something shared stops the work to ask Josh.

**Data rule.** Reading any data Josh can access is allowed. A write to anything shared (a shared database, or an app other people use) needs Josh's confirmation in the thread, and a write that affects other users goes through the SQL write safety ceremony.

**Patient-data rule** (Josh, 17 November 2026; `docs/design/data-model.md`, "Patient data"). Assume every system may hold patient data. Nothing that identifies a patient goes to GitHub or Jira (commits, pull requests, comments, tickets) or into logs; gates check what they write there with `graphs/gates/lib/patient_data.py`. The ledger, summaries and decision records avoid patient names, dates of birth, social security numbers and phone numbers; unique identifiers such as record numbers are fine there. Data goes only to platforms Josh's organisation owns or has a BAA with (every current one does); confirm that before adding a new connector or platform. Refer to a file that holds patient data by path only. Folders that hold it are named `.phi`, which `.gitignore` ignores.

## Commands

- Install once: `pip install -r requirements.txt` (PyYAML).
- Checks and tests: `python3 scripts/check.py` (add `--fast` to skip `tests/`).
- Conventions: `python3 scripts/conventions.py check`, and `python3 scripts/conventions.py lookup --folder <path>` or `--repo <name>` to find where work belongs.
- Laptop inventory (JP-96, run on the laptop only, read-only, standard library only): `python3 scripts/laptop_inventory.py --out ~/josh-360-inventory.json`
- What the laptop has installed: `python3 laptop/status.py show` (reads the `laptop-status` branch).
- Install: merging to `main` installs on the laptop on its own (JP-105). Code that runs on the laptop uses Python 3.9 and the standard library only. A new background job is an entry in `jobs.yaml`, and Josh 360 ships no launchd plist or installer of its own: its jobs start only through the macbook-automations startup list, which starts the job runner (the one tracked exception is the Session Atlas service installer, `scripts/atlas_service.py`, until the phase 1 close: `docs/phase-1-close-checklist.md`); a new Claude Code hook is an executable file in `hooks/<Event>/`; a new install step goes in `STEPS` in `laptop/install.py`.
- Loose ends (JP-109, laptop only; read-only apart from `keep`): `python3 ledger/loose_ends.py` (add `--session <id>`, `--json`, `--fetch`); mark a branch kept on purpose with `python3 ledger/loose_ends.py keep --folder <path> --branch <name>`; `python3 ledger/closeout.py` proposes, `--apply` does the reversible ones; `/closeout` calls the closeout agent.
- Startup list check (JP-119, laptop): `python3 laptop/check_jobs.py` compares what is loaded and installed in launchd with the macbook-automations startup list and `laptop/launchd-register.json`, and prints each difference (`--json` for the report; the daily job `launchd-check` puts it on `laptop-status` as `reports/launchd-check.json`). A job switched off by `retire-leftover-jobs` comes back with `python3 scripts/restore_retired_job.py <archive folder>`.
- Pause the laptop from the cloud: push a branch named `laptop-pause`; delete it to resume.
- Feature tree (JP-143): `python3 scripts/feature_tree.py check`, and `build` after editing `docs/design/feature-tree/tree.yaml`.
- Architecture page (JP-144): `python3 scripts/architecture_page.py check`, and `build` after editing the feature tree or anything in `docs/design/architecture/`.
- Graph checker on its own: `python3 graphs/tools/check_graph.py` (rules in `graphs/CONVENTION.md`).
- Walker (JP-114): `python3 graphs/tools/walker.py <start|next|record|answer|abandon|allow|retry|status> ...`; it reads the JSON copies in `graphs/compiled/`, so run `python3 graphs/tools/compile_graphs.py` after changing a graph, a tier, or a role or agent (`--check` is part of `scripts/check.py`).

## Layout

- `README.md`: what the repository is and where things live.
- `apps/`: runnable parts: `apps/session-atlas` (JP-111, headless: artifact catalog, removal guard, cost import; rules in its `AGENTS.md`); action-triage moves in later.
- `ledger/`: the ledger, the local record of every agent session.
- `graphs/`: the agent graphs and the walker (`graphs/tools/walker.py`). How a graph is stored, the checker's rules and how a graph runs: `graphs/CONVENTION.md`.
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
- `docs/phase-1-deletion-list.md`: what is archived and waits for Josh's one-sitting approval to be deleted for good.
- `docs/phase-1-close-checklist.md`: the changes to Josh's other repositories that wait for the phase 1 close, with their steps in order.
- `.claude/`: workflow values, skills, commands and subagents.
- `scripts/check.py`: the repo's checks, run by CI as the `suite` job.
- `scripts/conventions.py`: checks and reads the registry and the priorities file.
- `scripts/laptop_inventory.py`, `scripts/laptop_figures.py`: the read-only laptop inventory and starting figures (JP-96); `scripts/laptop_inventory_job.py` runs it once as the `inventory` job and its report lands on `laptop-status` as `reports/inventory.json`.
- `tests/`: the tests (stdlib unittest), run by `scripts/check.py`.
- `jobs.yaml`: Josh 360's background jobs on the laptop.
- `laptop/`: how the laptop follows `main`: the install script, the job runner, the `follow` job, the status branch and the pause switch.
- `hooks/`: Claude Code hooks, loaded on the laptop through `hooks/dispatch`.

## Product

Josh 360 is Josh's personal workflow platform: one data model (the ledger), one set of conventions, and agent graphs that take work from an idea to a reviewed pull request, plus a view of his priorities. Josh is the only user. Requirements: `docs/vision-and-roadmap.md`; tickets: JP-94 and its children.

## Constraints that shape most decisions

- Who merges, and what needs Josh's confirmation, is in "Rules every session follows" above and `docs/WORKFLOW.md` §5.
- Data stays on the laptop; there is no cloud database.
