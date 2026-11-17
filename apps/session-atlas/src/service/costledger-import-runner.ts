import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../util/log.ts'
import type { Runner } from './runners.ts'

export const COST_LEDGER_IMPORT_INTERVAL_MS = 3_600_000
const MAX_CAPTURED_OUTPUT = 32 * 1024

type ImportRunResult = { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
type ImportCommand = (args: string[]) => Promise<ImportRunResult>

type Options = {
  homeDir: string
  ledgerPath: string
  projectsDir: string
  piSessionsDir: string
  log: Logger
  intervalMs?: number
  now?: () => number
  runImport?: ImportCommand
}

function repoRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..', '..')
}

function boundedText(stream: NodeJS.ReadableStream | null): () => string {
  let text = ''
  let truncated = false
  stream?.on('data', (chunk: Buffer | string) => {
    const value = String(chunk)
    if (text.length >= MAX_CAPTURED_OUTPUT) { truncated = true; return }
    if (text.length + value.length > MAX_CAPTURED_OUTPUT) truncated = true
    text += value.slice(0, MAX_CAPTURED_OUTPUT - text.length)
  })
  return () => `${text}${truncated ? '\n[output truncated]' : ''}`
}

function runImportCommand(args: string[], onStart: (child: ChildProcess) => void, onExit: (child: ChildProcess) => void): Promise<ImportRunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = boundedText(child.stdout)
    const stderr = boundedText(child.stderr)
    onStart(child)
    child.once('error', err => { onExit(child); reject(err) })
    child.once('close', (exitCode, signal) => {
      onExit(child)
      resolveResult({ exitCode, signal, stdout: stdout(), stderr: stderr() })
    })
  })
}

function importArgs(o: Pick<Options, 'homeDir' | 'ledgerPath' | 'projectsDir' | 'piSessionsDir'>): string[] {
  return [
    '--disable-warning=ExperimentalWarning',
    join(repoRoot(), 'src', 'costledger', 'cli.ts'),
    'import',
    '--claude-dir', o.projectsDir,
    '--pi-dir', o.piSessionsDir,
    '--opencode-db', join(o.homeDir, '.local', 'share', 'opencode', 'opencode.db'),
    '--db', o.ledgerPath,
  ]
}

/** Runs the importer out of process so transcript scanning cannot stall Atlas's event loop. */
export function costLedgerImportRunner(o: Options): Runner {
  const intervalMs = o.intervalMs ?? COST_LEDGER_IMPORT_INTERVAL_MS
  const now = o.now ?? Date.now
  const args = importArgs(o)
  let activeChild: ChildProcess | null = null
  let lastStarted = Number.NEGATIVE_INFINITY
  let running = false
  let stopping = false
  const runImport = o.runImport ?? (argv => runImportCommand(
    argv,
    child => { activeChild = child },
    child => { if (activeChild === child) activeChild = null },
  ))

  return {
    name: 'cost-ledger-import',
    stop() {
      stopping = true
      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill('SIGTERM')
    },
    async run() {
      const startedAt = now()
      if (stopping || running || startedAt - lastStarted < intervalMs) return false
      lastStarted = startedAt
      running = true
      try {
        void runImport(args).then(result => {
          if (stopping && result.signal === 'SIGTERM') {
            o.log.info('ledger import stopped during Atlas shutdown')
            return
          }
          if (result.exitCode !== 0) {
            o.log.error('ledger import failed', { exitCode: result.exitCode, signal: result.signal, stderr: result.stderr.trim() })
            return
          }
          if (result.stderr.trim()) o.log.warn('ledger import reported source errors', { stderr: result.stderr.trim() })
          o.log.info('ledger import completed', { summary: result.stdout.trim() })
        }).catch(err => {
          o.log.error('ledger import failed', { err: err instanceof Error ? err.message : String(err) })
        }).finally(() => { running = false })
      } catch (err) {
        running = false
        o.log.error('ledger import failed', { err: err instanceof Error ? err.message : String(err) })
      }
      return false
    },
  }
}
