// Acceptance scenarios AC-01 .. AC-16 for the Artifact Manager (spec section 16; plan 2026-10-26 Task 13a).
//
// Each `describe` is one acceptance ID. The scenarios cross component boundaries end to end with REAL components: the hook
// script (hooks/atlas-hook.js) spawned exactly as Claude Code runs it and posting to a real createAtlasServer; the real
// catalog (openDatabase, migrations included); the service runner (artifactManagerRunner) driving the REAL discovery worker
// child process; the HTTP routes; the `npm run artifacts` CLI, the standalone removal checker and the Bash removal guard
// spawned as programs. A fake worker is used only where a scenario needs frames a real worker never sends (AC-13).
//
// What the harness wires, compared with src/service/main.ts:
//   wired      createAtlasServer with the event, session and artifact routes; artifactManagerRunner with its worker; the
//              known-location verify runner (verifyRunner, production interval, ticked with the runner; a scenario that
//              depends on verification ticks it with interval 0); the spool runner where a scenario replays the spool (AC-11).
//   NOT wired  the file watcher (fs.watch hints are replaced by explicit runner.markDirty() calls, so a scenario never waits
//              for, or races, a 2 s debounce); the legacy artifactRunner (it only confirms legacy `created_path`
//              candidates; the new pipeline's compatibility projection is asserted instead); the transcript, focus, prune,
//              enumerator and cost runners; the dashboard and action routes; launchd.
//
// Fixtures are disposable: every HOME, repository, catalog and output folder is a fresh temporary directory, the real
// ~/.claude is never read or written, and every server, runner, worker and child process of a test is stopped, and its
// directories removed, when that test ends (afterEach).
//
// Deliberate harness choices, each stated where it is used:
//   - Process-wide Git neutralisation. This test process runs with GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL=/dev/null, so
//     every IN-PROCESS Git user (the fixture commands and the removal checker called in-process in AC-04, AC-09 and AC-12)
//     sees no system or global configuration. What that hides: this container's /etc/gitconfig configures git-lfs. Until
//     Defect Wave 1 a filter driver merely configured made the checker report a modified tracked document as an
//     `filter-unverified` unknown (exit 2) instead of an `unpreserved-working` risk (exit 3); the checker-side DEFECT-6 test in
//     AC-12 runs the checker through the spawned CLI with a filter driver in the fixture HOME's gitconfig.
//     Programs spawned with a minimal environment (CLI, guard, hook) do see the host's system configuration.
//   - The "hermetic" worker is the real worker child process, spawned through the client's own `spawn` seam with
//     GIT_CONFIG_NOSYSTEM=1 added to its environment. Before Defect Wave 1 every checkout scan in this container was partial
//     without it (the worker side of DEFECT-6, verified in AC-12's FINAL-WAVE test with a filter configured only in the
//     fixture HOME).
//   - The runner's 30 s status-start floor is set to 0 so consecutive checkout passes are not delayed by wall time; the
//     floor itself is covered by test/service/artifact-manager-runner.test.ts.
//   - backgroundPauseMs: 0 (the 1 s pause after a background slice, covered by the runner tests, would only add wall time)
//     and frameWaitMs: 25 (each runner tick waits at most 25 ms for the worker's next frame instead of 200 ms, so the loop
//     interleaves HTTP and child I/O promptly). The runner's clock is injectable (`svc.offsetMs`) for downtime, lookback,
//     retry backoff and the 10-minute full reconciliation; hook event times stay real.
//
// Production defects found here are recorded as `todo: 'DEFECT-<n>: ...'` tests (ruling R62) and listed in
// .superpowers/sdd/2026-10-26-artifact-manager/task-13a-report.md ("Defects for owners").

import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig, type AtlasConfig } from '../../src/config.ts'
import { migrate, openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { addOrigin, artifactPathsForSession, artifactsForSession, findArtifactByPath, upsertArtifact } from '../../src/db/artifacts.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import {
  ARTIFACT_JOB_PRIORITY, enqueueArtifactJob, findArtifactDocumentStateDrift, getArtifactManagerStatus, listArtifactRoots, registerArtifactRepository, registerArtifactRoot, type ArtifactRootRow,
} from '../../src/db/artifact-manager.ts'
import type { ArtifactWorkerFrame, ArtifactWorkerRequest } from '../../src/artifacts/contracts.ts'
import { checkWorktreeRemoval, type RemovalCheckResult } from '../../src/artifacts/removal-check.ts'
import { createAtlasServer } from '../../src/server/http.ts'
import { registerSessionRoutes } from '../../src/server/api-sessions.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { createArtifactWorkerClient, type ArtifactWorkerClient, type ArtifactWorkerClientStatus, type ArtifactWorkerEvent } from '../../src/service/artifact-worker.ts'
import { artifactManagerRunner, readArtifactManagerState, type ArtifactManagerRunner } from '../../src/service/artifact-manager-runner.ts'
import type { Runner } from '../../src/service/runners.ts'
import { silentLogger } from '../helpers/log.ts'

// ================================================================================================================ environment

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GUARD = join(REPO_ROOT, 'hooks', 'atlas-removal-guard.js')
const CLI = join(REPO_ROOT, 'src', 'cli', 'artifacts.ts')
const PATH_ENV = process.env.PATH ?? '/usr/bin:/bin'

// Nothing from the real environment reaches a fixture: no inherited Git or Atlas variables, no system or global Git config.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') || key.startsWith('ATLAS_')) delete process.env[key]
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
delete process.env.XDG_CONFIG_HOME
const ORIGINAL_HOME = process.env.HOME

// Cleanup order: runners/workers/servers first (they hold processes and sockets), then child processes, then directories.
// It runs after EVERY test (a top-level afterEach applies to the tests of every describe), so at most one test's services
// are alive at a time, and once more after the file.
const TEMP: string[] = []
const STOPPERS: Array<() => void | Promise<void>> = []
const CHILDREN = new Set<ChildProcess>()
async function cleanup(): Promise<void> {
  for (const s of STOPPERS.splice(0).reverse()) { try { await s() } catch { /* already stopped */ } }
  for (const c of CHILDREN) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  CHILDREN.clear()
  for (const d of TEMP.splice(0)) {
    // A scenario may leave an unreadable folder behind on failure: restore access before removing.
    try { execFileSync('chmod', ['-R', 'u+rwx', d], { stdio: 'ignore' }) } catch { /* best effort */ }
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
}
afterEach(cleanup)
after(cleanup)
process.on('exit', () => {
  for (const c of CHILDREN) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  for (const d of TEMP) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
})

function scratch(prefix: string, base: string = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(join(base, prefix)))
  TEMP.push(dir)
  return dir
}
const newHome = (): string => scratch('atlas-acc-home-')
/**
 * A home under a short base path, removed by the same per-test cleanup. For a scenario that sets a very small Git output cap,
 * which also applies to the runner's own `worktree list` (about 110 bytes per worktree plus its path, twice): a long temporary
 * directory (a long TMPDIR, or macOS's /private/var/folders/xx/<32 characters>/T/) would push that listing over the cap.
 */
const shortHome = (): string => scratch('a-', existsSync('/tmp') ? '/tmp' : tmpdir())

const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false']
function gitBuf(cwd: string, args: string[], env: Record<string, string> = {}): Buffer {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
}
const git = (cwd: string, args: string[], env: Record<string, string> = {}): string => gitBuf(cwd, args, env).toString('utf8').trim()

