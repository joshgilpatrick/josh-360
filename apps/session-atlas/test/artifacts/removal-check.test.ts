import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import {
  ARTIFACT_JOB_PRIORITY, enqueueArtifactJob, readArtifactCoverageNote, recordArtifactObservation, registerArtifactRoot,
} from '../../src/db/artifact-manager.ts'
import { loadConfig } from '../../src/config.ts'
import type { ArtifactWorkerEvent } from '../../src/service/artifact-worker.ts'
import { artifactManagerRunner } from '../../src/service/artifact-manager-runner.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { startRouteServer } from '../helpers/server.ts'
import { silentLogger } from '../helpers/log.ts'
import { artifactGitSpawnCount } from '../../src/artifacts/git.ts'
import {
  checkWorktreeRemoval, REMOVAL_CHECK_REMOTE_RETENTION_NOTE, type RemovalCheckIssue, type RemovalCheckOptions, type RemovalCheckResult,
} from '../../src/artifacts/removal-check.ts'

// Every repository, catalog and home directory here is a temporary fixture. This process's own Git environment is isolated
// first (temporary HOME, no system or global config, no inherited GIT_* variables), so neither the fixture commands nor the
// adapter's configuration view can read or write the real home. Fixture commands carry their identity with -c.

for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') || key.startsWith('ATLAS_')) delete process.env[key]
const FIXTURE_HOME = realpathSync(tempDir('atlas-rc-home-'))
process.env.HOME = FIXTURE_HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
delete process.env.XDG_CONFIG_HOME

const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false']
const NOW = '2026-10-27T12:00:00.000Z'
const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n'

function git(cwd: string, args: string[], opts: { env?: Record<string, string> } = {}): Buffer {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
}
const gitText = (cwd: string, args: string[]): string => git(cwd, args).toString('utf8').replace(/\n$/, '')

function put(root: string, rel: string, content: string | Buffer = 'x\n'): string {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

function commitAll(repo: string, message: string): string {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '--allow-empty', '-m', message])
  return gitText(repo, ['rev-parse', 'HEAD'])
}

type Fx = { base: string; main: string; wt: string; catalog: string }

// One migrated, empty catalog, copied into each fixture (migrating a fresh database per fixture costs ~35 ms each).
const TEMPLATE_CATALOG = join(realpathSync(tempDir('atlas-rc-catalog-')), 'atlas.db')
openDatabase(TEMPLATE_CATALOG).close()

const DEFAULT_FILES: Record<string, string> = { 'README.md': '# readme\n', 'docs/guide.md': 'guide\n', 'src/app.ts': 'export {}\n' }

/**
 * A repository with a committed baseline, one linked worktree at `<main>/.claude/worktrees/feat` (on a new branch `feat`, or
 * detached at the baseline) and an empty, migrated Atlas catalog outside both.
 */
function fixture(opts: { files?: Record<string, string>; detach?: boolean; beforeWorktree?: (main: string) => void } = {}): Fx {
  if (opts.files === undefined && !opts.detach && opts.beforeWorktree === undefined) return copyOfDefaultFixture()
  return buildFixture(opts)
}

let defaultFixture: Fx | null = null

/**
 * The default fixture, built once and copied (a fresh build costs four Git processes). Only the two absolute links between the
 * worktree and its administrative directory are rewritten for the new location; Git re-reads the copied files' stat data.
 */
function copyOfDefaultFixture(): Fx {
  defaultFixture ??= buildFixture({})
  const base = realpathSync(tempDir('atlas-rc-'))
  cpSync(defaultFixture.base, base, { recursive: true })
  const main = join(base, 'repo')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  writeFileSync(join(main, '.git', 'worktrees', 'feat', 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  return { base, main, wt, catalog: join(base, 'atlas', 'atlas.db') }
}

function buildFixture(opts: { files?: Record<string, string>; detach?: boolean; beforeWorktree?: (main: string) => void }): Fx {
  const base = realpathSync(tempDir('atlas-rc-'))
  const main = join(base, 'repo')
  git(base, ['init', '-q', main])
  for (const [rel, content] of Object.entries(opts.files ?? DEFAULT_FILES)) put(main, rel, content)
  opts.beforeWorktree?.(main)
  commitAll(main, 'baseline')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  git(main, ['worktree', 'add', '-q', ...(opts.detach ? ['--detach', wt] : ['-b', 'feat', wt])])
  const catalog = join(base, 'atlas', 'atlas.db')
  mkdirSync(dirname(catalog))
  copyFileSync(TEMPLATE_CATALOG, catalog)
  return { base, main, wt, catalog }
}

function withCatalog(fx: Fx, fn: (db: AtlasDb) => void): void {
  const db = openDatabase(fx.catalog)
  try { fn(db) } finally { db.close() }
}

function registerRoot(db: AtlasDb, path: string, kind: 'output' | 'session-directory' | 'checkout', prot = false): string {
  const flags: Array<'cli-output' | 'session-cwd' | 'checkout'> = kind === 'output' ? ['cli-output'] : kind === 'checkout' ? ['checkout'] : ['session-cwd']
  return registerArtifactRoot(db, { kind, canonicalPath: path, repositoryId: null, projectName: null, checkoutIdentity: null, protected: prot, scopeFlags: flags }, NOW).rootId
}

function knownLocation(db: AtlasDb, rootId: string, rootPath: string, path: string): void {
  recordArtifactObservation(db, {
    rootId, identity: { identityKind: 'root', repositoryId: null, rootId, relativePath: path.slice(rootPath.length + 1) }, kind: 'working', observedAt: NOW, path,
    stat: { dev: '1', ino: '2', size: 3, mtimeMs: Date.parse(NOW), ctimeMs: Date.parse(NOW) },
  }, NOW)
}

const INACTIVE = async (): Promise<'inactive'> => 'inactive'

/** Every result this file produces, for the coverage-invariant test at the end. */
const RESULTS: RemovalCheckResult[] = []

// Which coverage field an unknown makes incomplete (the brief: "... makes coverage incomplete").
const FILESYSTEM_UNKNOWNS = ['protected-unverified', 'oversized', 'budget-exceeded', 'catalog-root-incomplete', 'permission-denied', 'walk-cap', 'copy-unverified']
const GIT_UNKNOWNS = ['lfs-unverified', 'filter-unverified', 'representation-unverified', 'submodule-unverified', 'object-unavailable', 'retention-unknown', 'git-incomplete', 'head-unresolved', 'inventory-mismatch', 'worktree-locked', 'contains-worktree']

/**
 * exit 0 => every coverage field complete (catalog complete, sessions inactive) and nothing listed; exit 2 => no risk and at
 * least one coverage field short of that, matching the unknowns listed; unknowns without risks => exit 2.
 */
function assertCoverageInvariant(r: RemovalCheckResult): void {
  RESULTS.push(r)
  const { filesystem, git: gitCoverage, catalog, sessions } = r.coverage
  const complete = filesystem === 'complete' && gitCoverage === 'complete' && catalog === 'complete' && sessions === 'inactive'
  const label = JSON.stringify({ exitCode: r.exitCode, coverage: r.coverage, unknowns: r.unknowns.map(i => i.code), risks: r.risks.map(i => i.code) })
  if (r.exitCode === 0) assert.ok(complete && r.risks.length === 0 && r.unknowns.length === 0, `exit 0 with gaps: ${label}`)
  if (r.exitCode === 2) assert.ok(!complete && r.risks.length === 0, `exit 2 with complete coverage: ${label}`)
  if (r.risks.length === 0 && r.unknowns.length > 0) assert.equal(r.exitCode, 2, label)
  for (const u of r.unknowns) {
    if (FILESYSTEM_UNKNOWNS.includes(u.code)) assert.equal(filesystem, 'incomplete', `${u.code} leaves filesystem coverage incomplete: ${label}`)
    if (GIT_UNKNOWNS.includes(u.code)) assert.equal(gitCoverage, 'incomplete', `${u.code} leaves git coverage incomplete: ${label}`)
    if (u.code === 'catalog-missing') assert.equal(catalog, 'missing', label)
    if (u.code === 'catalog-error') assert.equal(catalog, 'error', label)
    if (u.code === 'session-unknown') assert.equal(sessions, 'unknown', label)
  }
}

async function check(fx: Fx, options: RemovalCheckOptions = {}, target: string = fx.wt): Promise<RemovalCheckResult> {
  const r = await checkWorktreeRemoval(target, { catalogPath: fx.catalog, probeSessionActivity: INACTIVE, callerCwd: fx.base, ...options })
  assertCoverageInvariant(r)
  return r
}

const codes = (list: RemovalCheckIssue[]): string[] => [...new Set(list.map(i => i.code))].sort()
const pathsOf = (list: RemovalCheckIssue[], code: string): Array<string | null> => list.filter(i => i.code === code).map(i => i.path).sort()

function assertSafe(r: RemovalCheckResult, label = 'expected a safe result'): void {
  assert.deepEqual({ risks: r.risks, unknowns: r.unknowns }, { risks: [], unknowns: [] }, label)
  assert.deepEqual(r.coverage, { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'inactive' }, label)
  assert.equal(r.exitCode, 0, label)
}

function assertBlocked(r: RemovalCheckResult, exitCode: 2 | 3, label: string): void {
  assert.equal(r.exitCode, exitCode, `${label}: ${JSON.stringify({ risks: r.risks, unknowns: r.unknowns, coverage: r.coverage })}`)
  if (exitCode === 3) assert.ok(r.risks.length > 0, `${label}: exit 3 lists its risks`)
  else assert.deepEqual(r.risks, [], `${label}: exit 2 has no risks`)
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code })
}

