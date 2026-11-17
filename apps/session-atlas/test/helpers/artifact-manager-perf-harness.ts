// Shared measurement harness for test/perf/artifact-manager.test.ts (plan 2026-10-26 Task 13b). Nothing here changes how
// Atlas behaves: it builds disposable fixtures (temporary HOMEs, repositories and folders), starts the REAL service
// (src/service/main.ts, unmodified) as a child process with the measurement probe preloaded, spawns the real hook, guard and
// CLI programs, and samples /proc for CPU, I/O and memory. Every directory, server and child process it creates is
// registered with a Scope and removed or killed by Scope.cleanup().

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const HOOK = join(REPO_ROOT, 'hooks', 'atlas-hook.js')
export const GUARD = join(REPO_ROOT, 'hooks', 'atlas-removal-guard.js')
export const CLI = join(REPO_ROOT, 'src', 'cli', 'artifacts.ts')
export const SERVICE_MAIN = join(REPO_ROOT, 'src', 'service', 'main.ts')
export const PROBE = join(REPO_ROOT, 'test', 'helpers', 'artifact-manager-perf-probe.ts')
export const PATH_ENV = process.env.PATH ?? '/usr/bin:/bin'

// ------------------------------------------------------------------------------------------------------------ cleanup scope

/** Owns the temporary directories, child processes and stoppers of one measurement. */
export class Scope {
  private dirs: string[] = []
  private children = new Set<ChildProcess>()
  private stoppers: Array<() => void | Promise<void>> = []

