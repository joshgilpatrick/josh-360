import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openTestDb } from '../helpers/db.ts'
import { addLargeDocument, PRE_RELEASE_MISSING_COLUMNS, PRE_RELEASE_MISSING_INDEXES, toPreReleaseCatalog, type LargeDocumentShape } from '../helpers/artifact-large-document.ts'
import { migrate, openDatabase } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { addOrigin, ftsQuery, setExistsState, upsertArtifact } from '../../src/db/artifacts.ts'
import { adoptProvisionalLocations, backfillLegacyArtifacts } from '../../src/artifacts/backfill.ts'
import { seedBenchmark } from '../../scripts/seed-benchmark.ts'
import { ARTIFACT_MANAGER_TABLES, artifactDocumentAtRiskSql, artifactDocumentAvailabilitySql, refreshArtifactDocumentStateSql, refreshArtifactVersionRuleCopiesSql } from '../../src/db/migration-9-artifact-manager.ts'
import type { AtlasDb } from '../../src/db/database.ts'
import type { ArtifactDocumentIdentity, ArtifactEvidenceSource, ArtifactWorkerObservation } from '../../src/artifacts/contracts.ts'
import {
  ARTIFACT_JOB_PRIORITY, ArtifactDocumentNotFoundError, artifactDirectScopeId, claimArtifactJob, commitArtifactBatch, configureArtifactDocumentExtensions, enqueueArtifactJob, finishArtifactJob,
  coverageNoteKey, getArtifactDocument, getArtifactManagerStatus, getArtifactRemovalContext, getArtifactVersion, listArtifactCoverageNotes, listArtifactDocuments,
  listArtifactGitObjects, listArtifactRoots, parseCoverageNote, readArtifactCoverageNote, writeArtifactCoverageNote,
  listLegacyArtifactBackfill, recordArtifactEvidence, recordArtifactGitObjectChecks, recordArtifactObservation, registerArtifactRepository, registerArtifactRoot, retryArtifactJob,
  setArtifactDiscoveryPaused, type ArtifactDocumentFilters, type ArtifactRootRow, discardArtifactPlannerStatistics, findArtifactDocumentStateDrift, rebuildArtifactDocumentState,
  artifactCatalogShapeProblems, assertArtifactCatalogShape, adoptArtifactRepositoryIdentity, listRootIdentityLocations, mergeArtifactDocuments,
} from '../../src/db/artifact-manager.ts'

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10', S3 = '5c2d7e8f-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
/** Minute m past 12:00 on a fixed day. Every `now` passed below is at or after the event times it is given. */
const T = (m: number) => new Date(Date.UTC(2026, 9, 20, 12, m)).toISOString()
const NOW = T(59)
const OID = (c: string) => c.repeat(40)
const PAGE = { limit: 50, offset: 0 }

type Fx = { db: AtlasDb; repo: string; main: ArtifactRootRow; feat: ArtifactRootRow; out: ArtifactRootRow }

/** One repository with its main checkout and a linked worktree inside it, plus an unrelated output root. */
function fixture(): Fx {
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: '/home/u/repo', startedAt: T(0), now: T(0) })
  ensureSession(db, { sessionId: S2, cwd: '/home/u/repo/.worktrees/feat', startedAt: T(0), now: T(0) })
  const repo = registerArtifactRepository(db, { commonDir: '/home/u/repo/.git', displayName: 'repo', remoteIdentity: null }, T(0))
  const main = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/repo', repositoryId: repo, projectName: 'repo', checkoutIdentity: 'ck-main', protected: false, scopeFlags: ['checkout'] }, T(0))
  const feat = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/repo/.worktrees/feat', repositoryId: repo, projectName: 'repo', checkoutIdentity: 'ck-feat', protected: false, scopeFlags: ['checkout', 'session-cwd'] }, T(0))
  const out = registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/out', repositoryId: null, projectName: 'reports', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T(0))
  return { db, repo, main, feat, out }
}

const repoDoc = (repositoryId: string, relativePath: string): ArtifactDocumentIdentity => ({ identityKind: 'repository', repositoryId, rootId: null, relativePath })
const rootDoc = (rootId: string, relativePath: string): ArtifactDocumentIdentity => ({ identityKind: 'root', repositoryId: null, rootId, relativePath })

type Evidence = NonNullable<ArtifactWorkerObservation['evidence']>
type WorkingOpts = { at?: number; ino?: string; size?: number; observedAt?: number; captured?: number; evidence?: Partial<Evidence> & { eventKey: string }; git?: ArtifactWorkerObservation['git'] }

/**
 * A working-file observation whose write happened at minute `at` (mtime), observed (the row built) at minute 30 unless told
 * otherwise. `captured` is the minute the worker's lstat began; without it the row carries no capture time and binds no event.
 */
function working(root: ArtifactRootRow, identity: ArtifactDocumentIdentity, path: string, o: WorkingOpts = {}): ArtifactWorkerObservation {
  const at = o.at ?? 5
  const obs: ArtifactWorkerObservation = {
    rootId: root.rootId, identity, kind: 'working', observedAt: T(o.observedAt ?? 30), path, ...(o.captured !== undefined ? { capturedAt: T(o.captured) } : {}),
    stat: { dev: '1', ino: o.ino ?? '100', size: o.size ?? 10, mtimeMs: Date.parse(T(at)), ctimeMs: Date.parse(T(at)) },
  }
  if (o.git) obs.git = o.git
  if (o.evidence) obs.evidence = { source: 'hook', sessionId: null, operation: 'touched', certainty: 'unknown', eventAt: T(at), ...o.evidence }
  return obs
}

function commitObs(fx: Fx, rel: string, commit: string, blob: string, evidence?: Evidence): ArtifactWorkerObservation {
  const obs: ArtifactWorkerObservation = {
    rootId: fx.main.rootId, identity: repoDoc(fx.repo, rel), kind: 'commit', observedAt: T(30),
    git: { repositoryId: fx.repo, commitOid: commit, gitPath: rel, blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 12 },
  }
  if (evidence) obs.evidence = evidence
  return obs
}

function indexObs(fx: Fx, rel: string, blob: string, stage = 0): ArtifactWorkerObservation {
  return {
    rootId: fx.feat.rootId, identity: repoDoc(fx.repo, rel), kind: 'index', observedAt: T(30),
    git: { repositoryId: fx.repo, checkoutIdentity: 'ck-feat', gitPath: rel, blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 12, stage },
  }
}

function evidenceInput(root: ArtifactRootRow, identity: ArtifactDocumentIdentity, path: string, sourceKey: string, extra: { source?: ArtifactEvidenceSource; sessionId?: string | null; operation?: Evidence['operation']; certainty?: Evidence['certainty']; eventAt?: string; locator?: string } = {}) {
  return { rootId: root.rootId, path, identity, sourceKey, source: extra.source ?? 'hook', sessionId: extra.sessionId === undefined ? S1 : extra.sessionId, operation: extra.operation ?? 'created', certainty: extra.certainty ?? 'recorded', eventAt: extra.eventAt ?? T(1), ...(extra.locator !== undefined ? { locator: extra.locator } : {}) }
}

function count(db: AtlasDb, table: string, where = '1 = 1', ...params: Array<string | number | null>): number {
  return (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n
}
function row(db: AtlasDb, sql: string, ...params: Array<string | number | null>): Record<string, unknown> {
  const r = db.raw.prepare(sql).get(...params) as Record<string, unknown> | undefined
  assert.ok(r, `no row for ${sql}`)
  return { ...r }
}
function rows(db: AtlasDb, sql: string, ...params: Array<string | number | null>): Array<Record<string, unknown>> {
  return (db.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(r => ({ ...r }))
}
function ids(db: AtlasDb, filters: ArtifactDocumentFilters, page = PAGE): string[] {
  return listArtifactDocuments(db, filters, page).rows.map(r => r.displayName)
}

/** Enqueue, claim and fully apply one batch for a scope, the way the service runner drives a job. */
function runJob(db: AtlasDb, scopeId: string, taskKind: 'output-walk' | 'checkout-status' | 'direct-observation' | 'verify', observations: ArtifactWorkerObservation[], now: string): string {
  const jobId = enqueueArtifactJob(db, { scopeId, taskKind, priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, now)
  const job = claimArtifactJob(db, now)
  assert.equal(job?.jobId, jobId)
  commitArtifactBatch(db, jobId, job!.desiredGeneration, observations, { cursor: null, coverage: 'complete', complete: true }, now)
  finishArtifactJob(db, jobId, { complete: true, coverage: 'complete' }, now)
  return jobId
}

/** The COUNT and page SQL that listArtifactDocuments issues for `filters`, captured through a proxied connection. */
function listSql(db: AtlasDb, filters: ArtifactDocumentFilters): { count: string; page: string } {
  const seen: string[] = []
  const raw = new Proxy(db.raw, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => { seen.push(sql); return target.prepare(sql) }
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  listArtifactDocuments({ ...db, raw }, filters, PAGE)
  const count = seen.find(s => s.startsWith('SELECT COUNT(*) AS n FROM artifact_documents d'))
  const page = seen.find(s => s.includes('ORDER BY d.last_change_at DESC'))
  assert.ok(count && page, 'captured the count and page queries')
  return { count, page }
}
function plan(db: AtlasDb, sql: string): string[] {
  return (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(r => r.detail)
}

test('deduplicatesEvidenceByStableEventKey', () => {
  const fx = fixture(), { db, out } = fx
  const id = rootDoc(out.rootId, 'notes/plan.md'), path = '/home/u/out/notes/plan.md'
  // Events are delivered at minute 20; the worker's stat below is observed at minute 30.
  const first = recordArtifactEvidence(db, evidenceInput(out, id, path, 'hook:tool-1'), T(20))
  assert.equal(first.duplicate, false)
  const replay = recordArtifactEvidence(db, evidenceInput(out, id, path, 'hook:tool-1'), T(21))
  assert.deepEqual(replay, { documentId: first.documentId, duplicate: true }, 'event replay returns duplicate')
  assert.equal(count(db, 'artifact_evidence'), 1)

  // A different, concurrent event for the same file is separate evidence, not an overwrite. It was written after event 1 (minute 2
  // against minute 1): since R92 the latest write is shown by event time, not by delivery order, and equal times would be a tie.
  const other = recordArtifactEvidence(db, evidenceInput(out, id, path, 'hook:tool-2', { sessionId: S2, operation: 'modified', eventAt: T(2) }), T(20))
  assert.deepEqual(other, { documentId: first.documentId, duplicate: false })
  assert.equal(count(db, 'artifact_evidence'), 2)

  // The later stat (its lstat began at minute 25) names event 1 itself, so that one is bound by its key; of the pending events the
  // stat can be shown to describe, only the latest (event 2) binds. The worker replaying event 1 adds nothing.
  const v1 = recordArtifactObservation(db, working(out, id, path, { captured: 25, evidence: { eventKey: 'hook:tool-1' } }), NOW)
  assert.equal(v1.documentId, first.documentId)
  assert.equal(v1.duplicate, false, 'a new version was recorded')
  assert.equal(count(db, 'artifact_evidence'), 2)
  assert.equal(count(db, 'artifact_evidence', 'version_id = ?', v1.versionId), 2)

  // A changed file with a third event gets a second version; the first events keep their version.
  const v2 = recordArtifactObservation(db, working(out, id, path, { at: 20, size: 30, observedAt: 40, evidence: { eventKey: 'hook:tool-3', sessionId: S1, operation: 'modified', certainty: 'recorded' } }), NOW)
  assert.notEqual(v2.versionId, v1.versionId)
  assert.equal(count(db, 'artifact_evidence', 'version_id = ?', v1.versionId), 2, 'version provenance is not overwritten')
  assert.equal(row(db, `SELECT version_id FROM artifact_evidence WHERE source_key = 'hook:tool-3'`).version_id, v2.versionId)

  const again = recordArtifactObservation(db, working(out, id, path, { at: 20, size: 30, observedAt: 40, evidence: { eventKey: 'hook:tool-3', sessionId: S1, operation: 'modified', certainty: 'recorded' } }), NOW)
  assert.deepEqual({ ...again }, { documentId: first.documentId, artifactId: v2.artifactId, versionId: v2.versionId, duplicate: true })
  assert.equal(count(db, 'artifact_evidence'), 3)
  assert.equal(count(db, 'artifact_versions'), 2)
})

test('groupsLinkedWorktreePathsButKeepsVariants', () => {
  const fx = fixture(), { db, repo, main, feat } = fx
  const id = repoDoc(repo, 'docs/report.md')
  const a = recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/report.md', { ino: '1', size: 10 }), NOW)
  const b = recordArtifactObservation(db, working(feat, id, '/home/u/repo/.worktrees/feat/docs/report.md', { ino: '2', size: 20 }), NOW)
  assert.equal(a.documentId, b.documentId, 'one logical group across linked worktrees')
  assert.notEqual(a.artifactId, b.artifactId)
  assert.notEqual(a.versionId, b.versionId, 'differing contents stay separate variants')

  const list = listArtifactDocuments(db, {}, PAGE)
  assert.equal(list.total, 1)
  assert.equal(list.rows[0]!.locationCount, 2)
  assert.equal(list.rows[0]!.versionCount, 2)
  assert.equal(list.rows[0]!.projectName, 'repo')
  assert.equal(list.rows[0]!.availability, 'local')

  const detail = getArtifactDocument(db, a.documentId, PAGE)
  assert.deepEqual(detail.locations.map(l => l.path).sort(), ['/home/u/repo/.worktrees/feat/docs/report.md', '/home/u/repo/docs/report.md'])
  assert.deepEqual(detail.versions.map(v => [v.kind, v.current]), [['working', true], ['working', true]], 'both variants are current; neither is a backup of the other')

  // Committed snapshots join the same group; replaying a commit adds nothing; a second commit is a distinct version.
  const c1 = recordArtifactObservation(db, commitObs(fx, 'docs/report.md', OID('a'), OID('b')), NOW)
  assert.equal(c1.documentId, a.documentId)
  assert.equal(recordArtifactObservation(db, commitObs(fx, 'docs/report.md', OID('a'), OID('b')), NOW).duplicate, true)
  recordArtifactObservation(db, commitObs(fx, 'docs/report.md', OID('c'), OID('b')), NOW)
  assert.equal(listArtifactDocuments(db, {}, PAGE).rows[0]!.versionCount, 4, 'equal bytes in two commits keep distinct provenance')
})

test('versionDetailLinksAWorkingVersionToItsLocationAndNoOtherKind', () => {
  const fx = fixture(), { db, repo, main, feat } = fx
  const id = repoDoc(repo, 'docs/report.md')
  const a = recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/report.md', { ino: '1', size: 10 }), NOW)
  const b = recordArtifactObservation(db, working(feat, id, '/home/u/repo/.worktrees/feat/docs/report.md', { ino: '2', size: 20 }), NOW)
  const c = recordArtifactObservation(db, commitObs(fx, 'docs/report.md', OID('a'), OID('b')), NOW)
  const i = recordArtifactObservation(db, indexObs(fx, 'docs/report.md', OID('c')), NOW)
  assert.equal(getArtifactVersion(db, a.versionId!)!.locationArtifactId, a.artifactId, 'a working version names the location it was observed at')
  assert.equal(getArtifactVersion(db, b.versionId!)!.locationArtifactId, b.artifactId)
  assert.notEqual(a.artifactId, b.artifactId)
  assert.equal(getArtifactVersion(db, c.versionId!)!.locationArtifactId, null, 'a commit snapshot has no local location')
  assert.equal(getArtifactVersion(db, i.versionId!)!.locationArtifactId, null, 'nor does a staged snapshot')
  const detail = getArtifactDocument(db, a.documentId, PAGE)
  const byId = new Map(detail.versions.map(v => [v.versionId, v.locationArtifactId]))
  assert.deepEqual([byId.get(a.versionId!), byId.get(b.versionId!), byId.get(c.versionId!), byId.get(i.versionId!)], [a.artifactId, b.artifactId, null, null], 'the detail page carries the same links')
  assert.ok(detail.locations.every(l => [a.artifactId, b.artifactId].includes(l.artifactId)), 'every linked ID is one of the listed locations')
})

test('doesNotMergeIndependentClones', () => {
  const fx = fixture(), { db, repo, main, out } = fx
  const clone = registerArtifactRepository(db, { commonDir: '/home/u/clone/.git', displayName: 'repo', remoteIdentity: 'github.com/u/repo' }, T(0))
  assert.notEqual(clone, repo)
  assert.equal(registerArtifactRepository(db, { commonDir: '/home/u/clone/.git', displayName: 'repo', remoteIdentity: null }, T(1)), clone, 'repository IDs are stable per common directory')
  const cloneRoot = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/clone', repositoryId: clone, projectName: 'repo', checkoutIdentity: 'ck-clone', protected: false, scopeFlags: ['checkout'] }, T(0))
  const other = registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/other-out', repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T(0))

  const same = { ino: '7', size: 10, at: 5 }
  const inRepo = recordArtifactObservation(db, working(main, repoDoc(repo, 'docs/report.md'), '/home/u/repo/docs/report.md', same), NOW)
  const inClone = recordArtifactObservation(db, working(cloneRoot, repoDoc(clone, 'docs/report.md'), '/home/u/clone/docs/report.md', same), NOW)
  const outA = recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'a.csv'), '/home/u/out/a.csv', same), NOW)
  const outB = recordArtifactObservation(db, working(other, rootDoc(other.rootId, 'a.csv'), '/home/u/other-out/a.csv', same), NOW)
  const unrelated = recordArtifactObservation(db, working(main, repoDoc(repo, 'docs/other/report.md'), '/home/u/repo/docs/other/report.md', same), NOW)
  const docs = new Set([inRepo, inClone, outA, outB, unrelated].map(r => r.documentId))
  assert.equal(docs.size, 5, 'clones, unrelated roots and unrelated paths never merge')
  assert.equal(listArtifactDocuments(db, {}, PAGE).total, 5)
})

test('unchangedBatchDoesNotChurn', () => {
  const fx = fixture(), { db, out } = fx
  const batch = [
    working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md', { ino: '1' }),
    working(out, rootDoc(out.rootId, 'b.csv'), '/home/u/out/b.csv', { ino: '2' }),
    working(out, rootDoc(out.rootId, 'sub/c.json'), '/home/u/out/sub/c.json', { ino: '3' }),
  ]
  runJob(db, out.rootId, 'output-walk', batch, T(31))
  const snapshot = () => ({
    artifacts: rows(db, 'SELECT * FROM artifacts ORDER BY artifact_id'),
    documents: rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'),
    versions: rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'),
    states: rows(db, 'SELECT * FROM artifact_version_state ORDER BY version_id'),
    evidence: rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'),
  })
  const before = snapshot()
  assert.equal(before.versions.length, 3)
  assert.equal(row(db, 'SELECT last_successful_at FROM artifact_roots WHERE root_id = ?', out.rootId).last_successful_at, T(31))

  // A later periodic scan sees identical signatures: only the root checkpoint moves.
  runJob(db, out.rootId, 'output-walk', batch.map(o => ({ ...o, observedAt: T(45) })), T(46))
  assert.deepEqual(snapshot(), before, 'no versions, evidence, activity or per-file verification churn')
  const root = listArtifactRoots(db).find(r => r.rootId === out.rootId)!
  assert.equal(root.lastSuccessfulAt, T(46))
  assert.equal(root.appliedGeneration, 2)
  assert.equal(root.coverageState, 'idle')

  // An explicit verification pass may refresh verification timestamps, still without new versions.
  runJob(db, out.rootId, 'verify', batch.map(o => ({ ...o, observedAt: T(50) })), T(50))
  assert.equal(count(db, 'artifact_versions'), 3)
  assert.equal(count(db, 'artifacts', 'last_verified_at = ?', T(50)), 3)
})

test('commitsBatchAndCheckpointAtomically', () => {
  const fx = fixture(), { db, out } = fx
  const jobId = enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(1))
  const job = claimArtifactJob(db, T(2))!
  assert.equal(listArtifactRoots(db).find(r => r.rootId === out.rootId)!.coverageState, 'scanning')
  const good = working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md')
  const bad = { ...indexObs(fx, 'x.md', OID('d')), git: { ...indexObs(fx, 'x.md', OID('d')).git!, stage: undefined } } as ArtifactWorkerObservation

  assert.throws(() => commitArtifactBatch(db, jobId, job.desiredGeneration, [good, bad], { cursor: 'frontier-1', coverage: 'partial', complete: false }, T(3)), /row 1/)
  assert.equal(count(db, 'artifacts'), 0, 'the valid row rolled back with the invalid one')
  assert.equal(count(db, 'artifact_documents'), 0)
  assert.equal(row(db, 'SELECT cursor FROM artifact_jobs WHERE job_id = ?', jobId).cursor, null, 'the checkpoint rolled back with the rows')
  assert.equal(row(db, 'SELECT cursor FROM artifact_roots WHERE root_id = ?', out.rootId).cursor, null)

  commitArtifactBatch(db, jobId, job.desiredGeneration, [good], { cursor: 'frontier-1', coverage: 'partial', complete: false }, T(3))
  assert.equal(count(db, 'artifacts'), 1)
  assert.equal(row(db, 'SELECT cursor FROM artifact_jobs WHERE job_id = ?', jobId).cursor, 'frontier-1')
  assert.equal(row(db, 'SELECT cursor FROM artifact_roots WHERE root_id = ?', out.rootId).cursor, 'frontier-1')

  // A slice boundary is not the end of the scan: the job requeues and resumes from its cursor.
  finishArtifactJob(db, jobId, { complete: false, coverage: 'partial' }, T(4))
  assert.equal(listArtifactRoots(db).find(r => r.rootId === out.rootId)!.coverageState, 'partial')
  assert.throws(() => commitArtifactBatch(db, jobId, 1, [good], { cursor: null, coverage: 'complete', complete: true }, T(5)), /not running/)
  const resumed = claimArtifactJob(db, T(5))!
  assert.equal(resumed.jobId, jobId)
  assert.equal(resumed.cursor, 'frontier-1')
  commitArtifactBatch(db, jobId, resumed.desiredGeneration, [], { cursor: null, coverage: 'complete', complete: true }, T(6))
  finishArtifactJob(db, jobId, { complete: true, coverage: 'complete' }, T(6))
  const root = listArtifactRoots(db).find(r => r.rootId === out.rootId)!
  assert.deepEqual([root.coverageState, root.cursor, root.lastSuccessfulAt, root.appliedGeneration], ['idle', null, T(6), 1])
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', jobId).state, 'done')
})

test('paginatesUniqueDocumentsInSql', () => {
  const fx = fixture(), { db, repo, main, feat, out } = fx
  const seen = (root: ArtifactRootRow, identity: ArtifactDocumentIdentity, path: string, at: number, ev?: Partial<Evidence> & { eventKey: string }) =>
    recordArtifactObservation(db, working(root, identity, path, { at, ino: path, ...(ev ? { evidence: ev } : {}) }), NOW)
  const alpha = repoDoc(repo, 'docs/alpha.md')
  seen(main, alpha, '/home/u/repo/docs/alpha.md', 1, { eventKey: 'a1', sessionId: S1, operation: 'created', certainty: 'recorded' })
  seen(feat, alpha, '/home/u/repo/.worktrees/feat/docs/alpha.md', 10, { eventKey: 'a2', source: 'transcript', sessionId: S2, operation: 'modified', certainty: 'inferred' })
  seen(out, rootDoc(out.rootId, 'beta.csv'), '/home/u/out/beta.csv', 2, { eventKey: 'b1', sessionId: S1, operation: 'created', certainty: 'recorded' })
  seen(out, rootDoc(out.rootId, 'gamma.html'), '/home/u/out/gamma.html', 3)
  recordArtifactObservation(db, commitObs(fx, 'db/schema.sql', OID('e'), OID('f'), { source: 'git', eventKey: 'g1', sessionId: null, operation: 'created', certainty: 'recorded', eventAt: T(4) }), NOW)
  seen(out, rootDoc(out.rootId, 'data.json'), '/home/u/out/data.json', 5, { eventKey: 'e1', sessionId: S2, operation: 'created', certainty: 'recorded' })
  seen(out, rootDoc(out.rootId, 'script.ts'), '/home/u/out/script.ts', 6, { eventKey: 'f1', sessionId: S1, operation: 'created', certainty: 'recorded' })
  seen(out, rootDoc(out.rootId, 'phi/patients.csv'), '/home/u/out/phi/patients.csv', 7, { eventKey: 'p1', sessionId: S1, operation: 'created', certainty: 'recorded' })

  const all = listArtifactDocuments(db, {}, PAGE)
  assert.deepEqual(all.rows.map(r => r.displayName), ['alpha.md', 'data.json', 'schema.sql', 'gamma.html', 'beta.csv'], 'documents only, protected hidden, most recent activity first')
  assert.equal(all.total, 5)
  assert.ok(all.coverage && typeof all.coverage.paused === 'boolean', 'coverage metadata rides along')
  const paged = [0, 2, 4].flatMap(offset => {
    const p = listArtifactDocuments(db, {}, { limit: 2, offset })
    assert.equal(p.total, 5)
    assert.ok(p.rows.length <= 2)
    return p.rows.map(r => r.documentId)
  })
  assert.deepEqual(paged, all.rows.map(r => r.documentId), 'stable, non-overlapping pages')

  const a = all.rows[0]!
  assert.deepEqual([a.locationCount, a.versionCount, a.activityAt, a.activitySource, a.extension], [2, 2, T(10), 'transcript', 'md'])
  assert.deepEqual(a.sessionAssociations, [{ sessionId: S1, certainty: 'recorded' }, { sessionId: S2, certainty: 'inferred' }])
  assert.equal(all.rows[3]!.activitySource, 'mtime', 'a scan-only discovery falls back to its file time, labelled as such')

  assert.deepEqual(ids(db, { types: 'all' }), ['alpha.md', 'script.ts', 'data.json', 'schema.sql', 'gamma.html', 'beta.csv'])
  assert.deepEqual(ids(db, { sensitive: 'only' }), ['patients.csv'])
  assert.equal(listArtifactDocuments(db, { sensitive: 'show' }, PAGE).total, 6)
  assert.deepEqual(ids(db, { extension: 'CSV' }), ['beta.csv'])
  assert.deepEqual(ids(db, { extension: '.csv' }), ['beta.csv'])
  assert.deepEqual(ids(db, { project: 'reports' }), ['data.json', 'gamma.html', 'beta.csv'])
  assert.deepEqual(ids(db, { project: 'repo' }), ['alpha.md', 'schema.sql'])
  assert.deepEqual(ids(db, { sessionId: S1 }), ['alpha.md', 'beta.csv'], 'a document with two sessions is returned once')
  assert.deepEqual(ids(db, { sessionId: S2 }), ['alpha.md', 'data.json'])
  assert.equal(listArtifactDocuments(db, { sessionId: S1 }, { limit: 1, offset: 0 }).total, 2)
  assert.deepEqual(ids(db, { from: T(4), to: T(5) }), ['data.json', 'schema.sql'])
  assert.deepEqual(ids(db, { q: 'alpha' }), ['alpha.md'])
  assert.deepEqual(ids(db, { q: 'schema' }), ['schema.sql'], 'Git-only documents are searchable by path')
  assert.deepEqual(ids(db, { source: 'transcript' }), ['alpha.md'])
  assert.deepEqual(ids(db, { availability: 'git' }), ['schema.sql'])
  assert.deepEqual(ids(db, { availability: 'local' }), ['alpha.md', 'data.json', 'gamma.html', 'beta.csv'])
  assert.deepEqual(ids(db, { needsPreservation: true }), ['alpha.md', 'data.json', 'gamma.html', 'beta.csv'], 'uncommitted working versions of unknown preservation')
  assert.deepEqual(ids(db, { needsPreservation: false }), ['schema.sql'])
  assert.equal(listArtifactDocuments(db, {}, { limit: 100_000, offset: -3 }).limit, 500, 'limit is clamped')

  // The document set follows configuration; an unusable list falls back to the default set.
  configureArtifactDocumentExtensions(['.TS', 'md', '../bad'])
  try {
    assert.deepEqual(ids(db, {}), ['alpha.md', 'script.ts'])
  } finally {
    configureArtifactDocumentExtensions([])
  }
  assert.equal(listArtifactDocuments(db, {}, PAGE).total, 5)
})

test('sessionDeletionPreservesDocumentEvidence', () => {
  const fx = fixture(), { db, out } = fx
  const id = rootDoc(out.rootId, 'deliverables/summary.md'), path = '/home/u/out/deliverables/summary.md'
  const r = recordArtifactObservation(db, working(out, id, path, { evidence: { eventKey: 'hook:del', sessionId: S1, operation: 'created', certainty: 'recorded' } }), NOW)
  assert.equal(count(db, 'artifact_origins', 'session_id = ?', S1), 1)
  db.raw.prepare('DELETE FROM sessions WHERE session_id = ?').run(S1)
  assert.equal(count(db, 'artifact_documents', 'document_id = ?', r.documentId), 1)
  assert.equal(count(db, 'artifact_versions', 'version_id = ?', r.versionId), 1)
  assert.equal(count(db, 'artifacts', 'artifact_id = ?', r.artifactId), 1)
  assert.deepEqual(row(db, `SELECT session_id, source, operation, certainty FROM artifact_evidence WHERE source_key = 'hook:del'`), { session_id: null, source: 'hook', operation: 'created', certainty: 'recorded' })
  const listed = listArtifactDocuments(db, {}, PAGE)
  assert.equal(listed.total, 1)
  assert.deepEqual(listed.rows[0]!.sessionAssociations, [])
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
})

test('commit and index snapshots persist without fabricated filesystem stats', () => {
  const fx = fixture(), { db } = fx
  const c = recordArtifactObservation(db, commitObs(fx, 'docs/spec.md', OID('1'), OID('2')), NOW)
  assert.equal(c.artifactId, null)
  assert.deepEqual(row(db, 'SELECT kind, location_artifact_id, stat_signature, observation_revision, commit_oid, git_path, object_format, blob_oid FROM artifact_versions WHERE version_id = ?', c.versionId),
    { kind: 'commit', location_artifact_id: null, stat_signature: null, observation_revision: null, commit_oid: OID('1'), git_path: 'docs/spec.md', object_format: 'sha1', blob_oid: OID('2') })
  assert.equal(count(db, 'artifacts'), 0, 'no local location is invented for a Git snapshot')

  const i1 = recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('3')), NOW)
  assert.equal(i1.documentId, c.documentId)
  assert.deepEqual(row(db, 'SELECT commit_oid, stat_signature, observation_revision, index_stage, checkout_identity FROM artifact_versions WHERE version_id = ?', i1.versionId),
    { commit_oid: null, stat_signature: null, observation_revision: 1, index_stage: 0, checkout_identity: 'ck-feat' })
  assert.equal(recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('3')), NOW).duplicate, true, 'an unchanged index entry creates no revision')
  const i2 = recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('4')), NOW)
  assert.equal(row(db, 'SELECT observation_revision FROM artifact_versions WHERE version_id = ?', i2.versionId).observation_revision, 2)
  assert.equal(getArtifactVersion(db, i1.versionId!)!.current, false)
  assert.equal(getArtifactVersion(db, i1.versionId!)!.availability, 'last-known', 'a superseded staged blob is not claimed as available')
  assert.equal(getArtifactVersion(db, i2.versionId!)!.current, true)
  assert.equal(getArtifactVersion(db, 'nope'), null)

  assert.throws(() => recordArtifactObservation(db, { ...commitObs(fx, 'docs/spec.md', OID('5'), OID('6')), path: '/home/u/repo/docs/spec.md' }, NOW), /commit/)
  assert.throws(() => recordArtifactObservation(db, commitObs(fx, 'docs/spec.md', 'HEAD', OID('6')), NOW), /OID/)
  assert.throws(() => recordArtifactObservation(db, { ...indexObs(fx, 'docs/spec.md', OID('7')), identity: rootDoc(fx.out.rootId, 'docs/spec.md') }, NOW), /repository/)
})

