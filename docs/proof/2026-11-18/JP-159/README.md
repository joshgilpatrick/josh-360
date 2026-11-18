# JP-159 proof: Session Atlas's two broken scripts

## Contents

- [What changed](#what-changed)
- [Scenarios](#scenarios)
- [What this does not fix](#what-this-does-not-fix)

## What changed

`apps/session-atlas/package.json` pointed `backfill` and `recompute-projects` at `src/transcript/backfill.ts`, a file the JP-111 move left behind in claude-360. `recompute-projects` now runs `src/cli/recompute-projects.ts` (the same logic, ported). `backfill` is removed, because sessions come from the ledger since JP-111. Choices: `docs/decisions/JP-159.md`. Nothing on the laptop, in macbook-automations or in claude-harness named either script.

All data here is made up: a temporary home folder with an empty or missing `cache.db`.

## Scenarios

| Scenario | Proof | Test |
| --- | --- | --- |
| @auto: both scripts run, or are removed and nothing names them | `01-recompute-tests.txt`, `02-run-the-scripts.txt` | `apps/session-atlas/test/cli/recompute-projects.test.ts`: "npm run recompute-projects runs ...", "every package.json script names a file that exists" |
| `recompute-projects` rewrites names and only raises secret flags | `01-recompute-tests.txt` | the same file, first two tests |
| @auto: the README says what is true | `apps/session-atlas/README.md`, the paragraph after the `artifacts.*` table | the tests above check every claim in it: the command, its output line, the exit 1 with no `cache.db`, and no `backfill` |
| The suites still pass | `03-suites.txt` | `npm run typecheck`, `npm test`, `python3 scripts/check.py` |

## What this does not fix

The doctor's hourly `backfills.retire-session-atlas` failure is a different job (`scripts/retire_session_atlas.py`), which never calls npm. Its reason is only in `~/.josh-360/logs/retire-session-atlas.log` on the laptop.
