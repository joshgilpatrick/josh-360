// Test-only. Before JP-111 a hook posted each event to Atlas, which turned it into session rows. Now the ledger records sessions
// and src/mirror/session-mirror.ts copies them, so no production code applies hook events. Many catalog tests still describe a
// session by its events (start, tool use, end), so this helper writes the session rows those events used to write and passes the
// event's artifact metadata to the observation code, which the artifact manager still runs. No focus state, no job queue.
import type { AtlasDb } from '../../src/db/database.ts'
import { ensureSession, getSession, isStaleSessionEnd, recordHookActivity, setSessionStatus, touchSession, withdrawEndConfirmation } from '../../src/db/sessions.ts'
import { ingestArtifactEvent, type ArtifactObservationOptions, type ArtifactObservationOutcome } from '../../src/ingest/artifact-observations.ts'
import type { AtlasEvent } from '../../src/ingest/event.ts'
import { nowIso } from '../../src/util/time.ts'

export type IngestResult = { duplicate: boolean; artifacts?: ArtifactObservationOutcome }

function endTime(eventTs: string, now: string): string {
  const ms = Date.parse(eventTs)
  return Number.isFinite(ms) && ms <= Date.parse(now) ? new Date(ms).toISOString() : now
}

function upsertLineage(db: AtlasDb, child: string, parent: string, root: string, now: string): void {
  db.raw.prepare(`INSERT INTO session_lineage (child_session_id, parent_session_id, root_session_id, confidence, discovered_at)
    VALUES (?, ?, ?, 'confirmed', ?) ON CONFLICT(child_session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id,
    root_session_id = excluded.root_session_id`).run(child, parent, root, now)
}

function processSessionIds(db: AtlasDb, event: AtlasEvent, isSubagentEvent: boolean): string[] {
  const ids = new Set([event.session_id])
  if (!isSubagentEvent) return [...ids]
  if (event.parent_session_id) {
    ids.add(event.parent_session_id)
    const root = getSession(db, event.parent_session_id)?.rootSessionId
    if (root) ids.add(root)
  }
  const own = getSession(db, event.session_id)?.rootSessionId
  if (own) ids.add(own)
  return [...ids]
}

const seen = new WeakMap<AtlasDb, Set<string>>()

export function applyEvent(db: AtlasDb, event: AtlasEvent, opts: { now?: string; artifacts?: ArtifactObservationOptions } = {}): IngestResult {
  const now = opts.now ?? nowIso()
  return db.transaction(() => {
    let fingerprints = seen.get(db)
    if (!fingerprints) { fingerprints = new Set(); seen.set(db, fingerprints) }
    if (fingerprints.has(event.fingerprint)) return { duplicate: true }
    fingerprints.add(event.fingerprint)
    const isSubagentEvent = event.session_id.startsWith('agent-')
    if (event.parent_session_id) ensureSession(db, { sessionId: event.parent_session_id, startedAt: event.ts, now })
    ensureSession(db, { sessionId: event.session_id, isSubagent: isSubagentEvent, parentSessionId: event.parent_session_id, agentType: event.agent_type,
      cwd: event.cwd, transcriptPath: event.transcript_path, startedAt: event.ts, now })
    if (isSubagentEvent && event.parent_session_id) {
      const parent = getSession(db, event.parent_session_id)
      upsertLineage(db, event.session_id, event.parent_session_id, parent?.rootSessionId ?? event.parent_session_id, now)
    }
    touchSession(db, event.session_id, event.ts)
    if (event.event !== 'session_end') {
      for (const id of processSessionIds(db, event, isSubagentEvent)) {
        recordHookActivity(db, id, event.ts, now)
        withdrawEndConfirmation(db, id, event.ts)
      }
    }
    if (event.event === 'session_start' && event.source !== 'compact') setSessionStatus(db, event.session_id, 'active', now)
    if (event.event === 'session_end' && !isStaleSessionEnd(db, event.session_id, endTime(event.ts, now))) {
      setSessionStatus(db, event.session_id, 'closed', now, 'hook', endTime(event.ts, now))
    }
    const artifacts = ingestArtifactEvent(db, event, { ...opts.artifacts, now })
    return artifacts ? { duplicate: false, artifacts } : { duplicate: false }
  })
}
