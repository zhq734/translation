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

test('旧版单文件工作台状态必须迁移并恢复文件、语言、显示模式、缩放、滚动锚点和译文', () => {
  const legacy = {
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
  const state: DocumentViewerState = normalizeDocumentViewerState(legacy)
  assert.equal(state.version, 3)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.tabs[0]?.selection.path, '/tmp/viewer.pdf')
  assert.equal(state.tabs[0]?.sourceLang, 'EN')
  assert.equal(state.tabs[0]?.targetLang, 'ZH')
  assert.equal(state.tabs[0]?.viewMode, 'translation')
  assert.equal(state.tabs[0]?.zoom, 1.5)
  assert.deepEqual(state.tabs[0]?.scroll, { source: 120, translation: 180 })
  assert.equal(state.tabs[0]?.activePageId, 'page-b')
  assert.equal(state.tabs[0]?.activeBlockId, 'nested-1')
  assert.deepEqual(state.tabs[0]?.source, model())
  assert.deepEqual(state.tabs[0]?.translation, model())
  assert.equal(DOCUMENT_VIEWER_STATE_STORAGE_KEY, 'selection-translator.document-viewer-state')
  assert.equal(DOCUMENT_VIEWER_STATE_VERSION, 3)
})

test('工作台必须持久化完整 Tab 集合、活动 Tab 与每个 Tab 的阅读状态', () => {
  const secondModel = {
    ...model(),
    documentId: 'viewer-document-2',
    source: {
      ...model().source,
      path: '/tmp/notes.md',
      fileName: 'notes.md',
      format: 'md',
      sha256: 'notes-sha',
      size: 512
    }
  }
  const state = normalizeDocumentViewerState({
    version: 3,
    activeTabId: 'tab-b',
    tabs: [{
      id: 'tab-a',
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
      scrollSyncEnabled: false,
      pageNumber: 2,
      ocrDisplayMode: 'translation',
      activePageId: 'page-b',
      activeBlockId: 'heading-1',
      source: model(),
      translation: model()
    }, {
      id: 'tab-b',
      file: {
        path: '/tmp/notes.md',
        name: 'notes.md',
        size: 512,
        format: 'md',
        sha256: 'notes-sha'
      },
      sourceLang: 'auto',
      targetLang: 'ZH',
      viewMode: 'translation',
      zoom: 1.5,
      scroll: { source: 4, translation: 56 },
      scrollSyncEnabled: true,
      pageNumber: 1,
      ocrDisplayMode: 'ocr-text',
      activePageId: 'page-a',
      activeBlockId: null,
      source: secondModel,
      translation: secondModel
    }]
  })

  assert.equal(state.version, 3)
  assert.equal(state.activeTabId, 'tab-b')
  assert.equal(state.tabs.length, 2)
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['tab-a', 'tab-b'])
  assert.equal(state.tabs[0]?.zoom, 1.25)
  assert.equal(state.tabs[0]?.scrollSyncEnabled, false)
  assert.equal(state.tabs[0]?.pageNumber, 2)
  assert.equal(state.tabs[1]?.selection.format, 'md')
  assert.equal(state.tabs[1]?.ocrDisplayMode, 'ocr-text')
  assert.equal(state.tabs[1]?.scroll.translation, 56)

  const restored = parseDocumentViewerState(serializeDocumentViewerState(state))
  assert.deepEqual(restored, state)
})

