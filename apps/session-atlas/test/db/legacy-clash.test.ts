import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openLedger } from '../../src/costledger/db.ts'
import { openDatabase, migrate } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'

// JP-163: cache.db was seeded from the old cost ledger, which also carried its own artifact catalog (an `artifacts` table with a TEXT
// key, plus artifact_locations and artifact_events) and left schema_migrations empty. Migration 1 then failed on "table artifacts
// already exists" and Atlas never started. A table (or index or trigger) that a migration is about to create and that already
// exists cannot be Atlas's own, so migrate() sets it aside under a new name, rows kept, and the migration runs. Made-up data only.

const LEGACY = `
CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT);
CREATE TABLE artifact_locations (id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), location TEXT);
CREATE TABLE artifact_events (id INTEGER PRIMARY KEY, artifact_id TEXT, kind TEXT);
CREATE INDEX idx_artifacts_created ON artifacts(created_at);
CREATE TRIGGER artifacts_ai AFTER INSERT ON artifacts BEGIN UPDATE artifacts SET created_at = 'x' WHERE artifact_id = new.artifact_id; END;
INSERT INTO artifacts VALUES ('a-1', '/made/up/one.md', 't1'), ('a-2', '/made/up/two.md', 't2');
INSERT INTO artifact_locations VALUES (1, 'a-1', '/made/up/one.md');
INSERT INTO artifact_events VALUES (1, 'a-1', 'seen');
`

function seededPath(): string {
  const path = join(tempDir('atlas-legacy-clash-'), 'cache.db')
  const cost = openLedger(path)
  cost.raw.exec("INSERT INTO pricing_runs (started_at, note) VALUES ('2026-11-17T00:00:00Z', 'made-up')")
  cost.raw.exec("INSERT INTO jira_session_links (issue_key, tool, source_session_id, action, recorded_at) VALUES ('JP-1', 'claude-code', 's1', 'worked', '2026-11-17T00:00:00Z')")
  cost.raw.exec(LEGACY)
  cost.raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  cost.close()
  return path
}

test('legacy catalog tables clash with migration 1: Atlas starts, the legacy rows are kept under a new name, cost rows are unchanged', () => {
  const db = openDatabase(seededPath())
  const count = (t: string) => (db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
  const columns = (t: string) => (db.raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; type: string }>)

  assert.equal(columns('artifacts').find(c => c.name === 'artifact_id')?.type, 'INTEGER', 'Atlas has its own artifacts table')
  assert.equal(columns('legacy_artifacts').find(c => c.name === 'artifact_id')?.type, 'TEXT')
  assert.equal(count('legacy_artifacts'), 2, 'legacy rows are kept')
  assert.equal(count('artifact_locations'), 1, 'a legacy table whose name Atlas never creates is left alone')
  assert.equal(count('artifact_events'), 1)
  assert.equal(count('pricing_runs'), 1, 'cost rows are unchanged')
  assert.equal(count('jira_session_links'), 1)
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c, MIGRATIONS.length)
  assert.equal(count('artifacts'), 0)
  // the legacy child still points at the renamed parent
  assert.deepEqual((db.raw.prepare('PRAGMA foreign_key_list(artifact_locations)').all() as Array<{ table: string }>).map(f => f.table), ['legacy_artifacts'])
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
  assert.equal(count('legacy_artifacts_2'), 2)
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
