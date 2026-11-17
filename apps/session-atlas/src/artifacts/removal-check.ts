// Standalone, read-only worktree removal checker (plan 2026-10-26 Task 11; spec section 11 "Worktree removal protection").
//
// checkWorktreeRemoval(target, options) answers, immediately before an ordinary `git worktree remove <target>`, whether removing
// that exact linked worktree could lose a protected file version, a commit or work in progress. Task 10's `check-removal`
// command and Task 12's Bash guard rely on it, so its bar is "never say safe when unsure":
//   exit 0  a complete check found nothing at risk: every protected version is proven preserved outside the target, the HEAD
//           commit is retained by a local branch or tag, the probe says no session is active, and nothing changed meanwhile;
//   exit 3  risks were found (unique versions, conflicts, an unretained commit, an active session, ...);
//   exit 2  coverage or proof is incomplete: anything ambiguous, unreadable, capped, timed out, raced or unverifiable.
// Risks win over unknowns, and both are listed (R43). Both nonzero outcomes block automated removal. A result is a point-in-time
// answer: it is never reused, and it never authorizes a forced removal.
//
// What it reads, and nothing else:
//   - the filesystem under the target: one lstat-based walk that never follows a symlink or enters another repository, then
//     bounded no-follow reads (re-stat before and after) of the files whose bytes it must compare;
//   - Git, only through the Task 4 adapter: no writes, no optional index refresh, no filters, textconv, hooks or fsmonitor;
//   - the Atlas catalog, only when its file exists, through a read-only SQLite handle and getArtifactRemovalContext (SELECT only),
//     plus the coverage note of each partial root under the target (one keyed SELECT each, R67) and two index-bounded SELECTs
//     per copy candidate for protection registered in other checkouts (catalogCopyGuard).
//     A missing catalog is never created and never read as an empty one; the catalog is context, never proof;
//   - session activity, only from the injected probe (Task 10/12 build it from the service and local process evidence).
// It writes nothing, spawns nothing but Git, and never puts file contents or Git stderr in a result.
//
// Protected content. A path is checked when it is protected (a `phi` or `.phi` segment in any case, a secret-looking name, a protected
// catalog root, a protected known location), a known artifact location, or a document by extension outside the fixed
// dependency/build caches; the cache exclusion does not apply inside a registered output root. User ignoreSegments and Git
// ignore rules hide nothing. Protected and secret-looking files are never read (spec s4, s7): their preservation cannot be
// proven, so they are always unknowns.
//
// Preservation. Every current version is judged separately: the working file's bytes and the stage-0 index blob. Exactly two
// things count as preservation:
//   - a verified identical REGULAR file outside the target: the same repository-relative path in another checkout of the
//     repository, whose real path does not lead back into the target, compared byte for byte with a re-stat around the read;
//   - the target's HEAD commit, when a local refs/heads/* or refs/tags/* ref retains it (for-each-ref --contains, confirmed with
//     merge-base --is-ancestor and cat-file -e), for a version byte-identical to that commit's blob. Working bytes are compared
//     with the blob read through cat-file without any filter, whatever `filterState` says (R42): an end-of-line conversion or
//     a filter makes Git's "clean" something other than byte equality. A staged version is the committed one only when its OID
//     is the commit's. An LFS pointer on either side is never proof. Working bytes that DIFFER from the committed blob are
//     `filter-unverified` only where a configured filter driver applies to that path (or that cannot be established); a
//     driver merely configured (git-lfs in a user's gitconfig, named by no attribute there) leaves the edit an ordinary risk.
// Detached HEADs, reflogs, remote-tracking refs, the index, sizes, timestamps, names and status letters never are. Remote
// retention is never checked or claimed (REMOVAL_CHECK_REMOTE_RETENTION_NOTE).
//
// Races. Every compared file is re-stat'ed after its read and again before returning, every walked directory is re-stat'ed
// (catching entries added or removed anywhere), and the worktree list, local branches and tags and the index file are read
// again: any change is `race-detected`. The walk and Git's own lists of the target must agree.

import { constants as fsConstants, lstatSync, readdirSync, realpathSync, type BigIntStats, type Dirent } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { loadConfig, type AtlasConfig } from '../config.ts'
import { getArtifactRemovalContext, readArtifactCoverageNote, type ArtifactRemovalContext } from '../db/artifact-manager.ts'
import { classifyPath, isSensitiveFilename } from './filetype.ts'
import {
  decodeGitPath, isGitLfsPointer, isGitOid, parseBatchCheck, parseBatchContents, parseLsFilesStageZ, parsePorcelainV1Z, parseWorktreeListZ,
  type GitObjectFormat,
} from './git-parser.ts'
import {
  listGitWorktrees, readBlobMetadata, resolveGitCheckout, resolveGitFilterApplication, runArtifactGit, type GitBlobMetadata, type GitCheckout, type GitLimits, type GitResult,
} from './git.ts'
import { FIXED_DISCOVERY_SEGMENTS, hasPhiSegment } from './path-policy.ts'

// ------------------------------------------------------------------------------------------------------------ public types

export type RemovalCheckIssue = { code: string; path: string | null; detail: string }

export type RemovalSessionActivity = 'active' | 'inactive' | 'unknown'

/** What a session probe answers. `unknown` may carry the reason and next step, which the result's `session-unknown` detail then shows. */
export type RemovalSessionProbeAnswer = RemovalSessionActivity | { activity: 'unknown'; reason: string }

export type RemovalCheckResult = {
  exitCode: 0 | 2 | 3
  /** The canonical target when it could be resolved, else the path as given. */
  target: string
  checkedAt: string
  risks: Array<{ code: string; path: string | null; detail: string }>
  unknowns: Array<{ code: string; path: string | null; detail: string }>
  coverage: {
    filesystem: 'complete' | 'incomplete'
    git: 'complete' | 'incomplete'
    /** 'error' also when the check stopped before the catalog was read (an unusable target spelling or path). */
    catalog: 'complete' | 'missing' | 'error'
    /** 'unknown' also when the check stopped before the probe answered. */
    sessions: 'active' | 'inactive' | 'unknown'
  }
}

export type RemovalCheckLimits = {
  /** Largest file (or blob) compared; a bigger protected version is `oversized`. Default: artifacts.hashMaxFileBytes. */
  maxFileBytes: number
  /** Bytes read in total (working files, blobs, copies); beyond it `budget-exceeded`. Default: artifacts.hashMaxJobBytes. */
  maxTotalBytes: number
  /** Directory entries walked under the target; beyond it `walk-cap`. */
  maxEntries: number
  /** Output cap of each Git command. */
  gitMaxOutputBytes: number
  /** Wait for the session probe. Default: the remaining wall-time budget. */
  probeTimeoutMs: number
}

/** Fault and timing seams, for tests. None of them may be used to weaken a production check. */
export type RemovalCheckHooks = {
  /** Clock for the wall-time budget (epoch milliseconds). */
  now?: () => number
  /** After the target is resolved as a linked worktree, before Git state is first recorded. */
  afterResolve?: () => void | Promise<void>
  /**
   * Called before each directory listing, each file read and each size lookup of the comparison pre-pass ('stat'); throwing
   * simulates that failure (e.g. an EACCES error).
   */
  beforeFs?: (op: 'readdir' | 'read' | 'stat', path: string) => void
  /** After the filesystem walk, before Git lists the target. */
  afterWalk?: () => void | Promise<void>
  /** After a file's bytes are read, before its after-read re-stat. */
  afterRead?: (path: string) => void | Promise<void>
  /** After every decision, before the final re-stat and the second read of Git state. */
  beforeFinalCheck?: () => void | Promise<void>
}

export type RemovalCheckOptions = {
  /** Atlas catalog file. undefined: the configured default (~/.claude/atlas/atlas.db). null: none (coverage 'missing'). */
  catalogPath?: string | null
  /** Live session activity for the canonical target. Absent: sessions are 'unknown' (exit 2). */
  probeSessionActivity?: (canonicalTarget: string) => Promise<RemovalSessionProbeAnswer>
  /** Wall-time budget for the whole check (default 8 s). On expiry the result is returned with a `timeout` unknown. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Document extensions (default: artifacts.documentExtensions). */
  documentExtensions?: string[]
  /** Extra secret-looking filename globs, on top of the built-in rules (default: artifacts.sensitivePatterns). */
  sensitivePatterns?: string[]
  limits?: Partial<RemovalCheckLimits>
  /** The cleanup caller's working directory (default: this process's). Inside the target it is a risk. null: not checked. */
  callerCwd?: string | null
  hooks?: RemovalCheckHooks
}

/**
 * Printed by every caller next to a result, whatever its exit code: what "preserved by a commit" does and does not mean. It is a
 * constant, not a per-run finding, because remote retention is never checked; it is therefore neither a risk nor an unknown and
 * never blocks a safe result.
 */
export const REMOVAL_CHECK_REMOTE_RETENTION_NOTE =
  'Commit retention is local only: a version kept by a local branch or tag is not a remote backup, and remote retention was not checked. ' +
  'A branch or tag deleted in the same cleanup no longer retains anything.'

export const DEFAULT_REMOVAL_CHECK_TIMEOUT_MS = 8000

// ------------------------------------------------------------------------------------------------------------------ limits

const DEFAULT_MAX_ENTRIES = 500_000
const DEFAULT_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_GIT_COMMAND_MS = 10_000
const MAX_TIMEOUT_MS = 10 * 60_000
/** Blob bytes read per `cat-file --batch`. */
const BLOB_CHUNK_BYTES = 16 * 1024 * 1024
/** Floor for any Git output cap: the adapter applies the cap to its own config enumeration too. */
const MIN_GIT_OUTPUT_BYTES = 1024 * 1024
/** Issues listed per array; the rest are counted in one `more-issues` entry of the same array. */
const MAX_LISTED = 500
const CHECKPOINT_EVERY = 512
/** The longest stretch of work between two yields to the event loop, so an abort or a timer can always run. */
const YIELD_EVERY_MS = 25
/** Files read at once while comparing. */
const READ_CONCURRENCY = 8

