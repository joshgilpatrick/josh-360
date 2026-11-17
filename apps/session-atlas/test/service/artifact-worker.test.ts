import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactWorkerFrame, ArtifactWorkerRequest } from '../../src/artifacts/contracts.ts'
import { ARTIFACT_IPC_LIMITS } from '../../src/artifacts/discovery.ts'
import {
  ARTIFACT_WORKER_MAIN, ARTIFACT_WORKER_PRELOAD, artifactWorkerLaunchPlans, createArtifactWorkerClient, type ArtifactProcessInfo, type ArtifactWorkerClient,
} from '../../src/service/artifact-worker.ts'
import { silentLogger } from '../helpers/log.ts'

// Cleanup is registered before the first temporary directory exists; every real client is stopped (which kills its worker and
// every tracked process group) before the directories go.
const TEMP: string[] = []
const CLIENTS: ArtifactWorkerClient[] = []
function cleanup(): void {
  for (const c of CLIENTS.splice(0)) { try { c.stop() } catch { /* already stopped */ } }
  for (const d of TEMP.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
}
process.on('exit', cleanup)
after(cleanup)

const NODE = process.execPath
const NODE_ARGS = ['--disable-warning=ExperimentalWarning', '--import=file:///x/preload.ts', '/x/worker-main.ts']

// ------------------------------------------------------------------------------------------------ priority wrapper

test('Linux launches the worker under ionice -c3 and nice -n 19 when both exist', () => {
  const plans = artifactWorkerLaunchPlans({ platform: 'linux', node: NODE, nodeArgs: NODE_ARGS, exists: p => p === '/usr/bin/ionice' || p === '/usr/bin/nice' })
  assert.deepEqual(plans[0], { command: '/usr/bin/ionice', args: ['-c3', '/usr/bin/nice', '-n', '19', NODE, ...NODE_ARGS], facility: 'applied', label: 'ionice -c3 nice -n 19' })
  // Fallbacks: CPU priority alone, then no facility at all.
  assert.deepEqual(plans[1], { command: '/usr/bin/nice', args: ['-n', '19', NODE, ...NODE_ARGS], facility: 'applied', label: 'nice -n 19' })
  assert.deepEqual(plans.at(-1), { command: NODE, args: NODE_ARGS, facility: 'unavailable', label: 'none' })
})

test('Linux without ionice uses nice alone; macOS uses taskpolicy -b; nothing available is reported unavailable', () => {
  const linux = artifactWorkerLaunchPlans({ platform: 'linux', node: NODE, nodeArgs: NODE_ARGS, exists: p => p === '/bin/nice' })
  assert.deepEqual(linux[0], { command: '/bin/nice', args: ['-n', '19', NODE, ...NODE_ARGS], facility: 'applied', label: 'nice -n 19' })
  const mac = artifactWorkerLaunchPlans({ platform: 'darwin', node: NODE, nodeArgs: NODE_ARGS, exists: p => p === '/usr/sbin/taskpolicy' })
  assert.deepEqual(mac[0], { command: '/usr/sbin/taskpolicy', args: ['-b', NODE, ...NODE_ARGS], facility: 'applied', label: 'taskpolicy -b' })
  const bare = artifactWorkerLaunchPlans({ platform: 'linux', node: NODE, nodeArgs: NODE_ARGS, exists: () => false })
  assert.deepEqual(bare, [{ command: NODE, args: NODE_ARGS, facility: 'unavailable', label: 'none' }])
  const other = artifactWorkerLaunchPlans({ platform: 'win32', node: NODE, nodeArgs: NODE_ARGS, exists: () => true })
  assert.equal(other[0]!.facility, 'unavailable')
})

// ------------------------------------------------------------------------------------------------ injected child

class FakeChild extends EventEmitter {
  pid: number
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pidPipe = new PassThrough()
  stdio: unknown[]
  exitCode: number | null = null
  signalCode: string | null = null
  written = ''
  constructor(pid: number) {
    super()
    this.pid = pid
    this.stdio = [this.stdin, this.stdout, this.stderr, this.pidPipe]
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (s: string) => { this.written += s })
  }
  die(code: number | null, signal: string | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
  kill(signal?: string): boolean { this.die(null, signal ?? 'SIGTERM'); return true }
  send(frame: unknown): void { this.stdout.write(`${JSON.stringify(frame)}\n`) }
}

type Harness = {
  client: ArtifactWorkerClient; spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }>; kills: Array<[number, string | number]>
  t: { now: number }; warnings: string[]
}

