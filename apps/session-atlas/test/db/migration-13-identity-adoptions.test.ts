import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrate, openDatabase } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { openTestDb } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

// Migration 13 (PR #19 follow-up review, finding 4, ruling R93): one adoption cursor per checkout root. Additive only.

test('migration 13 only creates the cursor table and its index: no rebuild, no preflight guard, no foreign-key opt-out', () => {
  const m = MIGRATIONS.find(x => x.id === 13)!
  assert.equal(m.name, 'artifact-identity-adoptions')
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1]!.id, 13)
  assert.equal(m.noForeignKeys, undefined)
  assert.equal(m.after, undefined)
  assert.doesNotMatch(m.sql, /\b(DROP|ALTER|INSERT|UPDATE|DELETE)\b/i)
  assert.equal((m.sql.match(/CREATE TABLE/gi) ?? []).length, 1)
})

test('a schema-12 database gains the empty cursor table and keeps everything else; a second migrate is a no-op', () => {
  const fresh = openTestDb()
  const cols = (fresh.raw.prepare('PRAGMA table_info(artifact_identity_adoptions)').all() as Array<{ name: string; notnull: number; pk: number }>).map(c => [c.name, c.notnull, c.pk].join())
  assert.deepEqual(cols, ['root_id,0,1', 'after_path,0,0', 'requested_at,1,0', 'updated_at,1,0', 'failures,1,0'])
  fresh.close()

  const path = join(tempDir('atlas-m13-'), 'atlas.db')
  const old = openDatabase(path, { migrate: false })
  migrate(old, MIGRATIONS.filter(m => m.id <= 12))
  assert.equal(old.raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'artifact_identity_adoptions'`).get()!.n, 0)
  old.close()
  const db = openDatabase(path)
  assert.deepEqual(db.raw.prepare('SELECT id FROM schema_migrations WHERE id > 11 ORDER BY id').all().map(r => (r as { id: number }).id), [12, 13])
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM artifact_identity_adoptions').get()!.n, 0)
  assert.equal(migrate(db), 0)
  assert.equal((db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  db.close()
})
