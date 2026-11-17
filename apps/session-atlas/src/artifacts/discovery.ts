// Resumable, DB-free discovery for the Artifact Manager worker (plan 2026-10-26 Task 5).
//
// discoverArtifactSlice(request) runs ONE bounded slice of one task against one registered root and yields NDJSON-ready
// frames. It reads directory entries, lstat metadata and Git (through the Task 4 adapter only); it never opens the Atlas
// database, never reads or hashes document bytes, never writes a user file or Git ref, and never follows a directory symlink.
// Everything it needs (extensions, ignore segments, limits, cutoff) comes from the request; nothing is read from process-wide
// configuration. The service validates every frame again, re-authorizes paths and recomputes identities (Task 7).
//
// Slice protocol (worker-main.ts carries it over stdin/stdout):
//   - a slice yields zero or more DATA frames (1..limits.maxFrameRows rows, at most 250; complete:false, coverage 'partial', no
//     error), then exactly one TERMINAL frame with rows: []. The terminal frame carries the slice's final cursor, `complete`
//     (the whole pass is done), coverage, counts and, when anything was skipped or failed, `error`. isTerminalArtifactFrame()
//     tells them apart.
//   - every frame's cursor is a checkpoint covering every row of that frame and of the frames before it, so a replay from any
//     committed frame repeats at most rows already seen (duplicates are harmless; nothing is skipped).
//   - counts are per frame (the entries accounted for since the previous frame); the sum over a slice is the slice total.
//   - a slice stops at `limits.maxEntries` new entries or `limits.maxMs` of its own per-entry work, whichever comes first.
//     Neither the fixed setup before the first entry (root check, checkout resolution, the git status/ls-files/cat-file
//     snapshot, each Git process bounded by `gitTimeoutMs`) nor time spent suspended at a yield (waiting for the service's
//     acknowledgement) counts. At least one entry is always processed, so every slice makes progress. A slice boundary is
//     not the end of a scan: `complete:false` + an advanced cursor.
//
// Cursors (opaque to the service, at most 64 KiB, bound to their task and root ID):
//   - output-walk: the path (raw name bytes, base64) of the last entry visited in a depth-first walk that lists each directory
//     and sorts its entries by byte order. A resumed slice re-lists only the directories on that path (O(depth x directory
//     size)), skips names at or before the cursor and continues; it never restarts at the first directory. A directory in the
//     cursor means "entered, no child visited yet". Mutation between slices never breaks the walk: removed entries are
//     simply absent, entries added AFTER the cursor are found in this pass, and entries added BEHIND it are found by the next
//     generation (a fresh pass from a null cursor). The cursor also carries the pass start time: a walked directory that
//     changed after it, or a listed entry that vanished, makes the pass partial (`path-changed`), since an entry may have
//     moved behind the cursor (DEFECT-4). Directory mtimes are never used to skip anything.
//   - checkout-status: the raw Git path of the last status entry processed; each slice re-runs `git status` and continues after
//     it (parsed entries are not carried between slices: the worker keeps no state between requests and a 64 KiB cursor
//     cannot hold them). A status pass of up to `maxEntries` entries finishes in one slice.
//   - git-history: the Task 4 history cursor, wrapped. A finished pass returns complete:true WITH its cursor (the persisted
//     ref tips): the next pass must start from it, not from null, or it is an initial pass again.
//   - every cursor also carries the pass's sticky gap codes, so a skip in slice 1 still makes the last slice report 'partial'.
//   A cursor that cannot be decoded (or belongs to another task or root) is answered with `invalid-cursor` and cursor null: the
//   next slice restarts the pass. A cursor that would exceed the bound is never truncated: the slice stops with `cursor-limit`.
//
// Coverage: 'complete' only when the whole scope was walked to the end with nothing skipped for an unsupported/limit/
// permission reason. Policy skips (symlinks, fixed and configured discovery exclusions, junk files) are counted in
// counts.skipped but are not gaps. ARTIFACT_WORKER_GAP_CODES lists the gaps; artifactWorkerErrorKind() classifies every code.

import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ArtifactsConfig } from '../config.ts'
import type {
  ArtifactDocumentIdentity, ArtifactTaskKind, ArtifactWorkerFrame, ArtifactWorkerObservation, ArtifactWorkerRequest, ArtifactWorkerRoot,
} from './contracts.ts'
import { classifyPath } from './filetype.ts'
import {
  decodeGitPath, parseBatchCheck, parseLsFilesStageZ, parseLsFilesTagsZ, parsePorcelainV1Z, type GitChange, type GitIndexEntry, type GitObjectFormat, type GitStatusEntry,
} from './git-parser.ts'
import {
  GitAdapterError, listTrackedDocumentStates, readDocumentHistory, resolveGitCheckout, resolveTrackedDocumentFilters, runArtifactGit, type GitCheckout, type GitLimits,
} from './git.ts'
import {
  authorizeArtifactPath, canonicalizeArtifactRoot, documentIdentityForGitPath, documentIdentityForPath, isPassiveDiscoveryExcluded, MAX_ARTIFACT_PATH_CHARS,
  type ArtifactIdentityRefusal,
} from './path-policy.ts'

// ------------------------------------------------------------------------------------------------------------ shared limits

/**
 * IPC bounds shared with the service (Task 7 imports this): at most 250 rows and 1 MiB per encoded frame line (newline
 * included), cursors of at most 64 KiB (UTF-8 bytes), error messages of at most 512 characters, request lines of at most 1 MiB.
 */
export const ARTIFACT_IPC_LIMITS = Object.freeze({
  maxRows: 250,
  maxFrameBytes: 1_048_576,
  maxCursorBytes: 65_536,
  maxErrorMessageChars: 512,
  maxLineBytes: 1_048_576,
} as const)

/** Import cutoff when a request carries no `sinceMs` (ruling R24): seven days. */
export const ARTIFACT_DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Coverage gaps, most severe first. Each is counted in counts.skipped where an item was skipped, is sticky for the pass (kept in
 * the cursor), and makes the pass's final coverage 'partial'. The terminal frame's error code is the most severe one present;
 * its message lists all of them.
 *  permission-denied     a directory or file below the root could not be read (EACCES/EPERM)
 *  unreadable-entry      any other filesystem error on an entry (ELOOP, EIO, ENAMETOOLONG, ...)
 *  path-changed          a directory's real path changed during the walk (replaced by a symlink): not descended; or the
 *                        walk saw the root change under it (DEFECT-4): an entry listed but gone when reached, or a walked
 *                        directory changed after (or just before, m5) the pass start, so entries may have moved unseen
 *  git-status-truncated  a Git listing hit the output cap or timeout: `git status` (only fully parsed records were used), or
 *                        an output-walk's tracked-clean snapshot (R66: no eligible file below that root was emitted)
 *  git-malformed-output  Git output did not parse to the end: `git status`, or an output-walk's tracked-clean snapshot
 *                        (R66: then no eligible file below that root was emitted)
 *  git-history-gap       the history adapter reported gaps (the message lists its tokens: shallow, missing-objects, ...)
 *  git-object-unavailable a blob's size could not be read (missing or promisor object): that version was not emitted
 *  git-filter-unresolved a configured filter driver (suppressed, never run) applies to a tracked document of the pass, or
 *                        whether one does could not be established: Git's "clean" is not byte equivalence there. A driver
 *                        that is merely configured (named by no attribute in effect for such a path) is not a gap.
 *  nested-worktree       a non-empty `.claude/worktrees` below the root was skipped (each worktree is its own root)
 *  nested-checkout       a nested Git checkout below a repository-identity root (or an untracked nested repo) was skipped
 *  unsupported-path      a name that is not lossless UTF-8, a path over 4096 characters, a path the path policy refuses an
 *                        identity for, or a committed path the catalog cannot key (control characters, event key > 512)
 *  oversized-record      one observation alone could not fit in a frame
 *  malformed-record      a Git record without its commit, or with a commit time that is not a representable date
 *  lookback-limited      history, or an eligible file (walk, status), older than the cutoff was deliberately not imported
 *                        ("partial until Import older files"); the service keeps a scan task's gap from the root's first
 *                        pass only (R67: later passes' cutoff rolls over files they already saw)
 */
export const ARTIFACT_WORKER_GAP_CODES = Object.freeze([
  'permission-denied', 'unreadable-entry', 'path-changed', 'git-status-truncated', 'git-malformed-output', 'git-history-gap',
  'git-object-unavailable', 'git-filter-unresolved', 'nested-worktree', 'nested-checkout', 'unsupported-path', 'oversized-record',
  'malformed-record', 'lookback-limited',
] as const)
export type ArtifactWorkerGapCode = (typeof ARTIFACT_WORKER_GAP_CODES)[number]

/**
 * How the service should treat a frame's error code:
 *  failed   nothing was done and repeating the same request cannot help (invalid request, policy refusal, unsupported task)
 *  retry    nothing was consumed: the cursor is the one sent; retry later with backoff (Git failures, inaccessible root)
 *  restart  the cursor was discarded (cursor null): the next slice starts the pass over
 *  gap      progress was made; coverage is partial for the named reason (ARTIFACT_WORKER_GAP_CODES)
 *  result   a direct observation's definitive outcome (the path is missing, or not a regular file)
 * Any `git-<token>` code not listed is 'retry'.
 */
export type ArtifactWorkerErrorKind = 'failed' | 'retry' | 'restart' | 'gap' | 'result'

const ERROR_KINDS: Readonly<Record<string, ArtifactWorkerErrorKind>> = Object.freeze({
  'invalid-request': 'failed', 'oversized-request': 'failed', 'invalid-frame': 'failed', 'worker-busy': 'retry', 'internal-error': 'retry',
  'direct-only-root': 'failed', 'unsupported-task': 'failed', 'not-a-checkout': 'failed', 'checkout-mismatch': 'failed',
  'invalid-cursor': 'restart', 'cursor-limit': 'failed',
  'root-missing': 'retry', 'root-inaccessible': 'retry', 'root-moved': 'failed', 'root-invalid': 'failed',
  'path-missing': 'result', 'not-regular-file': 'result', 'path-denied': 'failed', 'path-inaccessible': 'retry',
  ...Object.fromEntries(ARTIFACT_WORKER_GAP_CODES.map(c => [c, 'gap' as const])),
})

export function artifactWorkerErrorKind(code: string): ArtifactWorkerErrorKind {
  return ERROR_KINDS[code] ?? (code.startsWith('git-') ? 'retry' : 'failed')
}

/** The last frame of a slice: it carries no rows. Data frames always carry at least one. */
export function isTerminalArtifactFrame(frame: ArtifactWorkerFrame): boolean {
  return frame.rows.length === 0
}

// ---------------------------------------------------------------------------------------------------------------- validation

const TASKS: readonly ArtifactTaskKind[] = ['direct-observation', 'checkout-status', 'output-walk', 'git-history', 'verify', 'legacy-backfill']
const ROOT_KINDS: readonly string[] = ['checkout', 'output', 'session-directory']
const SCOPE_FLAGS: readonly string[] = ['checkout', 'configured-output', 'cli-output', 'session-cwd', 'direct-only']
const SCAN_FLAGS: ReadonlySet<string> = new Set(['checkout', 'configured-output', 'cli-output', 'session-cwd'])
const COVERAGES: readonly string[] = ['complete', 'partial', 'inaccessible']
const SOURCES: readonly string[] = ['hook', 'transcript', 'git', 'watcher', 'reconcile', 'legacy']
const OPERATIONS: readonly string[] = ['created', 'modified', 'touched']
const CERTAINTIES: readonly string[] = ['recorded', 'inferred', 'unknown']
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const LONE_SURROGATE_RE = /\p{Cs}/u
// U+FFFD is what a lossy decoder leaves behind; with a lone surrogate it means the string no longer names exactly one file.
const LOSSY_RE = /\p{Cs}|�/u
const EXTENSION_RE = /^[a-z0-9]{1,16}$/
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const GIT_TOKEN_RE = /^[a-z0-9-]{1,40}$/
const OID_RE: Readonly<Record<string, RegExp>> = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ }
const MAX_ID_CHARS = 256
const MAX_EXTENSIONS = 64
const MAX_IGNORE_SEGMENTS = 256
const MAX_SEGMENT_CHARS = 255
const MAX_ENTRIES_LIMIT = 1_000_000
const MAX_MS_LIMIT = 600_000
const MAX_GIT_OUTPUT_LIMIT = 256 * 1024 * 1024
const MAX_TIMESTAMP_CHARS = 64
// Task 2 stores evidence keys of at most 512 printable characters.
const MAX_EVENT_KEY_CHARS = 512
const MAX_STAT_ID_CHARS = 64
// JS dates cover +-8.64e15 ms.
const MAX_DATE_MS = 8.64e15

