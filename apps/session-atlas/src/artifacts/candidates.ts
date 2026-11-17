import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { AtlasDb } from '../db/database.ts'
import { addOrigin, findArtifactByPath, upsertArtifact } from '../db/artifacts.ts'
import { getSession, projectNameFromCwd } from '../db/sessions.ts'
import { isInsideHome } from '../util/paths.ts'
import { CLAUDE_RUNTIME_SEGMENTS, FIXED_DISCOVERY_SEGMENTS, JUNK_SUFFIXES } from './path-policy.ts'

export type ArtifactCandidate = { path: string; sessionId: string; detectedVia: 'tool_event' | 'watcher' | 'reconcile'; observedAt: string }
export type ConfirmResult = 'created' | 'linked' | 'rejected' | 'duplicate'

// One prepared statement per db connection (node:sqlite statements are reusable), rather than
// re-preparing on every call — matters most for the watcher, which can call this once per active
// session on every filesystem event.
const insertCandidateStmts = new WeakMap<DatabaseSync, StatementSync>()
const markCandidateStmts = new WeakMap<DatabaseSync, StatementSync>()

function insertCandidateStmt(db: AtlasDb): StatementSync {
  let stmt = insertCandidateStmts.get(db.raw)
  if (!stmt) {
    stmt = db.raw.prepare(`INSERT OR IGNORE INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, ?, ?, 'pending')`)
    insertCandidateStmts.set(db.raw, stmt)
  }
  return stmt
}

function markCandidateStmt(db: AtlasDb): StatementSync {
  let stmt = markCandidateStmts.get(db.raw)
  if (!stmt) {
    stmt = db.raw.prepare(`UPDATE artifact_candidates SET state = ? WHERE path = ? AND session_id = ? AND detected_via = ?`)
    markCandidateStmts.set(db.raw, stmt)
  }
  return stmt
}

// Single source of truth for the artifact_candidates insert used by the ingestor, the transcript
// processor, and the watcher. Returns whether a new row was actually inserted (false when the
// UNIQUE(path, session_id, detected_via) constraint deduped it).
export function recordCandidate(db: AtlasDb, c: ArtifactCandidate): boolean {
  const r = insertCandidateStmt(db).run(c.path, c.sessionId, c.detectedVia, c.observedAt)
  return r.changes > 0
}

// The segment, suffix and Claude-runtime lists are shared with the artifact-manager path policy (path-policy.ts), so the
// legacy candidate rules and the new discovery exclusions cannot drift apart.
export const IGNORED_SEGMENTS = new Set(FIXED_DISCOVERY_SEGMENTS)
let extraIgnoredSegments = new Set<string>()

// Called once at service start with config.artifacts.ignoreSegments so users can extend the
// built-in list without a code change. Replaces (never accumulates) the previous extra set.
export function configureArtifactRules(opts: { ignoreSegments: string[] }): void {
  extraIgnoredSegments = new Set(opts.ignoreSegments)
}

// Claude Code temp dirs a session legitimately writes deliverables into: $CLAUDE_JOB_DIR/tmp
// (~/.claude/jobs/<id>/tmp) and ~/.claude/tmp. Checked before the runtime-segment guards so
// those files stay discoverable and revealable (H3). Everything else under ~/.claude/jobs is
// still job state, not an artifact.
const CLAUDE_TEMP_RE = /^\/\.claude\/(?:jobs\/[^/]+\/tmp|tmp)\//
export function isClaudeTempPath(path: string): boolean {
  if (!isAbsolute(path)) return false
  const normalized = resolve(path)
  return homeSpellings().some(home => normalized.startsWith(home + sep) && CLAUDE_TEMP_RE.test(normalized.slice(home.length)))
}

// Home by its given spelling and by its real path. A home reached through a symlink (macOS /var -> /private/var) has two
// spellings; a literal path is judged against the first, a resolved path against the second, so neither looks "outside home".
// Both spellings are used for the deny lists, so a resolved path into a sensitive directory is caught under either one.
function homeSpellings(): string[] {
  const lexical = resolve(homedir())
  let real = lexical
  try { real = realpathSync(lexical) } catch { /* a missing home keeps its spelling */ }
  const out = [lexical.replace(/\/+$/, '')]
  const r = real.replace(/\/+$/, '')
  if (r && r !== out[0]) out.push(r)
  return out
}
const realHome = (): string => homeSpellings().at(-1) as string
const IGNORED_SUFFIXES = JUNK_SUFFIXES
const WINDOW_TAIL_MS = 60_000
// Plan 02 handoff: artifact_candidates.path is untrusted (hook POST / transcript tool_result).
const MAX_PATH_LEN = 4096

// Claude Code's own runtime subtrees under ~/.claude -- never a session's own artifact, always
// noise (or another session's private data) when a session's cwd happens to be ~/.claude itself
// (a live checkout of the claude-harness config repo, which is a real, supported setup here; see
// I4). The transcript reader's own use of ~/.claude/projects (locate.ts) does not go through
// isIgnoredPath/isUntrustedPath, so this never affects Atlas's own ability to find transcripts.
// (CLAUDE_RUNTIME_SEGMENTS is imported from path-policy.ts.)

