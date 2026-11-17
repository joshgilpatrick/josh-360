import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { nowIso } from './time.ts'

export type Logger = {
  info(msg: string, data?: object): void
  warn(msg: string, data?: object): void
  error(msg: string, data?: object): void
}

export type LoggerOptions = {
  /** Rotate once the file is larger than this. Defaults to 20 MiB. */
  maxBytes?: number
  /** Check the size on the first write and then every this many writes, not on each one. Defaults to 500. */
  checkEvery?: number
}

// The log is append-only JSON lines. Without a cap it grew to over 300 MB on the owner's machine, so once it passes
// `maxBytes` it is renamed to `<path>.1` (replacing an older one) and a new file starts. One old file is kept.
export function createLogger(path: string | null, opts: LoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024
  const checkEvery = Math.max(1, opts.checkEvery ?? 500)
  if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let writes = 0
  const rotateIfLarge = (p: string) => {
    try {
      if (statSync(p).size > maxBytes) renameSync(p, `${p}.1`)
    } catch { /* missing file or a failed rename: keep appending to the current file */ }
  }
  const write = (level: string, msg: string, data?: object) => {
    const line = JSON.stringify({ ts: nowIso(), level, msg, ...(data ?? {}) }) + '\n'
    if (path) {
      if (writes++ % checkEvery === 0) rotateIfLarge(path)
      try { appendFileSync(path, line, { mode: 0o600 }) } catch { process.stderr.write(line) }
    } else if (level !== 'info') {
      process.stderr.write(line)
    }
  }
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  }
}
