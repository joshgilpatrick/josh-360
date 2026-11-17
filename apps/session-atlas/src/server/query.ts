// Query-string parsing shared by the read-API route handlers. Every accessor is defensive:
// a missing/blank/unparsable value falls back to `undefined` (or the stated default) rather than
// throwing, so a malformed query string degrades a filter instead of failing the whole request.
export type QueryHelpers = {
  str(name: string): string | undefined
  num(name: string): number | undefined
  int(name: string): number | undefined
  bool(name: string): boolean
  page(): { limit: number; offset: number }
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const TRUE_VALUES = new Set(['1', 'true'])

export function qs(url: URL): QueryHelpers {
  const sp = url.searchParams
  const str = (name: string): string | undefined => {
    const v = sp.get(name)
    return v && v.trim() ? v.trim() : undefined
  }
  const num = (name: string): number | undefined => {
    const raw = sp.get(name)
    if (raw === null || raw === '') return undefined
    const v = Number(raw)
    return Number.isFinite(v) ? v : undefined
  }
  // Integer-only parse for limit/offset: truncates a fractional value (e.g. "2.5") instead of
  // handing SQLite a REAL where it expects an INTEGER bind (which throws "datatype mismatch"),
  // and rejects non-finite/NaN input the same way num() does. Kept separate from num() above
  // because other callers of num() (e.g. minCost) legitimately want fractional values.
  const int = (name: string): number | undefined => {
    const v = num(name)
    return v === undefined ? undefined : Math.trunc(v)
  }
  const bool = (name: string): boolean => TRUE_VALUES.has((sp.get(name) ?? '').toLowerCase())
  const page = (): { limit: number; offset: number } => {
    const rawLimit = int('limit')
    const limit = rawLimit === undefined || rawLimit < 1 ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, rawLimit)
    const rawOffset = int('offset')
    // A huge offset (e.g. "1e21") is finite but exceeds Number.MAX_SAFE_INTEGER, which
    // better-sqlite3 refuses to bind as an integer -- cap it rather than let that throw.
    const offset = rawOffset === undefined || rawOffset < 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, rawOffset)
    return { limit, offset }
  }
  return { str, num, int, bool, page }
}
