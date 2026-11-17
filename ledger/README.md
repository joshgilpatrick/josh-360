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
| `homes.py`, `jira_read.py` | Where a session belongs, worked out with no model: ticket key, ticket links, registry, else unassigned. One read-only Jira call. |
| `costs.py`, `state_notes.py` | Copy cost, ticket links and titles from the cost ledger, and the notes in STATE.md. Nothing is copied from a `.phi` folder. |
| `ask.py` | The one read command for working agents: six queries, read-only, at most 20 rows and 4096 bytes. |
| `correct.py` | Withdraws a row with a correction row (and can undo it once); rows are never edited or deleted. |
| `backup.py`, `redact.py` | A daily verified gzip backup (14 daily, 8 weekly; the Azure copy is JP-150), and the one way to overwrite patient data found in a cell. Josh runs `redact.py` at a terminal. |
| `backfill.py` | The one-time backfill of history from Session Atlas and old transcripts (the `ledger-backfill` job). |
| `codes.json` | The code lists that grow over time: friction facts, debrief kinds and endings, and the ordered rules that say who started a session (`started_by_env`). Writers refuse a code not listed here. |

The design, with what each table is for, where today's stores go and the questions for Josh: `docs/design/data-model.md`. The build plan: `docs/superpowers/plans/2026-11-16-ledger.md` (JP-107).

## Status

Built (JP-107, 17 November 2026): the database and its migrations, the recorder, homes, costs and notes, the read command, backup, redaction and the backfill. Proof: `docs/proof/2026-11-17/JP-107/README.md`. The design was amended by JP-148 and JP-149 (the JP-146 review's fixes, Josh's patient-data rule, local sessions only). Later tickets add the writers for the other tables (`docs/design/data-model.md`, "Who writes what"); the Azure copy of the backups is JP-150. No patient data in any file here.
