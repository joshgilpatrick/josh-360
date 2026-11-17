import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestRunId, loggedVsComputed, report, reportTotal, traceMessage, unpricedByModel, REPORT_DIMENSIONS } from '../../src/costledger/reports.ts'
import { FIXED_NOW, insertTestMessage, openTestLedger } from '../helpers/costledger.ts'
import type { LedgerDb } from '../../src/costledger/db.ts'

function priceRun(db: LedgerDb, entries: Array<{ id: number; status: string; cost: number | null; modelId?: string }>): number {
  const run = Number(db.raw.prepare("INSERT INTO pricing_runs (started_at, note) VALUES (?, '')").run(FIXED_NOW).lastInsertRowid)
  const ins = db.raw.prepare('INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) VALUES (?, ?, ?, ?, ?)')
  for (const e of entries) ins.run(run, e.id, e.modelId ?? null, e.cost, e.status)
  return run
}

function entriesFor(ids: { a: number; b: number; c: number; d: number; e: number; f: number }, aCost = 1) {
  return [
    { id: ids.a, status: 'priced', cost: aCost, modelId: 'claude-sonnet-5' },
    { id: ids.b, status: 'priced', cost: 2, modelId: 'claude-opus-5-5' },
    { id: ids.c, status: 'priced', cost: 0.5, modelId: 'gpt-6-luna' },
    { id: ids.d, status: 'missing_alias', cost: null },
    { id: ids.e, status: 'suspect', cost: null },
    { id: ids.f, status: 'no_usage', cost: null },
  ]
}