/** Path -> size, mtime and content hash of every file and directory under `root` (Git internals included). */
function snapshotTree(root: string, skip: string[] = []): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (skip.includes(full)) continue
      const st = statSync(full, { bigint: true })
      if (st.isDirectory()) {
        out.set(full, `dir:${st.mtimeNs}`)
        walk(full)
      } else {
        out.set(full, `${st.size}:${st.mtimeNs}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------------------------------------------------------- safe

test('a clean worktree on its own branch is safe: exit 0, complete coverage, the probe gets the canonical target', async () => {
  const fx = fixture()
  // Non-document untracked files and document-named files inside fixed dependency/build caches are not protected content.
  put(fx.wt, '.gitignore', 'node_modules/\ndist/\n*.log\n')
  put(fx.wt, 'scratch.bin', 'b')
  put(fx.wt, 'tool.log', 'l')
  put(fx.wt, 'node_modules/pkg/README.md', 'dependency readme')
  put(fx.wt, 'dist/build/notes.md', 'generated')
  const probed: string[] = []
  const r = await check(fx, { probeSessionActivity: async target => { probed.push(target); return 'inactive' } })
  assertSafe(r)
  assert.equal(r.target, fx.wt)
  assert.deepEqual(probed, [fx.wt])
  assert.ok(Number.isFinite(Date.parse(r.checkedAt)) && new Date(r.checkedAt).toISOString() === r.checkedAt, 'checkedAt is an ISO timestamp')

  // A tracked document edited identically in the main checkout is preserved by that verified copy.
  put(fx.wt, 'docs/guide.md', 'guide v2\n')
  put(fx.main, 'docs/guide.md', 'guide v2\n')
  assertSafe(await check(fx), 'the edited working version has a verified identical copy outside the target')
})

test('remote retention is never checked or claimed, and a configured remote does not block a safe result', async () => {
  const fx = fixture()
  git(fx.main, ['remote', 'add', 'origin', 'https://example.invalid/never-pushed.git'])
  const r = await check(fx)
  assertSafe(r)
  assert.match(REMOVAL_CHECK_REMOTE_RETENTION_NOTE, /remote/i)
  assert.match(REMOVAL_CHECK_REMOTE_RETENTION_NOTE, /not a (remote )?backup|never .*backup|not .*backed up/i)
  assert.equal(JSON.stringify(r).includes('backup'), false, 'the result never claims a backup')
})

// ------------------------------------------------------------------------------------------------- untracked / ignored

test('untracked and ignored documents are both enumerated and are risks; user ignore segments never hide them', async () => {
  const fx = fixture()
  put(fx.wt, '.gitignore', 'out/\n*.log\n')
  put(fx.wt, 'notes.md', 'untracked notes')
  put(fx.wt, '.scratch/draft.md', 'a draft under the default ignoreSegments name')
  put(fx.wt, 'out/report.md', 'ignored report')
  put(fx.wt, 'out/deep/table.csv', 'a,b\n')
  put(fx.wt, 'tool.log', 'ignored non-document')
  put(fx.wt, 'scratch.bin', 'untracked non-document')
  const r = await check(fx)
  assertBlocked(r, 3, 'unique untracked and ignored documents')
  assert.deepEqual(r.unknowns, [])
  assert.deepEqual(pathsOf(r.risks, 'unpreserved-untracked'), [join(fx.wt, '.scratch/draft.md'), join(fx.wt, 'notes.md')])
  assert.deepEqual(pathsOf(r.risks, 'unpreserved-ignored'), [join(fx.wt, 'out/deep/table.csv'), join(fx.wt, 'out/report.md')])
  assert.equal(r.risks.length, 4, 'non-documents are not listed')
  assert.equal(JSON.stringify(r).includes('ignored report'), false, 'details never carry file contents')

  // An unusable extension list falls back to the configured set instead of protecting nothing.
  const fallback = await check(fx, { documentExtensions: [] })
  assert.deepEqual(fallback.risks, r.risks)
  const custom = await check(fx, { documentExtensions: ['.CSV'] })
  assert.deepEqual(custom.risks.map(i => i.path), [join(fx.wt, 'out/deep/table.csv')], 'a configured list replaces the default one')
})

test('documents ignored through info/exclude or the user\'s global excludes file are still found', async () => {
  const fx = fixture()
  writeFileSync(join(fx.main, '.git', 'info', 'exclude'), 'private/\n')
  const excludes = join(FIXTURE_HOME, 'global-excludes')
  const globalConfig = join(FIXTURE_HOME, '.gitconfig')
  writeFileSync(excludes, '*.draft.md\n')
  writeFileSync(globalConfig, `[core]\n\texcludesFile = ${excludes}\n`)
  try {
    put(fx.wt, 'private/plan.md', 'plan')
    put(fx.wt, 'ideas.draft.md', 'ideas')
    // The user's own Git (with that global config) shows neither as untracked.
    assert.equal(gitText(fx.wt, ['-c', `core.excludesFile=${excludes}`, 'status', '--porcelain', '-uall']), '')
    const r = await check(fx)
    assertBlocked(r, 3, 'globally ignored output')
    const flagged = r.risks.filter(i => i.code === 'unpreserved-ignored' || i.code === 'unpreserved-untracked').map(i => i.path).sort()
    assert.deepEqual(flagged, [join(fx.wt, 'ideas.draft.md'), join(fx.wt, 'private/plan.md')])
  } finally {
    rmSync(globalConfig, { force: true })
  }
})

test('fixed caches are skipped, but never inside a registered output root, for a known location or under a protected root', async () => {
  const fx = fixture()
  put(fx.wt, '.gitignore', 'build/\n')
  put(fx.wt, 'build/cache/notes.md', 'cache')
  assertSafe(await check(fx), 'a document in a fixed build cache is not protected content')

  // A registered output root inside the cache: its documents are protected although `build/` is a fixed cache segment.
  put(fx.wt, 'build/out/summary.md', 'deliverable')
  withCatalog(fx, db => { registerRoot(db, join(fx.wt, 'build/out'), 'output') })
  let r = await check(fx)
  assertBlocked(r, 3, 'registered output root inside a cache')
  assert.deepEqual(r.risks.map(i => i.path), [join(fx.wt, 'build/out/summary.md')])

  // A known artifact location (any extension, inside a cache) is protected too.
  const fx2 = fixture()
  put(fx2.wt, '.gitignore', 'build/\n')
  const data = put(fx2.wt, 'build/cache/data.bin', 'known artifact')
  withCatalog(fx2, db => {
    const rootId = registerRoot(db, fx2.wt, 'session-directory')
    knownLocation(db, rootId, fx2.wt, data)
  })
  r = await check(fx2)
  assertBlocked(r, 3, 'known location inside a cache')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['unpreserved-ignored', data]])

  // A known location that no longer exists has nothing left to lose.
  unlinkSync(data)
  assertSafe(await check(fx2), 'a missing known location')
})

// -------------------------------------------------------------------------------------------------- index and working

test('staged and working versions are checked independently; the index is never preservation', async () => {
  const fx = fixture()
  put(fx.wt, 'docs/guide.md', 'staged version\n')
  git(fx.wt, ['add', 'docs/guide.md'])
  put(fx.wt, 'docs/guide.md', 'working version\n')
  let r = await check(fx)
  assertBlocked(r, 3, 'stage/working divergence')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]).sort(), [['staged-unpreserved', join(fx.wt, 'docs/guide.md')], ['unpreserved-working', join(fx.wt, 'docs/guide.md')]])

  // Working file back to the committed bytes: only the staged-only version remains at risk.
  put(fx.wt, 'docs/guide.md', 'guide\n')
  r = await check(fx)
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['staged-unpreserved', join(fx.wt, 'docs/guide.md')]])

  // A newly staged document whose working file equals the staged blob: both versions exist only in this worktree.
  git(fx.wt, ['reset', '-q', '--', 'docs/guide.md'])
  put(fx.wt, 'new.md', 'staged and identical\n')
  git(fx.wt, ['add', 'new.md'])
  r = await check(fx)
  assert.deepEqual(r.risks.map(i => [i.code, i.path]).sort(), [['staged-unpreserved', join(fx.wt, 'new.md')], ['unpreserved-working', join(fx.wt, 'new.md')]])

  // A same-size copy outside the target that differs proves neither version: bytes are compared, not sizes.
  put(fx.main, 'new.md', 'staged and IDENTICAL\n')
  assert.equal(statSync(join(fx.main, 'new.md')).size, statSync(join(fx.wt, 'new.md')).size)
  r = await check(fx)
  assert.deepEqual(r.risks.map(i => [i.code, i.path]).sort(), [['staged-unpreserved', join(fx.wt, 'new.md')], ['unpreserved-working', join(fx.wt, 'new.md')]])
  put(fx.main, 'new.md', 'staged and identical\n')
  assertSafe(await check(fx), 'an identical copy proves both the staged and the working version')
})

test('a same-size edit of a tracked document is compared byte for byte with the committed blob', async () => {
  const fx = fixture()
  put(fx.wt, 'docs/guide.md', 'GUIDE\n')
  assert.equal(statSync(join(fx.wt, 'docs/guide.md')).size, 'guide\n'.length)
  const r = await check(fx)
  assertBlocked(r, 3, 'same-size edit')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['unpreserved-working', join(fx.wt, 'docs/guide.md')]])
})

test('a staged deletion that hides a working copy is a risk; a plain staged deletion is not', async () => {
  const fx = fixture()
  git(fx.wt, ['rm', '--cached', '-q', 'docs/guide.md'])
  const r = await check(fx)
  assertBlocked(r, 3, 'staged deletion hiding a working copy')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['staged-deletion', join(fx.wt, 'docs/guide.md')]])

  const fx2 = fixture()
  git(fx2.wt, ['rm', '-q', 'docs/guide.md'])
  assertSafe(await check(fx2), 'the deleted version stays in the retained commit')
})

test('assume-unchanged and skip-worktree edits that status hides are found by comparing bytes', async () => {
  const fx = fixture()
  git(fx.wt, ['update-index', '--assume-unchanged', 'docs/guide.md'])
  git(fx.wt, ['update-index', '--skip-worktree', 'README.md'])
  assertSafe(await check(fx), 'flagged but unchanged files are still proven by their bytes')
  put(fx.wt, 'docs/guide.md', 'hidden edit\n')
  put(fx.wt, 'README.md', '# hidden readme edit\n')
  assert.equal(gitText(fx.wt, ['status', '--porcelain']), '', 'status cannot see either edit')
  const r = await check(fx)
  assertBlocked(r, 3, 'hidden edits')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]).sort(), [['hidden-edit', join(fx.wt, 'README.md')], ['hidden-edit', join(fx.wt, 'docs/guide.md')]])
})

test('a clean status is not byte equality: an end-of-line conversion leaves the version unproven', async () => {
  const fx = fixture()
  git(fx.wt, ['config', 'core.autocrlf', 'true'])
  put(fx.wt, 'docs/guide.md', 'guide\r\n')
  git(fx.wt, ['add', 'docs/guide.md'])
  assert.equal(gitText(fx.wt, ['status', '--porcelain']), '', 'Git calls it clean under its conversion')
  const r = await check(fx)
  assertBlocked(r, 2, 'converted working bytes')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['representation-unverified', join(fx.wt, 'docs/guide.md')]])
})

test('unresolved conflicts and in-progress operations block removal, for documents and other files alike', async () => {
  const fx = fixture()
  put(fx.main, 'docs/guide.md', 'main side\n')
  put(fx.main, 'src/app.ts', 'export const side = "main"\n')
  commitAll(fx.main, 'main edit')
  put(fx.wt, 'docs/guide.md', 'feat side\n')
  put(fx.wt, 'src/app.ts', 'export const side = "feat"\n')
  commitAll(fx.wt, 'feat edit')
  assert.throws(() => git(fx.wt, ['merge', '-q', 'main']))
  const r = await check(fx)
  assertBlocked(r, 3, 'conflicts')
  assert.deepEqual(pathsOf(r.risks, 'conflict'), [join(fx.wt, 'docs/guide.md'), join(fx.wt, 'src/app.ts')])
  assert.ok(codes(r.risks).includes('operation-in-progress'))

  // A merge stopped before its commit (no conflict) keeps its state in the worktree's Git directory.
  const fx2 = fixture()
  put(fx2.main, 'other.ts', 'export {}\n')
  commitAll(fx2.main, 'main adds a file')
  put(fx2.wt, 'feat.ts', 'export {}\n')
  commitAll(fx2.wt, 'feat adds a file')
  git(fx2.wt, ['merge', '-q', '--no-commit', '--no-ff', 'main'])
  const r2 = await check(fx2)
  assertBlocked(r2, 3, 'merge in progress')
  assert.deepEqual(codes(r2.risks), ['operation-in-progress'])
})

// ------------------------------------------------------------------------------------------------------- preservation

test('only a verified identical regular file outside the target is a copy: same name, size and time are never proof', async () => {
  const fx = fixture()
  put(fx.wt, 'reports/q3.md', 'quarterly numbers\n')
  put(fx.main, 'reports/q3.md', 'quarterly numbers\n')
  assertSafe(await check(fx), 'exact copy outside the target')

  put(fx.main, 'reports/q3.md', 'quarterly NUMBERS\n')
  const t = new Date('2026-01-01T00:00:00Z')
  utimesSync(join(fx.main, 'reports/q3.md'), t, t)
  utimesSync(join(fx.wt, 'reports/q3.md'), t, t)
  assert.equal(statSync(join(fx.main, 'reports/q3.md')).size, statSync(join(fx.wt, 'reports/q3.md')).size)
  const r = await check(fx)
  assertBlocked(r, 3, 'same-size divergent copy')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['unpreserved-untracked', join(fx.wt, 'reports/q3.md')]])
})

test('a copy reached through a symlink into the target, or a symlink candidate, is not preservation', async () => {
  const fx = fixture()
  put(fx.wt, 'out/r.md', 'only here\n')
  symlinkSync(join(fx.wt, 'out'), join(fx.main, 'out'))
  const r = await check(fx)
  assertBlocked(r, 3, 'copy resolving into the target')
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['unpreserved-untracked', join(fx.wt, 'out/r.md')]])

  const fx2 = fixture()
  put(fx2.wt, 'notes/a.md', 'kept elsewhere\n')
  put(fx2.base, 'elsewhere/a.md', 'kept elsewhere\n')
  mkdirSync(join(fx2.main, 'notes'))
  symlinkSync(join(fx2.base, 'elsewhere/a.md'), join(fx2.main, 'notes/a.md'))
  assertBlocked(await check(fx2), 3, 'a file symlink is not a regular-file copy')
})

test('retention: a named branch or tag counts; a detached HEAD, a deleted branch, the reflog or a remote-tracking ref does not', async () => {
  const detachedAtMain = fixture({ detach: true })
  assertSafe(await check(detachedAtMain), 'detached at a commit that main retains')

  const fx = fixture({ detach: true })
  put(fx.wt, 'docs/guide.md', 'committed while detached\n')
  const commit = commitAll(fx.wt, 'detached work')
  let r = await check(fx)
  assertBlocked(r, 3, 'detached-only commit')
  assert.ok(codes(r.risks).includes('unretained-commit'))
  assert.deepEqual(pathsOf(r.risks, 'unpreserved-working'), [join(fx.wt, 'docs/guide.md')], 'a version only in that commit is not preserved')

  git(fx.main, ['update-ref', 'refs/remotes/origin/feat', commit])
  r = await check(fx)
  assertBlocked(r, 3, 'remote-tracking ref only')
  assert.ok(codes(r.risks).includes('unretained-commit'))

  git(fx.main, ['tag', 'keep', commit])
  assertSafe(await check(fx), 'a local tag retains the commit')

  // A branch that retained the commit, deleted: the reflog still has it, which does not count.
  const fx2 = fixture()
  git(fx2.wt, ['checkout', '-q', '-b', 'temp'])
  put(fx2.wt, 'docs/guide.md', 'on temp\n')
  commitAll(fx2.wt, 'temp work')
  git(fx2.wt, ['checkout', '-q', '--detach'])
  git(fx2.wt, ['branch', '-q', '-D', 'temp'])
  git(fx2.wt, ['branch', '-q', '-D', 'feat'])
  r = await check(fx2)
  assertBlocked(r, 3, 'deleted branch')
  assert.ok(codes(r.risks).includes('unretained-commit'))
})

test('a missing blob or a missing branch ref is never proof', async () => {
  const fx = fixture()
  const oid = gitText(fx.main, ['rev-parse', 'HEAD:docs/guide.md'])
  rmSync(join(fx.main, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
  let r = await check(fx)
  assertBlocked(r, 2, 'missing blob')
  assert.ok(codes(r.unknowns).includes('object-unavailable'), JSON.stringify(r.unknowns))
  assert.equal(r.coverage.git, 'incomplete')

  // The worktree's branch ref vanishes (removed behind Git's back): nothing retains its tracked versions.
  const fx2 = fixture()
  rmSync(join(fx2.main, '.git', 'refs', 'heads', 'feat'))
  r = await check(fx2)
  assertBlocked(r, 2, 'branch ref removed behind Git\'s back')
  assert.deepEqual(codes(r.unknowns), ['head-unresolved'])
})

// ----------------------------------------------------------------------------------------------------------- targets

test('the main checkout, a subdirectory, a symlink, a missing path, a non-repository and a bad spelling are refused', async () => {
  const fx = fixture()
  let r = await check(fx, {}, fx.main)
  assertBlocked(r, 3, 'main checkout')
  assert.deepEqual(codes(r.risks), ['main-checkout'])
  assert.equal(r.coverage.git, 'incomplete')

  r = await check(fx, {}, join(fx.wt, 'docs'))
  assertBlocked(r, 2, 'subdirectory of a worktree')
  assert.deepEqual(codes(r.unknowns), ['not-worktree-root'])

  const link = join(fx.base, 'link-to-wt')
  symlinkSync(fx.wt, link)
  r = await check(fx, {}, link)
  assertBlocked(r, 2, 'symlink target')
  assert.deepEqual(codes(r.unknowns), ['target-symlink'])

  r = await check(fx, {}, join(fx.base, 'missing'))
  assertBlocked(r, 2, 'missing target')
  assert.deepEqual(codes(r.unknowns), ['unknown-target'])

  const plain = join(fx.base, 'plain')
  mkdirSync(plain)
  r = await check(fx, {}, plain)
  assertBlocked(r, 2, 'not a repository')
  assert.deepEqual(codes(r.unknowns), ['unknown-target'])

  const bare = join(fx.base, 'bare.git')
  git(fx.base, ['init', '-q', '--bare', bare])
  r = await check(fx, {}, bare)
  assertBlocked(r, 2, 'bare repository')
  assert.deepEqual(codes(r.unknowns), ['unknown-target'])

  for (const spelling of ['relative/path', '', `${fx.wt}\0x`]) {
    r = await check(fx, {}, spelling)
    assertBlocked(r, 2, `bad spelling ${JSON.stringify(spelling)}`)
    assert.deepEqual(codes(r.unknowns), ['invalid-target'])
  }
})

test('a worktree containing another worktree or a registered checkout root, or a locked one, is not resolved', async () => {
  const fx = fixture()
  git(fx.main, ['worktree', 'add', '-q', '-b', 'inner', join(fx.wt, 'inner')])
  let r = await check(fx)
  assertBlocked(r, 2, 'nested worktree')
  assert.ok(codes(r.unknowns).includes('contains-worktree'))

  const fx2 = fixture()
  mkdirSync(join(fx2.wt, 'vendored'))
  withCatalog(fx2, db => { registerRoot(db, join(fx2.wt, 'vendored'), 'checkout') })
  r = await check(fx2)
  assertBlocked(r, 2, 'registered checkout root inside the target')
  assert.ok(codes(r.unknowns).includes('contains-worktree'))

  const fx3 = fixture()
  git(fx3.main, ['worktree', 'lock', fx3.wt])
  r = await check(fx3)
  assertBlocked(r, 2, 'locked worktree')
  assert.deepEqual(codes(r.unknowns), ['worktree-locked'])
})

test('gitlinks and nested repositories are unverified units', async () => {
  const fx = fixture()
  git(fx.wt, ['init', '-q', 'vendor/lib'])
  put(fx.wt, 'vendor/lib/notes.md', 'inside a nested repository')
  let r = await check(fx)
  assertBlocked(r, 2, 'nested repository')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['submodule-unverified', join(fx.wt, 'vendor/lib')]])

  const fx2 = fixture()
  const sub = join(fx2.wt, 'modules/sub')
  git(fx2.wt, ['init', '-q', 'modules/sub'])
  put(sub, 'x.md', 'x')
  commitAll(sub, 'sub baseline')
  git(fx2.wt, ['add', 'modules/sub'])
  commitAll(fx2.wt, 'add gitlink')
  r = await check(fx2)
  assertBlocked(r, 2, 'gitlink')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['submodule-unverified', join(fx2.wt, 'modules/sub')]])

  // A `.git` entry that Git does not accept as a repository: the walk still does not enter the directory, and says so.
  const odd = fixture()
  put(odd.wt, 'odd/.git', 'not a gitdir pointer')
  put(odd.wt, 'odd/a.md', 'inside')
  r = await check(odd)
  assertBlocked(r, 2, 'unusable .git entry')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['submodule-unverified', join(odd.wt, 'odd')]])

  // An uninitialized gitlink (empty directory) is still unverified: its commit's retention is not proven.
  const fx3 = fixture()
  const gl = gitText(fx3.main, ['rev-parse', 'HEAD'])
  git(fx3.wt, ['update-index', '--add', '--cacheinfo', `160000,${gl},modules/empty`])
  mkdirSync(join(fx3.wt, 'modules/empty'), { recursive: true })
  r = await check(fx3)
  assertBlocked(r, 2, 'uninitialized gitlink')
  assert.deepEqual(codes(r.unknowns), ['submodule-unverified'])
})

// ---------------------------------------------------------------------------------------------------------- sessions

test('sessions: active is a risk; unknown, failing, malformed, hanging or absent probes are incomplete; catalog state is context', async () => {
  const fx = fixture()
  withCatalog(fx, db => { ensureSession(db, { sessionId: SID, cwd: join(fx.wt, 'docs'), startedAt: NOW, now: NOW }) })

  let r = await check(fx, { probeSessionActivity: async () => 'active' })
  assertBlocked(r, 3, 'active session')
  assert.deepEqual(codes(r.risks), ['active-session'])
  assert.equal(r.coverage.sessions, 'active')
  assert.ok(r.risks[0]!.detail.includes(SID), 'the catalog session inside the target is named')

  // A catalog row that still says "active" is stale context: the probe decides.
  assertSafe(await check(fx), 'a stale catalog session with an inactive probe')

  const incomplete: Array<[string, RemovalCheckOptions]> = [
    ['unknown', { probeSessionActivity: async () => 'unknown' }],
    ['absent', { probeSessionActivity: undefined }],
    ['throws', { probeSessionActivity: async () => { throw new Error('service down') } }],
    ['malformed', { probeSessionActivity: async () => 'idle' as unknown as 'inactive' }],
    ['hangs', { probeSessionActivity: () => new Promise(() => {}), limits: { probeTimeoutMs: 20 } }],
  ]
  for (const [label, options] of incomplete) {
    r = await check(fx, options)
    assertBlocked(r, 2, `probe ${label}`)
    assert.equal(r.coverage.sessions, 'unknown', label)
    assert.deepEqual(codes(r.unknowns), ['session-unknown'], label)
    assert.equal(JSON.stringify(r).includes('service down'), false, 'probe error text is not forwarded')
  }
})

test('a caller whose working directory is inside the target is a risk', async () => {
  const fx = fixture()
  const r = await check(fx, { callerCwd: join(fx.wt, 'docs') })
  assertBlocked(r, 3, 'caller inside')
  assert.deepEqual(codes(r.risks), ['caller-inside-target'])
})

// ------------------------------------------------------------------------------------------------------- protection

test('a `.phi` folder is PHI like `phi`: its files are never read and never proven, a look-alike name is an ordinary document (R85)', async () => {
  const fx = fixture({ files: { ...DEFAULT_FILES, 'data/athena/csv/.phi/patients.md': 'tracked dot-phi' } })
  const scan = put(fx.wt, 'x/.PHI/scan.md', 'untracked dot-phi bytes')
  const delphi = put(fx.wt, 'notes/.phix/plan.md', 'ordinary bytes\n')
  const reads: string[] = []
  const r = await check(fx, { hooks: { beforeFs: (op, path) => { if (op === 'read') reads.push(path) } } })
  assertBlocked(r, 3, 'dot-phi files')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]).sort(), [
    ['protected-unverified', join(fx.wt, 'data/athena/csv/.phi/patients.md')],
    ['protected-unverified', join(fx.wt, 'x/.PHI/scan.md')],
  ])
  for (const p of [scan, join(fx.wt, 'data/athena/csv/.phi/patients.md')]) assert.ok(!reads.includes(p), `${p} was never read`)
  assert.ok(reads.includes(delphi), 'a `.phix` folder is not PHI, so its document is compared')
  for (const secret of ['tracked dot-phi', 'untracked dot-phi bytes']) assert.equal(JSON.stringify(r).includes(secret), false)
})

test('PHI paths, protected roots and secret-looking documents are never read and never proven', async () => {
  const fx = fixture({ files: { ...DEFAULT_FILES, 'phi/intake.bin': 'tracked protected', 'config/credentials.json': '{"k":"tracked secret"}' } })
  // The upper-case and lower-case folders sit under different parents: on a case-insensitive volume `PHI` and `phi` would be one folder.
  const scan = put(fx.wt, 'x/PHI/scan.dcm', 'untracked protected bytes')
  const priv = put(fx.wt, 'private/x.bin', 'protected-root bytes')
  withCatalog(fx, db => { registerRoot(db, join(fx.wt, 'private'), 'output', true) })
  const reads: string[] = []
  const r = await check(fx, { hooks: { beforeFs: (op, path) => { if (op === 'read') reads.push(path) } } })
  assertBlocked(r, 2, 'protected files')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]).sort(), [
    ['protected-unverified', join(fx.wt, 'config/credentials.json')],
    ['protected-unverified', join(fx.wt, 'phi/intake.bin')],
    ['protected-unverified', join(fx.wt, 'private/x.bin')],
    ['protected-unverified', join(fx.wt, 'x/PHI/scan.dcm')],
  ])
  for (const p of [scan, priv, join(fx.wt, 'phi/intake.bin'), join(fx.wt, 'config/credentials.json')]) assert.ok(!reads.includes(p), `${p} was never read`)
  assert.ok(reads.includes(join(fx.wt, 'docs/guide.md')), 'ordinary documents are compared')
  for (const secret of ['tracked protected', 'tracked secret', 'untracked protected bytes', 'protected-root bytes']) assert.equal(JSON.stringify(r).includes(secret), false)

  // A staged-only protected version is never compared either, even with a same-size candidate outside the target.
  const staged = fixture()
  put(staged.wt, 'PHI/new.dcm', 'staged protected')
  git(staged.wt, ['add', 'PHI/new.dcm'])
  put(staged.main, 'PHI/new.dcm', 'staged protected')
  const rs = await check(staged)
  assertBlocked(rs, 2, 'staged protected version')
  assert.deepEqual(rs.unknowns.map(i => [i.code, i.path]), [['protected-unverified', join(staged.wt, 'PHI/new.dcm')]])

  // A copy under a protected path (here another worktree below a `PHI` directory) is never read, so it proves nothing.
  const fx2 = fixture()
  const other = join(fx2.base, 'PHI', 'other')
  git(fx2.main, ['worktree', 'add', '-q', '-b', 'other', other])
  put(fx2.wt, 'notes/plan.md', 'plan\n')
  put(other, 'notes/plan.md', 'plan\n')
  const reads2: string[] = []
  const r2 = await check(fx2, { hooks: { beforeFs: (op, path) => { if (op === 'read') reads2.push(path) } } })
  assertBlocked(r2, 3, 'copy only under a protected path')
  assert.deepEqual(r2.risks.map(i => [i.code, i.path]), [['unpreserved-untracked', join(fx2.wt, 'notes/plan.md')]])
  assert.ok(!reads2.some(p => p.startsWith(other)), 'nothing under the protected worktree was read')

  // Nor is a copy under a protected root registered in another checkout, which the target's own catalog context does not list.
  // Protection holds by the candidate's spelling and by its real path: a symlink into the protected root, and a symlink inside
  // it that leads elsewhere, are both protected.
  const fx3 = fixture()
  withCatalog(fx3, db => { registerRoot(db, join(fx3.main, 'private'), 'output', true) })
  put(fx3.wt, 'private/notes.md', 'notes\n')
  put(fx3.main, 'private/notes.md', 'notes\n')
  put(fx3.wt, 'links/plan.md', 'plan\n')
  put(fx3.main, 'private/plan.md', 'plan\n')
  symlinkSync(join(fx3.main, 'private'), join(fx3.main, 'links'))
  put(fx3.wt, 'private/out/data.md', 'data\n')
  put(fx3.main, 'public/data.md', 'data\n')
  symlinkSync(join(fx3.main, 'public'), join(fx3.main, 'private/out'))
  // The PHI rule applies to the real path too: `<main>/notes` leads into `<main>/PHI/notes`.
  put(fx3.wt, 'notes/intake.md', 'intake\n')
  put(fx3.main, 'PHI/notes/intake.md', 'intake\n')
  symlinkSync(join(fx3.main, 'PHI/notes'), join(fx3.main, 'notes'))
  const reads3: string[] = []
  const r3 = await check(fx3, { hooks: { beforeFs: (op, path) => { if (op === 'read') reads3.push(path) } } })
  assert.deepEqual(reads3.filter(p => p.startsWith(`${fx3.main}/`) && !p.startsWith(`${fx3.wt}/`)), [], 'no copy in the other checkout was read')
  assertBlocked(r3, 3, 'copies only under a protected root of another checkout')
  assert.deepEqual(r3.risks.map(i => [i.code, i.path]), [
    ['unpreserved-untracked', join(fx3.wt, 'links/plan.md')],
    ['unpreserved-untracked', join(fx3.wt, 'notes/intake.md')],
    ['unpreserved-untracked', join(fx3.wt, 'private/notes.md')],
    ['unpreserved-untracked', join(fx3.wt, 'private/out/data.md')],
  ])
})

// -------------------------------------------------------------------------------------------------- limits and faults

test('caps, permission errors, a spent budget and timeouts make coverage incomplete', async () => {
  const fx = fixture()
  put(fx.wt, 'reports/a.md', 'copy\n')
  put(fx.main, 'reports/a.md', 'copy\n')
  assertSafe(await check(fx), 'baseline')

  let r = await check(fx, { limits: { maxFileBytes: 4 } })
  assertBlocked(r, 2, 'per-file cap')
  assert.deepEqual(codes(r.unknowns), ['oversized'])

  r = await check(fx, { limits: { maxTotalBytes: 8 } })
  assertBlocked(r, 2, 'byte budget')
  assert.ok(codes(r.unknowns).includes('budget-exceeded'))

  r = await check(fx, { limits: { gitMaxOutputBytes: 16 } })
  assertBlocked(r, 2, 'Git output cap')
  assert.ok(codes(r.unknowns).includes('git-incomplete'))
  assert.equal(r.coverage.git, 'incomplete')

  r = await check(fx, { limits: { maxEntries: 3 } })
  assertBlocked(r, 2, 'walk cap')
  assert.ok(codes(r.unknowns).includes('walk-cap'))
  assert.equal(r.coverage.filesystem, 'incomplete')

  r = await check(fx, { hooks: { beforeFs: (op, path) => { if (op === 'readdir' && path === join(fx.wt, 'docs')) throw errno('EACCES') } } })
  assertBlocked(r, 2, 'unreadable directory')
  assert.ok(codes(r.unknowns).includes('permission-denied'))
  assert.equal(r.coverage.filesystem, 'incomplete')

  r = await check(fx, { hooks: { beforeFs: (op, path) => { if (op === 'read' && path === join(fx.wt, 'reports/a.md')) throw errno('EACCES') } } })
  assertBlocked(r, 2, 'unreadable file')
  assert.ok(codes(r.unknowns).includes('permission-denied'))

  let skew = 0
  let spawnedAtExpiry = -1
  r = await check(fx, { hooks: { now: () => Date.now() + skew, afterWalk: () => { skew = 3_600_000; spawnedAtExpiry = artifactGitSpawnCount() } } })
  assertBlocked(r, 2, 'wall-time budget')
  assert.ok(codes(r.unknowns).includes('timeout'))
  assert.equal(r.coverage.git, 'incomplete')
  assert.equal(artifactGitSpawnCount(), spawnedAtExpiry, 'no Git process starts once the budget is spent')

  r = await check(fx, { signal: AbortSignal.abort() })
  assertBlocked(r, 2, 'aborted')
  assert.ok(codes(r.unknowns).includes('aborted'))
})

test('a file that changes while it is compared, or before the final re-stat, invalidates the proof', async () => {
  const fx = fixture()
  const a = put(fx.wt, 'reports/a.md', 'same\n')
  put(fx.main, 'reports/a.md', 'same\n')
  assertSafe(await check(fx), 'baseline')

  let r = await check(fx, { hooks: { afterRead: path => { if (path === a) appendFileSync(a, 'more') } } })
  assertBlocked(r, 2, 'changed during the read')
  assert.match(r.unknowns.find(i => i.code === 'race-detected' && i.path === a)?.detail ?? '', /while it was being compared/, 'the unstable read itself is discarded')
  writeFileSync(a, 'same\n')

  r = await check(fx, { hooks: { beforeFinalCheck: () => writeFileSync(a, 'diff\n') } })
  assertBlocked(r, 2, 'changed before the final re-stat')
  assert.ok(codes(r.unknowns).includes('race-detected'))
  writeFileSync(a, 'same\n')

  // The outside copy used as proof is re-stat'ed too.
  const copy = join(fx.main, 'reports/a.md')
  r = await check(fx, { hooks: { beforeFinalCheck: () => writeFileSync(copy, 'diff\n') } })
  assertBlocked(r, 2, 'copy changed before the final re-stat')
  assert.deepEqual(pathsOf(r.unknowns, 'race-detected'), [copy])
  writeFileSync(copy, 'same\n')

  r = await check(fx, { hooks: { beforeFinalCheck: () => { put(fx.wt, 'src/late.ts', 'late') } } })
  assertBlocked(r, 2, 'new entry before the final re-stat')
  assert.ok(codes(r.unknowns).includes('race-detected'))
  unlinkSync(join(fx.wt, 'src/late.ts'))

  r = await check(fx, { hooks: { beforeFinalCheck: () => { git(fx.main, ['branch', 'late-branch']) } } })
  assertBlocked(r, 2, 'refs changed before the final check')
  assert.ok(codes(r.unknowns).includes('race-detected'))

  r = await check(fx, { hooks: { beforeFinalCheck: () => { git(fx.main, ['checkout', '-q', '--detach']) } } })
  assertBlocked(r, 2, 'another worktree\'s HEAD moved before the final check')
  assert.ok(codes(r.unknowns).includes('race-detected'))
  git(fx.main, ['checkout', '-q', 'main'])

  r = await check(fx, { hooks: { beforeFinalCheck: () => { git(fx.wt, ['add', 'reports/a.md']) } } })
  assertBlocked(r, 2, 'index changed before the final check')
  assert.ok(codes(r.unknowns).includes('race-detected'))
  git(fx.wt, ['reset', '-q', '--', 'reports/a.md'])

  r = await check(fx, { hooks: { afterWalk: () => { put(fx.wt, 'late.md', 'appeared after the walk') } } })
  assertBlocked(r, 2, 'file appeared between the walk and Git')
  assert.ok(pathsOf(r.unknowns, 'race-detected').includes(join(fx.wt, 'late.md')), 'the file Git listed but the walk did not see is named')
  unlinkSync(join(fx.wt, 'late.md'))

  // The walk saw a file Git does not account for: the two inventories must agree.
  const gone = put(fx.wt, 'gone.bin', 'x')
  r = await check(fx, { hooks: { afterWalk: () => unlinkSync(gone) } })
  assertBlocked(r, 2, 'file vanished between the walk and Git')
  assert.deepEqual(pathsOf(r.unknowns, 'inventory-mismatch'), [gone])
})

// ----------------------------------------------------------------------------------------------------------- catalog

test('a missing catalog is not an empty catalog and is never created; a broken one is an error', async () => {
  const fx = fixture()
  const missing = join(fx.base, 'nowhere', 'atlas.db')
  let r = await check(fx, { catalogPath: missing })
  assertBlocked(r, 2, 'missing catalog')
  assert.equal(r.coverage.catalog, 'missing')
  assert.deepEqual(codes(r.unknowns), ['catalog-missing'])
  assert.equal(existsSync(dirname(missing)), false, 'nothing was created')

  r = await check(fx, { catalogPath: null })
  assert.equal(r.coverage.catalog, 'missing')
  assert.equal(r.exitCode, 2)

  // Risks win over unknowns (R43), and both are listed.
  put(fx.wt, 'notes.md', 'unique')
  r = await check(fx, { catalogPath: missing })
  assert.equal(r.exitCode, 3)
  assert.deepEqual(codes(r.risks), ['unpreserved-untracked'])
  assert.deepEqual(codes(r.unknowns), ['catalog-missing'])
  unlinkSync(join(fx.wt, 'notes.md'))

  // Default location: the temporary HOME has no Atlas directory, which stays absent.
  r = await check(fx, { catalogPath: undefined })
  assert.equal(r.coverage.catalog, 'missing')
  assert.equal(existsSync(join(FIXTURE_HOME, '.claude')), false)

  const garbage = put(fx.base, 'garbage.db', 'not a database')
  const empty = join(fx.base, 'empty.db')
  openDatabase(empty, { migrate: false }).close()
  for (const path of [garbage, empty, join(fx.base, 'atlas'), 'relative.db']) {
    r = await check(fx, { catalogPath: path })
    assertBlocked(r, 2, `broken catalog ${path}`)
    assert.equal(r.coverage.catalog, 'error')
    assert.deepEqual(codes(r.unknowns), ['catalog-error'])
  }
})

test('a copy read twice (staged and working version) must not change between the reads', async () => {
  const fx = fixture()
  put(fx.wt, 'new.md', 'AAAA\n')
  git(fx.wt, ['add', 'new.md'])
  put(fx.wt, 'new.md', 'BBBB\n')
  const copy = put(fx.main, 'new.md', 'AAAA\n')
  let copyReads = 0
  const r = await check(fx, {
    hooks: { beforeFs: (op, path) => { if (op === 'read' && path === copy && ++copyReads === 2) writeFileSync(copy, 'BBBB\n') } },
  })
  assert.equal(copyReads, 2, 'the staged and the working version each read the copy once')
  assertBlocked(r, 2, 'copy replaced between its two reads')
  assert.deepEqual(pathsOf(r.unknowns, 'race-detected'), [copy])
  // What a fresh check makes of the new state.
  assert.deepEqual(codes((await check(fx)).risks), ['staged-unpreserved'])
})

test('a large catalog does not slow a check: protection of a copy is looked up per candidate, by index', async () => {
  const fx = fixture()
  put(fx.wt, 'notes/keep.md', 'kept\n')
  put(fx.main, 'notes/keep.md', 'kept\n')
  // 200,000 unrelated locations in the main checkout. Fast to build in this throwaway catalog: its full-text triggers and
  // secondary indexes are dropped first (the checker's lookups use only the UNIQUE path and canonical_path indexes).
  withCatalog(fx, db => {
    for (const { type, name } of db.raw.prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name = 'artifacts' AND (type = 'trigger' OR (type = 'index' AND sql IS NOT NULL))`).all() as Array<{ type: string; name: string }>) {
      db.raw.exec(`DROP ${type.toUpperCase()} ${name}`)
    }
    db.raw.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199999)
      INSERT INTO artifacts (path, filename, created_at) SELECT ? || '/n' || i || '.md', 'n' || i || '.md', ? FROM n`).run(join(fx.main, 'notes'), NOW)
  })
  let maxGap = 0
  let last = Date.now()
  const ticker = setInterval(() => { const at = Date.now(); maxGap = Math.max(maxGap, at - last); last = at }, 5)
  const t0 = Date.now()
  const r = await check(fx).finally(() => clearInterval(ticker))
  const elapsed = Date.now() - t0
  assertSafe(r, 'the identical copy outside the target still proves the untracked document')
  assert.ok(maxGap <= 300, `the event loop was blocked for ${maxGap} ms`)
  assert.ok(elapsed <= 1500, `a clean check took ${elapsed} ms`)
})

test('a catalog that cannot be read again for other checkouts leaves their copies unusable', async () => {
  const fx = fixture()
  put(fx.wt, 'reports/q.md', 'quarterly\n')
  const copy = put(fx.main, 'reports/q.md', 'quarterly\n')
  const reads: string[] = []
  const r = await check(fx, {
    hooks: {
      afterResolve: () => renameSync(fx.catalog, `${fx.catalog}.gone`),
      beforeFs: (op, path) => { if (op === 'read') reads.push(path) },
    },
  })
  assert.ok(!reads.includes(copy), 'the copy was not read without knowing whether it is protected')
  assert.equal(r.coverage.catalog, 'error')
  assert.deepEqual(codes(r.unknowns), ['catalog-error'])
  assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['unpreserved-untracked', join(fx.wt, 'reports/q.md')]])
})

test('catalog roots under the target with incomplete coverage block; roots that only contain the target do not', async () => {
  const fx = fixture()
  let rootId = ''
  withCatalog(fx, db => {
    rootId = registerRoot(db, fx.wt, 'session-directory')
    db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'partial' WHERE root_id = ?`).run(rootId)
  })
  let r = await check(fx)
  assertBlocked(r, 2, 'partial root')
  assert.deepEqual(codes(r.unknowns), ['catalog-root-incomplete'])

  withCatalog(fx, db => { db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'idle', desired_generation = 3, applied_generation = 2 WHERE root_id = ?`).run(rootId) })
  r = await check(fx)
  assertBlocked(r, 2, 'pending generation')
  assert.deepEqual(codes(r.unknowns), ['catalog-root-incomplete'])

  withCatalog(fx, db => {
    db.raw.prepare(`UPDATE artifact_roots SET applied_generation = 3 WHERE root_id = ?`).run(rootId)
    const outer = registerRoot(db, fx.main, 'session-directory')
    db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'failed' WHERE root_id = ?`).run(outer)
  })
  assertSafe(await check(fx), 'complete root at the target, failed root above it')
})

