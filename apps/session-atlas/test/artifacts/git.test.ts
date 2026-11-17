import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir } from '../helpers/tmp.ts'
import { assertPortablePath, twoLaunchFixture } from '../helpers/portable-paths.ts'
import {
  ARTIFACT_GIT_ALLOWED_SUBCOMMANDS, ARTIFACT_GIT_OPTION_POLICY, ARTIFACT_GIT_REFUSED_ARG_PREFIXES, DEFAULT_GIT_LIMITS, GitAdapterError,
  PATHSPEC_ARGV_CHUNK_BYTES, artifactGitSpawnCount, listGitWorktrees, listTrackedDocumentStates, readBlobMetadata, readDocumentHistory, resolveGitCheckout, resolveGitFilterApplication, resolveTrackedDocumentFilters,
  runArtifactGit, type GitCheckout, type GitHistoryPage, type GitLimits,
} from '../../src/artifacts/git.ts'
import {
  decodeGitPath, parseAtlasSessionTrailers, parseCheckAttrZ, parseGitLogZ, parseLsFilesStageZ, parseLsFilesTagsZ, parseNameStatusZ, parsePorcelainV1Z, sanitizeRemoteUrl,
  type GitChange, type GitStatusEntry,
} from '../../src/artifacts/git-parser.ts'

// Every repository here is a temporary fixture. This process's own Git environment is isolated first: a temporary HOME, no
// system config, an empty global config and no inherited GIT_* variables, so fixture commands never read or write the real
// home. Fixture commands carry their identity with -c; the adapter under test builds its own environment regardless.

for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const FIXTURE_HOME = realpathSync(tempDir('atlas-git-home-'))
process.env.HOME = FIXTURE_HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
delete process.env.XDG_CONFIG_HOME

const LIMITS: GitLimits = DEFAULT_GIT_LIMITS
const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'
const SID2 = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678'
const IDENTITY = ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false']

function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): Buffer {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd, env: { ...process.env, ...opts.env }, input: opts.input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
}
const gitText = (cwd: string, args: string[]): string => git(cwd, args).toString('utf8').replace(/\n$/, '')

function newRepo(opts: { objectFormat?: 'sha256'; name?: string } = {}): string {
  const parent = realpathSync(tempDir('atlas-git-'))
  const path = join(parent, opts.name ?? 'repo')
  git(parent, ['init', '-q', ...(opts.objectFormat ? [`--object-format=${opts.objectFormat}`] : []), path])
  return path
}

function put(root: string, rel: string | Buffer, content: string | Buffer = 'x\n'): void {
  const full = typeof rel === 'string' ? join(root, rel) : Buffer.concat([Buffer.from(root + '/'), rel])
  if (typeof rel === 'string') mkdirSync(dirname(full as string), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(repo: string, message: string, env: Record<string, string> = {}): string {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '--allow-empty', '-F', '-'], { input: message, env })
  return gitText(repo, ['rev-parse', 'HEAD'])
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A helper script that records its execution in `markers/<label>` and then behaves as `tail` says. */
function marker(dir: string, markers: string, label: string, tail = 'exit 0'): string {
  const path = join(dir, `helper-${label}.sh`)
  writeFileSync(path, `#!/bin/sh\ntouch ${shSingleQuote(join(markers, label))}\n${tail}\n`)
  chmodSync(path, 0o755)
  return path
}

const markersIn = (dir: string): string[] => readdirSync(dir).sort()

// FIFOs used to stall Git. If a test hangs or this process is killed, a Git child blocked opening one for reading would outlive
// it (the adapter runs Git in its own process group); opening the FIFO for writing hands such a reader EOF so it exits.
const FIFOS = new Set<string>()
function makeFifo(prefix: string): string {
  const fifo = join(realpathSync(tempDir(prefix)), 'blocks')
  execFileSync('mkfifo', [fifo])
  FIFOS.add(fifo)
  return fifo
}
function releaseFifo(fifo: string): void {
  try { closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)) } catch { /* no reader is waiting */ }
}
process.on('exit', () => { for (const fifo of FIFOS) releaseFifo(fifo) })
process.once('SIGTERM', () => { for (const fifo of FIFOS) releaseFifo(fifo); process.exit(143) })
const STALL_TEST_TIMEOUT_MS = 60_000

async function drainHistory(repo: GitCheckout, cursor: string | null, limits: GitLimits = LIMITS, options = {}, maxPages = 200): Promise<{ pages: GitHistoryPage[]; changes: GitChange[]; cursor: string | null }> {
  const pages: GitHistoryPage[] = []
  let next = cursor
  for (let i = 0; i < maxPages; i++) {
    const page = await readDocumentHistory(repo, next, limits, options)
    pages.push(page)
    next = page.cursor
    if (!page.hasMore) break
  }
  assert.ok(pages.length < maxPages, 'history paging terminates')
  return { pages, changes: pages.flatMap(p => p.changes), cursor: next }
}

function byPath<T extends { path: string | null }>(entries: T[]): Map<string, T> {
  return new Map(entries.filter(e => e.path !== null).map(e => [e.path as string, e]))
}

function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else out.set(full.slice(root.length), `${st.size}:${st.mtimeMs}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    }
  }
  walk(root)
  return out
}

function invalidUtf8NamesSupported(dir: string): boolean {
  const probe = Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x70, 0x72, 0x6f, 0x62, 0x65, 0xff])])
  try {
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function sha256Supported(): boolean {
  try {
    const parent = realpathSync(tempDir('atlas-git-sha256-probe-'))
    git(parent, ['init', '-q', '--object-format=sha256', join(parent, 'r')])
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------------------------------------------------ pure parsers

test('decodeGitPath keeps only lossless UTF-8: invalid bytes, surrogates and overlongs are refused; BOM and U+FFFD survive', () => {
  assert.equal(decodeGitPath(Buffer.from('docs/é 文書 🎉.md')), 'docs/é 文書 🎉.md')
  assert.equal(decodeGitPath(Buffer.from([0x66, 0xff, 0x2e, 0x6d, 0x64])), null, 'invalid byte')
  assert.equal(decodeGitPath(Buffer.from([0xed, 0xa0, 0x80, 0x2e, 0x6d, 0x64])), null, 'CESU-8 lone surrogate')
  assert.equal(decodeGitPath(Buffer.from([0xc0, 0xaf, 0x78])), null, 'overlong encoding')
  assert.equal(decodeGitPath(Buffer.from([0xe2, 0x82])), null, 'truncated sequence')
  assert.equal(decodeGitPath(Buffer.alloc(0)), null, 'empty path')
  assert.equal(decodeGitPath(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), '﻿a', 'leading BOM is part of the name, not stripped')
  assert.equal(decodeGitPath(Buffer.from('real�.md')), 'real�.md', 'a genuine U+FFFD is lossless')
})

test('parsePorcelainV1Z: staged, unstaged, conflicts, untracked, ignored and rename pairs without line splitting', () => {
  const rec = (s: string | Buffer): Buffer => Buffer.concat([typeof s === 'string' ? Buffer.from(s) : s, Buffer.from([0])])
  const buf = Buffer.concat([
    rec('M  staged.md'), rec(' M unstaged.md'), rec('MM both.md'), rec('A  added.md'), rec('D  gone.md'), rec(' D wt-gone.md'),
    rec('R  new\nname.md'), rec('old\tname.md'), rec('C  copy.md'), rec('src.md'), rec(' R wt-renamed.md'), rec('wt-orig.md'),
    rec('UU conflict.md'), rec('AA both-added.md'), rec('DU del-them.md'), rec('?? -c.md'), rec('?? :(exclude)x.md'),
    rec('?? "quoted" name.md'), rec('!! ignored.log'), rec('T  type.md'), rec(Buffer.concat([Buffer.from('?? bad'), Buffer.from([0xff])])),
  ])
  const entries = parsePorcelainV1Z(buf)
  assert.equal(entries.length, 18)
  const m = byPath(entries)
  assert.deepEqual([m.get('staged.md')!.kind, m.get('staged.md')!.staged, m.get('staged.md')!.unstaged], ['ordinary', true, false])
  assert.deepEqual([m.get('unstaged.md')!.staged, m.get('unstaged.md')!.unstaged], [false, true])
  assert.deepEqual([m.get('both.md')!.staged, m.get('both.md')!.unstaged], [true, true])
  assert.equal(m.get('added.md')!.x, 'A')
  assert.equal(m.get('gone.md')!.x, 'D')
  assert.equal(m.get('wt-gone.md')!.y, 'D')
  const renamed = m.get('new\nname.md')!
  assert.equal(renamed.kind, 'renamed')
  assert.equal(renamed.origPath, 'old\tname.md', 'porcelain -z prints the destination first, then the source')
  assert.deepEqual([m.get('copy.md')!.kind, m.get('copy.md')!.origPath], ['copied', 'src.md'])
  assert.deepEqual([m.get('wt-renamed.md')!.kind, m.get('wt-renamed.md')!.origPath], ['renamed', 'wt-orig.md'])
  for (const p of ['conflict.md', 'both-added.md', 'del-them.md']) {
    assert.equal(m.get(p)!.kind, 'unmerged')
    assert.equal(m.get(p)!.conflict, true)
  }
  assert.equal(m.get('-c.md')!.kind, 'untracked')
  assert.equal(m.get(':(exclude)x.md')!.kind, 'untracked')
  assert.equal(m.get('"quoted" name.md')!.kind, 'untracked')
  assert.equal(m.get('ignored.log')!.kind, 'ignored')
  assert.equal(m.get('type.md')!.x, 'T')
  const lossy = entries.find(e => e.lossy)!
  assert.equal(lossy.path, null)
  assert.equal(lossy.kind, 'untracked')
  assert.deepEqual(lossy.pathBytes, Buffer.from([0x62, 0x61, 0x64, 0xff]))
})

test('parsePorcelainV1Z reports malformed and truncated records instead of dropping them, and skips a branch header', () => {
  assert.deepEqual(parsePorcelainV1Z(Buffer.alloc(0)), [])
  const header = parsePorcelainV1Z(Buffer.from('## main...origin/main\0?? a.md\0'))
  assert.deepEqual(header.map(e => [e.kind, e.path]), [['untracked', 'a.md']])
  const truncated = parsePorcelainV1Z(Buffer.from('?? a.md\0?? b.m'))
  assert.equal(truncated.length, 2)
  assert.equal(truncated[1]!.kind, 'malformed')
  assert.equal(truncated[1]!.lossy, true)
  const splitPair = parsePorcelainV1Z(Buffer.from('R  new.md\0'))
  assert.equal(splitPair.at(-1)!.kind, 'malformed', 'a rename whose source field is missing is not a plain entry')
  const garbage = parsePorcelainV1Z(Buffer.from('?? ok.md\0XY nope\0?? later.md\0'))
  assert.deepEqual(garbage.map(e => e.kind), ['untracked', 'malformed'], 'parsing stops at the first malformed record')
})

test('parseNameStatusZ reconstructs rename and copy pairs (source, destination) and keeps scores', () => {
  const buf = Buffer.from('M\0a.md\0A\0new\nline.md\0D\0gone.md\0R100\0old name.md\0new name.md\0C075\0src.md\0dst.md\0T\0link.md\0MM\0merged.md\0')
  const changes = parseNameStatusZ(buf)
  assert.deepEqual(changes.map(c => [c.status, c.oldPath, c.path, c.score]), [
    ['M', null, 'a.md', null], ['A', null, 'new\nline.md', null], ['D', null, 'gone.md', null],
    ['R', 'old name.md', 'new name.md', 100], ['C', 'src.md', 'dst.md', 75], ['T', null, 'link.md', null], ['M', null, 'merged.md', null],
  ])
  assert.equal(changes.at(-1)!.rawStatus, 'MM')
  assert.ok(changes.every(c => !c.lossy && c.commit === null && c.blobOid === null))
  const lossy = parseNameStatusZ(Buffer.concat([Buffer.from('A\0'), Buffer.from([0x78, 0xfe]), Buffer.from('\0')]))
  assert.deepEqual([lossy[0]!.lossy, lossy[0]!.path], [true, null])
  const truncated = parseNameStatusZ(Buffer.from('R100\0only-source.md\0'))
  assert.equal(truncated.at(-1)!.status, 'malformed')
  assert.equal(parseNameStatusZ(Buffer.from('Q\0x.md\0'))[0]!.status, 'malformed')
})

test('parseLsFilesStageZ reads mode, OID, stage and path from ls-files -s -z', () => {
  const oid = 'a'.repeat(40)
  const entries = parseLsFilesStageZ(Buffer.from(`100644 ${oid} 0\tplain.md\x00100755 ${oid} 2\tnew\nline.md\x00`), 'sha1')
  assert.deepEqual(entries.map(e => [e.mode, e.oid, e.stage, e.path]), [[0o100644, oid, 0, 'plain.md'], [0o100755, oid, 2, 'new\nline.md']])
  assert.equal(parseLsFilesStageZ(Buffer.from(`100644 ${'a'.repeat(64)} 0\tx.md\0`), 'sha1')[0]!.malformed, true, 'OID length must match the object format')
})

test('parseLsFilesTagsZ reads tagged index records NUL-safely and stops at a malformed one', () => {
  const out = parseLsFilesTagsZ(Buffer.from('H docs/a.md\0C docs/a.md\0h hidden.md\0S skip.md\0M x.md\0H new\nline.md\0'))
  assert.equal(out.malformed, false)
  assert.deepEqual(out.entries.map(e => [e.tag, e.path]), [['H', 'docs/a.md'], ['C', 'docs/a.md'], ['h', 'hidden.md'], ['S', 'skip.md'], ['M', 'x.md'], ['H', 'new\nline.md']])
  assert.equal(parseLsFilesTagsZ(Buffer.from('H a.md\0Hb.md\0')).malformed, true, 'no separator')
  assert.equal(parseLsFilesTagsZ(Buffer.from('H a.md\0H b.m')).malformed, true, 'unterminated tail')
  assert.deepEqual(parseLsFilesTagsZ(Buffer.concat([Buffer.from('H '), Buffer.from([0x78, 0xff]), Buffer.from('\0')])).entries.map(e => e.path), [null])
})

test('parseAtlasSessionTrailers reads only Atlas-Session UUID trailers from the final trailer block', () => {
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nBody text.\n\nAtlas-Session: ${SID}\n`), [SID])
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\natlas-session : ${SID2}\nCo-Authored-By: X <x@e>\n`), [SID2.toLowerCase()], 'key is case-insensitive, value lowercased')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nAtlas-Session: ${SID}\nAtlas-Session: ${SID}\nAtlas-Session: ${SID2}\n`), [SID, SID2.toLowerCase()].sort())
  assert.deepEqual(parseAtlasSessionTrailers(`Atlas-Session: ${SID}\n`), [], 'the title paragraph is never a trailer block')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nAtlas-Session: ${SID}\n\nMore prose after it.\n`), [], 'a body line that merely looks like a trailer')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nsee notes\nAtlas-Session: ${SID}\n`), [], 'a mixed prose/trailer paragraph is not a trailer block')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nClaude-Session: https://claude.ai/code/session_abc\nX-Session: ${SID}\n`), [], 'other trailers are ignored')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nAtlas-Session: not-a-uuid\nAtlas-Session: ${SID}x\nAtlas-Session: {${SID}}\n`), [], 'malformed values are ignored')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\n\nAtlas-Session: ${SID.slice(0, 20)}\n ${SID.slice(20)}\n`), [], 'a folded value is not a UUID')
  assert.deepEqual(parseAtlasSessionTrailers(`Add doc\r\n\r\nAtlas-Session: ${SID}  \r\n\r\n`), [SID], 'CRLF and trailing blank lines')
})

