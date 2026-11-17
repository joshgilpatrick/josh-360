// Centralized, read-only Git invocation for the Artifact Manager (plan 2026-10-26 Task 4).
//
// Atlas runs Git in the background against user repositories. Every launch goes through one policy here:
//   - argv arrays only (never a shell), `-C <absolute repo>`, and an exact per-subcommand option allowlist
//     (ARTIFACT_GIT_OPTION_POLICY): Git's long-option abbreviations never reach Git, and every unlisted option is refused;
//   - an environment built from scratch: no inherited GIT_* variable, no system or global config, no network transport, no
//     prompts, no optional index writes, no replace objects or grafts, literal pathspecs;
//   - neutralizing config (GIT_CONFIG_COUNT) for every repository-configurable command hook: fsmonitor, hooks, pager, editor,
//     askpass, ssh, credential helpers, external diff, signature verification programs, remerge diffs; and full stat
//     comparison (core.checkStat, core.trustctime), so "clean" never rests on size and mtime alone (I4);
//   - for status, ls-files and cat-file, every configured filter and diff driver is enumerated without executing anything,
//     filter clean/smudge/process and diff textconv/command are overridden to empty, and the result says
//     `filterState: 'unresolved'` whenever a filter driver exists, so no caller treats a clean status as byte-equivalence;
//     whether a configured driver actually APPLIES to the paths a caller relies on is answered separately, per path, by
//     resolveGitFilterApplication / resolveTrackedDocumentFilters (an attribute read, `check-attr`, internal to this module);
//   - a timeout that kills the whole process group and an output cap that stops reading and kills; both, like a refusal, yield
//     an explicitly incomplete result, never an empty complete one.
// Nothing here fetches, pushes, writes refs or objects, or runs a repository-configured program. Parsing lives in git-parser.ts.

import { spawn } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  decodeGitPath, isGitLfsPointer, isGitOid, parseBatchCheck, parseBatchContents, parseCheckAttrZ, parseConfigNullZ, parseGitLogZ, parseWorktreeListZ,
  sanitizeRemoteUrl, GIT_LFS_POINTER_MAX_BYTES, GIT_LOG_RECORD_FORMAT, type GitChange, type GitObjectFormat, type ParsedGitCommit,
} from './git-parser.ts'

// ------------------------------------------------------------------------------------------------------------ public types

export type GitLimits = { timeoutMs: number; maxOutputBytes: number }

/** Plan defaults: 10 s per Git command, 8 MiB of stdout. */
export const DEFAULT_GIT_LIMITS: Readonly<GitLimits> = Object.freeze({ timeoutMs: 10_000, maxOutputBytes: 8 * 1024 * 1024 })

/**
 * 'none': no filter driver is configured for this repository (repository, global or system config).
 * 'unresolved': at least one is; its commands were suppressed, so Git's notion of "clean" is not byte-equivalence with the
 * user's own Git, and blob bytes may differ from working-file bytes, for any path such a driver applies to. A call does not
 * know which paths those are: a caller that relies on byte-equivalence for particular paths asks
 * resolveGitFilterApplication (or resolveTrackedDocumentFilters), which reports exactly the paths a configured driver applies
 * to. A driver that is configured but named by no attribute in effect for a path (git-lfs installed for the user, a
 * repository that never uses it) changes nothing for that path.
 * 'not-checked': the command cannot run filters (logs, trees, refs), so configuration was not inspected.
 */
export type GitFilterState = 'none' | 'unresolved' | 'not-checked'

/**
 * Whether a configured filter driver applies to given paths (the `filter` attribute in effect names a configured driver).
 *  none        no configured driver applies to any of the paths (or no driver is configured at all);
 *  applies     at least one does: `filtered` lists exactly those paths;
 *  unresolved  the answer is unknown (configuration or attributes could not be read completely, an attribute source Git could
 *              not read, a Git failure, timeout or output cap, refused input): treat EVERY path as filtered.
 */
export type GitFilterApplication = {
  state: 'none' | 'applies' | 'unresolved'
  /** Git paths a configured driver applies to; complete only when `state` is not 'unresolved'. */
  filtered: Set<string>
  /** null unless `state` is 'unresolved': a short stable token, safe to log. */
  error: string | null
  timedOut: boolean
}

export type GitResult = {
  /** Captured stdout, at most `maxOutputBytes`; partial when truncated or timed out. */
  stdout: Buffer
  /** Git's exit code; null when it was not spawned or was killed. */
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  /**
   * null only for a run that exited 0 within its limits. Otherwise a short stable token, safe to log (no paths):
   * refused-subcommand | refused-argument | refused-repo-path | refused-limits | refused-input (nothing was spawned),
   * helper-unresolved (filter/diff drivers could not be enumerated, so the command was not run), unsupported-git (host Git older
   * than 2.36 cannot apply the policy), spawn-failed, timeout, output-cap,
   * signal, exit-nonzero. A nonzero exit can be a command's answer (merge-base --is-ancestor); callers check exitCode for that.
   */
  error: string | null
  /** True whenever `error` is set: the output must not be read as a complete answer. */
  incomplete: boolean
  signal: string | null
  /** Bounded stderr for classification. It can contain paths: never log or forward it. */
  stderr: string
  filterState: GitFilterState
}

export type GitRunOptions = {
  input?: Buffer
  /**
   * The exact stdout size the caller expects (one blob of a stored size, at most maxOutputBytes): stdout is then collected
   * straight into one buffer of that size instead of chunks plus their concatenation, so a large blob is never held twice
   * (PERF-GAP-4). Output of any other size is still returned exactly as Git wrote it (up to the cap); an unusable value is
   * ignored.
   */
  expectedBytes?: number
  /**
   * Pins the run to this repository directory (absolute; GIT_DIR, for the command and its helper-driver read): Git then never
   * discovers a repository from `repoPath` upward, so a checkout whose `.git` vanished is an error, never an answer from an
   * enclosing repository (fix round 1, I3). A relative or NUL-bearing value is refused (`refused-repo-path`).
   */
  gitDir?: string
}

/**
 * Exact options one allowlisted subcommand accepts before `--`. Matching is exact, so Git's own prefix abbreviation of long
 * options (`--filt` for `--filters`, `--del` for `--delete`) can never reach Git.
 *   exact: arguments accepted exactly as written (long flags, or a long option together with its one accepted value).
 *   valued: `--name=` keys whose glued value must match the pattern. Callers must glue values (`--contains=<rev>`,
 *     `--max-count=5`): a value in the following argument is refused.
 *   shorts: single-letter flags, alone or clustered (`-rz`, `-tvz`), each letter checked.
 *   shortValued: letters taking a glued value (`-n1`, `-uall`, `-M50%`) that ends the cluster; `-n 1` is refused.
 * Arguments that do not start with '-' are positionals (revisions, object names); user paths go after `--`.
 */
export type GitOptionPolicy = {
  readonly exact: readonly string[]
  readonly valued: Readonly<Record<string, RegExp>>
  readonly shorts: string
  readonly shortValued: Readonly<Record<string, RegExp>>
}

const NUMBER = /^\d{1,9}$/
const DATE = /^[0-9A-Za-z:@.+\- ]{1,64}$/
const RENAME_SCORE = /^\d{1,3}%?$/
const OPTIONAL_RENAME_SCORE = /^(\d{1,3}%?)?$/
const FORMAT = /^[^\0]{0,4096}$/
const REVISION = /^[^\s-][^\s]{0,1023}$/
const DIFF_MERGES = /^(off|none|first-parent|1|dense-combined|cc|combined|c|separate)$/
const policy = (p: Partial<GitOptionPolicy>): GitOptionPolicy =>
  Object.freeze({ exact: Object.freeze(p.exact ?? []), valued: Object.freeze(p.valued ?? {}), shorts: p.shorts ?? '', shortValued: Object.freeze(p.shortValued ?? {}) })

/**
 * The only subcommands runArtifactGit accepts, each with the exact options Atlas callers need (discovery, previews/exports,
 * removal checks). All are read-only under this policy: `worktree` only as `worktree list`, `symbolic-ref` only to read. Content
 * diffs (-p, --stat), conversions (--filters, --textconv), submodule recursion and every abbreviation are absent. `show` is
 * excluded because it runs textconv. Adding a subcommand or option requires a controller ruling.
 */
export const ARTIFACT_GIT_OPTION_POLICY: Readonly<Record<string, GitOptionPolicy>> = Object.freeze({
  status: policy({
    exact: ['--porcelain', '--porcelain=v1', '--short', '--branch', '--null', '--ignored', '--ignored=traditional', '--ignored=matching', '--ignored=no',
      '--untracked-files', '--untracked-files=all', '--untracked-files=normal', '--untracked-files=no', '--renames', '--no-renames', '--find-renames',
      '--no-ahead-behind'],
    valued: { '--find-renames=': RENAME_SCORE },
    shorts: 'zsb',
    shortValued: { u: /^(all|normal|no)?$/ },
  }),
  'ls-files': policy({
    exact: ['--cached', '--deleted', '--modified', '--others', '--ignored', '--stage', '--unmerged', '--killed', '--directory', '--no-empty-directory',
      '--exclude-standard', '--full-name', '--error-unmatch', '--deduplicate'],
    valued: { '--exclude=': /^[^\0\n]{1,1024}$/ },
    // -v / -t (R23) tag assume-unchanged and skip-worktree entries, which status hides.
    shorts: 'zsoimduktv',
  }),
  'ls-tree': policy({ exact: ['--long', '--name-only', '--name-status', '--object-only', '--full-name', '--full-tree'], shorts: 'rdtzl' }),
  log: policy({
    exact: ['--raw', '--name-status', '--name-only', '--no-abbrev', '--full-history', '--first-parent', '--no-merges', '--merges', '--reverse',
      '--topo-order', '--date-order', '--all', '--branches', '--tags', '--no-walk', '--no-walk=unsorted', '--no-walk=sorted', '--stdin', '--not',
      '--find-renames', '--no-renames', '--no-color', '--no-relative', '--root', '--follow', '--ignore-missing', '--parents', '--boundary',
      '--no-decorate', '--no-textconv', '--no-ext-diff', '--no-show-signature'],
    valued: {
      '--format=': FORMAT, '--pretty=': FORMAT, '--max-count=': NUMBER, '--skip=': NUMBER, '--max-age=': NUMBER, '--min-age=': NUMBER,
      '--since=': DATE, '--until=': DATE, '--after=': DATE, '--before=': DATE, '--find-renames=': RENAME_SCORE, '--diff-merges=': DIFF_MERGES,
      '--max-parents=': NUMBER, '--min-parents=': NUMBER,
    },
    shorts: 'z',
    shortValued: { n: NUMBER, M: OPTIONAL_RENAME_SCORE },
  }),
  'rev-parse': policy({
    exact: ['--verify', '--quiet', '--show-toplevel', '--show-prefix', '--show-cdup', '--git-common-dir', '--absolute-git-dir', '--is-inside-work-tree',
      '--is-inside-git-dir', '--is-bare-repository', '--is-shallow-repository', '--show-object-format', '--show-object-format=storage',
      '--path-format=absolute', '--path-format=relative', '--symbolic-full-name', '--abbrev-ref'],
    shorts: 'q',
  }),
  'rev-list': policy({
    exact: ['--all', '--branches', '--tags', '--stdin', '--not', '--no-walk', '--no-walk=unsorted', '--no-walk=sorted', '--count', '--objects',
      '--first-parent', '--reverse', '--topo-order', '--date-order', '--boundary', '--parents', '--ignore-missing', '--missing=allow-any',
      '--missing=allow-promisor', '--missing=print', '--merges', '--no-merges', '--quiet', '--full-history'],
    valued: {
      '--max-count=': NUMBER, '--skip=': NUMBER, '--max-age=': NUMBER, '--min-age=': NUMBER, '--since=': DATE, '--until=': DATE,
      '--max-parents=': NUMBER, '--min-parents=': NUMBER,
    },
    shortValued: { n: NUMBER },
  }),
  'for-each-ref': policy({
    valued: {
      '--format=': FORMAT, '--sort=': /^-?[a-z*:()]{1,64}$/, '--count=': NUMBER, '--contains=': REVISION, '--no-contains=': REVISION,
      '--merged=': REVISION, '--no-merged=': REVISION, '--points-at=': REVISION,
    },
  }),
  'show-ref': policy({ exact: ['--verify', '--heads', '--tags', '--head', '--dereference', '--quiet', '--hash', '--exists'], shorts: 'qds' }),
  'symbolic-ref': policy({ exact: ['--quiet', '--short', '--no-recurse'], shorts: 'q' }),
  worktree: policy({ exact: ['--porcelain', '--verbose'], shorts: 'zv' }),
  'cat-file': policy({
    exact: ['--batch', '--batch-check', '--batch-command', '--buffer', '--unordered', '--batch-all-objects'],
    valued: { '--batch=': FORMAT, '--batch-check=': FORMAT, '--batch-command=': FORMAT },
    shorts: 'etspz',
  }),
  'diff-tree': policy({
    exact: ['--raw', '--name-status', '--name-only', '--no-abbrev', '--no-commit-id', '--root', '--stdin', '--find-renames', '--no-renames',
      '--no-textconv', '--no-ext-diff', '--no-color', '--no-relative'],
    valued: { '--find-renames=': RENAME_SCORE },
    shorts: 'rtz',
    shortValued: { M: OPTIONAL_RENAME_SCORE },
  }),
  'merge-base': policy({ exact: ['--is-ancestor', '--independent', '--all', '--octopus'], shorts: 'a' }),
})

