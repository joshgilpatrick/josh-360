import { basename, extname } from 'node:path'

export const FILE_TYPES = ['document', 'spreadsheet', 'presentation', 'code', 'config', 'data', 'notebook', 'image', 'archive', 'other'] as const
export type FileType = typeof FILE_TYPES[number]

const BY_TYPE: Record<Exclude<FileType, 'other'>, string[]> = {
  document: ['md', 'markdown', 'txt', 'rtf', 'doc', 'docx', 'pdf', 'odt', 'tex', 'log'],
  spreadsheet: ['csv', 'tsv', 'xls', 'xlsx', 'xlsm', 'ods', 'numbers'],
  presentation: ['ppt', 'pptx', 'key', 'odp'],
  code: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'sh', 'zsh', 'bash', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'php', 'r', 'scala', 'lua', 'pl'],
  config: ['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'plist', 'xml', 'properties', 'editorconfig', 'gitignore'],
  data: ['parquet', 'db', 'sqlite', 'sqlite3', 'jsonl', 'ndjson', 'avro', 'arrow', 'feather', 'pkl', 'npy', 'h5'],
  notebook: ['ipynb'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tiff', 'heic', 'ico'],
  archive: ['zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'rar', 'dmg'],
}
const TYPE_OF: Record<string, FileType> = {}
for (const [t, exts] of Object.entries(BY_TYPE)) for (const e of exts) TYPE_OF[e] = t as FileType

const MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/x-ndjson', yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml', html: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sh: 'application/x-sh', sql: 'application/sql',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ipynb: 'application/x-ipynb+json', parquet: 'application/vnd.apache.parquet',
}

// Filename-only patterns (H2). The index never reads file content; these mark rows so the UI
// hides them by default. Matched case-insensitively against the basename.
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|secret|token)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /^credentials(\..+)?$/i,
  /^secrets?(\..+)?$/i,
  /^\.(netrc|npmrc|pypirc)$/i,
]
let extraSensitive: RegExp[] = []

function globToRegExp(glob: string): RegExp {
  const escaped = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`, 'i')
}

// Called once at service start with config.artifacts.sensitivePatterns. Replaces the extra set.
export function configureSensitivePatterns(globs: string[]): void {
  extraSensitive = globs.map(globToRegExp)
}

export function isSensitiveFilename(filename: string): boolean {
  return SENSITIVE_PATTERNS.some(re => re.test(filename)) || extraSensitive.some(re => re.test(filename))
}

export function classifyPath(path: string): { filename: string; extension: string; fileType: FileType; mimeType: string | null; sensitive: boolean } {
  const filename = basename(path)
  let extension = extname(filename).slice(1).toLowerCase()
  if (!extension && filename.startsWith('.') && filename.length > 1 && !filename.slice(1).includes('.')) extension = filename.slice(1).toLowerCase()
  return { filename, extension, fileType: TYPE_OF[extension] ?? 'other', mimeType: MIME[extension] ?? null, sensitive: isSensitiveFilename(filename) }
}
