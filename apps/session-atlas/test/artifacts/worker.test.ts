import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import diagnosticsChannel from 'node:diagnostics_channel'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, constants as fsConstants, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { ArtifactWorkerFrame, ArtifactWorkerObservation, ArtifactWorkerRequest, ArtifactWorkerRoot } from '../../src/artifacts/contracts.ts'
import { ARTIFACT_IPC_LIMITS, encodeArtifactWorkerFrame, validateArtifactWorkerFrame } from '../../src/artifacts/discovery.ts'
import { runArtifactWorker } from '../../src/artifacts/worker-main.ts'

// Cleanup is registered before the first temporary directory exists and runs on exit, on failed assertions and on
// SIGINT/SIGTERM/SIGHUP: every spawned worker (and any Git child it leaves) is killed, every FIFO reader released, then every
// temporary directory removed.
const TEMP_DIRS = new Set<string>()
const CHILDREN = new Set<ChildProcess>()
const FIFOS = new Set<string>()
diagnosticsChannel.subscribe('child_process', message => {
  const child = (message as { process?: ChildProcess }).process
  if (!child) return
  CHILDREN.add(child)
  child.once('exit', () => CHILDREN.delete(child))
})
function releaseFifo(fifo: string): void {
  try { closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)) } catch { /* no reader is waiting */ }
}
function cleanup(): void {
  for (const child of CHILDREN) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* not a group leader */ }
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  CHILDREN.clear()
  for (const fifo of FIFOS) releaseFifo(fifo)
  FIFOS.clear()
  for (const dir of TEMP_DIRS) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
  TEMP_DIRS.clear()
}
process.on('exit', cleanup)
// Also once every test in this file has run (passed or failed): a still-running child would keep the file from exiting.
after(cleanup)
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.once(signal, () => { cleanup(); process.exit(code) })
}

for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-worker-home-')))
TEMP_DIRS.add(HOME)
process.env.HOME = HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKER = join(REPO_ROOT, 'src', 'artifacts', 'worker-main.ts')
const DISCOVERY = join(REPO_ROOT, 'src', 'artifacts', 'discovery.ts')
const EXTS = ['md', 'txt', 'json', 'csv', 'pdf', 'html', 'sql']
const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false']