/** The subcommands of ARTIFACT_GIT_OPTION_POLICY. */
export const ARTIFACT_GIT_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze(Object.keys(ARTIFACT_GIT_OPTION_POLICY))

/**
 * Arguments (before `--`) beginning with any of these are refused. With the exact option policy none of them can pass anyway;
 * the list stays as a second, independent check (and documents R22).
 */
export const ARTIFACT_GIT_REFUSED_ARG_PREFIXES: readonly string[] = Object.freeze([
  '--upload-pack', '--receive-pack', '--exec', '--output', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace',
  '--super-prefix', '--textconv', '--filters', '--ext-diff', '--show-signature', '--remerge-diff', '--recurse-submodules',
  // Runs core.alternateRefsCommand for each alternate object store.
  '--alternate-refs',
])

export class GitAdapterError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`git adapter: ${code}`)
    this.name = 'GitAdapterError'
    this.code = code
  }
}

export type GitHead = {
  /** Commit OID HEAD names; null when unborn (or unresolvable while detached). */
  oid: string | null
  /** The branch HEAD points at (refs/heads/...); null when detached. */
  ref: string | null
  detached: boolean
  unborn: boolean
}

export type GitRemote = { name: string; url: string | null }

/** One checkout (work tree) of a repository. Linked worktrees share `commonDir` and history; each has its own gitDir/index. */
export type GitCheckout = {
  /** Canonical absolute top level of the work tree (as reported by Git when the directory is gone: see `prunable`). */
  worktreePath: string
  /** Canonical per-checkout Git directory (equals commonDir for the main checkout). */
  gitDir: string
  /** Canonical common Git directory: the repository's shared objects and refs. */
  commonDir: string
  isMain: boolean
  objectFormat: GitObjectFormat
  shallow: boolean
  /** Promisor (partial clone) repository: objects may be missing locally and are never fetched by Atlas. */
  partialClone: boolean
  head: GitHead
  locked: boolean
  /** The worktree's directory is missing (Git would prune it). */
  prunable: boolean
  /** Remote display identities with credentials, query and fragment removed. */
  remotes: GitRemote[]
}

// ------------------------------------------------------------------------------------------------------- invocation policy

const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024
/** Upper bound for a stdin payload (object IDs for batch commands). */
export const MAX_GIT_INPUT_BYTES = 8 * 1024 * 1024
const STDERR_CAP_BYTES = 16 * 1024
const MAX_HELPER_DRIVERS = 64
// A path that cannot exist (/dev/null is not a directory): where a program or file name must be given, nothing can be found.
const NOWHERE = '/dev/null/atlas-disabled'

// Fixed environment for every launch. Nothing is inherited except PATH (to find git itself).
const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: 'C',
  LANG: 'C',
  HOME: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: ':',
  GIT_SEQUENCE_EDITOR: ':',
  // Set-but-empty allowlist: no transport (file, ssh, https, ext::, remote helpers) is permitted, so lazy fetches of missing
  // promisor objects, credential helpers and ssh commands are never reached.
  GIT_ALLOW_PROTOCOL: '',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: NOWHERE,
  GIT_ATTR_NOSYSTEM: '1',
})

// Command-line-scope config (highest precedence, applied through GIT_CONFIG_COUNT) for every launch.
const BASE_CONFIG_OVERRIDES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NOWHERE],
  ['core.pager', 'cat'],
  ['core.editor', ':'],
  ['sequence.editor', ':'],
  ['core.askPass', '/bin/false'],
  ['core.sshCommand', '/bin/false'],
  ['credential.helper', ''],
  ['diff.external', ''],
  ['log.showSignature', 'false'],
  ['log.diffMerges', 'first-parent'],
  ['gpg.program', '/bin/false'],
  ['gpg.openpgp.program', '/bin/false'],
  ['gpg.x509.program', '/bin/false'],
  ['gpg.ssh.program', '/bin/false'],
  ['protocol.allow', 'never'],
  ['color.ui', 'false'],
  ['log.showRoot', 'true'],
  ['diff.relative', 'false'],
  ['submodule.recurse', 'false'],
  ['status.submoduleSummary', 'false'],
  ['safe.bareRepository', 'explicit'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['i18n.logOutputEncoding', 'UTF-8'],
  // I4: a user config that compares only size and mtime (checkStat=minimal, trustctime=false) would call a same-size edit
  // with its mtime restored clean. Full stat comparison only ever adds content comparisons; it never skips one.
  ['core.checkStat', 'default'], ['core.trustctime', 'true'],
] as const)

// Options placed directly after the subcommand. Everything that could re-enable what they disable is refused in user args.
const INSERTED_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  log: ['--no-textconv', '--no-ext-diff', '--no-show-signature'],
  'diff-tree': ['--no-textconv', '--no-ext-diff'],
  // Submodule status would spawn Git inside each submodule under that submodule's own (un-enumerated) config.
  status: ['--ignore-submodules=all'],
})

// Commands that run with every configured filter and diff driver blanked: work-tree readers (clean filters, fsmonitor) and
// cat-file (smudge filters and textconv, which only its refused --filters/--textconv modes would reach).
const HELPER_BLANKED = new Set(['status', 'ls-files', 'cat-file'])

// Commands whose --stdin accepts revision pseudo-options.
const STDIN_REVISION_COMMANDS = new Set(['log', 'rev-list', 'diff-tree'])

// GIT_CONFIG_COUNT (the neutralizing overrides) needs Git 2.31; `worktree list --porcelain -z` needs 2.36. On older Git the
// overrides would be silently ignored, so every command is refused instead.
const MIN_GIT_VERSION: readonly [number, number] = [2, 36]

let spawnCount = 0

/** Number of Git processes this module has launched (diagnostics and tests: batching must not scale with file count). */
export function artifactGitSpawnCount(): number {
  return spawnCount
}

function normalizeLimits(limits: GitLimits): GitLimits | null {
  if (!limits || typeof limits !== 'object') return null
  const { timeoutMs, maxOutputBytes } = limits
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return null
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) return null
  return { timeoutMs, maxOutputBytes }
}

function validRepoPath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0')
}

/** True when `arg` (an option-looking argument before `--`) is exactly allowed by `p`. */
function optionAllowed(p: GitOptionPolicy, arg: string): boolean {
  if (p.exact.includes(arg)) return true
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    if (eq < 0) return false
    const pattern = p.valued[arg.slice(0, eq + 1)]
    return pattern !== undefined && pattern.test(arg.slice(eq + 1))
  }
  if (arg.length < 2) return false // a lone '-' (stdin) is not an option Atlas uses
  for (let i = 1; i < arg.length; i++) {
    const letter = arg[i]!
    const valuePattern = Object.hasOwn(p.shortValued, letter) ? p.shortValued[letter] : undefined
    if (valuePattern) return valuePattern.test(arg.slice(i + 1)) // the glued value ends the cluster
    if (!p.shorts.includes(letter)) return false
  }
  return true
}

/** Why `args` must not run, or null. Only arguments before `--` are options; after it they are paths/positionals. */
function argumentRefusal(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return 'refused-subcommand'
  for (const a of args) if (typeof a !== 'string' || a.includes('\0')) return 'refused-argument'
  const all = args as string[]
  const sub = all[0]!
  if (!Object.hasOwn(ARTIFACT_GIT_OPTION_POLICY, sub)) return 'refused-subcommand'
  const p = ARTIFACT_GIT_OPTION_POLICY[sub]!
  const rest = all.slice(1)
  const dd = rest.indexOf('--')
  const before = dd < 0 ? rest : rest.slice(0, dd)
  const after = dd < 0 ? [] : rest.slice(dd + 1)
  if (sub === 'worktree') {
    // `worktree list` and its flags only: no other worktree subcommand, no positional, nothing after `--`.
    if (before[0] !== 'list' || dd >= 0) return 'refused-subcommand'
    before.shift()
  }
  const positionals: string[] = []
  for (const a of before) {
    if (!a.startsWith('-')) { positionals.push(a); continue }
    if (ARTIFACT_GIT_REFUSED_ARG_PREFIXES.some(prefix => a.startsWith(prefix))) return 'refused-argument'
    if (!optionAllowed(p, a)) return 'refused-argument'
    // %G… placeholders and %(signature) atoms verify signatures with an external program.
    if (a.includes('%G') || a.includes('%(signature')) return 'refused-argument'
  }
  if (sub === 'worktree' && positionals.length > 0) return 'refused-argument'
  // A second positional makes symbolic-ref write HEAD (or any symref).
  if (sub === 'symbolic-ref' && positionals.length + after.length > 1) return 'refused-argument'
  return null
}

