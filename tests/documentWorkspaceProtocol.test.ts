import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentModel, DocumentTextBlock } from '../src/shared/documentTypes.ts'
import {
  DOCUMENT_WORKSPACE_CHANNELS,
  applyDocumentWorkspaceTranslationUpdate,
  normalizeDocumentRunRequest,
  normalizeDocumentTargetId,
  normalizeDocumentTaskIdentityRequest,
  type DocumentWorkspaceTranslationUpdate,
  type DocumentWorkspaceSnapshot
} from '../src/shared/documentWorkspace.ts'

/**
 * 创建包含两个文本区块的最小文档模型。
 * @param path 源文件路径。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(path = '/tmp/sample.txt'): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path,
      fileName: 'sample.txt',
      format: 'txt',
      sha256: 'fixture',
      size: 11
    },
    metadata: { direction: 'auto' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 600,
      height: 800,
      blocks: [
        {
          kind: 'text',
          blockId: 'block-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-1', text: 'Hello' }]
        },
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }],
    assets: [],
    warnings: []
  }
}

/**
 * 创建运行中的工作台快照。
 * @returns 工作台快照。
 * @author zhenghq
 */
function snapshot(): DocumentWorkspaceSnapshot {
  const source = model()
  return {
    jobId: 'job-1',
    generation: 1,
    task: {
      jobId: 'job-1',
      generation: 1,
      phase: 'translate',
      status: 'translating',
      progress: { completed: 0, total: 2 },
      phaseCompleted: false,
      failedBlocks: 0,
      warningCount: 0,
      cancellationRequested: false
    },
    percent: 40,
    source,
    translation: model(),
    sourcePreference: 'EN',
    targetPreference: 'ZH',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  }
}

/**
 * 创建匹配第一个文本区块的增量事件。
 * @returns 块级增量事件。
 * @author zhenghq
 */
function update(): DocumentWorkspaceTranslationUpdate {
  return {
    jobId: 'job-1',
    generation: 1,
    pageId: 'page-1',
    blockId: 'block-1',
    block: {
      kind: 'text',
      blockId: 'block-1',
      readingOrder: 0,
      translatable: true,
      role: 'paragraph',
      runs: [{ runId: 'run-1', text: '你好' }]
    },
    completed: 1,
    total: 2
  }
}

test('文档工作台协议必须暴露独立的块增量通道', () => {
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.blockTranslated, 'document:block-translated')
})

test('文档工作台协议必须暴露历史与缓存管理通道', () => {
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.listHistory, 'document:list-history')
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.openHistory, 'document:open-history')
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.deleteHistory, 'document:delete-history')
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.clearCache, 'document:clear-cache')
})

test('文档运行请求必须只保留白名单字段并校验模式与代际', () => {
  assert.deepEqual(normalizeDocumentRunRequest({
    path: '/tmp/example.pdf',
    generation: 3,
    sourceLang: 'EN',
    targetLang: 'ZH',
    mode: 'translation'
  }), {
    path: '/tmp/example.pdf',
    generation: 3,
    sourceLang: 'EN',
    targetLang: 'ZH',
    mode: 'translation'
  })

  assert.deepEqual(normalizeDocumentRunRequest({
    path: '/tmp/example.pdf',
    generation: 4,
    mode: 'ocr',
    filePath: '/tmp/escape.pdf',
    url: 'file:///tmp/escape.pdf',
    command: 'open /tmp'
  }), {
    path: '/tmp/example.pdf',
    generation: 4,
    mode: 'ocr'
  })

  assert.equal(normalizeDocumentRunRequest(null), null)
  assert.equal(normalizeDocumentRunRequest([]), null)
  assert.equal(normalizeDocumentRunRequest({ path: '', generation: 1 }), null)
  assert.equal(normalizeDocumentRunRequest({ path: '/tmp/example.pdf', generation: 0 }), null)
  assert.equal(normalizeDocumentRunRequest({ path: '/tmp/example.pdf', generation: 1.5 }), null)
  assert.equal(normalizeDocumentRunRequest({ path: '/tmp/example.pdf', generation: 1, mode: 'invalid' }), null)
})

