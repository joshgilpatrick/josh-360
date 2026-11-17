import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Attribution, AttributionQuality } from './types.ts'

const NONE: Attribution = { repoKey: null, displayName: null, rootPath: null, worktreePath: null, resolution: 'none' }

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

function live(cwd: string): Attribution {
  let out: string
  try {
    out = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv() })
  } catch {
    return NONE
  }
  const [common, top] = out.trim().split('\n')
  if (!common || !top) return NONE
  const commonReal = realpathSync(common)
  const rootPath = basename(commonReal) === '.git' ? dirname(commonReal) : commonReal
  return { repoKey: rootPath, displayName: basename(rootPath), rootPath, worktreePath: realpathSync(top), resolution: 'live' }
}

const PATTERNS = [/^(.*)\/\.claude\/worktrees\/[^/]+(\/.*)?$/, /^(.*)-worktrees\/[^/]+(\/.*)?$/]

function fallback(cwd: string): Attribution {
  for (const re of PATTERNS) {
    const m = re.exec(cwd)
    const repoPath = m?.[1]
    if (!repoPath) continue
    const rootPath = existsSync(repoPath) ? realpathSync(repoPath) : repoPath
    return { repoKey: rootPath, displayName: basename(rootPath), rootPath, worktreePath: cwd, resolution: 'fallback' }
  }
  return NONE
}

export function createResolver(): { resolve(cwd: string | null): Attribution } {
  const cache = new Map<string, Attribution>()
  return {
    resolve(cwd) {
      if (!cwd) return NONE
      const hit = cache.get(cwd)
      if (hit) return hit
      const liveResult = existsSync(cwd) ? live(cwd) : NONE
      const result = liveResult.resolution === 'none' ? fallback(cwd) : liveResult
      cache.set(cwd, result)
      return result
    },
  }
}

export function attributionQuality(a: Attribution, gitBranch: string | null): AttributionQuality {
  if (a.repoKey === null) return 'unknown'
  return a.resolution === 'live' && gitBranch !== null ? 'exact' : 'derived'
}