  scratch(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    this.dirs.push(dir)
    return dir
  }
  track(child: ChildProcess): ChildProcess {
    this.children.add(child)
    child.once('exit', () => this.children.delete(child))
    return child
  }
  onCleanup(fn: () => void | Promise<void>): void {
    this.stoppers.push(fn)
  }
  async cleanup(): Promise<void> {
    for (const s of this.stoppers.splice(0).reverse()) { try { await s() } catch { /* already stopped */ } }
    for (const c of this.children) { try { c.kill('SIGKILL') } catch { /* gone */ } }
    this.children.clear()
    for (const d of this.dirs.splice(0)) {
      try { execFileSync('chmod', ['-R', 'u+rwx', d], { stdio: 'ignore' }) } catch { /* best effort */ }
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
  /** Synchronous last resort (process exit): kill children, remove directories. */
  killSync(): void {
    for (const c of this.children) { try { c.kill('SIGKILL') } catch { /* gone */ } }
    for (const d of this.dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}

// ------------------------------------------------------------------------------------------------------------ statistics

export type Summary = { n: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number }

/** Nearest-rank percentile (the value at or below which p% of the samples fall). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(sorted.length, rank) - 1]!
}

export function summarize(values: readonly number[]): Summary {
  const s = [...values].sort((a, b) => a - b)
  const r = (v: number) => Math.round(v * 100) / 100
  return {
    n: s.length, min: r(s[0] ?? NaN), p50: r(percentile(s, 50)), p95: r(percentile(s, 95)), p99: r(percentile(s, 99)), max: r(s[s.length - 1] ?? NaN),
    mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
  }
}

/** One machine-readable result line: `PERF <name> key=value ...` (values without spaces). */
export function perfLine(name: string, metrics: Record<string, string | number | boolean | null>): string {
  const parts = Object.entries(metrics).map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : Math.round(v * 100) / 100) : String(v).replace(/\s+/g, '_')}`)
  const line = `PERF ${name} ${parts.join(' ')}`
  console.log(line)
  return line
}

/** The 1-, 5- and 15-minute machine load as `a/b/c` (two decimals each); from os.loadavg(), so macOS reports it too. */
export function machineLoad(): string {
  try { return loadavg().map(v => v.toFixed(2)).join('/') } catch { return 'unknown' }
}

/** The caller's metrics followed by `at` (when the record was written) and `load` (unless the caller already carries one). */
export function perfRecordMetrics<M extends Record<string, string | number | boolean | null>>(metrics: M): M & { at: string } & ('load' extends keyof M ? unknown : { load: string }) {
  const extra: Record<string, string> = { at: new Date().toISOString() }
  if (!('load' in metrics)) extra.load = machineLoad()
  return { ...metrics, ...extra } as M & { at: string } & ('load' extends keyof M ? unknown : { load: string })
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Polls `done` every `intervalMs` until it returns true; throws with `label` after `timeoutMs`. Returns elapsed ms. */
export async function waitFor(done: () => boolean | Promise<boolean>, label: string, timeoutMs: number, intervalMs = 50): Promise<number> {
  const started = performance.now()
  for (;;) {
    if (await done()) return performance.now() - started
    if (performance.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
    await sleep(intervalMs)
  }
}

// ------------------------------------------------------------------------------------------------------------ /proc sampling

export type ProcSample = { utimeMs: number; stimeMs: number; rssBytes: number; hwmBytes: number }
export type ProcIo = { rchar: number; wchar: number; readBytes: number; writeBytes: number }

const CLK_TCK = (() => { try { return Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100 } catch { return 100 } })()

export function procSample(pid: number): ProcSample | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // fields[0] is field 3 (state): utime is field 14 and stime field 15.
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? 0) * 1024
    return { utimeMs: (utime * 1000) / CLK_TCK, stimeMs: (stime * 1000) / CLK_TCK, rssBytes: kb('VmRSS'), hwmBytes: kb('VmHWM') }
  } catch {
    return null
  }
}

/** Resets the kernel's peak-RSS counter (VmHWM) of `pid` (Linux: `5` to /proc/<pid>/clear_refs), so a later VmHWM is the peak of one window. */
export function resetPeakRss(pid: number): boolean {
  try { writeFileSync(`/proc/${pid}/clear_refs`, '5'); return true } catch { return false }
}

export function procIo(pid: number): ProcIo | null {
  try {
    const io = readFileSync(`/proc/${pid}/io`, 'utf8')
    const v = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(io)?.[1] ?? NaN)
    return { rchar: v('rchar'), wchar: v('wchar'), readBytes: v('read_bytes'), writeBytes: v('write_bytes') }
  } catch {
    return null
  }
}

/** Whether /proc is available (Linux). Without it (macOS) the /proc-based CPU, I/O and RSS metrics read as unavailable. */
export const HAS_PROC = existsSync('/proc/self/stat')

function procEntries(): string[] {
  try { return readdirSync('/proc') } catch { return [] }
}

/** Direct children of `pid`, with their command lines. */
export function childProcesses(pid: number): Array<{ pid: number; cmdline: string }> {
  const out: Array<{ pid: number; cmdline: string }> = []
  for (const name of procEntries()) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (ppid !== pid) continue
      out.push({ pid: Number(name), cmdline: readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() })
    } catch { /* exited */ }
  }
  return out
}

/** Every live process whose command line contains `needle` (used to prove that nothing was left behind). */
export function processesMatching(needle: string): number[] {
  const out: number[] = []
  for (const name of procEntries()) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      if (readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').includes(needle)) out.push(Number(name))
    } catch { /* exited */ }
  }
  return out
}

/**
 * Samples one process's RSS (and the worker's, found by a callback) every `intervalMs`. Peak RSS is the larger of the sampled
 * maximum and the kernel's VmHWM (which also catches spikes between samples).
 */
export class RssSampler {
  private timer: NodeJS.Timeout | null = null
  readonly peaks = new Map<number, number>()
  readonly last = new Map<number, ProcSample>()
  private readonly pids: () => number[]
  private readonly intervalMs: number
  constructor(pids: () => number[], intervalMs = 100) {
    this.pids = pids
    this.intervalMs = intervalMs
  }
  start(): this {
    const tick = () => {
      for (const pid of this.pids()) {
        const s = procSample(pid)
        if (!s) continue
        this.last.set(pid, s)
        this.peaks.set(pid, Math.max(this.peaks.get(pid) ?? 0, s.rssBytes, s.hwmBytes))
      }
    }
    tick()
    this.timer = setInterval(tick, this.intervalMs)
    // A sampler never keeps a finished (or failed) measurement process alive.
    this.timer.unref()
    return this
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export const MiB = 1024 * 1024
export const mib = (bytes: number) => Math.round((bytes / MiB) * 10) / 10

// ------------------------------------------------------------------------------------------------------------ Git fixtures

const IDENTITY = ['-c', 'user.name=Atlas Perf', '-c', 'user.email=atlas-perf@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false']
/** Fixture Git: never the host's system or global configuration. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd, env: { PATH: PATH_ENV, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * MiB,
  }).toString('utf8').trim()
}

export function put(path: string, content: string | Buffer = 'x\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** A repository at `dir` whose `files` are committed on `main`. Returns its real path. */
export function makeRepo(dir: string, files: Record<string, string | Buffer> = { 'README.md': '# readme\n' }): string {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  for (const [rel, content] of Object.entries(files)) put(join(dir, rel), content)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'baseline'])
  return realpathSync(dir)
}

export function addWorktree(repo: string, dir: string, branch: string): string {
  git(repo, ['worktree', 'add', '-q', '-b', branch, dir])
  return realpathSync(dir)
}

/** `count` files of `bytes` each under `dir`, `perDir` per subfolder: `<dir>/d<NNN>/<prefix><NNNNN>.<ext>`. */
export function writeTree(dir: string, opts: { count: number; perDir: number; bytes: number; prefix?: string; ext?: string | ((i: number) => string) }): string[] {
  const paths: string[] = []
  const body = Buffer.alloc(opts.bytes, 'a')
  for (let i = 0; i < opts.count; i++) {
    const sub = join(dir, `d${String(Math.floor(i / opts.perDir)).padStart(4, '0')}`)
    if (i % opts.perDir === 0) mkdirSync(sub, { recursive: true })
    const ext = typeof opts.ext === 'function' ? opts.ext(i) : (opts.ext ?? 'md')
    const p = join(sub, `${opts.prefix ?? 'f'}${String(i).padStart(6, '0')}.${ext}`)
    // Distinct contents so no two documents are byte-identical by accident.
    writeFileSync(p, opts.bytes > 16 ? Buffer.concat([Buffer.from(`${i}\n`), body.subarray(0, opts.bytes - String(i).length - 1)]) : `${i}\n`)
    paths.push(p)
  }
  return paths
}

// ------------------------------------------------------------------------------------------------------------ ports and servers

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** A TCP server that accepts connections and never answers (a hung service). */
export async function hungServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}

// ------------------------------------------------------------------------------------------------------------ the real service

export type ProbeStats = {
  windowMs: number; samples: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; meanMs: number
  cpuUserMs: number; cpuSystemMs: number; rssBytes: number; peakRssBytes: number
  /** Live Buffer/ArrayBuffer and external bytes; `gcRan` is true when a `probe(.., true)` collection really ran (needs --expose-gc). */
  arrayBuffersBytes: number; externalBytes: number; gcRan: boolean
}

export type ServiceProcess = {
  home: string
  pid: number
  port: number
  base: string
  dbPath: string
  child: ChildProcess
  /** The probe's event-loop/CPU/RSS window; `reset` starts a new window. */
  probe(reset?: boolean, gc?: boolean): Promise<ProbeStats>
  /** The discovery worker child's pid, if one is running. */
  workerPid(): number | null
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string; ms: number }>
  /** SIGTERM, wait for exit (SIGKILL after 15 s); kills any child it left behind. */
  stop(): Promise<{ leftovers: number[] }>
  stderr(): string
}

/** Environment for every spawned program: nothing from this process's Git or Atlas environment. */
export function programEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: PATH_ENV, LANG: 'C.UTF-8', ...extra }
}

/**
 * Starts src/service/main.ts as `node --import <probe> src/service/main.ts` with HOME = `home` (so every Atlas path, the
 * catalog, the spool and the worker's HOME are inside the fixture) and the fake focus provider (no network, no keychain).
 * `config` is written to <home>/.josh-360/atlas/config.json first.
 */
export async function startServiceProcess(scope: Scope, opts: { home: string; config?: Record<string, unknown>; port?: number; nodeArgs?: string[] }): Promise<ServiceProcess> {
  const atlasDir = join(opts.home, '.josh-360', 'atlas')
  mkdirSync(atlasDir, { recursive: true, mode: 0o700 })
  if (opts.config) writeFileSync(join(atlasDir, 'config.json'), JSON.stringify(opts.config))
  const port = opts.port ?? await freePort()
  // nodeArgs: extra Node flags for a diagnostic run only. ATLAS_PERF_PROFILE_DIR=<dir> adds a V8 CPU profile of the service
  // (written when it exits) to find a bottleneck; measured runs set neither.
  const profile = process.env.ATLAS_PERF_PROFILE_DIR ? ['--cpu-prof', `--cpu-prof-dir=${process.env.ATLAS_PERF_PROFILE_DIR}`] : []
  const child = scope.track(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...profile, ...(opts.nodeArgs ?? []), '--import', PROBE, SERVICE_MAIN], {
    cwd: REPO_ROOT,
    env: programEnv({ HOME: opts.home, ATLAS_PORT: String(port), ATLAS_PROVIDER: 'fake' }),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }))
  let err = ''
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { if (err.length < 64_000) err += c })
  const pending = new Map<number, (s: ProbeStats) => void>()
  let nextId = 1
  child.on('message', (m: unknown) => {
    const msg = m as { type?: string; id?: number; stats?: ProbeStats }
    if (msg?.type === 'perf-snapshot' && typeof msg.id === 'number') { pending.get(msg.id)?.(msg.stats!); pending.delete(msg.id) }
  })
  const base = `http://127.0.0.1:${port}`
  const knownChildren = new Set<number>()
  const svc: ServiceProcess = {
    home: opts.home, pid: child.pid!, port, base, dbPath: join(atlasDir, 'atlas.db'), child,
    probe: (reset = false, gc = false) => new Promise<ProbeStats>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('probe snapshot timed out')) }, 10_000)
      pending.set(id, s => { clearTimeout(timer); resolve(s) })
      child.send({ type: 'perf-snapshot', id, reset, gc })
    }),
    workerPid: () => {
      const kids = childProcesses(child.pid!)
      for (const k of kids) knownChildren.add(k.pid)
      return kids.find(k => k.cmdline.includes('worker-main.ts'))?.pid ?? null
    },
    api: async (method, path, body) => {
      const t = performance.now()
      let res: Response
      try {
        res = await fetch(`${base}${path}`, {
          method, headers: body !== undefined || method === 'POST' ? { 'content-type': 'application/json' } : {},
          ...(body !== undefined ? { body: JSON.stringify(body) } : method === 'POST' ? { body: '{}' } : {}),
        })
      } catch (error) {
        // Say why: the transport's own code, and whether the service is still running (with the end of its stderr).
        const cause = (error as { cause?: { code?: string; message?: string } }).cause
        const state = child.exitCode !== null || child.signalCode !== null ? `service exited (code ${child.exitCode}, signal ${child.signalCode}): ${err.slice(-1500)}` : 'service running'
        throw new Error(`${method} ${path} failed after ${Math.round(performance.now() - t)} ms: ${cause?.code ?? cause?.message ?? String(error)}; ${state}`, { cause: error })
      }
      const text = await res.text()
      const ms = performance.now() - t
      let json: any = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return { status: res.status, json, text, ms }
    },
    stop: async () => {
      for (const k of childProcesses(child.pid!)) knownChildren.add(k.pid)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 15_000)
        await exited
        clearTimeout(killer)
      }
      // A child the service left behind is killed only while its command line still names one of the service's own
      // programs (a pid reused by an unrelated process is never signalled). Children are found through /proc: without it
      // (macOS) this check cannot run, and says so instead of reporting "no leftovers".
      const leftovers: number[] = []
      if (!HAS_PROC) {
        console.log(`PERF note: left-over worker/Git detection after a service stop needs /proc and was NOT done on ${process.platform}; check with: pgrep -fl 'worker-main.ts|git '`)
        return { leftovers }
      }
      for (const pid of knownChildren) {
        let cmdline = ''
        try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { continue }
        if (!/worker-main\.ts|costledger|src\/service\/main\.ts/.test(cmdline)) continue
        leftovers.push(pid)
        try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      }
      return { leftovers }
    },
    stderr: () => err,
  }
  scope.onCleanup(async () => { await svc.stop() })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`the service exited during start-up: ${err.slice(0, 2000)}`)
    try { return (await svc.api('GET', '/api/artifact-manager/status')).status === 200 } catch { return false }
  }, 'the service to listen', 30_000, 50)
  return svc
}

