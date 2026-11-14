import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_FILE_HISTORY_LIMIT,
  filterDocumentFileHistory,
  filterDocumentTaskHistory,
  findExistingTaskHistoryTab,
  mergeDocumentHistoryEntries,
  normalizeDocumentFileHistory,
  recordDocumentFileHistory,
  type DocumentFileHistoryEntry
} from '../src/renderer/src/documentHistory.ts'
import type { DocumentHistoryEntry } from '../src/shared/documentWorkspace.ts'
import type { DocumentWorkspaceTab } from '../src/renderer/src/documentUiModel.ts'

/**
 * 构造一条文件翻译历史记录。
 * @param name 文件名。
 * @param lastUsedAt 最近使用时间戳。
 * @returns 文件翻译历史记录。
 * @author zhenghq
 */
function historyEntry(name: string, lastUsedAt: number): DocumentFileHistoryEntry {
  return {
    path: `/tmp/${name}`,
    name,
    size: 1024,
    format: 'pdf',
    lastUsedAt
  }
}

/**
 * 构造一个最小可用的已打开文档 Tab。
 * @param overrides 需要覆盖的 Tab 字段。
 * @returns 已打开文档 Tab。
 * @author zhenghq
 */
function openTab(overrides: Partial<DocumentWorkspaceTab> & Pick<DocumentWorkspaceTab, 'id'>): DocumentWorkspaceTab {
  return {
    id: overrides.id,
    sourceKind: 'task',
    selection: { path: null, name: 'file.pdf', size: 1, format: 'pdf', sha256: '', error: null },
    snapshot: null,
    activeJobId: null,
    expectedJobId: null,
    generation: 0,
    startInFlight: false,
    status: 'running',
    scrollPositions: { source: 0, translation: 0 },
    zoom: 1,
    viewMode: 'spread',
    pageNumber: 1,
    scrollSyncEnabled: true,
    sourceLang: 'auto',
    targetLang: 'zh',
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

test('历史任务必须优先绑定同任务的已打开 Tab，包括正在翻译的实时 Tab', () => {
  const tabs = [
    openTab({ id: 'replay', sourceKind: 'history', snapshot: { jobId: 'other' } as DocumentWorkspaceTab['snapshot'] }),
    openTab({ id: 'live', activeJobId: 'job-1' })
  ]

  assert.equal(findExistingTaskHistoryTab(tabs, 'job-1')?.id, 'live')
  assert.equal(findExistingTaskHistoryTab([tabs[0]!], 'other')?.id, 'replay')
})

test('历史任务必须按文件路径与哈希绑定同一文件的实时 Tab', () => {
  const source = { path: '/tmp/report.pdf', sha256: 'hash-1' }
  const tabs = [
    openTab({ id: 'live', selection: { path: source.path, name: 'report.pdf', size: 1, format: 'pdf', sha256: 'hash-1', error: null } }),
    openTab({ id: 'changed', selection: { path: '/tmp/other.pdf', name: 'other.pdf', size: 1, format: 'pdf', sha256: 'hash-2', error: null } })
  ]

  assert.equal(findExistingTaskHistoryTab(tabs, 'job-9', source)?.id, 'live')
  assert.equal(findExistingTaskHistoryTab(tabs, 'job-9', { ...source, sha256: 'hash-changed' }), null)
  // 快照或实时 Tab 缺少哈希时按路径宽松匹配，兼容旧历史数据。
  assert.equal(findExistingTaskHistoryTab(tabs, 'job-9', { path: source.path, sha256: '' })?.id, 'live')
  assert.equal(findExistingTaskHistoryTab([
    openTab({ id: 'no-hash', selection: { path: source.path, name: 'report.pdf', size: 1, format: 'pdf', sha256: '', error: null } })
  ], 'job-9', source)?.id, 'no-hash')
})

test('历史回放 Tab 不得通过文件身份复用到其他任务条目', () => {
  const tabs = [
    openTab({
      id: 'replay',
      sourceKind: 'history',
      selection: { path: '/tmp/report.pdf', name: 'report.pdf', size: 1, format: 'pdf', sha256: 'hash-1', error: null },
      snapshot: { jobId: 'old-job' } as DocumentWorkspaceTab['snapshot']
    })
  ]

  assert.equal(findExistingTaskHistoryTab(tabs, 'new-job', { path: '/tmp/report.pdf', sha256: 'hash-1' }), null)
})

test('重启恢复的只读 Tab 必须按文件身份绑定历史任务条目', () => {
  const source = { path: '/tmp/report.pdf', sha256: 'hash-1' }
  const tabs = [
    openTab({
      id: 'restored',
      sourceKind: 'restored',
      snapshot: { jobId: 'restored-viewer-state' } as DocumentWorkspaceTab['snapshot'],
      selection: { path: source.path, name: 'report.pdf', size: 1, format: 'pdf', sha256: 'hash-1', error: null }
    })
  ]

  assert.equal(findExistingTaskHistoryTab(tabs, 'job-1', source)?.id, 'restored')
  // 文件内容已变化时不得复用旧阅读状态。
  assert.equal(findExistingTaskHistoryTab(tabs, 'job-1', { ...source, sha256: 'hash-2' }), null)
})

test('文件翻译历史必须忽略损坏数据并过滤空路径', () => {
  assert.deepEqual(normalizeDocumentFileHistory(null), [])
  assert.deepEqual(normalizeDocumentFileHistory('invalid'), [])
  assert.deepEqual(normalizeDocumentFileHistory([
    { path: '', name: 'empty.pdf', size: 1, format: 'pdf', lastUsedAt: 1 },
    { path: '/tmp/valid.pdf', name: 'valid.pdf', size: 1024, format: 'pdf', lastUsedAt: 2 },
    { path: '/tmp/broken.pdf', name: 'broken.pdf', size: -1, format: 'pdf', lastUsedAt: 3 }
  ]), [historyEntry('valid.pdf', 2)])
})

test('文件翻译历史必须按最近使用排序、去重并限制数量', () => {
  const entries = Array.from({ length: DOCUMENT_FILE_HISTORY_LIMIT + 1 }, (_, index) =>
    historyEntry(`file-${index}.pdf`, index)
  )
  const recorded = recordDocumentFileHistory(entries, {
    path: '/tmp/file-5.pdf',
    name: 'file-5.pdf',
    size: 2048,
    format: 'docx'
  }, 999)

  assert.equal(recorded.length, DOCUMENT_FILE_HISTORY_LIMIT)
  assert.equal(recorded[0]?.path, '/tmp/file-5.pdf')
  assert.equal(recorded[0]?.size, 2048)
  assert.equal(recorded.filter((entry) => entry.path === '/tmp/file-5.pdf').length, 1)
  assert.equal(recorded.some((entry) => entry.path === '/tmp/file-0.pdf'), false)
  assert.equal(recorded.at(-1)?.path, '/tmp/file-1.pdf')
})

test('文件翻译历史搜索必须同时匹配文件名与路径且忽略大小写', () => {
  const entries = [
    historyEntry('Quarterly-Report.PDF', 2),
    { ...historyEntry('notes.txt', 1), path: '/Users/alice/Archive/notes.txt', format: 'txt' }
  ]

  assert.deepEqual(filterDocumentFileHistory(entries, 'quarterly'), [entries[0]])
  assert.deepEqual(filterDocumentFileHistory(entries, 'ALICE'), [entries[1]])
  assert.deepEqual(filterDocumentFileHistory(entries, '  '), entries)
  assert.deepEqual(filterDocumentFileHistory(entries, 'missing'), [])
})

/**
 * 构造一条任务历史摘要。
 * @param jobId 任务标识。
 * @param updatedAt 更新时间。
 * @param status 终态状态。
 * @returns 任务历史摘要。
 * @author zhenghq
 */
function taskHistoryEntry(
  jobId: string,
  updatedAt: number,
  status: DocumentHistoryEntry['status'] = 'completed'
): DocumentHistoryEntry {
  return {
    jobId,
    generation: 2,
    fileName: `${jobId}.pdf`,
    format: 'pdf',
    sourcePreference: 'EN',
    targetPreference: 'ZH',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
    status,
    percent: 100,
    updatedAt,
    exportStatus: 'not-exported'
  }
}

test('任务历史必须与可重新选择的文件历史合并且任务摘要优先', () => {
  const taskEntries = [
    taskHistoryEntry('new-task', 300),
    taskHistoryEntry('same-file', 200, 'partial')
  ]
  const fileEntries: DocumentFileHistoryEntry[] = [{
    path: '/tmp/new-task.pdf',
    name: 'new-task.pdf',
    size: 1024,
    format: 'pdf',
    lastUsedAt: 400
  }, {
    path: '/tmp/unmatched.pdf',
    name: 'unmatched.pdf',
    size: 1024,
    format: 'pdf',
    lastUsedAt: 100
  }]

  const merged = mergeDocumentHistoryEntries(taskEntries, fileEntries)
  assert.equal(merged.length, 3)
  assert.equal(merged[0]?.kind, 'task')
  assert.equal(merged[0]?.task?.jobId, 'new-task')
  assert.equal(merged.some((entry) => entry.kind === 'file' && entry.file?.path === '/tmp/new-task.pdf'), false)
  assert.equal(merged[1]?.kind, 'task')
  assert.equal(merged[1]?.task?.jobId, 'same-file')
  assert.equal(merged[2]?.kind, 'file')
  assert.equal(merged[2]?.file?.path, '/tmp/unmatched.pdf')
})

test('任务历史搜索必须匹配文件名、语言方向与状态且忽略大小写', () => {
  const entries = [
    taskHistoryEntry('Quarterly-Report', 2),
    { ...taskHistoryEntry('draft', 1, 'failed'), fileName: 'draft.docx', format: 'docx' }
  ]

  assert.deepEqual(filterDocumentTaskHistory(entries, 'quarterly'), [entries[0]])
  assert.deepEqual(filterDocumentTaskHistory(entries, 'FAILED'), [entries[1]])
  assert.deepEqual(filterDocumentTaskHistory(entries, 'en → zh'), entries)
  assert.deepEqual(filterDocumentTaskHistory(entries, '  '), entries)
  assert.deepEqual(filterDocumentTaskHistory(entries, 'missing'), [])
})
