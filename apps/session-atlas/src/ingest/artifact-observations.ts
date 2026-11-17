import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AtlasDb } from '../db/database.ts'
import {
  ARTIFACT_JOB_PRIORITY, artifactDirectScopeId, enqueueArtifactJob, listArtifactRoots, recordArtifactEvidence, recordArtifactObservation, registerArtifactRoot,
  type ArtifactRootRow,
} from '../db/artifact-manager.ts'
import { getSession } from '../db/sessions.ts'
import { authorizeArtifactPath, canonicalizeArtifactRoot, documentIdentityForPath } from '../artifacts/path-policy.ts'
import type { ArtifactCertainty, ArtifactDocumentIdentity, ArtifactEvidenceSource, ArtifactOperation, ArtifactWorkerObservation, ArtifactWorkerRoot } from '../artifacts/contracts.ts'
import type { ToolResultRecord } from '../transcript/records.ts'
import type { Logger } from '../util/log.ts'
import type { AtlasEvent } from './event.ts'

// Hook and transcript observations, recorded with honest attribution (spec s5, plan Task 6).
//
// This module decides what Atlas may later claim about who created or modified a file, so every rule here errs toward
// "unknown":
//   - Only an explicit, successful creation result is a recorded creation. An Edit is a modification. A tool call without a
//     successful result records nothing. A legacy created_path is kept as a legacy claim with certainty `unknown`.
//   - A Bash completion (success or failure) only marks the cwd's registered scope dirty. The cwd is never recorded as a
//     document, and no filename is ever parsed out of a command or its output.
//   - Evidence is immutable and keyed by a stable source key, so replays (HTTP retry, spool drain, transcript reprocessing)
//     never add a second row.
//   - Inference (inferSessionActivity, for the Task 7 scheduler) links every overlapping session as `inferred` or none at all.
//
// Source keys (all at most 512 characters; see sourceId):
//   tool-use:<sessionId>:<toolUseId>     a tool call seen by the hook (payload tool_use_id) or by the transcript (the
//                                        tool_result's tool_use_id). <sessionId> is the transcript identity: the session
//                                        whose transcript holds the call, which is also the session the hook reports after
//                                        re-keying a subagent's events to `agent-<id>`. Both sides build this exact string,
//                                        so the hook and the transcript converge on one evidence row, whichever comes first.
//   hook-event:<sessionId>:<uuid>        a hook observation without a usable tool-use ID: the hook mints one UUID per
//                                        invocation and reuses it for HTTP and spool. It cannot converge with a transcript.
//   legacy:<sessionId>:<id>              a created_path from a pre-Task-6 hook or spool file (id: tool_use_id, else fingerprint).
//   infer:<versionId>:<sessionId>        an inferred link from inferSessionActivity.
//
// Writes go only through the persistence boundary (src/db/artifact-manager.ts). The few reads here are SELECTs. Each
// recording runs in its own SAVEPOINT inside the caller's transaction:
//   - A deterministic policy outcome (validation, authorization or root refusal, stale or forked transcript record, duplicate)
//     is a counted result. Its own writes, if any, roll back, and the event, transcript delta or batch around it goes on.
//   - An unexpected store failure (SQLITE_BUSY/IOERR/FULL, a programming error) rolls back the savepoint and PROPAGATES as an
//     ArtifactObservationStoreError (ruling R30), so the caller's transaction fails and nothing is acknowledged: the hook
//     spools and the spool drain retries, a transcript job keeps its checkpoint and retries.
// Paths and contents are never logged or counted; rejections are counted by stable reason token only, and a store error's
// message carries only a sanitized category (SQLite's error code and its fixed category text, or the error class name).

export type ArtifactObservationOptions = {
  /** Home directory for path authorization. Default: os.homedir(), the HOME the service runs with. */
  home?: string
  /** Receives one sanitized line (no path, no content) when the store fails unexpectedly, before the error propagates. */
  log?: Pick<Logger, 'error'>
}

/** What happened to one observation. Never carries a path, so it is safe in an HTTP response or a log line. */
export type ArtifactObservationOutcome =
  | { status: 'recorded'; source: ArtifactEvidenceSource; documentId: string; rootRegistered: boolean }
  // crossSession: the same tool-use ID is already recorded for this file under another session (a fork/resume copy).
  | { status: 'duplicate'; crossSession?: boolean }
  | { status: 'scope-enqueued'; roots: number }
  | { status: 'no-scope-root' }
  | { status: 'rejected'; reason: string }

/** Input for one exact-path observation. `path` is untrusted until authorized here. */
export type DirectArtifactObservationInput = {
  sessionId: string
  path: string
  operation: ArtifactOperation
  certainty: ArtifactCertainty
  source: 'hook' | 'transcript' | 'legacy'
  sourceKey: string
  eventAt: string
  locator?: string
  /**
   * The tool-use ID this observation came from (hook payload or transcript), when it has one. The locator then becomes
   * `tool_use:<id>`, and the observation is a duplicate if hook or transcript evidence with that locator already exists for
   * the same file under ANY session (ruling R32: tool-use IDs are globally unique, so a second session reporting one is a
   * fork or resume copy, never a second write).
   */
  toolUseId?: string
}

