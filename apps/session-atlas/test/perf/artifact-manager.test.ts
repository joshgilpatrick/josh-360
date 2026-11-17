// Artifact Manager performance measurements (spec section 16 "Measured release targets"; plan 2026-10-26 Task 13b, reworked in
// Wave 3 after the defect waves).
//
// Gated by ATLAS_PERF=1 like the other perf tests (`npm run perf`). Every test prints machine-readable lines
// `PERF <name> <metric>=<value> ...`. The measurement itself runs in the test; then EVERY hard target is its own subtest (helper
// `target`), so a miss in one target never hides another and a crash or TypeError in the measurement fails the test instead of
// reading as a known gap. A subtest is marked `todo: 'PERF-GAP-<n>: ...'` (ruling R62) only where a target is missed because of
// a PRODUCTION gap with an owner row in the results document; at the time of writing the only one is PERF-GAP-5 (Linux, R75: the API
// p95 of both burst rounds in PERF-07 and of PERF-08's dirty walk). The T6 API targets use the p95 corrected for the closed-loop
// client's coordinated omission (see ApiLoad); the raw p95 is printed next to it. Every API window also has two hard guards that
// are never under a todo (helper `apiGuards`): a minimum number of answered requests and only the expected failed requests, so a
// dead service or an empty sample fails on every platform instead of reading as the known gap. A todo subtest that meets its
// target prints a `PERF note` saying the marker can go. Each target also prints a `PERF target ... verdict=met|missed|met-todo|missed-todo|
// not-measured` line. Nothing is skipped, loosened or tuned to pass;
// a value this platform cannot measure (the /proc-based worker metrics outside Linux) is an explicit skip
// "not measured on this platform", never a pass. The results, the method of every number and the machine they were taken on are
// in deliverables/2026-10-27/artifact-manager-benchmark-results.md.
//
// Harnesses (all fixtures are disposable: temporary HOMEs, repositories and folders; the real ~/.claude is never read or written):
//   - REAL SERVICE: src/service/main.ts, unmodified, as a child process with HOME = a fixture home, the fake focus provider and
//     test/helpers/artifact-manager-perf-probe.ts preloaded (event-loop delay histogram, CPU and RSS of the service process,
//     read over IPC). Its own discovery worker, priority wrapper, watcher, verify runner and every other runner run as in
//     production, with production defaults (2 s debounce, 30 s status floor, 1 s background pause, 500 ms poll, 10 min
//     recovery, 32-row frames). Load is generated from THIS process over HTTP; worker CPU, RSS and I/O are read from
//     /proc/<pid> (Linux). The worker's environment is minimal by design (PATH, HOME, LANG), so it sees this machine's
//     /etc/gitconfig (git-lfs is configured in the build container: since DEFECT-6 was fixed that no longer keeps checkout
//     passes partial).
//   - IN-PROCESS: the persistence layer and the HTTP routes on a fixture catalog (grouped queries, R47), and the runner with its
//     real worker child driven through the runner's injected clock (idle-root recovery timeline).

import { after, describe, test, type TestContext } from 'node:test'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type AtlasConfig } from '../../src/config.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { setExistsState } from '../../src/db/artifacts.ts'
import {
  getArtifactDocument, listArtifactDocuments, recordArtifactObservation, registerArtifactRepository, registerArtifactRoot, type ArtifactDocumentFilters,
} from '../../src/db/artifact-manager.ts'
import type { ArtifactWorkerObservation } from '../../src/artifacts/contracts.ts'
import { createAtlasServer } from '../../src/server/http.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { createArtifactWorkerClient, type ArtifactWorkerClient } from '../../src/service/artifact-worker.ts'
import { artifactManagerRunner } from '../../src/service/artifact-manager-runner.ts'
import { seedBenchmark } from '../../scripts/seed-benchmark.ts'
import { silentLogger } from '../helpers/log.ts'
import {
  CLI, GUARD, HAS_PROC, MiB, PROBE, REPO_ROOT, Scope, RssSampler, addWorktree, bashTool, countOf, freePort, git, hungServer, makeRepo, mib, machineLoad, openCatalogReadOnly, perfLine, perfRecordMetrics, procIo,
  procSample, processesMatching, put, resetPeakRss, runHook, runProgram, sessionStart, sid, sleep, startServiceProcess, stopEvent, summarize, waitFor, writeTool,
  writeTree, type ProbeStats, type ServiceProcess, type Summary,
} from '../helpers/artifact-manager-perf-harness.ts'

const enabled = process.env.ATLAS_PERF === '1'
/** Options for one measurement: skipped unless ATLAS_PERF=1. Known gaps are marked on the target subtests, never here. */
const gate = () => (enabled ? {} : { skip: 'set ATLAS_PERF=1' })
/** Why a /proc-based metric cannot be measured here (null on Linux). */
const NO_PROC = HAS_PROC ? null : `not measured on this platform (${process.platform}: no /proc; sample the worker with ps, see the Mac runbook)`
/** R75: Node 22 implements recursive fs.watch in JavaScript on Linux (macOS uses FSEvents). */
const JS_RECURSIVE_WATCH = process.platform === 'linux'

// Nothing from this process's Git or Atlas environment reaches an in-process fixture (programs get a minimal env anyway).
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') || key.startsWith('ATLAS_PORT') || key.startsWith('ATLAS_HOME')) delete process.env[key]

const RESULTS: string[] = []
/** Every running API load and sampler: stopped when a measurement ends, so a failed one leaves no timer or request loop alive. */
const LIVE = new Set<() => void>()
const stopLive = () => { for (const stop of LIVE) { try { stop() } catch { /* stopped */ } } LIVE.clear() }
/** Prints and keeps one result line: the caller's metrics, then `at` (time written) and `load` (machine load, unless the caller sets its own). */
const record = (name: string, metrics: Record<string, string | number | boolean | null>) => { RESULTS.push(perfLine(name, perfRecordMetrics(metrics))) }
const flat = (prefix: string, s: Summary) => ({ [`${prefix}_n`]: s.n, [`${prefix}_p50`]: s.p50, [`${prefix}_p95`]: s.p95, [`${prefix}_p99`]: s.p99, [`${prefix}_max`]: s.max })
const iso = (t: number) => new Date(t).toISOString()

// Results are also appended to this file when set (the benchmark document quotes them).
const OUT = process.env.ATLAS_PERF_OUT
process.on('exit', () => { if (OUT && RESULTS.length) appendFileSync(OUT, `${RESULTS.join('\n')}\n`) })

// Hygiene: no service started by this file may outlive it (each measurement stops its own; this proves it where it can).
after(() => {
  if (!HAS_PROC) {
    console.log(`PERF note: the left-over service check needs /proc and was NOT done on ${process.platform}; check with: pgrep -fl artifact-manager-perf-probe`)
    return
  }
  const left = processesMatching('artifact-manager-perf-probe.ts')
  assert.deepEqual(left, [], `services left running: ${left.join(', ')}`)
})

/** Runs one measurement with its own cleanup scope; every load, sampler, service, child and directory is gone when it returns. */
async function withScope<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
  const scope = new Scope()
  try {
    return await fn(scope)
  } finally {
    stopLive()
    await scope.cleanup()
  }
}

type Check = {
  ok: boolean
  /** The measured value the verdict is about (printed in the PERF target line). */
  value: string | number
  message: string
  /** R62: only for a target missed because of a PRODUCTION gap that has an owner row in the results document. */
  todo?: string
  /** Set when this platform cannot measure the value: the subtest is an explicit skip, never a pass. */
  unmeasured?: string | null
}

/** One hard target as its own subtest of the measurement `t`. */
async function target(t: TestContext, id: string, name: string, c: Check): Promise<void> {
  const verdict = c.unmeasured ? 'not-measured' : c.ok ? (c.todo ? 'met-todo' : 'met') : (c.todo ? 'missed-todo' : 'missed')
  record('target', { test: id, target: name, value: c.value, verdict })
  if (c.unmeasured) {
    await t.test(name, { skip: c.unmeasured }, () => {})
    return
  }
  if (c.todo && c.ok) console.log(`PERF note: ${id} "${name}" met its target although it is marked todo (${c.todo.slice(0, 60)}...): the marker can be removed`)
  await t.test(name, c.todo ? { todo: c.todo } : {}, () => { assert.ok(c.ok, c.message) })
}

/** A /proc-based number from meter(): 'n/a' outside Linux. */
const procNumber = (v: number | string | undefined): number => (typeof v === 'number' ? v : Number.NaN)

// ================================================================================================================ in-process helpers

type RouteServer = { base: string; close(): Promise<void> }
async function routeServer(scope: Scope, db: AtlasDb, home: string, config: AtlasConfig): Promise<RouteServer> {
  const atlas = createAtlasServer({ db, config: { ...config, port: 0 }, log: silentLogger })
  registerArtifactRoutes(atlas.router, { db, log: silentLogger, home, config })
  const port = await atlas.listen()
  const close = async () => { atlas.server.closeAllConnections(); await atlas.close().catch(() => {}) }
  scope.onCleanup(close)
  return { base: `http://127.0.0.1:${port}`, close }
}

/** `n` sequential GETs after one warm-up; returns the latency summary (client-observed, ms). Fails on a non-200. */
async function timeGets(url: string, n = 40): Promise<Summary> {
  const once = async () => {
    const t = performance.now()
    const res = await fetch(url)
    await res.arrayBuffer()
    if (res.status !== 200) throw new Error(`${url} -> ${res.status}`)
    return performance.now() - t
  }
  // The warm-up request may meet a keep-alive socket the server closed while the client was idle (an undici reuse race):
  // it alone is retried once. Measured requests run back to back and are never retried.
  await once().catch(() => once())
  const times: number[] = []
  for (let i = 0; i < n; i++) times.push(await once())
  return summarize(times)
}

/** `n` sequential calls after one warm-up (in-process function timing, ms). */
function timeCalls(fn: () => unknown, n = 40): Summary {
  fn()
  const times: number[] = []
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); times.push(performance.now() - t) }
  return summarize(times)
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => ((r() * 16) | 0).toString(16)).join('')

// ================================================================================================================ PERF-09 (R47)

