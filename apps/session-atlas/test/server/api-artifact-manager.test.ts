import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, constants as fsConstants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDir, removeTempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { startRouteServer } from '../helpers/server.ts'
import { loadConfig, type AtlasConfig } from '../../src/config.ts'
import type { AtlasDb } from '../../src/db/database.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { findArtifactByPath, upsertArtifact } from '../../src/db/artifacts.ts'
import {
  recordArtifactObservation, registerArtifactRepository, registerArtifactRoot, type ArtifactRootRow,
} from '../../src/db/artifact-manager.ts'
import type { ArtifactDocumentIdentity, ArtifactWorkerObservation, ArtifactWorkerRequest } from '../../src/artifacts/contracts.ts'
import { configureSensitivePatterns } from '../../src/artifacts/filetype.ts'
import { runArtifactGit, type GitLimits, type GitResult, type GitRunOptions } from '../../src/artifacts/git.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { artifactManagerRunner } from '../../src/service/artifact-manager-runner.ts'
import type { ArtifactWorkerClient, ArtifactWorkerEvent } from '../../src/service/artifact-worker.ts'
import { silentLogger } from '../helpers/log.ts'

// Route tests for the Artifact Manager APIs (plan 2026-10-26 Task 8). Every test builds its own temporary HOME, a real
// temporary Git repository and a temporary database; nothing reads or writes the real home directory.

const ORIGINAL_ENV = { ...process.env }
const homes: string[] = []
// Cleanup is registered before the first temporary directory exists.
after(() => {
  configureSensitivePatterns([])
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key]
  Object.assign(process.env, ORIGINAL_ENV)
  for (const h of homes) removeTempDir(h)
})
// The adapter reads the user's Git configuration view (to enumerate filter drivers) from this process: isolate it, as the
// other Git suites do, so no host or global configuration takes part.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
delete process.env.XDG_CONFIG_HOME

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10'
const T0 = '2026-10-20T12:00:00.000Z'
const OBS = '2026-10-27T11:00:00.000Z'
const NOW = '2026-10-27T12:00:00.000Z'
const JSON_HEADERS = { 'content-type': 'application/json' }
const UNKNOWN_ID = '0b5e2c1e-1111-4222-8333-444455556666'

const COMMITTED = '# Report\ncommitted bytes\n'
const STAGED = '# Report\nstaged bytes\n'
const WORKING = '# Report\nworking bytes\n'
const PLAN = 'protected plan\n'
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`
const XHTML = '<html xmlns="http://www.w3.org/1999/xhtml"><script>fetch("/api/artifact-manager/pause")</script></html>'
const SANDBOX = "sandbox; default-src 'none'"

type GitCall = { repoPath: string; args: string[]; limits: GitLimits }
type OpenCall = { path: string; flags: number; mode: number | undefined }
type ErrorBody = { error: { code: string; message: string } }

type Fx = {
  home: string
  db: AtlasDb
  config: AtlasConfig
  base: string
  repoDir: string
  repositoryId: string
  commitOid: string
  checkout: ArtifactRootRow
  outDir: string
  out: ArtifactRootRow
  durableDir: string
  durable: ArtifactRootRow
  gitCalls: GitCall[]
  /** The adapter options of each call in gitCalls (same index). */
  gitOptions: Array<GitRunOptions | undefined>
  gitOverride: { fn: ((call: GitCall) => GitResult | Promise<GitResult> | null) | null }
  /** Every file open the routes made, and a hook that runs just before the real open (to simulate a race). */
  opens: OpenCall[]
  openHook: { fn: ((call: OpenCall) => void) | null }
  /** Wraps the handle an open returned (to stall or fail its writes). */
  handleWrap: { fn: ((call: OpenCall, handle: FileHandle) => FileHandle) | null }
  reveals: string[]
  close(): Promise<void>
}

function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Atlas Test', GIT_AUTHOR_EMAIL: 'atlas@example.invalid', GIT_COMMITTER_NAME: 'Atlas Test', GIT_COMMITTER_EMAIL: 'atlas@example.invalid',
      GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z',
    },
  }).trim()
}

const NS = 1_000_000_000n
function msOf(ns: bigint): number {
  let sec = ns / NS
  let rem = ns % NS
  if (rem < 0n) { sec -= 1n; rem += NS }
  return Number(sec) * 1e3 + Number(rem) / 1e6
}

/** The stat signature exactly as the discovery worker reports it. */
function statOf(path: string): NonNullable<ArtifactWorkerObservation['stat']> {
  const s = lstatSync(path, { bigint: true })
  return { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeMs: msOf(s.mtimeNs), ctimeMs: msOf(s.ctimeNs) }
}

function cannedGit(over: Partial<GitResult>): GitResult {
  return { stdout: Buffer.alloc(0), exitCode: null, timedOut: false, truncated: false, error: null, incomplete: false, signal: null, stderr: '', filterState: 'none', ...over }
}

async function fixture(opts: { atlasHome?: string; passConfig?: boolean } = {}): Promise<Fx> {
  const home = realpathSync(tempDir('atlas-am-home-'))
  homes.push(home)
  process.env.HOME = home
  const config = loadConfig({ HOME: home, ...(opts.atlasHome ? { ATLAS_HOME: join(home, opts.atlasHome) } : {}) })
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: home, startedAt: T0, now: T0 })
  ensureSession(db, { sessionId: S2, cwd: home, startedAt: T0, now: T0 })

  const repoDir = join(home, 'proj')
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  mkdirSync(join(repoDir, 'phi'))
  git(repoDir, home, 'init', '-q', '-b', 'main')
  writeFileSync(join(repoDir, 'docs', 'report.md'), COMMITTED)
  writeFileSync(join(repoDir, 'docs', 'pointer.md'), LFS_POINTER)
  writeFileSync(join(repoDir, 'docs', 'credentials.json'), '{"token":"x"}\n')
  writeFileSync(join(repoDir, 'phi', 'plan.md'), PLAN)
  writeFileSync(join(repoDir, 'docs', 'x.xml'), XHTML)
  git(repoDir, home, 'add', '-A')
  git(repoDir, home, 'commit', '-q', '-m', 'initial')
  // Staged and working bytes now differ from each other and from the commit.
  writeFileSync(join(repoDir, 'docs', 'report.md'), STAGED)
  git(repoDir, home, 'add', 'docs/report.md')
  writeFileSync(join(repoDir, 'docs', 'report.md'), WORKING)
  const commitOid = git(repoDir, home, 'rev-parse', 'HEAD')

  const repositoryId = registerArtifactRepository(db, { commonDir: realpathSync(join(repoDir, '.git')), displayName: 'proj', remoteIdentity: null }, T0)
  const checkout = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: repoDir, repositoryId, projectName: 'proj', checkoutIdentity: 'ck-main', protected: false, scopeFlags: ['checkout'] }, T0)
  const outDir = join(home, 'out')
  mkdirSync(join(outDir, 'phi'), { recursive: true })
  const out = registerArtifactRoot(db, { kind: 'output', canonicalPath: outDir, repositoryId: null, projectName: 'reports', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, T0)
  const durableDir = join(config.artifacts.durableOutputBase, repositoryId, 'deliverables')
  mkdirSync(durableDir, { recursive: true, mode: 0o700 })
  chmodSync(durableDir, 0o700)
  const durable = registerArtifactRoot(db, { kind: 'output', canonicalPath: durableDir, repositoryId, projectName: 'proj', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)

  const gitCalls: GitCall[] = []
  const gitOptions: Array<GitRunOptions | undefined> = []
  const gitOverride: Fx['gitOverride'] = { fn: null }
  const reveals: string[] = []
  const opens: OpenCall[] = []
  const openHook: Fx['openHook'] = { fn: null }
  const handleWrap: Fx['handleWrap'] = { fn: null }
  const fs = {
    open: async (path: string, flags: number, mode?: number) => {
      const call = { path, flags, mode }
      opens.push(call)
      openHook.fn?.(call)
      const handle = await openFile(path, flags, mode)
      return handleWrap.fn ? handleWrap.fn(call, handle) : handle
    },
  }
  const runGit = async (repoPath: string, args: string[], limits: GitLimits, options?: GitRunOptions): Promise<GitResult> => {
    const call = { repoPath, args: [...args], limits: { ...limits } }
    gitCalls.push(call)
    gitOptions.push(options === undefined ? undefined : { ...options })
    const canned = gitOverride.fn?.(call) ?? null
    return canned ?? runArtifactGit(repoPath, args, limits, options)
  }
  const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, {
    ...deps, home, ...(opts.passConfig === false ? {} : { config }), now: () => NOW, runGit, fs, reveal: async p => { reveals.push(p) }, openWith: async p => { reveals.push(`open:${p}`) },
  }))
  return {
    home, db, config, base: srv.base, repoDir, repositoryId, commitOid, checkout, outDir, out, durableDir, durable, gitCalls, gitOptions, gitOverride, opens, openHook, handleWrap, reveals,
    close: async () => { await srv.close(); db.close() },
  }
}

const repoDoc = (fx: Fx, rel: string): ArtifactDocumentIdentity => ({ identityKind: 'repository', repositoryId: fx.repositoryId, rootId: null, relativePath: rel })
const rootDoc = (root: ArtifactRootRow, rel: string): ArtifactDocumentIdentity => ({ identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: rel })

type EvidenceOpts = Partial<NonNullable<ArtifactWorkerObservation['evidence']>> & { eventKey: string }

function working(fx: Fx, root: ArtifactRootRow, path: string, identity: ArtifactDocumentIdentity, evidence?: EvidenceOpts): { documentId: string; versionId: string } {
  const obs: ArtifactWorkerObservation = { rootId: root.rootId, identity, kind: 'working', observedAt: OBS, path, stat: statOf(path) }
  if (evidence) obs.evidence = { source: 'hook', sessionId: null, operation: 'touched', certainty: 'unknown', eventAt: OBS, ...evidence }
  const r = recordArtifactObservation(fx.db, obs, NOW)
  return { documentId: r.documentId, versionId: r.versionId! }
}

/** A working file under the output root, created and observed. */
function outFile(fx: Fx, rel: string, content: string | Buffer, evidence?: EvidenceOpts): { documentId: string; versionId: string; path: string } {
  const path = join(fx.outDir, rel)
  writeFileSync(path, content)
  return { ...working(fx, fx.out, path, rootDoc(fx.out, rel), evidence), path }
}

function blobOf(fx: Fx, spec: string): { oid: string; size: number } {
  const oid = git(fx.repoDir, fx.home, 'rev-parse', spec)
  return { oid, size: Number(git(fx.repoDir, fx.home, 'cat-file', '-s', oid)) }
}

function commitVersion(fx: Fx, rel: string, over: { blobOid?: string; size?: number; commitOid?: string } = {}): { documentId: string; versionId: string; blobOid: string; size: number } {
  const real = over.blobOid === undefined ? blobOf(fx, `HEAD:${rel}`) : { oid: over.blobOid, size: over.size ?? 10 }
  const size = over.size ?? real.size
  const r = recordArtifactObservation(fx.db, {
    rootId: fx.checkout.rootId, identity: repoDoc(fx, rel), kind: 'commit', observedAt: OBS,
    git: { repositoryId: fx.repositoryId, commitOid: over.commitOid ?? fx.commitOid, gitPath: rel, blobOid: real.oid, objectFormat: 'sha1', mode: 0o100644, size },
  }, NOW)
  return { documentId: r.documentId, versionId: r.versionId!, blobOid: real.oid, size }
}

function indexVersion(fx: Fx, rel: string): { documentId: string; versionId: string; blobOid: string; size: number } {
  const b = blobOf(fx, `:${rel}`)
  const r = recordArtifactObservation(fx.db, {
    rootId: fx.checkout.rootId, identity: repoDoc(fx, rel), kind: 'index', observedAt: OBS,
    git: { repositoryId: fx.repositoryId, checkoutIdentity: 'ck-main', gitPath: rel, blobOid: b.oid, objectFormat: 'sha1', mode: 0o100644, size: b.size, stage: 0 },
  }, NOW)
  return { documentId: r.documentId, versionId: r.versionId!, blobOid: b.oid, size: b.size }
}

const get = (fx: Fx, path: string, headers: Record<string, string> = {}) => fetch(`${fx.base}${path}`, { headers })
const post = (fx: Fx, path: string, body?: unknown, signal?: AbortSignal) =>
  fetch(`${fx.base}${path}`, { method: 'POST', headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) })

async function expectError(fx: Fx, res: Response, status: number, code: string): Promise<ErrorBody> {
  const text = await res.text()
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status}: ${text}`)
  const body = JSON.parse(text) as ErrorBody
  assert.equal(body.error?.code, code, text)
  assert.equal(typeof body.error.message, 'string')
  assert.ok(!text.includes(fx.home), `error response carries no path: ${text}`)
  return body
}

function count(db: AtlasDb, sql: string, ...params: Array<string | number>): number {
  return (db.raw.prepare(sql).get(...params) as { n: number }).n
}
function setState(db: AtlasDb, key: string, value: string): void {
  db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value, NOW)
}

type Summary = { documentId: string; displayName: string; protected: boolean; availability: string; sessionAssociations: Array<{ sessionId: string; certainty: string }>; locationCount: number; versionCount: number }
type ListBody = { rows: Summary[]; total: number; limit: number; offset: number; coverage: { paused: boolean; roots: Array<{ rootId: string }>; pendingJobs: number } }

async function list(fx: Fx, query = ''): Promise<ListBody> {
  const res = await get(fx, `/api/artifact-documents${query ? `?${query}` : ''}`)
  const text = await res.text()
  assert.equal(res.status, 200, text)
  return JSON.parse(text) as ListBody
}
const names = (b: ListBody) => b.rows.map(r => r.displayName).sort()

// ------------------------------------------------------------------------------------------------------------ documents

