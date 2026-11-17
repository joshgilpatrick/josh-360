import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, statSync, truncateSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ARTIFACT_DEFAULT_FRAME_ROWS, type ArtifactWorkerFrame, type ArtifactWorkerObservation, type ArtifactWorkerRequest } from '../../src/artifacts/contracts.ts'
import { loadConfig, type AtlasConfig } from '../../src/config.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { DatabaseSync } from 'node:sqlite'
import { upsertArtifact } from '../../src/db/artifacts.ts'
import { ensureSession, touchSession } from '../../src/db/sessions.ts'
import {
  ARTIFACT_JOB_PRIORITY, ARTIFACT_SETTLING, artifactDirectScopeId, enqueueArtifactJob, getArtifactManagerStatus, listArtifactRoots, recordArtifactEvidence, recordArtifactObservation, registerArtifactRepository,
  registerArtifactRoot, setArtifactDiscoveryPaused, type ArtifactRootRow,
} from '../../src/db/artifact-manager.ts'
import type { ArtifactWorkerClient, ArtifactWorkerClientStatus, ArtifactWorkerEvent } from '../../src/service/artifact-worker.ts'
import { createArtifactWorkerClient } from '../../src/service/artifact-worker.ts'
import { artifactGitSpawnCount, runArtifactGit, type GitLimits, type GitResult, type GitRunOptions } from '../../src/artifacts/git.ts'
import { verifyExistence } from '../../src/artifacts/reconcile.ts'
import { recordDirectArtifactObservation } from '../../src/ingest/artifact-observations.ts'
import {
  ArtifactRefreshRefusedError, artifactManagerRunner, includeOlderPending, includeOlderPendingRoots, readArtifactManagerState, requestArtifactRefresh, type ArtifactManagerRunnerDeps,
} from '../../src/service/artifact-manager-runner.ts'
import type { Logger } from '../../src/util/log.ts'
import { openTestDb } from '../helpers/db.ts'
import { toPreReleaseCatalog } from '../helpers/artifact-large-document.ts'
import { silentLogger } from '../helpers/log.ts'

// Cleanup first: every runner is stopped (killing its worker and every tracked process group), then temp dirs go.
const TEMP: string[] = []
const STOPPERS: Array<() => void> = []
function cleanup(): void {
  for (const s of STOPPERS.splice(0)) { try { s() } catch { /* already stopped */ } }
  for (const d of TEMP.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
}
process.on('exit', cleanup)
after(cleanup)

for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false']
function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
}

function newHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-mgr-home-')))
  TEMP.push(home)
  return home
}
function put(path: string, content = 'x\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0)
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

// ------------------------------------------------------------------------------------------------ fake worker

type Script = (req: ArtifactWorkerRequest, n: number) => ArtifactWorkerFrame[]

class FakeWorker implements ArtifactWorkerClient {
  requests: ArtifactWorkerRequest[] = []
  acks: string[] = []
  restarts: string[] = []
  events: ArtifactWorkerEvent[] = []
  pending: ArtifactWorkerFrame[] = []
  script: Script = req => [terminal(req)]
  /** Called for every ack; returning 'crash' makes the worker die before the ack reaches it. */
  onAck: ((jobId: string, index: number) => 'crash' | void) | null = null
  stopped = false
  start(req: ArtifactWorkerRequest): void {
    this.requests.push(structuredClone(req))
    this.pending = this.script(req, this.requests.length)
    this.deliver()
  }
  private deliver(): void {
    const f = this.pending.shift()
    if (f) this.events.push({ type: 'frame', frame: f })
  }
  poll(): ArtifactWorkerEvent | null { return this.events.shift() ?? null }
  async wait(): Promise<void> {}
  ack(jobId: string): void {
    this.acks.push(jobId)
    if (this.onAck?.(jobId, this.acks.length) === 'crash') {
      this.pending = []
      this.events.push({ type: 'exit', reason: 'signal-SIGKILL' })
      return
    }
    this.deliver()
  }
  restart(reason: string): void { this.restarts.push(reason); this.pending = []; this.events = [] }
  stop(): void { this.stopped = true }
  status(): ArtifactWorkerClientStatus {
    return { running: !this.stopped, pid: null, activeJobId: null, priorityFacility: 'applied', priorityCommand: 'test', liveGroups: [], spawns: 0, crashes: 0, gitChildrenSeen: 0 }
  }
}

function terminal(req: ArtifactWorkerRequest, over: Partial<ArtifactWorkerFrame> = {}): ArtifactWorkerFrame {
  return { type: 'batch', jobId: req.jobId, rows: [], cursor: null, complete: true, coverage: 'complete', counts: { visited: 1, eligible: 0, skipped: 0 }, ...over }
}
function data(req: ArtifactWorkerRequest, rows: ArtifactWorkerObservation[], cursor: string | null): ArtifactWorkerFrame {
  return { type: 'batch', jobId: req.jobId, rows, cursor, complete: false, coverage: 'partial', counts: { visited: rows.length, eligible: rows.length, skipped: 0 } }
}

function statOf(path: string): NonNullable<ArtifactWorkerObservation['stat']> {
  const s = lstatSync(path, { bigint: true })
  return { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs) }
}
/** A working row exactly as the worker derives it for `root` (root identity unless the root carries repository identity). */
function working(root: ArtifactRootRow, path: string, repo?: { repositoryId: string; top: string }): ArtifactWorkerObservation {
  const identity = repo
    ? { identityKind: 'repository' as const, repositoryId: repo.repositoryId, rootId: null, relativePath: path.slice(repo.top.length + 1) }
    : { identityKind: 'root' as const, repositoryId: null, rootId: root.rootId, relativePath: path.slice(root.canonicalPath.length + 1) }
  return { rootId: root.rootId, identity, kind: 'working', observedAt: iso(T0), capturedAt: iso(T0), path, stat: statOf(path) }
}
function commitRow(root: ArtifactRootRow, gitPath: string, commit: string): ArtifactWorkerObservation {
  return {
    rootId: root.rootId, identity: { identityKind: 'repository', repositoryId: root.repositoryId!, rootId: null, relativePath: gitPath }, kind: 'commit', observedAt: iso(T0),
    git: { repositoryId: root.repositoryId!, commitOid: commit, gitPath, blobOid: 'a'.repeat(40), objectFormat: 'sha1', mode: 0o100644, size: 3 },
    evidence: { source: 'git', eventKey: `git:${commit}:${gitPath}`, sessionId: null, operation: 'touched', certainty: 'unknown', eventAt: iso(T0 - DAY) },
  }
}

// ------------------------------------------------------------------------------------------------ harness

type H = { home: string; db: AtlasDb; config: AtlasConfig; fake: FakeWorker; t: number; warnings: string[]; log: Logger }

function harness(over: { atlasHome?: string } = {}): H {
  const home = newHome()
  const db = openTestDb()
  const config = loadConfig({ HOME: home, ...(over.atlasHome ? { ATLAS_HOME: over.atlasHome } : {}) })
  const warnings: string[] = []
  const log: Logger = { info() {}, error() {}, warn: (msg, data) => { warnings.push(`${msg} ${JSON.stringify(data ?? {})}`) } }
  return { home, db, config, fake: new FakeWorker(), t: T0, warnings, log }
}

function runner(h: H, over: Partial<ArtifactManagerRunnerDeps> = {}) {
  const r = artifactManagerRunner({
    db: h.db, config: h.config, log: h.log, worker: h.fake, home: h.home, clock: () => h.t, autoSchedule: false, frameWaitMs: 0, ...over,
  })
  STOPPERS.push(() => r.stop?.())
  return r
}

async function spin(r: { run(): Promise<boolean> }, n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await r.run()
}

function outputRoot(h: H, name: string, over: Partial<Parameters<typeof registerArtifactRoot>[1]> = {}): ArtifactRootRow {
  const path = join(h.home, name)
  mkdirSync(path, { recursive: true })
  // A CLI-registered root: reconciliation would deactivate a configured-output root that the config does not declare.
  return registerArtifactRoot(h.db, { kind: 'output', canonicalPath: path, repositoryId: null, projectName: name, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'], ...over }, iso(h.t))
}
function checkoutRoot(h: H, name: string): ArtifactRootRow {
  const path = join(h.home, name)
  mkdirSync(path, { recursive: true })
  const repo = registerArtifactRepository(h.db, { commonDir: join(path, '.git'), displayName: name, remoteIdentity: null }, iso(h.t))
  return registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: path, repositoryId: repo, projectName: name, checkoutIdentity: `ck-${name}`, protected: false, scopeFlags: ['checkout'] }, iso(h.t))
}
function enqueue(h: H, scopeId: string, taskKind: ArtifactWorkerRequest['task'], priority: number = ARTIFACT_JOB_PRIORITY.dirty): string {
  return enqueueArtifactJob(h.db, { scopeId, taskKind, priority, generation: 0 }, iso(h.t))
}
function job(h: H, scopeId: string, taskKind: string): Record<string, unknown> | undefined {
  return h.db.raw.prepare('SELECT * FROM artifact_jobs WHERE scope_id = ? AND task_kind = ?').get(scopeId, taskKind) as Record<string, unknown> | undefined
}
function n(h: H, sql: string, ...params: Array<string | number>): number {
  return (h.db.raw.prepare(sql).get(...params) as { n: number }).n
}
function rootRow(h: H, rootId: string): ArtifactRootRow {
  return listArtifactRoots(h.db).find(r => r.rootId === rootId)!
}

// ================================================================================================ crash, atomicity, generations

test('a worker crash after a batch commit and before its ack replays from the committed checkpoint without duplicates', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const files = ['a.md', 'b.md', 'c.md'].map(f => put(join(r0.canonicalPath, f)))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = (req, i) => i === 1
    ? [data(req, [working(r0, files[0]!), working(r0, files[1]!)], 'w1'), data(req, [working(r0, files[2]!)], 'w2'), terminal(req)]
    : [data(req, [working(r0, files[1]!), working(r0, files[2]!)], 'w3'), terminal(req)]
  h.fake.onAck = (_job, index) => (index === 2 ? 'crash' : undefined)
  const r = runner(h)
  await spin(r, 6)
  assert.equal(h.fake.requests.length, 1)
  // Frame 2 was committed (durable) although its ack never reached the dead worker.
  assert.equal(job(h, r0.rootId, 'output-walk')!.cursor, 'w2')
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'retry')
  assert.equal(readArtifactManagerState(h.db, 'health.worker-crashes'), '1')
  h.t += 2_000
  await spin(r, 6)
  assert.equal(h.fake.requests.length, 2)
  assert.equal(h.fake.requests[1]!.cursor, 'w2', 'the retry resumes from the committed checkpoint')
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'done')
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_versions WHERE kind = 'working'`), 3, 'replayed rows create no second version')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_documents'), 3)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), 3)
  assert.equal(rootRow(h, r0.rootId).coverageState, 'idle')
  assert.equal(rootRow(h, r0.rootId).appliedGeneration, 1)
})

test('rows and their checkpoint commit atomically: a failing row rolls back the whole batch and nothing is acknowledged', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  const b = put(join(r0.canonicalPath, 'b.md'))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = req => [data(req, [working(r0, a), working(r0, b)], 'w1'), terminal(req)]
  h.db.raw.exec(`CREATE TRIGGER fail_b BEFORE INSERT ON artifacts WHEN NEW.path LIKE '%/b.md' BEGIN SELECT RAISE(ABORT, 'injected'); END`)
  const r = runner(h)
  await spin(r, 4)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), 0, 'the row before the failure was rolled back with it')
  assert.equal(job(h, r0.rootId, 'output-walk')!.cursor, null, 'the checkpoint did not advance')
  assert.deepEqual(h.fake.acks, [], 'nothing uncommitted is acknowledged')
  assert.deepEqual(h.fake.restarts, ['commit-failed'])
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'retry')
  h.db.raw.exec('DROP TRIGGER fail_b')
  h.t += 2_000
  await spin(r, 4)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), 2)
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_versions`), 2)
})

// ================================================================================================ commit size and yields (PERF-GAP-3)

test('the worker is asked for frames of artifacts.maxRowsPerFrame rows, and a frame with more rows than asked is refused uncommitted (PERF-GAP-3)', async () => {
  const h = harness()
  const size = h.config.artifacts.maxRowsPerFrame
  assert.equal(size, ARTIFACT_DEFAULT_FRAME_ROWS, 'the default frame size')
  const r0 = outputRoot(h, 'out')
  const files = Array.from({ length: size + 1 }, (_, i) => put(join(r0.canonicalPath, `f${String(i).padStart(3, '0')}.md`)))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = (req, i) => i === 1
    ? [data(req, files.map(f => working(r0, f)), 'w1'), terminal(req)]
    : [data(req, files.slice(0, size).map(f => working(r0, f)), 'w1'), data(req, [working(r0, files[size]!)], 'w2'), terminal(req)]
  const r = runner(h)
  await spin(r, 4)
  assert.equal(h.fake.requests[0]!.limits.maxFrameRows, size, 'the request carries the frame size')
  assert.deepEqual(h.fake.acks, [], 'the oversized frame is never acknowledged')
  assert.deepEqual(h.fake.restarts, ['frame-rejected'])
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), 0, 'nothing of it was committed')
  assert.equal(readArtifactManagerState(h.db, 'health.rejected-frames'), '1')
  assert.equal(job(h, r0.rootId, 'output-walk')!.cursor, null)
  h.t += 2_000
  await spin(r, 6)
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'done')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), size + 1, 'frames within the size commit as before')

  // A configured size is what the worker is asked for; the frozen 250-row frame maximum stays the bound.
  const h2 = harness()
  h2.config.artifacts.maxRowsPerFrame = 7
  const o2 = outputRoot(h2, 'out')
  enqueue(h2, o2.rootId, 'output-walk')
  await spin(runner(h2), 2)
  assert.equal(h2.fake.requests[0]!.limits.maxFrameRows, 7)
})

test('every frame commit is followed by one turn of the event loop before the next commit (PERF-GAP-3, R65)', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const files = [0, 1, 2].map(i => put(join(r0.canonicalPath, `f${i}.md`)))
  // A dirty-priority pass whose frames arrive back to back (R35): data frames and the terminal frame.
  enqueue(h, r0.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.dirty)
  h.fake.script = req => [data(req, [working(r0, files[0]!)], 'c1'), data(req, [working(r0, files[1]!)], 'c2'), data(req, [working(r0, files[2]!)], 'c3'), terminal(req)]
  const order: string[] = []
  // The ack follows the frame's commit; a macrotask queued there runs before the next commit only if the runner yields.
  h.fake.onAck = () => { order.push('commit'); setImmediate(() => order.push('turn')) }
  const r = runner(h)
  await spin(r, 6)
  assert.deepEqual(order, ['commit', 'turn', 'commit', 'turn', 'commit', 'turn', 'commit', 'turn'])
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_versions'), 3)
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'done')
})

test('the legacy backfill commits at most maxRowsPerFrame rows per transaction, 250 rows per background slice, with a turn of the event loop between transactions (PERF-GAP-3)', async () => {
  const h = harness()
  h.config.artifacts.maxRowsPerFrame = 40
  h.db.transaction(() => {
    for (let i = 0; i < 300; i++) upsertArtifact(h.db, { path: join(h.home, 'old', `f${i}.md`), sizeBytes: 1, createdAt: iso(T0 - DAY + i), projectName: null, now: iso(T0) })
  })
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  const linked = () => n(h, 'SELECT COUNT(*) AS n FROM artifacts WHERE document_id IS NOT NULL')
  // Each outermost transaction that links rows is one batch; record its size and whether a macrotask ran before the next one.
  const order: string[] = []
  const sizes: number[] = []
  const transaction = h.db.transaction
  let depth = 0
  h.db.transaction = <T>(fn: () => T): T => {
    if (depth > 0) return transaction(fn)
    depth++
    const before = linked()
    try { return transaction(fn) } finally {
      depth--
      const added = linked() - before
      if (added > 0) { sizes.push(added); order.push('batch'); setImmediate(() => order.push('turn')) }
    }
  }
  const r = runner(h)
  for (let i = 0; i < 10; i++) await r.run()
  assert.deepEqual(sizes, [40, 40, 40, 40, 40, 40, 10], 'batches of at most 40 rows; the slice stops at 250 rows')
  assert.equal(linked(), 250)
  assert.deepEqual(order, sizes.flatMap(() => ['batch', 'turn']))
  assert.equal(job(h, 'legacy-backfill', 'legacy-backfill')!.cursor, String((h.db.raw.prepare('SELECT artifact_id FROM artifacts ORDER BY artifact_id LIMIT 1 OFFSET 249').get() as { artifact_id: number }).artifact_id),
    'each batch committed its checkpoint')
  // The background pause follows the slice; then the rest, and the pass completes.
  h.t += 1_000
  for (let i = 0; i < 4; i++) await r.run()
  assert.deepEqual(sizes, [40, 40, 40, 40, 40, 40, 10, 40, 10])
  assert.equal(job(h, 'legacy-backfill', 'legacy-backfill')!.state, 'done')
  assert.equal(readArtifactManagerState(h.db, 'health.backfill-rows'), '300')
  h.db.transaction = transaction
})

test('F-STATS: building the runner discards planner statistics on the artifact catalog before anything is planned with them', () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  recordArtifactObservation(h.db, { rootId: r0.rootId, identity: { identityKind: 'root', repositoryId: null, rootId: r0.rootId, relativePath: 'a.md' }, kind: 'working', observedAt: iso(T0),
    path: join(r0.canonicalPath, 'a.md'), stat: { dev: '1', ino: '2', size: 3, mtimeMs: T0 - 1000, ctimeMs: T0 - 1000 } }, iso(T0))
  h.db.raw.exec('ANALYZE')
  const tables = () => (h.db.raw.prepare('SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl').all() as Array<{ tbl: string }>).map(r => r.tbl)
  assert.ok(tables().includes('artifacts') && tables().includes('artifact_documents'))
  const kept = tables().filter(t => t !== 'artifacts' && !t.startsWith('artifact_'))
  runner(h)
  assert.deepEqual(tables().filter(t => t === 'artifacts' || (t.startsWith('artifact_') && t !== 'artifact_origins')), [], 'no statistics on the artifact manager tables')
  assert.deepEqual(tables().filter(t => t !== 'artifacts' && !t.startsWith('artifact_')), kept, 'other statistics are kept')
  assert.ok(h.warnings.some(w => w.startsWith('discarded planner statistics on the artifact catalog')), 'the discard is logged')
  h.warnings.length = 0
  runner(h)
  assert.deepEqual(h.warnings, [], 'nothing to discard, nothing logged')
})

test('an event during a multi-slice pass advances the generation and gets one fresh pass', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = (req, i) => (i === 1 ? [data(req, [working(r0, a)], 'w1'), terminal(req, { complete: false, coverage: 'partial', cursor: 'w1' })] : [terminal(req)])
  const r = runner(h)
  await spin(r, 4)
  enqueue(h, r0.rootId, 'output-walk') // a change arrives between slices
  for (let i = 0; i < 3; i++) { h.t += 1_000; await spin(r, 4) }
  assert.deepEqual(h.fake.requests.map(q => q.cursor), [null, 'w1', null], 'resume the pass, then one fresh pass for the event')
  const j = job(h, r0.rootId, 'output-walk')!
  assert.equal(j.state, 'done')
  assert.equal(j.applied_generation, j.desired_generation)
  assert.equal(h.fake.requests[2]!.generation > h.fake.requests[0]!.generation, true)
})

// ================================================================================================ priority, fairness, pause

test('direct observations outrank background scans, background slices pause 1 s, and the legacy backfill runs last', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  upsertArtifact(h.db, { path: join(h.home, 'legacy.md'), sizeBytes: 1, createdAt: iso(T0 - DAY), projectName: null, now: iso(T0 - DAY) })
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  enqueue(h, r0.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
  enqueue(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h.fake.script = req => (req.task === 'direct-observation' ? [data(req, [working(r0, a)], null), terminal(req)] : [terminal(req)])
  const r = runner(h)
  await spin(r, 6)
  assert.deepEqual(h.fake.requests.map(q => q.task), ['direct-observation', 'output-walk'], 'direct first, then the scan; no pause after a direct check')
  assert.equal(h.fake.requests[0]!.path, a)
  // The walk was a background slice: nothing is claimed for 1 s.
  await spin(r, 4)
  assert.equal(job(h, 'legacy-backfill', 'legacy-backfill')!.state, 'queued')
  h.t += 1_000
  await spin(r, 4)
  assert.equal(job(h, 'legacy-backfill', 'legacy-backfill')!.state, 'done')
  assert.equal(h.fake.requests.length, 2, 'the backfill runs in the service, never in the worker')
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_documents WHERE identity_kind = 'provisional'`), 1)
})

test('a large root yields after each slice and a small root still finishes first', async () => {
  const h = harness()
  const large = outputRoot(h, 'large')
  const small = outputRoot(h, 'small')
  const lf = [1, 2, 3, 4].map(i => put(join(large.canonicalPath, `f${i}.md`)))
  const sf = put(join(small.canonicalPath, 's.md'))
  // Equal priority: the job waiting longest goes first (claim order is priority, then time queued).
  enqueue(h, large.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
  h.t += 1
  enqueue(h, small.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
  h.t += 1
  h.fake.script = req => {
    if (req.root.rootId === small.rootId) return [data(req, [working(small, sf)], null), terminal(req)]
    const i = req.cursor === null ? 0 : Number(req.cursor.slice(1))
    const rows = [data(req, [working(large, lf[i]!)], `l${i + 1}`)]
    return i + 1 < lf.length ? [...rows, terminal(req, { complete: false, coverage: 'partial', cursor: `l${i + 1}` })] : [...rows, terminal(req)]
  }
  const r = runner(h)
  let smallDoneWhileLargeMidPass = false
  for (let i = 0; i < 12; i++) {
    await spin(r, 3)
    if (rootRow(h, small.rootId).appliedGeneration === 1 && rootRow(h, large.rootId).cursor !== null) smallDoneWhileLargeMidPass = true
    h.t += 1_000
  }
  assert.ok(smallDoneWhileLargeMidPass, 'the small root completed while the large one was still mid-pass')
  assert.deepEqual(h.fake.requests.map(q => (q.root.rootId === small.rootId ? 'S' : `L:${q.cursor}`)), ['L:null', 'S', 'L:l1', 'L:l2', 'L:l3'])
  assert.equal(rootRow(h, large.rootId).coverageState, 'idle')
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_versions`), 5)
})

