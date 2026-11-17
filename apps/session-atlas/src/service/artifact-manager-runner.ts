// The Artifact Manager's scheduler (plan 2026-10-26 Task 7; spec s2, s4, s6 and s10). One runner in the service loop drives
// ONE worker process (artifact-worker.ts) through ONE task at a time, and is the only code that applies worker results to the
// catalog. It never awaits a whole scan: each run() handles at most one frame (or claims one job, or one legacy-backfill batch
// of at most artifacts.maxRowsPerFrame rows) and returns, so every other runner keeps being serviced. Every such catalog commit
// is followed by one turn of the event loop (PERF-GAP-3), and the worker is asked for frames of at most maxRowsPerFrame rows
// (default 32; the frozen frame maximum of 250 stays the bound), so one commit blocks the loop for tens of milliseconds.
//
// Per tick:
//   1. Watcher hints (markDirty) are debounced in memory and turned into jobs: exact paths become `direct-observation` checks
//      at `dirty` priority; an overflow, a watcher error or too many paths dirties the folder's scope (a recovery pass).
//   2. With a job in flight: take the next frame (waiting at most frameWaitMs), validate it IN THE SERVICE (frame bounds and
//      kind invariants, the claimed root still active, every row's root, kind and evidence shape, each path inside the root,
//      re-authorized against the registered roots, and its identity recomputed by the path policy), then commit the rows and
//      the checkpoint in ONE transaction (commitArtifactBatch, the R26 history cursor, provisional-document adoption, session
//      inference, counters) and only then acknowledge. A rejected frame or a failed commit is never acknowledged: the worker
//      is restarted and the job retries from its last committed checkpoint (replay is idempotent). A worker crash or hang
//      does the same.
//   3. Otherwise: reconcile roots when due (async, in the background, while no job runs), schedule recovery, honour pause
//      (no claim at all) and the 1 s pause after a background slice, then claim the next job: lowest priority number first
//      (direct 0, dirty 10, recovery 20, verify 30, backfill 40), longest waiting first within a priority, so a large root
//      that yields a slice goes behind smaller scopes (fairness, Task 2).
//
// Frame outcomes, classified only through artifactWorkerErrorKind (Task 5):
//   none/gap  progress: commit; a terminal frame finishes the slice (complete => pass done, else requeued to resume). A gap
//             keeps coverage partial with its codes recorded under coverage-reason:<rootId>; it is never retried.
//   result    a direct check's definitive answer: commit and finish; `path-missing` marks the known location missing.
//   restart   the cursor was discarded: commit (cursor null) and requeue; a git-history pass drops its stored cursor.
//   retry     transient: commit the checkpoint, then retry after 2, 10, 30, 120 and 300 s; after that the job is failed
//             (the Retry action is a refresh). Status shows queued/inaccessible with the reason meanwhile.
//   failed    deterministic: commit the checkpoint WITHOUT completing, fail the job; nothing retries it until activity
//             or a configuration change requeues it (recovery skips scopes listed under job-failed:<task>:<rootId>).
// Partial or inaccessible results never complete a generation (Task 2 records a pass generation only for complete: true).
//
// State this runner keeps in artifact_manager_state (no paths or contents in any key or value; root IDs are UUIDs):
//   pass-start:<rootId>, pass-since:<rootId>            start time (ISO) and import cutoff (epoch ms) of the root's current
//                                                       scan pass (R24); pass-since is deleted when the pass completes
//   pass-start:git-history:<rootId>, pass-since:git-history:<rootId>   the same for the root's Git history pass
//   history-cursor:<rootId>                             the completed history pass's cursor (persisted ref tips), R26
//   coverage-reason:<rootId>, coverage-reason:git-history:<rootId>    the root's coverage note for a gap-partial pass (key and
//                                                       JSON shape defined once in src/db/artifact-manager.ts, R71); a scan
//                                                       task's `lookback-limited` stays until a pass of that task that
//                                                       imported older files completes (R67)
//   job-failed:<task>:<rootId>                          the failure code of a failed root-scoped job (recovery skips it)
//   recovery-done:<scope key>                           ISO time the last pass of a recovery scope completed: <task>:<rootId>,
//                                                       git-history-repository:<repositoryId>, legacy-backfill:legacy-backfill,
//                                                       verify:git-objects. Loaded at start, so a restart re-walks nothing that
//                                                       completed within the recovery interval (F-RESTART-PASS)
//   include-older:<task>:<rootId>                       '1': an "Import older files" request for that task on that root, written
//                                                       by requestArtifactRefresh (output-walk; checkout-status + git-history)
//   pass-older:<rootId>, pass-older:git-history:<rootId>  '1' while the current pass runs with includeOlder: it consumed the
//                                                       request at its start; on completion the request key is cleared only
//                                                       when written before that start (a newer request survives)
//   legacy-backfill.cursor                              the last artifact_id the legacy backfill completed
//   worker.priority-facility, worker.priority-command   'applied' | 'unavailable' | 'wrapper-failed', and the wrapper label
//   health.worker-crashes, health.slices, health.entries-inspected, health.rows-committed, health.retries, health.failed,
//   health.rejected-frames, health.status-throttled, health.db-write-ms, health.slice-ms, health.last-pass-duration-ms,
//   health.backfill-rows, health.git-objects-checked,  integer counters (queue age is computed by getArtifactManagerStatus)
//   health.git-objects-slices
//   git-objects.resume                                  JSON {r, v, n} (n is 0): where the next Git object check pass starts,
//                                                       written when a pass stopped at its slice cap (GIT_OBJECT_MAX_SLICES_PER_PASS)
//   root-device:<rootId>                                the device an auto-registered root's own folder was last seen on (R73.2);
//                                                       deactivateRoot deletes it
//
// Besides worker jobs the runner itself runs two background tasks as jobs: the legacy backfill (`legacy-backfill`) and the
// Git object check (`verify` on scope `git-objects`, DEFECT-3): bounded `cat-file --batch-check` slices over stored commit and
// index versions that record what Git proved about each object (recordArtifactGitObjectChecks), resumable from the job cursor.
// Each slice is one repository (fix round 1, I4), pinned to its recorded common dir (I3).
//
// Where the state lives: the pause flag, the root coverage notes (R71: readArtifactCoverageNote / writeArtifactCoverageNote,
// shared with the status route and the removal checker) and the per-root device renumber evidence (`renumber:<rootId>`, R73,
// written by the verifier, direct checks and scans; deactivateRoot deletes it) have their own helpers in
// src/db/artifact-manager.ts. Every other key listed above belongs to this runner and is read and written only through the
// small helpers below (readArtifactManagerState, writeState, deleteState, bumpState); requestArtifactRefresh writes the
// include-older keys for the refresh route. Root deactivation is deactivateRoot below: the db module has no deactivation, and
// deactivating also drops the root's recovery-done keys (fix round 1) and its renumber evidence (fix round 2).

import { createHash } from 'node:crypto'
import diagnosticsChannel from 'node:diagnostics_channel'
import type { ChildProcess } from 'node:child_process'
import { closeSync, lstatSync, opendirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AtlasConfig, ArtifactOutputRootConfig } from '../config.ts'
import type { AtlasDb } from '../db/database.ts'
import { findArtifactByPath } from '../db/artifacts.ts'
import { probeRootFolder, recheckKnownLocation, type VerifyLstat, type VerifyReaddir } from '../artifacts/reconcile.ts'
import {
  ARTIFACT_JOB_PRIORITY, adoptArtifactRepositoryIdentity, advanceArtifactIdentityAdoption, artifactDirectScopeId, artifactRootRenumberKey, assertArtifactCatalogShape, claimArtifactJob, commitArtifactBatch, deleteArtifactCoverageNote, discardArtifactPlannerStatistics, dropArtifactIdentityAdoption, enqueueArtifactJob, failArtifactIdentityAdoption, finishArtifactJob, listArtifactGitObjects,
  listArtifactRoots, listRootIdentityLocations, nextArtifactIdentityAdoption, readArtifactCoverageNote, recordArtifactGitObjectChecks, registerArtifactRepository, registerArtifactRoot, requestArtifactIdentityAdoption, retryArtifactJob, writeArtifactCoverageNote,
  type ArtifactGitObjectCheck, type ArtifactGitObjectCursor, type ArtifactGitObjectRow,
  type ArtifactJobInput, type ArtifactJobRow, type ArtifactRootRow,
} from '../db/artifact-manager.ts'
import { ARTIFACT_DEFAULT_FRAME_ROWS, type ArtifactDocumentIdentity, type ArtifactTaskKind, type ArtifactWorkerFrame, type ArtifactWorkerObservation, type ArtifactWorkerRequest, type ArtifactWorkerRoot } from '../artifacts/contracts.ts'
import { adoptProvisionalLocations, backfillLegacyArtifacts, LEGACY_BACKFILL_MAX_BATCH } from '../artifacts/backfill.ts'
import {
  ARTIFACT_IPC_LIMITS, ARTIFACT_WORKER_GAP_CODES, artifactWorkerErrorKind, isTerminalArtifactFrame, validateArtifactWorkerFrame, validateArtifactWorkerRequest, type ArtifactWorkerErrorKind,
} from '../artifacts/discovery.ts'
import { classifyPath } from '../artifacts/filetype.ts'
import { listGitWorktrees, resolveGitCheckout, runArtifactGit, type GitCheckout, type GitLimits, type GitResult, type GitRunOptions } from '../artifacts/git.ts'
import { parseBatchCheck } from '../artifacts/git-parser.ts'
import { authorizeArtifactPath, canonicalizeArtifactRoot, documentIdentityForGitPath, documentIdentityForPath, hasPhiSegment, isPassiveDiscoveryExcluded, isPhiSegment } from '../artifacts/path-policy.ts'
import { recentSessionFolders } from '../artifacts/watcher.ts'
import { inferSessionActivity, markArtifactScopeDirty } from '../ingest/artifact-observations.ts'
import { projectNameFor } from '../util/project-name.ts'
import type { Logger } from '../util/log.ts'
import { createArtifactWorkerClient, type ArtifactWorkerClient } from './artifact-worker.ts'
import type { Runner } from './runners.ts'

// ------------------------------------------------------------------------------------------------------------ constants

/** Transient retry delays (spec s10); a sixth failure fails the job. */
export const ARTIFACT_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([2_000, 10_000, 30_000, 120_000, 300_000])
/** Pause between background slices (spec s10). */
export const ARTIFACT_BACKGROUND_PAUSE_MS = 1_000
/** R24: a later pass reaches back to this long before the previous pass started. */
const PASS_OVERLAP_MS = 60_000
/** The task kinds that scan a whole root (their scope is the root ID and they own its coverage). */
const SCAN_TASKS: ReadonlySet<ArtifactTaskKind> = new Set(['checkout-status', 'output-walk'])
const ROOT_TASKS: ReadonlySet<ArtifactTaskKind> = new Set(['checkout-status', 'output-walk', 'git-history'])
const SCAN_FLAGS: ReadonlySet<string> = new Set(['checkout', 'configured-output', 'cli-output', 'session-cwd'])
/** Immediate children auto-registered as output roots under each checkout and session cwd (spec s4), matched case-insensitively. */
const OUTPUT_CHILD_NAMES: ReadonlySet<string> = new Set(['docs', 'reports', 'exports', 'deliverables', 'phi', '.phi'])
const BACKFILL_SCOPE = 'legacy-backfill'
/**
 * DEFECT-3 (spec s8 "Verify object presence before offering View Git version"): the job scope of the bounded Git object check,
 * a `verify` task the service runs itself (like the legacy backfill), at verify priority, once per recovery interval. Each
 * slice reads at most GIT_OBJECT_BATCH due commit/index versions of ONE repository after its (repository, version) cursor and
 * runs one `cat-file --batch-check` per object format through the Task 4 adapter, in the background (fix round 1, I4).
 */
const GIT_OBJECT_SCOPE = 'git-objects'
/** artifact_manager_state key prefix of a recovery scope's last completed pass (F-RESTART-PASS). */
const RECOVERY_DONE_PREFIX = 'recovery-done:'
const GIT_OBJECT_BATCH = 256
/** I4: a version whose object Git proved present or missing is not checked again for this long. */
export const GIT_OBJECT_RECHECK_MS = 6 * 3_600_000
/**
 * I4: at most this many slices that check versions (each one repository, at most two Git processes) per pass; a pass that
 * reaches it ends and the next one resumes where it stopped (`git-objects.resume`), so the Git processes of one pass are
 * bounded without starving any repository. A window with nothing due (fix round 2) costs no Git and is not counted.
 */
export const GIT_OBJECT_MAX_SLICES_PER_PASS = 64
const GIT_OBJECT_RESUME_KEY = 'git-objects.resume'
/**
 * At most this many recovery-done (or job-failed) keys are read at start (one primary-key range): a few per root and
 * repository. A recovery scope past the bound counts as never completed (one extra pass, never a missed one); a job-failed key
 * past it is cleared at a later start.
 */
const MAX_RECOVERY_KEYS = 8_192
/**
 * R73.2: the scope flags of roots Atlas registered on its own and registers again when their folder returns (checkouts, session
 * folders, their output children). Such a root whose own folder is proven deleted is retired; a root the user declared
 * (cli-output, configured-output) stays active and disconnected, and so does a direct-only parent (R74.2: ingest never
 * reactivates an inactive parent, so retiring one would refuse every later file in that folder).
 */
const AUTO_ROOT_FLAGS: ReadonlySet<string> = new Set(['checkout', 'session-cwd'])
/** How often the auto-registered roots' own folders are checked (and their devices recorded). */
const ROOT_FOLDER_CHECK_MS = 30_000
/** artifact_manager_state key prefix of the device an auto-registered root's folder was last seen on (R73.2). */
const ROOT_DEVICE_PREFIX = 'root-device:'
const DEFAULT_FRAME_WAIT_MS = 200
const SESSION_CHECK_MS = 30_000
const SCHEDULE_EVERY_MS = 1_000
const MAX_DIRTY_PATHS = 64
const MAX_DEBOUNCE_MS = 10_000
const MAX_CLAIMS_PER_TICK = 8
const MAX_PLANNED_CHECKOUTS = 200
const WORKER_EXTENSION_RE = /^[a-z0-9]{1,16}$/
const DEFAULT_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'json', 'sql']
/** The key setArtifactDiscoveryPaused (Task 2) writes. */
const PAUSE_KEY = 'discovery.paused'
/** Claim-time refusals that describe the root's registration state, not a failure of the scope: never a job-failed key. */
const ROOT_STATE_REFUSALS: ReadonlySet<string> = new Set(['root-inactive', 'root-unknown', 'root-refused'])
/** This runner's own transient failure codes (retried with backoff; kept as job-failed across restarts once exhausted). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'worker-crash', 'worker-timeout', 'worker-protocol', 'worker-unavailable', 'worker-busy', 'frame-rejected', 'commit-failed', 'backfill-failed',
])
/** A job-failed code that only a configuration change can cure: cleared at every start (config is read at start). */
function deterministicFailure(code: string): boolean {
  return !TRANSIENT_CODES.has(code) && artifactWorkerErrorKind(code) === 'failed'
}

