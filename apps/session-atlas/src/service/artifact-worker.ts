// The service side of the artifact worker protocol (plan 2026-10-26 Task 7, spec s2 and s10): ONE lazily started child process
// running src/artifacts/worker-main.ts, at background priority, speaking NDJSON over stdin/stdout.
//
// This module owns process management and framing only; the scheduler (artifact-manager-runner.ts) owns jobs, validation of
// what a frame claims, commits and acknowledgements. Guarantees:
//   - One child, one job at a time. start() refuses while a job is active; a job ends when its terminal frame is acknowledged.
//   - Every line is bounded (ARTIFACT_IPC_LIMITS, shared with the worker) and every frame passes validateArtifactWorkerFrame
//     before the runner sees it. A malformed or oversized line, a frame for another job, or a second frame before the previous
//     one was acknowledged is a protocol violation: the worker is killed and an `exit` event with a `protocol-...` reason is
//     reported. No frame is ever acknowledged here on the runner's behalf: ack() is called by the runner after its commit.
//   - Liveness: a job that produces no frame for `frameTimeoutMs` (counted only while waiting for the worker, never while
//     the runner holds an unacknowledged frame) is killed and reported as an `exit` event with reason `timeout`.
//   - Process groups: the worker is spawned detached (its own process group), and the Git children it starts (detached by
//     the Git adapter, each in its own group) are reported by artifact-worker-preload.ts over fd 3. Every tracked group is
//     killed with SIGKILL on stop(), restart(), a protocol violation, a timeout and after a crash, so no worker or Git
//     process outlives the worker that started it (spec s10: no live process survives a restart).
//   - Priority: the child runs under the platform's background facility through a small wrapper (macOS `taskpolicy -b`;
//     Linux `ionice -c3` when present, around `nice -n 19`). When no facility exists, or the wrapper fails at startup and the
//     ladder falls back to plain node, status().priorityFacility says so ('unavailable' / 'wrapper-failed'); that blocks
//     claiming the production performance gate.
// Nothing here logs paths, names or contents: the worker's stderr carries short path-free diagnostics by contract.

import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ArtifactWorkerFrame, ArtifactWorkerRequest } from '../artifacts/contracts.ts'
import { ARTIFACT_IPC_LIMITS, isTerminalArtifactFrame, validateArtifactWorkerFrame } from '../artifacts/discovery.ts'
import type { Logger } from '../util/log.ts'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
/** The worker entry point, resolved from this module (never from the working directory). */
export const ARTIFACT_WORKER_MAIN = join(REPO_ROOT, 'src', 'artifacts', 'worker-main.ts')
/** Reports the worker's Git children to the service over fd 3. */
export const ARTIFACT_WORKER_PRELOAD = join(REPO_ROOT, 'src', 'service', 'artifact-worker-preload.ts')

/** Default liveness bound: generous enough for a slice's fixed Git setup (each Git process bounded by gitTimeoutMs). */
export const ARTIFACT_WORKER_FRAME_TIMEOUT_MS = 240_000
/** A wrapped worker that exits non-zero within this window, before any frame, is a wrapper failure: fall back. */
const STARTUP_WINDOW_MS = 5_000
const MAX_STDERR_LINE = 300
const MAX_PID_LINE = 64

export type ArtifactWorkerEvent = { type: 'frame'; frame: ArtifactWorkerFrame } | { type: 'exit'; reason: string }

export type ArtifactWorkerClientStatus = {
  running: boolean
  pid: number | null
  activeJobId: string | null
  /** 'applied' | 'unavailable' | a reason such as 'wrapper-failed'. */
  priorityFacility: string
  /** The wrapper in use, e.g. 'ionice -c3 nice -n 19', 'taskpolicy -b' or 'none'. */
  priorityCommand: string
  /** Process groups that would be killed now: the worker's and every live Git child's. */
  liveGroups: number[]
  spawns: number
  crashes: number
  gitChildrenSeen: number
}

