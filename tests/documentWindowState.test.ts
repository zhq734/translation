import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DOCUMENT_WINDOW_STATE_FILE,
  loadDocumentWindowState,
  saveDocumentWindowState
} from '../src/main/documentWindowState.ts'

test('文档窗口状态文件必须使用固定名称且只持久化窗口边界', () => {
  assert.equal(DOCUMENT_WINDOW_STATE_FILE, 'document-workspace-window.json')
  const directory = mkdtempSync(join(tmpdir(), 'document-window-state-'))
  try {
    const filePath = join(directory, DOCUMENT_WINDOW_STATE_FILE)
    saveDocumentWindowState(filePath, { x: 120, y: 80, width: 1180, height: 780 })
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
      x: 120,
      y: 80,
      width: 1180,
      height: 780
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('窗口状态缺失、JSON 损坏或字段非法时必须安全回退', () => {
  const directory = mkdtempSync(join(tmpdir(), 'document-window-state-invalid-'))
  try {
    const missing = join(directory, 'missing.json')
    assert.equal(loadDocumentWindowState(missing), null)

    const corrupt = join(directory, 'corrupt.json')
    writeFileSync(corrupt, '{not-json')
    assert.equal(loadDocumentWindowState(corrupt), null)

    const array = join(directory, 'array.json')
    writeFileSync(array, '[]')
    assert.equal(loadDocumentWindowState(array), null)

    const invalid = join(directory, 'invalid.json')
    writeFileSync(invalid, JSON.stringify({ x: 0, y: 0, width: 0, height: -1 }))
    assert.equal(loadDocumentWindowState(invalid), null)

    const infinite = join(directory, 'infinite.json')
    writeFileSync(infinite, '{"x":1,"y":2,"width":1e999,"height":780}')
    assert.equal(loadDocumentWindowState(infinite), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
