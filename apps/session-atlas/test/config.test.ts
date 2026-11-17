import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir } from './helpers/tmp.ts'
import { loadConfig } from '../src/config.ts'
import { ARTIFACT_DEFAULT_FRAME_ROWS } from '../src/artifacts/contracts.ts'
import { ARTIFACT_IPC_LIMITS } from '../src/artifacts/discovery.ts'

test('defaults derive from HOME and ATLAS_PORT', () => {
  const home = tempDir('atlas-home-')
  const cfg = loadConfig({ HOME: home })
  assert.equal(cfg.josh360Dir, join(home, '.josh-360'))
  assert.equal(cfg.atlasDir, join(home, '.josh-360', 'atlas'))
  assert.equal(cfg.dbPath, join(home, '.josh-360', 'state', 'cache.db'))
  assert.equal(cfg.ledgerPath, cfg.dbPath, 'the cost import and the catalog share cache.db')
  assert.equal(cfg.factsPath, join(home, '.josh-360', 'state', 'ledger.db'))
  assert.equal(cfg.spoolDir, join(home, '.josh-360', 'atlas', 'spool'))
  assert.equal(cfg.projectsDir, join(home, '.claude', 'projects'))
  assert.equal(cfg.host, '127.0.0.1')
  assert.equal(cfg.port, 8770)
})



test('invalid port falls back to default', () => {
  const cfg = loadConfig({ HOME: '/tmp/x', ATLAS_PORT: 'abc' })
  assert.equal(cfg.port, 8770)
})

test('out-of-range port falls back to default', () => {
  const cfg = loadConfig({ HOME: '/tmp/x', ATLAS_PORT: '70000' })
  assert.equal(cfg.port, 8770)
})

test('a non-numeric worker.pollMs override falls back to the default', () => {
  const home = tempDir('atlas-home-')
  const cfgPath = join(home, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ worker: { pollMs: 'fast' } }))
  const cfg = loadConfig({ HOME: home }, cfgPath)
  assert.equal(cfg.worker.pollMs, 500)
})

test('a worker.pollMs override below the floor is clamped, never 0 or NaN', () => {
  const home = tempDir('atlas-home-')
  const cfgPath = join(home, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ worker: { pollMs: 0 } }))
  const cfg = loadConfig({ HOME: home }, cfgPath)
  assert.equal(cfg.worker.pollMs, 100)
})

test('a worker.pollMs override above the ceiling is clamped', () => {
  const home = tempDir('atlas-home-')
  const cfgPath = join(home, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ worker: { pollMs: 999_999 } }))
  const cfg = loadConfig({ HOME: home }, cfgPath)
  assert.equal(cfg.worker.pollMs, 60_000)
})


test('transcript.maxLineBytes defaults to 64 MiB and is clamped to 0..256 MiB', () => {
  const home = tempDir('atlas-home-')
  assert.equal(loadConfig({ HOME: home }).transcript.maxLineBytes, 64 * 1024 * 1024)
  const cfgPath = join(home, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ transcript: { maxLineBytes: 10 * 1024 * 1024 * 1024 } }))
  assert.equal(loadConfig({ HOME: home }, cfgPath).transcript.maxLineBytes, 256 * 1024 * 1024)
  writeFileSync(cfgPath, JSON.stringify({ transcript: { maxLineBytes: 'big' } }))
  assert.equal(loadConfig({ HOME: home }, cfgPath).transcript.maxLineBytes, 64 * 1024 * 1024)
})







// Named provider presets. Each preset only fills defaults for the existing gateway path
// (baseUrl + Bearer token); provider.ts keeps dispatching on baseUrl presence.





// Reasoning models served via OpenRouter (e.g. DeepSeek) spend output tokens on thinking before
// the JSON; the Anthropic default of 1500 was observed to hit max_tokens, 4000 was not.

