import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrate, openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { ensureSession, setSessionStatus } from '../../src/db/sessions.ts'
import { openTestDb } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

// Migration 10 (PR #19 review, P1): sessions.end_reason tells a SessionEnd hook ('hook': the end is confirmed) from the idle
// sweep ('idle': Atlas only heard nothing). Additive: one nullable column, no rebuild, so no preflight guard.

const T = '2026-10-01T00:00:00.000Z'
const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10', S3 = '00000000-0000-4000-8000-000000000003'

/** Rows as plain objects: node:sqlite returns null-prototype objects, which strict deepEqual refuses to match against literals. */
function plain(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.map(r => ({ ...(r as object) }))
}

function columns(db: AtlasDb, table: string): Array<{ name: string; type: string; notnull: number; dflt_value: string | null }> {
  return db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
}

/** A production-shaped schema-9 file: an open session and two sessions that were closed before end reasons existed. */
function atNine(): string {
  const path = join(tempDir('atlas-m10-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  migrate(db, MIGRATIONS.filter(m => m.id <= 9))
  ensureSession(db, { sessionId: S1, cwd: '/x/keystone', startedAt: T, now: T })
  ensureSession(db, { sessionId: S2, cwd: '/x/other', startedAt: T, now: T })
  ensureSession(db, { sessionId: S3, cwd: '/x/third', startedAt: T, now: T })
  db.raw.prepare("UPDATE sessions SET status = 'closed', ended_at = ? WHERE session_id IN (?, ?)").run('2026-10-01T13:00:00.000Z', S2, S3)
  db.close()
  return path
}

test('migration 10 is additive (one ALTER ... ADD COLUMN), and needs no preflight guard or foreign-key opt-out', () => {
  assert.deepEqual(MIGRATIONS.map(m => m.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  const m = MIGRATIONS.find(x => x.id === 10)!
  assert.equal(m.name, 'session-end-reason')
  assert.equal(m.noForeignKeys, undefined)
  assert.equal(m.after, undefined)
  assert.doesNotMatch(m.sql, /\b(DROP|CREATE|INSERT|UPDATE|DELETE)\b/i)
  assert.equal((m.sql.match(/ALTER TABLE/gi) ?? []).length, 1)
})

test('a fresh database has a nullable end_reason with no default, and only hook, idle or NULL are accepted', () => {
  const db = openTestDb()
  const col = columns(db, 'sessions').find(c => c.name === 'end_reason')
  assert.ok(col, 'sessions.end_reason exists')
  assert.equal(col.notnull, 0)
  assert.equal(col.dflt_value, null)
  ensureSession(db, { sessionId: S1, cwd: '/x', startedAt: T, now: T })
  const set = (v: string | null) => db.raw.prepare('UPDATE sessions SET end_reason = ? WHERE session_id = ?').run(v, S1)
  for (const ok of ['hook', 'idle', null]) assert.doesNotThrow(() => set(ok), String(ok))
  for (const bad of ['crash', 'HOOK', '', 'exit']) assert.throws(() => set(bad), /CHECK/, bad)
  db.close()
})

test('migrating a populated schema-9 database applies only migration 10, keeps every row and index, and leaves old closed rows NULL (never confirmed)', () => {
  const path = atNine()
  const before = openDatabase(path, { migrate: false })
  const snapshot = {
    migrations: before.raw.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all(),
    sessions: plain(before.raw.prepare('SELECT * FROM sessions ORDER BY session_id').all()),
    schema: before.raw.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'sessions' ORDER BY type, name").all(),
    columns: columns(before, 'sessions').map(c => c.name),
  }
  assert.equal(snapshot.migrations.length, 9)
  assert.ok(!snapshot.columns.includes('end_reason'))
  before.close()

  const db = openDatabase(path) // no preflight backup exists and none is needed: the migration is additive
  assert.deepEqual(db.raw.prepare('SELECT id, name, applied_at FROM schema_migrations WHERE id <= 9 ORDER BY id').all(), snapshot.migrations, 'prior migration records untouched')
  assert.deepEqual(db.raw.prepare('SELECT id, name FROM schema_migrations WHERE id > 9 ORDER BY id').all().map(r => ({ ...r })), [{ id: 10, name: 'session-end-reason' }, { id: 11, name: 'session-last-hook-event' }, { id: 12, name: 'phi-dot-folder-reclassify' }, { id: 13, name: 'artifact-identity-adoptions' }])
  assert.deepEqual(columns(db, 'sessions').map(c => c.name), [...snapshot.columns, 'end_reason', 'last_hook_event_at'], 'one column per migration appended, none reordered or dropped')
  const after = plain(db.raw.prepare('SELECT * FROM sessions ORDER BY session_id').all())
  assert.equal(after.length, snapshot.sessions.length)
  for (const [i, row] of after.entries()) {
    const { end_reason: reason, last_hook_event_at: hook, ...rest } = row
    assert.deepEqual(rest, snapshot.sessions[i], `${row.session_id} unchanged`)
    assert.equal(hook, null, `${row.session_id}: no hook chronology is known for an existing row`)
    assert.equal(reason, null, `${row.session_id}: existing rows, closed or not, have no end reason`)
  }
  assert.deepEqual(db.raw.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'sessions' AND tbl_name <> 'artifact_identity_adoptions' ORDER BY type, name").all(), snapshot.schema, 'no index, trigger or table changed')
  db.raw.exec(`INSERT INTO sessions_fts(sessions_fts) VALUES ('integrity-check')`) // throws if the external-content index disagrees with sessions
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal((db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')

  // The closed legacy rows are not confirmed, whatever their ended_at says.
  const ids = db.raw.prepare("SELECT session_id FROM sessions WHERE status = 'closed' AND end_reason IS NULL ORDER BY session_id").all().map(r => (r as { session_id: string }).session_id)
  assert.deepEqual(ids, [S2, S3].sort())
  setSessionStatus(db, S2, 'closed', T, 'hook')
  assert.equal((db.raw.prepare('SELECT end_reason FROM sessions WHERE session_id = ?').get(S2) as { end_reason: string }).end_reason, 'hook', 'new closes record their reason')
  db.close()
})

test('migration 10 is a no-op the second time, and a failure inside it rolls its column back', () => {
  const path = atNine()
  const db = openDatabase(path)
  assert.equal(migrate(db), 0)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, 13)
  db.close()

  const failPath = join(tempDir('atlas-m10-fail-'), 'atlas.db')
  const failing = openDatabase(failPath, { migrate: false })
  const m10 = MIGRATIONS.find(m => m.id === 10)!
  migrate(failing, MIGRATIONS.filter(m => m.id <= 9))
  assert.throws(() => migrate(failing, [{ ...m10, sql: `${m10.sql}\nINSERT INTO table_that_does_not_exist VALUES (1);` }]), /no such table/)
  assert.ok(!columns(failing, 'sessions').some(c => c.name === 'end_reason'), 'the column was rolled back')
  assert.equal((failing.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, 9)
  assert.equal(migrate(failing), 4, 'the real migration (and migrations 11, 12 and 13) still applies afterwards')
  failing.close()
})