const SCAN_FLAGS: ReadonlySet<string> = new Set(['checkout', 'configured-output', 'cli-output', 'session-cwd'])
// Roots one scope hint may dirty: the cwd's own scope plus registered roots inside the cwd. Bounded so a hint from a broad
// cwd cannot fan out over every registered project.
const MAX_SCOPE_ROOTS = 16
const PRINTABLE_ID_RE = /^[\x20-\x7e]{1,256}$/
// A usable source event / tool-use ID, as event.ts and the hook require.
const SOURCE_EVENT_ID_RE = /^[\x20-\x7e]{1,512}$/
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
// A change this far past the observing clock is not trusted as a change time.
const FUTURE_SKEW_MS = 60_000

/**
 * Inference window (R29): a session is linked to a version transition only if it was active within this many milliseconds of
 * the change (its start no later than change + window, its last activity no earlier than change - window).
 */
export const ARTIFACT_INFERENCE_INTERVAL_MS = 5 * 60_000

/**
 * Transcript age gate (R31): a transcript tool result is a direct observation only if its own timestamp is within this window
 * of the processing clock (and not before the processed session started). Older results (backfill, checkpoint repair,
 * catch-up after downtime) record nothing: a months-old creation must never attach to today's version of the file.
 * Historical attribution belongs to the legacy backfill ("Origin unknown"). 15 minutes covers a transcript job that runs a
 * few minutes after its turn without reaching back into earlier work.
 */
export const TRANSCRIPT_LIVE_WINDOW_MS = 15 * 60_000

// ---------------------------------------------------------------------------------------------------------------- counters

const counters = new Map<string, number>()

function bump(key: string): void {
  counters.set(key, (counters.get(key) ?? 0) + 1)
}

/**
 * Process-lifetime counts by outcome (`recorded`, `duplicate`, `scope-enqueued`, `no-scope-root`, `rejected:<reason>`,
 * `inference:<status>` and `inference-skipped:<reason>`). Tokens only, never paths. For health reporting (Task 7/8).
 */
export function getArtifactObservationCounters(): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function resetArtifactObservationCounters(): void {
  counters.clear()
}

function outcome(o: ArtifactObservationOutcome): ArtifactObservationOutcome {
  bump(o.status === 'rejected' ? `rejected:${o.reason}` : o.status)
  return o
}
const reject = (reason: string): ArtifactObservationOutcome => outcome({ status: 'rejected', reason })

// ---------------------------------------------------------------------------------------------------------------- source keys

/** An ID usable inside a source key: printable ASCII up to 256 characters as is, anything else as a SHA-256 digest. */
function sourceId(id: string): string {
  return PRINTABLE_ID_RE.test(id) ? id : `sha256-${createHash('sha256').update(id).digest('hex')}`
}

/** The key shared by the hook and the transcript for one tool call (see the module comment). */
export function artifactToolUseSourceKey(sessionId: string, toolUseId: string): string {
  return `tool-use:${sessionId}:${sourceId(toolUseId)}`
}
export function artifactHookEventSourceKey(sessionId: string, eventId: string): string {
  return `hook-event:${sessionId}:${sourceId(eventId)}`
}
export function artifactLegacySourceKey(sessionId: string, id: string): string {
  return `legacy:${sessionId}:${sourceId(id)}`
}
export function artifactInferenceSourceKey(versionId: string, sessionId: string): string {
  return `infer:${sourceId(versionId)}:${sessionId}`
}

// ---------------------------------------------------------------------------------------------------------------- helpers

let savepointSeq = 0

/** Raised inside a savepoint to roll back its writes and return a deterministic policy outcome instead. Not a failure. */
class PolicyStop<T> extends Error {
  readonly value: T
  constructor(value: T) {
    super('policy outcome')
    this.value = value
  }
}

/**
 * An unexpected failure of the artifact store while recording an observation (R30). The message holds only a sanitized
 * category, never a path or file content. It propagates so the event is not acknowledged.
 */
export class ArtifactObservationStoreError extends Error {
  readonly category: string
  constructor(category: string) {
    super(`artifact observation store failed (${category})`)
    this.name = 'ArtifactObservationStoreError'
    this.category = category
  }
}

/** SQLite's numeric code and fixed category text (e.g. "sqlite 5 database is locked"), else only the error class name. */
function storeCategory(err: unknown): string {
  const e = (err ?? {}) as { errcode?: unknown; errstr?: unknown; name?: unknown }
  if (typeof e.errcode === 'number') return `sqlite ${e.errcode}${typeof e.errstr === 'string' && /^[a-z ]{1,64}$/.test(e.errstr) ? ` ${e.errstr}` : ''}`
  return typeof e.name === 'string' && /^[A-Za-z]{1,64}$/.test(e.name) ? e.name : 'Error'
}