describe('PERF-09 status and list cost by the number of active checkouts of one repository (R47)', () => {
  test('GET /api/artifact-manager/status and GET /api/artifact-documents at K = 21 / 121 / 421 checkouts', gate(), async t => {
    const cells = await withScope(async scope => {
      const out: Array<{ K: number; name: string; s: Summary }> = []
      for (const K of [21, 121, 421]) {
        const home = scope.scratch('atlas-perf-r47-')
        const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
        const db = openDatabase(config.dbPath)
        scope.onCleanup(() => { try { db.close() } catch { /* closed */ } })
        const now = new Date().toISOString()
        // Fixture through the real persistence functions: one repository, K checkout roots (the main checkout plus K-1 linked
        // worktrees under .claude/worktrees), 2,000 documents with a working location in the main checkout and a commit
        // version each. Paths need not exist: status and list read only the catalog.
        const repo = `${home}/work/proj`
        const repositoryId = registerArtifactRepository(db, { commonDir: `${repo}/.git`, displayName: 'proj', remoteIdentity: null }, now)
        const roots = Array.from({ length: K }, (_, k) => registerArtifactRoot(db, {
          kind: 'checkout', canonicalPath: k === 0 ? repo : `${repo}/.claude/worktrees/wt${String(k).padStart(3, '0')}`, repositoryId, projectName: 'proj',
          checkoutIdentity: `ck-${k}`, protected: false, scopeFlags: ['checkout'],
        }, now))
        const r = mulberry32(K)
        db.transaction(() => {
          for (let i = 0; i < 2000; i++) {
            const rel = `docs/topic-${i % 40}/note-${i}.md`
            recordArtifactObservation(db, {
              rootId: roots[0]!.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: rel }, kind: 'working', observedAt: now,
              path: `${repo}/${rel}`, stat: { dev: '2049', ino: String(1000 + i), size: 100 + i, mtimeMs: Date.now() - i * 1000, ctimeMs: Date.now() - i * 1000 },
            }, now)
            recordArtifactObservation(db, {
              rootId: roots[0]!.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: rel }, kind: 'commit', observedAt: now,
              git: { repositoryId, commitOid: hex(r, 40), gitPath: rel, blobOid: hex(r, 40), objectFormat: 'sha1', mode: 0o100644, size: 100 + i },
            }, now)
          }
          // Steady state of the queue: one finished checkout-status job per checkout and one git-history job (direct SQL, fixture only).
          const ins = db.raw.prepare(`INSERT INTO artifact_jobs (job_id, scope_id, task_kind, desired_generation, applied_generation, state, priority, attempts, coverage_state, updated_at)
            VALUES (?, ?, ?, 1, 1, 'done', 20, 0, 'complete', ?)`)
          roots.forEach((root, k) => ins.run(`job-${K}-${k}`, root.rootId, 'checkout-status', now))
          ins.run(`job-${K}-history`, roots[0]!.rootId, 'git-history', now)
        })
        const srv = await routeServer(scope, db, home, config)
        const cold = { status: await timeGets(`${srv.base}/api/artifact-manager/status`), list: await timeGets(`${srv.base}/api/artifact-documents?limit=50`) }
        // With a history cursor held by the first checkout by path (the scheduler's steady state after one history pass).
        db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, 'cursor', ?)`).run(`history-cursor:${roots[0]!.rootId}`, now)
        const steady = { status: await timeGets(`${srv.base}/api/artifact-manager/status`), list: await timeGets(`${srv.base}/api/artifact-documents?limit=50`) }
        const statusBody = await (await fetch(`${srv.base}/api/artifact-manager/status`)).json() as { roots: unknown[] }
        assert.equal(statusBody.roots.length, K, 'every checkout is listed in status')
        record('r47-status-list', {
          K, docs: 2000, load: machineLoad(),
          ...flat('status_nocursor_ms', cold.status), ...flat('list_nocursor_ms', cold.list), ...flat('status_cursor_ms', steady.status), ...flat('list_cursor_ms', steady.list),
        })
        out.push({ K, name: 'status without a history cursor', s: cold.status }, { K, name: 'list without a history cursor', s: cold.list },
          { K, name: 'status with a history cursor', s: steady.status }, { K, name: 'list with a history cursor', s: steady.list })
        await srv.close()
        db.close()
      }
      return out
    })
    // R47: the status/list cost is judged against the health/list API budget of spec s16 (p95 < 200 ms).
    for (const c of cells) {
      await target(t, 'PERF-09', `K=${c.K} ${c.name}: p95 < 200 ms`, { ok: c.s.p95 < 200, value: c.s.p95, message: `K=${c.K} ${c.name}: p95 ${c.s.p95} ms (API budget 200 ms)` })
    }
  })
})

// ================================================================================================================ PERF-05

const WORDS = ['billing', 'export', 'report', 'migration', 'dashboard', 'cleanup', 'auth', 'sync', 'invoice', 'schedule', 'intake', 'pipeline', 'refactor', 'notes', 'summary']
const DOC_EXTS = ['md', 'md', 'md', 'md', 'html', 'json', 'sql', 'csv', 'txt', 'pdf', 'docx', 'ts', 'png'] // ts/png: not documents (types=all only)
const DIRS = ['docs', 'docs/specs', 'reports', 'notes', 'deliverables/2026-10', 'src']
const DAY = 86_400_000

type GroupedCatalog = {
  documents: number; locations: number; versions: number; evidence: number; sessions: string[]; buildMs: number; observations: number; busySession: string
  wideDocument: string; nowMs: number
}

/**
 * 10,000 document groups and 100,000 locations, written through the REAL persistence functions (registerArtifactRepository,
 * registerArtifactRoot, recordArtifactObservation with its evidence, ensureSession, setExistsState), so documents, versions,
 * version state, evidence, the legacy projection and FTS rows are exactly what the service would write. Shape: 20 repositories
 * x 11 checkouts (main + 10 linked worktrees) x 450 repository documents (one working location per checkout, 15% divergent
 * bytes, 80% of the rest tracked-clean, one commit version with Git evidence each; 25% carry recorded hook evidence of one of
 * 2,000 sessions, 10% of the commits a recorded Atlas-Session trailer), plus 10 output roots x 100 root-identity documents;
 * 1% of documents sit in a `phi` folder (protected); 3% of locations are then marked missing, and every location of 5% of
 * the repository documents (deleted everywhere, Git-only).
 * Deterministic: every random choice comes from one seeded generator and is drawn in creation order (never in the order of a
 * production-generated id), and the query times are relative to the fixture's own clock, so the totals are the same in every run.
 */
function buildGroupedCatalog(db: AtlasDb, base: string): GroupedCatalog {
  const r = mulberry32(20261027)
  const pick = <T,>(a: readonly T[]) => a[(r() * a.length) | 0]!
  const uuid = () => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-${'89ab'[(r() * 4) | 0]}${hex(r, 3)}-${hex(r, 12)}`
  const now = new Date().toISOString()
  const nowMs = Date.parse(now)
  const started = performance.now()
  const sessions: string[] = []
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      const s = uuid()
      const at = iso(nowMs - r() * 90 * DAY)
      ensureSession(db, { sessionId: s, cwd: `${base}/work/repo-${String(i % 20).padStart(2, '0')}`, startedAt: at, now: at })
      sessions.push(s)
    }
  })
  let ino = 10_000
  let observations = 0
  // The main checkout's path of every repository document, in creation order (the seeded counter for the Git-only draw).
  const mainPaths: string[] = []
  const obs = (o: ArtifactWorkerObservation) => { recordArtifactObservation(db, o, now); observations++ }
  for (let p = 0; p < 20; p++) {
    const pp = String(p).padStart(2, '0')
    const repoDir = `${base}/work/repo-${pp}`
    db.transaction(() => {
      const repositoryId = registerArtifactRepository(db, { commonDir: `${repoDir}/.git`, displayName: `repo-${pp}`, remoteIdentity: null }, now)
      const checkouts = Array.from({ length: 11 }, (_, j) => registerArtifactRoot(db, {
        kind: 'checkout', canonicalPath: j === 0 ? repoDir : `${repoDir}/.claude/worktrees/wt-${String(j).padStart(2, '0')}`, repositoryId, projectName: `project-${pp}`,
        checkoutIdentity: `ck-${p}-${j}`, protected: false, scopeFlags: ['checkout'],
      }, now))
      for (let d = 0; d < 450; d++) {
        const dir = r() < 0.01 ? 'phi' : pick(DIRS)
        const rel = `${dir}/${pick(WORDS)}-${pick(WORDS)}-${p}-${d}.${pick(DOC_EXTS)}`
        const identity = { identityKind: 'repository' as const, repositoryId, rootId: null, relativePath: rel }
        const docMs = nowMs - r() * 90 * DAY
        const size = 200 + ((r() * 50_000) | 0)
        const commitOid = hex(r, 40)
        const blobOid = hex(r, 40)
        const trailer = r() < 0.1 ? pick(sessions) : null
        obs({
          rootId: checkouts[0]!.rootId, identity, kind: 'commit', observedAt: now,
          git: { repositoryId, commitOid, gitPath: rel, blobOid, objectFormat: 'sha1', mode: 0o100644, size },
          evidence: { source: 'git', eventKey: `git:${commitOid}:${rel}`, sessionId: trailer, operation: 'touched', certainty: trailer ? 'recorded' : 'unknown', eventAt: iso(docMs) },
        })
        const hookSession = r() < 0.25 ? pick(sessions) : null
        checkouts.forEach((c, j) => {
          const divergent = r() < 0.15
          const tracked = !divergent && r() < 0.8
          const o: ArtifactWorkerObservation = {
            rootId: c.rootId, identity, kind: 'working', observedAt: now, path: `${c.canonicalPath}/${rel}`,
            stat: { dev: '2049', ino: String(ino++), size: divergent ? size + 7 : size, mtimeMs: docMs + j * 1000, ctimeMs: docMs + j * 1000 },
            git: { repositoryId, checkoutIdentity: `ck-${p}-${j}`, gitPath: rel, objectFormat: 'sha1', mode: 0o100644, size: divergent ? size + 7 : size, ...(tracked ? { blobOid } : {}) },
          }
          if (j === 0 && hookSession) {
            o.evidence = { source: 'hook', eventKey: `tool-use:${hookSession}:toolu_${p}_${d}`, sessionId: hookSession, operation: 'created', certainty: 'recorded', eventAt: iso(docMs) }
          }
          obs(o)
        })
        mainPaths.push(`${checkouts[0]!.canonicalPath}/${rel}`)
      }
    })
  }
  db.transaction(() => {
    for (let k = 0; k < 10; k++) {
      const root = registerArtifactRoot(db, {
        kind: 'output', canonicalPath: `${base}/outputs/out-${k}`, repositoryId: null, projectName: `outputs-${k}`, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'],
      }, now)
      for (let d = 0; d < 100; d++) {
        const rel = `${pick(WORDS)}/${pick(WORDS)}-${k}-${d}.${pick(DOC_EXTS)}`
        const docMs = nowMs - r() * 90 * DAY
        const hookSession = r() < 0.3 ? pick(sessions) : null
        obs({
          rootId: root.rootId, identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: rel }, kind: 'working', observedAt: now,
          path: `${root.canonicalPath}/${rel}`, stat: { dev: '2049', ino: String(ino++), size: 1000 + d, mtimeMs: docMs, ctimeMs: docMs },
          ...(hookSession ? { evidence: { source: 'hook' as const, eventKey: `tool-use:${hookSession}:toolu_out_${k}_${d}`, sessionId: hookSession, operation: 'created' as const, certainty: 'recorded' as const, eventAt: iso(docMs) } } : {}),
        })
      }
    }
    // artifact_id is the insertion order (deterministic); document_id is a random production id and never orders a draw.
    const ids = db.raw.prepare('SELECT artifact_id FROM artifacts ORDER BY artifact_id').all() as Array<{ artifact_id: number }>
    for (const { artifact_id } of ids) if (r() < 0.03) setExistsState(db, artifact_id, 'missing', null, now)
    // 5% of the repository documents were deleted from every checkout: only their committed versions remain (Git-only).
    const docOf = db.raw.prepare('SELECT document_id FROM artifacts WHERE path = ?')
    const locs = db.raw.prepare('SELECT artifact_id FROM artifacts WHERE document_id = ? ORDER BY artifact_id')
    for (const path of mainPaths) {
      if (r() >= 0.05) continue
      const doc = docOf.get(path) as { document_id: string }
      for (const { artifact_id } of locs.all(doc.document_id) as Array<{ artifact_id: number }>) setExistsState(db, artifact_id, 'missing', null, now)
    }
  })
  const n = (sql: string) => countOf(db.raw, sql)
  const busy = db.raw.prepare(`SELECT session_id FROM artifact_evidence WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY COUNT(*) DESC, session_id LIMIT 1`).get() as { session_id: string }
  const wide = db.raw.prepare(`SELECT document_id FROM artifacts GROUP BY document_id ORDER BY COUNT(*) DESC, MIN(artifact_id) LIMIT 1`).get() as { document_id: string }
  return {
    documents: n('SELECT COUNT(*) AS n FROM artifact_documents'), locations: n('SELECT COUNT(*) AS n FROM artifacts'), versions: n('SELECT COUNT(*) AS n FROM artifact_versions'),
    evidence: n('SELECT COUNT(*) AS n FROM artifact_evidence'), sessions, buildMs: performance.now() - started, observations, busySession: busy.session_id, wideDocument: wide.document_id,
    nowMs,
  }
}

describe('PERF-05 grouped queries at 10,000 document groups and 100,000 locations', () => {
  test('representative filtered grouped list queries, session/evidence joins, pagination and detail: p95 < 100 ms', gate(), async t => {
    const measured = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-groups-')
      const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
      const db = openDatabase(config.dbPath)
      scope.onCleanup(() => { try { db.close() } catch { /* closed */ } })
      const cat = buildGroupedCatalog(db, home)
      record('groups-fixture', {
        documents: cat.documents, locations: cat.locations, versions: cat.versions, evidence: cat.evidence, sessions: cat.sessions.length,
        observations: cat.observations, build_ms: Math.round(cat.buildMs), observations_per_s: Math.round(cat.observations / (cat.buildMs / 1000)),
        db_mib: mib(statSync(config.dbPath).size + (() => { try { return statSync(`${config.dbPath}-wal`).size } catch { return 0 } })()),
      })
      assert.equal(cat.documents, 10_000)
      assert.equal(cat.locations, 100_000)
      const visible = listArtifactDocuments(db, {}, { limit: 1, offset: 0 }).total
      const nowMs = cat.nowMs
      const cases: Array<[string, ArtifactDocumentFilters, { limit: number; offset: number }, string]> = [
        ['default', {}, { limit: 50, offset: 0 }, 'limit=50'],
        ['page-100', {}, { limit: 50, offset: 5000 }, 'limit=50&offset=5000'],
        ['last-page', {}, { limit: 50, offset: Math.max(0, visible - 50) }, `limit=50&offset=${Math.max(0, visible - 50)}`],
        ['ext', { extension: 'md' }, { limit: 50, offset: 0 }, 'ext=md'],
        ['project', { project: 'project-07' }, { limit: 50, offset: 0 }, 'project=project-07'],
        ['availability-local', { availability: 'local' }, { limit: 50, offset: 0 }, 'availability=local'],
        ['availability-git', { availability: 'git' }, { limit: 50, offset: 0 }, 'availability=git'],
        ['availability-unavailable', { availability: 'unavailable' }, { limit: 50, offset: 0 }, 'availability=unavailable'],
        ['needs-preservation', { needsPreservation: true }, { limit: 50, offset: 0 }, 'needsPreservation=true'],
        ['no-preservation-needed', { needsPreservation: false }, { limit: 50, offset: 0 }, 'needsPreservation=false'],
        ['session', { sessionId: cat.busySession }, { limit: 50, offset: 0 }, `session=${cat.busySession}`],
        ['source-hook', { source: 'hook' }, { limit: 50, offset: 0 }, 'source=hook'],
        ['search-1', { q: 'billing' }, { limit: 50, offset: 0 }, 'q=billing'],
        ['search-2', { q: 'billing report' }, { limit: 50, offset: 0 }, 'q=billing%20report'],
        ['combined', { project: 'project-07', extension: 'md', availability: 'local', q: 'report' }, { limit: 50, offset: 0 }, 'project=project-07&ext=md&availability=local&q=report'],
        ['date-range', { from: iso(nowMs - 30 * DAY), to: iso(nowMs - 7 * DAY) }, { limit: 50, offset: 0 }, `from=${iso(nowMs - 30 * DAY)}&to=${iso(nowMs - 7 * DAY)}`],
        ['types-all', { types: 'all' }, { limit: 50, offset: 0 }, 'types=all'],
        ['sensitive-show', { sensitive: 'show' }, { limit: 50, offset: 0 }, 'sensitive=show'],
        ['page-500', {}, { limit: 500, offset: 0 }, 'limit=500'],
      ]
      const srv = await routeServer(scope, db, home, config)
      const production: Array<{ name: string; total: number | null; http: Summary }> = []
      const run = async (label: string) => {
        for (const [name, filters, page, query] of cases) {
          const fn = timeCalls(() => listArtifactDocuments(db, filters, page))
          const http = await timeGets(`${srv.base}/api/artifact-documents?${query}`)
          const total = listArtifactDocuments(db, filters, { limit: 1, offset: 0 }).total
          record('groups-query', { stats: label, query: name, total, ...flat('fn_ms', fn), ...flat('http_ms', http) })
          if (label === 'production') production.push({ name, total, http })
        }
        const detailFn = timeCalls(() => getArtifactDocument(db, cat.wideDocument, { limit: 50, offset: 0 }))
        const detailHttp = await timeGets(`${srv.base}/api/artifact-documents/${cat.wideDocument}`)
        const locations = getArtifactDocument(db, cat.wideDocument, { limit: 500, offset: 0 }).locations.length
        record('groups-query', { stats: label, query: 'detail-widest', locations, ...flat('fn_ms', detailFn), ...flat('http_ms', detailHttp) })
        if (label === 'production') production.push({ name: 'detail-widest', total: null, http: detailHttp })
      }
      // As the service leaves the catalog (it never runs ANALYZE and discards planner statistics at start), then once more
      // after ANALYZE for comparison only (not a target).
      await run('production')
      db.raw.exec('ANALYZE')
      await run('after-analyze')
      return production
    })
    for (const c of measured) {
      await target(t, 'PERF-05', `${c.name}: HTTP p95 < 100 ms`, { ok: c.http.p95 < 100, value: c.http.p95, message: `${c.name}: HTTP p95 ${c.http.p95} ms (target < 100 ms, spec s16)` })
    }
  })
})

// ================================================================================================================ PERF-04

describe('PERF-04 small idle output root recovery (simulated clock)', () => {
  test('a write with no notification in a small idle output root is recovered within 10 min plus one slice', gate(), async t => {
    const r = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-idle-')
      const out = join(home, 'outputs', 'small')
      writeTree(out, { count: 50, perDir: 10, bytes: 200, prefix: 'baseline-' })
      const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
      config.artifacts.outputRoots = [{ path: out, repositoryId: null, label: 'small', protected: false }]
      const db = openDatabase(config.dbPath)
      scope.onCleanup(() => { try { db.close() } catch { /* closed */ } })
      // The real worker child with the production launch (priority wrapper); the runner with production defaults except the
      // clock: simulated time = wall time + the idle time the service loop would have slept (500 ms per idle pass).
      // The root starts idle: its files are an hour old (simulated) when the service first runs, as for a root left untouched.
      const w: ArtifactWorkerClient = createArtifactWorkerClient({ log: silentLogger, home })
      scope.onCleanup(() => w.stop())
      let offset = 0
      const clock = () => Date.now() + offset
      // The settle rule (docs/superpowers/specs/2026-11-06-settle-before-version-design.md) measures a file's age from the
      // worker's capture time to the file's ctime. The simulated clock moves only the runner's time, so without this mapping the
      // worker's stamps and the file system's times stay on the real clock and a file never ages in simulated time. Every
      // offset change is logged with the real time it began, and the working rows of each frame are mapped onto simulated time.
      const offsets: Array<{ fromMs: number; offset: number }> = [{ fromMs: -Infinity, offset: 0 }]
      const simMs = (realMs: number): number => {
        let lo = 0
        let hi = offsets.length - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (offsets[mid]!.fromMs <= realMs) lo = mid
          else hi = mid - 1
        }
        return realMs + offsets[lo]!.offset
      }
      const simIso = (iso: string): string => new Date(simMs(Date.parse(iso))).toISOString()
      const runner = artifactManagerRunner({ db, config, log: silentLogger, home, worker: w, clock })
      scope.onCleanup(() => runner.stop?.())
      const POLL_MS = config.worker.pollMs
      const jobState = () => db.raw.prepare(`SELECT j.state, j.updated_at FROM artifact_jobs j JOIN artifact_roots r ON r.root_id = j.scope_id WHERE r.canonical_path = ? AND j.task_kind = 'output-walk'`).get(out) as { state: string } | undefined
      const timeline: Array<{ simS: number; event: string }> = []
      let lastState = ''
      let frames = 0
      let maxRows = 0
      const realPoll = w.poll.bind(w)
      w.poll = () => {
        const ev = realPoll()
        if (ev?.type !== 'frame') return ev
        frames++
        maxRows = Math.max(maxRows, ev.frame.rows.length)
        const rows = ev.frame.rows.map((row): typeof row => {
          if (row.kind !== 'working') return row
          return {
            ...row,
            observedAt: simIso(row.observedAt),
            ...(row.capturedAt !== undefined ? { capturedAt: simIso(row.capturedAt) } : {}),
            ...(row.stat ? { stat: { ...row.stat, ctimeMs: simMs(row.stat.ctimeMs), mtimeMs: simMs(row.stat.mtimeMs) } } : {}),
          }
        })
        return { ...ev, frame: { ...ev.frame, rows } }
      }
      const step = async (): Promise<void> => {
        const busy = await runner.run()
        await runner.settle()
        const s = jobState()?.state ?? 'none'
        if (s !== lastState) { timeline.push({ simS: (clock() - t0) / 1000, event: `job ${s}` }); lastState = s }
        if (!busy) { offset += POLL_MS; offsets.push({ fromMs: Date.now(), offset }) }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      // An idle root's files are older than one quiet period when the service starts. Shift the clock once, by an hour; the
      // shift begins after every baseline ctime, or that entry would still look new.
      const AGE_MS = 60 * 60 * 1000
      const ctimes: number[] = []
      const scan = (d: string): void => {
        ctimes.push(lstatSync(d).ctimeMs)
        for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) scan(join(d, e.name)); else ctimes.push(lstatSync(join(d, e.name)).ctimeMs) }
      }
      scan(out)
      const shiftFromMs = Date.now()
      assert.ok(Math.max(...ctimes) < shiftFromMs, 'the clock shift must begin after every baseline ctime, or the baseline would still look new')
      offset += AGE_MS
      offsets.push({ fromMs: shiftFromMs, offset })
      const t0 = clock()
      const visible = (p: string) => (db.raw.prepare('SELECT current_version_id FROM artifacts WHERE path = ?').get(p) as { current_version_id: string | null } | undefined)?.current_version_id != null
      const baselineFile = join(out, 'd0000', 'baseline-000000.md')
      for (let i = 0; i < 20_000 && !(visible(baselineFile) && jobState()?.state === 'done'); i++) await step()
      assert.ok(visible(baselineFile), 'the baseline pass catalogued the root')
      const baselineDoneS = (clock() - t0) / 1000
      timeline.push({ simS: baselineDoneS, event: 'baseline pass done' })
      // The write: no hook, no watcher (not wired here), no refresh. Only the recovery schedule can find it. Since Wave 2a the
      // schedule counts from the last COMPLETED pass (persisted recovery-done), so this write right after a completion is the
      // case the 10 min + one slice bound is about.
      const written = put(join(out, 'd0002', 'late-write.md'), 'written with no notification\n')
      const writeS = (clock() - t0) / 1000
      timeline.push({ simS: writeS, event: 'unnotified write' })
      let foundS = -1
      const wallStart = performance.now()
      for (let i = 0; i < 20_000; i++) {
        await step()
        if (visible(written)) { foundS = (clock() - t0) / 1000; break }
        if ((clock() - t0) / 1000 > writeS + 1800) break
      }
      timeline.push({ simS: foundS, event: 'write visible' })
      const latencyS = foundS - writeS
      const targetS = config.artifacts.recoveryIntervalMs / 1000 + config.artifacts.maxSliceMs / 1000
      record('idle-root-recovery', {
        entries: 51 + 5, baseline_done_sim_s: Math.round(baselineDoneS * 10) / 10, write_sim_s: Math.round(writeS * 10) / 10, visible_sim_s: Math.round(foundS * 10) / 10,
        latency_sim_s: Math.round(latencyS * 10) / 10, target_s: targetS, wall_ms: Math.round(performance.now() - wallStart), frames, max_frame_rows: maxRows,
        timeline: timeline.map(e => `${Math.round(e.simS * 10) / 10}s:${e.event}`).join('|'),
      })
      return { foundS, latencyS, targetS, slice: config.artifacts.maxSliceMs }
    })
    await target(t, 'PERF-04', 'T4 unnotified write recovered within 10 min + one slice', {
      ok: r.foundS >= 0 && r.latencyS <= r.targetS, value: Math.round(r.latencyS * 10) / 10,
      message: r.foundS < 0 ? 'the unnotified write was never recovered' : `recovered ${r.latencyS.toFixed(1)} s after the write; target ${r.targetS} s (10 min + one ${r.slice} ms slice)`,
    })
  })
})

