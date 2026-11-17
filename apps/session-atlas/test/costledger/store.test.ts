import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RANK_SQL, isSuspect, markScanned, needsScan, promptSideTokens, totalTokens, upsertMessage, upsertRepo } from '../../src/costledger/store.ts'
import { FIXED_NOW, openTestLedger } from '../helpers/costledger.ts'
import type { Attribution, ParsedMessage } from '../../src/costledger/types.ts'

const ATTR: Attribution = { repoKey: '/r/app', displayName: 'app', rootPath: '/r/app', worktreePath: '/r/app/wt', resolution: 'live' }
const NONE: Attribution = { repoKey: null, displayName: null, rootPath: null, worktreePath: null, resolution: 'none' }

function pm(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    tool: 'claude-code', sourceMessageId: 'm1', sourceSessionId: 's1', tsUtc: '2026-09-30T12:00:00.000Z',
    modelRaw: 'claude-sonnet-5', providerRaw: null,
    inputTokens: 100, outputTokens: 10, reasoningTokens: null, cacheReadTokens: 0,
    cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheWriteUnclassifiedTokens: 0,
    loggedCostUsd: null, isSidechain: false, cwd: '/r/app', gitBranch: 'main',
    sourcePath: '/t/a.jsonl', sourceLocator: 'line:1', usageStatus: 'ok',
    ...over,
  }
}
type Row = { id: number; source_session_id: string | null; output_tokens: number | null; input_tokens: number | null; is_sidechain: number; ts_utc: string; source_path: string; source_locator: string; suspect: number; repo_key: string | null; worktree_path: string | null; attribution_quality: string; usage_status: string; git_branch: string | null }
const rows = (db: ReturnType<typeof openTestLedger>) => db.raw.prepare('SELECT * FROM messages ORDER BY id').all() as unknown as Row[]

test('totalTokens and promptSideTokens treat null as 0 and ignore reasoning', () => {
  const m = pm({ inputTokens: 1, outputTokens: 2, reasoningTokens: 50, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 5, cacheWriteUnclassifiedTokens: null })
  assert.equal(totalTokens(m), 15)
  assert.equal(promptSideTokens(m), 13)
  assert.equal(totalTokens(pm({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWrite5mTokens: null, cacheWrite1hTokens: null, cacheWriteUnclassifiedTokens: null })), 0)
})

test('a new message is inserted with attribution columns and a repos row', () => {
  const db = openTestLedger()
  assert.equal(upsertMessage(db, pm(), ATTR, 'exact'), 'inserted')
  const r = rows(db)[0]
  assert.equal(r?.repo_key, '/r/app')
  assert.equal(r?.worktree_path, '/r/app/wt')
  assert.equal(r?.attribution_quality, 'exact')
  assert.equal(r?.git_branch, 'main')
  assert.equal(r?.suspect, 0)
  assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM repos WHERE repo_key = '/r/app'").get() as { c: number }).c, 1)
  db.close()
})

test('the same message twice is kept, not duplicated', () => {
  const db = openTestLedger()
  upsertMessage(db, pm(), ATTR, 'exact')
  assert.equal(upsertMessage(db, pm(), ATTR, 'exact'), 'kept')
  assert.equal(rows(db).length, 1)
  db.close()
})

