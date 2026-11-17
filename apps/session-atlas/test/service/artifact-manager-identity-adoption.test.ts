import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.ts'
import type { AtlasDb } from '../../src/db/database.ts'
import { ensureSession, touchSession } from '../../src/db/sessions.ts'
import { ARTIFACT_JOB_PRIORITY, artifactDirectScopeId, enqueueArtifactJob, listArtifactRoots, recordArtifactObservation, registerArtifactRoot, setArtifactDiscoveryPaused, type ArtifactRootRow } from '../../src/db/artifact-manager.ts'
import type { ArtifactWorkerObservation, ArtifactWorkerRequest } from '../../src/artifacts/contracts.ts'
import type { Logger } from '../../src/util/log.ts'
import type { ArtifactWorkerClient, ArtifactWorkerClientStatus, ArtifactWorkerEvent } from '../../src/service/artifact-worker.ts'
import { artifactManagerRunner } from '../../src/service/artifact-manager-runner.ts'
import { silentLogger } from '../helpers/log.ts'
import { openTestDb } from '../helpers/db.ts'

// PR #19 follow-up review, finding 4 (ruling R93): promoting root-identity documents to the repository identity when a checkout is
// registered is background work. Registration only records a cursor; run() adopts one bounded page per turn and yields.

const TEMP: string[] = []
const RUNNERS: Array<() => void> = []
function cleanup(): void {
  for (const s of RUNNERS.splice(0)) { try { s() } catch { /* already stopped */ } }
  for (const d of TEMP.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
}
process.on('exit', cleanup)
after(cleanup)

for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A worker that finishes every job at once with an empty, complete pass. */
class IdleWorker implements ArtifactWorkerClient {
  private events: ArtifactWorkerEvent[] = []
  starts: string[] = []
  start(req: ArtifactWorkerRequest): void {
    this.starts.push(req.task)
    this.events.push({ type: 'frame', frame: { type: 'batch', jobId: req.jobId, rows: [], cursor: null, complete: true, coverage: 'complete', counts: { visited: 0, eligible: 0, skipped: 0 } } })
  }
  poll(): ArtifactWorkerEvent | null { return this.events.shift() ?? null }
  async wait(): Promise<void> {}
  ack(): void {}
  restart(): void { this.events = [] }
  stop(): void {}
  status(): ArtifactWorkerClientStatus {
    return { running: false, pid: null, activeJobId: null, priorityFacility: 'applied', priorityCommand: 'test', liveGroups: [], spawns: 0, crashes: 0, gitChildrenSeen: 0 }
  }
}

type Fx = { home: string; db: AtlasDb; repo: string; docs: ArtifactRootRow }
const T = '2026-10-27T12:00:00.000Z'

/** A real Git checkout under a fresh home, a session running in it, and `count` root-identity documents under repo/docs (direct inserts). */
function fixture(count: number): Fx {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-adopt-')))
  TEMP.push(home)
  const repo = join(home, 'proj')
  git(home, ['init', '-q', repo])
  writeFileSync(join(repo, 'README.md'), '# readme\n')
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'init'])
  const db = openTestDb()
  ensureSession(db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: repo, startedAt: T, now: T })
  touchSession(db, '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', new Date().toISOString())
  const docs = registerArtifactRoot(db, { kind: 'session-directory', canonicalPath: join(repo, 'docs'), repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T)
  db.transaction(() => {
    for (let i = 0; i < count; i++) addRootDoc(db, docs, `d${String(i).padStart(5, '0')}.md`, i)
  })
  return { home, db, repo, docs }
}
function addRootDoc(db: AtlasDb, root: ArtifactRootRow, name: string, i: number): void {
  const obs: ArtifactWorkerObservation = {
    rootId: root.rootId, identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: name }, kind: 'working', observedAt: T,
    path: join(root.canonicalPath, name), stat: { dev: '1', ino: String(1000 + i), size: 10, mtimeMs: Date.parse(T), ctimeMs: Date.parse(T) },
  }
  recordArtifactObservation(db, obs, T)
}