// ================================================================================================================ real-service helpers

type StatusRoot = { rootId: string; kind: string; path: string | null; state: string; completedAt: string | null; lastSuccessfulAt: string | null; gaps: string[]; oldestQueuedAgeMs: number; reason: string | null }
type Status = { paused: boolean; pendingJobs: number; oldestQueueAgeMs: number; priorityFacility: string | null; health: Record<string, number>; roots: StatusRoot[] }

/**
 * The status the harness steers by (not a measured request): one retry after a transport error, since a keep-alive socket
 * the server closed while the client reused it fails once without the service being at fault. A stopped service still throws.
 */
async function status(svc: ServiceProcess): Promise<Status> {
  let r
  try {
    r = await svc.api('GET', '/api/artifact-manager/status?sensitive=show')
  } catch (error) {
    if (svc.child.exitCode !== null || svc.child.signalCode !== null) throw error
    controlRetries++
    await sleep(200)
    r = await svc.api('GET', '/api/artifact-manager/status?sensitive=show')
  }
  if (r.status !== 200) throw new Error(`status -> ${r.status}`)
  return r.json as Status
}
let controlRetries = 0

/** Polls status until no job is pending (twice in a row) and `ready` holds. Returns the last status. */
async function waitIdle(svc: ServiceProcess, label: string, timeoutMs: number, ready: (s: Status) => boolean = () => true): Promise<Status> {
  let last: Status | null = null
  let calm = 0
  await waitFor(async () => {
    last = await status(svc)
    calm = last.pendingJobs === 0 && ready(last) ? calm + 1 : 0
    return calm >= 2
  }, label, timeoutMs, 250)
  return last!
}

type Window = Record<string, number | string>
type Meter = {
  /** Ends the window: event-loop delay and CPU of the service (probe), worker CPU/IO/RSS, service RSS/IO, health deltas. */
  stop(): Promise<Window>
  sampler: RssSampler
  workerPids: Set<number>
}

/** Starts a measurement window on a running service (resets the probe window). */
async function meter(svc: ServiceProcess, intervalMs = 100): Promise<Meter> {
  await svc.probe(true)
  const workerPids = new Set<number>()
  const first = new Map<number, { cpu: number; rchar: number; readBytes: number }>()
  const lastSeen = new Map<number, { cpu: number; rchar: number; readBytes: number }>()
  const health0 = (await status(svc)).health
  const svcIo0 = procIo(svc.pid)
  // This (measuring) process's own CPU in the window: it shares the machine with the service, so it is reported.
  const clientCpu0 = process.cpuUsage()
  const take = (pid: number) => {
    const s = procSample(pid)
    const io = procIo(pid)
    if (!s) return
    const v = { cpu: s.utimeMs + s.stimeMs, rchar: io?.rchar ?? 0, readBytes: io?.readBytes ?? 0 }
    if (!first.has(pid)) first.set(pid, v)
    lastSeen.set(pid, v)
  }
  const sampler = new RssSampler(() => {
    const w = svc.workerPid()
    if (w !== null) { workerPids.add(w); take(w) }
    return [svc.pid, ...workerPids]
  }, intervalMs).start()
  LIVE.add(() => sampler.stop())
  return {
    sampler, workerPids,
    stop: async () => {
      sampler.stop()
      for (const pid of workerPids) take(pid)
      const probe: ProbeStats = await svc.probe(false)
      const health1 = (await status(svc)).health
      const delta = (k: string) => (health1[k] ?? 0) - (health0[k] ?? 0)
      let workerCpu = 0, workerRchar = 0, workerRead = 0, workerPeak = 0
      for (const pid of workerPids) {
        const a = first.get(pid), b = lastSeen.get(pid)
        if (!a || !b) continue
        // A worker first seen in this window started inside it: count all of its CPU.
        const base = a === b ? { cpu: 0, rchar: 0, readBytes: 0 } : a
        workerCpu += b.cpu - base.cpu
        workerRchar += b.rchar - base.rchar
        workerRead += b.readBytes - base.readBytes
        workerPeak = Math.max(workerPeak, sampler.peaks.get(pid) ?? 0)
      }
      const svcIo1 = procIo(svc.pid)
      const clientCpu = process.cpuUsage(clientCpu0)
      return {
        window_ms: probe.windowMs, client_cpu_ms: Math.round((clientCpu.user + clientCpu.system) / 1000), eld_p50_ms: probe.p50Ms, eld_p99_ms: probe.p99Ms, eld_max_ms: probe.maxMs,
        svc_cpu_ms: probe.cpuUserMs + probe.cpuSystemMs, svc_rss_peak_mib: mib(Math.max(probe.peakRssBytes, sampler.peaks.get(svc.pid) ?? 0)),
        // rchar/wchar: bytes through read()/write() (page cache included: SQLite page and WAL traffic); read/write_bytes: storage I/O.
        svc_rchar_mib: svcIo0 && svcIo1 ? mib(svcIo1.rchar - svcIo0.rchar) : 'n/a', svc_wchar_mib: svcIo0 && svcIo1 ? mib(svcIo1.wchar - svcIo0.wchar) : 'n/a',
        svc_read_mib: svcIo0 && svcIo1 ? mib(svcIo1.readBytes - svcIo0.readBytes) : 'n/a', svc_write_mib: svcIo0 && svcIo1 ? mib(svcIo1.writeBytes - svcIo0.writeBytes) : 'n/a',
        // Without /proc (macOS) the worker cannot be sampled here: 'n/a', and the worker RSS targets are explicit skips.
        worker_pids: workerPids.size, worker_cpu_ms: HAS_PROC ? Math.round(workerCpu) : 'n/a', worker_rchar_mib: HAS_PROC ? mib(workerRchar) : 'n/a',
        worker_read_mib: HAS_PROC ? mib(workerRead) : 'n/a', worker_rss_peak_mib: HAS_PROC ? mib(workerPeak) : 'n/a',
        slices: delta('slices'), entries_inspected: delta('entries-inspected'), rows_committed: delta('rows-committed'), db_write_ms: delta('db-write-ms'), slice_ms: delta('slice-ms'),
        retries: delta('retries'), failed: delta('failed'), rejected_frames: delta('rejected-frames'), worker_crashes: delta('worker-crashes'), status_throttled: delta('status-throttled'),
        backfill_rows: delta('backfill-rows'),
        // When this window closed and the machine load then (record()'s own at=/load= are the time of writing, which can be later).
        window_end_at: new Date().toISOString(), window_end_load: machineLoad(),
      }
    },
  }
}

/**
 * A closed-loop API client: one request every `everyMs`, or right after the previous one when it ran late. Closed loop means
 * coordinated omission: while one request is stuck behind a long block, no other request is issued, so a block yields one slow
 * sample (or one failed request), not the several an open-loop client would see. `stop()` therefore also returns a summary
 * CORRECTED for coordinated omission (as HdrHistogram's recordValueWithExpectedInterval does): every request that took L ms
 * also stands for the requests that would have been issued during it, L - everyMs, L - 2 x everyMs, ... down to everyMs, and a
 * request that failed after waiting at least everyMs counts with the time it waited. The T6 API targets use the corrected p95.
 */
class ApiLoad {
  private stopped = false
  private done: Promise<void> | null = null
  readonly samples = new Map<string, number[]>()
  /** Every answered request's time, plus every failed request that waited at least everyMs (for the corrected summary). */
  private readonly timed: number[] = []
  /** Failed requests that waited at least everyMs (a stall, not a refused connection). */
  stalledErrors = 0
  errors = 0
  /** Failed requests whose connection was refused (nothing listening): the deliberate restart gap, or a dead service. */
  refused = 0
  /** The first few failures, for the record (an error is never retried or folded into latency). */
  readonly errorNotes: string[] = []
  private note(text: string): void { if (this.errorNotes.length < 3) this.errorNotes.push(text.slice(0, 120)) }
  private readonly svc: () => ServiceProcess
  private readonly paths: string[]
  private readonly everyMs: number
  constructor(svc: () => ServiceProcess, paths: string[], everyMs: number) {
    this.svc = svc
    this.paths = paths
    this.everyMs = everyMs
  }
  start(): this {
    LIVE.add(() => { this.stopped = true })
    this.done = (async () => {
      let i = 0
      let next = performance.now()
      while (!this.stopped) {
        const wait = next - performance.now()
        if (wait > 0) await sleep(wait)
        if (this.stopped) break
        next += this.everyMs
        const path = this.paths[i++ % this.paths.length]!
        const t0 = performance.now()
        try {
          const r = await this.svc().api('GET', path)
          this.timed.push(r.ms)
          if (r.status !== 200) { this.errors++; this.note(`HTTP ${r.status}`) } else (this.samples.get(path) ?? this.samples.set(path, []).get(path)!).push(r.ms)
        } catch (error) {
          this.errors++
          if (error instanceof Error && /ECONNREFUSED/.test(error.message)) this.refused++
          const waited = performance.now() - t0
          if (waited >= this.everyMs) { this.stalledErrors++; this.timed.push(waited) }
          this.note(error instanceof Error ? error.message.replace(/;.*$/, '') : 'error')
        }
      }
    })()
    return this
  }
  async stop(): Promise<ApiStats> {
    this.stopped = true
    await this.done
    const byPath: Record<string, Summary> = {}
    for (const [p, v] of this.samples) byPath[p] = summarize(v)
    const corrected: number[] = []
    for (const ms of this.timed) {
      corrected.push(ms)
      for (let missed = ms - this.everyMs; missed >= this.everyMs; missed -= this.everyMs) corrected.push(missed)
    }
    return {
      all: summarize([...this.samples.values()].flat()), corrected: summarize(corrected), byPath, errors: this.errors, refused: this.refused, stalledErrors: this.stalledErrors,
      errorNotes: this.errorNotes.join('|') || 'none',
    }
  }
}

type ApiStats = { all: Summary; corrected: Summary; byPath: Record<string, Summary>; errors: number; refused: number; stalledErrors: number; errorNotes: string }

const API_PATHS = [
  '/api/artifact-manager/status',
  '/api/artifact-documents?limit=50',
  '/api/artifact-documents?ext=md&availability=local&limit=50',
  '/api/artifact-documents?q=report&limit=50',
]

const visibleIn = (catalog: ReturnType<typeof openCatalogReadOnly>, paths: string[]): Set<string> => {
  const out = new Set<string>()
  const stmt = catalog.prepare('SELECT current_version_id AS v FROM artifacts WHERE path = ?')
  for (const p of paths) if ((stmt.get(p) as { v: string | null } | undefined)?.v) out.add(p)
  return out
}

/**
 * Writes files from a separate "script" process, as a real generator would. Writing thousands of files synchronously in THIS
 * process would block the measuring client's own event loop for the length of the write, and a request in flight then reads
 * slow although the service answered in time (seen in Wave 3: a 251 ms burst sample while the service's event-loop max was
 * 59.5 ms and this process was blocked for its 222 ms write). Returns the writer's wall time.
 */
const FILE_WRITER = `const fs = require('fs'), path = require('path'); let d = ''; process.stdin.setEncoding('utf8')
process.stdin.on('data', c => { d += c }).on('end', () => { for (const [f, c] of JSON.parse(d)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c) } })`
async function writeFilesInChild(scope: Scope, cwd: string, files: Array<[string, string]>): Promise<number> {
  const r = await runProgram(scope, process.execPath, ['-e', FILE_WRITER], {}, cwd, JSON.stringify(files), 300_000)
  if (r.code !== 0) throw new Error(`the file-writing script failed (${r.code}): ${r.err.slice(0, 500)}`)
  return r.ms
}

/** The measuring process's own event-loop delay over a window (a slow API sample is only the service's when this stays low). */
function clientLoop(): { stop(): { client_eld_p99_ms: number; client_eld_max_ms: number } } {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  const ms = (ns: number) => Math.round((ns / 1e6) * 100) / 100
  return { stop: () => { h.disable(); return { client_eld_p99_ms: h.count > 0 ? ms(h.percentile(99)) : 0, client_eld_max_ms: h.count > 0 ? ms(h.max) : 0 } } }
}

/**
 * T6 targets of one load window: health/list API p95 < 200 ms (corrected for coordinated omission, see ApiLoad; the raw
 * closed-loop p95 is in the message and the PERF lines) and service event-loop p99 < 100 ms.
 */
async function responsiveness(t: TestContext, id: string, label: string, api: ApiStats | null, window: Window | null, apiTodo?: string, expect?: ApiExpect): Promise<void> {
  if (api && expect) await apiGuards(t, id, label, api, expect)
  if (api) await apiTarget(t, id, `T6 API p95 < 200 ms (${label})`, api, apiTodo)
  if (window) {
    const eld = Number(window.eld_p99_ms)
    await target(t, id, `T6 event-loop p99 < 100 ms (${label})`, { ok: eld < 100, value: eld, message: `service event-loop delay p99 ${eld} ms (${label}; target < 100 ms)` })
  }
}

/**
 * What a healthy API window looks like. The guards are hard subtests that are NEVER under a todo: a dead service, an empty sample
 * or an unexpected failed request must fail on every platform and not read as the known PERF-GAP-5 miss (an empty sample has a
 * NaN p95, which a todo would report as "missed-todo"). `minSamples` is below the smallest answered-request count in the Wave 3
 * runs (results document: burst rounds 13-20, so 10; the walks 37-341, so about half; session-folder initial walk about 300;
 * dirty walk 210-238). `refused` is how many refused connections the window may hold (only the deliberate restart gap of PERF-06 has any),
 * `other` how many other failed requests (only the dirty walk on Linux: the one request the R75 stall resets).
 */
