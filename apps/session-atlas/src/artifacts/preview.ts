// Preview classification (spec §5.8). Deliberately its own allowlist rather than a reuse of
// filetype.ts's MIME map: that map exists to label rows in the index, while this one decides
// what the server is willing to read off disk and hand to a browser. svg is excluded on purpose
// -- an inline SVG can carry script -- as is every archive and binary data format.
export type PreviewMode = 'inline' | 'tab' | 'external' | 'none'

export const PREVIEW_MAX_BYTES = 2_000_000

const TEXT_TYPES: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', jsonc: 'application/json', yaml: 'application/yaml', yml: 'application/yaml',
  toml: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'application/xml', css: 'text/css',
  js: 'text/plain', mjs: 'text/plain', cjs: 'text/plain', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  py: 'text/plain', rb: 'text/plain', go: 'text/plain', rs: 'text/plain', java: 'text/plain',
  sh: 'text/plain', bash: 'text/plain', zsh: 'text/plain', sql: 'text/plain',
}
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const EXTERNAL = new Set(['pdf', 'docx', 'xlsx', 'xlsm', 'pptx', 'doc', 'xls', 'ppt', 'key', 'numbers', 'pages', 'odt', 'ods', 'odp', 'ipynb'])

const norm = (extension: string): string => extension.trim().toLowerCase().replace(/^\./, '')

export function previewModeFor(extension: string): PreviewMode {
  const e = norm(extension)
  if (e === 'html') return 'tab'
  if (Object.hasOwn(TEXT_TYPES, e) || Object.hasOwn(IMAGE_TYPES, e)) return 'inline'
  if (EXTERNAL.has(e)) return 'external'
  return 'none'
}

// Every text type is charset-qualified so a browser never sniffs an encoding; combined with the
// nosniff header the response can only ever be interpreted as the type named here.
export function previewContentType(extension: string): string | null {
  const e = norm(extension)
  if (e === 'html') return 'text/html; charset=utf-8'
  if (Object.hasOwn(IMAGE_TYPES, e)) return IMAGE_TYPES[e]!
  if (Object.hasOwn(TEXT_TYPES, e)) return `${TEXT_TYPES[e]}; charset=utf-8`
  return null
}
