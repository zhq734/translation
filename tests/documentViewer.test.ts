import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import {
  DOCUMENT_VIEWER_STATE_STORAGE_KEY,
  DOCUMENT_VIEWER_STATE_VERSION,
  clampDocumentZoom,
  createEmptyDocumentViewerState,
  createRestoredDocumentWorkspaceSnapshot,
  normalizeDocumentViewerState,
  parseDocumentPageNumber,
  parseDocumentViewerState,
  resolveDocumentBlockHighlight,
  resolveDocumentPageJump,
  resolveDocumentTocTarget,
  resolveFitDocumentZoom,
  serializeDocumentViewerState,
  validateRestoredDocumentViewerFile,
  type DocumentViewerState
} from '../src/renderer/src/documentViewer.ts'

/**
 * 构造包含目录、章节和嵌套区块的文档模型。
 * @returns 用于查看器纯函数测试的文档模型。
 * @author zhenghq
 */
function model(): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'viewer-document',
    source: {
      path: '/tmp/viewer.pdf',
      fileName: 'viewer.pdf',
      format: 'pdf',
      sha256: 'viewer-sha',
      size: 2048
    },
    metadata: { direction: 'ltr' },
    pages: [
      {
        pageId: 'page-a',
        index: 0,
        width: 600,
        height: 800,
        title: 'Contents',
        blocks: [{
          kind: 'text',
          blockId: 'toc-1',
          readingOrder: 0,
          translatable: false,
          role: 'heading',
          runs: [{ runId: 'toc-run', text: 'Chapter One' }],
          toc: { pageNumber: '2' }
        }]
      },
      {
        pageId: 'page-b',
        index: 1,
        width: 600,
        height: 800,
        title: 'Chapter One',
        blocks: [{
          kind: 'text',
          blockId: 'heading-1',
          readingOrder: 0,
          translatable: true,
          role: 'heading',
          runs: [{ runId: 'heading-run', text: 'Chapter One' }]
        }, {
          kind: 'table',
          blockId: 'table-1',
          readingOrder: 1,
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
                runs: [{ runId: 'nested-run', text: 'Nested content' }]
              }]
            }]
          }]
        }]
      },
      {
        pageId: 'page-c',
        index: 2,
        width: 600,
        height: 800,
        title: 'Chapter Two',
        blocks: [{
          kind: 'text',
          blockId: 'heading-2',
          readingOrder: 0,
          translatable: true,
          role: 'heading',
          runs: [{ runId: 'heading-2-run', text: 'Chapter Two' }]
        }]
      }
    ],
    assets: [],
    warnings: []
  }
}

test('页码输入按 1 基解析并拒绝非整数和越界页码', () => {
  assert.equal(parseDocumentPageNumber('1', 3), 1)
  assert.equal(parseDocumentPageNumber(' 3 ', 3), 3)
  assert.equal(parseDocumentPageNumber('0', 3), null)
  assert.equal(parseDocumentPageNumber('4', 3), null)
  assert.equal(parseDocumentPageNumber('1.5', 3), null)
  assert.equal(parseDocumentPageNumber('', 3), null)

  assert.deepEqual(resolveDocumentPageJump(model(), '2'), {
    pageId: 'page-b',
    pageIndex: 1,
    pageNumber: 2,
    blockId: null
  })
  assert.equal(resolveDocumentPageJump(model(), '9'), null)
})

test('目录跳转优先匹配页码，其次匹配章节标题或区块标题', () => {
  assert.deepEqual(resolveDocumentTocTarget(model(), 'Chapter One'), {
    pageId: 'page-b',
    pageIndex: 1,
    pageNumber: 2,
    blockId: 'heading-1'
  })
  assert.deepEqual(resolveDocumentTocTarget(model(), 'Chapter Two'), {
    pageId: 'page-c',
    pageIndex: 2,
    pageNumber: 3,
    blockId: 'heading-2'
  })
  assert.deepEqual(resolveDocumentTocTarget(model(), 'Chapter One', '2'), {
    pageId: 'page-b',
    pageIndex: 1,
    pageNumber: 2,
    blockId: 'heading-1'
  })
  assert.equal(resolveDocumentTocTarget(model(), 'Missing chapter'), null)
})

test('缩放必须限制在 50% 到 200%，适合宽度按页面宽度计算', () => {
  assert.equal(clampDocumentZoom(0.2), 0.5)
  assert.equal(clampDocumentZoom(1.25), 1.25)
  assert.equal(clampDocumentZoom(3), 2)
  assert.equal(clampDocumentZoom(Number.NaN), 1)
  assert.equal(resolveFitDocumentZoom(600, 360), 0.6)
  assert.equal(resolveFitDocumentZoom(100, 360), 2)
  assert.equal(resolveFitDocumentZoom(1200, 100), 0.5)
  assert.equal(resolveFitDocumentZoom(0, 360), 1)
})

