import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { ArtifactsConfig } from '../config.ts'
import type { ArtifactDocumentIdentity, ArtifactWorkerRoot } from './contracts.ts'
import { isSensitiveFilename } from './filetype.ts'

// Path policy for the artifact manager (spec section 4 "Access and discovery are separate policies", section 7 "Identity").
//
// Three questions are answered here and kept apart on purpose:
//   - May Atlas act on, stat or record this exact path? (canonicalizeArtifactRoot, authorizeArtifactPath)
//   - Should a bulk traversal skip this path? (isPassiveDiscoveryExcluded) -- noise suppression only, never an access rule.
//   - Which logical document does this path belong to? (documentIdentityForPath, documentIdentityForGitPath)
//
// Nothing here trusts a path's spelling. Authorization rejects `..`, resolves every existing ancestor through realpath and
// re-checks the result against home, the secret/runtime exclusions and the registered canonical roots. Deny lists and the PHI
// rule compare folded segments (macOS volumes are usually case- and normalization-insensitive, so `~/.SSH` is `~/.ssh`);
// containment compares exactly and fails closed. Paths and identities are never split on newlines and never
// Unicode-normalized: a path is one opaque string.
//
// This module is a leaf (no database, no config loading) so the DB-free discovery worker can import it.

export const MAX_ARTIFACT_PATH_CHARS = 4096

/** Fixed passive-discovery exclusions: dependency, build, cache and tool-scratch directory names. Discovery only. */
export const FIXED_DISCOVERY_SEGMENTS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', '.cache', 'coverage', '.pytest_cache', '.mypy_cache', '.DS_Store', '.Trash',
  // Tool scratch output (H1): Playwright CLI snapshots/console logs, test reports, IDE state.
  '.playwright-cli', 'playwright-report', 'test-results', '.turbo', '.parcel-cache', '.idea', '.vscode', '.tox', '.nox',
]

/** Editor swap files, partial downloads, locks and other transient files. Discovery only. */
export const JUNK_SUFFIXES: readonly string[] = ['.tmp', '.swp', '.swx', '~', '.lock', '.pyc', '.part', '.crdownload']

/** Claude Code's own runtime subtrees under a `.claude` directory: transcripts, job state, focus files, todos, caches. */
export const CLAUDE_RUNTIME_SEGMENTS: readonly string[] = ['projects', 'jobs', 'session-focus', 'todos', 'shell-snapshots', 'statsig', 'cache']

// Secrets and runtime data, matched by folded segment anywhere in a path: a single directory name, or a (parent, child)
// pair. Anywhere-matching covers the home-anchored directories (~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud,
// ~/Library/Keychains, ~/.claude/atlas, ~/.josh-360/{atlas,state,backups,logs} and the Claude runtime subtrees) without needing `home`, and also covers the same
// names reached through any other spelling. `.claude/.credentials.json` is Claude Code's OAuth token store on Linux: a
// `.json` document by extension, under a supported session cwd, and not caught by the secret-filename patterns. The same
// holds for `.claude/settings.json` and `settings.local.json` (their `env` block can hold secrets) and for the cost ledger
// directory `.claude/cost-ledger`. The pair match is on any `.claude` directory, so a project's own `.claude/settings*.json`
// is configuration too and is not catalogued as a document (R82).
const SECRET_SEGMENTS: ReadonlySet<string> = new Set(['.ssh', '.gnupg', '.aws'])
const SECRET_PAIRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['.config', new Set(['gcloud'])],
  ['library', new Set(['keychains'])],
  // Josh 360's own runtime data (JP-111): the ledger and cache databases, their backups and Atlas's logs and settings.
  ['.josh-360', new Set(['atlas', 'state', 'backups', 'logs'])],
  ['.claude', new Set(['atlas', '.credentials.json', 'settings.json', 'settings.local.json', 'cost-ledger', ...CLAUDE_RUNTIME_SEGMENTS])],
])

