import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { relative } from 'node:path'

/**
 * The path limits a fixture has to fit on every platform the suite runs on. macOS allows a path of at most 1,024 bytes including
 * the terminating NUL (PATH_MAX) and a name of at most 255 bytes; Linux allows 4,096. A fixture built for the smaller limit
 * runs unchanged on both, so no test branches on the platform.
 */
export const PORTABLE_PATH_MAX = 1023
export const PORTABLE_NAME_MAX = 255
/** A macOS temporary folder as `realpath` spells it, as a worst case (`/var/folders/<2>/<30>/T` lives under `/private`). */
export const MAC_TEMP_PREFIX = '/private/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T'

/**
 * The byte length `absolute` (under the real temporary folder) would have if that folder were macOS's: only the folder prefix is
 * swapped, so the mkdtemp names and everything below them count as they are.
 */
export function portablePathBytes(absolute: string): number {
  const rel = relative(realpathSync(tmpdir()), absolute)
  if (rel.startsWith('..')) throw new Error(`${absolute} is not under the temporary folder`)
  return Buffer.byteLength(`${MAC_TEMP_PREFIX}/${rel}`)
}

/** Fails with the measured length when a path a fixture creates would not fit the portable limit, or one of its names would not. */
export function assertPortablePath(absolute: string, what = 'fixture path'): void {
  const bytes = portablePathBytes(absolute)
  if (bytes > PORTABLE_PATH_MAX) throw new Error(`${what} is ${bytes} bytes against a macOS-style temp prefix; the portable limit is ${PORTABLE_PATH_MAX}`)
  for (const name of relative(realpathSync(tmpdir()), absolute).split('/')) {
    if (Buffer.byteLength(name) > PORTABLE_NAME_MAX) throw new Error(`${what} has a ${Buffer.byteLength(name)}-byte name; the portable limit is ${PORTABLE_NAME_MAX}`)
  }
}

/**
 * Extensions and a root for a listing that needs two `ls-files` launches (`chunkBytes`: the product's argv budget per launch for
 * pathspecs) with 64 extensions, the most one call takes. Each extension is 16 bytes, the longest allowed, so the pathspecs are
 * as long as they can be without the files' paths being so. The root's names are made of glob magic (`?`, `[`, `*`), each of
 * which the pathspec escapes with one more byte, so a root of about 500 bytes on disk makes about 1 KB of pathspec. `lookalike`
 * is a path the root would match were its magic not escaped.
 */
export function twoLaunchFixture(chunkBytes: number): { root: string; lookalike: string; exts: string[]; first: string; last: string } {
  const exts = Array.from({ length: 64 }, (_, i) => `e${String(i).padStart(15, '0')}`) // sorted: [0] in the first launch, [63] in the second
  const segments = 3
  const specBytes = Buffer.byteLength(':(glob,icase)**/*.') + 16 + 1 // one pathspec's argv bytes without the root; +1 for its NUL
  const escapedRoot = Math.floor(chunkBytes / exts.length) - specBytes + 1 // the root bytes at which 64 pathspecs first exceed one launch
  const marks = 6 // per name: `[i]*` is 4 bytes on disk and 6 in the pathspec
  const unit = Math.ceil((escapedRoot - segments) / segments) // a name's bytes in the pathspec, with the `/` after it
  const run = Math.ceil((unit - marks) / 2) // `?` marks, each 1 byte on disk and 2 in the pathspec
  const names = Array.from({ length: segments }, (_, i) => `${'?'.repeat(run)}[${i}]*`)
  const root = names.join('/')
  const lookalike = Array.from({ length: segments }, (_, i) => `${'r'.repeat(run)}${i}`).join('/')
  const escaped = Buffer.byteLength(root.replace(/[\\*?[]/g, c => `\\${c}`)) + 1
  if (exts.length * (specBytes + escaped) <= chunkBytes) throw new Error(`fixture root of ${escaped} pathspec bytes does not need a second launch`)
  return { root, lookalike, exts, first: exts[0]!, last: exts.at(-1)! }
}
