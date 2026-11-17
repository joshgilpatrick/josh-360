import type { AtlasDb } from './database.ts'
import type { Migration } from './migrations.ts'
import { EPOCH_MIN, normalizeModelId, SYNTHETIC_PRICING_ROW, toUtcStart, vendorForModel } from './migration-6-frozen.ts'
import { nowIso } from '../util/time.ts'

// Migration 6 builds the usage ledger schema and turns `session_usage` into a read-only view. It is the last
// entry of MIGRATIONS (src/db/migrations.ts), registered only after every legacy `session_usage` writer was
// removed (the writer-switch barrier). On a legacy database that still holds rows, `migrate()` runs it only
// behind the preflight guard (src/db/preflight.ts). Tests that need the pre-ledger schema use openLegacyDb()
// (test/helpers/ledger-db.ts); everything else gets this schema from openTestDb().

/** Bits 0-4 and 6. The legacy schema had no unclassified cache-write counter, so bit 5 is 0. */
export const LEGACY_PRESENCE_UNKNOWN_MASK = 95
export const MAINTENANCE_FLAG_KEY = 'operator-ops-enabled'
export const CLAUDE_DEFAULT_ALIAS = { sourceClient: 'claude-code', sourceField: '__default__', rawValue: '__absent__', provider: 'anthropic' } as const

