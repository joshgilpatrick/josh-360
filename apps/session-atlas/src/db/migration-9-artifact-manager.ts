import type { DatabaseSync } from 'node:sqlite'
import type { Migration } from './migrations.ts'

// ------------------------------------------------------------------------------------------------ planner statistics (F-STATS)

/** The tables migration 9 creates or adds indexes to: the artifact manager's catalog. */
export const ARTIFACT_MANAGER_TABLES: readonly string[] = Object.freeze([
  'artifacts', 'artifact_repositories', 'artifact_roots', 'artifact_documents', 'artifact_versions', 'artifact_version_state', 'artifact_evidence',
  'artifact_jobs', 'artifact_document_aliases', 'artifact_manager_state',
])

/**
 * F-STATS: deletes the planner statistics (sqlite_stat1, and sqlite_stat4 where SQLite built one) of the artifact manager's
 * tables and, when it removed any, makes this connection's planner reload them (ANALYZE sqlite_schema reads the statistics
 * tables again; it computes nothing). Atlas never runs ANALYZE. Statistics taken by anything else while a column was still
 * empty (artifacts.document_id before the legacy backfill: "this index matches every row") made SQLite scan every location
 * for every document: one grouped list request took 104 s instead of 8 ms. Without statistics the planner's index heuristics
 * are the plans the catalog was measured with. Statistics are derived data that ANALYZE can rebuild; nothing else is deleted,
 * so this needs no backup guard. Returns how many statistics rows it deleted. The caller owns the transaction.
 */
export function deleteArtifactPlannerStatistics(raw: DatabaseSync): number {
  let removed = 0
  for (const table of ['sqlite_stat1', 'sqlite_stat4']) {
    if (!raw.prepare(`SELECT 1 AS hit FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table)) continue
    removed += Number(raw.prepare(`DELETE FROM ${table} WHERE tbl IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ARTIFACT_MANAGER_TABLES)).changes)
  }
  if (removed > 0) raw.exec('ANALYZE sqlite_schema')
  return removed
}

// ------------------------------------------------------------------------------------------------ derived document state
//
// Wave 2b (PERF-GAP-1): two rules of the grouped list are stored on each document group and kept current by triggers, in the
// same transaction (the same statement) as every write that can change them, whichever module makes it. The list filters on
// them through their own indexes instead of evaluating the rules for every document, which took 50-240 ms at 10,000 groups and
// grew with the catalog. A later change to a rule needs a migration that replaces the triggers and rebuilds the stored values
// (migration 9 is unreleased, so it is amended in place here).
//
// Each rule has two forms. The DEFINITION reads locations, versions and version state directly: it is the rule as the Wave 2a
// list evaluated it, and the consistency check compares the stored values with it. The INDEXED form, used by the triggers and
// the list's display, gives the same answer through bounded index probes (fix round 1, I1): every EXISTS is one seek on all the
// key columns of an index, so it costs O(log n) in the size of the document whether a row matches or not, however many locations
// and versions the document has. Locations are probed on idx_artifacts_document (document, exists state, verification state);
// versions through partial indexes on artifact_version_state, whose rows carry three copies kept by the same triggers: their
// version's document and kind, and whether it is a live working copy (its version is its own location's current version and
// that location is present). Nothing else reads the copies.

/** The live-copy flag of the version `vid` (an SQL expression): two primary-key lookups. */
function liveCopySql(vid: string): string {
  return `EXISTS (SELECT 1 FROM artifact_versions lv JOIN artifacts ll ON ll.artifact_id = lv.location_artifact_id
    WHERE lv.version_id = ${vid} AND ll.current_version_id = lv.version_id AND ll.exists_state = 'present')`
}

/** The live-copy flag of the version row aliased `v`: one primary-key lookup. */
function liveCopyOfSql(v: string): string {
  return `EXISTS (SELECT 1 FROM artifacts ll WHERE ll.artifact_id = ${v}.location_artifact_id AND ll.current_version_id = ${v}.version_id AND ll.exists_state = 'present')`
}