const FRAME_KEYS: readonly string[] = ['type', 'jobId', 'rows', 'cursor', 'complete', 'coverage', 'counts', 'error']
const OBSERVATION_KEYS: readonly string[] = ['rootId', 'identity', 'kind', 'observedAt', 'capturedAt', 'path', 'stat', 'git', 'evidence']
const IDENTITY_KEYS: readonly string[] = ['identityKind', 'repositoryId', 'rootId', 'relativePath']
const STAT_KEYS: readonly string[] = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
const GIT_KEYS: readonly string[] = ['repositoryId', 'checkoutIdentity', 'commitOid', 'gitPath', 'blobOid', 'objectFormat', 'mode', 'size', 'stage']
const EVIDENCE_KEYS: readonly string[] = ['source', 'eventKey', 'sessionId', 'operation', 'certainty', 'eventAt', 'locator']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (o: Obj, allowed: readonly string[]): boolean => Object.keys(o).every(k => allowed.includes(k))
const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS && !CONTROL_RE.test(v) && !LONE_SURROGATE_RE.test(v)
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
const nat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const intIn = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max

/** An absolute path with no empty, "." or ".." segment, no NUL, not "/", at most 4096 characters, losslessly representable. */
function isNormalizedAbsolute(p: unknown): p is string {
  return typeof p === 'string' && p.length > 1 && p.length <= MAX_ARTIFACT_PATH_CHARS && p.startsWith('/') && !p.includes('\0')
    && !LOSSY_RE.test(p) && p.slice(1).split('/').every(s => s !== '' && s !== '.' && s !== '..')
}

function isNormalizedRelative(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_ARTIFACT_PATH_CHARS && !p.startsWith('/') && !p.includes('\0')
    && !LOSSY_RE.test(p) && p.split('/').every(s => s !== '' && s !== '.' && s !== '..')
}

/**
 * Why `value` is not a well-formed ArtifactWorkerRequest (a short field name, never a value), or null. The service may use it
 * before sending; the worker refuses an invalid request with an `invalid-request` frame.
 */
export function validateArtifactWorkerRequest(value: unknown): string | null {
  if (!isObj(value)) return 'request'
  if (!isId(value.jobId)) return 'jobId'
  const r = value.root
  if (!isObj(r) || !isId(r.rootId) || !ROOT_KINDS.includes(r.kind as string) || !isNormalizedAbsolute(r.canonicalPath)
    || CONTROL_RE.test(r.canonicalPath) || !(r.repositoryId === null || isId(r.repositoryId))
    || !(r.checkoutIdentity === null || isId(r.checkoutIdentity)) || typeof r.protected !== 'boolean' || !Array.isArray(r.scopeFlags)
    || r.scopeFlags.length > SCOPE_FLAGS.length || !r.scopeFlags.every(f => SCOPE_FLAGS.includes(f as string))) return 'root'
  if (!nat(value.generation)) return 'generation'
  if (!TASKS.includes(value.task as ArtifactTaskKind)) return 'task'
  if (value.path !== undefined && (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > MAX_ARTIFACT_PATH_CHARS)) return 'path'
  if (value.task === 'direct-observation' && value.path === undefined) return 'path'
  if (!(value.cursor === null || (typeof value.cursor === 'string' && utf8Bytes(value.cursor) <= ARTIFACT_IPC_LIMITS.maxCursorBytes))) return 'cursor'
  if (typeof value.includeOlder !== 'boolean') return 'includeOlder'
  const exts = value.documentExtensions
  if (!Array.isArray(exts) || exts.length === 0 || exts.length > MAX_EXTENSIONS
    || !exts.every(e => typeof e === 'string' && EXTENSION_RE.test(e.toLowerCase()))) return 'documentExtensions'
  const ignore = value.ignoreSegments
  if (!Array.isArray(ignore) || ignore.length > MAX_IGNORE_SEGMENTS
    || !ignore.every(s => typeof s === 'string' && s.length > 0 && s.length <= MAX_SEGMENT_CHARS && !s.includes('/') && !s.includes('\0'))) return 'ignoreSegments'
  const l = value.limits
  if (!isObj(l) || !intIn(l.maxEntries, 1, MAX_ENTRIES_LIMIT) || !intIn(l.maxMs, 1, MAX_MS_LIMIT) || !intIn(l.gitTimeoutMs, 1, MAX_MS_LIMIT)
    || !intIn(l.gitMaxOutputBytes, 1, MAX_GIT_OUTPUT_LIMIT) || !(l.maxFrameRows === undefined || intIn(l.maxFrameRows, 1, ARTIFACT_IPC_LIMITS.maxRows))) return 'limits'
  if (value.sinceMs !== undefined && (typeof value.sinceMs !== 'number' || !Number.isFinite(value.sinceMs))) return 'sinceMs'
  return null
}

function statProblem(s: unknown): boolean {
  return !isObj(s) || !onlyKeys(s, STAT_KEYS) || !isId(s.dev) || s.dev.length > MAX_STAT_ID_CHARS || !isId(s.ino) || s.ino.length > MAX_STAT_ID_CHARS
    || !nat(s.size) || typeof s.mtimeMs !== 'number' || !Number.isFinite(s.mtimeMs) || typeof s.ctimeMs !== 'number' || !Number.isFinite(s.ctimeMs)
}

function gitProblem(g: unknown): boolean {
  if (!isObj(g) || !onlyKeys(g, GIT_KEYS) || !isId(g.repositoryId)) return true
  const re = typeof g.objectFormat === 'string' && Object.hasOwn(OID_RE, g.objectFormat) ? OID_RE[g.objectFormat] : undefined
  if (!re) return true
  if (!intIn(g.mode, 0, 0o177777) || !nat(g.size)) return true
  for (const k of ['commitOid', 'blobOid'] as const) if (g[k] !== undefined && !(typeof g[k] === 'string' && re.test(g[k]))) return true
  if (g.gitPath !== undefined && !isNormalizedRelative(g.gitPath)) return true
  if (g.checkoutIdentity !== undefined && !isId(g.checkoutIdentity)) return true
  return g.stage !== undefined && !intIn(g.stage, 0, 3)
}

function evidenceProblem(e: unknown): boolean {
  if (!isObj(e) || !onlyKeys(e, EVIDENCE_KEYS)) return true
  if (!SOURCES.includes(e.source as string) || !OPERATIONS.includes(e.operation as string) || !CERTAINTIES.includes(e.certainty as string)) return true
  if (typeof e.eventKey !== 'string' || e.eventKey.length === 0 || e.eventKey.length > MAX_EVENT_KEY_CHARS || CONTROL_RE.test(e.eventKey)) return true
  if (!(e.sessionId === null || isId(e.sessionId))) return true
  if (typeof e.eventAt !== 'string' || e.eventAt.length > MAX_TIMESTAMP_CHARS || CONTROL_RE.test(e.eventAt)) return true
  return e.locator !== undefined && (typeof e.locator !== 'string' || e.locator.length > MAX_EVENT_KEY_CHARS || CONTROL_RE.test(e.locator))
}

/** Kind invariants of the frozen contract, plus: no unknown keys anywhere (no smuggled content), identity agrees with Git. */
function observationProblem(o: unknown): boolean {
  if (!isObj(o) || !onlyKeys(o, OBSERVATION_KEYS) || !isId(o.rootId)) return true
  const id = o.identity
  if (!isObj(id) || !onlyKeys(id, IDENTITY_KEYS) || !isNormalizedRelative(id.relativePath)) return true
  if (id.identityKind === 'repository') {
    if (!isId(id.repositoryId) || id.rootId !== null) return true
  } else if (id.identityKind === 'root') {
    if (!isId(id.rootId) || id.repositoryId !== null) return true
  } else {
    return true
  }
  if (typeof o.observedAt !== 'string' || o.observedAt.length > MAX_TIMESTAMP_CHARS || !Number.isFinite(Date.parse(o.observedAt))) return true
  // The capture time of an lstat exists only for a row that carries a stat.
  if (o.capturedAt !== undefined && (o.kind !== 'working' || typeof o.capturedAt !== 'string' || o.capturedAt.length > MAX_TIMESTAMP_CHARS || !Number.isFinite(Date.parse(o.capturedAt)))) return true
  if (o.path !== undefined && !isNormalizedAbsolute(o.path)) return true
  if (o.stat !== undefined && statProblem(o.stat)) return true
  if (o.git !== undefined && gitProblem(o.git)) return true
  if (o.evidence !== undefined && evidenceProblem(o.evidence)) return true
  const g = o.git as Obj | undefined
  const sameRepository = (): boolean => !!g && id.identityKind === 'repository' && id.repositoryId === g.repositoryId && id.relativePath === g.gitPath
  switch (o.kind) {
    case 'working':
      if (o.path === undefined || o.stat === undefined) return true
      if (!(o.path as string).endsWith(`/${id.relativePath as string}`)) return true
      return !!g && id.identityKind === 'repository' && g.repositoryId !== id.repositoryId
    case 'index':
      if (!g || g.checkoutIdentity === undefined || g.gitPath === undefined || g.blobOid === undefined || g.stage === undefined || g.commitOid !== undefined) return true
      return !sameRepository()
    case 'commit':
      if (o.path !== undefined || o.stat !== undefined) return true
      if (!g || g.commitOid === undefined || g.gitPath === undefined || g.blobOid === undefined || g.stage !== undefined) return true
      return !sameRepository()
    default:
      return true
  }
}

