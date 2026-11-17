import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { LedgerDb } from './db.ts'
import { readOpenCodeSessions } from './parse-opencode.ts'

export type SpawnRef = { sessionId: string; ownerAgentId: string; toolUseId: string }
export type LinkQuality = 'exact' | 'derived' | 'unresolved' | 'conflict'
type Edge = { agentId: string; quality: LinkQuality }
type Parents = Map<string, string>

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Replace the Agent-call owners recorded for one transcript. Idempotent: safe to repeat for the same path. */
export function recordSpawns(db: LedgerDb, path: string, spawns: SpawnRef[]): void {
  db.transaction(() => {
    db.raw.prepare('DELETE FROM claude_spawn_owners WHERE source_path = ?').run(path)
    const ins = db.raw.prepare('INSERT OR REPLACE INTO claude_spawn_owners (source_path, source_session_id, tool_use_id, owner_agent_id) VALUES (?, ?, ?, ?)')
    for (const s of spawns) ins.run(path, s.sessionId, s.toolUseId, s.ownerAgentId)
  })
}

/**
 * Pick one agent's parent. Owner '' means the main session and is a real owner, so presence is tested with
 * undefined, never truthiness. The result `agentId` is '' for the session root.
 */
export function resolveClaudeParent(
  agentId: string, toolUseId: string | null, parentAgentId: string | null,
  owners: Map<string, string>, present: Set<string>,
): Edge {
  const found = toolUseId === null ? undefined : owners.get(toolUseId)
  // An owner that is neither the main session nor a present agent would orphan this node, so it is ignored.
  const owner = found !== undefined && found !== '' && !present.has(found) ? undefined : found
  const claimed = parentAgentId !== null && parentAgentId !== agentId && present.has(parentAgentId) ? parentAgentId : null
  if (owner !== undefined) {
    if (claimed !== null && claimed !== owner) return { agentId: '', quality: 'conflict' }
    return { agentId: owner, quality: 'exact' }
  }
  if (claimed !== null) return { agentId: claimed, quality: 'derived' }
  return { agentId: '', quality: 'unresolved' }
}

/** True when making `child` a child of `parent` would close a loop through already accepted edges. */
function closesLoop(child: string, parent: string, accepted: Parents): boolean {
  const seen = new Set<string>()
  for (let p = parent; p !== ''; p = accepted.get(p) ?? '') {
    if (p === child || seen.has(p)) return true
    seen.add(p)
  }
  return false
}