/**
 * The availability of the document whose ID is the SQL expression `doc` (the Wave 2a rule): `local` when a location is present
 * and verified (a legacy row with no verification state counts as verified); else `git` when a commit or index version is
 * available; else `stale` when a location is present but not verified, or a Git version's object could not be read without
 * proof either way (`unknown`); else `unavailable`. Indexed form: each branch is one or two seeks (a verified location is
 * 'verified' or, for a legacy row, NULL: two seeks).
 */
export function artifactDocumentAvailabilitySql(doc: string): string {
  return `CASE
  WHEN EXISTS (SELECT 1 FROM artifacts la INDEXED BY idx_artifacts_document WHERE la.document_id = ${doc} AND la.exists_state = 'present' AND la.verification_state = 'verified')
    OR EXISTS (SELECT 1 FROM artifacts ln INDEXED BY idx_artifacts_document WHERE ln.document_id = ${doc} AND ln.exists_state = 'present' AND ln.verification_state IS NULL) THEN 'local'
  WHEN EXISTS (SELECT 1 FROM artifact_version_state gs INDEXED BY idx_artifact_version_state_git
               WHERE gs.version_document_id = ${doc} AND gs.version_kind IN ('commit', 'index') AND gs.availability = 'available') THEN 'git'
  WHEN EXISTS (SELECT 1 FROM artifacts ka INDEXED BY idx_artifacts_document WHERE ka.document_id = ${doc} AND ka.exists_state = 'present') THEN 'stale'
  WHEN EXISTS (SELECT 1 FROM artifact_version_state us INDEXED BY idx_artifact_version_state_git
               WHERE us.version_document_id = ${doc} AND us.version_kind IN ('commit', 'index') AND us.availability = 'unknown') THEN 'stale'
  ELSE 'unavailable' END`
}

/**
 * Whether a worktree removal could lose a version of the document `doc` (needs preservation): a version not known to be
 * preserved (`unique` or `unknown`) that is the current working copy of a present location (a live copy), or a live staged
 * snapshot (an index version that is available or unknown). `extra` narrows the version state further (the display's `unique`
 * test, on `rs`). Indexed form: one seek per preservation value in each partial index.
 */
export function artifactDocumentAtRiskSql(doc: string, extra = ''): string {
  return `(EXISTS (SELECT 1 FROM artifact_version_state rs INDEXED BY idx_artifact_version_state_live_risk
    WHERE rs.version_document_id = ${doc} AND rs.version_kind = 'working' AND rs.live_copy = 1 AND rs.preservation_state IN ('unique', 'unknown') ${extra})
  OR EXISTS (SELECT 1 FROM artifact_version_state rs INDEXED BY idx_artifact_version_state_index_risk
    WHERE rs.version_document_id = ${doc} AND rs.version_kind = 'index' AND rs.preservation_state IN ('unique', 'unknown') ${extra}
      AND rs.availability IN ('available', 'unknown')))`
}

/** The availability rule's definition: the same answer as artifactDocumentAvailabilitySql, read from the source rows. */
export function artifactDocumentAvailabilityDefinitionSql(doc: string): string {
  return `CASE
  WHEN EXISTS (SELECT 1 FROM artifacts la WHERE la.document_id = ${doc} AND la.exists_state = 'present' AND COALESCE(la.verification_state, 'verified') = 'verified') THEN 'local'
  WHEN EXISTS (SELECT 1 FROM artifact_versions gv JOIN artifact_version_state gs ON gs.version_id = gv.version_id
               WHERE gv.document_id = ${doc} AND gv.kind IN ('commit', 'index') AND gs.availability = 'available') THEN 'git'
  WHEN EXISTS (SELECT 1 FROM artifacts ka WHERE ka.document_id = ${doc} AND ka.exists_state = 'present') THEN 'stale'
  WHEN EXISTS (SELECT 1 FROM artifact_versions uv JOIN artifact_version_state us ON us.version_id = uv.version_id
               WHERE uv.document_id = ${doc} AND uv.kind IN ('commit', 'index') AND us.availability = 'unknown') THEN 'stale'
  ELSE 'unavailable' END`
}