test('parseGitLogZ is unambiguous when commit messages contain record markers, colons and fake raw lines', () => {
  const oid = 'b'.repeat(40)
  const parent = 'c'.repeat(40)
  const blob = 'd'.repeat(40)
  const zero = '0'.repeat(40)
  const msg = `tricky\n\n@E\n@H\n:100644 100644 ${zero} ${zero} M\n\nAtlas-Session: ${SID}\n`
  const buf = Buffer.concat([
    Buffer.from(`@H\x00${oid}\x00${parent}\x00100\x00090\x00${msg}\x00@E\x00\n:000000 100644 ${zero} ${blob} A\x00@H\x00:100644 100644 ${blob} ${blob} R100\x00a\nb.md\x00c.md\x00`),
    Buffer.from(`@H\x00${parent}\x00\x00050\x00040\x00root\n\x00@E\x00`),
  ])
  const parsed = parseGitLogZ(buf, 'sha1')
  assert.equal(parsed.malformed, false)
  assert.equal(parsed.partial, false)
  assert.deepEqual(parsed.commits.map(c => c.oid), [oid, parent])
  const first = parsed.commits[0]!
  assert.deepEqual(first.parents, [parent])
  assert.deepEqual([first.committedAt, first.authoredAt], [100, 90])
  assert.deepEqual(first.atlasSessionIds, [SID])
  assert.deepEqual(first.changes.map(c => [c.status, c.oldPath, c.path, c.blobOid]), [['A', null, '@H', blob], ['R', 'a\nb.md', 'c.md', blob]])
  assert.equal(first.changes[0]!.mode, 0o100644)
  assert.deepEqual(parsed.commits[1]!.parents, [])
  const cut = parseGitLogZ(buf.subarray(0, buf.length - 10), 'sha1')
  assert.equal(cut.partial, true)
  assert.equal(parseGitLogZ(Buffer.from(`@H\x00${'e'.repeat(64)}\x00\x00001\x00001\x00m\x00@E\x00`), 'sha1').malformed, true, 'OID length is checked against the format')
})

test('sanitizeRemoteUrl strips credentials, query and fragment from https, ssh and scp-like remotes', () => {
  assert.equal(sanitizeRemoteUrl('https://user:token@host/org/repo.git?x=1#f'), 'https://host/org/repo.git')
  assert.equal(sanitizeRemoteUrl('https://x-access-token:ghp_SECRET@github.com/o/r.git'), 'https://github.com/o/r.git')
  assert.equal(sanitizeRemoteUrl('https://ghp_SECRET@github.com/o/r'), 'https://github.com/o/r')
  assert.equal(sanitizeRemoteUrl('https://host:8443/o/r.git?token=SECRET'), 'https://host:8443/o/r.git')
  assert.equal(sanitizeRemoteUrl('ssh://git@host:2222/o/r.git'), 'ssh://host:2222/o/r.git')
  assert.equal(sanitizeRemoteUrl('git@github.com:org/repo.git'), 'github.com:org/repo.git')
  assert.equal(sanitizeRemoteUrl('deploy:SECRET@host:org/repo.git'), 'host:org/repo.git')
  assert.equal(sanitizeRemoteUrl('host:org/repo@v2.git'), 'host:org/repo@v2.git')
  assert.equal(sanitizeRemoteUrl('https://user:pa/ss@host/repo.git'), 'https://host/repo.git', 'a password containing a slash')
  assert.equal(sanitizeRemoteUrl('/srv/git/repo.git'), '/srv/git/repo.git')
  assert.equal(sanitizeRemoteUrl('file:///srv/git/repo.git'), 'file:///srv/git/repo.git')
  assert.equal(sanitizeRemoteUrl('https://host/r\n.git'), null, 'control characters are not displayable')
  assert.equal(sanitizeRemoteUrl(''), null)
  for (const raw of ['https://u:SECRET@h/x', 'git+ssh://u:SECRET@h/x', 'u:SECRET@h:x', 'https://h/x?SECRET', 'https://h/x#SECRET']) {
    assert.ok(!String(sanitizeRemoteUrl(raw)).includes('SECRET'), raw)
  }
})

// Final review: the query and fragment used to be cut before the userinfo was removed, so a token holding a raw `#` or `?` left
// its first part behind (`https://tok#en@host/r` became `https://tok`, stored as the repository's remote identity).
test('sanitizeRemoteUrl drops all userinfo up to the last @ of the authority, whatever raw characters it holds', () => {
  for (const [raw, expected] of [
    ['https://tok#en@host/r', 'https://host/r'],
    ['https://tok?en@host/r', 'https://host/r'],
    ['https://user:p#w?x@host:8443/r.git?z=1#f', 'https://host:8443/r.git'],
    ['ssh://tok#en@host/r', 'ssh://host/r'],
    ['https://tok#en@host', 'https://host'],
    ['tok#en@host:org/r.git', 'host:org/r.git'],
    ['us:p?w@host:org/r.git', 'host:org/r.git'],
    ['https://user:pa/s#s@host/r', 'https://host/r'],
    // An @ later in the path or in the query is not the end of the userinfo, and no longer hides the user in front of the host.
    ['https://SECRET@host/o/r@v2', 'https://host/o/r@v2'],
    ['https://host/o/r?e=a@b#f@g', 'https://host/o/r'],
    // Unchanged shapes.
    ['https://host/o/r.git', 'https://host/o/r.git'],
    ['git@github.com:org/repo.git', 'github.com:org/repo.git'],
    ['deploy:SECRET@host:org/repo.git', 'host:org/repo.git'],
    ['https://user:token@host/org/repo.git?x=1#f', 'https://host/org/repo.git'],
    ['/srv/git/repo.git', '/srv/git/repo.git'],
    ['host:org/repo@v2.git', 'host:org/repo@v2.git'],
  ] as const) {
    assert.equal(sanitizeRemoteUrl(raw), expected, raw)
  }
  assert.equal(sanitizeRemoteUrl(''), null)
  assert.equal(sanitizeRemoteUrl('https://'), null)
  assert.equal(sanitizeRemoteUrl('https://tok\n@host/r'), null)
  for (const raw of ['https://tok#en@host/r', 'https://SECRET@host/o/r@v2', 'https://user:p#SECRET@host/r', 'SECRET?x@host:o/r']) {
    assert.ok(!/tok|SECRET/.test(String(sanitizeRemoteUrl(raw))), raw)
  }
})

// ------------------------------------------------------------------------------------------------------- invocation policy

