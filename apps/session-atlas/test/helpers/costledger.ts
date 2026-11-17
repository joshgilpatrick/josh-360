import { openLedger } from '../../src/costledger/db.ts'
import type { LedgerDb } from '../../src/costledger/db.ts'

/** Fixed clock for tests; pass wherever a function takes `now`. */
export const FIXED_NOW = '2026-10-02T00:00:00.000Z'

export function openTestLedger(): LedgerDb {
  return openLedger(':memory:')
}

export type TestMessageRow = {
  tool: string
  source_message_id: string
  source_session_id: string | null
  source_agent_id?: string | null
  ts_utc: string
  model_raw: string
  provider_raw: string | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_write_5m_tokens: number | null
  cache_write_1h_tokens: number | null
  cache_write_unclassified_tokens: number | null
  logged_cost_usd: number | null
  is_sidechain: number
  cwd: string | null
  git_branch: string | null
  repo_key: string | null
  worktree_path: string | null
  attribution_quality: string
  usage_status: string
  suspect: number
  source_path: string
  source_locator: string
}

/** Insert one messages row with sensible defaults; returns its id. Every column can be overridden. */
export function insertTestMessage(db: LedgerDb, overrides: Partial<TestMessageRow> = {}): number {
  const row: TestMessageRow = {
    tool: 'claude-code', source_message_id: 'msg_1', source_session_id: 's1', source_agent_id: null, ts_utc: '2026-09-30T12:00:00.000Z',
    model_raw: 'claude-sonnet-5', provider_raw: null,
    input_tokens: 1000, output_tokens: 100, reasoning_tokens: null, cache_read_tokens: 0,
    cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_write_unclassified_tokens: 0,
    logged_cost_usd: null, is_sidechain: 0, cwd: '/r/app', git_branch: 'main', repo_key: '/r/app', worktree_path: '/r/app',
    attribution_quality: 'exact', usage_status: 'ok', suspect: 0, source_path: '/t/a.jsonl', source_locator: 'line:1',
    ...overrides,
  }
  const cols = Object.keys(row)
  const sql = `INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  const r = db.raw.prepare(sql).run(...(Object.values(row) as Array<string | number | null>))
  return Number(r.lastInsertRowid)
}

/** Insert a message plus its own holder row, as the importer does; returns the message id. */
export function insertHeldMessage(db: LedgerDb, overrides: Partial<TestMessageRow> = {}): number {
  const id = insertTestMessage(db, overrides)
  const r = db.raw.prepare("SELECT COALESCE(source_session_id, '') AS s, COALESCE(source_agent_id, '') AS a FROM messages WHERE id = ?").get(id) as { s: string; a: string }
  db.raw.prepare('INSERT OR IGNORE INTO message_holders (message_id, source_session_id, source_agent_id) VALUES (?, ?, ?)').run(id, r.s, r.a)
  return id
}

/** One pricing run that writes the given cost rows; returns the run id. */
export function priceMessages(db: LedgerDb, entries: Array<{ id: number; status: string; cost: number | null; modelId?: string }>): number {
  const run = Number(db.raw.prepare("INSERT INTO pricing_runs (started_at, note) VALUES (?, '')").run(FIXED_NOW).lastInsertRowid)
  const ins = db.raw.prepare('INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) VALUES (?, ?, ?, ?, ?)')
  for (const e of entries) ins.run(run, e.id, e.modelId ?? null, e.cost, e.status)
  return run
}

/** A finished import run; returns its id. */
export function finishImport(db: LedgerDb, at = FIXED_NOW): number {
  return Number(db.raw.prepare('INSERT INTO import_runs (started_at, finished_at) VALUES (?, ?)').run(at, at).lastInsertRowid)
}
