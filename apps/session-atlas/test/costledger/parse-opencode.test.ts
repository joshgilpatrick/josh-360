import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readOpenCode, readOpenCodeSessions } from '../../src/costledger/parse-opencode.ts'
import { OPENCODE_COST_CUTOFF_MS } from '../../src/costledger/constants.ts'
import { tempDir } from '../helpers/tmp.ts'

const AFTER = OPENCODE_COST_CUTOFF_MS + 60_000
const NOW = OPENCODE_COST_CUTOFF_MS + 10 * 86_400_000

function makeDb(opts: { v2?: boolean; legacy?: boolean } = { v2: true, legacy: true }): { path: string; db: DatabaseSync } {
  const path = join(tempDir('oc-'), 'opencode.db')
  const db = new DatabaseSync(path)
  if (opts.v2) {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT)')
    db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  }
  if (opts.legacy) {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  }
  return { path, db }
}
let seq = 0
function v2(db: DatabaseSync, id: string, session: string, data: object, type = 'assistant', created = AFTER): void {
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(id, session, type, ++seq, created, created, JSON.stringify(data))
}
function legacy(db: DatabaseSync, id: string, session: string, data: object, created = AFTER): void {
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, session, created, created, JSON.stringify(data))
}
const v2Data = (over: object = {}) => ({
  time: { created: AFTER }, model: { id: 'azure/gpt-6-luna', providerID: 'bifrost-responses' },
  tokens: { input: 3, output: 49, reasoning: 11, cache: { read: 44522, write: 85 } }, cost: 0.00097, ...over,
})
const legacyData = (over: object = {}) => ({
  role: 'assistant', time: { created: AFTER }, modelID: 'anthropic/claude-sonnet-5', providerID: 'bifrost', path: { cwd: '/r/app' },
  tokens: { input: 5, output: 7, reasoning: 0, cache: { read: 10, write: 2 } }, cost: 0.5, ...over,
})

test('v2 row maps tokens (output includes reasoning), cwd and parent from session_v2', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session_v2 VALUES ('s1','/r/app','p1')").run()
  v2(db, 'm1', 's1', v2Data())
  db.close()
  const [m] = readOpenCode(path, NOW)
  assert.ok(m)
  assert.equal(m.tool, 'opencode')
  assert.equal(m.sourceMessageId, 'm1')
  assert.equal(m.sourceSessionId, 's1')
  assert.equal(m.modelRaw, 'azure/gpt-6-luna')
  assert.equal(m.providerRaw, 'bifrost-responses')
  assert.equal(m.inputTokens, 3)
  assert.equal(m.outputTokens, 60)
  assert.equal(m.reasoningTokens, 11)
  assert.equal(m.cacheReadTokens, 44522)
  assert.equal(m.cacheWriteUnclassifiedTokens, 85)
  assert.equal(m.cacheWrite5mTokens, null)
  assert.equal(m.loggedCostUsd, 0.00097)
  assert.equal(m.cwd, '/r/app')
  assert.equal(m.isSidechain, true)
  assert.equal(m.gitBranch, null)
  assert.equal(m.tsUtc, new Date(AFTER).toISOString())
  assert.equal(m.sourceLocator, 'row:m1')
  assert.equal(m.usageStatus, 'ok')
})

test('legacy row uses path.cwd and session parent', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session VALUES ('s2','/other',NULL)").run()
  legacy(db, 'L1', 's2', legacyData())
  db.close()
  const [m] = readOpenCode(path, NOW)
  assert.ok(m)
  assert.equal(m.cwd, '/r/app')
  assert.equal(m.isSidechain, false)
  assert.equal(m.modelRaw, 'anthropic/claude-sonnet-5')
})