export const LEDGER_DDL = `
ALTER TABLE sessions ADD COLUMN source_client TEXT NOT NULL DEFAULT 'claude-code' CHECK (source_client IN ('claude-code','opencode','pi'));
ALTER TABLE sessions ADD COLUMN timestamp_provenance TEXT NOT NULL DEFAULT 'source' CHECK (timestamp_provenance IN ('source','atlas-first-seen'));
CREATE INDEX idx_sessions_source ON sessions(source_client);
ALTER TABLE model_pricing ADD COLUMN effective_to TEXT;

CREATE TABLE usage_source_sessions (
  source_client TEXT NOT NULL, native_session_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
  source_cwd TEXT, source_root TEXT, source_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (source_client, native_session_id));

CREATE TABLE usage_provider_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_client TEXT NOT NULL, source_field TEXT NOT NULL, raw_value TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) > 0), effective_from TEXT NOT NULL, effective_to TEXT,
  created_actor TEXT NOT NULL, created_claim_source TEXT NOT NULL, created_at TEXT NOT NULL, evidence TEXT, reason TEXT NOT NULL,
  closed_actor TEXT, closed_claim_source TEXT, closed_at TEXT, close_reason TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from));
CREATE INDEX idx_alias_key ON usage_provider_aliases(source_client, source_field, raw_value, effective_from);

CREATE TABLE usage_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, source_client TEXT NOT NULL, native_session_id TEXT NOT NULL,
  native_event_id TEXT, fallback_key TEXT, identity_quality TEXT NOT NULL CHECK (identity_quality IN ('native','fallback')),
  execution_role TEXT NOT NULL CHECK (execution_role IN ('main','subagent')),
  route_field TEXT, route_value TEXT, raw_route_json TEXT NOT NULL DEFAULT '{}',
  provider_route TEXT CHECK (provider_route IS NULL OR length(provider_route) > 0), provider_alias_id INTEGER REFERENCES usage_provider_aliases(id), route_reason TEXT,
  raw_model TEXT, model TEXT CHECK (model IS NULL OR length(model) > 0), model_vendor TEXT,
  raw_ts TEXT, ts_utc TEXT, ts_reason TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER, cache_write_unclassified_tokens INTEGER, reasoning_tokens INTEGER,
  present_mask INTEGER NOT NULL DEFAULT 0, reported_cost_usd REAL, completed_at_ms INTEGER, counters_verified INTEGER NOT NULL DEFAULT 0,
  model_pricing_id INTEGER REFERENCES model_pricing(id) ON DELETE RESTRICT,
  assignment_source TEXT CHECK (assignment_source IS NULL OR assignment_source IN ('auto','manual','system-policy')),
  assignment_at TEXT, assignment_actor TEXT, assignment_claim_source TEXT, assignment_reason TEXT, override_flags TEXT NOT NULL DEFAULT '[]',
  review_flag INTEGER NOT NULL DEFAULT 0, unresolved_reason TEXT,
  source_generation TEXT NOT NULL, source_offset INTEGER, source_seq INTEGER,
  superseded_by INTEGER REFERENCES usage_events(event_id),
  legacy_scope TEXT NOT NULL DEFAULT 'none' CHECK (legacy_scope IN ('none','staged-prefix','held-tail','straddler','tail')),
  legacy_state_id INTEGER, cutover_snapshot_json TEXT, legacy_message_counted INTEGER NOT NULL DEFAULT 0,
  applied_contribution_json TEXT,
  first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((native_event_id IS NULL) <> (fallback_key IS NULL)));
CREATE UNIQUE INDEX ux_events_native ON usage_events(source_client, native_session_id, native_event_id) WHERE native_event_id IS NOT NULL;
CREATE UNIQUE INDEX ux_events_fallback ON usage_events(source_client, native_session_id, fallback_key) WHERE fallback_key IS NOT NULL;
CREATE INDEX idx_events_session ON usage_events(session_id);
CREATE INDEX idx_events_unresolved ON usage_events(model_pricing_id, unresolved_reason);
CREATE INDEX idx_events_price ON usage_events(model_pricing_id, ts_utc);

CREATE TABLE usage_event_aliases (old_event_id INTEGER NOT NULL PRIMARY KEY REFERENCES usage_events(event_id), new_event_id INTEGER NOT NULL REFERENCES usage_events(event_id), reason TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE usage_price_assignment_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, prior_pricing_id INTEGER, new_pricing_id INTEGER,
  claimed_actor TEXT NOT NULL, claim_source TEXT NOT NULL CHECK (claim_source IN ('local-api','system')), reason TEXT NOT NULL, override_flags TEXT NOT NULL,
  before_cost_usd REAL, after_cost_usd REAL, before_status TEXT NOT NULL, after_status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE usage_route_resolution_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, prior_route TEXT, new_route TEXT, prior_alias_id INTEGER, new_alias_id INTEGER,
  claimed_actor TEXT NOT NULL, claim_source TEXT NOT NULL, reason TEXT NOT NULL, before_cost_usd REAL, after_cost_usd REAL, before_status TEXT NOT NULL, after_status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE usage_source_reconciliation_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, change_kind TEXT NOT NULL, prior_pricing_id INTEGER, new_pricing_id INTEGER,
  prior_route TEXT, new_route TEXT, before_cost_usd REAL, after_cost_usd REAL, before_status TEXT NOT NULL, after_status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE usage_legacy_adoption_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_state_id INTEGER NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, claimed_actor TEXT NOT NULL, claim_source TEXT NOT NULL, reason TEXT NOT NULL,
  accept_usage_difference INTEGER NOT NULL, accept_cost_change INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE usage_operator_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, target_id INTEGER, detail_json TEXT NOT NULL,
  claimed_actor TEXT NOT NULL, claim_source TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER audit_price_immutable BEFORE UPDATE ON usage_price_assignment_audit BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
CREATE TRIGGER audit_route_immutable BEFORE UPDATE ON usage_route_resolution_audit BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
CREATE TRIGGER audit_recon_immutable BEFORE UPDATE ON usage_source_reconciliation_audit BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
CREATE TRIGGER audit_adopt_immutable BEFORE UPDATE ON usage_legacy_adoption_audit BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
CREATE TRIGGER audit_op_immutable BEFORE UPDATE ON usage_operator_audit BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;

CREATE TABLE usage_adapter_session_fence (
  source_client TEXT NOT NULL, native_session_id TEXT NOT NULL, adapter_epoch INTEGER NOT NULL, last_applied_seq INTEGER NOT NULL DEFAULT 0,
  callback_generation INTEGER NOT NULL DEFAULT 0, last_scan_fence INTEGER, last_scan_mode TEXT, last_scan_record_count INTEGER,
  scan_settled INTEGER NOT NULL DEFAULT 0, gap_first_seen TEXT, gap_attempts INTEGER NOT NULL DEFAULT 0, release_through_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY (source_client, native_session_id));
CREATE TABLE usage_adapter_status (source_client TEXT PRIMARY KEY, configured INTEGER NOT NULL DEFAULT 0, installed_at TEXT, uninstalled_at TEXT,
  last_heartbeat_at TEXT, lease_expires_at TEXT, updated_at TEXT NOT NULL);

CREATE TABLE usage_reconcile_jobs (
  source_client TEXT NOT NULL CHECK (source_client = 'pi'), native_session_id TEXT NOT NULL, job_kind TEXT NOT NULL CHECK (job_kind = 'scan'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','complete','failed')),
  file_path TEXT NOT NULL, file_dev INTEGER, file_ino INTEGER, file_size INTEGER NOT NULL DEFAULT 0, file_mtime_ms INTEGER, byte_offset INTEGER NOT NULL DEFAULT 0,
  dirty_generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_expires_at TEXT, diagnostic TEXT,
  failed_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (source_client, native_session_id, job_kind));
CREATE INDEX idx_reconcile_claim ON usage_reconcile_jobs(state, next_attempt_at);

CREATE TABLE source_anomalies (
  anomaly_id INTEGER PRIMARY KEY AUTOINCREMENT, source_client TEXT NOT NULL, native_session_id TEXT NOT NULL, anomaly_kind TEXT NOT NULL,
  source_identity TEXT NOT NULL, field TEXT, range_start INTEGER, range_end INTEGER, blocking INTEGER NOT NULL DEFAULT 0, hint_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, resolved_at TEXT,
  UNIQUE (source_client, native_session_id, anomaly_kind, source_identity));
CREATE INDEX idx_anomalies_open ON source_anomalies(source_client, native_session_id, resolved_at);

CREATE TABLE usage_legacy (
  legacy_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, execution_role TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL, thinking_tokens INTEGER NOT NULL, message_count INTEGER NOT NULL, last_usage_fingerprint TEXT,
  pricing_version TEXT, estimated_cost_usd REAL, cost_status TEXT NOT NULL, replay_status TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (session_id, provider, model, execution_role));
CREATE TRIGGER legacy_immutable BEFORE UPDATE ON usage_legacy BEGIN SELECT RAISE(ABORT, 'usage_legacy is immutable'); END;
CREATE TRIGGER legacy_nodelete BEFORE DELETE ON usage_legacy BEGIN SELECT RAISE(ABORT, 'usage_legacy is immutable'); END;

CREATE TABLE usage_legacy_state (
  legacy_state_id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_id INTEGER UNIQUE REFERENCES usage_legacy(legacy_id),
  session_id TEXT NOT NULL, provider TEXT, model TEXT, execution_role TEXT NOT NULL,
  inclusion_state TEXT NOT NULL CHECK (inclusion_state IN ('legacy-baseline','events-adopted','unmatched','source-missing','migration-pending')),
  legacy_present INTEGER NOT NULL, presence_unknown_mask INTEGER NOT NULL DEFAULT 0, reason TEXT,
  frozen_path TEXT, frozen_offset INTEGER, frozen_size INTEGER, frozen_sha256 TEXT,
  reconstruction_state TEXT NOT NULL DEFAULT 'pending' CHECK (reconstruction_state IN ('pending','complete','failed')),
  updated_at TEXT NOT NULL);
CREATE INDEX idx_legacy_state_session ON usage_legacy_state(session_id);

CREATE TABLE session_usage_summary (
  summary_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, provider TEXT, model TEXT, execution_role TEXT NOT NULL,
  input_tokens_known INTEGER NOT NULL DEFAULT 0, input_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  output_tokens_known INTEGER NOT NULL DEFAULT 0, output_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens_known INTEGER NOT NULL DEFAULT 0, cache_read_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens_known INTEGER NOT NULL DEFAULT 0, cache_write_5m_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens_known INTEGER NOT NULL DEFAULT 0, cache_write_1h_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  cache_write_unclassified_tokens_known INTEGER NOT NULL DEFAULT 0, cache_write_unclassified_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens_known INTEGER NOT NULL DEFAULT 0, reasoning_tokens_unknown INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0, known_cost_usd REAL NOT NULL DEFAULT 0,
  costed_components INTEGER NOT NULL DEFAULT 0, unresolved_components INTEGER NOT NULL DEFAULT 0,
  unresolved_event_count INTEGER NOT NULL DEFAULT 0, unresolved_legacy_count INTEGER NOT NULL DEFAULT 0,
  unadopted_prefix_group_count INTEGER NOT NULL DEFAULT 0, migration_pending_group_count INTEGER NOT NULL DEFAULT 0,
  legacy_recorded_cost_usd REAL, legacy_presence_unknown_mask INTEGER NOT NULL DEFAULT 0,
  pricing_versions_json TEXT NOT NULL DEFAULT '{}', legacy_pricing_version TEXT, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX ux_summary_key ON session_usage_summary(session_id, COALESCE(provider, char(0)), COALESCE(model, char(0)), execution_role);

CREATE TABLE atlas_maintenance (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE backup_manifest (backup_id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preflight','post-cutover','baseline')), schema_version INTEGER NOT NULL, restore_eligible INTEGER NOT NULL DEFAULT 1,
  is_restore_baseline INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
`

