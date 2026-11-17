import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMigration6, openLedgerTestDb, openLegacyTestDb, openSevenTestDb } from '../helpers/ledger-db.ts'
import { ledgerActive } from '../../src/db/migration-6-ledger.ts'

const NOW = '2026-09-30T00:00:00.000Z'
// The retired seedPricing wrote one claude-sonnet-5 row at version 2026-06-24 among others; the legacy fixtures only need that row.
function seedSonnetPricing(db: ReturnType<typeof openLegacyTestDb>) {
  db.raw.prepare(`INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, vendor)
    VALUES ('anthropic','claude-sonnet-5','2026-06-24','2026-06-24T00:00:00.000Z',2,10,0.2,2.5,4,'anthropic')`).run()
}
function legacyDb() {
  const db = openLegacyTestDb()
  seedSonnetPricing(db)
  db.raw.prepare(`INSERT INTO sessions (session_id, title, started_at, last_activity_at, created_at, updated_at, start_cwd, transcript_path) VALUES ('s1','t',?,?,?,?,'/w','/w/s1.jsonl')`).run(NOW, NOW, NOW, NOW)
  db.raw.prepare(`INSERT INTO transcript_checkpoints (session_id, transcript_path, byte_offset, updated_at) VALUES ('s1','/w/s1.jsonl',4096,?)`).run(NOW)
  const ins = db.raw.prepare(`INSERT INTO session_usage (session_id, provider, model, execution_role, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, thinking_tokens, message_count, last_usage_fingerprint, pricing_version, estimated_cost_usd, cost_status, updated_at) VALUES ('s1','anthropic',?,?,?,0,0,0,0,0,?,'fp',?,?,?,?)`)
  ins.run('claude-sonnet-5', 'main', 1000, 3, '2026-06-24', 0.002, 'priced', NOW)
  ins.run('claude-mystery-9', 'subagent', 7, 1, null, null, 'unpriced', NOW)
  return db
}
const INSERT_PRICE = `INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok) VALUES (?,?,?,?,1,1,1,1,1)`

test('legacy rows archive exactly and the view reproduces them', () => {
  const db = legacyDb()
  applyMigration6(db)
  const legacy = db.raw.prepare('SELECT model, input_tokens, message_count, estimated_cost_usd, cost_status, last_usage_fingerprint FROM usage_legacy ORDER BY model').all()
  assert.deepEqual(legacy.map(r => ({ ...r })), [
    { model: 'claude-mystery-9', input_tokens: 7, message_count: 1, estimated_cost_usd: null, cost_status: 'unpriced', last_usage_fingerprint: 'fp' },
    { model: 'claude-sonnet-5', input_tokens: 1000, message_count: 3, estimated_cost_usd: 0.002, cost_status: 'priced', last_usage_fingerprint: 'fp' },
  ])
  const view = db.raw.prepare(`SELECT model, input_tokens, cache_write_unclassified_tokens, estimated_cost_usd, cost_status, cost_state, pricing_version, last_usage_fingerprint, unknown_counter_mask, legacy_presence_unknown_mask, migration_pending_group_count FROM session_usage WHERE model = 'claude-sonnet-5'`).get()
  assert.deepEqual({ ...view }, { model: 'claude-sonnet-5', input_tokens: 1000, cache_write_unclassified_tokens: 0, estimated_cost_usd: 0.002, cost_status: 'priced', cost_state: 'priced',
    pricing_version: '2026-06-24', last_usage_fingerprint: null, unknown_counter_mask: 0, legacy_presence_unknown_mask: 95, migration_pending_group_count: 1 })
  const state = db.raw.prepare(`SELECT inclusion_state, frozen_path, frozen_offset, presence_unknown_mask FROM usage_legacy_state WHERE model = 'claude-sonnet-5'`).get()
  assert.deepEqual({ ...state }, { inclusion_state: 'migration-pending', frozen_path: '/w/s1.jsonl', frozen_offset: 4096, presence_unknown_mask: 95 })
  assert.throws(() => db.raw.exec(`UPDATE usage_legacy SET input_tokens = 0`), /immutable/)
  assert.throws(() => db.raw.exec(`DELETE FROM usage_legacy`), /immutable/)
  db.close()
})

