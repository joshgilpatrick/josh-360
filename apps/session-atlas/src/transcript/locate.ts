import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function locateTranscript(projectsDir: string, sessionId: string): string | null {
  if (!existsSync(projectsDir)) return null
  let projects: string[]
  try { projects = readdirSync(projectsDir) } catch { return null }
  const agent = /^agent-([0-9a-f]{6,32})$/.exec(sessionId)
  for (const p of projects) {
    const projectDir = join(projectsDir, p)
    if (!agent) {
      const candidate = join(projectDir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
      continue
    }
    let entries: string[]
    try { entries = readdirSync(projectDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { continue }
    for (const parent of entries) {
      const candidate = join(projectDir, parent, 'subagents', `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}
