import { lstatSync, opendirSync, readdirSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AtlasDb } from '../db/database.ts'
import { setExistsState } from '../db/artifacts.ts'
import {
  artifactSignatureDevice, artifactSignatureIsSameFile, readArtifactRootRenumbers, recordArtifactRootRenumber, type ArtifactRootRenumber,
} from '../db/artifact-manager.ts'
import { getSession } from '../db/sessions.ts'
import { isIgnoredPath, isTrustedRoot, recordCandidate } from './candidates.ts'

const WINDOW_TAIL_MS = 60_000

export function reconcileSession(db: AtlasDb, sessionId: string, opts: { now: string; maxEntries?: number; maxDepth?: number }): { scanned: number; candidates: number; capped: boolean } {
  const maxEntries = opts.maxEntries ?? 5000, maxDepth = opts.maxDepth ?? 4
  const session = getSession(db, sessionId)
  const root = session?.resumeCwd?.replace(/\/+$/, '')
  if (!session || !root || !isTrustedRoot(root)) return { scanned: 0, candidates: 0, capped: false }
  const start = Date.parse(session.startedAt), end = Date.parse(session.lastActivityAt) + WINDOW_TAIL_MS
  // Fail closed: an unparseable timestamp makes every "<"/">" comparison false below, which
  // would otherwise walk the whole folder and record every file as a candidate.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { scanned: 0, candidates: 0, capped: false }
  const known = new Set((db.raw.prepare(`SELECT a.path FROM artifacts a JOIN artifact_origins o ON o.artifact_id = a.artifact_id WHERE o.session_id = ?`).all(sessionId) as Array<{ path: string }>).map(r => r.path))

  // Walk the filesystem entirely outside any db.transaction: readdirSync/lstatSync on up to
  // 5000 entries must never hold the writer lock, which would otherwise block the hook
  // endpoint/spool/watcher for the whole walk. Collect the matching paths, then take one short
  // transaction just for the recordCandidate inserts.
  let scanned = 0, capped = false
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  walk: while (queue.length) {
    const { dir, depth } = queue.shift()!
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (++scanned > maxEntries) { capped = true; break walk }
      const path = join(dir, e.name)
      if (isIgnoredPath(path)) continue
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { if (depth + 1 <= maxDepth) queue.push({ dir: path, depth: depth + 1 }); continue }
      if (!e.isFile() || known.has(path)) continue
      let st
      try { st = lstatSync(path) } catch { continue }
      const birth = st.birthtimeMs || st.ctimeMs
      if (birth < start || birth > end) continue
      found.push(path)
    }
  }

  let candidates = 0
  if (found.length > 0) {
    db.transaction(() => {
      for (const path of found) {
        if (recordCandidate(db, { path, sessionId, detectedVia: 'reconcile', observedAt: opts.now })) candidates += 1
      }
    })
  }
  return { scanned, candidates, capped }
}

// ------------------------------------------------------------------------------------------------ known-location verification
//
// Spec s6 and ruling R72: ONE proof decides that a known location is missing, for the verifier, the direct-check handler and
// the location action routes alike (probeKnownLocation). lstat succeeding on something that is not a regular file is
// missing; otherwise only ENOENT/ENOTDIR counts, and only when the nearest existing ancestor folder lives on the device the
// location was last seen present on (the recorded device: last_seen_device, else its stat signature's), so an unmounted
// volume or mount point never makes its files missing. An active registered root must also still be its own folder (a
// root that vanished is disconnected, AC-11/AC-12). Fallbacks: a device renumbered since (APFS external volumes, btrfs or
// overlay remounts) is accepted when another location of the same root, recorded on the location's own device, was seen
// present on the anchor's device: in the same verifier run, or earlier by any check or scan (the root's persisted renumber
// evidence, R73; chains of renumbers are followed; only the same file, by inode, size and mtime, is evidence: R74.3). A location with no recorded device (legacy rows) needs a nearest existing
// ancestor that is a non-empty folder not a mount point, or a regular file (a file where a folder of the path was is proof
// too); a sighting records its device. Everything else is "unverified": exists_state and last_verified_at (the verification
// age) stay, verification_state becomes 'unverified', and the verifier and the direct-check handler record a path-free reason
// token (`verify.last-unverified`) and a counter (`health.verify-unverified`). Unverified locations are rechecked in
// rotation, at most a quarter of each run, so they never starve the rest.