const OWN_GROUP = 4321

function harness(over: { exists?: (p: string) => boolean; frameTimeoutMs?: number; procInfo?: ((pid: number) => ArtifactProcessInfo | null) | null } = {}): Harness {
  const spawns: Harness['spawns'] = []
  const kills: Harness['kills'] = []
  const warnings: string[] = []
  const t = { now: 1_000_000 }
  let nextPid = 5000
  const client = createArtifactWorkerClient({
    log: { info() {}, error() {}, warn: (msg, data) => { warnings.push(`${msg} ${JSON.stringify(data ?? {})}`) } },
    // The fake Git pids look like detached Git children (each leads its own group); the service's own group is fixed.
    procInfo: over.procInfo === undefined ? (pid => ({ ppid: 1, pgrp: pid, comm: 'git' })) : over.procInfo,
    ownGroup: OWN_GROUP,
    home: '/home/someone',
    platform: 'linux',
    exists: over.exists ?? (p => p === '/usr/bin/ionice' || p === '/usr/bin/nice'),
    clock: () => t.now,
    frameTimeoutMs: over.frameTimeoutMs ?? 60_000,
    spawn: (command, args, options) => {
      const child = new FakeChild(nextPid++)
      spawns.push({ command, args, options, child })
      return child as unknown as ChildProcess
    },
    kill: (pid, signal) => {
      kills.push([pid, signal])
      // Like a real process, the child's exit is observed later, not inside kill().
      const target = spawns.find(s => s.child.pid === Math.abs(pid))
      if (target && signal !== 0) setImmediate(() => target.child.die(null, String(signal)))
    },
  })
  return { client, spawns, kills, t, warnings }
}

