// The Artifact Manager's discovery worker process (plan 2026-10-26 Task 5). The service (Task 7) starts it as
//   node --disable-warning=ExperimentalWarning src/artifacts/worker-main.ts
// under the platform's background-priority facility; this process never changes its own priority, never opens the Atlas
// database (nothing in its module graph can: see test/artifacts/worker.test.ts) and writes nothing but frames to stdout.
//
// Protocol, one JSON object per line in each direction (UTF-8, '\n'-terminated, at most 1 MiB per line):
//   service -> worker
//     request  an ArtifactWorkerRequest (no `type` field). Starts a job; accepted only while the worker is idle.
//     ack      { "type": "ack", "jobId": ... }: the service committed the job's outstanding frame.
//   worker -> service
//     ArtifactWorkerFrame lines only. A job is one slice: zero or more data frames (rows, complete:false) and one terminal
//     frame (rows: []), as documented in discovery.ts. After EACH frame the worker waits for the matching ack before it
//     produces the next one: at most one unacknowledged frame per job, and the slice does no work while it waits. The job
//     ends when its terminal frame is acknowledged; only then is the worker idle again.
//   Protocol-level refusals (a line that is not valid UTF-8 JSON, over 1 MiB, an unknown message type, a malformed ack, a
//   request without a usable job ID, or a request while a job is active) are answered at once with a frame whose jobId is ''
//   and error code `invalid-request`, `oversized-request` or `worker-busy`. They belong to no job and are never acknowledged;
//   an ack for them (or any ack with no outstanding frame for its job) is ignored. A request with a usable job ID but an
//   invalid field is a job of its own: one terminal `invalid-request` frame, acknowledged like any other.
//   Every frame is validated against the frame bounds before it is written; a frame that fails (a bug) is replaced by a
//   terminal `invalid-frame` frame carrying the last good cursor, and the job ends.
//   Closing stdin (or SIGTERM/SIGINT/SIGHUP) ends the process promptly and kills every Git child it started, wherever the
//   current job is. stderr carries short diagnostics only: never paths, names or contents.

import diagnosticsChannel from 'node:diagnostics_channel'
import type { ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ArtifactAckFrame, ArtifactWorkerFrame, ArtifactWorkerRequest } from './contracts.ts'
import {
  ARTIFACT_IPC_LIMITS, artifactRejectionFrame, discoverArtifactSlice, encodeArtifactWorkerFrame, isTerminalArtifactFrame, validateArtifactWorkerFrame,
} from './discovery.ts'

export type ArtifactWorkerIo = {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** One diagnostic line (no paths, names or contents). */
  log(line: string): void
  exit(code: number): void
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const LONE_SURROGATE_RE = /\p{Cs}/u
// Lines read ahead of the consumer; beyond this the input is paused (no unbounded buffering).
const MAX_QUEUED_LINES = 64

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isJobId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !CONTROL_RE.test(v) && !LONE_SURROGATE_RE.test(v)
/** Exactly the frozen ArtifactAckFrame: { type: 'ack', jobId }, nothing else. */
const isAckFrame = (v: Record<string, unknown>): v is ArtifactAckFrame =>
  v.type === 'ack' && isJobId(v.jobId) && Object.keys(v).every(k => k === 'type' || k === 'jobId')

function processIo(): ArtifactWorkerIo {
  return {
    input: process.stdin,
    output: process.stdout,
    log: line => { process.stderr.write(`artifact-worker: ${line}\n`) },
    exit: code => process.exit(code),
  }
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  // Git children run in their own process group (detached); kill the whole group, then the child itself.
  try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* not a group leader, or gone */ }
  try { child.kill('SIGKILL') } catch { /* gone */ }
}

function label(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  const name = e instanceof Error ? e.name : typeof e
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? `${name} ${code}` : name
}

type Line = Buffer | 'oversized'
/** The active job. `release` is armed while one frame is outstanding; `terminal` says that frame ends the job. */
type Job = { jobId: string; release: ((acked: boolean) => void) | null; terminal: boolean }