test('unpriced legacy row reads back as an unpriced view row with no cost', () => {
  const db = legacyDb()
  applyMigration6(db)
  const r = db.raw.prepare(`SELECT estimated_cost_usd, cost_status, cost_state, known_priced_subtotal_usd, pricing_version, unresolved_legacy_count, legacy_recorded_cost_usd, replay_status FROM session_usage WHERE model = 'claude-mystery-9'`).get()
  assert.deepEqual({ ...r }, { estimated_cost_usd: null, cost_status: 'unpriced', cost_state: 'unpriced', known_priced_subtotal_usd: null, pricing_version: null, unresolved_legacy_count: 1, legacy_recorded_cost_usd: null, replay_status: 'na' })
  db.close()
})

test('legacy state records frozen checkpoint only when one exists', () => {
  const db = legacyDb()
  db.raw.prepare(`INSERT INTO sessions (session_id, title, started_at, last_activity_at, created_at, updated_at) VALUES ('s2','t',?,?,?,?)`).run(NOW, NOW, NOW, NOW)
  db.raw.prepare(`INSERT INTO session_usage (session_id, provider, model, execution_role, input_tokens, message_count, updated_at) VALUES ('s2','anthropic','claude-sonnet-5','main',5,1,?)`).run(NOW)
  applyMigration6(db)
  const s2 = db.raw.prepare(`SELECT frozen_path, frozen_offset, frozen_size, frozen_sha256, reconstruction_state, reason, legacy_present FROM usage_legacy_state WHERE session_id = 's2'`).get()
  assert.deepEqual({ ...s2 }, { frozen_path: null, frozen_offset: null, frozen_size: null, frozen_sha256: null, reconstruction_state: 'pending', reason: 'cutover', legacy_present: 1 })
  const s1 = db.raw.prepare(`SELECT frozen_size FROM usage_legacy_state WHERE session_id = 's1' AND model = 'claude-sonnet-5'`).get() as { frozen_size: number }
  assert.equal(s1.frozen_size, 4096)
  db.close()
})

test('legacy rows whose models normalize to one key merge into one summary row', () => {
  const db = legacyDb()
  db.raw.prepare(`INSERT INTO session_usage (session_id, provider, model, execution_role, input_tokens, output_tokens, thinking_tokens, message_count, pricing_version, estimated_cost_usd, cost_status, updated_at) VALUES ('s1','anthropic','Claude-Sonnet-5-20260101','main',50,9,4,2,'2026-06-24',0.001,'priced',?)`).run(NOW)
  applyMigration6(db)
  // Both legacy rows are archived with their original model strings...
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM usage_legacy WHERE execution_role = 'main'`).get() as { n: number }).n, 2)
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM usage_legacy_state WHERE model = 'claude-sonnet-5'`).get() as { n: number }).n, 2)
  // ...and the summary holds the merged row under the normalized key.
  const rows = db.raw.prepare(`SELECT model, input_tokens_known, output_tokens_known, reasoning_tokens_known, message_count, known_cost_usd, costed_components, unresolved_components, legacy_recorded_cost_usd, legacy_pricing_version FROM session_usage_summary WHERE execution_role = 'main'`).all().map(r => ({ ...r }))
  assert.deepEqual(rows, [{ model: 'claude-sonnet-5', input_tokens_known: 1050, output_tokens_known: 9, reasoning_tokens_known: 4, message_count: 5, known_cost_usd: 0.003, costed_components: 2, unresolved_components: 0, legacy_recorded_cost_usd: 0.003, legacy_pricing_version: '2026-06-24' }])
  db.close()
})

test('merged summary row with differing legacy pricing versions has no single legacy version', () => {
  const db = legacyDb()
  db.raw.prepare(`INSERT INTO session_usage (session_id, provider, model, execution_role, input_tokens, message_count, pricing_version, estimated_cost_usd, cost_status, updated_at) VALUES ('s1','anthropic','claude-sonnet-5-20260101','main',1,1,'2026-01-01',0.5,'priced',?)`).run(NOW)
  applyMigration6(db)
  const summary = db.raw.prepare(`SELECT legacy_pricing_version FROM session_usage_summary WHERE model = 'claude-sonnet-5'`).get()
  assert.deepEqual({ ...summary }, { legacy_pricing_version: null })
  // Contract B's view reports 'mixed' only for differing event versions; two legacy versions with no
  // single survivor read back as unknown rather than a fabricated one.
  const view = db.raw.prepare(`SELECT pricing_version FROM session_usage WHERE model = 'claude-sonnet-5'`).get()
  assert.deepEqual({ ...view }, { pricing_version: null })
  db.close()
})