export const SESSION_USAGE_VIEW = `
CREATE VIEW session_usage AS SELECT
  s.session_id, s.provider, s.model, s.execution_role,
  CASE WHEN s.input_tokens_unknown > 0 THEN NULL ELSE s.input_tokens_known END AS input_tokens,
  CASE WHEN s.output_tokens_unknown > 0 THEN NULL ELSE s.output_tokens_known END AS output_tokens,
  CASE WHEN s.cache_read_tokens_unknown > 0 THEN NULL ELSE s.cache_read_tokens_known END AS cache_read_tokens,
  CASE WHEN s.cache_write_5m_tokens_unknown > 0 THEN NULL ELSE s.cache_write_5m_tokens_known END AS cache_write_5m_tokens,
  CASE WHEN s.cache_write_1h_tokens_unknown > 0 THEN NULL ELSE s.cache_write_1h_tokens_known END AS cache_write_1h_tokens,
  CASE WHEN s.cache_write_unclassified_tokens_unknown > 0 THEN NULL ELSE s.cache_write_unclassified_tokens_known END AS cache_write_unclassified_tokens,
  CASE WHEN s.reasoning_tokens_unknown > 0 THEN NULL ELSE s.reasoning_tokens_known END AS reasoning_tokens,
  CASE WHEN s.reasoning_tokens_unknown > 0 THEN NULL ELSE s.reasoning_tokens_known END AS thinking_tokens,
  s.message_count, NULL AS last_usage_fingerprint,
  CASE WHEN s.legacy_pricing_version IS NOT NULL AND s.pricing_versions_json = '{}' THEN s.legacy_pricing_version
       WHEN (SELECT COUNT(*) FROM json_each(s.pricing_versions_json)) = 1 AND s.legacy_pricing_version IS NULL THEN (SELECT key FROM json_each(s.pricing_versions_json))
       WHEN (SELECT COUNT(*) FROM json_each(s.pricing_versions_json)) = 1 AND s.legacy_pricing_version = (SELECT key FROM json_each(s.pricing_versions_json)) THEN s.legacy_pricing_version
       WHEN (SELECT COUNT(*) FROM json_each(s.pricing_versions_json)) = 0 THEN NULL ELSE 'mixed' END AS pricing_version,
  CASE WHEN s.unresolved_components = 0 AND s.costed_components > 0 THEN s.known_cost_usd ELSE NULL END AS estimated_cost_usd,
  CASE WHEN s.unresolved_components = 0 AND s.costed_components > 0 THEN 'priced' ELSE 'unpriced' END AS cost_status,
  CASE WHEN s.unresolved_components = 0 AND s.costed_components > 0 THEN 'priced' WHEN s.costed_components > 0 THEN 'partial' ELSE 'unpriced' END AS cost_state,
  CASE WHEN s.costed_components > 0 THEN s.known_cost_usd ELSE NULL END AS known_priced_subtotal_usd,
  (CASE WHEN s.input_tokens_unknown > 0 THEN 1 ELSE 0 END) | (CASE WHEN s.output_tokens_unknown > 0 THEN 2 ELSE 0 END)
    | (CASE WHEN s.cache_read_tokens_unknown > 0 THEN 4 ELSE 0 END) | (CASE WHEN s.cache_write_5m_tokens_unknown > 0 THEN 8 ELSE 0 END)
    | (CASE WHEN s.cache_write_1h_tokens_unknown > 0 THEN 16 ELSE 0 END) | (CASE WHEN s.cache_write_unclassified_tokens_unknown > 0 THEN 32 ELSE 0 END)
    | (CASE WHEN s.reasoning_tokens_unknown > 0 THEN 64 ELSE 0 END) AS unknown_counter_mask,
  s.legacy_presence_unknown_mask, s.legacy_recorded_cost_usd, s.unresolved_event_count, s.unresolved_legacy_count,
  s.unadopted_prefix_group_count, s.migration_pending_group_count,
  (SELECT COUNT(*) FROM source_anomalies a JOIN usage_source_sessions m ON m.source_client = a.source_client AND m.native_session_id = a.native_session_id
    WHERE m.session_id = s.session_id AND a.resolved_at IS NULL) AS source_anomaly_count,
  COALESCE((SELECT CASE j.state WHEN 'running' THEN 'in_progress' WHEN 'done' THEN 'complete' ELSE j.state END
    FROM transcript_replay_jobs j JOIN sessions ss ON ss.session_id = j.session_id WHERE j.session_id = s.session_id AND ss.source_client = 'claude-code'), 'na') AS replay_status,
  s.updated_at
FROM session_usage_summary s;
`

