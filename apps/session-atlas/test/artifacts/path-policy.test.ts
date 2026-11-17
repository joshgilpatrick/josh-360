import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { loadConfig, type ArtifactsConfig } from '../../src/config.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { recordArtifactEvidence, registerArtifactRepository, registerArtifactRoot, type ArtifactRootRow } from '../../src/db/artifact-manager.ts'
import type { ArtifactDocumentIdentity, ArtifactWorkerRoot } from '../../src/artifacts/contracts.ts'
import { isIgnoredPath } from '../../src/artifacts/candidates.ts'
import {
  authorizeArtifactPath, canonicalizeArtifactRoot, documentIdentityForGitPath, documentIdentityForPath, hasPhiSegment, isPassiveDiscoveryExcluded,
  isPhiSegment,
} from '../../src/artifacts/path-policy.ts'

// Every fixture lives under a fresh temporary "home" passed explicitly as `home`; nothing here reads or writes the real home.
// Paths are compared through realpath so the suite also holds where the temp directory is itself reached through a symlink
// (macOS /var -> /private/var).

const NOW = '2026-10-27T12:00:00.000Z'

function freshHome(): string {
  return realpathSync(tempDir('atlas-pp-home-'))
}

function outsideDir(): string {
  return realpathSync(tempDir('atlas-pp-outside-'))
}

function mk(path: string, content = 'x'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function root(rootId: string, canonicalPath: string, over: Partial<ArtifactWorkerRoot> = {}): ArtifactWorkerRoot {
  return { rootId, kind: 'output', canonicalPath, repositoryId: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'], ...over }
}

/** Registers an existing directory as a root through the policy, the way the service will. */
function canonRoot(path: string, home: string): string {
  const r = canonicalizeArtifactRoot(path, home)
  assert.ok('canonicalPath' in r, `expected ${path} to canonicalize, got ${JSON.stringify(r)}`)
  assert.equal(r.exists, true)
  return r.canonicalPath
}

function artifactsConfig(home: string, override?: Partial<ArtifactsConfig>): ArtifactsConfig {
  return { ...loadConfig({ HOME: home }, join(home, 'no-such-config.json')).artifacts, ...override }
}

function identity(r: ReturnType<typeof documentIdentityForPath>): ArtifactDocumentIdentity {
  assert.ok(!('incomplete' in r), `expected an identity, got refusal ${JSON.stringify(r)}`)
  return r
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })
}

/** A real repository with a linked worktree under .claude/worktrees, the layout Claude Code creates. */
function repoWithWorktree(home: string): { main: string; wt: string; commonDir: string } {
  const main = join(home, 'proj')
  mkdirSync(main)
  git(main, 'init', '-q')
  mk(join(main, 'docs', 'plan.md'), 'plan')
  mk(join(main, '.gitignore'), 'exports/\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
  const wt = join(main, '.claude', 'worktrees', 'feat')
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt)
  const commonDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()
  assert.equal(commonDir, git(main, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'linked worktree shares the common dir')
  return { main, wt, commonDir: realpathSync(commonDir) }
}

function workerRoot(row: ArtifactRootRow): ArtifactWorkerRoot {
  return { rootId: row.rootId, kind: row.kind, canonicalPath: row.canonicalPath, repositoryId: row.repositoryId, checkoutIdentity: row.checkoutIdentity, protected: row.protected, scopeFlags: row.scopeFlags }
}

function evidence(db: AtlasDb, sourceKey: string, rootId: string, path: string, id: ArtifactDocumentIdentity) {
  return recordArtifactEvidence(db, { rootId, path, identity: id, sourceKey, source: 'hook', sessionId: null, operation: 'touched', certainty: 'recorded', eventAt: NOW }, NOW)
}

// ------------------------------------------------------------------------------------------------ root canonicalization

test('canonicalizeArtifactRoot rejects roots outside home, home itself, its ancestors and malformed spellings', () => {
  const home = freshHome()
  const outside = outsideDir()
  for (const p of [outside, '/etc', '/', home, `${home}/`, dirname(home), dirname(dirname(home))]) {
    assert.deepEqual(canonicalizeArtifactRoot(p, home), { error: 'outside-home' }, p)
  }
  for (const p of ['relative/dir', `${home}/a/../b`, `${home}/..`, `${home}/a\0b`, `${home}/bad\nname`, `${home}/${'x'.repeat(5000)}`, `${home}/\uDC00`]) {
    assert.deepEqual(canonicalizeArtifactRoot(p, home), { error: 'outside-home' }, JSON.stringify(p))
  }
})

test('canonicalizeArtifactRoot rejects Atlas runtime, Claude runtime, Git internal and secrets directories, in any letter case', () => {
  const home = freshHome()
  const denied = [
    '.claude/atlas', '.claude/atlas/spool', '.claude/projects', '.claude/projects/-x', '.claude/jobs', '.claude/session-focus', '.claude/todos',
    '.claude/shell-snapshots', '.claude/statsig', '.claude/cache', '.claude/cost-ledger', '.claude/Cost-Ledger/imports', '.ssh', '.ssh/keys', '.SSH', '.gnupg', '.aws', '.config/gcloud',
    'Library/Keychains', 'library/keychains', '.Claude/Atlas', 'proj/.git', 'proj/.git/worktrees/x',
    // Long s and Kelvin sign: the same directories on a case- and normalization-insensitive (macOS) volume.
    '.ſsh', 'Library/Keychains',
  ]
  for (const rel of denied) {
    mkdirSync(join(home, rel), { recursive: true })
    assert.deepEqual(canonicalizeArtifactRoot(join(home, rel), home), { error: 'outside-home' }, rel)
  }
  // The spelling is judged as given, before resolution: a secrets-directory name stays rejected even when it is a symlink to
  // an ordinary directory.
  mkdirSync(join(home, 'plain'))
  symlinkSync(join(home, 'plain'), join(home, '.gnupg-alias'))
  symlinkSync(join(home, 'plain'), join(home, 'proj', '.GNUPG'))
  assert.equal(canonRoot(join(home, '.gnupg-alias'), home), join(home, 'plain'), 'control: a different name is fine')
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'proj', '.GNUPG'), home), { error: 'outside-home' })
  // Their neighbours stay usable: ~/.claude itself is a supported session cwd, and the durable output base sits beside atlas.
  for (const rel of ['.claude', '.claude/artifact-output', '.config', 'Library', 'proj', '.claude/worktrees/feat']) {
    mkdirSync(join(home, rel), { recursive: true })
    assert.equal(canonRoot(join(home, rel), home), join(home, rel), rel)
  }
})

