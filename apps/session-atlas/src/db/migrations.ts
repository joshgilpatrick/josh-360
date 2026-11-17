import type { AtlasDb } from './database.ts'
import { isSensitiveFilename } from '../artifacts/filetype.ts'
import { vendorForModel } from './migration-6-frozen.ts'
import { MIGRATION_6 } from './migration-6-ledger.ts'
import { MIGRATION_7 } from './migration-7-cost-cache.ts'
import { MIGRATION_8 } from './migration-8-retire-usage.ts'
import { MIGRATION_9 } from './migration-9-artifact-manager.ts'
import { reclassifyPhiFolders } from './migration-12-phi-reclassify.ts'

// `after` runs inside the same transaction as `sql`, after it, for work SQL alone cannot do
// (here: applying the JS filename classifier to rows that existed before the column did).
// `noForeignKeys` turns enforcement off for this migration only, outside its transaction (SQLite ignores the pragma inside
// one). Migration 8 needs it: with enforcement on, DROP TABLE on a large parent scans the whole schema and takes minutes.
export type Migration = { id: number; name: string; sql: string; after?: (db: AtlasDb) => void; noForeignKeys?: boolean }

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  root_session_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  agent_type TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'fallback',
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  focus_state TEXT NOT NULL DEFAULT 'metadata-only',
  focus_activated_at TEXT,
  focus_activation_source TEXT,
  start_cwd TEXT,
  resume_cwd TEXT,
  project_name TEXT,
  transcript_path TEXT,
  supervisor_job_id TEXT,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT,
  native_cost_usd REAL,
  native_cost_unknown INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('active','closed','unknown')),
  CHECK (focus_state IN ('metadata-only','active','inactive')),
  CHECK (title_source IN ('fallback','native','worker'))
);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_focus ON sessions(focus_state);
CREATE INDEX idx_sessions_project ON sessions(project_name);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_subagent ON sessions(is_subagent);

CREATE VIRTUAL TABLE sessions_fts USING fts5(
  session_id UNINDEXED, title, summary, project_name, start_cwd,
  content='sessions', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(rowid, session_id, title, summary, project_name, start_cwd)
  VALUES (new.rowid, new.session_id, new.title, new.summary, new.project_name, new.start_cwd);
END;
CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, session_id, title, summary, project_name, start_cwd)
  VALUES ('delete', old.rowid, old.session_id, old.title, old.summary, old.project_name, old.start_cwd);
END;
CREATE TRIGGER sessions_au AFTER UPDATE OF title, summary, project_name, start_cwd ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, session_id, title, summary, project_name, start_cwd)
  VALUES ('delete', old.rowid, old.session_id, old.title, old.summary, old.project_name, old.start_cwd);
  INSERT INTO sessions_fts(rowid, session_id, title, summary, project_name, start_cwd)
  VALUES (new.rowid, new.session_id, new.title, new.summary, new.project_name, new.start_cwd);
END;

CREATE TABLE focus_states (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  main_task TEXT NOT NULL DEFAULT '',
  subtasks_json TEXT NOT NULL DEFAULT '[]',
  open_decisions_json TEXT NOT NULL DEFAULT '[]',
  parked_json TEXT NOT NULL DEFAULT '[]',
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  staleness TEXT NOT NULL DEFAULT 'stale',
  worker_byte_offset INTEGER NOT NULL DEFAULT 0,
  worker_compaction_generation INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at TEXT,
  last_error_category TEXT,
  last_error_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (staleness IN ('current','stale','blocked'))
);

CREATE TABLE session_lineage (
  child_session_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'unknown',
  discovered_at TEXT NOT NULL,
  CHECK (confidence IN ('confirmed','inferred','unknown'))
);
CREATE INDEX idx_lineage_parent ON session_lineage(parent_session_id);
CREATE INDEX idx_lineage_root ON session_lineage(root_session_id);

CREATE TABLE session_usage (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  execution_role TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_usage_fingerprint TEXT,
  pricing_version TEXT,
  estimated_cost_usd REAL,
  cost_status TEXT NOT NULL DEFAULT 'unpriced',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, provider, model, execution_role),
  CHECK (execution_role IN ('main','subagent')),
  CHECK (cost_status IN ('priced','unpriced'))
);

CREATE TABLE model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  pricing_version TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  input_per_mtok REAL NOT NULL,
  output_per_mtok REAL NOT NULL,
  cache_read_per_mtok REAL NOT NULL,
  cache_write_5m_per_mtok REAL NOT NULL,
  cache_write_1h_per_mtok REAL NOT NULL,
  UNIQUE (provider, model, pricing_version)
);
CREATE INDEX idx_pricing_lookup ON model_pricing(provider, model, effective_from DESC);

