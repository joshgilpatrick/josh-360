// Pure parsers for Git's NUL-delimited output (Artifact Manager, plan 2026-10-26 Task 4).
//
// No I/O and no process launches: every function here takes the bytes Git printed and returns structured records. Paths stay
// Buffers until they are proven to be lossless UTF-8 (decodeGitPath); a path that is not is reported with `lossy: true`, its
// raw bytes and a null string, so callers mark their slice incomplete instead of dropping the record or decoding it lossily
// into an identity. A record that does not have Git's documented shape, or that output truncation cut short, becomes an explicit
// `malformed` record and parsing stops there: nothing after an unparseable record is guessed at.

export type GitObjectFormat = 'sha1' | 'sha256'

export const GIT_OID_HEX_LENGTH: Readonly<Record<GitObjectFormat, number>> = Object.freeze({ sha1: 40, sha256: 64 })

const HEX_RE = /^[0-9a-f]+$/

/** True when `value` is a full lowercase hex object ID of exactly the length `format` uses. */
export function isGitOid(value: unknown, format: GitObjectFormat): value is string {
  return typeof value === 'string' && value.length === GIT_OID_HEX_LENGTH[format] && HEX_RE.test(value)
}

/** The all-zero OID Git prints for "no object" (the absent side of an addition or deletion, an unborn HEAD). */
export function isNullGitOid(value: string): boolean {
  return /^0+$/.test(value)
}

// ------------------------------------------------------------------------------------------------------------------- paths

// fatal: reject invalid sequences, overlongs and encoded surrogates. ignoreBOM: a leading U+FEFF is part of the name, not a
// byte-order mark to strip (stripping it would be lossy).
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/u

/**
 * The path as a string when its bytes are lossless UTF-8, else null. Lossless means: strict decoding succeeds, the result has
 * no unpaired surrogate, and re-encoding gives back exactly the input bytes. An empty path is never valid.
 */
export function decodeGitPath(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  let text: string
  try {
    text = STRICT_UTF8.decode(bytes)
  } catch {
    return null
  }
  if (LONE_SURROGATE_RE.test(text)) return null
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null
  return text
}

type NulFields = { fields: Buffer[]; tail: Buffer | null }

/** Splits on NUL terminators. `tail` holds bytes after the last NUL: output that ended mid-field. */
function splitNul(buffer: Buffer): NulFields {
  const fields: Buffer[] = []
  let start = 0
  for (;;) {
    const at = buffer.indexOf(0, start)
    if (at < 0) break
    fields.push(buffer.subarray(start, at))
    start = at + 1
  }
  return { fields, tail: start < buffer.length ? buffer.subarray(start) : null }
}

// Copies, so a returned record never pins a multi-megabyte stdout buffer.
const copy = (b: Uint8Array): Buffer => Buffer.from(b)
const ascii = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')

// ------------------------------------------------------------------------------------------------- status --porcelain=v1 -z

export type GitStatusKind = 'ordinary' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | 'malformed'

export type GitStatusEntry = {
  kind: GitStatusKind
  /** Index status letter (porcelain X), '' for a malformed record. */
  x: string
  /** Work-tree status letter (porcelain Y), '' for a malformed record. */
  y: string
  /** Repository-relative path (the destination of a rename/copy); null when lossy or malformed. */
  path: string | null
  pathBytes: Buffer
  /** Source path of a rename/copy; null otherwise or when lossy. */
  origPath: string | null
  origPathBytes: Buffer | null
  /** True when a path is not lossless UTF-8 or the record is malformed: the caller's slice is incomplete. */
  lossy: boolean
  /** The index differs from HEAD for this tracked path. */
  staged: boolean
  /** The work tree differs from the index for this tracked path. */
  unstaged: boolean
  conflict: boolean
}

const STATUS_LETTERS = new Set([' ', 'M', 'T', 'A', 'D', 'R', 'C', 'U', '?', '!'])
const UNMERGED_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function malformedStatus(bytes: Uint8Array): GitStatusEntry {
  return {
    kind: 'malformed', x: '', y: '', path: null, pathBytes: copy(bytes), origPath: null, origPathBytes: null,
    lossy: true, staged: false, unstaged: false, conflict: false,
  }
}

