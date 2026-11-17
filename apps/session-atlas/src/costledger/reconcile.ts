import type { LedgerDb } from './db.ts'

export const VIRTUAL_KEY_BY_TOOL: Record<string, string> = { 'claude-code': 'claude-code-cli', opencode: 'opencode', pi: 'pi' }
export const ACCEPTANCE_KEYS = ['claude-code-cli', 'opencode', 'pi']
export const DEFAULT_TOLERANCE = 0.1

const MODEL_GROUPS: Record<string, string> = { 'gpt-5.6-luna': 'gpt-6-luna' }
const PREFIXES = ['azure_ai/', 'azure/', 'anthropic/', 'openai/']
const WEEK_MS = 7 * 24 * 3600 * 1000

export type BifrostWeekRow = {
  week: string; virtualKey: string; model: string; costUsd: number; requests: number; failures: number
  promptTokens: number; outputTokens: number
}
export type LedgerWeekRow = {
  week: string; virtualKey: string; modelGroup: string; costUsd: number; messages: number; unpricedMessages: number; suspectMessages: number
  promptTokens: number; outputTokens: number
}
export type WeekComparison = {
  week: string; virtualKey: string; modelGroup: string
  ledgerCostUsd: number; bifrostCostUsd: number; diffUsd: number; diffPct: number | null
  ledgerMessages: number; unpricedMessages: number; suspectMessages: number; bifrostRequests: number; bifrostFailures: number
  ledgerPromptTokens: number; bifrostPromptTokens: number; ledgerOutputTokens: number; bifrostOutputTokens: number
  promptTokenDiffPct: number | null; outputTokenDiffPct: number | null
  complete: boolean; withinTolerance: boolean
}
export type GapModel = { modelGroup: string; diffUsd: number }
export type AcceptanceWeek = {
  week: string
  sessionAttributedUsd: number
  bifrostCostUsd: number
  unattributedRemainderUsd: number
  diffPct: number | null
  pass: boolean
  unpricedMessages: number
  suspectMessages: number
  gapModels: GapModel[]
}
export type KeyAcceptance = { virtualKey: string; status: 'PASS' | 'FAIL' | 'NOT_EVALUATED'; weeks: AcceptanceWeek[]; evaluatedWeeks: number }
export type Acceptance = { keys: KeyAcceptance[]; allPass: boolean }