test('copied Claude call is billed once but every session and agent holds it', () => {
  const db=openTestLedger()
  assert.equal(upsertMessage(db,pm({sourceSessionId:'a',sourceAgentId:null,outputTokens:10}),ATTR,'exact'),'inserted')
  assert.equal(upsertMessage(db,pm({sourceSessionId:'b',sourceAgentId:'child',isSidechain:true,outputTokens:5}),ATTR,'exact'),'kept')
  assert.equal(rows(db).length,1)
  assert.deepEqual(db.raw.prepare('SELECT source_session_id s,source_agent_id a FROM message_holders ORDER BY s').all().map(r=>({...r})),
    [{s:'a',a:''},{s:'b',a:'child'}])
  assert.equal(upsertMessage(db,pm({sourceSessionId:'b',sourceAgentId:'child',outputTokens:20}),ATTR,'exact'),'replaced')
  assert.equal(rows(db)[0]?.source_session_id,'b')
  assert.equal((db.raw.prepare('SELECT count(*) n FROM message_holders').get() as {n:number}).n,2)
  assert.equal((db.raw.prepare('SELECT count(*) n FROM message_holders h JOIN messages m ON m.id=h.message_id').get() as {n:number}).n,2)
  db.close()
})
test('an identical re-scan changes neither message nor holder counts', () => {
  const db=openTestLedger()
  const counts=() => db.raw.prepare('SELECT (SELECT count(*) FROM messages) m,(SELECT count(*) FROM message_holders) h').get()
  upsertMessage(db,pm({sourceSessionId:'a'}),ATTR,'exact')
  upsertMessage(db,pm({sourceSessionId:'b',sourceAgentId:'child'}),ATTR,'exact')
  const before=counts()
  upsertMessage(db,pm({sourceSessionId:'a'}),ATTR,'exact')
  upsertMessage(db,pm({sourceSessionId:'b',sourceAgentId:'child'}),ATTR,'exact')
  assert.deepEqual(counts(),before)
  db.close()
})
test('Pi and OpenCode retain identical message IDs in different sessions', () => {
  const db=openTestLedger()
  for (const tool of ['pi','opencode'] as const) {
    upsertMessage(db,pm({tool,sourceSessionId:'a'}),ATTR,'exact')
    upsertMessage(db,pm({tool,sourceSessionId:'b'}),ATTR,'exact')
  }
  assert.equal(rows(db).length,4)
  db.close()
})

test('messages without a session id still deduplicate within the unknown-session group', () => {
  const db = openTestLedger()
  assert.equal(upsertMessage(db, pm({ sourceSessionId: null }), ATTR, 'exact'), 'inserted')
  assert.equal(upsertMessage(db, pm({ sourceSessionId: null }), ATTR, 'exact'), 'kept')
  assert.equal(rows(db).length, 1)
  db.close()
})

test('a grown re-scan replaces the stored row and keeps its id (never duplicates)', () => {
  const db = openTestLedger()
  upsertMessage(db, pm({ outputTokens: 10 }), ATTR, 'exact')
  const id = rows(db)[0]?.id
  assert.equal(upsertMessage(db, pm({ outputTokens: 80 }), ATTR, 'exact'), 'replaced')
  const all = rows(db)
  assert.equal(all.length, 1)
  assert.equal(all[0]?.id, id)
  assert.equal(all[0]?.output_tokens, 80)
  db.close()
})

test('fewer tokens never replace a stored row', () => {
  const db = openTestLedger()
  upsertMessage(db, pm({ outputTokens: 80 }), ATTR, 'exact')
  assert.equal(upsertMessage(db, pm({ outputTokens: 5 }), ATTR, 'exact'), 'kept')
  assert.equal(rows(db)[0]?.output_tokens, 80)
  db.close()
})

test('equal tokens: non-sidechain beats sidechain, never the reverse', () => {
  const db = openTestLedger()
  upsertMessage(db, pm({ isSidechain: true }), ATTR, 'exact')
  assert.equal(upsertMessage(db, pm({ isSidechain: false }), ATTR, 'exact'), 'replaced')
  assert.equal(rows(db)[0]?.is_sidechain, 0)
  assert.equal(upsertMessage(db, pm({ isSidechain: true }), ATTR, 'exact'), 'kept')
  db.close()
})

test('equal tokens and sidechain: earlier ts wins, then smaller path, then smaller locator', () => {
  const db = openTestLedger()
  upsertMessage(db, pm({ tsUtc: '2026-09-30T12:00:05.000Z' }), ATTR, 'exact')
  assert.equal(upsertMessage(db, pm({ tsUtc: '2026-09-30T12:00:01.000Z' }), ATTR, 'exact'), 'replaced')
  assert.equal(upsertMessage(db, pm({ tsUtc: '2026-09-30T12:00:09.000Z' }), ATTR, 'exact'), 'kept')
  assert.equal(upsertMessage(db, pm({ tsUtc: '2026-09-30T12:00:01.000Z', sourcePath: '/t/0.jsonl' }), ATTR, 'exact'), 'replaced')
  assert.equal(upsertMessage(db, pm({ tsUtc: '2026-09-30T12:00:01.000Z', sourcePath: '/t/9.jsonl' }), ATTR, 'exact'), 'kept')
  assert.equal(upsertMessage(db, pm({ tsUtc: '2026-09-30T12:00:01.000Z', sourcePath: '/t/0.jsonl', sourceLocator: 'line:0' }), ATTR, 'exact'), 'replaced')
  assert.equal(rows(db)[0]?.source_locator, 'line:0')
  db.close()
})