test('canonicalizeArtifactRoot resolves a symlinked root to its canonical target and rejects escapes', () => {
  const home = freshHome()
  const outside = outsideDir()
  mkdirSync(join(home, 'real', 'docs'), { recursive: true })
  symlinkSync(join(home, 'real', 'docs'), join(home, 'docs-link'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'docs-link'), home), { canonicalPath: join(home, 'real', 'docs'), exists: true })

  symlinkSync(outside, join(home, 'out-link'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'out-link'), home), { error: 'symlink-escape' }, 'symlink leaving home')
  mkdirSync(join(home, '.ssh'))
  symlinkSync(join(home, '.ssh'), join(home, 'ssh-link'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'ssh-link'), home), { error: 'symlink-escape' }, 'symlink into ~/.ssh')
  symlinkSync(home, join(home, 'home-link'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'home-link'), home), { error: 'symlink-escape' }, 'symlink to home itself')
  symlinkSync('/', join(home, 'slash-link'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'slash-link'), home), { error: 'symlink-escape' }, 'symlink to /')
  // A missing root below a symlinked ancestor that leaves home is an escape too.
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'out-link', 'not-yet'), home), { error: 'symlink-escape' })
  symlinkSync(join(home, 'nowhere'), join(home, 'dangling'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'dangling', 'x'), home), { error: 'symlink-escape' }, 'dangling ancestor cannot be verified')

  mk(join(home, 'file.md'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'file.md'), home), { error: 'not-directory' })
  symlinkSync(join(home, 'file.md'), join(home, 'file-link'))
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'file-link'), home), { error: 'not-directory' })
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'file.md', 'below'), home), { error: 'not-directory' })
})

test('a missing output root returns its normalized canonical path with exists:false and never authorizes parent traversal', () => {
  const home = freshHome()
  mkdirSync(join(home, 'proj', 'link-target'), { recursive: true })
  symlinkSync(join(home, 'proj', 'link-target'), join(home, 'proj', 'via'))
  assert.deepEqual(canonicalizeArtifactRoot(`${home}//proj/./exports/`, home), { canonicalPath: join(home, 'proj', 'exports'), exists: false })
  assert.deepEqual(canonicalizeArtifactRoot(join(home, 'proj', 'via', 'out'), home), { canonicalPath: join(home, 'proj', 'link-target', 'out'), exists: false },
    'the existing part of a missing root is canonicalized through its symlink')

  const missing = root('missing', join(home, 'proj', 'exports'))
  mk(join(home, 'proj', 'sibling.md'))
  const r = [missing]
  assert.equal(authorizeArtifactPath(join(home, 'proj', 'sibling.md'), r, home).allowed, false, 'the parent of a missing root is not authorized')
  const below = authorizeArtifactPath(join(home, 'proj', 'exports', 'report.md'), r, home)
  assert.equal(below.allowed, false, 'a not-yet-existing path under a missing root is not authorized')
  assert.equal(below.rootId, null)
  assert.equal(below.canonicalPath, null)
  assert.equal(authorizeArtifactPath(join(home, 'proj', 'exports', '..', 'sibling.md'), r, home).allowed, false)
})

// ------------------------------------------------------------------------------------------------ authorization: spelling

test('authorizeArtifactPath rejects parent segments, relative paths, NUL bytes and over-long paths', () => {
  const home = freshHome()
  const docs = join(home, 'docs')
  mk(join(docs, 'a.md'))
  mk(join(home, 'elsewhere', 'b.md'))
  const roots = [root('docs', canonRoot(docs, home))]
  assert.equal(authorizeArtifactPath(join(docs, 'a.md'), roots, home).allowed, true, 'control case')
  const cases: Array<[string, string]> = [
    [`${docs}/sub/../a.md`, 'parent-segment'],
    [`${docs}/../docs/a.md`, 'parent-segment'],
    [`${docs}/..`, 'parent-segment'],
    ['docs/a.md', 'relative-path'],
    ['./a.md', 'relative-path'],
    ['', 'malformed'],
    // Node would encode the lone surrogate as U+FFFD at the syscall, so this string does not name the file it spells.
    [`${docs}/\uD800.md`, 'malformed'],
    [`${docs}/a.md\0.png`, 'nul-byte'],
    [`${docs}/${'x'.repeat(5000)}.md`, 'too-long'],
  ]
  for (const [p, reason] of cases) {
    const res = authorizeArtifactPath(p, roots, home)
    assert.deepEqual({ allowed: res.allowed, canonicalPath: res.canonicalPath, rootId: res.rootId, reason: res.reason }, { allowed: false, canonicalPath: null, rootId: null, reason }, JSON.stringify(p.slice(0, 80)))
    assert.equal(res.protected, false, `no protection signal in ${JSON.stringify(p.slice(0, 80))}`)
  }
  // A rejected spelling still carries its path-only protection signals, so callers can redact it.
  const signalled: Array<[string, string]> = [
    [`${docs}/PHI/x/../jane-doe.md`, 'parent-segment'],
    [`${docs}/phi/a\0.md`, 'nul-byte'],
    [`${docs}/PHI/${'x'.repeat(5000)}.md`, 'too-long'],
    ['PHI/a.md', 'relative-path'],
    [`${docs}/Phi/\uD800.md`, 'malformed'],
    [`${docs}/sub/../.env`, 'parent-segment'],
    [`${docs}/sub/../id_rsa`, 'parent-segment'],
  ]
  for (const [p, reason] of signalled) {
    const res = authorizeArtifactPath(p, roots, home)
    assert.deepEqual([res.allowed, res.reason, res.protected], [false, reason, true], JSON.stringify(p.slice(0, 80)))
  }
  // Not a string at all: nothing can be inspected, so it fails closed.
  const notString = authorizeArtifactPath(42 as unknown as string, roots, home)
  assert.deepEqual([notString.allowed, notString.reason, notString.protected], [false, 'malformed', true])
})

test('parent traversal after a symlinked directory is rejected even when the lexical result would be authorized', () => {
  const home = freshHome()
  const docs = join(home, 'docs')
  mk(join(docs, 'a.md'))
  const outside = outsideDir()
  mk(join(outside, 'inner', 'x'))
  mk(join(outside, 'a.md'), 'secret')
  // docs/hop -> outside/inner, so the kernel reads docs/hop/../a.md as outside/a.md while a lexical join says docs/a.md.
  symlinkSync(join(outside, 'inner'), join(docs, 'hop'))
  const res = authorizeArtifactPath(`${docs}/hop/../a.md`, [root('docs', canonRoot(docs, home))], home)
  assert.equal(res.allowed, false)
  assert.equal(res.reason, 'parent-segment')
})

// ------------------------------------------------------------------------------------------------ authorization: symlinks