test('the read-only allowlist is exported and refuses everything else without spawning Git', async () => {
  assert.deepEqual([...ARTIFACT_GIT_ALLOWED_SUBCOMMANDS].sort(), [
    'cat-file', 'diff-tree', 'for-each-ref', 'log', 'ls-files', 'ls-tree', 'merge-base', 'rev-list', 'rev-parse', 'show-ref', 'status', 'symbolic-ref', 'worktree',
  ])
  const repo = newRepo()
  put(repo, 'a.md')
  const head = commitAll(repo, 'one')
  const outside = realpathSync(tempDir('atlas-git-out-'))
  const refused: string[][] = [
    [], ['show', 'HEAD'], ['fetch'], ['pull'], ['push'], ['clone', repo, join(outside, 'c')], ['commit', '--allow-empty', '-m', 'x'], ['add', '-A'],
    ['update-ref', 'refs/heads/evil', 'HEAD'], ['gc'], ['config', 'core.x', 'y'], ['checkout', '-b', 'x'], ['reset', '--hard'], ['clean', '-fdx'],
    ['submodule', 'update'], ['lfs', 'fetch'], ['grep', 'x'], ['difftool'], ['worktree', 'add', join(outside, 'wt')], ['worktree', 'remove', repo],
    ['worktree', 'prune'], ['worktree'], ['symbolic-ref', 'HEAD', 'refs/heads/evil'], ['symbolic-ref', '-d', 'HEAD'], ['symbolic-ref', '--delete', 'HEAD'],
    ['symbolic-ref', '-qd', 'HEAD'], ['log', `--output=${join(outside, 'leak')}`], ['log', '--upload-pack=x'], ['log', '--exec=x'], ['log', '-c'],
    ['log', '-ccore.fsmonitor=x'], ['log', '--config-env=core.pager=X'], ['rev-parse', '--git-dir'], ['status', `--work-tree=${outside}`],
    ['log', '--git-dir=/tmp'], ['log', '--textconv'], ['log', '--ext-diff'], ['log', '--show-signature'], ['log', '--format=%G?'], ['log', '--pretty=format:%GS'],
    ['for-each-ref', '--format=%(signature)'], ['log', '--remerge-diff'], ['log', '--diff-merges=remerge'], ['log', '--diff-merges=r'],
    ['cat-file', '--filters', `${head}:a.md`], ['cat-file', '--textconv', `${head}:a.md`], ['cat-file', '--path=a.md', '--batch'],
    ['ls-files', '--recurse-submodules'], ['status', '-v'], ['status', '--verbose'], ['status', '-sv'], ['status', '--ignore-submodules=none'],
    ['log', 'HEAD\0evil'], ['rev-list', '--alternate-refs', 'HEAD'], ['log', '--alternate-refs'],
  ]
  const before = artifactGitSpawnCount()
  for (const args of refused) {
    const r = await runArtifactGit(repo, args, LIMITS)
    assert.match(String(r.error), /^refused-/, `refused: ${JSON.stringify(args)}`)
    assert.equal(r.exitCode, null)
    assert.equal(r.stdout.length, 0)
    assert.equal(r.incomplete, true)
  }
  for (const [args, input] of [[['rev-list', '--stdin'], '--alternate-refs\n'], [['log', '--stdin'], `${head}\n--all\n`], [['diff-tree', '--stdin'], '-p\n']] as const) {
    const r = await runArtifactGit(repo, [...args], LIMITS, { input: Buffer.from(input) })
    assert.equal(r.error, 'refused-input', `stdin pseudo-options refused for ${args[0]}`)
  }
  assert.equal(artifactGitSpawnCount(), before, 'no refused command spawned a process')
  assert.equal(gitText(repo, ['rev-parse', 'HEAD']), head, 'HEAD unchanged')
  assert.equal(gitText(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main')
  assert.throws(() => git(repo, ['rev-parse', '--verify', '-q', 'refs/heads/evil']), 'no ref was created')
  assert.equal(existsSync(join(outside, 'leak')), false)
  assert.equal((await runArtifactGit('relative/path', ['status'], LIMITS)).error, 'refused-repo-path')
  assert.equal((await runArtifactGit(repo, ['status'], { timeoutMs: 0, maxOutputBytes: 10 })).error, 'refused-limits')
  assert.equal((await runArtifactGit(repo, ['status'], { timeoutMs: 1000, maxOutputBytes: Number.NaN })).error, 'refused-limits')
})

test('every subcommand has an exact option allowlist; no allowed option begins with a refused prefix', () => {
  assert.deepEqual(Object.keys(ARTIFACT_GIT_OPTION_POLICY).sort(), [...ARTIFACT_GIT_ALLOWED_SUBCOMMANDS].sort())
  for (const [sub, policy] of Object.entries(ARTIFACT_GIT_OPTION_POLICY)) {
    for (const opt of [...policy.exact, ...Object.keys(policy.valued)]) {
      assert.ok(opt.startsWith('-'), `${sub} ${opt}`)
      assert.ok(!ARTIFACT_GIT_REFUSED_ARG_PREFIXES.some(p => opt.startsWith(p)), `${sub} ${opt} collides with a refused prefix`)
    }
    for (const key of Object.keys(policy.valued)) assert.ok(key.startsWith('--') && key.endsWith('='), `${sub} ${key}`)
    for (const ch of [...policy.shorts, ...Object.keys(policy.shortValued)]) assert.match(ch, /^[A-Za-z]$/, `${sub} -${ch}`)
    assert.ok(!policy.shorts.includes('c'), `${sub}: -c stays refused`)
  }
})

test('abbreviated and unlisted options are refused before spawn: no helper runs and no ref is written', async () => {
  const sub = newRepo({ name: 'sub' })
  put(sub, 'inner.md', 'inner\n'); commitAll(sub, 'inner')
  const repo = newRepo()
  put(repo, 'a.md', 'doc a\n'); put(repo, '.gitattributes', '*.md filter=evil diff=evil\n')
  commitAll(repo, 'one')
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'modules/sub'])
  commitAll(repo, 'sub')
  put(join(repo, 'modules', 'sub'), '.gitattributes', '*.md filter=subevil\n')
  git(join(repo, 'modules', 'sub'), ['add', '.gitattributes']); git(join(repo, 'modules', 'sub'), ['commit', '-q', '-m', 'attrs'])
  git(repo, ['add', 'modules/sub']); git(repo, ['commit', '-q', '-m', 'bump'])
  git(repo, ['symbolic-ref', 'refs/heads/symref', 'refs/heads/main'])
  const scratch = realpathSync(tempDir('atlas-git-abbrev-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  const subGitDir = join(repo, '.git', 'modules', 'modules', 'sub')
  writeFileSync(join(subGitDir, 'config'), readFileSync(join(subGitDir, 'config'), 'utf8') + `[filter "subevil"]\n\tclean = ${marker(scratch, markers, 'sub-clean', 'exec cat')}\n`)
  writeFileSync(join(repo, '.git', 'config'), readFileSync(join(repo, '.git', 'config'), 'utf8')
    + `[filter "evil"]\n\tclean = ${marker(scratch, markers, 'clean', 'exec cat')}\n\tsmudge = ${marker(scratch, markers, 'smudge', 'exec cat')}\n`
    + `[diff "evil"]\n\ttextconv = ${marker(scratch, markers, 'textconv', 'cat "$1"')}\n\tcommand = ${marker(scratch, markers, 'diff-command')}\n`)
  const later = new Date(Date.now() + 10_000)
  utimesSync(join(repo, 'modules', 'sub', 'inner.md'), later, later)
  utimesSync(join(repo, 'a.md'), later, later)
  await runArtifactGit(repo, ['rev-parse', 'HEAD'], LIMITS) // warm the one-time Git version probe
  const cases: string[][] = [
    ['cat-file', '--filt', 'HEAD:a.md'], ['cat-file', '--filte', 'HEAD:a.md'], ['cat-file', '--tex', 'HEAD:a.md'], ['cat-file', '--textco', 'HEAD:a.md'],
    ['cat-file', '--batch', '--filt'], ['cat-file', '--pat=a.md', '--batch'], ['status', '--porcelain', '--ignore-s=none'],
    ['status', '--porcelain', '--ignore-submodules=none'], ['status', '--verb'], ['status', '--porc'], ['status', '-v'], ['status', '-zv'],
    ['ls-files', '--recurse', '-z'], ['ls-files', '--recurse-submodules', '-z'], ['ls-files', '-zc'], ['symbolic-ref', '--del', 'refs/heads/symref'],
    ['symbolic-ref', '--d', 'refs/heads/symref'], ['symbolic-ref', '-d', 'refs/heads/symref'], ['log', '--textc', '-p', '-n1'], ['log', '--ext', '-p', '-n1'],
    ['log', `--outp=${join(scratch, 'leak')}`, '-n1'], ['log', '-5'], ['log', '-n'], ['log', '--format', '%H'], ['diff-tree', '--textc', '-p', 'HEAD~2', 'HEAD'],
    ['rev-parse', '--git-d'], ['for-each-ref', '--contains', 'HEAD'], ['worktree', 'list', 'extra'], ['show-ref', '--exclude-existing'], ['ls-files', '-'],
  ]
  const before = artifactGitSpawnCount()
  for (const args of cases) {
    const r = await runArtifactGit(repo, args, LIMITS)
    assert.match(String(r.error), /^refused-/, `refused before spawn: ${args.join(' ')}`)
  }
  assert.equal(artifactGitSpawnCount(), before, 'nothing was spawned')
  // R23: ls-files -v / -t show assume-unchanged and skip-worktree state (status hides edits to such files).
  git(repo, ['update-index', '--assume-unchanged', 'a.md'])
  const tagsBefore = artifactGitSpawnCount()
  const tagged = await runArtifactGit(repo, ['ls-files', '-v', '-z'], LIMITS)
  assert.equal(tagged.error, null)
  assert.equal(artifactGitSpawnCount() - tagsBefore, 2, 'one config read and one ls-files')
  assert.ok(tagged.stdout.toString('utf8').split('\0').includes('h a.md'), 'assume-unchanged is shown with a lowercase tag')
  assert.equal((await runArtifactGit(repo, ['ls-files', '--v'], LIMITS)).error, 'refused-argument', 'no long or abbreviated form')
  assert.deepEqual(markersIn(markers), [], 'no smudge, textconv or submodule clean helper ran')
  assert.equal(gitText(repo, ['symbolic-ref', 'refs/heads/symref']), 'refs/heads/main', 'the symbolic ref still exists')
  assert.equal(existsSync(join(scratch, 'leak')), false)
  // The full, listed forms still work, and cat-file runs with filter and diff drivers blanked.
  for (const args of [['cat-file', '-p', 'HEAD:a.md'], ['cat-file', 'blob', 'HEAD:a.md'], ['status', '--porcelain=v1', '-z'], ['ls-files', '-sz'],
    ['ls-files', '-v', '-z'], ['ls-files', '-t', '-z'], ['ls-files', '-tvz'],
    ['log', '-n2', '--format=%H'], ['log', '--max-count=1', '-M50%', '--raw', '-z'], ['status', '-uall', '-z'], ['symbolic-ref', '-q', 'refs/heads/symref'],
    ['for-each-ref', '--contains=HEAD', '--format=%(refname)'], ['rev-list', '-n1', 'HEAD'], ['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', 'HEAD']]) {
    const r = await runArtifactGit(repo, args, LIMITS)
    assert.equal(r.error, null, `${args.join(' ')}: ${r.error} ${r.stderr}`)
  }
  assert.equal((await runArtifactGit(repo, ['cat-file', 'blob', 'HEAD:a.md'], LIMITS)).filterState, 'unresolved')
  assert.deepEqual(markersIn(markers), [])
})

test('options after -- are paths: literal pathspecs, leading dashes and pathspec-magic-looking names round-trip', async () => {
  const repo = newRepo()
  const names = ['a.md', '*.md', '-c.md', '--output=x.md', ':(exclude)a.md', 'sub/./dot.md', ' lead space.md']
  for (const n of names) put(repo, n)
  commitAll(repo, 'names')
  const run = async (...paths: string[]): Promise<string[]> => {
    const r = await runArtifactGit(repo, ['ls-files', '-z', '--', ...paths], LIMITS)
    assert.equal(r.error, null)
    return r.stdout.toString('utf8').split('\0').filter(Boolean).sort()
  }
  assert.deepEqual(await run('*.md'), ['*.md'], 'a glob character is literal')
  assert.deepEqual(await run(':(exclude)a.md'), [':(exclude)a.md'], 'pathspec magic is literal')
  assert.deepEqual(await run('-c.md', '--output=x.md'), ['--output=x.md', '-c.md'])
  assert.deepEqual(await run('sub'), ['sub/dot.md'])
  assert.deepEqual(await run(' lead space.md'), [' lead space.md'])
  assert.equal(existsSync(join(repo, 'x.md')), false)
})

test('status parsing on a real checkout: staged/unstaged/conflict/untracked, ignored omitted, odd names and rename pairs', async () => {
  const repo = newRepo()
  const tricky = ['new\nline.md', 'tab\there.md', '"quoted".md', '-dash.md', 'trailing space .md', 'é-文書-🎉.md', ':colon.md']
  put(repo, 'staged.md'); put(repo, 'unstaged.md'); put(repo, 'both.md'); put(repo, 'gone.md'); put(repo, 'wt-gone.md'); put(repo, 'old\nname.md', 'rename me\n')
  put(repo, 'conflict.md', 'base\n'); put(repo, '.gitignore', '*.log\nignored-dir/\n')
  commitAll(repo, 'base')
  git(repo, ['checkout', '-q', '-b', 'side'])
  put(repo, 'conflict.md', 'side\n'); put(repo, 'both-added.md', 'side\n')
  commitAll(repo, 'side')
  git(repo, ['checkout', '-q', 'main'])
  put(repo, 'conflict.md', 'main\n'); put(repo, 'both-added.md', 'main\n')
  commitAll(repo, 'main')
  try { git(repo, ['merge', '-q', 'side']) } catch { /* expected conflict */ }
  put(repo, 'staged.md', 'changed\n'); git(repo, ['add', 'staged.md'])
  put(repo, 'unstaged.md', 'changed\n')
  put(repo, 'both.md', 'one\n'); git(repo, ['add', 'both.md']); put(repo, 'both.md', 'two\n')
  git(repo, ['rm', '-q', 'gone.md'])
  rmSync(join(repo, 'wt-gone.md'))
  git(repo, ['mv', 'old\nname.md', 'new\tname.md'])
  for (const n of tricky) put(repo, n)
  put(repo, 'build.log'); put(repo, 'ignored-dir/x.md')
  put(repo, 'nested/deep/new.md')

  const r = await runArtifactGit(repo, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], LIMITS)
  assert.equal(r.error, null)
  assert.equal(r.filterState, 'none')
  const entries = parsePorcelainV1Z(r.stdout)
  assert.ok(entries.every(e => !e.lossy))
  const m = byPath(entries)
  assert.deepEqual([m.get('staged.md')!.x, m.get('staged.md')!.y], ['M', ' '])
  assert.deepEqual([m.get('unstaged.md')!.x, m.get('unstaged.md')!.y], [' ', 'M'])
  assert.deepEqual([m.get('both.md')!.x, m.get('both.md')!.y], ['M', 'M'])
  assert.equal(m.get('gone.md')!.x, 'D')
  assert.equal(m.get('wt-gone.md')!.y, 'D')
  assert.deepEqual([m.get('new\tname.md')!.kind, m.get('new\tname.md')!.origPath], ['renamed', 'old\nname.md'])
  assert.deepEqual([m.get('conflict.md')!.kind, m.get('conflict.md')!.x + m.get('conflict.md')!.y], ['unmerged', 'UU'])
  assert.deepEqual([m.get('both-added.md')!.kind, m.get('both-added.md')!.x + m.get('both-added.md')!.y], ['unmerged', 'AA'])
  for (const n of [...tricky, 'nested/deep/new.md']) assert.equal(m.get(n)?.kind, 'untracked', n)
  assert.equal(m.has('build.log'), false, 'ignored files are omitted')
  assert.equal(m.has('ignored-dir/x.md'), false)
  if (process.platform === 'linux') {
    put(repo, 'nfd-é.md')
    const again = byPath(parsePorcelainV1Z((await runArtifactGit(repo, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], LIMITS)).stdout))
    assert.equal(again.get('nfd-é.md')?.kind, 'untracked', 'NFD bytes are kept, not normalized')
  }
})

test('a filename that is not valid UTF-8 is reported lossy with its bytes, never dropped or decoded into an identity', async t => {
  const repo = newRepo()
  if (!invalidUtf8NamesSupported(repo)) return t.skip('filesystem rejects non-UTF-8 names')
  const raw = Buffer.from([0x72, 0x65, 0x70, 0x6f, 0x72, 0x74, 0xff, 0x2e, 0x6d, 0x64])
  put(repo, raw)
  put(repo, 'fine.md')
  const entries = parsePorcelainV1Z((await runArtifactGit(repo, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], LIMITS)).stdout)
  assert.equal(entries.length, 2)
  const lossy = entries.find(e => e.lossy)!
  assert.equal(lossy.path, null)
  assert.equal(lossy.kind, 'untracked')
  assert.deepEqual(lossy.pathBytes, raw)
  commitAll(repo, `add\n\nAtlas-Session: ${SID}\n`)
  const checkout = (await resolveGitCheckout(repo))!
  const { pages, changes } = await drainHistory(checkout, null)
  const bad = changes.find(c => c.lossy)!
  assert.ok(bad, 'the lossy committed path is present')
  assert.equal(bad.path, null)
  assert.deepEqual(bad.pathBytes, raw)
  assert.equal(pages.at(-1)!.complete, false, 'a lossy path keeps history incomplete')
  assert.ok(pages.at(-1)!.gaps.includes('lossy-path'))
})