test('event-only evidence creates a pending location and the later stat attaches its version', () => {
  const fx = fixture(), { db, out } = fx
  const id = rootDoc(out.rootId, 'draft.md'), path = '/home/u/out/draft.md'
  const e = recordArtifactEvidence(db, evidenceInput(out, id, path, 'hook:pending', { locator: 'tool_use:toolu_01', eventAt: T(19) }), T(20))
  const loc = row(db, 'SELECT artifact_id, document_id, root_id, exists_state, verification_state, last_verified_at, size_bytes, current_version_id FROM artifacts WHERE path = ?', path)
  assert.deepEqual({ ...loc, artifact_id: 0 }, { artifact_id: 0, document_id: e.documentId, root_id: out.rootId, exists_state: 'present', verification_state: 'pending', last_verified_at: null, size_bytes: null, current_version_id: null })
  assert.deepEqual(row(db, `SELECT version_id, artifact_id, source_locator FROM artifact_evidence WHERE source_key = 'hook:pending'`), { version_id: null, artifact_id: loc.artifact_id, source_locator: 'tool_use:toolu_01' })
  assert.equal(listArtifactDocuments(db, {}, PAGE).rows[0]!.availability, 'stale', 'a reported but not yet verified path is not claimed as local')

  // A scan slice that stat'ed the file before the event was delivered does not claim the event's version.
  const early = recordArtifactObservation(db, working(out, id, path, { at: 2, observedAt: 10, captured: 9 }), NOW)
  assert.equal(early.artifactId, loc.artifact_id)
  assert.equal(row(db, `SELECT version_id FROM artifact_evidence WHERE source_key = 'hook:pending'`).version_id, null)

  const obs = recordArtifactObservation(db, working(out, id, path, { at: 2, captured: 25 }), NOW)
  assert.equal(obs.versionId, early.versionId, 'same signature, same version')
  assert.equal(obs.duplicate, false, 'attaching the pending event is new information')
  assert.equal(row(db, `SELECT version_id FROM artifact_evidence WHERE source_key = 'hook:pending'`).version_id, obs.versionId)
  assert.deepEqual(row(db, 'SELECT verification_state, size_bytes, last_verified_at FROM artifacts WHERE path = ?', path), { verification_state: 'verified', size_bytes: 10, last_verified_at: T(10) })
  assert.equal(listArtifactDocuments(db, {}, PAGE).rows[0]!.availability, 'local')
})

test('compatibility origins: only recorded creations project as creator and legacy rows are never rewritten (R15)', () => {
  const fx = fixture(), { db, out } = fx
  const ev = (rel: string, key: string, extra: Parameters<typeof evidenceInput>[4]) => recordArtifactEvidence(db, evidenceInput(out, rootDoc(out.rootId, rel), `/home/u/out/${rel}`, key, extra), NOW)
  const origin = (rel: string) => rows(db, 'SELECT o.session_id, o.relation, o.detected_via FROM artifact_origins o JOIN artifacts a ON a.artifact_id = o.artifact_id WHERE a.path = ? ORDER BY o.session_id', `/home/u/out/${rel}`)

  ev('a.md', 'k1', { source: 'hook', sessionId: S1, operation: 'created', certainty: 'recorded' })
  ev('a.md', 'k2', { source: 'transcript', sessionId: S2, operation: 'modified', certainty: 'recorded' })
  assert.deepEqual(origin('a.md'), [{ session_id: S1, relation: 'creator', detected_via: 'tool_event' }, { session_id: S2, relation: 'reference', detected_via: 'tool_event' }])
  ev('b.md', 'k3', { source: 'watcher', sessionId: S1, operation: 'created', certainty: 'inferred' })
  assert.deepEqual(origin('b.md'), [{ session_id: S1, relation: 'reference', detected_via: 'watcher' }], 'an inferred creation is not a creator')
  ev('c.md', 'k4', { source: 'reconcile', sessionId: S1, operation: 'touched', certainty: 'unknown' })
  ev('d.md', 'k5', { source: 'git', sessionId: S1, operation: 'created', certainty: 'recorded' })
  assert.deepEqual(origin('c.md'), [{ session_id: S1, relation: 'reference', detected_via: 'reconcile' }])
  assert.deepEqual(origin('d.md'), [{ session_id: S1, relation: 'creator', detected_via: 'reconcile' }])
  ev('e.md', 'k6', { source: 'legacy', sessionId: S1, operation: 'created', certainty: 'inferred' })
  ev('f.md', 'k7', { source: 'hook', sessionId: null, operation: 'created', certainty: 'recorded' })
  assert.deepEqual(origin('e.md'), [], 'legacy evidence is never re-projected')
  assert.deepEqual(origin('f.md'), [], 'evidence without a session projects nothing')

  const legacy = upsertArtifact(db, { path: '/home/u/out/g.md', sizeBytes: 1, createdAt: T(0), projectName: 'reports', now: T(0) })
  addOrigin(db, legacy.artifactId, S1, 'reference', 'watcher', T(0))
  const before = rows(db, 'SELECT * FROM artifact_origins WHERE artifact_id = ?', legacy.artifactId)
  const g = ev('g.md', 'k8', { source: 'hook', sessionId: S1, operation: 'created', certainty: 'recorded' })
  assert.deepEqual(rows(db, 'SELECT * FROM artifact_origins WHERE artifact_id = ?', legacy.artifactId), before, 'an existing origin is not upgraded')
  assert.equal(row(db, 'SELECT document_id FROM artifacts WHERE artifact_id = ?', legacy.artifactId).document_id, g.documentId, 'the legacy location is linked to its document')
})

test('direct observations get one job per exact file and the row is removed once applied (R7)', () => {
  const fx = fixture(), { db, out, main } = fx
  const scopeA = artifactDirectScopeId(out.rootId, '/home/u/out/a.md'), scopeB = artifactDirectScopeId(out.rootId, '/home/u/out/b.md')
  assert.equal(scopeA, `direct:${out.rootId}:/home/u/out/a.md`)
  const a = enqueueArtifactJob(db, { scopeId: scopeA, taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, T(1))
  const b = enqueueArtifactJob(db, { scopeId: scopeB, taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, T(2))
  assert.notEqual(a, b, 'distinct files are not coalesced')
  assert.equal(enqueueArtifactJob(db, { scopeId: scopeA, taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, T(2)), a, 'the same file coalesces')
  assert.equal(count(db, 'artifact_jobs'), 2)
  const job = claimArtifactJob(db, T(3))!
  assert.equal(job.jobId, a)
  commitArtifactBatch(db, a, job.desiredGeneration, [working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md')], { cursor: null, coverage: 'complete', complete: true }, T(3))
  finishArtifactJob(db, a, { complete: true, coverage: 'complete' }, T(3))
  assert.equal(count(db, 'artifact_jobs', 'job_id = ?', a), 0, 'an applied direct observation leaves no row behind')
  assert.equal(count(db, 'artifact_jobs', 'job_id = ?', b), 1)
  assert.equal(claimArtifactJob(db, T(3))!.jobId, b)
  finishArtifactJob(db, b, { complete: false, coverage: 'inaccessible', error: 'ENOENT' }, T(3))
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', b).state, 'failed', 'a failed direct observation stays inspectable')

  const status = runJob(db, main.rootId, 'checkout-status', [], T(4))
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', status).state, 'done', 'other task kinds keep their row')
})

test('claims due jobs by priority, then oldest first, honouring retry time, lease expiry and pause (R14)', () => {
  const fx = fixture(), { db, out, main } = fx
  assert.deepEqual(ARTIFACT_JOB_PRIORITY, { direct: 0, dirty: 10, recovery: 20, verify: 30, backfill: 40 })
  /** Second s past 12:05, so the one-minute lease is still live until s = 60 after a claim at s = 0. */
  const at = (s: number) => new Date(Date.UTC(2026, 9, 20, 12, 5, s)).toISOString()
  const backfill = enqueueArtifactJob(db, { scopeId: 'legacy', taskKind: 'legacy-backfill', priority: ARTIFACT_JOB_PRIORITY.backfill, generation: 1 }, at(1))
  const walk = enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, at(2))
  const status = enqueueArtifactJob(db, { scopeId: main.rootId, taskKind: 'checkout-status', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, at(3))
  const direct = enqueueArtifactJob(db, { scopeId: artifactDirectScopeId(out.rootId, '/home/u/out/a.md'), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, at(4))

  setArtifactDiscoveryPaused(db, true, at(5))
  assert.equal(claimArtifactJob(db, at(5)), null, 'paused discovery claims nothing')
  assert.equal(getArtifactManagerStatus(db, at(5)).paused, true)
  setArtifactDiscoveryPaused(db, false, at(5))
  assert.equal(getArtifactManagerStatus(db, at(5)).paused, false)

  const first = claimArtifactJob(db, at(5))!
  assert.deepEqual([first.jobId, first.state, first.attempts, first.taskKind], [direct, 'running', 1, 'direct-observation'])
  assert.ok(first.leaseUntil! > at(5))
  assert.equal(claimArtifactJob(db, at(5))!.jobId, walk, 'equal priority: the older job first')
  finishArtifactJob(db, walk, { complete: false, coverage: 'partial' }, at(6))
  assert.equal(claimArtifactJob(db, at(7))!.jobId, status, 'a yielded slice goes behind waiting work of the same priority')
  retryArtifactJob(db, status, 'git-timeout', at(20), at(7))
  assert.equal(claimArtifactJob(db, at(8))!.jobId, walk)
  assert.equal(claimArtifactJob(db, at(8))!.jobId, backfill)
  assert.equal(claimArtifactJob(db, at(8)), null, 'a retry is not due before its retry time and live leases are held')
  const retried = claimArtifactJob(db, at(20))!
  assert.deepEqual([retried.jobId, retried.attempts, retried.retryAt], [status, 2, null])
  const expired = claimArtifactJob(db, at(66))!
  assert.equal(expired.jobId, direct, 'an expired lease makes a running job due again')
  assert.equal(expired.attempts, 2)
})

test('enqueue coalesces by generation and an event during a run schedules exactly one more pass', () => {
  const fx = fixture(), { db, out } = fx
  const job = enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(1))
  assert.equal(enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 1 }, T(2)), job)
  assert.deepEqual(row(db, 'SELECT desired_generation, priority, updated_at FROM artifact_jobs WHERE job_id = ?', job), { desired_generation: 1, priority: 10, updated_at: T(1) },
    'a waiting job keeps its place in line and takes the more urgent priority')
  assert.equal(listArtifactRoots(db).find(r => r.rootId === out.rootId)!.coverageState, 'queued')

  const claimed = claimArtifactJob(db, T(3))!
  enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 1 }, T(4))
  enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 1 }, T(4))
  commitArtifactBatch(db, job, claimed.desiredGeneration, [], { cursor: null, coverage: 'complete', complete: true }, T(5))
  finishArtifactJob(db, job, { complete: true, coverage: 'complete' }, T(5))
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', job).state, 'queued', 'events during the run guarantee another pass')
  const second = claimArtifactJob(db, T(6))!
  assert.ok(second.desiredGeneration > claimed.desiredGeneration)
  commitArtifactBatch(db, job, second.desiredGeneration, [], { cursor: null, coverage: 'complete', complete: true }, T(7))
  finishArtifactJob(db, job, { complete: true, coverage: 'complete' }, T(7))
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', job).state, 'done')
  const root = listArtifactRoots(db).find(r => r.rootId === out.rootId)!
  assert.equal(root.appliedGeneration, root.desiredGeneration)

  assert.throws(() => commitArtifactBatch(db, job, 1, [], { cursor: null, coverage: 'complete', complete: true }, T(8)), /not running/)
  enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(9))
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', job).state, 'queued', 'new activity requeues a finished scope')
  const third = claimArtifactJob(db, T(10))!
  finishArtifactJob(db, job, { complete: false, coverage: 'inaccessible', error: 'permission denied at /home/u/out/private' }, T(10))
  assert.equal(row(db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', third.jobId).state, 'failed')
  assert.equal(listArtifactRoots(db).find(r => r.rootId === out.rootId)!.coverageState, 'inaccessible')
})

test('manager status is redacted and reports pending work, ages and pause state', () => {
  const fx = fixture(), { db, out } = fx
  const job = enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(1))
  claimArtifactJob(db, T(1))
  commitArtifactBatch(db, job, 1, [], { cursor: '/home/u/out/deep/dir', coverage: 'partial', complete: false }, T(2))
  retryArtifactJob(db, job, 'walk-error', T(9), T(4))
  const direct = enqueueArtifactJob(db, { scopeId: artifactDirectScopeId(out.rootId, '/home/u/out/x.md'), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, T(4))

  const status = getArtifactManagerStatus(db, T(5))
  assert.equal(status.paused, false)
  assert.equal(status.pendingJobs, 2)
  assert.equal(status.oldestQueueAgeMs, 60_000)
  const root = status.roots.find(r => r.rootId === out.rootId)!
  assert.equal(root.state, 'queued')
  assert.equal(root.reason, 'walk-error')
  assert.equal(root.oldestQueuedAgeMs, 60_000)
  assert.ok(root.cursor !== null && !root.cursor.includes('/home'), 'cursor progress is shown without its path')
  assert.equal(status.roots.length, 3)
  assert.equal(status.roots.find(r => r.rootId === fx.main.rootId)!.oldestQueuedAgeMs, 0)

  assert.equal(claimArtifactJob(db, T(9))!.jobId, direct)
  const failing = claimArtifactJob(db, T(9))!
  assert.equal(failing.jobId, job)
  finishArtifactJob(db, failing.jobId, { complete: false, coverage: 'partial', error: 'EACCES: /home/u/out/secret/file.md' }, T(9))
  const reason = getArtifactManagerStatus(db, T(9)).roots.find(r => r.rootId === out.rootId)!.reason!
  assert.ok(!reason.includes('/home'), `status reason is redacted: ${reason}`)
  assert.equal(JSON.stringify(getArtifactManagerStatus(db, T(9))).includes('/home/u'), false)
})

test('removal context is separator-aware, SELECT-only and works on a read-only handle', () => {
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: '/a/b/sub', startedAt: T(0), now: T(0) })
  ensureSession(db, { sessionId: S2, cwd: '/a/bc', startedAt: T(0), now: T(0) })
  ensureSession(db, { sessionId: S3, cwd: '/a/b', startedAt: T(0), now: T(0) })
  const reg = (path: string, prot = false) => registerArtifactRoot(db, { kind: 'output', canonicalPath: path, repositoryId: null, projectName: null, checkoutIdentity: null, protected: prot, scopeFlags: ['cli-output'] }, T(0))
  const outer = reg('/a'), b = reg('/a/b'), bc = reg('/a/bc'), docs = reg('/a/b/docs', true)
  recordArtifactObservation(db, working(b, rootDoc(b.rootId, 'x.md'), '/a/b/x.md'), NOW)
  recordArtifactObservation(db, working(bc, rootDoc(bc.rootId, 'y.md'), '/a/bc/y.md'), NOW)
  recordArtifactObservation(db, working(docs, rootDoc(docs.rootId, 'z.md'), '/a/b/docs/z.md'), NOW)
  recordArtifactObservation(db, working(outer, rootDoc(outer.rootId, 'b.md'), '/a/b.md'), NOW)

  const ro = new DatabaseSync(db.path, { readOnly: true })
  try {
    const ctx = getArtifactRemovalContext({ raw: ro }, '/a/b')
    assert.deepEqual(ctx.roots.map(r => r.canonicalPath), ['/a', '/a/b', '/a/b/docs'], 'containing and contained roots, never the sibling /a/bc')
    assert.deepEqual(ctx.roots.find(r => r.canonicalPath === '/a/b/docs')!.protected, true)
    assert.deepEqual(ctx.locations.map(l => [l.path, l.protected, l.verificationState]), [['/a/b/docs/z.md', true, 'verified'], ['/a/b/x.md', false, 'verified']])
    assert.equal(ctx.locations[1]!.rootId, b.rootId)
    assert.ok(ctx.locations[1]!.documentId)
    assert.deepEqual(ctx.sessions.map(s => s.sessionId).sort(), [S1, S3].sort())
    assert.deepEqual(ctx.sessions.find(s => s.sessionId === S1)!.cwd, '/a/b/sub')
    assert.throws(() => getArtifactRemovalContext({ raw: ro }, 'a/b'), /absolute/)
  } finally {
    ro.close()
  }
})

test('document detail pages locations, versions and evidence and resolves retired aliases', () => {
  const fx = fixture(), { db, repo, main, feat } = fx
  const id = repoDoc(repo, 'docs/guide.md')
  const a = recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/guide.md', { ino: '1', evidence: { eventKey: 'd1', sessionId: S1, operation: 'created', certainty: 'recorded' } }), NOW)
  recordArtifactObservation(db, working(feat, id, '/home/u/repo/.worktrees/feat/docs/guide.md', { ino: '2', evidence: { eventKey: 'd2', sessionId: S2, operation: 'modified', certainty: 'recorded' } }), NOW)
  const a2 = recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/guide.md', { ino: '1', size: 99, at: 35, observedAt: 40, evidence: { eventKey: 'd3', sessionId: S1, operation: 'modified', certainty: 'recorded' } }), NOW)

  const page1 = getArtifactDocument(db, a.documentId, { limit: 1, offset: 0 })
  assert.equal(page1.document.documentId, a.documentId)
  assert.deepEqual([page1.locations.length, page1.versions.length, page1.evidence.length], [1, 1, 1])
  assert.deepEqual(page1.next, { locations: '1', versions: '1', evidence: '1' })
  assert.equal(page1.evidence[0]!.sourceKey, 'd3', 'newest evidence first')
  const rest = getArtifactDocument(db, a.documentId, { limit: 10, offset: 1 })
  assert.deepEqual(rest.next, { locations: null, versions: null, evidence: null })
  assert.deepEqual([rest.locations.length, rest.versions.length, rest.evidence.length], [1, 2, 2])

  const old = getArtifactVersion(db, a.versionId!)!
  assert.deepEqual([old.current, old.availability, old.kind, old.commitOid], [false, 'unavailable', 'working', null], 'an overwritten working version keeps metadata but not availability')
  assert.equal(getArtifactVersion(db, a2.versionId!)!.current, true)

  db.raw.prepare('INSERT INTO artifact_document_aliases (alias_id, document_id, created_at) VALUES (?, ?, ?)').run('retired-group', a.documentId, T(0))
  assert.equal(getArtifactDocument(db, 'retired-group', PAGE).document.documentId, a.documentId)
  assert.throws(() => getArtifactDocument(db, 'missing', PAGE), ArtifactDocumentNotFoundError)
})

test('root registration deduplicates canonical paths, merges scope flags and makes protection stick', () => {
  const fx = fixture(), { db, out } = fx
  recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'r.md'), '/home/u/out/r.md'), NOW)
  const again = registerArtifactRoot(db, { kind: 'session-directory', canonicalPath: '/home/u/out', repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['session-cwd'] }, T(1))
  assert.equal(again.rootId, out.rootId)
  assert.deepEqual([again.kind, again.scopeFlags, again.protected, again.projectName, again.active], ['output', ['configured-output', 'session-cwd'], true, 'reports', true])
  assert.equal(row(db, 'SELECT is_sensitive FROM artifacts WHERE path = ?', '/home/u/out/r.md').is_sensitive, 1, 'locations under a protected root are protected')
  assert.equal(registerArtifactRoot(db, { ...again, protected: false, scopeFlags: ['cli-output'] }, T(2)).protected, true, 'protection from any registration sticks')
  assert.equal(listArtifactRoots(db).length, 3)
  for (const bad of ['relative/path', '/home/u/out/', '/home/u/../etc', '/']) {
    assert.throws(() => registerArtifactRoot(db, { ...again, canonicalPath: bad }, T(3)), /canonical/)
  }
  assert.throws(() => registerArtifactRoot(db, { ...again, canonicalPath: '/home/u/x', repositoryId: 'no-such-repo' }, T(3)), /repository/)
})

