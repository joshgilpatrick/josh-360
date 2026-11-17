import type { LedgerDb } from './db.ts'

export type ReportDimension = 'repo' | 'branch' | 'worktree' | 'tool' | 'model' | 'subagent' | 'day'
export const REPORT_DIMENSIONS: ReportDimension[] = ['repo', 'branch', 'worktree', 'tool', 'model', 'subagent', 'day']

export type ReportFilter = { from?: string; to?: string }

export type ReportRow = {
  key: string
  costUsd: number
  messages: number
  pricedMessages: number
  unpricedMessages: number
  excludedMessages: number
  tokens: number
  unpricedTokens: number
}

export type UnpricedRow = { status: string; modelRaw: string; messages: number; tokens: number }

const BUCKET_SQL: Record<ReportDimension, string> = {
  repo: "COALESCE(repo_key, '(no repo)')",
  branch: "COALESCE(repo_key, '(no repo)') || ' @ ' || COALESCE(git_branch, '(no branch)')",
  worktree: "COALESCE(worktree_path, '(no worktree)')",
  tool: 'tool',
  model: 'COALESCE(cmodel, model_raw)',
  subagent: "CASE WHEN is_sidechain = 1 THEN 'subagent' ELSE 'main' END",
  day: 'substr(ts_utc, 1, 10)',
}

const TOKENS_SQL = 'COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_5m_tokens,0) + COALESCE(cache_write_1h_tokens,0) + COALESCE(cache_write_unclassified_tokens,0)'
const UNPRICED = "('missing_price','missing_alias','not_priced')"
const EXCLUDED = "('suspect','no_usage')"

/** Every message with its status/cost/model from its most recent cost row (a run writes a row only when a message's result changed). Binds: from, to. */
const BASE = `(SELECT m.*, COALESCE(c.pricing_status, 'not_priced') AS st, c.computed_cost_usd AS cost, c.model_id AS cmodel, ${TOKENS_SQL} AS tok
  FROM messages m LEFT JOIN latest_message_costs c ON c.message_id = m.id
  WHERE m.ts_utc >= ? AND m.ts_utc < ?)`

export function latestRunId(db: LedgerDb): number | null {
  const r = db.raw.prepare('SELECT MAX(id) AS id FROM pricing_runs').get() as { id: number | null } | undefined
  return r?.id ?? null
}

/** Stored ts_utc is toISOString() text; normalize bounds (Z/offset/date-only) so text comparison is correct. */
function isoBound(v: string | undefined, dflt: string): string {
  if (!v) return dflt
  const t = new Date(v)
  if (Number.isNaN(t.getTime())) throw new RangeError(`invalid date bound: ${v}`)
  return t.toISOString()
}

function binds(filter: ReportFilter): [string, string] {
  return [isoBound(filter.from, ''), isoBound(filter.to, '9999-12-31T23:59:59.999Z')]
}

export function report(db: LedgerDb, by: ReportDimension, filter: ReportFilter = {}): ReportRow[] {
  const sql = `SELECT ${BUCKET_SQL[by]} AS bucket,
    SUM(CASE WHEN st = 'priced' THEN cost ELSE 0 END) AS cost_usd,
    COUNT(*) AS messages,
    SUM(CASE WHEN st = 'priced' THEN 1 ELSE 0 END) AS priced,
    SUM(CASE WHEN st IN ${UNPRICED} THEN 1 ELSE 0 END) AS unpriced,
    SUM(CASE WHEN st IN ${EXCLUDED} THEN 1 ELSE 0 END) AS excluded,
    SUM(tok) AS tokens,
    SUM(CASE WHEN st IN ${UNPRICED} THEN tok ELSE 0 END) AS unpriced_tokens
  FROM ${BASE} GROUP BY bucket ORDER BY cost_usd DESC, bucket ASC`
  const rows = db.raw.prepare(sql).all(...binds(filter)) as unknown as Array<{
    bucket: string; cost_usd: number; messages: number; priced: number; unpriced: number; excluded: number; tokens: number; unpriced_tokens: number
  }>
  return rows.map(r => ({
    key: r.bucket,
    costUsd: Number(r.cost_usd),
    messages: Number(r.messages),
    pricedMessages: Number(r.priced),
    unpricedMessages: Number(r.unpriced),
    excludedMessages: Number(r.excluded),
    tokens: Number(r.tokens),
    unpricedTokens: Number(r.unpriced_tokens),
  }))
}

export function reportTotal(db: LedgerDb, filter: ReportFilter = {}): ReportRow {
  const total: ReportRow = { key: 'TOTAL', costUsd: 0, messages: 0, pricedMessages: 0, unpricedMessages: 0, excludedMessages: 0, tokens: 0, unpricedTokens: 0 }
  for (const r of report(db, 'tool', filter)) {
    total.costUsd += r.costUsd
    total.messages += r.messages
    total.pricedMessages += r.pricedMessages
    total.unpricedMessages += r.unpricedMessages
    total.excludedMessages += r.excludedMessages
    total.tokens += r.tokens
    total.unpricedTokens += r.unpricedTokens
  }
  return total
}