/** The at-risk rule's definition: the same answer as artifactDocumentAtRiskSql, read from the source rows. */
export function artifactDocumentAtRiskDefinitionSql(doc: string): string {
  return `EXISTS (SELECT 1 FROM artifact_versions rv JOIN artifact_version_state rs ON rs.version_id = rv.version_id
  WHERE rv.document_id = ${doc} AND rs.preservation_state IN ('unique', 'unknown') AND (
    (rv.kind = 'working' AND EXISTS (SELECT 1 FROM artifacts ra WHERE ra.artifact_id = rv.location_artifact_id AND ra.current_version_id = rv.version_id AND ra.exists_state = 'present'))
    OR (rv.kind = 'index' AND rs.availability IN ('available', 'unknown'))))`
}

/**
 * Recomputes all three copies on the version state rows whose version ID is in `ids` (a list of SQL expressions or a SELECT)
 * from their versions and locations, and writes only the rows that changed: a few primary-key lookups per row.
 */
export function refreshArtifactVersionRuleCopiesSql(ids: string, when = ''): string {
  return `UPDATE artifact_version_state SET version_document_id = v.document_id, version_kind = v.kind, live_copy = ${liveCopyOfSql('v')}
FROM artifact_versions v WHERE v.version_id = artifact_version_state.version_id AND artifact_version_state.version_id IN (${ids}) ${when ? `AND (${when})` : ''}
  AND (artifact_version_state.version_document_id IS NOT v.document_id OR artifact_version_state.version_kind IS NOT v.kind
    OR artifact_version_state.live_copy IS NOT ${liveCopyOfSql('v')});`
}

/** Recomputes only the live-copy flag (what a location's change can change) of the state rows whose version ID is in `ids`. */
function refreshArtifactLiveCopySql(ids: string, when = ''): string {
  return `UPDATE artifact_version_state SET live_copy = ${liveCopySql('artifact_version_state.version_id')}
WHERE version_id IN (${ids}) ${when ? `AND (${when})` : ''} AND live_copy IS NOT ${liveCopySql('artifact_version_state.version_id')};`
}

/**
 * Clears the copies of the state rows whose version ID is in `ids` and whose version is gone (only possible with foreign keys
 * off): such a row counts for nothing, as in the definitions.
 */
export function clearOrphanArtifactVersionRuleCopiesSql(ids: string): string {
  return `UPDATE artifact_version_state SET version_document_id = NULL, version_kind = NULL, live_copy = 0
WHERE version_id IN (${ids}) AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.version_id = artifact_version_state.version_id)
  AND (version_document_id IS NOT NULL OR version_kind IS NOT NULL OR live_copy <> 0);`
}

/**
 * Recomputes the stored state of the documents whose ID is in `ids` (a list of SQL expressions or a SELECT) with the indexed
 * rules and writes only the documents whose state changed, so an unchanged document never touches its indexes. Each rule is
 * evaluated once for a document whose state does not change (the usual case) and at most twice for one whose state changes:
 * a few seeks each, cheaper than materializing the values first (measured). `when` narrows when it runs at all.
 */
export function refreshArtifactDocumentStateSql(ids: string, when = ''): string {
  const availability = artifactDocumentAvailabilitySql('artifact_documents.document_id')
  const atRisk = artifactDocumentAtRiskSql('artifact_documents.document_id')
  return `UPDATE artifact_documents SET availability = ${availability}, needs_preservation = ${atRisk}
WHERE document_id IN (${ids}) ${when ? `AND (${when})` : ''} AND (availability IS NOT ${availability} OR needs_preservation IS NOT ${atRisk});`
}