// ------------------------------------------------------------------------------------------------------------ programs

export type HookRun = { code: number | null; outcome: string; atMs: number; wallMs: number; startedAt: number; endedAt: number }

/** Spawns the real hook with one payload on stdin, exactly as Claude Code runs it. `wallMs` is spawn to exit, measured here. */
export function runHook(scope: Scope, payload: Record<string, unknown>, env: { home: string; port: number }): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const child = scope.track(spawn(process.execPath, [HOOK], {
      env: programEnv({ HOME: env.home, ATLAS_PORT: String(env.port), ATLAS_HOOK_TIMING: '1' }), stdio: ['pipe', 'ignore', 'pipe'],
    }))
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    let err = ''
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { err += c })
    child.on('error', reject)
    // `exit` marks the end of execution (the measured wall time); `close` comes once stderr is drained.
    let endedAt = Number.NaN
    child.once('exit', () => { endedAt = performance.now() })
    child.on('close', code => {
      if (Number.isNaN(endedAt)) endedAt = performance.now()
      clearTimeout(killer)
      const last = err.trim().split('\n').pop() ?? '{}'
      let trace: { outcome?: string; atMs?: number } = {}
      try { trace = JSON.parse(last) as typeof trace } catch { /* no trace */ }
      resolve({ code, outcome: trace.outcome ?? 'unknown', atMs: trace.atMs ?? -1, wallMs: endedAt - startedAt, startedAt, endedAt })
    })
    child.stdin!.on('error', () => {})
    child.stdin!.end(JSON.stringify(payload))
  })
}

