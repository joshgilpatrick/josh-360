import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb } from '../helpers/db.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { addOrigin, artifactPathsForSession, artifactsForSession, creatorOf, ftsQuery, getArtifact, searchArtifacts, setExistsState, upsertArtifact } from '../../src/db/artifacts.ts'

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', S2 = '3a1b6f7a-4f5f-4a92-9e7e-2d6e6b8e9c10', SUB = 'agent-abcdef123456'
const T = (m: number) => `2026-09-17T00:${String(m).padStart(2, '0')}:00.000Z`

function seed() {
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: '/x/keystone', startedAt: T(0), now: T(0) })
  ensureSession(db, { sessionId: S2, cwd: '/x/other', startedAt: T(0), now: T(0) })
  ensureSession(db, { sessionId: SUB, parentSessionId: S1, isSubagent: true, agentType: 'Explore', startedAt: T(0), now: T(0) })
  const a = upsertArtifact(db, { path: '/x/keystone/docs/billing-export.md', sizeBytes: 10, createdAt: T(1), projectName: 'keystone', now: T(1) })
  addOrigin(db, a.artifactId, S1, 'creator', 'tool_event', T(1))
  const b = upsertArtifact(db, { path: '/x/other/data.csv', sizeBytes: 20, createdAt: T(2), projectName: 'other', now: T(2) })
  addOrigin(db, b.artifactId, S2, 'creator', 'watcher', T(2))
  const c = upsertArtifact(db, { path: '/x/keystone/tmp/sub-notes.md', sizeBytes: 5, createdAt: T(3), projectName: 'keystone', now: T(3) })
  addOrigin(db, c.artifactId, SUB, 'creator', 'tool_event', T(3))
  return { db, a, b, c }
}

test('upsert is idempotent by path and origins keep the first creator', () => {
  const { db, a } = seed()
  const again = upsertArtifact(db, { path: '/x/keystone/docs/billing-export.md', sizeBytes: 11, createdAt: T(5), projectName: 'keystone', now: T(5) })
  assert.equal(again.artifactId, a.artifactId); assert.equal(again.created, false)
  assert.equal(addOrigin(db, a.artifactId, S2, 'reference', 'reconcile', T(6)), true)
  assert.equal(addOrigin(db, a.artifactId, S2, 'reference', 'reconcile', T(7)), false)
  assert.equal(creatorOf(db, a.artifactId), S1)
  assert.equal(getArtifact(db, a.artifactId)!.createdAt, T(1), 'creation timestamp is never overwritten')
  db.close()
})

test('search filters by text, type, extension, project, session, parent, date, and existence', () => {
  const { db, a, c } = seed()
  const page = { limit: 50, offset: 0 }
  assert.deepEqual(searchArtifacts(db, { q: 'billing' }, page).rows.map(r => r.artifactId), [a.artifactId])
  assert.equal(searchArtifacts(db, { q: 'bill' }, page).total, 1, 'prefix match')
  assert.equal(searchArtifacts(db, { fileType: 'spreadsheet' }, page).total, 1)
  assert.equal(searchArtifacts(db, { extension: 'md' }, page).total, 1, 'subagent artifacts hidden by default')
  assert.equal(searchArtifacts(db, { extension: 'md', includeSubagents: true }, page).total, 2)
  assert.equal(searchArtifacts(db, { projectName: 'keystone', includeSubagents: true }, page).total, 2)
  assert.equal(searchArtifacts(db, { sessionId: S2 }, page).total, 1)
  assert.deepEqual(searchArtifacts(db, { parentSessionId: S1, includeSubagents: true }, page).rows.map(r => r.artifactId).sort(), [a.artifactId, c.artifactId].sort())
  assert.equal(searchArtifacts(db, { createdFrom: T(2) }, page).total, 1)
  assert.equal(searchArtifacts(db, { createdTo: T(1) }, page).total, 1)
  setExistsState(db, a.artifactId, 'missing', null, T(9))
  assert.equal(searchArtifacts(db, { existsState: 'missing' }, page).total, 1)
  assert.equal(searchArtifacts(db, {}, page).total, 2, 'missing rows still listed')
  const r = searchArtifacts(db, {}, { limit: 1, offset: 0 })
  assert.equal(r.rows.length, 1); assert.equal(r.total, 2); assert.equal(r.rows[0]!.creatorSessionId, S2, 'newest first')
  assert.equal(artifactsForSession(db, S1).length, 1)
  db.close()
})

test('artifactPathsForSession orders by observed_at, since filters out older origins, and reference-only origins are excluded', () => {
  const { db, b } = seed()
  const d = upsertArtifact(db, { path: '/x/keystone/docs/later.md', sizeBytes: 3, createdAt: T(4), projectName: 'keystone', now: T(4) })
  addOrigin(db, d.artifactId, S1, 'creator', 'tool_event', T(4))
  // S1 merely referenced (did not create) artifact b, at a timestamp after everything else --
  // "Confirmed created files" must never include it.
  addOrigin(db, b.artifactId, S1, 'reference', 'reconcile', T(5))
  assert.deepEqual(artifactPathsForSession(db, S1), ['/x/keystone/docs/billing-export.md', '/x/keystone/docs/later.md'])
  assert.deepEqual(artifactPathsForSession(db, S1, T(1)), ['/x/keystone/docs/later.md'])
  assert.deepEqual(artifactPathsForSession(db, S1, T(4)), [])
  assert.deepEqual(artifactPathsForSession(db, S2), ['/x/other/data.csv'])
  db.close()
})

test('ftsQuery quotes tokens and rejects empty input', () => {
  assert.equal(ftsQuery('billing export'), '"billing"* "export"*')
  assert.equal(ftsQuery('  "weird" AND (x) '), '"weird"* "AND"* "x"*')
  assert.equal(ftsQuery('   '), null)
})

test('sensitive rows are flagged on insert and filtered by the sensitive option', () => {
  const { db } = seed()
  const env = upsertArtifact(db, { path: '/x/keystone/.env.local', sizeBytes: 3, createdAt: T(4), projectName: 'keystone', now: T(4) })
  addOrigin(db, env.artifactId, S1, 'creator', 'tool_event', T(4))
  assert.equal(getArtifact(db, env.artifactId)!.isSensitive, true)
  assert.equal(searchArtifacts(db, {}, { limit: 50, offset: 0 }).total, 3, 'no option: unfiltered')
  assert.equal(searchArtifacts(db, { sensitive: 'hide' }, { limit: 50, offset: 0 }).total, 2)
  assert.equal(searchArtifacts(db, { sensitive: 'show' }, { limit: 50, offset: 0 }).total, 3)
  const only = searchArtifacts(db, { sensitive: 'only' }, { limit: 50, offset: 0 })
  assert.equal(only.total, 1)
  assert.equal(only.rows[0]!.path, '/x/keystone/.env.local')
  db.close()
})
