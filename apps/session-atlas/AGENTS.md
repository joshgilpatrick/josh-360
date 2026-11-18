# Agent Notes: Session Atlas (apps/session-atlas)

Read `README.md` for what it is and how it runs. This file holds the rules agents must follow when changing it. The repository-wide rules are in `/AGENTS.md` at the josh-360 root; where the two differ, the root file wins.

## Contents

- [No model call](#no-model-call)
- [Sessions come from the ledger](#sessions-come-from-the-ledger)
- [Cost](#cost)
- [Database migrations](#database-migrations)
- [Tests and checks](#tests-and-checks)
- [Working in this folder](#working-in-this-folder)

## No model call

- Atlas makes no model call, on any turn or at any other time, and has no runtime dependency. `test/retire/no-model-call.test.ts` fails on an Anthropic SDK import, a model API host, a provider setting, a `fetch(` or a `claude` launch in `src/` or `hooks/`.
- Do not add a focus, summary or title worker here. Summaries are the ledger's job (`ledger/summary.py`, JP-108), and cost to the ledger's cheap tier.

## Sessions come from the ledger

- `~/.josh-360/state/ledger.db` is written only by Python. Atlas opens it read-only, in one place: `src/mirror/session-mirror.ts`. Do not add a second reader and never write to it.
- The mirror copies into `cache.db`'s `sessions` table. It must only insert and update (`ON CONFLICT DO UPDATE`), never delete or `INSERT OR REPLACE`, because the artifact catalog's foreign keys cascade from that table.
- Only the ledger's `session-end` confirms that a session is over. Anything else is idle-closed or active, so the removal check reports it unknown. Do not make an unconfirmed end look confirmed.

## Cost

- The cost import writes its tables into `cache.db` through `src/costledger/` only. Atlas shows no cost. josh-360's `ledger/costs.py` copies cost into `ledger.db`; it never writes these tables.
- Unknown cost is `null`, never `$0`. Pricing and imports belong to the cost ledger commands (`npm run costledger -- <command>`, see `docs/costledger.md`).

## Database migrations

- Migrations live in `src/db/migrations.ts`. Add new ones at the end with the next id. Migrations 1 to 13 stay as they are, because the catalog's shape check replays them.
- Each migration runs in its own transaction.
- A database that holds Atlas's tables but has no `schema_migrations` rows (the retire job seeds `cache.db` from an older file) is adopted, not replayed (JP-163): `src/db/adopt.ts` holds one schema probe per migration, and `migrate()` records a migration whose effect it finds and runs the rest. A new migration adds its probe there, or it is treated as not yet applied. Migration 1 runs as "create if missing" on such a file.
- A migration that drops tables with foreign keys can be slow to run with enforcement on. Mark it `noForeignKeys: true` so `migrate()` turns enforcement off for it and checks `PRAGMA foreign_key_check` before commit.
- Migrations 6 and 8 are guarded by a preflight backup check (`src/db/preflight.ts`) when the database has data. Do not bypass it. Any new destructive migration needs the same guard added in `src/db/database.ts`.
- `cache.db` is rebuildable working state. Anything that must last belongs in the ledger, not here.

## Tests and checks

- Run `npm test` (`node:test`, `test/**/*.test.ts`) before you call a change done, and `npm run typecheck` (it needs `npm install` for TypeScript).
- Tests use made-up data in temp folders and never the real home. Use `ATLAS_STATE_DIR` and `ATLAS_HOME` to point Atlas at them.
- A test that describes the docs or removed code is kept in `test/retire/`.
- Code that runs on the laptop (here, Node) needs Node 22.18 or newer and nothing else installed.

## Working in this folder

- Keep one logical change per commit.
- Never put patient data in a test, a log line or a commit. Atlas reads file names and folder names only, never file content.
- The hooks are files in the josh-360 `hooks/` folder (`10-atlas-removal-guard`, `40-jira-session-link`) that call into this folder. Change them with their test, `tests/test_atlas_hooks.py`.
