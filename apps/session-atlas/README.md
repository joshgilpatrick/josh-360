# Session Atlas (josh-360)

## Contents

- [What it is](#what-it-is)
- [Where the data lives](#where-the-data-lives)
- [Run it](#run-it)
- [Hooks and the removal guard](#hooks-and-the-removal-guard)
- [Cost](#cost)
- [Configuration](#configuration)
- [Artifact manager](#artifact-manager)
- [npm run artifacts](#npm-run-artifacts)
- [Tests, benchmark and limits](#tests-benchmark-and-limits)

## What it is

Session Atlas is the file side of Josh 360: a headless service that finds the files a session made (the artifact catalog), answers "is it safe to remove this worktree?", and imports token cost from transcripts. It moved here from claude-360 in JP-111. It has no dashboard and **makes no model call**, on any turn or at any other time (`test/retire/no-model-call.test.ts` reads the source to prove it). It has no runtime dependencies.

What came with it: the artifact manager, the removal guard, the cost import and the `artifacts` and `costledger` commands. What did not: the dashboard and sessions grid (later, once the ledger is hardened), the focus worker and its providers, Send to Background, Atlas's own hook-event ingest and title runners, and the launchd installer (josh-360's `session-atlas-service` job installs the service now).

## Where the data lives

- **Sessions come from the ledger.** `~/.josh-360/state/ledger.db` is written only by josh-360's Python recorder. Atlas opens it read-only and every minute copies what the catalog needs (session id, folder, title, lineage, whether the ledger saw it end) into the `sessions` table of `cache.db` (`src/mirror/session-mirror.ts`). It only adds and updates, never deletes, because the catalog's keys cascade from that table. Only the ledger's own `session-end` confirms that a session is over; anything else is idle-closed after 12 hours or still active, so the removal check treats an unconfirmed end as unknown.
- **`~/.josh-360/state/cache.db`** holds the artifact catalog, the cost-import tables and a few working tables. It is rebuildable working state and the only file Atlas writes. `ATLAS_STATE_DIR` moves both files (for tests).
- **`~/.josh-360/atlas/`** holds `atlas.log` and an optional `config.json` (`ATLAS_HOME` moves it).
- Atlas migrations 1 to 13 are kept intact, because the catalog's shape check replays them. A few empty tables from dropped features remain.

## Run it

On the laptop the hourly `session-atlas-service` job installs and loads `com.josh360.session-atlas` in launchd and restarts it when this folder's code changes (`scripts/atlas_service.py`). By hand, needing Node 22.18 or newer and no `npm install` for running:

```bash
node --disable-warning=ExperimentalWarning src/service/main.ts   # or: npm start
curl -s http://127.0.0.1:8770/api/health
```

`npm test` runs half as many test files at once as there are CPUs (at least one), so the suite's own load does not slow its timing tests. `npm run typecheck` needs `npm install` (TypeScript and the Node types).

Logs: `~/.josh-360/atlas/atlas.log` and `~/.josh-360/logs/session-atlas.{out,err}.log`. Stop it: `launchctl bootout gui/$(id -u)/com.josh360.session-atlas` (the job loads it again within the hour; remove the job from `jobs.yaml` to stop it for good). The old claude-360 service is retired by the once-job `retire-session-atlas`, which archives its files under `~/Archive/josh-360-retired/` with a README on how to put it back.

## Hooks and the removal guard

Both hooks load through josh-360's dispatcher (`hooks/dispatch`), not `~/.claude/settings.json`:

- `hooks/PreToolUse/10-atlas-removal-guard` runs `hooks/atlas-removal-guard.js` for the Bash tool only, with a 10 s guard deadline;
- `hooks/PostToolUse/40-jira-session-link` records a ticket link in the cost tables when a successful `jira workitem` transition or comment names an issue key. It always exits 0.

The guard stands between an agent and the removal of a Git worktree. `git worktree remove <path>` of a linked worktree runs `npm run artifacts -- check-removal` and is allowed only when the checker exits 0 and its JSON answer agrees; `--force`, a direct `rm` of a worktree or of a folder that contains one, and commands it cannot read safely that appear to target a worktree are blocked, each with a reason and the next step. When it runs, it fails closed: unreadable input, a timeout, a crash, a checker that cannot run, or a command it cannot judge (a command that mentions a deletion and holds a NUL character or is over 64 KiB; a large command that mentions no deletion is not refused and passes) all end in a block.

### Removal guard limits
This is a guard for the supported agent workflow, not an OS-level protection boundary: other terminals, programs and filesystem APIs are not intercepted, and a target computed at run time (a variable, a command substitution) is judged by its text only. Not covered:
- `git clean -fdx` (in a worktree, or with `-C`) and `rm` of a file or folder inside a worktree: only the worktree itself and its ancestors are protected;
- `rm -rf <main checkout>/.git`, `mv <worktree> ...` and `git branch -D`;
- aliases: the guard does not read your Git configuration, so an alias for `worktree remove` is caught only when the command text contains `worktree`, `remove` or `prune`;
- a command name computed in the middle of a word (`a${c}m`), or a target computed by a command other than `pwd` or `git rev-parse --show-toplevel`;
- a session whose end Atlas did not see is not proof that its Claude Code process stopped, and Atlas looks at no processes. A session the service closed as idle (12 hours by default), or closed before this version recorded how sessions end, therefore leaves the check incomplete (exit 2, `session-unknown`, naming the session) whenever its start or resume folder is the worktree or inside it, or when it recorded no folder at all (where it ran is not known); it never counts as inactive. Only a SessionEnd hook confirms an end (for a subagent, the SessionEnd of its root session), and a hook event written after that SessionEnd withdraws the confirmation until the session ends again (a late-delivered event written before the end does not; a subagent's later event also withdraws its root's). A SessionEnd written before the session's latest recorded hook activity is stale: it changes nothing, however late it is delivered. Confirm that the process has exited, then remove the worktree yourself from your own terminal, or check again after the session ends. Sessions closed before this version stay unconfirmed for good, so a worktree that older sessions used needs this once;
- the guard cannot run when `node` is not on the PATH Claude Code uses, or after the checkout moved (the hook command fails and the command is allowed): the hook is a file in josh-360's `hooks/`, so a moved checkout moves with it;
- the plist's `ATLAS_HOME`, `ATLAS_STATE_DIR` and `ATLAS_PORT` are not inherited by the guard or by the checker it starts, which read them from the environment Claude Code runs in (`JOSH360_HOME` is inherited through the dispatcher). With custom values, set the same variables there, or every removal is blocked (the checker cannot find the catalog or the service: exit 2);
- a huge worktree can exceed the guard's 8 s checker budget and is blocked: run `npm run artifacts -- check-removal --worktree <path> --timeout-ms 60000` yourself until it exits 0, then remove the worktree from your own terminal.

## Cost

Atlas imports message-level token usage from Claude Code, OpenCode and Pi, prices it and keeps the result in the cost tables of `cache.db`. It shows no cost itself: josh-360's ledger (`ledger/costs.py`) copies cost, ticket links and titles from those tables into `ledger.db`, where cost is read. Imports, pricing and reports are the `costledger` command (`npm run costledger -- <command>`); see the [operator guide](docs/costledger.md). The service starts an import when it starts and then hourly. Unknown cost is `null`, never `$0`.

## Configuration

Environment: `ATLAS_PORT` (8770), `ATLAS_HOME` (`~/.josh-360/atlas`), `ATLAS_STATE_DIR` (`~/.josh-360/state`), `JOSH360_HOME` (`~/.josh-360`).
Optional `~/.josh-360/atlas/config.json` with `transcript` and `worker` blocks (see `src/config.ts`). More optional blocks tune the index: `artifacts` (below), `projects.aliases` (path prefix to project name; longest prefix wins) and `sessions.idleCloseHours` (default 12: sessions idle that long with no fresh transcript are marked closed). Example:

```json
{
  "artifacts": { "ignoreSegments": [".scratch"], "sensitivePatterns": ["*.kdbx"], "outputRoots": [{ "path": "~/deliverables", "label": "Deliverables" }] },
  "projects": { "aliases": { "/Users/me/development/active/josh-360": "josh-360" } },
  "sessions": { "idleCloseHours": 12 }
}
```

Every `artifacts.*` key is optional. A list you configure **replaces** the default list (it does not add to it), and an explicit `[]` clears it, except `documentExtensions`: `[]`, or a list with no usable extension, falls back to the default list with a warning. A number outside its range is clamped, and anything that is not a number falls back to the default, each logged as an `artifacts config warning` in `atlas.log` when the artifact manager starts; a malformed entry is ignored, never repaired.

| Key | Default (range) | Meaning |
|---|---|---|
| `artifacts.documentExtensions` | md, markdown, txt, rst, html, htm, pdf, doc, docx, rtf, odt, csv, tsv, xls, xlsx, ods, ppt, pptx, odp, json, sql | Extensions discovery treats as documents, and the default "Documents" filter. A leading dot and letter case are ignored; an invalid entry is dropped with a warning. |
| `artifacts.sensitivePatterns` | `["*.kdbx"]` | Extra filename globs (`*` only, case-insensitive) marked as secret files, on top of the built-in patterns, which always apply and match the file name only, case-insensitively: `.env` and `.env.<anything>` (so `.env.local`, but not `.envrc` or `.env-prod`); any name ending in `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.secret` or `.token`; `id_rsa`, `id_dsa`, `id_ecdsa` and `id_ed25519`, alone or with a `.<anything>` suffix (`id_rsa.pub`, but not `id_rsa_old`); `credentials`, `secret` and `secrets`, alone or with a `.<anything>` suffix (`credentials.json`, but not `credentials-prod.json` or `secrets-old.txt`); and exactly `.netrc`, `.npmrc` and `.pypirc`. Any other name is not flagged. |
| `artifacts.ignoreSegments` | `[".scratch"]` | Folder names never indexed, on top of the built-in dependency, build, cache and tool-scratch names. |
| `artifacts.outputRoots` | `[]` | Output folders to scan: `{ "path": "~/x" or an absolute path, "repositoryId": uuid, "label": text, "protected": true }` (only `path` is required). Not the home folder or a parent of it, no `..`. A malformed entry disables that root, and a mistyped `protected` disables it rather than unprotecting it; the same path twice is one root and `protected` sticks. |
| `artifacts.durableOutputBase` | `~/.claude/artifact-output` | Base of `npm run artifacts -- output-dir`: `<base>/<repository-uuid>/deliverables`. |
| `artifacts.initialLookbackDays` | 7 (0–3650) | How far back the first scan of a root looks; `refresh --include-older` reaches beyond it. |
| `artifacts.recoveryIntervalMs` | 600000 (60000–86400000) | Safety-net rescan of registered roots, with fresh Git answers. |
| `artifacts.statusMinIntervalMs` | 30000 (30000–3600000) | At most one Git status pass starts per checkout in this time. |
| `artifacts.debounceMs` | 2000 (0–30000) | Wait after a file change before scanning. It is also the settle quiet period: a working version is recorded only once the file has gone this long without changing. Watcher and scan observations wait; a write a hook or transcript reports is recorded at once. |
| `artifacts.maxEntriesPerSlice` | 5000 (100–50000) | Directory entries examined per scan slice. |
| `artifacts.maxSliceMs` | 2000 (100–10000) | Time per scan slice. |
| `artifacts.maxRowsPerFrame` | 32 (1–250) | Rows the service commits in one transaction, per worker frame and per legacy-backfill batch. |
| `artifacts.gitTimeoutMs` | 10000 (1000–60000) | Timeout of one Git command. |
| `artifacts.gitMaxOutputBytes` | 8388608 (1048576–67108864) | Output cap of one Git command; output beyond it makes that scan incomplete, never complete. |
| `artifacts.hashMaxFileBytes` | 67108864 (0–1073741824) | Removal checker: the largest file or blob it compares; a larger one makes the answer incomplete. |
| `artifacts.hashMaxJobBytes` | 134217728 (0–1073741824) | Removal checker: the bytes it reads in all; beyond that the answer is incomplete. |
| `artifacts.hashMaxJobMs` | 5000 (0–60000) | Accepted and range-checked, but nothing reads it yet. |

Project names come from the git `origin` remote (repo name), then the git top-level folder, then the folder name. Secret files are matched by **filename only**: Atlas never reads file content. After changing aliases or sensitive patterns, stored project names and secret flags are meant to be rewritten by `npm run recompute-projects`, which would **raise** the secret flag of existing rows whose filename now matches and never lower one (a flag can also come from the location, a folder named exactly `phi` or `.phi`, any case, or from a manual flag). That script does not run today: `package.json` points `recompute-projects` and `backfill` at `src/transcript/backfill.ts`, which is not in this folder.

## Artifact manager
The catalog (served at `/api/artifacts`; there is no page for it since JP-111) lists documents, not file paths: one row per logical document, with the locations that hold it, its versions and the session evidence behind it.

- **Grouped browser.** Rows group by project and day, by session, or as a flat list, and filter by search text, project, extension, session, date, availability, source, document types ("Documents" or "All file types") and "needs preservation". The coverage report lists every registered folder with its scan state (up to date, queued, scanning, partial, failed, inaccessible) and its gaps.
- **What is scanned.** The folders of recently active Claude Code sessions (up to 40 sessions active in the last 6 hours) and their Git checkouts, the folders in `artifacts.outputRoots`, and folders you register (`register-output` below). Discovery runs in one bounded worker process, started when needed. The API can pause and resume discovery and refresh a root ("Import older files" included); the pause survives a restart.
- **Evidence is labelled.** Each piece of session evidence is `recorded` (seen directly in a session event), `inferred` (deduced from timing or file changes; not confirmed) or `unknown` (nothing reliable ties the session to the file). "Created" is shown only for a recorded or inferred creation; an edit is "Modified" and is never presented as authorship. Evidence belongs to the document first: an event is tied to one version only when the stat that produced that version began after the event was reported and the event is the latest one before it. An earlier write that nothing observed, or one reported after the stat began, stays with the document and is not attributed to a version.
- **Availability is what Atlas last proved.** A document is a verified local file, Git only, last known (a local file seen earlier and not verified since) or contents unavailable. A Git version whose object Atlas has not checked yet is shown as "not checked yet", not as gone, and Preview and Export are still offered for it; the check runs in the background when a checkout is reachable.
- **Protected documents** (a folder named exactly `phi` or `.phi`, any case, anywhere in the path (the name must match exactly: `Delphi` or `.phix` is not PHI), a secret-looking filename, or an output folder configured `protected: true`) are hidden by default; the `visibility` query shows or isolates them. Atlas never reads file content to decide this. Export of a protected document is refused unless its project has a protected output folder and protected documents are shown.
- **Preservation is advisory.** Every version starts as "preservation unknown" and nothing updates that afterwards, so "needs preservation" currently means "has a live working copy or a staged snapshot", not "is known to exist nowhere else". Treat it as a prompt to check before removing a worktree, never as proof either way.

## npm run artifacts
`npm run artifacts -- <command>`. It never writes the Atlas database or the cost ledger (catalog changes go through the running service) and never deletes, moves or overwrites anything.

| Command | What it does |
|---|---|
| `status [--json]` | Coverage from the local service: discovery paused or running, the queue, and every registered root with its state, gaps and failures. A protected location is shown as "Protected location (hidden)". |
| `refresh --root ID [--include-older]` | Queues a rescan of one registered root (`status` lists the IDs); it only queues. `--include-older` also imports files and Git history older than the usual look-back (`artifacts.initialLookbackDays`, 7 days by default). |
| `register-output --path ABS [--repo ABS]` | Registers an existing folder as an output root. The service refuses secret, runtime and out-of-home folders. `--repo` ties it to the registered checkout that contains that path. |
| `output-dir --repo ABS [--create]` | Prints the durable output directory `<base>/<repository-uuid>/deliverables` of the repository containing that path; the path is the only line on stdout, so `ATLAS_OUTPUT_DIR="$(npm run -s artifacts -- output-dir --repo "$PWD" --create)"` works. `--create` makes it private (mode 0700) and registers it. A symbolic link, a directory that is not yours or is open to group or others, or one inside a checkout is refused. The repository must already be registered. |
| `check-removal --worktree ABS [--json] [--timeout-ms N]` | Read-only check to run immediately before ONE ordinary `git worktree remove <path>` of that linked worktree. The answer is valid for that next removal only, never authorizes `--force`, and nothing is removed by it. It works while Atlas is stopped (the sessions are then unknown: exit 2). `--timeout-ms` is 1000–120000, default 8000; use `--timeout-ms 60000` for a huge worktree. |

Exit codes. `check-removal`: **0** a complete check found nothing at risk (the only code that permits the removal), **2** incomplete (coverage or proof is missing, or the sessions are unknown: a live session, or one closed without a confirmed end, in the worktree), **3** risks were found. Every command: **64** usage error, **65** `output-dir`: repository not registered or directory unsafe, **69** the Atlas service is unavailable or refused the request, **70** internal error. A usage or internal error never exits 0, 2 or 3.

## Tests, benchmark and limits

- `npm test` runs `test/**/*.test.ts`. The session mirror's tests build a made-up ledger from `ledger/schema.sql`, so a change to the ledger's columns breaks them here first.
- `npm run perf` seeds 10k sessions and 100k artifacts in a temp database and asserts p95 list queries under 100 ms, then runs the artifact-manager performance file. `npm run seed -- --home <dir>` builds a seeded home.
- Artifact evidence from hook events is retired with Atlas's own hooks: a file is tied to a session by folder and time and labelled `inferred` or `unknown`, never `recorded`.
- The old claude-360 benchmark runbook (`deliverables/2026-10-27/artifact-manager-benchmark-results.md` in that repository) is not carried over. The macOS gates it listed (the real-database migration, the launchd lifecycle, Finder, FSEvents burst and dirty-walk, the removal guard and git-lfs checks) have not been run for the move; the first run on the laptop is the check.
- Directory fan-out is not bounded in discovery: one flat folder is listed whole on every slice. A single folder of several hundred thousand entries can exceed the 256 MiB worker memory target (measured: 300,000 entries about 224 MiB); a cap is planned.
- Device-number reuse: if a different volume is later mounted at the same path under a device number the system reused, with the same folder layout, Atlas can show files of the earlier volume as "missing" (display only; nothing is deleted).
- Preservation state is advisory, and the removal guard has the limits listed above.
- Claude Code's own configuration is mostly kept out of the catalog: `settings.json` and `settings.local.json` in any `.claude` folder and `.claude/cost-ledger` are never catalogued, and neither are `~/.josh-360/{atlas,state,backups,logs}`.