type ApiExpect = { minSamples: number; refused?: number; other?: number }
function apiGuardChecks(label: string, api: ApiStats, expect: ApiExpect): { sample: Check; failures: Check } {
  const maxRefused = expect.refused ?? 0
  const maxOther = expect.other ?? 0
  const other = api.errors - api.refused
  return {
    sample: {
      ok: api.all.n >= expect.minSamples, value: api.all.n,
      message: `${api.all.n} answered requests in the ${label} window (want at least ${expect.minSamples}); ${api.errors} failed (${api.errorNotes})`,
    },
    failures: {
      ok: api.refused <= maxRefused && other <= maxOther, value: api.errors,
      message: `${api.errors} failed requests in the ${label} window: ${api.refused} refused connections (at most ${maxRefused} expected) and ${other} others (at most ${maxOther} expected): ${api.errorNotes}`,
    },
  }
}
async function apiGuards(t: TestContext, id: string, label: string, api: ApiStats, expect: ApiExpect): Promise<void> {
  const g = apiGuardChecks(label, api, expect)
  await target(t, id, `T6 API sample holds at least ${expect.minSamples} answered requests (${label})`, g.sample)
  await target(t, id, `T6 API requests fail only as expected (${label})`, g.failures)
}

/** The T6 API target on the corrected p95; the message gives both p95s, the maximum, the sample count and the stalled errors. */
async function apiTarget(t: TestContext, id: string, name: string, api: ApiStats, todo?: string): Promise<void> {
  await target(t, id, name, {
    ok: api.corrected.p95 < 200, value: api.corrected.p95, todo,
    message: `API p95 ${api.corrected.p95} ms corrected for coordinated omission (raw closed-loop p95 ${api.all.p95} ms, max ${api.all.max} ms, n=${api.all.n}, ${api.stalledErrors} failed after a stall); target < 200 ms`,
  })
}

/** API fields for a PERF line: the raw closed-loop summary and the corrected one. */
const apiFields = (prefix: string, api: ApiStats) => ({ ...flat(prefix, api.all), ...flat(`${prefix}_co`, api.corrected), [`${prefix}_stalled_errors`]: api.stalledErrors })

/** T7 target: worker RSS peak below 256 MiB over the given windows (explicit skip where /proc is missing). */
async function workerRss(t: TestContext, id: string, label: string, windows: Window[]): Promise<void> {
  const peak = Math.max(...windows.map(w => procNumber(w.worker_rss_peak_mib)))
  await target(t, id, `T7 worker RSS < 256 MiB (${label})`, { ok: peak < 256, value: Number.isFinite(peak) ? peak : 'n/a', message: `worker RSS peak ${peak} MiB (${label}; target < 256 MiB)`, unmeasured: NO_PROC })
}

// ================================================================================================================ PERF-01

describe('PERF-01 direct observations through hook, service and catalog', () => {
  test('100 direct path observations: at least 95% visible within 1 s (healthy service, no backlog)', gate(), async t => {
    const r = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-direct-')
      const main = makeRepo(join(home, 'work', 'proj'))
      const wt = addWorktree(main, join(main, '.claude', 'worktrees', 'feat'), 'feat')
      const svc = await startServiceProcess(scope, { home })
      const S = sid(1)
      assert.equal((await runHook(scope, sessionStart(S, wt), { home, port: svc.port })).outcome, 'delivered')
      const ready = await waitIdle(svc, 'the session checkout registered and its first passes done', 180_000, s => s.roots.some(r => r.path === wt))
      record('direct-observations-baseline', { roots: ready.roots.map(x => `${x.kind}:${x.state}${x.gaps.length ? `[${x.gaps.join(',')}]` : ''}`).join('+') })
      const load = machineLoad()
      const m = await meter(svc)
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const N = 100
      const CADENCE_MS = 500
      const paths: string[] = []
      const issuedAt: number[] = []
      const hooks: Array<Awaited<ReturnType<typeof runHook>>> = []
      const listedAt = new Map<string, number>()
      const versionAt = new Map<string, number>()
      const listedStmt = catalog.prepare('SELECT path, current_version_id AS v FROM artifacts WHERE path >= ? AND path < ? AND document_id IS NOT NULL')
      const prefix = join(wt, 'notes', 'obs-')
      const prefixEnd = join(wt, 'notes', 'obs.') // '.' sorts right after '-': [prefix, prefixEnd) is every obs-* path
      const poll = setInterval(() => {
        const at = performance.now()
        for (const row of listedStmt.all(prefix, prefixEnd) as Array<{ path: string; v: string | null }>) {
          if (!listedAt.has(row.path)) listedAt.set(row.path, at)
          if (row.v && !versionAt.has(row.path)) versionAt.set(row.path, at)
        }
      }, 10)
      LIVE.add(() => clearInterval(poll))
      const start = performance.now()
      for (let i = 0; i < N; i++) {
        const due = start + i * CADENCE_MS
        const wait = due - performance.now()
        if (wait > 0) await sleep(wait)
        const p = put(join(wt, 'notes', `obs-${String(i).padStart(3, '0')}.md`), `direct observation ${i}\n`)
        paths.push(p)
        issuedAt.push(performance.now())
        hooks.push(await runHook(scope, writeTool(S, wt, p, `toolu_perf_direct_${i}`, 'create'), { home, port: svc.port }))
      }
      await waitFor(() => versionAt.size >= N, 'every observation visible', 30_000).catch(() => {})
      clearInterval(poll)
      const metrics = await m.stop()
      const versionLat = paths.map((p, i) => (versionAt.get(p) ?? Number.POSITIVE_INFINITY) - issuedAt[i]!)
      const listedLat = paths.map((p, i) => (listedAt.get(p) ?? Number.POSITIVE_INFINITY) - issuedAt[i]!)
      const afterHook = paths.map((p, i) => (versionAt.get(p) ?? Number.POSITIVE_INFINITY) - hooks[i]!.endedAt)
      const within1s = versionLat.filter(v => v <= 1000).length
      const api = await svc.api('GET', `/api/artifact-documents?session=${S}&limit=500`)
      const listedNames = new Set((api.json.rows as Array<{ displayName: string }>).map(x => x.displayName))
      const allListed = paths.every(p => listedNames.has(p.slice(p.lastIndexOf('/') + 1)))
      const v = summarize(versionLat.filter(Number.isFinite))
      record('direct-observations', {
        n: N, cadence_ms: CADENCE_MS, load, visible: versionAt.size, within_1s: within1s, pct_within_1s: within1s,
        ...flat('visible_from_hook_spawn_ms', v), ...flat('visible_from_hook_exit_ms', summarize(afterHook.filter(Number.isFinite))),
        ...flat('listed_from_hook_spawn_ms', summarize(listedLat.filter(Number.isFinite))),
        ...flat('hook_wall_ms', summarize(hooks.map(h => h.wallMs))), hook_outcomes: [...new Set(hooks.map(h => h.outcome))].join('+'), api_lists_all: allListed,
        ...metrics,
      })
      return { within1s, N, v, allListed }
    })
    await target(t, 'PERF-01', 'T1 at least 95 of 100 direct observations visible within 1 s', {
      ok: r.within1s >= 95, value: r.within1s, message: `${r.within1s} of ${r.N} observations were visible within 1 s (target: at least 95); p95 ${r.v.p95} ms`,
    })
    await target(t, 'PERF-01', 'every observed document is listed by the API for its session', { ok: r.allListed, value: String(r.allListed), message: 'a document the hook observed is missing from the session filter' })
  })
})

// ================================================================================================================ PERF-02

type HookSet = { label: string; wall: Summary; inner: Summary; outcomes: Record<string, number>; spooled: number }

/** Runs `n` hooks with one payload each, `gapMs` apart, and summarizes them (wall = spawn to exit; inner = the hook's own clock). */
async function hookSet(scope: Scope, label: string, home: string, port: number, n: number, gapMs: number, payload: (i: number) => Record<string, unknown>,
  extra: Record<string, string | number> = {}): Promise<HookSet> {
  const out: Array<Awaited<ReturnType<typeof runHook>>> = []
  const load = machineLoad()
  for (let i = 0; i < n; i++) {
    out.push(await runHook(scope, payload(i), { home, port }))
    await sleep(gapMs)
  }
  const spooled = (() => { try { return readdirSync(join(home, '.josh-360', 'atlas', 'spool')).length } catch { return 0 } })()
  const wall = summarize(out.map(h => h.wallMs))
  const inner = summarize(out.map(h => h.atMs))
  const outcomes: Record<string, number> = {}
  for (const h of out) outcomes[h.outcome] = (outcomes[h.outcome] ?? 0) + 1
  record('hook-latency', {
    server: label, n, load, ...flat('wall_ms', wall), ...flat('inprocess_ms', inner),
    outcomes: Object.entries(outcomes).map(([k, v]) => `${k}:${v}`).join('+'), spool_files: spooled, over_500_wall: out.filter(h => h.wallMs > 500).length,
    over_500_inprocess: out.filter(h => h.atMs > 500).length, exit_codes: [...new Set(out.map(h => h.code))].join('+'), ...extra,
  })
  return { label, wall, inner, outcomes, spooled }
}

/** T2's 500 ms cap for one set of hook runs, as two targets (the process lifetime and the hook's own clock). */
async function hookCap(t: TestContext, id: string, h: HookSet): Promise<void> {
  await target(t, id, `T2 no hook execution beyond 500 ms (${h.label}, spawn to exit)`, { ok: h.wall.max <= 500, value: h.wall.max, message: `${h.label}: a hook process ran ${h.wall.max} ms from spawn to exit (cap 500 ms)` })
  await target(t, id, `T2 no hook execution beyond 500 ms (${h.label}, hook's own clock)`, { ok: h.inner.max <= 500, value: h.inner.max, message: `${h.label}: the hook's own clock reached ${h.inner.max} ms (cap 500 ms)` })
}

describe('PERF-02 hook latency', () => {
  test('hook p95 < 200 ms with a healthy service, and no execution beyond the 500 ms cap (healthy, refused, hung)', gate(), async t => {
    const sets = await withScope(async scope => {
      const N = 200
      // Healthy: the real service; every run is an observation the service records (a Write of an existing file).
      const home = scope.scratch('atlas-perf-hook-')
      const main = makeRepo(join(home, 'work', 'proj'))
      const svc = await startServiceProcess(scope, { home })
      const S = sid(2)
      await runHook(scope, sessionStart(S, main), { home, port: svc.port })
      await waitIdle(svc, 'the session checkout registered', 180_000, s => s.roots.some(r => r.path === main))
      const hookFile = put(join(main, 'notes', 'hook-target.md'), 'target\n')
      const healthy = await hookSet(scope, 'healthy', home, svc.port, N, 50, i => writeTool(S, main, hookFile, `toolu_perf_hook_${i}`, 'update'))
      await svc.stop()
      // Refused: nothing listens on the port (a stopped service); every event is spooled.
      const refusedHome = scope.scratch('atlas-perf-hook-refused-')
      const refused = await hookSet(scope, 'refused', refusedHome, await freePort(), N, 50, i => writeTool(S, main, hookFile, `toolu_perf_refused_${i}`, 'update'))
      // Hung: the port accepts and never answers; the hook must give up at its own timeout and spool.
      const hungHome = scope.scratch('atlas-perf-hook-hung-')
      const hung = await hungServer()
      scope.onCleanup(() => hung.close())
      const stuck = await hookSet(scope, 'hung', hungHome, hung.port, N, 50, i => writeTool(S, main, hookFile, `toolu_perf_hung_${i}`, 'update'))
      return { healthy, refused, stuck, N }
    })
    await target(t, 'PERF-02', 'T2 healthy hook p95 < 200 ms', { ok: sets.healthy.wall.p95 < 200, value: sets.healthy.wall.p95, message: `healthy hook p95 ${sets.healthy.wall.p95} ms (target < 200 ms)` })
    for (const h of [sets.healthy, sets.refused, sets.stuck]) await hookCap(t, 'PERF-02', h)
    await target(t, 'PERF-02', 'every healthy event delivered', { ok: sets.healthy.outcomes['delivered'] === sets.N, value: JSON.stringify(sets.healthy.outcomes), message: `healthy outcomes ${JSON.stringify(sets.healthy.outcomes)}` })
    for (const h of [sets.refused, sets.stuck]) {
      await target(t, 'PERF-02', `every ${h.label} event spooled exactly once`, {
        ok: h.outcomes['spooled'] === sets.N && h.spooled === sets.N, value: `${h.outcomes['spooled'] ?? 0}/${h.spooled}`,
        message: `${h.label}: outcomes ${JSON.stringify(h.outcomes)}, ${h.spooled} spool files (want ${sets.N} of each)`,
      })
    }
  })
})

// ================================================================================================================ PERF-03

describe('PERF-03 script outputs in an active 5,000-entry checkout after a completed turn', () => {
  test('script outputs (untracked, gitignored output root, docs) are visible within 60 s of the turn-completed notification', gate(), async t => {
    const turns = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-turn-')
      // A registered active checkout with 5,000 relevant entries: README plus 3,999 tracked notes and 1,000 tracked docs.
      const repo = join(home, 'work', 'proj')
      mkdirSync(repo, { recursive: true })
      git(repo, ['init', '-q'])
      put(join(repo, 'README.md'), '# proj\n')
      put(join(repo, '.gitignore'), 'reports/\n')
      writeTree(join(repo, 'notes'), { count: 3999, perDir: 100, bytes: 400, prefix: 'note-' })
      writeTree(join(repo, 'docs'), { count: 1000, perDir: 100, bytes: 400, prefix: 'doc-' })
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'baseline'])
      // The gitignored output folder exists before the session (an output root is registered when its folder exists).
      put(join(repo, 'reports', 'previous.csv'), 'a,b\n')
      const svc = await startServiceProcess(scope, { home })
      const S = sid(3)
      const fixtureStart = performance.now()
      await runHook(scope, sessionStart(S, repo), { home, port: svc.port })
      const ready = await waitIdle(svc, 'the checkout, its docs and reports roots and their first passes', 600_000,
        s => s.roots.some(r => r.path === repo) && s.roots.some(r => r.path === join(repo, 'docs')) && s.roots.some(r => r.path === join(repo, 'reports')))
      const baselineMs = performance.now() - fixtureStart
      record('turn-outputs-baseline', {
        tracked_documents: 5000, baseline_wall_ms: Math.round(baselineMs),
        roots: ready.roots.map(r => `${r.kind}:${r.state}${r.gaps.length ? `[${r.gaps.join(',')}]` : ''}`).join('+'),
      })
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const outputs = (run: string) => [
        ...[0, 1, 2, 3].map(k => join(repo, 'results', run, `out-${k}.md`)),
        ...[0, 1, 2].map(k => join(repo, 'reports', run, `r-${k}.csv`)),
        ...[0, 1, 2].map(k => join(repo, 'docs', run, `d-${k}.md`)),
      ]
      const results: Array<{ run: string; visible: number; outputs: number; slowestMs: number }> = []
      const turn = async (run: string, opts: { bashHint: boolean; quietBeforeMs: number }) => {
        if (opts.quietBeforeMs > 0) await sleep(opts.quietBeforeMs)
        const load = machineLoad()
        const m = await meter(svc)
        const files = outputs(run)
        for (const f of files) put(f, `${run} output ${f}\n`)
        if (opts.bashHint) {
          await runHook(scope, bashTool(S, repo, `toolu_perf_turn_${run}`), { home, port: svc.port })
          await sleep(1000)
        }
        const stopAt = performance.now()
        await runHook(scope, stopEvent(S, repo), { home, port: svc.port })
        const seen = new Map<string, number>()
        let maxQueueAge = 0
        const timer = setInterval(() => { void status(svc).then(s => { maxQueueAge = Math.max(maxQueueAge, s.oldestQueueAgeMs) }).catch(() => {}) }, 500)
        LIVE.add(() => clearInterval(timer))
        await waitFor(() => {
          const now = performance.now()
          for (const f of visibleIn(catalog, files)) if (!seen.has(f)) seen.set(f, now - stopAt)
          return seen.size === files.length
        }, `all ${run} outputs visible`, 120_000, 20).catch(() => {})
        clearInterval(timer)
        const metrics = await m.stop()
        const lat = files.map(f => seen.get(f) ?? Number.POSITIVE_INFINITY)
        const byKind = (needle: string) => Math.round(Math.max(...files.map((f, i) => (f.includes(needle) ? lat[i]! : 0))))
        record('turn-outputs', {
          run, bash_hint: opts.bashHint, quiet_before_ms: opts.quietBeforeMs, load, outputs: files.length, visible: seen.size,
          max_from_stop_ms: Math.round(Math.max(...lat)), untracked_max_ms: byKind('/results/'), ignored_output_root_max_ms: byKind('/reports/'), docs_max_ms: byKind('/docs/'),
          max_queue_age_ms: maxQueueAge, ...metrics,
        })
        results.push({ run, visible: seen.size, outputs: files.length, slowestMs: Math.max(...lat) })
      }
      // A: the turn ends right after the first passes (the 30 s status floor may defer the checkout pass).
      await turn('run-a', { bashHint: false, quietBeforeMs: 0 })
      // B: the script's Bash call sends its scope hint, the turn ends a second later.
      await turn('run-b', { bashHint: true, quietBeforeMs: 0 })
      // C: the checkout has been quiet for longer than the status floor when the turn ends.
      await turn('run-c', { bashHint: false, quietBeforeMs: 35_000 })
      return results
    })
    for (const r of turns) {
      await target(t, 'PERF-03', `T3 every script output visible within 60 s of the turn end (${r.run})`, {
        ok: r.slowestMs <= 60_000, value: Number.isFinite(r.slowestMs) ? Math.round(r.slowestMs) : 'never',
        message: `${r.run}: ${r.visible}/${r.outputs} visible, slowest ${Math.round(r.slowestMs)} ms after Stop (target 60 s)`,
      })
    }
  })
})

