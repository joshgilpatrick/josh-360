import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestLedger, insertHeldMessage } from '../helpers/costledger.ts'
import type { LedgerDb } from '../../src/costledger/db.ts'
import { sessionRoots } from '../../src/costledger/session-reports.ts'
import { ensureOverviewView, OVERVIEW_VIEW } from '../../src/costledger/overview-view.ts'

const DAY = 86_400_000
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
let n = 0

type Opt = { tool?: string; session: string; agent?: string; at?: string; cost?: number | null; cwd?: string | null; branch?: string | null; status?: string }

/** One held message in a session, with a cost row (cost === null means priced as missing_price). */
function msg(db: LedgerDb, o: Opt): void {
  n += 1
  const id = insertHeldMessage(db, {
    tool: o.tool ?? 'claude-code', source_message_id: `m${n}`, source_session_id: o.session, source_agent_id: o.agent ?? null,
    ts_utc: o.at ?? ago(1), cwd: o.cwd === undefined ? '/r/app' : o.cwd, git_branch: o.branch === undefined ? 'main' : o.branch,
    source_locator: `line:${n}`,
  })
  db.raw.prepare("INSERT OR IGNORE INTO pricing_runs (id, started_at) VALUES (1, '2026-10-02T00:00:00.000Z')").run()
  const status = o.status ?? (o.cost === null ? 'missing_price' : 'priced')
  db.raw.prepare('INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) VALUES (1, ?, ?, ?, ?)')
    .run(id, 'model', o.cost ?? null, status)
}

function node(db: LedgerDb, tool: string, s: string, a: string, ps: string | null, pa: string | null, kind: string): void {
  db.raw.prepare('INSERT INTO session_nodes (tool, source_session_id, source_agent_id, parent_session_id, parent_agent_id, kind, link_quality) VALUES (?,?,?,?,?,?,?)')
    .run(tool, s, a, ps, pa, kind, 'exact')
}

const label = (db: LedgerDb, tool: string, s: string, kind: string, value: string): void => {
  db.raw.prepare("INSERT INTO session_labels (tool, source_session_id, kind, value, recorded_at) VALUES (?,?,?,?,'2026-10-09T00:00:00.000Z')").run(tool, s, kind, value)
}

type Row = {
  tool: string; session_id: string; title: string | null; jira_tickets: string | null
  branch: string | null; folder: string | null; pr_links: string | null; cost_usd: number | null; unpriced_messages: number
  first_active_at: string; last_active_at: string
}
const rows = (db: LedgerDb): Row[] => (db.raw.prepare('SELECT * FROM session_overview_45d').all() as unknown as Row[]).map(r => ({ ...r }))
const byId = (db: LedgerDb, id: string): Row | undefined => rows(db).find(r => r.session_id === id)

test('one row per parent session; a Claude subagent is not a row but its cost is in the parent', () => {
  const db = openTestLedger()
  node(db, 'claude-code', 'A', '', null, null, 'main')
  node(db, 'claude-code', 'A', 'ag1', 'A', '', 'subagent')
  msg(db, { session: 'A', cost: 1 })
  msg(db, { session: 'A', agent: 'ag1', cost: 2 })
  msg(db, { session: 'A', agent: 'ag1', cost: 0.5 })
  const r = rows(db)
  assert.deepEqual(r.map(x => [x.tool, x.session_id, x.cost_usd]), [['claude-code', 'A', 3.5]])
  db.close()
})

test('an OpenCode child session is not a row; its cost rolls up through nested children', () => {
  const db = openTestLedger()
  node(db, 'opencode', 'R', '', null, null, 'main')
  node(db, 'opencode', 'C', '', 'R', '', 'subagent')
  node(db, 'opencode', 'G', '', 'C', '', 'subagent')
  msg(db, { tool: 'opencode', session: 'R', cost: 1 })
  msg(db, { tool: 'opencode', session: 'C', cost: 2 })
  msg(db, { tool: 'opencode', session: 'G', cost: 4 })
  assert.deepEqual(rows(db).map(x => [x.session_id, x.cost_usd]), [['R', 7]])
  db.close()
})

test('a Pi session has no hierarchy rows and still appears', () => {
  const db = openTestLedger()
  msg(db, { tool: 'pi', session: 'P', cost: 0.25 })
  assert.deepEqual(rows(db).map(x => [x.tool, x.session_id, x.cost_usd]), [['pi', 'P', 0.25]])
  db.close()
})

test('subagents whose main session never logged a call still show up as one session', () => {
  const db = openTestLedger()
  node(db, 'claude-code', 'O', 'ag9', 'O', '', 'subagent')
  msg(db, { session: 'O', agent: 'ag9', cost: 3 })
  msg(db, { session: 'O', agent: 'ag8', cost: 1 })
  assert.deepEqual(rows(db).map(x => [x.session_id, x.cost_usd]), [['O', 4]])
  db.close()
})

