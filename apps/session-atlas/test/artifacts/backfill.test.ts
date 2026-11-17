import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb } from '../helpers/db.ts'
import type { AtlasDb } from '../../src/db/database.ts'
import { addOrigin, searchArtifacts, upsertArtifact } from '../../src/db/artifacts.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import {
  getArtifactDocument, recordArtifactEvidence, recordArtifactObservation, registerArtifactRepository, registerArtifactRoot,
} from '../../src/db/artifact-manager.ts'
import { adoptProvisionalLocations, backfillLegacyArtifacts, LEGACY_BACKFILL_MAX_BATCH } from '../../src/artifacts/backfill.ts'

// The legacy backfill reads only the catalog: every path below is fictional, so a filesystem or Git scan would find nothing
// (and the test would still pass only if no scan is needed).
const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10'
const T = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString()
const HOME = '/home/u'

type Legacy = { id: number; path: string }

function legacy(db: AtlasDb, path: string, createdAt: string): Legacy {
  const r = upsertArtifact(db, { path, sizeBytes: 10, createdAt, projectName: 'legacy-proj', now: createdAt })
  return { id: r.artifactId, path }
}

function count(db: AtlasDb, sql: string, ...params: Array<string | number>): number {
  return (db.raw.prepare(sql).get(...params) as { n: number }).n
}

function doc(db: AtlasDb, artifactId: number): Record<string, unknown> {
  return db.raw.prepare(`SELECT d.* FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.artifact_id = ?`).get(artifactId) as Record<string, unknown>
}

function fixture(): { db: AtlasDb; rows: Legacy[] } {
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: `${HOME}/proj`, startedAt: T(0), now: T(0) })
  ensureSession(db, { sessionId: S2, cwd: `${HOME}/proj`, startedAt: T(0), now: T(0) })
  const rows = [
    legacy(db, `${HOME}/proj/report.md`, T(1)),
    legacy(db, `${HOME}/proj/data.csv`, T(2)),
    legacy(db, `${HOME}/proj/notes.txt`, T(3)),
    legacy(db, `${HOME}/proj/out/summary.html`, T(4)),
    legacy(db, `${HOME}/proj/orphan.md`, T(5)),
  ]
  addOrigin(db, rows[0]!.id, S1, 'creator', 'tool_event', T(1))
  addOrigin(db, rows[0]!.id, S2, 'reference', 'watcher', T(6))
  addOrigin(db, rows[1]!.id, S1, 'creator', 'reconcile', T(2))
  addOrigin(db, rows[2]!.id, S2, 'reference', 'tool_event', T(3))
  addOrigin(db, rows[3]!.id, S1, 'creator', 'watcher', T(4))
  return { db, rows }
}