test('authorizeArtifactPath rejects symlink escapes through a symlinked ancestor and re-checks containment on the real path', () => {
  const home = freshHome()
  const outside = outsideDir()
  const docs = join(home, 'docs')
  mkdirSync(docs)
  const roots = [root('docs', canonRoot(docs, home))]

  mk(join(outside, 'leak.md'))
  symlinkSync(outside, join(docs, 'out'))
  let res = authorizeArtifactPath(join(docs, 'out', 'leak.md'), roots, home)
  assert.deepEqual([res.allowed, res.reason, res.canonicalPath], [false, 'symlink-escape', null], 'ancestor symlink leaving home')
  res = authorizeArtifactPath(join(docs, 'out', 'new-file.md'), roots, home)
  assert.deepEqual([res.allowed, res.reason], [false, 'symlink-escape'], 'not-yet-existing file below an escaping ancestor')

  mk(join(home, '.ssh', 'notes.md'))
  symlinkSync(join(home, '.ssh'), join(docs, 'keys'))
  res = authorizeArtifactPath(join(docs, 'keys', 'notes.md'), roots, home)
  assert.deepEqual([res.allowed, res.reason], [false, 'symlink-escape'], 'innocuous spelling resolving into ~/.ssh')

  mk(join(home, 'private', 'diary.md'))
  symlinkSync(join(home, 'private'), join(docs, 'priv'))
  res = authorizeArtifactPath(join(docs, 'priv', 'diary.md'), roots, home)
  assert.deepEqual([res.allowed, res.reason], [false, 'symlink-escape'], 'resolves inside home but outside every registered root')

  // The real path is re-checked against the exclusions even when it stays inside a registered root.
  const claude = join(home, '.claude')
  mk(join(claude, 'atlas', 'atlas.md'))
  symlinkSync(join(claude, 'atlas'), join(claude, 'notes'))
  const repo = join(home, 'repo')
  mk(join(repo, '.git', 'config.md'))
  symlinkSync(join(repo, '.git'), join(repo, 'meta'))
  const wide = [root('claude', canonRoot(claude, home), { kind: 'session-directory', scopeFlags: ['session-cwd'] }), root('repo', canonRoot(repo, home), { kind: 'checkout', scopeFlags: ['checkout'] })]
  for (const p of [join(claude, 'notes', 'atlas.md'), join(claude, 'notes', 'not-yet.md'), join(repo, 'meta', 'config.md')]) {
    res = authorizeArtifactPath(p, wide, home)
    assert.deepEqual([res.allowed, res.reason], [false, 'symlink-escape'], p)
  }

  // A symlinked ancestor that lands inside another registered root is authorized under that root's canonical path.
  const other = join(home, 'other')
  mk(join(other, 'shared.md'))
  symlinkSync(other, join(docs, 'to-other'))
  const both = [...roots, root('other', canonRoot(other, home))]
  res = authorizeArtifactPath(join(docs, 'to-other', 'shared.md'), both, home)
  assert.deepEqual([res.allowed, res.canonicalPath, res.rootId], [true, join(other, 'shared.md'), 'other'])
})

test('authorizeArtifactPath rejects a file symlink as an action target even when its target is authorized', () => {
  const home = freshHome()
  const docs = join(home, 'docs')
  mk(join(docs, 'real.md'))
  symlinkSync(join(docs, 'real.md'), join(docs, 'alias.md'))
  symlinkSync(join(docs, 'gone.md'), join(docs, 'dangling.md'))
  const roots = [root('docs', canonRoot(docs, home))]
  assert.equal(authorizeArtifactPath(join(docs, 'real.md'), roots, home).allowed, true)
  for (const name of ['alias.md', 'dangling.md']) {
    const res = authorizeArtifactPath(join(docs, name), roots, home)
    assert.deepEqual([res.allowed, res.reason, res.canonicalPath], [false, 'file-symlink', null], name)
  }
  mkdirSync(join(docs, 'sub'))
  assert.deepEqual([authorizeArtifactPath(join(docs, 'sub'), roots, home).allowed, authorizeArtifactPath(join(docs, 'sub'), roots, home).reason], [false, 'not-regular-file'])
  assert.equal(authorizeArtifactPath(join(docs, 'real.md', 'below.md'), roots, home).allowed, false, 'a file is not a directory')
})

// ------------------------------------------------------------------------------------------------ authorization: secrets and runtime

test('authorizeArtifactPath rejects secrets, Atlas runtime, Claude runtime and Git internals even under a registered root', () => {
  const home = freshHome()
  const claude = join(home, '.claude')
  const config = join(home, '.config')
  const repo = join(home, 'repo')
  for (const p of ['atlas/notes.md', 'atlas/atlas.db', 'projects/-p/a.md', 'jobs/j1/state.json', 'todos/t.json', 'session-focus/s.md', 'shell-snapshots/s.md', 'statsig/s.json', 'cache/c.md', 'Atlas/x.md', 'PROJECTS/x.md']) {
    mk(join(claude, p))
  }
  mk(join(config, 'gcloud', 'credentials.md'))
  mk(join(config, 'tool', 'readme.md'))
  mk(join(repo, '.git', 'description.md'))
  mk(join(repo, 'docs', 'ok.md'))
  mk(join(claude, 'CLAUDE.md'))
  mk(join(claude, 'tmp', 'notes.md'))
  mk(join(claude, 'jobs', 'j1', 'tmp', 'report.md'))
  const roots = [root('claude', canonRoot(claude, home), { kind: 'session-directory', scopeFlags: ['session-cwd'] }), root('config', canonRoot(config, home)), root('repo', canonRoot(repo, home), { kind: 'checkout', scopeFlags: ['checkout'] })]

  for (const p of ['atlas/notes.md', 'atlas/atlas.db', 'projects/-p/a.md', 'jobs/j1/state.json', 'todos/t.json', 'session-focus/s.md', 'shell-snapshots/s.md', 'statsig/s.json', 'cache/c.md', 'Atlas/x.md', 'PROJECTS/x.md']) {
    const res = authorizeArtifactPath(join(claude, p), roots, home)
    assert.deepEqual([res.allowed, res.reason], [false, 'secret-or-runtime'], p)
  }
  assert.deepEqual(pick(authorizeArtifactPath(join(config, 'gcloud', 'credentials.md'), roots, home)), [false, 'secret-or-runtime'])
  assert.deepEqual(pick(authorizeArtifactPath(join(repo, '.git', 'description.md'), roots, home)), [false, 'git-internals'])
  assert.deepEqual(pick(authorizeArtifactPath(join(home, '.ssh', 'id_ed25519'), roots, home)), [false, 'secret-or-runtime'])
  assert.deepEqual(pick(authorizeArtifactPath(join(home, '.AWS', 'credentials'), roots, home)), [false, 'secret-or-runtime'], 'letter case does not bypass')
  // Spellings a case- and normalization-insensitive volume (macOS) treats as the same directory: long s, Kelvin sign.
  assert.deepEqual(pick(authorizeArtifactPath(join(home, '.ſsh', 'id_ed25519'), roots, home)), [false, 'secret-or-runtime'])
  assert.deepEqual(pick(authorizeArtifactPath(join(home, 'Library', 'Keychains', 'login.keychain-db'), roots, home)), [false, 'secret-or-runtime'])
  // Claude Code's Linux OAuth token store is a `.json` under a supported session cwd; it is a secret, not a document.
  mk(join(claude, '.credentials.json'), '{}')
  assert.deepEqual(pick(authorizeArtifactPath(join(claude, '.credentials.json'), roots, home)), [false, 'secret-or-runtime'])
  // Ordinary files beside them stay authorized, including Claude Code's own temp dirs where sessions write deliverables.
  for (const p of [join(claude, 'CLAUDE.md'), join(claude, 'tmp', 'notes.md'), join(claude, 'jobs', 'j1', 'tmp', 'report.md'), join(config, 'tool', 'readme.md'), join(repo, 'docs', 'ok.md')]) {
    assert.equal(authorizeArtifactPath(p, roots, home).allowed, true, p)
  }
  // The temp-dir exception is exact: a letter-case variant of the job path is still job state.
  mk(join(claude, 'JOBS', 'j2', 'tmp', 'r.md'))
  assert.equal(authorizeArtifactPath(join(claude, 'JOBS', 'j2', 'tmp', 'r.md'), roots, home).allowed, false)
})

