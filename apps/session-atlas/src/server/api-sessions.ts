// The two session routes the worktree removal check reads (src/cli/artifacts.ts, createSessionProbe). They serve the cache.db
// `sessions` table, which the ledger mirror fills (src/mirror/session-mirror.ts). There is no session list for people here: the
// sessions view returns later, built on the ledger (JP-94, after the ledger is hardened).
import { isValidSessionId } from '../ingest/event.ts'
import type { AtlasDb } from '../db/database.ts'
import { getSession } from '../db/sessions.ts'
import { HttpError, type Router } from './http.ts'
import type { Logger } from '../util/log.ts'
import { qs } from './query.ts'

// A closed session's end is confirmed only when the ledger holds the session's own end (end_reason 'hook' here), or when it is a
// subagent whose root session was closed by one and the subagent shows no activity after that end. A NULL reason says nothing.
// COALESCE keeps the expression two-valued so NOT (...) is never NULL.
const END_CONFIRMED_SQL = `(s.status = 'closed' AND (COALESCE(s.end_reason, '') = 'hook' OR (s.is_subagent = 1 AND EXISTS
  (SELECT 1 FROM sessions root WHERE root.session_id = s.root_session_id AND root.status = 'closed' AND root.end_reason = 'hook'
    AND NOT (s.last_hook_event_at IS NOT NULL AND root.ended_at IS NOT NULL AND s.last_hook_event_at > root.ended_at)))))`

const STATUSES = new Set(['active', 'closed', 'unknown'])

function parseEndConfirmed(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  if (raw !== 'true' && raw !== 'false') throw new HttpError(400, `invalid endConfirmed: ${raw}`)
  return raw === 'true'
}

export function registerSessionRoutes(router: Router, deps: { db: AtlasDb; log: Logger }): void {
  const { db } = deps

  router.add('GET', '/api/sessions', ctx => {
    const q = qs(ctx.url)
    const status = q.str('status')
    if (status !== undefined && !STATUSES.has(status)) throw new HttpError(400, `invalid status: ${status}`)
    const endConfirmed = parseEndConfirmed(q.str('endConfirmed'))
    const where: string[] = []
    const params: Array<string | number> = []
    if (status) { where.push('s.status = ?'); params.push(status) }
    if (!q.bool('includeSubagents')) where.push('s.is_subagent = 0')
    if (endConfirmed !== undefined) where.push(endConfirmed ? END_CONFIRMED_SQL : `NOT ${END_CONFIRMED_SQL}`)
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { limit, offset } = q.page()
    const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions s ${clause}`).get(...params) as { n: number }).n
    const rows = (db.raw.prepare(`SELECT s.session_id, s.status, s.start_cwd, s.resume_cwd, s.end_reason, s.is_subagent, s.parent_session_id,
        s.title, s.started_at, s.last_activity_at, ${END_CONFIRMED_SQL} AS end_confirmed
      FROM sessions s ${clause} ORDER BY s.last_activity_at DESC, s.session_id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, unknown>>).map(r => ({
      sessionId: r.session_id, status: r.status, startCwd: r.start_cwd ?? null, resumeCwd: r.resume_cwd ?? null,
      endReason: (r.end_reason as string | null) ?? null, endConfirmed: r.end_confirmed === 1, isSubagent: r.is_subagent === 1,
      parentSessionId: r.parent_session_id ?? null, title: r.title, startedAt: r.started_at, lastActivityAt: r.last_activity_at,
    }))
    ctx.send(200, { rows, total, limit, offset })
  })

  router.add('GET', '/api/sessions/:id', ctx => {
    const id = ctx.params.id!
    if (!isValidSessionId(id)) throw new HttpError(400, 'invalid session id')
    const session = getSession(db, id)
    if (!session) throw new HttpError(404, 'session not found')
    ctx.send(200, { session })
  })
}