test('artifacts, projects, and sessions blocks default and validate their types', () => {
  const home = tempDir('atlas-home-')
  const base = loadConfig({ HOME: home })
  assert.deepEqual(base.artifacts.ignoreSegments, ['.scratch'])
  assert.deepEqual(base.artifacts.sensitivePatterns, ['*.kdbx'])
  assert.deepEqual(base.projects, { aliases: {} })
  assert.deepEqual(base.sessions, { idleCloseHours: 12 })

  const path = join(home, 'config.json')
  writeFileSync(path, JSON.stringify({
    artifacts: { ignoreSegments: ['.drafts', 7, ' '], sensitivePatterns: 'nope' },
    projects: { aliases: { '/Users/me/dev/x/': 'x-alias', '/bad': 3 } },
    sessions: { idleCloseHours: '48' },
  }))
  const cfg = loadConfig({ HOME: home }, path)
  assert.deepEqual(cfg.artifacts.ignoreSegments, ['.drafts'], 'a configured list replaces the default; blanks and non-strings are dropped')
  assert.deepEqual(cfg.artifacts.sensitivePatterns, ['*.kdbx'], 'a malformed list falls back to the default')
  assert.deepEqual(cfg.artifacts.warnings, [
    'artifacts.ignoreSegments: ignored 2 entries that were not non-blank strings',
    'artifacts.sensitivePatterns: expected a list of strings; using the default',
  ])
  assert.deepEqual(cfg.projects.aliases, { '/Users/me/dev/x': 'x-alias' })
  assert.equal(cfg.sessions.idleCloseHours, 48)

  writeFileSync(path, JSON.stringify({ sessions: { idleCloseHours: 0 }, projects: 'nope', artifacts: [] }))
  const clamped = loadConfig({ HOME: home }, path)
  assert.equal(clamped.sessions.idleCloseHours, 1)
  assert.deepEqual(clamped.projects.aliases, {})
  assert.deepEqual(clamped.artifacts.ignoreSegments, ['.scratch'])

  writeFileSync(path, JSON.stringify({ artifacts: { ignoreSegments: [], sensitivePatterns: [] } }))
  const optedOut = loadConfig({ HOME: home }, path).artifacts
  assert.deepEqual([optedOut.ignoreSegments, optedOut.sensitivePatterns], [[], []], 'an explicit empty list clears the default')
})

const DEFAULT_DOCUMENT_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'json', 'sql']
const MIB = 1024 * 1024
// [key, default, min, max]: the spec's section 14 defaults and the task's clamp bounds, written out independently of src/config.ts.
const ARTIFACT_NUMBERS: Array<[string, number, number, number]> = [
  ['initialLookbackDays', 7, 0, 3650],
  ['recoveryIntervalMs', 600_000, 60_000, 86_400_000],
  ['statusMinIntervalMs', 30_000, 30_000, 3_600_000],
  ['debounceMs', 2000, 0, 30_000],
  ['maxEntriesPerSlice', 5000, 100, 50_000],
  ['maxSliceMs', 2000, 100, 10_000],
  // Wave 2b (PERF-GAP-3): rows per catalog commit; the frozen 250-row frame maximum is the ceiling.
  ['maxRowsPerFrame', 32, 1, 250],
  ['gitTimeoutMs', 10_000, 1000, 60_000],
  ['gitMaxOutputBytes', 8 * MIB, 1 * MIB, 64 * MIB],
  ['hashMaxFileBytes', 64 * MIB, 0, 1024 * MIB],
  ['hashMaxJobBytes', 128 * MIB, 0, 1024 * MIB],
  ['hashMaxJobMs', 5000, 0, 60_000],
]

function artifactsFrom(artifacts: unknown, home = tempDir('atlas-home-')) {
  const path = join(home, 'config.json')
  writeFileSync(path, JSON.stringify({ artifacts }))
  return loadConfig({ HOME: home }, path).artifacts
}