test('document list returns each document once across sessions and locations, pages stably and keeps unknown origins', async () => {
  const fx = await fixture()
  try {
    // A: one repository document with two locations (two checkouts of one repository), two sessions and a commit.
    const wtDir = join(fx.home, 'proj-wt')
    mkdirSync(join(wtDir, 'docs'), { recursive: true })
    writeFileSync(join(wtDir, 'docs', 'report.md'), 'linked worktree copy\n')
    const wt = registerArtifactRoot(fx.db, { kind: 'checkout', canonicalPath: wtDir, repositoryId: fx.repositoryId, projectName: 'proj', checkoutIdentity: 'ck-wt', protected: false, scopeFlags: ['checkout'] }, T0)
    const a1 = working(fx, fx.checkout, join(fx.repoDir, 'docs', 'report.md'), repoDoc(fx, 'docs/report.md'), { eventKey: 'a-s1', sessionId: S1, source: 'hook', operation: 'created', certainty: 'recorded' })
    const a2 = working(fx, wt, join(wtDir, 'docs', 'report.md'), repoDoc(fx, 'docs/report.md'), { eventKey: 'a-s2', sessionId: S2, source: 'transcript', operation: 'modified', certainty: 'inferred' })
    assert.equal(a1.documentId, a2.documentId)
    commitVersion(fx, 'docs/report.md')
    const b = outFile(fx, 'b.md', 'unknown origin\n')
    const c = outFile(fx, 'c.md', 'session one\n', { eventKey: 'c-s1', sessionId: S1, source: 'hook', operation: 'created', certainty: 'recorded' })
    const d = outFile(fx, 'script.py', 'print(1)\n')
    const e = commitVersion(fx, 'docs/old.md', { blobOid: 'e'.repeat(40), size: 4 })
    // Protected: a phi segment, a secret-looking name, and a Git-only document under phi/.
    const p1 = outFile(fx, 'phi/notes.md', 'phi notes\n')
    const p2 = outFile(fx, 'credentials.json', '{}\n')
    const p3 = commitVersion(fx, 'phi/plan.md')

    const all = await list(fx)
    assert.equal(all.total, 4)
    assert.equal(all.limit, 50)
    assert.equal(all.offset, 0)
    assert.deepEqual(names(all), ['b.md', 'c.md', 'old.md', 'report.md'])
    assert.equal(new Set(all.rows.map(r => r.documentId)).size, all.rows.length, 'no duplicate document in a page')
    const report = all.rows.find(r => r.documentId === a1.documentId)!
    assert.equal(report.locationCount, 2)
    assert.deepEqual(report.sessionAssociations, [{ sessionId: S1, certainty: 'recorded' }, { sessionId: S2, certainty: 'inferred' }])
    // Unknown origin stays visible in the unfiltered list.
    assert.deepEqual(all.rows.find(r => r.documentId === b.documentId)!.sessionAssociations, [])
    assert.ok(Array.isArray(all.coverage.roots) && typeof all.coverage.paused === 'boolean')

    // Stable pagination: one row per page, the same total on every page, every document exactly once.
    const paged: string[] = []
    for (let offset = 0; offset < 4; offset++) {
      const page = await list(fx, `limit=1&offset=${offset}`)
      assert.equal(page.total, 4)
      assert.equal(page.limit, 1)
      assert.equal(page.offset, offset)
      assert.equal(page.rows.length, 1)
      paged.push(page.rows[0]!.documentId)
    }
    assert.deepEqual(paged, all.rows.map(r => r.documentId))
    assert.deepEqual((await list(fx, 'offset=4')).rows, [])
    assert.equal((await list(fx, 'limit=100000')).limit, 500, 'limit is capped at 500')

    // Session filters match any association, once per document; unknown origin is not invented into a session.
    const s1 = await list(fx, `session=${S1}`)
    assert.deepEqual(names(s1), ['c.md', 'report.md'])
    assert.equal(s1.total, 2)
    assert.deepEqual(names(await list(fx, `session=${S2}`)), ['report.md'])
    assert.deepEqual(names(await list(fx, 'source=transcript')), ['report.md'])
    assert.deepEqual(names(await list(fx, 'source=hook')), ['c.md', 'report.md'])
    assert.deepEqual(names(await list(fx, 'ext=md')), ['b.md', 'c.md', 'old.md', 'report.md'])
    assert.deepEqual(names(await list(fx, 'types=all')), ['b.md', 'c.md', 'old.md', 'report.md', 'script.py'])
    assert.equal(d.documentId.length, 36)
    assert.deepEqual(names(await list(fx, 'availability=git')), ['old.md'])
    assert.equal((await list(fx, 'availability=git')).rows[0]!.documentId, e.documentId)
    assert.deepEqual(names(await list(fx, 'needsPreservation=true')), ['b.md', 'c.md', 'report.md'])
    assert.deepEqual(names(await list(fx, 'needsPreservation=false')), ['old.md'])
    assert.deepEqual(names(await list(fx, 'project=reports')), ['b.md', 'c.md'])
    assert.equal((await list(fx, 'from=2099-01-01')).total, 0)

    // Protected documents: hidden by default (from rows AND total), shown or isolated only on request.
    const shown = await list(fx, 'sensitive=show')
    assert.equal(shown.total, 7)
    assert.deepEqual(names(await list(fx, 'sensitive=only')), ['credentials.json', 'notes.md', 'plan.md'])
    assert.ok((await list(fx, 'sensitive=only')).rows.every(r => r.protected))
    for (const p of [p1, p2, p3]) assert.ok(!all.rows.some(r => r.documentId === p.documentId))
    assert.deepEqual(names(await list(fx, 'availability=git&sensitive=only')), ['plan.md'], 'a Git-only protected document is protected')
    assert.equal((await list(fx, 'availability=git')).total, 1, 'the Git-only protected document is not counted by default')
  } finally {
    await fx.close()
  }
})

test('document list validates every parameter with stable error codes', async () => {
  const fx = await fixture()
  try {
    const bad = [
      'sensitive=bogus', 'availability=everywhere', 'types=some', 'source=email', 'limit=0', 'limit=abc', 'limit=2.5', 'offset=-1',
      'offset=x', 'from=not-a-date', 'to=yesterday', 'needsPreservation=maybe', 'ext=../md', `q=${'x'.repeat(600)}`, 'session=not-a-session',
      'sensitive=show&sensitive=hide', 'project=a%00b',
    ]
    for (const q of bad) await expectError(fx, await get(fx, `/api/artifact-documents?${q}`), 400, 'invalid-parameter')
    // Values are never echoed back into the message.
    const e = await expectError(fx, await get(fx, '/api/artifact-documents?source=SECRET-VALUE'), 400, 'invalid-parameter')
    assert.ok(!e.error.message.includes('SECRET-VALUE'))
  } finally {
    await fx.close()
  }
})