test('R67: a root under the target whose only gap is the informational lookback-limited one does not block; any other gap does', async () => {
  const fx = fixture()
  let rootId = ''
  const setNote = (value: object | null): void => withCatalog(fx, db => {
    db.raw.prepare('DELETE FROM artifact_manager_state WHERE key = ?').run(`coverage-reason:${rootId}`)
    if (value) db.raw.prepare('INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)').run(`coverage-reason:${rootId}`, JSON.stringify(value), NOW)
  })
  withCatalog(fx, db => {
    rootId = registerRoot(db, join(fx.wt, 'docs'), 'output')
    db.raw.prepare(`UPDATE artifact_roots SET coverage_state = 'partial', desired_generation = 1, applied_generation = 1 WHERE root_id = ?`).run(rootId)
  })
  // The root's last completed pass left out only files older than the lookback: the checker walks the filesystem itself.
  setNote({ task: 'output-walk', codes: ['lookback-limited'], complete: true, at: NOW })
  assertSafe(await check(fx), 'a lookback-only gap is informational for removal')
  // Anything else stays an unfinished root.
  for (const [label, note] of [
    ['another gap too', { task: 'output-walk', codes: ['permission-denied', 'lookback-limited'], complete: true, at: NOW }],
    ['a pass not complete', { task: 'output-walk', codes: ['lookback-limited'], complete: false, at: NOW }],
    ['no reason recorded', null],
    ['an unreadable note', { codes: 'lookback-limited' }],
  ] as const) {
    setNote(note)
    const r = await check(fx)
    assertBlocked(r, 2, label)
    assert.deepEqual(codes(r.unknowns), ['catalog-root-incomplete'], label)
  }
  setNote({ task: 'output-walk', codes: ['lookback-limited'], complete: true, at: NOW })
  withCatalog(fx, db => { db.raw.prepare('UPDATE artifact_roots SET desired_generation = 2 WHERE root_id = ?').run(rootId) })
  assertBlocked(await check(fx), 2, 'a newer generation pending')
})

