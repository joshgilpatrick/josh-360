import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import type { LedgerDb } from './db.ts'
import { listJsonl } from './files.ts'
import type { Tool } from './types.ts'

/** Human-friendly names a session carries. Not every tool has every kind; a missing kind is simply absent. */
export type LabelKind = 'custom_title' | 'ai_title' | 'agent_name' | 'tool_title'
export type SessionLabel = { tool: Tool; sessionId: string; kind: LabelKind; value: string }
export type PrLink = { tool: Tool; sessionId: string; url: string; repository: string | null; number: string | null }
export type ParsedLabels = { labels: SessionLabel[]; prLinks: PrLink[] }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null)

const CLAUDE_KINDS: Record<string, { kind: LabelKind; field: string }> = {
  'custom-title': { kind: 'custom_title', field: 'customTitle' },
  'ai-title': { kind: 'ai_title', field: 'aiTitle' },
  'agent-name': { kind: 'agent_name', field: 'agentName' },
}
const CLAUDE_MARKERS = ['"type":"custom-title"', '"type":"ai-title"', '"type":"agent-name"', '"type":"pr-link"']

/** The session a Claude transcript belongs to when a record does not name one: the parent folder for subagent files, else the file name. */
function claudeFallbackSession(path: string): string {
  const parts = path.split('/')
  const sub = parts.lastIndexOf('subagents')
  if (sub > 0 && parts[sub - 1]) return parts[sub - 1] as string
  return basename(path).replace(/\.jsonl$/, '')
}

/** Claude Code: the last custom title, AI title and agent name per session, and each distinct PR link. */
export async function parseClaudeLabels(path: string): Promise<ParsedLabels> {
  const fallback = claudeFallbackSession(path)
  const latest = new Map<string, SessionLabel>()
  const prs = new Map<string, PrLink>()
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const text of rl) {
    if (!CLAUDE_MARKERS.some(m => text.includes(m))) continue
    let d: unknown
    try { d = JSON.parse(text) } catch { continue }
    if (!isObj(d) || typeof d.type !== 'string') continue
    const sessionId = str(d.sessionId) ?? fallback
    const spec = CLAUDE_KINDS[d.type]
    if (spec) {
      const value = str(d[spec.field])
      if (value !== null) latest.set(`${sessionId}\u0000${spec.kind}`, { tool: 'claude-code', sessionId, kind: spec.kind, value })
    } else if (d.type === 'pr-link') {
      const url = str(d.prUrl)
      if (url !== null) prs.set(`${sessionId}\u0000${url}`, { tool: 'claude-code', sessionId, url, repository: str(d.prRepository), number: str(d.prNumber) })
    }
  }
  return { labels: [...latest.values()], prLinks: [...prs.values()] }
}

/** Pi: the user-set name from the last `session_info` record (set with /name). */
export function parsePiLabels(path: string): ParsedLabels {
  let sessionId: string | null = null
  let name: string | null = null
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    if (!text) continue
    let d: unknown
    try { d = JSON.parse(text) } catch { continue }
    if (!isObj(d)) continue
    if (d.type === 'session') sessionId = str(d.id)
    else if (d.type === 'session_info') name = str(d.name) ?? name
  }
  if (sessionId === null || name === null) return { labels: [], prLinks: [] }
  return { labels: [{ tool: 'pi', sessionId, kind: 'custom_title', value: name }], prLinks: [] }
}

/** OpenCode puts this placeholder in the title until it has generated a real one. */
const PLACEHOLDER = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/

function titlesOf(db: DatabaseSync, table: string): Array<{ id: string; title: string }> {
  try {
    return db.prepare(`SELECT id, title FROM ${table}`).all() as unknown as Array<{ id: string; title: string }>
  } catch (e) {
    if (e instanceof Error && /no such (table|column)/.test(e.message)) return []
    throw e
  }
}

/** OpenCode: each session's title, skipping placeholders. A session_v2 row wins over the legacy session table. */
export function readOpenCodeLabels(dbPath: string): ParsedLabels {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const byId = new Map<string, string>()
    for (const r of [...titlesOf(db, 'session'), ...titlesOf(db, 'session_v2')]) {
      const title = str(r.title)
      if (title !== null && !PLACEHOLDER.test(title)) byId.set(r.id, title)
    }
    return { labels: [...byId].map(([sessionId, value]) => ({ tool: 'opencode' as const, sessionId, kind: 'tool_title' as const, value })), prLinks: [] }
  } finally {
    db.close()
  }
}

/** Write labels and PR links. Idempotent; a label's recorded_at moves only when its value changes. */
export function storeLabels(db: LedgerDb, parsed: ParsedLabels, now: string): void {
  db.transaction(() => {
    const label = db.raw.prepare(`INSERT INTO session_labels (tool, source_session_id, kind, value, recorded_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tool, source_session_id, kind) DO UPDATE SET value = excluded.value, recorded_at = excluded.recorded_at
      WHERE session_labels.value <> excluded.value`)
    for (const l of parsed.labels) label.run(l.tool, l.sessionId, l.kind, l.value, now)
    const pr = db.raw.prepare('INSERT OR IGNORE INTO session_pr_links (tool, source_session_id, url, repository, number, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const p of parsed.prLinks) pr.run(p.tool, p.sessionId, p.url, p.repository, p.number, now)
  })
}

export type LabelSources = { claudeProjectsDir: string | null; piSessionsDir: string | null; opencodeDb: string | null }

/**
 * Capture labels from every source. Claude and Pi files are read once and again only when they change (tracked in
 * label_scans, separate from the message scan so existing transcripts are covered). OpenCode is re-read each run.
 * A failure on one source is reported and never stops the others.
 */
export async function importLabels(db: LedgerDb, sources: LabelSources, now: string, errors: string[]): Promise<void> {
  // The message scan already reports a file it cannot read as `<path>: ...`; do not report the same file twice.
  const report = (path: string, e: unknown): void => {
    if (errors.some(x => x.startsWith(`${path}:`))) return
    errors.push(`labels ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const files = async (tool: Tool, dir: string | null, parse: (path: string) => Promise<ParsedLabels> | ParsedLabels): Promise<void> => {
    if (dir === null) return
    const seen = db.raw.prepare('SELECT size, mtime_ms FROM label_scans WHERE path = ?')
    for (const f of listJsonl(dir)) {
      const prev = seen.get(f.path) as { size: number; mtime_ms: number } | undefined
      if (prev && prev.size === f.size && prev.mtime_ms === f.mtime) continue
      try {
        const parsed = await parse(f.path)
        db.transaction(() => {
          storeLabels(db, parsed, now)
          db.raw.prepare(`INSERT INTO label_scans (path, tool, size, mtime_ms) VALUES (?, ?, ?, ?)
            ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`).run(f.path, tool, f.size, f.mtime)
        })
      } catch (e) {
        report(f.path, e)
      }
    }
  }
  await files('claude-code', sources.claudeProjectsDir, parseClaudeLabels)
  await files('pi', sources.piSessionsDir, parsePiLabels)
  if (sources.opencodeDb !== null && existsSync(sources.opencodeDb)) {
    try {
      storeLabels(db, readOpenCodeLabels(sources.opencodeDb), now)
    } catch (e) {
      report(sources.opencodeDb, e)
    }
  }
}
