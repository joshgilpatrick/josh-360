import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptance, compareWeeks, firstTsByKey, isCompleteWeek, ledgerWeekly, modelGroup } from '../../src/costledger/reconcile.ts'
import type { BifrostWeekRow, LedgerWeekRow } from '../../src/costledger/reconcile.ts'
import { FIXED_NOW, insertTestMessage, openTestLedger } from '../helpers/costledger.ts'
import type { LedgerDb } from '../../src/costledger/db.ts'

function priceRun(db: LedgerDb, entries: Array<{ id: number; status: string; cost: number | null; modelId?: string }>): number {
  const run = Number(db.raw.prepare("INSERT INTO pricing_runs (started_at, note) VALUES (?, '')").run(FIXED_NOW).lastInsertRowid)
  const ins = db.raw.prepare('INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) VALUES (?, ?, ?, ?, ?)')
  for (const e of entries) ins.run(run, e.id, e.modelId ?? null, e.cost, e.status)
  return run
}

const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`)
const L = (week: string, virtualKey: string, modelGroup: string, costUsd: number, messages = 1): LedgerWeekRow =>
  ({ week, virtualKey, modelGroup, costUsd, messages, unpricedMessages: 0, suspectMessages: 0, promptTokens: 0, outputTokens: 0 })
const B = (week: string, virtualKey: string, model: string, costUsd: number, requests = 1): BifrostWeekRow =>
  ({ week, virtualKey, model, costUsd, requests, failures: 0, promptTokens: 0, outputTokens: 0 })
const START = '2026-09-14T00:00:00.000Z'
const OPTS = { nowIso: '2026-10-13T00:00:00.000Z', firstTsByKey: { 'claude-code-cli': START, opencode: START, pi: START } }

function ledgerFixture(db: LedgerDb) {
  const m1 = insertTestMessage(db, { source_message_id: 'm1', ts_utc: '2026-09-27T23:59:59.999Z' })
  const m2 = insertTestMessage(db, { source_message_id: 'm2', ts_utc: '2026-09-28T00:00:00.000Z' })
  const m3 = insertTestMessage(db, { source_message_id: 'm3', tool: 'opencode', model_raw: 'gpt-5.6-luna', ts_utc: '2026-09-29T10:00:00.000Z' })
  const m4 = insertTestMessage(db, { source_message_id: 'm4', tool: 'pi', model_raw: 'azure/gpt-6-luna', ts_utc: '2026-09-29T11:00:00.000Z' })
  const m5 = insertTestMessage(db, { source_message_id: 'm5', model_raw: 'mystery', ts_utc: '2026-09-29T12:00:00.000Z' })
  const entries = [
    { id: m1, status: 'priced', cost: 1, modelId: 'claude-sonnet-5' },
    { id: m2, status: 'priced', cost: 2, modelId: 'claude-sonnet-5' },
    { id: m3, status: 'priced', cost: 0.3, modelId: 'gpt-5.6-luna' },
    { id: m4, status: 'priced', cost: 0.2 },
    { id: m5, status: 'missing_alias', cost: null },
  ]
  priceRun(db, entries)
  return entries
}

test('modelGroup strips one prefix, lowercases and groups gpt-5.6-luna with gpt-6-luna', () => {
  assert.equal(modelGroup('Azure/GPT-5.6-Luna'), 'gpt-6-luna')
  assert.equal(modelGroup('gpt-6-luna'), 'gpt-6-luna')
  assert.equal(modelGroup('anthropic/claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(modelGroup('azure/azure/x'), 'azure/x')
})

test('ledgerWeekly: Sunday and Monday split at the UTC week boundary; tools map to virtual keys; models are grouped', () => {
  const db = openTestLedger()
  const entries = ledgerFixture(db)
  const rows = ledgerWeekly(db)
  assert.deepEqual(rows.map(r => [r.week, r.virtualKey, r.modelGroup, r.messages, r.unpricedMessages]), [
    ['2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 1, 0],
    ['2026-09-28', 'claude-code-cli', 'claude-sonnet-5', 1, 0],
    ['2026-09-28', 'claude-code-cli', 'mystery', 0, 1],
    ['2026-09-28', 'opencode', 'gpt-6-luna', 1, 0],
    ['2026-09-28', 'pi', 'gpt-6-luna', 1, 0],
  ])
  near(rows[0]?.costUsd, 1)
  near(rows[1]?.costUsd, 2)
  near(rows[3]?.costUsd, 0.3)
  near(rows[4]?.costUsd, 0.2)
  const u1 = insertTestMessage(db, { source_message_id: 'u1', tool: 'pi', model_raw: 'azure/gpt-5.6-luna', ts_utc: '2026-09-29T13:00:00.000Z' })
  const u2 = insertTestMessage(db, { source_message_id: 'u2', tool: 'pi', model_raw: 'gpt-6-luna', ts_utc: '2026-09-29T14:00:00.000Z' })
  const u3 = insertTestMessage(db, { source_message_id: 'u3', tool: 'pi', model_raw: 'azure/gpt-6-luna', ts_utc: '2026-09-29T15:00:00.000Z' })
  priceRun(db, [...entries, { id: u1, status: 'missing_alias', cost: null }, { id: u2, status: 'missing_price', cost: null }, { id: u3, status: 'missing_alias', cost: null }])
  const pi = ledgerWeekly(db).find(r => r.virtualKey === 'pi' && r.week === '2026-09-28' && r.modelGroup === 'gpt-6-luna')
  assert.equal(pi?.unpricedMessages, 3)
  assert.equal(pi?.messages, 1)
  db.close()
})

test('ledgerWeekly sums prompt-side and output tokens of priced and unpriced rows, not suspect rows', () => {
  const db = openTestLedger()
  const a = insertTestMessage(db, { source_message_id: 'a', input_tokens: 10, cache_read_tokens: 100, cache_write_5m_tokens: 1000, cache_write_1h_tokens: 10_000, cache_write_unclassified_tokens: 100_000, output_tokens: 7 })
  const b = insertTestMessage(db, { source_message_id: 'b', model_raw: 'mystery', input_tokens: 5, output_tokens: 3 })
  const s = insertTestMessage(db, { source_message_id: 's', input_tokens: 9_000_000, output_tokens: 9 })
  priceRun(db, [{ id: a, status: 'priced', cost: 1, modelId: 'claude-sonnet-5' }, { id: b, status: 'missing_alias', cost: null }, { id: s, status: 'suspect', cost: null, modelId: 'claude-sonnet-5' }])
  const rows = ledgerWeekly(db)
  const sonnet = rows.find(r => r.modelGroup === 'claude-sonnet-5')
  const mystery = rows.find(r => r.modelGroup === 'mystery')
  assert.equal(sonnet?.promptTokens, 111_110)
  assert.equal(sonnet?.outputTokens, 7)
  assert.equal(mystery?.promptTokens, 5)
  assert.equal(mystery?.outputTokens, 3)
  db.close()
})

test('ledgerWeekly merges models that share a group inside one key and week', () => {
  const db = openTestLedger()
  const x = insertTestMessage(db, { source_message_id: 'x', tool: 'opencode', model_raw: 'gpt-5.6-luna', ts_utc: '2026-09-29T10:00:00.000Z' })
  const y = insertTestMessage(db, { source_message_id: 'y', tool: 'opencode', model_raw: 'gpt-6-luna', ts_utc: '2026-09-29T11:00:00.000Z' })
  priceRun(db, [{ id: x, status: 'priced', cost: 0.3, modelId: 'gpt-5.6-luna' }, { id: y, status: 'priced', cost: 0.1, modelId: 'gpt-6-luna' }])
  const rows = ledgerWeekly(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.messages, 2)
  near(rows[0]?.costUsd, 0.4)
  db.close()
})

test('ledgerWeekly reads only the latest pricing run; suspect and no_usage rows are not counted', () => {
  const db = openTestLedger()
  const entries = ledgerFixture(db)
  const s = insertTestMessage(db, { source_message_id: 's', ts_utc: '2026-09-29T13:00:00.000Z' })
  const n = insertTestMessage(db, { source_message_id: 'n', ts_utc: '2026-09-29T14:00:00.000Z' })
  priceRun(db, [
    ...entries.map(e => (e.id === entries[0]?.id ? { ...e, cost: 10 } : e)),
    { id: s, status: 'suspect', cost: null },
    { id: n, status: 'no_usage', cost: null },
  ])
  const rows = ledgerWeekly(db)
  near(rows[0]?.costUsd, 10)
  assert.equal(rows.length, 5)
  db.close()
})

test('firstTsByKey gives the earliest message per virtual key, empty when no messages', () => {
  const db = openTestLedger()
  assert.deepEqual(firstTsByKey(db), {})
  ledgerFixture(db)
  assert.deepEqual(firstTsByKey(db), { 'claude-code-cli': '2026-09-27T23:59:59.999Z', opencode: '2026-09-29T10:00:00.000Z', pi: '2026-09-29T11:00:00.000Z' })
  db.close()
})

test('compareWeeks: outer join, model-group merge, 10% boundary is inside, one-sided rows', () => {
  const ledger = [L('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 100), L('2026-09-28', 'claude-code-cli', 'claude-sonnet-5', 90), L('2026-09-28', 'pi', 'gpt-6-luna', 5)]
  const bifrost = [
    B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 100, 10),
    B('2026-09-28', 'claude-code-cli', 'claude-sonnet-5', 100, 8),
    B('2026-09-28', 'opencode', 'azure/gpt-6-luna', 3, 3),
    B('2026-09-28', 'opencode', 'gpt-5.6-luna', 1, 1),
  ]
  const rows = compareWeeks(ledger, bifrost, OPTS)
  assert.deepEqual(rows.map(r => [r.week, r.virtualKey, r.modelGroup]), [
    ['2026-09-21', 'claude-code-cli', 'claude-sonnet-5'],
    ['2026-09-28', 'claude-code-cli', 'claude-sonnet-5'],
    ['2026-09-28', 'opencode', 'gpt-6-luna'],
    ['2026-09-28', 'pi', 'gpt-6-luna'],
  ])
  const [a, b, c, d] = rows
  assert.equal(a?.diffPct, 0)
  assert.equal(a?.withinTolerance, true)
  assert.equal(a?.bifrostRequests, 10)
  assert.equal(b?.diffUsd, -10)
  assert.equal(b?.diffPct, -0.1)
  assert.equal(b?.withinTolerance, true)
  assert.equal(c?.bifrostCostUsd, 4)
  assert.equal(c?.bifrostRequests, 4)
  assert.equal(c?.ledgerCostUsd, 0)
  assert.equal(c?.ledgerMessages, 0)
  assert.equal(c?.diffPct, -1)
  assert.equal(c?.withinTolerance, false)
  assert.equal(d?.bifrostCostUsd, 0)
  assert.equal(d?.diffPct, null)
  assert.equal(d?.withinTolerance, false)
  assert.ok(rows.every(r => r.complete))
})

test('compareWeeks compares prompt-side and output tokens', () => {
  const l = { ...L('2026-09-21', 'pi', 'm', 1), promptTokens: 880, outputTokens: 50 }
  const b = { ...B('2026-09-21', 'pi', 'm', 1), promptTokens: 1000, outputTokens: 0 }
  const [r] = compareWeeks([l], [b], OPTS)
  assert.equal(r?.ledgerPromptTokens, 880)
  assert.equal(r?.bifrostPromptTokens, 1000)
  near(r?.promptTokenDiffPct ?? undefined, -0.12)
  assert.equal(r?.ledgerOutputTokens, 50)
  assert.equal(r?.outputTokenDiffPct, null)
})

test('compareWeeks: a ledger of zero against a Bifrost of zero is within tolerance', () => {
  const rows = compareWeeks([L('2026-09-21', 'pi', 'x', 0, 0)], [], OPTS)
  assert.equal(rows[0]?.diffPct, null)
  assert.equal(rows[0]?.withinTolerance, true)
})

test('compareWeeks: completeness is judged against each key\'s own first message', () => {
  const opts = { nowIso: OPTS.nowIso, firstTsByKey: { 'claude-code-cli': START, opencode: '2026-09-28T16:55:16.107Z' } }
  const rows = compareWeeks([], [B('2026-09-21', 'claude-code-cli', 'm', 1), B('2026-09-21', 'opencode', 'm', 1), B('2026-09-21', 'pi', 'm', 1)], opts)
  assert.deepEqual(rows.map(r => [r.virtualKey, r.complete]), [['claude-code-cli', true], ['opencode', false], ['pi', false]])
})

test('isCompleteWeek: partial first week, exact end boundary, current week, Monday start', () => {
  assert.equal(isCompleteWeek('2026-09-21', '2026-10-13T00:00:00.000Z', '2026-09-23T10:00:00.000Z'), false)
  assert.equal(isCompleteWeek('2026-09-28', '2026-10-05T00:00:00.000Z', '2026-09-23T10:00:00.000Z'), true)
  assert.equal(isCompleteWeek('2026-09-28', '2026-10-04T23:59:59.999Z', '2026-09-23T10:00:00.000Z'), false)
  assert.equal(isCompleteWeek('2026-10-05', '2026-10-08T00:00:00.000Z', '2026-09-23T10:00:00.000Z'), false)
  assert.equal(isCompleteWeek('2026-09-21', '2026-10-13T00:00:00.000Z', '2026-09-21T00:00:00.000Z'), true)
  assert.equal(isCompleteWeek('2026-09-21', '2026-10-13T00:00:00.000Z', null), false)
})

test('acceptance covers all three keys; it passes only when every key passes', () => {
  const ledger = [L('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 100), L('2026-09-28', 'claude-code-cli', 'claude-sonnet-5', 90), L('2026-09-21', 'opencode', 'gpt-6-luna', 10), L('2026-09-21', 'pi', 'gpt-6-luna', 5)]
  const bifrost = [B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 100), B('2026-09-28', 'claude-code-cli', 'claude-sonnet-5', 100), B('2026-09-21', 'opencode', 'gpt-6-luna', 10.5), B('2026-09-21', 'pi', 'gpt-6-luna', 5)]
  const result = acceptance(compareWeeks(ledger, bifrost, OPTS))
  assert.deepEqual(result.keys.map(k => [k.virtualKey, k.status, k.evaluatedWeeks]), [['claude-code-cli', 'PASS', 2], ['opencode', 'PASS', 1], ['pi', 'PASS', 1]])
  assert.equal(result.allPass, true)
  const claude = result.keys[0]
  assert.deepEqual(claude?.weeks.map(w => w.week), ['2026-09-21', '2026-09-28'])
  assert.equal(claude?.weeks[1]?.sessionAttributedUsd, 90)
  assert.equal(claude?.weeks[1]?.unattributedRemainderUsd, 10)
})

test('acceptance fails when one key fails, and names the models behind the gap, biggest first', () => {
  const ledger = [L('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 100), L('2026-09-21', 'opencode', 'gpt-6-luna', 10), L('2026-09-21', 'opencode', 'kimi', 1), L('2026-09-21', 'pi', 'gpt-6-luna', 5)]
  const bifrost = [B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 100), B('2026-09-21', 'opencode', 'gpt-6-luna', 12), B('2026-09-21', 'opencode', 'kimi', 4), B('2026-09-21', 'pi', 'gpt-6-luna', 5)]
  const result = acceptance(compareWeeks(ledger, bifrost, OPTS))
  assert.equal(result.allPass, false)
  const oc = result.keys.find(k => k.virtualKey === 'opencode')
  assert.equal(oc?.status, 'FAIL')
  assert.deepEqual(oc?.weeks[0]?.gapModels, [{ modelGroup: 'kimi', diffUsd: -3 }, { modelGroup: 'gpt-6-luna', diffUsd: -2 }])
  assert.deepEqual(result.keys.find(k => k.virtualKey === 'claude-code-cli')?.weeks[0]?.gapModels, [])
})

test('a key with no complete week is NOT_EVALUATED, and that blocks allPass', () => {
  const opts = { nowIso: OPTS.nowIso, firstTsByKey: { 'claude-code-cli': START, opencode: START } }
  const ledger = [L('2026-09-21', 'claude-code-cli', 'm', 1), L('2026-09-21', 'opencode', 'm', 1)]
  const bifrost = [B('2026-09-21', 'claude-code-cli', 'm', 1), B('2026-09-21', 'opencode', 'm', 1)]
  const result = acceptance(compareWeeks(ledger, bifrost, opts))
  assert.deepEqual(result.keys.map(k => [k.virtualKey, k.status]), [['claude-code-cli', 'PASS'], ['opencode', 'PASS'], ['pi', 'NOT_EVALUATED']])
  assert.equal(result.allPass, false)
})

test('acceptance sums model groups inside a week', () => {
  const ledger = [{ ...L('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 50), unpricedMessages: 3 }, { ...L('2026-09-21', 'claude-code-cli', 'claude-opus-5-5', 50), unpricedMessages: 2 }]
  const bifrost = [B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 60), B('2026-09-21', 'claude-code-cli', 'claude-opus-5-5', 40)]
  const result = acceptance(compareWeeks(ledger, bifrost, OPTS), ['claude-code-cli'])
  assert.equal(result.keys[0]?.evaluatedWeeks, 1)
  assert.equal(result.keys[0]?.weeks[0]?.sessionAttributedUsd, 100)
  assert.equal(result.keys[0]?.weeks[0]?.bifrostCostUsd, 100)
  assert.equal(result.keys[0]?.weeks[0]?.unpricedMessages, 5)
  assert.equal(result.allPass, true)
})

test('ledgerWeekly counts suspect rows per group: raw names that merge are summed, and a suspect-only group still appears', () => {
  const db = openTestLedger()
  const x = insertTestMessage(db, { source_message_id: 'sx', tool: 'opencode', model_raw: 'gpt-5.6-luna', ts_utc: '2026-09-29T10:00:00.000Z' })
  const y = insertTestMessage(db, { source_message_id: 'sy', tool: 'opencode', model_raw: 'gpt-6-luna', ts_utc: '2026-09-29T11:00:00.000Z' })
  const p = insertTestMessage(db, { source_message_id: 'sp', ts_utc: '2026-09-29T12:00:00.000Z' })
  const q = insertTestMessage(db, { source_message_id: 'sq', tool: 'pi', model_raw: 'gpt-9-zeta', ts_utc: '2026-09-29T13:00:00.000Z' })
  const r = insertTestMessage(db, { source_message_id: 'sr', ts_utc: '2026-09-29T14:00:00.000Z' })
  priceRun(db, [{ id: x, status: 'suspect', cost: null }, { id: y, status: 'suspect', cost: null }, { id: p, status: 'priced', cost: 1, modelId: 'claude-sonnet-5' }, { id: q, status: 'no_usage', cost: null }, { id: r, status: 'no_usage', cost: null }])
  const rows = ledgerWeekly(db)
  // no_usage is neither suspect nor unpriced: a no_usage-only group does not appear, and a no_usage row inside a group adds nothing
  assert.equal(rows.length, 2)
  assert.equal(rows.some(g => g.modelGroup === 'gpt-9-zeta'), false)
  const luna = rows.find(r => r.modelGroup === 'gpt-6-luna')
  assert.equal(luna?.suspectMessages, 2)
  assert.equal(luna?.messages, 0)
  assert.equal(luna?.unpricedMessages, 0)
  const sonnet = rows.find(r => r.modelGroup === 'claude-sonnet-5')
  assert.equal(sonnet?.suspectMessages, 0)
  assert.equal(sonnet?.unpricedMessages, 0)
  assert.equal(sonnet?.messages, 1)
  db.close()
})

test('acceptance reports suspectMessages as the sum across model rows and leaves pass, cost and diff numbers unchanged', () => {
  const clean = [L('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 50), L('2026-09-21', 'claude-code-cli', 'claude-opus-5-5', 50)]
  const withSuspect = [{ ...clean[0]!, suspectMessages: 3 }, { ...clean[1]!, suspectMessages: 2 }]
  for (const bifrost of [
    [B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 60), B('2026-09-21', 'claude-code-cli', 'claude-opus-5-5', 40)],
    [B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 200), B('2026-09-21', 'claude-code-cli', 'claude-opus-5-5', 40)],
  ]) {
    const base = acceptance(compareWeeks(clean, bifrost, OPTS), ['claude-code-cli']).keys[0]?.weeks[0]
    const sus = acceptance(compareWeeks(withSuspect, bifrost, OPTS), ['claude-code-cli']).keys[0]?.weeks[0]
    assert.equal(base?.suspectMessages, 0)
    assert.equal(sus?.suspectMessages, 5)
    assert.deepEqual({ ...sus, suspectMessages: 0 }, base)
  }
  const passWeek = acceptance(compareWeeks(withSuspect, [B('2026-09-21', 'claude-code-cli', 'claude-sonnet-5', 60), B('2026-09-21', 'claude-code-cli', 'claude-opus-5-5', 40)], OPTS), ['claude-code-cli'])
  assert.equal(passWeek.keys[0]?.weeks[0]?.pass, true)
  assert.equal(passWeek.allPass, true)
})
