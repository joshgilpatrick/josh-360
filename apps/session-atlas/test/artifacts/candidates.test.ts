import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tempDir, removeTempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { ensureSession, touchSession } from '../../src/db/sessions.ts'
import { configureArtifactRules, confirmCandidate, isClaudeTempPath, isIgnoredPath, isTrustedRoot, isUntrustedPath, processCandidates, pruneSettledCandidates } from '../../src/artifacts/candidates.ts'
import { findArtifactByPath, creatorOf } from '../../src/db/artifacts.ts'

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10'
const iso = (ms: number) => new Date(ms).toISOString()
// Temp dirs must be inside the home directory for the home boundary check; macOS tmpdir is /var/folders which is outside.
const base = tempDir('.atlas-test-', homedir())
after(() => removeTempDir(base))

test('ignored paths', () => {
  assert.equal(isIgnoredPath('/x/node_modules/a/b.js'), true)
  assert.equal(isIgnoredPath('/x/.git/HEAD'), true)
  // Spec s4: the blanket exclusion of every .claude/worktrees file is gone -- a linked worktree is a real checkout whose
  // files are ingested and actionable. Bulk checkout noise is suppressed at discovery instead (path-policy.ts); the other
  // rules still apply inside a worktree.
  assert.equal(isIgnoredPath('/x/.claude/worktrees/w/a.md'), false)
  assert.equal(isIgnoredPath('/x/.claude/worktrees/w/node_modules/a.md'), true)
  assert.equal(isIgnoredPath('/x/a.swp'), true)
  assert.equal(isIgnoredPath('/x/docs/a.md'), false)
})

// I4: ~/.claude is a real, supported cwd (a live checkout of the claude-harness config repo) --
// but its runtime-owned subtrees (other sessions' transcripts, job state, session-focus files,
// todos, shell snapshots, caches) must never be catalogued as if they were that session's own
// artifacts.
test('Claude Code runtime subtrees under ~/.claude are ignored and untrusted', () => {
  const home = homedir()
  for (const seg of ['projects', 'jobs', 'session-focus', 'todos', 'shell-snapshots', 'statsig', 'cache']) {
    const p = join(home, '.claude', seg, 'x', 'y.jsonl')
    assert.equal(isIgnoredPath(p), true, `isIgnoredPath: ${seg}`)
    assert.equal(isUntrustedPath(p), true, `isUntrustedPath: ${seg}`)
  }
  // A sibling file directly under ~/.claude (not one of the runtime subtrees) is unaffected.
  assert.equal(isIgnoredPath(join(home, '.claude', 'CLAUDE.md')), false)
})

test('tool_event candidates confirm even without a window; watcher candidates respect the window', () => {
  const db = openTestDb()
  const dir = tempDir('proj-', base)
  const old = join(dir, 'old.md'); writeFileSync(old, 'x')
  const start = Date.now() + 5_000                       // session starts 5s in the future, so old.md is before the window
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(start), now: iso(start) })
  touchSession(db, S1, iso(start + 60_000))
  assert.equal(confirmCandidate(db, { path: old, sessionId: S1, detectedVia: 'watcher', observedAt: iso(start) }, { now: iso(start), graceMs: 0 }), 'rejected')
  assert.equal(confirmCandidate(db, { path: old, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(start) }, { now: iso(start) }), 'created')
  assert.equal(findArtifactByPath(db, old)!.existsState, 'present')
  const missing = join(dir, 'gone.md')
  assert.equal(confirmCandidate(db, { path: missing, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(start) }, { now: iso(start) }), 'created')
  assert.equal(findArtifactByPath(db, missing)!.existsState, 'missing')
  assert.equal(confirmCandidate(db, { path: missing, sessionId: S1, detectedVia: 'watcher', observedAt: iso(start) }, { now: iso(start) }), 'rejected')
  assert.equal(confirmCandidate(db, { path: dir, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(start) }, { now: iso(start) }), 'rejected', 'directories are not artifacts')
  assert.equal(confirmCandidate(db, { path: '/etc/hosts', sessionId: S1, detectedVia: 'tool_event', observedAt: iso(start) }, { now: iso(start) }), 'rejected', 'outside home')
  db.close()
})

