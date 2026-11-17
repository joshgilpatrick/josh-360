import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tempDir } from '../helpers/tmp.ts'
import { openDatabase } from '../../src/db/database.ts'
import {
  assertLedgerPreflight, createPreflightBackup, ledgerFingerprint, ledgerGuardApplies, manifestPath, recordPreflightBackup,
} from '../../src/db/preflight.ts'
import { applyMigration6, openLegacyDb } from '../helpers/ledger-db.ts'
import { tableNames } from '../helpers/db.ts'

const NOW = '2026-09-30T00:00:00.000Z'
function legacyFile() {
  const dir = tempDir('atlas-preflight-')
  const path = join(dir, 'atlas.db')
  const db = openLegacyDb(path)
  db.raw.prepare(`INSERT INTO sessions (session_id, title, started_at, last_activity_at, created_at, updated_at) VALUES ('s1','t',?,?,?,?)`).run(NOW, NOW, NOW, NOW)
  db.raw.prepare(`INSERT INTO session_usage (session_id, provider, model, execution_role, updated_at) VALUES ('s1','anthropic','claude-sonnet-5','main',?)`).run(NOW)
  db.close()
  return { dir, path }
}

test('no-migrate open does not create schema', () => {
  const path = join(tempDir('atlas-nomig-'), 'a.db')
  const db = openDatabase(path, { migrate: false })
  assert.equal(db.raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sessions'`).get(), undefined)
  db.close()
})

test('guard applies only to a file DB with legacy rows', () => {
  const { path } = legacyFile()
  const db = openDatabase(path, { migrate: false })
  assert.equal(ledgerGuardApplies(db), true)
  db.raw.exec('DELETE FROM session_usage')
  assert.equal(ledgerGuardApplies(db), false)
  db.close()
})

test('guard exempts fresh, :memory:, and already-migrated databases', () => {
  const fresh = openDatabase(join(tempDir('atlas-fresh-'), 'a.db'), { migrate: false })
  assert.equal(ledgerGuardApplies(fresh), false)
  fresh.close()
  const mem = openLegacyDb(':memory:')
  mem.raw.prepare(`INSERT INTO sessions (session_id, title, started_at, last_activity_at, created_at, updated_at) VALUES ('s1','t',?,?,?,?)`).run(NOW, NOW, NOW, NOW)
  mem.raw.prepare(`INSERT INTO session_usage (session_id, provider, model, execution_role, updated_at) VALUES ('s1','anthropic','claude-sonnet-5','main',?)`).run(NOW)
  assert.equal(ledgerGuardApplies(mem), false)
  mem.close()
  const { path } = legacyFile()
  const db = openDatabase(path, { migrate: false })
  applyMigration6(db)
  assert.equal(ledgerGuardApplies(db), false)
  db.close()
})

test('missing, stale, and valid manifests', () => {
  const { dir, path } = legacyFile()
  let db = openDatabase(path, { migrate: false })
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-missing/)
  db.close()
  const m = createPreflightBackup(path, dir)
  assert.ok(existsSync(m.backupPath))
  db = openDatabase(path, { migrate: false })
  assert.equal(assertLedgerPreflight(db).sha256, m.sha256)
  db.raw.prepare(`UPDATE session_usage SET input_tokens = 5`).run()
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-stale/)
  db.close()
  const bad = JSON.parse(readFileSync(manifestPath(path), 'utf8'))
  writeFileSync(manifestPath(path), JSON.stringify({ ...bad, sha256: 'x' }))
  db = openDatabase(path, { migrate: false })
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-backup-invalid|ledger-preflight-stale/)
  db.close()
})

test('backup is a verified copy and the manifest binds the source fingerprint', () => {
  const { dir, path } = legacyFile()
  const m = createPreflightBackup(path, dir)
  assert.equal(m.dbPath, path)
  assert.equal(m.schemaVersion, 5)
  assert.equal(m.fingerprint.schemaVersion, 5)
  assert.equal(m.fingerprint.rowCounts.sessions, 1)
  assert.equal(m.fingerprint.rowCounts.session_usage, 1)
  assert.deepEqual(Object.keys(m.fingerprint.rowCounts).sort(), ['model_pricing', 'session_usage', 'sessions', 'transcript_checkpoints', 'transcript_replay_jobs'])
  assert.match(m.fingerprint.sessionUsageSha256, /^[0-9a-f]{64}$/)
  assert.equal(m.sizeBytes, statSync(m.backupPath).size)
  assert.equal(statSync(manifestPath(path)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(manifestPath(path), 'utf8')), m)
  const backup = openDatabase(m.backupPath, { migrate: false })
  assert.deepEqual(ledgerFingerprint(backup), m.fingerprint)
  backup.close()
  const src = openDatabase(path, { migrate: false })
  assert.deepEqual(ledgerFingerprint(src), m.fingerprint)
  src.close()
})

function journalMode(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode }
  finally { db.close() }
}

