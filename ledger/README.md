# Ledger

## Contents

- [What is here](#what-is-here)
- [Status](#status)

The ledger: the local, append-only record of every agent session, graph run and decision Josh makes, and its data model. Data stays on the laptop.

## What is here

| File | What it is |
| --- | --- |
| `schema.sql` | The draft schema for `~/.josh-360/state/ledger.db` (JP-99). Tested by `tests/test_ledger_schema.py`. |
| `codes.json` | The code lists that grow over time: friction facts, debrief kinds and endings, and the ordered rules that say who started a session (`started_by_env`). Writers refuse a code not listed here. |

The design, with what each table is for, where today's stores go and the questions for Josh: `docs/design/data-model.md`. The build plan: `docs/superpowers/plans/2026-11-16-ledger.md` (JP-107).

## Status

Designed, not built; amended by JP-148 (17 November 2026) with the JP-146 review's five fixes, and by JP-149 (the same day) with Josh's answers to the review's questions: his patient-data rule, and local sessions only. JP-107 builds the database, the recorder and the read command; later tickets add the writers for their tables (`docs/design/data-model.md`, "Who writes what"). No patient data in any file here.