const FIXED_DISCOVERY_SET: ReadonlySet<string> = new Set(FIXED_DISCOVERY_SEGMENTS)
// Roots carrying only `direct-only` (no bulk-scan flag) authorize exact observed paths -- a regular file directly inside the
// root, judged on its real path -- and are never bulk-scanned. A root with any scan flag authorizes its whole subtree.
const SCAN_SCOPE_FLAGS: ReadonlySet<string> = new Set(['checkout', 'configured-output', 'cli-output', 'session-cwd'])
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const NON_ASCII_RE = /[^\u0000-\u007f]/
// With the `u` flag, \p{Cs} matches only unpaired surrogates. Node encodes one as U+FFFD at the syscall, so such a string
// does not name the file it spells.
const LONE_SURROGATE_RE = /\p{Cs}/u
// A lone surrogate cannot be encoded as UTF-8, and U+FFFD is what a lossy decoder leaves behind for invalid bytes; either
// means the string no longer names exactly one file.
const LOSSY_RE = /\p{Cs}|�/u

/** Why an identity was not produced. The caller records the slice as incomplete; it never stores a substitute identity. */
export type ArtifactIdentityRefusal = { incomplete: true; reason: 'lossy-path' | 'invalid-path' | 'outside-root' | 'invalid-id' }

/**
 * Stable denial tokens returned in `reason` by authorizeArtifactPath. They never contain the path.
 * - malformed (not a non-empty string, or an unpaired surrogate), relative-path, nul-byte, too-long, parent-segment: the
 *   spelling itself is rejected before any filesystem call.
 * - outside-home: not strictly inside the home directory (also: home is unusable, e.g. "/").
 * - secret-or-runtime: under a secrets directory, Atlas runtime data, a Claude runtime subtree, Claude's settings files or the cost ledger.
 * - git-internals: a `.git` segment (a repository's Git directory, or a linked worktree's `.git` file).
 * - symlink-escape: the spelling passed but its real path leaves home, enters an excluded directory, leaves every
 *   registered root, or cannot be resolved (a dangling ancestor link).
 * - outside-roots: inside home but not inside any usable registered root.
 * - root-missing: a not-yet-existing path whose deepest existing ancestor is above every containing root.
 * - file-symlink: the target itself is a symbolic link. not-regular-file: a directory, FIFO, socket or device.
 * - ancestor-not-directory: a not-yet-existing path below something that is not a directory.
 * - inaccessible: the filesystem refused the check (permissions, loops, over-long components).
 */
export type ArtifactPathDenialReason =
  | 'malformed' | 'relative-path' | 'nul-byte' | 'too-long' | 'parent-segment' | 'outside-home' | 'secret-or-runtime' | 'git-internals'
  | 'symlink-escape' | 'outside-roots' | 'root-missing' | 'file-symlink' | 'not-regular-file' | 'ancestor-not-directory' | 'inaccessible'

type Home = { lexical: string; real: string }
type Spelling = { ok: true; lexical: string } | { ok: false; reason: ArtifactPathDenialReason }

// ---------------------------------------------------------------------------------------------------------------- helpers

function segmentsOf(absPath: string): string[] {
  return absPath.slice(1).split('/')
}

/** `path` is strictly below `dir`. Both are normalized absolute paths; `dir` is never "/". */
function strictlyWithin(path: string, dir: string): boolean {
  return path.length > dir.length + 1 && path.startsWith(`${dir}/`)
}

function atOrWithin(path: string, dir: string): boolean {
  return path === dir || strictlyWithin(path, dir)
}

