import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { mirrorSessions, statusFor } from '../../src/mirror/session-mirror.ts'

// JP-111: the mirror copies the ledger's sessions into cache.db. The ledger here is built from josh-360's own schema.sql with
// made-up rows, so a change to the ledger's columns breaks this test instead of the laptop.
const SCHEMA = join(import.meta.dirname, '..', '..', '..', '..', 'ledger', 'schema.sql')
const MACHINE = 'machine-0001'
const NOW = '2026-11-17T12:00:00.000Z'

type Ep = { episode: number; last: string; quiet: string; reason: 'session-end' | 'quiet' | 'killed' | 'unknown'; title?: string; titleSource?: string; folder?: string }

function makeLedger(): { path: string; db: DatabaseSync } {
  const path = join(tempDir('atlas-mirror-'), 'ledger.db')
  const db = new DatabaseSync(path)
  db.exec(readFileSync(SCHEMA, 'utf8'))
  db.prepare('INSERT INTO machines (machine_id, label, created_at, recorded_by) VALUES (?, ?, ?, ?)').run(MACHINE, 'test machine', NOW, 'test')
  return { path, db }
}

function addSession(db: DatabaseSync, id: string, startedAt: string, folder: string | null, eps: Ep[] = []): void {
  const uid = `${MACHINE}:claude-code:${id}`
  db.prepare(`INSERT INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by, start_folder, recorded_at, recorded_by)
    VALUES (?, ?, 'claude-code', ?, ?, 'unknown', ?, ?, 'test')`).run(uid, MACHINE, id, startedAt, folder, NOW)
  for (const e of eps) {
    db.prepare(`INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, folder, title, title_source, recorded_at, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`).run(uid, e.episode, startedAt, e.last, e.quiet, e.reason, e.folder ?? folder, e.title ?? null, e.titleSource ?? null, NOW)
  }
}

const sessionRow = (atlas: ReturnType<typeof openTestDb>, id: string) =>
  atlas.raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as Record<string, unknown> | undefined

test('a session the ledger ended is confirmed closed; one it only saw go quiet is not', () => {
  const { path, db } = makeLedger()
  addSession(db, 'sess-ended', '2026-11-17T09:00:00Z', '/work/a', [{ episode: 1, last: '2026-11-17T09:30:00Z', quiet: '2026-11-17T09:31:00Z', reason: 'session-end', title: 'Ended one', titleSource: 'custom' }])
  addSession(db, 'sess-quiet', '2026-11-16T09:00:00Z', '/work/b', [{ episode: 1, last: '2026-11-16T09:30:00Z', quiet: '2026-11-16T10:00:00Z', reason: 'quiet' }])
  addSession(db, 'sess-live', '2026-11-17T11:50:00Z', '/work/c')
  db.close()
  const atlas = openTestDb()
  assert.deepEqual(mirrorSessions(atlas, path, { now: NOW }), { read: 3, written: 3 })
  const ended = sessionRow(atlas, 'sess-ended')!
  assert.deepEqual([ended.status, ended.end_reason, ended.title, ended.title_source], ['closed', 'hook', 'Ended one', 'native'])
  const quiet = sessionRow(atlas, 'sess-quiet')!
  assert.deepEqual([quiet.status, quiet.end_reason], ['closed', 'idle'], 'quiet is not a confirmed end')
  const live = sessionRow(atlas, 'sess-live')!
  assert.deepEqual([live.status, live.end_reason], ['active', null])
  atlas.close()
})

test('activity after the ledger recorded an end withdraws the confirmation', () => {
  const row = { tool_session_id: 's', started_at: '2026-11-17T09:00:00Z', start_folder: '/x', transcript_path: null, episode_folder: '/x',
    episode_last_activity_at: '2026-11-17T11:59:00Z', episode_quiet_at: '2026-11-17T09:31:00Z', episode_end_reason: 'session-end',
    title: null, title_source: null, parent_tool_id: null, root_tool_id: null, lineage_kind: null }
  assert.equal(statusFor(row, Date.parse(NOW)).status, 'active')
})

test('the mirror only adds and updates: a cache.db session the ledger does not hold stays', () => {
  const { path, db } = makeLedger()
  addSession(db, 'sess-a', '2026-11-17T11:00:00Z', '/work/a')
  db.close()
  const atlas = openTestDb()
  ensureSession(atlas, { sessionId: 'cache-only', cwd: '/work/z', startedAt: NOW, now: NOW })
  assert.deepEqual(mirrorSessions(atlas, path, { now: NOW }), { read: 1, written: 1 })
  assert.ok(sessionRow(atlas, 'cache-only'), 'a session missing from the ledger must not be deleted (the catalog cascades from it)')
  atlas.close()
})

test('lineage comes across, and a subagent is marked as one', () => {
  const { path, db } = makeLedger()
  addSession(db, 'parent-1', '2026-11-17T11:00:00Z', '/work/a')
  addSession(db, 'child-1', '2026-11-17T11:05:00Z', '/work/a')
  const uid = (id: string) => `${MACHINE}:claude-code:${id}`
  db.prepare(`INSERT INTO session_lineage (child_uid, parent_uid, root_uid, kind, confidence, discovered_at, recorded_by) VALUES (?, ?, ?, 'subagent', 'confirmed', ?, 'test')`)
    .run(uid('child-1'), uid('parent-1'), uid('parent-1'), NOW)
  db.close()
  const atlas = openTestDb()
  mirrorSessions(atlas, path, { now: NOW })
  const child = sessionRow(atlas, 'child-1')!
  assert.deepEqual([child.parent_session_id, child.root_session_id, child.is_subagent], ['parent-1', 'parent-1', 1])
  atlas.close()
})

test('the mirror never writes ledger.db, and a missing ledger is skipped, not treated as empty', () => {
  const { path, db } = makeLedger()
  addSession(db, 'sess-a', '2026-11-17T11:00:00Z', '/work/a')
  db.close()
  const before = readFileSync(path)
  const atlas = openTestDb()
  mirrorSessions(atlas, path, { now: NOW })
  assert.ok(before.equals(readFileSync(path)), 'ledger.db changed')
  assert.equal(mirrorSessions(atlas, join(tempDir('atlas-nomirror-'), 'absent.db'), { now: NOW }), null)
  assert.ok(sessionRow(atlas, 'sess-a'))
  atlas.close()
})