function makeRunner(fx: Fx, over: { worker?: ArtifactWorkerClient; log?: Logger } = {}) {
  const config = loadConfig({ HOME: fx.home })
  const r = artifactManagerRunner({ db: fx.db, config, log: over.log ?? silentLogger, worker: over.worker ?? new IdleWorker(), home: fx.home, clock: () => Date.now(), autoSchedule: true, frameWaitMs: 0, backgroundPauseMs: 0 })
  RUNNERS.push(() => r.stop?.())
  return r
}
type R = ReturnType<typeof makeRunner>

const scalar = (db: AtlasDb, sql: string, ...p: string[]): number => Number((db.raw.prepare(sql).get(...p) as { n: number }).n)
const rootKind = (db: AtlasDb) => scalar(db, `SELECT COUNT(*) AS n FROM artifact_documents WHERE identity_kind = 'root'`)
const adopted = (db: AtlasDb, total: number) => total - rootKind(db)
const cursors = (db: AtlasDb) => scalar(db, 'SELECT COUNT(*) AS n FROM artifact_identity_adoptions')
const checkoutOf = (db: AtlasDb, repo: string) => listArtifactRoots(db).find(r => r.canonicalPath === repo && r.kind === 'checkout' && r.active)

/** Runs the root reconciliation to the point where the checkout is registered (the plan is applied by the run that follows the plan). */
async function register(r: R, db: AtlasDb, repo: string): Promise<void> {
  for (let i = 0; i < 6 && !checkoutOf(db, repo); i++) { await r.run(); await r.settle() }
  assert.ok(checkoutOf(db, repo), 'the checkout was registered')
}

test('R93: registering a checkout with 10,000 root-identity documents adopts at most one page per run() and lets the event loop in between', async () => {
  const N = 10_000
  const fx = fixture(N)
  const r = makeRunner(fx)
  await register(r, fx.db, fx.repo)
  assert.ok(adopted(fx.db, N) <= 500, `registration itself adopts nothing beyond a page (adopted ${adopted(fx.db, N)})`)

  let runs = 0, maxStep = 0, firedWhileIncomplete = false
  let before = adopted(fx.db, N)
  while ((rootKind(fx.db) > 0 || cursors(fx.db) > 0) && runs < 200) {
    let atFire = -1
    setImmediate(() => { atFire = adopted(fx.db, N) })
    await r.run()
    await r.settle()
    runs++
    const now = adopted(fx.db, N)
    maxStep = Math.max(maxStep, now - before)
    before = now
    if (atFire >= 0 && atFire < N) firedWhileIncomplete = true
  }
  assert.equal(rootKind(fx.db), 0, 'repeated run() calls finish all 10,000')
  assert.ok(firedWhileIncomplete, 'a queued setImmediate ran while adoption was still incomplete')
  assert.ok(maxStep <= 500, `one run() adopts at most one page (largest step ${maxStep})`)
  assert.ok(runs >= 10, `the work took several turns (${runs})`)
  assert.equal(cursors(fx.db), 0, 'the cursor row is gone at the end')
})

test('R93: the cursor survives a restart: a new runner on the same database resumes at after_path, adopts nothing twice, and clears the row', async () => {
  const N = 3_000
  const fx = fixture(N)
  const first = makeRunner(fx)
  await register(first, fx.db, fx.repo)
  for (let i = 0; i < 40 && adopted(fx.db, N) === 0; i++) { await first.run(); await first.settle() }
  const partial = adopted(fx.db, N)
  assert.ok(partial > 0 && partial < N, `precondition: adoption is part way (${partial})`)
  const row = fx.db.raw.prepare('SELECT root_id, after_path FROM artifact_identity_adoptions').get() as { root_id: string; after_path: string | null }
  assert.ok(row.after_path, 'the cursor holds the last path of the last page')
  first.stop?.()
  await first.settle()

  const second = makeRunner(fx)
  const startingPoint = fx.db.raw.prepare(`SELECT MIN(a.path) AS p FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE d.identity_kind = 'root'`).get() as { p: string }
  assert.ok(startingPoint.p > row.after_path!, 'every path up to the cursor was adopted before the restart')
  for (let i = 0; i < 100 && (rootKind(fx.db) > 0 || cursors(fx.db) > 0); i++) { await second.run(); await second.settle() }
  assert.equal(rootKind(fx.db), 0)
  assert.equal(scalar(fx.db, `SELECT COUNT(*) AS n FROM artifact_documents WHERE identity_kind = 'repository'`), N, 'every document was adopted once: no duplicates, no merges')
  assert.equal(scalar(fx.db, 'SELECT COUNT(*) AS n FROM artifact_document_aliases'), 0)
  assert.equal(cursors(fx.db), 0)
})

