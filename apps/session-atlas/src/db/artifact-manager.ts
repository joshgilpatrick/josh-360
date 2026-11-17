import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { migrate, openDatabase, type AtlasDb } from './database.ts'
import { MIGRATIONS } from './migrations.ts'
import { addOrigin, ftsQuery, getArtifact, type ArtifactRow } from './artifacts.ts'
import { classifyPath } from '../artifacts/filetype.ts'
import { hasPhiSegment } from '../artifacts/path-policy.ts'
import {
  ARTIFACT_MANAGER_TABLES, artifactDocumentAtRiskDefinitionSql, artifactDocumentAtRiskSql, artifactDocumentAvailabilityDefinitionSql, artifactDocumentAvailabilitySql, deleteArtifactPlannerStatistics,
  clearOrphanArtifactVersionRuleCopiesSql, refreshArtifactDocumentStateSql, refreshArtifactVersionRuleCopiesSql,
} from './migration-9-artifact-manager.ts'
import type {
  ArtifactCertainty, ArtifactDocumentIdentity, ArtifactEvidenceSource, ArtifactManagerStatus, ArtifactOperation, ArtifactRootCoverageState,
  ArtifactRootKind, ArtifactTaskKind, ArtifactVersionKind, ArtifactWorkerObservation,
} from '../artifacts/contracts.ts'

// The artifact manager's persistence boundary (plan 2026-10-26, "Frozen cross-task contracts"). It owns every artifact-manager
// transaction, ID, uniqueness rule and SQL statement, plus the compatibility projection into the legacy artifact_origins table.
// The service is the only caller that writes; the removal checker calls getArtifactRemovalContext on its own read-only handle.
//
// Three things are kept apart on purpose: a document (the logical group, keyed by a tuple, never a concatenated path), a version
// (an immutable observation of contents) and a location (an `artifacts` row: a place a version can currently be opened from).
// Versions are never updated after insert; availability and preservation live in artifact_version_state. Evidence is immutable
// and deduplicated by its stable source key. Jobs coalesce on (scope, task) and advance by generation.
//
// Nothing here stores document contents: only paths, identities, OIDs, stat signatures, counts and bounded locators.

// ---------------------------------------------------------------------------------------------------------------- contracts

export type ArtifactRootRegistration = {
  kind: ArtifactRootKind
  canonicalPath: string
  repositoryId: string | null
  projectName: string | null
  checkoutIdentity: string | null
  protected: boolean
  // `direct-only` roots authorize exact observed paths and are never bulk-scanned.
  scopeFlags: Array<'checkout' | 'configured-output' | 'cli-output' | 'session-cwd' | 'direct-only'>
}

export type ArtifactJobInput = { scopeId: string; taskKind: ArtifactTaskKind; priority: number; generation: number; cursor?: string | null }

export type ArtifactRootRow = ArtifactRootRegistration & {
  rootId: string
  active: boolean
  desiredGeneration: number
  appliedGeneration: number
  cursor: string | null
  coverageState: ArtifactRootCoverageState
  lastSuccessfulAt: string | null
  lastError: string | null
}

export type ArtifactJobRow = {
  jobId: string
  scopeId: string
  taskKind: ArtifactTaskKind
  desiredGeneration: number
  appliedGeneration: number
  state: 'queued' | 'running' | 'retry' | 'done' | 'failed'
  priority: number
  leaseUntil: string | null
  retryAt: string | null
  attempts: number
  cursor: string | null
}

export type ArtifactRemovalContext = {
  roots: Array<Pick<ArtifactRootRow, 'rootId' | 'canonicalPath' | 'kind' | 'protected' | 'active' | 'coverageState' | 'desiredGeneration' | 'appliedGeneration'>>
  locations: Array<{ path: string; rootId: string | null; documentId: string | null; protected: boolean; verificationState: string | null }>
  sessions: Array<{ sessionId: string; cwd: string | null; status: string; lastActivityAt: string | null }>
}

export type ArtifactEventEvidenceInput = {
  rootId: string
  path: string
  identity: ArtifactDocumentIdentity
  sourceKey: string
  source: ArtifactEvidenceSource
  sessionId: string | null
  operation: ArtifactOperation
  certainty: ArtifactCertainty
  eventAt: string
  locator?: string
}

export type ArtifactDocumentFilters = {
  q?: string
  project?: string
  extension?: string
  from?: string
  to?: string
  sessionId?: string
  availability?: 'local' | 'git' | 'stale' | 'unavailable'
  needsPreservation?: boolean
  sensitive?: 'hide' | 'show' | 'only'
  source?: ArtifactEvidenceSource
  types?: 'documents' | 'all'
}

export type ArtifactDocumentSummary = {
  documentId: string
  displayName: string
  projectName: string | null
  extension: string
  activityAt: string
  activitySource: string
  sessionAssociations: Array<{ sessionId: string; certainty: ArtifactCertainty }>
  availability: 'local' | 'git' | 'stale' | 'unavailable'
  preservationState: 'preserved' | 'unique' | 'unknown'
  protected: boolean
  locationCount: number
  versionCount: number
}

export type ArtifactVersionDetail = {
  versionId: string
  kind: ArtifactVersionKind
  gitPath: string | null
  commitOid: string | null
  objectFormat: 'sha1' | 'sha256' | null
  stage: number | null
  // The location a working version was observed at (artifact_id); null for index and commit versions.
  locationArtifactId: number | null
  observedAt: string
  availability: 'available' | 'last-known' | 'unavailable' | 'unknown'
  preservationState: 'preserved' | 'unique' | 'unknown'
  current: boolean
}

export type ArtifactEvidenceRow = {
  sourceKey: string
  source: ArtifactEvidenceSource
  operation: ArtifactOperation
  certainty: ArtifactCertainty
  sessionId: string | null
  eventAt: string | null
  observedAt: string
  locator: string | null
}

// Not the location-oriented ArtifactPage of src/db/artifacts.ts: this one is only the requested window.
export type ArtifactPage = { limit: number; offset: number }
export type ArtifactDocumentPage = { rows: ArtifactDocumentSummary[]; total: number; limit: number; offset: number; coverage: ArtifactManagerStatus }
export type ArtifactDocumentDetail = {
  document: ArtifactDocumentSummary
  locations: ArtifactRow[]
  versions: ArtifactVersionDetail[]
  evidence: ArtifactEvidenceRow[]
  next: { locations: string | null; versions: string | null; evidence: string | null }
}

// Registration input for a Git repository. Linked worktrees share one common directory and therefore one repository ID;
// independent clones have different common directories and stay distinct even when their remotes match.
export type ArtifactRepositoryRegistration = { commonDir: string; displayName: string; remoteIdentity: string | null }

// Lower is served first. Within one priority the job waiting longest goes next, so a large scope that yields a slice
// goes behind smaller scopes instead of starving them.
export const ARTIFACT_JOB_PRIORITY = { direct: 0, dirty: 10, recovery: 20, verify: 30, backfill: 40 } as const

// A claimed job's lease. Each committed batch renews it; an expired lease makes the job due again (a crashed run).
const ARTIFACT_JOB_LEASE_MS = 60_000

export class ArtifactDocumentNotFoundError extends Error {
  constructor() {
    super('artifact document not found')
    this.name = 'ArtifactDocumentNotFoundError'
  }
}

/** The `last_error` marker of a direct check that waits only for its file to settle (a quiet-period deferral, not a failure). */
export const ARTIFACT_SETTLING = 'settling'

// A direct observation is one job per exact file: UNIQUE(scope_id, task_kind) would otherwise coalesce different files.
export function artifactDirectScopeId(rootId: string, path: string): string {
  return `direct:${rootId}:${path}`
}

// The default eligible document set (spec section 4). The service replaces it with config.artifacts.documentExtensions at start.
const DEFAULT_DOCUMENT_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'json', 'sql']
let documentExtensions = [...DEFAULT_DOCUMENT_EXTENSIONS]

export function configureArtifactDocumentExtensions(extensions: string[]): void {
  const kept = extensions.map(e => e.trim().replace(/^\.+/, '').toLowerCase()).filter(e => /^[a-z0-9][a-z0-9_-]{0,15}$/.test(e))
  documentExtensions = kept.length ? [...new Set(kept)] : [...DEFAULT_DOCUMENT_EXTENSIONS]
}

// ---------------------------------------------------------------------------------------------------------------- limits

const MAX_BATCH_ROWS = 250
const MAX_CURSOR_CHARS = 64 * 1024
const MAX_SOURCE_KEY_CHARS = 512
const MAX_LOCATOR_CHARS = 512
const MAX_EVENT_AT_CHARS = 64
const MAX_PATH_CHARS = 4096
const MAX_SCOPE_CHARS = 8192
const MAX_PAGE = 500
const DEFAULT_PAGE = 50
const MAX_BACKFILL_PAGE = 1000
// A source time this far past the service clock is treated as invalid rather than allowed to outrank real activity.
const FUTURE_SKEW_MS = 60_000
// Activity label for a bounded observation time used when no valid evidenced or file time exists.
const FALLBACK_ACTIVITY = 'observed'
const REDACTED = '[redacted]'
const PAUSE_KEY = 'discovery.paused'

const ROOT_KINDS: readonly ArtifactRootKind[] = ['checkout', 'output', 'session-directory']
const KIND_RANK: Record<ArtifactRootKind, number> = { 'session-directory': 0, output: 1, checkout: 2 }
const SCOPE_FLAGS: readonly string[] = ['checkout', 'configured-output', 'cli-output', 'session-cwd', 'direct-only']
const TASK_KINDS: readonly ArtifactTaskKind[] = ['direct-observation', 'checkout-status', 'output-walk', 'git-history', 'verify', 'legacy-backfill']
// Task kinds that scan a whole root: their scope is the root ID, and they own its cursor, generation and coverage.
const SCAN_TASKS: ReadonlySet<string> = new Set(['checkout-status', 'output-walk'])
const SOURCES: readonly ArtifactEvidenceSource[] = ['hook', 'transcript', 'git', 'watcher', 'reconcile', 'legacy']
const OPERATIONS: readonly ArtifactOperation[] = ['created', 'modified', 'touched']
const CERTAINTIES: readonly ArtifactCertainty[] = ['recorded', 'inferred', 'unknown']
const COVERAGES = ['complete', 'partial', 'inaccessible'] as const
const OID_RE = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ } as const
const CONTROL_RE = /[\u0000-\u001f\u007f]/

// ---------------------------------------------------------------------------------------------------------------- helpers

type SqlValue = string | number | null
// Any handle with a raw connection: the service's AtlasDb, or the removal checker's read-only DatabaseSync.
type RawDb = Pick<AtlasDb, 'raw'>