CREATE TABLE artifacts (
  artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  file_type TEXT NOT NULL DEFAULT 'other',
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  project_name TEXT,
  exists_state TEXT NOT NULL DEFAULT 'present',
  last_verified_at TEXT,
  CHECK (exists_state IN ('present','missing'))
);
CREATE INDEX idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX idx_artifacts_type ON artifacts(file_type);
CREATE INDEX idx_artifacts_ext ON artifacts(extension);
CREATE INDEX idx_artifacts_project ON artifacts(project_name);
CREATE INDEX idx_artifacts_exists ON artifacts(exists_state);

CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  artifact_id UNINDEXED, filename, path, content='artifacts', content_rowid='artifact_id', tokenize='unicode61'
);
CREATE TRIGGER artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, artifact_id, filename, path) VALUES (new.artifact_id, new.artifact_id, new.filename, new.path);
END;
CREATE TRIGGER artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, artifact_id, filename, path) VALUES ('delete', old.artifact_id, old.artifact_id, old.filename, old.path);
END;
CREATE TRIGGER artifacts_au AFTER UPDATE OF filename, path ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, artifact_id, filename, path) VALUES ('delete', old.artifact_id, old.artifact_id, old.filename, old.path);
  INSERT INTO artifacts_fts(rowid, artifact_id, filename, path) VALUES (new.artifact_id, new.artifact_id, new.filename, new.path);
END;

CREATE TABLE artifact_origins (
  artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  detected_via TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, session_id),
  CHECK (relation IN ('creator','reference')),
  CHECK (detected_via IN ('tool_event','watcher','reconcile'))
);
CREATE INDEX idx_origins_session ON artifact_origins(session_id);

CREATE TABLE artifact_candidates (
  candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  detected_via TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (path, session_id, detected_via),
  CHECK (state IN ('pending','confirmed','rejected'))
);
CREATE INDEX idx_candidates_state ON artifact_candidates(state, observed_at);

CREATE TABLE transcript_checkpoints (
  session_id TEXT PRIMARY KEY,
  transcript_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_record_uuid TEXT,
  compaction_generation INTEGER NOT NULL DEFAULT 0,
  compaction_baseline_uuid TEXT,
  usage_fingerprint TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE worker_jobs (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  input_revision INTEGER NOT NULL DEFAULT 0,
  running_revision INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  started_at TEXT,
  last_error_category TEXT,
  last_error_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, kind),
  CHECK (kind IN ('focus','transcript','artifacts')),
  CHECK (state IN ('pending','running','done','quarantined'))
);
CREATE INDEX idx_jobs_claim ON worker_jobs(state, next_attempt_at);

CREATE TABLE events_seen (
  fingerprint TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
CREATE INDEX idx_events_seen_at ON events_seen(seen_at);
`,
  },
  {
    id: 2,
    name: 'sensitive-artifacts-and-attention-acks',
    sql: `
ALTER TABLE artifacts ADD COLUMN is_sensitive INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_artifacts_sensitive ON artifacts(is_sensitive);
CREATE TABLE attention_acks (
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  acked_at TEXT NOT NULL,
  PRIMARY KEY (session_id, reason)
);
`,
    after: db => {
      const rows = db.raw.prepare('SELECT artifact_id, filename FROM artifacts').all() as Array<{ artifact_id: number; filename: string }>
      const flag = db.raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ?')
      for (const r of rows) if (isSensitiveFilename(r.filename)) flag.run(r.artifact_id)
    },
  },
  {
    id: 3,
    name: 'replay-jobs-vendor-and-last-turn',
    sql: `
ALTER TABLE model_pricing ADD COLUMN vendor TEXT;
ALTER TABLE sessions ADD COLUMN last_turn_at TEXT;
ALTER TABLE session_usage ADD COLUMN replay_status TEXT NOT NULL DEFAULT 'na'
  CHECK (replay_status IN ('na','pending','in_progress','complete','failed'));

CREATE TABLE transcript_replay_jobs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  transcript_path TEXT NOT NULL,
  target_byte_offset INTEGER NOT NULL,
  bytes_processed INTEGER NOT NULL DEFAULT 0,
  source_size_at_start INTEGER NOT NULL,
  source_mtime_at_start TEXT NOT NULL,
  -- Persistent aggregate state lets an interrupted multi-pass replay resume without rereading
  -- the already-processed prefix or losing its priced totals. This is job scratch state, not a
  -- second usage ledger; it is deleted with the job/session.
  usage_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  updated_at TEXT NOT NULL,
  CHECK (state IN ('pending','running','done','failed'))
);
CREATE INDEX idx_replay_jobs_state ON transcript_replay_jobs(state, updated_at);
`,
    // Mirrors migration 2's pattern: apply a pure JS classifier to rows that existed before the
    // column did. vendor is informational and never participates in a pricing lookup.
    after: db => {
      const rows = db.raw.prepare('SELECT id, model FROM model_pricing WHERE vendor IS NULL').all() as Array<{ id: number; model: string }>
      const set = db.raw.prepare('UPDATE model_pricing SET vendor = ? WHERE id = ?')
      for (const r of rows) set.run(vendorForModel(r.model), r.id)
    },
  },
  {
    id: 4,
    name: 'custom-title-reconciliation',
    sql: `