// I2 (final review, ledger SECURITY NOTE): ~/.claude/settings.json can hold `env` secrets and cost-ledger/ is the cost store; both
// are Claude configuration and runtime, never documents, whichever root (a direct-only parent, a session cwd) would contain them.
test('authorizeArtifactPath refuses Claude settings files and the cost ledger directory, protected, under any root', () => {
  const home = freshHome()
  const claude = join(home, '.claude')
  for (const rel of ['settings.json', 'settings.local.json', 'cost-ledger/ledger.db', 'cost-ledger/exports/notes.md', 'CLAUDE.md', 'keybindings.json', 'docs/settings.json']) {
    mk(join(claude, rel))
  }
  mk(join(home, 'proj', '.claude', 'settings.json'))
  mk(join(home, 'proj', '.claude', 'settings.local.json'))
  mk(join(home, 'proj', '.claude', 'commands', 'plan.md'))
  mk(join(home, 'proj', 'docs', 'settings.json'))
  const direct = root('claude', canonRoot(claude, home), { kind: 'session-directory', scopeFlags: ['direct-only'] })
  const cwdRoot = root('claude-cwd', canonRoot(claude, home), { kind: 'session-directory', scopeFlags: ['session-cwd'] })
  const proj = root('proj', canonRoot(join(home, 'proj'), home), { kind: 'checkout', scopeFlags: ['checkout'] })
  const denied = [
    join(claude, 'settings.json'), join(claude, 'settings.local.json'), join(claude, 'cost-ledger', 'ledger.db'), join(claude, 'cost-ledger', 'exports', 'notes.md'),
    // Spelling does not matter: the deny list compares folded segments (a case-insensitive volume names the same file).
    join(claude, 'Settings.JSON'), join(home, '.CLAUDE', 'SETTINGS.LOCAL.JSON'), join(claude, 'COST-LEDGER', 'x.md'),
    // R82: a project's own .claude/settings*.json is configuration with possible secrets as well, not a document.
    join(home, 'proj', '.claude', 'settings.json'), join(home, 'proj', '.claude', 'settings.local.json'),
  ]
  for (const roots of [[direct], [cwdRoot], [direct, cwdRoot, proj]]) {
    for (const p of denied) {
      const res = authorizeArtifactPath(p, roots, home)
      assert.deepEqual([res.allowed, res.reason, res.protected], [false, 'secret-or-runtime', true], `${p} under ${roots.map(r => r.rootId).join('+')}`)
    }
  }
  // Their neighbours stay usable, and so does a settings.json that is not directly under a `.claude` directory.
  const everything = [direct, cwdRoot, proj]
  for (const p of [join(claude, 'CLAUDE.md'), join(claude, 'keybindings.json'), join(home, 'proj', '.claude', 'commands', 'plan.md'), join(home, 'proj', 'docs', 'settings.json')]) {
    assert.equal(authorizeArtifactPath(p, everything, home).allowed, true, p)
  }
  assert.equal(authorizeArtifactPath(join(claude, 'docs', 'settings.json'), [cwdRoot], home).allowed, true, 'not directly under .claude')
})

test('authorizeArtifactPath rejects paths outside home and outside every registered root, and ignores unusable roots', () => {
  const home = freshHome()
  const outside = outsideDir()
  mk(join(outside, 'x.md'))
  mk(join(home, 'loose.md'))
  mk(join(home, 'docs', 'a.md'))
  const bogus = [root('outside', outside), root('home', home), root('slash', '/'), root('dotdot', `${home}/docs/..`), root('ssh', join(home, '.ssh'))]
  assert.deepEqual(pick(authorizeArtifactPath(join(outside, 'x.md'), bogus, home)), [false, 'outside-home'])
  assert.deepEqual(pick(authorizeArtifactPath(join(home, 'loose.md'), bogus, home)), [false, 'outside-roots'], 'home itself is never a usable root')
  assert.deepEqual(pick(authorizeArtifactPath(join(home, 'docs', 'a.md'), bogus, home)), [false, 'outside-roots'])
  assert.deepEqual(pick(authorizeArtifactPath(join(home, 'docs', 'a.md'), [], '/')), [false, 'outside-home'], 'a home of / authorizes nothing')
  // The given spelling is judged on its own too: a path spelled outside home, or through a secrets directory name, is
  // rejected even when its real path is a file inside a registered root.
  const docsRoot = [root('docs', canonRoot(join(home, 'docs'), home))]
  symlinkSync(join(home, 'docs'), join(outside, 'into-docs'))
  assert.deepEqual(pick(authorizeArtifactPath(join(outside, 'into-docs', 'a.md'), docsRoot, home)), [false, 'outside-home'])
  symlinkSync(join(home, 'docs'), join(home, '.aws'))
  assert.deepEqual(pick(authorizeArtifactPath(join(home, '.aws', 'a.md'), docsRoot, home)), [false, 'secret-or-runtime'])
  assert.equal(authorizeArtifactPath(join(home, '.aws', 'a.md'), docsRoot, home).protected, true, 'a denied secret-dir path is flagged for redaction')
})

test('authorizeArtifactPath accepts the symlinked spelling of home', () => {
  const home = freshHome()
  const docs = join(home, 'docs')
  mk(join(docs, 'a.md'))
  const alias = join(outsideDir(), 'home-alias')
  symlinkSync(home, alias)
  const roots = [root('docs', canonRoot(join(alias, 'docs'), alias))]
  assert.equal(roots[0]!.canonicalPath, docs, 'roots are stored by their real path')
  const res = authorizeArtifactPath(join(alias, 'docs', 'a.md'), roots, alias)
  assert.deepEqual([res.allowed, res.canonicalPath, res.rootId], [true, join(docs, 'a.md'), 'docs'])
})

