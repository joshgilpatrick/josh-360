import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_LEDGER_PATH } from './constants.ts'
import { openLedger } from './db.ts'
import { recordJiraHookLinks } from './jira-hook.ts'

// Entry point for the Claude Code PostToolUse hook. It must never block or fail a Jira action,
// so the process always exits 0. A failure is not silent: it is appended to a log beside the ledger.
export function runJiraHook(raw: string, ledgerPath: string, now: string): number {
  try {
    const payload = JSON.parse(raw) as Parameters<typeof recordJiraHookLinks>[1]
    const db = openLedger(ledgerPath)
    try {
      recordJiraHookLinks(db, payload, now)
    } finally {
      db.close()
    }
  } catch (err) {
    logFailure(ledgerPath, now, err)
  }
  return 0
}

function logFailure(ledgerPath: string, now: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  try {
    appendFileSync(join(dirname(ledgerPath), 'jira-hook.log'), `${now} ${message.replace(/\s+/g, ' ').slice(0, 500)}\n`)
  } catch {
    // Nowhere left to report to; the hook still exits 0.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }
  process.exitCode = runJiraHook(raw, process.env.COSTLEDGER_DB ?? DEFAULT_LEDGER_PATH, new Date().toISOString())
}