function newDir(prefix = 'root-'): string {
  return realpathSync(mkdtempSync(join(HOME, prefix)))
}
function put(root: string, rel: string, content = 'x\n'): string {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}
let seq = 0
function root(path: string, over: Partial<ArtifactWorkerRoot> = {}): ArtifactWorkerRoot {
  return { rootId: `root-${++seq}`, kind: 'output', canonicalPath: path, repositoryId: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'], ...over }
}
function request(r: ArtifactWorkerRoot, over: Partial<ArtifactWorkerRequest> = {}): ArtifactWorkerRequest {
  return {
    jobId: `job-${++seq}`, root: r, generation: 1, task: 'output-walk', cursor: null, includeOlder: true, documentExtensions: EXTS, ignoreSegments: [],
    limits: { maxEntries: 5000, maxMs: 60_000, gitTimeoutMs: 10_000, gitMaxOutputBytes: 8 * 1024 * 1024 }, ...over,
  }
}

// ------------------------------------------------------------------------------------------------------------------ harness

type Harness = {
  child: ChildProcess
  received: ArtifactWorkerFrame[]
  next(timeoutMs?: number): Promise<ArtifactWorkerFrame>
  quiet(ms: number): Promise<void>
  send(value: unknown): void
  sendRaw(bytes: string | Buffer): void
  ack(jobId: string): void
  run(req: ArtifactWorkerRequest): Promise<ArtifactWorkerFrame[]>
  close(): void
  exited: Promise<{ code: number | null; signal: string | null; ms: number }>
  stderr(): string
}

function startWorker(extraNodeArgs: string[] = []): Harness {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...extraNodeArgs, WORKER], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  CHILDREN.add(child)
  const received: ArtifactWorkerFrame[] = []
  const queue: ArtifactWorkerFrame[] = []
  let waiter: ((f: ArtifactWorkerFrame) => void) | null = null
  let pending = ''
  let errText = ''
  let closedAt = 0
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      assert.ok(Buffer.byteLength(line) + 1 <= ARTIFACT_IPC_LIMITS.maxFrameBytes, 'a frame line fits the 1 MiB bound')
      const frame = JSON.parse(line) as ArtifactWorkerFrame
      assert.equal(validateArtifactWorkerFrame(frame), null, 'every frame the worker writes is valid')
      received.push(frame)
      if (waiter) { const w = waiter; waiter = null; w(frame) } else queue.push(frame)
    }
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => { errText += chunk })
  const exited = new Promise<{ code: number | null; signal: string | null; ms: number }>(res => {
    child.once('exit', (code, signal) => res({ code, signal, ms: closedAt ? Date.now() - closedAt : -1 }))
  })
  const h: Harness = {
    child, received, exited,
    next(timeoutMs = 15_000) {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((res, rej) => {
        const t = setTimeout(() => { waiter = null; rej(new Error(`no frame within ${timeoutMs} ms; stderr: ${errText}`)) }, timeoutMs)
        waiter = f => { clearTimeout(t); res(f) }
      })
    },
    async quiet(ms) {
      await new Promise(r => setTimeout(r, ms))
      assert.equal(queue.length, 0, `no frame arrives within ${ms} ms`)
    },
    send(value) { child.stdin!.write(JSON.stringify(value) + '\n') },
    sendRaw(bytes) { child.stdin!.write(bytes) },
    ack(jobId) { child.stdin!.write(JSON.stringify({ type: 'ack', jobId }) + '\n') },
    async run(req) {
      h.send(req)
      const frames: ArtifactWorkerFrame[] = []
      for (;;) {
        const f = await h.next()
        assert.equal(f.jobId, req.jobId)
        frames.push(f)
        h.ack(req.jobId)
        if (f.rows.length === 0) return frames
      }
    },
    close() { closedAt = Date.now(); child.stdin!.end() },
    stderr: () => errText,
  }
  return h
}

// --------------------------------------------------------------------------------------------------------- DB-free module graph

function runtimeImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Only a whole `import type` clause is erased; `import { type A } from 'x'` still loads 'x'.
      if (node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)) {
      out.push('<import-equals>')
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      out.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '<dynamic-import>')
    } else if (ts.isIdentifier(node) && (node.text === 'require' || node.text === 'createRequire')) {
      out.push(`<${node.text}>`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function moduleGraph(entries: string[]): { files: string[]; specifiers: string[] } {
  const files = new Set<string>()
  const specifiers = new Set<string>()
  const stack = [...entries]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of runtimeImports(file)) {
      specifiers.add(spec)
      if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec))
    }
  }
  return { files: [...files].sort(), specifiers: [...specifiers].sort() }
}

test('the worker module graph contains no database module, statically', () => {
  const graph = moduleGraph([WORKER, DISCOVERY])
  const relFiles = graph.files.map(f => f.slice(REPO_ROOT.length + 1))
  assert.ok(relFiles.includes('src/artifacts/git.ts') && relFiles.includes('src/artifacts/path-policy.ts'), `graph was walked: ${relFiles}`)
  for (const f of relFiles) assert.ok(!f.startsWith('src/db/'), `${f} must not be in the worker graph`)
  for (const s of graph.specifiers) {
    assert.ok(!/sqlite/i.test(s), `${s} must not be imported`)
    assert.ok(!s.startsWith('<'), `no dynamic or CommonJS loading (${s})`)
    assert.ok(s.startsWith('.') || s.startsWith('node:'), `only relative or built-in modules (${s})`)
    assert.notEqual(s, 'node:module')
  }

  // The walker itself sees what it must catch.
  const probeDir = newDir('probe-')
  writeFileSync(join(probeDir, 'a.ts'), "import type { X } from './typeonly.ts'\nimport { type Y } from './loaded.ts'\nimport('node:sqlite')\n")
  assert.deepEqual(runtimeImports(join(probeDir, 'a.ts')).sort(), ['./loaded.ts', 'node:sqlite'])
})

