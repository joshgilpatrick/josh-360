import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AtlasDb } from './database.ts'
import { nowIso } from '../util/time.ts'

// Preflight evidence for the usage-ledger migration (spec section 5, step 2). A legacy database
// may only take migration 6 when a manifest exists that binds (a) a verified WAL-consistent backup
// and (b) a logical fingerprint of the live database; migrate() re-checks the fingerprint inside its
// exclusive transaction. `database.ts` and this module import each other; that is safe because each
// only uses the other's exports inside function bodies, never at module evaluation time.

const FINGERPRINT_TABLES = ['sessions', 'session_usage', 'model_pricing', 'transcript_checkpoints', 'transcript_replay_jobs'] as const

export type LedgerFingerprint = { schemaVersion: number; rowCounts: Record<string, number>; sessionUsageSha256: string }
export type PreflightManifest = {
  dbPath: string; backupPath: string; sizeBytes: number; sha256: string
  schemaVersion: number; fingerprint: LedgerFingerprint; createdAt: string
}

const quoteSqlString = (s: string) => "'" + s.replaceAll("'", "''") + "'"

export function manifestPath(dbPath: string): string {
  return `${dbPath}.ledger-preflight.json`
}

function objectType(db: Pick<AtlasDb, 'raw'>, name: string): string | null {
  const row = db.raw.prepare(`SELECT type FROM sqlite_master WHERE name = ?`).get(name) as { type: string } | undefined
  return row?.type ?? null
}

function migrationApplied(db: AtlasDb, id: number): boolean {
  if (objectType(db, 'schema_migrations') !== 'table') return false
  return db.raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id) !== undefined
}

export function ledgerFingerprint(db: Pick<AtlasDb, 'raw'>): LedgerFingerprint {
  let schemaVersion = 0
  if (objectType(db, 'schema_migrations') === 'table') {
    const row = db.raw.prepare(`SELECT MAX(id) AS v FROM schema_migrations`).get() as { v: number | null }
    schemaVersion = row.v ?? 0
  }
  const rowCounts: Record<string, number> = {}
  for (const t of FINGERPRINT_TABLES) {
    // Table names come from the constant list above, never from data.
    rowCounts[t] = objectType(db, t) === null ? 0 : (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  }
  const rows = objectType(db, 'session_usage') === null
    ? []
    : db.raw.prepare(`SELECT * FROM session_usage ORDER BY session_id, provider, model, execution_role`).all()
  const sessionUsageSha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  return { schemaVersion, rowCounts, sessionUsageSha256 }
}

/** Streams the file through sha256 so a multi-gigabyte database is never held in memory. Shared with the post-cutover baseline backup (ledger-validate). */
export function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let size = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      size += n
    }
    return { sha256: hash.digest('hex'), sizeBytes: size }
  } finally {
    closeSync(fd)
  }
}

/**
 * Writes a verified backup of `dbPath` into a private `backupDir` plus a preflight manifest next to the database.
 * The service must already be stopped (spec section 5 step 1); both database connections are read-only.
 */
