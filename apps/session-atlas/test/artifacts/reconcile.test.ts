import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync, symlinkSync, rmSync, utimesSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { tempDir, removeTempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import type { AtlasDb } from '../../src/db/database.ts'
import { ensureSession, touchSession } from '../../src/db/sessions.ts'
import { readFirstEntry, recheckKnownLocation, reconcileSession, verifyExistence } from '../../src/artifacts/reconcile.ts'
import { processCandidates } from '../../src/artifacts/candidates.ts'
import { findArtifactByPath, searchArtifacts } from '../../src/db/artifacts.ts'
import { recordArtifactObservation, registerArtifactRoot, type ArtifactRootRow } from '../../src/db/artifact-manager.ts'

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const iso = (ms: number) => new Date(ms).toISOString()
const base = tempDir('.atlas-test-', homedir())

after(() => removeTempDir(base))

test('reconcile finds files born in the window, skips ignored and pre-existing, and respects caps', () => {
  const db = openTestDb()
  try {
    const dir = tempDir('r-', base)
    writeFileSync(join(dir, 'before.md'), 'x')
    const start = Date.now() + 1500
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(start), now: iso(start) })
    touchSession(db, S1, iso(start + 60_000))
    mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'x.js'), 'x')
    mkdirSync(join(dir, 'deep', 'a', 'b', 'c', 'd'), { recursive: true })
    // files created "inside" the window: use a grace of 0 by waiting until the filesystem clock reaches
    // start. File timestamps come from the kernel's coarse clock, which can lag Date.now() by one tick,
    // so waiting on Date.now() alone can stamp the in-window file a few ms before start.
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    const wait = start - Date.now(); if (wait > 0) sleep(wait)
    const probe = join(base, 'fs-clock-probe')
    const giveUp = Date.now() + 1000
    try {
      while (Date.now() < giveUp) {
        writeFileSync(probe, 'x')
        const st = lstatSync(probe)
        if ((st.birthtimeMs || st.ctimeMs) >= start) break
        rmSync(probe, { force: true })
        sleep(1)
      }
    } finally {
      rmSync(probe, { force: true })
    }
    writeFileSync(join(dir, 'in-window.csv'), 'x')
    writeFileSync(join(dir, 'deep', 'a', 'b', 'c', 'd', 'too-deep.md'), 'x')
    const r = reconcileSession(db, S1, { now: iso(Date.now()), maxDepth: 3 })
    assert.equal(r.candidates, 1)
    assert.equal(r.capped, false)
    const c = processCandidates(db, { sessionId: S1, now: iso(Date.now()) })
    assert.equal(c.created, 1)
    assert.ok(findArtifactByPath(db, join(dir, 'in-window.csv')))
    assert.equal(findArtifactByPath(db, join(dir, 'before.md')), null)
    assert.equal(reconcileSession(db, S1, { now: iso(Date.now()), maxEntries: 2 }).capped, true)
  } finally {
    db.close()
  }
})

// F3: an unparseable session.startedAt (Date.parse -> NaN) used to make every "birth < start" /
// "birth > end" comparison false, so the walk recorded every file in the folder instead of
// failing closed and scanning nothing.
test('F3: reconcileSession returns zero on an unparseable session timestamp instead of scanning', () => {
  const db = openTestDb()
  try {
    const dir = tempDir('badtime-', base)
    writeFileSync(join(dir, 'a.md'), 'x')
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: 'now', now: iso(Date.now()) })
    assert.deepEqual(reconcileSession(db, S1, { now: iso(Date.now()) }), { scanned: 0, candidates: 0, capped: false })
  } finally {
    db.close()
  }
})

// F4: the whole BFS walk (up to 5000 readdir/lstat calls) used to run inside db.transaction,
// holding the writer lock for the whole walk and blocking the hook endpoint/spool/watcher.
// Deterministic check (no wall-clock): the moment BEGIN IMMEDIATE fires, the tree is deleted.
// If the transaction still wrapped the walk, BEGIN would fire before the first readdir and the
// walk would find nothing; with the walk hoisted out, every file was already collected.
test('F4: the directory walk completes before any db write transaction begins', () => {
  const db = openTestDb()
  try {
    const dir = tempDir('notx-', base)
    const FILE_COUNT = 300
    for (let i = 0; i < FILE_COUNT; i++) writeFileSync(join(dir, `f${i}.md`), 'x')
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
    touchSession(db, S1, iso(now + 1000))

    let begins = 0
    const originalExec = db.raw.exec.bind(db.raw)
    db.raw.exec = ((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && begins++ === 0) rmSync(dir, { recursive: true, force: true })
      return originalExec(sql)
    }) as typeof db.raw.exec

    const r = reconcileSession(db, S1, { now: iso(Date.now()), maxEntries: FILE_COUNT + 10 })
    assert.equal(begins, 1, 'expected exactly one write transaction for the recordCandidate loop')
    assert.equal(r.scanned, FILE_COUNT)
    assert.equal(r.candidates, FILE_COUNT)
  } finally {
    db.close()
  }
})

