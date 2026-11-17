import { ensureOverviewView } from './overview-view.ts'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type LedgerDb = {
  raw: DatabaseSync
  path: string
  close(): void
  transaction<T>(fn: () => T): T
}

const MESSAGE_COLUMNS = `
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_session_id TEXT,
  source_agent_id TEXT,
  ts_utc TEXT NOT NULL,
  model_raw TEXT NOT NULL,
  provider_raw TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  cache_write_unclassified_tokens INTEGER,
  logged_cost_usd REAL,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,
  git_branch TEXT,
  repo_key TEXT,
  worktree_path TEXT,
  attribution_quality TEXT NOT NULL,
  usage_status TEXT NOT NULL,
  suspect INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL,
  source_locator TEXT NOT NULL
`

const LEGACY_MESSAGE_COLUMNS = `
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_session_id TEXT,
  ts_utc TEXT NOT NULL,
  model_raw TEXT NOT NULL,
  provider_raw TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  cache_write_unclassified_tokens INTEGER,
  logged_cost_usd REAL,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,
  git_branch TEXT,
  repo_key TEXT,
  worktree_path TEXT,
  attribution_quality TEXT NOT NULL,
  usage_status TEXT NOT NULL,
  suspect INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL,
  source_locator TEXT NOT NULL
`

const MESSAGE_COLUMN_NAMES = `id, tool, source_message_id, source_session_id, source_agent_id, ts_utc, model_raw, provider_raw,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  cache_write_unclassified_tokens, logged_cost_usd, is_sidechain, cwd, git_branch, repo_key, worktree_path,
  attribution_quality, usage_status, suspect, source_path, source_locator`

const LEGACY_MESSAGE_COLUMN_NAMES = `id, tool, source_message_id, source_session_id, ts_utc, model_raw, provider_raw,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  cache_write_unclassified_tokens, logged_cost_usd, is_sidechain, cwd, git_branch, repo_key, worktree_path,
  attribution_quality, usage_status, suspect, source_path, source_locator`

const DDL = `
CREATE TABLE IF NOT EXISTS source_files (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  last_scanned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  repo_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  root_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (${MESSAGE_COLUMNS});
CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages (ts_utc);
CREATE INDEX IF NOT EXISTS messages_repo_idx ON messages (repo_key, git_branch);
CREATE TABLE IF NOT EXISTS models (
  model_id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models (model_id),
  source_note TEXT
);
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models (model_id),
  token_class TEXT NOT NULL CHECK (token_class IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
  min_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  usd_per_million REAL NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  source_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (model_id, token_class, min_prompt_tokens, effective_from)
);
CREATE TABLE IF NOT EXISTS pricing_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS message_costs (
  run_id INTEGER NOT NULL REFERENCES pricing_runs (id),
  message_id INTEGER NOT NULL REFERENCES messages (id),
  model_id TEXT,
  computed_cost_usd REAL,
  price_ids TEXT,
  pricing_status TEXT NOT NULL CHECK (pricing_status IN ('priced','missing_price','missing_alias','suspect','no_usage')),
  PRIMARY KEY (run_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_costs_message_idx ON message_costs (message_id, run_id);
CREATE VIEW IF NOT EXISTS latest_message_costs AS
  SELECT c.* FROM message_costs c
  WHERE c.run_id = (SELECT MAX(x.run_id) FROM message_costs x WHERE x.message_id = c.message_id);
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS jira_session_links (
  issue_key TEXT NOT NULL CHECK (issue_key GLOB '[A-Z][A-Z0-9]*-[0-9]*'),
  tool TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('worked')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (issue_key, tool, source_session_id)
);
CREATE INDEX IF NOT EXISTS jira_session_links_session_idx ON jira_session_links (tool, source_session_id);
CREATE TABLE IF NOT EXISTS session_labels (
  tool TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('custom_title', 'ai_title', 'agent_name', 'tool_title')),
  value TEXT NOT NULL CHECK (length(value) > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tool, source_session_id, kind)
);
CREATE INDEX IF NOT EXISTS session_labels_session_idx ON session_labels (tool, source_session_id);
CREATE TABLE IF NOT EXISTS session_pr_links (
  tool TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  url TEXT NOT NULL,
  repository TEXT,
  number TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tool, source_session_id, url)
);
CREATE INDEX IF NOT EXISTS session_pr_links_url_idx ON session_pr_links (url);
CREATE TABLE IF NOT EXISTS label_scans (
  path TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
`

const GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS message_holders(
  message_id INTEGER NOT NULL REFERENCES messages(id),
  source_session_id TEXT NOT NULL, source_agent_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(message_id,source_session_id,source_agent_id));
CREATE INDEX IF NOT EXISTS message_holders_session_idx ON message_holders(source_session_id,message_id);
CREATE TABLE IF NOT EXISTS claude_spawn_owners(
  source_path TEXT NOT NULL, source_session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL, owner_agent_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(source_path,source_session_id,tool_use_id));
CREATE TABLE IF NOT EXISTS session_nodes(
  tool TEXT NOT NULL, source_session_id TEXT NOT NULL, source_agent_id TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT, parent_agent_id TEXT, kind TEXT NOT NULL,
  link_quality TEXT NOT NULL, spawn_tool_use_id TEXT,
  PRIMARY KEY(tool,source_session_id,source_agent_id));
CREATE INDEX IF NOT EXISTS session_nodes_parent_idx ON session_nodes(tool,parent_session_id,parent_agent_id);
CREATE TABLE IF NOT EXISTS session_links(
  tool TEXT NOT NULL, session_a TEXT NOT NULL, session_b TEXT NOT NULL,
  kind TEXT NOT NULL, shared_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tool,session_a,session_b,kind));
`

type SchemaState = {
  messagesExists: boolean
  sourceAgentExists: boolean
  needsMigration: boolean
  tableHasOldUnique: boolean
}

function inspectSchema(raw: DatabaseSync): SchemaState {
  const table = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string } | undefined
  if (!table) return { messagesExists: false, sourceAgentExists: false, needsMigration: false, tableHasOldUnique: false }
  const columns = raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  const sourceAgentExists = columns.some(column => column.name === 'source_agent_id')
  const index = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_source_identity_idx'").get() as { sql: string } | undefined
  const hasConditionalIndex = Boolean(index?.sql && /CASE\s+WHEN\s+tool\s*=\s*'claude-code'\s+THEN\s+''\s+ELSE\s+COALESCE\(source_session_id/i.test(index.sql))
  const hasOldSessionIndex = Boolean(index?.sql && /COALESCE\(source_session_id/i.test(index.sql) && !hasConditionalIndex)
  const tableHasOldUnique = /UNIQUE\s*\(\s*tool\s*,\s*source_message_id\s*\)/i.test(table.sql)
  return {
    messagesExists: true,
    sourceAgentExists,
    needsMigration: !sourceAgentExists || tableHasOldUnique || hasOldSessionIndex || !index,
    tableHasOldUnique,
  }
}

function migrateLegacyMessageIdentity(raw: DatabaseSync): void {
  const schema = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string } | undefined
  if (!schema || !/UNIQUE\s*\(\s*tool\s*,\s*source_message_id\s*\)/i.test(schema.sql)) return
  const columns = raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  const hasSourceAgent = columns.some(column => column.name === 'source_agent_id')
  const tableColumns = hasSourceAgent ? MESSAGE_COLUMNS : LEGACY_MESSAGE_COLUMNS
  const columnNames = hasSourceAgent ? MESSAGE_COLUMN_NAMES : LEGACY_MESSAGE_COLUMN_NAMES
  raw.exec('PRAGMA foreign_keys = OFF')
  try {
    raw.exec('BEGIN IMMEDIATE')
    raw.exec(`CREATE TABLE messages_session_identity_new (${tableColumns})`)
    raw.exec(`INSERT INTO messages_session_identity_new (${columnNames}) SELECT ${columnNames} FROM messages`)
    raw.exec('DROP TABLE messages')
    raw.exec('ALTER TABLE messages_session_identity_new RENAME TO messages')
    raw.exec('CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages (ts_utc)')
    raw.exec('CREATE INDEX IF NOT EXISTS messages_repo_idx ON messages (repo_key, git_branch)')
    raw.exec("CREATE UNIQUE INDEX messages_source_identity_idx ON messages (tool, COALESCE(source_session_id, ''), source_message_id)")
    if (raw.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('message identity migration would break foreign keys')
    raw.exec('COMMIT')
  } catch (e) {
    try { raw.exec('ROLLBACK') } catch {}
    throw e
  } finally {
    raw.exec('PRAGMA foreign_keys = ON')
  }
}

function migrateGraphSchema(raw: DatabaseSync, collapseCopies: boolean, sourceAgentExists: boolean): void {
  raw.exec('BEGIN IMMEDIATE')
  try {
    if (!sourceAgentExists) {
      raw.exec('ALTER TABLE messages ADD COLUMN source_agent_id TEXT')
      // Old rows carry no agent; forget the Claude scan marks so the next import rescans and fills them in.
      raw.exec("DELETE FROM source_files WHERE tool = 'claude-code'")
    }
    raw.exec(GRAPH_DDL)
    raw.exec('DROP INDEX IF EXISTS messages_source_identity_idx')
    if (collapseCopies) {
      raw.exec(`
