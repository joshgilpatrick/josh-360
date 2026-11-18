# JP-163 proof: Session Atlas starts on a cache.db seeded from the old cost ledger

## Contents

- [What was wrong](#what-was-wrong)
- [Scenario to proof](#scenario-to-proof)
- [Still to check on the laptop](#still-to-check-on-the-laptop)

## What was wrong

`scripts/retire_session_atlas.py` seeded `cache.db` with a copy of the old cost ledger, including the ledger's own artifact catalog (`artifacts` with a TEXT key, `artifact_locations`, `artifact_events`) and an empty `schema_migrations`. Atlas's migration 1 then tried to create its own `artifacts` table and failed with "table artifacts already exists", on every restart. Reproduced on made-up data before the change with exactly that message.

## Scenario to proof

| Scenario | Proof |
| --- | --- |
| Legacy catalog tables clash with migration 1 | `apps/session-atlas/test/db/legacy-clash.test.ts`: Atlas opens the file, `legacy_artifacts` holds the old rows, cost tables and rows are unchanged, a clashing index and trigger are set aside too, a second open changes nothing. |
| The seed leaves the old catalog behind | `tests/test_retire_session_atlas.py`, `test_the_seed_leaves_the_old_catalog_tables_behind`: `cache.db` has the cost rows and none of the three tables; the archived copy keeps them. |
| A fresh database is unchanged | `legacy-clash.test.ts`, last test (every migration once, in order, nothing set aside), plus the unchanged `test/db/database.test.ts` and `shared-cache.test.ts`. |
| Atlas answers on the laptop | `@laptop`, see below. |

Atlas suite: 1,072 pass, 0 fail, 17 skipped (skips pre-date this change); `npm run typecheck` clean; `python3 scripts/check.py` ok. Choices: `docs/decisions/JP-163.md`.

## Still to check on the laptop

After the merge installs (about 10 minutes), the next start of the Atlas service renames the legacy `artifacts` table to `legacy_artifacts` and runs the migrations. Nothing edits `cache.db` by hand. Then:

1. `python3 ~/.josh-360/repo/scripts/doctor.py --only services`: `services.atlas-health` passes.
2. Row counts of the cost tables (`messages`, `message_costs`, `jira_session_links`) match what they were before; `session-atlas.err.log` ends with a `migration 1: set aside legacy artifacts -> legacy_artifacts` line and no more "already exists" lines.
