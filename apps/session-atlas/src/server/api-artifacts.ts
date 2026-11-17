import { execFile } from 'node:child_process'
import { open as openFile, unlink, type FileHandle } from 'node:fs/promises'
import { constants as fsConstants, lstatSync, realpathSync, type BigIntStats, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve as resolvePath } from 'node:path'
import { loadConfig, type AtlasConfig } from '../config.ts'
import type { AtlasDb } from '../db/database.ts'
import { getArtifact, searchArtifacts, setExistsState, SUBAGENT_EXCLUSION_SQL } from '../db/artifacts.ts'
import {
  ARTIFACT_JOB_PRIORITY, ArtifactDocumentNotFoundError, artifactDirectScopeId, artifactDocumentHasPhiPath, enqueueArtifactJob, getArtifactDocument, getArtifactManagerStatus,
  listArtifactCoverageNotes, listArtifactDocuments, listArtifactRoots, recordArtifactGitObjectChecks, registerArtifactRoot, setArtifactDiscoveryPaused,
  type ArtifactDocumentFilters, type ArtifactGitObjectCheck, type ArtifactRootRow,
} from '../db/artifact-manager.ts'
import type { ArtifactEvidenceSource, ArtifactRootCoverageState, ArtifactTaskKind, ArtifactWorkerRoot } from '../artifacts/contracts.ts'
import { isIgnoredPath, isUntrustedPath } from '../artifacts/candidates.ts'
import { recheckKnownLocation } from '../artifacts/reconcile.ts'
import { isSensitiveFilename } from '../artifacts/filetype.ts'
import { DEFAULT_GIT_LIMITS, runArtifactGit, type GitLimits, type GitResult, type GitRunOptions } from '../artifacts/git.ts'
import { GIT_LFS_POINTER_MAX_BYTES, isGitLfsPointer, isGitOid } from '../artifacts/git-parser.ts'
import { authorizeArtifactPath, canonicalizeArtifactRoot, hasPhiSegment } from '../artifacts/path-policy.ts'
import { previewContentType, previewModeFor, PREVIEW_MAX_BYTES } from '../artifacts/preview.ts'
import { isValidSessionId } from '../ingest/event.ts'
import {
  artifactRefusedDirectories, includeOlderPendingRoots, isArtifactDiscoveryPaused, isArtifactRootRefused, readArtifactManagerHealth, readArtifactManagerState,
  requestArtifactRefresh,
} from '../service/artifact-manager-runner.ts'
import { HttpError, type RouteContext, type Router } from './http.ts'
import type { Logger } from '../util/log.ts'
import { nowIso } from '../util/time.ts'
import { qs } from './query.ts'
import type { SensitiveFilter } from '../db/artifacts.ts'

// Hidden by default (H2): only an explicit show/only widens the result set.
function sensitiveParam(raw: string | undefined): SensitiveFilter {
  return raw === 'show' || raw === 'only' ? raw : 'hide'
}

// Default reveal shells out to Finder via an argv array (never a shell string) so a path can
// never be interpreted by a shell -- tests always inject their own `reveal` and must never hit
// this function.
const defaultReveal = (path: string): Promise<void> =>
  new Promise((resolve, reject) => execFile('open', ['-R', path], err => (err ? reject(err) : resolve())))

// Same argv-array discipline as defaultReveal (never a shell string), minus -R so the file is
// handed to its default application instead of being shown in Finder. Tests always inject their
// own openWith and must never hit this function.
const defaultOpenWith = (path: string): Promise<void> =>
  new Promise((resolve, reject) => execFile('open', [path], err => (err ? reject(err) : resolve())))

function fsCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

const isMissingFsError = (error: unknown): boolean => fsCode(error) === 'ENOENT' || fsCode(error) === 'ENOTDIR'
const isSymlinkFsError = (error: unknown): boolean => fsCode(error) === 'ELOOP'
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino

/** The data directories no root may touch, and the durable output base an export writes under. */
export type ArtifactRouteConfig = Pick<AtlasConfig, 'atlasDir' | 'spoolDir' | 'ledgerPath'> & { artifacts: Pick<AtlasConfig['artifacts'], 'durableOutputBase'> }

/** The Git adapter seam (Task 4's runArtifactGit by default). */
export type ArtifactGitRunner = (repoPath: string, args: string[], limits: GitLimits, options?: GitRunOptions) => Promise<GitResult>

/** The file-open seam used by version preview and export (fs/promises open by default). Flags are always passed explicitly. */
export type ArtifactRouteFs = { open(path: string, flags: number, mode?: number): Promise<FileHandle> }

export type ArtifactRouteDeps = {
  db: AtlasDb
  log: Logger
  reveal?: (path: string) => Promise<void>
  openWith?: (path: string) => Promise<void>
  /** Home directory for the path policy; defaults to os.homedir() at request time. */
  home?: string
  /** Clock for status ages, job times and the pause flag; defaults to nowIso. */
  now?: () => string
  /** Git adapter for preview/export of Git versions; defaults to runArtifactGit. */
  runGit?: ArtifactGitRunner
  /** Defaults to loadConfig(), read once on first use by a route that needs it. */
  config?: ArtifactRouteConfig
  /** File opens for version preview and export; defaults to fs/promises open. */
  fs?: ArtifactRouteFs
}

/** What both route families authorize against: the home directory, the (lazily loaded) config and the active registered roots. */
type RootAccess = { home: () => string; cfg: () => ArtifactRouteConfig; activeRoots: () => ArtifactRootRow[] }

function rootAccess(deps: ArtifactRouteDeps): RootAccess {
  const { db } = deps
  let config = deps.config
  const cfg = (): ArtifactRouteConfig => (config ??= loadConfig())
  return {
    home: () => deps.home ?? homedir(),
    cfg,
    // Active roots outside the Atlas data, spool and cost-ledger directories, the set every action authorizes against.
    activeRoots: () => {
      const refused = artifactRefusedDirectories(cfg())
      return listArtifactRoots(db).filter(r => r.active && !isArtifactRootRefused(r.canonicalPath, refused))
    },
  }
}

