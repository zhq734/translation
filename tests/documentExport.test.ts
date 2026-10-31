import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_WORKSPACE_CHANNELS,
  createDocumentExportProgress,
  normalizeDocumentExportCancelRequest,
  normalizeDocumentOpenExportFolderRequest,
  normalizeDocumentExportRequest,
  parseDocumentExportProgress,
  type DocumentExportRequest
} from '../src/shared/documentWorkspace.ts'

/**
 * 构造一个合法的完整导出请求。
 * @returns 导出请求。
 * @author zhenghq
 */
function request(): DocumentExportRequest {
  return {
    jobId: 'job-1',
    generation: 1,
    mode: 'complete'
  }
}

test('文档导出协议必须暴露进度、取消与打开目录通道', () => {
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.exportProgress, 'document:export-progress')
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.cancelExport, 'document:cancel-export')
  assert.equal(DOCUMENT_WORKSPACE_CHANNELS.openExportFolder, 'document:open-export-folder')
})

test('文档导出请求必须校验任务、代际、模式和布局字段', () => {
  assert.deepEqual(normalizeDocumentExportRequest(request()), {
    jobId: 'job-1',
    generation: 1,
    mode: 'complete',
    layout: 'translation'
  })
  assert.deepEqual(normalizeDocumentExportRequest({ ...request(), layout: 'bilingual' }), {
    jobId: 'job-1',
    generation: 1,
    mode: 'complete',
    layout: 'bilingual'
  })
  assert.equal(normalizeDocumentExportRequest({ ...request(), layout: 'side-by-side' }), null)
  assert.equal(normalizeDocumentExportRequest({ ...request(), jobId: ' ' }), null)
  assert.equal(normalizeDocumentExportRequest({ ...request(), generation: 0 }), null)
  assert.equal(normalizeDocumentExportRequest({ ...request(), generation: 1.5 }), null)
  assert.equal(normalizeDocumentExportRequest({ ...request(), mode: 'invalid' }), null)
  assert.equal(normalizeDocumentExportRequest({ ...request(), textLayer: 'yes' }), null)
  assert.equal(normalizeDocumentExportRequest(null), null)
})

test('文档导出请求不得接受 Renderer 提供的路径、URL 或命令', () => {
  const normalized = normalizeDocumentExportRequest({
    ...request(),
    filePath: '/tmp/escape.pdf',
    path: 'https://example.com/escape.pdf',
    command: 'open /tmp'
  })

  assert.deepEqual(normalized, {
    jobId: 'job-1',
    generation: 1,
    mode: 'complete',
    layout: 'translation'
  })
})

test('文档导出进度必须校验阶段、百分比和页面计数，并拒绝伪造任务代际', () => {
  const progress = createDocumentExportProgress('job-1', 2, {
    phase: 'composing',
    percent: 40,
    completedPages: 2,
    totalPages: 5,
    warningCount: 1
  })

  assert.deepEqual(parseDocumentExportProgress(progress), progress)
  assert.equal(parseDocumentExportProgress({ ...progress, generation: 0 }), null)
  assert.equal(parseDocumentExportProgress({ ...progress, phase: 'rendering' }), null)
  assert.equal(parseDocumentExportProgress({ ...progress, percent: 101 }), null)
  assert.equal(parseDocumentExportProgress({ ...progress, percent: Number.NaN }), null)
  assert.equal(parseDocumentExportProgress({ ...progress, completedPages: 6 }), null)
  assert.equal(parseDocumentExportProgress({ ...progress, warningCount: -1 }), null)
})

test('文档导出取消与打开目录请求只能携带任务身份', () => {
  assert.deepEqual(normalizeDocumentExportCancelRequest({ jobId: 'job-1', generation: 2 }), {
    jobId: 'job-1',
    generation: 2
  })
  assert.deepEqual(normalizeDocumentOpenExportFolderRequest({
    jobId: 'job-1',
    generation: 2,
    filePath: '/tmp/escape.pdf',
    path: 'https://example.com/escape.pdf',
    command: 'open /tmp'
  }), { jobId: 'job-1', generation: 2 })
  assert.equal(normalizeDocumentExportCancelRequest({ jobId: 'job-1', generation: 0 }), null)
  assert.equal(normalizeDocumentOpenExportFolderRequest({ jobId: '', generation: 1 }), null)
})