export const LEDGER_GUARDS = `
CREATE TRIGGER pricing_identity_immutable BEFORE UPDATE OF provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok ON model_pricing
BEGIN SELECT RAISE(ABORT, 'model_pricing rows are immutable'); END;
CREATE TRIGGER pricing_close_once BEFORE UPDATE OF effective_to ON model_pricing
WHEN OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.effective_to <= OLD.effective_from
BEGIN SELECT RAISE(ABORT, 'effective_to may be set once to a later instant'); END;
CREATE TRIGGER pricing_canonical_insert BEFORE INSERT ON model_pricing
WHEN NEW.effective_from NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
BEGIN SELECT RAISE(ABORT, 'model_pricing.effective_from must be canonical UTC'); END;
CREATE TRIGGER alias_identity_immutable BEFORE UPDATE OF source_client, source_field, raw_value, provider, effective_from, created_actor, created_claim_source, created_at, evidence, reason ON usage_provider_aliases
BEGIN SELECT RAISE(ABORT, 'alias rows are immutable'); END;
CREATE TRIGGER alias_close_once BEFORE UPDATE OF effective_to ON usage_provider_aliases
WHEN OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.effective_to <= OLD.effective_from OR OLD.source_field = '__default__'
BEGIN SELECT RAISE(ABORT, 'alias may be closed once; default alias is non-closable'); END;
CREATE TRIGGER alias_no_delete BEFORE DELETE ON usage_provider_aliases BEGIN SELECT RAISE(ABORT, 'alias rows are append-only'); END;
`