function put(path: string, content: string | Buffer = 'x\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** A repository at `dir` with README.md committed on `main`. Returns its real path. */
function makeRepo(dir: string, files: Record<string, string> = { 'README.md': '# readme\n' }): string {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  for (const [rel, content] of Object.entries(files)) put(join(dir, rel), content)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'baseline'])
  return realpathSync(dir)
}
function commitAll(repo: string, message: string, env: Record<string, string> = {}): string {
  git(repo, ['add', '-A'], env)
  git(repo, ['commit', '-q', '-m', message], env)
  return git(repo, ['rev-parse', 'HEAD'])
}
function addWorktree(repo: string, dir: string, branch: string): string {
  git(repo, ['worktree', 'add', '-q', '-b', branch, dir])
  return realpathSync(dir)
}

const sid = (n: number): string => `${String(n).padStart(8, '0')}-6e70-4357-9e2f-a4ef9a4f33db`
const iso = (ms: number): string => new Date(ms).toISOString()
const DAY = 86_400_000
const rows = <T = Record<string, unknown>>(db: AtlasDb, sql: string, ...p: Array<string | number | null>): T[] => db.raw.prepare(sql).all(...p).map(r => ({ ...r }) as T)
const one = <T = Record<string, unknown>>(db: AtlasDb, sql: string, ...p: Array<string | number | null>): T | undefined => {
  const r = db.raw.prepare(sql).get(...p)
  return r === undefined ? undefined : ({ ...r } as T)
}
const count = (db: AtlasDb, sql: string, ...p: Array<string | number | null>): number => (db.raw.prepare(sql).get(...p) as { n: number }).n

// ================================================================================================================ the worker

/**
 * The real worker child process with its Git system configuration excluded (see the header). `extraEnv` is added to the
 * environment the client builds; nothing else about the launch changes.
 */
function hermeticWorker(home: string, extraEnv: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1' }): ArtifactWorkerClient {
  return createArtifactWorkerClient({
    log: silentLogger, home,
    spawn: (command: string, args: string[], options: SpawnOptions) => nodeSpawn(command, args, { ...options, env: { ...(options.env ?? {}), ...extraEnv } }),
  })
}

/** A scripted worker for the crash and hang scenarios only (same shape as the runner tests' fake). */
class ScriptedWorker implements ArtifactWorkerClient {
  requests: ArtifactWorkerRequest[] = []
  acks: string[] = []
  restarts: string[] = []
  events: ArtifactWorkerEvent[] = []
  pending: ArtifactWorkerFrame[] = []
  script: (req: ArtifactWorkerRequest, n: number) => ArtifactWorkerFrame[] = req => [{ type: 'batch', jobId: req.jobId, rows: [], cursor: null, complete: true, coverage: 'complete', counts: { visited: 0, eligible: 0, skipped: 0 } }]
  onAck: ((index: number) => 'crash' | void) | null = null
  start(req: ArtifactWorkerRequest): void { this.requests.push(structuredClone(req)); this.pending = this.script(req, this.requests.length); this.deliver() }
  private deliver(): void { const f = this.pending.shift(); if (f) this.events.push({ type: 'frame', frame: f }) }
  poll(): ArtifactWorkerEvent | null { return this.events.shift() ?? null }
  async wait(): Promise<void> {}
  ack(jobId: string): void {
    this.acks.push(jobId)
    if (this.onAck?.(this.acks.length) === 'crash') { this.pending = []; this.events.push({ type: 'exit', reason: 'signal-SIGKILL' }); return }
    this.deliver()
  }
  restart(reason: string): void { this.restarts.push(reason); this.pending = []; this.events = [] }
  stop(): void {}
  status(): ArtifactWorkerClientStatus {
    return { running: true, pid: null, activeJobId: null, priorityFacility: 'applied', priorityCommand: 'test', liveGroups: [], spawns: 0, crashes: 0, gitChildrenSeen: 0 }
  }
}

// ================================================================================================================ the service

type Svc = {
  home: string
  db: AtlasDb
  config: AtlasConfig
  port: number
  base: string
  runner: ArtifactManagerRunner
  /** The known-location verify runner, constructed as src/service/main.ts constructs it (ticked by until()). */
  worker: ArtifactWorkerClient
  /** Added to Date.now() by the runner's clock (time travel for downtime scenarios). */
  offsetMs: number
  revealed: string[]
  opened: string[]
  close(): Promise<void>
}

type SvcOptions = {
  home?: string
  autoSchedule?: boolean
  worker?: ArtifactWorkerClient
  workerEnv?: Record<string, string>
  configure?: (config: AtlasConfig) => void
  frameWaitMs?: number
  /** Verify runner interval; default: the production default (it runs on the first tick, then every 10 minutes). */
  verifyIntervalMs?: number
}

/** The service as src/service/main.ts wires it, minus what the file header lists as not wired. */
async function startService(opts: SvcOptions = {}): Promise<Svc> {
  const home = opts.home ?? newHome()
  // Hook observations authorize against os.homedir(), the HOME the service runs with.
  process.env.HOME = home
  const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
  config.artifacts.statusMinIntervalMs = 0
  opts.configure?.(config)
  const db = openDatabase(config.dbPath)
  const atlas = createAtlasServer({ db, config: { ...config, port: 0 }, log: silentLogger })
  const revealed: string[] = []
  const opened: string[] = []
  registerSessionRoutes(atlas.router, { db, log: silentLogger })
  registerArtifactRoutes(atlas.router, { db, log: silentLogger, home, config, reveal: async p => { revealed.push(p) }, openWith: async p => { opened.push(p) } })
  const port = await atlas.listen()
  const worker = opts.worker ?? hermeticWorker(home, opts.workerEnv)
  const svc: Svc = {
    home, db, config, port, base: `http://127.0.0.1:${port}`, worker, offsetMs: 0, revealed, opened,
    runner: null as unknown as ArtifactManagerRunner,
    close: async () => {
      svc.runner.stop?.()
      atlas.server.closeAllConnections()
      await atlas.close().catch(() => {})
      try { db.close() } catch { /* closed */ }
    },
  }
  svc.runner = artifactManagerRunner({
    db, config, log: silentLogger, worker, home, clock: () => Date.now() + svc.offsetMs, autoSchedule: opts.autoSchedule ?? true,
    backgroundPauseMs: 0, frameWaitMs: opts.frameWaitMs ?? 25,
  })
  let closed = false
  STOPPERS.push(async () => { if (!closed) { closed = true; await svc.close() } })
  return svc
}

/** One service-loop pass over the wired runners, in main.ts's order (the artifact manager, then verification). */
async function tick(svc: Svc): Promise<boolean> {
  const busy = await svc.runner.run()
  await svc.runner.settle()
  return busy
}

/** Runs the service loop (runner ticks, letting HTTP and child I/O through) until `done`, or fails with `label`. */
async function until(svc: Svc, done: () => boolean, label: string, ms = 30_000): Promise<number> {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > ms) throw new Error(`timed out after ${ms} ms waiting for: ${label}`)
    const busy = await tick(svc)
    if (!busy) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return Date.now() - started
}
const pending = (svc: Svc): number => getArtifactManagerStatus(svc.db, iso(Date.now() + svc.offsetMs)).pendingJobs
/**
 * A few ticks first (so a due root reconciliation is planned, applied and its recovery scheduled), then until no job is
 * queued, running or waiting for a retry.
 */
async function idle(svc: Svc, label: string, ms?: number): Promise<number> {
  for (let i = 0; i < 3; i++) await tick(svc)
  return until(svc, () => pending(svc) === 0, label, ms)
}