const FIXED_CACHE_SEGMENTS: ReadonlySet<string> = new Set(FIXED_DISCOVERY_SEGMENTS)
const DOT_GIT = Buffer.from('.git')
// Git state files of an operation stopped half-way; they live in the worktree's own Git directory and go with it.
const OPERATION_STATE = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer']
const FILE_TYPE_MASK = 0o170000
const REGULAR = 0o100000
const GITLINK = 0o160000

// ------------------------------------------------------------------------------------------------------------- check state

/** Thrown to end the check early (timeout, abort, a target that cannot be checked); the result is still returned. */
class StopCheck extends Error {}

type Area = 'filesystem' | 'git'

// Which coverage field an unknown makes incomplete when the caller names none, so exit 2 always shows in `coverage`. Catalog
// and session unknowns have their own fields (set where they are recorded); every other unknown defaults to `filesystem`.
const OWN_FIELD_UNKNOWNS: ReadonlySet<string> = new Set(['catalog-missing', 'catalog-error', 'session-unknown'])
const GIT_UNKNOWNS: ReadonlySet<string> = new Set([
  'git-incomplete', 'retention-unknown', 'object-unavailable', 'head-unresolved', 'submodule-unverified', 'inventory-mismatch', 'worktree-metadata',
  'contains-worktree', 'worktree-locked', 'lfs-unverified', 'filter-unverified', 'representation-unverified', 'internal-error',
])

class Check {
  readonly risks: RemovalCheckIssue[] = []
  readonly unknowns: RemovalCheckIssue[] = []
  private readonly seen = new Set<string>()
  readonly incomplete = { filesystem: false, git: false }
  catalog: 'complete' | 'missing' | 'error' = 'error'
  sessions: RemovalSessionActivity = 'unknown'
  /** The whole pipeline ran to its final re-stat. */
  finished = false
  /** Compared paths and walked directories with the stat signature their proof depends on. */
  readonly stable = new Map<string, string>()
  readonly deadline: number
  readonly now: () => number
  readonly signal: AbortSignal | undefined
  readonly hooks: RemovalCheckHooks
  readonly limits: RemovalCheckLimits
  private bytesLeft: number

  constructor(deadline: number, now: () => number, signal: AbortSignal | undefined, hooks: RemovalCheckHooks, limits: RemovalCheckLimits) {
    this.deadline = deadline
    this.now = now
    this.signal = signal
    this.hooks = hooks
    this.limits = limits
    this.bytesLeft = limits.maxTotalBytes
  }

  risk(code: string, path: string | null, detail: string): void {
    this.add(this.risks, code, path, detail)
  }

  unknown(code: string, path: string | null, detail: string, area?: Area): void {
    const field = area ?? (OWN_FIELD_UNKNOWNS.has(code) ? null : GIT_UNKNOWNS.has(code) ? 'git' : 'filesystem')
    if (field) this.incomplete[field] = true
    this.add(this.unknowns, code, path, detail)
  }