/** An absolute path with no empty, "." or ".." segment, no trailing separator and no NUL, and not the filesystem root. */
function isNormalizedAbsolute(p: unknown): p is string {
  return typeof p === 'string' && p.length > 1 && p.length <= MAX_ARTIFACT_PATH_CHARS && p.startsWith('/') && !p.includes('\0')
    && segmentsOf(p).every(s => s !== '' && s !== '.' && s !== '..')
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && !CONTROL_RE.test(v)
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Validates a caller-supplied spelling before any filesystem call. `..` is rejected rather than collapsed: the kernel resolves
 * `link/..` relative to the link's target, so a lexical collapse can name a different file than the one opened. Harmless
 * spellings ("//", "/./", a trailing "/") are normalized.
 */
function checkSpelling(path: unknown): Spelling {
  if (typeof path !== 'string' || path.length === 0 || LONE_SURROGATE_RE.test(path)) return { ok: false, reason: 'malformed' }
  if (path.includes('\0')) return { ok: false, reason: 'nul-byte' }
  if (path.length > MAX_ARTIFACT_PATH_CHARS) return { ok: false, reason: 'too-long' }
  if (!path.startsWith('/')) return { ok: false, reason: 'relative-path' }
  if (path.split('/').includes('..')) return { ok: false, reason: 'parent-segment' }
  const lexical = resolve(path)
  if (lexical === '/') return { ok: false, reason: 'outside-home' }
  return { ok: true, lexical }
}

/** Home by its given spelling and by its real path; null when it is unusable ("/", relative, malformed). */
function homeOf(home: unknown): Home | null {
  if (typeof home !== 'string' || !home.startsWith('/') || home.includes('\0') || home.split('/').includes('..')) return null
  const lexical = resolve(home)
  if (lexical === '/') return null
  let real = lexical
  try { real = realpathSync.native(lexical) } catch { /* a missing home keeps its spelling; nothing below it exists either */ }
  return real === '/' ? null : { lexical, real }
}

/** Strictly inside home (never home itself or an ancestor of it), by either spelling of home. */
function insideHome(p: string, h: Home): boolean {
  return strictlyWithin(p, h.lexical) || strictlyWithin(p, h.real)
}

/**
 * Claude Code temp dirs a session legitimately writes deliverables into ($CLAUDE_JOB_DIR/tmp = .claude/jobs/<id>/tmp, and
 * .claude/tmp) stay usable although .claude/jobs is job state. Exact letter case only, so a case variant stays excluded.
 */
function isClaudeJobTempPair(segs: string[], i: number): boolean {
  return segs[i] === '.claude' && segs[i + 1] === 'jobs' && segs[i + 3] === 'tmp' && segs.length > i + 4
}

/**
 * A segment folded for deny-list and PHI comparison. macOS volumes are usually case-insensitive and normalization-insensitive
 * with Unicode case folding, so `.SSH`, `.ſsh` (long s) and `Library/Keychains` (Kelvin sign) can all name the real
 * directory. NFKC plus a lower/upper/lower round trip maps those (and ß/ẞ to ss) onto their ASCII forms. It may also fold a
 * name the filesystem would keep distinct; for a deny list or protection that only over-protects.
 */
function fold(segment: string): string {
  if (!NON_ASCII_RE.test(segment)) return segment.toLowerCase()
  return segment.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase()
}

/** The exclusion that applies to a normalized absolute path regardless of roots, or null. */
function locationPolicy(absPath: string): 'git-internals' | 'secret-or-runtime' | null {
  const segs = segmentsOf(absPath)
  const lower = segs.map(fold)
  if (lower.includes('.git')) return 'git-internals'
  for (let i = 0; i < lower.length; i++) {
    if (SECRET_SEGMENTS.has(lower[i]!)) return 'secret-or-runtime'
    const children = SECRET_PAIRS.get(lower[i]!)
    if (children && i + 1 < lower.length && children.has(lower[i + 1]!) && !isClaudeJobTempPair(segs, i)) return 'secret-or-runtime'
  }
  return null
}

/**
 * The one PHI segment rule (spec section 4, ruling R85): a segment that is exactly `phi` or `.phi` after the deny-list fold
 * (NFKC plus a case round trip). `.phi` is the folder name the harness uses for PHI; `Delphi`, `phil`, `.phix` and `phi.txt`
 * are not PHI. Kept dependency-free so the discovery worker, the DB layer and the standalone removal checker share it.
 */
export function isPhiSegment(segment: string): boolean {
  const f = fold(segment)
  return f === 'phi' || f === '.phi'
}

/** A protected location: a `phi` or `.phi` segment (any case) anywhere in the path, as today file names included. Content is never inspected. */
export function hasPhiSegment(path: string): boolean {
  return path.split('/').some(isPhiSegment)
}

/** A root this policy will authorize against: a normalized absolute directory strictly inside home and not excluded. */
function usableRoot(r: ArtifactWorkerRoot, h: Home): boolean {
  return !!r && typeof r === 'object' && isId(r.rootId) && isNormalizedAbsolute(r.canonicalPath) && insideHome(r.canonicalPath, h)
    && locationPolicy(r.canonicalPath) === null
}

/** A root with no bulk-scan scope: `direct-only`, or (failing closed) no usable flags at all. */
function isDirectOnly(r: ArtifactWorkerRoot): boolean {
  return !Array.isArray(r.scopeFlags) || !r.scopeFlags.some(f => SCAN_SCOPE_FLAGS.has(f))
}

/** The most specific root; duplicates of one canonical directory tie-break by root ID (code-unit order, locale-free). */
function deepestRoot(roots: ArtifactWorkerRoot[]): ArtifactWorkerRoot {
  return roots.reduce((best, r) => {
    if (r.canonicalPath.length !== best.canonicalPath.length) return r.canonicalPath.length > best.canonicalPath.length ? r : best
    return r.rootId < best.rootId ? r : best
  })
}

function relativeRefusal(rel: unknown): ArtifactIdentityRefusal | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_ARTIFACT_PATH_CHARS || rel.includes('\0') || rel.startsWith('/')
    || rel.split('/').some(s => s === '' || s === '.' || s === '..')) return { incomplete: true, reason: 'invalid-path' }
  if (LOSSY_RE.test(rel)) return { incomplete: true, reason: 'lossy-path' }
  return null
}