test('旧版单文件查看器状态必须迁移为一个完整 Tab', () => {
  const legacy = normalizeDocumentViewerState({
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

  assert.equal(legacy.version, 3)
  assert.equal(legacy.activeTabId, legacy.tabs[0]?.id)
  assert.equal(legacy.tabs.length, 1)
  assert.equal(legacy.tabs[0]?.selection.path, '/tmp/viewer.pdf')
  assert.equal(legacy.tabs[0]?.scroll.source, 12)
  assert.equal(legacy.tabs[0]?.activePageId, 'page-b')
})

test('损坏的 Tab 项不能污染其他可恢复 Tab，活动 Tab 必须回退到有效项', () => {
  const state = normalizeDocumentViewerState({
    version: 3,
    activeTabId: 'missing-tab',
    tabs: [{
      id: 'valid-tab',
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
      scrollSyncEnabled: true,
      pageNumber: 1,
      ocrDisplayMode: 'translation',
      activePageId: 'page-a',
      activeBlockId: null,
      source: model(),
      translation: model()
    }, {
      id: 'broken-tab',
      file: { path: '/tmp/missing.pdf' },
      source: null,
      translation: null
    }]
  })

  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0]?.id, 'valid-tab')
  assert.equal(state.activeTabId, 'valid-tab')
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
  assert.equal(bounded.tabs[0]?.zoom, 2)
  assert.deepEqual(bounded.tabs[0]?.scroll, { source: 0, translation: 88 })
  assert.equal(bounded.tabs[0]?.activePageId, 'page-a')
  assert.equal(bounded.tabs[0]?.activeBlockId, null)
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

  assert.equal(state.tabs[0]?.viewMode, 'source')
  assert.equal(normalizeDocumentViewerState({
    ...state,
    tabs: [{ ...state.tabs[0], viewMode: 'translation' }]
  }).tabs[0]?.viewMode, 'translation')
  assert.equal(normalizeDocumentViewerState({
    ...state,
    tabs: [{ ...state.tabs[0], viewMode: 'spread' }]
  }).tabs[0]?.viewMode, 'spread')
  assert.equal(normalizeDocumentViewerState({
    ...state,
    tabs: [{ ...state.tabs[0], viewMode: 'unknown' }]
  }).tabs[0]?.viewMode, 'spread')
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
    tabs: [{ ...state.tabs[0], source: { schemaVersion: 1 }, translation: model() }]
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
  const snapshot = createRestoredDocumentWorkspaceSnapshot(state.tabs[0]!)
  assert.equal(snapshot.jobId, 'restored-viewer-state')
  assert.equal(snapshot.generation, 0)
  assert.equal(snapshot.source, state.tabs[0]?.source)
  assert.equal(snapshot.translation, state.tabs[0]?.translation)
  assert.equal(snapshot.task.status, 'completed')
  assert.equal(snapshot.languagePair.sourceLang, 'EN')
  assert.equal(snapshot.languagePair.targetLang, 'ZH')
})

test('状态 v1 缺少完整双模型时不得恢复半成品 Tab，旧显示模式键仍可兼容', () => {
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
  assert.deepEqual(legacy, createEmptyDocumentViewerState())

  assert.deepEqual(normalizeDocumentViewerState({
    version: 1,
    file: null,
    sourceLang: 'EN',
    targetLang: 'ZH',
    zoom: 1,
    scroll: { source: 0, translation: 0 },
    activePageId: null,
    activeBlockId: null,
    translation: null
  }, 'source'), createEmptyDocumentViewerState())
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
  assert.equal(state.tabs[0]?.activePageId, 'page-c')
  assert.equal(state.tabs[0]?.activeBlockId, 'heading-2')
})

/**
 * 构造旧版 PDF 表格快照；每个视觉行或同行片段都是独立文本区块。
 * @param translated 是否生成译文内容。
 * @param format 源文件格式，用于验证迁移只作用于 PDF。
 * @returns 包含旧版表格单元格区块的文档模型。
 * @author zhenghq
 */
function legacyPdfTableCellModel(
  translated = false,
  format: DocumentModel['source']['format'] = 'pdf'
): DocumentModel {
  const value = translated ? 'translated' : 'source'
  const text = (
    blockId: string,
    readingOrder: number,
    x: number,
    y: number,
    width: number,
    valueText: string,
    textAlign: 'left' | 'right',
    style?: { fontWeight?: number; italic?: boolean }
  ) => ({
    kind: 'text' as const,
    blockId,
    readingOrder,
    translatable: true,
    role: 'paragraph' as const,
    bbox: { x, y, width, height: 10 },
    textAlign,
    runs: [{ runId: `${blockId}-run`, text: valueText, ...(style ? { style } : {}) }]
  })
  return {
    ...model(),
    documentId: `legacy-pdf-${value}`,
    source: { ...model().source, format },
    pages: [{
      pageId: 'page-pdf',
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        kind: 'table',
        blockId: 'pdf-table',
        readingOrder: 0,
        translatable: false,
        rows: [{
          rowId: 'pdf-row',
          cells: [{
            cellId: 'cell-merge',
            rowSpan: 1,
            colSpan: 1,
            blocks: [
              text('legacy-text-a1', 0, 10, 100, 30, translated ? 'Translated Hello ' : 'Hello ', 'left', { fontWeight: 700 }),
              text('legacy-text-a2', 1, 42, 100, 30, translated ? 'world' : 'world', 'right', { italic: true }),
              text('legacy-text-a3', 2, 10, 112, 40, translated ? 'Translated Next' : 'Next', 'left'),
              {
                kind: 'image',
                blockId: 'legacy-cell-image',
                readingOrder: 3,
                translatable: false,
                bbox: { x: 10, y: 130, width: 50, height: 20 },
                assetId: 'asset-cell-image',
                renderPending: false
              },
              text('legacy-text-a4', 4, 10, 155, 40, translated ? 'Translated After' : 'After', 'left')
            ]
          }, {
            cellId: 'cell-mismatch',
            rowSpan: 1,
            colSpan: 1,
            blocks: translated ? [
              text('legacy-text-b1', 0, 210, 100, 40, 'Translated first', 'left')
            ] : [
              text('legacy-text-b1', 0, 210, 100, 40, 'First', 'left'),
              text('legacy-text-b2', 1, 210, 112, 40, 'Second', 'left')
            ]
          }]
        }],
        columnWidths: [300, 300],
        headerRows: 0
      }]
    }],
    assets: [{
      assetId: 'asset-cell-image',
      kind: 'image',
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      byteLength: 12
    }],
    warnings: []
  }
}