test('pause blocks every claim (direct ones too) while evidence stays durable; resume catches up', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  setArtifactDiscoveryPaused(h.db, true, iso(h.t))
  recordArtifactEvidence(h.db, {
    rootId: r0.rootId, path: a, identity: { identityKind: 'root', repositoryId: null, rootId: r0.rootId, relativePath: 'a.md' }, sourceKey: 'hook-event:s:1',
    source: 'hook', sessionId: null, operation: 'created', certainty: 'recorded', eventAt: iso(h.t),
  }, iso(h.t))
  enqueue(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = req => (req.task === 'direct-observation' ? [data(req, [working(r0, a)], null), terminal(req)] : [terminal(req)])
  const r = runner(h)
  for (let i = 0; i < 3; i++) { await spin(r, 3); h.t += 5_000 }
  assert.equal(h.fake.requests.length, 0, 'nothing is claimed while paused')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_evidence'), 1, 'the observation itself is durable')
  setArtifactDiscoveryPaused(h.db, false, iso(h.t))
  for (let i = 0; i < 3; i++) { await spin(r, 3); h.t += 1_000 }
  assert.deepEqual(h.fake.requests.map(q => q.task), ['direct-observation', 'output-walk'])
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_evidence WHERE version_id IS NOT NULL'), 1, 'the evidence is attached to the version resume produced')
})

test('P2-4: a worker batch whose stat was captured before a newer event binds that event to nothing; the batch that followed the event claims it', async () => {
  // The reviewer's deterministic reproduction: the worker captured version A (13 bytes), the file was rewritten as B (58 bytes) and
  // its successful modification event was ingested before A's batch reached the service.
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'), 'x'.repeat(13))
  const identity = { identityKind: 'root' as const, repositoryId: null, rootId: r0.rootId, relativePath: 'a.md' }
  const event = (key: string, operation: 'created' | 'modified', atMs: number) => recordArtifactEvidence(h.db, {
    rootId: r0.rootId, path: a, identity, sourceKey: key, source: 'hook', sessionId: null, operation, certainty: 'recorded', eventAt: iso(atMs - 5),
  }, iso(atMs))
  const row = (size: number, capturedMs: number, observedMs: number, mtimeMs: number): ArtifactWorkerObservation => ({
    ...working(r0, a), observedAt: iso(observedMs), capturedAt: iso(capturedMs), stat: { dev: '1', ino: '77', size, mtimeMs, ctimeMs: mtimeMs },
  })
  event('hook:create', 'created', T0)
  enqueue(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  event('hook:modify', 'modified', T0 + 30_000) // ingested while the old stat (captured at +10 s) was still being delivered
  h.fake.script = (req, i) => (i === 1 ? [data(req, [row(13, T0 + 10_000, T0 + 40_000, T0 + 5_000)], null), terminal(req)] : [data(req, [row(58, T0 + 50_000, T0 + 51_000, T0 + 29_000)], null), terminal(req)])
  h.t = T0 + 41_000
  const r = runner(h)
  await spin(r, 4)
  const bound = (key: string) => (h.db.raw.prepare('SELECT v.size_bytes AS size FROM artifact_evidence e LEFT JOIN artifact_versions v ON v.version_id = e.version_id WHERE e.source_key = ?').get(key) as { size: number | null }).size
  assert.equal(h.fake.requests.length, 1)
  assert.equal(bound('hook:create'), 13, 'the creation is bound to the content the stat showed')
  assert.equal(bound('hook:modify'), null, 'the modification is not bound to the 13-byte version')
  enqueue(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h.t = T0 + 52_000
  await spin(r, 4)
  assert.equal(h.fake.requests.length, 2)
  assert.equal(bound('hook:modify'), 58, 'the stat that began after the event repairs the link to the 58-byte version')
  assert.equal(bound('hook:create'), 13, 'and the bound link is not rewritten')
})

test('the legacy backfill runs in slices of at most 250 with a durable checkpoint and resumes after a restart', async () => {
  const h = harness()
  h.db.transaction(() => {
    for (let i = 0; i < 300; i++) upsertArtifact(h.db, { path: join(h.home, 'old', `f${i}.md`), sizeBytes: 1, createdAt: iso(T0 - DAY + i), projectName: null, now: iso(T0) })
  })
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  const r1 = runner(h)
  // PERF-GAP-3: a slice is eight batches of at most maxRowsPerFrame (32) rows, one per tick, then the background pause.
  await spin(r1, 12)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts WHERE document_id IS NOT NULL'), 250)
  const cursor = job(h, 'legacy-backfill', 'legacy-backfill')!.cursor as string
  assert.equal(cursor, String((h.db.raw.prepare('SELECT artifact_id FROM artifacts ORDER BY artifact_id LIMIT 1 OFFSET 249').get() as { artifact_id: number }).artifact_id))
  r1.stop?.()
  // A new service instance picks up at the committed checkpoint.
  const r2 = runner(h)
  h.t += 1_000
  await spin(r2, 3)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts WHERE document_id IS NULL'), 0)
  assert.equal(job(h, 'legacy-backfill', 'legacy-backfill')!.state, 'done')
  assert.equal(readArtifactManagerState(h.db, 'legacy-backfill.cursor'), String((h.db.raw.prepare('SELECT MAX(artifact_id) AS m FROM artifacts').get() as { m: number }).m))
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_documents WHERE identity_kind = 'provisional'`), 300)
  assert.equal(h.fake.requests.length, 0)
})

// ================================================================================================ failures and classification

test('a scan failure keeps its partial results visible, retries after 2, 10, 30, 120 and 300 s, then fails with its reason', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = (req, i) => (i === 1
    ? [data(req, [working(r0, a)], 'p1'), terminal(req, { complete: false, coverage: 'inaccessible', cursor: 'p1', error: { code: 'root-inaccessible', message: 'the root cannot be listed' } })]
    : [terminal(req, { complete: false, coverage: 'inaccessible', cursor: req.cursor, error: { code: 'root-inaccessible', message: 'the root cannot be listed' } })])
  const r = runner(h)
  await spin(r, 4)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_versions'), 1, 'rows committed before the failure stay')
  let status = getArtifactManagerStatus(h.db, iso(h.t)).roots.find(x => x.rootId === r0.rootId)!
  assert.equal(status.reason, 'root-inaccessible')
  assert.equal(status.cursor, '[redacted]', 'partial progress is visible')
  const waits: number[] = []
  for (const backoff of [2_000, 10_000, 30_000, 120_000, 300_000]) {
    const j = job(h, r0.rootId, 'output-walk')!
    assert.equal(j.state, 'retry')
    waits.push(Date.parse(j.retry_at as string) - h.t)
    h.t += backoff - 1
    await spin(r, 3)
    assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'retry', 'not before its backoff')
    h.t += 1
    await spin(r, 4)
  }
  assert.deepEqual(waits, [2_000, 10_000, 30_000, 120_000, 300_000])
  assert.equal(h.fake.requests.length, 6)
  assert.ok(h.fake.requests.slice(1).every(q => q.cursor === 'p1'), 'every retry resumes from the committed cursor')
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'failed')
  status = getArtifactManagerStatus(h.db, iso(h.t)).roots.find(x => x.rootId === r0.rootId)!
  assert.equal(status.state, 'inaccessible')
  assert.equal(status.reason, 'root-inaccessible')
  assert.equal(readArtifactManagerState(h.db, `job-failed:output-walk:${r0.rootId}`), 'root-inaccessible')
  assert.equal(readArtifactManagerState(h.db, 'health.retries'), '5')
  assert.equal(readArtifactManagerState(h.db, 'health.failed'), '1')
})

test('worker error codes are classified with artifactWorkerErrorKind: a gap is progress, not a failure', async () => {
  const cases: Array<{ code: string; complete: boolean; coverage: ArtifactWorkerFrame['coverage']; cursor: string | null; expect: (h: H, rootId: string) => void }> = [
    { code: 'permission-denied', complete: true, coverage: 'partial', cursor: null, expect: (h, id) => {
      assert.equal(job(h, id, 'output-walk')!.state, 'done')
      assert.equal(rootRow(h, id).coverageState, 'partial')
      assert.match(readArtifactManagerState(h.db, `coverage-reason:${id}`) ?? '', /permission-denied/)
    } },
    { code: 'lookback-limited', complete: false, coverage: 'partial', cursor: 'g1', expect: (h, id) => {
      assert.equal(job(h, id, 'output-walk')!.state, 'queued', 'a slice boundary with a gap resumes, it is not retried')
      assert.equal(job(h, id, 'output-walk')!.cursor, 'g1')
    } },
    { code: 'invalid-cursor', complete: false, coverage: 'partial', cursor: null, expect: (h, id) => {
      assert.equal(job(h, id, 'output-walk')!.state, 'queued')
      assert.equal(job(h, id, 'output-walk')!.cursor, null, 'the pass restarts')
    } },
    { code: 'cursor-limit', complete: false, coverage: 'partial', cursor: null, expect: (h, id) => {
      assert.equal(job(h, id, 'output-walk')!.state, 'failed', 'a deterministic failure is not retried')
      assert.equal(rootRow(h, id).coverageState, 'failed')
    } },
    { code: 'git-timeout', complete: false, coverage: 'partial', cursor: null, expect: (h, id) => {
      assert.equal(job(h, id, 'output-walk')!.state, 'retry')
      assert.equal(Date.parse(job(h, id, 'output-walk')!.retry_at as string) - h.t, 2_000)
    } },
  ]
  for (const c of cases) {
    const h = harness()
    const r0 = outputRoot(h, 'out')
    // Recovery priority: a background slice, so the 1 s pause leaves the requeued job observable (dirty work would resume).
    enqueue(h, r0.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
    h.fake.script = req => [terminal(req, { complete: c.complete, coverage: c.coverage, cursor: c.cursor, error: { code: c.code, message: `coverage gaps: ${c.code}` } })]
    const r = runner(h)
    await spin(r, 3)
    c.expect(h, r0.rootId)
  }

  // A direct check's definitive result: a missing path marks its known location missing; the job is finished.
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const gone = join(r0.canonicalPath, 'gone.md')
  // R72 (fix round 1): a location with no recorded device is proven missing only by a non-empty folder on its parent's
  // filesystem; an empty root folder could be an unmounted mount point.
  put(join(r0.canonicalPath, 'kept.md'))
  upsertArtifact(h.db, { path: gone, sizeBytes: 1, createdAt: iso(T0), projectName: null, now: iso(T0) })
  enqueue(h, artifactDirectScopeId(r0.rootId, gone), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h.fake.script = req => [terminal(req, { error: { code: 'path-missing', message: 'ENOENT' } })]
  await spin(runner(h), 3)
  assert.equal((h.db.raw.prepare('SELECT exists_state AS s FROM artifacts WHERE path = ?').get(gone) as { s: string }).s, 'missing')
  assert.equal(job(h, artifactDirectScopeId(r0.rootId, gone), 'direct-observation'), undefined)
})

test('a nested checkout keeps a pass partial with its reason; it is not retried, only recovered on schedule', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const r0 = outputRoot(h, 'out')
  h.fake.script = req => [terminal(req, { complete: true, coverage: 'partial', error: { code: 'nested-checkout', message: 'coverage gaps: nested-checkout' } })]
  const r = runner(h, { autoSchedule: true })
  await spin(r, 4)
  await r.settle()
  await spin(r, 4)
  assert.equal(h.fake.requests.length, 1)
  assert.equal(rootRow(h, r0.rootId).coverageState, 'partial')
  assert.match(readArtifactManagerState(h.db, `coverage-reason:${r0.rootId}`) ?? '', /nested-checkout/)
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'done')
  for (let i = 0; i < 5; i++) { h.t += 60_000; await spin(r, 3) }
  assert.equal(h.fake.requests.length, 1, 'no retry loop')
  h.t += 600_000
  await spin(r, 2)
  await r.settle()
  await spin(r, 4)
  assert.equal(h.fake.requests.length, 2, 'the next pass is the periodic recovery')
})

// ================================================================================================ service-side validation

test('frames are validated in the service: wrong root, wrong direct path, outside the root, bad identity, smuggled evidence', async () => {
  const bad: Array<{ name: string; setup: (h: H, root: ArtifactRootRow, other: ArtifactRootRow) => { scope: string; task: ArtifactWorkerRequest['task']; rows: ArtifactWorkerObservation[] } }> = [
    { name: 'another root', setup: (h, root, other) => ({ scope: root.rootId, task: 'output-walk', rows: [{ ...working(root, put(join(root.canonicalPath, 'x.md'))), rootId: other.rootId }] }) },
    { name: 'outside the root', setup: (h, root, other) => {
      const p = put(join(other.canonicalPath, 'y.md'))
      return { scope: root.rootId, task: 'output-walk', rows: [{ ...working(root, put(join(root.canonicalPath, 'y.md'))), path: p }] }
    } },
    { name: 'direct path', setup: (h, root) => {
      const want = put(join(root.canonicalPath, 'want.md'))
      const other = put(join(root.canonicalPath, 'other.md'))
      return { scope: artifactDirectScopeId(root.rootId, want), task: 'direct-observation', rows: [working(root, other)] }
    } },
    { name: 'invented repository identity', setup: (h, root) => {
      const p = put(join(root.canonicalPath, 'z.md'))
      return { scope: root.rootId, task: 'output-walk', rows: [{ ...working(root, p), identity: { identityKind: 'repository', repositoryId: 'nope', rootId: null, relativePath: 'z.md' } }] }
    } },
    { name: 'smuggled evidence', setup: (h, root) => {
      const p = put(join(root.canonicalPath, 'e.md'))
      return { scope: root.rootId, task: 'output-walk', rows: [{ ...working(root, p), evidence: { source: 'hook', eventKey: 'hook-event:x:1', sessionId: null, operation: 'created', certainty: 'recorded', eventAt: iso(T0) } }] }
    } },
    { name: 'commit row in a walk', setup: (h, root) => ({ scope: root.rootId, task: 'output-walk', rows: [{ ...commitRow({ ...root, repositoryId: 'r' }, 'c.md', 'c'.repeat(40)), rootId: root.rootId }] }) },
    { name: 'commit row in a status pass', setup: h => {
      const c = checkoutRoot(h, 'repo')
      return { scope: c.rootId, task: 'checkout-status', rows: [commitRow(c, 'c.md', 'c'.repeat(40))] }
    } },
  ]
  for (const c of bad) {
    const h = harness()
    const root = outputRoot(h, 'out')
    const other = outputRoot(h, 'other')
    const s = c.setup(h, root, other)
    enqueue(h, s.scope, s.task)
    h.fake.script = req => [data(req, s.rows, null), terminal(req)]
    const r = runner(h)
    await spin(r, 3)
    assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_versions'), 0, `${c.name}: nothing committed`)
    assert.deepEqual(h.fake.acks, [], `${c.name}: nothing acknowledged`)
    assert.deepEqual(h.fake.restarts, ['frame-rejected'], `${c.name}: the misbehaving worker is restarted`)
    assert.equal(job(h, s.scope, s.task)!.state, 'retry', c.name)
    assert.equal(readArtifactManagerState(h.db, 'health.rejected-frames'), '1')
  }
})

test('a root deactivated mid-job rejects its frames; a direct-only root is never bulk-scanned', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  const b = put(join(r0.canonicalPath, 'b.md'))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = req => [data(req, [working(r0, a)], 'w1'), data(req, [working(r0, b)], 'w2'), terminal(req)]
  h.fake.onAck = () => { h.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(r0.rootId) }
  const r = runner(h)
  await spin(r, 4)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_versions'), 1, 'only the frame before the deactivation')
  assert.deepEqual(h.fake.restarts, ['frame-rejected'])
  // Also a terminal frame (no rows): it must not finish a pass on a root that is no longer active.
  const h1 = harness()
  const r1 = outputRoot(h1, 'out')
  const c1 = put(join(r1.canonicalPath, 'c.md'))
  enqueue(h1, r1.rootId, 'output-walk')
  h1.fake.script = req => [data(req, [working(r1, c1)], 'w1'), terminal(req)]
  h1.fake.onAck = () => { h1.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(r1.rootId) }
  await spin(runner(h1), 4)
  assert.deepEqual(h1.fake.restarts, ['frame-rejected'])
  assert.equal(job(h1, r1.rootId, 'output-walk')!.state, 'retry')
  assert.equal(rootRow(h1, r1.rootId).appliedGeneration, 0)

  const h2 = harness()
  const direct = outputRoot(h2, 'drop', { kind: 'session-directory', scopeFlags: ['direct-only'] })
  const untouched = outputRoot(h2, 'drop2', { kind: 'output', scopeFlags: ['direct-only'] })
  const f = put(join(direct.canonicalPath, 'f.md'))
  enqueue(h2, direct.rootId, 'output-walk')
  enqueue(h2, artifactDirectScopeId(direct.rootId, f), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h2.fake.script = req => (req.task === 'direct-observation' ? [data(req, [working(direct, f)], null), terminal(req)] : [terminal(req)])
  const r2 = runner(h2, { autoSchedule: true })
  for (let i = 0; i < 4; i++) { await spin(r2, 3); await r2.settle(); h2.t += 1_000 }
  assert.deepEqual(h2.fake.requests.map(q => q.task), ['direct-observation'], 'the exact path is observed; the folder is never walked')
  assert.equal(job(h2, direct.rootId, 'output-walk')!.state, 'failed')
  assert.equal(job(h2, direct.rootId, 'output-walk')!.last_error, 'direct-only-root')
  assert.equal(n(h2, 'SELECT COUNT(*) AS n FROM artifact_jobs WHERE scope_id = ?', untouched.rootId), 0, 'recovery never schedules a bulk task for a direct-only root')
})

// ================================================================================================ R24, R26, status floor

test('R26: a completed history pass persists its cursor with the batch, and the next pass starts from it', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'repo')
  enqueue(h, c.rootId, 'git-history', ARTIFACT_JOB_PRIORITY.recovery)
  h.fake.script = (req, i) => (i === 1
    ? [data(req, [commitRow(c, 'docs/a.md', 'c'.repeat(40))], 'h1'), terminal(req, { cursor: 'tips-1' })]
    : i === 2 ? [terminal(req, { complete: false, cursor: null, error: { code: 'invalid-cursor', message: 'restart' } })] : [terminal(req, { cursor: 'tips-2' })])
  const r = runner(h)
  await spin(r, 4)
  assert.equal(h.fake.requests[0]!.cursor, null)
  assert.equal(h.fake.requests[0]!.includeOlder, false)
  assert.equal(readArtifactManagerState(h.db, `history-cursor:${c.rootId}`), 'tips-1')
  assert.equal(job(h, c.rootId, 'git-history')!.cursor, null, 'Task 2 clears the job cursor; the state key keeps it')
  enqueue(h, c.rootId, 'git-history', ARTIFACT_JOB_PRIORITY.recovery)
  h.t += 1_000
  await spin(r, 4)
  assert.equal(h.fake.requests[1]!.cursor, 'tips-1', 'routine passes continue from the persisted ref tips')
  assert.equal(h.fake.requests[1]!.includeOlder, false)
  // The worker refused it (restart): the stale cursor is dropped, not resent forever.
  assert.equal(readArtifactManagerState(h.db, `history-cursor:${c.rootId}`), null)
  h.t += 1_000
  await spin(r, 4)
  assert.equal(h.fake.requests[2]!.cursor, null)
  assert.equal(readArtifactManagerState(h.db, `history-cursor:${c.rootId}`), 'tips-2')
})

test('R26: the history cursor is written in the same transaction as the completing commit', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'repo')
  enqueue(h, c.rootId, 'git-history', ARTIFACT_JOB_PRIORITY.recovery)
  h.fake.script = req => [data(req, [commitRow(c, 'docs/a.md', 'c'.repeat(40))], 'h1'), terminal(req, { cursor: 'tips-1' })]
  h.db.raw.exec(`CREATE TRIGGER fail_cursor BEFORE INSERT ON artifact_manager_state WHEN NEW.key LIKE 'history-cursor:%' BEGIN SELECT RAISE(ABORT, 'injected'); END`)
  const r = runner(h)
  await spin(r, 4)
  const j = job(h, c.rootId, 'git-history')!
  assert.equal(j.cursor, 'h1', 'the completing commit rolled back with the failed cursor write')
  assert.equal(j.applied_generation, 0)
  assert.equal(j.state, 'retry')
  assert.equal(h.fake.acks.length, 1, 'the terminal frame was not acknowledged')
})

test('R24: sinceMs is the lookback on a first pass, spans a long downtime, and stays fixed for the whole pass', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const lookback = h.config.artifacts.initialLookbackDays * DAY
  let fail = false
  h.fake.script = (req, i) => {
    if (fail) return [terminal(req, { complete: false, coverage: 'partial', cursor: null, error: { code: 'root-inaccessible', message: 'x' } })]
    return i === 2 ? [terminal(req, { complete: false, coverage: 'partial', cursor: 'w1' })] : [terminal(req)]
  }
  const r = runner(h)
  enqueue(h, r0.rootId, 'output-walk')
  await spin(r, 3)
  assert.equal(h.fake.requests[0]!.sinceMs, T0 - lookback)
  assert.equal(readArtifactManagerState(h.db, `pass-start:${r0.rootId}`), iso(T0))
  // Atlas was stopped for ten days: the next pass reaches back to just before the previous pass started.
  h.t = T0 + 10 * DAY
  enqueue(h, r0.rootId, 'output-walk')
  await spin(r, 3)
  assert.equal(h.fake.requests[1]!.sinceMs, T0 - 60_000)
  h.t += 1_000
  await spin(r, 3)
  assert.equal(h.fake.requests[2]!.cursor, 'w1')
  assert.equal(h.fake.requests[2]!.sinceMs, T0 - 60_000, 'a resumed slice keeps its pass cutoff')
  // A first slice that fails before committing anything does not move the window forward.
  const passStart = h.t
  h.t = T0 + 30 * DAY
  fail = true
  enqueue(h, r0.rootId, 'output-walk')
  await spin(r, 3)
  const since = h.fake.requests[3]!.sinceMs!
  assert.equal(since, passStart - 1_000 - 60_000)
  fail = false
  h.t += 2_000
  await spin(r, 3)
  assert.equal(h.fake.requests[4]!.cursor, null)
  assert.equal(h.fake.requests[4]!.sinceMs, since)
})

test('status floor: one checkout status start per 30 s, resumed slices count once, direct observations bypass it', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'repo')
  const f = put(join(c.canonicalPath, 'f.md'))
  const repo = { repositoryId: c.repositoryId!, top: c.canonicalPath }
  h.fake.script = (req, i) => {
    if (req.task === 'direct-observation') return [data(req, [working(c, f, repo)], null), terminal(req)]
    return i === 1 ? [terminal(req, { complete: false, coverage: 'partial', cursor: 's1' })] : [terminal(req)]
  }
  enqueue(h, c.rootId, 'checkout-status')
  const r = runner(h)
  await spin(r, 3)
  h.t += 1_000
  await spin(r, 3)
  assert.deepEqual(h.fake.requests.map(q => q.cursor), [null, 's1'], 'the resumed slice ran within the floor')
  h.t = T0 + 5_000
  enqueue(h, c.rootId, 'checkout-status')
  enqueue(h, artifactDirectScopeId(c.rootId, f), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  await spin(r, 4)
  h.t += 1_000
  await spin(r, 4)
  assert.deepEqual(h.fake.requests.map(q => q.task), ['checkout-status', 'checkout-status', 'direct-observation'], 'the new status pass waits; the direct check does not')
  const j = job(h, c.rootId, 'checkout-status')!
  assert.equal(j.state, 'retry')
  assert.equal(j.retry_at, iso(T0 + 30_000))
  h.t = T0 + 30_000
  await spin(r, 3)
  assert.equal(h.fake.requests.length, 4)
  assert.equal(h.fake.requests[3]!.cursor, null)
  assert.equal(job(h, c.rootId, 'checkout-status')!.state, 'done')
  // A throttled claim is not a failed attempt: a transient failure right after one still waits only the first backoff step.
  h.t = T0 + 35_000
  enqueue(h, c.rootId, 'checkout-status')
  await spin(r, 3)
  assert.equal(job(h, c.rootId, 'checkout-status')!.state, 'retry')
  h.fake.script = req => [terminal(req, { complete: false, coverage: 'partial', cursor: null, error: { code: 'git-timeout', message: 'x' } })]
  h.t = T0 + 60_000
  await spin(r, 3)
  const j2 = job(h, c.rootId, 'checkout-status')!
  assert.equal(j2.last_error, 'git-timeout')
  assert.equal(Date.parse(j2.retry_at as string) - h.t, 2_000)
})

// ================================================================================================ roots

test('roots come from sessions and config: checkouts first, R27 identity fields, docs-like children, nested worktrees', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  mkdirSync(join(proj, 'src'), { recursive: true })
  git(h.home, ['init', '-q', proj])
  put(join(proj, 'README.md'))
  git(proj, ['add', 'README.md'])
  git(proj, ['commit', '-q', '-m', 'init'])
  for (const d of ['docs', 'Reports', 'phi', '.phi', '.phix', 'notes']) mkdirSync(join(proj, d))
  put(join(proj, 'docs', 'keep.md'))
  git(proj, ['worktree', 'add', '-q', join(proj, '.claude', 'worktrees', 'feat'), '-b', 'feat'])
  const other = join(proj, '.claude', 'worktrees', 'other')
  git(h.home, ['init', '-q', other])
  const scratch = join(h.home, 'scratch')
  mkdirSync(join(scratch, 'Exports'), { recursive: true })
  mkdirSync(join(scratch, 'misc'), { recursive: true })
  const external = join(h.home, 'external-out')
  mkdirSync(external)
  h.config.artifacts.outputRoots = [{ path: external, repositoryId: null, label: 'ext', protected: false }]
  const now = iso(Date.now())
  ensureSession(h.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: join(proj, 'src'), startedAt: now, now })
  ensureSession(h.db, { sessionId: '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10', cwd: scratch, startedAt: now, now })
  const order: string[] = []
  const r = runner(h, {
    autoSchedule: true, clock: () => Date.now(),
    registerRoot: (db, input, at) => { order.push(input.canonicalPath); return registerArtifactRoot(db, input, at) },
  })
  await r.run()
  await r.settle()
  await r.run()
  const roots = new Map(listArtifactRoots(h.db).map(x => [x.canonicalPath, x]))
  const main = roots.get(proj)!
  assert.equal(main.kind, 'checkout')
  assert.ok(main.repositoryId && main.checkoutIdentity)
  for (const child of ['docs', 'Reports', 'phi', '.phi']) {
    const c = roots.get(join(proj, child))
    assert.ok(c, `${child} is registered with its exact spelling`)
    assert.equal(c!.kind, 'output')
    assert.equal(c!.repositoryId, main.repositoryId, 'R27: repository of the containing checkout')
    assert.equal(c!.checkoutIdentity, main.checkoutIdentity, 'R27: and its checkout identity')
    assert.ok(order.indexOf(proj) < order.indexOf(join(proj, child)), 'the checkout is registered before its nested roots')
  }
  assert.equal(roots.get(join(proj, 'phi'))!.protected, true)
  assert.equal(roots.get(join(proj, '.phi'))!.protected, true, 'a `.phi` child is a protected output root like `phi` (R85)')
  assert.equal(roots.has(join(proj, '.phix')), false)
  assert.equal(roots.has(join(proj, 'notes')), false)
  const feat = roots.get(join(proj, '.claude', 'worktrees', 'feat'))!
  assert.equal(feat.kind, 'checkout')
  assert.equal(feat.repositoryId, main.repositoryId, 'a linked worktree shares the repository')
  assert.notEqual(feat.checkoutIdentity, main.checkoutIdentity)
  const nested = roots.get(other)!
  assert.equal(nested.kind, 'checkout', 'an unrelated checkout under .claude/worktrees is its own root')
  assert.notEqual(nested.repositoryId, main.repositoryId)
  const s = roots.get(scratch)!
  assert.equal(s.kind, 'session-directory')
  assert.deepEqual(s.scopeFlags, ['session-cwd'])
  const exports = roots.get(join(scratch, 'Exports'))!
  assert.equal(exports.kind, 'output')
  assert.equal(exports.repositoryId, null)
  assert.equal(exports.checkoutIdentity, null)
  const ext = roots.get(external)!
  assert.equal(ext.kind, 'output')
  assert.equal(ext.checkoutIdentity, null, 'an external root never gets a checkout identity')
  assert.equal(roots.has(h.home), false, 'home is never a root')
  assert.equal(roots.has(join(scratch, 'misc')), false)
})

test('roots equal to, inside or containing the Atlas data, spool or cost-ledger directory are refused and deactivated on every start', async () => {
  const home = newHome()
  const atlasHome = join(home, 'work', 'atlas-data')
  mkdirSync(join(atlasHome, 'exports'), { recursive: true })
  mkdirSync(join(home, 'fine'))
  mkdirSync(join(home, '.josh-360', 'state'), { recursive: true })
  const db = openTestDb()
  const config = loadConfig({ HOME: home, ATLAS_HOME: atlasHome })
  config.artifacts.outputRoots = [
    { path: join(home, 'work'), repositoryId: null, label: null, protected: false },
    { path: join(atlasHome, 'exports'), repositoryId: null, label: null, protected: false },
    { path: join(home, 'fine'), repositoryId: null, label: null, protected: false },
  ]
  const reg = (path: string) => registerArtifactRoot(db, { kind: 'output', canonicalPath: path, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(T0))
  const inside = reg(join(atlasHome, 'exports'))
  const ledger = reg(join(home, '.josh-360', 'state'))
  const direct = registerArtifactRoot(db, { kind: 'session-directory', canonicalPath: atlasHome, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, iso(T0))
  const fake = new FakeWorker()
  const start = () => {
    const r = artifactManagerRunner({ db, config, log: silentLogger, worker: fake, home, clock: () => Date.now(), autoSchedule: true, frameWaitMs: 0, backgroundPauseMs: 0 })
    STOPPERS.push(() => r.stop?.())
    return r
  }
  const r1 = start()
  await r1.run()
  await r1.settle()
  await r1.run()
  const active = () => new Map(listArtifactRoots(db).map(x => [x.canonicalPath, x.active]))
  let roots = active()
  assert.equal(roots.get(join(atlasHome, 'exports')), false, 'inside the Atlas data directory')
  assert.equal(roots.get(join(home, '.josh-360', 'state')), false, 'the cost-ledger directory')
  assert.equal(roots.get(atlasHome), false, 'even a direct-only root')
  assert.equal(roots.has(join(home, 'work')), false, 'a root containing the Atlas data directory is never registered')
  assert.equal(roots.get(join(home, 'fine')), true)
  // Something re-activates one (an older binary, a CLI call); the next start deactivates it again.
  reg(join(atlasHome, 'exports'))
  assert.equal(active().get(join(atlasHome, 'exports')), true)
  r1.stop?.()
  const r2 = start()
  await r2.run()
  await r2.settle()
  roots = active()
  assert.equal(roots.get(join(atlasHome, 'exports')), false)
  // A job for a refused root is never sent to the worker.
  enqueueArtifactJob(db, { scopeId: artifactDirectScopeId(direct.rootId, join(atlasHome, 'atlas.db')), taskKind: 'direct-observation', priority: 0, generation: 0 }, iso(Date.now()))
  enqueueArtifactJob(db, { scopeId: inside.rootId, taskKind: 'output-walk', priority: 10, generation: 0 }, iso(Date.now()))
  enqueueArtifactJob(db, { scopeId: ledger.rootId, taskKind: 'output-walk', priority: 10, generation: 0 }, iso(Date.now()))
  for (let i = 0; i < 6; i++) { await r2.run(); await r2.settle() }
  // Registered again while this instance runs (as Task 6 could for a hook path): refused at claim time and deactivated.
  reg(join(atlasHome, 'exports'))
  enqueueArtifactJob(db, { scopeId: inside.rootId, taskKind: 'output-walk', priority: 10, generation: 0 }, iso(Date.now()))
  for (let i = 0; i < 3; i++) { await r2.run(); await r2.settle() }
  assert.equal(active().get(join(atlasHome, 'exports')), false)
  assert.ok(fake.requests.every(q => q.root.canonicalPath === join(home, 'fine')), 'no request ever names a refused root')
  db.close()
})

test('config warnings are logged at startup', async () => {
  const h = harness()
  h.config.artifacts.warnings = ['artifacts.debounceMs: out of range 0..30000; using 30000', 'artifacts.outputRoots[0]: repeats an earlier root; merged into it']
  const r = runner(h)
  await r.run()
  await r.run()
  const lines = h.warnings.filter(w => w.includes('artifacts config'))
  assert.equal(lines.length, 2)
  assert.ok(lines[0]!.includes('artifacts.debounceMs: out of range'))
})

test('the priority facility and worker health are recorded in artifact_manager_state without paths', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = req => [data(req, [working(r0, a)], 'w1'), terminal(req, { counts: { visited: 7, eligible: 1, skipped: 2 } })]
  const r = runner(h)
  await spin(r, 4)
  assert.equal(readArtifactManagerState(h.db, 'worker.priority-facility'), 'applied')
  assert.equal(readArtifactManagerState(h.db, 'worker.priority-command'), 'test')
  assert.equal(readArtifactManagerState(h.db, 'health.entries-inspected'), '8')
  assert.equal(readArtifactManagerState(h.db, 'health.rows-committed'), '1')
  assert.equal(readArtifactManagerState(h.db, 'health.slices'), '1')
  assert.ok(readArtifactManagerState(h.db, 'health.last-pass-duration-ms') !== null)
  const values = (h.db.raw.prepare('SELECT key, value FROM artifact_manager_state').all() as Array<{ key: string; value: string }>)
  for (const v of values) assert.ok(!v.value.includes(h.home) && !v.key.includes(h.home), `no path in ${v.key}`)
})

test('watcher hints are debounced: paths become exact direct checks, an overflow dirties the scope', async () => {
  const h = harness()
  h.config.artifacts.debounceMs = 2_000
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  const r = runner(h)
  r.markDirty(r0.canonicalPath, a)
  r.markDirty(r0.canonicalPath, join(r0.canonicalPath, 'ignored.tmp'))
  r.markDirty(r0.canonicalPath, a)
  await r.run()
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_jobs'), 0, 'nothing is enqueued inside the debounce window')
  h.t += 2_000
  await r.run()
  assert.equal(job(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation')?.priority, ARTIFACT_JOB_PRIORITY.dirty)
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_jobs WHERE task_kind = 'direct-observation'`), 1, 'one job per distinct eligible path')
  r.markDirty(r0.canonicalPath, null) // overflow / lost events
  h.t += 2_000
  await r.run()
  assert.equal(job(h, r0.rootId, 'output-walk')?.priority, ARTIFACT_JOB_PRIORITY.dirty)
})


