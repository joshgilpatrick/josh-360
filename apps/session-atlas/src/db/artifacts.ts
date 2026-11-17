import type { AtlasDb } from './database.ts'
import { classifyPath } from '../artifacts/filetype.ts'

export type ArtifactRow = {
  artifactId: number; path: string; filename: string; extension: string; fileType: string; mimeType: string | null; sizeBytes: number | null
  createdAt: string; projectName: string | null; existsState: 'present' | 'missing'; lastVerifiedAt: string | null; creatorSessionId: string | null; creatorTitle: string | null; isSensitive: boolean
}
export type SensitiveFilter = 'hide' | 'show' | 'only'
export type ArtifactFilters = {
  q?: string; fileType?: string; extension?: string; projectName?: string; sessionId?: string; parentSessionId?: string
  createdFrom?: string; createdTo?: string; existsState?: 'present' | 'missing'; includeSubagents?: boolean; sensitive?: SensitiveFilter
}
export type ArtifactPage = { rows: ArtifactRow[]; total: number; limit: number; offset: number }

const CREATOR = `(SELECT o.session_id FROM artifact_origins o WHERE o.artifact_id = a.artifact_id AND o.relation = 'creator' LIMIT 1)`

// The single definition of "hide artifacts created by a subagent," shared by every query that
// filters on it (buildWhere below, and the /api/artifacts/types route) so the rule can't drift
// into two hand-maintained copies. Requires the artifacts table to be aliased `a` in the
// surrounding query. Non-correlated by construction: SQLite materializes the inner SELECT once
// (a "LIST SUBQUERY" with a bloom filter) instead of re-running a correlated subquery per row
// of `artifacts` -- see the artifacts.ts perf remediation for the ~6x measurement at 100k rows.
export const SUBAGENT_EXCLUSION_SQL = `a.artifact_id NOT IN (SELECT o.artifact_id FROM artifact_origins o JOIN sessions s ON s.session_id = o.session_id WHERE o.relation = 'creator' AND s.is_subagent = 1)`
const SELECT = `SELECT a.*, ${CREATOR} AS creator_session_id, (SELECT s.title FROM sessions s WHERE s.session_id = ${CREATOR}) AS creator_title FROM artifacts a`

function toRow(r: Record<string, unknown>): ArtifactRow {
  return {
    artifactId: r.artifact_id as number, path: r.path as string, filename: r.filename as string, extension: r.extension as string, fileType: r.file_type as string,
    mimeType: (r.mime_type as string) ?? null, sizeBytes: (r.size_bytes as number) ?? null, createdAt: r.created_at as string, projectName: (r.project_name as string) ?? null,
    existsState: r.exists_state as ArtifactRow['existsState'], lastVerifiedAt: (r.last_verified_at as string) ?? null,
    creatorSessionId: (r.creator_session_id as string) ?? null, creatorTitle: (r.creator_title as string) ?? null,
    isSensitive: r.is_sensitive === 1,
  }
}

export function upsertArtifact(db: AtlasDb, input: { path: string; sizeBytes: number | null; createdAt: string; projectName: string | null; now: string }): { artifactId: number; created: boolean } {
  return db.transaction(() => {
    const existing = db.raw.prepare('SELECT artifact_id FROM artifacts WHERE path = ?').get(input.path) as { artifact_id: number } | undefined
    if (existing) {
      db.raw.prepare(`UPDATE artifacts SET size_bytes = COALESCE(?, size_bytes), exists_state = 'present', last_verified_at = ? WHERE artifact_id = ?`).run(input.sizeBytes, input.now, existing.artifact_id)
      return { artifactId: existing.artifact_id, created: false }
    }
    const c = classifyPath(input.path)
    const res = db.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, mime_type, size_bytes, created_at, project_name, exists_state, last_verified_at, is_sensitive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?)`).run(input.path, c.filename, c.extension, c.fileType, c.mimeType, input.sizeBytes, input.createdAt, input.projectName, input.now, c.sensitive ? 1 : 0)
    return { artifactId: Number(res.lastInsertRowid), created: true }
  })
}

export function addOrigin(db: AtlasDb, artifactId: number, sessionId: string, relation: 'creator' | 'reference', detectedVia: string, observedAt: string): boolean {
  const res = db.raw.prepare(`INSERT OR IGNORE INTO artifact_origins (artifact_id, session_id, relation, detected_via, observed_at) VALUES (?, ?, ?, ?, ?)`).run(artifactId, sessionId, relation, detectedVia, observedAt)
  return res.changes > 0
}

export function creatorOf(db: AtlasDb, artifactId: number): string | null {
  const r = db.raw.prepare(`SELECT session_id FROM artifact_origins WHERE artifact_id = ? AND relation = 'creator' LIMIT 1`).get(artifactId) as { session_id: string } | undefined
  return r?.session_id ?? null
}

export function getArtifact(db: AtlasDb, artifactId: number): ArtifactRow | null {
  const r = db.raw.prepare(`${SELECT} WHERE a.artifact_id = ?`).get(artifactId) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

export function findArtifactByPath(db: AtlasDb, path: string): ArtifactRow | null {
  const r = db.raw.prepare(`${SELECT} WHERE a.path = ?`).get(path) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

export function ftsQuery(q: string): string | null {
  const tokens = q.replace(/[^\p{L}\p{N}_.-]+/gu, ' ').split(' ').map(t => t.trim()).filter(Boolean)
  return tokens.length ? tokens.map(t => `"${t.replace(/"/g, '')}"*`).join(' ') : null
}

