import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as tmp from './tmp.ts'

// The temp-directory helper (final review, minor): a run that is killed (SIGINT, SIGTERM) leaves its directories behind unless the
// helper cleans up on those signals too, and the leaks pile up in the OS temp folder. Everything here uses a disposable base
// directory (the sweeper takes the base as a parameter and the child processes get it as TMPDIR); no test touches the real temp
// folder's other contents.

const TMP_TS = fileURLToPath(new URL('./tmp.ts', import.meta.url))
const H = 3_600_000
const base = () => realpathSync(tmp.tempDir('atlas-tmptest-'))

/** Runs a child that imports the helper with TMPDIR=`dir`, creates directories as asked and then waits or exits. */
function child(dir: string, body: string): { proc: ReturnType<typeof spawn>; lines: Promise<string[]>; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const script = `const { tempDir } = await import(${JSON.stringify(pathToFileURL(TMP_TS).href)})\n${body}`
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => { out += c })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', (code, signal) => resolve({ code, signal }))
  })
  const lines = new Promise<string[]>(resolve => {
    const t = setInterval(() => { if (out.includes('READY\n')) { clearInterval(t); resolve(out.split('\n').filter(l => l && l !== 'READY')) } }, 20)
    proc.on('exit', () => { clearInterval(t); resolve(out.split('\n').filter(l => l && l !== 'READY')) })
  })
  return { proc, lines, done }
}

const WAIT = `const a = tempDir('atlas-sig-'), b = tempDir('atlas-sig2-')
process.stdout.write(a + '\\n' + b + '\\nREADY\\n')
setInterval(() => {}, 1000)`

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`a run killed by ${signal} removes its temporary directories and still dies from that signal`, async () => {
    const dir = base()
    const { proc, lines, done } = child(dir, WAIT)
    const [a, b] = await lines
    assert.ok(a && b && existsSync(a) && existsSync(b), 'the child created two directories')
    proc.kill(signal)
    const end = await done
    assert.equal(end.signal, signal, 'the signal is re-raised after the cleanup, so the exit status is the signal\'s')
    assert.deepEqual([existsSync(a), existsSync(b)], [false, false], 'both directories are gone')
    assert.deepEqual(readdirSync(join(dir, tmp.TEMP_MARKER_DIR)), [], 'and so are their markers')
  })
}

test('a run that ends normally removes its directories and their markers, and leaves a fresh base without stray files', async () => {
  const dir = base()
  const { lines, done } = child(dir, `const a = tempDir('atlas-end-')\nprocess.stdout.write(a + '\\nREADY\\n')`)
  const [a] = await lines
  assert.ok(a?.startsWith(dir))
  const end = await done
  assert.deepEqual(end, { code: 0, signal: null })
  assert.equal(existsSync(a!), false)
  assert.deepEqual(readdirSync(join(dir, tmp.TEMP_MARKER_DIR)), [])
})

test('a directory is recorded for the sweeper only when it is a plain atlas-* name directly in the OS temp folder', async () => {
  const dir = base()
  const outside = join(dir, 'elsewhere')
  mkdirSync(outside)
  const { lines, done } = child(dir, `const fs = await import('node:fs')
const a = tempDir('atlas-mark-'), b = tempDir('plain-'), c = tempDir('atlas-in-base-', ${JSON.stringify(outside)})
process.stdout.write([a, b, c, fs.readdirSync(${JSON.stringify(join(dir, tmp.TEMP_MARKER_DIR))}).join(',')].join('\\n') + '\\nREADY\\n')`)
  const out = await lines
  await done
  assert.equal(out.length, 4)
  assert.equal(out[3], out[0]!.slice(dir.length + 1), 'only the atlas-* directory in the temp folder has a marker')
})

// ---------------------------------------------------------------------------------------------------------------- the sweeper

/** A directory with a file in it, and (when `ageHours` is given) a marker backdated by that many hours, as the helper writes it. */
function make(root: string, name: string, ageHours: number | null): string {
  const d = join(root, name)
  mkdirSync(d)
  writeFileSync(join(d, 'f.txt'), 'x')
  if (ageHours !== null) mark(root, name, ageHours)
  return d
}
function mark(root: string, name: string, ageHours: number): void {
  const m = join(root, tmp.TEMP_MARKER_DIR)
  mkdirSync(m, { recursive: true })
  const file = join(m, name)
  writeFileSync(file, '')
  const t = new Date(Date.now() - ageHours * H)
  utimesSync(file, t, t)
}