test('first creator keeps provenance; later sessions link; same session is duplicate', () => {
  const db = openTestDb()
  const dir = tempDir('proj-', base)
  const now = Date.now()
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
  ensureSession(db, { sessionId: S2, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
  const f = join(dir, 'new.md'); writeFileSync(f, 'x')
  touchSession(db, S1, iso(now + 1000)); touchSession(db, S2, iso(now + 1000))
  assert.equal(confirmCandidate(db, { path: f, sessionId: S1, detectedVia: 'watcher', observedAt: iso(now) }, { now: iso(now) }), 'created')
  assert.equal(confirmCandidate(db, { path: f, sessionId: S1, detectedVia: 'reconcile', observedAt: iso(now) }, { now: iso(now) }), 'duplicate')
  assert.equal(confirmCandidate(db, { path: f, sessionId: S2, detectedVia: 'watcher', observedAt: iso(now) }, { now: iso(now) }), 'linked')
  assert.equal(creatorOf(db, findArtifactByPath(db, f)!.artifactId), S1)
  db.close()
})

test('processCandidates drains pending rows and updates their state', () => {
  const db = openTestDb()
  const dir = tempDir('proj-', base)
  const now = Date.now()
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
  const a = join(dir, 'a.md'); writeFileSync(a, 'x')
  db.raw.prepare(`INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, 'tool_event', ?, 'pending')`).run(a, S1, iso(now))
  db.raw.prepare(`INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, 'watcher', ?, 'pending')`).run(join(dir, 'node_modules', 'x.js'), S1, iso(now))
  assert.deepEqual(processCandidates(db, { sessionId: S1, now: iso(now) }), { created: 1, linked: 0, rejected: 1, duplicate: 0 })
  const states = (db.raw.prepare('SELECT state FROM artifact_candidates ORDER BY candidate_id').all() as Array<{ state: string }>).map(r => r.state)
  assert.deepEqual(states, ['confirmed', 'rejected'])
  assert.deepEqual(processCandidates(db, { now: iso(now) }), { created: 0, linked: 0, rejected: 0, duplicate: 0 })
  db.close()
})

test('untrusted candidate paths are rejected before any stat (plan 02 handoff)', () => {
  const db = openTestDb()
  const dir = tempDir('proj-', base)
  const now = Date.now()
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
  touchSession(db, S1, iso(now + 1000))

  // Sensitive directory under home, even though the path itself is well-formed and absolute.
  const sshPath = join(homedir(), '.ssh', 'atlas-test-nonexistent-key')
  assert.equal(confirmCandidate(db, { path: sshPath, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(now) }, { now: iso(now) }), 'rejected', 'path under ~/.ssh is rejected')

  // A symlink inside the temp fixture dir that resolves outside the home directory.
  const link = join(dir, 'escape.md')
  symlinkSync('/etc/hosts', link)
  assert.equal(confirmCandidate(db, { path: link, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(now) }, { now: iso(now) }), 'rejected', 'symlink escaping home is rejected')

  // A path far longer than the 4096-char ceiling.
  const longPath = join(dir, `${'x'.repeat(5000)}.md`)
  assert.equal(confirmCandidate(db, { path: longPath, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(now) }, { now: iso(now) }), 'rejected', 'overlong path is rejected')

  db.close()
})

// F2: confirmCandidate must lstat, never stat — a symlink dropped anywhere (even a tool_event
// candidate, which skips the creation-window check) must never be followed to its real target
// and catalogued as if the symlink itself were the created file.
test('F2: a symlink candidate is rejected via lstat, never followed to its target', () => {
  const db = openTestDb()
  const dir = tempDir('symlink-', base)
  const now = Date.now()
  const target = join(dir, 'target.md'); writeFileSync(target, 'real content')
  const link = join(dir, 'link.md'); symlinkSync(target, link)
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
  touchSession(db, S1, iso(now + 1000))
  assert.equal(confirmCandidate(db, { path: link, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(now) }, { now: iso(now) }), 'rejected')
  assert.equal(findArtifactByPath(db, link), null, 'a rejected symlink is never recorded as an artifact')
  db.close()
})

// F2: the sensitive-directory check must also apply to the resolved realpath, not only the
// literal candidate path — otherwise a path that merely passes THROUGH a symlinked ancestor
// directory into ~/.ssh (rather than being a symlink itself) slips past the literal-path check.
test('F2: a path whose realpath resolves under ~/.ssh via a symlinked ancestor directory is rejected', () => {
  const prevHome = process.env.HOME
  const fakeHome = tempDir('fakehome-', base)
  process.env.HOME = fakeHome
  try {
    const db = openTestDb()
    const now = Date.now()
    const dir = tempDir('proj-', fakeHome)
    const sshDir = join(fakeHome, '.ssh'); mkdirSync(sshDir)
    writeFileSync(join(sshDir, 'note.md'), 'x')
    const linkDir = join(dir, 'linkdir')
    symlinkSync(sshDir, linkDir)
    const candidatePath = join(linkDir, 'note.md') // literal path is under dir, not ~/.ssh
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
    touchSession(db, S1, iso(now + 1000))
    assert.equal(confirmCandidate(db, { path: candidatePath, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(now) }, { now: iso(now) }), 'rejected')
    db.close()
  } finally {
    process.env.HOME = prevHome
  }
})

// I2 (final review): the legacy gates (isUntrustedPath, used by candidates and the legacy preview/reveal/open routes) must refuse
// the same Claude configuration the path policy refuses: settings files (they can hold `env` secrets) and the cost ledger.
test('I2: the legacy trust gate refuses ~/.claude/settings.json, settings.local.json and cost-ledger/, but not ordinary ~/.claude files', () => {
  const prevHome = process.env.HOME
  const fakeHome = tempDir('fakehome-', base)
  process.env.HOME = fakeHome
  try {
    const claude = join(fakeHome, '.claude')
    mkdirSync(join(claude, 'cost-ledger'), { recursive: true })
    for (const f of ['settings.json', 'settings.local.json', 'CLAUDE.md', join('cost-ledger', 'ledger.db')]) writeFileSync(join(claude, f), 'x')
    for (const f of ['settings.json', 'settings.local.json', join('cost-ledger', 'ledger.db'), join('cost-ledger', 'exports', 'a.md'), 'Settings.JSON']) {
      assert.equal(isUntrustedPath(join(claude, f)), true, f)
    }
    assert.equal(isUntrustedPath(join(claude, 'CLAUDE.md')), false, 'control: a neighbour is still trusted')
    // Through a symlinked ancestor the real path is judged too.
    const linkDir = join(fakeHome, 'linkdir')
    symlinkSync(claude, linkDir)
    assert.equal(isUntrustedPath(join(linkDir, 'settings.json')), true, 'via a symlinked ancestor')
  } finally {
    process.env.HOME = prevHome
  }
})

// F7: markCandidate re-prepared its UPDATE statement on every call instead of caching it in the
// same WeakMap-per-connection way recordCandidate's insert statement already is.
test('F7: markCandidate prepares its UPDATE statement once per db connection, not per call', () => {
  const db = openTestDb()
  const dir = tempDir('markcache-', base)
  const now = Date.now()
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
  touchSession(db, S1, iso(now + 1000))
  let updatePrepareCount = 0
  const originalPrepare = db.raw.prepare.bind(db.raw)
  db.raw.prepare = ((sql: string) => {
    if (sql.startsWith('UPDATE artifact_candidates')) updatePrepareCount += 1
    return originalPrepare(sql)
  }) as typeof db.raw.prepare
  // Five distinct rejected candidates each go through markCandidate once.
  for (let i = 0; i < 5; i++) {
    confirmCandidate(db, { path: `/etc/hosts-${i}`, sessionId: S1, detectedVia: 'tool_event', observedAt: iso(now) }, { now: iso(now) })
  }
  assert.equal(updatePrepareCount, 1, 'the UPDATE statement should be prepared once and reused, not re-prepared per call')
  db.close()
})

// F3: Date.parse('now') is NaN, and NaN comparisons are always false, so an unparseable session
// timestamp used to make the creation-window check fail OPEN (neither "birth < start" nor
// "birth > end" holds) instead of failing closed.
test('F3: an unparseable session timestamp fails closed on a window-checked candidate', () => {
  const db = openTestDb()
  const dir = tempDir('badtime-', base)
  const now = Date.now()
  const f = join(dir, 'a.md'); writeFileSync(f, 'x')
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: 'now', now: iso(now) })
  assert.equal(confirmCandidate(db, { path: f, sessionId: S1, detectedVia: 'watcher', observedAt: iso(now) }, { now: iso(now) }), 'rejected')
  db.close()
})

