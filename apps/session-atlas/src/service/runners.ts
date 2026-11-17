import { pruneSettledCandidates } from '../artifacts/candidates.ts'
import type { AtlasDb } from '../db/database.ts'
import type { Logger } from '../util/log.ts'

export type Runner = { name: string; run(): Promise<boolean>; stop?(): void }

/** Hourly housekeeping: removes settled artifact candidates, capped per pass so a large backlog clears over several passes. */
export function pruneRunner(db: AtlasDb, log: Logger, opts: { intervalMs?: number } = {}): Runner {
  const intervalMs = opts.intervalMs ?? 3_600_000
  let last = 0
  return {
    name: 'prune',
    async run() {
      if (Date.now() - last < intervalMs) return false
      last = Date.now()
      const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
      const candidates = pruneSettledCandidates(db, cutoff, { maxRows: 200_000 })
      if (candidates) log.info('pruned settled artifact candidates', { n: candidates })
      return false
    },
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const t = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

export async function runLoop(runners: Runner[], opts: { pollMs: number; log: Logger; signal: AbortSignal }): Promise<void> {
  while (!opts.signal.aborted) {
    let busy = false
    for (const r of runners) {
      if (opts.signal.aborted) break
      try { busy = (await r.run()) || busy } catch (err) { opts.log.error('runner failed', { runner: r.name, err: String(err) }) }
    }
    // Yield to a macrotask between busy passes so pending HTTP requests get served during a long pass.
    if (busy) await new Promise<void>(resolve => setImmediate(resolve))
    else await sleep(opts.pollMs, opts.signal)
  }
}
