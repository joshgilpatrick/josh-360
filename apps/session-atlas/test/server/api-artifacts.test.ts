import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tempDir } from '../helpers/tmp.ts'
import { openTestDb } from '../helpers/db.ts'
import { startRouteServer } from '../helpers/server.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { addOrigin, upsertArtifact, getArtifact } from '../../src/db/artifacts.ts'
import { registerArtifactRoutes } from '../../src/server/api-artifacts.ts'
import { registerArtifactRoot } from '../../src/db/artifact-manager.ts'
import { PREVIEW_MAX_BYTES } from '../../src/artifacts/preview.ts'

const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const T = '2026-09-17T00:00:00.000Z'
const postHeaders = { 'content-type': 'application/json' }

test('artifact list, types, recent, and reveal validation', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const present = join(dir, 'present.md'); writeFileSync(present, 'x')
    const a = upsertArtifact(db, { path: present, sizeBytes: 1, createdAt: T, projectName: 'p', now: T })
    addOrigin(db, a.artifactId, S1, 'creator', 'tool_event', T)
    const b = upsertArtifact(db, { path: join(dir, 'gone.csv'), sizeBytes: 1, createdAt: T, projectName: 'p', now: T })
    addOrigin(db, b.artifactId, S1, 'creator', 'tool_event', T)
    const c = upsertArtifact(db, { path: '/etc/hosts', sizeBytes: 1, createdAt: T, projectName: 'p', now: T })
    addOrigin(db, c.artifactId, S1, 'creator', 'tool_event', T)
    // A symlink sitting at an artifact's recorded path: lstat sees the link, not the file it
    // points at, so this must count as "missing" (409) rather than being followed and revealed.
    const linkPath = join(dir, 'link.bin')
    symlinkSync(present, linkPath)
    const d = upsertArtifact(db, { path: linkPath, sizeBytes: 1, createdAt: T, projectName: 'p', now: T })
    addOrigin(db, d.artifactId, S1, 'creator', 'tool_event', T)

    const revealed: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, reveal: async p => { revealed.push(p) } }))
    try {
      const list = await (await fetch(`${srv.base}/api/artifacts?type=document`)).json() as { total: number }
      assert.equal(list.total, 1)

      const types = await (await fetch(`${srv.base}/api/artifacts/types`)).json() as Array<{ fileType: string; count: number }>
      assert.deepEqual(types.find(t => t.fileType === 'spreadsheet'), { fileType: 'spreadsheet', count: 1 })

      const recent = await (await fetch(`${srv.base}/api/artifacts/recent?limit=5`)).json() as Array<{ artifactId: number }>
      assert.equal(recent.length, 4)

      // M1: a fractional limit must not reach `LIMIT ?` as a REAL bind (node:sqlite throws
      // "datatype mismatch" on that) -- it truncates to an integer instead of 500ing.
      const fractional = await fetch(`${srv.base}/api/artifacts/recent?limit=2.5`)
      assert.equal(fractional.status, 200)
      assert.equal((await fractional.json() as Array<unknown>).length, 2)

      assert.equal((await fetch(`${srv.base}/api/artifacts/${a.artifactId}/reveal`, { method: 'POST', headers: postHeaders })).status, 200)
      assert.deepEqual(revealed, [present])

      assert.equal((await fetch(`${srv.base}/api/artifacts/${b.artifactId}/reveal`, { method: 'POST', headers: postHeaders })).status, 409)
      assert.equal(getArtifact(db, b.artifactId)!.existsState, 'missing')

      assert.equal((await fetch(`${srv.base}/api/artifacts/${c.artifactId}/reveal`, { method: 'POST', headers: postHeaders })).status, 403)

      assert.equal((await fetch(`${srv.base}/api/artifacts/${d.artifactId}/reveal`, { method: 'POST', headers: postHeaders })).status, 409)
      assert.equal(getArtifact(db, d.artifactId)!.existsState, 'missing')

      assert.equal((await fetch(`${srv.base}/api/artifacts/999999/reveal`, { method: 'POST', headers: postHeaders })).status, 404)
      assert.equal((await fetch(`${srv.base}/api/artifacts/abc/reveal`, { method: 'POST', headers: postHeaders })).status, 400)
    } finally {
      await srv.close()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sensitive artifacts are hidden by default, shown or isolated on request, and summarized', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
  const doc = upsertArtifact(db, { path: join(dir, 'notes.md'), sizeBytes: 1, createdAt: T, projectName: 'p', now: T })
  addOrigin(db, doc.artifactId, S1, 'creator', 'tool_event', T)
  const env = upsertArtifact(db, { path: join(dir, '.env'), sizeBytes: 1, createdAt: T, projectName: 'p', now: T })
  addOrigin(db, env.artifactId, S1, 'creator', 'tool_event', T)
  const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, reveal: async () => {} }))
  try {
    const totals = async (qs: string) => ((await (await fetch(`${srv.base}/api/artifacts${qs}`)).json()) as { total: number }).total
    assert.equal(await totals(''), 1)
    assert.equal(await totals('?sensitive=hide'), 1)
    assert.equal(await totals('?sensitive=show'), 2)
    assert.equal(await totals('?sensitive=only'), 1)
    assert.equal(await totals('?sensitive=garbage'), 1, 'unknown value falls back to hide')
    const recent = (await (await fetch(`${srv.base}/api/artifacts/recent?limit=8`)).json()) as Array<{ path: string }>
    assert.deepEqual(recent.map(r => r.path), [join(dir, 'notes.md')])
    const recentAll = (await (await fetch(`${srv.base}/api/artifacts/recent?limit=8&sensitive=show`)).json()) as Array<{ path: string }>
    assert.equal(recentAll.length, 2)
    const types = (await (await fetch(`${srv.base}/api/artifacts/types`)).json()) as Array<{ fileType: string; count: number }>
    assert.deepEqual(types, [{ fileType: 'document', count: 1 }])
    const summary = (await (await fetch(`${srv.base}/api/artifacts/summary`)).json()) as Record<string, number>
    assert.deepEqual(summary, { total: 2, projects: 1, fileTypes: 2, sensitiveHidden: 1 })
  } finally {
    await srv.close()
    db.close()
  }
})