test('the running worker process never loads node:sqlite or a src/db module', async () => {
  const hook = [
    "import { registerHooks } from 'node:module';",
    'const seen = new Set();',
    'registerHooks({ resolve(specifier, context, nextResolve) { const r = nextResolve(specifier, context); seen.add(r.url); return r; } });',
    "process.on('exit', () => { process.stderr.write('ATLAS-MODULES ' + JSON.stringify({ urls: [...seen], builtins: process.moduleLoadList.filter(m => /sqlite/i.test(m)) }) + '\\n'); });",
  ].join('\n')
  const h = startWorker([`--import=data:text/javascript,${encodeURIComponent(hook)}`])
  const dir = newDir()
  const file = put(dir, 'a.md')
  const r = root(dir)
  await h.run(request(r))
  await h.run(request(r, { task: 'direct-observation', path: file }))
  h.close()
  const exit = await h.exited
  assert.equal(exit.code, 0)
  const line = h.stderr().split('\n').find(l => l.startsWith('ATLAS-MODULES '))
  assert.ok(line, `module report present; stderr: ${h.stderr()}`)
  const report = JSON.parse(line!.slice('ATLAS-MODULES '.length)) as { urls: string[]; builtins: string[] }
  assert.ok(report.urls.some(u => u.endsWith('/src/artifacts/discovery.ts')), 'the hook observed the worker graph')
  assert.deepEqual(report.builtins, [])
  for (const u of report.urls) {
    assert.ok(!/sqlite/i.test(u), u)
    assert.ok(!u.includes('/src/db/'), u)
  }
})

// --------------------------------------------------------------------------------------------------------------- protocol

test('the worker waits for each acknowledgement before it sends the next batch', async () => {
  const dir = newDir()
  for (let i = 0; i < 600; i++) put(dir, `f${String(i).padStart(3, '0')}.md`)
  const h = startWorker()
  const req = request(root(dir))
  h.send(req)
  const first = await h.next()
  assert.equal(first.rows.length, 250)
  await h.quiet(500)
  h.ack('some-other-job')
  await h.quiet(300)
  h.ack(req.jobId)
  const second = await h.next()
  assert.equal(second.rows.length, 250)
  await h.quiet(300)
  h.ack(req.jobId)
  const third = await h.next()
  assert.equal(third.rows.length, 100)
  h.ack(req.jobId)
  const end = await h.next()
  assert.equal(end.rows.length, 0)
  assert.equal(end.complete, true)
  await h.quiet(300)
  // The job ends when its terminal frame is acknowledged: a request in the same chunk, right after that ack, is accepted.
  const again = request(root(dir), { task: 'direct-observation', path: join(dir, 'f000.md') })
  h.sendRaw(`${JSON.stringify({ type: 'ack', jobId: req.jobId })}\n${JSON.stringify(again)}\n`)
  const direct = await h.next()
  assert.equal(direct.jobId, again.jobId, 'not refused as busy')
  assert.equal(direct.rows.length, 1)
  h.ack(again.jobId)
  assert.equal((await h.next()).jobId, again.jobId)
  h.ack(again.jobId)
  assert.equal(h.received.filter(f => f.jobId === req.jobId).length, 4)
  h.close()
  assert.equal((await h.exited).code, 0)
})