/** Everything except the encoded size. */
function frameStructureProblem(value: unknown): string | null {
  if (!isObj(value) || value.type !== 'batch') return 'not-a-batch-frame'
  if (!onlyKeys(value, FRAME_KEYS)) return 'malformed-frame'
  if (typeof value.jobId !== 'string' || value.jobId.length > MAX_ID_CHARS || CONTROL_RE.test(value.jobId) || LONE_SURROGATE_RE.test(value.jobId)) return 'malformed-frame'
  if (!Array.isArray(value.rows)) return 'malformed-frame'
  if (value.rows.length > ARTIFACT_IPC_LIMITS.maxRows) return 'too-many-rows'
  if (value.cursor !== null && typeof value.cursor !== 'string') return 'malformed-frame'
  if (typeof value.cursor === 'string' && utf8Bytes(value.cursor) > ARTIFACT_IPC_LIMITS.maxCursorBytes) return 'cursor-too-large'
  if (typeof value.complete !== 'boolean' || !COVERAGES.includes(value.coverage as string)) return 'malformed-frame'
  const c = value.counts
  if (!isObj(c) || !onlyKeys(c, ['visited', 'eligible', 'skipped']) || !nat(c.visited) || !nat(c.eligible) || !nat(c.skipped)) return 'malformed-frame'
  if (value.error !== undefined) {
    const e = value.error
    if (!isObj(e) || !onlyKeys(e, ['code', 'message']) || typeof e.code !== 'string' || !CODE_RE.test(e.code) || typeof e.message !== 'string'
      || e.message.length > ARTIFACT_IPC_LIMITS.maxErrorMessageChars || CONTROL_RE.test(e.message)) return 'invalid-error'
  }
  for (const row of value.rows) if (observationProblem(row)) return 'malformed-row'
  return null
}

/**
 * Why `value` is not a frame the worker may send or the service may accept, or null: 'not-a-batch-frame', 'malformed-frame',
 * 'too-many-rows', 'cursor-too-large', 'invalid-error', 'malformed-row' (kind invariants, unknown keys, identity/Git mismatch)
 * or 'frame-too-large' (encoded line, newline included, over 1 MiB).
 */
export function validateArtifactWorkerFrame(value: unknown): string | null {
  const problem = frameStructureProblem(value)
  if (problem) return problem
  return utf8Bytes(JSON.stringify(value)) + 1 > ARTIFACT_IPC_LIMITS.maxFrameBytes ? 'frame-too-large' : null
}

/** The NDJSON line for `frame` (without its newline). Throws when the frame breaks any bound or invariant. */
export function encodeArtifactWorkerFrame(frame: ArtifactWorkerFrame): string {
  const problem = frameStructureProblem(frame)
  if (problem) throw new Error(`invalid artifact worker frame: ${problem}`)
  const line = JSON.stringify(frame)
  if (utf8Bytes(line) + 1 > ARTIFACT_IPC_LIMITS.maxFrameBytes) throw new Error('invalid artifact worker frame: frame-too-large')
  return line
}

function boundedMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, ARTIFACT_IPC_LIMITS.maxErrorMessageChars)
}

/** A protocol-level refusal not tied to a job (jobId ''): it is never acknowledged. */
export function artifactRejectionFrame(code: string, message: string): ArtifactWorkerFrame {
  return {
    type: 'batch', jobId: '', rows: [], cursor: null, complete: false, coverage: 'partial', counts: { visited: 0, eligible: 0, skipped: 0 },
    error: { code: CODE_RE.test(code) ? code : 'invalid-request', message: boundedMessage(message) },
  }
}

// ------------------------------------------------------------------------------------------------------------- filesystem

export type ArtifactDirentType = 'file' | 'directory' | 'symlink' | 'other' | 'unknown'
export type ArtifactDirent = { name: Buffer; type: ArtifactDirentType }
/** `capturedAtMs` (epoch milliseconds) is taken before the lstat call: a lower bound of when the kernel read the file's state. */
export type ArtifactFileStat = { type: 'file' | 'directory' | 'symlink' | 'other'; dev: string; ino: string; size: number; mtimeMs: number; ctimeMs: number; capturedAtMs?: number }

/**
 * The filesystem calls discovery makes: list a directory (raw name bytes, lstat-like entry types), lstat one path (never
 * following a final symlink), and realpath a directory. Errors carry Node's `code`. Tests inject failures through it.
 */
export type ArtifactDiscoveryFs = {
  readdir(dir: string): Promise<ArtifactDirent[]>
  lstat(path: string): Promise<ArtifactFileStat>
  realpath(path: string): Promise<string>
}

function direntType(d: Dirent<Buffer>): ArtifactDirentType {
  if (d.isFile()) return 'file'
  if (d.isDirectory()) return 'directory'
  if (d.isSymbolicLink()) return 'symlink'
  if (d.isFIFO() || d.isSocket() || d.isBlockDevice() || d.isCharacterDevice()) return 'other'
  return 'unknown'
}

const NS_PER_SEC = 1_000_000_000n
/** Milliseconds exactly as Node computes Stats#mtimeMs (seconds * 1e3 + nanoseconds / 1e6), from BigInt stats. */
function msOf(ns: bigint): number {
  let sec = ns / NS_PER_SEC
  let rem = ns % NS_PER_SEC
  if (rem < 0n) { sec -= 1n; rem += NS_PER_SEC }
  return Number(sec) * 1e3 + Number(rem) / 1e6
}

export const nodeArtifactDiscoveryFs: ArtifactDiscoveryFs = Object.freeze({
  async readdir(dir: string): Promise<ArtifactDirent[]> {
    const list = await readdir(dir, { encoding: 'buffer', withFileTypes: true })
    return list.map(d => ({ name: d.name, type: direntType(d) }))
  },
  async lstat(path: string): Promise<ArtifactFileStat> {
    // The clock is read before the call: the state the kernel returns is the file's at or after this instant, never before it.
    const capturedAtMs = Date.now()
    // BigInt stats: device and inode numbers above 2^53 stay exact.
    const s = await lstat(path, { bigint: true })
    const type = s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other'
    return { type, dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeMs: msOf(s.mtimeNs), ctimeMs: msOf(s.ctimeNs), capturedAtMs }
  },
  realpath: (path: string): Promise<string> => realpath(path),
})

function errnoCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** A path-free description of an unexpected error: its class and errno-style code, never its message. */
function errorLabel(e: unknown): string {
  const code = errnoCode(e)
  const name = e instanceof Error ? e.name : typeof e
  return /^[A-Za-z0-9_]{1,40}$/.test(code ?? '') ? `${name} ${code}` : name
}

const isRefusal = (x: ArtifactDocumentIdentity | ArtifactIdentityRefusal): x is ArtifactIdentityRefusal => 'incomplete' in x

// ---------------------------------------------------------------------------------------------------------------- options

export type ArtifactDiscoveryOptions = {
  /** Filesystem layer (default: node:fs/promises). */
  fs?: ArtifactDiscoveryFs
  /** Monotonic milliseconds used only for the slice time budget (default: performance.now). */
  clock?: () => number
  /** Home directory for path authorization (default: os.homedir(), i.e. the HOME the service started the worker with). */
  home?: string
  /** Lowers the cursor bound (tests); never raises it above ARTIFACT_IPC_LIMITS.maxCursorBytes. */
  maxCursorBytes?: number
}

// ---------------------------------------------------------------------------------------------------------------- frames

type FrameError = { code: string; message: string }
type Coverage = ArtifactWorkerFrame['coverage']
type Counts = ArtifactWorkerFrame['counts']

// Room kept in every frame for everything but the rows: the cursor JSON-escaped (my cursors contain no control characters,
// so escaping at most doubles them), job ID, counts, error and keys.
const FRAME_ENVELOPE_RESERVE = 2 * ARTIFACT_IPC_LIMITS.maxCursorBytes + 16 * 1024
const ROW_BUDGET = ARTIFACT_IPC_LIMITS.maxFrameBytes - FRAME_ENVELOPE_RESERVE

/**
 * Accumulates rows into frames of at most `maxRows` rows (the request's limits.maxFrameRows, else the frozen 250) and 1 MiB,
 * whichever bound comes first.
 */
class FrameBuilder {
  readonly jobId: string
  readonly maxRows: number
  /** The cursor covering every row added so far, as of the last checkpoint. */
  checkpoint: string | null
  counts: Counts = { visited: 0, eligible: 0, skipped: 0 }
  private rows: ArtifactWorkerObservation[] = []
  private rowBytes = 0

  constructor(jobId: string, start: string | null, maxRows: number = ARTIFACT_IPC_LIMITS.maxRows) {
    this.jobId = jobId
    this.checkpoint = start
    this.maxRows = Math.min(ARTIFACT_IPC_LIMITS.maxRows, Math.max(1, Math.trunc(maxRows)))
  }

  /** Adds `row`. Returns the data frame to send first when the row does not fit beside the pending rows. */
  add(row: ArtifactWorkerObservation): { frame: ArtifactWorkerFrame | null; oversized: boolean } {
    const bytes = utf8Bytes(JSON.stringify(row)) + 1
    if (bytes > ROW_BUDGET) return { frame: null, oversized: true }
    let frame: ArtifactWorkerFrame | null = null
    if (this.rows.length >= this.maxRows || this.rowBytes + bytes > ROW_BUDGET) frame = this.flush()
    this.rows.push(row)
    this.rowBytes += bytes
    return { frame, oversized: false }
  }

