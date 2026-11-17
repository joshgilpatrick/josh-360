import type { LedgerDb } from './db.ts'

// Jira keys look like AD-123 or JP-7: an uppercase project prefix, a dash, then digits.
const JIRA_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/

export type JiraSessionLink = {
  issueKey: string
  tool: string
  sessionId: string
  /** Only 'worked' is recorded. Creating an issue is deliberately not a link. */
  action: 'worked'
  recordedAt: string
}

export type JiraIssueCost = {
  issueKey: string
  sessions: number
  sessionIds: string[]
  /** Sum of each linked session's latest priced cost, counted once per session. */
  costUsd: number
  /** Linked-session messages whose latest cost row is not priced. The total is incomplete when this is above zero. */
  unpricedMessages: number
}

/** Record that a session worked on an issue. Re-recording the same session and issue keeps one row. */
export function recordJiraSessionLink(db: LedgerDb, link: JiraSessionLink): void {
  if (!JIRA_KEY.test(link.issueKey)) throw new Error(`not a Jira issue key: ${link.issueKey}`)
  db.raw.prepare(`INSERT INTO jira_session_links (issue_key, tool, source_session_id, action, recorded_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (issue_key, tool, source_session_id) DO NOTHING`)
    .run(link.issueKey, link.tool, link.sessionId, link.action, link.recordedAt)
}

/**
 * Cost of one Jira issue: every session linked to it, with each message counted once even when
 * several linked sessions hold it (a Claude copy shared across sessions).
 */
export function jiraIssueCost(db: LedgerDb, issueKey: string): JiraIssueCost {
  const sessionIds = (db.raw.prepare(`SELECT source_session_id FROM jira_session_links WHERE issue_key = ? ORDER BY source_session_id`)
    .all(issueKey) as Array<{ source_session_id: string }>).map(r => r.source_session_id)
  const totals = db.raw.prepare(`
    SELECT COALESCE(SUM(c.computed_cost_usd), 0) AS cost,
           COALESCE(SUM(CASE WHEN c.pricing_status <> 'priced' THEN 1 ELSE 0 END), 0) AS unpriced
    FROM latest_message_costs c
    WHERE c.message_id IN (
      SELECT h.message_id FROM message_holders h
      JOIN jira_session_links l ON l.source_session_id = h.source_session_id
      WHERE l.issue_key = ?
    )
  `).get(issueKey) as { cost: number; unpriced: number }
  return {
    issueKey,
    sessions: sessionIds.length,
    sessionIds,
    costUsd: totals.cost,
    unpricedMessages: totals.unpriced,
  }
}