test('tool scratch dirs are ignored, and config.json can add more segments', () => {
  assert.equal(isIgnoredPath('/x/.playwright-cli/page-1.yml'), true)
  assert.equal(isIgnoredPath('/x/playwright-report/index.html'), true)
  assert.equal(isIgnoredPath('/x/test-results/a.png'), true)
  assert.equal(isIgnoredPath('/x/.idea/workspace.xml'), true)
  assert.equal(isIgnoredPath('/x/.scratch/a.md'), false)
  configureArtifactRules({ ignoreSegments: ['.scratch'] })
  try {
    assert.equal(isIgnoredPath('/x/.scratch/a.md'), true)
  } finally {
    configureArtifactRules({ ignoreSegments: [] })
  }
  assert.equal(isIgnoredPath('/x/.scratch/a.md'), false)
})

// H3: a session may write real deliverables into Claude Code's own temp dirs
// ($CLAUDE_JOB_DIR/tmp or ~/.claude/tmp). Those stay discoverable and revealable even though the
// rest of ~/.claude/jobs (state.json, timeline.jsonl) stays ignored and untrusted.
test('Claude temp dirs under ~/.claude stay discoverable while job state stays ignored', () => {
  const home = homedir()
  const jobTmp = join(home, '.claude', 'jobs', '190c612e', 'tmp', 'report.md')
  const claudeTmp = join(home, '.claude', 'tmp', 'notes.md')
  for (const p of [jobTmp, claudeTmp]) {
    assert.equal(isClaudeTempPath(p), true, p)
    assert.equal(isIgnoredPath(p), false, `ignored: ${p}`)
    assert.equal(isUntrustedPath(p), false, `untrusted: ${p}`)
  }
  const jobState = join(home, '.claude', 'jobs', '190c612e', 'state.json')
  assert.equal(isClaudeTempPath(jobState), false)
  assert.equal(isIgnoredPath(jobState), true)
  assert.equal(isUntrustedPath(jobState), true)
  assert.equal(isClaudeTempPath('/elsewhere/.claude/tmp/x.md'), false)
  assert.equal(isClaudeTempPath(`${home}/.claude/jobs/190c612e/tmp/../../../.ssh/key`), false)
})

