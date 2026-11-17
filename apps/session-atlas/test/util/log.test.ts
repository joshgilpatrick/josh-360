import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { createLogger } from '../../src/util/log.ts'

const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { msg: string })

test('createLogger appends one JSON line per call', () => {
  const path = join(tempDir('atlas-log-'), 'atlas.log')
  const log = createLogger(path)
  log.info('one', { a: 1 })
  log.warn('two')
  assert.deepEqual(lines(path).map(l => l.msg), ['one', 'two'])
})

test('createLogger rotates to <path>.1 once the file passes maxBytes, and starts a new file', () => {
  const path = join(tempDir('atlas-log-'), 'atlas.log')
  const log = createLogger(path, { maxBytes: 200, checkEvery: 1 })
  for (let i = 0; i < 10; i++) log.info(`line-${i}`, { pad: 'x'.repeat(40) })
  assert.ok(existsSync(`${path}.1`), 'the full log was kept as .1')
  assert.ok(statSync(path).size <= 200 + 120, `current log stays near the cap, got ${statSync(path).size}`)
  const all = [...lines(`${path}.1`), ...lines(path)].map(l => l.msg)
  assert.equal(all.at(-1), 'line-9', 'the newest line is in the current file')
  assert.ok(all.length >= 3, 'lines from before the last rotation survive in .1')
})

test('createLogger keeps only one old file: a second rotation replaces <path>.1', () => {
  const path = join(tempDir('atlas-log-'), 'atlas.log')
  writeFileSync(`${path}.1`, 'stale\n')
  const log = createLogger(path, { maxBytes: 100, checkEvery: 1 })
  for (let i = 0; i < 20; i++) log.info(`r-${i}`, { pad: 'y'.repeat(40) })
  assert.ok(!readFileSync(`${path}.1`, 'utf8').includes('stale'), 'the older .1 was replaced')
  assert.ok(!existsSync(`${path}.2`), 'no .2 is created')
})

test('createLogger rotates an existing oversized file at the first size check after start', () => {
  const path = join(tempDir('atlas-log-'), 'atlas.log')
  writeFileSync(path, 'z'.repeat(5_000) + '\n')
  const log = createLogger(path, { maxBytes: 1_000, checkEvery: 1 })
  log.info('after-start')
  assert.equal(statSync(`${path}.1`).size, 5_001)
  assert.deepEqual(lines(path).map(l => l.msg), ['after-start'])
})

test('createLogger checks the size only every checkEvery writes', () => {
  const path = join(tempDir('atlas-log-'), 'atlas.log')
  const log = createLogger(path, { maxBytes: 50, checkEvery: 1_000 })
  for (let i = 0; i < 20; i++) log.info(`n-${i}`)
  assert.ok(!existsSync(`${path}.1`), 'no rotation before the first size check')
})
