import type { LedgerDb } from './db.ts'
import { SUSPECT_OUTPUT_TOKENS, SUSPECT_PROMPT_TOKENS } from './constants.ts'
import type { Attribution, AttributionQuality, ParsedMessage } from './types.ts'

export type UpsertResult = 'inserted' | 'replaced' | 'kept'

const n = (v: number | null): number => v ?? 0

export function promptSideTokens(m: ParsedMessage): number {
  return n(m.inputTokens) + n(m.cacheReadTokens) + n(m.cacheWrite5mTokens) + n(m.cacheWrite1hTokens) + n(m.cacheWriteUnclassifiedTokens)
}

export function totalTokens(m: ParsedMessage): number {
  return promptSideTokens(m) + n(m.outputTokens)
}

export function isSuspect(m: ParsedMessage): boolean {
  return promptSideTokens(m) > SUSPECT_PROMPT_TOKENS || n(m.outputTokens) > SUSPECT_OUTPUT_TOKENS
}

export function upsertRepo(db: LedgerDb, attr: Attribution): void {
  if (attr.repoKey === null || attr.displayName === null || attr.rootPath === null) return
  db.raw.prepare('INSERT OR IGNORE INTO repos (repo_key, display_name, root_path) VALUES (?, ?, ?)').run(attr.repoKey, attr.displayName, attr.rootPath)
}

type StoredRank = { id: number; source_agent_id: string | null; total: number; is_sidechain: number; ts_utc: string; source_path: string; source_locator: string }

function isBetter(c: ParsedMessage, s: StoredRank): boolean {
  const ct = totalTokens(c)
  if (ct !== s.total) return ct > s.total
  const cs = c.isSidechain ? 1 : 0
  if (cs !== s.is_sidechain) return cs < s.is_sidechain
  if (c.tsUtc !== s.ts_utc) return c.tsUtc < s.ts_utc
  if (c.sourcePath !== s.source_path) return c.sourcePath < s.source_path
  return c.sourceLocator < s.source_locator
}

export const RANK_SQL = `SELECT id, source_agent_id,
  COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_5m_tokens,0)
    + COALESCE(cache_write_1h_tokens,0) + COALESCE(cache_write_unclassified_tokens,0) AS total,
  is_sidechain, ts_utc, source_path, source_locator
FROM messages WHERE tool = ?
  AND CASE WHEN tool = 'claude-code' THEN '' ELSE COALESCE(source_session_id, '') END = CASE WHEN tool = 'claude-code' THEN '' ELSE COALESCE(?, '') END
  AND source_message_id = ?`

const HOLDER_SQL = `INSERT OR IGNORE INTO message_holders (message_id, source_session_id, source_agent_id) VALUES (?, ?, ?)`

export function upsertMessage(db: LedgerDb, m: ParsedMessage, attr: Attribution, quality: AttributionQuality): UpsertResult {
  return db.transaction(() => {
    upsertRepo(db, attr)
    const row = {
      tool: m.tool,
      source_message_id: m.sourceMessageId,
      source_session_id: m.sourceSessionId,
      source_agent_id: m.sourceAgentId ?? null,
      ts_utc: m.tsUtc,
      model_raw: m.modelRaw,
      provider_raw: m.providerRaw,
      input_tokens: m.inputTokens,
      output_tokens: m.outputTokens,
      reasoning_tokens: m.reasoningTokens,
      cache_read_tokens: m.cacheReadTokens,
      cache_write_5m_tokens: m.cacheWrite5mTokens,
      cache_write_1h_tokens: m.cacheWrite1hTokens,
      cache_write_unclassified_tokens: m.cacheWriteUnclassifiedTokens,
      logged_cost_usd: m.loggedCostUsd,
      is_sidechain: m.isSidechain ? 1 : 0,
      cwd: m.cwd,
      git_branch: m.gitBranch,
      repo_key: attr.repoKey,
      worktree_path: attr.worktreePath,
      attribution_quality: quality,
      usage_status: m.usageStatus,
      suspect: isSuspect(m) ? 1 : 0,
      source_path: m.sourcePath,
      source_locator: m.sourceLocator,
    }
    const cols = Object.keys(row)
    const values = Object.values(row) as Array<string | number | null>
    const stored = db.raw.prepare(RANK_SQL).get(m.tool, m.sourceSessionId, m.sourceMessageId) as StoredRank | undefined
    const hold = (id: number | bigint): void => {
      db.raw.prepare(HOLDER_SQL).run(id, m.sourceSessionId ?? '', m.sourceAgentId ?? '')
    }
    if (!stored) {
      const res = db.raw.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values)
      hold(res.lastInsertRowid)
      return 'inserted' as const
    }
    hold(stored.id)
    if (!isBetter(m, stored)) {
      // The same physical row re-read (e.g. after a migration added the column): backfill its agent, never null it.
      if (m.sourceAgentId != null && stored.source_path === m.sourcePath && stored.source_locator === m.sourceLocator && stored.source_agent_id !== m.sourceAgentId) {
        db.raw.prepare('UPDATE messages SET source_agent_id = ? WHERE id = ?').run(m.sourceAgentId, stored.id)
      }
      return 'kept' as const
    }
    db.raw.prepare(`UPDATE messages SET ${cols.map(c => `${c} = ?`).join(',')} WHERE id = ?`).run(...values, stored.id)
    return 'replaced' as const
  })
}

export function needsScan(db: LedgerDb, path: string, size: number, mtimeMs: number): boolean {
  const r = db.raw.prepare('SELECT size, mtime_ms FROM source_files WHERE path = ?').get(path) as { size: number; mtime_ms: number } | undefined
  return !r || r.size !== size || r.mtime_ms !== mtimeMs
}

export function markScanned(db: LedgerDb, tool: string, path: string, size: number, mtimeMs: number, now: string): void {
  db.raw.prepare(`INSERT INTO source_files (tool, path, size, mtime_ms, last_scanned_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET tool = excluded.tool, size = excluded.size, mtime_ms = excluded.mtime_ms, last_scanned_at = excluded.last_scanned_at`)
    .run(tool, path, size, mtimeMs, now)
}
