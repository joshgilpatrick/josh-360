import { readFileSync } from 'node:fs'
import type { ParsedMessage } from './types.ts'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function parsePiFile(path: string): ParsedMessage[] {
  const out: ParsedMessage[] = []
  let cwd: string | null = null
  let sessionId: string | null = null
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text) continue
    let d: unknown
    try { d = JSON.parse(text) } catch { continue }
    if (!isObj(d)) continue
    if (d.type === 'session') {
      cwd = str(d.cwd)
      sessionId = str(d.id)
      continue
    }
    if (d.type !== 'message' || !isObj(d.message)) continue
    const m = d.message
    if (m.role !== 'assistant' || !isObj(m.usage)) continue
    const u = m.usage
    const id = str(d.id)
    const model = str(m.model)
    const ts = typeof d.timestamp === 'string' ? new Date(d.timestamp) : null
    if (id === null || model === null || ts === null || Number.isNaN(ts.getTime())) continue
    if (num(u.totalTokens) === 0) continue
    const noUsage = num(u.totalTokens) === null && [u.input, u.output, u.reasoning, u.cacheRead, u.cacheWrite].every(v => (num(v) ?? 0) === 0)
    const tok = (v: unknown): number | null => (noUsage ? null : num(v))
    const cost = isObj(u.cost) ? num(u.cost.total) : null
    out.push({
      tool: 'pi', sourceMessageId: id, sourceSessionId: sessionId, tsUtc: ts.toISOString(),
      modelRaw: model, providerRaw: str(m.provider),
      inputTokens: tok(u.input), outputTokens: tok(u.output), reasoningTokens: tok(u.reasoning),
      cacheReadTokens: tok(u.cacheRead), cacheWrite5mTokens: null, cacheWrite1hTokens: null,
      cacheWriteUnclassifiedTokens: tok(u.cacheWrite), loggedCostUsd: cost,
      isSidechain: false, cwd, gitBranch: null,
      sourcePath: path, sourceLocator: `line:${i + 1}`, usageStatus: noUsage ? 'no_usage' : 'ok',
    })
  }
  return out
}