test('R93: pause holds adoption, and a root that is no longer an active checkout loses its cursor without work', async () => {
  const N = 1_200
  const fx = fixture(N)
  const r = makeRunner(fx)
  await register(r, fx.db, fx.repo)
  const cursor = fx.db.raw.prepare('SELECT root_id FROM artifact_identity_adoptions').get() as { root_id: string } | undefined
  assert.ok(cursor, 'registration left a cursor')
  const mark = adopted(fx.db, N)
  setArtifactDiscoveryPaused(fx.db, true, T)
  for (let i = 0; i < 6; i++) await r.run()
  assert.equal(adopted(fx.db, N), mark, 'a pause holds the adoption')
  assert.equal(cursors(fx.db), 1)
  fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(cursor.root_id)
  setArtifactDiscoveryPaused(fx.db, false, T)
  const rootsBefore = rootKind(fx.db)
  await r.run()
  assert.equal(cursors(fx.db), 0, 'the cursor of a deactivated root is dropped')
  assert.equal(rootKind(fx.db), rootsBefore, 'and nothing was adopted for it')
})

test('R93: a hook document written before the checkout was registered ends as one repository document once the cursor drains', async () => {
  const fx = fixture(0)
  addRootDoc(fx.db, fx.docs, 'plan.md', 1)
  const r = makeRunner(fx)
  await register(r, fx.db, fx.repo)
  const id = (fx.db.raw.prepare(`SELECT document_id FROM artifacts WHERE path = ?`).get(join(fx.repo, 'docs', 'plan.md')) as { document_id: string }).document_id
  for (let i = 0; i < 10 && cursors(fx.db) > 0; i++) await r.run()
  assert.equal(cursors(fx.db), 0)
  const d = fx.db.raw.prepare('SELECT identity_kind AS k, relative_path AS p FROM artifact_documents WHERE document_id = ?').get(id) as { k: string; p: string }
  assert.deepEqual({ ...d }, { k: 'repository', p: 'docs/plan.md' })
  assert.equal(scalar(fx.db, 'SELECT COUNT(*) AS n FROM artifact_documents'), 1)
})


/** A second real checkout under the same home, with its own session, docs root and `count` root-identity documents named `<prefix>NNNNN.md`. */
function addCheckout(fx: Fx, name: string, count: number, prefix: string, sessionId: string): { repo: string; docs: ArtifactRootRow } {
  const repo = join(fx.home, name)
  git(fx.home, ['init', '-q', repo])
  writeFileSync(join(repo, 'README.md'), '# readme\n')
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'init'])
  ensureSession(fx.db, { sessionId, cwd: repo, startedAt: T, now: T })
  touchSession(fx.db, sessionId, new Date().toISOString())
  const docs = registerArtifactRoot(fx.db, { kind: 'session-directory', canonicalPath: join(repo, 'docs'), repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T)
  fx.db.transaction(() => { for (let i = 0; i < count; i++) addRootDoc(fx.db, docs, `${prefix}${String(i).padStart(5, '0')}.md`, 50_000 + i) })
  return { repo, docs }
}

test('R95: a due direct job is claimed before an adoption page, while the cursor stays pending', async () => {
  const N = 1_200
  const fx = fixture(N)
  const worker = new IdleWorker()
  const r = makeRunner(fx, { worker })
  await register(r, fx.db, fx.repo)
  for (let i = 0; i < 10 && worker.starts.length > 0 && cursors(fx.db) === 1 && adopted(fx.db, N) === 0; i++) { await r.run(); await r.settle() }
  const docsRoot = listArtifactRoots(fx.db).find(x => x.canonicalPath === join(fx.repo, 'docs'))!
  const mark = adopted(fx.db, N)
  assert.equal(cursors(fx.db), 1, 'precondition: a cursor is pending')
  assert.ok(mark < N)
  const startsBefore = worker.starts.length
  enqueueArtifactJob(fx.db, { scopeId: artifactDirectScopeId(docsRoot.rootId, join(docsRoot.canonicalPath, 'd00001.md')), taskKind: 'direct-observation', priority: ARTIFACT_JOB_PRIORITY.direct, generation: 0 }, new Date().toISOString())
  await r.run()
  assert.equal(worker.starts.length, startsBefore + 1, 'the direct job was started')
  assert.equal(worker.starts[worker.starts.length - 1], 'direct-observation')
  assert.equal(cursors(fx.db), 1, 'the cursor is still pending')
  assert.equal(adopted(fx.db, N), mark, 'and that turn adopted no page')
  for (let i = 0; i < 80 && (rootKind(fx.db) > 0 || cursors(fx.db) > 0); i++) { await r.run(); await r.settle() }
  assert.equal(rootKind(fx.db), 0, 'the adoption then completes')
})

