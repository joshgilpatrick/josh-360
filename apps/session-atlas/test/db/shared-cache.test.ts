import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openLedger } from '../../src/costledger/db.ts'
import { openDatabase } from '../../src/db/database.ts'

// JP-111: cost-import tables and the artifact catalog share one file, cache.db. The retire job seeds that file with a copy of the old
// cost ledger, so Atlas's migrations must run on top of existing cost tables and leave their rows alone, and the cost import must
// open the file afterwards.
test('Atlas migrations run on a cost-ledger file and keep its rows; the cost import reopens it', () => {
  const path = join(tempDir('atlas-shared-cache-'), 'cache.db')
  const cost = openLedger(path)
  const raw = (cost as unknown as { raw?: { exec(sql: string): void } }).raw ?? (cost as unknown as { exec(sql: string): void })
  raw.exec("INSERT INTO pricing_runs (started_at, note) VALUES ('2026-11-17T00:00:00Z', 'made-up')")
  raw.exec("INSERT INTO jira_session_links (issue_key, tool, source_session_id, action, recorded_at) VALUES ('JP-1', 'claude-code', 's1', 'worked', '2026-11-17T00:00:00Z')")
  cost.close()

  const atlas = openDatabase(path)
  const count = (table: string) => (atlas.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  assert.equal(count('pricing_runs'), 1)
  assert.equal(count('jira_session_links'), 1)
  assert.equal(count('artifact_documents'), 0)
  atlas.close()

  openLedger(path).close()
})
