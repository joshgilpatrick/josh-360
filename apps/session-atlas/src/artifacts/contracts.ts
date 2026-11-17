// Frozen cross-task contracts for the Artifact Manager (plan 2026-10-26, "Frozen cross-task contracts").
//
// Types, plus one default (ARTIFACT_DEFAULT_FRAME_ROWS). The persistence layer (src/db/artifact-manager.ts), path policy, Git
// adapter, discovery worker, service and APIs all import these names as written, so a change here is a change to every one of them. The artifact worker never
// receives a database handle: it speaks only the request, observation and frame types below. Nothing in this file may carry
// document contents, command bodies or hook payloads -- identities, paths, OIDs, signatures and counts only.

export type ArtifactRootKind = 'checkout' | 'output' | 'session-directory'

export type ArtifactTaskKind = 'direct-observation' | 'checkout-status' | 'output-walk' | 'git-history' | 'verify' | 'legacy-backfill'

export type ArtifactEvidenceSource = 'hook' | 'transcript' | 'git' | 'watcher' | 'reconcile' | 'legacy'

export type ArtifactOperation = 'created' | 'modified' | 'touched'

export type ArtifactCertainty = 'recorded' | 'inferred' | 'unknown'

export type ArtifactVersionKind = 'working' | 'commit' | 'index'

// Exactly one of repositoryId/rootId is non-null (repository identity vs. root identity). relativePath is the Git path,
// represented losslessly for valid UTF-8 names, or the filesystem-relative path with '/' separators for a non-Git root.
export type ArtifactDocumentIdentity = { identityKind: 'repository' | 'root'; repositoryId: string | null; rootId: string | null; relativePath: string }

export type ArtifactRootCoverageState = 'idle' | 'queued' | 'scanning' | 'partial' | 'failed' | 'inaccessible'

export type ArtifactWorkerRoot = {
  rootId: string
  kind: ArtifactRootKind
  canonicalPath: string
  repositoryId: string | null
  checkoutIdentity: string | null
  protected: boolean
  scopeFlags: Array<'checkout' | 'configured-output' | 'cli-output' | 'session-cwd' | 'direct-only'>
}

// Service to worker. A direct-observation request supplies its exact file path in `path`.
// `sinceMs` (ruling R24, optional, epoch milliseconds) is the import cutoff for bulk tasks: output-walk and checkout-status
// emit a file only when max(mtimeMs, ctimeMs) >= sinceMs (ctime catches writes that keep an old mtime), and a git-history
// pass that starts from a null cursor skips commits older than it. `includeOlder` removes the cutoff. Absent: now - 7 days.
export type ArtifactWorkerRequest = {
  jobId: string
  root: ArtifactWorkerRoot
  generation: number
  task: ArtifactTaskKind
  path?: string
  cursor: string | null
  includeOlder: boolean
  documentExtensions: string[]
  ignoreSegments: string[]
  // maxFrameRows (Wave 2b, additive, optional): the most rows the worker puts in one data frame, 1..250. Absent: the frozen
  // frame maximum of 250 rows. The 1 MiB bound per encoded frame applies either way.
  limits: { maxEntries: number; maxMs: number; gitTimeoutMs: number; gitMaxOutputBytes: number; maxFrameRows?: number }
  sinceMs?: number
}

// Rows per worker data frame the service asks for by default (config artifacts.maxRowsPerFrame). The service commits each
// frame in one transaction on its event loop, so a frame's size bounds how long that loop is blocked. Measured (Wave 2b,
// PERF-GAP-3) at about 0.6-0.9 ms per new row including the stored document state, plus ~15 ms for the COMMIT itself: 32 rows
// keep one commit near 35-45 ms, against 45-60 ms at 50 rows and 180-260 ms for a 250-row frame. Against 50 rows, 32 lowered
// the service's event-loop p99 in the dirty walk from 93 to 70 ms and in the cold walk from 68 to 48-53 ms, at 2-6% of
// throughput. The frozen frame maximum (250 rows, 1 MiB) stays the upper bound.
export const ARTIFACT_DEFAULT_FRAME_ROWS = 32

// Kind invariants:
// - working: requires an absolute `path` and `stat`; may carry Git identity.
// - index: requires checkout identity, Git path, blob, object format, mode, size and stage; no filesystem stat is required.
// - commit: requires repository ID, commit OID, Git path, blob, object format, mode and size; carries no absolute path or stat.
// Worker output carries the `identity` derived by the path policy (Task 3).
export type ArtifactWorkerObservation = {
  rootId: string
  identity: ArtifactDocumentIdentity
  kind: ArtifactVersionKind
  observedAt: string
  /**
   * Working rows only, optional and additive: a lower bound of the instant the worker's lstat saw the file (taken before the call
   * returned), so the stat in this row describes the file no earlier than this time. `observedAt` is when the row was built, which
   * can be much later (identity and Git lookups run between the lstat and the row), so it says nothing about WHEN the stat
   * happened. The service binds a session's tool event to a version only when this time shows the stat began after the event was
   * reported (PR #19 review, P2-4); a row without it, or with one later than its own observedAt or in the future, binds nothing.
   */
  capturedAt?: string
  path?: string
  stat?: { dev: string; ino: string; size: number; mtimeMs: number; ctimeMs: number }
  git?: {
    repositoryId: string
    checkoutIdentity?: string
    commitOid?: string
    gitPath?: string
    blobOid?: string
    objectFormat: 'sha1' | 'sha256'
    mode: number
    size: number
    stage?: number
  }
  evidence?: {
    source: ArtifactEvidenceSource
    eventKey: string
    sessionId: string | null
    operation: ArtifactOperation
    certainty: ArtifactCertainty
    eventAt: string
    locator?: string
  }
}

// Worker to service, NDJSON, one frame per line: at most 250 observations and 1 MiB encoded. `cursor` is opaque and at most
// 64 KiB. The worker waits for the service's ArtifactAckFrame for this jobId before it sends the next batch. `error` reports a
// failed batch or job by category: `code` is a short stable token, `message` is at most 512 characters and never includes file
// contents or paths.
export type ArtifactWorkerFrame = {
  type: 'batch'
  jobId: string
  rows: ArtifactWorkerObservation[]
  cursor: string | null
  complete: boolean
  coverage: 'complete' | 'partial' | 'inaccessible'
  counts: { visited: number; eligible: number; skipped: number }
  error?: { code: string; message: string }
}

// Service to worker acknowledgement that a batch is durably committed.
export type ArtifactAckFrame = { type: 'ack'; jobId: string }

// Status paths are redacted by default.
export type ArtifactRootStatus = {
  rootId: string
  state: ArtifactRootCoverageState
  generation: number
  cursor: string | null
  completedAt: string | null
  oldestQueuedAgeMs: number
  reason: string | null
}

export type ArtifactManagerStatus = { paused: boolean; roots: ArtifactRootStatus[]; pendingJobs: number; oldestQueueAgeMs: number }
