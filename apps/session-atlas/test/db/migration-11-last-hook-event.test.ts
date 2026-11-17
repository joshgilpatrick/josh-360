import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrate, openDatabase } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'
import { ensureSession } from '../../src/db/sessions.ts'
import { openTestDb } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

// Migration 11 (PR #19 follow-up review, ruling R89): sessions.last_hook_event_at is the producer chronology that delivery order
// cannot fake. Additive: one nullable column, no rebuild, so no preflight guard. Existing rows stay NULL.

const T = '2026-10-01T00:00:00.000Z'
const S1 = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'

test('migration 11 is additive (one ALTER ... ADD COLUMN), needs no preflight guard or foreign-key opt-out, and the next id is not used here', () => {
  const m = MIGRATIONS.find(x => x.id === 11)!
  assert.equal(m.name, 'session-last-hook-event')
  assert.equal(m.noForeignKeys, undefined)
  assert.equal(m.after, undefined)
  assert.doesNotMatch(m.sql, /\b(DROP|CREATE|INSERT|UPDATE|DELETE)\b/i)
  assert.equal((m.sql.match(/ALTER TABLE/gi) ?? []).length, 1)
  assert.match(m.sql, /ADD COLUMN last_hook_event_at TEXT;/)
})

test('a fresh database has a nullable last_hook_event_at with no default; a populated schema-10 database keeps every row and gets NULL', () => {
  const fresh = openTestDb()
  const col = (fresh.raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>).find(c => c.name === 'last_hook_event_at')
  assert.ok(col)
  assert.equal(col.notnull, 0)
  assert.equal(col.dflt_value, null)
  fresh.close()

  const path = join(tempDir('atlas-m11-'), 'atlas.db')
  const old = openDatabase(path, { migrate: false })
  migrate(old, MIGRATIONS.filter(m => m.id <= 10))
  ensureSession(old, { sessionId: S1, cwd: '/x/keystone', startedAt: T, now: T })
  old.close()
  const db = openDatabase(path)
  assert.deepEqual(db.raw.prepare('SELECT id FROM schema_migrations WHERE id > 10').all().map(r => (r as { id: number }).id), [11, 12, 13])
  assert.equal((db.raw.prepare('SELECT last_hook_event_at AS v FROM sessions WHERE session_id = ?').get(S1) as { v: string | null }).v, null)
  assert.equal(migrate(db), 0, 'a no-op the second time')
  assert.equal((db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  db.close()
})