// Prepared statements are reused per connection (PERF-GAP-3): preparing the same SQL again on every call was about 40% of the
// per-row cost of a catalog commit (16 statements per new working row, 15-30 us each to prepare). Keyed by the connection
// object, so a closed or another connection never reuses one; bounded, because list queries build SQL for variable filter sets
// and ID lists. Least recently used first (fix round 1, R76): a hit moves its statement to the end, so a full cache drops the
// coldest text (typically a one-off list query), never the hot write statements. A statement runs to completion on every call
// (get, all, run), so sharing one is safe: nothing here iterates a statement lazily.
const STATEMENT_CACHE_MAX = 512
const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
function prepared(db: RawDb, sql: string): StatementSync {
  let cache = statementCache.get(db.raw)
  if (!cache) {
    cache = new Map()
    statementCache.set(db.raw, cache)
  }
  let statement = cache.get(sql)
  if (statement) {
    cache.delete(sql)
    cache.set(sql, statement)
    return statement
  }
  statement = db.raw.prepare(sql)
  if (cache.size >= STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(sql, statement)
  return statement
}

function get<T>(db: RawDb, sql: string, ...params: SqlValue[]): T | undefined {
  return prepared(db, sql).get(...params) as T | undefined
}
function all<T>(db: RawDb, sql: string, ...params: SqlValue[]): T[] {
  return prepared(db, sql).all(...params) as T[]
}
function run(db: RawDb, sql: string, ...params: SqlValue[]): { changes: number; lastId: number } {
  const res = prepared(db, sql).run(...params)
  return { changes: Number(res.changes), lastId: Number(res.lastInsertRowid) }
}

function fail(message: string): never {
  throw new Error(message)
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !CONTROL_RE.test(v)
const flag = (b: boolean): number => (b ? 1 : 0)

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

/** Validates and normalizes a timestamp so stored values compare correctly as text. */
function iso(value: unknown, label: string): string {
  const t = typeof value === 'string' && value.length <= MAX_EVENT_AT_CHARS ? Date.parse(value) : NaN
  if (!Number.isFinite(t)) fail(`${label} must be an ISO timestamp`)
  return new Date(t).toISOString()
}

/** A source time usable as activity: valid, not before the epoch, and not meaningfully after `ceiling`. */
function boundedMs(ms: number, ceiling: string): string | null {
  if (!Number.isFinite(ms) || ms < 0 || ms > Date.parse(ceiling) + FUTURE_SKEW_MS) return null
  return new Date(ms).toISOString()
}
function boundedTime(raw: string, ceiling: string): string | null {
  return boundedMs(Date.parse(raw), ceiling)
}

/**
 * The only form in which a job or root error is stored or returned: a short category token, either the whole text (such as
 * `git-timeout`) or a leading code before a colon (such as `ENOENT` from "ENOENT: ... '/Users/j/Jane Doe'"). Anything else is
 * `error`, so free text, which may carry paths or names, never reaches the database or a status response.
 */
function errorCategory(text: string): string {
  return /^([A-Za-z0-9._-]{1,64})(?::|$)/.exec(text.trim())?.[1] ?? 'error'
}

/** A canonical absolute path: no trailing separator, empty, "." or ".." segment, and not the filesystem root. */
function canonicalPath(value: unknown, label: string, strict: boolean): string {
  if (typeof value !== 'string' || !value.startsWith('/')) fail(`${label}: canonical path must be absolute`)
  const bad = value === '/' || value.length > MAX_PATH_CHARS || value.includes('\0') || (strict && CONTROL_RE.test(value))
    || value.split('/').slice(1).some(s => s === '' || s === '.' || s === '..')
  if (bad) fail(`${label}: not a canonical path`)
  return value
}

function relativePath(value: unknown): string {
  const bad = typeof value !== 'string' || value === '' || value.length > MAX_PATH_CHARS || value.includes('\0') || value.startsWith('/')
    || value.split('/').some(s => s === '' || s === '.' || s === '..')
  if (bad) fail('identity relative path is not a normalized relative path')
  return value as string
}

function assertIdentity(identity: ArtifactDocumentIdentity): void {
  if (!identity || typeof identity !== 'object') fail('observation identity is missing')
  if (identity.identityKind === 'repository') {
    if (!isId(identity.repositoryId) || identity.rootId !== null) fail('a repository identity needs a repository ID and no root ID')
  } else if (identity.identityKind === 'root') {
    if (!isId(identity.rootId) || identity.repositoryId !== null) fail('a root identity needs a root ID and no repository ID')
  } else {
    fail('unknown identity kind')
  }
  relativePath(identity.relativePath)
}

type EvidenceFields = {
  sourceKey: string; source: ArtifactEvidenceSource; sessionId: string | null; operation: ArtifactOperation; certainty: ArtifactCertainty
  eventAt: string; locator: string | null
}

function evidenceFields(e: { sourceKey: unknown; source: unknown; sessionId: unknown; operation: unknown; certainty: unknown; eventAt: unknown; locator?: unknown }): EvidenceFields {
  const key = e.sourceKey
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SOURCE_KEY_CHARS || CONTROL_RE.test(key)) fail(`evidence source key must be 1-${MAX_SOURCE_KEY_CHARS} printable characters`)
  if (!SOURCES.includes(e.source as ArtifactEvidenceSource)) fail('unknown evidence source')
  if (!OPERATIONS.includes(e.operation as ArtifactOperation)) fail('unknown evidence operation')
  if (!CERTAINTIES.includes(e.certainty as ArtifactCertainty)) fail('unknown evidence certainty')
  if (e.sessionId !== null && !isId(e.sessionId)) fail('evidence session ID is malformed')
  if (typeof e.eventAt !== 'string' || CONTROL_RE.test(e.eventAt)) fail('evidence event time must be text')
  let locator: string | null = null
  if (e.locator !== undefined && e.locator !== null) {
    // A locator names where the event came from (a transcript record, a tool-use ID). Anything multi-line looks like content.
    if (typeof e.locator !== 'string' || CONTROL_RE.test(e.locator)) fail('evidence locator must be a single line of text')
    locator = e.locator.slice(0, MAX_LOCATOR_CHARS)
  }
  return {
    sourceKey: key, source: e.source as ArtifactEvidenceSource, sessionId: e.sessionId as string | null, operation: e.operation as ArtifactOperation,
    certainty: e.certainty as ArtifactCertainty, eventAt: e.eventAt.slice(0, MAX_EVENT_AT_CHARS), locator,
  }
}

function statSignature(stat: ArtifactWorkerObservation['stat']): string {
  const ok = !!stat && typeof stat === 'object' && isId(stat.dev) && stat.dev.length <= 64 && isId(stat.ino) && stat.ino.length <= 64
    && Number.isInteger(stat.size) && stat.size >= 0 && Number.isFinite(stat.mtimeMs) && Number.isFinite(stat.ctimeMs)
  if (!ok) fail('working observation needs a stat with dev, ino, size, mtimeMs and ctimeMs')
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
}

function assertGit(git: NonNullable<ArtifactWorkerObservation['git']>): void {
  if (!git || typeof git !== 'object' || !isId(git.repositoryId)) fail('Git identity needs a repository ID')
  const re = OID_RE[git.objectFormat]
  if (!re) fail('unknown Git object format')
  if (!Number.isInteger(git.mode) || git.mode < 0 || git.mode > 0o177777) fail('Git mode is malformed')
  if (!Number.isInteger(git.size) || git.size < 0) fail('Git size is malformed')
  if (git.blobOid !== undefined && !re.test(git.blobOid)) fail('invalid blob OID')
  if (git.commitOid !== undefined && !re.test(git.commitOid)) fail('invalid commit OID')
  if (git.gitPath !== undefined) relativePath(git.gitPath)
  if (git.checkoutIdentity !== undefined && !isId(git.checkoutIdentity)) fail('checkout identity is malformed')
  if (git.stage !== undefined && !(Number.isInteger(git.stage) && git.stage >= 0 && git.stage <= 3)) fail('index stage must be 0-3')
}

// ---------------------------------------------------------------------------------------------------------------- records

type RootRecord = {
  root_id: string; kind: ArtifactRootKind; canonical_path: string; repository_id: string | null; project_name: string | null; checkout_identity: string | null
  protected: number; active: number; scope_flags: string; desired_generation: number; applied_generation: number; cursor: string | null
  coverage_state: ArtifactRootCoverageState; last_successful_at: string | null; last_error: string | null
}
type JobRecord = {
  job_id: string; scope_id: string; task_kind: ArtifactTaskKind; desired_generation: number; applied_generation: number; pass_generation: number | null; state: ArtifactJobRow['state']
  priority: number; lease_until: string | null; retry_at: string | null; attempts: number; cursor: string | null
}
type LocationRecord = {
  artifact_id: number; document_id: string | null; observation_signature: string | null; current_version_id: string | null
  exists_state: string; verification_state: string | null
}

const rootRecord = (db: RawDb, rootId: string) => get<RootRecord>(db, 'SELECT * FROM artifact_roots WHERE root_id = ?', rootId)
const jobRecord = (db: RawDb, jobId: string) => get<JobRecord>(db, 'SELECT * FROM artifact_jobs WHERE job_id = ?', jobId)
const locationByPath = (db: RawDb, path: string) =>
  get<LocationRecord>(db, 'SELECT artifact_id, document_id, observation_signature, current_version_id, exists_state, verification_state FROM artifacts WHERE path = ?', path)

function toRootRow(r: RootRecord): ArtifactRootRow {
  return {
    rootId: r.root_id, kind: r.kind, canonicalPath: r.canonical_path, repositoryId: r.repository_id, projectName: r.project_name,
    checkoutIdentity: r.checkout_identity, protected: r.protected === 1, scopeFlags: JSON.parse(r.scope_flags) as ArtifactRootRegistration['scopeFlags'],
    active: r.active === 1, desiredGeneration: r.desired_generation, appliedGeneration: r.applied_generation, cursor: r.cursor,
    coverageState: r.coverage_state, lastSuccessfulAt: r.last_successful_at, lastError: r.last_error,
  }
}

function toJobRow(r: JobRecord): ArtifactJobRow {
  return {
    jobId: r.job_id, scopeId: r.scope_id, taskKind: r.task_kind, desiredGeneration: r.desired_generation, appliedGeneration: r.applied_generation,
    state: r.state, priority: r.priority, leaseUntil: r.lease_until, retryAt: r.retry_at, attempts: r.attempts, cursor: r.cursor,
  }
}

function underProtectedRoot(db: RawDb, path: string): boolean {
  return get(db, `SELECT 1 AS hit FROM artifact_roots WHERE protected = 1 AND (canonical_path = ? OR substr(?, 1, length(canonical_path) + 1) = canonical_path || '/') LIMIT 1`, path, path) !== undefined
}

/** Protected if the filename is sensitive, a path segment is `phi`, or any registered protected root contains it. */
function isProtectedPath(db: RawDb, path: string): boolean {
  return classifyPath(path).sensitive || hasPhiSegment(path) || underProtectedRoot(db, path)
}

/**
 * A repository path is protected when, placed in any registered checkout of that repository, the path policy protects it.
 * This covers Git-only documents (clean tracked files have only history rows). It raises a flag; no location is invented.
 */
function repositoryPathProtected(db: RawDb, repositoryId: string, relativePath: string): boolean {
  return all<{ canonical_path: string }>(db, `SELECT canonical_path FROM artifact_roots WHERE kind = 'checkout' AND repository_id = ?`, repositoryId)
    .some(c => isProtectedPath(db, `${c.canonical_path}/${relativePath}`))
}

/**
 * For a root identity the path must be exactly the identity root plus its relative path. `known` is a root row already read in
 * this transaction (the observing root), reused when it is the identity's root.
 */
function assertIdentityMatchesPath(db: RawDb, identity: ArtifactDocumentIdentity, path: string, known?: RootRecord): void {
  if (identity.identityKind !== 'root') return
  const root = (known?.root_id === identity.rootId ? known : rootRecord(db, identity.rootId!)) ?? fail('identity names an unknown root')
  if (path !== `${root.canonical_path}/${identity.relativePath}`) fail('path does not match its root identity')
}

// ---------------------------------------------------------------------------------------------------------------- documents and activity

type Activity = { at: string; source: string }

/**
 * The project a new document is filed under, taken only from root registrations: a root identity's own root (else the root
 * that observed it); a repository identity's observing root when it belongs to that repository, else the repository's
 * registered roots, checkouts first. Unknown stays null.
 */
function projectFor(db: RawDb, identity: ArtifactDocumentIdentity, root: RootRecord): string | null {
  if (identity.identityKind === 'root') {
    const own = identity.rootId === root.root_id ? root : rootRecord(db, identity.rootId!)
    return own?.project_name ?? root.project_name
  }
  if (root.repository_id === identity.repositoryId && root.project_name !== null) return root.project_name
  return get<{ project_name: string }>(db, `SELECT project_name FROM artifact_roots WHERE repository_id = ? AND project_name IS NOT NULL ORDER BY kind <> 'checkout', canonical_path LIMIT 1`,
    identity.repositoryId)?.project_name ?? null
}

/**
 * Finds the document for a tuple identity, or creates it with its first known activity and its stored list filters: the
 * lowercase extension, the registered project, and protection from a sensitive filename or a phi segment anywhere in its
 * relative path (so a Git-only document is protected too). A later known project fills one that was missing.
 */
function documentFor(db: AtlasDb, identity: ArtifactDocumentIdentity, firstObservedAt: string, activity: Activity, projectName: string | null, known?: RootRecord): string {
  const existing = identity.identityKind === 'repository'
    ? get<{ document_id: string }>(db, `SELECT document_id FROM artifact_documents WHERE identity_kind = 'repository' AND repository_id = ? AND relative_path = ?`, identity.repositoryId, identity.relativePath)
    : get<{ document_id: string }>(db, `SELECT document_id FROM artifact_documents WHERE identity_kind = 'root' AND identity_root_id = ? AND relative_path = ?`, identity.rootId, identity.relativePath)
  if (existing) {
    if (projectName !== null) run(db, 'UPDATE artifact_documents SET project_name = ? WHERE document_id = ? AND project_name IS NULL', projectName, existing.document_id)
    return existing.document_id
  }
  if (identity.identityKind === 'repository' && !get(db, 'SELECT 1 AS hit FROM artifact_repositories WHERE repository_id = ?', identity.repositoryId)) fail('identity names an unknown repository')
  if (identity.identityKind === 'root' && !(known?.root_id === identity.rootId || rootRecord(db, identity.rootId!))) fail('identity names an unknown root')
  const documentId = randomUUID()
  const displayName = identity.relativePath.slice(identity.relativePath.lastIndexOf('/') + 1)
  const c = classifyPath(displayName)
  run(db, `INSERT INTO artifact_documents (document_id, identity_kind, repository_id, identity_root_id, relative_path, display_name, extension, project_name, protected, first_observed_at, last_change_at, last_change_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, documentId, identity.identityKind, identity.repositoryId, identity.rootId, identity.relativePath, displayName, c.extension, projectName,
  flag(c.sensitive || hasPhiSegment(identity.relativePath) || (identity.identityKind === 'repository' && repositoryPathProtected(db, identity.repositoryId!, identity.relativePath))),
  firstObservedAt, activity.at, activity.source)
  return documentId
}

function raiseProtection(db: RawDb, documentId: string): void {
  run(db, 'UPDATE artifact_documents SET protected = 1 WHERE document_id = ? AND protected = 0', documentId)
}

/** A document with any protected location is protected. Raise-only: nothing here ever clears it. */
function raiseProtectionFromLocation(db: RawDb, documentId: string, artifactId: number): void {
  run(db, `UPDATE artifact_documents SET protected = 1 WHERE document_id = ? AND protected = 0 AND EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = ? AND is_sensitive = 1)`, documentId, artifactId)
}

/**
 * Advances document activity. Evidenced and file times keep the latest; the bounded observation-time fallback only fills a
 * gap and is replaced by any real activity, even an older one, so import or polling time never outranks real work.
 */
function recordActivity(db: RawDb, documentId: string, activity: Activity): void {
  if (activity.source === FALLBACK_ACTIVITY) {
    run(db, `UPDATE artifact_documents SET last_change_at = ?, last_change_source = ? WHERE document_id = ? AND (last_change_at IS NULL OR (last_change_source = ? AND last_change_at < ?))`,
      activity.at, activity.source, documentId, FALLBACK_ACTIVITY, activity.at)
  } else {
    run(db, `UPDATE artifact_documents SET last_change_at = ?, last_change_source = ? WHERE document_id = ? AND (last_change_at IS NULL OR last_change_source = ? OR last_change_at < ?)`,
      activity.at, activity.source, documentId, FALLBACK_ACTIVITY, activity.at)
  }
}

// ---------------------------------------------------------------------------------------------------------------- locations and evidence

function createLocation(db: RawDb, input: { path: string; root: RootRecord; documentId: string; createdAt: string; verifiedAt: string | null; sizeBytes: number | null }): LocationRecord {
  const c = classifyPath(input.path)
  const verification = input.verifiedAt === null ? 'pending' : 'verified'
  const res = run(db, `INSERT INTO artifacts (path, filename, extension, file_type, mime_type, size_bytes, created_at, project_name, exists_state, last_verified_at, is_sensitive, document_id, root_id, verification_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?, ?)`, input.path, c.filename, c.extension, c.fileType, c.mimeType, input.sizeBytes, input.createdAt,
  input.root.project_name, input.verifiedAt, flag(isProtectedPath(db, input.path)), input.documentId, input.root.root_id, verification)
  raiseProtectionFromLocation(db, input.documentId, res.lastId)
  return { artifact_id: res.lastId, document_id: input.documentId, observation_signature: null, current_version_id: null, exists_state: 'present', verification_state: verification }
}

/**
 * A location seen again applies the CURRENT path policy (ruling R91): a row written under an older, narrower rule is raised when the
 * policy now protects its path or its document's repository-relative path. Raise-only, one statement per flag; it never lowers anything.
 */
function applyCurrentPolicy(db: RawDb, loc: LocationRecord, path: string, documentId: string, relativePath: string): void {
  if (isProtectedPath(db, path)) run(db, 'UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ? AND is_sensitive = 0', loc.artifact_id)
  if (hasPhiSegment(relativePath)) raiseProtection(db, documentId)
  raiseProtectionFromLocation(db, documentId, loc.artifact_id)
}

/**
 * Whether the document's own paths have a PHI segment, whatever its flags say: its repository-relative path or any of its locations'
 * paths. The metadata reads use this as a defence against a stale flag (ruling R91). Stops at the first hit; a document has few locations.
 */
export function artifactDocumentHasPhiPath(db: Pick<AtlasDb, 'raw'>, documentId: string): boolean {
  const doc = get<{ relative_path: string | null }>(db, 'SELECT relative_path FROM artifact_documents WHERE document_id = ?', documentId)
  if (doc?.relative_path != null && hasPhiSegment(doc.relative_path)) return true
  for (const r of db.raw.prepare('SELECT path FROM artifacts WHERE document_id = ?').iterate(documentId) as Iterable<{ path: string }>) {
    if (hasPhiSegment(r.path)) return true
  }
  return false
}

/** Links an existing (usually legacy) location to its document. Protection can only be raised, never lowered. */
function linkLocation(db: RawDb, loc: LocationRecord, path: string, documentId: string, rootId: string): void {
  run(db, `UPDATE artifacts SET document_id = ?, root_id = COALESCE(root_id, ?), is_sensitive = MAX(is_sensitive, ?) WHERE artifact_id = ?`, documentId, rootId, flag(isProtectedPath(db, path)), loc.artifact_id)
  raiseProtectionFromLocation(db, documentId, loc.artifact_id)
  loc.document_id = documentId
}

/**
 * Event-only evidence (a hook or transcript event) is recorded for a location before any stat of the file shows what the event
 * wrote, so it starts with no version. A later observation timestamp does not make it that stat's evidence: a stat can be taken,
 * the file rewritten and the rewrite reported, all before the stat is handled (PR #19 review, P2-4). Only an explicit correlation
 * binds an event to a version, and only the one event the stat can be shown to describe:
 *   - the stat must carry its capture time (a lower bound of when the worker's lstat saw the file); without it nothing binds;
 *   - the event must have been reported, and its write must have happened, no later than that capture, so the stat began after
 *     the write finished;
 *   - the write must be later than `since` (the previous capture of this location), so it cannot be content an earlier stat
 *     already showed, and a superseded event left unbound by an earlier stat is never claimed by a later change;
 *   - of the events that qualify, binding follows the demonstrated WRITE chronology, never the order of delivery (ruling R92): a
 *     spooled event can reach the service after a later write was already reported. The write time of an event is its `event_at`
 *     when that is readable and not after its own report; otherwise the write time is not demonstrated (the report time is only an
 *     upper bound). One candidate binds, even when only its report time is known. With two or more, the one whose demonstrated
 *     write time is strictly the latest binds, and only when every candidate has a demonstrated write time; a tie for the latest,
 *     or any candidate without a demonstrated write time, means the latest write cannot be shown, so nothing binds. An earlier
 *     write describes content nothing ever observed, and stays unbound.
 * An event reported after the capture stays unbound until a later stat satisfies the rule, which may repair its link. A bound
 * event is never rebound or rebound elsewhere, and legacy evidence (an old origin, not an event about contents) never binds.
 * Returns how many events were bound (0 or 1).
 */
function attachPendingEvidence(db: RawDb, artifactId: number, versionId: string, capturedAt: string | null, since: string | null): number {
  if (capturedAt === null) return 0
  const pending = all<{ evidence_id: string; event_at: string | null; observed_at: string }>(db,
    `SELECT evidence_id, event_at, observed_at FROM artifact_evidence
     WHERE artifact_id = ? AND version_id IS NULL AND source <> 'legacy' AND observed_at <= ? ${since === null ? '' : 'AND observed_at > ?'} ORDER BY observed_at DESC, rowid DESC`,
    ...(since === null ? [artifactId, capturedAt] : [artifactId, capturedAt, since]))
  const capturedMs = Date.parse(capturedAt)
  const sinceMs = since === null ? -Infinity : Date.parse(since)
  const candidates: Array<{ evidenceId: string; writeMs: number; demonstrated: boolean }> = []
  for (const e of pending) {
    const reportedMs = Date.parse(e.observed_at)
    const wroteMs = e.event_at === null ? NaN : Date.parse(e.event_at)
    // The write happened at its event time, never after it was reported; an event time that is missing, unreadable or after its
    // own report is not believed, and the report time stands in for it as an upper bound only.
    const demonstrated = Number.isFinite(wroteMs) && wroteMs <= reportedMs
    const writeMs = demonstrated ? wroteMs : reportedMs
    if (writeMs > sinceMs && reportedMs <= capturedMs) candidates.push({ evidenceId: e.evidence_id, writeMs, demonstrated })
  }
  let chosen: string | null = null
  if (candidates.length === 1) chosen = candidates[0]!.evidenceId
  else if (candidates.length > 1 && candidates.every(c => c.demonstrated)) {
    const latest = Math.max(...candidates.map(c => c.writeMs))
    const atLatest = candidates.filter(c => c.writeMs === latest)
    if (atLatest.length === 1) chosen = atLatest[0]!.evidenceId
  }
  if (chosen === null) return 0
  return run(db, 'UPDATE artifact_evidence SET version_id = ? WHERE evidence_id = ? AND version_id IS NULL', versionId, chosen).changes
}

// Legacy artifact_origins keeps its schema (relation creator|reference, detected_via tool_event|watcher|reconcile). Only a
// recorded creation may be a creator; INSERT OR IGNORE means an existing origin, legacy or not, is never rewritten or upgraded.
function projectOrigin(db: AtlasDb, artifactId: number, sessionId: string | null, ev: EvidenceFields, observedAt: string): void {
  if (sessionId === null || ev.source === 'legacy') return
  const via = ev.source === 'hook' || ev.source === 'transcript' ? 'tool_event' : ev.source === 'watcher' ? 'watcher' : 'reconcile'
  addOrigin(db, artifactId, sessionId, ev.certainty === 'recorded' && ev.operation === 'created' ? 'creator' : 'reference', via, observedAt)
}

/** Inserts immutable evidence once per source key. A replay only fills a still-missing version/location link. */
function applyEvidence(db: AtlasDb, ev: EvidenceFields, ctx: { documentId: string; versionId: string | null; artifactId: number | null; observedAt: string; now: string }): boolean {
  const existing = get<{ document_id: string }>(db, 'SELECT document_id FROM artifact_evidence WHERE source_key = ?', ev.sourceKey)
  if (existing) {
    if (existing.document_id === ctx.documentId) {
      run(db, 'UPDATE artifact_evidence SET version_id = COALESCE(version_id, ?), artifact_id = COALESCE(artifact_id, ?) WHERE source_key = ?', ctx.versionId, ctx.artifactId, ev.sourceKey)
    }
    return false
  }
  // The foreign key admits only known sessions; an unknown one is recorded as no session, as a deleted session would be.
  const sessionId = ev.sessionId !== null && get(db, 'SELECT 1 AS hit FROM sessions WHERE session_id = ?', ev.sessionId) ? ev.sessionId : null
  run(db, `INSERT INTO artifact_evidence (evidence_id, source_key, document_id, version_id, artifact_id, session_id, source, operation, certainty, event_at, observed_at, source_locator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), ev.sourceKey, ctx.documentId, ctx.versionId, ctx.artifactId, sessionId, ev.source, ev.operation,
  ev.certainty, ev.eventAt, ctx.observedAt, ev.locator)
  const at = boundedTime(ev.eventAt, ctx.now)
  recordActivity(db, ctx.documentId, at ? { at, source: ev.source } : { at: ctx.observedAt, source: FALLBACK_ACTIVITY })
  if (at && ev.operation === 'created' && ev.certainty === 'recorded') {
    run(db, 'UPDATE artifact_documents SET first_created_at = ? WHERE document_id = ? AND (first_created_at IS NULL OR first_created_at > ?)', at, ctx.documentId, at)
  }
  if (ctx.artifactId !== null) projectOrigin(db, ctx.artifactId, sessionId, ev, ctx.observedAt)
  return true
}

