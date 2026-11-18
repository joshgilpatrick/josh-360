# JP-163 proof: Session Atlas starts on a cache.db seeded from the old cost ledger

## Contents

- [What was wrong](#what-was-wrong)
- [Scenario to proof](#scenario-to-proof)
- [Still to check on the laptop](#still-to-check-on-the-laptop)

## What was wrong

`cache.db` is a copy of the old cost ledger, seeded by the retire job, and it carries the ledger's own catalog tables: `artifacts` (artifact_id TEXT, no `file_type`), `artifact_locations` and `artifact_events`, with an empty `schema_migrations` and no `sessions` table. Atlas's migration 1 tried to create its own `artifacts` table and failed with "table artifacts already exists" on every restart. Skipping that one statement would not be enough, because the next one, `CREATE INDEX idx_artifacts_type ON artifacts(file_type)`, needs a column the old table lacks.

The fix is in Atlas's migration code only (`apps/session-atlas/src/db/legacy-names.ts`, called from `migrate()`): before a migration runs, any table, index or trigger it is about to create that already exists is renamed to `legacy_<name>`, rows kept, in the same transaction. It does not look at the old table's shape, so it works for the laptop's. The retire script is unchanged.

## Scenario to proof

All in `apps/session-atlas/test/db/legacy-clash.test.ts`, on made-up data in temp folders.

| Scenario | Test |
| --- | --- |
| Old catalog tables clash with migration 1 (5 message rows, 3 old artifact rows, no `file_type`, empty `schema_migrations`, no `sessions`) | "old catalog tables clash with migration 1": no error, `schema_migrations` records 1 to 13 in order, `legacy_artifacts` holds the 3 rows, the 5 message rows are byte-identical, Atlas's `artifacts` has `file_type`. Before the change the same file failed with "table artifacts already exists". |
| A database that already records its migrations is left alone | "a database that already records its migrations is left alone": `migrate()` returns 0 and the schema is identical before and after, with no `legacy_` object. |
| A fresh database is unchanged | "a fresh database is unchanged": migrations 1 to 13 each run once, in order, nothing set aside; the existing `test/db/database.test.ts` and `shared-cache.test.ts` pass unchanged. |
| Atlas answers on the laptop (`@e2e`) | See below. |

Extra cases in the same file: a clashing index and trigger are set aside, a second open changes nothing, and a second clash does not overwrite an earlier `legacy_` table. Atlas suite and `python3 scripts/check.py` results are in the PR. Choices: `docs/decisions/JP-163.md`.

## Still to check on the laptop

After the merge installs (about 10 minutes), the next start of the Atlas service renames the old `artifacts` table to `legacy_artifacts` and runs the migrations. Nothing edits `cache.db` by hand. Then:

1. `python3 ~/.josh-360/repo/scripts/doctor.py --only services`: `services.atlas-health` passes.
2. The cost tables (`messages`, `message_costs`, `jira_session_links`) have the row counts they had before, and `session-atlas.err.log` ends with `migration 1: set aside legacy artifacts -> legacy_artifacts` and no more "already exists" lines.