test('文档运行请求必须拒绝 URL、空字节、换行与命令式路径', () => {
  const invalidPaths = [
    'https://example.com/example.pdf',
    'http://example.com/example.pdf',
    'file:///tmp/example.pdf',
    '/tmp/example.pdf\u0000.txt',
    '/tmp/example.pdf\nopen /tmp',
    '/tmp/example.pdf\r\nopen /tmp',
    '$(open /tmp)',
    '`open /tmp`',
    'open /tmp',
    'document.pdf'
  ]

  for (const path of invalidPaths) {
    assert.equal(
      normalizeDocumentRunRequest({ path, generation: 1, mode: 'translation' }),
      null,
      `应拒绝非本机绝对路径：${JSON.stringify(path)}`
    )
  }
})

test('文档任务身份必须拒绝伪造代际、路径式任务标识与控制字符', () => {
  assert.deepEqual(normalizeDocumentTaskIdentityRequest({ jobId: 'job-1', generation: 2 }), {
    jobId: 'job-1',
    generation: 2
  })
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: 'job-1', generation: 0 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: 'job-1', generation: -1 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: 'job-1', generation: 1.5 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: 'job-1', generation: Number.MAX_SAFE_INTEGER + 1 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: '', generation: 1 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: ' ', generation: 1 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: 'job\u0000-1', generation: 1 }), null)
  assert.equal(normalizeDocumentTaskIdentityRequest({ jobId: '/tmp/sample.pdf', generation: 1 }) !== null, true)
})

test('文档目标标识必须拒绝空值、控制字符和超长输入', () => {
  assert.equal(normalizeDocumentTargetId('0:0:text:run-1'), '0:0:text:run-1')
  assert.equal(normalizeDocumentTargetId(''), null)
  assert.equal(normalizeDocumentTargetId('   '), null)
  assert.equal(normalizeDocumentTargetId('0:0:text:run\n1'), null)
  assert.equal(normalizeDocumentTargetId('x'.repeat(513)), null)
  assert.equal(normalizeDocumentTargetId(42), null)
})

test('块增量必须原位替换匹配译文区块并同步翻译进度', () => {
  const previous = snapshot()
  const before = structuredClone(previous)
  const next = applyDocumentWorkspaceTranslationUpdate(previous, update())

  assert.notEqual(next, previous)
  assert.notEqual(next.translation, previous.translation)
  assert.notEqual(next.translation?.pages[0], previous.translation?.pages[0])
  assert.deepEqual(next.translation?.pages[0]?.blocks[0], update().block)
  assert.equal(next.translation?.pages[0]?.blocks[1]?.blockId, 'block-2')
  assert.deepEqual(next.task.progress, { completed: 1, total: 2 })
  assert.equal(next.percent, previous.percent)
  assert.deepEqual(next.languagePair, { sourceLang: 'EN', targetLang: 'ZH' })
  assert.deepEqual(previous, before)
})

test('块增量遇到旧代际、终态或缺失页面区块时必须返回原快照', () => {
  const previous = snapshot()
  const stale = { ...update(), generation: 2 }
  assert.equal(applyDocumentWorkspaceTranslationUpdate(previous, stale), previous)

  const terminal: DocumentWorkspaceSnapshot = {
    ...previous,
    task: { ...previous.task, status: 'completed' }
  }
  assert.equal(applyDocumentWorkspaceTranslationUpdate(terminal, update()), terminal)

  const missingPage = { ...update(), pageId: 'page-missing' }
  assert.equal(applyDocumentWorkspaceTranslationUpdate(previous, missingPage), previous)

  const missingBlock = { ...update(), blockId: 'block-missing' }
  assert.equal(applyDocumentWorkspaceTranslationUpdate(previous, missingBlock), previous)

  const noTranslation: DocumentWorkspaceSnapshot = { ...previous, translation: undefined }
  assert.equal(applyDocumentWorkspaceTranslationUpdate(noTranslation, update()), noTranslation)
})

test('块增量必须拒绝更新页面中的嵌套区块而不误改表格内容', () => {
  const previous = snapshot()
  const translation = previous.translation!
  translation.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-1',
    readingOrder: 0,
    translatable: false,
    rows: [{
      rowId: 'row-1',
      cells: [{
        cellId: 'cell-1',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'nested-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'nested-run', text: 'Nested' }]
        }]
      }]
    }]
  }]
  const nestedUpdate = {
    ...update(),
    blockId: 'nested-1',
    block: {
      kind: 'text',
      blockId: 'nested-1',
      readingOrder: 0,
      translatable: true,
      role: 'paragraph',
      runs: [{ runId: 'nested-run', text: '嵌套' }]
    } satisfies DocumentTextBlock
  }

  assert.equal(applyDocumentWorkspaceTranslationUpdate(previous, nestedUpdate), previous)
})