// ---------------------------------------------------------------------------------------------------------------- versions

function insertVersionState(db: RawDb, versionId: string, now: string): void {
  run(db, `INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES (?, 'available', 'unknown', ?)`, versionId, now)
}

/** A superseded version keeps its row; only its derived availability changes. */
function supersede(db: RawDb, versionId: string, availability: 'unavailable' | 'last-known', now: string): void {
  run(db, `UPDATE artifact_version_state SET availability = ?, checked_at = ? WHERE version_id = ? AND availability = 'available'`, availability, now, versionId)
}

type Applied = { documentId: string; artifactId: number | null; versionId: string | null; changed: boolean }
/** `capturedAt`: the stat's validated capture time (see attachPendingEvidence), or null when the row carries none that can be trusted. */
type ObservationContext = { observedAt: string; capturedAt: string | null; now: string; evidenceActivity: Activity | null; refreshVerification: boolean; quietMs: number }
/** A working row skipped because its file changed less than the quiet period ago: it is due again in `deferMs` (path is canonical). */
type Deferred = { deferMs: number; path: string }

/**
 * How long a changing file still has to wait, in ms, or null when it may be recorded now. Age is the reference time (the stat's
 * capture, else the observation) minus the file's ctime. The file is still changing when the age is under the quiet period and
 * above minus the quiet period; a ctime further in the future than that is a clock problem and records as it always did.
 */
function settleWaitMs(stat: { ctimeMs?: number }, ctx: ObservationContext): number | null {
  if (ctx.quietMs <= 0 || !Number.isFinite(stat.ctimeMs)) return null
  const age = Date.parse(ctx.capturedAt ?? ctx.observedAt) - stat.ctimeMs!
  return age < ctx.quietMs && age > -ctx.quietMs ? ctx.quietMs - age : null
}

/** A tool reported its write finished, unbound, at or after the file's last change (ctime floored to the ms) and no later than the capture. */
function reportedAfterChange(db: RawDb, artifactId: number, ctimeMs: number, reference: string): boolean {
  return get(db, `SELECT 1 AS hit FROM artifact_evidence WHERE artifact_id = ? AND version_id IS NULL AND source IN ('hook', 'transcript') AND observed_at >= ? AND observed_at <= ?`,
    artifactId, new Date(Math.floor(ctimeMs)).toISOString(), reference) !== undefined
}

function applyWorking(db: AtlasDb, obs: ArtifactWorkerObservation, root: RootRecord, ctx: ObservationContext): Applied | Deferred {
  const path = canonicalPath(obs.path, 'working observation path', false)
  if (!within(path, root.canonical_path)) fail('observation path is outside its root')
  assertIdentityMatchesPath(db, obs.identity, path, root)
  const signature = statSignature(obs.stat)
  const stat = obs.stat!
  // Git vouching for a clean tracked file means its fresh mtime may be checkout noise, never document activity.
  const tracked = typeof obs.git?.blobOid === 'string'
  const mtime = boundedMs(stat.mtimeMs, ctx.observedAt)

  let loc = locationByPath(db, path)
  // Settle before version: a file changed within the quiet period may still be mid-write. Skipping writes nothing (pending
  // evidence stays pending); an unchanged stat, a row carrying its own evidence and a tool-reported finished write are exempt.
  const unchanged = loc !== undefined && loc.observation_signature === signature && loc.current_version_id !== null
  if (!unchanged && obs.evidence === undefined) {
    const deferMs = settleWaitMs(stat, ctx)
    if (deferMs !== null && !(loc && reportedAfterChange(db, loc.artifact_id, stat.ctimeMs, ctx.capturedAt ?? ctx.observedAt))) return { deferMs, path }
  }
  // A location keeps its original document: adding a nested scope must not split documents or change their IDs.
  let documentId = loc?.document_id ?? null
  if (documentId === null) {
    const initial = ctx.evidenceActivity ?? (!tracked && mtime ? { at: mtime, source: 'mtime' } : { at: ctx.observedAt, source: FALLBACK_ACTIVITY })
    documentId = documentFor(db, obs.identity, ctx.observedAt, initial, projectFor(db, obs.identity, root), root)
    if (loc) linkLocation(db, loc, path, documentId, root.root_id)
  }
  const known = loc !== undefined
  if (!loc) {
    loc = createLocation(db, { path, root, documentId, createdAt: ctx.evidenceActivity?.at ?? mtime ?? ctx.observedAt, verifiedAt: ctx.observedAt, sizeBytes: stat.size })
  } else {
    applyCurrentPolicy(db, loc, path, documentId, obs.identity.relativePath)
  }

  if (loc.observation_signature === signature && loc.current_version_id !== null) {
    // Unchanged: no version, no activity, and no per-file timestamp churn unless the file was not known to be present or
    // this is an explicit verification.
    if (ctx.refreshVerification || loc.exists_state !== 'present' || loc.verification_state !== 'verified') {
      run(db, `UPDATE artifacts SET exists_state = 'present', verification_state = 'verified', last_verified_at = ? WHERE artifact_id = ?`, ctx.observedAt, loc.artifact_id)
    }
    // The same stat seen again: an event reported since the current version's capture is about content this stat shows (any write
    // after that capture would have changed the signature), so a late-bound event can be repaired here.
    const current = ctx.capturedAt === null ? undefined : get<{ observed_at: string }>(db, 'SELECT observed_at FROM artifact_versions WHERE version_id = ?', loc.current_version_id)
    const attached = attachPendingEvidence(db, loc.artifact_id, loc.current_version_id, ctx.capturedAt, current?.observed_at ?? null)
    return { documentId, artifactId: loc.artifact_id, versionId: loc.current_version_id, changed: attached > 0 }
  }

  const previous = loc.current_version_id ? get<{ observed_at: string }>(db, 'SELECT observed_at FROM artifact_versions WHERE version_id = ?', loc.current_version_id) : undefined
  const revision = (get<{ r: number | null }>(db, `SELECT MAX(observation_revision) AS r FROM artifact_versions WHERE kind = 'working' AND location_artifact_id = ?`, loc.artifact_id)?.r ?? 0) + 1
  const versionId = randomUUID()
  const g = obs.git
  run(db, `INSERT INTO artifact_versions (version_id, document_id, kind, location_artifact_id, repository_id, checkout_identity, git_path, object_format, blob_oid, observation_revision, stat_signature, mode, size_bytes, observed_at)
    VALUES (?, ?, 'working', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, versionId, documentId, loc.artifact_id, g?.repositoryId ?? null, g?.checkoutIdentity ?? null, g?.gitPath ?? null,
  g?.objectFormat ?? null, g?.blobOid ?? null, revision, signature, g?.mode ?? null, stat.size, ctx.capturedAt ?? ctx.observedAt)
  insertVersionState(db, versionId, ctx.now)
  // The overwritten bytes are gone unless something else preserved them; the version keeps its metadata.
  if (loc.current_version_id) supersede(db, loc.current_version_id, 'unavailable', ctx.now)

  // A verified signature transition after a baseline is activity. Its time is the file's mtime when that falls inside the
  // observation window, else the observation itself (a rewrite that preserved an old mtime is still a change).
  let change: Activity | null = null
  if (loc.observation_signature !== null && !tracked) {
    change = mtime && previous && mtime > previous.observed_at ? { at: mtime, source: 'mtime' } : { at: ctx.observedAt, source: 'signature' }
    recordActivity(db, documentId, change)
  } else if (known && loc.observation_signature === null && !tracked) {
    // The first verified stat of a location that existed without one (a migrated or backfilled file, or one a tool event created
    // first): its mtime is when the file last changed, so it initialises the document's activity. The stat's capture time (not the
    // later persist time) bounds it, so a future mtime is not believed; recordActivity only ever raises, and the creation date,
    // creator and evidence are not touched.
    const first = boundedMs(stat.mtimeMs, ctx.capturedAt ?? ctx.observedAt)
    if (first) recordActivity(db, documentId, { at: first, source: 'mtime' })
  }
  // The new stat signature carries the device it was seen on, so an older recorded device no longer applies (R72); a device
  // other than the recorded one is renumber evidence for the location's root (R73).
  const seen = get<{ last_seen_device: string | null; root_id: string | null }>(db, 'SELECT last_seen_device, root_id FROM artifacts WHERE artifact_id = ?', loc.artifact_id)
  const recorded = seen?.last_seen_device ?? artifactSignatureDevice(loc.observation_signature)
  // R74.3: only the same file (inode, size, mtime) seen on another device is evidence; a different file at the path is not.
  if (recorded !== null && artifactSignatureIsSameFile(loc.observation_signature, stat)) recordArtifactRootRenumber(db, seen?.root_id ?? root.root_id, recorded, stat.dev, ctx.now)
  run(db, `UPDATE artifacts SET observation_signature = ?, current_version_id = ?, size_bytes = ?, exists_state = 'present', verification_state = 'verified', last_verified_at = ?,
    last_change_at = COALESCE(?, last_change_at, ?), last_seen_device = NULL WHERE artifact_id = ?`, signature, versionId, stat.size, ctx.observedAt, change?.at ?? null, mtime, loc.artifact_id)
  attachPendingEvidence(db, loc.artifact_id, versionId, ctx.capturedAt, previous?.observed_at ?? null)
  return { documentId, artifactId: loc.artifact_id, versionId, changed: true }
}

function applyIndex(db: AtlasDb, obs: ArtifactWorkerObservation, root: RootRecord, ctx: ObservationContext): Applied {
  if (obs.identity.identityKind !== 'repository') fail('index observation needs a repository identity')
  const g = obs.git
  if (!g || g.checkoutIdentity === undefined || g.gitPath === undefined || g.blobOid === undefined || g.stage === undefined) {
    fail('index observation needs checkout identity, Git path, blob, object format, mode, size and stage')
  }
  if (g.repositoryId !== obs.identity.repositoryId) fail('index observation repository does not match its identity')
  const documentId = documentFor(db, obs.identity, ctx.observedAt, ctx.evidenceActivity ?? { at: ctx.observedAt, source: FALLBACK_ACTIVITY }, projectFor(db, obs.identity, root))
  const latest = get<{ version_id: string; document_id: string; blob_oid: string; object_format: string; mode: number; size_bytes: number; observation_revision: number }>(db,
    `SELECT version_id, document_id, blob_oid, object_format, mode, size_bytes, observation_revision FROM artifact_versions
     WHERE kind = 'index' AND checkout_identity = ? AND git_path = ? AND index_stage = ? ORDER BY observation_revision DESC LIMIT 1`, g.checkoutIdentity, g.gitPath, g.stage)
  if (root.protected === 1 || repositoryPathProtected(db, g.repositoryId, obs.identity.relativePath)) raiseProtection(db, documentId)
  if (latest && latest.document_id === documentId && latest.blob_oid === g.blobOid && latest.object_format === g.objectFormat && latest.mode === g.mode && latest.size_bytes === g.size) {
    // An unchanged index entry creates no revision (spec section 3), and leaves its availability alone: only a Git object
    // check (or a changed entry, a new revision) may say whether its blob can be read.
    return { documentId, artifactId: null, versionId: latest.version_id, changed: false }
  }
  const versionId = randomUUID()
  run(db, `INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, checkout_identity, git_path, object_format, blob_oid, index_stage, observation_revision, mode, size_bytes, observed_at)
    VALUES (?, ?, 'index', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, versionId, documentId, g.repositoryId, g.checkoutIdentity, g.gitPath, g.objectFormat, g.blobOid, g.stage,
  (latest?.observation_revision ?? 0) + 1, g.mode, g.size, ctx.observedAt)
  insertVersionState(db, versionId, ctx.now)
  // A replaced staged blob may linger in the object store, but it is no longer the staged snapshot and is not retention.
  if (latest) supersede(db, latest.version_id, 'last-known', ctx.now)
  return { documentId, artifactId: null, versionId, changed: true }
}

function applyCommit(db: AtlasDb, obs: ArtifactWorkerObservation, root: RootRecord, ctx: ObservationContext): Applied {
  if (obs.path !== undefined || obs.stat !== undefined) fail('commit observation must not carry a filesystem path or stat')
  if (obs.identity.identityKind !== 'repository') fail('commit observation needs a repository identity')
  const g = obs.git
  if (!g || g.commitOid === undefined || g.gitPath === undefined || g.blobOid === undefined) fail('commit observation needs repository, commit OID, Git path, blob, object format, mode and size')
  if (g.repositoryId !== obs.identity.repositoryId) fail('commit observation repository does not match its identity')
  const documentId = documentFor(db, obs.identity, ctx.observedAt, ctx.evidenceActivity ?? { at: ctx.observedAt, source: FALLBACK_ACTIVITY }, projectFor(db, obs.identity, root))
  if (root.protected === 1 || repositoryPathProtected(db, g.repositoryId, obs.identity.relativePath)) raiseProtection(db, documentId)
  const existing = get<{ version_id: string }>(db, `SELECT version_id FROM artifact_versions WHERE kind = 'commit' AND document_id = ? AND repository_id = ? AND commit_oid = ? AND git_path = ?`,
    documentId, g.repositoryId, g.commitOid, g.gitPath)
  if (existing) return { documentId, artifactId: null, versionId: existing.version_id, changed: false }
  const versionId = randomUUID()
  run(db, `INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, commit_oid, git_path, object_format, blob_oid, mode, size_bytes, observed_at)
    VALUES (?, ?, 'commit', ?, ?, ?, ?, ?, ?, ?, ?)`, versionId, documentId, g.repositoryId, g.commitOid, g.gitPath, g.objectFormat, g.blobOid, g.mode, g.size, ctx.observedAt)
  insertVersionState(db, versionId, ctx.now)
  return { documentId, artifactId: null, versionId, changed: true }
}

/**
 * The capture time of a working row's stat when it is a valid instant that is not after the row's own observation and not in the
 * future; otherwise null, and then no event may be bound to this stat (a time the worker could not have had proves nothing).
 */
function capturedTime(raw: unknown, observedAt: string, now: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_EVENT_AT_CHARS) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms) || ms < 0 || ms > Date.parse(observedAt) || ms > Date.parse(now) + FUTURE_SKEW_MS) return null
  return new Date(ms).toISOString()
}

function applyObservation(db: AtlasDb, obs: ArtifactWorkerObservation, now: string, refreshVerification: boolean, quietMs = 0): { documentId: string; artifactId: number | null; versionId: string | null; duplicate: boolean } | Deferred {
  if (!obs || typeof obs !== 'object') fail('observation is not an object')
  assertIdentity(obs.identity)
  const observedAt = boundedTime(iso(obs.observedAt, 'observedAt'), now) ?? now
  const evidence = obs.evidence === undefined ? null : evidenceFields({ ...obs.evidence, sourceKey: obs.evidence?.eventKey })
  if (obs.git !== undefined) assertGit(obs.git)
  const root = rootRecord(db, obs.rootId) ?? fail('observation names an unknown root')
  const evidenceAt = evidence ? boundedTime(evidence.eventAt, now) : null
  const ctx: ObservationContext = {
    observedAt, capturedAt: capturedTime(obs.capturedAt, observedAt, now), now, evidenceActivity: evidence && evidenceAt ? { at: evidenceAt, source: evidence.source } : null, refreshVerification, quietMs,
  }
  const applied = obs.kind === 'working' ? applyWorking(db, obs, root, ctx)
    : obs.kind === 'index' ? applyIndex(db, obs, root, ctx)
      : obs.kind === 'commit' ? applyCommit(db, obs, root, ctx)
        : fail('unknown observation kind')
  if ('deferMs' in applied) return applied
  const inserted = evidence ? applyEvidence(db, evidence, { documentId: applied.documentId, versionId: applied.versionId, artifactId: applied.artifactId, observedAt, now }) : false
  return { documentId: applied.documentId, artifactId: applied.artifactId, versionId: applied.versionId, duplicate: !applied.changed && !inserted }
}