test('the same id in different tools is two rows', () => {
  const db = openTestLedger()
  upsertMessage(db, pm(), ATTR, 'exact')
  upsertMessage(db, pm({ tool: 'opencode' }), ATTR, 'exact')
  assert.equal(rows(db).length, 2)
  db.close()
})

test('suspect bounds are strictly greater than 2,000,000 prompt-side or 500,000 output', () => {
  assert.equal(isSuspect(pm({ inputTokens: 2_000_000, outputTokens: 0 })), false)
  assert.equal(isSuspect(pm({ inputTokens: 1_000_000, cacheReadTokens: 1_000_001, outputTokens: 0 })), true)
  assert.equal(isSuspect(pm({ inputTokens: 0, outputTokens: 500_000 })), false)
  assert.equal(isSuspect(pm({ inputTokens: 0, outputTokens: 500_001 })), true)
  const db = openTestLedger()
  upsertMessage(db, pm({ inputTokens: 2_000_001 }), ATTR, 'exact')
  assert.equal(rows(db)[0]?.suspect, 1)
  db.close()
})

test('null tokens stay null and no_usage status is stored', () => {
  const db = openTestLedger()
  upsertMessage(db, pm({ inputTokens: null, outputTokens: null, usageStatus: 'no_usage' }), ATTR, 'exact')
  const r = rows(db)[0]
  assert.equal(r?.input_tokens, null)
  assert.equal(r?.output_tokens, null)
  assert.equal(r?.usage_status, 'no_usage')
  db.close()
})

test('a null-repo message is stored with null repo_key and adds no repos row', () => {
  const db = openTestLedger()
  upsertMessage(db, pm({ cwd: null, gitBranch: null }), NONE, 'unknown')
  const r = rows(db)[0]
  assert.equal(r?.repo_key, null)
  assert.equal(r?.attribution_quality, 'unknown')
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM repos').get() as { c: number }).c, 0)
  db.close()
})

test('upsertRepo is idempotent', () => {
  const db = openTestLedger()
  upsertRepo(db, ATTR)
  upsertRepo(db, ATTR)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM repos').get() as { c: number }).c, 1)
  db.close()
})

test('scan state: unknown path scans; same size and mtime skips; either change rescans; one row per path', () => {
  const db = openTestLedger()
  assert.equal(needsScan(db, '/t/a.jsonl', 10, 1000), true)
  markScanned(db, 'claude-code', '/t/a.jsonl', 10, 1000, FIXED_NOW)
  assert.equal(needsScan(db, '/t/a.jsonl', 10, 1000), false)
  assert.equal(needsScan(db, '/t/a.jsonl', 11, 1000), true)
  assert.equal(needsScan(db, '/t/a.jsonl', 10, 1001), true)
  markScanned(db, 'claude-code', '/t/a.jsonl', 11, 1001, FIXED_NOW)
  assert.equal(needsScan(db, '/t/a.jsonl', 11, 1001), false)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM source_files').get() as { c: number }).c, 1)
  db.close()
})

test('the duplicate lookup uses every column of the identity index', () => {
  const db = openTestLedger()
  for (const tool of ['claude-code', 'pi'] as const) {
    const plan = db.raw.prepare('EXPLAIN QUERY PLAN ' + RANK_SQL).all(tool, 's', 'x') as Array<{ detail: string }>
    const detail = plan.map(p => p.detail).join(' ')
    assert.match(detail, /messages_source_identity_idx/, tool)
    assert.match(detail, /source_message_id=\?/, tool + ': message id must be an index key, not a scan filter')
  }
  db.close()
})
