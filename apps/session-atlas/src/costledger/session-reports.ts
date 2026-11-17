import type { LedgerDb } from './db.ts'
import type { ReportFilter } from './reports.ts'
import type { Tool } from './types.ts'

export type SessionCostRow = {
  tool: string
  sessionId: string
  ownCostUsd: number
  familyCostUsd: number
  ownMessages: number
  familyMessages: number
  unpricedMessages: number
  /** Informational only: latest-run cost of calls this session holds as a copy of another session's canonical call. Never part of family. */
  sharedHistoryCostUsd: number
}

export type SessionTreeNode = {
  sessionId: string
  agentId: string
  parentSessionId: string | null
  parentAgentId: string | null
  kind: string
  linkQuality: string
  ownCostUsd: number
  familyCostUsd: number
  ownMessages: number
  familyMessages: number
  unpricedMessages: number
}

export type SessionLink = { kind: string; direction: 'undirected' | 'child_to_parent'; from: string; to: string; quality: string; sharedCalls: number }
export type SessionTreeResult = { root: SessionCostRow; nodes: SessionTreeNode[]; links: SessionLink[] }

type Direct = { tool: string; s: string; a: string; cost: number; msgs: number; unpriced: number }
type Node = { tool: string; s: string; a: string; ps: string | null; pa: string | null; kind: string; quality: string }
type Sum = { cost: number; msgs: number; unpriced: number; ownCost: number; ownMsgs: number }
type Member = { tool: string; s: string; a: string }

const key = (tool: string, s: string, a: string): string => JSON.stringify([tool, s, a])

/** Same bound handling as reports.ts: stored ts_utc is toISOString() text, so bounds are normalized before comparing. */
function isoBound(v: string | undefined, dflt: string): string {
  if (!v) return dflt
  const t = new Date(v)
  if (Number.isNaN(t.getTime())) throw new RangeError(`invalid date bound: ${v}`)
  return t.toISOString()
}

const IN_WINDOW = `(SELECT m.id, m.tool, COALESCE(m.source_session_id, '') AS s, COALESCE(m.source_agent_id, '') AS a,
    COALESCE(c.pricing_status, 'not_priced') AS st, c.computed_cost_usd AS cost
  FROM messages m LEFT JOIN latest_message_costs c ON c.message_id = m.id
  WHERE m.ts_utc >= ? AND m.ts_utc < ?)`

/** Each canonical call counted once, at its canonical row's own (session, agent) node. Unpriced is never $0. */
function directTotals(db: LedgerDb, binds: [string, string]): Direct[] {
  return db.raw.prepare(`SELECT tool, s, a,
      SUM(CASE WHEN st = 'priced' THEN COALESCE(cost, 0) ELSE 0 END) AS cost, COUNT(*) AS msgs,
      SUM(CASE WHEN st IN ('missing_price','missing_alias','not_priced') THEN 1 ELSE 0 END) AS unpriced
    FROM ${IN_WINDOW} GROUP BY tool, s, a`).all(...binds) as unknown as Direct[]
}

function allNodes(db: LedgerDb, direct: Direct[]): Node[] {
  const rows = db.raw.prepare('SELECT tool, source_session_id s, source_agent_id a, parent_session_id ps, parent_agent_id pa, kind, link_quality quality FROM session_nodes').all() as unknown as Node[]
  const known = new Set(rows.map(n => key(n.tool, n.s, n.a)))
  // A call with no matching node still gets one root, so it is neither lost nor counted twice.
  for (const d of direct) if (!known.has(key(d.tool, d.s, d.a))) rows.push({ tool: d.tool, s: d.s, a: d.a, ps: null, pa: null, kind: 'main', quality: 'unresolved' })
  // A node whose parent node does not exist is treated as a root so its cost cannot vanish from the root sums.
  const all = new Set(rows.map(n => key(n.tool, n.s, n.a)))
  for (const n of rows) if (n.ps !== null && !all.has(key(n.tool, n.ps, n.pa ?? ''))) { n.ps = null; n.pa = null }
  return rows
}

/** Directed descendants of every node. UNION (not UNION ALL) drops repeated rows, so a cycle cannot loop. */
function descendants(db: LedgerDb): Map<string, Member[]> {
  const rows = db.raw.prepare(`WITH RECURSIVE tree(rt, rs, ra, tool, s, a) AS (
      SELECT tool, source_session_id, source_agent_id, tool, source_session_id, source_agent_id FROM session_nodes
      UNION
      SELECT t.rt, t.rs, t.ra, n.tool, n.source_session_id, n.source_agent_id
      FROM tree t JOIN session_nodes n ON n.tool = t.tool AND n.parent_session_id = t.s AND n.parent_agent_id = t.a
    ) SELECT rt, rs, ra, tool, s, a FROM tree`).all() as unknown as Array<{ rt: string; rs: string; ra: string } & Member>
  const out = new Map<string, Member[]>()
  for (const r of rows) {
    const k = key(r.rt, r.rs, r.ra)
    let list = out.get(k)
    if (!list) out.set(k, (list = []))
    list.push({ tool: r.tool, s: r.s, a: r.a })
  }
  return out
}

