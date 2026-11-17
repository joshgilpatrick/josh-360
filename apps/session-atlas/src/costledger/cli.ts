import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_LEDGER_PATH } from './constants.ts'
import type { LedgerDb } from './db.ts'
import { openLedger } from './db.ts'
import type { IngestSources } from './ingest.ts'
import { importAll } from './ingest.ts'
import { jiraIssueCost, recordJiraSessionLink } from './jira-links.ts'
import { addAlias, addModel, addPrice, normalizeModelName, runPricing } from './pricing.ts'
import type { BifrostWeekRow } from './reconcile.ts'
import { acceptance, compareWeeks, firstTsByKey, ledgerWeekly } from './reconcile.ts'
import type { ReportDimension } from './reports.ts'
import type { SessionTreeResult } from './session-reports.ts'
import { sessionRoots, sessionTree } from './session-reports.ts'
import type { Tool } from './types.ts'
import { REPORT_DIMENSIONS, loggedVsComputed, report, reportTotal, traceMessage, unpricedByModel } from './reports.ts'

export type CliIo = { out(s: string): void; err(s: string): void; now(): string }

const defaultIo: CliIo = {
  out: s => { process.stdout.write(`${s}\n`) },
  err: s => { process.stderr.write(`${s}\n`) },
  now: () => new Date().toISOString(),
}

const USAGE = `usage: costledger <command> [flags]
  import     [--claude-dir P] [--pi-dir P] [--opencode-db P] [--migrate-identity] [--db P] [--json]   (a value of "none" skips a source; --migrate-identity upgrades an existing ledger, back it up first)
  report     --by repo|branch|worktree|tool|model|subagent|day|session [--from ISO] [--to ISO] [--db P] [--json]
  unpriced   [--from ISO] [--to ISO] [--db P] [--json]
  reprice    [--db P] [--json]
  price add  --model M --class C --usd N --effective-from ISO [--min N] [--note T] [--db P]
  model add  --model M --vendor V [--db P]   (registers a new model; then "price add" its rates and "reprice")
  alias add  --alias A --model M [--note T] [--db P]   (another spelling of a known model; then "reprice")
  reconcile  --bifrost-file P [--db P] [--json]
  logged-cost [--from ISO] [--to ISO] [--db P] [--json]
  trace      --id SOURCE_MESSAGE_ID [--db P] [--json]
  session    --tool claude-code|opencode|pi --id SESSION_ID [--from ISO] [--to ISO] [--db P] [--json]
  jira-link  --issue KEY --tool claude-code|opencode|pi --session SESSION_ID [--db P]   (records that a session worked on a Jira issue; not for issue creation)
  jira-cost  --issue KEY [--db P] [--json]   (cost of every session linked to the issue)`

class UsageError extends Error {}

/** --from/--to/--effective-from: a value with no Z or offset is UTC (matches stored ts_utc), never the host's local time. */
function utcBound(v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined
  const t = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : `${v}Z`)
  if (Number.isNaN(t.getTime())) throw new UsageError(`--${name} must be an ISO date`)
  return t.toISOString()
}

const ALLOWED: Record<string, string[]> = {
  import: ['db', 'json', 'claude-dir', 'pi-dir', 'opencode-db', 'migrate-identity'],
  report: ['db', 'json', 'by', 'from', 'to'],
  unpriced: ['db', 'json', 'from', 'to'],
  reprice: ['db', 'json'],
  'price add': ['db', 'model', 'class', 'usd', 'effective-from', 'min', 'note'],
  'model add': ['db', 'model', 'vendor'],
  'alias add': ['db', 'alias', 'model', 'note'],
  reconcile: ['db', 'json', 'bifrost-file'],
  'logged-cost': ['db', 'json', 'from', 'to'],
  trace: ['db', 'json', 'id'],
  session: ['db', 'json', 'tool', 'id', 'from', 'to'],
  'jira-link': ['db', 'issue', 'tool', 'session'],
  'jira-cost': ['db', 'json', 'issue'],
}
const TOKEN_CLASSES = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']

