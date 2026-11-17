import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { startRouteServer } from '../helpers/server.ts'
import { loadConfig } from '../../src/config.ts'
import { registerArtifactRepository, registerArtifactRoot } from '../../src/db/artifact-manager.ts'
import { closeIdleSessions, ensureSession, getSession, setSessionStatus } from '../../src/db/sessions.ts'
import { applyEvent } from '../helpers/apply-event.ts'
import { registerSessionRoutes } from '../../src/server/api-sessions.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { REMOVAL_CHECK_REMOTE_RETENTION_NOTE, type RemovalCheckOptions, type RemovalCheckResult } from '../../src/artifacts/removal-check.ts'
import { FIXED_DISCOVERY_SEGMENTS } from '../../src/artifacts/path-policy.ts'
import type { CliDeps } from '../../src/cli/artifacts.ts'

// Tests for `npm run artifacts` (plan 2026-10-26 Task 10). Every test uses a temporary HOME, temporary Git repositories and a
// local fake Atlas service on port 0; nothing reads or writes the real home directory, the real Atlas database or a real service.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI_PATH = join(REPO_ROOT, 'src', 'cli', 'artifacts.ts')
const ORIGINAL_ENV = { ...process.env }
const cleanups: Array<() => Promise<void> | void> = []
// The checker reads the configuration from process.env for its extension list: point it at a temporary HOME, never the real one.
const PROCESS_HOME = realpathSync(tempDir('atlas-cli-process-home-'))
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') || key.startsWith('ATLAS_')) delete process.env[key]
process.env.HOME = PROCESS_HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
delete process.env.XDG_CONFIG_HOME
after(async () => {
  for (const fn of cleanups.splice(0)) await fn()
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key]
  Object.assign(process.env, ORIGINAL_ENV)
})

const R1 = '5b1f0f0e-1c0a-4a55-9d0e-3c2f6a1b7e01'
const R2 = '5b1f0f0e-1c0a-4a55-9d0e-3c2f6a1b7e02'
const R3 = '5b1f0f0e-1c0a-4a55-9d0e-3c2f6a1b7e03'
const R4 = '5b1f0f0e-1c0a-4a55-9d0e-3c2f6a1b7e04'
const REPO_ID = '8d1e5a52-7a49-4b52-8f0a-0a6c1c2d3e4f'
const JOB1 = 'job-1111'
const JOB2 = 'job-2222'
const USAGE_RE = /^error: .+\nusage: /s

// ----------------------------------------------------------------------------------------------------------------- harness

type Recorded = { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: string; json: unknown }
type Reply = { status?: number; json?: unknown; text?: string; hang?: boolean; delayMs?: number; drop?: boolean; partial?: boolean }
type Fake = { port: number; requests: Recorded[]; close(): Promise<void> }

async function startFake(handler: (req: Recorded, n: number) => Reply | undefined): Promise<Fake> {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = Buffer.concat(chunks).toString('utf8')
      let json: unknown
      try { json = body ? JSON.parse(body) : undefined } catch { json = undefined }
      const rec: Recorded = { method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body, json }
      requests.push(rec)
      const reply = handler(rec, requests.length) ?? { status: 404, json: { error: { code: 'not-found', message: 'no route' } } }
      if (reply.hang) return
      if (reply.drop) {
        req.socket.destroy()
        return
      }
      if (reply.partial) {
        // Promises 100 bytes, sends 7, then the connection dies.
        req.socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"paused')
        setTimeout(() => req.socket.destroy(), 20)
        return
      }
      const send = (): void => {
        res.writeHead(reply.status ?? 200, { 'content-type': reply.text !== undefined ? 'text/plain' : 'application/json' })
        res.end(reply.text ?? JSON.stringify(reply.json))
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs)
      else send()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  let closed = false
  const fake: Fake = {
    port: address.port,
    requests,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    },
  }
  cleanups.push(() => fake.close())
  return fake
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const fake = await startFake(() => undefined)
  const port = fake.port
  await fake.close()
  return port
}

const makeHome = (): string => realpathSync(tempDir('atlas-cli-home-'))
const makeWork = (): string => realpathSync(tempDir('atlas-cli-work-'))

/** Every entry below `dir`, relative and sorted. */
function tree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(String).sort()
}

type Run = { code: number; out: string; err: string }

async function loadMain(): Promise<(argv: string[], deps?: CliDeps) => Promise<number>> {
  return (await import('../../src/cli/artifacts.ts')).main
}

async function run(argv: string[], home: string, port: number, deps: CliDeps = {}, env: Record<string, string> = {}): Promise<Run> {
  const main = await loadMain()
  let out = ''
  let err = ''
  const code = await main(argv, {
    env: { HOME: home, ATLAS_PORT: String(port), PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdout: t => { out += t },
    stderr: t => { err += t },
    ...deps,
  })
  return { code, out, err }
}

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: PROCESS_HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Atlas Test', GIT_AUTHOR_EMAIL: 'atlas@example.invalid', GIT_COMMITTER_NAME: 'Atlas Test', GIT_COMMITTER_EMAIL: 'atlas@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

/** A repository with one committed document, in a temporary work directory. */
function makeRepo(work: string, name = 'proj'): string {
  const dir = join(work, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# readme\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  return realpathSync(dir)
}

function addWorktree(repo: string, dir: string, branch: string): string {
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir)
  return realpathSync(dir)
}

/** A migrated catalog at the configured path, built with the repository's own opener (in the TEST only). */
async function makeCatalog(home: string): Promise<string> {
  const { openDatabase } = await import('../../src/db/database.ts')
  const path = join(home, '.josh-360', 'state', 'cache.db')
  openDatabase(path).close()
  return path
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function statusRoot(over: Record<string, unknown>): Record<string, unknown> {
  return {
    rootId: R1, kind: 'checkout', path: null, pathRedacted: false, protected: false, projectName: null, repositoryId: null, scopeFlags: ['checkout'],
    directOnly: false, state: 'idle', generation: 1, cursor: null, completedAt: null, lastSuccessfulAt: null, oldestQueuedAgeMs: 0, lastError: null,
    gaps: [], failures: [], includeOlderPending: false, reason: null, ...over,
  }
}

function statusBody(roots: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { paused: false, pendingJobs: 0, oldestQueueAgeMs: 0, priorityFacility: null, health: {}, roots, ...over }
}

const SID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * `endReason` / `endConfirmed` describe a closed session: a legacy closed row has neither (null, not confirmed), the idle sweep is
 * 'idle', a SessionEnd hook is 'hook' (confirmed).
 */
type Live = { id: string; status: 'active' | 'unknown' | 'closed'; resume: string | null; start?: string | null; endReason?: 'hook' | 'idle' | null; endConfirmed?: boolean }

/** A list row. The current service carries `startCwd` (R54); `startInRows: false` is an older service without the key. `endKeys: false` is a service older than the end reason. */
function listRow(r: Live, startInRows = false, endKeys = true): Record<string, unknown> {
  return {
    sessionId: r.id, title: 't', summary: null, projectName: null, resumeCwd: r.resume, ...(startInRows ? { startCwd: r.start === undefined ? r.resume : r.start } : {}),
    status: r.status, focusState: 'active', isSubagent: false,
    parentSessionId: null, startedAt: '2026-10-27T10:00:00.000Z', lastActivityAt: '2026-10-27T11:00:00.000Z', directCostUsd: null, sourceClient: 'claude-code',
    costStatus: 'pending', artifactCount: 0, childCount: 0, staleness: null,
    ...(endKeys ? { endReason: r.endReason ?? null, endConfirmed: r.endConfirmed ?? false } : {}),
  }
}

/**
 * A fake of GET /api/sessions (status/endConfirmed/limit/offset honored, like the real route) and GET /api/sessions/:id.
 * `startInRows: false`: an older service without the start folder. `endKeys: false`: a service older than the end reason (no
 * `endReason`/`endConfirmed` on rows, and the `endConfirmed` filter is ignored, as an unknown query parameter is).
 */
function sessionsService(rows: Live[], over: (req: Recorded) => Reply | undefined = () => undefined, options: { startInRows?: boolean; endKeys?: boolean } = {}): (req: Recorded) => Reply | undefined {
  return req => {
    const special = over(req)
    if (special) return special
    if (req.method === 'GET' && req.path === '/api/sessions') {
      const status = req.query.get('status')
      const confirmed = req.query.get('endConfirmed')
      const limit = Number(req.query.get('limit'))
      const offset = Number(req.query.get('offset'))
      const endKeys = options.endKeys !== false
      const matching = rows.filter(r => r.status === status && (!endKeys || confirmed === null || (confirmed === 'true') === (r.endConfirmed ?? false)))
      return { json: { rows: matching.slice(offset, offset + limit).map(r => listRow(r, options.startInRows === true, endKeys)), total: matching.length, limit, offset } }
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(req.path)
    if (req.method === 'GET' && detail) {
      const r = rows.find(x => x.id === detail[1])
      if (!r) return { status: 404, json: { error: 'session not found' } }
      return { json: { session: { sessionId: r.id, startCwd: r.start === undefined ? r.resume : r.start, resumeCwd: r.resume, status: r.status }, folders: { start: r.start === undefined ? r.resume : r.start, resume: r.resume } } }
    }
    return undefined
  }
}

const listRequests = (fake: Fake): Recorded[] => fake.requests.filter(r => r.path === '/api/sessions')
const detailRequests = (fake: Fake): Recorded[] => fake.requests.filter(r => /^\/api\/sessions\/[^/]+$/.test(r.path))

function cleanResult(over: Partial<RemovalCheckResult> = {}): RemovalCheckResult {
  return {
    exitCode: 0, target: '/work/wt', checkedAt: '2026-10-27T12:00:00.000Z', risks: [], unknowns: [],
    coverage: { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'inactive' }, ...over,
  }
}

type Seen = { target: string; options: RemovalCheckOptions }

/** An injected checker that records its arguments and returns `result`. */
function stubChecker(result: unknown): { seen: Seen[]; fn: NonNullable<CliDeps['checkWorktreeRemoval']> } {
  const seen: Seen[] = []
  return { seen, fn: async (target, options) => { seen.push({ target, options }); return result as RemovalCheckResult } }
}

/** The session probe the CLI builds for check-removal, captured through the injected checker. */
async function captureProbe(home: string, port: number, probe: CliDeps['probe'] = {}, requestTimeoutMs?: number): Promise<(target: string) => Promise<string | { activity: string; reason: string }>> {
  const stub = stubChecker(cleanResult())
  const deps: CliDeps = { checkWorktreeRemoval: stub.fn, probe }
  if (requestTimeoutMs !== undefined) deps.requestTimeoutMs = requestTimeoutMs
  const r = await run(['check-removal', '--worktree', '/work/wt'], home, port, deps)
  assert.equal(r.code, 0, r.err)
  const fn = stub.seen[0]?.options.probeSessionActivity
  assert.equal(typeof fn, 'function')
  return fn as (target: string) => Promise<string | { activity: string; reason: string }>
}

// ----------------------------------------------------------------------------------------------------------------- parser

const USAGE_CASES: Array<[string, string[]]> = [
  ['no arguments', []],
  ['an unknown command', ['frobnicate']],
  ['a prototype key as the command', ['constructor']],
  ['__proto__ as the command', ['__proto__']],
  ['an option instead of a command', ['--worktree', '/x']],
  ['help with an extra argument', ['help', 'check-removal']],
  ['status with an unknown flag', ['status', '--verbose']],
  ['status with a positional', ['status', 'extra']],
  ['status with a duplicate --json', ['status', '--json', '--json']],
  ['status with a value for a boolean flag', ['status', '--json=yes']],
  ['refresh without --root', ['refresh']],
  ['refresh with a duplicate --root', ['refresh', '--root', R1, '--root', R1]],
  ['refresh with a duplicate --include-older', ['refresh', '--root', R1, '--include-older', '--include-older']],
  ['refresh with a root that is not a UUID', ['refresh', '--root', 'not-a-uuid']],
  ['refresh with a path as the root', ['refresh', '--root', '/etc/passwd']],
  ['refresh with an empty root', ['refresh', '--root', '']],
  ['refresh with a UUID plus a suffix', ['refresh', '--root', `${R1}0`]],
  ['register-output without --path', ['register-output']],
  ['register-output with a relative path', ['register-output', '--path', 'relative/dir']],
  ['register-output with a tilde path', ['register-output', '--path', '~/out']],
  ['register-output with a .. segment', ['register-output', '--path', '/a/../b']],
  ['register-output with a NUL in the path', ['register-output', '--path', '/a\0b']],
  ['register-output with a newline in the path', ['register-output', '--path', '/a\nb']],
  ['register-output with an escape in the path', ['register-output', '--path', '/a\u001b[31mb']],
  ['register-output with a C1 control in the path', ['register-output', '--path', '/a\u009bb']],
  ['register-output with a relative --repo', ['register-output', '--path', '/a', '--repo', 'repo']],
  ['register-output with a duplicate --path', ['register-output', '--path', '/a', '--path', '/b']],
  ['register-output with a duplicate --repo', ['register-output', '--path', '/a', '--repo', '/b', '--repo', '/b']],
  ['output-dir without --repo', ['output-dir']],
  ['output-dir with a relative --repo', ['output-dir', '--repo', 'repo']],
  ['output-dir with a duplicate --repo', ['output-dir', '--repo', '/a', '--repo', '/a']],
  ['output-dir with a duplicate --create', ['output-dir', '--repo', '/a', '--create', '--create']],
  ['output-dir with a value for --create', ['output-dir', '--repo', '/a', '--create=1']],
  ['output-dir with an unknown flag', ['output-dir', '--repo', '/a', '--force']],
  ['check-removal without --worktree', ['check-removal']],
  ['check-removal with a relative worktree', ['check-removal', '--worktree', 'wt']],
  ['check-removal with a ./ worktree', ['check-removal', '--worktree', './wt']],
  ['check-removal with a .. segment', ['check-removal', '--worktree', '/a/b/../c']],
  ['check-removal with a newline in the worktree', ['check-removal', '--worktree', '/a\nb']],
  ['check-removal with an overlong worktree', ['check-removal', '--worktree', `/${'a'.repeat(4097)}`]],
  ['check-removal with a duplicate --worktree', ['check-removal', '--worktree', '/a', '--worktree', '/b']],
  ['check-removal with a duplicate --json', ['check-removal', '--worktree', '/a', '--json', '--json']],
  ['check-removal with a duplicate --timeout-ms', ['check-removal', '--worktree', '/a', '--timeout-ms', '2000', '--timeout-ms', '3000']],
  ['check-removal with a timeout below the minimum', ['check-removal', '--worktree', '/a', '--timeout-ms', '999']],
  ['check-removal with a timeout above the maximum', ['check-removal', '--worktree', '/a', '--timeout-ms', '120001']],
  ['check-removal with a fractional timeout', ['check-removal', '--worktree', '/a', '--timeout-ms', '1500.5']],
  ['check-removal with a non-numeric timeout', ['check-removal', '--worktree', '/a', '--timeout-ms', 'abc']],
  ['check-removal with an exponent timeout', ['check-removal', '--worktree', '/a', '--timeout-ms', '8e3']],
  ['check-removal with a zero-padded timeout', ['check-removal', '--worktree', '/a', '--timeout-ms', '08000']],
  ['check-removal with an empty timeout', ['check-removal', '--worktree', '/a', '--timeout-ms', '']],
  ['check-removal with a negative timeout', ['check-removal', '--worktree', '/a', '--timeout-ms', '-5000']],
  ['check-removal with --force', ['check-removal', '--worktree', '/a', '--force']],
  ['check-removal with --help after the command', ['check-removal', '--worktree', '/a', '--help']],
  ['check-removal with a positional', ['check-removal', '--worktree', '/a', '/b']],
  ['check-removal with an option terminator', ['check-removal', '--worktree', '/a', '--', '/b']],
  ['check-removal with a missing value', ['check-removal', '--worktree']],
  ['check-removal with a flag as the value', ['check-removal', '--worktree', '--json']],
]

test('every usage error exits 64 with the message and usage on stderr, nothing on stdout, no request and no file', async () => {
  const fake = await startFake(() => undefined)
  const home = makeHome()
  const stub = stubChecker(cleanResult())
  for (const [label, argv] of USAGE_CASES) {
    const r = await run(argv, home, fake.port, { checkWorktreeRemoval: stub.fn })
    assert.equal(r.code, 64, `${label}: exit code ${r.code}, stderr ${r.err}`)
    assert.equal(r.out, '', `${label}: stdout must stay empty`)
    assert.match(r.err, USAGE_RE, label)
  }
  for (const [flag, argv] of [['--root', ['refresh', '--root', '']], ['--worktree', ['check-removal', '--worktree', '']], ['--repo', ['output-dir', '--repo', '']]] as Array<[string, string[]]>) {
    assert.match((await run(argv, home, fake.port)).err, new RegExp(`^error: ${flag} needs a value`), `${flag} with an empty value`)
  }
  assert.equal(fake.requests.length, 0, 'a usage error makes no request')
  assert.equal(stub.seen.length, 0, 'a usage error never reaches the checker')
  assert.deepEqual(tree(home), [], 'a usage error creates nothing')
})

test('--help, -h and help print the usage to stdout and exit 0; they are the only exit-0 paths without a command', async () => {
  const home = makeHome()
  for (const argv of [['--help'], ['-h'], ['help']]) {
    const r = await run(argv, home, 1)
    assert.equal(r.code, 0, argv.join(' '))
    assert.equal(r.err, '')
    for (const word of ['status', 'refresh', 'register-output', 'output-dir', 'check-removal', '--timeout-ms', 'ATLAS_OUTPUT_DIR']) assert.ok(r.out.includes(word), `${argv.join(' ')}: usage mentions ${word}`)
    // The exit codes, the removal-check limits and the read-only catalog note.
    assert.match(r.out, /\b64\b.*usage/is)
    assert.match(r.out, /\b69\b/)
    assert.match(r.out, /\b70\b/)
    assert.match(r.out, /atlas\.db-wal/)
    assert.match(r.out, /read-only/i)
    assert.match(r.out, /never (?:creates|writes)/i)
  }
})

test('a missing atlas service is exit 69 for every service command, with nothing created and nothing on stdout', async () => {
  const port = await deadPort()
  const home = makeHome()
  const work = makeWork()
  const repo = makeRepo(work)
  for (const argv of [
    ['status'], ['status', '--json'], ['refresh', '--root', R1], ['refresh', '--root', R1, '--include-older'],
    ['register-output', '--path', join(work, 'out')], ['output-dir', '--repo', repo], ['output-dir', '--repo', repo, '--create'],
  ]) {
    const r = await run(argv, home, port)
    assert.equal(r.code, 69, `${argv.join(' ')}: ${r.err}`)
    assert.equal(r.out, '', argv.join(' '))
    assert.match(r.err, /^error: .*not reachable.*start it/s, argv.join(' '))
    assert.ok(r.err.includes(String(port)), 'names the port it tried')
  }
  assert.deepEqual(tree(home), [], 'no command creates the database, the atlas directory or anything else')
})

test('a hanging service is exit 69 after the request timeout, and a malformed or refused answer is 69, never a success', async () => {
  const home = makeHome()
  const hang = await startFake(() => ({ hang: true }))
  const started = Date.now()
  const timeout = await run(['status'], home, hang.port, { requestTimeoutMs: 150 })
  assert.equal(timeout.code, 69)
  assert.match(timeout.err, /did not answer in time/)
  assert.ok(Date.now() - started < 3000, 'the call is bounded')

  // A connection cut before any answer is "not reachable"; an answer beyond the size bound is refused, not parsed.
  const dropped = await startFake(() => ({ drop: true }))
  const cut = await run(['status'], home, dropped.port)
  assert.equal(cut.code, 69)
  assert.match(cut.err, /not reachable/)
  const cutShort = await startFake(() => ({ partial: true }))
  const partial = await run(['status'], home, cutShort.port)
  assert.equal(partial.code, 69)
  assert.equal(partial.out, '')
  assert.match(partial.err, /not reachable/, 'an answer cut off half way is not an answer')
  const huge = await startFake(() => ({ text: 'x'.repeat(17 * 1024 * 1024) }))
  const big = await run(['status'], home, huge.port)
  assert.equal(big.code, 69)
  assert.equal(big.out, '')
  assert.match(big.err, /too large/)

  for (const [label, reply] of [
    ['a 500', { status: 500, json: { error: { code: 'internal-error', message: '/home/leak' } } }],
    ['plain text', { text: 'hello' }],
    ['an array', { json: [] }],
    ['roots that are not a list', { json: { ...statusBody([]), roots: 'x' } }],
    ['a root without an ID', { json: statusBody([{ kind: 'output' }]) }],
    ['a paused flag that is not a boolean', { json: { ...statusBody([]), paused: 'no' } }],
    ['a missing pending count', { json: { paused: false, roots: [] } }],
  ] as Array<[string, Reply]>) {
    const fake = await startFake(() => reply)
    const r = await run(['status'], home, fake.port)
    assert.equal(r.code, 69, label)
    assert.equal(r.out, '', label)
    assert.ok(!r.err.includes('/home/leak'), `${label}: raw server text is not echoed`)
  }
})

// ----------------------------------------------------------------------------------------------------------------- status

const SECRET_PATH = '/secret/phi/leak'
const R5 = '5b1f0f0e-1c0a-4a55-9d0e-3c2f6a1b7e05'
const STATUS_ROOTS = [
  statusRoot({
    rootId: R1, kind: 'checkout', path: '/work/proj', projectName: 'proj', repositoryId: REPO_ID, state: 'partial', generation: 4,
    completedAt: '2026-10-27T10:00:00.000Z', lastSuccessfulAt: '2026-10-27T10:00:00.000Z', gaps: ['nested-checkout'], failures: [{ task: 'git-history', code: 'git-timeout' }],
    includeOlderPending: true, reason: 'Git history failed (git-timeout); use Refresh to retry. Importing older files.',
  }),
  statusRoot({ rootId: R2, kind: 'output', path: null, pathRedacted: true, protected: true, scopeFlags: ['cli-output'] }),
  statusRoot({ rootId: R3, kind: 'output', path: SECRET_PATH, pathRedacted: false, protected: true, projectName: 'clinic', scopeFlags: ['cli-output'], reason: 'Scanning.' }),
  statusRoot({ rootId: R4, kind: 'output', path: '/work/out', projectName: 'reports', scopeFlags: ['configured-output'], reason: 'line one\nline two\u001b[31m\u009b' }),
  statusRoot({ rootId: R5, kind: 'output', path: '/work/older', scopeFlags: ['cli-output'], includeOlderPending: true }),
]
const STATUS = statusBody(STATUS_ROOTS, { paused: true, pendingJobs: 3, oldestQueueAgeMs: 125_000, priorityFacility: 'applied', health: { slices: 7 } })

test('status prints paused state, queue, and every root; protected locations stay hidden even if the service leaks a path', async () => {
  const fake = await startFake(req => (req.path === '/api/artifact-manager/status' ? { json: STATUS } : undefined))
  const r = await run(['status'], makeHome(), fake.port)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.match(r.out, /paused/i)
  assert.match(r.out, /3 pending/)
  assert.match(r.out, /oldest waiting 2m/)
  assert.match(r.out, /checkout/)
  assert.ok(r.out.includes('/work/proj'))
  assert.match(r.out, /partial/)
  assert.ok(r.out.includes('2026-10-27T10:00:00.000Z'), 'last successful scan')
  assert.match(r.out, /nested-checkout/)
  assert.match(r.out, /git-history.*git-timeout/)
  assert.ok(r.out.includes('Git history failed (git-timeout); use Refresh to retry. Importing older files.'), 'reason sentences verbatim')
  assert.ok(r.out.includes('\n    importing older files\n'), 'a root importing older files says so, also when the service gave no sentence for it')
  assert.ok(r.out.includes('/work/out'))
  assert.equal(r.out.split('Protected location (hidden)').length - 1, 2, 'the redacted root and the leaking protected root are both hidden')
  assert.ok(!r.out.includes(SECRET_PATH) && !r.out.includes('clinic'), 'a protected root never prints its path or project name')
  // Control characters in a service-provided sentence are neutralized.
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(r.out), 'no control characters on stdout')
  assert.ok(r.out.includes('line one?line two?[31m?'))
  // One GET, and it never asks for protected paths.
  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0]!.method, 'GET')
  assert.equal(fake.requests[0]!.path, '/api/artifact-manager/status')
  assert.equal(fake.requests[0]!.query.has('sensitive'), false)
})