export function unpricedByModel(db: LedgerDb, filter: ReportFilter = {}): UnpricedRow[] {
  const sql = `SELECT st AS status, model_raw, COUNT(*) AS messages, SUM(tok) AS tokens
    FROM ${BASE} WHERE st IN ${UNPRICED} GROUP BY st, model_raw ORDER BY tokens DESC, model_raw ASC`
  const rows = db.raw.prepare(sql).all(...binds(filter)) as unknown as Array<{ status: string; model_raw: string; messages: number; tokens: number }>
  return rows.map(r => ({ status: r.status, modelRaw: r.model_raw, messages: Number(r.messages), tokens: Number(r.tokens) }))
}

export const LOGGED_COST_TOLERANCE = 0.1

export type LoggedVsComputedRow = { tool: string; model: string; messages: number; loggedUsd: number; computedUsd: number; diffPct: number | null; flagged: boolean }

/** Priced messages that also carry a tool-logged cost, compared per (tool, model). A big gap points at a wrong price row. */
export function loggedVsComputed(db: LedgerDb, filter: ReportFilter = {}): LoggedVsComputedRow[] {
  const sql = `SELECT tool, COALESCE(cmodel, model_raw) AS model, COUNT(*) AS messages, SUM(logged_cost_usd) AS logged, SUM(cost) AS computed
    FROM ${BASE} WHERE st = 'priced' AND logged_cost_usd IS NOT NULL GROUP BY tool, model ORDER BY tool ASC, model ASC`
  const rows = db.raw.prepare(sql).all(...binds(filter)) as unknown as Array<{ tool: string; model: string; messages: number; logged: number; computed: number }>
  return rows.map(r => {
    const loggedUsd = Number(r.logged)
    const computedUsd = Number(r.computed)
    const diffPct = loggedUsd > 0 ? (computedUsd - loggedUsd) / loggedUsd : null
    const flagged = diffPct === null ? computedUsd > 0 : Math.abs(diffPct) > LOGGED_COST_TOLERANCE + 1e-9
    return { tool: r.tool, model: r.model, messages: Number(r.messages), loggedUsd, computedUsd, diffPct, flagged }
  })
}

export type TracePrice = { id: number; modelId: string; tokenClass: string; minPromptTokens: number; usdPerMillion: number; effectiveFrom: string; effectiveTo: string | null; sourceNote: string | null }
export type TraceResult = {
  message: Record<string, string | number | null>
  runId: number | null
  status: string
  modelId: string | null
  costUsd: number | null
  prices: TracePrice[]
}

/** Every ledger row with this source message id (one per tool), with its most recent cost row (`runId` is the run that last changed it) and the exact price rows used. */
export function traceMessage(db: LedgerDb, sourceMessageId: string): TraceResult[] {
  const msgs = db.raw.prepare(`SELECT id, tool, source_message_id, source_session_id, ts_utc, model_raw, provider_raw, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unclassified_tokens, logged_cost_usd, is_sidechain,
      cwd, git_branch, repo_key, worktree_path, attribution_quality, usage_status, suspect, source_path, source_locator
    FROM messages WHERE source_message_id = ? ORDER BY tool`).all(sourceMessageId) as unknown as Array<Record<string, string | number | null>>
  const costOf = db.raw.prepare('SELECT run_id, pricing_status, model_id, computed_cost_usd, price_ids FROM latest_message_costs WHERE message_id = ?')
  const priceOf = db.raw.prepare('SELECT id, model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, effective_to, source_note FROM prices WHERE id = ?')
  return msgs.map(message => {
    const c = costOf.get(message.id as number) as { run_id: number; pricing_status: string; model_id: string | null; computed_cost_usd: number | null; price_ids: string | null } | undefined
    const ids = c?.price_ids ? (JSON.parse(c.price_ids) as number[]) : []
    const prices = ids.map(id => {
      const p = priceOf.get(id) as { id: number; model_id: string; token_class: string; min_prompt_tokens: number; usd_per_million: number; effective_from: string; effective_to: string | null; source_note: string | null }
      return { id: p.id, modelId: p.model_id, tokenClass: p.token_class, minPromptTokens: p.min_prompt_tokens, usdPerMillion: p.usd_per_million, effectiveFrom: p.effective_from, effectiveTo: p.effective_to, sourceNote: p.source_note }
    })
    return { message, runId: c?.run_id ?? null, status: c?.pricing_status ?? 'not_priced', modelId: c?.model_id ?? null, costUsd: c?.computed_cost_usd ?? null, prices }
  })
}