type Json = Record<string, any>
async function api(svc: Svc, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json; text: string; headers: Headers }> {
  const res = await fetch(`${svc.base}${path}`, {
    method, headers: { ...(body !== undefined || method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : method === 'POST' ? { body: '{}' } : {}),
  })
  const text = await res.text()
  let json: Json = {}
  try { json = JSON.parse(text) as Json } catch { /* not JSON (a preview body) */ }
  return { status: res.status, json, text, headers: res.headers }
}

/** A session now arrives from the ledger mirror, not a hook: only a SessionStart payload is honoured, by writing the session row the mirror would. */
async function hook(svc: Svc, payload: Record<string, unknown>): Promise<{ outcome: string }> {
  if (payload.hook_event_name !== 'SessionStart') return { outcome: 'not-delivered' }
  const ts = new Date().toISOString()
  ensureSession(svc.db, { sessionId: String(payload.session_id), cwd: String(payload.cwd), startedAt: ts, now: ts })
  return { outcome: 'delivered' }
}

const sessionStart = (session: string, cwd: string) => ({ hook_event_name: 'SessionStart', session_id: session, cwd, source: 'startup' })
const writeTool = (session: string, cwd: string, path: string, toolUseId: string, type: 'create' | 'update') => ({
  hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: 'Write', tool_use_id: toolUseId,
  tool_input: { file_path: path, content: 'never forwarded' }, tool_response: { type, filePath: path, content: 'never forwarded' },
})
const editTool = (session: string, cwd: string, path: string, toolUseId: string) => ({
  hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: 'Edit', tool_use_id: toolUseId,
  tool_input: { file_path: path, old_string: 'a', new_string: 'b' }, tool_response: { filePath: path, oldString: 'a', newString: 'b' },
})
const bashTool = (session: string, cwd: string, toolUseId: string, failed = false) => (failed
  ? { hook_event_name: 'PostToolUseFailure', session_id: session, cwd, tool_name: 'Bash', tool_use_id: toolUseId, tool_input: { command: 'python gen.py' }, error: 'Exit code 1' }
  : { hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: 'Bash', tool_use_id: toolUseId, tool_input: { command: 'python gen.py' }, tool_response: { stdout: '', stderr: '' } })

// ================================================================================================================ catalog views

type DocRow = {
  documentId: string; displayName: string; projectName: string | null; extension: string; activityAt: string; activitySource: string
  sessionAssociations: Array<{ sessionId: string; certainty: string }>; availability: string; preservationState: string; protected: boolean; locationCount: number; versionCount: number
}
type Detail = { document: DocRow; locations: Json[]; versions: Json[]; evidence: Json[] }

async function listDocs(svc: Svc, query = ''): Promise<{ rows: DocRow[]; total: number; coverage: Json }> {
  const r = await api(svc, 'GET', `/api/artifact-documents${query ? `?${query}` : ''}`)
  assert.equal(r.status, 200, r.text)
  return r.json as { rows: DocRow[]; total: number; coverage: Json }
}
async function detail(svc: Svc, documentId: string, query = ''): Promise<Detail> {
  const r = await api(svc, 'GET', `/api/artifact-documents/${documentId}${query ? `?${query}` : ''}`)
  assert.equal(r.status, 200, r.text)
  return r.json as unknown as Detail
}
/** The document of one catalogued location path. */
function documentOf(svc: Svc, path: string): string | null {
  return one<{ document_id: string | null }>(svc.db, 'SELECT document_id FROM artifacts WHERE path = ?', path)?.document_id ?? null
}
function documentByRelative(svc: Svc, relativePath: string): string[] {
  return rows<{ document_id: string }>(svc.db, 'SELECT document_id FROM artifact_documents WHERE relative_path = ? ORDER BY document_id', relativePath).map(r => r.document_id)
}
/**
 * The catalog's stored preservation answer. Nothing in this release writes 'preserved' or 'unique': preservation is proven
 * only by the removal checker, live, at removal time, and every catalogued version stays 'unknown'. This pins that contract
 * so a future writer cannot turn grouping, Git retention or copy equality into a stored preservation claim unnoticed.
 */
function assertPreservationUnknown(versions: Json[], why: string): void {
  assert.ok(versions.length > 0, 'there are versions to judge')
  assert.deepEqual([...new Set(versions.map(v => v.preservationState))], ['unknown'], why)
}
const rootAt = (svc: Svc, path: string): ArtifactRootRow | undefined => listArtifactRoots(svc.db).find(r => r.canonicalPath === path)
async function rootStatus(svc: Svc, rootId: string, sensitive = 'show'): Promise<Json> {
  const r = await api(svc, 'GET', `/api/artifact-manager/status?sensitive=${sensitive}`)
  assert.equal(r.status, 200, r.text)
  const root = (r.json.roots as Json[]).find(x => x.rootId === rootId)
  assert.ok(root, 'the root is listed in status')
  return root
}

// ================================================================================================================ AC-01

describe('AC-01 a tool creates and later edits a document in a linked worktree', () => {
})

// ================================================================================================================ AC-02

describe('AC-02 script output in a registered output root, including ignored files and unattended scripts', () => {
})

// ================================================================================================================ settle before version

// Every other scenario here sets debounceMs to 0 (they are not about timing). This one keeps the default quiet period (2,000 ms):
// a scan (reconcile or watcher: both wait for the quiet period) that meets a file while it is still being written must not version it, and the file is versioned once, with its
// final content, after it stops changing. Docs: docs/superpowers/specs/2026-11-06-settle-before-version-design.md.
describe('settle before version with the default quiet period', () => {
  test('a scan of a file that is still changing records nothing; the one version is the finished file', async () => {
    const home = newHome()
    const out = join(home, 'settle-out')
    mkdirSync(out)
    // debounceMs is deliberately left at its default.
    const svc = await startService({ home, configure: c => { c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: 'settle', protected: false }] } })
    assert.equal(svc.config.artifacts.debounceMs, 2_000, 'the default quiet period')
    await idle(svc, 'baseline pass of the empty output root')
    const root = rootAt(svc, out)
    assert.ok(root && root.kind === 'output', 'the output root is registered')
    const passes = () => one<{ applied: number }>(svc.db, `SELECT MAX(applied_generation) AS applied FROM artifact_jobs WHERE scope_id = ?`, root.rootId)?.applied ?? 0
    const before = passes()
    const versions = (documentId: string) => rows<{ size_bytes: number }>(svc.db, `SELECT size_bytes FROM artifact_versions WHERE document_id = ? AND kind = 'working'`, documentId)

    // A script keeps writing the report: the file changes every 50 ms until the test stops it.
    const file = join(out, 'report.md')
    writeFileSync(file, '')
    const writer = setInterval(() => { try { appendFileSync(file, 'partial line of the report\n') } catch { /* removed with the test */ } }, 50)
    try {
      // A scan meets the file mid-write: the root refresh requested here is a reconcile scan, and any watcher scan is judged by the same rule.
      const refresh = await api(svc, 'POST', '/api/artifact-manager/refresh', { rootId: root.rootId })
      assert.equal(refresh.status, 202, refresh.text)
      await until(svc, () => passes() > before, 'the scan of the changing file')
      assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifact_versions'), 0, 'a file still changing is not versioned')
      assert.equal(documentOf(svc, file), null, 'and has no document yet')
    } finally {
      clearInterval(writer)
    }

    // The script finishes. Another scan (the refresh again) right after the last write still finds it fresh; the file is versioned once it is quiet.
    const finalText = '# Report\n\nthe finished report\n'
    const finishedAt = Date.now()
    writeFileSync(file, finalText)
    const finalSize = statSync(file).size
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/refresh', { rootId: root.rootId })).status, 202)
    await until(svc, () => documentOf(svc, file) !== null && versions(documentOf(svc, file)!).length > 0, 'the settled version')
    const recordedAfter = Date.now() - finishedAt
    await idle(svc, 'everything settled')
    const documentId = documentOf(svc, file)!
    assert.deepEqual(versions(documentId).map(v => v.size_bytes), [finalSize], 'exactly one working version, with the final size')
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifact_documents'), 1)
    assert.ok(recordedAfter >= 1_500, `the version waited for the quiet period (recorded ${recordedAfter} ms after the last write)`)
  })
})

// ================================================================================================================ AC-03