test('document detail paginates locations, versions and evidence separately and never carries bytes', async () => {
  const fx = await fixture()
  try {
    const wtDir = join(fx.home, 'proj-wt')
    mkdirSync(join(wtDir, 'docs'), { recursive: true })
    writeFileSync(join(wtDir, 'docs', 'report.md'), 'linked worktree copy\n')
    const wt = registerArtifactRoot(fx.db, { kind: 'checkout', canonicalPath: wtDir, repositoryId: fx.repositoryId, projectName: 'proj', checkoutIdentity: 'ck-wt', protected: false, scopeFlags: ['checkout'] }, T0)
    const a = working(fx, fx.checkout, join(fx.repoDir, 'docs', 'report.md'), repoDoc(fx, 'docs/report.md'), { eventKey: 'd-1', sessionId: S1, operation: 'created', certainty: 'recorded' })
    working(fx, wt, join(wtDir, 'docs', 'report.md'), repoDoc(fx, 'docs/report.md'), { eventKey: 'd-2', sessionId: S2, certainty: 'inferred' })
    commitVersion(fx, 'docs/report.md')

    const res = await get(fx, `/api/artifact-documents/${a.documentId}?limit=1&locationsOffset=1&versionsOffset=2`)
    const text = await res.text()
    assert.equal(res.status, 200, text)
    assert.ok(!text.includes('working bytes') && !text.includes('linked worktree copy'), 'no document bytes in the detail')
    const body = JSON.parse(text) as {
      document: Summary; locations: Array<{ artifactId: number; path: string }>; versions: Array<{ versionId: string; kind: string; availability: string }>
      evidence: Array<{ sessionId: string | null; certainty: string }>; next: { locations: string | null; versions: string | null; evidence: string | null }
      limit: number; offsets: { locations: number; versions: number; evidence: number }
    }
    assert.equal(body.document.documentId, a.documentId)
    assert.equal(body.document.availability, 'local')
    assert.equal(body.locations.length, 1)
    assert.equal(body.locations[0]!.path, join(wtDir, 'docs', 'report.md'), 'the second location, by its own offset')
    assert.equal(body.versions.length, 1)
    assert.equal(body.evidence.length, 1)
    assert.deepEqual(body.next, { locations: null, versions: null, evidence: '1' })
    assert.deepEqual(body.offsets, { locations: 1, versions: 2, evidence: 0 })
    assert.equal(body.limit, 1)
    const firstVersions = JSON.parse(await (await get(fx, `/api/artifact-documents/${a.documentId}?limit=1`)).text()) as typeof body
    assert.equal(firstVersions.next.versions, '1')
    assert.notEqual(firstVersions.versions[0]!.versionId, body.versions[0]!.versionId, 'versions page independently of locations')

    // Each version names the location it was observed at (working versions only), so the browser can pair a chosen variant with its row.
    const whole = JSON.parse(await (await get(fx, `/api/artifact-documents/${a.documentId}`)).text()) as { locations: Array<{ artifactId: number; path: string }>; versions: Array<{ kind: string; locationArtifactId: number | null }> }
    const pathOf = new Map(whole.locations.map(l => [l.artifactId, l.path]))
    const linked = whole.versions.filter(v => v.kind === 'working').map(v => pathOf.get(v.locationArtifactId!)).sort()
    assert.deepEqual(linked, [join(fx.repoDir, 'docs', 'report.md'), join(wtDir, 'docs', 'report.md')].sort(), 'working versions point at their own location rows')
    assert.ok(whole.versions.filter(v => v.kind !== 'working').every(v => v.locationArtifactId === null), 'Git versions point at no location')

    // A retired (alias) ID resolves to its document.
    fx.db.raw.prepare('INSERT INTO artifact_document_aliases (alias_id, document_id, created_at) VALUES (?, ?, ?)').run(UNKNOWN_ID, a.documentId, NOW)
    const viaAlias = JSON.parse(await (await get(fx, `/api/artifact-documents/${UNKNOWN_ID}`)).text()) as typeof body
    assert.equal(viaAlias.document.documentId, a.documentId)

    // Protected detail: hidden (not found) by default, visible with sensitive=show or only; `only` hides the rest.
    const p = outFile(fx, 'phi/notes.md', 'phi notes\n')
    await expectError(fx, await get(fx, `/api/artifact-documents/${p.documentId}`), 404, 'not-found')
    assert.equal((await get(fx, `/api/artifact-documents/${p.documentId}?sensitive=show`)).status, 200)
    assert.equal((await get(fx, `/api/artifact-documents/${p.documentId}?sensitive=only`)).status, 200)
    await expectError(fx, await get(fx, `/api/artifact-documents/${a.documentId}?sensitive=only`), 404, 'not-found')

    // ArtifactDocumentNotFoundError -> 404; malformed IDs -> 400 before any lookup.
    await expectError(fx, await get(fx, '/api/artifact-documents/7d1c7a52-0000-4000-8000-000000000000'), 404, 'not-found')
    for (const id of ['abc', '123', '..%2F..%2Fetc', `${a.documentId}x`, '%20'])
      await expectError(fx, await get(fx, `/api/artifact-documents/${id}`), 400, 'invalid-id')
    await expectError(fx, await get(fx, `/api/artifact-documents/${a.documentId}?limit=0`), 400, 'invalid-parameter')
    await expectError(fx, await get(fx, `/api/artifact-documents/${a.documentId}?versionsOffset=-2`), 400, 'invalid-parameter')
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ preview

test('local preview serves exactly the selected version and refuses a changed, swapped, missing or protected file', async () => {
  const fx = await fixture()
  try {
    const reportPath = join(fx.repoDir, 'docs', 'report.md')
    const report = working(fx, fx.checkout, reportPath, repoDoc(fx, 'docs/report.md'))
    let res = await get(fx, `/api/artifact-versions/${report.versionId}/preview`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), WORKING)
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin')
    assert.equal(fx.gitCalls.length, 0, 'a local preview runs no Git')
    const opened = fx.opens.find(o => o.path === reportPath)!
    assert.equal(opened.flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW, 'opened without following a final symlink')
    assert.equal(opened.flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR), 0, 'opened read-only')

    // HTML keeps the sandbox CSP.
    const html = outFile(fx, 'page.html', '<script>alert(1)</script>')
    res = await get(fx, `/api/artifact-versions/${html.versionId}/preview`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-security-policy'), "sandbox; default-src 'none'")
    await res.arrayBuffer()

    // A changed file never masquerades as its historical version, and its new bytes are not served.
    writeFileSync(reportPath, `${WORKING}appended secret line\n`)
    res = await get(fx, `/api/artifact-versions/${report.versionId}/preview`)
    const changed = await expectError(fx, res, 409, 'local-version-changed')
    assert.ok(!JSON.stringify(changed).includes('appended'))
    const newer = working(fx, fx.checkout, reportPath, repoDoc(fx, 'docs/report.md'))
    assert.notEqual(newer.versionId, report.versionId)
    assert.equal(await (await get(fx, `/api/artifact-versions/${newer.versionId}/preview`)).text(), `${WORKING}appended secret line\n`)
    await expectError(fx, await get(fx, `/api/artifact-versions/${report.versionId}/preview`), 409, 'local-version-changed')

    // A symlink swapped in at the location is never followed.
    const swap = outFile(fx, 'swap.md', 'original\n')
    writeFileSync(join(fx.outDir, 'target.md'), 'symlink target bytes\n')
    unlinkSync(swap.path)
    symlinkSync(join(fx.outDir, 'target.md'), swap.path)
    res = await get(fx, `/api/artifact-versions/${swap.versionId}/preview`)
    const swapped = await expectError(fx, res, 409, 'local-version-changed')
    assert.ok(!JSON.stringify(swapped).includes('symlink target bytes'))

    // A swap that races the authorization (between the check and the open) is still refused.
    const raced = outFile(fx, 'raced.md', 'raced original\n')
    writeFileSync(join(fx.outDir, 'decoy.md'), 'decoy bytes\n')
    fx.openHook.fn = call => {
      if (call.path !== raced.path) return
      unlinkSync(raced.path)
      symlinkSync(join(fx.outDir, 'decoy.md'), raced.path)
    }
    const racedError = await expectError(fx, await get(fx, `/api/artifact-versions/${raced.versionId}/preview`), 409, 'local-version-changed')
    assert.ok(!JSON.stringify(racedError).includes('decoy'))
    fx.openHook.fn = null

    // Only the location's current version is served, even when the file itself is untouched.
    const pinned = outFile(fx, 'pinned.md', 'pinned\n')
    const other = outFile(fx, 'other.md', 'other\n')
    assert.equal((await get(fx, `/api/artifact-versions/${pinned.versionId}/preview`)).status, 200)
    fx.db.raw.prepare('UPDATE artifacts SET current_version_id = ? WHERE path = ?').run(other.versionId, pinned.path)
    await expectError(fx, await get(fx, `/api/artifact-versions/${pinned.versionId}/preview`), 409, 'local-version-changed')

    const gone = outFile(fx, 'gone.md', 'soon gone\n')
    unlinkSync(gone.path)
    await expectError(fx, await get(fx, `/api/artifact-versions/${gone.versionId}/preview`), 409, 'local-file-missing')

    // Size cap and the MIME allowlist.
    const big = outFile(fx, 'big.txt', Buffer.alloc(2_000_001, 0x61))
    await expectError(fx, await get(fx, `/api/artifact-versions/${big.versionId}/preview`), 413, 'too-large')
    const pdf = outFile(fx, 'doc.pdf', '%PDF-1.4\n')
    await expectError(fx, await get(fx, `/api/artifact-versions/${pdf.versionId}/preview`), 415, 'preview-unsupported')

    // Protected and secret-looking files: hidden by default, never previewed even when shown.
    const phi = outFile(fx, 'phi/notes.md', 'phi notes\n')
    await expectError(fx, await get(fx, `/api/artifact-versions/${phi.versionId}/preview`), 404, 'not-found')
    await expectError(fx, await get(fx, `/api/artifact-versions/${phi.versionId}/preview?sensitive=show`), 403, 'protected')
    const cred = outFile(fx, 'credentials.json', '{"token":"x"}\n')
    await expectError(fx, await get(fx, `/api/artifact-versions/${cred.versionId}/preview?sensitive=show`), 403, 'protected')

    // Re-authorized at action time: a location whose root is no longer registered is refused before it is opened.
    const loose = join(fx.home, 'loose')
    mkdirSync(loose)
    const looseRoot = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: loose, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    writeFileSync(join(loose, 'n.md'), 'loose\n')
    const looseVersion = working(fx, looseRoot, join(loose, 'n.md'), rootDoc(looseRoot, 'n.md'))
    assert.equal((await get(fx, `/api/artifact-versions/${looseVersion.versionId}/preview`)).status, 200)
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(looseRoot.rootId)
    await expectError(fx, await get(fx, `/api/artifact-versions/${looseVersion.versionId}/preview`), 403, 'path-not-allowed')

    // Same-origin: a cross-site browser fetch is refused.
    await expectError(fx, await get(fx, `/api/artifact-versions/${newer.versionId}/preview`, { 'sec-fetch-site': 'cross-site' }), 403, 'cross-origin')

    await expectError(fx, await get(fx, '/api/artifact-versions/not-a-uuid/preview'), 400, 'invalid-id')
    await expectError(fx, await get(fx, `/api/artifact-versions/${UNKNOWN_ID}/preview`), 404, 'not-found')
    await expectError(fx, await get(fx, `/api/artifact-versions/${newer.versionId}/preview?sensitive=everything`), 400, 'invalid-parameter')
  } finally {
    await fx.close()
  }
})

test('Git preview reads only the stored blob, verifies its size and refuses LFS pointers and missing objects', async () => {
  const fx = await fixture()
  try {
    const w = working(fx, fx.checkout, join(fx.repoDir, 'docs', 'report.md'), repoDoc(fx, 'docs/report.md'))
    const c = commitVersion(fx, 'docs/report.md')
    const i = indexVersion(fx, 'docs/report.md')
    assert.equal(w.documentId, c.documentId)
    assert.equal(c.documentId, i.documentId)

    // Exact version selection: the commit, the staged snapshot and the working file each serve their own bytes.
    let res = await get(fx, `/api/artifact-versions/${c.versionId}/preview`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), COMMITTED)
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(fx.gitCalls.at(-1), { repoPath: fx.repoDir, args: ['cat-file', 'blob', c.blobOid], limits: { timeoutMs: 10_000, maxOutputBytes: 2_000_001 } })
    assert.equal(await (await get(fx, `/api/artifact-versions/${i.versionId}/preview`)).text(), STAGED)
    assert.deepEqual(fx.gitCalls.at(-1)!.args, ['cat-file', 'blob', i.blobOid])
    assert.equal(await (await get(fx, `/api/artifact-versions/${w.versionId}/preview`)).text(), WORKING)

    const pointer = commitVersion(fx, 'docs/pointer.md')
    await expectError(fx, await get(fx, `/api/artifact-versions/${pointer.versionId}/preview`), 410, 'lfs-payload-unavailable')
    const missing = commitVersion(fx, 'docs/missing.md', { blobOid: 'ab'.repeat(20), size: 12 })
    await expectError(fx, await get(fx, `/api/artifact-versions/${missing.versionId}/preview`), 410, 'git-object-unavailable')
    const wrongSize = commitVersion(fx, 'docs/report.md', { commitOid: 'cd'.repeat(20), blobOid: c.blobOid, size: c.size + 5 })
    await expectError(fx, await get(fx, `/api/artifact-versions/${wrongSize.versionId}/preview`), 410, 'git-object-unavailable')
    const smaller = commitVersion(fx, 'docs/report.md', { commitOid: 'ce'.repeat(20), blobOid: c.blobOid, size: c.size - 3 })
    await expectError(fx, await get(fx, `/api/artifact-versions/${smaller.versionId}/preview`), 410, 'git-object-unavailable')

    // Oversized by stored metadata: refused before any Git process.
    const before = fx.gitCalls.length
    const huge = commitVersion(fx, 'docs/huge.md', { blobOid: 'cf'.repeat(20), size: 2_000_001 })
    await expectError(fx, await get(fx, `/api/artifact-versions/${huge.versionId}/preview`), 413, 'too-large')
    assert.equal(fx.gitCalls.length, before)

    // Injected adapter failures: path-free structured errors.
    fx.gitOverride.fn = () => cannedGit({ exitCode: null, timedOut: true, error: 'timeout', incomplete: true })
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview`), 503, 'git-unavailable')
    fx.gitOverride.fn = () => cannedGit({ exitCode: 128, error: 'exit-nonzero', incomplete: true, stderr: `fatal: detected dubious ownership in repository at '${fx.repoDir}'` })
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview`), 409, 'unsafe-repository')
    fx.gitOverride.fn = () => cannedGit({ exitCode: null, error: 'helper-unresolved', incomplete: true, filterState: 'unresolved' })
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview`), 503, 'git-unavailable')
    fx.gitOverride.fn = null

    // Protected Git-only document: hidden by default, never previewed.
    const plan = commitVersion(fx, 'phi/plan.md')
    await expectError(fx, await get(fx, `/api/artifact-versions/${plan.versionId}/preview`), 404, 'not-found')
    const calls = fx.gitCalls.length
    await expectError(fx, await get(fx, `/api/artifact-versions/${plan.versionId}/preview?sensitive=show`), 403, 'protected')
    assert.equal(fx.gitCalls.length, calls, 'a protected blob is never read')

    // A name that became secret-looking after its document was catalogued (a sensitivePatterns addition) is refused too.
    const vault = commitVersion(fx, 'docs/vault.private.md', { blobOid: c.blobOid, size: c.size })
    assert.equal(await (await get(fx, `/api/artifact-versions/${vault.versionId}/preview`)).text(), COMMITTED)
    configureSensitivePatterns(['*.private.md'])
    try {
      await expectError(fx, await get(fx, `/api/artifact-versions/${vault.versionId}/preview`), 403, 'protected')
    } finally {
      configureSensitivePatterns([])
    }

    // A document protected only by a protected root (no secret-looking name, no phi segment) is refused on its flag alone.
    registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: join(fx.repoDir, 'docs'), repositoryId: fx.repositoryId, projectName: 'proj', checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T0)
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview`), 404, 'not-found')
    const protectedCalls = fx.gitCalls.length
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview?sensitive=show`), 403, 'protected')
    assert.equal(fx.gitCalls.length, protectedCalls)

    // No registered checkout of the repository: nothing to run Git in.
    const readme = commitVersion(fx, 'README.md', { blobOid: c.blobOid, size: c.size })
    assert.equal(await (await get(fx, `/api/artifact-versions/${readme.versionId}/preview`)).text(), COMMITTED)
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(fx.checkout.rootId)
    await expectError(fx, await get(fx, `/api/artifact-versions/${readme.versionId}/preview`), 409, 'git-repository-unavailable')
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ export

test('export writes a committed or staged blob to the durable root privately, collision-safe and never overwriting', async () => {
  const fx = await fixture()
  try {
    const c = commitVersion(fx, 'docs/report.md')
    const exportOf = (versionId: string, query = '', body?: unknown) => post(fx, `/api/artifact-versions/${versionId}/export${query}`, body)
    type Exported = { versionId: string; rootId: string; fileName: string; path: string; sizeBytes: number; kind: string }

    let res = await exportOf(c.versionId)
    let text = await res.text()
    assert.equal(res.status, 201, text)
    const first = JSON.parse(text) as Exported
    assert.equal(first.versionId, c.versionId)
    assert.equal(first.rootId, fx.durable.rootId)
    assert.equal(first.sizeBytes, c.size)
    assert.equal(first.path, join(fx.durableDir, first.fileName))
    assert.ok(!first.fileName.includes('/') && !first.fileName.startsWith('.'))
    assert.match(first.fileName, /\.md$/)
    assert.equal(readFileSync(first.path, 'utf8'), COMMITTED)
    assert.equal(statSync(first.path).mode & 0o777, 0o600)
    assert.deepEqual(fx.gitCalls.at(-1), { repoPath: fx.repoDir, args: ['cat-file', 'blob', c.blobOid], limits: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 * 1024 + 1 } })
    const created = fx.opens.find(o => o.path === first.path)!
    const exclusive = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
    assert.equal(created.flags & exclusive, exclusive, 'create-exclusive, write-only, no symlink following')
    assert.equal(created.mode, 0o600)

    // A second export never overwrites the first.
    const second = JSON.parse(await (await exportOf(c.versionId)).text()) as Exported
    assert.notEqual(second.fileName, first.fileName)
    assert.equal(readFileSync(first.path, 'utf8'), COMMITTED)

    // A symlink planted at the next name is neither followed nor replaced.
    const victim = join(fx.home, 'victim.txt')
    writeFileSync(victim, 'victim\n')
    unlinkSync(first.path)
    symlinkSync(victim, first.path)
    const third = JSON.parse(await (await exportOf(c.versionId)).text()) as Exported
    assert.ok(![first.fileName, second.fileName].includes(third.fileName))
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n')
    assert.ok(lstatSync(first.path).isSymbolicLink())
    for (const name of readdirSync(fx.durableDir)) {
      const st = lstatSync(join(fx.durableDir, name))
      if (st.isFile()) assert.equal(st.mode & 0o777, 0o600, name)
    }

    // A staged snapshot exports too, labelled as staged.
    const i = indexVersion(fx, 'docs/report.md')
    res = await exportOf(i.versionId)
    text = await res.text()
    assert.equal(res.status, 201, text)
    const staged = JSON.parse(text) as Exported
    assert.equal(staged.kind, 'index')
    assert.match(staged.fileName, /staged/)
    assert.equal(readFileSync(staged.path, 'utf8'), STAGED)

    const filesNow = () => readdirSync(fx.durableDir).sort()
    const snapshot = filesNow()

    // Never a working version; never a client-chosen destination; never a missing or LFS object.
    const w = working(fx, fx.checkout, join(fx.repoDir, 'docs', 'report.md'), repoDoc(fx, 'docs/report.md'))
    await expectError(fx, await exportOf(w.versionId), 409, 'version-not-exportable')
    await expectError(fx, await exportOf(c.versionId, '', { destination: join(fx.home, 'elsewhere') }), 400, 'invalid-body')
    await expectError(fx, await exportOf(c.versionId, '', { name: 'chosen.md' }), 400, 'invalid-body')
    await expectError(fx, await exportOf(c.versionId, '', [1]), 400, 'invalid-body')
    const pointer = commitVersion(fx, 'docs/pointer.md')
    await expectError(fx, await exportOf(pointer.versionId), 410, 'lfs-payload-unavailable')
    const missing = commitVersion(fx, 'docs/missing.md', { blobOid: 'ab'.repeat(20), size: 12 })
    await expectError(fx, await exportOf(missing.versionId), 410, 'git-object-unavailable')
    const before = fx.gitCalls.length
    const huge = commitVersion(fx, 'docs/huge.md', { blobOid: 'cf'.repeat(20), size: 64 * 1024 * 1024 + 1 })
    await expectError(fx, await exportOf(huge.versionId), 413, 'too-large')
    assert.equal(fx.gitCalls.length, before, 'the size cap applies before Git runs')
    assert.deepEqual(filesNow(), snapshot, 'refused exports write nothing')

    // Protected documents: hidden by default; with sensitive=show only into a protected durable root; secret-looking never.
    const plan = commitVersion(fx, 'phi/plan.md')
    await expectError(fx, await exportOf(plan.versionId), 404, 'not-found')
    await expectError(fx, await exportOf(plan.versionId, '?sensitive=show'), 403, 'protected')
    const phiDir = join(fx.durableDir, 'PHI')
    mkdirSync(phiDir, { mode: 0o700 })
    chmodSync(phiDir, 0o700)
    const phiRoot = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: phiDir, repositoryId: fx.repositoryId, projectName: 'proj', checkoutIdentity: null, protected: true, scopeFlags: ['cli-output'] }, T0)
    res = await exportOf(plan.versionId, '?sensitive=show')
    text = await res.text()
    assert.equal(res.status, 201, text)
    const planned = JSON.parse(text) as Exported
    assert.equal(planned.rootId, phiRoot.rootId)
    assert.equal(readFileSync(planned.path, 'utf8'), PLAN)
    const cred = commitVersion(fx, 'docs/credentials.json')
    await expectError(fx, await exportOf(cred.versionId, '?sensitive=show'), 403, 'protected')
    // Unprotected documents still go to the unprotected durable root.
    assert.equal((JSON.parse(await (await exportOf(c.versionId)).text()) as Exported).rootId, fx.durable.rootId)

    // The destination must be private, real (no symlinked root) and registered under the durable base.
    chmodSync(fx.durableDir, 0o755)
    await expectError(fx, await exportOf(c.versionId), 409, 'output-root-not-private')
    chmodSync(fx.durableDir, 0o700)
    const elsewhere = join(fx.home, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    renameSync(fx.durableDir, `${fx.durableDir}-moved`)
    symlinkSync(elsewhere, fx.durableDir)
    await expectError(fx, await exportOf(c.versionId), 409, 'output-root-unavailable')
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing is written through a symlinked root')
    unlinkSync(fx.durableDir)
    renameSync(`${fx.durableDir}-moved`, fx.durableDir)
    // A symlinked ancestor of the durable folder is refused before any file is created...
    const projectDir = join(fx.config.artifacts.durableOutputBase, fx.repositoryId)
    const decoyDir = join(fx.home, 'decoy-project')
    mkdirSync(join(decoyDir, 'deliverables'), { recursive: true, mode: 0o700 })
    chmodSync(join(decoyDir, 'deliverables'), 0o700)
    const swapAncestor = () => { renameSync(projectDir, `${projectDir}-moved`); symlinkSync(decoyDir, projectDir) }
    const restoreAncestor = () => { unlinkSync(projectDir); renameSync(`${projectDir}-moved`, projectDir) }
    swapAncestor()
    await expectError(fx, await exportOf(c.versionId), 409, 'output-root-unavailable')
    restoreAncestor()
    // ...and a swap racing the exclusive create leaves nothing behind in the wrong place.
    fx.openHook.fn = call => { if (call.path.startsWith(`${fx.durableDir}/`)) { fx.openHook.fn = null; swapAncestor() } }
    try {
      await expectError(fx, await exportOf(c.versionId), 409, 'export-failed')
    } finally {
      fx.openHook.fn = null
      restoreAncestor()
    }
    assert.deepEqual(readdirSync(join(decoyDir, 'deliverables')), [], 'the racing create was removed')
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id IN (?, ?)').run(fx.durable.rootId, phiRoot.rootId)
    // An output root of the repository outside the durable base is not a durable destination.
    const loose = join(fx.home, 'exports')
    mkdirSync(loose, { mode: 0o700 })
    registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: loose, repositoryId: fx.repositoryId, projectName: 'proj', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    await expectError(fx, await exportOf(c.versionId), 409, 'no-output-root')
    assert.deepEqual(readdirSync(loose), [])

    await expectError(fx, await exportOf('nope'), 400, 'invalid-id')
    await expectError(fx, await exportOf(UNKNOWN_ID), 404, 'not-found')
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ status

test('status merges coverage reasons, failures, include-older, facility and health, redacting protected root paths', async () => {
  const fx = await fixture()
  try {
    const phiDir = join(fx.home, 'clinic', 'phi')
    mkdirSync(phiDir, { recursive: true })
    const phiRoot = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: phiDir, repositoryId: null, projectName: 'clinic', checkoutIdentity: null, protected: true, scopeFlags: ['cli-output'] }, T0)
    const directDir = join(fx.home, 'direct')
    mkdirSync(directDir)
    const direct = registerArtifactRoot(fx.db, { kind: 'session-directory', canonicalPath: directDir, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T0)
    fx.db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'partial', last_successful_at = ? WHERE root_id = ?`).run(T0, fx.checkout.rootId)
    setState(fx.db, `coverage-reason:${fx.checkout.rootId}`, JSON.stringify({ task: 'checkout-status', codes: ['nested-checkout'], complete: true, at: NOW }))
    setState(fx.db, `job-failed:git-history:${fx.checkout.rootId}`, 'git-timeout')
    setState(fx.db, `include-older:output-walk:${fx.out.rootId}`, '1')
    // A legacy root-wide key is ignored.
    setState(fx.db, `include-older:${fx.checkout.rootId}`, '1')
    // A complete pass that resolved its nested worktrees is not partial.
    setState(fx.db, `coverage-reason:${fx.durable.rootId}`, JSON.stringify({ task: 'output-walk', codes: [], info: 'nested-worktrees-registered', complete: true, at: NOW }))
    fx.db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'inaccessible', last_error = 'root-inaccessible' WHERE root_id = ?`).run(phiRoot.rootId)
    setState(fx.db, 'worker.priority-facility', 'unavailable')
    setState(fx.db, 'worker.priority-command', '/usr/bin/nice')
    setState(fx.db, 'health.worker-crashes', '2')
    setState(fx.db, 'health.slices', '7')

    type RootStatus = {
      rootId: string; kind: string; path: string | null; pathRedacted: boolean; protected: boolean; directOnly: boolean; state: string; reason: string | null
      includeOlderPending: boolean; lastSuccessfulAt: string | null; failures: Array<{ task: string; code: string }>; gaps: string[]
    }
    type Status = { paused: boolean; roots: RootStatus[]; pendingJobs: number; oldestQueueAgeMs: number; priorityFacility: string | null; health: Record<string, number> }
    let res = await get(fx, '/api/artifact-manager/status')
    let text = await res.text()
    assert.equal(res.status, 200, text)
    assert.ok(!text.includes(phiDir) && !text.includes('clinic/phi'), 'a protected root path is redacted by default')
    assert.ok(!text.includes('/usr/bin/nice'), 'no wrapper paths in status')
    const status = JSON.parse(text) as Status
    assert.equal(status.paused, false)
    assert.equal(status.priorityFacility, 'unavailable')
    assert.deepEqual(status.health, { slices: 7, 'worker-crashes': 2 })
    const byId = new Map(status.roots.map(r => [r.rootId, r]))
    const phi = byId.get(phiRoot.rootId)!
    assert.equal(phi.path, null)
    assert.equal(phi.pathRedacted, true)
    assert.equal(phi.state, 'inaccessible')
    assert.match(phi.reason!, /inaccessible/i)
    const ck = byId.get(fx.checkout.rootId)!
    assert.equal(ck.path, fx.repoDir)
    assert.equal(ck.state, 'partial')
    assert.equal(ck.lastSuccessfulAt, T0)
    assert.deepEqual(ck.gaps, ['nested-checkout'])
    assert.deepEqual(ck.failures, [{ task: 'git-history', code: 'git-timeout' }])
    assert.match(ck.reason!, /nested/i)
    assert.match(ck.reason!, /history/i)
    const out = byId.get(fx.out.rootId)!
    assert.equal(out.includeOlderPending, true)
    assert.match(out.reason!, /older/i)
    assert.equal(byId.get(fx.checkout.rootId)!.includeOlderPending, false)
    const durable = byId.get(fx.durable.rootId)!
    assert.deepEqual(durable.gaps, [])
    assert.ok(durable.reason === null || !/partial/i.test(durable.reason))
    assert.equal(byId.get(direct.rootId)!.directOnly, true)
    for (const r of status.roots) if (r.reason !== null) assert.ok(!r.reason.includes('/'), `reason is path-free: ${r.reason}`)

    res = await get(fx, '/api/artifact-manager/status?sensitive=show')
    text = await res.text()
    assert.equal((JSON.parse(text) as Status).roots.find(r => r.rootId === phiRoot.rootId)!.path, phiDir)
    const only = JSON.parse(await (await get(fx, '/api/artifact-manager/status?sensitive=only')).text()) as Status
    assert.deepEqual(only.roots.map(r => r.rootId), [phiRoot.rootId])
    await expectError(fx, await get(fx, '/api/artifact-manager/status?sensitive=yes'), 400, 'invalid-parameter')

    // The document list carries the same coverage view.
    const listed = await list(fx)
    assert.ok(!JSON.stringify(listed).includes(phiDir))
    assert.ok(listed.coverage.roots.some(r => r.rootId === fx.checkout.rootId))
  } finally {
    await fx.close()
  }
})

test('status exposes each root\'s repository ID, also for a protected root whose path is redacted (R53)', async () => {
  const fx = await fixture()
  try {
    const phiDir = join(fx.home, 'clinic', 'phi')
    mkdirSync(phiDir, { recursive: true })
    const phiRoot = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: phiDir, repositoryId: fx.repositoryId, projectName: 'clinic', checkoutIdentity: null, protected: true, scopeFlags: ['cli-output'] }, T0)
    type RootIds = { rootId: string; path: string | null; pathRedacted: boolean; repositoryId?: string | null }
    const res = await get(fx, '/api/artifact-manager/status')
    const text = await res.text()
    assert.equal(res.status, 200, text)
    assert.ok(!text.includes(phiDir) && !text.includes('clinic/phi'), 'the protected path stays redacted')
    const roots = new Map((JSON.parse(text) as { roots: RootIds[] }).roots.map(r => [r.rootId, r]))
    assert.equal(roots.get(fx.checkout.rootId)!.repositoryId, fx.repositoryId)
    assert.equal(roots.get(fx.durable.rootId)!.repositoryId, fx.repositoryId)
    assert.equal(roots.get(fx.out.rootId)!.repositoryId, null, 'a root of no repository reports null, not a missing field')
    const phi = roots.get(phiRoot.rootId)!
    assert.equal(phi.pathRedacted, true)
    assert.equal(phi.path, null)
    assert.equal(phi.repositoryId, fx.repositoryId, 'a repository ID is not sensitive')
    // The document list carries the same coverage view.
    assert.ok((await list(fx)).coverage.roots.some(r => (r as RootIds).repositoryId === fx.repositoryId))
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ refresh, pause, resume

test('refresh queues a registered root and returns 202 with a job ID without scanning', async () => {
  const fx = await fixture()
  try {
    writeFileSync(join(fx.outDir, 'fresh.md'), 'not yet catalogued\n')
    const locations = count(fx.db, 'SELECT COUNT(*) AS n FROM artifacts')
    let res = await post(fx, '/api/artifact-manager/refresh', { rootId: fx.out.rootId })
    let text = await res.text()
    assert.equal(res.status, 202, text)
    const queued = JSON.parse(text) as { jobId: string; rootId: string; includeOlder: boolean }
    assert.equal(queued.rootId, fx.out.rootId)
    assert.equal(queued.includeOlder, false)
    const job = fx.db.raw.prepare('SELECT scope_id, task_kind, state FROM artifact_jobs WHERE job_id = ?').get(queued.jobId) as { scope_id: string; task_kind: string; state: string }
    assert.deepEqual({ ...job }, { scope_id: fx.out.rootId, task_kind: 'output-walk', state: 'queued' })
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifacts'), locations, 'the request itself observes nothing')
    assert.equal(findArtifactByPath(fx.db, join(fx.outDir, 'fresh.md')), null)
    assert.equal(fx.gitCalls.length, 0)
    assert.equal((fx.db.raw.prepare('SELECT coverage_state FROM artifact_roots WHERE root_id = ?').get(fx.out.rootId) as { coverage_state: string }).coverage_state, 'queued')
    // Repeated refreshes coalesce into one job.
    assert.equal((JSON.parse(await (await post(fx, '/api/artifact-manager/refresh', { rootId: fx.out.rootId })).text()) as { jobId: string }).jobId, queued.jobId)

    // A checkout queues its status pass and its repository's history; "Import older files" is recorded for the runner.
    res = await post(fx, '/api/artifact-manager/refresh', { rootId: fx.checkout.rootId, includeOlder: true })
    text = await res.text()
    assert.equal(res.status, 202, text)
    const ck = JSON.parse(text) as { jobId: string; includeOlder: boolean }
    assert.equal(ck.includeOlder, true)
    const tasks = (fx.db.raw.prepare('SELECT task_kind FROM artifact_jobs WHERE scope_id = ? ORDER BY task_kind').all(fx.checkout.rootId) as Array<{ task_kind: string }>).map(r => r.task_kind)
    assert.deepEqual(tasks, ['checkout-status', 'git-history'])
    assert.equal((fx.db.raw.prepare('SELECT task_kind FROM artifact_jobs WHERE job_id = ?').get(ck.jobId) as { task_kind: string }).task_kind, 'checkout-status')
    // One request per task the refresh queued, each consumed by that task's own pass.
    const requests = (fx.db.raw.prepare(`SELECT key, value FROM artifact_manager_state WHERE key LIKE 'include-older:%' ORDER BY key`).all() as Array<{ key: string; value: string }>)
      .map(r => `${r.key}=${r.value}`)
    assert.deepEqual(requests, [`include-older:checkout-status:${fx.checkout.rootId}=1`, `include-older:git-history:${fx.checkout.rootId}=1`])

    // Refusals: unknown, direct-only, inactive, malformed.
    const jobs = count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_jobs')
    await expectError(fx, await post(fx, '/api/artifact-manager/refresh', { rootId: UNKNOWN_ID }), 404, 'root-not-found')
    const directDir = join(fx.home, 'direct')
    mkdirSync(directDir)
    const direct = registerArtifactRoot(fx.db, { kind: 'session-directory', canonicalPath: directDir, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T0)
    await expectError(fx, await post(fx, '/api/artifact-manager/refresh', { rootId: direct.rootId }), 409, 'direct-only-root')
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(fx.durable.rootId)
    await expectError(fx, await post(fx, '/api/artifact-manager/refresh', { rootId: fx.durable.rootId }), 409, 'root-inactive')
    for (const body of [{}, { rootId: 'abc' }, { rootId: fx.out.rootId, includeOlder: 'yes' }, { rootId: fx.out.rootId, path: '/' }, [fx.out.rootId], 'x', null])
      await expectError(fx, await post(fx, '/api/artifact-manager/refresh', body), 400, 'invalid-body')
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_jobs'), jobs, 'refused refreshes queue nothing')
    const bad = await fetch(`${fx.base}/api/artifact-manager/refresh`, { method: 'POST', headers: JSON_HEADERS, body: '{not json' })
    await expectError(fx, bad, 400, 'invalid-body')
  } finally {
    await fx.close()
  }
})

/** A deterministic in-process worker for the runner: every request ends in one complete terminal frame. */
function fakeWorker(): { client: ArtifactWorkerClient; requests: ArtifactWorkerRequest[] } {
  const requests: ArtifactWorkerRequest[] = []
  const events: ArtifactWorkerEvent[] = []
  const client: ArtifactWorkerClient = {
    start(req) {
      requests.push(structuredClone(req))
      events.push({ type: 'frame', frame: { type: 'batch', jobId: req.jobId, rows: [], cursor: req.task === 'git-history' ? 'tips-1' : null, complete: true, coverage: 'complete', counts: { visited: 1, eligible: 0, skipped: 0 } } })
    },
    poll: () => events.shift() ?? null,
    async wait() {},
    ack() {},
    restart() { events.length = 0 },
    stop() {},
    status: () => ({ running: true, pid: null, activeJobId: null, priorityFacility: 'applied', priorityCommand: 'test', liveGroups: [], spawns: 0, crashes: 0, gitChildrenSeen: 0 }),
  }
  return { client, requests }
}

test('Import older files reaches every pass: the status pass finishing first leaves the history request, and status shows it until both ran', async () => {
  const fx = await fixture()
  const worker = fakeWorker()
  const r = artifactManagerRunner({
    db: fx.db, config: fx.config, log: silentLogger, worker: worker.client, home: fx.home, clock: () => Date.parse(NOW) + 1_000, autoSchedule: false, frameWaitMs: 0,
  })
  try {
    const res = await post(fx, '/api/artifact-manager/refresh', { rootId: fx.checkout.rootId, includeOlder: true })
    const text = await res.text()
    assert.equal(res.status, 202, text)
    const queued = JSON.parse(text) as { jobId: string; rootId: string; includeOlder: boolean; historyJobId: string | null }
    assert.equal(queued.includeOlder, true)
    // Force the claim order: the status pass first.
    fx.db.raw.prepare('UPDATE artifact_jobs SET updated_at = ? WHERE job_id = ?').run('2026-10-27T12:00:00.500Z', queued.historyJobId)
    const pending = async () => (JSON.parse(await (await get(fx, '/api/artifact-manager/status')).text()) as { roots: Array<{ rootId: string; includeOlderPending: boolean }> })
      .roots.find(x => x.rootId === fx.checkout.rootId)!.includeOlderPending
    assert.equal(await pending(), true)
    await r.run()
    await r.run()
    assert.deepEqual(worker.requests.map(q => [q.task, q.includeOlder]), [['checkout-status', true]])
    assert.equal(await pending(), true, 'the history pass has not run yet')
    await r.run()
    await r.run()
    assert.deepEqual(worker.requests.map(q => [q.task, q.includeOlder]), [['checkout-status', true], ['git-history', true]])
    assert.equal(await pending(), false)
    assert.equal(count(fx.db, `SELECT COUNT(*) AS n FROM artifact_manager_state WHERE key LIKE 'include-older:%'`), 0)
  } finally {
    r.stop?.()
    await fx.close()
  }
})

test('concurrent Import older files refreshes coalesce to one job per scope; a direct-only root is refused and records no request', async () => {
  const fx = await fixture()
  try {
    const all = await Promise.all(Array.from({ length: 5 }, () => post(fx, '/api/artifact-manager/refresh', { rootId: fx.checkout.rootId, includeOlder: true })))
    const bodies = await Promise.all(all.map(async res => {
      const text = await res.text()
      assert.equal(res.status, 202, text)
      return JSON.parse(text) as { jobId: string; rootId: string; includeOlder: boolean; historyJobId: string | null }
    }))
    assert.equal(new Set(bodies.map(b => b.jobId)).size, 1)
    assert.equal(new Set(bodies.map(b => b.historyJobId)).size, 1)
    assert.ok(bodies.every(b => b.rootId === fx.checkout.rootId && b.includeOlder === true))
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_jobs WHERE scope_id = ?', fx.checkout.rootId), 2)
    assert.equal(count(fx.db, `SELECT COUNT(*) AS n FROM artifact_manager_state WHERE key LIKE 'include-older:%'`), 2)

    const directDir = join(fx.home, 'direct')
    mkdirSync(directDir)
    const direct = registerArtifactRoot(fx.db, { kind: 'session-directory', canonicalPath: directDir, repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['direct-only'] }, T0)
    await expectError(fx, await post(fx, '/api/artifact-manager/refresh', { rootId: direct.rootId, includeOlder: true }), 409, 'direct-only-root')
    assert.equal(count(fx.db, `SELECT COUNT(*) AS n FROM artifact_manager_state WHERE key LIKE 'include-older:%' AND key LIKE ?`, `%${direct.rootId}`), 0)
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_jobs WHERE scope_id = ?', direct.rootId), 0)
  } finally {
    await fx.close()
  }
})

test('pause and resume are idempotent and reflected in status', async () => {
  const fx = await fixture()
  try {
    const paused = async () => (JSON.parse(await (await get(fx, '/api/artifact-manager/status')).text()) as { paused: boolean }).paused
    for (let n = 0; n < 2; n++) {
      const res = await post(fx, '/api/artifact-manager/pause')
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { paused: true })
      assert.equal(await paused(), true)
    }
    // Refresh still queues while paused (it waits for resume).
    const queued = await post(fx, '/api/artifact-manager/refresh', { rootId: fx.out.rootId })
    assert.equal(queued.status, 202)
    await queued.arrayBuffer()
    for (let n = 0; n < 2; n++) {
      const res = await post(fx, '/api/artifact-manager/resume', {})
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { paused: false })
      assert.equal(await paused(), false)
    }
    await expectError(fx, await post(fx, '/api/artifact-manager/pause', { paused: false }), 400, 'invalid-body')
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ roots

test('root registration canonicalizes one output root and refuses invalid, secret, Atlas-data and missing roots', async () => {
  const fx = await fixture({ atlasHome: 'atlas-data' })
  try {
    const exportsDir = join(fx.home, 'exports')
    mkdirSync(exportsDir)
    const link = join(fx.home, 'exports-link')
    symlinkSync(exportsDir, link)
    type Registered = { root: { rootId: string; kind: string; path: string; protected: boolean; active: boolean; scopeFlags: string[]; repositoryId: string | null; projectName: string | null }; jobId: string | null }
    let res = await post(fx, '/api/artifact-manager/roots', { path: link })
    let text = await res.text()
    assert.equal(res.status, 201, text)
    const reg = JSON.parse(text) as Registered
    assert.equal(reg.root.path, exportsDir, 'the symlink is resolved to its canonical target')
    assert.equal(reg.root.kind, 'output')
    assert.equal(reg.root.active, true)
    assert.equal(reg.root.protected, false)
    assert.deepEqual(reg.root.scopeFlags, ['cli-output'])
    assert.ok(reg.jobId)
    assert.equal((fx.db.raw.prepare('SELECT task_kind FROM artifact_jobs WHERE job_id = ?').get(reg.jobId) as { task_kind: string }).task_kind, 'output-walk')
    res = await post(fx, '/api/artifact-manager/roots', { path: `${exportsDir}/` })
    text = await res.text()
    assert.equal(res.status, 200, text)
    assert.equal((JSON.parse(text) as Registered).root.rootId, reg.root.rootId, 'registration is deduplicated by canonical path')

    // Repository association by its registered checkout, and protection.
    const deliver = join(fx.home, 'deliver')
    mkdirSync(deliver)
    res = await post(fx, '/api/artifact-manager/roots', { path: deliver, repo: fx.repoDir, protected: true })
    text = await res.text()
    assert.equal(res.status, 201, text)
    const withRepo = (JSON.parse(text) as Registered).root
    assert.equal(withRepo.repositoryId, fx.repositoryId)
    assert.equal(withRepo.projectName, 'proj')
    assert.equal(withRepo.protected, true)
    const phiDir = join(fx.home, 'Clinic', 'PHI')
    mkdirSync(phiDir, { recursive: true })
    assert.equal((JSON.parse(await (await post(fx, '/api/artifact-manager/roots', { path: phiDir })).text()) as Registered).root.protected, true, 'a phi segment protects the root')

    const roots = count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_roots')
    mkdirSync(join(fx.home, '.ssh'))
    mkdirSync(join(fx.home, '.SSH'), { recursive: true }) // on a case-insensitive volume this is `.ssh` itself, so it must not fail with EEXIST
    mkdirSync(join(fx.home, 'atlas-data'), { recursive: true })
    mkdirSync(join(fx.home, '.josh-360', 'atlas'), { recursive: true })
    writeFileSync(join(fx.home, 'plain-file'), 'x')
    symlinkSync('/etc', join(fx.home, 'etc-link'))
    const cases: Array<[unknown, number, string]> = [
      ['exports', 400, 'root-relative'],
      ['~/exports', 400, 'root-relative'],
      ['/etc', 403, 'root-outside-home'],
      [fx.home, 403, 'root-outside-home'],
      [join(fx.home, '.ssh'), 403, 'root-outside-home'],
      [join(fx.home, '.SSH'), 403, 'root-outside-home'],
      [join(fx.home, '.josh-360', 'atlas'), 403, 'root-outside-home'],
      [`${fx.home}/exports/../.ssh`, 403, 'root-outside-home'],
      [join(fx.home, 'atlas-data'), 403, 'root-refused'],
      [join(fx.home, 'atlas-data', 'spool'), 403, 'root-refused'],
      [join(fx.home, 'etc-link'), 403, 'root-symlink-escape'],
      [join(fx.home, 'missing', 'child'), 409, 'root-missing'],
      [join(fx.home, 'plain-file'), 409, 'root-not-directory'],
    ]
    for (const [path, status, code] of cases) await expectError(fx, await post(fx, '/api/artifact-manager/roots', { path }), status, code)
    for (const body of [{}, { path: 42 }, { path: exportsDir, protected: 'yes' }, { path: exportsDir, kind: 'checkout' }, { path: exportsDir, repo: 7 }, null])
      await expectError(fx, await post(fx, '/api/artifact-manager/roots', body), 400, 'invalid-body')
    await expectError(fx, await post(fx, '/api/artifact-manager/roots', { path: exportsDir, repo: fx.outDir }), 409, 'repository-not-registered')
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_roots'), roots, 'refused registrations register nothing')
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_roots WHERE canonical_path = ?', fx.home), 0, 'a missing root never activates its parent')
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ legacy routes and R37

test('legacy routes keep their shapes, and secret directories are denied regardless of case or Unicode spelling (R37)', async () => {
  const fx = await fixture()
  try {
    const legacy = upsertArtifact(fx.db, { path: join(fx.outDir, 'legacy.md'), sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
    writeFileSync(join(fx.outDir, 'legacy.md'), 'legacy\n')
    outFile(fx, 'doc.md', 'grouped\n')
    const page = JSON.parse(await (await get(fx, '/api/artifacts')).text()) as { rows: Array<{ artifactId: number }>; total: number; limit: number; offset: number }
    assert.deepEqual(Object.keys(page).sort(), ['limit', 'offset', 'rows', 'total'])
    assert.ok(page.rows.every(r => Number.isInteger(r.artifactId)), 'location routes keep integer artifact IDs')
    assert.equal(await (await get(fx, `/api/artifacts/${legacy.artifactId}/preview`)).text(), 'legacy\n')

    const secrets = [
      join(fx.home, '.SSH', 'notes.md'),
      join(fx.home, 'library', 'keychains', 'x.md'),
      join(fx.home, '.ſsh', 'notes.md'),
      join(fx.home, 'Library', 'Keychains', 'y.md'),
      join(fx.home, '.Config', 'GCloud', 'z.md'),
    ]
    for (const p of secrets) {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'secret notes\n')
      const a = upsertArtifact(fx.db, { path: p, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
      const preview = await get(fx, `/api/artifacts/${a.artifactId}/preview`)
      assert.equal(preview.status, 403, `preview ${p}`)
      assert.ok(!(await preview.text()).includes('secret notes'))
      const reveal = await post(fx, `/api/artifacts/${a.artifactId}/reveal`)
      assert.equal(reveal.status, 403, `reveal ${p}`)
      await reveal.arrayBuffer()
    }
    const pdf = join(fx.home, '.SSH', 'key.pdf')
    writeFileSync(pdf, '%PDF')
    const a = upsertArtifact(fx.db, { path: pdf, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
    const open = await post(fx, `/api/artifacts/${a.artifactId}/open`)
    assert.equal(open.status, 403)
    await open.arrayBuffer()
    assert.deepEqual(fx.reveals, [], 'nothing under a secret directory was revealed or opened')
  } finally {
    await fx.close()
  }
})

test('a `.phi` folder is PHI like `phi`: hidden by default, never previewed or exported (R85)', async () => {
  const fx = await fixture()
  try {
    mkdirSync(join(fx.outDir, '.PHI'))
    const dotPhi = outFile(fx, '.PHI/notes.md', 'phi notes\n')
    const ok = outFile(fx, 'notes.md', 'ordinary\n')
    assert.deepEqual((await list(fx)).rows.map(r => r.displayName), ['notes.md'], 'hidden by default')
    assert.deepEqual((await list(fx, '?sensitive=only')).rows.map(r => r.displayName), ['notes.md'])
    await expectError(fx, await get(fx, `/api/artifact-documents/${dotPhi.documentId}`), 404, 'not-found')
    await expectError(fx, await get(fx, `/api/artifact-versions/${dotPhi.versionId}/preview`), 404, 'not-found')
    await expectError(fx, await get(fx, `/api/artifact-versions/${dotPhi.versionId}/preview?sensitive=show`), 403, 'protected')
    assert.equal((await get(fx, `/api/artifact-versions/${ok.versionId}/preview`)).status, 200)

    const plan = commitVersion(fx, 'phi/plan.md')
    const git = commitVersion(fx, 'data/athena/csv/.phi/plan.md', { blobOid: plan.blobOid, size: plan.size })
    const calls = fx.gitCalls.length
    await expectError(fx, await get(fx, `/api/artifact-versions/${git.versionId}/preview?sensitive=show`), 403, 'protected')
    await expectError(fx, await post(fx, `/api/artifact-versions/${git.versionId}/export?sensitive=show`), 403, 'protected')
    assert.equal(fx.gitCalls.length, calls, 'a protected blob is never read')
  } finally {
    await fx.close()
  }
})

// PR #19 review item 3: the location actions the browser uses (/api/artifacts/:id/preview|open|reveal) honour a registered output
// root even when a passive-scan exclusion name (here `build`) is in its path, and keep every other protection.
test('location actions work for files under a registered output root inside build/, and keep their protections (review item 3)', async () => {
  const fx = await fixture()
  try {
    const reports = join(fx.home, 'project', 'build', 'reports')
    mkdirSync(join(reports, 'phi'), { recursive: true })
    const root = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: reports, repositoryId: null, projectName: 'reports', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    const observe = (rel: string, content: string | Buffer) => {
      const path = join(reports, rel)
      writeFileSync(path, content)
      const v = working(fx, root, path, rootDoc(root, rel))
      return { path, versionId: v.versionId, id: findArtifactByPath(fx.db, path)!.artifactId }
    }
    const md = observe('summary.md', '# summary\n')
    const pdf = observe('report.pdf', '%PDF-1.4\n')
    assert.equal((await get(fx, `/api/artifact-versions/${md.versionId}/preview`)).status, 200, 'the version preview already works')

    const res = await get(fx, `/api/artifacts/${md.id}/preview`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '# summary\n')
    assert.equal(res.headers.get('content-security-policy'), SANDBOX)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await post(fx, `/api/artifacts/${md.id}/reveal`)).status, 200)
    assert.equal((await post(fx, `/api/artifacts/${pdf.id}/open`)).status, 200)
    assert.equal((await post(fx, `/api/artifacts/${pdf.id}/reveal`)).status, 200)
    assert.deepEqual(fx.reveals, [md.path, `open:${pdf.path}`, pdf.path])

    // The same names outside a registered root are still denied, exactly as before.
    mkdirSync(join(fx.home, 'other', 'build'), { recursive: true })
    const stray = join(fx.home, 'other', 'build', 'x.md')
    writeFileSync(stray, 'stray\n')
    const unregistered = upsertArtifact(fx.db, { path: stray, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
    assert.equal((await get(fx, `/api/artifacts/${unregistered.artifactId}/preview`)).status, 403)
    assert.equal((await post(fx, `/api/artifacts/${unregistered.artifactId}/reveal`)).status, 403)

    // A secret, a PHI folder and a symlink under the registered root are still refused, and nothing is revealed or opened.
    const env = observe('.env', 'TOKEN=1\n')
    const phi = join(reports, 'phi', 'notes.md')
    writeFileSync(phi, 'phi notes\n')
    const phiLoc = upsertArtifact(fx.db, { path: phi, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
    const link = join(reports, 'link.md')
    symlinkSync(join(reports, 'summary.md'), link)
    const linkLoc = upsertArtifact(fx.db, { path: link, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
    const shown = fx.reveals.length
    for (const [name, id] of [['.env', env.id], ['phi', phiLoc.artifactId], ['symlink', linkLoc.artifactId]] as const) {
      const preview = await get(fx, `/api/artifacts/${id}/preview`)
      assert.equal(preview.status, 403, `preview ${name}`)
      assert.ok(!(await preview.text()).includes('TOKEN'))
      for (const action of ['reveal', 'open']) {
        const r = await post(fx, `/api/artifacts/${id}/${action}`)
        assert.equal(r.status, 403, `${action} ${name}`)
        await r.arrayBuffer()
      }
    }
    assert.equal(fx.reveals.length, shown, 'nothing protected was revealed or opened')

    // Atlas runtime and Claude settings stay denied inside a registered root (R82).
    const claudeDir = join(fx.home, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const settings = join(claudeDir, 'settings.json')
    writeFileSync(settings, '{}\n')
    const settingsLoc = upsertArtifact(fx.db, { path: settings, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 })
    assert.equal((await get(fx, `/api/artifacts/${settingsLoc.artifactId}/preview`)).status, 403)
  } finally {
    await fx.close()
  }
})

// Ruling R88: for one file under an ignored name (`build/`), the location actions answer exactly what the artifact-manager route
// answers for the same file, whatever state its root is in.
test('location actions and version previews agree for an ignored-name file in every root state (R88)', async () => {
  for (const state of ['active root', 'deactivated root', 'refused root', 'root_id NULL'] as const) {
    const fx = await fixture(state === 'refused root' ? { atlasHome: 'atlas-data' } : {})
    try {
      const dir = state === 'refused root' ? join(fx.home, 'atlas-data', 'build', 'reports') : join(fx.home, 'project', 'build', 'reports')
      mkdirSync(dir, { recursive: true })
      const root = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: dir, repositoryId: null, projectName: 'reports', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
      const path = join(dir, 'summary.md')
      writeFileSync(path, '# summary\n')
      const v = working(fx, root, path, rootDoc(root, 'summary.md'))
      const id = findArtifactByPath(fx.db, path)!.artifactId
      if (state === 'deactivated root') fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(root.rootId)
      if (state === 'root_id NULL') fx.db.raw.prepare('UPDATE artifacts SET root_id = NULL WHERE artifact_id = ?').run(id)
      const next = (await get(fx, `/api/artifact-versions/${v.versionId}/preview`)).status
      const legacy = (await get(fx, `/api/artifacts/${id}/preview`)).status
      const reveal = (await post(fx, `/api/artifacts/${id}/reveal`)).status
      assert.equal(legacy, next, `${state}: preview`)
      assert.equal(reveal, next, `${state}: reveal`)
      if (state === 'active root') {
        // Secret and PHI files stay denied on both sides (the version route answers 403 `protected` once protected documents are shown).
        mkdirSync(join(dir, 'phi'), { recursive: true })
        for (const rel of ['.env', 'phi/notes.md']) {
          const p = join(dir, rel)
          writeFileSync(p, 'x\n')
          const pv = working(fx, root, p, rootDoc(root, rel))
          const pid = findArtifactByPath(fx.db, p)!.artifactId
          assert.equal((await get(fx, `/api/artifacts/${pid}/preview`)).status, 403, `${rel}: location action`)
          assert.equal((await get(fx, `/api/artifact-versions/${pv.versionId}/preview?sensitive=show`)).status, 403, `${rel}: version route`)
        }
      }
    } finally {
      await fx.close()
    }
  }
})

// Ruling R87: the legacy location actions had no PHI check, so a known artifact ID served a `phi`/`.phi` file the lists hide.
test('legacy preview, open and reveal deny a PHI path and run nothing (R87)', async () => {
  const fx = await fixture()
  try {
    const phiFiles = [join(fx.outDir, 'x', '.phi'), join(fx.outDir, 'x', 'PHI')]
    const ids: number[] = []
    for (const dir of phiFiles) {
      mkdirSync(dir, { recursive: true })
      for (const name of ['notes.md', 'doc.pdf']) {
        const p = join(dir, name)
        writeFileSync(p, name.endsWith('pdf') ? '%PDF' : 'phi notes\n')
        ids.push(upsertArtifact(fx.db, { path: p, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 }).artifactId)
      }
    }
    for (const id of ids) {
      const preview = await get(fx, `/api/artifacts/${id}/preview`)
      assert.equal(preview.status, 403, `preview ${id}`)
      assert.ok(!(await preview.text()).includes('phi notes'))
      for (const action of ['open', 'reveal']) {
        const r = await post(fx, `/api/artifacts/${id}/${action}`)
        assert.equal(r.status, 403, `${action} ${id}`)
        await r.arrayBuffer()
      }
    }
    assert.deepEqual(fx.reveals, [], 'no OS open or reveal ran')
    // An ordinary neighbour (and a folder merely containing the letters) is unchanged.
    mkdirSync(join(fx.outDir, 'x', 'Delphi'), { recursive: true })
    const ok = join(fx.outDir, 'x', 'Delphi', 'notes.md')
    writeFileSync(ok, 'ordinary\n')
    const okId = upsertArtifact(fx.db, { path: ok, sizeBytes: 1, createdAt: T0, projectName: 'p', now: T0 }).artifactId
    assert.equal(await (await get(fx, `/api/artifacts/${okId}/preview`)).text(), 'ordinary\n')
    assert.equal((await post(fx, `/api/artifacts/${okId}/reveal`)).status, 200)
    assert.deepEqual(fx.reveals, [ok])
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ fix round 1

test('status and list coverage treat a root nested in a protected root as protected and redact its path and labels (I1)', async () => {
  const fx = await fixture()
  try {
    const clinic = join(fx.home, 'clinic-jane-doe')
    mkdirSync(join(clinic, 'reports', 'deep'), { recursive: true })
    mkdirSync(`${clinic}x`)
    const prot = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: clinic, repositoryId: null, projectName: 'clinic-jane-doe', checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T0)
    const nested = registerArtifactRoot(fx.db, { kind: 'session-directory', canonicalPath: join(clinic, 'reports'), repositoryId: null, projectName: 'jane-reports', checkoutIdentity: null, protected: false, scopeFlags: ['session-cwd'] }, T0)
    const deep = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: join(clinic, 'reports', 'deep'), repositoryId: null, projectName: 'jane-deep', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    // A sibling that only shares the spelling prefix is not inside the protected root.
    const sibling = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: `${clinic}x`, repositoryId: null, projectName: 'sibling', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    fx.db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'inaccessible', last_error = 'root-inaccessible' WHERE root_id = ?`).run(nested.rootId)

    type RootStatus = { rootId: string; path: string | null; pathRedacted: boolean; protected: boolean; projectName: string | null; reason: string | null }
    const leaks = (text: string) => [`${clinic}/`, `"${clinic}"`, 'clinic-jane-doe"', 'jane-reports', 'jane-deep'].filter(s => text.includes(s))
    for (const url of ['/api/artifact-manager/status', '/api/artifact-documents']) {
      const text = await (await get(fx, url)).text()
      assert.deepEqual(leaks(text), [], `${url} leaks nothing of the protected root by default`)
      const roots = (url.includes('status') ? JSON.parse(text) : JSON.parse(text).coverage).roots as RootStatus[]
      for (const id of [prot.rootId, nested.rootId, deep.rootId]) {
        const r = roots.find(x => x.rootId === id)!
        assert.deepEqual({ path: r.path, pathRedacted: r.pathRedacted, protected: r.protected, projectName: r.projectName }, { path: null, pathRedacted: true, protected: true, projectName: null }, `${url} ${id}`)
        if (r.reason !== null) assert.ok(!r.reason.includes('/') && !r.reason.includes('jane'), r.reason)
      }
      const sib = roots.find(x => x.rootId === sibling.rootId)!
      assert.deepEqual({ path: sib.path, protected: sib.protected, projectName: sib.projectName }, { path: `${clinic}x`, protected: false, projectName: 'sibling' })
    }
    // Shown on explicit request.
    const shown = JSON.parse(await (await get(fx, '/api/artifact-manager/status?sensitive=show')).text()) as { roots: RootStatus[] }
    const shownNested = shown.roots.find(x => x.rootId === nested.rootId)!
    assert.deepEqual({ path: shownNested.path, protected: shownNested.protected, projectName: shownNested.projectName }, { path: join(clinic, 'reports'), protected: true, projectName: 'jane-reports' })
    const only = JSON.parse(await (await get(fx, '/api/artifact-manager/status?sensitive=only')).text()) as { roots: RootStatus[] }
    assert.deepEqual(only.roots.map(r => r.rootId).sort(), [prot.rootId, nested.rootId, deep.rootId].sort())
  } finally {
    await fx.close()
  }
})