type EnvOptions = { literalPathspecs: boolean; userConfigView?: boolean; userAttributeView?: boolean; gitDir?: string | null }

function gitEnv(overrides: ReadonlyArray<readonly [string, string]>, opts: EnvOptions): Record<string, string> {
  const env: Record<string, string> = { ...BASE_ENV, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }
  if (opts.userConfigView || opts.userAttributeView) {
    // Read-only enumeration of the configuration the user's own Git would load (system, global, repository). Used only to
    // learn which filter drivers exist, and which of them the user's attributes apply; the commands that read or write a
    // repository's contents never load system or global config.
    delete env.GIT_CONFIG_NOSYSTEM
    delete env.GIT_CONFIG_SYSTEM
    delete env.GIT_CONFIG_GLOBAL
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL']) {
      const value = process.env[key]
      if (value !== undefined && !value.includes('\0')) env[key] = value
    }
  }
  if (opts.userAttributeView) {
    // The attribute files the user's own Git reads: the system file unless the user's environment disables it, the global
    // file (core.attributesFile, or the XDG default under HOME), the repository's info/attributes and .gitattributes files.
    delete env.GIT_ATTR_NOSYSTEM
    const value = process.env.GIT_ATTR_NOSYSTEM
    if (value !== undefined && !value.includes('\0')) env.GIT_ATTR_NOSYSTEM = value
  }
  if (opts.literalPathspecs) env.GIT_LITERAL_PATHSPECS = '1'
  if (opts.gitDir) env.GIT_DIR = opts.gitDir
  overrides.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  env.GIT_CONFIG_COUNT = String(overrides.length)
  return env
}

type SpawnOutcome = { stdout: Buffer; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean; spawnFailed: boolean }

/** Launches `git --no-pager -C <repo> <args>` in its own process group, bounded by `deadline` and the output cap. */
function spawnGit(repoPath: string, args: string[], env: Record<string, string>, limits: GitLimits, input: Buffer | null, deadline: number, expectedBytes: number | null = null): Promise<SpawnOutcome> {
  return new Promise(resolveOutcome => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      resolveOutcome({ stdout: Buffer.alloc(0), stderr: '', exitCode: null, signal: null, timedOut: true, truncated: false, spawnFailed: false })
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['--no-pager', '-C', repoPath, ...args], {
        cwd: '/', env, detached: true, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolveOutcome({ stdout: Buffer.alloc(0), stderr: '', exitCode: null, signal: null, timedOut: false, truncated: false, spawnFailed: true })
      return
    }
    spawnCount++
    const chunks: Buffer[] = []
    let size = 0
    // With an expected size, bytes go straight into one buffer of that size; the first byte past it falls back to chunks, so
    // the result is always exactly what Git wrote (up to the cap).
    let target: Buffer | null = expectedBytes !== null ? Buffer.alloc(expectedBytes) : null
    const store = (part: Buffer): void => {
      if (target !== null && size + part.length <= target.length) {
        part.copy(target, size)
      } else {
        if (target !== null) { chunks.push(target.subarray(0, size)); target = null }
        chunks.push(part)
      }
      size += part.length
    }
    const errChunks: Buffer[] = []
    let errSize = 0
    let truncated = false
    let timedOut = false
    let killed = false
    let spawnFailed = false
    let settled = false

    const killGroup = (): void => {
      if (killed) return
      killed = true
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveOutcome({
        stdout: target !== null ? target.subarray(0, size) : Buffer.concat(chunks, size), stderr: Buffer.concat(errChunks, errSize).toString('utf8'),
        exitCode: killed ? null : exitCode, signal, timedOut, truncated, spawnFailed,
      })
    }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, remaining)

    child.stdout!.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = limits.maxOutputBytes - size
      if (chunk.length > room) {
        if (room > 0) store(chunk.subarray(0, room))
        truncated = true
        killGroup()
        child.stdout!.destroy()
        return
      }
      store(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      if (errSize >= STDERR_CAP_BYTES) return
      const part = chunk.subarray(0, STDERR_CAP_BYTES - errSize)
      errChunks.push(part)
      errSize += part.length
    })
    child.on('error', () => { spawnFailed = true; finish(null, null) })
    // After a kill, a descendant that escaped the group could hold the pipes open: do not wait on them.
    child.on('exit', (code, signal) => {
      if (killed) { child.stdout?.destroy(); child.stderr?.destroy(); finish(null, signal) }
      else if (code === null) finish(null, signal)
    })
    child.on('close', (code, signal) => finish(code, signal))
    if (input && child.stdin) {
      child.stdin.on('error', () => { /* Git may exit before reading all input; its exit status reports that */ })
      child.stdin.end(input)
    }
  })
}

function toResult(o: SpawnOutcome, filterState: GitFilterState): GitResult {
  let error: string | null = null
  if (o.spawnFailed) error = 'spawn-failed'
  else if (o.truncated) error = 'output-cap'
  else if (o.timedOut) error = 'timeout'
  else if (o.exitCode === null) error = 'signal'
  else if (o.exitCode !== 0) error = 'exit-nonzero'
  return {
    stdout: o.stdout, exitCode: o.exitCode, timedOut: o.timedOut, truncated: o.truncated, error, incomplete: error !== null,
    signal: o.signal, stderr: o.stderr, filterState,
  }
}

function refusedResult(error: string): GitResult {
  return { stdout: Buffer.alloc(0), exitCode: null, timedOut: false, truncated: false, error, incomplete: true, signal: null, stderr: '', filterState: 'not-checked' }
}

type HelperDrivers = { filters: string[]; diffs: string[] }
type HelperEnumeration = { drivers: HelperDrivers; error: null; timedOut: boolean } | { drivers: null; error: string; timedOut: boolean }

/**
 * Names of every configured filter driver and diff driver, read with `git config --get-regexp` (which only reads configuration
 * files) under the user's own configuration view, so drivers from global/system config (e.g. Git LFS) are seen too.
 */
async function enumerateHelperDrivers(repoPath: string, limits: GitLimits, deadline: number, gitDir: string | null = null): Promise<HelperEnumeration> {
  const env = gitEnv(BASE_CONFIG_OVERRIDES, { literalPathspecs: true, userConfigView: true, gitDir })
  const o = await spawnGit(repoPath, ['config', '--null', '--get-regexp', '^(filter|diff)\\.'], env, limits, null, deadline)
  if (o.timedOut) return { drivers: null, error: 'timeout', timedOut: true }
  if (o.truncated || o.spawnFailed || o.exitCode === null) return { drivers: null, error: 'helper-unresolved', timedOut: false }
  if (o.exitCode === 1 && o.stdout.length === 0) return { drivers: { filters: [], diffs: [] }, error: null, timedOut: false }
  if (o.exitCode !== 0) return { drivers: null, error: 'helper-unresolved', timedOut: false }
  const parsed = parseConfigNullZ(o.stdout)
  if (parsed.malformed) return { drivers: null, error: 'helper-unresolved', timedOut: false }
  const filters = new Set<string>()
  const diffs = new Set<string>()
  for (const { key } of parsed.entries) {
    const first = key.indexOf('.')
    const last = key.lastIndexOf('.')
    if (first < 0 || last <= first) continue // `filter.<var>` / `diff.<var>` without a driver name is not a driver
    const name = key.slice(first + 1, last)
    if (name.includes('\n')) return { drivers: null, error: 'helper-unresolved', timedOut: false }
    ;(key.slice(0, first) === 'filter' ? filters : diffs).add(name)
  }
  if (filters.size > MAX_HELPER_DRIVERS || diffs.size > MAX_HELPER_DRIVERS) return { drivers: null, error: 'helper-unresolved', timedOut: false }
  return { drivers: { filters: [...filters].sort(), diffs: [...diffs].sort() }, error: null, timedOut: false }
}

function blankingOverrides(drivers: HelperDrivers): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = []
  for (const name of drivers.filters) {
    out.push([`filter.${name}.clean`, ''], [`filter.${name}.smudge`, ''], [`filter.${name}.process`, ''], [`filter.${name}.required`, 'false'])
  }
  for (const name of drivers.diffs) out.push([`diff.${name}.textconv`, ''], [`diff.${name}.command`, ''])
  return out
}

let versionGate: Promise<boolean> | null = null

/** Whether the host Git is new enough for this policy. A definitive answer is cached; a failed probe is retried next time. */
function gitSupportsPolicy(): Promise<boolean> {
  versionGate ??= (async () => {
    const o = await spawnGit('/', ['version'], gitEnv(BASE_CONFIG_OVERRIDES, { literalPathspecs: true }), DEFAULT_GIT_LIMITS, null, Date.now() + DEFAULT_GIT_LIMITS.timeoutMs)
    const m = /^git version (\d+)\.(\d+)/.exec(o.stdout.toString('latin1'))
    if (o.exitCode !== 0 || !m) {
      versionGate = null
      return false
    }
    const [major, minor] = [Number(m[1]), Number(m[2])]
    return major > MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor >= MIN_GIT_VERSION[1])
  })()
  return versionGate
}

type ExecOptions = { input?: Buffer | null; literalPathspecs?: boolean; drivers?: HelperDrivers; expectedBytes?: number | null; gitDir?: string | null }

/** Runs pre-validated argv under the full policy. Internal callers pass only fixed, adapter-built arguments. */
async function execPolicyGit(repoPath: string, args: string[], limits: GitLimits, opts: ExecOptions = {}): Promise<GitResult> {
  if (!(await gitSupportsPolicy())) return refusedResult('unsupported-git')
  const deadline = Date.now() + limits.timeoutMs
  const sub = args[0]!
  const overrides: Array<readonly [string, string]> = [...BASE_CONFIG_OVERRIDES]
  let filterState: GitFilterState = 'not-checked'
  if (HELPER_BLANKED.has(sub)) {
    let drivers = opts.drivers
    if (!drivers) {
      const found = await enumerateHelperDrivers(repoPath, limits, deadline, opts.gitDir ?? null)
      if (found.drivers === null) {
        // Cannot prove the command helper-free: do not run it.
        return { ...refusedResult(found.error), timedOut: found.timedOut, filterState: 'unresolved' }
      }
      drivers = found.drivers
    }
    overrides.push(...blankingOverrides(drivers))
    filterState = drivers.filters.length > 0 ? 'unresolved' : 'none'
  }
  const argv = [sub, ...(INSERTED_OPTIONS[sub] ?? []), ...args.slice(1)]
  const env = gitEnv(overrides, { literalPathspecs: opts.literalPathspecs ?? true, gitDir: opts.gitDir ?? null })
  const outcome = await spawnGit(repoPath, argv, env, limits, opts.input ?? null, deadline, opts.expectedBytes ?? null)
  return toResult(outcome, filterState)
}

