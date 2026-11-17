import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { sessionRoots } from '../../src/costledger/session-reports.ts'
import { reportTotal } from '../../src/costledger/reports.ts'
import { main } from '../../src/costledger/cli.ts'
import { openLedger } from '../../src/costledger/db.ts'
import { tempDir } from '../helpers/tmp.ts'

const NOW = '2026-10-13T00:00:00.000Z'

type Setup = { db: string; claudeDir: string; root: string }

function setup(): Setup {
  const root = tempDir('cli-')
  const dir = join(root, 'claude', 'proj')
  mkdirSync(dir, { recursive: true })
  const plain = join(root, 'plain')
  mkdirSync(plain)
  // one sonnet message at exactly the start of week 2026-09-28: 1,000,000 input tokens = $2.00
  writeFileSync(join(dir, 'a.jsonl'), JSON.stringify({
    type: 'assistant', isSidechain: false, sessionId: 's', cwd: plain, gitBranch: '', timestamp: '2026-09-28T00:00:00.000Z',
    message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n')
  return { db: join(root, 'led', 'ledger.db'), claudeDir: join(root, 'claude'), root }
}

async function run(args: string[], now = NOW): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, { out: s => out.push(s), err: s => err.push(s), now: () => now })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
/** Always disables Pi and OpenCode so a test can never read the real ones. */
const importArgs = (s: Setup, ...extra: string[]) => ['import', '--db', s.db, '--claude-dir', s.claudeDir, '--pi-dir', 'none', '--opencode-db', 'none', ...extra]

test('import then report --json gives the hand-computed cost', async () => {
  const s = setup()
  const imp = await run(importArgs(s, '--json'))
  assert.equal(imp.code, 0)
  const parsed = JSON.parse(imp.out) as { ingest: { claude: { inserted: number } }; pricing: { priced: number } }
  assert.equal(parsed.ingest.claude.inserted, 1)
  assert.equal(parsed.pricing.priced, 1)
  const rep = await run(['report', '--by', 'tool', '--db', s.db, '--json'])
  assert.equal(rep.code, 0)
  const body = JSON.parse(rep.out) as { rows: Array<{ key: string; costUsd: number }>; total: { costUsd: number } }
  assert.equal(body.rows[0]?.key, 'claude-code')
  assert.equal(body.rows[0]?.costUsd, 2)
  assert.equal(body.total.costUsd, 2)
})

test('report table is human readable and includes a TOTAL row', async () => {
  const s = setup()
  await run(importArgs(s))
  const rep = await run(['report', '--by', 'repo', '--db', s.db])
  assert.equal(rep.code, 0)
  assert.match(rep.out, /\(no repo\)/)
  assert.match(rep.out, /\$2\.00/)
  assert.match(rep.out, /TOTAL/)
})

test('importing twice reports nothing new', async () => {
  const s = setup()
  await run(importArgs(s))
  const again = await run(importArgs(s, '--json'))
  const parsed = JSON.parse(again.out) as { ingest: { claude: { inserted: number; filesSkipped: number } } }
  assert.equal(parsed.ingest.claude.inserted, 0)
  assert.equal(parsed.ingest.claude.filesSkipped, 1)
})

test('unpriced lists models with no price; empty when everything is priced', async () => {
  const s = setup()
  await run(importArgs(s))
  const none = await run(['unpriced', '--db', s.db, '--json'])
  assert.deepEqual(JSON.parse(none.out), { rows: [] })
})

test('price add + reprice changes the cost; an older date is refused with exit 1', async () => {
  const s = setup()
  await run(importArgs(s))
  const add = await run(['price', 'add', '--db', s.db, '--model', 'claude-sonnet-5', '--class', 'input', '--usd', '3', '--effective-from', '2026-09-28T00:00:00.000Z', '--note', 'test'])
  assert.equal(add.code, 0)
  assert.match(add.out, /reprice/)
  const before = JSON.parse((await run(['report', '--by', 'tool', '--db', s.db, '--json'])).out) as { total: { costUsd: number } }
  assert.equal(before.total.costUsd, 2)
  const rp = await run(['reprice', '--db', s.db, '--json'])
  assert.equal(rp.code, 0)
  const after = JSON.parse((await run(['report', '--by', 'tool', '--db', s.db, '--json'])).out) as { total: { costUsd: number } }
  assert.equal(after.total.costUsd, 3)
  const old = await run(['price', 'add', '--db', s.db, '--model', 'claude-sonnet-5', '--class', 'input', '--usd', '9', '--effective-from', '2019-01-01T00:00:00.000Z'])
  assert.equal(old.code, 1)
  assert.match(old.err, /later than/)
})

test('model add, price add and alias add make a previously unknown model priceable via reprice', async () => {
  const s = setup()
  await run(importArgs(s))
  const addModelRun = await run(['model', 'add', '--db', s.db, '--model', 'claude-sonnet-5-cli', '--vendor', 'anthropic'])
  assert.equal(addModelRun.code, 0)
  assert.match(addModelRun.out, /price add/)
  const addPriceRun = await run(['price', 'add', '--db', s.db, '--model', 'claude-sonnet-5-cli', '--class', 'input', '--usd', '1', '--effective-from', '2026-01-01T00:00:00.000Z'])
  assert.equal(addPriceRun.code, 0)
  const alias = await run(['alias', 'add', '--db', s.db, '--alias', 'claude-sonnet-5-cli-alt', '--model', 'claude-sonnet-5-cli', '--note', 'test'])
  assert.equal(alias.code, 0)
  assert.match(alias.out, /reprice/)
  const check = new DatabaseSync(s.db)
  assert.deepEqual({ ...(check.prepare("SELECT model_id m FROM model_aliases WHERE alias = 'claude-sonnet-5-cli-alt'").get() as object) }, { m: 'claude-sonnet-5-cli' })
  check.close()
})

test('model add and alias add: a conflict exits 1; a missing flag or unknown target exits 2', async () => {
  const s = setup()
  await run(importArgs(s))
  assert.equal((await run(['model', 'add', '--db', s.db, '--model', 'claude-sonnet-5', '--vendor', 'anthropic'])).code, 1)
  assert.equal((await run(['model', 'add', '--db', s.db, '--model', 'x-model'])).code, 2)
  assert.equal((await run(['alias', 'add', '--db', s.db, '--alias', 'new-name', '--model', 'no-such-model'])).code, 2)
  assert.equal((await run(['alias', 'add', '--db', s.db, '--alias', 'claude-sonnet-5', '--model', 'claude-sonnet-5'])).code, 1)
  assert.equal((await run(['alias', 'add', '--db', s.db, '--model', 'claude-sonnet-5'])).code, 2)
})

test('reconcile: all three keys are judged; one key outside 10% fails overall; labels are printed', async () => {
  const s = setup()
  await run(importArgs(s))
  const file = join(s.root, 'bifrost.json')
  const row = (virtualKey: string, cost: number) => ({ week: '2026-09-28', virtualKey, model: 'claude-sonnet-5', costUsd: cost, requests: 1, failures: 0, promptTokens: 1_000_000, outputTokens: 0 })
  writeFileSync(file, JSON.stringify([row('claude-code-cli', 2.1)]))
  const partial = await run(['reconcile', '--db', s.db, '--bifrost-file', file])
  assert.equal(partial.code, 0)
  assert.match(partial.out, /ACCEPTANCE claude-code-cli \(1 complete weeks\): PASS/)
  assert.match(partial.out, /ACCEPTANCE opencode: NOT EVALUATED/)
  assert.match(partial.out, /session-attributed \$2\.00, bifrost \$2\.10, unattributed remainder \$0\.10/)
  assert.match(partial.out, /ACCEPTANCE OVERALL: NOT PASSED/)
  writeFileSync(file, JSON.stringify([row('claude-code-cli', 3)]))
  const fail = await run(['reconcile', '--db', s.db, '--bifrost-file', file, '--json'])
  assert.equal(fail.code, 0)
  const body = JSON.parse(fail.out) as { acceptance: { allPass: boolean; keys: Array<{ virtualKey: string; status: string; weeks: Array<{ gapModels: Array<{ modelGroup: string }> }> }> } }
  const claude = body.acceptance.keys.find(k => k.virtualKey === 'claude-code-cli')
  assert.equal(claude?.status, 'FAIL')
  assert.equal(claude?.weeks[0]?.gapModels[0]?.modelGroup, 'claude-sonnet-5')
  assert.equal(body.acceptance.allPass, false)
  const early = await run(['reconcile', '--db', s.db, '--bifrost-file', file], '2026-09-30T00:00:00.000Z')
  assert.match(early.out, /ACCEPTANCE claude-code-cli: NOT EVALUATED/)
})

test('reconcile prints unpriced and suspect counts on a week line, and only when they are above zero', async () => {
  const s = setup()
  await run(importArgs(s))
  const file = join(s.root, 'bifrost.json')
  writeFileSync(file, JSON.stringify([{ week: '2026-09-28', virtualKey: 'claude-code-cli', model: 'claude-sonnet-5', costUsd: 2, requests: 1, failures: 0, promptTokens: 1_000_000, outputTokens: 0 }]))
  const clean = await run(['reconcile', '--db', s.db, '--bifrost-file', file])
  assert.match(clean.out, /\) pass$/m)
  assert.doesNotMatch(clean.out, /unpriced|suspect/)
  const led = openLedger(s.db)
  try {
    led.raw.prepare('UPDATE messages SET suspect = 1').run()
  } finally {
    led.close()
  }
  await run(['reprice', '--db', s.db])
  const flagged = await run(['reconcile', '--db', s.db, '--bifrost-file', file])
  assert.match(flagged.out, /week 2026-09-28: .* FAIL, suspect 1$/m)
  assert.doesNotMatch(flagged.out, /unpriced/)
  const led2 = openLedger(s.db)
  try {
    led2.raw.prepare("UPDATE messages SET suspect = 0, model_raw = 'no-such-model-zz'").run()
  } finally {
    led2.close()
  }
  await run(['reprice', '--db', s.db])
  const unpriced = await run(['reconcile', '--db', s.db, '--bifrost-file', file])
  assert.match(unpriced.out, /week 2026-09-28: .* FAIL, unpriced 1$/m)
  assert.doesNotMatch(unpriced.out, /suspect/)
})

test('trace prints the source location, the cost and the price rows; an unknown id exits 1', async () => {
  const s = setup()
  await run(importArgs(s))
  const t = await run(['trace', '--db', s.db, '--id', 'msg_1'])
  assert.equal(t.code, 0)
  assert.match(t.out, /a\.jsonl line:1/)
  assert.match(t.out, /priced \$2\.00/)
  assert.match(t.out, /price #\d+ claude-sonnet-5 input min 0 \$2\/M/)
  const j = JSON.parse((await run(['trace', '--db', s.db, '--id', 'msg_1', '--json'])).out) as Array<{ prices: unknown[] }>
  assert.equal(j[0]?.prices.length, 1)
  const missing = await run(['trace', '--db', s.db, '--id', 'nope'])
  assert.equal(missing.code, 1)
})

test('logged-cost lists nothing when no tool logged a cost', async () => {
  const s = setup()
  await run(importArgs(s))
  const r = await run(['logged-cost', '--db', s.db, '--json'])
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.out), { rows: [] })
})

