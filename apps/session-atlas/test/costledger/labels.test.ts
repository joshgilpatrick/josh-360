import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTestLedger } from '../helpers/costledger.ts'
import { tempDir } from '../helpers/tmp.ts'
import { importLabels, parseClaudeLabels, parsePiLabels, readOpenCodeLabels, storeLabels } from '../../src/costledger/labels.ts'
import { ingest } from '../../src/costledger/ingest.ts'

const NOW = '2026-10-09T00:00:00.000Z'
const line = (o: object) => JSON.stringify(o)
function file(lines: string[], name = 's1.jsonl'): string {
  const p = join(tempDir('labels-'), name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

test('claude: keeps the last custom title, ai title and agent name per session', async () => {
  const p = file([
    line({ type: 'ai-title', aiTitle: 'First guess', sessionId: 's1' }),
    line({ type: 'custom-title', customTitle: 'med - suki', sessionId: 's1' }),
    line({ type: 'agent-name', agentName: 'Suki sync', sessionId: 's1' }),
    line({ type: 'ai-title', aiTitle: 'Better guess', sessionId: 's1' }),
    line({ type: 'user', message: { role: 'user', content: 'hello' }, sessionId: 's1' }),
  ])
  const r = await parseClaudeLabels(p)
  const by = Object.fromEntries(r.labels.map(l => [l.kind, l.value]))
  assert.deepEqual(by, { ai_title: 'Better guess', custom_title: 'med - suki', agent_name: 'Suki sync' })
  assert.ok(r.labels.every(l => l.tool === 'claude-code' && l.sessionId === 's1'))
})

test('claude: ignores empty or non-string titles and unparseable lines', async () => {
  const p = file([
    '{not json "type":"ai-title"',
    line({ type: 'ai-title', aiTitle: '', sessionId: 's1' }),
    line({ type: 'custom-title', customTitle: 42, sessionId: 's1' }),
    line({ type: 'agent-name', sessionId: 's1' }),
  ])
  assert.deepEqual((await parseClaudeLabels(p)).labels, [])
})

test('claude: pr-link repeats collapse to one link per URL', async () => {
  const pr = { type: 'pr-link', sessionId: 's1', prNumber: '38', prUrl: 'https://github.com/o/r/pull/38', prRepository: 'o/r', timestamp: 't' }
  const p = file([line(pr), line(pr), line({ ...pr, prNumber: '39', prUrl: 'https://github.com/o/r/pull/39' })])
  const r = await parseClaudeLabels(p)
  assert.deepEqual(r.prLinks.map(l => [l.url, l.repository, l.number]).sort(), [
    ['https://github.com/o/r/pull/38', 'o/r', '38'], ['https://github.com/o/r/pull/39', 'o/r', '39'],
  ])
})

test('claude: a record without sessionId falls back to the file name', async () => {
  const p = file([line({ type: 'custom-title', customTitle: 'named' })], 'abc-123.jsonl')
  assert.equal((await parseClaudeLabels(p)).labels[0]?.sessionId, 'abc-123')
})

test('claude: a sidechain file under subagents/ takes the parent session id from its path', async () => {
  const dir = tempDir('labels-sub-')
  const p = join(dir, 'parent-sid', 'subagents', 'agent-x.jsonl')
  mkdirSync(join(dir, 'parent-sid', 'subagents'), { recursive: true })
  writeFileSync(p, line({ type: 'agent-name', agentName: 'helper' }) + '\n')
  assert.equal((await parseClaudeLabels(p)).labels[0]?.sessionId, 'parent-sid')
})

function opencodeDb(): { path: string; db: DatabaseSync } {
  const path = join(tempDir('oc-labels-'), 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT)')
  return { path, db }
}

test('opencode: stores real titles and skips the placeholder titles', () => {
  const { path, db } = opencodeDb()
  const ins = db.prepare('INSERT INTO session VALUES (?,?,?)')
  ins.run('a', 'PIMS monthly audit pipeline', null)
  ins.run('b', 'New session - 2026-05-13T13:50:23.794Z', null)
  ins.run('c', 'Child session - 2026-05-13T13:50:23.794Z', 'a')
  ins.run('d', '', null)
  db.close()
  const r = readOpenCodeLabels(path)
  assert.deepEqual(r.labels.map(l => [l.tool, l.sessionId, l.kind, l.value]), [['opencode', 'a', 'tool_title', 'PIMS monthly audit pipeline']])
})

test('opencode: a session_v2 title wins over the legacy session table', () => {
  const { path, db } = opencodeDb()
  db.prepare('INSERT INTO session VALUES (?,?,?)').run('a', 'Old title', null)
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT)')
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('a', 'New title', null)
  db.close()
  assert.deepEqual(readOpenCodeLabels(path).labels.map(l => l.value), ['New title'])
})

test('opencode: a database with neither session table yields nothing', () => {
  const path = join(tempDir('oc-empty-'), 'opencode.db')
  new DatabaseSync(path).close()
  assert.deepEqual(readOpenCodeLabels(path), { labels: [], prLinks: [] })
})

test('storeLabels is idempotent and updates a changed title in place', () => {
  const db = openTestLedger()
  const one = { labels: [{ tool: 'claude-code' as const, sessionId: 's1', kind: 'ai_title' as const, value: 'First' }], prLinks: [] }
  storeLabels(db, one, NOW)
  storeLabels(db, one, NOW)
  const two = { labels: [{ tool: 'claude-code' as const, sessionId: 's1', kind: 'ai_title' as const, value: 'Second' }], prLinks: [] }
  storeLabels(db, two, '2026-10-10T00:00:00.000Z')
  const rows = db.raw.prepare('SELECT value, recorded_at FROM session_labels').all() as Array<{ value: string; recorded_at: string }>
  assert.deepEqual(rows.map(r => ({ ...r })), [{ value: 'Second', recorded_at: '2026-10-10T00:00:00.000Z' }])
  db.close()
})

test('storeLabels keeps different kinds and PR links side by side and never duplicates a PR', () => {
  const db = openTestLedger()
  const pr = { tool: 'claude-code' as const, sessionId: 's1', url: 'https://github.com/o/r/pull/1', repository: 'o/r', number: '1' }
  const data = {
    labels: [
      { tool: 'claude-code' as const, sessionId: 's1', kind: 'custom_title' as const, value: 'Mine' },
      { tool: 'claude-code' as const, sessionId: 's1', kind: 'ai_title' as const, value: 'Auto' },
    ],
    prLinks: [pr],
  }
  storeLabels(db, data, NOW)
  storeLabels(db, data, NOW)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_labels').get() as { c: number }).c, 2)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_pr_links').get() as { c: number }).c, 1)
  db.close()
})