export function createPreflightBackup(dbPath: string, backupDir: string): PreflightManifest {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  if ((statSync(backupDir).mode & 0o077) !== 0) {
    throw new Error(`ledger-preflight-backup-dir-not-private: restrict access to ${backupDir}`)
  }

  const backupPath = join(backupDir, `atlas-preflight-${Date.now()}-${randomUUID()}.db`)
  const source = new DatabaseSync(dbPath, { readOnly: true })
  let fingerprint: LedgerFingerprint
  let complete = false
  try {
    try {
      const previousUmask = process.umask(0o077)
      try { source.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`) }
      finally { process.umask(previousUmask) }
      // Fingerprint the source on the same connection, right after the copy, so the backup and the
      // fingerprint describe the same instant.
      fingerprint = ledgerFingerprint({ raw: source })
    } finally {
      source.close()
    }

    const backup = new DatabaseSync(backupPath, { readOnly: true })
    let backupFingerprint: LedgerFingerprint
    try {
      const check = backup.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
      if (check.length !== 1 || check[0]!.integrity_check !== 'ok') {
        throw new Error(`ledger-preflight-backup-invalid: integrity_check failed for ${backupPath}`)
      }
      backupFingerprint = ledgerFingerprint({ raw: backup })
    } finally {
      backup.close()
    }
    if (!isDeepStrictEqual(backupFingerprint, fingerprint)) {
      throw new Error(`ledger-preflight-backup-invalid: backup content differs from source for ${backupPath}`)
    }

    // Hash after the last connection closed so the digest covers the final on-disk bytes.
    const { sha256, sizeBytes } = hashFile(backupPath)
    chmodSync(backupPath, 0o600)
    const manifest: PreflightManifest = {
      dbPath, backupPath, sizeBytes, sha256, schemaVersion: fingerprint.schemaVersion, fingerprint, createdAt: nowIso(),
    }
    const mp = manifestPath(dbPath)
    writeFileSync(mp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    chmodSync(mp, 0o600)
    complete = true
    return manifest
  } finally {
    if (!complete && existsSync(backupPath)) {
      try { chmodSync(backupPath, 0o600); unlinkSync(backupPath) } catch {}
    }
  }
}

/** True only for a file database that still holds legacy `session_usage` rows and has not taken migration 6. */
export function ledgerGuardApplies(db: AtlasDb): boolean {
  if (db.path === ':memory:') return false
  if (migrationApplied(db, 6)) return false
  if (objectType(db, 'session_usage') !== 'table') return false
  return db.raw.prepare(`SELECT 1 FROM session_usage LIMIT 1`).get() !== undefined
}

/** Migration 8 drops data, so a file database that holds any session may only take it against a fresh preflight backup. */
export function usageCleanupGuardApplies(db: AtlasDb): boolean {
  if (db.path === ':memory:') return false
  if (migrationApplied(db, 8)) return false
  if (objectType(db, 'sessions') !== 'table') return false
  return db.raw.prepare(`SELECT 1 FROM sessions LIMIT 1`).get() !== undefined
}

function isFingerprint(v: unknown): v is LedgerFingerprint {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  return typeof f.schemaVersion === 'number' && typeof f.sessionUsageSha256 === 'string'
    && typeof f.rowCounts === 'object' && f.rowCounts !== null
}

function parseManifest(text: string): PreflightManifest | null {
  let v: unknown
  try { v = JSON.parse(text) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const m = v as Record<string, unknown>
  if (typeof m.dbPath !== 'string' || typeof m.backupPath !== 'string' || typeof m.sha256 !== 'string'
    || typeof m.sizeBytes !== 'number' || typeof m.schemaVersion !== 'number' || typeof m.createdAt !== 'string'
    || !isFingerprint(m.fingerprint)) return null
  return m as unknown as PreflightManifest
}

/** Throws `ledger-preflight-{missing,invalid,backup-invalid,stale}` on the first failed check. */
export function assertLedgerPreflight(db: AtlasDb): PreflightManifest {
  const mp = manifestPath(db.path)
  if (!existsSync(mp)) throw new Error(`ledger-preflight-missing: no manifest at ${mp}`)
  const manifest = parseManifest(readFileSync(mp, 'utf8'))
  if (!manifest) throw new Error(`ledger-preflight-invalid: unreadable manifest ${mp}`)
  if (manifest.dbPath !== db.path) throw new Error(`ledger-preflight-invalid: manifest is for ${manifest.dbPath}, not ${db.path}`)
  if (!existsSync(manifest.backupPath) || !statSync(manifest.backupPath).isFile()) {
    throw new Error(`ledger-preflight-backup-invalid: backup missing at ${manifest.backupPath}`)
  }
  const actual = hashFile(manifest.backupPath)
  if (actual.sha256 !== manifest.sha256 || actual.sizeBytes !== manifest.sizeBytes) {
    throw new Error(`ledger-preflight-backup-invalid: backup size/sha256 differ at ${manifest.backupPath}`)
  }
  if (!isDeepStrictEqual(manifest.fingerprint, ledgerFingerprint(db))) {
    throw new Error(`ledger-preflight-stale: database changed since the preflight backup ${manifest.backupPath}`)
  }
  return manifest
}

/** Call inside the migration transaction, after migration 6 created `backup_manifest`. */
export function recordPreflightBackup(db: AtlasDb, m: PreflightManifest): void {
  db.raw.prepare(
    `INSERT INTO backup_manifest (path, sha256, size_bytes, kind, schema_version, restore_eligible, is_restore_baseline, created_at)
     VALUES (?, ?, ?, 'preflight', ?, 1, 0, ?)`,
  ).run(m.backupPath, m.sha256, m.sizeBytes, m.schemaVersion, m.createdAt)
}
