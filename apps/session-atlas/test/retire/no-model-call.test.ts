import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// JP-111 acceptance: Atlas makes no model call, on any turn or at any other time. It has no model client, no model API host, no
// provider setting and no code that starts the `claude` program. These checks read the source, so a regression fails here even
// when no test exercises the code path.
const ROOT = join(import.meta.dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'seed' ? [] : sourceFiles(path)
    return /\.(ts|js)$/.test(name) ? [path] : []
  })
}

test('no model client, API host, provider setting or claude launch in src/ or hooks/', () => {
  const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'hooks'))]
  assert.ok(files.length > 50)
  const banned: Array<[string, RegExp]> = [
    ['an Anthropic SDK import', /@anthropic-ai/],
    ['a model API host', /api\.anthropic\.com|openrouter\.ai|api\.openai\.com/],
    ['a provider setting', /ATLAS_PROVIDER|ATLAS_MODEL/],
    ['a Messages API call', /messages\.create|\/v1\/messages/],
    ['a network fetch', /\bfetch\(/],
    ['claude started as a process', /(spawn|execFile|exec)(Sync)?\(\s*['"`][^'"`]*\bclaude\b/],
  ]
  const hits: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [what, re] of banned) if (re.test(text)) hits.push(`${file.slice(ROOT.length + 1)}: ${what}`)
  }
  assert.deepEqual(hits, [])
})

test('package.json carries no runtime dependency, so no model SDK can be pulled in', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])
})