test('a direct-only root authorizes only files directly inside it, judged on the real path', () => {
  const home = freshHome()
  const dl = join(home, 'Downloads')
  mk(join(dl, 'report.md'))
  mk(join(dl, 'deep', 'bank', 'statement.pdf'))
  mkdirSync(join(dl, 'shallow'))
  // The registration the hook path gets: its canonical parent, flagged direct-only.
  const direct = root('dl', canonRoot(dl, home), { scopeFlags: ['direct-only'] })
  const ok = (p: string) => authorizeArtifactPath(p, [direct], home)

  const report = ok(join(dl, 'report.md'))
  assert.deepEqual([report.allowed, report.canonicalPath, report.rootId], [true, join(dl, 'report.md'), 'dl'], 'the observed file')
  const fresh = ok(join(dl, 'not-yet.md'))
  assert.deepEqual([fresh.allowed, fresh.canonicalPath, fresh.rootId], [true, join(dl, 'not-yet.md'), 'dl'], 'a not-yet-written direct child')

  // Nothing deeper: existing or not, through a missing or an existing subdirectory, or smuggled in through a symlinked one.
  assert.deepEqual(pick(ok(join(dl, 'deep', 'bank', 'statement.pdf'))), [false, 'outside-roots'])
  assert.deepEqual(pick(ok(join(dl, 'shallow', 'new.pdf'))), [false, 'outside-roots'])
  assert.deepEqual(pick(ok(join(dl, 'missing-dir', 'new.pdf'))), [false, 'outside-roots'])
  symlinkSync(join(dl, 'deep', 'bank'), join(dl, 'shortcut'))
  assert.deepEqual(pick(ok(join(dl, 'shortcut', 'statement.pdf'))), [false, 'symlink-escape'])
  assert.deepEqual(pick(ok(join(dl, 'shortcut', 'later.pdf'))), [false, 'symlink-escape'])
  // A symlinked directory that resolves back to the root itself names a direct child; its real path is what is returned.
  symlinkSync(dl, join(dl, 'self'))
  const viaSelf = ok(join(dl, 'self', 'report.md'))
  assert.deepEqual([viaSelf.allowed, viaSelf.canonicalPath, viaSelf.rootId], [true, join(dl, 'report.md'), 'dl'])
  // The target itself must not be a directory, and no flags at all is treated as direct-only (fail closed).
  assert.deepEqual(pick(ok(join(dl, 'deep'))), [false, 'not-regular-file'])
  assert.deepEqual(pick(authorizeArtifactPath(join(dl, 'deep', 'bank', 'statement.pdf'), [{ ...direct, scopeFlags: [] }], home)), [false, 'outside-roots'])

  // A root that also carries a scan scope keeps authorizing its whole subtree, and so does a scan root nested inside.
  const scanned = { ...direct, scopeFlags: ['direct-only' as const, 'configured-output' as const] }
  assert.deepEqual(pick(authorizeArtifactPath(join(dl, 'deep', 'bank', 'statement.pdf'), [scanned], home)), [true, null])
  const deep = root('deep', canonRoot(join(dl, 'deep'), home))
  const nested = authorizeArtifactPath(join(dl, 'deep', 'bank', 'statement.pdf'), [direct, deep], home)
  assert.deepEqual([nested.allowed, nested.rootId], [true, 'deep'])
})

// ------------------------------------------------------------------------------------------------ authorization: worktrees and output roots

test('a safe file in a linked worktree is authorized under the worktree root, and the legacy blanket worktree exclusion is gone', () => {
  const home = freshHome()
  const { main, wt } = repoWithWorktree(home)
  mk(join(wt, 'docs', 'notes.md'))
  const roots = [root('main', canonRoot(main, home), { kind: 'checkout', scopeFlags: ['checkout'] }), root('feat', canonRoot(wt, home), { kind: 'checkout', scopeFlags: ['checkout'] })]
  for (const rel of ['docs/plan.md', 'docs/notes.md']) {
    const res = authorizeArtifactPath(join(wt, rel), roots, home)
    assert.deepEqual([res.allowed, res.canonicalPath, res.rootId, res.protected, res.reason], [true, join(wt, rel), 'feat', false, null], rel)
    assert.equal(isIgnoredPath(join(wt, rel)), false, `legacy isIgnoredPath no longer rejects ${rel}`)
  }
  // The worktree's .git file is Git internals all the same.
  assert.deepEqual(pick(authorizeArtifactPath(join(wt, '.git'), roots, home)), [false, 'git-internals'])
  // A not-yet-written file in the worktree (a direct observation before stat) is authorized from its existing parent.
  const fresh = authorizeArtifactPath(join(wt, 'docs', 'new', 'draft.md'), roots, home)
  assert.deepEqual([fresh.allowed, fresh.canonicalPath, fresh.rootId], [true, join(wt, 'docs', 'new', 'draft.md'), 'feat'])
})

test('a Git-ignored file under a registered output root is authorized and discoverable', () => {
  const home = freshHome()
  const { main } = repoWithWorktree(home)
  const out = mk(join(main, 'exports', 'run-1.csv'), 'a,b')
  assert.equal(git(main, 'check-ignore', '--', out).trim(), out, 'fixture: the export really is Git-ignored')
  const exportsRoot = root('exports', canonRoot(join(main, 'exports'), home))
  const roots = [root('main', canonRoot(main, home), { kind: 'checkout', scopeFlags: ['checkout'] }), exportsRoot]
  const res = authorizeArtifactPath(out, roots, home)
  assert.deepEqual([res.allowed, res.canonicalPath, res.rootId], [true, out, 'exports'], 'the deepest containing root owns a new location')
  assert.equal(isPassiveDiscoveryExcluded(out, artifactsConfig(home), exportsRoot), false, 'Git ignore rules do not suppress output-root discovery')
})

// ------------------------------------------------------------------------------------------------ protection

test('the PHI predicate matches exactly a `phi` or `.phi` segment after the NFKC and case fold (R85)', () => {
  for (const seg of ['phi', 'PHI', 'Phi', 'pHi', '.phi', '.PHI', '.Phi', '\uFF30\uFF28\uFF29', '.\uFF50\uFF48\uFF49']) assert.equal(isPhiSegment(seg), true, seg)
  for (const seg of ['delphi', 'Delphi', 'phil', '.phix', 'phix', 'phi.txt', '..phi', '.phi.', '', '.', 'my-phi', '.phi ']) assert.equal(isPhiSegment(seg), false, seg)
  assert.equal(hasPhiSegment('/home/u/data/athena/csv/.phi/patients.csv'), true)
  assert.equal(hasPhiSegment('/home/u/x/.PHI/b.md'), true)
  assert.equal(hasPhiSegment('/home/u/Clinic/PHI/out/a.md'), true)
  // Directory-or-file as today: every segment is compared, so only a name that is exactly `phi` or `.phi` counts.
  for (const p of ['/home/u/delphi/a.md', '/home/u/phi.txt', '/home/u/.phix/a.md', '/home/u/philosophy.md']) assert.equal(hasPhiSegment(p), false, p)
})

test('a path below a `.phi` folder is protected by path authorization in any case', () => {
  const home = freshHome()
  const docs = join(home, 'docs')
  mkdirSync(docs)
  const roots = [root('docs', canonRoot(docs, home))]
  for (const seg of ['.phi', '.PHI', '.Phi']) {
    const p = mk(join(docs, 'data', 'athena', 'csv', seg, 'patients.md'))
    const res = authorizeArtifactPath(p, roots, home)
    assert.deepEqual([res.allowed, res.protected], [true, true], p)
  }
  const dot = authorizeArtifactPath(mk(join(docs, '.phix', 'a.md')), roots, home)
  assert.deepEqual([dot.allowed, dot.protected], [true, false])
})

