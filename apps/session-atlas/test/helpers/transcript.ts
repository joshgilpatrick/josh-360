import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type Usage = { input: number; output: number; cacheRead?: number; cache5m?: number; cache1h?: number; thinking?: number }

const common = (sid: string, opts: { uuid?: string; ts?: string; cwd?: string; parentUuid?: string | null; agentId?: string } = {}) => ({
  parentUuid: opts.parentUuid ?? null, isSidechain: Boolean(opts.agentId), ...(opts.agentId ? { agentId: opts.agentId } : {}),
  uuid: opts.uuid ?? randomUUID(), timestamp: opts.ts ?? '2026-09-17T00:00:00.000Z', sessionId: sid,
  cwd: opts.cwd ?? '/Users/x/dev/keystone', version: '2.1.274', gitBranch: 'main', userType: 'external', entrypoint: 'cli',
})

export function titleLines(sid: string, t: { ai?: string; agent?: string; custom?: string }): string[] {
  const out: string[] = []
  if (t.ai) out.push(JSON.stringify({ type: 'ai-title', aiTitle: t.ai, sessionId: sid }))
  if (t.agent) out.push(JSON.stringify({ type: 'agent-name', agentName: t.agent, sessionId: sid }))
  if (t.custom) out.push(JSON.stringify({ type: 'custom-title', customTitle: t.custom, sessionId: sid }))
  return out
}

export function userLine(sid: string, text: string, opts: { uuid?: string; ts?: string; cwd?: string; agentId?: string } = {}): string {
  return JSON.stringify({ ...common(sid, opts), type: 'user', promptId: randomUUID(), message: { role: 'user', content: text } })
}

export function assistantLines(sid: string, m: { messageId: string; model: string; usage: Usage; blocks: Array<Record<string, unknown>> },
  opts: { ts?: string; cwd?: string; agentId?: string } = {}): string[] {
  const usage = {
    input_tokens: m.usage.input, output_tokens: m.usage.output,
    cache_read_input_tokens: m.usage.cacheRead ?? 0, cache_creation_input_tokens: (m.usage.cache5m ?? 0) + (m.usage.cache1h ?? 0),
    cache_creation: { ephemeral_5m_input_tokens: m.usage.cache5m ?? 0, ephemeral_1h_input_tokens: m.usage.cache1h ?? 0 },
    output_tokens_details: { thinking_tokens: m.usage.thinking ?? 0 }, service_tier: 'standard',
  }
  return m.blocks.map((block, i) => JSON.stringify({
    ...common(sid, opts), type: 'assistant', requestId: `req_${m.messageId}`, apiBlockIndex: i,
    message: { model: m.model, id: m.messageId, type: 'message', role: 'assistant', content: [block], stop_reason: null, usage },
  }))
}

export function toolResultLine(sid: string, r: { toolUseId: string; text: string; created?: boolean; filePath?: string }, opts: { agentId?: string } = {}): string {
  const toolUseResult = r.created ? { type: 'create', filePath: r.filePath, content: r.text } : r.text
  return JSON.stringify({ ...common(sid, opts), type: 'user', message: { role: 'user', content: [{ tool_use_id: r.toolUseId, type: 'tool_result', content: r.text }] }, toolUseResult })
}

export function compactLines(sid: string, c: { uuid: string; summary: string; trigger?: 'auto' | 'manual' }): string[] {
  return [
    JSON.stringify({ ...common(sid, { uuid: c.uuid }), logicalParentUuid: randomUUID(), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
      compactMetadata: { trigger: c.trigger ?? 'auto', preTokens: 394876, postTokens: 56615, cumulativeDroppedTokens: 338261 } }),
    JSON.stringify({ ...common(sid, { parentUuid: c.uuid }), type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${c.summary}` } }),
  ]
}

export function costStateLine(sid: string, c: { totalCostUSD: number; modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>; hasUnknownModelCost?: boolean }): string {
  return JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: c.totalCostUSD, modelUsage: c.modelUsage, hasUnknownModelCost: c.hasUnknownModelCost ?? false })
}

export function relocatedLine(sid: string, cwd: string): string {
  return JSON.stringify({ type: 'relocated', sessionId: sid, relocatedCwd: cwd })
}

export function turnDurationLine(sid: string): string {
  return JSON.stringify({ ...common(sid), type: 'system', subtype: 'turn_duration', durationMs: 1234, messageCount: 10 })
}

export function writeTranscript(dir: string, sid: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sid}.jsonl`)
  writeFileSync(path, lines.map(l => l + '\n').join(''))
  return path
}

export function appendTranscript(path: string, lines: string[]): void {
  appendFileSync(path, lines.map(l => l + '\n').join(''))
}

export function writeSubagentTranscript(dir: string, parentSid: string, agentId: string, lines: string[], meta: { agentType: string; description?: string; spawnDepth?: number }): string {
  const sub = join(dir, parentSid, 'subagents')
  mkdirSync(sub, { recursive: true })
  const path = join(sub, `agent-${agentId}.jsonl`)
  writeFileSync(path, lines.map(l => l + '\n').join(''))
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: meta.agentType, description: meta.description ?? '', spawnDepth: meta.spawnDepth ?? 1 }))
  return path
}