test('pause also stops root reconciliation: no Git runs and nothing is registered until resume', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  mkdirSync(proj)
  const now = iso(Date.now())
  ensureSession(h.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: proj, startedAt: now, now })
  let gitCalls = 0
  const git = { resolveCheckout: async () => { gitCalls++; return null }, listWorktrees: async () => { gitCalls++; return [] } }
  setArtifactDiscoveryPaused(h.db, true, now)
  const r = runner(h, { autoSchedule: true, clock: () => Date.now(), git })
  for (let i = 0; i < 3; i++) { await r.run(); await r.settle() }
  assert.equal(gitCalls, 0)
  assert.equal(listArtifactRoots(h.db).length, 0)
  setArtifactDiscoveryPaused(h.db, false, now)
  for (let i = 0; i < 3; i++) { await r.run(); await r.settle() }
  assert.equal(gitCalls, 1)
  assert.deepEqual(listArtifactRoots(h.db).map(x => [x.canonicalPath, x.kind]), [[proj, 'session-directory']])
})

test('R29: a version transition after a completed baseline links the overlapping session as inferred; a first pass never does', async () => {
  const h = harness()
  const S = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
  const start = Date.now()
  h.t = start - 60_000
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'), 'v1')
  ensureSession(h.db, { sessionId: S, cwd: r0.canonicalPath, startedAt: iso(start - 120_000), now: iso(start) })
  h.fake.script = req => [data(req, [{ ...working(r0, a), observedAt: iso(h.t) }], null), terminal(req)]
  enqueue(h, r0.rootId, 'output-walk')
  const r = runner(h)
  await spin(r, 3)
  assert.equal(rootRow(h, r0.rootId).appliedGeneration, 1)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_evidence'), 0, 'a first pass never infers a creator')
  writeFileSync(a, 'v2, a new signature')
  h.t = Date.now() + 1_000
  enqueue(h, r0.rootId, 'output-walk')
  await spin(r, 3)
  const ev = h.db.raw.prepare('SELECT session_id, source, certainty, operation FROM artifact_evidence').all().map(x => ({ ...x }))
  assert.deepEqual(ev, [{ session_id: S, source: 'reconcile', certainty: 'inferred', operation: 'modified' }])
})

test('a worker observation of a backfilled legacy location adopts its provisional document in the same commit', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  upsertArtifact(h.db, { path: a, sizeBytes: 1, createdAt: iso(T0 - DAY), projectName: null, now: iso(T0 - DAY) })
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  const r = runner(h)
  await spin(r, 2)
  const provisional = (h.db.raw.prepare('SELECT document_id FROM artifacts WHERE path = ?').get(a) as { document_id: string }).document_id
  assert.equal((h.db.raw.prepare('SELECT identity_kind FROM artifact_documents WHERE document_id = ?').get(provisional) as { identity_kind: string }).identity_kind, 'provisional')
  h.t += 1_000
  enqueue(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h.fake.script = req => [data(req, [working(r0, a)], null), terminal(req)]
  await spin(r, 3)
  const d = h.db.raw.prepare('SELECT d.document_id, d.identity_kind, d.identity_root_id, d.relative_path FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.path = ?').get(a) as Record<string, unknown>
  assert.deepEqual({ ...d }, { document_id: provisional, identity_kind: 'root', identity_root_id: r0.rootId, relative_path: 'a.md' })
})

// A home reached through a symlink (macOS /var -> /private/var): a legacy row recorded under home's literal spelling and a worker
// observation of the same file under its real path are ONE document, whether or not the backfill has reached the legacy row yet.
for (const backfilled of [true, false]) {
  test(`a legacy row under a symlinked home's literal spelling and its real-path observation are one document (backfilled first: ${backfilled})`, async () => {
    const base = harness()
    const real = join(base.home, 'real'); mkdirSync(real)
    const link = join(base.home, 'link'); symlinkSync(real, link)
    const h: H = { ...base, home: link }
    const r0 = registerArtifactRoot(h.db, { kind: 'output', canonicalPath: join(real, 'out'), repositoryId: null, projectName: 'out', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(h.t))
    const file = put(join(real, 'out', 'a.md'))
    const literal = join(link, 'out', 'a.md')
    upsertArtifact(h.db, { path: literal, sizeBytes: 1, createdAt: iso(T0 - DAY), projectName: 'out', now: iso(T0 - DAY) })
    const r = runner(h)
    if (backfilled) {
      enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
      await spin(r, 2)
    }
    h.t += 1_000
    enqueue(h, artifactDirectScopeId(r0.rootId, file), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
    h.fake.script = req => [data(req, [working(r0, file)], null), terminal(req)]
    await spin(r, 3)
    if (!backfilled) {
      enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
      await spin(r, 2)
    }
    assert.equal(n(h, 'SELECT COUNT(DISTINCT document_id) AS n FROM artifacts WHERE document_id IS NOT NULL'), 1, 'one file, one document')
    assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts WHERE document_id IS NULL'), 0)
    assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_documents'), 1)
  })
}

test('the legacy backfill protects a row under a symlinked home\'s literal spelling when the real path is under a protected root', async () => {
  const base = harness()
  const real = join(base.home, 'real'); mkdirSync(real)
  const link = join(base.home, 'link'); symlinkSync(real, link)
  const h: H = { ...base, home: link }
  registerArtifactRoot(h.db, { kind: 'output', canonicalPath: join(real, 'sec'), repositoryId: null, projectName: 'sec', checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, iso(h.t))
  const row = upsertArtifact(h.db, { path: join(link, 'sec', 'a.md'), sizeBytes: 1, createdAt: iso(T0 - DAY), projectName: 'sec', now: iso(T0 - DAY) })
  h.db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
  const r = runner(h)
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  await spin(r, 2)
  assert.equal(n(h, 'SELECT is_sensitive AS n FROM artifacts WHERE artifact_id = ?', row.artifactId), 1)
  assert.equal(n(h, 'SELECT d.protected AS n FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.artifact_id = ?', row.artifactId), 1)
})

test('a legacy row whose literal spelling now resolves to a different file is not merged into the observed document', async () => {
  const base = harness()
  const real = join(base.home, 'real'); mkdirSync(real)
  const link = join(base.home, 'link'); symlinkSync(real, link)
  const h: H = { ...base, home: link }
  const r0 = registerArtifactRoot(h.db, { kind: 'output', canonicalPath: join(real, 'out'), repositoryId: null, projectName: 'out', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(h.t))
  const file = put(join(real, 'out', 'a.md'))
  // The retarget below keeps the observed file inside home (a worker path outside home is refused as unauthorized), so the link moves
  // up to the parent: link/out/a.md then names this other file.
  put(join(base.home, 'out', 'a.md'))
  // The legacy row has exactly the alias spelling of the observed file, so the alias is catalogued and only the realpath guard can refuse it.
  upsertArtifact(h.db, { path: join(link, 'out', 'a.md'), sizeBytes: 1, createdAt: iso(T0 - DAY), projectName: 'out', now: iso(T0 - DAY) })
  // The runner captures home's real path now (link -> real); the home link is retargeted afterwards, so the literal spelling resolves elsewhere.
  const r = runner(h)
  unlinkSync(link); symlinkSync(base.home, link)
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  await spin(r, 2)
  h.t += 1_000
  enqueue(h, artifactDirectScopeId(r0.rootId, file), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h.fake.script = req => [data(req, [working(r0, file)], null), terminal(req)]
  await spin(r, 3)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_documents'), 2, 'the alias now resolves to another file; nothing is merged on a guess')
})

test('protocol refusals: a busy worker is restarted and the job retried; a refused request fails the job', async () => {
  for (const [code, state, restarts] of [['worker-busy', 'retry', ['worker-busy']], ['invalid-request', 'failed', []]] as const) {
    const h = harness()
    const r0 = outputRoot(h, 'out')
    enqueue(h, r0.rootId, 'output-walk')
    h.fake.script = req => [{ ...terminal(req), jobId: '', complete: false, coverage: 'partial', error: { code, message: 'refused' } }]
    await spin(runner(h), 3)
    assert.equal(job(h, r0.rootId, 'output-walk')!.state, state, code)
    assert.deepEqual(h.fake.restarts, [...restarts])
    assert.deepEqual(h.fake.acks, [], 'a refusal belongs to no job and is never acknowledged')
  }
})


test('recovery never re-enqueues a root parked mid-pass, nor a scope whose job failed deterministically', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 60_000
  const big = outputRoot(h, 'big')
  const bad = outputRoot(h, 'bad')
  h.fake.script = req => {
    if (req.root.rootId === bad.rootId) return [terminal(req, { complete: false, coverage: 'partial', cursor: null, error: { code: 'cursor-limit', message: 'x' } })]
    const i = req.cursor === null ? 0 : Number(req.cursor.slice(1))
    return [terminal(req, { complete: false, coverage: 'partial', cursor: `b${i + 1}` })]
  }
  const r = runner(h, { autoSchedule: true })
  for (let i = 0; i < 8; i++) { await spin(r, 3); await r.settle(); h.t += 61_000 }
  assert.equal(job(h, big.rootId, 'output-walk')!.desired_generation, 1, 'a long pass is not bumped by recovery')
  assert.ok(h.fake.requests.filter(q => q.root.rootId === big.rootId).length >= 6, 'the pass keeps progressing slice by slice')
  assert.equal(h.fake.requests.filter(q => q.root.rootId === bad.rootId).length, 1, 'a deterministic failure waits for activity or a configuration change')
  assert.equal(job(h, bad.rootId, 'output-walk')!.state, 'failed')
})


test('a pass interrupted by a service crash stays leased, then resumes from its committed checkpoint in the next service', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  const b = put(join(r0.canonicalPath, 'b.md'))
  enqueue(h, r0.rootId, 'output-walk')
  // The first service commits one batch and dies before acknowledging or finishing anything (no stop(), no exit event).
  h.fake.script = req => [data(req, [working(r0, a)], 'w1')]
  const first = runner(h)
  await spin(first, 2)
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'running')
  assert.equal(job(h, r0.rootId, 'output-walk')!.cursor, 'w1')
  // A second service (fresh worker) leaves the leased job alone until the lease expires.
  const fake2 = new FakeWorker()
  fake2.script = req => [data(req, [working(r0, a), working(r0, b)], 'w2'), terminal(req)]
  h.fake = fake2 // the first runner keeps its own (dead) worker
  const second = runner(h)
  h.t += 30_000
  await spin(second, 3)
  assert.equal(fake2.requests.length, 0, 'the lease still holds')
  h.t += 31_000
  await spin(second, 4)
  assert.equal(fake2.requests.length, 1)
  assert.equal(fake2.requests[0]!.cursor, 'w1', 'resumed from the committed checkpoint')
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'done')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_versions'), 2, 'the replayed row created no second version')
})


// ================================================================================================ fix round 1

test('I1: stop() during a root reconciliation makes no further Git call', async () => {
  const h = harness()
  const now = iso(Date.now())
  for (let i = 0; i < 10; i++) {
    mkdirSync(join(h.home, `p${i}`))
    ensureSession(h.db, { sessionId: `2864efe7-6e70-4357-9e2f-a4ef9a4f33${String(10 + i)}`, cwd: join(h.home, `p${i}`), startedAt: now, now })
  }
  let calls = 0
  const git = {
    resolveCheckout: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return null },
    listWorktrees: async () => { calls++; return [] },
  }
  const r = runner(h, { autoSchedule: true, clock: () => Date.now(), git })
  await r.run()
  while (calls < 2) await new Promise(resolve => setTimeout(resolve, 5))
  r.stop?.()
  const atStop = calls
  await r.settle()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(calls, atStop, 'the reconciliation makes no Git call after stop()')
  assert.equal(listArtifactRoots(h.db).length, 0, 'and a partial plan is never applied')
})