/** A known location with what its proof needs: the recorded devices and its registered root. */
export type KnownLocation = {
  artifact_id: number; path: string; exists_state: string; verification_state: string | null; observation_signature: string | null
  last_seen_device: string | null; root_id: string | null; root_path: string | null; root_active: number | null
}
/** What one check proved. `anchorDevice`: the only obstacle was a device other than the recorded one (see the fallback). */
export type LocationProbe =
  | { state: 'present'; size: number; device: string; ino: string; mtimeMs: number }
  | { state: 'missing' }
  | { state: 'unverified'; reason: string; anchorDevice?: string }
export type VerifyLstat = (path: string) => BigIntStats
/** Names in a folder; the proof only asks whether there is one, so the default reads at most one entry (readFirstEntry). */
export type VerifyReaddir = (path: string) => string[]
type VerifyCandidate = KnownLocation

const VERIFY_SELECT = `SELECT a.artifact_id, a.path, a.exists_state, a.verification_state, a.observation_signature, a.last_seen_device, a.root_id,
    r.canonical_path AS root_path, r.active AS root_active
  FROM artifacts a LEFT JOIN artifact_roots r ON r.root_id = a.root_id`
const UNVERIFIED_CURSOR_KEY = 'verify.unverified-after'
const ERRNO_RE = /^E[A-Z0-9_]{1,31}$/
/** Path-free reason tokens: an errno, or one of these. root-unreachable means exactly that the active root is not its folder. */
const REASONS = new Set(['root-unreachable', 'device-changed', 'device-unknown', 'path-changed'])
/** A location's verification state once a check settled it: verified with a version, pending without one, legacy NULL. */
const SETTLED_VERIFICATION = `CASE WHEN current_version_id IS NOT NULL THEN 'verified' WHEN document_id IS NOT NULL THEN 'pending' ELSE NULL END`
const defaultLstat: VerifyLstat = path => lstatSync(path, { bigint: true })
/** The first entry of a folder (or none), read through a directory handle that is always closed: never the whole listing. */
export function readFirstEntry(path: string): string[] {
  const dir = opendirSync(path)
  try {
    const entry = dir.readSync()
    return entry === null ? [] : [entry.name]
  } finally {
    dir.closeSync()
  }
}
const defaultReaddir: VerifyReaddir = readFirstEntry

const errnoOf = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}
const unverified = (reason: string | null, anchorDevice?: string): LocationProbe => ({
  state: 'unverified', reason: reason !== null && (ERRNO_RE.test(reason) || REASONS.has(reason)) ? reason : 'error', ...(anchorDevice !== undefined ? { anchorDevice } : {}),
})

/** The device a check or observation last saw this location present on, or null. */
function recordedDevice(loc: Pick<KnownLocation, 'last_seen_device' | 'observation_signature'>): string | null {
  if (loc.last_seen_device !== null && /^\d{1,40}$/.test(loc.last_seen_device)) return loc.last_seen_device
  return artifactSignatureDevice(loc.observation_signature)
}

/** Whether renumber evidence leads from device `from` to device `to` (directly or through a chain of pairs). */
function renumberLeads(pairs: readonly Pick<ArtifactRootRenumber, 'from' | 'to'>[], from: string, to: string): boolean {
  const seen = new Set([from])
  const queue = [from]
  while (queue.length > 0) {
    const d = queue.shift()!
    for (const p of pairs) {
      if (p.from !== d || seen.has(p.to)) continue
      if (p.to === to) return true
      seen.add(p.to)
      queue.push(p.to)
    }
  }
  return false
}

/**
 * The renumber a present probe shows (R73), or null. Only the SAME file seen on another device counts (R74.3): its inode, size
 * and mtime must match its stat signature (a real renumber keeps inode numbers on APFS, btrfs and NFS). A different file at the
 * same path, such as a stray file written into a bare mount point, says nothing about the volume.
 */
function renumberShown(loc: KnownLocation, probe: LocationProbe): { from: string; to: string } | null {
  if (probe.state !== 'present') return null
  const from = recordedDevice(loc)
  if (from === null || from === probe.device) return null
  // The inode, size and mtime that matched were taken on the signature's own device. A recorded device that differs from it was
  // left by another probe (possibly of a different file at the path), so the pair would lead from a device this file was never
  // proven on: no evidence. This also drops chain evidence from files verified on an intermediate device (fails closed).
  if (from !== artifactSignatureDevice(loc.observation_signature)) return null
  return artifactSignatureIsSameFile(loc.observation_signature, { ino: probe.ino, size: probe.size, mtimeMs: probe.mtimeMs }) ? { from, to: probe.device } : null
}

