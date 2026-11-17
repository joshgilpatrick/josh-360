import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { tempDir, removeTempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { ensureSession, setSessionStatus } from '../../src/db/sessions.ts'
import { listJobs } from '../helpers/legacy-jobs.ts'
import type { Logger } from '../../src/util/log.ts'
import { silentLogger } from '../helpers/log.ts'
import { createWatcher } from '../../src/artifacts/watcher.ts'
import type { AtlasDb } from '../../src/db/database.ts'

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10'
const iso = (ms: number) => new Date(ms).toISOString()
const base = tempDir('.atlas-test-', homedir())

after(() => removeTempDir(base))

// Polls `pred` until it is true or `timeoutMs` elapses, then returns either way — the caller's own
// assertion afterward produces the useful failure message. 15s default absorbs FSEvents delivery
// lag under full-suite load (observed >5s about 1 run in 3); positive waits return as soon as
// the predicate holds, so the cap only costs time on a real failure.
async function waitFor(pred: () => boolean, opts: { timeoutMs?: number; stepMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const stepMs = opts.stepMs ?? 50
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pred()) return
    if (Date.now() >= deadline) return
    await sleep(stepMs)
  }
}

// macOS FSEvents has a startup race: a write that lands before the freshly created recursive
// watcher's stream is actually running is never delivered, however long you wait (measured
// ~1 in 40 under parallel full-suite load, 0 in 40 once the stream has settled). Tests therefore
// write the file and keep re-touching it every `stepMs` until the predicate holds; re-touches
// are harmless because candidate inserts are INSERT OR IGNORE per (path, session).
async function touchUntil(pred: () => boolean, file: string, content: string, opts: { timeoutMs?: number; stepMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  const stepMs = opts.stepMs ?? 250
  for (;;) {
    writeFileSync(file, content)
    await waitFor(pred, { timeoutMs: stepMs, stepMs: 25 })
    if (pred() || Date.now() >= deadline) return
  }
}

const countCandidates = (db: AtlasDb): number => (db.raw.prepare(`SELECT COUNT(*) AS n FROM artifact_candidates`).get() as { n: number }).n

test('sync watches recent active folders, skips nested/ignored/home, and caps count', () => {
  const db = openTestDb()
  const w = createWatcher({ db, log: silentLogger, maxFolders: 5 })
  try {
    const now = Date.now()
    const a = tempDir('a-', base); const nested = join(a, 'sub'); mkdirSync(nested)
    ensureSession(db, { sessionId: S1, cwd: a, startedAt: iso(now), now: iso(now) })
    ensureSession(db, { sessionId: S2, cwd: nested, startedAt: iso(now), now: iso(now) })
    ensureSession(db, { sessionId: 'agent-abcdef123456', parentSessionId: S1, isSubagent: true, cwd: a, startedAt: iso(now), now: iso(now) })
    ensureSession(db, { sessionId: '4b2c7d8e-1111-4a92-9e7e-2d6e6b8e9c10', cwd: homedir(), startedAt: iso(now), now: iso(now) })
    const r = w.syncActiveFolders()
    assert.deepEqual(r.watching, [a])
    setSessionStatus(db, S1, 'closed', iso(now)); setSessionStatus(db, S2, 'closed', iso(now))
    assert.deepEqual(w.syncActiveFolders().removed, [a])
  } finally {
    w.close(); db.close()
  }
})

type Dirty = { folder: string; path: string | null }

// Task 7: a watcher callback only reports what became dirty (the watched folder and the exact path, or null for "the whole
// folder"). It never stats, hashes, runs Git, scans or touches SQLite: the artifact manager debounces the hints and turns them
// into bounded jobs.
test('a file created in a watched folder is reported dirty, and the callback does no SQLite work', async () => {
  const db = openTestDb()
  const dirty: Dirty[] = []
  const w = createWatcher({ db, log: silentLogger, onDirty: (folder, path) => { dirty.push({ folder, path }) } })
  try {
    const now = Date.now()
    const dir = tempDir('w-', base)
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now), now: iso(now) })
    w.syncActiveFolders()
    const file = join(dir, 'made-by-bash.csv')
    await touchUntil(() => dirty.some(d => d.path === file), file, 'a,b\n')
    assert.ok(dirty.some(d => d.folder === dir && d.path === file))
    assert.equal(countCandidates(db), 0, 'no candidate row is written from the callback')
    assert.deepEqual(listJobs(db), [], 'no job is enqueued from the callback')
  } finally {
    w.close(); db.close()
  }
})