test('pricing periods: UTC starts, derived ends, synthetic row, guards', () => {
  const db = legacyDb()
  db.raw.exec(`INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok) VALUES ('anthropic','claude-sonnet-5','2027-01-01','2027-01-01',1,5,0.1,1.25,2)`)
  applyMigration6(db)
  const rows = db.raw.prepare(`SELECT pricing_version, effective_from, effective_to FROM model_pricing WHERE model = 'claude-sonnet-5' ORDER BY effective_from`).all().map(r => ({ ...r }))
  assert.deepEqual(rows, [
    { pricing_version: '2026-06-24', effective_from: '2026-06-24T00:00:00.000Z', effective_to: '2027-01-01T00:00:00.000Z' },
    { pricing_version: '2027-01-01', effective_from: '2027-01-01T00:00:00.000Z', effective_to: null },
  ])
  assert.equal((db.raw.prepare(`SELECT pricing_version FROM model_pricing WHERE model = 'claude-sonnet-5' AND effective_to IS NULL`).get() as { pricing_version: string }).pricing_version, '2027-01-01')
  assert.equal((db.raw.prepare(`SELECT input_per_mtok FROM model_pricing WHERE model = '<synthetic>'`).get() as { input_per_mtok: number }).input_per_mtok, 0)
  assert.throws(() => db.raw.exec(`UPDATE model_pricing SET input_per_mtok = 9 WHERE model = 'claude-sonnet-5'`), /immutable/)
  assert.throws(() => db.raw.exec(`UPDATE model_pricing SET effective_to = '2028-01-01T00:00:00.000Z' WHERE pricing_version = '2026-06-24' AND model = 'claude-sonnet-5'`), /once/)
  assert.throws(() => db.raw.exec(`INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok) VALUES ('anthropic','x','v','2027-01-01',1,1,1,1,1)`), /canonical/)
  db.close()
})

test('latest pricing row may be closed once to a later instant, then never again', () => {
  const db = openSevenTestDb()
  db.raw.prepare(INSERT_PRICE).run('anthropic', 'claude-x', 'v1', '2026-01-01T00:00:00.000Z')
  assert.throws(() => db.raw.exec(`UPDATE model_pricing SET effective_to = '2026-01-01T00:00:00.000Z' WHERE model = 'claude-x'`), /once/)
  assert.throws(() => db.raw.exec(`UPDATE model_pricing SET effective_to = NULL WHERE model = 'claude-x'`), /once/)
  db.raw.exec(`UPDATE model_pricing SET effective_to = '2026-02-01T00:00:00.000Z' WHERE model = 'claude-x'`)
  assert.throws(() => db.raw.exec(`UPDATE model_pricing SET effective_to = '2026-03-01T00:00:00.000Z' WHERE model = 'claude-x'`), /once/)
  db.close()
})

test('non-normalized stored model fails closed and leaves the schema unchanged', () => {
  const db = legacyDb()
  db.raw.exec(`INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok) VALUES ('anthropic','Claude-Odd-1','v','2026-06-24',1,1,1,1,1)`)
  assert.equal(ledgerActive(db), false)
  assert.throws(() => applyMigration6(db), /non-normalized-model/)
  assert.equal((db.raw.prepare(`SELECT type FROM sqlite_master WHERE name = 'session_usage'`).get() as { type: string }).type, 'table')
  assert.equal(db.raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'usage_events'`).get(), undefined)
  assert.equal(db.raw.prepare(`SELECT 1 FROM pragma_table_info('model_pricing') WHERE name = 'effective_to'`).get(), undefined)
  assert.equal(ledgerActive(db), false)
  db.close()
})

test('equal converted starts fail closed', () => {
  const db = legacyDb()
  db.raw.exec(`INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok) VALUES ('anthropic','claude-sonnet-5','dup','2026-06-24',1,1,1,1,1)`)
  assert.throws(() => applyMigration6(db), /equal-start/)
  assert.equal(db.raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'usage_events'`).get(), undefined)
  db.close()
})

test('a start that is neither date-only nor canonical fails closed', () => {
  const db = legacyDb()
  db.raw.prepare(INSERT_PRICE).run('anthropic', 'claude-odd', 'v', '2026-6-24')
  assert.throws(() => applyMigration6(db), /non-canonical-start/)
  db.close()
})

