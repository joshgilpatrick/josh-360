import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type AtlasDb } from '../src/db/database.ts'
import { classifyPath } from '../src/artifacts/filetype.ts'

function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const WORDS = ['billing', 'export', 'report', 'migration', 'dashboard', 'cleanup', 'auth', 'sync', 'invoice', 'schedule', 'patient', 'intake', 'pipeline', 'refactor', 'notes']
const EXTS = ['md', 'md', 'md', 'ts', 'py', 'csv', 'xlsx', 'json', 'yaml', 'png', 'pdf', 'sql', 'txt', 'html', 'ipynb', 'zip']
const uuid = (r: () => number) => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = (r() * 16) | 0; return (c === 'x' ? n : (n & 3) | 8).toString(16) })
const pick = <T,>(r: () => number, a: readonly T[]) => a[(r() * a.length) | 0]!

export function seedBenchmark(db: AtlasDb, opts: { sessions: number; artifacts: number; seed?: number }): void {
  const r = mulberry32(opts.seed ?? 42)
  const home = '/Users/bench'
  const base = Date.parse('2026-01-01T00:00:00Z')
  const ids: string[] = [], mains: string[] = []
  const insSession = db.raw.prepare(`INSERT INTO sessions (session_id, parent_session_id, root_session_id, is_subagent, agent_type, title, title_source, summary, status, focus_state, start_cwd, resume_cwd, project_name, transcript_path, started_at, last_activity_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insLineage = db.raw.prepare(`INSERT OR IGNORE INTO session_lineage (child_session_id, parent_session_id, root_session_id, confidence, discovered_at) VALUES (?, ?, ?, 'confirmed', ?)`)
  const insFocus = db.raw.prepare(`INSERT INTO focus_states (session_id, revision, main_task, subtasks_json, open_decisions_json, parked_json, deliverables_json, staleness, last_refreshed_at, updated_at) VALUES (?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?)`)
  const insArtifact = db.raw.prepare(`INSERT INTO artifacts (path, filename, extension, file_type, mime_type, size_bytes, created_at, project_name, exists_state, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insOrigin = db.raw.prepare(`INSERT INTO artifact_origins (artifact_id, session_id, relation, detected_via, observed_at) VALUES (?, ?, 'creator', 'tool_event', ?)`)

  db.transaction(() => {
    for (let i = 0; i < opts.sessions; i++) {
      const sid = uuid(r), project = `project-${String((r() * 40) | 0).padStart(2, '0')}`, cwd = `${home}/dev/${project}`
      const started = new Date(base + r() * 250 * 86_400_000), last = new Date(started.getTime() + r() * 6 * 3_600_000)
      const isSub = mains.length > 0 && r() < 0.08
      const parent = isSub ? pick(r, mains) : null
      const focus = !isSub && r() < 0.3
      const title = isSub ? `Explore · ${sid.slice(0, 8)}` : `${pick(r, WORDS)} ${pick(r, WORDS)} ${i}`
      insSession.run(sid, parent, parent, isSub ? 1 : 0, isSub ? 'Explore' : null, title, focus ? 'worker' : 'fallback', focus ? `Works on ${title}. Adds tests.` : null,
        r() < 0.2 ? 'active' : 'closed', focus ? 'active' : 'metadata-only', cwd, cwd, project, `${home}/.claude/projects/-Users-bench-dev-${project}/${sid}.jsonl`, started.toISOString(), last.toISOString(), started.toISOString(), last.toISOString())
      if (parent) insLineage.run(sid, parent, parent, started.toISOString())
      if (focus) insFocus.run(sid, 1 + ((r() * 5) | 0), `Finish ${title}`, r() < 0.9 ? 'current' : 'stale', last.toISOString(), last.toISOString())
      ids.push(sid); if (!isSub) mains.push(sid)
    }
    for (let i = 0; i < opts.artifacts; i++) {
      const sid = pick(r, ids), project = `project-${String((r() * 40) | 0).padStart(2, '0')}`, ext = pick(r, EXTS)
      const path = `${home}/dev/${project}/${pick(r, ['docs', 'src', 'deliverables/2026-03-01', 'data', 'notes'])}/${pick(r, WORDS)}-${pick(r, WORDS)}-${i}.${ext}`
      const c = classifyPath(path), created = new Date(base + r() * 250 * 86_400_000).toISOString()
      const res = insArtifact.run(path, c.filename, c.extension, c.fileType, c.mimeType, (r() * 2_000_000) | 0, created, project, r() < 0.03 ? 'missing' : 'present', created)
      insOrigin.run(Number(res.lastInsertRowid), sid, created)
    }
  })
  db.raw.exec('ANALYZE')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d }
  // `mkdtempSync` must only run when --home is actually absent: passed as a pre-evaluated
  // default-argument expression, JS evaluates it eagerly before `arg()` checks for --home,
  // so a temp dir would be created and leaked on every invocation, even one that passes --home.
  const homeIndex = process.argv.indexOf('--home')
  const home = homeIndex >= 0 ? process.argv[homeIndex + 1]! : mkdtempSync(join(tmpdir(), 'atlas-bench-'))
  const dir = join(home, '.claude', 'atlas'); mkdirSync(dir, { recursive: true })
  const db = openDatabase(join(dir, 'atlas.db'))
  const t = performance.now()
  try {
    seedBenchmark(db, { sessions: Number(arg('sessions', '10000')), artifacts: Number(arg('artifacts', '100000')) })
  } finally {
    db.close()
  }
  process.stdout.write(`${home}\nseeded in ${Math.round(performance.now() - t)} ms\n`)
}