test('status --json prints one JSON document with the service shape, protected paths nulled', async () => {
  const fake = await startFake(() => ({ json: STATUS }))
  const r = await run(['status', '--json'], makeHome(), fake.port)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.endsWith('}\n') && !r.out.endsWith('\n\n'))
  const doc = JSON.parse(r.out) as { paused: boolean; pendingJobs: number; oldestQueueAgeMs: number; priorityFacility: string; health: Record<string, number>; roots: Array<Record<string, unknown>> }
  assert.equal(doc.paused, true)
  assert.equal(doc.pendingJobs, 3)
  assert.equal(doc.oldestQueueAgeMs, 125_000)
  assert.equal(doc.priorityFacility, 'applied')
  assert.deepEqual(doc.health, { slices: 7 })
  assert.deepEqual(doc.roots.map(x => x.rootId), [R1, R2, R3, R4, R5])
  assert.deepEqual(doc.roots[0], STATUS_ROOTS[0])
  assert.deepEqual(doc.roots[3], STATUS_ROOTS[3])
  assert.equal(doc.roots[1]!.path, null)
  assert.equal(doc.roots[2]!.path, null, 'a leaked protected path is nulled')
  assert.equal(doc.roots[2]!.pathRedacted, true)
  assert.equal(doc.roots[2]!.projectName, null)
  assert.ok(!r.out.includes(SECRET_PATH) && !r.out.includes('clinic'))
})

test('status with no roots says so', async () => {
  const fake = await startFake(() => ({ json: statusBody([]) }))
  const r = await run(['status'], makeHome(), fake.port)
  assert.equal(r.code, 0)
  assert.match(r.out, /no roots/i)
  assert.match(r.out, /running/i)
})

// ----------------------------------------------------------------------------------------------------------------- refresh

test('refresh posts only a lower-case root ID (and includeOlder when asked) in a local JSON request, and prints the jobs and the paused note', async () => {
  const fake = await startFake(req => (req.method === 'POST' && req.path === '/api/artifact-manager/refresh'
    ? { status: 202, json: { jobId: JOB1, rootId: R1, includeOlder: req.json !== undefined && (req.json as { includeOlder?: boolean }).includeOlder === true, historyJobId: JOB2, paused: true } } : undefined))
  const home = makeHome()
  const r = await run(['refresh', '--root', R1.toUpperCase(), '--include-older'], home, fake.port)
  assert.equal(r.code, 0, r.err)
  assert.equal(fake.requests.length, 1)
  const req = fake.requests[0]!
  assert.deepEqual(req.json, { rootId: R1, includeOlder: true })
  assert.match(String(req.headers['content-type']), /^application\/json/)
  assert.equal(req.headers.host, `127.0.0.1:${fake.port}`)
  assert.equal(req.headers.origin, undefined)
  assert.ok(r.out.includes(JOB1) && r.out.includes(JOB2))
  assert.match(r.out, /paused/i)
  assert.match(r.out, /queued/i)

  const plain = await run(['refresh', '--root', R1], home, fake.port)
  assert.equal(plain.code, 0, plain.err)
  assert.deepEqual(fake.requests[1]!.json, { rootId: R1 }, 'includeOlder is not sent unless asked for')
  assert.deepEqual(tree(home), [])
})

test('refresh maps every refusal to a fixed corrective message (exit 69) and never echoes server text', async () => {
  const leak = '/home/leak/secret \u001b[31mtext'
  const table: Array<[number, string, RegExp]> = [
    [404, 'root-not-found', /no registered root.*status/is],
    [409, 'root-inactive', /inactive/],
    [409, 'root-refused', /never scanned/],
    [409, 'direct-only-root', /directly observed/],
    [409, 'root-not-scannable', /Git identity/],
    [400, 'invalid-body', /rejected/],
  ]
  for (const [status, code, message] of table) {
    const fake = await startFake(() => ({ status, json: { error: { code, message: leak } } }))
    const r = await run(['refresh', '--root', R1], makeHome(), fake.port)
    assert.equal(r.code, 69, code)
    assert.equal(r.out, '', code)
    assert.match(r.err, message, code)
    assert.ok(!r.err.includes('/home/leak') && !r.err.includes('\u001b'), `${code}: raw server text is not echoed`)
  }
  const unknown = await startFake(() => ({ status: 409, json: { error: { code: 'brand-new-code', message: leak } } }))
  const r = await run(['refresh', '--root', R1], makeHome(), unknown.port)
  assert.equal(r.code, 69)
  assert.match(r.err, /HTTP 409/)
  assert.ok(!r.err.includes('brand-new-code') && !r.err.includes('/home/leak'))
  const bad = await startFake(() => ({ status: 202, json: { jobId: 5, paused: 'x' } }))
  const badRun = await run(['refresh', '--root', R1], makeHome(), bad.port)
  assert.equal(badRun.code, 69, 'a 202 without the documented fields is not a success')
  assert.match(badRun.err, /does not understand/)
  for (const status of [200, 201, 204, 302]) {
    const other = await startFake(() => ({ status, json: { jobId: JOB1, historyJobId: null, paused: false } }))
    const r2 = await run(['refresh', '--root', R1], makeHome(), other.port)
    assert.equal(r2.code, 69, `only 202 queues a refresh (HTTP ${status})`)
    assert.equal(r2.out, '')
    assert.match(r2.err, /does not understand/, `HTTP ${status}`)
  }
})

// ----------------------------------------------------------------------------------------------------------------- register-output

function rootsReply(req: Recorded, over: Record<string, unknown> = {}, status = 201): Reply {
  const body = req.json as { path: string; repo?: string; repositoryId?: string }
  return {
    status,
    json: {
      root: { rootId: R2, kind: 'output', path: body.path, protected: false, active: true, scopeFlags: ['cli-output'], repositoryId: body.repositoryId ?? null, projectName: null, state: 'idle', ...over },
      jobId: JOB1,
    },
  }
}

test('register-output posts the path (and repo only when given), prints new vs already-registered, and hides a protected root', async () => {
  const home = makeHome()
  const fake = await startFake((req, n) => (req.method === 'POST' && req.path === '/api/artifact-manager/roots' ? rootsReply(req, {}, n === 2 ? 200 : 201) : undefined))
  const created = await run(['register-output', '--path', '/work/out'], home, fake.port)
  assert.equal(created.code, 0, created.err)
  assert.deepEqual(fake.requests[0]!.json, { path: '/work/out' })
  assert.match(created.out, /registered/i)
  assert.ok(created.out.includes(R2) && created.out.includes(JOB1) && created.out.includes('/work/out'))
  assert.match(created.out, /not protected/i)

  const again = await run(['register-output', '--path', '/work/out', '--repo', '/work/proj'], home, fake.port)
  assert.equal(again.code, 0, again.err)
  assert.deepEqual(fake.requests[1]!.json, { path: '/work/out', repo: '/work/proj' })
  assert.match(again.out, /already registered/i)

  const hidden = await startFake(req => rootsReply(req, { protected: true, projectName: 'clinic' }))
  const phi = await run(['register-output', '--path', '/work/PHI/out'], home, hidden.port)
  assert.equal(phi.code, 0, phi.err)
  assert.ok(!phi.out.includes('/work/PHI/out') && !phi.out.includes('clinic'), 'a protected root prints no path or project name')
  assert.match(phi.out, /Protected location \(hidden\)/)
  assert.match(phi.out, /protected/i)
  assert.ok(phi.out.includes(R2))
  assert.deepEqual(tree(home), [])
})

test('register-output maps the route refusals to fixed messages (exit 69) and never echoes server text', async () => {
  const leak = '/home/leak/secret'
  const table: Array<[number, string, RegExp]> = [
    [400, 'invalid-body', /--path or --repo/],
    [400, 'root-relative', /absolute/],
    [403, 'root-outside-home', /inside your home directory/],
    [403, 'root-symlink-escape', /symbolic link/],
    [403, 'root-refused', /cost-ledger/],
    [409, 'root-missing', /does not exist/],
    [409, 'root-not-directory', /not a folder/],
    [409, 'repository-not-registered', /registered checkout/],
    [409, 'root-conflict', /already registered/],
  ]
  for (const [status, code, message] of table) {
    const fake = await startFake(() => ({ status, json: { error: { code, message: leak } } }))
    const r = await run(['register-output', '--path', '/work/out'], makeHome(), fake.port)
    assert.equal(r.code, 69, code)
    assert.equal(r.out, '', code)
    assert.match(r.err, message, code)
    assert.ok(!r.err.includes(leak), `${code}: raw server text is not echoed`)
  }
  const good = { rootId: R2, kind: 'output', path: '/work/out', protected: false, repositoryId: null }
  const broken: Array<[string, unknown]> = [
    ['a numeric root ID', { root: { ...good, rootId: 7 }, jobId: JOB1 }],
    ['no kind', { root: { ...good, kind: undefined }, jobId: JOB1 }],
    ['no path', { root: { ...good, path: undefined }, jobId: JOB1 }],
    ['a protected flag that is not a boolean', { root: { ...good, protected: 'no' }, jobId: JOB1 }],
    ['a repository ID that is not text', { root: { ...good, repositoryId: 5 }, jobId: JOB1 }],
    ['no repository ID', { root: { ...good, repositoryId: undefined }, jobId: JOB1 }],
    ['a job ID that is not text', { root: good, jobId: 5 }],
    ['no job ID', { root: good }],
    ['no root', { jobId: JOB1 }],
  ]
  for (const [label, body] of broken) {
    const bad = await startFake(() => ({ status: 201, json: body }))
    const r = await run(['register-output', '--path', '/work/out'], makeHome(), bad.port)
    assert.equal(r.code, 69, label)
    assert.equal(r.out, '', label)
    assert.match(r.err, /does not understand/, label)
  }
  const fine = await startFake(() => ({ status: 201, json: { root: good, jobId: null } }))
  assert.equal((await run(['register-output', '--path', '/work/out'], makeHome(), fine.port)).code, 0, 'a null job ID is allowed')
  for (const status of [202, 204, 302]) {
    const odd = await startFake(req => rootsReply(req, {}, status))
    const r = await run(['register-output', '--path', '/work/out'], makeHome(), odd.port)
    assert.equal(r.code, 69, `only 200 and 201 are successes (HTTP ${status})`)
    assert.match(r.err, /does not understand/, `HTTP ${status}`)
  }
})

// ----------------------------------------------------------------------------------------------------------------- output-dir

type OutFx = { home: string; work: string; repo: string; fake: Fake; dir: string; base: string }

/** A registered checkout (status lists it) and a roots endpoint that answers 201 first, then 200. */
async function outFixture(over: { home?: string; repoId?: unknown; extraRoots?: Array<Record<string, unknown>>; roots?: (repo: string) => Array<Record<string, unknown>> } = {}): Promise<OutFx> {
  const home = over.home ?? makeHome()
  const work = makeWork()
  const repo = makeRepo(work)
  const repoId = over.repoId === undefined ? REPO_ID : over.repoId
  let posts = 0
  const fake = await startFake(req => {
    if (req.method === 'GET' && req.path === '/api/artifact-manager/status') {
      return { json: statusBody(over.roots ? over.roots(repo) : [statusRoot({ rootId: R1, kind: 'checkout', path: repo, projectName: 'proj', repositoryId: repoId }), ...(over.extraRoots ?? [])]) }
    }
    if (req.method === 'POST' && req.path === '/api/artifact-manager/roots') return rootsReply(req, {}, ++posts === 1 ? 201 : 200)
    return undefined
  })
  const base = join(home, '.claude', 'artifact-output')
  return { home, work, repo, fake, base, dir: join(base, REPO_ID, 'deliverables') }
}

const posts = (fake: Fake): Recorded[] => fake.requests.filter(r => r.method === 'POST')
const modeOf = (path: string): number => lstatSync(path).mode & 0o777

test('output-dir without --create prints the durable path only, asks the service for the repository ID, and creates nothing', async () => {
  const fx = await outFixture()
  const r = await run(['output-dir', '--repo', fx.repo], fx.home, fx.fake.port)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, `${fx.dir}\n`, 'the path is the only line on stdout')
  assert.match(r.err, /does not exist yet/)
  assert.match(r.err, /it is not registered as an output root/)
  assert.deepEqual(tree(fx.home), [], 'nothing is created without --create')
  assert.equal(posts(fx.fake).length, 0, 'nothing is registered without --create')
  assert.equal(fx.fake.requests[0]!.path, '/api/artifact-manager/status')
  assert.equal(fx.fake.requests[0]!.query.get('sensitive'), 'show', 'a checkout under a protected folder must still match')

  // A folder inside the checkout resolves to the checkout, and an upper-case ID from the service is normalized like the server does.
  const sub = await outFixture({ repoId: REPO_ID.toUpperCase() })
  mkdirSync(join(sub.repo, 'docs'))
  const inner = await run(['output-dir', '--repo', join(sub.repo, 'docs')], sub.home, sub.fake.port)
  assert.equal(inner.code, 0, inner.err)
  assert.equal(inner.out, `${sub.dir}\n`)
})

/** The durable directories, pre-made private. */
function precreate(fx: OutFx): void {
  mkdirSync(join(fx.base, REPO_ID), { recursive: true })
  chmodSync(join(fx.base, REPO_ID), 0o700)
  mkdirSync(fx.dir)
  chmodSync(fx.dir, 0o700)
}