// F1 (round 1) + item 2 (round 2): when a nested child folder's session has newer activity than its ancestor's, the child is
// chosen first; the ancestor must then collapse the child's WATCH into itself (never a nested fs.watch). Hints from anywhere
// under the merged watch are reported with that folder and their exact path.
test('an ancestor folder absorbs a newer-activity descendant watch and reports hints from both', async () => {
  const db = openTestDb()
  const dirty: Dirty[] = []
  const w = createWatcher({ db, log: silentLogger, onDirty: (folder, path) => { dirty.push({ folder, path }) } })
  try {
    const now = Date.now()
    const parent = tempDir('p-', base)
    const child = join(parent, 'sub'); mkdirSync(child)
    const sibling = join(parent, 'other'); mkdirSync(sibling)
    ensureSession(db, { sessionId: S1, cwd: parent, startedAt: iso(now - 1000), now: iso(now - 1000) })
    ensureSession(db, { sessionId: S2, cwd: child, startedAt: iso(now), now: iso(now) })
    const r = w.syncActiveFolders()
    assert.deepEqual(r.watching, [parent]) // one watch, not two nested ones
    const siblingFile = join(sibling, 'made-by-bash.csv')
    await touchUntil(() => dirty.some(d => d.path === siblingFile), siblingFile, 'a,b\n')
    const childFile = join(child, 'made-by-second.csv')
    await touchUntil(() => dirty.some(d => d.path === childFile), childFile, 'a,b\n')
    assert.ok(dirty.every(d => d.folder === parent))
    assert.equal(countCandidates(db), 0)
  } finally {
    w.close(); db.close()
  }
})

// F2 (round 1): onEvent runs synchronously inside the fs.watch callback, so a throw from the dirty sink must never escape
// uncaught; the watcher logs a warning instead of crashing the service.
test('a watcher event whose dirty sink throws is caught and logged, not thrown', async () => {
  const db = openTestDb()
  const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = []
  const log: Logger = {
    info: () => {},
    error: () => {},
    warn: (msg, data) => { warnings.push({ msg, data: data as Record<string, unknown> | undefined }) },
  }
  const w = createWatcher({ db, log, onDirty: () => { throw new Error('sink failed') } })
  const dir = tempDir('z-', base)
  try {
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now), now: iso(now) })
    w.syncActiveFolders()
    await touchUntil(() => warnings.length > 0, join(dir, 'made-by-bash.csv'), 'a,b\n')
    assert.ok(warnings.some(x => x.msg === 'watcher event failed'), 'expected the watcher to log and swallow the error instead of throwing out of the fs.watch callback')
  } finally {
    w.close(); db.close()
  }
})