/**
 * Runs `fn` in its own savepoint inside the caller's transaction (or a new one). A PolicyStop rolls back `fn`'s writes and
 * returns its outcome. Anything else rolls back `fn`'s writes and propagates as ArtifactObservationStoreError.
 */
function isolated<T>(db: AtlasDb, fn: () => T, log?: Pick<Logger, 'error'>): T {
  return db.transaction(() => {
    const name = `artifact_observation_${++savepointSeq}`
    db.raw.exec(`SAVEPOINT ${name}`)
    try {
      const out = fn()
      db.raw.exec(`RELEASE ${name}`)
      return out
    } catch (err) {
      // If SQLite already aborted the whole transaction the savepoint is gone; the caller's rollback then covers it.
      try {
        db.raw.exec(`ROLLBACK TO ${name}`)
        db.raw.exec(`RELEASE ${name}`)
      } catch { /* nothing left to roll back here */ }
      if (err instanceof PolicyStop) return err.value as T
      if (err instanceof ArtifactObservationStoreError) throw err
      const category = storeCategory(err)
      bump('store-error')
      log?.error('artifact observation store failed', { err: category })
      throw new ArtifactObservationStoreError(category)
    }
  })
}

const workerRoot = (r: ArtifactRootRow): ArtifactWorkerRoot => ({
  rootId: r.rootId, kind: r.kind, canonicalPath: r.canonicalPath, repositoryId: r.repositoryId, checkoutIdentity: r.checkoutIdentity, protected: r.protected, scopeFlags: r.scopeFlags,
})
const scannable = (r: ArtifactRootRow): boolean => r.scopeFlags.some(f => SCAN_FLAGS.has(f))
const strictlyWithin = (p: string, dir: string): boolean => p.length > dir.length + 1 && p.startsWith(`${dir}/`)
const atOrWithin = (p: string, dir: string): boolean => p === dir || strictlyWithin(p, dir)
/** Deepest first; equal depth by root ID (code-unit order), matching the path policy's tie-break. */
const deepestFirst = (a: ArtifactRootRow, b: ArtifactRootRow): number =>
  b.canonicalPath.length - a.canonicalPath.length || (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0)

function activeRoots(db: AtlasDb): ArtifactRootRow[] {
  return listArtifactRoots(db).filter(r => r.active)
}

function evidenceExists(db: AtlasDb, sourceKey: string): boolean {
  return db.raw.prepare('SELECT 1 AS hit FROM artifact_evidence WHERE source_key = ?').get(sourceKey) !== undefined
}

/**
 * The root a direct observation is identified and scheduled under, and its identity. Inside a registered checkout the
 * identity is the repository path relative to the deepest such checkout, whichever output root also contains the file (spec
 * s4: repository UUID plus repo-relative path), and the job runs against that checkout so the worker derives the same
 * identity. Otherwise it is the root the path policy chose (deepest, ties by ID) with a root identity.
 */
function identityFor(canonical: string, authRoot: ArtifactRootRow, roots: ArtifactRootRow[], home: string):
  { root: ArtifactRootRow; identity: ArtifactDocumentIdentity } | { reason: string } {
  const checkout = roots.filter(r => r.kind === 'checkout' && r.repositoryId !== null && scannable(r) && strictlyWithin(canonical, r.canonicalPath)).sort(deepestFirst)[0]
  if (checkout && authorizeArtifactPath(canonical, [workerRoot(checkout)], home).allowed) {
    const id = documentIdentityForPath(canonical, workerRoot(checkout), { repositoryId: checkout.repositoryId!, gitPath: canonical.slice(checkout.canonicalPath.length + 1) })
    return 'incomplete' in id ? { reason: `identity-${id.reason}` } : { root: checkout, identity: id }
  }
  const id = documentIdentityForPath(canonical, workerRoot(authRoot), null)
  return 'incomplete' in id ? { reason: `identity-${id.reason}` } : { root: authRoot, identity: id }
}

// ---------------------------------------------------------------------------------------------------------------- direct observations

/**
 * Records one exact-path observation as event-only evidence and schedules one `direct-observation` job for exactly that path
 * (scope `direct:<rootId>:<path>`), never a traversal. A replay of a known source key changes nothing.
 *
 * The path is authorized against the active registered roots. A path outside every root has its immediate parent canonicalized
 * and registered as a `session-directory` root with scope `['direct-only']` (which authorizes only files directly inside it and
 * is never bulk-scanned); a parent that is home, above home, a secret/runtime directory or otherwise refused is a counted
 * rejection and registers nothing, and so is ~/.claude itself (`parent-claude-config`). Known limitation: a file directly in home
 * cannot be observed this way, since home is never a root; registered-root discovery is its only path in.
 *
 * Policy outcomes (refusal, duplicate) are counted results whose writes roll back on their own. An unexpected store failure
 * rolls back and propagates (ArtifactObservationStoreError) so the event is not acknowledged.
 */
