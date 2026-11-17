import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ParsedMessage } from './types.ts'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const branchOf = (v: unknown): string | null => {
  const s = str(v)
  return s === null || s === 'HEAD' ? null : s
}

function cacheSplit(u: Json): { w5: number | null; w1: number | null; rest: number | null } {
  const total = num(u.cache_creation_input_tokens)
  const cc = u.cache_creation
  if (isObj(cc)) {
    const w5 = num(cc.ephemeral_5m_input_tokens) ?? 0
    const w1 = num(cc.ephemeral_1h_input_tokens) ?? 0
    return { w5, w1, rest: total === null ? 0 : Math.max(total - w5 - w1, 0) }
  }
  return { w5: null, w1: null, rest: total }
}

type Base = Pick<ParsedMessage, 'sourceSessionId' | 'sourceAgentId' | 'tsUtc' | 'isSidechain' | 'cwd' | 'gitBranch' | 'sourcePath' | 'sourceLocator'>

function build(id: string, model: string, u: Json, base: Base): ParsedMessage {
  const { w5, w1, rest } = cacheSplit(u)
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : null
  return {
    tool: 'claude-code', sourceMessageId: id, providerRaw: null, modelRaw: model,
    inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens),
    reasoningTokens: details ? num(details.thinking_tokens) : null,
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWrite5mTokens: w5, cacheWrite1hTokens: w1, cacheWriteUnclassifiedTokens: rest,
    loggedCostUsd: null, usageStatus: 'ok', ...base,
  }
}

export type SpawnLink = { sessionId: string; ownerAgentId: string; toolUseId: string }

export async function* parseClaudeFile(path: string, onSpawn?: (s: SpawnLink) => void): AsyncGenerator<ParsedMessage> {
  const pathSidechain = path.includes('/subagents/')
  const parts = path.split('/')
  const subIdx = parts.lastIndexOf('subagents')
  const pathSessionId = subIdx > 0 ? str(parts[subIdx - 1]) : null
  const fileAgentId = pathSessionId === null ? null : (/^agent-(.+)\.jsonl$/.exec(parts[parts.length - 1] ?? '')?.[1] ?? null)
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const text of rl) {
    n += 1
    const hasToolUse = text.includes('"tool_use"')
    if (!hasToolUse && !text.includes('"usage"')) continue
    let d: unknown
    try { d = JSON.parse(text) } catch { continue }
    if (!isObj(d)) continue
    const rowSession = str(d.sessionId) ?? pathSessionId
    const agentId = fileAgentId !== null && rowSession === pathSessionId ? fileAgentId : null
    const msg = d.message
    if (onSpawn && hasToolUse && rowSession !== null && isObj(msg) && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        const toolUseId = isObj(c) && c.type === 'tool_use' && c.name === 'Agent' ? str(c.id) : null
        if (toolUseId !== null) onSpawn({ sessionId: rowSession, ownerAgentId: agentId ?? '', toolUseId })
      }
    }
    if (!isObj(msg) || msg.role !== 'assistant' || !isObj(msg.usage)) continue
    const id = str(msg.id)
    const model = str(msg.model)
    if (id === null || model === null || model === '<synthetic>') continue
    const ts = typeof d.timestamp === 'string' ? new Date(d.timestamp) : null
    if (ts === null || Number.isNaN(ts.getTime())) continue
    const base: Base = {
      sourceSessionId: rowSession, sourceAgentId: agentId, tsUtc: ts.toISOString(), isSidechain: d.isSidechain === true || pathSidechain,
      cwd: str(d.cwd), gitBranch: branchOf(d.gitBranch), sourcePath: path, sourceLocator: `line:${n}`,
    }
    yield build(id, model, msg.usage, base)
    const iters = msg.usage.iterations
    if (Array.isArray(iters)) {
      for (let i = 0; i < iters.length; i++) {
        const it = iters[i]
        if (!isObj(it) || it.type !== 'advisor_message') continue
        const advModel = str(it.model)
        if (advModel === null) continue
        yield build(`${id}#adv${i}`, advModel, it, base)
      }
    }
  }
}