test('R96: a page that throws leaves its documents and cursor position, counts the failure, lets another checkout finish, and drops the row after the 3rd failure', async () => {
  const fx = fixture(0)
  const bad = addCheckout(fx, 'bad-proj', 0, 'x', '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c01')
  const good = addCheckout(fx, 'good-proj', 700, 'ok', '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c02')
  fx.db.transaction(() => { for (let i = 0; i < 20; i++) addRootDoc(fx.db, bad.docs, `bad${String(i).padStart(2, '0')}.md`, 70_000 + i) })
  const warnings: string[] = []
  const log: Logger = { info() {}, error() {}, warn: (m, d) => { warnings.push(`${m} ${JSON.stringify(d ?? {})}`) } }
  const r = makeRunner(fx, { log })
  for (let i = 0; i < 8 && !(checkoutOf(fx.db, bad.repo) && checkoutOf(fx.db, good.repo)); i++) { await r.run(); await r.settle() }
  const badRoot = checkoutOf(fx.db, bad.repo)!
  assert.ok(checkoutOf(fx.db, good.repo))
  assert.equal(cursors(fx.db), 3, "one cursor per checkout (the fixture's own checkout holds no documents)")
  // The failing checkout is the head of the queue; an injected fault makes its page throw.
  fx.db.raw.prepare('UPDATE artifact_identity_adoptions SET requested_at = ? WHERE root_id = ?').run('2000-01-01T00:00:00.000Z', badRoot.rootId)
  fx.db.raw.exec(`CREATE TRIGGER inject_page_fault BEFORE UPDATE ON artifact_documents WHEN NEW.identity_kind = 'repository' AND NEW.relative_path LIKE 'docs/bad%' BEGIN SELECT RAISE(ABORT, 'injected'); END`)
  const badBefore = fx.db.raw.prepare(`SELECT d.document_id, d.identity_kind FROM artifact_documents d WHERE d.relative_path LIKE 'bad%' ORDER BY 1`).all().map(x => ({ ...x }))
  assert.equal(badBefore.length, 20)
  const seen: number[] = []
  for (let i = 0; i < 60 && cursors(fx.db) > 0; i++) {
    await r.run(); await r.settle()
    const row = fx.db.raw.prepare('SELECT failures, after_path FROM artifact_identity_adoptions WHERE root_id = ?').get(badRoot.rootId) as { failures: number; after_path: string | null } | undefined
    if (row) { if (seen[seen.length - 1] !== row.failures) seen.push(row.failures); assert.equal(row.after_path, null, 'the failed page left the cursor where it was') }
  }
  assert.deepEqual(seen, [0, 1, 2], 'failures count up (the third failure drops the row)')
  assert.equal(cursors(fx.db), 0, 'the poison row is gone and the other checkout completed')
  assert.equal(scalar(fx.db, `SELECT COUNT(*) AS n FROM artifact_documents WHERE identity_kind = 'repository' AND relative_path LIKE 'docs/ok%'`), 700, 'the other checkout adopted everything')
  assert.deepEqual(fx.db.raw.prepare(`SELECT d.document_id, d.identity_kind FROM artifact_documents d WHERE d.relative_path LIKE 'bad%' ORDER BY 1`).all().map(x => ({ ...x })), badBefore, 'the failing checkout\'s documents are unchanged')
  assert.ok(warnings.some(w => w.includes('adoption') && w.includes(badRoot.rootId)), `a warning names the root: ${warnings.join(' | ')}`)
})