test('an acknowledgement that arrives before the output drains is not lost', async () => {
  const dir = newDir()
  for (let i = 0; i < 300; i++) put(dir, `f${String(i).padStart(3, '0')}.md`)
  // An asynchronous pipe (macOS): every write reports backpressure and 'drain' comes only when the test says so.
  const input = new PassThrough()
  const written: string[] = []
  const drains: Array<() => void> = []
  let wakeWriter: (() => void) | null = null
  const output = {
    write(line: string): boolean { written.push(line); wakeWriter?.(); return false },
    once(event: string, cb: () => void) { if (event === 'drain') drains.push(cb); return output },
    on() { return output },
  }
  const exits: number[] = []
  const nextLine = async (count: number): Promise<ArtifactWorkerFrame> => {
    for (let i = 0; i < 100 && written.length < count; i++) await new Promise<void>(r => { wakeWriter = r; setTimeout(r, 50) })
    assert.ok(written.length >= count, `line ${count} was written`)
    return JSON.parse(written[count - 1]!) as ArtifactWorkerFrame
  }
  const worker = runArtifactWorker({ input, output: output as unknown as NodeJS.WritableStream, log: () => {}, exit: code => { exits.push(code) } })
  const req = request(root(dir))
  input.write(`${JSON.stringify(req)}\n`)
  assert.equal((await nextLine(1)).rows.length, 250)
  input.write(`${JSON.stringify({ type: 'ack', jobId: req.jobId })}\n`) // read and acknowledged before 'drain'
  await new Promise(r => setTimeout(r, 50))
  for (const d of drains.splice(0)) d()
  assert.equal((await nextLine(2)).rows.length, 50, 'the early acknowledgement released the next frame')
  for (const d of drains.splice(0)) d()
  input.write(`${JSON.stringify({ type: 'ack', jobId: req.jobId })}\n`)
  assert.equal((await nextLine(3)).rows.length, 0)
  worker.shutdown(0)
  assert.deepEqual(exits, [0])
})

test('names with newlines, tabs, quotes and Unicode survive the NDJSON round trip', async () => {
  const dir = newDir()
  const names = ['two\nlines.md', 'tab\tname.md', 'quote"back\\slash.md', 'carriage\rreturn.md', 'é-composé.md', 'emoji-😀.md']
  for (const n of names) put(dir, n)
  const h = startWorker()
  const frames = await h.run(request(root(dir)))
  const rows: ArtifactWorkerObservation[] = frames.flatMap(f => f.rows)
  assert.deepEqual(rows.map(r => r.path).sort(), names.map(n => join(dir, n)).sort())
  assert.deepEqual(rows.map(r => r.identity.relativePath).sort(), [...names].sort())
  h.close()
  await h.exited
})

test('malformed and oversized request lines are rejected with error frames and the worker keeps serving', async () => {
  const h = startWorker()
  const expectRejection = async (code: string): Promise<void> => {
    const f = await h.next()
    assert.equal(f.jobId, '')
    assert.equal(f.rows.length, 0)
    assert.equal(f.complete, false)
    assert.equal(f.error?.code, code)
  }
  h.sendRaw('not json\n')
  await expectRejection('invalid-request')
  h.sendRaw('[1,2]\n')
  await expectRejection('invalid-request')
  h.sendRaw('{"type":"ack"}\n')
  await expectRejection('invalid-request')
  h.sendRaw('{"type":"cancel","jobId":"x"}\n')
  await expectRejection('invalid-request')
  h.sendRaw(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]))
  await expectRejection('invalid-request')
  h.sendRaw('{"jobId":"' + 'x'.repeat(ARTIFACT_IPC_LIMITS.maxLineBytes) + '"}\n')
  await expectRejection('oversized-request')
  h.sendRaw('\n\n')
  await h.quiet(200)

  // A request with a usable job ID but a broken field is answered as that job, and acknowledged like any job.
  const dir = newDir()
  put(dir, 'a.md')
  const broken = { ...request(root(dir)), task: 'everything' }
  h.send(broken)
  const refused = await h.next()
  assert.equal(refused.jobId, broken.jobId)
  assert.equal(refused.error?.code, 'invalid-request')
  h.ack(broken.jobId)

  const ok = await h.run(request(root(dir)))
  assert.equal(ok.flatMap(f => f.rows).length, 1)
  h.close()
  assert.equal((await h.exited).code, 0)
})