test('every extension below a case-insensitive PHI segment is protected; filenames merely containing phi are not', () => {
  const home = freshHome()
  const docs = join(home, 'docs')
  mkdirSync(docs)
  const roots = [root('docs', canonRoot(docs, home))]
  const config = artifactsConfig(home)
  const names = [...config.documentExtensions.map(e => `f.${e}`), 'f.png', 'f.zip', 'f.py', 'f.jsonl', 'noext', 'F.PDF', 'archive.tar.gz', '.hidden']
  for (const seg of ['PHI', 'phi', 'Phi', 'pHi']) {
    for (const where of [[seg], ['patients', seg, 'deep', 'er']]) {
      for (const name of names) {
        const p = mk(join(docs, ...where, name))
        const res = authorizeArtifactPath(p, roots, home)
        assert.deepEqual([res.allowed, res.protected], [true, true], p)
      }
    }
  }
  // Not yet written: protection is decided from the path alone, never from content.
  assert.equal(authorizeArtifactPath(join(docs, 'PHI', 'later', 'x.docx'), roots, home).protected, true)
  for (const p of ['phi.md', 'PHIX/a.md', 'my-phi/a.md', 'phi-notes/a.md', 'graphic/a.md']) {
    const res = authorizeArtifactPath(mk(join(docs, p)), roots, home)
    assert.deepEqual([res.allowed, res.protected], [true, false], p)
  }
  // A PHI segment above the root still marks the location, and so does a protected root or a secret-looking filename.
  const phiRoot = root('phi-out', canonRoot(mkdirp(join(home, 'Clinic', 'PHI', 'out')), home))
  assert.equal(authorizeArtifactPath(mk(join(phiRoot.canonicalPath, 'a.md')), [phiRoot], home).protected, true)
  const locked = root('locked', canonRoot(mkdirp(join(home, 'locked')), home), { protected: true })
  assert.equal(authorizeArtifactPath(mk(join(locked.canonicalPath, 'a.md')), [locked], home).protected, true)
  for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'credentials.json', 'secrets.yaml']) {
    const res = authorizeArtifactPath(mk(join(docs, name)), roots, home)
    assert.deepEqual([res.allowed, res.protected], [true, true], name)
  }
  // Protection from any containing root sticks even when a deeper, unprotected root owns the location.
  const inner = root('inner', canonRoot(mkdirp(join(locked.canonicalPath, 'inner')), home))
  const nested = authorizeArtifactPath(mk(join(inner.canonicalPath, 'b.md')), [locked, inner], home)
  assert.deepEqual([nested.rootId, nested.protected], ['inner', true])
  // Protection follows the spelling used as well as the real path: a symlink cannot launder a protected location.
  const open = root('open', canonRoot(mkdirp(join(home, 'open')), home))
  mk(join(open.canonicalPath, 'c.md'))
  symlinkSync(open.canonicalPath, join(locked.canonicalPath, 'to-open'))
  symlinkSync(open.canonicalPath, join(mkdirp(join(docs, 'alias')), 'PHI'))
  const viaLocked = authorizeArtifactPath(join(locked.canonicalPath, 'to-open', 'c.md'), [locked, open], home)
  assert.deepEqual([viaLocked.allowed, viaLocked.canonicalPath, viaLocked.rootId, viaLocked.protected], [true, join(open.canonicalPath, 'c.md'), 'open', true])
  const viaPhi = authorizeArtifactPath(join(docs, 'alias', 'PHI', 'c.md'), [...roots, open], home)
  assert.deepEqual([viaPhi.allowed, viaPhi.rootId, viaPhi.protected], [true, 'open', true])
  assert.equal(authorizeArtifactPath(join(open.canonicalPath, 'c.md'), [open], home).protected, false, 'control: the real path alone is unprotected')
})

// ------------------------------------------------------------------------------------------------ discovery exclusions

test('ignore rules affect bulk scans but never existing-location authorization', () => {
  const home = freshHome()
  const out = join(home, 'out')
  mkdirSync(out)
  const outRoot = root('out', canonRoot(out, home))
  const config = artifactsConfig(home)
  assert.ok(config.ignoreSegments.includes('.scratch'), 'fixture: default user ignore segment')
  const ignored = ['node_modules/pkg/README.md', 'build/report.md', '.cache/x.md', 'dist/a.html', '.scratch/draft.md', 'notes.md.swp', 'report.md~', 'a.tmp', 'deep/test-results/r.json']
  for (const rel of ignored) {
    const p = mk(join(out, rel))
    assert.equal(isPassiveDiscoveryExcluded(p, config, outRoot), true, `scan skips ${rel}`)
    const res = authorizeArtifactPath(p, [outRoot], home)
    assert.deepEqual([res.allowed, res.rootId], [true, 'out'], `but an already-known ${rel} stays authorized`)
  }
  for (const rel of ['report.md', 'sub/data.csv', 'Build-notes/x.md', 'nodemodules/x.md']) {
    assert.equal(isPassiveDiscoveryExcluded(mk(join(out, rel)), config, outRoot), false, rel)
  }
  // User segments come from the config passed in, not from process-wide state.
  const custom = artifactsConfig(home, { ignoreSegments: ['drafts'] })
  assert.equal(isPassiveDiscoveryExcluded(join(out, 'drafts', 'a.md'), custom, outRoot), true)
  assert.equal(isPassiveDiscoveryExcluded(join(out, '.scratch', 'a.md'), custom, outRoot), false)
})

test('discovery exclusions apply below the root only; secrets, runtime and Git internals are never walked', () => {
  const home = freshHome()
  const config = artifactsConfig(home)
  // An explicitly registered root may itself sit under a segment that would be noise deeper down.
  const buildOut = root('build-out', canonRoot(mkdirp(join(home, 'proj', 'build', 'exports')), home))
  assert.equal(isPassiveDiscoveryExcluded(buildOut.canonicalPath, config, buildOut), false)
  assert.equal(isPassiveDiscoveryExcluded(join(buildOut.canonicalPath, 'r.md'), config, buildOut), false)
  const wtRoot = root('wt', canonRoot(mkdirp(join(home, 'proj', '.claude', 'worktrees', 'feat')), home), { kind: 'checkout', scopeFlags: ['checkout'] })
  assert.equal(isPassiveDiscoveryExcluded(join(wtRoot.canonicalPath, 'docs', 'a.md'), config, wtRoot), false, 'a linked worktree root is scanned')
  assert.equal(isPassiveDiscoveryExcluded(join(wtRoot.canonicalPath, '.git'), config, wtRoot), true)

  const claude = root('claude', canonRoot(mkdirp(join(home, '.claude')), home), { kind: 'session-directory', scopeFlags: ['session-cwd'] })
  for (const rel of ['atlas', 'atlas/atlas.db', 'projects', 'projects/-p/a.md', 'jobs', 'jobs/j/state.json', 'cache', 'todos/a.json', 'Projects/x.md']) {
    assert.equal(isPassiveDiscoveryExcluded(join(claude.canonicalPath, rel), config, claude), true, rel)
  }
  assert.equal(isPassiveDiscoveryExcluded(join(claude.canonicalPath, 'worktrees', 'feat', 'a.md'), config, claude), true, 'nested worktrees straddling the root')
  assert.equal(isPassiveDiscoveryExcluded(join(claude.canonicalPath, 'CLAUDE.md'), config, claude), false)
  assert.equal(isPassiveDiscoveryExcluded(join(claude.canonicalPath, 'commands', 'review.md'), config, claude), false)
  const conf = root('conf', canonRoot(mkdirp(join(home, '.config')), home))
  assert.equal(isPassiveDiscoveryExcluded(join(conf.canonicalPath, 'gcloud', 'x.json'), config, conf), true, 'a secret dir straddling the root is skipped')
  const proj = root('proj', canonRoot(mkdirp(join(home, 'proj2')), home), { kind: 'session-directory', scopeFlags: ['session-cwd'] })
  for (const rel of ['.git', '.git/HEAD', '.GIT/config', '.ssh/id.md', 'x/.aws/credentials', '.claude/worktrees/feat/docs/a.md']) {
    assert.equal(isPassiveDiscoveryExcluded(join(proj.canonicalPath, rel), config, proj), true, rel)
  }
  assert.equal(isPassiveDiscoveryExcluded(join(proj.canonicalPath, '.claude', 'commands', 'a.md'), config, proj), false)

  // Fail closed outside the root, on malformed spellings, and for roots that are never bulk-scanned.
  assert.equal(isPassiveDiscoveryExcluded(join(home, 'proj2-sibling', 'a.md'), config, proj), true)
  assert.equal(isPassiveDiscoveryExcluded(`${proj.canonicalPath}/x/../a.md`, config, proj), true)
  assert.equal(isPassiveDiscoveryExcluded('relative/a.md', config, proj), true)
  const direct = { ...proj, scopeFlags: ['direct-only' as const] }
  assert.equal(isPassiveDiscoveryExcluded(join(proj.canonicalPath, 'a.md'), config, direct), true, 'direct-only roots are never bulk-scanned')
  assert.equal(isPassiveDiscoveryExcluded(join(proj.canonicalPath, 'a.md'), config, { ...proj, scopeFlags: ['direct-only', 'cli-output'] }), false)
})