test('root registration refuses to rewrite an existing checkout or a root of another repository (I2)', async () => {
  const fx = await fixture()
  try {
    const otherRepo = registerArtifactRepository(fx.db, { commonDir: join(fx.home, 'other', '.git'), displayName: 'other', remoteIdentity: null }, T0)
    const snapshot = () => fx.db.raw.prepare('SELECT kind, repository_id, project_name, checkout_identity, scope_flags, protected, active FROM artifact_roots WHERE root_id = ?').get(fx.checkout.rootId) as Record<string, unknown>
    const before = { ...snapshot() }
    const jobs = count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_jobs')
    for (const body of [
      { path: fx.repoDir, repositoryId: otherRepo, label: 'renamed' },
      { path: fx.repoDir },
      { path: `${fx.repoDir}/`, label: 'renamed' },
      { path: fx.repoDir, repo: fx.repoDir, protected: true },
    ]) await expectError(fx, await post(fx, '/api/artifact-manager/roots', body), 409, 'root-conflict')
    assert.deepEqual({ ...snapshot() }, before, 'the checkout root is untouched')
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS n FROM artifact_jobs'), jobs)

    // An output root already associated with one repository is not re-associated with another.
    await expectError(fx, await post(fx, '/api/artifact-manager/roots', { path: fx.durableDir, repositoryId: otherRepo }), 409, 'root-conflict')
    const durable = fx.db.raw.prepare('SELECT repository_id FROM artifact_roots WHERE root_id = ?').get(fx.durable.rootId) as { repository_id: string }
    assert.equal(durable.repository_id, fx.repositoryId)
    // The same repository, or none, re-registers it.
    let res = await post(fx, '/api/artifact-manager/roots', { path: fx.durableDir, repositoryId: fx.repositoryId })
    assert.equal(res.status, 200, await res.text())
    res = await post(fx, '/api/artifact-manager/roots', { path: fx.durableDir })
    assert.equal(res.status, 200, await res.text())
  } finally {
    await fx.close()
  }
})

