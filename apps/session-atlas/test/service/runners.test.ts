import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { silentLogger } from '../helpers/log.ts'
import { pruneRunner, runLoop } from '../../src/service/runners.ts'
import { ensureSession, getSession } from '../../src/db/sessions.ts'

const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'

test('runLoop keeps running until aborted and tolerates runner errors', async () => {
  let calls = 0
  const ac = new AbortController()
  const flaky = { name: 'flaky', run: async () => { calls += 1; if (calls === 1) throw new Error('x'); if (calls >= 3) ac.abort(); return false } }
  await runLoop([flaky], { pollMs: 5, log: silentLogger, signal: ac.signal })
  assert.ok(calls >= 3)
})

test('runLoop yields at least one macrotask per busy pass instead of spinning on microtasks', async () => {
  let calls = 0
  const ac = new AbortController()
  const busy = { name: 'busy', run: async () => { calls += 1; if (calls >= 5) ac.abort(); return true } }
  let immediateCount = 0
  const realSetImmediate = globalThis.setImmediate
  const g = globalThis as unknown as { setImmediate: typeof setImmediate }
  g.setImmediate = ((cb: () => void) => { immediateCount += 1; return realSetImmediate(cb) }) as typeof setImmediate
  try {
    await runLoop([busy], { pollMs: 5, log: silentLogger, signal: ac.signal })
  } finally {
    g.setImmediate = realSetImmediate
  }
  assert.ok(calls >= 5)
  assert.ok(immediateCount >= 4, `expected at least one setImmediate per busy pass, got ${immediateCount}`)
})

test('pruneRunner prunes settled artifact candidates older than 7 days and keeps pending ones', async () => {
  const db = openTestDb()
  const put = (path: string, state: string, observedAt: string) => db.raw.prepare(
    `INSERT INTO artifact_candidates (path, session_id, detected_via, observed_at, state) VALUES (?, ?, 'watcher', ?, ?)`,
  ).run(path, SID, observedAt, state)
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const fresh = new Date(Date.now() - 86_400_000).toISOString()
  put('/x/old-rejected.md', 'rejected', old)
  put('/x/old-pending.md', 'pending', old)
  put('/x/fresh-rejected.md', 'rejected', fresh)
  const r = pruneRunner(db, silentLogger, { intervalMs: 0 })
  assert.equal(await r.run(), false)
  const left = (db.raw.prepare('SELECT path FROM artifact_candidates ORDER BY path').all() as Array<{ path: string }>).map(x => x.path)
  assert.deepEqual(left, ['/x/fresh-rejected.md', '/x/old-pending.md'])
  db.close()
})