test('preflight leaves source permissions and journal mode unchanged; backup artifacts are private', () => {
  const { dir, path } = legacyFile()
  const setup = openDatabase(path, { migrate: false })
  setup.raw.prepare('PRAGMA journal_mode = DELETE').get()
  setup.close()

  const backupDir = join(dir, 'shared-backups')
  mkdirSync(backupDir)
  chmodSync(dir, 0o755)
  chmodSync(path, 0o644)
  chmodSync(backupDir, 0o700)
  const before = {
    directoryMode: statSync(dir).mode & 0o777,
    fileMode: statSync(path).mode & 0o777,
    journalMode: journalMode(path),
  }

  const manifest = createPreflightBackup(path, backupDir)
  assert.deepEqual({
    directoryMode: statSync(dir).mode & 0o777,
    fileMode: statSync(path).mode & 0o777,
    journalMode: journalMode(path),
  }, before)
  assert.equal(statSync(backupDir).mode & 0o777, 0o700)
  assert.equal(statSync(manifest.backupPath).mode & 0o777, 0o600)
  assert.equal(statSync(manifestPath(path)).mode & 0o777, 0o600)
})

test('preflight refuses a backup directory readable by others without changing it', () => {
  const { dir, path } = legacyFile()
  const backupDir = join(dir, 'shared-backups')
  mkdirSync(backupDir)
  chmodSync(backupDir, 0o755)
  assert.throws(() => createPreflightBackup(path, backupDir), /ledger-preflight-backup-dir-not-private/)
  assert.equal(statSync(backupDir).mode & 0o777, 0o755)
  assert.deepEqual(readdirSync(backupDir), [])
})

test('invalid manifests: bad JSON, wrong dbPath, tampered or missing backup', () => {
  const { dir, path } = legacyFile()
  const m = createPreflightBackup(path, dir)
  const db = openDatabase(path, { migrate: false })
  writeFileSync(manifestPath(path), '{not json')
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-invalid/)
  writeFileSync(manifestPath(path), JSON.stringify({ ...m, dbPath: join(dir, 'other.db') }))
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-invalid/)
  writeFileSync(manifestPath(path), JSON.stringify({ ...m, sizeBytes: m.sizeBytes + 1 }))
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-backup-invalid/)
  writeFileSync(manifestPath(path), JSON.stringify({ ...m, backupPath: join(dir, 'gone.db') }))
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-backup-invalid/)
  writeFileSync(manifestPath(path), JSON.stringify(m))
  writeFileSync(m.backupPath, 'corrupt')
  assert.throws(() => assertLedgerPreflight(db), /ledger-preflight-backup-invalid/)
  db.close()
})

test('recordPreflightBackup inserts a restore-eligible non-baseline preflight row', () => {
  const { dir, path } = legacyFile()
  const m = createPreflightBackup(path, dir)
  const db = openDatabase(path, { migrate: false })
  applyMigration6(db)
  recordPreflightBackup(db, m)
  const row = db.raw.prepare(`SELECT * FROM backup_manifest`).get() as Record<string, unknown>
  assert.equal(row.kind, 'preflight')
  assert.equal(row.path, m.backupPath)
  assert.equal(row.sha256, m.sha256)
  assert.equal(row.size_bytes, m.sizeBytes)
  assert.equal(row.schema_version, 5)
  assert.equal(row.restore_eligible, 1)
  assert.equal(row.is_restore_baseline, 0)
  db.close()
})

test('migrate() refuses migration 6 on a legacy DB without a preflight and leaves it unchanged', () => {
  const { path } = legacyFile()
  assert.throws(() => openDatabase(path), /ledger-preflight-missing/)
  const db = openDatabase(path, { migrate: false })
  assert.equal(db.raw.prepare(`SELECT MAX(id) AS v FROM schema_migrations`).get()!.v, 5)
  assert.equal((db.raw.prepare(`SELECT type FROM sqlite_master WHERE name = 'session_usage'`).get() as { type: string }).type, 'table')
  assert.equal(db.raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'usage_events'`).get(), undefined)
  db.close()
})

test('migrate() applies migrations 6 and 7 on a valid preflight; a stale one is refused', () => {
  const { dir, path } = legacyFile()
  createPreflightBackup(path, dir)
  const pre = openDatabase(path, { migrate: false })
  pre.raw.prepare(`UPDATE session_usage SET output_tokens = 9`).run()
  pre.close()
  assert.throws(() => openDatabase(path), /ledger-preflight-stale/)
  const m = createPreflightBackup(path, dir)
  // Migration 8 drops data and needs its own backup taken at the schema it sees, so this pass stops after 7.
  assert.throws(() => openDatabase(path), /ledger-preflight-stale/)
  const db = openDatabase(path, { migrate: false })
  assert.equal(db.raw.prepare(`SELECT MAX(id) AS v FROM schema_migrations`).get()!.v, 7)
  const rows = db.raw.prepare(`SELECT kind, path, sha256, schema_version, restore_eligible, is_restore_baseline FROM backup_manifest`).all()
  assert.deepEqual(rows.map(r => ({ ...r })), [{ kind: 'preflight', path: m.backupPath, sha256: m.sha256, schema_version: 5, restore_eligible: 1, is_restore_baseline: 0 }])
  assert.equal(db.raw.prepare(`SELECT output_tokens AS v FROM usage_legacy`).get()!.v, 9)
  assert.ok(tableNames(db).includes('usage_events'), 'migration 8 did not run')
  db.close()
})

test('migrate() does not require a preflight for a fresh DB', () => {
  const path = join(tempDir('atlas-fresh-mig-'), 'a.db')
  const db = openDatabase(path)
  assert.equal(db.raw.prepare(`SELECT MAX(id) AS v FROM schema_migrations`).get()!.v, 13)
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM backup_manifest`).get()!.n, 0)
  db.close()
})