test('every preview response is sandboxed, including inline XML and the legacy location route (I3, R39)', async () => {
  const fx = await fixture()
  try {
    const xml = outFile(fx, 'evil.xml', XHTML)
    let res = await get(fx, `/api/artifact-versions/${xml.versionId}/preview`, { 'sec-fetch-site': 'same-origin' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8')
    assert.equal(res.headers.get('content-security-policy'), SANDBOX)
    await res.arrayBuffer()
    const committed = commitVersion(fx, 'docs/x.xml')
    res = await get(fx, `/api/artifact-versions/${committed.versionId}/preview`, { 'sec-fetch-site': 'none' })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), XHTML)
    assert.equal(res.headers.get('content-security-policy'), SANDBOX)
    for (const [name, body] of [['notes.md', '# notes\n'], ['data.json', '{}'], ['pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])]] as const) {
      const v = outFile(fx, name, body)
      res = await get(fx, `/api/artifact-versions/${v.versionId}/preview`)
      assert.equal(res.status, 200, name)
      assert.equal(res.headers.get('content-security-policy'), SANDBOX, name)
      await res.arrayBuffer()
    }
    // The legacy location route sends the same header on inline previews.
    for (const name of ['legacy.xml', 'legacy.md']) {
      const path = join(fx.outDir, name)
      writeFileSync(path, XHTML)
      const a = upsertArtifact(fx.db, { path, sizeBytes: XHTML.length, createdAt: T0, projectName: 'p', now: T0 })
      res = await get(fx, `/api/artifacts/${a.artifactId}/preview`)
      assert.equal(res.status, 200, name)
      assert.equal(res.headers.get('content-security-policy'), SANDBOX, name)
      await res.arrayBuffer()
    }
  } finally {
    await fx.close()
  }
})

test('export names stay within 255 bytes for long CJK and ASCII names without splitting a character (M1)', async () => {
  const fx = await fixture()
  try {
    const c = commitVersion(fx, 'docs/report.md')
    const cjk = `${'报'.repeat(84)}.md`
    const ascii = `${'a'.repeat(250)}.md`
    // One ASCII byte first, so the 150-byte boundary falls inside a three-byte character.
    const offset = `x${'报'.repeat(83)}.md`
    assert.equal(Buffer.byteLength(cjk), 255)
    for (const leaf of [cjk, ascii, offset]) {
      const v = commitVersion(fx, `docs/${leaf}`, { blobOid: c.blobOid, size: c.size })
      for (let n = 0; n < 2; n++) {
        const res = await post(fx, `/api/artifact-versions/${v.versionId}/export`)
        const text = await res.text()
        assert.equal(res.status, 201, text)
        const { fileName, path } = JSON.parse(text) as { fileName: string; path: string }
        assert.ok(Buffer.byteLength(fileName) <= 255, `${Buffer.byteLength(fileName)} bytes`)
        assert.ok(!fileName.includes('�'))
        assert.match(fileName, /\.md$/)
        const stem = fileName.slice(0, fileName.indexOf('--'))
        assert.ok(stem.length > 0 && leaf.startsWith(stem), 'the stem is a whole-character prefix of the original name')
        assert.ok(Buffer.byteLength(stem) <= 150)
        assert.equal(readFileSync(path, 'utf8'), COMMITTED)
      }
    }
  } finally {
    await fx.close()
  }
})

test('Git reads for preview and export run one at a time behind a bounded queue (M2)', async () => {
  const fx = await fixture()
  // Each Git read blocks on its own gate, opened by the test in start order.
  const gates: Array<{ promise: Promise<void>; open: () => void }> = []
  const gate = (i: number) => {
    while (gates.length <= i) {
      let open: () => void = () => {}
      const promise = new Promise<void>(resolve => { open = resolve })
      gates.push({ promise, open })
    }
    return gates[i]!
  }
  const openAll = () => { for (let i = 0; i < 20; i++) gate(i).open() }
  const settle = async (until: () => boolean) => { for (let i = 0; i < 500 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 10)) }
  try {
    const c = commitVersion(fx, 'docs/report.md')
    let active = 0
    let maxActive = 0
    let started = 0
    fx.gitOverride.fn = async call => {
      const mine = started++
      active++
      maxActive = Math.max(maxActive, active)
      await gate(mine).promise
      const r = await runArtifactGit(call.repoPath, call.args, call.limits)
      active--
      return r
    }
    const statuses: number[] = []
    const bodies: string[] = []
    const send = (n: number) => (n % 2 === 0 ? get(fx, `/api/artifact-versions/${c.versionId}/preview`) : post(fx, `/api/artifact-versions/${c.versionId}/export`))
      .then(async res => { statuses.push(res.status); bodies.push(await res.text()) })
    const requests = Array.from({ length: 10 }, (_, n) => send(n))
    // One read runs and eight wait; the tenth request is turned away at once while the first is still blocked.
    await settle(() => statuses.length > 0)
    assert.deepEqual(statuses, [503])
    const busy = JSON.parse(bodies[0]!) as ErrorBody
    assert.equal(busy.error.code, 'busy')
    assert.ok(!bodies[0]!.includes(fx.home))
    assert.equal(started, 1, 'only one Git read has started')

    // The finishing read hands its slot to the next waiter; a newcomer arriving during that read waits its turn.
    gate(0).open()
    await settle(() => started === 2)
    assert.equal(started, 2)
    requests.push(send(10))
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(started, 2, 'the newcomer did not overtake the queue')
    openAll()
    await Promise.all(requests)
    assert.equal(maxActive, 1, 'never more than one Git read at a time')
    assert.equal(started, 10)
    assert.equal(statuses.length, 11)
    assert.ok(statuses.slice(1).every(s => s === 200 || s === 201), `all queued reads complete: ${statuses.join(',')}`)
  } finally {
    openAll()
    fx.gitOverride.fn = null
    await fx.close()
  }
})

test('the routes honor an injected config and fall back to loadConfig() without one (R38)', async () => {
  // With config (ATLAS_HOME = ~/atlas-data): that folder is Atlas data and refused as a root.
  const injected = await fixture({ atlasHome: 'atlas-data' })
  try {
    mkdirSync(join(injected.home, 'atlas-data'))
    await expectError(injected, await post(injected, '/api/artifact-manager/roots', { path: join(injected.home, 'atlas-data') }), 403, 'root-refused')
  } finally {
    await injected.close()
  }
  // Without config the routes read loadConfig() (this process has no ATLAS_HOME), so the same folder is an ordinary root.
  const fallback = await fixture({ passConfig: false })
  try {
    mkdirSync(join(fallback.home, 'atlas-data'))
    assert.equal((await post(fallback, '/api/artifact-manager/roots', { path: join(fallback.home, 'atlas-data') })).status, 201)
    await expectError(fallback, await post(fallback, '/api/artifact-manager/roots', { path: join(fallback.home, '.josh-360') }), 403, 'root-refused')
  } finally {
    await fallback.close()
  }
})

// ------------------------------------------------------------------------------------------------------------ fix round 2

/** A deferred: a promise plus the function that resolves it. */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !cond() && Date.now() < end;) await pause(10)
}
/** Rejects instead of hanging when `p` does not settle in time (a leaked slot would leave requests waiting forever). */
function within(p: Promise<unknown>, ms: number, what: string): Promise<unknown> {
  return Promise.race([p, pause(ms).then(() => { throw new Error(`${what} did not finish within ${ms} ms`) })])
}