// Files under .claude/worktrees/ are NOT ignored (spec s4): a linked worktree is a real checkout whose files are ingested and
// actionable; bulk checkout noise is suppressed at discovery instead (path-policy.ts isPassiveDiscoveryExcluded).
export function isIgnoredPath(path: string): boolean {
  const parts = path.split(sep)
  if (parts.some(p => IGNORED_SEGMENTS.has(p) || extraIgnoredSegments.has(p))) return true
  if (!isClaudeTempPath(path)) {
    if (path.includes(`${sep}.claude${sep}atlas${sep}`)) return true
    if (['atlas', 'state', 'backups', 'logs'].some(d => path.includes(`${sep}.josh-360${sep}${d}${sep}`))) return true
    if (CLAUDE_RUNTIME_SEGMENTS.some(seg => path.includes(`${sep}.claude${sep}${seg}${sep}`))) return true
  }
  const name = parts[parts.length - 1] ?? ''
  return IGNORED_SUFFIXES.some(s => name.endsWith(s))
}

function sensitiveDirs(): string[] {
  return homeSpellings().flatMap(sensitiveDirsUnder)
}
function sensitiveDirsUnder(home: string): string[] {
  return [
    join(home, '.claude', 'atlas'),
    // Josh 360's own data: the ledger, the shared cache, backups and logs (JP-111).
    ...['atlas', 'state', 'backups', 'logs'].map(d => join(home, '.josh-360', d)),
    // Claude Code's own runtime-owned subtrees: other sessions' and subagents' transcripts, job
    // state, session-focus files, todos, shell snapshots, and caches. Never watched, walked, or
    // revealed as if they belonged to whatever session happens to run with cwd=~/.claude (I4).
    ...CLAUDE_RUNTIME_SEGMENTS.map(seg => join(home, '.claude', seg)),
    // Claude Code's settings (an `env` block can hold secrets) and the cost ledger: configuration and runtime data, not documents (I2).
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(home, '.claude', 'cost-ledger'),
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.config', 'gcloud'),
    join(home, 'Library', 'Keychains'),
  ]
}

// R37: macOS volumes are usually case- and Unicode-normalization-insensitive, so `~/.SSH`, `~/.ſsh` (long s) or
// `~/library/keychains` name the real secret directory. Segments are compared folded, with the same fold as path-policy.ts
// (which does not export it): NFKC plus a lower/upper/lower round trip. Folding can only over-deny. The Claude temp exception
// above stays exact-case, so a case variant of a runtime subtree remains denied.
function foldSegment(segment: string): string {
  if (!/[^\u0000-\u007f]/.test(segment)) return segment.toLowerCase()
  return segment.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase()
}
const foldPath = (path: string): string => path.split(sep).map(foldSegment).join(sep)

function isSensitivePath(path: string): boolean {
  if (isClaudeTempPath(path)) return false
  const folded = foldPath(path)
  return sensitiveDirs().map(foldPath).some(d => folded === d || folded.startsWith(d + sep))
}

// Resolves the candidate's real path (following any symlink chain, including a symlinked
// ancestor directory) when it exists. Never reads file content — realpathSync only follows the
// path's link chain, it does not open the file. Returns null when the path does not exist (yet);
// there is then nothing for it to escape to.
function resolveRealpath(path: string): string | null {
  try { return realpathSync(path) } catch { return null }
}

// Untrusted-path guard (plan 02 handoff): runs before any stat of the candidate path. The
// sensitive-dir and home-boundary checks apply to both the literal path AND its resolved
// realpath, so a path that only *passes through* a symlink (a symlinked ancestor directory, or
// is itself a symlink) into a sensitive directory or outside home is caught even though its
// literal spelling looks innocuous.
export function isUntrustedPath(path: string): boolean {
  if (!isAbsolute(path)) return true
  if (path.length > MAX_PATH_LEN) return true
  if (isSensitivePath(path)) return true
  if (!homeSpellings().some(h => isInsideHome(path, h))) return true
  const real = resolveRealpath(path)
  if (real && (isSensitivePath(real) || !isInsideHome(real, realHome()))) return true
  return false
}

// Trust boundary for a watcher/reconcile ROOT folder (not a candidate file). Deliberately
// stricter than isUntrustedPath: a root must never be the home directory itself (isUntrustedPath
// allows a candidate FILE to equal home only in the degenerate case that never happens in
// practice), and this applies to both the literal root and its resolved realpath — so a root that
// is home, or is reachable as home only via a symlinked ancestor directory, is never watched or
// walked.
export function isTrustedRoot(path: string): boolean {
  const homes = homeSpellings()
  const p = path.replace(/\/+$/, '')
  if (!p || homes.includes(p)) return false
  if (isUntrustedPath(p)) return false
  const real = resolveRealpath(p)
  if (real && homes.includes(real.replace(/\/+$/, ''))) return false
  return true
}

