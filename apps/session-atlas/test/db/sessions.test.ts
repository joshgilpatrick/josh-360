import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb } from '../helpers/db.ts'
import { closeIdleSessions, ensureSession, fallbackTitle, getSession, setCustomTitle, setCustomTitleIfAbsent, setFocusState, setNativeTitle, setSessionStatus, setWorkerTitleAndSummary, touchSession } from '../../src/db/sessions.ts'

const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const T0 = '2026-09-17T00:00:00.000Z'
const T1 = '2026-09-17T00:05:00.000Z'

test('fallbackTitle is deterministic from folder and id', () => {
  assert.equal(fallbackTitle('/Users/x/dev/keystone', SID), 'keystone · 2864efe7')
  assert.equal(fallbackTitle(undefined, SID), 'session · 2864efe7')
})

test('ensureSession inserts once, then only touches', () => {
  const db = openTestDb()
  const a = ensureSession(db, { sessionId: SID, cwd: '/Users/x/dev/keystone', transcriptPath: '/t.jsonl', startedAt: T0, now: T0 })
  assert.equal(a.title, 'keystone · 2864efe7')
  assert.equal(a.projectName, 'keystone')
  assert.equal(a.focusState, 'metadata-only')
  const b = ensureSession(db, { sessionId: SID, cwd: '/Users/x/dev/keystone/.claude/worktrees/w1', startedAt: T1, now: T1 })
  assert.equal(b.startedAt, T0, 'start time is not overwritten')
  assert.equal(b.resumeCwd, '/Users/x/dev/keystone/.claude/worktrees/w1')
  assert.equal(b.startCwd, '/Users/x/dev/keystone')
  assert.equal(b.lastActivityAt, T1)
  db.close()
})

test('focus activation happens once and can be deactivated', () => {
  const db = openTestDb()
  ensureSession(db, { sessionId: SID, startedAt: T0, now: T0 })
  assert.equal(setFocusState(db, SID, 'active', 'skill:focus', T0), true)
  assert.equal(setFocusState(db, SID, 'active', 'tool:TaskCreate', T1), false)
  const s = getSession(db, SID)!
  assert.equal(s.focusActivationSource, 'skill:focus')
  assert.equal(setFocusState(db, SID, 'inactive', 'skill:focus off', T1), true)
  assert.equal(getSession(db, SID)!.focusState, 'inactive')
  db.close()
})

test('worker title outranks native title', () => {
  const db = openTestDb()
  ensureSession(db, { sessionId: SID, startedAt: T0, now: T0 })
  setNativeTitle(db, SID, 'extract tshirt sizes', T0)
  assert.equal(getSession(db, SID)!.titleSource, 'native')
  setWorkerTitleAndSummary(db, SID, 'T-shirt size tally', 'Tallies sizes from scanned forms.', T1)
  setNativeTitle(db, SID, 'renamed by user', T1)
  assert.equal(getSession(db, SID)!.title, 'T-shirt size tally')
  setSessionStatus(db, SID, 'closed', T1)
  assert.equal(getSession(db, SID)!.endedAt, T1)
  touchSession(db, SID, '2026-09-17T00:06:00.000Z')
  assert.equal(getSession(db, SID)!.lastActivityAt, '2026-09-17T00:06:00.000Z')
  db.close()
})

test('custom title survives worker/native writers while worker summaries refresh', () => {
  const db = openTestDb()
  ensureSession(db, { sessionId: SID, startedAt: T0, now: T0 })
  assert.equal(getSession(db, SID)!.customTitle, null)

  setWorkerTitleAndSummary(db, SID, 'Generated', 'First summary', T0)
  setCustomTitle(db, SID, 'high - zus criteria changes', T0)
  setWorkerTitleAndSummary(db, SID, 'New generated', 'Updated summary', T1)
  assert.equal(getSession(db, SID)!.title, 'high - zus criteria changes')
  assert.equal(getSession(db, SID)!.summary, 'Updated summary')
  assert.equal(getSession(db, SID)!.titleSource, 'native')

  setNativeTitle(db, SID, 'Late AI title', T1)
  assert.equal(getSession(db, SID)!.title, 'high - zus criteria changes')
  assert.equal(setCustomTitleIfAbsent(db, SID, 'Older scan title', T1), false)
  assert.equal(getSession(db, SID)!.title, 'high - zus criteria changes')

  const hits = db.raw.prepare('SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?').all('zus') as Array<{session_id:string}>
  assert.deepEqual(hits.map(h => h.session_id), [SID])
  assert.equal(getSession(db, SID)!.customTitle, 'high - zus criteria changes')
  db.close()
})