test('evidence is bounded: locators truncated, content-like or oversized keys rejected, unknown sessions and future times handled', () => {
  const fx = fixture(), { db, out } = fx
  const id = rootDoc(out.rootId, 'bounded.md'), path = '/home/u/out/bounded.md'
  recordArtifactEvidence(db, evidenceInput(out, id, path, 'k-long', { locator: 'x'.repeat(2000) }), NOW)
  assert.equal((row(db, `SELECT source_locator FROM artifact_evidence WHERE source_key = 'k-long'`).source_locator as string).length, 512)
  assert.throws(() => recordArtifactEvidence(db, evidenceInput(out, id, path, 'k-nl', { locator: 'line one\nline two' }), NOW), /locator/)
  assert.throws(() => recordArtifactEvidence(db, evidenceInput(out, id, path, ''), NOW), /source key/)
  assert.throws(() => recordArtifactEvidence(db, evidenceInput(out, id, path, 'k'.repeat(600)), NOW), /source key/)
  assert.throws(() => recordArtifactEvidence(db, evidenceInput(out, id, '/home/u/elsewhere/bounded.md', 'k-out'), NOW), /outside/)
  assert.throws(() => recordArtifactEvidence(db, evidenceInput(out, id, '/home/u/out/other.md', 'k-mismatch'), NOW), /identity/)

  recordArtifactEvidence(db, evidenceInput(out, rootDoc(out.rootId, 'ghost.md'), '/home/u/out/ghost.md', 'k-ghost', { sessionId: 'not-a-known-session' }), NOW)
  assert.equal(row(db, `SELECT session_id FROM artifact_evidence WHERE source_key = 'k-ghost'`).session_id, null)

  const future = '2099-01-01T00:00:00.000Z'
  const f = recordArtifactEvidence(db, evidenceInput(out, rootDoc(out.rootId, 'future.md'), '/home/u/out/future.md', 'k-future', { eventAt: future }), NOW)
  assert.equal(row(db, `SELECT event_at FROM artifact_evidence WHERE source_key = 'k-future'`).event_at, future, 'the raw source time is retained')
  assert.deepEqual(row(db, 'SELECT last_change_at, last_change_source, first_created_at FROM artifact_documents WHERE document_id = ?', f.documentId),
    { last_change_at: NOW, last_change_source: 'observed', first_created_at: null }, 'an unusable time falls back to the labelled observation time')
  const bounded = recordArtifactEvidence(db, evidenceInput(out, id, path, 'k-future-2', { eventAt: future, operation: 'modified' }), NOW)
  assert.deepEqual(row(db, 'SELECT last_change_at, last_change_source FROM artifact_documents WHERE document_id = ?', bounded.documentId),
    { last_change_at: T(1), last_change_source: 'hook' }, 'a future time cannot outrank real activity')
})

test('activity: a known document gaining a location is not recent again, and signature transitions are labelled', () => {
  const fx = fixture(), { db, repo, main, feat } = fx
  const id = repoDoc(repo, 'docs/known.md')
  const first = recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/known.md', { at: 1, evidence: { eventKey: 'kn1', sessionId: S1, operation: 'created', certainty: 'recorded' } }), NOW)
  const activity = () => row(db, 'SELECT last_change_at, last_change_source, first_created_at FROM artifact_documents WHERE document_id = ?', first.documentId)
  assert.deepEqual(activity(), { last_change_at: T(1), last_change_source: 'hook', first_created_at: T(1) })

  // A new worktree materializes the same file with a fresh mtime: a new location, no fresh activity.
  recordArtifactObservation(db, working(feat, id, '/home/u/repo/.worktrees/feat/docs/known.md', { at: 40, ino: '9', observedAt: 41 }), NOW)
  assert.deepEqual(activity(), { last_change_at: T(1), last_change_source: 'hook', first_created_at: T(1) })

  // A post-baseline rewrite that preserved an old mtime is still a change, timed by its observation.
  recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/known.md', { at: 0, size: 77, observedAt: 45 }), NOW)
  assert.deepEqual(activity(), { last_change_at: T(45), last_change_source: 'signature', first_created_at: T(1) })
  recordArtifactObservation(db, working(main, id, '/home/u/repo/docs/known.md', { at: 47, size: 78, observedAt: 48 }), NOW)
  assert.deepEqual(activity(), { last_change_at: T(47), last_change_source: 'mtime', first_created_at: T(1) })

  // A clean tracked file that Git vouches for gets no file-time activity of its own.
  const tracked = recordArtifactObservation(db, working(main, repoDoc(repo, 'docs/tracked.md'), '/home/u/repo/docs/tracked.md', {
    at: 29, git: { repositoryId: repo, checkoutIdentity: 'ck-main', gitPath: 'docs/tracked.md', blobOid: OID('9'), objectFormat: 'sha1', mode: 0o100644, size: 10 },
  }), NOW)
  assert.equal(row(db, 'SELECT last_change_source FROM artifact_documents WHERE document_id = ?', tracked.documentId).last_change_source, 'observed')
})

test('legacy backfill pages existing locations by artifact id', () => {
  const { db } = fixture()
  const made = ['/x/1.md', '/x/2.md', '/x/3.md'].map(p => upsertArtifact(db, { path: p, sizeBytes: 1, createdAt: T(0), projectName: null, now: T(0) }).artifactId)
  addOrigin(db, made[0]!, S1, 'creator', 'tool_event', T(0))
  const first = listLegacyArtifactBackfill(db, 0, 2)
  assert.deepEqual(first.map(r => r.artifactId), made.slice(0, 2))
  assert.equal(first[0]!.creatorSessionId, S1)
  assert.deepEqual(listLegacyArtifactBackfill(db, made[1]!, 2).map(r => r.artifactId), [made[2]])
  assert.deepEqual(listLegacyArtifactBackfill(db, made[2]!, 2), [])
})

test('Git-only documents with a sensitive name or a phi segment are protected, hidden by default and counted consistently', () => {
  const fx = fixture(), { db } = fx
  const docs = Object.fromEntries(['config/credentials.json', 'phi/report.md', 'docs/PHI/notes.md', 'data/athena/csv/.phi/patients.md', 'data/.PHI/b.md', 'docs/.phix/c.md', 'docs/philosophy.md', 'docs/plain.md'].map((rel, i) =>
    [rel, recordArtifactObservation(db, commitObs(fx, rel, OID(String(i + 1)), OID('f')), NOW).documentId]))
  const stored = (rel: string) => row(db, 'SELECT extension, project_name, protected FROM artifact_documents WHERE document_id = ?', docs[rel]!)
  assert.deepEqual(stored('config/credentials.json'), { extension: 'json', project_name: 'repo', protected: 1 }, 'a committed sensitive filename with no local copy')
  assert.deepEqual(stored('phi/report.md'), { extension: 'md', project_name: 'repo', protected: 1 })
  assert.equal(stored('docs/PHI/notes.md').protected, 1, 'the phi segment is matched case-insensitively anywhere in the path')
  assert.equal(stored('data/athena/csv/.phi/patients.md').protected, 1, 'a `.phi` segment protects like `phi` (R85)')
  assert.equal(stored('data/.PHI/b.md').protected, 1)
  assert.equal(stored('docs/.phix/c.md').protected, 0, 'only exactly `phi` or `.phi` counts')
  assert.equal(stored('docs/philosophy.md').protected, 0, 'only a whole phi segment counts')
  assert.equal(stored('docs/plain.md').protected, 0)

  const names = (filters: ArtifactDocumentFilters) => {
    const all = listArtifactDocuments(db, filters, PAGE)
    assert.equal(all.total, all.rows.length, 'the total counts exactly the filtered rows')
    assert.equal(listArtifactDocuments(db, filters, { limit: 1, offset: 0 }).total, all.total, 'the total does not depend on the page')
    return all.rows.map(r => r.displayName).sort()
  }
  assert.deepEqual(names({}), ['c.md', 'philosophy.md', 'plain.md'])
  assert.deepEqual(names({ sensitive: 'only' }), ['b.md', 'credentials.json', 'notes.md', 'patients.md', 'report.md'])
  assert.deepEqual(names({ sensitive: 'show' }), ['b.md', 'c.md', 'credentials.json', 'notes.md', 'patients.md', 'philosophy.md', 'plain.md', 'report.md'])
  assert.deepEqual(names({ extension: 'json' }), [], 'a hidden document stays hidden under other filters')
  assert.deepEqual(names({ extension: 'json', sensitive: 'show' }), ['credentials.json'])
  assert.deepEqual(names({ project: 'repo' }), ['c.md', 'philosophy.md', 'plain.md'])
  assert.equal(getArtifactDocument(db, docs['config/credentials.json']!, PAGE).document.protected, true)
})

test('protection is raised by a location under a protected root and never lowered', () => {
  const fx = fixture(), { db, repo, main, feat, out } = fx
  const id = repoDoc(repo, 'deliverables/r.md')
  const doc = recordArtifactObservation(db, commitObs(fx, 'deliverables/r.md', OID('a'), OID('b')), NOW).documentId
  const isProtected = () => row(db, 'SELECT protected FROM artifact_documents WHERE document_id = ?', doc).protected
  assert.equal(isProtected(), 0)

  // A protected output root inside the checkout: the document gains a location there and becomes protected.
  const vault = registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/repo/deliverables', repositoryId: repo, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(1))
  recordArtifactObservation(db, working(vault, id, '/home/u/repo/deliverables/r.md'), NOW)
  assert.equal(isProtected(), 1)

  // An unprotected copy elsewhere, the protected copy going missing and a re-registration do not lower it.
  recordArtifactObservation(db, working(feat, id, '/home/u/repo/.worktrees/feat/deliverables/r.md', { ino: '2' }), NOW)
  db.raw.prepare(`UPDATE artifacts SET exists_state = 'missing' WHERE path = '/home/u/repo/deliverables/r.md'`).run()
  registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/repo/deliverables', repositoryId: repo, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T(2))
  recordArtifactObservation(db, working(main, repoDoc(repo, 'deliverables/s.md'), '/home/u/repo/deliverables/s.md'), NOW)
  assert.equal(isProtected(), 1)
  assert.equal(listArtifactDocuments(db, {}, PAGE).rows.some(r => r.documentId === doc), false)

  // Registering protection later raises documents already catalogued under the root.
  const plain = recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'later.md'), '/home/u/out/later.md'), NOW).documentId
  assert.equal(row(db, 'SELECT protected FROM artifact_documents WHERE document_id = ?', plain).protected, 0)
  registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/out', repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(3))
  assert.equal(row(db, 'SELECT protected FROM artifact_documents WHERE document_id = ?', plain).protected, 1)
  assert.deepEqual(listArtifactDocuments(db, { sensitive: 'only' }, PAGE).rows.map(r => r.displayName).sort(), ['later.md', 'r.md', 's.md'])
})

test('extension and project are stored per document and project names come only from root registrations', () => {
  const fx = fixture(), { db } = fx
  const anon = registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/anon', repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T(0))
  const upper = recordArtifactObservation(db, working(anon, rootDoc(anon.rootId, 'Report.FINAL.HTML'), '/home/u/anon/Report.FINAL.HTML'), NOW).documentId
  const dotfile = recordArtifactObservation(db, working(anon, rootDoc(anon.rootId, '.notes'), '/home/u/anon/.notes'), NOW).documentId
  const bare = recordArtifactObservation(db, working(anon, rootDoc(anon.rootId, 'Makefile'), '/home/u/anon/Makefile'), NOW).documentId
  const stored = (id: string) => row(db, 'SELECT extension, project_name FROM artifact_documents WHERE document_id = ?', id)
  assert.deepEqual(stored(upper), { extension: 'html', project_name: null }, 'lowercase, no dot; no project is invented')
  assert.deepEqual(stored(dotfile), { extension: 'notes', project_name: null })
  assert.deepEqual(stored(bare), { extension: '', project_name: null })
  assert.deepEqual(listArtifactDocuments(db, { extension: 'HTML' }, PAGE).rows.map(r => r.documentId), [upper])

  // Naming the root's project later names its documents; a re-registration under another name keeps one root in one project.
  registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/anon', repositoryId: null, projectName: 'named-later', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T(1))
  assert.equal(stored(upper).project_name, 'named-later')
  registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/anon', repositoryId: null, projectName: 'renamed', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T(2))
  assert.equal(stored(upper).project_name, 'renamed')
  assert.equal(listArtifactDocuments(db, { project: 'renamed', types: 'all' }, PAGE).total, 3)
  assert.equal(listArtifactDocuments(db, { project: 'renamed' }, PAGE).total, 1, 'the default document type filter still applies')
  assert.equal(listArtifactDocuments(db, { project: 'named-later', types: 'all' }, PAGE).total, 0)

  // A repository document takes the project of the repository's roots; a nameless root never blanks it.
  const committed = recordArtifactObservation(db, commitObs(fx, 'notes/x.md', OID('c'), OID('d')), NOW).documentId
  assert.equal(stored(committed).project_name, 'repo')
  registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/repo', repositoryId: fx.repo, projectName: null, checkoutIdentity: 'ck-main', protected: false, scopeFlags: ['checkout'] }, T(3))
  assert.equal(stored(committed).project_name, 'repo')
})

test('hot grouped-list queries use their indexes instead of scanning documents, locations or evidence', () => {
  const fx = fixture(), { db, out } = fx
  recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md', { evidence: { eventKey: 'p1', sessionId: S1 } }), NOW)
  const bareScan = (lines: string[]) => lines.filter(l => /^SCAN \w+$/.test(l))
  const check = (label: string, filters: ArtifactDocumentFilters, expect: { count: RegExp; page: RegExp; ordered: boolean; noScan: boolean }) => {
    const sql = listSql(db, filters)
    const count = plan(db, sql.count), page = plan(db, sql.page)
    const show = `${label}\ncount:\n  ${count.join('\n  ')}\npage:\n  ${page.join('\n  ')}`
    assert.ok(count.some(l => expect.count.test(l)), show)
    assert.ok(page.some(l => expect.page.test(l)), show)
    assert.deepEqual([...bareScan(count), ...bareScan(page)], [], `no full table scan: ${show}`)
    if (expect.noScan) assert.deepEqual([...count, ...page].filter(l => l.startsWith('SCAN')), [], `no scan at all: ${show}`)
    if (expect.ordered) assert.ok(!page.some(l => l.includes('TEMP B-TREE')), `the page is read in index order: ${show}`)
  }
  // The default view (document extensions, protected hidden) is an index-only seek per extension; its page may then sort the
  // matching keys or walk the activity index, depending on the planner, but never reads the documents table in full.
  check('default', {}, { count: /SEARCH d USING COVERING INDEX idx_artifact_documents_extension\b/, page: /USING (COVERING )?INDEX idx_artifact_documents_(extension|activity)\b/, ordered: false, noScan: false })
  check('extension', { extension: 'md' }, { count: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_extension\b/, page: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_extension\b/, ordered: true, noScan: true })
  check('project', { project: 'reports' }, { count: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_project\b/, page: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_project\b/, ordered: true, noScan: true })
  check('session', { sessionId: S1 }, { count: /SEARCH se USING COVERING INDEX idx_artifact_evidence_session\b/, page: /SEARCH se USING COVERING INDEX idx_artifact_evidence_session\b/, ordered: false, noScan: true })
  check('activity window', { from: T(0), to: T(59) }, { count: /idx_artifact_documents_/, page: /idx_artifact_documents_/, ordered: false, noScan: false })
  // PERF-GAP-1: the availability and preservation filters read the stored rule values on their own indexes (no per-document
  // subquery); the count is index-only, and one extension pages in index order.
  check('availability', { availability: 'git' }, { count: /SEARCH d USING COVERING INDEX idx_artifact_documents_availability\b/, page: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_availability\b/, ordered: false, noScan: true })
  check('availability, one extension', { availability: 'local', extension: 'md' }, { count: /SEARCH d USING COVERING INDEX idx_artifact_documents_availability\b/, page: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_availability\b/, ordered: true, noScan: true })
  check('needs preservation', { needsPreservation: true }, { count: /SEARCH d USING COVERING INDEX idx_artifact_documents_preservation\b/, page: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_preservation\b/, ordered: false, noScan: true })
  check('no preservation needed', { needsPreservation: false }, { count: /SEARCH d USING COVERING INDEX idx_artifact_documents_preservation\b/, page: /SEARCH d USING (COVERING )?INDEX idx_artifact_documents_preservation\b/, ordered: false, noScan: true })
  for (const [label, sql] of Object.entries(listSql(db, { availability: 'stale', needsPreservation: false }))) {
    assert.doesNotMatch(sql, /EXISTS/, `${label}: no per-document rule is evaluated to filter`)
  }
})

test('a search drives the grouped list from its matched set: the path FTS by rowid and the two relative-path indexes, one primary-key lookup per match (PERF-GAP-1)', () => {
  const fx = fixture(), { db, out } = fx
  recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'billing-report.md'), '/home/u/out/billing-report.md'), NOW)
  recordArtifactObservation(db, commitObs(fx, 'docs/billing.md', OID('1'), OID('2')), NOW)
  const seen: string[] = []
  const raw = new Proxy(db.raw, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => { seen.push(sql); return target.prepare(sql) }
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const page = listArtifactDocuments({ ...db, raw }, { q: 'billing' }, PAGE)
  assert.deepEqual(page.rows.map(r => r.displayName).sort(), ['billing-report.md', 'billing.md'])
  assert.equal(page.total, 2)
  const sql = seen.find(s => s.includes('COUNT(*) OVER ()'))
  assert.ok(sql, 'the page and its total are one query')
  assert.ok(!seen.some(s => s.startsWith('SELECT COUNT(*) AS n FROM')), 'no second evaluation of the matched set for the total')
  const lines = plan(db, sql.replaceAll('?', "'billing'"))
  const show = lines.join('\n')
  assert.ok(lines.some(l => /SCAN artifacts_fts VIRTUAL TABLE/.test(l)), show)
  assert.ok(lines.some(l => /SEARCH fa USING INTEGER PRIMARY KEY/.test(l)), show)
  assert.ok(lines.some(l => /idx_artifact_documents_repository_path/.test(l)) && lines.some(l => /idx_artifact_documents_root_path/.test(l)), show)
  assert.ok(lines.some(l => /SEARCH d USING INDEX sqlite_autoindex_artifact_documents_1/.test(l)), `one lookup per matched document: ${show}`)
  assert.deepEqual(lines.filter(l => /^SCAN (d|fa|artifact_documents)$/.test(l)), [], `no scan of the documents or locations: ${show}`)
})

test('an event during a multi-slice pass gets one more fresh pass, whether the job is running or parked (R19)', () => {
  const fx = fixture(), { db, out } = fx
  const enqueue = (at: number) => enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(at))
  const job = enqueue(1)
  const state = () => row(db, 'SELECT state, cursor, desired_generation AS desired, applied_generation AS applied, pass_generation AS pass FROM artifact_jobs WHERE job_id = ?', job)
  const slice = (at: number, cursor: string | null) => {
    const claimed = claimArtifactJob(db, T(at))!
    assert.equal(claimed.jobId, job)
    commitArtifactBatch(db, job, claimed.desiredGeneration, [], { cursor, coverage: cursor === null ? 'complete' : 'partial', complete: cursor === null }, T(at))
    finishArtifactJob(db, job, { complete: cursor === null, coverage: cursor === null ? 'complete' : 'partial' }, T(at))
    return claimed
  }

  // Running: two events during slice 1 of pass 1 coalesce into one bump, which the resumed tail must not consume.
  const first = claimArtifactJob(db, T(2))!
  assert.equal(first.desiredGeneration, 1)
  enqueue(3); enqueue(3)
  commitArtifactBatch(db, job, first.desiredGeneration, [], { cursor: 'frontier-1', coverage: 'partial', complete: false }, T(4))
  finishArtifactJob(db, job, { complete: false, coverage: 'partial' }, T(4))
  assert.deepEqual(state(), { state: 'queued', cursor: 'frontier-1', desired: 2, applied: 0, pass: 1 })
  const resumed = slice(5, null)
  assert.deepEqual([resumed.cursor, resumed.desiredGeneration], ['frontier-1', 2], 'the claim still reports the desired generation')
  assert.deepEqual(state(), { state: 'queued', cursor: null, desired: 2, applied: 1, pass: null }, 'the tail completed pass 1 only; a fresh pass is queued')
  assert.equal(listArtifactRoots(db).find(r => r.rootId === out.rootId)!.appliedGeneration, 1)
  assert.equal(slice(6, null).cursor, null, 'the extra pass starts from the beginning')
  assert.deepEqual(state(), { state: 'done', cursor: null, desired: 2, applied: 2, pass: null })

  // Parked between slices with a cursor: an event must not be absorbed by the rest of the pass.
  enqueue(7)
  slice(8, 'frontier-2')
  enqueue(9)
  assert.deepEqual(state(), { state: 'queued', cursor: 'frontier-2', desired: 4, applied: 2, pass: 3 })
  slice(10, null)
  assert.deepEqual(state(), { state: 'queued', cursor: null, desired: 4, applied: 3, pass: null })
  slice(11, null)
  assert.deepEqual(state(), { state: 'done', cursor: null, desired: 4, applied: 4, pass: null })
  assert.equal(listArtifactRoots(db).find(r => r.rootId === out.rootId)!.appliedGeneration, 4)
})

test('a retry-parked pass and a finish without a final batch keep pass generations honest (R19)', () => {
  const fx = fixture(), { db, out } = fx
  const enqueue = (at: number) => enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(at))
  const job = enqueue(1)
  const state = () => row(db, 'SELECT state, cursor, desired_generation AS desired, applied_generation AS applied, pass_generation AS pass FROM artifact_jobs WHERE job_id = ?', job)

  // Retry-parked mid-pass with a cursor: the event survives the retry and the resumed tail.
  const a = claimArtifactJob(db, T(2))!
  commitArtifactBatch(db, job, a.desiredGeneration, [], { cursor: 'frontier-r', coverage: 'partial', complete: false }, T(3))
  retryArtifactJob(db, job, 'walk-error', T(5), T(3))
  enqueue(4)
  assert.deepEqual(state(), { state: 'retry', cursor: 'frontier-r', desired: 2, applied: 0, pass: 1 })
  const b = claimArtifactJob(db, T(5))!
  assert.equal(b.cursor, 'frontier-r')
  // A complete finish records the pass generation even without a final complete batch.
  finishArtifactJob(db, job, { complete: true, coverage: 'complete' }, T(6))
  assert.deepEqual(state(), { state: 'queued', cursor: null, desired: 2, applied: 1, pass: null })
  const c = claimArtifactJob(db, T(7))!
  assert.equal(c.cursor, null)
  finishArtifactJob(db, job, { complete: true, coverage: 'complete' }, T(7))
  assert.deepEqual(state(), { state: 'done', cursor: null, desired: 2, applied: 2, pass: null })

  // Retry-parked before any progress: the next claim is a fresh pass at the latest generation, so one pass suffices.
  enqueue(8)
  claimArtifactJob(db, T(9))
  retryArtifactJob(db, job, 'git-timeout', T(11), T(9))
  enqueue(10)
  const fresh = claimArtifactJob(db, T(11))!
  assert.equal(fresh.cursor, null)
  commitArtifactBatch(db, job, fresh.desiredGeneration, [], { cursor: null, coverage: 'complete', complete: true }, T(12))
  finishArtifactJob(db, job, { complete: true, coverage: 'complete' }, T(12))
  assert.equal(state().state, 'done')
  assert.equal(state().applied, state().desired)
})

