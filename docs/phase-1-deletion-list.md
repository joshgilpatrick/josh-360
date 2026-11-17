# Phase 1 deletion list

## Contents

- [How to use this list](#how-to-use-this-list)
- [Waiting for Josh's approval](#waiting-for-joshs-approval)

## How to use this list

Retiring is two moves. Switching off and archiving is reversible and needs nobody. Permanent deletion waits here, in one list per phase, for Josh's approval in one sitting at the phase close (JP-120). A ticket that retires something adds a row. Nothing on this list has been deleted. JP-120 also collects the rows in the "Deletion list" column of the dismantling plan in `docs/inventory/laptop.md`.

## Waiting for Josh's approval

| Item | Where it is | Archived by | Notes |
| --- | --- | --- | --- |
| The focus loop archive: `archive/focus/` (hooks, `/focus` skill, dashboard tools, the focus-aware compaction files, old tests, `restore.sh`) | claude-harness repository | JP-100, claude-harness PR on branch `claude/project-thread-llrs18` | Git history keeps every file even after the folder goes. Delete only once Josh is sure he will not bring `/focus` back. |
| The archived focus dashboard plist `com.eventus.focus-dashboard.plist` | Laptop: `~/Archive/josh-360-retired/<date>/focus-dashboard/` | JP-100, one-time job `retire-focus-dashboard` | The folder also holds a README with the two commands that put the job back. |
| `~/.claude/session-focus/` | Laptop | Not archived: it held no files on 16 November | Delete the empty folder, or any `closed/` files that remain. The job's report says how many files it holds. |
| The old Session Atlas plist `com.eventus.claude-atlas.plist` | Laptop: `~/Archive/josh-360-retired/<date>/session-atlas/` | JP-111, one-time job `retire-session-atlas` | The folder holds a README with the commands that put the old Atlas back. |
| The old Atlas index `atlas.db` (with `-wal` and `-shm`), saved as `atlas-atlas.db*` | Laptop: the same archive folder | JP-111, `retire-session-atlas` | Holds focus text, the old artifact catalog and old session rows. The ledger has the sessions; the catalog is rebuilt by discovery. |
| The old cost ledger `ledger.db`, saved as `cost-ledger-ledger.db*` | Laptop: the same archive folder | JP-111, `retire-session-atlas` | Copied into `~/.josh-360/state/cache.db` first, so cost history carries on. Keep until the ledger's cost rows have been checked against it. |
| `settings.json.bak`, the settings file before the old Atlas hook entries came out | Laptop: the same archive folder | JP-111, `retire-session-atlas` | Mode 0600 because settings can hold credentials. Delete once the new settings have been checked. |
| The Session Atlas code and docs in the claude-360 repository, and the `claude-atlas` Keychain item | claude-360 repository; Laptop login keychain | Not archived by JP-111: other repositories wait for the phase 1 close | Archive claude-360 with a notice that Session Atlas now lives in josh-360 `apps/session-atlas`. The Keychain item was only for the focus worker. |
| The `~/.claude/atlas/` folder (logs, spool, `config.json`) | Laptop | Not touched by JP-111 | Delete once nothing reads it. Josh's `config.json` aliases are copied by hand to `~/.josh-360/atlas/config.json` if wanted. |
