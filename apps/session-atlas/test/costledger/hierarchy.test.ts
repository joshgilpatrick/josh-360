import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openTestLedger } from '../helpers/costledger.ts'
import { tempDir } from '../helpers/tmp.ts'
import { rebuildSharedHistoryLinks, recordSpawns, resolveClaudeParent, syncClaudeHierarchy, syncOpenCodeHierarchy } from '../../src/costledger/hierarchy.ts'

const plain = (r: object): object => ({ ...r }) // node:sqlite rows have a null prototype

test('toolUseId owner wins, parentAgentId falls back, conflicts remain visible', () => {
  const owners=new Map([['spawn-b','a'],['spawn-c','b']])
  const present=new Set(['a','b','c'])
  assert.deepEqual(resolveClaudeParent('b','spawn-b','a',owners,present),{agentId:'a',quality:'exact'})
  assert.deepEqual(resolveClaudeParent('c','spawn-c','a',owners,present),{agentId:'',quality:'conflict'})
  assert.deepEqual(resolveClaudeParent('c',null,'b',owners,present),{agentId:'b',quality:'derived'})
  assert.deepEqual(resolveClaudeParent('c',null,null,owners,present),{agentId:'',quality:'unresolved'})
})

test('an owner that is not a present agent is never used as a parent', () => {
  const owners = new Map([['t1', 'ghost']])
  assert.deepEqual(resolveClaudeParent('b', 't1', null, owners, new Set(['b'])), { agentId: '', quality: 'unresolved' })
  assert.deepEqual(resolveClaudeParent('b', 't1', 'a', owners, new Set(['a', 'b'])), { agentId: 'a', quality: 'derived' })
})

test('a main-session owner (empty string) is a real owner, not a missing one', () => {
  const owners = new Map([['t1', '']])
  assert.deepEqual(resolveClaudeParent('a', 't1', null, owners, new Set(['a'])), { agentId: '', quality: 'exact' })
})

test('two holders produce one undirected link without copying any price', () => {
  const db=openTestLedger()
  const m=Number(db.raw.prepare("INSERT INTO messages(tool,source_message_id,source_session_id,ts_utc,model_raw,attribution_quality,usage_status,source_path,source_locator) VALUES('claude-code','c','a','2026-10-01T00:00:00.000Z','x','exact','ok','/a','line:1')").run().lastInsertRowid)
  db.raw.prepare('INSERT INTO message_holders(message_id,source_session_id) VALUES (?,?),(?,?)').run(m,'a',m,'b')
  rebuildSharedHistoryLinks(db)
  assert.deepEqual(db.raw.prepare("SELECT session_a a,session_b b,shared_calls n FROM session_links WHERE kind='shared_history'").all().map(plain),[{a:'a',b:'b',n:1}])
  db.close()
})

test('recordSpawns is idempotent and a re-scan replaces that path owners', () => {
  const db = openTestLedger()
  recordSpawns(db, '/p', [{ sessionId: 's', ownerAgentId: '', toolUseId: 't1' }, { sessionId: 's', ownerAgentId: '', toolUseId: 't1' }])
  recordSpawns(db, '/p', [{ sessionId: 's', ownerAgentId: '', toolUseId: 't1' }])
  recordSpawns(db, '/other', [{ sessionId: 's', ownerAgentId: 'x', toolUseId: 't9' }])
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM claude_spawn_owners').get() as { c: number }).c, 2)
  recordSpawns(db, '/p', [{ sessionId: 's', ownerAgentId: 'a', toolUseId: 't2' }])
  assert.deepEqual(db.raw.prepare("SELECT tool_use_id t FROM claude_spawn_owners WHERE source_path='/p'").all().map(plain), [{ t: 't2' }])
  db.close()
})

function agentFiles(root: string, session: string, metas: Record<string, object | null>): void {
  const dir = join(root, 'project', session, 'subagents')
  mkdirSync(dir, { recursive: true })
  for (const [agent, meta] of Object.entries(metas)) {
    writeFileSync(join(dir, `agent-${agent}.jsonl`), '')
    if (meta !== null) writeFileSync(join(dir, `agent-${agent}.meta.json`), JSON.stringify({ description: 'secret prompt', ...meta }))
  }
}
const nodes = (db: ReturnType<typeof openTestLedger>) => db.raw.prepare(
  "SELECT source_agent_id a, parent_agent_id p, link_quality q FROM session_nodes WHERE tool='claude-code' AND source_session_id='s' AND source_agent_id<>'' ORDER BY a").all().map(plain)

