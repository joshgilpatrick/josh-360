import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { configureProjectNaming, projectNameFor, repoNameFromOriginUrl, resetProjectNameCache } from '../../src/util/project-name.ts'

function gitRepo(root: string, originUrl: string | null): void {
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), originUrl ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '[core]\n\tbare = false\n')
}

test('repoNameFromOriginUrl handles ssh and https forms', () => {
  assert.equal(repoNameFromOriginUrl('git@github.com:Eventus-Whole-Health/keystone-platform.git'), 'keystone-platform')
  assert.equal(repoNameFromOriginUrl('https://github.com/joshgilpatrick/claude-360'), 'claude-360')
  assert.equal(repoNameFromOriginUrl('https://github.com/joshgilpatrick/claude-360.git/'), 'claude-360')
  assert.equal(repoNameFromOriginUrl('https://github.com/joshgilpatrick/claude-360.git?access_token=secret#origin'), 'claude-360')
  assert.equal(repoNameFromOriginUrl('https://x-access-token:secret@github.com'), 'github.com')
  assert.equal(repoNameFromOriginUrl('ssh://user:secret@github.com:2222/org/claude-360.git'), 'claude-360')
  assert.equal(repoNameFromOriginUrl(''), null)
})

test('origin repo name wins, then git top-level folder, then cwd basename', () => {
  resetProjectNameCache()
  const base = tempDir('atlas-pn-')
  const withOrigin = join(base, 'active', 'checkout-dir')
  gitRepo(withOrigin, 'git@github.com:Eventus-Whole-Health/keystone-platform.git')
  mkdirSync(join(withOrigin, 'backend', 'app'), { recursive: true })
  assert.equal(projectNameFor(withOrigin), 'keystone-platform')
  assert.equal(projectNameFor(join(withOrigin, 'backend', 'app')), 'keystone-platform', 'subfolder resolves to the repo')

  const noOrigin = join(base, 'local-only')
  gitRepo(noOrigin, null)
  assert.equal(projectNameFor(join(noOrigin, 'src')), 'local-only')

  const plain = join(base, 'just-a-folder', 'deeper')
  mkdirSync(plain, { recursive: true })
  assert.equal(projectNameFor(plain), 'deeper')
  assert.equal(projectNameFor(undefined), null)
})

test('a worktree cwd resolves to its parent repo, and aliases take precedence by longest prefix', () => {
  resetProjectNameCache()
  const base = tempDir('atlas-pn-')
  const repo = join(base, 'repo')
  gitRepo(repo, 'https://github.com/x/atlas.git')
  const wt = join(repo, '.claude', 'worktrees', 'feature-x', 'src')
  mkdirSync(wt, { recursive: true })
  assert.equal(projectNameFor(wt), 'atlas')

  configureProjectNaming({ aliases: { [base]: 'everything', [repo]: 'atlas-alias' } })
  try {
    assert.equal(projectNameFor(join(repo, 'src')), 'atlas-alias')
    assert.equal(projectNameFor(join(base, 'other')), 'everything')
  } finally {
    configureProjectNaming({ aliases: {} })
  }
})