test('an export holds the shared Git slot through its write and fsync, so export buffers never overlap (M2, round 2)', async () => {
  const fx = await fixture()
  const stall = deferred()
  const clients: AbortController[] = []
  try {
    const c = commitVersion(fx, 'docs/report.md')
    let gitStarts = 0
    fx.gitOverride.fn = () => { gitStarts++; return null }
    let syncs = 0
    let live = 0
    let peakLive = 0
    fx.handleWrap.fn = (call, h) => {
      if ((call.flags & fsConstants.O_CREAT) === 0) return h
      const write = h.writeFile.bind(h), sync = h.sync.bind(h), close = h.close.bind(h)
      let wrote = false
      return Object.assign(h, {
        writeFile: async (data: Buffer) => { wrote = true; live++; peakLive = Math.max(peakLive, live); return write(data) },
        sync: async () => { if (syncs++ === 0) await stall.promise; return sync() },
        close: async () => { if (wrote) live--; return close() },
      })
    }
    const statuses: number[] = []
    const send = (kind: 'export' | 'preview') => {
      const ac = new AbortController()
      clients.push(ac)
      const req = kind === 'export' ? post(fx, `/api/artifact-versions/${c.versionId}/export`, undefined, ac.signal) : fetch(`${fx.base}/api/artifact-versions/${c.versionId}/preview`, { signal: ac.signal })
      return req.then(async res => { statuses.push(res.status); await res.arrayBuffer() })
    }
    const first = send('export')
    await until(() => syncs === 1)
    assert.equal(syncs, 1, 'the first export is stalled in its fsync')
    assert.equal(gitStarts, 1)
    // While that export is still writing, no other Git read starts: the next export and a preview wait in the queue.
    const waiting = [send('export'), send('preview')]
    await pause(300)
    assert.equal(gitStarts, 1, 'no Git read starts while an export is writing')
    // The queue bound is unchanged: the writer holds the slot, eight wait, and the next request is turned away at once.
    const more = Array.from({ length: 7 }, () => send('export'))
    await until(() => statuses.length > 0)
    assert.deepEqual(statuses, [503])
    assert.equal(gitStarts, 1)
    stall.open()
    await within(Promise.all([first, ...waiting, ...more]), 30_000, 'queued exports')
    assert.equal(statuses.length, 10)
    assert.ok(statuses.slice(1).every(s => s === 200 || s === 201), statuses.join(','))
    assert.equal(gitStarts, 9)
    assert.equal(peakLive, 1, 'at most one export buffer is being written at a time')
  } finally {
    stall.open()
    for (const ac of clients) ac.abort()
    fx.gitOverride.fn = null
    fx.handleWrap.fn = null
    await fx.close()
  }
})

