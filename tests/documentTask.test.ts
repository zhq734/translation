import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_TASK_PHASES,
  calculateDocumentTaskProgress,
  canApplyDocumentTaskEvent,
  completeDocumentTask,
  completeDocumentTaskPhase,
  createDocumentTaskState,
  failDocumentTask,
  markDocumentTaskPartial,
  moveDocumentTaskToPhase,
  requestDocumentTaskCancellation,
  updateDocumentTaskProgress,
  type DocumentTaskProgress
} from '../src/shared/documentTask.ts'

/**
 * 构造测试用任务进度。
 * @param completed 已完成单位数。
 * @param total 总单位数。
 * @returns 进度对象。
 * @author zhenghq
 */
function progress(completed: number, total: number): DocumentTaskProgress {
  return { completed, total }
}

test('文档任务阶段应按固定顺序推进且不能跳过阶段', () => {
  let state = createDocumentTaskState('job-1', 1)
  assert.deepEqual(DOCUMENT_TASK_PHASES, ['validate', 'parse', 'ocr', 'translate', 'layout', 'export'])
  assert.equal(state.phase, 'validate')
  assert.equal(state.status, 'validating')

  state = moveDocumentTaskToPhase(state, 'parse')
  state = moveDocumentTaskToPhase(state, 'ocr')
  state = moveDocumentTaskToPhase(state, 'translate')
  state = moveDocumentTaskToPhase(state, 'layout')
  state = moveDocumentTaskToPhase(state, 'export')

  assert.equal(state.phase, 'export')
  assert.equal(state.status, 'exporting')
  assert.throws(() => moveDocumentTaskToPhase(state, 'parse'), /阶段|phase/iu)
})

test('阶段完成只允许推进一次且进度在阶段内单调不减', () => {
  let state = createDocumentTaskState('job-1', 1)
  state = moveDocumentTaskToPhase(state, 'parse')
  state = { ...state, progress: progress(5, 10) }
  state = completeDocumentTaskPhase(state)
  assert.equal(state.progress.completed, 5)
  state = updateDocumentTaskProgress(state, progress(3, 10))
  assert.equal(state.progress.completed, 5)
  state = moveDocumentTaskToPhase(state, 'ocr')
  state = completeDocumentTaskPhase(state)
  state = moveDocumentTaskToPhase(state, 'translate')
  assert.equal(state.phase, 'translate')
  assert.equal(state.progress.completed, 0)
  assert.equal(state.progress.total, 0)
  assert.equal(state.phaseCompleted, false)
})

test('完成阶段应计入该阶段全部权重，正常完成应进入 completed 终态', () => {
  let state = createDocumentTaskState('job-1', 1)
  state = moveDocumentTaskToPhase(state, 'parse')
  state = { ...state, progress: progress(3, 10) }
  state = completeDocumentTaskPhase(state)
  assert.equal(state.phaseCompleted, true)
  assert.equal(calculateDocumentTaskProgress(state), 10)
  state = completeDocumentTask(state, { failedBlocks: 0, warningCount: 2 })
  assert.equal(state.status, 'completed')
  assert.equal(state.warningCount, 2)
  assert.equal(calculateDocumentTaskProgress(state), 100)
})

test('总进度应按阶段权重汇总并限制在 0 到 100', () => {
  const state = createDocumentTaskState('job-1', 1)
  assert.equal(calculateDocumentTaskProgress(state), 0)

  const parsing = {
    ...moveDocumentTaskToPhase(state, 'parse'),
    progress: progress(50, 100)
  }
  assert.equal(calculateDocumentTaskProgress(parsing), 6)

  const ocr = moveDocumentTaskToPhase(parsing, 'ocr')
  assert.equal(calculateDocumentTaskProgress(ocr), 10)
  const translating = updateDocumentTaskProgress(
    moveDocumentTaskToPhase(ocr, 'translate'),
    progress(50, 100)
  )
  assert.equal(calculateDocumentTaskProgress(translating), 57.5)
  assert.equal(calculateDocumentTaskProgress(updateDocumentTaskProgress(translating, progress(999, 100))), 85)
  assert.equal(calculateDocumentTaskProgress(updateDocumentTaskProgress(translating, progress(-1, 100))), 57.5)
  const zeroTotalUpdate = updateDocumentTaskProgress(translating, progress(1, 0))
  assert.deepEqual(zeroTotalUpdate.progress, progress(50, 100))
  assert.equal(calculateDocumentTaskProgress(zeroTotalUpdate), 57.5)
})

test('取消请求应保留已完成进度并忽略迟到结果', () => {
  let state = createDocumentTaskState('job-1', 2)
  state = moveDocumentTaskToPhase(state, 'parse')
  state = moveDocumentTaskToPhase(state, 'ocr')
  state = moveDocumentTaskToPhase(state, 'translate')
  state = { ...state, progress: progress(3, 10) }

  const cancelled = requestDocumentTaskCancellation(state)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancellationRequested, true)
  assert.equal(cancelled.progress.completed, 3)
  assert.equal(canApplyDocumentTaskEvent(state, 'job-1', 2), true)
  assert.equal(canApplyDocumentTaskEvent(cancelled, 'job-1', 3), false)
  assert.equal(canApplyDocumentTaskEvent(cancelled, 'job-2', 2), false)
})

test('失败应保留已有结果并阻止后续阶段继续推进', () => {
  let state = createDocumentTaskState('job-1', 1)
  state = moveDocumentTaskToPhase(state, 'parse')
  state = moveDocumentTaskToPhase(state, 'ocr')
  state = moveDocumentTaskToPhase(state, 'translate')
  state = { ...state, progress: progress(4, 10) }
  const failed = failDocumentTask(state, 'translation-provider-error')

  assert.equal(failed.status, 'failed')
  assert.equal(failed.errorCode, 'translation-provider-error')
  assert.equal(failed.progress.completed, 4)
  assert.throws(() => moveDocumentTaskToPhase(failed, 'layout'), /terminal/iu)
  assert.equal(canApplyDocumentTaskEvent(failed, 'job-1', 1), false)
})

test('部分完成应保留失败块计数和可恢复阶段', () => {
  let state = createDocumentTaskState('job-1', 1)
  state = moveDocumentTaskToPhase(state, 'parse')
  state = moveDocumentTaskToPhase(state, 'ocr')
  state = moveDocumentTaskToPhase(state, 'translate')
  state = { ...state, progress: progress(7, 10) }
  const partial = markDocumentTaskPartial(state, { failedBlocks: 3, warningCount: 2 })

  assert.equal(partial.status, 'partial')
  assert.equal(partial.progress.completed, 7)
  assert.equal(partial.failedBlocks, 3)
  assert.equal(partial.warningCount, 2)
  assert.equal(partial.phase, 'translate')
})

test('任务事件应校验 jobId、代际和终态', () => {
  const state = createDocumentTaskState('job-1', 7)
  assert.equal(canApplyDocumentTaskEvent(state, 'job-1', 7), true)
  assert.equal(canApplyDocumentTaskEvent(state, 'job-1', 6), false)
  assert.equal(canApplyDocumentTaskEvent(state, 'job-2', 7), false)
  assert.equal(canApplyDocumentTaskEvent({ ...state, status: 'completed' }, 'job-1', 7), false)
})