/** R72(c)/R73: an unverified probe whose only obstacle was a renumbered device, proven by the root's evidence, is missing. */
function vouchedMissing(loc: KnownLocation, probe: LocationProbe, pairs: (rootId: string) => readonly Pick<ArtifactRootRenumber, 'from' | 'to'>[]): boolean {
  const anchor = probe.state === 'unverified' ? probe.anchorDevice : undefined
  const recorded = recordedDevice(loc)
  return anchor !== undefined && loc.root_id !== null && recorded !== null && renumberLeads(pairs(loc.root_id), recorded, anchor)
}

/** The nearest ancestor of `path` that exists (lstat), or why none could be read. */
function nearestExisting(path: string, lstat: VerifyLstat): { dir: string; st: BigIntStats } | { error: string | null } {
  let dir = dirname(path)
  for (;;) {
    try {
      return { dir, st: lstat(dir) }
    } catch (e) {
      const code = errnoOf(e)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { error: code }
    }
    const up = dirname(dir)
    if (up === dir) return { error: 'root-unreachable' }
    dir = up
  }
}

/** Without a recorded device: a non-empty folder on its parent's filesystem (not a mount point, mounted or left behind). */
function provenWithoutDevice(anchor: { dir: string; st: BigIntStats }, lstat: VerifyLstat, readdir: VerifyReaddir): boolean {
  if (!anchor.st.isDirectory()) return anchor.st.isFile()
  try {
    if (readdir(anchor.dir).length === 0) return false
    return lstat(dirname(anchor.dir)).dev === anchor.st.dev
  } catch {
    return false
  }
}