test('output-dir reports a describable state for an existing private directory and refuses an existing unsafe one without --create too', async () => {
  const fx = await outFixture()
  precreate(fx)
  const ok = await run(['output-dir', '--repo', fx.repo], fx.home, fx.fake.port)
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.out, `${fx.dir}\n`)
  assert.match(ok.err, /exists/)
  assert.match(ok.err, /private/)
  chmodSync(fx.dir, 0o755)
  const loose = await run(['output-dir', '--repo', fx.repo], fx.home, fx.fake.port)
  assert.equal(loose.code, 65)
  assert.equal(loose.out, '', 'no usable path is printed for an unsafe directory')
  assert.equal(modeOf(fx.dir), 0o755, 'never chmods')
})

test('output-dir without --create says whether the durable directory is already registered as an output root', async () => {
  const home = makeHome()
  const dir = join(home, '.claude', 'artifact-output', REPO_ID, 'deliverables')
  const fx = await outFixture({ home, extraRoots: [statusRoot({ rootId: R2, kind: 'output', path: dir, repositoryId: REPO_ID })] })
  const r = await run(['output-dir', '--repo', fx.repo], home, fx.fake.port)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, `${dir}\n`)
  assert.match(r.err, /it is registered as an output root/)
  assert.doesNotMatch(r.err, /not registered/)
})

test('output-dir refuses a repository the service has not registered, or that is not a checkout, with exit 65 and no path', async () => {
  const fx = await outFixture({ roots: () => [] })
  const notRegistered = await run(['output-dir', '--repo', fx.repo], fx.home, fx.fake.port)
  assert.equal(notRegistered.code, 65)
  assert.equal(notRegistered.out, '')
  assert.match(notRegistered.err, /not registered/i)
  assert.ok(!notRegistered.err.includes(fx.home) && !notRegistered.err.includes('artifact-output'), 'nothing path-like to use')
  assert.deepEqual(tree(fx.home), [])
  assert.equal((await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)).code, 65)
  assert.deepEqual(tree(fx.home), [])
  assert.equal(posts(fx.fake).length, 0)

  // A same-path root of another kind, a checkout without a repository, and two repositories at one path are not an identity.
  const variants: Array<[string, (repo: string) => Array<Record<string, unknown>>]> = [
    ['a root of another kind at the path', repo => [statusRoot({ kind: 'output', path: repo, repositoryId: REPO_ID })]],
    ['a checkout without a repository', repo => [statusRoot({ kind: 'checkout', path: repo, repositoryId: null })]],
    ['a checkout at another path', repo => [statusRoot({ kind: 'checkout', path: join(repo, 'elsewhere'), repositoryId: REPO_ID })]],
    ['two repositories claiming one path', repo => [statusRoot({ rootId: R1, kind: 'checkout', path: repo, repositoryId: REPO_ID }), statusRoot({ rootId: R2, kind: 'checkout', path: repo, repositoryId: R3 })]],
  ]
  for (const [label, roots] of variants) {
    const other = await outFixture({ roots })
    const r = await run(['output-dir', '--repo', other.repo, '--create'], other.home, other.fake.port)
    assert.equal(r.code, 65, label)
    assert.equal(r.out, '', label)
    assert.deepEqual(tree(other.home), [], label)
  }
  const plain = makeWork()
  mkdirSync(join(plain, 'not-git'))
  const notGit = await run(['output-dir', '--repo', join(plain, 'not-git')], fx.home, fx.fake.port)
  assert.equal(notGit.code, 65)
  assert.equal(notGit.out, '')
  assert.match(notGit.err, /not inside a Git checkout/i)
  const missing = await run(['output-dir', '--repo', join(plain, 'missing')], fx.home, fx.fake.port)
  assert.equal(missing.code, 65)
})

test('output-dir --create makes every component 0700, registers the root by repository ID, and is idempotent without overwriting', async () => {
  const fx = await outFixture()
  const oldMask = process.umask(0)
  try {
    const first = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
    assert.equal(first.code, 0, first.err)
    assert.equal(first.out, `${fx.dir}\n`)
    for (const dir of [join(fx.home, '.claude'), fx.base, join(fx.base, REPO_ID), fx.dir]) {
      assert.equal(lstatSync(dir).isDirectory(), true, dir)
      assert.equal(modeOf(dir), 0o700, `${dir} is private`)
      assert.equal(lstatSync(dir).uid, process.getuid!())
    }
    assert.deepEqual(tree(fx.home), ['.claude', '.claude/artifact-output', `.claude/artifact-output/${REPO_ID}`, `.claude/artifact-output/${REPO_ID}/deliverables`])
    assert.equal(posts(fx.fake).length, 1)
    assert.deepEqual(posts(fx.fake)[0]!.json, { path: fx.dir, repositoryId: REPO_ID }, 'registered by repository ID, with the canonical path, not by repo')
    assert.match(first.err, /registered/i)

    // The user's file in the directory survives the second run, untouched.
    const keep = join(fx.dir, 'keep.md')
    writeFileSync(keep, 'precious\n')
    const before = statSync(keep)
    const second = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
    assert.equal(second.code, 0, second.err)
    assert.equal(second.out, first.out, 'the same path both times')
    assert.match(second.err, /already registered/i)
    assert.equal(posts(fx.fake).length, 2)
    assert.equal(readFileSync(keep, 'utf8'), 'precious\n')
    assert.equal(statSync(keep).ino, before.ino)
    assert.equal(statSync(keep).mtimeMs, before.mtimeMs)
    assert.deepEqual(readdirSync(fx.dir), ['keep.md'])
  } finally {
    process.umask(oldMask)
  }
})

test('output-dir --create reuses existing private directories without chmod and tolerates a group-readable base', async () => {
  const fx = await outFixture()
  mkdirSync(join(fx.base, REPO_ID, 'deliverables'), { recursive: true })
  chmodSync(join(fx.base, REPO_ID, 'deliverables'), 0o700)
  chmodSync(join(fx.base, REPO_ID), 0o700)
  chmodSync(fx.base, 0o755)
  const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
  assert.equal(r.code, 0, r.err)
  assert.equal(modeOf(fx.base), 0o755, 'an existing base is not chmod-ed')
  assert.equal(posts(fx.fake).length, 1)

  const writable = await outFixture()
  mkdirSync(writable.base, { recursive: true })
  chmodSync(writable.base, 0o777)
  const bad = await run(['output-dir', '--repo', writable.repo, '--create'], writable.home, writable.fake.port)
  assert.equal(bad.code, 65, 'a world-writable base can have its entries replaced by others')
  assert.equal(modeOf(writable.base), 0o777)
  assert.equal(posts(writable.fake).length, 0)
  assert.deepEqual(readdirSync(writable.base), [])

  // A group-writable base is just as open: its entries can be replaced by the group.
  const group = await outFixture()
  mkdirSync(group.base, { recursive: true })
  chmodSync(group.base, 0o775)
  const g = await run(['output-dir', '--repo', group.repo, '--create'], group.home, group.fake.port)
  assert.equal(g.code, 65)
  assert.equal(g.out, '')
  assert.equal(modeOf(group.base), 0o775, 'never chmod')
  assert.equal(posts(group.fake).length, 0)
  assert.deepEqual(readdirSync(group.base), [])
})

test('output-dir --create refuses a directory a restrictive umask left short of 0700, and registers nothing', async () => {
  const fx = await outFixture()
  const oldMask = process.umask(0o277)
  try {
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
    assert.equal(r.code, 65, r.err)
    assert.equal(r.out, '')
    assert.match(r.err, /not private/)
    assert.equal(posts(fx.fake).length, 0)
  } finally {
    process.umask(oldMask)
    // The test's own temporary directory: make it removable again.
    try { chmodSync(join(fx.home, '.claude'), 0o700) } catch { /* not created */ }
  }
})

test('output-dir --create refuses existing group/other-accessible, symlinked, non-directory or foreign-owned components and changes nothing', async () => {
  // deliverables / repository directory with group or other bits
  for (const target of ['deliverables', 'repo-dir'] as const) {
    const fx = await outFixture()
    precreate(fx)
    const loose = target === 'deliverables' ? fx.dir : join(fx.base, REPO_ID)
    chmodSync(loose, 0o750)
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
    assert.equal(r.code, 65, target)
    assert.equal(r.out, '')
    assert.match(r.err, /private|permission/i)
    assert.equal(modeOf(loose), 0o750, `${target}: never chmod an existing directory`)
    assert.equal(posts(fx.fake).length, 0, target)
  }
  // a symlink in place of deliverables, or of the repository directory
  for (const target of ['deliverables', 'repo-dir'] as const) {
    const fx = await outFixture()
    const elsewhere = join(fx.work, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    mkdirSync(join(fx.base, REPO_ID), { recursive: true })
    chmodSync(join(fx.base, REPO_ID), 0o700)
    if (target === 'deliverables') symlinkSync(elsewhere, fx.dir)
    else {
      rmSync(join(fx.base, REPO_ID), { recursive: true })
      symlinkSync(elsewhere, join(fx.base, REPO_ID))
    }
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
    assert.equal(r.code, 65, target)
    assert.equal(r.out, '')
    assert.match(r.err, /symbolic link/i)
    assert.deepEqual(readdirSync(elsewhere), [], `${target}: nothing is created through the link`)
    assert.equal(lstatSync(target === 'deliverables' ? fx.dir : join(fx.base, REPO_ID)).isSymbolicLink(), true, 'the link is left as it was')
    assert.equal(posts(fx.fake).length, 0)
    const dry = await run(['output-dir', '--repo', fx.repo], fx.home, fx.fake.port)
    assert.equal(dry.code, 65, `${target}: also without --create`)
    assert.equal(dry.out, '')
  }
  // a file where the directory should be
  const file = await outFixture()
  mkdirSync(join(file.base, REPO_ID), { recursive: true })
  chmodSync(join(file.base, REPO_ID), 0o700)
  writeFileSync(file.dir, 'x')
  const f = await run(['output-dir', '--repo', file.repo, '--create'], file.home, file.fake.port)
  assert.equal(f.code, 65)
  assert.match(f.err, /not a directory/i)
  assert.equal(readFileSync(file.dir, 'utf8'), 'x')
  // owned by someone else
  const foreign = await outFixture()
  precreate(foreign)
  const other = await run(['output-dir', '--repo', foreign.repo, '--create'], foreign.home, foreign.fake.port, { uid: process.getuid!() + 1 })
  assert.equal(other.code, 65)
  assert.match(other.err, /owned by/i)
  assert.equal(posts(foreign.fake).length, 0)
})

function writeConfig(atlasDir: string, config: unknown): void {
  mkdirSync(atlasDir, { recursive: true })
  writeFileSync(join(atlasDir, 'config.json'), JSON.stringify(config))
}

test('output-dir applies the service\'s own location policy before it prints or creates anything', async () => {
  // Each base is one the service would refuse to register: outside HOME, inside the Atlas data, spool or cost-ledger folders.
  type Case = [string, RegExp, (fx: OutFx) => { base: string; atlasHome?: string }]
  const home = /inside your home directory/
  const data = /overlaps the Atlas data, spool or cost-ledger folders/
  const cases: Case[] = [
    ['a base outside the home directory', home, fx => ({ base: join(fx.work, 'elsewhere', 'base') })],
    ['a base inside the Atlas runtime directory', home, fx => ({ base: join(fx.home, '.josh-360', 'atlas', 'exports') })],
    ['a base inside a moved Atlas data directory', data, fx => ({ base: join(fx.home, 'atlas-data', 'exports'), atlasHome: join(fx.home, 'atlas-data') })],
    ['a base inside the spool directory', data, fx => ({ base: join(fx.home, 'atlas-data', 'spool', 'exports'), atlasHome: join(fx.home, 'atlas-data') })],
    // The path policy refuses ~/.claude/cost-ledger as a runtime folder (I2) before the data-folder check is reached; the ledger
    // cannot be moved (its path is fixed under ~/.claude), so the second layer's cost-ledger wording is no longer reachable here.
    ['a base inside the cost-ledger directory', home, fx => ({ base: join(fx.home, '.claude', 'cost-ledger', 'exports') })],
    ['a base that is the Atlas data directory itself', data, fx => ({ base: join(fx.home, 'atlas-data'), atlasHome: join(fx.home, 'atlas-data') })],
    ['a base under a secrets directory', home, fx => ({ base: join(fx.home, '.ssh', 'exports') })],
  ]
  for (const [label, message, make] of cases) {
    const fx = await outFixture()
    const { base, atlasHome } = make(fx)
    writeConfig(atlasHome ?? join(fx.home, '.josh-360', 'atlas'), { artifacts: { durableOutputBase: base } })
    const env: Record<string, string> = atlasHome ? { ATLAS_HOME: atlasHome } : {}
    const before = tree(fx.home)
    const outsideBefore = existsSync(join(fx.work, 'elsewhere'))
    for (const args of [['output-dir', '--repo', fx.repo], ['output-dir', '--repo', fx.repo, '--create']]) {
      const r = await run(args, fx.home, fx.fake.port, {}, env)
      assert.equal(r.code, 65, `${label}: ${args.join(' ')}: ${r.out}${r.err}`)
      assert.equal(r.out, '', `${label}: no path is printed`)
      assert.match(r.err, /would not be registered/, label)
      assert.match(r.err, message, label)
    }
    assert.deepEqual(tree(fx.home), before, `${label}: nothing was created`)
    assert.equal(existsSync(join(fx.work, 'elsewhere')), outsideBefore, `${label}: nothing was created outside the home`)
    assert.equal(posts(fx.fake).length, 0, label)
  }
})

test('output-dir never falls back to the root directory when HOME is not set', async () => {
  const rootClaudeBefore = existsSync('/.claude/artifact-output')
  const fx = await outFixture()
  const atlasHome = join(fx.work, 'atlas')
  const base = join(fx.work, 'base')
  // A configured base elsewhere (HOME unset makes the home "/"): refused before anything is created.
  writeConfig(atlasHome, { artifacts: { durableOutputBase: base } })
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ATLAS_PORT: String(fx.fake.port), ATLAS_HOME: atlasHome }
  for (const args of [['output-dir', '--repo', fx.repo], ['output-dir', '--repo', fx.repo, '--create']]) {
    const r = await run(args, fx.home, fx.fake.port, { env })
    assert.equal(r.code, 65, `${args.join(' ')}: ${r.out}${r.err}`)
    assert.equal(r.out, '')
    assert.match(r.err, /HOME/)
  }
  assert.equal(existsSync(base), false)
  assert.equal(posts(fx.fake).length, 0)
  // An empty or relative HOME is no home either (it would put the base in the current directory).
  for (const odd of ['', 'relative/home']) {
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port, { env: { ...env, HOME: odd } })
    assert.equal(r.code, 65, `HOME=${JSON.stringify(odd)}: ${r.out}${r.err}`)
    assert.equal(r.out, '')
    assert.match(r.err, /HOME/, `HOME=${JSON.stringify(odd)}`)
  }
  assert.equal(existsSync(base), false)
  // The default base would be "/.claude/artifact-output": only the dry run is exercised here, and it prints nothing.
  const noConfig = join(fx.work, 'no-config')
  const dry = await run(['output-dir', '--repo', fx.repo], fx.home, fx.fake.port, { env: { ...env, ATLAS_HOME: noConfig } })
  assert.equal(dry.code, 65, `${dry.out}${dry.err}`)
  assert.equal(dry.out, '')
  assert.match(dry.err, /HOME/)
  assert.equal(existsSync('/.claude/artifact-output'), rootClaudeBefore)
})

test('output-dir checks control characters on the resolved base, not only on the configured text', async () => {
  const fx = await outFixture()
  const odd = join(fx.home, 'data\nline')
  mkdirSync(odd, { mode: 0o700 })
  mkdirSync(join(fx.home, '.claude'))
  symlinkSync(odd, fx.base)
  for (const args of [['output-dir', '--repo', fx.repo], ['output-dir', '--repo', fx.repo, '--create']]) {
    const r = await run(args, fx.home, fx.fake.port)
    assert.equal(r.code, 65, `${args.join(' ')}: ${r.out}${r.err}`)
    assert.equal(r.out, '', 'a path with a newline never reaches stdout')
    assert.match(r.err, /control characters/)
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(r.err), 'and not stderr either')
  }
  assert.deepEqual(readdirSync(odd), [], 'nothing was created through the link')
  assert.equal(posts(fx.fake).length, 0)
})

test('output-dir refuses a durable path inside the checkout, through a configured base or a symlinked base, before creating anything', async () => {
  // configured base inside the checkout
  const cfg = await outFixture()
  mkdirSync(join(cfg.home, '.josh-360', 'atlas'), { recursive: true })
  writeFileSync(join(cfg.home, '.josh-360', 'atlas', 'config.json'), JSON.stringify({ artifacts: { durableOutputBase: join(cfg.repo, 'out') } }))
  const before = tree(cfg.home)
  for (const args of [['output-dir', '--repo', cfg.repo], ['output-dir', '--repo', cfg.repo, '--create']]) {
    const r = await run(args, cfg.home, cfg.fake.port)
    assert.equal(r.code, 65, args.join(' '))
    assert.equal(r.out, '')
    assert.match(r.err, /inside the checkout/i)
  }
  assert.deepEqual(readdirSync(cfg.repo).sort(), ['.git', 'README.md'], 'nothing created in the checkout')
  assert.deepEqual(tree(cfg.home), before)
  assert.equal(posts(cfg.fake).length, 0)

  // the default base is a symlink into the checkout
  const link = await outFixture()
  mkdirSync(join(link.repo, 'outputs'), { mode: 0o700 })
  mkdirSync(join(link.home, '.claude'))
  symlinkSync(join(link.repo, 'outputs'), link.base)
  const r = await run(['output-dir', '--repo', link.repo, '--create'], link.home, link.fake.port)
  assert.equal(r.code, 65)
  assert.equal(r.out, '')
  assert.match(r.err, /inside the checkout/i)
  assert.deepEqual(readdirSync(join(link.repo, 'outputs')), [], 'nothing created through the symlinked base')
  assert.equal(posts(link.fake).length, 0)

  // a base through a symlink to somewhere harmless is fine: the canonical path is printed and registered
  const fine = await outFixture()
  const data = join(fine.home, 'data')
  mkdirSync(data, { mode: 0o700 })
  mkdirSync(join(fine.home, '.claude'))
  symlinkSync(data, fine.base)
  const ok = await run(['output-dir', '--repo', fine.repo, '--create'], fine.home, fine.fake.port)
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.out, `${join(data, REPO_ID, 'deliverables')}\n`)
  assert.deepEqual(posts(fine.fake)[0]!.json, { path: join(data, REPO_ID, 'deliverables'), repositoryId: REPO_ID })
  assert.equal(modeOf(join(data, REPO_ID, 'deliverables')), 0o700)

  // inside ANOTHER registered checkout is refused too (the export route requires a path outside every checkout)
  const otherWork = makeWork()
  const second = makeRepo(otherWork, 'second')
  const many = await outFixture({ extraRoots: [statusRoot({ rootId: R2, kind: 'checkout', path: second, repositoryId: R3 })] })
  mkdirSync(join(many.home, '.josh-360', 'atlas'), { recursive: true })
  writeFileSync(join(many.home, '.josh-360', 'atlas', 'config.json'), JSON.stringify({ artifacts: { durableOutputBase: join(second, 'out') } }))
  const nested = await run(['output-dir', '--repo', many.repo, '--create'], many.home, many.fake.port)
  assert.equal(nested.code, 65)
  assert.deepEqual(readdirSync(second).sort(), ['.git', 'README.md'])
})