test('latest custom rename replaces the earlier custom title', () => {
  const db = openTestDb()
  ensureSession(db, { sessionId: SID, startedAt: T0, now: T0 })
  setCustomTitle(db, SID, 'First custom title', T0)
  setCustomTitle(db, SID, 'Latest custom title', T1)
  assert.equal(getSession(db, SID)!.title, 'Latest custom title')
  assert.equal(getSession(db, SID)!.customTitle, 'Latest custom title')
  db.close()
})

test('closeIdleSessions closes active/unknown sessions idle past the threshold unless the transcript is fresh', () => {
  const db = openTestDb()
  const now = '2026-09-20T12:00:00.000Z'
  const old = '2026-09-19T00:00:00.000Z'
  const idle = '11111111-1111-4111-8111-111111111111', fresh = '22222222-2222-4222-8222-222222222222', recent = '33333333-3333-4333-8333-333333333333', sub = 'agent-abcdef123456'
  ensureSession(db, { sessionId: idle, cwd: '/x/a', transcriptPath: '/t/idle.jsonl', startedAt: old, now: old })
  ensureSession(db, { sessionId: fresh, cwd: '/x/b', transcriptPath: '/t/fresh.jsonl', startedAt: old, now: old })
  ensureSession(db, { sessionId: recent, cwd: '/x/c', startedAt: now, now })
  ensureSession(db, { sessionId: sub, parentSessionId: idle, isSubagent: true, startedAt: old, now: old })
  db.raw.prepare(`UPDATE sessions SET status = 'unknown' WHERE session_id = ?`).run(idle)
  const mtimes: Record<string, number> = { '/t/fresh.jsonl': Date.parse(now) - 60_000 }
  const n = closeIdleSessions(db, { idleCloseHours: 12, now, transcriptMtime: p => mtimes[p] ?? null })
  assert.equal(n, 2)
  assert.equal(getSession(db, idle)!.status, 'closed')
  assert.equal(getSession(db, idle)!.endedAt, now)
  assert.equal(getSession(db, sub)!.status, 'closed')
  assert.equal(getSession(db, fresh)!.status, 'active', 'fresh transcript mtime keeps it open')
  assert.equal(getSession(db, recent)!.status, 'active')
  assert.equal(closeIdleSessions(db, { idleCloseHours: 12, now, transcriptMtime: () => null }), 1, 'the fresh one closes once its transcript is stale too')
  db.close()
})

/** end_reason is read straight from the column: SessionRow does not carry it (list rows and the removal probe do). */
const endReasonOf = (db: ReturnType<typeof openTestDb>, id: string): string | null => (db.raw.prepare('SELECT end_reason FROM sessions WHERE session_id = ?').get(id) as { end_reason: string | null }).end_reason

test('P1: a closed session records why: the idle sweep is "idle", a SessionEnd hook is "hook", a reopened session has no reason', () => {
  const db = openTestDb()
  const now = '2026-09-20T12:00:00.000Z'
  const old = '2026-09-19T00:00:00.000Z'
  const idle = '11111111-1111-4111-8111-111111111111', hooked = '22222222-2222-4222-8222-222222222222', bare = '33333333-3333-4333-8333-333333333333'
  for (const id of [idle, hooked, bare]) ensureSession(db, { sessionId: id, cwd: '/x/a', startedAt: old, now: old })
  assert.equal(endReasonOf(db, idle), null, 'an open session has no end reason')

  closeIdleSessions(db, { idleCloseHours: 12, now, transcriptMtime: () => null })
  const swept = getSession(db, idle)!
  assert.deepEqual([swept.status, swept.endedAt, endReasonOf(db, idle)], ['closed', now, 'idle'], 'the sweep never learns that a process exited')

  setSessionStatus(db, hooked, 'closed', now, 'hook')
  assert.equal(endReasonOf(db, hooked), 'hook')
  setSessionStatus(db, bare, 'closed', now)
  assert.equal(endReasonOf(db, bare), null, 'closing without a reason records none: it is never read as a confirmed end')

  // A late SessionEnd upgrades an idle close (the hook arrived after the sweep); reopening clears the reason with ended_at.
  setSessionStatus(db, idle, 'closed', '2026-09-20T13:00:00.000Z', 'hook')
  assert.deepEqual([endReasonOf(db, idle), getSession(db, idle)!.endedAt], ['hook', '2026-09-20T13:00:00.000Z'])
  setSessionStatus(db, hooked, 'active', '2026-09-20T14:00:00.000Z')
  const reopened = getSession(db, hooked)!
  assert.deepEqual([reopened.status, reopened.endedAt, endReasonOf(db, hooked)], ['active', null, null])
  db.close()
})