// ---------------------------------------------------------------------------------------------------------------- roots

/**
 * Canonicalizes a root candidate (session cwd, checkout, configured or CLI output directory, durable output base) at
 * registration. An existing root resolves through every symlink, including a symlinked root itself, and must be a directory.
 * A missing root resolves its deepest existing ancestor and appends the rest, giving its normalized canonical path with
 * `exists: false`; it stays inactive and authorizes nothing above itself (authorizeArtifactPath requires a not-yet-existing
 * path's deepest existing ancestor to be at or inside the root).
 *
 * Errors: `outside-home` is every policy rejection of the spelling as given -- not strictly inside home (home itself, an
 * ancestor of home, an absolute path elsewhere), a secret/Atlas-runtime/Claude-runtime directory, Git internals, a `..`
 * segment, a relative path, NUL or other control characters, or over 4096 characters. `symlink-escape` means the spelling
 * passed but its real path does not (it resolves outside home, to home itself, into an excluded directory, or through a
 * dangling link). `not-directory` means the path or its deepest existing ancestor is not a directory, or could not be checked.
 */
export function canonicalizeArtifactRoot(path: string, home: string): { canonicalPath: string; exists: boolean } | { error: 'outside-home' | 'symlink-escape' | 'not-directory' } {
  const spelled = checkSpelling(path)
  const h = homeOf(home)
  if (!spelled.ok || !h || CONTROL_RE.test(path)) return { error: 'outside-home' }
  const lexical = spelled.lexical
  if (!insideHome(lexical, h) || locationPolicy(lexical) !== null) return { error: 'outside-home' }

  // Deepest existing ancestor-or-self. lstat never follows the final link; realpath below resolves every link in the prefix.
  let dir = lexical
  const tail: string[] = []
  for (;;) {
    try {
      lstatSync(dir)
      break
    } catch (err) {
      if (!isMissing(err) || dir === '/') return { error: 'not-directory' }
    }
    tail.unshift(basename(dir))
    dir = dirname(dir)
  }
  let real: string
  try { real = realpathSync.native(dir) } catch { return { error: 'symlink-escape' } }
  let st: Stats
  try { st = lstatSync(real) } catch { return { error: 'not-directory' } }
  if (!st.isDirectory()) return { error: 'not-directory' }

  const canonical = tail.length === 0 ? real : `${real === '/' ? '' : real}/${tail.join('/')}`
  const ok = canonical.length <= MAX_ARTIFACT_PATH_CHARS && !CONTROL_RE.test(canonical) && insideHome(canonical, h) && locationPolicy(canonical) === null
  if (!ok) return { error: canonical === lexical ? 'outside-home' : 'symlink-escape' }
  return { canonicalPath: canonical, exists: tail.length === 0 }
}