test('output-dir refuses a durable directory that would contain a registered checkout, and one under a home with control characters', async () => {
  const home = makeHome()
  const nested = join(home, '.claude', 'artifact-output', REPO_ID, 'deliverables', 'clone')
  const fx = await outFixture({ home, extraRoots: [statusRoot({ rootId: R2, kind: 'checkout', path: nested, repositoryId: R3 })] })
  for (const args of [['output-dir', '--repo', fx.repo], ['output-dir', '--repo', fx.repo, '--create']]) {
    const r = await run(args, home, fx.fake.port)
    assert.equal(r.code, 65, args.join(' '))
    assert.equal(r.out, '')
    assert.match(r.err, /inside another registered checkout/)
  }
  assert.deepEqual(tree(home), [])
  assert.equal(posts(fx.fake).length, 0)

  // A home with a newline in it would make the printed path a lie on stdout: refused, nothing created.
  const odd = await outFixture()
  const weirdHome = `${odd.home}/x\ny`
  for (const args of [['output-dir', '--repo', odd.repo], ['output-dir', '--repo', odd.repo, '--create']]) {
    const r = await run(args, weirdHome, odd.fake.port)
    assert.equal(r.code, 65, args.join(' '))
    assert.equal(r.out, '')
    assert.match(r.err, /control characters/)
  }
  assert.deepEqual(tree(odd.home), [])
})

test('output-dir --create refuses a path through a regular file before creating anything, and leaves the file', async () => {
  const fx = await outFixture()
  writeFileSync(join(fx.home, '.claude'), 'a file where the Claude directory should be\n')
  const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
  assert.equal(r.code, 65)
  assert.equal(r.out, '')
  assert.match(r.err, /a part of its path is not a folder/)
  assert.equal(readFileSync(join(fx.home, '.claude'), 'utf8'), 'a file where the Claude directory should be\n')
  assert.equal(posts(fx.fake).length, 0)
})

test('output-dir --create re-verifies after creating: a swapped component or ancestor is refused and never registered', async () => {
  // Three ways the tree can change between the creation and the registration. Each is caught by its own check.
  const swaps: Array<[string, (fx: OutFx, dir: string, elsewhere: string) => void]> = [
    ['deliverables replaced by a symbolic link', (_fx, dir, elsewhere) => { rmSync(dir, { recursive: true }); symlinkSync(elsewhere, dir) }],
    ['deliverables replaced by a directory open to others', (_fx, dir) => { rmSync(dir, { recursive: true }); mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755) }],
    ['the Claude directory replaced by a link to its moved copy', fx => {
      renameSync(join(fx.home, '.claude'), join(fx.home, '.claude-moved'))
      symlinkSync(join(fx.home, '.claude-moved'), join(fx.home, '.claude'))
    }],
  ]
  for (const [label, swap] of swaps) {
    const fx = await outFixture()
    const elsewhere = join(fx.work, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port, { hooks: { afterCreate: dir => swap(fx, dir, elsewhere) } })
    assert.equal(r.code, 65, label)
    assert.equal(r.out, '', label)
    assert.equal(posts(fx.fake).length, 0, label)
    assert.deepEqual(readdirSync(elsewhere), [], label)
  }
})

test('output-dir never builds a path from an unusable repository ID or trusts a mismatched registration answer', async () => {
  for (const bad of ['../../etc', `${REPO_ID}/..`, '', 'a'.repeat(200), 5]) {
    const fx = await outFixture({ repoId: bad })
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
    // An absent or null identity is "not registered" (65); a present but malformed one is a service fault (69).
    assert.equal(r.code, 69, JSON.stringify(bad))
    assert.equal(r.out, '')
    assert.deepEqual(tree(fx.home), [], 'no directory is created for it')
    assert.equal(posts(fx.fake).length, 0)
  }
  const traversal = await outFixture({ repoId: '../../etc' })
  assert.equal((await run(['output-dir', '--repo', traversal.repo], traversal.home, traversal.fake.port)).code, 69)

  for (const [label, over] of [['another path', { path: '/elsewhere/deliverables' }], ['another repository', { repositoryId: R3 }], ['another kind', { kind: 'checkout' }]] as Array<[string, Record<string, unknown>]>) {
    const fx = await outFixture()
    const wrong = await startFake(req => {
      if (req.method === 'GET') return { json: statusBody([statusRoot({ rootId: R1, kind: 'checkout', path: fx.repo, repositoryId: REPO_ID })]) }
      return rootsReply(req, over)
    })
    const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, wrong.port)
    assert.equal(r.code, 69, label)
    assert.equal(r.out, '', label)
  }
})

test('output-dir --create that loses the service while registering is exit 69 with the created-but-not-registered note, and no path on stdout', async () => {
  const fx = await outFixture()
  const flaky = await startFake(req => (req.method === 'GET'
    ? { json: statusBody([statusRoot({ rootId: R1, kind: 'checkout', path: fx.repo, repositoryId: REPO_ID })]) } : { drop: true }))
  const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, flaky.port)
  assert.equal(r.code, 69)
  assert.equal(r.out, '')
  assert.match(r.err, /not reachable/)
  assert.match(r.err, /created \(mode 0700\) but not registered/)
  assert.equal(modeOf(fx.dir), 0o700)
  // Run again against a healthy service: the directory is reused and registered.
  const again = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, fx.fake.port)
  assert.equal(again.code, 0, again.err)
  assert.equal(again.out, `${fx.dir}\n`)
  assert.match(again.err, /the directory already existed/)
})

test('output-dir --create maps a refused registration to a fixed message (exit 69) and leaves what it created, without a path on stdout', async () => {
  const fx = await outFixture()
  const refusing = await startFake(req => {
    if (req.method === 'GET') return { json: statusBody([statusRoot({ rootId: R1, kind: 'checkout', path: fx.repo, repositoryId: REPO_ID })]) }
    return { status: 403, json: { error: { code: 'root-outside-home', message: '/home/leak' } } }
  })
  const r = await run(['output-dir', '--repo', fx.repo, '--create'], fx.home, refusing.port)
  assert.equal(r.code, 69)
  assert.equal(r.out, '')
  assert.match(r.err, /inside your home directory/)
  assert.match(r.err, /created/i)
  assert.ok(!r.err.includes('/home/leak'))
  assert.equal(modeOf(fx.dir), 0o700)
})

// ----------------------------------------------------------------------------------------------------------------- check-removal: arguments, exit codes, output

test('check-removal hands the checker the configured catalog path, the caller directory and a session probe, and nothing else', async () => {
  const home = makeHome()
  const stub = stubChecker(cleanResult())
  const r = await run(['check-removal', '--worktree', '/work/wt'], home, 1, { checkWorktreeRemoval: stub.fn })
  assert.equal(r.code, 0, r.err)
  assert.equal(stub.seen.length, 1)
  const { target, options } = stub.seen[0]!
  assert.equal(target, '/work/wt')
  assert.equal(options.catalogPath, join(home, '.josh-360', 'state', 'cache.db'))
  assert.equal(typeof options.probeSessionActivity, 'function')
  assert.equal(options.callerCwd, process.cwd())
  assert.equal('timeoutMs' in options, false, 'the checker default applies unless --timeout-ms is given')
  assert.deepEqual(Object.keys(options).sort(), ['callerCwd', 'catalogPath', 'probeSessionActivity'])
  assert.deepEqual(tree(home), [], 'the catalog is not created by the CLI')

  const timed = await run(['check-removal', '--worktree', '/work/wt', '--timeout-ms', '20000'], home, 1, { checkWorktreeRemoval: stub.fn })
  assert.equal(timed.code, 0, timed.err)
  assert.equal(stub.seen[1]!.options.timeoutMs, 20000)
  const edge = await run(['check-removal', '--worktree', '/work/wt', '--timeout-ms', '1000'], home, 1, { checkWorktreeRemoval: stub.fn })
  assert.equal(edge.code, 0)
  assert.equal(stub.seen[2]!.options.timeoutMs, 1000)
  assert.equal((await run(['check-removal', '--worktree', '/work/wt', '--timeout-ms', '120000'], home, 1, { checkWorktreeRemoval: stub.fn })).code, 0)
  assert.equal(stub.seen[3]!.options.timeoutMs, 120000)
})

test('check-removal trusts INIT_CWD only under npm run artifacts, and passes whichever caller directory is inside the target', async () => {
  const home = makeHome()
  const lifecycle = { npm_lifecycle_event: 'artifacts' }
  const cases: Array<[string, string, Record<string, string>, string]> = [
    ['a stale INIT_CWD inside the target, no npm lifecycle', '/work/wt', { INIT_CWD: '/work/wt/sub' }, process.cwd()],
    ['INIT_CWD inside the target under another npm script', '/work/wt', { INIT_CWD: '/work/wt/sub', npm_lifecycle_event: 'test' }, process.cwd()],
    ['INIT_CWD inside the target under npm exec', '/work/wt', { INIT_CWD: '/work/wt/sub', npm_lifecycle_event: 'npx' }, process.cwd()],
    ['INIT_CWD inside the target under npm run artifacts', '/work/wt', { INIT_CWD: '/work/wt/sub', ...lifecycle }, '/work/wt/sub'],
    ['INIT_CWD equal to the target under npm run artifacts', '/work/wt', { INIT_CWD: '/work/wt', ...lifecycle }, '/work/wt'],
    ['INIT_CWD outside the target under npm run artifacts', '/work/wt', { INIT_CWD: '/home/caller/inside', ...lifecycle }, process.cwd()],
    ['INIT_CWD a prefix sibling of the target under npm run artifacts', '/work/wt', { INIT_CWD: '/work/wt-other', ...lifecycle }, process.cwd()],
    ['a relative INIT_CWD', '/work/wt', { INIT_CWD: 'relative/dir', ...lifecycle }, process.cwd()],
    ['an empty INIT_CWD', '/work/wt', { INIT_CWD: '', ...lifecycle }, process.cwd()],
    ['an INIT_CWD with a newline', '/work/wt', { INIT_CWD: '/work/wt/a\nb', ...lifecycle }, process.cwd()],
    // The process directory is checked as well: when it is inside the target it wins over an outside INIT_CWD.
    ['the process directory inside the target, INIT_CWD outside', process.cwd(), { INIT_CWD: '/home/caller/inside', ...lifecycle }, process.cwd()],
  ]
  // Spellings through links count by their real path, on either side.
  const work = makeWork()
  const real = join(work, 'real')
  mkdirSync(join(real, 'wt', 'sub'), { recursive: true })
  symlinkSync(real, join(work, 'link'))
  cases.push(
    ['INIT_CWD spelled through a link into the target', join(real, 'wt'), { INIT_CWD: join(work, 'link', 'wt', 'sub'), ...lifecycle }, join(work, 'link', 'wt', 'sub')],
    ['the target spelled through a link, INIT_CWD real', join(work, 'link', 'wt'), { INIT_CWD: join(real, 'wt', 'sub'), ...lifecycle }, join(real, 'wt', 'sub')],
    ['INIT_CWD a link to a place outside the target', join(real, 'wt'), { INIT_CWD: join(work, 'link'), ...lifecycle }, process.cwd()],
  )
  for (const [label, worktree, env, expected] of cases) {
    const stub = stubChecker(cleanResult())
    const r = await run(['check-removal', '--worktree', worktree], home, 1, { checkWorktreeRemoval: stub.fn }, env)
    assert.equal(r.code, 0, `${label}: ${r.err}`)
    assert.equal(stub.seen[0]!.options.callerCwd, expected, label)
  }
})

test('check-removal exits with the checker exit code only for a well-formed result: 0, 2 and 3', async () => {
  const home = makeHome()
  const issue = { code: 'unpreserved-working', path: '/work/wt/a.md', detail: 'an uncommitted edit' }
  const unknown = { code: 'session-unknown', path: null, detail: 'no answer' }
  const cases: Array<[number, RemovalCheckResult]> = [
    [0, cleanResult()],
    [2, cleanResult({ exitCode: 2, unknowns: [unknown], coverage: { filesystem: 'complete', git: 'complete', catalog: 'missing', sessions: 'unknown' } })],
    [3, cleanResult({ exitCode: 3, risks: [issue] })],
    [3, cleanResult({ exitCode: 3, risks: [issue], unknowns: [unknown] })],
  ]
  for (const [expected, result] of cases) {
    for (const json of [false, true]) {
      const stub = stubChecker(result)
      const r = await run(['check-removal', '--worktree', '/work/wt', ...(json ? ['--json'] : [])], home, 1, { checkWorktreeRemoval: stub.fn })
      assert.equal(r.code, expected, `${expected} ${json ? 'json' : 'text'}`)
      assert.equal(r.err, '')
      assert.notEqual(r.out, '')
    }
  }
})

test('check-removal never turns a malformed, inconsistent or failed checker answer into 0, 2 or 3', async () => {
  const home = makeHome()
  const issue = { code: 'x', path: null, detail: 'd' }
  const inconsistent: Array<[string, unknown]> = [
    ['an exit code of 1', cleanResult({ exitCode: 1 as 0 })],
    ['an exit code of 4', cleanResult({ exitCode: 4 as 0 })],
    ['a string exit code', cleanResult({ exitCode: '0' as unknown as 0 })],
    ['no exit code', { ...cleanResult(), exitCode: undefined }],
    ['a null result', null],
    ['a string result', 'ok'],
    ['an empty object', {}],
    ['risks that are not a list', { ...cleanResult(), risks: 'none' }],
    ['an issue without a code', cleanResult({ exitCode: 3, risks: [{ path: null, detail: 'd' } as never] })],
    ['an issue with a numeric path', cleanResult({ exitCode: 3, risks: [{ code: 'x', path: 5, detail: 'd' } as never] })],
    ['a missing target', { ...cleanResult(), target: undefined }],
    ['a missing coverage', { ...cleanResult(), coverage: undefined }],
    ['an unknown coverage value', cleanResult({ coverage: { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'maybe' as 'inactive' } })],
    ['an unknown coverage value on a blocking result', cleanResult({ exitCode: 2, unknowns: [issue], coverage: { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'maybe' as 'inactive' } })],
    ['an unknown catalog value on a blocking result', cleanResult({ exitCode: 3, risks: [issue], coverage: { filesystem: 'complete', git: 'complete', catalog: 'absent' as 'complete', sessions: 'inactive' } })],
    ['no coverage field on a blocking result', cleanResult({ exitCode: 2, unknowns: [issue], coverage: { filesystem: 'complete', git: 'complete', sessions: 'inactive' } as never })],
    ['a numeric target on a blocking result', { ...cleanResult({ exitCode: 2, unknowns: [issue] }), target: 5 }],
    ['a missing checkedAt on a blocking result', { ...cleanResult({ exitCode: 2, unknowns: [issue] }), checkedAt: undefined }],
    ['exit 0 with a risk', cleanResult({ risks: [issue] })],
    ['exit 0 with an unknown', cleanResult({ unknowns: [issue] })],
    ['exit 0 with incomplete filesystem coverage', cleanResult({ coverage: { filesystem: 'incomplete', git: 'complete', catalog: 'complete', sessions: 'inactive' } })],
    ['exit 0 with incomplete Git coverage', cleanResult({ coverage: { filesystem: 'complete', git: 'incomplete', catalog: 'complete', sessions: 'inactive' } })],
    ['exit 0 with a missing catalog', cleanResult({ coverage: { filesystem: 'complete', git: 'complete', catalog: 'missing', sessions: 'inactive' } })],
    ['exit 0 with a catalog error', cleanResult({ coverage: { filesystem: 'complete', git: 'complete', catalog: 'error', sessions: 'inactive' } })],
    ['exit 0 with unknown sessions', cleanResult({ coverage: { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'unknown' } })],
    ['exit 0 with active sessions', cleanResult({ coverage: { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'active' } })],
  ]
  for (const [label, result] of inconsistent) {
    for (const json of [false, true]) {
      const stub = stubChecker(result)
      const r = await run(['check-removal', '--worktree', '/work/wt', ...(json ? ['--json'] : [])], home, 1, { checkWorktreeRemoval: stub.fn })
      assert.equal(r.code, 70, `${label}${json ? ' (json)' : ''}: exit ${r.code}`)
      assert.equal(r.out, '', `${label}: no answer is printed`)
      assert.match(r.err, /^error: .*internal/is, label)
    }
  }
  for (const label of ['throws', 'rejects']) {
    const r = await run(['check-removal', '--worktree', '/work/wt'], home, 1, {
      checkWorktreeRemoval: label === 'throws' ? () => { throw new Error('boom /home/leak') } : () => Promise.reject(new Error('boom /home/leak')),
    })
    assert.equal(r.code, 70, label)
    assert.equal(r.out, '')
    assert.match(r.err, /internal error \(Error\)/)
    assert.ok(!r.err.includes('boom') && !r.err.includes('/home/leak'), 'no raw error text')
  }
  // A failure before the checker runs (here: the configuration cannot be read) is internal as well.
  const env: Record<string, string> = {}
  Object.defineProperty(env, 'HOME', { get() { throw new Error('boom') }, enumerable: true })
  const main = await loadMain()
  let out = ''
  let err = ''
  const code = await main(['check-removal', '--worktree', '/work/wt'], { env, stdout: t => { out += t }, stderr: t => { err += t }, checkWorktreeRemoval: stubChecker(cleanResult()).fn })
  assert.equal(code, 70)
  assert.equal(out, '')
  assert.match(err, /internal error/)
})

test('check-removal --json prints one document: the result, the retention note and the next-removal-only marker', async () => {
  const result = cleanResult({ exitCode: 3, risks: [{ code: 'unpreserved-working', path: '/work/wt/a.md', detail: 'an uncommitted edit' }] })
  for (const stubResult of [result, cleanResult()]) {
    const stub = stubChecker(stubResult)
    const r = await run(['check-removal', '--worktree', '/work/wt', '--json'], makeHome(), 1, { checkWorktreeRemoval: stub.fn })
    assert.equal(r.code, stubResult.exitCode)
    assert.equal(r.err, '')
    assert.ok(r.out.endsWith('\n') && !r.out.endsWith('\n\n'))
    const doc = JSON.parse(r.out) as Record<string, unknown>
    assert.deepEqual(Object.keys(doc).sort(), ['remoteRetentionNote', 'result', 'validFor'])
    assert.equal(doc.validFor, 'next-removal-only')
    assert.equal(doc.remoteRetentionNote, REMOVAL_CHECK_REMOTE_RETENTION_NOTE)
    assert.deepEqual(doc.result, stubResult)
  }
})

