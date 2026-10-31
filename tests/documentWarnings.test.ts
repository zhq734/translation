import assert from 'node:assert/strict'
import test from 'node:test'
import { createRestoredDocumentWorkspaceSnapshot, type DocumentViewerTabState } from '../src/renderer/src/documentViewer.ts'
import type { DocumentModel, DocumentWarning } from '../src/shared/documentTypes.ts'
import {
  countVisibleDocumentWarnings,
  filterVisibleDocumentWarnings
} from '../src/shared/documentWarnings.ts'

/**
 * 构造测试用文档告警。
 * @param code 稳定告警码。
 * @param pageId 关联页面标识。
 * @returns 文档告警。
 * @author zhenghq
 */
function warning(code: string, pageId?: string): DocumentWarning {
  return {
    code,
    severity: code.endsWith('failed') ? 'error' : 'warning',
    message: `${code} fallback`,
    ...(pageId ? { pageId } : {})
  }
}

/**
 * 构造恢复快照所需的最小文档模型。
 * @param warnings 模型告警。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(warnings: DocumentWarning[]): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'warning-document',
    source: {
      path: '/tmp/warning.pdf',
      fileName: 'warning.pdf',
      format: 'pdf',
      sha256: 'warning-sha',
      size: 128
    },
    metadata: { direction: 'ltr' },
    pages: [],
    assets: [],
    warnings
  }
}

test('内部 OCR 阶段提示不得进入界面告警列表', () => {
  const visible = filterVisibleDocumentWarnings([
    warning('embedded-image-ocr-required', 'page-1'),
    warning('ocr-required', 'page-1'),
    warning('ocr-failed', 'page-1'),
    warning('ocr-limit-reached', 'page-2')
  ])

  assert.deepEqual(visible.map((item) => item.code), ['ocr-failed', 'ocr-limit-reached'])
})

test('源与译文告警必须按稳定关联键去重，同时保留不同页面的同类告警', () => {
  const visible = countVisibleDocumentWarnings([
    warning('ocr-failed', 'page-1'),
    warning('ocr-failed', 'page-1'),
    warning('ocr-failed', 'page-2'),
    warning('embedded-image-ocr-required', 'page-1')
  ], [
    warning('ocr-failed', 'page-1'),
    warning('ocr-limit-reached', 'page-3')
  ])

  assert.equal(visible, 3)
})

test('恢复快照的告警计数必须排除内部提示并合并源与译文重复项', () => {
  const source = model([
    warning('embedded-image-ocr-required', 'page-1'),
    warning('ocr-failed', 'page-1')
  ])
  const translation = model([
    warning('embedded-image-ocr-required', 'page-1'),
    warning('ocr-failed', 'page-1'),
    warning('ocr-limit-reached', 'page-2')
  ])
  const tab: DocumentViewerTabState = {
    id: 'warning-tab',
    selection: {
      path: '/tmp/warning.pdf',
      name: 'warning.pdf',
      size: 128,
      format: 'pdf',
      sha256: 'warning-sha'
    },
    sourceLang: 'EN',
    targetLang: 'ZH',
    viewMode: 'spread',
    zoom: 1,
    scroll: { source: 0, translation: 0 },
    scrollSyncEnabled: true,
    pageNumber: 1,
    ocrDisplayMode: 'translation',
    activePageId: null,
    activeBlockId: null,
    source,
    translation
  }

  const snapshot = createRestoredDocumentWorkspaceSnapshot(tab)

  assert.equal(snapshot.task.warningCount, 2)
})