// ---------------------------------------------------------------------------------------------------------------- Git object checks

/** What reading or checking the Git object of a commit or index version proved (spec s8 "Verify object presence"). */
export type ArtifactGitObjectCheck = {
  versionId: string
  /**
   * present: `cat-file` found a blob of the stored size (or its exact bytes were read); missing: `cat-file --batch-check`
   * answered "missing"; mismatch: the object is not a blob of the stored size, so it can never be served exactly;
   * unreadable: a read failed without proving anything about the object.
   */
  object: 'present' | 'missing' | 'mismatch' | 'unreadable'
}

/** A commit or index version as the Git object check needs it: the stored object identity and its repository's common dir. */
export type ArtifactGitObjectRow = {
  versionId: string; kind: 'commit' | 'index'; repositoryId: string; commonDir: string; checkoutIdentity: string | null; objectFormat: 'sha1' | 'sha256'; blobOid: string
  sizeBytes: number
}
/** Where the object check's work list resumes: after this (repository, version) pair. */
export type ArtifactGitObjectCursor = { repositoryId: string; versionId: string }

const MAX_GIT_OBJECT_CHECKS = 1000
const GIT_OBJECT_STATES = ['present', 'missing', 'mismatch', 'unreadable']
/** A staged snapshot replaced by a later revision of the same index entry (it can come back only as last-known). */
const SUPERSEDED_INDEX = `EXISTS (SELECT 1 FROM artifact_versions sv JOIN artifact_versions nv ON nv.kind = 'index' AND nv.checkout_identity = sv.checkout_identity
  AND nv.git_path = sv.git_path AND nv.index_stage = sv.index_stage AND nv.observation_revision > sv.observation_revision
  WHERE sv.version_id = artifact_version_state.version_id AND sv.kind = 'index')`

/**
 * Index rows one work-list call reads at most, due or not (fix round 2): a call stays bounded (a few milliseconds, on the event
 * loop) however few versions are due, and the caller resumes after `last`.
 */
export const GIT_OBJECT_SCAN_ROWS = 1024
/** One work-list call: the due versions read (in order), the position read through, and whether the list ended there. */
export type ArtifactGitObjectPage = { rows: ArtifactGitObjectRow[]; last: ArtifactGitObjectCursor | null; end: boolean }

/**
 * The resumable work list of the bounded Git object check (I4): commit and index versions after `after` in (repository,
 * version) order, read through idx_artifact_versions_git_objects, at most `scanRows` index rows per call, keeping those due
 * (at most `limit`): never checked, last proven at or before `checkedBefore` (the re-check interval, so repeated passes do
 * almost nothing), or unproven (`unknown`, always due). The window reads only the index and the version state; the stored
 * identity is read for the due versions alone. `last` is the last row read (due or not), so the caller resumes past versions
 * that are not due; `end` means nothing follows it. Working versions are judged by their location.
 */
export function listArtifactGitObjects(db: RawDb, after: ArtifactGitObjectCursor | null, limit: number, checkedBefore: string, scanRows = GIT_OBJECT_SCAN_ROWS): ArtifactGitObjectPage {
  const n = Number.isFinite(limit) ? Math.min(MAX_GIT_OBJECT_CHECKS, Math.max(1, Math.trunc(limit))) : DEFAULT_PAGE
  const scan = Number.isFinite(scanRows) ? Math.max(n, Math.min(16 * GIT_OBJECT_SCAN_ROWS, Math.trunc(scanRows))) : GIT_OBJECT_SCAN_ROWS
  const cutoff = iso(checkedBefore, 'checkedBefore')
  const read = all<{ repository_id: string; version_id: string; checked_at: string | null; availability: string | null }>(db,
    `SELECT v.repository_id, v.version_id, s.checked_at, s.availability
     FROM artifact_versions v INDEXED BY idx_artifact_versions_git_objects
     LEFT JOIN artifact_version_state s ON s.version_id = v.version_id
     WHERE v.kind IN ('commit', 'index') AND (v.repository_id, v.version_id) > (?, ?)
     ORDER BY v.repository_id, v.version_id LIMIT ?`, after?.repositoryId ?? '', after?.versionId ?? '', scan)
  const due: string[] = []
  let last: ArtifactGitObjectCursor | null = null
  let consumed = 0
  for (const r of read) {
    consumed += 1
    last = { repositoryId: r.repository_id, versionId: r.version_id }
    if (r.checked_at === null || r.checked_at <= cutoff || r.availability === 'unknown') {
      due.push(r.version_id)
      if (due.length === n) break
    }
  }
  const byId = new Map(due.length === 0 ? [] : all<{
    version_id: string; kind: 'commit' | 'index'; repository_id: string; common_dir: string; checkout_identity: string | null; object_format: 'sha1' | 'sha256'
    blob_oid: string; size_bytes: number
  }>(db, `SELECT v.version_id, v.kind, v.repository_id, r.common_dir, v.checkout_identity, v.object_format, v.blob_oid, v.size_bytes
     FROM artifact_versions v JOIN artifact_repositories r ON r.repository_id = v.repository_id
     WHERE v.version_id IN (SELECT value FROM json_each(?))`, JSON.stringify(due)).map(r => [r.version_id, r] as const))
  const rows: ArtifactGitObjectRow[] = []
  for (const id of due) {
    const r = byId.get(id)
    if (r) {
      rows.push({
        versionId: r.version_id, kind: r.kind, repositoryId: r.repository_id, commonDir: r.common_dir, checkoutIdentity: r.checkout_identity, objectFormat: r.object_format,
        blobOid: r.blob_oid, sizeBytes: r.size_bytes,
      })
    }
  }
  return { rows, last, end: consumed === read.length && read.length < scan }
}

/**
 * Applies Git object checks to commit and index versions' derived availability; versions are never changed, and a working
 * version is never touched (its location decides). Only proof moves a version: present restores an unavailable or unknown one
 * (a superseded staged snapshot only to last-known); missing or mismatch makes it unavailable; an unreadable object (a failed
 * read that proved nothing) only takes an available one to unknown, so it is no longer offered while a staged snapshot stays
 * counted as needing preservation. An unchanged proof only refreshes checked_at (the object check's re-check interval, I4).
 * Returns how many versions changed availability.
 */
export function recordArtifactGitObjectChecks(db: AtlasDb, checks: ArtifactGitObjectCheck[], now: string): number {
  const at = iso(now, 'now')
  if (!Array.isArray(checks) || checks.length > MAX_GIT_OBJECT_CHECKS) fail(`at most ${MAX_GIT_OBJECT_CHECKS} Git object checks at a time`)
  for (const c of checks) {
    if (!c || typeof c !== 'object' || !isId(c.versionId) || !GIT_OBJECT_STATES.includes(c.object)) fail('malformed Git object check')
  }
  return db.transaction(() => {
    let changed = 0
    const gitVersion = `version_id = ? AND version_id IN (SELECT version_id FROM artifact_versions WHERE version_id = ? AND kind IN ('commit', 'index'))`
    for (const c of checks) {
      const res = c.object === 'present'
        ? run(db, `UPDATE artifact_version_state SET availability = CASE WHEN ${SUPERSEDED_INDEX} THEN 'last-known' ELSE 'available' END, checked_at = ?
            WHERE ${gitVersion} AND availability IN ('unavailable', 'unknown')`, at, c.versionId, c.versionId)
        : c.object === 'unreadable'
          ? run(db, `UPDATE artifact_version_state SET availability = 'unknown', checked_at = ? WHERE ${gitVersion} AND availability = 'available'`, at, c.versionId, c.versionId)
          : run(db, `UPDATE artifact_version_state SET availability = 'unavailable', checked_at = ? WHERE ${gitVersion} AND availability <> 'unavailable'`, at, c.versionId, c.versionId)
      changed += res.changes
      // I4: a proof (present, missing, mismatch) is fresh until the re-check interval passes; an unproven read is retried.
      if (c.object !== 'unreadable' && res.changes === 0) run(db, `UPDATE artifact_version_state SET checked_at = ? WHERE ${gitVersion} AND checked_at < ?`, at, c.versionId, c.versionId, at)
    }
    return changed
  })
}

// ---------------------------------------------------------------------------------------------------------------- ingestion

/** Records event-only evidence before a stat exists: the location is created pending verification, with no version yet. */
export function recordArtifactEvidence(db: AtlasDb, input: ArtifactEventEvidenceInput, now: string): { documentId: string; duplicate: boolean } {
  const at = iso(now, 'now')
  const ev = evidenceFields(input)
  assertIdentity(input.identity)
  const path = canonicalPath(input.path, 'evidence path', false)
  return db.transaction(() => {
    const existing = get<{ document_id: string }>(db, 'SELECT document_id FROM artifact_evidence WHERE source_key = ?', ev.sourceKey)
    if (existing) return { documentId: existing.document_id, duplicate: true }
    const root = rootRecord(db, input.rootId) ?? fail('evidence names an unknown root')
    if (!within(path, root.canonical_path)) fail('evidence path is outside its root')
    assertIdentityMatchesPath(db, input.identity, path, root)
    const eventAt = boundedTime(ev.eventAt, at)
    let loc = locationByPath(db, path)
    let documentId = loc?.document_id ?? null
    if (documentId === null) {
      documentId = documentFor(db, input.identity, at, eventAt ? { at: eventAt, source: ev.source } : { at, source: FALLBACK_ACTIVITY }, projectFor(db, input.identity, root), root)
      if (loc) linkLocation(db, loc, path, documentId, root.root_id)
    }
    if (!loc) {
      loc = createLocation(db, { path, root, documentId, createdAt: eventAt ?? at, verifiedAt: null, sizeBytes: null })
    } else {
      applyCurrentPolicy(db, loc, path, documentId, input.identity.relativePath)
      // A successful tool write recreated a path last seen missing; its stat is still to come.
      if (loc.exists_state !== 'present') run(db, `UPDATE artifacts SET exists_state = 'present', verification_state = 'pending' WHERE artifact_id = ?`, loc.artifact_id)
    }
    applyEvidence(db, ev, { documentId, versionId: null, artifactId: loc.artifact_id, observedAt: at, now: at })
    return { documentId, duplicate: false }
  })
}

export function recordArtifactObservation(db: AtlasDb, observation: ArtifactWorkerObservation, now: string): { documentId: string; artifactId: number | null; versionId: string | null; duplicate: boolean } {
  const at = iso(now, 'now')
  return db.transaction(() => {
    const applied = applyObservation(db, observation, at, false)
    return 'deferMs' in applied ? fail('a working observation was deferred without a quiet period') : applied
  })
}

// ---------------------------------------------------------------------------------------------------------------- document identity

type MergeSource = {
  document_id: string; protected: number; first_observed_at: string; first_created_at: string | null
  last_change_at: string | null; last_change_source: string | null; project_name: string | null
}

// Everything that names a document. Locations, versions and evidence move with it; aliases already pointing at it follow.
const DOCUMENT_REFERENCES = ['artifact_versions', 'artifact_evidence', 'artifacts', 'artifact_document_aliases'] as const

/**
 * Merges document `fromId` into `intoId` and retires `fromId` (run it inside the caller's transaction). Its locations, versions
 * and evidence move over without being copied, rewritten or counted twice (version identities are content-addressed rows that
 * only change owner), the old ID stays as an alias of the survivor so old links resolve, protection and the earliest dates
 * carry over, and a real (non-fallback) activity time is kept when it is later. The survivor's stored availability and
 * preservation are re-derived. Atomic (it joins a surrounding transaction). Returns false, changing nothing, when either document
 * does not exist or they are the same.
 */
export function mergeArtifactDocuments(db: AtlasDb, fromId: string, intoId: string, now: string): boolean {
  if (fromId === intoId) return false
  return db.transaction(() => {
    const from = get<MergeSource>(db, `SELECT document_id, protected, first_observed_at, first_created_at, last_change_at, last_change_source, project_name FROM artifact_documents WHERE document_id = ?`, fromId)
    if (!from || !get(db, 'SELECT 1 AS hit FROM artifact_documents WHERE document_id = ?', intoId)) return false
    for (const table of DOCUMENT_REFERENCES) run(db, `UPDATE ${table} SET document_id = ? WHERE document_id = ?`, intoId, fromId)
    run(db, `INSERT OR IGNORE INTO artifact_document_aliases (alias_id, document_id, created_at) VALUES (?, ?, ?)`, fromId, intoId, now)
    // Earliest dates and any protection carry over; a real (non-fallback) activity time is kept when it is later.
    const source = from.last_change_source ?? FALLBACK_ACTIVITY
    run(db, `UPDATE artifact_documents SET protected = MAX(protected, ?), first_observed_at = MIN(first_observed_at, ?),
        first_created_at = CASE WHEN ? IS NULL THEN first_created_at WHEN first_created_at IS NULL OR first_created_at > ? THEN ? ELSE first_created_at END,
        project_name = COALESCE(project_name, ?),
        last_change_source = CASE WHEN ? IS NOT NULL AND ? <> '${FALLBACK_ACTIVITY}' AND (last_change_at IS NULL OR last_change_source = '${FALLBACK_ACTIVITY}' OR last_change_at < ?) THEN ? ELSE last_change_source END,
        last_change_at = CASE WHEN ? IS NOT NULL AND ? <> '${FALLBACK_ACTIVITY}' AND (last_change_at IS NULL OR last_change_source = '${FALLBACK_ACTIVITY}' OR last_change_at < ?) THEN ? ELSE last_change_at END
      WHERE document_id = ?`,
    from.protected, from.first_observed_at, from.first_created_at, from.first_created_at, from.first_created_at, from.project_name,
    from.last_change_at, source, from.last_change_at, from.last_change_source,
    from.last_change_at, source, from.last_change_at, from.last_change_at, intoId)
    run(db, 'DELETE FROM artifact_documents WHERE document_id = ?', fromId)
    // The triggers keep these current as rows change owner; re-deriving the survivor makes the merge independent of their conditions.
    run(db, refreshArtifactVersionRuleCopiesSql('SELECT version_id FROM artifact_versions WHERE document_id = ?'), intoId)
    run(db, refreshArtifactDocumentStateSql('?'), intoId)
    return true
  })
}

/** A location whose document was born under a root identity, found by `listRootIdentityLocations`. */
export type ArtifactRootIdentityLocation = { path: string; documentId: string }

/**
 * Catalogued locations at or inside `dir` whose document has a ROOT identity (born before a repository was known for the path),
 * in path order, at most `limit`, after path `afterPath`. Read-only: the service uses it when it registers a checkout.
 */
export function listRootIdentityLocations(db: RawDb, dir: string, afterPath: string | null, limit: number): ArtifactRootIdentityLocation[] {
  // [dir + '/', dir + '0') is exactly the strings under dir + '/' in binary order, so the path index serves it.
  return all<{ path: string; document_id: string }>(db,
    `SELECT a.path, a.document_id FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id
     WHERE a.path ${afterPath === null ? '>=' : '>'} ? AND a.path < ? AND d.identity_kind = 'root' ORDER BY a.path LIMIT ?`, afterPath ?? `${dir}/`, `${dir}0`, Math.max(1, Math.trunc(limit)))
    .map(r => ({ path: r.path, documentId: r.document_id }))
}

/** One pending repository-identity adoption: the checkout root and the last path of the last page done (null: not started). */
export type ArtifactIdentityAdoption = { rootId: string; afterPath: string | null; requestedAt: string }

/** Records (or restarts from the beginning) the adoption of a checkout's root-identity documents. Idempotent; runs in the caller's transaction. */
export function requestArtifactIdentityAdoption(db: RawDb, rootId: string, now: string): void {
  run(db, `INSERT INTO artifact_identity_adoptions(root_id, after_path, requested_at, updated_at) VALUES (?, NULL, ?, ?)
    ON CONFLICT(root_id) DO UPDATE SET after_path = NULL, requested_at = excluded.requested_at, updated_at = excluded.updated_at`, rootId, now, now)
}

/** The pending adoption requested first, or null. */
export function nextArtifactIdentityAdoption(db: RawDb): ArtifactIdentityAdoption | null {
  const r = get<{ root_id: string; after_path: string | null; requested_at: string }>(db, 'SELECT root_id, after_path, requested_at FROM artifact_identity_adoptions ORDER BY requested_at, root_id LIMIT 1')
  return r ? { rootId: r.root_id, afterPath: r.after_path, requestedAt: r.requested_at } : null
}

/** Moves a pending adoption's cursor to `afterPath`, or deletes it when `afterPath` is null (the last page is done). */
export function advanceArtifactIdentityAdoption(db: RawDb, rootId: string, afterPath: string | null, now: string): void {
  if (afterPath === null) run(db, 'DELETE FROM artifact_identity_adoptions WHERE root_id = ?', rootId)
  else run(db, 'UPDATE artifact_identity_adoptions SET after_path = ?, updated_at = ?, failures = 0 WHERE root_id = ?', afterPath, now, rootId)
}