/** Serves the protocol on `io` until the input closes. `shutdown` kills every Git child, then exits through `io.exit`. */
export function runArtifactWorker(io: ArtifactWorkerIo = processIo()): { shutdown(code: number): void } {
  const children = new Set<ChildProcess>()
  // Every process this worker spawns (the Git adapter's included) is announced on this documented channel.
  diagnosticsChannel.subscribe('child_process', message => {
    const child = (message as { process?: ChildProcess }).process
    if (!child) return
    children.add(child)
    child.once('exit', () => children.delete(child))
  })

  let active: Job | null = null
  let shuttingDown = false
  const shutdown = (code: number): void => {
    if (shuttingDown) return
    shuttingDown = true
    for (const child of children) killChild(child)
    active?.release?.(false)
    io.exit(code)
  }

  const writeLine = (line: string): Promise<void> => new Promise(resolve => {
    if (shuttingDown) { resolve(); return }
    if (io.output.write(`${line}\n`)) resolve()
    else io.output.once('drain', () => resolve())
  })
  const reject = (code: string, message: string): Promise<void> => writeLine(encodeArtifactWorkerFrame(artifactRejectionFrame(code, message)))

  const awaitAck = (job: Job, terminal: boolean): Promise<boolean> => new Promise<boolean>(resolve => {
    if (shuttingDown) { resolve(false); return }
    job.terminal = terminal
    job.release = resolve
  })

  const runJob = async (request: ArtifactWorkerRequest): Promise<void> => {
    const job: Job = { jobId: request.jobId, release: null, terminal: false }
    active = job
    let lastGoodCursor = typeof request.cursor === 'string' && Buffer.byteLength(request.cursor) <= ARTIFACT_IPC_LIMITS.maxCursorBytes ? request.cursor : null
    const slice = discoverArtifactSlice(request)
    try {
      for (;;) {
        const next = await slice.next()
        if (next.done || shuttingDown) break
        let frame: ArtifactWorkerFrame = next.value
        let last = isTerminalArtifactFrame(frame)
        if (frame.jobId !== request.jobId || validateArtifactWorkerFrame(frame) !== null) {
          io.log('replaced a frame that broke the frame bounds')
          frame = {
            type: 'batch', jobId: request.jobId, rows: [], cursor: lastGoodCursor, complete: false, coverage: 'partial',
            counts: { visited: 0, eligible: 0, skipped: 0 }, error: { code: 'invalid-frame', message: 'a frame broke the frame bounds and was not sent' },
          }
          last = true
        } else {
          lastGoodCursor = frame.cursor
        }
        // Armed before the write: on an asynchronous pipe the service can read the line and acknowledge it before 'drain'.
        const acked = awaitAck(job, last)
        await writeLine(encodeArtifactWorkerFrame(frame))
        if (!(await acked) || last) break
      }
    } catch (e) {
      // discoverArtifactSlice reports failures as frames; reaching here is a bug. End the job explicitly.
      io.log(`job failed unexpectedly: ${label(e)}`)
      if (!shuttingDown) {
        const acked = awaitAck(job, true)
        await writeLine(encodeArtifactWorkerFrame({
          type: 'batch', jobId: request.jobId, rows: [], cursor: lastGoodCursor, complete: false, coverage: 'partial',
          counts: { visited: 0, eligible: 0, skipped: 0 }, error: { code: 'internal-error', message: `worker failure: ${label(e)}` },
        }))
        await acked
      }
    } finally {
      try { await slice.return(undefined) } catch { /* already closed */ }
      if (active === job) active = null
    }
  }

  const handleLine = async (raw: Line): Promise<void> => {
    if (raw === 'oversized') return reject('oversized-request', `a line exceeded ${ARTIFACT_IPC_LIMITS.maxLineBytes} bytes`)
    let text: string
    try {
      text = STRICT_UTF8.decode(raw)
    } catch {
      return reject('invalid-request', 'a line is not valid UTF-8')
    }
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (text.trim() === '') return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return reject('invalid-request', 'a line is not JSON')
    }
    if (!isObj(message)) return reject('invalid-request', 'a line is not a JSON object')
    if (message.type === 'ack') {
      if (!isAckFrame(message)) return reject('invalid-request', 'an acknowledgement is exactly { type: "ack", jobId }')
      const ack: ArtifactAckFrame = message
      const job = active
      if (job === null || job.release === null || job.jobId !== ack.jobId) {
        io.log('ignored an acknowledgement with no outstanding frame for its job')
        return
      }
      const release = job.release
      job.release = null
      // The job ends the moment its terminal frame is acknowledged, so a request on the very next line is accepted.
      if (job.terminal) active = null
      release(true)
      return
    }
    if (message.type !== undefined) return reject('invalid-request', 'unknown message type')
    if (!isJobId(message.jobId)) return reject('invalid-request', 'a request needs a job ID')
    if (active !== null) return reject('worker-busy', 'a job is active; send the next request after its terminal frame is acknowledged')
    void runJob(message as ArtifactWorkerRequest)
  }

  // Line splitting with a hard per-line bound: an over-long line is discarded as it streams in, never buffered whole.
  const queue: Line[] = []
  let wake: (() => void) | null = null
  let parts: Buffer[] = []
  let partBytes = 0
  let discarding = false
  const enqueue = (line: Line): void => {
    queue.push(line)
    if (queue.length >= MAX_QUEUED_LINES) io.input.pause()
    wake?.()
  }
  io.input.on('data', (chunk: Buffer | string) => {
    let data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    for (;;) {
      const nl = data.indexOf(0x0a)
      const piece = nl < 0 ? data : data.subarray(0, nl)
      if (!discarding) {
        if (partBytes + piece.length > ARTIFACT_IPC_LIMITS.maxLineBytes) {
          discarding = true
          parts = []
          partBytes = 0
        } else if (piece.length > 0) {
          parts.push(Buffer.from(piece))
          partBytes += piece.length
        }
      }
      if (nl < 0) break
      enqueue(discarding ? 'oversized' : Buffer.concat(parts, partBytes))
      parts = []
      partBytes = 0
      discarding = false
      data = data.subarray(nl + 1)
    }
  })
  io.input.on('end', () => shutdown(0))
  io.input.on('close', () => shutdown(0))
  io.input.on('error', () => shutdown(0))
  io.output.on('error', () => shutdown(0))

  void (async () => {
    for (;;) {
      while (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
      wake = null
      const line = queue.shift()!
      if (queue.length < MAX_QUEUED_LINES / 2) io.input.resume()
      try {
        await handleLine(line)
      } catch (e) {
        io.log(`line handling failed: ${label(e)}`)
      }
    }
  })()
  return { shutdown }
}

function isEntryModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryModule()) {
  const io = processIo()
  const worker = runArtifactWorker(io)
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) process.once(signal, () => worker.shutdown(code))
  // Never let a stack trace (whose message could name a path) reach stderr.
  process.on('uncaughtException', e => { io.log(`fatal: ${label(e)}`); worker.shutdown(70) })
  process.on('unhandledRejection', e => { io.log(`fatal: ${label(e)}`); worker.shutdown(70) })
}