test('legacy backfill links every old location to a provisional per-location document, resumably and idempotently', () => {
  const { db, rows } = fixture()
  try {
    const originsBefore = db.raw.prepare('SELECT * FROM artifact_origins ORDER BY artifact_id, session_id').all()
    const first = backfillLegacyArtifacts(db, null, 2, T(10))
    assert.equal(first.done, false)
    assert.equal(first.scanned, 2)
    assert.equal(first.cursor, String(rows[1]!.id))
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE document_id IS NOT NULL'), 2)
    // Restart from the committed cursor (a crash between batches loses nothing and repeats nothing).
    const second = backfillLegacyArtifacts(db, first.cursor, 2, T(11))
    const third = backfillLegacyArtifacts(db, second.cursor, 2, T(12))
    assert.equal(third.done, true)
    assert.equal(third.cursor, String(rows[4]!.id))
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE document_id IS NULL'), 0)

    for (const r of rows) {
      const d = doc(db, r.id)
      assert.equal(d.identity_kind, 'provisional', 'unverified locations are grouped per location')
      assert.equal(d.legacy_artifact_id, r.id)
      assert.equal(d.repository_id, null)
      assert.equal(d.identity_root_id, null)
    }
    // IDs, paths, FTS and origins are untouched; no root is invented.
    assert.deepEqual(db.raw.prepare('SELECT artifact_id, path FROM artifacts ORDER BY artifact_id').all().map(x => ({ ...x })), rows.map(r => ({ artifact_id: r.id, path: r.path })))
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE root_id IS NOT NULL'), 0)
    assert.deepEqual(db.raw.prepare('SELECT * FROM artifact_origins ORDER BY artifact_id, session_id').all(), originsBefore)
    assert.deepEqual(searchArtifacts(db, { q: 'summary', includeSubagents: true }, { limit: 10, offset: 0 }).rows.map(r => r.artifactId), [rows[3]!.id])

    // The historical date survives as the document's first observation and activity, labelled legacy.
    const d0 = doc(db, rows[0]!.id)
    assert.equal(d0.first_observed_at, T(1))
    assert.equal(d0.last_change_at, T(1))
    assert.equal(d0.last_change_source, 'legacy')
    assert.equal(d0.project_name, 'legacy-proj')

    // Every origin is preserved as legacy evidence with its detection method; never recorded, never a new creator.
    const ev = db.raw.prepare(`SELECT e.session_id, e.source, e.operation, e.certainty, e.event_at, e.source_locator, a.artifact_id FROM artifact_evidence e
      JOIN artifacts a ON a.artifact_id = e.artifact_id ORDER BY a.artifact_id, e.session_id`).all().map(x => ({ ...x }))
    assert.deepEqual(ev, [
      { session_id: S1, source: 'legacy', operation: 'created', certainty: 'unknown', event_at: T(1), source_locator: 'legacy:tool_event', artifact_id: rows[0]!.id },
      { session_id: S2, source: 'legacy', operation: 'touched', certainty: 'unknown', event_at: T(6), source_locator: 'legacy:watcher', artifact_id: rows[0]!.id },
      { session_id: S1, source: 'legacy', operation: 'created', certainty: 'unknown', event_at: T(2), source_locator: 'legacy:reconcile', artifact_id: rows[1]!.id },
      { session_id: S2, source: 'legacy', operation: 'touched', certainty: 'unknown', event_at: T(3), source_locator: 'legacy:tool_event', artifact_id: rows[2]!.id },
      { session_id: S1, source: 'legacy', operation: 'created', certainty: 'unknown', event_at: T(4), source_locator: 'legacy:watcher', artifact_id: rows[3]!.id },
    ])
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_evidence WHERE certainty = 'recorded'`), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_origins WHERE relation = 'creator'`), 3, 'no creator origin is added')

    // A full rerun from the start (a restart that lost its cursor) changes nothing.
    const snapshot = (table: string) => db.raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    const docs = snapshot('artifact_documents'), evidence = snapshot('artifact_evidence'), artifacts = snapshot('artifacts')
    const again = backfillLegacyArtifacts(db, null, 250, T(20))
    assert.equal(again.done, true)
    assert.equal(again.linked, 0)
    assert.equal(again.evidence, 0)
    assert.deepEqual(snapshot('artifact_documents'), docs)
    assert.deepEqual(snapshot('artifact_evidence'), evidence)
    assert.deepEqual(snapshot('artifacts'), artifacts)
  } finally {
    db.close()
  }
})

test('a backfill batch never exceeds 250 rows', () => {
  const db = openTestDb()
  try {
    db.transaction(() => { for (let i = 0; i < 260; i++) legacy(db, `${HOME}/bulk/f${i}.md`, T(i)) })
    assert.equal(LEGACY_BACKFILL_MAX_BATCH, 250)
    const r = backfillLegacyArtifacts(db, null, 1000, T(300))
    assert.equal(r.scanned, 250)
    assert.equal(r.done, false)
    const rest = backfillLegacyArtifacts(db, r.cursor, 1000, T(301))
    assert.equal(rest.scanned, 10)
    assert.equal(rest.done, true)
  } finally {
    db.close()
  }
})