// ------------------------------------------------------------------------------------------------ identity

test('nested-root overlap resolves to one stable document identity', () => {
  const home = freshHome()
  const outer = root('r-outer', canonRoot(mkdirp(join(home, 'work')), home))
  const inner = root('r-inner', canonRoot(mkdirp(join(home, 'work', 'reports')), home))
  const dupA = root('r-b', inner.canonicalPath)
  const dupB = root('r-a', inner.canonicalPath)
  const p = mk(join(inner.canonicalPath, 'q3', 'summary.md'))
  const ids = new Set<string>()
  for (const order of [[outer, inner], [inner, outer]]) {
    const res = authorizeArtifactPath(p, order, home)
    assert.equal(res.rootId, 'r-inner', 'a new location takes the deepest containing root')
    ids.add(JSON.stringify(identity(documentIdentityForPath(res.canonicalPath!, order.find(r => r.rootId === res.rootId)!, null))))
  }
  assert.deepEqual([...ids], [JSON.stringify({ identityKind: 'root', repositoryId: null, rootId: 'r-inner', relativePath: 'q3/summary.md' })])
  // Duplicate registrations of one canonical directory tie-break by root ID, whatever the order.
  for (const order of [[outer, dupA, dupB], [dupB, outer, dupA], [dupA, dupB, outer]]) {
    assert.equal(authorizeArtifactPath(p, order, home).rootId, 'r-a')
  }
  // An existing location keeps its original identity root: the caller passes that root and gets the same identity back.
  assert.deepEqual(identity(documentIdentityForPath(p, outer, null)), { identityKind: 'root', repositoryId: null, rootId: 'r-outer', relativePath: 'reports/q3/summary.md' })
})

test('newline and Unicode filenames remain one path through authorization, discovery and identity', () => {
  const home = freshHome()
  const out = root('out', canonRoot(mkdirp(join(home, 'out')), home))
  const config = artifactsConfig(home)
  const names = ['two\nlines.md', 'tab\there.md', 'résumé – 報告 🚀.md', 'café.md', 'café.md', 'trailing-newline.md\n', ' lead space.md']
  // Each name gets its own folder: on a case- or normalization-insensitive volume the two `café.md` spellings would be one file,
  // and the canonical path would be the spelling stored first.
  for (const [i, name] of names.entries()) {
    const p = mk(join(out.canonicalPath, 'sub dir', `n${i}`, name))
    const res = authorizeArtifactPath(p, [out], home)
    assert.deepEqual([res.allowed, res.canonicalPath, res.rootId], [true, p, 'out'], JSON.stringify(name))
    assert.equal(isPassiveDiscoveryExcluded(p, config, out), false, JSON.stringify(name))
    assert.deepEqual(identity(documentIdentityForPath(p, out, null)), { identityKind: 'root', repositoryId: null, rootId: 'out', relativePath: `sub dir/n${i}/${name}` })
  }
  // NFC and NFD spellings are kept exactly as given: no normalization merges or splits them.
  const nfd = identity(documentIdentityForPath(join(out.canonicalPath, 'café.md'), out, null))
  const nfc = identity(documentIdentityForPath(join(out.canonicalPath, 'café.md'), out, null))
  assert.notEqual(nfd.relativePath, nfc.relativePath)
  assert.deepEqual(identity(documentIdentityForGitPath('repo-1', 'docs/two\nlines.md')), { identityKind: 'repository', repositoryId: 'repo-1', rootId: null, relativePath: 'docs/two\nlines.md' })
})

test('Git identity keeps the exact path and refuses anything it cannot represent losslessly', () => {
  assert.deepEqual(documentIdentityForGitPath('repo-1', 'Docs/Plan.MD'), { identityKind: 'repository', repositoryId: 'repo-1', rootId: null, relativePath: 'Docs/Plan.MD' })
  const refusals: Array<[string, string, string]> = [
    ['repo-1', 'docs/\uD800bad.md', 'lossy-path'],
    ['repo-1', 'docs/bad\uDC00.md', 'lossy-path'],
    ['repo-1', 'docs/replaced-�.md', 'lossy-path'],
    ['repo-1', '', 'invalid-path'],
    ['repo-1', '/abs.md', 'invalid-path'],
    ['repo-1', 'a/../b.md', 'invalid-path'],
    ['repo-1', 'a//b.md', 'invalid-path'],
    ['repo-1', 'a/./b.md', 'invalid-path'],
    ['repo-1', 'a/', 'invalid-path'],
    ['repo-1', 'nul\0.md', 'invalid-path'],
    ['repo-1', 'x'.repeat(5000), 'invalid-path'],
    ['', 'a.md', 'invalid-id'],
    ['bad\nid', 'a.md', 'invalid-id'],
  ]
  for (const [repo, path, reason] of refusals) {
    assert.deepEqual(documentIdentityForGitPath(repo, path), { incomplete: true, reason }, JSON.stringify([repo, path.slice(0, 40)]))
  }
  // A paired surrogate (an astral character) is valid UTF-8 and stays as written.
  assert.equal(identity(documentIdentityForGitPath('repo-1', 'notes/🚀.md')).relativePath, 'notes/🚀.md')
})