  /** Pending rows as a data frame checkpointed at the current cursor, or null. */
  flush(): ArtifactWorkerFrame | null {
    if (this.rows.length === 0) return null
    const frame: ArtifactWorkerFrame = {
      type: 'batch', jobId: this.jobId, rows: this.rows, cursor: this.checkpoint, complete: false, coverage: 'partial', counts: this.counts,
    }
    this.rows = []
    this.rowBytes = 0
    this.counts = { visited: 0, eligible: 0, skipped: 0 }
    return frame
  }

  /** Pending rows (if any), then the terminal frame. */
  end(t: { cursor: string | null; complete: boolean; coverage: Coverage; error?: FrameError }): ArtifactWorkerFrame[] {
    const data = this.flush()
    const terminal: ArtifactWorkerFrame = {
      type: 'batch', jobId: this.jobId, rows: [], cursor: t.cursor, complete: t.complete, coverage: t.coverage, counts: this.counts,
    }
    if (t.error) terminal.error = { code: t.error.code, message: boundedMessage(t.error.message) }
    this.counts = { visited: 0, eligible: 0, skipped: 0 }
    return data ? [data, terminal] : [terminal]
  }
}

/**
 * Active time of a slice's per-entry work. Time spent suspended at a yield (waiting for the service) is excluded, and so is
 * the fixed setup before the first entry: `startWork()` restarts the clock once checkout resolution and the Git snapshot
 * (status, ls-files, cat-file) are done. Those Git processes are bounded by their own `gitTimeoutMs`; they never shrink how
 * many entries a slice may process.
 */
class SliceClock {
  private readonly now: () => number
  private started: number
  private suspendedAt: number | null = null
  private suspended = 0

  constructor(now: () => number) {
    this.now = now
    this.started = now()
  }

  startWork(): void {
    this.started = this.now()
    this.suspended = 0
    this.suspendedAt = null
  }

  elapsed(): number {
    const pending = this.suspendedAt === null ? 0 : this.now() - this.suspendedAt
    return this.now() - this.started - this.suspended - pending
  }
  suspend(): void { this.suspendedAt = this.now() }
  resume(): void {
    if (this.suspendedAt !== null) this.suspended += Math.max(0, this.now() - this.suspendedAt)
    this.suspendedAt = null
  }
}

// ---------------------------------------------------------------------------------------------------------------- cursors

type CursorTask = 'output-walk' | 'checkout-status' | 'git-history'
/**
 * t: task; r: root ID; o: includeOlder of the pass; g: sticky gap codes; p: position (base64 raw bytes); lb: history lookback;
 * s: when the pass started (epoch ms; output-walk only, DEFECT-4).
 */
type CursorHeader = { t: CursorTask; r: string; o: boolean; g: string[]; p: string[]; lb: boolean; s?: number }
type DecodedCursor = { header: CursorHeader; payload: string }

const CURSOR_PREFIX = 'adw1:'
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_CURSOR_SEGMENTS = MAX_ARTIFACT_PATH_CHARS / 2

// Layout: adw1:<header length>:<header JSON><payload>. The payload (the Task 4 history cursor) is kept verbatim, not
// re-escaped, so a 60 KiB history cursor still fits.
function encodeCursor(h: CursorHeader, payload: string): string {
  const json = JSON.stringify(h)
  return `${CURSOR_PREFIX}${json.length}:${json}${payload}`
}

function decodeCursor(cursor: string, task: CursorTask, rootId: string): DecodedCursor | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null
  const colon = cursor.indexOf(':', CURSOR_PREFIX.length)
  const lenText = colon < 0 ? '' : cursor.slice(CURSOR_PREFIX.length, colon)
  if (!/^\d{1,6}$/.test(lenText)) return null
  const len = Number(lenText)
  const json = cursor.slice(colon + 1, colon + 1 + len)
  if (json.length !== len) return null
  let h: unknown
  try { h = JSON.parse(json) } catch { return null }
  if (!isObj(h) || !onlyKeys(h, ['t', 'r', 'o', 'g', 'p', 'lb', 's']) || h.t !== task || h.r !== rootId || typeof h.o !== 'boolean' || typeof h.lb !== 'boolean') return null
  if (h.s !== undefined && !(Number.isSafeInteger(h.s) && (h.s as number) >= 0)) return null
  if (!Array.isArray(h.g) || h.g.length > ARTIFACT_WORKER_GAP_CODES.length || !h.g.every(c => (ARTIFACT_WORKER_GAP_CODES as readonly string[]).includes(c as string))) return null
  if (!Array.isArray(h.p) || h.p.length > MAX_CURSOR_SEGMENTS || !h.p.every(s => typeof s === 'string' && BASE64_RE.test(s))) return null
  const payload = cursor.slice(colon + 1 + len)
  if (task !== 'git-history' && payload !== '') return null
  return { header: h as CursorHeader, payload }
}

// ---------------------------------------------------------------------------------------------------------------- slice

type Stop = { kind: 'stopped'; code: string; message: string; coverage: Coverage }
type Outcome = { kind: 'done' } | { kind: 'paused' } | Stop
const DONE: Outcome = Object.freeze({ kind: 'done' })
const stop = (code: string, message: string, coverage: Coverage = 'partial'): Stop => ({ kind: 'stopped', code, message, coverage })

function discoveryConfig(req: ArtifactWorkerRequest): ArtifactsConfig {
  // Only ignoreSegments is read by the exclusion rules; the rest mirrors the request so nothing comes from process globals.
  return {
    ignoreSegments: [...req.ignoreSegments], sensitivePatterns: [], documentExtensions: req.documentExtensions.map(e => e.toLowerCase()), outputRoots: [],
    durableOutputBase: '', initialLookbackDays: 0, recoveryIntervalMs: 0, statusMinIntervalMs: 0, debounceMs: 0,
    maxEntriesPerSlice: req.limits.maxEntries, maxSliceMs: req.limits.maxMs, maxRowsPerFrame: req.limits.maxFrameRows ?? ARTIFACT_IPC_LIMITS.maxRows, gitTimeoutMs: req.limits.gitTimeoutMs,
    gitMaxOutputBytes: req.limits.gitMaxOutputBytes, hashMaxFileBytes: 0, hashMaxJobBytes: 0, hashMaxJobMs: 0, warnings: [],
  }
}

const basenameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** Identity rule for live files under a root (spec s7; see documentIdentityForPath). */
type IdentityMode = { kind: 'root' } | { kind: 'repository'; repositoryId: string; top: string }

class Slice {
  readonly req: ArtifactWorkerRequest
  readonly root: ArtifactWorkerRoot
  readonly fs: ArtifactDiscoveryFs
  readonly home: string
  readonly clock: SliceClock
  readonly out: FrameBuilder
  readonly maxCursorBytes: number
  readonly sinceMs: number
  readonly extensions: ReadonlySet<string>
  readonly config: ArtifactsConfig
  readonly gitLimits: GitLimits
  readonly gaps = new Set<string>()
  /** Entries first visited in this slice (re-descending along the cursor does not count). */
  newEntries = 0
  ended = false
  /**
   * When the current output-walk pass started (epoch ms, carried in the cursor): a directory whose entries changed at or after
   * it may have lost an entry to the already-walked part of the root (DEFECT-4). null for every other task.
   */
  passStartMs: number | null = null
  private position: { p: string[]; lb: boolean; payload: string } | null = null

  constructor(req: ArtifactWorkerRequest, options: ArtifactDiscoveryOptions) {
    this.req = req
    this.root = req.root
    this.fs = options.fs ?? nodeArtifactDiscoveryFs
    this.home = options.home ?? homedir()
    this.clock = new SliceClock(options.clock ?? (() => performance.now()))
    this.out = new FrameBuilder(req.jobId, req.cursor, req.limits.maxFrameRows ?? ARTIFACT_IPC_LIMITS.maxRows)
    const lowered = options.maxCursorBytes
    this.maxCursorBytes = Number.isSafeInteger(lowered) && lowered! > 0 ? Math.min(lowered!, ARTIFACT_IPC_LIMITS.maxCursorBytes) : ARTIFACT_IPC_LIMITS.maxCursorBytes
    this.sinceMs = req.sinceMs ?? Date.now() - ARTIFACT_DEFAULT_LOOKBACK_MS
    this.extensions = new Set(req.documentExtensions.map(e => e.toLowerCase()))
    this.config = discoveryConfig(req)
    this.gitLimits = { timeoutMs: req.limits.gitTimeoutMs, maxOutputBytes: req.limits.gitMaxOutputBytes }
  }

  visit(): void {
    this.newEntries++
    this.out.counts.visited++
  }
  /** Counts a skipped item; with a gap code the pass also becomes partial. */
  skip(gap?: ArtifactWorkerGapCode): void {
    this.out.counts.skipped++
    if (gap) this.gaps.add(gap)
  }
  gap(code: ArtifactWorkerGapCode): void {
    this.gaps.add(code)
  }
  budgetSpent(): boolean {
    return this.newEntries > 0 && (this.newEntries >= this.req.limits.maxEntries || this.clock.elapsed() >= this.req.limits.maxMs)
  }
  extensionEligible(name: string): boolean {
    return this.extensions.has(classifyPath(name).extension)
  }
  /** R24: eligible by age when includeOlder, or when either the content time or the inode change time is after the cutoff. */
  recent(st: ArtifactFileStat): boolean {
    return this.req.includeOlder || Math.max(st.mtimeMs, st.ctimeMs) >= this.sinceMs
  }

  decode(task: CursorTask): DecodedCursor | null | 'invalid' {
    if (this.req.cursor === null) return null
    const decoded = decodeCursor(this.req.cursor, task, this.root.rootId)
    if (!decoded) return 'invalid'
    for (const g of decoded.header.g) this.gaps.add(g)
    return decoded
  }
  /** Forgets the pass so far (includeOlder switched on mid-pass): the slice starts the pass over. */
  restartPass(): void {
    this.gaps.clear()
  }

  private encode(p: string[], lb: boolean, payload: string): string | null {
    const header: CursorHeader = { t: this.req.task as CursorTask, r: this.root.rootId, o: this.req.includeOlder, g: this.sortedGaps(), p, lb }
    if (this.passStartMs !== null) header.s = this.passStartMs
    const cursor = encodeCursor(header, payload)
    return utf8Bytes(cursor) <= this.maxCursorBytes ? cursor : null
  }
  /** Moves the checkpoint past everything added so far. False when the cursor would break its bound (nothing changes). */
  advance(p: string[], lb = false, payload = ''): boolean {
    const cursor = this.encode(p, lb, payload)
    if (cursor === null) return false
    this.position = { p, lb, payload }
    this.out.checkpoint = cursor
    return true
  }
  /** The cursor for an unfinished pass's terminal frame: the latest position with every gap recorded so far. */
  resumeCursor(): string | null {
    if (!this.position) return this.out.checkpoint
    return this.encode(this.position.p, this.position.lb, this.position.payload) ?? this.out.checkpoint
  }