// ---------------------------------------------------------------------------------------------------------------- access

/**
 * Decides whether Atlas may stat, record or act on one exact path. Allowed means: a regular file (not a symlink) or a
 * not-yet-existing path whose real location is strictly inside a usable registered root under home, outside secrets, Atlas
 * runtime, Claude runtime and Git internals. Discovery exclusions (node_modules, build, user ignoreSegments, Git ignore
 * rules) play no part, and linked worktrees are ordinary roots. A root with no bulk-scan flag (`direct-only`) covers only a
 * file whose real parent IS that root (an existing regular file, or a not-yet-existing name whose deepest existing ancestor
 * is the root itself); its subdirectories need a root of their own.
 *
 * On success `canonicalPath` is the real path to act on (every symlinked ancestor resolved) and `rootId` is the deepest root
 * containing it, ties broken by the smaller root ID: the identity root for a NEW location. A location already catalogued
 * keeps its original identity root; callers pass that root to documentIdentityForPath instead. A not-yet-existing path is
 * allowed only when its deepest existing ancestor resolves at or inside the chosen root, so a missing root never authorizes
 * its parent. On denial `canonicalPath` and `rootId` are null and `reason` is an ArtifactPathDenialReason token.
 *
 * `protected` is true when any segment of the given or real path is `phi` (any case), the filename is secret-looking
 * (filetype.ts patterns, including configured extras), or any registered root containing the path is protected. Denied paths
 * report the same path-only signals so a caller can redact them, including a spelling rejected before any filesystem call
 * (read from the raw string); a non-string input reports `protected: true`.
 *
 * The check is a point-in-time decision: an action must still open with O_NOFOLLOW / re-lstat, since the filesystem can
 * change between this call and the action.
 */