ALTER TABLE sessions ADD COLUMN custom_title TEXT;
CREATE TABLE title_scan_jobs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  transcript_path TEXT,
  target_byte_offset INTEGER,
  bytes_processed INTEGER NOT NULL DEFAULT 0,
  latest_custom_title TEXT,
  source_size_at_start INTEGER,
  source_mtime_at_start REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed')),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_title_scan_claim ON title_scan_jobs(state, next_attempt_at);
`,
    after: db => {
      db.raw.prepare('INSERT OR IGNORE INTO title_scan_jobs(session_id, transcript_path, next_attempt_at, updated_at) SELECT session_id, transcript_path, updated_at, updated_at FROM sessions').run()
    },
  },
  {
    id: 5,
    name: 'combined-title-cost-replay',
    sql: `
ALTER TABLE transcript_replay_jobs ADD COLUMN reprice_all INTEGER NOT NULL DEFAULT 0 CHECK (reprice_all IN (0,1));
ALTER TABLE transcript_replay_jobs ADD COLUMN latest_custom_title TEXT;
`,
  },
  MIGRATION_6,
  MIGRATION_7,
  MIGRATION_8,
  MIGRATION_9,
  {
    id: 10,
    name: 'session-end-reason',
    // Additive only (one nullable column, no rebuild, no preflight guard). `closed` + `ended_at` cannot tell a SessionEnd hook from the
    // idle sweep (closeIdleSessions), which closes a session whose Claude process may still run. 'hook' is a confirmed end, 'idle' is
    // the sweep. Rows closed before this migration stay NULL: their cause is unknown and they are never treated as confirmed.
    sql: `ALTER TABLE sessions ADD COLUMN end_reason TEXT CHECK (end_reason IN ('hook','idle'));`,
  },
  {
    id: 11,
    name: 'session-last-hook-event',
    // Additive only (one nullable column, no rebuild, no preflight guard). The latest time, by the hook event's OWN timestamp, at which
    // the session's process was seen doing anything other than ending (a subagent's events count for its root session too). It is the
    // producer's chronology that delivery order cannot fake: last_activity_at mixes service, hook and transcript time and cannot serve.
    // A SessionEnd older than it is stale. Existing rows stay NULL (no chronology known), which changes nothing for them.
    sql: `ALTER TABLE sessions ADD COLUMN last_hook_event_at TEXT;`,
  },
  {
    id: 12,
    name: 'phi-dot-folder-reclassify',
    // No schema change. Commit 91f60d8 widened the PHI segment rule from `phi` to `phi` and `.phi`; rows written before it were classified
    // under the narrower rule and kept is_sensitive = 0 / protected = 0 for `.phi/` paths. The `after` step raises (never lowers) those flags
    // once, in this transaction, so the service never serves the old classification (ruling R91). Pages of 1,000 rows, bounded memory.
    sql: ``,
    after: reclassifyPhiFolders,
  },
  {
    id: 13,
    name: 'artifact-identity-adoptions',
    // Additive only (one new table, no rebuild, no preflight guard). Ruling R93: a newly registered (or reactivated) checkout adopts the
    // root-identity documents catalogued below it in bounded pages, one page per service turn, not inside the registration transaction.
    // One cursor row per checkout root: `after_path` is the last path of the last page done (NULL: not started); the row is deleted when
    // the last page is done. No foreign key to artifact_roots: the service drops a row whose root is gone or inactive, and a cursor must
    // never block (or be cascaded by) a root change. `failures` counts consecutive failed pages (R96): a poison page is moved behind the
    // other checkouts and dropped after a bounded number of tries.
    sql: `CREATE TABLE artifact_identity_adoptions (
  root_id TEXT PRIMARY KEY,
  after_path TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_artifact_identity_adoptions_requested ON artifact_identity_adoptions(requested_at, root_id);`,
  },
]
