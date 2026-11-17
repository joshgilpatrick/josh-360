# Move Session Atlas into josh-360 (JP-111) Implementation Plan

## Contents

- [Goal and constraints](#goal-and-constraints)
- [Where this fits](#where-this-fits)
- [Design choices](#design-choices)
- [Tasks](#tasks)
- [Out of scope](#out-of-scope)

## Goal and constraints

Bring Session Atlas (claude-360) into `apps/session-atlas` so that it has one data source, the ledger, makes no model call on any turn, and leaves the old database archived and unwritten. The ticket's acceptance: the same features with one data source; no model call per turn; the old store archived, not deleted, and no process writes to it.

JP-111 was `Not Started` when this build began. Its blocker (JP-108) is Done, and the ledger (JP-107) and walker (JP-114) are merged. Josh ruled on 17 November that everything in epic JP-94 is fair game once nothing blocks it, so the build starts without the backlog and sprint rule. Code is built and tested in the cloud on made-up data only. Nothing is deleted; every retirement is a switch-off plus an archive, and the permanent deletions wait in `docs/phase-1-deletion-list.md`.

## Where this fits

- Josh's 17 November review of the feature tree (JP-145): the dashboard, sessions grid and needs-attention views (S4, S5, S6) wait until the ledger is hardened; Send to Background (S7) is dropped; the focus worker (S3) is dropped for good. What comes in is the artifact manager and its removal guard, cost (as the ledger's cost tables) and the session index (as ledger data).
- The architecture page (JP-144) says Atlas's pages are switched off at JP-111.
- Changes to claude-360 itself wait for the phase 1 close (JP-120). This ticket only writes down what that notice PR will say.
- `docs/design/data-model.md`: the ledger is two files, `ledger.db` (facts, written by Python only) and `cache.db` (rebuildable working tables). The cost-import tables and the artifact catalog are working tables, so they live in `cache.db`.

## Design choices

1. **Headless.** `apps/session-atlas` keeps the artifact manager (catalog, output folders, discovery worker, removal check), the hourly cost import and the CLI (`npm run artifacts`, `npm run costledger`). It drops the dashboard and its web files, the focus worker and its providers, Send to Background, title and transcript runners, the hook-event ingest and the launchd installer.
2. **One more file, not a second database.** The service opens `~/.josh-360/state/cache.db` for its tables and `ledger.db` read-only. Atlas migrations 1 to 13 are kept intact because the catalog's shape check replays them, which leaves a few empty tables from the dropped features.
3. **Sessions are mirrored, not recorded.** `src/mirror/session-mirror.ts` copies sessions, lineage and ends from the ledger into `cache.db`'s `sessions` table, which the catalog's keys point at. It only adds and updates (the keys cascade, so deleting would drop catalog rows). A confirmed end comes only from the ledger's `session-end`; anything else is idle-closed or active, so the removal check still treats an unconfirmed end as unknown.
4. **Hooks move to josh-360's dispatcher.** The removal guard becomes `hooks/PreToolUse/10-atlas-removal-guard` and the Jira link hook becomes `hooks/PostToolUse/40-jira-session-link`. The session recorder (spool hooks) already exists from JP-107, so Atlas's own event hooks are retired and artifact evidence from hook events is retired with them. Passive discovery stays.
5. **Cost.** `ledger/costs.py` and the recorder read the cost tables from `cache.db`, falling back to the old cost ledger until the cutover has run.
6. **Cutover on the laptop** is two jobs. `retire-session-atlas` (once, after `ledger-backfill`) stops the old service, takes the old hook entries out of `~/.claude/settings.json` (with a backup), seeds `cache.db` from the old cost ledger and archives the old files. `session-atlas-service` (hourly) writes the launchd plist and keeps the new service on the latest code. Both are idempotent and tested against a fake `launchctl`.
7. **No per-turn spend.** The service imports no model client. A test fails if the source mentions an Anthropic SDK or API host.

## Tasks

1. **Move and trim** the code, tests and docs into `apps/session-atlas`; make it run against `cache.db` and `ledger.db` (`src/config.ts`).
2. **Session mirror and minimal session API** with tests (made-up ledger.db built by the tests).
3. **Hooks** in `hooks/`, with `tests/test_atlas_hooks.py`.
4. **Cost** repoint in `ledger/` with tests.
5. **Jobs**: `scripts/retire_session_atlas.py`, `scripts/atlas_service.py`, entries in `jobs.yaml`, tests.
6. **Docs and proof**: Atlas `README.md` and `AGENTS.md`, `docs/decisions.md`, `docs/phase-1-deletion-list.md`, `docs/surface-map.md`, proof under `docs/proof/2026-11-17/JP-111/`.
7. **Review ceremony and merge**, then JP-111 to Done.

## Out of scope

- New features, and the dashboard, sessions grid and needs-attention views (later, once the ledger is hardened).
- Send to Background (dropped).
- Any change to action-triage, claude-360 or claude-harness. The claude-360 notice PR waits for the phase 1 close.
- Moving the old artifact catalog's rows. It is rebuilt by passive discovery and the old file is archived.