test('reconcile with a malformed Bifrost file exits 1', async () => {
  const s = setup()
  await run(importArgs(s))
  const file = join(s.root, 'bad.json')
  writeFileSync(file, '{"nope": true}')
  const r = await run(['reconcile', '--db', s.db, '--bifrost-file', file])
  assert.equal(r.code, 1)
  assert.match(r.err, /error:/)
})

test('usage errors exit 2: unknown command, missing --by, bad dimension, unknown flag, unknown model, bad class, bad date, missing value', async () => {
  const s = setup()
  const cases: string[][] = [
    ['nope'],
    [],
    ['report', '--db', s.db],
    ['report', '--db', s.db, '--by', 'planet'],
    ['report', '--db', s.db, '--by', 'tool', '--bogus', 'x'],
    ['price', 'add', '--db', s.db, '--model', 'no-such-model', '--class', 'input', '--usd', '1', '--effective-from', '2026-10-01T00:00:00.000Z'],
    ['price', 'add', '--db', s.db, '--model', 'x', '--class', 'bogus', '--usd', '1', '--effective-from', '2026-10-01T00:00:00.000Z'],
    ['price', 'add', '--db', s.db, '--model', 'x', '--class', 'input', '--usd', '1', '--effective-from', 'yesterday'],
    ['report', '--db', s.db, '--by', 'tool', '--from', 'garbage'],
    ['report', '--db'],
    ['report', '--db', s.db, '--by', 'tool', '--from', '--json'],
    ['trace', '--db', s.db, '--id', '--json'],
    ['reconcile', '--db', s.db],
    ['trace', '--db', s.db],
  ]
  for (const args of cases) {
    const r = await run(args)
    assert.equal(r.code, 2, `args ${JSON.stringify(args)} gave ${r.code}: ${r.err}`)
    assert.match(r.err, /usage|error/i)
  }
})