test('the same session id under two tools stays separate', () => {
  const db = openTestLedger()
  storeLabels(db, { labels: [
    { tool: 'claude-code', sessionId: 'x', kind: 'ai_title', value: 'claude one' },
    { tool: 'pi', sessionId: 'x', kind: 'custom_title', value: 'pi one' },
  ], prLinks: [] }, NOW)
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_labels').get() as { c: number }).c, 2)
  db.close()
})

test('the schema rejects an unknown label kind and an empty value', () => {
  const db = openTestLedger()
  const ins = db.raw.prepare('INSERT INTO session_labels (tool, source_session_id, kind, value, recorded_at) VALUES (?,?,?,?,?)')
  assert.throws(() => ins.run('claude-code', 's', 'summary', 'x', NOW))
  assert.throws(() => ins.run('claude-code', 's', 'ai_title', '', NOW))
  db.close()
})

const piHeader = (id = 'pi-1') => line({ type: 'session', version: 3, id, timestamp: NOW, cwd: '/r/app' })

test('pi: the last session_info name becomes the custom title', () => {
  const p = file([
    piHeader(),
    line({ type: 'session_info', id: 'a', parentId: null, timestamp: NOW, name: 'First name' }),
    line({ type: 'session_info', id: 'b', parentId: 'a', timestamp: NOW, name: ' Refactor auth ' }),
  ])
  assert.deepEqual(parsePiLabels(p).labels.map(l => [l.tool, l.sessionId, l.kind, l.value]), [['pi', 'pi-1', 'custom_title', 'Refactor auth']])
})

test('pi: a later blank name does not erase an earlier one, and no name means no label', () => {
  const kept = file([piHeader(), line({ type: 'session_info', name: 'Keep me' }), line({ type: 'session_info', name: '  ' })])
  assert.equal(parsePiLabels(kept).labels[0]?.value, 'Keep me')
  assert.deepEqual(parsePiLabels(file([piHeader()])).labels, [])
  assert.deepEqual(parsePiLabels(file([line({ type: 'session_info', name: 'orphan' })])).labels, [])
})