test('the Git slot is released on every export failure path and after a client abort mid-write (M2, round 2)', async () => {
  const fx = await fixture()
  const stall = deferred()
  const clients: AbortController[] = []
  try {
    const c = commitVersion(fx, 'docs/report.md')
    // Every request is abortable, so a leaked slot fails the test (and lets the server close) instead of hanging it.
    const exportOnce = (signal?: AbortSignal) => {
      const own = new AbortController()
      clients.push(own)
      return post(fx, `/api/artifact-versions/${c.versionId}/export`, undefined, signal ?? own.signal)
    }
    const files = () => readdirSync(fx.durableDir).length
    const fail = (method: 'writeFile' | 'sync') => {
      fx.handleWrap.fn = (call, h) => {
        if ((call.flags & fsConstants.O_CREAT) === 0) return h
        fx.handleWrap.fn = null
        return Object.assign(h, { [method]: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } })
      }
    }
    // A failing write, a failing fsync, a failed re-check after the read and a rejecting adapter: each is refused and
    // leaves nothing behind.
    fail('writeFile')
    await expectError(fx, await within(exportOnce(), 20_000, 'export') as Response, 409, 'export-failed')
    fail('sync')
    await expectError(fx, await within(exportOnce(), 20_000, 'export') as Response, 409, 'export-failed')
    fx.gitOverride.fn = () => { fx.gitOverride.fn = null; chmodSync(fx.durableDir, 0o755); return null }
    await expectError(fx, await within(exportOnce(), 20_000, 'export') as Response, 409, 'output-root-not-private')
    chmodSync(fx.durableDir, 0o700)
    fx.gitOverride.fn = () => { fx.gitOverride.fn = null; return Promise.reject(new Error('adapter exploded')) }
    await expectError(fx, await within(exportOnce(), 20_000, 'export') as Response, 500, 'internal-error')
    assert.equal(files(), 0, 'failed exports leave no files')

    // A client that disconnects while its export is still writing: the server finishes and releases the slot.
    let syncs = 0
    let closed = false
    fx.handleWrap.fn = (call, h) => {
      if ((call.flags & fsConstants.O_CREAT) === 0) return h
      const sync = h.sync.bind(h)
      const close = h.close.bind(h)
      // The close is slowed so the export holds the slot well after its file exists: the batch below must wait for the release.
      return Object.assign(h, {
        sync: async () => { syncs++; await stall.promise; return sync() },
        close: async () => { await new Promise(r => setTimeout(r, 300)); await close(); closed = true },
      })
    }
    const ac = new AbortController()
    const aborted = exportOnce(ac.signal).then(() => 'answered', () => 'aborted')
    await until(() => syncs === 1)
    ac.abort()
    assert.equal(await aborted, 'aborted')
    stall.open()
    // The file exists from its creation, so files() === 1 proves nothing about the slot. The slot is released right after the
    // handle is closed (only promise continuations remain), and a timer turn lets those run.
    await until(() => files() === 1 && closed)
    assert.ok(closed, 'the aborted export finished its write')
    await pause(0)
    fx.handleWrap.fn = null

    // Nothing leaked: a full queue of exports (one running, eight waiting) all succeed.
    const batch = Array.from({ length: 9 }, () => exportOnce().then(async res => { await res.arrayBuffer(); return res.status }))
    const statuses = await within(Promise.all(batch), 30_000, 'exports after failures') as number[]
    assert.deepEqual(statuses, Array(9).fill(201))
    assert.equal(files(), 10)
  } finally {
    stall.open()
    for (const client of clients) client.abort()
    fx.gitOverride.fn = null
    fx.handleWrap.fn = null
    chmodSync(fx.durableDir, 0o700)
    await fx.close()
  }
})