test('--from and --to with no timezone are UTC whatever the host TZ; date-only, offsets and --to are honoured', async () => {
  const s = setup()
  await run(importArgs(s))
  const prev = process.env.TZ
  const count = async (...flags: string[]): Promise<number> => {
    const r = await run(['report', '--by', 'tool', '--db', s.db, '--json', ...flags])
    assert.equal(r.code, 0, r.err)
    return (JSON.parse(r.out) as { rows: unknown[] }).rows.length
  }
  try {
    for (const tz of ['America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz
      // the one message sits at exactly 2026-09-28T00:00:00Z
      assert.equal(await count('--from', '2026-09-28T00:00:00'), 1, tz)
      assert.equal(await count('--from', '2026-09-28T00:00:01'), 0, tz)
      assert.equal(await count('--from', '2026-09-28'), 1, tz)
      assert.equal(await count('--from', '2026-09-27T20:00:00-04:00'), 1, tz)
      assert.equal(await count('--to', '2026-09-28T00:00:01'), 1, tz)
      assert.equal(await count('--to', '2026-09-28T00:00:00'), 0, tz)
    }
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
})

test('an empty --from or --to value is a usage error, not "no bound"', async () => {
  const s = setup()
  await run(importArgs(s))
  for (const flag of ['--from', '--to']) {
    const r = await run(['report', '--by', 'tool', '--db', s.db, flag, ''])
    assert.equal(r.code, 2, flag)
    assert.match(r.err, new RegExp(`error: ${flag} must be an ISO date`))
  }
})

test('price add --effective-from with no timezone is UTC whatever the host TZ; an offset is honoured', async () => {
  const s = setup()
  await run(importArgs(s))
  const prev = process.env.TZ
  const add = async (from: string, min: string, note: string): Promise<void> => {
    const r = await run(['price', 'add', '--db', s.db, '--model', 'claude-sonnet-5', '--class', 'input', '--usd', '3', '--min', min, '--effective-from', from, '--note', note])
    assert.equal(r.code, 0, r.err)
  }
  const stored = (note: string): string | undefined => {
    const led = openLedger(s.db)
    try {
      return (led.raw.prepare('SELECT effective_from AS f FROM prices WHERE source_note = ?').get(note) as { f: string } | undefined)?.f
    } finally {
      led.close()
    }
  }
  try {
    process.env.TZ = 'Asia/Tokyo'
    await add('2030-01-01T09:00:00', '1000', 'naive')
    await add('2030-01-01T09:00:00+09:00', '2000', 'offset')
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
  assert.equal(stored('naive'), '2030-01-01T09:00:00.000Z')
  assert.equal(stored('offset'), '2030-01-01T00:00:00.000Z')
})

test('price add with a valid model still exits 2 for: --usd -1, --min 1.5, a bad --class, a missing or empty --effective-from', async () => {
  const s = setup()
  await run(importArgs(s))
  const ok = ['--model', 'claude-sonnet-5', '--class', 'input', '--usd', '1', '--effective-from', '2030-01-01T00:00:00Z']
  const swap = (flag: string, value: string | null): string[] => {
    const out: string[] = []
    for (let i = 0; i < ok.length; i += 2) {
      if (ok[i] !== flag) out.push(ok[i] as string, ok[i + 1] as string)
      else if (value !== null) out.push(flag, value)
    }
    return out
  }
  const cases: Array<[string[], RegExp]> = [
    [swap('--usd', '-1'), /--usd must be a number >= 0/],
    [[...ok, '--min', '1.5'], /--min must be an integer >= 0/],
    [swap('--class', 'bogus'), /--class must be one of/],
    [swap('--effective-from', null), /--effective-from is required/],
    [swap('--effective-from', ''), /--effective-from must be an ISO date/],
  ]
  for (const [args, message] of cases) {
    const r = await run(['price', 'add', '--db', s.db, ...args])
    assert.equal(r.code, 2, `args ${JSON.stringify(args)} gave ${r.code}: ${r.err}`)
    assert.match(r.err, message)
  }
})

test('an ingest error goes to stderr, not stdout, and the other files still import', { skip: process.getuid?.() === 0 }, async () => {
  const s = setup()
  const bad = join(s.claudeDir, 'proj', 'bad.jsonl')
  writeFileSync(bad, '{}\n')
  chmodSync(bad, 0o000)
  try {
    const r = await run(importArgs(s))
    assert.ok(r.err.startsWith(`error: ${bad}:`), r.err)
    assert.doesNotMatch(r.out, /error:/)
    assert.match(r.out, /^claude: files 1, /m)
    assert.match(r.out, /^pricing: priced 1,/m)
  } finally {
    chmodSync(bad, 0o600)
  }
})

test('a usage error prints the usage text; any other error does not; a trace with no match prints exactly one error line', async () => {
  const s = setup()
  await run(importArgs(s))
  const usage = await run(['price', 'add', '--db', s.db])
  assert.equal(usage.code, 2)
  assert.match(usage.err, /^error: --model is required\n/)
  assert.match(usage.err, /^usage: costledger <command> \[flags\]$/m)
  assert.match(usage.err, /^ {2}price add {2}--model M --class C --usd N --effective-from ISO/m)
  const missing = await run(['trace', '--db', s.db, '--id', 'nope'])
  assert.equal(missing.code, 1)
  assert.equal(missing.err, 'error: no message with that id')
  assert.equal(missing.out, '')
})

test('report prints the "unpriced: n messages" line only when something is unpriced', async () => {
  const s = setup()
  const line = /^unpriced: /m
  await run(importArgs(s))
  const clean = await run(['report', '--by', 'tool', '--db', s.db])
  assert.doesNotMatch(clean.out, line)
  writeFileSync(join(s.claudeDir, 'proj', 'b.jsonl'), JSON.stringify({
    type: 'assistant', isSidechain: false, sessionId: 's2', cwd: join(s.root, 'plain'), gitBranch: '', timestamp: '2026-09-28T00:00:00.000Z',
    message: { id: 'msg_2', role: 'assistant', model: 'no-such-model-9', usage: { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n')
  const imp = await run(importArgs(s))
  assert.equal(imp.code, 0, imp.err)
  const dirty = await run(['report', '--by', 'tool', '--db', s.db])
  assert.match(dirty.out, /^unpriced: 1 messages \(500 tokens\); run "unpriced" for the list$/m)
})

test('--pi-dir none skips Pi even when a Pi session sits in the home directory; the default reads it', async () => {
  const home = tempDir('home-')
  const piDir = join(home, '.pi', 'agent', 'sessions', 'proj')
  mkdirSync(piDir, { recursive: true })
  writeFileSync(join(piDir, 's.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-pi', timestamp: '2026-09-28T00:00:00.000Z', cwd: home }),
    JSON.stringify({ type: 'message', id: 'pi_1', parentId: null, timestamp: '2026-09-28T00:00:01.000Z', message: { role: 'assistant', provider: 'bifrost-pi', model: 'azure/gpt-6-luna', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 } } }),
  ].join('\n') + '\n')
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    const skipped = setup()
    const a = await run(['import', '--db', skipped.db, '--claude-dir', skipped.claudeDir, '--pi-dir', 'none'])
    assert.equal(a.code, 0, a.err)
    assert.match(a.out, /^pi: files 0, skipped 0, messages 0, inserted 0, replaced 0, kept 0$/m)
    const rep = JSON.parse((await run(['report', '--by', 'tool', '--db', skipped.db, '--json'])).out) as { total: { costUsd: number; messages: number } }
    assert.deepEqual([rep.total.messages, rep.total.costUsd], [1, 2])
    const read = setup()
    const b = await run(['import', '--db', read.db, '--claude-dir', read.claudeDir])
    assert.equal(b.code, 0, b.err)
    assert.match(b.out, /^pi: files 1, skipped 0, messages 1, inserted 1, replaced 0, kept 0$/m)
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
  }
})

test('session commands show own and family price without adding copied history', async () => {
  const s = setup(); await run(importArgs(s))
  const rep = await run(['report', '--by', 'session', '--db', s.db, '--json'])
  assert.equal(rep.code, 0, rep.err)
  const rows = (JSON.parse(rep.out) as { rows: Array<{ tool: string; sessionId: string; familyCostUsd: number }> }).rows
  assert.deepEqual(rows.map(r => [r.tool, r.sessionId, r.familyCostUsd]), [['claude-code', 's', 2]])
  const detail = await run(['session', '--tool', 'claude-code', '--id', 's', '--db', s.db, '--json'])
  assert.equal(detail.code, 0, detail.err)
  assert.equal((JSON.parse(detail.out) as { root: { familyCostUsd: number } }).root.familyCostUsd, 2)
  const text = await run(['session', '--tool', 'claude-code', '--id', 's', '--db', s.db])
  assert.equal(text.code, 0, text.err)
  assert.match(text.out, /\$2\.00/)
  assert.equal((await run(['report', '--by', 'session', '--db', s.db])).code, 0)
})

test('session command requires tool and rejects missing session', async () => {
  const s = setup(); await run(importArgs(s))
  assert.equal((await run(['session', '--id', 's', '--db', s.db])).code, 2)
  assert.equal((await run(['session', '--tool', 'bogus', '--id', 's', '--db', s.db])).code, 2)
  assert.equal((await run(['session', '--tool', 'claude-code', '--id', 'missing', '--db', s.db])).code, 1)
})

test('import --migrate-identity without --db is a usage error and opens no ledger', async () => {
  const s = setup()
  const r = await run(['import', '--migrate-identity', '--claude-dir', s.claudeDir, '--pi-dir', 'none', '--opencode-db', 'none'])
  assert.equal(r.code, 2)
  assert.match(r.err, /--migrate-identity requires an explicit --db/)
  assert.equal(r.out, '')
})

test('--migrate-identity is only accepted by import', async () => {
  const s = setup()
  const r = await run(['report', '--by', 'tool', '--db', s.db, '--migrate-identity'])
  assert.equal(r.code, 2)
})

test('old-index temp DB is refused by report untouched, and import --migrate-identity migrates it', async () => {
  const s = setup()
  const old = openLedger(s.db)
  old.raw.exec("DROP INDEX messages_source_identity_idx; CREATE UNIQUE INDEX messages_source_identity_idx ON messages(tool,COALESCE(source_session_id,''),source_message_id)")
  old.close()
  const schema = (): string => {
    const raw = new DatabaseSync(s.db, { readOnly: true })
    try { return JSON.stringify(raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()) } finally { raw.close() }
  }
  const before = schema()
  const rep = await run(['report', '--by', 'tool', '--db', s.db])
  assert.equal(rep.code, 1)
  assert.match(rep.err, /import --migrate-identity/)
  assert.doesNotMatch(rep.err, /\n\s+at /)
  assert.equal(schema(), before)
  const imp = await run(importArgs(s, '--migrate-identity'))
  assert.equal(imp.code, 0, imp.err)
  assert.notEqual(schema(), before)
  assert.equal((await run(['report', '--by', 'tool', '--db', s.db])).code, 0)
})

test('repricing changes a descendant family cost, root families sum to the tool total, and old pricing runs remain', async () => {
  const s = setup()
  const proj = join(s.claudeDir, 'proj')
  const plain = join(s.root, 'plain')
  const row = (id: string, model: string, ts: string, content: unknown[], agent: boolean) => JSON.stringify({
    type: 'assistant', isSidechain: agent, sessionId: 's', cwd: plain, gitBranch: '', timestamp: ts,
    message: { id, role: 'assistant', model, content, usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n'
  const tool = (id: string) => ({ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'general-purpose' } })
  // the root spawns two descendants: one priced from a later date, one whose model has no price at all
  writeFileSync(join(proj, 'a.jsonl'), readFileSync(join(proj, 'a.jsonl'), 'utf8') + row('msg_sp', 'claude-sonnet-5', '2026-09-28T00:00:00.000Z', [tool('t1'), tool('t2')], false).replace('1000000', '0'))
  mkdirSync(join(proj, 's', 'subagents'), { recursive: true })
  writeFileSync(join(proj, 's', 'subagents', 'agent-p.jsonl'), row('msg_p', 'claude-sonnet-5', '2026-09-29T00:00:00.000Z', [], true))
  writeFileSync(join(proj, 's', 'subagents', 'agent-p.meta.json'), JSON.stringify({ toolUseId: 't1', spawnDepth: 1 }))
  writeFileSync(join(proj, 's', 'subagents', 'agent-u.jsonl'), row('msg_u', 'mystery-model', '2026-09-29T00:00:00.000Z', [], true))
  writeFileSync(join(proj, 's', 'subagents', 'agent-u.meta.json'), JSON.stringify({ toolUseId: 't2', spawnDepth: 1 }))
  assert.equal((await run(importArgs(s))).code, 0)

  const snap = (): { family: number; unpriced: number; total: number; sum: number; runs: number[] } => {
    const led = openLedger(s.db)
    try {
      const roots = sessionRoots(led)
      const runs = (led.raw.prepare('SELECT id FROM pricing_runs ORDER BY id').all() as Array<{ id: number }>).map(x => x.id)
      return { family: roots[0]?.familyCostUsd ?? NaN, unpriced: roots[0]?.unpricedMessages ?? NaN, total: reportTotal(led).costUsd, sum: roots.reduce((a, x) => a + x.familyCostUsd, 0), runs }
    } finally { led.close() }
  }
  const before = snap()
  assert.ok(Math.abs(before.family - 4) < 1e-9, `family before ${before.family}`)
  assert.equal(before.unpriced, 1)
  assert.ok(Math.abs(before.sum - before.total) < 1e-9)

  assert.equal((await run(['price', 'add', '--db', s.db, '--model', 'claude-sonnet-5', '--class', 'input', '--usd', '3', '--effective-from', '2026-09-29T00:00:00.000Z'])).code, 0)
  assert.equal((await run(['reprice', '--db', s.db])).code, 0)
  const after = snap()
  assert.ok(Math.abs(after.family - 5) < 1e-9, `family after ${after.family}`)
  assert.equal(after.unpriced, 1)
  assert.ok(Math.abs(after.sum - after.total) < 1e-9)
  assert.ok(after.runs.length > before.runs.length)
  for (const id of before.runs) assert.ok(after.runs.includes(id), `pricing run ${id} was removed`)

  const text = await run(['session', '--tool', 'claude-code', '--id', 's', '--db', s.db])
  assert.equal(text.code, 0, text.err)
  assert.match(text.out, /family \$5\.00 \(\d+ msgs, 1 unpriced\)/)
  const tool2 = JSON.parse((await run(['report', '--by', 'tool', '--db', s.db, '--json'])).out) as { total: { unpricedMessages: number } }
  assert.equal(tool2.total.unpricedMessages, 1)
})
