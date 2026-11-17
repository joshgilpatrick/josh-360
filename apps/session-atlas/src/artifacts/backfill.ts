// Resumable legacy backfill for the Artifact Manager (plan 2026-10-26 Task 7, spec s15). Runs in the service as the lowest-
// priority `legacy-backfill` job, never in the worker and never inside a migration transaction. It reads only the catalog:
// no filesystem walk, stat or Git call.
//
// For every pre-existing location (an `artifacts` row) in artifact_id order, at most 250 per batch (the service asks for
// artifacts.maxRowsPerFrame, 32 by default, per transaction: PERF-GAP-3):
//   - a location with no document gets a PROVISIONAL per-location document (identity_kind 'provisional', keyed by its
//     legacy_artifact_id), never a guessed repository/root group: its identity is unverified until a worker observation of
//     that exact path confirms one (adoptProvisionalLocations, called by the scheduler inside the commit of that batch);
//   - artifact ID, path, FTS row, origins and dates stay as they are: the document's first observation and activity are
//     the location's original created_at (labelled 'legacy'), never the backfill time;
//   - each artifact_origins row is preserved as one `legacy` evidence row with its original detection method in the locator
//     (`legacy:<detected_via>`), certainty `unknown` (never upgraded to recorded), and its original session. A location with
//     no origin gets no session; root metadata stays unknown (root_id is left NULL). Only origins that PREDATE the new
//     pipeline are legacy: the first run persists an upper bound (MAX(artifact_id) then, key legacy-backfill.origin-bound),
//     and an origin that is the compatibility projection of non-legacy evidence is skipped (same artifact, session, time, and
//     the relation and detection method the projection derives), because Task 2 projects a compatibility origin for every
//     hook/transcript/inference link and converting it back would invent evidence. A different event of the same artifact and
//     session (a later modification) does not make an older origin a duplicate, so that origin stays `legacy` evidence;
//   - linking raises the location's is_sensitive from the document's protection, which counts a sensitive filename, a `phi`
//     path segment and any protected registered root containing the path (ruling R20). Protection is only ever raised.
// Idempotent: provisional documents are unique by legacy_artifact_id, links only fill a NULL document_id and evidence keys are
// deterministic, so a crash between batches, a rerun from the start or an overlapping run changes nothing twice.
//
// RULING NOTE (cross-task finding, reported): the persistence boundary (src/db/artifact-manager.ts) exports no operation that
// creates provisional documents or records legacy evidence, so this module issues those few SQL statements itself. They touch
// only rows the backfill owns (provisional documents, legacy evidence) plus the two link columns of artifacts (document_id when
// NULL, raise-only is_sensitive and COALESCEd root_id). Merging a provisional document into an existing one goes through the
// boundary's mergeArtifactDocuments, shared with the root-to-repository identity adoption (adoptArtifactRepositoryIdentity).

import { randomUUID } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'
import type { AtlasDb } from '../db/database.ts'
import { listLegacyArtifactBackfill, mergeArtifactDocuments } from '../db/artifact-manager.ts'
import type { ArtifactDocumentIdentity } from './contracts.ts'
import { classifyPath } from './filetype.ts'
import { hasPhiSegment } from './path-policy.ts'

/** A backfill batch never processes more rows than this. */
export const LEGACY_BACKFILL_MAX_BATCH = 250

export type LegacyBackfillResult = {
  /** The last artifact_id processed (the checkpoint to resume after); unchanged when the batch was empty. */
  cursor: string
  /** No rows remain after `cursor` (the batch was short). */
  done: boolean
  scanned: number
  /** Locations newly linked to a provisional document. */
  linked: number
  /** Legacy evidence rows newly recorded. */
  evidence: number
}

type Row = { artifact_id: number; document_id: string | null; is_sensitive: number }
type Origin = { session_id: string; relation: string; detected_via: string; observed_at: string }

const CONTROL_RE = /[\u0000-\u001f\u007f]/

type Prepare = (sql: string) => StatementSync

