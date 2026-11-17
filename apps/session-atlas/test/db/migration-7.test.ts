import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, tableNames } from '../helpers/db.ts'
import { openDatabase } from '../../src/db/database.ts'
import { ensureSession } from '../../src/db/sessions.ts'

const T = '2026-10-01T00:00:00.000Z', S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'

test('migration 7 adds the cache tables on a database that already has sessions', () => {
  const db = openTestDb()
  assert.ok(tableNames(db).includes('session_cost_cache'))
  assert.ok(tableNames(db).includes('session_cost_cache_state'))
  ensureSession(db, { sessionId: S1, cwd: '/x', startedAt: T, now: T })
  db.raw.prepare(`INSERT INTO session_cost_cache (session_id, direct_cost_usd, status, ledger_import_id) VALUES (?, 1.5, 'priced', 3)`).run(S1)
  assert.throws(() => db.raw.prepare(`INSERT INTO session_cost_cache (session_id, status) VALUES ('x', 'partial')`).run(), /CHECK|FOREIGN/)
  assert.throws(() => db.raw.prepare(`INSERT INTO session_cost_cache_state (id, refreshed_at) VALUES (2, ?)`).run(T), /CHECK/)
  const path = db.path
  db.close()
  const again = openDatabase(path)
  assert.equal((again.raw.prepare('SELECT COUNT(*) AS n FROM session_cost_cache').get() as { n: number }).n, 1, 'reopening keeps rows')
  assert.equal((again.raw.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v, 13)
  again.close()
})

test('deleting a session removes its cache row', () => {
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: '/x', startedAt: T, now: T })
  db.raw.prepare(`INSERT INTO session_cost_cache (session_id, direct_cost_usd, status) VALUES (?, 1, 'priced')`).run(S1)
  db.raw.prepare('DELETE FROM sessions WHERE session_id = ?').run(S1)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM session_cost_cache').get() as { n: number }).n, 0)
  db.close()
})
