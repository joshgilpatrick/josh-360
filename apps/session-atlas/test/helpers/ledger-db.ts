import { join } from 'node:path'
import { openTestDb } from './db.ts'
import { tempDir } from './tmp.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { MIGRATION_6 } from '../../src/db/migration-6-ledger.ts'
import { nowIso } from '../../src/util/time.ts'

/**
 * A database at a legacy schema (migrations 1 through `upTo`, default 5 = the last legacy schema): `session_usage` is
 * still a table and no ledger table exists. Migration 6 is registered, so `openDatabase(path)` would take it; this is
 * the one way to get a pre-ledger file for migration, preflight, and legacy-seeding tests.
 */
export function openLegacyDb(path: string, upTo = 5): AtlasDb {
  const db = openDatabase(path, { migrate: false })
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  for (const m of MIGRATIONS.filter(x => x.id <= Math.min(upTo, MIGRATION_6.id - 1))) {
    db.transaction(() => {
      db.raw.exec(m.sql)
      m.after?.(db)
      db.raw.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, nowIso())
    })
  }
  return db
}

/** `openLegacyDb` on a fresh temp path. */
export function openLegacyTestDb(upTo = 5): AtlasDb {
  return openLegacyDb(join(tempDir('atlas-db-'), 'atlas.db'), upTo)
}

/** Applies migration 6 to a database from `openLegacyDb` / `openLegacyTestDb`, bypassing the preflight guard (tests only). */
export function applyMigration6(db: AtlasDb): void {
  db.transaction(() => {
    db.raw.exec(MIGRATION_6.sql)
    MIGRATION_6.after!(db)
    db.raw.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(MIGRATION_6.id, MIGRATION_6.name, nowIso())
  })
}

/** A fresh database at schema 7: migration 6's tables exist and migration 8 has not dropped them. For migration 6 tests only. */
export function openSevenTestDb(): AtlasDb {
  const path = join(tempDir('atlas-db-'), 'atlas.db')
  const db = openDatabase(path, { migrate: false })
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  for (const m of MIGRATIONS.filter(x => x.id <= 7)) {
    db.transaction(() => {
      db.raw.exec(m.sql)
      m.after?.(db)
      db.raw.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, nowIso())
    })
  }
  return db
}

/** Since the writer switch `openTestDb()` already runs migration 6; this name is kept so ledger tests keep reading as before. */
export function openLedgerTestDb(): AtlasDb {
  return openTestDb()
}