test('Git-only documents observed through, or registered under, a protected root are protected', () => {
  const fx = fixture(), { db, repo, main } = fx
  const commitVia = (root: ArtifactRootRow, repositoryId: string, rel: string, oid: string) => recordArtifactObservation(db, {
    rootId: root.rootId, identity: repoDoc(repositoryId, rel), kind: 'commit', observedAt: T(30),
    git: { repositoryId, commitOid: OID(oid), gitPath: rel, blobOid: OID('b'), objectFormat: 'sha1', mode: 0o100644, size: 1 },
  }, NOW).documentId
  const isProtected = (id: string) => row(db, 'SELECT protected FROM artifact_documents WHERE document_id = ?', id).protected
  const output = (path: string) => registerArtifactRoot(db, { kind: 'output', canonicalPath: path, repositoryId: null, projectName: null, checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T(1))

  // A commit-only document in a protected checkout: no location exists, and none is invented.
  const secureRepo = registerArtifactRepository(db, { commonDir: '/home/u/secure/.git', displayName: 'secure', remoteIdentity: null }, T(0))
  const secure = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/secure', repositoryId: secureRepo, projectName: 'secure', checkoutIdentity: 'ck-s', protected: true, scopeFlags: ['checkout'] }, T(0))
  const dated = commitVia(secure, secureRepo, '2026-10-01.md', '1')
  assert.equal(isProtected(dated), 1)
  assert.equal(count(db, 'artifacts'), 0)
  assert.deepEqual(listArtifactDocuments(db, {}, PAGE).rows.map(r => [r.displayName, r.protected]), [])

  // A working copy first seen in an unprotected linked worktree of that repository is created protected: in the protected
  // checkout the same repository path would be protected.
  const secureWt = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/secure-wt', repositoryId: secureRepo, projectName: 'secure', checkoutIdentity: 'ck-s2', protected: false, scopeFlags: ['checkout'] }, T(0))
  const fromWorktree = recordArtifactObservation(db, working(secureWt, repoDoc(secureRepo, 'drafts/d.md'), '/home/u/secure-wt/drafts/d.md'), NOW)
  assert.equal(row(db, 'SELECT is_sensitive FROM artifacts WHERE artifact_id = ?', fromWorktree.artifactId).is_sensitive, 0, 'the worktree location itself is not under a protected root')
  assert.equal(isProtected(fromWorktree.documentId), 1)

  // A protected output root nested in the checkout, registered before the history import.
  output('/home/u/repo/deliverables')
  const inside = commitVia(main, repo, 'deliverables/x.md', '2')
  const outside = commitVia(main, repo, 'docs/y.md', '3')
  assert.deepEqual([isProtected(inside), isProtected(outside)], [1, 0])

  // Registered after the import: documents at or under it are raised, separator-aware.
  const later = commitVia(main, repo, 'reports/z.md', '4'), sibling = commitVia(main, repo, 'reports-2026/a.md', '5')
  output('/home/u/repo/reports')
  assert.deepEqual([isProtected(later), isProtected(sibling)], [1, 0])

  // Inside a linked worktree the root's path is taken relative to that worktree's checkout.
  const vaulted = commitVia(main, repo, 'vault/v.md', '6')
  output('/home/u/repo/.worktrees/feat/vault')
  assert.equal(isProtected(vaulted), 1)

  // An existing document later observed through a protected root is raised by that observation.
  const seenLater = commitVia(main, repo, 'docs/w.md', '8')
  assert.equal(isProtected(seenLater), 0)
  const external = output('/home/u/vault-out')
  commitVia(external, repo, 'docs/w.md', '9')
  assert.equal(isProtected(seenLater), 1)

  // A whole checkout registered as protected later raises all of its repository's documents.
  const plainRepo = registerArtifactRepository(db, { commonDir: '/home/u/plain/.git', displayName: 'plain', remoteIdentity: null }, T(0))
  const plainRoot = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/plain', repositoryId: plainRepo, projectName: 'plain', checkoutIdentity: 'ck-p', protected: false, scopeFlags: ['checkout'] }, T(0))
  const plainDoc = commitVia(plainRoot, plainRepo, 'plain.md', '7')
  assert.equal(isProtected(plainDoc), 0)
  registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/plain', repositoryId: plainRepo, projectName: 'plain', checkoutIdentity: 'ck-p', protected: true, scopeFlags: ['checkout'] }, T(2))
  assert.equal(isProtected(plainDoc), 1)

  const visible = listArtifactDocuments(db, {}, PAGE)
  assert.deepEqual(visible.rows.map(r => r.displayName).sort(), ['a.md', 'y.md'], 'only docs/y.md and reports-2026/a.md stay visible')
  assert.equal(visible.total, 2)
  assert.deepEqual(listArtifactDocuments(db, { sensitive: 'only' }, PAGE).rows.map(r => r.displayName).sort(), ['2026-10-01.md', 'd.md', 'plain.md', 'v.md', 'w.md', 'x.md', 'z.md'])

  // A checkout of a repository registered inside a protected directory puts every path of that repository there.
  const nestedRepo = registerArtifactRepository(db, { commonDir: '/home/u/nested/.git', displayName: 'nested', remoteIdentity: null }, T(0))
  const nestedRoot = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/nested', repositoryId: nestedRepo, projectName: 'nested', checkoutIdentity: 'ck-n', protected: false, scopeFlags: ['checkout'] }, T(0))
  const nestedDoc = commitVia(nestedRoot, nestedRepo, 'n.md', 'a')
  assert.equal(isProtected(nestedDoc), 0)
  registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/repo/deliverables/nested-wt', repositoryId: nestedRepo, projectName: 'nested', checkoutIdentity: 'ck-n2', protected: false, scopeFlags: ['checkout'] }, T(3))
  assert.equal(isProtected(nestedDoc), 1)
})

test('error reasons are reduced to a category token wherever they are stored or returned', () => {
  const fx = fixture(), { db, out } = fx
  const walk = () => {
    const id = enqueueArtifactJob(db, { scopeId: out.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 1 }, T(1))
    assert.equal(claimArtifactJob(db, T(1))?.jobId, id)
    return id
  }
  const reasons = (id: string) => ({
    job: row(db, 'SELECT last_error FROM artifact_jobs WHERE job_id = ?', id).last_error,
    root: listArtifactRoots(db).find(r => r.rootId === out.rootId)!.lastError,
    status: getArtifactManagerStatus(db, T(2)).roots.find(r => r.rootId === out.rootId)!.reason,
  })

  const spaced = `ENOENT: no such file or directory, scandir '/Users/j/PHI/Jane Doe labs'`
  let id = walk()
  finishArtifactJob(db, id, { complete: false, coverage: 'partial', error: spaced }, T(1))
  assert.deepEqual(reasons(id), { job: 'ENOENT', root: 'ENOENT', status: 'ENOENT' })
  const everything = JSON.stringify([rows(db, 'SELECT * FROM artifact_jobs'), listArtifactRoots(db), getArtifactManagerStatus(db, T(2))])
  for (const fragment of ['Jane', 'Doe', 'labs', '/Users', 'PHI']) assert.ok(!everything.includes(fragment), `no "${fragment}" stored or returned`)

  id = walk()
  finishArtifactJob(db, id, { complete: false, coverage: 'partial', error: 'Jane Doe labs could not be read' }, T(1))
  assert.deepEqual(reasons(id), { job: 'error', root: 'error', status: 'error' }, 'free text without a leading code becomes a generic category')

  id = walk()
  retryArtifactJob(db, id, 'git-timeout', T(5), T(1))
  assert.deepEqual(reasons(id), { job: 'git-timeout', root: 'git-timeout', status: 'git-timeout' })
  claimArtifactJob(db, T(5))
  retryArtifactJob(db, id, `scan of '/Users/j/Jane Doe'`, T(9), T(5))
  assert.deepEqual(reasons(id), { job: 'error', root: 'error', status: 'error' })
})

test('Git-only document protection does not depend on registration order', () => {
  const ALL = ['old/deleted.md', 'deliverables/x.md', 'deliverables-2026/y.md', 'docs/z.md']
  const cases = [
    { name: 'protected root above the checkout', checkout: '/home/u/clinic/repo', root: '/home/u/clinic', expected: ALL },
    { name: 'protected root inside the checkout', checkout: '/home/u/b', root: '/home/u/b/deliverables', expected: ['deliverables/x.md'] },
  ]
  type Step = 'docs' | 'checkout' | 'protect' | 'unprotected-root'
  const orders: Step[][] = [
    ['docs', 'protect', 'checkout'],
    ['docs', 'checkout', 'protect'],
    ['docs', 'unprotected-root', 'checkout', 'protect'],
    ['checkout', 'docs', 'protect'],
    ['protect', 'docs', 'checkout'],
    ['checkout', 'protect', 'docs'],
    ['protect', 'checkout', 'docs'],
  ]
  for (const c of cases) {
    for (const order of orders) {
      const label = `${c.name}: ${order.join(' -> ')}`
      const db = openTestDb()
      const checkoutRoot = (repositoryId: string, canonicalPath: string, checkoutIdentity: string) =>
        registerArtifactRoot(db, { kind: 'checkout', canonicalPath, repositoryId, projectName: 'p', checkoutIdentity, protected: false, scopeFlags: ['checkout'] }, T(0))
      const outputRoot = (prot: boolean) =>
        registerArtifactRoot(db, { kind: 'output', canonicalPath: c.root, repositoryId: null, projectName: null, checkoutIdentity: null, protected: prot, scopeFlags: ['configured-output'] }, T(1))
      const commit = (root: ArtifactRootRow, repositoryId: string, rel: string, oid: string) => recordArtifactObservation(db, {
        rootId: root.rootId, identity: repoDoc(repositoryId, rel), kind: 'commit', observedAt: T(30),
        git: { repositoryId, commitOid: OID(oid), gitPath: rel, blobOid: OID('b'), objectFormat: 'sha1', mode: 0o100644, size: 1 },
      }, NOW).documentId
      // History is imported through an unrelated checkout of the same repository, so these documents never get a location.
      const repo = registerArtifactRepository(db, { commonDir: '/home/u/src/.git', displayName: 'src', remoteIdentity: null }, T(0))
      const source = checkoutRoot(repo, '/home/u/src', 'ck-src')
      // A neighbour that only shares a string prefix with the protected root must never be raised.
      const otherRepo = registerArtifactRepository(db, { commonDir: '/home/u/other/.git', displayName: 'other', remoteIdentity: null }, T(0))
      const neighbour = checkoutRoot(otherRepo, `${c.root}2/repo`, 'ck-n')
      const neighbourDocs = [commit(neighbour, otherRepo, 'deliverables/x.md', 'e')]
      const docs = new Map<string, string>()
      for (const step of order) {
        if (step === 'docs') ALL.forEach((rel, i) => docs.set(rel, commit(source, repo, rel, String(i + 1))))
        else if (step === 'checkout') checkoutRoot(repo, c.checkout, 'ck-target')
        else if (step === 'protect') outputRoot(true)
        else outputRoot(false)
      }
      neighbourDocs.push(commit(neighbour, otherRepo, 'late.md', 'f'))
      const isProtected = (id: string) => row(db, 'SELECT protected FROM artifact_documents WHERE document_id = ?', id).protected
      assert.deepEqual(ALL.filter(rel => isProtected(docs.get(rel)!) === 1), c.expected, label)
      assert.deepEqual(neighbourDocs.map(isProtected), [0, 0], `${label}: the prefix neighbour stays unprotected`)
      assert.equal(listArtifactDocuments(db, {}, PAGE).total, ALL.length - c.expected.length + neighbourDocs.length, `${label}: totals`)

      // Re-registering the same roots with unchanged flags changes nothing.
      const before = rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id')
      outputRoot(true); checkoutRoot(repo, c.checkout, 'ck-target')
      assert.deepEqual(rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'), before, `${label}: re-registration is a no-op`)
      db.close()
    }
  }
})

test('a checkout inside a phi directory protects its repository whether history came first or second', () => {
  for (const historyFirst of [true, false]) {
    const db = openTestDb()
    const repo = registerArtifactRepository(db, { commonDir: '/home/u/src/.git', displayName: 'src', remoteIdentity: null }, T(0))
    const source = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/src', repositoryId: repo, projectName: 'p', checkoutIdentity: 'ck-src', protected: false, scopeFlags: ['checkout'] }, T(0))
    const commit = () => recordArtifactObservation(db, {
      rootId: source.rootId, identity: repoDoc(repo, 'notes/a.md'), kind: 'commit', observedAt: T(30),
      git: { repositoryId: repo, commitOid: OID('1'), gitPath: 'notes/a.md', blobOid: OID('b'), objectFormat: 'sha1', mode: 0o100644, size: 1 },
    }, NOW).documentId
    const register = () => registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/PHI/repo', repositoryId: repo, projectName: 'p', checkoutIdentity: 'ck-phi', protected: false, scopeFlags: ['checkout'] }, T(1))
    let doc: string
    if (historyFirst) { doc = commit(); register() } else { register(); doc = commit() }
    assert.equal(row(db, 'SELECT protected FROM artifact_documents WHERE document_id = ?', doc).protected, 1, `history first: ${historyFirst}`)
    assert.equal(listArtifactDocuments(db, {}, PAGE).total, 0)
    db.close()
  }
})

// ------------------------------------------------------------------------------------------------ Defect Wave 2a: availability

test('DEFECT-7: a working version is unavailable while its only location is missing, last-known while unverified, and available again unchanged', () => {
  const fx = fixture(), { db } = fx
  const path = '/home/u/out/notes/a.md'
  const obs = working(fx.out, rootDoc(fx.out.rootId, 'notes/a.md'), path)
  const a = recordArtifactObservation(db, obs, NOW)
  const version = () => getArtifactVersion(db, a.versionId!)!
  const detail = () => getArtifactDocument(db, a.documentId, PAGE)
  assert.equal(version().availability, 'available')
  assert.equal(detail().document.availability, 'local')
  // A direct ENOENT check (the runner's path-missing handler) marks the location missing.
  setExistsState(db, a.artifactId!, 'missing', null, NOW)
  assert.equal(version().availability, 'unavailable', 'its bytes are gone with the location')
  assert.equal(detail().versions.find(v => v.versionId === a.versionId)!.availability, 'unavailable', 'the detail agrees')
  assert.equal(detail().document.availability, 'unavailable', 'and so does the document')
  assert.ok(ids(db, { availability: 'unavailable' }).includes('a.md'))
  // The same file (same signature) is seen again: available again, without a new version.
  assert.equal(recordArtifactObservation(db, obs, NOW).versionId, a.versionId)
  assert.equal(version().availability, 'available')
  assert.equal(detail().document.availability, 'local')
  // A verifier that could not reach it (DEFECT-5) leaves the last known state: last-known, never missing.
  db.raw.prepare(`UPDATE artifacts SET verification_state = 'unverified' WHERE artifact_id = ?`).run(a.artifactId)
  assert.equal(version().availability, 'last-known')
  assert.equal(detail().document.availability, 'stale')
  // A newer observation supersedes it: the old version stays unavailable whatever its location says now.
  const b = recordArtifactObservation(db, working(fx.out, rootDoc(fx.out.rootId, 'notes/a.md'), path, { ino: '101', size: 11 }), NOW)
  assert.equal(version().availability, 'unavailable')
  assert.equal(getArtifactVersion(db, b.versionId!)!.availability, 'available')
  assert.equal(detail().document.availability, 'local')
})

test('DEFECT-3: a Git object check sets a commit or index version\'s availability only on proof, and the document follows', () => {
  const fx = fixture(), { db } = fx
  const c = recordArtifactObservation(db, commitObs(fx, 'docs/spec.md', OID('1'), OID('2')), NOW)
  const avail = (id: string | null) => getArtifactVersion(db, id!)!.availability
  const doc = () => getArtifactDocument(db, c.documentId, PAGE).document.availability
  const check = (versionId: string | null, object: 'present' | 'missing' | 'mismatch' | 'unreadable') => recordArtifactGitObjectChecks(db, [{ versionId: versionId!, object }], NOW)
  assert.equal(doc(), 'git')
  // A failed read proves nothing: the version is no longer offered, but not claimed gone.
  assert.equal(check(c.versionId, 'unreadable'), 1)
  assert.equal(avail(c.versionId), 'unknown')
  // Fix round 1: unproven is last-known (stale), not unavailable, so the UI keeps the action that re-proves it.
  assert.equal(doc(), 'stale', 'no longer offered as Git only, and not claimed unavailable')
  // `cat-file --batch-check` answering "missing" is proof.
  assert.equal(check(c.versionId, 'missing'), 1)
  assert.equal(avail(c.versionId), 'unavailable')
  assert.equal(check(c.versionId, 'unreadable'), 0, 'an unproven failure never turns a proven answer into unknown')
  assert.equal(avail(c.versionId), 'unavailable')
  // The object came back (fetched again): available, and the document is Git only again.
  assert.equal(check(c.versionId, 'present'), 1)
  assert.equal(avail(c.versionId), 'available')
  assert.equal(doc(), 'git')
  assert.equal(check(c.versionId, 'present'), 0, 'an unchanged answer writes nothing')
  // An object whose type or size is not the stored one can never be served exactly.
  check(c.versionId, 'mismatch')
  assert.equal(avail(c.versionId), 'unavailable')

  // Index versions: a superseded staged snapshot comes back as last-known, never as the current one.
  const i1 = recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('3')), NOW)
  const i2 = recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('4')), NOW)
  assert.equal(avail(i1.versionId), 'last-known')
  check(i1.versionId, 'missing')
  assert.equal(avail(i1.versionId), 'unavailable')
  check(i1.versionId, 'present')
  assert.equal(avail(i1.versionId), 'last-known')
  // A live staged snapshot that cannot be read stays at risk for removal (fail closed): unknown, not unavailable.
  check(i2.versionId, 'unreadable')
  assert.equal(avail(i2.versionId), 'unknown')
  assert.ok(ids(db, { needsPreservation: true }).includes('spec.md'), 'still counted as needing preservation')
  check(i2.versionId, 'present')
  assert.equal(avail(i2.versionId), 'available')

  // Working versions are judged by their location, never by a Git object check.
  const w = recordArtifactObservation(db, working(fx.out, rootDoc(fx.out.rootId, 'x.md'), '/home/u/out/x.md'), NOW)
  assert.equal(check(w.versionId, 'missing'), 0)
  assert.equal(avail(w.versionId), 'available')
  assert.throws(() => recordArtifactGitObjectChecks(db, [{ versionId: c.versionId!, object: 'gone' as 'missing' }], NOW), /Git object check/)
})

test('I4: the Git object work list pages one repository at a time from a (repository, version) cursor, skips recently checked versions and uses an index', () => {
  const fx = fixture(), { db } = fx
  const other = registerArtifactRepository(db, { commonDir: '/home/u/other/.git', displayName: 'other', remoteIdentity: null }, T(0))
  const otherRoot = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: '/home/u/other', repositoryId: other, projectName: 'other', checkoutIdentity: 'ck-other', protected: false, scopeFlags: ['checkout'] }, T(0))
  const made = [
    recordArtifactObservation(db, commitObs(fx, 'docs/a.md', OID('1'), OID('2')), NOW),
    recordArtifactObservation(db, commitObs(fx, 'docs/b.md', OID('1'), OID('3')), NOW),
    recordArtifactObservation(db, indexObs(fx, 'docs/c.md', OID('4')), NOW),
    recordArtifactObservation(db, { ...commitObs(fx, 'x.md', OID('5'), OID('6')), rootId: otherRoot.rootId, identity: repoDoc(other, 'x.md'), git: { repositoryId: other, commitOid: OID('5'), gitPath: 'x.md', blobOid: OID('6'), objectFormat: 'sha1', mode: 0o100644, size: 12 } }, NOW),
  ]
  recordArtifactObservation(db, working(fx.out, rootDoc(fx.out.rootId, 'w.md'), '/home/u/out/w.md'), NOW)
  const due = T(59) // every version above was checked (inserted) at NOW = T(59): nothing is due before it
  assert.deepEqual(listArtifactGitObjects(db, null, 10, T(58)).rows, [], 'versions checked within the interval are skipped')
  const later = '2026-10-21T00:00:00.000Z'
  const all = listArtifactGitObjects(db, null, 10, later).rows
  const key = (r: { repositoryId: string; versionId: string }) => `${r.repositoryId}/${r.versionId}`
  assert.deepEqual(all.map(key), [...made.map(m => key({ repositoryId: m === made[3] ? other : fx.repo, versionId: m.versionId! }))].sort(), 'repository, then version order')
  const c = all.find(r => r.versionId === made[2]!.versionId)!
  assert.deepEqual({ repositoryId: c.repositoryId, commonDir: c.commonDir, checkoutIdentity: c.checkoutIdentity, objectFormat: c.objectFormat, blobOid: c.blobOid, sizeBytes: c.sizeBytes },
    { repositoryId: fx.repo, commonDir: '/home/u/repo/.git', checkoutIdentity: 'ck-feat', objectFormat: 'sha1', blobOid: OID('4'), sizeBytes: 12 })
  const first = listArtifactGitObjects(db, null, 2, later).rows
  assert.deepEqual(listArtifactGitObjects(db, first[1]!, 10, later).rows.map(key), all.slice(2).map(key), 'resumes after the (repository, version) cursor')
  // A proof refreshes the check time (so the next passes skip it, even when nothing changed); an unproven version stays due.
  recordArtifactGitObjectChecks(db, [{ versionId: made[0]!.versionId!, object: 'present' }, { versionId: made[1]!.versionId!, object: 'unreadable' }], '2026-10-21T00:00:01.000Z')
  const stillDue = listArtifactGitObjects(db, null, 10, later).rows.map(r => r.versionId)
  assert.ok(!stillDue.includes(made[0]!.versionId!), 'a proven version is not due again within the interval')
  assert.ok(stillDue.includes(made[1]!.versionId!), 'an unproven one is retried')
  void due
  // The page is an index range, not a scan and sort of every version.
  const seen: string[] = []
  const raw = new Proxy(db.raw, {
    get(target, k) {
      if (k === 'prepare') return (sql: string) => { seen.push(sql); return target.prepare(sql) }
      const value = Reflect.get(target, k) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  listArtifactGitObjects({ ...db, raw }, first[1]!, 10, later)
  const sql = seen.find(q => q.includes('FROM artifact_versions'))!
  assert.ok(plan(db, sql.replaceAll('?', "''")).some(d => d.includes('idx_artifact_versions_git_objects')), `uses the work-list index: ${plan(db, sql.replaceAll('?', "''")).join(' | ')}`)
})

test('fix round 2: a work-list call reads a bounded number of index rows however few are due, and the cursor reaches every due version', () => {
  const fx = fixture(), { db } = fx
  const template = recordArtifactObservation(db, commitObs(fx, 'docs/template.md', OID('1'), OID('2')), NOW).versionId!
  // 100k commit versions, all checked just now (none due), but one near the end that was last checked long ago.
  db.raw.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
    INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, commit_oid, git_path, object_format, blob_oid, mode, size_bytes, observed_at)
    SELECT printf('bulk-%06d', i), t.document_id, 'commit', t.repository_id, t.commit_oid, printf('bulk/%06d.md', i), t.object_format, t.blob_oid, t.mode, t.size_bytes, t.observed_at
    FROM n, (SELECT * FROM artifact_versions WHERE version_id = ?) t`).run(template)
  db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at)
    SELECT version_id, 'available', 'unknown', ? FROM artifact_versions WHERE version_id >= 'bulk-' AND version_id < 'bulk.'`).run(NOW)
  db.raw.prepare('UPDATE artifact_version_state SET checked_at = ? WHERE version_id = ?').run(T(0), 'bulk-099990')
  const cutoff = T(30)
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    const page = listArtifactGitObjects(db, null, 256, cutoff)
    times.push(performance.now() - t0)
    assert.deepEqual(page.rows, [], 'nothing due in the first window')
    assert.equal(page.end, false, 'the page says more follows')
  }
  const median = [...times].sort((a, b) => a - b)[2]!
  assert.ok(median < 20, `one call reads a bounded window, not the whole index: ${median.toFixed(1)} ms`)
  // Following the cursor through the windows finds the one due version, and ends.
  let after: { repositoryId: string; versionId: string } | null = null
  const found: string[] = []
  let calls = 0
  for (;;) {
    const page = listArtifactGitObjects(db, after, 256, cutoff)
    calls += 1
    found.push(...page.rows.map(r => r.versionId))
    if (page.end) break
    assert.notEqual(page.last, null)
    after = page.last
    assert.ok(calls < 1_000)
  }
  assert.deepEqual(found, ['bulk-099990'])
  assert.ok(calls > 1 && calls < 200, `bounded windows: ${calls} calls`)
})

test('fix round 1: an unchanged index entry never undoes what an object check proved', () => {
  const fx = fixture(), { db } = fx
  const i = recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('3')), NOW)
  recordArtifactGitObjectChecks(db, [{ versionId: i.versionId!, object: 'missing' }], NOW)
  assert.equal(recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('3')), NOW).duplicate, true)
  assert.equal(getArtifactVersion(db, i.versionId!)!.availability, 'unavailable', 'the next checkout-status pass keeps the proof')
  recordArtifactGitObjectChecks(db, [{ versionId: i.versionId!, object: 'present' }], NOW)
  assert.equal(getArtifactVersion(db, i.versionId!)!.availability, 'available', 'only a successful object check restores it')
  const j = recordArtifactObservation(db, indexObs(fx, 'docs/spec.md', OID('4')), NOW)
  assert.equal(getArtifactVersion(db, j.versionId!)!.availability, 'available', 'a changed entry is a new, available revision')
})

test('R71: the coverage note has one key and JSON shape; anything else reads as no note', () => {
  const fx = fixture(), { db } = fx
  assert.equal(coverageNoteKey(fx.out.rootId, 'output-walk'), `coverage-reason:${fx.out.rootId}`)
  assert.equal(coverageNoteKey(fx.out.rootId, 'checkout-status'), coverageNoteKey(fx.out.rootId, 'output-walk'), 'the scan tasks share one note')
  assert.equal(coverageNoteKey(fx.main.rootId, 'git-history'), `coverage-reason:git-history:${fx.main.rootId}`)
  writeArtifactCoverageNote(db, fx.out.rootId, 'output-walk', { codes: ['lookback-limited'], complete: true }, NOW)
  writeArtifactCoverageNote(db, fx.main.rootId, 'git-history', { codes: [], info: 'nested-worktrees-registered', complete: false }, NOW)
  assert.deepEqual(readArtifactCoverageNote(db, fx.out.rootId, 'output-walk'), { task: 'output-walk', codes: ['lookback-limited'], complete: true, info: null, at: NOW })
  assert.equal(row(db, 'SELECT value FROM artifact_manager_state WHERE key = ?', `coverage-reason:${fx.out.rootId}`).value,
    JSON.stringify({ task: 'output-walk', codes: ['lookback-limited'], complete: true, at: NOW }), 'the stored JSON shape')
  assert.deepEqual([...listArtifactCoverageNotes(db).keys()].sort(), [fx.main.rootId, fx.out.rootId].sort())
  assert.equal(listArtifactCoverageNotes(db).get(fx.main.rootId)![0]!.info, 'nested-worktrees-registered')
  // Fail closed: a value of any other shape grants nothing (the removal checker relies on this).
  for (const raw of ['{', '[]', 'null', JSON.stringify({ codes: 'lookback-limited', complete: true }), JSON.stringify({ codes: ['lookback-limited', 'Not A Code'], complete: true }),
    JSON.stringify({ codes: [1], complete: true }), JSON.stringify({ codes: Array.from({ length: 33 }, () => 'x'), complete: true }), JSON.stringify({ codes: [], info: 'Bad Info', complete: true })]) {
    assert.equal(parseCoverageNote(raw), null, raw)
  }
  assert.equal(parseCoverageNote(JSON.stringify({ codes: ['x'], complete: 'yes' }))!.complete, false, 'only true is complete')
  assert.throws(() => writeArtifactCoverageNote(db, fx.out.rootId, 'output-walk', { codes: ['Bad Code'], complete: true }, NOW), /codes/)
  assert.throws(() => writeArtifactCoverageNote(db, fx.out.rootId, 'verify', { codes: [], complete: true }, NOW), /root task/)
})

// ---------------------------------------------------------------------------------------------------------------- Wave 2b

test('a root identity is checked against its own root, not the observing one, now that the observing root row is reused (PERF-GAP-3)', () => {
  const fx = fixture()
  const inner = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: '/home/u/out/sub', repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T(0))
  // Observed by the outer root, identified by the nested root: valid, keyed by the nested root's relative path.
  const ok = recordArtifactObservation(fx.db, working(fx.out, rootDoc(inner.rootId, 'a.md'), '/home/u/out/sub/a.md'), NOW)
  assert.equal(getArtifactDocument(fx.db, ok.documentId, PAGE).locations[0]!.path, '/home/u/out/sub/a.md')
  // The nested root's identity with a path relative to the observing root does not match it.
  assert.throws(() => recordArtifactObservation(fx.db, working(fx.out, rootDoc(inner.rootId, 'sub/b.md'), '/home/u/out/sub/b.md', { ino: '101' }), NOW), /does not match its root identity/)
  // And the observing root's own identity still has to match its own path.
  assert.throws(() => recordArtifactObservation(fx.db, working(fx.out, rootDoc(fx.out.rootId, 'c.md'), '/home/u/out/sub/c.md', { ino: '102' }), NOW), /does not match its root identity/)
  assert.throws(() => recordArtifactObservation(fx.db, working(fx.out, rootDoc('no-such-root', 'd.md'), '/home/u/out/d.md', { ino: '103' }), NOW), /unknown root/)
})