test('I1: no Git process started by a reconciliation outlives stop()', async () => {
  const h = harness()
  const now = iso(Date.now())
  for (let i = 0; i < 12; i++) {
    git(h.home, ['init', '-q', join(h.home, `repo${i}`)])
    ensureSession(h.db, { sessionId: `3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c${String(10 + i)}`, cwd: join(h.home, `repo${i}`), startedAt: now, now })
  }
  const seen: Array<{ child: import('node:child_process').ChildProcess; at: number }> = []
  const watch = (message: unknown) => {
    const child = (message as { process?: import('node:child_process').ChildProcess }).process
    if (child) queueMicrotask(() => { if (child.spawnfile === 'git' && child.spawnargs[1] === '--no-pager') seen.push({ child, at: Date.now() }) })
  }
  const dc = await import('node:diagnostics_channel')
  dc.subscribe('child_process', watch)
  try {
    const r = runner(h, { autoSchedule: true, clock: () => Date.now() })
    await r.run()
    while (seen.length < 3) await new Promise(resolve => setTimeout(resolve, 2))
    const stopAt = Date.now()
    r.stop?.()
    await r.settle()
    await new Promise(resolve => setTimeout(resolve, 300))
    const after = seen.filter(s => s.at > stopAt)
    assert.ok(after.length <= 8, `at most the one adapter call already under way may still start a process (saw ${after.length})`)
    assert.ok(seen.every(s => s.child.exitCode !== null || s.child.signalCode !== null), 'every Git process has exited')
    assert.ok(seen.length < 12 * 8, 'the reconciliation stopped early')
  } finally {
    dc.unsubscribe('child_process', watch)
  }
})