// F6: reconcile.ts only checked "inside home, not home, not /" for the session's root folder — a
// cwd under a sensitive directory (per candidates.ts's own sensitive-dir list) was walked anyway.
// HOME is overridden to a throwaway fake home (never the real ~/.ssh) so the directory and a file
// inside it can exist for real, proving the walk would otherwise have found it.
test('F6: reconcileSession scans 0 when the session cwd is under a sensitive directory', () => {
  const prevHome = process.env.HOME
  const fakeHome = tempDir('atlas-fakehome-')
  process.env.HOME = fakeHome
  const db = openTestDb()
  try {
    const sshDir = join(fakeHome, '.ssh'); mkdirSync(sshDir)
    writeFileSync(join(sshDir, 'id_rsa'), 'key')
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: sshDir, startedAt: iso(now - 1000), now: iso(now) })
    touchSession(db, S1, iso(now + 1000))
    assert.deepEqual(reconcileSession(db, S1, { now: iso(Date.now()) }), { scanned: 0, candidates: 0, capped: false })
  } finally {
    db.close()
    process.env.HOME = prevHome
    removeTempDir(fakeHome)
  }
})

// F6: a cwd that is itself a symlink out of home passed the string-only "starts with home" check.
test('F6: reconcileSession scans 0 when the session cwd is a symlink escaping home', () => {
  const db = openTestDb()
  const outside = tempDir('atlas-outside-') // deliberately NOT under home
  try {
    writeFileSync(join(outside, 'secret.md'), 'x')
    const link = join(base, 'escape-reconcile-link')
    symlinkSync(outside, link)
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: link, startedAt: iso(now - 1000), now: iso(now) })
    touchSession(db, S1, iso(now + 1000))
    assert.deepEqual(reconcileSession(db, S1, { now: iso(Date.now()) }), { scanned: 0, candidates: 0, capped: false })
  } finally {
    db.close(); removeTempDir(outside)
  }
})

// F9: a path already recorded as an origin of the session must be skipped on rescan — this is
// independent of the creation-window rule (which would still match; the file's birth time hasn't
// changed) and must not count toward the scan cap.
test('F9: a path already recorded as an origin of the session is skipped on rescan, not re-added as a candidate', () => {
  const db = openTestDb()
  try {
    const dir = tempDir('known-', base)
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
    touchSession(db, S1, iso(now + 1000))
    const f = join(dir, 'known.md'); writeFileSync(f, 'x')

    const first = reconcileSession(db, S1, { now: iso(Date.now()) })
    assert.equal(first.candidates, 1)
    processCandidates(db, { sessionId: S1, now: iso(Date.now()) })
    assert.ok(findArtifactByPath(db, f), 'artifact recorded as an origin of S1')

    const second = reconcileSession(db, S1, { now: iso(Date.now()) })
    assert.equal(second.candidates, 0, 'already-known path produces no new candidate row')
    assert.equal(second.capped, false)
    const pending = db.raw.prepare(`SELECT COUNT(*) AS n FROM artifact_candidates WHERE path = ? AND state = 'pending'`).get(f) as { n: number }
    assert.equal(pending.n, 0, 'no new pending candidate row was inserted for the already-known path')
  } finally {
    db.close()
  }
})

test('verifyExistence marks missing files and restores them when they return', () => {
  const db = openTestDb()
  try {
    const dir = tempDir('v-', base)
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
    const f = join(dir, 'a.md'); writeFileSync(f, 'x')
    db.raw.prepare(`INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, 'tool_event', ?, 'pending')`).run(f, S1, iso(now))
    processCandidates(db, { now: iso(now) })
    // R72 (fix round 1): a legacy row has no recorded device until it is seen present once; that sighting records it, and the
    // folder left empty by the deletion is then judged by that device.
    assert.deepEqual(verifyExistence(db, { now: iso(now) }), { checked: 1, missing: 0, restored: 0, unverified: 0 })
    rmSync(f)
    assert.deepEqual(verifyExistence(db, { now: iso(now + 1) }), { checked: 1, missing: 1, restored: 0, unverified: 0 })
    assert.equal(findArtifactByPath(db, f)!.existsState, 'missing')
    assert.equal(searchArtifacts(db, {}, { limit: 10, offset: 0 }).total, 1, 'missing artifacts remain listed')
    writeFileSync(f, 'back')
    assert.deepEqual(verifyExistence(db, { now: iso(now + 2) }), { checked: 1, missing: 0, restored: 1, unverified: 0 })
    assert.equal(findArtifactByPath(db, f)!.sizeBytes, 4)
  } finally {
    db.close()
  }
})

// Controller ruling: verifyExistence must lstat, never stat, so a path whose file was replaced
// by a symlink is reported missing instead of silently following the link to another file.
test('verifyExistence treats a present artifact replaced by a symlink as missing, never following it', () => {
  const db = openTestDb()
  try {
    const dir = tempDir('s-', base)
    const now = Date.now()
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: iso(now - 1000), now: iso(now) })
    const f = join(dir, 'a.md'); writeFileSync(f, 'x')
    const other = join(dir, 'other.md'); writeFileSync(other, 'this file exists and is fine')
    db.raw.prepare(`INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, 'tool_event', ?, 'pending')`).run(f, S1, iso(now))
    processCandidates(db, { now: iso(now) })
    assert.equal(findArtifactByPath(db, f)!.existsState, 'present')
    const sizeBefore = findArtifactByPath(db, f)!.sizeBytes
    assert.equal(sizeBefore, 1)
    rmSync(f)
    symlinkSync(other, f)
    assert.deepEqual(verifyExistence(db, { now: iso(now + 1) }), { checked: 1, missing: 1, restored: 0, unverified: 0 })
    const after = findArtifactByPath(db, f)!
    assert.equal(after.existsState, 'missing')
    // The symlink's own lstat size (its target-path length) must not replace the last-known real size.
    assert.equal(after.sizeBytes, sizeBefore)
  } finally {
    db.close()
  }
})

