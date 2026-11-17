export type UsageTotals = { input: number; output: number; cacheRead: number; cache5m: number; cache1h: number; thinking: number }
export type TranscriptRecord =
  | { kind: 'usage'; messageId: string; model: string; usage: UsageTotals; ts: string | null }
  | { kind: 'usage_raw'; messageId: string | null; model: string | null; rawUsage: Record<string, unknown>; ts: string | null }
  | { kind: 'title'; source: 'custom' | 'agent' | 'ai'; title: string }
  | { kind: 'cwd'; cwd: string }
  | { kind: 'compact_boundary'; uuid: string; trigger: string }
  | { kind: 'compact_summary'; text: string }
  | ToolResultRecord
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; ts: string | null }
  // toolUseId (Task 6) is optional so existing constructors of this shape keep compiling; classifyRecord always sets it.
  | { kind: 'tool_use'; name: string; path: string | null; ts: string | null; toolUseId?: string | null }
  | { kind: 'cost_state'; totalCostUsd: number; hasUnknown: boolean }
  | { kind: 'turn_end'; ts: string | null }
  | { kind: 'other' }

/**
 * A tool result. `created`/`path` keep their legacy meaning for the candidate feed (created now requires an explicit, successful
 * creation). The rest lets the processor classify the result honestly (Task 6, ruling R28) without file contents:
 * - isError: the block is flagged is_error, or the structured result reports an error.
 * - writeType: Write's own create/update distinction (toolUseResult.type), or, for a result with no structured payload, the
 *   message the tool returns, matched at its start only (never inside echoed file text).
 * - edited: the structured result has Edit/MultiEdit's shape (old/new strings or an edits list).
 * - filePath: the structured result's file path, if any.
 * - transcriptSessionId: the session that wrote this record (`agent-<id>` for a subagent record), used to skip records copied
 *   in from another session's transcript.
 * With several tool_result blocks on one line the single toolUseResult cannot be attributed to a block, so the structured
 * facts are left unknown for each of them. The Task 6 fields are optional so existing constructors of the legacy shape keep
 * compiling; classifyRecord always sets them, and a consumer must treat an absent `isError` as unconfirmed success.
 */
export type ToolResultRecord = {
  kind: 'tool_result'; toolUseId: string | null; created: boolean; path: string | null
  isError?: boolean; writeType?: 'create' | 'update' | null; edited?: boolean; filePath?: string | null; transcriptSessionId?: string | null; ts?: string | null
}

// The messages Write returns, anchored at the start of the result text. Shared in meaning with hooks/atlas-hook.js.
export const WRITE_CREATED_TEXT_RE = /^File created successfully at: /
export const WRITE_UPDATED_TEXT_RE = /^The file [^\n]+ has been updated/
const ERROR_TEXT_RE = /^\s*(?:Error\b|<tool_use_error>)/
const AGENT_ID_RE = /^[0-9a-f]{6,32}$/

export const MAX_TEXT_CHARS = 1200
// M6: a hard cut at MAX_TEXT_CHARS can land in the middle of a token -- including a secret like
// an `sk-ant-...` API key -- leaving a fragment too short for envelope.ts's redaction regex to
// recognize (redaction there runs on this already-clipped text). Treat MAX_TEXT_CHARS as a soft
// limit: extend to the next whitespace within CLIP_SLACK extra characters so a token straddling
// the boundary is kept whole (and therefore still redactable) instead of being split.
const CLIP_SLACK = 80
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : null)
function clip(s: string): string {
  if (s.length <= MAX_TEXT_CHARS) return s
  const hardEnd = Math.min(s.length, MAX_TEXT_CHARS + CLIP_SLACK)
  const window = s.slice(MAX_TEXT_CHARS, hardEnd)
  const ws = window.search(/\s/)
  return s.slice(0, ws === -1 ? hardEnd : MAX_TEXT_CHARS + ws)
}

function usageFrom(m: Obj): UsageTotals | null {
  const u = m.usage
  if (!isObj(u)) return null
  const cc = isObj(u.cache_creation) ? u.cache_creation : {}
  const cache5m = num(cc.ephemeral_5m_input_tokens), cache1h = num(cc.ephemeral_1h_input_tokens)
  const totalCreate = num(u.cache_creation_input_tokens)
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : {}
  return {
    input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens),
    // When the breakdown is absent, attribute creation tokens to the 5-minute tier (the API default).
    cache5m: cache5m + cache1h === 0 ? totalCreate : cache5m, cache1h, thinking: num(details.thinking_tokens),
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isObj).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