const docOfVersion = (v: string) => `(SELECT document_id FROM artifact_versions WHERE version_id = ${v})`

// The inputs of the two rules and the writes that change them. Each trigger first brings the copies on the version state rows it
// can affect up to date, then refreshes the documents it can affect; both steps read a bounded number of index entries. A
// version's insert needs no trigger: the rules read a version only through its state row, which can only be inserted after it
// (foreign key). A location affects the at-risk rule only through the version it holds as current, so a change of a location can
// change only its own document (availability), the live-copy flag of its old and new current versions, and their documents (at
// risk). The rules read a working version only while it is a live copy and only through its preservation (its availability is
// read through its location), so a state insert of a working version that is not live, or a change of a working version's
// availability alone, refreshes no document. Deleting a location or a version that still has dependent rows is refused by the
// foreign keys; their delete triggers keep the stored state right for the deletes that are allowed (a location with no versions;
// any delete with foreign keys off).
const LOCATION_CURRENT_CHANGED = 'OLD.current_version_id IS NOT NEW.current_version_id OR OLD.exists_state IS NOT NEW.exists_state'
const DOCUMENT_STATE_TRIGGERS = `
CREATE TRIGGER artifact_documents_state_location_insert AFTER INSERT ON artifacts WHEN NEW.document_id IS NOT NULL OR NEW.current_version_id IS NOT NULL
BEGIN
${refreshArtifactLiveCopySql('NEW.current_version_id')}
${refreshArtifactDocumentStateSql(`NEW.document_id, ${docOfVersion('NEW.current_version_id')}`)}
END;
CREATE TRIGGER artifact_documents_state_location_update AFTER UPDATE OF document_id, exists_state, verification_state, current_version_id ON artifacts
WHEN OLD.document_id IS NOT NEW.document_id OR OLD.exists_state IS NOT NEW.exists_state OR OLD.verification_state IS NOT NEW.verification_state
  OR OLD.current_version_id IS NOT NEW.current_version_id
BEGIN
${refreshArtifactLiveCopySql('OLD.current_version_id, NEW.current_version_id', LOCATION_CURRENT_CHANGED)}
${refreshArtifactDocumentStateSql(`NEW.document_id, OLD.document_id, ${docOfVersion('OLD.current_version_id')}, ${docOfVersion('NEW.current_version_id')}`)}
END;
CREATE TRIGGER artifact_documents_state_location_delete AFTER DELETE ON artifacts
BEGIN
${refreshArtifactLiveCopySql('OLD.current_version_id')}
${refreshArtifactDocumentStateSql(`OLD.document_id, ${docOfVersion('OLD.current_version_id')}`)}
END;
CREATE TRIGGER artifact_documents_state_version_update AFTER UPDATE OF document_id, kind, location_artifact_id ON artifact_versions
WHEN OLD.document_id IS NOT NEW.document_id OR OLD.kind IS NOT NEW.kind OR OLD.location_artifact_id IS NOT NEW.location_artifact_id
BEGIN
${refreshArtifactVersionRuleCopiesSql('NEW.version_id')}
${refreshArtifactDocumentStateSql('NEW.document_id, OLD.document_id')}
END;
CREATE TRIGGER artifact_documents_state_version_delete AFTER DELETE ON artifact_versions
BEGIN
${clearOrphanArtifactVersionRuleCopiesSql('OLD.version_id')}
${refreshArtifactDocumentStateSql('OLD.document_id')}
END;
CREATE TRIGGER artifact_documents_state_version_state_insert AFTER INSERT ON artifact_version_state
BEGIN
${refreshArtifactVersionRuleCopiesSql('NEW.version_id')}
${refreshArtifactDocumentStateSql(docOfVersion('NEW.version_id'), `EXISTS (SELECT 1 FROM artifact_version_state x WHERE x.version_id = NEW.version_id AND (x.version_kind IS NOT 'working' OR x.live_copy = 1))`)}
END;
CREATE TRIGGER artifact_documents_state_version_state_update AFTER UPDATE OF version_id, availability, preservation_state ON artifact_version_state
WHEN OLD.version_id IS NOT NEW.version_id OR OLD.preservation_state IS NOT NEW.preservation_state
  OR (OLD.availability IS NOT NEW.availability AND (SELECT kind FROM artifact_versions WHERE version_id = NEW.version_id) IS NOT 'working')
BEGIN
${refreshArtifactVersionRuleCopiesSql('NEW.version_id', 'OLD.version_id IS NOT NEW.version_id')}
${clearOrphanArtifactVersionRuleCopiesSql('NEW.version_id')}
${refreshArtifactDocumentStateSql(`${docOfVersion('NEW.version_id')}, ${docOfVersion('OLD.version_id')}, OLD.version_document_id`)}
END;
CREATE TRIGGER artifact_documents_state_version_state_delete AFTER DELETE ON artifact_version_state
BEGIN
${refreshArtifactDocumentStateSql(`OLD.version_document_id, ${docOfVersion('OLD.version_id')}`)}
END;
`