// ================================================================================================================ PERF-06

describe('PERF-06 sustained backfill: a 100,000-entry root plus the legacy catalog backfill', () => {
  test('API p95 < 200 ms, event-loop p99 < 100 ms, worker RSS < 256 MiB; bounded, fair, resumable progress with correct partial coverage', gate(), async t => {
    const SLICE = 5_000 // production maxEntriesPerSlice
    const r = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-backfill-')
      const big = join(home, 'data', 'big')
      const fixtureStart = performance.now()
      // 100,000 files in 1,000 folders (101,000 entries): 60% eligible documents (.md), 40% other files (.png, .ts).
      writeTree(big, { count: 100_000, perDir: 100, bytes: 64, prefix: 'f', ext: i => (i % 5 < 3 ? 'md' : i % 5 === 3 ? 'png' : 'ts') })
      const EXPECTED_DOCS = 60_000
      const small = join(home, 'work', 'notebook')
      writeTree(small, { count: 10, perDir: 10, bytes: 64, prefix: 'n' })
      // A populated pre-upgrade catalog: the existing perf fixture (2,000 sessions, 100,000 legacy artifacts with origins),
      // migrated by openDatabase; the service backfills it into provisional documents (legacy-backfill, priority 40).
      const atlasDir = join(home, '.josh-360', 'atlas')
      mkdirSync(atlasDir, { recursive: true, mode: 0o700 })
      const seedDb = openDatabase(join(atlasDir, 'atlas.db'))
      seedBenchmark(seedDb, { sessions: 2000, artifacts: 100_000 })
      // seedBenchmark ends with ANALYZE, which Atlas itself never runs. Since F-STATS was fixed the service discards planner
      // statistics on the artifact tables at start; the fixture still drops them so this measurement does not depend on that.
      seedDb.raw.exec('DELETE FROM sqlite_stat1')
      seedDb.close()
      record('backfill-fixture', { files: 100_000, folders: 1000, eligible: EXPECTED_DOCS, legacy_artifacts: 100_000, fixture_ms: Math.round(performance.now() - fixtureStart) })
      const config = { artifacts: { outputRoots: [{ path: big, label: 'big' }] } }
      let svc = await startServiceProcess(scope, { home, config })
      const S = sid(6)
      await runHook(scope, sessionStart(S, small), { home, port: svc.port })
      const load = new ApiLoad(() => svc, API_PATHS, 250).start()
      const windows: Window[] = []
      let m = await meter(svc)
      let client = clientLoop()
      const started = performance.now()
      const series: Array<{ t: number; inspected: number; rows: number; backfill: number; docs: number; state: string; pending: number; queueAgeMs: number }> = []
      const violations: string[] = []
      let catalog = openCatalogReadOnly(svc.dbPath)
      const bigDocs = () => countOf(catalog, `SELECT COUNT(*) AS n FROM artifacts WHERE path >= ? AND path < ? AND current_version_id IS NOT NULL`, `${big}/`, `${big}0`)
      let fairness: Record<string, number | string> = { probe: 'not-run' }
      let restart: Record<string, number | string> = { restart: 'not-run' }
      let fairnessDone = false
      let restarted = false
      let smallReadyMs = -1
      const sample = async () => {
        const s = await status(svc)
        const root = s.roots.find(x => x.path === big)
        const docs = bigDocs()
        series.push({
          t: performance.now() - started, inspected: s.health['entries-inspected'] ?? 0, rows: s.health['rows-committed'] ?? 0, backfill: s.health['backfill-rows'] ?? 0,
          docs, state: root?.state ?? 'unregistered', pending: s.pendingJobs, queueAgeMs: s.oldestQueueAgeMs,
        })
        // Correct partial coverage: until every document is catalogued the root is never reported complete.
        if (root && docs < EXPECTED_DOCS && (root.state === 'idle' || root.lastSuccessfulAt !== null)) violations.push(`${Math.round(performance.now() - started)}ms: ${root.state} lastSuccessfulAt=${root.lastSuccessfulAt} with ${docs} docs`)
        return { s, root, docs }
      }
      for (;;) {
        const { s, root, docs } = await sample()
        if (root && root.lastSuccessfulAt !== null && docs >= EXPECTED_DOCS) break
        if (performance.now() - started > 30 * 60_000) throw new Error(`the 100,000-entry root did not complete in 30 min: ${JSON.stringify(series.at(-1))}`)
        const inspected = s.health['entries-inspected'] ?? 0
        const smallRoot = s.roots.find(x => x.path === small)
        if (smallReadyMs < 0 && smallRoot?.lastSuccessfulAt) smallReadyMs = Math.round(performance.now() - started)
        if (!fairnessDone && inspected >= 20_000 && smallRoot?.lastSuccessfulAt) {
          // Fairness: once the small session root is registered and walked, a new file in it announced only by its session's
          // turn end (recovery priority, the same priority as the big walk) must not wait for the big root's pass.
          fairnessDone = true
          const f = put(join(small, 'mid-walk.md'), 'written while the big root is being walked\n')
          const t0 = performance.now()
          await runHook(scope, stopEvent(S, small), { home, port: svc.port })
          await waitFor(() => visibleIn(catalog, [f]).size === 1, 'the small root file', 300_000, 50).catch(() => {})
          const after = await status(svc)
          const afterRoot = after.roots.find(x => x.path === big)
          fairness = {
            probe: 'small-root-turn-end', small_visible_ms: visibleIn(catalog, [f]).size === 1 ? Math.round(performance.now() - t0) : -1,
            big_inspected_at_probe: inspected, big_inspected_when_visible: after.health['entries-inspected'] ?? 0,
            big_complete_when_visible: afterRoot?.lastSuccessfulAt ? 1 : 0, big_docs_when_visible: bigDocs(),
          }
        }
        if (!restarted && inspected >= 50_000 && docs < EXPECTED_DOCS) {
          // Resumable: stop the service mid-pass (SIGTERM, as launchd does) and start a new one on the same catalog.
          restarted = true
          const before = await status(svc)
          windows.push({ window: 'walk-before-restart', ...(await m.stop()), ...client.stop() })
          catalog.close()
          const t0 = performance.now()
          const stopped = await svc.stop()
          const docsAtStop = (() => { const c = openCatalogReadOnly(join(atlasDir, 'atlas.db')); try { return countOf(c, `SELECT COUNT(*) AS n FROM artifacts WHERE path >= ? AND path < ?`, `${big}/`, `${big}0`) } finally { c.close() } })()
          svc = await startServiceProcess(scope, { home })
          catalog = openCatalogReadOnly(svc.dbPath)
          m = await meter(svc)
          client = clientLoop()
          restart = {
            inspected_at_restart: before.health['entries-inspected'] ?? 0, docs_at_stop: docsAtStop, restart_gap_ms: Math.round(performance.now() - t0), leftover_processes: stopped.leftovers.length,
          }
        }
        await sleep(1000)
      }
      const walkMs = performance.now() - started
      windows.push({ window: restarted ? 'walk-after-restart' : 'walk', ...(await m.stop()), ...client.stop() })
      const walkApi = await load.stop()
      const afterWalk = await status(svc)
      // Any further scan pass after the resumed walk is measured on its own (F-RESTART-PASS: there must be none now), then the
      // legacy backfill alone: 60 s of it at background priority (cold backfill has no completion deadline).
      const scansPending = () => countOf(catalog, `SELECT COUNT(*) AS n FROM artifact_jobs WHERE task_kind <> 'legacy-backfill' AND state IN ('queued', 'running', 'retry')`)
      const extraStart = performance.now()
      const loadExtra = new ApiLoad(() => svc, API_PATHS, 250).start()
      m = await meter(svc)
      client = clientLoop()
      // The scheduler looks for due recovery once a second: give it 5 s to queue a pass, then wait until no scan is pending
      // for 5 consecutive seconds.
      await sleep(5000)
      let quiet = 0
      await waitFor(() => { quiet = scansPending() === 0 ? quiet + 1 : 0; return quiet >= 5 }, 'every scan pass finished', 30 * 60_000, 1000)
      const extraWindow = await m.stop()
      const extraClient = client.stop()
      const extraApi = await loadExtra.stop()
      windows.push({ window: 'after-walk-until-no-scan-pending', ...extraWindow, ...extraClient })
      const afterExtra = await status(svc)
      const extraInspected = (afterExtra.health['entries-inspected'] ?? 0) - (afterWalk.health['entries-inspected'] ?? 0)
      record('backfill-extra-pass', {
        wall_ms: Math.round(performance.now() - extraStart), entries_inspected: extraInspected,
        rows_committed: (afterExtra.health['rows-committed'] ?? 0) - (afterWalk.health['rows-committed'] ?? 0), slices: (afterExtra.health['slices'] ?? 0) - (afterWalk.health['slices'] ?? 0),
        ...apiFields('api_ms', extraApi), api_errors: extraApi.errors,
      })
      const load2 = new ApiLoad(() => svc, API_PATHS, 250).start()
      m = await meter(svc)
      client = clientLoop()
      const b0 = (await status(svc)).health['backfill-rows'] ?? 0
      await sleep(60_000)
      const legacyWindow = await m.stop()
      const legacyClient = client.stop()
      const legacyApi = await load2.stop()
      const b1 = (await status(svc)).health['backfill-rows'] ?? 0
      windows.push({ window: 'legacy-backfill-60s', ...legacyWindow, ...legacyClient })
      const totalInspected = afterWalk.health['entries-inspected'] ?? 0
      const dup = {
        documents: countOf(catalog, `SELECT COUNT(*) AS n FROM artifact_documents d WHERE d.document_id IN (SELECT document_id FROM artifacts WHERE path >= ? AND path < ?)`, `${big}/`, `${big}0`),
        locations: countOf(catalog, `SELECT COUNT(*) AS n FROM artifacts WHERE path >= ? AND path < ?`, `${big}/`, `${big}0`),
        versions: countOf(catalog, `SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifacts a ON a.artifact_id = v.location_artifact_id WHERE a.path >= ? AND a.path < ?`, `${big}/`, `${big}0`),
        evidence: countOf(catalog, `SELECT COUNT(*) AS n FROM artifact_evidence e JOIN artifacts a ON a.artifact_id = e.artifact_id WHERE a.path >= ? AND a.path < ?`, `${big}/`, `${big}0`),
      }
      // T8: a restart AFTER the pass completed re-walks nothing (the recovery schedule is persisted: F-RESTART-PASS fixed). The
      // scheduler looks for due recovery once a second; a lost schedule would queue the big root again at once.
      const bigJob = () => catalog.prepare(`SELECT j.state AS s, j.desired_generation AS d, j.applied_generation AS a FROM artifact_jobs j JOIN artifact_roots r ON r.root_id = j.scope_id
        WHERE r.canonical_path = ? AND j.task_kind = 'output-walk'`).get(big) as { s: string; d: number; a: number }
      const job0 = bigJob()
      const h0 = (await status(svc)).health
      catalog.close()
      const restartAt = performance.now()
      await svc.stop()
      svc = await startServiceProcess(scope, { home })
      catalog = openCatalogReadOnly(svc.dbPath)
      const jobStates = new Set<string>()
      for (let i = 0; i < 30; i++) { await sleep(1000); const j = bigJob(); jobStates.add(`${j.s}:${j.d}/${j.a}`) }
      const job1 = bigJob()
      const s1 = await status(svc)
      const bigAfter = s1.roots.find(x => x.path === big)
      const afterComplete = {
        observed_ms: Math.round(performance.now() - restartAt), entries_inspected: (s1.health['entries-inspected'] ?? 0) - (h0['entries-inspected'] ?? 0),
        rows_committed: (s1.health['rows-committed'] ?? 0) - (h0['rows-committed'] ?? 0), job_before: `${job0.s}:${job0.d}/${job0.a}`, job_after: `${job1.s}:${job1.d}/${job1.a}`,
        job_states_seen: [...jobStates].join('+'), big_state_after: bigAfter?.state ?? 'unregistered', rewalked: job1.d !== job0.d || jobStates.size > 1 ? 1 : 0,
      }
      record('backfill-restart-after-complete', afterComplete)
      const rate = (a: number, b: number, msSpan: number) => Math.round(((b - a) / Math.max(1, msSpan)) * 1000)
      const maxQueueAge = Math.max(...series.map(x => x.queueAgeMs))
      record('backfill-walk', {
        entries: 101_000, eligible: EXPECTED_DOCS, walk_wall_ms: Math.round(walkMs), entries_inspected_total: totalInspected, rows_committed_total: afterWalk.health['rows-committed'] ?? 0,
        slices_total: afterWalk.health['slices'] ?? 0, rows_per_s: rate(0, afterWalk.health['rows-committed'] ?? 0, walkMs), entries_per_s: rate(0, totalInspected, walkMs),
        max_queue_age_ms: maxQueueAge, coverage_violations: violations.length, ...dup, ...restart, ...fairness, small_root_first_complete_ms: smallReadyMs,
        retries: afterWalk.health['retries'] ?? 0, failed: afterWalk.health['failed'] ?? 0, rejected_frames: afterWalk.health['rejected-frames'] ?? 0, worker_crashes: afterWalk.health['worker-crashes'] ?? 0,
      })
      record('backfill-legacy', { window_ms: 60_000, backfill_rows: b1 - b0, rows_per_s: Math.round((b1 - b0) / 60), legacy_total: 100_000, projected_remaining_s: b1 - b0 > 0 ? Math.round(((100_000 - b1) / (b1 - b0)) * 60) : -1 })
      for (const w of windows) record('backfill-window', w)
      record('backfill-api', { phase: 'walk', ...apiFields('ms', walkApi), errors: walkApi.errors, error_notes: walkApi.errorNotes, control_retries: controlRetries, ...Object.fromEntries(Object.entries(walkApi.byPath).map(([p, s]) => [`p95_${p.replace(/[^a-z]+/gi, '_')}`, s.p95])) })
      record('backfill-api', { phase: 'after-walk', ...apiFields('ms', extraApi), errors: extraApi.errors, error_notes: extraApi.errorNotes })
      record('backfill-api', { phase: 'legacy', ...apiFields('ms', legacyApi), errors: legacyApi.errors, error_notes: legacyApi.errorNotes, ...Object.fromEntries(Object.entries(legacyApi.byPath).map(([p, s]) => [`p95_${p.replace(/[^a-z]+/gi, '_')}`, s.p95])) })
      record('backfill-progress', { series: series.filter((_, i) => i % 10 === 0).map(x => `${Math.round(x.t / 1000)}s:${x.inspected}i/${x.docs}d/${x.state}`).join('|') })
      catalog.close()
      return { EXPECTED_DOCS, windows, walkApi, extraApi, legacyApi, violations, dup, totalInspected, extraInspected, fairness, afterComplete, restart }
    })
    const win = (name: string) => r.windows.find(w => w.window === name) ?? null
    // T6 (spec s16) in every phase of the sustained backfill.
    // The walk's API window holds the deliberate SIGTERM restart: connections are refused while the new service starts (3-4 at 4
    // requests/s in the Wave 3 runs, restart gap 0.66-0.93 s); any other failed request, or more refusals than the measured gap
    // explains, fails hard.
    const restartGapMs = Number(r.restart.restart_gap_ms ?? 0)
    await responsiveness(t, 'PERF-06', 'cold walk', r.walkApi, win('walk-before-restart') ?? win('walk'), undefined,
      { minSamples: 150, refused: restartGapMs > 0 ? Math.ceil(restartGapMs / 250) + 2 : 0 })
    await responsiveness(t, 'PERF-06', 'cold walk after the restart', null, win('walk-after-restart'))
    await responsiveness(t, 'PERF-06', 'after the walk until no scan is pending', r.extraApi, win('after-walk-until-no-scan-pending'), undefined, { minSamples: 20 })
    await responsiveness(t, 'PERF-06', 'legacy backfill', r.legacyApi, win('legacy-backfill-60s'), undefined, { minSamples: 120 })
    // T7 and T8: bounded memory, correct partial coverage, no duplicates, fair and resumable progress.
    await workerRss(t, 'PERF-06', 'every window', r.windows)
    await target(t, 'PERF-06', 'T8 the root never reads complete before every document is catalogued', { ok: r.violations.length === 0, value: r.violations.length, message: `coverage violations: ${r.violations.slice(0, 3).join('; ')}` })
    await target(t, 'PERF-06', 'T8 one document per eligible file (no duplicates across slices or the restart)', { ok: r.dup.documents === r.EXPECTED_DOCS, value: r.dup.documents, message: `${r.dup.documents} documents for ${r.EXPECTED_DOCS} eligible files` })
    await target(t, 'PERF-06', 'T8 one version per file (no churn from resumed or repeated slices)', { ok: r.dup.versions === r.EXPECTED_DOCS, value: r.dup.versions, message: `${r.dup.versions} versions for ${r.EXPECTED_DOCS} files` })
    await target(t, 'PERF-06', 'T8 fair progress: a small root is served while the big root is still being walked', {
      ok: Number(r.fairness.small_visible_ms) >= 0 && Number(r.fairness.big_complete_when_visible) === 0, value: Number(r.fairness.small_visible_ms ?? -1),
      message: `small-root file visible after ${r.fairness.small_visible_ms} ms; big root complete by then: ${r.fairness.big_complete_when_visible}`,
    })
    await target(t, 'PERF-06', 'T8 a restart mid-pass resumes from its cursor (at most one slice of rework, never from the first folder)', {
      ok: r.totalInspected <= 101_000 + SLICE + 1_000, value: r.totalInspected, message: `entries inspected ${r.totalInspected} for 101,000 entries plus the small root`,
    })
    await target(t, 'PERF-06', 'T8 the resumed pass is not followed by a second pass (F-RESTART-PASS)', {
      ok: r.extraInspected < SLICE, value: r.extraInspected, message: `${r.extraInspected} entries inspected after the resumed walk completed (a second pass would inspect 101,000)`,
    })
    await target(t, 'PERF-06', 'T8 a restart after a completed pass re-walks nothing', {
      ok: r.afterComplete.rewalked === 0 && r.afterComplete.entries_inspected < SLICE, value: r.afterComplete.entries_inspected,
      message: `after a restart that followed the completed pass: job ${r.afterComplete.job_before} -> ${r.afterComplete.job_after} (seen ${r.afterComplete.job_states_seen}), ${r.afterComplete.entries_inspected} entries inspected in ${r.afterComplete.observed_ms} ms`,
    })
  })
})