export function registerArtifactRoutes(router: Router, deps: ArtifactRouteDeps): void {
  const { db } = deps
  const reveal = deps.reveal ?? defaultReveal
  const openWith = deps.openWith ?? defaultOpenWith
  const access = rootAccess(deps)

  router.add('GET', '/api/artifacts', ctx => {
    const q = qs(ctx.url)
    const exists = q.str('exists')
    ctx.send(200, searchArtifacts(db, {
      q: q.str('q'),
      fileType: q.str('type'),
      extension: q.str('ext'),
      projectName: q.str('project'),
      sessionId: q.str('session'),
      parentSessionId: q.str('parent'),
      createdFrom: q.str('from'),
      createdTo: q.str('to'),
      existsState: exists === 'present' || exists === 'missing' ? exists : undefined,
      includeSubagents: q.bool('includeSubagents'),
      sensitive: sensitiveParam(q.str('sensitive')),
    }, q.page()))
  })

  // Both non-parameterized routes below are registered ahead of the /:id/reveal route -- a
  // different segment count means the router would never confuse them, but the ordering is kept
  // consistent with the sessions routes regardless.
  router.add('GET', '/api/artifacts/types', ctx => {
    const rows = db.raw.prepare(
      `SELECT a.file_type, COUNT(*) AS n FROM artifacts a
       WHERE ${SUBAGENT_EXCLUSION_SQL} AND a.is_sensitive = 0
       GROUP BY a.file_type ORDER BY n DESC`
    ).all() as Array<{ file_type: string; n: number }>
    ctx.send(200, rows.map(r => ({ fileType: r.file_type, count: r.n })))
  })

  router.add('GET', '/api/artifacts/recent', ctx => {
    const q = qs(ctx.url)
    const limit = Math.max(1, Math.min(48, q.int('limit') ?? 12))
    ctx.send(200, searchArtifacts(db, { existsState: 'present', sensitive: sensitiveParam(q.str('sensitive')) }, { limit, offset: 0 }).rows)
  })

  router.add('GET', '/api/artifacts/summary', ctx => {
    const r = db.raw.prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT a.project_name) AS projects, COUNT(DISTINCT a.file_type) AS file_types,
              COALESCE(SUM(a.is_sensitive), 0) AS sensitive
       FROM artifacts a WHERE ${SUBAGENT_EXCLUSION_SQL}`,
    ).get() as { total: number; projects: number; file_types: number; sensitive: number }
    ctx.send(200, { total: r.total, projects: r.projects, fileTypes: r.file_types, sensitiveHidden: r.sensitive })
  })

  /**
   * R72 (C1): a location action that could not reach its file answers 409 and records "missing" only with the verifier's
   * proof (recheckKnownLocation: ENOENT/ENOTDIR with the nearest folder on the device the location was last seen on). A
   * permission failure, a symlink loop or an unmounted volume writes nothing: revalidation must not claim missing (spec s12).
   */
  const unreachable = (id: number): HttpError => {
    const probe = recheckKnownLocation(db, id, nowIso(), { recordUnverified: false })
    return probe?.state === 'missing' ? new HttpError(409, 'file missing') : new HttpError(409, 'file not accessible')
  }
  /** lstat (or the opened descriptor) shows something that is not a regular file at the path: the file is not there. */
  const notAFile = (id: number): HttpError => {
    setExistsState(db, id, 'missing', null, nowIso())
    return new HttpError(409, 'file missing')
  }

  /**
   * The path gate shared by preview, open and reveal. Every location action denies a PHI path (R87: the lists hide it, so a known
   * ID must not serve it) and anything isUntrustedPath rejects. A path isIgnoredPath flags (dependency, build and cache names,
   * the user's ignoreSegments, junk suffixes, Atlas/Claude runtime) is denied too, unless it lies under an active registered
   * root: those names are passive-scan exclusions, which must not refuse an explicitly registered output or an indexed location.
   * Such a path is then judged by the registered-root policy, which still refuses secrets, Atlas/Claude runtime, Git internals,
   * symlinks, non-regular files, protected roots and secret-looking names. Callers still lstat and open without following.
   */
  const assertLocationAllowed = (path: string): void => {
    if (hasPhiSegment(path) || isUntrustedPath(path)) throw new HttpError(403, 'path not allowed')
    if (!isIgnoredPath(path)) return
    const auth = authorizeArtifactPath(path, access.activeRoots().map(workerRoot), access.home())
    if (!auth.allowed || auth.protected || !isCanonicalSpelling(path, auth.canonicalPath)) throw new HttpError(403, 'path not allowed')
  }

  // The path is already in canonical form: authorization resolved no link in it. The one tolerated difference is home itself being
  // reached through a symlink (macOS /var -> /private/var), where a file spelled with home's literal prefix and the same path under
  // home's real prefix are the same file; any other difference (a symlinked ancestor inside home) still refuses.
  const isCanonicalSpelling = (path: string, canonical: string | null): boolean => {
    if (canonical === null) return false
    if (canonical === path) return true
    const literal = resolvePath(access.home()).replace(/\/+$/, '')
    let real: string
    try { real = realpathSync.native(literal) } catch { return false }
    return real !== literal && path.startsWith(literal + '/') && canonical === real + path.slice(literal.length)
  }

  // The single trust gate for every route that touches the filesystem. Order matters: path
  // policy first (never stat a path we would refuse), then lstat (never follow a symlink), then
  // the missing-file bookkeeping. Widening any of this widens all three routes at once.
  const resolveFile = (rawId: string | undefined) => {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid artifact id')
    const artifact = getArtifact(db, id)
    if (!artifact) throw new HttpError(404, 'artifact not found')
    if (artifact.isSensitive) throw new HttpError(403, 'path not allowed')
    assertLocationAllowed(artifact.path)
    let stat: Stats
    try { stat = lstatSync(artifact.path) } catch { throw unreachable(id) }
    if (!stat.isFile()) throw notAFile(id)
    return { id, artifact, stat }
  }

  router.add('POST', '/api/artifacts/:id/reveal', async ctx => {
    const id = Number(ctx.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid artifact id')
    const artifact = getArtifact(db, id)
    if (!artifact) throw new HttpError(404, 'artifact not found')
    // Trust boundary (assertLocationAllowed): PHI, anything isUntrustedPath rejects (outside home, home itself, sensitive dirs,
    // symlink-escapes-home-via-realpath) or isIgnoredPath flags (node_modules, .git, the atlas worktrees/db dirs, junk suffixes)
    // outside a registered root, before ever stat-ing the path.
    assertLocationAllowed(artifact.path)
    // lstat, never stat: a symlink sitting at the artifact's path must never be followed and
    // revealed -- it counts as missing, same as a directory. A path that cannot be checked is R72's to judge.
    let stat: Stats
    try { stat = lstatSync(artifact.path) } catch { throw unreachable(id) }
    if (!stat.isFile()) throw notAFile(id)
    await reveal(artifact.path)
    ctx.send(200, { revealed: true })
  })

  // Narrow read endpoint (spec §5.8): only allowlisted extensions are servable, the body is
  // capped, and the content type is exact + nosniff so a browser can never reinterpret it.
  // Every other artifact path in Atlas still reads nothing off disk.
  router.add('GET', '/api/artifacts/:id/preview', async ctx => {
    const { artifact, stat: initialStat } = resolveFile(ctx.params.id)
    const mode = previewModeFor(artifact.extension)
    const type = previewContentType(artifact.extension)
    if ((mode !== 'inline' && mode !== 'tab') || !type) throw new HttpError(415, 'preview not supported for this file type')

    let file
    try {
      file = await openFile(artifact.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      if (isMissingFsError(error)) throw unreachable(artifact.artifactId)
      if (isSymlinkFsError(error)) throw new HttpError(409, 'file changed')
      throw error
    }

    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw notAFile(artifact.artifactId)
      if (!sameFile(initialStat, stat)) throw new HttpError(409, 'file changed')
      if (stat.size > PREVIEW_MAX_BYTES) throw new HttpError(413, 'file too large to preview')
      const body = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < body.length) {
        const result = await file.read(body, offset, body.length - offset, offset)
        // Shorter than its stat while being read: it changed, which proves nothing about its absence.
        if (result.bytesRead <= 0) throw new HttpError(409, 'file changed')
        offset += result.bytesRead
      }
      const headers: Record<string, string | number> = {
        'content-type': type,
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
        // R39: every preview is sandboxed, not only HTML. An inline type such as XML can still run XHTML-namespace script
        // when a browser opens it top-level, and that script would run in Atlas's own origin.
        'content-security-policy': "sandbox; default-src 'none'",
      }
      ctx.res.writeHead(200, headers)
      ctx.res.end(body)
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (isMissingFsError(error)) throw unreachable(artifact.artifactId)
      if (isSymlinkFsError(error)) throw new HttpError(409, 'file changed')
      throw error
    } finally {
      await file.close()
    }
  })

  router.add('POST', '/api/artifacts/:id/open', async ctx => {
    const { artifact, stat } = resolveFile(ctx.params.id)
    if (previewModeFor(artifact.extension) !== 'external') throw new HttpError(415, 'this file type is not opened in an external app')
    // macOS `open` accepts a pathname rather than our checked descriptor; this immediate identity
    // check narrows, but cannot eliminate, the final pathname handoff race.
    let handoff: Stats
    try { handoff = lstatSync(artifact.path) } catch { throw unreachable(artifact.artifactId) }
    if (!handoff.isFile()) throw notAFile(artifact.artifactId)
    if (!sameFile(stat, handoff)) throw new HttpError(409, 'file changed')
    await openWith(artifact.path)
    ctx.send(200, { opened: true })
  })

  registerArtifactManagerRoutes(router, deps, access)
}

// ================================================================================================================ artifact manager

// Grouped document, version, status and root routes (plan 2026-10-26 Task 8; spec sections 8, 9, 12 and 13). They are
// additive: the location-oriented /api/artifacts routes above keep their shapes, their integer artifact IDs and their gates.
//
// Rules every route here follows:
//   - IDs come from the URL as UUIDs and are resolved to registered paths on the server. No route accepts a file path, a Git
//     revision or shell text, except POST /roots, whose whole purpose is to validate and canonicalize one folder.
//   - Protection (spec s4, s12) applies identically to list, totals, detail, preview, export and status: protected documents
//     are hidden unless `sensitive=show|only` asks for them (a hidden document is "not found"), previews of protected or
//     secret-looking files are refused even then, and an export of a protected document goes only to a protected durable root.
//   - List, detail and status read the catalog only: no traversal, hashing, checkout status or Git history. Preview and
//     export are the only routes that touch file contents: a local preview opens one already-authorized path with O_NOFOLLOW
//     and checks the version's stored stat signature before and after reading; a Git preview or export runs ONE helper-free
//     `git cat-file blob <stored blob OID>` through Task 4's adapter with a fixed timeout and an output cap of the route's
//     limit + 1, and serves the bytes only when their length is exactly the stored size; what that read proved about the
//     version's object is recorded in its availability (DEFECT-3). Refresh and root registration only queue background work.
//   - Errors are `{ error: { code, message } }`: stable codes, messages that never echo a path, a parameter value or bytes.
//
// RULING NOTE (cross-task findings, reported): Task 2 exports no lookup from a version to its document, protection, location,
// blob OID, size or stat signature (ArtifactVersionDetail has none of them), and no writer for artifact_manager_state other
// than the pause flag. The read-only version query below is issued here; include-older requests go through the runner's
// requestArtifactRefresh. runArtifactGit applies the caller's output cap to its own
// helper-driver enumeration as well, so a cap as tight as the stored size + 1 makes a small blob's cat-file come back
// `helper-unresolved`; the cap here is therefore the route limit + 1 and the stored size is checked exactly afterwards.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const EXT_PARAM_RE = /^\.?[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/
const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/
const MAX_TEXT_PARAM = 256
const MAX_PROJECT_CHARS = 200
const MAX_OFFSET = 1_000_000_000
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 500
/** Spec s13 / plan Task 8: an export reads and writes at most 64 MiB. */
export const ARTIFACT_EXPORT_MAX_BYTES = 64 * 1024 * 1024
/** The one fixed timeout for the single cat-file a preview or export may run. */
const GIT_READ_TIMEOUT_MS = DEFAULT_GIT_LIMITS.timeoutMs
/** Git reads (preview and export) run one at a time; at most this many wait, first come first served, and the rest get 503. */
const GIT_READ_QUEUE_MAX = 8
const MAX_EXPORT_NAME_ATTEMPTS = 100
/**
 * Export basenames stay well inside the 255-byte NAME_MAX of APFS/ext4: at most 150 UTF-8 bytes of stem, plus `--` and a
 * 12-hex tag (`staged-` for an index version), a `-100` collision suffix and a `.`-plus-16-byte extension: 194 bytes at most.
 */
const MAX_EXPORT_STEM_BYTES = 150
const MAX_NAME_BYTES = 255
const SENSITIVE_VALUES = ['hide', 'show', 'only'] as const
const AVAILABILITY_VALUES = ['local', 'git', 'stale', 'unavailable'] as const
const TYPES_VALUES = ['documents', 'all'] as const
const SOURCE_VALUES: readonly ArtifactEvidenceSource[] = ['hook', 'transcript', 'git', 'watcher', 'reconcile', 'legacy']
const BOOLEAN_VALUES: Readonly<Record<string, boolean>> = { true: true, '1': true, false: false, '0': false }
const SCAN_FLAGS: ReadonlySet<string> = new Set(['checkout', 'configured-output', 'cli-output', 'session-cwd'])
const ROOT_TASK_LABELS: Readonly<Record<string, string>> = { 'checkout-status': 'Checkout scan', 'output-walk': 'Folder scan', 'git-history': 'Git history import' }
/** Path-free explanations for the worker's coverage-gap codes (discovery.ts ARTIFACT_WORKER_GAP_CODES). */
const GAP_TEXT: Readonly<Record<string, string>> = {
  'permission-denied': 'some entries could not be read (permission denied)',
  'unreadable-entry': 'some entries could not be read',
  'path-changed': 'files changed while they were being scanned',
  'git-status-truncated': 'Git output (a checkout status, or the tracked-file snapshot of a folder) exceeded the output limit',
  'git-malformed-output': 'Git returned output that could not be parsed',
  'git-history-gap': 'part of the Git history could not be imported',
  'git-object-unavailable': 'some Git objects are not available locally',
  'git-filter-unresolved': 'Git filters are configured, so working files may differ from what Git reports',
  'nested-worktree': 'nested worktrees are not registered as their own roots yet',
  'nested-checkout': 'nested checkouts (submodules or other repositories) are not scanned as part of this root',
  'unsupported-path': 'some file names cannot be represented exactly',
  'oversized-record': 'some records exceeded the size limit',
  'malformed-record': 'some records were malformed',
  'lookback-limited': 'only recently changed files were imported; use Import older files to include the rest',
}

type Sensitive = (typeof SENSITIVE_VALUES)[number]

/** A structured client error. `code` is a stable token; `message` never carries a path, a parameter value or file bytes. */
class ArtifactApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ArtifactApiError'
    this.status = status
    this.code = code
  }
}

const apiError = (status: number, code: string, message: string) => new ArtifactApiError(status, code, message)
const notFound = () => apiError(404, 'not-found', 'no such document or version')
const protectedError = () => apiError(403, 'protected', 'protected or secret-looking files are never previewed, and are exported only to a protected durable output folder')
const localChanged = () => apiError(409, 'local-version-changed', 'the file changed since this version was recorded; choose its current version')
const localMissing = () => apiError(409, 'local-file-missing', 'the file is not at its recorded location; a recheck has been queued')
const tooLarge = (limit: number) => apiError(413, 'too-large', `the version is larger than the ${limit}-byte limit`)
const gitObjectUnavailable = () => apiError(410, 'git-object-unavailable', 'the Git object for this version is not available locally')
const invalidParameter = (name: string, why: string) => apiError(400, 'invalid-parameter', `${name} ${why}`)
const invalidBody = (why: string) => apiError(400, 'invalid-body', why)

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const scannable = (r: Pick<ArtifactRootRow, 'scopeFlags'>): boolean => r.scopeFlags.some(f => SCAN_FLAGS.has(f))
const token = (value: string | null): string => (value !== null && TOKEN_RE.test(value) ? value : 'error')

/**
 * Spec s4 (I1, R40): protection from any containing root sticks. The canonical paths of every registered root that is
 * protected or has a phi segment, inactive ones included (that only over-protects); a root at or inside one of them is
 * protected, compared separator-aware so /a/b never contains /a/bc. Status, list coverage and durable export roots all use it.
 */
const protectedRootPaths = (registered: readonly ArtifactRootRow[]): string[] => registered.filter(r => r.protected || hasPhiSegment(r.canonicalPath)).map(r => r.canonicalPath)
const insideProtectedRoot = (path: string, protectedPaths: readonly string[]): boolean => protectedPaths.some(p => within(path, p))
/** Secret-looking: a sensitive filename (filetype.ts patterns, including configured extras) or a phi segment anywhere. */
const secretLooking = (path: string): boolean => isSensitiveFilename(basename(path)) || hasPhiSegment(path)

const NS_PER_SECOND = 1_000_000_000n
/** Milliseconds exactly as the discovery worker computes them from BigInt stats (discovery.ts), so signatures compare equal. */
function msOf(ns: bigint): number {
  let sec = ns / NS_PER_SECOND
  let rem = ns % NS_PER_SECOND
  if (rem < 0n) { sec -= 1n; rem += NS_PER_SECOND }
  return Number(sec) * 1e3 + Number(rem) / 1e6
}

type StatSignature = [dev: string, ino: string, size: number, mtimeMs: number, ctimeMs: number]

/** The stored working-version signature (Task 2 stores JSON [dev, ino, size, mtimeMs, ctimeMs]); null when unreadable. */
function parseSignature(raw: string | null): StatSignature | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (Array.isArray(v) && v.length === 5 && typeof v[0] === 'string' && typeof v[1] === 'string' && typeof v[2] === 'number' && typeof v[3] === 'number' && typeof v[4] === 'number') {
      return v as StatSignature
    }
  } catch { /* fall through */ }
  return null
}

function sameSignature(st: BigIntStats, sig: StatSignature): boolean {
  return String(st.dev) === sig[0] && String(st.ino) === sig[1] && Number(st.size) === sig[2] && msOf(st.mtimeNs) === sig[3] && msOf(st.ctimeNs) === sig[4]
}

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8, cut only between code points. */
function truncateUtf8(text: string, maxBytes: number): string {
  let out = ''
  let bytes = 0
  for (const ch of text) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > maxBytes) break
    out += ch
    bytes += n
  }
  return out
}

function errorLabel(e: unknown): string {
  const code = fsCode(e)
  const name = e instanceof Error ? e.name : typeof e
  return code !== undefined && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? `${name} ${code}` : name
}

// ---------------------------------------------------------------------------------------------------------------- parameters

/** One query value: given at most once, bounded, no control characters; blank means absent. The value is never echoed. */
function queryValue(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  if (values.length > 1) throw invalidParameter(name, 'may be given only once')
  const raw = values[0]
  if (raw === undefined) return undefined
  if (raw.length > MAX_TEXT_PARAM || CONTROL_RE.test(raw)) throw invalidParameter(name, 'is malformed')
  const v = raw.trim()
  return v === '' ? undefined : v
}

function enumValue<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const v = queryValue(url, name)
  if (v === undefined) return undefined
  if (!(allowed as readonly string[]).includes(v)) throw invalidParameter(name, `must be one of: ${allowed.join(', ')}`)
  return v as T
}

/** A non-negative decimal integer in [min, max]; above max it is capped when `cap`, else refused. */
function intValue(url: URL, name: string, min: number, max: number, cap: boolean): number | undefined {
  const v = queryValue(url, name)
  if (v === undefined) return undefined
  if (!/^\d{1,16}$/.test(v)) throw invalidParameter(name, 'must be a whole number')
  const n = Number(v)
  if (n < min) throw invalidParameter(name, `must be at least ${min}`)
  if (n > max) {
    if (cap) return max
    throw invalidParameter(name, `must be at most ${max}`)
  }
  return n
}

function timeValue(url: URL, name: string): string | undefined {
  const v = queryValue(url, name)
  if (v === undefined) return undefined
  const t = Date.parse(v)
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || !Number.isFinite(t)) throw invalidParameter(name, 'must be an ISO date or timestamp')
  return new Date(t).toISOString()
}

const sensitiveValue = (url: URL): Sensitive => enumValue(url, 'sensitive', SENSITIVE_VALUES) ?? 'hide'
/** The list rule, applied to single documents too: hide shows unprotected only, only shows protected only, show shows both. */
const visible = (isProtected: boolean, sensitive: Sensitive): boolean => sensitive === 'show' || (sensitive === 'only' ? isProtected : !isProtected)

function idParam(ctx: RouteContext): string {
  const id = ctx.params.id ?? ''
  if (!UUID_RE.test(id)) throw apiError(400, 'invalid-id', 'expected an ID in UUID form')
  return id.toLowerCase()
}

/** A JSON object body with only `allowed` keys; an empty body counts as {}. Keys and values are never echoed. */
async function jsonBody(ctx: RouteContext, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const raw = await ctx.json<unknown>()
  if (raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalidBody('the request body must be a JSON object')
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some(k => !allowed.includes(k))) {
    throw invalidBody(allowed.length > 0 ? `the request body accepts only: ${allowed.join(', ')}` : 'this request takes no body fields')
  }
  return body
}

// ---------------------------------------------------------------------------------------------------------------- records

type VersionRecord = {
  version_id: string; document_id: string; kind: 'working' | 'commit' | 'index'; location_artifact_id: number | null; repository_id: string | null
  checkout_identity: string | null; git_path: string | null; object_format: string | null; blob_oid: string | null; commit_oid: string | null
  size_bytes: number | null; stat_signature: string | null; protected: number; display_name: string
}
type LocationRecord = { artifact_id: number; path: string; root_id: string | null; is_sensitive: number; current_version_id: string | null }

const workerRoot = (r: ArtifactRootRow): ArtifactWorkerRoot => ({
  rootId: r.rootId, kind: r.kind, canonicalPath: r.canonicalPath, repositoryId: r.repositoryId, checkoutIdentity: r.checkoutIdentity, protected: r.protected, scopeFlags: r.scopeFlags,
})

type RootStatusView = {
  rootId: string
  kind: ArtifactRootRow['kind']
  path: string | null
  pathRedacted: boolean
  protected: boolean
  projectName: string | null
  /** The repository the root belongs to (a random UUID, so not sensitive: it stays when the path is redacted); null for none. */
  repositoryId: string | null
  scopeFlags: ArtifactRootRow['scopeFlags']
  directOnly: boolean
  state: ArtifactRootCoverageState
  generation: number
  cursor: string | null
  completedAt: string | null
  lastSuccessfulAt: string | null
  oldestQueuedAgeMs: number
  lastError: string | null
  gaps: string[]
  failures: Array<{ task: string; code: string }>
  includeOlderPending: boolean
  reason: string | null
}

/** One human, path-free sentence per known cause of a root's state; null when the root is idle with nothing to explain. */
function rootReason(s: Pick<RootStatusView, 'state' | 'lastError' | 'gaps' | 'failures' | 'includeOlderPending' | 'directOnly' | 'lastSuccessfulAt'>): string | null {
  const parts: string[] = []
  for (const f of s.failures) parts.push(`${ROOT_TASK_LABELS[f.task] ?? 'Scan'} failed (${f.code}); use Refresh to retry.`)
  if (s.state === 'inaccessible') parts.push(`The folder is inaccessible${s.lastError ? ` (${s.lastError})` : ''}; check that it exists and is readable.`)
  else if (s.state === 'failed') parts.push(`The last scan failed${s.lastError ? ` (${s.lastError})` : ''}; use Refresh to retry.`)
  if (s.gaps.length > 0) parts.push(`Partial coverage: ${s.gaps.map(g => GAP_TEXT[g] ?? `incomplete (${g})`).join('; ')}.`)
  if (s.includeOlderPending) parts.push('Importing older files.')
  if (s.state === 'partial' && s.gaps.length === 0) parts.push('The scan is incomplete and resumes automatically.')
  else if (s.state === 'queued') parts.push('Waiting to scan.')
  else if (s.state === 'scanning') parts.push('Scanning.')
  if (s.directOnly) parts.push('Only directly observed files are recorded; this folder is never bulk-scanned.')
  else if (s.state === 'idle' && s.lastSuccessfulAt === null && s.failures.length === 0) parts.push('Not scanned yet.')
  return parts.length > 0 ? parts.join(' ') : null
}

function registerArtifactManagerRoutes(router: Router, deps: ArtifactRouteDeps, access: RootAccess): void {
  const { db, log } = deps
  const now = deps.now ?? nowIso
  const runGit = deps.runGit ?? runArtifactGit
  const open = deps.fs?.open ?? ((path: string, flags: number, mode?: number) => openFile(path, flags, mode))
  const { home, cfg, activeRoots } = access

  const route = (method: string, pattern: string, handler: (ctx: RouteContext) => Promise<void> | void): void => {
    router.add(method, pattern, async ctx => {
      try {
        await handler(ctx)
      } catch (err) {
        if (ctx.res.headersSent) { ctx.res.end(); return }
        if (err instanceof ArtifactApiError) ctx.send(err.status, { error: { code: err.code, message: err.message } })
        else if (err instanceof ArtifactDocumentNotFoundError) ctx.send(404, { error: { code: 'not-found', message: 'no such document or version' } })
        // readJsonBody's own errors: an oversized or unparsable body.
        else if (err instanceof HttpError) ctx.send(err.status, { error: err.status === 413 ? { code: 'body-too-large', message: 'the request body is too large' } : { code: 'invalid-body', message: 'the request body is not valid JSON' } })
        else {
          log.error('artifact manager route failed', { route: pattern, error: errorLabel(err) })
          ctx.send(500, { error: { code: 'internal-error', message: 'internal error' } })
        }
      }
    })
  }

  // One Git blob read at a time, shared by preview and export: a FIFO of at most GIT_READ_QUEUE_MAX waiters. An export keeps the
  // slot through its write and fsync as well, so at most one blob buffer (each up to 64 MiB) is alive and a slow disk turns
  // into 503 `busy` instead of growing memory. The slot is released on every path (finally), and a finishing holder hands it
  // straight to the next waiter, so a newcomer can never overtake the queue.
  let gitReading = false
  const gitWaiters: Array<() => void> = []
  const withGitSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (gitReading) {
      if (gitWaiters.length >= GIT_READ_QUEUE_MAX) throw apiError(503, 'busy', 'Atlas is reading other Git versions right now; try again shortly')
      await new Promise<void>(resolve => gitWaiters.push(resolve))
    } else {
      gitReading = true
    }
    try {
      return await fn()
    } finally {
      const next = gitWaiters.shift()
      if (next) next()
      else gitReading = false
    }
  }

  // ------------------------------------------------------------------------------------------------------------ status

  /** Task 2's coverage plus the runner's reasons, failures, include-older flags, facility and health; protected paths redacted under hide. */
  const managerStatus = (sensitive: Sensitive) => {
    const base = getArtifactManagerStatus(db, now())
    const registered = listArtifactRoots(db)
    const rows = new Map(registered.map(r => [r.rootId, r]))
    const protectedPaths = protectedRootPaths(registered)
    // R71: the runner's coverage notes through their one definition (src/db/artifact-manager.ts).
    const notes = listArtifactCoverageNotes(db)
    const failures = new Map<string, Array<{ task: string; code: string }>>()
    const refused = artifactRefusedDirectories(cfg())
    const failed = db.raw.prepare(`SELECT key, value FROM artifact_manager_state WHERE key LIKE 'job-failed:%' ORDER BY key`).all() as Array<{ key: string; value: string }>
    for (const { key, value } of failed) {
      const rest = key.slice('job-failed:'.length)
      const i = rest.indexOf(':')
      const task = rest.slice(0, i)
      if (i > 0 && Object.hasOwn(ROOT_TASK_LABELS, task)) failures.set(rest.slice(i + 1), [...(failures.get(rest.slice(i + 1)) ?? []), { task, code: token(value) }])
    }
    const health: Record<string, number> = {}
    for (const [key, value] of Object.entries(readArtifactManagerHealth(db))) {
      if (key.startsWith('health.') && /^-?\d{1,15}$/.test(value)) health[key.slice('health.'.length)] = Number(value)
    }
    const facility = readArtifactManagerState(db, 'worker.priority-facility')
    // R47 (PERF-GAP-2): every root's include-older flag in one pass, linear in the number of roots.
    const olderPending = includeOlderPendingRoots(db, registered, refused)
    const roots: RootStatusView[] = []
    for (const r of base.roots) {
      const row = rows.get(r.rootId)
      if (!row) continue
      const isProtected = insideProtectedRoot(row.canonicalPath, protectedPaths)
      if (sensitive === 'only' && !isProtected) continue
      const redact = isProtected && sensitive === 'hide'
      const rootNotes = notes.get(r.rootId) ?? []
      const view: RootStatusView = {
        rootId: r.rootId, kind: row.kind, path: redact ? null : row.canonicalPath, pathRedacted: redact, protected: isProtected,
        // A project label is often the folder's own name: redacted with the path.
        projectName: redact ? null : row.projectName, repositoryId: row.repositoryId,
        scopeFlags: row.scopeFlags, directOnly: !scannable(row), state: r.state, generation: r.generation, cursor: r.cursor, completedAt: r.completedAt,
        lastSuccessfulAt: row.lastSuccessfulAt, oldestQueuedAgeMs: r.oldestQueuedAgeMs, lastError: r.reason === null ? null : token(r.reason),
        gaps: [...new Set(rootNotes.flatMap(n => n.codes))].sort(), failures: failures.get(r.rootId) ?? [], includeOlderPending: olderPending.has(r.rootId), reason: null,
      }
      view.reason = rootReason(view)
      roots.push(view)
    }
    return {
      paused: base.paused, pendingJobs: base.pendingJobs, oldestQueueAgeMs: base.oldestQueueAgeMs,
      priorityFacility: facility !== null && TOKEN_RE.test(facility) ? facility : null, health, roots,
    }
  }

  // ------------------------------------------------------------------------------------------------------------ documents

  route('GET', '/api/artifact-documents', ctx => {
    const url = ctx.url
    const sensitive = sensitiveValue(url)
    const filters: ArtifactDocumentFilters = { sensitive, types: enumValue(url, 'types', TYPES_VALUES) ?? 'documents' }
    const q = queryValue(url, 'q')
    if (q !== undefined) filters.q = q
    const project = queryValue(url, 'project')
    if (project !== undefined) {
      if (project.length > MAX_PROJECT_CHARS) throw invalidParameter('project', 'is too long')
      filters.project = project
    }
    const ext = queryValue(url, 'ext')
    if (ext !== undefined) {
      if (!EXT_PARAM_RE.test(ext)) throw invalidParameter('ext', 'must be a file extension')
      filters.extension = ext
    }
    const from = timeValue(url, 'from')
    if (from !== undefined) filters.from = from
    const to = timeValue(url, 'to')
    if (to !== undefined) filters.to = to
    const session = queryValue(url, 'session')
    if (session !== undefined) {
      if (!isValidSessionId(session)) throw invalidParameter('session', 'must be a session ID')
      filters.sessionId = session
    }
    const availability = enumValue(url, 'availability', AVAILABILITY_VALUES)
    if (availability !== undefined) filters.availability = availability
    const needs = queryValue(url, 'needsPreservation')
    if (needs !== undefined) {
      const flag = Object.hasOwn(BOOLEAN_VALUES, needs) ? BOOLEAN_VALUES[needs] : undefined
      if (flag === undefined) throw invalidParameter('needsPreservation', 'must be true or false')
      filters.needsPreservation = flag
    }
    const source = enumValue(url, 'source', SOURCE_VALUES)
    if (source !== undefined) filters.source = source
    const limit = intValue(url, 'limit', 1, MAX_PAGE_LIMIT, true) ?? DEFAULT_PAGE_LIMIT
    const offset = intValue(url, 'offset', 0, MAX_OFFSET, false) ?? 0
    const page = listArtifactDocuments(db, filters, { limit, offset })
    ctx.send(200, { rows: page.rows, total: page.total, limit: page.limit, offset: page.offset, coverage: managerStatus(sensitive === 'hide' ? 'hide' : 'show') })
  })

  route('GET', '/api/artifact-documents/:id', ctx => {
    const id = idParam(ctx)
    const url = ctx.url
    const sensitive = sensitiveValue(url)
    const limit = intValue(url, 'limit', 1, MAX_PAGE_LIMIT, true) ?? DEFAULT_PAGE_LIMIT
    const offsets = {
      locations: intValue(url, 'locationsOffset', 0, MAX_OFFSET, false) ?? 0,
      versions: intValue(url, 'versionsOffset', 0, MAX_OFFSET, false) ?? 0,
      evidence: intValue(url, 'evidenceOffset', 0, MAX_OFFSET, false) ?? 0,
    }
    // Throws ArtifactDocumentNotFoundError (404) for an unknown ID; a retired group ID resolves through its alias.
    const first = getArtifactDocument(db, id, { limit, offset: offsets.locations })
    if (!visible(first.document.protected || first.locations.some(l => l.isSensitive) || artifactDocumentHasPhiPath(db, first.document.documentId), sensitive)) throw notFound()
    const documentId = first.document.documentId
    const at = (offset: number) => (offset === offsets.locations ? first : getArtifactDocument(db, documentId, { limit, offset }))
    const versions = at(offsets.versions)
    const evidence = offsets.evidence === offsets.versions ? versions : at(offsets.evidence)
    ctx.send(200, {
      document: first.document, locations: first.locations, versions: versions.versions, evidence: evidence.evidence,
      next: { locations: first.next.locations, versions: versions.next.versions, evidence: evidence.next.evidence }, limit, offsets,
    })
  })

  // ------------------------------------------------------------------------------------------------------------ versions

  /** The version and its document, enforcing the list's protection rule: a document hidden by `sensitive` is not found. */
  const versionFor = (id: string, sensitive: Sensitive): VersionRecord => {
    const v = db.raw.prepare(`SELECT v.version_id, v.document_id, v.kind, v.location_artifact_id, v.repository_id, v.checkout_identity, v.git_path, v.object_format,
        v.blob_oid, v.commit_oid, v.size_bytes, v.stat_signature, d.protected, d.display_name
      FROM artifact_versions v JOIN artifact_documents d ON d.document_id = v.document_id WHERE v.version_id = ?`).get(id) as VersionRecord | undefined
    if (!v) throw notFound()
    // The flag can be stale (a row written before the `.phi` rule widened): a PHI path protects the version's document whatever it says.
    if (v.protected !== 1 && artifactDocumentHasPhiPath(db, v.document_id)) v.protected = 1
    if (!visible(v.protected === 1, sensitive)) throw notFound()
    return v
  }

  const locationFor = (v: VersionRecord): LocationRecord | null => (v.location_artifact_id === null ? null
    : (db.raw.prepare('SELECT artifact_id, path, root_id, is_sensitive, current_version_id FROM artifacts WHERE artifact_id = ?').get(v.location_artifact_id) as LocationRecord | undefined) ?? null)

  /** Spec s12 "attempt revalidation when selected": a changed or missing local file queues one direct observation of it. */
  const requestRecheck = (loc: LocationRecord): void => {
    if (loc.root_id === null) return
    try {
      enqueueArtifactJob(db, { scopeId: artifactDirectScopeId(loc.root_id, loc.path), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 0 }, now())
    } catch (err) {
      log.warn('artifact recheck could not be queued', { error: errorLabel(err) })
    }
  }

  /**
   * The exact bytes of a current local version: the location re-authorized against the registered roots now, opened without
   * following a symlink, and its stat signature checked before and after the read. Any difference is a conflict, never the
   * new bytes under the old version's ID.
   */
  const readLocalVersion = async (v: VersionRecord, loc: LocationRecord): Promise<Buffer> => {
    if (loc.current_version_id !== v.version_id) throw localChanged()
    const signature = parseSignature(v.stat_signature)
    if (signature === null) throw localChanged()
    if (signature[2] > PREVIEW_MAX_BYTES) throw tooLarge(PREVIEW_MAX_BYTES)
    const auth = authorizeArtifactPath(loc.path, activeRoots().map(workerRoot), home())
    if (auth.protected) throw protectedError()
    if (!auth.allowed) {
      if (auth.reason === 'file-symlink' || auth.reason === 'not-regular-file') { requestRecheck(loc); throw localChanged() }
      throw apiError(403, 'path-not-allowed', 'this location is not inside a registered, accessible root')
    }
    if (auth.canonicalPath !== loc.path) throw localChanged()

    let file
    try {
      file = await open(loc.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0))
    } catch (error) {
      requestRecheck(loc)
      if (isMissingFsError(error)) throw localMissing()
      if (isSymlinkFsError(error)) throw localChanged()
      throw apiError(409, 'local-file-unreadable', 'the file could not be opened')
    }
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || !sameSignature(before, signature)) { requestRecheck(loc); throw localChanged() }
      const size = Number(before.size)
      const body = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const { bytesRead } = await file.read(body, offset, size - offset, offset)
        if (bytesRead <= 0) throw localChanged()
        offset += bytesRead
      }
      if (!sameSignature(await file.stat({ bigint: true }), signature)) { requestRecheck(loc); throw localChanged() }
      return body
    } finally {
      await file.close()
    }
  }

  /** A registered checkout of the repository to run Git in: the version's own checkout first, re-validated now. */
  const gitRepositoryPath = (repositoryId: string, checkoutIdentity: string | null): string | null => {
    const h = home()
    const checkouts = activeRoots().filter(r => r.kind === 'checkout' && r.repositoryId === repositoryId)
      .sort((a, b) => Number(b.checkoutIdentity === checkoutIdentity) - Number(a.checkoutIdentity === checkoutIdentity) || byText(a.canonicalPath, b.canonicalPath))
    for (const r of checkouts) {
      const c = canonicalizeArtifactRoot(r.canonicalPath, h)
      if (!('error' in c) && c.exists && c.canonicalPath === r.canonicalPath) return r.canonicalPath
    }
    return null
  }

  type GitBlobRequest = { versionId: string; repositoryId: string; checkoutIdentity: string | null; oid: string; size: number; limit: number }

  /**
   * DEFECT-3: what a read proved about a commit or index version's object goes into its stored availability, so the catalog
   * stops offering a version it cannot serve (spec s8): a blob of another size is proof (`mismatch`), a failed read is not
   * (`unreadable`: no longer offered, never claimed missing; the background object check settles it), exact bytes are proof
   * of presence. Never fails the request that learned it.
   */
  const noteGitObject = (versionId: string, object: ArtifactGitObjectCheck['object']): void => {
    try {
      recordArtifactGitObjectChecks(db, [{ versionId, object }], now())
    } catch (err) {
      log.warn('artifact version availability could not be recorded', { error: errorLabel(err) })
    }
  }
  type GitBlob = { body: Buffer; filterState: GitResult['filterState'] }

  /** A commit or index version's stored blob identity, validated without any I/O: refused before a Git slot is taken. */
  const gitBlobRequest = (v: VersionRecord, limit: number): GitBlobRequest => {
    const format = v.object_format
    if ((format !== 'sha1' && format !== 'sha256') || !isGitOid(v.blob_oid, format) || v.repository_id === null
      || v.size_bytes === null || !Number.isInteger(v.size_bytes) || v.size_bytes < 0) {
      // A stored identity that can never name a readable blob.
      noteGitObject(v.version_id, 'mismatch')
      throw gitObjectUnavailable()
    }
    if (v.size_bytes > limit) throw tooLarge(limit)
    return { versionId: v.version_id, repositoryId: v.repository_id, checkoutIdentity: v.kind === 'index' ? v.checkout_identity : null, oid: v.blob_oid, size: v.size_bytes, limit }
  }

  /**
   * The stored blob, by its stored OID only: one `git cat-file blob <oid>` with a fixed timeout and an output cap of the
   * route's limit + 1; a blob whose length is not exactly the stored size is refused. An LFS pointer is not the document.
   * Callers run this inside withGitSlot.
   */
  const readGitBlobInSlot = async (req: GitBlobRequest): Promise<GitBlob> => {
    const repoPath = gitRepositoryPath(req.repositoryId, req.checkoutIdentity)
    // Fix round 2: pinned to the recorded common dir, like the object check, so a checkout whose .git is gone never reads from
    // an enclosing repository and the route and the check agree.
    const commonDir = (db.raw.prepare('SELECT common_dir FROM artifact_repositories WHERE repository_id = ?').get(req.repositoryId) as { common_dir: string } | undefined)?.common_dir
    if (repoPath === null || commonDir === undefined) {
      // I5 (fix round 1): with no checkout to read it from, the version is no longer offered as available (unverified, not missing).
      noteGitObject(req.versionId, 'unreadable')
      throw apiError(409, 'git-repository-unavailable', 'no registered checkout of this repository is available to read the version from')
    }
    // PERF-GAP-4 (R63): the stored size lets the adapter collect the blob into one buffer (no second whole-blob copy).
    const result = await runGit(repoPath, ['cat-file', 'blob', req.oid], { timeoutMs: GIT_READ_TIMEOUT_MS, maxOutputBytes: req.limit + 1 }, { expectedBytes: req.size, gitDir: commonDir })
    if (result.error !== null) {
      // stderr can name paths: it is classified here and never forwarded.
      if (result.error === 'exit-nonzero' && /dubious ownership/i.test(result.stderr)) {
        throw apiError(409, 'unsafe-repository', 'Git refuses this repository because another user owns it; Atlas will not override that')
      }
      if (result.error === 'exit-nonzero') { noteGitObject(req.versionId, 'unreadable'); throw gitObjectUnavailable() }
      // More bytes than the stored size allows: the object is not the stored blob.
      if (result.error === 'output-cap') { noteGitObject(req.versionId, 'mismatch'); throw gitObjectUnavailable() }
      throw apiError(503, 'git-unavailable', 'Git could not read the version right now; try again later')
    }
    const body = result.stdout
    if (body.length !== req.size) { noteGitObject(req.versionId, 'mismatch'); throw gitObjectUnavailable() }
    noteGitObject(req.versionId, 'present')
    if (body.length <= GIT_LFS_POINTER_MAX_BYTES && isGitLfsPointer(body)) {
      throw apiError(410, 'lfs-payload-unavailable', 'this Git version is a Git LFS pointer; its payload has not been fetched')
    }
    return { body, filterState: result.filterState }
  }

  route('GET', '/api/artifact-versions/:id/preview', async ctx => {
    // Same-origin: a cross-site browser request (img, script, form) never receives document bytes.
    const site = ctx.req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw apiError(403, 'cross-origin', 'previews are served only to Atlas itself')
    const id = idParam(ctx)
    const v = versionFor(id, sensitiveValue(ctx.url))
    // Spec s4: previews are disabled for protected and secret-looking files, whatever the view filter.
    if (v.protected === 1) throw protectedError()
    const loc = v.kind === 'working' ? locationFor(v) : null
    if (v.kind === 'working' && loc === null) throw localChanged()
    const source = loc?.path ?? v.git_path
    if (source === null || secretLooking(source) || loc?.is_sensitive === 1) throw protectedError()
    const extension = extname(basename(source)).slice(1)
    const mode = previewModeFor(extension)
    const type = previewContentType(extension)
    if ((mode !== 'inline' && mode !== 'tab') || !type) throw apiError(415, 'preview-unsupported', 'this file type cannot be previewed')
    let body: Buffer
    if (loc !== null) {
      body = await readLocalVersion(v, loc)
    } else {
      const req = gitBlobRequest(v, PREVIEW_MAX_BYTES)
      body = (await withGitSlot(() => readGitBlobInSlot(req))).body
    }
    const headers: Record<string, string | number> = {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
      // R39: every preview response is sandboxed, whatever its type (inline XML can carry XHTML script).
      'content-security-policy': "sandbox; default-src 'none'",
    }
    ctx.res.writeHead(200, headers)
    ctx.res.end(body)
  })

  // ------------------------------------------------------------------------------------------------------------ export

  /**
   * The durable output roots a version of `repositoryId` may be exported to: active output roots registered for that
   * repository at or under the configured durable base (canonical), outside every registered checkout. A root is protected
   * by the same containment rule as status (R40): its own flag, or any protected (or phi) root at or above it. A protected
   * document goes only to a protected root; an unprotected one prefers an unprotected root. Shallowest, then smallest root ID.
   */
  const durableRootFor = (repositoryId: string, isProtected: boolean): { root: ArtifactRootRow; protected: boolean } => {
    const base = canonicalizeArtifactRoot(cfg().artifacts.durableOutputBase, home())
    const protectedPaths = protectedRootPaths(listArtifactRoots(db))
    const roots = activeRoots()
    const checkouts = roots.filter(r => r.kind === 'checkout')
    const candidates = ('error' in base ? [] : roots.filter(r => r.kind === 'output' && r.repositoryId === repositoryId && within(r.canonicalPath, base.canonicalPath)
      && !checkouts.some(c => within(r.canonicalPath, c.canonicalPath)))).map(r => ({ root: r, protected: insideProtectedRoot(r.canonicalPath, protectedPaths) }))
    const eligible = candidates.filter(c => !isProtected || c.protected)
      .sort((a, b) => Number(a.protected) - Number(b.protected) || a.root.canonicalPath.length - b.root.canonicalPath.length || byText(a.root.rootId, b.root.rootId))
    const chosen = eligible[0]
    if (chosen) return chosen
    if (isProtected && candidates.length > 0) throw protectedError()
    throw apiError(409, 'no-output-root', 'this project has no registered durable output folder; create one with npm run artifacts -- output-dir --repo <checkout> --create')
  }

  /** The destination must still be the registered real directory, private to this user, under home and policy. */
  const checkDurableRoot = (root: ArtifactRootRow): void => {
    const unavailable = () => apiError(409, 'output-root-unavailable', 'the durable output folder is missing, moved or not a real folder; register it again')
    const c = canonicalizeArtifactRoot(root.canonicalPath, home())
    if ('error' in c || !c.exists || c.canonicalPath !== root.canonicalPath) throw unavailable()
    if (isArtifactRootRefused(root.canonicalPath, artifactRefusedDirectories(cfg()))) throw unavailable()
    let st: Stats
    try { st = lstatSync(root.canonicalPath) } catch { throw unavailable() }
    if (!st.isDirectory()) throw unavailable()
    const uid = process.getuid?.()
    if ((st.mode & 0o077) !== 0 || (uid !== undefined && st.uid !== uid)) {
      throw apiError(409, 'output-root-not-private', 'the durable output folder must be private to you (mode 0700); fix its permissions and retry')
    }
  }

  /** `<stem>--<commit12>` or `<stem>--staged-<blob12>`: built only from stored metadata, never from the request. */
  const exportName = (v: VersionRecord): { stem: string; extension: string } => {
    const leaf = basename(v.git_path ?? v.display_name)
    const dot = extname(leaf)
    const cleaned = (dot ? leaf.slice(0, -dot.length) : leaf).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s-]+/, '').trim()
    const stem = truncateUtf8(cleaned, MAX_EXPORT_STEM_BYTES).trim() || 'document'
    const commit = v.commit_oid !== null && /^[0-9a-f]{12}/.test(v.commit_oid) ? v.commit_oid.slice(0, 12) : 'commit'
    const tag = v.kind === 'index' ? `staged-${(v.blob_oid ?? '').slice(0, 12)}` : commit
    const extension = dot.slice(1).toLowerCase()
    return { stem: `${stem}--${tag}`, extension: /^[a-z0-9]{1,16}$/.test(extension) ? extension : '' }
  }

  /** Creates a new private file (O_CREAT|O_EXCL|O_NOFOLLOW, 0600): an existing name or a planted symlink is skipped, never replaced. */
  const writeExclusive = async (dir: string, stem: string, extension: string, body: Buffer): Promise<string> => {
    for (let n = 1; n <= MAX_EXPORT_NAME_ATTEMPTS; n++) {
      const name = `${stem}${n > 1 ? `-${n}` : ''}${extension ? `.${extension}` : ''}`
      if (Buffer.byteLength(name) > MAX_NAME_BYTES) throw apiError(409, 'export-failed', 'the generated export name is too long')
      const target = join(dir, name)
      let file
      try {
        file = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      } catch (error) {
        if (fsCode(error) === 'EEXIST' || fsCode(error) === 'ELOOP') continue
        throw apiError(409, 'export-failed', 'the export could not be created in the durable output folder')
      }
      let created: Stats | null = null
      let ok = false
      try {
        created = await file.stat()
        // The new file must be at `name` inside the real registered folder (no directory swapped for a symlink since the
        // folder was checked) before any byte is written, and still be there once the bytes are durable.
        const placed = (st: Stats): boolean => {
          const at = lstatSync(target)
          return realpathSync.native(dir) === dir && at.isFile() && at.dev === st.dev && at.ino === st.ino
        }
        if (placed(created)) {
          await file.chmod(0o600)
          await file.writeFile(body)
          await file.sync()
          ok = placed(created)
        }
      } catch (error) {
        log.warn('artifact export write failed', { error: errorLabel(error) })
      } finally {
        await file.close()
      }
      if (ok) return name
      // Remove only the file this call created, identified by device and inode.
      try {
        const current = lstatSync(target)
        if (created && current.isFile() && current.dev === created.dev && current.ino === created.ino) await unlink(target)
      } catch { /* already gone */ }
      throw apiError(409, 'export-failed', 'the export could not be written completely; nothing was kept')
    }
    throw apiError(409, 'export-name-exhausted', 'too many exports of this version already exist; remove some and retry')
  }

  route('POST', '/api/artifact-versions/:id/export', async ctx => {
    const id = idParam(ctx)
    const sensitive = sensitiveValue(ctx.url)
    // The destination and the name are server-resolved: the body takes no fields at all.
    await jsonBody(ctx, [])
    const v = versionFor(id, sensitive)
    if (v.kind === 'working') throw apiError(409, 'version-not-exportable', 'only committed or staged Git versions can be exported; a working file is opened or previewed in place')
    if (v.git_path === null || v.repository_id === null) throw gitObjectUnavailable()
    // Secret-looking files are never copied; a protected document needs a protected durable root (checked below).
    if (isSensitiveFilename(basename(v.git_path))) throw protectedError()
    const isProtected = v.protected === 1 || hasPhiSegment(v.git_path)
    const req = gitBlobRequest(v, ARTIFACT_EXPORT_MAX_BYTES)
    const { root, protected: rootProtected } = durableRootFor(v.repository_id, isProtected)
    checkDurableRoot(root)
    const { stem, extension } = exportName(v)
    // The Git slot covers the read, the re-check and the write with its fsync: one export buffer is alive at a time, and the
    // slot is released on every path (withGitSlot's finally), including a failed check, write, fsync or cleanup.
    const written = await withGitSlot(async () => {
      let blob: GitBlob | null = await readGitBlobInSlot(req)
      try {
        // Re-checked after the asynchronous read, immediately before the exclusive create.
        checkDurableRoot(root)
        const fileName = await writeExclusive(root.canonicalPath, stem, extension, blob.body)
        return { fileName, sizeBytes: blob.body.length, filterState: blob.filterState }
      } finally {
        blob = null
      }
    })
    const fileName = written.fileName
    const path = join(root.canonicalPath, fileName)
    // The export is an ordinary file in an output root: queue its observation instead of writing catalog rows here.
    try {
      enqueueArtifactJob(db, { scopeId: artifactDirectScopeId(root.rootId, path), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 0 }, now())
    } catch (err) {
      log.warn('artifact export observation could not be queued', { error: errorLabel(err) })
    }
    // R40: under hide, the path of a protected durable root (or of one inside a protected root) is not revealed.
    const redact = rootProtected && sensitive === 'hide'
    ctx.send(201, {
      versionId: v.version_id, kind: v.kind, rootId: root.rootId, fileName, path: redact ? null : path, pathRedacted: redact, sizeBytes: written.sizeBytes,
      filterState: written.filterState,
    })
  })

  // ------------------------------------------------------------------------------------------------------------ manager

  route('GET', '/api/artifact-manager/status', ctx => {
    ctx.send(200, managerStatus(sensitiveValue(ctx.url)))
  })

  route('POST', '/api/artifact-manager/refresh', async ctx => {
    const body = await jsonBody(ctx, ['rootId', 'includeOlder'])
    if (typeof body.rootId !== 'string' || !UUID_RE.test(body.rootId)) throw invalidBody('rootId must be a registered root ID')
    if (body.includeOlder !== undefined && typeof body.includeOlder !== 'boolean') throw invalidBody('includeOlder must be true or false')
    const rootId = body.rootId.toLowerCase()
    const includeOlder = body.includeOlder === true
    const roots = listArtifactRoots(db)
    const root = roots.find(r => r.rootId === rootId)
    const refused = artifactRefusedDirectories(cfg())
    if (!root) throw apiError(404, 'root-not-found', 'no registered root has this ID')
    if (!root.active) throw apiError(409, 'root-inactive', 'this root is inactive; register it again to scan it')
    if (isArtifactRootRefused(root.canonicalPath, refused)) throw apiError(409, 'root-refused', 'this root overlaps Atlas data and is never scanned')
    if (!scannable(root)) throw apiError(409, 'direct-only-root', 'this root records only directly observed files and is never bulk-scanned')
    if (root.kind === 'checkout' && (root.repositoryId === null || root.checkoutIdentity === null)) {
      throw apiError(409, 'root-not-scannable', 'this checkout has no resolved Git identity yet')
    }
    // Queue only: the runner's helper enqueues the scopes it schedules (and the per-task include-older requests); nothing is
    // traversed, stat-ed or run in this request.
    const queued = requestArtifactRefresh(db, root.rootId, { includeOlder, now: now(), refused })
    ctx.send(202, { jobId: queued.jobId, rootId: root.rootId, includeOlder, historyJobId: queued.historyJobId, paused: isArtifactDiscoveryPaused(db) })
  })

  for (const [path, paused] of [['/api/artifact-manager/pause', true], ['/api/artifact-manager/resume', false]] as const) {
    route('POST', path, async ctx => {
      await jsonBody(ctx, [])
      setArtifactDiscoveryPaused(db, paused, now())
      ctx.send(200, { paused })
    })
  }

  route('POST', '/api/artifact-manager/roots', async ctx => {
    const body = await jsonBody(ctx, ['path', 'repo', 'repositoryId', 'label', 'protected'])
    if (typeof body.path !== 'string' || body.path === '') throw invalidBody('path must be an absolute folder path')
    if (body.repo !== undefined && (typeof body.repo !== 'string' || body.repo === '')) throw invalidBody('repo must be an absolute checkout path')
    if (body.repositoryId !== undefined && (typeof body.repositoryId !== 'string' || !UUID_RE.test(body.repositoryId))) throw invalidBody('repositoryId must be a repository ID')
    if (body.repo !== undefined && body.repositoryId !== undefined) throw invalidBody('give repo or repositoryId, not both')
    if (body.label !== undefined && (typeof body.label !== 'string' || !body.label.trim() || body.label.length > MAX_PROJECT_CHARS || CONTROL_RE.test(body.label))) {
      throw invalidBody('label must be a short single line')
    }
    if (body.protected !== undefined && typeof body.protected !== 'boolean') throw invalidBody('protected must be true or false')
    if (!body.path.startsWith('/')) throw apiError(400, 'root-relative', 'the folder path must be absolute')
    const h = home()
    const c = canonicalizeArtifactRoot(body.path, h)
    if ('error' in c) {
      if (c.error === 'symlink-escape') throw apiError(403, 'root-symlink-escape', 'the folder resolves through a symbolic link to a place Atlas may not use')
      if (c.error === 'not-directory') throw apiError(409, 'root-not-directory', 'the path is not a folder')
      throw apiError(403, 'root-outside-home', 'the folder must be inside your home directory and outside secret, Git and Atlas runtime folders')
    }
    if (isArtifactRootRefused(c.canonicalPath, artifactRefusedDirectories(cfg()))) throw apiError(403, 'root-refused', 'Atlas data, spool and cost-ledger folders cannot be artifact roots')
    // A missing folder is refused rather than registered: it must never authorize or scan its parent.
    if (!c.exists) throw apiError(409, 'root-missing', 'the folder does not exist; create it first')
    // registerArtifactRoot merges into an existing registration (COALESCE of repository and project): a checkout's identity
    // and repository come only from Git resolution, and a root is never moved to another repository through this route.
    const existing = listArtifactRoots(db).find(r => r.canonicalPath === c.canonicalPath)
    const conflict = () => apiError(409, 'root-conflict', 'this folder is already registered as a checkout or for another repository; it was not changed')
    if (existing?.kind === 'checkout') throw conflict()

    let repositoryId: string | null = null
    let projectName: string | null = typeof body.label === 'string' ? body.label.trim() : null
    if (typeof body.repo === 'string') {
      const rc = canonicalizeArtifactRoot(body.repo, h)
      const owner = 'error' in rc || !rc.exists ? undefined : activeRoots()
        .filter(r => r.kind === 'checkout' && r.repositoryId !== null && within(rc.canonicalPath, r.canonicalPath))
        .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length || byText(a.rootId, b.rootId))[0]
      if (!owner) throw apiError(409, 'repository-not-registered', 'that folder is not inside a registered checkout')
      repositoryId = owner.repositoryId
      projectName ??= owner.projectName
    } else if (typeof body.repositoryId === 'string') {
      repositoryId = body.repositoryId.toLowerCase()
      if (!db.raw.prepare('SELECT 1 AS hit FROM artifact_repositories WHERE repository_id = ?').get(repositoryId)) {
        throw apiError(409, 'repository-not-registered', 'no registered repository has this ID')
      }
    }
    if (existing && existing.repositoryId !== null && repositoryId !== null && existing.repositoryId !== repositoryId) throw conflict()
    const existed = existing !== undefined
    const at = now()
    const registered = db.transaction(() => {
      const row = registerArtifactRoot(db, {
        kind: 'output', canonicalPath: c.canonicalPath, repositoryId, projectName, checkoutIdentity: null,
        protected: body.protected === true || hasPhiSegment(c.canonicalPath), scopeFlags: ['cli-output'],
      }, at)
      const task: ArtifactTaskKind | null = row.kind !== 'checkout' ? 'output-walk' : row.repositoryId !== null && row.checkoutIdentity !== null ? 'checkout-status' : null
      const jobId = task !== null && row.active && scannable(row)
        ? enqueueArtifactJob(db, { scopeId: row.rootId, taskKind: task, priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 0 }, at) : null
      return { row, jobId }
    })
    const r = registered.row
    ctx.send(existed ? 200 : 201, {
      root: {
        rootId: r.rootId, kind: r.kind, path: r.canonicalPath, protected: r.protected, active: r.active, scopeFlags: r.scopeFlags, repositoryId: r.repositoryId,
        projectName: r.projectName, state: r.coverageState,
      },
      jobId: registered.jobId,
    })
  })
}
