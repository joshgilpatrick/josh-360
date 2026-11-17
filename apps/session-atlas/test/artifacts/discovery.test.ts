import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import diagnosticsChannel from 'node:diagnostics_channel'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ArtifactWorkerFrame, ArtifactWorkerObservation, ArtifactWorkerRequest, ArtifactWorkerRoot } from '../../src/artifacts/contracts.ts'
import {
  ARTIFACT_IPC_LIMITS, artifactWorkerErrorKind, discoverArtifactSlice, nodeArtifactDiscoveryFs, validateArtifactWorkerFrame,
  type ArtifactDiscoveryFs, type ArtifactDiscoveryOptions,
} from '../../src/artifacts/discovery.ts'
import { artifactGitSpawnCount, PATHSPEC_ARGV_CHUNK_BYTES } from '../../src/artifacts/git.ts'
import { assertPortablePath, twoLaunchFixture } from '../helpers/portable-paths.ts'

// Cleanup is registered before the first temporary directory exists: on normal exit, on a failed assertion (the test process
// still exits through 'exit') and on SIGINT/SIGTERM/SIGHUP. Every child process this file causes (fixture Git and the adapter's
// detached Git) is seen through the documented `child_process` diagnostics channel and killed with its process group.
const TEMP_DIRS = new Set<string>()
const CHILDREN = new Set<ChildProcess>()
diagnosticsChannel.subscribe('child_process', message => {
  const child = (message as { process?: ChildProcess }).process
  if (!child) return
  CHILDREN.add(child)
  child.once('exit', () => CHILDREN.delete(child))
})
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* not a group leader */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}
function cleanup(): void {
  for (const child of CHILDREN) killChild(child)
  CHILDREN.clear()
  for (const dir of TEMP_DIRS) {
    try { execFileSync('chmod', ['-R', 'u+rwx', dir], { stdio: 'ignore' }) } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  TEMP_DIRS.clear()
}
process.on('exit', cleanup)
// Also once every test in this file has run (passed or failed): a still-running child would keep the file from exiting.
after(cleanup)
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.once(signal, () => { cleanup(); process.exit(code) })
}

function makeTemp(prefix: string, base: string = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(join(base, prefix)))
  if (base === tmpdir()) TEMP_DIRS.add(dir)
  return dir
}

// Fixture Git runs with no system/global config and no inherited GIT_* variables; the adapter builds its own environment.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const HOME = makeTemp('atlas-disc-home-')
process.env.HOME = HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
delete process.env.XDG_CONFIG_HOME

const DEFAULT_EXTS = ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'json', 'sql']
const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false']
const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const DAY_MS = 86_400_000

function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, ...opts.env }, input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8')
}
const gitLine = (cwd: string, args: string[]): string => git(cwd, args).replace(/\n$/, '')

function newDir(prefix = 'root-'): string {
  return makeTemp(prefix, HOME)
}
function newRepo(): string {
  const parent = newDir('repo-')
  const path = join(parent, 'repo')
  git(parent, ['init', '-q', path])
  return path
}
/**
 * Waits until every change made so far is older than anything the next Git snapshot can see (coarse file timestamps), and
 * older than the window before a pass start in which a directory change still counts as one during the pass (m5: ~20 ms).
 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40))

function put(root: string, rel: string, content: string | Buffer = 'x\n'): string {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}
function commitAll(repo: string, message: string, env: Record<string, string> = {}): string {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '--allow-empty', '-F', '-'], { input: message, env })
  return gitLine(repo, ['rev-parse', 'HEAD'])
}

let rootSeq = 0
function outputRoot(path: string, over: Partial<ArtifactWorkerRoot> = {}): ArtifactWorkerRoot {
  return { rootId: `root-${++rootSeq}`, kind: 'output', canonicalPath: path, repositoryId: null, checkoutIdentity: null, protected: false, scopeFlags: ['configured-output'], ...over }
}
function checkoutRoot(path: string, over: Partial<ArtifactWorkerRoot> = {}): ArtifactWorkerRoot {
  return outputRoot(path, { kind: 'checkout', repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1', scopeFlags: ['checkout'], ...over })
}
let jobSeq = 0
function request(root: ArtifactWorkerRoot, over: Partial<ArtifactWorkerRequest> = {}): ArtifactWorkerRequest {
  return {
    jobId: `job-${++jobSeq}`, root, generation: 1, task: 'output-walk', cursor: null, includeOlder: true, documentExtensions: [...DEFAULT_EXTS],
    ignoreSegments: ['.scratch'], limits: { maxEntries: 5000, maxMs: 60_000, gitTimeoutMs: 10_000, gitMaxOutputBytes: 8 * 1024 * 1024 }, ...over,
  }
}
function limits(over: Partial<ArtifactWorkerRequest['limits']>): ArtifactWorkerRequest['limits'] {
  return { maxEntries: 5000, maxMs: 60_000, gitTimeoutMs: 10_000, gitMaxOutputBytes: 8 * 1024 * 1024, ...over }
}

/** Runs one slice. Checks the slice protocol: data frames carry rows and complete:false, exactly one terminal frame has no rows. */
async function slice(req: ArtifactWorkerRequest, options?: ArtifactDiscoveryOptions): Promise<{ frames: ArtifactWorkerFrame[]; rows: ArtifactWorkerObservation[]; end: ArtifactWorkerFrame }> {
  const frames: ArtifactWorkerFrame[] = []
  for await (const frame of discoverArtifactSlice(req, options)) {
    assert.equal(validateArtifactWorkerFrame(frame), null, `frame ${frames.length} is valid`)
    assert.equal(frame.jobId, req.jobId)
    frames.push(frame)
  }
  assert.ok(frames.length >= 1, 'a slice always ends with a terminal frame')
  const end = frames[frames.length - 1]!
  assert.equal(end.rows.length, 0, 'the terminal frame carries no rows')
  for (const f of frames.slice(0, -1)) {
    assert.ok(f.rows.length > 0, 'a data frame carries rows')
    assert.equal(f.complete, false, 'a data frame never ends a pass')
  }
  return { frames, rows: frames.flatMap(f => f.rows), end }
}

/** Runs slices, feeding back each terminal cursor, until a pass completes or a slice fails (a gap is progress, not failure). */
async function drain(req: ArtifactWorkerRequest, options?: ArtifactDiscoveryOptions, maxSlices = 500) {
  const slices: Array<Awaited<ReturnType<typeof slice>>> = []
  const failed = (f: ArtifactWorkerFrame): boolean => f.error !== undefined && artifactWorkerErrorKind(f.error.code) !== 'gap'
  let cursor = req.cursor
  for (let i = 0; i < maxSlices; i++) {
    const s = await slice({ ...req, jobId: `${req.jobId}-s${i}`, cursor }, options)
    slices.push(s)
    if (s.end.complete || failed(s.end)) break
    assert.notEqual(s.end.cursor, null, 'an unfinished pass keeps a cursor')
    cursor = s.end.cursor
  }
  const last = slices[slices.length - 1]!
  assert.ok(last.end.complete || failed(last.end), 'the pass ends')
  const total = { visited: 0, eligible: 0, skipped: 0 }
  for (const s of slices) for (const f of s.frames) { total.visited += f.counts.visited; total.eligible += f.counts.eligible; total.skipped += f.counts.skipped }
  return { slices, rows: slices.flatMap(s => s.rows), end: last.end, total }
}

const rel = (root: string, rows: ArtifactWorkerObservation[]): string[] => rows.map(r => r.path!.slice(root.length + 1))

function spyFs(log: string[], base: ArtifactDiscoveryFs = nodeArtifactDiscoveryFs): ArtifactDiscoveryFs {
  return {
    readdir: async dir => { log.push(`readdir ${dir}`); return base.readdir(dir) },
    lstat: async path => { log.push(`lstat ${path}`); return base.lstat(path) },
    realpath: async path => base.realpath(path),
  }
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

// PR #19 review, P2-4: a working row says when its lstat began, because the row itself is built later (identity and Git lookups
// run in between) and its observedAt says nothing about when the file was read.
test('a working row carries the time its lstat began, which is not the time the row was built', async () => {
  const root = newDir()
  put(root, 'a.md', 'a\n')
  put(root, 'sub/b.md', 'b\n')
  const slow: ArtifactDiscoveryFs = { ...nodeArtifactDiscoveryFs, lstat: async path => { const st = await nodeArtifactDiscoveryFs.lstat(path); await new Promise(resolve => setTimeout(resolve, 60)); return st } }
  const beforeMs = Date.now()
  const walk = await slice(request(outputRoot(root)), { fs: slow })
  const afterMs = Date.now()
  assert.deepEqual(rel(root, walk.rows).sort(), ['a.md', 'sub/b.md'])
  for (const r of walk.rows) {
    assert.equal(typeof r.capturedAt, 'string', 'every working row has its capture time')
    const captured = Date.parse(r.capturedAt!), observed = Date.parse(r.observedAt)
    assert.ok(captured >= beforeMs && observed <= afterMs, 'both lie within the slice')
    assert.ok(observed - captured >= 50, `the row was built ${observed - captured} ms after its lstat began (the injected delay was 60 ms)`)
  }
  const direct = await slice(request(outputRoot(root), { task: 'direct-observation', path: join(root, 'a.md') }), { fs: slow })
  assert.equal(direct.rows.length, 1)
  assert.ok(Date.parse(direct.rows[0]!.observedAt) - Date.parse(direct.rows[0]!.capturedAt!) >= 50, 'a direct observation too')
  // A filesystem that cannot say (an injected stat without it) gives a row without the field, never a made-up time.
  const bare: ArtifactDiscoveryFs = { ...nodeArtifactDiscoveryFs, lstat: async path => { const { capturedAtMs: _drop, ...st } = await nodeArtifactDiscoveryFs.lstat(path); return st } }
  const plain = await slice(request(outputRoot(root)), { fs: bare })
  assert.equal(plain.rows.length, 2)
  assert.ok(plain.rows.every(r => !('capturedAt' in r)))
})

// --------------------------------------------------------------------------------------------------------------- output-walk

test('output-walk emits eligible document metadata only, in byte order, with a terminal frame', async () => {
  const root = newDir()
  put(root, 'a/x.md')
  put(root, 'a/y.ts')
  put(root, 'b/c/z.PDF', 'pdf bytes')
  put(root, 'notes.txt')
  put(root, 'top.json', '{}')
  put(root, 'node_modules/pkg/readme.md')
  put(root, '.scratch/s.md')
  put(root, 'draft.md.swp')
  put(root, 'Zeta.md')
  await settle() // a pass started just after its directories changed is partial (m5)
  const r = outputRoot(root)
  const { rows, end, frames } = await slice(request(r))
  assert.deepEqual(rel(root, rows), ['Zeta.md', 'a/x.md', 'b/c/z.PDF', 'notes.txt', 'top.json'])
  for (const row of rows) {
    assert.equal(row.kind, 'working')
    assert.equal(row.rootId, r.rootId)
    assert.deepEqual(row.identity, { identityKind: 'root', repositoryId: null, rootId: r.rootId, relativePath: row.path!.slice(root.length + 1) })
    const st = statSync(row.path!, { bigint: true })
    assert.equal(row.stat!.dev, String(st.dev))
    assert.equal(row.stat!.ino, String(st.ino))
    assert.equal(row.stat!.size, Number(st.size))
    assert.equal(row.stat!.mtimeMs, statSync(row.path!).mtimeMs)
    assert.equal(row.stat!.ctimeMs, statSync(row.path!).ctimeMs)
    assert.equal(row.git, undefined)
    assert.equal(row.evidence, undefined)
    assert.ok(!Number.isNaN(Date.parse(row.observedAt)))
  }
  assert.equal(end.complete, true)
  assert.equal(end.coverage, 'complete')
  assert.equal(end.cursor, null)
  assert.equal(end.error, undefined)
  const counts = frames.reduce((a, f) => ({ visited: a.visited + f.counts.visited, eligible: a.eligible + f.counts.eligible, skipped: a.skipped + f.counts.skipped }), { visited: 0, eligible: 0, skipped: 0 })
  assert.equal(counts.eligible, 5)
  assert.equal(counts.skipped, 3, 'node_modules, .scratch and the swap file are counted as skipped')
  // Zeta.md a b c z.PDF x.md y.ts .scratch draft.md.swp node_modules notes.txt top.json
  assert.equal(counts.visited, 12)
})

test('resumed slices continue after the cursor and never restart at the first directory', async () => {
  const root = newDir()
  for (let d = 0; d < 5; d++) for (let f = 0; f < 5; f++) put(root, `d${d}/f${f}.md`, `${d}${f}`)
  const r = outputRoot(root)
  const whole = await slice(request(r))
  assert.equal(whole.rows.length, 25)

  const logs: string[][] = []
  let current: string[] = []
  const fs: ArtifactDiscoveryFs = {
    readdir: async dir => { current.push(`readdir ${dir}`); return nodeArtifactDiscoveryFs.readdir(dir) },
    lstat: async path => { current.push(`lstat ${path}`); return nodeArtifactDiscoveryFs.lstat(path) },
    realpath: path => nodeArtifactDiscoveryFs.realpath(path),
  }
  const slices: Array<Awaited<ReturnType<typeof slice>>> = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    current = []
    const s = await slice(request(r, { cursor, limits: limits({ maxEntries: 4 }) }), { fs })
    logs.push(current)
    slices.push(s)
    if (s.end.complete) break
    cursor = s.end.cursor
  }
  const rows = slices.flatMap(s => s.rows)
  assert.deepEqual(rel(root, rows), rel(root, whole.rows), 'the resumed pass yields exactly the single-slice rows, in order, without duplicates')
  const visited = slices.flatMap(s => s.frames).reduce((n, f) => n + f.counts.visited, 0)
  assert.equal(visited, 30, 'every entry (5 directories + 25 files) is visited exactly once across slices')
  assert.equal(slices.length, Math.ceil(30 / 4) + (30 % 4 === 0 ? 1 : 0))
  // d0 is listed only while the cursor is inside it; later slices re-read only the root and the cursor's own directory.
  const d0Reads = logs.map(l => l.filter(x => x === `readdir ${join(root, 'd0')}`).length)
  assert.equal(d0Reads[0], 1)
  assert.ok(d0Reads.slice(2).every(n => n === 0), `d0 is not re-read after the cursor left it: ${d0Reads}`)
  for (const l of logs) assert.ok(l.filter(x => x.startsWith('readdir')).length <= 3, 'a resumed slice re-descends only along the cursor path')
  // Each file is inspected once in the whole pass. (Directories get one change check once their listing is walked: DEFECT-4.)
  const lstats = logs.flat().filter(x => x.startsWith('lstat') && x.endsWith('.md'))
  assert.equal(lstats.length, 25)
  assert.equal(new Set(lstats).size, lstats.length, 'no file is re-inspected by a later slice')
})

