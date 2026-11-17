import type { AtlasDb } from '../../src/db/database.ts'

export type JobKind = 'focus' | 'transcript' | 'artifacts'
export type JobState = 'pending' | 'running' | 'done' | 'quarantined'
export type WorkerJob = {
  sessionId: string; kind: JobKind; state: JobState; inputRevision: number; runningRevision: number | null
  attempts: number; nextAttemptAt: string; startedAt: string | null; lastErrorCategory: string | null; lastErrorAt: string | null; updatedAt: string
}

function rowToJob(r: Record<string, unknown>): WorkerJob {
  return {
    sessionId: r.session_id as string, kind: r.kind as JobKind, state: r.state as JobState, inputRevision: r.input_revision as number,
    runningRevision: (r.running_revision as number) ?? null, attempts: r.attempts as number, nextAttemptAt: r.next_attempt_at as string,
    startedAt: (r.started_at as string) ?? null, lastErrorCategory: (r.last_error_category as string) ?? null,
    lastErrorAt: (r.last_error_at as string) ?? null, updatedAt: r.updated_at as string,
  }
}

export function enqueueJob(db: AtlasDb, sessionId: string, kind: JobKind, inputRevision: number, now: string): void {
  db.raw.prepare(`INSERT INTO worker_jobs (session_id, kind, state, input_revision, attempts, next_attempt_at, updated_at)
    VALUES (?, ?, 'pending', ?, 0, ?, ?)
    ON CONFLICT(session_id, kind) DO UPDATE SET
      input_revision = MAX(worker_jobs.input_revision, excluded.input_revision),
      state = CASE WHEN worker_jobs.state = 'running' THEN 'running' ELSE 'pending' END,
      attempts = CASE WHEN worker_jobs.state IN ('done','quarantined') THEN 0 ELSE worker_jobs.attempts END,
      next_attempt_at = CASE WHEN worker_jobs.state IN ('done','quarantined') THEN excluded.next_attempt_at ELSE worker_jobs.next_attempt_at END,
      updated_at = excluded.updated_at`).run(sessionId, kind, inputRevision, now, now)
}

export function enqueueFocusJob(db: AtlasDb, sessionId: string, inputRevision: number, now: string): void {
  enqueueJob(db, sessionId, 'focus', inputRevision, now)
}

export function claimNextJob(db: AtlasDb, now: string, kind?: JobKind): WorkerJob | null {
  return db.transaction(() => {
    const row = db.raw.prepare(`SELECT * FROM worker_jobs WHERE state = 'pending' AND next_attempt_at <= ? AND (? IS NULL OR kind = ?)
      ORDER BY next_attempt_at ASC LIMIT 1`).get(now, kind ?? null, kind ?? null) as Record<string, unknown> | undefined
    if (!row) return null
    db.raw.prepare(`UPDATE worker_jobs SET state = 'running', running_revision = input_revision, started_at = ?, attempts = attempts + 1, updated_at = ?
      WHERE session_id = ? AND kind = ?`).run(now, now, row.session_id as string, row.kind as string)
    return rowToJob(db.raw.prepare('SELECT * FROM worker_jobs WHERE session_id = ? AND kind = ?').get(row.session_id as string, row.kind as string) as Record<string, unknown>)
  })
}

export function completeJob(db: AtlasDb, sessionId: string, kind: JobKind, now: string): 'done' | 'requeued' {
  return db.transaction(() => {
    const row = db.raw.prepare('SELECT input_revision, running_revision FROM worker_jobs WHERE session_id = ? AND kind = ?').get(sessionId, kind) as { input_revision: number; running_revision: number } | undefined
    if (!row) return 'done'
    const requeue = row.input_revision > row.running_revision
    db.raw.prepare(`UPDATE worker_jobs SET state = ?, running_revision = NULL, attempts = 0, next_attempt_at = ?, last_error_category = NULL, updated_at = ?
      WHERE session_id = ? AND kind = ?`).run(requeue ? 'pending' : 'done', now, now, sessionId, kind)
    return requeue ? 'requeued' : 'done'
  })
}

export function failJob(db: AtlasDb, sessionId: string, kind: JobKind, category: string, now: string,
  backoff: { backoffBaseMs: number; backoffMaxMs: number; maxAttempts: number }): 'retry' | 'quarantined' {
  return db.transaction(() => {
    const row = db.raw.prepare('SELECT attempts FROM worker_jobs WHERE session_id = ? AND kind = ?').get(sessionId, kind) as { attempts: number } | undefined
    const attempts = row?.attempts ?? 1
    if (attempts >= backoff.maxAttempts) {
      db.raw.prepare(`UPDATE worker_jobs SET state = 'quarantined', running_revision = NULL, last_error_category = ?, last_error_at = ?, updated_at = ? WHERE session_id = ? AND kind = ?`)
        .run(category, now, now, sessionId, kind)
      return 'quarantined'
    }
    const delay = Math.min(backoff.backoffMaxMs, backoff.backoffBaseMs * 2 ** (attempts - 1))
    const next = new Date(Date.parse(now) + delay).toISOString()
    db.raw.prepare(`UPDATE worker_jobs SET state = 'pending', running_revision = NULL, next_attempt_at = ?, last_error_category = ?, last_error_at = ?, updated_at = ? WHERE session_id = ? AND kind = ?`)
      .run(next, category, now, now, sessionId, kind)
    return 'retry'
  })
}

export function recoverRunningJobs(db: AtlasDb, now: string): number {
  return Number(db.raw.prepare(`UPDATE worker_jobs SET state = 'pending', running_revision = NULL, next_attempt_at = ?, updated_at = ? WHERE state = 'running'`).run(now, now).changes)
}

export function listJobs(db: AtlasDb): WorkerJob[] {
  return (db.raw.prepare('SELECT * FROM worker_jobs ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map(rowToJob)
}

export function getJob(db: AtlasDb, sessionId: string, kind: JobKind): WorkerJob | null {
  const r = db.raw.prepare('SELECT * FROM worker_jobs WHERE session_id = ? AND kind = ?').get(sessionId, kind) as Record<string, unknown> | undefined
  return r ? rowToJob(r) : null
}

// H6 retry: a quarantined (or backed-off pending) job goes back to the front of the queue with
// a clean attempt count. A running job is never touched -- the worker owns it until it completes.
export function retryJob(db: AtlasDb, sessionId: string, kind: JobKind, now: string): boolean {
  const res = db.raw.prepare(`UPDATE worker_jobs SET state = 'pending', running_revision = NULL, attempts = 0, next_attempt_at = ?, updated_at = ?
    WHERE session_id = ? AND kind = ? AND state IN ('pending', 'quarantined')`).run(now, now, sessionId, kind)
  return res.changes > 0
}