export function recordDirectArtifactObservation(db: AtlasDb, input: DirectArtifactObservationInput, opts: ArtifactObservationOptions & { now: string }): ArtifactObservationOutcome {
  const home = opts.home ?? homedir()
  return isolated(db, () => {
    if (evidenceExists(db, input.sourceKey)) return outcome({ status: 'duplicate' })
    // An event time the store would refuse (control characters, oversized) is a malformed claim: drop it, never retry it.
    if (typeof input.eventAt !== 'string' || input.eventAt.length > 64 || /[\u0000-\u001f\u007f]/.test(input.eventAt)) return reject('event-time-invalid')
    let roots = activeRoots(db)
    let auth = authorizeArtifactPath(input.path, roots.map(workerRoot), home)
    let rootRegistered = false
    if (!auth.allowed && (auth.reason === 'outside-roots' || auth.reason === 'symlink-escape')) {
      // Not covered by any root: authorize exactly this file through a direct-only root on its immediate parent.
      const parent = canonicalizeArtifactRoot(dirname(input.path), home)
      if ('error' in parent) return reject(`parent-${parent.error}`)
      if (!parent.exists) return reject('parent-missing')
      // ~/.claude holds Claude Code's configuration and runtime data (settings, credentials, the cost ledger). The path policy refuses
      // the sensitive files in it; this keeps the folder itself from becoming a root through an observation of any other file (I2).
      const claudeConfig = canonicalizeArtifactRoot(join(home, '.claude'), home)
      if ('canonicalPath' in claudeConfig && parent.canonicalPath === claudeConfig.canonicalPath) return reject('parent-claude-config')
      // Re-registering would re-activate a deactivated root with its old (possibly bulk-scan) flags; that is not ours to do.
      if (listArtifactRoots(db).some(r => !r.active && r.canonicalPath === parent.canonicalPath)) return reject('parent-root-inactive')
      registerArtifactRoot(db, { kind: 'session-directory', canonicalPath: parent.canonicalPath, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, opts.now)
      rootRegistered = true
      roots = activeRoots(db)
      auth = authorizeArtifactPath(input.path, roots.map(workerRoot), home)
    }
    if (!auth.allowed || auth.canonicalPath === null || auth.rootId === null) {
      // Roll back a registration that did not end up authorizing the path.
      if (rootRegistered) throw new PolicyStop(reject(auth.reason ?? 'denied'))
      return reject(auth.reason ?? 'denied')
    }
    const canonical = auth.canonicalPath
    const authRoot = roots.find(r => r.rootId === auth.rootId)
    if (!authRoot) return reject('root-unknown')
    const chosen = identityFor(canonical, authRoot, roots, home)
    if ('reason' in chosen) {
      if (rootRegistered) throw new PolicyStop(reject(chosen.reason))
      return reject(chosen.reason)
    }
    const locator = input.toolUseId !== undefined ? `tool_use:${sourceId(input.toolUseId)}` : input.locator
    if (input.toolUseId !== undefined && toolUseAlreadyRecorded(db, canonical, locator!)) {
      const dup = outcome({ status: 'duplicate', crossSession: true })
      if (rootRegistered) throw new PolicyStop(dup)
      return dup
    }
    const res = recordArtifactEvidence(db, {
      rootId: chosen.root.rootId, path: canonical, identity: chosen.identity, sourceKey: input.sourceKey, source: input.source, sessionId: input.sessionId,
      operation: input.operation, certainty: input.certainty, eventAt: input.eventAt, locator,
    }, opts.now)
    if (res.duplicate) return outcome({ status: 'duplicate' })
    enqueueArtifactJob(db, { scopeId: artifactDirectScopeId(chosen.root.rootId, canonical), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 0 }, opts.now)
    return outcome({ status: 'recorded', source: input.source, documentId: res.documentId, rootRegistered })
  }, opts.log)
}

/**
 * Hook or transcript evidence carrying this tool-use locator already exists for the file at `canonical`, under any session.
 * A tool call writes one file, so scoping the lookup to the file's location loses nothing, and it runs on indexes
 * (artifacts.path, then artifact_evidence.artifact_id) rather than scanning all evidence for a locator.
 */
function toolUseAlreadyRecorded(db: AtlasDb, canonical: string, locator: string): boolean {
  return db.raw.prepare(`SELECT 1 AS hit FROM artifacts a JOIN artifact_evidence e ON e.artifact_id = a.artifact_id
    WHERE a.path = ? AND e.source_locator = ? AND e.source IN ('hook', 'transcript') LIMIT 1`).get(canonical, locator) !== undefined
}

// ---------------------------------------------------------------------------------------------------------------- scope hints

/**
 * Marks a verified cwd's registered scope dirty: the deepest scannable root at or above the cwd, plus scannable roots inside
 * it (at most 16 in all). Each gets a `checkout-status` (checkout root) or `output-walk` job at `priority`, coalesced by the
 * persistence layer. Never records a document, never registers a root, never traverses here. A cwd that is home, outside
 * home, secret/runtime or missing is a counted rejection; a cwd with no registered root is `no-scope-root` (the scheduler's
 * session-root reconciliation is then the backstop).
 */
export function markArtifactScopeDirty(db: AtlasDb, cwd: string, priority: number, opts: ArtifactObservationOptions & { now: string }): ArtifactObservationOutcome {
  const home = opts.home ?? homedir()
  return isolated(db, () => {
    const c = canonicalizeArtifactRoot(cwd, home)
    if ('error' in c) return reject(`cwd-${c.error}`)
    if (!c.exists) return reject('cwd-missing')
    const roots = activeRoots(db).filter(scannable)
    const owner = roots.filter(r => atOrWithin(c.canonicalPath, r.canonicalPath)).sort(deepestFirst)[0]
    const inner = roots.filter(r => strictlyWithin(r.canonicalPath, c.canonicalPath)).sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : 1))
    const targets = [...(owner ? [owner] : []), ...inner.filter(r => r !== owner)].slice(0, MAX_SCOPE_ROOTS)
    if (targets.length === 0) return outcome({ status: 'no-scope-root' })
    for (const r of targets) {
      enqueueArtifactJob(db, { scopeId: r.rootId, taskKind: r.kind === 'checkout' ? 'checkout-status' : 'output-walk', priority, generation: 0 }, opts.now)
    }
    return outcome({ status: 'scope-enqueued', roots: targets.length })
  }, opts.log)
}