/**
 * Runs one allowlisted, read-only Git command in `repoPath` (absolute) under the adapter's invocation policy. Refusals,
 * timeouts, output caps and unprovable helper suppression come back as results with `error` set; this never throws.
 * Pass user paths after `--`: pathspecs are literal (no globbing or `:` magic).
 */
export async function runArtifactGit(repoPath: string, args: string[], limits: GitLimits, options: GitRunOptions = {}): Promise<GitResult> {
  const lim = normalizeLimits(limits)
  if (!lim) return refusedResult('refused-limits')
  if (!validRepoPath(repoPath)) return refusedResult('refused-repo-path')
  const gitDir = options?.gitDir
  if (gitDir !== undefined && !validRepoPath(gitDir)) return refusedResult('refused-repo-path')
  const refusal = argumentRefusal(args)
  if (refusal) return refusedResult(refusal)
  const input = options?.input
  if (input !== undefined && (!Buffer.isBuffer(input) || input.length > MAX_GIT_INPUT_BYTES)) return refusedResult('refused-input')
  // Revision commands read pseudo-options from --stdin (Git 2.42+), e.g. --alternate-refs, which runs a configured command.
  if (input !== undefined && STDIN_REVISION_COMMANDS.has(args[0]!) && input.toString('latin1').split('\n').some(line => line.startsWith('-'))) {
    return refusedResult('refused-input')
  }
  const expected = options?.expectedBytes
  const expectedBytes = Number.isInteger(expected) && expected! >= 0 && expected! <= lim.maxOutputBytes ? expected! : null
  return execPolicyGit(repoPath, [...args], lim, { input: input ?? null, expectedBytes, gitDir: gitDir ?? null })
}

// ------------------------------------------------------------------------------------------------------- filter application

/** stdin bytes per `check-attr` process (well under MAX_GIT_INPUT_BYTES). */
const ATTR_INPUT_CHUNK_BYTES = 4 * 1024 * 1024

const isGitRelativePath = (p: unknown): p is string =>
  typeof p === 'string' && p.length > 0 && !p.includes('\0') && p.split('/').every(s => s !== '' && s !== '.' && s !== '..')

const unresolvedFilters = (error: string, timedOut = false): GitFilterApplication => ({ state: 'unresolved', filtered: new Set(), error, timedOut })

/**
 * Which of `paths` have a `filter` attribute naming one of the configured `drivers`: `git check-attr -z --stdin filter`, in
 * bounded stdin chunks, under the user's own configuration and attribute view (system and global attribute files included,
 * exactly what the user's Git would apply) with every command hook neutralized and every driver blanked. check-attr only reads
 * configuration, attribute files and the index; it runs no driver. Git merely WARNS about an attribute file it cannot read
 * (a permission failure, a symlinked .gitattributes) and goes on as if it were empty, so any stderr output is 'unresolved'.
 */
async function filterApplication(worktreePath: string, paths: string[], drivers: HelperDrivers, lim: GitLimits): Promise<GitFilterApplication> {
  const filtered = new Set<string>()
  if (drivers.filters.length === 0 || paths.length === 0) return { state: 'none', filtered, error: null, timedOut: false }
  const configured = new Set(drivers.filters)
  const env = gitEnv([...BASE_CONFIG_OVERRIDES, ...blankingOverrides(drivers)], { literalPathspecs: true, userAttributeView: true })
  const groups: string[][] = []
  let group: string[] = []
  let bytes = 0
  for (const p of paths) {
    const n = Buffer.byteLength(p) + 1
    if (group.length > 0 && bytes + n > ATTR_INPUT_CHUNK_BYTES) { groups.push(group); group = []; bytes = 0 }
    group.push(p)
    bytes += n
  }
  if (group.length > 0) groups.push(group)
  for (const chunk of groups) {
    const input = Buffer.from(chunk.map(p => `${p}\0`).join(''), 'utf8')
    const o = await spawnGit(worktreePath, ['check-attr', '-z', '--stdin', 'filter'], env, lim, input, Date.now() + lim.timeoutMs)
    const r = toResult(o, 'not-checked')
    if (r.error !== null) return unresolvedFilters(r.error, r.timedOut)
    if (o.stderr.length > 0) return unresolvedFilters('attribute-source-unreadable')
    const parsed = parseCheckAttrZ(o.stdout)
    if (parsed.malformed || parsed.records.length !== chunk.length) return unresolvedFilters('malformed-output')
    for (const [i, rec] of parsed.records.entries()) {
      // Records come back in input order, one per path, naming the path exactly as given.
      if (rec.path !== chunk[i] || rec.attribute !== 'filter') return unresolvedFilters('malformed-output')
      // `set` (the attribute without a value) and `unset`/`unspecified` name no driver, unless a driver is literally called so.
      if (configured.has(rec.value)) filtered.add(rec.path)
    }
  }
  return { state: filtered.size > 0 ? 'applies' : 'none', filtered, error: null, timedOut: false }
}

/**
 * Which of `gitPaths` a configured filter driver applies to: the paths for which Git's "clean" (and a blob's bytes) may differ
 * from the working file's bytes under the user's own Git. `worktreePath` is the absolute top level of a work tree and each path
 * is a normalized Git path relative to it. With no driver configured this costs one configuration read and no attribute read.
 * Never throws; every doubt is `unresolved` (see GitFilterApplication). A configured driver that no attribute names for a
 * path (git-lfs installed for the user, a repository that never uses it) does not apply to it.
 */
export async function resolveGitFilterApplication(worktreePath: string, gitPaths: readonly string[], limits: GitLimits): Promise<GitFilterApplication> {
  const lim = normalizeLimits(limits)
  if (!lim) return unresolvedFilters('refused-limits')
  if (!validRepoPath(worktreePath)) return unresolvedFilters('refused-repo-path')
  if (!Array.isArray(gitPaths) || !gitPaths.every(isGitRelativePath)) return unresolvedFilters('refused-input')
  if (gitPaths.length === 0) return { state: 'none', filtered: new Set(), error: null, timedOut: false }
  if (!(await gitSupportsPolicy())) return unresolvedFilters('unsupported-git')
  const found = await enumerateHelperDrivers(worktreePath, lim, Date.now() + lim.timeoutMs)
  if (found.drivers === null) return unresolvedFilters(found.error, found.timedOut)
  return filterApplication(worktreePath, [...new Set(gitPaths)], found.drivers, lim)
}

/**
 * Which TRACKED files with one of `documentExtensions` (case-insensitive, no dot) a configured filter driver applies to,
 * anywhere in the work tree at `worktreePath` (its absolute top level), or only below `rootRelative` (a Git path): `ls-files -z`
 * with extension pathspecs (see lsTrackedDocuments), then the attribute read of resolveGitFilterApplication. With no driver
 * configured, only the configuration is read.
 */
export async function resolveTrackedDocumentFilters(worktreePath: string, documentExtensions: readonly string[], limits: GitLimits, rootRelative = ''): Promise<GitFilterApplication> {
  const lim = normalizeLimits(limits)
  if (!lim) return unresolvedFilters('refused-limits')
  if (!validRepoPath(worktreePath)) return unresolvedFilters('refused-repo-path')
  const pathspecs = extensionPathspecs(documentExtensions)
  if (pathspecs === null || pathspecs === 'invalid') return unresolvedFilters('refused-extension')
  if (!(await gitSupportsPolicy())) return unresolvedFilters('unsupported-git')
  const found = await enumerateHelperDrivers(worktreePath, lim, Date.now() + lim.timeoutMs)
  if (found.drivers === null) return unresolvedFilters(found.error, found.timedOut)
  if (found.drivers.filters.length === 0) return { state: 'none', filtered: new Set(), error: null, timedOut: false }
  const list = await lsTrackedDocuments(worktreePath, ['ls-files', '-z'], rootRelative, documentExtensions, lim, found.drivers)
  if (list.error !== null) return unresolvedFilters(list.error, list.timedOut)
  const paths = new Set<string>()
  let start = 0
  for (;;) {
    const at = list.stdout.indexOf(0, start)
    if (at < 0) break
    const path = decodeGitPath(list.stdout.subarray(start, at))
    // A tracked name that is not lossless UTF-8 cannot be asked about by name: its filter state stays unknown.
    if (path === null) return unresolvedFilters('lossy-path')
    paths.add(path)
    start = at + 1
  }
  if (start !== list.stdout.length) return unresolvedFilters('malformed-output')
  return filterApplication(worktreePath, [...paths], found.drivers, lim)
}

/**
 * m1: `ls-files -v --cached --modified -z` for the tracked files with one of `documentExtensions` below `rootRelative` (a Git
 * path relative to the work tree top `worktreePath`; '' for the whole tree), so that a large folder's other files never
 * count against the output cap. Never throws; errors as runArtifactGit's.
 */
export async function listTrackedDocumentStates(worktreePath: string, rootRelative: string, documentExtensions: readonly string[], limits: GitLimits): Promise<GitResult> {
  const lim = normalizeLimits(limits)
  if (!lim) return refusedResult('refused-limits')
  if (!validRepoPath(worktreePath)) return refusedResult('refused-repo-path')
  return lsTrackedDocuments(worktreePath, ['ls-files', '-v', '--cached', '--modified', '-z'], rootRelative, documentExtensions, lim)
}

/** argv bytes of pathspecs per `ls-files` launch: far below every platform's argument limit. */
export const PATHSPEC_ARGV_CHUNK_BYTES = 64 * 1024

/**
 * `git <args> -- <extension pathspecs below rootRelative>`, internal (fixed arguments; glob magic in the root path escaped, so
 * it matches literally) over argv-bounded launches that share one driver read, one deadline and one output cap: each launch
 * may write only what the ones before it left ('output-cap' beyond it), so at most one cap of output is ever held.
 */
async function lsTrackedDocuments(top: string, args: string[], rootRelative: string, exts: unknown, lim: GitLimits, drivers?: HelperDrivers): Promise<GitResult> {
  const specs = extensionPathspecs(exts)
  if (specs === null || specs === 'invalid') return refusedResult('refused-extension')
  if (rootRelative !== '' && !isGitRelativePath(rootRelative)) return refusedResult('refused-input')
  const prefix = rootRelative === '' ? '' : `${rootRelative.replace(/[\\*?[]/g, c => `\\${c}`)}/`
  const chunks: string[][] = []
  let bytes = Infinity
  for (const spec of specs.map(p => p.replace(')', () => `)${prefix}`))) { // a function: `$` in the root is never a pattern
    const n = Buffer.byteLength(spec) + 1
    if (bytes + n > PATHSPEC_ARGV_CHUNK_BYTES) { chunks.push([]); bytes = 0 }
    chunks.at(-1)!.push(spec)
    bytes += n
  }
  const deadline = Date.now() + lim.timeoutMs
  if (!drivers) {
    // Read once, under the whole cap: a later launch's small remaining budget must not cut the configuration read short.
    if (!(await gitSupportsPolicy())) return refusedResult('unsupported-git')
    const found = await enumerateHelperDrivers(top, lim, deadline)
    if (found.drivers === null) return { ...refusedResult(found.error), timedOut: found.timedOut, filterState: 'unresolved' }
    drivers = found.drivers
  }
  const out: Buffer[] = []
  let size = 0
  let last: GitResult | null = null
  for (const chunk of chunks) {
    const left = { timeoutMs: Math.max(1, deadline - Date.now()), maxOutputBytes: lim.maxOutputBytes - size }
    last = await execPolicyGit(top, [...args, '--', ...chunk], left, { literalPathspecs: false, drivers })
    out.push(last.stdout)
    size += last.stdout.length
    if (last.error !== null) break
  }
  return { ...last!, stdout: Buffer.concat(out, size) }
}

