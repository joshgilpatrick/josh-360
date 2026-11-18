import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openDatabase, migrate, type AtlasDb } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'

// JP-163: cache.db arrived with Atlas's tables but no schema_migrations rows (the retire job seeds it from an older file), so
// migration 1 ran again and failed on "table ... already exists". migrate() now recognises what is already in effect.
// Every database here is made up, in a temp folder.

const fresh = () => openDatabase(join(tempDir('atlas-adopt-'), 'cache.db'), { migrate: false })
const recorded = (db: AtlasDb) => (db.raw.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: number }>).map(r => r.id)
const columns = (db: AtlasDb, table: string) => (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
const tables = (db: AtlasDb) => (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name)
const allIds = MIGRATIONS.map(m => m.id)

test('tables present, no migration record: nothing reruns and every migration in effect is recorded', () => {
  const db = fresh()
  migrate(db)
  db.raw.exec("INSERT INTO sessions (session_id, title, started_at, last_activity_at, created_at, updated_at) VALUES ('s1', 'made-up', 't', 't', 't', 't')")
  db.raw.exec('DELETE FROM schema_migrations')

  const ran = migrate(db)

  assert.equal(ran, 1, 'only migration 12 has no schema to probe and may run again; it is idempotent')
  assert.deepEqual(recorded(db), allIds)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c, 1, 'existing rows are untouched')
  db.close()
})

test('a half-present migration 1 (artifacts there, sessions missing) is completed, then later migrations run', () => {
  const db = fresh()
  migrate(db, MIGRATIONS.filter(m => m.id === 1))
  db.raw.exec('PRAGMA foreign_keys = OFF')
  for (const t of ['sessions_fts', 'session_lineage', 'focus_states', 'artifact_origins', 'sessions']) db.raw.exec(`DROP TABLE ${t}`)
  db.raw.exec('PRAGMA foreign_keys = ON')
  db.raw.exec('DELETE FROM schema_migrations')
  assert.ok(!tables(db).includes('sessions') && tables(db).includes('artifacts'))

  migrate(db)

  assert.ok(tables(db).includes('sessions') && tables(db).includes('artifact_origins'))
  assert.deepEqual(recorded(db), allIds)
  db.close()
})

test('a missing migration still runs: tables of migrations 1 to 5, no record, then everything after', () => {
  const db = fresh()
  migrate(db, MIGRATIONS.filter(m => m.id <= 5))
  db.raw.exec('DELETE FROM schema_migrations')
  assert.ok(!columns(db, 'sessions').includes('end_reason'))

  const ran = migrate(db)

  assert.ok(columns(db, 'sessions').includes('end_reason'), 'migration 10 ran and its column exists')
  assert.ok(columns(db, 'sessions').includes('last_hook_event_at'))
  assert.ok(tables(db).includes('artifact_documents'), 'migration 9 ran')
  assert.deepEqual(recorded(db), allIds)
  assert.equal(ran, allIds.length - 5, 'migrations 1 to 5 were adopted, the other eight ran')
  db.close()
})

test('only the missing column runs: migration 10 absent, 11 present', () => {
  const db = fresh()
  migrate(db)
  db.raw.exec('ALTER TABLE sessions DROP COLUMN end_reason')
  db.raw.exec('DELETE FROM schema_migrations')

  migrate(db)

  assert.ok(columns(db, 'sessions').includes('end_reason'))
  assert.deepEqual(recorded(db), allIds)
  db.close()
})

test('a fresh database still runs every migration once, in order', () => {
  const db = fresh()
  const ran = migrate(db)
  assert.equal(ran, allIds.length)
  const rows = db.raw.prepare('SELECT id FROM schema_migrations ORDER BY applied_at, rowid').all() as Array<{ id: number }>
  assert.deepEqual(rows.map(r => r.id), allIds)
  assert.equal(migrate(db), 0, 'a second open runs nothing')
  db.close()
})

test('a database with only cost-ledger tables is not mistaken for an Atlas one', () => {
  const db = fresh()
  db.raw.exec('CREATE TABLE pricing_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, note TEXT)')
  assert.equal(migrate(db), allIds.length)
  assert.deepEqual(recorded(db), allIds)
  db.close()
})