function req(jobId = 'job-1'): ArtifactWorkerRequest {
  return {
    jobId, root: { rootId: 'r1', kind: 'output', canonicalPath: '/home/someone/out', repositoryId: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'] },
    generation: 1, task: 'output-walk', cursor: null, includeOlder: false, documentExtensions: ['md'], ignoreSegments: [],
    limits: { maxEntries: 5000, maxMs: 2000, gitTimeoutMs: 10_000, gitMaxOutputBytes: 8 * 1024 * 1024 }, sinceMs: 0,
  }
}

function terminal(jobId: string, over: Partial<ArtifactWorkerFrame> = {}): ArtifactWorkerFrame {
  return { type: 'batch', jobId, rows: [], cursor: null, complete: true, coverage: 'complete', counts: { visited: 1, eligible: 0, skipped: 0 }, ...over }
}

function row(): ArtifactWorkerFrame['rows'][number] {
  return {
    rootId: 'r1', identity: { identityKind: 'root', repositoryId: null, rootId: 'r1', relativePath: 'a.md' }, kind: 'working', observedAt: new Date(0).toISOString(),
    path: '/home/someone/out/a.md', stat: { dev: '1', ino: '2', size: 3, mtimeMs: 4, ctimeMs: 5 },
  }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('the worker is spawned lazily, detached, with four pipes, a minimal environment and the priority wrapper', async () => {
  const h = harness()
  assert.equal(h.spawns.length, 0, 'nothing is spawned before the first job')
  h.client.start(req())
  assert.equal(h.spawns.length, 1)
  const s = h.spawns[0]!
  assert.equal(s.command, '/usr/bin/ionice')
  assert.deepEqual(s.args.slice(0, 5), ['-c3', '/usr/bin/nice', '-n', '19', process.execPath])
  assert.ok(s.args.includes('--disable-warning=ExperimentalWarning'))
  assert.ok(s.args.some(a => a.startsWith('--import=') && a.endsWith('artifact-worker-preload.ts')), 'the process-group reporter is preloaded')
  assert.equal(s.args.at(-1), ARTIFACT_WORKER_MAIN)
  assert.ok(ARTIFACT_WORKER_MAIN.endsWith('/src/artifacts/worker-main.ts') && ARTIFACT_WORKER_PRELOAD.endsWith('/src/service/artifact-worker-preload.ts'))
  assert.equal(s.options.detached, true, 'its own process group, so the group can be killed')
  assert.deepEqual(s.options.stdio, ['pipe', 'pipe', 'pipe', 'pipe'])
  const env = s.options.env as Record<string, string>
  assert.equal(env.HOME, '/home/someone')
  assert.ok(Object.keys(env).every(k => !k.startsWith('GIT_') && k !== 'NODE_OPTIONS'), 'no inherited Git or Node options')
  assert.equal(env.ATLAS_ARTIFACT_WORKER_PID_FD, '3')
  await tick()
  assert.deepEqual(JSON.parse(s.child.written.trim()), req())
  assert.equal(h.client.status().priorityFacility, 'applied')
  assert.equal(h.client.status().priorityCommand, 'ionice -c3 nice -n 19')
})

test('frames split across chunks are reassembled, and each is acknowledged exactly once', async () => {
  const h = harness()
  h.client.start(req())
  const child = h.spawns[0]!.child
  const line = JSON.stringify({ ...terminal('job-1', { complete: false, coverage: 'partial', cursor: 'c1' }), rows: [row()] })
  child.stdout.write(line.slice(0, 40))
  await tick()
  assert.equal(h.client.poll(), null, 'half a line is not a frame')
  child.stdout.write(`${line.slice(40)}\n`)
  await tick()
  const ev = h.client.poll()
  assert.equal(ev?.type, 'frame')
  assert.equal(ev?.type === 'frame' && ev.frame.rows.length, 1)
  h.client.ack('job-1')
  await tick()
  assert.ok(child.written.trim().endsWith('{"type":"ack","jobId":"job-1"}'))
  const before = child.written
  h.client.ack('job-1')
  await tick()
  assert.equal(child.written, before, 'a second ack for the same frame is not sent')
  child.send(terminal('job-1'))
  await tick()
  assert.equal(h.client.poll()?.type, 'frame')
  h.client.ack('job-1')
  assert.equal(h.client.status().activeJobId, null, 'the job ends when its terminal frame is acknowledged')
})

test('a malformed frame, an oversized line or a second frame before the ack kills the worker and reports a protocol exit', async () => {
  for (const send of [
    (c: FakeChild) => c.stdout.write('{"type":"batch","jobId":"job-1"}\n'),
    (c: FakeChild) => c.stdout.write(`${'x'.repeat(ARTIFACT_IPC_LIMITS.maxFrameBytes + 10)}\n`),
    (c: FakeChild) => { c.send(terminal('job-1', { complete: false, coverage: 'partial', cursor: 'c', rows: [row()] })); c.send(terminal('job-1')) },
    (c: FakeChild) => c.send(terminal('other-job')),
  ]) {
    const h = harness()
    h.client.start(req())
    const child = h.spawns[0]!.child
    send(child)
    await tick()
    let ev = h.client.poll()
    if (ev?.type === 'frame') ev = h.client.poll() // the one valid frame before the violation
    assert.equal(ev?.type, 'exit')
    assert.match(ev?.type === 'exit' ? ev.reason : '', /^protocol-/)
    assert.ok(h.kills.some(([pid, sig]) => pid === -child.pid && sig === 'SIGKILL'), 'the worker group is killed')
    assert.equal(h.client.status().running, false)
  }
})

test('Git children reported by the preload are tracked as process groups and killed on stop, restart and crash', async () => {
  const h = harness()
  h.client.start(req())
  const child = h.spawns[0]!.child
  child.pidPipe.write('S 4242\nS 4343\nE 4343\n')
  await tick()
  assert.deepEqual(h.client.status().liveGroups.sort(), [4242, child.pid].sort())
  h.client.stop()
  // Synchronously: a service exiting right after stop() never sees the worker's exit event.
  assert.ok(h.kills.some(([pid, sig]) => pid === -4242 && sig === 'SIGKILL'), 'the live Git group is killed')
  assert.ok(!h.kills.some(([pid]) => pid === -4343), 'an exited Git child is not signalled (its pid may be reused)')
  assert.ok(h.kills.some(([pid, sig]) => pid === -child.pid && sig === 'SIGKILL'), 'the worker group is killed')
  assert.throws(() => h.client.start(req('job-2')), /stopped/)

  // A crash (the worker dies on its own) still kills the Git groups it left behind, and is reported once.
  const h2 = harness()
  h2.client.start(req())
  const c2 = h2.spawns[0]!.child
  c2.pidPipe.write('S 777\n')
  await tick()
  c2.die(null, 'SIGSEGV')
  await tick()
  assert.ok(h2.kills.some(([pid, sig]) => pid === -777 && sig === 'SIGKILL'))
  const ev = h2.client.poll()
  assert.deepEqual(ev, { type: 'exit', reason: 'signal-SIGSEGV' })
  assert.equal(h2.client.poll(), null)
  assert.equal(h2.client.status().crashes, 1)
  // The next job spawns a fresh worker.
  h2.client.start(req('job-2'))
  assert.equal(h2.spawns.length, 2)

  // restart(): frames already received from the old child are dropped with it.
  const h3 = harness()
  h3.client.start(req())
  const c3 = h3.spawns[0]!.child
  c3.pidPipe.write('S 888\n')
  c3.send(terminal('job-1'))
  await tick()
  h3.client.restart('test')
  assert.equal(h3.client.poll(), null)
  assert.ok(h3.kills.some(([pid]) => pid === -888) && h3.kills.some(([pid]) => pid === -c3.pid))
  assert.equal(h3.client.status().crashes, 0, 'a requested kill is not a crash')
})

test('a job that produces no frame within the frame timeout is killed and reported', async () => {
  const h = harness({ frameTimeoutMs: 5000 })
  h.client.start(req())
  h.t.now += 4000
  assert.equal(h.client.poll(), null)
  h.t.now += 2000
  assert.deepEqual(h.client.poll(), { type: 'exit', reason: 'timeout' })
  assert.ok(h.kills.some(([pid, sig]) => pid === -h.spawns[0]!.child.pid && sig === 'SIGKILL'))
})

test('a priority wrapper that fails at startup falls back to the next launch plan and says so', async () => {
  const h = harness()
  h.client.start(req())
  h.spawns[0]!.child.die(1, null) // e.g. ionice refused to set the class
  await tick()
  assert.equal(h.client.poll()?.type, 'exit')
  h.client.start(req('job-2'))
  assert.equal(h.spawns[1]!.command, '/usr/bin/nice')
  h.spawns[1]!.child.die(1, null)
  await tick()
  h.client.poll()
  h.client.start(req('job-3'))
  assert.equal(h.spawns[2]!.command, process.execPath)
  assert.equal(h.client.status().priorityFacility, 'wrapper-failed')
  assert.equal(h.client.status().priorityCommand, 'none')
})

test('no priority facility at all is reported as unavailable', () => {
  const h = harness({ exists: () => false })
  h.client.start(req())
  assert.equal(h.spawns[0]!.command, process.execPath)
  assert.equal(h.client.status().priorityFacility, 'unavailable')
})


// R36: a pid line is vetted before it can ever reach kill(-pid). `S 1` would otherwise make kill(-1, SIGKILL) signal every
// process the user owns.
test('implausible reported pids are refused, logged without paths, and never signalled', async () => {
  // 7777: a child of the worker (the first fake worker is pid 5000) that sits in the service's own process group; 8888: an
  // unrelated process (not the worker's, not Git).
  const h = harness({ procInfo: pid => (pid === 7777 ? { ppid: 5000, pgrp: OWN_GROUP, comm: 'git' } : pid === 8888 ? { ppid: 1, pgrp: 1234, comm: 'bash' } : { ppid: 1, pgrp: pid, comm: 'git' }) })
  h.client.start(req())
  const child = h.spawns[0]!.child
  child.pidPipe.write(`S 1\nS 0\nS ${process.pid}\nS ${OWN_GROUP}\nS 7777\nS 8888\nS ${child.pid}\nS 4242\n`)
  await tick()
  assert.deepEqual(h.client.status().liveGroups.sort((a, b) => a - b), [4242, child.pid].sort((a, b) => a - b))
  h.client.stop()
  await tick()
  for (const bad of [1, 0, process.pid, OWN_GROUP, 7777, 8888]) {
    assert.ok(!h.kills.some(([pid]) => pid === bad || pid === -bad), `pid ${bad} is never signalled`)
  }
  assert.ok(h.kills.some(([pid, sig]) => pid === -4242 && sig === 'SIGKILL'), 'the plausible Git child is still killed')
  const refused = h.warnings.filter(w => w.includes('implausible process id'))
  assert.equal(refused.length, 7)
  assert.ok(refused.every(w => !w.includes('/') && /"reason":"pid-[a-z-]+"/.test(w)), 'a reason token only')
})

test('without /proc (macOS), the service itself, its parent, its group and pid 1 are still refused', async () => {
  const h = harness({ procInfo: null })
  h.client.start(req())
  const child = h.spawns[0]!.child
  child.pidPipe.write(`S 1\nS ${process.pid}\nS ${process.ppid}\nS ${OWN_GROUP}\nS 4242\n`)
  await tick()
  h.client.stop()
  await tick()
  for (const bad of [1, process.pid, process.ppid, OWN_GROUP]) assert.ok(!h.kills.some(([pid]) => pid === bad || pid === -bad), `pid ${bad} is never signalled`)
  assert.ok(h.kills.some(([pid]) => pid === -4242))
})

test('a Git child reported by a worker that was already replaced is killed, not dropped', async () => {
  const h = harness()
  h.client.start(req())
  const old = h.spawns[0]!.child
  h.client.restart('test')
  await tick() // the old worker's exit is processed first; its pid lines arrive later
  old.pidPipe.write('S 999\nS 1\n')
  await tick()
  assert.ok(h.kills.some(([pid, sig]) => pid === -999 && sig === 'SIGKILL'), 'the orphaned Git group is killed')
  assert.ok(!h.kills.some(([pid]) => pid === -1 || pid === 1), 'the sanity check still applies')
  assert.ok(!h.client.status().liveGroups.includes(999), 'it is not tracked as a live group of the new worker')
})

// ------------------------------------------------------------------------------------------------ real worker

const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false']

test('a real worker runs a checkout-status job, reports its Git children, and leaves no live process after stop', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-wclient-home-')))
  TEMP.push(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  execFileSync('git', [...IDENTITY, 'init', '-q', repo], { env })
  writeFileSync(join(repo, 'notes.md'), 'x\n')
  const client = createArtifactWorkerClient({ log: silentLogger, home })
  CLIENTS.push(client)
  const request: ArtifactWorkerRequest = {
    ...req('real-1'), task: 'checkout-status', includeOlder: true,
    root: { rootId: 'r-real', kind: 'checkout', canonicalPath: repo, repositoryId: 'repo-1', checkoutIdentity: 'ck-1', protected: false, scopeFlags: ['checkout'] },
  }
  client.start(request)
  const frames: ArtifactWorkerFrame[] = []
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await client.wait(200)
    const ev = client.poll()
    if (!ev) continue
    assert.equal(ev.type, 'frame', ev.type === 'exit' ? ev.reason : '')
    if (ev.type !== 'frame') break
    frames.push(ev.frame)
    client.ack(ev.frame.jobId)
    if (ev.frame.rows.length === 0) break
  }
  assert.ok(frames.length >= 1)
  const rows = frames.flatMap(f => f.rows)
  assert.deepEqual(rows.map(r => r.path), [join(repo, 'notes.md')])
  assert.ok(client.status().gitChildrenSeen > 0, 'the preload reported the Git processes the worker started')
  const pid = client.status().pid
  assert.ok(typeof pid === 'number')
  client.stop()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid!, 0), /ESRCH/, 'the worker process is gone')
  assert.deepEqual(client.status().liveGroups, [])
})