describe('AC-03 continuity through a linked worktree, a commit, worktree removal and a merge', () => {
  // I1 (Wave 2a fix round 1): the worktree's auto-registered docs/ root is retired with the worktree, so an ignored output found
  // under it is proven missing (the folder above is on the device it was seen on) and the service can go idle again.
})

// PR #19 review, P2-2: the first successful file hook can arrive before the checkout is registered. Ingestion then authorizes the
// file through a direct-only root on its folder and the document is born with a ROOT identity; when the service later verifies
// the checkout and the repository path, the same file must become the repository document, not a second one.
describe('AC-03 (PR #19 review, P2-2) a hook that arrives before checkout registration keeps one document', () => {
  const kindOf = (svc: Svc, documentId: string): string | undefined => one<{ identity_kind: string }>(svc.db, 'SELECT identity_kind FROM artifact_documents WHERE document_id = ?', documentId)?.identity_kind

})

// ================================================================================================================ AC-04

describe('AC-04 divergent same-path variants and equal unrelated files', () => {

})

// ================================================================================================================ AC-05

/**
 * A clone (the session's checkout) of an upstream whose history is 20 days old, older than the 7-day lookback: docs/guide.md
 * has two commits on main, branch `alt` changes it and adds docs/alt-only.md. The clone's own files are back-dated, so the
 * baseline itself carries no noise. The session is active in the clone and every baseline pass has completed.
 * `importOlder` also runs "Import older files" on the checkout, so those old commits are catalogued (through Git history)
 * before the scenario starts: the unchanged tracked documents then exist, and a noisy pass would have something to claim.
 */
async function checkoutNoiseFixture(opts: { importOlder?: boolean } = {}): Promise<{ svc: Svc; S: string; clone: string; upstream: string; old: Record<string, string> }> {
  const home = newHome()
  const old = { GIT_AUTHOR_DATE: iso(Date.now() - 20 * DAY), GIT_COMMITTER_DATE: iso(Date.now() - 20 * DAY) }
  const upstream = join(home, 'work', 'upstream')
  mkdirSync(upstream, { recursive: true })
  git(upstream, ['init', '-q'])
  put(join(upstream, 'docs', 'guide.md'), 'guide v1\n')
  commitAll(upstream, 'guide v1', old)
  git(upstream, ['checkout', '-q', '-b', 'alt'])
  put(join(upstream, 'docs', 'guide.md'), 'guide on alt\n')
  put(join(upstream, 'docs', 'alt-only.md'), 'only on alt\n')
  commitAll(upstream, 'alt', old)
  git(upstream, ['checkout', '-q', 'main'])
  put(join(upstream, 'docs', 'guide.md'), 'guide v2\n')
  commitAll(upstream, 'guide v2', old)
  const clone = join(home, 'work', 'proj')
  git(home, ['clone', '-q', '--no-local', upstream, clone])
  git(clone, ['branch', '-q', '--track', 'alt', 'origin/alt'])
  const then = new Date(Date.now() - 20 * DAY)
  for (const f of ['guide.md']) utimesSync(join(clone, 'docs', f), then, then)
  const svc = await startService({ home, configure: c => { c.artifacts.debounceMs = 0 } })
  const S = sid(105)
  assert.equal((await hook(svc, sessionStart(S, realpathSync(clone)))).outcome, 'delivered')
  await idle(svc, 'baseline passes')
  const docsRoot = rootAt(svc, join(realpathSync(clone), 'docs'))
  assert.ok(docsRoot?.lastSuccessfulAt, 'the checkout\'s docs/ output root has a completed baseline')
  if (opts.importOlder) {
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/refresh', { rootId: rootAt(svc, realpathSync(clone))!.rootId, includeOlder: true })).status, 202)
    await idle(svc, 'Import older files')
    for (const rel of ['docs/guide.md', 'docs/alt-only.md']) assert.equal(documentByRelative(svc, rel).length, 1, `${rel} is catalogued through Git history`)
  }
  return { svc, S, clone: realpathSync(clone), upstream, old }
}

/** Applied generation of the clone's docs/ root, to prove a later folder scan really walked the materialized files. */
const docsGeneration = (svc: Svc, checkout: string): number => rootAt(svc, join(checkout, 'docs'))?.appliedGeneration ?? -1

/**
 * Checkout noise (spec s6, AC-05; ruling R66): an unchanged tracked document Git materialized never becomes recent, and nothing
 * anywhere links the active session to it. It is not an output: it is catalogued only through Git history (activity = commit
 * time, git evidence only) or, with commits older than the lookback and no "Import older files", not at all. Checked through the
 * detail and list routes AND the evidence and legacy origin tables, every problem listed. `control` names a genuine script
 * output written during the same session: it must be linked to the session by inference (the inference path is live in this
 * scenario), and it is the ONLY document linked to the session or listed as recent.
 */
async function assertNoCheckoutNoise(svc: Svc, S: string, relativePaths: string[], control: string | null = null): Promise<void> {
  const recentCutoff = Date.now() - DAY
  const problems: string[] = []
  for (const rel of relativePaths) {
    for (const id of documentByRelative(svc, rel)) {
      const d = await detail(svc, id)
      if (Date.parse(d.document.activityAt) >= recentCutoff) problems.push(`${rel}: recent activity ${d.document.activitySource} from checkout timestamps`)
      for (const e of d.evidence.filter(x => x.sessionId === S)) problems.push(`${rel}: session ${e.certainty} ${e.operation} (${e.source})`)
      for (const e of d.evidence.filter(x => x.source !== 'git')) problems.push(`${rel}: non-Git evidence ${e.source} ${e.certainty} ${e.operation}`)
    }
  }
  // The evidence table itself (any source, operation and certainty) and the legacy creator/reference projection.
  const linked = rows<{ rel: string; source: string; certainty: string; operation: string }>(svc.db,
    'SELECT d.relative_path AS rel, e.source, e.certainty, e.operation FROM artifact_evidence e JOIN artifact_documents d ON d.document_id = e.document_id WHERE e.session_id = ? ORDER BY rel', S)
  for (const e of linked) if (e.rel !== control) problems.push(`evidence table: session ${e.certainty} ${e.operation} (${e.source}) on ${e.rel}`)
  const origins = rows<{ path: string; relation: string }>(svc.db, 'SELECT a.path, o.relation FROM artifact_origins o JOIN artifacts a ON a.artifact_id = o.artifact_id WHERE o.session_id = ?', S)
  for (const o of origins) if (control === null || !o.path.endsWith(`/${control}`)) problems.push(`origins table: session ${o.relation} of ${o.path}`)
  const controlName = control === null ? null : control.slice(control.lastIndexOf('/') + 1)
  for (const r of (await listDocs(svc, `session=${S}&types=all`)).rows) if (r.displayName !== controlName) problems.push(`listed for the session: ${r.displayName}`)
  for (const r of (await listDocs(svc, `from=${encodeURIComponent(iso(recentCutoff))}`)).rows) if (r.displayName !== controlName) problems.push(`listed as recent: ${r.displayName}`)
  if (control !== null && !linked.some(e => e.rel === control && e.certainty === 'inferred' && e.operation === 'created')) {
    problems.push(`control: the session's own script output ${control} was not inferred (the inference path did not run)`)
  }
  assert.deepEqual(problems, [], 'checkout noise must not create activity or session claims')
}