/**
 * Prepares each SQL text once per batch call (PERF-GAP-3: preparing the same statements again for every row was about 40% of a
 * batch's cost on the service loop). The statements live only as long as the call.
 */
function statementsFor(db: AtlasDb): Prepare {
  const cache = new Map<string, StatementSync>()
  return sql => {
    let statement = cache.get(sql)
    if (!statement) {
      statement = db.raw.prepare(sql)
      cache.set(sql, statement)
    }
    return statement
  }
}

/** The two spellings of a symlinked home: legacy rows may carry the literal prefix, roots store the real one. */
export type HomeSpellings = { literal: string; real: string }

const UNDER_PROTECTED_ROOT_SQL = `SELECT 1 AS hit FROM artifact_roots WHERE protected = 1 AND (canonical_path = ? OR substr(?, 1, length(canonical_path) + 1) = canonical_path || '/') LIMIT 1`

function underProtectedRoot(q: Prepare, path: string, home?: HomeSpellings): boolean {
  const under = (candidate: string) => q(UNDER_PROTECTED_ROOT_SQL).get(candidate, candidate) !== undefined
  if (under(path)) return true
  if (home && (path === home.literal || path.startsWith(home.literal + '/'))) return under(home.real + path.slice(home.literal.length))
  return false
}

function protectedPath(q: Prepare, path: string, home?: HomeSpellings): boolean {
  return classifyPath(path).sensitive || hasPhiSegment(path) || underProtectedRoot(q, path, home)
}

function parseCursor(cursor: string | null): number {
  if (cursor === null || !/^\d{1,15}$/.test(cursor)) return 0
  return Number(cursor)
}

/** artifact_manager_state key: origins of artifacts above this ID were written after the upgrade and are never legacy. */
export const LEGACY_ORIGIN_BOUND_KEY = 'legacy-backfill.origin-bound'

/** The legacy evidence key of one origin: origins are unique per (artifact, session). */
export function legacyOriginSourceKey(artifactId: number, sessionId: string): string {
  return `legacy-origin:${artifactId}:${sessionId}`
}