function statusKind(x: string, y: string): GitStatusKind | null {
  const xy = x + y
  if (xy === '??') return 'untracked'
  if (xy === '!!') return 'ignored'
  if (x === '?' || y === '?' || x === '!' || y === '!') return null
  if (UNMERGED_PAIRS.has(xy)) return 'unmerged'
  if (x === 'U' || y === 'U') return null
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C' || y === 'C') return 'copied'
  if (xy === '  ') return null
  return 'ordinary'
}

/**
 * Parses `git status --porcelain=v1 -z`: records are `XY <path>\0`, and a rename or copy (R/C in either column) is followed by
 * its source as a second NUL-terminated field, destination first. A `## branch` header (from --branch) is skipped.
 */
export function parsePorcelainV1Z(buffer: Buffer): GitStatusEntry[] {
  const { fields, tail } = splitNul(buffer)
  const out: GitStatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length >= 3 && field[0] === 0x23 && field[1] === 0x23 && field[2] === 0x20) continue
    if (field.length < 4 || field[2] !== 0x20) { out.push(malformedStatus(field)); return out }
    const x = String.fromCharCode(field[0]!)
    const y = String.fromCharCode(field[1]!)
    const kind = STATUS_LETTERS.has(x) && STATUS_LETTERS.has(y) ? statusKind(x, y) : null
    if (!kind) { out.push(malformedStatus(field)); return out }
    const pathBytes = copy(field.subarray(3))
    let origPathBytes: Buffer | null = null
    if (kind === 'renamed' || kind === 'copied') {
      const source = fields[i + 1]
      if (source === undefined || source.length === 0) { out.push(malformedStatus(field)); return out }
      origPathBytes = copy(source)
      i++
    }
    const path = decodeGitPath(pathBytes)
    const origPath = origPathBytes ? decodeGitPath(origPathBytes) : null
    const tracked = kind === 'ordinary' || kind === 'renamed' || kind === 'copied'
    out.push({
      kind, x, y, path, pathBytes, origPath, origPathBytes,
      lossy: path === null || (origPathBytes !== null && origPath === null),
      staged: tracked && x !== ' ', unstaged: tracked && y !== ' ', conflict: kind === 'unmerged',
    })
  }
  if (tail) out.push(malformedStatus(tail))
  return out
}

// ------------------------------------------------------------------------------------------ name-status, raw diff and log

export type GitChangeStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X' | 'B' | 'malformed'

/** Commit-level facts shared by every change of one commit. Session association is commit-level, never per-file authorship. */
export type GitCommitInfo = {
  oid: string
  objectFormat: GitObjectFormat
  parents: string[]
  /** Committer and author times, epoch seconds as Git recorded them (not validated against the clock). */
  committedAt: number
  authoredAt: number
  /** Valid `Atlas-Session: <UUID>` trailer values (lowercase, unique, sorted). Every other trailer is ignored. */
  atlasSessionIds: string[]
  /** The commit is a shallow-clone boundary: its parents are absent, so its diff lists every file as added. */
  shallowBoundary: boolean
}

export type GitChange = {
  status: GitChangeStatus
  /** Git's status token as printed: 'M', 'R100', 'C075', 'MM' (combined merge diff), or '' when malformed. */
  rawStatus: string
  /** Similarity score of a rename/copy (or break) when Git printed one. */
  score: number | null
  /** Destination path (the new name of a rename/copy); null when lossy or malformed. */
  path: string | null
  pathBytes: Buffer
  /** Source path of a rename/copy. */
  oldPath: string | null
  oldPathBytes: Buffer | null
  lossy: boolean
  /** Numeric file modes (e.g. 0o100644); null when the source output carries none (name-status). */
  oldMode: number | null
  mode: number | null
  /** Blob OIDs before and after; null for the absent side, or when the source output carries none. */
  oldBlobOid: string | null
  blobOid: string | null
  /** Blob size in bytes, filled by batched object metadata; null unless `blobState` is 'present'. */
  size: number | null
  /**
   * What the metadata lookup found for `blobOid`: 'present' (size and LFS status known), 'missing' (Git reports the object
   * absent), 'unavailable' (not readable without fetching, in a partial clone). null when there is no blob to describe (a
   * deletion or submodule gitlink) or when the change came from a parser and was never looked up.
   */
  blobState: 'present' | 'missing' | 'unavailable' | null
  /** The blob is a Git LFS pointer file; null when not checked. LFS content is never fetched. */
  lfsPointer: boolean | null
  /** The commit this change belongs to; null for output that has no commit header (diff-tree --no-commit-id). */
  commit: GitCommitInfo | null
}