// R71 (Wave 2a): the coverage note has one key and one JSON shape (src/db/artifact-manager.ts). The runner writes it from a
// real pass; the status route explains the root with it and the removal checker reads it from its own read-only handle.
test('R71: the coverage note the runner writes is the one the status route shows and the removal checker reads', async () => {
  const fx = fixture()
  const home = realpathSync(tempDir('atlas-rc-r71-'))
  const config = loadConfig({ HOME: home })
  const db = openDatabase(fx.catalog)
  const docs = join(fx.wt, 'docs')
  const rootId = registerRoot(db, docs, 'output')
  // The root's first walk completes and reports only that files older than the lookback were left out (R67).
  const events: ArtifactWorkerEvent[] = []
  const worker = {
    start(req: { jobId: string }) {
      events.push({ type: 'frame', frame: { type: 'batch', jobId: req.jobId, rows: [], cursor: null, complete: true, coverage: 'partial', counts: { visited: 1, eligible: 0, skipped: 1 }, error: { code: 'lookback-limited', message: 'coverage gaps: lookback-limited' } } })
    },
    poll: () => events.shift() ?? null,
    async wait() {},
    ack() {},
    restart() { events.length = 0 },
    stop() {},
    status: () => ({ running: true, pid: null, activeJobId: null, priorityFacility: 'applied', priorityCommand: 'test', liveGroups: [], spawns: 0, crashes: 0, gitChildrenSeen: 0 }),
  }
  enqueueArtifactJob(db, { scopeId: rootId, taskKind: 'output-walk', priority: ARTIFACT_JOB_PRIORITY.dirty, generation: 0 }, NOW)
  const runner = artifactManagerRunner({ db, config, log: silentLogger, worker, home, clock: () => Date.parse(NOW) + 1_000, autoSchedule: false, frameWaitMs: 0 })
  const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, home, config, now: () => NOW }))
  try {
    await runner.run()
    await runner.run()
    const stored = readArtifactCoverageNote(db, rootId, 'output-walk')
    assert.deepEqual(stored && { task: stored.task, codes: stored.codes, complete: stored.complete, info: stored.info }, { task: 'output-walk', codes: ['lookback-limited'], complete: true, info: null })
    const status = await (await fetch(`${srv.base}/api/artifact-manager/status`)).json() as { roots: Array<{ rootId: string; state: string; gaps: string[]; reason: string | null }> }
    const root = status.roots.find(r => r.rootId === rootId)!
    assert.deepEqual([root.state, root.gaps], ['partial', ['lookback-limited']], 'the status route reads the note')
    assert.match(root.reason ?? '', /Import older files/)
    assertSafe(await check(fx), 'the checker reads the same note: a lookback-only gap is informational for removal')
  } finally {
    runner.stop?.()
    await srv.close()
    db.close()
  }
})