test('I2: terminal frames that contradict their error kind are rejected and never complete a pass', async () => {
  const cases: Array<Partial<ArtifactWorkerFrame>> = [
    { complete: true, coverage: 'inaccessible', error: { code: 'root-inaccessible', message: 'x' } },
    { complete: true, coverage: 'complete', error: { code: 'root-missing', message: 'x' } },
    { complete: true, coverage: 'complete', error: { code: 'invalid-cursor', message: 'x' } },
    { complete: true, coverage: 'complete', error: { code: 'permission-denied', message: 'coverage gaps: permission-denied' } },
    { complete: true, coverage: 'complete', error: { code: 'cursor-limit', message: 'x' } },
    { complete: true, coverage: 'inaccessible' },
    { complete: true, coverage: 'complete', error: { code: 'path-missing', message: 'ENOENT' } },
  ]
  for (const c of cases) {
    const h = harness()
    const r0 = outputRoot(h, 'out')
    enqueue(h, r0.rootId, 'output-walk')
    h.fake.script = req => [terminal(req, c)]
    await spin(runner(h), 3)
    const label = JSON.stringify(c)
    assert.deepEqual(h.fake.restarts, ['frame-rejected'], label)
    assert.deepEqual(h.fake.acks, [], label)
    assert.equal(rootRow(h, r0.rootId).appliedGeneration, 0, label)
    assert.equal(rootRow(h, r0.rootId).lastSuccessfulAt, null, label)
    assert.equal(job(h, r0.rootId, 'output-walk')!.applied_generation, 0, label)
  }
  // A restart with complete: false is consistent, but still must not hand Task 2 a completed pass.
  const h = harness()
  const r0 = outputRoot(h, 'out')
  enqueue(h, r0.rootId, 'output-walk')
  h.fake.script = req => [terminal(req, { complete: false, coverage: 'partial', error: { code: 'invalid-cursor', message: 'x' } })]
  await spin(runner(h), 3)
  assert.equal(job(h, r0.rootId, 'output-walk')!.applied_generation, 0)
  // Task 5 ends a refused direct check with complete: true (ledgered M4): accepted as a failure that completes nothing.
  const hd = harness()
  const rd = outputRoot(hd, 'out')
  const f = put(join(rd.canonicalPath, 'f.md'))
  enqueue(hd, artifactDirectScopeId(rd.rootId, f), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  hd.fake.script = req => [terminal(req, { complete: true, coverage: 'partial', error: { code: 'path-denied', message: 'outside-roots' } })]
  await spin(runner(hd), 3)
  const dj = job(hd, artifactDirectScopeId(rd.rootId, f), 'direct-observation')!
  assert.equal(dj.state, 'failed')
  assert.equal(dj.applied_generation, 0)
  assert.deepEqual(hd.fake.restarts, [])
})

test('I4: a root removed from config and re-added is scanned again; deterministic failures clear on the next start', async () => {
  const h = harness()
  const out = join(h.home, 'out')
  mkdirSync(out)
  const git = { resolveCheckout: async () => null, listWorktrees: async () => [] }
  const start = (declared: boolean) => {
    h.config.artifacts.outputRoots = declared ? [{ path: out, repositoryId: null, label: null, protected: false }] : []
    return runner(h, { autoSchedule: true, git, backgroundPauseMs: 0 })
  }
  const settle = async (r: ReturnType<typeof runner>, n = 6) => { for (let i = 0; i < n; i++) { await r.run(); await r.settle() } }
  let r = start(true)
  await settle(r)
  r.stop?.()
  const rootId = listArtifactRoots(h.db).find(x => x.canonicalPath === out)!.rootId
  assert.equal(h.fake.requests.length, 1)
  // A hint left a job queued; the user removes the root from config and restarts: deactivated, the job refused.
  enqueue(h, rootId, 'output-walk')
  h.t += 1_000
  r = start(false)
  await settle(r)
  r.stop?.()
  assert.equal(rootRow(h, rootId).active, false)
  assert.equal(job(h, rootId, 'output-walk')!.last_error, 'root-inactive')
  assert.equal(readArtifactManagerState(h.db, `job-failed:output-walk:${rootId}`), null, 'a refused inactive root is not a failed scope')
  // Re-added and restarted: reactivated and scanned (the first recovery is due at once).
  h.t += 1_000
  r = start(true)
  await settle(r)
  assert.equal(rootRow(h, rootId).active, true)
  assert.equal(h.fake.requests.length, 2)
  r.stop?.()

  // A deterministic failure key is cleared at the next start; an exhausted transient one is kept; reactivation clears both.
  h.db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, 'cursor-limit', ?), (?, 'root-inaccessible', ?)`)
    .run(`job-failed:output-walk:${rootId}`, iso(h.t), `job-failed:git-history:${rootId}`, iso(h.t))
  r = start(true)
  await r.run()
  assert.equal(readArtifactManagerState(h.db, `job-failed:output-walk:${rootId}`), null)
  assert.equal(readArtifactManagerState(h.db, `job-failed:git-history:${rootId}`), 'root-inaccessible')
  r.stop?.()
  h.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(rootId)
  r = start(true)
  await settle(r, 3)
  assert.equal(readArtifactManagerState(h.db, `job-failed:git-history:${rootId}`), null, 'reactivation clears what awaited it')
  r.stop?.()
})

test('I5: output children of a session cwd below its checkout top are registered with the checkout identity', async () => {
  const h = harness()
  const repo = join(h.home, 'repo')
  git(h.home, ['init', '-q', repo])
  put(join(repo, 'README.md'))
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  const web = join(repo, 'packages', 'web')
  mkdirSync(join(web, 'docs'), { recursive: true })
  mkdirSync(join(web, 'src'))
  const now = iso(Date.now())
  ensureSession(h.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: web, startedAt: now, now })
  const r = runner(h, { autoSchedule: true, clock: () => Date.now() })
  await r.run()
  await r.settle()
  await r.run()
  const roots = new Map(listArtifactRoots(h.db).map(x => [x.canonicalPath, x]))
  const top = roots.get(repo)!
  const docs = roots.get(join(web, 'docs'))
  assert.ok(docs, 'the session cwd docs child is a root')
  assert.equal(docs!.kind, 'output')
  assert.equal(docs!.repositoryId, top.repositoryId)
  assert.equal(docs!.checkoutIdentity, top.checkoutIdentity)
  assert.equal(roots.has(join(web, 'src')), false)
})

test('R34: a pass whose only gap is nested worktrees completes once every one is an active root of its own', async () => {
  type Case = { name: string; register: Array<'a' | 'b'>; deactivate?: 'b'; error: { code: string; message: string }; complete: boolean }
  const cases: Case[] = [
    { name: 'all registered', register: ['a', 'b'], error: { code: 'nested-worktree', message: 'coverage gaps: nested-worktree' }, complete: true },
    { name: 'one unregistered', register: ['a'], error: { code: 'nested-worktree', message: 'coverage gaps: nested-worktree' }, complete: false },
    { name: 'one inactive', register: ['a', 'b'], deactivate: 'b', error: { code: 'nested-worktree', message: 'coverage gaps: nested-worktree' }, complete: false },
    { name: 'nested checkout', register: ['a', 'b'], error: { code: 'nested-checkout', message: 'coverage gaps: nested-checkout' }, complete: false },
    { name: 'mixed gaps', register: ['a', 'b'], error: { code: 'permission-denied', message: 'coverage gaps: permission-denied, nested-worktree' }, complete: false },
  ]
  for (const c of cases) {
    const h = harness()
    const repo = checkoutRoot(h, 'repo')
    for (const w of ['a', 'b'] as const) {
      const path = join(repo.canonicalPath, '.claude', 'worktrees', w)
      mkdirSync(path, { recursive: true })
      if (!c.register.includes(w)) continue
      const row = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: path, repositoryId: repo.repositoryId, projectName: 'repo', checkoutIdentity: `ck-${w}`, protected: false, scopeFlags: ['checkout'] }, iso(h.t))
      if (c.deactivate === w) h.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(row.rootId)
    }
    enqueue(h, repo.rootId, 'checkout-status')
    h.fake.script = req => [terminal(req, { complete: true, coverage: 'partial', error: c.error })]
    await spin(runner(h), 3)
    const row = rootRow(h, repo.rootId)
    assert.equal(job(h, repo.rootId, 'checkout-status')!.state, 'done', c.name)
    if (c.complete) {
      assert.equal(row.coverageState, 'idle', c.name)
      assert.ok(row.lastSuccessfulAt !== null, `${c.name}: a completed baseline (R29 inference can run)`)
      assert.match(readArtifactManagerState(h.db, `coverage-reason:${repo.rootId}`) ?? '', /nested-worktrees-registered/)
    } else {
      assert.equal(row.coverageState, 'partial', c.name)
      assert.equal(row.lastSuccessfulAt, null, c.name)
    }
  }
})

test('R35: dirty and direct jobs still run during the 1 s pause and a reconciliation; background work waits; an explicit pause blocks all', async () => {
  const h = harness()
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  enqueue(h, r0.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
  h.fake.script = req => (req.task === 'direct-observation' ? [data(req, [working(r0, a)], null), terminal(req)] : [terminal(req)])
  const r = runner(h)
  await spin(r, 2) // the walk ran: a background slice, so the 1 s pause starts now
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  enqueue(h, r0.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
  enqueue(h, artifactDirectScopeId(r0.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  await spin(r, 3)
  assert.deepEqual(h.fake.requests.map(q => q.task), ['output-walk', 'direct-observation'], 'the direct check ran inside the pause window')
  assert.equal(job(h, 'legacy-backfill', 'legacy-backfill')!.state, 'queued', 'background work waits for the pause')
  assert.equal(job(h, r0.rootId, 'output-walk')!.state, 'queued')
  // A dirty slice is not background work: it starts no pause, so recovery work may follow at once.
  const hd = harness()
  const d0 = outputRoot(hd, 'out')
  const d1 = outputRoot(hd, 'other')
  enqueue(hd, d0.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.dirty)
  hd.t += 1
  enqueue(hd, d1.rootId, 'output-walk', ARTIFACT_JOB_PRIORITY.recovery)
  await spin(runner(hd), 4)
  assert.deepEqual(hd.fake.requests.map(q => q.root.rootId), [d0.rootId, d1.rootId])

  // During a reconciliation (its Git is still answering), a direct job runs and a background one does not.
  const h2 = harness()
  const r2root = outputRoot(h2, 'out')
  const b = put(join(r2root.canonicalPath, 'b.md'))
  mkdirSync(join(h2.home, 'proj'))
  const now = iso(Date.now())
  ensureSession(h2.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: join(h2.home, 'proj'), startedAt: now, now })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const git = { resolveCheckout: async () => { await gate; return null }, listWorktrees: async () => [] }
  h2.fake.script = req => (req.task === 'direct-observation' ? [data(req, [working(r2root, b)], null), terminal(req)] : [terminal(req)])
  const r2 = runner(h2, { autoSchedule: true, clock: () => Date.now(), git })
  await r2.run() // starts the reconciliation
  enqueue(h2, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  setArtifactDiscoveryPaused(h2.db, true, now)
  enqueue(h2, artifactDirectScopeId(r2root.rootId, b), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  await spin(r2, 3)
  assert.equal(h2.fake.requests.length, 0, 'an explicit pause blocks even direct observations')
  setArtifactDiscoveryPaused(h2.db, false, now)
  await spin(r2, 3)
  assert.deepEqual(h2.fake.requests.map(q => q.task), ['direct-observation'])
  assert.equal(job(h2, 'legacy-backfill', 'legacy-backfill')!.state, 'queued', 'the backfill waits for the reconciliation')
  release()
  await r2.settle()
})

// ================================================================================================ A1: include-older per task

const older = (h: H, task: string, rootId: string) => readArtifactManagerState(h.db, `include-older:${task}:${rootId}`)
/** Claims go by priority, then updated_at: moving one job's updated_at later forces the other job to be claimed first. */
function claimLast(h: H, scopeId: string, task: string, afterMs = 1): void {
  h.db.raw.prepare('UPDATE artifact_jobs SET updated_at = ? WHERE scope_id = ? AND task_kind = ?').run(iso(h.t + afterMs), scopeId, task)
}
/** A second checkout of `c`'s repository (a linked worktree). */
function worktreeOf(h: H, c: ArtifactRootRow, name: string): ArtifactRootRow {
  const path = join(h.home, name)
  mkdirSync(path, { recursive: true })
  return registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: path, repositoryId: c.repositoryId, projectName: name, checkoutIdentity: `ck-${name}`, protected: false, scopeFlags: ['checkout'] }, iso(h.t))
}

const LOOKBACK = { code: 'lookback-limited', message: 'coverage gaps: lookback-limited' }
/** The scan task's coverage note for a root (runner state), or null. */
function coverageNote(h: H, rootId: string): { codes: string[]; complete: boolean; info?: string } | null {
  const v = readArtifactManagerState(h.db, `coverage-reason:${rootId}`)
  return v === null ? null : JSON.parse(v) as { codes: string[]; complete: boolean; info?: string }
}
const coverageOf = (h: H, rootId: string) => {
  const row = rootRow(h, rootId)
  return { state: row.coverageState, baseline: row.lastSuccessfulAt !== null, codes: coverageNote(h, rootId)?.codes ?? [] }
}

test('R67: a walk\'s first-pass lookback gap stays visible until "Import older files" completes; later passes that skip aged files still complete', async () => {
  const h = harness()
  const o = outputRoot(h, 'out')
  const r = runner(h)
  let gap: { code: string; message: string } | null = LOOKBACK
  h.fake.script = req => [terminal(req, gap ? { coverage: 'partial', error: gap } : {})]
  const pass = async (includeOlder = false): Promise<void> => {
    h.t += 60_000
    requestArtifactRefresh(h.db, o.rootId, { includeOlder, now: iso(h.t) })
    await spin(r, 3)
    assert.equal(h.fake.requests.at(-1)!.includeOlder, includeOlder)
  }
  // The root's first pass skipped eligible files older than the lookback: partial, no baseline, the gap recorded.
  await pass()
  assert.deepEqual(coverageOf(h, o.rootId), { state: 'partial', baseline: false, codes: ['lookback-limited'] })
  // A later normal pass skips the same files again (or files imported earlier that have aged past the rolling lookback):
  // nothing new. It completes (a baseline: R29 inference can run) and the first pass's gap stays visible.
  await pass()
  assert.deepEqual(coverageOf(h, o.rootId), { state: 'idle', baseline: true, codes: ['lookback-limited'] })
  // A normal pass that skips nothing keeps it too: only importing the older files clears it.
  gap = null
  await pass()
  assert.deepEqual(coverageOf(h, o.rootId), { state: 'idle', baseline: true, codes: ['lookback-limited'] })
  // "Import older files" completes: cleared.
  await pass(true)
  assert.deepEqual(coverageOf(h, o.rootId), { state: 'idle', baseline: true, codes: [] })
  assert.equal(coverageNote(h, o.rootId), null)
  // Afterwards every file was imported: aged files skipped by a normal pass are not a gap.
  gap = LOOKBACK
  await pass()
  assert.deepEqual(coverageOf(h, o.rootId), { state: 'idle', baseline: true, codes: [] })
  // Any other gap still keeps a pass partial, and visible.
  gap = { code: 'permission-denied', message: 'coverage gaps: permission-denied, lookback-limited' }
  await pass()
  assert.deepEqual(coverageOf(h, o.rootId), { state: 'partial', baseline: true, codes: ['permission-denied'] })

  // Why only the first pass counts: a root whose first pass imported everything, whose files later age past the rolling
  // lookback (every later pass's cutoff), is complete; reporting those skips would keep it partial for good.
  const fresh = outputRoot(h, 'fresh')
  gap = null
  requestArtifactRefresh(h.db, fresh.rootId, { includeOlder: false, now: iso(h.t) })
  await spin(r, 3)
  gap = LOOKBACK
  h.t += 8 * DAY
  requestArtifactRefresh(h.db, fresh.rootId, { includeOlder: false, now: iso(h.t) })
  await spin(r, 3)
  assert.deepEqual(coverageOf(h, fresh.rootId), { state: 'idle', baseline: true, codes: [] })
})

test('R67: checkout status keeps its own lookback gap; a pass still in progress or failed keeps it; R34 resolves nested worktrees beside a known skip', async () => {
  const h = harness()
  const repo = checkoutRoot(h, 'repo')
  const r = runner(h)
  let frames: (req: ArtifactWorkerRequest) => ArtifactWorkerFrame[] = req => [terminal(req, { coverage: 'partial', error: LOOKBACK })]
  h.fake.script = req => (req.task === 'checkout-status' ? frames(req) : [terminal(req)])
  enqueue(h, repo.rootId, 'checkout-status')
  await spin(r, 3)
  assert.deepEqual(coverageOf(h, repo.rootId), { state: 'partial', baseline: false, codes: ['lookback-limited'] })
  // A later pass that pauses mid-way, and one that fails, leave the gap where it is.
  frames = req => [terminal(req, { complete: false, coverage: 'partial', cursor: 's1' })]
  h.t += 60_000
  enqueue(h, repo.rootId, 'checkout-status')
  await spin(r, 2)
  assert.deepEqual(coverageNote(h, repo.rootId)?.codes, ['lookback-limited'])
  frames = req => [terminal(req, { complete: false, coverage: 'partial', cursor: req.cursor, error: { code: 'git-timeout', message: 'git status failed' } })]
  h.t += 60_000
  await spin(r, 2)
  assert.deepEqual(coverageNote(h, repo.rootId)?.codes, ['lookback-limited'])
  // Every nested worktree is an active root of its own (R34) and the only other gap is the known lookback skip: complete.
  for (const w of ['a', 'b']) {
    const path = join(repo.canonicalPath, '.claude', 'worktrees', w)
    mkdirSync(path, { recursive: true })
    registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: path, repositoryId: repo.repositoryId, projectName: 'repo', checkoutIdentity: `ck-${w}`, protected: false, scopeFlags: ['checkout'] }, iso(h.t))
  }
  frames = req => [terminal(req, { coverage: 'partial', error: { code: 'nested-worktree', message: 'coverage gaps: nested-worktree, lookback-limited' } })]
  h.t += 600_000
  await spin(r, 6)
  assert.deepEqual(coverageOf(h, repo.rootId), { state: 'idle', baseline: true, codes: ['lookback-limited'] })
  assert.equal(coverageNote(h, repo.rootId)?.info, 'nested-worktrees-registered')
})

test('A1: the status pass finishing first leaves the history pass its import-older request (status claimed first)', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'repo')
  const r = runner(h)
  const q = requestArtifactRefresh(h.db, c.rootId, { includeOlder: true, now: iso(h.t) })
  assert.deepEqual(q.scopes.map(s => `${s.task}:${s.rootId}`), [`checkout-status:${c.rootId}`, `git-history:${c.rootId}`])
  assert.equal(q.jobId, q.scopes[0]!.jobId)
  assert.equal(q.historyJobId, q.scopes[1]!.jobId)
  assert.equal(older(h, 'checkout-status', c.rootId), '1')
  assert.equal(older(h, 'git-history', c.rootId), '1')
  assert.equal(readArtifactManagerState(h.db, `include-older:${c.rootId}`), null, 'no root-wide key any more')
  claimLast(h, c.rootId, 'git-history')
  h.fake.script = req => [terminal(req, req.task === 'git-history' ? { cursor: 'tips-1' } : {})]
  h.t += 1_000
  await spin(r, 2)
  assert.deepEqual(h.fake.requests.map(x => [x.task, x.includeOlder]), [['checkout-status', true]])
  assert.equal(job(h, c.rootId, 'checkout-status')!.state, 'done')
  assert.equal(older(h, 'checkout-status', c.rootId), null, 'the status pass consumed its own request')
  assert.equal(older(h, 'git-history', c.rootId), '1', 'and left the history request alone')
  assert.equal(includeOlderPending(h.db, c.rootId), true)
  await spin(r, 2)
  assert.deepEqual(h.fake.requests.map(x => [x.task, x.includeOlder]), [['checkout-status', true], ['git-history', true]])
  assert.equal(older(h, 'git-history', c.rootId), null)
  assert.equal(includeOlderPending(h.db, c.rootId), false)
})

test('A1: the history pass finishing first leaves the status pass its import-older request (history claimed first)', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'repo')
  const o = outputRoot(h, 'out')
  const r = runner(h)
  requestArtifactRefresh(h.db, c.rootId, { includeOlder: true, now: iso(h.t) })
  requestArtifactRefresh(h.db, o.rootId, { includeOlder: true, now: iso(h.t) })
  claimLast(h, c.rootId, 'checkout-status')
  claimLast(h, o.rootId, 'output-walk', 2)
  h.fake.script = req => [terminal(req, req.task === 'git-history' ? { cursor: 'tips-1' } : {})]
  h.t += 1_000
  await spin(r, 2)
  assert.deepEqual(h.fake.requests.map(x => [x.task, x.includeOlder]), [['git-history', true]])
  assert.equal(older(h, 'git-history', c.rootId), null)
  assert.equal(older(h, 'checkout-status', c.rootId), '1')
  assert.equal(older(h, 'output-walk', o.rootId), '1', 'another root\'s walk request is not touched either')
  assert.equal(includeOlderPending(h.db, c.rootId), true)
  await spin(r, 4)
  assert.deepEqual(h.fake.requests.map(x => [x.task, x.includeOlder]), [['git-history', true], ['checkout-status', true], ['output-walk', true]])
  assert.equal(older(h, 'checkout-status', c.rootId), null)
  assert.equal(older(h, 'output-walk', o.rootId), null)
  assert.equal(includeOlderPending(h.db, c.rootId), false)
  assert.equal(includeOlderPending(h.db, o.rootId), false)
})

test('A1: a request made during a pass survives that pass and the next pass honors it; includeOlder is fixed at pass start', async () => {
  const h = harness()
  const o = outputRoot(h, 'out')
  const r = runner(h)
  // Every first slice parks mid-pass; every resumed slice completes.
  h.fake.script = req => [req.cursor === null ? terminal(req, { complete: false, coverage: 'partial', cursor: 'w1' }) : terminal(req)]
  // A plain refresh starts a pass without includeOlder; the request arrives while it is parked.
  requestArtifactRefresh(h.db, o.rootId, { includeOlder: false, now: iso(h.t) })
  await spin(r, 2)
  h.t += 1_000
  requestArtifactRefresh(h.db, o.rootId, { includeOlder: true, now: iso(h.t) })
  h.t += 1_000
  await spin(r, 2)
  assert.deepEqual(h.fake.requests.map(x => [x.cursor, x.includeOlder]), [[null, false], ['w1', false]], 'the resumed slice keeps the pass-start choice')
  assert.equal(older(h, 'output-walk', o.rootId), '1', 'the pass that never consumed the request does not clear it')
  assert.equal(job(h, o.rootId, 'output-walk')!.state, 'queued', 'the refresh asked for another pass')
  // The next pass consumes it; a second request arrives during that pass.
  h.t += 1_000
  await spin(r, 2)
  assert.equal(h.fake.requests.at(-1)!.includeOlder, true)
  assert.equal(h.fake.requests.at(-1)!.cursor, null)
  h.t += 1_000
  requestArtifactRefresh(h.db, o.rootId, { includeOlder: true, now: iso(h.t) })
  h.t += 1_000
  await spin(r, 2)
  assert.equal(h.fake.requests.at(-1)!.cursor, 'w1')
  assert.equal(h.fake.requests.at(-1)!.includeOlder, true, 'resumed slices of a consuming pass keep includeOlder')
  assert.equal(older(h, 'output-walk', o.rootId), '1', 'a request newer than the pass start survives its completion')
  assert.equal(includeOlderPending(h.db, o.rootId), true)
  // The pass after that honors the newer request and, with nothing newer, clears it.
  h.t += 1_000
  await spin(r, 4)
  assert.deepEqual(h.fake.requests.slice(-2).map(x => [x.cursor, x.includeOlder]), [[null, true], ['w1', true]])
  assert.equal(older(h, 'output-walk', o.rootId), null)
  assert.equal(includeOlderPending(h.db, o.rootId), false)
  assert.equal(job(h, o.rootId, 'output-walk')!.state, 'done')
})

test('A1: a partial, retried, failed or restarted pass leaves its request; only a completed consuming pass clears it', async () => {
  const h = harness()
  const o = outputRoot(h, 'out')
  const r = runner(h)
  const outcome: Array<Partial<ArtifactWorkerFrame>> = [
    { complete: false, coverage: 'partial', cursor: 'w1' },
    { complete: false, coverage: 'partial', cursor: 'w1', error: { code: 'root-inaccessible', message: 'x' } },
    { complete: false, coverage: 'partial', cursor: 'w1', error: { code: 'root-moved', message: 'x' } },
    { complete: false, coverage: 'partial', cursor: null, error: { code: 'invalid-cursor', message: 'x' } },
    {},
  ]
  h.fake.script = (req, i) => [terminal(req, outcome[i - 1]!)]
  requestArtifactRefresh(h.db, o.rootId, { includeOlder: true, now: iso(h.t) })
  const states: string[] = []
  const step = async (ms: number) => {
    h.t += ms
    await spin(r, 2)
    states.push(String(job(h, o.rootId, 'output-walk')!.state))
    assert.equal(older(h, 'output-walk', o.rootId), states.length < outcome.length ? '1' : null, `after outcome ${states.length}`)
  }
  await step(1_000)
  await step(1_000)
  await step(2_000)
  // A deterministic failure parks the scope until a new request; that request does not ask for older files again.
  requestArtifactRefresh(h.db, o.rootId, { includeOlder: false, now: iso(h.t) })
  await step(1_000)
  await step(1_000)
  assert.deepEqual(states, ['queued', 'retry', 'failed', 'queued', 'done'])
  assert.ok(h.fake.requests.every(x => x.includeOlder), 'every slice and every restarted pass still honored the request')
  assert.equal(includeOlderPending(h.db, o.rootId), false)
})

test('A1: each task\'s request is cleared only by that task\'s consuming pass; pending covers the repository\'s history root', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'a-main')
  const wt = worktreeOf(h, c, 'b-wt')
  const r = runner(h)
  h.db.raw.prepare('INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)').run(`history-cursor:${wt.rootId}`, 'tips-0', iso(h.t))
  // The history pass of the repository runs on the checkout holding its cursor, for a refresh of either checkout.
  const q = requestArtifactRefresh(h.db, c.rootId, { includeOlder: true, now: iso(h.t) })
  assert.deepEqual(q.scopes.map(s => `${s.task}:${s.rootId}`), [`checkout-status:${c.rootId}`, `git-history:${wt.rootId}`])
  assert.equal(includeOlderPending(h.db, c.rootId), true)
  assert.equal(includeOlderPending(h.db, wt.rootId), true, 'the worktree shares the repository\'s history request')
  // A history pass that started before the request (no consumption) completes without clearing it.
  h.db.raw.prepare(`DELETE FROM artifact_jobs`).run()
  enqueue(h, wt.rootId, 'git-history')
  h.fake.script = req => [req.task === 'git-history' && req.cursor === 'tips-0' ? terminal(req, { complete: false, coverage: 'partial', cursor: 'h1' }) : terminal(req, req.task === 'git-history' ? { cursor: 'tips-1' } : {})]
  h.db.raw.prepare(`DELETE FROM artifact_manager_state WHERE key LIKE 'include-older:%'`).run()
  h.t += 1_000
  await spin(r, 2)
  assert.deepEqual(h.fake.requests.map(x => [x.task, x.cursor, x.includeOlder]), [['git-history', 'tips-0', false]])
  h.t += 1_000
  requestArtifactRefresh(h.db, c.rootId, { includeOlder: true, now: iso(h.t) })
  claimLast(h, c.rootId, 'checkout-status')
  h.t += 1_000
  await spin(r, 2)
  assert.deepEqual([h.fake.requests.at(-1)!.task, h.fake.requests.at(-1)!.cursor, h.fake.requests.at(-1)!.includeOlder], ['git-history', 'h1', false])
  assert.equal(older(h, 'git-history', wt.rootId), '1', 'a pass that did not consume the request leaves it')
  assert.equal(older(h, 'checkout-status', c.rootId), '1')
  // The status pass clears only its own key; the next history pass consumes and clears the history key.
  await spin(r, 2)
  assert.equal(h.fake.requests.at(-1)!.task, 'checkout-status')
  assert.equal(older(h, 'checkout-status', c.rootId), null)
  assert.equal(older(h, 'git-history', wt.rootId), '1')
  assert.equal(includeOlderPending(h.db, c.rootId), true, 'pending until every applicable request is consumed')
  await spin(r, 2)
  assert.deepEqual([h.fake.requests.at(-1)!.task, h.fake.requests.at(-1)!.includeOlder], ['git-history', true])
  assert.equal(older(h, 'git-history', wt.rootId), null)
  assert.equal(includeOlderPending(h.db, c.rootId), false)
  assert.equal(includeOlderPending(h.db, wt.rootId), false)
})

test('A1: requestArtifactRefresh refuses a direct-only root and coalesces repeated requests into one job per scope', async () => {
  const h = harness()
  const c = checkoutRoot(h, 'repo')
  const d = outputRoot(h, 'direct', { kind: 'session-directory', scopeFlags: ['direct-only'] })
  assert.throws(() => requestArtifactRefresh(h.db, d.rootId, { includeOlder: true, now: iso(h.t) }),
    (e: unknown) => e instanceof ArtifactRefreshRefusedError && e.code === 'direct-only-root')
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_manager_state WHERE key LIKE 'include-older:%'`), 0)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_jobs'), 0)
  assert.equal(includeOlderPending(h.db, d.rootId), false)
  const first = requestArtifactRefresh(h.db, c.rootId, { includeOlder: true, now: iso(h.t) })
  for (let i = 0; i < 3; i++) {
    const again = requestArtifactRefresh(h.db, c.rootId, { includeOlder: true, now: iso(h.t) })
    assert.deepEqual([again.jobId, again.historyJobId], [first.jobId, first.historyJobId])
  }
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_jobs'), 2)
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_manager_state WHERE key LIKE 'include-older:%'`), 2)
})

// ================================================================================================ end to end with the real worker

function realRunner(h: H, over: Partial<ArtifactManagerRunnerDeps> = {}) {
  const worker = createArtifactWorkerClient({ log: silentLogger, home: h.home })
  const r = artifactManagerRunner({ db: h.db, config: h.config, log: silentLogger, worker, home: h.home, backgroundPauseMs: 0, frameWaitMs: 50, ...over })
  STOPPERS.push(() => r.stop?.())
  return { r, worker }
}

async function until(r: { run(): Promise<boolean>; settle(): Promise<void> }, done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the runner')
    await r.run()
    await r.settle()
  }
}

test('end to end: the real worker discovers an output root and a small Git repository', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  git(h.home, ['init', '-q', proj])
  put(join(proj, 'docs', 'plan.md'), 'plan\n')
  git(proj, ['add', '.'])
  git(proj, ['commit', '-q', '-m', 'plan'])
  put(join(proj, 'notes.md'), 'untracked\n')
  const out = join(h.home, 'out')
  put(join(out, 'report.csv'), 'a,b\n')
  h.config.artifacts.outputRoots = [{ path: out, repositoryId: null, label: 'out', protected: false }]
  const now = iso(Date.now())
  ensureSession(h.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: proj, startedAt: now, now })
  touchSession(h.db, '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', now)
  const { r, worker } = realRunner(h)
  const docs = () => new Map((h.db.raw.prepare('SELECT relative_path, identity_kind FROM artifact_documents').all() as Array<{ relative_path: string; identity_kind: string }>).map(d => [d.relative_path, d.identity_kind]))
  await until(r, () => {
    const status = getArtifactManagerStatus(h.db, iso(Date.now()))
    return status.pendingJobs === 0 && docs().size >= 3 && readArtifactManagerState(h.db, `history-cursor:${listArtifactRoots(h.db).find(x => x.canonicalPath === proj)?.rootId}`) !== null
  })
  const d = docs()
  assert.equal(d.get('report.csv'), 'root')
  assert.equal(d.get('notes.md'), 'repository')
  assert.equal(d.get('docs/plan.md'), 'repository')
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifact_documents d ON d.document_id = v.document_id WHERE d.relative_path = 'docs/plan.md' AND v.kind = 'commit'`), 1)
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_documents WHERE relative_path = 'docs/plan.md'`), 1, 'walk and history agree on one document')
  assert.equal(readArtifactManagerState(h.db, 'worker.priority-facility'), 'applied')
  assert.ok(Number(readArtifactManagerState(h.db, 'health.slices')) > 0)
  const pid = worker.status().pid
  r.stop?.()
  await new Promise(resolve => setTimeout(resolve, 200))
  if (pid !== null) assert.throws(() => process.kill(pid, 0), /ESRCH/)
})

test('end to end: killing the real worker after a commit and before its ack resumes without duplicate versions', async () => {
  const h = harness()
  h.config.artifacts.debounceMs = 0 // the files were written an instant ago and this test is not about the quiet period
  const out = join(h.home, 'out')
  for (let i = 0; i < 260; i++) put(join(out, `f${String(i).padStart(3, '0')}.md`))
  const root = registerArtifactRoot(h.db, { kind: 'output', canonicalPath: out, repositoryId: null, projectName: 'out', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, iso(Date.now()))
  enqueueArtifactJob(h.db, { scopeId: root.rootId, taskKind: 'output-walk', priority: 10, generation: 0 }, iso(Date.now()))
  const real = createArtifactWorkerClient({ log: silentLogger, home: h.home })
  let killed = false
  const worker: ArtifactWorkerClient = {
    start: q => real.start(q), poll: () => real.poll(), wait: ms => real.wait(ms), restart: why => real.restart(why), stop: () => real.stop(), status: () => real.status(),
    ack: jobId => {
      if (!killed) { killed = true; process.kill(real.status().pid!, 'SIGKILL'); return }
      real.ack(jobId)
    },
  }
  const r = artifactManagerRunner({ db: h.db, config: h.config, log: silentLogger, worker, home: h.home, backgroundPauseMs: 0, frameWaitMs: 50, autoSchedule: false })
  STOPPERS.push(() => r.stop?.())
  await until(r, () => killed && job(h, root.rootId, 'output-walk')?.state === 'retry')
  // PERF-GAP-3: the real worker honours the requested frame size (artifacts.maxRowsPerFrame, by default ARTIFACT_DEFAULT_FRAME_ROWS).
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), h.config.artifacts.maxRowsPerFrame, 'the first frame was committed before the kill')
  assert.equal(h.config.artifacts.maxRowsPerFrame, ARTIFACT_DEFAULT_FRAME_ROWS)
  h.db.raw.prepare(`UPDATE artifact_jobs SET retry_at = ? WHERE job_id = ?`).run(iso(Date.now()), job(h, root.rootId, 'output-walk')!.job_id as string)
  await until(r, () => job(h, root.rootId, 'output-walk')?.state === 'done')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), 260)
  assert.equal(n(h, `SELECT COUNT(*) AS n FROM artifact_versions`), 260, 'one version per file: the replay was idempotent')
  assert.equal(readArtifactManagerState(h.db, 'health.worker-crashes'), '1')
})

test('end to end: a large root is sliced and a small root completes while it is still mid-pass', async () => {
  const h = harness()
  h.config.artifacts.debounceMs = 0 // the files were written an instant ago and this test is not about the quiet period
  h.config.artifacts.maxEntriesPerSlice = 100
  const large = join(h.home, 'large')
  const small = join(h.home, 'small')
  for (let i = 0; i < 350; i++) put(join(large, `d${i % 7}`, `f${i}.md`))
  put(join(small, 'one.md'))
  const reg = (p: string) => registerArtifactRoot(h.db, { kind: 'output', canonicalPath: p, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, iso(Date.now()))
  const L = reg(large), S = reg(small)
  enqueueArtifactJob(h.db, { scopeId: L.rootId, taskKind: 'output-walk', priority: 20, generation: 0 }, iso(Date.now() - 10))
  enqueueArtifactJob(h.db, { scopeId: S.rootId, taskKind: 'output-walk', priority: 20, generation: 0 }, iso(Date.now() - 5))
  const { r } = realRunner(h, { autoSchedule: false })
  let smallFirst = false
  await until(r, () => {
    if (rootRow(h, S.rootId).appliedGeneration === 1 && rootRow(h, L.rootId).appliedGeneration === 0) smallFirst = true
    return rootRow(h, L.rootId).appliedGeneration === 1
  })
  assert.ok(smallFirst, 'the small root finished before the large one')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts'), 351)
  assert.ok(Number(readArtifactManagerState(h.db, 'health.slices')) >= 5, 'the large root took several slices')
})

// ================================================================================================ Defect Wave 2a

test('DEFECT-3: a bounded, resumable Git object check marks a collected version unavailable and restores it when the object returns', async () => {
  const h = harness()
  const repo = join(h.home, 'proj')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  for (const n of ['a', 'b', 'c']) put(join(repo, 'docs', `${n}.md`), `${n}\n`)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'docs'])
  const commit = git(repo, ['rev-parse', 'HEAD']).trim()
  const repositoryId = registerArtifactRepository(h.db, { commonDir: join(repo, '.git'), displayName: 'proj', remoteIdentity: null }, iso(h.t))
  const root = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: repo, repositoryId, projectName: 'proj', checkoutIdentity: 'ck-proj', protected: false, scopeFlags: ['checkout'] }, iso(h.t))
  const versions = Object.fromEntries(['a', 'b', 'c'].map(n => {
    const blob = git(repo, ['rev-parse', `HEAD:docs/${n}.md`]).trim()
    const v = recordArtifactObservation(h.db, {
      rootId: root.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: `docs/${n}.md` }, kind: 'commit', observedAt: iso(h.t),
      git: { repositoryId, commitOid: commit, gitPath: `docs/${n}.md`, blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 2 },
    }, iso(h.t))
    return [n, { blob, versionId: v.versionId! }]
  })) as Record<string, { blob: string; versionId: string }>
  const avail = (n: string) => (h.db.raw.prepare('SELECT availability FROM artifact_version_state WHERE version_id = ?').get(versions[n]!.versionId) as { availability: string }).availability
  const checked = () => Number(readArtifactManagerState(h.db, 'health.git-objects-checked') ?? 0)
  // b.md's blob is garbage-collected.
  const object = join(repo, '.git', 'objects', versions.b!.blob.slice(0, 2), versions.b!.blob.slice(2))
  const saved = readFileSync(object)
  unlinkSync(object)

  enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
  const first = runner(h, { gitObjectBatch: 2, gitObjectRecheckMs: 0 })
  await first.run()
  await first.settle()
  await first.run()
  assert.equal(checked(), 2, 'one bounded slice: two versions')
  assert.equal(job(h, 'git-objects', 'verify')!.state, 'queued', 'the pass continues later')
  assert.notEqual(job(h, 'git-objects', 'verify')!.cursor, null, 'from its committed cursor')
  // A new service resumes the pass from the cursor (no version is checked twice).
  first.stop?.()
  const second = runner(h, { gitObjectBatch: 2, gitObjectRecheckMs: 0 })
  h.t += 1_001
  await second.run()
  await second.settle()
  await second.run()
  assert.equal(checked(), 3)
  assert.equal(job(h, 'git-objects', 'verify')!.state, 'done')
  assert.deepEqual({ a: avail('a'), b: avail('b'), c: avail('c') }, { a: 'available', b: 'unavailable', c: 'available' }, 'only the collected object is unavailable')
  assert.equal(h.fake.requests.length, 0, 'the service checks objects itself; the worker is not involved')
  // A pass in which Git answers nothing (its output cap makes the adapter refuse) proves nothing and changes nothing.
  writeFileSync(object, saved)
  const cap = h.config.artifacts.gitMaxOutputBytes
  h.config.artifacts.gitMaxOutputBytes = 1
  const blind = runner(h, { gitObjectBatch: 10, gitObjectRecheckMs: 0 })
  enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
  h.t += 1_001
  await blind.run()
  await blind.settle()
  await blind.run()
  blind.stop?.()
  h.config.artifacts.gitMaxOutputBytes = cap
  assert.equal(job(h, 'git-objects', 'verify')!.state, 'done')
  assert.deepEqual({ a: avail('a'), b: avail('b'), c: avail('c') }, { a: 'available', b: 'unavailable', c: 'available' }, 'an unanswered object is never judged')
  // The object returned (fetched again): the next pass makes the version available again.
  enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
  h.t += 1_001
  for (let i = 0; i < 3 && job(h, 'git-objects', 'verify')!.state !== 'done'; i++) {
    await second.run()
    await second.settle()
    await second.run()
    h.t += 1_001
  }
  assert.equal(job(h, 'git-objects', 'verify')!.state, 'done')
  assert.equal(avail('b'), 'available')
})

// ================================================================================================ fix round 1: I2

/** The schema and the row count of every table (FTS shadow tables aside), read through its own read-only connection. */
function catalogFile(path: string): unknown {
  const ro = new DatabaseSync(path, { readOnly: true })
  try {
    const schema = ro.prepare(`SELECT type, name, sql FROM sqlite_schema ORDER BY type, name`).all()
    const tables = ro.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name`).all() as Array<{ name: string }>
    return { schema, counts: tables.map(t => [t.name, (ro.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n]) }
  } finally { ro.close() }
}