// ------------------------------------------------------------------------------------------------ DEFECT-5 (Wave 2a)
// Spec s6: "Mark a known location missing after a direct ENOENT/ENOTDIR check ... Permission failures, disconnected roots and
// partial scans produce 'unverified', retaining the last known existence state."

type Loc = { existsState: string; verificationState: string | null; lastVerifiedAt: string | null }
function locOf(db: AtlasDb, path: string): Loc {
  const r = db.raw.prepare('SELECT exists_state, verification_state, last_verified_at FROM artifacts WHERE path = ?').get(path) as { exists_state: string; verification_state: string | null; last_verified_at: string | null }
  return { existsState: r.exists_state, verificationState: r.verification_state, lastVerifiedAt: r.last_verified_at }
}
function stateValue(db: AtlasDb, key: string): string | null {
  return (db.raw.prepare('SELECT value FROM artifact_manager_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}
/** A registered (CLI) output root at a fresh real directory, and a helper that catalogues one of its files as the worker would. */
function verifyFixture(): { db: AtlasDb; dir: string; root: ArtifactRootRow; observe(path: string): void } {
  const db = openTestDb()
  const dir = realpathSync(tempDir('atlas-verify-', tmpdir()))
  const rootPath = join(dir, 'volume')
  mkdirSync(rootPath)
  const root = registerArtifactRoot(db, { kind: 'output', canonicalPath: rootPath, repositoryId: null, projectName: 'v', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(Date.now()))
  const observe = (path: string) => {
    const s = lstatSync(path, { bigint: true })
    recordArtifactObservation(db, {
      rootId: root.rootId, identity: { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: path.slice(rootPath.length + 1) }, kind: 'working',
      observedAt: iso(Date.now()), path, stat: { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs) },
    }, iso(Date.now()))
  }
  return { db, dir, root, observe }
}
const put = (path: string, body = 'x\n'): string => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); return path }

test('DEFECT-5: an ENOENT under a reachable root is missing; an unreachable root leaves its files unverified, never missing', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const gone = put(join(root.canonicalPath, 'gone.md'))
    const kept = put(join(root.canonicalPath, 'sub', 'kept.md'))
    observe(gone); observe(kept)
    rmSync(gone)
    const now = Date.now()
    assert.deepEqual(verifyExistence(db, { now: iso(now + 1_000) }), { checked: 2, missing: 1, restored: 0, unverified: 0 }, 'control: a direct ENOENT under a reachable root')
    assert.equal(locOf(db, gone).existsState, 'missing')
    const verifiedAt = locOf(db, kept).lastVerifiedAt
    assert.equal(verifiedAt, iso(now + 1_000))
    // The whole root disappears from view (an unmounted volume): nothing under it may become missing.
    renameSync(root.canonicalPath, join(dir, 'volume-unmounted'))
    const r = verifyExistence(db, { now: iso(now + 2_000) })
    assert.equal(r.missing, 0)
    assert.ok(r.unverified >= 1, `the unreachable root's file is counted unverified: ${JSON.stringify(r)}`)
    assert.deepEqual(locOf(db, kept), { existsState: 'present', verificationState: 'unverified', lastVerifiedAt: verifiedAt }, 'last known state and verification age kept')
    assert.equal(stateValue(db, 'verify.last-unverified'), 'root-unreachable', 'a path-free token records why')
    assert.ok(Number(stateValue(db, 'health.verify-unverified')) >= 1, 'and a bounded counter how often')
    // Remounted: the next check verifies it again.
    renameSync(join(dir, 'volume-unmounted'), root.canonicalPath)
    const back = verifyExistence(db, { now: iso(now + 3_000) })
    assert.equal(back.missing, 0)
    assert.equal(locOf(db, kept).existsState, 'present')
    assert.equal(locOf(db, kept).verificationState, 'verified', 'verified again once reachable')
    assert.equal(locOf(db, kept).lastVerifiedAt, iso(now + 3_000))
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('DEFECT-5: an ELOOP or permission failure (any errno but ENOENT/ENOTDIR) leaves the location unverified', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const looped = put(join(root.canonicalPath, 'sub', 'b.md'))
    const denied = put(join(root.canonicalPath, 'locked', 'a.md'))
    const odd = put(join(root.canonicalPath, 'odd', 'c.md'))
    observe(looped); observe(denied); observe(odd)
    // The folder holding b.md becomes a symlink loop (ELOOP).
    renameSync(join(root.canonicalPath, 'sub'), join(dir, 'sub-elsewhere'))
    symlinkSync('sub', join(root.canonicalPath, 'sub'))
    // EACCES through the lstat seam (this container runs as root; the acceptance file covers a real EACCES through setpriv).
    const lstat = (path: string): BigIntStats => {
      if (path === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      // R72 (a), fix round 1: an ELOOP on the location itself while every folder above it reads fine is still no proof.
      if (path === odd) throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' })
      return lstatSync(path, { bigint: true })
    }
    const r = verifyExistence(db, { now: iso(Date.now() + 1_000), lstat })
    assert.deepEqual(r, { checked: 3, missing: 0, restored: 0, unverified: 3 })
    assert.deepEqual([locOf(db, odd).existsState, locOf(db, odd).verificationState], ['present', 'unverified'])
    assert.deepEqual([locOf(db, looped).existsState, locOf(db, looped).verificationState], ['present', 'unverified'])
    assert.deepEqual([locOf(db, denied).existsState, locOf(db, denied).verificationState], ['present', 'unverified'])
    assert.ok(['ELOOP', 'EACCES'].includes(stateValue(db, 'verify.last-unverified') ?? ''), 'the errno token, never a path')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('DEFECT-5: a retired root that is gone is judged by its device (a removed worktree is missing, a vanished volume is not)', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const a = put(join(root.canonicalPath, 'docs', 'a.md'))
    const b = put(join(root.canonicalPath, 'docs', 'b.md'))
    observe(a); observe(b)
    // b.md's recorded device is another filesystem's (a volume that is no longer mounted anywhere).
    const sig = JSON.parse((db.raw.prepare('SELECT observation_signature AS s FROM artifacts WHERE path = ?').get(b) as { s: string }).s) as unknown[]
    db.raw.prepare('UPDATE artifacts SET observation_signature = ? WHERE path = ?').run(JSON.stringify(['999999999', ...sig.slice(1)]), b)
    // The root is retired (reconciliation deactivated it: Git no longer lists the worktree) and its folder is removed.
    db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(root.rootId)
    rmSync(root.canonicalPath, { recursive: true, force: true })
    const r = verifyExistence(db, { now: iso(Date.now() + 1_000) })
    assert.deepEqual(r, { checked: 2, missing: 1, restored: 0, unverified: 1 })
    assert.equal(locOf(db, a).existsState, 'missing', 'the folder above it is reachable on the same filesystem: proof it is gone')
    assert.deepEqual([locOf(db, b).existsState, locOf(db, b).verificationState], ['present', 'unverified'], 'a different filesystem may simply be unmounted')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

// Superseded by R72(c) in fix round 1: without a recorded device the nearest existing folder must be non-empty and on its parent's
// filesystem (the empty-folder and mount-point cases are in the R72 tests below).
test('DEFECT-5: a legacy location with no root is missing when the nearest existing folder proves it (R72)', () => {
  const db = openTestDb()
  const dir = realpathSync(tempDir('atlas-verify-', tmpdir()))
  try {
    const a = put(join(dir, 'kept-folder', 'a.md'))
    // R72 (fix round 1): the folder must also stay non-empty to prove anything without a recorded device.
    put(join(dir, 'kept-folder', 'sibling.md'))
    const b = put(join(dir, 'gone-folder', 'b.md'))
    const now = Date.now()
    for (const p of [a, b]) db.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, created_at, exists_state, last_verified_at, is_sensitive) VALUES (?, 'x.md', 'md', 'markdown', ?, 'present', ?, 0)`).run(p, iso(now), iso(now))
    rmSync(a)
    rmSync(join(dir, 'gone-folder'), { recursive: true })
    const r = verifyExistence(db, { now: iso(now + 1_000) })
    assert.deepEqual(r, { checked: 2, missing: 2, restored: 0, unverified: 0 })
    assert.equal(findArtifactByPath(db, a)!.existsState, 'missing', 'its own folder, non-empty, on its parent filesystem')
    assert.equal(findArtifactByPath(db, b)!.existsState, 'missing', 'its folder is gone, and the folder above is non-empty on its parent filesystem')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('DEFECT-5: locations left unverified never starve verification of the others, and are rechecked in rotation', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const stuck = Array.from({ length: 6 }, (_, i) => put(join(root.canonicalPath, `s${i}.md`)))
    for (const p of stuck) observe(p)
    const other = registerArtifactRoot(db, { kind: 'output', canonicalPath: join(dir, 'other'), repositoryId: null, projectName: 'o', checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, iso(Date.now()))
    mkdirSync(other.canonicalPath)
    const late = put(join(other.canonicalPath, 'late.md'))
    const s = lstatSync(late, { bigint: true })
    recordArtifactObservation(db, {
      rootId: other.rootId, identity: { identityKind: 'root', repositoryId: null, rootId: other.rootId, relativePath: 'late.md' }, kind: 'working', observedAt: iso(Date.now() + 5_000), path: late,
      stat: { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs) },
    }, iso(Date.now() + 5_000))
    renameSync(root.canonicalPath, join(dir, 'away'))
    const now = Date.now() + 10_000
    // limit 4: the six unreachable files are the oldest-verified, yet the newer location is still reached.
    verifyExistence(db, { now: iso(now), limit: 4 })
    rmSync(late)
    for (let i = 1; i <= 3; i++) verifyExistence(db, { now: iso(now + i * 1_000), limit: 4 })
    assert.equal(locOf(db, late).existsState, 'missing', 'the newer location is still verified')
    renameSync(join(dir, 'away'), root.canonicalPath)
    for (let i = 4; i <= 12; i++) verifyExistence(db, { now: iso(now + i * 1_000), limit: 4 })
    assert.deepEqual(stuck.map(p => locOf(db, p).verificationState), stuck.map(() => 'verified'), 'every unverified location was rechecked in turn')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

// ------------------------------------------------------------------------------------------------ R72 (Wave 2a fix round 1)
// One proof for "missing", for every location: ENOENT/ENOTDIR, and the nearest existing folder on the device the location was
// last seen present on; an active root must also still be its folder. Devices are simulated through the lstat seam.

/** The real lstat, with the device of `paths` (exact) or of every path under `under` replaced. */
function lstatWithDevice(dev: bigint, match: (path: string) => boolean): (path: string) => BigIntStats {
  return (path: string) => {
    const s = lstatSync(path, { bigint: true })
    if (!match(path)) return s
    const copy = Object.assign(Object.create(Object.getPrototypeOf(s) as object) as BigIntStats, s)
    copy.dev = dev
    return copy
  }
}
const deviceOf = (path: string): bigint => lstatSync(path, { bigint: true }).dev
const lastSeenDevice = (db: AtlasDb, path: string): string | null => (db.raw.prepare('SELECT last_seen_device AS d FROM artifacts WHERE path = ?').get(path) as { d: string | null }).d

test('R72 (C2): an active root that is now an empty mount point never makes its files missing', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const a = put(join(root.canonicalPath, 'a.md'))
    observe(a)
    rmSync(a)
    // The root folder exists, but on the parent filesystem: the volume that held a.md is unmounted.
    const lstat = lstatWithDevice(deviceOf(root.canonicalPath) + 1n, p => p === root.canonicalPath)
    assert.deepEqual(verifyExistence(db, { now: iso(Date.now() + 1_000), lstat }), { checked: 1, missing: 0, restored: 0, unverified: 1 })
    assert.deepEqual([locOf(db, a).existsState, locOf(db, a).verificationState], ['present', 'unverified'])
    assert.equal(stateValue(db, 'verify.last-unverified'), 'device-changed', 'an accurate, path-free token')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R72 (C2): a nested mount point inside an active root never makes its files missing', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const x = put(join(root.canonicalPath, 'mnt', 'sub', 'x.md'))
    const kept = put(join(root.canonicalPath, 'kept.md'))
    observe(x); observe(kept)
    rmSync(join(root.canonicalPath, 'mnt', 'sub'), { recursive: true })
    // root/mnt is left as the mount point's own (parent filesystem) folder.
    const lstat = lstatWithDevice(deviceOf(root.canonicalPath) + 1n, p => p === join(root.canonicalPath, 'mnt'))
    const r = verifyExistence(db, { now: iso(Date.now() + 1_000), lstat })
    assert.deepEqual(r, { checked: 2, missing: 0, restored: 0, unverified: 1 })
    assert.equal(locOf(db, x).existsState, 'present')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R72 (S1): an active root whose path is no longer a folder leaves its files unverified (root-unreachable)', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const a = put(join(root.canonicalPath, 'a.md'))
    observe(a)
    rmSync(root.canonicalPath, { recursive: true })
    writeFileSync(root.canonicalPath, 'a file where the root was')
    assert.deepEqual(verifyExistence(db, { now: iso(Date.now() + 1_000) }), { checked: 1, missing: 0, restored: 0, unverified: 1 })
    assert.equal(locOf(db, a).existsState, 'present')
    assert.equal(stateValue(db, 'verify.last-unverified'), 'root-unreachable')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R72 (I2): after a device renumber a deleted file is proven missing by a sibling seen present in the same run', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const gone = put(join(root.canonicalPath, 'docs', 'gone.md'))
    const kept = put(join(root.canonicalPath, 'docs', 'kept.md'))
    observe(gone); observe(kept)
    db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(root.rootId)
    rmSync(gone)
    // The volume came back under another device number (APFS external volume, btrfs/overlay remount).
    const renumbered = deviceOf(dir) + 7n
    const lstat = lstatWithDevice(renumbered, p => p.startsWith(dir))
    const r = verifyExistence(db, { now: iso(Date.now() + 1_000), lstat })
    assert.deepEqual(r, { checked: 2, missing: 1, restored: 0, unverified: 0 })
    assert.equal(locOf(db, gone).existsState, 'missing', 'the live sibling shows the folder is on the mounted volume')
    assert.equal(lastSeenDevice(db, kept), String(renumbered), 'the device the sibling was seen on is recorded')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R72 (I2): after a device renumber with no live sibling the location is unverified as device-changed, not root-unreachable', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const gone = put(join(root.canonicalPath, 'docs', 'gone.md'))
    observe(gone)
    db.raw.prepare('UPDATE artifact_roots SET active = 0 WHERE root_id = ?').run(root.rootId)
    rmSync(gone)
    const lstat = lstatWithDevice(deviceOf(dir) + 7n, p => p.startsWith(dir))
    assert.deepEqual(verifyExistence(db, { now: iso(Date.now() + 1_000), lstat }), { checked: 1, missing: 0, restored: 0, unverified: 1 })
    assert.equal(stateValue(db, 'verify.last-unverified'), 'device-changed')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R72 (I2): a legacy row with no recorded device needs a non-empty folder that is not a mount point; seeing it present records its device', () => {
  const db = openTestDb()
  const dir = realpathSync(tempDir('atlas-verify-', tmpdir()))
  try {
    const now = Date.now()
    const legacy = (p: string) => db.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, created_at, exists_state, last_verified_at, is_sensitive) VALUES (?, 'x.md', 'md', 'markdown', ?, 'present', ?, 0)`).run(p, iso(now), iso(now))
    const alone = put(join(dir, 'empty-after', 'alone.md'))
    const crowd = put(join(dir, 'crowded', 'crowd.md'))
    put(join(dir, 'crowded', 'other.md'))
    const mounted = put(join(dir, 'mount', 'm.md'))
    put(join(dir, 'mount', 'other.md'))
    for (const p of [alone, crowd, mounted]) legacy(p)
    for (const p of [alone, crowd, mounted]) rmSync(p)
    // dir/mount is a mount point: its device differs from its parent's.
    const lstat = lstatWithDevice(deviceOf(dir) + 3n, p => p === join(dir, 'mount'))
    const r = verifyExistence(db, { now: iso(now + 1_000), lstat })
    assert.deepEqual(r, { checked: 3, missing: 1, restored: 0, unverified: 2 })
    assert.equal(findArtifactByPath(db, crowd)!.existsState, 'missing', 'a non-empty folder on its parent filesystem is proof')
    assert.equal(findArtifactByPath(db, alone)!.existsState, 'present', 'an empty folder may be an unmounted mount point')
    assert.equal(findArtifactByPath(db, mounted)!.existsState, 'present', 'a mount point is not proof without a recorded device')
    // Seen present once, a legacy row records its device; from then on an empty folder on that device is proof.
    const seen = put(join(dir, 'seen', 'seen.md'))
    legacy(seen)
    verifyExistence(db, { now: iso(now + 2_000) })
    assert.equal(lastSeenDevice(db, seen), String(deviceOf(seen)))
    rmSync(seen)
    verifyExistence(db, { now: iso(now + 3_000) })
    assert.equal(findArtifactByPath(db, seen)!.existsState, 'missing')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R72 (C2): a nested mount point is not vouched for by siblings on the root\'s own filesystem', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const x = put(join(root.canonicalPath, 'mnt', 'sub', 'x.md'))
    const kept = put(join(root.canonicalPath, 'kept.md'))
    observe(x); observe(kept)
    // x.md was seen on the volume mounted at root/mnt (another device than the root's own filesystem); it is unmounted now.
    db.raw.prepare('UPDATE artifacts SET last_seen_device = ? WHERE path = ?').run(String(deviceOf(root.canonicalPath) + 5n), x)
    rmSync(join(root.canonicalPath, 'mnt', 'sub'), { recursive: true })
    const r = verifyExistence(db, { now: iso(Date.now() + 1_000) })
    assert.deepEqual(r, { checked: 2, missing: 0, restored: 0, unverified: 1 }, 'kept.md, present on the mount point\'s filesystem, is no proof for x.md')
    assert.equal(locOf(db, x).existsState, 'present')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

// ------------------------------------------------------------------------------------------------ R73 (Wave 2a fix round 2)
// The renumber fallback of R72(c) persists per root: whenever a location of a root is seen present on a device other than the
// one recorded (verifier or scan), the (old -> new) pair is kept, and the verifier and the direct checks consult it.

const renumberState = (db: AtlasDb, rootId: string): unknown => JSON.parse(stateValue(db, `renumber:${rootId}`) ?? 'null')
const idOf = (db: AtlasDb, path: string): number => findArtifactByPath(db, path)!.artifactId
function recordOldDevice(db: AtlasDb, paths: string[], old: string): void {
  // As seen before the volume was renumbered: the stat signature carries the old device number.
  for (const p of paths) {
    const sig = JSON.parse((db.raw.prepare('SELECT observation_signature AS s FROM artifacts WHERE path = ?').get(p) as { s: string }).s) as unknown[]
    db.raw.prepare('UPDATE artifacts SET observation_signature = ?, last_seen_device = NULL WHERE path = ?').run(JSON.stringify([old, ...sig.slice(1)]), p)
  }
}

test('R73 (C3): a sibling seen on the new device in an EARLIER verifier run still vouches for a file deleted later, in the verifier and a direct check', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const gone = put(join(root.canonicalPath, 'docs', 'gone.md'))
    const direct = put(join(root.canonicalPath, 'docs', 'direct.md'))
    const kept = put(join(root.canonicalPath, 'docs', 'kept.md'))
    for (const p of [gone, direct, kept]) observe(p)
    const now = Date.now()
    const old = String(deviceOf(dir) + 9n)
    recordOldDevice(db, [gone, direct, kept], old)
    // Run 1 checks kept.md only (the least recently verified): seen present on the volume's new device number.
    db.raw.prepare('UPDATE artifacts SET last_verified_at = ? WHERE path IN (?, ?)').run(iso(now + 60_000), gone, direct)
    verifyExistence(db, { now: iso(now + 1_000), limit: 1 })
    assert.equal(lastSeenDevice(db, kept), String(deviceOf(kept)))
    assert.deepEqual(renumberState(db, root.rootId), [{ from: old, to: String(deviceOf(kept)), at: iso(now + 1_000) }], 'the pair is persisted for the root')
    rmSync(gone)
    rmSync(direct)
    // A direct check (the handler, the routes) proves it from the persisted pair.
    assert.equal(recheckKnownLocation(db, idOf(db, direct), iso(now + 2_000), { recordUnverified: true })?.state, 'missing')
    // Later verifier runs: kept.md is now recorded on the new device, so this run alone holds no evidence; the persisted pair does.
    for (let i = 0; i < 2; i++) verifyExistence(db, { now: iso(now + 3_000 + i) })
    assert.equal(locOf(db, gone).existsState, 'missing')
    assert.equal(locOf(db, direct).existsState, 'missing')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R73 (C4): a scan that re-observes a sibling on the new device before the verifier runs records the evidence', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const gone = put(join(root.canonicalPath, 'docs', 'gone.md'))
    const kept = put(join(root.canonicalPath, 'docs', 'kept.md'))
    observe(gone); observe(kept)
    const old = String(deviceOf(dir) + 9n)
    recordOldDevice(db, [gone, kept], old)
    // The scan sees kept.md again: its signature now carries the new device.
    observe(kept)
    assert.deepEqual((renumberState(db, root.rootId) as Array<{ from: string; to: string }>).map(p => [p.from, p.to]), [[old, String(deviceOf(kept))]])
    rmSync(gone)
    for (let i = 0; i < 3; i++) verifyExistence(db, { now: iso(Date.now() + 1_000 + i) })
    assert.equal(locOf(db, gone).existsState, 'missing')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R73: persisted evidence vouches only from the OLD device to the anchor\'s CURRENT device (chains followed), and stays bounded', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const real = String(deviceOf(dir))
    const chained = put(join(root.canonicalPath, 'a', 'chained.md'))
    const other = put(join(root.canonicalPath, 'b', 'other.md'))
    put(join(root.canonicalPath, 'a', 'stay.md'))
    put(join(root.canonicalPath, 'b', 'stay.md'))
    observe(chained); observe(other)
    // chained.md was last seen on device 11, other.md on device 12 (a nested volume, say). Evidence: 11 -> 13 -> real.
    recordOldDevice(db, [chained], '11')
    recordOldDevice(db, [other], '12')
    const now = Date.now()
    db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(`renumber:${root.rootId}`, JSON.stringify([{ from: '13', to: real, at: iso(now) }, { from: '11', to: '13', at: iso(now - 1) }, { from: '14', to: '15', at: iso(now - 2) }]), iso(now))
    rmSync(chained); rmSync(other)
    verifyExistence(db, { now: iso(now + 1_000) })
    assert.equal(locOf(db, chained).existsState, 'missing', '11 -> 13 -> the anchor\'s device')
    assert.deepEqual([locOf(db, other).existsState, locOf(db, other).verificationState], ['present', 'unverified'], 'no pair leads from 12: no proof')
    // Many renumbers: only the newest few pairs are kept.
    const many = put(join(root.canonicalPath, 'c', 'many.md'))
    observe(many)
    for (let i = 0; i < 6; i++) {
      recordOldDevice(db, [many], String(100 + i))
      observe(many)
    }
    const pairs = renumberState(db, root.rootId) as Array<{ from: string }>
    assert.ok(pairs.length <= 4, `bounded: ${pairs.length}`)
    assert.equal(pairs[0]!.from, '105', 'newest first')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('fix round 2: a direct check that records an unverified result also records its token and counts it, like the verifier', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const denied = put(join(root.canonicalPath, 'locked', 'a.md'))
    observe(denied)
    const lstat = (path: string): BigIntStats => {
      if (path === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return lstatSync(path, { bigint: true })
    }
    // A route check (recordUnverified: false) writes nothing at all.
    assert.equal(recheckKnownLocation(db, idOf(db, denied), iso(Date.now()), { recordUnverified: false, lstat })?.state, 'unverified')
    assert.equal(stateValue(db, 'verify.last-unverified'), null)
    assert.equal(recheckKnownLocation(db, idOf(db, denied), iso(Date.now()), { recordUnverified: true, lstat })?.state, 'unverified')
    assert.equal(stateValue(db, 'verify.last-unverified'), 'EACCES')
    assert.equal(stateValue(db, 'health.verify-unverified'), '1')
    assert.equal(locOf(db, denied).verificationState, 'unverified')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

// R74.5 (fix round 3): the descriptor count needs /proc/self/fd (Linux); elsewhere that part is skipped with this reason.
const HAS_PROC_FD = existsSync('/proc/self/fd')
const NO_PROC_FD_SKIP: string | false = HAS_PROC_FD ? false : 'no /proc/self/fd on this platform: open descriptors cannot be counted'

test('fix round 2: the "non-empty folder" test reads one entry, never the whole listing', () => {
  const dir = realpathSync(tempDir('atlas-verify-', tmpdir()))
  try {
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}.md`), 'x')
    mkdirSync(join(dir, 'empty'))
    assert.equal(readFirstEntry(dir).length, 1, 'one entry, never the whole listing')
    assert.deepEqual(readFirstEntry(join(dir, 'empty')), [])
  } finally {
    removeTempDir(dir)
  }
})

test('fix round 2: the one-entry read closes every folder handle', { skip: NO_PROC_FD_SKIP }, () => {
  const dir = realpathSync(tempDir('atlas-verify-', tmpdir()))
  try {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.md`), 'x')
    const fds = () => readdirSync('/proc/self/fd').length
    const open = fds()
    for (let i = 0; i < 300; i++) readFirstEntry(dir)
    assert.equal(fds(), open, 'every folder handle is closed')
  } finally {
    removeTempDir(dir)
  }
})

// R74.3 (fix round 3): a renumber pair is recorded only for the SAME file seen on another device (same inode, size and mtime as
// its stat signature). A different file at the same path proves nothing about the volume.
test('R74.3 (NEST): a stray file written into a bare mount point records no renumber pair, so the unmounted volume\'s files stay unverified', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const x = put(join(root.canonicalPath, 'mnt', 'x.md'))
    const y = put(join(root.canonicalPath, 'mnt', 'y.md'))
    observe(x); observe(y)
    // Both were seen on the volume mounted at root/mnt (another device than the root's own filesystem).
    const volume = String(deviceOf(dir) + 5n)
    recordOldDevice(db, [x, y], volume)
    // Unmounted: the volume's files are gone from view, and a stray y.md is written into the bare mount point (a new file).
    const stray = join(root.canonicalPath, 'mnt', 'stray.tmp')
    writeFileSync(stray, 'a different, longer file\n')
    rmSync(x); rmSync(y)
    renameSync(stray, y)
    verifyExistence(db, { now: iso(Date.now() + 1_000) })
    assert.equal(renumberState(db, root.rootId), null, 'no pair from a different file')
    assert.deepEqual([locOf(db, x).existsState, locOf(db, x).verificationState], ['present', 'unverified'])
    // Later runs (after more unmounts) still prove nothing.
    verifyExistence(db, { now: iso(Date.now() + 2_000) })
    assert.equal(locOf(db, x).existsState, 'present')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

test('R74.3: a scan that sees a different file at a known path records no renumber pair; the same file on a new device does', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const same = put(join(root.canonicalPath, 'a', 'same.md'))
    const swapped = put(join(root.canonicalPath, 'b', 'swapped.md'))
    // A whole-second mtime on the original, set before it is first observed, so the replacement below can carry EXACTLY the same
    // mtime. (A copy made through a millisecond Date could differ by 1 ms from the original's sub-millisecond mtime about half
    // the time, and then the mtime check alone refused the pair and the test passed without the inode check.)
    const whole = new Date(Math.floor(Date.now() / 1000 - 600) * 1000)
    utimesSync(swapped, whole, whole)
    observe(same); observe(swapped)
    recordOldDevice(db, [same], '31')
    recordOldDevice(db, [swapped], '32')
    // swapped.md is replaced by another file before the scan sees it: same size and the same mtime to the nanosecond; only the
    // inode tells them apart.
    const before = lstatSync(swapped, { bigint: true })
    const tmp = join(root.canonicalPath, 'b', 'new.tmp')
    writeFileSync(tmp, 'y\n')
    utimesSync(tmp, whole, whole)
    assert.equal(lstatSync(tmp, { bigint: true }).mtimeNs, before.mtimeNs, 'the premise: the replacement has the same mtime, to the nanosecond')
    assert.equal(lstatSync(tmp, { bigint: true }).size, before.size, 'the premise: and the same size')
    rmSync(swapped)
    renameSync(tmp, swapped)
    assert.notEqual(lstatSync(swapped, { bigint: true }).ino, before.ino)
    assert.equal(lstatSync(swapped, { bigint: true }).mtimeNs, before.mtimeNs)
    observe(swapped)
    observe(same)
    const pairs = (renumberState(db, root.rootId) as Array<{ from: string; to: string }>).map(p => p.from)
    assert.deepEqual(pairs, ['31'], 'only the same file on a new device is renumber evidence')
  } finally {
    db.close(); removeTempDir(dir)
  }
})

// R74.3, inverted order (final review): a location's recorded device is the last device ANY probe saw it present on, which can
// be a different file's (a stray file in a bare mount point). The pair must lead from the device of the SIGNATURE whose
// inode, size and mtime matched, or a plain unmount marks a present file missing.
test('R74.3 (inverted order): a recorded device that is not the signature\'s own device yields no renumber pair, so a plain unmount marks nothing missing', () => {
  const { db, dir, root, observe } = verifyFixture()
  try {
    const a = put(join(root.canonicalPath, 'a.md'))
    const onVolume = put(join(root.canonicalPath, 'mnt', 's.md'))
    observe(a); observe(onVolume)
    const real = deviceOf(a)
    const signatureDevice = String(real + 9n)
    const strayDevice = String(real + 4n)
    // a.md: its signature (inode, size, mtime) was taken on device `signatureDevice`, but an earlier probe of a different file at
    // that path left the recorded device at `strayDevice`; today the same file is seen on the root's own device.
    recordOldDevice(db, [a], signatureDevice)
    db.raw.prepare('UPDATE artifacts SET last_seen_device = ? WHERE path = ?').run(strayDevice, a)
    // s.md was last seen on `strayDevice`; its volume is unmounted now, so the folder shows the root's own (other) device.
    recordOldDevice(db, [onVolume], strayDevice)
    rmSync(onVolume)
    verifyExistence(db, { now: iso(Date.now() + 1_000) })
    assert.equal(renumberState(db, root.rootId), null, 'no pair: the recorded device disagrees with the signature\'s device')
    assert.deepEqual([locOf(db, onVolume).existsState, locOf(db, onVolume).verificationState], ['present', 'unverified'], 'the unmounted volume\'s file is not missing')
    assert.equal(locOf(db, a).existsState, 'present')
  } finally {
    db.close(); removeTempDir(dir)
  }
})
