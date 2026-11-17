import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger } from '../../src/costledger/db.ts'
import { openTestLedger, insertTestMessage } from '../helpers/costledger.ts'
import { tempDir } from '../helpers/tmp.ts'

function createLegacyLedger(path: string): void {
  const raw = new DatabaseSync(path)
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, tool TEXT NOT NULL, source_message_id TEXT NOT NULL, source_session_id TEXT,
      ts_utc TEXT NOT NULL, model_raw TEXT NOT NULL, provider_raw TEXT, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_5m_tokens INTEGER, cache_write_1h_tokens INTEGER,
      cache_write_unclassified_tokens INTEGER, logged_cost_usd REAL, is_sidechain INTEGER NOT NULL DEFAULT 0,
      cwd TEXT, git_branch TEXT, repo_key TEXT, worktree_path TEXT, attribution_quality TEXT NOT NULL,
      usage_status TEXT NOT NULL, suspect INTEGER NOT NULL DEFAULT 0, source_path TEXT NOT NULL,
      source_locator TEXT NOT NULL, UNIQUE (tool, source_message_id)
    );
    CREATE TABLE pricing_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, note TEXT);
    CREATE TABLE message_costs (
      run_id INTEGER NOT NULL REFERENCES pricing_runs (id), message_id INTEGER NOT NULL REFERENCES messages (id),
      model_id TEXT, computed_cost_usd REAL, price_ids TEXT,
      pricing_status TEXT NOT NULL CHECK (pricing_status IN ('priced','missing_price','missing_alias','suspect','no_usage')),
      PRIMARY KEY (run_id, message_id)
    );
    INSERT INTO pricing_runs (id, started_at) VALUES (1, '2026-10-01T00:00:00.000Z');
    INSERT INTO messages (id, tool, source_message_id, source_session_id, ts_utc, model_raw, attribution_quality,
      usage_status, source_path, source_locator)
    VALUES (7, 'claude-code', 'same-id', 'session-a', '2026-10-01T00:00:00.000Z', 'model', 'exact', 'ok', '/t/a.jsonl', 'line:1');
    INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status)
    VALUES (1, 7, 'model', 0.25, 'priced');
  `)
  raw.close()
}

test('schema has every table later tasks use', () => {
  const db = openTestLedger()
  const names = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
  for (const t of ['source_files', 'repos', 'messages', 'models', 'model_aliases', 'prices', 'pricing_runs', 'message_costs', 'import_runs']) {
    assert.ok(names.includes(t), `missing table ${t}`)
  }
  db.close()
})

test('upgrades the old message key without losing rows or dependent costs', () => {
  const path = join(tempDir('costledger-legacy-'), 'ledger.db')
  createLegacyLedger(path)
  const db = openLedger(path, { allowIdentityMigration: true })
  const existing = db.raw.prepare('SELECT id, source_session_id FROM messages WHERE source_message_id = ?').get('same-id') as { id: number; source_session_id: string }
  assert.equal(existing.id, 7)
  assert.equal(existing.source_session_id, 'session-a')
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM message_costs WHERE run_id = 1 AND message_id = 7').get() as { c: number }).c, 1)
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), [])
  assert.throws(() => insertTestMessage(db, { source_message_id: 'same-id', source_session_id: 'session-b' }))
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE source_message_id = ?').get('same-id') as { c: number }).c, 1)
  db.close()
})

test('messages use tool-conditional source identity', () => {
  const db = openTestLedger()
  insertTestMessage(db, { source_message_id: 'm1', source_session_id: 's1' })
  assert.throws(() => insertTestMessage(db, { source_message_id: 'm1', source_session_id: 's1' }))
  assert.throws(() => insertTestMessage(db, { source_message_id: 'm1', source_session_id: 's2' }))
  insertTestMessage(db, { source_message_id: 'm1', tool: 'opencode', source_session_id: 's1' })
  insertTestMessage(db, { source_message_id: 'm2', source_session_id: null })
  assert.throws(() => insertTestMessage(db, { source_message_id: 'm2', source_session_id: null }))
  db.close()
})


test('existing session-key DB needs explicit opt-in and collapses only Claude copies', () => {
  const path=join(tempDir('ledger-migrate-'),'ledger.db')
  const old=openLedger(path)
  old.raw.exec("DROP INDEX messages_source_identity_idx; CREATE UNIQUE INDEX messages_source_identity_idx ON messages(tool,COALESCE(source_session_id,''),source_message_id)")
  const a=insertTestMessage(old,{source_message_id:'copy',source_session_id:'a',source_path:'/a',output_tokens:50})
  const b=insertTestMessage(old,{source_message_id:'copy',source_session_id:'b',source_path:'/b',output_tokens:10})
  insertTestMessage(old,{tool:'opencode',source_message_id:'copy',source_session_id:'a'})
  insertTestMessage(old,{tool:'opencode',source_message_id:'copy',source_session_id:'b'})
  old.raw.exec("INSERT INTO pricing_runs(started_at) VALUES ('2026-10-01T00:00:00.000Z')")
  old.raw.prepare("INSERT INTO message_costs(run_id,message_id,pricing_status,computed_cost_usd) VALUES(1,?,'priced',1),(1,?,'priced',2)").run(a,b)
  old.close()
  assert.throws(()=>openLedger(path),/explicit.*migration/i)
  const db=openLedger(path,{allowIdentityMigration:true})
  assert.equal((db.raw.prepare("SELECT count(*) n FROM messages WHERE tool='claude-code' AND source_message_id='copy'").get() as {n:number}).n,1)
  assert.deepEqual((db.raw.prepare('SELECT source_session_id s FROM message_holders WHERE message_id=? ORDER BY s').all(a) as Array<{s:string}>).map(x=>x.s),['a','b'])
  assert.equal((db.raw.prepare('SELECT count(*) n FROM message_costs WHERE message_id=?').get(b) as {n:number}).n,0)
  assert.equal((db.raw.prepare("SELECT count(*) n FROM messages WHERE tool='opencode' AND source_message_id='copy'").get() as {n:number}).n,2)
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(),[])
  db.close()
})
test('Claude global uniqueness does not collapse OpenCode or Pi sessions', () => {
  const db=openTestLedger()
  insertTestMessage(db,{source_message_id:'shared',source_session_id:'a'})
  assert.throws(()=>insertTestMessage(db,{source_message_id:'shared',source_session_id:'b'}))
  for (const tool of ['opencode','pi']) {
    insertTestMessage(db,{tool,source_message_id:'shared',source_session_id:'a'})
    insertTestMessage(db,{tool,source_message_id:'shared',source_session_id:'b'})
  }
  db.close()
})

test('latest_message_costs gives each message its most recent cost row, and a message with none is absent', () => {
  const db = openTestLedger()
  const a = insertTestMessage(db, { source_message_id: 'a' })
  const b = insertTestMessage(db, { source_message_id: 'b' })
  insertTestMessage(db, { source_message_id: 'never' })
  const run = (): number => Number(db.raw.prepare("INSERT INTO pricing_runs (started_at, note) VALUES ('2026-10-02T00:00:00.000Z', '')").run().lastInsertRowid)
  const cost = db.raw.prepare("INSERT INTO message_costs (run_id, message_id, computed_cost_usd, pricing_status) VALUES (?, ?, ?, 'priced')")
  const r1 = run()
  cost.run(r1, a, 1)
  cost.run(r1, b, 5)
  const r2 = run()
  cost.run(r2, a, 2)
  run() // a third run that changed nothing writes no rows
  const rows = db.raw.prepare('SELECT message_id m, run_id r, computed_cost_usd c FROM latest_message_costs ORDER BY message_id').all() as Array<{ m: number; r: number; c: number }>
  assert.deepEqual(rows.map(x => [x.m, x.r, x.c]), [[a, r2, 2], [b, r1, 5]])
  db.close()
})

test('cost lookups by message use the (message_id, run_id) index', () => {
  const db = openTestLedger()
  const plan = (db.raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM latest_message_costs WHERE message_id = 1').all() as Array<{ detail: string }>).map(r => r.detail).join('\n')
  assert.match(plan, /message_costs_message_idx|sqlite_autoindex_message_costs/)
  db.close()
})

test('prices reject an unknown token class', () => {
  const db = openTestLedger()
  db.raw.prepare("INSERT INTO models (model_id, vendor) VALUES ('m', 'v')").run()
  assert.throws(() => db.raw.prepare("INSERT INTO prices (model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, created_at) VALUES ('m','bogus',0,1,'2020-01-01T00:00:00.000Z','x')").run())
  db.close()
})

test('file ledger is created with mode 0600 and opens twice without error', () => {
  const dir = tempDir('costledger-db-')
  const path = join(dir, 'sub', 'ledger.db')
  openLedger(path).close()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  openLedger(path).close()
})

test('transaction rolls back on throw and nests safely', () => {
  const db = openTestLedger()
  assert.throws(() => db.transaction(() => { insertTestMessage(db, { source_message_id: 'a' }); throw new Error('boom') }))
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 0)
  db.transaction(() => { db.transaction(() => { insertTestMessage(db, { source_message_id: 'b' }) }) })
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 1)
  db.close()
})