// ================================================================================================================ PERF-07

// The burst rounds are sampled during the round only, so the request interval must let even a fast round answer the guard's
// minimum. A round has been seen to be fully visible 1,053 ms after the hint (macOS, APFS, round 2), and a closed loop at
// 250 ms answers only 5 requests in that time. BURST_MIN_ROUND_MS is that observation rounded down to 1,000 ms: a round is not
// assumed to be shorter than that (the service must catalogue 2,000 files and their versions). The interval gives the guard's
// minimum twice over in such a round, so one slow request or a late first request does not leave it short of the guard.
const BURST_MIN_SAMPLES = 10
const BURST_MIN_ROUND_MS = 1_000
const BURST_API_EVERY_MS = Math.floor(BURST_MIN_ROUND_MS / (2 * BURST_MIN_SAMPLES)) // 50 ms

// What an unexpected extra version of a rewritten file holds (diagnostic only; it adds information and asserts nothing). A file has
// more versions than rounds when a stat was recorded that is neither the old nor the final state.
type VersionStat = { ino: string | number; size: number; mtimeMs: number; ctimeMs: number }
type ExtraKind = 'EMPTY' | 'CTIME-ONLY' | 'SAME-SIZE-NEW-MTIME' | 'OTHER'
/**
 * EMPTY: size 0 (a stat between truncate and write). CTIME-ONLY: same inode, size and mtime as the previous version, a newer
 * ctime (a metadata change, no write). SAME-SIZE-NEW-MTIME: same inode and size, new mtime (a second write of the same length;
 * the normal rewrite of this test looks like this too). OTHER: anything else, and a first version.
 */
function classifyVersion(prev: VersionStat | null, v: VersionStat): ExtraKind {
  if (v.size === 0) return 'EMPTY'
  if (prev === null || String(prev.ino) !== String(v.ino) || prev.size !== v.size) return 'OTHER'
  if (prev.mtimeMs === v.mtimeMs && prev.ctimeMs !== v.ctimeMs) return 'CTIME-ONLY'
  if (prev.mtimeMs !== v.mtimeMs) return 'SAME-SIZE-NEW-MTIME'
  return 'OTHER'
}
/** The kind of a file's extra version: the first EMPTY or CTIME-ONLY version after the first, else the kind of the version at position `round` (0-based), else OTHER. */
function classifyExtra(versions: VersionStat[], round: number): ExtraKind {
  const kinds = versions.map((v, i) => (i === 0 ? 'OTHER' : classifyVersion(versions[i - 1]!, v)))
  return kinds.find(k => k === 'EMPTY' || k === 'CTIME-ONLY') ?? kinds[round] ?? 'OTHER'
}
/** "5 files over: 4 EMPTY, 1 OTHER; first: i=123 sizes 0->15", or '' when no file is over. */
function overSummary(files: Array<{ index: number; kind: ExtraKind; sizes: number[] }>): string {
  if (files.length === 0) return ''
  const by = new Map<ExtraKind, number>()
  for (const f of files) by.set(f.kind, (by.get(f.kind) ?? 0) + 1)
  const first = files[0]!
  return `${files.length} files over: ${[...by].map(([k, n]) => `${n} ${k}`).join(', ')}; first: i=${first.index} sizes ${first.sizes.join('->')}`
}

describe('PERF-07 a 2,000-file output burst', () => {
  test('bounded memory, prompt complete discovery, no duplicate documents, versions or evidence; API and event loop during each round', gate(), async t => {
    const rounds = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-burst-')
      const proj = join(home, 'work', 'analysis')
      put(join(proj, 'exports', 'README.md'), 'outputs land here\n')
      put(join(proj, 'gen.py'), 'print(1)\n')
      const svc = await startServiceProcess(scope, { home })
      const S = sid(7)
      await runHook(scope, sessionStart(S, proj), { home, port: svc.port })
      await waitIdle(svc, 'the session folder and its exports root', 180_000, s => s.roots.some(r => r.path === join(proj, 'exports')))
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const batch = join(proj, 'exports', 'batch')
      const burst = async (round: number) => {
        const load = machineLoad()
        const api = new ApiLoad(() => svc, API_PATHS, BURST_API_EVERY_MS).start()
        const m = await meter(svc)
        const client = clientLoop()
        // The script that produces the burst runs in its own process (see writeFilesInChild).
        const files: Array<[string, string]> = []
        for (let i = 0; i < 2000; i++) {
          files.push([join(batch, `part-${String(Math.floor(i / 200)).padStart(2, '0')}`, `table-${String(i).padStart(4, '0')}.${i % 4 === 0 ? 'csv' : 'md'}`), `round ${round} row ${i}\n`])
        }
        const writerStartedAt = Date.now()
        const writtenMs = await writeFilesInChild(scope, proj, files)
        const writerEndedAt = Date.now()
        const hintAt = performance.now()
        await runHook(scope, bashTool(S, proj, `toolu_perf_burst_${round}`), { home, port: svc.port })
        const want = round
        const done = () => countOf(catalog, `SELECT COUNT(*) AS n FROM artifacts a WHERE a.path >= ? AND a.path < ? AND (SELECT COUNT(*) FROM artifact_versions v WHERE v.kind = 'working' AND v.location_artifact_id = a.artifact_id) >= ?`, `${batch}/`, `${batch}0`, want)
        await waitFor(() => done() >= 2000, `burst ${round} fully catalogued`, 600_000, 250).catch(() => {})
        const allMs = performance.now() - hintAt
        const metrics = await m.stop()
        const apiStats = await api.stop()
        const clientStats = client.stop()
        const counts = {
          documents: countOf(catalog, `SELECT COUNT(DISTINCT document_id) AS n FROM artifacts WHERE path >= ? AND path < ?`, `${batch}/`, `${batch}0`),
          locations: countOf(catalog, `SELECT COUNT(*) AS n FROM artifacts WHERE path >= ? AND path < ?`, `${batch}/`, `${batch}0`),
          versions: countOf(catalog, `SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifacts a ON a.artifact_id = v.location_artifact_id WHERE a.path >= ? AND a.path < ?`, `${batch}/`, `${batch}0`),
          evidence: countOf(catalog, `SELECT COUNT(*) AS n FROM artifact_evidence e JOIN artifacts a ON a.artifact_id = e.artifact_id WHERE a.path >= ? AND a.path < ?`, `${batch}/`, `${batch}0`),
          dup_evidence: countOf(catalog, `SELECT COUNT(*) AS n FROM (SELECT e.version_id, e.session_id, e.source FROM artifact_evidence e JOIN artifacts a ON a.artifact_id = e.artifact_id
            WHERE a.path >= ? AND a.path < ? GROUP BY e.version_id, e.session_id, e.source HAVING COUNT(*) > 1)`, `${batch}/`, `${batch}0`),
        }
        // Diagnostic (reads only, asserts nothing; an error here is recorded and never reaches the round or its subtests): which files hold more working versions than this round, and what the extra one is.
        let overNote = ''
        try {
          const overRows = catalog.prepare(`SELECT a.artifact_id AS id, a.path AS path FROM artifacts a WHERE a.path >= ? AND a.path < ?
            AND (SELECT COUNT(*) FROM artifact_versions v WHERE v.kind = 'working' AND v.location_artifact_id = a.artifact_id) > ? ORDER BY a.path`).all(`${batch}/`, `${batch}0`, round) as Array<{ id: number; path: string }>
          const over = overRows.map(r => {
            const vs = catalog.prepare(`SELECT observation_revision AS rev, stat_signature AS sig, observed_at AS at FROM artifact_versions WHERE kind = 'working' AND location_artifact_id = ? ORDER BY observation_revision`).all(r.id) as Array<{ rev: number; sig: string; at: string }>
            const stats = vs.map(v => { const [, ino, size, mtimeMs, ctimeMs] = JSON.parse(v.sig) as [string, string, number, number, number]; return { rev: v.rev, ino, size, mtimeMs, ctimeMs, at: v.at } })
            let live: { size: number; mtimeMs: number; ctimeMs: number; bytes: number } | string
            try { const st = lstatSync(r.path); live = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, bytes: readFileSync(r.path).length } } catch (e) { live = `unreadable: ${e instanceof Error ? e.message : String(e)}` }
            return { index: Number(/table-(\d+)\./.exec(r.path)?.[1] ?? -1), path: r.path, kind: classifyExtra(stats, round), sizes: stats.map(v => v.size), stats, live }
          })
          const walkJobs = catalog.prepare(`SELECT state, updated_at AS at FROM artifact_jobs WHERE task_kind = 'output-walk' ORDER BY updated_at`).all() as Array<{ state: string; at: string }>
          record('burst-over', {
            round, files_over: over.length, summary: overSummary(over) || 'none', writer_start: iso(writerStartedAt), writer_end: iso(writerEndedAt),
            walk_jobs: walkJobs.map(j => `${j.state}@${j.at}`).join(',') || 'none',
          })
          for (const f of over.slice(0, 20)) record('burst-over-file', { round, index: f.index, kind: f.kind, versions: JSON.stringify(f.stats), live: JSON.stringify(f.live) })
          overNote = overSummary(over)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          overNote = `diagnostic failed: ${message}`
          try { record('burst-over-error', { round, error: message }) } catch { /* the diagnostic never fails the round */ }
        }
        record('burst', {
          round, files: 2000, load, write_ms: Math.round(writtenMs), catalogued: done(), all_visible_from_hint_ms: Math.round(allMs), ...counts,
          ...apiFields('api_ms', apiStats), api_errors: apiStats.errors, api_error_notes: apiStats.errorNotes, ...clientStats, ...metrics,
        })
        return { round, counts, metrics, api: apiStats, done: done(), overNote }
      }
      const first = await burst(1)
      const second = await burst(2) // the same 2,000 files rewritten: one new version each, no new documents
      return [first, second]
    })
    const [first, second] = rounds as [typeof rounds[0], typeof rounds[0]]
    await target(t, 'PERF-07', 'T8 round 1: every file of the burst is catalogued', { ok: first.done === 2000, value: first.done, message: `${first.done} of 2000 catalogued` })
    await target(t, 'PERF-07', 'T8 round 1: one document per file', { ok: first.counts.documents === 2000, value: first.counts.documents, message: `${first.counts.documents} documents for 2000 files` })
    await target(t, 'PERF-07', 'T8 round 2: every rewritten file has its new version', { ok: second.done === 2000, value: second.done, message: `${second.done} of 2000 have their second version` })
    await target(t, 'PERF-07', 'T8 round 2: a rewrite creates no new document', { ok: second.counts.documents === 2000, value: second.counts.documents, message: `${second.counts.documents} documents after the rewrite` })
    await target(t, 'PERF-07', 'T8 round 2: exactly one new version per rewritten file', { ok: second.counts.versions === 4000, value: second.counts.versions, message: `${second.counts.versions} versions (want 4000)${second.overNote ? `; ${second.overNote}` : ''}` })
    await target(t, 'PERF-07', 'T8 no duplicate evidence', { ok: first.counts.dup_evidence === 0 && second.counts.dup_evidence === 0, value: second.counts.dup_evidence, message: `duplicate evidence groups: ${first.counts.dup_evidence} / ${second.counts.dup_evidence}` })
    for (const r of [first, second]) {
      await workerRss(t, 'PERF-07', `burst round ${r.round}`, [r.metrics])
      await target(t, 'PERF-07', `T6 event-loop p99 < 100 ms (burst round ${r.round})`, { ok: Number(r.metrics.eld_p99_ms) < 100, value: Number(r.metrics.eld_p99_ms), message: `event-loop p99 ${r.metrics.eld_p99_ms} ms in burst round ${r.round}` })
      // R75: Node 22's JavaScript recursive fs.watch (Linux only; macOS uses FSEvents) re-reads the burst folders synchronously on
      // the service's main thread: in round 2 for 1.3-1.8 s, in round 1 (the new folders) for 0.2-0.4 s (Wave 3 CPU profiles);
      // with 13-23 samples per round (the 250 ms interval of Waves 3 to 5; 56-67 at the current 50 ms) the raw p95 was the one
      // sample that waited at 250 ms and is not at 50 ms. Only where that watcher runs is this a known gap.
      const gap = !JS_RECURSIVE_WATCH ? undefined : r.round === 2
        ? 'PERF-GAP-5 (Linux, R75): recursive fs.watch blocks the service in burst round 2 (corrected API p95 1.1-1.5 s in 6 runs at the 250 ms interval and 0.97 and 1.04 s in 2 runs at the 50 ms interval; the raw p95 was the maximum, 1.3-1.8 s, at 15-19 samples but only 31 ms at 20 samples, R6, and is 36-46 ms at 56-67 samples with the stall as the 1.2 s maximum; a 1.5-2.0 s main-thread block in node:internal/fs/recursive_watch; results document 4.7; macOS gate M6b)'
        : 'PERF-GAP-5 (Linux, R75): recursive fs.watch blocks the service in burst round 1 (the new folders: a 0.2-0.4 s block in node:internal/fs/recursive_watch). INTERMITTENT: the API p95 was met in 8 of 9 traceable runs and missed with 261 ms in 1 when a request met the block, so a real round-1 regression on Linux is masked by this marker until macOS gate M6b (results document 4.7)'
      // Outside the todo: an empty sample or a failed request must fail hard (13-20 answered requests at 250 ms in every Wave 3 round, 56-67 at 50 ms; no error in any).
      await apiGuards(t, 'PERF-07', `burst round ${r.round}`, r.api, { minSamples: BURST_MIN_SAMPLES })
      await apiTarget(t, 'PERF-07', `T6 API p95 < 200 ms (burst round ${r.round})`, r.api, gap)
    }
  })
})

// ================================================================================================================ PERF-08

