import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type SourceFile = { path: string; size: number; mtime: number }

/** Every .jsonl under dir, sorted, with size and mtime. Files that vanish between listing and stat are skipped. */
export function listJsonl(dir: string): SourceFile[] {
  if (!existsSync(dir)) return []
  const rels = (readdirSync(dir, { recursive: true }) as string[]).filter(r => r.endsWith('.jsonl')).sort()
  const out: SourceFile[] = []
  for (const rel of rels) {
    const path = join(dir, rel)
    try {
      const st = statSync(path)
      if (st.isFile()) out.push({ path, size: st.size, mtime: Math.floor(st.mtimeMs) })
    } catch {
      // vanished between listing and stat: skip
    }
  }
  return out
}
