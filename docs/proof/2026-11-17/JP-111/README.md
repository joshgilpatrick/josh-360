# JP-111 proof: move Session Atlas into josh-360 and onto the ledger

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)
- [What this does not do](#what-this-does-not-do)

## Scenarios

Everything here ran in the cloud on made-up data: a ledger built from `ledger/schema.sql` with made-up rows, a made-up home folder, a fake `launchctl` and a fake `node`. No real transcript, settings file or launchd was touched. Josh's acceptance for the ticket was: the same features with one data source (the ledger), no model call per turn, and the old store archived, not deleted, with no process writing to it.

| Acceptance | Proof | Test |
| --- | --- | --- |
| One data source: sessions come from the ledger, read only | `02-session-mirror-and-shared-cache.txt` | `test/mirror/session-mirror.test.ts`: ended, quiet and live sessions, lineage, never deletes, never writes `ledger.db`, a missing ledger is skipped (not read as empty) |
| Cost and catalog share one rebuildable file | `02-session-mirror-and-shared-cache.txt` | `test/db/shared-cache.test.ts`: Atlas's migrations run on top of a cost-ledger file and keep its rows |
| No model call, on any turn or at all | `01-no-model-call.txt` | `test/retire/no-model-call.test.ts`: no model SDK, API host, provider setting, `fetch` or `claude` launch in `src/` or `hooks/`; no runtime dependency in `package.json` |
| Old store archived, not deleted; nothing writes it afterwards | `03-retire-job.txt`, `07-retire-dry-run-made-up-home.json` | `tests/test_retire_session_atlas.py`: stops the old job, moves the plist, `atlas.db` and the old cost ledger (with `-wal` and `-shm`) into the archive, takes out only the old hook entries (backup kept, owner only), seeds `cache.db` from the old cost ledger without overwriting an existing one, waits for the ledger backfill, changes nothing on a dry run or a second run, fails without touching files when the job will not stop |
| The new service stays up | `04-service-job.txt` | `tests/test_atlas_service.py`: writes the launchd plist, loads it, restarts it on new code, waits for the retirement, refuses an old Node, never names another label |
| The removal guard and the Jira link hook still work from josh-360's hooks | `05-hooks.txt` | `tests/test_atlas_hooks.py`: ignores other tools, lets `ls` through, blocks `git worktree remove --force`, Jira hook writes `cache.db` and prints nothing |
| Cost reaches the ledger from `cache.db` | `06-cost-repoint.txt` | `tests/test_ledger_costs.py` (`DefaultPath`): uses `cache.db` once it holds the cost tables, otherwise the old cost ledger |
| The suites pass | `08-atlas-suite.txt`, `09-repo-suite.txt` | `npm test` in `apps/session-atlas` (1,075 tests, as a non-root user 1,062 pass and 13 skip) and `python3 scripts/check.py` |

`07-retire-dry-run-made-up-home.json` shows the retire job's own report on a made-up home: what it would stop, move, remove from settings and seed. It names no session, title or path.

## What still needs the laptop

Nothing needs Josh. These happen on their own after the merge (merging to `main` installs on the laptop, JP-105), and each can be checked afterwards in `python3 laptop/status.py show` and in `~/.josh-360/logs/`:

1. **`retire-session-atlas`** runs once, after `ledger-backfill` has succeeded (it retries hourly until then). Its report on the `laptop-status` branch should say `result: ok`, `cache_db: seeded` and how many hook entries it removed. The archive is `~/Archive/josh-360-retired/<date>/session-atlas/`, with a README that puts the old Atlas back. `~/.claude/settings.json` will show as changed in the claude-harness repository; that is expected, and the change is committed there at the phase close.
2. **`session-atlas-service`** then loads `com.josh360.session-atlas`. `curl -s http://127.0.0.1:8770/api/health` should answer, and `~/.josh-360/atlas/atlas.log` should say `atlas listening` and, within a minute, nothing about `ledger.db not readable`.
3. **The hooks.** Run `git worktree remove --force /tmp/x` in a Claude Code session: it should be blocked with a reason. This needs the claude-harness settings to register a `PostToolUse` entry for the dispatcher as well as `PreToolUse`; if the Jira link hook never fires, that registration is the cause (the guard itself needs only `PreToolUse`, which is already registered).
4. **First scan.** The artifact catalog starts empty (the old catalog is archived, not migrated). Discovery rebuilds it from the folders of recent sessions; `npm run artifacts -- status` shows its progress. The macOS gates that claude-360 listed (FSEvents burst, Finder, foreground responsiveness) have not been run on the move and are the first thing to watch.

## What this does not do

- The dashboard, sessions grid and needs-attention views (later, once the ledger is hardened) and Send to Background (dropped).
- The claude-360 notice PR and any other change to claude-360, claude-harness or action-triage. Those wait for the phase 1 close (JP-120). Their deletions are on `docs/phase-1-deletion-list.md`.
- Moving the old artifact catalog's rows. It is rebuilt by discovery and the old file is archived.