function fail(reason: string): never {
  throw new Error(`migration-6: ${reason}`)
}

// Step 1. Fail closed on any stored model the real normalizer would change; rewrite nothing.
function preflightModels(db: AtlasDb): void {
  const rows = db.raw.prepare('SELECT id, model FROM model_pricing ORDER BY id').all() as Array<{ id: number; model: string }>
  for (const r of rows) if (r.model !== normalizeModelId(r.model)) fail(`non-normalized-model ${r.id}`)
}

// Step 2. Date-only starts become fixed-width UTC midnight; anything else non-canonical fails.
function convertStarts(db: AtlasDb): void {
  db.raw.exec(`UPDATE model_pricing SET effective_from = effective_from || 'T00:00:00.000Z' WHERE length(effective_from) = 10`)
  const rows = db.raw.prepare('SELECT id, effective_from FROM model_pricing ORDER BY id').all() as Array<{ id: number; effective_from: string }>
  for (const r of rows) {
    let canonical = false
    try { canonical = toUtcStart(r.effective_from) === r.effective_from } catch { canonical = false }
    if (!canonical) fail(`non-canonical-start ${r.id}`)
  }
}

// Step 3.
function checkEqualStarts(db: AtlasDb): void {
  const dup = db.raw.prepare(`SELECT provider, model FROM model_pricing GROUP BY provider, model, effective_from HAVING COUNT(*) > 1 ORDER BY provider, model LIMIT 1`).get() as { provider: string; model: string } | undefined
  if (dup) fail(`equal-start ${dup.provider}/${dup.model}`)
}