test('a slice boundary is not the end of a scan', async () => {
  const root = newDir()
  for (let i = 0; i < 10; i++) put(root, `f${i}.md`)
  const s = await slice(request(outputRoot(root), { limits: limits({ maxEntries: 3 }) }))
  assert.equal(s.end.complete, false)
  assert.equal(s.end.coverage, 'partial')
  assert.equal(typeof s.end.cursor, 'string')
  assert.equal(s.end.error, undefined)
  assert.equal(s.rows.length, 3)
})

test('the time budget ends a slice; time spent suspended at a yield is not counted', async () => {
  const root = newDir()
  for (let i = 0; i < 10; i++) put(root, `f${i}.md`)
  let now = 0
  const fs: ArtifactDiscoveryFs = { ...nodeArtifactDiscoveryFs, lstat: async p => { now += 1000; return nodeArtifactDiscoveryFs.lstat(p) } }
  const s = await slice(request(outputRoot(root), { limits: limits({ maxMs: 2500 }) }), { fs, clock: () => now })
  assert.equal(s.end.complete, false)
  assert.equal(s.rows.length, 3, 'three 1 s inspections exhaust a 2.5 s budget')

  // A consumer that is slow to pull the next frame does not shorten the slice.
  const many = newDir()
  for (let i = 0; i < 300; i++) put(many, `f${String(i).padStart(3, '0')}.md`)
  let t = 0
  const frames: ArtifactWorkerFrame[] = []
  for await (const f of discoverArtifactSlice(request(outputRoot(many), { limits: limits({ maxMs: 2500 }) }), { clock: () => t })) {
    frames.push(f)
    t += 10_000 // the service took 10 s to acknowledge
  }
  assert.equal(frames.at(-1)!.complete, true)
  assert.equal(frames.flatMap(f => f.rows).length, 300)
})

