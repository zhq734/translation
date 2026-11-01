import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_WORKSPACE_CHANNELS,
  createDocumentExportProgress,
  normalizeDocumentApprovedExportRequest,
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

test('文档导出请求必须校验任务、代际、模式和文字层字段', () => {
  assert.deepEqual(normalizeDocumentExportRequest(request()), {
    jobId: 'job-1',
    generation: 1,
    mode: 'complete'
  })
  assert.deepEqual(normalizeDocumentExportRequest({ ...request(), layout: 'bilingual' }), {
    jobId: 'job-1',
    generation: 1,
    mode: 'complete'
  })
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
    mode: 'complete'
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

test('文档导出取消只携带任务身份，打开目录仅保留已导出路径查找键', () => {
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
  }), {
    jobId: 'job-1',
    generation: 2,
    filePath: '/tmp/escape.pdf'
  })
  assert.equal(normalizeDocumentExportCancelRequest({ jobId: 'job-1', generation: 0 }), null)
  assert.equal(normalizeDocumentOpenExportFolderRequest({ jobId: '', generation: 1 }), null)
})

test('历史文档导出请求必须校验重新授权信息并保留译文模型', () => {
  const request = {
    source: {
      path: '/tmp/history.pdf',
      format: 'pdf' as const,
      sourceSha256: 'a'.repeat(64),
      sourceSize: 128
    },
    fileName: 'history.pdf',
    translation: {
      schemaVersion: 1,
      documentId: 'history-document',
      source: {
        path: '/tmp/history.pdf',
        fileName: 'history.pdf',
        format: 'pdf',
        sha256: 'a'.repeat(64),
        size: 128,
        pageCount: 1
      },
      metadata: { direction: 'ltr' },
      pages: [{
        pageId: 'page-1',
        index: 0,
        width: 600,
        height: 800,
        blocks: [{
          kind: 'text',
          blockId: 'block-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-1', text: '译文' }]
        }]
      }],
      assets: [],
      warnings: []
    }
  }

  assert.deepEqual(normalizeDocumentApprovedExportRequest(request), request)
  assert.equal(normalizeDocumentApprovedExportRequest({
    ...request,
    source: { ...request.source, path: 'relative.pdf' }
  }), null)
  assert.equal(normalizeDocumentApprovedExportRequest({
    ...request,
    source: { ...request.source, sourceSha256: 'not-a-sha' }
  }), null)
  assert.equal(normalizeDocumentApprovedExportRequest({
    ...request,
    translation: { ...request.translation, documentId: '' }
  }), null)
  assert.equal(normalizeDocumentApprovedExportRequest({
    ...request,
    translation: null
  }), null)
})