test('Git runs with a sanitized environment: inherited GIT_* and helper variables are dropped and the repository is never written', async () => {
  const repo = newRepo()
  const other = newRepo({ name: 'other' })
  const scratch = realpathSync(tempDir('atlas-git-env-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  put(repo, 'mine.md'); commitAll(repo, 'mine')
  put(other, 'theirs.md'); commitAll(other, 'theirs')
  const evil = marker(scratch, markers, 'env-helper', 'exit 0')
  const saved = { ...process.env }
  // A stat-dirty but unchanged tracked file: plain `git status` would refresh and rewrite the index.
  utimesSync(join(repo, 'mine.md'), new Date(), new Date(Date.now() + 5000))
  const before = snapshotTree(join(repo, '.git'))
  try {
    Object.assign(process.env, {
      GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(scratch, 'index'), GIT_EXTERNAL_DIFF: evil, GIT_PAGER: evil,
      GIT_SSH_COMMAND: evil, GIT_PROXY_COMMAND: evil, GIT_ASKPASS: evil, GIT_EDITOR: evil, GIT_TRACE: join(scratch, 'trace'),
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${evil}'`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: evil,
      GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'), GIT_NAMESPACE: 'evil',
    })
    const status = await runArtifactGit(repo, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], LIMITS)
    assert.equal(status.error, null)
    assert.deepEqual(parsePorcelainV1Z(status.stdout), [], 'status is of the requested repository, not GIT_DIR/GIT_WORK_TREE')
    const files = await runArtifactGit(repo, ['ls-files', '-z'], LIMITS)
    assert.equal(files.stdout.toString(), 'mine.md\0')
    const log = await runArtifactGit(repo, ['log', '--raw', '-n1'], LIMITS)
    assert.equal(log.error, null)
    const checkout = await resolveGitCheckout(repo)
    assert.equal(checkout!.worktreePath, repo)
    await readDocumentHistory(checkout!, null, LIMITS)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
  assert.deepEqual(markersIn(markers), [], 'no inherited helper ran')
  assert.equal(existsSync(join(scratch, 'trace')), false, 'GIT_TRACE was not inherited')
  assert.deepEqual(snapshotTree(join(repo, '.git')), before, 'the .git directory (index included) is byte-for-byte unchanged')
})

test('repository-configured helpers, filters, hooks and includes never execute; filter state is reported unresolved', async () => {
  const repo = newRepo()
  const scratch = realpathSync(tempDir('atlas-git-hostile-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  put(repo, 'a.md', 'doc a\n'); put(repo, 'b.txt', 'text b\n'); put(repo, 'c.csv', 'x,y\n')
  put(repo, '.gitattributes', '*.md filter=evil diff=evil merge=evil\n*.txt filter=inc diff=evil\n*.csv filter=inc2\n')
  commitAll(repo, 'one')
  put(repo, 'a.md', 'doc a v2\n')
  const head = commitAll(repo, 'two')
  const blobA = gitText(repo, ['rev-parse', 'HEAD:a.md'])
  // A signed-looking commit makes log.showSignature reach for gpg.program.
  const signed = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: `tree ${gitText(repo, ['rev-parse', 'HEAD^{tree}'])}\nparent ${head}\nauthor A <a@e> 1700000000 +0000\ncommitter A <a@e> 1700000000 +0000\n`
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEfake\n -----END PGP SIGNATURE-----\n\nsigned\n',
  }).toString().trim()
  git(repo, ['update-ref', 'refs/heads/main', signed])
  const alt = newRepo({ name: 'alt' })
  put(alt, 'alt.md'); commitAll(alt, 'alt')
  writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), join(alt, '.git', 'objects') + '\n')
  const hooks = join(scratch, 'hooks'); mkdirSync(hooks)
  for (const h of ['post-index-change', 'reference-transaction', 'post-checkout', 'pre-commit', 'post-commit', 'pre-auto-gc', 'fsmonitor-watchman']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${shSingleQuote(join(markers, 'hook-' + h))}\nexit 0\n`)
    chmodSync(join(hooks, h), 0o755)
  }
  const inc = join(scratch, 'included.config')
  writeFileSync(inc, `[filter "inc"]\n\tclean = ${marker(scratch, markers, 'inc-clean', 'exec cat')}\n\tsmudge = ${marker(scratch, markers, 'inc-smudge', 'exec cat')}\n`
    + `[core]\n\tfsmonitor = ${marker(scratch, markers, 'inc-fsmonitor', 'exit 1')}\n`)
  const inc2 = join(scratch, 'included2.config')
  writeFileSync(inc2, `[filter "inc2"]\n\tprocess = ${marker(scratch, markers, 'inc2-process', 'exit 1')}\n\trequired = true\n`)
  const cfg = [
    `[core]`, `\tfsmonitor = ${marker(scratch, markers, 'fsmonitor', 'exit 1')}`, `\tpager = ${marker(scratch, markers, 'pager', 'cat')}`,
    `\teditor = ${marker(scratch, markers, 'editor')}`, `\tsshCommand = ${marker(scratch, markers, 'ssh', 'exit 1')}`, `\thooksPath = ${hooks}`,
    `\taskPass = ${marker(scratch, markers, 'askpass')}`, `\talternateRefsCommand = ${marker(scratch, markers, 'alternate-refs', 'exit 0')}`,
    `[diff]`, `\texternal = ${marker(scratch, markers, 'diff-external')}`,
    `[diff "evil"]`, `\ttextconv = ${marker(scratch, markers, 'textconv', 'cat "$1"')}`, `\tcommand = ${marker(scratch, markers, 'diff-command')}`,
    `[merge "evil"]`, `\tdriver = ${marker(scratch, markers, 'merge-driver')}`,
    `[filter "evil"]`, `\tclean = ${marker(scratch, markers, 'clean', 'exec cat')}`, `\tsmudge = ${marker(scratch, markers, 'smudge', 'exec cat')}`,
    `\trequired = true`,
    `[credential]`, `\thelper = ${marker(scratch, markers, 'credential')}`,
    `[gpg]`, `\tprogram = ${marker(scratch, markers, 'gpg', 'exit 1')}`,
    `[log]`, `\tshowSignature = true`,
    `[status]`, `\tsubmoduleSummary = true`,
    `[include]`, `\tpath = ${inc}`,
    `[includeIf "gitdir:${repo}/"]`, `\tpath = ${inc2}`,
  ].join('\n') + '\n'
  writeFileSync(join(repo, '.git', 'config'), readFileSync(join(repo, '.git', 'config'), 'utf8') + cfg)
  // Make every tracked file stat-dirty so status/ls-files must re-read contents (and would run clean filters).
  const later = new Date(Date.now() + 10_000)
  for (const f of ['a.md', 'b.txt', 'c.csv']) utimesSync(join(repo, f), later, later)

  const runs: Array<[string[], Buffer?]> = [
    [['status', '--porcelain=v1', '--untracked-files=all', '-z']], [['status', '--porcelain=v1', '--ignored', '-z']], [['status']],
    [['ls-files', '-z']], [['ls-files', '-m', '-z']], [['ls-files', '-s', '-z']], [['ls-files', '--others', '--exclude-standard', '-z']],
    [['ls-files', '--others', '--ignored', '--exclude-standard', '-z']], [['ls-files', '--modified', '--deleted', '-z']],
    [['ls-tree', '-r', '-z', '--long', 'HEAD']], [['log', '-z', '--raw', '--no-abbrev', '-M', 'HEAD']],
    [['log', '-n3']], [['cat-file', 'blob', blobA]], [['cat-file', '-p', `${head}:a.md`]], [['cat-file', '-t', blobA]], [['cat-file', '-s', blobA]],
    [['cat-file', '--batch'], Buffer.from(`${blobA}\n${head}:b.txt\n`)], [['cat-file', '--batch-check'], Buffer.from(`${blobA}\n`)],
    [['diff-tree', '-r', '-z', '--name-status', '-M', `${head}~1`, head]], [['rev-list', '--all']], [['for-each-ref']], [['show-ref']],
    [['worktree', 'list', '--porcelain', '-z']], [['rev-parse', 'HEAD']], [['symbolic-ref', 'HEAD']], [['merge-base', head, signed]],
  ]
  for (const [args, input] of runs) {
    const r = await runArtifactGit(repo, args, LIMITS, input ? { input } : {})
    assert.equal(r.error, null, `${args.join(' ')}: ${r.error} ${r.stderr}`)
  }
  for (const args of [['log', '-p', 'HEAD'], ['log', '--stat', 'HEAD'], ['diff-tree', '-r', '-p', `${head}~1`, head], ['cat-file', '--filters', `${head}:a.md`]]) {
    assert.equal((await runArtifactGit(repo, args, LIMITS)).error, 'refused-argument', `content diffs and conversions are refused: ${args.join(' ')}`)
  }
  const status = await runArtifactGit(repo, ['status', '--porcelain=v1', '-z'], LIMITS)
  assert.equal(status.filterState, 'unresolved', 'filter drivers are configured, so cleanliness is not byte-equivalence')
  assert.equal((await runArtifactGit(repo, ['log', '-n1'], LIMITS)).filterState, 'not-checked')
  const checkout = (await resolveGitCheckout(repo))!
  assert.equal(checkout.worktreePath, repo)
  await listGitWorktrees(repo)
  const history = await drainHistory(checkout, null)
  assert.ok(history.changes.some(c => c.path === 'a.md'))
  assert.equal(history.pages.at(-1)!.filterState, 'unresolved')
  assert.deepEqual(markersIn(markers), [], 'no repository-configured command executed')

  // Control: the same repository under plain Git does run these helpers, so the fixture is armed. (The included config's
  // core.fsmonitor is read after the main one, so it is the one plain Git runs.) Exit status is irrelevant here.
  const tryGit = (args: string[]): void => { try { git(repo, args) } catch { /* a failing helper may fail the command */ } }
  // inc2's process filter fails on purpose (the pkt-line handshake dies even when not required); first let plain status run it,
  // then blank only that driver so plain status gets far enough to write the index and fire the hook.
  tryGit(['status', '--porcelain'])
  tryGit(['-c', 'filter.inc2.process=', '-c', 'filter.inc2.required=false', 'status', '--porcelain'])
  tryGit(['log', '-p', '-n2', '--', 'a.md'])
  tryGit(['log', '-n1'])
  tryGit(['rev-list', '--alternate-refs', '-n1'])
  const fired = markersIn(markers)
  for (const expected of ['alternate-refs', 'clean', 'gpg', 'hook-post-index-change', 'inc-clean', 'inc-fsmonitor', 'inc2-process', 'textconv']) {
    assert.ok(fired.includes(expected), `control run fired ${expected}: ${fired.join(',')}`)
  }
})

test('status never recurses into submodules, whose own filter and fsmonitor config was not enumerated', async () => {
  const sub = newRepo({ name: 'sub' })
  put(sub, 'inner.md', 'inner\n'); commitAll(sub, 'inner')
  const repo = newRepo()
  put(repo, 'top.md'); commitAll(repo, 'top')
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'modules/sub'])
  commitAll(repo, 'add submodule')
  const scratch = realpathSync(tempDir('atlas-git-submodule-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  const subGitDir = join(repo, '.git', 'modules', 'modules', 'sub')
  writeFileSync(join(repo, 'modules', 'sub', '.gitattributes'), '*.md filter=subevil\n')
  git(join(repo, 'modules', 'sub'), ['add', '.gitattributes'])
  git(join(repo, 'modules', 'sub'), ['commit', '-q', '-m', 'attrs'])
  git(repo, ['add', 'modules/sub']); git(repo, ['commit', '-q', '-m', 'bump'])
  writeFileSync(join(subGitDir, 'config'), readFileSync(join(subGitDir, 'config'), 'utf8')
    + `[core]\n\tfsmonitor = ${marker(scratch, markers, 'sub-fsmonitor', 'exit 1')}\n[filter "subevil"]\n\tclean = ${marker(scratch, markers, 'sub-clean', 'exec cat')}\n`)
  const later = new Date(Date.now() + 10_000)
  utimesSync(join(repo, 'modules', 'sub', 'inner.md'), later, later)
  for (const args of [['status', '--porcelain=v1', '--untracked-files=all', '-z'], ['status'], ['ls-files', '-m', '-z']]) {
    const r = await runArtifactGit(repo, args, LIMITS)
    assert.equal(r.error, null, args.join(' '))
  }
  assert.deepEqual(markersIn(markers), [])
  try { git(repo, ['status', '--porcelain']) } catch { /* only the attempt matters */ }
  assert.ok(markersIn(markers).length > 0, `control: plain status recursed into the submodule (${markersIn(markers).join(',')})`)
})

test('filter drivers from the user global config are reported unresolved but never loaded or run', async () => {
  const repo = newRepo()
  const scratch = realpathSync(tempDir('atlas-git-global-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  put(repo, 'big.bin', 'payload\n'); put(repo, '.gitattributes', '*.bin filter=lfs\n')
  commitAll(repo, 'one')
  const globalConfig = join(scratch, 'gitconfig')
  writeFileSync(globalConfig, `[filter "lfs"]\n\tclean = ${marker(scratch, markers, 'global-clean', 'exec cat')}\n\tprocess = ${marker(scratch, markers, 'global-process', 'exit 1')}\n`
    + '[status]\n\tshowUntrackedFiles = no\n')
  put(repo, 'untracked.md')
  utimesSync(join(repo, 'big.bin'), new Date(), new Date(Date.now() + 5000))
  const plain = await runArtifactGit(repo, ['status', '--porcelain=v1', '-z'], LIMITS)
  assert.equal(plain.filterState, 'none')
  // A hostile ~/.gitconfig in this process's HOME must not be loaded by executed commands either.
  const homeConfig = join(FIXTURE_HOME, '.gitconfig')
  writeFileSync(homeConfig, `[core]\n\tfsmonitor = ${marker(scratch, markers, 'home-fsmonitor', 'exit 1')}\n`
    + `[filter "lfs"]\n\tclean = ${marker(scratch, markers, 'home-clean', 'exec cat')}\n[status]\n\tshowUntrackedFiles = no\n`)
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  try {
    const r = await runArtifactGit(repo, ['status', '--porcelain=v1', '-z'], LIMITS)
    assert.equal(r.error, null)
    assert.equal(r.filterState, 'unresolved')
    assert.deepEqual(parsePorcelainV1Z(r.stdout).map(e => [e.kind, e.path]), [['untracked', 'untracked.md']], 'global/home config (showUntrackedFiles=no) is not loaded')
    assert.equal((await runArtifactGit(repo, ['ls-files', '-m', '-z'], LIMITS)).error, null)
  } finally {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    rmSync(homeConfig, { force: true })
  }
  assert.deepEqual(markersIn(markers), [])
})

test('parseCheckAttrZ reads path/attribute/value triples without line splitting and reports truncation', () => {
  const out = parseCheckAttrZ(Buffer.from('a.md\0filter\0lfs\0new\nline.md\0filter\0unspecified\0'))
  assert.equal(out.malformed, false)
  assert.deepEqual(out.records.map(r => [r.path, r.attribute, r.value]), [['a.md', 'filter', 'lfs'], ['new\nline.md', 'filter', 'unspecified']])
  assert.equal(parseCheckAttrZ(Buffer.from('a.md\0filter\0lfs\0b.md\0filter\0')).malformed, true, 'a record cut short')
  assert.equal(parseCheckAttrZ(Buffer.from('a.md\0filter\0lf')).malformed, true, 'unterminated tail')
  const lossy = parseCheckAttrZ(Buffer.concat([Buffer.from([0x78, 0xff]), Buffer.from('\0filter\0lfs\0')]))
  assert.deepEqual([lossy.records[0]!.path, lossy.malformed], [null, false])
})

/** A user gitconfig defining an armed git-lfs-like filter driver whose helpers leave a marker if they ever run. */
function armedLfsConfig(scratch: string, markers: string, extra = ''): string {
  const path = join(scratch, 'gitconfig')
  writeFileSync(path, `[filter "lfs"]\n\tclean = ${marker(scratch, markers, 'lfs-clean', 'exec cat')}\n\tsmudge = ${marker(scratch, markers, 'lfs-smudge', 'exec cat')}\n`
    + `\tprocess = ${marker(scratch, markers, 'lfs-process', 'exit 1')}\n\trequired = true\n${extra}`)
  return path
}

test('DEFECT-6: a configured filter driver that no attribute names applies to no path; a named one applies exactly to its paths', async () => {
  const repo = newRepo()
  const scratch = realpathSync(tempDir('atlas-git-filterapp-'))
  const markers = join(scratch, 'markers'); mkdirSync(markers)
  const paths = ['a.md', 'b.bin', 'c.dat', 'd.txt', 'new\nline.md', 'docs/e.md', 'docs/F.MD']
  for (const p of paths) put(repo, p, `${p}\n`)
  commitAll(repo, 'one')
  const later = new Date(Date.now() + 10_000)
  for (const p of paths) utimesSync(join(repo, p), later, later)

  // No driver configured anywhere: nothing to evaluate, one configuration read and no attribute read.
  await runArtifactGit(repo, ['rev-parse', 'HEAD'], LIMITS) // warm the one-time Git version probe
  let before = artifactGitSpawnCount()
  const unconfigured = await resolveGitFilterApplication(repo, paths, LIMITS)
  assert.deepEqual([unconfigured.state, [...unconfigured.filtered], unconfigured.error], ['none', [], null])
  assert.equal(artifactGitSpawnCount() - before, 1, 'only the configuration read')
  before = artifactGitSpawnCount()
  assert.equal((await resolveGitFilterApplication(repo, [], LIMITS)).state, 'none')
  assert.equal(artifactGitSpawnCount() - before, 0, 'no path, no process')

  process.env.GIT_CONFIG_GLOBAL = armedLfsConfig(scratch, markers)
  try {
    // git-lfs installed for the user, named by no attribute (the FINAL-WAVE case): it applies to nothing.
    const unreferenced = await resolveGitFilterApplication(repo, paths, LIMITS)
    assert.deepEqual([unreferenced.state, [...unreferenced.filtered], unreferenced.error], ['none', [], null])
    // Named directly, through a macro, nested; `filter` set without a value and a driver that is not configured name nothing.
    put(repo, '.gitattributes', '*.bin filter=lfs\n[attr]big filter=lfs\n*.dat big\n*.txt filter\n*.md filter=elsewhere\n')
    put(repo, 'docs/.gitattributes', '*.md filter=lfs\n*.MD filter=lfs\n')
    const referenced = await resolveGitFilterApplication(repo, paths, LIMITS)
    assert.deepEqual([referenced.state, [...referenced.filtered].sort(), referenced.error], ['applies', ['b.bin', 'c.dat', 'docs/F.MD', 'docs/e.md'], null])
    // The tracked-document form lists tracked files by extension (case-insensitively) and evaluates only those.
    put(repo, 'untracked.bin', 'u\n')
    const tracked = await resolveTrackedDocumentFilters(repo, ['md', 'bin'], LIMITS)
    assert.deepEqual([tracked.state, [...tracked.filtered].sort()], ['applies', ['b.bin', 'docs/F.MD', 'docs/e.md']], 'untracked files and other extensions are not candidates')
    const below = await resolveTrackedDocumentFilters(repo, ['md', 'bin'], LIMITS, 'docs')
    assert.deepEqual([below.state, [...below.filtered].sort()], ['applies', ['docs/F.MD', 'docs/e.md']], 'm1: only the tracked documents below a root are listed')
    assert.equal((await resolveTrackedDocumentFilters(repo, ['txt', 'csv'], LIMITS)).state, 'none')
    rmSync(join(repo, '.gitattributes')); rmSync(join(repo, 'docs', '.gitattributes'))
    assert.equal((await resolveGitFilterApplication(repo, paths, LIMITS)).state, 'none')

    // The user's own attribute files are read too: the XDG default under HOME, and core.attributesFile.
    put(FIXTURE_HOME, '.config/git/attributes', 'a.md filter=lfs\n')
    try {
      const xdg = await resolveGitFilterApplication(repo, paths, LIMITS)
      assert.deepEqual([xdg.state, [...xdg.filtered]], ['applies', ['a.md']])
    } finally {
      rmSync(join(FIXTURE_HOME, '.config'), { recursive: true, force: true })
    }
    put(scratch, 'user-attributes', 'd.txt filter=lfs\n')
    process.env.GIT_CONFIG_GLOBAL = armedLfsConfig(scratch, markers, `[core]\n\tattributesFile = ${join(scratch, 'user-attributes')}\n`)
    const configured = await resolveGitFilterApplication(repo, paths, LIMITS)
    assert.deepEqual([configured.state, [...configured.filtered]], ['applies', ['d.txt']])
    process.env.GIT_CONFIG_GLOBAL = armedLfsConfig(scratch, markers)

    // Fail closed: an attribute source Git cannot read (it only warns and carries on) is unresolved, never "none".
    put(scratch, 'elsewhere-attrs', '*.md filter=lfs\n')
    execFileSync('ln', ['-s', join(scratch, 'elsewhere-attrs'), join(repo, 'docs', '.gitattributes')])
    const unreadable = await resolveGitFilterApplication(repo, paths, LIMITS)
    assert.equal(unreadable.state, 'unresolved', 'a .gitattributes Git refuses to read leaves the filter state unknown')
    assert.notEqual(unreadable.error, null)
    rmSync(join(repo, 'docs', '.gitattributes'))
    // ...and so is a Git failure (a corrupt index), an output cap and a refused path.
    const capped = await resolveGitFilterApplication(repo, paths, { timeoutMs: 10_000, maxOutputBytes: 64 })
    assert.equal(capped.state, 'unresolved')
    before = artifactGitSpawnCount()
    for (const bad of [['/abs.md'], ['../up.md'], ['a/../b.md'], ['a//b.md'], ['nul\0.md'], ['']]) {
      const r = await resolveGitFilterApplication(repo, bad, LIMITS)
      assert.deepEqual([r.state, r.error], ['unresolved', 'refused-input'], JSON.stringify(bad))
    }
    assert.equal(artifactGitSpawnCount() - before, 0, 'refused input spawns nothing')
    const gitDir = gitText(repo, ['rev-parse', '--absolute-git-dir'])
    const index = readFileSync(join(gitDir, 'index'))
    writeFileSync(join(gitDir, 'index'), 'corrupt index')
    try {
      assert.equal((await resolveGitFilterApplication(repo, paths, LIMITS)).state, 'unresolved')
    } finally {
      writeFileSync(join(gitDir, 'index'), index)
    }
  } finally {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  }
  // The attribute read is internal: the public allowlist still refuses check-attr, and no driver ever ran.
  assert.equal((await runArtifactGit(repo, ['check-attr', '-z', '--stdin', 'filter'], LIMITS, { input: Buffer.from('a.md\0') })).error, 'refused-subcommand')
  assert.deepEqual(markersIn(markers), [], 'no filter helper executed')
})

/**
 * Waits until the wall clock is well into a later whole second than now (Git compares stat times at one-second resolution;
 * just after the boundary the kernel's coarse clock, which stamps files, can still read the previous second).
 */
async function nextSecond(): Promise<void> {
  const second = Math.floor(Date.now() / 1000)
  while (Math.floor(Date.now() / 1000) === second || Date.now() % 1000 < 50) await new Promise(resolve => setTimeout(resolve, 10))
}

test('I4: a same-size edit with its mtime restored is seen as changed even when the user\'s config compares only size and mtime', async () => {
  const repo = newRepo()
  put(repo, 'a.md', 'abcd\n')
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(repo, 'a.md'), old, old) // older than the index: not racily clean, so Git trusts the stat data
  commitAll(repo, 'one')
  // The weakest stat check a user can configure: size and whole-second mtime only, no inode change time.
  git(repo, ['config', 'core.checkStat', 'minimal'])
  git(repo, ['config', 'core.trustctime', 'false'])
  await nextSecond()
  put(repo, 'a.md', 'wxyz\n') // same size
  utimesSync(join(repo, 'a.md'), old, old) // mtime restored, as `touch -r`, `cp -p` and `rsync -t` do
  assert.equal(gitText(repo, ['status', '--porcelain']), '', 'control: the user\'s own Git calls it clean under that config')
  const status = await runArtifactGit(repo, ['status', '--porcelain=v1', '-z'], LIMITS)
  assert.deepEqual(parsePorcelainV1Z(status.stdout).map(e => [e.y, e.path]), [['M', 'a.md']], 'the adapter compares the inode change time, then the bytes')
  const tags = await runArtifactGit(repo, ['ls-files', '-v', '--cached', '--modified', '-z'], LIMITS)
  assert.deepEqual(parseLsFilesTagsZ(tags.stdout).entries.map(e => e.tag + e.path), ['Ha.md', 'Ca.md'])
})

test('m1: listTrackedDocumentStates lists only tracked documents below a literally matched root, over argv-bounded launches held to one output cap', async () => {
  const repo = newRepo()
  // A root of glob magic (about 500 bytes on disk, about 1 KB as pathspec once escaped) makes the 64 extension pathspecs exceed
  // one launch's argv budget, so they need two launches; the files' own paths stay within the portable path limit.
  const { root, lookalike, exts, first, last } = twoLaunchFixture(PATHSPEC_ARGV_CHUNK_BYTES)
  put(repo, `${root}/a.${first}`); put(repo, `${root}/b.${last.toUpperCase()}`); put(repo, `${root}/c.bin`)
  put(repo, `${lookalike}/outside.${first}`) // what the root would match were its magic not escaped
  put(repo, `outside.${last}`)
  for (const p of [`${root}/b.${last.toUpperCase()}`, `${lookalike}/outside.${first}`]) assertPortablePath(join(repo, p), 'a path this fixture creates')
  commitAll(repo, 'one')
  const r = await listTrackedDocumentStates(repo, root, exts, LIMITS)
  assert.equal(r.error, null)
  const spawned = artifactGitSpawnCount() // after the host Git's one-time version check
  await listTrackedDocumentStates(repo, root, exts, LIMITS)
  assert.equal(artifactGitSpawnCount() - spawned, 3, 'one configuration read, then two ls-files launches')
  assert.deepEqual(parseLsFilesTagsZ(r.stdout).entries.map(e => e.tag + e.path).sort(), [`H${root}/a.${first}`, `H${root}/b.${last.toUpperCase()}`])
  // Each launch alone fits a cap that both together exceed: the shared cap fails closed.
  const one = (await listTrackedDocumentStates(repo, root, [first], LIMITS)).stdout.length
  const capped = await listTrackedDocumentStates(repo, root, exts, { ...LIMITS, maxOutputBytes: one + 10 })
  // The second launch gets only the 10 bytes the first left: it is stopped there (killed), never run and buffered whole.
  assert.deepEqual([capped.error, capped.truncated, capped.exitCode, capped.stdout.length], ['output-cap', true, null, one + 10])
  assert.equal((await listTrackedDocumentStates(repo, '', [last], LIMITS)).stdout.toString().split('\0').filter(Boolean).length, 2)
  // `$` sequences in a root's name are literal: as a replacement string, `out$$` would list `out$/`, `a$&b` `a)b/`, and so on.
  const dollars = newRepo()
  const names = ['out$$', 'a$&b', 'a$`b', "a$'b"]
  for (const name of names) put(dollars, `${name}/clean.e0`)
  for (const sibling of ['out$', 'a)b', 'a:(glob,icaseb', 'ax/y.e0b']) put(dollars, `${sibling}/clean.e0`)
  commitAll(dollars, 'one')
  for (const name of names) {
    const listed = await listTrackedDocumentStates(dollars, name, ['e0'], LIMITS)
    assert.deepEqual([listed.error, parseLsFilesTagsZ(listed.stdout).entries.map(e => e.tag + e.path)], [null, [`H${name}/clean.e0`]], name)
  }
})

