import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrate, openDatabase } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { createPreflightBackup } from '../../src/db/preflight.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { nowIso } from '../../src/util/time.ts'
import { openTestDb, tableNames } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

const T = '2026-10-01T00:00:00.000Z', S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const DROPPED_OBJECTS = ['session_usage', 'usage_event_aliases', 'usage_events', 'usage_legacy_adoption_audit', 'usage_legacy_state', 'usage_legacy', 'session_usage_summary', 'usage_provider_aliases', 'usage_adapter_status', 'usage_adapter_session_fence', 'usage_reconcile_jobs', 'usage_operator_audit', 'usage_price_assignment_audit', 'usage_route_resolution_audit', 'usage_source_reconciliation_audit', 'model_pricing', 'source_anomalies', 'atlas_maintenance', 'transcript_replay_jobs']
const KEPT = ['sessions', 'usage_source_sessions', 'transcript_checkpoints', 'backup_manifest', 'session_cost_cache', 'session_cost_cache_state']

/** A file database at schema 7 holding one session and one usage event, as a real install looks just before step 3. */
function atSeven(): string {
  const path = join(tempDir('atlas-m8-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  db.raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  for (const m of MIGRATIONS.filter(x => x.id <= 7)) db.transaction(() => {
    db.raw.exec(m.sql); m.after?.(db)
    db.raw.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, nowIso())
  })
  ensureSession(db, { sessionId: S1, cwd: '/x', startedAt: T, now: T })
  db.raw.prepare("INSERT INTO usage_source_sessions (source_client, native_session_id, session_id, created_at, updated_at) VALUES ('pi', 'native-1', ?, ?, ?)").run(S1, T, T)
  db.close()
  return path
}

test('a fresh database ends at schema 8 with the usage tables gone and the kept ones present', () => {
  const db = openTestDb()
  const names = tableNames(db)
  const objects = new Set((db.raw.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name))
  for (const t of DROPPED_OBJECTS) assert.ok(!objects.has(t), `${t} dropped`)
  for (const t of KEPT) assert.ok(names.includes(t), `${t} kept`)
  const cols = (db.raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name)
  assert.ok(!cols.includes('native_cost_usd') && !cols.includes('native_cost_unknown'))
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session_usage'").get() as { n: number }).n, 0)
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('a database with sessions refuses migration 8 without a preflight backup, and changes nothing', () => {
  const path = atSeven()
  assert.throws(() => openDatabase(path), /ledger-preflight-missing/)
  const db = openDatabase(path, { migrate: false })
  assert.ok(tableNames(db).includes('usage_events'), 'the refused migration rolled back')
  assert.equal((db.raw.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v, 7)
  db.close()
})

test('with a fresh preflight backup migration 8 runs, keeps sessions and the Pi mapping, and records the backup', () => {
  const path = atSeven()
  const manifest = createPreflightBackup(path, tempDir('atlas-m8-bak-'))
  const db = openDatabase(path)
  assert.equal((db.raw.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v, 13)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM usage_source_sessions').get() as { n: number }).n, 1)
  assert.ok(!tableNames(db).includes('usage_events'))
  const rec = db.raw.prepare('SELECT * FROM backup_manifest ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown>
  assert.equal(rec.sha256, manifest.sha256)
  db.close()
})

test('migration 8 runs with foreign keys off and leaves enforcement on afterwards', () => {
  const path = atSeven()
  createPreflightBackup(path, tempDir('atlas-m8-bak-'))
  const db = openDatabase(path)
  assert.equal((db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
  assert.equal((db.raw.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v, 13)
  db.close()
})

test('a migration that leaves a dangling foreign key is rolled back and enforcement is restored', () => {
  // Drives migrate() with a real noForeignKeys migration whose SQL leaves a dangling reference: it must roll back and re-enable enforcement.
  const path = join(tempDir('atlas-m8-fk-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  db.raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  db.raw.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
  db.raw.exec('CREATE TABLE child (pid INTEGER REFERENCES parent(id))')
  db.raw.exec('INSERT INTO parent (id) VALUES (1)')
  db.raw.exec('INSERT INTO child (pid) VALUES (1)')
  db.raw.exec('PRAGMA foreign_keys = ON')
  const bad = { id: 9, name: 'bad', sql: 'DROP TABLE parent', noForeignKeys: true }
  assert.throws(() => migrate(db, [bad]), /left foreign-key violations/)
  assert.ok(tableNames(db).includes('parent'), 'the failed migration rolled back')
  assert.equal((db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'enforcement restored')
  db.close()
})

test('a backup taken before the database changed is refused as stale', () => {
  const path = atSeven()
  createPreflightBackup(path, tempDir('atlas-m8-bak-'))
  const db = openDatabase(path, { migrate: false })
  ensureSession(db, { sessionId: '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10', cwd: '/x', startedAt: T, now: T })
  db.close()
  assert.throws(() => openDatabase(path), /ledger-preflight-stale/)
})