test('the human report names the exit meaning, lists risks and unknowns with codes, and always carries the notes', async () => {
  const issue = { code: 'unpreserved-working', path: '/work/wt/a.md', detail: 'an uncommitted edit with no verified copy' }
  const unknown = { code: 'catalog-missing', path: null, detail: 'the Atlas catalog does not exist' }
  const cases: Array<[number, RemovalCheckResult, RegExp]> = [
    [0, cleanResult(), /^Exit 0: a complete check found nothing at risk/m],
    [2, cleanResult({ exitCode: 2, unknowns: [unknown], coverage: { filesystem: 'complete', git: 'complete', catalog: 'missing', sessions: 'unknown' } }), /^Exit 2: the check is incomplete.*blocks automated removal/m],
    [3, cleanResult({ exitCode: 3, risks: [issue], unknowns: [unknown] }), /^Exit 3: risks were found.*blocks automated removal/m],
  ]
  for (const [exit, result, meaning] of cases) {
    const r = await run(['check-removal', '--worktree', '/work/wt'], makeHome(), 1, { checkWorktreeRemoval: stubChecker(result).fn })
    assert.equal(r.code, exit)
    assert.match(r.out, meaning)
    assert.ok(r.out.includes(result.target) && r.out.includes(result.checkedAt))
    assert.ok(r.out.includes(REMOVAL_CHECK_REMOTE_RETENTION_NOTE), `exit ${exit}: the remote-retention note is always printed`)
    assert.match(r.out, /NEXT single removal only/)
    assert.match(r.out, /never reuse|do not reuse/i)
    assert.match(r.out, /filesystem=\w+.*git=\w+.*catalog=\w+.*sessions=\w+/s)
    // What is not protected, taken from the checker's own list.
    assert.ok(r.out.includes(FIXED_DISCOVERY_SEGMENTS.join(', ')))
    assert.match(r.out, /not (?:checked|protected)/i)
    assert.match(r.out, /phi/)
    assert.match(r.out, /\.npmrc/)
    assert.match(r.out, /always exits? 2|always exit 2/i)
    assert.match(r.out, /--timeout-ms/)
    for (const i of [...result.risks, ...result.unknowns]) {
      assert.ok(r.out.includes(`[${i.code}]`), i.code)
      assert.ok(r.out.includes(i.detail), i.detail)
      if (i.path) assert.ok(r.out.includes(i.path), i.path)
    }
    assert.match(r.out, new RegExp(`Risks \\(${result.risks.length}\\)`))
    assert.match(r.out, new RegExp(`Unknowns \\(${result.unknowns.length}\\)`))
    assert.match(r.out, /forced removal|--force/)
    // What would complete an incomplete check.
    const hasHints = r.out.includes('To complete the check:')
    assert.equal(hasHints, result.coverage.sessions === 'unknown' || result.coverage.catalog !== 'complete', `exit ${exit}`)
    if (result.coverage.sessions === 'unknown') assert.match(r.out, /Sessions unknown.*Atlas service/)
    if (result.coverage.catalog === 'missing') assert.match(r.out, /Catalog missing.*creates the catalog/)
  }
  const unreadable = await run(['check-removal', '--worktree', '/work/wt'], makeHome(), 1, {
    checkWorktreeRemoval: stubChecker(cleanResult({ exitCode: 2, unknowns: [unknown], coverage: { filesystem: 'complete', git: 'complete', catalog: 'error', sessions: 'inactive' } })).fn,
  })
  assert.equal(unreadable.code, 2)
  assert.match(unreadable.out, /Catalog unreadable.*read-only open/)
  assert.ok(!unreadable.out.includes('Sessions unknown'))
})

test('every printed path, detail and code is neutralized: controls, escapes, line separators and bidi marks never reach the terminal', async () => {
  const hostile = '/work/wt/a\nb\u001b[2J\u009b\u0085\u2028\u2029\u202e.md'
  const result = cleanResult({
    exitCode: 3, target: '/work/wt\nforged: SAFE',
    risks: [{ code: 'unpreserved-working', path: hostile, detail: `edit of ${hostile}\r\nExit 0: safe` }],
    unknowns: [{ code: 'x\ny', path: hostile, detail: 'd\u0007' }],
  })
  const stub = stubChecker(result)
  const r = await run(['check-removal', '--worktree', '/work/wt'], makeHome(), 1, { checkWorktreeRemoval: stub.fn })
  assert.equal(r.code, 3)
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(r.out), 'no control or separator characters in the report')
  const entryLines = r.out.split('\n').filter(l => l.startsWith('  - ['))
  assert.equal(entryLines.length, 2, 'each risk and unknown is exactly one line')
  assert.ok(entryLines[0]!.includes('/work/wt/a?b?[2J???') && entryLines[0]!.includes('Exit 0: safe'), 'the hostile text stays on the risk line')
  assert.ok(!r.out.split('\n').some(l => l.startsWith('forged:')), 'a newline in the target cannot start a forged line')
  // JSON keeps the exact strings (escaped by JSON itself).
  const j = await run(['check-removal', '--worktree', '/work/wt', '--json'], makeHome(), 1, { checkWorktreeRemoval: stub.fn })
  assert.equal(((JSON.parse(j.out) as { result: RemovalCheckResult }).result.risks[0]!).path, hostile)
  assert.ok(!j.out.includes('\u001b'), 'JSON escapes the escape character')
})

// ----------------------------------------------------------------------------------------------------------------- check-removal: session probe

const TARGET = '/work/wt'

test('the probe pages the live statuses and the unconfirmed closed ones with subagents and answers inactive only when all were fully read and nothing matched', async () => {
  const home = makeHome()
  const fake = await startFake(sessionsService([]))
  const probe = await captureProbe(home, fake.port)
  assert.equal(await probe(TARGET), 'inactive')
  const lists = listRequests(fake)
  assert.deepEqual(lists.map(l => l.query.get('status')), ['active', 'unknown', 'closed'])
  assert.deepEqual(lists.map(l => l.query.get('endConfirmed')), [null, null, 'false'], 'only closed sessions without a confirmed end are asked for')
  for (const l of lists) {
    assert.equal(l.method, 'GET')
    assert.equal(l.query.get('includeSubagents'), 'true')
    assert.equal(l.query.get('limit'), '500')
    assert.equal(l.query.get('offset'), '0')
    assert.equal(l.headers.host, `127.0.0.1:${fake.port}`)
  }
})

test('the probe answers unknown when the service is unreachable, slow or refuses, never inactive', async () => {
  const home = makeHome()
  const probeDown = await captureProbe(home, await deadPort())
  assert.equal(await probeDown(TARGET), 'unknown')

  const hang = await startFake(() => ({ hang: true }))
  const slow = await captureProbe(home, hang.port, {}, 100)
  const started = Date.now()
  assert.equal(await slow(TARGET), 'unknown')
  assert.ok(Date.now() - started < 3000)

  const total = await startFake(sessionsService([], () => ({ json: { rows: [], total: 0, limit: 500, offset: 0 }, delayMs: 250 })))
  const bounded = await captureProbe(home, total.port, { totalMs: 300 }, 5000)
  const t0 = Date.now()
  assert.equal(await bounded(TARGET), 'unknown', 'the total bound ends a probe whose calls each answer in time')
  assert.ok(Date.now() - t0 < 2000)

  for (const status of [400, 404, 500, 503]) {
    // Even a body that looks like an empty, complete list is not believed when the status says it failed.
    const fake = await startFake(() => ({ status, json: { rows: [], total: 0, limit: 500, offset: 0 } }))
    assert.equal(await (await captureProbe(home, fake.port))(TARGET), 'unknown', `HTTP ${status}`)
  }
  // The second status set failing after the first was empty is still unknown.
  const second = await startFake(sessionsService([], req => (req.path === '/api/sessions' && req.query.get('status') === 'unknown' ? { status: 500, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, second.port))(TARGET), 'unknown')
})

test('the probe matches a live session by its resume or start folder, equal or inside the target, never by a string prefix', async () => {
  const home = makeHome()
  const cases: Array<[string, Live[], string]> = [
    ['resume equal to the target', [{ id: SID(1), status: 'active', resume: TARGET }], 'active'],
    ['resume inside the target', [{ id: SID(1), status: 'active', resume: `${TARGET}/src/deep/er` }], 'active'],
    ['start inside the target, resume elsewhere', [{ id: SID(1), status: 'active', resume: '/home/u/other', start: `${TARGET}/sub` }], 'active'],
    ['a prefix sibling', [{ id: SID(1), status: 'active', resume: `${TARGET}-other`, start: `${TARGET}x/y` }], 'inactive'],
    ['the parent directory', [{ id: SID(1), status: 'active', resume: '/work', start: '/' }], 'inactive'],
    ['a dot-dot spelling that leaves the target', [{ id: SID(1), status: 'active', resume: `${TARGET}/../wt-other`, start: `${TARGET}/..` }], 'inactive'],
    ['a dot-dot spelling that stays inside', [{ id: SID(1), status: 'active', resume: `${TARGET}/a/../b` }], 'active'],
    ['a trailing slash', [{ id: SID(1), status: 'active', resume: `${TARGET}/` }], 'active'],
    ['an unknown-status session inside', [{ id: SID(1), status: 'unknown', resume: `${TARGET}/x` }], 'unknown'],
    ['an unknown-status session elsewhere', [{ id: SID(1), status: 'unknown', resume: '/home/u/other' }], 'inactive'],
    ['an unknown-status session started inside', [{ id: SID(1), status: 'unknown', resume: '/home/u/other', start: `${TARGET}/sub` }], 'unknown'],
    ['an active session wins over an unknown one', [{ id: SID(1), status: 'unknown', resume: TARGET }, { id: SID(2), status: 'active', resume: TARGET }], 'active'],
    ['a session in neither folder next to an unknown match', [{ id: SID(1), status: 'active', resume: '/home/u/other' }, { id: SID(2), status: 'unknown', resume: TARGET }], 'unknown'],
    ['a session with no folder at all', [{ id: SID(1), status: 'active', resume: null, start: null }], 'unknown'],
    ['a session with a relative folder only', [{ id: SID(1), status: 'active', resume: 'relative/dir', start: null }], 'unknown'],
    ['a null resume with an outside start', [{ id: SID(1), status: 'active', resume: null, start: '/home/u/other' }], 'inactive'],
  ]
  for (const [label, rows, expected] of cases) {
    const fake = await startFake(sessionsService(rows))
    const probe = await captureProbe(home, fake.port)
    assert.equal(await probe(TARGET), expected, label)
  }
  // An active match is conclusive: the unknown set is not even requested, and a resume match needs no detail lookup.
  const fake = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: TARGET }]))
  assert.equal(await (await captureProbe(home, fake.port))(TARGET), 'active')
  assert.deepEqual(listRequests(fake).map(l => l.query.get('status')), ['active'])
  assert.equal(detailRequests(fake).length, 0)
})

const IDLE_NOTE = (id: string): string => `session ${id} was closed by idle cleanup, not by a confirmed end; confirm its process has exited, then remove the worktree yourself, or retry after the session ends`
const NOFOLDER_NOTE = (id: string): string => `session ${id} was closed without a confirmed end and its folder is not recorded, so Atlas cannot tell whether it uses this worktree; confirm its process has exited, then remove the worktree yourself, or retry after the session ends`
const LEGACY_NOTE = (id: string): string => `session ${id} was closed with no recorded end reason, not by a confirmed end; confirm its process has exited, then remove the worktree yourself, or retry after the session ends`

test('P1: a matching closed session without a confirmed end makes the probe unknown, naming the session and the next step; only a confirmed end clears it', async () => {
  const home = makeHome()
  const unconfirmed = (id: string, extra: Partial<Live> = {}): Live => ({ id, status: 'closed', resume: `${TARGET}/x`, endReason: 'idle', endConfirmed: false, ...extra })
  const cases: Array<[string, Live[], string | { activity: string; reason: string }]> = [
    ['closed by the idle sweep, resume folder inside', [unconfirmed(SID(1))], { activity: 'unknown', reason: IDLE_NOTE(SID(1)) }],
    ['closed by the idle sweep, resume folder equal to the target', [unconfirmed(SID(1), { resume: TARGET })], { activity: 'unknown', reason: IDLE_NOTE(SID(1)) }],
    ['closed by the idle sweep, start folder inside and resume elsewhere', [unconfirmed(SID(1), { resume: '/home/u/other', start: `${TARGET}/sub` })], { activity: 'unknown', reason: IDLE_NOTE(SID(1)) }],
    ['closed before an end reason was recorded (NULL)', [unconfirmed(SID(1), { endReason: null })], { activity: 'unknown', reason: LEGACY_NOTE(SID(1)) }],
    ['the first match is the one named', [unconfirmed(SID(1), { resume: '/home/u/other' }), unconfirmed(SID(2)), unconfirmed(SID(3), { endReason: null })], { activity: 'unknown', reason: IDLE_NOTE(SID(2)) }],
    ['confirmed by a SessionEnd hook, inside the target', [unconfirmed(SID(1), { endReason: 'hook', endConfirmed: true })], 'inactive'],
    ['a confirmed end next to an unconfirmed one elsewhere', [unconfirmed(SID(1), { endReason: 'hook', endConfirmed: true }), unconfirmed(SID(2), { resume: '/home/u/other' })], 'inactive'],
    ['closed by the idle sweep, folders elsewhere', [unconfirmed(SID(1), { resume: '/home/u/other' })], 'inactive'],
    ['closed by the idle sweep, a prefix sibling of the target', [unconfirmed(SID(1), { resume: `${TARGET}-other`, start: `${TARGET}x/y` })], 'inactive'],
    ['closed by the idle sweep, a dot-dot spelling that leaves the target', [unconfirmed(SID(1), { resume: `${TARGET}/../wt-other`, start: `${TARGET}/..` })], 'inactive'],
    ['R90: closed without a confirmed end, never reported a folder: it could be anywhere, so unknown, named', [unconfirmed(SID(1), { resume: null, start: null })], { activity: 'unknown', reason: NOFOLDER_NOTE(SID(1)) }],
    ['R90: closed without a confirmed end, a relative folder only: no usable folder either', [unconfirmed(SID(1), { resume: 'relative/dir', start: null })], { activity: 'unknown', reason: NOFOLDER_NOTE(SID(1)) }],
    ['R90: a legacy (NULL reason) closed session with no folder is unknown too', [unconfirmed(SID(1), { endReason: null, resume: null, start: null })], { activity: 'unknown', reason: NOFOLDER_NOTE(SID(1)) }],
    ['R90: a folderless one next to one elsewhere is still named', [unconfirmed(SID(1), { resume: '/home/u/other' }), unconfirmed(SID(2), { resume: null, start: null })], { activity: 'unknown', reason: NOFOLDER_NOTE(SID(2)) }],
    ['R90: a match in the target is named ahead of a folderless one', [unconfirmed(SID(1), { resume: null, start: null }), unconfirmed(SID(2))], { activity: 'unknown', reason: IDLE_NOTE(SID(2)) }],
    ['R90: a closed CONFIRMED session with no folder is skipped as before', [unconfirmed(SID(1), { resume: null, start: null, endReason: 'hook', endConfirmed: true })], 'inactive'],
    ['a live session in the target wins over an idle-closed one', [unconfirmed(SID(1)), { id: SID(2), status: 'active', resume: TARGET }], 'active'],
    ['an unknown-status match is reported as before, ahead of a closed one', [unconfirmed(SID(1)), { id: SID(2), status: 'unknown', resume: TARGET }], 'unknown'],
    ['a live session elsewhere changes nothing', [unconfirmed(SID(1)), { id: SID(2), status: 'active', resume: '/home/u/other' }], { activity: 'unknown', reason: IDLE_NOTE(SID(1)) }],
  ]
  for (const [label, rows, expected] of cases) {
    const fake = await startFake(sessionsService(rows))
    assert.deepEqual(await (await captureProbe(home, fake.port))(TARGET), expected, label)
  }
})

