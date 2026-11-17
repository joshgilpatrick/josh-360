import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrate, openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { upsertArtifact } from '../../src/db/artifacts.ts'
import { registerArtifactRoot } from '../../src/db/artifact-manager.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { startRouteServer } from '../helpers/server.ts'
import { tempDir } from '../helpers/tmp.ts'

// Migration 12 (PR #19 follow-up review, finding 2, ruling R91): commit 91f60d8 widened the PHI segment rule from `phi` to `phi` and
// `.phi`. Rows written before it were classified under the narrower rule, so the catalog must be reclassified once, at upgrade,
// raise-only. Synthetic metadata only: no file here exists and no content is read.

const T = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-27T12:00:00.000Z'
const HOME = '/home/u'
const closers: Array<() => Promise<void>> = []
after(async () => { for (const c of closers) await c() })

type Row = { is_sensitive: number }
type Doc = { protected: number }

/** A catalog exactly as code before 91f60d8 left it: PHI-looking `.phi` paths with both flags at 0. */
function atEleven(): { path: string; ids: { dotPhi: number; upperPhi: number; control: number; plainPhi: number; docDot: string; docUpper: string; docControl: string; docPlain: string; docRelOnly: string; docOther: string; rootPhi: string; rootOk: string } } {
  const path = join(tempDir('atlas-m12-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  migrate(db, MIGRATIONS.filter(m => m.id <= 11))
  const out = registerArtifactRoot(db, { kind: 'output', canonicalPath: `${HOME}/out`, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T)
  const rootPhi = registerArtifactRoot(db, { kind: 'output', canonicalPath: `${HOME}/.phi/exports`, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T)
  const loc = (p: string) => upsertArtifact(db, { path: p, sizeBytes: 1, createdAt: T, projectName: 'synthetic', now: T }).artifactId
  const doc = (id: string, rel: string, protectedFlag = 0) => db.raw.prepare(`INSERT INTO artifact_documents (document_id, identity_kind, identity_root_id, relative_path, display_name, extension, first_observed_at, protected) VALUES (?, 'root', ?, ?, ?, 'md', ?, ?)`)
    .run(id, out.rootId, rel, rel, T, protectedFlag)
  const link = (artifact: number, documentId: string) => db.raw.prepare('UPDATE artifacts SET document_id = ? WHERE artifact_id = ?').run(documentId, artifact)
  const ids = {
    dotPhi: loc(`${HOME}/proj/.phi/synthetic-report.md`), upperPhi: loc(`${HOME}/proj/.PHI/synthetic-report.md`), control: loc(`${HOME}/proj/Delphi/synthetic-report.md`), plainPhi: loc(`${HOME}/proj/phi/synthetic-report.md`),
    docDot: 'd0000000-0000-4000-8000-000000000001', docUpper: 'd0000000-0000-4000-8000-000000000002', docControl: 'd0000000-0000-4000-8000-000000000003',
    docPlain: 'd0000000-0000-4000-8000-000000000004', docRelOnly: 'd0000000-0000-4000-8000-000000000005', docOther: 'd0000000-0000-4000-8000-000000000006',
    rootPhi: rootPhi.rootId, rootOk: out.rootId,
  }
  doc(ids.docDot, 'proj/.phi/synthetic-report.md'); link(ids.dotPhi, ids.docDot)
  doc(ids.docUpper, 'proj/x.md'); link(ids.upperPhi, ids.docUpper) // the document path itself is fine: its location carries the segment
  doc(ids.docControl, 'proj/Delphi/synthetic-report.md'); link(ids.control, ids.docControl)
  doc(ids.docPlain, 'proj/phi/synthetic-report.md', 1); link(ids.plainPhi, ids.docPlain) // protected under the old rule already
  db.raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ?').run(ids.plainPhi)
  doc(ids.docRelOnly, 'archive/.Phi/synthetic-notes.md') // no location at all: a Git-only style document
  doc(ids.docOther, 'proj/ordinary.md', 1) // protected for another reason: never lowered
  db.close()
  return { path, ids }
}

const flags = (db: AtlasDb, artifact: number) => (db.raw.prepare('SELECT is_sensitive FROM artifacts WHERE artifact_id = ?').get(artifact) as Row).is_sensitive
const docFlag = (db: AtlasDb, id: string) => (db.raw.prepare('SELECT protected FROM artifact_documents WHERE document_id = ?').get(id) as Doc).protected
const rootFlag = (db: AtlasDb, id: string) => (db.raw.prepare('SELECT protected FROM artifact_roots WHERE root_id = ?').get(id) as Doc).protected

test('migration 12 is followed only by migration 13, named plainly, with an after step and no schema change', () => {
  const m = MIGRATIONS.find(x => x.id === 12)!
  assert.equal(m.name, 'phi-dot-folder-reclassify')
  assert.deepEqual(MIGRATIONS.filter(x => x.id > 12).map(x => x.id), [13])
  assert.equal(m.sql.trim(), '')
  assert.equal(typeof m.after, 'function')
  assert.equal(m.noForeignKeys, undefined)
})

test('upgrading a schema-11 catalog flags every .phi/.PHI location and document, leaves the control alone, never lowers, and a second migrate is a no-op', () => {
  const { path, ids } = atEleven()
  const old = openDatabase(path, { migrate: false })
  assert.equal(flags(old, ids.dotPhi), 0, 'precondition: the old classification left the flag at 0')
  assert.equal(docFlag(old, ids.docDot), 0)
  old.close()

  const db = openDatabase(path)
  assert.equal(flags(db, ids.dotPhi), 1)
  assert.equal(flags(db, ids.upperPhi), 1)
  assert.equal(flags(db, ids.plainPhi), 1)
  assert.equal(flags(db, ids.control), 0, 'Delphi is not PHI')
  assert.equal(docFlag(db, ids.docDot), 1)
  assert.equal(docFlag(db, ids.docUpper), 1, 'a document with a PHI location is protected')
  assert.equal(docFlag(db, ids.docRelOnly), 1, 'a document whose repository-relative path has a PHI segment is protected')
  assert.equal(docFlag(db, ids.docControl), 0)
  assert.equal(docFlag(db, ids.docPlain), 1)
  assert.equal(docFlag(db, ids.docOther), 1, 'protected for another reason: never lowered')
  assert.equal(rootFlag(db, ids.rootPhi), 1, 'a root registered inside a .phi folder is protected, as registration does today')
  assert.equal(rootFlag(db, ids.rootOk), 0)
  const snapshot = JSON.stringify([db.raw.prepare('SELECT artifact_id, is_sensitive FROM artifacts ORDER BY artifact_id').all(), db.raw.prepare('SELECT document_id, protected FROM artifact_documents ORDER BY document_id').all()])
  assert.equal(migrate(db), 0, 'a no-op the second time')
  assert.equal(JSON.stringify([db.raw.prepare('SELECT artifact_id, is_sensitive FROM artifacts ORDER BY artifact_id').all(), db.raw.prepare('SELECT document_id, protected FROM artifact_documents ORDER BY document_id').all()]), snapshot)
  assert.equal((db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  db.close()
})

test('the reclassification pages through the catalog (more rows than one page)', () => {
  const path = join(tempDir('atlas-m12-'), 'atlas.db')
  const db0 = openDatabase(path, { migrate: false })
  migrate(db0, MIGRATIONS.filter(m => m.id <= 11))
  const insert = db0.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, mime_type, size_bytes, created_at, project_name, exists_state, is_sensitive) VALUES (?, ?, 'md', 'document', 'text/markdown', 1, ?, 'synthetic', 'present', 0)`)
  db0.raw.exec('BEGIN')
  for (let i = 0; i < 2300; i++) insert.run(`${HOME}/p${i}/${i % 100 === 0 ? '.phi' : 'docs'}/n.md`, 'n.md', T)
  db0.raw.exec('COMMIT')
  db0.close()
  const db = openDatabase(path)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE is_sensitive = 1').get() as { n: number }).n, 23)
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE is_sensitive = 1 AND path NOT LIKE '%/.phi/%'`).get() as { n: number }).n, 0)
  db.close()
})

test('after the upgrade the default document list omits the PHI rows and the default detail answers as for a protected document', async () => {
  const { path, ids } = atEleven()
  const db = openDatabase(path)
  const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, home: HOME, now: () => NOW }))
  closers.push(async () => { await srv.close(); db.close() })
  const names = ((await (await fetch(`${srv.base}/api/artifact-documents`)).json()) as { rows: Array<{ documentId: string }> }).rows.map(r => r.documentId).sort()
  assert.deepEqual(names, [ids.docControl], 'only the non-PHI control is listed by default')
  for (const id of [ids.docDot, ids.docUpper, ids.docRelOnly]) {
    const res = await fetch(`${srv.base}/api/artifact-documents/${id}`)
    assert.equal(res.status, 404, id)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not-found')
  }
  assert.equal((await fetch(`${srv.base}/api/artifact-documents/${ids.docControl}`)).status, 200)
  assert.equal((await fetch(`${srv.base}/api/artifact-documents/${ids.docDot}?sensitive=show`)).status, 200)
})
