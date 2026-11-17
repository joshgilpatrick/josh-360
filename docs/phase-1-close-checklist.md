# Phase 1 close checklist

## Contents

- [How to use this list](#how-to-use-this-list)
- [Move the Session Atlas service onto the startup list (JP-119)](#move-the-session-atlas-service-onto-the-startup-list-jp-119)
- [Bring in the skill sync (JP-119)](#bring-in-the-skill-sync-jp-119)
- [After the close](#after-the-close)

## How to use this list

Changes to Josh's other repositories (macbook-automations, claude-harness, claude-360) wait for the phase 1 close (JP-120), where Josh merges them with the rest. A ticket that has such a change writes the steps here, so the closing thread can do them in order without re-reading the ticket. Permanent deletions go on `docs/phase-1-deletion-list.md`, not here. JP-120 adds the other tickets' steps.

## Move the Session Atlas service onto the startup list (JP-119)

Why: Josh 360 should ship no job installer of its own (JP-119). Today `scripts/atlas_service.py`, the `session-atlas-service` job, writes `~/Library/LaunchAgents/com.josh360.session-atlas.plist` and loads it, because Session Atlas is a long-running service and the job runner is not one. It cannot go until the service's definition is on the macbook-automations startup list, because the worktree removal guard fails closed when it cannot reach Atlas: switching the installer off first would block every `git worktree remove`. `laptop/check_jobs.py` shows this as the one known gap, and `tests/test_no_installers.py` allows exactly this one installer.

Do these two steps in this order:

1. **macbook-automations** (pull request, Josh merges it at the close). Add three things, in the style of `scripts/josh-360-jobs.sh` and its plist:
   - `launchd/com.josh360.session-atlas.plist`: label `com.josh360.session-atlas`, runs `/bin/bash scripts/josh-360-atlas.sh`, `RunAtLoad` and `KeepAlive` true, `ThrottleInterval` 5, `ProcessType` Background, logs to `/Users/jgilpatrick/.josh-360/logs/session-atlas.out.log` and `.err.log`.
   - `scripts/josh-360-atlas.sh`: waits (sleeps, then exits so launchd starts it again) until `retire-session-atlas` has a `last_result` of 0 in `~/.josh-360/state/jobs-state.json`; finds Node 22.18 or newer the way `scripts/atlas_service.py` does (`find_node`); then `exec`s `node --disable-warning=ExperimentalWarning ~/.josh-360/repo/apps/session-atlas/src/service/main.ts` from `~/.josh-360/repo/apps/session-atlas`. Add a test beside `tests/test_josh_360_jobs.py`.
   - One line in `launchd/startup-manifest.txt` under the Josh 360 comment, then `scripts/startup.sh`. `startup.sh` boots out a label before it bootstraps it, so it takes over from the interim plist.
2. **josh-360** (small follow-up pull request, an agent merges it):
   - Archive the interim `~/Library/LaunchAgents/com.josh360.session-atlas.plist` (a launchd agent in `~/Library/LaunchAgents` also loads at login, so leaving it beside the startup list's copy makes two definitions of one label). Do it in a one-time job that moves the file into `~/Archive/josh-360-retired/<date>/session-atlas-interim/`, as `scripts/retire_leftover_jobs.py` does.
   - Replace `scripts/atlas_service.py` with a restart-only job: when the code under `apps/session-atlas` has changed since the service started, `launchctl kickstart -k gui/<uid>/com.josh360.session-atlas`; it never writes a plist and never bootstraps. Keep its test for the restart rules (Node reads its modules only at start).
   - In `laptop/launchd-register.json`, remove the `transitional` row. In `tests/test_no_installers.py`, drop `scripts/atlas_service.py` from `USES_LAUNCHAGENTS` and make `test_only_the_transitional_atlas_installer_writes_a_plist` assert that no file writes a plist.
   - Delete the "interim" note from `scripts/atlas_service.py`'s replacement and from `AGENTS.md`.

Check afterwards: `python3 laptop/check_jobs.py` on the laptop prints no difference and no known gap, and `curl -s http://127.0.0.1:8770/api/health` answers.

## Bring in the skill sync (JP-119)

`com.jgilpatrick.sync-client-skills` keeps the skill links for OpenCode, Pi and Codex current. It runs when `~/.claude/skills` changes, which needs a `WatchPaths` entry that the Josh 360 job runner does not offer, so JP-119 left it where it is (`laptop/launchd-register.json`, decision `bring-in-at-close`). At the close, in the claude-harness and macbook-automations pull requests: add its plist to macbook-automations `launchd/` and to the startup manifest, keep its script in claude-harness, then move the `elsewhere` row to the startup list by deleting it from the register and archive the copy in `~/Library/LaunchAgents`.

## After the close

Run `python3 laptop/check_jobs.py` on the laptop, or read `reports/launchd-check.json` on the `laptop-status` branch (`git show origin/laptop-status:reports/launchd-check.json`). Zero differences means every job the laptop runs is on the startup list or named in the register with a reason.