describe('AC-05 checkout timestamp noise and pre-existing dirty files', () => {
  test('a new worktree materializing tracked documents does not make them recent or associate the session', async () => {
    const { svc, S, clone } = await checkoutNoiseFixture()
    const wt = join(dirname(clone), 'proj-wt')
    git(clone, ['worktree', 'add', '-q', '--detach', wt, 'origin/alt'])
    // The next full reconciliation registers the new worktree (and its docs/ folder) and scans it.
    svc.offsetMs += svc.config.artifacts.recoveryIntervalMs + 1_000
    await idle(svc, 'scans of the new worktree')
    const wtDocs = rootAt(svc, join(realpathSync(wt), 'docs'))
    assert.ok(wtDocs?.lastSuccessfulAt, 'the new worktree\'s docs/ folder is registered and completely scanned')
    // Commits older than the lookback and no "Import older files": these clean tracked documents are not catalogued at all
    // (R68(a)). That absence, and recency, are what this scenario discriminates on: the worktree is a sibling of the session's
    // folder, not inside it, so the session checks in assertNoCheckoutNoise hold by construction here.
    assert.deepEqual(['docs/guide.md', 'docs/alt-only.md'].map(rel => documentByRelative(svc, rel).length), [0, 0], 'not catalogued at all')
    await assertNoCheckoutNoise(svc, S, ['docs/guide.md', 'docs/alt-only.md'])
  })

})

// ================================================================================================================ AC-06

describe('AC-06 event certainty, concurrent sessions, commit trailers and unknown origin', () => {
})

// ================================================================================================================ AC-07

/** The real worker behind a recorder of every request it is sent. */
function recordingWorker(inner: ArtifactWorkerClient, seen: ArtifactWorkerRequest[]): ArtifactWorkerClient {
  return {
    start: req => { seen.push(structuredClone(req)); inner.start(req) }, poll: () => inner.poll(), wait: ms => inner.wait(ms), ack: id => inner.ack(id),
    restart: why => inner.restart(why), stop: () => inner.stop(), status: () => inner.status(),
  }
}

describe('AC-07 service downtime over seven days and resumable older-file import', () => {

  test('"Import older files" is resumable across a service restart and visibly partial until complete', async () => {
    const home = newHome()
    const out = join(home, 'archive')
    for (let i = 0; i < 30; i++) put(join(out, `d${i % 3}`, `old-${String(i).padStart(2, '0')}.md`), `old ${i}\n`)
    const configure = (c: AtlasConfig) => {
      c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: 'archive', protected: false }]
      c.artifacts.maxEntriesPerSlice = 6
      c.artifacts.debounceMs = 0
    }
    // The service clock is a month ahead, so every file is older than the initial lookback.
    const seen1: ArtifactWorkerRequest[] = []
    const first = await startService({ home, configure, worker: recordingWorker(hermeticWorker(home), seen1) })
    first.offsetMs = 30 * DAY
    await idle(first, 'the initial pass')
    const root = rootAt(first, out)!
    assert.equal(count(first.db, 'SELECT COUNT(*) AS n FROM artifacts'), 0, 'nothing older than the lookback was imported')
    const refresh = await api(first, 'POST', '/api/artifact-manager/refresh', { rootId: root.rootId, includeOlder: true })
    assert.equal(refresh.status, 202, refresh.text)
    // Run until the import has committed at least one slice and parked between slices.
    const job = () => one<{ state: string; cursor: string | null }>(first.db, `SELECT state, cursor FROM artifact_jobs WHERE scope_id = ? AND task_kind = 'output-walk'`, root.rootId)
    await until(first, () => job()?.state === 'queued' && job()?.cursor != null && count(first.db, 'SELECT COUNT(*) AS n FROM artifacts') > 0, 'the first committed slice', 20_000)
    const midway = count(first.db, 'SELECT COUNT(*) AS n FROM artifacts')
    assert.ok(midway > 0 && midway < 30, `partly imported (${midway} of 30)`)
    const mid = await rootStatus(first, root.rootId)
    assert.ok(['partial', 'queued', 'scanning'].includes(mid.state), `visibly incomplete: ${mid.state}`)
    assert.equal(mid.includeOlderPending, true)
    assert.match(mid.reason, /Importing older files/)
    assert.notEqual(mid.cursor, null, 'progress is kept')
    await first.close()

    // A new service process resumes from the committed cursor instead of the first directory.
    const seen2: ArtifactWorkerRequest[] = []
    const second = await startService({ home, configure, worker: recordingWorker(hermeticWorker(home), seen2) })
    second.offsetMs = 30 * DAY + 120_000
    await idle(second, 'the rest of the import')
    const resumed = seen2.find(r => r.task === 'output-walk' && r.root.rootId === root.rootId)!
    assert.ok(resumed.cursor !== null && resumed.includeOlder, 'the first request after the restart carries the committed cursor')
    assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM artifacts'), 30)
    assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM artifact_versions'), 30, 'no duplicate versions from the replayed slice')
    const done = await rootStatus(second, root.rootId)
    assert.equal(done.state, 'idle')
    assert.equal(done.includeOlderPending, false)
    assert.ok(!/Importing older files/.test(done.reason ?? ''), 'no longer pending once complete')
  })

  // DEFECT-2 (Tasks 5, 7), fixed in Defect Wave 1 (R67): the walk reports lookback-limited; the service keeps the first pass's gap
  // until "Import older files" completes.
  test('an initial pass that skipped files older than the lookback says so in its coverage', async () => {
    const home = newHome()
    const out = join(home, 'archive')
    put(join(out, 'old.md'), 'older than the lookback\n')
    const svc = await startService({ home, configure: c => { c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: null, protected: false }] } })
    svc.offsetMs = 30 * DAY
    await idle(svc, 'the initial pass')
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifacts'), 0)
    const st = await rootStatus(svc, rootAt(svc, out)!.rootId)
    // Spec s6: "A recency filter reduces rows imported ... coverage indicators must expose that difference."
    assert.ok(st.gaps.includes('lookback-limited') || /Import older files/.test(st.reason ?? ''), `the root reports that older files were not imported: ${JSON.stringify({ state: st.state, gaps: st.gaps, reason: st.reason })}`)
  })
})

// ================================================================================================================ AC-08

describe('AC-08 exact Git commit/path recovery without false availability or preservation', () => {

  // DEFECT-3 (Tasks 7, 8, 2), fixed in Defect Wave 2a: a failed preview/export records what it proved about the object, and a
  // bounded background `cat-file --batch-check` pass marks collected versions unavailable (and available again if they return).

})

// ================================================================================================================ AC-09

describe('AC-09 removal protections', () => {
})

// ================================================================================================================ AC-10

type Spawned = { code: number | null; out: string; err: string; ms: number }
/** Spawns node with a minimal environment (never the test process's), as a user's shell or Claude Code would. */
function spawnProgram(args: string[], env: Record<string, string>, cwd: string, stdin?: string): Promise<Spawned> {
  return spawnCommand(process.execPath, args, env, cwd, stdin)
}
function spawnCommand(command: string, args: string[], env: Record<string, string>, cwd: string, stdin?: string): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = nodeSpawn(command, args, { cwd, env: { PATH: PATH_ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    CHILDREN.add(child)
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    let out = ''
    let err = ''
    child.stdout!.setEncoding('utf8').on('data', (c: string) => { out += c })
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { err += c })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(killer); CHILDREN.delete(child); resolve({ code, out, err, ms: performance.now() - started }) })
    child.stdin!.on('error', () => {})
    child.stdin!.end(stdin ?? '')
  })
}
const runCli = (args: string[], env: Record<string, string>, cwd = REPO_ROOT) => spawnProgram(['--disable-warning=ExperimentalWarning', CLI, ...args], env, cwd)
const runGuard = (command: string, cwd: string, env: Record<string, string>) => spawnProgram([GUARD], env, REPO_ROOT, JSON.stringify({
  session_id: sid(910), transcript_path: '/t/session.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'cleanup' },
}))
/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function treeOf(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(String).sort()
}