/** One resumable batch of the legacy backfill, in one transaction (the caller may nest it in its own). */
export function backfillLegacyArtifacts(db: AtlasDb, cursor: string | null, limit: number, now: string, home?: HomeSpellings): LegacyBackfillResult {
  const after = parseCursor(cursor)
  const n = Math.min(LEGACY_BACKFILL_MAX_BATCH, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : LEGACY_BACKFILL_MAX_BATCH))
  return db.transaction(() => {
    const q = statementsFor(db)
    let bound = Number((q('SELECT value FROM artifact_manager_state WHERE key = ?').get(LEGACY_ORIGIN_BOUND_KEY) as { value: string } | undefined)?.value ?? Number.NaN)
    if (!Number.isSafeInteger(bound)) {
      bound = (q('SELECT MAX(artifact_id) AS m FROM artifacts').get() as { m: number | null }).m ?? 0
      q(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(LEGACY_ORIGIN_BOUND_KEY, String(bound), now)
    }
    // An origin is the compatibility projection of new evidence only when that evidence has the origin's own identity: the same
    // artifact, session and time, and the relation and detection method projectOrigin derives from it. A later event of the same
    // session (a modification after an older creation) did not make this row, so it is not its duplicate.
    const projectedFrom = q(`SELECT 1 AS hit FROM artifact_evidence WHERE artifact_id = ? AND session_id = ? AND source <> 'legacy' AND observed_at = ?
      AND CASE source WHEN 'hook' THEN 'tool_event' WHEN 'transcript' THEN 'tool_event' WHEN 'watcher' THEN 'watcher' ELSE 'reconcile' END = ?
      AND CASE WHEN certainty = 'recorded' AND operation = 'created' THEN 'creator' ELSE 'reference' END = ? LIMIT 1`)
    const page = listLegacyArtifactBackfill(db, after, n)
    let linked = 0
    let evidence = 0
    const state = q('SELECT artifact_id, document_id, is_sensitive FROM artifacts WHERE artifact_id = ?')
    const origins = q('SELECT session_id, relation, detected_via, observed_at FROM artifact_origins WHERE artifact_id = ? ORDER BY session_id')
    for (const a of page) {
      const row = state.get(a.artifactId) as Row | undefined
      if (!row) continue
      let documentId = row.document_id
      if (documentId === null) {
        const isProtected = row.is_sensitive === 1 || protectedPath(q, a.path, home)
        const c = classifyPath(a.filename)
        q(`INSERT INTO artifact_documents (document_id, identity_kind, repository_id, identity_root_id, relative_path, legacy_artifact_id, display_name, extension,
            project_name, protected, first_created_at, last_change_at, last_change_source, first_observed_at)
          VALUES (?, 'provisional', NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, 'legacy', ?) ON CONFLICT(legacy_artifact_id) DO NOTHING`)
          .run(randomUUID(), a.artifactId, a.filename, c.extension, a.projectName, isProtected ? 1 : 0, a.createdAt, a.createdAt)
        const doc = q('SELECT document_id, protected FROM artifact_documents WHERE legacy_artifact_id = ?').get(a.artifactId) as { document_id: string; protected: number }
        const res = q('UPDATE artifacts SET document_id = ?, is_sensitive = MAX(is_sensitive, ?) WHERE artifact_id = ? AND document_id IS NULL')
          .run(doc.document_id, doc.protected, a.artifactId)
        if (Number(res.changes) > 0) linked++
        documentId = (state.get(a.artifactId) as Row).document_id!
      } else if (row.is_sensitive === 0 && protectedPath(q, a.path, home)) {
        // A re-run applies the current policy to a location that already has a document (ruling R91): raise-only.
        q('UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ? AND is_sensitive = 0').run(a.artifactId)
        q('UPDATE artifact_documents SET protected = 1 WHERE document_id = ? AND protected = 0').run(documentId)
      }
      // A location written after the upgrade has no legacy origins (its origins are projections of new evidence).
      if (a.artifactId > bound) continue
      for (const o of origins.all(a.artifactId) as Origin[]) {
        if (CONTROL_RE.test(o.session_id)) continue
        if (projectedFrom.get(a.artifactId, o.session_id, o.observed_at, o.detected_via, o.relation)) continue
        const res = q(`INSERT OR IGNORE INTO artifact_evidence (evidence_id, source_key, document_id, version_id, artifact_id, session_id, source, operation, certainty,
            event_at, observed_at, source_locator) VALUES (?, ?, ?, NULL, ?, ?, 'legacy', ?, 'unknown', ?, ?, ?)`)
          .run(randomUUID(), legacyOriginSourceKey(a.artifactId, o.session_id), documentId, a.artifactId, o.session_id, o.relation === 'creator' ? 'created' : 'touched',
            o.observed_at, o.observed_at, `legacy:${o.detected_via}`)
        if (Number(res.changes) > 0) evidence++
      }
    }
    const last = page.length > 0 ? page[page.length - 1]!.artifactId : after
    return { cursor: String(last), done: page.length < n, scanned: page.length, linked, evidence }
  })
}

type Located = { artifact_id: number; document_id: string | null; identity_kind: string | null }

function validIdentity(identity: ArtifactDocumentIdentity): boolean {
  const rel = identity?.relativePath
  const relOk = typeof rel === 'string' && rel.length > 0 && rel.length <= 4096 && !rel.startsWith('/') && !rel.includes('\0') && !rel.split('/').some(s => s === '' || s === '.' || s === '..')
  if (!relOk) return false
  if (identity.identityKind === 'repository') return typeof identity.repositoryId === 'string' && identity.repositoryId.length > 0 && identity.rootId === null
  if (identity.identityKind === 'root') return typeof identity.rootId === 'string' && identity.rootId.length > 0 && identity.repositoryId === null
  return false
}

