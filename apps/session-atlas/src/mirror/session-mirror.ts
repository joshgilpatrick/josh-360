// The one data-access layer between the ledger and the artifact catalog (JP-111).
//
// The artifact manager and the worktree removal check need to know which sessions exist, where they ran and whether they have
// ended. That is the ledger's `sessions` and `session_episodes` (ledger.db, written only by the Python recorder). This module
// opens ledger.db READ-ONLY and copies what they need into cache.db's `sessions` table, which the catalog's foreign keys point at.
// cache.db is rebuildable working state, so the copy may be deleted and made again.
//
// Rules: it never writes ledger.db; it never deletes a cache.db session (the catalog's keys cascade from it) and updates with
// ON CONFLICT DO UPDATE, never INSERT OR REPLACE; and it never reports a session as safely over unless the ledger holds the
// session's own end ("session-end"). Anything else is `closed` with end reason `idle` (not confirmed) or `active`.
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AtlasDb } from '../db/database.ts'
import { projectNameFor } from '../util/project-name.ts'
import { nowIso } from '../util/time.ts'

export const IDLE_CLOSE_HOURS = 12

type LedgerRow = {
  tool_session_id: string; started_at: string; start_folder: string | null; transcript_path: string | null
  episode_folder: string | null; episode_last_activity_at: string | null; episode_quiet_at: string | null
  episode_end_reason: string | null; title: string | null; title_source: string | null
  parent_tool_id: string | null; root_tool_id: string | null; lineage_kind: string | null
}

export type MirrorResult = { read: number; written: number } | null

const TITLE_SOURCE: Record<string, 'native' | 'worker' | 'fallback'> = { custom: 'native', 'agent-name': 'native', tool: 'native', ai: 'worker', fallback: 'fallback' }

const QUERY = `
SELECT s.tool_session_id, s.started_at, s.start_folder, s.transcript_path,
       e.folder AS episode_folder, e.last_activity_at AS episode_last_activity_at, e.quiet_at AS episode_quiet_at,
       e.end_reason AS episode_end_reason, e.title AS title, e.title_source AS title_source,
       p.tool_session_id AS parent_tool_id, r.tool_session_id AS root_tool_id, l.kind AS lineage_kind
FROM sessions s
LEFT JOIN current_session_episodes e ON e.session_uid = s.session_uid
  AND e.episode = (SELECT MAX(e2.episode) FROM current_session_episodes e2 WHERE e2.session_uid = s.session_uid)
LEFT JOIN session_lineage l ON l.child_uid = s.session_uid
LEFT JOIN sessions p ON p.session_uid = l.parent_uid
LEFT JOIN sessions r ON r.session_uid = l.root_uid
WHERE s.tool = 'claude-code'
GROUP BY s.session_uid`

/** Open the ledger read-only, or null when it does not exist yet or cannot be read. Unknown is not empty: callers skip the pass. */
export function openFacts(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('SELECT 1 FROM sessions LIMIT 1').get()
    return db
  } catch {
    return null
  }
}

function mtimeIso(path: string | null): string | null {
  if (!path) return null
  try { return statSync(path).mtime.toISOString() } catch { return null }
}

/** The status the removal check will see. Only the ledger's own session end confirms that a session is over. */
export function statusFor(row: LedgerRow, nowMs: number, idleCloseHours = IDLE_CLOSE_HOURS): { status: 'active' | 'closed'; endReason: 'hook' | 'idle' | null; endedAt: string | null; lastActivityAt: string } {
  const fileMtime = mtimeIso(row.transcript_path)
  const candidates = [row.started_at, row.episode_last_activity_at, fileMtime].filter((v): v is string => !!v)
  const lastActivityAt = candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
  const confirmedEnd = row.episode_end_reason === 'session-end' && row.episode_quiet_at
  if (confirmedEnd && Date.parse(lastActivityAt) <= Date.parse(row.episode_quiet_at as string)) {
    return { status: 'closed', endReason: 'hook', endedAt: row.episode_quiet_at, lastActivityAt }
  }
  const idleMs = idleCloseHours * 3_600_000
  if (nowMs - Date.parse(lastActivityAt) > idleMs) return { status: 'closed', endReason: 'idle', endedAt: lastActivityAt, lastActivityAt }
  return { status: 'active', endReason: null, endedAt: null, lastActivityAt }
}

export function mirrorSessions(db: AtlasDb, factsPath: string, opts: { now?: string; idleCloseHours?: number } = {}): MirrorResult {
  const facts = openFacts(factsPath)
  if (!facts) return null
  const now = opts.now ?? nowIso()
  const nowMs = Date.parse(now)
  try {
    const rows = facts.prepare(QUERY).all() as unknown as LedgerRow[]
    const upsert = db.raw.prepare(`INSERT INTO sessions (session_id, parent_session_id, root_session_id, is_subagent, title, title_source, status,
        start_cwd, resume_cwd, project_name, transcript_path, started_at, last_activity_at, ended_at, end_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, root_session_id = excluded.root_session_id,
        is_subagent = excluded.is_subagent, title = excluded.title, title_source = excluded.title_source, status = excluded.status,
        start_cwd = excluded.start_cwd, resume_cwd = excluded.resume_cwd, project_name = excluded.project_name,
        transcript_path = excluded.transcript_path, last_activity_at = excluded.last_activity_at, ended_at = excluded.ended_at,
        end_reason = excluded.end_reason, updated_at = excluded.updated_at`)
    let written = 0
    db.transaction(() => {
      for (const r of rows) {
        const st = statusFor(r, nowMs, opts.idleCloseHours)
        const cwd = r.episode_folder ?? r.start_folder
        const title = r.title ?? `${cwd ? cwd.split('/').filter(Boolean).pop() ?? 'session' : 'session'} · ${r.tool_session_id.slice(0, 8)}`
        const source = r.title ? (TITLE_SOURCE[r.title_source ?? ''] ?? 'fallback') : 'fallback'
        upsert.run(r.tool_session_id, r.parent_tool_id, r.root_tool_id ?? r.tool_session_id, r.lineage_kind === 'subagent' ? 1 : 0,
          title, source, st.status, r.start_folder, cwd, projectNameFor(cwd ?? undefined), r.transcript_path, r.started_at,
          st.lastActivityAt, st.endedAt, st.endReason, now, now)
        written += 1
      }
    })
    return { read: rows.length, written }
  } finally {
    facts.close()
  }
}

export function mirrorRunner(deps: { db: AtlasDb; factsPath: string; log: { warn(m: string, f?: Record<string, unknown>): void; info(m: string, f?: Record<string, unknown>): void }; intervalMs?: number }) {
  const intervalMs = deps.intervalMs ?? 60_000
  let last = 0
  return {
    name: 'session-mirror',
    async run(): Promise<boolean> {
      if (Date.now() - last < intervalMs) return false
      last = Date.now()
      const res = mirrorSessions(deps.db, deps.factsPath)
      if (res === null) deps.log.warn('ledger.db not readable; session mirror skipped this pass')
      return false
    },
  }
}
