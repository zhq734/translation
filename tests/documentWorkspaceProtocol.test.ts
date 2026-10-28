import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_WORKSPACE_CHANNELS,
  type DocumentRunRequest,
  type DocumentRunResult,
  type DocumentWorkspaceSnapshot
} from '../src/shared/documentWorkspace.ts'
import { createDocumentTaskState } from '../src/shared/documentTask.ts'

test('文档工作台协议应暴露受控运行、取消、资源与导出通道', () => {
  assert.deepEqual(DOCUMENT_WORKSPACE_CHANNELS, {
    run: 'document:run',
    cancel: 'document:cancel',
    retryFailed: 'document:retry-failed',
    exportPdf: 'document:export-pdf',
    getAsset: 'document:get-asset',
    getSource: 'document:get-source',
    progress: 'document:progress',
    completed: 'document:completed'
  })
})

test('文档任务快照应携带 jobId、generation、状态与百分比', () => {
  const request: DocumentRunRequest = { path: '/tmp/test.txt', generation: 3 }
  const task = createDocumentTaskState('job-1', request.generation)
  const snapshot: DocumentWorkspaceSnapshot = {
    jobId: task.jobId,
    generation: task.generation,
    task,
    percent: 0
  }
  assert.equal(snapshot.task.generation, 3)
  assert.equal(snapshot.percent, 0)
})

test('文档部分完成快照应明确携带可重试失败块数量', () => {
  const task = createDocumentTaskState('job-1', 3)
  const snapshot: DocumentWorkspaceSnapshot = {
    jobId: task.jobId,
    generation: task.generation,
    task: { ...task, status: 'partial', failedBlocks: 2 },
    percent: 100,
    retryableFailedBlocks: 2
  }
  assert.equal(snapshot.retryableFailedBlocks, 2)
})

test('文档运行冲突结果应返回可安全采用的下一任务代际', () => {
  const conflict: DocumentRunResult = {
    accepted: false,
    code: 'generation-conflict',
    suggestedGeneration: 8
  }
  assert.equal(conflict.suggestedGeneration, 8)
})