test('same id in both tables is returned once and session_message wins', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session_v2 VALUES ('s1','/v2dir',NULL)").run()
  db.prepare("INSERT INTO session VALUES ('s1','/legacydir',NULL)").run()
  v2(db, 'dup', 's1', v2Data({ tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  legacy(db, 'dup', 's1', legacyData({ tokens: { input: 99, output: 99, reasoning: 0, cache: { read: 0, write: 0 } } }))
  legacy(db, 'only-legacy', 's1', legacyData())
  db.close()
  const ms = readOpenCode(path, NOW)
  assert.equal(ms.length, 2)
  assert.equal(ms.find(m => m.sourceMessageId === 'dup')?.inputTokens, 1)
})

test('rows before the cost cutoff and non-assistant rows are dropped', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session_v2 VALUES ('s1','/r/app',NULL)").run()
  v2(db, 'old', 's1', v2Data({ time: { created: OPENCODE_COST_CUTOFF_MS - 1 } }), 'assistant', OPENCODE_COST_CUTOFF_MS - 1)
  v2(db, 'user', 's1', v2Data(), 'user')
  v2(db, 'new', 's1', v2Data())
  legacy(db, 'oldl', 's1', legacyData({ time: { created: OPENCODE_COST_CUTOFF_MS - 5 } }), OPENCODE_COST_CUTOFF_MS - 5)
  legacy(db, 'userl', 's1', legacyData({ role: 'user' }))
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('badl', 's1', AFTER, AFTER, '{not json')
  legacy(db, 'goodl', 's1', legacyData())
  db.close()
  assert.deepEqual(readOpenCode(path, NOW).map(m => m.sourceMessageId), ['new', 'goodl'])
})

test('row without tokens is no_usage with null tokens, never zero', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session_v2 VALUES ('s1','/r/app',NULL)").run()
  v2(db, 'err', 's1', { time: { created: AFTER }, model: { id: 'opencode/fledge-alpha-free', providerID: 'opencode' }, finish: 'error' })
  db.close()
  const [m] = readOpenCode(path, NOW)
  assert.ok(m)
  assert.equal(m.usageStatus, 'no_usage')
  assert.equal(m.inputTokens, null)
  assert.equal(m.outputTokens, null)
  assert.equal(m.loggedCostUsd, null)
})

test('a database with only the legacy table still works, and one with only v2 too', () => {
  const a = makeDb({ legacy: true })
  a.db.prepare("INSERT INTO session VALUES ('s','/r/app',NULL)").run()
  legacy(a.db, 'x', 's', legacyData())
  a.db.close()
  assert.equal(readOpenCode(a.path, NOW).length, 1)
  const b = makeDb({ v2: true })
  b.db.prepare("INSERT INTO session_v2 VALUES ('s','/r/app',NULL)").run()
  v2(b.db, 'y', 's', v2Data())
  b.db.close()
  assert.equal(readOpenCode(b.path, NOW).length, 1)
})

test('timestamps more than a day after now are dropped (clock garbage)', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session_v2 VALUES ('s1','/r/app',NULL)").run()
  v2(db, 'future', 's1', v2Data({ time: { created: NOW + 2 * 86_400_000 } }))
  db.close()
  assert.equal(readOpenCode(path, NOW).length, 0)
})

test('the source database is never modified', () => {
  const { path, db } = makeDb()
  db.prepare("INSERT INTO session_v2 VALUES ('s1','/r/app',NULL)").run()
  v2(db, 'm1', 's1', v2Data())
  db.close()
  const before = JSON.stringify(readOpenCode(path, NOW))
  assert.equal(JSON.stringify(readOpenCode(path, NOW)), before)
})

test('read all parent sessions including ones with no eligible assistant message', () => {
  const {path,db}=makeDb()
  db.prepare("INSERT INTO session_v2 VALUES('root','/r',NULL),('child','/r','root')").run()
  db.prepare("INSERT INTO session VALUES('child','/old','wrong-parent')").run()
  db.close()
  assert.deepEqual(readOpenCodeSessions(path).map(s=>[s.sessionId,s.parentSessionId]),[['root',null],['child','root']])
})
test('V2 and legacy retain identical IDs in separate sessions', () => {
  const {path,db}=makeDb()
  db.prepare("INSERT INTO session_v2 VALUES('a','/r',NULL)").run()
  db.prepare("INSERT INTO session VALUES('b','/r',NULL)").run()
  v2(db,'reused','a',v2Data())
  legacy(db,'reused','b',legacyData())
  db.close()
  assert.deepEqual(readOpenCode(path,NOW).map(m=>m.sourceSessionId),['a','b'])
})
test('fork_session_id is read when present and absent in old schemas',()=>{
 const old=makeDb({v2:true,legacy:false})
 old.db.prepare("INSERT INTO session_v2 VALUES('root','/r',NULL)").run()
 old.db.close()
 assert.equal(readOpenCodeSessions(old.path)[0]?.forkSessionId,null)
 const modern=makeDb({v2:true,legacy:false})
 modern.db.exec('ALTER TABLE session_v2 ADD COLUMN fork_session_id TEXT')
 modern.db.prepare("INSERT INTO session_v2(id,directory,parent_id,fork_session_id) VALUES('branch','/r',NULL,'root')").run()
 modern.db.close()
 assert.equal(readOpenCodeSessions(modern.path)[0]?.forkSessionId,'root')
})