test('only sessions with activity in the last 45 days; the family counts if a child is recent', () => {
  const db = openTestLedger()
  msg(db, { session: 'old', at: ago(46), cost: 1 })
  msg(db, { session: 'edge', at: ago(44), cost: 1 })
  node(db, 'claude-code', 'fam', '', null, null, 'main')
  node(db, 'claude-code', 'fam', 'ag', 'fam', '', 'subagent')
  msg(db, { session: 'fam', at: ago(60), cost: 1 })
  msg(db, { session: 'fam', agent: 'ag', at: ago(2), cost: 1 })
  assert.deepEqual(rows(db).map(x => x.session_id).sort(), ['edge', 'fam'])
  // cost is the whole session, not only the part inside the window
  assert.equal(byId(db, 'fam')?.cost_usd, 2)
  db.close()
})

test('titles, Jira tickets and PRs are shown; several tickets and PRs are listed together', () => {
  const db = openTestLedger()
  msg(db, { session: 'A', cost: 1 })
  label(db, 'claude-code', 'A', 'ai_title', 'Ledger rows fix')
  label(db, 'claude-code', 'A', 'custom_title', 'my ledger session')
  label(db, 'claude-code', 'A', 'tool_title', 'OpenCode title')
  label(db, 'claude-code', 'A', 'agent_name', 'ignored name')
  for (const k of ['AD-9', 'AD-12']) {
    db.raw.prepare("INSERT INTO jira_session_links (issue_key, tool, source_session_id, action, recorded_at) VALUES (?,?,?,?,'2026-10-09T00:00:00.000Z')").run(k, 'claude-code', 'A', 'worked')
  }
  for (const u of ['https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/1']) {
    db.raw.prepare("INSERT INTO session_pr_links (tool, source_session_id, url, repository, number, recorded_at) VALUES (?,?,?,?,?,'2026-10-09T00:00:00.000Z')").run('claude-code', 'A', u, 'o/r', u.slice(-1))
  }
  const r = byId(db, 'A')
  assert.equal(r?.title, 'my ledger session')
  assert.equal('ai_title' in (r ?? {}), false)
  assert.equal('custom_title' in (r ?? {}), false)
  assert.equal('tool_title' in (r ?? {}), false)
  assert.equal(r?.jira_tickets, 'AD-12, AD-9')
  assert.equal(r?.pr_links, 'https://github.com/o/r/pull/1, https://github.com/o/r/pull/2')
  db.close()
})

test('a session without titles, tickets or PRs shows NULL, not an empty string; labels never cross tools', () => {
  const db = openTestLedger()
  msg(db, { session: 'x', cost: 1 })
  label(db, 'pi', 'x', 'ai_title', 'pi only')
  const r = byId(db, 'x')
  assert.deepEqual([r?.title, r?.jira_tickets, r?.pr_links], [null, null, null])
  db.close()
})

test('title priority is custom_title, then tool_title, then ai_title', () => {
  const db = openTestLedger()
  msg(db, { session: 'tool-fallback', tool: 'opencode', cost: 1 })
  label(db, 'opencode', 'tool-fallback', 'ai_title', 'AI title')
  label(db, 'opencode', 'tool-fallback', 'tool_title', 'OpenCode title')
  msg(db, { session: 'ai-fallback', cost: 1 })
  label(db, 'claude-code', 'ai-fallback', 'ai_title', 'AI title')
  msg(db, { session: 'preferred', cost: 1 })
  label(db, 'claude-code', 'preferred', 'ai_title', 'AI title')
  label(db, 'claude-code', 'preferred', 'tool_title', 'Tool title')
  label(db, 'claude-code', 'preferred', 'custom_title', 'Custom title')
  assert.equal(byId(db, 'tool-fallback')?.title, 'OpenCode title')
  assert.equal(byId(db, 'ai-fallback')?.title, 'AI title')
  assert.equal(byId(db, 'preferred')?.title, 'Custom title')
  assert.equal('tool_title' in (byId(db, 'tool-fallback') ?? {}), false)
  db.close()
})

test('branch and folder are the most recent known values in the session', () => {
  const db = openTestLedger()
  msg(db, { session: 'A', at: ago(5), cwd: '/r/old', branch: 'feat/one' })
  msg(db, { session: 'A', at: ago(3), cwd: '/r/new', branch: 'feat/two' })
  msg(db, { session: 'A', at: ago(1), cwd: null, branch: null })
  const r = byId(db, 'A')
  assert.deepEqual([r?.folder, r?.branch], ['/r/new', 'feat/two'])
  db.close()
})