test('artifact manager defaults match the spec', () => {
  const home = tempDir('atlas-home-')
  assert.deepEqual(loadConfig({ HOME: home }).artifacts, {
    ignoreSegments: ['.scratch'],
    sensitivePatterns: ['*.kdbx'],
    documentExtensions: DEFAULT_DOCUMENT_EXTENSIONS,
    outputRoots: [],
    durableOutputBase: join(home, '.claude', 'artifact-output'),
    initialLookbackDays: 7,
    recoveryIntervalMs: 600_000,
    statusMinIntervalMs: 30_000,
    debounceMs: 2000,
    maxEntriesPerSlice: 5000,
    maxSliceMs: 2000,
    maxRowsPerFrame: 32,
    gitTimeoutMs: 10_000,
    gitMaxOutputBytes: 8_388_608,
    hashMaxFileBytes: 67_108_864,
    hashMaxJobBytes: 134_217_728,
    hashMaxJobMs: 5000,
    warnings: [],
  })
  assert.deepEqual(artifactsFrom({}, home).warnings, [], 'an empty block warns about nothing')
})

test('valid artifact manager overrides are accepted unchanged and an unrelated block is untouched', () => {
  const home = tempDir('atlas-home-')
  const path = join(home, 'config.json')
  writeFileSync(path, JSON.stringify({ worker: { pollMs: 900 }, artifacts: { debounceMs: 500, gitTimeoutMs: 20_000, initialLookbackDays: 30, documentExtensions: ['md'] } }))
  const cfg = loadConfig({ HOME: home }, path)
  assert.equal(cfg.artifacts.debounceMs, 500)
  assert.equal(cfg.artifacts.gitTimeoutMs, 20_000)
  assert.equal(cfg.artifacts.initialLookbackDays, 30)
  assert.deepEqual(cfg.artifacts.documentExtensions, ['md'])
  assert.equal(cfg.artifacts.maxEntriesPerSlice, 5000, 'unset keys keep their defaults')
  assert.deepEqual(cfg.artifacts.warnings, [])
  assert.equal(cfg.worker.pollMs, 900)
})

for (const [key, fallback, min, max] of ARTIFACT_NUMBERS) {
  test(`artifacts.${key} clamps to ${min}..${max} and rejects non-numbers`, () => {
    const home = tempDir('atlas-home-')
    const get = (v: unknown) => (artifactsFrom({ [key]: v }, home) as unknown as Record<string, number>)[key]
    assert.equal(get(min), min)
    assert.equal(get(max), max)
    assert.equal(get(Math.floor((min + max) / 2)), Math.floor((min + max) / 2))
    assert.equal(get(min - 1), min, 'below the floor clamps up')
    assert.equal(get(max + 1), max, 'above the ceiling clamps down')
    assert.equal(get(-5_000_000), min)
    assert.equal(get(String(max + 1)), max, 'a numeric string is coerced then clamped')
    for (const bad of ['fast', '', '  ', null, true, [], {}, [5]]) assert.equal(get(bad), fallback, `${JSON.stringify(bad)} falls back to the default, not to a bound or zero`)

    const path = join(home, 'raw.json')
    writeFileSync(path, `{"artifacts":{"${key}":1e999}}`) // JSON.parse yields Infinity
    assert.equal((loadConfig({ HOME: home }, path).artifacts as unknown as Record<string, number>)[key], fallback, 'Infinity is rejected')

    const warned = (v: unknown) => artifactsFrom({ [key]: v }, home).warnings
    assert.deepEqual(warned(fallback), [], 'an in-range value is silent')
    assert.equal(warned(max + 1).length, 1)
    assert.match(warned(max + 1)[0]!, new RegExp(`^artifacts\\.${key}: `))
    assert.equal(warned('fast').length, 1)
    assert.doesNotMatch(warned('fast')[0]!, /fast/, 'warnings never echo the offending value')
  })
}

test('artifacts.maxRowsPerFrame defaults to the contract default and its ceiling is the frozen frame maximum (Wave 2b)', () => {
  assert.equal(ARTIFACT_DEFAULT_FRAME_ROWS, 32)
  assert.equal(loadConfig({ HOME: tempDir('atlas-home-') }).artifacts.maxRowsPerFrame, ARTIFACT_DEFAULT_FRAME_ROWS)
  assert.equal(artifactsFrom({ maxRowsPerFrame: 100_000 }).maxRowsPerFrame, ARTIFACT_IPC_LIMITS.maxRows, 'never above 250 rows')
  assert.equal(artifactsFrom({ maxRowsPerFrame: 0 }).maxRowsPerFrame, 1, 'never an empty frame')
})