describe('PERF-08 dirty-priority output walk of a large non-Git session folder (Task 7 ledger item)', () => {
  test('API latency and service event-loop delay: idle vs recovery-priority walk vs dirty-priority walk (back-to-back slices)', gate(), async t => {
    const phases = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-dirty-')
      const folder = join(home, 'work', 'bulk-session')
      const files = writeTree(join(folder, 'data'), { count: 50_000, perDir: 100, bytes: 64, prefix: 'r', ext: i => (i % 10 < 7 ? 'md' : 'bin') })
      const eligible = files.filter(f => f.endsWith('.md'))
      const svc = await startServiceProcess(scope, { home })
      const S = sid(8)
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const catalogued = (minVersions: number) => countOf(catalog, `SELECT COUNT(*) AS n FROM artifacts a WHERE a.path >= ? AND a.path < ? AND (SELECT COUNT(*) FROM artifact_versions v WHERE v.kind = 'working' AND v.location_artifact_id = a.artifact_id) >= ?`, `${folder}/`, `${folder}0`, minVersions)
      const phase = async (name: string, run: () => Promise<void>) => {
        const load = machineLoad()
        const api = new ApiLoad(() => svc, API_PATHS, 250).start()
        const m = await meter(svc)
        const client = clientLoop()
        const t0 = performance.now()
        await run()
        const wall = performance.now() - t0
        const metrics = await m.stop()
        const a = await api.stop()
        record('dirty-walk', { phase: name, load, wall_ms: Math.round(wall), ...apiFields('api_ms', a), api_errors: a.errors, api_error_notes: a.errorNotes, ...client.stop(), ...metrics })
        return { a, metrics }
      }
      // 1. The session starts: its folder becomes a session-directory root walked at recovery priority (1 s pause per slice).
      const recovery = await phase('recovery-priority-initial-walk', async () => {
        await runHook(scope, sessionStart(S, folder), { home, port: svc.port })
        await waitFor(() => catalogued(1) >= eligible.length, 'the initial walk', 1_800_000, 1000)
        await waitIdle(svc, 'idle after the initial walk', 600_000)
      })
      // 2. Idle baseline with the same API load (a control, not a target).
      const idle = await phase('idle', async () => { await sleep(20_000) })
      // 3. A script rewrites every document; its Bash call sends the scope hint: a dirty-priority walk, slices back to back.
      const dirty = await phase('dirty-priority-walk', async () => {
        // The rewrite runs in its own process: 35,000 synchronous writes here would block the measuring client (writeFilesInChild).
        record('dirty-walk-rewrite', { files: eligible.length, writer_ms: Math.round(await writeFilesInChild(scope, folder, eligible.map(f => [f, `rewritten ${f.length}\n`]))) })
        await runHook(scope, bashTool(S, folder, 'toolu_perf_dirty_walk'), { home, port: svc.port })
        await waitFor(() => catalogued(2) >= eligible.length, 'the dirty walk', 1_800_000, 1000)
      })
      record('dirty-walk-summary', {
        entries: 50_500, eligible: eligible.length,
        api_p95_idle: idle.a.all.p95, api_p95_recovery: recovery.a.all.p95, api_p95_dirty: dirty.a.all.p95,
        eld_p99_idle: idle.metrics.eld_p99_ms ?? null, eld_p99_recovery: recovery.metrics.eld_p99_ms ?? null, eld_p99_dirty: dirty.metrics.eld_p99_ms ?? null,
        eld_max_dirty: dirty.metrics.eld_max_ms ?? null, svc_cpu_dirty_ms: dirty.metrics.svc_cpu_ms ?? null, worker_cpu_dirty_ms: dirty.metrics.worker_cpu_ms ?? null,
      })
      return { recovery, dirty }
    })
    await responsiveness(t, 'PERF-08', 'recovery-priority initial walk', phases.recovery.a, phases.recovery.metrics, undefined, { minSamples: 150 })
    // R75: in the dirty walk Node 22's JavaScript recursive fs.watch (Linux only) re-reads the 35,000 rewritten files' folders
    // on the service's main thread: one 8.6-9.7 s block per run in Wave 3 (a request waiting through it is reset).
    await responsiveness(t, 'PERF-08', 'dirty-priority walk', phases.dirty.a, phases.dirty.metrics, JS_RECURSIVE_WATCH
      ? 'PERF-GAP-5 (Linux, R75): recursive fs.watch blocks the service in the dirty walk (an 8.6-10.1 s main-thread block in every Wave 3 run, one API request reset after 8.4-10.0 s; the raw closed-loop p95 hides it; results document 5.5; macOS gate M6b)'
      : undefined,
    // Outside the todo: 210-238 answered requests in every Wave 3 run, and on Linux exactly the one request the stall resets
    // (ECONNRESET after 8.4-10.0 s); a second failed request, a refused connection or an empty sample fails hard on every platform.
    { minSamples: 100, other: JS_RECURSIVE_WATCH ? 1 : 0 })
    await workerRss(t, 'PERF-08', 'initial and dirty walks', [phases.recovery.metrics, phases.dirty.metrics])
  })
})

// ================================================================================================================ PERF-10

describe('PERF-10 removal checker at scale (carried measurement)', () => {
  test('check-removal on 5,000 x 10 KB and on 20,000 tiny tracked documents with the default budget: exit code, wall time, memory', gate(), async t => {
    const fixtures = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-checker-')
      const fixture = (name: string, opts: { count: number; perDir: number; bytes: number }) => {
        const main = join(home, 'work', name)
        mkdirSync(main, { recursive: true })
        git(main, ['init', '-q'])
        put(join(main, 'README.md'), `# ${name}\n`)
        writeTree(join(main, 'docs'), { ...opts, prefix: 'doc-' })
        git(main, ['add', '-A'])
        git(main, ['commit', '-q', '-m', 'baseline'])
        return { main, wt: addWorktree(main, join(home, 'work', `${name}-wt`), `feat-${name}`) }
      }
      const large = fixture('large-docs', { count: 5000, perDir: 100, bytes: 10 * 1024 })
      const tiny = fixture('tiny-docs', { count: 20_000, perDir: 200, bytes: 12 })
      // The service runs (catalog plus the live-session probe the checker asks); no session works in either worktree.
      const svc = await startServiceProcess(scope, { home })
      await runHook(scope, sessionStart(sid(10), join(home, 'work')), { home, port: svc.port }).catch(() => null)
      const out: Array<{ label: string; codes: Array<number | null> }> = []
      for (const [label, wt, files] of [['5000x10KB', large.wt, 5000], ['20000-tiny', tiny.wt, 20_000]] as const) {
        const runs: Array<{ ms: number; code: number | null; exit: number | null; unknowns: string; risks: number; peakMib: number | string }> = []
        for (let i = 0; i < 3; i++) {
          const load = machineLoad()
          let pid = 0
          const sampler = new RssSampler(() => (pid ? [pid] : []), 50)
          LIVE.add(() => sampler.stop())
          const r = await runProgram(scope, process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'check-removal', '--worktree', wt, '--json'],
            { HOME: home, ATLAS_PORT: String(svc.port) }, join(home, 'work'), '', 120_000, p => { pid = p; sampler.start() })
          sampler.stop()
          let doc: { result?: { exitCode?: number; unknowns?: Array<{ code: string }>; risks?: unknown[] } } = {}
          try { doc = JSON.parse(r.out) } catch { /* not JSON */ }
          const unknowns = [...new Set((doc.result?.unknowns ?? []).map(u => u.code))].join('+') || 'none'
          runs.push({ ms: r.ms, code: r.code, exit: doc.result?.exitCode ?? null, unknowns, risks: doc.result?.risks?.length ?? -1, peakMib: HAS_PROC ? mib(sampler.peaks.get(pid) ?? 0) : 'n/a' })
          record('checker-run', { fixture: label, tracked_documents: files, run: i + 1, load, wall_ms: Math.round(r.ms), cli_exit: r.code, result_exit: doc.result?.exitCode ?? -1, unknowns, risks: runs.at(-1)!.risks, rss_peak_mib: runs.at(-1)!.peakMib })
        }
        const wall = summarize(runs.map(x => x.ms))
        record('checker', { fixture: label, tracked_documents: files, budget_ms: 8000, wall_ms_median: wall.p50, wall_ms_min: wall.min, wall_ms_max: wall.max, slack_ms_min: Math.round(8000 - wall.max), exits: runs.map(x => x.code).join('+'), unknowns: [...new Set(runs.map(x => x.unknowns))].join('|') })
        out.push({ label, codes: runs.map(x => x.code) })
      }
      return out
    })
    // No spec target: the checker must give one of its three answers (0 safe, 2 incomplete, 3 at risk), never anything else.
    for (const f of fixtures) {
      await target(t, 'PERF-10', `the checker answers 0, 2 or 3 (${f.label})`, { ok: f.codes.every(c => c === 0 || c === 2 || c === 3), value: f.codes.join('+'), message: `${f.label}: exit codes ${f.codes.join(', ')}` })
    }
  })
})

// ================================================================================================================ PERF-11

describe('PERF-11 Bash removal guard latency (carried measurement)', () => {
  test('200 unrelated and 200 relevant commands through the real guard: p50/p95', gate(), async t => {
    const outcome = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-guard-')
      // 20 tracked documents per repository (results document 5.3; the checker-at-scale fixtures are in PERF-10).
      const docs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`docs/doc-${i}.md`, `doc ${i}\n`]))
      // Repository A has an active session, so the service registers its linked worktree as a checkout root; repository B has
      // none, so its worktree is unknown to the catalog and a complete check can allow its removal.
      const mainA = makeRepo(join(home, 'work', 'proj-a'), docs)
      const wtA = addWorktree(mainA, join(home, 'work', 'proj-a-wt'), 'feat-a')
      const mainB = makeRepo(join(home, 'work', 'proj-b'), docs)
      const wtB = addWorktree(mainB, join(home, 'work', 'proj-b-wt'), 'feat-b')
      // The output root inside the registered worktree is re-walked once per recovery interval, and a check that lands in that
      // re-walk correctly answers incomplete (test/artifacts/removal-check.test.ts, "pending generation"). This test measures guard
      // latency and the DEFECT-6 fix, so the interval is pinned to its maximum to keep refreshes out of the window. Initial passes
      // still run at start: the first recovery is due at once for a root with no previous recovery.
      const svc = await startServiceProcess(scope, { home, config: { artifacts: { recoveryIntervalMs: 86_400_000 } } })
      await runHook(scope, sessionStart(sid(11), mainA), { home, port: svc.port })
      const ready = await waitIdle(svc, 'repository A and its worktree registered', 180_000, s => s.roots.some(r => r.path === mainA) && s.roots.some(r => r.path === wtA))
      record('guard-fixture', { tracked_documents_per_repo: 20, roots: ready.roots.map(r => `${r.kind}:${r.state}${r.gaps.length ? `[${r.gaps.join(',')}]` : ''}`).join('+') })
      // Diagnostic only: discovery passes started on roots at or under the target worktree while a set ran.
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const targetRootPasses = () => (catalog.prepare(`SELECT COALESCE(SUM(desired_generation), 0) AS n FROM artifact_roots
        WHERE canonical_path = ? OR substr(canonical_path, 1, length(?) + 1) = ? || '/'`).get(wtA, wtA, wtA) as { n: number }).n
      const env = { HOME: home, ATLAS_PORT: String(svc.port) }
      const guard = (command: string, cwd: string) => runProgram(scope, process.execPath, [GUARD], env, REPO_ROOT, JSON.stringify({
        session_id: sid(11), transcript_path: '/t/session.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'perf' },
      }), 60_000)
      const unrelated = ['ls -la', 'npm test', 'git status', 'echo done > /dev/null', 'cat README.md']
      const sets = [
        { label: 'unrelated', n: 200, cwd: mainA, command: (i: number) => unrelated[i % unrelated.length]! },
        { label: 'relevant-unregistered-worktree', n: 200, cwd: mainB, command: () => `git worktree remove ${wtB}` },
        { label: 'relevant-registered-worktree', n: 50, cwd: mainA, command: () => `git worktree remove ${wtA}` },
      ]
      const out: Record<string, { n: number; codes: Record<string, number>; passes: number }> = {}
      for (const set of sets) {
        const load = machineLoad()
        const passesBefore = targetRootPasses()
        const times: number[] = []
        const codes: Record<string, number> = {}
        for (let i = 0; i < set.n; i++) {
          const r = await guard(set.command(i), set.cwd)
          times.push(r.ms)
          const reason = r.code === 0 ? 'allowed' : (/blocked this command \[([a-z-]+)\]/.exec(r.err)?.[1] ?? `exit-${r.code}`)
          const detail = /\[(catalog-[a-z-]+|filter-[a-z-]+|[a-z-]+-unverified)\]/.exec(r.err)?.[1]
          const key = detail ? `${reason}:${detail}` : reason
          codes[key] = (codes[key] ?? 0) + 1
        }
        const passes = targetRootPasses() - passesBefore
        out[set.label] = { n: set.n, codes, passes }
        record('guard-latency', { commands: set.label, load, ...flat('wall_ms', summarize(times)), outcomes: Object.entries(codes).map(([k, v]) => `${k}:${v}`).join('+'), target_root_passes: passes })
      }
      return out
    })
    const allowed = (label: string, what: string) => {
      const o = outcome[label]!
      return target(t, 'PERF-11', what, { ok: o.codes['allowed'] === o.n, value: `${o.codes['allowed'] ?? 0}/${o.n}`, message: `${label}: ${JSON.stringify(o.codes)} (target_root_passes ${o.passes})` })
    }
    await allowed('unrelated', 'unrelated commands always pass through (200/200)')
    await allowed('relevant-unregistered-worktree', 'a clean, retained worktree the catalog does not cover is allowed after a complete check (200/200)')
    // DEFECT-6 is fixed: with git-lfs configured, a clean registered worktree's checkout root completes and its removal is allowed.
    await allowed('relevant-registered-worktree', 'a clean, retained REGISTERED worktree is allowed after a complete check (50/50)')
  })
})

// ================================================================================================================ PERF-12

/**
 * R63 retention check. `baseline` is the service's live Buffer/ArrayBuffer bytes after a collection before the first export,
 * `after` the same reading after a collection following each export. A copy of the blob that Atlas keeps (one per export, or one
 * cached copy) leaves at least one blob of live bytes; allocator caching and not-yet-collected garbage do not survive the
 * collection. The bound is half a blob, so any retained copy of the whole blob fails and a few MiB of ordinary buffers pass.
 */
function liveBufferCheck(baseline: number, after: number[], blobBytes: number, collected: boolean): Check {
  const growth = after.map(x => x - baseline)
  const worst = Math.max(...growth)
  const bound = blobBytes / 2
  return {
    ok: collected && after.length > 0 && worst < bound, value: Math.round((worst / MiB) * 10) / 10,
    message: collected
      ? `live buffer growth after a collection following each export: ${growth.map(x => (x / MiB).toFixed(1)).join(' -> ')} MiB (bound < ${bound / MiB} MiB, half a blob; a retained copy holds ${blobBytes / MiB} MiB)`
      : 'the service did not collect before the live buffer reading (it must run with --expose-gc)',
  }
}

