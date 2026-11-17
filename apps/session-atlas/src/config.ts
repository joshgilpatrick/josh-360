import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { expandHome } from './util/paths.ts'
import { ARTIFACT_DEFAULT_FRAME_ROWS } from './artifacts/contracts.ts'

// A configured output directory (artifacts.outputRoots). `path` is already absolute and normalized; it is not yet
// canonicalized against the filesystem or authorized, which root registration does. A malformed entry is dropped, never repaired.
export type ArtifactOutputRootConfig = { path: string; repositoryId: string | null; label: string | null; protected: boolean }

export type ArtifactsConfig = {
  ignoreSegments: string[]
  sensitivePatterns: string[]
  // Eligible document extensions for background discovery and the default UI filter: lowercase, no leading dot.
  documentExtensions: string[]
  outputRoots: ArtifactOutputRootConfig[]
  // Absolute base for durable output directories (~ already expanded).
  durableOutputBase: string
  initialLookbackDays: number
  recoveryIntervalMs: number
  statusMinIntervalMs: number
  debounceMs: number
  maxEntriesPerSlice: number
  maxSliceMs: number
  // Rows the service commits in one transaction on its event loop: per worker data frame (requested from the worker, which
  // never exceeds it) and per legacy-backfill transaction. 1..250 (the frozen frame maximum).
  maxRowsPerFrame: number
  gitTimeoutMs: number
  gitMaxOutputBytes: number
  hashMaxFileBytes: number
  hashMaxJobBytes: number
  hashMaxJobMs: number
  // One line per ignored or clamped setting, e.g. "artifacts.debounceMs: out of range 0..30000; using 30000". loadConfig has
  // no logger, so the service logs these at startup. Lines name the setting and its index, never the offending value.
  warnings: string[]
}
export type ProjectsConfig = { aliases: Record<string, string> }
export type SessionsConfig = { idleCloseHours: number }

export type AtlasConfig = {
  homeDir: string
  /** ~/.josh-360 (JOSH360_HOME): where cache.db, ledger.db and Atlas's own logs and settings live. */
  josh360Dir: string
  /** The ledger's facts file (ledger.db), opened read-only for the session mirror. Python writes it; Atlas never does. */
  factsPath: string
  claudeDir: string
  projectsDir: string
  ledgerPath: string
  atlasDir: string
  dbPath: string
  spoolDir: string
  logPath: string
  host: '127.0.0.1'
  port: number
  // maxLineBytes: one transcript line longer than maxDeltaBytes is read whole up to this size instead of stalling the
  // session. 0 (or any value not above maxDeltaBytes) turns that off.
  transcript: { maxDeltaBytes: number; tailBytesOnRepair: number; maxLineBytes: number }
  worker: { pollMs: number; backoffBaseMs: number; backoffMaxMs: number; maxAttempts: number }
  artifacts: ArtifactsConfig
  projects: ProjectsConfig
  sessions: SessionsConfig
  // Pi session JSONL root. Wake signals may only name files inside it (spec §2).
  piSessionsDir: string
}

const DEFAULT_PORT = 8770

function parsePort(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

// Coerces a config.json/env-sourced value to a finite number and clamps it into [min, max].
// Anything that doesn't coerce to a finite number (wrong type, "fast", null, NaN, Infinity)
// falls back to `fallback` outright, so a bad override can never produce NaN or 0 downstream
// (e.g. a 0ms poll interval spinning a runner loop at 100% CPU).
function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function readOverrides(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function mergeBlock<T extends object>(base: T, override: unknown): T {
  if (!override || typeof override !== 'object') return base
  return { ...base, ...(override as Partial<T>) }
}

// Keeps only non-blank strings from a config.json array; anything else (wrong type, blanks)
// is dropped rather than failing the whole config load.
function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
}

// Keeps only string -> non-blank string entries; keys are path prefixes, so a trailing slash is
// stripped to make prefix matching in project-name.ts unambiguous.
function stringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v.trim() || !k.trim()) continue
    out[k.trim().replace(/\/+$/, '')] = v.trim()
  }
  return out
}