// ------------------------------------------------------------------------------------------------------------ state helpers

/** One artifact_manager_state value, or null. */
export function readArtifactManagerState(db: Pick<AtlasDb, 'raw'>, key: string): string | null {
  return (db.raw.prepare('SELECT value FROM artifact_manager_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

function writeState(db: AtlasDb, key: string, value: string, now: string): void {
  db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, now)
}

/**
 * The keys starting with `prefix` (which ends in ':'), as one primary-key range in key order, at most `limit` of them: never a
 * LIKE scan of the whole table (fix round 1).
 */
function stateRange(db: AtlasDb, prefix: string, limit: number): Array<{ key: string; value: string }> {
  return db.raw.prepare('SELECT key, value FROM artifact_manager_state WHERE key >= ? AND key < ? ORDER BY key LIMIT ?')
    .all(prefix, `${prefix.slice(0, -1)};`, limit) as Array<{ key: string; value: string }>
}

function deleteState(db: AtlasDb, key: string): void {
  db.raw.prepare('DELETE FROM artifact_manager_state WHERE key = ?').run(key)
}

function bumpState(db: AtlasDb, key: string, by: number, now: string): void {
  if (!Number.isFinite(by) || by === 0) return
  db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT), updated_at = excluded.updated_at`).run(key, String(Math.round(by)), now, String(Math.round(by)))
}

/** Whether discovery is paused (Task 2's flag). Pause blocks every claim, discovery and background verification. */
export function isArtifactDiscoveryPaused(db: Pick<AtlasDb, 'raw'>): boolean {
  return readArtifactManagerState(db, PAUSE_KEY) === '1'
}

/** Worker and health counters for status reporting (keys `worker.*` and `health.*`; no paths). */
export function readArtifactManagerHealth(db: Pick<AtlasDb, 'raw'>): Record<string, string> {
  const rows = db.raw.prepare(`SELECT key, value FROM artifact_manager_state WHERE key LIKE 'health.%' OR key LIKE 'worker.%' ORDER BY key`).all() as Array<{ key: string; value: string }>
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

const passStartKey = (rootId: string, task: ArtifactTaskKind) => (task === 'git-history' ? `pass-start:git-history:${rootId}` : `pass-start:${rootId}`)
const passSinceKey = (rootId: string, task: ArtifactTaskKind) => (task === 'git-history' ? `pass-since:git-history:${rootId}` : `pass-since:${rootId}`)
const historyCursorKey = (rootId: string) => `history-cursor:${rootId}`
const jobFailedKey = (task: ArtifactTaskKind, rootId: string) => `job-failed:${task}:${rootId}`
const includeOlderKey = (task: ArtifactTaskKind, rootId: string) => `include-older:${task}:${rootId}`
const passOlderKey = (rootId: string, task: ArtifactTaskKind) => (task === 'git-history' ? `pass-older:git-history:${rootId}` : `pass-older:${rootId}`)

function stateWrittenAt(db: Pick<AtlasDb, 'raw'>, key: string): string | null {
  return (db.raw.prepare('SELECT updated_at FROM artifact_manager_state WHERE key = ?').get(key) as { updated_at: string } | undefined)?.updated_at ?? null
}

/**
 * Marks a root inactive (refused or no longer declared). Its catalogued history stays; its recovery schedule goes (fix round 1),
 * so a root declared again is scanned as a new one and no key outlives the root it schedules.
 */
function deactivateRoot(db: AtlasDb, rootId: string): boolean {
  const changed = Number(db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ? AND active = 1').run(rootId).changes) > 0
  if (changed) {
    dropArtifactIdentityAdoption(db, rootId)
    for (const task of SCAN_TASKS) deleteState(db, `${RECOVERY_DONE_PREFIX}${task}:${rootId}`)
    // R73: its renumber evidence and recorded folder device are about a volume this root no longer watches.
    deleteState(db, artifactRootRenumberKey(rootId))
    deleteState(db, `${ROOT_DEVICE_PREFIX}${rootId}`)
  }
  return changed
}

// ------------------------------------------------------------------------------------------------------------ small helpers

const iso = (ms: number) => new Date(ms).toISOString()
/** One turn of the event loop (a macrotask): pending I/O callbacks, such as HTTP requests, and due timers run first. */
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)
const strictlyWithin = (path: string, dir: string) => path.length > dir.length + 1 && path.startsWith(`${dir}/`)
/** Locations read per page (one transaction, one turn of the event loop) when a newly registered checkout adopts the documents catalogued below it. */
const ADOPTION_PAGE = 250
/** Consecutive failed pages after which a checkout's adoption is dropped (its documents keep root identity until it is registered again). */
const ADOPTION_MAX_FAILURES = 3
const scannable = (r: Pick<ArtifactRootRow, 'scopeFlags'>) => r.scopeFlags.some(f => SCAN_FLAGS.has(f))
const errName = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code
  const name = e instanceof Error ? e.name : typeof e
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? `${name} ${code}` : name
}
const workerRoot = (r: ArtifactRootRow): ArtifactWorkerRoot => ({
  rootId: r.rootId, kind: r.kind, canonicalPath: r.canonicalPath, repositoryId: r.repositoryId, checkoutIdentity: r.checkoutIdentity, protected: r.protected, scopeFlags: r.scopeFlags,
})
const deepestFirst = (a: ArtifactRootRow, b: ArtifactRootRow): number =>
  b.canonicalPath.length - a.canonicalPath.length || (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0)

function sameIdentity(a: ArtifactDocumentIdentity, b: ArtifactDocumentIdentity): boolean {
  return a.identityKind === b.identityKind && a.repositoryId === b.repositoryId && a.rootId === b.rootId && a.relativePath === b.relativePath
}

/** True only when lstat proves the folder is not there (ENOENT/ENOTDIR); any other answer keeps it. */
function folderGone(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

function realOr(path: string): string {
  try { return realpathSync.native(path) } catch { return path.replace(/\/+$/, '') || '/' }
}

/**
 * Directories no root may equal, contain or lie inside (Task 3 adjudication C): the Atlas data directory, its spool and the
 * cost-ledger directory, by real path and as spelled (they move with ATLAS_HOME and HOME).
 */
export function artifactRefusedDirectories(config: Pick<AtlasConfig, 'atlasDir' | 'spoolDir' | 'ledgerPath'>): string[] {
  const dirs = [config.atlasDir, config.spoolDir, dirname(config.ledgerPath)].flatMap(d => [d.replace(/\/+$/, ''), realOr(d)])
  return [...new Set(dirs.filter(d => d.length > 1))]
}

export function isArtifactRootRefused(path: string, refused: readonly string[]): boolean {
  return refused.some(d => within(path, d) || within(d, path))
}

/**
 * Per-call memo for artifactHistoryRootFor (R47, PERF-GAP-2): each repository's history root is resolved once per status or
 * list call, and the roots holding a history cursor are read with one indexed range query instead of one read per checkout.
 */
export type ArtifactHistoryRootMemo = { byRepository: Map<string, ArtifactRootRow | null>; cursorRoots: Set<string> | null }
const newArtifactHistoryRootMemo = (): ArtifactHistoryRootMemo => ({ byRepository: new Map(), cursorRoots: null })

/** The state keys starting with `prefix` (an indexed range on the primary key; `prefix` ends with ':', so ';' bounds it). */
function stateKeysWithPrefix(db: Pick<AtlasDb, 'raw'>, prefix: string): string[] {
  return (db.raw.prepare('SELECT key FROM artifact_manager_state WHERE key >= ? AND key < ?').all(prefix, `${prefix.slice(0, -1)};`) as Array<{ key: string }>).map(r => r.key)
}

/**
 * The checkout whose Git history pass the runner keeps for `repositoryId` (the history cursor is bound to that root): among
 * the repository's active, scannable, unrefused checkouts with a checkout identity, the one already holding a history
 * cursor, else the first by path. The scheduler and the refresh route both use this, so they agree on the scope.
 */
export function artifactHistoryRootFor(db: Pick<AtlasDb, 'raw'>, roots: readonly ArtifactRootRow[], repositoryId: string, refused: readonly string[] = [], memo?: ArtifactHistoryRootMemo): ArtifactRootRow | null {
  const known = memo?.byRepository.get(repositoryId)
  if (known !== undefined) return known
  const checkouts = roots.filter(r => r.active && r.kind === 'checkout' && r.repositoryId === repositoryId && r.checkoutIdentity !== null
    && r.scopeFlags.some(f => SCAN_FLAGS.has(f)) && !isArtifactRootRefused(r.canonicalPath, refused))
    .sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0))
  let hasCursor: (rootId: string) => boolean = rootId => readArtifactManagerState(db, `history-cursor:${rootId}`) !== null
  if (memo) {
    memo.cursorRoots ??= new Set(stateKeysWithPrefix(db, 'history-cursor:').map(k => k.slice('history-cursor:'.length)))
    const cursorRoots = memo.cursorRoots
    hasCursor = rootId => cursorRoots.has(rootId)
  }
  const found = checkouts.find(r => hasCursor(r.rootId)) ?? checkouts[0] ?? null
  memo?.byRepository.set(repositoryId, found)
  return found
}

/** The scan scopes a refresh of `root` queues, as the runner schedules them: none for a direct-only root. */
export function artifactRefreshScopes(db: Pick<AtlasDb, 'raw'>, root: ArtifactRootRow, roots: readonly ArtifactRootRow[], refused: readonly string[] = [], memo?: ArtifactHistoryRootMemo): Array<{ task: ArtifactTaskKind; rootId: string }> {
  if (!root.scopeFlags.some(f => SCAN_FLAGS.has(f))) return []
  if (root.kind !== 'checkout') return [{ task: 'output-walk', rootId: root.rootId }]
  if (root.repositoryId === null || root.checkoutIdentity === null) return []
  const history = artifactHistoryRootFor(db, roots, root.repositoryId, refused, memo)
  return [{ task: 'checkout-status', rootId: root.rootId }, ...(history ? [{ task: 'git-history' as const, rootId: history.rootId }] : [])]
}

export class ArtifactRefreshRefusedError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`artifact refresh refused: ${code}`)
    this.name = 'ArtifactRefreshRefusedError'
    this.code = code
  }
}

/**
 * THE way to ask the runner for a refresh of a registered root, optionally with "Import older files". In one transaction it
 * enqueues the root's scan scopes exactly as the runner schedules them (output-walk for an output or session-directory root;
 * checkout-status for a checkout plus git-history on its repository's history root; dirty priority) and, with includeOlder,
 * writes one `include-older:<task>:<rootId>` key per scope. Each key is consumed by the first pass of THAT task that starts
 * after it was written and cleared only when that pass completes, so one task finishing first never cancels another's
 * request, and a request made during a pass survives for the next one. Repeated requests coalesce (one job per scope).
 * Throws ArtifactRefreshRefusedError (root-not-found, root-inactive, root-refused, direct-only-root, root-not-scannable) and
 * queues nothing; callers map the code.
 */
export function requestArtifactRefresh(db: AtlasDb, rootId: string, opts: { includeOlder: boolean; now: string; refused?: readonly string[] }): {
  jobId: string; historyJobId: string | null; scopes: Array<{ task: ArtifactTaskKind; rootId: string; jobId: string }>
} {
  const refusedDirs = opts.refused ?? []
  const roots = listArtifactRoots(db)
  const root = roots.find(r => r.rootId === rootId)
  if (!root) throw new ArtifactRefreshRefusedError('root-not-found')
  if (!root.active) throw new ArtifactRefreshRefusedError('root-inactive')
  if (isArtifactRootRefused(root.canonicalPath, refusedDirs)) throw new ArtifactRefreshRefusedError('root-refused')
  if (!root.scopeFlags.some(f => SCAN_FLAGS.has(f))) throw new ArtifactRefreshRefusedError('direct-only-root')
  const scopes = artifactRefreshScopes(db, root, roots, refusedDirs)
  if (scopes.length === 0) throw new ArtifactRefreshRefusedError('root-not-scannable')
  return db.transaction(() => {
    const queued = scopes.map(scope => {
      if (opts.includeOlder) writeState(db, includeOlderKey(scope.task, scope.rootId), '1', opts.now)
      const jobId = enqueueArtifactJob(db, { scopeId: scope.rootId, taskKind: scope.task, priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 0 }, opts.now)
      return { ...scope, jobId }
    })
    return { jobId: queued[0]!.jobId, historyJobId: queued.find(q => q.task === 'git-history')?.jobId ?? null, scopes: queued }
  })
}

/** Whether an "Import older files" request for `rootId` is still waiting for (or running in) any of its applicable passes. */
export function includeOlderPending(db: AtlasDb, rootId: string, opts: { roots?: readonly ArtifactRootRow[]; refused?: readonly string[] } = {}): boolean {
  const roots = opts.roots ?? listArtifactRoots(db)
  const root = roots.find(r => r.rootId === rootId)
  if (!root) return false
  return includeOlderPendingRoots(db, [root], opts.refused ?? [], roots).has(rootId)
}

/**
 * The IDs of `roots` whose "Import older files" request is still pending, for a whole status or list call at once (R47,
 * PERF-GAP-2): with no request anywhere this is one indexed read; otherwise each repository's history root is resolved once,
 * so the cost grows linearly with the number of roots. `context` is the full root list the history root is chosen from
 * (default: `roots`).
 */
export function includeOlderPendingRoots(db: Pick<AtlasDb, 'raw'>, roots: readonly ArtifactRootRow[], refused: readonly string[] = [], context: readonly ArtifactRootRow[] = roots): Set<string> {
  const pending = new Set<string>()
  const requests = new Set(stateKeysWithPrefix(db, 'include-older:'))
  if (requests.size === 0) return pending
  const memo = newArtifactHistoryRootMemo()
  for (const root of roots) {
    if (artifactRefreshScopes(db, root, context, refused, memo).some(s => requests.has(includeOlderKey(s.task, s.rootId)))) pending.add(root.rootId)
  }
  return pending
}

function directScope(scopeId: string): { rootId: string; path: string } | null {
  if (!scopeId.startsWith('direct:')) return null
  const rest = scopeId.slice('direct:'.length)
  const i = rest.indexOf(':')
  if (i <= 0) return null
  const rootId = rest.slice(0, i)
  const path = rest.slice(i + 1)
  if (!path.startsWith('/') || artifactDirectScopeId(rootId, path) !== scopeId) return null
  return { rootId, path }
}

/** A checkout's identity: its common and per-checkout Git directories plus that directory's inode and birth, so a checkout
 *  re-created at the same path gets a new identity when the filesystem can tell (spec s3). */
export function artifactCheckoutIdentity(checkout: Pick<GitCheckout, 'commonDir' | 'gitDir'>): string {
  let fingerprint: string[] = []
  try {
    const st = statSync(checkout.gitDir, { bigint: true })
    fingerprint = [String(st.dev), String(st.ino), String(st.birthtimeNs)]
  } catch { /* identity from the paths alone */ }
  return `ck-${createHash('sha256').update(JSON.stringify([checkout.commonDir, checkout.gitDir, ...fingerprint])).digest('hex').slice(0, 32)}`
}

// ------------------------------------------------------------------------------------------------------------ root planning

type ScopeFlag = ArtifactRootRow['scopeFlags'][number]
type PlannedCheckout = { worktreePath: string; commonDir: string; gitDir: string; displayName: string; remoteIdentity: string | null; checkoutIdentity: string; projectName: string | null }
type PlannedRoot = { path: string; kind: 'output' | 'session-directory'; flags: ScopeFlag[]; protected: boolean; projectName: string | null; checkoutPath: string | null; configRepositoryId: string | null }
type RootPlan = {
  checkouts: PlannedCheckout[]
  roots: PlannedRoot[]
  /** Canonical paths currently declared in config outputRoots. */
  configPaths: Set<string>
  /** Repositories whose worktree list was read: common dir -> listed worktree paths. */
  listed: Map<string, Set<string>>
  activeCheckouts: string[]
  activeSessionDirs: string[]
}
type GitResolver = { resolveCheckout(path: string): Promise<GitCheckout | null>; listWorktrees(path: string): Promise<GitCheckout[]> }

/** The immediate child directories (not symlinks) whose name is one of the output names, with their exact spelling. */
function outputChildren(dir: string): Array<{ path: string; phi: boolean; nestedGit: boolean }> {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out: Array<{ path: string; phi: boolean; nestedGit: boolean }> = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const lower = e.name.toLowerCase()
    if (!OUTPUT_CHILD_NAMES.has(lower)) continue
    const path = join(dir, e.name)
    let nestedGit = false
    try { lstatSync(join(path, '.git')); nestedGit = true } catch { /* not a nested checkout */ }
    out.push({ path, phi: isPhiSegment(e.name), nestedGit })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * Plans root registrations from existing metadata only (never a walk of home): recent session cwds, configured output roots,
 * the worktrees Git lists for each repository found there, every checkout directly under a checkout's .claude/worktrees, and
 * the docs/reports/exports/deliverables/phi/.phi children of each checkout and non-Git session cwd. Git runs through the Task 4
 * adapter (async child processes, bounded by its own limits). Touches no database.
 */
async function planRoots(input: {
  sessionCwds: string[]; outputRoots: ArtifactOutputRootConfig[]; home: string; refused: readonly string[]; git: GitResolver; log: Logger
  /** True once the runner stopped: no further Git call is made and the partial plan is returned (and never applied). */
  aborted: () => boolean
}): Promise<RootPlan> {
  const { home, refused, log, aborted } = input
  const git = input.git
  const plan: RootPlan = { checkouts: [], roots: [], configPaths: new Set(), listed: new Map(), activeCheckouts: [], activeSessionDirs: [] }
  const checkouts = new Map<string, PlannedCheckout>()
  const roots = new Map<string, PlannedRoot>()
  const usable = (path: string): string | null => {
    const c = canonicalizeArtifactRoot(path, home)
    if ('error' in c || !c.exists || isArtifactRootRefused(c.canonicalPath, refused)) return null
    return c.canonicalPath
  }
  const resolve = async (path: string): Promise<GitCheckout | null> => {
    if (aborted()) return null
    try { return await git.resolveCheckout(path) } catch (e) { if (!aborted()) log.warn('artifact root resolution failed', { error: errName(e) }); return null }
  }
  const addCheckout = (c: GitCheckout): PlannedCheckout | null => {
    if (checkouts.has(c.worktreePath)) return checkouts.get(c.worktreePath)!
    if (checkouts.size >= MAX_PLANNED_CHECKOUTS || c.prunable) return null
    if (usable(c.worktreePath) !== c.worktreePath) return null
    const origin = c.remotes.find(r => r.name === 'origin') ?? c.remotes[0]
    const remote = origin?.url && origin.url.length <= 512 && !/[\u0000-\u001f\u007f]/.test(origin.url) ? origin.url : null
    const projectName = projectNameFor(c.worktreePath)
    const p: PlannedCheckout = {
      worktreePath: c.worktreePath, commonDir: c.commonDir, gitDir: c.gitDir, displayName: (projectName ?? c.worktreePath.slice(c.worktreePath.lastIndexOf('/') + 1)).slice(0, 200) || 'repository',
      remoteIdentity: remote, checkoutIdentity: artifactCheckoutIdentity(c), projectName,
    }
    checkouts.set(c.worktreePath, p)
    return p
  }
  const addRoot = (r: PlannedRoot): void => {
    const existing = roots.get(r.path)
    if (existing) {
      existing.flags = [...new Set([...existing.flags, ...r.flags])]
      existing.protected = existing.protected || r.protected
      existing.checkoutPath ??= r.checkoutPath
      existing.configRepositoryId ??= r.configRepositoryId
      return
    }
    roots.set(r.path, r)
  }
  const listRepository = async (checkout: GitCheckout): Promise<void> => {
    if (plan.listed.has(checkout.commonDir) || aborted()) return
    let list: GitCheckout[]
    try {
      list = await git.listWorktrees(checkout.worktreePath)
    } catch (e) {
      if (aborted()) return
      // Without a complete listing nothing may be concluded about the other worktrees (none is deactivated).
      log.warn('artifact worktree listing failed', { error: errName(e) })
      addCheckout(checkout)
      return
    }
    plan.listed.set(checkout.commonDir, new Set(list.filter(w => !w.prunable).map(w => w.worktreePath)))
    for (const w of list) addCheckout(w)
  }

  // A session cwd below its checkout's top (a monorepo package): its own output children and nested worktrees count too.
  const cwdsInCheckouts: Array<{ cwd: string; top: string }> = []
  // Session cwds: the checkout around each (and its repository's worktrees), else the cwd itself.
  for (const cwd of input.sessionCwds) {
    if (aborted()) return plan
    const path = usable(cwd)
    if (!path) continue
    const checkout = await resolve(path)
    if (aborted()) return plan
    if (checkout && usable(checkout.worktreePath) === checkout.worktreePath) {
      await listRepository(checkout)
      addCheckout(checkout)
      plan.activeCheckouts.push(checkout.worktreePath)
      if (path !== checkout.worktreePath && path.startsWith(`${checkout.worktreePath}/`)) cwdsInCheckouts.push({ cwd: path, top: checkout.worktreePath })
    } else {
      addRoot({ path, kind: 'session-directory', flags: ['session-cwd'], protected: hasPhiSegment(path), projectName: projectNameFor(path), checkoutPath: null, configRepositoryId: null })
      plan.activeSessionDirs.push(path)
    }
  }
  // Configured output roots: inside a checkout they carry its identity (R27), so the checkout is registered too.
  for (const [index, cfg] of input.outputRoots.entries()) {
    if (aborted()) return plan
    const c = canonicalizeArtifactRoot(cfg.path, home)
    if ('error' in c) { log.warn('configured artifact output root refused', { index, reason: c.error }); continue }
    if (!c.exists) { log.warn('configured artifact output root does not exist', { index }); continue }
    if (isArtifactRootRefused(c.canonicalPath, refused)) { log.warn('configured artifact output root refused: Atlas data, spool or cost-ledger directory', { index }); continue }
    plan.configPaths.add(c.canonicalPath)
    const checkout = await resolve(c.canonicalPath)
    const planned = checkout ? addCheckout(checkout) : null
    addRoot({
      path: c.canonicalPath, kind: 'output', flags: ['configured-output'], protected: cfg.protected || hasPhiSegment(c.canonicalPath),
      projectName: cfg.label ?? projectNameFor(c.canonicalPath), checkoutPath: planned?.worktreePath ?? null, configRepositoryId: cfg.repositoryId,
    })
  }
  // Every checkout (and every session cwd inside one): nested .claude/worktrees checkouts, each its own root (or the subtree
  // stays a gap), and output children.
  const queue = [...checkouts.values()]
  const nestedUnder = async (base: string): Promise<void> => {
    let nested: string[] = []
    try {
      nested = readdirSync(join(base, '.claude', 'worktrees'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(base, '.claude', 'worktrees', e.name))
    } catch { /* none */ }
    for (const dir of nested.sort()) {
      if (checkouts.has(dir) || aborted()) continue
      const found = await resolve(dir)
      if (!found || found.worktreePath !== dir) continue
      const added = addCheckout(found)
      if (added) queue.push(added)
    }
  }
  for (const { cwd, top } of cwdsInCheckouts) {
    if (aborted()) return plan
    await nestedUnder(cwd)
    for (const child of outputChildren(cwd)) {
      if (usable(child.path) !== child.path) continue
      addRoot({
        path: child.path, kind: 'output', flags: ['session-cwd'], protected: child.phi || hasPhiSegment(child.path), projectName: checkouts.get(top)?.projectName ?? null,
        // R27: inside the session's checkout, so it carries that checkout's repository and identity (unless a nested repo).
        checkoutPath: child.nestedGit ? null : top, configRepositoryId: null,
      })
    }
  }
  for (let i = 0; i < queue.length; i++) {
    if (aborted()) return plan
    const co = queue[i]!
    await nestedUnder(co.worktreePath)
    for (const child of outputChildren(co.worktreePath)) {
      if (usable(child.path) !== child.path) continue
      addRoot({
        path: child.path, kind: 'output', flags: ['checkout'], protected: child.phi || hasPhiSegment(child.path), projectName: co.projectName,
        // A child that is itself a nested repository is not part of this checkout: it keeps root identity.
        checkoutPath: child.nestedGit ? null : co.worktreePath, configRepositoryId: null,
      })
    }
  }
  for (const dir of plan.activeSessionDirs) {
    for (const child of outputChildren(dir)) {
      if (usable(child.path) !== child.path) continue
      addRoot({ path: child.path, kind: 'output', flags: ['session-cwd'], protected: child.phi || hasPhiSegment(child.path), projectName: projectNameFor(dir), checkoutPath: null, configRepositoryId: null })
    }
  }
  plan.checkouts = [...checkouts.values()]
  plan.roots = [...roots.values()]
  return plan
}

// ------------------------------------------------------------------------------------------------------------ runner

export type ArtifactManagerRunnerDeps = {
  db: AtlasDb
  config: AtlasConfig
  log: Logger
  /** Default: one lazily started worker process at background priority. */
  worker?: ArtifactWorkerClient
  /** Home for path authorization (default config.homeDir). */
  home?: string
  /** Milliseconds clock (default Date.now). */
  clock?: () => number
  /** false: no root reconciliation, recovery or backfill scheduling; jobs come only from enqueues (tests). Default true. */
  autoSchedule?: boolean
  /** How long one tick waits for the in-flight job's next frame (default 200 ms). */
  frameWaitMs?: number
  /** Pause after a background slice (default 1000 ms). */
  backgroundPauseMs?: number
  /** Root registration (injectable to observe the order). */
  registerRoot?: typeof registerArtifactRoot
  /** Git for root resolution (default: the Task 4 adapter). */
  git?: GitResolver
  /** Sessions active within this window make their checkouts active (default 6 h). */
  activeSessionMs?: number
  /** At most this many recent session folders are reconciled (default 40, as the watcher). */
  maxSessionFolders?: number
  /** Versions per Git object check slice (default 256; tests use fewer). */
  gitObjectBatch?: number
  /** A proven Git object is re-checked after this long (default GIT_OBJECT_RECHECK_MS; tests use 0). */
  gitObjectRecheckMs?: number
  /** Slices per Git object check pass (default GIT_OBJECT_MAX_SLICES_PER_PASS). */
  gitObjectMaxSlices?: number
  /** Filesystem reads of the root-level proof (R73.2; default lstat and readdir; a test seam). */
  rootFs?: { lstat?: VerifyLstat; readdir?: VerifyReaddir }
  /** The Git adapter the object check runs `cat-file --batch-check` through (default runArtifactGit; a test seam). */
  runGit?: (repoPath: string, args: string[], limits: GitLimits, options?: GitRunOptions) => Promise<GitResult>
}

export type ArtifactManagerRunner = Runner & {
  /** A watcher hint: `path` changed under `folder`, or (null) the whole folder must be rechecked. In-memory only. */
  markDirty(folder: string, path: string | null): void
  /** Resolves once a background root reconciliation and a Git object check slice (if any) have finished. */
  settle(): Promise<void>
}

type Inflight = {
  job: ArtifactJobRow
  root: ArtifactRootRow
  task: ArtifactTaskKind
  request: ArtifactWorkerRequest
  directPath: string | null
  /** The root's baseline when the job was claimed (R29: never read after the commit). */
  baseline: { appliedGeneration: number; completedAt: string | null }
  sliceStartMs: number
  background: boolean
}

type Dirty = { whole: boolean; paths: Set<string>; firstAt: number; lastAt: number }

/** A Git object check slice running in the background: what it proved, and where the pass continues. */
type GitObjectSlice = {
  job: ArtifactJobRow; promise: Promise<void>; done: boolean; checks: ArtifactGitObjectCheck[]; cursor: string | null; complete: boolean; error: string | null
  /** Versions this slice checks (0: a window with nothing due, not counted as a slice: R74.7). */
  size: number
  /** On completion: the pass stopped at its slice cap here (the next pass resumes from it), or null (it reached the end). */
  resume: ArtifactGitObjectCursor | null
}

/** The object check's job cursor: the last (repository, version) done and how many checking slices this pass has taken. */
type GitObjectPassCursor = { after: ArtifactGitObjectCursor | null; slices: number }

function parseGitObjectCursor(raw: string | null): GitObjectPassCursor | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as { r?: unknown; v?: unknown; n?: unknown }
    if (typeof v.r === 'string' && typeof v.v === 'string' && Number.isSafeInteger(v.n) && (v.n as number) >= 0) {
      return { after: { repositoryId: v.r, versionId: v.v }, slices: v.n as number }
    }
  } catch { /* an unreadable cursor restarts the pass */ }
  return null
}

const gitObjectCursorJson = (after: ArtifactGitObjectCursor, slices: number): string => JSON.stringify({ r: after.repositoryId, v: after.versionId, n: slices })

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** OOS1: bounds of the object-store readability check (directories through alternates; pack indexes per directory). */
const MAX_OBJECT_DIRECTORIES = 16
const MAX_PACK_INDEXES = 4096

/**
 * Whether this process can read the object store Git answered from (OOS1): the common dir's `objects/` folder, every
 * alternate listed in `objects/info/alternates` (followed to the same depth as Git, relative to the listing objects folder)
 * and every `pack/*.idx` and `pack/*.pack` in each (one byte of each pack, R74.4). Git answers "missing" (exit 0) for an object it cannot read (an unreadable pack index makes
 * every packed object "missing" with nothing on stderr), so "missing" is proof only when this holds. Anything unexpected
 * (an unreadable listing, a quoted alternate, past the bounds) is false.
 */
function readableFile(path: string, readByte: boolean): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    return !readByte || readSync(fd, Buffer.alloc(1), 0, 1, 0) >= 0
  } catch {
    return false
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* already closed */ }
  }
}

