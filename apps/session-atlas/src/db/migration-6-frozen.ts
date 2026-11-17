// Frozen copies of the helpers migrations 3 and 6 used when they shipped. The live versions were deleted with Atlas's usage
// code (spec 2026-10-06 section 7); migrations must keep producing the same schema and rows on a fresh database, so these
// never change. Only migration files may import this module.

export const EPOCH_MIN = '0000-01-01T00:00:00.000Z'

export type PricingRow = {
  provider: string; model: string; pricingVersion: string; effectiveFrom: string
  inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok: number; cacheWrite5mPerMtok: number; cacheWrite1hPerMtok: number; vendor?: string
}

export const SYNTHETIC_PRICING_ROW: PricingRow = {
  provider: 'anthropic', model: '<synthetic>', pricingVersion: 'non-billable-synthetic', effectiveFrom: EPOCH_MIN,
  inputPerMtok: 0, outputPerMtok: 0, cacheReadPerMtok: 0, cacheWrite5mPerMtok: 0, cacheWrite1hPerMtok: 0,
}

export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{8}$/, '')
}

export function vendorForModel(model: string): string {
  const m = normalizeModelId(model)
  if (m.startsWith('claude-')) return 'anthropic'
  if (m.startsWith('gpt-')) return 'openai'
  if (m.startsWith('deepseek-')) return 'deepseek'
  return 'unknown'
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const CANON = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function toUtcStart(v: string): string {
  if (DATE_ONLY.test(v)) return `${v}T00:00:00.000Z`
  if (CANON.test(v)) return v
  throw new Error(`non-canonical price start: ${v}`)
}