test('orphan meta, conflict and cycle stay visible and the tree stays finite', () => {
  const root = tempDir('hier-')
  agentFiles(root, 's', {
    orphan: { toolUseId: 'nobody-owns-this' },
    x: { toolUseId: 'tx' }, y: { toolUseId: 'ty', parentAgentId: 'z' }, z: {},
    c1: { parentAgentId: 'c2' }, c2: { parentAgentId: 'c1' },
  })
  const db = openTestLedger()
  recordSpawns(db, '/main', [{ sessionId: 's', ownerAgentId: '', toolUseId: 'tx' }, { sessionId: 's', ownerAgentId: 'x', toolUseId: 'ty' }])
  syncClaudeHierarchy(db, join(root, 'project'))
  const byAgent = Object.fromEntries((nodes(db) as Array<{ a: string; p: string; q: string }>).map(r => [r.a, r]))
  assert.deepEqual(byAgent.orphan, { a: 'orphan', p: '', q: 'unresolved' })
  assert.deepEqual(byAgent.x, { a: 'x', p: '', q: 'exact' })
  assert.equal(byAgent.y?.q, 'conflict')
  assert.equal(byAgent.z?.q, 'unresolved')
  assert.deepEqual([byAgent.c1?.q, byAgent.c2?.q].sort(), ['conflict', 'derived'])
  for (const a of Object.keys(byAgent)) {
    let cur = a
    for (let i = 0; i < 10 && cur !== ''; i++) cur = byAgent[cur]?.p ?? ''
    assert.equal(cur, '', `${a} reaches the root`)
  }
  assert.equal(JSON.stringify(db.raw.prepare('SELECT * FROM session_nodes').all()).includes('secret prompt'), false)
  db.close()
})

test('deleting only the meta files keeps resolved edges and their quality; a changed meta replaces them', () => {
  const root = tempDir('hier-')
  agentFiles(root, 's', { a: { toolUseId: 't1' }, b: { parentAgentId: 'a' } })
  const db = openTestLedger()
  recordSpawns(db, '/main', [{ sessionId: 's', ownerAgentId: '', toolUseId: 't1' }])
  syncClaudeHierarchy(db, join(root, 'project'))
  const resolved = [{ a: 'a', p: '', q: 'exact' }, { a: 'b', p: 'a', q: 'derived' }]
  assert.deepEqual(nodes(db), resolved)
  const sub = join(root, 'project', 's', 'subagents')
  for (const agent of ['a', 'b']) rmSync(join(sub, `agent-${agent}.meta.json`))
  syncClaudeHierarchy(db, join(root, 'project'))
  assert.deepEqual(nodes(db), resolved)
  agentFiles(root, 's', { b: { toolUseId: 't1' } })
  syncClaudeHierarchy(db, join(root, 'project'))
  assert.deepEqual(nodes(db), [{ a: 'a', p: '', q: 'exact' }, { a: 'b', p: '', q: 'exact' }])
  db.close()
})

test('isFork in a subagent meta is still a child agent, not a cross-session fork', () => {
  const root = tempDir('hier-')
  agentFiles(root, 's', { a: { toolUseId: 't1', isFork: true } })
  const db = openTestLedger()
  recordSpawns(db, '/main', [{ sessionId: 's', ownerAgentId: '', toolUseId: 't1' }])
  syncClaudeHierarchy(db, join(root, 'project'))
  assert.deepEqual(db.raw.prepare("SELECT kind k, parent_session_id ps, parent_agent_id pa, link_quality q FROM session_nodes WHERE tool='claude-code' AND source_agent_id='a'").all().map(plain), [{ k: 'subagent', ps: 's', pa: '', q: 'exact' }])
  assert.equal(db.raw.prepare("SELECT 1 FROM session_links WHERE kind='fork'").all().length, 0)
  db.close()
})

function openCodeDb(rows: Array<[string, string | null, string | null]>): string {
  const path = join(tempDir('hier-oc-'), 'oc.db')
  const oc = new DatabaseSync(path)
  oc.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, fork_session_id TEXT)')
  for (const [id, parent, fork] of rows) oc.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)').run(id, '/d', parent, fork)
  oc.close()
  return path
}

test('OpenCode root/child/grandchild, forks, and parent_id precedence', () => {
  const path = openCodeDb([['root', null, null], ['child', 'root', null], ['grand', 'child', null], ['fk', null, 'root'], ['both', 'child', 'root']])
  const db = openTestLedger()
  syncOpenCodeHierarchy(db, path)
  syncOpenCodeHierarchy(db, path) // re-sync: fork parent and link must survive
  const rows = db.raw.prepare("SELECT source_session_id s, parent_session_id p, kind k, link_quality q FROM session_nodes WHERE tool='opencode' ORDER BY s").all().map(plain)
  assert.deepEqual(rows, [
    { s: 'both', p: 'child', k: 'subagent', q: 'exact' },
    { s: 'child', p: 'root', k: 'subagent', q: 'exact' },
    { s: 'fk', p: 'root', k: 'fork', q: 'exact' },
    { s: 'grand', p: 'child', k: 'subagent', q: 'exact' },
    { s: 'root', p: null, k: 'main', q: 'exact' },
  ])
  assert.deepEqual(db.raw.prepare("SELECT session_a a, session_b b FROM session_links WHERE tool='opencode' AND kind='fork' ORDER BY a").all().map(plain), [{ a: 'both', b: 'root' }, { a: 'fk', b: 'root' }])
  db.close()
})

test('OpenCode cycle and unknown parent are flagged, not followed', () => {
  const path = openCodeDb([['a', 'b', null], ['b', 'a', null], ['c', 'ghost', null]])
  const db = openTestLedger()
  syncOpenCodeHierarchy(db, path)
  const q = Object.fromEntries((db.raw.prepare("SELECT source_session_id s, link_quality q, parent_session_id p FROM session_nodes WHERE tool='opencode'").all() as Array<{ s: string; q: string; p: string | null }>).map(r => [r.s, r]))
  assert.equal(q.c?.q, 'unresolved')
  assert.equal(q.c?.p, null)
  assert.deepEqual([q.a?.q, q.b?.q].sort(), ['conflict', 'exact'])
  db.close()
})
