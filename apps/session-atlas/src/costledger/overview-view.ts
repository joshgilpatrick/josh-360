import type { DatabaseSync } from 'node:sqlite'

export const OVERVIEW_VIEW = 'session_overview_45d'

/**
 * One row per parent session with activity in the last 45 days. A parent session is a session no other session
 * spawned: Claude subagents live inside their session, and OpenCode child sessions are folded into their root.
 * Cost and activity times cover the whole family (every agent and child session), not only the last 45 days.
 * Unknown cost is NULL, never zero. Branch and folder prefer the parent's own main-thread calls, newest first.
 * Titles, tickets and PRs belong to the parent session itself.
 */
const BODY = `
WITH RECURSIVE
known(tool, s) AS (
  SELECT DISTINCT tool, COALESCE(source_session_id, '') FROM messages
  UNION SELECT tool, source_session_id FROM session_nodes
),
edges(tool, s, p) AS (
  SELECT DISTINCT n.tool, n.source_session_id, n.parent_session_id FROM session_nodes n
  JOIN known k ON k.tool = n.tool AND k.s = n.parent_session_id
  WHERE n.parent_session_id <> n.source_session_id
),
tree(tool, root, s) AS (
  SELECT k.tool, k.s, k.s FROM known k WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.tool = k.tool AND e.s = k.s)
  UNION SELECT t.tool, t.root, e.s FROM tree t JOIN edges e ON e.tool = t.tool AND e.p = t.s
),
msgs AS (
  SELECT t.tool, t.root, m.ts_utc, m.cwd, m.git_branch,
    (COALESCE(m.source_session_id, '') = t.root AND COALESCE(m.source_agent_id, '') = '') AS is_main,
    COALESCE(c.pricing_status, 'not_priced') AS st, c.computed_cost_usd AS cost
  FROM messages m
  JOIN tree t ON t.tool = m.tool AND t.s = COALESCE(m.source_session_id, '')
  LEFT JOIN latest_message_costs c ON c.message_id = m.id
),
agg AS (
  SELECT tool, root, MIN(ts_utc) AS first_at, MAX(ts_utc) AS last_at,
    SUM(CASE WHEN st = 'priced' THEN COALESCE(cost, 0) ELSE 0 END) AS cost_sum,
    SUM(st = 'priced') AS n_priced,
    SUM(st IN ('missing_price', 'missing_alias', 'not_priced')) AS n_unpriced
  FROM msgs GROUP BY tool, root
),
recent(tool, root) AS (
  SELECT tool, root FROM agg WHERE last_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-45 days')
),
place AS (
  SELECT tool, root, cwd, git_branch,
    ROW_NUMBER() OVER (PARTITION BY tool, root ORDER BY is_main DESC, ts_utc DESC) AS rn_cwd
  FROM msgs WHERE cwd IS NOT NULL AND (tool, root) IN (SELECT tool, root FROM recent)
),
branch AS (
  SELECT tool, root, git_branch,
    ROW_NUMBER() OVER (PARTITION BY tool, root ORDER BY is_main DESC, ts_utc DESC) AS rn_branch
  FROM msgs WHERE git_branch IS NOT NULL AND (tool, root) IN (SELECT tool, root FROM recent)
)
SELECT a.tool AS tool, a.root AS session_id,
  COALESCE(
    (SELECT value FROM session_labels l WHERE l.tool = a.tool AND l.source_session_id = a.root AND l.kind = 'custom_title'),
    (SELECT value FROM session_labels l WHERE l.tool = a.tool AND l.source_session_id = a.root AND l.kind = 'tool_title'),
    (SELECT value FROM session_labels l WHERE l.tool = a.tool AND l.source_session_id = a.root AND l.kind = 'ai_title')
  ) AS title,
  (SELECT group_concat(issue_key, ', ') FROM (SELECT issue_key FROM jira_session_links j WHERE j.tool = a.tool AND j.source_session_id = a.root ORDER BY issue_key)) AS jira_tickets,
  (SELECT b.git_branch FROM branch b WHERE b.tool = a.tool AND b.root = a.root AND b.rn_branch = 1) AS branch,
  (SELECT p.cwd FROM place p WHERE p.tool = a.tool AND p.root = a.root AND p.rn_cwd = 1) AS folder,
  (SELECT group_concat(url, ', ') FROM (SELECT url FROM session_pr_links r WHERE r.tool = a.tool AND r.source_session_id = a.root ORDER BY url)) AS pr_links,
  CASE WHEN a.n_priced = 0 AND a.n_unpriced > 0 THEN NULL ELSE a.cost_sum END AS cost_usd,
  a.n_unpriced AS unpriced_messages,
  a.first_at AS first_active_at, a.last_at AS last_active_at
FROM agg a JOIN recent r ON r.tool = a.tool AND r.root = a.root
ORDER BY a.last_at DESC`

const CREATE = `CREATE VIEW ${OVERVIEW_VIEW} AS${BODY}`

/** Create the view, or replace it when its stored definition differs from this one. Idempotent. */
export function ensureOverviewView(raw: DatabaseSync): void {
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?").get(OVERVIEW_VIEW) as { sql: string } | undefined
  if (row?.sql === CREATE) return
  raw.exec('BEGIN IMMEDIATE')
  try {
    raw.exec(`DROP VIEW IF EXISTS ${OVERVIEW_VIEW}`)
    raw.exec(CREATE)
    raw.exec('COMMIT')
  } catch (e) {
    try { raw.exec('ROLLBACK') } catch {}
    throw e
  }
}
