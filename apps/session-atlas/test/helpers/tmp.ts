import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const registry = new Set<string>()
/** Directory -> the marker written for it (only for atlas-* directories created directly in the OS temp folder). */
const markers = new Map<string, string>()
let hooked = false

/** Names the sweeper may remove: a plain atlas-* name (what mkdtemp makes from the test prefixes), never a path. */
const SWEEPABLE_NAME = /^atlas-[A-Za-z0-9._-]+$/
/** How old a recorded directory must be before the sweeper removes it. */
export const TEMP_SWEEP_MAX_AGE_MS = 24 * 3_600_000
/**
 * A hidden folder in the temp folder with one empty file per directory this helper created there, named after it. The file's
 * modification time is the directory's creation time. The sweeper removes only directories that have such a file, so a directory
 * made by anything else (another tool, an older test run before this existed, a person) is never its business, and nothing is
 * written inside the directories handed to tests.
 */
export const TEMP_MARKER_DIR = '.atlas-test-tmp'

function forget(dir: string): void {
  const marker = markers.get(dir)
  markers.delete(dir)
  if (marker) try { rmSync(marker, { force: true }) } catch { /* best effort */ }
}

function cleanup(): void {
  for (const d of registry) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    forget(d)
  }
  registry.clear()
}

/**
 * Best effort: removes the atlas-* directories this helper recorded (see TEMP_MARKER_DIR) in `base` (default: the OS temp folder)
 * more than `maxAgeMs` (default 24 hours) ago, which only a run that was killed or crashed leaves behind. Never follows a
 * symbolic link, removes nothing that is not a real directory of the current user, and ignores every error. Returns the names it
 * removed. `base`, `now` and `maxAgeMs` exist for the tests; a caller never needs them.
 */
export function sweepStaleTempDirs(opts: { base?: string; now?: number; maxAgeMs?: number } = {}): string[] {
  const removed: string[] = []
  try {
    const base = opts.base ?? tmpdir()
    const now = opts.now ?? Date.now()
    const maxAge = opts.maxAgeMs ?? TEMP_SWEEP_MAX_AGE_MS
    const folder = join(base, TEMP_MARKER_DIR)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    for (const name of readdirSync(folder)) {
      try {
        if (!SWEEPABLE_NAME.test(name)) continue
        const marker = join(folder, name)
        const m = lstatSync(marker)
        if (!m.isFile() || now - m.mtimeMs < maxAge) continue
        const dir = join(base, name)
        let st: Stats | null = null
        try { st = lstatSync(dir) } catch { st = null }
        if (st === null) { rmSync(marker, { force: true }); continue }
        // lstat does not follow: a link, a file or another user's directory under this name is left exactly as it is.
        if (st.isDirectory() && (uid === null || st.uid === uid)) {
          rmSync(dir, { recursive: true, force: true })
          rmSync(marker, { force: true })
          removed.push(name)
        } else if (!st.isDirectory()) {
          rmSync(marker, { force: true })
        }
      } catch { /* one entry failing never stops the sweep */ }
    }
  } catch { /* no registry yet, an unreadable base: nothing to sweep */ }
  return removed
}

function hook(): void {
  if (hooked) return
  hooked = true
  // A run that ends by itself cleans up on exit. A run that is interrupted or terminated (Ctrl-C, a stopped container) gets no
  // exit event, so those signals clean up too and then re-raise the signal with its default action, so the exit status still says
  // how the process ended. Limit: while the main thread is blocked in synchronous work the signal is deferred until it returns
  // (measured: a 4 s busy loop died at 4,008 ms with these handlers installed and at 306 ms without), so a test stuck in an
  // infinite synchronous loop does not react to SIGINT or SIGTERM and needs SIGKILL, which leaves its directories to the sweep.
  process.on('exit', cleanup)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanup()
      process.kill(process.pid, signal)
    })
  }
  // What an earlier run left behind (killed before it could clean up) and is more than a day old.
  sweepStaleTempDirs()
}

/** mkdtemp under the OS temp dir (or `base`), removed automatically when the test process exits or is interrupted. */
export function tempDir(prefix: string, base: string = tmpdir()): string {
  hook()
  const dir = mkdtempSync(join(base, prefix))
  registry.add(dir)
  const name = basename(dir)
  if (SWEEPABLE_NAME.test(name) && resolve(dirname(dir)) === resolve(tmpdir())) {
    try {
      const folder = join(dirname(dir), TEMP_MARKER_DIR)
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const marker = join(folder, name)
      writeFileSync(marker, '')
      markers.set(dir, marker)
    } catch { /* not recorded: the exit and signal cleanup still apply */ }
  }
  return dir
}

/** Remove one registered dir early (idempotent). */
export function removeTempDir(dir: string): void {
  registry.delete(dir)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  forget(dir)
}