export function modelGroup(raw: string): string {
  let s = raw.trim().toLowerCase()
  for (const p of PREFIXES) {
    if (s.startsWith(p)) { s = s.slice(p.length); break }
  }
  return MODEL_GROUPS[s] ?? s
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byKey = (a: { week: string; virtualKey: string; modelGroup: string }, b: { week: string; virtualKey: string; modelGroup: string }): number =>
  cmp(a.week, b.week) || cmp(a.virtualKey, b.virtualKey) || cmp(a.modelGroup, b.modelGroup)
const pctOf = (ledger: number, bifrost: number): number | null => (bifrost > 0 ? (ledger - bifrost) / bifrost : null)
const within = (diffPct: number | null, ledger: number, tolerance: number): boolean =>
  diffPct === null ? ledger === 0 : Math.abs(diffPct) <= tolerance + 1e-9

/** Earliest message timestamp per Bifrost virtual key (a tool's data can start later than another's). */
export function firstTsByKey(db: LedgerDb): Record<string, string> {
  const rows = db.raw.prepare('SELECT tool, MIN(ts_utc) AS t FROM messages GROUP BY tool').all() as Array<{ tool: string; t: string }>
  const out: Record<string, string> = {}
  for (const r of rows) out[VIRTUAL_KEY_BY_TOOL[r.tool] ?? r.tool] = r.t
  return out
}

const PROMPT_SQL = 'COALESCE(m.input_tokens,0) + COALESCE(m.cache_read_tokens,0) + COALESCE(m.cache_write_5m_tokens,0) + COALESCE(m.cache_write_1h_tokens,0) + COALESCE(m.cache_write_unclassified_tokens,0)'
const COUNTED = "(c.pricing_status IS NULL OR c.pricing_status IN ('priced','missing_price','missing_alias'))"
const WEEKLY_SQL = `SELECT date(substr(m.ts_utc, 1, 10), '-6 days', 'weekday 1') AS week, m.tool AS tool,
    COALESCE(c.model_id, m.model_raw) AS model,
    SUM(CASE WHEN c.pricing_status = 'priced' THEN c.computed_cost_usd ELSE 0 END) AS cost,
    SUM(CASE WHEN c.pricing_status = 'priced' THEN 1 ELSE 0 END) AS priced,
    SUM(CASE WHEN c.pricing_status IS NULL OR c.pricing_status IN ('missing_price','missing_alias') THEN 1 ELSE 0 END) AS unpriced,
    SUM(CASE WHEN c.pricing_status = 'suspect' THEN 1 ELSE 0 END) AS suspect_n,
    SUM(CASE WHEN ${COUNTED} THEN ${PROMPT_SQL} ELSE 0 END) AS prompt,
    SUM(CASE WHEN ${COUNTED} THEN COALESCE(m.output_tokens,0) ELSE 0 END) AS output
  FROM messages m LEFT JOIN latest_message_costs c ON c.message_id = m.id
  GROUP BY week, tool, model HAVING priced + unpriced + suspect_n > 0`

export function ledgerWeekly(db: LedgerDb): LedgerWeekRow[] {
  const rows = db.raw.prepare(WEEKLY_SQL).all() as unknown as Array<{ week: string; tool: string; model: string; cost: number; priced: number; unpriced: number; suspect_n: number; prompt: number; output: number }>
  const merged = new Map<string, LedgerWeekRow>()
  for (const r of rows) {
    const virtualKey = VIRTUAL_KEY_BY_TOOL[r.tool] ?? r.tool
    const group = modelGroup(r.model)
    const key = `${r.week}|${virtualKey}|${group}`
    const cur = merged.get(key) ?? { week: r.week, virtualKey, modelGroup: group, costUsd: 0, messages: 0, unpricedMessages: 0, suspectMessages: 0, promptTokens: 0, outputTokens: 0 }
    cur.costUsd += Number(r.cost)
    cur.messages += Number(r.priced)
    cur.unpricedMessages += Number(r.unpriced)
    cur.suspectMessages += Number(r.suspect_n)
    cur.promptTokens += Number(r.prompt)
    cur.outputTokens += Number(r.output)
    merged.set(key, cur)
  }
  return [...merged.values()].sort(byKey)
}

export function isCompleteWeek(week: string, nowIso: string, firstTsIso: string | null): boolean {
  if (firstTsIso === null) return false
  const start = Date.parse(`${week}T00:00:00.000Z`)
  return start >= Date.parse(firstTsIso) && start + WEEK_MS <= Date.parse(nowIso)
}

export function compareWeeks(
  ledger: LedgerWeekRow[],
  bifrost: BifrostWeekRow[],
  opts: { nowIso: string; firstTsByKey: Record<string, string>; tolerance?: number },
): WeekComparison[] {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE
  const keyOf = (week: string, vk: string, group: string) => `${week}|${vk}|${group}`
  type Bif = { week: string; virtualKey: string; modelGroup: string; cost: number; requests: number; failures: number; prompt: number; output: number }
  const bif = new Map<string, Bif>()
  for (const b of bifrost) {
    const group = modelGroup(b.model)
    const k = keyOf(b.week, b.virtualKey, group)
    const cur = bif.get(k) ?? { week: b.week, virtualKey: b.virtualKey, modelGroup: group, cost: 0, requests: 0, failures: 0, prompt: 0, output: 0 }
    cur.cost += b.costUsd
    cur.requests += b.requests
    cur.failures += b.failures
    cur.prompt += b.promptTokens
    cur.output += b.outputTokens
    bif.set(k, cur)
  }
  const led = new Map<string, LedgerWeekRow>()
  for (const l of ledger) led.set(keyOf(l.week, l.virtualKey, l.modelGroup), l)
  const keys = new Set([...bif.keys(), ...led.keys()])
  const out: WeekComparison[] = []
  for (const k of keys) {
    const l = led.get(k)
    const b = bif.get(k)
    const base = l ?? b
    if (!base) continue
    const ledgerCost = l?.costUsd ?? 0
    const bifrostCost = b?.cost ?? 0
    const diffPct = pctOf(ledgerCost, bifrostCost)
    const lp = l?.promptTokens ?? 0
    const bp = b?.prompt ?? 0
    const lo = l?.outputTokens ?? 0
    const bo = b?.output ?? 0
    out.push({
      week: base.week,
      virtualKey: base.virtualKey,
      modelGroup: l ? l.modelGroup : (b?.modelGroup ?? ''),
      ledgerCostUsd: ledgerCost,
      bifrostCostUsd: bifrostCost,
      diffUsd: ledgerCost - bifrostCost,
      diffPct,
      ledgerMessages: l?.messages ?? 0,
      unpricedMessages: l?.unpricedMessages ?? 0,
      suspectMessages: l?.suspectMessages ?? 0,
      bifrostRequests: b?.requests ?? 0,
      bifrostFailures: b?.failures ?? 0,
      ledgerPromptTokens: lp,
      bifrostPromptTokens: bp,
      ledgerOutputTokens: lo,
      bifrostOutputTokens: bo,
      promptTokenDiffPct: pctOf(lp, bp),
      outputTokenDiffPct: pctOf(lo, bo),
      complete: isCompleteWeek(base.week, opts.nowIso, opts.firstTsByKey[base.virtualKey] ?? null),
      withinTolerance: within(diffPct, ledgerCost, tolerance),
    })
  }
  return out.sort(byKey)
}

/**
 * Per key: every complete week, ledger ("session-attributed") vs Bifrost cost summed over model groups.
 * A key with no complete week is NOT_EVALUATED; allPass needs every key to PASS.
 */
export function acceptance(rows: WeekComparison[], keys: string[] = ACCEPTANCE_KEYS, tolerance: number = DEFAULT_TOLERANCE): Acceptance {
  const result: KeyAcceptance[] = keys.map(virtualKey => {
    const byWeek = new Map<string, { ledger: number; bifrost: number; unpriced: number; suspect: number; models: GapModel[] }>()
    for (const r of rows) {
      if (r.virtualKey !== virtualKey || !r.complete) continue
      const cur = byWeek.get(r.week) ?? { ledger: 0, bifrost: 0, unpriced: 0, suspect: 0, models: [] }
      cur.ledger += r.ledgerCostUsd
      cur.unpriced += r.unpricedMessages
      cur.suspect += r.suspectMessages
      cur.bifrost += r.bifrostCostUsd
      if (r.diffUsd !== 0) cur.models.push({ modelGroup: r.modelGroup, diffUsd: r.diffUsd })
      byWeek.set(r.week, cur)
    }
    const weeks = [...byWeek.entries()]
      .sort(([a], [b]) => cmp(a, b))
      .map(([week, v]): AcceptanceWeek => {
        const diffPct = pctOf(v.ledger, v.bifrost)
        const pass = within(diffPct, v.ledger, tolerance)
        const gapModels = pass ? [] : v.models.sort((a, b) => Math.abs(b.diffUsd) - Math.abs(a.diffUsd) || cmp(a.modelGroup, b.modelGroup))
        return { week, sessionAttributedUsd: v.ledger, bifrostCostUsd: v.bifrost, unattributedRemainderUsd: v.bifrost - v.ledger, diffPct, pass, unpricedMessages: v.unpriced, suspectMessages: v.suspect, gapModels }
      })
    const status = weeks.length === 0 ? 'NOT_EVALUATED' : weeks.every(w => w.pass) ? 'PASS' : 'FAIL'
    return { virtualKey, status, weeks, evaluatedWeeks: weeks.length }
  })
  return { keys: result, allPass: result.length > 0 && result.every(k => k.status === 'PASS') }
}