/**
 * A page of this adoption failed (and rolled back): the cursor keeps its position, the row moves behind every other pending one
 * (requested_at = now) and the failure is counted. After `maxFailures` consecutive failures the row is dropped; the documents keep
 * their root identity until the root is registered again. Returns the count and whether the row was dropped.
 */
export function failArtifactIdentityAdoption(db: RawDb, rootId: string, now: string, maxFailures: number): { failures: number; dropped: boolean } {
  run(db, 'UPDATE artifact_identity_adoptions SET failures = failures + 1, requested_at = ?, updated_at = ? WHERE root_id = ?', now, now, rootId)
  const row = get<{ failures: number }>(db, 'SELECT failures FROM artifact_identity_adoptions WHERE root_id = ?', rootId)
  if (!row) return { failures: 0, dropped: false }
  if (row.failures >= maxFailures) { run(db, 'DELETE FROM artifact_identity_adoptions WHERE root_id = ?', rootId); return { failures: row.failures, dropped: true } }
  return { failures: row.failures, dropped: false }
}

export function dropArtifactIdentityAdoption(db: RawDb, rootId: string): void {
  run(db, 'DELETE FROM artifact_identity_adoptions WHERE root_id = ?', rootId)
}

export type ArtifactRepositoryAdoption = { path: string; rootId: string; identity: ArtifactDocumentIdentity }

/**
 * A location whose document was created under a ROOT identity (a hook that arrived before the checkout was registered, or
 * before the repository was known) takes the repository identity the service has now verified for its path. Each entry is a
 * path and a repository identity the service validated itself (the observing root, the re-authorized path, the identity
 * recomputed by the path policy): nothing is trusted from a worker. For each location still on a root-identity document:
 *   - when a document with that repository identity already exists, the root-identity document is merged into it
 *     (mergeArtifactDocuments: locations, versions and the original session evidence move, the old ID stays an alias);
 *   - otherwise the document is re-identified in place and keeps its ID, so nothing moves and no link changes.
 * No byte equality is claimed and no version is created or rewritten. Protection is only raised. Idempotent: a location already
 * on a repository (or provisional) document, or at an unknown path, is left alone. Returns how many documents were resolved.
 */
export function adoptArtifactRepositoryIdentity(db: AtlasDb, entries: ArtifactRepositoryAdoption[], now: string): { reidentified: number; merged: number } {
  const counts = { reidentified: 0, merged: 0 }
  if (entries.length === 0) return counts
  const at = iso(now, 'now')
  db.transaction(() => {
    for (const e of entries) {
      const id = e.identity
      if (!id || id.identityKind !== 'repository' || !isId(id.repositoryId) || id.rootId !== null) continue
      let rel: string
      try { rel = relativePath(id.relativePath) } catch { continue }
      const loc = get<{ artifact_id: number; document_id: string }>(db,
        `SELECT a.artifact_id, a.document_id FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.path = ? AND d.identity_kind = 'root'`, e.path)
      if (!loc) continue
      if (!get(db, 'SELECT 1 AS hit FROM artifact_repositories WHERE repository_id = ?', id.repositoryId)) continue
      const target = get<{ document_id: string }>(db, `SELECT document_id FROM artifact_documents WHERE identity_kind = 'repository' AND repository_id = ? AND relative_path = ?`, id.repositoryId, rel)
      let documentId: string
      if (target) {
        if (!mergeArtifactDocuments(db, loc.document_id, target.document_id, at)) continue
        documentId = target.document_id
        counts.merged++
      } else {
        run(db, `UPDATE artifact_documents SET identity_kind = 'repository', repository_id = ?, identity_root_id = NULL, relative_path = ? WHERE document_id = ?`, id.repositoryId, rel, loc.document_id)
        documentId = loc.document_id
        counts.reidentified++
      }
      const root = rootRecord(db, e.rootId)
      if (root) {
        const project = projectFor(db, id, root)
        if (project !== null) run(db, 'UPDATE artifact_documents SET project_name = ? WHERE document_id = ? AND project_name IS NULL', project, documentId)
      }
      // The repository identity brings the repository's own path rules: the same raise-only protection a new repository document gets.
      if (hasPhiSegment(rel) || repositoryPathProtected(db, id.repositoryId, rel) || isProtectedPath(db, e.path)) raiseProtection(db, documentId)
      run(db, `UPDATE artifacts SET is_sensitive = MAX(is_sensitive, (SELECT protected FROM artifact_documents WHERE document_id = ?)) WHERE document_id = ?`, documentId, documentId)
      raiseProtectionFromLocation(db, documentId, loc.artifact_id)
    }
  })
  return counts
}

// ---------------------------------------------------------------------------------------------------------------- repositories and roots

export function registerArtifactRepository(db: AtlasDb, input: ArtifactRepositoryRegistration, now: string): string {
  const at = iso(now, 'now')
  const commonDir = canonicalPath(input.commonDir, 'repository common directory', true)
  if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 200 || CONTROL_RE.test(input.displayName)) fail('repository display name is malformed')
  if (input.remoteIdentity !== null && (typeof input.remoteIdentity !== 'string' || input.remoteIdentity.length > 512 || CONTROL_RE.test(input.remoteIdentity))) fail('repository remote identity is malformed')
  return db.transaction(() => {
    const existing = get<{ repository_id: string }>(db, 'SELECT repository_id FROM artifact_repositories WHERE common_dir = ?', commonDir)
    if (existing) {
      run(db, 'UPDATE artifact_repositories SET last_verified_at = ?, remote_identity = COALESCE(?, remote_identity) WHERE repository_id = ?', at, input.remoteIdentity, existing.repository_id)
      return existing.repository_id
    }
    const repositoryId = randomUUID()
    run(db, `INSERT INTO artifact_repositories (repository_id, common_dir, display_name, remote_identity, registered_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?)`,
      repositoryId, commonDir, input.displayName.trim(), input.remoteIdentity, at, at)
    return repositoryId
  })
}

/**
 * Registers a root, deduplicated by canonical path across sessions, configuration and CLI: scope flags merge, the stronger
 * kind wins (checkout over output over session directory), and protection from any registration sticks, including on the
 * locations already catalogued under it.
 */
export function registerArtifactRoot(db: AtlasDb, input: ArtifactRootRegistration, now: string): ArtifactRootRow {
  iso(now, 'now')
  const path = canonicalPath(input.canonicalPath, 'root path', true)
  if (!ROOT_KINDS.includes(input.kind)) fail('unknown root kind')
  if (input.repositoryId !== null && !isId(input.repositoryId)) fail('root repository ID is malformed')
  if (input.projectName !== null && (typeof input.projectName !== 'string' || input.projectName.length > 200 || CONTROL_RE.test(input.projectName))) fail('root project name is malformed')
  if (input.checkoutIdentity !== null && !isId(input.checkoutIdentity)) fail('root checkout identity is malformed')
  if (typeof input.protected !== 'boolean') fail('root protection must be a boolean')
  if (!Array.isArray(input.scopeFlags) || input.scopeFlags.some(f => !SCOPE_FLAGS.includes(f))) fail('unknown root scope flag')
  return db.transaction(() => {
    if (input.repositoryId !== null && !get(db, 'SELECT 1 AS hit FROM artifact_repositories WHERE repository_id = ?', input.repositoryId)) fail('root names an unknown repository')
    const existing = get<RootRecord>(db, 'SELECT * FROM artifact_roots WHERE canonical_path = ?', path)
    let rootId: string
    if (existing) {
      rootId = existing.root_id
      const flags = [...new Set([...(JSON.parse(existing.scope_flags) as string[]), ...input.scopeFlags])].sort()
      const kind = KIND_RANK[input.kind] > KIND_RANK[existing.kind] ? input.kind : existing.kind
      run(db, `UPDATE artifact_roots SET kind = ?, repository_id = COALESCE(?, repository_id), project_name = COALESCE(?, project_name), checkout_identity = COALESCE(?, checkout_identity),
        protected = MAX(protected, ?), active = 1, scope_flags = ? WHERE root_id = ?`, kind, input.repositoryId, input.projectName, input.checkoutIdentity, flag(input.protected), JSON.stringify(flags), rootId)
    } else {
      rootId = randomUUID()
      run(db, `INSERT INTO artifact_roots (root_id, kind, canonical_path, repository_id, project_name, checkout_identity, protected, active, scope_flags, desired_generation, applied_generation, cursor, coverage_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, NULL, 'idle')`, rootId, input.kind, path, input.repositoryId, input.projectName, input.checkoutIdentity, flag(input.protected),
      JSON.stringify([...new Set(input.scopeFlags)].sort()))
    }
    const root = rootRecord(db, rootId)!
    // Raise-only protection runs when this registration changes what is protected: the root became protected, or it became
    // (a checkout of) a repository. An unchanged re-registration is a no-op. Each (checkout, protected root) pair that
    // involves this root is checked in both directions, so the result does not depend on registration order.
    const becameProtected = root.protected === 1 && existing?.protected !== 1
    const becameCheckout = root.kind === 'checkout' && root.repository_id !== null && (existing?.kind !== 'checkout' || existing.repository_id !== root.repository_id)
    if (becameProtected) {
      // [path + '/', path + '0') is exactly the strings under path + '/' in binary order, so the path index serves it.
      run(db, `UPDATE artifacts SET is_sensitive = 1 WHERE is_sensitive = 0 AND (path = ? OR (path >= ? AND path < ?))`, path, `${path}/`, `${path}0`)
      run(db, `UPDATE artifact_documents SET protected = 1 WHERE protected = 0 AND document_id IN
        (SELECT document_id FROM artifacts WHERE document_id IS NOT NULL AND (path = ? OR (path >= ? AND path < ?)))`, path, `${path}/`, `${path}0`)
      // Git-only documents have no location: check every checkout at, above or inside this root.
      for (const c of relatedRoots(db, path, `kind = 'checkout' AND repository_id IS NOT NULL`)) protectRepositoryPaths(db, c.repository_id!, c.canonical_path, path)
    }
    if (becameCheckout) {
      if (hasPhiSegment(path)) raiseRepository(db, root.repository_id!)
      for (const q of relatedRoots(db, path, 'protected = 1')) protectRepositoryPaths(db, root.repository_id!, path, q.canonical_path)
    }
    if (input.projectName !== null) {
      // A root's own documents follow its registered project; a repository's documents only gain a project they lacked,
      // since several roots may observe one repository.
      run(db, `UPDATE artifact_documents SET project_name = ? WHERE identity_kind = 'root' AND identity_root_id = ? AND project_name IS NOT ?`, root.project_name, rootId, root.project_name)
      if (root.repository_id !== null) {
        run(db, `UPDATE artifact_documents SET project_name = ? WHERE identity_kind = 'repository' AND repository_id = ? AND project_name IS NULL`, root.project_name, root.repository_id)
      }
    }
    return toRootRow(root)
  })
}

function raiseRepository(db: RawDb, repositoryId: string): void {
  run(db, `UPDATE artifact_documents SET protected = 1 WHERE identity_kind = 'repository' AND repository_id = ? AND protected = 0`, repositoryId)
}

/** Roots matching `filter` (a fixed SQL condition) at `path`, above it, or inside it; separator-aware in every direction. */
function relatedRoots(db: RawDb, path: string, filter: string): Array<{ repository_id: string | null; canonical_path: string }> {
  return all(db, `SELECT repository_id, canonical_path FROM artifact_roots WHERE ${filter}
    AND (canonical_path = ? OR (canonical_path >= ? AND canonical_path < ?) OR substr(?, 1, length(canonical_path) + 1) = canonical_path || '/')`, path, `${path}/`, `${path}0`, path)
}

/**
 * Raises the repository documents that one (checkout, protected root) pair puts under protection: all of them when the
 * protected root is at or above the checkout, else those at or under the root's path relative to the checkout. One set-based
 * UPDATE per pair; unrelated pairs change nothing.
 */
function protectRepositoryPaths(db: RawDb, repositoryId: string, checkoutPath: string, protectedPath: string): void {
  if (within(checkoutPath, protectedPath)) {
    raiseRepository(db, repositoryId)
  } else if (within(protectedPath, checkoutPath)) {
    const rel = protectedPath.slice(checkoutPath.length + 1)
    run(db, `UPDATE artifact_documents SET protected = 1 WHERE identity_kind = 'repository' AND repository_id = ? AND protected = 0 AND (relative_path = ? OR (relative_path >= ? AND relative_path < ?))`,
      repositoryId, rel, `${rel}/`, `${rel}0`)
  }
}

export function listArtifactRoots(db: AtlasDb): ArtifactRootRow[] {
  return all<RootRecord>(db, 'SELECT * FROM artifact_roots ORDER BY canonical_path').map(toRootRow)
}

// ---------------------------------------------------------------------------------------------------------------- jobs

function checkCursor(cursor: unknown): string | null {
  if (cursor === null) return null
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_CHARS) fail(`cursor must be text of at most ${MAX_CURSOR_CHARS} characters`)
  return cursor
}

function checkCoverage(coverage: unknown): 'complete' | 'partial' | 'inaccessible' {
  if (!COVERAGES.includes(coverage as typeof COVERAGES[number])) fail('unknown coverage')
  return coverage as typeof COVERAGES[number]
}

function rootCoverage(coverage: 'complete' | 'partial' | 'inaccessible'): ArtifactRootCoverageState {
  return coverage === 'complete' ? 'idle' : coverage
}

function leaseFrom(now: string): string {
  return new Date(Date.parse(now) + ARTIFACT_JOB_LEASE_MS).toISOString()
}

function runningJob(db: RawDb, jobId: string): JobRecord {
  const job = jobRecord(db, jobId) ?? fail('unknown artifact job')
  if (job.state !== 'running') fail('artifact job is not running')
  return job
}

function discoveryPaused(db: RawDb): boolean {
  return get<{ value: string }>(db, 'SELECT value FROM artifact_manager_state WHERE key = ?', PAUSE_KEY)?.value === '1'
}

/**
 * Coalesces work on (scope, task). A waiting job keeps its place in line and takes the more urgent priority. A pass that has
 * started (running, or parked between slices or for a retry with its pass generation fixed) cannot cover an event that
 * arrives during it, so desired moves past that pass generation; several events during one pass coalesce into that one bump.
 * A finished or failed job is requeued. A direct check waiting for its file to settle (retry, last error 'settling') becomes
 * queued at once: a settle wait is not a failure backoff, and any other retry keeps its time.
 */
export function enqueueArtifactJob(db: AtlasDb, input: ArtifactJobInput, now: string): string {
  const at = iso(now, 'now')
  if (typeof input.scopeId !== 'string' || !input.scopeId || input.scopeId.length > MAX_SCOPE_CHARS || input.scopeId.includes('\0')) fail('job scope is malformed')
  if (!TASK_KINDS.includes(input.taskKind)) fail('unknown task kind')
  if (!Number.isInteger(input.priority)) fail('job priority must be an integer')
  if (!Number.isInteger(input.generation) || input.generation < 0) fail('job generation must be a non-negative integer')
  const setCursor = input.cursor !== undefined
  const cursor = setCursor ? checkCursor(input.cursor) : null
  return db.transaction(() => {
    const job = get<JobRecord>(db, 'SELECT * FROM artifact_jobs WHERE scope_id = ? AND task_kind = ?', input.scopeId, input.taskKind)
    let jobId: string
    if (!job) {
      jobId = randomUUID()
      run(db, `INSERT INTO artifact_jobs (job_id, scope_id, task_kind, desired_generation, applied_generation, state, priority, lease_until, retry_at, attempts, cursor, coverage_state, last_error, updated_at)
        VALUES (?, ?, ?, ?, 0, 'queued', ?, NULL, NULL, 0, ?, 'partial', NULL, ?)`, jobId, input.scopeId, input.taskKind, Math.max(1, input.generation), input.priority, cursor, at)
    } else if (job.state === 'queued' || job.state === 'retry' || job.state === 'running') {
      jobId = job.job_id
      // A running job's cursor belongs to its worker; only a waiting job's cursor may be replaced.
      // A settle wait is not a failure backoff: a new event deserves an immediate look, since a tool's report may now exempt the file.
      run(db, `UPDATE artifact_jobs SET desired_generation = MAX(desired_generation, ?, COALESCE(pass_generation + 1, 0)), priority = MIN(priority, ?),
        cursor = CASE WHEN ? AND state <> 'running' THEN ? ELSE cursor END,
        state = CASE WHEN state = 'retry' AND last_error = '${ARTIFACT_SETTLING}' THEN 'queued' ELSE state END,
        retry_at = CASE WHEN state = 'retry' AND last_error = '${ARTIFACT_SETTLING}' THEN NULL ELSE retry_at END WHERE job_id = ?`, input.generation, input.priority, flag(setCursor), cursor, jobId)
    } else {
      jobId = job.job_id
      run(db, `UPDATE artifact_jobs SET desired_generation = MAX(MAX(desired_generation, applied_generation) + 1, ?), state = 'queued', priority = ?, attempts = 0, lease_until = NULL,
        retry_at = NULL, last_error = NULL, cursor = CASE WHEN ? THEN ? ELSE cursor END, updated_at = ? WHERE job_id = ?`, input.generation, input.priority, flag(setCursor), cursor, at, jobId)
    }
    if (SCAN_TASKS.has(input.taskKind)) {
      run(db, `UPDATE artifact_roots SET desired_generation = MAX(desired_generation, (SELECT desired_generation FROM artifact_jobs WHERE job_id = ?)),
        coverage_state = CASE WHEN coverage_state IN ('idle', 'failed') THEN 'queued' ELSE coverage_state END WHERE root_id = ?`, jobId, input.scopeId)
    }
    return jobId
  })
}