describe('AC-10 standalone checker and the Bash removal guard', () => {
  test('the checker works with Atlas stopped and no catalog file: it still finds risks, reports incomplete coverage and creates nothing', async () => {
    const home = newHome()
    const main = makeRepo(join(home, 'work', 'proj'))
    const wt = addWorktree(main, join(home, 'work', 'proj-wt'), 'feat')
    const port = await deadPort()
    const before = treeOf(home)
    const r = await runCli(['check-removal', '--worktree', wt, '--json'], { HOME: home, ATLAS_PORT: String(port) })
    assert.equal(r.code, 2, r.err)
    const doc = JSON.parse(r.out) as { result: RemovalCheckResult }
    assert.equal(doc.result.coverage.catalog, 'missing')
    assert.equal(doc.result.coverage.sessions, 'unknown', 'a stopped service never reads as "no active session"')
    assert.deepEqual(treeOf(home), before, 'no catalog, WAL or directory is created')
    const draft = put(join(wt, 'draft.md'), 'unsaved work\n')
    const risky = await runCli(['check-removal', '--worktree', wt, '--json'], { HOME: home, ATLAS_PORT: String(port) })
    assert.equal(risky.code, 3, risky.err)
    assert.ok((JSON.parse(risky.out) as { result: RemovalCheckResult }).result.risks.some(x => x.path === draft), 'risks are still found offline')
    // With a catalog on disk but the service stopped, session activity stays unknown: still exit 2, never 0.
    rmSync(draft)
    const catalogHome = newHome()
    const catalogPath = loadConfig({ HOME: catalogHome }).dbPath
    openDatabase(catalogPath).close()
    const stopped = await runCli(['check-removal', '--worktree', wt, '--json'], { HOME: catalogHome, ATLAS_PORT: String(port) })
    assert.equal(stopped.code, 2, stopped.out)
    assert.equal((JSON.parse(stopped.out) as { result: RemovalCheckResult }).result.coverage.catalog, 'complete')
  })

})

// ================================================================================================================ AC-11

describe('AC-11 delivery failure, replay, crashes, generations, quarantines and unchanged scans', () => {

  // DEFECT-5 (Task 7, reconcile.ts), fixed in Defect Wave 2a: the verifier marks a location missing only for ENOENT/ENOTDIR on a
  // reachable root; any other errno or an unreachable root leaves it unverified with its last known state.
  test('a root that becomes inaccessible never marks its known files missing while the service keeps verifying', async () => {
    const home = newHome()
    const out = join(home, 'out')
    const a = put(join(out, 'a.md'), 'a\n')
    // Verification ticks with the runner on every loop pass, so this assertion is exercised, not only the scan.
    const svc = await startService({ home, verifyIntervalMs: 0 })
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/roots', { path: out })).status, 201)
    await idle(svc, 'baseline')
    assert.equal(findArtifactByPath(svc.db, a)?.existsState, 'present')
    renameSync(out, `${out}-gone`)
    const root = rootAt(svc, out)!
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/refresh', { rootId: root.rootId })).status, 202)
    for (let i = 0; i < 4; i++) {
      await until(svc, () => one<{ state: string }>(svc.db, `SELECT state FROM artifact_jobs WHERE scope_id = ? AND task_kind = 'output-walk'`, root.rootId)?.state !== 'running', 'the attempt', 10_000)
      svc.offsetMs += 301_000
      for (let k = 0; k < 4; k++) await tick(svc)
    }
    assert.notEqual(rootAt(svc, out)!.coverageState, 'idle', 'the scan never reads as complete')
    // Spec s6: "Permission failures, disconnected roots and partial scans produce 'unverified', retaining the last known existence state."
    assert.equal(findArtifactByPath(svc.db, a)?.existsState, 'present', 'an inaccessible root never marks its files missing')
  })

  test('a worker crash and a service crash both resume from committed progress without duplicates', async () => {
    const home = newHome()
    const out = join(home, 'big')
    for (let i = 0; i < 300; i++) put(join(out, `d${i % 5}`, `f${String(i).padStart(3, '0')}.md`), `file ${i}\n`)
    const configure = (c: AtlasConfig) => {
      c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: null, protected: false }]
      c.artifacts.maxEntriesPerSlice = 120
      c.artifacts.debounceMs = 0
    }
    // Worker crash: the real worker is killed after its first batch committed and before the acknowledgement reached it.
    const real = hermeticWorker(home)
    let killed = false
    const seen: ArtifactWorkerRequest[] = []
    const crashing: ArtifactWorkerClient = {
      start: q => { seen.push(structuredClone(q)); real.start(q) }, poll: () => real.poll(), wait: ms => real.wait(ms), restart: why => real.restart(why), stop: () => real.stop(), status: () => real.status(),
      ack: jobId => { if (!killed) { killed = true; process.kill(real.status().pid!, 'SIGKILL'); return } real.ack(jobId) },
    }
    const first = await startService({ home, configure, worker: crashing })
    const rootId = () => rootAt(first, out)?.rootId
    await until(first, () => killed && one<{ state: string }>(first.db, `SELECT state FROM artifact_jobs WHERE task_kind = 'output-walk' AND scope_id = ?`, rootId() ?? '')?.state === 'retry', 'the crash', 20_000)
    const committed = count(first.db, 'SELECT COUNT(*) AS n FROM artifacts')
    assert.ok(committed > 0 && committed < 300, `the first batch was committed before the crash (${committed})`)
    assert.equal(readArtifactManagerState(first.db, 'health.worker-crashes'), '1')
    first.offsetMs += 3_000
    // Run until another slice has been committed, then let the whole service die mid-pass.
    await until(first, () => count(first.db, 'SELECT COUNT(*) AS n FROM artifacts') > committed + 50, 'a slice after the crash', 20_000)
    const cursorAtCrash = one<{ cursor: string | null }>(first.db, `SELECT cursor FROM artifact_jobs WHERE task_kind = 'output-walk' AND scope_id = ?`, rootId()!)?.cursor ?? null
    const beforeServiceCrash = count(first.db, 'SELECT COUNT(*) AS n FROM artifacts')
    await first.close()
    const seen2: ArtifactWorkerRequest[] = []
    const second = await startService({ home, configure, worker: recordingWorker(hermeticWorker(home), seen2) })
    second.offsetMs = 120_000 // past the dead service's 60 s lease
    await idle(second, 'the rest of the pass')
    assert.ok(cursorAtCrash !== null && beforeServiceCrash < 300, 'the service died mid-pass with committed progress')
    const resumed = seen2.find(q => q.task === 'output-walk')
    assert.ok(resumed, 'the pass was resumed')
    assert.equal(resumed.cursor, cursorAtCrash, 'from the committed cursor, not from the first directory')
    assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM artifacts'), 300)
    assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM artifact_versions'), 300, 'replayed rows create no second version')
    assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM artifact_documents'), 300)
  })

  test('a change during a multi-slice pass gets another pass, and an unchanged pass creates no churn', async () => {
    const home = newHome()
    const out = join(home, 'out')
    for (let i = 0; i < 60; i++) put(join(out, `m${i % 4}`, `f${String(i).padStart(2, '0')}.md`), `file ${i}\n`)
    mkdirSync(join(out, 'aaa'))
    const svc = await startService({ home, configure: c => { c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: null, protected: false }]; c.artifacts.maxEntriesPerSlice = 12 } })
    const rootId = () => rootAt(svc, out)?.rootId ?? ''
    const job = () => one<{ state: string; cursor: string | null; desired_generation: number; applied_generation: number }>(svc.db,
      `SELECT state, cursor, desired_generation, applied_generation FROM artifact_jobs WHERE task_kind = 'output-walk' AND scope_id = ?`, rootId())
    await until(svc, () => job()?.cursor != null, 'the first committed slice', 20_000)
    // A file appears in a directory the pass has already passed, and its event arrives mid-pass.
    const late = put(join(out, 'aaa', 'late.md'), 'arrived mid-pass\n')
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/refresh', { rootId: rootId() })).status, 202)
    await idle(svc, 'both passes')
    assert.ok(findArtifactByPath(svc.db, late), 'the second pass found the file the first pass had already passed')
    const j = job()!
    assert.equal(j.applied_generation, j.desired_generation, 'the generation that arrived mid-pass was applied')
    assert.ok(rootAt(svc, out)!.appliedGeneration >= 2)

    // An unchanged pass: no new version, evidence, location or document change, and no activity churn.
    const snapshot = () => ({
      versions: rows(svc.db, 'SELECT * FROM artifact_versions ORDER BY version_id'),
      evidence: rows(svc.db, 'SELECT * FROM artifact_evidence ORDER BY evidence_id'),
      documents: rows(svc.db, 'SELECT * FROM artifact_documents ORDER BY document_id'),
      locations: rows(svc.db, 'SELECT * FROM artifacts ORDER BY artifact_id'),
    })
    const before = snapshot()
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/refresh', { rootId: rootId() })).status, 202)
    await idle(svc, 'the unchanged pass')
    assert.ok(rootAt(svc, out)!.appliedGeneration >= 3, 'the unchanged pass ran')
    assert.deepEqual(snapshot(), before, 'an unchanged scan writes nothing')
  })
})

