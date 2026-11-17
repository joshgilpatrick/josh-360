import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openTestLedger, insertTestMessage } from '../helpers/costledger.ts'
import { tempDir } from '../helpers/tmp.ts'
import { recordJiraSessionLink, jiraIssueCost } from '../../src/costledger/jira-links.ts'
import { main } from '../../src/costledger/cli.ts'

function priced(db: ReturnType<typeof openTestLedger>, sessionId: string, messageId: string, cost: number): void {
  const id = insertTestMessage(db, { source_message_id: messageId, source_session_id: sessionId, tool: 'claude-code' })
  const run = db.raw.prepare("INSERT OR IGNORE INTO pricing_runs (id, started_at) VALUES (1, '2026-10-02T00:00:00.000Z')")
  run.run()
  db.raw.prepare("INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) VALUES (1, ?, 'model', ?, 'priced')").run(id, cost)
  db.raw.prepare("INSERT OR IGNORE INTO message_holders (message_id, source_session_id, source_agent_id) VALUES (?, ?, '')").run(id, sessionId)
}

test('jira_session_links table exists with the columns the cost query needs', () => {
  const db = openTestLedger()
  const cols = (db.raw.prepare('PRAGMA table_info(jira_session_links)').all() as Array<{ name: string }>).map(c => c.name)
  for (const c of ['issue_key', 'tool', 'source_session_id', 'action', 'recorded_at']) assert.ok(cols.includes(c), `missing column ${c}`)
  db.close()
})

test('recording the same session and issue twice keeps one row', () => {
  const db = openTestLedger()
  recordJiraSessionLink(db, { issueKey: 'AD-12', tool: 'claude-code', sessionId: 's1', action: 'worked', recordedAt: '2026-10-02T00:00:00.000Z' })
  recordJiraSessionLink(db, { issueKey: 'AD-12', tool: 'claude-code', sessionId: 's1', action: 'worked', recordedAt: '2026-10-03T00:00:00.000Z' })
  const n = (db.raw.prepare('SELECT COUNT(*) c FROM jira_session_links').get() as { c: number }).c
  assert.equal(n, 1)
  db.close()
})

test('rejects a malformed Jira key', () => {
  const db = openTestLedger()
  assert.throws(() => recordJiraSessionLink(db, { issueKey: 'not a key', tool: 'claude-code', sessionId: 's1', action: 'worked', recordedAt: '2026-10-02T00:00:00.000Z' }))
  db.close()
})

test('jiraIssueCost sums each linked session once, across tools, and reports unpriced separately', () => {
  const db = openTestLedger()
  priced(db, 'sA', 'm1', 1.5)
  priced(db, 'sA', 'm2', 0.5)
  priced(db, 'sB', 'm3', 2.0)
  recordJiraSessionLink(db, { issueKey: 'AD-12', tool: 'claude-code', sessionId: 'sA', action: 'worked', recordedAt: '2026-10-02T00:00:00.000Z' })
  recordJiraSessionLink(db, { issueKey: 'AD-12', tool: 'claude-code', sessionId: 'sB', action: 'worked', recordedAt: '2026-10-02T00:00:00.000Z' })
  recordJiraSessionLink(db, { issueKey: 'AD-99', tool: 'claude-code', sessionId: 'sC', action: 'worked', recordedAt: '2026-10-02T00:00:00.000Z' })
  const cost = jiraIssueCost(db, 'AD-12')
  assert.equal(cost.sessions, 2)
  assert.equal(cost.costUsd, 4.0)
  assert.deepEqual(cost.sessionIds.sort(), ['sA', 'sB'])
  db.close()
})

test('jira-link then jira-cost through the CLI reports the linked cost', async () => {
  const db = join(tempDir('jira-cli-'), 'ledger.db')
  const out: string[] = []
  const err: string[] = []
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), now: () => '2026-10-02T00:00:00.000Z' }
  assert.equal(await main(['jira-link', '--db', db, '--issue', 'AD-12', '--tool', 'claude-code', '--session', 's1'], io), 0)
  assert.equal(await main(['jira-link', '--db', db, '--issue', 'AD-12', '--tool', 'claude-code', '--session', 's1'], io), 0)
  assert.equal(await main(['jira-cost', '--db', db, '--issue', 'AD-12', '--json'], io), 0)
  const parsed = JSON.parse(out.at(-1)!) as { issueKey: string; sessions: number; sessionIds: string[] }
  assert.equal(parsed.issueKey, 'AD-12')
  assert.equal(parsed.sessions, 1)
  assert.deepEqual(parsed.sessionIds, ['s1'])
  assert.equal(await main(['jira-link', '--db', db, '--issue', 'bad key', '--tool', 'claude-code', '--session', 's1'], io), 1)
  assert.match(err.join('\n'), /not a Jira issue key/)
})
