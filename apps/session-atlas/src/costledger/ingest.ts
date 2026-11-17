import { existsSync } from 'node:fs'
import type { LedgerDb } from './db.ts'
import { attributionQuality, createResolver } from './attribution.ts'
import { rebuildSharedHistoryLinks, recordSpawns, syncClaudeHierarchy, syncOpenCodeHierarchy } from './hierarchy.ts'
import type { SpawnRef } from './hierarchy.ts'
import { listJsonl } from './files.ts'
import { importLabels } from './labels.ts'
import { parseClaudeFile } from './parse-claude.ts'
import { readOpenCode } from './parse-opencode.ts'
import { parsePiFile } from './parse-pi.ts'
import { runPricing, seedPrices, SEED_PATH } from './pricing.ts'
import { markScanned, needsScan, upsertMessage } from './store.ts'
import type { ParsedMessage, PricingStatus, Tool } from './types.ts'

export type IngestSources = { claudeProjectsDir: string | null; piSessionsDir: string | null; opencodeDb: string | null }
export type ToolSummary = { files: number; filesSkipped: number; messages: number; inserted: number; replaced: number; kept: number }
export type IngestSummary = { claude: ToolSummary; pi: ToolSummary; opencode: ToolSummary; errors: string[] }
export type ImportResult = {
  importRunId: number
  seeded: number
  ingest: IngestSummary
  pricingRunId: number
  pricing: Record<PricingStatus, number>
  pricingChanged: number
}

const empty = (): ToolSummary => ({ files: 0, filesSkipped: 0, messages: 0, inserted: 0, replaced: 0, kept: 0 })

export async function ingest(db: LedgerDb, sources: IngestSources, now: string): Promise<IngestSummary> {
  const resolver = createResolver()
  const summary: IngestSummary = { claude: empty(), pi: empty(), opencode: empty(), errors: [] }

  const store = (batch: ParsedMessage[], s: ToolSummary): void => {
    for (const m of batch) {
      const attr = resolver.resolve(m.cwd)
      s[upsertMessage(db, m, attr, attributionQuality(attr, m.gitBranch))] += 1
    }
    s.messages += batch.length
  }

  type Parsed = { batch: ParsedMessage[]; spawns?: SpawnRef[] }
  const scanFiles = async (tool: Tool, dir: string | null, s: ToolSummary, parse: (path: string) => Promise<Parsed>): Promise<void> => {
    if (dir === null) return
    for (const f of listJsonl(dir)) {
      if (!needsScan(db, f.path, f.size, f.mtime)) {
        s.filesSkipped += 1
        continue
      }
      // Parse fully first; rows, spawn owners and the scanned mark commit together or not at all.
      const before = { ...s }
      try {
        const parsed = await parse(f.path)
        db.transaction(() => {
          store(parsed.batch, s)
          if (parsed.spawns) recordSpawns(db, f.path, parsed.spawns)
          markScanned(db, tool, f.path, f.size, f.mtime, now)
        })
        s.files += 1
      } catch (e) {
        Object.assign(s, before)
        summary.errors.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  await scanFiles('claude-code', sources.claudeProjectsDir, summary.claude, async path => {
    const batch: ParsedMessage[] = []
    const spawns: SpawnRef[] = []
    for await (const m of parseClaudeFile(path, x => spawns.push(x))) batch.push(m)
    return { batch, spawns }
  })
  await scanFiles('pi', sources.piSessionsDir, summary.pi, async path => ({ batch: parsePiFile(path) }))
  if (sources.claudeProjectsDir !== null) {
    try {
      syncClaudeHierarchy(db, sources.claudeProjectsDir)
      rebuildSharedHistoryLinks(db)
    } catch (e) {
      summary.errors.push(`${sources.claudeProjectsDir}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (sources.opencodeDb !== null && existsSync(sources.opencodeDb)) {
    try {
      const batch = readOpenCode(sources.opencodeDb, Date.parse(now))
      db.transaction(() => store(batch, summary.opencode))
      syncOpenCodeHierarchy(db, sources.opencodeDb)
      summary.opencode.files = 1
    } catch (e) {
      summary.errors.push(`${sources.opencodeDb}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  await importLabels(db, sources, now, summary.errors)
  return summary
}

export async function importAll(db: LedgerDb, sources: IngestSources, now: string): Promise<ImportResult> {
  const importRunId = Number(db.raw.prepare('INSERT INTO import_runs (started_at) VALUES (?)').run(now).lastInsertRowid)
  const seeded = seedPrices(db, SEED_PATH, now)
  const summary = await ingest(db, sources, now)
  const priced = runPricing(db, now, `import ${importRunId}`)
  db.raw.prepare('UPDATE import_runs SET finished_at = ?, summary_json = ? WHERE id = ?')
    .run(now, JSON.stringify({ seeded, ingest: summary, pricing: priced.counts, pricingChanged: priced.changed }), importRunId)
  return { importRunId, seeded, ingest: summary, pricingRunId: priced.runId, pricing: priced.counts, pricingChanged: priced.changed }
}