function assistantRecords(raw: Obj, m: Obj, ts: string | null): TranscriptRecord[] {
  const out: TranscriptRecord[] = []
  const usage = usageFrom(m)
  const id = str(m.id)
  if (usage && id && str(m.model)) out.push({ kind: 'usage', messageId: id, model: m.model as string, usage, ts })
  if (isObj(m.usage)) out.push({ kind: 'usage_raw', messageId: str(m.id), model: str(m.model), rawUsage: m.usage, ts })
  const content = Array.isArray(m.content) ? m.content.filter(isObj) : []
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'text', role: 'assistant', text: clip(b.text), ts })
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      const input = isObj(b.input) ? b.input : {}
      const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
      out.push({ kind: 'tool_use', name: b.name, path, ts, toolUseId: str(b.id) })
    }
  }
  return out
}

function userRecords(raw: Obj, m: Obj, ts: string | null): TranscriptRecord[] {
  if (raw.isCompactSummary === true) return [{ kind: 'compact_summary', text: clip(textFromContent(m.content)) }]
  const blocks = Array.isArray(m.content) ? m.content.filter(isObj) : []
  const results = blocks.filter(b => b.type === 'tool_result')
  if (results.length) {
    const single = results.length === 1
    const structured = single && isObj(raw.toolUseResult)
    const tur: Obj = structured ? raw.toolUseResult as Obj : {}
    const turText = single && typeof raw.toolUseResult === 'string' ? raw.toolUseResult : null
    const transcriptSessionId = typeof raw.agentId === 'string' && AGENT_ID_RE.test(raw.agentId) ? `agent-${raw.agentId}` : str(raw.sessionId)
    return results.map(b => {
      const text = textFromContent(b.content)
      const isError = b.is_error === true || (typeof tur.error === 'string' && tur.error.length > 0) || (turText !== null && ERROR_TEXT_RE.test(turText))
      const writeType = tur.type === 'create' || tur.type === 'update' ? tur.type
        : structured ? null : WRITE_CREATED_TEXT_RE.test(text) ? 'create' : WRITE_UPDATED_TEXT_RE.test(text) ? 'update' : null
      const edited = (typeof tur.oldString === 'string' && typeof tur.newString === 'string') || Array.isArray(tur.edits)
      const created = !isError && writeType === 'create'
      const filePath = str(tur.filePath)
      return {
        kind: 'tool_result', toolUseId: str(b.tool_use_id), created, path: filePath ?? (created ? /at: (\/\S+)/.exec(text)?.[1] ?? null : null),
        isError, writeType, edited, filePath, transcriptSessionId, ts,
      } satisfies ToolResultRecord
    })
  }
  const text = textFromContent(m.content)
  return text.trim() && raw.isMeta !== true ? [{ kind: 'text', role: 'user', text: clip(text), ts }] : []
}

export function classifyRecord(raw: unknown): TranscriptRecord[] {
  if (!isObj(raw)) return [{ kind: 'other' }]
  const type = str(raw.type)
  const ts = str(raw.timestamp)
  const out: TranscriptRecord[] = []
  if (typeof raw.cwd === 'string' && raw.cwd.startsWith('/')) out.push({ kind: 'cwd', cwd: raw.cwd })
  switch (type) {
    case 'assistant': if (isObj(raw.message)) out.push(...assistantRecords(raw, raw.message, ts)); break
    case 'user': if (isObj(raw.message)) out.push(...userRecords(raw, raw.message, ts)); break
    case 'ai-title': if (str(raw.aiTitle)) out.push({ kind: 'title', source: 'ai', title: raw.aiTitle as string }); break
    case 'agent-name': if (str(raw.agentName)) out.push({ kind: 'title', source: 'agent', title: raw.agentName as string }); break
    case 'custom-title': if (str(raw.customTitle)) out.push({ kind: 'title', source: 'custom', title: raw.customTitle as string }); break
    case 'relocated': if (str(raw.relocatedCwd)) out.push({ kind: 'cwd', cwd: raw.relocatedCwd as string }); break
    case 'worktree-state': { const w = isObj(raw.worktreeSession) ? raw.worktreeSession : {}; if (str(w.worktreePath)) out.push({ kind: 'cwd', cwd: w.worktreePath as string }); break }
    case 'cost-state': out.push({ kind: 'cost_state', totalCostUsd: num(raw.totalCostUSD), hasUnknown: raw.hasUnknownModelCost === true }); break
    case 'system': {
      if (raw.subtype === 'compact_boundary') {
        const meta = isObj(raw.compactMetadata) ? raw.compactMetadata : {}
        out.push({ kind: 'compact_boundary', uuid: str(raw.uuid) ?? '', trigger: str(meta.trigger) ?? 'unknown' })
      } else if (raw.subtype === 'turn_duration') out.push({ kind: 'turn_end', ts })
      break
    }
  }
  return out.length ? out : [{ kind: 'other' }]
}