// -------------------------------------------------------------------------------------------------------- filters, LFS

test('a configured filter driver does not blanket-fail clean documents (R42); LFS pointers are never proof', async () => {
  const fx = fixture({
    beforeWorktree: main => {
      git(main, ['config', 'filter.noop.clean', 'cat'])
      git(main, ['config', 'filter.noop.smudge', 'cat'])
      put(main, '.gitattributes', '*.md filter=noop\n')
    },
  })
  assertSafe(await check(fx), 'clean documents under an unresolved filter, proven by bytes')
  put(fx.wt, 'docs/guide.md', 'edited under a filter\n')
  let r = await check(fx)
  assertBlocked(r, 2, 'edit under an unresolved filter')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['filter-unverified', join(fx.wt, 'docs/guide.md')]])

  const lfs = fixture({ files: { ...DEFAULT_FILES, 'media/big.md': LFS_POINTER } })
  r = await check(lfs)
  assertBlocked(r, 2, 'pointer in the working tree')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['lfs-unverified', join(lfs.wt, 'media/big.md')]])
  put(lfs.wt, 'media/big.md', 'the real large document\n')
  r = await check(lfs)
  assertBlocked(r, 2, 'pointer committed, real bytes in the working tree')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['lfs-unverified', join(lfs.wt, 'media/big.md')]])

  // An untracked pointer is never the document, even with an identical copy outside the target.
  const loose = fixture()
  put(loose.wt, 'media/loose.md', LFS_POINTER)
  put(loose.main, 'media/loose.md', LFS_POINTER)
  r = await check(loose)
  assertBlocked(r, 2, 'untracked pointer')
  assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['lfs-unverified', join(loose.wt, 'media/loose.md')]])
})