// Migration 9 (artifact manager spec sections 3 and 15): the additive schema only. A document group, a version of its contents
// and a place that version can be opened from are three different things, so they get three tables: artifact_documents (the
// logical group), artifact_versions (immutable observations) and artifacts (the existing location rows, extended below).
// Nothing here backfills: root and Git resolution, document links and legacy evidence are filled in later by resumable
// background jobs, outside any migration transaction, and every existing artifacts/artifact_origins/FTS row stays as it is.
//
// Additive means no DROP and no table rebuild, so no preflight backup guard and no noForeignKeys opt-out. ALTER TABLE ADD COLUMN
// keeps the artifacts primary key, path uniqueness and FTS triggers. Foreign keys deliberately have no ON DELETE CASCADE:
// deleting a session sets evidence.session_id to NULL and never deletes a document or version. Retired document group IDs are
// kept as rows in artifact_document_aliases so old links stay valid.
export const MIGRATION_9: Migration = {
  id: 9,
  name: 'artifact-manager',
  sql: `
CREATE TABLE artifact_repositories (
  repository_id TEXT PRIMARY KEY,
  common_dir TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  remote_identity TEXT,
  registered_at TEXT NOT NULL,
  last_verified_at TEXT
);

CREATE TABLE artifact_roots (
  root_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('checkout','output','session-directory')),
  canonical_path TEXT NOT NULL UNIQUE,
  repository_id TEXT REFERENCES artifact_repositories(repository_id),
  project_name TEXT,
  checkout_identity TEXT,
  protected INTEGER NOT NULL CHECK (protected IN (0,1)),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  -- A JSON array keeps overlapping session/config/CLI scan roles after canonical-path deduplication; it never makes a second file observation.
  scope_flags TEXT NOT NULL CHECK (CASE WHEN json_valid(scope_flags) THEN json_type(scope_flags) = 'array' ELSE 0 END),
  desired_generation INTEGER NOT NULL,
  applied_generation INTEGER NOT NULL,
  cursor TEXT,
  coverage_state TEXT NOT NULL CHECK (coverage_state IN ('idle','queued','scanning','partial','failed','inaccessible')),
  last_successful_at TEXT,
  last_error TEXT
);
CREATE INDEX idx_artifact_roots_repository ON artifact_roots(repository_id);
CREATE INDEX idx_artifact_roots_scan ON artifact_roots(active, coverage_state, last_successful_at);

CREATE TABLE artifact_documents (
  document_id TEXT PRIMARY KEY,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('repository','root','provisional')),
  repository_id TEXT REFERENCES artifact_repositories(repository_id),
  identity_root_id TEXT REFERENCES artifact_roots(root_id),
  relative_path TEXT,
  legacy_artifact_id INTEGER UNIQUE REFERENCES artifacts(artifact_id),
  display_name TEXT NOT NULL,
  -- Grouped-list filters stored on the document so filters, totals and pagination run on indexes (spec sections 3 and 12).
  -- extension: lowercase, no dot. project_name: from a root registration only, never inferred from content. protected: a
  -- sensitive filename, a phi path segment or any protected location; the persistence layer only ever raises it.
  extension TEXT NOT NULL DEFAULT '',
  project_name TEXT,
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),
  first_created_at TEXT,
  last_change_at TEXT,
  last_change_source TEXT,
  first_observed_at TEXT NOT NULL,
  -- Derived (Wave 2b, PERF-GAP-1), kept by the artifact_documents_state_* triggers below: the availability rule and whether a
  -- worktree removal could lose a version (artifactDocumentAvailabilitySql, artifactDocumentAtRiskSql). A new document has no
  -- location or version yet: unavailable, nothing at risk.
  availability TEXT NOT NULL DEFAULT 'unavailable' CHECK (availability IN ('local','git','stale','unavailable')),
  needs_preservation INTEGER NOT NULL DEFAULT 0 CHECK (needs_preservation IN (0,1)),
  CHECK (
    (identity_kind = 'repository' AND repository_id IS NOT NULL AND identity_root_id IS NULL AND relative_path IS NOT NULL AND legacy_artifact_id IS NULL)
    OR (identity_kind = 'root' AND repository_id IS NULL AND identity_root_id IS NOT NULL AND relative_path IS NOT NULL AND legacy_artifact_id IS NULL)
    OR (identity_kind = 'provisional' AND repository_id IS NULL AND identity_root_id IS NULL AND relative_path IS NULL AND legacy_artifact_id IS NOT NULL)
  )
);
-- The logical keys are tuples, never concatenated strings. A provisional row is unique by legacy_artifact_id (the column's own UNIQUE).
CREATE UNIQUE INDEX idx_artifact_documents_repository_path ON artifact_documents(repository_id, relative_path) WHERE identity_kind = 'repository';
CREATE UNIQUE INDEX idx_artifact_documents_root_path ON artifact_documents(identity_root_id, relative_path) WHERE identity_kind = 'root';
-- Activity order with a unique tie-break, so a page is read in index order with no sort. The filter indexes put protected
-- second: the default view hides protected documents, so its count is an index-only seek per extension.
CREATE INDEX idx_artifact_documents_activity ON artifact_documents(last_change_at DESC, document_id DESC);
CREATE INDEX idx_artifact_documents_extension ON artifact_documents(extension, protected, last_change_at DESC, document_id DESC);
CREATE INDEX idx_artifact_documents_project ON artifact_documents(project_name, protected, last_change_at DESC, document_id DESC);
-- The derived filters (Wave 2b): a count is an index-only seek per extension, a page with one extension reads in index order.
CREATE INDEX idx_artifact_documents_availability ON artifact_documents(availability, protected, extension, last_change_at DESC, document_id DESC);
CREATE INDEX idx_artifact_documents_preservation ON artifact_documents(needs_preservation, protected, extension, last_change_at DESC, document_id DESC);

CREATE TABLE artifact_versions (
  version_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES artifact_documents(document_id),
  kind TEXT NOT NULL CHECK (kind IN ('working','commit','index')),
  location_artifact_id INTEGER REFERENCES artifacts(artifact_id),
  repository_id TEXT REFERENCES artifact_repositories(repository_id),
  checkout_identity TEXT,
  commit_oid TEXT,
  git_path TEXT,
  object_format TEXT,
  blob_oid TEXT,
  index_stage INTEGER,
  observation_revision INTEGER,
  stat_signature TEXT,
  raw_sha256 TEXT,
  mode INTEGER,
  size_bytes INTEGER,
  observed_at TEXT NOT NULL,
  CHECK (
    (kind = 'commit' AND repository_id IS NOT NULL AND commit_oid IS NOT NULL AND git_path IS NOT NULL AND object_format IS NOT NULL
      AND blob_oid IS NOT NULL AND mode IS NOT NULL AND size_bytes IS NOT NULL)
    -- An index snapshot has no commit OID. Its observation revision is required too: the unique key below is meaningless with NULL.
    OR (kind = 'index' AND checkout_identity IS NOT NULL AND git_path IS NOT NULL AND object_format IS NOT NULL AND blob_oid IS NOT NULL
      AND index_stage IS NOT NULL AND observation_revision IS NOT NULL AND mode IS NOT NULL AND size_bytes IS NOT NULL)
    OR (kind = 'working' AND location_artifact_id IS NOT NULL AND observation_revision IS NOT NULL AND stat_signature IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_artifact_versions_commit ON artifact_versions(document_id, repository_id, commit_oid, git_path) WHERE kind = 'commit';
CREATE UNIQUE INDEX idx_artifact_versions_working ON artifact_versions(location_artifact_id, observation_revision) WHERE kind = 'working';
CREATE UNIQUE INDEX idx_artifact_versions_index ON artifact_versions(checkout_identity, git_path, index_stage, observation_revision) WHERE kind = 'index';
CREATE INDEX idx_artifact_versions_document ON artifact_versions(document_id, observed_at DESC);
-- The Git object check pages commit and index versions one repository at a time (fix round 1, I4).
CREATE INDEX idx_artifact_versions_git_objects ON artifact_versions(repository_id, version_id) WHERE kind IN ('commit', 'index');

-- Versions are immutable observations. Revalidation and removal checks update this derived row, never the version.
-- version_document_id, version_kind and live_copy are copies for the derived document state's indexed rules (fix round 1, I1),
-- kept by the artifact_documents_state_* triggers; writers never set them: the version's document and kind, and 1 while the
-- version is its own location's current version and that location is present (a live working copy).
CREATE TABLE artifact_version_state (
  version_id TEXT PRIMARY KEY REFERENCES artifact_versions(version_id),
  availability TEXT NOT NULL CHECK (availability IN ('available','last-known','unavailable','unknown')),
  preservation_state TEXT NOT NULL CHECK (preservation_state IN ('preserved','unique','unknown')),
  checked_at TEXT NOT NULL,
  version_document_id TEXT,
  version_kind TEXT,
  live_copy INTEGER NOT NULL DEFAULT 0 CHECK (live_copy IN (0,1))
);
CREATE INDEX idx_artifact_version_state_checked ON artifact_version_state(checked_at);
CREATE INDEX idx_artifact_version_state_preservation ON artifact_version_state(preservation_state, availability);
-- The rules' probes (fix round 1, I1): each partial index holds only the rows its rule can match, keyed by document, so a probe
-- is one seek whether a row matches or not. Git versions by availability; live working copies and staged snapshots by
-- preservation (the at-risk rule); preserved versions (the list's display).
CREATE INDEX idx_artifact_version_state_git ON artifact_version_state(version_document_id, availability) WHERE version_kind IN ('commit', 'index');
CREATE INDEX idx_artifact_version_state_live_risk ON artifact_version_state(version_document_id, preservation_state) WHERE version_kind = 'working' AND live_copy = 1;
CREATE INDEX idx_artifact_version_state_index_risk ON artifact_version_state(version_document_id, preservation_state, availability) WHERE version_kind = 'index';
CREATE INDEX idx_artifact_version_state_preserved ON artifact_version_state(version_document_id) WHERE preservation_state = 'preserved';

CREATE TABLE artifact_evidence (
  evidence_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES artifact_documents(document_id),
  version_id TEXT REFERENCES artifact_versions(version_id),
  artifact_id INTEGER REFERENCES artifacts(artifact_id),
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('hook','transcript','git','watcher','reconcile','legacy')),
  operation TEXT NOT NULL CHECK (operation IN ('created','modified','touched')),
  certainty TEXT NOT NULL CHECK (certainty IN ('recorded','inferred','unknown')),
  event_at TEXT,
  observed_at TEXT NOT NULL,
  source_locator TEXT
);
CREATE INDEX idx_artifact_evidence_document ON artifact_evidence(document_id, observed_at DESC);
CREATE INDEX idx_artifact_evidence_session ON artifact_evidence(session_id, document_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_artifact_evidence_version ON artifact_evidence(version_id) WHERE version_id IS NOT NULL;
CREATE INDEX idx_artifact_evidence_artifact ON artifact_evidence(artifact_id) WHERE artifact_id IS NOT NULL;

CREATE TABLE artifact_jobs (
  job_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  desired_generation INTEGER NOT NULL,
  applied_generation INTEGER NOT NULL,
  -- The generation the current pass runs at: fixed when a pass starts from no cursor and kept across resumed slices, so a
  -- change during a multi-slice pass leaves desired ahead of applied and gets a fresh pass. NULL between passes.
  pass_generation INTEGER,
  state TEXT NOT NULL CHECK (state IN ('queued','running','retry','done','failed')),
  priority INTEGER NOT NULL,
  lease_until TEXT,
  retry_at TEXT,
  attempts INTEGER NOT NULL,
  cursor TEXT,
  coverage_state TEXT NOT NULL CHECK (coverage_state IN ('complete','partial','inaccessible')),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_id, task_kind)
);
CREATE INDEX idx_artifact_jobs_due ON artifact_jobs(state, priority DESC, retry_at);
CREATE INDEX idx_artifact_jobs_lease ON artifact_jobs(state, lease_until);

CREATE TABLE artifact_document_aliases (
  alias_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES artifact_documents(document_id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifact_document_aliases_document ON artifact_document_aliases(document_id);

-- Small durable key/value store for manager state that is not a job: the discovery pause flag and health counters.
CREATE TABLE artifact_manager_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- artifacts stays the current or last-known local location. These columns link it to the logical document and root and carry
-- its Git/verification state; all are NULL until background enrichment fills them.
ALTER TABLE artifacts ADD COLUMN document_id TEXT REFERENCES artifact_documents(document_id);
ALTER TABLE artifacts ADD COLUMN root_id TEXT REFERENCES artifact_roots(root_id);
ALTER TABLE artifacts ADD COLUMN current_version_id TEXT REFERENCES artifact_versions(version_id);
ALTER TABLE artifacts ADD COLUMN git_state TEXT;
ALTER TABLE artifacts ADD COLUMN observation_signature TEXT;
ALTER TABLE artifacts ADD COLUMN last_change_at TEXT;
ALTER TABLE artifacts ADD COLUMN verification_state TEXT;
-- The device (st_dev, decimal) a check last saw this location present on, when it differs from its stat signature's or it has
-- none (legacy rows): the device proof for marking it missing (ruling R72).
ALTER TABLE artifacts ADD COLUMN last_seen_device TEXT;
-- A document's locations; with the exists and verification states as keys, each location probe of the availability rule is one
-- seek on all three columns (fix round 1, I1).
CREATE INDEX idx_artifacts_document ON artifacts(document_id, exists_state, verification_state);
CREATE INDEX idx_artifacts_root ON artifacts(root_id);
CREATE INDEX idx_artifacts_verification ON artifacts(verification_state, last_verified_at);
${DOCUMENT_STATE_TRIGGERS}`,
  // F-STATS: statistics a pre-upgrade ANALYZE left on the artifacts table describe it without the indexes added above.
  after: db => { deleteArtifactPlannerStatistics(db.raw) },
}
