import { watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import type { AtlasDb } from '../db/database.ts'
import type { Logger } from '../util/log.ts'
import { isIgnoredPath, isTrustedRoot } from './candidates.ts'

// The bounded watcher is a HINT source for the artifact manager (spec s10): at most 40 recently active session folders, no new
// fleet of watchers. A callback only reports what became dirty -- the watched folder and the exact path, or `null` for "the
// whole folder" (a nameless event, an overflow, a watcher error) -- through `onDirty`. It never stats, hashes, runs Git, scans
// a directory or touches SQLite per notification: the artifact manager runner debounces the hints and turns them into bounded
// jobs (exact-path checks, or a scope recovery pass).

export type ArtifactWatcher = {
  syncActiveFolders(): { watching: string[]; added: string[]; removed: string[] }
  watch(folder: string, sessionIds: string[]): boolean
  unwatch(folder: string): void
  folders(): string[]
  close(): void
}

/** Receives a dirty hint: `path` is an exact path under `folder`, or null when the whole folder must be rechecked. */
export type ArtifactDirtySink = (folder: string, path: string | null) => void

type SessionCwds = Map<string, string> // sessionId -> that session's own resume_cwd

const norm = (p: string) => p.replace(/\/+$/, '')

/**
 * Recently active top-level sessions with a cwd, most recent first (the watcher's and the artifact manager's shared source of
 * "active" folders). Subagents share their parent's cwd and are left out.
 */
export function recentSessionFolders(db: AtlasDb, sinceIso: string): Array<{ sessionId: string; cwd: string }> {
  const rows = db.raw.prepare(`SELECT session_id, resume_cwd FROM sessions WHERE status = 'active' AND is_subagent = 0 AND resume_cwd IS NOT NULL AND last_activity_at >= ?
    ORDER BY last_activity_at DESC`).all(sinceIso) as Array<{ session_id: string; resume_cwd: string }>
  return rows.map(r => ({ sessionId: r.session_id, cwd: r.resume_cwd }))
}

export function createWatcher(deps: {
  db: AtlasDb
  log: Logger
  maxFolders?: number
  recentMs?: number
  onDirty?: ArtifactDirtySink
  /** fs.watch, injectable so tests can raise errors and overflows. */
  watchFn?: typeof watch
}): ArtifactWatcher {
  const { db, log } = deps
  const maxFolders = deps.maxFolders ?? 40
  const recentMs = deps.recentMs ?? 6 * 3_600_000
  const onDirty: ArtifactDirtySink = deps.onDirty ?? (() => {})
  const watchFn = deps.watchFn ?? watch
  const active = new Map<string, { watcher: FSWatcher; sessions: SessionCwds }>()

  function onEvent(folder: string, filename: string | null): void {
    try {
      // No name: the platform lost or coalesced events (an overflow). The whole folder is dirty.
      if (!filename) { onDirty(folder, null); return }
      const path = join(folder, filename)
      if (!path.startsWith(folder + sep)) return // defensive guard against a '..'-escaping filename
      if (isIgnoredPath(path)) return // string-only filter: dependency/runtime directories and junk suffixes
      onDirty(folder, path)
    } catch (err) {
      // Never let this synchronous fs.watch callback throw out uncaught and crash the service.
      log.warn('watcher event failed', { folder, error: String(err) })
    }
  }

  // Registers (or merges into) a watch on `folder` for the given sessions. Additive: an existing
  // entry's session set is merged, never replaced — full-replace semantics belong to the sync
  // loop below, which alone knows the definitive desired state for a tick.
  function registerFolder(folder: string, sessions: Array<{ sessionId: string; cwd: string }>): boolean {
    folder = norm(folder)
    const existing = active.get(folder)
    if (existing) { for (const s of sessions) existing.sessions.set(s.sessionId, norm(s.cwd)); return true }
    if (!isTrustedRoot(folder) || isIgnoredPath(folder + sep + 'x')) return false
    try {
      // Linux (R75): Node's recursive fs.watch there is a JavaScript walker that reads the tree on the main thread, and can stall
      // the service for seconds when many files change. macOS uses native FSEvents. See deliverables/2026-10-27/artifact-manager-benchmark-results.md.
      const watcher = watchFn(folder, { recursive: true, persistent: false }, (_event, filename) => onEvent(folder, typeof filename === 'string' ? filename : null))
      watcher.on('error', err => {
        // A watcher error may have lost events: the whole folder is dirty for recovery, and the watch is dropped (the next
        // sync re-creates it).
        log.warn('watcher error; dropping folder', { folder, error: String(err) })
        try { onDirty(folder, null) } catch (e) { log.warn('watcher event failed', { folder, error: String(e) }) }
        unwatch(folder)
      })
      active.set(folder, { watcher, sessions: new Map(sessions.map(s => [s.sessionId, norm(s.cwd)])) })
      return true
    } catch (err) {
      log.warn('cannot watch folder', { folder, error: String(err) })
      return false
    }
  }

  // Public `watch`: a direct caller supplies only session ids, with no independent cwd — treat
  // each session's cwd as the whole watched folder (the pre-existing, documented contract).
  function watchFolder(folder: string, sessionIds: string[]): boolean {
    return registerFolder(folder, sessionIds.map(sessionId => ({ sessionId, cwd: folder })))
  }

  function unwatch(folder: string): void {
    const e = active.get(norm(folder))
    if (!e) return
    try { e.watcher.close() } catch { /* already closed */ }
    active.delete(norm(folder))
  }

  function syncActiveFolders() {
    const since = new Date(Date.now() - recentMs).toISOString()
    const wanted = new Map<string, SessionCwds>()
    for (const r of recentSessionFolders(db, since)) {
      const f = norm(r.cwd)
      if (!isTrustedRoot(f) || isIgnoredPath(f + sep + 'x')) continue
      const parent = [...wanted.keys()].find(w => f === w || f.startsWith(w + sep))
      if (parent) { wanted.get(parent)!.set(r.sessionId, f); continue }
      // f is an ancestor of one or more already-chosen folders (they were picked first because
      // their session had newer activity) — collapse those descendants' WATCHES into f, while
      // keeping each session's own cwd intact.
      const descendants = [...wanted.keys()].filter(w => w.startsWith(f + sep))
      if (descendants.length > 0) {
        const merged: SessionCwds = new Map([[r.sessionId, f]])
        for (const d of descendants) { for (const [sid, cwd] of wanted.get(d)!) merged.set(sid, cwd); wanted.delete(d) }
        wanted.set(f, merged)
        continue
      }
      if (wanted.size >= maxFolders) continue
      wanted.set(f, new Map([[r.sessionId, f]]))
    }
    const removed: string[] = []
    for (const f of [...active.keys()]) if (!wanted.has(f)) { unwatch(f); removed.push(f) }
    const added: string[] = []
    for (const [f, sessions] of wanted) {
      if (active.has(f)) { active.get(f)!.sessions = sessions; continue } // sync is authoritative: full replace
      if (registerFolder(f, [...sessions].map(([sessionId, cwd]) => ({ sessionId, cwd })))) added.push(f)
    }
    return { watching: [...active.keys()], added, removed }
  }

  return { syncActiveFolders, watch: watchFolder, unwatch, folders: () => [...active.keys()], close: () => { for (const f of [...active.keys()]) unwatch(f) } }
}
