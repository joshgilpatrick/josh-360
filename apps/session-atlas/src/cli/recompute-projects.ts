// `npm run recompute-projects`: after changing `projects.aliases` or `artifacts.sensitivePatterns` in config.json, rewrite
// the stored project names of sessions and artifacts, and raise the secret flag of artifacts whose filename now matches.
//
// JP-159 brought this back. Before JP-111 it lived in src/transcript/backfill.ts, which the move into josh-360 left out
// (sessions now come from the ledger, so that file's transcript backfill has no job here any more).
//
// It never lowers a secret flag: a flag also comes from the location (a folder named `phi` or `.phi`) or from a manual flag,
// which the filename does not show. An artifact takes its creator session's project. One transaction; safe to run twice.
// With no cache.db it creates nothing and exits 1, because a missing database is not an empty one.

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.ts'
import { openDatabase, type AtlasDb } from '../db/database.ts'
import { configureSensitivePatterns, isSensitiveFilename } from '../artifacts/filetype.ts'
import { configureProjectNaming, projectNameFor, resetProjectNameCache } from '../util/project-name.ts'

export function recomputeProjectNames(db: AtlasDb): { sessions: number; artifacts: number; sensitive: number } {
  resetProjectNameCache()
  const out = { sessions: 0, artifacts: 0, sensitive: 0 }
  db.transaction(() => {
    const sessions = db.raw.prepare('SELECT session_id, start_cwd, resume_cwd, project_name FROM sessions').all() as
      Array<{ session_id: string; start_cwd: string | null; resume_cwd: string | null; project_name: string | null }>
    const setSession = db.raw.prepare('UPDATE sessions SET project_name = ? WHERE session_id = ?')
    for (const s of sessions) {
      const name = projectNameFor(s.start_cwd ?? s.resume_cwd ?? undefined)
      if (name !== s.project_name) { setSession.run(name, s.session_id); out.sessions += 1 }
    }
    const artifacts = db.raw.prepare(`SELECT a.artifact_id, a.filename, a.project_name, a.is_sensitive,
        (SELECT s.project_name FROM artifact_origins o JOIN sessions s ON s.session_id = o.session_id
          WHERE o.artifact_id = a.artifact_id AND o.relation = 'creator' LIMIT 1) AS creator_project
      FROM artifacts a`).all() as
      Array<{ artifact_id: number; filename: string; project_name: string | null; is_sensitive: number; creator_project: string | null }>
    const setArtifact = db.raw.prepare('UPDATE artifacts SET project_name = ? WHERE artifact_id = ?')
    const raiseSensitive = db.raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ? AND is_sensitive = 0')
    for (const a of artifacts) {
      if (a.creator_project !== null && a.creator_project !== a.project_name) { setArtifact.run(a.creator_project, a.artifact_id); out.artifacts += 1 }
      if (a.is_sensitive === 0 && isSensitiveFilename(a.filename)) { raiseSensitive.run(a.artifact_id); out.sensitive += 1 }
    }
  })
  return out
}

export function main(): number {
  const config = loadConfig()
  if (!existsSync(config.dbPath)) {
    process.stderr.write(`recompute-projects: ${config.dbPath} does not exist; nothing to recompute (the headless Session Atlas creates it)\n`)
    return 1
  }
  configureProjectNaming({ aliases: config.projects.aliases })
  configureSensitivePatterns(config.artifacts.sensitivePatterns)
  const db = openDatabase(config.dbPath)
  try {
    const r = recomputeProjectNames(db)
    process.stdout.write(`sessions=${r.sessions} artifacts=${r.artifacts} sensitive=${r.sensitive}\n`)
    return 0
  } finally {
    db.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()