/**
 * Claims the next due job: lowest priority number first, then the one waiting longest. Due means queued, a retry whose time
 * has come, or a running job whose lease expired. Nothing is claimed while discovery is paused; queued work waits for resume.
 * A claim with no cursor starts a pass and fixes its pass generation at the current desired generation; a claim that
 * resumes a cursor continues the same pass. The returned desiredGeneration is the current desired generation either way.
 */
export function claimArtifactJob(db: AtlasDb, now: string): ArtifactJobRow | null {
  const at = iso(now, 'now')
  return db.transaction(() => {
    if (discoveryPaused(db)) return null
    const job = get<JobRecord>(db, `SELECT * FROM artifact_jobs WHERE state = 'queued' OR (state = 'retry' AND retry_at <= ?) OR (state = 'running' AND lease_until <= ?)
      ORDER BY priority ASC, updated_at ASC, job_id ASC LIMIT 1`, at, at)
    if (!job) return null
    run(db, `UPDATE artifact_jobs SET state = 'running', lease_until = ?, retry_at = NULL, attempts = attempts + 1, updated_at = ?,
      pass_generation = CASE WHEN cursor IS NULL OR pass_generation IS NULL THEN desired_generation ELSE pass_generation END WHERE job_id = ?`, leaseFrom(at), at, job.job_id)
    if (SCAN_TASKS.has(job.task_kind)) {
      run(db, `UPDATE artifact_roots SET coverage_state = 'scanning', desired_generation = MAX(desired_generation, ?) WHERE root_id = ?`, job.desired_generation, job.scope_id)
    }
    return toJobRow(jobRecord(db, job.job_id)!)
  })
}

/**
 * Applies one worker batch and its checkpoint in one transaction: an invalid row rolls back the whole batch and leaves the
 * cursor where it was, so a replay after a crash starts from committed progress. A complete batch records the pass
 * generation fixed when its pass started, never a desired generation that advanced during the pass.
 *
 * Settle before version: with `quietMs` above 0 a working row whose file changed less than that long before its capture records
 * nothing (see applyWorking) and its path is returned in `deferredPaths`. In the same transaction that path's direct check is
 * scheduled for when the quiet period ends: created in `retry` when absent, pushed later when already waiting, revived into `retry`
 * when failed or done, left alone when queued, and kept in `retry` when it is this very job. The scan itself, and its coverage, are
 * unaffected.
 */
