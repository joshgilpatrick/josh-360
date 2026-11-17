// The perf suite's machine-readable records carry the machine load (also on macOS) and the time they were written.
// Runs without ATLAS_PERF: it only exercises the record helpers, never a measurement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineLoad, perfLine, perfRecordMetrics } from '../helpers/artifact-manager-perf-harness.ts'

test('machineLoad is a 1/5/15-minute load triple with two decimals on linux and darwin', { skip: ['linux', 'darwin'].includes(process.platform) ? false : `not checked on ${process.platform}` }, () => {
  assert.match(machineLoad(), /^\d+\.\d{2}\/\d+\.\d{2}\/\d+\.\d{2}$/)
})

test('perfRecordMetrics appends at and load after the caller metrics', () => {
  const m = perfRecordMetrics({ a: 1 })
  assert.deepEqual(Object.keys(m), ['a', 'at', 'load'])
  assert.ok(m.at.endsWith('Z'))
  assert.ok(Math.abs(Date.parse(m.at) - Date.now()) < 5000)
})

test('perfRecordMetrics keeps a load the caller already carries, once', () => {
  const m = perfRecordMetrics({ a: 1, load: 'x' })
  assert.equal(m.load, 'x')
  assert.deepEqual(Object.keys(m), ['a', 'load', 'at'])
})

test('a record line keeps its current prefix', () => {
  const orig = console.log
  console.log = () => {}
  let line: string
  try { line = perfLine('target', perfRecordMetrics({ test: 'PERF-06', target: 'T6' })) } finally { console.log = orig }
  assert.ok(line.startsWith('PERF target test=PERF-06 target=T6 '), line)
})