test('a request sent while a job is active is refused without disturbing that job', async () => {
  const dir = newDir()
  for (let i = 0; i < 300; i++) put(dir, `f${String(i).padStart(3, '0')}.md`)
  const h = startWorker()
  const req = request(root(dir))
  h.send(req)
  const first = await h.next()
  assert.equal(first.jobId, req.jobId)
  const intruder = request(root(dir))
  h.send(intruder)
  const busy = await h.next()
  assert.equal(busy.jobId, '')
  assert.equal(busy.error?.code, 'worker-busy')
  h.ack(intruder.jobId)
  await h.quiet(300)
  h.ack(req.jobId)
  const second = await h.next()
  assert.equal(second.jobId, req.jobId)
  assert.equal(second.rows.length, 50)
  h.ack(req.jobId)
  const end = await h.next()
  assert.equal(end.complete, true)
  h.ack(req.jobId)
  h.close()
  await h.exited
})

test('closing stdin ends the worker promptly while it waits for an acknowledgement', async () => {
  const dir = newDir()
  for (let i = 0; i < 300; i++) put(dir, `f${i}.md`)
  const h = startWorker()
  h.send(request(root(dir)))
  await h.next()
  h.close()
  const exit = await h.exited
  assert.equal(exit.code, 0)
  assert.ok(exit.ms < 2000, `exited in ${exit.ms} ms`)
})

/**
 * Whether a process is still running. An exited child its parent has not reaped yet (a zombie, `Z` in ps) still answers
 * kill(pid, 0), but it is gone: nothing runs, and it only waits to be reaped. `ps` is POSIX, so this holds on Linux and macOS.
 */
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z')
  } catch (error) {
    // ps exits with status 1 once the process is gone. Anything else (ps not installed, not executable) must not read as "gone".
    if ((error as { status?: number | null }).status === 1) return false
    throw error
  }
}

test('a process that exited but is not yet reaped does not count as running', async () => {
  // The shell starts a long-lived child, then becomes `sleep` (exec): from then on nothing waits for its children. Killing the
  // child after the exec leaves a zombie under a parent that never reaps it. (Killing a child that merely exited early would race
  // with the shell, which reaps it itself before the exec.)
  const holder = spawn('sh', ['-c', 'sleep 30 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let pid = 0
  const psOf = (field: string, p: number): string => { try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(p)], { encoding: 'utf8' }).trim() } catch { return '' } }
  const waitFor = async (cond: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 25)) // up to 5 s: a loaded host can be slow
    return cond()
  }
  try {
    pid = await new Promise<number>(resolve => holder.stdout!.once('data', chunk => resolve(Number(String(chunk).trim()))))
    assert.ok(await waitFor(() => psOf('comm', holder.pid!).endsWith('sleep')), 'the holder has exec-ed and no longer reaps its children')
    process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(() => psOf('stat', pid).startsWith('Z')), `the fixture produced a zombie (state ${JSON.stringify(psOf('stat', pid))})`)
    assert.doesNotThrow(() => process.kill(pid, 0), 'sanity: kill(pid, 0) alone still sees it')
    assert.equal(isRunning(pid), false)
    assert.equal(isRunning(holder.pid!), true, 'a live process is running')
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    holder.kill('SIGKILL')
  }
})

test('closing stdin kills a running Git child', async () => {
  const parent = newDir('repo-')
  const repo = join(parent, 'repo')
  execFileSync('git', [...IDENTITY, 'init', '-q', repo], { stdio: 'ignore' })
  const fifo = join(parent, 'stall.fifo')
  execFileSync('mkfifo', [fifo])
  FIFOS.add(fifo)
  const configPath = join(repo, '.git', 'config')
  writeFileSync(configPath, readFileSync(configPath, 'utf8') + `[include]\n\tpath = ${fifo}\n`)

  const gitPids = (): number[] => execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
    .filter(l => l.includes(repo) && /\bgit\b/.test(l)).map(l => Number(l.trim().split(/\s+/)[0]))
  const h = startWorker()
  h.send(request(root(repo, { kind: 'checkout', repositoryId: 'repo-1', checkoutIdentity: 'co-1', scopeFlags: ['checkout'] }), { task: 'checkout-status' }))
  let blocked: number[] = []
  for (let i = 0; i < 100 && blocked.length === 0; i++) {
    await new Promise(r => setTimeout(r, 50))
    blocked = gitPids()
  }
  assert.ok(blocked.length > 0, 'a Git child is blocked reading the FIFO')
  h.close()
  const exit = await h.exited
  assert.ok(exit.ms < 3000, `exited in ${exit.ms} ms`)
  let alive = blocked
  for (let i = 0; i < 40 && alive.length > 0; i++) {
    await new Promise(r => setTimeout(r, 50))
    alive = alive.filter(isRunning)
  }
  assert.deepEqual(alive, [], 'the blocked Git child was killed with the worker')
  releaseFifo(fifo)
})

