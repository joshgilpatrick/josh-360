import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPath } from '../../src/artifacts/filetype.ts'
import { configureSensitivePatterns, isSensitiveFilename } from '../../src/artifacts/filetype.ts'

test('classifies common extensions', () => {
  assert.deepEqual(classifyPath('/x/report.MD'), { filename: 'report.MD', extension: 'md', fileType: 'document', mimeType: 'text/markdown', sensitive: false })
  assert.equal(classifyPath('/x/data.xlsx').fileType, 'spreadsheet')
  assert.equal(classifyPath('/x/deck.pptx').fileType, 'presentation')
  assert.equal(classifyPath('/x/app.py').fileType, 'code')
  assert.equal(classifyPath('/x/settings.yaml').fileType, 'config')
  assert.equal(classifyPath('/x/.env').extension, 'env')
  assert.equal(classifyPath('/x/.env').fileType, 'config')
  assert.equal(classifyPath('/x/rows.parquet').fileType, 'data')
  assert.equal(classifyPath('/x/nb.ipynb').fileType, 'notebook')
  assert.equal(classifyPath('/x/logo.png').mimeType, 'image/png')
  assert.equal(classifyPath('/x/bundle.tar.gz').extension, 'gz')
  assert.equal(classifyPath('/x/bundle.tar.gz').fileType, 'archive')
  assert.deepEqual(classifyPath('/x/Makefile'), { filename: 'Makefile', extension: '', fileType: 'other', mimeType: null, sensitive: false })
})

test('secret-looking filenames are flagged sensitive by name only', () => {
  for (const n of ['.env', '.env.local', '.env.functions.local', 'server.pem', 'private.key', 'store.p12', 'app.pfx', 'release.jks', 'id_rsa', 'id_ed25519.pub', 'credentials.json', 'secrets.yaml', 'secret', 'api.token', '.netrc', '.npmrc', '.pypirc'])
    assert.equal(isSensitiveFilename(n), true, n)
  for (const n of ['README.md', 'environment.md', 'keyboard.ts', 'tokens.css', 'secretary-notes.md'])
    assert.equal(isSensitiveFilename(n), false, n)
  assert.equal(classifyPath('/x/.env.local').sensitive, true)
  assert.equal(classifyPath('/x/report.md').sensitive, false)
})

test('config.json sensitive patterns are simple filename globs', () => {
  configureSensitivePatterns(['*.kdbx', 'vault-*'])
  try {
    assert.equal(isSensitiveFilename('passwords.kdbx'), true)
    assert.equal(isSensitiveFilename('vault-prod.json'), true)
    assert.equal(isSensitiveFilename('kdbx-notes.md'), false)
  } finally {
    configureSensitivePatterns([])
  }
  assert.equal(isSensitiveFilename('passwords.kdbx'), false)
})