export function authorizeArtifactPath(path: string, roots: ArtifactWorkerRoot[], home: string): { allowed: boolean; canonicalPath: string | null; rootId: string | null; protected: boolean; reason: string | null } {
  const pathProtected = (p: string) => hasPhiSegment(p) || isSensitiveFilename(basename(p))
  const spelled = checkSpelling(path)
  // A rejected spelling still reports its path-only signals, read from the raw string; a non-string fails closed.
  if (!spelled.ok) return deny(spelled.reason, typeof path === 'string' ? pathProtected(path) : true)
  const lexical = spelled.lexical
  const lexicalProtected = pathProtected(lexical)
  const h = homeOf(home)
  if (!h || !insideHome(lexical, h)) return deny('outside-home', lexicalProtected)
  const lexicalPolicy = locationPolicy(lexical)
  if (lexicalPolicy) return deny(lexicalPolicy, true)

  let st: Stats | null = null
  try {
    st = lstatSync(lexical)
  } catch (err) {
    if (!isMissing(err)) return deny('inaccessible', lexicalProtected)
  }
  let canonical: string
  // For a not-yet-existing path: the real directory its existence is anchored to.
  let anchor: string | null = null
  if (st) {
    if (st.isSymbolicLink()) return deny('file-symlink', lexicalProtected)
    if (!st.isFile()) return deny('not-regular-file', lexicalProtected)
    try { canonical = realpathSync.native(lexical) } catch { return deny('inaccessible', lexicalProtected) }
  } else {
    let dir = dirname(lexical)
    const tail = [basename(lexical)]
    for (;;) {
      try {
        lstatSync(dir)
        break
      } catch (err) {
        if (!isMissing(err) || dir === '/') return deny('inaccessible', lexicalProtected)
      }
      tail.unshift(basename(dir))
      dir = dirname(dir)
    }
    try { anchor = realpathSync.native(dir) } catch { return deny('symlink-escape', lexicalProtected) }
    let ast: Stats
    try { ast = lstatSync(anchor) } catch { return deny('inaccessible', lexicalProtected) }
    if (!ast.isDirectory()) return deny('ancestor-not-directory', lexicalProtected)
    canonical = `${anchor === '/' ? '' : anchor}/${tail.join('/')}`
  }

  const moved = canonical !== lexical
  const signalled = lexicalProtected || pathProtected(canonical)
  if (canonical.length > MAX_ARTIFACT_PATH_CHARS) return deny('too-long', signalled)
  if (!insideHome(canonical, h)) return deny(moved ? 'symlink-escape' : 'outside-home', signalled)
  const canonicalPolicy = locationPolicy(canonical)
  if (canonicalPolicy) return deny(moved ? 'symlink-escape' : canonicalPolicy, true)

  const list = Array.isArray(roots) ? roots : []
  // A direct-only root covers only a file directly inside it, by its real parent, so a symlinked subdirectory cannot bring
  // a deeper file in. (Directories were refused above as not-regular-file.)
  const parent = dirname(canonical)
  const containing = list.filter(r => usableRoot(r, h) && strictlyWithin(canonical, r.canonicalPath) && (!isDirectOnly(r) || parent === r.canonicalPath))
  const eligible = anchor === null ? containing
    : containing.filter(r => atOrWithin(anchor, r.canonicalPath) && (!isDirectOnly(r) || anchor === r.canonicalPath))
  if (eligible.length === 0) return deny(containing.length > 0 ? 'root-missing' : moved ? 'symlink-escape' : 'outside-roots', signalled)

  // Protection from any containing root sticks, whichever root owns the location, by the given or the real spelling.
  const rootProtected = list.some(r => !!r && r.protected === true && isNormalizedAbsolute(r.canonicalPath)
    && (strictlyWithin(canonical, r.canonicalPath) || strictlyWithin(lexical, r.canonicalPath)))
  return { allowed: true, canonicalPath: canonical, rootId: deepestRoot(eligible).rootId, protected: signalled || rootProtected, reason: null }
}

function deny(reason: ArtifactPathDenialReason, isProtected: boolean): { allowed: boolean; canonicalPath: string | null; rootId: string | null; protected: boolean; reason: string | null } {
  return { allowed: false, canonicalPath: null, rootId: null, protected: isProtected, reason }
}

// ---------------------------------------------------------------------------------------------------------------- discovery

/**
 * Whether a bulk traversal of `root` should skip `path` (a directory to not descend into, or a file to not emit). Only
 * discovery uses this: it never denies an already-known location, an explicit action, a registered output file or removal
 * protection -- those go through authorizeArtifactPath, which ignores every rule here except the location exclusions.
 *
 * Name rules apply to segments BELOW the root only, so an explicitly registered root may itself live under `build/` or
 * `.claude/worktrees/`: fixed dependency/build/cache names, the user's `config.ignoreSegments` (exact names) and junk
 * suffixes on the last segment. A linked worktree nested below the root (`.claude/worktrees/<name>`) is skipped because it
 * is its own checkout root, discovered with its own Git identity. Secrets, Atlas/Claude runtime and Git internals are
 * skipped anywhere (including a pair straddling the root, such as root ~/.config and child gcloud). Fails closed: a
 * malformed path, a path outside the root, or a root with no bulk-scan scope (`direct-only`) is excluded.
 */