const MIB = 1024 * 1024
// The frozen worker frame maximum (ARTIFACT_IPC_LIMITS.maxRows in src/artifacts/discovery.ts).
const MAX_FRAME_ROWS = 250
const DEFAULT_DOCUMENT_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'json', 'sql']
const EXTENSION_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/
const MAX_ROOT_LABEL = 200

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
}

// Artifact numbers are whole numbers inside [min, max]. Out-of-range clamps (with a warning); anything that is not a number
// or numeric string (null, booleans, blanks, Infinity) falls back to the default rather than to a bound or zero.
function boundedInt(raw: unknown, key: string, fallback: number, min: number, max: number, warnings: string[]): number {
  if (raw === undefined) return fallback
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(n)) {
    warnings.push(`artifacts.${key}: expected a number between ${min} and ${max}; using ${fallback}`)
    return fallback
  }
  const whole = Math.trunc(n)
  const bounded = Math.min(max, Math.max(min, whole))
  if (bounded !== whole) warnings.push(`artifacts.${key}: out of range ${min}..${max}; using ${bounded}`)
  return bounded
}

// A configured list replaces the default (an explicit [] clears it). Anything that is not a list falls back to the default.
function artifactStringList(raw: unknown, key: string, fallback: string[], warnings: string[]): string[] {
  if (raw === undefined) return [...fallback]
  if (!Array.isArray(raw)) {
    warnings.push(`artifacts.${key}: expected a list of strings; using the default`)
    return [...fallback]
  }
  const kept = stringList(raw)
  if (kept.length !== raw.length) warnings.push(`artifacts.${key}: ignored ${raw.length - kept.length} entries that were not non-blank strings`)
  return kept
}

function documentExtensions(raw: unknown, warnings: string[]): string[] {
  if (raw === undefined) return [...DEFAULT_DOCUMENT_EXTENSIONS]
  if (!Array.isArray(raw)) {
    warnings.push('artifacts.documentExtensions: expected a list of extensions; using the default set')
    return [...DEFAULT_DOCUMENT_EXTENSIONS]
  }
  const kept = new Set<string>()
  raw.forEach((entry, i) => {
    const ext = typeof entry === 'string' ? entry.trim().replace(/^\./, '').toLowerCase() : ''
    if (EXTENSION_RE.test(ext)) kept.add(ext)
    else warnings.push(`artifacts.documentExtensions[${i}]: not a valid extension; ignored`)
  })
  // An unusable list would silently turn document discovery off, so it falls back to the default set instead.
  if (kept.size === 0) {
    warnings.push('artifacts.documentExtensions: no usable extensions; using the default set')
    return [...DEFAULT_DOCUMENT_EXTENSIONS]
  }
  return [...kept]
}

// Resolves a configured directory to a normalized absolute path, or null when it is malformed or broad. Rejected rather than
// repaired: relative paths, ~user, control characters, any ".." segment (it could widen the path), the filesystem root, the
// home directory or any parent of it, and a "~" path that expands to somewhere outside the home directory. Whether the
// directory exists and is authorized is decided later, at root registration.
function configuredDirectory(raw: unknown, homeDir: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || CONTROL_CHARS_RE.test(trimmed)) return null
  // Checked before ~ expansion, which would silently collapse a ".." into a different directory.
  if (trimmed.split(sep).includes('..')) return null
  const expanded = expandHome(trimmed, homeDir)
  if (!isAbsolute(expanded)) return null
  const abs = resolve(expanded)
  const home = resolve(homeDir)
  if (abs === sep || abs === home || home.startsWith(abs + sep)) return null
  // expandHome resolves "~/" + rest against HOME, so "~//etc" becomes "/etc". A "~" path means "inside my home directory"
  // and must stay strictly there; only an explicitly absolute path may point elsewhere.
  if (trimmed.startsWith('~') && !abs.startsWith(home.endsWith(sep) ? home : home + sep)) return null
  return abs
}