  sortedGaps(): string[] {
    return ARTIFACT_WORKER_GAP_CODES.filter(c => this.gaps.has(c))
  }
  gapError(detail: string[] = []): FrameError | undefined {
    const list = this.sortedGaps()
    if (list.length === 0) return undefined
    const tokens = detail.filter(t => GIT_TOKEN_RE.test(t))
    return { code: list[0]!, message: `coverage gaps: ${list.join(', ')}${tokens.length > 0 ? `; git history: ${tokens.join(', ')}` : ''}` }
  }

  async *emit(frame: ArtifactWorkerFrame | null): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
    if (!frame) return
    this.clock.suspend()
    try {
      yield frame
    } finally {
      this.clock.resume()
    }
  }

  async *addRow(row: ArtifactWorkerObservation): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
    const added = this.out.add(row)
    if (added.oversized) { this.skip('oversized-record'); return }
    yield* this.emit(added.frame)
    this.out.counts.eligible++
  }

  async *end(t: { cursor: string | null; complete: boolean; coverage: Coverage; error?: FrameError }): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
    if (this.ended) return
    this.ended = true
    for (const frame of this.out.end(t)) yield* this.emit(frame)
  }

  /** Ends the slice without finishing the pass. Rows already produced are still sent, checkpointed at the last good cursor. */
  async *fail(code: string, message: string, coverage: Coverage = 'partial', cursor: string | null = this.out.checkpoint): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
    yield* this.end({ cursor, complete: false, coverage, error: { code, message } })
  }

  /** Ends an unfinished pass at a slice boundary. */
  async *pause(): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
    yield* this.end({ cursor: this.resumeCursor(), complete: false, coverage: 'partial', error: this.gapError() })
  }

  /** Ends a walked-to-the-end pass: complete only without gaps. */
  async *finish(cursor: string | null = null, detail: string[] = [], extraIncomplete = false): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
    const clean = this.gaps.size === 0 && !extraIncomplete
    yield* this.end({ cursor, complete: true, coverage: clean ? 'complete' : 'partial', error: this.gapError(detail) })
  }

  /** The registered root still resolves to itself, under home, outside excluded locations. */
  rootProblem(): Stop | null {
    const c = canonicalizeArtifactRoot(this.root.canonicalPath, this.home)
    if ('error' in c) return stop('root-invalid', `root refused: ${c.error}`, 'inaccessible')
    if (!c.exists) return stop('root-missing', 'the root directory does not exist', 'inaccessible')
    if (c.canonicalPath !== this.root.canonicalPath) return stop('root-moved', 'the root no longer resolves to its registered path', 'inaccessible')
    return null
  }

  /**
   * How live files under this root are identified (spec s4/s7, ruling R27), for walks and direct observations alike:
   *  - a `checkout` root: repository identity, Git path relative to the root (the root is its work tree's top level);
   *  - an `output` or `session-directory` root: repository identity ONLY when the request carries BOTH `repositoryId` and
   *    `checkoutIdentity` (the service asserting that the root lies inside that checkout) AND Git resolves a work tree
   *    around the root; the Git path is relative to that work tree. Otherwise root identity.
   * A `repositoryId` without a `checkoutIdentity` is a project association: it never yields a repository identity, even
   * when the root happens to sit inside some unrelated work tree (a dotfiles repository at home, a nested repository, a
   * submodule). The service (Task 7) must therefore set both fields on an output or session root it registers inside a
   * checkout, taking them from resolveGitCheckout of THAT root (the innermost work tree), and recompute identities by the
   * same rule.
   */
  async identityMode(): Promise<IdentityMode | Stop> {
    const repositoryId = this.root.repositoryId
    if (repositoryId === null) return { kind: 'root' }
    if (this.root.kind === 'checkout') return { kind: 'repository', repositoryId, top: this.root.canonicalPath }
    if (this.root.checkoutIdentity === null) return { kind: 'root' }
    let checkout: GitCheckout | null
    try {
      checkout = await resolveGitCheckout(this.root.canonicalPath)
    } catch (e) {
      return stop(gitAdapterCode(e), 'could not resolve the Git checkout around the root')
    }
    if (!checkout) return { kind: 'root' }
    const top = checkout.worktreePath
    if (this.root.canonicalPath !== top && !this.root.canonicalPath.startsWith(`${top}/`)) return stop('checkout-mismatch', 'the root is not inside its reported work tree')
    return { kind: 'repository', repositoryId, top }
  }

  identityFor(mode: IdentityMode, path: string): ArtifactDocumentIdentity | ArtifactIdentityRefusal {
    if (mode.kind === 'root') return documentIdentityForPath(path, this.root, null)
    return documentIdentityForPath(path, this.root, { repositoryId: mode.repositoryId, gitPath: path.slice(mode.top.length + 1) })
  }

  workingRow(path: string, st: ArtifactFileStat, identity: ArtifactDocumentIdentity): ArtifactWorkerObservation {
    return {
      rootId: this.root.rootId, identity, kind: 'working', observedAt: new Date().toISOString(),
      // The lstat happened before the identity and Git lookups that precede this row: say when, so the service can tell which
      // events had already been reported when the file was read (PR #19 review, P2-4).
      ...(st.capturedAtMs !== undefined && Number.isFinite(st.capturedAtMs) ? { capturedAt: new Date(st.capturedAtMs).toISOString() } : {}), path,
      stat: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
    }
  }

  /** Resolves the checkout a checkout-status or git-history task runs in: exactly the root, which must be its top level. */
  async checkout(): Promise<GitCheckout | Stop> {
    let checkout: GitCheckout | null
    try {
      checkout = await resolveGitCheckout(this.root.canonicalPath)
    } catch (e) {
      return stop(gitAdapterCode(e), 'could not resolve the Git checkout')
    }
    if (!checkout) return stop('not-a-checkout', 'the root is not a Git work tree', 'inaccessible')
    if (checkout.worktreePath !== this.root.canonicalPath) return stop('checkout-mismatch', 'the root is not the top level of its work tree')
    return checkout
  }
}

function gitAdapterCode(e: unknown): string {
  const code = e instanceof GitAdapterError ? `git-${e.code}` : 'git-failed'
  return CODE_RE.test(code) ? code : 'git-failed'
}

const isDirectOnly = (root: ArtifactWorkerRoot): boolean => !root.scopeFlags.some(f => SCAN_FLAGS.has(f))

// ---------------------------------------------------------------------------------------------------------------- entry point

/**
 * Runs one bounded slice of `request` and yields its frames (see the protocol at the top of this file). The caller must not
 * pull the next frame before the service has acknowledged the previous one; the generator does no work while suspended.
 * Never throws for a bad request or filesystem/Git failure: those end the slice with an error frame.
 */
export async function* discoverArtifactSlice(request: ArtifactWorkerRequest, options: ArtifactDiscoveryOptions = {}): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
  const problem = validateArtifactWorkerRequest(request)
  if (problem !== null) {
    const raw = request as unknown
    const jobId = isObj(raw) && isId(raw.jobId) ? raw.jobId : ''
    const cursor = isObj(raw) && typeof raw.cursor === 'string' && utf8Bytes(raw.cursor) <= ARTIFACT_IPC_LIMITS.maxCursorBytes ? raw.cursor : null
    const frame = artifactRejectionFrame('invalid-request', `invalid request field: ${problem}`)
    yield { ...frame, jobId, cursor }
    return
  }
  const slice = new Slice(request, options)
  if (request.task !== 'direct-observation' && isDirectOnly(request.root)) {
    yield* slice.fail('direct-only-root', 'a direct-only root is never bulk-scanned')
    return
  }
  try {
    switch (request.task) {
      case 'direct-observation':
        yield* directObservation(slice, request.path!)
        return
      case 'verify':
        if (request.path !== undefined) yield* directObservation(slice, request.path)
        else yield* slice.fail('unsupported-task', 'verify checks one exact path')
        return
      case 'legacy-backfill':
        yield* slice.fail('unsupported-task', 'legacy backfill runs in the service, not the worker')
        return
      case 'output-walk':
        yield* outputWalk(slice)
        return
      case 'checkout-status':
        yield* checkoutStatus(slice)
        return
      case 'git-history':
        yield* gitHistory(slice)
        return
    }
  } catch (e) {
    // Unexpected failure: rows already produced keep their checkpoint; nothing is claimed past it.
    yield* slice.fail('internal-error', `unexpected ${errorLabel(e)}`)
  }
}

// ---------------------------------------------------------------------------------------------------------- direct observation

/** Exactly one file: authorized by the path policy, lstat'ed, never traversed. Age and extension do not apply. */
async function* directObservation(s: Slice, path: string): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
  s.visit()
  const auth = authorizeArtifactPath(path, [s.root], s.home)
  if (!auth.allowed || auth.canonicalPath === null) {
    const reason = auth.reason ?? 'denied'
    if (reason === 'file-symlink' || reason === 'not-regular-file') {
      s.skip()
      yield* s.end({ cursor: null, complete: true, coverage: 'complete', error: { code: 'not-regular-file', message: reason } })
    } else if (reason === 'inaccessible') {
      yield* s.fail('path-inaccessible', reason, 'inaccessible', null)
    } else {
      s.skip()
      yield* s.end({ cursor: null, complete: true, coverage: 'partial', error: { code: 'path-denied', message: reason } })
    }
    return
  }
  const canonical = auth.canonicalPath
  let st: ArtifactFileStat
  try {
    st = await s.fs.lstat(canonical)
  } catch (e) {
    const code = errnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      yield* s.end({ cursor: null, complete: true, coverage: 'complete', error: { code: 'path-missing', message: code } })
    } else {
      yield* s.fail('path-inaccessible', errorLabel(e), 'inaccessible', null)
    }
    return
  }
  if (st.type !== 'file') {
    s.skip()
    yield* s.end({ cursor: null, complete: true, coverage: 'complete', error: { code: 'not-regular-file', message: st.type } })
    return
  }
  const mode = await s.identityMode()
  if (mode.kind === 'stopped') { yield* s.fail(mode.code, mode.message, mode.coverage, null); return }
  const identity = s.identityFor(mode, canonical)
  if (isRefusal(identity)) {
    s.skip('unsupported-path')
    yield* s.finish(null)
    return
  }
  yield* s.addRow(s.workingRow(canonical, st, identity))
  yield* s.finish(null)
}

