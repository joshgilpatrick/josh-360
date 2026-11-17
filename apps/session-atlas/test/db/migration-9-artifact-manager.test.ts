import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrate, openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { artifactDocumentAtRiskDefinitionSql, artifactDocumentAvailabilityDefinitionSql } from '../../src/db/migration-9-artifact-manager.ts'
import { addOrigin, searchArtifacts, upsertArtifact } from '../../src/db/artifacts.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { openTestDb, tableNames } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

const T = '2026-10-01T00:00:00.000Z', S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10'
const NEW_TABLES = ['artifact_repositories', 'artifact_roots', 'artifact_documents', 'artifact_versions', 'artifact_version_state', 'artifact_evidence', 'artifact_jobs', 'artifact_document_aliases', 'artifact_manager_state']
const NEW_ARTIFACT_COLUMNS = ['document_id', 'root_id', 'current_version_id', 'git_state', 'observation_signature', 'last_change_at', 'verification_state', 'last_seen_device']

function columns(db: AtlasDb, table: string): string[] {
  return (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
}
function count(db: AtlasDb, table: string): number {
  return (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}
/** Rows as plain objects: node:sqlite returns null-prototype objects, which strict deepEqual refuses to match against literals. */
function plain(rows: unknown[]): unknown[] {
  return rows.map(r => ({ ...(r as object) }))
}
function plan(db: AtlasDb, sql: string): string {
  return (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(r => r.detail).join('\n')
}

/** A populated file database exactly as a production install looks at schema 8: sessions, artifacts with origins, FTS and a candidate. */
function atEight(): { path: string; ids: number[] } {
  const path = join(tempDir('atlas-m9-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  migrate(db, MIGRATIONS.filter(m => m.id <= 8))
  ensureSession(db, { sessionId: S1, cwd: '/x/keystone', startedAt: T, now: T })
  ensureSession(db, { sessionId: S2, cwd: '/x/other', startedAt: T, now: T })
  const a = upsertArtifact(db, { path: '/x/keystone/docs/billing-export.md', sizeBytes: 10, createdAt: T, projectName: 'keystone', now: T })
  const b = upsertArtifact(db, { path: '/x/other/data.csv', sizeBytes: 20, createdAt: T, projectName: 'other', now: T })
  addOrigin(db, a.artifactId, S1, 'creator', 'tool_event', T)
  addOrigin(db, b.artifactId, S2, 'reference', 'reconcile', T)
  db.raw.prepare(`INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at) VALUES ('/x/keystone/pending.md', ?, 'watcher', ?)`).run(S1, T)
  db.close()
  return { path, ids: [a.artifactId, b.artifactId] }
}

function seed(db: AtlasDb) {
  const ins = (sql: string, ...params: Array<string | number | null>) => db.raw.prepare(sql).run(...params)
  return {
    repo: (id: string, dir = `/r/${id}/.git`) => ins(`INSERT INTO artifact_repositories (repository_id, common_dir, display_name, registered_at) VALUES (?, ?, ?, ?)`, id, dir, id, T),
    root: (id: string, path: string, extra: { kind?: string; flags?: string; protectedFlag?: number; coverage?: string; repo?: string | null } = {}) =>
      ins(`INSERT INTO artifact_roots (root_id, kind, canonical_path, repository_id, protected, active, scope_flags, desired_generation, applied_generation, coverage_state)
           VALUES (?, ?, ?, ?, ?, 1, ?, 1, 0, ?)`, id, extra.kind ?? 'output', path, extra.repo ?? null, extra.protectedFlag ?? 0, extra.flags ?? '["configured-output"]', extra.coverage ?? 'idle'),
    repoDoc: (id: string, repo: string, rel: string) => ins(`INSERT INTO artifact_documents (document_id, identity_kind, repository_id, relative_path, display_name, first_observed_at) VALUES (?, 'repository', ?, ?, ?, ?)`, id, repo, rel, rel, T),
    rootDoc: (id: string, root: string, rel: string) => ins(`INSERT INTO artifact_documents (document_id, identity_kind, identity_root_id, relative_path, display_name, first_observed_at) VALUES (?, 'root', ?, ?, ?, ?)`, id, root, rel, rel, T),
    commit: (id: string, doc: string, repo: string, oid: string, path: string) => ins(`INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, commit_oid, git_path, object_format, blob_oid, mode, size_bytes, observed_at) VALUES (?, ?, 'commit', ?, ?, ?, 'sha1', 'b1', 33188, 5, ?)`, id, doc, repo, oid, path, T),
    working: (id: string, doc: string, artifact: number, revision: number) => ins(`INSERT INTO artifact_versions (version_id, document_id, kind, location_artifact_id, observation_revision, stat_signature, observed_at) VALUES (?, ?, 'working', ?, ?, 'sig', ?)`, id, doc, artifact, revision, T),
    index: (id: string, doc: string, checkout: string, path: string, stage: number, revision: number) => ins(`INSERT INTO artifact_versions (version_id, document_id, kind, checkout_identity, git_path, object_format, blob_oid, index_stage, observation_revision, mode, size_bytes, observed_at) VALUES (?, ?, 'index', ?, ?, 'sha1', 'b2', ?, ?, 33188, 5, ?)`, id, doc, checkout, path, stage, revision, T),
    evidence: (id: string, key: string, doc: string, extra: { session?: string | null; source?: string; operation?: string; certainty?: string } = {}) =>
      ins(`INSERT INTO artifact_evidence (evidence_id, source_key, document_id, session_id, source, operation, certainty, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, key, doc, extra.session ?? null, extra.source ?? 'hook', extra.operation ?? 'created', extra.certainty ?? 'recorded', T),
    job: (id: string, scope: string, kind: string, extra: { state?: string; coverage?: string } = {}) =>
      ins(`INSERT INTO artifact_jobs (job_id, scope_id, task_kind, desired_generation, applied_generation, state, priority, attempts, coverage_state, updated_at) VALUES (?, ?, ?, 1, 0, ?, 5, 0, ?, ?)`, id, scope, kind, extra.state ?? 'queued', extra.coverage ?? 'partial', T),
  }
}

test('migration 9 is registered after 8, additive, and needs no preflight guard or foreign-key opt-out', () => {
  assert.deepEqual(MIGRATIONS.map(m => m.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  const m = MIGRATIONS.find(x => x.id === 9)!
  assert.equal(m.name, 'artifact-manager')
  assert.equal(m.noForeignKeys, undefined)
  assert.doesNotMatch(m.sql, /\bDROP\b/i)
})

test('a fresh database has the new tables with the frozen column names and the new nullable artifacts columns', () => {
  const db = openTestDb()
  for (const t of NEW_TABLES) assert.ok(tableNames(db).includes(t), `missing ${t}`)
  assert.deepEqual(columns(db, 'artifact_repositories'), ['repository_id', 'common_dir', 'display_name', 'remote_identity', 'registered_at', 'last_verified_at'])
  assert.deepEqual(columns(db, 'artifact_roots'), ['root_id', 'kind', 'canonical_path', 'repository_id', 'project_name', 'checkout_identity', 'protected', 'active', 'scope_flags', 'desired_generation', 'applied_generation', 'cursor', 'coverage_state', 'last_successful_at', 'last_error'])
  assert.deepEqual(columns(db, 'artifact_documents'), ['document_id', 'identity_kind', 'repository_id', 'identity_root_id', 'relative_path', 'legacy_artifact_id', 'display_name', 'extension', 'project_name', 'protected', 'first_created_at', 'last_change_at', 'last_change_source', 'first_observed_at', 'availability', 'needs_preservation'])
  assert.deepEqual(columns(db, 'artifact_versions'), ['version_id', 'document_id', 'kind', 'location_artifact_id', 'repository_id', 'checkout_identity', 'commit_oid', 'git_path', 'object_format', 'blob_oid', 'index_stage', 'observation_revision', 'stat_signature', 'raw_sha256', 'mode', 'size_bytes', 'observed_at'])
  assert.deepEqual(columns(db, 'artifact_version_state'), ['version_id', 'availability', 'preservation_state', 'checked_at', 'version_document_id', 'version_kind', 'live_copy'])
  assert.deepEqual(columns(db, 'artifact_evidence'), ['evidence_id', 'source_key', 'document_id', 'version_id', 'artifact_id', 'session_id', 'source', 'operation', 'certainty', 'event_at', 'observed_at', 'source_locator'])
  assert.deepEqual(columns(db, 'artifact_jobs'), ['job_id', 'scope_id', 'task_kind', 'desired_generation', 'applied_generation', 'pass_generation', 'state', 'priority', 'lease_until', 'retry_at', 'attempts', 'cursor', 'coverage_state', 'last_error', 'updated_at'])
  assert.deepEqual(columns(db, 'artifact_document_aliases'), ['alias_id', 'document_id', 'created_at'])
  assert.deepEqual(columns(db, 'artifact_manager_state'), ['key', 'value', 'updated_at'])
  const cols = db.raw.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
  for (const name of NEW_ARTIFACT_COLUMNS) {
    const c = cols.find(x => x.name === name)
    assert.ok(c, `artifacts.${name} added`)
    assert.equal(c.notnull, 0, `artifacts.${name} is nullable`)
    assert.equal(c.dflt_value, null)
  }
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('migrating a populated schema-8 database applies only migration 9 and keeps every existing row, FTS entry and migration record', () => {
  const { path, ids } = atEight()
  const before = openDatabase(path, { migrate: false })
  const snapshot = {
    migrations: before.raw.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all(),
    sessions: before.raw.prepare('SELECT * FROM sessions ORDER BY session_id').all(),
    artifacts: before.raw.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all(),
    origins: before.raw.prepare('SELECT * FROM artifact_origins ORDER BY artifact_id, session_id').all(),
    candidates: before.raw.prepare('SELECT * FROM artifact_candidates ORDER BY candidate_id').all(),
  }
  assert.equal(snapshot.migrations.length, 8)
  before.close()

  // Only migrations up to 9: migration 10 (a later, separate change) adds a column to sessions, which would change the row snapshot below.
  const db = openDatabase(path, { migrate: false })
  migrate(db, MIGRATIONS.filter(m => m.id <= 9)) // no preflight backup exists and none is needed: the migration is additive
  const rows = (sql: string) => db.raw.prepare(sql).all()
  assert.deepEqual(rows('SELECT id, name, applied_at FROM schema_migrations WHERE id <= 8 ORDER BY id'), snapshot.migrations, 'prior migration records untouched')
  assert.deepEqual(plain(rows('SELECT id FROM schema_migrations WHERE id > 8')), [{ id: 9 }])
  assert.deepEqual(rows('SELECT * FROM sessions ORDER BY session_id'), snapshot.sessions)
  assert.deepEqual(rows('SELECT * FROM artifact_origins ORDER BY artifact_id, session_id'), snapshot.origins)
  assert.deepEqual(rows('SELECT * FROM artifact_candidates ORDER BY candidate_id'), snapshot.candidates)
  const after = rows('SELECT * FROM artifacts ORDER BY artifact_id') as Array<Record<string, unknown>>
  assert.deepEqual(after.map(r => r.artifact_id), ids, 'artifact IDs preserved')
  for (const [i, row] of after.entries()) {
    const old = snapshot.artifacts[i] as Record<string, unknown>
    for (const [k, v] of Object.entries(old)) assert.equal(row[k], v, `artifacts.${k} preserved`)
    for (const k of NEW_ARTIFACT_COLUMNS) assert.equal(row[k], null, `artifacts.${k} starts null`)
  }
  assert.deepEqual(searchArtifacts(db, { q: 'billing' }, { limit: 10, offset: 0 }).rows.map(r => r.artifactId), [ids[0]], 'FTS still finds the legacy row')
  db.raw.exec(`INSERT INTO artifacts_fts(artifacts_fts) VALUES ('integrity-check')`) // throws if the external-content index disagrees with artifacts
  for (const t of NEW_TABLES) assert.equal(count(db, t), 0, `${t} starts empty: population is a later background job`)
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal((db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  db.close()
})

test('the artifacts FTS triggers and uniqueness survive the added columns', () => {
  const db = openTestDb()
  const triggers = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'artifacts' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name)
  // The FTS triggers, plus (Wave 2b) the ones that keep each document's derived availability and preservation current.
  assert.deepEqual(triggers, ['artifact_documents_state_location_delete', 'artifact_documents_state_location_insert', 'artifact_documents_state_location_update', 'artifacts_ad', 'artifacts_ai', 'artifacts_au'])
  const a = upsertArtifact(db, { path: '/x/keystone/notes.md', sizeBytes: 1, createdAt: T, projectName: 'keystone', now: T })
  assert.deepEqual(searchArtifacts(db, { q: 'notes' }, { limit: 10, offset: 0 }).rows.map(r => r.artifactId), [a.artifactId])
  db.raw.prepare('UPDATE artifacts SET path = ?, filename = ? WHERE artifact_id = ?').run('/x/keystone/renamed.md', 'renamed.md', a.artifactId)
  assert.equal(searchArtifacts(db, { q: 'notes' }, { limit: 10, offset: 0 }).total, 0)
  assert.equal(searchArtifacts(db, { q: 'renamed' }, { limit: 10, offset: 0 }).total, 1)
  assert.throws(() => db.raw.prepare(`INSERT INTO artifacts (path, filename, created_at) VALUES ('/x/keystone/renamed.md', 'dup', ?)`).run(T), /UNIQUE/)
  db.close()
})

test('F-STATS: migration 9 discards planner statistics a pre-upgrade ANALYZE left on the artifacts table, and keeps the others', () => {
  const { path } = atEight()
  const before = openDatabase(path, { migrate: false })
  before.raw.exec('ANALYZE')
  const stats = (db: AtlasDb) => plain(db.raw.prepare('SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx').all()) as Array<{ tbl: string }>
  assert.ok(stats(before).some(r => r.tbl === 'artifacts'), 'the analyzed schema-8 catalog has statistics on artifacts')
  const others = stats(before).filter(r => r.tbl !== 'artifacts')
  assert.ok(others.some(r => r.tbl === 'sessions'))
  before.close()
  const db = openDatabase(path)
  assert.deepEqual(stats(db).filter(r => r.tbl === 'artifacts'), [], 'statistics describing artifacts without its new indexes are gone')
  assert.deepEqual(stats(db), others, 'statistics of every other table are kept as they were')
  db.close()
  // A catalog without statistics (the usual case) migrates as before: there is no sqlite_stat1 to touch.
  const plainCatalog = atEight()
  const fresh = openDatabase(plainCatalog.path)
  assert.equal((fresh.raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'`).get() as { n: number }).n, 0)
  fresh.close()
})

test('a second migration is a no-op, including after reopening the file', () => {
  const { path } = atEight()
  const db = openDatabase(path)
  assert.equal(migrate(db), 0)
  assert.equal(count(db, 'schema_migrations'), 13)
  db.close()
  const again = openDatabase(path)
  assert.equal(count(again, 'schema_migrations'), 13)
  assert.equal((again.raw.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v, 13)
  again.close()
})

test('a failure inside migration 9 rolls back every table and column it added', () => {
  const path = join(tempDir('atlas-m9-fail-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  const m9 = MIGRATIONS.find(m => m.id === 9)!
  migrate(db, MIGRATIONS.filter(m => m.id <= 8))
  assert.throws(() => migrate(db, [{ ...m9, sql: `${m9.sql}\nINSERT INTO table_that_does_not_exist VALUES (1);` }]), /no such table/)
  for (const t of NEW_TABLES) assert.ok(!tableNames(db).includes(t), `${t} rolled back`)
  assert.ok(!columns(db, 'artifacts').includes('document_id'))
  assert.equal(count(db, 'schema_migrations'), 8)
  assert.equal(migrate(db, MIGRATIONS.filter(m => m.id <= 9)), 1, 'the real migration still applies afterwards')
  db.close()
})

test('artifact_manager_state holds a key, a value and an update time', () => {
  const db = openTestDb()
  db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES ('discovery_paused', '1', ?)`).run(T)
  assert.throws(() => db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES ('discovery_paused', '0', ?)`).run(T), /UNIQUE|PRIMARY KEY/)
  assert.throws(() => db.raw.prepare(`INSERT INTO artifact_manager_state (key, updated_at) VALUES ('no_value', ?)`).run(T), /NOT NULL/)
  assert.deepEqual(plain(db.raw.prepare(`SELECT key, value, updated_at FROM artifact_manager_state`).all()), [{ key: 'discovery_paused', value: '1', updated_at: T }])
  db.close()
})

test('roots enforce their enums, flags, JSON scope array and canonical-path uniqueness', () => {
  const db = openTestDb(), s = seed(db)
  s.root('r1', '/home/u/docs', { flags: '["configured-output","session-cwd"]' })
  assert.throws(() => s.root('r2', '/home/u/docs'), /UNIQUE/, 'overlapping registrations dedupe by canonical path')
  assert.throws(() => s.root('r3', '/home/u/a', { kind: 'worktree' }), /CHECK/)
  assert.throws(() => s.root('r3', '/home/u/a', { coverage: 'done' }), /CHECK/)
  assert.throws(() => s.root('r3', '/home/u/a', { protectedFlag: 2 }), /CHECK/)
  assert.throws(() => s.root('r3', '/home/u/a', { flags: 'not json' }), /CHECK/, 'invalid JSON is rejected, not raised as a JSON error')
  assert.throws(() => s.root('r3', '/home/u/a', { flags: '{"a":1}' }), /CHECK/, 'JSON must be an array')
  assert.throws(() => s.root('r3', '/home/u/a', { repo: 'no-such-repo' }), /FOREIGN KEY/)
  s.repo('repo1')
  s.root('r4', '/home/u/b', { kind: 'checkout', repo: 'repo1', flags: '[]' })
  assert.throws(() => s.repo('repo2', '/r/repo1/.git'), /UNIQUE/, 'one repository per common dir')
  db.close()
})

test('document identity kinds each require exactly their own key columns, and keys are unique per tuple', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.repo('repo2'); s.root('r1', '/home/u/out')
  const a = upsertArtifact(db, { path: '/home/u/old.md', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  const doc = (id: string, kind: string, repo: string | null, root: string | null, rel: string | null, legacy: number | null) =>
    db.raw.prepare(`INSERT INTO artifact_documents (document_id, identity_kind, repository_id, identity_root_id, relative_path, legacy_artifact_id, display_name, first_observed_at) VALUES (?, ?, ?, ?, ?, ?, 'd', ?)`).run(id, kind, repo, root, rel, legacy, T)

  s.repoDoc('d1', 'repo1', 'docs/a.md')
  s.repoDoc('d2', 'repo2', 'docs/a.md') // same relative path in an independent clone is a distinct document
  assert.throws(() => s.repoDoc('d3', 'repo1', 'docs/a.md'), /UNIQUE/)
  s.rootDoc('d4', 'r1', 'a.md')
  assert.throws(() => s.rootDoc('d5', 'r1', 'a.md'), /UNIQUE/)
  doc('d6', 'provisional', null, null, null, a.artifactId)
  assert.throws(() => doc('d7', 'provisional', null, null, null, a.artifactId), /UNIQUE/, 'a provisional row is unique by its legacy artifact')
  assert.throws(() => doc('d8', 'provisional', null, null, null, 9999), /FOREIGN KEY/)

  assert.throws(() => doc('x1', 'repository', null, null, 'a.md', null), /CHECK/, 'repository identity needs a repository')
  assert.throws(() => doc('x2', 'repository', 'repo1', 'r1', 'b.md', null), /CHECK/, 'repository identity has no root')
  assert.throws(() => doc('x3', 'repository', 'repo1', null, null, null), /CHECK/, 'repository identity needs a path')
  assert.throws(() => doc('x4', 'root', 'repo1', 'r1', 'b.md', null), /CHECK/, 'root identity has no repository')
  assert.throws(() => doc('x5', 'root', null, null, 'b.md', null), /CHECK/, 'root identity needs a root')
  assert.throws(() => doc('x6', 'provisional', null, null, null, null), /CHECK/, 'provisional identity needs its legacy artifact')
  assert.throws(() => doc('x7', 'provisional', null, null, 'b.md', a.artifactId), /CHECK/, 'provisional identity carries no path')
  assert.throws(() => doc('x8', 'repository', 'repo1', null, 'c.md', a.artifactId), /CHECK/, 'a verified identity drops the legacy link')
  assert.throws(() => doc('x9', 'guess', null, null, null, null), /CHECK/)
  db.close()
})

test('document filter columns default safely for rows written without them, and protected is a 0/1 flag', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.repoDoc('d1', 'repo1', 'docs/a.md')
  assert.deepEqual(plain(db.raw.prepare(`SELECT extension, project_name, protected FROM artifact_documents WHERE document_id = 'd1'`).all()), [{ extension: '', project_name: null, protected: 0 }])
  assert.throws(() => db.raw.prepare(`UPDATE artifact_documents SET protected = 2 WHERE document_id = 'd1'`).run(), /CHECK/)
  assert.throws(() => db.raw.prepare(`UPDATE artifact_documents SET extension = NULL WHERE document_id = 'd1'`).run(), /NOT NULL/)
  db.close()
})

test('derived document state (Wave 2b): a new document is unavailable with nothing at risk, the values are checked enums, and triggers keep them on every write', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.root('r1', '/home/u/out'); s.repoDoc('d1', 'repo1', 'docs/a.md')
  const state = () => plain(db.raw.prepare(`SELECT availability, needs_preservation FROM artifact_documents WHERE document_id = 'd1'`).all())
  assert.deepEqual(state(), [{ availability: 'unavailable', needs_preservation: 0 }])
  assert.throws(() => db.raw.prepare(`UPDATE artifact_documents SET availability = 'gone' WHERE document_id = 'd1'`).run(), /CHECK/)
  assert.throws(() => db.raw.prepare(`UPDATE artifact_documents SET needs_preservation = 2 WHERE document_id = 'd1'`).run(), /CHECK/)
  // Raw writes, as any module makes them: a commit version with its state, then a present location holding a working version.
  s.commit('c1', 'd1', 'repo1', 'a'.repeat(40), 'docs/a.md')
  assert.deepEqual(state(), [{ availability: 'unavailable', needs_preservation: 0 }], 'a version without its state row counts for nothing')
  db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES ('c1', 'available', 'unknown', ?)`).run(T)
  assert.deepEqual(state(), [{ availability: 'git', needs_preservation: 0 }])
  const a = upsertArtifact(db, { path: '/home/u/out/a.md', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  db.raw.prepare(`UPDATE artifacts SET document_id = 'd1' WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(state(), [{ availability: 'local', needs_preservation: 0 }], 'a legacy location with no verification state counts as verified')
  s.working('w1', 'd1', a.artifactId, 1)
  db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES ('w1', 'available', 'unknown', ?)`).run(T)
  assert.deepEqual(state(), [{ availability: 'local', needs_preservation: 0 }], 'not current at its location yet')
  db.raw.prepare(`UPDATE artifacts SET current_version_id = 'w1' WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(state(), [{ availability: 'local', needs_preservation: 1 }])
  db.raw.prepare(`UPDATE artifact_version_state SET preservation_state = 'preserved' WHERE version_id = 'w1'`).run()
  assert.deepEqual(state(), [{ availability: 'local', needs_preservation: 0 }])
  db.raw.prepare(`UPDATE artifacts SET exists_state = 'missing' WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(state(), [{ availability: 'git', needs_preservation: 0 }])
  db.raw.prepare(`UPDATE artifact_version_state SET availability = 'unknown' WHERE version_id = 'c1'`).run()
  assert.deepEqual(state(), [{ availability: 'stale', needs_preservation: 0 }], 'an unproven Git object is last-known, not unavailable')
  db.raw.prepare(`UPDATE artifact_version_state SET availability = 'unavailable' WHERE version_id = 'c1'`).run()
  assert.deepEqual(state(), [{ availability: 'unavailable', needs_preservation: 0 }])

  // A version moved to another document (a merge) refreshes both documents.
  s.repoDoc('d2', 'repo1', 'docs/b.md')
  const of = (id: string) => plain(db.raw.prepare(`SELECT availability, needs_preservation FROM artifact_documents WHERE document_id = ?`).all(id))
  db.raw.prepare(`UPDATE artifact_version_state SET availability = 'available' WHERE version_id = 'c1'`).run()
  assert.deepEqual(of('d1'), [{ availability: 'git', needs_preservation: 0 }])
  db.raw.prepare(`UPDATE artifact_versions SET document_id = 'd2' WHERE version_id = 'c1'`).run()
  assert.deepEqual([of('d1'), of('d2')], [[{ availability: 'unavailable', needs_preservation: 0 }], [{ availability: 'git', needs_preservation: 0 }]])
  // A location holding (as current) a version of another document: its changes refresh that document too.
  db.raw.prepare(`UPDATE artifacts SET exists_state = 'present', document_id = 'd1' WHERE artifact_id = ?`).run(a.artifactId)
  db.raw.prepare(`UPDATE artifact_version_state SET preservation_state = 'unknown' WHERE version_id = 'w1'`).run()
  db.raw.prepare(`UPDATE artifact_versions SET document_id = 'd2' WHERE version_id = 'w1'`).run()
  assert.deepEqual(of('d2'), [{ availability: 'git', needs_preservation: 1 }], 'w1 is still current at a present location')
  db.raw.prepare(`UPDATE artifacts SET exists_state = 'missing' WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(of('d2'), [{ availability: 'git', needs_preservation: 0 }], 'the location of d1 changed what is at risk in d2')
  db.raw.prepare(`UPDATE artifacts SET exists_state = 'present' WHERE artifact_id = ?`).run(a.artifactId)
  db.raw.prepare(`UPDATE artifacts SET current_version_id = NULL WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(of('d2'), [{ availability: 'git', needs_preservation: 0 }], 'no longer current')
  // A working version made current before its state row exists counts once the state row arrives; a superseded copy's
  // availability alone changes nothing.
  s.working('w2', 'd1', a.artifactId, 2)
  db.raw.prepare(`UPDATE artifacts SET current_version_id = 'w2' WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(of('d1'), [{ availability: 'local', needs_preservation: 0 }])
  db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES ('w2', 'available', 'unique', ?)`).run(T)
  assert.deepEqual(of('d1'), [{ availability: 'local', needs_preservation: 1 }])
  db.raw.prepare(`UPDATE artifact_version_state SET availability = 'unavailable' WHERE version_id = 'w2'`).run()
  assert.deepEqual(of('d1'), [{ availability: 'local', needs_preservation: 1 }], 'a working version counts through its location, not its availability')
  db.close()
})

test('the delete triggers keep the derived state equal to the rules for every delete the foreign keys allow, and with them off (fix round 1, R76)', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.repoDoc('d1', 'repo1', 'docs/a.md'); s.repoDoc('d2', 'repo1', 'docs/b.md')
  const of = (id: string) => plain(db.raw.prepare(`SELECT availability, needs_preservation FROM artifact_documents WHERE document_id = ?`).all(id))
  const drift = () => plain(db.raw.prepare(`SELECT document_id FROM artifact_documents d WHERE availability IS NOT ${artifactDocumentAvailabilityDefinitionSql('d.document_id')}
    OR needs_preservation IS NOT ${artifactDocumentAtRiskDefinitionSql('d.document_id')}`).all())
  const state = (id: string, availability: string, preservation: string) =>
    db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES (?, ?, ?, ?)`).run(id, availability, preservation, T)
  // A location with no versions (the only one the foreign keys let go): its document loses its local availability.
  const a = upsertArtifact(db, { path: '/home/u/out/a.md', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  db.raw.prepare(`UPDATE artifacts SET document_id = 'd1' WHERE artifact_id = ?`).run(a.artifactId)
  assert.deepEqual(of('d1'), [{ availability: 'local', needs_preservation: 0 }])
  db.raw.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(a.artifactId)
  assert.deepEqual(of('d1'), [{ availability: 'unavailable', needs_preservation: 0 }], 'location delete')
  // A version state row (nothing refers to it), then its version once nothing refers to that.
  s.commit('c1', 'd1', 'repo1', 'a'.repeat(40), 'docs/a.md')
  state('c1', 'available', 'unknown')
  assert.deepEqual(of('d1'), [{ availability: 'git', needs_preservation: 0 }])
  db.raw.prepare(`DELETE FROM artifact_version_state WHERE version_id = 'c1'`).run()
  assert.deepEqual(of('d1'), [{ availability: 'unavailable', needs_preservation: 0 }], 'version state delete')
  db.raw.prepare(`DELETE FROM artifact_versions WHERE version_id = 'c1'`).run()
  assert.deepEqual(of('d1'), [{ availability: 'unavailable', needs_preservation: 0 }], 'version delete')
  assert.deepEqual(drift(), [])
  // With foreign keys off (as during a migration that turns them off), a version can go while its state row stays, and a
  // location while its versions stay: neither counts any longer, as in the rules' definitions.
  const b = upsertArtifact(db, { path: '/home/u/out/b.md', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  db.raw.prepare(`UPDATE artifacts SET document_id = 'd1' WHERE artifact_id = ?`).run(b.artifactId)
  s.working('w1', 'd2', b.artifactId, 1)
  state('w1', 'available', 'unknown')
  db.raw.prepare(`UPDATE artifacts SET current_version_id = 'w1' WHERE artifact_id = ?`).run(b.artifactId)
  s.commit('c2', 'd2', 'repo1', 'b'.repeat(40), 'docs/b.md')
  state('c2', 'available', 'unknown')
  assert.deepEqual([of('d1'), of('d2')], [[{ availability: 'local', needs_preservation: 0 }], [{ availability: 'git', needs_preservation: 1 }]])
  db.raw.exec('PRAGMA foreign_keys = OFF')
  try {
    db.raw.prepare(`DELETE FROM artifact_versions WHERE version_id = 'c2'`).run()
    assert.deepEqual(of('d2'), [{ availability: 'unavailable', needs_preservation: 1 }], 'an orphaned Git state row no longer counts')
    db.raw.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(b.artifactId)
    assert.deepEqual([of('d1'), of('d2')], [[{ availability: 'unavailable', needs_preservation: 0 }], [{ availability: 'unavailable', needs_preservation: 0 }]],
      'the deleted location is no longer local for d1, nor the live copy of w1 for d2')
    db.raw.prepare(`DELETE FROM artifact_versions WHERE version_id = 'w1'`).run()
    assert.deepEqual(drift(), [])
  } finally {
    db.raw.exec('PRAGMA foreign_keys = ON')
  }
  db.close()
})

test('version kinds enforce their required columns and their own uniqueness keys', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.repoDoc('d1', 'repo1', 'docs/a.md'); s.repoDoc('d2', 'repo1', 'docs/b.md')
  const a = upsertArtifact(db, { path: '/home/u/a.md', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  const raw = (sql: string, ...p: Array<string | number | null>) => db.raw.prepare(sql).run(...p)

  s.commit('c1', 'd1', 'repo1', 'aaa', 'docs/a.md')
  assert.throws(() => s.commit('c2', 'd1', 'repo1', 'aaa', 'docs/a.md'), /UNIQUE/, 'same document, repository, commit and path')
  s.commit('c3', 'd1', 'repo1', 'bbb', 'docs/a.md') // another commit keeps its own provenance
  s.commit('c4', 'd1', 'repo1', 'aaa', 'docs/renamed.md') // same commit, different path-at-commit
  s.commit('c5', 'd2', 'repo1', 'aaa', 'docs/a.md') // a different document may share the commit and path text
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, commit_oid, git_path, object_format, mode, size_bytes, observed_at) VALUES ('c6', 'd1', 'commit', 'repo1', 'ccc', 'p', 'sha1', 33188, 1, ?)`, T), /CHECK/, 'commit needs a blob')
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, git_path, object_format, blob_oid, mode, size_bytes, observed_at) VALUES ('c7', 'd1', 'commit', 'p', 'sha1', 'b', 33188, 1, ?)`, T), /CHECK/, 'commit needs repository and commit OID')

  s.working('w1', 'd1', a.artifactId, 1)
  s.working('w2', 'd1', a.artifactId, 2)
  assert.throws(() => s.working('w3', 'd1', a.artifactId, 2), /UNIQUE/, 'one working version per location and revision')
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, location_artifact_id, observation_revision, observed_at) VALUES ('w4', 'd1', 'working', ?, 3, ?)`, a.artifactId, T), /CHECK/, 'working needs a stat signature')
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, observation_revision, stat_signature, observed_at) VALUES ('w5', 'd1', 'working', 3, 's', ?)`, T), /CHECK/, 'working needs a location')

  s.index('i1', 'd1', 'co1', 'docs/a.md', 0, 1)
  s.index('i2', 'd1', 'co1', 'docs/a.md', 0, 2)
  s.index('i3', 'd1', 'co1', 'docs/a.md', 2, 1) // a conflict stage is its own snapshot
  assert.throws(() => s.index('i4', 'd1', 'co1', 'docs/a.md', 0, 2), /UNIQUE/, 'checkout, path, stage and revision')
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, git_path, object_format, blob_oid, index_stage, observation_revision, mode, size_bytes, observed_at) VALUES ('i5', 'd1', 'index', 'p', 'sha1', 'b', 0, 1, 33188, 1, ?)`, T), /CHECK/, 'index needs a checkout identity')
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, checkout_identity, git_path, object_format, blob_oid, observation_revision, mode, size_bytes, observed_at) VALUES ('i6', 'd1', 'index', 'co1', 'p', 'sha1', 'b', 1, 33188, 1, ?)`, T), /CHECK/, 'index needs a stage')
  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, checkout_identity, git_path, object_format, blob_oid, index_stage, mode, size_bytes, observed_at) VALUES ('i7', 'd1', 'index', 'co1', 'p', 'sha1', 'b', 0, 33188, 1, ?)`, T), /CHECK/, 'an index snapshot has an observation revision, or its uniqueness key would never fire')

  assert.throws(() => raw(`INSERT INTO artifact_versions (version_id, document_id, kind, observed_at) VALUES ('k1', 'd1', 'snapshot', ?)`, T), /CHECK/)
  assert.throws(() => s.commit('c8', 'no-such-doc', 'repo1', 'zzz', 'p'), /FOREIGN KEY/)
  db.close()
})

test('derived version state is a separate row with its own enums', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.repoDoc('d1', 'repo1', 'a.md'); s.commit('c1', 'd1', 'repo1', 'aaa', 'a.md')
  const state = (id: string, availability: string, preservation: string) => db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES (?, ?, ?, ?)`).run(id, availability, preservation, T)
  assert.throws(() => state('c1', 'gone', 'unknown'), /CHECK/)
  assert.throws(() => state('c1', 'unknown', 'safe'), /CHECK/)
  assert.throws(() => state('nope', 'unknown', 'unknown'), /FOREIGN KEY/)
  state('c1', 'unknown', 'unknown')
  assert.throws(() => state('c1', 'available', 'preserved'), /UNIQUE|PRIMARY KEY/)
  db.raw.prepare(`UPDATE artifact_version_state SET availability = 'last-known', preservation_state = 'unique', checked_at = ? WHERE version_id = 'c1'`).run('2026-10-02T00:00:00.000Z')
  assert.equal((db.raw.prepare(`SELECT kind FROM artifact_versions WHERE version_id = 'c1'`).get() as { kind: string }).kind, 'commit', 'the immutable version row is untouched')
  db.close()
})