test('artifact numbers are whole numbers: fractions truncate before the bounds apply', () => {
  assert.equal(artifactsFrom({ debounceMs: 2500.9 }).debounceMs, 2500)
  assert.equal(artifactsFrom({ maxEntriesPerSlice: 99.9 }).maxEntriesPerSlice, 100)
  assert.equal(artifactsFrom({ initialLookbackDays: 0.9 }).initialLookbackDays, 0, 'zero lookback is a valid choice')
})

test('documentExtensions are normalized to lowercase without dots, deduplicated, and invalid entries are dropped with a warning', () => {
  const cfg = artifactsFrom({ documentExtensions: ['MD', '.Txt', ' pdf ', 'md', 'tar.gz', '', 7, '*.csv', 'a/b', 'x'.repeat(40), 'ok_1', 'dot-sql', '.'] })
  assert.deepEqual(cfg.documentExtensions, ['md', 'txt', 'pdf', 'ok_1', 'dot-sql'])
  const dropped = ['[4]', '[5]', '[6]', '[7]', '[8]', '[9]', '[12]']
  for (const idx of dropped) assert.ok(cfg.warnings.some(w => w.startsWith(`artifacts.documentExtensions${idx}: `)), `warns about entry ${idx}`)
  assert.equal(cfg.warnings.length, dropped.length, 'duplicates are folded silently; nothing else warns')
  assert.ok(cfg.warnings.every(w => !w.includes('tar.gz') && !w.includes('a/b')), 'warnings never echo the entry')
  assert.deepEqual(artifactsFrom({ documentExtensions: [...DEFAULT_DOCUMENT_EXTENSIONS, 'LOG'] }).documentExtensions, [...DEFAULT_DOCUMENT_EXTENSIONS, 'log'])
})

test('a documentExtensions value with nothing usable falls back to the default set with a warning', () => {
  for (const bad of ['md', 5, {}, [], ['!!', 3, ''], [null]]) {
    const cfg = artifactsFrom({ documentExtensions: bad })
    assert.deepEqual(cfg.documentExtensions, DEFAULT_DOCUMENT_EXTENSIONS, JSON.stringify(bad))
    assert.ok(cfg.warnings.some(w => w.startsWith('artifacts.documentExtensions')), JSON.stringify(bad))
  }
})

test('outputRoots keep valid entries (absolute or home-relative), normalized, and disable every malformed one with a warning', () => {
  const home = tempDir('atlas-home-')
  const cfg = artifactsFrom({
    outputRoots: [
      { path: '~/reports', label: 'Reports', protected: true, repositoryId: 'repo-uuid' },
      { path: `${home}/exports/` },
      { path: 'docs' },
      { path: '~' },
      { path: '/' },
      { path: dirname(home) },
      { path: home },
      { path: '~/a/../..' },
      { path: '~/a/../b' },
      { path: '~bob/x' },
      { path: '' },
      { path: 5 },
      { path: '~/bad\nname' },
      { path: '~/bad\u0000name' },
      { label: 'no path' },
      '~/plain-string',
      null,
      ['~/array'],
      { path: '~/ok1', protected: 'yes' },
      { path: '~/ok2', repositoryId: 5 },
      { path: '~/ok3', repositoryId: '  ' },
      { path: '~/ok4', label: 5 },
      { path: '~/ok5', label: 'x'.repeat(201) },
      { path: '~//etc' }, // ~ expansion would resolve this to /etc, outside the home directory
      { path: '~//' },
      { path: '~//home/other' },
    ],
  }, home)
  assert.deepEqual(cfg.outputRoots, [
    { path: join(home, 'reports'), repositoryId: 'repo-uuid', label: 'Reports', protected: true },
    { path: join(home, 'exports'), repositoryId: null, label: null, protected: false },
  ], 'no accepted root lies outside the home directory')
  assert.equal(cfg.warnings.length, 24, cfg.warnings.join('\n'))
  for (let i = 2; i <= 25; i++) assert.ok(cfg.warnings.some(w => w.startsWith(`artifacts.outputRoots[${i}]: `)), `warns about entry ${i}`)
  assert.ok(cfg.warnings.every(w => !/[\n\u0000]/.test(w) && !w.includes('plain-string') && !w.includes('bob')), 'warnings never echo values or carry control characters')
})