// ---------------------------------------------------------------------------------------------------------- output-walk

const DOT_GIT = Buffer.from('.git')

/**
 * DEFECT-1 (ruling R66). Under repository identity, a tracked file that Git finds clean against its index is not an output:
 * it is Git's (its versions come from history import, within the lookback or through "Import older files"), and its fresh
 * mtime after a new worktree, pull, hard reset or branch switch is checkout noise. One `ls-files -v --cached --modified -z`
 * for the root's eligible documents per slice, taken when the slice first meets an eligible file, is Git's own index
 * comparison (full stat, whatever the user's core.checkStat/trustctime: I4): stat data first, then the contents of every
 * entry whose stat differs or is racily clean (mtime not older than the index), with
 * assume-unchanged (lowercase), skip-worktree (`S`), unmerged (`M`) and intent-to-add (`H` + `C`) entries never clean. A file
 * is clean only with exactly one `H` record and no other, and only if it has not changed since Git looked (its ctime, which
 * only the kernel sets, is older than the snapshot). Everything else is emitted exactly as before. Nothing is kept between
 * slices; the cursor holds only the walk position.
 */
type TrackedClean = { kind: 'ready'; startedAtMs: number; clean: Set<string> } | { kind: 'unresolved'; gap: ArtifactWorkerGapCode }

type Walk = { mode: IdentityMode; tracked?: TrackedClean | Stop }

/** File timestamps come from the kernel's coarse clock, which can lag the wall clock by a scheduler tick. */
const COARSE_CLOCK_LAG_MS = 10

const b64 = (b: Buffer): string => b.toString('base64')

/**
 * output-walk: the registered root only, independent of Git ignore rules (ignored output is eligible), never following a
 * directory symlink, metadata first, eligible documents only (extension, then age by max(mtime, ctime)).
 */
async function* outputWalk(s: Slice): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
  const decoded = s.decode('output-walk')
  if (decoded === 'invalid') {
    yield* s.fail('invalid-cursor', 'the cursor does not belong to this walk; the pass restarts', 'partial', null)
    return
  }
  let resume: Buffer[] | null = decoded ? decoded.header.p.map(p => Buffer.from(p, 'base64')) : null
  let restarted = false
  if (decoded && s.req.includeOlder && !decoded.header.o) { resume = null; s.restartPass(); restarted = true }
  if (resume && resume.length === 0) resume = null
  const rootIssue = s.rootProblem()
  if (rootIssue) { yield* s.fail(rootIssue.code, rootIssue.message, rootIssue.coverage); return }
  const mode = await s.identityMode()
  if (mode.kind === 'stopped') { yield* s.fail(mode.code, mode.message, mode.coverage); return }
  s.clock.startWork()
  // A resumed pass keeps the start time its first slice recorded; a cursor written before the start time was recorded
  // proves nothing about changes during its pass (0: every directory counts as changed, so that pass ends partial).
  s.passStartMs = decoded && !restarted ? (decoded.header.s ?? 0) : Date.now()
  const outcome = yield* walkDirectory(s, { mode }, s.root.canonicalPath, [], resume)
  if (outcome.kind === 'stopped') yield* s.fail(outcome.code, outcome.message, outcome.coverage)
  else if (outcome.kind === 'paused') yield* s.pause()
  else yield* s.finish(null)
}

function walkAdvance(s: Slice, position: Buffer[]): Outcome {
  return s.advance(position.map(b64)) ? DONE : stop('cursor-limit', 'the traversal cursor would exceed its bound')
}

async function* walkDirectory(s: Slice, w: Walk, dir: string, rel: Buffer[], resume: Buffer[] | null): AsyncGenerator<ArtifactWorkerFrame, Outcome, undefined> {
  const isRoot = rel.length === 0
  let listing: ArtifactDirent[]
  try {
    listing = await s.fs.readdir(dir)
    // Every component of `dir` was seen as a real directory when it was entered; a symlink swapped in since then would make
    // the listing come from somewhere else. The real path must still be the path walked.
    if ((await s.fs.realpath(dir)) !== dir) throw Object.assign(new Error('moved'), { code: 'ATLAS_PATH_CHANGED' })
  } catch (e) {
    const code = errnoCode(e)
    if (isRoot) {
      if (code === 'ENOENT' || code === 'ENOTDIR') return stop('root-missing', 'the root directory does not exist', 'inaccessible')
      if (code === 'ATLAS_PATH_CHANGED') return stop('root-moved', 'the root no longer resolves to its registered path', 'inaccessible')
      return stop('root-inaccessible', `the root cannot be listed: ${errorLabel(e)}`, 'inaccessible')
    }
    // Gone since it was listed: removed, or moved, possibly into the part of the root already walked (DEFECT-4).
    if (code === 'ENOENT' || code === 'ENOTDIR') { s.gap('path-changed'); return DONE }
    s.skip(code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : code === 'ATLAS_PATH_CHANGED' ? 'path-changed' : 'unreadable-entry')
    return DONE
  }
  if (!isRoot && w.mode.kind === 'repository' && listing.some(e => e.name.equals(DOT_GIT))) {
    // A nested checkout's files belong to another repository whose ID the worker does not know.
    s.skip('nested-checkout')
    return DONE
  }
  listing.sort((a, b) => Buffer.compare(a.name, b.name))
  let pending = resume
  for (const entry of listing) {
    if (pending) {
      const order = Buffer.compare(entry.name, pending[0]!)
      if (order < 0) continue
      if (order === 0) {
        const outcome = yield* reenter(s, w, dir, rel, entry, pending.length > 1 ? pending.slice(1) : null)
        pending = null
        if (outcome.kind !== 'done') return outcome
        continue
      }
      pending = null
    }
    if (s.budgetSpent()) return { kind: 'paused' }
    const outcome = yield* visitEntry(s, w, dir, rel, entry)
    if (outcome.kind !== 'done') return outcome
  }
  await checkWalkedDirectory(s, dir)
  return DONE
}

/** Timestamp truncation a directory's times may carry (m5): HFS+ 1 s and FAT 2 s; exFAT 10 ms, the coarsest sub-second one. */
const COARSE_TIMESTAMP_GRANULARITY_MS = 2000
const FINE_TIMESTAMP_GRANULARITY_MS = 10

/**
 * DEFECT-4. A folder (or file) that moves, during a pass, from a part of the root not yet walked into a part already walked
 * is never seen by that pass. The move changes its SOURCE directory, which this pass still walks to the end afterwards
 * (an unwalked directory later in the pass; a directory on the cursor path is listed again by every resumed slice), so:
 *  - an entry listed but gone when the walk reaches it is `path-changed` (walkDirectory, reenter, entryFailure);
 *  - once a directory's listing has been fully walked, its own lstat must show no change (mtime, ctime) since the pass
 *    started, else `path-changed`: this also catches an entry that left before the directory was listed.
 * The pass is then partial, never complete; the next pass, a fresh generation, walks the moved entries. Cost: one lstat per
 * walked directory per pass (again for a directory a resumed slice re-enters) and one number (the pass start) in the cursor;
 * nothing is remembered per directory. A change just after the pass start can carry an earlier time (m5): the kernel's coarse
 * clock lags by up to a tick, and a filesystem truncates to its granularity (exFAT 10 ms, HFS+ 1 s, FAT 2 s). So times that far
 * before the start count as changes too, erring toward `path-changed`: a directory changed in the ~20 ms (~2 s where its times
 * have no sub-second part) before a pass makes that one pass partial; the next pass of a quiet root completes.
 */
async function checkWalkedDirectory(s: Slice, dir: string): Promise<void> {
  if (s.passStartMs === null) return
  let st: ArtifactFileStat
  try {
    st = await s.fs.lstat(dir)
  } catch (e) {
    const code = errnoCode(e)
    s.gap(code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : code === 'ENOENT' || code === 'ENOTDIR' ? 'path-changed' : 'unreadable-entry')
    return
  }
  // Whole-second times: taken as a 1-2 s filesystem (a fine one with a whole-second time, e.g. from an archive, only widens it).
  const granularity = st.mtimeMs % 1000 === 0 || st.ctimeMs % 1000 === 0 ? COARSE_TIMESTAMP_GRANULARITY_MS : FINE_TIMESTAMP_GRANULARITY_MS
  if (st.type !== 'directory' || Math.max(st.mtimeMs, st.ctimeMs) >= s.passStartMs - granularity - COARSE_CLOCK_LAG_MS) s.gap('path-changed')
}

/** The cursor's own entry (already visited): descend again only when it is a directory still on the walk. */
async function* reenter(s: Slice, w: Walk, dir: string, rel: Buffer[], entry: ArtifactDirent, rest: Buffer[] | null): AsyncGenerator<ArtifactWorkerFrame, Outcome, undefined> {
  const name = decodeGitPath(entry.name)
  if (name === null) return DONE
  const path = `${dir}/${name}`
  if (path.length > MAX_ARTIFACT_PATH_CHARS || isPassiveDiscoveryExcluded(path, s.config, s.root)) return DONE
  let type = entry.type
  if (type === 'unknown') {
    try {
      type = (await s.fs.lstat(path)).type
    } catch (e) {
      // Whatever the cursor had not reached below this entry is now unreachable: a counted gap, as for any unreadable
      // entry. A vanished entry may have moved into the part already walked (DEFECT-4): the pass is not complete either.
      // The position stays where it is; the walk continues after it.
      const code = errnoCode(e)
      if (code === 'ENOENT' || code === 'ENOTDIR') s.gap('path-changed')
      else s.skip(code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'unreadable-entry')
      return DONE
    }
  }
  if (type !== 'directory') return DONE
  return yield* walkDirectory(s, w, path, [...rel, entry.name], rest)
}

async function hasEntries(s: Slice, path: string): Promise<boolean> {
  try {
    return (await s.fs.readdir(path)).length > 0
  } catch {
    return true // cannot tell: assume something is hidden
  }
}

