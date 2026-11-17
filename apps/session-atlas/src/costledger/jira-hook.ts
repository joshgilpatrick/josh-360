import type { LedgerDb } from './db.ts'
import { recordJiraSessionLink } from './jira-links.ts'

// Claude Code PostToolUse hook for the Jira CLI. Runs after a Bash tool call succeeds and records
// a ticket-session link when that command transitioned or commented on an explicit issue key.
// Edits, creates, views, and searches are not logged (see the using-jira skill).

const JIRA_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/
// `comment` with no subcommand is the form acli's own examples use; list/delete/visibility are not work on the ticket.
const READ_ONLY_COMMENT = new Set(['list', 'delete', 'visibility'])

export type JiraHookPayload = {
  session_id?: unknown
  tool_name?: unknown
  tool_input?: unknown
  tool_response?: unknown
  tool_output?: unknown
}

// acli exits 0 even when it fails, and writes the failure to stdout as "✗ Failure: ..." or "✗ Error: ...".
// Only the exit code is not a reliable signal, so a line starting with this marker means the call did not happen.
const ACLI_FAILURE = /(^|\n)\s*✗\s*(Failure|Error)\b/

/** Stdout/stderr text of the Bash call, from whichever field the Claude Code payload carries it in. */
function bashOutputText(payload: JiraHookPayload): string | null {
  const response = (payload.tool_response ?? payload.tool_output) as unknown
  if (typeof response === 'string') return response
  if (response && typeof response === 'object') {
    const r = response as { stdout?: unknown; stderr?: unknown }
    return `${typeof r.stdout === 'string' ? r.stdout : ''}\n${typeof r.stderr === 'string' ? r.stderr : ''}`
  }
  return null
}

/**
 * Splits a shell line into simple commands, each a list of words. Follows shell quoting so text
 * inside quotes (an echo, a commit message, a JSON payload) is one word and never starts a command.
 * Only && || ; | and newlines outside quotes separate commands.
 */
export function shellCommands(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null

  const endWord = (): void => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < line.length) word += line[++i]
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; hasWord = true; continue }
    if (ch === '\\' && i + 1 < line.length) { word += line[++i]; hasWord = true; continue }
    if (ch === ' ' || ch === '\t') { endWord(); continue }
    if (ch === '\n' || ch === ';') { endCommand(); continue }
    if (ch === '&' && line[i + 1] === '&') { endCommand(); i++; continue }
    if (ch === '|') { endCommand(); if (line[i + 1] === '|') i++; continue }
    word += ch
    hasWord = true
  }
  endCommand()
  return commands
}

/** Words of an acli call that transitions or comments on a work item. Leading VAR=value assignments and a path to acli are allowed. */
function isLoggedAcliCall(words: string[]): boolean {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i++
  const program = words[i] ?? ''
  if (program !== 'acli' && !program.endsWith('/acli')) return false
  if (words[i + 1] !== 'jira' || words[i + 2] !== 'workitem') return false
  const action = words[i + 3]
  if (action === 'transition') return true
  return action === 'comment' && !READ_ONLY_COMMENT.has(words[i + 4] ?? '')
}

/** Issue keys given with --key or -k (value as its own word or after =). --jql and --filter name no keys, so they add nothing. */
function keysFromWords(words: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if (word === '--key' || word === '-k') values.push(words[i + 1] ?? '')
    else if (word.startsWith('--key=')) values.push(word.slice('--key='.length))
  }
  return values.flatMap(v => v.split(',')).map(k => k.trim()).filter(k => JIRA_KEY.test(k))
}

/** Issue keys named in logged acli calls within one Bash command line. Each key appears once. */
export function jiraIssueKeysFromCommand(command: string): string[] {
  const keys: string[] = []
  for (const words of shellCommands(command)) {
    if (!isLoggedAcliCall(words)) continue
    for (const key of keysFromWords(words)) if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

/** Records one link per issue named in a successful Jira transition or comment. Returns the keys it recorded. */
export function recordJiraHookLinks(db: LedgerDb, payload: JiraHookPayload, recordedAt: string): string[] {
  if (payload.tool_name !== 'Bash') return []
  if (typeof payload.session_id !== 'string' || payload.session_id === '') return []
  const toolInput = payload.tool_input as { command?: unknown } | undefined
  if (typeof toolInput?.command !== 'string') return []
  // Fail closed: if the output is missing or shows an acli failure, the Jira call did not happen, so nothing is logged.
  const output = bashOutputText(payload)
  if (output === null || ACLI_FAILURE.test(output)) return []
  const keys = jiraIssueKeysFromCommand(toolInput.command)
  for (const issueKey of keys) {
    recordJiraSessionLink(db, { issueKey, tool: 'claude-code', sessionId: payload.session_id, action: 'worked', recordedAt })
  }
  return keys
}