/**
 * Resolves provisional (legacy) documents whose location a worker observation just verified (spec s15: "merge document
 * groups only after verified same-repository/same-relative-path resolution"). Each entry is a working observation the
 * service already validated: its root, its re-authorized path and its identity recomputed by the path policy. For each
 * location still linked to a provisional document:
 *   - when a document with that identity already exists, the provisional one is merged into it (mergeArtifactDocuments): its
 *     locations, versions and evidence move, its ID is kept as an alias (old links resolve), protection and the earliest dates carry over;
 *   - otherwise the provisional document takes the identity in place and keeps its ID.
 * The location gets its root (when it had none) and raise-only protection. No byte equality is claimed. Returns how many
 * provisional documents were resolved; anything else (already resolved, unknown path) is left alone, so it is idempotent.
 */
export function adoptProvisionalLocations(db: AtlasDb, entries: Array<{ path: string; rootId: string; identity: ArtifactDocumentIdentity; aliases?: readonly string[] }>, now: string): number {
  if (entries.length === 0) return 0
  return db.transaction(() => {
    const q = statementsFor(db)
    let resolved = 0
    for (const e of entries) {
      if (!validIdentity(e.identity)) continue
      const id = e.identity
      const targetOf = () => (id.identityKind === 'repository'
        ? q(`SELECT document_id FROM artifact_documents WHERE identity_kind = 'repository' AND repository_id = ? AND relative_path = ?`).get(id.repositoryId, id.relativePath)
        : q(`SELECT document_id FROM artifact_documents WHERE identity_kind = 'root' AND identity_root_id = ? AND relative_path = ?`).get(id.rootId, id.relativePath)) as { document_id: string } | undefined
      // The observed (canonical) path first, then each other spelling of the same file the service verified (a legacy row recorded
      // under a symlinked home's literal spelling). An alias location joins the document of the canonical identity: one file, one
      // document. An alias with no document yet (the backfill has not reached it) is linked directly, so the backfill keeps it there.
      for (const spelling of [e.path, ...(e.aliases ?? [])]) {
        const alias = spelling !== e.path
        const loc = q(`SELECT a.artifact_id, a.document_id, d.identity_kind FROM artifacts a LEFT JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.path = ?`).get(spelling) as Located | undefined
        if (!loc) continue
        if (loc.document_id === null ? !alias : loc.identity_kind !== 'provisional') continue
        const target = targetOf()
        const provisional = loc.document_id
        let documentId: string
        if (target) {
          documentId = target.document_id
          // The shared merge: locations, versions and evidence move, the provisional ID stays as an alias, dates and protection carry over.
          if (provisional !== null) mergeArtifactDocuments(db, provisional, documentId, now)
          else q('UPDATE artifacts SET document_id = ? WHERE artifact_id = ? AND document_id IS NULL').run(documentId, loc.artifact_id)
        } else {
          if (alias || provisional === null) continue
          documentId = provisional
          q(`UPDATE artifact_documents SET identity_kind = ?, repository_id = ?, identity_root_id = ?, relative_path = ?, legacy_artifact_id = NULL WHERE document_id = ?`)
            .run(id.identityKind, id.repositoryId, id.rootId, id.relativePath, provisional)
        }
        if (classifyPath(spelling).sensitive || hasPhiSegment(spelling) || hasPhiSegment(id.relativePath) || underProtectedRoot(q, spelling)) {
          q('UPDATE artifact_documents SET protected = 1 WHERE document_id = ? AND protected = 0').run(documentId)
        }
        q(`UPDATE artifacts SET root_id = COALESCE(root_id, ?), is_sensitive = MAX(is_sensitive, (SELECT protected FROM artifact_documents WHERE document_id = ?)) WHERE artifact_id = ?`)
          .run(e.rootId, documentId, loc.artifact_id)
        q(`UPDATE artifact_documents SET protected = 1 WHERE document_id = ? AND protected = 0 AND EXISTS (SELECT 1 FROM artifacts WHERE document_id = ? AND is_sensitive = 1)`)
          .run(documentId, documentId)
        resolved++
      }
    }
    return resolved
  })
}
