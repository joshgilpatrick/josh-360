import { isAbsolute, resolve, sep } from 'node:path'

export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return resolve(home, p.slice(2))
  return p
}

export function isInsideHome(p: string, home: string): boolean {
  if (!isAbsolute(p)) return false
  const abs = resolve(p)
  const root = resolve(home)
  return abs === root || abs.startsWith(root + sep)
}

// Claude Code encodes a cwd as a project dir name by replacing '/' with '-'.
export function encodedProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}
