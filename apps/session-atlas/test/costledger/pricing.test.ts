import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addAlias, addModel, addPrice, normalizeModelName, resolveModel, runPricing, seedPrices, SEED_PATH } from '../../src/costledger/pricing.ts'
import { FIXED_NOW, insertTestMessage, openTestLedger } from '../helpers/costledger.ts'
import type { LedgerDb } from '../../src/costledger/db.ts'

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`)
const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_write_unclassified_tokens: 0 }

function seeded(): LedgerDb {
  const db = openTestLedger()
  seedPrices(db, SEED_PATH, FIXED_NOW)
  return db
}
function priceOne(db: LedgerDb, over: Parameters<typeof insertTestMessage>[1]): { status: string; cost: number | null; modelId: string | null } {
  const id = insertTestMessage(db, over)
  const r = runPricing(db, FIXED_NOW)
  const row = db.raw.prepare('SELECT pricing_status s, computed_cost_usd c, model_id m FROM message_costs WHERE run_id = ? AND message_id = ?').get(r.runId, id) as { s: string; c: number | null; m: string | null }
  return { status: row.s, cost: row.c, modelId: row.m }
}

test('seed loads models, aliases and prices, and a second seed inserts nothing', () => {
  const db = openTestLedger()
  const first = seedPrices(db, SEED_PATH, FIXED_NOW)
  assert.ok(first > 100)
  assert.equal(seedPrices(db, SEED_PATH, FIXED_NOW), 0)
  assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM models WHERE model_id = 'claude-sonnet-5'").get() as { c: number }).c, 1)
  assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM models WHERE model_id = 'claude-fable-5'").get() as { c: number }).c, 1)
  assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM models WHERE model_id = 'gpt-5.6-terra'").get() as { c: number }).c, 1)
  assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM model_aliases WHERE alias = 'big-pickle'").get() as { c: number }).c, 1)
  db.close()
})

test('the GPT-6.1-Sol seed uses its published effective date', () => {
  const db = openTestLedger()
  seedPrices(db, SEED_PATH, FIXED_NOW)
  const row = db.raw.prepare("SELECT effective_from FROM prices WHERE model_id = 'gpt-6.1-sol' AND token_class = 'input' AND min_prompt_tokens = 0").get() as { effective_from: string } | undefined
  assert.equal(row?.effective_from, '2026-10-01T00:00:00.000Z')
  db.close()
})

test('normalizeModelName strips one provider prefix and lowercases', () => {
  assert.equal(normalizeModelName('Azure/GPT-6-Luna'), 'gpt-6-luna')
  assert.equal(normalizeModelName('anthropic/claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(normalizeModelName('azure_ai/DeepSeek-V4-Flash-0731'), 'deepseek-v4-flash-0731')
  assert.equal(normalizeModelName('azure/azure/x'), 'azure/x')
})

test('resolveModel: direct, prefixed, alias, unknown (never fuzzy)', () => {
  const db = seeded()
  assert.equal(resolveModel(db, 'claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(resolveModel(db, 'azure/gpt-6-luna'), 'gpt-6-luna')
  assert.equal(resolveModel(db, 'DeepSeek-V4-Flash-0731'), 'deepseek-v4-flash-0731')
  assert.equal(resolveModel(db, 'claude-haiku-4-5-20251001'), 'claude-haiku-4-5')
  assert.equal(resolveModel(db, 'big-pickle'), 'opencode-free')
  assert.equal(resolveModel(db, 'claude-sonnet-5-extra'), null)
  assert.equal(resolveModel(db, 'gpt-6'), null)
  db.close()
})

test('cost uses every token class; unclassified cache writes use the 5m rate', () => {
  const db = seeded()
  const r = priceOne(db, { model_raw: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 100, cache_read_tokens: 2000, cache_write_5m_tokens: 3000, cache_write_1h_tokens: 500, cache_write_unclassified_tokens: 200 })
  assert.equal(r.status, 'priced')
  assert.equal(r.modelId, 'claude-sonnet-5')
  // (1000*2 + 100*10 + 2000*0.2 + (3000+200)*2.5 + 500*4) / 1e6
  near(r.cost, 0.0134)
  db.close()
})

test('long-context tier applies above 272k prompt-side tokens, base rates at or below', () => {
  const db = seeded()
  const hi = priceOne(db, { source_message_id: 'hi', model_raw: 'gpt-5.6-luna', ...zero, input_tokens: 300_000, output_tokens: 1000 })
  near(hi.cost, 300_000 * 0.4 / 1e6 + 1000 * 1.8 / 1e6)
  const lo = priceOne(db, { source_message_id: 'lo', model_raw: 'gpt-5.6-luna', ...zero, input_tokens: 272_000, output_tokens: 1000 })
  near(lo.cost, 272_000 * 0.2 / 1e6 + 1000 * 1.2 / 1e6)
  db.close()
})

test('claude-haiku-5-5 is priced from the seed: base rates up to 100k prompt tokens, the higher tier above', () => {
  const db = seeded()
  const base = priceOne(db, { source_message_id: 'hk-base', model_raw: 'claude-haiku-5-5', ...zero, input_tokens: 100_000, output_tokens: 1000, cache_read_tokens: 0 })
  near(base.cost, 100_000 * 0.1 / 1e6 + 1000 * 0.5 / 1e6)
  const high = priceOne(db, { source_message_id: 'hk-high', model_raw: 'claude-haiku-5-5', ...zero, input_tokens: 100_001, output_tokens: 1000 })
  near(high.cost, 100_001 * 0.5 / 1e6 + 1000 * 2.5 / 1e6)
  db.close()
})

test('prompt-side tokens for the tier include cache reads and writes', () => {
  const db = seeded()
  const r = priceOne(db, { model_raw: 'gpt-5.6-luna', ...zero, input_tokens: 10, cache_read_tokens: 280_000, output_tokens: 0 })
  near(r.cost, 10 * 0.4 / 1e6 + 280_000 * 0.04 / 1e6)
  db.close()
})

test('gpt-5.6-terra uses its seeded rates below and above the long-context threshold', () => {
  const db = seeded()
  const base = priceOne(db, { source_message_id: 'terra-base', model_raw: 'gpt-5.6-terra', ...zero, input_tokens: 272_000, output_tokens: 1000 })
  near(base.cost, 272_000 * 2 / 1e6 + 1000 * 12 / 1e6)
  const long = priceOne(db, { source_message_id: 'terra-long', model_raw: 'gpt-5.6-terra', ...zero, input_tokens: 10, cache_read_tokens: 272_000, output_tokens: 1000 })
  near(long.cost, 10 * 4 / 1e6 + 272_000 * 0.4 / 1e6 + 1000 * 18 / 1e6)
  db.close()
})

test('claude-fable-5 uses its seeded flat rates for input, output, and cache tokens', () => {
  const db = seeded()
  const r = priceOne(db, { model_raw: 'claude-fable-5', ...zero, input_tokens: 1_000_000, output_tokens: 1000, cache_read_tokens: 100_000, cache_write_5m_tokens: 10_000, cache_write_1h_tokens: 5_000 })
  near(r.cost, 10.375)
  db.close()
})

test('gpt-6-luna uses OpenAI list rates across providers with a tier above 272,000 total prompt tokens', () => {
  const db = seeded()
  const base = priceOne(db, { source_message_id: 'luna-base', provider_raw: 'bifrost-responses', model_raw: 'azure/gpt-6-luna', ...zero, input_tokens: 272_000, output_tokens: 1000 })
  near(base.cost, 272_000 * 0.1 / 1e6 + 1000 * 0.5 / 1e6)
  const long = priceOne(db, { source_message_id: 'luna-long', provider_raw: 'bifrost-responses', model_raw: 'azure/gpt-6-luna', ...zero, input_tokens: 10, cache_read_tokens: 272_000, output_tokens: 1000 })
  near(long.cost, 10 * 0.2 / 1e6 + 272_000 * 0.02 / 1e6 + 1000 * 0.75 / 1e6)
  db.close()
})

test('a price change takes effect exactly at effectiveFrom; older messages keep the old price; history is kept', () => {
  const db = seeded()
  addPrice(db, { modelId: 'claude-sonnet-5', tokenClass: 'input', minPromptTokens: 0, usdPerMillion: 3, effectiveFrom: '2026-09-30T12:00:00.000Z', sourceNote: 'test change' }, FIXED_NOW)
  const before = priceOne(db, { source_message_id: 'b', model_raw: 'claude-sonnet-5', ...zero, input_tokens: 1_000_000, ts_utc: '2026-09-30T11:59:59.999Z' })
  const at = priceOne(db, { source_message_id: 'a', model_raw: 'claude-sonnet-5', ...zero, input_tokens: 1_000_000, ts_utc: '2026-09-30T12:00:00.000Z' })
  near(before.cost, 2)
  near(at.cost, 3)
  const rows = db.raw.prepare("SELECT effective_from f, effective_to t, usd_per_million u FROM prices WHERE model_id='claude-sonnet-5' AND token_class='input' AND min_prompt_tokens=0 ORDER BY effective_from").all() as Array<{ f: string; t: string | null; u: number }>
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.t, '2026-09-30T12:00:00.000Z')
  assert.equal(rows[0]?.u, 2)
  assert.equal(rows[1]?.t, null)
  db.close()
})

test('addPrice refuses a date that is not later than the open row', () => {
  const db = seeded()
  assert.throws(() => addPrice(db, { modelId: 'claude-sonnet-5', tokenClass: 'input', minPromptTokens: 0, usdPerMillion: 9, effectiveFrom: '2020-01-01T00:00:00.000Z', sourceNote: 'x' }, FIXED_NOW), /later than the current price row/)
  db.close()
})

test('message before any price row is missing_price, not zero', () => {
  const db = seeded()
  const r = priceOne(db, { model_raw: 'claude-sonnet-5', ...zero, input_tokens: 1000, ts_utc: '2019-12-31T23:59:59.999Z' })
  assert.equal(r.status, 'missing_price')
  assert.equal(r.cost, null)
  db.close()
})

test('known model without a rate for a class that has tokens is missing_price; zero-token classes need no rate', () => {
  const db = openTestLedger()
  db.raw.prepare("INSERT INTO models (model_id, vendor) VALUES ('thin','v')").run()
  db.raw.prepare("INSERT INTO prices (model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, created_at) VALUES ('thin','input',0,1,'2020-01-01T00:00:00.000Z','x'),('thin','output',0,2,'2020-01-01T00:00:00.000Z','x')").run()
  const ok = priceOne(db, { source_message_id: 'ok', model_raw: 'thin', ...zero, input_tokens: 1_000_000, output_tokens: 1_000_000 })
  assert.equal(ok.status, 'priced')
  near(ok.cost, 3)
  const bad = priceOne(db, { source_message_id: 'bad', model_raw: 'thin', ...zero, input_tokens: 10, cache_read_tokens: 5 })
  assert.equal(bad.status, 'missing_price')
  db.close()
})

test('unmapped model is missing_alias with no model id', () => {
  const db = seeded()
  const r = priceOne(db, { model_raw: 'mystery-model-9' })
  assert.deepEqual(r, { status: 'missing_alias', cost: null, modelId: null })
  db.close()
})

test('addModel registers a new model that can then be priced; names are stored in lookup form', () => {
  const db = seeded()
  assert.equal(addModel(db, { modelId: 'Azure/GPT-9-Test', vendor: 'openai' }), 'gpt-9-test')
  assert.equal(resolveModel(db, 'azure/gpt-9-test'), 'gpt-9-test')
  addPrice(db, { modelId: 'gpt-9-test', tokenClass: 'input', minPromptTokens: 0, usdPerMillion: 2, effectiveFrom: '2026-01-01T00:00:00.000Z', sourceNote: 't' }, FIXED_NOW)
  const r = priceOne(db, { model_raw: 'gpt-9-test', ...zero, input_tokens: 1_000_000 })
  assert.equal(r.status, 'priced')
  near(r.cost, 2)
  db.close()
})

test('addModel refuses a duplicate, an existing alias name, and blank input', () => {
  const db = seeded()
  assert.throws(() => addModel(db, { modelId: 'claude-sonnet-5', vendor: 'anthropic' }), /already a model/)
  assert.throws(() => addModel(db, { modelId: 'big-pickle', vendor: 'x' }), /already an alias/)
  assert.throws(() => addModel(db, { modelId: '  ', vendor: 'x' }), /model/)
  assert.throws(() => addModel(db, { modelId: 'gpt-9-test', vendor: ' ' }), /vendor/)
  db.close()
})

test('addAlias maps a new spelling onto a known model and normalizes the alias', () => {
  const db = seeded()
  assert.equal(resolveModel(db, 'claude-sonnet-5-spelling'), null)
  assert.equal(addAlias(db, { alias: 'Anthropic/Claude-Sonnet-5-Spelling', modelId: 'claude-sonnet-5', sourceNote: 't' }), 'claude-sonnet-5-spelling')
  assert.equal(resolveModel(db, 'claude-sonnet-5-spelling'), 'claude-sonnet-5')
  db.close()
})

test('addAlias refuses an unknown target, a duplicate alias, a name that is already a model, and a blank alias', () => {
  const db = seeded()
  assert.throws(() => addAlias(db, { alias: 'new-name', modelId: 'no-such-model', sourceNote: '' }), /unknown model/)
  assert.throws(() => addAlias(db, { alias: 'big-pickle', modelId: 'claude-sonnet-5', sourceNote: '' }), /already an alias/)
  assert.throws(() => addAlias(db, { alias: 'claude-sonnet-5', modelId: 'claude-sonnet-5', sourceNote: '' }), /already a model/)
  assert.throws(() => addAlias(db, { alias: ' ', modelId: 'claude-sonnet-5', sourceNote: '' }), /alias/)
  db.close()
})

test('suspect, no_usage and all-null token rows are never priced and never missing_alias', () => {
  const db = seeded()
  assert.equal(priceOne(db, { source_message_id: 's', model_raw: 'mystery-model-9', suspect: 1 }).status, 'suspect')
  assert.equal(priceOne(db, { source_message_id: 'n', model_raw: 'mystery-model-9', usage_status: 'no_usage', input_tokens: null, output_tokens: null }).status, 'no_usage')
  const nul = priceOne(db, { source_message_id: 'z', model_raw: 'claude-sonnet-5', input_tokens: null, output_tokens: null })
  assert.deepEqual(nul, { status: 'no_usage', cost: null, modelId: null })
  db.close()
})

test('opencode free models cost zero and are priced', () => {
  const db = seeded()
  const r = priceOne(db, { tool: 'opencode', model_raw: 'big-pickle', ...zero, input_tokens: 5000, output_tokens: 500 })
  assert.equal(r.status, 'priced')
  near(r.cost, 0)
  db.close()
})

const costRows = (db: LedgerDb): number => (db.raw.prepare('SELECT COUNT(*) c FROM message_costs').get() as { c: number }).c

test('a first run prices every message; counts cover all statuses for every run, changed or not', () => {
  const db = seeded()
  insertTestMessage(db, { source_message_id: 'a' })
  insertTestMessage(db, { source_message_id: 'b', model_raw: 'mystery-model-9' })
  const r1 = runPricing(db, FIXED_NOW, 'first')
  assert.deepEqual(r1.counts, { priced: 1, missing_price: 0, missing_alias: 1, suspect: 0, no_usage: 0 })
  assert.equal(r1.changed, 2)
  assert.equal(costRows(db), 2)
  const r2 = runPricing(db, FIXED_NOW, 'second')
  assert.notEqual(r1.runId, r2.runId)
  assert.deepEqual(r2.counts, r1.counts)
  db.close()
})

test('a re-run with nothing new writes no cost rows, but the run itself is recorded', () => {
  const db = seeded()
  insertTestMessage(db, { source_message_id: 'a' })
  insertTestMessage(db, { source_message_id: 'b', model_raw: 'mystery-model-9' })
  runPricing(db, FIXED_NOW, 'first')
  const r2 = runPricing(db, FIXED_NOW, 'second')
  assert.equal(r2.changed, 0)
  assert.equal(costRows(db), 2)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM pricing_runs').get() as { c: number }).c, 2)
  db.close()
})

test('only messages whose result changed get a new row: a new message, and a newly priced model', () => {
  const db = seeded()
  insertTestMessage(db, { source_message_id: 'a' })
  const stuck = insertTestMessage(db, { source_message_id: 'b', model_raw: 'mystery-model-9' })
  runPricing(db, FIXED_NOW, 'first')
  const fresh = insertTestMessage(db, { source_message_id: 'c' })
  addAlias(db, { alias: 'mystery-model-9', modelId: 'claude-sonnet-5', sourceNote: 't' })
  const r2 = runPricing(db, FIXED_NOW, 'second')
  assert.equal(r2.changed, 2)
  assert.equal(costRows(db), 4)
  const rowsOf = (id: number) => db.raw.prepare('SELECT run_id r, pricing_status s FROM message_costs WHERE message_id = ? ORDER BY run_id').all(id) as Array<{ r: number; s: string }>
  assert.deepEqual(rowsOf(stuck).map(x => x.s), ['missing_alias', 'priced'])
  assert.deepEqual(rowsOf(fresh).map(x => x.r), [r2.runId])
  db.close()
})

test('a price change writes rows only for the messages it affects; the rest keep their earlier row', () => {
  const db = seeded()
  const early = insertTestMessage(db, { source_message_id: 'early', ...zero, input_tokens: 1_000_000, ts_utc: '2026-09-30T11:00:00.000Z' })
  const late = insertTestMessage(db, { source_message_id: 'late', ...zero, input_tokens: 1_000_000, ts_utc: '2026-09-30T13:00:00.000Z' })
  runPricing(db, FIXED_NOW, 'first')
  addPrice(db, { modelId: 'claude-sonnet-5', tokenClass: 'input', minPromptTokens: 0, usdPerMillion: 3, effectiveFrom: '2026-09-30T12:00:00.000Z', sourceNote: 'change' }, FIXED_NOW)
  const r2 = runPricing(db, FIXED_NOW, 'second')
  assert.equal(r2.changed, 1)
  const count = (id: number) => (db.raw.prepare('SELECT COUNT(*) c FROM message_costs WHERE message_id = ?').get(id) as { c: number }).c
  assert.equal(count(early), 1)
  assert.equal(count(late), 2)
  db.close()
})

test('the same cost from different price rows counts as a change, so the trace to the price rows stays current', () => {
  const db = seeded()
  const id = insertTestMessage(db, { source_message_id: 'a', ...zero, input_tokens: 1_000_000, ts_utc: '2026-09-30T13:00:00.000Z' })
  runPricing(db, FIXED_NOW, 'first')
  addPrice(db, { modelId: 'claude-sonnet-5', tokenClass: 'input', minPromptTokens: 0, usdPerMillion: 2, effectiveFrom: '2026-09-30T12:00:00.000Z', sourceNote: 'same rate, new row' }, FIXED_NOW)
  const r2 = runPricing(db, FIXED_NOW, 'second')
  assert.equal(r2.changed, 1)
  const rows = db.raw.prepare('SELECT computed_cost_usd c, price_ids p FROM message_costs WHERE message_id = ? ORDER BY run_id').all(id) as Array<{ c: number; p: string }>
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.c, rows[1]?.c)
  assert.notEqual(rows[0]?.p, rows[1]?.p)
  db.close()
})

test('a message that goes back to an earlier answer still gets a new row (compared with its latest row, not any row)', () => {
  const db = seeded()
  const id = insertTestMessage(db, { source_message_id: 'a', model_raw: 'flip-model' })
  runPricing(db, FIXED_NOW, 'unmapped')
  addAlias(db, { alias: 'flip-model', modelId: 'claude-sonnet-5', sourceNote: 't' })
  runPricing(db, FIXED_NOW, 'mapped')
  db.raw.prepare("DELETE FROM model_aliases WHERE alias = 'flip-model'").run()
  const r3 = runPricing(db, FIXED_NOW, 'unmapped again')
  assert.equal(r3.changed, 1)
  const rows = db.raw.prepare('SELECT pricing_status s FROM message_costs WHERE message_id = ? ORDER BY run_id').all(id) as Array<{ s: string }>
  assert.deepEqual(rows.map(x => x.s), ['missing_alias', 'priced', 'missing_alias'])
  db.close()
})

test('more than one chunk of messages is priced (chunking has no off-by-one)', () => {
  const db = seeded()
  db.transaction(() => { for (let i = 0; i < 5003; i++) insertTestMessage(db, { source_message_id: `m${i}` }) })
  const r = runPricing(db, FIXED_NOW)
  assert.equal(r.counts.priced, 5003)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM message_costs WHERE run_id = ?').get(r.runId) as { c: number }).c, 5003)
  db.close()
})

test('a priced row records the ids of the price rows it used; unpriced rows record none', () => {
  const db = seeded()
  const id = insertTestMessage(db, { source_message_id: 'p', model_raw: 'claude-sonnet-5', ...zero, input_tokens: 1000, output_tokens: 10 })
  const bad = insertTestMessage(db, { source_message_id: 'q', model_raw: 'mystery-model-9' })
  const r = runPricing(db, FIXED_NOW)
  const get = (mid: number) => db.raw.prepare('SELECT price_ids p FROM message_costs WHERE run_id = ? AND message_id = ?').get(r.runId, mid) as { p: string | null }
  const want = db.raw.prepare("SELECT id FROM prices WHERE model_id = 'claude-sonnet-5' AND token_class IN ('input','output') ORDER BY id").all() as Array<{ id: number }>
  assert.equal(get(id).p, JSON.stringify(want.map(w => w.id)))
  assert.equal(get(bad).p, null)
  db.close()
})

test('a seeded model with a dated rate change prices before and after the change date', () => {
  const db = seeded()
  const before = priceOne(db, { ...zero, source_message_id: 'dated-before', ts_utc: '2026-10-08T02:44:59.000Z', model_raw: 'claude-sonnet-5-5', cache_read_tokens: 1_000_000 })
  const after = priceOne(db, { ...zero, source_message_id: 'dated-after', ts_utc: '2026-10-08T02:45:00.000Z', model_raw: 'claude-sonnet-5-5', cache_read_tokens: 1_000_000 })
  near(before.cost, 0.2)
  near(after.cost, 0.1)
  db.close()
})