test('prepared statements are reused per connection only: another or a reopened connection never sees them (PERF-GAP-3)', () => {
  const a = fixture()
  const b = fixture()
  recordArtifactObservation(a.db, working(a.out, rootDoc(a.out.rootId, 'a.md'), '/home/u/out/a.md'), NOW)
  recordArtifactObservation(b.db, working(b.out, rootDoc(b.out.rootId, 'b.md'), '/home/u/out/b.md'), NOW)
  assert.deepEqual(listArtifactDocuments(a.db, {}, PAGE).rows.map(r => r.displayName), ['a.md'])
  assert.deepEqual(listArtifactDocuments(b.db, {}, PAGE).rows.map(r => r.displayName), ['b.md'])
  a.db.close()
  // b's statements still work after a closed, and a closed connection fails as it always did.
  assert.equal(listArtifactDocuments(b.db, {}, PAGE).total, 1)
  assert.throws(() => listArtifactDocuments(a.db, {}, PAGE))
  // More distinct statements than the bounded cache holds (each extension list is another SQL text): it is emptied, not broken.
  try {
    for (let n = 1; n <= 600; n++) {
      configureArtifactDocumentExtensions(['md', ...Array.from({ length: n }, (_, i) => `x${i}`)])
      assert.equal(listArtifactDocuments(b.db, {}, PAGE).total, 1)
    }
  } finally {
    configureArtifactDocumentExtensions([])
  }
  assert.deepEqual(listArtifactDocuments(b.db, {}, PAGE).rows.map(r => r.displayName), ['b.md'])
  b.db.close()
})

test('the statement cache drops its least recently used statements, never a hot write statement (fix round 1, R76)', () => {
  const fx = fixture(), { db, out } = fx
  const hot = `INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES (?, 'available', 'unknown', ?)`
  let prepares = 0
  const prepare = db.raw.prepare.bind(db.raw)
  db.raw.prepare = ((sql: string) => { if (sql === hot) prepares++; return prepare(sql) }) as typeof db.raw.prepare
  let n = 0
  const write = () => recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md', { ino: String(1000 + ++n), size: 10 + n }), NOW)
  try {
    write()
    // Thousands of one-off list statements (each extension list is another SQL text), with a write every 50 lists.
    for (let i = 1; i <= 1200; i++) {
      configureArtifactDocumentExtensions(['md', ...Array.from({ length: i }, (_, k) => `x${k}`)])
      assert.equal(listArtifactDocuments(db, {}, PAGE).total, 1)
      if (i % 50 === 0) write()
    }
  } finally {
    configureArtifactDocumentExtensions([])
  }
  assert.equal(count(db, 'artifact_versions'), n, 'every write made its version')
  assert.equal(prepares, 1, 'the hot write statement was prepared once and never evicted')
  db.close()
})

test('the start-up statistics discard looks first and takes the write lock only when there is something to delete (fix round 1, R76)', () => {
  const db = openTestDb()
  db.raw.exec('ANALYZE')
  db.raw.exec(`DELETE FROM sqlite_stat1`)
  const other = new DatabaseSync(db.path)
  try {
    other.exec('BEGIN IMMEDIATE')
    const t0 = performance.now()
    assert.equal(discardArtifactPlannerStatistics(db), 0, 'nothing to discard: no write lock wanted while another writer holds it')
    assert.ok(performance.now() - t0 < 1_000, `it did not wait for the lock: ${(performance.now() - t0).toFixed(0)} ms`)
    other.exec('ROLLBACK')
    db.raw.prepare(`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('artifacts', 'idx_artifacts_document', '10 10'), ('sessions', NULL, '3')`).run()
    assert.equal(discardArtifactPlannerStatistics(db), 1, 'statistics on the artifact tables are deleted, the others kept')
    assert.equal(count(db, 'sqlite_stat1'), 1)
  } finally {
    other.close()
    db.close()
  }
})

// ---------------------------------------------------------------------------------------------------------------- Wave 2b: derived state

// The Wave 2a rules exactly as the list evaluated them per document before PERF-GAP-1 (the reference for the stored values).
const OLD_AVAILABILITY = `CASE
  WHEN EXISTS (SELECT 1 FROM artifacts la WHERE la.document_id = d.document_id AND la.exists_state = 'present' AND COALESCE(la.verification_state, 'verified') = 'verified') THEN 'local'
  WHEN EXISTS (SELECT 1 FROM artifact_versions gv JOIN artifact_version_state gs ON gs.version_id = gv.version_id
               WHERE gv.document_id = d.document_id AND gv.kind IN ('commit', 'index') AND gs.availability = 'available') THEN 'git'
  WHEN EXISTS (SELECT 1 FROM artifacts ka WHERE ka.document_id = d.document_id AND ka.exists_state = 'present') THEN 'stale'
  WHEN EXISTS (SELECT 1 FROM artifact_versions uv JOIN artifact_version_state us ON us.version_id = uv.version_id
               WHERE uv.document_id = d.document_id AND uv.kind IN ('commit', 'index') AND us.availability = 'unknown') THEN 'stale'
  ELSE 'unavailable' END`
const OLD_AT_RISK = (extra: string) => `EXISTS (SELECT 1 FROM artifact_versions rv JOIN artifact_version_state rs ON rs.version_id = rv.version_id
  WHERE rv.document_id = d.document_id AND rs.preservation_state IN ('unique', 'unknown') ${extra} AND (
    (rv.kind = 'working' AND EXISTS (SELECT 1 FROM artifacts ra WHERE ra.artifact_id = rv.location_artifact_id AND ra.current_version_id = rv.version_id AND ra.exists_state = 'present'))
    OR (rv.kind = 'index' AND rs.availability IN ('available', 'unknown'))))`
const OLD_PRESERVATION = `CASE WHEN ${OLD_AT_RISK(`AND rs.preservation_state = 'unique'`)} THEN 'unique' WHEN ${OLD_AT_RISK('')} THEN 'unknown'
  WHEN EXISTS (SELECT 1 FROM artifact_versions pv JOIN artifact_version_state ps ON ps.version_id = pv.version_id WHERE pv.document_id = d.document_id AND ps.preservation_state = 'preserved') THEN 'preserved'
  ELSE 'unknown' END`
const DOCUMENT_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'json', 'sql']

/** Stored state that differs from the Wave 2a rules, read straight from the old per-document SQL. */
function oldRuleDrift(db: AtlasDb): unknown[] {
  return rows(db, `SELECT * FROM (SELECT d.document_id, d.availability, d.needs_preservation, ${OLD_AVAILABILITY} AS rule_availability, ${OLD_AT_RISK('')} AS rule_needs
    FROM artifact_documents d) WHERE availability IS NOT rule_availability OR needs_preservation IS NOT rule_needs`)
}

/** The grouped list exactly as Wave 2a computed it: per-document predicates, the same order, count and window. */
function oldList(db: AtlasDb, f: ArtifactDocumentFilters): { ids: string[]; total: number } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (f.q) {
    const fq = ftsQuery(f.q)
    const tokens = f.q.replace(/[^\p{L}\p{N}_.-]+/gu, ' ').split(' ').filter(Boolean).map(t => t.toLowerCase())
    if (fq && tokens.length) {
      clauses.push(`(d.document_id IN (SELECT fa.document_id FROM artifacts fa WHERE fa.artifact_id IN (SELECT artifact_id FROM artifacts_fts WHERE artifacts_fts MATCH ?))
        OR (${tokens.map(() => 'instr(lower(d.relative_path), ?) > 0').join(' AND ')}))`)
      params.push(fq, ...tokens)
    }
  }
  if (f.project !== undefined) { clauses.push('d.project_name = ?'); params.push(f.project) }
  if (f.extension !== undefined) { clauses.push('d.extension = ?'); params.push(f.extension) }
  if (f.sessionId !== undefined) { clauses.push('d.document_id IN (SELECT se.document_id FROM artifact_evidence se WHERE se.session_id = ?)'); params.push(f.sessionId) }
  if (f.source !== undefined) { clauses.push('EXISTS (SELECT 1 FROM artifact_evidence so WHERE so.document_id = d.document_id AND so.source = ?)'); params.push(f.source) }
  if (f.availability !== undefined) { clauses.push(`(${OLD_AVAILABILITY}) = ?`); params.push(f.availability) }
  if (f.needsPreservation !== undefined) clauses.push(f.needsPreservation ? OLD_AT_RISK('') : `NOT ${OLD_AT_RISK('')}`)
  const sensitive = f.sensitive ?? 'hide'
  if (sensitive === 'hide') clauses.push('d.protected = 0')
  else if (sensitive === 'only') clauses.push('d.protected = 1')
  if ((f.types ?? 'documents') === 'documents') { clauses.push(`d.extension IN (${DOCUMENT_EXTENSIONS.map(() => '?').join(', ')})`); params.push(...DOCUMENT_EXTENSIONS) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return {
    ids: rows(db, `SELECT d.document_id FROM artifact_documents d ${where} ORDER BY d.last_change_at DESC, d.document_id DESC`, ...params).map(r => r.document_id as string),
    total: row(db, `SELECT COUNT(*) AS n FROM artifact_documents d ${where}`, ...params).n as number,
  }
}

/** Version state rows whose rule copies (fix round 1, I1) differ from their version and location. */
function copyDrift(db: AtlasDb): unknown[] {
  return rows(db, `SELECT s.version_id, s.version_document_id, s.version_kind, s.live_copy FROM artifact_version_state s LEFT JOIN artifact_versions v ON v.version_id = s.version_id
    WHERE s.version_document_id IS NOT v.document_id OR s.version_kind IS NOT v.kind OR s.live_copy IS NOT EXISTS (SELECT 1 FROM artifacts a
      WHERE a.artifact_id = v.location_artifact_id AND a.current_version_id = v.version_id AND a.exists_state = 'present')`)
}

function rng(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Random sequences of the real writers (and of the raw updates other modules make: reconcile's verification states, a future
 * preservation writer, document merges): after every operation the stored availability and needs-preservation equal the Wave
 * 2a rules, and in the end every filter lists exactly what the old per-document SQL listed, in the same order, with the same
 * totals and the same displayed availability and preservation.
 */
test('derived document state never drifts from the availability and preservation rules under random writer sequences (PERF-GAP-1)', () => {
  // Fixed seeds, each reaching at least four of the document states with the rowid-ordered picks below (checked by the coverage assertion).
  for (const seed of [3, 4, 5, 19, 27, 38]) {
    const fx = fixture(), { db, repo, main, feat, out } = fx
    const r = rng(seed)
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!
    const names = ['a.md', 'b.md', 'notes/c.md', 'phi/d.md', 'report billing.md', 'e.pdf', 'f.ts', 'docs/g.csv']
    const hex = (n: number) => String(n).padStart(40, '0')
    let ino = 1000
    let minute = 1
    const now = () => T(Math.min(59, 30 + (minute++ % 29)))
    const working0 = (root: ArtifactRootRow, rel: string, tracked: boolean) => {
      const base = root.canonicalPath
      const identity = root.kind === 'checkout' ? repoDoc(repo, rel) : rootDoc(root.rootId, rel)
      const o = working(root, identity, `${base}/${rel}`, { ino: String(r() < 0.5 ? ino : ++ino), size: 10 + Math.floor(r() * 3), at: Math.floor(r() * 20) })
      if (root.kind === 'checkout') o.git = { repositoryId: repo, checkoutIdentity: root.checkoutIdentity!, gitPath: rel, objectFormat: 'sha1', mode: 0o100644, size: o.stat!.size, ...(tracked ? { blobOid: hex(o.stat!.size) } : {}) }
      return o
    }
    // Choices index into row lists, and document and version IDs are random UUIDs: those lists are read in insertion order (rowid),
    // not ID order, so a seed picks the same rows on every run (in ID order, 4 of 70 runs missed the coverage check on seed 6).
    const ops: Array<[string, () => void]> = [
      ['working (output)', () => { recordArtifactObservation(db, working0(out, pick(names), false), now()) }],
      ['working (checkout)', () => { recordArtifactObservation(db, working0(pick([main, feat]), pick(names), r() < 0.5), now()) }],
      ['commit', () => { recordArtifactObservation(db, commitObs(fx, pick(names), hex(Math.floor(r() * 9) + 1), hex(Math.floor(r() * 5) + 100)), now()) }],
      ['index', () => { recordArtifactObservation(db, indexObs(fx, pick(names), hex(Math.floor(r() * 4) + 200), r() < 0.8 ? 0 : 2), now()) }],
      ['evidence', () => {
        const rel = pick(names)
        recordArtifactEvidence(db, evidenceInput(out, rootDoc(out.rootId, rel), `/home/u/out/${rel}`, `hook:${seed}:${ino++}`), now())
      }],
      ['location missing/present', () => {
        const a = rows(db, 'SELECT artifact_id FROM artifacts ORDER BY artifact_id')
        if (a.length) setExistsState(db, pick(a).artifact_id as number, r() < 0.6 ? 'missing' : 'present', null, now())
      }],
      ['verification state (reconcile)', () => {
        const a = rows(db, 'SELECT artifact_id FROM artifacts ORDER BY artifact_id')
        if (a.length) db.raw.prepare('UPDATE artifacts SET verification_state = ? WHERE artifact_id = ?').run(pick(['unverified', 'verified', 'pending', null]), pick(a).artifact_id as number)
      }],
      ['git object checks', () => {
        const v = rows(db, `SELECT version_id FROM artifact_versions WHERE kind IN ('commit', 'index') ORDER BY rowid`)
        if (v.length) recordArtifactGitObjectChecks(db, [{ versionId: pick(v).version_id as string, object: pick(['present', 'missing', 'mismatch', 'unreadable'] as const) }], now())
      }],
      ['preservation (raw)', () => {
        const v = rows(db, 'SELECT version_id FROM artifact_versions ORDER BY rowid')
        if (v.length) db.raw.prepare('UPDATE artifact_version_state SET preservation_state = ? WHERE version_id = ?').run(pick(['preserved', 'unique', 'unknown']), pick(v).version_id as string)
      }],
      ['legacy location, backfill and adoption', () => {
        const rel = pick(names)
        upsertArtifact(db, { path: `/home/u/out/${rel}`, sizeBytes: 3, createdAt: T(1), projectName: null, now: T(1) })
        backfillLegacyArtifacts(db, null, 250, now())
        if (r() < 0.7) adoptProvisionalLocations(db, [{ path: `/home/u/out/${rel}`, rootId: out.rootId, identity: rootDoc(out.rootId, rel) }], now())
      }],
      ['merge (raw move of a location and its versions)', () => {
        const d = rows(db, 'SELECT document_id FROM artifact_documents ORDER BY rowid')
        const a = rows(db, 'SELECT artifact_id FROM artifacts WHERE document_id IS NOT NULL ORDER BY artifact_id')
        if (d.length && a.length) {
          const loc = pick(a).artifact_id as number, to = pick(d).document_id as string
          db.transaction(() => {
            db.raw.prepare('UPDATE artifact_versions SET document_id = ? WHERE location_artifact_id = ?').run(to, loc)
            db.raw.prepare('UPDATE artifacts SET document_id = ? WHERE artifact_id = ?').run(to, loc)
          })
        }
      }],
    ]
    for (let i = 0; i < 160; i++) {
      const [name, op] = pick(ops)
      op()
      assert.deepEqual(oldRuleDrift(db), [], `seed ${seed}, operation ${i} (${name}): stored state equals the Wave 2a rules`)
      assert.deepEqual(copyDrift(db), [], `seed ${seed}, operation ${i} (${name}): every version state row's rule copies match its version and location`)
    }
    assert.deepEqual(findArtifactDocumentStateDrift(db), [], 'the consistency check agrees')
    assert.ok(count(db, 'artifact_documents') >= 8, `seed ${seed} built a catalog`)
    const docs = rows(db, 'SELECT document_id FROM artifact_documents')
    const states = new Set(rows(db, 'SELECT availability || needs_preservation AS s FROM artifact_documents').map(x => x.s))
    assert.ok(states.size >= 4, `seed ${seed} reached several states: ${[...states].join(', ')}`)
    // Every filter lists what the old SQL listed (ids, order, total), and the displayed values are the rules' values.
    const filters: ArtifactDocumentFilters[] = [{}, { types: 'all', sensitive: 'show' }, { sensitive: 'only' }, { extension: 'md' }, { project: 'repo' }, { sessionId: S1 }, { source: 'hook' }]
    for (const a of ['local', 'git', 'stale', 'unavailable'] as const) filters.push({ availability: a }, { availability: a, types: 'all', sensitive: 'show' }, { availability: a, extension: 'md' })
    for (const n of [true, false]) filters.push({ needsPreservation: n }, { needsPreservation: n, sensitive: 'show', types: 'all' }, { needsPreservation: n, availability: 'local' })
    for (const q of ['report', 'billing report', 'notes', 'c.md', 'ort', 'zzz', 'a', '.']) filters.push({ q }, { q, types: 'all', sensitive: 'show' }, { q, availability: 'git' }, { q, project: 'repo', needsPreservation: true })
    for (const f of filters) {
      const expected = oldList(db, f)
      const got = listArtifactDocuments(db, f, { limit: 500, offset: 0 })
      assert.deepEqual(got.rows.map(x => x.documentId), expected.ids, `seed ${seed} ${JSON.stringify(f)}: same documents in the same order`)
      assert.equal(got.total, expected.total, `seed ${seed} ${JSON.stringify(f)}: same total`)
      assert.equal(listArtifactDocuments(db, f, { limit: 2, offset: 1 }).total, expected.total, 'the total does not depend on the page')
      assert.deepEqual(listArtifactDocuments(db, f, { limit: 2, offset: 1 }).rows.map(x => x.documentId), expected.ids.slice(1, 3), 'pagination windows the same order')
      const past = listArtifactDocuments(db, f, { limit: 3, offset: expected.total + 2 })
      assert.deepEqual([past.rows.length, past.total], [0, expected.total], 'a page past the end still carries the total')
    }
    for (const { document_id } of docs) {
      const shown = getArtifactDocument(db, document_id as string, PAGE).document
      const rule = row(db, `SELECT ${OLD_AVAILABILITY} AS a, ${OLD_PRESERVATION} AS p FROM artifact_documents d WHERE d.document_id = ?`, document_id as string)
      assert.deepEqual([shown.availability, shown.preservationState], [rule.a, rule.p], `seed ${seed}: displayed availability and preservation follow the rules`)
    }
    db.close()
  }
})

test('the derived state is rebuilt to the rules from any stored value, and the consistency check names the documents that drifted', () => {
  const fx = fixture(), { db, out } = fx
  const a = recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md'), NOW).documentId
  const b = recordArtifactObservation(db, commitObs(fx, 'docs/b.md', OID('1'), OID('2')), NOW).documentId
  assert.deepEqual(findArtifactDocumentStateDrift(db), [])
  db.raw.prepare(`UPDATE artifact_documents SET availability = 'unavailable', needs_preservation = 0 WHERE document_id = ?`).run(a)
  db.raw.prepare(`UPDATE artifact_documents SET availability = 'stale' WHERE document_id = ?`).run(b)
  assert.deepEqual(findArtifactDocumentStateDrift(db).map(x => x.documentId).sort(), [a, b].sort())
  assert.deepEqual(findArtifactDocumentStateDrift(db).find(x => x.documentId === a)!.derived, { availability: 'local', needsPreservation: 1 })
  assert.equal(listArtifactDocuments(db, { availability: 'local' }, PAGE).total, 0, 'the filters read the stored value')
  assert.equal(rebuildArtifactDocumentState(db), 2)
  assert.deepEqual(findArtifactDocumentStateDrift(db), [])
  assert.deepEqual(listArtifactDocuments(db, { availability: 'local' }, PAGE).rows.map(r => r.documentId), [a])
  assert.equal(rebuildArtifactDocumentState(db), 0, 'nothing to repair')
  db.close()
})

test('20,000 version state rows of one document are written in linear time (PERF-GAP-1)', () => {
  const fx = fixture(), { db } = fx
  const template = recordArtifactObservation(db, commitObs(fx, 'docs/long-history.md', OID('1'), OID('2')), NOW).versionId!
  // 20,000 commits of one document, every one unavailable: each state row's refresh is a few index seeks (fix round 1, I1:
  // the bound for every shape of a large document is the next test).
  db.raw.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
    INSERT INTO artifact_versions (version_id, document_id, kind, repository_id, commit_oid, git_path, object_format, blob_oid, mode, size_bytes, observed_at)
    SELECT printf('bulk-%06d', i), t.document_id, 'commit', t.repository_id, printf('%040d', i), t.git_path, t.object_format, t.blob_oid, t.mode, t.size_bytes, t.observed_at
    FROM n, (SELECT * FROM artifact_versions WHERE version_id = ?) t`).run(template)
  const t0 = performance.now()
  db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at)
    SELECT version_id, 'unavailable', 'unknown', ? FROM artifact_versions WHERE version_id >= 'bulk-' AND version_id < 'bulk.'`).run(NOW)
  const ms = performance.now() - t0
  assert.ok(ms < 5_000, `20,000 state rows of one document in ${ms.toFixed(0)} ms`)
  assert.deepEqual(findArtifactDocumentStateDrift(db), [])
  db.close()
})

// CPU time of this process (user + system, ms), not wall time: these bounds are about the work the statements do, and a loaded
// machine stretches wall time without changing it (R97).
const cpuNowMs = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
const medianCpuMs = (n: number, f: (i: number) => void): number => {
  const t: number[] = []
  for (let i = 0; i < n; i++) { const t0 = cpuNowMs(); f(i); t.push(cpuNowMs() - t0) }
  return t.sort((a, b) => a - b)[Math.floor(n / 2)]!
}

/**
 * Fix round 1 (I1): the refresh of a document's stored state is bounded whatever the shape of the document. Before, a probe
 * that found no matching row (no present verified location, no available Git version, no live copy at risk) read every
 * location and version of the document, so a large document made every write to it slow, and one UPDATE over its locations
 * quadratic: 2,000 locations took 3-7 s and object-check commits grew to 0.4 s. Each shape here has 2,000 locations (one working
 * version each) and 3,000 commits, every probe answering "no".
 */
test('the stored document state is refreshed in bounded time for every shape of a large document (fix round 1, I1)', () => {
  const fx = fixture(), { db, repo, main } = fx
  let shapes = 0
  const shape = (name: string, locations: number, location: LargeDocumentShape['location'], workingPreservation: LargeDocumentShape['workingPreservation']) =>
    addLargeDocument(db, { name: `${name}-${locations}-${shapes++}`, repositoryId: repo, rootId: main.rootId, locations, commits: Math.round(locations * 1.5), location, workingPreservation, commitAvailability: 'unavailable', at: NOW })
  const variants: Array<[string, LargeDocumentShape['location'], LargeDocumentShape['workingPreservation']]> = [
    ['missing', { exists: 'missing', verification: 'verified' }, 'unknown'],
    ['unverified-preserved', { exists: 'present', verification: 'unverified' }, 'preserved'],
  ]
  let rev = 10
  for (const [name, location, preservation] of variants) {
    const big = shape(name, 2000, location, preservation)
    const write = medianCpuMs(15, i => db.transaction(() => {
      const loc = big.locationIds[i * 97 % big.locationIds.length]!
      const id = `${big.documentId}-new-${rev++}`
      db.raw.prepare(`INSERT INTO artifact_versions (version_id, document_id, kind, location_artifact_id, observation_revision, stat_signature, observed_at) VALUES (?, ?, 'working', ?, ?, 'sig2', ?)`).run(id, big.documentId, loc, rev, NOW)
      db.raw.prepare(`INSERT INTO artifact_version_state (version_id, availability, preservation_state, checked_at) VALUES (?, 'available', ?, ?)`).run(id, preservation, NOW)
      db.raw.prepare('UPDATE artifacts SET current_version_id = ? WHERE artifact_id = ?').run(id, loc)
    }))
    assert.ok(write < 5, `${name}: a new working version (version, state, current) took ${write.toFixed(2)} CPU ms`)
    const flip = medianCpuMs(15, i => db.raw.prepare(`UPDATE artifacts SET verification_state = CASE WHEN verification_state IS 'pending' THEN ? ELSE 'pending' END WHERE artifact_id = ?`)
      .run(location.verification, big.locationIds[i * 31 % big.locationIds.length]!))
    assert.ok(flip < 5, `${name}: a verification flip of one location took ${flip.toFixed(2)} CPU ms`)
    // One UPDATE over every location of the document, against the same over a document a quarter its size: linear, not
    // quadratic (quadratic would make the ratio about 16).
    const bulk = (doc: string) => medianCpuMs(3, i => db.raw.prepare(`UPDATE artifacts SET verification_state = ? WHERE document_id = ?`).run(i % 2 ? location.verification : 'pending', doc))
    const large = bulk(big.documentId)
    const quarter = bulk(shape(name, 500, location, preservation).documentId)
    assert.ok(large < 500, `${name}: one UPDATE over 2,000 locations took ${large.toFixed(0)} CPU ms`)
    assert.ok(large / Math.max(quarter, 1) < 8, `${name}: 2,000 locations ${large.toFixed(1)} CPU ms against 500 locations ${quarter.toFixed(1)} CPU ms`)
  }
  // Object-check commits on a document whose 5,000 commits are proved missing one 256-check batch at a time: the cost of a
  // batch does not grow as fewer of the document's versions stay available.
  const p7 = addLargeDocument(db, { name: 'p7', repositoryId: repo, rootId: main.rootId, locations: 1, commits: 5000, location: { exists: 'missing', verification: 'verified' }, workingPreservation: 'unknown', commitAvailability: 'available', at: NOW })
  const batches: number[] = []
  for (let i = 0; i < p7.commitVersionIds.length; i += 256) {
    const checks = p7.commitVersionIds.slice(i, i + 256).map(versionId => ({ versionId, object: 'missing' as const }))
    const t0 = cpuNowMs()
    recordArtifactGitObjectChecks(db, checks, NOW)
    batches.push(cpuNowMs() - t0)
  }
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
  assert.ok(Math.max(...batches) < 100, `256-check object-check commits: ${batches.map(b => b.toFixed(0)).join(' ')} CPU ms`)
  assert.ok(sorted(batches.slice(-5))[2]! < 3 * sorted(batches.slice(0, 5))[2]! + 5, `no growth: ${batches.map(b => b.toFixed(1)).join(' ')} CPU ms`)
  assert.equal(row(db, 'SELECT availability FROM artifact_documents WHERE document_id = ?', p7.documentId).availability, 'unavailable')
  assert.deepEqual(findArtifactDocumentStateDrift(db), [], 'every large document still matches the rules\' definitions')
  db.close()
})