test('the sweeper removes only directories this helper recorded more than 24 hours ago, and nothing else', () => {
  const root = base()
  const outsideTarget = join(base(), 'precious')
  mkdirSync(outsideTarget)
  writeFileSync(join(outsideTarget, 'keep.txt'), 'keep')
  const old = make(root, 'atlas-old-AAAAAA', 25)
  const veryOld = make(root, 'atlas-older-BBBBBB', 24 * 30)
  const recent = make(root, 'atlas-recent-CCCCCC', 23)
  const fresh = make(root, 'atlas-fresh-DDDDDD', 0)
  // Old by its own timestamps but never recorded by the helper: not ours, never removed.
  const unrecorded = make(root, 'atlas-unrecorded-EEEEEE', null)
  const longAgo = new Date(Date.now() - 100 * H)
  utimesSync(unrecorded, longAgo, longAgo)
  // A marker alone does not make a name eligible: it must start with atlas-.
  const notAtlas = make(root, 'other-FFFFFF', 48)
  const unrelated = make(root, 'keep-me', null)
  // A symbolic link under an eligible name is never followed or removed, and the target stays.
  symlinkSync(outsideTarget, join(root, 'atlas-link-GGGGGG'))
  mark(root, 'atlas-link-GGGGGG', 48)
  // A regular file under an eligible name is not a directory, so it is left alone.
  writeFileSync(join(root, 'atlas-file-HHHHHH'), 'not a directory')
  mark(root, 'atlas-file-HHHHHH', 48)
  // A marker whose directory is already gone is dropped.
  mark(root, 'atlas-gone-IIIIII', 48)

  const removed = tmp.sweepStaleTempDirs({ base: root }).sort()
  assert.deepEqual(removed, ['atlas-older-BBBBBB', 'atlas-old-AAAAAA'].sort())
  assert.deepEqual([old, veryOld].map(existsSync), [false, false])
  assert.deepEqual([recent, fresh, unrecorded, notAtlas, unrelated].map(existsSync), [true, true, true, true, true])
  assert.equal(lstatSync(join(root, 'atlas-link-GGGGGG')).isSymbolicLink(), true, 'the link itself is not touched')
  assert.equal(readFileSync(join(outsideTarget, 'keep.txt'), 'utf8'), 'keep', 'and its target is intact')
  assert.equal(readFileSync(join(root, 'atlas-file-HHHHHH'), 'utf8'), 'not a directory')
  const markers = readdirSync(join(root, tmp.TEMP_MARKER_DIR)).sort()
  assert.ok(!markers.includes('atlas-old-AAAAAA') && !markers.includes('atlas-gone-IIIIII'), `swept and orphaned markers are dropped: ${markers.join(', ')}`)
  assert.ok(markers.includes('atlas-recent-CCCCCC') && markers.includes('atlas-fresh-DDDDDD'), 'markers of directories still in their time stay')
  assert.deepEqual(tmp.sweepStaleTempDirs({ base: root }), [], 'a second sweep finds nothing more')
  // Ages are measured against the clock the caller gives.
  assert.deepEqual(tmp.sweepStaleTempDirs({ base: root, now: Date.now() + 2 * H }).sort(), ['atlas-recent-CCCCCC'])
})

test('the sweeper never throws: a missing base, a missing registry and unreadable entries are ignored', () => {
  const root = base()
  assert.deepEqual(tmp.sweepStaleTempDirs({ base: join(root, 'no-such-base') }), [])
  assert.deepEqual(tmp.sweepStaleTempDirs({ base: root }), [])
  mkdirSync(join(root, tmp.TEMP_MARKER_DIR, 'atlas-a-JJJJJJ'), { recursive: true })
  assert.doesNotThrow(() => tmp.sweepStaleTempDirs({ base: root, now: Date.now() + 100 * H }))
  rmSync(join(root, tmp.TEMP_MARKER_DIR), { recursive: true, force: true })
})