test('the artifact manager is not built on a catalog migrated by a pre-release build of migration 9, and the service does not start on it (fix round 1, I2)', async () => {
  // The runner: refused before anything is written (no worker started, no statistics discarded, no job touched).
  const h = harness()
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  toPreReleaseCatalog(h.db)
  const before = catalogFile(h.db.path)
  assert.throws(() => runner(h), /^Error: artifact-catalog-prerelease-schema: .*missing column artifact_documents\.availability/)
  assert.deepEqual(catalogFile(h.db.path), before)
  assert.deepEqual(h.fake.requests, [])
  // A current catalog builds.
  assert.doesNotThrow(() => runner(harness()))

  // The real service: it exits at start with the message, as the other schema guards make it, and leaves the file as it was.
  const home = newHome()
  const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
  const db = openDatabase(config.dbPath)
  toPreReleaseCatalog(db)
  ensureSession(db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: home, startedAt: '2026-10-27T10:00:00.000Z', now: '2026-10-27T10:00:00.000Z' })
  db.close()
  const file = catalogFile(config.dbPath)
  // Everything under the temporary HOME: no ATLAS_HOME from the caller's environment.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ATLAS_PORT: '0' }
  delete env.ATLAS_HOME
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(process.cwd(), 'src', 'service', 'main.ts')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', d => { stderr += String(d) })
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, 30_000)
    child.on('exit', c => { clearTimeout(timer); resolve(c) })
  })
  assert.equal(code, 1, `the service exits at start (stderr: ${stderr})`)
  assert.match(stderr, /^atlas failed to start: Error: artifact-catalog-prerelease-schema: .*pre-release build of migration 9.*Back up the database file/s)
  assert.match(stderr, /Atlas has not changed the artifact catalog and will not start on it\./)
  assert.deepEqual(catalogFile(config.dbPath), file, 'the artifact catalog (schema and every table\'s rows) is unchanged')
})

test('a Git object check commits its proofs in parts of at most maxRowsPerFrame rows, a turn of the event loop apart, with its checkpoint in the last part (fix round 1, I1)', async () => {
  const h = harness()
  h.config.artifacts.maxRowsPerFrame = 2
  const repo = join(h.home, 'proj')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  const names = ['a', 'b', 'c', 'd', 'e']
  for (const n of names) put(join(repo, 'docs', `${n}.md`), `${n}\n`)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'docs'])
  const commit = git(repo, ['rev-parse', 'HEAD']).trim()
  const repositoryId = registerArtifactRepository(h.db, { commonDir: join(repo, '.git'), displayName: 'proj', remoteIdentity: null }, iso(h.t))
  const root = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: repo, repositoryId, projectName: 'proj', checkoutIdentity: 'ck-proj', protected: false, scopeFlags: ['checkout'] }, iso(h.t))
  for (const n of names) {
    recordArtifactObservation(h.db, {
      rootId: root.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: `docs/${n}.md` }, kind: 'commit', observedAt: iso(h.t),
      git: { repositoryId, commitOid: commit, gitPath: `docs/${n}.md`, blobOid: git(repo, ['rev-parse', `HEAD:docs/${n}.md`]).trim(), objectFormat: 'sha1', mode: 0o100644, size: 2 },
    }, iso(h.t))
  }
  // Unproven until the check: each proof of "present" changes one version.
  h.db.raw.prepare(`UPDATE artifact_version_state SET availability = 'unknown'`).run()
  const proven = () => n(h, `SELECT COUNT(*) AS n FROM artifact_version_state WHERE availability = 'available'`)
  enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
  // Each outermost transaction that proves versions: how many, the job's state and cursor after it, and whether a macrotask ran
  // before the next one.
  const parts: Array<{ proved: number; state: string; done: boolean }> = []
  const order: string[] = []
  const transaction = h.db.transaction
  let depth = 0
  h.db.transaction = <T>(fn: () => T): T => {
    if (depth > 0) return transaction(fn)
    depth++
    const before = proven()
    try { return transaction(fn) } finally {
      depth--
      const proved = proven() - before
      if (proved > 0) {
        const j = job(h, 'git-objects', 'verify')!
        parts.push({ proved, state: j.state as string, done: j.state === 'done' })
        order.push('part')
        setImmediate(() => order.push('turn'))
      }
    }
  }
  const r = runner(h, { gitObjectBatch: 10, gitObjectRecheckMs: 0 })
  await r.run()
  await r.settle()
  for (let i = 0; i < 6 && job(h, 'git-objects', 'verify')!.state !== 'done'; i++) await r.run()
  assert.deepEqual(parts.map(p => p.proved), [2, 2, 1], 'one slice of five versions, committed in parts of at most two')
  assert.deepEqual(parts.map(p => p.done), [false, false, true], 'the checkpoint and the job outcome go with the last part only')
  assert.deepEqual(order, ['part', 'turn', 'part', 'turn', 'part', 'turn'])
  assert.equal(Number(readArtifactManagerState(h.db, 'health.git-objects-checked')), 5)
  r.stop?.()

  // A stop between parts: what was committed stays, the cursor and the job do not move, so the rest is simply checked again.
  h.db.transaction = transaction
  h.db.raw.prepare(`UPDATE artifact_version_state SET availability = 'unknown'`).run()
  enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
  h.t += 1_001
  const before = job(h, 'git-objects', 'verify')!
  const s = runner(h, { gitObjectBatch: 10, gitObjectRecheckMs: 0 })
  await s.run()
  await s.settle()
  await s.run()
  s.stop?.()
  await s.run()
  const after = job(h, 'git-objects', 'verify')!
  assert.equal(proven(), 2, 'only the first part was committed')
  assert.equal(after.cursor, before.cursor, 'the checkpoint did not move')
  assert.notEqual(after.state, 'done')
})

test('DEFECT-3: the Git object check is scheduled with recovery at verify priority, and a pass under way is never bumped', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 60_000
  // Two commit versions of a repository with no reachable checkout: the pass walks them in three slices and runs no Git.
  const repositoryId = registerArtifactRepository(h.db, { commonDir: join(h.home, 'gone', '.git'), displayName: 'gone', remoteIdentity: null }, iso(h.t))
  const holder = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: join(h.home, 'gone'), repositoryId, projectName: 'gone', checkoutIdentity: 'ck-gone', protected: false, scopeFlags: ['direct-only'] }, iso(h.t))
  for (const n of ['a', 'b']) {
    recordArtifactObservation(h.db, {
      rootId: holder.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: `${n}.md` }, kind: 'commit', observedAt: iso(h.t),
      git: { repositoryId, commitOid: 'c'.repeat(40), gitPath: `${n}.md`, blobOid: (n === 'a' ? 'd' : 'e').repeat(40), objectFormat: 'sha1', mode: 0o100644, size: 2 },
    }, iso(h.t))
  }
  const r = runner(h, { autoSchedule: true, gitObjectBatch: 1, gitObjectRecheckMs: 0, git: { resolveCheckout: async () => null, listWorktrees: async () => [] } })
  const verify = () => job(h, 'git-objects', 'verify')
  const tick = async (advanceMs: number) => { await r.run(); await r.settle(); h.t += advanceMs }
  for (let i = 0; i < 4 && !(verify()?.cursor); i++) await tick(0)
  assert.ok(verify(), 'scheduled with recovery')
  assert.equal(verify()!.priority, ARTIFACT_JOB_PRIORITY.verify)
  assert.notEqual(verify()!.cursor, null, 'the first slice is committed and the pass continues')
  // The recovery interval elapses mid-pass: recovery is due again, but the pass under way is not bumped.
  h.t += 61_000
  const midPass: number[] = []
  for (let i = 0; i < 8 && verify()!.applied_generation === 0; i++) {
    await tick(1_001)
    if (verify()!.applied_generation === 0) midPass.push(Number(verify()!.desired_generation))
  }
  assert.ok(midPass.length >= 2, `the rest of the pass took several ticks: ${midPass.length}`)
  assert.deepEqual([...new Set(midPass)], [1], 'never bumped while under way')
  assert.equal(verify()!.applied_generation, 1, 'the pass completed')
  assert.equal(h.fake.requests.length, 0)
})

// F-RESTART-PASS (Wave 2a): the recovery schedule survives a service restart (persisted per scope as the last completion time).
const noGit = { resolveCheckout: async () => null, listWorktrees: async () => [] }
async function ticks(r: { run(): Promise<boolean>; settle(): Promise<void> }, h: H, n: number, advanceMs: number): Promise<void> {
  for (let i = 0; i < n; i++) { await r.run(); await r.settle(); h.t += advanceMs }
}

test('F-RESTART-PASS: a restart after a completed pass starts no extra pass until the interval elapses on the persisted clock', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const o = outputRoot(h, 'out')
  const walks = (w: FakeWorker) => w.requests.filter(q => q.task === 'output-walk' && q.root.rootId === o.rootId).length
  const first = runner(h, { autoSchedule: true, git: noGit })
  await ticks(first, h, 6, 1_001)
  assert.equal(walks(h.fake), 1, 'the recovery pass ran')
  assert.equal(job(h, o.rootId, 'output-walk')!.state, 'done')
  const doneAt = h.t
  first.stop?.()
  // A new service process (fresh worker) five minutes later: the root completed recently, so nothing is re-walked.
  const fake2 = new FakeWorker()
  h.fake = fake2
  h.t += 300_000
  const second = runner(h, { autoSchedule: true, git: noGit })
  await ticks(second, h, 8, 1_001)
  assert.equal(walks(fake2), 0, 'no extra pass after the restart')
  // Once the interval has elapsed since that completion, recovery runs again, exactly once.
  h.t = doneAt + 600_000 + 5_000
  await ticks(second, h, 8, 1_001)
  assert.equal(walks(fake2), 1, 'the next pass follows the persisted schedule')
})

test('F-RESTART-PASS: a restart mid-pass resumes from the committed cursor and the resumed pass is not followed by another', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const o = outputRoot(h, 'out')
  const a = put(join(o.canonicalPath, 'a.md'))
  h.fake.script = req => [data(req, [working(o, a)], 'w1'), terminal(req, { complete: false, coverage: 'partial', cursor: 'w1' })]
  const first = runner(h, { autoSchedule: true, git: noGit })
  await ticks(first, h, 5, 1_001)
  assert.equal(job(h, o.rootId, 'output-walk')!.cursor, 'w1', 'the first slice is committed')
  first.stop?.()
  // The new service resumes the pass (once the dead service's 60 s lease has expired), completes it, and then leaves the root
  // alone until the interval elapses.
  const fake2 = new FakeWorker()
  h.fake = fake2
  h.t += 61_000
  const second = runner(h, { autoSchedule: true, git: noGit })
  await ticks(second, h, 10, 1_001)
  const walks = fake2.requests.filter(q => q.task === 'output-walk' && q.root.rootId === o.rootId)
  assert.deepEqual(walks.map(q => q.cursor), ['w1'], 'resumed from the cursor, and no second pass from the first directory')
  assert.equal(job(h, o.rootId, 'output-walk')!.state, 'done')
  assert.equal(job(h, o.rootId, 'output-walk')!.desired_generation, 1, 'never bumped by the restart')
})

test('F-RESTART-PASS: a Git history pass parked mid-pass is resumed after a restart, not bumped into a second pass', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const c = checkoutRoot(h, 'proj')
  h.fake.script = req => (req.task === 'git-history' && req.cursor === null
    ? [terminal(req, { complete: false, coverage: 'partial', cursor: 'h1' })]
    : [terminal(req)])
  const first = runner(h, { autoSchedule: true, git: noGit })
  await ticks(first, h, 6, 1_001)
  assert.equal(job(h, c.rootId, 'git-history')!.cursor, 'h1', 'the history pass is parked mid-pass')
  first.stop?.()
  const fake2 = new FakeWorker()
  h.fake = fake2
  h.t += 61_000
  const second = runner(h, { autoSchedule: true, git: noGit })
  await ticks(second, h, 10, 1_001)
  const history = fake2.requests.filter(q => q.task === 'git-history')
  assert.deepEqual(history.map(q => q.cursor), ['h1'], 'resumed once, never restarted from no cursor')
  assert.equal(job(h, c.rootId, 'git-history')!.desired_generation, 1)
  assert.equal(job(h, c.rootId, 'git-history')!.state, 'done')
})