test('every probe of a refresh is one seek on all the key columns it needs, and nothing is scanned (fix round 1, I1)', () => {
  const db = openTestDb()
  const lines = plan(db, refreshArtifactDocumentStateSql(`'d1', 'd2'`).replace(/;\s*$/, ''))
  const probes = [...new Set(lines.filter(l => /^SEARCH (la|ln|ka|gs|us|rs) /.test(l)).map(l => l.replace(/ USING (COVERING )?INDEX /, ' ')))]
  assert.deepEqual(probes, [
    'SEARCH la idx_artifacts_document (document_id=? AND exists_state=? AND verification_state=?)',
    'SEARCH ln idx_artifacts_document (document_id=? AND exists_state=? AND verification_state=?)',
    'SEARCH gs idx_artifact_version_state_git (version_document_id=? AND availability=?)',
    'SEARCH ka idx_artifacts_document (document_id=? AND exists_state=?)',
    'SEARCH us idx_artifact_version_state_git (version_document_id=? AND availability=?)',
    'SEARCH rs idx_artifact_version_state_live_risk (version_document_id=? AND preservation_state=?)',
    'SEARCH rs idx_artifact_version_state_index_risk (version_document_id=? AND preservation_state=? AND availability=?)',
  ], lines.join(' | '))
  assert.deepEqual(lines.filter(l => /\bSCAN\b/.test(l)), [], 'nothing is scanned')
  assert.deepEqual(lines.filter(l => /artifact_versions/.test(l)), [], 'no probe reads a document\'s versions')
  // The copies' upkeep: primary-key lookups only.
  const copies = plan(db, refreshArtifactVersionRuleCopiesSql(`'v1'`).replace(/;\s*$/, ''))
  assert.deepEqual(copies.filter(l => !/^(SEARCH \S+ USING (INDEX sqlite_autoindex_\w+ \(version_id=\?\)|INTEGER PRIMARY KEY \(rowid=\?\))|CORRELATED SCALAR SUBQUERY \d+)$/.test(l)), [], copies.join(' | '))
  db.close()
})

// ---------------------------------------------------------------------------------------------------------------- fix round 1: I2

/** Everything a shape check could change: the schema, the row counts, and this connection's change counter. */
function catalogSnapshot(db: AtlasDb): unknown {
  const schema = rows(db, `SELECT type, name, sql FROM sqlite_schema ORDER BY type, name`)
  const counts = rows(db, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name`)
    .map(t => [t.name, row(db, `SELECT COUNT(*) AS n FROM "${t.name as string}"`).n])
  return { schema, counts, changes: row(db, 'SELECT total_changes() AS n').n }
}

test('a catalog migrated by a pre-release build of migration 9 is named object by object, read-only and fast; a current or unmigrated one passes (fix round 1, I2)', () => {
  const fx = fixture(), { db, out } = fx
  recordArtifactObservation(db, working(out, rootDoc(out.rootId, 'a.md'), '/home/u/out/a.md'), NOW)
  assert.deepEqual(artifactCatalogShapeProblems(db), [], 'this build\'s catalog')
  assert.doesNotThrow(() => assertArtifactCatalogShape(db))
  const t0 = performance.now()
  artifactCatalogShapeProblems(db)
  assert.ok(performance.now() - t0 < 50, `a few schema reads: ${(performance.now() - t0).toFixed(1)} ms`)
  // Migration 9 not applied yet (a schema-8 database): nothing to check, migration 9 will create everything.
  const eight = openDatabase(':memory:', { migrate: false })
  migrate(eight, MIGRATIONS.filter(m => m.id < 9))
  assert.deepEqual(artifactCatalogShapeProblems(eight), [])
  eight.close()

  // One trigger missing, then present under its name with an earlier body.
  db.raw.exec('DROP TRIGGER artifact_documents_state_version_state_insert')
  assert.deepEqual(artifactCatalogShapeProblems(db), ['missing trigger artifact_documents_state_version_state_insert'])
  db.raw.exec(`CREATE TRIGGER artifact_documents_state_version_state_insert AFTER INSERT ON artifact_version_state BEGIN SELECT 1; END`)
  assert.deepEqual(artifactCatalogShapeProblems(db), ['different trigger artifact_documents_state_version_state_insert'])

  // The whole pre-release shape: every missing object and column is named, and the refusal says what to do.
  toPreReleaseCatalog(db)
  const problems = artifactCatalogShapeProblems(db)
  for (const name of PRE_RELEASE_MISSING_INDEXES) assert.ok(problems.includes(`missing index ${name}`), `${name}: ${problems.join('; ')}`)
  for (const [table, column] of PRE_RELEASE_MISSING_COLUMNS) assert.ok(problems.includes(`missing column ${table}.${column}`), `${table}.${column}: ${problems.join('; ')}`)
  assert.ok(problems.includes('missing trigger artifact_documents_state_location_update'))
  assert.ok(problems.includes('different index idx_artifacts_document'), 'an index of the same name with other columns')
  const before = catalogSnapshot(db)
  assert.throws(() => assertArtifactCatalogShape(db), (err: Error) => {
    assert.match(err.message, /^artifact-catalog-prerelease-schema: .+ was migrated by a pre-release build of migration 9/)
    assert.match(err.message, /missing column artifact_documents\.availability/)
    assert.match(err.message, /Atlas has not changed the artifact catalog and will not start on it\. Back up the database file, then restore a backup taken before migration 9 ran, or recreate the database/)
    assert.doesNotMatch(err.message, /has not changed it/, 'the old wording claimed more than the service start can promise')
    return true
  })
  assert.deepEqual(catalogSnapshot(db), before, 'the check and the refusal change nothing')
  // Read-only: the same answer through a read-only connection.
  const ro = new DatabaseSync(db.path, { readOnly: true })
  try { assert.deepEqual(artifactCatalogShapeProblems({ raw: ro }), problems) } finally { ro.close() }
  db.close()
})

// ---------------------------------------------------------------------------------------------------------------- Wave 2b: F-STATS

/**
 * F-STATS (13b): a catalog analyzed while every location's document link was still empty (the perf fixture: seedBenchmark runs
 * ANALYZE on the legacy catalog) tells the planner that idx_artifacts_document matches every row. The grouped list's old
 * per-document availability predicate then scanned every location for every document (104 s for one request at 100,000).
 */
test('stale planner statistics cannot slow the grouped list, and the service start discards them (F-STATS)', () => {
  const db = openTestDb()
  seedBenchmark(db, { sessions: 40, artifacts: 6000 })
  assert.match(String(row(db, `SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_artifacts_document'`).stat), /^6000 6000\b/, 'the stale statistic: one value for every row')
  let cursor: string | null = null
  for (;;) { const r = backfillLegacyArtifacts(db, cursor, 250, NOW); cursor = r.cursor; if (r.done) break }
  assert.equal(count(db, 'artifact_documents'), 6000)
  const docPlan = (sql: string) => plan(db, sql).join(' | ')
  // The hazard: a document's locations looked up by a query the document index does not cover (a detail page's location list)
  // scan the whole table under the stale statistic. (Before fix round 1 the old per-document availability filter did too, and
  // took 104 s in 13b; with the document index keyed on (document, exists state, verification state) its probes stay seeks.)
  const someDoc = String(row(db, 'SELECT document_id FROM artifact_documents ORDER BY document_id LIMIT 1').document_id)
  const hazard = `SELECT path FROM artifacts WHERE document_id = '${someDoc}'`
  assert.match(docPlan(hazard), /^SCAN artifacts\b/, `stale statistics produce the bad plan: ${docPlan(hazard)}`)
  const oldFilter = `SELECT COUNT(*) AS n FROM artifact_documents d WHERE (${OLD_AVAILABILITY}) = 'local'`
  assert.match(docPlan(oldFilter), /SEARCH la USING (COVERING )?INDEX idx_artifacts_document\b/, `the availability probes keep their seeks: ${docPlan(oldFilter)}`)

  // Harmless already: the list filters read stored values and the rules' per-document subqueries name their indexes, so with
  // the stale statistics still in place every per-document lookup of a list query, its display or a write is an index search.
  const noLocationScan = (label: string, sql: string) => {
    const lines = plan(db, sql)
    assert.deepEqual(lines.filter(l => /^SCAN (la|ln|ka|ca|ra|fa|rv|iv|gv|uv|gs|us|rs|ps|pv|cv|artifacts|artifact_versions|artifact_version_state)\b/.test(l)), [], `${label}: ${lines.join(' | ')}`)
    for (const l of lines) {
      if (/^SEARCH (la|ln|ka|ca) /.test(l)) assert.match(l, /idx_artifacts_document\b/, `${label}: ${l}`)
      if (/^SEARCH (gs|us|rs|ps) /.test(l)) assert.match(l, /idx_artifact_version_state_(git|live_risk|index_risk|preserved)\b/, `${label}: ${l}`)
      if (/^SEARCH cv /.test(l)) assert.match(l, /idx_artifact_versions_document\b/, `${label}: ${l}`)
    }
  }
  for (const f of [{ availability: 'local' }, { availability: 'stale' }, { needsPreservation: true }, { needsPreservation: false }, {}] as ArtifactDocumentFilters[]) {
    const sql = listSql(db, f)
    noLocationScan(`count ${JSON.stringify(f)}`, sql.count)
    noLocationScan(`page ${JSON.stringify(f)}`, sql.page)
  }
  const someDocs = rows(db, 'SELECT document_id FROM artifact_documents ORDER BY document_id LIMIT 50').map(r => r.document_id as string)
  noLocationScan('display', `SELECT ${artifactDocumentAvailabilitySql('d.document_id')} AS a, ${artifactDocumentAtRiskSql('d.document_id')} AS p FROM artifact_documents d WHERE d.document_id = '${someDocs[0]}'`)
  noLocationScan('trigger refresh', refreshArtifactDocumentStateSql(`'${someDocs[0]}'`).replace(/;\s*$/, ''))
  noLocationScan('trigger copies', refreshArtifactVersionRuleCopiesSql(`'some-version'`).replace(/;\s*$/, ''))
  const t0 = performance.now()
  for (const f of [{ availability: 'local' }, { availability: 'unavailable' }, { needsPreservation: false }, { q: 'billing' }, {}] as ArtifactDocumentFilters[]) listArtifactDocuments(db, f, PAGE)
  db.raw.prepare(`UPDATE artifacts SET exists_state = 'missing' WHERE artifact_id IN (SELECT artifact_id FROM artifacts ORDER BY artifact_id LIMIT 200)`).run()
  const ms = performance.now() - t0
  assert.ok(ms < 2_000, `five list requests and 200 location writes with the stale statistics took ${ms.toFixed(0)} ms`)
  assert.deepEqual(findArtifactDocumentStateDrift(db), [])

  // The fix: the stale rows go, the planner forgets them, and the location lookup is an index search again.
  db.raw.exec(`INSERT INTO sqlite_stat1 (tbl, idx, stat) SELECT 'sessions', NULL, '40' WHERE NOT EXISTS (SELECT 1 FROM sqlite_stat1 WHERE tbl = 'sessions')`)
  const sessionsBefore = rows(db, `SELECT * FROM sqlite_stat1 WHERE tbl = 'sessions' ORDER BY idx`)
  const ruleIndexes = `idx IN ('idx_artifacts_document', 'idx_artifact_documents_availability', 'idx_artifact_documents_preservation')`
  assert.ok(count(db, 'sqlite_stat1', ruleIndexes) > 0, 'the analyzed catalog has statistics on the rules\' indexes')
  assert.ok(discardArtifactPlannerStatistics(db) > 0)
  assert.equal(count(db, 'sqlite_stat1', ruleIndexes), 0, 'and they are discarded with the rest (fix round 1)')
  assert.deepEqual(rows(db, `SELECT DISTINCT tbl FROM sqlite_stat1 WHERE tbl IN (SELECT value FROM json_each(?)) ORDER BY tbl`, JSON.stringify(ARTIFACT_MANAGER_TABLES)), [],
    'no statistics are left on the artifact manager tables')
  assert.ok(count(db, 'sqlite_stat1', `tbl = 'artifact_origins'`) > 0, 'the legacy origins table, which migration 9 does not change, keeps its statistics')
  assert.deepEqual(rows(db, `SELECT * FROM sqlite_stat1 WHERE tbl = 'sessions' ORDER BY idx`), sessionsBefore, 'statistics of other tables are kept')
  assert.match(docPlan(hazard), /^SEARCH artifacts USING INDEX idx_artifacts_document \(document_id=\?\)/, docPlan(hazard))
  assert.match(docPlan(oldFilter), /SEARCH la USING (COVERING )?INDEX idx_artifacts_document\b/, docPlan(oldFilter))
  const t1 = performance.now()
  db.raw.prepare(oldFilter).get()
  assert.ok(performance.now() - t1 < 2_000, `the old form runs on the index again: ${(performance.now() - t1).toFixed(0)} ms`)
  assert.equal(discardArtifactPlannerStatistics(db), 0, 'nothing left to discard')
  db.close()
})

// ---------------------------------------------------------------------------------------------------------------- PR #19 review, P2-2

/**
 * A hook that arrived before the checkout was registered: its file is authorized through a direct-only root on its folder and
 * its document is born with a ROOT identity (one location, one hook evidence row, one working version). The fixture's main
 * checkout (/home/u/repo) is the checkout the service later verifies.
 */
function hookBeforeRegistration(fx: Fx, rel = 'docs/plan.md', session = S1, checkout: ArtifactRootRow = fx.main) {
  const { db } = fx
  const folder = `${checkout.canonicalPath}/${rel.slice(0, rel.lastIndexOf('/'))}`, name = rel.slice(rel.lastIndexOf('/') + 1)
  const direct = registerArtifactRoot(db, { kind: 'session-directory', canonicalPath: folder, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T(1))
  const path = `${folder}/${name}`
  const { documentId } = recordArtifactEvidence(db, evidenceInput(direct, rootDoc(direct.rootId, name), path, `hook:${rel}`, { sessionId: session }), T(2))
  recordArtifactObservation(db, working(direct, rootDoc(direct.rootId, name), path, { at: 3, ino: '300' }), T(31))
  return { direct, path, documentId, rel }
}
const verified = (fx: Fx, path: string, rel: string, checkout: ArtifactRootRow = fx.main) => ({ path, rootId: checkout.rootId, identity: repoDoc(fx.repo, rel) })
const kindOfDocument = (db: AtlasDb, id: string) => (row(db, 'SELECT identity_kind AS k FROM artifact_documents WHERE document_id = ?', id).k as string)

test('P2-2: a root-identity document takes the repository identity in place when no repository document exists: same ID, nothing moves, and a second run changes nothing', () => {
  const fx = fixture(), { db } = fx
  const h = hookBeforeRegistration(fx)
  assert.equal(kindOfDocument(db, h.documentId), 'root')
  const before = { versions: rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), evidence: rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'), location: row(db, 'SELECT artifact_id, path, document_id, root_id, current_version_id FROM artifacts WHERE path = ?', h.path) }
  const docsBefore = count(db, 'artifact_documents')

  assert.deepEqual(adoptArtifactRepositoryIdentity(db, [verified(fx, h.path, h.rel)], T(40)), { reidentified: 1, merged: 0 })
  assert.deepEqual(row(db, 'SELECT identity_kind AS k, repository_id AS r, identity_root_id AS i, relative_path AS p, legacy_artifact_id AS l FROM artifact_documents WHERE document_id = ?', h.documentId),
    { k: 'repository', r: fx.repo, i: null, p: h.rel, l: null })
  assert.equal(count(db, 'artifact_documents'), docsBefore, 'no document was created or retired')
  assert.deepEqual(rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), before.versions, 'versions are untouched (content-addressed identities)')
  assert.deepEqual(rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'), before.evidence, 'evidence, including the original session evidence, is untouched')
  assert.deepEqual(row(db, 'SELECT artifact_id, path, document_id, root_id, current_version_id FROM artifacts WHERE path = ?', h.path), before.location)
  assert.equal(count(db, 'artifact_document_aliases'), 0, 'no ID changed, so no alias')

  // The path now belongs to the repository group: a later observation by repository identity finds this document.
  const again = recordArtifactObservation(db, working(fx.main, repoDoc(fx.repo, h.rel), h.path, { at: 6, ino: '300', size: 20, observedAt: 35 }), T(41))
  assert.equal(again.documentId, h.documentId)
  assert.equal(commitDocument(fx, h.rel, OID('a'), OID('b')), h.documentId, 'and so does the commit import: one document')
  const snapshot = [rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'), rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'), rows(db, 'SELECT * FROM artifact_document_aliases')]
  assert.deepEqual(adoptArtifactRepositoryIdentity(db, [verified(fx, h.path, h.rel)], T(42)), { reidentified: 0, merged: 0 }, 'idempotent')
  assert.deepEqual([rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'), rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'), rows(db, 'SELECT * FROM artifact_document_aliases')], snapshot)
  assert.deepEqual(findArtifactDocumentStateDrift(db), [])
  db.close()
})

/** A commit import for the main checkout: the document it lands in. */
function commitDocument(fx: Fx, rel: string, commit: string, blob: string, evidence?: Evidence): string {
  return recordArtifactObservation(fx.db, commitObs(fx, rel, commit, blob, evidence), T(45)).documentId
}

test('P2-2: with a repository document that already holds versions and evidence, the root-identity document merges into it: nothing is lost or duplicated, the old ID is an alias', () => {
  const fx = fixture(), { db } = fx
  const rel = 'docs/plan.md'
  // The repository document exists first: a commit with its trailer evidence, and the main checkout's own working copy.
  const survivor = commitDocument(fx, rel, OID('1'), OID('b'), { source: 'git', sessionId: S2, operation: 'touched', certainty: 'recorded', eventAt: T(10), eventKey: `git:${OID('1')}:${rel}` })
  recordArtifactObservation(db, working(fx.main, repoDoc(fx.repo, rel), `/home/u/repo/${rel}`, { at: 8, ino: '500', observedAt: 32, evidence: { eventKey: 'hook:main', sessionId: S2, operation: 'modified', certainty: 'recorded' } }), T(33))
  recordArtifactObservation(db, indexObs(fx, rel, OID('c')), T(34))
  // The hook that arrived before registration: root identity, with the original session evidence and two working versions.
  const h = hookBeforeRegistration(fx, rel, S1, fx.feat)
  recordArtifactObservation(db, working(h.direct, rootDoc(h.direct.rootId, 'plan.md'), h.path, { at: 4, ino: '300', size: 99, observedAt: 36 }), T(37))
  const born = h.documentId
  assert.notEqual(born, survivor)
  const counted = () => ({
    locations: count(db, 'artifacts', 'document_id IS NOT NULL'), versions: count(db, 'artifact_versions'), evidence: count(db, 'artifact_evidence'), states: count(db, 'artifact_version_state'),
    origins: count(db, 'artifact_origins'),
  })
  const before = counted()
  const evidenceKeys = rows(db, 'SELECT source_key FROM artifact_evidence ORDER BY source_key')
  const versionIds = rows(db, 'SELECT version_id, location_artifact_id, observation_revision, stat_signature, kind FROM artifact_versions ORDER BY version_id')
  assert.equal(count(db, 'artifact_versions', 'document_id = ?', born), 2, 'the hook document holds two working versions')

  assert.deepEqual(adoptArtifactRepositoryIdentity(db, [verified(fx, h.path, rel, fx.feat)], T(50)), { reidentified: 0, merged: 1 })
  assert.deepEqual(counted(), before, 'locations, versions, version states, evidence and legacy origins are all still there, each once')
  assert.deepEqual(rows(db, 'SELECT source_key FROM artifact_evidence ORDER BY source_key'), evidenceKeys)
  assert.deepEqual(rows(db, 'SELECT version_id, location_artifact_id, observation_revision, stat_signature, kind FROM artifact_versions ORDER BY version_id'), versionIds, 'version identities are unchanged')
  assert.equal(count(db, 'artifact_documents', 'document_id = ?', born), 0, 'the old document is retired')
  assert.equal(row(db, 'SELECT document_id AS d FROM artifact_document_aliases WHERE alias_id = ?', born).d, survivor, 'its ID is kept as an alias of the survivor')
  assert.deepEqual(rows(db, 'SELECT DISTINCT document_id FROM artifacts WHERE path IN (?, ?)', h.path, `/home/u/repo/${rel}`).map(r => r.document_id), [survivor], 'both checkouts\' locations belong to one document')
  assert.equal(count(db, 'artifact_evidence', 'document_id = ? AND session_id = ? AND source = ?', survivor, S1, 'hook'), 1, 'the original session evidence moved with the document')
  assert.equal(count(db, 'artifact_evidence', 'document_id = ?', born), 0)

  // Old links resolve: the detail of the retired ID is the survivor's, with every version, location and piece of evidence.
  const detail = getArtifactDocument(db, born, PAGE)
  assert.equal(detail.document.documentId, survivor)
  assert.equal(detail.locations.length, 2)
  assert.deepEqual(detail.versions.map(v => v.kind).sort(), ['commit', 'index', 'working', 'working', 'working'])
  assert.equal(detail.evidence.length, 3)
  assert.deepEqual(findArtifactDocumentStateDrift(db), [], 'stored availability and preservation agree with their definitions after the merge')
  const stateOf = rows(db, 'SELECT document_id, availability, needs_preservation FROM artifact_documents ORDER BY document_id')
  assert.equal(rebuildArtifactDocumentState(db), 0, 'and a full rebuild has nothing to change')
  assert.deepEqual(rows(db, 'SELECT document_id, availability, needs_preservation FROM artifact_documents ORDER BY document_id'), stateOf)
  assert.equal(count(db, 'artifact_version_state', 'version_document_id <> (SELECT document_id FROM artifact_versions v WHERE v.version_id = artifact_version_state.version_id)'), 0, 'every state row names its version\'s document')

  // A second run, and a run for the other path, change nothing.
  const snapshot = [rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'), rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'), rows(db, 'SELECT * FROM artifact_document_aliases')]
  assert.deepEqual(adoptArtifactRepositoryIdentity(db, [verified(fx, h.path, rel, fx.feat), verified(fx, `/home/u/repo/${rel}`, rel)], T(51)), { reidentified: 0, merged: 0 })
  assert.deepEqual([rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'), rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), rows(db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'), rows(db, 'SELECT * FROM artifact_document_aliases')], snapshot)
  db.close()
})

test('P2-2: a merge carries protection and the earliest dates over, keeps a real activity time, and re-points aliases that already named the retired document', () => {
  const fx = fixture(), { db } = fx
  const rel = 'docs/plan.md'
  const survivor = commitDocument(fx, rel, OID('1'), OID('b'))
  db.raw.prepare(`UPDATE artifact_documents SET last_change_at = ?, last_change_source = 'observed', first_observed_at = ? WHERE document_id = ?`).run(T(45), T(45), survivor)
  const h = hookBeforeRegistration(fx, rel, S1, fx.feat)
  db.raw.prepare(`UPDATE artifact_documents SET protected = 1, first_created_at = ?, project_name = 'drafts' WHERE document_id = ?`).run(T(2), h.documentId)
  // An earlier merge left an alias pointing at the hook document: it must follow to the survivor, not dangle on a deleted ID.
  db.raw.prepare(`INSERT INTO artifact_documents (document_id, identity_kind, repository_id, relative_path, display_name, first_observed_at) VALUES ('older', 'repository', ?, 'older.md', 'older.md', ?)`).run(fx.repo, T(0))
  assert.equal(mergeArtifactDocuments(db, 'older', h.documentId, T(3)), true)
  assert.equal(row(db, `SELECT document_id AS d FROM artifact_document_aliases WHERE alias_id = 'older'`).d, h.documentId)
  const hookRow = row(db, 'SELECT last_change_at AS at, last_change_source AS src, first_observed_at AS observed FROM artifact_documents WHERE document_id = ?', h.documentId)

  adoptArtifactRepositoryIdentity(db, [verified(fx, h.path, rel, fx.feat)], T(50))
  const merged = row(db, 'SELECT protected, first_created_at, first_observed_at, last_change_at, last_change_source, project_name, extension, display_name FROM artifact_documents WHERE document_id = ?', survivor)
  assert.equal(merged.protected, 1, 'protection is raise-only and carries over')
  assert.equal(merged.first_created_at, T(2))
  assert.equal(merged.first_observed_at, [hookRow.observed as string, T(45)].sort()[0])
  assert.deepEqual([merged.last_change_at, merged.last_change_source], [hookRow.at, hookRow.src], 'a real activity time replaces the survivor\'s fallback observation time')
  assert.equal(merged.project_name, 'repo', 'the survivor\'s own project is kept (the retired document\'s only fills a missing one)')
  assert.equal(row(db, 'SELECT is_sensitive AS s FROM artifacts WHERE path = ?', h.path).s, 1, 'and its locations are protected too')
  for (const alias of ['older', h.documentId]) assert.equal(row(db, 'SELECT document_id AS d FROM artifact_document_aliases WHERE alias_id = ?', alias).d, survivor, `${alias} resolves to the survivor`)
  assert.equal(getArtifactDocument(db, 'older', PAGE).document.documentId, survivor)

  assert.equal(mergeArtifactDocuments(db, survivor, survivor, T(60)), false, 'a document is never merged into itself')
  assert.equal(mergeArtifactDocuments(db, 'no-such-document', survivor, T(60)), false)
  assert.equal(mergeArtifactDocuments(db, survivor, 'no-such-document', T(60)), false)
  assert.equal(count(db, 'artifact_documents', 'document_id = ?', survivor), 1, 'a refused merge leaves both sides alone')
  db.close()
})

