import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The runner is loaded only here, with spawn patched to count and throw, so a broken import.meta.main guard
// cannot start a real test run (which would include this file and recurse). syncBuiltinESMExports makes the
// ESM named export of spawn see the patch.
const childProcess = createRequire(import.meta.url)('node:child_process') as { spawn: unknown }
const realSpawn = childProcess.spawn
let spawnCalls = 0
childProcess.spawn = () => { spawnCalls++; throw new Error('importing the runner must not spawn') }
syncBuiltinESMExports()
let runner: typeof import('../../scripts/run-tests.ts')
try {
  runner = await import('../../scripts/run-tests.ts')
} finally {
  childProcess.spawn = realSpawn
  syncBuiltinESMExports()
}
const { exitStatus, testArgs, testConcurrency } = runner

test('testConcurrency is half the CPUs, at least one', () => {
  const cases: Array<[number, number]> = [[12, 6], [4, 2], [3, 1], [2, 1], [1, 1], [0, 1], [NaN, 1], [13, 6]]
  for (const [cpus, want] of cases) assert.equal(testConcurrency(cpus), want, `cpus=${cpus}`)
})

test('testArgs builds the node test command', () => {
  assert.deepEqual(testArgs(4, []), [
    '--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=2', 'test/**/*.test.ts',
  ])
})

test('testArgs puts extra arguments after the glob', () => {
  const args = testArgs(12, ['--foo', 'bar'])
  assert.deepEqual(args.slice(-3), ['test/**/*.test.ts', '--foo', 'bar'])
  assert.ok(args.includes('--test-concurrency=6'))
})

test('package.json test script runs the runner exactly', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts.test, 'node --disable-warning=ExperimentalWarning scripts/run-tests.ts')
})

test('importing the runner module starts no test run', () => {
  assert.equal(spawnCalls, 0)
  assert.equal(typeof runner.testArgs, 'function')
})

test('exitStatus reports a signal death as 128 plus the signal number', () => {
  assert.equal(exitStatus(0, null), 0)
  assert.equal(exitStatus(1, null), 1)
  assert.equal(exitStatus(null, 'SIGINT'), 130)
  assert.equal(exitStatus(null, 'SIGHUP'), 129)
  assert.equal(exitStatus(null, 'SIGKILL'), 137)
  assert.equal(exitStatus(null, null), 1)
})
