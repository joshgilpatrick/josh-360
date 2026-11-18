# JP-163 proof: Session Atlas starts on a seeded cache.db

## Contents

- [What was wrong](#what-was-wrong)
- [Scenario to proof](#scenario-to-proof)
- [Still to check on the laptop](#still-to-check-on-the-laptop)

## What was wrong

`migrate()` skipped a migration only when `schema_migrations` listed it. A `cache.db` that already had Atlas's tables and an empty `schema_migrations` made it replay migration 1, which failed with "table ... already exists", so Atlas never started. Reproduced on made-up data before the change: `table sessions already exists` for a full schema, and `table artifacts already exists` (the laptop's message) when `sessions` is missing.

## Scenario to proof

| Scenario | Proof |
| --- | --- |
| Tables present, no migration record | `apps/session-atlas/test/db/adopt-existing-schema.test.ts`: "tables present, no migration record" and "a half-present migration 1". |
| A missing migration still runs | Same file: "a missing migration still runs" (migrations 1 to 5 present, 6 to 13 run, `end_reason` exists) and "only the missing column runs". |
| A fresh database is unchanged | Same file: "a fresh database still runs every migration once, in order"; the existing `test/db/database.test.ts` and `shared-cache.test.ts` pass unchanged. |
| Atlas answers on the laptop | `@laptop`, see below. |

Atlas suite: 1,073 pass, 0 fail, 17 skipped (the skips were there before). `npm run typecheck` clean. Choices: `docs/decisions/JP-163.md`.

## Still to check on the laptop

After the merge installs, run `python3 ~/.josh-360/repo/scripts/doctor.py --only services`. `services.atlas-health` should pass. Nothing edits `cache.db` by hand; Atlas adds the missing `schema_migrations` rows itself on its next start.
