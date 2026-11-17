import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, tableNames } from '../helpers/db.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { openLegacyTestDb } from '../helpers/ledger-db.ts'

const cols = (db: ReturnType<typeof openTestDb>, table: string): Record<string, { type: string; notnull: number; dflt: unknown }> => {
  const rows = db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>
  return Object.fromEntries(rows.map(r => [r.name, { type: r.type, notnull: r.notnull, dflt: r.dflt_value }]))
}

// Migration 6 turns session_usage into a view, so the migration-3 schema is checked on a database migrated to 3 only.
test('migration 3 adds the additive columns without disturbing existing ones', () => {
  const db = openLegacyTestDb(3)
  const pricing = cols(db, 'model_pricing')
  assert.ok('vendor' in pricing, 'model_pricing.vendor exists')
  assert.equal(pricing.vendor!.notnull, 0, 'vendor is nullable')
  assert.ok('input_per_mtok' in pricing, 'existing pricing columns are untouched')

  const sessions = cols(db, 'sessions')
  assert.ok('last_turn_at' in sessions)
  assert.equal(sessions.last_turn_at!.notnull, 0)
  assert.ok('last_activity_at' in sessions, 'last_activity_at keeps its existing semantics')

  const usage = cols(db, 'session_usage')
  assert.ok('replay_status' in usage)
  assert.equal(usage.replay_status!.notnull, 1)
  assert.match(String(usage.replay_status!.dflt), /na/)
})

test('migration 3 creates transcript_replay_jobs with its state constraint and index', () => {
  const db = openLegacyTestDb(3)
  assert.ok(tableNames(db).includes('transcript_replay_jobs'))
  const c = cols(db, 'transcript_replay_jobs')
  for (const name of ['session_id', 'transcript_path', 'target_byte_offset', 'bytes_processed',
    'source_size_at_start', 'source_mtime_at_start', 'usage_json', 'attempts', 'state', 'last_error', 'updated_at']) {
    assert.ok(name in c, `${name} column exists`)
  }
  const idx = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transcript_replay_jobs'").all() as Array<{ name: string }>
  assert.ok(idx.some(r => r.name === 'idx_replay_jobs_state'))
  assert.throws(() => db.raw.prepare(
    `INSERT INTO transcript_replay_jobs (session_id, transcript_path, target_byte_offset, source_size_at_start, source_mtime_at_start, updated_at)
     VALUES ('s', '/p', 1, 1, 'x', 'x')`).run(), /FOREIGN KEY/, 'session_id is a real foreign key')
})

test('session_usage.replay_status only accepts the five known states', () => {
  const db = openLegacyTestDb(3)
  db.raw.prepare(`INSERT INTO sessions (session_id, root_session_id, title, status, focus_state, started_at, last_activity_at, created_at, updated_at)
    VALUES ('s1', 's1', 't', 'active', 'metadata-only', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')`).run()
  const insert = (status: string) => db.raw.prepare(
    `INSERT INTO session_usage (session_id, provider, model, execution_role, replay_status, updated_at)
     VALUES ('s1', 'anthropic', ?, 'main', ?, '2026-09-22T00:00:00.000Z')`)
  for (const s of ['na', 'pending', 'in_progress', 'complete', 'failed']) insert(s).run(`m-${s}`, s)
  assert.throws(() => insert('bogus').run('m-bogus', 'bogus'), /CHECK/)
})

test('the migration backfills vendor for rows inserted before the column existed', () => {
  const db = openLegacyTestDb(3)
  // Simulate a pre-migration row: a priced model whose vendor was never written.
  db.raw.prepare(`INSERT INTO model_pricing (provider, model, pricing_version, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, vendor)
    VALUES ('anthropic','claude-opus-5','2026-06-24','2026-06-24T00:00:00.000Z',1,1,1,1,1,NULL)`).run()
  const back = db.raw.prepare('SELECT vendor FROM model_pricing WHERE model = ?').get('claude-opus-5') as { vendor: string | null }
  assert.equal(back.vendor, null, 'precondition: the row is now unlabelled')
  // Invoke migration 3's real callback so this test covers its backfill behavior.
  const after = MIGRATIONS.find(m => m.id === 3)?.after
  assert.ok(after, 'migration 3 has an after hook')
  after(db)
  assert.equal((db.raw.prepare('SELECT vendor FROM model_pricing WHERE model = ?').get('claude-opus-5') as { vendor: string }).vendor, 'anthropic')
})