function parseFlags(args: string[], allowed: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`)
    const name = a.slice(2)
    if (!allowed.includes(name)) throw new UsageError(`unknown flag --${name}`)
    if (name === 'json' || name === 'migrate-identity') { flags.set(name, true); continue }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`)
    flags.set(name, value)
    i++
  }
  return flags
}

const str = (f: Map<string, string | true>, name: string): string | undefined => {
  const v = f.get(name)
  return typeof v === 'string' ? v : undefined
}
const need = (f: Map<string, string | true>, name: string): string => {
  const v = str(f, name)
  if (v === undefined) throw new UsageError(`--${name} is required`)
  return v
}
const source = (f: Map<string, string | true>, name: string, fallback: string): string | null => {
  const v = str(f, name)
  return v === undefined ? fallback : v === 'none' ? null : v
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map(r => (r[c] ?? '').length))) ?? []
  return rows.map(r => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0))).join('  ').trimEnd()).join('\n')
}
const usd = (n: number): string => `$${n.toFixed(2)}`
const countsLine = (c: Record<string, number>): string =>
  `priced ${c.priced}, missing_price ${c.missing_price}, missing_alias ${c.missing_alias}, suspect ${c.suspect}, no_usage ${c.no_usage}`

const TOOLS: Tool[] = ['claude-code', 'opencode', 'pi']

/** Shared history is informational and undirected (never added to a family); a parent link that is not 'exact' is flagged as uncertain. */
function sessionText(r: SessionTreeResult): string[] {
  const lines = [`${r.root.tool} session ${r.root.sessionId || '(no session id)'}: own ${usd(r.root.ownCostUsd)}, family ${usd(r.root.familyCostUsd)} (${r.root.familyMessages} msgs${r.root.unpricedMessages > 0 ? `, ${r.root.unpricedMessages} unpriced` : ''})`]
  const ref = (s: string, a: string) => `${s}${a ? `/${a}` : ''}`
  lines.push(table([['node', 'kind', 'parent', 'link', 'own', 'family', 'msgs'], ...r.nodes.map(n => [
    ref(n.sessionId, n.agentId), n.kind, n.parentSessionId === null ? '-' : ref(n.parentSessionId, n.parentAgentId ?? ''),
    n.parentSessionId !== null && n.linkQuality !== 'exact' ? `UNCERTAIN (${n.linkQuality})` : n.linkQuality,
    usd(n.ownCostUsd), usd(n.familyCostUsd), String(n.familyMessages)])]))
  for (const l of r.links) {
    if (l.direction === 'undirected') lines.push(`shared history (informational, undirected, not in family cost): ${l.from} <-> ${l.to}, ${l.sharedCalls} shared calls`)
    else lines.push(`fork link: ${l.from} -> parent ${l.to}, ${l.sharedCalls} shared calls (${l.quality})`)
  }
  if (r.root.sharedHistoryCostUsd > 0) lines.push(`shared history held as copies: ${usd(r.root.sharedHistoryCostUsd)} (informational, not in family cost)`)
  return lines
}

function isBifrostRow(x: unknown): x is BifrostWeekRow {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return typeof r.week === 'string' && typeof r.virtualKey === 'string' && typeof r.model === 'string'
    && typeof r.costUsd === 'number' && typeof r.requests === 'number' && typeof r.failures === 'number'
    && typeof r.promptTokens === 'number' && typeof r.outputTokens === 'number'
}

function readBifrost(path: string): BifrostWeekRow[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(raw) || !raw.every(isBifrostRow)) throw new Error('invalid Bifrost file: expected a JSON array of {week, virtualKey, model, costUsd, requests, failures, promptTokens, outputTokens}')
  return raw
}