const SINGLE_STATUS_RE = /^([ACDMRTUXB])(\d{1,3})?$/
const COMBINED_STATUS_RE = /^[ACDMRTUX]{2,}$/

function malformedChange(bytes: Uint8Array, commit: GitCommitInfo | null): GitChange {
  return {
    status: 'malformed', rawStatus: '', score: null, path: null, pathBytes: copy(bytes), oldPath: null, oldPathBytes: null, lossy: true,
    oldMode: null, mode: null, oldBlobOid: null, blobOid: null, size: null, blobState: null, lfsPointer: null, commit,
  }
}

function combinedStatus(letters: string): GitChangeStatus {
  if ([...letters].every(l => l === 'A')) return 'A'
  if ([...letters].every(l => l === 'D')) return 'D'
  return 'M'
}

type EntryParse = { change: GitChange; next: number } | { malformed: true }

function pathChange(fields: Buffer[], at: number, twoPaths: boolean, base: Omit<GitChange, 'path' | 'pathBytes' | 'oldPath' | 'oldPathBytes' | 'lossy'>): EntryParse {
  const first = fields[at]
  const second = twoPaths ? fields[at + 1] : undefined
  if (first === undefined || first.length === 0 || (twoPaths && (second === undefined || second.length === 0))) return { malformed: true }
  const pathBytes = copy(twoPaths ? second! : first)
  const oldPathBytes = twoPaths ? copy(first) : null
  const path = decodeGitPath(pathBytes)
  const oldPath = oldPathBytes ? decodeGitPath(oldPathBytes) : null
  return {
    change: { ...base, path, pathBytes, oldPath, oldPathBytes, lossy: path === null || (oldPathBytes !== null && oldPath === null) },
    next: at + (twoPaths ? 2 : 1),
  }
}

function parseNameStatusEntry(fields: Buffer[], at: number, commit: GitCommitInfo | null): EntryParse {
  const token = ascii(fields[at]!)
  const single = SINGLE_STATUS_RE.exec(token)
  if (single) {
    const status = single[1] as GitChangeStatus
    return pathChange(fields, at + 1, status === 'R' || status === 'C', {
      status, rawStatus: token, score: single[2] !== undefined ? Number(single[2]) : null,
      oldMode: null, mode: null, oldBlobOid: null, blobOid: null, size: null, blobState: null, lfsPointer: null, commit,
    })
  }
  if (COMBINED_STATUS_RE.test(token)) {
    return pathChange(fields, at + 1, false, {
      status: combinedStatus(token), rawStatus: token, score: null,
      oldMode: null, mode: null, oldBlobOid: null, blobOid: null, size: null, blobState: null, lfsPointer: null, commit,
    })
  }
  return { malformed: true }
}

const MODE_RE = /^[0-7]{6}$/

/**
 * One raw diff entry: `:<srcmode> <dstmode> <srcoid> <dstoid> <status>\0<path>\0[<path>\0]`, or the combined form for a merge
 * with n parents: `::…` (n colons), n+1 modes, n+1 OIDs and n status letters, followed by the single result path.
 */