// Step 4. Each non-latest row ends where the next row for the same provider/model begins.
function backfillEnds(db: AtlasDb): void {
  db.raw.exec(`UPDATE model_pricing SET effective_to = (SELECT MIN(n.effective_from) FROM model_pricing n
    WHERE n.provider = model_pricing.provider AND n.model = model_pricing.model AND n.effective_from > model_pricing.effective_from)`)
}

// Step 5 (also re-run after step 6). Zero-length periods and overlaps fail closed.
function checkPeriods(db: AtlasDb): void {
  const zero = db.raw.prepare('SELECT id FROM model_pricing WHERE effective_to IS NOT NULL AND effective_to <= effective_from ORDER BY id LIMIT 1').get() as { id: number } | undefined
  if (zero) fail(`bad-period ${zero.id}`)
  const overlap = db.raw.prepare(`SELECT a.id AS id FROM model_pricing a JOIN model_pricing b ON a.provider = b.provider AND a.model = b.model AND a.id < b.id
    WHERE a.effective_from < COALESCE(b.effective_to, '9999') AND b.effective_from < COALESCE(a.effective_to, '9999') ORDER BY a.id LIMIT 1`).get() as { id: number } | undefined
  if (overlap) fail(`bad-period ${overlap.id}`)
}

// Step 6. The reserved zero-rate row for non-billable synthetic messages.
function insertSynthetic(db: AtlasDb): void {
  const p = SYNTHETIC_PRICING_ROW
  db.raw.prepare(`INSERT OR IGNORE INTO model_pricing (provider, model, pricing_version, effective_from, effective_to, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, vendor)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(p.provider, p.model, p.pricingVersion, p.effectiveFrom, p.inputPerMtok, p.outputPerMtok, p.cacheReadPerMtok, p.cacheWrite5mPerMtok, p.cacheWrite1hPerMtok, vendorForModel('<synthetic>'))
}

// Step 7.
function installGuards(db: AtlasDb): void {
  db.raw.exec(LEDGER_GUARDS)
}

// Step 8. Every existing Claude session maps to itself.
function mapSources(db: AtlasDb, now: string): void {
  db.raw.prepare(`INSERT OR IGNORE INTO usage_source_sessions (source_client, native_session_id, session_id, source_cwd, source_root, source_path, created_at, updated_at)
    SELECT 'claude-code', session_id, session_id, start_cwd, NULL, transcript_path, ?, ? FROM sessions`).run(now, now)
}

// Step 9.
function insertDefaultAlias(db: AtlasDb, now: string): void {
  const a = CLAUDE_DEFAULT_ALIAS
  db.raw.prepare(`INSERT INTO usage_provider_aliases (source_client, source_field, raw_value, provider, effective_from, effective_to, created_actor, created_claim_source, created_at, evidence, reason)
    VALUES (?, ?, ?, ?, ?, NULL, 'system', 'system', ?, NULL, ?)`)
    .run(a.sourceClient, a.sourceField, a.rawValue, a.provider, EPOCH_MIN, now, 'migration-6 default Claude route (spec §3)')
}

type LegacyRow = {
  legacy_id: number; session_id: string; provider: string; model: string; execution_role: string
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_5m_tokens: number; cache_write_1h_tokens: number
  thinking_tokens: number; message_count: number; pricing_version: string | null; estimated_cost_usd: number | null; cost_status: string
}

// Step 10. Copy every stored value exactly, including the legacy fingerprint and replay status.
function archiveLegacy(db: AtlasDb): void {
  db.raw.exec(`INSERT INTO usage_legacy (session_id, provider, model, execution_role, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, thinking_tokens, message_count, last_usage_fingerprint, pricing_version, estimated_cost_usd, cost_status, replay_status, updated_at)
    SELECT session_id, provider, model, execution_role, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, thinking_tokens, message_count, last_usage_fingerprint, pricing_version, estimated_cost_usd, cost_status, replay_status, updated_at FROM session_usage ORDER BY rowid`)
}

const normalizedOrNull = (model: string): string | null => normalizeModelId(model) || null

// Step 11. Every archived aggregate starts migration-pending; the prefix job hashes the frozen bytes later.
function seedLegacyState(db: AtlasDb, rows: LegacyRow[], now: string): void {
  const checkpoint = db.raw.prepare('SELECT transcript_path, byte_offset FROM transcript_checkpoints WHERE session_id = ?')
  const insert = db.raw.prepare(`INSERT INTO usage_legacy_state (legacy_id, session_id, provider, model, execution_role, inclusion_state, legacy_present, presence_unknown_mask, reason,
      frozen_path, frozen_offset, frozen_size, frozen_sha256, reconstruction_state, updated_at)
    VALUES (?, ?, ?, ?, ?, 'migration-pending', 1, ?, 'cutover', ?, ?, ?, NULL, 'pending', ?)`)
  for (const r of rows) {
    const cp = checkpoint.get(r.session_id) as { transcript_path: string; byte_offset: number } | undefined
    insert.run(r.legacy_id, r.session_id, r.provider, normalizedOrNull(r.model), r.execution_role, LEGACY_PRESENCE_UNKNOWN_MASK,
      cp?.transcript_path ?? null, cp?.byte_offset ?? null, cp?.byte_offset ?? null, now)
  }
}

// Step 12. One summary row per (session, provider, normalized model, role); colliding legacy rows add up.
function seedSummary(db: AtlasDb, rows: LegacyRow[], now: string): void {
  type Group = { session_id: string; provider: string; model: string | null; execution_role: string; rows: LegacyRow[] }
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const model = normalizedOrNull(r.model)
    const key = JSON.stringify([r.session_id, r.provider, model, r.execution_role])
    const g = groups.get(key)
    if (g) g.rows.push(r)
    else groups.set(key, { session_id: r.session_id, provider: r.provider, model, execution_role: r.execution_role, rows: [r] })
  }
  const insert = db.raw.prepare(`INSERT INTO session_usage_summary (session_id, provider, model, execution_role,
      input_tokens_known, output_tokens_known, cache_read_tokens_known, cache_write_5m_tokens_known, cache_write_1h_tokens_known, cache_write_unclassified_tokens_known, reasoning_tokens_known,
      message_count, known_cost_usd, costed_components, unresolved_components, unresolved_legacy_count, migration_pending_group_count,
      legacy_recorded_cost_usd, legacy_presence_unknown_mask, pricing_versions_json, legacy_pricing_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?, '{}', ?, ?)`)
  const sum = (g: Group, pick: (r: LegacyRow) => number): number => g.rows.reduce((t, r) => t + pick(r), 0)
  for (const g of groups.values()) {
    const priced = g.rows.filter(r => r.cost_status === 'priced')
    const unresolved = g.rows.length - priced.length
    const versions = new Set(g.rows.map(r => r.pricing_version))
    const single = versions.size === 1 ? [...versions][0] ?? null : null
    insert.run(g.session_id, g.provider, g.model, g.execution_role,
      sum(g, r => r.input_tokens), sum(g, r => r.output_tokens), sum(g, r => r.cache_read_tokens), sum(g, r => r.cache_write_5m_tokens), sum(g, r => r.cache_write_1h_tokens), sum(g, r => r.thinking_tokens),
      sum(g, r => r.message_count), sum(g, r => r.estimated_cost_usd ?? 0), priced.length, unresolved, unresolved,
      priced.length > 0 ? priced.reduce((t, r) => t + (r.estimated_cost_usd ?? 0), 0) : null, LEGACY_PRESENCE_UNKNOWN_MASK, single, now)
  }
}

// Step 13.
function swapTableForView(db: AtlasDb): void {
  db.raw.exec('DROP TABLE session_usage')
  db.raw.exec(SESSION_USAGE_VIEW)
}

// Step 14. Old priced aggregates in job scratch state are discarded; finished jobs are left alone.
function rewriteReplayJobs(db: AtlasDb, now: string): void {
  db.raw.prepare(`UPDATE transcript_replay_jobs SET usage_json = '{}', reprice_all = 0, state = 'pending', bytes_processed = 0, attempts = 0, last_error = NULL, updated_at = ? WHERE state <> 'done'`).run(now)
}

// Step 15. Operator operations stay off until the post-cutover validation command opens the gate.
function closeMaintenanceGate(db: AtlasDb, now: string): void {
  db.raw.prepare('INSERT INTO atlas_maintenance (key, value, updated_at) VALUES (?, ?, ?)').run(MAINTENANCE_FLAG_KEY, '0', now)
}

/** Runs inside the migration transaction, after `LEDGER_DDL`. Any failure throws and rolls everything back. */
export function ledgerAfter(db: AtlasDb): void {
  const now = nowIso()
  preflightModels(db)
  convertStarts(db)
  checkEqualStarts(db)
  backfillEnds(db)
  checkPeriods(db)
  insertSynthetic(db)
  checkPeriods(db)
  installGuards(db)
  mapSources(db, now)
  insertDefaultAlias(db, now)
  archiveLegacy(db)
  const legacy = db.raw.prepare('SELECT legacy_id, session_id, provider, model, execution_role, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, thinking_tokens, message_count, pricing_version, estimated_cost_usd, cost_status FROM usage_legacy ORDER BY legacy_id').all() as LegacyRow[]
  seedLegacyState(db, legacy, now)
  seedSummary(db, legacy, now)
  swapTableForView(db)
  rewriteReplayJobs(db, now)
  closeMaintenanceGate(db, now)
}

export const MIGRATION_6: Migration = { id: 6, name: 'usage-ledger', sql: LEDGER_DDL, after: ledgerAfter }

/** True once migration 6 has been applied. Deliberately uncached: tests apply it mid-life. */
export function ledgerActive(db: AtlasDb): boolean {
  return db.raw.prepare('SELECT 1 FROM schema_migrations WHERE id = 6').get() !== undefined
}