test('documentIdentityForPath uses the confirmed Git path, never the root repository association', () => {
  const home = freshHome()
  const docs = mkdirp(join(home, 'repo', 'docs'))
  const checkout = root('ck', canonRoot(join(home, 'repo'), home), { kind: 'checkout', repositoryId: 'repo-1', scopeFlags: ['checkout'] })
  const external = root('ext', canonRoot(mkdirp(join(home, 'external-out')), home), { repositoryId: 'repo-1' })
  const p = mk(join(docs, 'plan.md'))
  assert.deepEqual(identity(documentIdentityForPath(p, checkout, { repositoryId: 'repo-1', gitPath: 'docs/plan.md' })), { identityKind: 'repository', repositoryId: 'repo-1', rootId: null, relativePath: 'docs/plan.md' })
  // Without a confirmed Git path, even a checkout or an output root associated with a repository yields root identity.
  assert.deepEqual(identity(documentIdentityForPath(p, checkout, null)), { identityKind: 'root', repositoryId: null, rootId: 'ck', relativePath: 'docs/plan.md' })
  const q = mk(join(external.canonicalPath, 'plan.md'))
  assert.deepEqual(identity(documentIdentityForPath(q, external, null)), { identityKind: 'root', repositoryId: null, rootId: 'ext', relativePath: 'plan.md' })
  // Refusals instead of lossy or invented identities.
  assert.deepEqual(documentIdentityForPath(join(home, 'elsewhere.md'), external, null), { incomplete: true, reason: 'outside-root' })
  assert.deepEqual(documentIdentityForPath(external.canonicalPath, external, null), { incomplete: true, reason: 'outside-root' })
  assert.deepEqual(documentIdentityForPath(`${external.canonicalPath}/a/../b.md`, external, null), { incomplete: true, reason: 'invalid-path' })
  assert.deepEqual(documentIdentityForPath(join(external.canonicalPath, '\uD800.md'), external, null), { incomplete: true, reason: 'lossy-path' })
  assert.deepEqual(documentIdentityForPath(p, checkout, { repositoryId: 'repo-1', gitPath: 'docs/�.md' }), { incomplete: true, reason: 'lossy-path' })
  assert.deepEqual(documentIdentityForPath(join(home, 'elsewhere.md'), checkout, { repositoryId: 'repo-1', gitPath: 'elsewhere.md' }), { incomplete: true, reason: 'outside-root' })
})

// ------------------------------------------------------------------------------------------------ integration with persistence

test('policy identities are accepted by the persistence layer: linked worktree and main checkout form ONE document group', () => {
  const home = freshHome()
  const { main, wt, commonDir } = repoWithWorktree(home)
  const db = openDatabase(':memory:')
  try {
    const repositoryId = registerArtifactRepository(db, { commonDir, displayName: 'proj', remoteIdentity: null }, NOW)
    const mainRow = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: canonRoot(main, home), repositoryId, projectName: 'proj', checkoutIdentity: 'ck-main', protected: false, scopeFlags: ['checkout'] }, NOW)
    const wtRow = registerArtifactRoot(db, { kind: 'checkout', canonicalPath: canonRoot(wt, home), repositoryId, projectName: 'proj', checkoutIdentity: 'ck-feat', protected: false, scopeFlags: ['checkout', 'session-cwd'] }, NOW)
    const roots = [workerRoot(mainRow), workerRoot(wtRow)]
    const byId = (id: string | null) => roots.find(r => r.rootId === id)!

    const docIds: string[] = []
    for (const [key, file] of [['k-main', join(main, 'docs', 'plan.md')], ['k-wt', join(wt, 'docs', 'plan.md')]] as const) {
      const auth = authorizeArtifactPath(file, roots, home)
      assert.equal(auth.allowed, true, file)
      const id = identity(documentIdentityForPath(auth.canonicalPath!, byId(auth.rootId), { repositoryId, gitPath: 'docs/plan.md' }))
      assert.deepEqual(id, identity(documentIdentityForGitPath(repositoryId, 'docs/plan.md')))
      const res = evidence(db, key, auth.rootId!, auth.canonicalPath!, id)
      assert.equal(res.duplicate, false)
      docIds.push(res.documentId)
    }
    assert.equal(docIds[0], docIds[1], 'one logical group across the main checkout and its linked worktree')
    const counts = db.raw.prepare('SELECT (SELECT COUNT(*) FROM artifact_documents) AS docs, (SELECT COUNT(*) FROM artifacts) AS locations').get() as { docs: number; locations: number }
    assert.deepEqual({ ...counts }, { docs: 1, locations: 2 })
  } finally {
    db.close()
  }
})

test('policy root identities are accepted by the persistence layer, and adding a nested root does not split an existing document', () => {
  const home = freshHome()
  const db = openDatabase(':memory:')
  try {
    const outerRow = registerArtifactRoot(db, { kind: 'output', canonicalPath: canonRoot(mkdirp(join(home, 'work')), home), repositoryId: null, projectName: 'work', checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] }, NOW)
    const outer = workerRoot(outerRow)
    const existing = mk(join(outer.canonicalPath, 'reports', 'old.md'))
    const weird = mk(join(outer.canonicalPath, 'reports', 'two\nlines – 報告.md'))
    const first = authorizeArtifactPath(existing, [outer], home)
    const firstDoc = evidence(db, 'e1', first.rootId!, first.canonicalPath!, identity(documentIdentityForPath(first.canonicalPath!, outer, null))).documentId
    const w = authorizeArtifactPath(weird, [outer], home)
    evidence(db, 'e-weird', w.rootId!, w.canonicalPath!, identity(documentIdentityForPath(w.canonicalPath!, outer, null)))
    const stored = db.raw.prepare('SELECT relative_path FROM artifact_documents WHERE relative_path LIKE ?').get('reports/two%') as { relative_path: string }
    assert.equal(stored.relative_path, 'reports/two\nlines – 報告.md', 'a newline name is stored as one path')

    // A nested scan scope arrives later.
    const innerRow = registerArtifactRoot(db, { kind: 'output', canonicalPath: canonRoot(join(home, 'work', 'reports'), home), repositoryId: null, projectName: 'work', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, NOW)
    const roots = [outer, workerRoot(innerRow)]
    const again = authorizeArtifactPath(existing, roots, home)
    assert.equal(again.rootId, innerRow.rootId, 'the deepest root is offered for new locations')
    const viaInner = evidence(db, 'e2', again.rootId!, again.canonicalPath!, identity(documentIdentityForPath(again.canonicalPath!, workerRoot(innerRow), null)))
    assert.equal(viaInner.documentId, firstDoc, 'the existing location keeps its original document')
    const viaOuter = evidence(db, 'e3', outer.rootId, existing, identity(documentIdentityForPath(existing, outer, null)))
    assert.equal(viaOuter.documentId, firstDoc)
    // A brand-new file under both roots gets the inner root identity.
    const fresh = mk(join(innerRow.canonicalPath, 'new.md'))
    const auth = authorizeArtifactPath(fresh, roots, home)
    const id = identity(documentIdentityForPath(auth.canonicalPath!, workerRoot(innerRow), null))
    assert.deepEqual(id, { identityKind: 'root', repositoryId: null, rootId: innerRow.rootId, relativePath: 'new.md' })
    assert.notEqual(evidence(db, 'e4', auth.rootId!, auth.canonicalPath!, id).documentId, firstDoc)
  } finally {
    db.close()
  }
})

function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

function pick(res: { allowed: boolean; reason: string | null }): [boolean, string | null] {
  return [res.allowed, res.reason]
}