function parseRawEntry(fields: Buffer[], at: number, format: GitObjectFormat, commit: GitCommitInfo | null): EntryParse {
  const meta = ascii(fields[at]!)
  let colons = 0
  while (meta[colons] === ':') colons++
  if (colons === 0) return { malformed: true }
  const tokens = meta.slice(colons).split(' ')
  if (tokens.length !== 2 * (colons + 1) + 1) return { malformed: true }
  const modes = tokens.slice(0, colons + 1)
  const oids = tokens.slice(colons + 1, 2 * (colons + 1))
  const statusToken = tokens[tokens.length - 1]!
  if (!modes.every(m => MODE_RE.test(m)) || !oids.every(o => isGitOid(o, format))) return { malformed: true }
  const blob = (oid: string): string | null => (isNullGitOid(oid) ? null : oid)
  const mode = (m: string): number | null => (m === '000000' ? null : parseInt(m, 8))
  if (colons === 1) {
    const single = SINGLE_STATUS_RE.exec(statusToken)
    if (!single) return { malformed: true }
    const status = single[1] as GitChangeStatus
    return pathChange(fields, at + 1, status === 'R' || status === 'C', {
      status, rawStatus: statusToken, score: single[2] !== undefined ? Number(single[2]) : null,
      oldMode: mode(modes[0]!), mode: mode(modes[1]!), oldBlobOid: blob(oids[0]!), blobOid: blob(oids[1]!), size: null, blobState: null, lfsPointer: null, commit,
    })
  }
  if (statusToken.length !== colons || !COMBINED_STATUS_RE.test(statusToken)) return { malformed: true }
  return pathChange(fields, at + 1, false, {
    status: combinedStatus(statusToken), rawStatus: statusToken, score: null,
    oldMode: mode(modes[0]!), mode: mode(modes[colons]!), oldBlobOid: blob(oids[0]!), blobOid: blob(oids[colons]!), size: null, blobState: null, lfsPointer: null, commit,
  })
}

/**
 * Parses name-status output with -z (`git diff-tree -r -z --name-status --no-commit-id`, or the change part of
 * `log --name-status -z`): `<status>\0<path>\0`, and for renames/copies `R<score>\0<source>\0<destination>\0`.
 */
export function parseNameStatusZ(buffer: Buffer): GitChange[] {
  const { fields, tail } = splitNul(buffer)
  const out: GitChange[] = []
  let at = 0
  while (at < fields.length) {
    const parsed = parseNameStatusEntry(fields, at, null)
    if ('malformed' in parsed) { out.push(malformedChange(fields[at]!, null)); return out }
    out.push(parsed.change)
    at = parsed.next
  }
  if (tail) out.push(malformedChange(tail, null))
  return out
}

/** Parses raw diff output with -z and full OIDs (`git diff-tree -r -z --raw --no-abbrev --no-commit-id`). */
export function parseRawDiffZ(buffer: Buffer, format: GitObjectFormat): GitChange[] {
  const { fields, tail } = splitNul(buffer)
  const out: GitChange[] = []
  let at = 0
  while (at < fields.length) {
    const parsed = parseRawEntry(fields, at, format, null)
    if ('malformed' in parsed) { out.push(malformedChange(fields[at]!, null)); return out }
    out.push(parsed.change)
    at = parsed.next
  }
  if (tail) out.push(malformedChange(tail, null))
  return out
}

/**
 * The commit header layout `parseGitLogZ` expects, for `git log -z --format=…`. Every field is NUL-terminated, the message
 * (%B) is one field (commit messages carry no NUL), and the record is closed by an explicit `@E` field, so markers, colons or
 * trailer-like lines inside a message cannot be mistaken for structure.
 */
export const GIT_LOG_RECORD_FORMAT = '@H%x00%H%x00%P%x00%ct%x00%at%x00%B%x00@E'

export type ParsedGitCommit = GitCommitInfo & { changes: GitChange[] }

export type ParsedGitLog = {
  commits: ParsedGitCommit[]
  /** Output did not have the documented shape; parsing stopped at the bad record. */
  malformed: boolean
  /** Output ended mid-field or mid-record (truncation or a killed process); the last commit may be incomplete. */
  partial: boolean
  /** OID of the last commit header seen, even when that commit's record was cut short. */
  lastHeaderOid: string | null
}

const DIGITS_RE = /^\d{1,15}$/

/**
 * Parses `git log -z --format=GIT_LOG_RECORD_FORMAT` with `--raw` (full OIDs) or `--name-status` changes. After the `@E` field Git
 * separates header and changes with a newline (or an empty field for a combined merge diff); a commit without changes is
 * followed directly by the next header.
 */