test('unknown cost is NULL, never zero; partly unpriced shows the known part and the unpriced count', () => {
  const db = openTestLedger()
  msg(db, { session: 'none', cost: null })
  msg(db, { session: 'part', cost: 2 })
  msg(db, { session: 'part', cost: null })
  const none = byId(db, 'none')
  assert.deepEqual([none?.cost_usd, none?.unpriced_messages], [null, 1])
  const part = byId(db, 'part')
  assert.deepEqual([part?.cost_usd, part?.unpriced_messages], [2, 1])
  db.close()
})

test('first and last activity span the whole family', () => {
  const db = openTestLedger()
  node(db, 'claude-code', 'A', '', null, null, 'main')
  node(db, 'claude-code', 'A', 'ag', 'A', '', 'subagent')
  msg(db, { session: 'A', at: ago(10), cost: 1 })
  msg(db, { session: 'A', agent: 'ag', at: ago(2), cost: 1 })
  const r = byId(db, 'A')
  const near = (iso: string | undefined, days: number): boolean => Math.abs(Date.parse(iso ?? '') - (Date.now() - days * DAY)) < 60_000
  assert.ok(near(r?.first_active_at, 10), `first_active_at ${r?.first_active_at}`)
  assert.ok(near(r?.last_active_at, 2), `last_active_at ${r?.last_active_at}`)
  db.close()
})

test('rows are newest-activity first', () => {
  const db = openTestLedger()
  msg(db, { session: 'older', at: ago(9), cost: 1 })
  msg(db, { session: 'newest', at: ago(1), cost: 1 })
  msg(db, { session: 'middle', at: ago(5), cost: 1 })
  assert.deepEqual(rows(db).map(r => r.session_id), ['newest', 'middle', 'older'])
  db.close()
})

test('the view agrees with the ledger\'s own session report for every session root', () => {
  const db = openTestLedger()
  node(db, 'claude-code', 'A', '', null, null, 'main')
  node(db, 'claude-code', 'A', 'ag1', 'A', '', 'subagent')
  node(db, 'claude-code', 'A', 'ag2', 'A', 'ag1', 'subagent')
  node(db, 'opencode', 'R', '', null, null, 'main')
  node(db, 'opencode', 'C', '', 'R', '', 'subagent')
  node(db, 'claude-code', 'O', 'ag9', 'O', '', 'subagent')
  msg(db, { session: 'A', cost: 1.25 })
  msg(db, { session: 'A', agent: 'ag1', cost: 2.5 })
  msg(db, { session: 'A', agent: 'ag2', cost: 0.125 })
  msg(db, { tool: 'opencode', session: 'R', cost: 4 })
  msg(db, { tool: 'opencode', session: 'C', cost: 8 })
  msg(db, { tool: 'pi', session: 'P', cost: 16 })
  msg(db, { session: 'O', agent: 'ag9', cost: 32 })
  const fromView = rows(db).map(r => [r.tool, r.session_id, r.cost_usd]).sort()
  const fromLedger = sessionRoots(db).map(r => [r.tool, r.sessionId, r.familyCostUsd]).sort()
  assert.deepEqual(fromView, fromLedger)
  db.close()
})

test('a shared-history copy is counted once, in the session that holds the canonical call', () => {
  const db = openTestLedger()
  msg(db, { session: 'one', cost: 5 })
  const shared = (db.raw.prepare("SELECT id FROM messages WHERE source_session_id = 'one'").get() as { id: number }).id
  db.raw.prepare("INSERT INTO message_holders (message_id, source_session_id, source_agent_id) VALUES (?, 'two', '')").run(shared)
  msg(db, { session: 'two', cost: 1 })
  assert.deepEqual(rows(db).map(r => [r.session_id, r.cost_usd]).sort(), [['one', 5], ['two', 1]])
  db.close()
})

test('ensureOverviewView is idempotent and replaces a stale definition', () => {
  const db = openTestLedger()
  ensureOverviewView(db.raw)
  ensureOverviewView(db.raw)
  const count = () => (db.raw.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'view' AND name = ?").get(OVERVIEW_VIEW) as { c: number }).c
  assert.equal(count(), 1)
  db.raw.exec(`DROP VIEW ${OVERVIEW_VIEW}`)
  db.raw.exec(`CREATE VIEW ${OVERVIEW_VIEW} AS SELECT 'stale' AS tool`)
  ensureOverviewView(db.raw)
  assert.equal(count(), 1)
  msg(db, { session: 'A', cost: 1 })
  assert.deepEqual(rows(db).map(r => r.session_id), ['A'])
  db.close()
})
