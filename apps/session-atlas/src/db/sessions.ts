import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { AtlasDb } from './database.ts'
import { projectNameFor } from '../util/project-name.ts'

export type SourceClient = 'claude-code' | 'opencode' | 'pi'

/** Why a session is `closed`: a SessionEnd hook arrived ('hook': the end is confirmed), or the idle sweep closed it ('idle': its process may still run). */
export type SessionEndReason = 'hook' | 'idle'

export type SessionRow = {
  sessionId: string; sourceClient: SourceClient; parentSessionId: string | null; rootSessionId: string | null; isSubagent: boolean; agentType: string | null
  title: string; titleSource: 'fallback' | 'native' | 'worker'; summary: string | null; customTitle: string | null
  status: 'active' | 'closed' | 'unknown'; focusState: 'metadata-only' | 'active' | 'inactive'
  focusActivatedAt: string | null; focusActivationSource: string | null
  startCwd: string | null; resumeCwd: string | null; projectName: string | null; transcriptPath: string | null
  supervisorJobId: string | null; startedAt: string; lastActivityAt: string; lastTurnAt: string | null; endedAt: string | null
  createdAt: string; updatedAt: string
}

const SELECT = `SELECT session_id, source_client, parent_session_id, root_session_id, is_subagent, agent_type, title, title_source, summary, custom_title, status,
  focus_state, focus_activated_at, focus_activation_source, start_cwd, resume_cwd, project_name, transcript_path, supervisor_job_id,
  started_at, last_activity_at, last_turn_at, ended_at, created_at, updated_at FROM sessions`

export function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    sessionId: r.session_id as string, sourceClient: r.source_client as SourceClient,
    parentSessionId: (r.parent_session_id as string) ?? null, rootSessionId: (r.root_session_id as string) ?? null,
    isSubagent: r.is_subagent === 1, agentType: (r.agent_type as string) ?? null, title: r.title as string,
    titleSource: r.title_source as SessionRow['titleSource'], summary: (r.summary as string) ?? null, customTitle: (r.custom_title as string) ?? null,
    status: r.status as SessionRow['status'],
    focusState: r.focus_state as SessionRow['focusState'], focusActivatedAt: (r.focus_activated_at as string) ?? null,
    focusActivationSource: (r.focus_activation_source as string) ?? null, startCwd: (r.start_cwd as string) ?? null,
    resumeCwd: (r.resume_cwd as string) ?? null, projectName: (r.project_name as string) ?? null, transcriptPath: (r.transcript_path as string) ?? null,
    supervisorJobId: (r.supervisor_job_id as string) ?? null, startedAt: r.started_at as string, lastActivityAt: r.last_activity_at as string,
    lastTurnAt: (r.last_turn_at as string) ?? null,
    endedAt: (r.ended_at as string) ?? null,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  }
}

export function fallbackTitle(cwd: string | undefined, sessionId: string): string {
  const short = sessionId.startsWith('agent-') ? sessionId.slice(6, 14) : sessionId.slice(0, 8)
  const folder = cwd ? basename(cwd) : ''
  return `${folder || 'session'} · ${short}`
}

export function projectNameFromCwd(cwd: string | undefined): string | null {
  return projectNameFor(cwd)
}

export function getSession(db: AtlasDb, sessionId: string): SessionRow | null {
  const r = db.raw.prepare(`${SELECT} WHERE session_id = ?`).get(sessionId) as Record<string, unknown> | undefined
  return r ? rowToSession(r) : null
}

export type EnsureSessionInput = {
  sessionId: string; parentSessionId?: string; isSubagent?: boolean; agentType?: string
  cwd?: string; transcriptPath?: string; startedAt: string; now: string
}