export function parseGitLogZ(buffer: Buffer, format: GitObjectFormat): ParsedGitLog {
  const { fields, tail } = splitNul(buffer)
  const result: ParsedGitLog = { commits: [], malformed: false, partial: tail !== null, lastHeaderOid: null }
  let at = 0
  while (at < fields.length) {
    if (ascii(fields[at]!) !== '@H') { result.malformed = true; return result }
    const header = fields.slice(at + 1, at + 7)
    if (header.length > 0 && isGitOid(ascii(header[0]!), format)) result.lastHeaderOid = ascii(header[0]!)
    if (header.length < 6) { result.partial = true; return result }
    const [oidB, parentsB, ctB, atB, messageB, endB] = header as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer]
    const oid = ascii(oidB)
    const parentsText = ascii(parentsB)
    const parents = parentsText === '' ? [] : parentsText.split(' ')
    const ct = ascii(ctB)
    const authored = ascii(atB)
    if (!isGitOid(oid, format) || !parents.every(p => isGitOid(p, format)) || !DIGITS_RE.test(ct) || !DIGITS_RE.test(authored) || ascii(endB) !== '@E') {
      result.malformed = true
      return result
    }
    // Changes reference a plain GitCommitInfo (shared by the commit's changes), never the record that contains them.
    const commit: GitCommitInfo = {
      oid, objectFormat: format, parents, committedAt: Number(ct), authoredAt: Number(authored),
      atlasSessionIds: parseAtlasSessionTrailers(messageB.toString('utf8')), shallowBoundary: false,
    }
    const info: ParsedGitCommit = { ...commit, changes: [] }
    at += 7
    result.commits.push(info)
    if (at >= fields.length) break
    let next = fields[at]!
    if (next.length === 0) {
      at++
      if (at >= fields.length) break
      next = fields[at]!
    } else if (next[0] === 0x0a) {
      fields[at] = next = next.subarray(1)
    }
    while (at < fields.length) {
      const field = fields[at]!
      if (ascii(field) === '@H') break
      const parsed = field[0] === 0x3a ? parseRawEntry(fields, at, format, commit) : parseNameStatusEntry(fields, at, commit)
      if ('malformed' in parsed) {
        // A truncated final entry looks malformed; only call it malformed when output was not cut short.
        if (tail !== null || at + 3 >= fields.length) result.partial = true
        else result.malformed = true
        return result
      }
      info.changes.push(parsed.change)
      at = parsed.next
    }
  }
  return result
}

// ------------------------------------------------------------------------------------------------------------------ trailers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRAILER_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:(.*)$/

/**
 * `Atlas-Session: <UUID>` values from a commit message's trailer block, and nothing else. Deliberately stricter than Git's own
 * trailer heuristics and independent of repository `trailer.*` config: the block is the final paragraph, never the title
 * paragraph, and every line in it must be a `Token: value` trailer or a folded continuation. The key matches case-insensitively;
 * a value must be exactly an 8-4-4-4-12 hex UUID (it is lowercased), otherwise it is ignored.
 */
export function parseAtlasSessionTrailers(message: string): string[] {
  const lines = message.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  let start = lines.length
  while (start > 0 && lines[start - 1]!.trim() !== '') start--
  if (start === 0 || start === lines.length) return []
  const trailers: Array<{ key: string; value: string }> = []
  for (const line of lines.slice(start)) {
    if (line[0] === ' ' || line[0] === '\t') {
      const last = trailers[trailers.length - 1]
      if (!last) return []
      last.value += '\n' + line.trim()
      continue
    }
    const m = TRAILER_LINE_RE.exec(line)
    if (!m) return []
    trailers.push({ key: m[1]!, value: m[2]!.trim() })
  }
  const ids = trailers.filter(t => t.key.toLowerCase() === 'atlas-session' && UUID_RE.test(t.value)).map(t => t.value.toLowerCase())
  return [...new Set(ids)].sort()
}

// ------------------------------------------------------------------------------------------------------------------- remotes

const CONTROL_RE = /[\u0000-\u001f\u007f]/
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//

/**
 * A remote URL safe to display: userinfo (user, password or token), query and fragment removed, for URL-style (https://, ssh://,
 * git://, file://) and scp-like (`[user@]host:path`) remotes; local paths pass through. Returns null for an empty value or one with
 * control characters. Userinfo is everything up to the LAST `@` of the authority (the text before the first `/`), whatever raw
 * characters it holds, so the query and fragment are cut only after it is removed: a token with a raw `#` or `?` never leaves a
 * first part behind. When it is ambiguous whether an `@` ends credentials, the text before it is dropped: losing display fidelity
 * is preferred to leaking a secret.
 */