test('P2-2: only a root-identity document on a path the service verified under a registered repository is adopted', () => {
  const fx = fixture(), { db } = fx
  const h = hookBeforeRegistration(fx)
  const repoLocation = '/home/u/repo/README.md'
  recordArtifactObservation(db, working(fx.main, repoDoc(fx.repo, 'README.md'), repoLocation, { ino: '700' }), T(31))
  const provisional = upsertArtifact(db, { path: '/home/u/repo/legacy.md', sizeBytes: 1, createdAt: T(0), projectName: null, now: T(0) })
  backfillLegacyArtifacts(db, null, 10, T(5))
  const snapshot = () => [rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id'), rows(db, 'SELECT * FROM artifacts ORDER BY artifact_id'), rows(db, 'SELECT * FROM artifact_document_aliases')]
  const before = snapshot()
  const refused = [
    ['an already repository-identified location', verified(fx, repoLocation, 'README.md')],
    ['a provisional legacy document (the backfill adoption owns it)', verified(fx, '/home/u/repo/legacy.md', 'legacy.md')],
    ['a path nothing catalogued', verified(fx, '/home/u/repo/docs/nothing.md', 'docs/nothing.md')],
    ['a repository ID that is not registered', { path: h.path, rootId: fx.main.rootId, identity: repoDoc('no-such-repository', h.rel) }],
    ['a root identity (nothing is verified by it)', { path: h.path, rootId: fx.main.rootId, identity: rootDoc(fx.main.rootId, 'docs/plan.md') }],
    ['an unnormalized relative path', { path: h.path, rootId: fx.main.rootId, identity: repoDoc(fx.repo, 'docs/../plan.md') }],
    ['an absolute relative path', { path: h.path, rootId: fx.main.rootId, identity: repoDoc(fx.repo, '/docs/plan.md') }],
    ['a malformed identity', { path: h.path, rootId: fx.main.rootId, identity: null as unknown as ArtifactDocumentIdentity }],
  ] as const
  for (const [label, entry] of refused) {
    assert.deepEqual(adoptArtifactRepositoryIdentity(db, [entry], T(50)), { reidentified: 0, merged: 0 }, label)
    assert.deepEqual(snapshot(), before, label)
  }
  assert.deepEqual(adoptArtifactRepositoryIdentity(db, [], T(50)), { reidentified: 0, merged: 0 })
  assert.equal(provisional.artifactId > 0, true)
  assert.equal(kindOfDocument(db, h.documentId), 'root', 'the root-identity document was never touched')
  db.close()
})

test('P2-2: adoption raises protection the repository identity brings, and never lowers it', () => {
  const fx = fixture(), { db } = fx
  // A registered protected folder inside the checkout: a repository path under it is protected in every checkout of the repository.
  registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/repo/clinic', repositoryId: fx.repo, projectName: null, checkoutIdentity: 'ck-main', protected: true, scopeFlags: ['configured-output'] }, T(0))
  const h = hookBeforeRegistration(fx, 'docs/phi/notes.md')
  assert.equal(row(db, 'SELECT protected AS p FROM artifact_documents WHERE document_id = ?', h.documentId).p, 1, 'a phi segment protected it already')
  adoptArtifactRepositoryIdentity(db, [verified(fx, h.path, h.rel)], T(50))
  assert.equal(row(db, 'SELECT protected AS p FROM artifact_documents WHERE document_id = ?', h.documentId).p, 1, 'still protected under its repository identity')
  const plain = hookBeforeRegistration(fx, 'docs/clean.md')
  assert.equal(row(db, 'SELECT protected AS p FROM artifact_documents WHERE document_id = ?', plain.documentId).p, 0)
  adoptArtifactRepositoryIdentity(db, [verified(fx, plain.path, plain.rel)], T(50))
  assert.equal(row(db, 'SELECT protected AS p FROM artifact_documents WHERE document_id = ?', plain.documentId).p, 0, 'an ordinary document stays unprotected')
  db.close()
})

test('P2-2: root-identity locations under a checkout are listed in path order and pages, never a prefix sibling, a repository document or another root\'s document', () => {
  const fx = fixture(), { db } = fx
  const a = hookBeforeRegistration(fx, 'docs/a.md')
  const b = hookBeforeRegistration(fx, 'docs/b.md')
  const c = hookBeforeRegistration(fx, 'notes/c.md')
  recordArtifactObservation(db, working(fx.main, repoDoc(fx.repo, 'README.md'), '/home/u/repo/README.md', { ino: '700' }), T(31))
  recordArtifactObservation(db, working(fx.out, rootDoc(fx.out.rootId, 'x.md'), '/home/u/out/x.md', { ino: '701' }), T(31))
  const sibling = registerArtifactRoot(db, { kind: 'output', canonicalPath: '/home/u/repo-other', repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T(0))
  recordArtifactObservation(db, working(sibling, rootDoc(sibling.rootId, 'y.md'), '/home/u/repo-other/y.md', { ino: '702' }), T(31))

  const all = listRootIdentityLocations(db, '/home/u/repo', null, 10)
  assert.deepEqual(all.map(l => l.path), [a.path, b.path, c.path], 'only root-identity locations below the checkout, in path order')
  assert.deepEqual(all.map(l => l.documentId), [a.documentId, b.documentId, c.documentId])
  assert.deepEqual(listRootIdentityLocations(db, '/home/u/repo', null, 2).map(l => l.path), [a.path, b.path])
  assert.deepEqual(listRootIdentityLocations(db, '/home/u/repo', b.path, 2).map(l => l.path), [c.path], 'the page after a path starts strictly after it')
  assert.deepEqual(listRootIdentityLocations(db, '/home/u/repo', c.path, 2), [])
  assert.deepEqual(listRootIdentityLocations(db, '/home/u/repo/docs', null, 10).map(l => l.path), [a.path, b.path])
  adoptArtifactRepositoryIdentity(db, [verified(fx, a.path, a.rel)], T(50))
  assert.deepEqual(listRootIdentityLocations(db, '/home/u/repo', null, 10).map(l => l.path), [b.path, c.path], 'an adopted document is no longer listed')
  db.close()
})

test('P2-2: many root-identity documents are adopted in one transaction, each once, with the stored state consistent', () => {
  const fx = fixture(), { db } = fx
  const direct = registerArtifactRoot(db, { kind: 'session-directory', canonicalPath: '/home/u/repo/docs', repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T(1))
  const N = 1200
  db.transaction(() => {
    for (let i = 0; i < N; i++) recordArtifactObservation(db, working(direct, rootDoc(direct.rootId, `f${i}.md`), `/home/u/repo/docs/f${i}.md`, { ino: String(1000 + i), evidence: { eventKey: `hook:${i}`, sessionId: S1, operation: 'created', certainty: 'recorded' } }), T(31))
  })
  assert.equal(listRootIdentityLocations(db, '/home/u/repo', null, N + 1).length, N)
  const entries = listRootIdentityLocations(db, '/home/u/repo', null, N).map(l => verified(fx, l.path, l.path.slice('/home/u/repo/'.length)))
  const t0 = performance.now()
  assert.deepEqual(adoptArtifactRepositoryIdentity(db, entries, T(50)), { reidentified: N, merged: 0 })
  const ms = performance.now() - t0
  assert.ok(ms < 20_000, `${N} adoptions took ${ms.toFixed(0)} ms`)
  assert.equal(count(db, 'artifact_documents', "identity_kind = 'root'"), 0)
  assert.equal(count(db, 'artifact_documents', "identity_kind = 'repository'"), N)
  assert.equal(count(db, 'artifact_evidence'), N, 'no evidence lost or duplicated')
  assert.deepEqual(findArtifactDocumentStateDrift(db), [])
  db.close()
})

// ---------------------------------------------------------------------------------------------------------------- PR #19 review, P2-4

const versionOfEvidence = (db: AtlasDb, key: string): string | null => (row(db, 'SELECT version_id AS v FROM artifact_evidence WHERE source_key = ?', key).v as string | null)
/** A hook event of the session, reported (ingested) at minute `reported`; its write finished a minute earlier unless told otherwise. */
function reportEvent(fx: Fx, key: string, reported: number, extra: { operation?: Evidence['operation']; sessionId?: string; written?: number; source?: ArtifactEvidenceSource } = {}) {
  const out = fx.out
  return recordArtifactEvidence(fx.db, evidenceInput(out, rootDoc(out.rootId, 'draft.md'), '/home/u/out/draft.md', key, {
    operation: extra.operation ?? 'modified', sessionId: extra.sessionId ?? S1, eventAt: T(extra.written ?? reported - 1), source: extra.source,
  }), T(reported))
}
/** A stat of draft.md: `size` identifies the content (13 bytes is version A, 58 bytes is version B), `captured` is when the lstat began. */
function statDraft(fx: Fx, o: { size: number; captured?: number; observedAt: number; at?: number }, now = 59) {
  return recordArtifactObservation(fx.db, working(fx.out, rootDoc(fx.out.rootId, 'draft.md'), '/home/u/out/draft.md', { ino: '100', ...o }), T(now))
}

test('P2-4: a stat captured before an event never claims it, even when persisted after the event was reported; the correct later stat repairs the link (the reviewer\'s A/B reproduction)', () => {
  const fx = fixture(), { db } = fx
  // 1. The tool creates the file (version A, 13 bytes); the creating event is reported at minute 20.
  reportEvent(fx, 'hook:create', 20, { operation: 'created' })
  // 2. The worker lstat'ed A at minute 21, but its row is only handled much later. In between, the file became B (58 bytes) and the
  //    successful modification event was ingested at minute 30.
  reportEvent(fx, 'hook:modify', 30, { sessionId: S2 })
  // 3. The old stat is persisted at minute 41 (the row was built, and so "observed", at minute 40).
  const a = statDraft(fx, { size: 13, captured: 21, observedAt: 40, at: 10 }, 41)
  assert.equal(versionOfEvidence(db, 'hook:create'), a.versionId, 'the creation event was reported before the stat began: A is the content it wrote')
  assert.equal(versionOfEvidence(db, 'hook:modify'), null, 'the modification was reported after the stat began, so A (13 bytes) is not its content, whatever the row\'s observation time says')
  assert.equal(row(db, 'SELECT size_bytes AS s FROM artifact_versions WHERE version_id = ?', a.versionId!).s, 13)
  // 4. A later stat that did begin after the event sees B (58 bytes): its version is created and the modification now binds to it.
  const b = statDraft(fx, { size: 58, captured: 35, observedAt: 36, at: 29 }, 59)
  assert.notEqual(b.versionId, a.versionId)
  assert.equal(row(db, 'SELECT size_bytes AS s FROM artifact_versions WHERE version_id = ?', b.versionId!).s, 58)
  assert.equal(versionOfEvidence(db, 'hook:modify'), b.versionId, 'the NULL link is repaired to the version that holds the file the event wrote')
  assert.equal(versionOfEvidence(db, 'hook:create'), a.versionId, 'a bound link is never rewritten')
  assert.equal(count(db, 'artifact_evidence', 'version_id IS NULL'), 0)
  db.close()
})

test('P2-4: the reproduction without a capture time: a row that cannot say when its stat began binds nothing, however late its observation is', () => {
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:create', 20, { operation: 'created' })
  reportEvent(fx, 'hook:modify', 30)
  // The worker-batch row of the reviewer's reproduction: stat A (13 bytes) with only a late observation time.
  const a = statDraft(fx, { size: 13, observedAt: 40, at: 10 }, 41)
  assert.equal(count(db, 'artifact_evidence', 'version_id IS NOT NULL'), 0, 'neither event is attached to A')
  assert.equal(row(db, 'SELECT size_bytes AS s FROM artifact_versions WHERE version_id = ?', a.versionId!).s, 13)
  // The next stat does carry its capture time, but the previous version has none: nothing shows that the events predate A, so the
  // honest answer stays "unknown" (they remain at document level), never a guess.
  const b = statDraft(fx, { size: 58, captured: 35, observedAt: 36, at: 29 })
  assert.notEqual(b.versionId, a.versionId)
  assert.equal(count(db, 'artifact_evidence', 'version_id IS NOT NULL'), 0)
  // From here on every stat has its capture time, and a new event is correlated again.
  reportEvent(fx, 'hook:next', 50)
  const c = statDraft(fx, { size: 60, captured: 52, observedAt: 53, at: 49 })
  assert.equal(versionOfEvidence(db, 'hook:next'), c.versionId)
  assert.equal(versionOfEvidence(db, 'hook:modify'), null)
  db.close()
})

test('P2-4: a capture time that cannot be true binds nothing: after the row was built, in the future, or not a time', () => {
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:create', 20, { operation: 'created' })
  const bad: Array<[string, string]> = [['after its own observation', T(45)], ['in the future of the service clock', new Date(Date.parse(T(59)) + 3_600_000).toISOString()], ['not a time', 'yesterday-ish'], ['empty', '']]
  for (const [label, capturedAt] of bad) {
    const obs = { ...working(fx.out, rootDoc(fx.out.rootId, 'draft.md'), '/home/u/out/draft.md', { ino: '100', size: 13, observedAt: 40 }), capturedAt }
    recordArtifactObservation(db, obs, T(59))
    assert.equal(versionOfEvidence(db, 'hook:create'), null, label)
  }
  // The version those rows made keeps its observation time as its own: no capture time was believed.
  assert.equal(row(db, `SELECT observed_at AS o FROM artifact_versions WHERE kind = 'working'`).o, T(40))
  // A believable capture time binds the next event.
  reportEvent(fx, 'hook:later', 45)
  const seen = statDraft(fx, { size: 13, captured: 46, observedAt: 47 })
  assert.equal(versionOfEvidence(db, 'hook:later'), seen.versionId, 'a believable capture time binds')
  assert.equal(versionOfEvidence(db, 'hook:create'), null, 'the event the bad rows could not claim stays unbound')
  db.close()
})

test('P2-4: two writes reported before one stat: only the latest binds to the version, the earlier one describes content nobody observed and stays unbound for good', () => {
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:first', 20, { operation: 'created' })
  reportEvent(fx, 'hook:second', 21)
  const v = statDraft(fx, { size: 40, captured: 22, observedAt: 30 })
  assert.equal(versionOfEvidence(db, 'hook:second'), v.versionId)
  assert.equal(versionOfEvidence(db, 'hook:first'), null)
  // Neither an unchanged re-scan, nor a later change nobody reported, nor a later reported change claims the superseded one.
  statDraft(fx, { size: 40, captured: 26, observedAt: 31 })
  assert.equal(versionOfEvidence(db, 'hook:first'), null, 'an unchanged scan')
  const w = statDraft(fx, { size: 50, captured: 35, observedAt: 36, at: 33 })
  assert.notEqual(w.versionId, v.versionId)
  assert.equal(versionOfEvidence(db, 'hook:first'), null, 'a later change that no event reported')
  assert.equal(count(db, 'artifact_evidence', 'version_id = ?', w.versionId!), 0, 'and that change is not attributed to an event that belongs to older content')
  reportEvent(fx, 'hook:third', 40)
  const x = statDraft(fx, { size: 60, captured: 41, observedAt: 42, at: 40 })
  assert.equal(versionOfEvidence(db, 'hook:third'), x.versionId)
  assert.equal(versionOfEvidence(db, 'hook:first'), null)
  assert.equal(versionOfEvidence(db, 'hook:second'), v.versionId, 'a bound link is never rewritten')
  db.close()
})

test('P2-4: an event reported after the current version was captured is bound by a later unchanged scan; one already bound never moves', () => {
  const fx = fixture(), { db } = fx
  const v = statDraft(fx, { size: 13, captured: 10, observedAt: 11 })
  reportEvent(fx, 'hook:late', 20)
  // The same file seen again before the event: still unbound (the stat began before the event was reported).
  assert.equal(statDraft(fx, { size: 13, captured: 15, observedAt: 16 }).duplicate, true)
  assert.equal(versionOfEvidence(db, 'hook:late'), null)
  // Seen again after it, with the same signature: any write after the first capture would have changed it, so the event wrote this content.
  const again = statDraft(fx, { size: 13, captured: 25, observedAt: 26 })
  assert.equal(again.versionId, v.versionId)
  assert.equal(again.duplicate, false, 'attaching the pending event is new information')
  assert.equal(versionOfEvidence(db, 'hook:late'), v.versionId)
  // A later change does not move it.
  const w = statDraft(fx, { size: 99, captured: 35, observedAt: 36, at: 30 })
  assert.notEqual(w.versionId, v.versionId)
  assert.equal(versionOfEvidence(db, 'hook:late'), v.versionId)
  assert.equal(statDraft(fx, { size: 99, captured: 45, observedAt: 46, at: 30 }).duplicate, true, 'nothing left to attach: an unchanged scan is a no-op')
  db.close()
})

test('P2-4: unchanged scans create no churn: no version, no row written and no timestamp moved when nothing is pending', () => {
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:create', 20, { operation: 'created' })
  const v = statDraft(fx, { size: 13, captured: 25, observedAt: 26 })
  const snapshot = () => [rows(db, 'SELECT * FROM artifact_evidence ORDER BY source_key'), rows(db, 'SELECT * FROM artifact_versions ORDER BY version_id'), rows(db, 'SELECT * FROM artifacts ORDER BY artifact_id'), rows(db, 'SELECT * FROM artifact_documents ORDER BY document_id')]
  const before = snapshot()
  const writes = () => (row(db, 'SELECT total_changes() AS n').n as number)
  const w0 = writes()
  for (let i = 0; i < 5; i++) assert.equal(statDraft(fx, { size: 13, captured: 30 + i, observedAt: 31 + i }).duplicate, true)
  assert.equal(writes(), w0, 'five unchanged scans wrote nothing')
  assert.deepEqual(snapshot(), before)
  assert.equal(count(db, 'artifact_versions'), 1)
  assert.equal(v.duplicate, false)
  db.close()
})

test('P2-4: evidence whose write predates the previous capture (a late report) is not claimed by the next version, and legacy evidence never binds', () => {
  const fx = fixture(), { db } = fx
  const v = statDraft(fx, { size: 13, captured: 20, observedAt: 21 })
  // Reported at minute 25, but the write finished at minute 12: it is older than the content stat A showed at minute 20.
  reportEvent(fx, 'transcript:late', 25, { written: 12, source: 'transcript' })
  const w = statDraft(fx, { size: 70, captured: 30, observedAt: 31, at: 28 })
  assert.notEqual(w.versionId, v.versionId)
  assert.equal(versionOfEvidence(db, 'transcript:late'), null, 'a change after the report is not attributed to an event whose write happened before the previous stat')
  // A legacy origin is not an event about contents: it never binds, whatever the times.
  reportEvent(fx, 'legacy:origin', 22, { source: 'legacy', written: 21 })
  statDraft(fx, { size: 71, captured: 40, observedAt: 41, at: 38 })
  assert.equal(versionOfEvidence(db, 'legacy:origin'), null)
  db.close()
})

// PR #19 follow-up review, finding 3 (ruling R92): delivery order is not write order. A spooled event can arrive after a later write was
// already reported, so a stat binds by demonstrated write chronology only.
test('R92: an event delivered late (written first, reported last) does not take the version of a later write that was reported at once (the reviewer\'s case)', () => {
  for (const [label, order] of [['B delivered after C', ['B', 'C']], ['C reported first in the other order', ['C', 'B']]] as const) {
    const fx = fixture(), { db } = fx
    // B was written at 12:02 and spooled; C was written at 12:03 and reported at once; B reached the service at 12:04.
    const send = { B: () => reportEvent(fx, 'hook:B', 4, { written: 2 }), C: () => reportEvent(fx, 'hook:C', 3, { written: 3 }) }
    for (const k of order) send[k]()
    const c = statDraft(fx, { size: 58, captured: 5, observedAt: 6, at: 3 })
    assert.equal(versionOfEvidence(db, 'hook:C'), c.versionId, `${label}: C wrote the content the stat showed`)
    assert.equal(versionOfEvidence(db, 'hook:B'), null, `${label}: B's write was earlier and its content was never observed`)
    db.close()
  }
})

test('R92: the same report time in either insertion order binds the later write, not the later row', () => {
  for (const order of [['B', 'C'], ['C', 'B']] as const) {
    const fx = fixture(), { db } = fx
    const send = { B: () => reportEvent(fx, 'hook:B', 4, { written: 2 }), C: () => reportEvent(fx, 'hook:C', 4, { written: 3 }) }
    for (const k of order) send[k]()
    const c = statDraft(fx, { size: 58, captured: 5, observedAt: 6, at: 3 })
    assert.equal(versionOfEvidence(db, 'hook:C'), c.versionId, order.join(','))
    assert.equal(versionOfEvidence(db, 'hook:B'), null, order.join(','))
    db.close()
  }
})

test('R92: events in write order still bind the later write (unchanged behaviour)', () => {
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:B', 3, { written: 2 })
  reportEvent(fx, 'hook:C', 4, { written: 3 })
  const c = statDraft(fx, { size: 58, captured: 5, observedAt: 6, at: 3 })
  assert.equal(versionOfEvidence(db, 'hook:C'), c.versionId)
  assert.equal(versionOfEvidence(db, 'hook:B'), null)
  db.close()
})

test('R92: two candidates with the same write time cannot show which is latest: neither binds, and a later change is not blamed on them', () => {
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:B', 3, { written: 2 })
  reportEvent(fx, 'hook:C', 4, { written: 2 })
  statDraft(fx, { size: 58, captured: 5, observedAt: 6, at: 3 })
  assert.equal(count(db, 'artifact_evidence', 'version_id IS NOT NULL'), 0)
  db.close()
})

test('R92: with two candidates, one without a demonstrated write time (event time after its own report) binds nothing; a single such candidate still binds', () => {
  for (const order of [['B', 'C'], ['C', 'B']] as const) {
    const fx = fixture(), { db } = fx
    // C's event time (minute 9) is later than its own report (minute 4): not believable, so its write time is not demonstrated.
    const send = { B: () => reportEvent(fx, 'hook:B', 3, { written: 2 }), C: () => reportEvent(fx, 'hook:C', 4, { written: 9 }) }
    for (const k of order) send[k]()
    statDraft(fx, { size: 58, captured: 5, observedAt: 6, at: 3 })
    assert.equal(count(db, 'artifact_evidence', 'version_id IS NOT NULL'), 0, order.join(','))
    db.close()
  }
  const fx = fixture(), { db } = fx
  reportEvent(fx, 'hook:only', 4, { written: 9 })
  const v = statDraft(fx, { size: 58, captured: 5, observedAt: 6, at: 3 })
  assert.equal(versionOfEvidence(db, 'hook:only'), v.versionId, 'a single candidate binds even when only its report time is known')
  db.close()
})

test('P2-4: a version\'s observation time is the capture time of its stat when the row carries one', () => {
  const fx = fixture(), { db } = fx
  const withCapture = statDraft(fx, { size: 13, captured: 20, observedAt: 26 })
  assert.equal(row(db, 'SELECT observed_at AS o FROM artifact_versions WHERE version_id = ?', withCapture.versionId!).o, T(20))
  assert.equal(row(db, 'SELECT last_verified_at AS v FROM artifacts WHERE path = ?', '/home/u/out/draft.md').v, T(26), 'verification still records when the row was handled')
  const without = statDraft(fx, { size: 14, observedAt: 33, at: 30 })
  assert.equal(row(db, 'SELECT observed_at AS o FROM artifact_versions WHERE version_id = ?', without.versionId!).o, T(33))
  db.close()
})

// PR #19 review item 7: a backfilled (migrated) non-Git file has a document but no observation signature. Its first verified stat
// must initialise the document's activity from the file's mtime, bounded, without touching creation dates, creator or evidence.
const summary = (db: AtlasDb, documentId: string) => getArtifactDocument(db, documentId, PAGE).document
const dates = (db: AtlasDb, documentId: string) => ({ ...db.raw.prepare('SELECT first_observed_at, first_created_at FROM artifact_documents WHERE document_id = ?').get(documentId) as object })

function migratedFile(fx: Fx, name: string): { path: string; artifactId: number; documentId: string } {
  const path = `/home/u/out/${name}`
  const row = upsertArtifact(fx.db, { path, sizeBytes: 10, createdAt: T(1), projectName: 'reports', now: T(1) })
  addOrigin(fx.db, row.artifactId, S1, 'creator', 'tool_event', T(1))
  backfillLegacyArtifacts(fx.db, null, 250, T(2))
  const doc = fx.db.raw.prepare('SELECT document_id FROM artifacts WHERE artifact_id = ?').get(row.artifactId) as { document_id: string }
  return { path, artifactId: row.artifactId, documentId: doc.document_id }
}

test('the first verified observation of a migrated file initialises its activity from the bounded mtime (review item 7)', () => {
  const fx = fixture()
  try {
    const m = migratedFile(fx, 'migrated.md')
    const before = summary(fx.db, m.documentId)
    const datesBefore = dates(fx.db, m.documentId)
    assert.equal(before.activityAt, T(1))
    assert.deepEqual(ids(fx.db, { from: T(14) }), [], 'the stale legacy date hides the document from from=12:14')

    recordArtifactObservation(fx.db, working(fx.out, rootDoc(fx.out.rootId, 'migrated.md'), m.path, { at: 15, captured: 29 }), NOW)
    const after = summary(fx.db, m.documentId)
    assert.equal(after.activityAt, T(15))
    assert.equal(after.activitySource, 'mtime')
    assert.deepEqual(dates(fx.db, m.documentId), datesBefore, 'the observation and creation dates are not rewritten')
    assert.deepEqual(after.sessionAssociations, before.sessionAssociations, 'session attribution is unchanged')
    assert.deepEqual(ids(fx.db, { from: T(14) }), ['migrated.md'])
    assert.deepEqual(ids(fx.db, { from: T(16) }), [])

    // A later unchanged scan is a no-op.
    const snapshot = JSON.stringify(fx.db.raw.prepare('SELECT * FROM artifact_documents').all())
    recordArtifactObservation(fx.db, working(fx.out, rootDoc(fx.out.rootId, 'migrated.md'), m.path, { at: 15, observedAt: 45, captured: 44 }), NOW)
    assert.equal(JSON.stringify(fx.db.raw.prepare('SELECT * FROM artifact_documents').all()), snapshot)
  } finally { fx.db.close() }
})

test('the first observation of a migrated file bounds a future mtime and never lowers existing activity (review item 7)', () => {
  const fx = fixture()
  try {
    const future = migratedFile(fx, 'future.md')
    recordArtifactObservation(fx.db, working(fx.out, rootDoc(fx.out.rootId, 'future.md'), future.path, { at: 50, captured: 29 }), NOW)
    assert.equal(summary(fx.db, future.documentId).activityAt, T(1), 'an mtime after the observation is not believed')

    const older = migratedFile(fx, 'older.md')
    fx.db.raw.prepare('UPDATE artifact_documents SET last_change_at = ?, last_change_source = ? WHERE document_id = ?').run(T(20), 'hook', older.documentId)
    recordArtifactObservation(fx.db, working(fx.out, rootDoc(fx.out.rootId, 'older.md'), older.path, { at: 10, captured: 29 }), NOW)
    assert.equal(summary(fx.db, older.documentId).activityAt, T(20))
  } finally { fx.db.close() }
})

// PR #19 follow-up review, finding 2 (ruling R91): a location seen again applies the CURRENT path policy, raise-only. A row written
// under the narrower pre-91f60d8 rule (flags at 0 for a `.phi` path) is repaired by the next observation, whatever branch it takes.
function flagsOf(db: AtlasDb, path: string): { sensitive: number; protectedDoc: number } {
  const r = db.raw.prepare('SELECT a.is_sensitive AS s, d.protected AS p FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.path = ?').get(path) as { s: number; p: number }
  return { sensitive: r.s, protectedDoc: r.p }
}
function makeStale(db: AtlasDb, path: string): void {
  db.raw.prepare('UPDATE artifacts SET is_sensitive = 0 WHERE path = ?').run(path)
  db.raw.prepare('UPDATE artifact_documents SET protected = 0 WHERE document_id = (SELECT document_id FROM artifacts WHERE path = ?)').run(path)
}

test('an unchanged rescan of a .phi location with stale flags raises both flags (same signature, no new version)', () => {
  const fx = fixture()
  try {
    const path = '/home/u/out/.phi/synthetic-report.md'
    const id = rootDoc(fx.out.rootId, '.phi/synthetic-report.md')
    const first = recordArtifactObservation(fx.db, working(fx.out, id, path), NOW)
    assert.deepEqual(flagsOf(fx.db, path), { sensitive: 1, protectedDoc: 1 }, 'a new row is classified by the current rule')
    makeStale(fx.db, path)
    const again = recordArtifactObservation(fx.db, working(fx.out, id, path), NOW)
    assert.equal(again.versionId, first.versionId, 'the same signature: no new version')
    assert.deepEqual(flagsOf(fx.db, path), { sensitive: 1, protectedDoc: 1 })
  } finally { fx.db.close() }
})

test('a changed rescan, a hook event for a known location and an index/commit re-observation also raise stale flags', () => {
  const fx = fixture()
  try {
    const path = '/home/u/out/.PHI/synthetic-report.md'
    const id = rootDoc(fx.out.rootId, '.PHI/synthetic-report.md')
    recordArtifactObservation(fx.db, working(fx.out, id, path), NOW)
    makeStale(fx.db, path)
    recordArtifactObservation(fx.db, working(fx.out, id, path, { size: 99, at: 10 }), NOW)
    assert.deepEqual(flagsOf(fx.db, path), { sensitive: 1, protectedDoc: 1 }, 'a changed signature')

    makeStale(fx.db, path)
    recordArtifactEvidence(fx.db, evidenceInput(fx.out, id, path, 'hook:stale-1', { operation: 'modified', eventAt: T(20) }), NOW)
    assert.deepEqual(flagsOf(fx.db, path), { sensitive: 1, protectedDoc: 1 }, 'a hook event naming the known location')

    const rel = 'docs/.phi/synthetic-plan.md'
    const idx = recordArtifactObservation(fx.db, indexObs(fx, rel, OID('a')), NOW)
    fx.db.raw.prepare('UPDATE artifact_documents SET protected = 0 WHERE document_id = ?').run(idx.documentId)
    recordArtifactObservation(fx.db, indexObs(fx, rel, OID('a')), NOW)
    assert.equal((fx.db.raw.prepare('SELECT protected FROM artifact_documents WHERE document_id = ?').get(idx.documentId) as { protected: number }).protected, 1, 'an unchanged index entry')
    fx.db.raw.prepare('UPDATE artifact_documents SET protected = 0 WHERE document_id = ?').run(idx.documentId)
    recordArtifactObservation(fx.db, commitObs(fx, rel, OID('c'), OID('a')), NOW)
    assert.equal((fx.db.raw.prepare('SELECT protected FROM artifact_documents WHERE document_id = ?').get(idx.documentId) as { protected: number }).protected, 1, 'a commit observation')
  } finally { fx.db.close() }
})

test('a location protected for another reason is never lowered by a rescan, an event or the backfill', () => {
  const fx = fixture()
  try {
    const path = '/home/u/out/ordinary-notes.md'
    const id = rootDoc(fx.out.rootId, 'ordinary-notes.md')
    recordArtifactObservation(fx.db, working(fx.out, id, path), NOW)
    fx.db.raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE path = ?').run(path)
    fx.db.raw.prepare('UPDATE artifact_documents SET protected = 1 WHERE document_id = (SELECT document_id FROM artifacts WHERE path = ?)').run(path)
    recordArtifactObservation(fx.db, working(fx.out, id, path), NOW)
    recordArtifactObservation(fx.db, working(fx.out, id, path, { size: 77, at: 12 }), NOW)
    recordArtifactEvidence(fx.db, evidenceInput(fx.out, id, path, 'hook:keep-1', { operation: 'modified', eventAt: T(21) }), NOW)
    backfillLegacyArtifacts(fx.db, null, 250, NOW)
    assert.deepEqual(flagsOf(fx.db, path), { sensitive: 1, protectedDoc: 1 })
  } finally { fx.db.close() }
})

test('a backfill re-run raises stale flags on a location that already has a document', () => {
  const fx = fixture()
  try {
    const path = '/home/u/out/.phi/synthetic-report.md'
    const id = rootDoc(fx.out.rootId, '.phi/synthetic-report.md')
    recordArtifactObservation(fx.db, working(fx.out, id, path), NOW)
    makeStale(fx.db, path)
    backfillLegacyArtifacts(fx.db, null, 250, NOW)
    assert.deepEqual(flagsOf(fx.db, path), { sensitive: 1, protectedDoc: 1 })
  } finally { fx.db.close() }
})

// ---------------------------------------------------------------------------------------------------------------- settle before version

const C = Date.parse(T(10))
const iso = (ms: number) => new Date(ms).toISOString()
const SETTLE_PATH = (name = 'draft.md') => `/home/u/out/${name}`

/** A fresh-stat working row on the output root: mtime and ctime are both `ctimeMs`. */
function settleStat(fx: Fx, o: { ctimeMs: number; capturedMs?: number; observedMs: number; size: number; ino?: string; name?: string }): ArtifactWorkerObservation {
  const name = o.name ?? 'draft.md'
  return {
    rootId: fx.out.rootId, identity: rootDoc(fx.out.rootId, name), kind: 'working', observedAt: iso(o.observedMs), path: SETTLE_PATH(name),
    ...(o.capturedMs !== undefined ? { capturedAt: iso(o.capturedMs) } : {}),
    stat: { dev: '1', ino: o.ino ?? '100', size: o.size, mtimeMs: o.ctimeMs, ctimeMs: o.ctimeMs },
  }
}

/** Enqueue (generation 1), claim, commit one complete batch with the quiet period, and finish, at `nowMs`. */
function runAt(fx: Fx, scopeId: string, taskKind: 'output-walk' | 'checkout-status' | 'direct-observation' | 'verify', observations: ArtifactWorkerObservation[], nowMs: number, quietMs?: number,
  priority: number = ARTIFACT_JOB_PRIORITY.recovery): { jobId: string; deferredPaths: string[] } {
  const now = iso(nowMs)
  const jobId = enqueueArtifactJob(fx.db, { scopeId, taskKind, priority, generation: 1 }, now)
  const job = claimArtifactJob(fx.db, now)
  assert.equal(job?.jobId, jobId)
  const result = commitArtifactBatch(fx.db, jobId, job!.desiredGeneration, observations, { cursor: null, coverage: 'complete', complete: true }, now, quietMs === undefined ? undefined : { quietMs })
  finishArtifactJob(fx.db, jobId, { complete: true, coverage: 'complete' }, now)
  return { jobId, deferredPaths: result.deferredPaths }
}

const directScope = (fx: Fx, name = 'draft.md') => artifactDirectScopeId(fx.out.rootId, SETTLE_PATH(name))
const directJob = (fx: Fx, name?: string) => fx.db.raw.prepare(`SELECT * FROM artifact_jobs WHERE scope_id = ? AND task_kind = 'direct-observation'`).get(directScope(fx, name)) as Record<string, unknown> | undefined
const walk = (fx: Fx, rows: ArtifactWorkerObservation[], nowMs: number, quietMs = 2000) => runAt(fx, fx.out.rootId, 'output-walk', rows, nowMs, quietMs)
const versionCount = (fx: Fx) => count(fx.db, 'artifact_versions', "kind = 'working'")

test('settle: a stat taken while the file is still being written records nothing and schedules its direct check; the settled stat records exactly one version', () => {
  const fx = fixture()
  try {
    const first = walk(fx, [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    assert.deepEqual(first.deferredPaths, ['/home/u/out/draft.md'])
    for (const table of ['artifacts', 'artifact_documents', 'artifact_versions']) assert.equal(count(fx.db, table), 0, table)
    assert.deepEqual({ state: directJob(fx)?.state, retry_at: directJob(fx)?.retry_at, last_error: directJob(fx)?.last_error }, { state: 'retry', retry_at: iso(C + 2000), last_error: 'settling' })

    walk(fx, [settleStat(fx, { ctimeMs: C + 150, capturedMs: C + 200, observedMs: C + 200, size: 58 })], C + 200)
    assert.equal(versionCount(fx), 0)
    assert.equal(directJob(fx)?.retry_at, iso(C + 2150))
    assert.equal(count(fx.db, 'artifact_jobs', "task_kind = 'direct-observation'"), 1)

    const at = iso(C + 2150)
    const job = claimArtifactJob(fx.db, at)
    assert.equal(job?.scopeId, directScope(fx))
    commitArtifactBatch(fx.db, job!.jobId, job!.desiredGeneration, [settleStat(fx, { ctimeMs: C + 150, capturedMs: C + 2150, observedMs: C + 2150, size: 58 })],
      { cursor: null, coverage: 'complete', complete: true }, at, { quietMs: 2000 })
    finishArtifactJob(fx.db, job!.jobId, { complete: true, coverage: 'complete' }, at)
    assert.equal(versionCount(fx), 1)
    assert.equal(row(fx.db, `SELECT size_bytes FROM artifact_versions WHERE kind = 'working'`).size_bytes, 58)
    assert.equal(directJob(fx), undefined)
  } finally { fx.db.close() }
})

test('settle: without a capture time the age is measured from observedAt', () => {
  const fx = fixture()
  try {
    const r = runAt(fx, directScope(fx), 'direct-observation', [settleStat(fx, { ctimeMs: C, observedMs: C + 100, size: 5 })], C + 100, 2000)
    assert.deepEqual(r.deferredPaths, ['/home/u/out/draft.md'])
    assert.equal(directJob(fx)?.retry_at, iso(C + 2000))
  } finally { fx.db.close() }
})

test('settle: a tool that reported the write after the file last changed lets a fresh stat record at once; a report from before the change does not', () => {
  const report = (fx: Fx, reportedAt: number, eventAt: number) =>
    recordArtifactEvidence(fx.db, evidenceInput(fx.out, rootDoc(fx.out.rootId, 'draft.md'), SETTLE_PATH(), 'hook:settle', { eventAt: iso(eventAt) }), iso(reportedAt))
  {
    const fx = fixture()
    try {
      report(fx, C + 50, C + 40)
      const r = runAt(fx, directScope(fx), 'direct-observation', [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 7 })], C + 100, 2000)
      assert.equal(versionCount(fx), 1)
      assert.equal(row(fx.db, `SELECT version_id FROM artifact_evidence WHERE source_key = 'hook:settle'`).version_id, row(fx.db, `SELECT version_id FROM artifact_versions WHERE kind = 'working'`).version_id)
      assert.deepEqual(r.deferredPaths, [])
    } finally { fx.db.close() }
  }
  {
    const fx = fixture()
    try {
      report(fx, C - 50, C - 60)
      const r = runAt(fx, directScope(fx), 'direct-observation', [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 7 })], C + 100, 2000)
      assert.equal(versionCount(fx), 0)
      assert.deepEqual(r.deferredPaths, ['/home/u/out/draft.md'])
    } finally { fx.db.close() }
  }
  {
    const fx = fixture()
    try {
      report(fx, C + 50, C + 40)
      runAt(fx, directScope(fx), 'direct-observation', [settleStat(fx, { ctimeMs: C + 50.7, capturedMs: C + 100, observedMs: C + 100, size: 7 })], C + 100, 2000)
      assert.equal(versionCount(fx), 1)
    } finally { fx.db.close() }
  }
})

test('settle: a ctime more than one quiet period in the future records at once (clock guard)', () => {
  const a = fixture()
  try {
    runAt(a, directScope(a), 'direct-observation', [settleStat(a, { ctimeMs: C + 6000, capturedMs: C, observedMs: C, size: 3 })], C, 2000)
    assert.equal(versionCount(a), 1)
  } finally { a.db.close() }
  const b = fixture()
  try {
    const r = runAt(b, directScope(b), 'direct-observation', [settleStat(b, { ctimeMs: C + 1000, capturedMs: C, observedMs: C, size: 3 })], C, 2000)
    assert.deepEqual(r.deferredPaths, ['/home/u/out/draft.md'])
    assert.equal(directJob(b)?.retry_at, iso(C + 3000))
  } finally { b.db.close() }
})

test('settle: a skip during the same path\'s direct check leaves that job in retry at the new due time', () => {
  const fx = fixture()
  try {
    runAt(fx, directScope(fx), 'direct-observation', [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100, 2000, ARTIFACT_JOB_PRIORITY.direct)
    const job = directJob(fx)
    assert.ok(job)
    assert.deepEqual({ state: job.state, retry_at: job.retry_at, last_error: job.last_error, priority: job.priority }, { state: 'retry', retry_at: iso(C + 2000), last_error: 'settling', priority: ARTIFACT_JOB_PRIORITY.direct })
    assert.ok(Number(job.desired_generation) > Number(job.applied_generation))
    const at = iso(C + 2000)
    const claimed = claimArtifactJob(fx.db, at)
    assert.equal(claimed?.jobId, job.job_id)
    commitArtifactBatch(fx.db, claimed!.jobId, claimed!.desiredGeneration, [settleStat(fx, { ctimeMs: C, capturedMs: C + 2000, observedMs: C + 2000, size: 4 })],
      { cursor: null, coverage: 'complete', complete: true }, at, { quietMs: 2000 })
    finishArtifactJob(fx.db, claimed!.jobId, { complete: true, coverage: 'complete' }, at)
    assert.equal(versionCount(fx), 1)
    assert.equal(directJob(fx), undefined)
  } finally { fx.db.close() }
})

test('settle: an event that arrives while the path\'s direct check is running, before it defers, leaves the check queued to run at once', () => {
  const fx = fixture()
  try {
    const at = iso(C + 100)
    enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, at)
    const claimed = claimArtifactJob(fx.db, at)
    assert.equal(claimed?.scopeId, directScope(fx))
    enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, at)
    const result = commitArtifactBatch(fx.db, claimed!.jobId, claimed!.desiredGeneration, [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 3 })],
      { cursor: null, coverage: 'complete', complete: true }, at, { quietMs: 2000 })
    assert.deepEqual(result.deferredPaths, [SETTLE_PATH()])
    finishArtifactJob(fx.db, claimed!.jobId, { complete: true, coverage: 'complete' }, at)
    const job = directJob(fx)
    assert.ok(job)
    assert.deepEqual({ state: job.state, retry_at: job.retry_at, last_error: job.last_error }, { state: 'queued', retry_at: null, last_error: null })
    assert.equal(versionCount(fx), 0)
  } finally { fx.db.close() }
})

