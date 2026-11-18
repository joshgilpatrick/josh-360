import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS, type Migration } from './migrations.ts'
import { nowIso } from '../util/time.ts'
import { setAsideLegacy } from './legacy-names.ts'
import { assertLedgerPreflight, ledgerGuardApplies, recordPreflightBackup, usageCleanupGuardApplies } from './preflight.ts'

export type AtlasDb = {
  raw: DatabaseSync
  path: string
  close(): void
  transaction<T>(fn: () => T): T
}

export function migrate(db: AtlasDb, list: Migration[] = MIGRATIONS): number {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)
  const applied = new Set((db.raw.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map(r => r.id))
  let count = 0
  for (const m of list) {
    if (applied.has(m.id)) continue
    if (m.noForeignKeys) db.raw.exec('PRAGMA foreign_keys = OFF')
    try {
      db.transaction(() => {
        // JP-163: a table, index or trigger this migration is about to create cannot be Atlas's own if it already exists.
        const moved = setAsideLegacy(db, m.sql)
        if (moved.length > 0) process.stderr.write(`migration ${m.id}: set aside legacy ${moved.join(', ')}\n`)
        // Backup guards (spec 2026-10-06 sections 5 and 7): migration 6 on a database with legacy usage rows, and migration 8
        // (which drops the usage tables) on a database with sessions, run only against a manifest whose fingerprint still
        // matches, verified inside this exclusive transaction.
        const guard = (m.id === 6 && ledgerGuardApplies(db)) || (m.id === 8 && usageCleanupGuardApplies(db))
        const manifest = guard ? assertLedgerPreflight(db) : null
        db.raw.exec(m.sql)
        if (m.after) m.after(db)
        // With enforcement off during a migration, verify nothing dangles before the transaction commits.
        if (m.noForeignKeys && (db.raw.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > 0) {
          throw new Error(`migration ${m.id} left foreign-key violations; rolled back`)
        }
        if (manifest) recordPreflightBackup(db, manifest)
        db.raw.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, nowIso())
      })
    } finally {
      if (m.noForeignKeys) db.raw.exec('PRAGMA foreign_keys = ON')
    }
    count += 1
  }
  return count
}

export function openDatabase(path: string, opts: { migrate?: boolean } = {}): AtlasDb {
  if (path !== ':memory:') {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')
  raw.exec('PRAGMA synchronous = NORMAL')
  if (path !== ':memory:') chmodSync(path, 0o600)
  // Tracks transaction nesting depth so transaction() is safe to call from inside another
  // transaction() call: sqlite has no nested BEGIN, so an inner call just runs fn() directly —
  // the outermost call alone owns BEGIN/COMMIT/ROLLBACK, and an inner throw propagates up to it.
  let depth = 0
  const db: AtlasDb = {
    raw,
    path,
    close: () => raw.close(),
    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        depth += 1
        try { return fn() } finally { depth -= 1 }
      }
      raw.exec('BEGIN IMMEDIATE')
      depth = 1
      try {
        const out = fn()
        raw.exec('COMMIT')
        return out
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      } finally {
        depth = 0
      }
    },
  }
  if (opts.migrate !== false) migrate(db)
  return db
}