test('setup time before the first entry never shrinks a slice; the time budget bounds the per-entry work', async () => {
  const repo = newRepo()
  put(repo, 'seed.md')
  commitAll(repo, 'init')
  for (let i = 0; i < 20; i++) put(repo, `u${String(i).padStart(2, '0')}.md`)
  // The clock reads 0 when the slice starts and 2500 ever after: all elapsed time falls in the setup (checkout resolution,
  // git status, ls-files, cat-file), none in the per-entry work.
  const setupClock = (): (() => number) => {
    let first = true
    return () => { if (first) { first = false; return 0 } return 2500 }
  }
  const status = await slice(request(checkoutRoot(repo), { task: 'checkout-status', limits: limits({ maxMs: 2000 }) }), { clock: setupClock() })
  assert.equal(status.rows.length, 20, 'one slice processes every parsed status entry')
  assert.equal(status.end.complete, true)

  const walked = await slice(request(outputRoot(repo, { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' }), { limits: limits({ maxMs: 2000 }) }), { clock: setupClock() })
  assert.equal(walked.end.complete, true)
  assert.equal(walked.rows.length, 20, 'the 20 untracked files; seed.md is tracked and clean, not an output (R66)')

  // git-history: checkout resolution is setup; 150 commits take two adapter pages, both inside one slice.
  const hist = newRepo()
  const now = Math.floor(Date.now() / 1000)
  let stream = ''
  for (let i = 0; i < 150; i++) {
    stream += `commit refs/heads/main\ncommitter Atlas Test <atlas@example.invalid> ${now - 150 + i} +0000\ndata 2\nc\n`
    stream += `M 100644 inline h${String(i).padStart(3, '0')}.md\ndata 2\nx\n\n`
  }
  git(hist, ['fast-import', '--quiet'], { input: stream })
  git(hist, ['checkout', '-q', 'main'])
  const history = await slice(request(checkoutRoot(hist), { task: 'git-history', limits: limits({ maxMs: 2000 }) }), { clock: setupClock() })
  assert.equal(history.rows.length, 150)
  assert.equal(history.end.complete, true)

  // Per-entry time still ends the slice: three 1 s inspections exhaust 2.5 s.
  let t = 0
  const fs: ArtifactDiscoveryFs = { ...nodeArtifactDiscoveryFs, lstat: async p => { t += 1000; return nodeArtifactDiscoveryFs.lstat(p) } }
  const timed = await slice(request(checkoutRoot(repo), { task: 'checkout-status', limits: limits({ maxMs: 2500 }) }), { fs, clock: () => t })
  assert.equal(timed.end.complete, false)
  assert.equal(timed.rows.length, 3)
})

test('root mutations between slices are harmless and behind-cursor additions arrive in the next generation', async () => {
  const root = newDir()
  for (const p of ['a/a1.md', 'a/a2.md', 'b/b1.md', 'b/b2.md', 'b/b3.md', 'c/c1.md', 'c/c2.md']) put(root, p)
  const r = outputRoot(root)
  const first = await slice(request(r, { limits: limits({ maxEntries: 5 }) }))
  assert.deepEqual(rel(root, first.rows), ['a/a1.md', 'a/a2.md', 'b/b1.md'])
  const cursor = first.end.cursor!

  await clockPast(cursorHeader(cursor).s as number) // the mutations below happen during the pass
  put(root, 'a/a0-behind.md')
  put(root, 'b/b0-behind.md')
  unlinkSync(join(root, 'b/b2.md'))
  put(root, 'b/b9.md')
  unlinkSync(join(root, 'c/c1.md'))
  put(root, 'c/c0.md')
  put(root, 'd/d1.md')

  const rest = await drain(request(r, { cursor, limits: limits({ maxEntries: 3 }) }))
  assert.deepEqual(rel(root, rest.rows), ['b/b3.md', 'b/b9.md', 'c/c0.md', 'c/c2.md', 'd/d1.md'])
  // The walk itself is unharmed, but directories changed during the pass: something may have moved behind the cursor, so the
  // pass is not complete (DEFECT-4); the next generation re-walks them.
  assert.equal(rest.end.complete, true)
  assert.deepEqual([rest.end.coverage, rest.end.error?.code], ['partial', 'path-changed'])

  // Replaying a slice from a committed cursor gives the same rows (a crash after commit is idempotent).
  const again = await slice(request(r, { cursor, limits: limits({ maxEntries: 3 }) }))
  const replay = await slice(request(r, { cursor, limits: limits({ maxEntries: 3 }) }))
  assert.deepEqual(rel(root, again.rows), rel(root, replay.rows))
  assert.equal(again.end.cursor, replay.end.cursor)

  // The cursor's own directory disappearing does not break the pass either.
  rmSync(join(root, 'b'), { recursive: true })
  const gone = await drain(request(r, { cursor, limits: limits({ maxEntries: 3 }) }))
  assert.deepEqual(rel(root, gone.rows), ['c/c0.md', 'c/c2.md', 'd/d1.md'])

  const next = await drain(request(r))
  assert.ok(rel(root, next.rows).includes('a/a0-behind.md'), 'the next generation finds what was added behind the cursor')
})

/**
 * Waits until the wall clock is well past `ms`: file timestamps come from the kernel's coarse clock, which can lag the wall
 * clock by a scheduler tick (up to ~10 ms), so a later change then carries a strictly later timestamp.
 */
async function clockPast(ms: number): Promise<void> {
  while (Date.now() <= ms + 20) await new Promise(resolve => setTimeout(resolve, 5))
}

/** Decodes an output-walk cursor's header (adw1:<length>:<header JSON>), for tests that inspect or forge one. */
function cursorHeader(cursor: string): Record<string, unknown> {
  const m = /^adw1:(\d+):/.exec(cursor)!
  return JSON.parse(cursor.slice(m[0].length, m[0].length + Number(m[1]))) as Record<string, unknown>
}

test('DEFECT-4: a folder moved into the already-walked part of the root during a pass never leaves the pass "complete"', async () => {
  const root = newDir()
  put(root, 'a-visited/first.md')
  for (let d = 0; d < 3; d++) for (let i = 0; i < 3; i++) put(root, `b${d}/f${i}.md`)
  const r = outputRoot(root)
  const moved = [0, 1, 2].map(i => `a-visited/b2/f${i}.md`)

  // Between slices (the acceptance scenario): the cursor rests in b0 when b2 moves behind it.
  const first = await slice(request(r, { limits: limits({ maxEntries: 5 }) }))
  assert.deepEqual(rel(root, first.rows), ['a-visited/first.md', 'b0/f0.md', 'b0/f1.md'])
  const passStart = cursorHeader(first.end.cursor!).s
  await clockPast(typeof passStart === 'number' ? passStart : Date.now())
  renameSync(join(root, 'b2'), join(root, 'a-visited', 'b2'))
  const rest = await drain(request(r, { cursor: first.end.cursor, limits: limits({ maxEntries: 5 }) }))
  const seen = rel(root, [...first.rows, ...rest.rows])
  assert.deepEqual(moved.filter(p => seen.includes(p)), [], 'fixture: the moved files are behind the cursor, unseen by this pass')
  assert.equal(rest.end.complete, true, 'the walk still reaches the end of the root')
  assert.deepEqual([rest.end.coverage, rest.end.error?.code], ['partial', 'path-changed'], 'a pass that missed them is never complete')
  assert.equal(typeof passStart, 'number', 'the pass start travels in the cursor')
  // The next pass (a fresh generation) finds them and, with nothing changing during or just before it (m5), is complete.
  await settle()
  const next = await drain(request(r, { limits: limits({ maxEntries: 5 }) }))
  assert.deepEqual(moved.filter(p => !rel(root, next.rows).includes(p)), [])
  assert.deepEqual([next.end.coverage, next.end.error], ['complete', undefined])

  // Within one slice: the folder moves while the walk is between its listing of the root and reaching it.
  const root2 = newDir()
  put(root2, 'a-visited/first.md')
  for (let d = 0; d < 3; d++) put(root2, `b${d}/f.md`)
  const moving: ArtifactDiscoveryFs = {
    ...nodeArtifactDiscoveryFs,
    readdir: async dir => {
      if (dir === join(root2, 'b1')) { await clockPast(Date.now()); renameSync(join(root2, 'b2'), join(root2, 'a-visited', 'b2')) }
      return nodeArtifactDiscoveryFs.readdir(dir)
    },
  }
  const single = await slice(request(outputRoot(root2)), { fs: moving })
  assert.ok(!rel(root2, single.rows).includes('a-visited/b2/f.md'), 'fixture: the moved file was not walked')
  assert.deepEqual([single.end.complete, single.end.coverage, single.end.error?.code], [true, 'partial', 'path-changed'])
  // Even where directory timestamps do not show the change (coarse timestamp granularity), the listed-but-vanished folder
  // and a listed-but-vanished document do.
  renameSync(join(root2, 'a-visited', 'b2'), join(root2, 'b2'))
  const frozen = (fs: ArtifactDiscoveryFs): ArtifactDiscoveryFs => ({
    ...fs, lstat: async p => { const st = await fs.lstat(p); return st.type === 'directory' ? { ...st, mtimeMs: 0, ctimeMs: 0 } : st },
  })
  const coarse = await slice(request(outputRoot(root2)), { fs: frozen(moving) })
  assert.deepEqual([coarse.end.coverage, coarse.end.error?.code], ['partial', 'path-changed'], 'a listed folder that vanished')
  renameSync(join(root2, 'a-visited', 'b2'), join(root2, 'b2'))
  const fileGone: ArtifactDiscoveryFs = {
    ...frozen(nodeArtifactDiscoveryFs),
    lstat: async p => { if (p === join(root2, 'b1', 'f.md')) throw errno('ENOENT'); return frozen(nodeArtifactDiscoveryFs).lstat(p) },
  }
  const vanishedFile = await slice(request(outputRoot(root2)), { fs: fileGone })
  assert.deepEqual([vanishedFile.end.coverage, vanishedFile.end.error?.code], ['partial', 'path-changed'], 'a listed document that vanished')
  assert.equal((await slice(request(outputRoot(root2)), { fs: frozen(nodeArtifactDiscoveryFs) })).end.coverage, 'complete', 'control')

  // Bounded: one lstat per walked directory once its listing is done (again only for a directory the next slice re-enters
  // because the cursor rests on its last entry), nothing kept but the pass start (the cursor stays small).
  const log: string[] = []
  const quiet = await drain(request(r, { limits: limits({ maxEntries: 3 }) }), { fs: spyFs(log) })
  assert.equal(quiet.end.coverage, 'complete', 'an unchanged multi-slice pass stays complete')
  const dirStats = log.filter(x => x.startsWith('lstat ') && !x.endsWith('.md'))
  const dirs = [root, join(root, 'a-visited'), join(root, 'a-visited', 'b2'), join(root, 'b0'), join(root, 'b1')].map(d => `lstat ${d}`)
  assert.deepEqual([...new Set(dirStats)].sort(), dirs.sort())
  assert.ok(dirStats.length <= dirs.length + quiet.slices.length, `directory checks do not grow with files (${dirStats.length})`)
  for (const s of quiet.slices.slice(0, -1)) assert.ok(Buffer.byteLength(s.end.cursor!) < 512, 'the cursor holds a position and a time, no directory list')

  // A cursor from before the pass start was recorded cannot prove anything: that pass is partial, the next one complete.
  const legacyStart = await slice(request(r, { limits: limits({ maxEntries: 3 }) }))
  const header = cursorHeader(legacyStart.end.cursor!)
  delete header.s
  const json = JSON.stringify(header)
  const legacy = await drain(request(r, { cursor: `adw1:${json.length}:${json}`, limits: limits({ maxEntries: 3 }) }))
  assert.deepEqual([legacy.end.complete, legacy.end.coverage, legacy.end.error?.code], [true, 'partial', 'path-changed'])
})

test('DEFECT-2 (R67): a walk or status pass that skips an eligible file older than the lookback says so (lookback-limited)', async () => {
  const root = newDir()
  put(root, 'a/new.md', 'new\n')
  put(root, 'b/old.md', 'old\n')
  put(root, 'b/old.bin', 'not a document\n')
  await settle() // m5
  const oldPath = join(root, 'b', 'old.md')
  const aged = (paths: string[]): ArtifactDiscoveryFs => ({
    ...nodeArtifactDiscoveryFs,
    lstat: async p => { const st = await nodeArtifactDiscoveryFs.lstat(p); return paths.includes(p) ? { ...st, mtimeMs: Date.now() - 30 * DAY_MS, ctimeMs: Date.now() - 30 * DAY_MS } : st },
  })
  const r = outputRoot(root)
  const s = await slice(request(r, { includeOlder: false }), { fs: aged([oldPath, join(root, 'b', 'old.bin')]) })
  assert.deepEqual(rel(root, s.rows), ['a/new.md'])
  assert.deepEqual([s.end.complete, s.end.coverage, s.end.error?.code], [true, 'partial', 'lookback-limited'])
  // Sticky across the slices of a pass (the skip happens in a later slice than the end).
  const sliced = await drain(request(r, { includeOlder: false, limits: limits({ maxEntries: 2 }) }), { fs: aged([oldPath]) })
  assert.ok(sliced.slices.length > 1)
  assert.deepEqual([sliced.end.coverage, sliced.end.error?.code], ['partial', 'lookback-limited'])
  // Nothing skipped by age: no gap; an old file that is not a document is no gap either.
  assert.deepEqual([(await slice(request(r, { includeOlder: false }))).end.coverage], ['complete'])
  assert.equal((await slice(request(r, { includeOlder: false }), { fs: aged([join(root, 'b', 'old.bin')]) })).end.coverage, 'complete')
  // "Import older files" removes the cutoff: the old file is emitted and the pass is complete.
  const older = await slice(request(r, { includeOlder: true }), { fs: aged([oldPath]) })
  assert.deepEqual([rel(root, older.rows), older.end.coverage], [['a/new.md', 'b/old.md'], 'complete'])

  // Checkout status: an old untracked document is skipped by age and reported; a tracked file Git finds clean is not a
  // candidate at all, so its age is no gap (R66).
  const repo = newRepo()
  put(repo, 'tracked.md', 'tracked\n')
  commitAll(repo, 'init')
  put(repo, 'draft-old.md', 'an old untracked draft\n')
  const status = await slice(request(checkoutRoot(repo), { task: 'checkout-status', includeOlder: false }), { fs: aged([join(repo, 'draft-old.md')]) })
  assert.deepEqual([status.rows.length, status.end.coverage, status.end.error?.code], [0, 'partial', 'lookback-limited'])
  await settle()
  const walkRepo = await slice(request(outputRoot(repo, { kind: 'session-directory', scopeFlags: ['session-cwd'], repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' }), { includeOlder: false }),
    { fs: aged([join(repo, 'tracked.md')]) })
  assert.deepEqual([rel(repo, walkRepo.rows), walkRepo.end.coverage], [['draft-old.md'], 'complete'], 'an old clean tracked file is Git\'s, not a lookback gap')
})

test('m5: on a filesystem with whole-second timestamps a move just after the pass start still leaves the pass partial; a quiet root completes', async () => {
  const root = newDir()
  put(root, 'a/first.md'); put(root, 'm/mid.md'); put(root, 'z/sub/moved.md')
  await settle()
  const changed = new Set<string>()
  const OLD = 1_000_000_000_000 // an old, whole-second time
  // Directory times as a 1-2 s granularity filesystem (HFS+, FAT) records them: a directory changed just now carries the start
  // of its (or the previous) second; an untouched one keeps its old whole-second time.
  const coarse: ArtifactDiscoveryFs = {
    ...nodeArtifactDiscoveryFs,
    readdir: async dir => {
      if (dir === join(root, 'm') && !changed.has(join(root, 'z'))) {
        renameSync(join(root, 'z', 'sub'), join(root, 'a', 'sub')) // after a/ was walked, before z/ is listed
        changed.add(join(root, 'z')).add(join(root, 'a'))
      }
      return nodeArtifactDiscoveryFs.readdir(dir)
    },
    lstat: async p => {
      const st = await nodeArtifactDiscoveryFs.lstat(p)
      if (st.type !== 'directory') return st
      const t = changed.has(p) ? Math.floor(Date.now() / 1000) * 1000 - 1000 : OLD
      return { ...st, mtimeMs: t, ctimeMs: t }
    },
  }
  const moved = await slice(request(outputRoot(root)), { fs: coarse })
  assert.ok(!rel(root, moved.rows).includes('a/sub/moved.md'), 'fixture: the moved file was not walked')
  assert.deepEqual([moved.end.complete, moved.end.coverage, moved.end.error?.code], [true, 'partial', 'path-changed'])
  // Control: the same coarse filesystem with nothing changing during the pass completes.
  changed.clear()
  renameSync(join(root, 'a', 'sub'), join(root, 'z', 'sub'))
  const quietFs: ArtifactDiscoveryFs = { ...coarse, readdir: nodeArtifactDiscoveryFs.readdir }
  const quiet = await slice(request(outputRoot(root)), { fs: quietFs })
  assert.deepEqual([quiet.end.coverage, quiet.end.error], ['complete', undefined])
  // On a fine-grained filesystem a root last changed before the margin also completes.
  await settle()
  assert.equal((await slice(request(outputRoot(root)))).end.coverage, 'complete')
})

test('a write that keeps an old mtime is discovered through ctime, and directory mtimes never prune descendants', async () => {
  const root = newDir()
  const file = put(root, 'deep/dir/copied.md', 'restored with cp -p\n')
  const old = new Date(Date.now() - 30 * DAY_MS)
  utimesSync(file, old, old)
  utimesSync(join(root, 'deep/dir'), old, old)
  utimesSync(join(root, 'deep'), old, old)
  const r = outputRoot(root)

  const recent = await slice(request(r, { includeOlder: false, sinceMs: Date.now() - 7 * DAY_MS }))
  assert.deepEqual(rel(root, recent.rows), ['deep/dir/copied.md'])
  assert.ok(recent.rows[0]!.stat!.mtimeMs < Date.now() - 20 * DAY_MS, 'the emitted stat keeps the old mtime')

  const defaulted = await slice(request(r, { includeOlder: false }))
  assert.deepEqual(rel(root, defaulted.rows), ['deep/dir/copied.md'], 'absent sinceMs means the last seven days')

  const future = Date.now() + 3_600_000
  assert.deepEqual((await slice(request(r, { includeOlder: false, sinceMs: future }))).rows, [], 'a file older than the cutoff by both times is not emitted')
  assert.equal((await slice(request(r, { includeOlder: true, sinceMs: future }))).rows.length, 1, 'includeOlder removes the cutoff')

  // A file whose mtime AND ctime are both old is filtered (simulated: ctime cannot be set backwards).
  const fakeOld: ArtifactDiscoveryFs = {
    ...nodeArtifactDiscoveryFs,
    lstat: async p => ({ ...(await nodeArtifactDiscoveryFs.lstat(p)), mtimeMs: old.getTime(), ctimeMs: old.getTime() }),
  }
  assert.deepEqual((await slice(request(r, { includeOlder: false }), { fs: fakeOld })).rows, [])
  assert.equal((await slice(request(r, { includeOlder: true }), { fs: fakeOld })).rows.length, 1)
})

test('a gitignored output file inside an output root is found, with repository identity only for a service-named checkout', async () => {
  const repo = newRepo()
  put(repo, '.gitignore', 'out/\n')
  put(repo, 'README.md')
  commitAll(repo, 'init')
  put(repo, 'out/report.md', 'generated\n')
  put(repo, 'out/data.csv', 'a,b\n')
  const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])
  assert.ok(!status.includes('report.md'), 'Git status itself omits the ignored output')

  const outDir = join(repo, 'out')
  const withRepo = outputRoot(outDir, { repositoryId: 'repo-uuid-9', checkoutIdentity: 'checkout-9' })
  await settle() // a pass started just after its directories changed is partial (m5)
  const a = await slice(request(withRepo))
  assert.deepEqual(a.rows.map(x => x.identity), [
    { identityKind: 'repository', repositoryId: 'repo-uuid-9', rootId: null, relativePath: 'out/data.csv' },
    { identityKind: 'repository', repositoryId: 'repo-uuid-9', rootId: null, relativePath: 'out/report.md' },
  ])
  assert.equal(a.end.coverage, 'complete')

  const noRepo = outputRoot(outDir)
  const b = await slice(request(noRepo))
  assert.deepEqual(b.rows.map(x => x.identity.relativePath), ['data.csv', 'report.md'])
  assert.ok(b.rows.every(x => x.identity.identityKind === 'root' && x.identity.rootId === noRepo.rootId))

  // A repository ID without the checkout identity is a project association, not a Git location (R27).
  const associated = outputRoot(outDir, { repositoryId: 'repo-uuid-9', checkoutIdentity: null })
  const c = await slice(request(associated))
  assert.deepEqual(c.rows.map(x => x.identity.relativePath), ['data.csv', 'report.md'])
  assert.ok(c.rows.every(x => x.identity.identityKind === 'root' && x.identity.rootId === associated.rootId))

  // An output root outside any checkout keeps root identity even when it names a repository and checkout.
  const external = newDir('external-')
  put(external, 'export.md')
  const ext = await slice(request(outputRoot(external, { repositoryId: 'repo-uuid-9', checkoutIdentity: 'checkout-9' })))
  assert.equal(ext.rows[0]!.identity.identityKind, 'root')
})

test('DEFECT-1 (R66): under repository identity, tracked files Git finds clean are not outputs; new, ignored, edited and flagged ones still are', async () => {
  const repo = newRepo()
  const tracked = ['clean.md', 'deep/old.md', 'edited.md', 'hidden.md', 'skip.md', 'sizes.md', 'Case.md', 'unindexed.md', 'recreated.md', 'moved-src.md', 'gitmv-src.md']
  for (const p of tracked) put(repo, `docs/${p}`, p === 'sizes.md' ? 'abcd\n' : `${p}\n`)
  put(repo, '.gitignore', 'docs/ignored-*.md\n')
  put(repo, 'README.md')
  symlinkSync('clean.md', join(repo, 'docs', 'link.md'))
  commitAll(repo, 'baseline')
  // Checkout noise: Git rewrote these (fresh mtime and ctime, same bytes).
  const now = new Date()
  for (const p of ['docs/clean.md', 'docs/deep/old.md']) { put(repo, p, `${p.slice(5)}\n`); utimesSync(join(repo, p), now, now) }
  put(repo, 'docs/edited.md', 'edited, never committed\n')
  git(repo, ['update-index', '--assume-unchanged', 'docs/hidden.md']); put(repo, 'docs/hidden.md', 'an edit status does not show\n')
  git(repo, ['update-index', '--skip-worktree', 'docs/skip.md'])
  // Same size, mtime restored: only the inode change time (and then the content) tells Git it changed.
  const sizesStat = statSync(join(repo, 'docs/sizes.md'))
  put(repo, 'docs/sizes.md', 'wxyz\n'); utimesSync(join(repo, 'docs/sizes.md'), sizesStat.atime, sizesStat.mtime)
  put(repo, 'docs/ita.md', 'intent to add\n'); git(repo, ['add', '-N', 'docs/ita.md'])
  put(repo, 'docs/new.md', 'brand new\n')
  put(repo, 'docs/ignored-out.md', 'generated, gitignored\n')
  renameSync(join(repo, 'docs/Case.md'), join(repo, 'docs/case.md')) // a case-only rename on disk: Git still indexes Case.md
  git(repo, ['rm', '-q', '--cached', 'docs/unindexed.md']) // deleted from the index, still on disk: untracked
  unlinkSync(join(repo, 'docs/recreated.md')); put(repo, 'docs/recreated.md', 'recreated.md\n') // deleted and recreated, same bytes
  renameSync(join(repo, 'docs/moved-src.md'), join(repo, 'docs/moved-dst.md')) // a plain move: the new name is untracked
  git(repo, ['mv', 'docs/gitmv-src.md', 'docs/gitmv-dst.md']) // a staged rename: clean against the index
  await settle()

  const docs = outputRoot(join(repo, 'docs'), { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })
  const before = artifactGitSpawnCount()
  const s = await slice(request(docs))
  const spawned = artifactGitSpawnCount() - before
  assert.deepEqual(rel(repo, s.rows), [
    'docs/case.md', 'docs/edited.md', 'docs/hidden.md', 'docs/ignored-out.md', 'docs/ita.md', 'docs/moved-dst.md', 'docs/new.md', 'docs/sizes.md', 'docs/skip.md',
    'docs/unindexed.md',
  ], 'clean tracked files (clean, deep/old, recreated, gitmv-dst) and the symlink are not emitted')
  assert.ok(s.rows.every(r => r.git === undefined && r.identity.identityKind === 'repository'), 'emitted rows are unchanged: no Git identity')
  assert.deepEqual([s.end.complete, s.end.coverage, s.end.error], [true, 'complete', undefined], 'a clean tracked file is no gap')
  assert.ok(spawned <= 12, `checkout resolution plus one ls-files per slice, never per file (${spawned})`)

  // Resumed slices take their own snapshot (nothing in the cursor) and reach the same rows.
  const sliced = await drain(request(docs, { limits: limits({ maxEntries: 3 }) }))
  assert.deepEqual(rel(repo, sliced.rows), rel(repo, s.rows))
  for (const sl of sliced.slices.slice(0, -1)) assert.ok(Buffer.byteLength(sl.end.cursor!) < 512, 'the cursor holds a position, not an index')
  // The same folder without repository identity (an external output root) never asks Git and emits every file.
  const plain = await slice(request(outputRoot(join(repo, 'docs'))))
  assert.ok(rel(repo, plain.rows).includes('docs/clean.md'))
  // A root at the work tree's top level: the snapshot covers the whole index.
  const top = await slice(request(outputRoot(repo, { kind: 'session-directory', scopeFlags: ['session-cwd'], repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })))
  assert.ok(!rel(repo, top.rows).includes('README.md') && !rel(repo, top.rows).includes('docs/clean.md'))
  assert.ok(rel(repo, top.rows).includes('docs/new.md'))
})

test('DEFECT-1 (R66): racily clean entries are content-checked, and a file changed after Git looked is never treated as clean', async () => {
  const repo = newRepo()
  put(repo, 'docs/racy.md', '1111\n')
  put(repo, 'docs/clean.md', 'clean\n')
  commitAll(repo, 'baseline')
  // Only size and whole-second mtime are compared (the weakest stat check a user may configure).
  git(repo, ['config', 'core.trustctime', 'false'])
  git(repo, ['config', 'core.checkStat', 'minimal'])
  const st = statSync(join(repo, 'docs/racy.md'))
  put(repo, 'docs/racy.md', '2222\n') // same size
  utimesSync(join(repo, 'docs/racy.md'), st.atime, st.mtime) // same mtime
  // The index is no newer than the file: the entry is racily clean, so Git compares contents and finds the change.
  const gitDir = gitLine(repo, ['rev-parse', '--absolute-git-dir'])
  const older = new Date(st.mtime.getTime() - 5000)
  utimesSync(join(gitDir, 'index'), older, older)
  await settle()
  const docs = outputRoot(join(repo, 'docs'), { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })
  assert.deepEqual(rel(repo, (await slice(request(docs))).rows), ['docs/racy.md'], 'a racily clean entry with other bytes is emitted')

  // A file that changes after Git took its snapshot cannot be proven clean by it: emitted, never silently dropped.
  let touched = false
  const racing: ArtifactDiscoveryFs = {
    ...nodeArtifactDiscoveryFs,
    lstat: async p => {
      if (!touched && p === join(repo, 'docs/clean.md')) { touched = true; await settle(); put(repo, 'docs/clean.md', 'clean\n') }
      return nodeArtifactDiscoveryFs.lstat(p)
    },
  }
  assert.ok(rel(repo, (await slice(request(docs), { fs: racing })).rows).includes('docs/clean.md'))
})

test('DEFECT-1 (R66): when Git cannot classify the tracked files, no row is emitted for them and the pass is never complete', async () => {
  const repo = newRepo()
  for (let i = 0; i < 300; i++) put(repo, `docs/t${String(i).padStart(3, '0')}.md`, `${i}\n`)
  commitAll(repo, 'baseline')
  put(repo, 'docs/zz-new.md', 'new\n')
  await settle()
  const docs = outputRoot(join(repo, 'docs'), { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })
  // A large index under a small output cap: Git's answer is cut, so neither the clean files nor the new one can be told apart.
  const capped = await slice(request(docs, { limits: limits({ gitMaxOutputBytes: 2048 }) }))
  assert.deepEqual(capped.rows, [], 'nothing is claimed as new')
  assert.deepEqual([capped.end.complete, capped.end.coverage, capped.end.error?.code], [true, 'partial', 'git-status-truncated'])
  const resumed = await drain(request(docs, { limits: limits({ gitMaxOutputBytes: 2048, maxEntries: 50 }) }))
  assert.ok(resumed.slices.length > 3)
  assert.deepEqual([resumed.rows.length, resumed.end.coverage, resumed.end.error?.code], [0, 'partial', 'git-status-truncated'], 'sticky across slices')
  // With room for the answer: only the new file.
  assert.deepEqual(rel(repo, (await slice(request(docs))).rows), ['docs/zz-new.md'])
  // Any other Git failure: the slice is retried later, nothing consumed, nothing emitted.
  const gitDir = gitLine(repo, ['rev-parse', '--absolute-git-dir'])
  writeFileSync(join(gitDir, 'index'), 'corrupt index')
  const broken = await slice(request(docs))
  assert.deepEqual(broken.rows, [])
  assert.equal(artifactWorkerErrorKind(broken.end.error!.code), 'retry')
  assert.equal(broken.end.complete, false)
})

test('I4: under a user config that compares only size and mtime, a same-size edit with its mtime restored is still emitted', async () => {
  const repo = newRepo()
  put(repo, 'docs/a.md', 'abcd\n')
  put(repo, 'docs/clean.md', 'clean\n')
  const old = new Date(Date.now() - 60_000)
  for (const p of ['docs/a.md', 'docs/clean.md']) utimesSync(join(repo, p), old, old)
  commitAll(repo, 'baseline')
  // Repository config is the user config scope the adapter's commands read (they never load global or system config).
  git(repo, ['config', 'core.checkStat', 'minimal'])
  git(repo, ['config', 'core.trustctime', 'false'])
  const second = Math.floor(Date.now() / 1000)
  // Well into a later second: just after the boundary the kernel's coarse clock can still read the previous one.
  while (Math.floor(Date.now() / 1000) === second || Date.now() % 1000 < 50) await new Promise(resolve => setTimeout(resolve, 10))
  put(repo, 'docs/a.md', 'wxyz\n') // same size, later second
  utimesSync(join(repo, 'docs/a.md'), old, old) // mtime restored (touch -r, cp -p, rsync -t)
  await settle()
  const s = await slice(request(outputRoot(join(repo, 'docs'), { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })))
  assert.deepEqual(rel(repo, s.rows), ['docs/a.md'], 'the edit is emitted; the untouched clean file is not')
})

test('m1: the R66 snapshot lists only documents, so a folder with many tracked non-document files stays classifiable under the output cap', async () => {
  const repo = newRepo()
  for (let i = 0; i < 1500; i++) put(repo, `docs/assets/f${String(i).padStart(4, '0')}.bin`, `${i}\n`)
  put(repo, 'docs/guide.md', 'guide\n')
  commitAll(repo, 'baseline')
  put(repo, 'docs/new.md', 'new\n')
  await settle()
  const docs = outputRoot(join(repo, 'docs'), { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })
  // 1,500 tracked binaries list as ~40 KB; the documents below the root as a few bytes.
  const s = await slice(request(docs, { limits: limits({ gitMaxOutputBytes: 4096 }) }))
  assert.deepEqual(rel(repo, s.rows), ['docs/new.md'])
  assert.deepEqual([s.end.complete, s.end.coverage, s.end.error], [true, 'complete', undefined])
  // A root whose path needs glob escaping is matched literally.
  const odd = newRepo()
  put(odd, 'do[c]s*/tracked.md', 'tracked\n')
  put(odd, 'docs/other.md', 'a sibling the escaped prefix must not match\n')
  commitAll(odd, 'baseline')
  put(odd, 'do[c]s*/new.md', 'new\n')
  await settle()
  const oddRoot = await slice(request(outputRoot(join(odd, 'do[c]s*'), { repositoryId: 'repo-uuid-2', checkoutIdentity: 'checkout-2' })))
  assert.deepEqual(rel(odd, oddRoot.rows), ['do[c]s*/new.md'])
  // `$` sequences in a root's name are literal too: its clean tracked files stay Git's, never new outputs.
  const dollars = newRepo()
  const names = ['out$$', 'a$&b', 'a$`b', "a$'b"]
  for (const name of names) put(dollars, `${name}/clean.md`, 'clean\n')
  put(dollars, 'out$/sibling.md', 'what `out$$` would match as a replacement string\n')
  commitAll(dollars, 'baseline')
  for (const name of names) put(dollars, `${name}/new.md`, 'new\n')
  await settle()
  for (const name of names) {
    const s = await slice(request(outputRoot(join(dollars, name), { repositoryId: 'repo-uuid-3', checkoutIdentity: 'checkout-3' })))
    assert.deepEqual([rel(dollars, s.rows), s.end.coverage], [[`${name}/new.md`], 'complete'], name)
  }
  // Two launches (64 extensions, a root whose escaped pathspec is ~1 KB): each gets only the output budget the ones before it left,
  // and past the cap the snapshot fails closed: no row for any file it could not classify.
  const long = newRepo()
  const { root: deep, exts, first, last } = twoLaunchFixture(PATHSPEC_ARGV_CHUNK_BYTES) // `first` is in the first launch, `last` in the second
  put(long, `${deep}/a.${first}`, 'a\n')
  put(long, `${deep}/b.${last}`, 'b\n')
  commitAll(long, 'baseline')
  const newest = put(long, `${deep}/new.${first}`, 'new\n')
  assertPortablePath(newest, 'the longest path this fixture creates')
  await settle()
  const deepRoot = (): ArtifactWorkerRoot => outputRoot(join(long, deep), { repositoryId: 'repo-uuid-4', checkoutIdentity: 'checkout-4' })
  const full = await slice(request(deepRoot(), { documentExtensions: exts }))
  assert.deepEqual([rel(long, full.rows), full.end.coverage], [[`${deep}/new.${first}`], 'complete'])
  const record = Buffer.byteLength(`H ${deep}/a.${first}\0`) // the first launch's whole output
  const capped = await slice(request(deepRoot(), { documentExtensions: exts, limits: limits({ gitMaxOutputBytes: record + 10 }) }))
  assert.deepEqual([capped.rows.length, capped.end.complete, capped.end.coverage, capped.end.error?.code], [0, true, 'partial', 'git-status-truncated'])
})

test('DEFECT-1 (R66): a submodule below the root stays a skipped nested checkout; its files are never classified by the parent index', async () => {
  const sub = newRepo()
  put(sub, 'inner.md', 'inner\n')
  commitAll(sub, 'inner')
  const repo = newRepo()
  put(repo, 'docs/top.md', 'top\n')
  commitAll(repo, 'top')
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'docs/sub'])
  commitAll(repo, 'add submodule')
  put(repo, 'docs/sub/new-in-sub.md', 'untracked inside the submodule\n')
  put(repo, 'docs/fresh.md', 'fresh\n')
  await settle()
  const s = await slice(request(outputRoot(join(repo, 'docs'), { repositoryId: 'repo-uuid-1', checkoutIdentity: 'checkout-1' })))
  assert.deepEqual(rel(repo, s.rows), ['docs/fresh.md'])
  assert.deepEqual([s.end.coverage, s.end.error?.code], ['partial', 'nested-checkout'])
})

test('a repository association alone never yields repository identity, inside any work tree (R27)', async () => {
  const rootIdentity = (r: ArtifactWorkerRoot, relativePath: string) => ({ identityKind: 'root', repositoryId: null, rootId: r.rootId, relativePath })
  const check = async (r: ArtifactWorkerRoot, file: string, relativePath: string): Promise<void> => {
    const walk = await slice(request(r))
    assert.deepEqual(walk.rows.map(x => x.identity), [rootIdentity(r, relativePath)], `walk under ${r.rootId}`)
    const direct = await slice(request(r, { task: 'direct-observation', path: file }))
    assert.deepEqual(direct.rows.map(x => x.identity), [rootIdentity(r, relativePath)], `direct observation under ${r.rootId}`)
  }

  // An unrelated work tree around the output directory (a dotfiles repository at home).
  const dot = newDir('dothome-')
  git(dot, ['init', '-q', '.'])
  const exportsDir = join(dot, 'Documents', 'exports')
  const report = put(exportsDir, 'report.md')
  await check(outputRoot(exportsDir, { repositoryId: 'project-x-repo', checkoutIdentity: null }), report, 'report.md')

  // A nested repository and a submodule inside the project's own checkout.
  const outer = newRepo()
  put(outer, 'README.md')
  commitAll(outer, 'init')
  const nested = join(outer, 'vendor', 'nested')
  git(outer, ['init', '-q', nested])
  const nestedFile = put(nested, 'out/n.md')
  await check(outputRoot(join(nested, 'out'), { repositoryId: 'outer-repo', checkoutIdentity: null }), nestedFile, 'n.md')
  const subSource = newRepo()
  put(subSource, 's.md')
  commitAll(subSource, 'sub')
  git(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'modules/sub'])
  const subFile = put(join(outer, 'modules', 'sub'), 'exports/s-out.md')
  await check(outputRoot(join(outer, 'modules', 'sub', 'exports'), { repositoryId: 'outer-repo', checkoutIdentity: null }), subFile, 's-out.md')

  // With both fields the service asserts the checkout: identity is the path relative to the work tree Git resolves.
  const named = outputRoot(join(nested, 'out'), { repositoryId: 'nested-repo', checkoutIdentity: 'nested-checkout-1' })
  const walk = await slice(request(named))
  assert.deepEqual(walk.rows.map(x => x.identity), [{ identityKind: 'repository', repositoryId: 'nested-repo', rootId: null, relativePath: 'out/n.md' }])
})

test('a nested checkout below a repository-identity output root is skipped and reported', async () => {
  const repo = newRepo()
  put(repo, 'README.md')
  commitAll(repo, 'init')
  put(repo, 'exports/top.md')
  const nested = join(repo, 'exports', 'clone')
  git(repo, ['init', '-q', nested])
  put(nested, 'inner.md')
  await settle() // a pass started just after its directories changed is partial, and path-changed outranks nested-checkout (m5)
  const s = await slice(request(outputRoot(join(repo, 'exports'), { repositoryId: 'repo-uuid-2', checkoutIdentity: 'checkout-2' })))
  assert.deepEqual(s.rows.map(x => x.identity.relativePath), ['exports/top.md'])
  assert.equal(s.end.complete, true)
  assert.equal(s.end.coverage, 'partial')
  assert.equal(s.end.error?.code, 'nested-checkout')
})

test('symlinks are never followed and are counted as skipped', async () => {
  const root = newDir()
  const outside = newDir('outside-')
  put(outside, 'secret-plan.md')
  put(root, 'real/doc.md')
  put(root, 'kept.md')
  symlinkSync(outside, join(root, 'link-out'))
  symlinkSync(join(root, 'real'), join(root, 'link-in'))
  symlinkSync(join(root, 'kept.md'), join(root, 'link-file.md'))
  symlinkSync(join(root, 'missing.md'), join(root, 'dangling.md'))
  await settle() // m5
  const { rows, end, frames } = await slice(request(outputRoot(root)))
  assert.deepEqual(rel(root, rows), ['kept.md', 'real/doc.md'])
  assert.equal(frames.reduce((n, f) => n + f.counts.skipped, 0), 4)
  assert.equal(end.coverage, 'complete', 'skipping symlinks is policy, not a coverage gap')
})

test('a permission failure leaves the pass partial and still emits everything readable', async () => {
  const root = newDir()
  put(root, 'a/one.md')
  put(root, 'locked/two.md')
  put(root, 'z/three.md')
  const lockedDir = join(root, 'locked')
  const fs: ArtifactDiscoveryFs = {
    ...nodeArtifactDiscoveryFs,
    readdir: async dir => { if (dir === lockedDir) throw errno('EACCES'); return nodeArtifactDiscoveryFs.readdir(dir) },
  }
  const s = await slice(request(outputRoot(root)), { fs })
  assert.deepEqual(rel(root, s.rows), ['a/one.md', 'z/three.md'])
  assert.equal(s.end.complete, true, 'the walk reached the end of the root')
  assert.equal(s.end.coverage, 'partial', 'but a permission failure cannot count as a completed scan')
  assert.equal(s.end.error?.code, 'permission-denied')
  assert.ok(!s.end.error!.message.includes(root), 'the message names no path')
  assert.ok(s.frames.reduce((n, f) => n + f.counts.skipped, 0) >= 1)

  // The same failure in an earlier slice stays recorded in the cursor until the pass ends.
  const resumed = await drain(request(outputRoot(root), { limits: limits({ maxEntries: 2 }) }), { fs })
  assert.equal(resumed.end.complete, true)
  assert.equal(resumed.end.coverage, 'partial')
  assert.equal(resumed.end.error?.code, 'permission-denied')

  // An unreadable root is inaccessible, not empty.
  const rootLocked: ArtifactDiscoveryFs = { ...nodeArtifactDiscoveryFs, readdir: async () => { throw errno('EACCES') } }
  const inaccessible = await slice(request(outputRoot(root)), { fs: rootLocked })
  assert.equal(inaccessible.end.coverage, 'inaccessible')
  assert.equal(inaccessible.end.complete, false)
  assert.equal(inaccessible.rows.length, 0)
})

test('a cursor entry that can no longer be inspected is a counted gap, never a silent skip', async () => {
  const root = newDir()
  for (const p of ['a/a1.md', 'b/b1.md', 'b/b2.md', 'c/c1.md']) put(root, p)
  const r = outputRoot(root)
  const first = await slice(request(r, { limits: limits({ maxEntries: 4 }) }))
  assert.deepEqual(rel(root, first.rows), ['a/a1.md', 'b/b1.md'], 'the cursor rests inside b')
  const bDir = join(root, 'b')
  // The listing cannot tell b's type, and inspecting b fails: the rest of b (b2.md) cannot be reached.
  const failing = (code: string): ArtifactDiscoveryFs => ({
    ...nodeArtifactDiscoveryFs,
    readdir: async dir => (await nodeArtifactDiscoveryFs.readdir(dir)).map(e => (dir === root && e.name.toString() === 'b' ? { ...e, type: 'unknown' as const } : e)),
    lstat: async p => { if (p === bDir) throw errno(code); return nodeArtifactDiscoveryFs.lstat(p) },
  })
  const denied = await drain(request(r, { cursor: first.end.cursor }), { fs: failing('EACCES') })
  assert.deepEqual(rel(root, denied.rows), ['c/c1.md'])
  assert.equal(denied.end.complete, true)
  assert.notEqual(denied.end.coverage, 'complete', 'an unreachable remainder cannot count as a completed scan')
  assert.equal(denied.end.error?.code, 'permission-denied')
  assert.ok(denied.total.skipped >= 1, 'the unreachable entry is counted')

  const unreadable = await drain(request(r, { cursor: first.end.cursor }), { fs: failing('ELOOP') })
  assert.equal(unreadable.end.coverage, 'partial')
  assert.equal(unreadable.end.error?.code, 'unreadable-entry')

  // A cursor entry that is simply gone is no gap of its own (nothing unreadable is skipped), but it may have moved behind the
  // cursor, so the pass is not complete either (DEFECT-4).
  const vanished = await drain(request(r, { cursor: first.end.cursor }), { fs: failing('ENOENT') })
  assert.deepEqual(rel(root, vanished.rows), ['c/c1.md'])
  assert.equal(vanished.end.complete, true)
  assert.deepEqual([vanished.end.coverage, vanished.end.error?.code], ['partial', 'path-changed'])
})

test('a real unreadable directory leaves the pass partial (non-root only)', { skip: process.getuid?.() === 0 ? 'running as root: permission bits are not enforced' : false }, async () => {
  const root = newDir()
  put(root, 'a/one.md')
  put(root, 'locked/two.md')
  chmodSync(join(root, 'locked'), 0o000)
  try {
    const s = await slice(request(outputRoot(root)))
    assert.deepEqual(rel(root, s.rows), ['a/one.md'])
    assert.equal(s.end.coverage, 'partial')
    assert.equal(s.end.error?.code, 'permission-denied')
  } finally {
    chmodSync(join(root, 'locked'), 0o755)
  }
})

test('a missing root is inaccessible, never an empty complete scan', async () => {
  const parent = newDir()
  const s = await slice(request(outputRoot(join(parent, 'not-yet'))))
  assert.equal(s.end.coverage, 'inaccessible')
  assert.equal(s.end.complete, false)
  assert.equal(s.end.error?.code, 'root-missing')
})

test('nested .claude/worktrees subtrees are skipped, counted and leave coverage partial', async () => {
  const root = newDir()
  put(root, 'doc.md')
  put(root, '.claude/worktrees/feature-x/plan.md')
  put(root, '.claude/notes.md')
  await settle() // m5
  const s = await slice(request(outputRoot(root, { kind: 'session-directory', scopeFlags: ['session-cwd'] })))
  assert.deepEqual(rel(root, s.rows), ['.claude/notes.md', 'doc.md'])
  assert.equal(s.end.coverage, 'partial')
  assert.equal(s.end.error?.code, 'nested-worktree')
  assert.ok(s.frames.reduce((n, f) => n + f.counts.skipped, 0) >= 1)

  const empty = newDir()
  put(empty, 'doc.md')
  mkdirSync(join(empty, '.claude/worktrees'), { recursive: true })
  await settle()
  assert.equal((await slice(request(outputRoot(empty)))).end.coverage, 'complete', 'an empty worktrees directory hides nothing')
})

test('names that cannot be represented losslessly are counted as unsupported, never dropped silently', async () => {
  const root = newDir()
  put(root, 'ok.md')
  const lossy = Buffer.concat([Buffer.from(`${root}/bad`), Buffer.from([0xff]), Buffer.from('.md')])
  try {
    writeFileSync(lossy, 'x')
  } catch {
    return // the filesystem refuses non-UTF-8 names (macOS APFS); nothing to prove here
  }
  await settle() // m5
  const s = await slice(request(outputRoot(root)))
  assert.deepEqual(rel(root, s.rows), ['ok.md'])
  assert.equal(s.end.coverage, 'partial')
  assert.equal(s.end.error?.code, 'unsupported-path')
  assert.equal(s.frames.reduce((n, f) => n + f.counts.skipped, 0), 1)
})

test('frames never exceed 250 rows or 1 MiB, splitting on whichever bound comes first', async () => {
  const many = newDir()
  for (let i = 0; i < 600; i++) put(many, `f${String(i).padStart(4, '0')}.md`)
  const a = await slice(request(outputRoot(many)))
  assert.deepEqual(a.frames.map(f => f.rows.length), [250, 250, 100, 0])

  // Long names full of control characters: each row is several KiB once JSON-escaped (U+0001 is 6 bytes), over the 1 MiB / 250
  // rows = 4,194 bytes it takes for the byte bound to come first, so frames split by bytes. The deepest path stays within the
  // portable limit, so the volume comes from the number of files, not the length of one path.
  const wide = newDir()
  const segment = (c: number): string => '\u0001'.repeat(200) + `-${c}`
  let dir = wide
  for (let d = 0; d < 3; d++) dir = join(dir, segment(d))
  mkdirSync(dir, { recursive: true })
  const FILES = 400
  for (let i = 0; i < FILES; i++) writeFileSync(join(dir, `${'\u0001'.repeat(100)}${i}.md`), 'x')
  assertPortablePath(join(dir, `${'\u0001'.repeat(100)}${FILES - 1}.md`), 'the longest path this fixture creates')
  const b = await slice(request(outputRoot(wide)))
  assert.equal(b.rows.length, FILES)
  assert.ok(Buffer.byteLength(JSON.stringify(b.rows[0])) > ARTIFACT_IPC_LIMITS.maxFrameBytes / ARTIFACT_IPC_LIMITS.maxRows, 'each row alone exceeds an even share of a frame')
  for (const f of b.frames) {
    assert.ok(f.rows.length <= ARTIFACT_IPC_LIMITS.maxRows)
    assert.ok(Buffer.byteLength(JSON.stringify(f)) + 1 <= ARTIFACT_IPC_LIMITS.maxFrameBytes, 'every frame fits in 1 MiB')
  }
  assert.ok(b.frames.length >= 3, 'the byte bound split the batch before 250 rows')
  assert.ok(b.frames.slice(0, -2).every(f => f.rows.length < 250))
})

test('a request may ask for smaller frames (limits.maxFrameRows, Wave 2b): rows are split at that count, the pass is unchanged', async () => {
  const many = newDir()
  for (let i = 0; i < 120; i++) put(many, `f${String(i).padStart(4, '0')}.md`)
  await settle() // a pass started just after its directories changed is partial (m5)
  const root = outputRoot(many)
  const small = await slice(request(root, { limits: limits({ maxFrameRows: 50 }) }))
  assert.deepEqual(small.frames.map(f => f.rows.length), [50, 50, 20, 0])
  const one = await slice(request(root, { limits: limits({ maxFrameRows: 1 }) }))
  assert.equal(one.frames.length, 121)
  assert.ok(one.frames.slice(0, -1).every(f => f.rows.length === 1))
  const full = await slice(request(root, { limits: limits({ maxFrameRows: ARTIFACT_IPC_LIMITS.maxRows }) }))
  assert.deepEqual(full.frames.map(f => f.rows.length), [120, 0])
  // The same rows in the same order, the same pass outcome and the same slice totals, whatever the frame size.
  const outcome = (x: typeof small) => ({ cursor: x.end.cursor, complete: x.end.complete, coverage: x.end.coverage, error: x.end.error,
    visited: x.frames.reduce((n, f) => n + f.counts.visited, 0), eligible: x.frames.reduce((n, f) => n + f.counts.eligible, 0) })
  for (const s of [one, full]) {
    assert.deepEqual(s.rows.map(r => r.path), small.rows.map(r => r.path))
    assert.deepEqual(outcome(s), outcome(small))
  }
  // Each data frame's cursor is a checkpoint covering its rows: resuming from frame 1 of the small run re-emits nothing before it.
  const resumed = await slice(request(root, { cursor: small.frames[0]!.cursor, limits: limits({ maxFrameRows: 50 }) }))
  assert.deepEqual(resumed.rows.map(r => r.path), small.rows.slice(50).map(r => r.path))
})

test('a cursor that would exceed its bound fails closed with an explicit error', async () => {
  const root = newDir()
  let dir = root
  for (let d = 0; d < 6; d++) dir = join(dir, `level-${d}-${'n'.repeat(40)}`)
  mkdirSync(dir, { recursive: true })
  put(dir, 'deep.md')
  put(root, 'a.md')
  const s = await slice(request(outputRoot(root)), { maxCursorBytes: 160 })
  for (const f of s.frames) assert.ok(f.cursor === null || Buffer.byteLength(f.cursor) <= 160, 'no cursor exceeds the bound')
  assert.equal(s.end.complete, false)
  assert.equal(s.end.coverage, 'partial')
  assert.equal(s.end.error?.code, 'cursor-limit')
})

// ---------------------------------------------------------------------------------------------------------- direct and refusals

test('direct-only roots are refused for every bulk task, without touching the filesystem', async () => {
  const root = newDir()
  put(root, 'a.md')
  const r = outputRoot(root, { kind: 'session-directory', scopeFlags: ['direct-only'] })
  for (const task of ['output-walk', 'checkout-status', 'git-history', 'verify', 'legacy-backfill'] as const) {
    const log: string[] = []
    const s = await slice(request(r, { task }), { fs: spyFs(log) })
    assert.equal(s.frames.length, 1, task)
    assert.equal(s.end.error?.code, 'direct-only-root', task)
    assert.equal(s.end.complete, false, task)
    assert.deepEqual(log, [], `${task} never reads the root`)
  }
})

test('a direct observation emits exactly the named file and never traverses', async () => {
  const root = newDir()
  for (let i = 0; i < 20; i++) put(root, `sub/f${i}.md`)
  const target = put(root, 'sub/run.log', 'not a document extension\n')
  const old = new Date(Date.now() - 400 * DAY_MS)
  utimesSync(target, old, old)
  const r = outputRoot(root)
  const log: string[] = []
  const s = await slice(request(r, { task: 'direct-observation', path: target, includeOlder: false }), { fs: spyFs(log) })
  assert.deepEqual(s.rows.map(x => x.path), [target], 'direct observations ignore age and extension')
  assert.deepEqual(s.rows[0]!.identity, { identityKind: 'root', repositoryId: null, rootId: r.rootId, relativePath: 'sub/run.log' })
  assert.equal(s.end.complete, true)
  assert.equal(s.end.coverage, 'complete')
  assert.ok(!log.some(x => x.startsWith('readdir')), 'no directory is listed')

  const link = join(root, 'sub/link.md')
  symlinkSync(join(root, 'sub/f1.md'), link)
  const sym = await slice(request(r, { task: 'direct-observation', path: link }))
  assert.equal(sym.rows.length, 0)
  assert.equal(sym.end.error?.code, 'not-regular-file')
  assert.equal(sym.frames.reduce((n, f) => n + f.counts.skipped, 0), 1)

  const missing = await slice(request(r, { task: 'direct-observation', path: join(root, 'sub/gone.md') }))
  assert.equal(missing.rows.length, 0)
  assert.equal(missing.end.error?.code, 'path-missing')
  assert.equal(missing.end.complete, true)

  const elsewhere = put(newDir('elsewhere-'), 'x.md')
  const denied = await slice(request(r, { task: 'direct-observation', path: elsewhere }))
  assert.equal(denied.rows.length, 0)
  assert.equal(denied.end.error?.code, 'path-denied')
  assert.ok(!denied.end.error!.message.includes(elsewhere))

  const noPath = await slice(request(r, { task: 'direct-observation' }))
  assert.equal(noPath.end.error?.code, 'invalid-request')

  // A direct-only root observes its direct children only.
  const direct = outputRoot(root, { kind: 'session-directory', scopeFlags: ['direct-only'] })
  const top = put(root, 'top.md')
  assert.equal((await slice(request(direct, { task: 'direct-observation', path: top }))).rows.length, 1)
  assert.equal((await slice(request(direct, { task: 'direct-observation', path: join(root, 'sub/f2.md') }))).end.error?.code, 'path-denied')
})

test('requests that break the contract are refused with one error frame', async () => {
  const root = newDir()
  put(root, 'a.md')
  const r = outputRoot(root)
  const bad: Array<[string, unknown]> = [
    ['no job id', { ...request(r), jobId: undefined }],
    ['unknown task', { ...request(r), task: 'scan-everything' }],
    ['zero entries', request(r, { limits: limits({ maxEntries: 0 }) })],
    ['negative time', request(r, { limits: limits({ maxMs: -1 }) })],
    ['bad extension', request(r, { documentExtensions: ['.md'] })],
    ['no extensions', request(r, { documentExtensions: [] })],
    ['ignore with slash', request(r, { ignoreSegments: ['a/b'] })],
    ['relative root', request(outputRoot('relative/root'))],
    ['oversized cursor', request(r, { cursor: 'x'.repeat(ARTIFACT_IPC_LIMITS.maxCursorBytes + 1) })],
    ['non-finite since', request(r, { sinceMs: Number.NaN })],
    ['root flags', request(outputRoot(root, { scopeFlags: ['everything' as 'checkout'] }))],
    // Wave 2b: the requested frame size is 1..250 whole rows (the frozen maximum stays the bound).
    ['zero frame rows', request(r, { limits: limits({ maxFrameRows: 0 }) })],
    ['frame rows above the frozen maximum', request(r, { limits: limits({ maxFrameRows: ARTIFACT_IPC_LIMITS.maxRows + 1 }) })],
    ['fractional frame rows', request(r, { limits: limits({ maxFrameRows: 12.5 }) })],
    ['frame rows as text', request(r, { limits: limits({ maxFrameRows: '50' as unknown as number }) })],
  ]
  for (const [label, req] of bad) {
    const frames: ArtifactWorkerFrame[] = []
    for await (const f of discoverArtifactSlice(req as ArtifactWorkerRequest)) frames.push(f)
    assert.equal(frames.length, 1, label)
    assert.equal(frames[0]!.error?.code, 'invalid-request', label)
    assert.equal(frames[0]!.rows.length, 0, label)
    assert.equal(validateArtifactWorkerFrame(frames[0]), null, label)
  }

  // A cursor from another root or task is discarded explicitly: the next slice restarts the pass.
  const other = newDir()
  for (let i = 0; i < 5; i++) put(other, `f${i}.md`)
  const foreign = (await slice(request(outputRoot(other), { limits: limits({ maxEntries: 2 }) }))).end.cursor
  const s = await slice(request(r, { cursor: foreign }))
  assert.equal(s.end.error?.code, 'invalid-cursor')
  assert.equal(s.end.cursor, null)
  const garbage = await slice(request(r, { cursor: 'not-a-cursor' }))
  assert.equal(garbage.end.error?.code, 'invalid-cursor')

  for (const task of ['legacy-backfill', 'verify'] as const) {
    assert.equal((await slice(request(r, { task }))).end.error?.code, 'unsupported-task', task)
  }
})

// --------------------------------------------------------------------------------------------------------------- checkout-status

test('checkout-status emits working and staged index observations with Git metadata and never invents a stat', async () => {
  const repo = newRepo()
  for (const f of ['a.md', 'b.md', 'c.md', 'f.md', 'r.md']) put(repo, f, `${f} v1\n`)
  put(repo, 'code.ts', 'export {}\n')
  commitAll(repo, 'init')
  put(repo, 'a.md', 'a.md unstaged edit\n')
  put(repo, 'b.md', 'b.md staged edit, longer\n')
  git(repo, ['add', 'b.md'])
  put(repo, 'd.md', 'new staged file\n')
  git(repo, ['add', 'd.md'])
  put(repo, 'e.md', 'untracked\n')
  put(repo, 'script.ts', 'untracked code\n')
  unlinkSync(join(repo, 'c.md'))
  git(repo, ['mv', 'r.md', 'r2.md'])
  const r = checkoutRoot(repo)
  const s = await slice(request(r, { task: 'checkout-status' }))

  const working = s.rows.filter(x => x.kind === 'working')
  const index = s.rows.filter(x => x.kind === 'index')
  assert.deepEqual(working.map(x => x.path!.slice(repo.length + 1)), ['a.md', 'b.md', 'd.md', 'e.md', 'r2.md'])
  for (const w of working) {
    assert.ok(w.stat && typeof w.stat.ino === 'string')
    assert.deepEqual(w.identity, { identityKind: 'repository', repositoryId: 'repo-uuid-1', rootId: null, relativePath: w.path!.slice(repo.length + 1) })
    assert.equal(w.evidence, undefined, 'status observations carry no evidence')
  }
  assert.deepEqual(index.map(x => x.git!.gitPath), ['b.md', 'd.md', 'r2.md'])
  for (const ix of index) {
    const gitPath = ix.git!.gitPath!
    assert.equal(ix.path, undefined, 'an index observation has no filesystem path')
    assert.equal(ix.stat, undefined, 'an index observation has no invented stat')
    assert.equal(ix.evidence, undefined)
    assert.deepEqual(ix.identity, { identityKind: 'repository', repositoryId: 'repo-uuid-1', rootId: null, relativePath: gitPath })
    assert.equal(ix.git!.blobOid, gitLine(repo, ['rev-parse', `:${gitPath}`]))
    assert.equal(ix.git!.repositoryId, 'repo-uuid-1')
    assert.equal(ix.git!.checkoutIdentity, 'checkout-1')
    assert.equal(ix.git!.objectFormat, 'sha1')
    assert.equal(ix.git!.mode, 0o100644)
    assert.equal(ix.git!.stage, 0)
    assert.equal(ix.git!.size, Buffer.byteLength(git(repo, ['cat-file', 'blob', ix.git!.blobOid!])))
  }
  assert.ok(!s.rows.some(x => x.identity.relativePath === 'c.md'), 'a deleted tracked file is not an observation')
  assert.ok(!s.rows.some(x => x.identity.relativePath === 'f.md'), 'a clean tracked file is checkout noise')
  assert.equal(s.end.complete, true)
  assert.equal(s.end.coverage, 'complete')
})

test('checkout-status reports every stage of a conflict and batches Git work per slice', async () => {
  const repo = newRepo()
  put(repo, 'm.md', 'base\n')
  commitAll(repo, 'base')
  git(repo, ['checkout', '-q', '-b', 'side'])
  put(repo, 'm.md', 'side\n')
  commitAll(repo, 'side')
  git(repo, ['checkout', '-q', 'main'])
  put(repo, 'm.md', 'main\n')
  commitAll(repo, 'main')
  assert.throws(() => git(repo, ['merge', '-q', 'side']))
  for (let i = 0; i < 40; i++) put(repo, `staged/s${String(i).padStart(2, '0')}.md`, `staged ${i}\n`)
  git(repo, ['add', 'staged'])

  const before = artifactGitSpawnCount()
  const s = await slice(request(checkoutRoot(repo), { task: 'checkout-status' }))
  const spawned = artifactGitSpawnCount() - before
  const conflict = s.rows.filter(x => x.kind === 'index' && x.git!.gitPath === 'm.md')
  assert.deepEqual(conflict.map(x => x.git!.stage), [1, 2, 3])
  for (const c of conflict) assert.equal(c.git!.blobOid, gitLine(repo, ['rev-parse', `:${c.git!.stage}:m.md`]))
  assert.ok(s.rows.some(x => x.kind === 'working' && x.path === join(repo, 'm.md')), 'the conflicted working file is observed too')
  assert.equal(s.rows.filter(x => x.kind === 'index' && x.git!.gitPath!.startsWith('staged/')).length, 40)
  assert.ok(spawned <= 20, `Git work is batched, not one process per file (spawned ${spawned})`)
})

test('checkout-status resumes by Git path across slices', async () => {
  const repo = newRepo()
  put(repo, 'seed.md')
  commitAll(repo, 'init')
  for (let i = 0; i < 9; i++) put(repo, `u${i}.md`, `${i}\n`)
  const r = checkoutRoot(repo)
  const whole = await slice(request(r, { task: 'checkout-status' }))
  const sliced = await drain(request(r, { task: 'checkout-status', limits: limits({ maxEntries: 2 }) }))
  assert.ok(sliced.slices.length >= 5)
  assert.deepEqual(sliced.rows.map(x => x.path), whole.rows.map(x => x.path))
  assert.equal(sliced.end.coverage, 'complete')
})

test('checkout-status with filters configured reports unresolved filter state as partial coverage', async () => {
  const repo = newRepo()
  put(repo, '.gitattributes', '*.md filter=lfsish\n')
  put(repo, 'a.md', 'one\n')
  commitAll(repo, 'init')
  git(repo, ['config', 'filter.lfsish.clean', 'cat'])
  put(repo, 'a.md', 'two\n')
  const s = await slice(request(checkoutRoot(repo), { task: 'checkout-status' }))
  assert.ok(s.rows.some(x => x.path === join(repo, 'a.md')))
  assert.equal(s.end.coverage, 'partial')
  assert.equal(s.end.error?.code, 'git-filter-unresolved')
})

test('DEFECT-6: checkout-status completes when a configured filter driver applies to no document, and stays partial when it applies to one', async () => {
  const repo = newRepo()
  put(repo, 'a.md', 'one\n'); put(repo, 'b.bin', 'bin\n'); put(repo, 'sub/clean.md', 'clean\n')
  commitAll(repo, 'init')
  // Configured (as git-lfs is for most users), named by no attribute.
  git(repo, ['config', 'filter.lfsish.clean', 'cat'])
  git(repo, ['config', 'filter.lfsish.smudge', 'cat'])
  put(repo, 'a.md', 'two\n'); put(repo, 'new.md', 'new\n')
  const r = checkoutRoot(repo)
  let s = await slice(request(r, { task: 'checkout-status' }))
  assert.ok(s.rows.some(x => x.path === join(repo, 'a.md')) && s.rows.some(x => x.path === join(repo, 'new.md')))
  assert.deepEqual([s.end.complete, s.end.coverage, s.end.error], [true, 'complete', undefined], 'an unreferenced driver changes nothing')
  // Applied only to a path that is not a document: documents are unaffected.
  put(repo, '.gitattributes', '*.bin filter=lfsish\n')
  s = await slice(request(r, { task: 'checkout-status' }))
  assert.deepEqual([s.end.coverage, s.end.error], ['complete', undefined])
  // Applied to a tracked document, even one status reports clean: Git's "clean" is not byte equivalence there.
  put(repo, '.gitattributes', '*.bin filter=lfsish\nsub/*.md filter=lfsish\n')
  s = await slice(request(r, { task: 'checkout-status' }))
  assert.deepEqual([s.end.complete, s.end.coverage, s.end.error?.code], [true, 'partial', 'git-filter-unresolved'])
  // An attribute source Git cannot read is never taken as "no filter".
  put(repo, '.gitattributes', '*.bin filter=lfsish\n')
  const elsewhere = put(newDir('attrs-'), 'attrs', 'sub/*.md filter=lfsish\n')
  symlinkSync(elsewhere, join(repo, 'sub', '.gitattributes'))
  s = await slice(request(r, { task: 'checkout-status' }))
  assert.deepEqual([s.end.coverage, s.end.error?.code], ['partial', 'git-filter-unresolved'])
})

test('checkout-status output cap keeps parsed observations and marks the inventory incomplete', async () => {
  const repo = newRepo()
  put(repo, 'seed.md')
  commitAll(repo, 'init')
  for (let i = 0; i < 50; i++) put(repo, `untracked-${String(i).padStart(2, '0')}.md`)
  const s = await slice(request(checkoutRoot(repo), { task: 'checkout-status', limits: limits({ gitMaxOutputBytes: 200 }) }))
  assert.ok(s.rows.length > 0 && s.rows.length < 50, `partial output still yields what was parsed (${s.rows.length})`)
  assert.equal(s.end.coverage, 'partial')
  assert.equal(s.end.error?.code, 'git-status-truncated')
})

test('checkout-status refuses a root that is not the top of its checkout', async () => {
  const repo = newRepo()
  put(repo, 'sub/a.md')
  commitAll(repo, 'init')
  const s = await slice(request(checkoutRoot(join(repo, 'sub')), { task: 'checkout-status' }))
  assert.equal(s.end.error?.code, 'checkout-mismatch')
  const plain = newDir()
  const n = await slice(request(checkoutRoot(plain), { task: 'checkout-status' }))
  assert.equal(n.end.error?.code, 'not-a-checkout')
  assert.equal(n.end.coverage, 'inaccessible')
})

// --------------------------------------------------------------------------------------------------------------- git-history

test('git-history emits commit observations with Git metadata, R25 evidence, and no filesystem path or stat', async () => {
  const repo = newRepo()
  put(repo, 'a.md', 'first\n')
  put(repo, 'code.ts', 'x\n')
  const c1 = commitAll(repo, 'add a')
  put(repo, 'a.md', 'second version\n')
  const c2 = commitAll(repo, `edit a\n\nAtlas-Session: ${SID}\n`)
  unlinkSync(join(repo, 'a.md'))
  commitAll(repo, 'remove a')
  const r = checkoutRoot(repo)
  const s = await drain(request(r, { task: 'git-history' }))
  assert.equal(s.end.complete, true)
  assert.equal(s.end.coverage, 'complete')
  assert.equal(typeof s.end.cursor, 'string', 'a finished history pass keeps its ref-tip cursor for the next pass')
  const byCommit = new Map(s.rows.map(x => [x.git!.commitOid, x]))
  assert.deepEqual([...byCommit.keys()].sort(), [c1, c2].sort())
  for (const [oid, row] of byCommit) {
    assert.equal(row.kind, 'commit')
    assert.equal(row.path, undefined)
    assert.equal(row.stat, undefined)
    assert.deepEqual(row.identity, { identityKind: 'repository', repositoryId: 'repo-uuid-1', rootId: null, relativePath: 'a.md' })
    assert.equal(row.git!.repositoryId, 'repo-uuid-1')
    assert.equal(row.git!.gitPath, 'a.md')
    assert.equal(row.git!.blobOid, gitLine(repo, ['rev-parse', `${oid}:a.md`]))
    assert.equal(row.git!.objectFormat, 'sha1')
    assert.equal(row.git!.mode, 0o100644)
    assert.equal(row.git!.size, Buffer.byteLength(git(repo, ['cat-file', 'blob', row.git!.blobOid!])))
    assert.equal(row.evidence!.source, 'git')
    assert.equal(row.evidence!.operation, 'touched')
    assert.equal(row.evidence!.eventKey, `git:${oid}:a.md`)
    assert.equal(row.evidence!.eventAt, new Date(Number(gitLine(repo, ['log', '-1', '--format=%ct', oid!])) * 1000).toISOString())
  }
  assert.equal(byCommit.get(c1)!.evidence!.certainty, 'unknown')
  assert.equal(byCommit.get(c1)!.evidence!.sessionId, null)
  assert.equal(byCommit.get(c2)!.evidence!.certainty, 'recorded')
  assert.equal(byCommit.get(c2)!.evidence!.sessionId, SID)

  // The next pass follows the persisted cursor and imports only what is newly reachable.
  put(repo, 'later.md', 'later\n')
  const c4 = commitAll(repo, 'later')
  const next = await drain(request(r, { task: 'git-history', cursor: s.end.cursor }))
  assert.deepEqual(next.rows.map(x => [x.git!.commitOid, x.git!.gitPath]), [[c4, 'later.md']])
})

test('git-history first pass honours the lookback and reports it until older files are imported', async () => {
  const repo = newRepo()
  const oldSec = Math.floor((Date.now() - 30 * DAY_MS) / 1000)
  put(repo, 'old.md', 'old\n')
  commitAll(repo, 'old', { GIT_COMMITTER_DATE: `${oldSec} +0000`, GIT_AUTHOR_DATE: `${oldSec} +0000` })
  put(repo, 'new.md', 'new\n')
  commitAll(repo, 'new')
  const r = checkoutRoot(repo)
  const first = await drain(request(r, { task: 'git-history', includeOlder: false, sinceMs: Date.now() - 7 * DAY_MS }))
  assert.deepEqual(first.rows.map(x => x.git!.gitPath), ['new.md'])
  assert.equal(first.end.complete, true)
  assert.equal(first.end.coverage, 'partial', 'older history was deliberately not imported')
  assert.equal(first.end.error?.code, 'lookback-limited')

  const older = await drain(request(r, { task: 'git-history', includeOlder: true, cursor: first.end.cursor }))
  assert.deepEqual(older.rows.map(x => x.git!.gitPath).sort(), ['new.md', 'old.md'])
  assert.equal(older.end.coverage, 'complete')
  assert.equal(older.end.error, undefined)
})

test('git-history maps adapter failures without losing or skipping the cursor', async () => {
  const repo = newRepo()
  put(repo, 'a.md')
  commitAll(repo, 'one')
  const r = checkoutRoot(repo)
  const pass = await drain(request(r, { task: 'git-history' }))
  put(repo, 'b.md')
  commitAll(repo, 'two')
  const failed = await slice(request(r, { task: 'git-history', cursor: pass.end.cursor, limits: limits({ gitTimeoutMs: 1 }) }))
  assert.equal(failed.rows.length, 0)
  assert.match(failed.end.error!.code, /^git-/)
  assert.equal(failed.end.cursor, pass.end.cursor, 'a retryable failure returns the cursor unchanged')
  assert.equal(failed.end.complete, false)
  assert.equal(failed.end.coverage, 'partial')

  const retried = await drain(request(r, { task: 'git-history', cursor: failed.end.cursor }))
  assert.deepEqual(retried.rows.map(x => x.git!.gitPath), ['b.md'], 'nothing was skipped by the failure')
})

test('git-history counts paths the catalog cannot key, while output-walk keeps newline names', async () => {
  const repo = newRepo()
  put(repo, 'plain.md')
  put(repo, 'new\nline.md', 'odd name\n')
  commitAll(repo, 'odd')
  const r = checkoutRoot(repo)
  const h = await drain(request(r, { task: 'git-history' }))
  assert.deepEqual(h.rows.map(x => x.git!.gitPath), ['plain.md'])
  assert.equal(h.end.coverage, 'partial')
  assert.equal(h.end.error?.code, 'unsupported-path')
  assert.ok(h.total.skipped >= 1)

  // Edited, so the walk emits it (a clean tracked file is not an output, R66): the Git path survives the NUL-separated index
  // listing intact. plain.md stays clean and is not emitted.
  put(repo, 'new\nline.md', 'odd name, edited\n')
  const w = await slice(request(r))
  assert.ok(w.rows.some(x => x.path === join(repo, 'new\nline.md') && x.identity.relativePath === 'new\nline.md'))
  assert.ok(!w.rows.some(x => x.path === join(repo, 'plain.md')))
})

test('git-history and checkout-status require a checkout root', async () => {
  const root = newDir()
  for (const task of ['git-history', 'checkout-status'] as const) {
    const s = await slice(request(outputRoot(root), { task }))
    assert.equal(s.end.error?.code, 'unsupported-task', task)
  }
})