// ---------------------------------------------------------------------------------------------------------------- events

/**
 * The ingestor's single entry point for artifact metadata on one event (called inside applyEvent's transaction):
 * - tool_completed with a valid artifact_observation: a scope hint (scopeOnly; its path must equal the event cwd) or a hook
 *   observation, recorded `recorded` with the operation the hook classified. Source key: tool-use when sourceEventId is the
 *   event's tool_use_id, else hook-event.
 * - tool_completed with created_path and no artifact_observation at all (a pre-Task-6 hook or spool file): a legacy
 *   creation claim, source `legacy`, certainty `unknown` (the old channel guessed creation from a Write without "updated").
 * - turn_completed / session_end: a final recovery for the session's scope (event cwd, else its last known cwd).
 * - a rejected or misplaced observation: counted, nothing applied.
 * Returns null when the event carries no artifact metadata.
 */
export function ingestArtifactEvent(db: AtlasDb, event: AtlasEvent, opts: ArtifactObservationOptions & { now: string }): ArtifactObservationOutcome | null {
  const obs = event.artifact_observation
  if (event.event === 'turn_completed' || event.event === 'session_end') {
    // A bad or misplaced observation is counted; it never suppresses the final recovery.
    if (event.artifact_observation_rejected) bump(`rejected:${event.artifact_observation_rejected}`)
    else if (obs) bump('rejected:observation-unexpected-event')
    const session = getSession(db, event.session_id)
    const cwd = event.cwd ?? session?.resumeCwd ?? session?.startCwd ?? null
    if (cwd === null) return outcome({ status: 'no-scope-root' })
    return markArtifactScopeDirty(db, cwd, ARTIFACT_JOB_PRIORITY.recovery, opts)
  }
  if (event.artifact_observation_rejected) return reject(event.artifact_observation_rejected)
  if (event.event !== 'tool_completed') return obs ? reject('observation-unexpected-event') : null
  if (obs) {
    if (obs.scopeOnly) {
      if (event.cwd === undefined || obs.path !== event.cwd) return reject('scope-cwd-mismatch')
      return markArtifactScopeDirty(db, obs.path, ARTIFACT_JOB_PRIORITY.dirty, opts)
    }
    const fromToolUse = event.tool_use_id !== undefined && obs.sourceEventId === event.tool_use_id
    const sourceKey = fromToolUse ? artifactToolUseSourceKey(event.session_id, obs.sourceEventId) : artifactHookEventSourceKey(event.session_id, obs.sourceEventId)
    return recordDirectArtifactObservation(db, {
      sessionId: event.session_id, path: obs.path, operation: obs.operation, certainty: 'recorded', source: 'hook', sourceKey, eventAt: event.ts,
      ...(fromToolUse ? { toolUseId: obs.sourceEventId } : { locator: `hook_event:${sourceId(obs.sourceEventId)}` }),
    }, opts)
  }
  if (event.created_path) {
    const id = event.tool_use_id ?? event.fingerprint
    return recordDirectArtifactObservation(db, {
      sessionId: event.session_id, path: event.created_path, operation: 'created', certainty: 'unknown', source: 'legacy',
      sourceKey: artifactLegacySourceKey(event.session_id, id), eventAt: event.ts, locator: `legacy:${sourceId(id)}`,
    }, opts)
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------- transcripts

/**
 * A transcript record stamped before the processed session started cannot be that session's own action (a re-stamped
 * fork/resume copy keeps its original time). A record without a readable time is not judged here.
 */
export function transcriptRecordPredatesSession(ts: string | null | undefined, sessionStartedAt: string): boolean {
  const at = Date.parse(ts ?? '')
  const start = Date.parse(sessionStartedAt)
  return Number.isFinite(at) && Number.isFinite(start) && at < start
}

/** The tool_use a result answers, when it was in the same delta: its name and the path its input named. */
export type TranscriptToolUse = { name: string; path: string | null }

/**
 * Classifies a transcript tool result exactly as the hook classifies the same call (hooks/atlas-hook.js fileOperation):
 * Write -> created (explicit create) / modified (explicit update) / touched; Edit, MultiEdit, NotebookEdit -> modified;
 * anything else, or any failed result, -> null. When the tool_use was in an earlier delta the result's own shape identifies
 * Write (create/update type) or Edit (old/new strings); otherwise the result is not classified. The path is the tool input's
 * path, else the structured result's filePath; it is never parsed out of result text.
 */
export function classifyTranscriptToolResult(toolUse: TranscriptToolUse | undefined, result: ToolResultRecord): { path: string; operation: ArtifactOperation } | null {
  // Success must be confirmed: a record without the isError fact is not evidence of a completed write.
  if (result.isError !== false) return null
  const writeType = result.writeType ?? null
  const name = toolUse?.name ?? (writeType !== null ? 'Write' : result.edited === true ? 'Edit' : null)
  let operation: ArtifactOperation
  if (name === 'Write') operation = writeType === 'create' ? 'created' : writeType === 'update' ? 'modified' : 'touched'
  else if (name !== null && EDIT_TOOLS.has(name)) operation = 'modified'
  else return null
  const path = toolUse?.path ?? result.filePath ?? null
  if (!path || !path.startsWith('/') || path.length > 4096 || path.includes('\0')) return null
  return { path, operation }
}

/**
 * Records a confirmed transcript tool result for `sessionId` (the transcript being processed) under the tool-use source key,
 * converging with the hook's observation of the same call. Skipped, counted, with no evidence, document, root or job:
 * - `transcript-foreign-record`: the record's own session differs from `sessionId` (copied from another transcript);
 * - `transcript-stale` (R31): its timestamp is missing, older than TRANSCRIPT_LIVE_WINDOW_MS before `now` (the injected
 *   processing clock), more than a minute ahead of it, or earlier than the processed session's `sessionStartedAt` (R32: a
 *   re-stamped fork/resume copy keeps its original time);
 * - a duplicate when the tool-use ID is already recorded for the file under any session (R32).
 * Returns null when the result is not a file observation.
 */
export function recordTranscriptToolResult(db: AtlasDb, sessionId: string, result: ToolResultRecord, toolUse: TranscriptToolUse | undefined,
  opts: ArtifactObservationOptions & { now: string; sessionStartedAt: string }): ArtifactObservationOutcome | null {
  const classified = classifyTranscriptToolResult(toolUse, result)
  if (!classified) return null
  // The same rule the hook applies before using a tool-use ID as its source ID, so both sides key the call identically.
  if (result.toolUseId === null || !SOURCE_EVENT_ID_RE.test(result.toolUseId)) return reject('transcript-no-tool-use-id')
  if (result.transcriptSessionId != null && result.transcriptSessionId !== sessionId) return reject('transcript-foreign-record')
  const at = Date.parse(result.ts ?? '')
  const now = Date.parse(opts.now)
  if (!Number.isFinite(at) || !Number.isFinite(now) || at < now - TRANSCRIPT_LIVE_WINDOW_MS || at > now + FUTURE_SKEW_MS) return reject('transcript-stale')
  if (!(at >= Date.parse(opts.sessionStartedAt))) return reject('transcript-stale')
  return recordDirectArtifactObservation(db, {
    sessionId, path: classified.path, operation: classified.operation, certainty: 'recorded', source: 'transcript',
    sourceKey: artifactToolUseSourceKey(sessionId, result.toolUseId), eventAt: result.ts!, toolUseId: result.toolUseId,
  }, opts)
}

// ---------------------------------------------------------------------------------------------------------------- inference (R29)

/**
 * One working-version transition committed by a scan pass, as Task 7's scheduler reports it to inferSessionActivity.
 * - documentId, rootId: the document and the scanned root whose pass committed the version.
 * - newVersionId: the working version the pass just committed (must still be its location's current version).
 * - previousVersionId: that location's version before this one, or null for a location with no earlier version (a new file).
 * - baseline: the root's state when this pass STARTED (read when the job was claimed): its applied generation and the time
 *   its last complete-coverage pass finished (ArtifactRootRow.appliedGeneration / lastSuccessfulAt). Reading it after the
 *   commit would let the first pass vouch for itself.
 * - observedAt: when the pass observed the new version.
 */
export type ArtifactSessionInferenceInput = {
  documentId: string
  rootId: string
  newVersionId: string
  previousVersionId: string | null
  baseline: { appliedGeneration: number; completedAt: string | null }
  observedAt: string
}

/**
 * - linked: evidence exists for every overlapping session (`recorded` counts rows new in this call; 0 on a replay).
 * - no-session: no active session overlapped the change; nothing recorded, origin stays unknown.
 * - skipped: inference does not apply (`reason` is a stable token): baseline-incomplete, version-mismatch, git-clean,
 *   location-mismatch, outside-root, superseded, unverified, previous-mismatch, already-evidenced, change-time-unknown,
 *   change-before-baseline, change-before-previous, change-in-future.
 */
export type ArtifactSessionInferenceResult = {
  status: 'linked' | 'no-session' | 'skipped'
  reason: string | null
  operation: 'created' | 'modified' | null
  sessionIds: string[]
  recorded: number
}

type VersionRow = { version_id: string; document_id: string; kind: string; location_artifact_id: number | null; observation_revision: number | null; stat_signature: string | null; blob_oid: string | null; observed_at: string }
type LocationRow = { path: string; root_id: string | null; document_id: string | null; current_version_id: string | null; exists_state: string; verification_state: string | null }
type DocumentRow = { identity_kind: 'repository' | 'root'; repository_id: string | null; identity_root_id: string | null; relative_path: string }
type SessionCandidate = { session_id: string; start_cwd: string | null; resume_cwd: string | null; started_at: string; last_activity_at: string }

/**
 * Links sessions to one committed working-version transition, for Task 7 to call after committing a scan batch (spec s5,
 * ruling R29). Applies only when the root's baseline was complete when the pass started (applied generation > 0 and a
 * complete-coverage pass time) and the file's change time (max of the new stat's mtime and ctime) falls after that baseline
 * and after the previous version's observation, so first-pass discoveries, pre-existing dirty files and files first seen
 * late are never inferred. Clean Git-tracked versions (blob known) are checkout noise and are skipped.
 *
 * Every session, active or since closed (a session that ended after the change is exactly the one the session-end recovery
 * scan is for), whose start or resume cwd is inside the root or contains it (separator-aware, as stored), and whose activity
 * overlaps [change - ARTIFACT_INFERENCE_INTERVAL_MS, change + ARTIFACT_INFERENCE_INTERVAL_MS] is linked. Activity runs from
 * started_at to last_activity_at, which every event (SessionEnd included) advances. ended_at is not used: an idle-closed
 * session gets ended_at at the prune time, hours after its last activity, which would stretch it over other sessions' work.
 * `unknown` (backfilled, never observed live) sessions are not linked. Each link has source `reconcile`, certainty `inferred` and operation `modified` (`created` when the location had no previous version).
 * Zero sessions records nothing; several are all linked and none is selected. Idempotent: the key is
 * infer:<versionId>:<sessionId>. A deterministic reason not to infer is a `skipped` result. An unexpected store failure
 * rolls back this call's writes and propagates (ArtifactObservationStoreError): Task 7 must not commit the batch as if the
 * inference had run (retry it with the batch).
 */
export function inferSessionActivity(db: AtlasDb, input: ArtifactSessionInferenceInput, now: string): ArtifactSessionInferenceResult {
  const skip = (reason: string): ArtifactSessionInferenceResult => {
    bump(`inference-skipped:${reason}`)
    return { status: 'skipped', reason, operation: null, sessionIds: [], recorded: 0 }
  }
  return isolated(db, () => {
    const baselineMs = input.baseline?.completedAt ? Date.parse(input.baseline.completedAt) : NaN
    if (!input.baseline || !(input.baseline.appliedGeneration > 0) || !Number.isFinite(baselineMs)) return skip('baseline-incomplete')
    const root = activeRoots(db).find(r => r.rootId === input.rootId)
    if (!root || !(root.appliedGeneration > 0)) return skip('baseline-incomplete')

    const version = db.raw.prepare(`SELECT version_id, document_id, kind, location_artifact_id, observation_revision, stat_signature, blob_oid, observed_at
      FROM artifact_versions WHERE version_id = ?`).get(input.newVersionId) as VersionRow | undefined
    if (!version || version.kind !== 'working' || version.document_id !== input.documentId || version.location_artifact_id === null) return skip('version-mismatch')
    if (version.blob_oid !== null) return skip('git-clean')
    const loc = db.raw.prepare('SELECT path, root_id, document_id, current_version_id, exists_state, verification_state FROM artifacts WHERE artifact_id = ?')
      .get(version.location_artifact_id) as LocationRow | undefined
    if (!loc || loc.document_id !== input.documentId) return skip('location-mismatch')
    if (!strictlyWithin(loc.path, root.canonicalPath)) return skip('outside-root')
    if (loc.current_version_id !== version.version_id) return skip('superseded')
    if (loc.exists_state !== 'present' || loc.verification_state !== 'verified') return skip('unverified')

    const previous = db.raw.prepare(`SELECT version_id, observed_at FROM artifact_versions WHERE kind = 'working' AND location_artifact_id = ? AND observation_revision < ?
      ORDER BY observation_revision DESC LIMIT 1`).get(version.location_artifact_id, version.observation_revision ?? 0) as { version_id: string; observed_at: string } | undefined
    if ((previous?.version_id ?? null) !== input.previousVersionId) return skip('previous-mismatch')
    // A change already explained by direct evidence (hook, transcript, Git) needs no inference. Evidence is bound to a version only
    // when a stat can be shown to describe it (PR #19 review, P2-4), so an event of this location that was reported since the
    // previous version and before this one was captured, and is not bound to a version yet, explains this change as well: with
    // no previous version, any such event does. Legacy evidence (an old origin, not an event about contents) never binds to a
    // version (attachPendingEvidence), so an unbound one explains nothing either.
    if (db.raw.prepare(`SELECT 1 AS hit FROM artifact_evidence WHERE source <> 'reconcile' AND (version_id = ?
      OR (version_id IS NULL AND source <> 'legacy' AND artifact_id = ? AND observed_at > ? AND observed_at <= ?)) LIMIT 1`).get(version.version_id, version.location_artifact_id, previous?.observed_at ?? '', version.observed_at)) return skip('already-evidenced')

    let stat: unknown
    try { stat = JSON.parse(version.stat_signature ?? '') } catch { stat = null }
    if (!Array.isArray(stat) || stat.length !== 5 || typeof stat[0] !== 'string' || typeof stat[1] !== 'string') return skip('change-time-unknown')
    const [dev, ino, size, mtimeMs, ctimeMs] = stat as [string, string, number, number, number]
    const changeMs = Math.max(mtimeMs, ctimeMs)
    if (!Number.isFinite(changeMs) || changeMs <= 0) return skip('change-time-unknown')
    if (changeMs <= baselineMs) return skip('change-before-baseline')
    if (previous && changeMs <= Date.parse(previous.observed_at)) return skip('change-before-previous')
    const observedMs = Date.parse(input.observedAt)
    if (!Number.isFinite(observedMs) || changeMs > observedMs + FUTURE_SKEW_MS) return skip('change-in-future')

    const operation: 'created' | 'modified' = previous ? 'modified' : 'created'
    const related = (cwd: string | null) => cwd !== null && (atOrWithin(cwd, root.canonicalPath) || strictlyWithin(root.canonicalPath, cwd))
    const sessions = (db.raw.prepare(`SELECT session_id, start_cwd, resume_cwd, started_at, last_activity_at FROM sessions WHERE status IN ('active', 'closed')`).all() as SessionCandidate[])
      .filter(s => related(s.start_cwd) || related(s.resume_cwd))
      .filter(s => Date.parse(s.started_at) <= changeMs + ARTIFACT_INFERENCE_INTERVAL_MS && Date.parse(s.last_activity_at) >= changeMs - ARTIFACT_INFERENCE_INTERVAL_MS)
      .map(s => s.session_id)
      .sort()
    if (sessions.length === 0) {
      bump('inference:no-session')
      return { status: 'no-session', reason: null, operation, sessionIds: [], recorded: 0 }
    }

    const doc = db.raw.prepare('SELECT identity_kind, repository_id, identity_root_id, relative_path FROM artifact_documents WHERE document_id = ?').get(input.documentId) as DocumentRow | undefined
    if (!doc) return skip('version-mismatch')
    const identity: ArtifactDocumentIdentity = { identityKind: doc.identity_kind, repositoryId: doc.repository_id, rootId: doc.identity_root_id, relativePath: doc.relative_path }
    const eventAt = new Date(changeMs).toISOString()
    let recorded = 0
    for (const sessionId of sessions) {
      const eventKey = artifactInferenceSourceKey(version.version_id, sessionId)
      const fresh = !evidenceExists(db, eventKey)
      // Re-applying the version's own stat is an unchanged observation: it creates no version and links the evidence to
      // exactly this version.
      const obs: ArtifactWorkerObservation = {
        rootId: loc.root_id ?? root.rootId, identity, kind: 'working', observedAt: version.observed_at, path: loc.path,
        stat: { dev, ino, size, mtimeMs, ctimeMs },
        evidence: { source: 'reconcile', eventKey, sessionId, operation, certainty: 'inferred', eventAt, locator: `version:${version.version_id}` },
      }
      const res = recordArtifactObservation(db, obs, now)
      if (res.versionId !== version.version_id) throw new Error('inference re-observation changed the version')
      if (fresh) recorded += 1
    }
    bump('inference:linked')
    return { status: 'linked', reason: null, operation, sessionIds: sessions, recorded }
  })
}
