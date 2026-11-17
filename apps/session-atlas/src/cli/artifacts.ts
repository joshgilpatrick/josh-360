// `npm run artifacts -- <command>`: the operator CLI of the Artifact Manager (plan 2026-10-26 Task 10; spec sections 9, 11 and 13).
//
//   status [--json]                                         coverage of the registered roots, from the local service
//   refresh --root ID [--include-older]                     queue a rescan of one registered root
//   register-output --path ABS [--repo ABS]                 register an existing folder as an output root
//   output-dir --repo ABS [--create]                        the durable output directory of a repository
//   check-removal --worktree ABS [--json] [--timeout-ms N]  the read-only worktree removal checker
//
// What it never does: write the Atlas database or the cost ledger (catalog changes go through the local service, one writer),
// delete, move or overwrite anything, rewrite scripts, or scan broadly. check-removal reads the catalog only through the
// checker's own read-only handle and passes the configured path; it opens nothing itself and creates nothing.
//
// Exit codes (ruling R52). check-removal exits with the checker's code (0, 2 or 3) ONLY when the checker produced a well-formed
// result, so a caller that treats only 0 as safe and 2/3 as checker answers can never mistake a failure of this program for
// one. Everything else: 64 usage error (message and usage on stderr, nothing on stdout), 65 data error (output-dir: repository
// not registered, directory unsafe), 69 the service is unavailable or refused the request, 70 internal error. main() returns
// the code and sets nothing global: the program entry assigns process.exitCode and lets the event loop drain, because an
// abandoned Git child of the checker can outlive the answer by several seconds.

import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig, type AtlasConfig } from '../config.ts'
import { resolveGitCheckout } from '../artifacts/git.ts'
import { canonicalizeArtifactRoot, FIXED_DISCOVERY_SEGMENTS, MAX_ARTIFACT_PATH_CHARS } from '../artifacts/path-policy.ts'
import {
  checkWorktreeRemoval, DEFAULT_REMOVAL_CHECK_TIMEOUT_MS, REMOVAL_CHECK_REMOTE_RETENTION_NOTE,
  type RemovalCheckOptions, type RemovalCheckResult, type RemovalSessionProbeAnswer,
} from '../artifacts/removal-check.ts'
import { isValidSessionId } from '../ingest/event.ts'
import { artifactRefusedDirectories, isArtifactRootRefused } from '../service/artifact-manager-runner.ts'

// ------------------------------------------------------------------------------------------------------------------ contract

export const EXIT_USAGE = 64
export const EXIT_DATA = 65
export const EXIT_SERVICE = 69
export const EXIT_INTERNAL = 70

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 3000
const HIDDEN_LOCATION = 'Protected location (hidden)'

/** The live-session probe's bounds. Every one ends in `unknown`, never in `inactive`. */
export type SessionProbeSettings = {
  /** Rows per page; the service's own maximum is 500, and a service that answers with another limit makes the probe unknown. */
  pageSize: number
  /** Pages read per status, then unknown. */
  maxPages: number
  /** Session detail lookups for the start folder, in total over both statuses, then unknown. */
  maxDetailLookups: number
  detailConcurrency: number
  /** Wall-time bound of the whole probe. */
  totalMs: number
  /** One request. */
  requestTimeoutMs: number
}

export type CliDeps = {
  /** Environment for configuration (HOME, ATLAS_HOME, ATLAS_PORT) and the caller directory (INIT_CWD). Default: process.env. */
  env?: NodeJS.ProcessEnv
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  /** The removal checker (default: the real one). */
  checkWorktreeRemoval?: (target: string, options: RemovalCheckOptions) => Promise<RemovalCheckResult>
  probe?: Partial<SessionProbeSettings>
  /** Timeout of one service request (default 3 s). */
  requestTimeoutMs?: number
  /** The user ID that must own the directories output-dir uses (default: this process's). */
  uid?: number
  /** Test seam: called once the durable directory tree exists, before it is verified again and registered. It weakens no check. */
  hooks?: { afterCreate?: (directory: string) => void }
  now?: () => number
}

const USAGE = `usage: npm run artifacts -- <command> [options]

commands:
  status [--json]
      Artifact Manager coverage from the local Atlas service: discovery paused or running, the queue, and every registered root
      with its state, gaps and failures. A protected location is shown as "${HIDDEN_LOCATION}".
  refresh --root <root-id> [--include-older]
      Queue a rescan of one registered root (status lists the IDs). It only queues work; nothing is scanned by this command.
  register-output --path <absolute-folder> [--repo <absolute-path-inside-a-registered-checkout>]
      Register an existing folder as an output root. The service validates the path and refuses secret, runtime and
      out-of-home folders.
  output-dir --repo <absolute-path> [--create]
      Print the durable output directory of the repository that contains --repo:
      <durable base>/<repository-uuid>/deliverables (default base ~/.claude/artifact-output). The path is the only line on
      stdout, so generators can take it as ATLAS_OUTPUT_DIR="$(npm run -s artifacts -- output-dir --repo "$PWD" --create)".
      With --create the directory is made private (mode 0700) and registered as an output root. Nothing that exists is ever
      changed, overwritten or deleted; a directory that is a symbolic link, is not yours, is open to group or others, or lies
      inside a checkout is refused. The repository must already be registered with the service.
  check-removal --worktree <absolute-path> [--json] [--timeout-ms <1000-120000>]
      Read-only check, to run immediately before ONE ordinary "git worktree remove <path>" of that linked worktree. It looks at
      the filesystem and Git, reads the Atlas catalog read-only and asks the service which sessions are live. The answer is valid
      for the next single removal only; it never authorizes a forced removal and this command never removes anything.
      Large worktrees may need a longer --timeout-ms (default ${DEFAULT_REMOVAL_CHECK_TIMEOUT_MS}).

exit codes:
  check-removal   0 a complete check found nothing at risk    3 risks were found    2 incomplete: coverage or proof is missing
                  Only 0 permits the removal; 2 and 3 both block it. Nothing else can produce 0, 2 or 3 (see below).
  all commands    64 usage error (usage on stderr, nothing on stdout)    69 the Atlas service is unavailable or refused the request
                  70 internal error    65 output-dir: repository not registered or directory unsafe

notes:
  check-removal works while Atlas is stopped: without the service the sessions are unknown (exit 2), and a missing catalog
  (atlas.db) is reported as incomplete coverage; it never creates the catalog and never writes it. Opening a checkpointed WAL
  catalog read-only can leave empty atlas.db-wal and atlas.db-shm files beside it; a read-only directory makes the catalog
  unreadable, which is exit 2. A usage error or an internal error never exits 0, 2 or 3.
  No command deletes, moves or rewrites anything, and none defaults to a broad scan.
`

// ------------------------------------------------------------------------------------------------------------------ helpers