function buildWhere(f: ArtifactFilters): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const fq = f.q ? ftsQuery(f.q) : null
  if (fq) { clauses.push(`a.artifact_id IN (SELECT artifact_id FROM artifacts_fts WHERE artifacts_fts MATCH ?)`); params.push(fq) }
  if (f.fileType) { clauses.push('a.file_type = ?'); params.push(f.fileType) }
  if (f.extension) { clauses.push('a.extension = ?'); params.push(f.extension.toLowerCase()) }
  if (f.projectName) { clauses.push('a.project_name = ?'); params.push(f.projectName) }
  if (f.sessionId) { clauses.push(`EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.artifact_id AND o.session_id = ?)`); params.push(f.sessionId) }
  if (f.parentSessionId) {
    clauses.push(`EXISTS (SELECT 1 FROM artifact_origins o JOIN sessions s ON s.session_id = o.session_id WHERE o.artifact_id = a.artifact_id AND (s.parent_session_id = ? OR s.session_id = ?))`)
    params.push(f.parentSessionId, f.parentSessionId)
  }
  if (f.createdFrom) { clauses.push('a.created_at >= ?'); params.push(f.createdFrom) }
  if (f.createdTo) { clauses.push('a.created_at <= ?'); params.push(f.createdTo) }
  if (f.existsState) { clauses.push('a.exists_state = ?'); params.push(f.existsState) }
  if (f.sensitive === 'hide') clauses.push('a.is_sensitive = 0')
  else if (f.sensitive === 'only') clauses.push('a.is_sensitive = 1')
  if (!f.includeSubagents) clauses.push(SUBAGENT_EXCLUSION_SQL)
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function searchArtifacts(db: AtlasDb, filters: ArtifactFilters, page: { limit: number; offset: number }): ArtifactPage {
  const limit = Math.max(1, Math.min(500, page.limit)), offset = Math.max(0, page.offset)
  const { where, params } = buildWhere(filters)
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM artifacts a ${where}`).get(...(params as (string | number | null)[])) as { n: number }).n
  const rows = (db.raw.prepare(`${SELECT} ${where} ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT ? OFFSET ?`).all(...(params as (string | number | null)[]), limit, offset) as Record<string, unknown>[]).map(toRow)
  return { rows, total, limit, offset }
}

export function setExistsState(db: AtlasDb, artifactId: number, state: 'present' | 'missing', sizeBytes: number | null, now: string): void {
  db.raw.prepare(`UPDATE artifacts SET exists_state = ?, size_bytes = COALESCE(?, size_bytes), last_verified_at = ? WHERE artifact_id = ?`).run(state, sizeBytes, now, artifactId)
}

export function artifactsForSession(db: AtlasDb, sessionId: string, sensitive: SensitiveFilter = 'show'): ArtifactRow[] {
  const sensitiveClause = sensitive === 'hide' ? ' AND a.is_sensitive = 0' : sensitive === 'only' ? ' AND a.is_sensitive = 1' : ''
  return (db.raw.prepare(`${SELECT} WHERE EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.artifact_id AND o.session_id = ?)${sensitiveClause} ORDER BY a.created_at DESC`).all(sessionId) as Record<string, unknown>[]).map(toRow)
}

export function oldestVerified(db: AtlasDb, limit: number): ArtifactRow[] {
  return (db.raw.prepare(`${SELECT} ORDER BY COALESCE(a.last_verified_at, '') ASC LIMIT ?`).all(limit) as Record<string, unknown>[]).map(toRow)
}

// Paths of every artifact this session *created* (relation = 'creator'; a merely-referenced
// artifact is excluded), ordered oldest-first. With `since`, only origins observed strictly
// after that timestamp are included -- used by the focus worker to get "confirmed created
// files" for the delta being sent (since the last refresh) and, with no `since`, the full set
// of paths ever created by the session (the merge allow-list).
export function artifactPathsForSession(db: AtlasDb, sessionId: string, since: string | null = null): string[] {
  return (db.raw.prepare(`SELECT a.path FROM artifacts a JOIN artifact_origins o ON o.artifact_id = a.artifact_id WHERE o.session_id = ? AND o.relation = 'creator' AND o.observed_at > ? ORDER BY o.observed_at`)
    .all(sessionId, since ?? '') as Array<{ path: string }>).map(r => r.path)
}
