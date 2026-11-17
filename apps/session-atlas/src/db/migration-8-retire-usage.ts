import type { Migration } from './migrations.ts'

// Migration 8 (spec 2026-10-06 section 7, rollout step 3): drops Atlas's own usage and pricing tables now that every cost
// number comes from the local cost ledger. Order: the session_usage view first (it reads the tables), then children before
// parents. Kept on purpose: usage_source_sessions (Pi sessions map to the ledger through it), transcript_checkpoints
// (titles and lineage), backup_manifest (this migration's own gate writes it). Guarded in migrate() like migration 6.
export const MIGRATION_8: Migration = {
  id: 8,
  name: 'retire-usage',
  noForeignKeys: true,
  sql: `
DROP VIEW session_usage;
DROP TABLE usage_event_aliases;
DROP TABLE usage_events;
DROP TABLE usage_legacy_adoption_audit;
DROP TABLE usage_legacy_state;
DROP TABLE usage_legacy;
DROP TABLE session_usage_summary;
DROP TABLE usage_provider_aliases;
DROP TABLE usage_adapter_status;
DROP TABLE usage_adapter_session_fence;
DROP TABLE usage_reconcile_jobs;
DROP TABLE usage_operator_audit;
DROP TABLE usage_price_assignment_audit;
DROP TABLE usage_route_resolution_audit;
DROP TABLE usage_source_reconciliation_audit;
DROP TABLE model_pricing;
DROP TABLE source_anomalies;
DROP TABLE atlas_maintenance;
DROP TABLE transcript_replay_jobs;
ALTER TABLE sessions DROP COLUMN native_cost_usd;
ALTER TABLE sessions DROP COLUMN native_cost_unknown;
`,
}
