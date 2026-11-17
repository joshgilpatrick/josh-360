import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseClaudeFile } from '../../src/costledger/parse-claude.ts'
import type { ParsedMessage } from '../../src/costledger/types.ts'
import { tempDir } from '../helpers/tmp.ts'

type Over = Record<string, unknown>
function line(id: string, over: Over = {}, usage: Over = {}, msg: Over = {}): string {
  return JSON.stringify({
    type: 'assistant', isSidechain: false, sessionId: 'sess-1', cwd: '/r/app', gitBranch: 'feat/x',
    timestamp: '2026-09-30T12:00:00.000Z',
    message: {
      id, role: 'assistant', model: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 }, ...usage },
      ...msg,
    },
    ...over,
  })
}
async function collect(path: string): Promise<ParsedMessage[]> {
  const out: ParsedMessage[] = []
  for await (const m of parseClaudeFile(path)) out.push(m)
  return out
}
function file(lines: string[], rel = 'main.jsonl', trailer = '\n'): string {
  const dir = tempDir('cl-parse-')
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, lines.join('\n') + trailer)
  return p
}

test('maps tokens, cache split, ids and locator', async () => {
  const [m] = await collect(file([line('msg_a')]))
  assert.ok(m)
  assert.equal(m.tool, 'claude-code')
  assert.equal(m.sourceMessageId, 'msg_a')
  assert.equal(m.sourceSessionId, 'sess-1')
  assert.equal(m.tsUtc, '2026-09-30T12:00:00.000Z')
  assert.equal(m.modelRaw, 'claude-sonnet-5')
  assert.equal(m.inputTokens, 10)
  assert.equal(m.outputTokens, 5)
  assert.equal(m.cacheReadTokens, 100)
  assert.equal(m.cacheWrite5mTokens, 30)
  assert.equal(m.cacheWrite1hTokens, 10)
  assert.equal(m.cacheWriteUnclassifiedTokens, 0)
  assert.equal(m.sourceLocator, 'line:1')
  assert.equal(m.cwd, '/r/app')
  assert.equal(m.gitBranch, 'feat/x')
  assert.equal(m.isSidechain, false)
  assert.equal(m.usageStatus, 'ok')
  assert.equal(m.providerRaw, null)
  assert.equal(m.loggedCostUsd, null)
  assert.equal(m.sourcePath.endsWith('main.jsonl'), true)
  const [z] = await collect(file([line('msg_z', { timestamp: '2026-09-30T08:00:00-04:00' })]))
  assert.equal(z?.tsUtc, '2026-09-30T12:00:00.000Z')
  assert.equal(m.reasoningTokens, null)
})

test('streamed duplicates are all yielded (store dedups), requestId not required', async () => {
  const ms = await collect(file([line('msg_a', {}, { output_tokens: 1 }), line('msg_a', {}, { output_tokens: 9 })]))
  assert.equal(ms.length, 2)
  assert.deepEqual(ms.map(m => m.outputTokens), [1, 9])
  assert.deepEqual(ms.map(m => m.sourceLocator), ['line:1', 'line:2'])
})

test('no cache_creation object: split is null and the total is unclassified', async () => {
  const [m] = await collect(file([line('msg_a', {}, { cache_creation: undefined })]))
  assert.ok(m)
  assert.equal(m.cacheWrite5mTokens, null)
  assert.equal(m.cacheWrite1hTokens, null)
  assert.equal(m.cacheWriteUnclassifiedTokens, 40)
})

test('cache split smaller than total leaves a remainder as unclassified', async () => {
  const [m] = await collect(file([line('msg_a', {}, { cache_creation_input_tokens: 50 })]))
  assert.ok(m)
  assert.equal(m.cacheWriteUnclassifiedTokens, 10)
  const [c] = await collect(file([line('msg_b', {}, { cache_creation_input_tokens: 20, output_tokens_details: { thinking_tokens: 7 } })]))
  assert.ok(c)
  assert.equal(c.cacheWriteUnclassifiedTokens, 0)
  assert.equal(c.reasoningTokens, 7)
  const [neg] = await collect(file([line('msg_c', {}, { input_tokens: -5 })]))
  assert.ok(neg)
  assert.equal(neg.inputTokens, null)
})