function fixture(db: LedgerDb) {
  const a = insertTestMessage(db, { source_message_id: 'a' })
  const b = insertTestMessage(db, { source_message_id: 'b', repo_key: '/r/other', worktree_path: '/r/other', git_branch: 'dev', ts_utc: '2026-10-01T08:00:00.000Z', is_sidechain: 1 })
  const c = insertTestMessage(db, { source_message_id: 'c', tool: 'opencode', repo_key: null, worktree_path: null, git_branch: null, cwd: null, attribution_quality: 'unknown' })
  const d = insertTestMessage(db, { source_message_id: 'd', model_raw: 'mystery', input_tokens: 400, output_tokens: 100 })
  const e = insertTestMessage(db, { source_message_id: 'e', input_tokens: 3_000_000, output_tokens: 0, suspect: 1 })
  const f = insertTestMessage(db, { source_message_id: 'f', input_tokens: null, output_tokens: null, usage_status: 'no_usage' })
  const ids = { a, b, c, d, e, f }
  priceRun(db, entriesFor(ids))
  return ids
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`)

test('latestRunId is null with no run, then the highest id', () => {
  const db = openTestLedger()
  assert.equal(latestRunId(db), null)
  const ids = fixture(db)
  const r2 = priceRun(db, entriesFor(ids))
  assert.equal(latestRunId(db), r2)
  db.close()
})

test('by repo: exact rows, explicit (no repo) bucket, cost order', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'repo'), [
    { key: '/r/other', costUsd: 2, messages: 1, pricedMessages: 1, unpricedMessages: 0, excludedMessages: 0, tokens: 1100, unpricedTokens: 0 },
    { key: '/r/app', costUsd: 1, messages: 4, pricedMessages: 1, unpricedMessages: 1, excludedMessages: 2, tokens: 3_001_600, unpricedTokens: 500 },
    { key: '(no repo)', costUsd: 0.5, messages: 1, pricedMessages: 1, unpricedMessages: 0, excludedMessages: 0, tokens: 1100, unpricedTokens: 0 },
  ])
  db.close()
})

test('by branch: repo @ branch, with (no branch) and (no repo) buckets', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'branch').map(r => [r.key, r.costUsd]), [
    ['/r/other @ dev', 2], ['/r/app @ main', 1], ['(no repo) @ (no branch)', 0.5],
  ])
  db.close()
})

test('a repo with a null branch (detached HEAD) lands in its own (no branch) bucket', () => {
  const db = openTestLedger()
  const x = insertTestMessage(db, { source_message_id: 'x', git_branch: null })
  priceRun(db, [{ id: x, status: 'priced', cost: 1.5, modelId: 'claude-sonnet-5' }])
  assert.deepEqual(report(db, 'branch').map(r => [r.key, r.costUsd]), [['/r/app @ (no branch)', 1.5]])
  db.close()
})

test('by worktree', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'worktree').map(r => [r.key, r.costUsd]), [['/r/other', 2], ['/r/app', 1], ['(no worktree)', 0.5]])
  db.close()
})

test('by tool', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'tool').map(r => [r.key, r.costUsd, r.messages]), [['claude-code', 3, 5], ['opencode', 0.5, 1]])
  db.close()
})

test('by subagent: sidechain rows are subagent, the rest main', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'subagent').map(r => [r.key, r.costUsd]), [['subagent', 2], ['main', 1.5]])
  db.close()
})

test('by day uses the UTC date', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'day').map(r => [r.key, r.costUsd]), [['2026-10-01', 2], ['2026-09-30', 1.5]])
  db.close()
})

test('by model uses the computed model id, falling back to model_raw', () => {
  const db = openTestLedger()
  fixture(db)
  const rows = report(db, 'model')
  assert.deepEqual(rows.map(r => [r.key, r.costUsd]), [['claude-opus-5-5', 2], ['claude-sonnet-5', 1], ['gpt-6-luna', 0.5], ['mystery', 0]])
  const sonnet = rows.find(r => r.key === 'claude-sonnet-5')
  assert.equal(sonnet?.messages, 3)
  assert.equal(sonnet?.excludedMessages, 2)
  db.close()
})

test('running pricing twice does not double any total; only the latest run counts', () => {
  const db = openTestLedger()
  const ids = fixture(db)
  const before = report(db, 'repo')
  priceRun(db, entriesFor(ids))
  assert.deepEqual(report(db, 'repo'), before)
  assert.equal(reportTotal(db).costUsd, 3.5)
  priceRun(db, entriesFor(ids, 5))
  const app = report(db, 'repo').find(r => r.key === '/r/app')
  assert.equal(app?.costUsd, 5)
  assert.equal(reportTotal(db).costUsd, 7.5)
  db.close()
})

test('a message with no cost row in the latest run is unpriced (not_priced), never $0 priced', () => {
  const db = openTestLedger()
  fixture(db)
  insertTestMessage(db, { source_message_id: 'g' })
  const app = report(db, 'repo').find(r => r.key === '/r/app')
  assert.equal(app?.unpricedMessages, 2)
  assert.equal(app?.unpricedTokens, 1600)
  assert.equal(app?.costUsd, 1)
  db.close()
})

test('with no pricing run at all, everything is unpriced and cost is 0', () => {
  const db = openTestLedger()
  insertTestMessage(db, { source_message_id: 'only' })
  const rows = report(db, 'repo')
  assert.deepEqual(rows, [{ key: '/r/app', costUsd: 0, messages: 1, pricedMessages: 0, unpricedMessages: 1, excludedMessages: 0, tokens: 1100, unpricedTokens: 1100 }])
  db.close()
})

test('from is inclusive, to is exclusive', () => {
  const db = openTestLedger()
  fixture(db)
  assert.deepEqual(report(db, 'subagent', { from: '2026-10-01T08:00:00.000Z' }).map(r => r.key), ['subagent'])
  assert.deepEqual(report(db, 'subagent', { to: '2026-10-01T08:00:00.000Z' }).map(r => r.key), ['main'])
  assert.deepEqual(report(db, 'subagent', { from: '2026-10-01T08:00:00.000Z', to: '2026-10-01T08:00:00.001Z' }).map(r => r.key), ['subagent'])
  assert.deepEqual(report(db, 'subagent', { from: '2026-10-01T10:00:00+02:00' }).map(r => r.key), ['subagent'])
  assert.deepEqual(report(db, 'subagent', { to: '2026-10-01T10:00:00+02:00' }).map(r => r.key), ['main'])
  assert.deepEqual(report(db, 'subagent', { from: '2026-10-01T08:00:00Z' }).map(r => r.key), ['subagent'])
  assert.deepEqual(report(db, 'subagent', { to: '2026-10-01T08:00:00Z' }).map(r => r.key), ['main'])
  assert.throws(() => report(db, 'subagent', { from: 'garbage' }), RangeError)
  db.close()
})

test('unpricedByModel lists unpriced statuses only, biggest token volume first', () => {
  const db = openTestLedger()
  fixture(db)
  insertTestMessage(db, { source_message_id: 'g' })
  assert.deepEqual(unpricedByModel(db), [
    { status: 'not_priced', modelRaw: 'claude-sonnet-5', messages: 1, tokens: 1100 },
    { status: 'missing_alias', modelRaw: 'mystery', messages: 1, tokens: 500 },
  ])
  db.close()
})

test('every dimension sums to the same total, and reportTotal matches', () => {
  const db = openTestLedger()
  fixture(db)
  const total = reportTotal(db)
  assert.equal(total.key, 'TOTAL')
  near(total.costUsd, 3.5)
  assert.equal(total.messages, 6)
  assert.equal(total.tokens, 3_003_800)
  for (const dim of REPORT_DIMENSIONS) {
    const rows = report(db, dim)
    near(rows.reduce((s, r) => s + r.costUsd, 0), 3.5)
    assert.equal(rows.reduce((s, r) => s + r.messages, 0), 6)
    assert.equal(rows.reduce((s, r) => s + r.tokens, 0), 3_003_800)
  }
  db.close()
})

test('an empty ledger reports no rows and a zero total', () => {
  const db = openTestLedger()
  assert.deepEqual(report(db, 'repo'), [])
  assert.deepEqual(reportTotal(db), { key: 'TOTAL', costUsd: 0, messages: 0, pricedMessages: 0, unpricedMessages: 0, excludedMessages: 0, tokens: 0, unpricedTokens: 0 })
  assert.deepEqual(unpricedByModel(db), [])
  db.close()
})

test('loggedVsComputed compares tool-logged cost with computed cost per tool and model, and flags gaps over 10%', () => {
  const db = openTestLedger()
  const a = insertTestMessage(db, { source_message_id: 'a', tool: 'opencode', logged_cost_usd: 1 })
  const b = insertTestMessage(db, { source_message_id: 'b', tool: 'opencode', logged_cost_usd: 1 })
  const c = insertTestMessage(db, { source_message_id: 'c', tool: 'pi', model_raw: 'gpt-6-luna', logged_cost_usd: 1 })
  const d = insertTestMessage(db, { source_message_id: 'd', tool: 'pi', model_raw: 'free', logged_cost_usd: 0 })
  const e = insertTestMessage(db, { source_message_id: 'e', tool: 'opencode' })
  const f = insertTestMessage(db, { source_message_id: 'f', tool: 'opencode', model_raw: 'mystery', logged_cost_usd: 5 })
  priceRun(db, [
    { id: a, status: 'priced', cost: 1.05, modelId: 'claude-sonnet-5' },
    { id: b, status: 'priced', cost: 1.05, modelId: 'claude-sonnet-5' },
    { id: c, status: 'priced', cost: 0.5, modelId: 'gpt-6-luna' },
    { id: d, status: 'priced', cost: 0.25, modelId: 'free' },
    { id: e, status: 'priced', cost: 9, modelId: 'claude-sonnet-5' },
    { id: f, status: 'missing_alias', cost: null },
  ])
  const rows = loggedVsComputed(db)
  assert.deepEqual(rows.map(r => [r.tool, r.model, r.messages, r.flagged]), [
    ['opencode', 'claude-sonnet-5', 2, false],
    ['pi', 'free', 1, true],
    ['pi', 'gpt-6-luna', 1, true],
  ])
  near(rows[0]?.loggedUsd ?? 0, 2)
  near(rows[0]?.computedUsd ?? 0, 2.1)
  near(rows[0]?.diffPct ?? 0, 0.05)
  assert.equal(rows[1]?.diffPct, null)
  near(rows[2]?.diffPct ?? 0, -0.5)
  db.close()
})

test('traceMessage returns the source location, latest-run cost and the exact price rows used', () => {
  const db = openTestLedger()
  db.raw.prepare("INSERT INTO models (model_id, vendor) VALUES ('claude-sonnet-5', 'anthropic')").run()
  const p1 = Number(db.raw.prepare("INSERT INTO prices (model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, source_note, created_at) VALUES ('claude-sonnet-5','input',0,2,'2020-01-01T00:00:00.000Z','seed','x')").run().lastInsertRowid)
  const p2 = Number(db.raw.prepare("INSERT INTO prices (model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, source_note, created_at) VALUES ('claude-sonnet-5','output',0,10,'2020-01-01T00:00:00.000Z','seed','x')").run().lastInsertRowid)
  const id = insertTestMessage(db, { source_message_id: 'msg_t', source_path: '/t/s.jsonl', source_locator: 'line:42' })
  const run = Number(db.raw.prepare("INSERT INTO pricing_runs (started_at, note) VALUES (?, '')").run(FIXED_NOW).lastInsertRowid)
  db.raw.prepare("INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, price_ids, pricing_status) VALUES (?, ?, 'claude-sonnet-5', 0.003, ?, 'priced')").run(run, id, JSON.stringify([p1, p2]))
  const [t, ...rest] = traceMessage(db, 'msg_t')
  assert.equal(rest.length, 0)
  assert.equal(t?.message.source_path, '/t/s.jsonl')
  assert.equal(t?.message.source_locator, 'line:42')
  assert.equal(t?.runId, run)
  assert.equal(t?.status, 'priced')
  assert.equal(t?.costUsd, 0.003)
  assert.deepEqual(t?.prices.map(p => [p.id, p.tokenClass, p.usdPerMillion]), [[p1, 'input', 2], [p2, 'output', 10]])
  assert.deepEqual(traceMessage(db, 'nope'), [])
  db.close()
})

test('traceMessage on a message never priced says not_priced with no price rows', () => {
  const db = openTestLedger()
  insertTestMessage(db, { source_message_id: 'lone' })
  const [t] = traceMessage(db, 'lone')
  assert.equal(t?.status, 'not_priced')
  assert.equal(t?.runId, null)
  assert.deepEqual(t?.prices, [])
  db.close()
})