async function* visitEntry(s: Slice, w: Walk, dir: string, rel: Buffer[], entry: ArtifactDirent): AsyncGenerator<ArtifactWorkerFrame, Outcome, undefined> {
  s.visit()
  const position = [...rel, entry.name]
  const name = decodeGitPath(entry.name)
  if (name === null) { s.skip('unsupported-path'); return walkAdvance(s, position) }
  const path = `${dir}/${name}`
  if (path.length > MAX_ARTIFACT_PATH_CHARS) { s.skip('unsupported-path'); return walkAdvance(s, position) }
  if (isPassiveDiscoveryExcluded(path, s.config, s.root)) {
    // A linked worktree under .claude/worktrees is its own root; skipping it is a coverage gap unless it is empty.
    const nestedWorktree = name === 'worktrees' && basenameOf(dir) === '.claude' && entry.type !== 'file' && entry.type !== 'symlink' && (await hasEntries(s, path))
    s.skip(nestedWorktree ? 'nested-worktree' : undefined)
    return walkAdvance(s, position)
  }
  let type = entry.type
  if (type === 'unknown') {
    try {
      type = (await s.fs.lstat(path)).type
    } catch (e) {
      return entryFailure(s, e, position)
    }
  }
  if (type === 'symlink' || type === 'other') { s.skip(); return walkAdvance(s, position) }
  if (type === 'directory') {
    const advanced = walkAdvance(s, position)
    if (advanced.kind !== 'done') return advanced
    return yield* walkDirectory(s, w, path, position, null)
  }
  if (!s.extensionEligible(name)) return walkAdvance(s, position)
  let st: ArtifactFileStat
  try {
    st = await s.fs.lstat(path)
  } catch (e) {
    return entryFailure(s, e, position)
  }
  if (st.type !== 'file') { s.skip(); return walkAdvance(s, position) } // replaced since it was listed
  if (w.mode.kind === 'repository') {
    const mode = w.mode
    w.tracked ??= await withClockSuspended(s, () => trackedCleanSnapshot(s, mode))
    const tracked = w.tracked
    if (tracked.kind === 'stopped') return tracked
    // Git could not classify the files below the root: none is claimed as new (no row) and the pass is not complete.
    if (tracked.kind === 'unresolved') { s.skip(tracked.gap); return walkAdvance(s, position) }
    if (tracked.clean.has(path.slice(mode.top.length + 1)) && st.ctimeMs < tracked.startedAtMs - COARSE_CLOCK_LAG_MS) { s.skip(); return walkAdvance(s, position) }
  }
  // DEFECT-2 (R67): an eligible file left out by the lookback is a visible gap, never a silent skip.
  if (!s.recent(st)) { s.gap('lookback-limited'); return walkAdvance(s, position) }
  const identity = s.identityFor(w.mode, path)
  if (isRefusal(identity)) { s.skip('unsupported-path'); return walkAdvance(s, position) }
  yield* s.addRow(s.workingRow(path, st, identity))
  return walkAdvance(s, position)
}

/** Runs `fn` with the slice clock stopped: a Git process is bounded by its own timeout, never by the per-entry budget. */
async function withClockSuspended<T>(s: Slice, fn: () => Promise<T>): Promise<T> {
  s.clock.suspend()
  try {
    return await fn()
  } finally {
    s.clock.resume()
  }
}

/**
 * The tracked files below a repository-identity root that Git finds clean (see TrackedClean). A capped or timed-out answer
 * cannot tell clean files from new ones: `git-status-truncated`; output that does not parse: `git-malformed-output`. Any other
 * Git failure ends the slice for a retry (nothing consumed), as every other Git failure of a walk does.
 */
async function trackedCleanSnapshot(s: Slice, mode: Extract<IdentityMode, { kind: 'repository' }>): Promise<TrackedClean | Stop> {
  const top = mode.top
  const startedAtMs = Date.now()
  // Eligible documents only (m1): a folder's other tracked files never push the listing over the output cap.
  const r = await listTrackedDocumentStates(top, s.root.canonicalPath === top ? '' : s.root.canonicalPath.slice(top.length + 1), [...s.extensions], s.gitLimits)
  if (r.error === 'output-cap' || r.error === 'timeout') return { kind: 'unresolved', gap: 'git-status-truncated' }
  if (r.error !== null) return stop(`git-${r.error}`, 'reading the index below the root failed; nothing was consumed')
  const parsed = parseLsFilesTagsZ(r.stdout)
  if (parsed.malformed) return { kind: 'unresolved', gap: 'git-malformed-output' }
  const tags = new Map<string, string>()
  // A name that is not lossless UTF-8 never matches a walked path (the walk skips such names as unsupported).
  for (const e of parsed.entries) if (e.path !== null) tags.set(e.path, (tags.get(e.path) ?? '') + e.tag)
  const clean = new Set<string>()
  for (const [path, t] of tags) if (t === 'H') clean.add(path)
  return { kind: 'ready', startedAtMs, clean }
}

function entryFailure(s: Slice, e: unknown, position: Buffer[]): Outcome {
  const code = errnoCode(e)
  // A listed entry gone before it was inspected was removed or moved, perhaps behind the cursor (DEFECT-4).
  if (code === 'ENOENT' || code === 'ENOTDIR') s.gap('path-changed')
  else s.skip(code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'unreadable-entry')
  return walkAdvance(s, position)
}

// ---------------------------------------------------------------------------------------------------------- checkout-status

const ARGV_CHUNK_BYTES = 64 * 1024
const BATCH_INPUT_CHUNK_BYTES = 4 * 1024 * 1024
const GITLINK = 0o160000
const FILE_TYPE_MASK = 0o170000
const REGULAR_BLOB = 0o100000

type IndexMetadata = { index: Map<string, GitIndexEntry[]>; sizes: Map<string, number> }

function* chunksBy(items: string[], maxBytes: number, extra: number): Generator<string[]> {
  let group: string[] = []
  let size = 0
  for (const item of items) {
    const bytes = utf8Bytes(item) + extra
    if (group.length > 0 && size + bytes > maxBytes) { yield group; group = []; size = 0 }
    group.push(item)
    size += bytes
  }
  if (group.length > 0) yield group
}

/** Blob, mode and stage of `paths` (one ls-files per 64 KiB of arguments) and their sizes (one cat-file --batch-check). */
async function indexMetadata(s: Slice, checkout: GitCheckout, paths: string[]): Promise<IndexMetadata | Stop> {
  const index = new Map<string, GitIndexEntry[]>()
  const sizes = new Map<string, number>()
  if (paths.length === 0) return { index, sizes }
  const wanted = new Set(paths)
  for (const group of chunksBy(paths, ARGV_CHUNK_BYTES, 1)) {
    const r = await runArtifactGit(checkout.worktreePath, ['ls-files', '-s', '-z', '--', ...group], s.gitLimits)
    if (r.error !== null) return stop(`git-${r.error}`, 'reading staged entries failed; nothing was consumed')
    // Staged blobs are Git's own record: a filter driver changes nothing about them (the pass-level check is in checkoutStatus).
    const parsed = parseLsFilesStageZ(r.stdout, checkout.objectFormat)
    if (parsed.some(e => e.malformed)) return stop('git-malformed-output', 'staged entries did not parse; nothing was consumed')
    for (const e of parsed) {
      if (e.path === null || !wanted.has(e.path) || e.mode === null || e.oid === null || e.stage === null) continue
      if ((e.mode & FILE_TYPE_MASK) === GITLINK) continue
      const list = index.get(e.path) ?? []
      list.push(e)
      index.set(e.path, list)
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.stage! - b.stage!)
  const oids = [...new Set([...index.values()].flat().map(e => e.oid!))]
  for (const group of chunksBy(oids, BATCH_INPUT_CHUNK_BYTES, 1)) {
    const check = await runArtifactGit(checkout.worktreePath, ['cat-file', '--batch-check'], s.gitLimits, { input: Buffer.from(group.map(o => `${o}\n`).join('')) })
    if (check.error !== null) return stop(`git-${check.error}`, 'reading blob sizes failed; nothing was consumed')
    const parsed = parseBatchCheck(check.stdout, checkout.objectFormat)
    if (parsed.malformed) return stop('git-malformed-output', 'blob sizes did not parse; nothing was consumed')
    group.forEach((oid, i) => {
      const rec = parsed.records[i]
      if (rec && rec.name === oid && rec.state === 'present' && rec.type === 'blob') sizes.set(oid, rec.size)
    })
  }
  return { index, sizes }
}

function underNestedWorktree(rootPath: string, gitPath: string): boolean {
  const segs = gitPath.split('/')
  if (basenameOf(rootPath) === '.claude' && segs[0] === 'worktrees') return true
  return segs.some((seg, i) => seg === '.claude' && segs[i + 1] === 'worktrees')
}

/**
 * checkout-status: `git status --porcelain=v1 --untracked-files=all -z`, entries in Git-path byte order. Each present,
 * eligible changed or untracked file becomes a `working` observation (lstat; no Git identity, no evidence); each staged or
 * conflicted entry becomes one `index` observation per stage with blob, mode, size and stage and no filesystem stat. Deleted
 * files are not observations (the service verifies existence); clean tracked files never appear (checkout noise).
 */
async function* checkoutStatus(s: Slice): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
  const root = s.root
  if (root.kind !== 'checkout' || root.repositoryId === null || root.checkoutIdentity === null) {
    yield* s.fail('unsupported-task', 'checkout-status needs a checkout root with repository and checkout identity')
    return
  }
  const repositoryId = root.repositoryId
  const checkoutIdentity = root.checkoutIdentity
  const decoded = s.decode('checkout-status')
  if (decoded === 'invalid') { yield* s.fail('invalid-cursor', 'the cursor does not belong to this status pass; the pass restarts', 'partial', null); return }
  let after: Buffer | null = decoded && decoded.header.p[0] !== undefined ? Buffer.from(decoded.header.p[0], 'base64') : null
  if (decoded && s.req.includeOlder && !decoded.header.o) { after = null; s.restartPass() }
  const rootIssue = s.rootProblem()
  if (rootIssue) { yield* s.fail(rootIssue.code, rootIssue.message, rootIssue.coverage); return }
  const checkout = await s.checkout()
  if ('kind' in checkout) { yield* s.fail(checkout.code, checkout.message, checkout.coverage); return }

  const status = await runArtifactGit(checkout.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], s.gitLimits)
  let truncated = false
  if (status.error !== null) {
    // A cap or timeout keeps the records parsed before the cut, but the inventory is incomplete. Anything else: retry later.
    if ((status.error === 'output-cap' || status.error === 'timeout') && status.stdout.length > 0) truncated = true
    else { yield* s.fail(`git-${status.error}`, 'git status failed; nothing was consumed'); return }
  }
  const parsed = parsePorcelainV1Z(status.stdout)
  if (truncated) s.gap('git-status-truncated')
  else if (parsed.some(e => e.kind === 'malformed')) s.gap('git-malformed-output')
  const entries = parsed.filter(e => e.kind !== 'malformed' && e.kind !== 'ignored').sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes))
  let start = 0
  if (after) while (start < entries.length && Buffer.compare(entries[start]!.pathBytes, after) <= 0) start++
  const remaining = entries.slice(start)
  const chunk = remaining.slice(0, s.req.limits.maxEntries)

  const stagedPaths = chunk.filter(e => e.path !== null && !e.path.endsWith('/') && (e.conflict || (e.staged && e.x !== 'D'))
    && s.extensionEligible(basenameOf(e.path))).map(e => e.path!)
  const meta = await indexMetadata(s, checkout, stagedPaths)
  if ('kind' in meta) { yield* s.fail(meta.code, meta.message, meta.coverage); return }

  // The snapshot is taken: only the per-entry work below counts against maxMs (up to maxEntries parsed entries per slice).
  s.clock.startWork()
  let processed = 0
  for (const entry of chunk) {
    if (s.budgetSpent()) break
    const outcome = yield* statusEntry(s, checkout, entry, meta, repositoryId, checkoutIdentity)
    processed++
    if (outcome.kind === 'stopped') { yield* s.fail(outcome.code, outcome.message, outcome.coverage); return }
  }
  if (processed !== remaining.length) { yield* s.pause(); return }
  // A configured filter driver (its commands were suppressed) makes Git's "clean" something other than byte equivalence only
  // for the paths it applies to. The inventory is complete unless one applies to a tracked document the pass covers, or
  // that cannot be established (DEFECT-6: a driver merely configured, git-lfs in a user's gitconfig, changes nothing).
  if (status.filterState === 'unresolved' && (await filterAppliesToDocuments(s, checkout.worktreePath))) s.gap('git-filter-unresolved')
  yield* s.finish(null)
}