describe('PERF-12 export of a large Git blob (64 MiB)', () => {
  test('time and service memory for exporting a 64 MiB committed document (R63: one bounded buffer per export)', gate(), async t => {
    const SIZE = 64 * MiB
    const live = { baseline: 0, after: [] as number[], collected: [] as boolean[] }
    const results = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-export-')
      const content = randomBytes((SIZE / 4) * 3).toString('base64')
      assert.equal(content.length, SIZE)
      const repo = makeRepo(join(home, 'work', 'proj'), { 'README.md': '# proj\n', 'data/big.csv': content })
      // --expose-gc for this service only: the probe collects before it reads the live buffer bytes (see liveBufferCheck).
      const svc = await startServiceProcess(scope, { home, nodeArgs: ['--expose-gc'] })
      await runHook(scope, sessionStart(sid(12), repo), { home, port: svc.port })
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const versionId = () => (catalog.prepare(`SELECT v.version_id AS id FROM artifact_versions v JOIN artifact_documents d ON d.document_id = v.document_id
        WHERE d.relative_path = 'data/big.csv' AND v.kind = 'commit'`).get() as { id: string } | undefined)?.id ?? null
      await waitFor(() => versionId() !== null, 'the committed 64 MiB document imported from history', 300_000, 250)
      await waitIdle(svc, 'idle', 300_000)
      const dir = await runProgram(scope, process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'output-dir', '--repo', repo, '--create'],
        { HOME: home, ATLAS_PORT: String(svc.port) }, repo)
      assert.equal(dir.code, 0, dir.err)
      const out: Array<Record<string, number | string>> = []
      const baselineLive = await svc.probe(false, true)
      assert.ok(baselineLive.gcRan, 'the service was started with --expose-gc and the probe collected')
      live.baseline = baselineLive.arrayBuffersBytes
      for (let i = 0; i < 3; i++) {
        const load = machineLoad()
        // Portable memory numbers come from the probe inside the service (process.memoryUsage.rss every 50 ms); on Linux the
        // kernel's peak counter (VmHWM, reset first) and 5 ms /proc sampling catch shorter peaks as well.
        const hwmReset = HAS_PROC ? resetPeakRss(svc.pid) : false
        const before = (await svc.probe(true)).rssBytes
        const sampler = new RssSampler(() => [svc.pid], 5).start()
        LIVE.add(() => sampler.stop())
        const r = await svc.api('POST', `/api/artifact-versions/${versionId()}/export`)
        sampler.stop()
        const probe = await svc.probe(false)
        const proc = procSample(svc.pid)
        const peak = Math.max(sampler.peaks.get(svc.pid) ?? 0, probe.peakRssBytes, proc?.hwmBytes ?? 0)
        const exported = r.status === 201 ? statSync(r.json.path as string).size : -1
        out.push({
          run: i + 1, load, hwm_reset: hwmReset ? 1 : 0, status: r.status, wall_ms: Math.round(r.ms), exported_bytes: exported, rss_before_mib: mib(before), rss_peak_mib: mib(peak),
          rss_delta_mib: mib(peak - before), rss_after_mib: mib(probe.rssBytes), hwm_mib: proc ? mib(proc.hwmBytes) : 'n/a', eld_max_ms: probe.maxMs, eld_p99_ms: probe.p99Ms,
          svc_cpu_ms: probe.cpuUserMs + probe.cpuSystemMs,
        })
        record('export-64mib', out.at(-1)!)
        if (r.status === 201) rmSync(r.json.path as string)
        // After the peak is read: collect in the service, then read what it still holds in Buffers and ArrayBuffers.
        const settled = await svc.probe(false, true)
        live.after.push(settled.arrayBuffersBytes)
        live.collected.push(settled.gcRan)
        out.at(-1)!.live_buffers_mib = mib(settled.arrayBuffersBytes)
        out.at(-1)!.live_buffers_growth_mib = mib(settled.arrayBuffersBytes - live.baseline)
        record('export-64mib-live', { run: i + 1, baseline_mib: mib(live.baseline), live_buffers_mib: mib(settled.arrayBuffersBytes), external_mib: mib(settled.externalBytes), rss_after_gc_mib: mib(settled.rssBytes) })
      }
      return out
    })
    const blobMib = SIZE / MiB
    await target(t, 'PERF-12', 'every export answers 201 with exactly the blob\'s bytes', {
      ok: results.every(x => x.status === 201 && x.exported_bytes === SIZE), value: results.map(x => `${x.status}:${x.exported_bytes}`).join('+'),
      message: `exports: ${results.map(x => `${x.status}/${x.exported_bytes} bytes`).join(', ')}`,
    })
    // R63: the explicit capped export holds one bounded buffer of the blob; the first export may grow the service by at most
    // about 2.1x the blob (13b measured 1.95x before the Wave 2a fix), and repeated exports must not keep growing it.
    const first = Number(results[0]!.rss_delta_mib)
    await target(t, 'PERF-12', 'T7b (R63) the first export grows the service by at most 2.1x the blob', {
      ok: first <= 2.1 * blobMib, value: first, message: `the first export grew the service by ${first} MiB (bound ${2.1 * blobMib} MiB = 2.1 x ${blobMib} MiB)`,
    })
    // The RSS peaks stay in the PERF lines. They cannot tell a retained copy from memory the allocator keeps after a large free
    // (macOS keeps recently freed large blocks: 157.8 -> 222.4 -> 222.6 MiB with nothing retained) or from a buffer not yet
    // collected, so the retention check reads the service's live Buffer bytes after a forced collection.
    const check = liveBufferCheck(live.baseline, live.after, SIZE, live.collected.every(Boolean) && live.collected.length === 3)
    await target(t, 'PERF-12', 'T7b (R63) repeated exports do not keep growing the service (a retained copy holds a blob of live buffers after each export)', check)
  })
})

// ================================================================================================================ PERF-13

describe('PERF-13 hook latency while the service loop commits a backfill', () => {
  test('hooks are delivered or spooled within the 500 ms cap while a 100,000-entry cold walk commits on the service loop', gate(), async t => {
    const r = await withScope(async scope => {
      const home = scope.scratch('atlas-perf-hookload-')
      const big = join(home, 'data', 'big')
      // The PERF-06 root: 100,000 files in 1,000 folders, 60,000 eligible documents, walked cold at recovery priority.
      writeTree(big, { count: 100_000, perDir: 100, bytes: 64, prefix: 'f', ext: i => (i % 5 < 3 ? 'md' : i % 5 === 3 ? 'png' : 'ts') })
      const main = makeRepo(join(home, 'work', 'proj'))
      const hookTarget = put(join(main, 'notes', 'hook-target.md'), 'target\n')
      const svc = await startServiceProcess(scope, { home, config: { artifacts: { outputRoots: [{ path: big, label: 'big' }] } } })
      const S = sid(13)
      await runHook(scope, sessionStart(S, main), { home, port: svc.port })
      const catalog = openCatalogReadOnly(svc.dbPath)
      scope.onCleanup(() => catalog.close())
      const walking = () => (catalog.prepare('SELECT last_successful_at AS done FROM artifact_roots WHERE canonical_path = ?').get(big) as { done: string | null } | undefined)?.done == null
      const committed = () => countOf(catalog, `SELECT COUNT(*) AS n FROM artifacts WHERE path >= ? AND path < ? AND current_version_id IS NOT NULL`, `${big}/`, `${big}0`)
      await waitFor(() => committed() >= 2_000, 'the cold walk committing rows', 300_000, 250)
      // The same UI load as PERF-06, and one hook every 250 ms (a busy session) while the walk commits.
      const api = new ApiLoad(() => svc, API_PATHS, 250).start()
      const m = await meter(svc)
      const client = clientLoop()
      const N = 200
      const GAP_MS = 250
      const hooks: Array<Awaited<ReturnType<typeof runHook>>> = []
      let duringWalk = 0
      const start = performance.now()
      for (let i = 0; i < N; i++) {
        const wait = start + i * GAP_MS - performance.now()
        if (wait > 0) await sleep(wait)
        const before = walking()
        const h = await runHook(scope, writeTool(S, main, hookTarget, `toolu_perf_hookload_${i}`, 'update'), { home, port: svc.port })
        if (before && walking()) duringWalk++
        hooks.push(h)
      }
      const metrics = await m.stop()
      const clientStats = client.stop()
      const apiStats = await api.stop()
      const wall = summarize(hooks.map(h => h.wallMs))
      const inner = summarize(hooks.map(h => h.atMs))
      const outcomes: Record<string, number> = {}
      for (const h of hooks) outcomes[h.outcome] = (outcomes[h.outcome] ?? 0) + 1
      const spooled = (() => { try { return readdirSync(join(home, '.josh-360', 'atlas', 'spool')).length } catch { return 0 } })()
      record('hook-latency-under-backfill', {
        n: N, gap_ms: GAP_MS, during_walk: duringWalk, load: machineLoad(), ...flat('wall_ms', wall), ...flat('inprocess_ms', inner),
        outcomes: Object.entries(outcomes).map(([k, v]) => `${k}:${v}`).join('+'), spool_files: spooled, over_200_wall: hooks.filter(h => h.wallMs >= 200).length,
        over_500_wall: hooks.filter(h => h.wallMs > 500).length, ...flat('api_ms', apiStats.all), api_errors: apiStats.errors, ...metrics, ...clientStats,
      })
      // The measurement is only meaningful while the walk commits: most hooks must have run during it.
      assert.ok(duringWalk >= N * 0.75, `only ${duringWalk} of ${N} hooks ran while the cold walk was committing: the load ended too early`)
      return { N, wall, inner, outcomes }
    })
    const h: HookSet = { label: 'during a cold-walk commit load', wall: r.wall, inner: r.inner, outcomes: r.outcomes, spooled: 0 }
    await hookCap(t, 'PERF-13', h)
    await target(t, 'PERF-13', 'every hook delivered or spooled (none dropped or failed)', {
      ok: (r.outcomes['delivered'] ?? 0) + (r.outcomes['spooled'] ?? 0) === r.N, value: JSON.stringify(r.outcomes), message: `outcomes ${JSON.stringify(r.outcomes)}`,
    })
  })
})

// ================================================================================================================ guard self-check

// Runs without ATLAS_PERF (it measures nothing): the hard API guards must reject exactly what they exist for.
// Runs without ATLAS_PERF: a real process with the probe preloaded retains a 64 MiB buffer on request, as a retained export
// copy would, and the PERF-12 live-buffer check must fail for it and pass for the same allocation once it is dropped.
describe('PERF-12 live buffer check (self-check, always runs)', () => {
  const RETAINER = `const keep = []; let junk = null
process.on('message', m => {
  if (m.type === 'perf-snapshot') return
  if (m.type === 'retain') keep.push(Buffer.alloc(m.bytes, 1))
  if (m.type === 'cache-once') { if (keep.length === 0) keep.push(Buffer.alloc(m.bytes, 1)) }
  if (m.type === 'churn') { junk = Buffer.alloc(m.bytes, 2); junk = null }
  process.send({ type: 'done', id: m.id })
})
setInterval(() => {}, 1000)`
  const start = (gc: boolean) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...(gc ? ['--expose-gc'] : []), '--import', PROBE, '-e', RETAINER], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    let id = 1
    const waiters = new Map<number, (m: any) => void>()
    child.on('message', (m: any) => { if (m?.type === 'done' || m?.type === 'perf-snapshot') { waiters.get(m.id)?.(m); waiters.delete(m.id) } })
    const ask = (msg: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      const n = id++
      const timer = setTimeout(() => reject(new Error('child did not answer')), 20_000)
      waiters.set(n, m => { clearTimeout(timer); resolve(m) })
      child.send({ ...msg, id: n })
    })
    return { ask, snapshot: async () => (await ask({ type: 'perf-snapshot', gc: true })).stats as ProbeStats, stop: () => child.kill('SIGKILL') }
  }
  const BLOB = 64 * MiB
  const run = async (action: 'retain' | 'cache-once' | 'churn') => {
    const c = start(true)
    try {
      const base = await c.snapshot()
      const after: number[] = []
      let collected = base.gcRan
      for (let i = 0; i < 3; i++) {
        await c.ask({ type: action, bytes: BLOB })
        const s = await c.snapshot()
        after.push(s.arrayBuffersBytes)
        collected &&= s.gcRan
      }
      return liveBufferCheck(base.arrayBuffersBytes, after, BLOB, collected)
    } finally { c.stop() }
  }
  test('a copy retained per export and a single cached copy fail; freed buffers of the same size pass', async () => {
    const perExport = await run('retain')
    assert.ok(!perExport.ok, `a 64 MiB buffer retained per export must fail: ${perExport.message}`)
    const cached = await run('cache-once')
    assert.ok(!cached.ok, `one cached 64 MiB copy must fail: ${cached.message}`)
    const freed = await run('churn')
    assert.ok(freed.ok, `a 64 MiB buffer allocated and dropped per export must pass: ${freed.message}`)
  })
  test('a process that did not collect cannot pass', async () => {
    const c = start(false)
    try {
      const s = await c.snapshot()
      assert.equal(s.gcRan, false, 'without --expose-gc the probe reports that it did not collect')
      assert.ok(!liveBufferCheck(s.arrayBuffersBytes, [s.arrayBuffersBytes], BLOB, s.gcRan).ok)
    } finally { c.stop() }
  })
})

describe('API window guards (self-check, always runs)', () => {
  const stats = (n: number, errors: number, refused: number): ApiStats => {
    const answered = Array.from({ length: n }, () => 20)
    return { all: summarize(answered), corrected: summarize(answered), byPath: {}, errors, refused, stalledErrors: 0, errorNotes: 'none' }
  }
  test('an empty sample, a dead service or an unexpected failed request fails; the expected ones pass', () => {
    const burst = { minSamples: 10 }
    const healthy = apiGuardChecks('burst', stats(13, 0, 0), burst)
    assert.ok(healthy.sample.ok && healthy.failures.ok, 'a healthy window of 13 answered requests passes')
    const empty = apiGuardChecks('burst', stats(0, 0, 0), burst)
    assert.ok(!empty.sample.ok, 'an empty sample (NaN p95) fails the sample guard')
    const dead = apiGuardChecks('burst', stats(2, 14, 14), burst)
    assert.ok(!dead.sample.ok && !dead.failures.ok, 'a service that stopped answering fails both guards')
    assert.ok(!apiGuardChecks('burst', stats(13, 1, 0), burst).failures.ok, 'one reset request fails where none is expected')
    const walk = { minSamples: 150, refused: 6 }
    assert.ok(apiGuardChecks('walk', stats(330, 4, 4), walk).failures.ok, 'refusals inside the restart gap pass')
    assert.ok(!apiGuardChecks('walk', stats(330, 7, 7), walk).failures.ok, 'more refusals than the restart gap explains fail')
    assert.ok(!apiGuardChecks('walk', stats(330, 4, 3), walk).failures.ok, 'a failure that was not a refused connection fails')
    const dirty = { minSamples: 100, other: 1 }
    assert.ok(apiGuardChecks('dirty', stats(235, 1, 0), dirty).failures.ok, 'the one request the Linux stall resets passes')
    assert.ok(!apiGuardChecks('dirty', stats(235, 2, 0), dirty).failures.ok, 'a second failed request fails')
    assert.ok(!apiGuardChecks('dirty', stats(235, 1, 1), dirty).failures.ok, 'a refused connection fails where only a reset is expected')
  })
  test('the extra-version classifier tells the four kinds apart', () => {
    const base = { ino: '7', size: 15, mtimeMs: 1000, ctimeMs: 1000 }
    assert.equal(classifyVersion(base, { ino: '7', size: 0, mtimeMs: 1001, ctimeMs: 1001 }), 'EMPTY')
    assert.equal(classifyVersion(base, { ino: '7', size: 15, mtimeMs: 1000, ctimeMs: 1005 }), 'CTIME-ONLY')
    assert.equal(classifyVersion(base, { ino: '7', size: 15, mtimeMs: 1002, ctimeMs: 1002 }), 'SAME-SIZE-NEW-MTIME')
    assert.equal(classifyVersion(base, { ino: '7', size: 20, mtimeMs: 1002, ctimeMs: 1002 }), 'OTHER')
    assert.equal(classifyVersion(base, { ino: '8', size: 15, mtimeMs: 1000, ctimeMs: 1005 }), 'OTHER', 'another inode is not a metadata touch')
    assert.equal(classifyVersion(null, base), 'OTHER')
    const empty = { ino: '7', size: 0, mtimeMs: 1001, ctimeMs: 1001 }
    const last = { ino: '7', size: 15, mtimeMs: 1002, ctimeMs: 1002 }
    assert.equal(classifyExtra([base, empty, last], 1), 'EMPTY', 'old, empty, final')
    assert.equal(classifyExtra([base, { ...base, ctimeMs: 1005 }, last], 1), 'CTIME-ONLY')
    assert.equal(classifyExtra([base, { ...base, mtimeMs: 1002, ctimeMs: 1002 }, { ...base, mtimeMs: 1003, ctimeMs: 1003 }], 1), 'SAME-SIZE-NEW-MTIME')
    assert.equal(classifyExtra([base, { ...base, size: 9, mtimeMs: 1002 }, last], 1), 'OTHER')
  })
  test('the over-count summary names the count, the kinds and the first file', () => {
    assert.equal(overSummary([]), '')
    assert.equal(overSummary([{ index: 123, kind: 'EMPTY', sizes: [15, 0, 15] }, { index: 9, kind: 'EMPTY', sizes: [15, 0, 15] }, { index: 5, kind: 'OTHER', sizes: [15, 15, 15] }]),
      '3 files over: 2 EMPTY, 1 OTHER; first: i=123 sizes 15->0->15')
  })
  test('the burst request interval answers the guard minimum twice over in the shortest round seen (1,053 ms on macOS)', () => {
    assert.ok(Math.floor(1_053 / BURST_API_EVERY_MS) >= 2 * BURST_MIN_SAMPLES, `${BURST_API_EVERY_MS} ms gives ${Math.floor(1_053 / BURST_API_EVERY_MS)} requests in 1,053 ms`)
    assert.ok(Math.floor(1_053 / 250) < BURST_MIN_SAMPLES, 'the former 250 ms interval could not reach the minimum in that round')
  })
})
