# JP-112 plan: record friction facts from every session, with no model

## Contents

- [What this plan is](#what-this-plan-is)
- [Tasks](#tasks)
- [Rules that hold throughout](#rules-that-hold-throughout)
- [Scenario to proof](#scenario-to-proof)

## What this plan is

JP-112 was not signed off Ready when the build started. Josh ruled on 17 November 2026 that everything in JP-94 that no other ticket blocks is fair game for this project, and JP-107 (its only blocker) is Done, so this minimal plan stands in for the sign-off. The design is already in `docs/design/data-model.md` ("Friction", "What the measures read"); `ledger/schema.sql` already has `session_facts` and `session_usage`, and `ledger/codes.json` has the starting fact codes. Nothing here needs a migration.

## Tasks

Each task is test first, on made-up transcripts (`tests/ledger_transcripts.py` style), and Python 3.9 with the standard library only.

1. **The transcript reader** (`ledger/friction.py`). Reads one episode's lines (by byte range, or by time range for the catch-up) and returns counts and usage names. It keeps no text: it compares message text with fixed markers in memory and keeps only booleans and counters; commands and file names are hashed for "same again" and then dropped.
2. **The writer** (`ledger/friction_write.py`). Writes `session_facts` (code must be in `codes.json`, value above zero, never twice for an episode) and `session_usage`, plus `instruction_bytes_loaded` and the `rule-file` rows from file sizes.
3. **Wire it into the recorder** (`ledger/record.py`, `write_episode`), so the recorder and the backfill both write facts when an episode is written. A failure here is logged and never stops the episode.
4. **The catch-up** (`friction_write.py` as a script, job `ledger-friction-catchup`, once): episodes recorded before this merged get their facts from their transcript, by time range.
5. **The measures** (`ledger/measures.py`): stored queries and one command that Josh and his own scripts run. Headline (Josh's messages per finished ticket beside the first-time sign-off share), first-time sign-off, spend and time per ticket, instruction size and unused loaded items. Loose ends are JP-109's; the command says so.
6. **Guards**: a test that the friction and usage tables and the measures never appear in `ledger/ask.py`, and that no answer from it holds them.
7. **Docs and proof**: `ledger/README.md`, `docs/design/data-model.md` status line, `docs/decisions.md` rows for the choices below, and `docs/proof/2026-11-17/JP-112/README.md`.

## Rules that hold throughout

- No model call, no network call (the one exception is the measures command's optional `--live`, which reads ticket status from Jira read-only, like `jira_read.py`).
- Counts and codes only. An item name (a skill, agent, tool or MCP server) is kept only when it is a plain identifier and passes the patient-data screen.
- The measures are not in `ask.py` and not shown to working agents.

## Scenario to proof

| Scenario | Proof |
| --- | --- |
| Counts, not text | `tests/test_ledger_friction.py`: seeded message and command text appears nowhere in the ledger file |
| No model is involved | `tests/test_ledger_friction.py`: the modules import no network or model library and the write path runs with sockets blocked |
| The headline can be read | `tests/test_ledger_measures.py` |
| Working agents cannot see the measures | `tests/test_ledger_friction.py` and the extended `tests/test_ledger_ask.py` |
