import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { startTestServer } from '../helpers/server.ts'
import { createAtlasServer, Router } from '../../src/server/http.ts'
import { loadConfig } from '../../src/config.ts'
import { openDatabase } from '../../src/db/database.ts'
import { createLogger } from '../../src/util/log.ts'
import { enqueueJob, claimNextJob, failJob } from '../helpers/legacy-jobs.ts'
import { ensureSession } from '../../src/db/sessions.ts'

const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'

// fetch()/undici treats Host as a forbidden header and silently sends the real connection
// host instead, so a bad-Host request must go over node:http directly.
function rawGet(baseUrl: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const req = http.request(url, { method: 'GET', agent: false, headers: { connection: 'close', ...headers } }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('same-origin posture: foreign Origin is rejected', async () => {
  const s = await startTestServer()
  try {
    const res = await fetch(`${s.baseUrl}/api/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ event: 'session_start' }),
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json() as { error: string }).error, 'forbidden origin')
  } finally {
    await s.close()
  }
})

test('same-origin posture: bad Host is rejected', async () => {
  const s = await startTestServer()
  try {
    const res = await rawGet(s.baseUrl, '/api/health', { host: 'evil.example' })
    assert.equal(res.status, 400)
    assert.equal((JSON.parse(res.body) as { error: string }).error, 'bad host')
  } finally {
    await s.close()
  }
})

test('same-origin posture: non-JSON content-type on a write is rejected', async () => {
  const s = await startTestServer()
  try {
    const res = await fetch(`${s.baseUrl}/api/ping`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' })
    assert.equal(res.status, 415)
  } finally {
    await s.close()
  }
})

test('same-origin posture: a plain POST (no Origin, json) is still accepted', async () => {
  const s = await startTestServer()
  try {
    const res = await fetch(`${s.baseUrl}/api/ping`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'session_start', session_id: SID, ts: '2026-09-17T00:00:00.000Z', fingerprint: 'f2', cwd: '/x' }),
    })
    assert.equal(res.status, 202)
  } finally {
    await s.close()
  }
})

test('same-origin posture: same-origin POST from the UI is allowed', async () => {
  const s = await startTestServer()
  try {
    const port = new URL(s.baseUrl).port
    const res = await fetch(`${s.baseUrl}/api/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ event: 'session_start', session_id: SID, ts: '2026-09-17T00:00:00.000Z', fingerprint: 'f3', cwd: '/x' }),
    })
    assert.equal(res.status, 202)
  } finally {
    await s.close()
  }
})

test('router robustness: malformed percent-encoding in a param returns 400 and the server keeps serving', async () => {
  const home = tempDir('atlas-srv-')
  const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
  const db = openDatabase(config.dbPath)
  const log = createLogger(null)
  const router = new Router()
  router.add('GET', '/api/x/:id', ctx => { ctx.send(200, { id: ctx.params.id }) })
  const atlas = createAtlasServer({ db, config: { ...config, port: 0 }, log, router })
  const port = await atlas.listen()
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const bad = await fetch(`${baseUrl}/api/x/%E0%A4%A`)
    assert.equal(bad.status, 400)
    const ok = await fetch(`${baseUrl}/api/x/hello`)
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { id: 'hello' })
  } finally {
    await atlas.close()
    db.close()
  }
})

test('health reports worker job counts and the last job activity', async () => {
  const s = await startTestServer()
  try {
    const empty = (await (await fetch(`${s.baseUrl}/api/health`)).json()) as { jobs: Record<string, number>; lastRunAt: string | null }
    assert.deepEqual(empty.jobs, { pending: 0, running: 0, quarantined: 0 })
    assert.equal(empty.lastRunAt, null)
    const t = '2026-09-20T00:00:00.000Z'
    ensureSession(s.db, { sessionId: SID, cwd: '/x', startedAt: t, now: t })
    enqueueJob(s.db, SID, 'transcript', 1, t)
    enqueueJob(s.db, SID, 'artifacts', 1, t)
    claimNextJob(s.db, t, 'artifacts')
    failJob(s.db, SID, 'artifacts', 'other', '2026-09-20T00:01:00.000Z', { backoffBaseMs: 1, backoffMaxMs: 1, maxAttempts: 1 })
    const h = (await (await fetch(`${s.baseUrl}/api/health`)).json()) as { jobs: Record<string, number>; lastRunAt: string | null; sessions: number }
    assert.deepEqual(h.jobs, { pending: 1, running: 0, quarantined: 1 })
    assert.equal(h.lastRunAt, '2026-09-20T00:01:00.000Z')
    assert.equal(h.sessions, 1)
  } finally {
    await s.close()
  }
})