/**
 * The partial-clone fixture. It states every transport rule it relies on instead of inheriting Git's defaults, which differ by
 * version and platform build: the source serves filtered clones AND later single-object requests (allowAnySHA1InWant: a protocol
 * v0/v1 server refuses a want that is not a ref tip), the clone and the control fetch speak protocol v2 over file:// (the
 * transport that honours --filter), and the file transport is allowed explicitly (Git 2.38.1+ restricts it to user-initiated
 * commands). `diag()` names the observed Git version, the clone's config and paths, so a failing run on another machine says
 * what differs instead of only which assertion failed.
 */
function partialCloneFixture() {
  const src = newRepo({ name: 'src' })
  for (let i = 0; i < 3; i++) put(src, `doc${i}.md`, `content ${i} long enough to be a real document body\n`)
  commitAll(src, 'one')
  put(src, 'doc1.md', 'changed content for doc one\n')
  git(src, ['mv', 'doc2.md', 'moved.md'])
  put(src, 'moved.md', 'content 2 long enough to be a real document body!\n')
  commitAll(src, 'two')
  git(src, ['config', 'uploadpack.allowFilter', 'true'])
  git(src, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
  const parent = realpathSync(tempDir('atlas-git-pc-'))
  const markers = join(parent, 'markers'); mkdirSync(markers)
  const clone = join(parent, 'clone')
  const transport = ['-c', 'protocol.version=2', '-c', 'protocol.file.allow=always']
  const diag = (): string => {
    const text = (cwd: string, args: string[]): string => { try { return gitText(cwd, args) } catch (e) { return `<${args.join(' ')} failed: ${String((e as Error).message).split('\n')[0]}>` } }
    const config = existsSync(clone) ? text(clone, ['config', '--local', '--list']).split('\n').filter(l => /^(core\.repositoryformatversion|extensions\.|remote\.)/.test(l)).join('; ') : '<no clone>'
    return `[${text(parent, ['--version'])}; platform=${process.platform}; src=${src}; clone=${clone}; config: ${config}]`
  }
  git(parent, [...transport, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${src}`, clone])
  // Precondition, so a Git that ignored the filter fails here with its reason rather than in a later assertion.
  assert.equal(gitText(clone, ['config', 'remote.origin.promisor']), 'true', `the clone is a promisor (partial) clone ${diag()}`)
  assert.equal(gitText(clone, ['config', 'remote.origin.partialclonefilter']), 'blob:none', `the clone filter ${diag()}`)
  git(clone, ['config', 'remote.origin.uploadpack', marker(parent, markers, 'upload-pack', 'exec git upload-pack "$@"')])
  git(clone, ['config', 'credential.helper', marker(parent, markers, 'credential')])
  const missing = (): string[] => git(clone, ['rev-list', '--objects', '--missing=print', '--all']).toString().split('\n').filter(l => l.startsWith('?'))
  const before = missing()
  assert.ok(before.length > 0, `the filtered clone lacks blobs: ${JSON.stringify(before)} ${diag()}`)
  return { clone, markers, transport, missing, before, oid: before[0]!.slice(1), diag }
}

/** What a partial clone's page must show, whichever way this Git reports a blob it may not fetch ('missing' or an aborted check). */
async function assertPartialCloneIsExplicitlyIncomplete(f: ReturnType<typeof partialCloneFixture>): Promise<void> {
  const { clone, oid, diag } = f
  const started = Date.now()
  const r = await runArtifactGit(clone, ['cat-file', 'blob', oid], LIMITS)
  assert.notEqual(r.error, null, `a missing promisor blob is an error, not data: ${JSON.stringify({ error: r.error, exitCode: r.exitCode, stderr: r.stderr })} ${diag()}`)
  assert.ok(Date.now() - started < 5000, 'failed fast, no prompt')
  const checkout = (await resolveGitCheckout(clone))!
  assert.equal(checkout.partialClone, true, `resolveGitCheckout read the promisor config ${diag()}`)
  const meta = await readBlobMetadata(clone, 'sha1', [oid], LIMITS)
  assert.notEqual(meta.complete, true, `blob metadata of a missing blob is incomplete: ${JSON.stringify({ complete: meta.complete, error: meta.error, state: meta.blobs.get(oid)?.state })} ${diag()}`)
  assert.notEqual(meta.blobs.get(oid)?.state, 'present', diag())
  const { pages, changes } = await drainHistory(checkout, null)
  const observed = `${JSON.stringify({ states: changes.map(ch => [ch.path, ch.blobState, ch.size]), gaps: pages.at(-1)?.gaps, complete: pages.at(-1)?.complete, partialClone: pages.at(-1)?.partialClone })} ${diag()}`
  assert.ok(changes.length > 0, `commit-level history is still read: ${observed}`)
  assert.ok(changes.filter(ch => ch.blobOid !== null).every(ch => ch.blobState !== null && (ch.blobState === 'present') === (ch.size !== null)), observed)
  assert.ok(changes.some(ch => ch.blobState === 'unavailable'), `a blob this Git may not fetch is recorded as unavailable: ${observed}`)
  assert.ok(pages.at(-1)!.gaps.includes('object-metadata-unavailable'), observed)
  assert.ok(!pages.at(-1)!.gaps.includes('missing-objects'), `a promisor blob is not reported as lost: ${observed}`)
  assert.equal(pages.at(-1)!.complete, false, observed)
  assert.equal(pages.at(-1)!.partialClone, true, observed)
  assert.deepEqual(f.missing(), f.before, `nothing was fetched ${diag()}`)
  assert.deepEqual(markersIn(f.markers), [], `no upload-pack or credential helper ran ${diag()}`)
}

test('partial clone history and blob metadata are explicitly incomplete and fetch nothing', async () => {
  const f = partialCloneFixture()
  await assertPartialCloneIsExplicitlyIncomplete(f)
  // Control: plain Git would lazily fetch through the configured upload-pack.
  try { git(f.clone, [...f.transport, 'cat-file', '-e', f.oid]) } catch { /* only the attempt matters */ }
  assert.ok(markersIn(f.markers).includes('upload-pack'), `control: plain Git lazily fetches through the configured upload-pack ${f.diag()}`)
})

// Git versions differ in how `cat-file --batch-check` answers for a blob it may not fetch: the Git of this container aborts
// the whole check at the first one (exit 128), a Git that reports it per object prints `<oid> missing` and goes on. In a
// partial clone both mean "not available here", so the page must be the same. The shim stands in for the second kind: for
// `cat-file --batch-check` it asks the real Git one object at a time and prints `<oid> missing` for an object it aborts on.
test('a Git that answers a promisor blob with "missing" instead of aborting gives the same partial-clone page', async () => {
  const f = partialCloneFixture()
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const shimDir = join(realpathSync(tempDir('atlas-git-shim-')), 'bin'); mkdirSync(shimDir)
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
case " $* " in
  *" cat-file --batch-check "*)
    while read oid; do
      out=$(printf '%s\\n' "$oid" | ${shSingleQuote(realGit)} "$@" 2>/dev/null) || out="$oid missing"
      printf '%s\\n' "$out"
    done ;;
  *) exec ${shSingleQuote(realGit)} "$@" ;;
esac
`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}:${savedPath ?? ''}`
  try {
    const direct = await runArtifactGit(f.clone, ['cat-file', '--batch-check'], LIMITS, { input: Buffer.from(f.oid + '\n') })
    assert.equal(direct.stdout.toString().trim(), `${f.oid} missing`, `the shim answers like a Git that reports per object: ${JSON.stringify({ stdout: direct.stdout.toString(), error: direct.error })} ${f.diag()}`)
    await assertPartialCloneIsExplicitlyIncomplete(f)
  } finally {
    process.env.PATH = savedPath
  }
})

test('timeout kills the process group and returns timedOut, never an empty complete result', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const repo = newRepo()
  put(repo, 'a.md'); commitAll(repo, 'one')
  const checkout = (await resolveGitCheckout(repo))!
  const fifo = makeFifo('atlas-git-fifo-')
  const configPath = join(repo, '.git', 'config')
  const original = readFileSync(configPath, 'utf8')
  writeFileSync(configPath, original + `[include]\n\tpath = ${fifo}\n`)
  try {
    const limits = { timeoutMs: 400, maxOutputBytes: LIMITS.maxOutputBytes }
    for (const args of [['rev-parse', 'HEAD'], ['status', '--porcelain=v1', '-z'], ['log', '-n1']]) {
      const started = Date.now()
      const r = await runArtifactGit(repo, args, limits)
      assert.equal(r.timedOut, true, args.join(' '))
      assert.equal(r.error, 'timeout')
      assert.equal(r.exitCode, null)
      assert.equal(r.incomplete, true)
      assert.ok(Date.now() - started < 5000, 'returned promptly after the deadline')
    }
    const page = await readDocumentHistory(checkout, null, limits)
    assert.equal(page.complete, false)
    assert.equal(page.timedOut, true)
    assert.equal(page.changes.length, 0)
    assert.equal(page.cursor, null, 'no progress is recorded')
  } finally {
    writeFileSync(configPath, original)
    releaseFifo(fifo)
    rmSync(fifo, { force: true })
  }
})

test('output cap stops reading, kills Git and returns the partial bytes flagged truncated', async () => {
  const repo = newRepo()
  for (let i = 0; i < 40; i++) put(repo, `file-${String(i).padStart(2, '0')}.md`)
  put(repo, 'big.md', 'y'.repeat(1024 * 1024))
  commitAll(repo, 'many')
  const full = await runArtifactGit(repo, ['ls-files', '-z'], LIMITS)
  assert.equal(full.error, null)
  const exact = await runArtifactGit(repo, ['ls-files', '-z'], { timeoutMs: 10_000, maxOutputBytes: full.stdout.length })
  assert.equal(exact.truncated, false, 'output exactly at the cap is complete')
  assert.equal(exact.error, null)
  const capped = await runArtifactGit(repo, ['ls-files', '-z'], { timeoutMs: 10_000, maxOutputBytes: 100 })
  assert.equal(capped.truncated, true)
  assert.equal(capped.error, 'output-cap')
  assert.equal(capped.incomplete, true)
  assert.deepEqual(capped.stdout, full.stdout.subarray(0, 100))
  const blob = await runArtifactGit(repo, ['cat-file', 'blob', 'HEAD:big.md'], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
  assert.equal(blob.truncated, true)
  assert.equal(blob.stdout.length, 64 * 1024)
  assert.equal(blob.exitCode, null)
})

test('bounded stdin feeds one batch process for many objects', async () => {
  const repo = newRepo()
  const names = Array.from({ length: 30 }, (_, i) => `d${i}.md`)
  names.forEach((n, i) => put(repo, n, `doc ${i}\n`))
  commitAll(repo, 'docs')
  const oids = names.map(n => gitText(repo, ['rev-parse', `HEAD:${n}`]))
  await runArtifactGit(repo, ['rev-parse', 'HEAD'], LIMITS) // warm the one-time Git version probe
  const before = artifactGitSpawnCount()
  const meta = await readBlobMetadata(repo, 'sha1', [...oids, 'f'.repeat(40)], LIMITS)
  assert.ok(artifactGitSpawnCount() - before <= 3, 'one non-executing config read, one batch-check and one batch read for small blobs')
  assert.equal(meta.complete, false, 'a missing object makes the batch incomplete')
  assert.deepEqual(meta.blobs.get(oids[0]!), { state: 'present', size: 6, lfsPointer: false })
  assert.equal(meta.blobs.get('f'.repeat(40))!.state, 'missing')
  const refused = await readBlobMetadata(repo, 'sha1', ['HEAD'], LIMITS)
  assert.equal(refused.error, 'refused-object-id', 'only OIDs of the repository format are accepted')
  const wrongFormat = await readBlobMetadata(repo, 'sha256', [oids[0]!], LIMITS)
  assert.equal(wrongFormat.error, 'refused-object-id')
})

// ------------------------------------------------------------------------------------------------------ checkout resolution

test('resolveGitCheckout: main checkout, subdirectory, unborn and detached HEADs, remotes sanitized', async () => {
  const repo = newRepo()
  const unborn = (await resolveGitCheckout(repo))!
  assert.equal(unborn.head.unborn, true)
  assert.equal(unborn.head.oid, null)
  assert.equal(unborn.head.ref, 'refs/heads/main')
  put(repo, 'sub/dir/a.md')
  const head = commitAll(repo, 'one')
  git(repo, ['remote', 'add', 'origin', 'https://user:token@host/org/repo.git?x=1#f'])
  git(repo, ['remote', 'add', 'scp', 'deploy:SECRET@host:org/repo.git'])
  const c = (await resolveGitCheckout(join(repo, 'sub', 'dir')))!
  assert.equal(c.worktreePath, repo)
  assert.equal(c.gitDir, join(repo, '.git'))
  assert.equal(c.commonDir, join(repo, '.git'))
  assert.equal(c.isMain, true)
  assert.equal(c.objectFormat, 'sha1')
  assert.equal(c.shallow, false)
  assert.equal(c.partialClone, false)
  assert.deepEqual(c.head, { oid: head, ref: 'refs/heads/main', detached: false, unborn: false })
  assert.deepEqual(c.remotes, [{ name: 'origin', url: 'https://host/org/repo.git' }, { name: 'scp', url: 'host:org/repo.git' }])
  assert.ok(!JSON.stringify(c).includes('token') && !JSON.stringify(c).includes('SECRET'))
  git(repo, ['checkout', '-q', '--detach'])
  const detached = (await resolveGitCheckout(repo))!
  assert.deepEqual(detached.head, { oid: head, ref: null, detached: true, unborn: false })
})

test('resolveGitCheckout returns null for non-repositories, bare repositories and paths inside .git', async () => {
  const plain = realpathSync(tempDir('atlas-git-plain-'))
  assert.equal(await resolveGitCheckout(plain), null)
  assert.equal(await resolveGitCheckout(join(plain, 'missing')), null)
  const repo = newRepo()
  assert.equal(await resolveGitCheckout(join(repo, '.git')), null)
  const bare = join(realpathSync(tempDir('atlas-git-bare-')), 'bare.git')
  git(dirname(bare), ['init', '-q', '--bare', bare])
  assert.equal(await resolveGitCheckout(bare), null)
  await assert.rejects(resolveGitCheckout('relative'), (e: unknown) => e instanceof GitAdapterError && e.code === 'invalid-path')
})

test('.git files resolve: separate git dir and a relative gitdir pointer', async () => {
  const parent = realpathSync(tempDir('atlas-git-sep-'))
  const work = join(parent, 'work')
  const store = join(parent, 'store.git')
  git(parent, ['init', '-q', `--separate-git-dir=${store}`, work])
  put(work, 'a.md'); commitAll(work, 'one')
  assert.ok(statSync(join(work, '.git')).isFile())
  const c = (await resolveGitCheckout(work))!
  assert.equal(c.worktreePath, work)
  assert.equal(c.gitDir, store)
  assert.equal(c.commonDir, store)
  writeFileSync(join(work, '.git'), 'gitdir: ../store.git\n')
  const rel = (await resolveGitCheckout(work))!
  assert.equal(rel.gitDir, store)
})

test('linked worktrees: per-checkout git dirs, shared common dir, detached/locked/prunable states and odd paths', async () => {
  const repo = newRepo()
  put(repo, 'a.md')
  const head = commitAll(repo, 'one')
  const parent = dirname(repo)
  const feature = join(parent, 'wt feature\nline')
  const detached = join(parent, 'wt-detached')
  const doomed = join(parent, 'wt-doomed')
  git(repo, ['worktree', 'add', '-q', '-b', 'feature', feature])
  git(repo, ['worktree', 'add', '-q', '--detach', detached, 'HEAD'])
  git(repo, ['worktree', 'add', '-q', '-b', 'doomed', doomed])
  git(repo, ['worktree', 'lock', '--reason', 'kept\nfor review', detached])
  rmSync(doomed, { recursive: true, force: true })

  const linked = (await resolveGitCheckout(feature))!
  assert.equal(linked.worktreePath, feature)
  assert.equal(linked.commonDir, join(repo, '.git'))
  assert.equal(dirname(linked.gitDir), join(repo, '.git', 'worktrees'))
  assert.equal(linked.isMain, false)
  assert.equal(linked.head.ref, 'refs/heads/feature')

  const all = await listGitWorktrees(feature)
  const m = new Map(all.map(w => [w.worktreePath, w]))
  assert.equal(all.length, 4)
  assert.equal(m.get(repo)!.isMain, true)
  assert.equal(m.get(repo)!.gitDir, join(repo, '.git'))
  assert.equal(m.get(feature)!.gitDir, linked.gitDir)
  assert.deepEqual(m.get(detached)!.head, { oid: head, ref: null, detached: true, unborn: false })
  assert.equal(m.get(detached)!.locked, true)
  assert.equal(m.get(doomed)!.prunable, true)
  assert.equal(dirname(m.get(doomed)!.gitDir), join(repo, '.git', 'worktrees'))
  for (const w of all) assert.equal(w.commonDir, join(repo, '.git'))
  assert.deepEqual(await listGitWorktrees(realpathSync(tempDir('atlas-git-none-'))), [])
})

test('SHA-256 repositories carry the object format with every OID', async t => {
  if (!sha256Supported()) return t.skip('host Git lacks SHA-256 support')
  const repo = newRepo({ objectFormat: 'sha256' })
  put(repo, 'a.md', 'one\n')
  commitAll(repo, `one\n\nAtlas-Session: ${SID}\n`)
  git(repo, ['mv', 'a.md', 'renamed.md'])
  commitAll(repo, 'two')
  put(repo, 'staged.md'); git(repo, ['add', 'staged.md'])
  const c = (await resolveGitCheckout(repo))!
  assert.equal(c.objectFormat, 'sha256')
  assert.match(c.head.oid!, /^[0-9a-f]{64}$/)
  const stage = parseLsFilesStageZ((await runArtifactGit(repo, ['ls-files', '-s', '-z'], LIMITS)).stdout, 'sha256')
  assert.ok(stage.length === 2 && stage.every(e => !e.malformed && /^[0-9a-f]{64}$/.test(e.oid!)))
  const { pages, changes } = await drainHistory(c, null)
  assert.equal(pages.at(-1)!.complete, true)
  assert.equal(pages.at(-1)!.objectFormat, 'sha256')
  assert.ok(changes.length >= 2)
  for (const ch of changes) {
    assert.equal(ch.commit!.objectFormat, 'sha256')
    assert.match(ch.commit!.oid, /^[0-9a-f]{64}$/)
    assert.match(ch.blobOid!, /^[0-9a-f]{64}$/)
    assert.equal(typeof ch.size, 'number')
  }
  assert.deepEqual(changes.find(ch => ch.status === 'R')!.oldPath, 'a.md')
})

// ------------------------------------------------------------------------------------------------------------------- history

test('history imports adds, modifications and renames with blob OID, mode, size and only Atlas-Session trailers', async () => {
  const repo = newRepo()
  put(repo, 'a.md', 'alpha\n'); put(repo, 'new\nline.md', 'nl\n'); put(repo, 'tool.sh', '#!/bin/sh\n'); chmodSync(join(repo, 'tool.sh'), 0o755)
  const c1 = commitAll(repo, `first\n\nAtlas-Session: ${SID}\nClaude-Session: https://claude.ai/code/session_x\n`)
  git(repo, ['mv', 'a.md', 'b.md'])
  put(repo, 'new\nline.md', 'nl changed\n')
  const c2 = commitAll(repo, `second\n\nAtlas-Session: ${SID2}\n\nlater prose so the line above is body, not trailer\n`)
  const checkout = (await resolveGitCheckout(repo))!
  const first = await drainHistory(checkout, null)
  const last = first.pages.at(-1)!
  assert.equal(last.complete, true)
  assert.equal(last.hasMore, false)
  assert.equal(last.error, null)
  assert.notEqual(last.cursor, null)
  const changes = first.changes
  const added = changes.filter(ch => ch.commit!.oid === c1)
  assert.deepEqual(added.map(ch => ch.path).sort(), ['a.md', 'new\nline.md', 'tool.sh'])
  for (const ch of added) {
    assert.equal(ch.status, 'A')
    assert.deepEqual(ch.commit!.atlasSessionIds, [SID])
    assert.equal(ch.commit!.objectFormat, 'sha1')
    assert.equal(ch.blobOid, gitText(repo, ['rev-parse', `${c1}:${ch.path}`]))
  }
  assert.equal(added.find(ch => ch.path === 'tool.sh')!.mode, 0o100755)
  assert.equal(added.find(ch => ch.path === 'a.md')!.size, 6)
  const second = changes.filter(ch => ch.commit!.oid === c2)
  assert.deepEqual(second.map(ch => [ch.status, ch.oldPath, ch.path]).sort(), [['M', null, 'new\nline.md'], ['R', 'a.md', 'b.md']])
  for (const ch of second) assert.deepEqual(ch.commit!.atlasSessionIds, [], 'a body line is not a trailer')
  assert.ok(changes.every(ch => ch.lfsPointer === false))

  const again = await readDocumentHistory(checkout, last.cursor, LIMITS)
  assert.deepEqual([again.changes.length, again.complete, again.hasMore], [0, true, false])
  put(repo, 'c.md', 'gamma\n')
  const c3 = commitAll(repo, 'third')
  const next = await drainHistory(checkout, again.cursor)
  assert.deepEqual(next.changes.map(ch => [ch.commit!.oid, ch.path]), [[c3, 'c.md']], 'only newly reachable history')
  assert.equal(next.pages.at(-1)!.complete, true)
})

test('history pages are bounded, resumable and claim completeness only on the final page', async () => {
  const repo = newRepo()
  const oids: string[] = []
  for (let i = 0; i < 7; i++) { put(repo, `doc${i}.md`, `v${i}\n`); oids.push(commitAll(repo, `c${i}`)) }
  const checkout = (await resolveGitCheckout(repo))!
  const { pages, changes } = await drainHistory(checkout, null, LIMITS, { maxCommits: 2 })
  assert.equal(pages.length, 4)
  assert.ok(pages.slice(0, -1).every(p => p.hasMore && !p.complete))
  assert.equal(pages.at(-1)!.complete, true)
  assert.deepEqual(changes.map(ch => ch.commit!.oid).sort(), [...oids].sort(), 'every commit exactly once')
  assert.ok(pages.every(p => (p.cursor ?? '').length <= 64 * 1024))
})

test('a stalled tree read (walk) or blob read (metadata) keeps the cursor; recovery imports every commit', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const repo = newRepo()
  const oids: string[] = []
  for (let i = 0; i < 6; i++) { put(repo, `d${i}.md`, `content ${i}\n`); oids.push(commitAll(repo, `c${i}`)) }
  const checkout = (await resolveGitCheckout(repo))!
  const short = { timeoutMs: 500, maxOutputBytes: LIMITS.maxOutputBytes }
  const expected = Array.from({ length: 6 }, (_, i) => `d${i}.md`)
  // A loose tree object replaced by a FIFO stalls only `log --raw`; a loose blob object, only `cat-file`.
  for (const victim of [`${oids[3]}^{tree}`, `${oids[3]}:d3.md`]) {
    const oid = gitText(repo, ['rev-parse', victim])
    const objectPath = join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    const saved = readFileSync(objectPath)
    rmSync(objectPath)
    execFileSync('mkfifo', [objectPath])
    FIFOS.add(objectPath)
    const got = new Set<string>()
    let cursor: string | null = null
    let stalls = 0
    try {
      for (let i = 0; i < 20 && stalls < 2; i++) {
        const page = await readDocumentHistory(checkout, cursor, short, { maxCommits: 2 })
        if (page.error !== null) {
          assert.equal(page.error, 'timeout', victim)
          assert.equal(page.cursor, cursor, `${victim}: an error returns the input cursor`)
          assert.deepEqual(page.changes, [])
          stalls++
          continue
        }
        for (const ch of page.changes) got.add(ch.path!)
        cursor = page.cursor
        if (!page.hasMore) break
      }
      assert.equal(stalls, 2, `${victim}: the stalled read surfaced as retryable errors`)
    } finally {
      releaseFifo(objectPath)
      rmSync(objectPath, { force: true })
      writeFileSync(objectPath, saved)
    }
    const rest = await drainHistory(checkout, cursor, LIMITS, { maxCommits: 2 })
    for (const ch of rest.changes) got.add(ch.path!)
    assert.deepEqual([...got].sort(), expected, `${victim}: no commit was skipped`)
    assert.equal(rest.pages.at(-1)!.complete, true)
    assert.deepEqual(rest.pages.at(-1)!.gaps, [])
  }
})

