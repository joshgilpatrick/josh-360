// JP-159: `npm run recompute-projects` runs again, and no package.json script points at a file that is not there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestDb } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'
import { openDatabase } from '../../src/db/database.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { addOrigin, getArtifact, upsertArtifact } from '../../src/db/artifacts.ts'
import { configureSensitivePatterns } from '../../src/artifacts/filetype.ts'
import { configureProjectNaming } from '../../src/util/project-name.ts'
import { recomputeProjectNames } from '../../src/cli/recompute-projects.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const T = '2026-11-18T00:00:00.000Z'

function projectOf(db: ReturnType<typeof openTestDb>, sessionId: string): string | null {
  return (db.raw.prepare('SELECT project_name FROM sessions WHERE session_id = ?').get(sessionId) as { project_name: string | null }).project_name
}

test('an alias added later rewrites the stored session and artifact project names', () => {
  configureProjectNaming({ aliases: {} })
  configureSensitivePatterns([])
  const db = openTestDb()
  ensureSession(db, { sessionId: S1, cwd: '/x/sample/keystone', startedAt: T, now: T })
  const a = upsertArtifact(db, { path: '/x/sample/keystone/notes.md', sizeBytes: 1, createdAt: T, projectName: 'keystone', now: T })
  addOrigin(db, a.artifactId, S1, 'creator', 'tool_event', T)
  assert.equal(projectOf(db, S1), 'keystone')

  configureProjectNaming({ aliases: { '/x/sample': 'sample-alias' } })
  const r = recomputeProjectNames(db)
  assert.deepEqual(r, { sessions: 1, artifacts: 1, sensitive: 0 })
  assert.equal(projectOf(db, S1), 'sample-alias')
  assert.equal(getArtifact(db, a.artifactId)!.projectName, 'sample-alias', 'an artifact follows its creator session')

  assert.deepEqual(recomputeProjectNames(db), { sessions: 0, artifacts: 0, sensitive: 0 }, 'a second run changes nothing')
  configureProjectNaming({ aliases: {} })
  db.close()
})

test('a new sensitive pattern raises the flag and never lowers one', () => {
  configureProjectNaming({ aliases: {} })
  configureSensitivePatterns([])
  const db = openTestDb()
  const plain = upsertArtifact(db, { path: '/x/sample/roster-export.txt', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  const manual = upsertArtifact(db, { path: '/x/sample/readme.txt', sizeBytes: 1, createdAt: T, projectName: null, now: T })
  db.raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ?').run(manual.artifactId)
  assert.equal(getArtifact(db, plain.artifactId)!.isSensitive, false)

  configureSensitivePatterns(['roster-*'])
  assert.equal(recomputeProjectNames(db).sensitive, 1)
  assert.equal(getArtifact(db, plain.artifactId)!.isSensitive, true)
  assert.equal(getArtifact(db, manual.artifactId)!.isSensitive, true, 'a flag the filename does not explain is kept')
  configureSensitivePatterns([])
  db.close()
})

function runScript(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, JOSH360_HOME: join(home, '.josh-360') }
  delete env.ATLAS_HOME
  delete env.ATLAS_STATE_DIR
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'recompute-projects'], { cwd: APP, encoding: 'utf8', timeout: 60_000, env })
}

test('npm run recompute-projects runs against the configured database and prints its counts', () => {
  const home = tempDir('atlas-recompute-')
  openDatabase(join(home, '.josh-360', 'state', 'cache.db')).close()
  const r = runScript(home)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^sessions=0 artifacts=0 sensitive=0$/m)
})

test('with no cache.db it changes nothing, creates nothing and exits 1', () => {
  const home = tempDir('atlas-recompute-')
  const r = runScript(home)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /cache\.db does not exist/)
  assert.equal(existsSync(join(home, '.josh-360', 'state', 'cache.db')), false)
})

test('every package.json script names a file that exists', () => {
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const file of command.match(/\b(?:src|scripts)\/[\w./-]+\.ts\b/g) ?? []) {
      assert.ok(existsSync(join(APP, file)), `${name}: ${file} does not exist`)
    }
  }
  assert.equal(pkg.scripts.backfill, undefined, 'the transcript backfill is the ledger\'s job since JP-111')
})