// ================================================================================================================ AC-12

/**
 * Real permission failures. The tests run as root here, and root ignores folder permissions, so a denied process is a child
 * started through setpriv with CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH removed from its bounding set. A non-root run needs
 * no setpriv. Without either the tests are skipped with this reason (never silently passed).
 */
const IS_ROOT = process.getuid?.() === 0
const HAS_SETPRIV = (() => { try { execFileSync('setpriv', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
const NO_DAC_SKIP: string | false = !IS_ROOT || (process.platform === 'linux' && HAS_SETPRIV) ? false
  : 'running as root without Linux setpriv: a real EACCES cannot be produced (root bypasses folder permissions)'
function spawnUnprivileged(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<Spawned> {
  return IS_ROOT ? spawnCommand('setpriv', ['--bounding-set=-dac_override,-dac_read_search', command, ...args], env, cwd) : spawnCommand(command, args, env, cwd)
}
/** Runs the production verify runner once against a catalog (argv[1]), as the service would. */
const VERIFY_ONCE = `import { openDatabase } from ${JSON.stringify(join(REPO_ROOT, 'src', 'db', 'database.ts'))}
import { verifyRunner } from ${JSON.stringify(join(REPO_ROOT, 'src', 'service', 'artifact-runner.ts'))}
const db = openDatabase(process.argv[1])
const quiet = { info() {}, warn() {}, error() {} }
await verifyRunner({ db, log: quiet, intervalMs: 0 }).run()
db.close()`

describe('AC-12 bounded work never yields false complete, missing or safe results', () => {

  // DEFECT-4 (Task 5), fixed in Defect Wave 1: a walked directory that changed after the pass started, or a listed entry that
  // vanished, makes the pass partial (path-changed); the next pass walks the moved folder.
  test('a directory moved into the already-walked part of a root during a pass is not left behind a "complete" root', async () => {
    const home = newHome()
    const out = join(home, 'out')
    put(join(out, 'a-visited', 'first.md'), 'first\n')
    for (let d = 0; d < 6; d++) for (let i = 0; i < 10; i++) put(join(out, `b${d}`, `f${i}.md`), `${d}/${i}\n`)
    const svc = await startService({ home, configure: c => { c.artifacts.maxEntriesPerSlice = 10; c.artifacts.debounceMs = 0 } })
    assert.equal((await api(svc, 'POST', '/api/artifact-manager/roots', { path: out })).status, 201)
    await until(svc, () => rootAt(svc, out)?.cursor != null && findArtifactByPath(svc.db, join(out, 'a-visited', 'first.md')) !== null, 'the first slice', 10_000)
    assert.equal(findArtifactByPath(svc.db, join(out, 'b5', 'f0.md')), null, 'b5 is not walked yet')
    // No notification arrives (no watcher, no hook): the move is seen only by the scan itself.
    renameSync(join(out, 'b5'), join(out, 'a-visited', 'b5'))
    await idle(svc, 'the rest of the pass')
    const moved = Array.from({ length: 10 }, (_, i) => join(out, 'a-visited', 'b5', `f${i}.md`))
    const missed = moved.filter(p => findArtifactByPath(svc.db, p) === null)
    const st = await rootStatus(svc, rootAt(svc, out)!.rootId)
    assert.ok(missed.length === 0 || st.state !== 'idle' || pending(svc) > 0,
      `${missed.length} moved files were never seen, yet the root reads as complete: ${JSON.stringify({ state: st.state, gaps: st.gaps, lastSuccessfulAt: st.lastSuccessfulAt })}`)
  })

  // DEFECT-5 (Task 7, reconcile.ts), fixed in Defect Wave 2a (see AC-11): ELOOP and an unmounted root leave known files unverified.


  test('without any notification a post-baseline write that keeps an old mtime is discovered by recovery', async () => {
    const home = newHome()
    const out = join(home, 'out')
    const existing = put(join(out, 'existing.md'), 'original\n')
    const svc = await startService({ home, configure: c => { c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: null, protected: false }] } })
    await idle(svc, 'baseline')
    assert.ok(rootAt(svc, out)!.lastSuccessfulAt)
    const versionsBefore = count(svc.db, 'SELECT COUNT(*) AS n FROM artifact_versions')
    const old = new Date(Date.now() - 40 * DAY)
    const copied = put(join(out, 'copied-with-old-mtime.md'), 'cp -p keeps the source time\n')
    utimesSync(copied, old, old)
    const st = statSync(existing)
    writeFileSync(existing, 'rewritten\n')
    utimesSync(existing, st.atime, st.mtime)
    // No hook, no watcher hint: only the periodic recovery pass runs.
    svc.offsetMs += svc.config.artifacts.recoveryIntervalMs + 1_000
    await idle(svc, 'the recovery pass')
    assert.ok(findArtifactByPath(svc.db, copied), 'a new file with an old mtime is discovered (its ctime is new)')
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifact_versions'), versionsBefore + 2, 'and the rewrite that kept its mtime is a new version')
  })

  test('a large root makes progress across slices while a small root is not starved', async () => {
    const home = newHome()
    const large = join(home, 'large'), small = join(home, 'small')
    for (let i = 0; i < 400; i++) put(join(large, `d${i % 8}`, `f${i}.md`), `${i}\n`)
    put(join(small, 'one.md'), 'one\n')
    const seen: ArtifactWorkerRequest[] = []
    const svc = await startService({ home, autoSchedule: false, worker: recordingWorker(hermeticWorker(home), seen), configure: c => { c.artifacts.maxEntriesPerSlice = 50; c.artifacts.debounceMs = 0 } })
    const reg = (p: string) => registerArtifactRoot(svc.db, { kind: 'output', canonicalPath: p, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(Date.now()))
    const L = reg(large), Sm = reg(small)
    enqueueArtifactJob(svc.db, { scopeId: L.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 0 }, iso(Date.now() - 10))
    enqueueArtifactJob(svc.db, { scopeId: Sm.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.recovery, generation: 0 }, iso(Date.now() - 5))
    let smallFirst = false
    await until(svc, () => {
      if (rootAt(svc, small)!.appliedGeneration === 1 && rootAt(svc, large)!.appliedGeneration === 0) smallFirst = true
      return rootAt(svc, large)!.appliedGeneration === 1
    }, 'the large root', 60_000)
    assert.ok(smallFirst, 'the small root completed while the large one was still mid-pass')
    const largeCursors = seen.filter(q => q.root.rootId === L.rootId).map(q => q.cursor)
    assert.ok(largeCursors.length >= 5, `the large root took several slices (${largeCursors.length})`)
    assert.equal(new Set(largeCursors).size, largeCursors.length, 'every slice resumed from a new position (no restart from the first directory)')
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifacts'), 401)
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifact_versions'), 401)
  })

  // DEFECT-6 (checker side, Task 11), fixed in Defect Wave 1: filter-unverified only where a configured driver applies to the path.

  // DEFECT-6 (FINAL-WAVE, Tasks 4, 5), fixed in Defect Wave 1: git-filter-unresolved only when a configured driver applies to a document.
})

// ================================================================================================================ AC-13

/** A tool_completed event exactly as the hook would post it, with a chosen observation. */
function observationEvent(session: string, cwd: string, observation: unknown, n: number): Record<string, unknown> {
  return { event: 'tool_completed', session_id: session, ts: iso(Date.now()), fingerprint: `ac13-${n}-${Date.now()}`, cwd, tool_name: 'Write', tool_use_id: `toolu_ac13_${n}`, artifact_observation: observation }
}

describe('AC-13 hostile paths, names, IPC, events and browser IDs; protected data hidden consistently', () => {

  test('browser-supplied IDs and parameters are validated and resolved server-side; no path or revision is accepted', async () => {
    const home = newHome()
    const out = join(home, 'out')
    put(join(out, 'doc.md'), 'doc\n')
    const outside = scratch('atlas-acc-outside-')
    symlinkSync(outside, join(home, 'link-out'))
    const svc = await startService({ home, configure: c => { c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: null, protected: false }] } })
    await idle(svc, 'baseline')
    const expect = async (method: string, path: string, status: number, code?: string, body?: unknown, headers?: Record<string, string>) => {
      const r = await api(svc, method, path, body, headers)
      assert.equal(r.status, status, `${method} ${path}: ${r.text}`)
      if (code) assert.equal(r.json.error?.code ?? r.json.error, code, `${method} ${path}`)
      assert.ok(!r.text.includes(home), `${method} ${path} never echoes a path`)
    }
    await expect('GET', '/api/artifact-documents/..%2F..%2Fetc%2Fpasswd', 400, 'invalid-id')
    await expect('GET', '/api/artifact-documents/1', 400, 'invalid-id')
    await expect('GET', '/api/artifact-documents/00000000-0000-4000-8000-000000000000', 404, 'not-found')
    await expect('GET', '/api/artifact-versions/HEAD~1/preview', 400, 'invalid-id')
    await expect('GET', `/api/artifact-versions/${encodeURIComponent('a'.repeat(40))}/preview`, 400, 'invalid-id')
    await expect('POST', '/api/artifact-versions/00000000-0000-4000-8000-000000000000/export', 400, 'invalid-body', { path: '/etc/passwd' })
    await expect('POST', '/api/artifact-manager/refresh', 400, 'invalid-body', { rootId: out })
    await expect('POST', '/api/artifact-manager/roots', 403, 'root-outside-home', { path: '/etc' })
    await expect('POST', '/api/artifact-manager/roots', 403, 'root-outside-home', { path: join(home, '.ssh') })
    await expect('POST', '/api/artifact-manager/roots', 403, 'root-symlink-escape', { path: join(home, 'link-out') })
    await expect('POST', '/api/artifact-manager/roots', 400, 'invalid-body', { path: out, command: 'touch /tmp/x' })
    await expect('GET', '/api/artifact-documents?ext=..%2F..%2Fx', 400, 'invalid-parameter')
    await expect('GET', '/api/artifact-documents?session=..%2F..', 400, 'invalid-parameter')
    await expect('GET', '/api/artifact-documents?sensitive=everything', 400, 'invalid-parameter')
    const injected = await api(svc, 'GET', `/api/artifact-documents?q=${encodeURIComponent(`' OR 1=1 --`)}`)
    assert.equal(injected.status, 200)
    assert.equal(injected.json.total, 0, 'a quoted SQL fragment is only a search term')
    const doc = (await listDocs(svc)).rows[0]!
    const v = (await detail(svc, doc.documentId)).versions[0]!
    await expect('GET', `/api/artifact-versions/${v.versionId}/preview`, 403, 'cross-origin', undefined, { 'sec-fetch-site': 'cross-site' })
    const evil = await fetch(`${svc.base}/api/artifact-manager/pause`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })
    assert.equal(evil.status, 403, 'a foreign origin cannot drive the API')
    await evil.text()
    assert.equal(getArtifactManagerStatus(svc.db, iso(Date.now())).paused, false)
  })

  test('NFC and NFD spellings of one name are two files and two documents, never merged', {
    skip: process.platform === 'darwin' ? 'APFS treats NFC and NFD spellings as the same file name, so the pair cannot coexist on macOS' : false,
  }, async () => {
    const home = newHome()
    const out = join(home, 'out')
    const nfc = put(join(out, 'caf\u00e9.md'), 'composed\n')
    const nfd = put(join(out, 'cafe\u0301.md'), 'decomposed\n')
    assert.equal(readdirSync(out).length, 2, 'the filesystem keeps both spellings')
    const svc = await startService({ home, configure: c => { c.artifacts.outputRoots = [{ path: out, repositoryId: null, label: null, protected: false }] } })
    await idle(svc, 'the walk')
    const [a, b] = [documentOf(svc, nfc), documentOf(svc, nfd)]
    assert.ok(a && b && a !== b, 'identity keeps the exact spelling (no Unicode normalisation)')
  })

  test('malformed worker frames are rejected in the service: nothing outside the root or with smuggled evidence is committed', async () => {
    const home = newHome()
    const out = join(home, 'out')
    const inside = put(join(out, 'inside.md'), 'inside\n')
    const fake = new ScriptedWorker()
    const svc = await startService({ home, autoSchedule: false, worker: fake })
    const root = registerArtifactRoot(svc.db, { kind: 'output', canonicalPath: out, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(Date.now()))
    const st = lstatSync(inside, { bigint: true })
    const stat = { dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeMs), ctimeMs: Number(st.ctimeMs) }
    const row = (over: Record<string, unknown>) => ({ rootId: root.rootId, identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: 'inside.md' }, kind: 'working', observedAt: iso(Date.now()), path: inside, stat, ...over })
    const hostileRows = [
      row({ path: '/etc/passwd', identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: '../../etc/passwd' } }),
      row({ path: join(home, '.ssh', 'id_rsa.md'), identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: '../.ssh/id_rsa.md' } }),
      row({ evidence: { source: 'hook', eventKey: 'forged', sessionId: sid(1), operation: 'created', certainty: 'recorded', eventAt: iso(Date.now()) } }),
      row({ identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: 'someone-else.md' } }),
      row({ rootId: '00000000-0000-4000-8000-000000000000' }),
    ]
    let n = 0
    fake.script = req => [{ type: 'batch', jobId: req.jobId, rows: [hostileRows[n++ % hostileRows.length] as never], cursor: 'c1', complete: false, coverage: 'partial', counts: { visited: 1, eligible: 1, skipped: 0 } }]
    for (let i = 0; i < hostileRows.length; i++) {
      enqueueArtifactJob(svc.db, { scopeId: root.rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 0 }, iso(Date.now()))
      svc.offsetMs += 400_000
      for (let k = 0; k < 4; k++) await tick(svc)
    }
    assert.equal(n, hostileRows.length, 'every hostile frame was offered')
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifacts'), 0, 'nothing was committed')
    assert.equal(count(svc.db, 'SELECT COUNT(*) AS n FROM artifact_evidence'), 0)
    assert.equal(Number(readArtifactManagerState(svc.db, 'health.rejected-frames')), hostileRows.length, 'each frame was rejected')
    assert.deepEqual(fake.acks, [], 'and none was acknowledged')
  })

})

// ================================================================================================================ AC-14

describe('AC-14 migration of a populated Atlas catalog', () => {
})

// ================================================================================================================ AC-15


// ================================================================================================================ AC-16

describe('AC-16 durable output registration and explicit Git export', () => {
})