export interface ArtifactWorkerClient {
  /** Sends one job request, spawning the worker if none is running. Throws while a job is active or after stop(). */
  start(request: ArtifactWorkerRequest): void
  /** The next validated frame or exit event, or null. Also enforces the frame timeout. */
  poll(): ArtifactWorkerEvent | null
  /** Resolves when an event is ready or after `ms`, whichever comes first. */
  wait(ms: number): Promise<void>
  /** Acknowledges the job's outstanding frame. The caller commits first. */
  ack(jobId: string): void
  /** Kills the worker and every tracked group; events already received are dropped. The next start() spawns afresh. */
  restart(reason: string): void
  /** restart(), and refuse all further jobs. Synchronous: safe in a shutdown or exit handler. */
  stop(): void
  status(): ArtifactWorkerClientStatus
}

export type ArtifactWorkerLaunchPlan = { command: string; args: string[]; facility: 'applied' | 'unavailable'; label: string }

export type ArtifactWorkerSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

const LINUX_IONICE = ['/usr/bin/ionice', '/bin/ionice']
const LINUX_NICE = ['/usr/bin/nice', '/bin/nice']
const MAC_TASKPOLICY = ['/usr/sbin/taskpolicy', '/usr/bin/taskpolicy']

/**
 * The ordered launch ladder: the platform's full background facility first, then reduced fallbacks, ending with plain node
 * (facility 'unavailable'). Only fixed absolute paths are considered (no PATH search: launchd's PATH is minimal).
 */
export function artifactWorkerLaunchPlans(opts: { platform: NodeJS.Platform; node: string; nodeArgs: string[]; exists: (path: string) => boolean }): ArtifactWorkerLaunchPlan[] {
  const find = (candidates: string[]) => candidates.find(p => opts.exists(p)) ?? null
  const plans: ArtifactWorkerLaunchPlan[] = []
  const nodeCmd = [opts.node, ...opts.nodeArgs]
  if (opts.platform === 'darwin') {
    const taskpolicy = find(MAC_TASKPOLICY)
    if (taskpolicy) plans.push({ command: taskpolicy, args: ['-b', ...nodeCmd], facility: 'applied', label: 'taskpolicy -b' })
  } else if (opts.platform === 'linux') {
    const nice = find(LINUX_NICE)
    const ionice = find(LINUX_IONICE)
    if (nice && ionice) plans.push({ command: ionice, args: ['-c3', nice, '-n', '19', ...nodeCmd], facility: 'applied', label: 'ionice -c3 nice -n 19' })
    if (nice) plans.push({ command: nice, args: ['-n', '19', ...nodeCmd], facility: 'applied', label: 'nice -n 19' })
  }
  plans.push({ command: opts.node, args: [...opts.nodeArgs], facility: 'unavailable', label: 'none' })
  return plans
}

/** What /proc says about a process (Linux), or null when it cannot be read (gone, or no /proc). */
export type ArtifactProcessInfo = { ppid: number; pgrp: number; comm: string }

/** Parses /proc/<pid>/stat: "pid (comm) state ppid pgrp ...". The comm field may itself contain spaces or parentheses. */
export function readProcInfo(pid: number): ArtifactProcessInfo | null {
  let text: string
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch { return null }
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const rest = text.slice(close + 2).split(' ')
  const ppid = Number(rest[1])
  const pgrp = Number(rest[2])
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgrp)) return null
  return { ppid, pgrp, comm: text.slice(open + 1, close) }
}