function objectStoreReadable(commonDir: string): boolean {
  const readableDir = (dir: string): boolean => {
    try { opendirSync(dir).closeSync(); return true } catch { return false }
  }
  const absent = (e: unknown): boolean => { const code = (e as { code?: unknown } | null)?.code; return code === 'ENOENT' || code === 'ENOTDIR' }
  const dirs: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: join(commonDir, 'objects'), depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    if (dirs.includes(dir)) continue
    if (dirs.length >= MAX_OBJECT_DIRECTORIES || !readableDir(dir)) return false
    dirs.push(dir)
    let listing = ''
    try { listing = readFileSync(join(dir, 'info', 'alternates'), 'utf8') } catch (e) { if (!absent(e)) return false }
    for (const line of listing.split('\n')) {
      if (line === '' || line.startsWith('#')) continue
      if (line.startsWith('"') || depth >= 5) return false
      queue.push({ dir: isAbsolute(line) ? line : resolve(dir, line), depth: depth + 1 })
    }
  }
  for (const dir of dirs) {
    let names: string[]
    try { names = readdirSync(join(dir, 'pack')) } catch (e) { if (absent(e)) continue; return false }
    const files = names.filter(n => n.endsWith('.idx') || n.endsWith('.pack'))
    if (files.length > 2 * MAX_PACK_INDEXES) return false
    for (const n of files) {
      // R74.4: a pack Git cannot read also makes its objects "missing" (with nothing on stderr): read one byte of each pack.
      if (!readableFile(join(dir, 'pack', n), n.endsWith('.pack'))) return false
    }
  }
  return true
}

