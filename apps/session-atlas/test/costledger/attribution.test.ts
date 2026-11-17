import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createResolver, attributionQuality } from '../../src/costledger/attribution.ts'
import { tempDir } from '../helpers/tmp.ts'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
}
function makeRepo(): { repo: string; real: string } {
  const repo = join(tempDir('attr-'), 'myrepo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'f.txt'), 'x')
  git(repo, 'add', 'f.txt')
  git(repo, 'commit', '-q', '-m', 'init')
  return { repo, real: realpathSync(repo) }
}

test('repo root and a subdirectory resolve to the same key', () => {
  const { repo, real } = makeRepo()
  mkdirSync(join(repo, 'src'))
  const r = createResolver()
  const a = r.resolve(repo)
  const b = r.resolve(join(repo, 'src'))
  assert.equal(a.repoKey, real)
  assert.equal(b.repoKey, real)
  assert.equal(a.displayName, 'myrepo')
  assert.equal(a.rootPath, real)
  assert.equal(a.worktreePath, real)
  assert.equal(b.worktreePath, real)
  assert.equal(a.resolution, 'live')
})

test('a git worktree maps to the repo of its main checkout but keeps its own worktree path', () => {
  const { repo, real } = makeRepo()
  const wt = join(tempDir('attr-wt-'), 'wt1')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/w', wt)
  const a = createResolver().resolve(wt)
  assert.equal(a.repoKey, real)
  assert.equal(a.worktreePath, realpathSync(wt))
  assert.equal(a.resolution, 'live')
  const bare = join(tempDir('attr-bare-'), 'bare.git')
  git(repo, 'clone', '-q', '--bare', repo, bare)
  const bwt = join(tempDir('attr-bwt-'), 'wt2')
  git(bare, 'worktree', 'add', '-q', '-b', 'feat/b', bwt)
  const b = createResolver().resolve(bwt)
  assert.equal(b.repoKey, realpathSync(bare))
  assert.equal(b.worktreePath, realpathSync(bwt))
  const under = join(repo, '.claude', 'worktrees', 'live1')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/l', under)
  const l = createResolver().resolve(under)
  assert.equal(l.resolution, 'live')
  assert.equal(l.worktreePath, realpathSync(under))
  const saved = process.env.GIT_DIR
  process.env.GIT_DIR = join(bare, 'nope')
  try {
    assert.equal(createResolver().resolve(wt).repoKey, real)
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = saved
  }
})

test('a directory that is not in any repo is the explicit none bucket', () => {
  const dir = tempDir('attr-plain-')
  assert.deepEqual(createResolver().resolve(dir), { repoKey: null, displayName: null, rootPath: null, worktreePath: null, resolution: 'none' })
})

test('null and empty cwd are the none bucket', () => {
  const r = createResolver()
  assert.equal(r.resolve(null).resolution, 'none')
  assert.equal(r.resolve('').resolution, 'none')
})

test('deleted .claude/worktrees directory falls back to the repo path (existing repo is realpathed)', () => {
  const { repo, real } = makeRepo()
  const gone = join(repo, '.claude', 'worktrees', 'old-feature')
  const a = createResolver().resolve(gone)
  assert.equal(a.resolution, 'fallback')
  assert.equal(a.repoKey, real)
  assert.equal(a.worktreePath, gone)
  const pruned = join(repo, '.claude', 'worktrees', 'pruned')
  mkdirSync(pruned, { recursive: true })
  writeFileSync(join(pruned, '.git'), 'gitdir: /no/such/admin\n')
  const p = createResolver().resolve(pruned)
  assert.equal(p.resolution, 'fallback')
  assert.equal(p.repoKey, real)
  assert.equal(p.worktreePath, pruned)
})

test('deleted <repo>-worktrees/<n> directory falls back; a missing repo keeps the raw path', () => {
  const a = createResolver().resolve('/no/such/place/pims_services-worktrees/pims-september')
  assert.equal(a.resolution, 'fallback')
  assert.equal(a.repoKey, '/no/such/place/pims_services')
  assert.equal(a.displayName, 'pims_services')
  assert.equal(createResolver().resolve('/no/p/.claude/worktrees/w/sub-worktrees/y').repoKey, '/no/p')
})

test('a missing directory matching no pattern is the none bucket', () => {
  assert.equal(createResolver().resolve('/no/such/dir').resolution, 'none')
})

test('git runs once per distinct cwd (cache): second call returns the identical object', () => {
  const { repo } = makeRepo()
  const r = createResolver()
  assert.equal(r.resolve(repo), r.resolve(repo))
})

test('attributionQuality: exact, derived, unknown', () => {
  const live = { repoKey: '/r', displayName: 'r', rootPath: '/r', worktreePath: '/r', resolution: 'live' } as const
  const fb = { ...live, resolution: 'fallback' } as const
  const none = { repoKey: null, displayName: null, rootPath: null, worktreePath: null, resolution: 'none' } as const
  assert.equal(attributionQuality(live, 'main'), 'exact')
  assert.equal(attributionQuality(live, null), 'derived')
  assert.equal(attributionQuality(fb, 'main'), 'derived')
  assert.equal(attributionQuality(none, 'main'), 'unknown')
})
