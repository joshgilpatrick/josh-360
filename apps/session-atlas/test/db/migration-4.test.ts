import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, migrate } from '../../src/db/database.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { openTestDb, tableNames } from '../helpers/db.ts'

const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const T = '2026-09-24T00:00:00.000Z'

test('migration 4 adds the custom-title reconciliation schema and seed hook', () => {
  const db = openTestDb()
  try {
    const columns = db.raw.prepare('PRAGMA table_info(sessions)').all() as Array<{name:string; notnull:number}>
    assert.deepEqual(columns.find(c => c.name === 'custom_title')?.notnull, 0)
    assert.ok(tableNames(db).includes('title_scan_jobs'))
    const indexes = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'title_scan_jobs'").all() as Array<{name: string}>
    assert.ok(indexes.some(index => index.name === 'idx_title_scan_claim'))

    ensureSession(db, { sessionId: SID, startedAt: T, now: T })
    assert.throws(() => db.raw.prepare('UPDATE sessions SET title_source = \'custom\' WHERE session_id = ?').run(SID), /CHECK/)
    assert.throws(() => db.raw.prepare(
      'INSERT INTO title_scan_jobs (session_id, next_attempt_at, updated_at) VALUES (?, ?, ?)').run('missing-session', T, T), /FOREIGN KEY/)

    const seed = MIGRATIONS.find(m => m.id === 4)!.after!
    seed(db)
    seed(db) // rerunning the seed is idempotent
    assert.equal((db.raw.prepare('SELECT count(*) AS n FROM title_scan_jobs WHERE session_id = ?').get(SID) as {n:number}).n, 1)
    assert.equal((db.raw.prepare('SELECT state FROM title_scan_jobs WHERE session_id = ?').get(SID) as {state: string}).state, 'pending')

    const reopened = openDatabase(db.path)
    try {
      assert.equal(migrate(reopened), 0)
      assert.equal((reopened.raw.prepare('SELECT count(*) AS n FROM schema_migrations WHERE id = 4').get() as {n:number}).n, 1)
    } finally {
      reopened.close()
    }
  } finally {
    db.close()
  }
})