// A home reached through a symlink (macOS: /var -> /private/var). Built here, so it needs no TMPDIR trick.
function withSymlinkedHome(fn: (h: { link: string; real: string }) => void): void {
  const prev = process.env.HOME
  const root = realpathSync(tempDir('atlas-symhome-'))
  const real = join(root, 'real'), link = join(root, 'link')
  mkdirSync(real, { recursive: true }); symlinkSync(real, link)
  process.env.HOME = link
  try { fn({ link, real }) } finally { process.env.HOME = prev; removeTempDir(root) }
}

test('a home reached through a symlink is not "outside home" for its own files', () => {
  withSymlinkedHome(({ link, real }) => {
    mkdirSync(join(real, '.claude', 'tmp'), { recursive: true }); mkdirSync(join(real, 'proj'), { recursive: true })
    writeFileSync(join(real, 'proj', 'a.md'), 'x'); writeFileSync(join(real, '.claude', 'CLAUDE.md'), 'x'); writeFileSync(join(real, '.claude', 'tmp', 'n.md'), 'x')
    for (const p of [join(link, 'proj', 'a.md'), join(real, 'proj', 'a.md'), join(link, '.claude', 'CLAUDE.md'), join(link, '.claude', 'tmp', 'n.md')]) {
      assert.equal(isUntrustedPath(p), false, p)
    }
    assert.equal(isClaudeTempPath(join(real, '.claude', 'tmp', 'n.md')), true)
    assert.equal(isTrustedRoot(join(link, 'proj')), true)
    assert.equal(isTrustedRoot(link), false, 'home itself, literal')
    assert.equal(isTrustedRoot(real), false, 'home itself, real')
  })
})