const UPSERT_NODE = `INSERT OR REPLACE INTO session_nodes
  (tool, source_session_id, source_agent_id, parent_session_id, parent_agent_id, kind, link_quality, spawn_tool_use_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

/** Every session that holds a call gets a root node, including the '' bucket for calls with no session. */
function ensureSessionRoots(db: LedgerDb, tool: string): void {
  db.raw.prepare(`INSERT OR IGNORE INTO session_nodes (tool, source_session_id, source_agent_id, parent_session_id, parent_agent_id, kind, link_quality, spawn_tool_use_id)
    SELECT DISTINCT m.tool, h.source_session_id, '', NULL, NULL, 'main', 'exact', NULL
    FROM message_holders h JOIN messages m ON m.id = h.message_id WHERE m.tool = ?`).run(tool)
}

type Meta = { toolUseId: string | null; parentAgentId: string | null }
const keyOf = (session: string, agent: string): string => JSON.stringify([session, agent])

/** Reads only toolUseId and parentAgentId; descriptions and prompts are never touched. */
function readMeta(path: string): Meta | null {
  try {
    const d: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return null
    const o = d as Record<string, unknown>
    return { toolUseId: str(o.toolUseId), parentAgentId: str(o.parentAgentId) }
  } catch {
    return null
  }
}

function scanClaudeFiles(dir: string): { agents: Map<string, Set<string>>; metas: Map<string, Meta> } {
  const agents = new Map<string, Set<string>>()
  const metas = new Map<string, Meta>()
  if (!existsSync(dir)) return { agents, metas }
  for (const rel of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
    const parts = rel.split(sep)
    const sub = parts.lastIndexOf('subagents')
    const m = /^agent-(.+?)(\.meta\.json|\.jsonl)$/.exec(parts[parts.length - 1] ?? '')
    const session = sub > 0 ? parts[sub - 1] : undefined
    const agent = m?.[1]
    if (m === null || agent === undefined || session === undefined || session === '') continue
    let set = agents.get(session)
    if (!set) agents.set(session, (set = new Set()))
    set.add(agent)
    if (m[2] === '.meta.json') {
      const meta = readMeta(join(dir, rel))
      if (meta) metas.set(keyOf(session, agent), meta)
    }
  }
  return { agents, metas }
}

type Existing = { source_agent_id: string; parent_agent_id: string | null }

/**
 * Rebuild Claude parent edges from every meta file on disk plus recorded Agent-call owners.
 * A node with no meta keeps its existing edge, so a vanished file never erases a known link.
 */
export function syncClaudeHierarchy(db: LedgerDb, dir: string): void {
  const files = scanClaudeFiles(dir)
  const held = db.raw.prepare(`SELECT DISTINCT h.source_session_id s, h.source_agent_id a FROM message_holders h
    JOIN messages m ON m.id = h.message_id WHERE m.tool = 'claude-code' AND h.source_agent_id <> ''`).all() as Array<{ s: string; a: string }>
  for (const { s, a } of held) {
    let set = files.agents.get(s)
    if (!set) files.agents.set(s, (set = new Set()))
    set.add(a)
  }
  db.transaction(() => {
    const ownersBySession = new Map<string, Map<string, string>>()
    const rows = db.raw.prepare('SELECT source_session_id s, tool_use_id t, owner_agent_id o FROM claude_spawn_owners ORDER BY source_path, tool_use_id').all() as Array<{ s: string; t: string; o: string }>
    for (const r of rows) {
      let m = ownersBySession.get(r.s)
      if (!m) ownersBySession.set(r.s, (m = new Map()))
      if (!m.has(r.t)) m.set(r.t, r.o)
    }
    const existingQ = db.raw.prepare("SELECT source_agent_id, parent_agent_id FROM session_nodes WHERE tool = 'claude-code' AND source_session_id = ? AND source_agent_id <> ''")
    for (const [session, present] of files.agents) {
      const owners = ownersBySession.get(session) ?? new Map<string, string>()
      const accepted: Parents = new Map()
      const fresh: string[] = []
      for (const agent of [...present].sort()) {
        const prior = (existingQ.all(session) as Existing[]).find(r => r.source_agent_id === agent)
        if (!files.metas.has(keyOf(session, agent)) && prior) accepted.set(agent, prior.parent_agent_id ?? '')
        else fresh.push(agent)
      }
      for (const agent of fresh) {
        const meta = files.metas.get(keyOf(session, agent))
        let edge = resolveClaudeParent(agent, meta?.toolUseId ?? null, meta?.parentAgentId ?? null, owners, present)
        if (edge.agentId === agent || closesLoop(agent, edge.agentId, accepted)) edge = { agentId: '', quality: 'conflict' }
        accepted.set(agent, edge.agentId)
        db.raw.prepare(UPSERT_NODE).run('claude-code', session, agent, session, edge.agentId, 'subagent', edge.quality, meta?.toolUseId ?? null)
      }
    }
    ensureSessionRoots(db, 'claude-code')
  })
}

/** parent_id is the only cost parent when present; fork_session_id is a parent only for rows without parent_id. */
export function syncOpenCodeHierarchy(db: LedgerDb, dbPath: string): void {
  const sessions = readOpenCodeSessions(dbPath).sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
  const known = new Set(sessions.map(s => s.sessionId))
  const held = db.raw.prepare("SELECT DISTINCT h.source_session_id s FROM message_holders h JOIN messages m ON m.id = h.message_id WHERE m.tool = 'opencode'").all() as Array<{ s: string }>
  for (const r of held) known.add(r.s)
  db.transaction(() => {
    const accepted: Parents = new Map()
    const dropFork = db.raw.prepare("DELETE FROM session_links WHERE tool = 'opencode' AND session_a = ? AND kind = 'fork'")
    const addFork = db.raw.prepare("INSERT OR REPLACE INTO session_links (tool, session_a, session_b, kind, shared_calls) VALUES ('opencode', ?, ?, 'fork', 0)")
    for (const s of sessions) {
      dropFork.run(s.sessionId)
      if (s.forkSessionId !== null && s.forkSessionId !== s.sessionId) addFork.run(s.sessionId, s.forkSessionId)
      const parent = s.parentSessionId ?? s.forkSessionId
      const kind = s.parentSessionId !== null ? 'subagent' : s.forkSessionId !== null ? 'fork' : 'main'
      let parentOut: string | null = null
      let quality: LinkQuality = 'exact'
      if (parent !== null) {
        if (parent === s.sessionId || closesLoop(s.sessionId, parent, accepted)) quality = 'conflict'
        else if (!known.has(parent)) quality = 'unresolved'
        else parentOut = parent
      }
      accepted.set(s.sessionId, parentOut ?? '')
      db.raw.prepare(UPSERT_NODE).run('opencode', s.sessionId, '', parentOut, parentOut === null ? null : '', kind, quality, null)
    }
    ensureSessionRoots(db, 'opencode')
  })
}

/** Undirected links between Claude sessions that hold a copy of the same call. No price is stored or copied. */
export function rebuildSharedHistoryLinks(db: LedgerDb): void {
  db.transaction(() => {
    db.raw.exec("DELETE FROM session_links WHERE tool='claude-code' AND kind='shared_history'")
    db.raw.exec(`INSERT INTO session_links(tool,session_a,session_b,kind,shared_calls)
      SELECT 'claude-code',a.source_session_id,b.source_session_id,'shared_history',COUNT(DISTINCT a.message_id)
      FROM (SELECT DISTINCT message_id,source_session_id FROM message_holders WHERE source_session_id<>'') a
      JOIN (SELECT DISTINCT message_id,source_session_id FROM message_holders WHERE source_session_id<>'') b
       ON b.message_id=a.message_id AND a.source_session_id<b.source_session_id
      GROUP BY a.source_session_id,b.source_session_id`)
  })
}