/** What one check of a known location proves (R72). Pure filesystem reads; writes nothing. */
export function probeKnownLocation(loc: KnownLocation, fs: { lstat?: VerifyLstat; readdir?: VerifyReaddir } = {}): LocationProbe {
  const lstat = fs.lstat ?? defaultLstat
  const readdir = fs.readdir ?? defaultReaddir
  let st: BigIntStats
  try {
    st = lstat(loc.path)
  } catch (e) {
    const code = errnoOf(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return unverified(code)
    if (loc.root_path !== null && loc.root_active === 1) {
      // An active registered root that is no longer its own folder is disconnected (an unmounted or moved volume).
      try { if (!lstat(loc.root_path).isDirectory()) return unverified('root-unreachable') } catch { return unverified('root-unreachable') }
    }
    const anchor = nearestExisting(loc.path, lstat)
    if ('error' in anchor) return unverified(anchor.error)
    if (anchor.st.isSymbolicLink()) return unverified('path-changed')
    const device = recordedDevice(loc)
    if (device === null) return provenWithoutDevice(anchor, lstat, readdir) ? { state: 'missing' } : unverified('device-unknown')
    const anchorDevice = String(anchor.st.dev)
    return anchorDevice === device ? { state: 'missing' } : unverified('device-changed', anchorDevice)
  }
  // lstat, never stat: a file replaced by a symlink (or anything not a regular file) is not that file: missing.
  return st.isFile() ? { state: 'present', size: Number(st.size), device: String(st.dev), ino: String(st.ino), mtimeMs: Number(st.mtimeNs / 1_000_000n) } : { state: 'missing' }
}

/** What the root-level proof says about an auto-registered root's own folder (R73.2). */
export type RootFolderProbe =
  | { state: 'present'; device: string; empty: boolean }
  | { state: 'gone' }
  | { state: 'unverified'; reason: string }

/**
 * The same proof as for a location, applied to a root's own folder (R73.2): `gone` only for ENOENT/ENOTDIR on the root path
 * with the nearest existing ancestor (not a symlink, and not itself a mount point: R74.1) on the device the root was recorded
 * on. No recorded device, any other errno, another device (an unmounted volume whose mount point went with it) or a root path
 * that is not a folder proves nothing. `present` reports the folder's device and whether it is empty (an empty folder may be
 * a mount point left behind).
 */
export function probeRootFolder(path: string, recordedDevice: string | null, fs: { lstat?: VerifyLstat; readdir?: VerifyReaddir } = {}): RootFolderProbe {
  const lstat = fs.lstat ?? defaultLstat
  const readdir = fs.readdir ?? defaultReaddir
  let st: BigIntStats
  try {
    st = lstat(path)
  } catch (e) {
    const code = errnoOf(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { state: 'unverified', reason: code !== null && ERRNO_RE.test(code) ? code : 'error' }
    if (recordedDevice === null) return { state: 'unverified', reason: 'device-unknown' }
    const anchor = nearestExisting(path, lstat)
    if ('error' in anchor) return { state: 'unverified', reason: anchor.error !== null && (ERRNO_RE.test(anchor.error) || REASONS.has(anchor.error)) ? anchor.error : 'error' }
    if (anchor.st.isSymbolicLink()) return { state: 'unverified', reason: 'path-changed' }
    if (String(anchor.st.dev) !== recordedDevice) return { state: 'unverified', reason: 'device-changed' }
    // R74.1: an anchor that is itself a mount point (its device differs from its parent's) is no proof: another filesystem
    // mounted there may reuse the device number the root was recorded on. (Cost: a folder deleted directly at a volume's top
    // level stays disconnected.)
    const above = dirname(anchor.dir)
    if (above !== anchor.dir) {
      try {
        if (lstat(above).dev !== anchor.st.dev) return { state: 'unverified', reason: 'mount-point' }
      } catch {
        return { state: 'unverified', reason: 'error' }
      }
    }
    return { state: 'gone' }
  }
  if (!st.isDirectory()) return { state: 'unverified', reason: 'path-changed' }
  let empty = true
  try { empty = readdir(path).length === 0 } catch { /* unreadable: treated as empty, so its device is never re-recorded from it */ }
  return { state: 'present', device: String(st.dev), empty }
}

/** One known location by artifact ID, with its root, or null. */
export function knownLocation(db: Pick<AtlasDb, 'raw'>, artifactId: number): KnownLocation | null {
  return (db.raw.prepare(`${VERIFY_SELECT} WHERE a.artifact_id = ?`).get(artifactId) as KnownLocation | undefined) ?? null
}

/** Writes what a probe proved about a location: present (recording its device), missing, or (when asked) unverified. */
function applyProbe(db: AtlasDb, loc: KnownLocation, probe: LocationProbe, now: string, recordUnverified: boolean): void {
  if (probe.state === 'unverified') {
    if (recordUnverified) db.raw.prepare(`UPDATE artifacts SET verification_state = 'unverified' WHERE artifact_id = ? AND verification_state IS NOT 'unverified'`).run(loc.artifact_id)
    return
  }
  const present = probe.state === 'present'
  // Only a real file's size is recorded; a symlink's own lstat size must never overwrite the last-known real size
  // (setExistsState COALESCEs null to keep the stored value).
  setExistsState(db, loc.artifact_id, present ? 'present' : 'missing', present ? probe.size : null, now)
  if (present && recordedDevice(loc) !== probe.device) {
    db.raw.prepare('UPDATE artifacts SET last_seen_device = ? WHERE artifact_id = ?').run(probe.device, loc.artifact_id)
    // R73: the same file seen on another device than recorded: the root's volume was renumbered (old -> new), kept for later
    // checks (R74.3: a different file at the path is no such evidence).
    const pair = renumberShown(loc, probe)
    if (pair !== null && loc.root_id !== null) recordArtifactRootRenumber(db, loc.root_id, pair.from, pair.to, now)
  }
  if (loc.verification_state === 'unverified') db.raw.prepare(`UPDATE artifacts SET verification_state = ${SETTLED_VERIFICATION} WHERE artifact_id = ?`).run(loc.artifact_id)
}

/**
 * A single on-demand check (the direct-check handler and the location action routes): records a proven absence (or a
 * presence) and, with `recordUnverified`, an unverified result; a route passes false and answers without writing. Returns the
 * probe, or null for an unknown location.
 */
export function recheckKnownLocation(db: AtlasDb, artifactId: number, now: string, opts: { recordUnverified: boolean; lstat?: VerifyLstat; readdir?: VerifyReaddir }): LocationProbe | null {
  const loc = knownLocation(db, artifactId)
  if (loc === null) return null
  let probe = probeKnownLocation(loc, opts)
  if (vouchedMissing(loc, probe, rootId => readArtifactRootRenumbers(db, rootId))) probe = { state: 'missing' }
  const settled = probe
  db.transaction(() => {
    applyProbe(db, loc, settled, now, opts.recordUnverified)
    if (settled.state === 'unverified' && opts.recordUnverified) noteUnverified(db, 1, settled.reason, now)
  })
  return probe
}

/** The path-free token of the last unverified result and the running counter (verifier and direct checks alike). */
function noteUnverified(db: AtlasDb, count: number, reason: string, now: string): void {
  db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES ('verify.last-unverified', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(reason, now)
  db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES ('health.verify-unverified', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT), updated_at = excluded.updated_at`).run(String(count), now)
}

/** Up to `limit` locations: unverified ones in rotation (at most a quarter), then the least recently verified others. */
function verifyCandidates(db: AtlasDb, limit: number): { candidates: VerifyCandidate[]; after: number } {
  const share = Math.max(1, Math.floor(limit / 4))
  const after = Number((db.raw.prepare('SELECT value FROM artifact_manager_state WHERE key = ?').get(UNVERIFIED_CURSOR_KEY) as { value: string } | undefined)?.value ?? 0) || 0
  const rotation = db.raw.prepare(`${VERIFY_SELECT} WHERE a.verification_state = 'unverified' AND a.artifact_id > ? ORDER BY a.artifact_id LIMIT ?`)
  let retry = rotation.all(after, share) as VerifyCandidate[]
  if (retry.length < share && after > 0) {
    // Wrap around for the rest of this run's share.
    const seen = new Set(retry.map(r => r.artifact_id))
    retry = [...retry, ...(rotation.all(0, share - retry.length) as VerifyCandidate[]).filter(r => !seen.has(r.artifact_id))]
  }
  const rest = db.raw.prepare(`${VERIFY_SELECT} WHERE a.verification_state IS NOT 'unverified' ORDER BY COALESCE(a.last_verified_at, '') ASC LIMIT ?`).all(limit - retry.length) as VerifyCandidate[]
  return { candidates: [...retry, ...rest], after }
}

export function verifyExistence(db: AtlasDb, opts: { now: string; limit?: number; lstat?: VerifyLstat; readdir?: VerifyReaddir }): { checked: number; missing: number; restored: number; unverified: number } {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 200))
  const { candidates, after } = verifyCandidates(db, limit)
  // Every filesystem check happens before the one short write transaction below.
  const probes = candidates.map(c => ({ c, probe: probeKnownLocation(c, opts) }))
  // R72/R73 fallback for a renumbered device: another location of the same root, recorded on the SAME device as this one, seen
  // present on the anchor's current device (in this run, or earlier: the root's persisted evidence) shows that filesystem is
  // mounted again under a new number and the anchor is on it. (A sibling recorded on another device proves nothing: a nested
  // mount point sits on the root's own filesystem, so its siblings there would vouch for the empty mount-point folder.)
  const inRun = new Map<string, Array<{ from: string; to: string }>>()
  for (const { c, probe } of probes) {
    const pair = renumberShown(c, probe)
    if (pair !== null && c.root_id !== null) inRun.set(c.root_id, [...(inRun.get(c.root_id) ?? []), pair])
  }
  const persisted = new Map<string, ArtifactRootRenumber[]>()
  const pairs = (rootId: string) => {
    if (!persisted.has(rootId)) persisted.set(rootId, readArtifactRootRenumbers(db, rootId))
    return [...(inRun.get(rootId) ?? []), ...persisted.get(rootId)!]
  }
  for (const p of probes) if (vouchedMissing(p.c, p.probe, pairs)) p.probe = { state: 'missing' }
  let missing = 0, restored = 0, unverifiedCount = 0
  let lastReason: string | null = null
  db.transaction(() => {
    for (const { c, probe } of probes) {
      if (probe.state === 'unverified') {
        unverifiedCount += 1
        lastReason = probe.reason
      } else {
        if (probe.state === 'missing' && c.exists_state === 'present') missing += 1
        if (probe.state === 'present' && c.exists_state === 'missing') restored += 1
      }
      applyProbe(db, c, probe, opts.now, true)
    }
    // The rotation resumes after the last unverified location this run rechecked (candidates list them first, in order).
    const rotated = candidates.filter(c => c.verification_state === 'unverified')
    const cursor = rotated.at(-1)?.artifact_id ?? 0
    const state = db.raw.prepare(`INSERT INTO artifact_manager_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    if (cursor !== after) state.run(UNVERIFIED_CURSOR_KEY, String(cursor), opts.now)
    if (unverifiedCount > 0) noteUnverified(db, unverifiedCount, lastReason ?? 'error', opts.now)
  })
  return { checked: candidates.length, missing, restored, unverified: unverifiedCount }
}