test('outputRoots that is not a list yields no roots; a repeated path merges and the protected declaration wins', () => {
  const home = tempDir('atlas-home-')
  for (const bad of ['~/reports', { path: '~/reports' }, 7]) {
    const cfg = artifactsFrom({ outputRoots: bad }, home)
    assert.deepEqual(cfg.outputRoots, [], JSON.stringify(bad))
    assert.ok(cfg.warnings.some(w => w.startsWith('artifacts.outputRoots: ')))
  }
  const merged = artifactsFrom({ outputRoots: [{ path: '~/reports' }, { path: join(home, 'reports'), protected: true }] }, home)
  assert.deepEqual(merged.outputRoots, [{ path: join(home, 'reports'), repositoryId: null, label: null, protected: true }])
  assert.equal(merged.warnings.length, 1)
  assert.match(merged.warnings[0]!, /^artifacts\.outputRoots\[1\]: /)
})

test('durableOutputBase is expanded under HOME; an unusable value falls back to the default with a warning', () => {
  const home = tempDir('atlas-home-')
  const dflt = join(home, '.claude', 'artifact-output')
  assert.equal(artifactsFrom({ durableOutputBase: '~/custom/out' }, home).durableOutputBase, join(home, 'custom', 'out'))
  assert.equal(artifactsFrom({ durableOutputBase: '/srv/artifacts/' }, home).durableOutputBase, '/srv/artifacts')
  for (const bad of ['relative/dir', '~', '/', home, dirname(home), '~/x/../..', '', 5, null, '~/bad\nname', '~//etc', '~//', '~//home/other']) {
    const cfg = artifactsFrom({ durableOutputBase: bad }, home)
    assert.equal(cfg.durableOutputBase, dflt, JSON.stringify(bad))
    assert.equal(cfg.warnings.length, 1, JSON.stringify(bad))
    assert.match(cfg.warnings[0]!, /^artifacts\.durableOutputBase: /)
  }
})

test('a non-object artifacts block uses every default and warns once', () => {
  const home = tempDir('atlas-home-')
  const defaults = loadConfig({ HOME: home }).artifacts
  for (const bad of ['nope', [], 3]) {
    const cfg = artifactsFrom(bad, home)
    assert.deepEqual({ ...cfg, warnings: [] }, defaults, JSON.stringify(bad))
    assert.deepEqual(cfg.warnings, ['artifacts: expected an object; using defaults'])
  }
})

test('piSessionsDir defaults under HOME and config.json overrides it with ~ expansion', () => {
  const home = tempDir('atlas-home-')
  assert.equal(loadConfig({ HOME: home }).piSessionsDir, join(home, '.pi', 'agent', 'sessions'))
  const cfgPath = join(home, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ piSessionsDir: '~/pi-sessions' }))
  assert.equal(loadConfig({ HOME: home }, cfgPath).piSessionsDir, join(home, 'pi-sessions'))
  writeFileSync(cfgPath, JSON.stringify({ piSessionsDir: '/srv/pi' }))
  assert.equal(loadConfig({ HOME: home }, cfgPath).piSessionsDir, '/srv/pi')
  writeFileSync(cfgPath, JSON.stringify({ piSessionsDir: '   ' }))
  assert.equal(loadConfig({ HOME: home }, cfgPath).piSessionsDir, join(home, '.pi', 'agent', 'sessions'))
  writeFileSync(cfgPath, JSON.stringify({ piSessionsDir: 5 }))
  assert.equal(loadConfig({ HOME: home }, cfgPath).piSessionsDir, join(home, '.pi', 'agent', 'sessions'))
})
