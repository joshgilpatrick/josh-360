import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePiFile } from '../../src/costledger/parse-pi.ts'
import { tempDir } from '../helpers/tmp.ts'

const header = (cwd: string, id = 'sess-p') => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-09-30T13:20:30.842Z', cwd })
const msg = (id: string, usage: object, over: object = {}, mover: object = {}) => JSON.stringify({
  type: 'message', id, parentId: null, timestamp: '2026-09-30T13:21:37.840Z',
  message: { role: 'assistant', api: 'openai-responses', provider: 'bifrost-pi', model: 'azure/gpt-6-luna', usage, ...mover }, ...over,
})
const usage = (over: object = {}) => ({ input: 3, output: 269, reasoning: 88, cacheRead: 23282, cacheWrite: 1903, totalTokens: 25457, cost: { total: 0.01 }, ...over })
function file(lines: string[]): string {
  const p = join(tempDir('pi-'), 's.jsonl')
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

test('maps usage, cwd from header, ids, provider and model', () => {
  const [m] = parsePiFile(file([header('/r/app'), msg('m1', usage())]))
  assert.ok(m)
  assert.equal(m.tool, 'pi')
  assert.equal(m.sourceMessageId, 'm1')
  assert.equal(m.sourceSessionId, 'sess-p')
  assert.equal(m.modelRaw, 'azure/gpt-6-luna')
  assert.equal(m.providerRaw, 'bifrost-pi')
  assert.equal(m.inputTokens, 3)
  assert.equal(m.outputTokens, 269)
  assert.equal(m.reasoningTokens, 88)
  assert.equal(m.cacheReadTokens, 23282)
  assert.equal(m.cacheWriteUnclassifiedTokens, 1903)
  assert.equal(m.loggedCostUsd, 0.01)
  assert.equal(m.cwd, '/r/app')
  assert.equal(m.gitBranch, null)
  assert.equal(m.isSidechain, false)
  assert.equal(m.tsUtc, '2026-09-30T13:21:37.840Z')
  assert.equal(m.sourceLocator, 'line:2')
})

test('failed request with zero total tokens is skipped', () => {
  const ms = parsePiFile(file([header('/r/app'), msg('e1', usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), {}, { stopReason: 'error' }), msg('z1', usage({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: undefined })), msg('z2', usage({ input: undefined, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: undefined })), msg('p1', usage({ input: 0, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: undefined })), msg('p2', usage({ input: 4, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: undefined })), msg('p3', usage({ input: 0, output: 0, reasoning: 6, cacheRead: 0, cacheWrite: 0, totalTokens: undefined })), msg('p4', usage({ input: 0, output: 0, reasoning: 0, cacheRead: 7, cacheWrite: 0, totalTokens: undefined })), msg('p5', usage({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 8, totalTokens: undefined })), msg('p6', usage({ input: undefined, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: undefined })), msg('ok', usage())]))
  assert.deepEqual(ms.map(m => m.sourceMessageId), ['z1', 'z2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'ok'])
  assert.deepEqual(ms.map(m => m.usageStatus), ['no_usage', 'no_usage', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
  assert.equal(ms[2]?.outputTokens, 5)
  assert.equal(ms[2]?.inputTokens, 0)
  assert.equal(ms[0]?.usageStatus, 'no_usage')
  assert.equal(ms[0]?.inputTokens, null)
  assert.equal(ms[0]?.cacheReadTokens, null)
  assert.equal(ms[8]?.usageStatus, 'ok')
})

test('non-assistant lines, missing model and bad timestamps are skipped; junk lines tolerated', () => {
  const lines = [
    header('/r/app'), '{not json', JSON.stringify({ type: 'model_change', id: 'x' }),
    msg('u', usage(), {}, { role: 'user' }), msg('nomodel', usage(), {}, { model: undefined }), msg('badts', usage(), { timestamp: 'zzz' }), msg('good', usage()),
  ]
  assert.deepEqual(parsePiFile(file(lines)).map(m => m.sourceMessageId), ['good'])
})

test('a later session header replaces cwd and session id', () => {
  const ms = parsePiFile(file([header('/a', 's-a'), msg('m1', usage()), header('/b', 's-b'), msg('m2', usage())]))
  assert.deepEqual(ms.map(m => [m.cwd, m.sourceSessionId]), [['/a', 's-a'], ['/b', 's-b']])
})

test('missing cost leaves loggedCostUsd null', () => {
  const [m] = parsePiFile(file([header('/r/app'), msg('m1', usage({ cost: undefined }))]))
  assert.equal(m?.loggedCostUsd, null)
})