// ------------------------------------------------------------------------------------------------------ checkout resolution

const errnoCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined

function adapterFailure(r: GitResult): GitAdapterError {
  return new GitAdapterError(r.error === 'exit-nonzero' ? 'git-failed' : (r.error ?? 'git-failed'))
}

/** Single path printed by rev-parse: exactly one trailing newline removed, decoded losslessly or refused. */
function onePath(r: GitResult): string {
  if (r.error) throw adapterFailure(r)
  const out = r.stdout
  if (out.length < 2 || out[out.length - 1] !== 0x0a) throw new GitAdapterError('malformed-output')
  const path = decodeGitPath(out.subarray(0, out.length - 1))
  if (path === null) throw new GitAdapterError('lossy-path')
  if (!isAbsolute(path)) throw new GitAdapterError('malformed-output')
  return path
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    throw new GitAdapterError('path-unresolvable')
  }
}

const REMOTE_CONFIG_RE = '^(remote\\..+\\.(url|promisor)|extensions\\.partialclone)$'

async function readRemotes(path: string): Promise<{ remotes: GitRemote[]; partialClone: boolean }> {
  const r = await execPolicyGit(path, ['config', '--null', '--get-regexp', REMOTE_CONFIG_RE], DEFAULT_GIT_LIMITS)
  if (r.exitCode === 1 && r.stdout.length === 0 && !r.timedOut) return { remotes: [], partialClone: false }
  if (r.error) throw adapterFailure(r)
  const parsed = parseConfigNullZ(r.stdout)
  if (parsed.malformed) throw new GitAdapterError('malformed-output')
  const remotes = new Map<string, GitRemote>()
  let partialClone = false
  for (const { key, value } of parsed.entries) {
    if (key === 'extensions.partialclone') { if (value) partialClone = true; continue }
    if (key.endsWith('.promisor')) { if (value === null || /^(true|yes|on|1)$/i.test(value)) partialClone = true; continue }
    if (key.startsWith('remote.') && key.endsWith('.url')) {
      const name = key.slice('remote.'.length, -'.url'.length)
      if (name && !remotes.has(name)) remotes.set(name, { name, url: value === null ? null : sanitizeRemoteUrl(value) })
    }
  }
  return { remotes: [...remotes.values()], partialClone }
}

/**
 * Resolves the checkout containing `path` (absolute): `.git` files (linked worktrees, separate git dirs, relative gitdir
 * pointers) and the common directory are resolved by Git and canonicalized. Returns null when `path` is not inside a work tree
 * (no repository, a bare repository, inside a .git directory, or a missing directory). Rejects with GitAdapterError when Git
 * cannot answer within the default limits, the path is not lossless UTF-8, or the repository is unusable.
 */
export async function resolveGitCheckout(path: string): Promise<GitCheckout | null> {
  if (!validRepoPath(path)) throw new GitAdapterError('invalid-path')
  try {
    if (!(await stat(path)).isDirectory()) return null
  } catch (e) {
    const code = errnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new GitAdapterError('inaccessible')
  }
  const probe = await execPolicyGit(path, ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--is-shallow-repository', '--show-object-format'], DEFAULT_GIT_LIMITS)
  if (probe.error) {
    if (probe.error === 'exit-nonzero' && /not a git repository|cannot use bare repository|safe\.bareRepository/i.test(probe.stderr)) return null
    if (probe.error === 'exit-nonzero' && /dubious ownership/i.test(probe.stderr)) throw new GitAdapterError('unsafe-repository')
    throw adapterFailure(probe)
  }
  const lines = probe.stdout.toString('latin1').split('\n')
  if (lines.length !== 5 || lines[4] !== '') throw new GitAdapterError('malformed-output')
  if (lines[0] !== 'false' || lines[1] !== 'true') return null
  const shallow = lines[2] === 'true'
  const objectFormat = lines[3]
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new GitAdapterError('unsupported-object-format')

  const [top, gitDirOut, commonOut, symbolic, verify, remotes] = await Promise.all([
    execPolicyGit(path, ['rev-parse', '--path-format=absolute', '--show-toplevel'], DEFAULT_GIT_LIMITS),
    execPolicyGit(path, ['rev-parse', '--path-format=absolute', '--git-dir'], DEFAULT_GIT_LIMITS),
    execPolicyGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], DEFAULT_GIT_LIMITS),
    execPolicyGit(path, ['symbolic-ref', '-q', 'HEAD'], DEFAULT_GIT_LIMITS),
    execPolicyGit(path, ['rev-parse', '-q', '--verify', 'HEAD'], DEFAULT_GIT_LIMITS),
    readRemotes(path),
  ])
  const worktreePath = await canonical(onePath(top))
  const gitDir = await canonical(onePath(gitDirOut))
  const commonDir = await canonical(onePath(commonOut))

  let ref: string | null = null
  if (symbolic.exitCode === 0 && !symbolic.error) {
    ref = decodeGitPath(symbolic.stdout.subarray(0, Math.max(0, symbolic.stdout.length - 1)))
    if (ref === null) throw new GitAdapterError('malformed-output')
  } else if (!(symbolic.exitCode === 1 && !symbolic.timedOut)) {
    throw adapterFailure(symbolic)
  }
  let oid: string | null = null
  if (verify.exitCode === 0 && !verify.error) {
    oid = verify.stdout.toString('latin1').trim()
    if (!isGitOid(oid, objectFormat)) throw new GitAdapterError('malformed-output')
  } else if (!(verify.exitCode === 1 && !verify.timedOut)) {
    throw adapterFailure(verify)
  }
  const isMain = gitDir === commonDir
  const locked = !isMain && (await stat(join(gitDir, 'locked')).then(() => true, () => false))
  return {
    worktreePath, gitDir, commonDir, isMain, objectFormat, shallow, partialClone: remotes.partialClone,
    head: { oid, ref, detached: ref === null, unborn: ref !== null && oid === null },
    locked, prunable: false, remotes: remotes.remotes,
  }
}

/** Maps each linked worktree path (as Git reports it) to its canonical per-worktree Git directory, from `<common>/worktrees`. */
async function linkedGitDirs(commonDir: string): Promise<Map<string, string>> {
  const dir = join(commonDir, 'worktrees')
  const out = new Map<string, string>()
  let ids: string[]
  try {
    ids = await readdir(dir)
  } catch {
    return out
  }
  for (const id of ids) {
    const raw = await readFile(join(dir, id, 'gitdir')).catch(() => null)
    if (!raw) continue
    let end = raw.length
    while (end > 0 && /\s/.test(String.fromCharCode(raw[end - 1]!))) end--
    let text = decodeGitPath(raw.subarray(0, end))
    if (text === null) continue
    if (text.endsWith('/.git')) text = text.slice(0, -'/.git'.length)
    if (!isAbsolute(text)) text = resolvePath(join(dir, id), text)
    const gitDir = await realpath(join(dir, id)).catch(() => null)
    if (gitDir) out.set(text, gitDir)
  }
  return out
}

/**
 * Every checkout of the repository containing `repoPath`: the main work tree first, then linked worktrees, including locked
 * and prunable ones (a bare main repository is not a checkout and is omitted). Returns [] when `repoPath` is not in a checkout.
 * Rejects with GitAdapterError when Git output cannot be read completely or a worktree path is not lossless UTF-8.
 */