function familySums(db: LedgerDb, nodes: Node[], direct: Direct[]): Map<string, Sum> {
  const own = new Map(direct.map(d => [key(d.tool, d.s, d.a), d]))
  const tree = descendants(db)
  const sums = new Map<string, Sum>()
  for (const n of nodes) {
    const k = key(n.tool, n.s, n.a)
    const me = own.get(k)
    const sum: Sum = { cost: 0, msgs: 0, unpriced: 0, ownCost: me?.cost ?? 0, ownMsgs: me?.msgs ?? 0 }
    for (const m of tree.get(k) ?? [{ tool: n.tool, s: n.s, a: n.a }]) {
      const d = own.get(key(m.tool, m.s, m.a))
      if (!d) continue
      sum.cost += d.cost
      sum.msgs += d.msgs
      sum.unpriced += d.unpriced
    }
    sums.set(k, sum)
  }
  return sums
}

/** Cost of canonical calls that a session holds only as a linked copy (the canonical row lives in another session). */
function sharedHistory(db: LedgerDb, binds: [string, string]): Map<string, number> {
  const rows = db.raw.prepare(`SELECT w.tool, h.source_session_id AS hs, SUM(CASE WHEN w.st = 'priced' THEN COALESCE(w.cost, 0) ELSE 0 END) AS cost
    FROM (SELECT DISTINCT message_id, source_session_id FROM message_holders) h JOIN ${IN_WINDOW} w ON w.id = h.message_id
    WHERE h.source_session_id <> w.s GROUP BY w.tool, h.source_session_id`).all(...binds) as unknown as Array<{ tool: string; hs: string; cost: number }>
  return new Map(rows.map(r => [key(r.tool, r.hs, ''), Number(r.cost)]))
}

type Context = { nodes: Node[]; sums: Map<string, Sum>; shared: Map<string, number> }

function context(db: LedgerDb, filter: ReportFilter): Context {
  const binds: [string, string] = [isoBound(filter.from, ''), isoBound(filter.to, '9999-12-31T23:59:59.999Z')]
  const direct = directTotals(db, binds)
  const nodes = allNodes(db, direct)
  return { nodes, sums: familySums(db, nodes, direct), shared: sharedHistory(db, binds) }
}

function rowOf(n: Node, ctx: Context): SessionCostRow {
  const s = ctx.sums.get(key(n.tool, n.s, n.a))
  return {
    tool: n.tool, sessionId: n.s,
    ownCostUsd: s?.ownCost ?? 0, familyCostUsd: s?.cost ?? 0,
    ownMessages: s?.ownMsgs ?? 0, familyMessages: s?.msgs ?? 0, unpricedMessages: s?.unpriced ?? 0,
    sharedHistoryCostUsd: ctx.shared.get(key(n.tool, n.s, '')) ?? 0,
  }
}

/** One row per root (no parent) that has calls in the window. Family = own plus directed descendants, computed at read time and never stored. */
export function sessionRoots(db: LedgerDb, filter: ReportFilter = {}): SessionCostRow[] {
  const ctx = context(db, filter)
  return ctx.nodes.filter(n => n.ps === null && (ctx.sums.get(key(n.tool, n.s, n.a))?.msgs ?? 0) > 0)
    .map(n => rowOf(n, ctx))
    .sort((x, y) => y.familyCostUsd - x.familyCostUsd || x.tool.localeCompare(y.tool) || x.sessionId.localeCompare(y.sessionId))
}

/** One session's tree, parents before children, plus its fork and shared-history links. Rejects an unknown session id. */
export function sessionTree(db: LedgerDb, tool: Tool, sessionId: string, filter: ReportFilter = {}): SessionTreeResult {
  const ctx = context(db, filter)
  const rootNode = ctx.nodes.find(n => n.tool === tool && n.s === sessionId && n.a === '')
  if (!rootNode) throw new RangeError(`unknown session: ${tool} ${sessionId === '' ? '(no session id)' : sessionId}`)
  const order: Node[] = []
  const seen = new Set<string>()
  let level = [rootNode]
  while (level.length > 0) {
    const next: Node[] = []
    for (const n of level) {
      const k = key(n.tool, n.s, n.a)
      if (seen.has(k)) continue
      seen.add(k)
      order.push(n)
      next.push(...ctx.nodes.filter(c => c.tool === tool && c.ps === n.s && c.pa === n.a).sort((x, y) => x.s.localeCompare(y.s) || x.a.localeCompare(y.a)))
    }
    level = next
  }
  const nodes = order.map((n): SessionTreeNode => {
    const s = ctx.sums.get(key(n.tool, n.s, n.a))
    return {
      sessionId: n.s, agentId: n.a, parentSessionId: n.ps, parentAgentId: n.pa, kind: n.kind, linkQuality: n.quality,
      ownCostUsd: s?.ownCost ?? 0, familyCostUsd: s?.cost ?? 0, ownMessages: s?.ownMsgs ?? 0, familyMessages: s?.msgs ?? 0, unpricedMessages: s?.unpriced ?? 0,
    }
  })
  const sessions = new Set(order.map(n => n.s))
  const linkRows = db.raw.prepare('SELECT session_a a, session_b b, kind, shared_calls n FROM session_links WHERE tool = ? ORDER BY kind, session_a, session_b').all(tool) as unknown as Array<{ a: string; b: string; kind: string; n: number }>
  const links = linkRows.filter(l => sessions.has(l.a) || sessions.has(l.b)).map((l): SessionLink => l.kind === 'fork'
    ? { kind: l.kind, direction: 'child_to_parent', from: l.a, to: l.b, quality: 'exact', sharedCalls: Number(l.n) }
    : { kind: l.kind, direction: 'undirected', from: l.a, to: l.b, quality: 'derived', sharedCalls: Number(l.n) })
  return { root: rowOf(rootNode, ctx), nodes, links }
}