export function ensureSession(db: AtlasDb, input: EnsureSessionInput): SessionRow {
  const existing = getSession(db, input.sessionId)
  if (existing) {
    touchSession(db, input.sessionId, input.now, { cwd: input.cwd, transcriptPath: input.transcriptPath })
    return getSession(db, input.sessionId)!
  }
  const root = input.parentSessionId ? (getSession(db, input.parentSessionId)?.rootSessionId ?? input.parentSessionId) : input.sessionId
  db.raw.prepare(`INSERT INTO sessions (session_id, parent_session_id, root_session_id, is_subagent, agent_type, title, title_source, status,
    focus_state, start_cwd, resume_cwd, project_name, transcript_path, started_at, last_activity_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'fallback', 'active', 'metadata-only', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.sessionId, input.parentSessionId ?? null, root, input.isSubagent ? 1 : 0, input.agentType ?? null,
      fallbackTitle(input.cwd, input.sessionId), input.cwd ?? null, input.cwd ?? null, projectNameFromCwd(input.cwd),
      input.transcriptPath ?? null, input.startedAt, input.now, input.now, input.now)
  return getSession(db, input.sessionId)!
}

// last_turn_at is deliberately narrower than last_activity_at (spec §5.4): only a caller that
// saw a genuine turn-boundary record passes it, so a bare cwd relocation can bump activity
// without implying the session actually did anything. MAX over COALESCE(...,'') keeps it
// monotonic: an out-of-order record never rewinds the displayed last turn.
export function touchSession(db: AtlasDb, sessionId: string, now: string, patch: { cwd?: string; transcriptPath?: string; lastTurnAt?: string } = {}): void {
  db.raw.prepare(`UPDATE sessions SET last_activity_at = MAX(last_activity_at, ?), updated_at = ?,
    resume_cwd = COALESCE(?, resume_cwd), start_cwd = COALESCE(start_cwd, ?), project_name = COALESCE(project_name, ?),
    transcript_path = COALESCE(?, transcript_path),
    last_turn_at = CASE WHEN ? IS NULL THEN last_turn_at ELSE MAX(COALESCE(last_turn_at, ''), ?) END
    WHERE session_id = ?`)
    .run(now, now, patch.cwd ?? null, patch.cwd ?? null, projectNameFromCwd(patch.cwd), patch.transcriptPath ?? null,
      patch.lastTurnAt ?? null, patch.lastTurnAt ?? null, sessionId)
}

/**
 * A reopened session ('active') has no end and so no end reason. A closed one records why: 'hook' only for a SessionEnd hook,
 * 'idle' for the idle sweep. Closing without a reason leaves NULL, which readers must treat as not confirmed. `endedAt` is when
 * the session ended (default: `now`, the time of the write); a SessionEnd passes its own time so that events written after it can
 * be told from events written before it, however late either is delivered.
 */
export function setSessionStatus(db: AtlasDb, sessionId: string, status: 'active' | 'closed', now: string, endReason: SessionEndReason | null = null, endedAt: string = now): void {
  db.raw.prepare(`UPDATE sessions SET status = ?, ended_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END, end_reason = CASE WHEN ? = 'closed' THEN ? ELSE NULL END,
    updated_at = ? WHERE session_id = ?`)
    .run(status, status, endedAt, status, endReason, now, sessionId)
}

/**
 * A hook event of a session written after the end its SessionEnd confirmed shows that the session's process was still running,
 * so the end is no longer confirmed: end_reason goes back to NULL (a new SessionEnd confirms it again). Nothing else changes: the
 * status stays closed. An event written at or before ended_at (a late-delivered one) proves nothing and leaves it alone, and so
 * does anything that is not a hook event (the transcript job moves last_activity_at after a close). A time that cannot be read
 * cannot be shown to be older, so it withdraws the confirmation. Returns whether it was withdrawn.
 */
export function withdrawEndConfirmation(db: AtlasDb, sessionId: string, eventTs: string): boolean {
  const row = db.raw.prepare(`SELECT ended_at FROM sessions WHERE session_id = ? AND status = 'closed' AND end_reason = 'hook'`).get(sessionId) as { ended_at: string | null } | undefined
  if (!row) return false
  const endedMs = row.ended_at === null ? NaN : Date.parse(row.ended_at)
  const eventMs = Date.parse(eventTs)
  if (Number.isFinite(endedMs) && Number.isFinite(eventMs) && eventMs <= endedMs) return false
  db.raw.prepare(`UPDATE sessions SET end_reason = NULL WHERE session_id = ? AND end_reason = 'hook'`).run(sessionId)
  return true
}

/**
 * Raises sessions.last_hook_event_at to a hook event's own time, monotonically: the latest moment the session's process was seen doing
 * anything other than ending (ruling R89). Delivery order cannot lower it, and no service-time write (ensureSession, the transcript job)
 * touches it. A time that cannot be read counts as `now`, the conservative choice (it can only make a later SessionEnd stale).
 */
export function recordHookActivity(db: AtlasDb, sessionId: string, eventTs: string, now: string): void {
  const ms = Date.parse(eventTs)
  const at = Number.isFinite(ms) ? new Date(ms).toISOString() : now
  db.raw.prepare(`UPDATE sessions SET last_hook_event_at = ? WHERE session_id = ? AND (last_hook_event_at IS NULL OR last_hook_event_at < ?)`).run(at, sessionId, at)
}

/** Whether a SessionEnd written at `endedAt` is older than the latest hook activity of the session: it then proves nothing. NULL (no chronology known) is never stale. */
export function isStaleSessionEnd(db: AtlasDb, sessionId: string, endedAt: string): boolean {
  const row = db.raw.prepare('SELECT last_hook_event_at FROM sessions WHERE session_id = ?').get(sessionId) as { last_hook_event_at: string | null } | undefined
  if (!row || row.last_hook_event_at === null) return false
  const lastMs = Date.parse(row.last_hook_event_at), endMs = Date.parse(endedAt)
  return Number.isFinite(lastMs) && Number.isFinite(endMs) && endMs < lastMs
}

export function setFocusState(db: AtlasDb, sessionId: string, state: 'active' | 'inactive', source: string, now: string): boolean {
  const res = db.raw.prepare(`UPDATE sessions SET focus_state = ?, focus_activated_at = CASE WHEN ? = 'active' THEN ? ELSE focus_activated_at END,
    focus_activation_source = CASE WHEN ? = 'active' THEN ? ELSE focus_activation_source END, updated_at = ?
    WHERE session_id = ? AND focus_state <> ?`).run(state, state, now, state, source, now, sessionId, state)
  return res.changes > 0
}

export function setCustomTitle(db: AtlasDb, sessionId: string, title: string, now: string): void {
  db.raw.prepare(`UPDATE sessions SET custom_title = ?, title = ?, title_source = 'native', updated_at = ? WHERE session_id = ?`)
    .run(title, title, now, sessionId)
}

export function setCustomTitleIfAbsent(db: AtlasDb, sessionId: string, title: string, now: string): boolean {
  const res = db.raw.prepare(`UPDATE sessions SET custom_title = ?, title = ?, title_source = 'native', updated_at = ?
    WHERE session_id = ? AND custom_title IS NULL`).run(title, title, now, sessionId)
  return res.changes > 0
}

export function setNativeTitle(db: AtlasDb, sessionId: string, title: string, now: string): void {
  db.raw.prepare(`UPDATE sessions SET title = ?, title_source = 'native', updated_at = ?
    WHERE session_id = ? AND title_source <> 'worker' AND custom_title IS NULL`)
    .run(title, now, sessionId)
}

export function setWorkerTitleAndSummary(db: AtlasDb, sessionId: string, title: string, summary: string, now: string): void {
  db.raw.prepare(`UPDATE sessions SET title = CASE WHEN custom_title IS NULL THEN ? ELSE title END,
    title_source = CASE WHEN custom_title IS NULL THEN 'worker' ELSE title_source END,
    summary = ?, updated_at = ? WHERE session_id = ?`)
    .run(title, summary, now, sessionId)
}

function transcriptMtimeMs(path: string): number | null {
  try { return statSync(path).mtimeMs } catch { return null }
}

// H5: sessions that never received a SessionEnd hook (backfilled 'unknown' rows, subagents,
// crashed CLIs) close once they have been idle longer than the threshold. A transcript whose
// file mtime is newer than the cutoff is still being written, so it stays open. A later hook
// event flips the session back to 'active' through the normal ingest path.
export function closeIdleSessions(db: AtlasDb, opts: { idleCloseHours: number; now: string; transcriptMtime?: (path: string) => number | null }): number {
  const cutoffMs = Date.parse(opts.now) - opts.idleCloseHours * 3_600_000
  const cutoff = new Date(cutoffMs).toISOString()
  const mtime = opts.transcriptMtime ?? transcriptMtimeMs
  const rows = db.raw.prepare(`SELECT session_id, transcript_path FROM sessions WHERE status IN ('active', 'unknown') AND last_activity_at < ?`).all(cutoff) as Array<{ session_id: string; transcript_path: string | null }>
  let n = 0
  for (const r of rows) {
    const m = r.transcript_path ? mtime(r.transcript_path) : null
    if (m !== null && m >= cutoffMs) continue
    // The sweep only sees that Atlas heard nothing: it never learns that the process exited, so this close is not a confirmed end.
    setSessionStatus(db, r.session_id, 'closed', opts.now, 'idle')
    n += 1
  }
  return n
}