test('块级双侧高亮必须解析顶层与嵌套区块，并拒绝未知页面或区块', () => {
  assert.deepEqual(resolveDocumentBlockHighlight(model(), 'page-b', 'nested-1'), {
    pageId: 'page-b',
    pageIndex: 1,
    blockId: 'nested-1',
    isNested: true
  })
  assert.deepEqual(resolveDocumentBlockHighlight(model(), 'page-c', 'heading-2'), {
    pageId: 'page-c',
    pageIndex: 2,
    blockId: 'heading-2',
    isNested: false
  })
  assert.equal(resolveDocumentBlockHighlight(model(), 'page-missing', 'heading-2'), null)
  assert.equal(resolveDocumentBlockHighlight(model(), 'page-c', 'missing-block'), null)
})

test('工作台状态必须恢复文件、语言、显示模式、缩放、滚动锚点和译文', () => {
  const state: DocumentViewerState = {
    version: 2,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'translation',
    zoom: 1.5,
    scroll: { source: 120, translation: 180 },
    activePageId: 'page-b',
    activeBlockId: 'nested-1',
    source: model(),
    translation: model()
  }
  assert.deepEqual(normalizeDocumentViewerState(state), state)
  assert.equal(DOCUMENT_VIEWER_STATE_STORAGE_KEY, 'selection-translator.document-viewer-state')
  assert.equal(DOCUMENT_VIEWER_STATE_VERSION, 2)
})

test('损坏或越界的工作台状态必须安全回退，不能恢复任意路径或未知模型', () => {
  assert.deepEqual(normalizeDocumentViewerState(null), createEmptyDocumentViewerState())
  const damaged = normalizeDocumentViewerState({
    version: 99,
    file: { path: '', name: 'x.pdf', size: -1, format: 'pdf', sha256: '' },
    sourceLang: 42,
    targetLang: 'ZH',
    viewMode: 'unknown',
    zoom: 9,
    scroll: { source: -20, translation: 'bad' },
    activePageId: 7,
    activeBlockId: 'block',
    translation: { schemaVersion: 1 }
  })
  assert.deepEqual(damaged, createEmptyDocumentViewerState())

  const bounded = normalizeDocumentViewerState({
    version: 2,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'spread',
    zoom: 9,
    scroll: { source: -20, translation: 88 },
    activePageId: 'missing',
    activeBlockId: 'missing',
    source: model(),
    translation: model()
  })
  assert.equal(bounded.zoom, 2)
  assert.deepEqual(bounded.scroll, { source: 0, translation: 88 })
  assert.equal(bounded.activePageId, 'page-a')
  assert.equal(bounded.activeBlockId, null)
})

test('显示模式必须完整支持原文、译文与对照三种状态', () => {
  const state = normalizeDocumentViewerState({
    version: 2,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'source',
    zoom: 1,
    scroll: { source: 0, translation: 0 },
    activePageId: 'page-a',
    activeBlockId: null,
    source: model(),
    translation: model()
  })

  assert.equal(state.viewMode, 'source')
  assert.equal(normalizeDocumentViewerState({ ...state, viewMode: 'translation' }).viewMode, 'translation')
  assert.equal(normalizeDocumentViewerState({ ...state, viewMode: 'spread' }).viewMode, 'spread')
  assert.equal(normalizeDocumentViewerState({ ...state, viewMode: 'unknown' }).viewMode, 'spread')
})

test('工作台状态必须安全序列化并在 JSON 损坏时回退为空状态', () => {
  const state = normalizeDocumentViewerState({
    version: 2,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'spread',
    zoom: 1.25,
    scroll: { source: 12, translation: 34 },
    activePageId: 'page-b',
    activeBlockId: 'heading-1',
    source: model(),
    translation: model()
  })
  const serialized = serializeDocumentViewerState(state)
  assert.deepEqual(parseDocumentViewerState(serialized), state)
  assert.deepEqual(parseDocumentViewerState('{broken'), createEmptyDocumentViewerState())
  assert.deepEqual(parseDocumentViewerState(JSON.stringify({ version: 2 })), createEmptyDocumentViewerState())
  assert.deepEqual(normalizeDocumentViewerState({
    ...state,
    source: { schemaVersion: 1 },
    translation: model()
  }), createEmptyDocumentViewerState())
})