  /** One entry per code and path; path-less entries also differ by detail (e.g. which Git step failed). */
  private add(list: RemovalCheckIssue[], code: string, path: string | null, detail: string): void {
    const key = `${list === this.risks ? 'r' : 'u'}\0${code}\0${path ?? `\0${detail}`}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    list.push({ code, path, detail })
  }

  /** Ends the check when the caller aborted or the wall-time budget is spent. */
  checkpoint(): void {
    if (this.signal?.aborted) {
      this.unknown('aborted', null, 'the check was cancelled before it finished')
      throw new StopCheck()
    }
    if (this.now() >= this.deadline) this.timeout()
  }

  timeout(): never {
    this.unknown('timeout', null, 'the wall-time budget ran out before the check finished')
    throw new StopCheck()
  }

  private lastYield = Date.now()

  /** A checkpoint that also yields to the event loop after YIELD_EVERY_MS of work, so long loops stay abortable. */
  async pace(): Promise<void> {
    this.checkpoint()
    if (Date.now() - this.lastYield < YIELD_EVERY_MS) return
    await new Promise<void>(resume => setImmediate(resume))
    this.lastYield = Date.now()
    this.checkpoint()
  }

  remainingMs(): number {
    return this.deadline - this.now()
  }

  /** Limits for one Git command: bounded by the remaining budget, never by more than the adapter's 10 s default. */
  gitLimits(maxOutputBytes = this.limits.gitMaxOutputBytes): GitLimits {
    this.checkpoint()
    return { timeoutMs: Math.max(1, Math.min(MAX_GIT_COMMAND_MS, Math.floor(this.remainingMs()))), maxOutputBytes: Math.max(1, Math.min(256 * 1024 * 1024, maxOutputBytes)) }
  }

  takeBytes(n: number): boolean {
    if (n > this.bytesLeft) return false
    this.bytesLeft -= n
    return true
  }

  /** Records a Git command that did not give a complete answer. Returns true when it did. */
  gitOk(r: GitResult, step: string): boolean {
    if (r.error === null) return true
    if (r.timedOut) {
      if (this.remainingMs() <= 0) this.timeout()
      this.unknown('timeout', null, `Git did not finish ${step} in time`, 'git')
    } else {
      this.unknown('git-incomplete', null, `Git did not answer ${step} completely (${r.error})`, 'git')
    }
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------------- helpers

function errnoCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

function sigOf(s: BigIntStats): string {
  return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
}

function fsProblem(c: Check, e: unknown, path: string, what: string): void {
  const code = errnoCode(e)
  if (code === 'EACCES' || code === 'EPERM') c.unknown('permission-denied', path, `${what} was refused by the filesystem`, 'filesystem')
  else if (code === 'ENOENT' || code === 'ENOTDIR') c.unknown('race-detected', path, `${what} disappeared during the check`, 'filesystem')
  else c.unknown('filesystem-error', path, `${what} failed (${code ?? 'error'})`, 'filesystem')
}

/** Splits NUL-terminated Git output; null when the output does not end with a terminator (cut short). */
function nulFields(buf: Buffer): Buffer[] | null {
  if (buf.length === 0) return []
  if (buf[buf.length - 1] !== 0) return null
  const out: Buffer[] = []
  let start = 0
  for (let at = buf.indexOf(0); at >= 0; at = buf.indexOf(0, start)) {
    out.push(buf.subarray(start, at))
    start = at + 1
  }
  return out
}

const EXTENSION_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/

/** The eligible extensions; a list with none usable falls back to the configured set rather than protecting nothing. */
function documentExtensions(given: unknown, config: () => AtlasConfig): ReadonlySet<string> {
  const clean = (list: unknown[]): string[] => list.map(e => (typeof e === 'string' ? e.trim().replace(/^\./, '').toLowerCase() : '')).filter(e => EXTENSION_RE.test(e))
  const kept = Array.isArray(given) ? clean(given) : []
  return new Set(kept.length > 0 ? kept : clean(config().artifacts.documentExtensions))
}

function positiveInt(v: unknown, fallback: number): number {
  return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : fallback
}

// ---------------------------------------------------------------------------------------------------------------- catalog

type CatalogView = {
  protectedRoots: string[]
  outputRoots: string[]
  locations: Map<string, { protected: boolean }>
  sessionIds: string[]
}

const EMPTY_CATALOG: CatalogView = { protectedRoots: [], outputRoots: [], locations: new Map(), sessionIds: [] }

type CatalogRead = {
  context: ArtifactRemovalContext
  /** Partial roots under the target whose last completed scan pass's only gap is the informational `lookback-limited` (R67). */
  lookbackOnly: ReadonlySet<string>
}

/**
 * R67: a root whose last completed scan pass left out only files older than the lookback is not unfinished for this check,
 * which walks the filesystem itself (an older file in the target is examined like any other). Read from the runner's coverage
 * note (`coverage-reason:<rootId>`, JSON {codes, complete}); anything unreadable or different grants nothing.
 */
function lookbackOnlyRoots(db: DatabaseSync, context: ArtifactRemovalContext): Set<string> {
  const out = new Set<string>()
  try {
    for (const r of context.roots) {
      if (r.coverageState !== 'partial') continue
      // R71: the note's one definition; a scan root's note is shared by its checkout-status and output-walk passes.
      const note = readArtifactCoverageNote({ raw: db }, r.rootId, r.kind === 'checkout' ? 'checkout-status' : 'output-walk')
      if (note !== null && note.complete && note.codes.length === 1 && note.codes[0] === 'lookback-limited') out.add(r.rootId)
    }
  } catch {
    // An unreadable catalog (locked, an older schema without the state table) grants nothing.
    return new Set()
  }
  return out
}

/**
 * Reads the catalog's context for the target with a read-only handle, never openDatabase (which can create directories,
 * migrate or write pragmas). A missing file is coverage 'missing', never an empty catalog; anything unreadable is 'error'.
 */
function readCatalog(c: Check, catalogPath: string | null, target: string): CatalogRead | null {
  if (catalogPath === null) {
    c.catalog = 'missing'
    c.unknown('catalog-missing', null, 'no Atlas catalog was given: registered roots, known artifacts and protected roots are unknown')
    return null
  }
  const broken = (): null => {
    c.catalog = 'error'
    c.unknown('catalog-error', null, 'the Atlas catalog could not be read: registered roots, known artifacts and protected roots are unknown')
    return null
  }
  if (typeof catalogPath !== 'string' || !isAbsolute(catalogPath) || catalogPath.includes('\0')) return broken()
  try {
    if (!lstatSync(catalogPath).isFile()) return broken()
  } catch (e) {
    const code = errnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return broken()
    c.catalog = 'missing'
    c.unknown('catalog-missing', null, 'the Atlas catalog does not exist: absence is not evidence that no protected artifacts or writers exist')
    return null
  }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(catalogPath, { readOnly: true })
    const context = getArtifactRemovalContext({ raw: db }, target)
    const lookbackOnly = lookbackOnlyRoots(db, context)
    c.catalog = 'complete'
    return { context, lookbackOnly }
  } catch {
    return broken()
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

/** Catalog facts the decisions use, and the catalog-derived blockers (nested checkout roots, unfinished root coverage). */
function catalogView(c: Check, read: CatalogRead | null, target: string): CatalogView {
  if (!read) return EMPTY_CATALOG
  const ctx = read.context
  const view: CatalogView = { protectedRoots: [], outputRoots: [], locations: new Map(), sessionIds: ctx.sessions.map(s => s.sessionId) }
  for (const r of ctx.roots) {
    if (r.protected) view.protectedRoots.push(r.canonicalPath)
    if (r.kind === 'output') view.outputRoots.push(r.canonicalPath)
    const under = within(r.canonicalPath, target)
    if (!under || !r.active) continue
    if (r.kind === 'checkout' && r.canonicalPath !== target) {
      c.unknown('contains-worktree', r.canonicalPath, 'a registered checkout root lies inside the target', 'git')
    }
    const informational = r.coverageState === 'partial' && read.lookbackOnly.has(r.rootId)
    if ((r.coverageState !== 'idle' && !informational) || r.appliedGeneration < r.desiredGeneration) {
      c.unknown('catalog-root-incomplete', r.canonicalPath, `a registered root under the target has unfinished discovery (${r.coverageState})`)
    }
  }
  for (const l of ctx.locations) {
    if (l.path.length > target.length + 1 && l.path.startsWith(`${target}/`)) view.locations.set(l.path.slice(target.length + 1), { protected: l.protected })
  }
  return view
}

type CopyGuard = { protects: (path: string) => boolean; close: () => void }

/** `path` itself and each of its ancestors, deepest first: '/a/b/c' -> ['/a/b/c', '/a/b', '/a']. */
function selfAndAncestors(path: string): string[] {
  const out: string[] = []
  for (let p = path; p.length > 1; p = p.slice(0, p.lastIndexOf('/')) || '/') out.push(p)
  return out
}

/**
 * Registered protection of copy candidates in other checkouts, which the target's own catalog context does not list. Looked up
 * per candidate path, on demand, with two index-bounded SELECTs on one read-only handle opened at the first lookup: a protected
 * root at or above the path (`canonical_path IN` the path and its ancestors: the separator-aware containment
 * getArtifactRemovalContext uses, on the UNIQUE canonical_path index), or a known location at exactly that path marked
 * sensitive (UNIQUE path index). Paths under a protected root and `phi` paths are judged by the caller's other rules. If the
 * catalog cannot be opened or read, that is recorded once (catalog error) and every candidate counts as protected: no copy is
 * read without knowing whether it is protected content.
 */
function catalogCopyGuard(c: Check, catalogPath: string): CopyGuard {
  let db: DatabaseSync | null = null
  let failed = false
  const byDepth = new Map<number, StatementSync>()
  let sensitive: StatementSync | null = null
  return {
    protects(path) {
      if (failed) return true
      c.checkpoint()
      try {
        db ??= new DatabaseSync(catalogPath, { readOnly: true })
        const scope = selfAndAncestors(path)
        let roots = byDepth.get(scope.length)
        if (!roots) {
          roots = db.prepare(`SELECT 1 AS hit FROM artifact_roots WHERE protected = 1 AND canonical_path IN (${scope.map(() => '?').join(', ')}) LIMIT 1`)
          byDepth.set(scope.length, roots)
        }
        sensitive ??= db.prepare('SELECT 1 AS hit FROM artifacts WHERE path = ? AND is_sensitive = 1 LIMIT 1')
        const hit = roots.get(...scope) !== undefined || sensitive.get(path) !== undefined
        c.checkpoint()
        return hit
      } catch (e) {
        if (e instanceof StopCheck) throw e
        failed = true
        c.catalog = 'error'
        c.unknown('catalog-error', null, 'the Atlas catalog could not be read again for the protected areas of other checkouts')
        return true
      }
    },
    close() {
      try { db?.close() } catch { /* already closed */ }
      db = null
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------- sessions

type Probe = { result: Promise<{ activity: RemovalSessionActivity; reason: string | null }>; cancel: () => void }

/** An `unknown` answer that names its reason: only that shape, with a string reason, is accepted. */
function isObjectAnswer(v: unknown): v is { activity: 'unknown'; reason: string } {
  return v !== null && typeof v === 'object' && (v as { activity?: unknown }).activity === 'unknown' && typeof (v as { reason?: unknown }).reason === 'string'
}

/** The reason is shown in a result: one bounded line, no control characters. */
function probeReason(reason: string): string {
  const line = reason.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?').trim()
  return line === '' ? 'the session probe could not establish session activity' : line.length > 400 ? `${line.slice(0, 399)}\u2026` : line
}

function startProbe(fn: RemovalCheckOptions['probeSessionActivity'], target: string, timeoutMs: number): Probe {
  if (typeof fn !== 'function') return { result: Promise.resolve({ activity: 'unknown', reason: 'no session probe was supplied' }), cancel: () => {} }
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = new Promise<{ activity: RemovalSessionActivity; reason: string | null }>(settle => {
    timer = setTimeout(() => settle({ activity: 'unknown', reason: 'the session probe did not answer in time' }), Math.max(0, timeoutMs))
    let answer: Promise<unknown>
    try {
      answer = Promise.resolve(fn(target))
    } catch {
      answer = Promise.reject(new Error('probe'))
    }
    answer.then(v => {
      if (v === 'active' || v === 'inactive') settle({ activity: v, reason: null })
      else if (v === 'unknown') settle({ activity: 'unknown', reason: 'the session probe could not establish session activity' })
      else if (isObjectAnswer(v)) settle({ activity: 'unknown', reason: probeReason(v.reason) })
      else settle({ activity: 'unknown', reason: 'the session probe gave an unrecognized answer' })
    }, () => settle({ activity: 'unknown', reason: 'the session probe failed' }))
  }).finally(() => clearTimeout(timer))
  return { result, cancel: () => clearTimeout(timer) }
}

// ------------------------------------------------------------------------------------------------------------------- walk

type EntryKind = 'file' | 'symlink' | 'other'
type Walk = { files: Map<string, EntryKind>; nested: Set<string>; complete: boolean }

function direntKind(d: Dirent<Buffer>, abs: string): EntryKind | 'dir' {
  if (d.isDirectory()) return 'dir'
  if (d.isFile()) return 'file'
  if (d.isSymbolicLink()) return 'symlink'
  if (d.isFIFO() || d.isSocket() || d.isCharacterDevice() || d.isBlockDevice()) return 'other'
  const st = lstatSync(abs)
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'
}

/**
 * Lists every entry under the target without following symlinks. A directory below the root holding `.git` is another
 * repository (submodule, nested clone or worktree): it is recorded, never entered. Each directory's stat signature is taken
 * before it is listed, so anything added or removed later changes it.
 */
async function walkTarget(c: Check, root: string): Promise<Walk> {
  const walk: Walk = { files: new Map(), nested: new Set(), complete: true }
  const stack = ['']
  let entries = 0
  while (stack.length > 0) {
    await c.pace()
    const rel = stack.pop()!
    const abs = rel ? `${root}/${rel}` : root
    let list: Dirent<Buffer>[]
    try {
      c.hooks.beforeFs?.('readdir', abs)
      const st = lstatSync(abs, { bigint: true })
      if (!st.isDirectory()) {
        c.unknown('race-detected', abs, 'a directory changed type during the check', 'filesystem')
        walk.complete = false
        continue
      }
      c.stable.set(abs, sigOf(st))
      list = readdirSync(abs, { withFileTypes: true, encoding: 'buffer' })
    } catch (e) {
      fsProblem(c, e, abs, 'listing a directory')
      walk.complete = false
      continue
    }
    if (rel !== '' && list.some(d => d.name.equals(DOT_GIT))) {
      walk.nested.add(rel)
      continue
    }
    for (const d of list) {
      if (++entries % CHECKPOINT_EVERY === 0) await c.pace()
      const name = decodeGitPath(d.name)
      if (name === null) {
        c.unknown('lossy-path', abs, 'a name in this directory is not valid UTF-8 and cannot be checked', 'filesystem')
        walk.complete = false
        continue
      }
      if (rel === '' && name === '.git') continue
      if (entries > c.limits.maxEntries) {
        c.unknown('walk-cap', root, `the target has more than ${c.limits.maxEntries} entries`, 'filesystem')
        walk.complete = false
        return walk
      }
      const childRel = rel ? `${rel}/${name}` : name
      let kind: EntryKind | 'dir'
      try {
        kind = direntKind(d, `${abs}/${name}`)
      } catch (e) {
        fsProblem(c, e, `${abs}/${name}`, 'inspecting an entry')
        walk.complete = false
        continue
      }
      if (kind === 'dir') stack.push(childRel)
      else walk.files.set(childRel, kind)
    }
  }
  return walk
}

// -------------------------------------------------------------------------------------------------------------------- git

type IndexEntry = { mode: number; oid: string }
type TreeEntry = { mode: number; oid: string }

type GitView = {
  /** Paths Git lists as untracked or ignored; `dir/` entries (nested repositories) are kept apart. */
  others: Map<string, 'untracked' | 'ignored'> | null
  nestedListed: string[]
  /** Stage-0 entries; every path with any entry; paths with stage 1-3 entries. */
  stage0: Map<string, IndexEntry> | null
  indexPaths: Set<string>
  conflicts: Set<string>
  /** Assume-unchanged or skip-worktree entries (ls-files -v), which status cannot see. */
  hidden: Set<string> | null
  /** Paths status reports as changed (staged or unstaged). */
  changed: Set<string> | null
  /** 'unresolved' when a filter driver is configured (for the user or the repository); which paths it applies to is asked per path. */
  filterState: GitResult['filterState']
}

function lossyGit(c: Check, root: string): void {
  c.unknown('lossy-path', root, 'Git reported a path that is not valid UTF-8 and cannot be checked', 'git')
}

async function listOthers(c: Check, root: string, ignored: boolean, view: GitView, lim: GitLimits): Promise<boolean> {
  const args = ignored ? ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'] : ['ls-files', '--others', '--exclude-standard', '-z']
  const r = await runArtifactGit(root, args, lim)
  if (!c.gitOk(r, ignored ? 'the ignored-file list' : 'the untracked-file list')) return false
  if (r.filterState === 'unresolved') view.filterState = 'unresolved'
  const fields = nulFields(r.stdout)
  if (!fields) {
    c.unknown('git-incomplete', null, 'Git listed other files in an unexpected form', 'git')
    return false
  }
  for (const f of fields) {
    const path = decodeGitPath(f)
    if (path === null) { lossyGit(c, root); continue }
    if (path.endsWith('/')) view.nestedListed.push(path.slice(0, -1))
    else view.others!.set(path, ignored ? 'ignored' : 'untracked')
  }
  return true
}

/** Git's own view of the target: untracked and ignored files (two separate commands), index stages, hidden flags, status. */
async function readGitView(c: Check, root: string, format: GitObjectFormat): Promise<GitView> {
  const view: GitView = { others: new Map(), nestedListed: [], stage0: new Map(), indexPaths: new Set(), conflicts: new Set(), hidden: new Set(), changed: new Set(), filterState: 'none' }
  // One set of limits for the whole batch: a deadline check between launches must not leave a started call unawaited.
  const lim = c.gitLimits()
  const [untrackedOk, ignoredOk, stage, tags, status] = await Promise.all([
    listOthers(c, root, false, view, lim),
    listOthers(c, root, true, view, lim),
    runArtifactGit(root, ['ls-files', '--stage', '-z'], lim),
    runArtifactGit(root, ['ls-files', '-v', '-z'], lim),
    runArtifactGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], lim),
  ])
  if (!untrackedOk || !ignoredOk) view.others = null
  for (const r of [stage, tags, status]) if (r.filterState === 'unresolved') view.filterState = 'unresolved'

  if (c.gitOk(stage, 'the index')) {
    const stage0 = new Map<string, IndexEntry>()
    view.stage0 = stage0
    for (const e of parseLsFilesStageZ(stage.stdout, format)) {
      if (e.malformed) {
        c.unknown('git-incomplete', null, 'Git listed the index in an unexpected form', 'git')
        view.stage0 = null
        break
      }
      if (e.path === null) { lossyGit(c, root); continue }
      view.indexPaths.add(e.path)
      if (e.stage === 0) stage0.set(e.path, { mode: e.mode!, oid: e.oid! })
      else view.conflicts.add(e.path)
    }
  } else {
    view.stage0 = null
  }

  const tagFields = c.gitOk(tags, 'the index flags') ? nulFields(tags.stdout) : null
  if (tagFields) {
    for (const f of tagFields) {
      const path = f.length > 2 && f[1] === 0x20 ? decodeGitPath(f.subarray(2)) : null
      if (path === null) { lossyGit(c, root); continue }
      const tag = String.fromCharCode(f[0]!)
      if (tag === 'S' || (tag >= 'a' && tag <= 'z')) view.hidden!.add(path)
    }
  } else {
    if (tags.error === null) c.unknown('git-incomplete', null, 'Git listed the index flags in an unexpected form', 'git')
    view.hidden = null
  }

  if (c.gitOk(status, 'the status')) {
    const changed = new Set<string>()
    view.changed = changed
    for (const e of parsePorcelainV1Z(status.stdout)) {
      if (e.kind === 'malformed') {
        c.unknown('git-incomplete', null, 'Git reported status in an unexpected form', 'git')
        view.changed = null
        break
      }
      if (e.path === null || (e.origPathBytes !== null && e.origPath === null)) { lossyGit(c, root); continue }
      changed.add(e.path)
      if (e.origPath !== null) changed.add(e.origPath)
    }
  } else {
    view.changed = null
  }
  return view
}

/** The HEAD commit's tree (`ls-tree -r -z`, no sizes: a missing blob must not break the listing). null when unreadable. */
async function readHeadTree(c: Check, root: string, format: GitObjectFormat, head: string): Promise<Map<string, TreeEntry> | null> {
  const r = await runArtifactGit(root, ['ls-tree', '-r', '-z', '--full-tree', head], c.gitLimits())
  if (!c.gitOk(r, 'the HEAD tree')) return null
  const fields = nulFields(r.stdout)
  const tree = new Map<string, TreeEntry>()
  for (const f of fields ?? [null]) {
    const tab = f ? f.indexOf(0x09) : -1
    const m = f && tab > 0 ? /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)$/.exec(f.subarray(0, tab).toString('latin1')) : null
    if (!f || !m || !isGitOid(m[3], format)) {
      c.unknown('git-incomplete', null, 'Git listed the HEAD tree in an unexpected form', 'git')
      return null
    }
    const path = decodeGitPath(f.subarray(tab + 1))
    if (path === null) { lossyGit(c, root); continue }
    tree.set(path, { mode: parseInt(m[1]!, 8), oid: m[3]! })
  }
  return tree
}

type Retention = 'retained' | 'unretained' | 'unknown' | 'none'

/**
 * Whether a local branch or tag retains the HEAD commit: for-each-ref --contains finds a candidate among refs/heads/* and
 * refs/tags/* only (never HEAD, a reflog or refs/remotes/*), merge-base --is-ancestor confirms it (exit 0 yes, 1 no, anything else
 * unknown) and cat-file -e proves the commit object is present.
 */
async function headRetention(c: Check, root: string, format: GitObjectFormat, head: string): Promise<Retention> {
  const unknown = (detail: string, code = 'retention-unknown'): Retention => {
    c.unknown(code, null, detail, 'git')
    return 'unknown'
  }
  const lim = c.gitLimits()
  const [refs, present] = await Promise.all([
    runArtifactGit(root, ['for-each-ref', `--contains=${head}`, '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(refname)', 'refs/heads/', 'refs/tags/'], lim),
    runArtifactGit(root, ['cat-file', '-e', head], lim),
  ])
  if (!c.gitOk(refs, 'which branches and tags retain HEAD')) return unknown('which local branches and tags retain the HEAD commit could not be read')
  const lines = refs.stdout.toString('latin1').split('\n')
  if (lines.pop() !== '') return unknown('which local branches and tags retain the HEAD commit could not be read')
  let candidate: string | null = null
  for (const line of lines) {
    const [oid, type, peeled, nameLatin1] = line.split('\0')
    if (type === 'commit' && isGitOid(oid, format)) candidate = oid!
    else if (type === 'tag' && isGitOid(peeled, format)) candidate = peeled!
    else {
      const name = nameLatin1 === undefined ? null : decodeGitPath(Buffer.from(nameLatin1, 'latin1'))
      if (name && !name.startsWith('-')) candidate = name
    }
    if (candidate) break
  }
  if (lines.length === 0) {
    c.risk('unretained-commit', null,
      'the HEAD commit is not reachable from any local branch or tag; a detached HEAD, a reflog or a remote-tracking ref does not retain it')
    return 'unretained'
  }
  if (candidate === null) return unknown('no retaining local branch or tag could be resolved to a commit')
  const ancestor = await runArtifactGit(root, ['merge-base', '--is-ancestor', head, candidate], c.gitLimits())
  if (ancestor.exitCode !== 0 || ancestor.timedOut || ancestor.truncated) {
    if (ancestor.timedOut && c.remainingMs() <= 0) c.timeout()
    return unknown('the retaining branch or tag could not be confirmed')
  }
  if (present.exitCode !== 0 || present.error !== null) {
    if (present.timedOut && c.remainingMs() <= 0) c.timeout()
    return unknown('the HEAD commit object is not present locally', 'object-unavailable')
  }
  return 'retained'
}

/** Presence of blobs without reading them (protected files' blobs are never read, not even for an LFS sniff). */
async function blobPresence(c: Check, root: string, format: GitObjectFormat, oids: string[]): Promise<Map<string, GitBlobMetadata>> {
  const out = new Map<string, GitBlobMetadata>()
  if (oids.length === 0) return out
  const r = await runArtifactGit(root, ['cat-file', '--batch-check'], c.gitLimits(), { input: Buffer.from(oids.map(o => `${o}\n`).join('')) })
  c.gitOk(r, 'object presence')
  const parsed = parseBatchCheck(r.stdout, format)
  oids.forEach((oid, i) => {
    const rec = parsed.records[i]
    if (r.error !== null || !rec || rec.name !== oid) out.set(oid, { state: 'unknown' })
    else if (rec.state !== 'present') out.set(oid, { state: 'missing' })
    else if (rec.type !== 'blob') out.set(oid, { state: 'not-blob', type: rec.type })
    else out.set(oid, { state: 'present', size: rec.size, lfsPointer: null })
  })
  return out
}

/** Exact blob bytes, without filters, for `oids` whose size is known; bytes are only compared, never kept or reported. */
async function readBlobs(c: Check, root: string, format: GitObjectFormat, oids: string[], sizes: Map<string, number>): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const total = oids.reduce((n, o) => n + (sizes.get(o) ?? 0), 0)
  const r = await runArtifactGit(root, ['cat-file', '--batch'], c.gitLimits(Math.max(MIN_GIT_OUTPUT_BYTES, total + oids.length * 200)),
    { input: Buffer.from(oids.map(o => `${o}\n`).join('')) })
  c.gitOk(r, 'object contents')
  for (const obj of parseBatchContents(r.stdout, format).objects) {
    if (obj.type === 'blob' && obj.content && obj.content.length === sizes.get(obj.name)) out.set(obj.name, obj.content)
  }
  return out
}

/** Stat signature of the per-worktree index file ('none' when absent), or null when it cannot be read. */
function indexSig(gitDir: string): string | null {
  try {
    return sigOf(lstatSync(join(gitDir, 'index'), { bigint: true }))
  } catch (e) {
    const code = errnoCode(e)
    return code === 'ENOENT' ? 'none' : null
  }
}

type GitState = { digest: string; head: { oid: string | null; branch: string | null } | null }

/**
 * One digest of the Git state a proof depends on (every worktree's HEAD and branch, local branches and tags, the index file),
 * plus the target's own HEAD and branch as the worktree list reports them, so the caller can bind them to the HEAD it used.
 */
async function gitStateSignature(c: Check, root: string, gitDir: string, format: GitObjectFormat): Promise<GitState | null> {
  const lim = c.gitLimits()
  const [worktrees, refs] = await Promise.all([
    runArtifactGit(root, ['worktree', 'list', '--porcelain', '-z'], lim),
    runArtifactGit(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/tags/'], lim),
  ])
  const index = indexSig(gitDir)
  if (!c.gitOk(worktrees, 'the worktree list') || !c.gitOk(refs, 'the local branches and tags') || index === null) return null
  const parsed = parseWorktreeListZ(worktrees.stdout, format)
  const own = parsed.malformed ? undefined : parsed.records.find(rec => {
    if (rec.path === null || rec.bare) return false
    try { return rec.path === root || realpathSync.native(rec.path) === root } catch { return false }
  })
  return {
    digest: createHash('sha256').update(worktrees.stdout).update('\0').update(refs.stdout).update('\0').update(index).digest('hex'),
    head: own ? { oid: own.head, branch: own.branch } : null,
  }
}

// --------------------------------------------------------------------------------------------------------------- file reads

type Read = { ok: true; bytes: Buffer } | { ok: false }

/**
 * Reads one regular file in full with O_NOFOLLOW, proving it did not change while read: its lstat signature before, its fstat
 * signature before and after, no byte beyond the stat'ed size, and its lstat signature again after. The signature is kept for
 * the final re-stat. Every failure is recorded as an unknown.
 */
async function readStable(c: Check, abs: string): Promise<Read> {
  c.checkpoint()
  let before: BigIntStats
  try {
    c.hooks.beforeFs?.('read', abs)
    before = await lstat(abs, { bigint: true })
  } catch (e) {
    fsProblem(c, e, abs, 'reading a file')
    return { ok: false }
  }
  if (!before.isFile()) {
    c.unknown('race-detected', abs, 'the file changed type during the check', 'filesystem')
    return { ok: false }
  }
  const size = Number(before.size)
  if (size > c.limits.maxFileBytes) {
    c.unknown('oversized', abs, `the file is larger than the ${c.limits.maxFileBytes}-byte comparison limit; preservation cannot be proven`)
    return { ok: false }
  }
  if (!c.takeBytes(size)) {
    c.unknown('budget-exceeded', abs, 'the check\'s byte budget ran out before this file could be compared')
    return { ok: false }
  }
  const sig = sigOf(before)
  let changed = false
  let bytes: Buffer
  try {
    const fh = await open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    try {
      if (sigOf(await fh.stat({ bigint: true })) !== sig) changed = true
      bytes = Buffer.alloc(size)
      let off = 0
      while (off < size) {
        const { bytesRead } = await fh.read(bytes, off, size - off, off)
        if (bytesRead === 0) break
        off += bytesRead
      }
      if (off !== size || (await fh.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) changed = true
      await c.hooks.afterRead?.(abs)
      if (sigOf(await fh.stat({ bigint: true })) !== sig) changed = true
    } finally {
      await fh.close()
    }
    if (sigOf(await lstat(abs, { bigint: true })) !== sig) changed = true
  } catch (e) {
    fsProblem(c, e, abs, 'reading a file')
    return { ok: false }
  }
  if (changed) {
    c.unknown('race-detected', abs, 'the file changed while it was being compared', 'filesystem')
    return { ok: false }
  }
  // A path read twice (one copy proving both the staged and the working version) must not have changed in between; the final
  // re-stat compares against the first signature.
  const first = c.stable.get(abs)
  if (first !== undefined && first !== sig) {
    c.unknown('race-detected', abs, 'the file changed between two reads during the check', 'filesystem')
    return { ok: false }
  }
  c.stable.set(abs, sig)
  return { ok: true, bytes }
}

type Copy = 'same' | 'none' | 'unknown'

const presentSize = (m: GitBlobMetadata | undefined): number | null => (m?.state === 'present' ? m.size : null)

/** Which coverage area an unproven comparison belongs to. */
function areaOf(code: string): Area | undefined {
  if (code === 'copy-unverified') return 'filesystem'
  if (code === 'git-incomplete' || code === 'object-unavailable' || code === 'retention-unknown') return 'git'
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------- decisions

type Context = {
  c: Check
  root: string
  format: GitObjectFormat
  /** Other checkouts of the repository, outside the target: where an identical copy at the same relative path counts. */
  copyRoots: string[]
  /** A copy candidate that is protected content (a protected catalog root or location there): never read, never evidence. */
  guardedCopy: (path: string) => boolean
  catalog: CatalogView
  extensions: ReadonlySet<string>
  sensitive: RegExp[]
  git: GitView
  head: Map<string, TreeEntry> | null
  hasHead: boolean
  retention: Retention
  meta: Map<string, GitBlobMetadata>
  /** Whether a configured filter driver applies (or may apply) to a path: Git's "clean" is then not byte equivalence there. */
  filterApplies: (rel: string) => boolean
}

function isProtected(ctx: Context, rel: string, abs: string): boolean {
  const name = basename(rel)
  return hasPhiSegment(abs) || isSensitiveFilename(name) || ctx.sensitive.some(re => re.test(name))
    || ctx.catalog.protectedRoots.some(r => within(abs, r)) || ctx.catalog.locations.get(rel)?.protected === true
}

/** Protected content: protected paths, known artifact locations, and documents outside fixed caches (unless in an output root). */
function isChecked(ctx: Context, rel: string, abs: string): boolean {
  if (isProtected(ctx, rel, abs) || ctx.catalog.locations.has(rel)) return true
  if (!ctx.extensions.has(classifyPath(rel).extension)) return false
  const cached = rel.split('/').slice(0, -1).some(s => FIXED_CACHE_SEGMENTS.has(s))
  return !cached || ctx.catalog.outputRoots.some(r => within(abs, r))
}

/** Whether one spelling of a copy candidate's path is protected content by any rule: such a copy is never read, never evidence. */
function protectedCopy(ctx: Context, path: string): boolean {
  const name = basename(path)
  return hasPhiSegment(path) || isSensitiveFilename(name) || ctx.sensitive.some(re => re.test(name))
    || ctx.catalog.protectedRoots.some(r => within(path, r)) || ctx.guardedCopy(path)
}

/**
 * Looks for a verified identical regular file at `rel` in another checkout. A candidate must be a regular file (not a symlink),
 * of the same size, not protected, and its real path must stay outside the target (a path that resolves back into the target
 * is not durable); its bytes are read with the same re-stat discipline.
 */
async function outsideCopy(ctx: Context, rel: string, source: Buffer): Promise<Copy> {
  let result: Copy = 'none'
  for (const base of ctx.copyRoots) {
    const candidate = `${base}/${rel}`
    if (protectedCopy(ctx, candidate)) continue
    let st: BigIntStats
    try {
      st = await lstat(candidate, { bigint: true })
    } catch (e) {
      const code = errnoCode(e)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') result = 'unknown'
      continue
    }
    if (!st.isFile() || Number(st.size) !== source.length) continue
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      result = 'unknown'
      continue
    }
    if (within(real, ctx.root) || protectedCopy(ctx, real)) continue
    const read = await readStable(ctx.c, candidate)
    if (!read.ok) { result = 'unknown'; continue }
    // The path may have been redirected (an ancestor swapped for a symlink) between the realpath check and the read.
    const again = await realpath(candidate).catch(() => null)
    if (again !== real) {
      ctx.c.unknown('race-detected', candidate, 'the copy\'s real path changed while it was read', 'filesystem')
      result = 'unknown'
      continue
    }
    if (read.bytes.equals(source)) return 'same'
  }
  return result
}

/** Sizes of same-path candidates in other checkouts, to know whether a staged blob is worth reading. */
async function candidateSizes(ctx: Context, rel: string): Promise<number[]> {
  const sizes: number[] = []
  for (const base of ctx.copyRoots) {
    try {
      const st = await lstat(`${base}/${rel}`)
      if (st.isFile()) sizes.push(st.size)
    } catch { /* no candidate */ }
  }
  return sizes
}

type Job =
  /** The working file's bytes. `blob`: the retained HEAD blob of the same size to compare with, when there is one. */
  | { kind: 'working'; rel: string; abs: string; blob: string | null; inconclusive: [string, string] | null }
  /** A staged-only version (stage-0 blob that is not the retained HEAD blob), compared with same-size outside copies. */
  | { kind: 'staged'; rel: string; abs: string; blob: string | null }

const isRegularMode = (mode: number): boolean => (mode & FILE_TYPE_MASK) === REGULAR

/** Plans the checks of one path; records the decisions that need no bytes. */
function planPath(ctx: Context, rel: string, disk: EntryKind | 'absent' | 'unknown', jobs: Job[]): void {
  const { c, git } = ctx
  const abs = `${ctx.root}/${rel}`
  if (git.conflicts.has(rel)) {
    c.risk('conflict', abs, 'an unresolved merge conflict: automated removal is blocked until it is resolved')
    return
  }
  const staged = git.stage0?.get(rel) ?? null
  if (staged && (staged.mode & FILE_TYPE_MASK) === GITLINK) {
    c.unknown('submodule-unverified', abs, 'a submodule is not checked: its commit and contents are not proven retained', 'git')
    return
  }
  if (!isChecked(ctx, rel, abs)) return
  const prot = isProtected(ctx, rel, abs)
  const head = ctx.head?.get(rel) ?? null
  const headRegular = head !== null && isRegularMode(head.mode)

  // The staged version. Equal to the HEAD blob it is the committed version, whose retention is the commit's (reported once).
  if (staged && isRegularMode(staged.mode)) {
    if (headRegular && head!.oid === staged.oid) {
      if (ctx.retention === 'retained') {
        const m = ctx.meta.get(staged.oid)
        if (m?.state !== 'present') {
          c.unknown(m?.state === 'missing' ? 'object-unavailable' : 'git-incomplete', abs, 'the committed blob of this file is not readable locally', 'git')
        }
      }
    } else if (ctx.hasHead && ctx.head === null) {
      c.unknown('git-incomplete', abs, 'the staged version could not be compared with the HEAD commit', 'git')
    } else if (prot) {
      c.unknown('protected-unverified', abs, 'a protected file is never read, so the preservation of its staged version cannot be proven')
    } else {
      jobs.push({ kind: 'staged', rel, abs, blob: staged.oid })
    }
  }

  if (disk !== 'file') return
  if (prot) {
    c.unknown('protected-unverified', abs, 'a protected file is never read, so the preservation of its working version cannot be proven; move or handle it manually')
    return
  }
  const listed = git.others?.get(rel) ?? null
  if (!staged && headRegular && listed !== null) {
    c.risk('staged-deletion', abs, 'a staged deletion hides a working copy of this file')
    return
  }
  // Which committed blob could prove the working bytes, or why none can be relied on.
  let blob: string | null = null
  let inconclusive: [string, string] | null = null
  if (ctx.hasHead && ctx.head === null) inconclusive = ['git-incomplete', 'the HEAD commit could not be read to compare this file']
  else if (headRegular && ctx.retention === 'unknown') inconclusive = ['retention-unknown', 'whether a branch or tag retains the committed version is unknown']
  else if (headRegular && ctx.retention === 'retained') {
    const m = ctx.meta.get(head!.oid)
    if (m?.state === 'missing') inconclusive = ['object-unavailable', 'the committed blob of this file is not present locally']
    else if (m?.state !== 'present') inconclusive = ['git-incomplete', 'the committed blob of this file could not be inspected']
    else if (m.lfsPointer !== false) inconclusive = m.lfsPointer ? ['lfs-unverified', 'the committed version is a Git LFS pointer, not the document'] : ['git-incomplete', 'the committed blob could not be inspected']
    else blob = head!.oid
  }
  jobs.push({ kind: 'working', rel, abs, blob, inconclusive })
}

async function runWorking(ctx: Context, job: Extract<Job, { kind: 'working' }>, blobs: Map<string, Buffer>): Promise<void> {
  const { c, git } = ctx
  const read = await readStable(c, job.abs)
  if (!read.ok) return
  if (isGitLfsPointer(read.bytes)) {
    c.unknown('lfs-unverified', job.abs, 'the working file is a Git LFS pointer, not the document')
    return
  }
  let inconclusive = job.inconclusive
  const comparable = job.blob !== null
  if (job.blob !== null) {
    const committed = blobs.get(job.blob)
    if (committed?.equals(read.bytes)) return
    if (committed === undefined && presentSize(ctx.meta.get(job.blob)) === read.bytes.length) {
      inconclusive ??= ['git-incomplete', 'the committed blob of this file could not be read']
    }
  }
  const copy = await outsideCopy(ctx, job.rel, read.bytes)
  if (copy === 'same') return
  if (copy === 'unknown') inconclusive ??= ['copy-unverified', 'a possible copy outside the target could not be verified']
  if (inconclusive) {
    c.unknown(inconclusive[0], job.abs, inconclusive[1], areaOf(inconclusive[0]))
    return
  }
  const listed = git.others?.get(job.rel) ?? null
  const tracked = git.indexPaths.has(job.rel)
  if (!tracked) {
    if (git.others === null || listed === null) c.unknown('git-incomplete', job.abs, 'Git did not classify this unpreserved file', 'git')
    else if (ctx.hasHead && ctx.head === null) c.unknown('git-incomplete', job.abs, 'this file could not be compared with the HEAD commit', 'git')
    else c.risk(listed === 'ignored' ? 'unpreserved-ignored' : 'unpreserved-untracked', job.abs, `an ${listed} file with no verified identical copy outside the target`)
    return
  }
  if (!comparable) {
    c.risk('unpreserved-working', job.abs, ctx.retention === 'unretained'
      ? 'the working version exists only in this worktree and in a commit no local branch or tag retains'
      : 'the working version is neither committed in a retained commit nor copied outside the target')
    return
  }
  // A retained committed blob exists and differs from the working bytes. Status only explains why. Where a configured filter
  // applies, the difference may be the filter's own representation (R42): unverifiable. Where none applies (a driver merely
  // configured, DEFECT-6), the byte comparison against the unfiltered blob stands and status classifies the edit.
  if (ctx.filterApplies(job.rel)) {
    c.unknown('filter-unverified', job.abs, 'the working bytes differ from the committed blob and a configured filter that applies to this file could not be evaluated')
  } else if (git.hidden?.has(job.rel)) {
    c.risk('hidden-edit', job.abs, 'an edit hidden from status by assume-unchanged or skip-worktree, with no copy outside the target')
  } else if (git.changed?.has(job.rel)) {
    c.risk('unpreserved-working', job.abs, 'an uncommitted edit with no verified identical copy outside the target')
  } else {
    c.unknown('representation-unverified', job.abs, 'Git reports the file clean but its bytes differ from the committed blob (line-ending or encoding conversion)')
  }
}

async function runStaged(ctx: Context, job: Extract<Job, { kind: 'staged' }>, blobs: Map<string, Buffer>): Promise<void> {
  const { c } = ctx
  const m = ctx.meta.get(job.blob!)
  if (m?.state === 'missing') return c.unknown('object-unavailable', job.abs, 'the staged blob of this file is not present locally', 'git')
  if (m?.state !== 'present') return c.unknown('git-incomplete', job.abs, 'the staged blob of this file could not be inspected', 'git')
  if (m.lfsPointer !== false) return c.unknown(m.lfsPointer ? 'lfs-unverified' : 'git-incomplete', job.abs, 'the staged version is a Git LFS pointer or could not be inspected', m.lfsPointer ? undefined : 'git')
  const sizes = await candidateSizes(ctx, job.rel)
  if (sizes.includes(m.size)) {
    if (m.size > c.limits.maxFileBytes) return c.unknown('oversized', job.abs, 'the staged version is larger than the comparison limit; preservation cannot be proven')
    const bytes = blobs.get(job.blob!)
    if (!bytes) return c.unknown('git-incomplete', job.abs, 'the staged blob of this file could not be read', 'git')
    const copy = await outsideCopy(ctx, job.rel, bytes)
    if (copy === 'same') return
    if (copy === 'unknown') return c.unknown('copy-unverified', job.abs, 'a possible copy of the staged version could not be verified', 'filesystem')
  }
  c.risk('staged-unpreserved', job.abs, 'a staged version that is in no retained commit and has no verified identical copy outside the target')
}

/**
 * Runs `fn` over `items` with at most READ_CONCURRENCY in flight, pacing (deadline, abort, yield) before each item. Every lane
 * has stopped before this returns or throws, so no work continues after the result is built.
 */
async function eachLimited<T>(c: Check, items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let halted = false
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (halted || i >= items.length) return
      try {
        await c.pace()
        await fn(items[i]!)
      } catch (e) {
        halted = true
        throw e
      }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, lane))
  const failed = settled.find((o): o is PromiseRejectedResult => o.status === 'rejected')
  if (failed) throw failed.reason
}

/**
 * Which planned working comparisons a configured filter driver applies to (only those can reach the filter question: a working
 * file compared with a retained committed blob). One batched attribute read for all of them; any doubt counts as applying.
 */
async function filterApplication(c: Check, root: string, git: GitView, jobs: Job[]): Promise<(rel: string) => boolean> {
  if (git.filterState !== 'unresolved') return () => false
  const rels = [...new Set(jobs.filter(j => j.kind === 'working' && j.blob !== null).map(j => j.rel))]
  if (rels.length === 0) return () => false
  const r = await withinBudget(c, resolveGitFilterApplication(root, rels, c.gitLimits()))
  if (r.state === 'unresolved') {
    if (r.timedOut && c.remainingMs() <= 0) c.timeout()
    return () => true
  }
  return rel => r.filtered.has(rel)
}

/** The blob a job must read, decided from sizes alone (no bytes yet): the same-size committed blob, or a staged blob with a same-size candidate. */
async function neededBlob(ctx: Context, job: Job): Promise<string | null> {
  try { ctx.c.hooks.beforeFs?.('stat', job.abs) } catch { return null }
  const max = ctx.c.limits.maxFileBytes
  if (job.kind === 'working') {
    const size = job.blob === null ? null : presentSize(ctx.meta.get(job.blob))
    if (size === null || size > max) return null
    try { return (await lstat(job.abs)).size === size ? job.blob : null } catch { return null /* readStable reports it */ }
  }
  const m = ctx.meta.get(job.blob!)
  if (m?.state !== 'present' || m.lfsPointer !== false || m.size > max) return null
  return (await candidateSizes(ctx, job.rel)).includes(m.size) ? job.blob! : null
}

/** Runs the planned comparisons, reading the blobs they need in bounded `cat-file --batch` chunks and the files in parallel lanes. */
async function runJobs(ctx: Context, jobs: Job[]): Promise<void> {
  const { c } = ctx
  const run = (blobs: Map<string, Buffer>) => (j: Job): Promise<void> => (j.kind === 'working' ? runWorking(ctx, j, blobs) : runStaged(ctx, j, blobs))
  const byOid = new Map<string, Job[]>()
  await eachLimited(c, jobs, async job => {
    const oid = await neededBlob(ctx, job)
    if (oid === null) return
    const list = byOid.get(oid)
    if (list) list.push(job)
    else byOid.set(oid, [job])
  })
  const groups: string[][] = []
  let chunk: string[] = []
  let chunkBytes = 0
  const sizes = new Map<string, number>()
  for (const oid of byOid.keys()) {
    const size = presentSize(ctx.meta.get(oid)) ?? 0
    sizes.set(oid, size)
    if (chunk.length > 0 && chunkBytes + size > BLOB_CHUNK_BYTES) { groups.push(chunk); chunk = []; chunkBytes = 0 }
    chunk.push(oid)
    chunkBytes += size
  }
  if (chunk.length > 0) groups.push(chunk)

  for (const group of groups) {
    await c.pace()
    const members = group.flatMap(oid => byOid.get(oid)!)
    if (!c.takeBytes(group.reduce((n, oid) => n + sizes.get(oid)!, 0))) {
      for (const j of members) c.unknown('budget-exceeded', j.abs, 'the check\'s byte budget ran out before this file could be compared')
      continue
    }
    await eachLimited(c, members, run(await readBlobs(c, ctx.root, ctx.format, group, sizes)))
  }
  const withBlob = new Set([...byOid.values()].flat())
  await eachLimited(c, jobs.filter(j => !withBlob.has(j)), run(new Map()))
}

// ------------------------------------------------------------------------------------------------------------ the check

function resolveLimits(options: RemovalCheckOptions, config: () => AtlasConfig, timeoutMs: number): RemovalCheckLimits {
  const l: Partial<RemovalCheckLimits> = options.limits !== null && typeof options.limits === 'object' ? options.limits : {}
  return {
    maxFileBytes: positiveInt(l.maxFileBytes, l.maxFileBytes === undefined ? config().artifacts.hashMaxFileBytes : 0),
    maxTotalBytes: positiveInt(l.maxTotalBytes, l.maxTotalBytes === undefined ? config().artifacts.hashMaxJobBytes : 0),
    maxEntries: positiveInt(l.maxEntries, DEFAULT_MAX_ENTRIES),
    gitMaxOutputBytes: Math.max(1, positiveInt(l.gitMaxOutputBytes, DEFAULT_GIT_OUTPUT_BYTES)),
    probeTimeoutMs: positiveInt(l.probeTimeoutMs, timeoutMs),
  }
}

/** Waits for an adapter call within the remaining budget; on expiry the call is abandoned (its own 10 s bound still ends it). */
async function withinBudget<T>(c: Check, work: Promise<T>): Promise<T> {
  work.catch(() => { /* an abandoned call's failure is not this check's concern */ })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>(settle => { timer = setTimeout(() => settle('expired'), Math.max(0, c.remainingMs())) })
  try {
    const outcome = await Promise.race([work, expired])
    if (outcome === 'expired') c.timeout()
    return outcome as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Checks whether removing the linked worktree at `targetPath` is safe. Never throws: every failure is a risk or an unknown in
 * the result. See the file header for the exit codes and what counts as preservation.
 */
export async function checkWorktreeRemoval(targetPath: string, options: RemovalCheckOptions = {}): Promise<RemovalCheckResult> {
  const checkedAt = new Date().toISOString()
  const target = printable(targetPath)
  try {
    return await runCheck(targetPath, options !== null && typeof options === 'object' ? options : {}, checkedAt)
  } catch (e) {
    // Even setup (a seam, the configuration) failing gives a blocking result, never an exception.
    return {
      exitCode: 2, target, checkedAt, risks: [],
      unknowns: [{ code: 'internal-error', path: null, detail: `the check failed unexpectedly (${e instanceof Error ? e.name : 'error'})` }],
      coverage: { filesystem: 'incomplete', git: 'incomplete', catalog: 'error', sessions: 'unknown' },
    }
  }
}

/** The target as given, for the result; a value whose string conversion throws (no prototype, a throwing toString) is ''. */
function printable(value: unknown): string {
  if (typeof value === 'string') return value
  try { return String(value) } catch { return '' }
}

async function runCheck(targetPath: unknown, options: RemovalCheckOptions, checkedAt: string): Promise<RemovalCheckResult> {
  const hooks: RemovalCheckHooks = options.hooks !== null && typeof options.hooks === 'object' ? options.hooks : {}
  const now = typeof hooks.now === 'function' ? hooks.now : Date.now
  let cachedConfig: AtlasConfig | null = null
  const config = (): AtlasConfig => (cachedConfig ??= loadConfig(process.env))
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs! >= 1 ? Math.min(options.timeoutMs!, MAX_TIMEOUT_MS) : DEFAULT_REMOVAL_CHECK_TIMEOUT_MS
  const c = new Check(now() + timeoutMs, now, options.signal instanceof AbortSignal ? options.signal : undefined, hooks, resolveLimits(options, config, timeoutMs))
  let target = printable(targetPath)
  let probe: Probe | null = null
  try {
    if (typeof targetPath !== 'string' || !isAbsolute(targetPath) || targetPath.includes('\0') || targetPath.split('/').includes('..') || resolvePath(targetPath) === '/') {
      c.unknown('invalid-target', null, 'the target must be an absolute path without ".." segments')
      throw new StopCheck()
    }
    c.checkpoint()
    target = await resolveTarget(c, resolvePath(targetPath))
    probe = startProbe(options.probeSessionActivity, target, Math.min(c.limits.probeTimeoutMs, Math.max(0, c.remainingMs())))
    const catalogPath = options.catalogPath === undefined ? config().dbPath : options.catalogPath
    const catalog = catalogView(c, readCatalog(c, catalogPath, target), target)
    checkCaller(c, options.callerCwd === undefined ? process.cwd() : options.callerCwd, target)
    await checkWorktree(c, target, catalog, catalogPath, options, config)
    const session = await probe.result
    c.sessions = session.activity
    if (session.activity === 'active') {
      const ids = catalog.sessionIds.slice(0, 5)
      c.risk('active-session', null, `a session is active in the target${ids.length ? ` (catalog sessions there: ${ids.join(', ')})` : ''}; wait for it to stop, then check again from outside the target`)
    } else if (session.activity === 'unknown') {
      c.unknown('session-unknown', null, `session activity in the target could not be established: ${session.reason ?? 'unknown'}`)
    }
    c.finished = true
  } catch (e) {
    if (!(e instanceof StopCheck)) c.unknown('internal-error', null, `the check failed unexpectedly (${e instanceof Error ? e.name : 'error'})`, 'git')
  } finally {
    probe?.cancel()
  }
  return result(c, target, checkedAt)
}

/** The exact directory: no symlink at the target itself; ancestors are resolved to the canonical path Git reports. */
async function resolveTarget(c: Check, lexical: string): Promise<string> {
  let st
  try {
    st = lstatSync(lexical)
  } catch (e) {
    const code = errnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') c.unknown('unknown-target', null, 'the target does not exist')
    else fsProblem(c, e, lexical, 'inspecting the target')
    throw new StopCheck()
  }
  if (st.isSymbolicLink()) {
    c.unknown('target-symlink', null, 'the target is a symbolic link; check the worktree by its real path')
    throw new StopCheck()
  }
  if (!st.isDirectory()) {
    c.unknown('unknown-target', null, 'the target is not a directory')
    throw new StopCheck()
  }
  try {
    return realpathSync.native(lexical)
  } catch (e) {
    fsProblem(c, e, lexical, 'resolving the target')
    throw new StopCheck()
  }
}

function checkCaller(c: Check, cwd: string | null, target: string): void {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return
  let real: string
  try { real = realpathSync.native(cwd) } catch { real = resolvePath(cwd) }
  if (within(real, target) || within(resolvePath(cwd), target)) {
    c.risk('caller-inside-target', null, 'the cleanup caller\'s working directory is inside the target; run a fresh check from outside it')
  }
}

async function checkWorktree(c: Check, target: string, catalog: CatalogView, catalogPath: string | null, options: RemovalCheckOptions, config: () => AtlasConfig): Promise<void> {
  // ---- the exact linked worktree, from Git's worktree metadata
  let checkout: GitCheckout | null
  let worktrees: GitCheckout[]
  // The worktree list is needed only once the target is accepted, but starting it now saves a round of Git processes.
  const listed = withinBudget(c, listGitWorktrees(target))
  listed.catch(() => { /* consumed below, or abandoned when the target is refused */ })
  try {
    checkout = await withinBudget(c, resolveGitCheckout(target))
    if (!checkout) {
      c.unknown('unknown-target', null, 'the target is not a Git work tree')
      throw new StopCheck()
    }
    if (checkout.worktreePath !== target) {
      c.unknown('not-worktree-root', null, 'the target is inside a work tree, not the top of one')
      throw new StopCheck()
    }
    if (checkout.isMain) {
      c.risk('main-checkout', null, 'the target is the repository\'s main checkout, not a linked worktree')
      throw new StopCheck()
    }
    worktrees = await listed
  } catch (e) {
    if (e instanceof StopCheck) throw e
    c.unknown('worktree-metadata', null, `the target's Git worktree metadata could not be read (${(e as { code?: string }).code ?? 'error'})`, 'git')
    throw new StopCheck()
  }
  const self = worktrees.find(w => !w.isMain && w.worktreePath === target)
  if (!self || self.gitDir !== checkout.gitDir) {
    c.unknown('unknown-target', null, 'the target is not a linked worktree registered with its repository')
    throw new StopCheck()
  }
  if (self.locked) c.unknown('worktree-locked', null, 'the worktree is locked; whoever locked it must unlock it first')
  for (const w of worktrees) {
    if (w !== self && within(w.worktreePath, target)) c.unknown('contains-worktree', w.worktreePath, 'another checkout of the repository lies inside the target', 'git')
  }
  if (within(checkout.commonDir, target)) c.risk('common-dir-inside-target', null, 'the repository\'s shared Git directory lies inside the target')
  const operations: string[] = []
  for (const name of OPERATION_STATE) {
    try {
      lstatSync(join(self.gitDir, name))
      operations.push(name)
    } catch (e) {
      const code = errnoCode(e)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') c.unknown('worktree-metadata', null, 'the worktree\'s Git directory could not be inspected', 'git')
    }
  }
  if (operations.length > 0) c.risk('operation-in-progress', null, `an unfinished Git operation keeps its state in the worktree (${operations.join(', ')})`)

  // Every proof below uses checkout.head. The target's HEAD and branch are read again with each record of Git state (here,
  // and after every decision) and must still be that HEAD: a commit, checkout or reset in between is a race.
  const format = checkout.objectFormat
  const resolvedHead = checkout.head
  const boundToHead = (state: GitState | null): boolean =>
    state !== null && state.head !== null && state.head.oid === resolvedHead.oid && state.head.branch === resolvedHead.ref
  await c.hooks.afterResolve?.()
  c.checkpoint()
  const before = await gitStateSignature(c, target, self.gitDir, format)
  if (before !== null && !boundToHead(before)) c.unknown('race-detected', null, 'the target\'s HEAD moved after the worktree was resolved', 'git')

  // ---- the filesystem, then Git's own lists of the same tree
  const walk = await walkTarget(c, target)
  await c.hooks.afterWalk?.()
  c.checkpoint()
  // Git's lists of the target, the HEAD tree and the retention proof are independent reads: run them together.
  const headOid = resolvedHead.oid
  const [git, head, retention] = await Promise.all([
    readGitView(c, target, format),
    headOid ? readHeadTree(c, target, format, headOid) : Promise.resolve(new Map<string, TreeEntry>()),
    headOid ? headRetention(c, target, format, headOid) : Promise.resolve<Retention>('none'),
  ])
  if (checkout.head.unborn && git.indexPaths.size > 0) {
    c.unknown('head-unresolved', null, 'HEAD names a branch with no commit while the index has entries: the commit this worktree was on cannot be verified', 'git')
  }

  // ---- nested repositories, submodules and the walk/Git agreement
  for (const rel of walk.nested) c.unknown('submodule-unverified', `${target}/${rel}`, 'a nested repository is not checked: its commits and contents are not proven retained', 'git')
  for (const rel of git.nestedListed) c.unknown('submodule-unverified', `${target}/${rel}`, 'a nested repository is not checked: its commits and contents are not proven retained', 'git')
  const nestedDirs = [...walk.nested, ...git.nestedListed]
  const insideNested = (rel: string): boolean => nestedDirs.some(d => within(rel, d))
  if (walk.complete && git.others !== null && git.stage0 !== null) {
    let n = 0
    for (const [rel, kind] of walk.files) {
      if (++n % CHECKPOINT_EVERY === 0) await c.pace()
      if (kind === 'other' || git.indexPaths.has(rel) || git.others.has(rel) || insideNested(rel)) continue
      c.unknown('inventory-mismatch', `${target}/${rel}`, 'Git did not account for a file the walk found', 'git')
    }
    for (const rel of git.others.keys()) {
      if (++n % CHECKPOINT_EVERY === 0) await c.pace()
      // Below a directory the walk did not enter (a `.git` entry Git itself may not accept), the unit is already unverified.
      if (!walk.files.has(rel) && !insideNested(rel)) c.unknown('race-detected', `${target}/${rel}`, 'Git listed a file the walk did not find', 'filesystem')
    }
  }

  // ---- decisions
  const extensions = documentExtensions(options.documentExtensions, config)
  const sensitive = (Array.isArray(options.sensitivePatterns) ? options.sensitivePatterns : config().artifacts.sensitivePatterns)
    .filter(g => typeof g === 'string' && g.trim()).map(g => globToRegExp(g.trim()))
  const ctx: Context = {
    c, root: target, format, catalog, extensions, sensitive, git, head, hasHead: headOid !== null, retention, meta: new Map(), filterApplies: () => true,
    copyRoots: worktrees.filter(w => w !== self && !w.prunable && !within(w.worktreePath, target)).map(w => w.worktreePath),
    guardedCopy: () => false,
  }
  // Without a readable catalog no registered protection is known (coverage already says so); with one, protection of each copy
  // candidate is looked up when (and only if) a candidate is found.
  const guard = c.catalog === 'complete' && typeof catalogPath === 'string' && ctx.copyRoots.length > 0 ? catalogCopyGuard(c, catalogPath) : null
  if (guard) ctx.guardedCopy = guard.protects
  // A path the walk did not see is absent only when the walk was complete; otherwise its state is unknown.
  const diskOf = (rel: string): EntryKind | 'absent' | 'unknown' => walk.files.get(rel) ?? (walk.complete ? 'absent' : 'unknown')
  const paths = new Set<string>([...walk.files.keys(), ...git.indexPaths])
  if (git.stage0) for (const [rel, e] of git.stage0) if ((e.mode & FILE_TYPE_MASK) === GITLINK) paths.add(rel)

  // Blob metadata (presence, size, LFS pointer) for every committed or staged blob a checked path relies on. Protected
  // paths' blobs only get a presence check, so their bytes are never read, not even for the LFS sniff.
  const plain: string[] = []
  const guarded: string[] = []
  let n = 0
  for (const rel of paths) {
    if (++n % CHECKPOINT_EVERY === 0) await c.pace()
    const abs = `${target}/${rel}`
    if (!isChecked(ctx, rel, abs)) continue
    const into = isProtected(ctx, rel, abs) ? guarded : plain
    const s = git.stage0?.get(rel)
    const h = head?.get(rel)
    if (s && isRegularMode(s.mode)) into.push(s.oid)
    if (h && isRegularMode(h.mode)) into.push(h.oid)
  }
  const plainOids = [...new Set(plain)]
  const plainSet = new Set(plainOids)
  const lim = c.gitLimits()
  const [meta, presence] = await Promise.all([
    plainOids.length > 0 ? readBlobMetadata(target, format, plainOids, lim) : Promise.resolve(null),
    blobPresence(c, target, format, [...new Set(guarded)].filter(o => !plainSet.has(o))),
  ])
  if (meta?.timedOut && c.remainingMs() <= 0) c.timeout()
  for (const oid of plainOids) ctx.meta.set(oid, meta?.blobs.get(oid) ?? { state: 'unknown' })
  for (const [oid, m] of presence) ctx.meta.set(oid, m)

  const jobs: Job[] = []
  for (const rel of [...paths].sort()) {
    await c.pace()
    if (insideNested(rel) && !git.stage0?.has(rel)) continue
    planPath(ctx, rel, diskOf(rel), jobs)
  }
  ctx.filterApplies = await filterApplication(c, target, git, jobs)
  try {
    await runJobs(ctx, jobs)
  } finally {
    guard?.close()
  }

  // ---- nothing may have changed: compared files, walked directories, HEAD, refs, worktrees and the index
  await c.hooks.beforeFinalCheck?.()
  c.checkpoint()
  for (const [path, sig] of c.stable) {
    await c.pace()
    let now: string | null = null
    try { now = sigOf(lstatSync(path, { bigint: true })) } catch { /* gone */ }
    if (now !== sig) c.unknown('race-detected', path, 'this path changed during the check, which invalidates the proof', 'filesystem')
  }
  const after = await gitStateSignature(c, target, self.gitDir, format)
  if (before === null || after === null) c.unknown('race-detected', null, 'Git state could not be read twice to rule out a change during the check', 'git')
  else if (before.digest !== after.digest) c.unknown('race-detected', null, 'HEAD, a branch or tag, a worktree or the index changed during the check', 'git')
  else if (!boundToHead(after)) c.unknown('race-detected', null, 'the target\'s HEAD is not the one the check used', 'git')
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function capped(list: RemovalCheckIssue[]): RemovalCheckIssue[] {
  const sorted = [...list].sort((a, b) => cmp(a.path ?? '', b.path ?? '') || cmp(a.code, b.code))
  if (sorted.length <= MAX_LISTED) return sorted
  const kept = sorted.slice(0, MAX_LISTED - 1)
  kept.push({ code: 'more-issues', path: null, detail: `${sorted.length - kept.length} more not listed` })
  return kept
}

function result(c: Check, target: string, checkedAt: string): RemovalCheckResult {
  const coverage: RemovalCheckResult['coverage'] = {
    filesystem: c.finished && !c.incomplete.filesystem ? 'complete' : 'incomplete',
    git: c.finished && !c.incomplete.git ? 'complete' : 'incomplete',
    catalog: c.catalog,
    sessions: c.sessions,
  }
  const risks = capped(c.risks)
  const unknowns = capped(c.unknowns)
  const complete = coverage.filesystem === 'complete' && coverage.git === 'complete' && coverage.catalog === 'complete' && coverage.sessions === 'inactive'
  const exitCode: 0 | 2 | 3 = risks.length > 0 ? 3 : unknowns.length > 0 || !complete ? 2 : 0
  return { exitCode, target, checkedAt, risks, unknowns, coverage }
}