export async function listGitWorktrees(repoPath: string): Promise<GitCheckout[]> {
  const base = await resolveGitCheckout(repoPath)
  if (!base) return []
  const r = await execPolicyGit(base.worktreePath, ['worktree', 'list', '--porcelain', '-z'], DEFAULT_GIT_LIMITS)
  if (r.error) throw adapterFailure(r)
  const { records, malformed } = parseWorktreeListZ(r.stdout, base.objectFormat)
  if (malformed) throw new GitAdapterError('malformed-output')
  const linked = await linkedGitDirs(base.commonDir)
  const out: GitCheckout[] = []
  for (const [index, rec] of records.entries()) {
    if (rec.bare) continue
    if (rec.path === null) throw new GitAdapterError('lossy-path')
    const isMain = index === 0
    let gitDir: string | null = isMain ? base.commonDir : linked.get(rec.path) ?? null
    const exists = await stat(rec.path).then(s => s.isDirectory(), () => false)
    const worktreePath = exists ? await canonical(rec.path) : rec.path
    if (!gitDir && exists) {
      const pointer = await resolveGitCheckout(worktreePath).catch(() => null)
      gitDir = pointer?.gitDir ?? null
    }
    if (!gitDir) throw new GitAdapterError('unresolved-worktree')
    out.push({
      worktreePath, gitDir, commonDir: base.commonDir, isMain, objectFormat: base.objectFormat, shallow: base.shallow,
      partialClone: base.partialClone,
      head: { oid: rec.head, ref: rec.branch, detached: rec.detached, unborn: rec.unborn },
      locked: rec.locked, prunable: rec.prunable || !exists, remotes: base.remotes,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------- object metadata

export type GitBlobMetadata =
  | { state: 'present'; size: number; lfsPointer: boolean | null }
  | { state: 'missing' }
  | { state: 'not-blob'; type: string }
  | { state: 'unknown' }

export type GitBlobMetadataResult = {
  blobs: Map<string, GitBlobMetadata>
  /** Every requested blob is present with size and LFS status known. */
  complete: boolean
  /**
   * null when both batch processes finished cleanly. Otherwise the first failure: an entry Git never answered for stays
   * `unknown` (in a partial clone, `cat-file` stops at the first promisor object it may not fetch: exit-nonzero).
   */
  error: string | null
  timedOut: boolean
  truncated: boolean
}

/**
 * Size, type and LFS-pointer status of many blobs with one `cat-file --batch-check` process fed by stdin, plus one `--batch`
 * read limited to blobs small enough to be LFS pointers (both with filter and diff drivers blanked, from one shared, non-executing
 * config read). OIDs must be full hex of `objectFormat`. Missing objects are reported, never fetched.
 */
export async function readBlobMetadata(repoPath: string, objectFormat: GitObjectFormat, oids: string[], limits: GitLimits): Promise<GitBlobMetadataResult> {
  const fail = (error: string, timedOut = false): GitBlobMetadataResult => ({ blobs: new Map(), complete: false, error, timedOut, truncated: false })
  const lim = normalizeLimits(limits)
  if (!lim) return fail('refused-limits')
  if (!validRepoPath(repoPath)) return fail('refused-repo-path')
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return fail('refused-object-id')
  if (!Array.isArray(oids) || !oids.every(o => isGitOid(o, objectFormat))) return fail('refused-object-id')
  if (oids.length === 0) return { blobs: new Map(), complete: true, error: null, timedOut: false, truncated: false }
  if (!(await gitSupportsPolicy())) return fail('unsupported-git')
  const found = await enumerateHelperDrivers(repoPath, lim, Date.now() + lim.timeoutMs)
  if (found.drivers === null) return fail(found.error, found.timedOut)
  return blobMetadata(repoPath, objectFormat, oids, lim, found.drivers)
}

async function blobMetadata(repoPath: string, objectFormat: GitObjectFormat, oids: string[], lim: GitLimits, drivers: HelperDrivers): Promise<GitBlobMetadataResult> {
  const blobs = new Map<string, GitBlobMetadata>()
  const unique = [...new Set(oids)]
  if (unique.length === 0) return { blobs, complete: true, error: null, timedOut: false, truncated: false }
  const input = Buffer.from(unique.map(o => o + '\n').join(''))
  if (input.length > MAX_GIT_INPUT_BYTES) return { blobs, complete: false, error: 'refused-input', timedOut: false, truncated: false }

  const check = await execPolicyGit(repoPath, ['cat-file', '--batch-check'], lim, { input, drivers })
  const parsed = parseBatchCheck(check.stdout, objectFormat)
  let complete = check.error === null && !parsed.malformed
  unique.forEach((oid, i) => {
    const rec = parsed.records[i]
    if (!rec || rec.name !== oid) { blobs.set(oid, { state: 'unknown' }); complete = false; return }
    if (rec.state !== 'present') { blobs.set(oid, { state: 'missing' }); complete = false; return }
    if (rec.type !== 'blob') { blobs.set(oid, { state: 'not-blob', type: rec.type }); return }
    blobs.set(oid, { state: 'present', size: rec.size, lfsPointer: rec.size > GIT_LFS_POINTER_MAX_BYTES ? false : null })
  })
  let timedOut = check.timedOut
  let truncated = check.truncated
  let error = check.error ?? (parsed.malformed ? 'malformed-output' : null)

  const small = unique.filter(o => { const b = blobs.get(o); return b?.state === 'present' && b.lfsPointer === null })
  if (small.length > 0) {
    const read = await execPolicyGit(repoPath, ['cat-file', '--batch'], lim, { input: Buffer.from(small.map(o => o + '\n').join('')), drivers })
    const contents = parseBatchContents(read.stdout, objectFormat)
    for (const obj of contents.objects) {
      const b = blobs.get(obj.name)
      if (b?.state === 'present' && obj.type === 'blob' && obj.content) b.lfsPointer = isGitLfsPointer(obj.content)
    }
    timedOut ||= read.timedOut
    truncated ||= read.truncated
    error ??= read.error ?? (contents.complete ? null : 'malformed-output')
    if (small.some(o => { const b = blobs.get(o); return b?.state === 'present' && b.lfsPointer === null })) complete = false
  }
  return { blobs, complete, error, timedOut, truncated }
}

// -------------------------------------------------------------------------------------------------------------------- history

export type GitHistoryOptions = {
  /** Commits per page (1..1000, default 100). The adapter halves it after a capped page and grows it back after clean pages. */
  maxCommits?: number
  /** Epoch seconds: on an initial pass (no history processed yet) skip commits committed before this. Reported as lookbackLimited. */
  notBefore?: number | null
  /** Only changes to paths with these extensions (case-insensitive, no dot, [a-z0-9]). Omitted: every path. */
  documentExtensions?: string[]
}

/**
 * One page of history. Callers must tell the two outcomes apart:
 *  - `error !== null`: nothing was consumed. `cursor` is exactly the input cursor and `changes` is empty: retry later with
 *    backoff. This covers a single-commit page that times out, spawn or signal failures, Git errors that do not report missing
 *    objects, malformed output and invalid input (an unreadable cursor needs a null-cursor restart). A transient failure never
 *    skips a commit. A multi-commit page that times out is not an error: it keeps the whole commits read before the timeout,
 *    or, with none, narrows the page (a smaller page size in the returned cursor, no changes, `timedOut: true`).
 *  - `error === null`: commit `changes`, then persist `cursor`, which may have advanced. `hasMore`: call again now (also after
 *    a page that only narrowed its size, with no changes). `complete` is true only on the last page of a pass with no recorded
 *    gap; otherwise `gaps` names why. A gap means progress was made past something that could not be imported (a commit larger
 *    than the output cap, missing objects, a shallow boundary): it is recorded, visible, and sticky in the cursor until a
 *    null-cursor restart, and an oversized commit is retried once a larger output cap is used.
 */
export type GitHistoryPage = {
  /** Changes of the commits in this page, each carrying its commit (OID with object format, parents, times, Atlas-Session IDs). */
  changes: GitChange[]
  /** Opaque (≤ 64 KiB) cursor: the input cursor when `error` is set, else the cursor to persist once `changes` are committed. */
  cursor: string | null
  /** True only on the final page of a pass with no gap: no shallow boundary, missing object, skipped commit, lossy path, unborn HEAD or error. */
  complete: boolean
  /** Another page remains: call again with `cursor`. */
  hasMore: boolean
  objectFormat: GitObjectFormat
  shallow: boolean
  partialClone: boolean
  /** Some checkout's HEAD names an unborn branch. */
  unborn: boolean
  /** Detached worktree HEAD commits included as history tips. */
  detached: string[]
  /** Branches whose previously processed tip is no longer an ancestor of their current tip (force-push, reset, rewrite). */
  rewrittenRefs: string[]
  /** Changed branches whose rewrite status was not checked (check budget exhausted or Git failed). */
  rewriteUnchecked: number
  missingObjects: string[]
  /** Commits this page skipped (or failed to retry) because one commit alone exceeded the output cap. */
  oversizedCommits: string[]
  /**
   * Why history is incomplete (sticky until a null-cursor restart): shallow, missing-objects, walk-failed, oversized-commit,
   * lossy-path, object-metadata-unavailable, unresolved-tag.
   */
  gaps: string[]
  /** Some pass since the last fresh start used `notBefore`: older history was deliberately not imported. */
  lookbackLimited: boolean
  filterState: GitFilterState
  timedOut: boolean
  truncated: boolean
  error: string | null
}

type PassState = {
  target: string[]
  refs: Record<string, string> | null
  /** Commits of this pass (in rev-list order) fully processed. */
  skip: number
  n: number
  maxAge: number | null
  detached: string[]
  unborn: boolean
  rewritten: string[]
  rewriteUnchecked: number
}

/** A commit skipped because its output exceeded `cap` bytes; retried when a call runs with a larger cap. */
type OversizedCommit = { oid: string; cap: number }

type HistoryCursor = {
  v: 2
  of: GitObjectFormat
  done: string[]
  refs: Record<string, string> | null
  gaps: string[]
  lookback: boolean
  oversized: OversizedCommit[]
  pass: PassState | null
}

const CURSOR_PREFIX = 'atlas-git-history:'
const MAX_CURSOR_CHARS = 60 * 1024
const MAX_TIPS = 256
const REDUCE_THRESHOLD = 128
const MAX_TRACKED_REFS = 64
const MAX_REWRITE_CHECKS = 16
const MAX_OVERSIZED = 32
const DEFAULT_PAGE_COMMITS = 100
const EXTENSION_RE = /^[a-z0-9]{1,16}$/

function encodeCursor(state: HistoryCursor): string | null {
  const text = CURSOR_PREFIX + JSON.stringify(state)
  return text.length <= MAX_CURSOR_CHARS ? text : null
}

function decodeCursor(cursor: string, format: GitObjectFormat): HistoryCursor | null {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX) || cursor.length > MAX_CURSOR_CHARS) return null
  let v: unknown
  try {
    v = JSON.parse(cursor.slice(CURSOR_PREFIX.length))
  } catch {
    return null
  }
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
  const oidList = (x: unknown): x is string[] => Array.isArray(x) && x.length <= MAX_TIPS && x.every(o => isGitOid(o, format))
  const refMap = (x: unknown): x is Record<string, string> | null =>
    x === null || (isObj(x) && Object.keys(x).length <= MAX_TRACKED_REFS && Object.values(x).every(o => isGitOid(o, format)))
  const nat = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0
  if (!isObj(v) || v.v !== 2 || v.of !== format || !oidList(v.done) || !refMap(v.refs) || typeof v.lookback !== 'boolean') return null
  if (!Array.isArray(v.gaps) || !v.gaps.every(g => typeof g === 'string' && /^[a-z-]{1,40}$/.test(g))) return null
  if (!Array.isArray(v.oversized) || v.oversized.length > MAX_OVERSIZED) return null
  if (!v.oversized.every(o => isObj(o) && isGitOid(o.oid, format) && nat(o.cap) && (o.cap as number) >= 1)) return null
  if (v.pass !== null) {
    const p = v.pass
    if (!isObj(p) || !oidList(p.target) || !refMap(p.refs) || !nat(p.skip) || !nat(p.n) || (p.n as number) < 1 || (p.n as number) > 1000) return null
    if (!(p.maxAge === null || nat(p.maxAge)) || !oidList(p.detached) || typeof p.unborn !== 'boolean' || !nat(p.rewriteUnchecked)) return null
    if (!Array.isArray(p.rewritten) || p.rewritten.length > MAX_TRACKED_REFS || !p.rewritten.every(r => typeof r === 'string')) return null
  }
  return v as unknown as HistoryCursor
}

function extensionPathspecs(exts: unknown): string[] | null | 'invalid' {
  if (exts === undefined || exts === null) return null
  if (!Array.isArray(exts) || exts.length === 0 || exts.length > 64) return 'invalid'
  const clean = [...new Set(exts.map(e => (typeof e === 'string' ? e.toLowerCase() : '')))]
  if (!clean.every(e => EXTENSION_RE.test(e))) return 'invalid'
  return clean.sort().map(e => `:(glob,icase)**/*.${e}`)
}

type Tips = { oids: string[]; branchRefs: Record<string, string>; detached: string[]; unborn: boolean; unresolvedTags: number }
type Failure = { failed: GitResult }

/** Current history tips: local branches, tags peeled to commits, and detached HEADs of every worktree. */
async function collectTips(cwd: string, format: GitObjectFormat, lim: GitLimits): Promise<Tips | Failure> {
  const [refs, worktrees] = await Promise.all([
    execPolicyGit(cwd, ['for-each-ref', '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)', 'refs/heads/', 'refs/tags/'], lim),
    execPolicyGit(cwd, ['worktree', 'list', '--porcelain', '-z'], lim),
  ])
  if (refs.error) return { failed: refs }
  if (worktrees.error) return { failed: worktrees }
  const tips = new Set<string>()
  const branchRefs: Record<string, string> = {}
  const nested: string[] = []
  const lines = refs.stdout.toString('latin1').split('\n')
  if (lines.pop() !== '') return { failed: { ...refs, error: 'malformed-output', incomplete: true } }
  for (const line of lines) {
    const [oid, type, peeled, peeledType, nameLatin1] = line.split('\0')
    if (!isGitOid(oid, format) || nameLatin1 === undefined) return { failed: { ...refs, error: 'malformed-output', incomplete: true } }
    let commit: string | null = null
    if (type === 'commit') commit = oid
    else if (type === 'tag' && peeledType === 'commit' && isGitOid(peeled, format)) commit = peeled
    else if (type === 'tag' && peeledType === 'tag') nested.push(oid)
    if (commit) tips.add(commit)
    const name = decodeGitPath(Buffer.from(nameLatin1, 'latin1'))
    if (commit && name && name.startsWith('refs/heads/')) branchRefs[name] = commit
  }
  let unresolvedTags = 0
  if (nested.length > 0) {
    const peel = await execPolicyGit(cwd, ['cat-file', '--batch-check'], lim, { input: Buffer.from(nested.map(o => `${o}^{commit}\n`).join('')) })
    const parsed = parseBatchCheck(peel.stdout, format)
    nested.forEach((_, i) => {
      const rec = parsed.records[i]
      if (rec?.state === 'present' && rec.type === 'commit') tips.add(rec.oid)
      else unresolvedTags++
    })
  }
  const wt = parseWorktreeListZ(worktrees.stdout, format)
  if (wt.malformed) return { failed: { ...worktrees, error: 'malformed-output', incomplete: true } }
  const detached = new Set<string>()
  let unborn = false
  for (const rec of wt.records) {
    if (rec.bare) continue
    if (rec.unborn) unborn = true
    if (rec.detached && rec.head) { detached.add(rec.head); tips.add(rec.head) }
  }
  const tracked = Object.keys(branchRefs).sort().slice(0, MAX_TRACKED_REFS)
  return {
    oids: [...tips].sort(), branchRefs: Object.fromEntries(tracked.map(k => [k, branchRefs[k]!])), detached: [...detached].sort(), unborn, unresolvedTags,
  }
}

/** The subset of `oids` (commits) present locally, without fetching: rev-list skips missing objects instead of failing. */
async function presentCommits(cwd: string, oids: string[], lim: GitLimits): Promise<Set<string> | Failure> {
  if (oids.length === 0) return new Set()
  const r = await execPolicyGit(cwd, ['rev-list', '--no-walk=unsorted', '--missing=allow-any', '--ignore-missing', '--stdin'], lim, {
    input: Buffer.from(oids.map(o => o + '\n').join('')),
  })
  if (r.error) return { failed: r }
  return new Set(r.stdout.toString('latin1').split('\n').filter(Boolean))
}

/** Reduces tips to those not reachable from another tip (`merge-base --independent`, in argv chunks). */
async function reduceTips(cwd: string, oids: string[], lim: GitLimits): Promise<string[] | Failure> {
  let current = [...oids].sort()
  while (current.length > REDUCE_THRESHOLD) {
    const next = new Set<string>()
    for (let i = 0; i < current.length; i += REDUCE_THRESHOLD) {
      const r = await execPolicyGit(cwd, ['merge-base', '--independent', ...current.slice(i, i + REDUCE_THRESHOLD)], lim)
      if (r.error) return { failed: r }
      for (const o of r.stdout.toString('latin1').split('\n')) if (o) next.add(o)
    }
    const reduced = [...next].sort()
    if (reduced.length >= current.length) break
    current = reduced
  }
  return current
}

async function detectRewrites(cwd: string, previous: Record<string, string> | null, current: Record<string, string>, present: Set<string>, lim: GitLimits): Promise<{ rewritten: string[]; unchecked: number }> {
  const rewritten: string[] = []
  let unchecked = 0
  if (!previous) return { rewritten, unchecked }
  let checks = 0
  for (const name of Object.keys(previous).sort()) {
    const oldOid = previous[name]!
    const newOid = current[name]
    if (newOid === undefined || newOid === oldOid) continue
    if (!present.has(oldOid)) { rewritten.push(name); continue }
    if (checks >= MAX_REWRITE_CHECKS) { unchecked++; continue }
    checks++
    const r = await execPolicyGit(cwd, ['merge-base', '--is-ancestor', oldOid, newOid], lim)
    if (r.exitCode === 1 && !r.timedOut && !r.truncated) rewritten.push(name)
    else if (r.exitCode !== 0) unchecked++
  }
  return { rewritten, unchecked }
}

async function readShallowBoundary(commonDir: string, format: GitObjectFormat): Promise<Set<string> | null> {
  try {
    const text = await readFile(join(commonDir, 'shallow'), 'latin1')
    return new Set(text.split('\n').filter(o => isGitOid(o, format)))
  } catch (e) {
    return errnoCode(e) === 'ENOENT' ? new Set() : null
  }
}

function blankPage(repo: GitCheckout, cursor: string | null): GitHistoryPage {
  return {
    changes: [], cursor, complete: false, hasMore: false, objectFormat: repo.objectFormat, shallow: repo.shallow, partialClone: repo.partialClone,
    unborn: false, detached: [], rewrittenRefs: [], rewriteUnchecked: 0, missingObjects: [], oversizedCommits: [], gaps: [],
    lookbackLimited: false, filterState: 'not-checked', timedOut: false, truncated: false, error: null,
  }
}

const MISSING_OBJECT_RE = /missing|unable to read|could not read|bad object|unable to parse|not a valid object|failed to traverse/i
const OID_IN_TEXT = (format: GitObjectFormat): RegExp => new RegExp(`\\b[0-9a-f]{${format === 'sha1' ? 40 : 64}}\\b`, 'g')
const oidsIn = (text: string, format: GitObjectFormat): string[] => [...new Set(text.match(OID_IN_TEXT(format)) ?? [])]
const hasBlob = (ch: GitChange): boolean => ch.blobOid !== null && ch.mode !== null && (ch.mode & 0o170000) !== 0o160000
const oidLines = (oids: string[], prefix = ''): string => oids.map(o => `${prefix}${o}\n`).join('')

type PageContext = {
  cwd: string
  repo: GitCheckout
  format: GitObjectFormat
  pathspecs: string[] | null
  lim: GitLimits
  drivers: HelperDrivers
  shallowSet: Set<string> | null
}

type PageOutcome =
  /** `processed` leading commits of the page are fully read (changes, sizes, LFS status); the rest stay for the next page. */
  | { kind: 'done'; changes: GitChange[]; processed: number; gaps: string[]; missing: string[]; truncated: boolean; timedOut: boolean }
  /**
   * Nothing was read (output cap, missing objects, or a timeout before any whole commit) and the page has more than one
   * commit: nothing is consumed and no error is reported; the next call reads a narrower page.
   */
  | { kind: 'shrink'; truncated: boolean; timedOut: boolean }
  /** A single commit cannot be read within the limits or with the objects present: skip it as a recorded gap. */
  | { kind: 'skip'; oid: string; reason: 'oversized-commit' | 'missing-objects'; missing: string[] }
  /** Failure with nothing to narrow (one commit) or unexplained: nothing is consumed; the caller returns its input cursor with this error. */
  | { kind: 'retry'; error: string; timedOut: boolean; truncated: boolean }

/**
 * Reads the changes of `pageOids` (in rev-list order) with one `log --no-walk` and batched blob metadata. Only whole commits
 * count: when output is cut (cap or timeout) or Git reports missing objects, the commits before the last header seen are kept
 * and everything from that header on stays unread. Any other failure consumes nothing.
 */
async function readCommitPage(ctx: PageContext, pageOids: string[]): Promise<PageOutcome> {
  const { cwd, repo, format, pathspecs, lim } = ctx
  const retry = (error: string, r: { timedOut: boolean; truncated: boolean }): PageOutcome => ({ kind: 'retry', error, timedOut: r.timedOut, truncated: r.truncated })
  const args = [
    'log', '--no-walk=unsorted', '--stdin', '--raw', '-z', '--no-abbrev', repo.partialClone ? '-M100%' : '-M', '--diff-merges=dense-combined',
    '--no-color', '--no-relative', `--format=${GIT_LOG_RECORD_FORMAT}`,
  ]
  if (pathspecs) args.push('--', ...pathspecs)
  const walk = await execPolicyGit(cwd, args, lim, { input: Buffer.from(oidLines(pageOids)), literalPathspecs: pathspecs === null })
  const parsed = parseGitLogZ(walk.stdout, format)
  const position = new Map(pageOids.map((o, i) => [o, i]))
  let previous = -1
  for (const c of parsed.commits) {
    const at = position.get(c.oid)
    if (at === undefined || at <= previous) return retry('malformed-output', { timedOut: false, truncated: false })
    previous = at
  }
  const reportsMissing = walk.error === 'exit-nonzero' && MISSING_OBJECT_RE.test(walk.stderr)
  let commits: ParsedGitCommit[]
  let processed: number
  if (walk.error === null && !parsed.malformed && !parsed.partial) {
    commits = parsed.commits
    processed = pageOids.length
  } else {
    if (!walk.truncated && !walk.timedOut && !reportsMissing) return retry(walk.error ?? 'malformed-output', walk)
    const lastSeen = parsed.lastHeaderOid === null ? undefined : position.get(parsed.lastHeaderOid)
    processed = lastSeen ?? 0
    commits = parsed.commits.filter(c => position.get(c.oid)! < processed)
    if (processed === 0) {
      // A timeout before any whole commit narrows the page (spec: retry with narrower history chunks); a single commit that
      // times out is a retryable error, never a skip.
      if (!walk.truncated && !reportsMissing) {
        if (pageOids.length > 1) return { kind: 'shrink', truncated: false, timedOut: true }
        return retry(walk.error ?? 'timeout', walk)
      }
      if (pageOids.length > 1) return { kind: 'shrink', truncated: walk.truncated, timedOut: false }
      return { kind: 'skip', oid: pageOids[0]!, reason: walk.truncated ? 'oversized-commit' : 'missing-objects', missing: oidsIn(walk.stderr, format) }
    }
  }

  const changes = commits.flatMap(c => c.changes)
  const meta = await blobMetadata(cwd, format, changes.filter(hasBlob).map(ch => ch.blobOid!), lim, ctx.drivers)
  if (meta.truncated || meta.error === 'refused-input') {
    if (pageOids.length > 1) return { kind: 'shrink', truncated: true, timedOut: false }
    return { kind: 'skip', oid: pageOids[0]!, reason: 'oversized-commit', missing: [] }
  }
  // A metadata timeout narrows a multi-commit page too; for a single commit it falls through to the retryable error below.
  if (meta.timedOut && pageOids.length > 1) return { kind: 'shrink', truncated: false, timedOut: true }
  // In a partial clone cat-file stops at the first promisor object it may not fetch: the unanswered rest is unavailable, a
  // deterministic state recorded per change. Any other metadata failure (a timeout included) consumes nothing.
  // Git versions differ here: some abort the check (exit 128), others print `<oid> missing` for that object and go on. In a
  // partial clone an object absent locally is a promisor object (not provably lost), so both answers give the same state,
  // 'unavailable', below; only a complete clone reports 'missing' (and its gap).
  const unavailableIsExpected = meta.error === 'exit-nonzero' && repo.partialClone
  if (meta.error !== null && !unavailableIsExpected) return retry(meta.error, meta)
  const gaps = new Set<string>()
  const missing: string[] = []
  for (const ch of changes) {
    if (ch.lossy) gaps.add('lossy-path')
    if (!hasBlob(ch)) continue
    const b = meta.blobs.get(ch.blobOid!)
    if (b?.state === 'present') {
      ch.blobState = 'present'
      ch.size = b.size
      ch.lfsPointer = b.lfsPointer
      if (b.lfsPointer === null) gaps.add('object-metadata-unavailable')
    } else if (b?.state === 'missing' && !repo.partialClone) {
      ch.blobState = 'missing'
      gaps.add('missing-objects')
      if (!missing.includes(ch.blobOid!)) missing.push(ch.blobOid!)
    } else {
      ch.blobState = 'unavailable'
      gaps.add('object-metadata-unavailable')
    }
  }
  for (const c of commits) {
    const boundary = ctx.shallowSet?.has(c.oid) ?? false
    c.shallowBoundary = boundary
    for (const ch of c.changes) if (ch.commit) ch.commit.shallowBoundary = boundary
  }
  return { kind: 'done', changes, processed, gaps: [...gaps], missing, truncated: walk.truncated, timedOut: walk.timedOut }
}

/**
 * Reads one bounded page of committed document history for the repository of `repo` (history is shared by its linked
 * worktrees: call once per repository). A pass covers every commit reachable from the current local branches, tags and
 * detached worktree HEADs that was not reachable from the tips the previous pass completed (so an outage never leaves a
 * permanent gap), newest first. Each page lists up to `maxCommits` commits with `rev-list` (no diffs) and reads exactly those
 * with one `log --no-walk` plus batched blob metadata, so the cursor only ever advances past whole, fully processed commits.
 * See GitHistoryPage for the error/progress contract.
 */
export async function readDocumentHistory(repo: GitCheckout, cursor: string | null, limits: GitLimits, options: GitHistoryOptions = {}): Promise<GitHistoryPage> {
  if (!repo || typeof repo !== 'object' || !validRepoPath(repo.worktreePath) || !validRepoPath(repo.commonDir) || (repo.objectFormat !== 'sha1' && repo.objectFormat !== 'sha256')) {
    return { ...blankPage({ objectFormat: 'sha1', shallow: false, partialClone: false } as GitCheckout, cursor), error: 'invalid-checkout' }
  }
  const retryLater = (error: string, r: { timedOut?: boolean; truncated?: boolean } = {}): GitHistoryPage =>
    ({ ...blankPage(repo, cursor), error, timedOut: r.timedOut ?? false, truncated: r.truncated ?? false })
  const lim = normalizeLimits(limits)
  if (!lim) return retryLater('refused-limits')
  const format = repo.objectFormat
  let state: HistoryCursor
  if (cursor === null) state = { v: 2, of: format, done: [], refs: null, gaps: [], lookback: false, oversized: [], pass: null }
  else {
    const decoded = decodeCursor(cursor, format)
    if (!decoded) return retryLater('invalid-cursor')
    state = decoded
  }
  const pathspecs = extensionPathspecs(options.documentExtensions)
  if (pathspecs === 'invalid') return retryLater('refused-extension')
  const maxCommits = Number.isInteger(options.maxCommits) && options.maxCommits! >= 1 ? Math.min(options.maxCommits!, 1000) : DEFAULT_PAGE_COMMITS
  const cwd = repo.worktreePath
  const gaps = new Set(state.gaps)
  const page = blankPage(repo, cursor)

  const found = await enumerateHelperDrivers(cwd, lim, Date.now() + lim.timeoutMs)
  if (found.drivers === null) return retryLater(found.error, found)
  page.filterState = found.drivers.filters.length > 0 ? 'unresolved' : 'none'
  const shallowSet = await readShallowBoundary(repo.commonDir, format)
  page.shallow = shallowSet === null || shallowSet.size > 0
  if (page.shallow) gaps.add('shallow')
  const ctx: PageContext = { cwd, repo, format, pathspecs, lim, drivers: found.drivers, shallowSet }

  const finish = (hasMore: boolean): GitHistoryPage => {
    state.gaps = [...gaps].sort()
    const encoded = encodeCursor(state)
    if (encoded === null) return retryLater('cursor-too-large')
    page.cursor = encoded
    page.gaps = [...new Set([...state.gaps, ...(state.oversized.length > 0 ? ['oversized-commit'] : [])])].sort()
    page.lookbackLimited = state.lookback
    page.hasMore = hasMore
    page.complete = !hasMore && page.gaps.length === 0 && !page.unborn && !page.shallow
    return page
  }
  const recordSkip = (outcome: Extract<PageOutcome, { kind: 'skip' }>): void => {
    if (outcome.reason === 'oversized-commit') {
      page.oversizedCommits.push(outcome.oid)
      page.truncated = true
      const known = state.oversized.find(o => o.oid === outcome.oid)
      if (known) known.cap = lim.maxOutputBytes
      else if (state.oversized.length < MAX_OVERSIZED) state.oversized.push({ oid: outcome.oid, cap: lim.maxOutputBytes })
      else gaps.add('oversized-commit') // not retryable: the list is full
    } else {
      gaps.add('missing-objects')
      for (const o of outcome.missing) if (!page.missingObjects.includes(o)) page.missingObjects.push(o)
    }
  }
  const recordDone = (outcome: Extract<PageOutcome, { kind: 'done' }>): void => {
    page.changes = outcome.changes
    page.truncated = outcome.truncated
    page.timedOut = outcome.timedOut
    for (const g of outcome.gaps) gaps.add(g)
    for (const o of outcome.missing) if (!page.missingObjects.includes(o)) page.missingObjects.push(o)
  }

  // Between passes, first retry one commit that was skipped under a smaller output cap than this call's.
  if (!state.pass) {
    const retryable = state.oversized.find(o => lim.maxOutputBytes > o.cap)
    if (retryable) {
      const outcome = await readCommitPage(ctx, [retryable.oid])
      if (outcome.kind === 'retry') return retryLater(outcome.error, outcome)
      if (outcome.kind === 'done') {
        state.oversized = state.oversized.filter(o => o.oid !== retryable.oid)
        recordDone(outcome)
      } else if (outcome.kind === 'skip') {
        if (outcome.reason === 'missing-objects') state.oversized = state.oversized.filter(o => o.oid !== retryable.oid)
        recordSkip(outcome)
      }
      return finish(true)
    }
  }

  if (!state.pass) {
    const tips = await collectTips(cwd, format, lim)
    if ('failed' in tips) return retryLater(tips.failed.error ?? 'git-failed', tips.failed)
    if (tips.unresolvedTags > 0) gaps.add('unresolved-tag')
    const probe = [...new Set([...tips.oids, ...state.done, ...Object.values(state.refs ?? {})])]
    const present = await presentCommits(cwd, probe, lim)
    if ('failed' in present) return retryLater(present.failed.error ?? 'git-failed', present.failed)
    const missingTips = tips.oids.filter(o => !present.has(o))
    if (missingTips.length > 0) { gaps.add('missing-objects'); page.missingObjects.push(...missingTips) }
    const rewrites = await detectRewrites(cwd, state.refs, tips.branchRefs, present, lim)
    const target = await reduceTips(cwd, tips.oids.filter(o => present.has(o)), lim)
    if ('failed' in target) return retryLater(target.failed.error ?? 'git-failed', target.failed)
    if (target.length > MAX_TIPS) return retryLater('too-many-tips')
    state.done = state.done.filter(o => present.has(o))
    const maxAge = state.done.length === 0 && typeof options.notBefore === 'number' && Number.isFinite(options.notBefore) ? Math.max(0, Math.floor(options.notBefore)) : null
    if (maxAge !== null) state.lookback = true
    state.pass = {
      target, refs: tips.branchRefs, skip: 0, n: maxCommits, maxAge, detached: tips.detached, unborn: tips.unborn,
      rewritten: rewrites.rewritten, rewriteUnchecked: rewrites.unchecked,
    }
  }
  const pass = state.pass
  Object.assign(page, { unborn: pass.unborn, detached: pass.detached, rewrittenRefs: pass.rewritten, rewriteUnchecked: pass.rewriteUnchecked })

  let passDone = false
  const doneSet = new Set(state.done)
  if (pass.target.length === 0 || pass.target.every(o => doneSet.has(o))) {
    passDone = true
  } else {
    const listArgs = ['rev-list', '--stdin', `--skip=${pass.skip}`, `--max-count=${pass.n}`]
    if (pass.maxAge !== null) listArgs.push(`--max-age=${pass.maxAge}`)
    const list = await execPolicyGit(cwd, listArgs, lim, { input: Buffer.from(oidLines(pass.target) + oidLines(state.done, '^')) })
    if (list.error) {
      if (list.error !== 'exit-nonzero' || !MISSING_OBJECT_RE.test(list.stderr)) return retryLater(list.error, list)
      if (pass.n > 1) {
        // Deterministic repository damage: narrow the page until the unreadable commit is isolated.
        pass.n = Math.ceil(pass.n / 2)
      } else {
        // The walk cannot get past missing objects: end the pass with an explicit, sticky gap.
        gaps.add('walk-failed')
        gaps.add('missing-objects')
        for (const o of oidsIn(list.stderr, format)) if (!page.missingObjects.includes(o)) page.missingObjects.push(o)
        passDone = true
      }
    } else {
      const lines = list.stdout.toString('latin1').split('\n')
      if (lines.pop() !== '' || !lines.every(o => isGitOid(o, format))) return retryLater('malformed-output')
      if (lines.length === 0) {
        passDone = true
      } else {
        const outcome = await readCommitPage(ctx, lines)
        if (outcome.kind === 'retry') return retryLater(outcome.error, outcome)
        if (outcome.kind === 'shrink') {
          pass.n = Math.ceil(pass.n / 2)
          page.truncated = outcome.truncated
          page.timedOut = outcome.timedOut
        } else if (outcome.kind === 'skip') {
          pass.skip += 1
          recordSkip(outcome)
        } else {
          recordDone(outcome)
          pass.skip += outcome.processed
          if (outcome.processed < lines.length) pass.n = Math.max(1, Math.ceil(pass.n / 2))
          else if (lines.length < pass.n) passDone = true
          else if (!outcome.truncated && !outcome.timedOut) pass.n = Math.min(maxCommits, pass.n * 2)
        }
      }
    }
  }

  if (passDone) {
    state.done = pass.target
    state.refs = pass.refs
    state.pass = null
  }
  return finish(state.pass !== null)
}
