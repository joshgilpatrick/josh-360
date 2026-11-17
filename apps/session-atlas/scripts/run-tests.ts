// Runs the suite with --test-concurrency at half the CPUs (at least one). Node's default of CPUs minus one
// loaded a 12-CPU Mac enough to fail timing tests (ledger E025, owner choice E028).
import { spawn } from 'node:child_process'
import { availableParallelism, constants } from 'node:os'
import { fileURLToPath } from 'node:url'

export function testConcurrency(cpus: number): number {
  if (!Number.isFinite(cpus) || cpus < 1) return 1
  return Math.max(1, Math.floor(cpus / 2))
}

export function testArgs(cpus: number, extra: readonly string[]): string[] {
  return [
    '--disable-warning=ExperimentalWarning',
    '--test',
    `--test-concurrency=${testConcurrency(cpus)}`,
    'test/**/*.test.ts',
    ...extra,
  ]
}

// A shell reports a signal death as 128 plus the signal number; the wrapper does the same without re-raising the signal.
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  const number = signal === null ? undefined : constants.signals[signal]
  return number === undefined ? 1 : 128 + number
}

if (import.meta.main) {
  const cpus = availableParallelism()
  process.stderr.write(`run-tests: --test-concurrency=${testConcurrency(cpus)} (${cpus} CPUs available)\n`)
  const child = spawn(process.execPath, testArgs(cpus, process.argv.slice(2)), {
    stdio: 'inherit',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  })
  // Pass stop signals (npm, timeout, CI limits) on, or the test run would be orphaned when this wrapper dies.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig))
  child.on('error', error => { throw error })
  child.on('exit', (code, signal) => { process.exitCode = exitStatus(code, signal) })
}