export function commitArtifactBatch(db: AtlasDb, jobId: string, generation: number, observations: ArtifactWorkerObservation[],
  checkpoint: { cursor: string | null; coverage: 'complete' | 'partial' | 'inaccessible'; complete: boolean }, now: string,
  opts: { quietMs?: number } = {}): { deferredPaths: string[] } {
  const at = iso(now, 'now')
  const quietMs = opts.quietMs ?? 0
  if (typeof quietMs !== 'number' || !Number.isFinite(quietMs) || quietMs < 0) fail('quiet period must be a non-negative number')
  if (!Number.isInteger(generation) || generation < 0) fail('batch generation must be a non-negative integer')
  if (!Array.isArray(observations) || observations.length > MAX_BATCH_ROWS) fail(`a batch carries at most ${MAX_BATCH_ROWS} observations`)
  const cursor = checkCursor(checkpoint.cursor)
  const coverage = checkCoverage(checkpoint.coverage)
  if (typeof checkpoint.complete !== 'boolean') fail('checkpoint completion must be a boolean')
  const complete = checkpoint.complete
  return db.transaction(() => {
    const job = runningJob(db, jobId)
    if (generation > job.desired_generation) fail('batch generation is ahead of its job')
    // Unchanged files are not re-verified by an ordinary scan; explicit verification and direct checks may refresh them.
    const refresh = job.task_kind === 'verify' || job.task_kind === 'direct-observation'
    const passGeneration = job.pass_generation ?? generation
    const deferred: Array<Deferred & { rootId: string }> = []
    observations.forEach((obs, i) => {
      try {
        const applied = applyObservation(db, obs, at, refresh, quietMs)
        if ('deferMs' in applied) deferred.push({ ...applied, rootId: obs.rootId })
      } catch (err) {
        throw new Error(`artifact batch row ${i}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }
    })
    run(db, `UPDATE artifact_jobs SET cursor = ?, coverage_state = ?, applied_generation = CASE WHEN ? THEN MAX(applied_generation, ?) ELSE applied_generation END, lease_until = ?, updated_at = ?
      WHERE job_id = ?`, complete ? null : cursor, coverage, flag(complete), passGeneration, leaseFrom(at), at, jobId)
    for (const d of deferred) scheduleSettleCheck(db, job, d, at)
    const deferredPaths = deferred.map(d => d.path)
    if (!SCAN_TASKS.has(job.task_kind)) return { deferredPaths }
    if (!complete) {
      run(db, 'UPDATE artifact_roots SET cursor = ? WHERE root_id = ?', cursor, job.scope_id)
    } else {
      const success = coverage === 'complete'
      run(db, `UPDATE artifact_roots SET cursor = NULL, applied_generation = MAX(applied_generation, ?), coverage_state = ?,
        last_successful_at = CASE WHEN ? THEN ? ELSE last_successful_at END, last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE root_id = ?`,
      passGeneration, rootCoverage(coverage), flag(success), at, flag(success), job.scope_id)
    }
    return { deferredPaths }
  })
}

/** Schedules the direct check of one skipped path for when its quiet period ends, by the state of that path's existing job. */
function scheduleSettleCheck(db: RawDb, running: JobRecord, d: Deferred & { rootId: string }, at: string): void {
  const due = new Date(Date.parse(at) + Math.ceil(d.deferMs)).toISOString()
  const scopeId = artifactDirectScopeId(d.rootId, d.path)
  const existing = get<JobRecord>(db, `SELECT * FROM artifact_jobs WHERE scope_id = ? AND task_kind = 'direct-observation'`, scopeId)
  if (!existing) {
    run(db, `INSERT INTO artifact_jobs (job_id, scope_id, task_kind, desired_generation, applied_generation, state, priority, lease_until, retry_at, attempts, cursor, coverage_state, last_error, updated_at)
      VALUES (?, ?, 'direct-observation', 1, 0, 'retry', ?, NULL, ?, 0, NULL, 'partial', ?, ?)`, randomUUID(), scopeId, running.priority, due, ARTIFACT_SETTLING, at)
  } else if (existing.job_id === running.job_id) {
    // The path's own check deferring itself. Desired stays put: a bump here could not be told from an event that arrived during the run.
    run(db, `UPDATE artifact_jobs SET retry_at = MAX(COALESCE(retry_at, ?), ?), last_error = ? WHERE job_id = ?`,
      due, due, ARTIFACT_SETTLING, existing.job_id)
  } else if (existing.state === 'retry') {
    // Only a settle wait is moved; a retry with any other last_error is a failure backoff and stays as it is.
    run(db, `UPDATE artifact_jobs SET retry_at = MAX(COALESCE(retry_at, ?), ?), priority = MIN(priority, ?) WHERE job_id = ? AND last_error = ?`, due, due, running.priority, existing.job_id, ARTIFACT_SETTLING)
  } else if (existing.state === 'running') {
    run(db, `UPDATE artifact_jobs SET desired_generation = MAX(desired_generation, COALESCE(pass_generation + 1, 0)) WHERE job_id = ?`, existing.job_id)
  } else if (existing.state !== 'queued') {
    run(db, `UPDATE artifact_jobs SET state = 'retry', retry_at = ?, attempts = 0, lease_until = NULL, cursor = NULL, last_error = ?, desired_generation = MAX(desired_generation, applied_generation) + 1,
      priority = MIN(priority, ?), updated_at = ? WHERE job_id = ?`, due, ARTIFACT_SETTLING, running.priority, at, existing.job_id)
  }
}

/**
 * Ends a run. An error fails the job, kept for inspection with its cursor so new activity resumes it. A complete run records
 * its pass generation; if desired has moved past it (an event arrived during the pass) the job requeues for a fresh pass
 * from no cursor, else it is done, and a direct observation's row is deleted since every file gets its own job. A run that
 * is not complete is a slice boundary: the job requeues and resumes the same pass from its cursor. A complete, error-free direct
 * observation that still has a `retry_at` (a claim always clears it, so commitArtifactBatch set it) was deferred to let its file
 * settle is neither deleted nor done. If an event arrived during that run (desired is past the pass), it is queued at once with no
 * retry time, since the event may exempt the file; its next stat records or defers it again. Otherwise it waits in retry at its
 * time, marked 'settling', with desired moved one past what it applied so the next pass is fresh and the job reads as pending work.
 */
export function finishArtifactJob(db: AtlasDb, jobId: string, result: { complete: boolean; coverage: 'complete' | 'partial' | 'inaccessible'; error?: string }, now: string): void {
  const at = iso(now, 'now')
  const coverage = checkCoverage(result.coverage)
  if (typeof result.complete !== 'boolean') fail('result completion must be a boolean')
  if (result.error !== undefined && typeof result.error !== 'string') fail('result error must be text')
  const error = result.error === undefined ? null : errorCategory(result.error)
  db.transaction(() => {
    const job = runningJob(db, jobId)
    const scan = SCAN_TASKS.has(job.task_kind)
    if (error !== null) {
      // A direct check that deferred its file and then failed is a failure like any other; the next event or a scan of its root resumes it.
      run(db, `UPDATE artifact_jobs SET state = 'failed', lease_until = NULL, retry_at = NULL, coverage_state = ?, last_error = ?, updated_at = ? WHERE job_id = ?`, coverage, error, at, jobId)
      if (scan) run(db, 'UPDATE artifact_roots SET coverage_state = ?, last_error = ? WHERE root_id = ?', coverage === 'inaccessible' ? 'inaccessible' : 'failed', error, job.scope_id)
      return
    }
    if (!result.complete) {
      // A slice boundary clears retry_at. Direct observations are single-batch, so a deferred direct check never reaches this branch.
      run(db, `UPDATE artifact_jobs SET state = 'queued', lease_until = NULL, retry_at = NULL, attempts = 0, coverage_state = ?, last_error = NULL, updated_at = ? WHERE job_id = ?`, coverage, at, jobId)
      if (scan) run(db, 'UPDATE artifact_roots SET coverage_state = ? WHERE root_id = ?', coverage === 'inaccessible' ? 'inaccessible' : 'partial', job.scope_id)
      return
    }
    const applied = Math.max(job.applied_generation, job.pass_generation ?? job.applied_generation)
    const again = applied < job.desired_generation
    if (job.task_kind === 'direct-observation' && job.retry_at !== null && again) {
      run(db, `UPDATE artifact_jobs SET state = 'queued', applied_generation = ?, pass_generation = NULL, cursor = NULL, lease_until = NULL, retry_at = NULL, attempts = 0, coverage_state = ?,
        last_error = NULL, updated_at = ? WHERE job_id = ?`, applied, coverage, at, jobId)
    } else if (job.task_kind === 'direct-observation' && job.retry_at !== null) {
      run(db, `UPDATE artifact_jobs SET state = 'retry', applied_generation = ?, desired_generation = MAX(desired_generation, ? + 1), pass_generation = NULL, cursor = NULL, lease_until = NULL,
        attempts = 0, coverage_state = ?, last_error = ?, updated_at = ? WHERE job_id = ?`, applied, applied, coverage, ARTIFACT_SETTLING, at, jobId)
    } else if (!again && job.task_kind === 'direct-observation') {
      run(db, 'DELETE FROM artifact_jobs WHERE job_id = ?', jobId)
    } else {
      run(db, `UPDATE artifact_jobs SET state = ?, applied_generation = ?, pass_generation = NULL, cursor = NULL, lease_until = NULL, retry_at = NULL, attempts = 0, coverage_state = ?,
        last_error = NULL, updated_at = ? WHERE job_id = ?`, again ? 'queued' : 'done', applied, coverage, at, jobId)
    }
    if (scan) {
      const success = coverage === 'complete'
      run(db, `UPDATE artifact_roots SET applied_generation = MAX(applied_generation, ?), cursor = NULL, coverage_state = ?,
        last_successful_at = CASE WHEN ? THEN ? ELSE last_successful_at END, last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE root_id = ?`,
      applied, again ? 'queued' : rootCoverage(coverage), flag(success), at, flag(success), job.scope_id)
    }
  })
}

/** Schedules a transient failure for a later attempt. The caller picks retryAt from the attempt count and its backoff policy. */
export function retryArtifactJob(db: AtlasDb, jobId: string, category: string, retryAt: string, now: string): void {
  const at = iso(now, 'now')
  const due = iso(retryAt, 'retryAt')
  if (typeof category !== 'string') fail('retry category must be text')
  const reason = errorCategory(category)
  db.transaction(() => {
    const job = runningJob(db, jobId)
    run(db, `UPDATE artifact_jobs SET state = 'retry', retry_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE job_id = ?`, due, reason, at, jobId)
    if (SCAN_TASKS.has(job.task_kind)) run(db, `UPDATE artifact_roots SET coverage_state = 'queued', last_error = ? WHERE root_id = ?`, reason, job.scope_id)
  })
}

export function setArtifactDiscoveryPaused(db: AtlasDb, paused: boolean, now: string): void {
  const at = iso(now, 'now')
  if (typeof paused !== 'boolean') fail('paused must be a boolean')
  run(db, `INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    PAUSE_KEY, paused ? '1' : '0', at)
}

/** Coverage and queue health with no paths: cursors are shown only as present or absent, and reasons only as a category. */
export function getArtifactManagerStatus(db: AtlasDb, now: string): ArtifactManagerStatus {
  const nowMs = Date.parse(iso(now, 'now'))
  const age = (t: string | null) => (t === null ? 0 : Math.max(0, nowMs - Date.parse(t)))
  const roots = all<{ root_id: string; coverage_state: ArtifactRootCoverageState; applied_generation: number; cursor: string | null; last_successful_at: string | null; last_error: string | null; oldest: string | null }>(db,
    `SELECT r.root_id, r.coverage_state, r.applied_generation, r.cursor, r.last_successful_at, r.last_error,
       (SELECT MIN(j.updated_at) FROM artifact_jobs j WHERE j.state IN ('queued', 'retry', 'running')
          AND (j.scope_id = r.root_id OR substr(j.scope_id, 1, length(r.root_id) + 8) = 'direct:' || r.root_id || ':')) AS oldest
     FROM artifact_roots r WHERE r.active = 1 ORDER BY r.canonical_path`)
  const pending = get<{ n: number; oldest: string | null }>(db, `SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM artifact_jobs WHERE state IN ('queued', 'retry', 'running')`)!
  return {
    paused: discoveryPaused(db),
    roots: roots.map(r => ({
      rootId: r.root_id, state: r.coverage_state, generation: r.applied_generation, cursor: r.cursor === null ? null : REDACTED,
      completedAt: r.last_successful_at, oldestQueuedAgeMs: age(r.oldest), reason: r.last_error === null ? null : errorCategory(r.last_error),
    })),
    pendingJobs: pending.n,
    oldestQueueAgeMs: age(pending.oldest),
  }
}

// ---------------------------------------------------------------------------------------------------------------- coverage notes

/**
 * The runner's explanation of a root's coverage (R34, R67, R71): the gap codes its last pass of a task reported, whether that
 * pass completed, and an informational token such as `nested-worktrees-registered`. A root has one note for its scan task
 * (checkout status and output walk share it) and one for its Git history pass, in artifact_manager_state. The runner writes
 * it, the status route explains a root with it and the removal checker reads it (on its own read-only handle) to treat a
 * lookback-only gap as informational. This is the one definition of its key and JSON shape; a value that does not have
 * exactly this shape reads as no note, which grants nothing.
 */
export type ArtifactCoverageNote = {
  task: 'checkout-status' | 'output-walk' | 'git-history' | null
  /** Gap codes (short tokens, at most 32), in the order the pass reported them. */
  codes: string[]
  complete: boolean
  info: string | null
  at: string | null
}

const COVERAGE_NOTE_PREFIX = 'coverage-reason:'
const COVERAGE_NOTE_HISTORY_PREFIX = `${COVERAGE_NOTE_PREFIX}git-history:`
const COVERAGE_NOTE_TASKS: readonly string[] = ['checkout-status', 'output-walk', 'git-history']
const COVERAGE_TOKEN_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_COVERAGE_CODES = 32

/** The state key of a root's coverage note for `task`: the scan tasks share `coverage-reason:<rootId>`; Git history has its own. */
export function coverageNoteKey(rootId: string, task: ArtifactTaskKind): string {
  return task === 'git-history' ? `${COVERAGE_NOTE_HISTORY_PREFIX}${rootId}` : `${COVERAGE_NOTE_PREFIX}${rootId}`
}

/** A stored note read back, or null for anything that is not exactly the stored shape (malformed JSON, codes or info). */
export function parseCoverageNote(raw: unknown): ArtifactCoverageNote | null {
  if (typeof raw !== 'string') return null
  let v: { task?: unknown; codes?: unknown; complete?: unknown; info?: unknown; at?: unknown }
  try { v = JSON.parse(raw) as typeof v } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const codes = v.codes
  if (!Array.isArray(codes) || codes.length > MAX_COVERAGE_CODES || !codes.every(c => typeof c === 'string' && COVERAGE_TOKEN_RE.test(c))) return null
  if (v.info !== undefined && (typeof v.info !== 'string' || !COVERAGE_TOKEN_RE.test(v.info))) return null
  return {
    task: typeof v.task === 'string' && COVERAGE_NOTE_TASKS.includes(v.task) ? v.task as ArtifactCoverageNote['task'] : null,
    codes: [...codes] as string[], complete: v.complete === true, info: typeof v.info === 'string' ? v.info : null, at: typeof v.at === 'string' ? v.at : null,
  }
}

/** Writes (replaces) a root's coverage note for `task`: JSON {task, codes, info?, complete, at}. */
export function writeArtifactCoverageNote(db: AtlasDb, rootId: string, task: ArtifactTaskKind, note: { codes: string[]; complete: boolean; info?: string | null }, now: string): void {
  const at = iso(now, 'now')
  if (!isId(rootId) || !COVERAGE_NOTE_TASKS.includes(task)) fail('coverage note needs a root ID and a root task')
  if (!Array.isArray(note.codes) || note.codes.length > MAX_COVERAGE_CODES || !note.codes.every(c => typeof c === 'string' && COVERAGE_TOKEN_RE.test(c))) fail('coverage note codes are malformed')
  const info = note.info ?? null
  if (info !== null && !COVERAGE_TOKEN_RE.test(info)) fail('coverage note info is malformed')
  const value = JSON.stringify({ task, codes: note.codes, ...(info !== null ? { info } : {}), complete: note.complete === true, at })
  run(db, `INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    coverageNoteKey(rootId, task), value, at)
}

export function deleteArtifactCoverageNote(db: AtlasDb, rootId: string, task: ArtifactTaskKind): void {
  run(db, 'DELETE FROM artifact_manager_state WHERE key = ?', coverageNoteKey(rootId, task))
}

/** A root's coverage note for `task`, or null (none, or not the stored shape). Database errors propagate to the caller. */
export function readArtifactCoverageNote(db: Pick<AtlasDb, 'raw'>, rootId: string, task: ArtifactTaskKind): ArtifactCoverageNote | null {
  return parseCoverageNote(get<{ value: string }>(db, 'SELECT value FROM artifact_manager_state WHERE key = ?', coverageNoteKey(rootId, task))?.value)
}

/** Every readable coverage note by root ID (scan and history notes alike), from one range read of the state keys. */
export function listArtifactCoverageNotes(db: Pick<AtlasDb, 'raw'>): Map<string, ArtifactCoverageNote[]> {
  const out = new Map<string, ArtifactCoverageNote[]>()
  // ';' follows ':' in binary order, so this range is exactly the keys under the prefix (the primary key index serves it).
  for (const r of all<{ key: string; value: string }>(db, 'SELECT key, value FROM artifact_manager_state WHERE key >= ? AND key < ? ORDER BY key',
    COVERAGE_NOTE_PREFIX, `${COVERAGE_NOTE_PREFIX.slice(0, -1)};`)) {
    const rootId = r.key.startsWith(COVERAGE_NOTE_HISTORY_PREFIX) ? r.key.slice(COVERAGE_NOTE_HISTORY_PREFIX.length) : r.key.slice(COVERAGE_NOTE_PREFIX.length)
    const note = parseCoverageNote(r.value)
    if (note) out.set(rootId, [...(out.get(rootId) ?? []), note])
  }
  return out
}

// ------------------------------------------------------------------------------------------ per-root device renumber evidence (R73)
//
// When a location of a root is seen present (verifier, direct check or scan) on a device other than the one recorded for it, and
// it is the same file (inode, size and mtime unchanged: R74.3), the volume came back under another device number (APFS external volumes, btrfs or overlay remounts). The (old -> new) pair is
// kept per root, newest first and bounded, so a later check of a file deleted since can still prove it missing: its recorded
// device must be the OLD device of a pair (or a chain of pairs) and its nearest existing folder's CURRENT device the NEW one.
// Deactivating the root deletes it.

/** One renumber seen on a root: a location recorded on `from` was seen present on `to` at `at`. */
export type ArtifactRootRenumber = { from: string; to: string; at: string }
const ROOT_RENUMBER_PREFIX = 'renumber:'
const MAX_ROOT_RENUMBERS = 4
const DEVICE_NUMBER_RE = /^\d{1,40}$/

/** artifact_manager_state key of a root's renumber evidence (JSON array of {from, to, at}). */
export const artifactRootRenumberKey = (rootId: string): string => `${ROOT_RENUMBER_PREFIX}${rootId}`

/** A root's renumber evidence, newest first; anything not the stored shape reads as none (which proves nothing). */
export function readArtifactRootRenumbers(db: Pick<AtlasDb, 'raw'>, rootId: string): ArtifactRootRenumber[] {
  const raw = get<{ value: string }>(db, 'SELECT value FROM artifact_manager_state WHERE key = ?', artifactRootRenumberKey(rootId))?.value
  if (raw === undefined) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v) || v.length > MAX_ROOT_RENUMBERS) return []
    const out: ArtifactRootRenumber[] = []
    for (const p of v) {
      const r = p as Partial<ArtifactRootRenumber> | null
      if (!r || typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.at !== 'string' || !DEVICE_NUMBER_RE.test(r.from) || !DEVICE_NUMBER_RE.test(r.to)) return []
      out.push({ from: r.from, to: r.to, at: r.at })
    }
    return out
  } catch {
    return []
  }
}

/** Records that a location of `rootId` recorded on device `from` was seen present on device `to` (no-op when equal or invalid). */
export function recordArtifactRootRenumber(db: AtlasDb, rootId: string, from: string, to: string, now: string): void {
  if (from === to || !DEVICE_NUMBER_RE.test(from) || !DEVICE_NUMBER_RE.test(to)) return
  const at = iso(now, 'now')
  const kept = readArtifactRootRenumbers(db, rootId).filter(p => !(p.from === from && p.to === to))
  const value = JSON.stringify([{ from, to, at }, ...kept].slice(0, MAX_ROOT_RENUMBERS))
  run(db, `INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    artifactRootRenumberKey(rootId), value, at)
}

/**
 * Whether a stat (inode, size, mtime) is the same file as a location's stat signature apart from its device (R74.3): the
 * inode, the size and the mtime to the millisecond. No signature, or an unreadable one, is never the same file.
 */
export function artifactSignatureIsSameFile(signature: string | null, stat: { ino: string; size: number; mtimeMs: number }): boolean {
  if (signature === null) return false
  try {
    const v = JSON.parse(signature) as unknown
    return Array.isArray(v) && v[1] === stat.ino && v[2] === stat.size && typeof v[3] === 'number' && Number.isFinite(stat.mtimeMs)
      && Math.floor(v[3]) === Math.floor(stat.mtimeMs)
  } catch {
    return false
  }
}

/** The device recorded in a location's stat signature (its first element), or null. */
export function artifactSignatureDevice(signature: string | null): string | null {
  if (signature === null) return null
  try {
    const v = JSON.parse(signature) as unknown
    return Array.isArray(v) && typeof v[0] === 'string' && DEVICE_NUMBER_RE.test(v[0]) ? v[0] : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------- grouped queries

// Extension, project and protection are stored on the document (idx_artifact_documents_extension/_project). Availability and
// preservation are derived per document from its locations and version state by the rules in migration 9
// (artifactDocumentAvailabilitySql, artifactDocumentAtRiskSql): the list's display evaluates them for the rows of one page; the
// filters read the same rules' values as stored on the document (availability, needs_preservation), which migration 9's
// triggers keep current in every writer's transaction (PERF-GAP-1). Each expression here expects artifact_documents aliased `d`.
// A Git version whose object could not be read without proof either way (`unknown`) makes the document last-known (`stale`),
// not `unavailable`: nothing proved its bytes gone. The UI labels such a version "not checked yet" and keeps Preview and Export
// attempts available (the server reads by content hash and exact size); the background Git object check re-proves it, since an
// unknown version is always due (fix rounds 1 and 2).
const DOC_AVAILABILITY = artifactDocumentAvailabilitySql('d.document_id')
/** Versions a worktree removal could lose: current working copies and live staged snapshots not known to be preserved. */
const atRisk = (extra: string) => artifactDocumentAtRiskSql('d.document_id', extra)
const DOC_PRESERVATION = `CASE
  WHEN ${atRisk(`AND rs.preservation_state = 'unique'`)} THEN 'unique'
  WHEN ${atRisk('')} THEN 'unknown'
  WHEN EXISTS (SELECT 1 FROM artifact_version_state ps INDEXED BY idx_artifact_version_state_preserved
               WHERE ps.version_document_id = d.document_id AND ps.preservation_state = 'preserved') THEN 'preserved'
  ELSE 'unknown' END`

/**
 * Re-derives every version state row's rule copies and every document's stored availability and needs-preservation, and writes
 * the ones that differ (a repair: the triggers keep them current). Returns how many documents changed.
 */
export function rebuildArtifactDocumentState(db: AtlasDb): number {
  return db.transaction(() => {
    run(db, refreshArtifactVersionRuleCopiesSql('SELECT version_id FROM artifact_version_state'))
    run(db, clearOrphanArtifactVersionRuleCopiesSql('SELECT version_id FROM artifact_version_state'))
    return run(db, refreshArtifactDocumentStateSql('SELECT document_id FROM artifact_documents')).changes
  })
}

export type ArtifactDocumentStateDrift = { documentId: string; stored: { availability: string; needsPreservation: number }; derived: { availability: string; needsPreservation: number } }

/**
 * Documents whose stored availability or needs-preservation differs from the rules' definitions, read from the source rows (not
 * through the triggers' copies): always empty while the triggers hold. It reads every document's rows: a check, not a hot path.
 */
export function findArtifactDocumentStateDrift(db: RawDb, limit = 100): ArtifactDocumentStateDrift[] {
  return all<{ document_id: string; availability: string; needs_preservation: number; derived_availability: string; derived_needs: number }>(db,
    `SELECT * FROM (SELECT d.document_id, d.availability, d.needs_preservation, ${artifactDocumentAvailabilityDefinitionSql('d.document_id')} AS derived_availability,
         ${artifactDocumentAtRiskDefinitionSql('d.document_id')} AS derived_needs
       FROM artifact_documents d) WHERE availability IS NOT derived_availability OR needs_preservation IS NOT derived_needs ORDER BY document_id LIMIT ?`,
    Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 100)
    .map(r => ({
      documentId: r.document_id, stored: { availability: r.availability, needsPreservation: r.needs_preservation },
      derived: { availability: r.derived_availability, needsPreservation: r.derived_needs },
    }))
}

const AVAILABILITIES = ['local', 'git', 'stale', 'unavailable']

// ---------------------------------------------------------------------------------------------------------------- catalog shape (fix round 1, I2)

type SchemaObject = { type: string; name: string; sql: string }
type CatalogShape = { objects: SchemaObject[]; columns: Array<{ table: string; column: string }> }
let migrationNineShape: CatalogShape | null = null
const normalizedSql = (sql: string | null): string => (sql ?? '').replace(/\s+/g, ' ').trim()

/**
 * What migration 9 defines, as this build's migrations create it: every table, index and trigger it adds (with its SQL) and
 * every column it adds to a table. Read once per process from two in-memory databases, migrated up to 8 and up to 9, so an
 * amendment of migration 9 is covered without a list to keep in step.
 */
function expectedCatalogShape(): CatalogShape {
  if (migrationNineShape) return migrationNineShape
  const build = (upTo: number) => {
    const db = openDatabase(':memory:', { migrate: false })
    migrate(db, MIGRATIONS.filter(m => m.id <= upTo))
    return db
  }
  const before = build(8), after = build(9)
  try {
    const objects = (db: AtlasDb) => db.raw.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as SchemaObject[]
    const columns = (db: AtlasDb, table: string) => (db.raw.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table) as Array<{ name: string }>).map(c => c.name)
    const old = new Set(objects(before).map(o => o.name))
    const shape: CatalogShape = { objects: objects(after).filter(o => !old.has(o.name)).map(o => ({ ...o, sql: normalizedSql(o.sql) })), columns: [] }
    for (const t of objects(after).filter(o => o.type === 'table')) {
      const had = old.has(t.name) ? new Set(columns(before, t.name)) : new Set<string>()
      for (const column of columns(after, t.name)) if (!had.has(column)) shape.columns.push({ table: t.name, column })
    }
    migrationNineShape = shape
    return shape
  } finally {
    before.close()
    after.close()
  }
}

/**
 * Fix round 1 (I2): when migration 9 is recorded as applied, the tables, columns, indexes and triggers it defines in this build
 * must all be there, the indexes and triggers with this build's SQL. A database migrated by a pre-release build of migration 9
 * (amended in place since) is not: its writes would leave the stored document state unmaintained and its list queries would
 * fail. Returns one line per difference; empty when the catalog has this build's shape or migration 9 has not run yet. Read-only
 * (a few schema reads), so it also works on a read-only connection.
 */
export function artifactCatalogShapeProblems(db: RawDb): string[] {
  const has = (name: string) => db.raw.prepare(`SELECT type, sql FROM sqlite_schema WHERE name = ?`).get(name) as { type: string; sql: string | null } | undefined
  if (!has('schema_migrations') || !db.raw.prepare('SELECT 1 AS hit FROM schema_migrations WHERE id = 9').get()) return []
  const shape = expectedCatalogShape()
  // Columns first (what a pre-release catalog most visibly lacks), then tables, indexes and triggers.
  const problems: string[] = []
  const columnsOf = new Map<string, Set<string>>()
  for (const { table, column } of shape.columns) {
    if (!columnsOf.has(table)) columnsOf.set(table, new Set((db.raw.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table) as Array<{ name: string }>).map(c => c.name)))
    if (!columnsOf.get(table)!.has(column)) problems.push(`missing column ${table}.${column}`)
  }
  const rank: Record<string, number> = { table: 0, index: 1, trigger: 2 }
  for (const o of [...shape.objects].sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3) || a.name.localeCompare(b.name))) {
    const live = has(o.name)
    if (!live) problems.push(`missing ${o.type} ${o.name}`)
    else if (live.type !== o.type) problems.push(`${o.name} is a ${live.type}, not a ${o.type}`)
    else if (o.type !== 'table' && normalizedSql(live.sql) !== o.sql) problems.push(`different ${o.type} ${o.name}`)
  }
  return problems
}

/**
 * Refuses (throws) when the catalog does not have this build's migration 9 shape (artifactCatalogShapeProblems), with what is
 * wrong and what to do. Changes nothing itself. The service calls it before the artifact manager starts, so a pre-release catalog
 * stops the service start like the other schema guards do, before the artifact manager writes to it. The artifact catalog is untouched.
 */
export function assertArtifactCatalogShape(db: AtlasDb): void {
  const problems = artifactCatalogShapeProblems(db)
  if (problems.length === 0) return
  const shown = problems.slice(0, 12).join('; ') + (problems.length > 12 ? `; and ${problems.length - 12} more` : '')
  throw new Error(`artifact-catalog-prerelease-schema: ${db.path} was migrated by a pre-release build of migration 9 (the artifact manager) and lacks what this build needs (${shown}). `
    + 'Atlas has not changed the artifact catalog and will not start on it. Back up the database file, then restore a backup taken before migration 9 ran, or recreate the database; '
    + 'a pre-release migration 9 is not upgraded in place.')
}

/**
 * F-STATS: discards planner statistics on the artifact manager's tables (deleteArtifactPlannerStatistics in migration 9) in its
 * own transaction, and makes this connection's planner forget them. The service calls it at start, before it serves a request:
 * statistics taken after the upgrade (an ANALYZE run by another tool while document links were still empty) could otherwise
 * make the planner scan every location per document again. It looks first, read-only, and takes the write lock only when there
 * is something to delete (fix round 1, R76): the usual start, with no statistics, never waits on another writer. Returns how
 * many statistics rows it removed.
 */
export function discardArtifactPlannerStatistics(db: AtlasDb): number {
  const tables = JSON.stringify(ARTIFACT_MANAGER_TABLES)
  const present = ['sqlite_stat1', 'sqlite_stat4'].some(t => get(db, `SELECT 1 AS hit FROM sqlite_schema WHERE type = 'table' AND name = ?`, t)
    && get(db, `SELECT 1 AS hit FROM ${t} WHERE tbl IN (SELECT value FROM json_each(?)) LIMIT 1`, tables))
  return present ? db.transaction(() => deleteArtifactPlannerStatistics(db.raw)) : 0
}

/**
 * The FROM clause and filters of a grouped list query (artifact_documents aliased `d`). A search drives the query from the set
 * of documents it matches (PERF-GAP-1): the documents with a location whose path matches the path FTS, plus those whose
 * relative path contains every token (Git-only documents have no location), read from the two relative-path indexes; every
 * document with a relative path is in one of them (a provisional document has none). It is the same set the per-document
 * predicate `document IN fts OR all tokens in lower(relative_path)` selected, computed once instead of tested per document.
 */
function documentQuery(f: ArtifactDocumentFilters): { from: string; where: string; params: SqlValue[]; searched: boolean } {
  const clauses: string[] = []
  const params: SqlValue[] = []
  let from = 'artifact_documents d'
  let searched = false
  if (f.q) {
    const fq = ftsQuery(f.q)
    const tokens = f.q.replace(/[^\p{L}\p{N}_.-]+/gu, ' ').split(' ').filter(Boolean).map(t => t.toLowerCase())
    if (fq && tokens.length) {
      const contains = (alias: string) => tokens.map(() => `instr(lower(${alias}.relative_path), ?) > 0`).join(' AND ')
      // CROSS JOIN keeps the matched set as the outer loop: one primary-key lookup per matched document.
      // The FTS is an external-content index of artifacts (content_rowid = artifact_id): its rowid is the location's
      // artifact_id, read without fetching the content row its artifact_id column would load.
      from = `(SELECT fa.document_id FROM artifacts_fts CROSS JOIN artifacts fa ON fa.artifact_id = artifacts_fts.rowid WHERE artifacts_fts MATCH ? AND fa.document_id IS NOT NULL
        UNION SELECT rp.document_id FROM artifact_documents rp INDEXED BY idx_artifact_documents_repository_path WHERE rp.identity_kind = 'repository' AND ${contains('rp')}
        UNION SELECT op.document_id FROM artifact_documents op INDEXED BY idx_artifact_documents_root_path WHERE op.identity_kind = 'root' AND ${contains('op')}) AS m
        CROSS JOIN artifact_documents d ON d.document_id = m.document_id`
      params.push(fq, ...tokens, ...tokens)
      searched = true
    }
  }
  if (f.project !== undefined) { clauses.push('d.project_name = ?'); params.push(f.project) }
  if (f.extension !== undefined) { clauses.push('d.extension = ?'); params.push(f.extension.trim().replace(/^\.+/, '').toLowerCase()) }
  if (f.from !== undefined) { clauses.push('d.last_change_at >= ?'); params.push(f.from) }
  if (f.to !== undefined) { clauses.push('d.last_change_at <= ?'); params.push(f.to) }
  if (f.sessionId !== undefined) { clauses.push('d.document_id IN (SELECT se.document_id FROM artifact_evidence se WHERE se.session_id = ?)'); params.push(f.sessionId) }
  if (f.source !== undefined) {
    if (!SOURCES.includes(f.source)) fail('unknown evidence source filter')
    // A source is low-cardinality, so this probes each document's evidence (idx_artifact_evidence_document) rather than
    // listing every evidence row of that source; a session is selective, so the session filter above drives from its index.
    clauses.push('EXISTS (SELECT 1 FROM artifact_evidence so WHERE so.document_id = d.document_id AND so.source = ?)')
    params.push(f.source)
  }
  // The stored values of the availability and preservation rules (migration 9's triggers keep them current), on their indexes.
  if (f.availability !== undefined) {
    if (!AVAILABILITIES.includes(f.availability)) fail('unknown availability filter')
    clauses.push('d.availability = ?')
    params.push(f.availability)
  }
  if (f.needsPreservation !== undefined) clauses.push(f.needsPreservation ? 'd.needs_preservation = 1' : 'd.needs_preservation = 0')
  const sensitive = f.sensitive ?? 'hide'
  if (sensitive === 'hide') clauses.push('d.protected = 0')
  else if (sensitive === 'only') clauses.push('d.protected = 1')
  else if (sensitive !== 'show') fail('unknown sensitive filter')
  const types = f.types ?? 'documents'
  if (types === 'documents') {
    clauses.push(`d.extension IN (${documentExtensions.map(() => '?').join(', ')})`)
    params.push(...documentExtensions)
  } else if (types !== 'all') {
    fail('unknown types filter')
  }
  return { from, where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, searched }
}

function clampPage(page: ArtifactPage): { limit: number; offset: number } {
  const limit = Number.isFinite(page?.limit) ? Math.min(MAX_PAGE, Math.max(1, Math.trunc(page.limit))) : DEFAULT_PAGE
  const offset = Number.isFinite(page?.offset) ? Math.max(0, Math.trunc(page.offset)) : 0
  return { limit, offset }
}

type SummaryRecord = {
  document_id: string; display_name: string; last_change_at: string | null; last_change_source: string | null; first_observed_at: string; project_name: string | null
  extension: string; availability: ArtifactDocumentSummary['availability']; preservation_state: ArtifactDocumentSummary['preservationState']; protected: number
  location_count: number; version_count: number
}

const CERTAINTY_BY_RANK: ArtifactCertainty[] = ['recorded', 'inferred', 'unknown']

/** Summaries for an already filtered and paginated ID list, returned in that order. */
function summaries(db: AtlasDb, ids: string[]): ArtifactDocumentSummary[] {
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(', ')
  const records = all<SummaryRecord>(db, `SELECT d.document_id, d.display_name, d.last_change_at, d.last_change_source, d.first_observed_at,
      d.project_name, d.extension, d.protected, ${DOC_AVAILABILITY} AS availability, ${DOC_PRESERVATION} AS preservation_state,
      (SELECT COUNT(*) FROM artifacts ca INDEXED BY idx_artifacts_document WHERE ca.document_id = d.document_id) AS location_count,
      (SELECT COUNT(*) FROM artifact_versions cv INDEXED BY idx_artifact_versions_document WHERE cv.document_id = d.document_id) AS version_count
    FROM artifact_documents d WHERE d.document_id IN (${marks})`, ...ids)
  // One association per session, at the strongest certainty its evidence reached.
  const associations = all<{ document_id: string; session_id: string; rank: number }>(db, `SELECT document_id, session_id,
      MIN(CASE certainty WHEN 'recorded' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END) AS rank
    FROM artifact_evidence WHERE session_id IS NOT NULL AND document_id IN (${marks}) GROUP BY document_id, session_id ORDER BY document_id, rank, session_id`, ...ids)
  const bySession = new Map<string, ArtifactDocumentSummary['sessionAssociations']>()
  for (const a of associations) {
    const list = bySession.get(a.document_id) ?? []
    list.push({ sessionId: a.session_id, certainty: CERTAINTY_BY_RANK[a.rank] ?? 'unknown' })
    bySession.set(a.document_id, list)
  }
  const byId = new Map(records.map(r => [r.document_id, r]))
  return ids.flatMap(id => {
    const r = byId.get(id)
    if (!r) return []
    return [{
      documentId: r.document_id, displayName: r.display_name, projectName: r.project_name, extension: r.extension,
      activityAt: r.last_change_at ?? r.first_observed_at, activitySource: r.last_change_source ?? FALLBACK_ACTIVITY,
      sessionAssociations: bySession.get(id) ?? [], availability: r.availability, preservationState: r.preservation_state, protected: r.protected === 1,
      locationCount: r.location_count, versionCount: r.version_count,
    }]
  })
}

/**
 * Filtered, deduplicated document groups, most recent evidenced activity first. Filtering, counting and pagination all run
 * in SQL over artifact_documents, so a document with several locations or sessions is counted and returned once.
 */
export function listArtifactDocuments(db: AtlasDb, filters: ArtifactDocumentFilters, page: ArtifactPage): ArtifactDocumentPage {
  const { limit, offset } = clampPage(page)
  const at = new Date().toISOString()
  const { from, where, params, searched } = documentQuery(filters ?? {})
  const count = () => get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${from} ${where}`, ...params)!.n
  let total: number
  let ids: string[]
  if (searched) {
    // A search's matched set is built once for the page and its total (a window count over the same rows); a page past the
    // end has no row to carry the total, so it is counted on its own.
    const page = all<{ document_id: string; total: number }>(db, `SELECT d.document_id, COUNT(*) OVER () AS total FROM ${from} ${where}
      ORDER BY d.last_change_at DESC, d.document_id DESC LIMIT ? OFFSET ?`, ...params, limit, offset)
    ids = page.map(r => r.document_id)
    total = page.length > 0 ? page[0]!.total : offset === 0 ? 0 : count()
  } else {
    total = count()
    ids = all<{ document_id: string }>(db, `SELECT d.document_id FROM ${from} ${where} ORDER BY d.last_change_at DESC, d.document_id DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset).map(r => r.document_id)
  }
  const result = { rows: summaries(db, ids), total, limit, offset } as ArtifactDocumentPage
  // The coverage is read only by a caller that uses it (the list route builds its own, with the runner's reasons): computed on
  // first access, as of this call (PERF-GAP-1, the status merge).
  let coverage: ArtifactManagerStatus | undefined
  Object.defineProperty(result, 'coverage', { enumerable: true, configurable: true, get: () => (coverage ??= getArtifactManagerStatus(db, at)) })
  return result
}

// A working version's bytes live only at its location, so its stored availability is read through that location (DEFECT-7): a
// location a direct check found missing makes it unavailable, an unverified one (unreachable root, permission failure) only
// last-known, and the same file seen again makes it available again with no write. Commit and index versions keep their
// stored availability, which Git object checks maintain (recordArtifactGitObjectChecks).
const VERSION_SELECT = `SELECT v.version_id, v.kind, v.git_path, v.commit_oid, v.object_format, v.index_stage, v.observed_at,
    CASE v.kind WHEN 'working' THEN v.location_artifact_id END AS location_artifact_id,
    CASE WHEN v.kind = 'working' AND COALESCE(s.availability, 'unknown') = 'available' THEN
      COALESCE((SELECT CASE WHEN wl.exists_state = 'missing' THEN 'unavailable' WHEN wl.verification_state = 'unverified' THEN 'last-known' ELSE 'available' END
        FROM artifacts wl WHERE wl.artifact_id = v.location_artifact_id), 'available')
      ELSE COALESCE(s.availability, 'unknown') END AS availability,
    COALESCE(s.preservation_state, 'unknown') AS preservation_state,
    CASE v.kind
      WHEN 'working' THEN EXISTS (SELECT 1 FROM artifacts ca WHERE ca.artifact_id = v.location_artifact_id AND ca.current_version_id = v.version_id AND ca.exists_state = 'present')
      WHEN 'index' THEN COALESCE(s.availability, 'unknown') <> 'unavailable' AND NOT EXISTS (SELECT 1 FROM artifact_versions nv WHERE nv.kind = 'index'
        AND nv.checkout_identity = v.checkout_identity AND nv.git_path = v.git_path AND nv.index_stage = v.index_stage AND nv.observation_revision > v.observation_revision)
      ELSE 0 END AS is_current
  FROM artifact_versions v LEFT JOIN artifact_version_state s ON s.version_id = v.version_id`

type VersionRecord = {
  version_id: string; kind: ArtifactVersionKind; git_path: string | null; commit_oid: string | null; object_format: 'sha1' | 'sha256' | null; index_stage: number | null
  location_artifact_id: number | null; observed_at: string; availability: ArtifactVersionDetail['availability']; preservation_state: ArtifactVersionDetail['preservationState']; is_current: number
}

function toVersion(r: VersionRecord): ArtifactVersionDetail {
  return {
    versionId: r.version_id, kind: r.kind, gitPath: r.git_path, commitOid: r.commit_oid, objectFormat: r.object_format, stage: r.index_stage,
    locationArtifactId: r.location_artifact_id, observedAt: r.observed_at, availability: r.availability, preservationState: r.preservation_state, current: r.is_current === 1,
  }
}

function resolveDocumentId(db: RawDb, id: string): string | null {
  if (typeof id !== 'string' || !id) return null
  if (get(db, 'SELECT 1 AS hit FROM artifact_documents WHERE document_id = ?', id)) return id
  return get<{ document_id: string }>(db, 'SELECT document_id FROM artifact_document_aliases WHERE alias_id = ?', id)?.document_id ?? null
}

/** One document with paginated locations, versions and evidence. A retired group ID resolves through its alias. */
export function getArtifactDocument(db: AtlasDb, documentId: string, page: ArtifactPage): ArtifactDocumentDetail {
  const { limit, offset } = clampPage(page)
  const id = resolveDocumentId(db, documentId)
  if (id === null) throw new ArtifactDocumentNotFoundError()
  const [document] = summaries(db, [id])
  const windowed = <T>(list: T[]) => ({ rows: list.slice(0, limit), next: list.length > limit ? String(offset + limit) : null })
  const locations = windowed(all<{ artifact_id: number }>(db, 'SELECT artifact_id FROM artifacts WHERE document_id = ? ORDER BY artifact_id LIMIT ? OFFSET ?', id, limit + 1, offset))
  const versions = windowed(all<VersionRecord>(db, `${VERSION_SELECT} WHERE v.document_id = ? ORDER BY v.observed_at DESC, v.version_id DESC LIMIT ? OFFSET ?`, id, limit + 1, offset))
  const evidence = windowed(all<{ source_key: string; source: ArtifactEvidenceSource; operation: ArtifactOperation; certainty: ArtifactCertainty; session_id: string | null; event_at: string | null; observed_at: string; source_locator: string | null }>(db,
    `SELECT source_key, source, operation, certainty, session_id, event_at, observed_at, source_locator FROM artifact_evidence WHERE document_id = ?
     ORDER BY observed_at DESC, evidence_id DESC LIMIT ? OFFSET ?`, id, limit + 1, offset))
  return {
    document: document!,
    locations: locations.rows.map(r => getArtifact(db, r.artifact_id)!),
    versions: versions.rows.map(toVersion),
    evidence: evidence.rows.map(e => ({
      sourceKey: e.source_key, source: e.source, operation: e.operation, certainty: e.certainty, sessionId: e.session_id, eventAt: e.event_at,
      observedAt: e.observed_at, locator: e.source_locator,
    })),
    next: { locations: locations.next, versions: versions.next, evidence: evidence.next },
  }
}

export function getArtifactVersion(db: AtlasDb, versionId: string): ArtifactVersionDetail | null {
  const r = get<VersionRecord>(db, `${VERSION_SELECT} WHERE v.version_id = ?`, versionId)
  return r ? toVersion(r) : null
}

/**
 * Catalog context for the removal checker, SELECT-only so it runs on a read-only handle: registered roots inside or
 * containing the target, known locations inside it and sessions whose start or resume cwd is inside it. Containment is
 * separator-aware (/a/b never matches /a/bc). This is context, not proof: the checker still verifies live state.
 */
export function getArtifactRemovalContext(db: Pick<AtlasDb, 'raw'>, canonicalTargetPath: string): ArtifactRemovalContext {
  const target = canonicalPath(canonicalTargetPath, 'removal target', false)
  const lo = `${target}/`, hi = `${target}0`
  const roots = all<RootRecord>(db, `SELECT * FROM artifact_roots
    WHERE canonical_path = ? OR (canonical_path >= ? AND canonical_path < ?) OR substr(?, 1, length(canonical_path) + 1) = canonical_path || '/'
    ORDER BY canonical_path`, target, lo, hi, target)
  const locations = all<{ path: string; root_id: string | null; document_id: string | null; is_sensitive: number; verification_state: string | null; root_protected: number }>(db,
    `SELECT a.path, a.root_id, a.document_id, a.is_sensitive, a.verification_state,
       EXISTS (SELECT 1 FROM artifact_roots pr WHERE pr.protected = 1 AND (a.path = pr.canonical_path OR substr(a.path, 1, length(pr.canonical_path) + 1) = pr.canonical_path || '/')) AS root_protected
     FROM artifacts a WHERE a.path = ? OR (a.path >= ? AND a.path < ?) ORDER BY a.path`, target, lo, hi)
  const sessions = all<{ session_id: string; start_cwd: string | null; resume_cwd: string | null; status: string; last_activity_at: string | null }>(db,
    `SELECT session_id, start_cwd, resume_cwd, status, last_activity_at FROM sessions
     WHERE start_cwd = ? OR (start_cwd >= ? AND start_cwd < ?) OR resume_cwd = ? OR (resume_cwd >= ? AND resume_cwd < ?)
     ORDER BY last_activity_at DESC, session_id`, target, lo, hi, target, lo, hi)
  const inside = (p: string | null) => p !== null && (p === target || p.startsWith(lo))
  return {
    roots: roots.map(r => ({
      rootId: r.root_id, canonicalPath: r.canonical_path, kind: r.kind, protected: r.protected === 1, active: r.active === 1, coverageState: r.coverage_state,
      desiredGeneration: r.desired_generation, appliedGeneration: r.applied_generation,
    })),
    locations: locations.map(l => ({
      path: l.path, rootId: l.root_id, documentId: l.document_id, protected: l.is_sensitive === 1 || l.root_protected === 1 || hasPhiSegment(l.path),
      verificationState: l.verification_state,
    })),
    sessions: sessions.map(s => ({ sessionId: s.session_id, cwd: inside(s.resume_cwd) ? s.resume_cwd : s.start_cwd, status: s.status, lastActivityAt: s.last_activity_at })),
  }
}

/** Existing locations in artifact_id order, for the resumable legacy backfill (document links and legacy evidence). */
export function listLegacyArtifactBackfill(db: AtlasDb, afterArtifactId: number, limit: number): ArtifactRow[] {
  const after = Number.isFinite(afterArtifactId) ? Math.trunc(afterArtifactId) : 0
  const n = Number.isFinite(limit) ? Math.min(MAX_BACKFILL_PAGE, Math.max(1, Math.trunc(limit))) : DEFAULT_PAGE
  return all<{ artifact_id: number }>(db, 'SELECT artifact_id FROM artifacts WHERE artifact_id > ? ORDER BY artifact_id LIMIT ?', after, n).map(r => getArtifact(db, r.artifact_id)!)
}
