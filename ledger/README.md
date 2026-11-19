# Ledger

## Contents

- [What is here](#what-is-here)
- [Status](#status)

The ledger: the local, append-only record of every agent session, graph run and decision Josh makes, and its data model. Data stays on the laptop.

## What is here

| File | What it is |
| --- | --- |
| `schema.sql` | The schema for `~/.josh-360/state/ledger.db` (JP-99). Tested by `tests/test_ledger_schema.py`. |
| `db.py`, `migrations/` | Create, open and migrate the ledger; every connection turns on `foreign_keys` and `recursive_triggers`. A migration may only add. Run `python3 ledger/db.py`. |
| `text.py` | Cuts and screens short text before it is written; text that fails the patient-data screen is withheld. |
| `spool.py` | The hook spool: hooks only append here, and the recorder reads it. |
| `sessions.py`, `transcript.py`, `record.py` | The recorder: the `sessions` row at start, then episodes from transcript metadata (never message text), git and the spool. The `ledger-record` job runs it every 5 minutes. |
| `friction.py`, `friction_write.py` | Friction facts (JP-112): counts of Josh's messages, interrupts, failed commands, repeated reads, context at the first turn, time waiting on Josh against time working, and the skills, agents, tools and MCP servers used, written with each episode by the recorder. No model, no network, no message text. `friction_write.py` is also the one-time `ledger-friction-catchup` job for episodes recorded before. |
| `measures.py` | The measures as stored queries (JP-112): Josh's messages per finished ticket beside the first-time sign-off share, spend and time per ticket, the size of the instructions a session loads, and what was loaded and never used; `measures.py ticket <KEY>` (JP-170) lists every session on one ticket with its graph step and cost, subagents folded into the step that started them, in `ticket_costs.py`. For Josh and his own scripts; working agents are never given it. |
| `_repo.py`, `graph_sessions.py` | `_repo.py` puts the repository root on the import path, so a ledger file works as a script or as an import. `graph_sessions.py` says where a graph step's session link lives (`~/.josh-360/state/graph-sessions/`); the ledger's hooks stay quiet in a graph session (JP-117). |
| `homes.py`, `jira_read.py` | Where a session belongs, worked out with no model: ticket key, ticket links, registry, else unassigned. One read-only Jira call. |
| `costs.py`, `state_notes.py` | Copy cost, ticket links and titles from the cost ledger, and the notes in STATE.md. Nothing is copied from a `.phi` folder. |
| `offer.py` | The one-line ticket offer (JP-110): the `PreToolUse` hook body (`hooks/PreToolUse/30-ticket-offer`), the command that records Josh's answer, and the recorder's half that writes `ticket_offers`. The hook never blocks and never opens the ledger for writing. |
| `summary.py`, `summary_sources.py` | About five summary lines for each episode that has gone quiet (JP-108): copied from the first line of the first message, the title and STATE.md, with no model; one small cheap-tier call only when those are too thin; none for a `.phi` folder. The `ledger-summary` job runs it every 5 minutes after the recorder. `summary_sources.py` is the one place message text is read. |
| `debrief.py`, `debrief_sources.py`, `debrief_form.json` | The session debrief (JP-113): how an episode ended and up to five moments of friction, as codes and pointers, never text. The same call as the summary's, so an episode gets at most one model call. `earns` decides which episodes get one (a graph run, or friction facts at a threshold in `debrief_form.json`); `parse_output` accepts only the form; `debrief_sources.py` builds the trimmed copy the model reads (the second place message text is read). The form is `1-provisional` until `python3 ledger/debrief.py finalise-form` has run on two weeks of real fact rows. |
| `comments.py` | Ticket comments to working sessions (JP-118): the `ticket-comments` job (every 5 minutes) reads the Jira comments of each ticket that has an unfinished session or graph run and hands each new one over once, as a file in the session's inbox (read by the `PostToolUse` and `UserPromptSubmit` hooks `40-ticket-comments`) or in the run's `comments/` folder (taken by the binding with `comments.py take --run <id>`). One `comment_deliveries` row per hand-over, id and author only. Comments that start with the robot emoji are the system's own and are skipped. |
| `ask.py` | The one read command for working agents: six queries, read-only, at most 20 rows and 4096 bytes. `changes --live` adds each row's ticket status and pull request state, read from Jira and GitHub now. |
| `correct.py` | Withdraws a row with a correction row (and can undo it once); rows are never edited or deleted. |
| `backup.py`, `redact.py` | A daily verified gzip backup (14 daily, 8 weekly), and the one way to overwrite patient data found in a cell, in the ledger, the local backups and the Azure copies. Josh runs `redact.py` at a terminal. |
| `upload.py`, `azure_blob.py` | The `ledger-upload` job (JP-150): makes an Azure blob container hold the same backups, signed in as Josh through `az login`, no stored secret. Names the container in `~/.josh-360/state/azure-backup.json` (`account`, `container`; nothing else is accepted). Reports ok, failed or not-configured on `laptop-status`. |
| `backfill.py` | The one-time backfill of history from Session Atlas and old transcripts (the `ledger-backfill` job). |
| `loose_ends.py`, `closeout.py`, `live.py` | Loose ends, worked out when asked (JP-109): seven kinds checked live against git, GitHub and Jira, nothing stored (the seventh, `closed-pr-branch`, is a remote ticket branch whose pull request was closed without merging, JP-174); `keep` marks a branch kept on purpose, local or remote-only; `closeout.py` proposes an action per item and, with `--apply`, does only the reversible ones. `live.py` reads a ticket's status, a pull request's state and a branch's pull requests, or "unknown". |
| `codes.json` | The code lists that grow over time: friction facts, debrief kinds and endings, and the ordered rules that say who started a session (`started_by_env`). Writers refuse a code not listed here. |

The design, with what each table is for, where today's stores go and the questions for Josh: `docs/design/data-model.md`. The build plan: `docs/superpowers/plans/2026-11-16-ledger.md` (JP-107).

## Status

Built (JP-107, 17 November 2026): the database and its migrations, the recorder, homes, costs and notes, the read command, backup, redaction and the backfill. Proof: `docs/proof/2026-11-17/JP-107/README.md`. The design was amended by JP-148 and JP-149 (the JP-146 review's fixes, Josh's patient-data rule, local sessions only). JP-112 added the friction facts and the measures (`docs/proof/2026-11-17/JP-112/README.md`). The session summaries (JP-108, `docs/proof/2026-11-17/JP-108/README.md`) and the ticket offer (JP-110, 17 November 2026) add the writers for `session_summaries` and `model_calls` (JP-113 adds `debriefs` and `debrief_moments`, `docs/proof/2026-11-17/JP-113/README.md`), and the writer for `ticket_offers` and the offer's `ticket_links`; proof: `docs/proof/2026-11-17/JP-110/README.md`. Passing ticket comments to working sessions (JP-118, 17 November 2026) adds the writer for `comment_deliveries`; proof: `docs/proof/2026-11-17/JP-118/README.md`. The graph walker writes the graph tables (`graph_runs`, `step_runs`, `step_results`, `run_ends`, `run_files`, `asks`, `decisions`, `memory_lookups`) through `graphs/tools/walker_lib/ledgerio.py`. Later tickets add the writers for the rest (`docs/design/data-model.md`, "Who writes what"); the Azure copy of the backups is built (JP-150, `docs/proof/2026-11-17/JP-150/README.md`). No patient data in any file here.

Loose ends and the closeout agent (JP-109, 17 November 2026): `python3 ledger/loose_ends.py` lists them, `/closeout` calls the agent. Proof: `docs/proof/2026-11-17/JP-109/README.md`.
