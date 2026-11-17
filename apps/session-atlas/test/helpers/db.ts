import { join } from 'node:path'
import { tempDir } from './tmp.ts'
import { openDatabase, type AtlasDb } from '../../src/db/database.ts'

export function openTestDb(): AtlasDb {
  const dir = tempDir('atlas-db-')
  return openDatabase(join(dir, 'atlas.db'))
}

export function tableNames(db: AtlasDb): string[] {
  const rows = db.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as Array<{ name: string }>
  return rows.map(r => r.name)
}
