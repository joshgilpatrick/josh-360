import { basename } from 'node:path'
import type { ArtifactOperation } from '../artifacts/contracts.ts'

export type AtlasEventType =
  | 'session_start' | 'prompt_submitted' | 'tool_completed' | 'turn_completed'
  | 'subagent_stop' | 'pre_compact' | 'session_end'

export const EVENT_TYPES: readonly AtlasEventType[] = [
  'session_start', 'prompt_submitted', 'tool_completed', 'turn_completed', 'subagent_stop', 'pre_compact', 'session_end',
]

export type AtlasEvent = {
  event: AtlasEventType
  session_id: string
  ts: string
  fingerprint: string
  parent_session_id?: string
  transcript_path?: string
  cwd?: string
  source?: string
  reason?: string
  trigger?: string
  tool_name?: string
  skill_name?: string
  skill_args?: string
  created_path?: string
  tool_use_id?: string
  slash_command?: string
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  /** Optional, bounded file observation from the hook (spec s5). Only `tool_completed` events may carry one. */
  artifact_observation?: ArtifactObservationPayload
  /**
   * Set by parseEvent, never read from the wire: why a supplied artifact_observation was dropped. The event still ingests;
   * the ingestor counts the reason (src/ingest/artifact-observations.ts).
   */
  artifact_observation_rejected?: ArtifactObservationRejection
}

/**
 * What the hook reports about one tool call's effect on a file (spec s5, plan Task 6). `path` is the absolute path the tool
 * named (for a scope hint: the session cwd). `operation` is `created` only when the tool result explicitly established
 * creation, `modified` for a confirmed update/Edit/NotebookEdit, `touched` when the distinction is unavailable.
 * `sourceEventId` is the tool-use ID, or a UUID minted once by the hook and reused for HTTP delivery and spool fallback.
 * `scopeOnly` marks a dirty hint for the cwd's registered scope (Bash): it never records the path as a document.
 */
export type ArtifactObservationPayload = { path: string; operation: ArtifactOperation; sourceEventId: string; scopeOnly: boolean }

export type ArtifactObservationRejection =
  | 'observation-not-object' | 'observation-unknown-key' | 'observation-path-invalid' | 'observation-path-oversize'
  | 'observation-operation-invalid' | 'observation-source-id-invalid' | 'observation-scope-only-invalid'

export const MAX_OBSERVATION_PATH_CHARS = 4096
export const MAX_SOURCE_EVENT_ID_CHARS = 512
const OBSERVATION_KEYS: ReadonlySet<string> = new Set(['path', 'operation', 'sourceEventId', 'scopeOnly'])
const OBSERVATION_OPERATIONS: readonly string[] = ['created', 'modified', 'touched']
// Printable ASCII only: a tool-use ID (toolu_...) or a UUID. Anything else is not a stable source ID.
const SOURCE_EVENT_ID_RE = /^[\x20-\x7e]{1,512}$/

/**
 * Validates an artifact_observation, failing closed: exactly the four keys, an absolute path of at most 4096 characters with
 * no NUL, a known operation, a 1-512 character printable source ID and a boolean scopeOnly. Never throws.
 */
export function parseArtifactObservation(raw: unknown): { ok: true; value: ArtifactObservationPayload } | { ok: false; reason: ArtifactObservationRejection } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'observation-not-object' }
  const o = raw as Record<string, unknown>
  if (Object.keys(o).some(k => !OBSERVATION_KEYS.has(k))) return { ok: false, reason: 'observation-unknown-key' }
  const { path, operation, sourceEventId, scopeOnly } = o
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return { ok: false, reason: 'observation-path-invalid' }
  if (path.length > MAX_OBSERVATION_PATH_CHARS) return { ok: false, reason: 'observation-path-oversize' }
  if (typeof operation !== 'string' || !OBSERVATION_OPERATIONS.includes(operation)) return { ok: false, reason: 'observation-operation-invalid' }
  if (typeof sourceEventId !== 'string' || !SOURCE_EVENT_ID_RE.test(sourceEventId)) return { ok: false, reason: 'observation-source-id-invalid' }
  if (typeof scopeOnly !== 'boolean') return { ok: false, reason: 'observation-scope-only-invalid' }
  return { ok: true, value: { path, operation: operation as ArtifactOperation, sourceEventId, scopeOnly } }
}

const OPTIONAL_STRING_FIELDS = [
  'transcript_path', 'cwd', 'source', 'reason', 'trigger', 'tool_name', 'skill_name', 'skill_args',
  'created_path', 'tool_use_id', 'slash_command', 'agent_type', 'agent_transcript_path',
] as const

const AGENT_ID_RE = /^[0-9a-f]{6,32}$/

export const SESSION_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agent-[0-9a-f]{6,32})$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EventValidationError'
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 ? v : undefined
}

export function parseEvent(input: unknown): AtlasEvent {
  if (!input || typeof input !== 'object') throw new EventValidationError('event must be an object')
  const o = input as Record<string, unknown>
  const event = str(o.event)
  if (!event || !EVENT_TYPES.includes(event as AtlasEventType)) throw new EventValidationError(`unknown event type ${String(o.event)}`)
  const session_id = str(o.session_id)
  if (!session_id || !isValidSessionId(session_id)) throw new EventValidationError('invalid session_id')
  const ts = str(o.ts)
  const fingerprint = str(o.fingerprint)
  if (!ts || !fingerprint) throw new EventValidationError('ts and fingerprint are required')
  const out: AtlasEvent = { event: event as AtlasEventType, session_id, ts, fingerprint }
  const parent_session_id = str(o.parent_session_id)
  if (parent_session_id !== undefined && !isValidSessionId(parent_session_id)) throw new EventValidationError('invalid parent_session_id')
  if (parent_session_id !== undefined) out.parent_session_id = parent_session_id
  const agent_id = str(o.agent_id)
  // Must match the same contract as a real session id's agent- suffix (global constraint:
  // "session ids are UUIDs or agent-[0-9a-f]{6,32}"), so a malformed value can never be used
  // to key a session row later.
  if (agent_id !== undefined && !AGENT_ID_RE.test(agent_id)) throw new EventValidationError('invalid agent_id')
  if (agent_id !== undefined) out.agent_id = agent_id
  for (const k of OPTIONAL_STRING_FIELDS) {
    const v = str(o[k])
    if (v !== undefined) out[k] = v
  }
  // A bad observation drops only itself: the rest of the event is still good metadata.
  if (o.artifact_observation !== undefined) {
    const parsed = parseArtifactObservation(o.artifact_observation)
    if (parsed.ok) out.artifact_observation = parsed.value
    else out.artifact_observation_rejected = parsed.reason
  }
  // Defence in depth against C1: a transcript_path is only ever trusted when its filename
  // actually matches this event's own session_id (e.g. a re-keyed subagent event whose hook
  // still carried the parent's transcript_path). Drop rather than reject the whole event -- the
  // rest of the event (tool name, cwd, etc.) is still good; the caller falls back to
  // locateTranscript when no valid stored path is available.
  if (out.transcript_path !== undefined && basename(out.transcript_path) !== `${session_id}.jsonl`) {
    delete out.transcript_path
  }
  return out
}