test('settle: a deferral leaves a direct check in failure backoff unchanged', () => {
  const fx = fixture()
  try {
    enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, iso(C))
    const claimed = claimArtifactJob(fx.db, iso(C))
    assert.equal(claimed?.scopeId, directScope(fx))
    retryArtifactJob(fx.db, claimed!.jobId, 'io', iso(C + 60000), iso(C))
    const before = directJob(fx)
    assert.deepEqual({ state: before?.state, retry_at: before?.retry_at, last_error: before?.last_error, attempts: before?.attempts }, { state: 'retry', retry_at: iso(C + 60000), last_error: 'io', attempts: 1 })
    walk(fx, [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    const after = directJob(fx)
    assert.deepEqual({ state: after?.state, retry_at: after?.retry_at, last_error: after?.last_error, attempts: after?.attempts }, { state: 'retry', retry_at: iso(C + 60000), last_error: 'io', attempts: 1 })
  } finally { fx.db.close() }
})

test('settle: a deferral re-arms a finished direct check as a settling retry', () => {
  const fx = fixture()
  try {
    // A direct check that finishes with nothing to wait for is deleted, so 'failed' is the finished state a row can be left in.
    enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.backfill, generation: 1 }, iso(C))
    const job = claimArtifactJob(fx.db, iso(C))
    finishArtifactJob(fx.db, job!.jobId, { complete: true, coverage: 'complete', error: 'io: boom' }, iso(C))
    assert.equal(directJob(fx)?.state, 'failed')
    walk(fx, [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    const r = directJob(fx)!
    assert.deepEqual({ state: r.state, retry_at: r.retry_at, last_error: r.last_error, attempts: r.attempts, priority: r.priority }, { state: 'retry', retry_at: iso(C + 2000), last_error: 'settling', attempts: 0, priority: ARTIFACT_JOB_PRIORITY.recovery })
    assert.ok(Number(r.desired_generation) > Number(r.applied_generation))
  } finally { fx.db.close() }
})

test('settle: a deferral while the path\'s own direct check runs elsewhere bumps its desired generation', () => {
  const fx = fixture()
  try {
    enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, iso(C))
    const claimed = claimArtifactJob(fx.db, iso(C))
    assert.equal(claimed?.scopeId, directScope(fx))
    const before = directJob(fx)!
    assert.equal(before.desired_generation, before.pass_generation)
    walk(fx, [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    const after = directJob(fx)!
    assert.equal(after.state, 'running')
    assert.ok(Number(after.desired_generation) > Number(after.pass_generation))
  } finally { fx.db.close() }
})

test('settle: a settling retry keeps the more urgent priority and the later due time', () => {
  const fx = fixture()
  try {
    runAt(fx, fx.out.rootId, 'output-walk', [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100, 2000, ARTIFACT_JOB_PRIORITY.backfill)
    const first = directJob(fx)!
    assert.deepEqual({ state: first.state, retry_at: first.retry_at, priority: first.priority }, { state: 'retry', retry_at: iso(C + 2000), priority: ARTIFACT_JOB_PRIORITY.backfill })
    runAt(fx, fx.out.rootId, 'output-walk', [settleStat(fx, { ctimeMs: C + 500, capturedMs: C + 600, observedMs: C + 600, size: 0 })], C + 600, 2000, ARTIFACT_JOB_PRIORITY.dirty)
    const second = directJob(fx)!
    assert.deepEqual({ state: second.state, retry_at: second.retry_at, last_error: second.last_error, priority: second.priority }, { state: 'retry', retry_at: iso(C + 2500), last_error: 'settling', priority: ARTIFACT_JOB_PRIORITY.dirty })
  } finally { fx.db.close() }
})

test('settle: a walk that skips one file schedules only that file\'s direct check and completes with its usual coverage', () => {
  const fx = fixture()
  try {
    const { jobId } = walk(fx, [
      settleStat(fx, { name: 'a.md', ctimeMs: C - 5000, capturedMs: C + 100, observedMs: C + 100, size: 1, ino: '1' }),
      settleStat(fx, { name: 'b.md', ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 2, ino: '2' }),
    ], C + 100)
    assert.equal(count(fx.db, 'artifacts', 'path = ?', SETTLE_PATH('a.md')), 1)
    assert.equal(versionCount(fx), 1)
    assert.equal(count(fx.db, 'artifacts', 'path = ?', SETTLE_PATH('b.md')), 0)
    assert.equal(row(fx.db, 'SELECT state FROM artifact_jobs WHERE job_id = ?', jobId).state, 'done')
    const root = listArtifactRoots(fx.db).find(r => r.rootId === fx.out.rootId)!
    assert.equal(root.coverageState, 'idle')
    assert.ok(root.appliedGeneration >= 1)
    const direct = rows(fx.db, `SELECT scope_id FROM artifact_jobs WHERE task_kind = 'direct-observation'`)
    assert.deepEqual(direct.map(d => d.scope_id), [directScope(fx, 'b.md')])
    assert.equal(count(fx.db, 'artifact_jobs', `task_kind = 'output-walk' AND state IN ('queued', 'retry')`), 0)
  } finally { fx.db.close() }
})

test('settle: a deferral leaves a queued direct check queued and revives a failed one into retry', () => {
  const queued = fixture()
  try {
    enqueueArtifactJob(queued.db, { scopeId: directScope(queued), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.backfill, generation: 1 }, iso(C))
    walk(queued, [settleStat(queued, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    const job = directJob(queued)
    assert.deepEqual({ state: job?.state, retry_at: job?.retry_at, priority: job?.priority }, { state: 'queued', retry_at: null, priority: ARTIFACT_JOB_PRIORITY.backfill })
  } finally { queued.db.close() }
  const failed = fixture()
  try {
    enqueueArtifactJob(failed.db, { scopeId: directScope(failed), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, iso(C))
    const job = claimArtifactJob(failed.db, iso(C))
    finishArtifactJob(failed.db, job!.jobId, { complete: true, coverage: 'complete', error: 'io: boom' }, iso(C))
    assert.equal(directJob(failed)?.state, 'failed')
    walk(failed, [settleStat(failed, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    const revived = directJob(failed)
    assert.deepEqual({ state: revived?.state, retry_at: revived?.retry_at, attempts: revived?.attempts, last_error: revived?.last_error }, { state: 'retry', retry_at: iso(C + 2000), attempts: 0, last_error: 'settling' })
  } finally { failed.db.close() }
})

test('settle: a later event makes a settling check due at once', () => {
  const fx = fixture()
  try {
    walk(fx, [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 0 })], C + 100)
    assert.equal(directJob(fx)?.state, 'retry')
    recordArtifactEvidence(fx.db, evidenceInput(fx.out, rootDoc(fx.out.rootId, 'draft.md'), SETTLE_PATH(), 'hook:late', { eventAt: iso(C + 250) }), iso(C + 300))
    enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, iso(C + 300))
    assert.deepEqual({ state: directJob(fx)?.state, retry_at: directJob(fx)?.retry_at }, { state: 'queued', retry_at: null })
    const job = claimArtifactJob(fx.db, iso(C + 300))
    assert.equal(job?.scopeId, directScope(fx))
    commitArtifactBatch(fx.db, job!.jobId, job!.desiredGeneration, [settleStat(fx, { ctimeMs: C, capturedMs: C + 300, observedMs: C + 300, size: 9 })],
      { cursor: null, coverage: 'complete', complete: true }, iso(C + 300), { quietMs: 2000 })
    assert.equal(versionCount(fx), 1)
  } finally { fx.db.close() }
})

test('settle: an unchanged stat is never skipped, and quiet 0 records a fresh stat at once', () => {
  const fx = fixture()
  try {
    runAt(fx, directScope(fx), 'direct-observation', [settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 6 })], C + 100)
    assert.equal(versionCount(fx), 1)
    assert.equal(directJob(fx), undefined)
    const r = runAt(fx, fx.out.rootId, 'verify', [settleStat(fx, { ctimeMs: C, capturedMs: C + 200, observedMs: C + 200, size: 6 })], C + 200, 2000)
    assert.equal(versionCount(fx), 1)
    assert.deepEqual(r.deferredPaths, [])
    assert.equal(directJob(fx), undefined)
    assert.equal(row(fx.db, 'SELECT last_verified_at FROM artifacts WHERE path = ?', SETTLE_PATH()).last_verified_at, iso(C + 200))
  } finally { fx.db.close() }
})

test('settle: a row carrying its own evidence is never deferred', () => {
  const fx = fixture()
  try {
    const obs = settleStat(fx, { ctimeMs: C, capturedMs: C + 100, observedMs: C + 100, size: 8 })
    obs.evidence = { source: 'hook', eventKey: 'hook:own', sessionId: S1, operation: 'modified', certainty: 'recorded', eventAt: iso(C) }
    const r = runAt(fx, directScope(fx), 'direct-observation', [obs], C + 100, 2000)
    assert.deepEqual(r.deferredPaths, [])
    assert.equal(versionCount(fx), 1)
    assert.equal(row(fx.db, `SELECT version_id FROM artifact_evidence WHERE source_key = 'hook:own'`).version_id, row(fx.db, `SELECT version_id FROM artifact_versions WHERE kind = 'working'`).version_id)
  } finally { fx.db.close() }
})

test('settle: an invalid quiet period is rejected', () => {
  const fx = fixture()
  try {
    const now = iso(C)
    const jobId = enqueueArtifactJob(fx.db, { scopeId: directScope(fx), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 1 }, now)
    const job = claimArtifactJob(fx.db, now)
    for (const quietMs of [-1, Number.NaN]) {
      assert.throws(() => commitArtifactBatch(fx.db, jobId, job!.desiredGeneration, [], { cursor: null, coverage: 'complete', complete: true }, now, { quietMs }), /quiet period must be a non-negative number/)
    }
  } finally { fx.db.close() }
})
