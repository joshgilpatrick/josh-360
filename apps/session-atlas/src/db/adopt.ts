import type { AtlasDb } from './database.ts'
import type { Migration } from './migrations.ts'

// JP-163: a database can arrive with Atlas's tables already in it and nothing in schema_migrations (the retire job seeds
// cache.db from an older file). Replaying migration 1 on it fails with "table ... already exists", so Atlas never starts.
// When schema_migrations is empty and any table of migration 1 exists, migrate() asks `inEffect` of each migration, in order,
// just before it would run it. A migration whose effect is found is recorded and skipped; every other one runs as usual.
// Probes read the schema only (tables and columns), never rows, and never write.

const MIGRATION_1_TABLES = [
  'sessions', 'focus_states', 'session_lineage', 'artifacts', 'artifact_origins', 'artifact_candidates',
  'transcript_checkpoints', 'worker_jobs', 'events_seen',
] as const

const hasTable = (db: AtlasDb, name: string): boolean =>
  db.raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined

const hasColumn = (db: AtlasDb, table: string, column: string): boolean =>
  hasTable(db, table) && (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column)

/** True when the database holds at least one table that migration 1 creates: a sign that Atlas's schema is (partly) there. */
export function holdsAtlasTables(db: AtlasDb): boolean {
  return MIGRATION_1_TABLES.some(t => hasTable(db, t))
}

// Migration 8 drops these, so a database past it no longer has the tables migrations 3 and 5 altered.
const USAGE_TABLES_DROPPED = (db: AtlasDb) =>
  !hasTable(db, 'model_pricing') && !hasTable(db, 'transcript_replay_jobs') && !hasTable(db, 'usage_events')

const PROBES: Record<number, (db: AtlasDb) => boolean> = {
  1: db => MIGRATION_1_TABLES.every(t => hasTable(db, t)),
  2: db => hasTable(db, 'attention_acks') && hasColumn(db, 'artifacts', 'is_sensitive'),
  3: db => hasColumn(db, 'sessions', 'last_turn_at'),
  4: db => hasColumn(db, 'sessions', 'custom_title') && hasTable(db, 'title_scan_jobs'),
  5: db => hasColumn(db, 'transcript_replay_jobs', 'reprice_all') || (PROBES[6]!(db) && USAGE_TABLES_DROPPED(db)),
  6: db => hasTable(db, 'usage_source_sessions') && hasTable(db, 'backup_manifest') && hasColumn(db, 'sessions', 'source_client'),
  7: db => hasTable(db, 'session_cost_cache') && hasTable(db, 'session_cost_cache_state'),
  8: db => PROBES[6]!(db) && USAGE_TABLES_DROPPED(db),
  9: db => hasTable(db, 'artifact_manager_state') && hasColumn(db, 'artifacts', 'document_id'),
  10: db => hasColumn(db, 'sessions', 'end_reason'),
  11: db => hasColumn(db, 'sessions', 'last_hook_event_at'),
  // 12 changes no schema, so it cannot be probed. It only raises sensitivity flags and never lowers them, so running it again is safe.
  13: db => hasTable(db, 'artifact_identity_adoptions'),
}

/** True when this migration's effect is already in the database's schema. A migration with no probe is never in effect. */
export function inEffect(db: AtlasDb, m: Migration): boolean {
  const probe = PROBES[m.id]
  return probe !== undefined && probe(db)
}

/**
 * Migration 1 only creates things. On a database that already holds some of them, each statement becomes "IF NOT EXISTS" so the
 * missing ones are created and the present ones are left alone (a file with `artifacts` but no `sessions` is the case seen on
 * the laptop). Used only when adopting an existing schema; a fresh database runs the migration unchanged.
 */
export function createMissingOnly(sql: string): string {
  return sql.replace(/\bCREATE (VIRTUAL TABLE|TABLE|UNIQUE INDEX|INDEX|TRIGGER) (?!IF NOT EXISTS)/g, 'CREATE $1 IF NOT EXISTS ')
}