/**
 * The Git object check of one repository's versions (exported for the permission tests, which run it without permission
 * override): one `cat-file --batch-check` per object format, fed the stored blob OIDs and pinned to the recorded common dir
 * (I3), so no repository Git could discover elsewhere ever answers. Only Git's own answer for an OID, at that OID's own
 * position, counts (S3): present (a blob of the stored size, else a mismatch) is proof; "missing" is proof only when Git wrote
 * nothing to stderr and the object store was readable (OOS1), else it proves nothing. An unanswered OID or a failed run
 * changes nothing.
 */
export async function checkArtifactGitObjectBatch(
  repoPath: string, commonDir: string, rows: readonly ArtifactGitObjectRow[], limits: GitLimits,
  opts: { runGit?: (repoPath: string, args: string[], limits: GitLimits, options?: GitRunOptions) => Promise<GitResult>; stopped?: () => boolean } = {},
): Promise<ArtifactGitObjectCheck[]> {
  const runGit = opts.runGit ?? runArtifactGit
  const checks: ArtifactGitObjectCheck[] = []
  const groups = new Map<string, ArtifactGitObjectRow[]>()
  for (const r of rows) groups.set(r.objectFormat, [...(groups.get(r.objectFormat) ?? []), r])
  for (const group of groups.values()) {
    if (opts.stopped?.()) break
    const oids = [...new Set(group.map(r => r.blobOid))]
    const result = await runGit(repoPath, ['cat-file', '--batch-check'], limits, { input: Buffer.from(oids.map(o => `${o}\n`).join('')), gitDir: commonDir })
    const records = parseBatchCheck(result.stdout, group[0]!.objectFormat).records
    const answers = new Map(oids.flatMap((oid, i) => (records[i]?.name === oid ? [[oid, records[i]!] as const] : [])))
    let missingProven: boolean | null = null
    for (const r of group) {
      const a = answers.get(r.blobOid)
      if (a?.state === 'present') checks.push({ versionId: r.versionId, object: a.type === 'blob' && a.size === r.sizeBytes ? 'present' : 'mismatch' })
      else if (a?.state === 'missing' && (missingProven ??= result.stderr.length === 0 && objectStoreReadable(commonDir))) checks.push({ versionId: r.versionId, object: 'missing' })
    }
  }
  return checks
}