// An optional text field: null when absent, the trimmed text when valid, false when present but unusable.
function optionalText(v: unknown, max: number): string | null | false {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return false
  const text = v.trim()
  return text && text.length <= max && !CONTROL_CHARS_RE.test(text) ? text : false
}

// Returns the root, or the reason it is disabled. An optional field of the wrong type disables the whole entry: a mistyped
// `protected` must never quietly become "unprotected".
function parseOutputRoot(entry: unknown, homeDir: string): ArtifactOutputRootConfig | string {
  if (!isPlainObject(entry)) return 'expected an object with a path; root disabled'
  const path = configuredDirectory(entry.path, homeDir)
  if (!path) return 'path must be an absolute or ~/ directory that is not the home directory or a parent of it; root disabled'
  const repositoryId = optionalText(entry.repositoryId, 128)
  if (repositoryId === false) return 'repositoryId must be a non-blank string; root disabled'
  const label = optionalText(entry.label, MAX_ROOT_LABEL)
  if (label === false) return `label must be a non-blank string of at most ${MAX_ROOT_LABEL} characters; root disabled`
  if (entry.protected !== undefined && typeof entry.protected !== 'boolean') return 'protected must be true or false; root disabled'
  return { path, repositoryId, label, protected: entry.protected === true }
}

function outputRoots(raw: unknown, homeDir: string, warnings: string[]): ArtifactOutputRootConfig[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push('artifacts.outputRoots: expected a list of root objects; no output roots enabled')
    return []
  }
  const roots: ArtifactOutputRootConfig[] = []
  raw.forEach((entry, i) => {
    const parsed = parseOutputRoot(entry, homeDir)
    if (typeof parsed === 'string') {
      warnings.push(`artifacts.outputRoots[${i}]: ${parsed}`)
      return
    }
    // The same directory declared twice is one root, and protection from either declaration sticks.
    const earlier = roots.find(r => r.path === parsed.path)
    if (earlier) {
      earlier.protected = earlier.protected || parsed.protected
      warnings.push(`artifacts.outputRoots[${i}]: repeats an earlier root; merged into it`)
    } else {
      roots.push(parsed)
    }
  })
  return roots
}

