import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openLedger } from '../../src/costledger/db.ts'
import { openDatabase, migrate } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'

// JP-163: cache.db was seeded from the old cost ledger, which also carried its own artifact catalog (an `artifacts` table with a TEXT
// key and no file_type column, plus artifact_locations and artifact_events) and left schema_migrations empty. Migration 1 then failed on "table artifacts
// already exists" and Atlas never started. A table (or index or trigger) that a migration is about to create and that already
// exists cannot be Atlas's own, so migrate() sets it aside under a new name, rows kept, and the migration runs. Made-up data only.

const LEGACY = `
CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT);
CREATE TABLE artifact_locations (id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), location TEXT);
CREATE TABLE artifact_events (id INTEGER PRIMARY KEY, artifact_id TEXT, kind TEXT);
CREATE INDEX idx_artifacts_created ON artifacts(created_at);
CREATE TRIGGER artifacts_ai AFTER INSERT ON artifacts BEGIN UPDATE artifacts SET created_at = 'x' WHERE artifact_id = new.artifact_id; END;
INSERT INTO artifacts VALUES ('a-1', '/made/up/one.md', 't1'), ('a-2', '/made/up/two.md', 't2'), ('a-3', '/made/up/three.md', 't3');
INSERT INTO artifact_locations VALUES (1, 'a-1', '/made/up/one.md');
INSERT INTO artifact_events VALUES (1, 'a-1', 'seen');
`

function seededPath(): string {
  const path = join(tempDir('atlas-legacy-clash-'), 'cache.db')
  const cost = openLedger(path)
  cost.raw.exec("INSERT INTO pricing_runs (started_at, note) VALUES ('2026-11-17T00:00:00Z', 'made-up')")
  for (let i = 1; i <= 5; i += 1) {
    cost.raw.exec(`INSERT INTO messages (tool, source_message_id, ts_utc, model_raw, attribution_quality, usage_status, source_path, source_locator)
      VALUES ('claude-code', 'm${i}', '2026-11-17T00:0${i}:00Z', 'made-up-model', 'exact', 'ok', '/made/up/s.jsonl', 'line ${i}')`)
  }
  cost.raw.exec("INSERT INTO jira_session_links (issue_key, tool, source_session_id, action, recorded_at) VALUES ('JP-1', 'claude-code', 's1', 'worked', '2026-11-17T00:00:00Z')")
  cost.raw.exec(LEGACY)
  cost.raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  cost.close()
  return path
}

test('old catalog tables clash with migration 1: Atlas starts, migrations 1 to 13 are recorded in order, old rows and message rows are kept', () => {
  const path = seededPath()
  const before = openLedger(path)
  const messagesBefore = JSON.stringify(before.raw.prepare('SELECT * FROM messages ORDER BY id').all())
  const hadSessions = before.raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sessions'").get() !== undefined
  before.close()
  assert.equal(hadSessions, false, 'the seeded file has no sessions table')

  const db = openDatabase(path)
  const count = (t: string) => (db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
  const columns = (t: string) => (db.raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; type: string }>)

  const ids = (db.raw.prepare('SELECT id FROM schema_migrations ORDER BY rowid').all() as Array<{ id: number }>).map(r => r.id)
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  assert.deepEqual(ids, MIGRATIONS.map(m => m.id))
  assert.ok(columns('artifacts').some(c => c.name === 'file_type'), "Atlas's own artifacts table has file_type")
  assert.equal(columns('artifacts').find(c => c.name === 'artifact_id')?.type, 'INTEGER')
  assert.equal(columns('legacy_artifacts').find(c => c.name === 'artifact_id')?.type, 'TEXT')
  assert.equal(count('legacy_artifacts'), 3, 'the 3 old artifact rows are still in the file')
  assert.equal(count('messages'), 5)
  assert.equal(JSON.stringify(db.raw.prepare('SELECT * FROM messages ORDER BY id').all()), messagesBefore, 'the 5 message rows are unchanged')
  assert.equal(count('artifact_locations'), 1, 'a legacy table whose name Atlas never creates is left alone')
  assert.equal(count('artifact_events'), 1)
  assert.equal(count('pricing_runs'), 1)
  assert.equal(count('jira_session_links'), 1)
  assert.equal(count('artifacts'), 0)
  // the legacy child still points at the renamed parent
  assert.deepEqual((db.raw.prepare('PRAGMA foreign_key_list(artifact_locations)').all() as Array<{ table: string }>).map(f => f.table), ['legacy_artifacts'])
  db.close()
})

test('a database that already records its migrations is left alone: nothing runs and nothing is renamed', () => {
  const path = join(tempDir('atlas-at-13-'), 'cache.db')
  openDatabase(path).close()
  const snapshot = (d: ReturnType<typeof openDatabase>) => JSON.stringify(d.raw.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all())
  const db = openDatabase(path, { migrate: false })
  const shape = snapshot(db)
  const recorded = JSON.stringify(db.raw.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all())

  assert.equal(migrate(db), 0, 'no migration runs')

  assert.equal(snapshot(db), shape, 'no table, index or trigger changed')
  assert.equal(JSON.stringify(db.raw.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all()), recorded)
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'legacy_%'").get() as { c: number }).c, 0)
  db.close()
})

test('a legacy index and trigger with the names Atlas uses are set aside too, and Atlas\'s own still work', () => {
  const db = openDatabase(seededPath())
  const names = (type: string) => (db.raw.prepare('SELECT name, tbl_name FROM sqlite_master WHERE type = ?').all(type) as Array<{ name: string; tbl_name: string }>)
  assert.ok(names('index').some(i => i.name === 'legacy_idx_artifacts_created' && i.tbl_name === 'legacy_artifacts'))
  assert.ok(names('index').some(i => i.name === 'idx_artifacts_created' && i.tbl_name === 'artifacts'))
  assert.ok(names('trigger').some(t => t.name === 'legacy_artifacts_ai' && t.tbl_name === 'legacy_artifacts'))
  db.raw.exec("INSERT INTO artifacts (path, filename, created_at) VALUES ('/made/up/three.md', 'three.md', 't3')")
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS c FROM artifacts_fts WHERE artifacts_fts MATCH ?').get('three') as { c: number }).c, 1)
  db.close()
})

test('opening the file again changes nothing', () => {
  const path = seededPath()
  openDatabase(path).close()
  const db = openDatabase(path)
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'legacy_%'").get() as { c: number }).c, 3)
  assert.equal(migrate(db), 0)
  db.close()
})

test('a second clash does not overwrite the first set-aside table', () => {
  const path = seededPath()
  const first = openLedger(path)
  first.raw.exec("CREATE TABLE legacy_artifacts (artifact_id TEXT, note TEXT); INSERT INTO legacy_artifacts VALUES ('keep', 'earlier')")
  first.close()
  const db = openDatabase(path)
  const count = (t: string) => (db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
  assert.equal(count('legacy_artifacts'), 1, 'the earlier table is untouched')
  assert.equal(count('legacy_artifacts_2'), 3)
  db.close()
})

test('a fresh database is unchanged: every migration runs once, in order, and nothing is set aside', () => {
  const db = openDatabase(join(tempDir('atlas-fresh-'), 'cache.db'), { migrate: false })
  assert.equal(migrate(db), MIGRATIONS.length)
  const ids = (db.raw.prepare('SELECT id FROM schema_migrations ORDER BY rowid').all() as Array<{ id: number }>).map(r => r.id)
  assert.deepEqual(ids, MIGRATIONS.map(m => m.id))
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'legacy_%'").get() as { c: number }).c, 0)
  db.close()
})