test('a durable root nested inside a protected root is protected: protected documents export there and its path is redacted under hide (R40)', async () => {
  const fx = await fixture()
  try {
    const base = fx.config.artifacts.durableOutputBase
    const clinic = join(base, 'clinic')
    const nestedDir = join(clinic, 'acme', 'deliverables')
    mkdirSync(nestedDir, { recursive: true, mode: 0o700 })
    chmodSync(nestedDir, 0o700)
    // Only the nested root serves this repository at first; it is two levels inside a protected root of no repository.
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(fx.durable.rootId)
    registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: clinic, repositoryId: null, projectName: 'clinic', checkoutIdentity: null, protected: true, scopeFlags: ['configured-output'] }, T0)
    const nested = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: nestedDir, repositoryId: fx.repositoryId, projectName: 'acme', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    type Exported = { rootId: string; fileName: string; path: string | null; pathRedacted: boolean }
    const exportOf = async (versionId: string, query = ''): Promise<{ status: number; text: string; body: Exported }> => {
      const res = await post(fx, `/api/artifact-versions/${versionId}/export${query}`)
      const text = await res.text()
      return { status: res.status, text, body: JSON.parse(text) as Exported }
    }

    // A protected document may be exported there (with an explicit view filter).
    const plan = commitVersion(fx, 'phi/plan.md')
    let r = await exportOf(plan.versionId, '?sensitive=show')
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.rootId, nested.rootId)
    assert.equal(r.body.path, join(nestedDir, r.body.fileName))
    assert.equal(readFileSync(join(nestedDir, r.body.fileName), 'utf8'), PLAN)

    // An unprotected document lands there too, but under hide the response names no path of the protected tree.
    const c = commitVersion(fx, 'docs/report.md')
    r = await exportOf(c.versionId)
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.rootId, nested.rootId)
    assert.equal(r.body.path, null)
    assert.equal(r.body.pathRedacted, true)
    assert.ok(!r.text.includes(clinic) && !r.text.includes('acme') && !r.text.includes('clinic'), r.text)
    assert.equal(readFileSync(join(nestedDir, r.body.fileName), 'utf8'), COMMITTED)
    r = await exportOf(c.versionId, '?sensitive=show')
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.path, join(nestedDir, r.body.fileName))
    assert.equal(r.body.pathRedacted, false)
    // An inactive protected ancestor still protects: deactivation never lowers protection.
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE canonical_path = ?').run(clinic)
    r = await exportOf(c.versionId)
    assert.equal(r.status, 201, r.text)
    assert.deepEqual({ rootId: r.body.rootId, path: r.body.path, pathRedacted: r.body.pathRedacted }, { rootId: nested.rootId, path: null, pathRedacted: true })

    // A sibling that only shares the spelling prefix is not protected: unprotected documents now prefer it, unredacted, and
    // protected documents still go only to the protected tree.
    const siblingDir = join(`${clinic}x`, 'deliverables')
    mkdirSync(siblingDir, { recursive: true, mode: 0o700 })
    chmodSync(siblingDir, 0o700)
    const sibling = registerArtifactRoot(fx.db, { kind: 'output', canonicalPath: siblingDir, repositoryId: fx.repositoryId, projectName: 'sibling', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T0)
    r = await exportOf(c.versionId)
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.rootId, sibling.rootId)
    assert.equal(r.body.path, join(siblingDir, r.body.fileName))
    assert.equal(r.body.pathRedacted, false)
    r = await exportOf(plan.versionId, '?sensitive=show')
    assert.equal(r.body.rootId, nested.rootId)
    // With only the sibling left, a protected document has no protected destination.
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(nested.rootId)
    await expectError(fx, await post(fx, `/api/artifact-versions/${plan.versionId}/export?sensitive=show`), 403, 'protected')
  } finally {
    await fx.close()
  }
})

// ------------------------------------------------------------------------------------------------ Defect Wave 2a (DEFECT-3)

test('DEFECT-3: a Git preview or export that cannot serve a version records what it proved, and a successful read restores it', async () => {
  const fx = await fixture()
  try {
    const stateOf = (versionId: string) => (fx.db.raw.prepare('SELECT availability FROM artifact_version_state WHERE version_id = ?').get(versionId) as { availability: string }).availability
    const docAvailability = async (documentId: string) => (JSON.parse(await (await get(fx, `/api/artifact-documents/${documentId}`)).text()) as { document: { availability: string } }).document.availability
    const c = commitVersion(fx, 'docs/report.md')
    // An object Git cannot read (exit-nonzero) proves nothing by itself: the version is no longer offered (unknown), and a
    // staged snapshot would stay counted as needing preservation; the background object check settles it.
    const missing = commitVersion(fx, 'docs/missing.md', { blobOid: 'ab'.repeat(20), size: 12 })
    assert.equal(await docAvailability(missing.documentId), 'git')
    await expectError(fx, await get(fx, `/api/artifact-versions/${missing.versionId}/preview`), 410, 'git-object-unavailable')
    assert.equal(stateOf(missing.versionId), 'unknown')
    // Fix round 1: unproven reads as last-known (stale), not unavailable: the document is no longer offered as Git only.
    assert.equal(await docAvailability(missing.documentId), 'stale', 'the document is no longer offered as Git only')
    // An object of another size can never be served exactly: proven unavailable, by preview and by export.
    const wrongSize = commitVersion(fx, 'docs/report.md', { commitOid: 'cd'.repeat(20), blobOid: c.blobOid, size: c.size + 5 })
    await expectError(fx, await get(fx, `/api/artifact-versions/${wrongSize.versionId}/preview`), 410, 'git-object-unavailable')
    assert.equal(stateOf(wrongSize.versionId), 'unavailable')
    const smaller = commitVersion(fx, 'docs/report.md', { commitOid: 'ce'.repeat(20), blobOid: c.blobOid, size: c.size - 3 })
    await expectError(fx, await post(fx, `/api/artifact-versions/${smaller.versionId}/export`), 410, 'git-object-unavailable')
    assert.equal(stateOf(smaller.versionId), 'unavailable')
    const gone = commitVersion(fx, 'docs/gone.md', { blobOid: 'ac'.repeat(20), size: 12 })
    await expectError(fx, await post(fx, `/api/artifact-versions/${gone.versionId}/export`), 410, 'git-object-unavailable')
    assert.equal(stateOf(gone.versionId), 'unknown')
    // A failure that is not about the object (a timeout) changes nothing.
    fx.gitOverride.fn = () => cannedGit({ exitCode: null, timedOut: true, error: 'timeout', incomplete: true })
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview`), 503, 'git-unavailable')
    fx.gitOverride.fn = null
    assert.equal(stateOf(c.versionId), 'available')
    // Exact bytes read again prove the object is present: an unknown version is available again.
    fx.db.raw.prepare(`UPDATE artifact_version_state SET availability = 'unknown' WHERE version_id = ?`).run(c.versionId)
    const ok = await get(fx, `/api/artifact-versions/${c.versionId}/preview`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), COMMITTED)
    assert.equal(stateOf(c.versionId), 'available')
  } finally {
    await fx.close()
  }
})

test('PERF-GAP-4: a Git preview or export tells the adapter the stored size, so the blob is collected into one buffer', async () => {
  const fx = await fixture()
  try {
    const c = commitVersion(fx, 'docs/report.md')
    const res = await get(fx, `/api/artifact-versions/${c.versionId}/preview`)
    assert.equal(await res.text(), COMMITTED)
    // Fix round 2: pinned to the recorded common dir as well, like the object check.
    const gitDir = realpathSync(join(fx.repoDir, '.git'))
    assert.deepEqual(fx.gitOptions.at(-1), { expectedBytes: c.size, gitDir })
    const exp = await post(fx, `/api/artifact-versions/${c.versionId}/export`)
    assert.equal(exp.status, 201, await exp.clone().text())
    assert.deepEqual(fx.gitCalls.at(-1)!.args, ['cat-file', 'blob', c.blobOid])
    assert.deepEqual(fx.gitOptions.at(-1), { expectedBytes: c.size, gitDir })
    const body = JSON.parse(await exp.text()) as { path: string; sizeBytes: number }
    assert.equal(body.sizeBytes, c.size)
    assert.equal(readFileSync(body.path, 'utf8'), COMMITTED, 'the exported bytes are exact')
  } finally {
    await fx.close()
  }
})

// I5 (Wave 2a fix round 1): with no reachable checkout of its repository a Git version cannot be read; it is not advertised.
test('I5: a Git preview with no reachable checkout records the version as unverified and the document stops reading Git only', async () => {
  const fx = await fixture()
  try {
    const c = commitVersion(fx, 'docs/report.md')
    const doc = async () => (JSON.parse(await (await get(fx, `/api/artifact-documents/${c.documentId}`)).text()) as { document: { availability: string }; versions: Array<{ versionId: string; availability: string }> })
    assert.equal((await doc()).document.availability, 'git')
    fx.db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(fx.checkout.rootId)
    await expectError(fx, await get(fx, `/api/artifact-versions/${c.versionId}/preview`), 409, 'git-repository-unavailable')
    const d = await doc()
    assert.equal(d.versions.find(v => v.versionId === c.versionId)!.availability, 'unknown', 'unverified, not claimed unavailable')
    assert.equal(d.document.availability, 'stale', 'no longer "Git only"')
  } finally {
    await fx.close()
  }
})

// Fix round 2 (E6): the preview route reads through the same pin as the object check, so the two never disagree. A de-initialized
// submodule (its gitfile removed, its repository kept under the superproject's .git/modules) keeps serving its own bytes.
test('fix round 2 (E6): a Git preview is pinned to the recorded repository: a de-initialized submodule serves its own blob', async () => {
  const fx = await fixture()
  try {
    const sup = join(fx.home, 'super')
    git(fx.home, fx.home, 'init', '-q', '-b', 'main', sup)
    git(sup, fx.home, 'commit', '-q', '--allow-empty', '-m', 'super')
    const sub = join(sup, 'sub')
    const modules = join(sup, '.git', 'modules', 'sub')
    mkdirSync(join(sup, '.git', 'modules'))
    git(fx.home, fx.home, 'init', '-q', '-b', 'main', `--separate-git-dir=${modules}`, sub)
    writeFileSync(join(sub, 'doc.md'), 'submodule bytes\n')
    git(sub, fx.home, 'add', 'doc.md')
    git(sub, fx.home, 'commit', '-q', '-m', 'sub')
    const blob = git(sub, fx.home, 'rev-parse', 'HEAD:doc.md')
    const commit = git(sub, fx.home, 'rev-parse', 'HEAD')
    const repositoryId = registerArtifactRepository(fx.db, { commonDir: modules, displayName: 'sub', remoteIdentity: null }, T0)
    const root = registerArtifactRoot(fx.db, { kind: 'checkout', canonicalPath: sub, repositoryId, projectName: 'sub', checkoutIdentity: 'ck-sub', protected: false, scopeFlags: ['checkout'] }, T0)
    const v = recordArtifactObservation(fx.db, {
      rootId: root.rootId, identity: { identityKind: 'repository', repositoryId, rootId: null, relativePath: 'doc.md' }, kind: 'commit', observedAt: OBS,
      git: { repositoryId, commitOid: commit, gitPath: 'doc.md', blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 16 },
    }, NOW).versionId!
    unlinkSync(join(sub, '.git'))
    const res = await get(fx, `/api/artifact-versions/${v}/preview`)
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(await res.text(), 'submodule bytes\n')
    assert.equal(fx.gitOptions.at(-1)?.gitDir, modules)
    assert.equal((fx.db.raw.prepare('SELECT availability AS a FROM artifact_version_state WHERE version_id = ?').get(v) as { a: string }).a, 'available')
  } finally {
    await fx.close()
  }
})

// PR #19 follow-up review, finding 2 (R91): the metadata reads enforce the path policy even when a catalog flag is stale.
test('a document left with protected = 0 whose path has a .phi segment is still refused by the default detail and version reads', async () => {
  const fx = await fixture()
  try {
    mkdirSync(join(fx.outDir, '.phi'))
    const stale = outFile(fx, '.phi/synthetic-report.md', 'synthetic\n')
    fx.db.raw.prepare('UPDATE artifacts SET is_sensitive = 0').run()
    fx.db.raw.prepare('UPDATE artifact_documents SET protected = 0').run()
    // A document whose relative path is clean but which has a second location under .phi/ (and a stale flag).
    const plain = outFile(fx, 'plain-notes.md', 'ordinary\n')
    const copy = upsertArtifact(fx.db, { path: join(fx.outDir, '.phi', 'copy.md'), sizeBytes: 1, createdAt: T0, projectName: 'reports', now: T0 })
    fx.db.raw.prepare('UPDATE artifacts SET document_id = ? WHERE artifact_id = ?').run(plain.documentId, copy.artifactId)
    const control = outFile(fx, 'control-notes.md', 'ordinary\n')

    for (const doc of [stale, plain]) {
      await expectError(fx, await get(fx, `/api/artifact-documents/${doc.documentId}`), 404, 'not-found')
      assert.equal((await get(fx, `/api/artifact-documents/${doc.documentId}?sensitive=only`)).status, 200, 'listed as protected under only')
    }
    await expectError(fx, await get(fx, `/api/artifact-versions/${stale.versionId}/preview`), 404, 'not-found')
    assert.equal((await get(fx, `/api/artifact-documents/${stale.documentId}?sensitive=show`)).status, 200, 'shown on request, like a flagged document')
    assert.equal((await get(fx, `/api/artifact-documents/${control.documentId}`)).status, 200, 'a document with no PHI path is unaffected')
  } finally { await fx.close() }
})
