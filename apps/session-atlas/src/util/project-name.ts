import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// H4: a project name is the git origin repo name when there is one, else the git top-level
// folder, else the cwd basename (the old behaviour). config.json aliases (path prefix -> name)
// win over all of that. Only .git/config is read as text; git is never spawned.

let aliases: Array<[string, string]> = []
const CACHE_LIMIT = 1024
const cache = new Map<string, string | null>()

export function configureProjectNaming(opts: { aliases: Record<string, string> }): void {
  aliases = Object.entries(opts.aliases)
    .map(([prefix, name]) => [prefix.replace(/\/+$/, ''), name] as [string, string])
    .sort((a, b) => b[0].length - a[0].length)
  cache.clear()
}

export function resetProjectNameCache(): void {
  cache.clear()
}

export function repoNameFromOriginUrl(url: string): string | null {
  let cleaned = url.trim().split(/[?#]/, 1)[0]!
  cleaned = cleaned.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, '$1').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const last = cleaned.split(/[/:]/).pop() ?? ''
  return last ? last : null
}

function findGitTop(start: string): string | null {
  let dir = start
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// A worktree's .git is a file "gitdir: <path>"; the shared config lives in that gitdir's
// commondir. A normal checkout's .git is a directory holding config directly.
function gitConfigPath(top: string): string | null {
  const dotGit = join(top, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'config')
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const gitdir = m[1]!.trim()
    const commonFile = join(gitdir, 'commondir')
    const common = existsSync(commonFile) ? join(gitdir, readFileSync(commonFile, 'utf8').trim()) : gitdir
    return join(common, 'config')
  } catch {
    return null
  }
}

function originRepoName(configPath: string): string | null {
  let text: string
  try { text = readFileSync(configPath, 'utf8') } catch { return null }
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\s*\[|$)/.exec(text)
  if (!section) return null
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]!)
  return url ? repoNameFromOriginUrl(url[1]!) : null
}

function compute(cwd: string): string | null {
  for (const [prefix, name] of aliases) if (cwd === prefix || cwd.startsWith(prefix + '/')) return name
  // A worktree cwd like /repo/.claude/worktrees/x belongs to project "repo".
  const wt = /^(.*)\/\.claude\/worktrees\/[^/]+/.exec(cwd)
  const start = wt ? wt[1]! : cwd
  const top = findGitTop(start)
  if (top) {
    const cfg = gitConfigPath(top)
    const fromOrigin = cfg ? originRepoName(cfg) : null
    if (fromOrigin) return fromOrigin
    const folder = basename(top)
    if (folder) return folder
  }
  return basename(start) || null
}

export function projectNameFor(cwd: string | undefined): string | null {
  if (!cwd) return null
  const key = cwd.replace(/\/+$/, '') || '/'
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const name = compute(key)
  cache.set(key, name)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return name
}
