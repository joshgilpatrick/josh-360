import type { Migration } from './migrations.ts'

// Migration 7 (spec 2026-10-06 section 3): a disposable copy of each session's direct cost from the local cost ledger, used only
// so the session list and dashboard can sort, filter and sum by cost in SQL. src/ledger/cache.ts refills it whenever the ledger's
// latest finished import or pricing run changes. Deleting every row is always safe; the next refresh rebuilds them.
export const MIGRATION_7: Migration = {
  id: 7,
  name: 'session-cost-cache',
  sql: `
CREATE TABLE session_cost_cache (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  direct_cost_usd REAL,
  status TEXT NOT NULL CHECK (status IN ('priced','unpriced')),
  ledger_import_id INTEGER
);
CREATE INDEX idx_cost_cache_cost ON session_cost_cache(direct_cost_usd);
CREATE TABLE session_cost_cache_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ledger_import_id INTEGER,
  ledger_pricing_run_id INTEGER,
  ledger_finished_at TEXT,
  refreshed_at TEXT NOT NULL
);
`,
}