test('a pre-existing open <synthetic> row of another version overlaps the seeded one and fails closed', () => {
  const db = legacyDb()
  db.raw.prepare(INSERT_PRICE).run('anthropic', '<synthetic>', 'custom', '2020-01-01')
  assert.throws(() => applyMigration6(db), /bad-period/)
  db.close()
})

test('default Claude alias, self mappings, maintenance gate closed', () => {
  const db = legacyDb()
  applyMigration6(db)
  assert.deepEqual({ ...db.raw.prepare(`SELECT provider, effective_from, effective_to FROM usage_provider_aliases WHERE source_field = '__default__'`).get() }, { provider: 'anthropic', effective_from: '0000-01-01T00:00:00.000Z', effective_to: null })
  assert.throws(() => db.raw.exec(`UPDATE usage_provider_aliases SET effective_to = '2030-01-01T00:00:00.000Z'`), /non-closable/)
  assert.deepEqual({ ...db.raw.prepare(`SELECT source_client, native_session_id, session_id, source_cwd, source_path FROM usage_source_sessions`).get() }, { source_client: 'claude-code', native_session_id: 's1', session_id: 's1', source_cwd: '/w', source_path: '/w/s1.jsonl' })
  assert.equal((db.raw.prepare(`SELECT value FROM atlas_maintenance WHERE key = 'operator-ops-enabled'`).get() as { value: string }).value, '0')
  assert.equal((db.raw.prepare(`SELECT source_client FROM sessions`).get() as { source_client: string }).source_client, 'claude-code')
  assert.equal(ledgerActive(db), true)
  db.close()
})

test('replay jobs that are not done are reset; done jobs are untouched', () => {
  const db = legacyDb()
  db.raw.prepare(`INSERT INTO sessions (session_id, title, started_at, last_activity_at, created_at, updated_at) VALUES ('s2','t',?,?,?,?)`).run(NOW, NOW, NOW, NOW)
  const job = db.raw.prepare(`INSERT INTO transcript_replay_jobs (session_id, transcript_path, target_byte_offset, bytes_processed, source_size_at_start, source_mtime_at_start, usage_json, attempts, state, last_error, updated_at, reprice_all) VALUES (?, '/w/x.jsonl', 100, 50, 100, 'm', '{"old":1}', 3, ?, 'boom', ?, 1)`)
  job.run('s1', 'running', NOW)
  job.run('s2', 'done', NOW)
  applyMigration6(db)
  const rows = db.raw.prepare(`SELECT session_id, state, usage_json, reprice_all, bytes_processed, attempts, last_error FROM transcript_replay_jobs ORDER BY session_id`).all().map(r => ({ ...r }))
  assert.deepEqual(rows, [
    { session_id: 's1', state: 'pending', usage_json: '{}', reprice_all: 0, bytes_processed: 0, attempts: 0, last_error: null },
    { session_id: 's2', state: 'done', usage_json: '{"old":1}', reprice_all: 1, bytes_processed: 50, attempts: 3, last_error: 'boom' },
  ])
  db.close()
})

test('fresh database migrates with an empty archive and only the synthetic price row', () => {
  const db = openSevenTestDb()
  for (const t of ['usage_legacy', 'usage_legacy_state', 'session_usage_summary', 'usage_source_sessions']) {
    assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t)
  }
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM session_usage`).get() as { n: number }).n, 0)
  assert.deepEqual(db.raw.prepare(`SELECT model, pricing_version, effective_from, effective_to, vendor FROM model_pricing`).all().map(r => ({ ...r })),
    [{ model: '<synthetic>', pricing_version: 'non-billable-synthetic', effective_from: '0000-01-01T00:00:00.000Z', effective_to: null, vendor: 'unknown' }])
  db.close()
})

test('audit tables reject updates', () => {
  const db = openSevenTestDb()
  db.raw.exec(`INSERT INTO usage_operator_audit (operation, target_id, detail_json, claimed_actor, claim_source, reason, created_at) VALUES ('x', 1, '{}', 'a', 'local-api', 'r', '${NOW}')`)
  assert.throws(() => db.raw.exec(`UPDATE usage_operator_audit SET reason = 'y'`), /immutable/)
  db.close()
})