class UsageError extends Error {}

type Io = { out(text: string): void; err(text: string): void }

type Ctx = {
  io: Io
  config: AtlasConfig
  env: NodeJS.ProcessEnv
  deps: CliDeps
  service: ServiceTarget
  requestTimeoutMs: number
  now: () => number
}

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const CONTROL_OR_SURROGATE = /[\u0000-\u001f\u007f-\u009f]|\p{Cs}/u
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Text safe for a terminal: control characters (C0, DEL, C1, including newlines and ESC), line separators and bidi marks become `?`. */
function printable(value: unknown): string {
  return String(value).replace(UNSAFE_TEXT, '?')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errnoCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === 'string' ? error.code : undefined
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}

function fail(ctx: Ctx, message: string): void {
  ctx.io.err(`error: ${printable(message)}\n`)
}

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// ------------------------------------------------------------------------------------------------------------------- parsing

type OptionType = 'string' | 'boolean'
const COMMANDS: Readonly<Record<string, { options: Readonly<Record<string, OptionType>>; required: readonly string[] }>> = {
  status: { options: { json: 'boolean' }, required: [] },
  refresh: { options: { root: 'string', 'include-older': 'boolean' }, required: ['root'] },
  'register-output': { options: { path: 'string', repo: 'string' }, required: ['path'] },
  'output-dir': { options: { repo: 'string', create: 'boolean' }, required: ['repo'] },
  'check-removal': { options: { worktree: 'string', json: 'boolean', 'timeout-ms': 'string' }, required: ['worktree'] },
}

type Parsed = { command: string; given: Record<string, string | true> }

