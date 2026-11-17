import { DatabaseSync } from 'node:sqlite'
import { OPENCODE_COST_CUTOFF_MS } from './constants.ts'
import type { ParsedMessage } from './types.ts'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

type Row = { id: string; session_id: string; time_created: number; data: string; directory: string | null; parent_id: string | null }

const V2_SQL = `SELECT s.id, s.session_id, s.time_created, s.data, v.directory, v.parent_id
  FROM session_message s LEFT JOIN session_v2 v ON v.id = s.session_id WHERE s.type = 'assistant'`
const LEGACY_SQL = `SELECT m.id, m.session_id, m.time_created, m.data, s.directory, s.parent_id
  FROM message m LEFT JOIN session s ON s.id = m.session_id WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'assistant'`

function rowsOf(db: DatabaseSync, sql: string): Row[] {
  try {
    return db.prepare(sql).all() as unknown as Row[]
  } catch (e) {
    if (e instanceof Error && /no such (table|column)/.test(e.message)) return []
    throw e
  }
}

function convert(row: Row, legacy: boolean, dbPath: string, nowMs: number): ParsedMessage | null {
  let d: unknown
  try { d = JSON.parse(row.data) } catch { return null }
  if (!isObj(d)) return null
  const time = isObj(d.time) ? num(d.time.created) : null
  const ms = time ?? row.time_created
  if (ms < OPENCODE_COST_CUTOFF_MS || ms > nowMs + 86_400_000) return null
  const model = legacy ? str(d.modelID) : isObj(d.model) ? str(d.model.id) : null
  if (model === null) return null
  const provider = legacy ? str(d.providerID) : isObj(d.model) ? str(d.model.providerID) : null
  const pathCwd = legacy && isObj(d.path) ? str(d.path.cwd) : null
  const t = isObj(d.tokens) ? d.tokens : null
  const cache = t && isObj(t.cache) ? t.cache : null
  const reasoning = t ? num(t.reasoning) : null
  const out = t ? num(t.output) : null
  return {
    tool: 'opencode', sourceMessageId: row.id, sourceSessionId: row.session_id, tsUtc: new Date(ms).toISOString(),
    modelRaw: model, providerRaw: provider,
    inputTokens: t ? num(t.input) : null,
    outputTokens: t && out !== null ? out + (reasoning ?? 0) : null,
    reasoningTokens: reasoning,
    cacheReadTokens: cache ? num(cache.read) : null,
    cacheWrite5mTokens: null, cacheWrite1hTokens: null,
    cacheWriteUnclassifiedTokens: cache ? num(cache.write) : null,
    loggedCostUsd: num(d.cost),
    isSidechain: row.parent_id !== null && row.parent_id !== undefined,
    cwd: pathCwd ?? str(row.directory), gitBranch: null,
    sourcePath: dbPath, sourceLocator: `row:${row.id}`,
    usageStatus: t ? 'ok' : 'no_usage',
  }
}

export function readOpenCode(dbPath: string, nowMs: number = Date.now()): ParsedMessage[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const byKey = new Map<string, ParsedMessage>()
    const keyOf = (r: Row): string => JSON.stringify([r.session_id, r.id])
    for (const r of rowsOf(db, V2_SQL)) {
      const m = convert(r, false, dbPath, nowMs)
      if (m) byKey.set(keyOf(r), m)
    }
    for (const r of rowsOf(db, LEGACY_SQL)) {
      if (byKey.has(keyOf(r))) continue
      const m = convert(r, true, dbPath, nowMs)
      if (m) byKey.set(keyOf(r), m)
    }
    return [...byKey.values()]
  } finally {
    db.close()
  }
}

export type OpenCodeSession = { sessionId: string; parentSessionId: string | null; forkSessionId: string | null }

type SessionRow = { id: string; parent_id: string | null; fork_session_id: string | null }

function sessionsOf(db: DatabaseSync, sql: string): SessionRow[] {
  try {
    return db.prepare(sql).all() as unknown as SessionRow[]
  } catch (e) {
    if (e instanceof Error && /no such (table|column)/.test(e.message)) return []
    throw e
  }
}

export function readOpenCodeSessions(dbPath: string): OpenCodeSession[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    let hasFork = false
    try {
      hasFork = (db.prepare('PRAGMA table_info(session_v2)').all() as unknown as Array<{ name: string }>)
        .some(c => c.name === 'fork_session_id')
    } catch { hasFork = false }
    const fork = hasFork ? 'fork_session_id' : 'NULL AS fork_session_id'
    const seen = new Set<string>()
    const out: OpenCodeSession[] = []
    const rows = [
      ...sessionsOf(db, `SELECT id, parent_id, ${fork} FROM session_v2 ORDER BY rowid`),
      ...sessionsOf(db, 'SELECT id, parent_id, NULL AS fork_session_id FROM session ORDER BY rowid'),
    ]
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push({ sessionId: r.id, parentSessionId: str(r.parent_id), forkSessionId: str(r.fork_session_id) })
    }
    return out
  } finally {
    db.close()
  }
}
