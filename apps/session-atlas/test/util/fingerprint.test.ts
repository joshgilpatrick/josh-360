import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha1Hex } from '../../src/util/fingerprint.ts'
import { isoFromEpochMs, nowIso } from '../../src/util/time.ts'

test('sha1Hex is deterministic and separator-safe', () => {
  assert.equal(sha1Hex('a', 'b'), sha1Hex('a', 'b'))
  assert.notEqual(sha1Hex('ab', ''), sha1Hex('a', 'b'))
  assert.match(sha1Hex('x'), /^[0-9a-f]{40}$/)
})

test('time helpers produce ISO-8601 UTC', () => {
  assert.equal(isoFromEpochMs(0), '1970-01-01T00:00:00.000Z')
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})
