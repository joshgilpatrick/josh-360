import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openTestDb, tableNames } from '../helpers/db.ts'
import { migrate, openDatabase } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'

test('openDatabase enables WAL and foreign keys and restricts file mode', () => {
  const db = openTestDb()
  const jm = db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  assert.equal(jm.journal_mode, 'wal')
  const fk = db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
  assert.equal(fk.foreign_keys, 1)
  assert.equal(statSync(db.path).mode & 0o777, 0o600)
  db.close()
})

test('openDatabase enforces 0700 on the data directory even when it already exists with looser permissions', () => {
  const dir = tempDir('atlas-db-')
  chmodSync(dir, 0o755)
  const db = openDatabase(join(dir, 'atlas.db'))
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(db.path).mode & 0o777, 0o600)
  db.close()
})

test('migrate creates every logical table and is idempotent', () => {
  const db = openTestDb()
  const names = tableNames(db)
  // Migration 8 drops the usage tables, so a fresh database keeps only the non-usage tables and the usage source mapping.
  for (const t of ['sessions', 'focus_states', 'session_lineage', 'artifacts',
    'artifact_origins', 'artifact_candidates', 'transcript_checkpoints', 'worker_jobs', 'events_seen',
    'schema_migrations', 'sessions_fts', 'artifacts_fts',
    'usage_source_sessions', 'session_cost_cache', 'session_cost_cache_state', 'backup_manifest']) {
    assert.ok(names.includes(t), `missing table ${t}`)
  }
  for (const t of ['session_usage', 'model_pricing', 'usage_events', 'usage_legacy', 'atlas_maintenance']) {
    assert.ok(!names.includes(t), `${t} is dropped by migration 8`)
  }
  assert.equal(migrate(db), 0, 'second migrate applies nothing')
  db.close()
})

test('FTS triggers keep sessions_fts in sync', () => {
  const db = openTestDb()
  db.raw.prepare(`INSERT INTO sessions (session_id, title, status, focus_state, started_at, last_activity_at, created_at, updated_at, project_name)
    VALUES ('11111111-1111-1111-1111-111111111111', 'Fix billing export', 'active', 'metadata-only', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 'keystone')`).run()
  const hit = db.raw.prepare("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH 'billing'").all()
  assert.equal(hit.length, 1)
  db.raw.prepare("UPDATE sessions SET title = 'Fix payroll export' WHERE session_id = '11111111-1111-1111-1111-111111111111'").run()
  assert.equal(db.raw.prepare("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH 'billing'").all().length, 0)
  assert.equal(db.raw.prepare("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH 'payroll'").all().length, 1)
  db.close()
})

test('sessions_au trigger is scoped to only the columns the FTS index covers', () => {
  // touchSession runs on every tool event, so an unscoped `AFTER UPDATE ON sessions` doubles
  // the FTS writes on every single event. artifacts_au already scopes to `OF filename, path`;
  // sessions_au must match that pattern (migration 1 has not shipped to any real DB yet, so
  // this is free to fix in place rather than as a migration 2).
  assert.match(MIGRATIONS[0]!.sql, /CREATE TRIGGER sessions_au AFTER UPDATE OF title, summary, project_name, start_cwd ON sessions/)
})

test('transaction rolls back on throw', () => {
  const db = openTestDb()
  assert.throws(() => db.transaction(() => {
    db.raw.prepare("INSERT INTO events_seen (fingerprint, seen_at) VALUES ('f1', 'now')").run()
    throw new Error('boom')
  }))
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM events_seen').get()!.n, 0)
  db.close()
})

test('transaction is reentrant: a nested call commits once with the outer', () => {
  const db = openTestDb()
  db.transaction(() => {
    db.raw.prepare("INSERT INTO events_seen (fingerprint, seen_at) VALUES ('outer', 'now')").run()
    db.transaction(() => {
      db.raw.prepare("INSERT INTO events_seen (fingerprint, seen_at) VALUES ('inner', 'now')").run()
    })
  })
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM events_seen').get()!.n, 2)
  db.close()
})

// F1: depth must only flip to 1 once BEGIN IMMEDIATE actually succeeds. If depth were set first
// and BEGIN threw (SQLITE_BUSY, or — as forced here — "cannot start a transaction within a
// transaction"), depth would stay stuck at 1 forever, and every later db.transaction() call would
// take the depth>0 branch: it would run fn() directly with no BEGIN/COMMIT/ROLLBACK at all, so a
// throw inside it would never roll back writes already made.
test('F1: a failed BEGIN IMMEDIATE does not corrupt the depth counter for later transactions', () => {
  const db = openTestDb()
  db.raw.exec('BEGIN') // manually open a transaction so the next BEGIN IMMEDIATE fails
  assert.throws(() => db.transaction(() => {}), /cannot start a transaction within a transaction/)
  db.raw.exec('ROLLBACK') // clean up the manual transaction; depth must be back to 0 here
  assert.throws(() => db.transaction(() => {
    db.raw.prepare("INSERT INTO events_seen (fingerprint, seen_at) VALUES ('f1-depth', 'now')").run()
    throw new Error('boom')
  }))
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM events_seen').get()!.n, 0)
  db.close()
})

test('transaction is reentrant: an inner throw rolls back the whole outer transaction', () => {
  const db = openTestDb()
  assert.throws(() => db.transaction(() => {
    db.raw.prepare("INSERT INTO events_seen (fingerprint, seen_at) VALUES ('outer', 'now')").run()
    db.transaction(() => {
      db.raw.prepare("INSERT INTO events_seen (fingerprint, seen_at) VALUES ('inner', 'now')").run()
      throw new Error('boom')
    })
  }))
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM events_seen').get()!.n, 0)
  db.close()
})

test('migration 2 adds is_sensitive and attention_acks, and its after-hook flags existing rows', () => {
  const db = openTestDb()
  assert.ok(tableNames(db).includes('attention_acks'))
  const cols = (db.raw.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map(c => c.name)
  assert.ok(cols.includes('is_sensitive'))
  db.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, created_at, is_sensitive) VALUES ('/x/.env', '.env', 'env', 'config', '2026-01-01T00:00:00.000Z', 0)`).run()
  db.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, created_at, is_sensitive) VALUES ('/x/a.md', 'a.md', 'md', 'document', '2026-01-01T00:00:00.000Z', 0)`).run()
  const m2 = MIGRATIONS.find(m => m.id === 2)!
  m2.after!(db)
  const flagged = (db.raw.prepare('SELECT path FROM artifacts WHERE is_sensitive = 1').all() as Array<{ path: string }>).map(r => r.path)
  assert.deepEqual(flagged, ['/x/.env'])
  db.close()
})