test('preview serves allowlisted files and refuses everything else', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const mk = (name: string, body: string) => {
      const p = join(dir, name); writeFileSync(p, body)
      const a = upsertArtifact(db, { path: p, sizeBytes: body.length, createdAt: T, projectName: 'p', now: T })
      addOrigin(db, a.artifactId, S1, 'creator', 'tool_event', T)
      return a.artifactId
    }
    const mdId = mk('notes.md', '# hello')
    const htmlId = mk('page.html', '<p>hi</p>')
    const svgId = mk('logo.svg', '<svg/>')
    const inheritedId = mk('prototype.md', 'prototype key content')
    db.raw.prepare('UPDATE artifacts SET extension = ? WHERE artifact_id = ?').run('constructor', inheritedId)
    const docxId = mk('report.docx', 'PK')
    const outsideId = upsertArtifact(db, { path: '/etc/hosts', sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    const goneId = upsertArtifact(db, { path: join(dir, 'gone.md'), sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId

    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, reveal: async () => {}, openWith: async () => {} }))
    try {
      const md = await fetch(`${srv.base}/api/artifacts/${mdId}/preview`)
      assert.equal(md.status, 200)
      assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8')
      assert.equal(md.headers.get('content-length'), String(Buffer.byteLength('# hello')))
      assert.equal(md.headers.get('cache-control'), 'no-store')
      assert.equal(md.headers.get('content-disposition'), 'inline')
      assert.equal(md.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(await md.text(), '# hello')

      const html = await fetch(`${srv.base}/api/artifacts/${htmlId}/preview`)
      assert.equal(html.status, 200)
      assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(html.headers.get('content-security-policy'), "sandbox; default-src 'none'")

      assert.equal((await fetch(`${srv.base}/api/artifacts/${svgId}/preview`)).status, 415, 'svg can carry script: never previewed')
      assert.equal((await fetch(`${srv.base}/api/artifacts/${inheritedId}/preview`)).status, 415, 'prototype keys are not previewable extensions')
      assert.equal((await fetch(`${srv.base}/api/artifacts/${docxId}/preview`)).status, 415, 'office formats use /open, not /preview')
      assert.equal((await fetch(`${srv.base}/api/artifacts/${outsideId}/preview`)).status, 403, 'untrusted path')
      assert.equal((await fetch(`${srv.base}/api/artifacts/${goneId}/preview`)).status, 409, 'missing on disk')
      assert.equal(getArtifact(db, goneId)!.existsState, 'missing', 'a missing preview marks the row missing')
      assert.equal((await fetch(`${srv.base}/api/artifacts/999999/preview`)).status, 404)
      assert.equal((await fetch(`${srv.base}/api/artifacts/abc/preview`)).status, 400)
    } finally { await srv.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('preview refuses a symlink and a file over the size ceiling', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const real = join(dir, 'real.md'); writeFileSync(real, 'x')
    const link = join(dir, 'link.md'); symlinkSync(real, link)
    const linkId = upsertArtifact(db, { path: link, sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    const big = join(dir, 'big.md'); writeFileSync(big, 'x'.repeat(PREVIEW_MAX_BYTES + 1))
    const bigId = upsertArtifact(db, { path: big, sizeBytes: PREVIEW_MAX_BYTES + 1, createdAt: T, projectName: 'p', now: T }).artifactId

    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, reveal: async () => {}, openWith: async () => {} }))
    try {
      assert.equal((await fetch(`${srv.base}/api/artifacts/${linkId}/preview`)).status, 409, 'lstat sees the link, never follows it')
      assert.equal((await fetch(`${srv.base}/api/artifacts/${bigId}/preview`)).status, 413)
    } finally { await srv.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('open launches the default app only for external types and only for safe paths', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const docx = join(dir, 'r.docx'); writeFileSync(docx, 'PK')
    const docxId = upsertArtifact(db, { path: docx, sizeBytes: 2, createdAt: T, projectName: 'p', now: T }).artifactId
    const md = join(dir, 'n.md'); writeFileSync(md, 'x')
    const mdId = upsertArtifact(db, { path: md, sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    const outsideId = upsertArtifact(db, { path: '/etc/hosts', sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId

    const opened: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, {
      ...deps, reveal: async () => {}, openWith: async p => { opened.push(p) },
    }))
    try {
      const ok = await fetch(`${srv.base}/api/artifacts/${docxId}/open`, { method: 'POST', headers: postHeaders, body: '{}' })
      assert.equal(ok.status, 200)
      assert.deepEqual(await ok.json(), { opened: true })
      assert.deepEqual(opened, [docx])

      assert.equal((await fetch(`${srv.base}/api/artifacts/${mdId}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 415,
        'an inline-previewable type is not launched externally')
      assert.equal((await fetch(`${srv.base}/api/artifacts/${outsideId}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 403)
      assert.equal(opened.length, 1, 'no rejected request ever reached the launcher')
    } finally { await srv.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('preview and open reject sensitive and ignored artifacts before filesystem access', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const sensitiveText = join(dir, 'credentials.md'); writeFileSync(sensitiveText, 'secret')
    const sensitiveTextId = upsertArtifact(db, { path: sensitiveText, sizeBytes: 6, createdAt: T, projectName: 'p', now: T }).artifactId
    const sensitiveExternal = join(dir, 'credentials.pdf'); writeFileSync(sensitiveExternal, 'secret')
    const sensitiveExternalId = upsertArtifact(db, { path: sensitiveExternal, sizeBytes: 6, createdAt: T, projectName: 'p', now: T }).artifactId
    const ignored = join(dir, 'node_modules', 'ignored.md'); mkdirSync(join(dir, 'node_modules')); writeFileSync(ignored, 'ignored')
    const ignoredId = upsertArtifact(db, { path: ignored, sizeBytes: 7, createdAt: T, projectName: 'p', now: T }).artifactId

    const opened: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, {
      ...deps, reveal: async () => {}, openWith: async p => { opened.push(p) },
    }))
    try {
      assert.equal((await fetch(`${srv.base}/api/artifacts/${sensitiveTextId}/preview`)).status, 403)
      assert.equal((await fetch(`${srv.base}/api/artifacts/${sensitiveExternalId}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 403)
      assert.equal((await fetch(`${srv.base}/api/artifacts/${ignoredId}/preview`)).status, 403)
      assert.equal(getArtifact(db, sensitiveTextId)!.existsState, 'present')
      assert.equal(getArtifact(db, sensitiveExternalId)!.existsState, 'present')
      assert.deepEqual(opened, [])
    } finally { await srv.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// I2 (final review): a legacy row whose path is Claude's settings file (it can hold `env` secrets) or a file in the cost ledger
// directory must never be previewed, revealed or opened, even though its filename is not secret-looking and the row says so.
test('legacy preview, reveal and open refuse ~/.claude/settings.json, settings.local.json and cost-ledger/ files', async () => {
  const prevHome = process.env.HOME
  const home = tempDir('atlas-api-home-')
  process.env.HOME = home
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: home, startedAt: T, now: T })
    mkdirSync(join(home, '.claude', 'cost-ledger'), { recursive: true })
    const files = ['settings.json', 'settings.local.json', join('cost-ledger', 'notes.md'), 'CLAUDE.md']
    const ids = files.map(f => {
      const path = join(home, '.claude', f); writeFileSync(path, '{"env":{"TOKEN":"x"}}')
      const row = upsertArtifact(db, { path, sizeBytes: 20, createdAt: T, projectName: 'p', now: T })
      assert.equal(getArtifact(db, row.artifactId)!.isSensitive, false, `${f}: the row itself is not flagged, only the path gate can refuse it`)
      return row.artifactId
    })
    const touched: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, {
      ...deps, reveal: async p => { touched.push(p) }, openWith: async p => { touched.push(p) },
    }))
    try {
      for (const [i, f] of files.slice(0, 3).entries()) {
        const id = ids[i]
        assert.equal((await fetch(`${srv.base}/api/artifacts/${id}/preview`)).status, 403, `${f} preview`)
        assert.equal((await fetch(`${srv.base}/api/artifacts/${id}/reveal`, { method: 'POST', headers: postHeaders })).status, 403, `${f} reveal`)
        assert.equal((await fetch(`${srv.base}/api/artifacts/${id}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 403, `${f} open`)
      }
      assert.deepEqual(touched, [])
      // Control: a neighbour in the same folder is still served.
      assert.equal((await fetch(`${srv.base}/api/artifacts/${ids[3]}/reveal`, { method: 'POST', headers: postHeaders })).status, 200)
    } finally { await srv.close() }
  } finally {
    process.env.HOME = prevHome
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('open rejects missing and symlinked external files without launching', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const target = join(dir, 'target.pdf'); writeFileSync(target, 'pdf')
    const link = join(dir, 'link.pdf'); symlinkSync(target, link)
    const linkId = upsertArtifact(db, { path: link, sizeBytes: 3, createdAt: T, projectName: 'p', now: T }).artifactId
    const missingId = upsertArtifact(db, { path: join(dir, 'missing.pdf'), sizeBytes: 3, createdAt: T, projectName: 'p', now: T }).artifactId
    const opened: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, {
      ...deps, reveal: async () => {}, openWith: async p => { opened.push(p) },
    }))
    try {
      assert.equal((await fetch(`${srv.base}/api/artifacts/${linkId}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 409)
      assert.equal((await fetch(`${srv.base}/api/artifacts/${missingId}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 409)
      assert.equal(getArtifact(db, linkId)!.existsState, 'missing')
      assert.equal(getArtifact(db, missingId)!.existsState, 'missing')
      assert.deepEqual(opened, [])
    } finally { await srv.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('open reports launcher failures without claiming success', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    const path = join(dir, 'fail.pdf'); writeFileSync(path, 'pdf')
    const id = upsertArtifact(db, { path, sizeBytes: 3, createdAt: T, projectName: 'p', now: T }).artifactId
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, {
      ...deps, reveal: async () => {}, openWith: async () => { throw new Error('launcher failed') },
    }))
    try {
      assert.equal((await fetch(`${srv.base}/api/artifacts/${id}/open`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 500)
      assert.equal(getArtifact(db, id)!.existsState, 'present')
    } finally { await srv.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// R72 / C1 (Wave 2a fix round 1): the location actions share the verifier's proof. A path that cannot be checked (here the
// folder holding the file became a symlink loop: ELOOP) answers 409 and writes nothing; only a proven absence is "missing".
test('reveal, preview and open never mark a location missing on ELOOP; a proven absence still is', async () => {
  const db = openTestDb()
  const dir = tempDir('.atlas-test-', homedir())
  try {
    ensureSession(db, { sessionId: S1, cwd: dir, startedAt: T, now: T })
    mkdirSync(join(dir, 'sub'))
    const files = { md: join(dir, 'sub', 'notes.md'), pdf: join(dir, 'sub', 'paper.pdf') }
    for (const p of Object.values(files)) writeFileSync(p, 'x')
    const ids = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, upsertArtifact(db, { path: p, sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId])) as Record<string, number>
    writeFileSync(join(dir, 'other.md'), 'keeps the folder non-empty')
    const gone = join(dir, 'gone.md')
    const goneId = upsertArtifact(db, { path: gone, sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    // The folder becomes a symlink loop.
    rmSync(join(dir, 'sub'), { recursive: true })
    symlinkSync('sub', join(dir, 'sub'))
    const opened: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, reveal: async p => { opened.push(p) }, openWith: async p => { opened.push(p) } }))
    try {
      const reveal = await fetch(`${srv.base}/api/artifacts/${ids.md}/reveal`, { method: 'POST', headers: postHeaders })
      assert.equal(reveal.status, 409)
      const preview = await fetch(`${srv.base}/api/artifacts/${ids.md}/preview`)
      assert.equal(preview.status, 409)
      const open = await fetch(`${srv.base}/api/artifacts/${ids.pdf}/open`, { method: 'POST', headers: postHeaders, body: '{}' })
      assert.equal(open.status, 409)
      assert.deepEqual([getArtifact(db, ids.md!)!.existsState, getArtifact(db, ids.pdf!)!.existsState], ['present', 'present'], 'nothing proves the files are gone')
      assert.deepEqual(opened, [])
      // Control: ENOENT in a reachable, non-empty folder on its own filesystem is proof.
      assert.equal((await fetch(`${srv.base}/api/artifacts/${goneId}/reveal`, { method: 'POST', headers: postHeaders })).status, 409)
      assert.equal(getArtifact(db, goneId)!.existsState, 'missing')
    } finally { await srv.close() }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// An ignored-name path under a registered root is authorized by its canonical path, which stays inside home and the root. Only the
// spelling check then refuses a path that differs from the canonical one by more than home's own link (here a symlinked folder).
test('under a symlinked home, the legacy gate refuses an ignored-name path spelled through a symlinked folder inside home', async () => {
  const prevHome = process.env.HOME
  const root = realpathSync(tempDir('atlas-api-symfolder-'))
  const real = join(root, 'real'), link = join(root, 'link')
  mkdirSync(real, { recursive: true }); symlinkSync(real, link)
  process.env.HOME = link
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: link, startedAt: T, now: T })
    mkdirSync(join(real, 'out', 'node_modules'), { recursive: true })
    writeFileSync(join(real, 'out', 'node_modules', 'n.md'), 'x')
    symlinkSync(join(real, 'out'), join(real, 'alias'))
    const viaAlias = upsertArtifact(db, { path: join(link, 'alias', 'node_modules', 'n.md'), sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    const direct = upsertArtifact(db, { path: join(link, 'out', 'node_modules', 'n.md'), sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    registerArtifactRoot(db, { kind: 'output', canonicalPath: join(real, 'out'), repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T)
    const touched: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, home: link, reveal: async p => { touched.push(p) }, openWith: async p => { touched.push(p) } }))
    try {
      const status = async (id: number, route: 'reveal' | 'preview' | 'open') => (await fetch(`${srv.base}/api/artifacts/${id}/${route}`,
        route === 'preview' ? undefined : { method: 'POST', headers: postHeaders, body: '{}' })).status
      for (const route of ['reveal', 'preview', 'open'] as const) assert.equal(await status(viaAlias, route), 403, `${route}: a symlinked folder inside home is not home's own link`)
      assert.deepEqual(touched, [], 'nothing is revealed or opened for the refused spelling')
      assert.equal(await status(direct, 'reveal'), 200, 'control: the same file spelled with home\'s literal prefix only is served')
      assert.deepEqual(touched, [join(link, 'out', 'node_modules', 'n.md')])
    } finally { await srv.close() }
  } finally {
    process.env.HOME = prevHome
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// A home reached through a symlink (macOS /var -> /private/var): the legacy gates judge a path against home like with like, so a
// file in the home is served, a file whose real path leaves the real home is refused, and a path the ignore rules flag but a
// registered root covers is judged by the root policy, not refused for the spelling of home.
test('under a symlinked home, legacy reveal serves the home\'s own files and still refuses a link out of it', async () => {
  const prevHome = process.env.HOME
  const root = realpathSync(tempDir('atlas-api-symhome-'))
  const real = join(root, 'real'), link = join(root, 'link')
  mkdirSync(real, { recursive: true }); symlinkSync(real, link)
  const outside = realpathSync(tempDir('atlas-api-outside-'))
  process.env.HOME = link
  const db = openTestDb()
  try {
    ensureSession(db, { sessionId: S1, cwd: link, startedAt: T, now: T })
    mkdirSync(join(real, 'docs')); mkdirSync(join(real, 'out', 'node_modules'), { recursive: true })
    writeFileSync(join(real, 'docs', 'a.md'), 'x'); writeFileSync(join(real, 'out', 'node_modules', 'n.md'), 'x'); writeFileSync(join(outside, 'o.md'), 'x')
    symlinkSync(outside, join(real, 'esc'))
    const mk = (path: string) => upsertArtifact(db, { path, sizeBytes: 1, createdAt: T, projectName: 'p', now: T }).artifactId
    const ok = mk(join(link, 'docs', 'a.md')), okReal = mk(join(real, 'docs', 'a.md'))
    const escaped = mk(join(link, 'esc', 'o.md'))
    const ignoredInRoot = mk(join(link, 'out', 'node_modules', 'n.md'))
    registerArtifactRoot(db, { kind: 'output', canonicalPath: join(real, 'out'), repositoryId: null, projectName: null, checkoutIdentity: null, protected: false, scopeFlags: ['cli-output'] }, T)
    const touched: string[] = []
    const srv = await startRouteServer(db, (router, deps) => registerArtifactRoutes(router, { ...deps, home: link, reveal: async p => { touched.push(p) }, openWith: async p => { touched.push(p) } }))
    try {
      const reveal = async (id: number) => (await fetch(`${srv.base}/api/artifacts/${id}/reveal`, { method: 'POST', headers: postHeaders })).status
      assert.equal(await reveal(ok), 200, 'literal spelling of a file in home')
      assert.equal(await reveal(okReal), 200, 'real spelling of a file in home')
      assert.equal(await reveal(ignoredInRoot), 200, 'an ignored-name path under a registered root, literal spelling')
      assert.equal(await reveal(escaped), 403, 'a link whose real path leaves the real home')
      assert.deepEqual(touched.sort(), [join(link, 'docs', 'a.md'), join(link, 'out', 'node_modules', 'n.md'), join(real, 'docs', 'a.md')].sort())
    } finally { await srv.close() }
  } finally {
    process.env.HOME = prevHome
    db.close()
    rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
  }
})