test('synthetic model, missing usage, missing id and bad timestamp are skipped', async () => {
  const lines = [
    line('s1', {}, {}, { model: '<synthetic>' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-30T12:00:00.000Z', message: { id: 'n1', role: 'assistant', model: 'claude-sonnet-5' } }),
    line('x', {}, {}, { id: undefined }),
    line('t1', { timestamp: 'not-a-date' }),
    line('u1', {}, {}, { role: 'user' }),
    line('m1', {}, {}, { model: undefined }),
    line('m2', {}, {}, { model: 42 }),
    line('n2', {}, {}, { usage: null }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    line('ok'),
  ]
  const ms = await collect(file(lines))
  assert.deepEqual(ms.map(m => m.sourceMessageId), ['ok'])
  assert.deepEqual(ms.map(m => m.sourceLocator), ['line:10'])
})

test('unparseable middle line and partial trailing line are skipped without error', async () => {
  const p = file([line('a'), '{"usage": broken', line('b'), '{"type":"assistant","message":{"id":"c","usage"'], 'main.jsonl', '')
  const ms = await collect(p)
  assert.deepEqual(ms.map(m => m.sourceMessageId), ['a', 'b'])
  assert.deepEqual(ms.map(m => m.sourceLocator), ['line:1', 'line:3'])
})

test('sidechain from the flag and from a subagents path', async () => {
  const [a] = await collect(file([line('a', { isSidechain: true })]))
  const [b] = await collect(file([line('b')], 'sess/subagents/agent-1.jsonl'))
  const [c] = await collect(file([line('c')]))
  assert.equal(a?.isSidechain, true)
  assert.equal(b?.isSidechain, true)
  assert.equal(c?.isSidechain, false)
})

test('branch: empty, missing and HEAD become null', async () => {
  const ms = await collect(file([line('a', { gitBranch: '' }), line('b', { gitBranch: 'HEAD' }), line('c', { gitBranch: undefined }), line('d', { gitBranch: 'main' })]))
  assert.deepEqual(ms.map(m => m.gitBranch), [null, null, null, 'main'])
})

test('mid-session cwd and branch change stays on each message', async () => {
  const ms = await collect(file([line('a', { cwd: '/r/app', gitBranch: 'main' }), line('b', { cwd: '/r/app/.claude/worktrees/w1', gitBranch: 'feat/w1' })]))
  assert.deepEqual(ms.map(m => [m.cwd, m.gitBranch]), [['/r/app', 'main'], ['/r/app/.claude/worktrees/w1', 'feat/w1']])
})

test('advisor_message iterations become extra messages with their own model', async () => {
  const iterations = [
    { type: 'message', input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: 'message', model: 'claude-haiku-5', input_tokens: 9, output_tokens: 9 },
    { type: 'advisor_message', input_tokens: 7, output_tokens: 7 },
    null,
    { type: 'advisor_message', model: 'claude-opus-5', input_tokens: 400, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } },
  ]
  const ms = await collect(file([line('msg_a', {}, { iterations })]))
  assert.equal(ms.length, 2)
  const adv = ms.find(m => m.sourceMessageId === 'msg_a#adv4')
  assert.ok(adv)
  assert.equal(adv.modelRaw, 'claude-opus-5')
  assert.equal(adv.inputTokens, 400)
  assert.equal(adv.outputTokens, 60)
  assert.equal(adv.cacheWrite5mTokens, 200)
  assert.equal(adv.sourceLocator, 'line:1')
})

test('empty file yields nothing', async () => {
  assert.deepEqual(await collect(file([], 'e.jsonl', '')), [])
})

test('child basename and advisor inherit agent node; synthetic Agent tool call emits only IDs', async () => {
  const spawns: Array<{sessionId:string;ownerAgentId:string;toolUseId:string}>=[]
  const path=file([
    JSON.stringify({type:'assistant',sessionId:'sess',message:{role:'assistant',model:'<synthetic>',content:[{type:'tool_use',name:'Agent',id:'call-1',input:{secret:'never stored'}}]}}),
    line('m',{sessionId:'sess',agentId:'row-id'},{iterations:[{type:'advisor_message',model:'claude-opus-5',input_tokens:3,output_tokens:2}]})
  ],'sess/subagents/agent-file-id.jsonl')
  const msgs:ParsedMessage[]=[]
  for await (const m of parseClaudeFile(path,s=>spawns.push(s))) msgs.push(m)
  assert.deepEqual(msgs.map(m=>m.sourceAgentId),['file-id','file-id'])
  assert.deepEqual(spawns,[{sessionId:'sess',ownerAgentId:'file-id',toolUseId:'call-1'}])
  assert.equal(JSON.stringify(spawns).includes('never stored'),false)
})
test('main-session Agent tool_use emits a spawn owned by the empty agent; other tools ignored', async () => {
  const spawns: Array<{sessionId:string;ownerAgentId:string;toolUseId:string}>=[]
  const tu=(name:string,id:string)=>JSON.stringify({type:'assistant',sessionId:'sess',message:{role:'assistant',content:[{type:'tool_use',name,id,input:{}}]}})
  const path=file([tu('Agent','call-main'),tu('Bash','call-bash')],'main.jsonl')
  for await (const _ of parseClaudeFile(path,s=>spawns.push(s))) { /* drain */ }
  assert.deepEqual(spawns,[{sessionId:'sess',ownerAgentId:'',toolUseId:'call-main'}])
})
test('mixed-ID child file does not assign the other session to the folder child', async () => {
  const ms=await collect(file([line('other',{sessionId:'other-session'})],'sess/subagents/agent-child.jsonl'))
  assert.equal(ms[0]?.sourceSessionId,'other-session')
  assert.equal(ms[0]?.sourceAgentId,null)
})
