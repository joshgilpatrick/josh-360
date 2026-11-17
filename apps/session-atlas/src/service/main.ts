import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type AtlasConfig } from '../config.ts'
import { configureArtifactRules } from '../artifacts/candidates.ts'
import { configureSensitivePatterns } from '../artifacts/filetype.ts'
import { configureArtifactDocumentExtensions } from '../db/artifact-manager.ts'
import { configureProjectNaming } from '../util/project-name.ts'
import { openDatabase } from '../db/database.ts'
import { createLogger, type Logger } from '../util/log.ts'
import { createAtlasServer } from '../server/http.ts'
import { registerArtifactRoutes } from '../server/api-artifacts.ts'
import { registerSessionRoutes } from '../server/api-sessions.ts'
import { pruneRunner, runLoop, type Runner } from './runners.ts'
import { createWatcher } from '../artifacts/watcher.ts'
import { artifactManagerRunner } from './artifact-manager-runner.ts'
import { costLedgerImportRunner } from './costledger-import-runner.ts'
import { mirrorRunner } from '../mirror/session-mirror.ts'

// loadConfig silently ignores a malformed config.json (it falls back to defaults). Say so in the log, never crash, never log contents.
function warnOnMalformedConfigFile(config: AtlasConfig, log: Logger): void {
  const path = join(config.atlasDir, 'config.json')
  if (!existsSync(path)) return
  try {
    JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    log.warn('config.json is present but failed to parse; using defaults', { path })
  }
}

/**
 * Session Atlas in josh-360 is a headless service: the artifact manager (catalog, output folders, removal check), the hourly cost
 * import, and a read-only mirror of the ledger's sessions. It has no dashboard and makes no model call. It writes cache.db only.
 */
export async function startService(): Promise<void> {
  const config = loadConfig()
  mkdirSync(config.atlasDir, { recursive: true, mode: 0o700 })
  const log = createLogger(config.logPath)
  warnOnMalformedConfigFile(config, log)
  configureArtifactRules({ ignoreSegments: config.artifacts.ignoreSegments })
  configureSensitivePatterns(config.artifacts.sensitivePatterns)
  configureArtifactDocumentExtensions(config.artifacts.documentExtensions)
  configureProjectNaming({ aliases: config.projects.aliases })
  process.on('unhandledRejection', err => { log.error('unhandled rejection', { err: String(err) }) })
  process.on('uncaughtException', err => { log.error('uncaught exception', { err: String(err) }) })
  const db = openDatabase(config.dbPath)

  const atlas = createAtlasServer({ db, config, log })
  registerSessionRoutes(atlas.router, { db, log })
  registerArtifactRoutes(atlas.router, { db, log, config })
  const artifactManager = artifactManagerRunner({ db, config, log })
  process.on('exit', () => artifactManager.stop?.())
  const watcher = createWatcher({ db, log, onDirty: (folder, path) => artifactManager.markDirty(folder, path) })
  watcher.syncActiveFolders()
  const runners: Runner[] = [
    mirrorRunner({ db, factsPath: config.factsPath, log }),
    artifactManager,
    pruneRunner(db, log),
    costLedgerImportRunner({ homeDir: config.homeDir, ledgerPath: config.ledgerPath, projectsDir: config.projectsDir, piSessionsDir: config.piSessionsDir, log }),
  ]

  const port = await atlas.listen()
  log.info('atlas listening', { host: config.host, port, db: config.dbPath })
  const ac = new AbortController()
  const stop = () => { log.info('shutting down'); ac.abort(); runners.forEach(r => r.stop?.()); watcher.close(); atlas.server.close(() => { db.close(); process.exit(0) }) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  await runLoop(runners, { pollMs: config.worker.pollMs, log, signal: ac.signal })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startService().catch(err => { process.stderr.write(`atlas failed to start: ${String(err)}\n`); process.exit(1) })
}