function markCandidate(db: AtlasDb, c: ArtifactCandidate, state: 'confirmed' | 'rejected'): void {
  markCandidateStmt(db).run(state, c.path, c.sessionId, c.detectedVia)
}

export function confirmCandidate(db: AtlasDb, c: ArtifactCandidate, opts: { now: string; graceMs?: number }): ConfirmResult {
  const grace = opts.graceMs ?? 2000
  const reject = () => { markCandidate(db, c, 'rejected'); return 'rejected' as const }
  if (isUntrustedPath(c.path) || isIgnoredPath(c.path)) return reject()
  const session = getSession(db, c.sessionId)
  if (!session) return reject()

  let stat: ReturnType<typeof lstatSync> | null = null
  try { stat = lstatSync(c.path) } catch { stat = null }
  // lstat, never stat: a symlink must never be followed to whatever it points at, even for a
  // tool_event candidate that otherwise skips the creation-window check.
  if (stat && stat.isSymbolicLink()) return reject()
  if (stat && !stat.isFile()) return reject()
  if (!stat && c.detectedVia !== 'tool_event') return reject()

  if (stat && c.detectedVia !== 'tool_event') {
    const birth = stat.birthtimeMs || stat.ctimeMs
    const start = Date.parse(session.startedAt) - grace
    const end = Date.parse(session.lastActivityAt) + WINDOW_TAIL_MS + grace
    // Fail closed: an unparseable timestamp makes every "<"/">" comparison false, which would
    // otherwise let every candidate through the window check instead of rejecting it.
    if (!Number.isFinite(start) || !Number.isFinite(end) || birth < start || birth > end) return reject()
  }

  return db.transaction(() => {
    const existing = findArtifactByPath(db, c.path)
    if (existing) {
      const linked = db.raw.prepare('SELECT 1 FROM artifact_origins WHERE artifact_id = ? AND session_id = ?').get(existing.artifactId, c.sessionId)
      markCandidate(db, c, 'confirmed')
      if (linked) return 'duplicate'
      addOrigin(db, existing.artifactId, c.sessionId, 'reference', c.detectedVia, c.observedAt)
      return 'linked'
    }
    const createdAt = stat && stat.birthtimeMs ? new Date(stat.birthtimeMs).toISOString() : c.observedAt
    const projectName = session.projectName ?? (session.resumeCwd ? projectNameFromCwd(session.resumeCwd) : null)
    const { artifactId } = upsertArtifact(db, { path: c.path, sizeBytes: stat ? stat.size : null, createdAt, projectName, now: opts.now })
    if (!stat) db.raw.prepare(`UPDATE artifacts SET exists_state = 'missing' WHERE artifact_id = ?`).run(artifactId)
    addOrigin(db, artifactId, c.sessionId, 'creator', c.detectedVia, c.observedAt)
    markCandidate(db, c, 'confirmed')
    return 'created'
  })
}

// Settled candidates are dedupe markers only: processCandidates reads 'pending' rows alone, and a confirmed candidate's
// data already lives in artifacts/artifact_origins. Deletes settled rows observed at or before the cutoff, `batchSize`
// rows per statement, and stops once a pass has deleted `maxRows`, so a large backlog is cleared over several passes
// without holding the service loop. A pruned key that is seen again is inserted and judged again, which is harmless.
export function pruneSettledCandidates(db: AtlasDb, olderThanIso: string, opts: { batchSize?: number; maxRows?: number } = {}): number {
  const batchSize = opts.batchSize ?? 5_000
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY
  const stmt = db.raw.prepare(`DELETE FROM artifact_candidates WHERE candidate_id IN (
    SELECT candidate_id FROM artifact_candidates WHERE state IN ('confirmed', 'rejected') AND observed_at <= ? LIMIT ?)`)
  let total = 0
  while (total < maxRows) {
    const n = Number(stmt.run(olderThanIso, batchSize).changes)
    total += n
    if (n < batchSize) break
  }
  return total
}

export function processCandidates(db: AtlasDb, opts: { sessionId?: string; now: string; limit?: number }): Record<ConfirmResult, number> {
  const counts: Record<ConfirmResult, number> = { created: 0, linked: 0, rejected: 0, duplicate: 0 }
  const rows = (opts.sessionId
    ? db.raw.prepare(`SELECT path, session_id, detected_via, observed_at FROM artifact_candidates WHERE state = 'pending' AND session_id = ? ORDER BY observed_at LIMIT ?`).all(opts.sessionId, opts.limit ?? 500)
    : db.raw.prepare(`SELECT path, session_id, detected_via, observed_at FROM artifact_candidates WHERE state = 'pending' ORDER BY observed_at LIMIT ?`).all(opts.limit ?? 500)) as Array<Record<string, string>>
  for (const r of rows) {
    const c: ArtifactCandidate = { path: r.path!, sessionId: r.session_id!, detectedVia: r.detected_via as ArtifactCandidate['detectedVia'], observedAt: r.observed_at! }
    counts[confirmCandidate(db, c, { now: opts.now })] += 1
  }
  return counts
}