/** Replaces a loose object with a FIFO so any Git process reading it blocks; returns a restore function. */
function stallObject(repo: string, rev: string): () => void {
  const oid = gitText(repo, ['rev-parse', rev])
  const objectPath = join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
  const saved = readFileSync(objectPath)
  rmSync(objectPath)
  execFileSync('mkfifo', [objectPath])
  FIFOS.add(objectPath)
  return () => {
    releaseFifo(objectPath)
    rmSync(objectPath, { force: true })
    writeFileSync(objectPath, saved)
    FIFOS.delete(objectPath)
  }
}

test('a walk timeout narrows the page: the healthy first commit is imported before a retryable error at n=1', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const repo = newRepo()
  const oids: string[] = []
  for (let i = 0; i < 4; i++) { put(repo, `w${i}.md`, `w${i}\n`); oids.push(commitAll(repo, `c${i}`)) }
  const checkout = (await resolveGitCheckout(repo))!
  const short = { timeoutMs: 500, maxOutputBytes: LIMITS.maxOutputBytes }
  // Page one is [c3, c2]. c2's diff reads c1's tree, which stalls; c3's diff (c2's and c3's trees) does not.
  const restore = stallObject(repo, `${oids[1]}^{tree}`)
  const imported = new Set<string>()
  let cursor: string | null = null
  let errorPage: GitHistoryPage | null = null
  try {
    for (let i = 0; i < 10 && !errorPage; i++) {
      const input: string | null = cursor
      let page = await readDocumentHistory(checkout, input, short, { maxCommits: 2 })
      if (page.error !== null) {
        assert.equal(page.cursor, input, 'the error page returns the input cursor byte for byte')
        // The 500 ms limit applies to every Git call, so a slow healthy call on a busy machine also errors. Only an
        // error that an immediate retry at the same cursor repeats is the stall under test.
        const again = await readDocumentHistory(checkout, input, short, { maxCommits: 2 })
        if (again.error !== null) {
          errorPage = page
          assert.equal(again.error, 'timeout')
          assert.equal(again.cursor, input, 'a repeated failure at n=1 neither narrows further nor moves')
          break
        }
        page = again
      }
      for (const ch of page.changes) imported.add(ch.commit!.oid)
      cursor = page.cursor
    }
    assert.equal(errorPage?.error, 'timeout')
    assert.deepEqual(errorPage?.changes, [])
    assert.ok(imported.has(oids[3]!), 'the healthy commit ahead of the stalled one was imported first')
    assert.ok(!imported.has(oids[2]!))
  } finally {
    restore()
  }
  const rest = await drainHistory(checkout, cursor, LIMITS, { maxCommits: 2 })
  for (const ch of rest.changes) imported.add(ch.commit!.oid)
  assert.deepEqual([...imported].sort(), [...oids].sort())
  assert.equal(rest.pages.at(-1)!.complete, true)
})