test('a location the new pipeline already linked keeps its document; its historical origins still become legacy evidence', () => {
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: `${HOME}/out`, startedAt: T(0), now: T(0) })
    ensureSession(db, { sessionId: S2, cwd: `${HOME}/out`, startedAt: T(0), now: T(0) })
    const root = registerArtifactRoot(db, { kind: 'output', canonicalPath: `${HOME}/out`, repositoryId: null, projectName: 'out', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T(0))
    const old = legacy(db, `${HOME}/out/a.md`, T(1))
    addOrigin(db, old.id, S1, 'creator', 'tool_event', T(1))
    addOrigin(db, old.id, S2, 'reference', 'watcher', T(1))
    const linked = recordArtifactEvidence(db, {
      rootId: root.rootId, path: old.path, identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: 'a.md' },
      sourceKey: 'hook-event:x:1', source: 'hook', sessionId: S1, operation: 'modified', certainty: 'recorded', eventAt: T(2),
    }, T(2))
    backfillLegacyArtifacts(db, null, 250, T(3))
    assert.equal(doc(db, old.id).document_id, linked.documentId)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_documents WHERE identity_kind = 'provisional'`), 0)
    // S1's hook modification (T2) is a different event from its historical creator origin (T1, tool_event, creator): the origin was
    // never a projection of that event, so both survive as legacy evidence, S1's and S2's.
    assert.deepEqual(db.raw.prepare(`SELECT session_id FROM artifact_evidence WHERE source = 'legacy' AND document_id = ? ORDER BY session_id`).all(linked.documentId).map(x => ({ ...x })), [{ session_id: S1 }, { session_id: S2 }])
  } finally {
    db.close()
  }
})

// PR #19 review item 6: a duplicate is decided by event identity (artifact, session, relation, detection method and time), never by
// artifact and session alone.
test('an older creator origin and a later same-session modification both stay evidence; a true projection is not duplicated', () => {
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: `${HOME}/out`, startedAt: T(0), now: T(0) })
    const root = registerArtifactRoot(db, { kind: 'output', canonicalPath: `${HOME}/out`, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T(0))
    const identity = (relativePath: string) => ({ identityKind: 'root' as const, repositoryId: null, rootId: root.rootId, relativePath })
    const old = legacy(db, `${HOME}/out/old.md`, T(1))
    addOrigin(db, old.id, S1, 'creator', 'tool_event', T(1))
    const modified = recordArtifactEvidence(db, {
      rootId: root.rootId, path: old.path, identity: identity('old.md'), sourceKey: 'hook-event:m:1', source: 'hook', sessionId: S1,
      operation: 'modified', certainty: 'recorded', eventAt: T(3),
    }, T(3))
    // The projection of a recorded creation made after the upgrade but before the first backfill batch: the same event as its origin.
    const made = recordArtifactEvidence(db, {
      rootId: root.rootId, path: `${HOME}/out/made.md`, identity: identity('made.md'), sourceKey: 'hook-event:c:1', source: 'hook', sessionId: S1,
      operation: 'created', certainty: 'recorded', eventAt: T(4),
    }, T(4))
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_origins o JOIN artifacts a ON a.artifact_id = o.artifact_id WHERE a.path = ?`, `${HOME}/out/made.md`), 1)

    backfillLegacyArtifacts(db, null, 250, T(5))
    const evidence = (documentId: string) => db.raw.prepare(`SELECT source, operation, certainty, event_at FROM artifact_evidence WHERE document_id = ? ORDER BY event_at`).all(documentId).map(x => ({ ...x }))
    assert.deepEqual(evidence(modified.documentId), [
      { source: 'legacy', operation: 'created', certainty: 'unknown', event_at: T(1) },
      { source: 'hook', operation: 'modified', certainty: 'recorded', event_at: T(3) },
    ])
    assert.deepEqual(evidence(made.documentId), [{ source: 'hook', operation: 'created', certainty: 'recorded', event_at: T(4) }], 'the projection of a recorded event is not turned back into legacy evidence')
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_evidence WHERE source = 'legacy' AND session_id = ?`, S1), 1)
    // Idempotent: a rerun adds nothing.
    assert.equal(backfillLegacyArtifacts(db, null, 250, T(6)).evidence, 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_evidence WHERE source = 'legacy'`), 1)
  } finally {
    db.close()
  }
})