// Spec s10: a watcher error, overflow or lost event marks the scope dirty for recovery. A null filename (some platforms'
// overflow signal) and an 'error' event both report the whole folder; the errored watch is dropped.
test('a watcher error or a nameless event marks the whole folder dirty', () => {
  const db = openTestDb()
  const dirty: Dirty[] = []
  const fakes: Array<EventEmitter & { close(): void; listener: (event: string, filename: string | null) => void }> = []
  const watchFn = ((_folder: string, _opts: unknown, listener: (event: string, filename: string | null) => void) => {
    const e = Object.assign(new EventEmitter(), { close() {}, listener })
    fakes.push(e)
    return e
  }) as unknown as NonNullable<Parameters<typeof createWatcher>[0]['watchFn']>
  const w = createWatcher({ db, log: silentLogger, onDirty: (folder, path) => { dirty.push({ folder, path }) }, watchFn })
  try {
    const dir = tempDir('o-', base)
    assert.equal(w.watch(dir, [S1]), true)
    fakes[0]!.listener('rename', null)
    assert.deepEqual(dirty, [{ folder: dir, path: null }])
    fakes[0]!.emit('error', new Error('overflow'))
    assert.deepEqual(dirty, [{ folder: dir, path: null }, { folder: dir, path: null }])
    assert.deepEqual(w.folders(), [], 'the errored watch is dropped; the next sync re-creates it')
    assert.equal(countCandidates(db), 0)
  } finally {
    w.close(); db.close()
  }
})

// F6: watcher.ts only checked "inside home, not home, not /" — a cwd under a sensitive directory
// (per candidates.ts's own sensitive-dir list) was never excluded from being watched. HOME is
// overridden to a throwaway fake home (never the real ~/.ssh) so the directory can be created for
// real and proven watchable-but-for-the-trust-check, without touching the user's actual ~/.ssh.
test('F6: a session cwd under a sensitive directory is never watched', () => {
  const prevHome = process.env.HOME
  const fakeHome = tempDir('atlas-fakehome-')
  process.env.HOME = fakeHome
  const db = openTestDb()
  const w = createWatcher({ db, log: silentLogger })
  try {
    const now = Date.now()
    const sshDir = join(fakeHome, '.ssh'); mkdirSync(sshDir)
    ensureSession(db, { sessionId: S1, cwd: sshDir, startedAt: iso(now), now: iso(now) })
    const r = w.syncActiveFolders()
    assert.deepEqual(r.watching, [])
    assert.equal(w.watch(sshDir, [S1]), false)
  } finally {
    w.close(); db.close()
    process.env.HOME = prevHome
    removeTempDir(fakeHome)
  }
})

// F6: a cwd that is itself a symlink out of home passed the string-only "starts with home" check.
test('F6: a session cwd that is a symlink escaping home is never watched', () => {
  const db = openTestDb()
  const w = createWatcher({ db, log: silentLogger })
  const outside = tempDir('atlas-outside-') // deliberately NOT under home
  try {
    const now = Date.now()
    const link = join(base, 'escape-link')
    symlinkSync(outside, link)
    ensureSession(db, { sessionId: S1, cwd: link, startedAt: iso(now), now: iso(now) })
    const r = w.syncActiveFolders()
    assert.deepEqual(r.watching, [])
    assert.equal(w.watch(link, [S1]), false)
  } finally {
    w.close(); db.close(); removeTempDir(outside)
  }
})

// item 4 (round 2): statSync follows symlinks, so a symlink dropped into a watched folder that
// points at a genuinely recent file elsewhere would otherwise be catalogued as a created file.
test('a symlink dropped into a watched folder is never catalogued as a candidate', async () => {
  const db = openTestDb()
  const w = createWatcher({ db, log: silentLogger })
  try {
    const now = Date.now()
    const dir = tempDir('y-', base)
    const real = tempDir('y-real-', base)
    const target = join(real, 'recent.csv')
    writeFileSync(target, 'a,b\n') // a real, recently-created file OUTSIDE the watched folder
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now), now: iso(now) })
    w.syncActiveFolders()
    symlinkSync(target, join(dir, 'link.csv'))
    // Bounded negative wait: give any (incorrect) event the same delivery window, then assert it
    // never produced a row. Shorter than the 5s default since we're proving absence, not presence.
    await waitFor(() => countCandidates(db) >= 1, { timeoutMs: 1500 })
    assert.equal(countCandidates(db), 0)
  } finally {
    w.close(); db.close()
  }
})