test('a metadata timeout narrows the page from maxCommits 3: progress without errors until n=1, then every commit', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const repo = newRepo()
  const oids: string[] = []
  for (let i = 0; i < 6; i++) { put(repo, `m${i}.md`, `doc ${i}\n`); oids.push(commitAll(repo, `c${i}`)) }
  const checkout = (await resolveGitCheckout(repo))!
  const short = { timeoutMs: 500, maxOutputBytes: LIMITS.maxOutputBytes }
  // Page one is [c5, c4, c3]; c4's blob stalls only cat-file (the walk reads trees, not blobs).
  const restore = stallObject(repo, `${oids[4]}:m4.md`)
  const imported = new Set<string>()
  let cursor: string | null = null
  const trail: string[] = []
  try {
    let transients = 0
    for (let i = 0; i < 12 + transients; i++) {
      const input: string | null = cursor
      let page = await readDocumentHistory(checkout, input, short, { maxCommits: 3 })
      if (page.error !== null) {
        assert.equal(page.error, 'timeout')
        assert.equal(page.cursor, input, 'only n=1 returns the error, with the cursor unchanged')
        // The 500 ms limit applies to every Git call, so a slow healthy call on a busy machine also errors. Only an
        // error that an immediate retry at the same cursor repeats is the stall under test.
        const again = await readDocumentHistory(checkout, input, short, { maxCommits: 3 })
        if (again.error === null) {
          trail.push('transient:timeout')
          transients++
          page = again
        } else {
          trail.push(page.error)
          assert.equal(again.error, 'timeout')
          assert.equal(again.cursor, input, 'only n=1 returns the error, with the cursor unchanged')
          break
        }
      }
      trail.push(`ok:${page.changes.length}`)
      assert.equal(page.hasMore, true)
      for (const ch of page.changes) imported.add(ch.commit!.oid)
      cursor = page.cursor
    }
    assert.equal(trail.at(-1), 'timeout', `narrowed to a single stalled commit: ${trail.join(' ')}`)
    assert.ok(trail.slice(0, -1).some(t => t === 'ok:0'), `a timed-out page narrowed without an error: ${trail.join(' ')}`)
    assert.deepEqual([...imported], [oids[5]], 'the healthy commit at index 0 was imported before the stalled one')
  } finally {
    restore()
  }
  const rest = await drainHistory(checkout, cursor, LIMITS, { maxCommits: 3 })
  for (const ch of rest.changes) imported.add(ch.commit!.oid)
  assert.deepEqual([...imported].sort(), [...oids].sort(), 'every commit is imported once the stall clears')
  assert.equal(rest.pages.at(-1)!.complete, true)
})

test('an unexplained Git error (no missing-object report) keeps the cursor and skips nothing', async () => {
  const repo = newRepo()
  for (let i = 0; i < 3; i++) { put(repo, `e${i}.md`, `v${i}\n`); commitAll(repo, `c${i}`) }
  const checkout = (await resolveGitCheckout(repo))!
  const first = await readDocumentHistory(checkout, null, LIMITS, { maxCommits: 1 })
  assert.equal(first.error, null)
  assert.equal(first.changes.length, 1)
  const configPath = join(repo, '.git', 'config')
  const original = readFileSync(configPath, 'utf8')
  // An invalid diff.renameLimit kills `log` (it parses diff config) but not rev-list, for-each-ref or cat-file.
  writeFileSync(configPath, original + '[diff]\n\trenameLimit = bogus\n')
  try {
    for (let i = 0; i < 2; i++) {
      const failed = await readDocumentHistory(checkout, first.cursor, LIMITS, { maxCommits: 1 })
      assert.equal(failed.error, 'exit-nonzero')
      assert.equal(failed.cursor, first.cursor)
      assert.deepEqual(failed.changes, [])
      assert.deepEqual(failed.gaps, [])
    }
  } finally {
    writeFileSync(configPath, original)
  }
  const rest = await drainHistory(checkout, first.cursor, LIMITS, { maxCommits: 1 })
  assert.deepEqual([...first.changes, ...rest.changes].map(ch => ch.path).sort(), ['e0.md', 'e1.md', 'e2.md'])
  assert.equal(rest.pages.at(-1)!.complete, true)
})

test('history covers branches, tags, detached worktree HEADs and merges, and reports rewritten refs', async () => {
  const repo = newRepo()
  put(repo, 'base.md', 'base\n'); commitAll(repo, 'base')
  git(repo, ['checkout', '-q', '-b', 'side'])
  put(repo, 'conf.md', 'side\n'); put(repo, 'side.md', 'side\n'); const sideOid = commitAll(repo, 'side')
  git(repo, ['checkout', '-q', 'main'])
  put(repo, 'conf.md', 'main\n'); commitAll(repo, 'main')
  try { git(repo, ['merge', '-q', 'side']) } catch { /* conflict */ }
  put(repo, 'conf.md', 'resolved\n')
  const merge = commitAll(repo, 'merge side')
  git(repo, ['checkout', '-q', '--orphan', 'tagged-only'])
  put(repo, 'tagged.md', 'tag\n'); const tagged = commitAll(repo, 'tagged')
  git(repo, ['tag', '-a', '-m', 'annotated', 'v1', tagged])
  git(repo, ['checkout', '-q', 'main'])
  git(repo, ['branch', '-D', 'tagged-only'])
  const wt = join(dirname(repo), 'detached-wt')
  git(repo, ['worktree', 'add', '-q', '--detach', wt, 'HEAD'])
  put(wt, 'detached.md', 'detached\n'); const detachedOid = commitAll(wt, 'detached work')
  const checkout = (await resolveGitCheckout(repo))!
  const first = await drainHistory(checkout, null)
  const paths = first.changes.map(ch => ch.path)
  for (const p of ['side.md', 'tagged.md', 'detached.md']) assert.ok(paths.includes(p), p)
  const mergeChange = first.changes.find(ch => ch.commit!.oid === merge)!
  assert.deepEqual([mergeChange.path, mergeChange.status, mergeChange.blobOid], ['conf.md', 'M', gitText(repo, [`rev-parse`, `${merge}:conf.md`])])
  assert.deepEqual(mergeChange.commit!.parents.length, 2)
  assert.deepEqual(first.pages.at(-1)!.detached, [detachedOid])
  assert.equal(first.pages.at(-1)!.complete, true)
  assert.ok(first.changes.some(ch => ch.commit!.oid === sideOid))

  git(repo, ['checkout', '-q', 'side'])
  git(repo, ['reset', '-q', '--hard', 'HEAD~1'])
  put(repo, 'rewritten.md', 'new history\n'); const rewritten = commitAll(repo, 'rewrite side')
  git(repo, ['checkout', '-q', 'main'])
  const after = await drainHistory(checkout, first.cursor)
  assert.deepEqual(after.pages.at(-1)!.rewrittenRefs, ['refs/heads/side'])
  assert.deepEqual(after.changes.map(ch => [ch.commit!.oid, ch.path]), [[rewritten, 'rewritten.md']])
  assert.equal(after.pages.at(-1)!.complete, true)
})