CREATE TEMP TABLE claude_rank AS
 SELECT id,source_message_id,COALESCE(source_session_id,'') AS sess,
        COALESCE(source_agent_id,'') AS agent,
        ROW_NUMBER() OVER (PARTITION BY source_message_id ORDER BY
          COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+
          COALESCE(cache_write_5m_tokens,0)+COALESCE(cache_write_1h_tokens,0)+
          COALESCE(cache_write_unclassified_tokens,0) DESC,
          is_sidechain ASC,ts_utc ASC,source_path ASC,source_locator ASC,id ASC) rn
 FROM messages WHERE tool='claude-code';
INSERT OR IGNORE INTO message_holders(message_id,source_session_id,source_agent_id)
 SELECT w.id,l.sess,l.agent FROM claude_rank l JOIN claude_rank w
 ON w.source_message_id=l.source_message_id AND w.rn=1;
INSERT OR IGNORE INTO message_holders(message_id,source_session_id,source_agent_id)
 SELECT id,COALESCE(source_session_id,''),COALESCE(source_agent_id,'') FROM messages
 WHERE tool<>'claude-code';
DELETE FROM message_costs WHERE message_id IN (SELECT id FROM claude_rank WHERE rn>1);
DELETE FROM messages WHERE id IN (SELECT id FROM claude_rank WHERE rn>1);
DROP TABLE claude_rank;
`)
    } else {
      raw.exec(`
INSERT OR IGNORE INTO message_holders(message_id,source_session_id,source_agent_id)
 SELECT id,COALESCE(source_session_id,''),COALESCE(source_agent_id,'') FROM messages;
`)
    }
    raw.exec(`CREATE UNIQUE INDEX messages_source_identity_idx ON messages(
  tool,CASE WHEN tool='claude-code' THEN '' ELSE COALESCE(source_session_id,'') END,source_message_id)`)
    if (raw.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('message identity migration would break foreign keys')
    raw.exec('COMMIT')
  } catch (e) {
    try { raw.exec('ROLLBACK') } catch {}
    throw e
  }
}

export function openLedger(path: string, opts: { allowIdentityMigration?: boolean } = {}): LedgerDb {
  const dir = path === ':memory:' ? null : dirname(path)
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const raw = new DatabaseSync(path)
  const before = inspectSchema(raw)
  if (before.needsMigration && !opts.allowIdentityMigration) {
    raw.close()
    throw new Error('existing ledger requires explicit identity migration')
  }
  if (dir) chmodSync(dir, 0o700)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')
  if (before.tableHasOldUnique) migrateLegacyMessageIdentity(raw)
  raw.exec(DDL)
  const after = inspectSchema(raw)
  if (!before.messagesExists || before.needsMigration) migrateGraphSchema(raw, before.needsMigration, after.sourceAgentExists)
  ensureOverviewView(raw)
  if (path !== ':memory:') chmodSync(path, 0o600)
  let depth = 0
  return {
    raw,
    path,
    close: () => raw.close(),
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn()
      raw.exec('BEGIN IMMEDIATE')
      depth = 1
      try {
        const out = fn()
        raw.exec('COMMIT')
        return out
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      } finally {
        depth = 0
      }
    },
  }
}