export function sanitizeRemoteUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '' || CONTROL_RE.test(raw)) return null
  const cutQuery = (text: string): string => {
    const cut = text.search(/[?#]/)
    return cut >= 0 ? text.slice(0, cut) : text
  }
  const scheme = SCHEME_RE.exec(raw)
  if (scheme) {
    const prefix = scheme[0]
    let rest = raw.slice(prefix.length)
    const slash = rest.indexOf('/')
    const authority = slash >= 0 ? rest.slice(0, slash) : rest
    let at = authority.lastIndexOf('@')
    if (at < 0 && slash >= 0) {
      // `user:pa/ss@host/…`: the authority contains a colon whose suffix is not a port, so a later '@' ends credentials.
      const colon = authority.indexOf(':')
      if (colon >= 0 && !/^\d*$/.test(authority.slice(colon + 1))) at = rest.lastIndexOf('@')
    }
    if (at >= 0) rest = rest.slice(at + 1)
    rest = cutQuery(rest)
    return rest === '' ? null : prefix + rest
  }
  const colon = raw.indexOf(':')
  const firstSlash = raw.indexOf('/')
  let out = raw
  if (colon > 0 && (firstSlash < 0 || colon < firstSlash)) {
    // scp-like: strip through the last '@' before the path's first '/'.
    const limit = firstSlash < 0 ? raw.length : firstSlash
    const at = raw.lastIndexOf('@', limit)
    if (at >= 0) out = raw.slice(at + 1)
  }
  out = cutQuery(out)
  return out === '' ? null : out
}

// ---------------------------------------------------------------------------------------------------------- worktree list

export type GitWorktreeRecord = {
  pathBytes: Buffer
  path: string | null
  /** HEAD OID; null when absent from the record. An all-zero OID (unborn branch) is reported as null with `unborn`. */
  head: string | null
  unborn: boolean
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** Parses `git worktree list --porcelain -z`: attribute fields per record, each record closed by an empty field. */
export function parseWorktreeListZ(buffer: Buffer, format: GitObjectFormat): { records: GitWorktreeRecord[]; malformed: boolean } {
  const { fields, tail } = splitNul(buffer)
  const records: GitWorktreeRecord[] = []
  let current: GitWorktreeRecord | null = null
  for (const field of fields) {
    if (field.length === 0) {
      if (!current) return { records, malformed: true }
      records.push(current)
      current = null
      continue
    }
    const space = field.indexOf(0x20)
    const key = ascii(space < 0 ? field : field.subarray(0, space))
    const value = space < 0 ? null : field.subarray(space + 1)
    if (key === 'worktree') {
      if (current || value === null || value.length === 0) return { records, malformed: true }
      const pathBytes = copy(value)
      current = { pathBytes, path: decodeGitPath(pathBytes), head: null, unborn: false, branch: null, detached: false, bare: false, locked: false, prunable: false }
      continue
    }
    if (!current) return { records, malformed: true }
    if (key === 'HEAD') {
      const oid = value === null ? '' : ascii(value)
      if (!isGitOid(oid, format)) return { records, malformed: true }
      if (isNullGitOid(oid)) current.unborn = true
      else current.head = oid
    } else if (key === 'branch') {
      current.branch = value === null ? null : decodeGitPath(value)
    } else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
    else if (key === 'locked') current.locked = true
    else if (key === 'prunable') current.prunable = true
    // Unknown attributes from newer Git are ignored.
  }
  if (current || tail) return { records, malformed: true }
  return { records, malformed: false }
}

// ---------------------------------------------------------------------------------------------------- config, index, tree

export type GitConfigEntry = { key: string; value: string | null }

/** Parses `git config --null --get-regexp`: `key\nvalue\0` per entry, or `key\0` for a valueless (implicit true) entry. */
export function parseConfigNullZ(buffer: Buffer): { entries: GitConfigEntry[]; malformed: boolean } {
  const { fields, tail } = splitNul(buffer)
  const entries: GitConfigEntry[] = []
  for (const field of fields) {
    const nl = field.indexOf(0x0a)
    const key = decodeGitPath(nl < 0 ? field : field.subarray(0, nl))
    if (key === null) return { entries, malformed: true }
    entries.push({ key, value: nl < 0 ? null : field.subarray(nl + 1).toString('utf8') })
  }
  return { entries, malformed: tail !== null }
}

export type GitIndexEntry = { mode: number | null; oid: string | null; stage: number | null; path: string | null; pathBytes: Buffer; lossy: boolean; malformed: boolean }

/** Parses `git ls-files -s -z` (`<mode> <oid> <stage>\t<path>\0`); index snapshots carry stage, blob, mode and path. */
export function parseLsFilesStageZ(buffer: Buffer, format: GitObjectFormat): GitIndexEntry[] {
  const { fields, tail } = splitNul(buffer)
  const out: GitIndexEntry[] = []
  const bad = (b: Uint8Array): GitIndexEntry => ({ mode: null, oid: null, stage: null, path: null, pathBytes: copy(b), lossy: true, malformed: true })
  for (const field of fields) {
    const tab = field.indexOf(0x09)
    const meta = tab < 0 ? '' : ascii(field.subarray(0, tab))
    const m = /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/.exec(meta)
    if (!m || !isGitOid(m[2], format) || tab + 1 >= field.length) { out.push(bad(field)); return out }
    const pathBytes = copy(field.subarray(tab + 1))
    const path = decodeGitPath(pathBytes)
    out.push({ mode: parseInt(m[1]!, 8), oid: m[2]!, stage: Number(m[3]), path, pathBytes, lossy: path === null, malformed: false })
  }
  if (tail) out.push(bad(tail))
  return out
}

export type GitTaggedPath = { tag: string; path: string | null; pathBytes: Buffer }

/**
 * Parses tagged `git ls-files -v -z` output (`<tag> <path>\0`). Tags: `H` cached, `S` skip-worktree, `M` unmerged, `C` changed
 * (with --modified), `R` removed, `K` to be killed, `?` other; a lowercase letter marks an assume-unchanged entry. With
 * `--cached --modified` a changed path is listed twice (`H`, then `C`). A record without `<tag><space><path>` ends the parse
 * as `malformed`.
 */
export function parseLsFilesTagsZ(buffer: Buffer): { entries: GitTaggedPath[]; malformed: boolean } {
  const { fields, tail } = splitNul(buffer)
  const entries: GitTaggedPath[] = []
  for (const field of fields) {
    const tag = field.length > 2 && field[1] === 0x20 ? String.fromCharCode(field[0]!) : ''
    if (!/^[A-Za-z?]$/.test(tag)) return { entries, malformed: true }
    const pathBytes = copy(field.subarray(2))
    entries.push({ tag, path: decodeGitPath(pathBytes), pathBytes })
  }
  return { entries, malformed: tail !== null }
}

export type GitTreeEntry = { mode: number | null; type: string | null; oid: string | null; size: number | null; path: string | null; pathBytes: Buffer; lossy: boolean; malformed: boolean }

/** Parses `git ls-tree -r -z --long` (`<mode> <type> <oid> <size>\t<path>\0`; size is '-' for non-blobs, space-padded). */
export function parseLsTreeLongZ(buffer: Buffer, format: GitObjectFormat): GitTreeEntry[] {
  const { fields, tail } = splitNul(buffer)
  const out: GitTreeEntry[] = []
  const bad = (b: Uint8Array): GitTreeEntry => ({ mode: null, type: null, oid: null, size: null, path: null, pathBytes: copy(b), lossy: true, malformed: true })
  for (const field of fields) {
    const tab = field.indexOf(0x09)
    const meta = tab < 0 ? '' : ascii(field.subarray(0, tab))
    const m = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+) +(-|\d+)$/.exec(meta)
    if (!m || !isGitOid(m[3], format) || tab + 1 >= field.length) { out.push(bad(field)); return out }
    const pathBytes = copy(field.subarray(tab + 1))
    const path = decodeGitPath(pathBytes)
    out.push({ mode: parseInt(m[1]!, 8), type: m[2]!, oid: m[3]!, size: m[4] === '-' ? null : Number(m[4]), path, pathBytes, lossy: path === null, malformed: false })
  }
  if (tail) out.push(bad(tail))
  return out
}

// ------------------------------------------------------------------------------------------------------------- check-attr

export type GitAttributeRecord = { path: string | null; pathBytes: Buffer; attribute: string; value: string }

/**
 * Parses `git check-attr -z` output: `<path>\0<attribute>\0<value>\0` per path and attribute, in input order. The value is the
 * attribute's string value or one of Git's words `unspecified`, `unset`, `set`. A record cut short or an unterminated tail is
 * `malformed` (the records before it are returned).
 */
export function parseCheckAttrZ(buffer: Buffer): { records: GitAttributeRecord[]; malformed: boolean } {
  const { fields, tail } = splitNul(buffer)
  const records: GitAttributeRecord[] = []
  const whole = fields.length - (fields.length % 3)
  for (let i = 0; i < whole; i += 3) {
    const pathBytes = copy(fields[i]!)
    records.push({ path: decodeGitPath(pathBytes), pathBytes, attribute: fields[i + 1]!.toString('utf8'), value: fields[i + 2]!.toString('utf8') })
  }
  return { records, malformed: tail !== null || whole !== fields.length }
}

// -------------------------------------------------------------------------------------------------------------- cat-file

export type GitBatchCheckRecord = { name: string; state: 'present'; oid: string; type: string; size: number } | { name: string; state: 'missing' | 'ambiguous' }

/**
 * Parses default-format `git cat-file --batch-check` output (`<oid> <type> <size>` or `<name> missing|ambiguous`), one line per
 * input line, in input order. A final line without its newline is incomplete and is not returned.
 */
export function parseBatchCheck(buffer: Buffer, format: GitObjectFormat): { records: GitBatchCheckRecord[]; malformed: boolean } {
  const text = buffer.toString('latin1')
  const lines = text.split('\n')
  const complete = lines.slice(0, -1)
  const records: GitBatchCheckRecord[] = []
  for (const line of complete) {
    const missing = /^(\S+) (missing|ambiguous)$/.exec(line)
    if (missing) { records.push({ name: missing[1]!, state: missing[2] as 'missing' | 'ambiguous' }); continue }
    const m = /^([0-9a-f]+) (\S+) (\d+)$/.exec(line)
    if (!m || !isGitOid(m[1], format)) return { records, malformed: true }
    records.push({ name: m[1]!, state: 'present', oid: m[1]!, type: m[2]!, size: Number(m[3]) })
  }
  return { records, malformed: false }
}

/**
 * Parses `git cat-file --batch` output: `<oid> <type> <size>\n<content>\n` or `<name> missing\n`, binary-safe by size. Contents are
 * returned only so the caller can inspect a small prefix (LFS pointer detection); they must never be logged or forwarded.
 */
export function parseBatchContents(buffer: Buffer, format: GitObjectFormat): { objects: Array<{ name: string; type: string | null; content: Buffer | null }>; complete: boolean } {
  const objects: Array<{ name: string; type: string | null; content: Buffer | null }> = []
  let at = 0
  while (at < buffer.length) {
    const nl = buffer.indexOf(0x0a, at)
    if (nl < 0) return { objects, complete: false }
    const header = buffer.subarray(at, nl).toString('latin1')
    const missing = /^(\S+) (missing|ambiguous)$/.exec(header)
    if (missing) { objects.push({ name: missing[1]!, type: null, content: null }); at = nl + 1; continue }
    const m = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header)
    if (!m || !isGitOid(m[1], format)) return { objects, complete: false }
    const size = Number(m[3])
    const end = nl + 1 + size
    if (end + 1 > buffer.length || buffer[end] !== 0x0a) return { objects, complete: false }
    objects.push({ name: m[1]!, type: m[2]!, content: buffer.subarray(nl + 1, end) })
    at = end + 1
  }
  return { objects, complete: true }
}

/** Git LFS pointer files are small (under 1024 bytes) and begin with the spec version line. */
export const GIT_LFS_POINTER_MAX_BYTES = 1023
const LFS_PREFIX = Buffer.from('version https://git-lfs.github.com/spec/')

export function isGitLfsPointer(content: Uint8Array): boolean {
  return content.length <= GIT_LFS_POINTER_MAX_BYTES && content.length >= LFS_PREFIX.length && LFS_PREFIX.equals(content.subarray(0, LFS_PREFIX.length))
}
