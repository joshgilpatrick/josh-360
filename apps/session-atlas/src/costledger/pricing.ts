import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LedgerDb } from './db.ts'
import type { PricingStatus } from './types.ts'

export const SEED_PATH = fileURLToPath(new URL('./seed/price-seed.json', import.meta.url))

type SeedTier = { minPromptTokens: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite5m: number | null; cacheWrite1h: number | null }
type Seed = {
  effectiveFrom: string
  models: Array<{ modelId: string; vendor: string; effectiveFrom?: string; effectiveTo?: string; sourceNote: string; tiers: SeedTier[]; dated?: Array<{ effectiveFrom: string; effectiveTo?: string; sourceNote: string; tiers: SeedTier[] }> }>
  aliases: Array<{ alias: string; modelId: string; sourceNote: string }>
}

const SEED_CLASSES = [
  ['input', 'input'], ['output', 'output'], ['cache_read', 'cacheRead'], ['cache_write_5m', 'cacheWrite5m'], ['cache_write_1h', 'cacheWrite1h'],
] as const

export function seedPrices(db: LedgerDb, seedPath: string, now: string): number {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed
  const insModel = db.raw.prepare('INSERT OR IGNORE INTO models (model_id, vendor) VALUES (?, ?)')
  const insAlias = db.raw.prepare('INSERT OR IGNORE INTO model_aliases (alias, model_id, source_note) VALUES (?, ?, ?)')
  const insPrice = db.raw.prepare('INSERT OR IGNORE INTO prices (model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, effective_to, source_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  return db.transaction(() => {
    let inserted = 0
    for (const m of seed.models) {
      insModel.run(m.modelId, m.vendor)
      const rows = [{ effectiveFrom: m.effectiveFrom ?? seed.effectiveFrom, effectiveTo: m.effectiveTo ?? null, sourceNote: m.sourceNote, tiers: m.tiers }, ...(m.dated ?? [])]
      for (const r of rows) {
        for (const t of r.tiers) {
          for (const [cls, field] of SEED_CLASSES) {
            const rate = t[field]
            if (rate === null) continue
            inserted += Number(insPrice.run(m.modelId, cls, t.minPromptTokens, rate, r.effectiveFrom, r.effectiveTo ?? null, r.sourceNote, now).changes)
          }
        }
      }
    }
    for (const a of seed.aliases) insAlias.run(a.alias, a.modelId, a.sourceNote)
    return inserted
  })
}