test('恢复文件前必须校验授权路径、格式、大小和 SHA-256 完全一致', () => {
  const file = {
    path: '/tmp/viewer.pdf',
    name: 'viewer.pdf',
    size: 2048,
    format: 'pdf',
    sha256: 'viewer-sha'
  }
  const selected = {
    status: 'selected' as const,
    path: file.path,
    fileName: file.name,
    size: file.size,
    format: 'pdf' as const,
    sha256: file.sha256,
    capabilities: {
      nativeLayout: true,
      ocrPageImages: true,
      ocrEmbeddedImages: false,
      preserveStyles: true,
      exportPdf: true as const
    }
  }
  assert.deepEqual(validateRestoredDocumentViewerFile(file, selected), { ok: true })
  assert.deepEqual(validateRestoredDocumentViewerFile(file, { ...selected, sha256: 'changed' }), {
    ok: false,
    code: 'sha256-mismatch'
  })
  assert.deepEqual(validateRestoredDocumentViewerFile(file, { ...selected, size: 2049 }), {
    ok: false,
    code: 'size-mismatch'
  })
  assert.deepEqual(validateRestoredDocumentViewerFile(file, { ...selected, format: 'docx' }), {
    ok: false,
    code: 'format-mismatch'
  })
  assert.deepEqual(validateRestoredDocumentViewerFile(file, { ...selected, path: '/tmp/other.pdf' }), {
    ok: false,
    code: 'path-mismatch'
  })
  assert.deepEqual(validateRestoredDocumentViewerFile(file, { status: 'rejected', code: 'unreadable' }), {
    ok: false,
    code: 'not-authorized'
  })
})

test('恢复快照必须保留源与译文模型，同时隔离旧任务身份和资源读取', () => {
  const source = model()
  const translation = {
    ...model(),
    documentId: 'viewer-document-translation',
    pages: model().pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => block.kind === 'text'
        ? { ...block, runs: block.runs.map((run) => ({ ...run, text: `translated:${run.text}` })) }
        : block)
    }))
  }
  const state = normalizeDocumentViewerState({
    version: 2,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'translation',
    zoom: 1.5,
    scroll: { source: 120, translation: 180 },
    activePageId: 'page-b',
    activeBlockId: 'nested-1',
    source,
    translation
  })
  const snapshot = createRestoredDocumentWorkspaceSnapshot(state)
  assert.equal(snapshot.jobId, 'restored-viewer-state')
  assert.equal(snapshot.generation, 0)
  assert.equal(snapshot.source, state.source)
  assert.equal(snapshot.translation, state.translation)
  assert.equal(snapshot.task.status, 'completed')
  assert.equal(snapshot.languagePair.sourceLang, 'EN')
  assert.equal(snapshot.languagePair.targetLang, 'ZH')
})

test('状态 v1 只恢复界面偏好，旧显示模式键仍可兼容', () => {
  const legacy = normalizeDocumentViewerState({
    version: 1,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'translation',
    zoom: 1.4,
    scroll: { source: 12, translation: 34 },
    activePageId: 'page-b',
    activeBlockId: 'heading-1',
    translation: model()
  }, 'source')
  assert.equal(legacy.version, 2)
  assert.equal(legacy.file?.path, '/tmp/viewer.pdf')
  assert.equal(legacy.viewMode, 'translation')
  assert.equal(legacy.zoom, 1.4)
  assert.equal(legacy.source, null)
  assert.equal(legacy.translation, null)
  assert.equal(legacy.activePageId, null)
  assert.equal(legacy.activeBlockId, null)

  assert.equal(normalizeDocumentViewerState({
    version: 1,
    file: null,
    sourceLang: 'EN',
    targetLang: 'ZH',
    zoom: 1,
    scroll: { source: 0, translation: 0 },
    activePageId: null,
    activeBlockId: null,
    translation: null
  }, 'source').viewMode, 'source')
})

test('页面与区块锚点优先按源模型校验，其次才使用译文模型', () => {
  const source = model()
  const translation = {
    ...model(),
    pages: model().pages.filter((page) => page.pageId !== 'page-c'),
    documentId: 'translated-model'
  }
  const state = normalizeDocumentViewerState({
    version: 2,
    file: {
      path: '/tmp/viewer.pdf',
      name: 'viewer.pdf',
      size: 2048,
      format: 'pdf',
      sha256: 'viewer-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'spread',
    zoom: 1,
    scroll: { source: 0, translation: 0 },
    activePageId: 'page-c',
    activeBlockId: 'heading-2',
    source,
    translation
  })
  assert.equal(state.activePageId, 'page-c')
  assert.equal(state.activeBlockId, 'heading-2')
})