export function isPassiveDiscoveryExcluded(path: string, config: ArtifactsConfig, root: ArtifactWorkerRoot): boolean {
  if (!root || typeof root !== 'object' || !isNormalizedAbsolute(root.canonicalPath)) return true
  if (isDirectOnly(root)) return true
  if (!isNormalizedAbsolute(path)) return true
  const base = root.canonicalPath
  if (path !== base && !strictlyWithin(path, base)) return true
  if (locationPolicy(path) !== null) return true
  if (path === base) return false

  const baseSegs = segmentsOf(base)
  const rel = path.slice(base.length + 1).split('/')
  const user = Array.isArray(config?.ignoreSegments) ? config.ignoreSegments : []
  for (let i = 0; i < rel.length; i++) {
    const s = rel[i]!
    if (FIXED_DISCOVERY_SET.has(s) || user.includes(s)) return true
    // `.claude` then `worktrees`, where the worktrees directory itself lies below the root.
    const prev = i === 0 ? baseSegs[baseSegs.length - 1] : rel[i - 1]
    if (s === 'worktrees' && prev === '.claude') return true
  }
  const name = rel[rel.length - 1]!
  return JUNK_SUFFIXES.some(suffix => name.endsWith(suffix))
}

// ---------------------------------------------------------------------------------------------------------------- identity

/**
 * Repository identity: repository UUID plus the exact repo-relative Git path, byte-for-byte as Git reported it (case and
 * Unicode form preserved). Linked worktrees and the main checkout share one repository ID, so one Git path is one document
 * group whichever checkout or output root found it. Callers pass a Git path only once the Git adapter has confirmed it,
 * decoded strictly as UTF-8. A path that is not a normalized relative path, or that cannot be represented losslessly
 * (an unpaired surrogate, or U+FFFD left by lossy decoding), is refused rather than approximated.
 */
export function documentIdentityForGitPath(repositoryId: string, gitPath: string): ArtifactDocumentIdentity | ArtifactIdentityRefusal {
  if (!isId(repositoryId)) return { incomplete: true, reason: 'invalid-id' }
  const refusal = relativeRefusal(gitPath)
  if (refusal) return refusal
  return { identityKind: 'repository', repositoryId, rootId: null, relativePath: gitPath }
}

/**
 * Identity for a filesystem path found under `root`. With a confirmed `repository` mapping it is the repository identity of
 * that Git path; otherwise it is root identity: `root.rootId` plus the exact path relative to `root.canonicalPath`.
 * `root.repositoryId` is never used here: a repository association on an output root is project metadata, not permission
 * to invent a Git path. Pass the canonical path from authorizeArtifactPath, and pass the root that owns the identity: the
 * location's original root when it is already catalogued, else the root authorizeArtifactPath chose (deepest, ties by ID).
 * The path must lie strictly inside the root in every case. Refusals: `outside-root`, `invalid-path`, `lossy-path`,
 * `invalid-id`.
 */
export function documentIdentityForPath(path: string, root: ArtifactWorkerRoot, repository: { repositoryId: string; gitPath: string } | null): ArtifactDocumentIdentity | ArtifactIdentityRefusal {
  if (!root || typeof root !== 'object' || !isId(root.rootId) || !isNormalizedAbsolute(root.canonicalPath)) return { incomplete: true, reason: 'invalid-id' }
  if (!isNormalizedAbsolute(path)) return { incomplete: true, reason: 'invalid-path' }
  if (!strictlyWithin(path, root.canonicalPath)) return { incomplete: true, reason: 'outside-root' }
  if (repository) return documentIdentityForGitPath(repository.repositoryId, repository.gitPath)
  const rel = path.slice(root.canonicalPath.length + 1)
  const refusal = relativeRefusal(rel)
  if (refusal) return refusal
  return { identityKind: 'root', repositoryId: null, rootId: root.rootId, relativePath: rel }
}