test('direct observations and direct-only refusals over IPC', async () => {
  const dir = newDir()
  const file = put(dir, 'note.md')
  const h = startWorker()
  const direct = await h.run(request(root(dir, { kind: 'session-directory', scopeFlags: ['direct-only'] }), { task: 'direct-observation', path: file }))
  assert.deepEqual(direct.flatMap(f => f.rows).map(r => r.path), [file])
  const refused = await h.run(request(root(dir, { kind: 'session-directory', scopeFlags: ['direct-only'] })))
  assert.equal(refused.length, 1)
  assert.equal(refused[0]!.error?.code, 'direct-only-root')
  h.close()
  await h.exited
})

// --------------------------------------------------------------------------------------------------------------- validator

test('the frame validator rejects oversized and malformed frames', () => {
  // One fixed instant: two rows built a millisecond apart would differ and break the byte-for-byte comparison at the end.
  const observedAt = new Date().toISOString()
  const row = (i: number, extra: Partial<ArtifactWorkerObservation> = {}): ArtifactWorkerObservation => ({
    rootId: 'r1', identity: { identityKind: 'root', repositoryId: null, rootId: 'r1', relativePath: `f${i}.md` }, kind: 'working', observedAt,
    path: `/home/u/r/f${i}.md`, stat: { dev: '1', ino: String(i + 1), size: 1, mtimeMs: 1, ctimeMs: 1 }, ...extra,
  })
  const frame = (rows: ArtifactWorkerObservation[], extra: Partial<ArtifactWorkerFrame> = {}): ArtifactWorkerFrame => ({
    type: 'batch', jobId: 'j', rows, cursor: null, complete: false, coverage: 'partial', counts: { visited: rows.length, eligible: rows.length, skipped: 0 }, ...extra,
  })
  const blob = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  const commitRow: ArtifactWorkerObservation = {
    rootId: 'r1', identity: { identityKind: 'repository', repositoryId: 'repo', rootId: null, relativePath: 'a.md' }, kind: 'commit', observedAt: new Date().toISOString(),
    git: { repositoryId: 'repo', commitOid: commit, gitPath: 'a.md', blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 3 },
    evidence: { source: 'git', eventKey: `git:${commit}:a.md`, sessionId: null, operation: 'touched', certainty: 'unknown', eventAt: new Date().toISOString() },
  }
  const indexRow: ArtifactWorkerObservation = {
    rootId: 'r1', identity: { identityKind: 'repository', repositoryId: 'repo', rootId: null, relativePath: 'a.md' }, kind: 'index', observedAt: new Date().toISOString(),
    git: { repositoryId: 'repo', checkoutIdentity: 'co', gitPath: 'a.md', blobOid: blob, objectFormat: 'sha1', mode: 0o100644, size: 3, stage: 0 },
  }
  assert.equal(validateArtifactWorkerFrame(frame([row(1), commitRow, indexRow])), null)
  assert.equal(validateArtifactWorkerFrame(frame(Array.from({ length: 250 }, (_, i) => row(i)))), null)
  assert.equal(validateArtifactWorkerFrame(frame(Array.from({ length: 251 }, (_, i) => row(i)))), 'too-many-rows')
  const longPath = '/home/u/' + 'p'.repeat(4000)
  const fat = Array.from({ length: 250 }, (_, i) => row(i, { path: `${longPath}${i}.md`, identity: { identityKind: 'root', repositoryId: null, rootId: 'r1', relativePath: `${'p'.repeat(4000)}${i}.md` } }))
  assert.equal(validateArtifactWorkerFrame(frame(fat)), 'frame-too-large')
  assert.throws(() => encodeArtifactWorkerFrame(frame(fat)), /frame-too-large/)
  assert.equal(validateArtifactWorkerFrame(frame([], { cursor: 'c'.repeat(ARTIFACT_IPC_LIMITS.maxCursorBytes + 1) })), 'cursor-too-large')
  assert.equal(validateArtifactWorkerFrame(frame([], { cursor: 'é'.repeat(ARTIFACT_IPC_LIMITS.maxCursorBytes / 2 + 1) })), 'cursor-too-large', 'the cursor bound is in bytes')
  assert.equal(validateArtifactWorkerFrame(frame([], { error: { code: 'x', message: 'm'.repeat(513) } })), 'invalid-error')
  assert.equal(validateArtifactWorkerFrame(frame([], { error: { code: 'Bad Code', message: '' } })), 'invalid-error')
  const malformed: Array<[string, unknown]> = [
    ['working without stat', row(1, { stat: undefined })],
    ['working with a relative path', row(1, { path: 'f1.md' })],
    ['commit with a path', { ...commitRow, path: '/home/u/a.md' }],
    ['commit with a stat', { ...commitRow, stat: { dev: '1', ino: '1', size: 1, mtimeMs: 1, ctimeMs: 1 } }],
    ['commit without a commit OID', { ...commitRow, git: { ...commitRow.git, commitOid: undefined } }],
    ['index without a stage', { ...indexRow, git: { ...indexRow.git, stage: undefined } }],
    ['index identity mismatch', { ...indexRow, identity: { ...indexRow.identity, relativePath: 'b.md' } }],
    ['sha256 length under sha1', { ...commitRow, git: { ...commitRow.git, objectFormat: 'sha256' } }],
    ['content smuggled in', { ...row(1), content: 'secret bytes' }],
    ['content smuggled into stat', row(1, { stat: { dev: '1', ino: '1', size: 1, mtimeMs: 1, ctimeMs: 1, bytes: 'x' } as unknown as ArtifactWorkerObservation['stat'] })],
    ['two identity owners', row(1, { identity: { identityKind: 'root', repositoryId: 'repo', rootId: 'r1', relativePath: 'f1.md' } })],
    ['parent segment', row(1, { identity: { identityKind: 'root', repositoryId: null, rootId: 'r1', relativePath: '../f1.md' } })],
    ['multi-line event key', { ...commitRow, evidence: { ...commitRow.evidence!, eventKey: 'git:\nx' } }],
    ['unknown kind', row(1, { kind: 'snapshot' as 'working' })],
    ['a capture time that is not a time', row(1, { capturedAt: 'a while ago' })],
    ['a capture time that is not text', row(1, { capturedAt: 5 as unknown as string })],
    ['a capture time on a commit row', { ...commitRow, capturedAt: '2026-10-20T12:00:00.000Z' }],
    ['a capture time on an index row', { ...indexRow, capturedAt: '2026-10-20T12:00:00.000Z' }],
  ]
  for (const [label, bad] of malformed) {
    assert.equal(validateArtifactWorkerFrame(frame([bad as ArtifactWorkerObservation])), 'malformed-row', label)
  }
  // PR #19 review, P2-4: a working row may say when its lstat began; the field is optional and additive.
  assert.equal(validateArtifactWorkerFrame(frame([row(1, { capturedAt: '2026-10-20T12:00:00.000Z' })])), null)
  assert.equal(validateArtifactWorkerFrame({ ...frame([]), type: 'ack' }), 'not-a-batch-frame')
  assert.equal(validateArtifactWorkerFrame({ ...frame([]), extra: 1 }), 'malformed-frame')
  assert.equal(validateArtifactWorkerFrame({ ...frame([]), counts: { visited: -1, eligible: 0, skipped: 0 } }), 'malformed-frame')
  assert.equal(encodeArtifactWorkerFrame(frame([row(1)])), JSON.stringify(frame([row(1)])))
})
