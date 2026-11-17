import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { openLedger } from '../../src/costledger/db.ts'
import { importAll, ingest } from '../../src/costledger/ingest.ts'
import type { IngestSources } from '../../src/costledger/ingest.ts'
import { report, reportTotal } from '../../src/costledger/reports.ts'
import { sessionRoots } from '../../src/costledger/session-reports.ts'
import { OPENCODE_COST_CUTOFF_MS } from '../../src/costledger/constants.ts'
import { FIXED_NOW, openTestLedger } from '../helpers/costledger.ts'
import { tempDir } from '../helpers/tmp.ts'

const AFTER = OPENCODE_COST_CUTOFF_MS + 60_000
const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`)

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
}
function makeRepo(): { repo: string; real: string; wt: string } {
  const repo = join(tempDir('golden-repo-'), 'myrepo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'f.txt'), 'x')
  git(repo, 'add', 'f.txt')
  git(repo, 'commit', '-q', '-m', 'init')
  const wt = join(tempDir('golden-wt-'), 'wt1')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
  return { repo, real: realpathSync(repo), wt }
}

const usage = (input: number, output: number, o: Record<string, unknown> = {}) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, ...o,
})
function cl(id: string, cwd: string, branch: string, u: object, model = 'claude-sonnet-5', side = false): string {
  return JSON.stringify({
    type: 'assistant', isSidechain: side, sessionId: 'sess-g', cwd, gitBranch: branch, timestamp: '2026-09-30T12:00:00.000Z',
    message: { id, role: 'assistant', model, usage: u },
  })
}

type World = { sources: IngestSources; real: string; mainFile: string; piFile: string }

function build(): World {
  const root = tempDir('golden-')
  const { repo, real, wt } = makeRepo()
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'proj', 'subagents'), { recursive: true })
  const mainFile = join(claudeDir, 'proj', 'main.jsonl')
  writeFileSync(mainFile, [
    // A: main, repo root. (1000*2 + 100*10 + 2000*0.2 + 3000*2.5 + 500*4) / 1e6 = 0.0129
    cl('msg_A', repo, 'main', usage(1000, 100, { cache_read_input_tokens: 2000, cache_creation_input_tokens: 3500, cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 500 } })),
    // B: streamed twice in one file (output grows 10 -> 200); worktree of the same repo. (500*2 + 200*10) / 1e6 = 0.003
    cl('msg_B', wt, 'feat/x', usage(500, 10)),
    cl('msg_B', wt, 'feat/x', usage(500, 200)),
    // synthetic row: skipped by the parser
    cl('msg_S', plain, 'main', usage(5, 5), '<synthetic>'),
    // E: unknown model in a non-git directory, empty branch. 730 tokens, unpriced (missing_alias).
    cl('msg_E', plain, '', usage(700, 30), 'mystery-model'),
  ].join('\n') + '\n')
  // C: subagent, opus, directory deleted (.claude/worktrees fallback). (100*4 + 50*20) / 1e6 = 0.0014
  writeFileSync(join(claudeDir, 'proj', 'subagents', 'agent-1.jsonl'),
    cl('msg_C', join(repo, '.claude', 'worktrees', 'gone'), 'feat/gone', usage(100, 50), 'claude-opus-5-5', true) + '\n')

  const piDir = join(root, 'pi')
  mkdirSync(join(piDir, 'proj'), { recursive: true })
  const piFile = join(piDir, 'proj', 's.jsonl')
  writeFileSync(piFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-pi', timestamp: '2026-09-30T13:20:30.842Z', cwd: repo }),
    // Pi: (1000*0.1 + 500*0.5 + 10000*0.01 + 2000*0.125) / 1e6 = 0.0007
    JSON.stringify({ type: 'message', id: 'pi_1', parentId: null, timestamp: '2026-09-30T13:21:37.840Z', message: { role: 'assistant', provider: 'bifrost-pi', model: 'azure/gpt-6-luna', usage: { input: 1000, output: 500, reasoning: 100, cacheRead: 10000, cacheWrite: 2000, totalTokens: 13500, cost: { total: 0.5 } } } }),
  ].join('\n') + '\n')

  const ocDb = join(root, 'opencode.db')
  const db = new DatabaseSync(ocDb)
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT)')
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('s1', plain, null)
  const model = { id: 'big-pickle', providerID: 'opencode' }
  const ins = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)')
  // free model, priced at 0
  ins.run('m1', 's1', 'assistant', 1, AFTER, AFTER, JSON.stringify({ time: { created: AFTER }, model, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }))
  // no tokens: imported as no_usage
  ins.run('m2', 's1', 'assistant', 2, AFTER, AFTER, JSON.stringify({ time: { created: AFTER }, model }))
  db.close()

  return { sources: { claudeProjectsDir: claudeDir, piSessionsDir: piDir, opencodeDb: ocDb }, real, mainFile, piFile }
}

test('golden: parse -> attribute -> dedup -> price -> report, with hand-computed dollars', async () => {
  const w = build()
  const db = openTestLedger()
  const r = await importAll(db, w.sources, FIXED_NOW)

  assert.deepEqual(r.ingest.claude, { files: 2, filesSkipped: 0, messages: 5, inserted: 4, replaced: 1, kept: 0 })
  assert.deepEqual(r.ingest.pi, { files: 1, filesSkipped: 0, messages: 1, inserted: 1, replaced: 0, kept: 0 })
  assert.deepEqual(r.ingest.opencode, { files: 1, filesSkipped: 0, messages: 2, inserted: 2, replaced: 0, kept: 0 })
  assert.deepEqual(r.ingest.errors, [])
  assert.deepEqual(r.pricing, { priced: 5, missing_price: 0, missing_alias: 1, suspect: 0, no_usage: 1 })
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 7)

  const total = reportTotal(db)
  near(total.costUsd, 0.018)
  assert.equal(total.messages, 7)
  assert.equal(total.tokens, 21830)
  assert.equal(total.unpricedMessages, 1)
  assert.equal(total.unpricedTokens, 730)
  assert.equal(total.excludedMessages, 1)

  const byRepo = report(db, 'repo')
  const real = byRepo.find(x => x.key === w.real)
  near(real?.costUsd, 0.018)
  assert.equal(real?.messages, 4)
  const none = byRepo.find(x => x.key === '(no repo)')
  assert.equal(none?.messages, 3)
  near(none?.costUsd, 0)
  assert.equal(byRepo.length, 2)

  assert.deepEqual(report(db, 'branch').map(x => x.key).sort(), [
    '(no repo) @ (no branch)', `${w.real} @ (no branch)`, `${w.real} @ feat/gone`, `${w.real} @ feat/x`, `${w.real} @ main`,
  ].sort())
  const byTool = report(db, 'tool')
  near(byTool.find(x => x.key === 'claude-code')?.costUsd, 0.0173)
  near(byTool.find(x => x.key === 'pi')?.costUsd, 0.0007)
  near(byTool.find(x => x.key === 'opencode')?.costUsd, 0)
  const bySub = report(db, 'subagent')
  near(bySub.find(x => x.key === 'subagent')?.costUsd, 0.0014)
  near(bySub.find(x => x.key === 'main')?.costUsd, 0.0166)

  const quality = (id: string) => (db.raw.prepare('SELECT attribution_quality q FROM messages WHERE source_message_id = ?').get(id) as { q: string }).q
  assert.equal(quality('msg_A'), 'exact')
  assert.equal(quality('msg_B'), 'exact')
  assert.equal(quality('msg_C'), 'derived')
  assert.equal(quality('pi_1'), 'derived')
  assert.equal(quality('msg_E'), 'unknown')
  const sub = db.raw.prepare("SELECT is_sidechain s, worktree_path w FROM messages WHERE source_message_id = 'msg_C'").get() as { s: number; w: string }
  assert.equal(sub.s, 1)
  assert.ok(sub.w.endsWith('/.claude/worktrees/gone'))
  db.close()
})

test('golden: importing the same sources twice changes nothing (idempotent) and never double-counts', async () => {
  const w = build()
  const db = openTestLedger()
  await importAll(db, w.sources, FIXED_NOW)
  const before = report(db, 'repo')
  const beforeTotal = reportTotal(db)
  const second = await importAll(db, w.sources, FIXED_NOW)

  assert.equal(second.seeded, 0)
  assert.deepEqual(second.ingest.claude, { files: 0, filesSkipped: 2, messages: 0, inserted: 0, replaced: 0, kept: 0 })
  assert.deepEqual(second.ingest.pi, { files: 0, filesSkipped: 1, messages: 0, inserted: 0, replaced: 0, kept: 0 })
  assert.deepEqual(second.ingest.opencode, { files: 1, filesSkipped: 0, messages: 2, inserted: 0, replaced: 0, kept: 2 })
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 7)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM pricing_runs').get() as { c: number }).c, 2)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM import_runs WHERE finished_at IS NOT NULL').get() as { c: number }).c, 2)
  assert.deepEqual(report(db, 'repo'), before)
  assert.deepEqual(reportTotal(db), beforeTotal)
  db.close()
})

test('golden: a transcript that grew is re-scanned and corrects the stored row (no duplicate)', async () => {
  const w = build()
  const db = openTestLedger()
  await importAll(db, w.sources, FIXED_NOW)
  const repo = w.real
  // rewrite main.jsonl: msg_B final output is now 400 (was 200) and a new message msg_H appears
  writeFileSync(w.mainFile, [
    cl('msg_B', repo, 'feat/x', usage(500, 400)),
    cl('msg_H', repo, 'main', usage(100, 0)),
  ].join('\n') + '\n')
  const again = await ingest(db, w.sources, FIXED_NOW)
  assert.deepEqual(again.claude, { files: 1, filesSkipped: 1, messages: 2, inserted: 1, replaced: 1, kept: 0 })
  const rows = db.raw.prepare("SELECT output_tokens o FROM messages WHERE source_message_id = 'msg_B'").all() as Array<{ o: number }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.o, 400)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 8)
  db.close()
})

test('golden: sources set to null are skipped, and missing directories or files are not errors', async () => {
  const w = build()
  const db = openTestLedger()
  const none = await ingest(db, { claudeProjectsDir: null, piSessionsDir: null, opencodeDb: null }, FIXED_NOW)
  assert.equal(none.claude.files + none.pi.files + none.opencode.files, 0)
  const missing = await ingest(db, { claudeProjectsDir: join(w.real, 'nope'), piSessionsDir: join(w.real, 'nope2'), opencodeDb: join(w.real, 'nope.db') }, FIXED_NOW)
  assert.deepEqual(missing.errors, [])
  assert.equal(missing.claude.files + missing.pi.files + missing.opencode.files, 0)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 0)
  db.close()
})

test('golden: an unreadable file is reported, not marked scanned, and the rest still import', { skip: process.getuid?.() === 0 }, async () => {
  const w = build()
  chmodSync(w.piFile, 0o000)
  const db = openTestLedger()
  try {
    const r = await ingest(db, w.sources, FIXED_NOW)
    assert.equal(r.errors.length, 1)
    assert.ok(r.errors[0]?.startsWith(w.piFile))
    assert.equal(r.claude.inserted, 4)
    assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM source_files WHERE tool = ?').get('pi') as { c: number }).c, 0)
  } finally {
    chmodSync(w.piFile, 0o600)
    db.close()
  }
})

function chainFixture(): { root: string; project: string; childDir: string } {
  const root = tempDir('claude-tree-')
  const project = join(root, 'project'), sid = 'root'
  const childDir = join(project, sid, 'subagents')
  mkdirSync(childDir, { recursive: true })
  const tool = (id: string) => ({ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'general-purpose' } })
  const assistant = (id: string, content: unknown[] = []) => JSON.stringify({
    type: 'assistant', sessionId: sid, timestamp: '2026-10-01T00:00:00.000Z', cwd: root,
    message: { role: 'assistant', id, model: 'claude-sonnet-5', content,
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n'
  writeFileSync(join(project, sid + '.jsonl'), assistant('m0', [tool('t1')]))
  for (const [child, spawn, next, depth] of [
    ['a', 't1', 't2', 1], ['b', 't2', 't3', 2], ['c', 't3', null, 3],
  ] as const) {
    writeFileSync(join(childDir, 'agent-' + child + '.jsonl'), assistant('m' + child, next ? [tool(next)] : []))
    writeFileSync(join(childDir, 'agent-' + child + '.meta.json'), JSON.stringify({ toolUseId: spawn, spawnDepth: depth }))
  }
  return { root, project, childDir }
}
const chain = (db: ReturnType<typeof openTestLedger>) => db.raw.prepare(
  "SELECT source_agent_id a, parent_agent_id p FROM session_nodes WHERE tool='claude-code' AND source_session_id='root' AND source_agent_id<>'' ORDER BY a").all().map(r => ({ ...r }))

test('golden: a depth-3 Claude chain resolves through Agent tool calls, and a re-import changes only the changed link', async () => {
  const { root, project, childDir } = chainFixture()
  const db = openTestLedger()
  await importAll(db, { claudeProjectsDir: root, piSessionsDir: null, opencodeDb: null }, FIXED_NOW)
  assert.deepEqual(chain(db), [{ a: 'a', p: '' }, { a: 'b', p: 'a' }, { a: 'c', p: 'b' }])
  assert.equal(db.raw.prepare("SELECT 1 FROM session_nodes WHERE tool='claude-code' AND source_agent_id='' AND source_session_id='root'").all().length, 1)
  const calls = () => (db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c
  assert.equal(calls(), 4)

  // Re-point c at a through its meta; mtime bump is not needed because hierarchy reads every meta each import.
  writeFileSync(join(childDir, 'agent-c.meta.json'), JSON.stringify({ toolUseId: 't2', spawnDepth: 2 }))
  utimesSync(join(childDir, 'agent-c.meta.json'), new Date(), new Date())
  const again = await importAll(db, { claudeProjectsDir: root, piSessionsDir: null, opencodeDb: null }, FIXED_NOW)
  assert.equal(again.ingest.claude.files, 0)
  assert.deepEqual(chain(db), [{ a: 'a', p: '' }, { a: 'b', p: 'a' }, { a: 'c', p: 'a' }])
  assert.equal(calls(), 4)

  // Changed JSONL is re-scanned: prior calls and nodes stay, owners are replaced, nothing is duplicated.
  const main = join(project, 'root.jsonl')
  writeFileSync(main, readFileSync(main, 'utf8') + '\n')
  await importAll(db, { claudeProjectsDir: root, piSessionsDir: null, opencodeDb: null }, FIXED_NOW)
  assert.equal(calls(), 4)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM claude_spawn_owners').get() as { c: number }).c, 3)
  assert.deepEqual(chain(db), [{ a: 'a', p: '' }, { a: 'b', p: 'a' }, { a: 'c', p: 'a' }])
  db.close()
})

test('golden: a parse failure commits no rows, no spawn owners and no scanned mark', { skip: process.getuid?.() === 0 }, async () => {
  const { root, project } = chainFixture()
  const main = join(project, 'root.jsonl')
  chmodSync(main, 0o000)
  const db = openTestLedger()
  try {
    const r = await ingest(db, { claudeProjectsDir: root, piSessionsDir: null, opencodeDb: null }, FIXED_NOW)
    assert.equal(r.errors.length, 1)
    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM source_files WHERE path = ?").get(main) as { c: number }).c, 0)
    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM claude_spawn_owners WHERE source_path = ?").get(main) as { c: number }).c, 0)
    assert.equal((db.raw.prepare("SELECT COUNT(*) c FROM messages WHERE source_path = ?").get(main) as { c: number }).c, 0)
    assert.equal(r.claude.messages, 3)
  } finally {
    chmodSync(main, 0o600)
    db.close()
  }
})

test('golden: cross-tool invariants - root-family sum equals the overall total, shared history is one call with two holders', async () => {
  const root = tempDir('golden-inv-')
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const claudeDir = join(root, 'claude')
  mkdirSync(join(claudeDir, 'proj'), { recursive: true })
  const line = (sid: string, id: string, u: object, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant', isSidechain: false, sessionId: sid, cwd: plain, gitBranch: '', timestamp: '2026-09-30T12:00:00.000Z',
    message: { id, role: 'assistant', model: 'claude-sonnet-5', usage: { ...u, ...extra } },
  }) + '\n'
  // the same call (identical id, timestamp and usage) appears in two sessions: a resumed/forked history copy
  writeFileSync(join(claudeDir, 'proj', 'one.jsonl'), line('inv-1', 'shared', usage(1000, 100)))
  writeFileSync(join(claudeDir, 'proj', 'two.jsonl'),
    line('inv-2', 'shared', usage(1000, 100)) + line('inv-2', 'unique', usage(500, 50), { iterations: [{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }] }))
  const piDir = join(root, 'pi')
  mkdirSync(join(piDir, 'proj'), { recursive: true })
  writeFileSync(join(piDir, 'proj', 's.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 'inv-pi', timestamp: '2026-09-30T13:20:30.842Z', cwd: plain }),
    JSON.stringify({ type: 'message', id: 'pi_inv', parentId: null, timestamp: '2026-09-30T13:21:37.840Z', message: { role: 'assistant', provider: 'bifrost-pi', model: 'azure/gpt-6-luna', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 } } }),
  ].join('\n') + '\n')
  const ocDb = join(root, 'opencode.db')
  const oc = new DatabaseSync(ocDb)
  oc.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT)')
  oc.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  oc.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('oc-parent', plain, null)
  oc.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('oc-child', plain, 'oc-parent')
  const model = { id: 'big-pickle', providerID: 'opencode' }
  const tokens = { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }
  const ins = oc.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)')
  ins.run('oc1', 'oc-parent', 'assistant', 1, AFTER, AFTER, JSON.stringify({ time: { created: AFTER }, model, tokens, cost: 0 }))
  ins.run('oc2', 'oc-child', 'assistant', 1, AFTER, AFTER, JSON.stringify({ time: { created: AFTER }, model, tokens, cost: 0 }))
  oc.close()

  const db = openTestLedger()
  const r = await importAll(db, { claudeProjectsDir: claudeDir, piSessionsDir: piDir, opencodeDb: ocDb }, FIXED_NOW)
  assert.deepEqual(r.ingest.errors, [])
  assert.equal((db.raw.prepare("SELECT count(*) n FROM messages WHERE source_message_id='unique#adv0'").get() as { n: number }).n, 1)
  assert.equal((db.raw.prepare("SELECT parent_session_id p FROM session_nodes WHERE tool='opencode' AND source_session_id='oc-child'").get() as { p: string }).p, 'oc-parent')

  const total = reportTotal(db), roots = sessionRoots(db)
  near(roots.reduce((sum, x) => sum + x.familyCostUsd, 0), total.costUsd)
  assert.ok(total.costUsd > 0)
  assert.equal((db.raw.prepare("SELECT count(*) n FROM messages WHERE tool='claude-code' AND source_message_id='shared'").get() as { n: number }).n, 1)
  assert.equal((db.raw.prepare("SELECT count(*) n FROM message_holders h JOIN messages m ON m.id=h.message_id WHERE m.tool='claude-code' AND m.source_message_id='shared'").get() as { n: number }).n, 2)
  assert.equal((db.raw.prepare("SELECT count(*) n FROM session_links WHERE tool='claude-code' AND kind='shared_history'").get() as { n: number }).n, 1)
  db.close()
})

test('golden: a hierarchy sync failure is reported in errors and does not abort import or pricing', async () => {
  const { root } = chainFixture()
  const db = openTestLedger()
  db.raw.exec('DROP TABLE session_links')
  try {
    const r = await importAll(db, { claudeProjectsDir: root, piSessionsDir: null, opencodeDb: null }, FIXED_NOW)
    assert.ok(r.ingest.errors.length > 0)
    assert.ok(r.pricing.priced > 0)
  } finally {
    db.close()
  }
})

test('golden: a ledger migrated from the old shape gets per-agent data on the next import', async () => {
  const { root } = chainFixture()
  const sources = { claudeProjectsDir: root, piSessionsDir: null, opencodeDb: null }
  const path = join(tempDir('golden-migrate-'), 'ledger.db')
  const first = openLedger(path)
  await importAll(first, sources, FIXED_NOW)
  first.close()
  // Downgrade to the old shape: no agent column, no graph tables, Claude files already marked scanned.
  const raw = new DatabaseSync(path)
  raw.exec(`DROP VIEW session_overview_45d; DROP INDEX messages_source_identity_idx; ALTER TABLE messages DROP COLUMN source_agent_id;
    DROP TABLE message_holders; DROP TABLE claude_spawn_owners; DROP TABLE session_nodes; DROP TABLE session_links;
    CREATE UNIQUE INDEX messages_source_identity_idx ON messages(tool,COALESCE(source_session_id,''),source_message_id)`)
  raw.close()

  const db = openLedger(path, { allowIdentityMigration: true })
  try {
    const r = await importAll(db, sources, FIXED_NOW)
    assert.equal(r.ingest.claude.files, 4)
    assert.equal(r.ingest.claude.filesSkipped, 0)
    assert.deepEqual(db.raw.prepare("SELECT source_agent_id a FROM messages WHERE tool='claude-code' AND source_agent_id<>'' ORDER BY a").all().map(x => (x as { a: string }).a), ['a', 'b', 'c'])
    assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM claude_spawn_owners').get() as { c: number }).c, 3)
    assert.deepEqual(chain(db), [{ a: 'a', p: '' }, { a: 'b', p: 'a' }, { a: 'c', p: 'b' }])
    assert.deepEqual(db.raw.prepare("SELECT DISTINCT link_quality q FROM session_nodes WHERE source_agent_id<>''").all().map(x => ({ ...x })), [{ q: 'exact' }])
    const [top] = sessionRoots(db)
    assert.equal(top?.ownMessages, 1)
    assert.equal(top?.familyMessages, 4)
    near(top?.familyCostUsd, 4 * (top?.ownCostUsd ?? NaN))
    // the overview view is created after the migration, once the tables it reads exist again
    assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_overview_45d').get() as { c: number }).c >= 0, true)
  } finally {
    db.close()
  }
})