async function dispatch(command: string, flags: Map<string, string | true>, db: LedgerDb, io: CliIo): Promise<void> {
  const json = flags.get('json') === true
  const from = utcBound(str(flags, 'from'), 'from')
  const to = utcBound(str(flags, 'to'), 'to')
  const filter = { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  if (command === 'import') {
    const sources: IngestSources = {
      claudeProjectsDir: source(flags, 'claude-dir', join(homedir(), '.claude', 'projects')),
      piSessionsDir: source(flags, 'pi-dir', join(homedir(), '.pi', 'agent', 'sessions')),
      opencodeDb: source(flags, 'opencode-db', join(homedir(), '.local', 'share', 'opencode', 'opencode.db')),
    }
    const r = await importAll(db, sources, io.now())
    if (json) { io.out(JSON.stringify(r)); return }
    for (const tool of ['claude', 'pi', 'opencode'] as const) {
      const s = r.ingest[tool]
      io.out(`${tool}: files ${s.files}, skipped ${s.filesSkipped}, messages ${s.messages}, inserted ${s.inserted}, replaced ${s.replaced}, kept ${s.kept}`)
    }
    io.out(`pricing: ${countsLine(r.pricing)}; ${r.pricingChanged} cost rows written`)
    for (const e of r.ingest.errors) io.err(`error: ${e}`)
    return
  }
  if (command === 'report') {
    const by = need(flags, 'by')
    if (by === 'session') {
      const rows = sessionRoots(db, filter)
      if (json) { io.out(JSON.stringify({ by, rows })); return }
      io.out(table([['tool', 'session', 'own', 'family', 'msgs', 'unpriced', 'shared-history (info only)'],
        ...rows.map(r => [r.tool, r.sessionId, usd(r.ownCostUsd), usd(r.familyCostUsd), String(r.familyMessages), String(r.unpricedMessages), usd(r.sharedHistoryCostUsd)])]))
      return
    }
    if (!(REPORT_DIMENSIONS as string[]).includes(by)) throw new UsageError(`--by must be one of ${REPORT_DIMENSIONS.join(', ')}`)
    const rows = report(db, by as ReportDimension, filter)
    const total = reportTotal(db, filter)
    if (json) { io.out(JSON.stringify({ by, rows, total })); return }
    const line = (r: typeof total) => [r.key, usd(r.costUsd), String(r.messages), String(r.pricedMessages), String(r.unpricedMessages), String(r.excludedMessages), String(r.tokens)]
    io.out(table([['key', 'cost', 'msgs', 'priced', 'unpriced', 'excluded', 'tokens'], ...rows.map(line), line(total)]))
    if (total.unpricedMessages > 0) io.out(`unpriced: ${total.unpricedMessages} messages (${total.unpricedTokens} tokens); run "unpriced" for the list`)
    return
  }
  if (command === 'session') {
    const tool = need(flags, 'tool')
    if (!(TOOLS as string[]).includes(tool)) throw new UsageError(`--tool must be one of ${TOOLS.join(', ')}`)
    const result = sessionTree(db, tool as Tool, need(flags, 'id'), filter)
    if (json) { io.out(JSON.stringify(result)); return }
    for (const line of sessionText(result)) io.out(line)
    return
  }
  if (command === 'jira-link') {
    const tool = need(flags, 'tool')
    if (!(TOOLS as string[]).includes(tool)) throw new UsageError(`--tool must be one of ${TOOLS.join(', ')}`)
    recordJiraSessionLink(db, { issueKey: need(flags, 'issue'), tool, sessionId: need(flags, 'session'), action: 'worked', recordedAt: io.now() })
    return
  }
  if (command === 'jira-cost') {
    const result = jiraIssueCost(db, need(flags, 'issue'))
    if (json) { io.out(JSON.stringify(result)); return }
    io.out(`${result.issueKey}: ${result.sessions} session(s), cost ${usd(result.costUsd)}, unpriced messages ${result.unpricedMessages}`)
    return
  }
  if (command === 'unpriced') {
    const rows = unpricedByModel(db, filter)
    if (json) { io.out(JSON.stringify({ rows })); return }
    io.out(table([['status', 'model', 'msgs', 'tokens'], ...rows.map(r => [r.status, r.modelRaw, String(r.messages), String(r.tokens)])]))
    return
  }
  if (command === 'reprice') {
    const r = runPricing(db, io.now(), 'reprice')
    if (json) { io.out(JSON.stringify({ runId: r.runId, counts: r.counts, changed: r.changed })); return }
    io.out(`pricing run ${r.runId}: ${countsLine(r.counts)}; ${r.changed} cost rows written`)
    return
  }
  if (command === 'price add') {
    const model = need(flags, 'model')
    const tokenClass = need(flags, 'class')
    const usdPerMillion = Number(need(flags, 'usd'))
    const min = Number(str(flags, 'min') ?? '0')
    const effectiveFromRaw = need(flags, 'effective-from')
    if (!TOKEN_CLASSES.includes(tokenClass)) throw new UsageError(`--class must be one of ${TOKEN_CLASSES.join(', ')}`)
    if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0) throw new UsageError('--usd must be a number >= 0')
    if (!Number.isInteger(min) || min < 0) throw new UsageError('--min must be an integer >= 0')
    const effectiveFrom = utcBound(effectiveFromRaw, 'effective-from') as string
    if (!db.raw.prepare('SELECT 1 AS x FROM models WHERE model_id = ?').get(model)) throw new UsageError(`unknown model ${model}`)
    addPrice(db, { modelId: model, tokenClass, minPromptTokens: min, usdPerMillion, effectiveFrom, sourceNote: str(flags, 'note') ?? '' }, io.now())
    io.out('price added; run "reprice" to apply it')
    return
  }
  if (command === 'model add') {
    const id = addModel(db, { modelId: need(flags, 'model'), vendor: need(flags, 'vendor') })
    io.out(`model ${id} added; run "price add" for each token class it uses, then "reprice"`)
    return
  }
  if (command === 'alias add') {
    const alias = need(flags, 'alias')
    const model = need(flags, 'model')
    if (!db.raw.prepare('SELECT 1 AS x FROM models WHERE model_id = ?').get(normalizeModelName(model))) throw new UsageError(`unknown model ${model}`)
    const stored = addAlias(db, { alias, modelId: model, sourceNote: str(flags, 'note') ?? '' })
    io.out(`alias ${stored} -> ${normalizeModelName(model)} added; run "reprice" to apply it`)
    return
  }
  const pct = (p: number | null) => (p === null ? 'n/a' : `${(p * 100).toFixed(1)}%`)
  if (command === 'logged-cost') {
    const rows = loggedVsComputed(db, filter)
    if (json) { io.out(JSON.stringify({ rows })); return }
    io.out(table([['tool', 'model', 'msgs', 'logged', 'computed', 'diff%', 'flag'],
      ...rows.map(r => [r.tool, r.model, String(r.messages), usd(r.loggedUsd), usd(r.computedUsd), pct(r.diffPct), r.flagged ? 'CHECK PRICE' : ''])]))
    return
  }
  if (command === 'trace') {
    const results = traceMessage(db, need(flags, 'id'))
    if (results.length === 0) throw new Error('no message with that id')
    if (json) { io.out(JSON.stringify(results)); return }
    for (const t of results) {
      const m = t.message
      io.out(`${m.tool} ${m.source_message_id} at ${m.ts_utc}  source ${m.source_path} ${m.source_locator}`)
      io.out(`  model ${m.model_raw} -> ${t.modelId ?? '(none)'}  repo ${m.repo_key ?? '(no repo)'} @ ${m.git_branch ?? '(no branch)'}`)
      io.out(`  tokens in ${m.input_tokens} out ${m.output_tokens} cache_read ${m.cache_read_tokens} 5m ${m.cache_write_5m_tokens} 1h ${m.cache_write_1h_tokens} unclassified ${m.cache_write_unclassified_tokens}`)
      io.out(`  pricing run ${t.runId ?? '(none)'}: ${t.status}${t.costUsd === null ? '' : ` ${usd(t.costUsd)} (${t.costUsd})`}`)
      for (const p of t.prices) io.out(`  price #${p.id} ${p.modelId} ${p.tokenClass} min ${p.minPromptTokens} $${p.usdPerMillion}/M from ${p.effectiveFrom} to ${p.effectiveTo ?? 'open'} (${p.sourceNote ?? ''})`)
    }
    return
  }
  // reconcile
  const bifrost = readBifrost(need(flags, 'bifrost-file'))
  const comparison = compareWeeks(ledgerWeekly(db), bifrost, { nowIso: io.now(), firstTsByKey: firstTsByKey(db) })
  const acc = acceptance(comparison)
  if (json) { io.out(JSON.stringify({ comparison, acceptance: acc })); return }
  io.out(table([
    ['week', 'key', 'model', 'session-attributed', 'bifrost', 'diff%', 'prompt-tok diff%', 'output-tok diff%', 'complete', 'ok'],
    ...comparison.map(c => [c.week, c.virtualKey, c.modelGroup, usd(c.ledgerCostUsd), usd(c.bifrostCostUsd), pct(c.diffPct),
      pct(c.promptTokenDiffPct), pct(c.outputTokenDiffPct), c.complete ? 'yes' : 'no', c.withinTolerance ? 'yes' : 'no']),
  ]))
  for (const k of acc.keys) {
    if (k.status === 'NOT_EVALUATED') { io.out(`ACCEPTANCE ${k.virtualKey}: NOT EVALUATED (no complete weeks)`); continue }
    io.out(`ACCEPTANCE ${k.virtualKey} (${k.evaluatedWeeks} complete weeks): ${k.status}`)
    for (const w of k.weeks) {
      io.out(`  week ${w.week}: session-attributed ${usd(w.sessionAttributedUsd)}, bifrost ${usd(w.bifrostCostUsd)}, unattributed remainder ${usd(w.unattributedRemainderUsd)} (${pct(w.diffPct)}) ${w.pass ? 'pass' : 'FAIL'}${w.unpricedMessages > 0 ? `, unpriced ${w.unpricedMessages}` : ''}${w.suspectMessages > 0 ? `, suspect ${w.suspectMessages}` : ''}`)
      for (const g of w.gapModels) io.out(`    gap: ${g.modelGroup} ${usd(g.diffUsd)}`)
    }
  }
  io.out(`ACCEPTANCE OVERALL: ${acc.allPass ? 'PASS' : 'NOT PASSED'}`)
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const [first, ...rest] = argv
    if (first === undefined) throw new UsageError('missing command')
    const command = first === 'price' || first === 'model' || first === 'alias' ? `${first} ${rest.shift() ?? ''}`.trim() : first
    const allowed = ALLOWED[command]
    if (!allowed) throw new UsageError(`unknown command ${command}`)
    const flags = parseFlags(rest, allowed)
    if (flags.has('migrate-identity') && str(flags, 'db') === undefined) throw new UsageError('--migrate-identity requires an explicit --db')
    let db: LedgerDb
    try {
      db = openLedger(str(flags, 'db') ?? DEFAULT_LEDGER_PATH, { allowIdentityMigration: flags.has('migrate-identity') })
    } catch (e) {
      if (e instanceof Error && /explicit identity migration/.test(e.message)) throw new Error(`${e.message}. Back the ledger up, then run "import --migrate-identity --db <path>" once; no other command changes it.`)
      throw e
    }
    try {
      await dispatch(command, flags, db, io)
    } finally {
      db.close()
    }
    return 0
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    io.err(`error: ${message}`)
    if (e instanceof UsageError) {
      io.err(USAGE)
      return 2
    }
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code })
}