export type ProgramRun = { code: number | null; out: string; err: string; ms: number }

/** Spawns a program with a minimal environment (never this process's), as a user's shell or Claude Code would. */
export function runProgram(scope: Scope, command: string, args: string[], env: Record<string, string>, cwd: string, stdin = '', timeoutMs = 120_000,
  onSpawn?: (pid: number) => void): Promise<ProgramRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = scope.track(spawn(command, args, { cwd, env: programEnv(env), stdio: ['pipe', 'pipe', 'pipe'] }))
    if (child.pid !== undefined) onSpawn?.(child.pid)
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    let out = ''
    let err = ''
    child.stdout!.setEncoding('utf8').on('data', (c: string) => { out += c })
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { err += c })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(killer); resolve({ code, out, err, ms: performance.now() - started }) })
    child.stdin!.on('error', () => {})
    child.stdin!.end(stdin)
  })
}

export const sid = (n: number): string => `${String(n).padStart(8, '0')}-6e70-4357-9e2f-a4ef9a4f33db`
export const sessionStart = (session: string, cwd: string) => ({ hook_event_name: 'SessionStart', session_id: session, cwd, source: 'startup' })
export const stopEvent = (session: string, cwd: string) => ({ hook_event_name: 'Stop', session_id: session, cwd, stop_hook_active: false })
export const writeTool = (session: string, cwd: string, path: string, toolUseId: string, type: 'create' | 'update') => ({
  hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: 'Write', tool_use_id: toolUseId,
  tool_input: { file_path: path, content: 'never forwarded' }, tool_response: { type, filePath: path, content: 'never forwarded' },
})
export const bashTool = (session: string, cwd: string, toolUseId: string) => ({
  hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: 'Bash', tool_use_id: toolUseId,
  tool_input: { command: 'python gen.py' }, tool_response: { stdout: '', stderr: '' },
})

// ------------------------------------------------------------------------------------------------------------ catalog reads

/** A read-only handle on a live service catalog (WAL readers never block the service's writer). */
export function openCatalogReadOnly(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) throw new Error('the catalog does not exist yet')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 2000')
  return db
}

export const countOf = (db: DatabaseSync, sql: string, ...p: Array<string | number | null>): number => Number((db.prepare(sql).get(...p) as { n: number | bigint }).n)