export function addPrice(
  db: LedgerDb,
  p: { modelId: string; tokenClass: string; minPromptTokens: number; usdPerMillion: number; effectiveFrom: string; sourceNote: string },
  now: string,
): void {
  db.transaction(() => {
    const open = db.raw.prepare('SELECT id, effective_from FROM prices WHERE model_id = ? AND token_class = ? AND min_prompt_tokens = ? AND effective_to IS NULL')
      .get(p.modelId, p.tokenClass, p.minPromptTokens) as { id: number; effective_from: string } | undefined
    if (open) {
      if (open.effective_from >= p.effectiveFrom) throw new Error('effectiveFrom must be later than the current price row')
      db.raw.prepare('UPDATE prices SET effective_to = ? WHERE id = ?').run(p.effectiveFrom, open.id)
    }
    db.raw.prepare('INSERT INTO prices (model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, source_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.modelId, p.tokenClass, p.minPromptTokens, p.usdPerMillion, p.effectiveFrom, p.sourceNote, now)
  })
}

const PREFIXES = ['azure_ai/', 'azure/', 'anthropic/', 'openai/']

export function normalizeModelName(raw: string): string {
  let s = raw.trim().toLowerCase()
  for (const p of PREFIXES) {
    if (s.startsWith(p)) { s = s.slice(p.length); break }
  }
  return s
}

/** Registers a model so prices can be added for it. The id is stored in lookup form (what resolveModel searches for); returns it. */
export function addModel(db: LedgerDb, m: { modelId: string; vendor: string }): string {
  const id = normalizeModelName(m.modelId)
  const vendor = m.vendor.trim()
  if (id === '') throw new Error('model id is required')
  if (vendor === '') throw new Error('vendor is required')
  return db.transaction(() => {
    if (db.raw.prepare('SELECT 1 AS x FROM models WHERE model_id = ?').get(id)) throw new Error(`${id} is already a model`)
    if (db.raw.prepare('SELECT 1 AS x FROM model_aliases WHERE alias = ?').get(id)) throw new Error(`${id} is already an alias; a name cannot be both`)
    db.raw.prepare('INSERT INTO models (model_id, vendor) VALUES (?, ?)').run(id, vendor)
    return id
  })
}

/** Points another spelling of a model name at a model that already exists. The alias is stored in lookup form; returns it. */
export function addAlias(db: LedgerDb, a: { alias: string; modelId: string; sourceNote: string }): string {
  const alias = normalizeModelName(a.alias)
  const modelId = normalizeModelName(a.modelId)
  if (alias === '') throw new Error('alias is required')
  return db.transaction(() => {
    if (!db.raw.prepare('SELECT 1 AS x FROM models WHERE model_id = ?').get(modelId)) throw new Error(`unknown model ${modelId}`)
    if (db.raw.prepare('SELECT 1 AS x FROM models WHERE model_id = ?').get(alias)) throw new Error(`${alias} is already a model; a name cannot be both`)
    if (db.raw.prepare('SELECT 1 AS x FROM model_aliases WHERE alias = ?').get(alias)) throw new Error(`${alias} is already an alias`)
    db.raw.prepare('INSERT INTO model_aliases (alias, model_id, source_note) VALUES (?, ?, ?)').run(alias, modelId, a.sourceNote)
    return alias
  })
}

export function resolveModel(db: LedgerDb, raw: string): string | null {
  const name = normalizeModelName(raw)
  const direct = db.raw.prepare('SELECT model_id FROM models WHERE model_id = ?').get(name) as { model_id: string } | undefined
  if (direct) return direct.model_id
  const alias = db.raw.prepare('SELECT model_id FROM model_aliases WHERE alias = ?').get(name) as { model_id: string } | undefined
  return alias ? alias.model_id : null
}

export type PricingRunResult = { runId: number; counts: Record<PricingStatus, number>; changed: number }

type PriceRow = { id: number; min_prompt_tokens: number; usd_per_million: number; effective_from: string; effective_to: string | null }
type MsgRow = {
  id: number; ts_utc: string; model_raw: string; usage_status: string; suspect: number
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null
  cache_write_5m_tokens: number | null; cache_write_1h_tokens: number | null; cache_write_unclassified_tokens: number | null
}

function loadPrices(db: LedgerDb): Map<string, PriceRow[]> {
  const table = new Map<string, PriceRow[]>()
  const rows = db.raw.prepare('SELECT id, model_id, token_class, min_prompt_tokens, usd_per_million, effective_from, effective_to FROM prices ORDER BY min_prompt_tokens DESC').all() as Array<PriceRow & { model_id: string; token_class: string }>
  for (const r of rows) {
    const key = `${r.model_id}|${r.token_class}`
    const list = table.get(key) ?? []
    list.push(r)
    table.set(key, list)
  }
  return table
}

function rateFor(table: Map<string, PriceRow[]>, model: string, cls: string, ts: string, prompt: number): PriceRow | null {
  for (const r of table.get(`${model}|${cls}`) ?? []) {
    if (r.min_prompt_tokens <= prompt && r.effective_from <= ts && (r.effective_to === null || ts < r.effective_to)) return r
  }
  return null
}

type StoredCost = { model_id: string | null; computed_cost_usd: number | null; price_ids: string | null; pricing_status: string }

/** Prices every message, but writes a cost row only where the result differs from the message's most recent row. `counts` always covers every message; `changed` is the rows written. */
export function runPricing(db: LedgerDb, now: string, note = ''): PricingRunResult {
  const counts: Record<PricingStatus, number> = { priced: 0, missing_price: 0, missing_alias: 0, suspect: 0, no_usage: 0 }
  let changed = 0
  return db.transaction(() => {
    const table = loadPrices(db)
    const modelCache = new Map<string, string | null>()
    const runId = Number(db.raw.prepare('INSERT INTO pricing_runs (started_at, note) VALUES (?, ?)').run(now, note).lastInsertRowid)
    const select = db.raw.prepare('SELECT id, ts_utc, model_raw, usage_status, suspect, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unclassified_tokens FROM messages WHERE id > ? ORDER BY id LIMIT 5000')
    const insert = db.raw.prepare('INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, price_ids, pricing_status) VALUES (?, ?, ?, ?, ?, ?)')
    const latest = db.raw.prepare('SELECT model_id, computed_cost_usd, price_ids, pricing_status FROM latest_message_costs WHERE message_id = ?')
    let lastId = 0
    for (;;) {
      const chunk = select.all(lastId) as unknown as MsgRow[]
      if (chunk.length === 0) break
      for (const m of chunk) {
        lastId = m.id
        let status: PricingStatus
        let modelId: string | null = null
        let cost: number | null = null
        let priceIds: string | null = null
        if (m.usage_status === 'no_usage' || (m.input_tokens === null && m.output_tokens === null)) {
          status = 'no_usage'
        } else if (m.suspect === 1) {
          status = 'suspect'
        } else {
          if (!modelCache.has(m.model_raw)) modelCache.set(m.model_raw, resolveModel(db, m.model_raw))
          modelId = modelCache.get(m.model_raw) ?? null
          if (modelId === null) {
            status = 'missing_alias'
          } else {
            const w5 = (m.cache_write_5m_tokens ?? 0) + (m.cache_write_unclassified_tokens ?? 0)
            const w1 = m.cache_write_1h_tokens ?? 0
            const prompt = (m.input_tokens ?? 0) + (m.cache_read_tokens ?? 0) + (m.cache_write_5m_tokens ?? 0) + w1 + (m.cache_write_unclassified_tokens ?? 0)
            const parts: Array<[string, number]> = [
              ['input', m.input_tokens ?? 0], ['output', m.output_tokens ?? 0], ['cache_read', m.cache_read_tokens ?? 0],
              ['cache_write_5m', w5], ['cache_write_1h', w1],
            ]
            let total = 0
            let missing = false
            const used: number[] = []
            for (const [cls, tokens] of parts) {
              if (tokens <= 0) continue
              const rate = rateFor(table, modelId, cls, m.ts_utc, prompt)
              if (rate === null) { missing = true; break }
              total += tokens * rate.usd_per_million
              used.push(rate.id)
            }
            if (missing) status = 'missing_price'
            else { status = 'priced'; cost = total / 1_000_000; priceIds = JSON.stringify(used.sort((a, b) => a - b)) }
          }
        }
        counts[status] += 1
        const prev = latest.get(m.id) as StoredCost | undefined
        if (prev && prev.pricing_status === status && prev.model_id === modelId && prev.computed_cost_usd === cost && prev.price_ids === priceIds) continue
        insert.run(runId, m.id, modelId, cost, priceIds, status)
        changed += 1
      }
    }
    return { runId, counts, changed }
  })
}
