// One large document group for the derived-state cost tests (Wave 2b fix round 1, I1): many locations, one working version
// per location (its current one) and many commit versions, written with plain SQL the way any writer could, so the
// artifact_documents_state_* triggers run for every row. Nothing here goes through the persistence layer's checks.
import type { AtlasDb } from '../../src/db/database.ts'

export type LargeDocumentShape = {
  name: string
  repositoryId: string
  rootId: string
  locations: number
  commits: number
  /** Every location's exists and verification state. */
  location: { exists: 'present' | 'missing'; verification: string | null }
  /** Every working version's preservation state. */
  workingPreservation: 'preserved' | 'unique' | 'unknown'
  /** Every commit version's availability. */
  commitAvailability: 'available' | 'last-known' | 'unavailable' | 'unknown'
  at: string
}

export type LargeDocument = { documentId: string; locationIds: number[]; commitVersionIds: string[] }

export function addLargeDocument(db: AtlasDb, s: LargeDocumentShape): LargeDocument {
  const raw = db.raw
  const documentId = `large-${s.name}`
  db.transaction(() => {
    raw.prepare(`INSERT INTO artifact_documents (document_id, identity_kind, repository_id, relative_path, display_name, extension, first_observed_at)
      VALUES (?, 'repository', ?, ?, ?, 'log', ?)`).run(documentId, s.repositoryId, s.name, s.name, s.at)
    raw.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO artifacts (path, filename, extension, file_type, created_at, exists_state, is_sensitive, document_id, root_id, verification_state)
      SELECT printf('/large/%s/%05d/%s', ?, i, ?), ?, 'log', 'text', ?, ?, 0, ?, ?, ? FROM n`)
      .run(s.locations, s.name, s.name, s.name, s.at, s.location.exists, documentId, s.rootId, s.location.verification)
    raw.prepare(`INSERT INTO artifact_versions (version_id, document_id, kind, location_artifact_id, observation_revision, stat_signature, observed_at)
      SELECT printf('%s-w-%06d', ?, artifact_id), ?, 'working', artifact_id, 1, 'sig', ? FROM artifacts WHERE document_id = ? ORDER BY artifact_id`)
      .run(s.name, documentId, s.at, documentId)
    raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at)
      SELECT version_id, 'available', ?, ? FROM artifact_versions WHERE document_id = ? AND kind = 'working' ORDER BY version_id`).run(s.workingPreservation, s.at, documentId)
    raw.prepare(`UPDATE artifacts SET current_version_id = printf('%s-w-%06d', ?, artifact_id) WHERE document_id = ?`).run(s.name, documentId)
    raw.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, commit_oid, git_path, object_format, blob_oid, mode, size_bytes, observed_at)
      SELECT printf('%s-c-%06d', ?, i), ?, 'commit', ?, printf('%040d', i), ?, 'sha1', printf('%040d', i), 33188, 10, ? FROM n`)
      .run(s.commits, s.name, documentId, s.repositoryId, s.name, s.at)
    raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at)
      SELECT version_id, ?, 'unknown', ? FROM artifact_versions WHERE document_id = ? AND kind = 'commit' ORDER BY version_id`).run(s.commitAvailability, s.at, documentId)
  })
  return {
    documentId,
    locationIds: (raw.prepare('SELECT artifact_id FROM artifacts WHERE document_id = ? ORDER BY artifact_id').all(documentId) as Array<{ artifact_id: number }>).map(r => r.artifact_id),
    commitVersionIds: (raw.prepare(`SELECT version_id FROM artifact_versions WHERE document_id = ? AND kind = 'commit' ORDER BY version_id`).all(documentId) as Array<{ version_id: string }>)
      .map(r => r.version_id),
  }
}

/** The derived-state objects of migration 9 that a pre-release build did not create (fix round 1, I2). */
export const PRE_RELEASE_MISSING_INDEXES: readonly string[] = [
  'idx_artifact_documents_availability', 'idx_artifact_documents_preservation', 'idx_artifact_version_state_git', 'idx_artifact_version_state_live_risk',
  'idx_artifact_version_state_index_risk', 'idx_artifact_version_state_preserved',
]
export const PRE_RELEASE_MISSING_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['artifact_documents', 'availability'], ['artifact_documents', 'needs_preservation'], ['artifact_version_state', 'version_document_id'],
  ['artifact_version_state', 'version_kind'], ['artifact_version_state', 'live_copy'], ['artifacts', 'last_seen_device'],
]

/**
 * Turns a current catalog into the one a pre-release build of migration 9 left (before Wave 2a's last_seen_device and Wave 2b's
 * derived state): its triggers, indexes and columns are dropped, migration 9 stays recorded as applied, every row stays.
 */
export function toPreReleaseCatalog(db: AtlasDb): void {
  const raw = db.raw
  const triggers = raw.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'artifact_documents_state_%'`).all() as Array<{ name: string }>
  for (const { name } of triggers) raw.exec(`DROP TRIGGER ${name}`)
  for (const name of PRE_RELEASE_MISSING_INDEXES) raw.exec(`DROP INDEX IF EXISTS ${name}`)
  // The pre-release document index had the document column only.
  raw.exec('DROP INDEX IF EXISTS idx_artifacts_document')
  raw.exec('CREATE INDEX idx_artifacts_document ON artifacts(document_id)')
  for (const [table, column] of PRE_RELEASE_MISSING_COLUMNS) {
    if (raw.prepare('SELECT 1 AS hit FROM pragma_table_xinfo(?) WHERE name = ?').get(table, column)) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
  }
}
