import { join } from 'node:path'
import { tempDir, removeTempDir } from './tmp.ts'
import { loadConfig } from '../../src/config.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'
import { createLogger } from '../../src/util/log.ts'
import { createAtlasServer, type Router } from '../../src/server/http.ts'
import { silentLogger } from './log.ts'

export async function startTestServer(): Promise<{ db: AtlasDb; baseUrl: string; close(): Promise<void> }> {
  const home = tempDir('atlas-srv-')
  const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
  const db = openDatabase(config.dbPath)
  const log = createLogger(null)
  const atlas = createAtlasServer({ db, config: { ...config, port: 0 }, log })
  // The one POST route of this test server: it exists so the same-origin rules can be tested on a POST.
  atlas.router.add('POST', '/api/ping', ctx => { ctx.send(202, { ok: true }) })
  const port = await atlas.listen()
  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => atlas.server.close(() => { db.close(); resolve() })),
  }
}

// Route-level test server for plan 05's read-API tests: the caller owns and seeds `db` (e.g. via
// openTestDb()) and supplies the routes to mount via `register`. Distinct from startTestServer
// above (which owns its own empty db and mounts one ping route) -- callers that
// need a seeded db and a specific route module use this instead. The temp ATLAS_HOME it creates
// (just for config plumbing; it holds no db file of its own) is removed on close so the suite
// leaves no atlas-route-* directories behind.
export async function startRouteServer(
  db: AtlasDb,
  register: (router: Router, deps: { db: AtlasDb; log: ReturnType<typeof createLogger> }) => void,
): Promise<{ base: string; close(): Promise<void> }> {
  const home = tempDir('atlas-route-')
  const config = loadConfig({ HOME: home, ATLAS_PORT: '0' })
  const atlas = createAtlasServer({ db, config: { ...config, port: 0 }, log: silentLogger })
  register(atlas.router, { db, log: silentLogger })
  const port = await atlas.listen()
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await atlas.close()
      removeTempDir(home)
    },
  }
}