// I3: Task 2 projects a compatibility origin for every new hook/transcript link. The periodic backfill must not convert those
// back into invented `legacy` evidence: origins count only up to the bound fixed on the first run, and never when the origin is
// the projection of non-legacy evidence (same artifact, session, time, relation and detection method: event identity).
test('the backfill never invents legacy evidence for documents the new pipeline recorded after the upgrade', () => {
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: `${HOME}/out`, startedAt: T(0), now: T(0) })
    const root = registerArtifactRoot(db, { kind: 'output', canonicalPath: `${HOME}/out`, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T(0))
    const pre = legacy(db, `${HOME}/out/pre.md`, T(1))
    addOrigin(db, pre.id, S1, 'creator', 'tool_event', T(1))
    const first = backfillLegacyArtifacts(db, null, 250, T(2))
    assert.equal(first.evidence, 1, 'a pre-upgrade origin is legacy evidence')
    // After the upgrade: a hook records a new file (Task 2 projects a creator origin for it) ...
    const hooked = recordArtifactEvidence(db, {
      rootId: root.rootId, path: `${HOME}/out/new.md`, identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: 'new.md' },
      sourceKey: 'hook-event:s:1', source: 'hook', sessionId: S1, operation: 'created', certainty: 'recorded', eventAt: T(3),
    }, T(3))
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_origins o JOIN artifacts a ON a.artifact_id = o.artifact_id WHERE a.path = ?`, `${HOME}/out/new.md`), 1)
    // ... and the still-running legacy confirmer writes a row with an origin.
    const late = legacy(db, `${HOME}/out/late.md`, T(4))
    addOrigin(db, late.id, S1, 'creator', 'tool_event', T(4))
    const second = backfillLegacyArtifacts(db, first.cursor, 250, T(5))
    assert.equal(second.evidence, 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_evidence WHERE source = 'legacy' AND document_id = ?`, hooked.documentId), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_evidence WHERE source = 'legacy'`), 1, 'only the pre-upgrade origin')
    assert.equal(doc(db, late.id).identity_kind, 'provisional', 'the late legacy row is still linked')
    // Rerunning from the start changes nothing either: the bound is persistent.
    assert.equal(backfillLegacyArtifacts(db, null, 250, T(6)).evidence, 0)
  } finally {
    db.close()
  }
})

test('linking a legacy row raises its location protection from the document and from protected roots (R20)', () => {
  const db = openTestDb()
  try {
    // Written before the root became protected, then the root registration raised nothing for it (no document yet).
    const underRoot = legacy(db, `${HOME}/vault/statement.md`, T(1))
    const phi = legacy(db, `${HOME}/clinic/PHI/visit.md`, T(2))
    const dotPhi = legacy(db, `${HOME}/data/athena/csv/.phi/visit.md`, T(3))
    const plain = legacy(db, `${HOME}/clinic/plain.md`, T(3))
    db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
    registerArtifactRoot(db, { kind: 'output', canonicalPath: `${HOME}/vault`, repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(4))
    db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
    backfillLegacyArtifacts(db, null, 250, T(5))
    const flag = (id: number) => (db.raw.prepare('SELECT is_sensitive AS s FROM artifacts WHERE artifact_id = ?').get(id) as { s: number }).s
    assert.equal(flag(underRoot.id), 1)
    assert.equal(doc(db, underRoot.id).protected, 1)
    assert.equal(flag(phi.id), 1)
    assert.equal(doc(db, phi.id).protected, 1)
    assert.equal(flag(dotPhi.id), 1, 'a `.phi` folder protects like `phi` (R85)')
    assert.equal(doc(db, dotPhi.id).protected, 1)
    assert.equal(flag(plain.id), 0)
    assert.equal(doc(db, plain.id).protected, 0)
  } finally {
    db.close()
  }
})

test('a legacy row spelled with a symlinked home\'s literal prefix is judged against protected roots under both spellings', () => {
  const home = { literal: '/home/link', real: '/home/real' }
  const db = openTestDb()
  try {
    registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/real/sec', repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(1))
    const secret = legacy(db, '/home/link/sec/a.md', T(2))
    const open = legacy(db, '/home/link/open/b.md', T(3))
    const sibling = legacy(db, '/home/link/secret/c.md', T(3))
    const prefixed = legacy(db, '/home/linkX/sec/a.md', T(3))
    db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
    backfillLegacyArtifacts(db, null, 250, T(4), home)
    const flag = (id: number) => (db.raw.prepare('SELECT is_sensitive AS s FROM artifacts WHERE artifact_id = ?').get(id) as { s: number }).s
    assert.equal(flag(secret.id), 1)
    assert.equal(doc(db, secret.id).protected, 1)
    assert.equal(flag(open.id), 0)
    assert.equal(doc(db, open.id).protected, 0)
    assert.equal(flag(sibling.id), 0, 'a sibling that only shares the name prefix is not under the root')
    assert.equal(doc(db, sibling.id).protected, 0)
    assert.equal(flag(prefixed.id), 0, 'a path that only shares the literal home as a name prefix does not map')
    assert.equal(doc(db, prefixed.id).protected, 0)
  } finally {
    db.close()
  }
})

test('a row at the literal home itself maps to the real home and is protected by a protected root there', () => {
  const home = { literal: '/home/link', real: '/home/real' }
  const db = openTestDb()
  try {
    registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/real', repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(1))
    const atHome = legacy(db, '/home/link', T(2))
    db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
    backfillLegacyArtifacts(db, null, 250, T(3), home)
    assert.equal((db.raw.prepare('SELECT is_sensitive AS s FROM artifacts WHERE artifact_id = ?').get(atHome.id) as { s: number }).s, 1)
    assert.equal(doc(db, atHome.id).protected, 1)
  } finally {
    db.close()
  }
})

test('the raise-only re-run judges a linked legacy row under both spellings of a symlinked home', () => {
  const home = { literal: '/home/link', real: '/home/real' }
  const db = openTestDb()
  try {
    const row = legacy(db, '/home/link/sec/a.md', T(1))
    backfillLegacyArtifacts(db, null, 250, T(2), home)
    const flag = () => (db.raw.prepare('SELECT is_sensitive AS s FROM artifacts WHERE artifact_id = ?').get(row.id) as { s: number }).s
    assert.equal(flag(), 0)
    assert.equal(doc(db, row.id).protected, 0)
    registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/real/sec', repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(3))
    db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
    backfillLegacyArtifacts(db, null, 250, T(4), home)
    assert.equal(flag(), 1)
    assert.equal(doc(db, row.id).protected, 1)
  } finally {
    db.close()
  }
})

test('a provisional document merges into a verified repository document, keeping an alias, or is upgraded in place', () => {
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: `${HOME}/repo`, startedAt: T(0), now: T(0) })
    const repo = registerArtifactRepository(db, { commonDir: `${HOME}/repo/.git`, displayName: 'repo', remoteIdentity: null }, T(0))
    const checkout = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: `${HOME}/repo`, repositoryId: repo, projectName: 'repo', checkoutIdentity: 'ck-1', protected: false, scopeFlags: ['checkout'] }, T(0))
    const tracked = legacy(db, `${HOME}/repo/docs/plan.md`, T(1))
    const fresh = legacy(db, `${HOME}/repo/notes.md`, T(2))
    addOrigin(db, tracked.id, S1, 'creator', 'tool_event', T(1))
    backfillLegacyArtifacts(db, null, 250, T(3))
    const provisionalId = doc(db, tracked.id).document_id as string
    const freshProvisional = doc(db, fresh.id).document_id as string

    // Git history established the repository document for docs/plan.md.
    const blob = 'a'.repeat(40), commit = 'b'.repeat(40)
    const target = recordArtifactObservation(db, {
      rootId: checkout.rootId, identity: { identityKind: 'repository', repositoryId: repo, rootId: null, relativePath: 'docs/plan.md' }, kind: 'commit', observedAt: T(4),
      git: { repositoryId: repo, commitOid: commit, gitPath: 'docs/plan.md', blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 10 },
      evidence: { source: 'git', eventKey: `git:${commit}:docs/plan.md`, sessionId: null, operation: 'touched', certainty: 'unknown', eventAt: T(4) },
    }, T(4))

    // A worker observation of each location verified its repository identity.
    const merged = adoptProvisionalLocations(db, [
      { path: tracked.path, rootId: checkout.rootId, identity: { identityKind: 'repository', repositoryId: repo, rootId: null, relativePath: 'docs/plan.md' } },
      { path: fresh.path, rootId: checkout.rootId, identity: { identityKind: 'repository', repositoryId: repo, rootId: null, relativePath: 'notes.md' } },
    ], T(5))
    assert.equal(merged, 2)

    // Merge: the location, its legacy evidence and the retired ID all lead to the repository document.
    assert.equal(doc(db, tracked.id).document_id, target.documentId)
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM artifact_documents WHERE document_id = ?', provisionalId), 0)
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM artifact_evidence WHERE source = 'legacy' AND document_id = ?`, target.documentId), 1)
    assert.equal((db.raw.prepare('SELECT document_id FROM artifact_document_aliases WHERE alias_id = ?').get(provisionalId) as { document_id: string }).document_id, target.documentId)
    assert.equal(getArtifactDocument(db, provisionalId, { limit: 10, offset: 0 }).document.documentId, target.documentId)
    assert.equal((db.raw.prepare('SELECT root_id FROM artifacts WHERE artifact_id = ?').get(tracked.id) as { root_id: string }).root_id, checkout.rootId)

    // Upgrade in place: no repository document existed, so the provisional one takes the identity and keeps its ID.
    const up = doc(db, fresh.id)
    assert.equal(up.document_id, freshProvisional)
    assert.equal(up.identity_kind, 'repository')
    assert.equal(up.repository_id, repo)
    assert.equal(up.relative_path, 'notes.md')
    assert.equal(up.legacy_artifact_id, null)

    // Idempotent: nothing provisional is left to adopt.
    assert.equal(adoptProvisionalLocations(db, [{ path: tracked.path, rootId: checkout.rootId, identity: { identityKind: 'repository', repositoryId: repo, rootId: null, relativePath: 'docs/plan.md' } }], T(6)), 0)
  } finally {
    db.close()
  }
})
