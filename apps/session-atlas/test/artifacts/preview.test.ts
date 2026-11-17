import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewModeFor, previewContentType, PREVIEW_MAX_BYTES } from '../../src/artifacts/preview.ts'

test('text, code, and raster-image extensions preview inline', () => {
  for (const e of ['txt', 'md', 'json', 'py', 'js', 'ts', 'csv', 'yaml', 'sql', 'log']) assert.equal(previewModeFor(e), 'inline', e)
  for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp']) assert.equal(previewModeFor(e), 'inline', e)
})

test('html opens in a tab and office formats open externally', () => {
  assert.equal(previewModeFor('html'), 'tab')
  for (const e of ['pdf', 'docx', 'xlsx', 'pptx', 'ipynb']) assert.equal(previewModeFor(e), 'external', e)
})

test('svg, archives, unknown, and inherited object keys are never previewable', () => {
  for (const e of ['svg', 'zip', 'gz', 'dmg', 'sqlite', 'parquet', 'exe', '', 'weird', 'constructor', '__proto__']) {
    assert.equal(previewModeFor(e), 'none', e)
    assert.equal(previewContentType(e), null, e)
  }
})

test('extension matching is case-insensitive and tolerates a leading dot', () => {
  assert.equal(previewModeFor('MD'), 'inline')
  assert.equal(previewModeFor('.PNG'), 'inline')
  assert.equal(previewModeFor('.Html'), 'tab')
})

test('inline content types are exact, charset-qualified for text, and null for non-previewable', () => {
  assert.equal(previewContentType('md'), 'text/markdown; charset=utf-8')
  assert.equal(previewContentType('json'), 'application/json; charset=utf-8')
  assert.equal(previewContentType('py'), 'text/plain; charset=utf-8')
  assert.equal(previewContentType('png'), 'image/png')
  assert.equal(previewContentType('html'), 'text/html; charset=utf-8')
  assert.equal(previewContentType('svg'), null)
  assert.equal(previewContentType('docx'), null)
})

test('the preview size ceiling is a positive safe integer', () => {
  assert.ok(Number.isSafeInteger(PREVIEW_MAX_BYTES) && PREVIEW_MAX_BYTES > 0)
})