test('P1: the closed-session pass is as strict as the live ones: a folder it cannot judge, a broken page or a service that cannot filter is unknown, never inactive', async () => {
  const home = makeHome()
  const target = '/work/wt'
  const idle = (id: string, extra: Partial<Live> = {}): Live => ({ id, status: 'closed', resume: '/home/u/other', endReason: 'idle', ...extra })
  // A folder given but not resolvable (a symbolic link loop) is uncertain, exactly as for a live session.
  const base = realpathSync(tempDir('atlas-cli-probe-loop-'))
  const loop = join(base, 'loop')
  symlinkSync(loop, loop)
  assert.equal(await (await captureProbe(home, (await startFake(sessionsService([idle(SID(1), { resume: loop, start: loop })]))).port))(target), 'unknown', 'unresolvable folder')

  // The closed list failing, malformed, or inconsistent ends in unknown.
  const failing = await startFake(sessionsService([], req => (req.path === '/api/sessions' && req.query.get('status') === 'closed' ? { status: 500, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, failing.port))(target), 'unknown', 'the closed list answers 500')
  const badKey = await startFake(sessionsService([], req => (req.path === '/api/sessions' && req.query.get('status') === 'closed'
    ? { json: { rows: [{ ...listRow(idle(SID(1))), endConfirmed: 'yes' }], total: 1, limit: 500, offset: 0 } } : undefined)))
  assert.equal(await (await captureProbe(home, badKey.port))(target), 'unknown', 'endConfirmed is not a boolean')
  const badReason = await startFake(sessionsService([], req => (req.path === '/api/sessions' && req.query.get('status') === 'closed'
    ? { json: { rows: [{ ...listRow(idle(SID(1))), endReason: 'crash' }], total: 1, limit: 500, offset: 0 } } : undefined)))
  assert.equal(await (await captureProbe(home, badReason.port))(target), 'unknown', 'endReason is not hook, idle or null')
  const wrongStatus = await startFake(sessionsService([], req => (req.path === '/api/sessions' && req.query.get('status') === 'closed'
    ? { json: { rows: [listRow({ id: SID(1), status: 'active', resume: '/home/u/other' })], total: 1, limit: 500, offset: 0 } } : undefined)))
  assert.equal(await (await captureProbe(home, wrongStatus.port))(target), 'unknown', 'a row whose status is not the one asked for')
  const rows = Array.from({ length: 3 }, (_, i) => idle(SID(i + 1)))
  const broken = await startFake(sessionsService(rows, req => (req.path === '/api/sessions' && req.query.get('status') === 'closed' && req.query.get('offset') === '2' ? { status: 500, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, broken.port, { pageSize: 2 }))(target), 'unknown', 'the second closed page fails')
  const found = await startFake(sessionsService([...rows, idle(SID(4), { resume: `${target}/deep` })]))
  assert.deepEqual(await (await captureProbe(home, found.port, { pageSize: 2 }))(target), { activity: 'unknown', reason: IDLE_NOTE(SID(4)) }, 'a match on the last closed page')
  const capped = await startFake(sessionsService(Array.from({ length: 6 }, (_, i) => idle(SID(i + 1)))))
  assert.equal(await (await captureProbe(home, capped.port, { pageSize: 2, maxPages: 2, maxDetailLookups: 0 }))(target), 'unknown', 'a bounded number of closed pages')

  // A confirmed row the service should not have sent proves nothing live: it never matches, even inside the target.
  const stray = await startFake(sessionsService([], req => (req.path === '/api/sessions' && req.query.get('status') === 'closed'
    ? { json: { rows: [listRow(idle(SID(1), { resume: target, start: target, endReason: 'hook', endConfirmed: true }), true)], total: 1, limit: 500, offset: 0 } } : undefined)))
  assert.equal(await (await captureProbe(home, stray.port))(target), 'inactive', 'a confirmed row among the unconfirmed ones')

  // A service older than the end reason: it does not know the filter or the keys, so EVERY closed session comes back without
  // proof of its end. None of them can clear the target.
  const older = await startFake(sessionsService([idle(SID(1), { resume: `${target}/x`, endReason: null })], undefined, { endKeys: false }))
  assert.deepEqual(await (await captureProbe(home, older.port))(target), { activity: 'unknown', reason: LEGACY_NOTE(SID(1)) }, 'an older service')
  const olderElsewhere = await startFake(sessionsService([idle(SID(1), { endReason: null })], undefined, { endKeys: false }))
  assert.equal(await (await captureProbe(home, olderElsewhere.port))(target), 'inactive', 'an older service, closed sessions elsewhere')
  // The start-folder lookup path (an older service without startCwd on rows) works for closed sessions too.
  const lookup = await startFake(sessionsService([idle(SID(1), { resume: '/home/u/a', start: `${target}/sub` })]))
  assert.deepEqual(await (await captureProbe(home, lookup.port))(target), { activity: 'unknown', reason: IDLE_NOTE(SID(1)) }, 'start folder by lookup')
  assert.equal(detailRequests(lookup).length, 1)
  const lookupBounded = await startFake(sessionsService([idle(SID(1)), idle(SID(2))]))
  assert.equal(await (await captureProbe(home, lookupBounded.port, { maxDetailLookups: 1 }))(target), 'unknown', 'the lookup bound is shared with the closed pass')
})

test('the probe looks up the start folder of sessions whose resume folder does not match, and a failed lookup is unknown', async () => {
  const home = makeHome()
  const rows: Live[] = [{ id: SID(1), status: 'active', resume: '/home/u/a' }, { id: SID(2), status: 'active', resume: '/home/u/b', start: `${TARGET}/sub` }]
  const fake = await startFake(sessionsService(rows))
  assert.equal(await (await captureProbe(home, fake.port))(TARGET), 'active')
  assert.deepEqual(detailRequests(fake).map(d => d.path).sort(), [`/api/sessions/${SID(1)}`, `/api/sessions/${SID(2)}`])

  // Lookups run side by side (up to the setting): three slow answers arrive in about one answer's time, not three.
  const slowRows: Live[] = Array.from({ length: 3 }, (_, i) => ({ id: SID(i + 1), status: 'active' as const, resume: `/home/u/${i}` }))
  const arrivals: number[] = []
  const slow = await startFake(sessionsService(slowRows, req => {
    if (!/^\/api\/sessions\/[^/]+$/.test(req.path)) return undefined
    arrivals.push(Date.now())
    return { json: { session: { sessionId: req.path.split('/').pop(), startCwd: '/home/u/x', resumeCwd: '/home/u/x' } }, delayMs: 400 }
  }))
  assert.equal(await (await captureProbe(home, slow.port, { detailConcurrency: 3 }))(TARGET), 'inactive')
  assert.equal(arrivals.length, 3)
  assert.ok(Math.max(...arrivals) - Math.min(...arrivals) < 300, `the three lookups started together (spread ${Math.max(...arrivals) - Math.min(...arrivals)} ms)`)

  // Workers stop at the first match: with one worker, a match on the first session leaves the others unasked.
  const many: Live[] = [{ id: SID(1), status: 'active', resume: '/home/u/a', start: `${TARGET}/x` }, { id: SID(2), status: 'active', resume: '/home/u/b' }, { id: SID(3), status: 'active', resume: '/home/u/c' }]
  const early = await startFake(sessionsService(many))
  assert.equal(await (await captureProbe(home, early.port, { detailConcurrency: 1 }))(TARGET), 'active')
  assert.equal(detailRequests(early).length, 1)

  const outside: Live[] = [{ id: SID(1), status: 'active', resume: '/home/u/a' }, { id: SID(2), status: 'unknown', resume: '/home/u/b' }]
  const idOf = (req: Recorded): string => req.path.split('/').pop() ?? ''
  const replies: Array<[string, (req: Recorded) => Reply]> = [
    ['a 500 with a valid-looking body', req => ({ status: 500, json: { session: { sessionId: idOf(req), startCwd: '/home/u/a', resumeCwd: '/home/u/a' } } })],
    ['a 404', () => ({ status: 404, json: {} })],
    ['text', () => ({ text: 'nope' })],
    ['no session', () => ({ json: { folders: {} } })],
    ['another session ID', () => ({ json: { session: { sessionId: SID(9), startCwd: '/x', resumeCwd: '/x' } } })],
    ['a start folder that is not text', req => ({ json: { session: { sessionId: idOf(req), startCwd: 5, resumeCwd: '/x' } } })],
    ['a resume folder that is not text', req => ({ json: { session: { sessionId: idOf(req), startCwd: '/x', resumeCwd: 5 } } })],
    ['a missing start folder field', req => ({ json: { session: { sessionId: idOf(req), resumeCwd: '/x' } } })],
    ['both folders null', req => ({ json: { session: { sessionId: idOf(req), startCwd: null, resumeCwd: null } } })],
  ]
  for (const [label, reply] of replies) {
    const f = await startFake(sessionsService(outside, req => (/^\/api\/sessions\/[^/]+$/.test(req.path) ? reply(req) : undefined)))
    assert.equal(await (await captureProbe(home, f.port))(TARGET), 'unknown', label)
  }
  // A lookup that never answers is a failed lookup, not "no match".
  const stalled = await startFake(sessionsService(outside, req => (/^\/api\/sessions\/[^/]+$/.test(req.path) ? { hang: true } : undefined)))
  assert.equal(await (await captureProbe(home, stalled.port, {}, 150))(TARGET), 'unknown', 'a lookup that times out')
  const fine = await startFake(sessionsService(outside))
  assert.equal(await (await captureProbe(home, fine.port))(TARGET), 'inactive')

  // More lookups than the bound allows cannot establish inactivity; the bound is shared by both statuses.
  const capped = await startFake(sessionsService(outside))
  assert.equal(await (await captureProbe(home, capped.port, { maxDetailLookups: 1 }))(TARGET), 'unknown')
  const exact = await startFake(sessionsService(outside))
  assert.equal(await (await captureProbe(home, exact.port, { maxDetailLookups: 2 }))(TARGET), 'inactive')
  const active = await startFake(sessionsService(Array.from({ length: 3 }, (_, i) => ({ id: SID(i + 1), status: 'active' as const, resume: `/home/u/${i}` }))))
  assert.equal(await (await captureProbe(home, active.port, { maxDetailLookups: 2 }))(TARGET), 'unknown', 'three lookups wanted within a bound of two')
})

test('the probe resolves a missing folder through its existing ancestors, and an unresolvable folder is unknown', async () => {
  const home = makeHome()
  const work = makeWork()
  const target = join(work, 'real', 'wt')
  mkdirSync(target, { recursive: true })
  symlinkSync(join(work, 'real'), join(work, 'link'))
  symlinkSync('loop', join(work, 'loop')) // a link to itself: nothing below it can be resolved
  symlinkSync('loop', join(target, 'loop'))
  for (const startInRows of [false, true]) {
    const mode = startInRows ? 'start folder in the list rows' : 'older service, folders by lookup'
    const probeOf = async (rows: Live[]) => (await captureProbe(home, (await startFake(sessionsService(rows, undefined, { startInRows }))).port))
    // A deleted sub-folder of the target spelled through a link: the spelling does not match, the canonical form does.
    const viaLink = join(work, 'link', 'wt', 'deleted-sub', 'deeper')
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: viaLink }]))(target), 'active', `${mode}: resume`)
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: '/home/u/elsewhere', start: viaLink }]))(target), 'active', `${mode}: start`)
    assert.equal(await (await probeOf([{ id: SID(1), status: 'unknown', resume: viaLink }]))(target), 'unknown', `${mode}: an unknown-status session`)
    // Missing folders that are not inside the target stay "no".
    for (const outside of [join(work, 'link', 'wt-other', 'gone'), join(work, 'link', 'gone'), join(work, 'real', 'wtx', 'gone')]) {
      assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: outside }]))(target), 'inactive', `${mode}: ${outside}`)
    }
    // A folder that cannot be resolved by any spelling and does not match by spelling is not "outside": unknown.
    const loop = join(work, 'loop', 'x')
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: loop }]))(target), 'unknown', `${mode}: unresolvable resume`)
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: '/home/u/elsewhere', start: loop }]))(target), 'unknown', `${mode}: unresolvable start`)
    assert.equal(await (await probeOf([{ id: SID(1), status: 'unknown', resume: loop }]))(target), 'unknown', `${mode}: unresolvable, unknown status`)
    // ...but a match elsewhere in the same session still decides.
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: loop, start: join(target, 'sub') }]))(target), 'active', `${mode}: a match beats an unresolvable folder`)
    // A folder inside the target by spelling is a match even if the file system cannot resolve it (a link loop below the target).
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: join(target, 'loop', 'x') }]))(target), 'active', `${mode}: inside the target by spelling, unresolvable`)
    assert.equal(await (await probeOf([{ id: SID(1), status: 'active', resume: loop }, { id: SID(2), status: 'active', resume: target }]))(target), 'active', `${mode}: another session's match beats it too`)
  }
})

test('the probe reads the start folder from the list rows and asks per session only when the key is absent (older service)', async () => {
  const home = makeHome()
  const cases: Array<[string, Live[], string]> = [
    ['start inside, resume outside', [{ id: SID(1), status: 'active', resume: '/home/u/other', start: `${TARGET}/sub` }], 'active'],
    ['start and resume outside', [{ id: SID(1), status: 'active', resume: '/home/u/a', start: '/home/u/b' }], 'inactive'],
    ['start outside, resume inside', [{ id: SID(1), status: 'active', resume: `${TARGET}/x`, start: '/home/u/b' }], 'active'],
    ['start null, resume outside', [{ id: SID(1), status: 'active', resume: '/home/u/a', start: null }], 'inactive'],
    ['start null, resume null', [{ id: SID(1), status: 'active', resume: null, start: null }], 'unknown'],
    ['start inside, unknown status', [{ id: SID(1), status: 'unknown', resume: '/home/u/a', start: `${TARGET}/sub` }], 'unknown'],
    ['a prefix sibling in both', [{ id: SID(1), status: 'active', resume: `${TARGET}-other`, start: `${TARGET}x` }], 'inactive'],
  ]
  for (const [label, rows, expected] of cases) {
    const fake = await startFake(sessionsService(rows, undefined, { startInRows: true }))
    assert.equal(await (await captureProbe(home, fake.port))(TARGET), expected, label)
    assert.equal(detailRequests(fake).length, 0, `${label}: no per-session request when the rows carry the start folder`)
  }
  // The key present but not text or null: the row is malformed, so unknown (and no lookup).
  const bad = await startFake(req => (req.path === '/api/sessions' && req.query.get('status') === 'active'
    ? { json: { rows: [{ ...listRow({ id: SID(1), status: 'active', resume: '/home/u/a' }), startCwd: 5 }], total: 1, limit: 500, offset: 0 } }
    : req.path === '/api/sessions' ? { json: { rows: [], total: 0, limit: 500, offset: 0 } } : undefined))
  assert.equal(await (await captureProbe(home, bad.port))(TARGET), 'unknown')
  assert.equal(detailRequests(bad).length, 0)
  // The lookup bound does not apply when no lookup is needed.
  const many = await startFake(sessionsService(Array.from({ length: 5 }, (_, i) => ({ id: SID(i + 1), status: 'active' as const, resume: `/home/u/${i}` })), undefined, { startInRows: true }))
  assert.equal(await (await captureProbe(home, many.port, { maxDetailLookups: 0 }))(TARGET), 'inactive')
  // Key absent (an older service): the per-session fallback still works and still fails closed.
  const older = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: '/home/u/a', start: `${TARGET}/sub` }]))
  assert.equal(await (await captureProbe(home, older.port))(TARGET), 'active')
  assert.equal(detailRequests(older).length, 1)
  const olderDown = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: '/home/u/a' }], req => (/^\/api\/sessions\/[^/]+$/.test(req.path) ? { status: 404, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, olderDown.port))(TARGET), 'unknown')
  const olderCapped = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: '/home/u/a' }]))
  assert.equal(await (await captureProbe(home, olderCapped.port, { maxDetailLookups: 0 }))(TARGET), 'unknown')
})

test('a failed lookup for an unknown-status session is unknown too, and an active match still wins', async () => {
  const home = makeHome()
  const detail = (req: Recorded): boolean => /^\/api\/sessions\/[^/]+$/.test(req.path)
  const rows: Live[] = [{ id: SID(1), status: 'active', resume: '/home/u/a' }, { id: SID(2), status: 'unknown', resume: '/home/u/b' }]
  // The active session's lookup succeeds outside the target; the unknown-status session's lookup fails.
  const missing = await startFake(sessionsService(rows, req => (detail(req) && req.path.endsWith(SID(2)) ? { status: 404, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, missing.port))(TARGET), 'unknown', '404')
  const broken = await startFake(sessionsService(rows, req => (detail(req) && req.path.endsWith(SID(2)) ? { text: 'nope' } : undefined)))
  assert.equal(await (await captureProbe(home, broken.port))(TARGET), 'unknown', 'garbage')
  const stalled = await startFake(sessionsService(rows, req => (detail(req) && req.path.endsWith(SID(2)) ? { hang: true } : undefined)))
  assert.equal(await (await captureProbe(home, stalled.port, {}, 150))(TARGET), 'unknown', 'timeout')
  const control = await startFake(sessionsService(rows))
  assert.equal(await (await captureProbe(home, control.port))(TARGET), 'inactive', 'both lookups fine: inactive')
  // An active match is conclusive whatever the unknown-status lookups do.
  const winning = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: TARGET }, rows[1]!], req => (detail(req) ? { status: 500, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, winning.port))(TARGET), 'active')
  const viaLookup = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: '/home/u/a', start: `${TARGET}/s` }, rows[1]!], req => (detail(req) && req.path.endsWith(SID(2)) ? { status: 500, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, viaLookup.port, { detailConcurrency: 1 }))(TARGET), 'active')
})

test('the probe pages until a short page, finds a match on a later page, and treats any broken paging as unknown', async () => {
  const home = makeHome()
  const many = (n: number, last: string): Live[] => Array.from({ length: n }, (_, i) => ({ id: SID(i + 1), status: 'active' as const, resume: i === n - 1 ? last : `/home/u/${i}` }))

  const hit = await startFake(sessionsService(many(5, `${TARGET}/z`)))
  assert.equal(await (await captureProbe(home, hit.port, { pageSize: 2 }))(TARGET), 'active')
  assert.deepEqual(listRequests(hit).map(l => `${l.query.get('offset')}/${l.query.get('limit')}`), ['0/2', '2/2', '4/2'])

  const miss = await startFake(sessionsService(many(4, '/home/u/last')))
  assert.equal(await (await captureProbe(home, miss.port, { pageSize: 2 }))(TARGET), 'inactive')
  assert.deepEqual(listRequests(miss).filter(l => l.query.get('status') === 'active').map(l => l.query.get('offset')), ['0', '2', '4'], 'a full last page is followed by one more, empty, page')

  const failing = await startFake(sessionsService(many(5, '/home/u/last'), req => (req.path === '/api/sessions' && req.query.get('offset') === '2' ? { status: 500, json: {} } : undefined)))
  assert.equal(await (await captureProbe(home, failing.port, { pageSize: 2 }))(TARGET), 'unknown', 'the second page failing')

  const garbled = await startFake(sessionsService(many(5, '/home/u/last'), req => (req.path === '/api/sessions' && req.query.get('offset') === '2' ? { text: '{' } : undefined)))
  assert.equal(await (await captureProbe(home, garbled.port, { pageSize: 2 }))(TARGET), 'unknown', 'the second page malformed')

  let calls = 0
  const shifting = await startFake(sessionsService(many(5, '/home/u/last'), req => {
    if (req.path !== '/api/sessions' || req.query.get('status') !== 'active') return undefined
    calls++
    const offset = Number(req.query.get('offset'))
    // A session closed while the pages were read: the first page saw 6, the others 5, and the last page then adds up to 5.
    return { json: { rows: many(5, '/home/u/last').slice(offset, offset + 2).map(row => listRow(row)), total: calls === 1 ? 6 : 5, limit: 2, offset } }
  }))
  assert.equal(await (await captureProbe(home, shifting.port, { pageSize: 2 }))(TARGET), 'unknown', 'the total changed between pages')

  const truncated = await startFake(sessionsService(many(5, '/home/u/last'), req => {
    if (req.path !== '/api/sessions' || req.query.get('status') !== 'active') return undefined
    const offset = Number(req.query.get('offset'))
    return { json: { rows: many(5, '/home/u/last').slice(offset, offset + 2).slice(0, offset === 4 ? 0 : 2).map(row => listRow(row)), total: 5, limit: 2, offset } }
  }))
  assert.equal(await (await captureProbe(home, truncated.port, { pageSize: 2 }))(TARGET), 'unknown', 'fewer rows than the reported total')

  const duplicated = await startFake(sessionsService(many(4, '/home/u/last'), req => {
    if (req.path !== '/api/sessions' || req.query.get('status') !== 'active') return undefined
    const offset = Number(req.query.get('offset'))
    const rows = many(4, '/home/u/last')
    // Session 2 appears on both pages, so the four rows read are only three sessions.
    const page = offset === 0 ? [rows[0]!, rows[1]!] : offset === 2 ? [rows[1]!, rows[2]!] : []
    return { json: { rows: page.map(row => listRow(row)), total: 4, limit: 2, offset } }
  }))
  assert.equal(await (await captureProbe(home, duplicated.port, { pageSize: 2 }))(TARGET), 'unknown', 'the same session twice')

  const endless = await startFake(sessionsService([], req => {
    if (req.path !== '/api/sessions' || req.query.get('status') !== 'active') return undefined
    const offset = Number(req.query.get('offset'))
    return { json: { rows: [listRow({ id: SID(offset + 1), status: 'active', resume: '/home/u/a' }), listRow({ id: SID(offset + 2), status: 'active', resume: '/home/u/b' })], total: 1000, limit: 2, offset } }
  }))
  assert.equal(await (await captureProbe(home, endless.port, { pageSize: 2, maxPages: 3, maxDetailLookups: 0 }))(TARGET), 'unknown', 'a bounded number of pages')
  assert.equal(listRequests(endless).length, 3)
})

