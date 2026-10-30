import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendDocumentBatchItems,
  createDocumentBatchState,
  markDocumentBatchItem,
  removeDocumentBatchItem,
  resolveDocumentBatchProgress,
  type DocumentBatchCandidate
} from '../src/renderer/src/documentBatch.ts'

/**
 * 构造一个批量翻译候选文件。
 * @param path 文件绝对路径。
 * @returns 批量翻译候选文件。
 * @author zhenghq
 */
function candidate(path: string): DocumentBatchCandidate {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    size: 1024,
    format: 'pdf'
  }
}

test('批量翻译队列必须按路径去重并保留首次加入顺序', () => {
  const state = createDocumentBatchState()
  const next = appendDocumentBatchItems(state, [
    candidate('/tmp/a.pdf'),
    candidate('/tmp/b.docx'),
    candidate('/tmp/a.pdf')
  ])

  assert.deepEqual(next.items.map((item) => item.path), ['/tmp/a.pdf', '/tmp/b.docx'])
  assert.deepEqual(next.items.map((item) => item.status), ['pending', 'pending'])
  assert.equal(next.items[0]?.id, 'batch-1')
  assert.equal(next.items[1]?.id, 'batch-2')
})

test('批量翻译队列必须顺序推进并生成整体进度', () => {
  let state = appendDocumentBatchItems(createDocumentBatchState(), [
    candidate('/tmp/a.pdf'),
    candidate('/tmp/b.docx')
  ])
  state = markDocumentBatchItem(state, 'batch-1', 'running', 35)
  assert.deepEqual(resolveDocumentBatchProgress(state), {
    completed: 0,
    total: 2,
    percent: 18,
    activeId: 'batch-1'
  })
  state = markDocumentBatchItem(state, 'batch-1', 'completed', 100)
  state = markDocumentBatchItem(state, 'batch-2', 'running', 50)
  assert.deepEqual(resolveDocumentBatchProgress(state), {
    completed: 1,
    total: 2,
    percent: 75,
    activeId: 'batch-2'
  })
  state = markDocumentBatchItem(state, 'batch-2', 'partial', 100)
  assert.deepEqual(resolveDocumentBatchProgress(state), {
    completed: 2,
    total: 2,
    percent: 100,
    activeId: null
  })
})

test('批量翻译队列必须支持移除、清空取消并拒绝运行态移除', () => {
  let state = appendDocumentBatchItems(createDocumentBatchState(), [
    candidate('/tmp/a.pdf'),
    candidate('/tmp/b.docx'),
    candidate('/tmp/c.txt')
  ])
  state = markDocumentBatchItem(state, 'batch-2', 'running', 10)
  assert.equal(removeDocumentBatchItem(state, 'batch-2'), state)
  state = removeDocumentBatchItem(state, 'batch-1')
  assert.deepEqual(state.items.map((item) => item.id), ['batch-2', 'batch-3'])
  state = markDocumentBatchItem(state, 'batch-2', 'failed', 100, 'run-failed')
  assert.equal(state.items[0]?.errorCode, 'run-failed')
  assert.equal(state.items[0]?.status, 'failed')
})

test('批量翻译队列必须限制非法进度并支持取消剩余项', () => {
  let state = appendDocumentBatchItems(createDocumentBatchState(), [
    candidate('/tmp/a.pdf'),
    candidate('/tmp/b.docx')
  ])
  state = markDocumentBatchItem(state, 'batch-1', 'running', Number.NaN)
  assert.equal(state.items[0]?.progress, 0)
  state = markDocumentBatchItem(state, 'batch-1', 'completed', 100)
  state = markDocumentBatchItem(state, 'batch-2', 'cancelled', 0)
  assert.equal(state.cancelled, true)
  assert.equal(resolveDocumentBatchProgress(state).percent, 100)
})