function sources(): { claude: string; pi: string; oc: string; claudeFile: string } {
  const claude = tempDir('lab-claude-')
  const pi = tempDir('lab-pi-')
  const oc = join(tempDir('lab-oc-'), 'opencode.db')
  mkdirSync(join(claude, 'proj'), { recursive: true })
  const claudeFile = join(claude, 'proj', 's1.jsonl')
  writeFileSync(claudeFile, [
    line({ type: 'ai-title', aiTitle: 'Ledger work', sessionId: 's1' }),
    line({ type: 'pr-link', sessionId: 's1', prUrl: 'https://github.com/o/r/pull/7', prRepository: 'o/r', prNumber: '7' }),
  ].join('\n') + '\n')
  writeFileSync(join(pi, 'p.jsonl'), [piHeader('pi-9'), line({ type: 'session_info', name: 'Pi named' })].join('\n') + '\n')
  const o = new DatabaseSync(oc)
  o.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT)')
  o.prepare('INSERT INTO session VALUES (?,?,?)').run('oc-1', 'OpenCode named', null)
  o.close()
  return { claude, pi, oc, claudeFile }
}

test('importLabels captures all three tools, and a second run changes nothing', async () => {
  const db = openTestLedger()
  const s = sources()
  const errors: string[] = []
  const src = { claudeProjectsDir: s.claude, piSessionsDir: s.pi, opencodeDb: s.oc }
  await importLabels(db, src, NOW, errors)
  const dump = () => db.raw.prepare('SELECT tool, source_session_id s, kind, value, recorded_at FROM session_labels ORDER BY tool, s, kind').all().map(r => ({ ...r }))
  const first = dump()
  assert.deepEqual(first.map(r => [r.tool, r.s, r.kind, r.value]), [
    ['claude-code', 's1', 'ai_title', 'Ledger work'], ['opencode', 'oc-1', 'tool_title', 'OpenCode named'], ['pi', 'pi-9', 'custom_title', 'Pi named'],
  ])
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_pr_links').get() as { c: number }).c, 1)
  await importLabels(db, src, '2026-10-20T00:00:00.000Z', errors)
  assert.deepEqual(dump(), first)
  assert.deepEqual(errors, [])
  db.close()
})

test('importLabels re-reads a changed transcript but skips an unchanged one', async () => {
  const db = openTestLedger()
  const s = sources()
  const src = { claudeProjectsDir: s.claude, piSessionsDir: null, opencodeDb: null }
  await importLabels(db, src, NOW, [])
  writeFileSync(s.claudeFile, line({ type: 'custom-title', customTitle: 'Renamed later', sessionId: 's1' }) + '\n')
  utimesSync(s.claudeFile, new Date(), new Date(Date.now() + 5000))
  await importLabels(db, src, '2026-10-21T00:00:00.000Z', [])
  const kinds = (db.raw.prepare('SELECT kind FROM session_labels ORDER BY kind').all() as Array<{ kind: string }>).map(r => r.kind)
  assert.deepEqual(kinds, ['ai_title', 'custom_title'])
  db.close()
})

test('one unreadable source is reported and the others still import', async () => {
  const db = openTestLedger()
  const s = sources()
  const bad = join(tempDir('lab-bad-'), 'opencode.db')
  writeFileSync(bad, 'not a database')
  const errors: string[] = []
  await importLabels(db, { claudeProjectsDir: s.claude, piSessionsDir: s.pi, opencodeDb: bad }, NOW, errors)
  assert.equal(errors.length, 1)
  assert.ok(errors[0]?.includes('opencode.db'))
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_labels').get() as { c: number }).c, 2)
  db.close()
})

test('missing source folders and a missing OpenCode file are fine', async () => {
  const db = openTestLedger()
  const errors: string[] = []
  await importLabels(db, { claudeProjectsDir: '/nope/a', piSessionsDir: '/nope/b', opencodeDb: '/nope/c.db' }, NOW, errors)
  await importLabels(db, { claudeProjectsDir: null, piSessionsDir: null, opencodeDb: null }, NOW, errors)
  assert.deepEqual(errors, [])
  db.close()
})

test('ingest() runs the label import, so a normal import fills session_labels', async () => {
  const db = openTestLedger()
  const s = sources()
  const summary = await ingest(db, { claudeProjectsDir: s.claude, piSessionsDir: s.pi, opencodeDb: s.oc }, NOW)
  assert.deepEqual(summary.errors, [])
  assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM session_labels').get() as { c: number }).c, 3)
  db.close()
})

test('a file the message scan already reported is not reported again by the label scan', async () => {
  const db = openTestLedger()
  const dir = tempDir('lab-dup-')
  const bad = join(dir, 'bad.jsonl')
  writeFileSync(bad, line({ type: 'ai-title', aiTitle: 'x', sessionId: 's' }) + '\n')
  const errors = [`${bad}: EACCES`]
  const { chmodSync } = await import('node:fs')
  chmodSync(bad, 0o000)
  try {
    await importLabels(db, { claudeProjectsDir: dir, piSessionsDir: null, opencodeDb: null }, NOW, errors)
  } finally {
    chmodSync(bad, 0o600)
  }
  assert.deepEqual(errors, [`${bad}: EACCES`])
  db.close()
})
