import type { AtlasDb } from './database.ts'

// JP-163: cache.db can hold tables from the old cost ledger's own artifact catalog, with names Atlas's migrations create (`artifacts`).
// A migration that is about to run has never run here, so a table, index or trigger it would create and that already exists is not
// Atlas's own. Instead of failing with "already exists", it is renamed with a `legacy_` prefix, rows and all, and the migration runs.
// Runs inside the migration's transaction, so the rename and the migration succeed or roll back together.

type Created = { kind: 'table' | 'index' | 'trigger'; name: string }

/** What a migration's SQL creates, by name. A statement with IF NOT EXISTS tolerates a clash, so it is not listed. */
export function createdNames(sql: string): Created[] {
  const text = sql.replace(/--[^\n]*/g, '')
  const out: Created[] = []
  const re = /\bCREATE\s+(?:UNIQUE\s+)?(VIRTUAL\s+TABLE|TABLE|INDEX|TRIGGER)\s+(?!IF\s+NOT\s+EXISTS\b)["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi
  for (const m of text.matchAll(re)) {
    const kind = m[1]!.toUpperCase().endsWith('TABLE') ? 'table' : m[1]!.toLowerCase() as 'index' | 'trigger'
    out.push({ kind, name: m[2]! })
  }
  return out
}

const exists = (db: AtlasDb, name: string): boolean =>
  db.raw.prepare('SELECT 1 FROM sqlite_master WHERE name = ? COLLATE NOCASE').get(name) !== undefined

function freeName(db: AtlasDb, name: string): string {
  let candidate = `legacy_${name}`
  for (let n = 2; exists(db, candidate); n += 1) candidate = `legacy_${name}_${n}`
  return candidate
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Renames every existing table, index and trigger that `sql` is about to create. Returns "old -> new" for each, for the log. */
export function setAsideLegacy(db: AtlasDb, sql: string): string[] {
  const created = createdNames(sql)
  const moved: string[] = []
  const find = (name: string, type: string) =>
    db.raw.prepare('SELECT name, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type = ?').get(name, type) as { name: string; sql: string | null } | undefined

  // Tables first. A table's indexes and triggers keep their names when it is renamed, so they are handled next, by name.
  for (const c of created.filter(c => c.kind === 'table')) {
    const found = find(c.name, 'table')
    if (!found) continue
    const next = freeName(db, found.name)
    db.raw.exec(`ALTER TABLE ${quote(found.name)} RENAME TO ${quote(next)}`)
    moved.push(`${found.name} -> ${next}`)
  }
  for (const c of created.filter(c => c.kind !== 'table')) {
    const found = find(c.name, c.kind)
    if (!found?.sql) continue // an automatic index has no SQL and moves with its table
    const next = freeName(db, found.name)
    const head = new RegExp(`^(\\s*CREATE\\s+(?:UNIQUE\\s+)?${c.kind}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)["\`[]?${found.name}["\`\\]]?`, 'i')
    if (!head.test(found.sql)) throw new Error(`cannot set aside legacy ${c.kind} ${found.name}: its definition is not in the expected form`)
    db.raw.exec(`DROP ${c.kind.toUpperCase()} ${quote(found.name)}`)
    db.raw.exec(found.sql.replace(head, `$1${next}`))
    moved.push(`${found.name} -> ${next}`)
  }
  return moved
}