/** The service's own process group: from /proc on Linux, else asked once from ps; null when unknown. */
function ownProcessGroup(): number | null {
  const fromProc = readProcInfo(process.pid)
  if (fromProc) return fromProc.pgrp
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const n = Number(out)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

type Job = { jobId: string; outstanding: boolean; terminal: boolean; deadline: number }
type Child = {
  child: ChildProcess
  gen: number
  pid: number | null
  plan: number
  spawnedAt: number
  frames: number
  expected: boolean
  exited: boolean
  parts: Buffer[]
  partBytes: number
  discarding: boolean
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function createArtifactWorkerClient(opts: {
  log: Logger
  /** HOME for the worker: path authorization inside the worker is relative to it. */
  home: string
  spawn?: ArtifactWorkerSpawn
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  clock?: () => number
  frameTimeoutMs?: number
  startupWindowMs?: number
  /** Process facts used to vet a reported pid before it is ever signalled (default: /proc where it exists; null: none). */
  procInfo?: ((pid: number) => ArtifactProcessInfo | null) | null
  /** The service's own process group (default: read once from /proc or ps). */
  ownGroup?: number | null
}): ArtifactWorkerClient {
  const log = opts.log
  const spawnFn: ArtifactWorkerSpawn = opts.spawn ?? ((command, args, options) => nodeSpawn(command, args, options))
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => { process.kill(pid, signal) })
  const clock = opts.clock ?? Date.now
  const frameTimeoutMs = opts.frameTimeoutMs ?? ARTIFACT_WORKER_FRAME_TIMEOUT_MS
  const startupWindowMs = opts.startupWindowMs ?? STARTUP_WINDOW_MS
  const procInfo = opts.procInfo ?? readProcInfo
  const procAvailable = opts.procInfo === null ? false : opts.procInfo !== undefined || existsSync('/proc/self/stat')
  const ownGroup = opts.ownGroup !== undefined ? opts.ownGroup : ownProcessGroup()
  const nodeArgs = ['--disable-warning=ExperimentalWarning', `--import=${pathToFileURL(ARTIFACT_WORKER_PRELOAD).href}`, ARTIFACT_WORKER_MAIN]
  const plans = artifactWorkerLaunchPlans({ platform: opts.platform ?? process.platform, node: process.execPath, nodeArgs, exists: opts.exists ?? existsSync })
  let planIndex = 0
  let wrapperFailed = false

  let current: Child | null = null
  let gen = 0
  let job: Job | null = null
  let stopped = false
  let events: ArtifactWorkerEvent[] = []
  let wakers: Array<() => void> = []
  // Live Git children of the current (or a just-killed) worker: pid == process group id (detached).
  const gitGroups = new Set<number>()
  let spawns = 0
  let crashes = 0
  let gitChildrenSeen = 0

  const notify = (): void => {
    const w = wakers
    wakers = []
    for (const resolveWait of w) resolveWait()
  }
  const push = (ev: ArtifactWorkerEvent): void => {
    events.push(ev)
    notify()
  }

  const signalGroup = (pid: number): void => {
    try { kill(-pid, 'SIGKILL') } catch { /* gone, or not a group leader */ }
    try { kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  const killGitGroups = (): void => {
    for (const pid of gitGroups) signalGroup(pid)
    gitGroups.clear()
  }

  /** Kills the current worker (an expected exit) and every tracked group. */
  const killCurrent = (): void => {
    const c = current
    killGitGroups()
    if (!c) return
    c.expected = true
    current = null
    if (c.pid !== null) signalGroup(c.pid)
    else { try { c.child.kill('SIGKILL') } catch { /* gone */ } }
  }

  const violation = (reason: string): void => {
    log.warn('artifact worker protocol violation; restarting it', { reason })
    killCurrent()
    job = null
    push({ type: 'exit', reason })
  }

  const write = (c: Child, line: string): void => {
    try { c.child.stdin?.write(`${line}\n`) } catch { /* the exit handler reports the death */ }
  }

  const onLine = (c: Child, raw: Buffer): void => {
    if (current !== c) return
    let frame: unknown
    try {
      frame = JSON.parse(STRICT_UTF8.decode(raw))
    } catch {
      violation('protocol-malformed-line')
      return
    }
    const problem = validateArtifactWorkerFrame(frame)
    if (problem !== null) { violation(`protocol-${problem}`); return }
    const f = frame as ArtifactWorkerFrame
    c.frames++
    if (f.jobId === '') {
      // A protocol-level refusal (busy, invalid request): it belongs to no job and is never acknowledged. The worker holds no
      // job afterwards, so neither do we; the runner decides what the refusal means for its job.
      job = null
      push({ type: 'frame', frame: f })
      return
    }
    if (!job || f.jobId !== job.jobId) { violation('protocol-unexpected-job'); return }
    if (job.outstanding) { violation('protocol-unacknowledged'); return }
    job.outstanding = true
    job.terminal = isTerminalArtifactFrame(f)
    push({ type: 'frame', frame: f })
  }

  const onStdout = (c: Child, chunk: Buffer): void => {
    let data = chunk
    for (;;) {
      if (current !== c) return
      const nl = data.indexOf(0x0a)
      const piece = nl < 0 ? data : data.subarray(0, nl)
      if (!c.discarding) {
        // A frame line, newline included, is at most maxFrameBytes: never buffer more than that.
        if (c.partBytes + piece.length + 1 > ARTIFACT_IPC_LIMITS.maxFrameBytes) {
          c.discarding = true
          c.parts = []
          c.partBytes = 0
          violation('protocol-oversized-frame')
          return
        }
        if (piece.length > 0) { c.parts.push(Buffer.from(piece)); c.partBytes += piece.length }
      }
      if (nl < 0) return
      const line = Buffer.concat(c.parts, c.partBytes)
      c.parts = []
      c.partBytes = 0
      if (line.length > 0) onLine(c, line)
      data = data.subarray(nl + 1)
    }
  }

  /**
   * Why a pid reported over fd 3 must never be signalled, or null. A bogus line must not reach kill(-pid): `S 1` would make
   * kill(-1) signal every process the user owns. Refused: pid <= 1, the service itself, its parent, its process group. Where
   * /proc exists the process must also be the worker's child (its parent chain reaches the worker) or, once orphaned by a dead
   * worker, a detached Git process leading its own group; a process that cannot be read is gone and not signalled.
   */
  const pidProblem = (pid: number, workerPid: number | null): string | null => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return 'pid-reserved'
    if (pid === process.pid || pid === process.ppid) return 'pid-service'
    if (ownGroup !== null && pid === ownGroup) return 'pid-service-group'
    if (workerPid !== null && pid === workerPid) return 'pid-worker'
    if (!procAvailable) return null
    const info = procInfo(pid)
    if (!info) return 'pid-unreadable'
    if (ownGroup !== null && info.pgrp === ownGroup) return 'pid-service-group'
    let parent = info.ppid
    for (let hops = 0; hops < 4 && parent > 1; hops++) {
      if (parent === workerPid) return null
      parent = procInfo(parent)?.ppid ?? 0
    }
    return info.comm === 'git' && info.pgrp === pid ? null : 'pid-not-worker-child'
  }

  const onPidLine = (c: Child, line: string): void => {
    const m = /^([SE]) (\d{1,10})$/.exec(line)
    if (!m) return
    const pid = Number(m[2])
    const replaced = c.gen !== gen || current !== c
    if (m[1] === 'E') { if (!replaced) gitGroups.delete(pid); return }
    const problem = pidProblem(pid, c.pid)
    if (problem !== null) {
      log.warn('artifact worker reported an implausible process id; ignored', { reason: problem })
      return
    }
    gitChildrenSeen++
    // A Git child reported by a worker that was already replaced would be orphaned: kill its group now, do not track it.
    if (replaced) signalGroup(pid)
    else gitGroups.add(pid)
  }

  const onExit = (c: Child, code: number | null, signal: NodeJS.Signals | null): void => {
    // 'error' (a failed spawn) and 'exit' can both fire for one child: handle it once.
    if (c.exited) return
    c.exited = true
    if (c.gen !== gen) return
    // Whatever the worker started may now be orphaned: kill it before anything else.
    killGitGroups()
    if (current === c) current = null
    if (c.expected) return
    // Its process group may still hold a descendant that did not die with it.
    if (c.pid !== null) { try { kill(-c.pid, 'SIGKILL') } catch { /* empty group */ } }
    crashes++
    const reason = signal ? `signal-${signal}` : `exit-${code ?? 'unknown'}`
    // A priority wrapper that cannot start the worker (e.g. ionice refused) fails at once, before any frame: fall back.
    if (c.frames === 0 && code !== 0 && signal === null && clock() - c.spawnedAt < startupWindowMs && c.plan < plans.length - 1 && c.plan === planIndex) {
      planIndex = c.plan + 1
      wrapperFailed = true
      log.warn('artifact worker failed to start under its priority wrapper; falling back', { from: plans[c.plan]!.label, to: plans[planIndex]!.label })
    }
    job = null
    push({ type: 'exit', reason })
  }

  const ensureChild = (): Child => {
    if (current) return current
    const plan = plans[planIndex]!
    gen++
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: opts.home, LANG: 'C', ATLAS_ARTIFACT_WORKER_PID_FD: '3' }
    let child: ChildProcess
    const c: Child = { child: undefined as unknown as ChildProcess, gen, pid: null, plan: planIndex, spawnedAt: clock(), frames: 0, expected: false, exited: false, parts: [], partBytes: 0, discarding: false }
    try {
      child = spawnFn(plan.command, plan.args, { cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env, windowsHide: true })
    } catch (err) {
      throw new Error(`artifact worker could not be started: ${err instanceof Error ? err.name : 'error'}`)
    }
    spawns++
    c.child = child
    c.pid = typeof child.pid === 'number' ? child.pid : null
    current = c
    child.stdout?.on('data', (chunk: Buffer | string) => onStdout(c, typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    let errText = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      errText += String(chunk)
      let nl: number
      while ((nl = errText.indexOf('\n')) >= 0) {
        const line = errText.slice(0, nl).slice(0, MAX_STDERR_LINE)
        errText = errText.slice(nl + 1)
        if (line.trim()) log.warn('artifact worker diagnostic', { line })
      }
      if (errText.length > 4 * MAX_STDERR_LINE) errText = ''
    })
    const pidPipe = child.stdio?.[3] as NodeJS.ReadableStream | null | undefined
    let pidText = ''
    pidPipe?.on('data', (chunk: Buffer | string) => {
      pidText += String(chunk)
      let nl: number
      while ((nl = pidText.indexOf('\n')) >= 0) {
        onPidLine(c, pidText.slice(0, nl))
        pidText = pidText.slice(nl + 1)
      }
      if (pidText.length > MAX_PID_LINE) pidText = ''
    })
    pidPipe?.on('error', () => { /* reported through exit */ })
    child.stdin?.on('error', () => { /* EPIPE: reported through exit */ })
    child.stdout?.on('error', () => { /* reported through exit */ })
    child.once('error', () => onExit(c, 127, null))
    child.once('exit', (code, signal) => onExit(c, code, signal))
    return c
  }

  return {
    start(request) {
      if (stopped) throw new Error('artifact worker client is stopped')
      if (job) throw new Error('artifact worker busy: a job is active')
      const c = ensureChild()
      job = { jobId: request.jobId, outstanding: false, terminal: false, deadline: clock() + frameTimeoutMs }
      write(c, JSON.stringify(request))
    },
    poll() {
      if (job && !job.outstanding && current && clock() > job.deadline) {
        log.warn('artifact worker produced no frame in time; restarting it', { timeoutMs: frameTimeoutMs })
        killCurrent()
        job = null
        push({ type: 'exit', reason: 'timeout' })
      }
      return events.shift() ?? null
    },
    wait(ms) {
      if (events.length > 0 || ms <= 0) return Promise.resolve()
      return new Promise<void>(resolveWait => {
        const timer = setTimeout(() => { wakers = wakers.filter(w => w !== done); resolveWait() }, ms)
        timer.unref?.()
        const done = (): void => { clearTimeout(timer); resolveWait() }
        wakers.push(done)
      })
    },
    ack(jobId) {
      if (!job || job.jobId !== jobId || !job.outstanding || !current) return
      write(current, JSON.stringify({ type: 'ack', jobId }))
      job.outstanding = false
      if (job.terminal) job = null
      else job.deadline = clock() + frameTimeoutMs
    },
    restart(reason) {
      if (current) log.info('restarting the artifact worker', { reason })
      killCurrent()
      job = null
      events = []
    },
    stop() {
      stopped = true
      killCurrent()
      job = null
      events = []
      notify()
    },
    status() {
      const plan = plans[planIndex]!
      return {
        running: current !== null,
        pid: current?.pid ?? null,
        activeJobId: job?.jobId ?? null,
        priorityFacility: plan.facility === 'unavailable' && wrapperFailed ? 'wrapper-failed' : plan.facility,
        priorityCommand: plan.label,
        liveGroups: [...(current?.pid != null ? [current.pid] : []), ...gitGroups],
        spawns,
        crashes,
        gitChildrenSeen,
      }
    },
  }
}
