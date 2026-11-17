import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { costLedgerImportRunner, COST_LEDGER_IMPORT_INTERVAL_MS } from '../../src/service/costledger-import-runner.ts'
import { openLedger } from '../../src/costledger/db.ts'
import { tempDir } from '../helpers/tmp.ts'
import type { Logger } from '../../src/util/log.ts'

type Result = { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function logger(onEntry?: (message: string, level: string, data?: object) => void) {
  const entries: Array<{ level: string; message: string; data?: object }> = []
  const record = (level: string, message: string, data?: object) => {
    entries.push({ level, message, data })
    onEntry?.(message, level, data)
  }
  const log: Logger = {
    info: (message, data) => record('info', message, data),
    warn: (message, data) => record('warn', message, data),
    error: (message, data) => record('error', message, data),
  }
  return { entries, log }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const success: Result = { exitCode: 0, signal: null, stdout: 'claude: 2 files\npricing: 3 priced', stderr: '' }

const paths = {
  homeDir: '/Users/tester',
  ledgerPath: '/Users/tester/.claude/cost-ledger/ledger.db',
  projectsDir: '/Users/tester/.claude/projects',
  piSessionsDir: '/Users/tester/.pi/agent/sessions',
}

test('Atlas starts an isolated ledger import immediately, then no more than hourly', async () => {
  const { entries, log } = logger()
  let now = 1_000_000
  const argsSeen: string[][] = []
  let completeFirst!: (result: Result) => void
  const runner = costLedgerImportRunner({
    ...paths,
    log,
    now: () => now,
    runImport: async args => {
      argsSeen.push(args)
      if (argsSeen.length === 1) return await new Promise<Result>(resolve => { completeFirst = resolve })
      return success
    },
  })

  assert.equal(await runner.run(), false)
  assert.equal(argsSeen.length, 1)
  assert.equal(await runner.run(), false, 'do not overlap a still-running import')
  assert.equal(argsSeen.length, 1)

  completeFirst(success)
  await flush()
  now += COST_LEDGER_IMPORT_INTERVAL_MS - 1
  await runner.run()
  assert.equal(argsSeen.length, 1)
  now += 1
  await runner.run()
  assert.equal(argsSeen.length, 2)
  await flush()

  const args = argsSeen[0]!
  assert.equal(args[0], '--disable-warning=ExperimentalWarning')
  assert.ok(args[1]?.endsWith('/src/costledger/cli.ts'))
  assert.deepEqual(args.slice(2), [
    'import',
    '--claude-dir', paths.projectsDir,
    '--pi-dir', paths.piSessionsDir,
    '--opencode-db', '/Users/tester/.local/share/opencode/opencode.db',
    '--db', paths.ledgerPath,
  ])
  assert.ok(entries.some(entry => entry.level === 'info' && entry.message === 'ledger import completed'))
})

test('a failed import is logged and does not reject the Atlas runner loop', async () => {
  const { entries, log } = logger()
  const runner = costLedgerImportRunner({
    ...paths,
    log,
    runImport: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'database is locked' }),
  })

  assert.equal(await runner.run(), false)
  await flush()
  const failure = entries.find(entry => entry.level === 'error' && entry.message === 'ledger import failed')
  assert.ok(failure)
  assert.match(JSON.stringify(failure.data), /database is locked/)
})

test('the default runner starts the costledger CLI against its configured paths', { timeout: 15_000 }, async () => {
  const homeDir = tempDir('atlas-cost-ledger-home-')
  const projectsDir = join(homeDir, '.claude', 'projects')
  const piSessionsDir = join(homeDir, '.pi', 'agent', 'sessions')
  const ledgerPath = join(homeDir, '.claude', 'cost-ledger', 'ledger.db')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(piSessionsDir, { recursive: true })

  let finish!: (message: string, level: string, data?: object) => void
  const completed = new Promise<{ message: string; level: string; data?: object }>(resolve => {
    finish = (message, level, data) => resolve({ message, level, data })
  })
  const { log } = logger((message, level, data) => {
    if (message === 'ledger import completed' || message === 'ledger import failed') finish(message, level, data)
  })
  const runner = costLedgerImportRunner({ homeDir, ledgerPath, projectsDir, piSessionsDir, log })

  assert.equal(await runner.run(), false)
  const result = await completed
  assert.equal(result.message, 'ledger import completed')
  assert.equal(result.level, 'info')
  const summary = (result.data as { summary: string }).summary
  assert.match(summary, /claude: files 0/)
  assert.match(summary, /pi: files 0/)
  assert.match(summary, /opencode: files 0/)
  assert.match(summary, /pricing: priced 0/)
  assert.ok(existsSync(ledgerPath))
  const db = openLedger(ledgerPath)
  try {
    assert.equal((db.raw.prepare('SELECT COUNT(*) c FROM import_runs').get() as { c: number }).c, 1)
  } finally {
    db.close()
  }
})

test('stopping Atlas prevents another hourly import', async () => {
  let now = 1_000_000
  let calls = 0
  const runner = costLedgerImportRunner({
    ...paths,
    log: logger().log,
    now: () => now,
    runImport: async () => { calls += 1; return success },
  })

  await runner.run()
  await flush()
  runner.stop?.()
  now += COST_LEDGER_IMPORT_INTERVAL_MS
  await runner.run()
  assert.equal(calls, 1)
})