// PERF-GAP-2 (R47, Wave 2a): the include-older flag of every root in one status or list call. It used to resolve the
// repository's history root (a filter, a sort and one state read per checkout) once per root: O(K^2) for K checkouts.
test('PERF-GAP-2 (R47): include-older flags for K checkouts cost one read without a request, and one more read per call with one', () => {
  const h = harness()
  const main = checkoutRoot(h, 'proj')
  const worktrees = Array.from({ length: 60 }, (_, i) => worktreeOf(h, main, `wt${String(i).padStart(2, '0')}`))
  const roots = listArtifactRoots(h.db)
  // Count every statement that reads manager state, through a proxied connection.
  const stateReads: string[] = []
  const raw = new Proxy(h.db.raw, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => { if (sql.includes('artifact_manager_state')) stateReads.push(sql); return target.prepare(sql) }
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const counted = { ...h.db, raw }
  assert.equal(includeOlderPendingRoots(counted, roots).size, 0)
  assert.equal(stateReads.length, 1, `no request at all: one read (${stateReads.length})`)
  // A request on one worktree: its own status scope and the repository's history root are pending; the history request
  // belongs to every checkout of the repository.
  // (The repository's history root is the checkout holding its history cursor.)
  h.db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, 'cursor', ?)`).run(`history-cursor:${worktrees[5]!.rootId}`, iso(h.t))
  requestArtifactRefresh(h.db, worktrees[10]!.rootId, { includeOlder: true, now: iso(h.t) })
  assert.ok(readArtifactManagerState(h.db, `include-older:git-history:${worktrees[5]!.rootId}`), 'the history request is on the cursor holder')
  stateReads.length = 0
  const pending = includeOlderPendingRoots(counted, roots)
  assert.ok(stateReads.length <= 2, `with a request: the include-older and history-cursor keys are read once per call, not per checkout (${stateReads.length})`)
  assert.deepEqual(pending, new Set(roots.map(r => r.rootId)))
  for (const r of roots) assert.equal(pending.has(r.rootId), includeOlderPending(h.db, r.rootId, { roots }), 'the per-root answer agrees')
  // Only a status request (no history request): exactly that root.
  h.db.raw.prepare(`DELETE FROM artifact_manager_state WHERE key LIKE 'include-older:git-history:%'`).run()
  assert.deepEqual(includeOlderPendingRoots(h.db, roots), new Set([worktrees[10]!.rootId]))
})

// R72 (Wave 2a fix round 1): a direct check's path-missing answer goes through the same proof as the verifier.
test('R72: a direct check answering path-missing marks the location missing only with the device proof', async () => {
  const h = harness()
  const o = outputRoot(h, 'out')
  const a = put(join(o.canonicalPath, 'a.md'))
  const b = put(join(o.canonicalPath, 'b.md'))
  h.fake.script = req => {
    if (req.cursor === null && req.task === 'direct-observation' && h.fake.requests.length <= 2) return [data(req, [working(o, req.path!)], null), terminal(req)]
    return [terminal(req, { error: { code: 'path-missing', message: 'ENOENT' } })]
  }
  enqueue(h, artifactDirectScopeId(o.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  enqueue(h, artifactDirectScopeId(o.rootId, b), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  const r = runner(h)
  await spin(r, 6)
  const state = (p: string) => ({ ...(h.db.raw.prepare('SELECT exists_state AS e, verification_state AS v FROM artifacts WHERE path = ?').get(p) as { e: string; v: string | null }) })
  assert.deepEqual([state(a).e, state(b).e], ['present', 'present'])
  rmSync(a)
  rmSync(b)
  // b was last seen on another device (its volume is not mounted here): ENOENT proves nothing about it.
  const sig = JSON.parse((h.db.raw.prepare('SELECT observation_signature AS s FROM artifacts WHERE path = ?').get(b) as { s: string }).s) as unknown[]
  h.db.raw.prepare('UPDATE artifacts SET observation_signature = ? WHERE path = ?').run(JSON.stringify(['999999999', ...sig.slice(1)]), b)
  enqueue(h, artifactDirectScopeId(o.rootId, a), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  enqueue(h, artifactDirectScopeId(o.rootId, b), 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  await spin(r, 6)
  assert.equal(state(a).e, 'missing', 'control: ENOENT on the device it was seen on')
  assert.deepEqual(state(b), { e: 'present', v: 'unverified' }, 'not proven: unverified, never missing')
})

// I1 (Wave 2a fix round 1): a worktree Git no longer lists is deactivated, and so are the roots registered inside it whose
// folder went with it (its auto-registered docs/ child): an active root that is not its folder stays unverified forever.
test('I1: roots nested in a removed worktree are retired with it once their folder is gone', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  git(h.home, ['init', '-q', proj])
  put(join(proj, 'README.md'))
  git(proj, ['add', 'README.md'])
  git(proj, ['commit', '-q', '-m', 'init'])
  const wt = join(h.home, 'proj-wt')
  git(proj, ['worktree', 'add', '-q', wt, '-b', 'feat'])
  mkdirSync(join(wt, 'docs'))
  const keepOut = join(h.home, 'keep-out')
  mkdirSync(keepOut)
  const now = iso(Date.now())
  ensureSession(h.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: proj, startedAt: now, now })
  const start = async () => {
    const r = runner(h, { autoSchedule: true, clock: () => Date.now() })
    await r.run()
    await r.settle()
    await r.run()
    r.stop?.()
  }
  await start()
  const roots = () => new Map(listArtifactRoots(h.db).map(x => [x.canonicalPath, x]))
  assert.equal(roots().get(wt)?.active, true)
  assert.equal(roots().get(join(wt, 'docs'))?.active, true, 'the worktree\'s docs/ child is a root of its own')
  // A CLI root inside the worktree whose folder survives elsewhere is not affected; nor is an unrelated root.
  registerArtifactRoot(h.db, { kind: 'output', canonicalPath: keepOut, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, now)
  git(proj, ['worktree', 'remove', '--force', wt])
  await start()
  assert.equal(roots().get(wt)?.active, false, 'Git no longer lists the worktree')
  assert.equal(roots().get(join(wt, 'docs'))?.active, false, 'its docs/ root went with it')
  assert.equal(roots().get(proj)?.active, true)
  assert.equal(roots().get(keepOut)?.active, true)
})

// ------------------------------------------------------------------------------------------------ fix round 1: the Git object check

/** A real repository with one commit and `n` commit versions catalogued with made-up blob OIDs (all answered "missing"). */
function objectRepo(h: H, name: string, n: number, tag: number): { root: ArtifactRootRow; versionIds: string[] } {
  const path = join(h.home, name)
  git(h.home, ['init', '-q', path])
  git(path, ['commit', '-q', '--allow-empty', '-m', 'init'])
  const repositoryId = registerArtifactRepository(h.db, { commonDir: join(path, '.git'), displayName: name, remoteIdentity: null }, iso(h.t))
  const root = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: path, repositoryId, projectName: name, checkoutIdentity: `ck-${name}`, protected: false, scopeFlags: ['checkout'] }, iso(h.t))
  const versionIds = Array.from({ length: n }, (_, j) => recordArtifactObservation(h.db, {
    rootId: root.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: `d/${j}.md` }, kind: 'commit', observedAt: iso(h.t),
    git: { repositoryId, commitOid: 'c'.repeat(40), gitPath: `d/${j}.md`, blobOid: `${tag.toString(16).padStart(4, '0')}${j.toString(16).padStart(4, '0')}`.padEnd(40, 'b'), objectFormat: 'sha1', mode: 0o100644, size: 2 },
  }, iso(h.t)).versionId!)
  return { root, versionIds }
}
const availabilityOf = (h: H, versionId: string) => (h.db.raw.prepare('SELECT availability AS a FROM artifact_version_state WHERE version_id = ?').get(versionId) as { a: string }).a
async function runObjectPass(h: H, r: ReturnType<typeof runner>, max = 40): Promise<void> {
  enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
  for (let i = 0; i < max && job(h, 'git-objects', 'verify')!.state !== 'done'; i++) {
    await r.run()
    await r.settle()
    await r.run()
    h.t += 1_001
  }
  assert.equal(job(h, 'git-objects', 'verify')!.state, 'done')
}

test('I4: the object check takes one slice per repository, not per few versions, and skips versions checked within the interval', async () => {
  const h = harness()
  const repos = Array.from({ length: 8 }, (_, i) => objectRepo(h, `repo${i}`, 50, i + 1))
  // Every version is due: last checked seven hours ago.
  h.db.raw.prepare('UPDATE artifact_version_state SET checked_at = ?').run(iso(h.t - 7 * 3_600_000))
  const r = runner(h)
  const spawnsBefore = artifactGitSpawnCount()
  await runObjectPass(h, r)
  const slices = Number(readArtifactManagerState(h.db, 'health.git-objects-slices'))
  const spawns = artifactGitSpawnCount() - spawnsBefore
  assert.ok(slices <= 9, `one slice per repository (and the closing one): ${slices}`)
  assert.ok(spawns <= 2 * 8 + 1, `a configuration read and one batch-check per repository: ${spawns} Git processes`)
  assert.deepEqual([...new Set(repos.flatMap(x => x.versionIds).map(v => availabilityOf(h, v)))], ['unavailable'], 'every version was checked')
  // Right after: everything was checked within the interval, so the next pass runs no Git at all.
  const again = artifactGitSpawnCount()
  await runObjectPass(h, r)
  assert.equal(artifactGitSpawnCount() - again, 0, 'nothing is re-checked inside the interval')
})

test('I5: a repository with no reachable checkout stops advertising its Git versions (unknown, never unavailable)', async () => {
  const h = harness()
  const { root, versionIds } = objectRepo(h, 'proj', 3, 9)
  rmSync(root.canonicalPath, { recursive: true })
  const r = runner(h, { gitObjectRecheckMs: 0 })
  const spawnsBefore = artifactGitSpawnCount()
  await runObjectPass(h, r)
  assert.deepEqual(versionIds.map(v => availabilityOf(h, v)), ['unknown', 'unknown', 'unknown'])
  assert.equal(artifactGitSpawnCount() - spawnsBefore, 0, 'no Git is run without a checkout')
})

test('I3: the object check is pinned to the recorded repository: a checkout whose .git vanished never answers from an enclosing one', async () => {
  const h = harness()
  // An enclosing repository (a superproject, or a dotfiles repository in HOME) around the registered one.
  const outer = join(h.home, 'outer')
  git(h.home, ['init', '-q', outer])
  git(outer, ['commit', '-q', '--allow-empty', '-m', 'outer'])
  const inner = join(outer, 'inner')
  git(outer, ['init', '-q', inner])
  put(join(inner, 'doc.md'), 'inner bytes\n')
  git(inner, ['add', 'doc.md'])
  git(inner, ['commit', '-q', '-m', 'inner'])
  const blob = git(inner, ['rev-parse', 'HEAD:doc.md']).trim()
  const repositoryId = registerArtifactRepository(h.db, { commonDir: join(inner, '.git'), displayName: 'inner', remoteIdentity: null }, iso(h.t))
  const root = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: inner, repositoryId, projectName: 'inner', checkoutIdentity: 'ck-inner', protected: false, scopeFlags: ['checkout'] }, iso(h.t))
  const v = recordArtifactObservation(h.db, {
    rootId: root.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: 'doc.md' }, kind: 'commit', observedAt: iso(h.t),
    git: { repositoryId, commitOid: git(inner, ['rev-parse', 'HEAD']).trim(), gitPath: 'doc.md', blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 12 },
  }, iso(h.t)).versionId!
  const r = runner(h, { gitObjectRecheckMs: 0 })
  await runObjectPass(h, r)
  assert.equal(availabilityOf(h, v), 'available', 'control: present in its own repository')
  // The inner repository's .git disappears (a de-initialized submodule, a lost worktree link); the folder stays.
  renameSync(join(inner, '.git'), join(outer, 'inner-git-elsewhere'))
  await runObjectPass(h, r)
  assert.equal(availabilityOf(h, v), 'available', 'the enclosing repository never answers "missing" for it')
})

test('S3: a batch-check answer is trusted only for the OID it names, at its own position', async () => {
  const h = harness()
  const { versionIds } = objectRepo(h, 'proj', 2, 7)
  const blobs = versionIds.map(id => (h.db.raw.prepare('SELECT blob_oid AS b FROM artifact_versions WHERE version_id = ?').get(id) as { b: string }).b)
  // Git answers in the wrong order: each line names the other OID.
  const runGit = async (repoPath: string, args: string[], limits: GitLimits, options?: GitRunOptions): Promise<GitResult> => {
    if (args[0] !== 'cat-file') return runArtifactGit(repoPath, args, limits, options)
    const asked = (options?.input ?? Buffer.alloc(0)).toString('latin1').split('\n').filter(Boolean)
    const stdout = Buffer.from(`${asked[1]} missing\n${asked[0]} blob 2\n`)
    return { stdout, exitCode: 0, timedOut: false, truncated: false, error: null, incomplete: false, signal: null, stderr: '', filterState: 'none' }
  }
  const r = runner(h, { gitObjectRecheckMs: 0, runGit })
  await runObjectPass(h, r)
  assert.equal(blobs.length, 2)
  assert.deepEqual(versionIds.map(v => availabilityOf(h, v)), ['available', 'available'], 'a misaligned answer proves nothing')
})

test('I4: a pass stops at its slice cap and the next pass resumes where it stopped, so no repository is starved', async () => {
  const h = harness()
  const repos = Array.from({ length: 5 }, (_, i) => objectRepo(h, `capped${i}`, 2, 0x20 + i))
  // Every version stays due (no re-check interval); the pass takes at most two slices.
  const r = runner(h, { gitObjectRecheckMs: 0, gitObjectMaxSlices: 2 })
  const byRepo = () => repos.map(x => x.versionIds.map(v => availabilityOf(h, v)).every(a => a === 'unavailable'))
  const slices = () => Number(readArtifactManagerState(h.db, 'health.git-objects-slices') ?? 0)
  await runObjectPass(h, r)
  assert.equal(slices(), 2, 'the pass ended at its cap')
  const firstPass = byRepo().filter(Boolean).length
  assert.equal(firstPass, 2, 'two repositories checked')
  await runObjectPass(h, r)
  assert.equal(byRepo().filter(Boolean).length, 4, 'the next pass resumed after them')
  await runObjectPass(h, r)
  assert.deepEqual(byRepo(), [true, true, true, true, true], 'every repository is reached')
})

// ------------------------------------------------------------------------------------------------ fix round 1: minors

test('fix round 1: no Git process started by a Git object check outlives stop()', async () => {
  const h = harness()
  const { root } = objectRepo(h, 'stall', 2, 0x31)
  // Any Git run in this repository blocks reading its configuration (an include that is a FIFO nobody writes).
  const fifo = join(h.home, 'stall.fifo')
  execFileSync('mkfifo', [fifo])
  appendFileSync(join(root.canonicalPath, '.git', 'config'), `[include]\n\tpath = ${fifo}\n`)
  h.config.artifacts.gitTimeoutMs = 20_000
  // The slice's adapter call is under way when stop() comes, and starts its Git process only after it.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let called = 0
  const runGit = async (repoPath: string, args: string[], limits: GitLimits, options?: GitRunOptions): Promise<GitResult> => {
    called++
    await gate
    return runArtifactGit(repoPath, args, limits, options)
  }
  const seen: Array<import('node:child_process').ChildProcess> = []
  const watch = (message: unknown) => {
    const child = (message as { process?: import('node:child_process').ChildProcess }).process
    if (child) queueMicrotask(() => { if (child.spawnfile === 'git' && child.spawnargs[1] === '--no-pager') seen.push(child) })
  }
  const dc = await import('node:diagnostics_channel')
  dc.subscribe('child_process', watch)
  try {
    const r = runner(h, { gitObjectRecheckMs: 0, runGit })
    enqueue(h, 'git-objects', 'verify', ARTIFACT_JOB_PRIORITY.verify)
    await r.run()
    while (called === 0) await new Promise(resolve => setTimeout(resolve, 2))
    r.stop?.()
    release()
    const t0 = Date.now()
    await r.settle()
    const waited = Date.now() - t0
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(seen.length >= 1, 'the adapter call under way started a Git process after stop()')
    assert.ok(seen.every(c => c.exitCode !== null || c.signalCode !== null), 'every Git process has exited')
    assert.ok(waited < 10_000, `killed on sight, not left to run to its timeout (${waited} ms)`)
    assert.equal(job(h, 'git-objects', 'verify')!.state, 'running', 'and the stopped slice commits nothing')
  } finally {
    dc.unsubscribe('child_process', watch)
  }
})

test('fix round 1: a deactivated root drops its recovery keys; startup reads one bounded key range and drops keys of roots that are not active', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const out = join(h.home, 'out')
  mkdirSync(out)
  const start = (declared: boolean, db: AtlasDb = h.db) => {
    h.config.artifacts.outputRoots = declared ? [{ path: out, repositoryId: null, label: null, protected: false }] : []
    return runner(h, { db, autoSchedule: true, git: noGit, backgroundPauseMs: 0 })
  }
  let r = start(true)
  await ticks(r, h, 6, 1_001)
  r.stop?.()
  const rootId = listArtifactRoots(h.db).find(x => x.canonicalPath === out)!.rootId
  const done = (task: string, id: string) => readArtifactManagerState(h.db, `recovery-done:${task}:${id}`)
  assert.notEqual(done('output-walk', rootId), null, 'control: the completed pass is persisted')
  // Fix round 2 (R73): the root's renumber evidence goes too.
  h.db.raw.prepare('INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)').run(`renumber:${rootId}`, JSON.stringify([{ from: '1', to: '2', at: iso(h.t) }]), iso(h.t))
  // Removed from config: deactivated, and its recovery schedule goes with it.
  h.t += 1_000
  r = start(false)
  await ticks(r, h, 4, 1_001)
  r.stop?.()
  assert.equal(rootRow(h, rootId).active, false)
  assert.equal(done('output-walk', rootId), null, 'deactivation removes the root\'s recovery keys')
  assert.equal(readArtifactManagerState(h.db, `renumber:${rootId}`), null, 'and its renumber evidence')
  // Keys left behind by roots that are inactive or no longer exist (an older build, a crash) are dropped at the next start.
  const other = outputRoot(h, 'other')
  h.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(other.rootId)
  const put = h.db.raw.prepare('INSERT OR REPLACE INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)')
  for (const key of [`recovery-done:output-walk:${other.rootId}`, `recovery-done:checkout-status:${other.rootId}`, 'recovery-done:output-walk:no-such-root', 'recovery-done:verify:git-objects']) put.run(key, iso(h.t), iso(h.t))
  const seen: string[] = []
  const raw = new Proxy(h.db.raw, {
    get(target, k) {
      if (k === 'prepare') return (sql: string) => { seen.push(sql); return target.prepare(sql) }
      const value = Reflect.get(target, k) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  r = start(false, { ...h.db, raw })
  await r.run()
  r.stop?.()
  const left = (h.db.raw.prepare(`SELECT key FROM artifact_manager_state WHERE key >= 'recovery-done:' AND key < 'recovery-done;' ORDER BY key`).all() as Array<{ key: string }>).map(x => x.key)
  assert.ok(!left.some(k => k.includes(other.rootId) || k.includes('no-such-root')), `keys of inactive and unknown roots are dropped: ${left.join(', ')}`)
  assert.ok(left.includes('recovery-done:verify:git-objects'), 'a service-wide scope is kept')
  // Every multi-row read of the state table at start (point lookups by key aside).
  const lookup = seen.filter(q => /^\s*SELECT[\s\S]*FROM artifact_manager_state/i.test(q) && !/WHERE key = \?\s*$/i.test(q.trim()))
  assert.ok(lookup.length >= 1, 'the startup lookup ran')
  for (const q of lookup) {
    assert.ok(!/LIKE/i.test(q), `a key range, not a LIKE scan: ${q}`)
    assert.ok(/LIMIT/i.test(q), `bounded: ${q}`)
    const detail = (h.db.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...Array.from(q.matchAll(/\?/g), () => 1)) as Array<{ detail: string }>).map(d => d.detail)
    assert.ok(detail.some(d => /USING (PRIMARY KEY|INDEX)/.test(d)), `indexed: ${detail.join(' | ')}`)
  }
})

test('S2: a persisted completion time ahead of the clock counts as now, so a clock step back cannot stall recovery', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const o = outputRoot(h, 'out')
  const walks = () => h.fake.requests.filter(q => q.task === 'output-walk' && q.root.rootId === o.rootId).length
  // The last pass was recorded ten days ahead of this clock (the clock was stepped back since).
  h.db.raw.prepare('INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)').run(`recovery-done:output-walk:${o.rootId}`, iso(h.t + 10 * 86_400_000), iso(h.t))
  const r = runner(h, { autoSchedule: true, git: noGit })
  await ticks(r, h, 4, 1_001)
  assert.equal(walks(), 0, 'it counts as completed just now')
  h.t += 600_000 + 5_000
  await ticks(r, h, 6, 1_001)
  assert.equal(walks(), 1, 'one interval from now, recovery runs: not ten days later')
})

// ------------------------------------------------------------------------------------------------ fix round 2: R73.2
// An AUTO-REGISTERED root (checkout, session directory, their output children, direct-only) whose own folder is proven deleted
// (ENOENT/ENOTDIR and the nearest existing folder on the root's recorded device) is retired; a user-declared root stays.

const SID_A = '5b1c2d3e-4f50-4a61-8b72-9c83d4e5f601'
const rootAt = (h: H, path: string) => listArtifactRoots(h.db).find(x => x.canonicalPath === path)
function catalogue(h: H, root: ArtifactRootRow, path: string): void {
  recordArtifactObservation(h.db, working(root, path), iso(h.t))
}
const existsOf = (h: H, path: string) => ({ ...(h.db.raw.prepare('SELECT exists_state AS e, verification_state AS v FROM artifacts WHERE path = ?').get(path) as { e: string; v: string | null }) })
const pendingJobs = (h: H, scopeId: string) => n(h, `SELECT COUNT(*) AS n FROM artifact_jobs WHERE scope_id = ? AND state IN ('queued', 'retry', 'running')`, scopeId)

test('R73.2: a deleted auto-registered root is retired by the root-level proof: its files become missing, the service goes idle, and it comes back clean', async () => {
  const h = harness()
  h.config.artifacts.recoveryIntervalMs = 600_000
  const proj = join(h.home, 'proj')
  const docs = join(proj, 'docs')
  mkdirSync(docs, { recursive: true })
  put(join(proj, 'keep.txt'))
  ensureSession(h.db, { sessionId: SID_A, cwd: proj, startedAt: iso(h.t), now: iso(h.t) })
  const r = runner(h, { autoSchedule: true, git: noGit })
  await ticks(r, h, 6, 1_001)
  const docsRoot = rootAt(h, docs)!
  assert.equal(docsRoot.active, true)
  assert.deepEqual(docsRoot.scopeFlags, ['session-cwd'], 'an auto-registered output child')
  assert.equal(readArtifactManagerState(h.db, `root-device:${docsRoot.rootId}`), String(lstatSync(docs, { bigint: true }).dev), 'its device is recorded while present')
  const file = put(join(docs, 'report.md'))
  catalogue(h, docsRoot, file)
  // rm -rf of the output folder.
  rmSync(docs, { recursive: true })
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, docs)!.active, false, 'retired')
  assert.equal(rootAt(h, proj)!.active, true, 'the session folder is still there')
  assert.equal(readArtifactManagerState(h.db, `root-device:${docsRoot.rootId}`), null, 'its state goes with it')
  verifyExistence(h.db, { now: iso(h.t) })
  assert.equal(existsOf(h, file).e, 'missing', 'the retired-root path proves its files missing')
  const walksBefore = h.fake.requests.length
  await ticks(r, h, 6, 61_000)
  assert.equal(pendingJobs(h, docsRoot.rootId), 0, 'nothing queued for it')
  assert.equal(h.fake.requests.filter(q => q.root.rootId === docsRoot.rootId).length, h.fake.requests.slice(0, walksBefore).filter(q => q.root.rootId === docsRoot.rootId).length, 'never scanned again')
  // The whole project goes: the session-directory root is retired as well.
  rmSync(proj, { recursive: true })
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, proj)!.active, false)
  // It comes back: the next full reconciliation registers it again with a clean slate and records its device anew.
  mkdirSync(docs, { recursive: true })
  h.t += 600_000
  await ticks(r, h, 8, 1_001)
  assert.equal(rootAt(h, docs)!.active, true, 'reactivated')
  assert.equal(readArtifactManagerState(h.db, `root-device:${docsRoot.rootId}`), String(lstatSync(docs, { bigint: true }).dev))
})

test('R73.2: a deleted user-declared (CLI) root stays active and disconnected: its files stay unverified', async () => {
  const h = harness()
  const o = outputRoot(h, 'out')
  const file = put(join(o.canonicalPath, 'a.md'))
  catalogue(h, o, file)
  const r = runner(h, { autoSchedule: true, git: noGit })
  await ticks(r, h, 4, 1_001)
  rmSync(o.canonicalPath, { recursive: true })
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, o.canonicalPath)!.active, true)
  verifyExistence(h.db, { now: iso(h.t) })
  assert.deepEqual(existsOf(h, file), { e: 'present', v: 'unverified' })
  assert.equal(readArtifactManagerState(h.db, 'verify.last-unverified'), 'root-unreachable')
})

test('R73.2: an auto root on an unmounted volume, or with no recorded device, is never retired', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  const mnt = join(proj, 'docs')
  const other = join(h.home, 'other')
  const otherDocs = join(other, 'reports')
  mkdirSync(mnt, { recursive: true })
  mkdirSync(otherDocs, { recursive: true })
  put(join(mnt, 'x.md'))
  ensureSession(h.db, { sessionId: SID_A, cwd: proj, startedAt: iso(h.t), now: iso(h.t) })
  ensureSession(h.db, { sessionId: '5b1c2d3e-4f50-4a61-8b72-9c83d4e5f602', cwd: other, startedAt: iso(h.t), now: iso(h.t) })
  // proj/docs was a mount point: once the volume is gone, the folder above it is on another filesystem than the root was.
  let unmounted = false
  const lstat = (path: string) => {
    const s = lstatSync(path, { bigint: true })
    if (!unmounted || path !== proj) return s
    const copy = Object.assign(Object.create(Object.getPrototypeOf(s) as object) as typeof s, s)
    copy.dev = s.dev + 1n
    return copy
  }
  const r = runner(h, { autoSchedule: true, git: noGit, rootFs: { lstat } })
  await ticks(r, h, 6, 1_001)
  const mntRoot = rootAt(h, mnt)!
  const otherRoot = rootAt(h, otherDocs)!
  assert.notEqual(readArtifactManagerState(h.db, `root-device:${mntRoot.rootId}`), null)
  // The mount point's own folder is removed with the unmount (udisks does this).
  unmounted = true
  rmSync(mnt, { recursive: true })
  // No device was ever recorded for this one (an older build registered it).
  h.db.raw.prepare('DELETE FROM artifact_manager_state WHERE key = ?').run(`root-device:${otherRoot.rootId}`)
  rmSync(otherDocs, { recursive: true })
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, mnt)!.active, true, 'device differs: not proof')
  assert.equal(rootAt(h, otherDocs)!.active, true, 'no recorded device: not proof')
})

// ------------------------------------------------------------------------------------------------ fix round 2: OOS1
// `git cat-file --batch-check` prints "missing" with exit 0 for objects it cannot READ: an unreadable pack index (no stderr at
// all), an unreadable loose-object folder (an error line). The tests run as root here, and root ignores permissions, so the
// check runs in a child started through setpriv with CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH removed from its bounding set
// (a non-root run needs no setpriv). Without either the test is skipped with this reason.

const IS_ROOT = process.getuid?.() === 0
const HAS_SETPRIV = (() => { try { execFileSync('setpriv', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
const NO_DAC_SKIP: string | false = !IS_ROOT || (process.platform === 'linux' && HAS_SETPRIV) ? false
  : 'running as root without Linux setpriv: a real permission failure cannot be produced (root bypasses file permissions)'
const RUNNER_MODULE = join(import.meta.dirname, '..', '..', 'src', 'service', 'artifact-manager-runner.ts')
/** Runs the object check's batch (the service's own code) once, without permission override, and prints its checks. */
const CHECK_BATCH_ONCE = `import { checkArtifactGitObjectBatch } from ${JSON.stringify(RUNNER_MODULE)}
const [repoPath, commonDir, rows] = process.argv.slice(1)
const checks = await checkArtifactGitObjectBatch(repoPath, commonDir, JSON.parse(rows), { timeoutMs: 20000, maxOutputBytes: 1048576 })
process.stdout.write(JSON.stringify(checks))`
function checkBatchUnprivileged(repo: string, rows: unknown[]): Array<{ versionId: string; object: string }> {
  const args = ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', CHECK_BATCH_ONCE, repo, join(repo, '.git'), JSON.stringify(rows)]
  const out = IS_ROOT
    ? execFileSync('setpriv', ['--bounding-set=-dac_override,-dac_read_search', process.execPath, ...args], { env: process.env })
    : execFileSync(process.execPath, args, { env: process.env })
  return JSON.parse(out.toString('utf8')) as Array<{ versionId: string; object: string }>
}
function objectRows(repo: string, names: string[]): Array<Record<string, unknown>> {
  return names.map(name => ({
    versionId: `v-${name}`, kind: 'commit', repositoryId: 'r', commonDir: join(repo, '.git'), checkoutIdentity: null, objectFormat: 'sha1',
    blobOid: git(repo, ['rev-parse', `HEAD:${name}.md`]).trim(), sizeBytes: Buffer.byteLength(`${name} bytes\n`),
  }))
}
function permRepo(h: H, name: string, docs: string[]): string {
  const repo = join(h.home, name)
  git(h.home, ['init', '-q', repo])
  for (const d of docs) put(join(repo, `${d}.md`), `${d} bytes\n`)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'docs'])
  return repo
}
const looseObject = (repo: string, oid: string) => join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2))

test('OOS1: "missing" counts only when Git wrote no error and the object store was readable (real permission failures)', { skip: NO_DAC_SKIP }, () => {
  const h = harness()
  // Control: a garbage-collected object is still "missing", and so recorded.
  const loose = permRepo(h, 'loose', ['a', 'b', 'c'])
  const rows = objectRows(loose, ['a', 'b', 'c'])
  unlinkSync(looseObject(loose, rows[2]!.blobOid as string))
  assert.deepEqual(checkBatchUnprivileged(loose, rows).map(c => [c.versionId, c.object]), [['v-a', 'present'], ['v-b', 'present'], ['v-c', 'missing']], 'control')
  // An unreadable loose-object folder: Git says "missing" for a.md's blob (and an error line on stderr).
  const folder = dirname(looseObject(loose, rows[0]!.blobOid as string))
  chmodSync(folder, 0o000)
  let unreadableFolder
  try {
    unreadableFolder = checkBatchUnprivileged(loose, rows)
  } finally {
    chmodSync(folder, 0o755)
  }
  assert.deepEqual(unreadableFolder.filter(c => c.object === 'missing'), [], 'no "missing" from a batch Git could not read cleanly')
  // An unreadable pack index: Git says "missing" for every packed object, with nothing on stderr.
  const packed = permRepo(h, 'packed', ['a', 'b'])
  git(packed, ['repack', '-a', '-d', '-q'])
  git(packed, ['prune-packed'])
  const packDir = join(packed, '.git', 'objects', 'pack')
  const indexes = readdirSync(packDir).filter(f => f.endsWith('.idx'))
  assert.ok(indexes.length > 0)
  // The object IDs are read while the pack is still readable: `git rev-parse` cannot resolve them afterwards (as a regular user).
  const packedRows = objectRows(packed, ['a', 'b'])
  for (const f of indexes) chmodSync(join(packDir, f), 0o000)
  let unreadableIndex
  try {
    unreadableIndex = checkBatchUnprivileged(packed, packedRows)
  } finally {
    for (const f of indexes) chmodSync(join(packDir, f), 0o644)
  }
  assert.deepEqual(unreadableIndex, [], 'an unreadable pack index proves nothing')
  assert.deepEqual(checkBatchUnprivileged(packed, packedRows).map(c => c.object), ['present', 'present'], 'control: readable again')
})

// ------------------------------------------------------------------------------------------------ fix round 2: test gaps
// These pin fix-round-1 behaviour that review mutants survived (M3 pin dropped, M6 common-dir check removed, M19 folderGone).

test('fix round 2 (E6, M3): a de-initialized submodule keeps its own objects: the pinned check reads them, never the superproject', async () => {
  const h = harness()
  const sup = join(h.home, 'super')
  git(h.home, ['init', '-q', sup])
  git(sup, ['commit', '-q', '--allow-empty', '-m', 'super'])
  const sub = join(sup, 'sub')
  const modules = join(sup, '.git', 'modules', 'sub')
  mkdirSync(join(sup, '.git', 'modules'))
  git(h.home, ['init', '-q', `--separate-git-dir=${modules}`, sub])
  put(join(sub, 'doc.md'), 'submodule bytes\n')
  git(sub, ['add', 'doc.md'])
  git(sub, ['commit', '-q', '-m', 'sub'])
  const blob = git(sub, ['rev-parse', 'HEAD:doc.md']).trim()
  const repositoryId = registerArtifactRepository(h.db, { commonDir: modules, displayName: 'sub', remoteIdentity: null }, iso(h.t))
  const root = registerArtifactRoot(h.db, { kind: 'checkout', canonicalPath: sub, repositoryId, projectName: 'sub', checkoutIdentity: 'ck-sub', protected: false, scopeFlags: ['checkout'] }, iso(h.t))
  const v = recordArtifactObservation(h.db, {
    rootId: root.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: 'doc.md' }, kind: 'commit', observedAt: iso(h.t),
    git: { repositoryId, commitOid: git(sub, ['rev-parse', 'HEAD']).trim(), gitPath: 'doc.md', blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 16 },
  }, iso(h.t)).versionId!
  // De-initialized: the gitfile is gone; the module's repository stays under the superproject's .git/modules.
  unlinkSync(join(sub, '.git'))
  const r = runner(h, { gitObjectRecheckMs: 0 })
  await runObjectPass(h, r)
  assert.equal(availabilityOf(h, v), 'available', 'answered by its own repository, never "missing" from the superproject')
})

test('fix round 2 (M6): a recorded common dir that is gone runs no Git and writes nothing', async () => {
  const h = harness()
  const { root, versionIds } = objectRepo(h, 'moved', 2, 0x41)
  const rows = () => versionIds.map(v => ({ ...(h.db.raw.prepare('SELECT availability, checked_at FROM artifact_version_state WHERE version_id = ?').get(v) as object) }))
  const before = rows()
  renameSync(join(root.canonicalPath, '.git'), join(h.home, 'moved-git-elsewhere'))
  const r = runner(h, { gitObjectRecheckMs: 0 })
  const spawns = artifactGitSpawnCount()
  await runObjectPass(h, r)
  assert.equal(artifactGitSpawnCount() - spawns, 0, 'no Git process')
  assert.deepEqual(rows(), before, 'nothing written')
})

test('fix round 2 (M19): a root nested in a worktree Git no longer lists keeps its registration while its folder exists', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  git(h.home, ['init', '-q', proj])
  put(join(proj, 'README.md'))
  git(proj, ['add', 'README.md'])
  git(proj, ['commit', '-q', '-m', 'init'])
  const wt = join(h.home, 'proj-wt')
  git(proj, ['worktree', 'add', '-q', wt, '-b', 'feat'])
  put(join(wt, 'docs', 'a.md'))
  const now = iso(Date.now())
  ensureSession(h.db, { sessionId: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', cwd: proj, startedAt: now, now })
  const start = async () => {
    const r = runner(h, { autoSchedule: true, clock: () => Date.now() })
    await r.run()
    await r.settle()
    await r.run()
    r.stop?.()
  }
  await start()
  const roots = () => new Map(listArtifactRoots(h.db).map(x => [x.canonicalPath, x]))
  assert.equal(roots().get(join(wt, 'docs'))?.active, true)
  // The worktree's link is lost and pruned: Git no longer lists it, but its folder (and docs/ in it) is still there.
  unlinkSync(join(wt, '.git'))
  git(proj, ['worktree', 'prune'])
  await start()
  assert.equal(roots().get(wt)?.active, false, 'Git no longer lists the worktree')
  assert.equal(roots().get(join(wt, 'docs'))?.active, true, 'a nested root whose folder exists keeps its own registration')
})

test('R73.2: an empty folder left behind by an unmounted volume never re-records the root device, so its later removal retires nothing', async () => {
  const h = harness()
  const proj = join(h.home, 'proj')
  const docs = join(proj, 'docs')
  put(join(docs, 'x.md'))
  ensureSession(h.db, { sessionId: SID_A, cwd: proj, startedAt: iso(h.t), now: iso(h.t) })
  // While mounted, proj/docs is the root of another filesystem (its device differs from its parent's).
  let mounted = true
  const lstat = (path: string) => {
    const s = lstatSync(path, { bigint: true })
    if (!mounted || path !== docs) return s
    const copy = Object.assign(Object.create(Object.getPrototypeOf(s) as object) as typeof s, s)
    copy.dev = s.dev + 1n
    return copy
  }
  const r = runner(h, { autoSchedule: true, git: noGit, rootFs: { lstat } })
  await ticks(r, h, 6, 1_001)
  const docsRoot = rootAt(h, docs)!
  const volume = String(lstatSync(docs, { bigint: true }).dev + 1n)
  assert.equal(readArtifactManagerState(h.db, `root-device:${docsRoot.rootId}`), volume)
  // Unmounted: the mount point stays as an empty folder on the parent filesystem.
  mounted = false
  rmSync(join(docs, 'x.md'))
  await ticks(r, h, 3, 31_000)
  assert.equal(readArtifactManagerState(h.db, `root-device:${docsRoot.rootId}`), volume, 'an empty folder never re-records the device')
  rmSync(docs, { recursive: true })
  await ticks(r, h, 3, 31_000)
  assert.equal(rootAt(h, docs)!.active, true, 'its removal is no proof: the folder above is not on the volume\'s device')
})

// ------------------------------------------------------------------------------------------------ fix round 3 (R74)

/** The real lstat, reporting `dev` for `top` and everything under it (a filesystem mounted at `top`). */
function mountedAt(top: string, dev: bigint, on: () => boolean = () => true) {
  return (path: string) => {
    const s = lstatSync(path, { bigint: true })
    if (!on() || (path !== top && !path.startsWith(`${top}/`))) return s
    const copy = Object.assign(Object.create(Object.getPrototypeOf(s) as object) as typeof s, s)
    copy.dev = dev
    return copy
  }
}

test('R74.1: an anchor that is itself a mount point is no proof: another filesystem reusing the device number retires no root', async () => {
  const h = harness()
  const vol = join(h.home, 'vol')
  const proj = join(vol, 'proj')
  const docs = join(proj, 'docs')
  const report = put(join(docs, 'report.md'))
  put(join(proj, 'notes.md'))
  ensureSession(h.db, { sessionId: SID_A, cwd: proj, startedAt: iso(h.t), now: iso(h.t) })
  // Filesystem A (device 41) is mounted at vol; its parent (home) is another filesystem.
  const r = runner(h, { autoSchedule: true, git: noGit, rootFs: { lstat: mountedAt(vol, 41n) } })
  await ticks(r, h, 6, 1_001)
  assert.equal(readArtifactManagerState(h.db, `root-device:${rootAt(h, proj)!.rootId}`), '41')
  assert.equal(readArtifactManagerState(h.db, `root-device:${rootAt(h, docs)!.rootId}`), '41')
  catalogue(h, rootAt(h, docs)!, report)
  // A is unmounted and a DIFFERENT filesystem B is mounted at vol under the same device number: proj is not on it.
  rmSync(proj, { recursive: true })
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, proj)!.active, true, 'the session folder root stays (disconnected)')
  assert.equal(rootAt(h, docs)!.active, true, 'and its docs/ root')
  verifyExistence(h.db, { now: iso(h.t) })
  assert.deepEqual(existsOf(h, report), { e: 'present', v: 'unverified' }, 'its files are unverified, never missing')
})

test('R74.2: a deleted direct-only root stays active (disconnected), so new files in the re-created folder are accepted', async () => {
  const h = harness()
  ensureSession(h.db, { sessionId: SID_A, cwd: join(h.home, 'not-here'), startedAt: iso(h.t), now: iso(h.t) })
  const notes = join(h.home, 'notes')
  const direct = (path: string, n: number) => recordDirectArtifactObservation(h.db, {
    sessionId: SID_A, path, operation: 'created', certainty: 'recorded', source: 'hook', sourceKey: `hook:${SID_A}:${n}`, eventAt: iso(h.t),
  }, { home: h.home, now: iso(h.t) })
  assert.equal(direct(put(join(notes, 'a.md')), 1).status, 'recorded')
  assert.deepEqual(rootAt(h, notes)!.scopeFlags, ['direct-only'])
  const r = runner(h, { autoSchedule: true, git: noGit })
  await ticks(r, h, 4, 31_000)
  rmSync(notes, { recursive: true })
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, notes)!.active, true, 'never retired: ingest could not bring it back')
  // Re-created, then a day later: new files there are accepted.
  assert.equal(direct(put(join(notes, 'b.md')), 2).status, 'recorded')
  h.t += DAY
  await ticks(r, h, 2, 31_000)
  assert.equal(direct(put(join(notes, 'c.md')), 3).status, 'recorded')
})

test('R74.6 (X7, X8, X9, X12): the root-level proof counts only ENOENT/ENOTDIR under a real folder on the recorded device, and only for roots Atlas registered itself', async () => {
  const h = harness()
  const x7 = outputRoot(h, 'p1/docs', { scopeFlags: ['session-cwd'] })
  const x12 = outputRoot(h, 'p2/docs', { scopeFlags: ['session-cwd'] })
  const x8 = outputRoot(h, 'p3/docs', { scopeFlags: ['session-cwd'] })
  const x9 = outputRoot(h, 'both', { scopeFlags: ['cli-output', 'session-cwd'] })
  const control = outputRoot(h, 'p4/docs', { scopeFlags: ['session-cwd'] })
  let denied = false
  const lstat = (path: string) => {
    if (denied && path === x7.canonicalPath) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return lstatSync(path, { bigint: true })
  }
  const r = runner(h, { autoSchedule: true, git: noGit, rootFs: { lstat } })
  await ticks(r, h, 4, 31_000)
  for (const x of [x7, x12, x8, x9, control]) rmSync(x.canonicalPath, { recursive: true })
  // X7: a permission failure on the root path. X12: a regular file where the root folder was. X8: the folder above it is now a
  // symlink (to a folder without docs/). X9: a root the user declared as well. Control: a plain deletion.
  denied = true
  writeFileSync(x12.canonicalPath, 'a file where the root folder was\n')
  mkdirSync(join(h.home, 'p3-elsewhere'))
  rmSync(join(h.home, 'p3'), { recursive: true })
  symlinkSync(join(h.home, 'p3-elsewhere'), join(h.home, 'p3'))
  await ticks(r, h, 4, 31_000)
  assert.equal(rootAt(h, control.canonicalPath)!.active, false, 'control: a plain deletion is retired')
  assert.equal(rootAt(h, x7.canonicalPath)!.active, true, 'X7: EACCES is no proof')
  assert.equal(rootAt(h, x12.canonicalPath)!.active, true, 'X12: a regular file at the root path is no proof')
  assert.equal(rootAt(h, x8.canonicalPath)!.active, true, 'X8: a symlinked anchor is no proof')
  assert.equal(rootAt(h, x9.canonicalPath)!.active, true, 'X9: a root the user also declared is never retired')
})

test('R74.7: a reconciliation that finishes while discovery is paused checks no root folder until discovery resumes', async () => {
  const h = harness()
  const p = join(h.home, 'p')
  const o = outputRoot(h, 'p/docs', { scopeFlags: ['session-cwd'] })
  ensureSession(h.db, { sessionId: SID_A, cwd: p, startedAt: iso(h.t), now: iso(h.t) })
  const first = runner(h, { autoSchedule: true, git: noGit })
  await ticks(first, h, 4, 31_000)
  first.stop?.()
  assert.notEqual(readArtifactManagerState(h.db, `root-device:${o.rootId}`), null)
  // A new service starts a reconciliation; discovery is paused and the folder deleted before it finishes.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const r = runner(h, { autoSchedule: true, git: { resolveCheckout: async () => { await gate; return null }, listWorktrees: async () => [] } })
  await r.run()
  setArtifactDiscoveryPaused(h.db, true, iso(h.t))
  rmSync(o.canonicalPath, { recursive: true })
  release()
  await r.settle()
  await r.run()
  assert.equal(rootAt(h, o.canonicalPath)!.active, true, 'nothing is retired while paused')
  setArtifactDiscoveryPaused(h.db, false, iso(h.t))
  await ticks(r, h, 3, 31_000)
  assert.equal(rootAt(h, o.canonicalPath)!.active, false, 'checked once discovery resumes')
})

test('R74.7: only Git object check slices that check something are counted', async () => {
  const h = harness()
  objectRepo(h, 'fresh', 3, 0x51)
  // Every version was proven just now: the pass finds nothing due.
  const r = runner(h)
  await runObjectPass(h, r)
  assert.equal(Number(readArtifactManagerState(h.db, 'health.git-objects-slices') ?? 0), 0, 'an empty window is not a slice')
})

test('R74.4 (and X10): an unreadable pack, here or in an alternate, proves nothing either (real permission failures)', { skip: NO_DAC_SKIP }, () => {
  const h = harness()
  const pack = (repo: string) => join(repo, '.git', 'objects', 'pack')
  const files = (repo: string, ext: string) => readdirSync(pack(repo)).filter(f => f.endsWith(ext)).map(f => join(pack(repo), f))
  const unreadable = <T>(paths: string[], f: () => T): T => {
    for (const p of paths) chmodSync(p, 0o000)
    try { return f() } finally { for (const p of paths) chmodSync(p, 0o644) }
  }
  // An unreadable .pack with a readable .idx: Git says "missing" (exit 0, nothing on stderr).
  const packed = permRepo(h, 'pack-unreadable', ['a', 'b'])
  git(packed, ['repack', '-a', '-d', '-q'])
  git(packed, ['prune-packed'])
  const packedRows = objectRows(packed, ['a', 'b']) // before the pack is made unreadable: rev-parse cannot read it afterwards
  assert.deepEqual(unreadable(files(packed, '.pack'), () => checkBatchUnprivileged(packed, packedRows)), [], 'an unreadable pack proves nothing')
  // An alternate: the objects live only in the repository this clone borrows from.
  const lender = permRepo(h, 'lender', ['a', 'b'])
  git(lender, ['repack', '-a', '-d', '-q'])
  git(lender, ['prune-packed'])
  const borrower = join(h.home, 'borrower')
  git(h.home, ['clone', '-q', '--shared', lender, borrower])
  assert.ok(readFileSync(join(borrower, '.git', 'objects', 'info', 'alternates'), 'utf8').includes(lender))
  const rows = objectRows(borrower, ['a', 'b'])
  assert.deepEqual(checkBatchUnprivileged(borrower, rows).map(c => c.object), ['present', 'present'], 'control: read through the alternate')
  assert.deepEqual(unreadable(files(lender, '.idx'), () => checkBatchUnprivileged(borrower, rows)), [], 'X10: the alternate\'s pack index is checked')
  assert.deepEqual(unreadable(files(lender, '.pack'), () => checkBatchUnprivileged(borrower, rows)), [], 'R74.4: and the alternate\'s pack')
})

test('settle: a direct check of a file that was just truncated records nothing and schedules that file\'s direct check (real file, 30 s quiet period)', async () => {
  const h = harness()
  h.config.artifacts.debounceMs = 30_000
  const r0 = outputRoot(h, 'out')
  const f = put(join(r0.canonicalPath, 'live.md'), 'old\n')
  truncateSync(f, 0)
  h.t = Date.now()
  enqueue(h, artifactDirectScopeId(r0.rootId, f), 'direct-observation')
  h.fake.script = req => [data(req, [{ ...working(r0, f), observedAt: iso(h.t), capturedAt: iso(h.t) }], null), terminal(req)]
  await spin(runner(h), 6)
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifacts WHERE path = ?', f), 0)
  assert.equal(n(h, "SELECT COUNT(*) AS n FROM artifact_versions WHERE kind = 'working'"), 0)
  const j = job(h, artifactDirectScopeId(r0.rootId, f), 'direct-observation')!
  assert.equal(j.state, 'retry')
  assert.equal(j.last_error, ARTIFACT_SETTLING)
  assert.ok(Date.parse(String(j.retry_at)) > h.t)
  assert.ok(Date.parse(String(j.retry_at)) <= h.t + 30_000 + 1_000)
})

/** Waits on the real file clock until `path` has been quiet for longer than `quietMs`; fails after 5 s. */
async function waitUntilQuiet(path: string, quietMs: number): Promise<void> {
  const giveUp = Date.now() + 5_000
  while (Date.now() - statSync(path).ctimeMs <= quietMs) {
    if (Date.now() > giveUp) assert.fail('the file never became quiet on the real clock')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('settle: the check a deferral left records the file once the file is quiet and the check is due (real file)', async () => {
  const h = harness()
  h.config.artifacts.debounceMs = 30_000
  const r0 = outputRoot(h, 'out')
  const f = put(join(r0.canonicalPath, 'live.md'), 'old\n')
  truncateSync(f, 0)
  h.t = Date.now()
  const scope = artifactDirectScopeId(r0.rootId, f)
  enqueue(h, scope, 'direct-observation')
  h.fake.script = req => [data(req, [{ ...working(r0, f), observedAt: iso(h.t), capturedAt: iso(h.t) }], null), terminal(req)]
  const r = runner(h)
  await spin(r, 6)
  assert.equal(n(h, "SELECT COUNT(*) AS n FROM artifact_versions WHERE kind = 'working'"), 0)
  const deferred = job(h, scope, 'direct-observation')!
  assert.equal(deferred.state, 'retry')
  assert.equal(deferred.last_error, ARTIFACT_SETTLING)
  // The writer finishes. The quiet period is now short enough to wait out on the real file clock.
  appendFileSync(f, 'the final content\n')
  h.config.artifacts.debounceMs = 200
  await waitUntilQuiet(f, 200)
  h.t = Math.max(Date.parse(String(deferred.retry_at)), Date.now()) + 1_000
  await spin(r, 6)
  const versions = h.db.raw.prepare("SELECT size_bytes FROM artifact_versions WHERE kind = 'working'").all().map(v => ({ ...v }))
  assert.deepEqual(versions, [{ size_bytes: statSync(f).size }])
  assert.equal(job(h, scope, 'direct-observation'), undefined)
})

test('settle: a backfilled legacy location stays provisional while its file is still settling, and is adopted once its check records it (real file)', async () => {
  const h = harness()
  h.config.artifacts.debounceMs = 30_000
  const r0 = outputRoot(h, 'out')
  const a = put(join(r0.canonicalPath, 'a.md'))
  upsertArtifact(h.db, { path: a, sizeBytes: 1, createdAt: iso(T0 - DAY), projectName: null, now: iso(T0 - DAY) })
  enqueue(h, 'legacy-backfill', 'legacy-backfill', ARTIFACT_JOB_PRIORITY.backfill)
  const r = runner(h)
  await spin(r, 2)
  const docOf = () => h.db.raw.prepare('SELECT d.document_id, d.identity_kind FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.path = ?').get(a) as { document_id: string; identity_kind: string }
  const provisional = docOf()
  assert.equal(provisional.identity_kind, 'provisional')
  writeFileSync(a, 'rewritten just now\n')
  h.t = Date.now()
  const scope = artifactDirectScopeId(r0.rootId, a)
  enqueue(h, scope, 'direct-observation', ARTIFACT_JOB_PRIORITY.direct)
  h.fake.script = req => [data(req, [{ ...working(r0, a), observedAt: iso(h.t), capturedAt: iso(h.t) }], null), terminal(req)]
  await spin(r, 6)
  assert.deepEqual(docOf(), provisional, 'still provisional after the deferring run')
  assert.equal(n(h, 'SELECT COUNT(*) AS n FROM artifact_versions WHERE document_id = ?', provisional.document_id), 0, 'no version yet')
  const deferred = job(h, scope, 'direct-observation')!
  assert.equal(deferred.state, 'retry')
  assert.equal(deferred.last_error, ARTIFACT_SETTLING)
  h.config.artifacts.debounceMs = 200
  await waitUntilQuiet(a, 200)
  h.t = Math.max(Date.parse(String(deferred.retry_at)), Date.now()) + 1_000
  await spin(r, 6)
  const adopted = h.db.raw.prepare('SELECT d.document_id, d.identity_kind, d.identity_root_id, d.relative_path FROM artifacts a JOIN artifact_documents d ON d.document_id = a.document_id WHERE a.path = ?').get(a) as Record<string, unknown>
  assert.deepEqual({ ...adopted }, { document_id: provisional.document_id, identity_kind: 'root', identity_root_id: r0.rootId, relative_path: 'a.md' })
  assert.equal(n(h, "SELECT COUNT(*) AS n FROM artifact_versions WHERE document_id = ? AND kind = 'working'", provisional.document_id), 1)
})