test('unborn repositories are explicit and never empty-and-complete', async () => {
  const repo = newRepo()
  const checkout = (await resolveGitCheckout(repo))!
  const page = await readDocumentHistory(checkout, null, LIMITS)
  assert.equal(page.unborn, true)
  assert.equal(page.changes.length, 0)
  assert.equal(page.complete, false)
  assert.equal(page.hasMore, false)
  put(repo, 'a.md'); commitAll(repo, 'born')
  const born = await drainHistory(checkout, page.cursor)
  assert.deepEqual(born.changes.map(ch => ch.path), ['a.md'])
  assert.equal(born.pages.at(-1)!.unborn, false)
  assert.equal(born.pages.at(-1)!.complete, true)
})

test('shallow clones report the boundary and stay incomplete', async () => {
  const src = newRepo({ name: 'src' })
  for (let i = 0; i < 3; i++) { put(src, `d${i}.md`, `v${i}\n`); commitAll(src, `c${i}`) }
  const parent = realpathSync(tempDir('atlas-git-shallow-'))
  const clone = join(parent, 'clone')
  git(parent, ['clone', '-q', '--depth', '1', `file://${src}`, clone])
  const checkout = (await resolveGitCheckout(clone))!
  assert.equal(checkout.shallow, true)
  const { pages, changes } = await drainHistory(checkout, null)
  const last = pages.at(-1)!
  assert.equal(last.shallow, true)
  assert.equal(last.complete, false)
  assert.ok(last.gaps.includes('shallow'))
  assert.ok(changes.length > 0)
  assert.ok(changes.every(ch => ch.commit!.shallowBoundary), 'the only reachable commit is the shallow boundary')
  const again = await readDocumentHistory(checkout, last.cursor, LIMITS)
  assert.equal(again.complete, false, 'the gap is sticky')
})

test('missing blob and commit objects are reported, not treated as complete', async () => {
  const repo = newRepo()
  put(repo, 'keep.md', 'keep\n'); commitAll(repo, 'one')
  put(repo, 'lost.md', 'this blob will be deleted\n'); commitAll(repo, 'two')
  const blob = gitText(repo, ['rev-parse', 'HEAD:lost.md'])
  rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
  const checkout = (await resolveGitCheckout(repo))!
  const { pages, changes } = await drainHistory(checkout, null)
  const last = pages.at(-1)!
  assert.ok(last.missingObjects.includes(blob))
  assert.equal(last.complete, false)
  const lost = changes.find(ch => ch.path === 'lost.md')!
  assert.equal(lost.blobOid, blob)
  assert.equal(lost.size, null)
  assert.equal(lost.blobState, 'missing')
  assert.ok(changes.filter(ch => ch.path !== 'lost.md').every(ch => ch.blobState === 'present'))

  const repo2 = newRepo()
  put(repo2, 'a.md', 'a\n'); const root = commitAll(repo2, 'root')
  put(repo2, 'b.md', 'b\n'); commitAll(repo2, 'child')
  rmSync(join(repo2, '.git', 'objects', root.slice(0, 2), root.slice(2)))
  const broken = await drainHistory((await resolveGitCheckout(repo2))!, null)
  assert.equal(broken.pages.at(-1)!.complete, false, 'a walk that cannot read a parent commit is incomplete')
  assert.ok(broken.pages.at(-1)!.gaps.length > 0)
})

test('Git LFS pointers are flagged and nothing is fetched or smudged', async () => {
  const repo = newRepo()
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12345\n'
  put(repo, 'deck.pptx', pointer); put(repo, 'notes.md', 'version https://example.com/not-lfs\n')
  commitAll(repo, 'lfs')
  const checkout = (await resolveGitCheckout(repo))!
  const { changes } = await drainHistory(checkout, null)
  assert.equal(changes.find(ch => ch.path === 'deck.pptx')!.lfsPointer, true)
  assert.equal(changes.find(ch => ch.path === 'notes.md')!.lfsPointer, false)
})

test('history respects lookback and document-extension filters without claiming the older history', async () => {
  const repo = newRepo()
  const old = { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' }
  put(repo, 'old.md'); commitAll(repo, 'old', old)
  put(repo, 'new.md'); put(repo, 'Upper.MD'); put(repo, 'code.ts'); commitAll(repo, 'new')
  const checkout = (await resolveGitCheckout(repo))!
  const notBefore = Math.floor(Date.now() / 1000) - 7 * 86400
  const { pages, changes } = await drainHistory(checkout, null, LIMITS, { notBefore, documentExtensions: ['md'] })
  assert.deepEqual(changes.map(ch => ch.path).sort(), ['Upper.MD', 'new.md'])
  assert.equal(pages.at(-1)!.lookbackLimited, true)
  const full = await drainHistory(checkout, null, LIMITS, {})
  assert.deepEqual(full.changes.map(ch => ch.path).sort(), ['Upper.MD', 'code.ts', 'new.md', 'old.md'])
  assert.equal(full.pages.at(-1)!.lookbackLimited, false)
})

test('history under an output cap salvages whole commits, skips an oversized commit as a gap and terminates', async () => {
  const repo = newRepo()
  put(repo, 'small.md'); commitAll(repo, 'small')
  for (let i = 0; i < 80; i++) put(repo, `bulk/doc-${i}.md`, `bulk ${i}\n`)
  const bulk = commitAll(repo, 'bulk')
  put(repo, 'after.md'); commitAll(repo, 'after')
  const checkout = (await resolveGitCheckout(repo))!
  const { pages, changes } = await drainHistory(checkout, null, { timeoutMs: 10_000, maxOutputBytes: 2048 })
  const last = pages.at(-1)!
  assert.equal(last.complete, false)
  assert.ok(last.gaps.includes('oversized-commit'))
  assert.ok(pages.some(p => p.oversizedCommits.includes(bulk)))
  assert.ok(changes.some(ch => ch.path === 'small.md'))
  assert.ok(changes.some(ch => ch.path === 'after.md'))
  assert.ok(!changes.some(ch => ch.commit!.oid === bulk), 'no partial commit is emitted')
  assert.ok(pages.some(p => p.truncated))
  assert.ok(pages.every(p => p.error === null), 'a deterministic cap is progress with a recorded gap, not an error')
  // The skipped OID is kept in the cursor and retried once a larger cap is available.
  const retried = await drainHistory(checkout, pages.at(-1)!.cursor, LIMITS)
  assert.equal(retried.changes.filter(ch => ch.commit!.oid === bulk).length, 80)
  assert.equal(retried.pages.at(-1)!.complete, true)
  assert.deepEqual(retried.pages.at(-1)!.gaps, [])
})

test('a stalled Git (FIFO include) returns the input cursor with an error; recovery imports every commit', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const repo = newRepo()
  for (let i = 0; i < 8; i++) { put(repo, `d${i}.md`, `v${i}\n`); commitAll(repo, `c${i}`) }
  const checkout = (await resolveGitCheckout(repo))!
  const first = await readDocumentHistory(checkout, null, LIMITS, { maxCommits: 2 })
  assert.equal(first.error, null)
  const got = new Set(first.changes.map(ch => ch.path))
  let cursor = first.cursor
  const fifo = makeFifo('atlas-git-stall-')
  const configPath = join(repo, '.git', 'config')
  const original = readFileSync(configPath, 'utf8')
  writeFileSync(configPath, original + `[include]\n\tpath = ${fifo}\n`)
  try {
    for (let i = 0; i < 4; i++) {
      const stalled = await readDocumentHistory(checkout, cursor, { timeoutMs: 300, maxOutputBytes: LIMITS.maxOutputBytes }, { maxCommits: 2 })
      assert.equal(stalled.error, 'timeout')
      assert.equal(stalled.timedOut, true)
      assert.equal(stalled.cursor, cursor, 'nothing consumed: the input cursor comes back unchanged')
      assert.deepEqual(stalled.changes, [])
      assert.equal(stalled.complete, false)
      cursor = stalled.cursor
    }
  } finally {
    writeFileSync(configPath, original)
    releaseFifo(fifo)
    rmSync(fifo, { force: true })
  }
  const rest = await drainHistory(checkout, cursor, LIMITS, { maxCommits: 2 })
  for (const ch of rest.changes) got.add(ch.path)
  assert.deepEqual([...got].sort(), Array.from({ length: 8 }, (_, i) => `d${i}.md`), 'no commit was skipped')
  assert.equal(rest.pages.at(-1)!.complete, true)
  assert.deepEqual(rest.pages.at(-1)!.gaps, [])
})

test('history batches object metadata: process count does not grow with the number of files', async () => {
  const repo = newRepo()
  for (let i = 0; i < 60; i++) put(repo, `docs/d${i}.md`, `doc ${i}\n`)
  commitAll(repo, 'sixty')
  const checkout = (await resolveGitCheckout(repo))!
  const before = artifactGitSpawnCount()
  const page = await readDocumentHistory(checkout, null, LIMITS)
  const spawned = artifactGitSpawnCount() - before
  assert.equal(page.changes.length, 60)
  assert.ok(page.changes.every(ch => typeof ch.size === 'number' && ch.lfsPointer === false))
  assert.ok(spawned <= 10, `spawned ${spawned} processes for 60 files`)
})

test('history rejects a cursor from another object format or a corrupted cursor', async () => {
  const repo = newRepo()
  put(repo, 'a.md'); commitAll(repo, 'one')
  const checkout = (await resolveGitCheckout(repo))!
  const page = await readDocumentHistory(checkout, null, LIMITS)
  const bad = await readDocumentHistory(checkout, 'not a cursor', LIMITS)
  assert.equal(bad.error, 'invalid-cursor')
  assert.equal(bad.cursor, 'not a cursor', 'an error never changes the cursor')
  assert.equal(bad.complete, false)
  const other = await readDocumentHistory({ ...checkout, objectFormat: 'sha256' }, page.cursor, LIMITS)
  assert.equal(other.error, 'invalid-cursor')
  assert.equal(other.complete, false)
})

// PERF-GAP-4 (R63, Wave 2a): one blob of a known size is collected once, into a buffer of exactly that size, never as chunks
// plus their concatenation (two copies of a 64 MiB export). Every other size still comes back exactly as Git wrote it.
test('PERF-GAP-4: a blob of the expected size is collected into one buffer; any other size is returned exactly, within the cap', async () => {
  const repo = newRepo()
  const size = 4 * 1024 * 1024
  const content = Buffer.alloc(size)
  for (let i = 0; i < size; i++) content[i] = 97 + (i % 26)
  put(repo, 'big.md', content)
  commitAll(repo, 'big')
  const oid = gitText(repo, ['rev-parse', 'HEAD:big.md'])
  const limits = { timeoutMs: 10_000, maxOutputBytes: size + 1 }
  const concatenated: number[] = []
  const original = Buffer.concat
  Buffer.concat = ((list: readonly Uint8Array[], total?: number) => {
    const b = original(list, total)
    concatenated.push(b.length)
    return b
  }) as typeof Buffer.concat
  let exact
  try {
    exact = await runArtifactGit(repo, ['cat-file', 'blob', oid], limits, { expectedBytes: size })
  } finally {
    Buffer.concat = original
  }
  assert.equal(exact.error, null)
  assert.ok(exact.stdout.equals(content), 'the exact bytes')
  assert.deepEqual(concatenated.filter(n => n >= size), [], 'the blob was never concatenated from chunks')
  // A wrong expectation changes nothing about the answer: more bytes than expected, fewer, or more than the cap.
  const more = await runArtifactGit(repo, ['cat-file', 'blob', oid], limits, { expectedBytes: size - 10 })
  assert.equal(more.error, null)
  assert.ok(more.stdout.equals(content), 'a larger blob is returned whole')
  const fewer = await runArtifactGit(repo, ['cat-file', 'blob', oid], limits, { expectedBytes: size + 1 })
  assert.equal(fewer.stdout.length, size, 'a smaller blob is returned at its own length')
  assert.ok(fewer.stdout.equals(content))
  const capped = await runArtifactGit(repo, ['cat-file', 'blob', oid], { timeoutMs: 10_000, maxOutputBytes: 1024 }, { expectedBytes: size })
  assert.equal(capped.error, 'output-cap')
  assert.equal(capped.stdout.length, 1024)
  assert.ok(capped.stdout.equals(content.subarray(0, 1024)))
  // An unusable expectation (negative, fractional or above the cap) is ignored, never trusted.
  for (const expectedBytes of [-1, 1.5, size + 2]) {
    const r = await runArtifactGit(repo, ['cat-file', 'blob', oid], limits, { expectedBytes })
    assert.ok(r.stdout.equals(content), `expectedBytes ${expectedBytes}`)
  }
})

test('fix round 1 (I3): a run pinned to a repository directory never answers from a repository Git would discover above it', async () => {
  const outer = newRepo({ name: 'outer' })
  put(outer, 'doc.md', 'outer bytes\n')
  commitAll(outer, 'outer')
  const oid = gitText(outer, ['rev-parse', 'HEAD:doc.md'])
  // A checkout folder inside the outer repository whose own .git is gone.
  const inner = join(outer, 'inner')
  mkdirSync(inner)
  const input = Buffer.from(`${oid}\n`)
  const climbing = await runArtifactGit(inner, ['cat-file', '--batch-check'], LIMITS, { input })
  assert.equal(climbing.error, null)
  assert.match(climbing.stdout.toString('latin1'), / blob 12\n$/, 'control: unpinned, Git answers from the enclosing repository')
  const pinned = await runArtifactGit(inner, ['cat-file', '--batch-check'], LIMITS, { input, gitDir: join(inner, '.git') })
  assert.notEqual(pinned.error, null, 'a pinned repository that is not there is an error, never an answer')
  assert.equal(pinned.stdout.length, 0)
  // Pinned to a repository that is there, the answer is that repository's own.
  const own = await runArtifactGit(inner, ['cat-file', '--batch-check'], LIMITS, { input, gitDir: join(outer, '.git') })
  assert.equal(own.error, null)
  assert.match(own.stdout.toString('latin1'), / blob 12\n$/)
  // An unusable pin is refused before anything runs.
  for (const gitDir of ['relative/.git', `${outer}/.git\0x`]) {
    assert.equal((await runArtifactGit(inner, ['cat-file', '--batch-check'], LIMITS, { input, gitDir })).error, 'refused-repo-path')
  }
})
