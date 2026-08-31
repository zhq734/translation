import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recordCaptureOutcome,
  resetCopyTimeoutTracker
} from '../src/main/copyTimeoutTracker.ts'

/**
 * 创建指定失败原因的空取词结果。
 * @param reason 取词失败原因。
 * @returns 可交给超时追踪器的取词结果。
 * @author zhenghq
 */
function failedCapture(reason: 'empty' | 'timeout' | 'unsupported') {
  return { text: '', reason }
}

test('macOS 在一分钟内连续三次真实超时时触发修复提示', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 1_000), false)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 2_000), false)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 3_000), true)
})

test('取词成功后应重置连续超时计数', () => {
  resetCopyTimeoutTracker()

  recordCaptureOutcome(failedCapture('timeout'), 'darwin', 1_000)
  recordCaptureOutcome(failedCapture('timeout'), 'darwin', 2_000)
  assert.equal(recordCaptureOutcome({ text: '已取到文字' }, 'darwin', 2_500), false)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 3_000), false)
})

test('相邻超时超过一分钟时应重新计数', () => {
  resetCopyTimeoutTracker()

  recordCaptureOutcome(failedCapture('timeout'), 'darwin', 1_000)
  recordCaptureOutcome(failedCapture('timeout'), 'darwin', 2_000)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 62_001), false)
})

test('空选区和不支持不计入 hiservices 连续超时', () => {
  resetCopyTimeoutTracker()

  recordCaptureOutcome(failedCapture('timeout'), 'darwin', 1_000)
  recordCaptureOutcome(failedCapture('empty'), 'darwin', 1_500)
  recordCaptureOutcome(failedCapture('unsupported'), 'darwin', 2_000)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 2_500), false)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'darwin', 3_000), true)
})

test('非 macOS 平台永远不触发 hiservices 修复提示', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'win32', 1_000), false)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'win32', 2_000), false)
  assert.equal(recordCaptureOutcome(failedCapture('timeout'), 'win32', 3_000), false)
})