export function artifactManagerRunner(deps: ArtifactManagerRunnerDeps): ArtifactManagerRunner {
  const { db, config, log } = deps
  // Fix round 1 (I2): a catalog migrated by a pre-release build of migration 9 stops the service start here, with what is wrong
  // and what to do, before the runner or its worker writes to the catalog (the service builds the runner before it listens, after
  // it has set worker jobs left running back to pending).
  assertArtifactCatalogShape(db)
  const cfg = config.artifacts
  const home = deps.home ?? config.homeDir
  const homeLiteral = home.replace(/\/+$/, '')
  const homeRealPath = (() => { try { return realpathSync.native(homeLiteral) } catch { return null } })()
  const clock = deps.clock ?? Date.now
  const autoSchedule = deps.autoSchedule ?? true
  const frameWaitMs = deps.frameWaitMs ?? DEFAULT_FRAME_WAIT_MS
  const backgroundPauseMs = deps.backgroundPauseMs ?? ARTIFACT_BACKGROUND_PAUSE_MS
  const registerRoot = deps.registerRoot ?? registerArtifactRoot
  const git: GitResolver = deps.git ?? { resolveCheckout: resolveGitCheckout, listWorktrees: listGitWorktrees }
  const activeSessionMs = deps.activeSessionMs ?? 6 * 3_600_000
  const maxSessionFolders = deps.maxSessionFolders ?? 40
  const gitObjectBatch = Math.max(1, Math.trunc(deps.gitObjectBatch ?? GIT_OBJECT_BATCH))
  const gitObjectRecheckMs = Math.max(0, deps.gitObjectRecheckMs ?? GIT_OBJECT_RECHECK_MS)
  const gitObjectMaxSlices = Math.max(1, Math.trunc(deps.gitObjectMaxSlices ?? GIT_OBJECT_MAX_SLICES_PER_PASS))
  // PERF-GAP-3 (ruling R65): rows per catalog commit on the service loop: the frame size asked of the worker and the legacy
  // backfill's batch. The frozen frame maximum (250 rows) stays the bound.
  const maxFrameRows = Math.min(ARTIFACT_IPC_LIMITS.maxRows, Math.max(1, Math.trunc(cfg.maxRowsPerFrame ?? ARTIFACT_DEFAULT_FRAME_ROWS)))
  const backfillBatchRows = Math.min(LEGACY_BACKFILL_MAX_BATCH, maxFrameRows)
  // Fix round 1 (I1): the proofs of one Git object check slice (up to gitObjectBatch versions, one Git process) are committed at
  // most this many per transaction, like a worker frame, so one commit stays in the same tens-of-milliseconds class.
  const gitObjectCommitRows = maxFrameRows
  const runGit = deps.runGit ?? runArtifactGit
  const worker = deps.worker ?? createArtifactWorkerClient({ log, home })
  const refused = artifactRefusedDirectories(config)
  const lookbackMs = cfg.initialLookbackDays * 86_400_000
  const workerExtensions = (() => {
    const kept = cfg.documentExtensions.filter(e => WORKER_EXTENSION_RE.test(e)).slice(0, 64)
    if (kept.length < cfg.documentExtensions.length) log.warn('artifacts config warning', { warning: 'artifacts.documentExtensions: entries with "-" or "_" are not scanned by the discovery worker' })
    return kept.length > 0 ? kept : DEFAULT_EXTENSIONS
  })()
  const extensionSet = new Set(workerExtensions)
  const workerIgnore = cfg.ignoreSegments.filter(s => s.length > 0 && s.length <= 255 && !s.includes('/') && !s.includes('\0')).slice(0, 256)

  let started = false
  let stopped = false
  let inflight: Inflight | null = null
  let pauseUntil = Number.NEGATIVE_INFINITY
  // Legacy-backfill rows committed since the last background pause (a slice is up to LEGACY_BACKFILL_MAX_BATCH rows).
  let backfillSliceRows = 0
  let reconcile: { promise: Promise<void>; plan: RootPlan | null; done: boolean } | null = null
  let gitObjects: GitObjectSlice | null = null
  let lastReconcileAt = Number.NEGATIVE_INFINITY
  let lastSessionCheck = Number.NEGATIVE_INFINITY
  let sessionKey: string | null = null
  let lastScheduleAt = Number.NEGATIVE_INFINITY
  let lastRootFolderCheck = Number.NEGATIVE_INFINITY
  let activeCheckouts = new Set<string>()
  let activeSessionDirs = new Set<string>()
  let facility = ''
  // Per recovery scope: the later of its last enqueue and its last completed pass (ms). Completions are persisted under
  // recovery-done:<key> and loaded at start; enqueue times only debounce scheduling within one process.
  const lastRecovery = new Map<string, number>()
  const historyMidPass = new Set<string>()
  const throttledClaims = new Map<string, number>()
  const dirty = new Map<string, Dirty>()

  // Git children the service itself starts (root resolution through the Task 4 adapter, which spawns `git --no-pager ...`
  // detached): tracked so stop() can kill their process groups.
  const serviceGit = new Set<number>()
  const killGroup = (pid: number): void => {
    if (pid <= 1) return
    try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  const killServiceGit = (): void => {
    for (const pid of serviceGit) killGroup(pid)
    serviceGit.clear()
  }
  const onChild = (message: unknown): void => {
    const child = (message as { process?: ChildProcess }).process
    if (!child) return
    queueMicrotask(() => {
      if (child.spawnfile !== 'git' || child.spawnargs[1] !== '--no-pager' || typeof child.pid !== 'number') return
      const pid = child.pid
      // After stop(), a Git process can still start inside an adapter call that was already under way: kill it at once.
      if (stopped) { killGroup(pid); return }
      serviceGit.add(pid)
      child.once('exit', () => serviceGit.delete(pid))
    })
  }
  diagnosticsChannel.subscribe('child_process', onChild)

  const nowIso = () => iso(clock())
  const safely = (what: string, fn: () => void): void => {
    try { fn() } catch (err) { log.warn(`artifact manager: ${what} failed`, { error: errName(err) }) }
  }

  // F-STATS: planner statistics on the catalog are discarded when the runner is built, which the service does before it
  // listens: no list request is planned with statistics taken while document links were still empty (104 s for one request).
  safely('discarding planner statistics', () => {
    const removed = discardArtifactPlannerStatistics(db)
    if (removed > 0) log.warn('discarded planner statistics on the artifact catalog (Atlas never keeps them)', { rows: removed })
  })

  // ---------------------------------------------------------------------------------------------- startup and status

  function recordFacility(): void {
    const s = worker.status()
    const key = `${s.priorityFacility}|${s.priorityCommand}`
    if (key === facility) return
    facility = key
    safely('recording the priority facility', () => db.transaction(() => {
      writeState(db, 'worker.priority-facility', s.priorityFacility, nowIso())
      writeState(db, 'worker.priority-command', s.priorityCommand, nowIso())
    }))
    if (s.priorityFacility !== 'applied') {
      log.warn('artifact worker runs without a background priority facility; the production performance gate cannot be claimed', { facility: s.priorityFacility })
    }
  }

  function deactivateRefused(): void {
    for (const r of listArtifactRoots(db)) {
      if (r.active && isArtifactRootRefused(r.canonicalPath, refused) && deactivateRoot(db, r.rootId)) {
        log.warn('artifact root deactivated: it is, contains or lies inside the Atlas data, spool or cost-ledger directory', { rootId: r.rootId })
      }
    }
  }

  /** Deterministic failures await a configuration change, and configuration is read at start: clear them now. */
  function clearDeterministicFailures(): void {
    for (const r of stateRange(db, 'job-failed:', MAX_RECOVERY_KEYS)) if (deterministicFailure(r.value)) deleteState(db, r.key)
  }

  function startup(): void {
    started = true
    for (const warning of cfg.warnings) log.warn('artifacts config warning', { warning })
    safely('refusing Atlas data roots', deactivateRefused)
    safely('clearing deterministic failures', clearDeterministicFailures)
    safely('loading the recovery schedule', loadRecoverySchedule)
    recordFacility()
  }

  // ---------------------------------------------------------------------------------------------- watcher hints

  function markDirty(folder: string, path: string | null): void {
    const t = clock()
    const d = dirty.get(folder) ?? { whole: false, paths: new Set<string>(), firstAt: t, lastAt: t }
    if (path === null || d.paths.size >= MAX_DIRTY_PATHS) d.whole = true
    else d.paths.add(path)
    d.lastAt = t
    dirty.set(folder, d)
  }

  /** The root a direct check runs under: the deepest scannable checkout containing it (repository identity), else the root
   *  the path policy chose. Mirrors Task 6 so watcher hints and hook observations land on the same job. */
  function directRootFor(canonical: string, authRootId: string, roots: ArtifactRootRow[]): ArtifactRootRow | null {
    const checkout = roots.filter(r => r.kind === 'checkout' && r.repositoryId !== null && scannable(r) && strictlyWithin(canonical, r.canonicalPath)).sort(deepestFirst)[0]
    if (checkout && authorizeArtifactPath(canonical, [workerRoot(checkout)], home).allowed) return checkout
    return roots.find(r => r.rootId === authRootId) ?? null
  }

  function flushDirty(nowMs: number): boolean {
    let did = false
    for (const [folder, d] of [...dirty]) {
      if (nowMs - d.lastAt < cfg.debounceMs && nowMs - d.firstAt < MAX_DEBOUNCE_MS) continue
      dirty.delete(folder)
      did = true
      safely('applying a watcher hint', () => {
        const now = iso(nowMs)
        if (d.whole) {
          markArtifactScopeDirty(db, folder, ARTIFACT_JOB_PRIORITY.dirty, { now, home, log })
          return
        }
        const roots = listArtifactRoots(db).filter(r => r.active && !isArtifactRootRefused(r.canonicalPath, refused))
        const wr = roots.map(workerRoot)
        const jobs: ArtifactJobInput[] = []
        for (const path of d.paths) {
          if (!extensionSet.has(classifyPath(path).extension)) continue
          const auth = authorizeArtifactPath(path, wr, home)
          if (!auth.allowed || auth.canonicalPath === null || auth.rootId === null) continue
          const root = directRootFor(auth.canonicalPath, auth.rootId, roots)
          if (!root || isPassiveDiscoveryExcluded(auth.canonicalPath, cfg, workerRoot(root))) continue
          jobs.push({ scopeId: artifactDirectScopeId(root.rootId, auth.canonicalPath), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 0 })
        }
        if (jobs.length > 0) db.transaction(() => { for (const j of jobs) enqueueArtifactJob(db, j, now) })
      })
    }
    return did
  }

  // ---------------------------------------------------------------------------------------------- roots

  function sessionCwds(nowMs: number): string[] {
    const seen = new Set<string>()
    for (const s of recentSessionFolders(db, iso(nowMs - activeSessionMs))) {
      const cwd = s.cwd.replace(/\/+$/, '')
      if (cwd && !seen.has(cwd)) seen.add(cwd)
      if (seen.size >= maxSessionFolders) break
    }
    return [...seen]
  }

  /** 'full' at start and every recovery interval (fresh Git answers); 'sessions' when the set of active session cwds changed. */
  function reconcileDue(nowMs: number): 'full' | 'sessions' | null {
    if (lastReconcileAt === Number.NEGATIVE_INFINITY || nowMs - lastReconcileAt >= cfg.recoveryIntervalMs) return 'full'
    if (nowMs - lastSessionCheck < SESSION_CHECK_MS) return null
    lastSessionCheck = nowMs
    return sessionCwds(nowMs).join('\n') !== sessionKey ? 'sessions' : null
  }

  // Git answers for root resolution, reused until the next periodic full refresh: a change in the set of active sessions
  // then resolves only the cwds it has not seen recently (each resolution is several Git processes).
  const resolved = new Map<string, { at: number; value: Promise<GitCheckout | null> }>()
  const listedCache = new Map<string, { at: number; value: Promise<GitCheckout[]> }>()
  function cachedGit(nowMs: number, fresh: boolean): GitResolver {
    const pick = <T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>): Promise<T> => {
      if (stopped) return Promise.reject(new Error('artifact manager stopped'))
      const hit = cache.get(key)
      if (!fresh && hit && nowMs - hit.at < cfg.recoveryIntervalMs) return hit.value
      const value = load()
      cache.set(key, { at: nowMs, value })
      // A failure is never cached.
      value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key) })
      if (cache.size > 1_000) cache.delete(cache.keys().next().value!)
      return value
    }
    return {
      resolveCheckout: path => pick(resolved, path, () => git.resolveCheckout(path)),
      listWorktrees: path => pick(listedCache, path, () => git.listWorktrees(path)),
    }
  }

  function startReconcile(nowMs: number, fresh: boolean): void {
    lastReconcileAt = fresh ? nowMs : lastReconcileAt
    lastSessionCheck = nowMs
    const cwds = sessionCwds(nowMs)
    sessionKey = cwds.join('\n')
    const state: { promise: Promise<void>; plan: RootPlan | null; done: boolean } = { promise: Promise.resolve(), plan: null, done: false }
    state.promise = planRoots({ sessionCwds: cwds, outputRoots: cfg.outputRoots, home, refused, git: cachedGit(nowMs, fresh), log, aborted: () => stopped }).then(
      plan => { state.plan = plan; state.done = true },
      err => { log.warn('artifact root reconciliation failed', { error: errName(err) }); state.done = true },
    )
    reconcile = state
  }

  /**
   * The root-identity documents catalogued below a checkout that was just registered (or reactivated) take the repository
   * identity of their path under it: the one the worker would derive for a live file there (R27, `expectedIdentity`). A path a
   * deeper registered checkout contains is that checkout's to claim, and one the path policy does not authorize under this
   * checkout keeps its root identity. Bounded pages inside the caller's transaction.
   */
  function adoptRepositoryIdentities(rootId: string, afterPath: string | null): void {
    const checkout = listArtifactRoots(db).find(r => r.rootId === rootId)
    // A root that is no longer an active checkout with a repository has nothing to adopt: its cursor goes.
    if (!checkout || !checkout.active || checkout.kind !== 'checkout' || checkout.repositoryId === null) { dropArtifactIdentityAdoption(db, rootId); return }
    const wr = workerRoot(checkout)
    const deeper = listArtifactRoots(db).filter(r => r.active && r.kind === 'checkout' && r.repositoryId !== null && strictlyWithin(r.canonicalPath, checkout.canonicalPath))
    const page = listRootIdentityLocations(db, checkout.canonicalPath, afterPath, ADOPTION_PAGE)
    const entries: Array<{ path: string; rootId: string; identity: ArtifactDocumentIdentity }> = []
    for (const l of page) {
      if (deeper.some(r => strictlyWithin(l.path, r.canonicalPath))) continue
      const auth = authorizeArtifactPath(l.path, [wr], home)
      if (!auth.allowed || auth.canonicalPath !== l.path) continue
      const identity = documentIdentityForPath(l.path, wr, { repositoryId: checkout.repositoryId, gitPath: l.path.slice(checkout.canonicalPath.length + 1) })
      if ('incomplete' in identity) continue
      entries.push({ path: l.path, rootId: checkout.rootId, identity })
    }
    const now = nowIso()
    adoptArtifactRepositoryIdentity(db, entries, now)
    advanceArtifactIdentityAdoption(db, rootId, page.length < ADOPTION_PAGE ? null : page[page.length - 1]!.path, now)
  }

  /**
   * R93: ONE page of the oldest pending adoption, in its own transaction. The caller yields to the event loop afterwards (PERF-GAP-3)
   * and reports the turn busy while a cursor is left. A failing page leaves its cursor for the next turn and reports no work, so a
   * persistent failure cannot spin the scheduler.
   */
  function hasPendingAdoption(): boolean {
    try { return nextArtifactIdentityAdoption(db) !== null } catch { return false }
  }

  function adoptionStep(): boolean {
    let pending
    try { pending = nextArtifactIdentityAdoption(db) } catch (err) { log.warn('artifact manager: reading the adoption queue failed', { error: errName(err) }); return false }
    if (!pending) return false
    try {
      db.transaction(() => adoptRepositoryIdentities(pending.rootId, pending.afterPath))
    } catch (err) {
      // R96: the page rolled back and its cursor is where it was. A separate small write moves the row behind the others and counts
      // the failure; the third one in a row drops it, so one poison page cannot hold up every other checkout.
      log.warn('artifact manager: adopting repository identities failed', { rootId: pending.rootId, error: errName(err) })
      try {
        const f = db.transaction(() => failArtifactIdentityAdoption(db, pending.rootId, nowIso(), ADOPTION_MAX_FAILURES))
        if (f.dropped) log.warn('artifact manager: repository identity adoption abandoned after repeated failures; its documents keep root identity until the root is registered again', { rootId: pending.rootId, failures: f.failures })
      } catch (err2) { log.warn('artifact manager: recording an adoption failure failed', { rootId: pending.rootId, error: errName(err2) }) }
    }
    return true
  }

  function applyPlan(plan: RootPlan): void {
    const now = nowIso()
    db.transaction(() => {
      // A root this plan registers anew or reactivates starts with a clean slate: its earlier failures await exactly this, and
      // its first recovery is due at once (nothing watched it while it was inactive).
      const before = new Map(listArtifactRoots(db).map(r => [r.canonicalPath, r.active]))
      const register = (input: Parameters<typeof registerArtifactRoot>[1]): ArtifactRootRow => {
        const row = registerRoot(db, input, now)
        if (before.get(input.canonicalPath) !== true) {
          clearFailures(row.rootId)
          clearRecovery(row.rootId)
        }
        return row
      }
      // Checkouts first, so every nested output/session root can carry the identity of the checkout it lies in (R27).
      const registered = new Map<string, ArtifactRootRow>()
      const listedRepos = new Map<string, Set<string>>()
      for (const c of plan.checkouts) {
        if (isArtifactRootRefused(c.worktreePath, refused)) continue
        const repositoryId = registerArtifactRepository(db, { commonDir: c.commonDir, displayName: c.displayName, remoteIdentity: c.remoteIdentity }, now)
        const row = register({
          kind: 'checkout', canonicalPath: c.worktreePath, repositoryId, projectName: c.projectName, checkoutIdentity: c.checkoutIdentity,
          protected: hasPhiSegment(c.worktreePath), scopeFlags: ['checkout'],
        })
        registered.set(c.worktreePath, row)
        const listed = plan.listed.get(c.commonDir)
        if (listed) listedRepos.set(repositoryId, listed)
      }
      for (const r of plan.roots) {
        if (isArtifactRootRefused(r.path, refused)) continue
        const co = r.checkoutPath ? registered.get(r.checkoutPath) : undefined
        const input = {
          kind: r.kind, canonicalPath: r.path, projectName: r.projectName, protected: r.protected, scopeFlags: r.flags,
          // R27: inside a registered checkout, that checkout's repository AND identity; an external root never gets a
          // checkout identity (a configured repositoryId is project metadata only).
          repositoryId: co?.repositoryId ?? r.configRepositoryId, checkoutIdentity: co?.checkoutIdentity ?? null,
        }
        try {
          register(input)
        } catch (err) {
          if (input.repositoryId === null || co) throw err
          // An unknown configured repository ID: register without it rather than drop the root.
          log.warn('configured artifact output root names an unknown repository; registered without it', { error: errName(err) })
          register({ ...input, repositoryId: null })
        }
      }
      // PR #19 review, P2-2: a document a hook created before this checkout was registered has a root identity. The registration
      // verifies the checkout's repository, and with it the repository path of everything catalogued below it: those documents
      // take the repository identity now, whether or not a scan ever emits a row for them (a clean tracked file never does).
      // R93: the promotion itself is background work, a page per service turn (adoptionStep); registration only records the cursor
      // (restarting a pending one from the beginning), so this transaction stays as small as the registration.
      for (const row of registered.values()) if (before.get(row.canonicalPath) !== true) requestArtifactIdentityAdoption(db, row.rootId, now)
      const goneWorktrees: string[] = []
      for (const row of listArtifactRoots(db)) {
        if (!row.active) continue
        const configOnly = row.scopeFlags.length === 1 && row.scopeFlags[0] === 'configured-output'
        const goneWorktree = row.kind === 'checkout' && row.repositoryId !== null && listedRepos.has(row.repositoryId) && !listedRepos.get(row.repositoryId)!.has(row.canonicalPath)
        if (goneWorktree) goneWorktrees.push(row.canonicalPath)
        if (isArtifactRootRefused(row.canonicalPath, refused) || (configOnly && !plan.configPaths.has(row.canonicalPath)) || goneWorktree) deactivateRoot(db, row.rootId)
      }
      // I1: the roots registered inside a worktree Git no longer lists (its docs/ and other output children) go with it once
      // their own folder is gone: nothing there can be scanned, and an active root that is not its folder would keep failing
      // its scans and leave its files unverified forever. A root whose folder still exists keeps its own registration.
      if (goneWorktrees.length > 0) {
        for (const row of listArtifactRoots(db)) {
          if (row.active && goneWorktrees.some(w => strictlyWithin(row.canonicalPath, w)) && folderGone(row.canonicalPath)) deactivateRoot(db, row.rootId)
        }
      }
    })
    activeCheckouts = new Set(plan.activeCheckouts)
    activeSessionDirs = new Set(plan.activeSessionDirs)
  }

  // ---------------------------------------------------------------------------------------------- recovery scheduling

  /**
   * R73.2: every active auto-registered root's own folder, by the root-level proof. Present: its device is recorded (the first
   * time, or anew when the folder is not empty: an empty folder may be a mount point left behind by an unmounted volume).
   * Proven deleted: the root is retired (deactivateRoot), so the verifier's retired-root path proves its files missing and
   * nothing schedules it again; a later reconciliation that finds the folder again registers it anew. Filesystem reads first,
   * then one short transaction.
   */
  function checkRootFolders(nowMs: number): void {
    lastRootFolderCheck = nowMs
    const devices = new Map(stateRange(db, ROOT_DEVICE_PREFIX, MAX_RECOVERY_KEYS).map(r => [r.key.slice(ROOT_DEVICE_PREFIX.length), r.value]))
    const roots = listArtifactRoots(db).filter(r => r.active && r.scopeFlags.length > 0 && r.scopeFlags.every(f => AUTO_ROOT_FLAGS.has(f))
      && !isArtifactRootRefused(r.canonicalPath, refused))
    const probes = roots.map(r => ({ r, recorded: devices.get(r.rootId) ?? null, probe: probeRootFolder(r.canonicalPath, devices.get(r.rootId) ?? null, deps.rootFs) }))
    const now = iso(nowMs)
    const retired: string[] = []
    db.transaction(() => {
      for (const { r, recorded, probe } of probes) {
        if (probe.state === 'present' && probe.device !== recorded && (recorded === null || !probe.empty)) writeState(db, `${ROOT_DEVICE_PREFIX}${r.rootId}`, probe.device, now)
        else if (probe.state === 'gone' && deactivateRoot(db, r.rootId)) retired.push(r.rootId)
      }
    })
    for (const rootId of retired) log.info('artifact root retired: its folder was deleted', { rootId })
  }

  /** Whether (scope, task) has a job queued, waiting for a retry or running: a pass that is still under way. */
  function jobPending(scopeId: string, task: ArtifactTaskKind): boolean {
    return db.raw.prepare(`SELECT 1 AS hit FROM artifact_jobs WHERE scope_id = ? AND task_kind = ? AND state IN ('queued', 'retry', 'running')`).get(scopeId, task) !== undefined
  }

  /** The recovery scope a completed pass of `task` on `root` satisfies (the keys scheduleRecovery uses), or null. */
  function recoveryKeyFor(task: ArtifactTaskKind, root: Pick<ArtifactRootRow, 'rootId' | 'repositoryId'>): string | null {
    if (SCAN_TASKS.has(task)) return `${task}:${root.rootId}`
    if (task === 'git-history' && root.repositoryId !== null) return `git-history-repository:${root.repositoryId}`
    return null
  }

  /** Persists that a recovery scope's pass completed at `now`, in the caller's transaction (applied in memory by noteRecovery). */
  function persistRecovery(key: string, now: string): void {
    writeState(db, `${RECOVERY_DONE_PREFIX}${key}`, now, now)
  }
  function noteRecovery(key: string, atMs: number): void {
    lastRecovery.set(key, Math.max(lastRecovery.get(key) ?? Number.NEGATIVE_INFINITY, atMs))
  }

  /**
   * At start: the persisted completion times, read as one bounded primary-key range (a time ahead of this clock counts as now,
   * so a clock step back cannot stall recovery). A root-scoped key whose root is not active (deactivated by an older build,
   * or gone) is deleted instead.
   */
  function loadRecoverySchedule(): void {
    const nowMs = clock()
    const rows = stateRange(db, RECOVERY_DONE_PREFIX, MAX_RECOVERY_KEYS)
    const active = new Set(listArtifactRoots(db).filter(r => r.active).map(r => r.rootId))
    const stale: string[] = []
    for (const r of rows) {
      const scope = r.key.slice(RECOVERY_DONE_PREFIX.length)
      const colon = scope.indexOf(':')
      if (colon > 0 && SCAN_TASKS.has(scope.slice(0, colon) as ArtifactTaskKind) && !active.has(scope.slice(colon + 1))) { stale.push(r.key); continue }
      const at = Date.parse(r.value)
      if (Number.isFinite(at)) noteRecovery(scope, Math.min(at, nowMs))
    }
    if (stale.length > 0) db.transaction(() => { for (const key of stale) deleteState(db, key) })
  }

  function scheduleRecovery(nowMs: number): void {
    if (nowMs - lastScheduleAt < SCHEDULE_EVERY_MS) return
    lastScheduleAt = nowMs
    const now = iso(nowMs)
    const roots = listArtifactRoots(db).filter(r => r.active && scannable(r) && !isArtifactRootRefused(r.canonicalPath, refused))
    const jobs: Array<{ key: string; input: ArtifactJobInput }> = []
    const due = (key: string) => nowMs - (lastRecovery.get(key) ?? Number.NEGATIVE_INFINITY) >= cfg.recoveryIntervalMs
    const want = (task: ArtifactTaskKind, r: ArtifactRootRow, priority: number) => {
      const key = `${task}:${r.rootId}`
      if (!due(key) || readArtifactManagerState(db, jobFailedKey(task, r.rootId)) !== null) return
      // A pass already queued, running or parked mid-pass is not re-enqueued: that would force an extra pass of a large root.
      // The job row says so across a restart too (F-RESTART-PASS); the in-memory checks only answer sooner.
      if (SCAN_TASKS.has(task) && (r.cursor !== null || r.coverageState === 'queued' || r.coverageState === 'scanning')) return
      if (task === 'git-history' && historyMidPass.has(r.rootId)) return
      if (jobPending(r.rootId, task)) return
      jobs.push({ key, input: { scopeId: r.rootId, taskKind: task, priority, generation: 0 } })
    }
    const byRepository = new Map<string, ArtifactRootRow[]>()
    for (const r of roots) {
      if (r.kind === 'checkout') {
        if (r.repositoryId === null || r.checkoutIdentity === null) continue
        const active = activeCheckouts.has(r.canonicalPath)
        // Active checkouts get status scans; an inactive (linked) worktree gets one initial bounded discovery.
        if (active || (r.appliedGeneration === 0 && r.lastSuccessfulAt === null)) want('checkout-status', r, ARTIFACT_JOB_PRIORITY.recovery)
        byRepository.set(r.repositoryId, [...(byRepository.get(r.repositoryId) ?? []), r])
      } else if (r.kind === 'output' || activeSessionDirs.has(r.canonicalPath)) {
        want('output-walk', r, ARTIFACT_JOB_PRIORITY.recovery)
      }
    }
    // Git history once per repository, on one stable checkout (the history cursor is bound to that root): every recovery
    // interval while a checkout of it is active, else until a first pass has stored its cursor.
    for (const [repositoryId, list] of byRepository) {
      const repoKey = `git-history-repository:${repositoryId}`
      if (!due(repoKey)) continue
      const anyActive = list.some(r => activeCheckouts.has(r.canonicalPath))
      const historyRoot = artifactHistoryRootFor(db, roots, repositoryId, refused)
      if (!historyRoot) continue
      if (!anyActive && readArtifactManagerState(db, historyCursorKey(historyRoot.rootId)) !== null) continue
      const before = jobs.length
      want('git-history', historyRoot, ARTIFACT_JOB_PRIORITY.recovery)
      if (jobs.length > before) jobs[jobs.length - 1]!.key = repoKey
    }
    if (due(`legacy-backfill:${BACKFILL_SCOPE}`)) {
      jobs.push({ key: `legacy-backfill:${BACKFILL_SCOPE}`, input: { scopeId: BACKFILL_SCOPE, taskKind: 'legacy-backfill', priority: ARTIFACT_JOB_PRIORITY.backfill, generation: 0 } })
    }
    // DEFECT-3: the Git object check, once per interval; a pass still under way (queued, running or parked) is not bumped.
    if (due(`verify:${GIT_OBJECT_SCOPE}`) && !jobPending(GIT_OBJECT_SCOPE, 'verify')) {
      jobs.push({ key: `verify:${GIT_OBJECT_SCOPE}`, input: { scopeId: GIT_OBJECT_SCOPE, taskKind: 'verify', priority: ARTIFACT_JOB_PRIORITY.verify, generation: 0 } })
    }
    if (jobs.length === 0) return
    safely('scheduling recovery', () => db.transaction(() => {
      for (const j of jobs) { enqueueArtifactJob(db, j.input, now); lastRecovery.set(j.key, nowMs) }
    }))
  }

  // ---------------------------------------------------------------------------------------------- job outcomes

  function clearFailures(rootId: string): void {
    for (const task of ROOT_TASKS) deleteState(db, jobFailedKey(task, rootId))
  }

  /** Forgets when a root's scan scopes last recovered, so the first recovery of a (re)activated root is due at once. */
  function clearRecovery(rootId: string): void {
    for (const task of SCAN_TASKS) {
      lastRecovery.delete(`${task}:${rootId}`)
      deleteState(db, `${RECOVERY_DONE_PREFIX}${task}:${rootId}`)
    }
  }

  function markFailed(task: ArtifactTaskKind, rootId: string | null, code: string, now: string): void {
    bumpState(db, 'health.failed', 1, now)
    if (rootId !== null && ROOT_TASKS.has(task)) writeState(db, jobFailedKey(task, rootId), code.slice(0, 64), now)
  }

  function refuse(job: ArtifactJobRow, code: string, rootId: string | null): void {
    const now = nowIso()
    log.warn('artifact job refused', { task: job.taskKind, reason: code })
    safely('refusing a job', () => db.transaction(() => {
      finishArtifactJob(db, job.jobId, { complete: false, coverage: 'partial', error: code }, now)
      // An inactive, unknown or refused root is already out of scheduling; a job-failed key would outlive its reactivation.
      markFailed(job.taskKind, ROOT_STATE_REFUSALS.has(code) ? null : rootId, code, now)
    }))
  }

  /** Transient failure: retry after the next backoff step, or fail once the steps are used up. Inside a transaction. */
  function retryOrFail(job: ArtifactJobRow, rootId: string | null, code: string, coverage: 'partial' | 'inaccessible', now: string): void {
    const attempt = Math.max(1, job.attempts - (throttledClaims.get(job.jobId) ?? 0))
    const delay = ARTIFACT_RETRY_BACKOFF_MS[attempt - 1]
    if (delay !== undefined) {
      retryArtifactJob(db, job.jobId, code, iso(Date.parse(now) + delay), now)
      bumpState(db, 'health.retries', 1, now)
    } else {
      finishArtifactJob(db, job.jobId, { complete: false, coverage, error: code }, now)
      markFailed(job.taskKind, rootId, code, now)
      throttledClaims.delete(job.jobId)
    }
  }

  function transient(f: Inflight, code: string): void {
    const now = nowIso()
    safely('scheduling a retry', () => db.transaction(() => retryOrFail(f.job, ROOT_TASKS.has(f.task) ? f.root.rootId : null, code, 'partial', now)))
    if (f.background) pauseUntil = clock() + backgroundPauseMs
  }

  // ---------------------------------------------------------------------------------------------- claiming

  /**
   * One legacy-backfill batch of at most maxRowsPerFrame rows (PERF-GAP-3: one short transaction on the service loop, like a
   * worker frame), with its cursor and the job's outcome in that same transaction. A background slice is still up to
   * LEGACY_BACKFILL_MAX_BATCH (250) rows: the 1 s background pause follows the batch that completes a slice (or the pass, or a
   * failure), and the job is simply claimed again in between, one batch per tick, so other work and API requests interleave.
   */
  function runBackfill(job: ArtifactJobRow): void {
    const now = nowIso()
    const key = `legacy-backfill:${BACKFILL_SCOPE}`
    const limit = Math.min(LEGACY_BACKFILL_MAX_BATCH - backfillSliceRows, backfillBatchRows)
    let sliceEnd = true
    try {
      const r = db.transaction(() => {
        const start = job.cursor ?? readArtifactManagerState(db, 'legacy-backfill.cursor')
        const r = backfillLegacyArtifacts(db, start, limit, now, homeRealPath !== null && homeRealPath !== homeLiteral ? { literal: homeLiteral, real: homeRealPath } : undefined)
        commitArtifactBatch(db, job.jobId, job.desiredGeneration, [], { cursor: r.done ? null : r.cursor, coverage: 'complete', complete: r.done }, now)
        if (r.done) writeState(db, 'legacy-backfill.cursor', r.cursor, now)
        finishArtifactJob(db, job.jobId, { complete: r.done, coverage: 'complete' }, now)
        bumpState(db, 'health.backfill-rows', r.scanned, now)
        if (r.done) persistRecovery(key, now)
        return r
      })
      if (r.done) noteRecovery(key, Date.parse(now))
      backfillSliceRows += r.scanned
      sliceEnd = r.done || r.scanned === 0 || backfillSliceRows >= LEGACY_BACKFILL_MAX_BATCH
    } catch (err) {
      log.warn('legacy artifact backfill batch failed; it will retry', { error: errName(err) })
      safely('scheduling a backfill retry', () => db.transaction(() => retryOrFail(job, null, 'backfill-failed', 'partial', now)))
    }
    if (sliceEnd) {
      backfillSliceRows = 0
      pauseUntil = clock() + backgroundPauseMs
    }
  }

  // ---------------------------------------------------------------------------------------------- Git object check (DEFECT-3)

  /** A registered, existing checkout of the repository to run Git in (objects are shared by all its worktrees), or null. */
  function gitObjectRepository(repositoryId: string, roots: readonly ArtifactRootRow[]): string | null {
    const checkouts = roots.filter(r => r.kind === 'checkout' && r.repositoryId === repositoryId)
      .sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0))
    for (const r of checkouts) {
      const c = canonicalizeArtifactRoot(r.canonicalPath, home)
      if (!('error' in c) && c.exists && c.canonicalPath === r.canonicalPath) return r.canonicalPath
    }
    return null
  }

  /**
   * The versions of one repository (a slice), checked by checkArtifactGitObjectBatch. A repository with no reachable checkout
   * records every version `unreadable` (I5: unverified, no longer advertised as available) without running Git; a recorded
   * common dir that is gone runs no Git and changes nothing (I3).
   */
  async function checkGitObjects(rows: ArtifactGitObjectRow[], roots: readonly ArtifactRootRow[]): Promise<ArtifactGitObjectCheck[]> {
    if (rows.length === 0) return []
    const repoPath = gitObjectRepository(rows[0]!.repositoryId, roots)
    if (repoPath === null) return rows.map(r => ({ versionId: r.versionId, object: 'unreadable' as const }))
    const commonDir = rows[0]!.commonDir
    if (!isDirectory(commonDir)) return []
    return checkArtifactGitObjectBatch(repoPath, commonDir, rows, { timeoutMs: cfg.gitTimeoutMs, maxOutputBytes: cfg.gitMaxOutputBytes }, { runGit, stopped: () => stopped })
  }

  /**
   * Starts one bounded slice of the Git object check pass in the background: the due versions of the next repository after the
   * job's (repository, version) cursor, at most gitObjectBatch of them, found in at most GIT_OBJECT_SCAN_ROWS index rows (I4;
   * a window with nothing due is an empty slice that only moves the cursor). The pass completes at the end of the work list,
   * or at its slice cap, when the next pass resumes where this one stopped.
   */
  function startGitObjectCheck(job: ArtifactJobRow): void {
    const now = clock()
    const pass = parseGitObjectCursor(job.cursor) ?? { after: parseGitObjectCursor(readArtifactManagerState(db, GIT_OBJECT_RESUME_KEY))?.after ?? null, slices: 0 }
    const page = listArtifactGitObjects(db, pass.after, gitObjectBatch, new Date(now - gitObjectRecheckMs).toISOString())
    const rows = page.rows
    const take = rows.findIndex(r => r.repositoryId !== rows[0]!.repositoryId)
    const slice = take < 0 ? rows : rows.slice(0, take)
    const last = slice.at(-1)
    // The next slice resumes after this repository's last due version when another repository's due versions follow in this
    // page, else after everything the page read (versions that are not due included: a bounded window, fix round 2).
    const atEnd = take < 0 && page.end
    const after = take >= 0 ? { repositoryId: last!.repositoryId, versionId: last!.versionId } : page.last
    const slices = pass.slices + (slice.length > 0 ? 1 : 0)
    const capped = !atEnd && slices >= gitObjectMaxSlices
    const complete = atEnd || capped
    const roots = listArtifactRoots(db).filter(r => r.active && !isArtifactRootRefused(r.canonicalPath, refused))
    const state: GitObjectSlice = {
      job, promise: Promise.resolve(), done: false, checks: [], cursor: complete ? null : gitObjectCursorJson(after!, slices), complete, error: null, size: slice.length,
      resume: capped ? after : null,
    }
    state.promise = checkGitObjects(slice, roots).then(
      checks => { state.checks = checks; state.done = true },
      err => { state.error = errName(err); state.done = true },
    )
    gitObjects = state
  }

  /**
   * Commits a finished slice: the availability it proved, its checkpoint and the job's outcome. The proofs go in parts of at most
   * gitObjectCommitRows, one part per call with a turn of the event loop between calls (run() yields after each), and the last
   * part carries the checkpoint and the job's outcome in its transaction: a stop or a failure between parts leaves the cursor
   * where it was, so those versions are only checked again (each proof is idempotent).
   */
  function finishGitObjectCheck(s: GitObjectSlice): void {
    const now = nowIso()
    if (s.error === null && s.checks.length > gitObjectCommitRows) {
      const part = s.checks.splice(0, gitObjectCommitRows)
      try {
        db.transaction(() => {
          recordArtifactGitObjectChecks(db, part, now)
          bumpState(db, 'health.git-objects-checked', part.length, now)
        })
      } catch (err) {
        log.warn('recording Git object checks failed', { error: errName(err) })
        s.error = 'record-failed'
      }
      return
    }
    gitObjects = null
    if (s.error !== null) {
      log.warn('artifact Git object check failed; it will retry', { error: s.error })
      safely('scheduling a Git object check retry', () => db.transaction(() => retryOrFail(s.job, null, 'git-objects-failed', 'partial', now)))
    } else {
      const key = `verify:${GIT_OBJECT_SCOPE}`
      safely('recording Git object checks', () => {
        db.transaction(() => {
          if (s.checks.length > 0) recordArtifactGitObjectChecks(db, s.checks, now)
          commitArtifactBatch(db, s.job.jobId, s.job.desiredGeneration, [], { cursor: s.cursor, coverage: 'complete', complete: s.complete }, now)
          finishArtifactJob(db, s.job.jobId, { complete: s.complete, coverage: 'complete' }, now)
          bumpState(db, 'health.git-objects-checked', s.checks.length, now)
          if (s.size > 0) bumpState(db, 'health.git-objects-slices', 1, now)
          if (s.complete) {
            if (s.resume) writeState(db, GIT_OBJECT_RESUME_KEY, gitObjectCursorJson(s.resume, 0), now)
            else deleteState(db, GIT_OBJECT_RESUME_KEY)
            persistRecovery(key, now)
          }
        })
        if (s.complete) noteRecovery(key, Date.parse(now))
      })
    }
    pauseUntil = clock() + backgroundPauseMs
  }

  /** Builds and starts one claimed job. Returns true when a worker request is in flight. */
  function begin(job: ArtifactJobRow, nowMs: number): boolean {
    const task = job.taskKind
    if (task === 'legacy-backfill') { runBackfill(job); return false }
    if (task === 'verify') {
      if (job.scopeId === GIT_OBJECT_SCOPE) startGitObjectCheck(job)
      else refuse(job, 'unsupported-task', null)
      return false
    }
    const roots = listArtifactRoots(db)
    let rootId: string
    let directPath: string | null = null
    if (task === 'direct-observation') {
      const scope = directScope(job.scopeId)
      if (!scope) { refuse(job, 'invalid-scope', null); return false }
      rootId = scope.rootId
      directPath = scope.path
    } else if (ROOT_TASKS.has(task)) {
      rootId = job.scopeId
    } else {
      refuse(job, 'unsupported-task', null)
      return false
    }
    const root = roots.find(r => r.rootId === rootId)
    const scopeRoot = ROOT_TASKS.has(task) ? rootId : null
    if (!root) { refuse(job, 'root-unknown', scopeRoot); return false }
    if (isArtifactRootRefused(root.canonicalPath, refused) || (directPath !== null && isArtifactRootRefused(directPath, refused))) {
      safely('deactivating a refused root', () => { if (isArtifactRootRefused(root.canonicalPath, refused)) deactivateRoot(db, root.rootId) })
      refuse(job, 'root-refused', scopeRoot)
      return false
    }
    if (!root.active) { refuse(job, 'root-inactive', scopeRoot); return false }
    if (task !== 'direct-observation' && !scannable(root)) { refuse(job, 'direct-only-root', scopeRoot); return false }
    if (directPath !== null && !strictlyWithin(directPath, root.canonicalPath)) { refuse(job, 'invalid-scope', null); return false }
    if ((task === 'checkout-status' && (root.kind !== 'checkout' || root.repositoryId === null || root.checkoutIdentity === null))
      || (task === 'git-history' && (root.kind !== 'checkout' || root.repositoryId === null))) {
      refuse(job, 'not-a-checkout-root', scopeRoot)
      return false
    }

    const now = iso(nowMs)
    const newPass = job.cursor === null
    // Spec s10: at most one status start per checkout per 30 s. Resumed slices of one pass are that one start; direct
    // observations are another task kind and never wait for it.
    if (task === 'checkout-status' && newPass) {
      const last = Date.parse(readArtifactManagerState(db, passStartKey(root.rootId, task)) ?? '')
      if (Number.isFinite(last) && nowMs - last < cfg.statusMinIntervalMs) {
        safely('throttling a status pass', () => db.transaction(() => {
          retryArtifactJob(db, job.jobId, 'status-throttled', iso(last + cfg.statusMinIntervalMs), now)
          bumpState(db, 'health.status-throttled', 1, now)
        }))
        throttledClaims.set(job.jobId, (throttledClaims.get(job.jobId) ?? 0) + 1)
        return false
      }
    }

    let cursor = job.cursor
    let sinceMs: number | undefined
    let includeOlder = false
    if (task !== 'direct-observation') {
      // A pass consumes its OWN task's "Import older files" request when it starts; resumed slices keep that choice.
      includeOlder = newPass
        ? readArtifactManagerState(db, includeOlderKey(task, root.rootId)) !== null
        : readArtifactManagerState(db, passOlderKey(root.rootId, task)) === '1'
      // R26: a history pass continues from the ref tips the last completed pass persisted.
      if (task === 'git-history' && cursor === null) cursor = readArtifactManagerState(db, historyCursorKey(root.rootId))
      const sinceKey = passSinceKey(root.rootId, task)
      if (newPass) {
        // R24: the first pass looks back initialLookbackDays; a later one also reaches back to just before the previous pass
        // started (a downtime longer than the lookback leaves no gap), and to the cutoff of a previous pass that never
        // completed (a failed start does not move the window forward).
        const prevStart = Date.parse(readArtifactManagerState(db, passStartKey(root.rootId, task)) ?? '')
        const carry = Number(readArtifactManagerState(db, sinceKey) ?? Number.NaN)
        let since = nowMs - lookbackMs
        if (Number.isFinite(prevStart)) since = Math.min(since, prevStart - PASS_OVERLAP_MS)
        if (Number.isFinite(carry)) since = Math.min(since, carry)
        sinceMs = since
      } else {
        const stored = Number(readArtifactManagerState(db, sinceKey) ?? Number.NaN)
        sinceMs = Number.isFinite(stored) ? stored : nowMs - lookbackMs
      }
    }
    const request: ArtifactWorkerRequest = {
      jobId: job.jobId, root: workerRoot(root), generation: job.desiredGeneration, task, ...(directPath !== null ? { path: directPath } : {}),
      cursor, includeOlder, documentExtensions: workerExtensions, ignoreSegments: workerIgnore,
      limits: { maxEntries: cfg.maxEntriesPerSlice, maxMs: cfg.maxSliceMs, gitTimeoutMs: cfg.gitTimeoutMs, gitMaxOutputBytes: cfg.gitMaxOutputBytes, maxFrameRows },
      ...(sinceMs !== undefined ? { sinceMs } : {}),
    }
    if (validateArtifactWorkerRequest(request) !== null) { refuse(job, 'invalid-request', scopeRoot); return false }
    if (task !== 'direct-observation' && newPass) {
      // Written when the pass starts (R24), before the worker sees the request.
      safely('recording a pass start', () => db.transaction(() => {
        writeState(db, passStartKey(root.rootId, task), now, now)
        writeState(db, passSinceKey(root.rootId, task), String(sinceMs), now)
        if (includeOlder) writeState(db, passOlderKey(root.rootId, task), '1', now)
        else deleteState(db, passOlderKey(root.rootId, task))
      }))
    }
    const f: Inflight = {
      job, root, task, request, directPath, baseline: { appliedGeneration: root.appliedGeneration, completedAt: root.lastSuccessfulAt },
      // R35: background work is recovery, verification and backfill; direct and dirty work never waits for the pause.
      sliceStartMs: nowMs, background: job.priority > ARTIFACT_JOB_PRIORITY.dirty,
    }
    try {
      worker.start(request)
    } catch (err) {
      log.warn('artifact worker could not take the job', { error: errName(err) })
      worker.restart('start-failed')
      transient(f, 'worker-unavailable')
      return false
    }
    inflight = f
    recordFacility()
    return true
  }

  /** The most urgent priority among due jobs, read without claiming (the same "due" rule as claimArtifactJob), or null. */
  function dueMinPriority(now: string): number | null {
    const r = db.raw.prepare(`SELECT MIN(priority) AS p FROM artifact_jobs WHERE state = 'queued' OR (state = 'retry' AND retry_at <= ?) OR (state = 'running' AND lease_until <= ?)`)
      .get(now, now) as { p: number | null } | undefined
    return r?.p ?? null
  }

  /** Claims and starts jobs; with `maxPriority`, only while the most urgent due job is at least that urgent (R35). */
  async function claimAndStart(nowMs: number, maxPriority?: number): Promise<boolean> {
    let did = false
    for (let i = 0; i < MAX_CLAIMS_PER_TICK; i++) {
      if (maxPriority !== undefined) {
        const p = dueMinPriority(iso(nowMs))
        if (p === null || p > maxPriority) return did
      }
      const job = claimArtifactJob(db, iso(nowMs))
      if (!job) return did
      did = true
      if (begin(job, nowMs)) return true
      // A backfill batch or a Git object check slice is background work: nothing more this tick (and, after a backfill
      // batch's commit, one turn of the event loop first, PERF-GAP-3).
      if (job.taskKind === 'legacy-backfill') { await yieldToEventLoop(); return true }
      if (gitObjects !== null) return true
    }
    return did
  }

  // ---------------------------------------------------------------------------------------------- frames

  const ALLOWED_KINDS: Readonly<Record<string, readonly string[]>> = {
    'direct-observation': ['working'], verify: ['working'], 'output-walk': ['working'], 'checkout-status': ['working', 'index'], 'git-history': ['commit'],
  }

  /** The identity the worker must have derived for a live file under `root` (Task 5's rule, R27). */
  function expectedIdentity(root: ArtifactRootRow, roots: ArtifactRootRow[], path: string): ArtifactDocumentIdentity | null {
    const wr = workerRoot(root)
    let id
    if (root.kind === 'checkout' && root.repositoryId !== null) {
      id = documentIdentityForPath(path, wr, { repositoryId: root.repositoryId, gitPath: path.slice(root.canonicalPath.length + 1) })
    } else if (root.repositoryId !== null && root.checkoutIdentity !== null) {
      const top = roots.find(r => r.kind === 'checkout' && r.repositoryId === root.repositoryId && r.checkoutIdentity === root.checkoutIdentity && within(root.canonicalPath, r.canonicalPath))
      if (!top) return null
      id = documentIdentityForPath(path, wr, { repositoryId: root.repositoryId, gitPath: path.slice(top.canonicalPath.length + 1) })
    } else {
      id = documentIdentityForPath(path, wr, null)
    }
    return 'incomplete' in id ? null : id
  }

  /** Why a frame must not be committed, or null. Service-side validation (spec s2). */
  function frameProblem(f: Inflight, frame: ArtifactWorkerFrame): string | null {
    if (validateArtifactWorkerFrame(frame) !== null) return 'malformed-frame'
    if (frame.jobId !== f.job.jobId) return 'wrong-job'
    // PERF-GAP-3: never more rows in one commit than the frame size this job asked for.
    if (frame.rows.length > (f.request.limits.maxFrameRows ?? ARTIFACT_IPC_LIMITS.maxRows)) return 'too-many-rows'
    const terminal = isTerminalArtifactFrame(frame)
    if (!terminal && (frame.complete || frame.error !== undefined)) return 'data-frame-shape'
    if (f.directPath !== null && frame.rows.length > 1) return 'too-many-rows'
    const roots = listArtifactRoots(db)
    const root = roots.find(r => r.rootId === f.root.rootId)
    if (!root || !root.active) return 'root-inactive'
    if (isArtifactRootRefused(root.canonicalPath, refused)) return 'root-refused'
    if (f.task !== 'direct-observation' && !scannable(root)) return 'direct-only-root'
    if (terminal) {
      // A terminal frame's claims must agree with its error kind: nothing that failed, must be retried or restarts may
      // complete a pass, and a gap or an inaccessible root is never complete coverage.
      const kind = frame.error ? artifactWorkerErrorKind(frame.error.code) : null
      // Task 5 ends a refused direct check (`path-denied`) with complete: true although the code classifies as failed
      // (ledgered M4): accepted, and recorded as a failure that completes nothing.
      const deniedDirect = frame.error?.code === 'path-denied' && f.task === 'direct-observation'
      if (frame.complete && (kind === 'retry' || kind === 'restart' || (kind === 'failed' && !deniedDirect))) return 'terminal-inconsistent'
      if (kind === 'gap' && frame.coverage === 'complete') return 'terminal-inconsistent'
      if (frame.complete && frame.coverage === 'inaccessible') return 'terminal-inconsistent'
      if (kind === 'result' && f.task !== 'direct-observation') return 'terminal-inconsistent'
      return null
    }
    const allowed = ALLOWED_KINDS[f.task] ?? []
    const authRoots = roots.filter(r => r.active && !isArtifactRootRefused(r.canonicalPath, refused)).map(workerRoot)
    for (const row of frame.rows) {
      if (row.rootId !== root.rootId) return 'wrong-root'
      if (!allowed.includes(row.kind)) return 'kind-not-allowed'
      if (row.kind === 'commit') {
        const g = row.git!
        const e = row.evidence
        if (e !== undefined && (e.source !== 'git' || e.operation !== 'touched' || e.eventKey !== `git:${g.commitOid}:${g.gitPath}` || e.locator !== undefined
          || e.certainty !== (e.sessionId === null ? 'unknown' : 'recorded'))) return 'evidence'
      } else if (row.evidence !== undefined) {
        return 'evidence'
      }
      if (row.kind === 'working') {
        const path = row.path!
        if (!strictlyWithin(path, root.canonicalPath)) return 'outside-root'
        if (f.directPath !== null && path !== f.directPath) return 'direct-path'
        if (isArtifactRootRefused(path, refused)) return 'refused-path'
        const auth = authorizeArtifactPath(path, authRoots, home)
        if (!auth.allowed || auth.canonicalPath !== path) return 'unauthorized-path'
        const expected = expectedIdentity(root, roots, path)
        if (!expected || !sameIdentity(expected, row.identity)) return 'identity-mismatch'
        if (row.git !== undefined && (root.kind !== 'checkout' || row.git.repositoryId !== root.repositoryId
          || (row.git.checkoutIdentity !== undefined && row.git.checkoutIdentity !== root.checkoutIdentity))) return 'wrong-repository'
      } else {
        const g = row.git!
        if (root.kind !== 'checkout' || root.repositoryId === null || g.repositoryId !== root.repositoryId) return 'wrong-repository'
        if (row.kind === 'index' && g.checkoutIdentity !== root.checkoutIdentity) return 'wrong-checkout'
        const expected = documentIdentityForGitPath(root.repositoryId, g.gitPath!)
        if ('incomplete' in expected || !sameIdentity(expected, row.identity)) return 'identity-mismatch'
      }
    }
    return null
  }

  type Snapshot = { document_id: string | null; current_version_id: string | null }
  function locations(paths: string[]): Map<string, Snapshot> {
    const out = new Map<string, Snapshot>()
    const stmt = db.raw.prepare('SELECT document_id, current_version_id FROM artifacts WHERE path = ?')
    for (const p of paths) {
      const r = stmt.get(p) as Snapshot | undefined
      if (r) out.set(p, { document_id: r.document_id, current_version_id: r.current_version_id })
    }
    return out
  }

  function gapCodes(frame: ArtifactWorkerFrame): string[] {
    const text = `${frame.error?.code ?? ''} ${frame.error?.message ?? ''}`
    return ARTIFACT_WORKER_GAP_CODES.filter(c => new RegExp(`(^|[^a-z-])${c}([^a-z-]|$)`).test(text))
  }

  /** R67: `frame` without its lookback-limited gap once the root's first scan pass has completed (see handleFrame). */
  function withoutKnownLookback(f: Inflight, frame: ArtifactWorkerFrame): ArtifactWorkerFrame {
    if (!SCAN_TASKS.has(f.task) || f.baseline.appliedGeneration === 0 || !isTerminalArtifactFrame(frame) || !frame.error) return frame
    if (artifactWorkerErrorKind(frame.error.code) !== 'gap') return frame
    const codes = gapCodes(frame)
    if (!codes.includes('lookback-limited')) return frame
    const rest = codes.filter(c => c !== 'lookback-limited')
    const { error: _known, ...base } = frame
    if (rest.length === 0) return { ...base, coverage: frame.complete ? 'complete' : frame.coverage }
    return { ...base, error: { code: rest[0]!, message: `coverage gaps: ${rest.join(', ')}` } }
  }

  /**
   * The other spelling of a canonical (real) path when home is reached through a symlink (macOS /var -> /private/var): a legacy
   * row, a hook or a configured path can name the same file by home's literal spelling. Returned only for a spelling that already
   * has a catalogued location and that still resolves to exactly this file, so a stale or redirected row is never merged.
   */
  function homeSpellingAliases(canonical: string): string[] {
    if (homeRealPath === null || homeRealPath === homeLiteral || !strictlyWithin(canonical, homeRealPath)) return []
    const alias = homeLiteral + canonical.slice(homeRealPath.length)
    if (!findArtifactByPath(db, alias)) return []
    try { return realpathSync.native(alias) === canonical ? [alias] : [] } catch { return [] }
  }

  /** Everything one frame changes, in the caller's transaction. Throws to roll it all back. */
  /**
   * R34: a pass whose only gap is `nested-worktree` is complete when every entry of every .claude/worktrees directory below
   * the root that the runner knows of (the root's own, and the parent of each registered checkout inside it) is a registered
   * ACTIVE checkout root: those subtrees are scanned as roots of their own. Anything else there keeps the gap.
   */
  function nestedWorktreesRegistered(root: ArtifactRootRow): boolean {
    const roots = listArtifactRoots(db)
    const activeCheckouts = new Set(roots.filter(r => r.active && r.kind === 'checkout').map(r => r.canonicalPath))
    const dirs = new Set<string>([join(root.canonicalPath, '.claude', 'worktrees')])
    for (const r of roots) {
      if (r.kind !== 'checkout' || !strictlyWithin(r.canonicalPath, root.canonicalPath)) continue
      const parent = dirname(r.canonicalPath)
      if (basename(parent) === 'worktrees' && basename(dirname(parent)) === '.claude') dirs.add(parent)
    }
    let entries = 0
    for (const dir of dirs) {
      let list
      try { list = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of list) {
        entries++
        if (!e.isDirectory() || !activeCheckouts.has(join(dir, e.name))) return false
      }
    }
    return entries > 0
  }

  /** Returns the recovery scope a completed pass satisfied (persisted here; noted in memory once the transaction commits). */
  function commitFrame(f: Inflight, frame: ArtifactWorkerFrame, kind: ArtifactWorkerErrorKind | null, note: string | null = null): string | null {
    const now = nowIso()
    const terminal = isTerminalArtifactFrame(frame)
    const allWorking = frame.rows.filter(r => r.kind === 'working') as Array<ArtifactWorkerObservation & { path: string }>
    const before = locations(allWorking.map(r => r.path))
    // Only progress may complete a pass: a failed, retried or restarted slice never does (I2).
    const complete = (kind === null || kind === 'gap' || kind === 'result') && frame.complete
    const { deferredPaths } = commitArtifactBatch(db, f.job.jobId, f.request.generation, frame.rows, { cursor: frame.cursor, coverage: frame.coverage, complete }, now, { quietMs: cfg.debounceMs })
    // A file still being written was not recorded (it is rechecked once settled): it takes no part in adoption or session linking.
    const deferred = new Set(deferredPaths)
    const working = deferred.size === 0 ? allWorking : allWorking.filter(r => !deferred.has(r.path))
    if (working.length > 0) {
      // A legacy location linked to a provisional document takes the identity this observation just verified.
      adoptProvisionalLocations(db, working.map(r => ({ path: r.path, rootId: f.root.rootId, identity: r.identity, aliases: homeSpellingAliases(r.path) })), now)
      // PR #19 review, P2-2: a location whose document a hook created under a root identity, before this checkout was registered,
      // takes the repository identity this observation just verified (merged into the repository document when one exists).
      adoptArtifactRepositoryIdentity(db, working.filter(r => r.identity.identityKind === 'repository').map(r => ({ path: r.path, rootId: f.root.rootId, identity: r.identity })), now)
      // R29: link sessions to working-version transitions, against the baseline as it was when the job was claimed.
      if (f.baseline.appliedGeneration > 0 && f.baseline.completedAt !== null) {
        const after = locations(working.map(r => r.path))
        for (const row of working) {
          const a = after.get(row.path)
          const previous = before.get(row.path)?.current_version_id ?? null
          if (!a || a.document_id === null || a.current_version_id === null || a.current_version_id === previous) continue
          inferSessionActivity(db, {
            documentId: a.document_id, rootId: f.root.rootId, newVersionId: a.current_version_id, previousVersionId: previous, baseline: f.baseline, observedAt: row.observedAt,
          }, now)
        }
      }
    }
    bumpState(db, 'health.entries-inspected', frame.counts.visited, now)
    bumpState(db, 'health.rows-committed', frame.rows.length, now)
    if (!terminal) return null

    bumpState(db, 'health.slices', 1, now)
    bumpState(db, 'health.slice-ms', Math.max(0, clock() - f.sliceStartMs), now)
    const code = frame.error?.code ?? null
    const rootId = f.root.rootId
    if (f.directPath !== null && code === 'path-missing') {
      // A direct ENOENT/ENOTDIR answer is checked against the one proof for "missing" (R72: the device the location was last
      // seen on); anything short of proof leaves it unverified, never missing.
      const loc = findArtifactByPath(db, f.directPath)
      if (loc && loc.existsState !== 'missing') recheckKnownLocation(db, loc.artifactId, now, { recordUnverified: true })
    }
    if (f.task === 'git-history') {
      if (kind === 'restart') deleteState(db, historyCursorKey(rootId))
      else if (complete && frame.cursor !== null) writeState(db, historyCursorKey(rootId), frame.cursor, now) // R26, same transaction
    }
    if (ROOT_TASKS.has(f.task)) {
      // R67: a scan task's lookback gap stays until a pass of that task that imported older files completes.
      const sticky = SCAN_TASKS.has(f.task) && !(complete && f.request.includeOlder) && (readArtifactCoverageNote(db, rootId, f.task)?.codes.includes('lookback-limited') ?? false)
      const codes = kind === 'gap' ? gapCodes(frame) : []
      if (sticky && !codes.includes('lookback-limited')) codes.push('lookback-limited')
      if (kind === 'gap' || (sticky && (note !== null || (complete && frame.coverage === 'complete')))) {
        writeArtifactCoverageNote(db, rootId, f.task, { codes, info: note, complete }, now)
      } else if (note !== null) writeArtifactCoverageNote(db, rootId, f.task, { codes: [], info: note, complete }, now)
      else if (complete && frame.coverage === 'complete') deleteArtifactCoverageNote(db, rootId, f.task)
    }
    if (kind === 'retry') {
      retryOrFail(f.job, ROOT_TASKS.has(f.task) ? rootId : null, code!, frame.coverage === 'inaccessible' ? 'inaccessible' : 'partial', now)
      return null
    }
    if (kind === 'failed') {
      finishArtifactJob(db, f.job.jobId, { complete: false, coverage: frame.coverage, error: code! }, now)
      markFailed(f.task, ROOT_TASKS.has(f.task) ? rootId : null, code!, now)
      return null
    }
    // none, gap, result: the slice ends as the worker says; restart: requeue from no cursor.
    const done = kind !== 'restart' && complete
    finishArtifactJob(db, f.job.jobId, { complete: done, coverage: frame.coverage }, now)
    if (ROOT_TASKS.has(f.task)) {
      if (done) {
        const started = Date.parse(readArtifactManagerState(db, passStartKey(rootId, f.task)) ?? '')
        if (Number.isFinite(started)) writeState(db, 'health.last-pass-duration-ms', String(Math.max(0, Date.parse(now) - started)), now)
        deleteState(db, passSinceKey(rootId, f.task))
        deleteState(db, jobFailedKey(f.task, rootId))
        if (readArtifactManagerState(db, passOlderKey(rootId, f.task)) === '1') {
          // The request this pass consumed is done. A request written after this pass started (a refresh during the pass)
          // is newer than this pass and stays for the next one.
          const startedAt = readArtifactManagerState(db, passStartKey(rootId, f.task))
          const writtenAt = stateWrittenAt(db, includeOlderKey(f.task, rootId))
          if (startedAt !== null && writtenAt !== null && writtenAt <= startedAt) deleteState(db, includeOlderKey(f.task, rootId))
          deleteState(db, passOlderKey(rootId, f.task))
        }
        // F-RESTART-PASS: this scope's recovery is satisfied until the interval has elapsed from now, across restarts too.
        const key = recoveryKeyFor(f.task, f.root)
        if (key !== null) {
          persistRecovery(key, now)
          return key
        }
      }
    }
    return null
  }

  function handleFrame(f: Inflight, frame: ArtifactWorkerFrame): void {
    if (frame.jobId === '') {
      // A protocol refusal: the worker never started this job.
      inflight = null
      const code = frame.error?.code ?? 'invalid-request'
      if (code === 'worker-busy') { worker.restart('worker-busy'); transient(f, 'worker-busy'); return }
      refuse(f.job, code, ROOT_TASKS.has(f.task) ? f.root.rootId : null)
      return
    }
    const problem = frameProblem(f, frame)
    if (problem !== null) {
      log.warn('artifact worker frame rejected; restarting the worker', { task: f.task, reason: problem })
      inflight = null
      worker.restart('frame-rejected')
      safely('counting a rejected frame', () => bumpState(db, 'health.rejected-frames', 1, nowIso()))
      transient(f, 'frame-rejected')
      return
    }
    // R67: whether eligible files older than the lookback were left out is decided by the root's FIRST completed scan pass
    // (kept as a sticky lookback gap, commitFrame). After it, the rolling lookback skips files an earlier pass already saw (or
    // left out and reported): no new gap, so it is taken out of the frame before anything else judges it.
    frame = withoutKnownLookback(f, frame)
    let kind = frame.error ? artifactWorkerErrorKind(frame.error.code) : null
    let effective = frame
    let note: string | null = null
    if (isTerminalArtifactFrame(frame) && frame.complete && kind === 'gap' && frame.coverage === 'partial'
      && gapCodes(frame).join(',') === 'nested-worktree' && nestedWorktreesRegistered(f.root)) {
      // R34: the service itself resolved the only gap (every nested worktree is an active root of its own), so the pass is
      // complete; decided before commitArtifactBatch/finishArtifactJob, whose invariants stay untouched.
      const { error: _resolved, ...rest } = frame
      effective = { ...rest, coverage: 'complete' }
      kind = null
      note = 'nested-worktrees-registered'
    }
    const startedAt = clock()
    let recovered: string | null = null
    try {
      recovered = db.transaction(() => commitFrame(f, effective, kind, note))
    } catch (err) {
      // Nothing of this frame is durable, so nothing is acknowledged: the worker restarts and the job replays from its
      // last committed checkpoint.
      log.warn('artifact batch commit failed; replaying from the last checkpoint', { task: f.task, error: errName(err) })
      inflight = null
      worker.restart('commit-failed')
      transient(f, 'commit-failed')
      return
    }
    if (recovered !== null) noteRecovery(recovered, startedAt)
    safely('counting write time', () => bumpState(db, 'health.db-write-ms', clock() - startedAt, nowIso()))
    worker.ack(frame.jobId)
    if (!isTerminalArtifactFrame(frame)) return
    inflight = null
    if (f.task === 'git-history') {
      if (frame.complete || kind === 'restart') historyMidPass.delete(f.root.rootId)
      else historyMidPass.add(f.root.rootId)
    }
    if (kind !== 'retry') throttledClaims.delete(f.job.jobId)
    if (f.background) pauseUntil = clock() + backgroundPauseMs
  }

  function handleExit(reason: string): void {
    const f = inflight
    inflight = null
    log.warn('artifact worker exited unexpectedly', { reason })
    safely('counting a worker crash', () => bumpState(db, 'health.worker-crashes', 1, nowIso()))
    recordFacility()
    if (f) transient(f, reason === 'timeout' ? 'worker-timeout' : reason.startsWith('protocol-') ? 'worker-protocol' : 'worker-crash')
  }

  async function serviceInflight(): Promise<boolean> {
    let ev = worker.poll()
    if (!ev && frameWaitMs > 0) {
      await worker.wait(frameWaitMs)
      if (stopped) return false
      ev = worker.poll()
    }
    if (!ev || !inflight) return false
    if (ev.type === 'exit') handleExit(ev.reason)
    else {
      handleFrame(inflight, ev.frame)
      // PERF-GAP-3 (R65): each frame commits in one transaction; between two commits the event loop takes one turn, so HTTP
      // requests and timers waiting behind a commit run before the next frame (also on back-to-back dirty slices, R35).
      await yieldToEventLoop()
    }
    return true
  }

  // ---------------------------------------------------------------------------------------------- the runner

  return {
    name: 'artifact-manager',
    markDirty,
    settle: async () => {
      await reconcile?.promise
      await gitObjects?.promise
    },
    stop() {
      if (stopped) return
      stopped = true
      worker.stop()
      killServiceGit()
      // A root reconciliation still under way makes no further Git call (planRoots checks `stopped`), but an adapter call
      // already running may start one more process: keep watching, killing on sight, until the reconciliation settles.
      const finish = (): void => {
        killServiceGit()
        diagnosticsChannel.unsubscribe('child_process', onChild)
      }
      // The same holds for a Git object check slice under way (it starts no further run: checkGitObjects checks `stopped`).
      const pending = [reconcile && !reconcile.done ? reconcile.promise : null, gitObjects && !gitObjects.done ? gitObjects.promise : null]
        .filter((p): p is Promise<void> => p !== null)
      if (pending.length > 0) void Promise.allSettled(pending).then(finish)
      else finish()
    },
    async run() {
      if (stopped) return false
      if (!started) startup()
      const nowMs = clock()
      let busy = flushDirty(nowMs)
      if (gitObjects?.done) {
        finishGitObjectCheck(gitObjects)
        busy = true
        // One catalog commit per turn of the event loop (PERF-GAP-3): a frame commit may follow below.
        await yieldToEventLoop()
        if (stopped) return busy
      }
      if (inflight) return (await serviceInflight()) || busy
      // An idle worker can still die (or be killed): count it and let the next job respawn it.
      const idleEvent = worker.poll()
      if (idleEvent?.type === 'exit') handleExit(idleEvent.reason)
      // An explicit pause (R18) blocks every claim, direct observations included.
      const paused = isArtifactDiscoveryPaused(db)
      let planApplied = false
      if (reconcile) {
        // While roots are being reconciled, only direct and dirty work may run (R35); background work waits.
        if (!reconcile.done) return paused ? busy : (await claimAndStart(nowMs, ARTIFACT_JOB_PRIORITY.dirty)) || busy
        const plan = reconcile.plan
        reconcile = null
        if (plan) {
          safely('registering artifact roots', () => applyPlan(plan))
          // R74.7: a pause holds root retirement too; the periodic check after it resumes records and retires (not needed for
          // correctness: nothing is lost by checking later).
          if (!paused) safely('checking root folders', () => checkRootFolders(nowMs))
        }
        busy = true
        planApplied = true
      }
      if (paused) return busy
      if (autoSchedule) {
        const due = reconcileDue(nowMs)
        if (due !== null) { startReconcile(nowMs, due === 'full'); return true }
        if (nowMs - lastRootFolderCheck >= ROOT_FOLDER_CHECK_MS) safely('checking root folders', () => checkRootFolders(nowMs))
        scheduleRecovery(nowMs)
      }
      // R93: repository identity adoption, one page per turn. Never while a root reconciliation is in flight (R35: the branch above
      // returned already; the plan reads and writes the registered roots), never in the turn that applied a plan (one catalog commit
      // per turn), and a pause holds it (R18). The turn is busy while a cursor is left, so the scheduler comes straight back.
      if (!planApplied && hasPendingAdoption()) {
        // R95 (R35): direct and dirty work due now is claimed before a page; adoption is background work.
        if (await claimAndStart(nowMs, ARTIFACT_JOB_PRIORITY.dirty)) return true
        if (adoptionStep()) {
          await yieldToEventLoop()
          return true
        }
      }
      // The 1 s pause after a background slice, and a Git object check still running, hold back background work only (R35).
      if (nowMs < pauseUntil || gitObjects !== null) return (await claimAndStart(nowMs, ARTIFACT_JOB_PRIORITY.dirty)) || busy
      return (await claimAndStart(nowMs)) || busy
    },
  }
}