function parseArtifactsConfig(override: unknown, homeDir: string, claudeDir: string): ArtifactsConfig {
  const warnings: string[] = []
  if (override !== undefined && !isPlainObject(override)) warnings.push('artifacts: expected an object; using defaults')
  const raw = isPlainObject(override) ? override : {}
  const num = (key: string, fallback: number, min: number, max: number) => boundedInt(raw[key], key, fallback, min, max, warnings)

  let durableOutputBase = join(claudeDir, 'artifact-output')
  if (raw.durableOutputBase !== undefined) {
    const base = configuredDirectory(raw.durableOutputBase, homeDir)
    if (base) durableOutputBase = base
    else warnings.push('artifacts.durableOutputBase: expected an absolute or ~/ directory that is not the home directory or a parent of it; using the default')
  }

  return {
    ignoreSegments: artifactStringList(raw.ignoreSegments, 'ignoreSegments', ['.scratch'], warnings),
    sensitivePatterns: artifactStringList(raw.sensitivePatterns, 'sensitivePatterns', ['*.kdbx'], warnings),
    documentExtensions: documentExtensions(raw.documentExtensions, warnings),
    outputRoots: outputRoots(raw.outputRoots, homeDir, warnings),
    durableOutputBase,
    initialLookbackDays: num('initialLookbackDays', 7, 0, 3650),
    recoveryIntervalMs: num('recoveryIntervalMs', 600_000, 60_000, 86_400_000),
    statusMinIntervalMs: num('statusMinIntervalMs', 30_000, 30_000, 3_600_000),
    debounceMs: num('debounceMs', 2000, 0, 30_000),
    maxEntriesPerSlice: num('maxEntriesPerSlice', 5000, 100, 50_000),
    maxSliceMs: num('maxSliceMs', 2000, 100, 10_000),
    maxRowsPerFrame: num('maxRowsPerFrame', ARTIFACT_DEFAULT_FRAME_ROWS, 1, MAX_FRAME_ROWS),
    gitTimeoutMs: num('gitTimeoutMs', 10_000, 1000, 60_000),
    gitMaxOutputBytes: num('gitMaxOutputBytes', 8 * MIB, 1 * MIB, 64 * MIB),
    hashMaxFileBytes: num('hashMaxFileBytes', 64 * MIB, 0, 1024 * MIB),
    hashMaxJobBytes: num('hashMaxJobBytes', 128 * MIB, 0, 1024 * MIB),
    hashMaxJobMs: num('hashMaxJobMs', 5000, 0, 60_000),
    warnings,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overridesPath?: string): AtlasConfig {
  const homeDir = env.HOME ?? '/'
  const claudeDir = join(homeDir, '.claude')
  const josh360Dir = env.JOSH360_HOME ?? join(homeDir, '.josh-360')
  const atlasDir = env.ATLAS_HOME ?? join(josh360Dir, 'atlas')
  const stateDir = env.ATLAS_STATE_DIR ?? join(josh360Dir, 'state')
  const overrides = readOverrides(overridesPath ?? join(atlasDir, 'config.json'))
  const transcript = mergeBlock({ maxDeltaBytes: 2_000_000, tailBytesOnRepair: 256_000, maxLineBytes: 64 * 1024 * 1024 }, overrides.transcript)
  transcript.maxDeltaBytes = clampNumber(transcript.maxDeltaBytes, 2_000_000, 10_000, 50_000_000)
  transcript.tailBytesOnRepair = clampNumber(transcript.tailBytesOnRepair, 256_000, 1000, 5_000_000)
  transcript.maxLineBytes = clampNumber(transcript.maxLineBytes, 64 * 1024 * 1024, 0, 256 * 1024 * 1024)

  const worker = mergeBlock({ pollMs: 500, backoffBaseMs: 2000, backoffMaxMs: 300_000, maxAttempts: 5 }, overrides.worker)
  worker.pollMs = clampNumber(worker.pollMs, 500, 100, 60_000)
  worker.backoffBaseMs = clampNumber(worker.backoffBaseMs, 2000, 100, 60_000)
  worker.backoffMaxMs = clampNumber(worker.backoffMaxMs, 300_000, 1000, 3_600_000)
  worker.maxAttempts = clampNumber(worker.maxAttempts, 5, 1, 10)

  const artifacts = parseArtifactsConfig(overrides.artifacts, homeDir, claudeDir)
  const projectsRaw = overrides.projects && typeof overrides.projects === 'object' && !Array.isArray(overrides.projects) ? (overrides.projects as Record<string, unknown>) : {}
  const projects: ProjectsConfig = { aliases: stringMap(projectsRaw.aliases) }
  const sessions = mergeBlock({ idleCloseHours: 12 }, overrides.sessions)
  sessions.idleCloseHours = clampNumber(sessions.idleCloseHours, 12, 1, 24 * 365)

  const piSessionsDir = typeof overrides.piSessionsDir === 'string' && overrides.piSessionsDir.trim()
    ? expandHome(overrides.piSessionsDir, homeDir)
    : join(homeDir, '.pi', 'agent', 'sessions')

  return {
    homeDir,
    josh360Dir,
    factsPath: join(stateDir, 'ledger.db'),
    claudeDir,
    projectsDir: join(claudeDir, 'projects'),
    // The cost import and the artifact catalog share one file, cache.db (JP-111): rebuildable working tables.
    ledgerPath: join(stateDir, 'cache.db'),
    atlasDir,
    dbPath: join(stateDir, 'cache.db'),
    spoolDir: join(atlasDir, 'spool'),
    logPath: join(atlasDir, 'atlas.log'),
    host: '127.0.0.1',
    port: parsePort(env.ATLAS_PORT),
    transcript,
    worker,
    artifacts,
    projects,
    sessions,
    piSessionsDir,
  }
}