test('the probe treats any malformed list answer as unknown, each by its own check', async () => {
  const home = makeHome()
  const row = (status: string): Record<string, unknown> => listRow({ id: SID(1), status: status as 'active', resume: '/home/u/a' })
  const ok = (rows: unknown[], over: Record<string, unknown> = {}) => ({ rows, total: rows.length, limit: 500, offset: 0, ...over })
  // Every case is judged on the active list; the unknown list is a well-formed empty one. A well-formed row outside the target
  // gives inactive (its start folder is looked up and is outside too), so only the malformation can make the answer unknown.
  const bodies: Array<[string, unknown, string]> = [
    ['a well-formed list (the control)', ok([row('active')]), 'inactive'],
    ['not JSON', undefined, 'unknown'],
    ['an array', [], 'unknown'],
    ['no rows', { total: 0, limit: 500, offset: 0 }, 'unknown'],
    ['rows that are not a list', { rows: 'x', total: 0, limit: 500, offset: 0 }, 'unknown'],
    ['no total', { rows: [], limit: 500, offset: 0 }, 'unknown'],
    ['a total that is a string', { rows: [], total: '0', limit: 500, offset: 0 }, 'unknown'],
    ['a fractional total', { rows: [], total: 0.5, limit: 500, offset: 0 }, 'unknown'],
    ['a negative total', { rows: [], total: -1, limit: 500, offset: 0 }, 'unknown'],
    ['a total larger than the rows', ok([row('active')], { total: 2 }), 'unknown'],
    ['a total smaller than the rows', ok([row('active')], { total: 0 }), 'unknown'],
    ['a clamped limit', ok([], { limit: 100 }), 'unknown'],
    ['another offset', ok([], { offset: 500 }), 'unknown'],
    ['a non-object row', ok(['x']), 'unknown'],
    ['a row with an invalid session ID', ok([{ ...row('active'), sessionId: '../../x' }]), 'unknown'],
    ['a row of another status', ok([row('closed')]), 'unknown'],
    ['a row folder that is not text', ok([{ ...row('active'), resumeCwd: 5 }]), 'unknown'],
    ['a row without a folder field', ok([{ ...row('active'), resumeCwd: undefined }]), 'unknown'],
    ['more rows than asked for', ok(Array.from({ length: 501 }, (_, i) => ({ ...row('active'), sessionId: SID(i + 1) }))), 'unknown'],
  ]
  for (const [label, body, expected] of bodies) {
    const fake = await startFake(req => {
      if (req.path === '/api/sessions') {
        if (req.query.get('status') !== 'active') return { json: ok([]) }
        return body === undefined ? { text: 'garbage' } : { json: body }
      }
      const id = /^\/api\/sessions\/([^/]+)$/.exec(req.path)?.[1]
      return id ? { json: { session: { sessionId: id, startCwd: '/home/u/a', resumeCwd: '/home/u/a' } } } : undefined
    })
    assert.equal(await (await captureProbe(home, fake.port))(TARGET), expected, label)
    if (expected === 'unknown') assert.ok(fake.requests.every(r => r.path === '/api/sessions'), `${label}: a rejected list leads to no further request`)
  }
})

test('the probe resolves symlinked session folders, so a link into the target counts', async () => {
  const home = makeHome()
  const work = makeWork()
  const target = join(work, 'wt')
  mkdirSync(join(target, 'sub'), { recursive: true })
  symlinkSync(join(target, 'sub'), join(work, 'link'))
  symlinkSync(work, join(work, 'up'))
  const fake = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: join(work, 'link') }]))
  assert.equal(await (await captureProbe(home, fake.port))(target), 'active')
  const outside = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: join(work, 'up') }]))
  assert.equal(await (await captureProbe(home, outside.port))(target), 'inactive', 'a link to the parent is not inside the target')
  // ".." after a link is resolved by the kernel, not by string: <link>/.. is the target itself.
  const dotdot = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: `${join(work, 'link')}/..` }]))
  assert.equal(await (await captureProbe(home, dotdot.port))(target), 'active')
  const gone = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: join(target, 'removed', 'dir') }]))
  assert.equal(await (await captureProbe(home, gone.port))(target), 'active', 'a folder that no longer exists is still judged by its spelling')
})

// ----------------------------------------------------------------------------------------------------------------- against the real routes

const NOW = '2026-10-27T12:00:00.000Z'

/** The real session and artifact routes over a temporary database, on a port of their own. */
async function realService(home: string): Promise<{ db: ReturnType<typeof openTestDb>; port: number }> {
  const db = openTestDb()
  const config = loadConfig({ HOME: home })
  const srv = await startRouteServer(db, (router, deps) => {
    registerArtifactRoutes(router, { ...deps, home, config, now: () => NOW })
    registerSessionRoutes(router, deps)
  })
  cleanups.push(async () => { await srv.close(); db.close() })
  return { db, port: Number(new URL(srv.base).port) }
}

test('against the real artifact routes: output-dir --create registers by repository ID, and status, refresh and register-output agree', async () => {
  const home = makeHome()
  const work = makeWork()
  const repo = makeRepo(home) // the service only accepts a --repo inside the home directory
  const before = tree(home)
  const { db, port } = await realService(home)
  const repositoryId = registerArtifactRepository(db, { commonDir: realpathSync(join(repo, '.git')), displayName: 'proj', remoteIdentity: null }, NOW)
  registerArtifactRoot(db, { kind: 'checkout', canonicalPath: repo, repositoryId, projectName: 'proj', checkoutIdentity: 'ck-main', protected: false, scopeFlags: ['checkout'] }, NOW)
  const dir = join(home, '.claude', 'artifact-output', repositoryId, 'deliverables')

  const dry = await run(['output-dir', '--repo', repo], home, port)
  assert.equal(dry.code, 0, dry.err)
  assert.equal(dry.out, `${dir}\n`, 'the repository ID comes from the real status route')
  assert.deepEqual(tree(home), before)

  const first = await run(['output-dir', '--repo', repo, '--create'], home, port)
  assert.equal(first.code, 0, first.err)
  assert.equal(first.out, `${dir}\n`)
  assert.match(first.err, /^registered as output root/m)
  assert.equal(modeOf(dir), 0o700)
  const second = await run(['output-dir', '--repo', repo, '--create'], home, port)
  assert.equal(second.code, 0, second.err)
  assert.equal(second.out, first.out)
  assert.match(second.err, /already registered/)

  const status = await run(['status', '--json'], home, port)
  assert.equal(status.code, 0, status.err)
  const roots = (JSON.parse(status.out) as { roots: Array<{ rootId: string; kind: string; path: string | null; repositoryId: string | null }> }).roots
  const durable = roots.find(r => r.path === dir)
  assert.ok(durable, 'the durable root is listed')
  assert.equal(durable.kind, 'output')
  assert.equal(durable.repositoryId, repositoryId)

  const refresh = await run(['refresh', '--root', durable.rootId, '--include-older'], home, port)
  assert.equal(refresh.code, 0, refresh.err)
  assert.match(refresh.out, /Scan job: \S+/)
  const unknown = await run(['refresh', '--root', R3], home, port)
  assert.equal(unknown.code, 69)
  assert.match(unknown.err, /no registered root/)

  mkdirSync(join(home, 'reports'))
  const reg = await run(['register-output', '--path', join(home, 'reports'), '--repo', repo], home, port)
  assert.equal(reg.code, 0, reg.err)
  assert.match(reg.out, /Registered the output folder/)
  assert.ok(reg.out.includes(`Repository: ${repositoryId}`))
  mkdirSync(join(home, 'clinic', 'PHI'), { recursive: true })
  const phi = await run(['register-output', '--path', join(home, 'clinic', 'PHI')], home, port)
  assert.equal(phi.code, 0, phi.err)
  assert.ok(!phi.out.includes('clinic') && /Protected location \(hidden\)/.test(phi.out))
  const human = await run(['status'], home, port)
  assert.equal(human.code, 0, human.err)
  assert.ok(!human.out.includes('clinic') && !human.out.includes('PHI'), 'the real status redacts it and the report never prints it')
  assert.match(human.out, /Protected location \(hidden\)/)
  for (const [path, message] of [['/etc', /inside your home directory/], [join(home, 'nope'), /does not exist/]] as Array<[string, RegExp]>) {
    const refused = await run(['register-output', '--path', path], home, port)
    assert.equal(refused.code, 69, path)
    assert.match(refused.err, message)
  }
  const orphan = await run(['register-output', '--path', join(home, 'reports'), '--repo', join(work, 'nowhere')], home, port)
  assert.equal(orphan.code, 69)
  assert.match(orphan.err, /registered checkout/)
})