test('under a symlinked home, sensitive dirs and escapes are still refused', () => {
  withSymlinkedHome(({ link, real }) => {
    mkdirSync(join(real, '.ssh'), { recursive: true }); mkdirSync(join(real, '.josh-360', 'atlas'), { recursive: true })
    writeFileSync(join(real, '.ssh', 'notes.md'), 'x'); writeFileSync(join(real, '.josh-360', 'atlas', 'n.md'), 'x')
    for (const p of [join(link, '.ssh', 'notes.md'), join(real, '.ssh', 'notes.md'), join(real, '.josh-360', 'atlas', 'n.md')]) {
      assert.equal(isUntrustedPath(p), true, p)
    }
    // A link inside home to a real file elsewhere, and to a sensitive dir inside the real home.
    const outside = realpathSync(tempDir('atlas-outside-'))
    try {
      writeFileSync(join(outside, 'o.md'), 'x')
      symlinkSync(outside, join(real, 'esc')); symlinkSync(join(real, '.ssh'), join(real, 'sshlink'))
      assert.equal(isUntrustedPath(join(link, 'esc', 'o.md')), true, 'real path leaves the real home')
      assert.equal(isUntrustedPath(join(link, 'sshlink', 'notes.md')), true, 'real path is in a sensitive dir')
      assert.equal(isTrustedRoot(join(link, 'esc')), false)
    } finally { removeTempDir(outside) }
  })
})

// Settled candidates (confirmed or rejected) are only dedupe markers: processCandidates reads 'pending' rows alone, and a
// confirmed candidate's data already lives in artifacts/artifact_origins. Pruning old settled rows keeps the table from
// growing without bound (the owner's live catalog reached 7.2 million rejected watcher rows) and never touches pending work.
const putCandidate = (db: ReturnType<typeof openTestDb>, path: string, state: string, observedAt: string) => db.raw.prepare(
  `INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, 'watcher', ?, ?)`,
).run(path, S1, observedAt, state)
const candidateCount = (db: ReturnType<typeof openTestDb>) => (db.raw.prepare('SELECT COUNT(*) AS n FROM artifact_candidates').get() as { n: number }).n

test('pruneSettledCandidates deletes old confirmed and rejected rows, keeps pending and newer rows', () => {
  const db = openTestDb()
  const old = '2026-10-01T00:00:00.000Z', recent = '2026-11-14T00:00:00.000Z', cutoff = '2026-11-08T00:00:00.000Z'
  putCandidate(db, '/x/old-rejected.md', 'rejected', old)
  putCandidate(db, '/x/old-confirmed.md', 'confirmed', old)
  putCandidate(db, '/x/old-pending.md', 'pending', old)
  putCandidate(db, '/x/new-rejected.md', 'rejected', recent)
  putCandidate(db, '/x/at-cutoff.md', 'rejected', cutoff)
  assert.equal(pruneSettledCandidates(db, cutoff), 3)
  const left = (db.raw.prepare('SELECT path FROM artifact_candidates ORDER BY path').all() as Array<{ path: string }>).map(r => r.path)
  assert.deepEqual(left, ['/x/new-rejected.md', '/x/old-pending.md'])
  db.close()
})

test('pruneSettledCandidates deletes in batches and reports the full count', () => {
  const db = openTestDb()
  for (let i = 0; i < 25; i++) putCandidate(db, `/x/f${i}.md`, 'rejected', '2026-10-01T00:00:00.000Z')
  assert.equal(pruneSettledCandidates(db, '2026-11-01T00:00:00.000Z', { batchSize: 10 }), 25)
  assert.equal(candidateCount(db), 0)
  db.close()
})

test('pruneSettledCandidates stops once a pass reaches maxRows, so one pass cannot hold the service loop', () => {
  const db = openTestDb()
  for (let i = 0; i < 25; i++) putCandidate(db, `/x/g${i}.md`, 'rejected', '2026-10-01T00:00:00.000Z')
  assert.equal(pruneSettledCandidates(db, '2026-11-01T00:00:00.000Z', { batchSize: 10, maxRows: 15 }), 20)
  assert.equal(candidateCount(db), 5)
  db.close()
})