test('恢复旧版 PDF 表格快照时必须按视觉行合并单元格文本并保留图片顺序', () => {
  const source = legacyPdfTableCellModel(false)
  const translation = legacyPdfTableCellModel(true)
  const state = normalizeDocumentViewerState({
    version: 3,
    activeTabId: 'legacy-pdf-tab',
    tabs: [{
      id: 'legacy-pdf-tab',
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
      scrollSyncEnabled: true,
      pageNumber: 1,
      ocrDisplayMode: 'translation',
      activePageId: 'page-pdf',
      activeBlockId: 'legacy-text-a2',
      source,
      translation
    }]
  })
  const tab = state.tabs[0]!
  const sourceCell = tab.source.pages[0]!.blocks[0]!.kind === 'table'
    ? tab.source.pages[0]!.blocks[0]!.rows[0]!.cells[0]!
    : null
  const translationCell = tab.translation.pages[0]!.blocks[0]!.kind === 'table'
    ? tab.translation.pages[0]!.blocks[0]!.rows[0]!.cells[0]!
    : null
  assert.ok(sourceCell && translationCell)
  assert.equal(tab.activeBlockId, 'legacy-text-a1', '被合并区块的高亮锚点必须迁移到合并后的区块')
  assert.deepEqual(sourceCell.blocks.map((block) => block.kind), ['text', 'image', 'text'])
  assert.deepEqual(sourceCell.blocks.map((block) => block.readingOrder), [0, 1, 2])
  assert.deepEqual(translationCell.blocks.map((block) => block.kind), ['text', 'image', 'text'])

  const sourceText = sourceCell.blocks[0]!
  const translationText = translationCell.blocks[0]!
  assert.equal(sourceText.kind, 'text')
  assert.equal(translationText.kind, 'text')
  if (sourceText.kind !== 'text' || translationText.kind !== 'text') return
  assert.equal(sourceText.blockId, 'legacy-text-a1')
  assert.equal(sourceText.runs.map((run) => run.text).join(''), 'Hello world Next')
  assert.equal(translationText.runs.map((run) => run.text).join(''), 'Translated Hello world Translated Next')
  assert.deepEqual(sourceText.bbox, { x: 10, y: 100, width: 62, height: 22 })
  assert.equal(sourceText.textAlign, undefined, '混合对齐方式的视觉行不能错误继承单行对齐')
  assert.equal(sourceText.runs[0]?.style?.fontWeight, 700)
  assert.equal(sourceText.runs[1]?.style?.italic, true)
  assert.equal(sourceCell.blocks[1]?.blockId, 'legacy-cell-image')
  assert.equal(sourceCell.blocks[2]?.blockId, 'legacy-text-a4')

  const mismatchCell = tab.source.pages[0]!.blocks[0]!.kind === 'table'
    ? tab.source.pages[0]!.blocks[0]!.rows[0]!.cells[1]!
    : null
  assert.equal(mismatchCell?.blocks.length, 2, '源译文结构不一致时不得猜测合并关系')
})

test('PDF 表格快照迁移必须幂等且不能影响非 PDF 文档', () => {
  const buildState = (format: DocumentModel['source']['format']) => normalizeDocumentViewerState({
    version: 3,
    activeTabId: 'legacy-tab',
    tabs: [{
      id: 'legacy-tab',
      file: {
        path: `/tmp/viewer.${format}`,
        name: `viewer.${format}`,
        size: 2048,
        format,
        sha256: 'viewer-sha'
      },
      sourceLang: 'EN',
      targetLang: 'ZH',
      viewMode: 'spread',
      zoom: 1,
      scroll: { source: 0, translation: 0 },
      scrollSyncEnabled: true,
      pageNumber: 1,
      ocrDisplayMode: 'translation',
      activePageId: 'page-pdf',
      activeBlockId: null,
      source: legacyPdfTableCellModel(false, format),
      translation: legacyPdfTableCellModel(true, format)
    }]
  })

  const once = buildState('pdf')
  const twice = normalizeDocumentViewerState(once)
  assert.deepEqual(twice, once)

  const markdown = buildState('markdown').tabs[0]!
  const markdownTable = markdown.source.pages[0]!.blocks[0]
  assert.equal(markdownTable?.kind, 'table')
  assert.equal(markdownTable?.kind === 'table' ? markdownTable.rows[0]!.cells[0]!.blocks.length : 0, 5)
})