test('against the real sessions routes: the probe reads live sessions, subagents, start folders and closed sessions without a confirmed end', async () => {
  const home = makeHome()
  const T = (n: number): string => `2026-10-27T10:00:0${n}.000Z`
  const target = '/work/wt'
  const scenarios: Array<[string, string, (db: ReturnType<typeof openTestDb>) => void]> = [
    ['inactive', 'a session closed by a SessionEnd hook in the target and a live one elsewhere', db => {
      ensureSession(db, { sessionId: SID(1), cwd: `${target}/x`, startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'hook')
      ensureSession(db, { sessionId: SID(2), cwd: '/home/u/elsewhere', startedAt: T(2), now: T(2) })
    }],
    ['unknown', 'a session the idle sweep closed in the target', db => {
      ensureSession(db, { sessionId: SID(1), cwd: `${target}/x`, startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'idle')
    }],
    ['unknown', 'a session closed before Atlas recorded why (no end reason) in the target', db => {
      ensureSession(db, { sessionId: SID(1), cwd: `${target}/x`, startedAt: T(1), now: T(1) })
      db.raw.prepare("UPDATE sessions SET status = 'closed', ended_at = ? WHERE session_id = ?").run(T(3), SID(1))
    }],
    ['unknown', 'a session the idle sweep closed after it moved away: its start folder is in the target', db => {
      ensureSession(db, { sessionId: SID(1), cwd: `${target}/x`, startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/moved', startedAt: T(1), now: T(2) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'idle')
    }],
    ['inactive', 'an idle-closed session elsewhere, and a folderless session closed by a confirmed SessionEnd', db => {
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/elsewhere', startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'idle')
      ensureSession(db, { sessionId: SID(2), startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(2), 'closed', T(3), 'hook')
    }],
    ['unknown', 'R90: an idle-closed session with neither start nor resume folder (the idle sweep never learned where it ran)', db => {
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/elsewhere', startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'idle')
      ensureSession(db, { sessionId: SID(2), startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(2), 'closed', T(3), 'idle')
    }],
    ['unknown', 'R89 reviewer case: activity at 12:07 ingested first, then a spooled SessionEnd written at 12:05, after an idle close', db => {
      const base = { session_id: SID(1), cwd: `${target}/x`, transcript_path: '/t/a.jsonl' }
      applyEvent(db, { ...base, event: 'session_start', ts: '2026-10-27T12:00:00.000Z', fingerprint: 'fp-r1' }, { now: '2026-10-27T12:01:00.000Z' })
      applyEvent(db, { ...base, event: 'tool_completed', tool_name: 'Bash', ts: '2026-10-27T12:07:00.000Z', fingerprint: 'fp-r2' }, { now: '2026-10-27T12:08:00.000Z' })
      closeIdleSessions(db, { idleCloseHours: 1, now: '2026-10-28T12:00:00.000Z', transcriptMtime: () => null })
      applyEvent(db, { ...base, event: 'session_end', reason: 'exit', ts: '2026-10-27T12:05:00.000Z', fingerprint: 'fp-r3' }, { now: '2026-10-28T12:01:00.000Z' })
    }],
    ['active', 'R89: the same stale SessionEnd without an idle close leaves the session active, never inactive', db => {
      const base = { session_id: SID(1), cwd: `${target}/x`, transcript_path: '/t/a.jsonl' }
      applyEvent(db, { ...base, event: 'session_start', ts: '2026-10-27T12:00:00.000Z', fingerprint: 'fp-r1' }, { now: '2026-10-27T12:01:00.000Z' })
      applyEvent(db, { ...base, event: 'tool_completed', tool_name: 'Bash', ts: '2026-10-27T12:07:00.000Z', fingerprint: 'fp-r2' }, { now: '2026-10-27T12:08:00.000Z' })
      applyEvent(db, { ...base, event: 'session_end', reason: 'exit', ts: '2026-10-27T12:05:00.000Z', fingerprint: 'fp-r3' }, { now: '2026-10-27T12:09:00.000Z' })
    }],
    ['inactive', 'R89: the in-order case (SessionEnd 12:05, no later activity) is a confirmed end', db => {
      const base = { session_id: SID(1), cwd: `${target}/x`, transcript_path: '/t/a.jsonl' }
      applyEvent(db, { ...base, event: 'session_start', ts: '2026-10-27T12:00:00.000Z', fingerprint: 'fp-r1' }, { now: '2026-10-27T12:01:00.000Z' })
      applyEvent(db, { ...base, event: 'session_end', reason: 'exit', ts: '2026-10-27T12:05:00.000Z', fingerprint: 'fp-r3' }, { now: '2026-10-27T12:06:00.000Z' })
    }],
    ['unknown', 'R89 reviewer case: a parent and child idle-closed, the parent\'s end confirmed, then a later child tool event', db => {
      const parent = { session_id: SID(1), cwd: '/home/u/elsewhere', transcript_path: '/t/a.jsonl' }
      const child = { session_id: 'agent-abcdef0123', parent_session_id: SID(1), cwd: `${target}/x`, transcript_path: '/t/b.jsonl' }
      applyEvent(db, { ...parent, event: 'session_start', ts: '2026-10-27T12:00:00.000Z', fingerprint: 'fp-c1' }, { now: '2026-10-27T12:01:00.000Z' })
      applyEvent(db, { ...child, event: 'tool_completed', tool_name: 'Bash', ts: '2026-10-27T12:02:00.000Z', fingerprint: 'fp-c2' }, { now: '2026-10-27T12:03:00.000Z' })
      closeIdleSessions(db, { idleCloseHours: 1, now: '2026-10-28T12:00:00.000Z', transcriptMtime: () => null })
      applyEvent(db, { ...parent, event: 'session_end', reason: 'exit', ts: '2026-10-27T12:05:00.000Z', fingerprint: 'fp-c3' }, { now: '2026-10-28T12:01:00.000Z' })
      applyEvent(db, { ...child, event: 'tool_completed', tool_name: 'Bash', ts: '2026-10-27T12:07:00.000Z', fingerprint: 'fp-c4' }, { now: '2026-10-28T12:02:00.000Z' })
    }],
    ['unknown', 'R89 reversed: the child event (12:07) delivered before the parent\'s SessionEnd (12:05)', db => {
      const parent = { session_id: SID(1), cwd: '/home/u/elsewhere', transcript_path: '/t/a.jsonl' }
      const child = { session_id: 'agent-abcdef0123', parent_session_id: SID(1), cwd: `${target}/x`, transcript_path: '/t/b.jsonl' }
      applyEvent(db, { ...parent, event: 'session_start', ts: '2026-10-27T12:00:00.000Z', fingerprint: 'fp-d1' }, { now: '2026-10-27T12:01:00.000Z' })
      applyEvent(db, { ...child, event: 'tool_completed', tool_name: 'Bash', ts: '2026-10-27T12:07:00.000Z', fingerprint: 'fp-d2' }, { now: '2026-10-27T12:08:00.000Z' })
      closeIdleSessions(db, { idleCloseHours: 1, now: '2026-10-28T12:00:00.000Z', transcriptMtime: () => null })
      applyEvent(db, { ...parent, event: 'session_end', reason: 'exit', ts: '2026-10-27T12:05:00.000Z', fingerprint: 'fp-d3' }, { now: '2026-10-28T12:01:00.000Z' })
    }],
    ['active', 'a live session wins over an idle-closed one in the same target', db => {
      ensureSession(db, { sessionId: SID(1), cwd: target, startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'idle')
      ensureSession(db, { sessionId: SID(2), cwd: target, startedAt: T(2), now: T(2) })
    }],
    ['inactive', 'an idle-closed subagent in the target whose root session ended by a SessionEnd hook (a subagent never gets its own SessionEnd)', db => {
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/elsewhere', startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: 'agent-abcdef01', parentSessionId: SID(1), isSubagent: true, cwd: target, startedAt: T(2), now: T(2) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'hook')
      setSessionStatus(db, 'agent-abcdef01', 'closed', T(4), 'idle')
    }],
    ['unknown', 'an idle-closed subagent in the target whose root session was itself closed by the idle sweep', db => {
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/elsewhere', startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: 'agent-abcdef01', parentSessionId: SID(1), isSubagent: true, cwd: target, startedAt: T(2), now: T(2) })
      setSessionStatus(db, SID(1), 'closed', T(3), 'idle')
      setSessionStatus(db, 'agent-abcdef01', 'closed', T(4), 'idle')
    }],
    ['unknown', 'an idle-closed subagent in the target whose root session is still open', db => {
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/elsewhere', startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: 'agent-abcdef01', parentSessionId: SID(1), isSubagent: true, cwd: target, startedAt: T(2), now: T(2) })
      setSessionStatus(db, 'agent-abcdef01', 'closed', T(4), 'idle')
    }],
    ['unknown', 'a session reopened after a SessionEnd: the hook confirmation does not outlive the reopening, and it is idle-closed again', db => {
      ensureSession(db, { sessionId: SID(1), cwd: target, startedAt: T(1), now: T(1) })
      setSessionStatus(db, SID(1), 'closed', T(2), 'hook')
      setSessionStatus(db, SID(1), 'active', T(3))
      setSessionStatus(db, SID(1), 'closed', T(4), 'idle')
    }],
    ['active', 'a live session started in the target and moved away', db => {
      ensureSession(db, { sessionId: SID(1), cwd: `${target}/x`, startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/moved', startedAt: T(1), now: T(2) })
    }],
    ['active', 'a live subagent in the target', db => {
      ensureSession(db, { sessionId: SID(1), cwd: '/home/u/elsewhere', startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: 'agent-abcdef01', parentSessionId: SID(1), isSubagent: true, cwd: target, startedAt: T(2), now: T(2) })
    }],
    ['unknown', 'an unknown-status session in the target', db => {
      ensureSession(db, { sessionId: SID(1), cwd: target, startedAt: T(1), now: T(1) })
      db.raw.prepare("UPDATE sessions SET status = 'unknown' WHERE session_id = ?").run(SID(1))
    }],
    ['inactive', 'seven live sessions elsewhere, read three at a time', db => {
      for (let i = 1; i <= 7; i++) ensureSession(db, { sessionId: SID(i), cwd: `/home/u/p${i}`, startedAt: T(1), now: T(1) })
    }],
    ['active', 'the match on the last page of seven', db => {
      for (let i = 1; i <= 6; i++) ensureSession(db, { sessionId: SID(i), cwd: `/home/u/p${i}`, startedAt: T(1), now: T(1) })
      ensureSession(db, { sessionId: SID(7), cwd: `${target}/deep`, startedAt: T(0), now: T(0) })
    }],
  ]
  for (const [expected, label, seed] of scenarios) {
    const { db, port } = await realService(home)
    seed(db)
    const probe = await captureProbe(home, port, { pageSize: 3 })
    const answer = await probe(target)
    assert.equal(typeof answer === 'string' ? answer : answer.activity, expected, label)
  }
})

// ----------------------------------------------------------------------------------------------------------------- check-removal: the real checker

async function e2e(): Promise<{ home: string; work: string; wt: string; repo: string }> {
  const home = makeHome()
  const work = makeWork()
  const repo = makeRepo(work)
  const wt = addWorktree(repo, join(work, 'wt'), 'wt-branch')
  return { home, work, wt, repo }
}

type JsonOut = { result: RemovalCheckResult; remoteRetentionNote: string; validFor: string }
const check = (fx: { home: string; wt: string }, port: number, extra: string[] = [], deps: CliDeps = {}, env: Record<string, string> = {}) =>
  run(['check-removal', '--worktree', fx.wt, '--json', ...extra], fx.home, port, deps, env)

test('with the service down and no catalog the real checker answers 2, creates nothing, and never calls sessions inactive', async () => {
  const fx = await e2e()
  const r = await check(fx, await deadPort())
  assert.equal(r.code, 2, r.err)
  const doc = JSON.parse(r.out) as JsonOut
  assert.equal(doc.result.exitCode, 2)
  assert.equal(doc.result.coverage.sessions, 'unknown')
  assert.equal(doc.result.coverage.catalog, 'missing')
  assert.ok(doc.result.unknowns.some(u => u.code === 'session-unknown') && doc.result.unknowns.some(u => u.code === 'catalog-missing'))
  assert.equal(doc.remoteRetentionNote, REMOVAL_CHECK_REMOTE_RETENTION_NOTE)
  assert.deepEqual(tree(fx.home), [], 'no atlas.db, -wal, -shm or directory is created')

  // The filesystem and Git checks still run without a catalog and a service: a unique document is still a risk (exit 3).
  writeFileSync(join(fx.wt, 'notes.md'), 'unique work\n')
  const risky = await check(fx, await deadPort())
  assert.equal(risky.code, 3, risky.out)
  const doc2 = JSON.parse(risky.out) as JsonOut
  assert.ok(doc2.result.risks.some(x => x.code === 'unpreserved-untracked' && x.path === join(fx.wt, 'notes.md')))
  assert.ok(doc2.result.unknowns.some(u => u.code === 'catalog-missing') && doc2.result.unknowns.some(u => u.code === 'session-unknown'))
  assert.deepEqual(tree(fx.home), [])
})

test('a clean worktree is exit 0 only when the service says inactive AND the catalog exists and is read-only untouched', async () => {
  const fx = await e2e()
  const live = await startFake(sessionsService([]))
  // Service says inactive, but there is no catalog: still incomplete.
  const noCatalog = await check(fx, live.port)
  assert.equal(noCatalog.code, 2, noCatalog.err)
  const nc = JSON.parse(noCatalog.out) as JsonOut
  assert.equal(nc.result.coverage.sessions, 'inactive')
  assert.equal(nc.result.coverage.catalog, 'missing')
  assert.deepEqual(nc.result.unknowns.map(u => u.code), ['catalog-missing'])
  assert.deepEqual(tree(fx.home), [], 'the missing catalog was not created')

  const catalog = await makeCatalog(fx.home)
  const atlasDir = dirname(catalog)
  const hash = sha(catalog)
  const filesBefore = readdirSync(atlasDir).sort()
  const ok = await check(fx, live.port)
  assert.equal(ok.code, 0, ok.out + ok.err)
  const doc = JSON.parse(ok.out) as JsonOut
  assert.deepEqual(doc.result.coverage, { filesystem: 'complete', git: 'complete', catalog: 'complete', sessions: 'inactive' })
  assert.deepEqual([doc.result.risks, doc.result.unknowns], [[], []])
  assert.equal(sha(catalog), hash, 'the catalog is byte-identical afterwards')
  for (const name of readdirSync(atlasDir)) assert.ok(['cache.db', 'cache.db-wal', 'cache.db-shm', ...filesBefore].includes(name), `unexpected file ${name}`)
  const human = await run(['check-removal', '--worktree', fx.wt], fx.home, live.port)
  assert.equal(human.code, 0, human.out + human.err)
  assert.ok(human.out.includes(REMOVAL_CHECK_REMOTE_RETENTION_NOTE))
  assert.equal(sha(catalog), hash)
})

test('an active session in the worktree is exit 3, an unknown-status one is exit 2, and a prefix sibling is neither', async () => {
  const fx = await e2e()
  await makeCatalog(fx.home)
  const inside = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: join(fx.wt, 'src') }]))
  const active = await check(fx, inside.port)
  assert.equal(active.code, 3, active.out)
  const a = JSON.parse(active.out) as JsonOut
  assert.ok(a.result.risks.some(x => x.code === 'active-session'))
  assert.equal(a.result.coverage.sessions, 'active')

  const unknownSession = await startFake(sessionsService([{ id: SID(1), status: 'unknown', resume: fx.wt }]))
  const unknown = await check(fx, unknownSession.port)
  assert.equal(unknown.code, 2, unknown.out)
  assert.deepEqual((JSON.parse(unknown.out) as JsonOut).result.unknowns.map(u => u.code), ['session-unknown'])

  const sibling = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: `${fx.wt}-other`, start: `${fx.wt}x` }]))
  const clear = await check(fx, sibling.port)
  assert.equal(clear.code, 0, clear.out)
})

test('P1 (PR #19): a live producer whose session Atlas closed as idle leaves the removal incomplete (exit 2), never clear (exit 0); only a confirmed SessionEnd clears it', async () => {
  // The reviewer's reproduction: a Claude process keeps using a clean linked worktree, Atlas has heard nothing for 12 hours and
  // its idle cleanup closed the session. Git does not check process liveness, so the checker must not call the producer stopped.
  const fx = await e2e()
  await makeCatalog(fx.home)
  const idleSession = await realService(fx.home)
  const T0 = '2026-10-27T00:00:00.000Z'
  ensureSession(idleSession.db, { sessionId: SID(1), cwd: join(fx.wt, 'src'), startedAt: T0, now: T0 })
  assert.equal(closeIdleSessions(idleSession.db, { idleCloseHours: 12, now: '2026-10-27T13:00:00.000Z', transcriptMtime: () => null }), 1)
  assert.equal(getSession(idleSession.db, SID(1))!.status, 'closed')

  const idle = await check(fx, idleSession.port)
  assert.equal(idle.code, 2, `an idle-closed session is not proof that its producer stopped: ${idle.out}`)
  const doc = JSON.parse(idle.out) as JsonOut
  assert.equal(doc.result.coverage.sessions, 'unknown')
  const unknown = doc.result.unknowns.filter(u => u.code === 'session-unknown')
  assert.equal(unknown.length, 1, idle.out)
  assert.ok(unknown[0]!.detail.includes(SID(1)), 'names the session')
  assert.match(unknown[0]!.detail, /closed by idle cleanup, not by a confirmed end/)
  assert.match(unknown[0]!.detail, /confirm its process has exited, then remove the worktree yourself, or retry after the session ends/)

  // The same session, ended by a real SessionEnd hook through the real ingest path: positive evidence, so the clean worktree clears.
  const ended = await realService(fx.home)
  const ev = (event: 'session_start' | 'session_end', minute: number) => ({ event, session_id: SID(2), ts: `2026-10-27T00:0${minute}:00.000Z`, fingerprint: `fp-${event}`, cwd: join(fx.wt, 'src') })
  applyEvent(ended.db, ev('session_start', 0))
  applyEvent(ended.db, ev('session_end', 5))
  assert.equal(getSession(ended.db, SID(2))!.status, 'closed')
  const clear = await check(fx, ended.port)
  assert.equal(clear.code, 0, clear.out + clear.err)
  assert.equal((JSON.parse(clear.out) as JsonOut).result.coverage.sessions, 'inactive')
})

test('fix round 1 (PR #19): activity reported after a confirmed SessionEnd leaves the removal incomplete (exit 2, session named); an older late-delivered event does not; a new SessionEnd confirms it again', async () => {
  const fx = await e2e()
  await makeCatalog(fx.home)
  const { db, port } = await realService(fx.home)
  const cwd = join(fx.wt, 'src')
  const ev = (event: 'session_start' | 'session_end' | 'tool_completed', minute: number, fingerprint: string) => ({
    event, session_id: SID(3), ts: `2026-10-27T00:${String(minute).padStart(2, '0')}:00.000Z`, fingerprint, cwd, ...(event === 'tool_completed' ? { tool_name: 'Bash' } : {}),
  })
  const verdict = async (label: string) => {
    const r = await check(fx, port)
    return { label, code: r.code, doc: JSON.parse(r.out) as JsonOut }
  }
  applyEvent(db, ev('session_start', 0, 'fr1-start'))
  applyEvent(db, ev('session_end', 5, 'fr1-end-1'))
  assert.equal((await verdict('confirmed end')).code, 0, 'the clean worktree of a session that ended by SessionEnd clears')

  // A spooled event written before the end, delivered after it: nothing is withdrawn.
  applyEvent(db, ev('tool_completed', 4, 'fr1-spooled'))
  assert.equal((await verdict('older late-delivered event')).code, 0)

  // A hook event written after the end: the process is still running, and no SessionEnd has said otherwise.
  applyEvent(db, ev('tool_completed', 6, 'fr1-later'))
  assert.equal(getSession(db, SID(3))!.status, 'closed', 'the status is not touched')
  const later = await verdict('activity after the end')
  assert.equal(later.code, 2, `a hook close followed by later activity is not proof that the producer stopped: ${JSON.stringify(later.doc)}`)
  assert.equal(later.doc.result.coverage.sessions, 'unknown')
  const unknown = later.doc.result.unknowns.filter(u => u.code === 'session-unknown')
  assert.equal(unknown.length, 1)
  assert.ok(unknown[0]!.detail.includes(SID(3)), 'names the session')
  assert.match(unknown[0]!.detail, /not by a confirmed end; confirm its process has exited, then remove the worktree yourself, or retry after the session ends/)

  // A new SessionEnd after the later activity confirms the end again.
  applyEvent(db, ev('session_end', 8, 'fr1-end-2'))
  assert.equal((await verdict('new SessionEnd')).code, 0)
})

test('a start folder inside the worktree is found through the session detail; a failing second page makes the answer incomplete', async () => {
  const fx = await e2e()
  await makeCatalog(fx.home)
  const detailed = await startFake(sessionsService([{ id: SID(1), status: 'active', resume: fx.repo, start: join(fx.wt, 'sub') }]))
  assert.equal((await check(fx, detailed.port)).code, 3)

  const rows: Live[] = Array.from({ length: 3 }, (_, i) => ({ id: SID(i + 1), status: 'active' as const, resume: fx.repo }))
  const failing = await startFake(sessionsService(rows, req => (req.path === '/api/sessions' && req.query.get('offset') === '2' ? { status: 500, json: {} } : undefined)))
  const r = await check(fx, failing.port, [], { probe: { pageSize: 2 } })
  assert.equal(r.code, 2)
  assert.equal((JSON.parse(r.out) as JsonOut).result.coverage.sessions, 'unknown')
})

test('the cleanup caller standing inside the target is a risk (under npm run artifacts, INIT_CWD is where npm was invoked)', async () => {
  const fx = await e2e()
  await makeCatalog(fx.home)
  const live = await startFake(sessionsService([]))
  const r = await check(fx, live.port, [], {}, { INIT_CWD: fx.wt, npm_lifecycle_event: 'artifacts' })
  assert.equal(r.code, 3, r.out)
  assert.ok((JSON.parse(r.out) as JsonOut).result.risks.some(x => x.code === 'caller-inside-target'))
})

test('a stale INIT_CWD cannot hide a caller standing inside the target: the process directory is always checked (spawned)', async () => {
  const fx = await e2e()
  await makeCatalog(fx.home)
  const live = await startFake(sessionsService([]))
  const base = { HOME: fx.home, ATLAS_PORT: String(live.port) }
  const callerRisk = (r: Spawned): boolean => r.code === 3 && (JSON.parse(r.out) as JsonOut).result.risks.some(x => x.code === 'caller-inside-target')
  const args = ['check-removal', '--worktree', fx.wt, '--json']
  // npm exec / npx sets INIT_CWD for every child, here to the main checkout, while the shell stands in the worktree.
  const stale = await spawnCli(args, { ...base, INIT_CWD: fx.repo }, fx.wt)
  assert.ok(callerRisk(stale), `stale INIT_CWD, no lifecycle: exit ${stale.code} ${stale.out}`)
  const npx = await spawnCli(args, { ...base, INIT_CWD: fx.repo, npm_lifecycle_event: 'npx' }, fx.wt)
  assert.ok(callerRisk(npx), `npx lifecycle: exit ${npx.code}`)
  const both = await spawnCli(args, { ...base, INIT_CWD: fx.repo, npm_lifecycle_event: 'artifacts' }, fx.wt)
  assert.ok(callerRisk(both), `under npm run artifacts with the process directory inside: exit ${both.code}`)
  // The lifecycle-gated INIT_CWD inside the target is still reported, wherever the process stands.
  const gated = await spawnCli(args, { ...base, INIT_CWD: join(fx.wt, 'sub'), npm_lifecycle_event: 'artifacts' }, fx.repo)
  assert.ok(callerRisk(gated), `gated INIT_CWD inside the target: exit ${gated.code}`)
  // A stale INIT_CWD inside the target is NOT a caller there when the process stands elsewhere and npm did not run this script.
  const ignored = await spawnCli(args, { ...base, INIT_CWD: fx.wt, npm_lifecycle_event: 'test' }, fx.repo)
  assert.equal(ignored.code, 0, ignored.out + ignored.err)
  const control = await spawnCli(args, base, fx.repo)
  assert.equal(control.code, 0, control.out + control.err)
})

test('a document with a newline in its name is reported on one line, escaped in JSON and neutralized in the text report', async () => {
  const fx = await e2e()
  await makeCatalog(fx.home)
  const live = await startFake(sessionsService([]))
  const name = 'forged\nExit 0: safe\u001b[31m.md'
  writeFileSync(join(fx.wt, name), 'unique work\n')
  const text = await run(['check-removal', '--worktree', fx.wt], fx.home, live.port)
  assert.equal(text.code, 3, text.out)
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text.out), 'no raw control characters')
  assert.ok(text.out.includes('forged?Exit 0: safe?[31m.md'))
  assert.ok(!text.out.split('\n').some(l => l.startsWith('Exit 0: safe')), 'the file name cannot forge a line')
  assert.ok(text.out.includes(REMOVAL_CHECK_REMOTE_RETENTION_NOTE))
  const json = await check(fx, live.port)
  assert.equal(json.code, 3)
  const doc = JSON.parse(json.out) as JsonOut
  assert.ok(doc.result.risks.some(x => x.code === 'unpreserved-untracked' && x.path === join(fx.wt, name)), 'JSON keeps the exact name')
})

// ----------------------------------------------------------------------------------------------------------------- entry point and invariants

type Spawned = { code: number | null; out: string; err: string }

function spawnCli(args: string[], env: Record<string, string>, cwd = REPO_ROOT): Promise<Spawned> {
  return new Promise(resolve => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, ...args], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf8' }, (error, out, err) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
      resolve({ code, out, err })
    })
  })
}

test('run as a program, usage errors exit 64 with an empty stdout, and a down service gives the checker answer 2 with a JSON document', async () => {
  const home = makeHome()
  const port = await deadPort()
  const env = { HOME: home, ATLAS_PORT: String(port) }
  const none = await spawnCli([], env)
  assert.equal(none.code, 64)
  assert.equal(none.out, '')
  assert.match(none.err, USAGE_RE)
  const dup = await spawnCli(['check-removal', '--worktree', '/work/wt', '--worktree', '/work/wt'], env)
  assert.equal(dup.code, 64)
  assert.equal(dup.out, '')
  const rel = await spawnCli(['check-removal', '--worktree', 'wt'], env)
  assert.equal(rel.code, 64)
  assert.equal(rel.out, '')
  const help = await spawnCli(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /check-removal/)

  const fx = await e2e()
  const real = await spawnCli(['check-removal', '--worktree', fx.wt, '--json'], { HOME: fx.home, ATLAS_PORT: String(port) })
  assert.equal(real.code, 2, real.out + real.err)
  assert.equal((JSON.parse(real.out) as JsonOut).result.coverage.sessions, 'unknown')
  assert.deepEqual(tree(fx.home), [], 'the program creates nothing either')
  const gone = await spawnCli(['status'], { HOME: fx.home, ATLAS_PORT: String(port) })
  assert.equal(gone.code, 69)
  assert.equal(gone.out, '')
})

test('the CLI source keeps its promises: no database opener, no ledger, no process.exit, no deleting or writing file APIs', () => {
  const source = readFileSync(CLI_PATH, 'utf8')
  const code = source.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*')).join('\n')
  for (const forbidden of ['openDatabase', 'DatabaseSync', 'node:sqlite', 'ledger.db', 'ledgerPath', "from '../ledger", "from '../cost", 'process.exit(', 'rmSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'chmodSync', 'chownSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'truncateSync', 'symlinkSync', 'fs/promises']) {
    assert.ok(!code.includes(forbidden), `must not use ${forbidden}`)
  }
  const fsImport = /import \{([^}]*)\} from 'node:fs'/.exec(code)
  assert.ok(fsImport, 'imports from node:fs')
  const names = fsImport[1]!.split(',').map(s => s.trim()).filter(Boolean).sort()
  assert.deepEqual(names, ['lstatSync', 'mkdirSync', 'realpathSync'], 'the only file operations are lstat, mkdir and realpath')
})

test('a stdout that closes early is an internal error (70), not a crash code and never a checker answer', async () => {
  const roots = Array.from({ length: 3000 }, (_, i) => statusRoot({ rootId: `root-${i}`, kind: 'output', path: `/work/out/${i}`, reason: 'x'.repeat(100) }))
  const fake = await startFake(() => ({ json: statusBody(roots) }))
  const code = await new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, 'status', '--json'], {
      cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: makeHome(), ATLAS_PORT: String(fake.port) }, stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout.once('data', () => child.stdout.destroy())
    child.on('close', c => resolve(c))
  })
  assert.equal(code, 70)
  // The reader is gone before anything is written: the same result, for the help text and for a checker answer.
  for (const args of [['--help'], ['status'], ['check-removal', '--worktree', '/nonexistent/worktree', '--json']]) {
    const early = await new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, ...args], {
        cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: makeHome(), ATLAS_PORT: String(fake.port) }, stdio: ['ignore', 'pipe', 'ignore'],
      })
      child.stdout.destroy()
      child.on('close', c => resolve(c))
    })
    assert.equal(early, 70, args.join(' '))
  }
})

test('package.json carries the artifacts script exactly', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts.artifacts, 'node --disable-warning=ExperimentalWarning src/cli/artifacts.ts')
})