/** True when a configured filter driver applies to a tracked eligible document below the root, or when that is unknown. */
async function filterAppliesToDocuments(s: Slice, top: string): Promise<boolean> {
  const prefix = top === s.root.canonicalPath ? '' : `${s.root.canonicalPath.slice(top.length + 1)}/`
  const filters = await resolveTrackedDocumentFilters(top, [...s.extensions], s.gitLimits, prefix.slice(0, -1))
  if (filters.state === 'unresolved') return true
  for (const gitPath of filters.filtered) {
    const path = `${top}/${gitPath}`
    if (gitPath.startsWith(prefix) && s.extensionEligible(basenameOf(gitPath)) && !isPassiveDiscoveryExcluded(path, s.config, s.root)) return true
  }
  return false
}

async function* statusEntry(s: Slice, checkout: GitCheckout, entry: GitStatusEntry, meta: IndexMetadata, repositoryId: string, checkoutIdentity: string): AsyncGenerator<ArtifactWorkerFrame, Outcome, undefined> {
  s.visit()
  const advance = (): Outcome => (s.advance([b64(entry.pathBytes)]) ? DONE : stop('cursor-limit', 'the status cursor would exceed its bound'))
  const gitPath = entry.path
  if (gitPath === null) { s.skip('unsupported-path'); return advance() }
  if (gitPath.endsWith('/')) {
    // An untracked directory with -uall: a nested repository or linked worktree Git does not descend into.
    s.skip(underNestedWorktree(s.root.canonicalPath, gitPath) ? 'nested-worktree' : 'nested-checkout')
    return advance()
  }
  const path = `${checkout.worktreePath}/${gitPath}`
  if (path.length > MAX_ARTIFACT_PATH_CHARS) { s.skip('unsupported-path'); return advance() }
  if (isPassiveDiscoveryExcluded(path, s.config, s.root)) {
    s.skip(underNestedWorktree(s.root.canonicalPath, gitPath) ? 'nested-worktree' : undefined)
    return advance()
  }
  if (!s.extensionEligible(basenameOf(gitPath))) return advance()
  const repoIdentity = documentIdentityForGitPath(repositoryId, gitPath)
  if (isRefusal(repoIdentity)) { s.skip('unsupported-path'); return advance() }

  for (const ie of meta.index.get(gitPath) ?? []) {
    const size = meta.sizes.get(ie.oid!)
    if (size === undefined) { s.skip('git-object-unavailable'); continue }
    yield* s.addRow({
      rootId: s.root.rootId, identity: repoIdentity, kind: 'index', observedAt: new Date().toISOString(),
      git: { repositoryId, checkoutIdentity, gitPath, blobOid: ie.oid!, objectFormat: checkout.objectFormat, mode: ie.mode!, size, stage: ie.stage! },
    })
  }

  let st: ArtifactFileStat
  try {
    st = await s.fs.lstat(path)
  } catch (e) {
    const code = errnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') s.skip(code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'unreadable-entry')
    return advance()
  }
  if (st.type !== 'file') { s.skip(); return advance() }
  // DEFECT-2 (R67): an eligible changed or untracked file left out by the lookback is a visible gap, never a silent skip.
  if (!s.recent(st)) { s.gap('lookback-limited'); return advance() }
  const identity = documentIdentityForPath(path, s.root, { repositoryId, gitPath })
  if (isRefusal(identity)) { s.skip('unsupported-path'); return advance() }
  yield* s.addRow(s.workingRow(path, st, identity))
  return advance()
}

// ---------------------------------------------------------------------------------------------------------- git-history

/**
 * A committed version of an eligible document, or null with the reason counted. Evidence (R25): source 'git', operation
 * 'touched', certainty 'recorded' only for exactly one valid Atlas-Session trailer (several sessions name no single one, so
 * none is picked), eventKey `git:<commit>:<path>`, eventAt the commit time.
 */
function commitObservation(s: Slice, ch: GitChange, repositoryId: string): ArtifactWorkerObservation | null {
  const commit = ch.commit
  if (ch.status === 'malformed' || commit === null) { s.skip('malformed-record'); return null }
  // Deletions and submodule gitlinks are not document versions; Git symlinks are not documents.
  if (ch.blobOid === null || ch.mode === null || (ch.mode & FILE_TYPE_MASK) !== REGULAR_BLOB) return null
  if (ch.path === null) { s.skip('unsupported-path'); return null }
  if (!s.extensionEligible(basenameOf(ch.path))) return null
  // The catalog keys evidence by printable text of at most 512 characters.
  const eventKey = `git:${commit.oid}:${ch.path}`
  if (CONTROL_RE.test(ch.path) || eventKey.length > MAX_EVENT_KEY_CHARS) { s.skip('unsupported-path'); return null }
  if (ch.blobState !== 'present' || ch.size === null) { s.skip('git-object-unavailable'); return null }
  const ms = commit.committedAt * 1000
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_DATE_MS) { s.skip('malformed-record'); return null }
  const identity = documentIdentityForGitPath(repositoryId, ch.path)
  if (isRefusal(identity)) { s.skip('unsupported-path'); return null }
  const sessionId = commit.atlasSessionIds.length === 1 ? commit.atlasSessionIds[0]! : null
  return {
    rootId: s.root.rootId, identity, kind: 'commit', observedAt: new Date().toISOString(),
    git: { repositoryId, commitOid: commit.oid, gitPath: ch.path, blobOid: ch.blobOid, objectFormat: commit.objectFormat as GitObjectFormat, mode: ch.mode, size: ch.size },
    evidence: { source: 'git', eventKey, sessionId, operation: 'touched', certainty: sessionId !== null ? 'recorded' : 'unknown', eventAt: new Date(ms).toISOString() },
  }
}

/**
 * git-history: pages of readDocumentHistory, each change a `commit` observation (no path, no stat). The first pass from a null
 * cursor skips commits older than the cutoff (reported as lookback-limited); includeOlder restarts a lookback-limited history
 * without the cutoff. Page outcomes: an error returns the cursor unchanged (retry later; invalid-cursor restarts); gaps and
 * lookback make coverage partial; a finished pass returns complete:true with the cursor the next pass must start from.
 */
async function* gitHistory(s: Slice): AsyncGenerator<ArtifactWorkerFrame, void, undefined> {
  const root = s.root
  if (root.kind !== 'checkout' || root.repositoryId === null) {
    yield* s.fail('unsupported-task', 'git-history needs a checkout root with a repository identity')
    return
  }
  const repositoryId = root.repositoryId
  const decoded = s.decode('git-history')
  if (decoded === 'invalid') { yield* s.fail('invalid-cursor', 'the cursor does not belong to this history; the pass restarts', 'partial', null); return }
  let inner: string | null = decoded && decoded.payload !== '' ? decoded.payload : null
  if (decoded && s.req.includeOlder && decoded.header.lb) { inner = null; s.restartPass() }
  const rootIssue = s.rootProblem()
  if (rootIssue) { yield* s.fail(rootIssue.code, rootIssue.message, rootIssue.coverage); return }
  const checkout = await s.checkout()
  if ('kind' in checkout) { yield* s.fail(checkout.code, checkout.message, checkout.coverage); return }

  s.clock.startWork()
  for (;;) {
    const notBefore = inner === null && !s.req.includeOlder ? Math.floor(s.sinceMs / 1000) : undefined
    const page = await readDocumentHistory(checkout, inner, s.gitLimits, {
      documentExtensions: [...s.extensions], ...(notBefore !== undefined ? { notBefore } : {}),
    })
    if (page.error !== null) {
      if (page.error === 'invalid-cursor') yield* s.fail('invalid-cursor', 'the history cursor was rejected; the pass restarts', 'partial', null)
      else yield* s.fail(`git-${CODE_RE.test(`git-${page.error}`) ? page.error : 'failed'}`, 'a git history page failed; nothing was consumed')
      return
    }
    for (const change of page.changes) {
      s.visit()
      const row = commitObservation(s, change, repositoryId)
      if (row) yield* s.addRow(row)
    }
    inner = page.cursor
    if (page.gaps.length > 0 || page.unborn) s.gap('git-history-gap')
    if (page.lookbackLimited) s.gap('lookback-limited')
    if (!s.advance([], page.lookbackLimited, inner ?? '')) { yield* s.fail('cursor-limit', 'the history cursor would exceed its bound'); return }
    const detail = [...page.gaps, ...(page.unborn ? ['unborn'] : [])]
    if (!page.hasMore) {
      yield* s.finish(s.out.checkpoint, detail, !page.complete)
      return
    }
    // Every page is progress, so the budget is checked only after one.
    if (s.newEntries >= s.req.limits.maxEntries || s.clock.elapsed() >= s.req.limits.maxMs) {
      yield* s.end({ cursor: s.out.checkpoint, complete: false, coverage: 'partial', error: s.gapError(detail) })
      return
    }
  }
}
