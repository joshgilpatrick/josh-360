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
