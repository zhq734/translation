import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvedDocumentSourceRequest,
  hasReusablePdfSourcePreview,
  isReadOnlyDocumentTab,
  isRestoredDocumentTab,
  resolveAuthorizedDocumentSourceRequest
} from '../src/renderer/src/documentSourceAccess.ts'
import {
  RESTORED_DOCUMENT_JOB_ID,
  type DocumentWorkspaceTab
} from '../src/renderer/src/documentUiModel.ts'

const SOURCE_SHA256 = 'a'.repeat(64)

/**
 * 创建源文件访问测试所需的文档 Tab。
 * @param overrides 需要覆盖的 Tab 字段。
 * @returns 完整且可安全传给访问逻辑的文档 Tab。
 * @author zhenghq
 */
function createTab(overrides: Partial<DocumentWorkspaceTab> = {}): DocumentWorkspaceTab {
  return {
    id: 'tab-1',
    sourceKind: 'task',
    selection: {
      path: '/tmp/example.pdf',
      name: 'example.pdf',
      size: 1024,
      format: 'pdf',
      sha256: SOURCE_SHA256,
      error: null
    },
    snapshot: null,
    activeJobId: null,
    expectedJobId: null,
    generation: 1,
    startInFlight: false,
    status: 'idle',
    scrollPositions: { source: 0, translation: 0 },
    zoom: 1,
    viewMode: 'spread',
    pageNumber: 1,
    scrollSyncEnabled: true,
    sourceLang: 'auto',
    targetLang: 'zh-CN',
    ocrDisplayMode: 'translation',
    activeBlockId: null,
    pendingLanguageRetranslation: false,
    pendingOcrModeTarget: null,
    ocrModeSwitchInFlight: false,
    pendingModeSwitchGeneration: null,
    pendingModeSwitchSnapshot: null,
    pendingModeSwitchSnapshotTerminal: false,
    languageRevision: 0,
    sourceAuthorized: true,
    ...overrides
  }
}

test('普通任务 Tab 必须使用已授权选择指纹构造源请求', () => {
  const tab = createTab()
  assert.deepEqual(
    resolveAuthorizedDocumentSourceRequest(tab, () => false, () => null),
    {
      path: '/tmp/example.pdf',
      sourceSha256: SOURCE_SHA256,
      sourceSize: 1024,
      format: 'pdf'
    }
  )
})

test('未授权或文件指纹不完整的普通任务不得读取源文件', () => {
  assert.equal(resolveAuthorizedDocumentSourceRequest(
    createTab({ sourceAuthorized: false }),
    () => false,
    () => null
  ), null)
  assert.equal(resolveAuthorizedDocumentSourceRequest(
    createTab({ selection: { ...createTab().selection, sha256: 'invalid' } }),
    () => false,
    () => null
  ), null)
  assert.equal(resolveAuthorizedDocumentSourceRequest(
    createTab({ selection: { ...createTab().selection, size: 0 } }),
    () => false,
    () => null
  ), null)
})

test('只读 Tab 必须继续复用快照校验后的源请求', () => {
  const tab = createTab({ sourceKind: 'history' })
  const approved = {
    path: '/tmp/example.pdf',
    sourceSha256: SOURCE_SHA256,
    sourceSize: 1024,
    format: 'pdf' as const
  }
  assert.equal(resolveAuthorizedDocumentSourceRequest(tab, () => true, () => approved), approved)
})

test('同一 Tab 的待解析或已解析 PDF 原文预览必须可复用', () => {
  const tab = createTab()
  assert.equal(hasReusablePdfSourcePreview(
    tab,
    `pdf-pending:${SOURCE_SHA256}`,
    tab.id,
    SOURCE_SHA256
  ), true)
  assert.equal(hasReusablePdfSourcePreview(
    tab,
    `pdf:${SOURCE_SHA256}`,
    tab.id,
    SOURCE_SHA256
  ), true)
  assert.equal(hasReusablePdfSourcePreview(
    tab,
    `pdf:${SOURCE_SHA256}`,
    'tab-2',
    SOURCE_SHA256
  ), false)
  assert.equal(hasReusablePdfSourcePreview(
    tab,
    `pdf:${SOURCE_SHA256}`,
    tab.id,
    'b'.repeat(64)
  ), false)
})

test('恢复态与历史态 Tab 必须统一识别为只读', () => {
  const taskTab = createTab()
  const restoredTab = createTab({
    sourceKind: 'restored',
    snapshot: { jobId: RESTORED_DOCUMENT_JOB_ID } as DocumentWorkspaceTab['snapshot']
  })
  const historyTab = createTab({ sourceKind: 'history' })

  assert.equal(isRestoredDocumentTab(restoredTab), true)
  assert.equal(isRestoredDocumentTab(taskTab), false)
  assert.equal(isReadOnlyDocumentTab(restoredTab), true)
  assert.equal(isReadOnlyDocumentTab(historyTab), true)
  assert.equal(isReadOnlyDocumentTab(taskTab), false)
})

test('只读 Tab 的源请求必须与重新授权快照完全一致', () => {
  const source = {
    path: '/tmp/example.pdf',
    sha256: SOURCE_SHA256,
    size: 1024,
    format: 'pdf'
  }
  const historyTab = createTab({
    sourceKind: 'history',
    snapshot: {
      jobId: 'history-job',
      source: { source }
    } as unknown as DocumentWorkspaceTab['snapshot']
  })

  assert.deepEqual(approvedDocumentSourceRequest(historyTab), {
    path: source.path,
    sourceSha256: source.sha256,
    sourceSize: source.size,
    format: 'pdf'
  })
  assert.equal(approvedDocumentSourceRequest({
    ...historyTab,
    sourceAuthorized: false
  }), null)
  assert.equal(approvedDocumentSourceRequest({
    ...historyTab,
    selection: { ...historyTab.selection, sha256: 'b'.repeat(64) }
  }), null)
  assert.equal(approvedDocumentSourceRequest(createTab()), null)
})