test('DEFECT-6: a filter driver configured for the user but named by no attribute changes nothing: clean is safe, an edit is a risk', async () => {
  // git-lfs installed for the user (the global gitconfig the checker's Git configuration view reads); the repository never
  // applies it. The helpers leave markers if they ever run.
  const scratch = realpathSync(tempDir('atlas-rc-lfs-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  const helper = (label: string, tail: string): string => {
    const p = join(scratch, `${label}.sh`)
    writeFileSync(p, `#!/bin/sh\ntouch '${join(markers, label)}'\n${tail}\n`, { mode: 0o755 })
    return p
  }
  const userConfig = join(scratch, 'gitconfig')
  writeFileSync(userConfig, `[filter "lfs"]\n\tclean = ${helper('clean', 'exec cat')}\n\tsmudge = ${helper('smudge', 'exec cat')}\n\tprocess = ${helper('process', 'exit 1')}\n\trequired = true\n`)
  const fx = fixture()
  process.env.GIT_CONFIG_GLOBAL = userConfig
  try {
    assertSafe(await check(fx), 'a clean worktree with an unreferenced filter driver')
    put(fx.wt, 'docs/guide.md', 'edited, with git-lfs merely configured\n')
    let r = await check(fx)
    assertBlocked(r, 3, 'an edit with an unreferenced filter driver')
    assert.deepEqual(r.risks.map(i => [i.code, i.path]), [['unpreserved-working', join(fx.wt, 'docs/guide.md')]])
    assert.deepEqual(codes(r.unknowns), [], 'no filter-unverified unknown for a path no filter applies to')
    // Once an attribute names the driver for that path, the byte difference is unverifiable again (R42 unchanged).
    put(fx.wt, '.gitattributes', '*.md filter=lfs\n')
    r = await check(fx)
    assertBlocked(r, 2, 'an edit under an applying filter')
    assert.deepEqual(r.unknowns.map(i => [i.code, i.path]), [['filter-unverified', join(fx.wt, 'docs/guide.md')]])
    // An attribute source Git cannot read leaves the question open: unknown, never a clean bill.
    rmSync(join(fx.wt, '.gitattributes'))
    symlinkSync(join(scratch, 'gitconfig'), join(fx.wt, 'docs', '.gitattributes'))
    r = await check(fx)
    assertBlocked(r, 2, 'an unreadable attribute source')
    assert.ok(r.unknowns.some(i => i.code === 'filter-unverified' && i.path === join(fx.wt, 'docs/guide.md')), JSON.stringify(r.unknowns))
  } finally {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  }
  assert.deepEqual(readdirSync(markers), [], 'no filter helper executed')
})

// -------------------------------------------------------------------------------------------------- paths and writes

test('a file name that is not lossless UTF-8 leaves coverage incomplete', async t => {
  const fx = fixture()
  mkdirSync(join(fx.wt, 'notes'))
  const name = Buffer.concat([Buffer.from(fx.wt + '/notes/'), Buffer.from([0x6e, 0x6f, 0x74, 0x65, 0xff, 0x2e, 0x6d, 0x64])])
  try {
    writeFileSync(name, 'x')
  } catch {
    t.skip('filesystem rejects invalid UTF-8 names')
    return
  }
  const r = await check(fx)
  assertBlocked(r, 2, 'lossy name')
  assert.deepEqual(pathsOf(r.unknowns, 'lossy-path'), [fx.wt, join(fx.wt, 'notes')], 'both the walk (its directory) and Git (the target) report it')
})

test('a Git command that fails is never read as an empty answer', async () => {
  const fx = fixture()
  put(fx.wt, 'notes.md', 'unique')
  const gitDir = gitText(fx.wt, ['rev-parse', '--absolute-git-dir'])
  writeFileSync(join(gitDir, 'index'), 'corrupt index')
  const r = await check(fx)
  assertBlocked(r, 2, 'corrupt index')
  assert.ok(codes(r.unknowns).includes('git-incomplete'))
  assert.equal(r.coverage.git, 'incomplete')
  // Each failed step is reported as a failure of that step, not only through the inconsistencies it causes downstream.
  const failedSteps = r.unknowns.filter(i => i.code === 'git-incomplete' && i.path === null).map(i => i.detail)
  for (const step of ['the index', 'the untracked-file list', 'the ignored-file list', 'the status']) {
    assert.ok(failedSteps.some(d => d.includes(`did not answer ${step} completely`)), `${step}: ${JSON.stringify(failedSteps)}`)
  }
  assert.equal(JSON.stringify(r).includes('fatal'), false, 'Git stderr is never forwarded')
})

test('the target\'s HEAD is bound across the whole check: a move after resolution or before the end is a race', async () => {
  // A commit lands in the detached target after it was resolved and before Git state is first recorded (CRITICAL 1).
  const fx = fixture({ detach: true })
  let fired = false
  const r = await check(fx, {
    hooks: {
      afterResolve: () => {
        fired = true
        put(fx.wt, 'src/feature.ts', 'export const feature = 1\n')
        commitAll(fx.wt, 'lands between resolution and the first record of Git state')
      },
    },
  })
  assert.ok(fired, 'the seam fired')
  assertBlocked(r, 2, 'HEAD moved after resolution')
  assert.ok(r.unknowns.some(i => i.code === 'race-detected' && i.path === null && /moved after the worktree was resolved/.test(i.detail)), JSON.stringify(r.unknowns))
  // A fresh check sees what the moved HEAD means.
  assert.deepEqual(codes((await check(fx)).risks), ['unretained-commit'])

  // The branch is bound too: switching to another branch at the same commit is concurrent activity.
  const branch = fixture()
  const rb = await check(branch, { hooks: { afterResolve: () => { git(branch.wt, ['checkout', '-q', '-b', 'other']) } } })
  assertBlocked(rb, 2, 'branch switched after resolution')
  assert.ok(rb.unknowns.some(i => i.code === 'race-detected' && /moved after the worktree was resolved/.test(i.detail)), JSON.stringify(rb.unknowns))
  assertSafe(await check(branch), 'a fresh check on the new branch')

  // The target's own HEAD moving at the very end (no file, branch or tag changes) is a race too.
  const late = fixture({ detach: true })
  const r2 = await check(late, { hooks: { beforeFinalCheck: () => { git(late.wt, ['commit', '-q', '--allow-empty', '-m', 'late']) } } })
  assertBlocked(r2, 2, 'HEAD moved before the final check')
  assert.ok(pathsOf(r2.unknowns, 'race-detected').includes(null))
})

test('a copy whose path resolves into the target while it is read is not preservation', async () => {
  const fx = fixture()
  put(fx.wt, 'out/r.md', 'only here\n')
  put(fx.main, 'out/r.md', 'only here\n')
  const candidate = join(fx.main, 'out/r.md')
  let swapped = false
  const r = await check(fx, {
    hooks: {
      beforeFs: (op, path) => {
        if (op !== 'read' || path !== candidate || swapped) return
        swapped = true
        renameSync(join(fx.main, 'out'), join(fx.main, 'out-moved'))
        symlinkSync(join(fx.wt, 'out'), join(fx.main, 'out'))
      },
    },
  })
  assert.ok(swapped)
  assertBlocked(r, 2, 'copy resolution changed during the read')
  assert.ok(pathsOf(r.unknowns, 'race-detected').includes(candidate), JSON.stringify(r.unknowns))
})

test('the time budget and an abort stop the comparison phase promptly', async () => {
  // Enough files that the comparison phase is long when each comparison is slow (a test-only delay after each read).
  const files: Record<string, string> = { ...DEFAULT_FILES }
  for (let i = 0; i < 240; i++) files[`data/${i % 12}/f${i}.json`] = `{"i":${i}}\n`
  const fx = fixture({ files })
  const compared = 2 + 240
  const slow = (): Promise<void> => new Promise(resume => setTimeout(resume, 30))

  // The deadline passes (clock seam) after the 16th comparison: the check stops inside the comparison phase.
  let skew = 0
  let reads = 0
  let expiredAt = 0
  const r = await check(fx, {
    timeoutMs: 2000,
    hooks: {
      now: () => Date.now() + skew,
      afterRead: async () => {
        if (++reads === 16) { skew = 3_600_000; expiredAt = Date.now() }
        await slow()
      },
    },
  })
  const late = Date.now() - expiredAt
  assertBlocked(r, 2, 'budget spent while comparing')
  assert.ok(codes(r.unknowns).includes('timeout'), JSON.stringify(r.unknowns))
  assert.ok(reads >= 16 && reads < compared / 2, `stopped inside the comparison phase after ${reads} of ${compared} reads`)
  assert.ok(late <= 400, `returned ${late} ms after the deadline`)

  // An abort inside the comparison phase is honoured just as promptly.
  const ac = new AbortController()
  let reads2 = 0
  let abortedAt = 0
  const a = await check(fx, {
    signal: ac.signal,
    hooks: { afterRead: async () => { if (++reads2 === 16) { ac.abort(); abortedAt = Date.now() } await slow() } },
  })
  assertBlocked(a, 2, 'aborted while comparing')
  assert.ok(codes(a.unknowns).includes('aborted'))
  assert.ok(Date.now() - abortedAt <= 400, `returned ${Date.now() - abortedAt} ms after the abort`)

  assertSafe(await check(fx), 'the default budget still completes')
})

test('the deadline stops the size pre-pass of the comparison phase', async () => {
  const files: Record<string, string> = { ...DEFAULT_FILES }
  for (let i = 0; i < 60; i++) files[`data/f${i}.json`] = `{"i":${i}}\n`
  const fx = fixture({ files })
  let skew = 0
  let stats = 0
  let reads = 0
  const r = await check(fx, {
    hooks: {
      now: () => Date.now() + skew,
      beforeFs: op => {
        if (op === 'stat' && ++stats === 1) skew = 3_600_000
        if (op === 'read') reads++
      },
    },
  })
  assertBlocked(r, 2, 'budget spent in the pre-pass')
  assert.ok(codes(r.unknowns).includes('timeout'))
  assert.ok(stats >= 1 && stats <= 8, `${stats} of 62 sizes were looked up after the deadline (at most one per lane)`)
  assert.equal(reads, 0, 'no file was read')
})

test('bad arguments and failing seams give an exit-2 result, never an exception', async () => {
  const fx = fixture()
  const direct = async (target: unknown, options?: unknown): Promise<RemovalCheckResult> => {
    const r = await checkWorktreeRemoval(target as string, options as RemovalCheckOptions)
    assertCoverageInvariant(r)
    return r
  }
  let r = await direct(fx.wt, null)
  assertBlocked(r, 2, 'null options')
  r = await direct(42, { catalogPath: fx.catalog, probeSessionActivity: INACTIVE })
  assertBlocked(r, 2, 'numeric target')
  assert.deepEqual(codes(r.unknowns), ['invalid-target'])
  r = await direct(null)
  assertBlocked(r, 2, 'null target')
  for (const [label, target] of [['null prototype', Object.create(null)], ['throwing toString', { toString: () => { throw new Error('boom') } }]] as const) {
    r = await direct(target, { catalogPath: fx.catalog, probeSessionActivity: INACTIVE })
    assertBlocked(r, 2, label)
    assert.deepEqual(codes(r.unknowns), ['invalid-target'], label)
  }
  r = await direct(fx.wt, { catalogPath: fx.catalog, probeSessionActivity: INACTIVE, callerCwd: fx.base, hooks: { now: () => { throw new Error('clock') } } })
  assertBlocked(r, 2, 'throwing clock')
  assert.ok(codes(r.unknowns).includes('internal-error'))
  r = await direct(fx.wt, { catalogPath: fx.catalog, probeSessionActivity: INACTIVE, callerCwd: fx.base, limits: 7, hooks: 'x', sensitivePatterns: 'y', documentExtensions: 'z' })
  assertSafe(r, 'malformed optional fields fall back to defaults')
})

test('the checker writes nothing: not in the target, the repository or the catalog', async () => {
  const fx = fixture()
  put(fx.wt, 'notes.md', 'untracked')
  put(fx.wt, 'docs/guide.md', 'edited\n')
  put(fx.wt, '.gitignore', 'out/\n')
  put(fx.wt, 'out/report.md', 'ignored')
  put(fx.main, 'notes.md', 'untracked')
  const before = snapshotTree(fx.base, [join(fx.base, 'atlas')])
  const catalogBytes = readFileSync(fx.catalog)
  const r = await check(fx)
  assert.equal(r.exitCode, 3)
  assert.deepEqual(snapshotTree(fx.base, [join(fx.base, 'atlas')]), before)
  assert.ok(readFileSync(fx.catalog).equals(catalogBytes), 'catalog bytes unchanged')
})

test('coverage invariant held for every result of the matrix above', () => {
  assert.ok(RESULTS.length >= 100, `${RESULTS.length} results recorded`)
  const exits = new Set(RESULTS.map(r => r.exitCode))
  assert.deepEqual([...exits].sort(), [0, 2, 3])
  const seen = new Set(RESULTS.flatMap(r => r.unknowns.map(i => i.code)))
  for (const code of ['protected-unverified', 'oversized', 'lfs-unverified', 'filter-unverified', 'representation-unverified', 'catalog-root-incomplete']) {
    assert.ok(seen.has(code), `the matrix exercises ${code}`)
  }
  for (const r of RESULTS) {
    const complete = r.coverage.filesystem === 'complete' && r.coverage.git === 'complete' && r.coverage.catalog === 'complete' && r.coverage.sessions === 'inactive'
    assert.equal(r.exitCode === 0, complete && r.risks.length === 0 && r.unknowns.length === 0)
    if (r.exitCode === 2) assert.equal(complete, false)
  }
})