/** Strict parse: unknown, duplicate, valueless and positional arguments are usage errors. */
function parseCommand(argv: string[]): Parsed {
  const command = argv[0]
  if (command === undefined) throw new UsageError('a command is required')
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`unknown command "${printable(command)}"`)
  const spec = COMMANDS[command]!
  const options: Record<string, { type: OptionType; multiple: true }> = {}
  for (const [name, type] of Object.entries(spec.options)) options[name] = { type, multiple: true }
  let values: Record<string, Array<string | boolean> | undefined>
  try {
    values = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: false }).values as unknown as Record<string, Array<string | boolean> | undefined>
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'the arguments could not be parsed')
  }
  const given: Record<string, string | true> = {}
  for (const [name, type] of Object.entries(spec.options)) {
    const list = values[name]
    if (list === undefined) continue
    if (list.length !== 1) throw new UsageError(`--${name} may be given only once`)
    const value = list[0]
    if (type === 'string') {
      if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} needs a value`)
      given[name] = value
    } else {
      given[name] = true
    }
  }
  for (const name of spec.required) if (given[name] === undefined) throw new UsageError(`--${name} is required`)
  return { command, given }
}

/** An absolute, normalized path with no control characters: the CLI never guesses what a relative or odd spelling meant. */
function absolutePath(flag: string, value: string): string {
  if (CONTROL_OR_SURROGATE.test(value)) throw new UsageError(`${flag} must not contain control characters`)
  if (value.length > MAX_ARTIFACT_PATH_CHARS) throw new UsageError(`${flag} is too long`)
  if (!isAbsolute(value)) throw new UsageError(`${flag} must be an absolute path`)
  if (value.split('/').includes('..')) throw new UsageError(`${flag} must not contain ".." segments`)
  return value
}

function timeoutOption(value: string | true | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) throw new UsageError(`--timeout-ms must be a whole number from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`)
  const ms = Number(value)
  if (ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) throw new UsageError(`--timeout-ms must be a whole number from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`)
  return ms
}

// ------------------------------------------------------------------------------------------------------------------ service

type ServiceTarget = { host: string; port: number }
type ServiceReply = { status: number; body: unknown }

class ServiceError extends Error {
  readonly kind: 'unreachable' | 'timeout' | 'too-large'
  constructor(kind: 'unreachable' | 'timeout' | 'too-large') {
    super(`service ${kind}`)
    this.kind = kind
  }
}

function parseJson(bytes: Buffer): unknown {
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** One local HTTP call (127.0.0.1, no proxy, no keep-alive, no Origin). Every failure is a ServiceError; a non-JSON body is `undefined`. */
function callService(
  target: ServiceTarget, method: 'GET' | 'POST', path: string, options: { body?: unknown; timeoutMs: number; signal?: AbortSignal },
): Promise<ServiceReply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body))
    const headers: Record<string, string | number> = { accept: 'application/json', connection: 'close' }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const request = httpRequest({ host: target.host, port: target.port, method, path, headers, agent: false })
    const onAbort = (): void => end(() => reject(new ServiceError('timeout')))
    function end(settle: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      settle()
      request.destroy()
    }
    timer = setTimeout(() => end(() => reject(new ServiceError('timeout'))), options.timeoutMs)
    request.on('error', () => end(() => reject(new ServiceError('unreachable'))))
    request.on('response', response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) end(() => reject(new ServiceError('too-large')))
        else chunks.push(chunk)
      })
      response.on('end', () => end(() => resolve({ status: response.statusCode ?? 0, body: parseJson(Buffer.concat(chunks)) })))
      response.on('error', () => end(() => reject(new ServiceError('unreachable'))))
    })
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    request.end(payload ?? undefined)
  })
}

/** A service call for a command. On failure the corrective message is printed and null is returned (the caller exits 69). */
async function request(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ServiceReply | null> {
  try {
    return await callService(ctx.service, method, path, { body, timeoutMs: ctx.requestTimeoutMs })
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    if (error.kind === 'unreachable') {
      fail(ctx, `the Atlas service is not reachable on ${ctx.service.host}:${ctx.service.port}; start it (npm start, or the installed launchd service) and run this command again`)
    } else if (error.kind === 'timeout') {
      fail(ctx, 'the Atlas service did not answer in time; check that it is running and not overloaded, then run this command again')
    } else {
      fail(ctx, 'the Atlas service sent an answer that is too large to read')
    }
    return null
  }
}

function errorCodeOf(body: unknown): string | null {
  return isObject(body) && isObject(body.error) && typeof body.error.code === 'string' ? body.error.code : null
}

/** A non-success answer: a fixed corrective sentence chosen by the error code, never the server's own text. Exit 69. */
function refusal(ctx: Ctx, reply: ServiceReply, table: Readonly<Record<string, string>>): number {
  if (reply.status < 400) return unexpectedAnswer(ctx)
  const code = errorCodeOf(reply.body)
  const fixed = code !== null && Object.hasOwn(table, code) ? table[code] : undefined
  if (fixed !== undefined) fail(ctx, `the Atlas service refused the request (HTTP ${reply.status}): ${fixed}`)
  else if (reply.status >= 500) fail(ctx, `the Atlas service failed to handle the request (HTTP ${reply.status}); see its log`)
  else fail(ctx, `the Atlas service refused the request (HTTP ${reply.status})`)
  return EXIT_SERVICE
}

function unexpectedAnswer(ctx: Ctx): number {
  fail(ctx, 'the Atlas service sent an answer this command does not understand; check that the service and this checkout are the same version')
  return EXIT_SERVICE
}

const REFRESH_ERRORS: Readonly<Record<string, string>> = {
  'root-not-found': 'no registered root has this ID; run "npm run artifacts -- status" to list root IDs',
  'root-inactive': 'this root is inactive; register it again, then refresh',
  'root-refused': 'this root overlaps Atlas data and is never scanned',
  'direct-only-root': 'this root records only directly observed files and is never bulk-scanned',
  'root-not-scannable': 'this checkout has no resolved Git identity yet; wait for its first scan, then refresh',
  'invalid-body': 'the service rejected the request',
}

const ROOT_ERRORS: Readonly<Record<string, string>> = {
  'invalid-body': 'the service rejected --path or --repo as invalid',
  'root-relative': '--path must be an absolute path',
  'root-outside-home': 'the folder must be inside your home directory and outside secret, Git and Atlas runtime folders',
  'root-symlink-escape': 'the folder resolves through a symbolic link to a place Atlas may not use',
  'root-refused': 'Atlas data, spool and cost-ledger folders cannot be artifact roots',
  'root-missing': 'the folder does not exist; create it first',
  'root-not-directory': 'the path is not a folder',
  'repository-not-registered': 'that folder is not inside a registered checkout; use Claude Code in the checkout so Atlas registers it, or leave --repo out',
  'root-conflict': 'this folder is already registered as a checkout or for another repository; nothing was changed',
}

// ------------------------------------------------------------------------------------------------------------------- status

type StatusDoc = { doc: Record<string, unknown>; roots: Array<Record<string, unknown>> }

function readStatus(body: unknown): StatusDoc | null {
  if (!isObject(body) || typeof body.paused !== 'boolean') return null
  if (typeof body.pendingJobs !== 'number' || !Number.isFinite(body.pendingJobs)) return null
  if (!Array.isArray(body.roots)) return null
  const roots: Array<Record<string, unknown>> = []
  for (const root of body.roots) {
    if (!isObject(root) || typeof root.rootId !== 'string' || typeof root.kind !== 'string') return null
    roots.push(root)
  }
  return { doc: body, roots }
}

/** A protected root never shows its path or project name, whatever the service sent. */
function isHidden(root: Record<string, unknown>): boolean {
  return root.pathRedacted === true || root.protected === true
}

function rootLabel(root: Record<string, unknown>): string {
  if (isHidden(root)) return HIDDEN_LOCATION
  const where = typeof root.path === 'string' ? root.path : `root ${String(root.rootId)}`
  return typeof root.projectName === 'string' && root.projectName !== '' ? `${where} (${root.projectName})` : where
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function statusReport(status: StatusDoc, now: number): string {
  const { doc, roots } = status
  const pending = doc.pendingJobs as number
  const lines = ['Artifact Manager', `Discovery: ${doc.paused === true ? 'paused' : 'running'}`]
  const oldest = typeof doc.oldestQueueAgeMs === 'number' && Number.isFinite(doc.oldestQueueAgeMs) ? doc.oldestQueueAgeMs : 0
  lines.push(`Queue: ${pending} pending job${pending === 1 ? '' : 's'}${pending > 0 ? `, oldest waiting ${ageText(oldest)}` : ''}`)
  if (roots.length === 0) {
    lines.push('', 'No roots are registered yet.')
    return `${lines.map(printable).join('\n')}\n`
  }
  lines.push('', `Roots (${roots.length}):`)
  for (const root of roots) {
    lines.push(`- ${String(root.kind)}  ${rootLabel(root)}  [root ${String(root.rootId)}]`)
    const last = typeof root.lastSuccessfulAt === 'string' ? root.lastSuccessfulAt : null
    const parsed = last === null ? Number.NaN : Date.parse(last)
    const when = last === null ? 'never' : Number.isNaN(parsed) ? last : `${last} (${ageText(now - parsed)} ago)`
    lines.push(`    state: ${typeof root.state === 'string' ? root.state : 'unknown'}; last successful scan: ${when}`)
    const gaps = stringList(root.gaps)
    if (gaps.length > 0) lines.push(`    gaps: ${gaps.join(', ')}`)
    const failures = Array.isArray(root.failures) ? root.failures.filter(isObject) : []
    if (failures.length > 0) lines.push(`    failures: ${failures.map(f => `${String(f.task)} (${String(f.code)})`).join(', ')}`)
    if (root.includeOlderPending === true) lines.push('    importing older files')
    if (typeof root.reason === 'string' && root.reason !== '') lines.push(`    note: ${root.reason}`)
  }
  return `${lines.map(printable).join('\n')}\n`
}

async function runStatus(ctx: Ctx, json: boolean): Promise<number> {
  const reply = await request(ctx, 'GET', '/api/artifact-manager/status')
  if (!reply) return EXIT_SERVICE
  if (reply.status !== 200) return refusal(ctx, reply, {})
  const status = readStatus(reply.body)
  if (!status) return unexpectedAnswer(ctx)
  if (json) {
    const roots = status.roots.map(root => (isHidden(root) ? { ...root, path: null, pathRedacted: true, projectName: null } : root))
    ctx.io.out(`${JSON.stringify({ ...status.doc, roots }, null, 2)}\n`)
  } else {
    ctx.io.out(statusReport(status, ctx.now()))
  }
  return 0
}

// ------------------------------------------------------------------------------------------------------------------ refresh

async function runRefresh(ctx: Ctx, rootArg: string, includeOlder: boolean): Promise<number> {
  const rootId = rootArg.toLowerCase()
  const reply = await request(ctx, 'POST', '/api/artifact-manager/refresh', includeOlder ? { rootId, includeOlder: true } : { rootId })
  if (!reply) return EXIT_SERVICE
  if (reply.status !== 202) return refusal(ctx, reply, REFRESH_ERRORS)
  const body = reply.body
  const idOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
  if (!isObject(body) || !idOrNull(body.jobId) || !(body.historyJobId === undefined || idOrNull(body.historyJobId)) || typeof body.paused !== 'boolean') return unexpectedAnswer(ctx)
  const lines = [`Refresh queued for root ${rootId}.`, `Scan job: ${typeof body.jobId === 'string' ? body.jobId : 'none queued'}`]
  if (typeof body.historyJobId === 'string') lines.push(`Older-files import job: ${body.historyJobId}`)
  if (body.paused) lines.push('Discovery is paused: the queued work starts after discovery is resumed.')
  ctx.io.out(`${lines.map(printable).join('\n')}\n`)
  return 0
}

// ------------------------------------------------------------------------------------------------------------ register-output

type RegisteredRoot = { rootId: string; kind: string; path: string; protected: boolean; repositoryId: string | null; created: boolean; jobId: string | null }

function readRegistration(reply: ServiceReply): RegisteredRoot | null {
  if (reply.status !== 200 && reply.status !== 201) return null
  const body = reply.body
  if (!isObject(body) || !isObject(body.root) || !(body.jobId === null || typeof body.jobId === 'string')) return null
  const root = body.root
  if (typeof root.rootId !== 'string' || typeof root.kind !== 'string' || typeof root.path !== 'string' || typeof root.protected !== 'boolean') return null
  if (!(root.repositoryId === null || typeof root.repositoryId === 'string')) return null
  return { rootId: root.rootId, kind: root.kind, path: root.path, protected: root.protected, repositoryId: root.repositoryId, created: reply.status === 201, jobId: body.jobId }
}

async function runRegisterOutput(ctx: Ctx, path: string, repo: string | undefined): Promise<number> {
  const reply = await request(ctx, 'POST', '/api/artifact-manager/roots', repo === undefined ? { path } : { path, repo })
  if (!reply) return EXIT_SERVICE
  if (reply.status !== 200 && reply.status !== 201) return refusal(ctx, reply, ROOT_ERRORS)
  const root = readRegistration(reply)
  if (!root) return unexpectedAnswer(ctx)
  ctx.io.out(`${[
    root.created ? 'Registered the output folder.' : 'This folder was already registered; nothing was changed.',
    `Root: ${root.rootId} (${root.kind}, ${root.protected ? 'protected' : 'not protected'})`,
    `Folder: ${root.protected ? HIDDEN_LOCATION : root.path}`,
    `Repository: ${root.repositoryId ?? 'none'}`,
    `Scan job: ${root.jobId ?? 'none queued'}`,
  ].map(printable).join('\n')}\n`)
  return 0
}

// ------------------------------------------------------------------------------------------------------------------ output-dir

type DirIssue = 'symlink' | 'not-directory' | 'not-owner' | 'not-private'
type StatLike = NonNullable<ReturnType<typeof lstatOrNull>>

const DIR_ISSUES: Readonly<Record<DirIssue, string>> = {
  symlink: 'is a symbolic link; it was not followed or changed',
  'not-directory': 'exists but is not a directory; it was not changed',
  'not-owner': 'is not owned by you; it was not changed',
  'not-private': 'is not private (group or other permission bits are set); it was not changed',
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * Whether an existing directory may be used: a real directory (not a link), owned by `uid`, with no group or other permission
 * bits ('private': the repository and deliverables directories) or at least no group/other write bit ('base': the durable
 * base, which other tools may have made 0755).
 */
function issueOf(stat: StatLike, uid: number, rule: 'private' | 'base'): DirIssue | null {
  if (stat.isSymbolicLink()) return 'symlink'
  if (!stat.isDirectory()) return 'not-directory'
  if (stat.uid !== uid) return 'not-owner'
  if ((stat.mode & (rule === 'private' ? 0o077 : 0o022)) !== 0) return 'not-private'
  return null
}

/** The canonical form of `path`: its deepest existing ancestor resolved through every symlink, then the missing tail appended. */
function canonicalWithTail(path: string): string {
  let existing = path
  const tail: string[] = []
  while (lstatOrNull(existing) === null) {
    if (existing === '/') throw new Error('no existing ancestor')
    tail.unshift(basename(existing))
    existing = dirname(existing)
  }
  const real = realpathSync.native(existing)
  return tail.length === 0 ? real : join(real, ...tail)
}

type RegisteredRepository = { kind: 'ok'; repositoryId: string } | { kind: 'none' } | { kind: 'invalid' }

/** The repository ID of the registered checkout whose root is exactly `worktree`; anything ambiguous is "none". */
function registeredRepository(roots: Array<Record<string, unknown>>, worktree: string): RegisteredRepository {
  const ids = new Set<unknown>()
  for (const root of roots) if (root.kind === 'checkout' && root.path === worktree) ids.add(root.repositoryId)
  if (ids.size !== 1) return { kind: 'none' }
  const [id] = [...ids]
  if (id === null || id === undefined) return { kind: 'none' }
  return typeof id === 'string' && UUID_RE.test(id) ? { kind: 'ok', repositoryId: id.toLowerCase() } : { kind: 'invalid' }
}

function dataError(ctx: Ctx, message: string): number {
  fail(ctx, message)
  return EXIT_DATA
}

function issueMessage(path: string, issue: DirIssue): string {
  return `the durable output directory component ${path} ${DIR_ISSUES[issue]}`
}

async function runOutputDir(ctx: Ctx, repoArg: string, create: boolean): Promise<number> {
  let checkout
  try {
    checkout = await resolveGitCheckout(repoArg)
  } catch {
    return dataError(ctx, 'Git could not read the repository at --repo (an unsafe-ownership or damaged repository is refused)')
  }
  if (checkout === null) return dataError(ctx, '--repo is not inside a Git checkout')

  // The repository UUID is assigned by the service; it is read from the registered checkout and never derived locally. Paths
  // are requested unredacted only to MATCH the checkout: none of them is printed.
  const reply = await request(ctx, 'GET', '/api/artifact-manager/status?sensitive=show')
  if (!reply) return EXIT_SERVICE
  if (reply.status !== 200) return refusal(ctx, reply, {})
  const status = readStatus(reply.body)
  if (!status) return unexpectedAnswer(ctx)
  const registered = registeredRepository(status.roots, checkout.worktreePath)
  if (registered.kind === 'invalid') return unexpectedAnswer(ctx)
  if (registered.kind === 'none') {
    return dataError(ctx, 'repo-not-registered: Atlas has not registered this checkout yet; use Claude Code in the checkout so the service registers it, wait for its first scan, then run this command again')
  }
  const repositoryId = registered.repositoryId

  const base = ctx.config.artifacts.durableOutputBase
  if (!isAbsolute(base)) return dataError(ctx, 'the durable output base (artifacts.durableOutputBase) must be an absolute path')
  let canonBase: string
  try {
    canonBase = canonicalWithTail(base)
  } catch {
    return dataError(ctx, 'the durable output base cannot be resolved (a dangling symbolic link or an unreadable parent); fix artifacts.durableOutputBase')
  }
  const repoDir = join(canonBase, repositoryId)
  const dir = join(repoDir, 'deliverables')
  // The text that is printed and registered is the resolved one: a link in the base can lead to a name with control characters.
  if (CONTROL_OR_SURROGATE.test(dir)) return dataError(ctx, 'the durable output directory, once symbolic links are resolved, has control characters in its path; use a base without them')

  // Outside the checkout it belongs to and every other registered checkout: a directory inside a worktree is lost with it.
  const checkoutRoots = [checkout.worktreePath, ...status.roots.filter(r => r.kind === 'checkout' && typeof r.path === 'string').map(r => r.path as string)]
  for (const root of checkoutRoots) {
    if (within(dir, root) || within(root, dir)) {
      return dataError(ctx, `the durable output directory would be inside ${root === checkout.worktreePath ? 'the checkout' : 'another registered checkout'} (a symbolic link in the base counts); set artifacts.durableOutputBase in config.json to a folder outside every checkout`)
    }
  }

  const uid = ctx.deps.uid ?? process.getuid?.()
  if (uid === undefined) return dataError(ctx, 'this platform does not report the user ID; the owner of the output directory cannot be verified')

  // Existing components first, before anything is created.
  const managed: Array<[string, 'private' | 'base']> = [[canonBase, 'base'], [repoDir, 'private'], [dir, 'private']]
  for (const [path, rule] of managed) {
    const stat = lstatOrNull(path)
    const issue = stat === null ? null : issueOf(stat, uid, rule)
    if (issue !== null) return dataError(ctx, issueMessage(path, issue))
  }
  // The service's own location policy, before anything is printed or created: a directory it would refuse to register is of no
  // use to a generator, and creating one outside the home or inside the Atlas data leaves debris behind a refusal. (After the
  // inspection above, so that an unsafe component that exists is named as such.)
  const home = ctx.config.homeDir
  if (!isAbsolute(home) || home === '/' || CONTROL_OR_SURROGATE.test(home)) {
    return dataError(ctx, 'HOME is not set to a usable home directory, so the durable output directory cannot be placed; run this command with your HOME set')
  }
  const policy = canonicalizeArtifactRoot(dir, home)
  const wontRegister = (why: string): number => dataError(ctx, `the durable output directory would not be registered by the service: ${why}; set artifacts.durableOutputBase in config.json to a folder it accepts`)
  if ('error' in policy) {
    // (The path is already resolved through every link, so a symlink-escape answer cannot arise here; it reads as outside the home.)
    if (policy.error === 'not-directory') return wontRegister('a part of its path is not a folder')
    return wontRegister('it must be inside your home directory and outside secret, Git and Atlas runtime folders')
  }
  if (policy.canonicalPath !== dir) return wontRegister('it resolves to a different path')
  if (isArtifactRootRefused(policy.canonicalPath, artifactRefusedDirectories(ctx.config))) return wontRegister('it overlaps the Atlas data, spool or cost-ledger folders')

  const existed = lstatOrNull(dir) !== null

  if (!create) {
    ctx.io.out(`${dir}\n`)
    ctx.io.err(`${existed ? 'the directory exists and is private' : 'the directory does not exist yet; run with --create to make it private and register it'}\n`)
    ctx.io.err(`${status.roots.some(r => r.kind === 'output' && r.path === dir) ? 'it is registered as an output root' : 'it is not registered as an output root'}\n`)
    return 0
  }

  const made: string[] = []
  let current = ''
  for (const part of dir.split('/').filter(Boolean)) {
    current += `/${part}`
    if (lstatOrNull(current) !== null) continue
    let raced = false
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') return dataError(ctx, `the durable output directory could not be created (${printable(errnoCode(error) ?? 'error')})`)
      raced = true
    }
    // A directory this run made must be exactly 0700 (a restrictive umask can only remove bits, so this also catches 0500); one a
    // concurrent creator made first is judged like any existing component.
    const after = lstatOrNull(current)
    let issue: DirIssue | null = after === null ? 'not-directory' : issueOf(after, uid, 'private')
    if (issue === null && after !== null && !raced && (after.mode & 0o777) !== 0o700) issue = 'not-private'
    if (issue !== null) return dataError(ctx, issueMessage(current, issue))
    if (!raced) made.push(current)
  }

  ctx.deps.hooks?.afterCreate?.(dir)

  // Verify what is there now, not what was planned: a component may have been swapped for a link meanwhile.
  for (const [path, rule] of managed) {
    const stat = lstatOrNull(path)
    const issue: DirIssue | null = stat === null ? 'not-directory' : issueOf(stat, uid, rule)
    if (issue !== null) return dataError(ctx, issueMessage(path, issue))
  }
  let real: string
  try {
    real = realpathSync.native(dir)
  } catch {
    return dataError(ctx, 'the durable output directory cannot be resolved after it was created')
  }
  if (real !== dir || !within(real, canonBase)) return dataError(ctx, 'the durable output directory resolves through a symbolic link; it was not registered')

  const registration = await request(ctx, 'POST', '/api/artifact-manager/roots', { path: dir, repositoryId })
  const notRegistered = (): number => {
    ctx.io.err('note: the directory was created (mode 0700) but not registered; fix the cause above and run this command again\n')
    return EXIT_SERVICE
  }
  if (!registration) return notRegistered()
  if (registration.status !== 200 && registration.status !== 201) {
    refusal(ctx, registration, ROOT_ERRORS)
    return notRegistered()
  }
  const root = readRegistration(registration)
  if (!root || root.kind !== 'output' || root.path !== dir || root.repositoryId?.toLowerCase() !== repositoryId) {
    unexpectedAnswer(ctx)
    return notRegistered()
  }
  ctx.io.out(`${dir}\n`)
  ctx.io.err(`${made.length > 0 ? `created ${made.length} director${made.length === 1 ? 'y' : 'ies'} (mode 0700)` : 'the directory already existed; nothing was changed'}\n`)
  ctx.io.err(`${root.created ? 'registered' : 'already registered'} as output root ${printable(root.rootId)}\n`)
  return 0
}

// ---------------------------------------------------------------------------------------------------------- session probe

/** `startCwd` is undefined when the service's list rows do not carry the key (an older service): then it is looked up per session. */
type LiveRow = {
  sessionId: string; resumeCwd: string | null; startCwd: string | null | undefined
  /** closed rows only: true when the service says a SessionEnd hook confirmed the end. Absent (an older service) or false: not confirmed. */
  endConfirmed: boolean
  /** closed rows only: why the service closed it, when it says. */
  endReason: 'hook' | 'idle' | null
}
/** 'none': no usable folder was given. 'uncertain': a folder was given but no spelling of it could be resolved. */
type FolderMatch = 'match' | 'no' | 'none' | 'uncertain'
/** The statuses the probe reads, in order. A closed session is read only while its end is not confirmed (see readLiveRow). */
type ProbeStatus = 'active' | 'unknown' | 'closed'

/**
 * Whether a session folder is the target or inside it, separator-aware (no prefix siblings): by its normalized spelling, and by
 * its real path as the kernel resolves the folder as given (".." after a link included) and as normalized. A folder that no
 * longer exists is resolved through its deepest existing ancestor, with the missing tail added back, so a deleted sub-folder
 * spelled through a link (or in another case or /tmp form) is still found inside the target. If no spelling can be resolved at
 * all and the normalized spelling does not match, the answer is 'uncertain', never 'no'.
 */
function folderMatch(folder: unknown, target: string): FolderMatch {
  if (typeof folder !== 'string' || folder === '' || folder.includes('\0') || !isAbsolute(folder)) return 'none'
  const lexical = resolvePath(folder)
  if (within(lexical, target)) return 'match'
  let resolved = false
  for (const spelling of new Set([folder, lexical])) {
    let real: string
    try {
      real = realpathSync.native(spelling)
    } catch {
      try {
        real = canonicalWithTail(spelling)
      } catch {
        continue
      }
    }
    resolved = true
    if (within(real, target)) return 'match'
  }
  return resolved ? 'no' : 'uncertain'
}

/**
 * One session's folders against the target: a match in any decides; otherwise a folder we could not judge is 'uncertain', and a
 * session with no usable folder at all is 'none' (ruling R90): a session that never reported where it runs could be anywhere, so
 * it is never 'no'. What 'none' means for the answer depends on the session's status (see createSessionProbe).
 */
function folderVerdict(folders: unknown[], target: string): 'match' | 'no' | 'uncertain' | 'none' {
  const found = folders.map(f => folderMatch(f, target))
  if (found.includes('match')) return 'match'
  if (found.includes('uncertain')) return 'uncertain'
  return found.every(f => f === 'none') ? 'none' : 'no'
}

function readLiveRow(value: unknown, status: string): LiveRow | null {
  if (!isObject(value) || typeof value.sessionId !== 'string' || !isValidSessionId(value.sessionId) || value.status !== status) return null
  if (value.resumeCwd !== null && typeof value.resumeCwd !== 'string') return null
  const hasStart = Object.hasOwn(value, 'startCwd')
  if (hasStart && value.startCwd !== null && typeof value.startCwd !== 'string') return null
  // Both keys are additive. A service that does not send them is older than the end reason: its closed rows are not confirmed ended.
  if (Object.hasOwn(value, 'endConfirmed') && typeof value.endConfirmed !== 'boolean') return null
  if (Object.hasOwn(value, 'endReason') && value.endReason !== null && value.endReason !== 'hook' && value.endReason !== 'idle') return null
  return {
    sessionId: value.sessionId, resumeCwd: value.resumeCwd, startCwd: hasStart ? (value.startCwd as string | null) : undefined,
    endConfirmed: value.endConfirmed === true, endReason: (value.endReason as 'hook' | 'idle' | null | undefined) ?? null,
  }
}

/**
 * Why a closed session without a confirmed end that reports no folder at all leaves the answer unknown (ruling R90): missing
 * location information cannot prove that a possibly live producer is outside the target.
 */
function noFolderReason(row: LiveRow): { activity: 'unknown'; reason: string } {
  return { activity: 'unknown', reason: `session ${row.sessionId} was closed without a confirmed end and its folder is not recorded, so Atlas cannot tell whether it uses this worktree; confirm its process has exited, then remove the worktree yourself, or retry after the session ends` }
}

/**
 * Why a matching closed session leaves the answer unknown, with the next step. A closed session proves its producer stopped only
 * when a SessionEnd hook confirmed it: the idle sweep closes a session that is merely quiet, so the process may still be using the folder.
 */
function unconfirmedEndReason(row: LiveRow): { activity: 'unknown'; reason: string } {
  const how = row.endReason === 'idle' ? 'was closed by idle cleanup' : 'was closed with no recorded end reason'
  return { activity: 'unknown', reason: `session ${row.sessionId} ${how}, not by a confirmed end; confirm its process has exited, then remove the worktree yourself, or retry after the session ends` }
}

/**
 * Every session of one live status, with subagents, read page by page until a short page. null (so: unknown) when any page
 * fails, is malformed, disagrees with the others on the total, repeats a session, or the pages do not add up to the total or
 * exceed the page bound.
 */
async function listLive(service: ServiceTarget, settings: SessionProbeSettings, status: ProbeStatus, signal: AbortSignal): Promise<LiveRow[] | null> {
  const rows: LiveRow[] = []
  const seen = new Set<string>()
  let total: unknown
  for (let page = 0; page < settings.maxPages; page++) {
    const offset = page * settings.pageSize
    // For closed sessions only those without a confirmed end are asked for: a confirmed one proves nothing live, and the history is long.
    const filter = status === 'closed' ? '&endConfirmed=false' : ''
    const reply = await callService(service, 'GET', `/api/sessions?status=${status}${filter}&includeSubagents=true&limit=${settings.pageSize}&offset=${offset}`, { timeoutMs: settings.requestTimeoutMs, signal })
    const body = reply.body
    if (reply.status !== 200 || !isObject(body) || !Array.isArray(body.rows)) return null
    if (body.limit !== settings.pageSize || body.offset !== offset) return null
    if (page > 0 && body.total !== total) return null
    total = body.total
    for (const raw of body.rows) {
      const row = readLiveRow(raw, status)
      if (row === null || seen.has(row.sessionId)) return null
      seen.add(row.sessionId)
      rows.push(row)
    }
    // The pages must add up to the reported total exactly: this also catches a total that is not a whole number, a page of the
    // wrong size and a session that closed or started while the pages were read.
    if (body.rows.length < settings.pageSize) return offset + body.rows.length === total ? rows : null
  }
  return null
}

/** The session detail's start and resume folders against the target. */
async function lookupFolders(service: ServiceTarget, settings: SessionProbeSettings, row: LiveRow, target: string, signal: AbortSignal): Promise<'match' | 'no' | 'uncertain' | 'none'> {
  try {
    const reply = await callService(service, 'GET', `/api/sessions/${row.sessionId}`, { timeoutMs: settings.requestTimeoutMs, signal })
    if (reply.status !== 200 || !isObject(reply.body) || !isObject(reply.body.session) || reply.body.session.sessionId !== row.sessionId) return 'uncertain'
    const { startCwd, resumeCwd } = reply.body.session
    if (!(startCwd === null || typeof startCwd === 'string') || !(resumeCwd === null || typeof resumeCwd === 'string')) return 'uncertain'
    return folderVerdict([startCwd, resumeCwd], target)
  } catch {
    return 'uncertain'
  }
}

/**
 * Builds the checker's session probe from the live service (ruling R52 and the Task 10 brief): `active` and `unknown` sessions
 * and `closed` ones whose end no SessionEnd hook confirmed, subagents included, are read completely; a session whose resume or
 * start folder is the canonical target or inside it makes the answer `active` (status active) or `unknown` (status unknown, or
 * closed without a confirmed end). A closed session proves the producer stopped only when a SessionEnd hook confirmed it: the idle
 * sweep (12 hours by default) and rows closed before Atlas recorded why say only that Atlas heard nothing, so such a match is
 * `unknown` with the session named and the next step. A closed session without a confirmed end that reports no folder at all is
 * `unknown` as well, named (ruling R90): where it ran is not known, so it cannot be ruled out. `inactive` only when every status was read in full, no session matched and
 * every non-matching session's start folder was looked up. Anything else (the service down, slow, refusing or malformed, paging
 * cut off or inconsistent, a bound reached, a live session with no usable folder) is `unknown`. No local process probe exists in
 * Atlas, so none is used: live-session evidence comes only from the service.
 */
export function createSessionProbe(service: ServiceTarget, settings: SessionProbeSettings): (canonicalTarget: string) => Promise<RemovalSessionProbeAnswer> {
  return async target => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), settings.totalMs)
    let lookupsLeft = settings.maxDetailLookups
    try {
      for (const status of ['active', 'unknown', 'closed'] as const) {
        const answerFor = (row: LiveRow): RemovalSessionProbeAnswer => (status === 'active' ? 'active' : status === 'unknown' ? 'unknown' : unconfirmedEndReason(row))
        const rows = await listLive(service, settings, status, abort.signal)
        if (rows === null) return 'unknown'
        const pending: LiveRow[] = []
        let uncertain = false
        // A closed session (no confirmed end) without any folder: the first one, to be named. A live one without a folder is plain uncertain.
        let folderless: LiveRow | null = null
        const noFolder = (row: LiveRow): void => { if (status === 'closed') folderless ??= row; else uncertain = true }
        for (const row of rows) {
          // The filter should not return these; one that does proves nothing about a live producer, so it cannot match.
          if (status === 'closed' && row.endConfirmed) continue
          if (row.startCwd === undefined) {
            // An older service whose rows lack the start folder: the resume folder here, the start folder by lookup below.
            if (folderMatch(row.resumeCwd, target) === 'match') return answerFor(row)
            pending.push(row)
            continue
          }
          const verdict = folderVerdict([row.resumeCwd, row.startCwd], target)
          if (verdict === 'match') return answerFor(row)
          if (verdict === 'uncertain') uncertain = true
          else if (verdict === 'none') noFolder(row)
        }
        if (pending.length > lookupsLeft) return 'unknown'
        lookupsLeft -= pending.length
        let next = 0
        let matched: LiveRow | null = null
        const worker = async (): Promise<void> => {
          while (matched === null && next < pending.length) {
            const row = pending[next++]!
            const found = await lookupFolders(service, settings, row, target, abort.signal)
            if (found === 'match') matched = row
            else if (found === 'uncertain') uncertain = true
            else if (found === 'none') noFolder(row)
          }
        }
        await Promise.all(Array.from({ length: Math.min(settings.detailConcurrency, pending.length) }, worker))
        if (matched !== null) return answerFor(matched)
        if (folderless !== null) return noFolderReason(folderless)
        if (uncertain) return 'unknown'
      }
      return 'inactive'
    } catch {
      return 'unknown'
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ check-removal

const COVERAGE_VALUES: Readonly<Record<keyof RemovalCheckResult['coverage'], readonly string[]>> = {
  filesystem: ['complete', 'incomplete'],
  git: ['complete', 'incomplete'],
  catalog: ['complete', 'missing', 'error'],
  sessions: ['active', 'inactive', 'unknown'],
}

function issueList(value: unknown): boolean {
  return Array.isArray(value) && value.every(i => isObject(i) && typeof i.code === 'string' && (i.path === null || typeof i.path === 'string') && typeof i.detail === 'string')
}

/**
 * The checker's answer, or null when it cannot be relied on. An exit code outside {0, 2, 3}, a malformed result, or a 0 that
 * contradicts the result's own contents (a risk, an unknown, incomplete or active coverage) is never passed on as a checker answer.
 */
function verifiedResult(value: unknown): RemovalCheckResult | null {
  if (!isObject(value) || (value.exitCode !== 0 && value.exitCode !== 2 && value.exitCode !== 3)) return null
  if (typeof value.target !== 'string' || typeof value.checkedAt !== 'string' || !issueList(value.risks) || !issueList(value.unknowns) || !isObject(value.coverage)) return null
  const coverage = value.coverage
  for (const [key, allowed] of Object.entries(COVERAGE_VALUES)) if (!allowed.includes(coverage[key] as string)) return null
  if (value.exitCode === 0) {
    const clean = (value.risks as unknown[]).length === 0 && (value.unknowns as unknown[]).length === 0
      && coverage.filesystem === 'complete' && coverage.git === 'complete' && coverage.catalog === 'complete' && coverage.sessions === 'inactive'
    if (!clean) return null
  }
  return value as RemovalCheckResult
}

const EXIT_MEANING: Readonly<Record<0 | 2 | 3, [string, string]>> = {
  0: ['NO RISK FOUND', 'Exit 0: a complete check found nothing at risk (every protected version is preserved outside the target, its commit is retained by a local branch or tag, and no session is live in it).'],
  2: ['INCOMPLETE', 'Exit 2: the check is incomplete: coverage or proof could not be established, so it cannot say the removal is safe. This blocks automated removal.'],
  3: ['RISKS FOUND', 'Exit 3: risks were found. This blocks automated removal; resolve them (preserve the files, commit, or stop the sessions) and check again.'],
}

function removalReport(result: RemovalCheckResult): string {
  const [headline, meaning] = EXIT_MEANING[result.exitCode]
  const entry = (i: { code: string; path: string | null; detail: string }): string => `  - [${i.code}] ${i.path === null ? '' : `${i.path}: `}${i.detail}`
  const lines = [
    'Worktree removal check',
    `Target: ${result.target}`,
    `Checked at: ${result.checkedAt}`,
    `Result: ${headline} (exit ${result.exitCode})`,
    meaning,
    `Coverage: filesystem=${result.coverage.filesystem} git=${result.coverage.git} catalog=${result.coverage.catalog} sessions=${result.coverage.sessions}`,
    '',
    `Risks (${result.risks.length})${result.risks.length === 0 ? ': none' : ':'}`,
    ...result.risks.map(entry),
    `Unknowns (${result.unknowns.length})${result.unknowns.length === 0 ? ': none' : ':'}`,
    ...result.unknowns.map(entry),
  ].map(printable)
  const next: string[] = []
  if (result.coverage.sessions === 'unknown') {
    next.push('Sessions unknown: live-session activity is read from the running Atlas service (npm start). Start it and check again; a very large number of sessions can also make the answer unknown. A session Atlas closed as idle (or before it recorded why), or one with no recorded folder, is not proof its process stopped: confirm the process has exited, then remove the worktree yourself, or check again after the session ends.')
  }
  if (result.coverage.catalog === 'missing') {
    next.push('Catalog missing: the Atlas catalog (atlas.db) does not exist yet, so registered protected locations are unknown. Run the Atlas service once so it creates the catalog, then check again.')
  }
  if (result.coverage.catalog === 'error') {
    next.push('Catalog unreadable: the Atlas catalog (atlas.db) could not be read (a damaged file, or a directory that does not allow a read-only open). Fix that, then check again.')
  }
  if (next.length > 0) lines.push('', 'To complete the check:', ...next.map(n => `  - ${n}`))
  lines.push(
    '',
    `Remote retention: ${REMOVAL_CHECK_REMOTE_RETENTION_NOTE}`,
    'Validity: this result is valid for the NEXT single removal only. Do not reuse it, cache it or apply it to several removals; run a fresh check immediately before each one. It never authorizes a forced removal (git worktree remove --force).',
    `What is not protected: only protected or secret-looking files, files Atlas knows as artifacts, and documents (by configured extension) are checked. Other files (images, code, archives, ignored data files) are not checked, and neither are documents under these cache folders unless they are inside a registered output folder: ${FIXED_DISCOVERY_SEGMENTS.join(', ')}.`,
    'Permanent exit 2: protected or secret-looking files (anything under a `phi` or `.phi` folder, any case; names like .npmrc, .env, *.key, credentials.json) are never read, so a worktree holding one always exits 2 until it is relocated.',
    `Large worktrees: if the check times out, raise the bound with --timeout-ms (${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}).`,
  )
  return `${lines.join('\n')}\n`
}

/** Whether `dir` is the target or inside it, by spelling and by real path (the same two views the checker takes of the caller). */
function insideTarget(dir: string, worktree: string): boolean {
  const targets = new Set([resolvePath(worktree)])
  const spellings = new Set([resolvePath(dir)])
  try { targets.add(realpathSync.native(worktree)) } catch { /* judged by spelling */ }
  try { spellings.add(realpathSync.native(dir)) } catch { /* judged by spelling */ }
  return [...spellings].some(d => [...targets].some(t => within(d, t)))
}

/**
 * Where the cleanup could be standing. The process's own directory is always a candidate. INIT_CWD (the directory npm was run
 * from) is a candidate only when npm itself ran this script: npm_lifecycle_event is "artifacts" under `npm run artifacts`. Any
 * npm command, `npx` included, puts INIT_CWD into the environment of every child it starts, so on its own it can be stale and
 * point away from where the caller really stands. The checker takes one directory: the first candidate inside the target, else
 * the process's directory, so a caller inside the target is never hidden by the other candidate.
 */
function callerDirectory(env: NodeJS.ProcessEnv, worktree: string): string {
  const here = process.cwd()
  const init = env.INIT_CWD
  const candidates = [here]
  if (env.npm_lifecycle_event === 'artifacts' && typeof init === 'string' && isAbsolute(init) && !CONTROL_OR_SURROGATE.test(init)) candidates.push(init)
  return candidates.find(c => insideTarget(c, worktree)) ?? here
}

async function runCheckRemoval(ctx: Ctx, worktree: string, json: boolean, timeoutMs: number | undefined): Promise<number> {
  const check = ctx.deps.checkWorktreeRemoval ?? checkWorktreeRemoval
  const settings: SessionProbeSettings = {
    pageSize: 500, maxPages: 50, maxDetailLookups: 1000, detailConcurrency: 8, requestTimeoutMs: ctx.requestTimeoutMs,
    totalMs: timeoutMs ?? DEFAULT_REMOVAL_CHECK_TIMEOUT_MS, ...ctx.deps.probe,
  }
  const options: RemovalCheckOptions = {
    catalogPath: ctx.config.dbPath,
    probeSessionActivity: createSessionProbe(ctx.service, settings),
    callerCwd: callerDirectory(ctx.env, worktree),
  }
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs
  const result = verifiedResult(await check(worktree, options))
  if (!result) {
    fail(ctx, 'internal error: the removal checker gave an unusable or inconsistent result; nothing can be concluded, so treat the worktree as NOT safe to remove')
    return EXIT_INTERNAL
  }
  if (json) ctx.io.out(`${JSON.stringify({ result, remoteRetentionNote: REMOVAL_CHECK_REMOTE_RETENTION_NOTE, validFor: 'next-removal-only' }, null, 2)}\n`)
  else ctx.io.out(removalReport(result))
  return result.exitCode
}

// ---------------------------------------------------------------------------------------------------------------- entry point

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io: Io = {
    out: deps.stdout ?? (text => { process.stdout.write(text) }),
    err: deps.stderr ?? (text => { process.stderr.write(text) }),
  }
  try {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
      io.out(USAGE)
      return 0
    }
    const { command, given } = parseCommand(argv)
    const path = (flag: string): string => absolutePath(`--${flag}`, given[flag] as string)
    // Everything that can be a usage error is decided before the configuration is read or a request is made.
    let run: (ctx: Ctx) => Promise<number>
    if (command === 'status') {
      run = ctx => runStatus(ctx, given.json === true)
    } else if (command === 'refresh') {
      const root = given.root as string
      if (!UUID_RE.test(root)) throw new UsageError('--root must be a root ID (a UUID, as listed by status)')
      run = ctx => runRefresh(ctx, root, given['include-older'] === true)
    } else if (command === 'register-output') {
      const registerPath = path('path')
      const repo = given.repo === undefined ? undefined : path('repo')
      run = ctx => runRegisterOutput(ctx, registerPath, repo)
    } else if (command === 'output-dir') {
      const repo = path('repo')
      run = ctx => runOutputDir(ctx, repo, given.create === true)
    } else {
      const worktree = path('worktree')
      const timeoutMs = timeoutOption(given['timeout-ms'])
      run = ctx => runCheckRemoval(ctx, worktree, given.json === true, timeoutMs)
    }
    const env = deps.env ?? process.env
    const config = loadConfig(env)
    return await run({
      io, config, env, deps, service: { host: config.host, port: config.port },
      requestTimeoutMs: deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, now: deps.now ?? Date.now,
    })
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${printable(error.message)}\n${USAGE}`)
      return EXIT_USAGE
    }
    io.err(`error: internal error (${printable(error instanceof Error ? error.name : 'error').slice(0, 40)}); no result was produced\n`)
    return EXIT_INTERNAL
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A stdout that closes before the answer is written (a pipe whose reader left) is an internal failure: Node's default is an
  // uncaught exception with exit code 1, and the answer was not delivered whatever the checker said. The write error is reported
  // after the answer has been returned, so this assignment, made when the error arrives, overrides the one below.
  process.stdout.on('error', () => { process.exitCode = EXIT_INTERNAL })
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, () => { process.exitCode = EXIT_INTERNAL })
}