test('evidence is unique by source key, validates its enums, and deleting a session keeps documents, versions and the evidence', () => {
  const db = openTestDb(), s = seed(db)
  ensureSession(db, { sessionId: S1, cwd: '/x', startedAt: T, now: T })
  s.repo('repo1'); s.repoDoc('d1', 'repo1', 'a.md'); s.commit('c1', 'd1', 'repo1', 'aaa', 'a.md')
  s.evidence('e1', 'hook:1', 'd1', { session: S1 })
  s.evidence('e2', 'hook:2', 'd1', { session: null, source: 'legacy', operation: 'touched', certainty: 'unknown' })
  assert.throws(() => s.evidence('e3', 'hook:1', 'd1'), /UNIQUE/, 'replaying a source event cannot duplicate evidence')
  assert.throws(() => s.evidence('e3', 'hook:3', 'd1', { source: 'guess' }), /CHECK/)
  assert.throws(() => s.evidence('e3', 'hook:3', 'd1', { operation: 'deleted' }), /CHECK/)
  assert.throws(() => s.evidence('e3', 'hook:3', 'd1', { certainty: 'sure' }), /CHECK/)
  assert.throws(() => s.evidence('e3', 'hook:3', 'd1', { session: 'no-such-session' }), /FOREIGN KEY/)
  assert.throws(() => s.evidence('e3', 'hook:3', 'no-such-doc'), /FOREIGN KEY/)

  db.raw.prepare('DELETE FROM sessions WHERE session_id = ?').run(S1)
  assert.deepEqual(plain(db.raw.prepare(`SELECT evidence_id, session_id FROM artifact_evidence ORDER BY evidence_id`).all()), [{ evidence_id: 'e1', session_id: null }, { evidence_id: 'e2', session_id: null }])
  assert.equal(count(db, 'artifact_documents'), 1)
  assert.equal(count(db, 'artifact_versions'), 1)
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('jobs are unique per scope and task, with checked states and coverage', () => {
  const db = openTestDb(), s = seed(db)
  s.job('j1', 'root:r1', 'output-walk')
  s.job('j2', 'root:r1', 'checkout-status') // another task class on the same scope
  s.job('j3', 'root:r2', 'output-walk')
  assert.throws(() => s.job('j4', 'root:r1', 'output-walk'), /UNIQUE/, 'one active job per scope and task class')
  for (const state of ['queued', 'running', 'retry', 'done', 'failed']) s.job(`s-${state}`, `scope-${state}`, 'verify', { state })
  assert.throws(() => s.job('j5', 'root:r9', 'verify', { state: 'paused' }), /CHECK/)
  assert.throws(() => s.job('j5', 'root:r9', 'verify', { coverage: 'idle' }), /CHECK/)
  db.close()
})

test('aliases keep retired group IDs resolvable and must name a real document', () => {
  const db = openTestDb(), s = seed(db)
  s.repo('repo1'); s.repoDoc('d1', 'repo1', 'a.md')
  db.raw.prepare(`INSERT INTO artifact_document_aliases (alias_id, document_id, created_at) VALUES ('retired-group', 'd1', ?)`).run(T)
  assert.throws(() => db.raw.prepare(`INSERT INTO artifact_document_aliases (alias_id, document_id, created_at) VALUES ('other', 'nope', ?)`).run(T), /FOREIGN KEY/)
  assert.throws(() => db.raw.prepare(`INSERT INTO artifact_document_aliases (alias_id, document_id, created_at) VALUES ('retired-group', 'd1', ?)`).run(T), /UNIQUE|PRIMARY KEY/)
  db.close()
})

test('the hot queries use the migration indexes instead of scanning', () => {
  const db = openTestDb()
  const uses = (sql: string, index: string) => assert.match(plan(db, sql), new RegExp(`USING (COVERING )?INDEX ${index}\\b`), `${sql}\n${plan(db, sql)}`)
  // grouped list: activity order, document-to-location/version/evidence joins
  const ordered = (sql: string, index: string) => { uses(sql, index); assert.doesNotMatch(plan(db, sql), /TEMP B-TREE/, `${sql} reads in index order`) }
  ordered(`SELECT document_id FROM artifact_documents ORDER BY last_change_at DESC, document_id DESC LIMIT 50`, 'idx_artifact_documents_activity')
  ordered(`SELECT document_id FROM artifact_documents WHERE extension = 'md' AND protected = 0 ORDER BY last_change_at DESC, document_id DESC LIMIT 50`, 'idx_artifact_documents_extension')
  ordered(`SELECT document_id FROM artifact_documents WHERE project_name = 'p' AND protected = 0 ORDER BY last_change_at DESC, document_id DESC LIMIT 50`, 'idx_artifact_documents_project')
  uses(`SELECT artifact_id FROM artifacts WHERE document_id = 'd'`, 'idx_artifacts_document')
  uses(`SELECT artifact_id FROM artifacts WHERE root_id = 'r'`, 'idx_artifacts_root')
  uses(`SELECT version_id FROM artifact_versions WHERE document_id = 'd' ORDER BY observed_at DESC`, 'idx_artifact_versions_document')
  uses(`SELECT evidence_id FROM artifact_evidence WHERE document_id = 'd' ORDER BY observed_at DESC`, 'idx_artifact_evidence_document')
  // session-to-evidence join
  uses(`SELECT document_id FROM artifact_evidence WHERE session_id = 's'`, 'idx_artifact_evidence_session')
  // logical keys and root-relative lookups (partial unique indexes)
  uses(`SELECT document_id FROM artifact_documents WHERE identity_kind = 'repository' AND repository_id = 'r' AND relative_path = 'p'`, 'idx_artifact_documents_repository_path')
  uses(`SELECT document_id FROM artifact_documents WHERE identity_kind = 'root' AND identity_root_id = 'r' AND relative_path = 'p'`, 'idx_artifact_documents_root_path')
  uses(`SELECT version_id FROM artifact_versions WHERE kind = 'working' AND location_artifact_id = 1 ORDER BY observation_revision DESC`, 'idx_artifact_versions_working')
  // due jobs, expired leases, stale verification
  uses(`SELECT job_id FROM artifact_jobs WHERE state = 'queued' ORDER BY priority DESC, retry_at`, 'idx_artifact_jobs_due')
  uses(`SELECT job_id FROM artifact_jobs WHERE state = 'running' AND lease_until <= 'x'`, 'idx_artifact_jobs_lease')
  uses(`SELECT artifact_id FROM artifacts WHERE verification_state = 'stale' ORDER BY last_verified_at LIMIT 100`, 'idx_artifacts_verification')
  uses(`SELECT version_id FROM artifact_version_state WHERE checked_at < 'x'`, 'idx_artifact_version_state_checked')
  uses(`SELECT version_id FROM artifact_version_state WHERE preservation_state = 'unique'`, 'idx_artifact_version_state_preservation')
  // Wave 2b: the derived filters count index-only and page in index order for one extension.
  uses(`SELECT COUNT(*) FROM artifact_documents WHERE availability = 'local' AND protected = 0 AND extension IN ('md', 'pdf')`, 'idx_artifact_documents_availability')
  ordered(`SELECT document_id FROM artifact_documents WHERE availability = 'git' AND protected = 0 AND extension = 'md' ORDER BY last_change_at DESC, document_id DESC LIMIT 50`, 'idx_artifact_documents_availability')
  uses(`SELECT COUNT(*) FROM artifact_documents WHERE needs_preservation = 1 AND protected = 0 AND extension IN ('md', 'pdf')`, 'idx_artifact_documents_preservation')
  ordered(`SELECT document_id FROM artifact_documents WHERE needs_preservation = 0 AND protected = 0 AND extension = 'md' ORDER BY last_change_at DESC, document_id DESC LIMIT 50`, 'idx_artifact_documents_preservation')
  // Fix round 1 (I1): each probe of the derived-state rules is one seek: locations on all three keys of idx_artifacts_document,
  // versions in a partial index whose WHERE is the rule's own condition.
  uses(`SELECT 1 FROM artifacts WHERE document_id = 'd' AND exists_state = 'present' AND verification_state = 'verified'`, 'idx_artifacts_document')
  uses(`SELECT 1 FROM artifacts WHERE document_id = 'd' AND exists_state = 'present' AND verification_state IS NULL`, 'idx_artifacts_document')
  uses(`SELECT 1 FROM artifact_version_state WHERE version_document_id = 'd' AND version_kind IN ('commit', 'index') AND availability = 'available'`, 'idx_artifact_version_state_git')
  uses(`SELECT 1 FROM artifact_version_state WHERE version_document_id = 'd' AND version_kind = 'working' AND live_copy = 1 AND preservation_state IN ('unique', 'unknown')`, 'idx_artifact_version_state_live_risk')
  uses(`SELECT 1 FROM artifact_version_state WHERE version_document_id = 'd' AND version_kind = 'index' AND preservation_state IN ('unique', 'unknown') AND availability IN ('available', 'unknown')`, 'idx_artifact_version_state_index_risk')
  uses(`SELECT 1 FROM artifact_version_state WHERE version_document_id = 'd' AND preservation_state = 'preserved'`, 'idx_artifact_version_state_preserved')
  db.close()
})
