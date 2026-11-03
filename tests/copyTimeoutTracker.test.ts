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

/**
 * 创建明确标记为未观测到合成复制事件的超时结果。
 * @returns 可交给超时追踪器的系统级故障结果。
 * @author zhenghq
 */
function unobservedTimeout() {
  return {
    text: '',
    reason: 'timeout' as const,
    diagnostics: { copyObserved: false }
  }
}

test('macOS 单次真实超时即触发自动修复', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'darwin', 1_000), true)
})

test('取词成功后下一次真实超时仍应立即触发自动修复', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'darwin', 1_000), true)
  assert.equal(recordCaptureOutcome({ text: '已取到文字' }, 'darwin', 2_500), false)
  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'darwin', 3_000), true)
})

test('单次真实超时不受距上次超时的时间影响', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'darwin', 62_001), true)
})

test('空选区和不支持不得触发 hiservices 自动修复', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(failedCapture('empty'), 'darwin', 1_500), false)
  assert.equal(recordCaptureOutcome(failedCapture('unsupported'), 'darwin', 2_000), false)
})

test('非 macOS 平台永远不触发 hiservices 自动修复', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'win32', 1_000), false)
  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'win32', 2_000), false)
  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'win32', 3_000), false)
})

test('已观测到合成复制但应用未写剪贴板时不得触发 hiservices 修复', () => {
  resetCopyTimeoutTracker()

  const observedTimeout = {
    text: '',
    reason: 'timeout' as const,
    diagnostics: { copyObserved: true }
  }

  assert.equal(recordCaptureOutcome(observedTimeout, 'darwin', 1_000), false)
  assert.equal(recordCaptureOutcome(observedTimeout, 'darwin', 2_000), false)
})

test('合成复制事件未进入 event tap 时应立即触发系统故障修复', () => {
  resetCopyTimeoutTracker()

  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'darwin', 1_000), true)
})

test('应用级复制超时不得触发 hiservices 自动修复', () => {
  resetCopyTimeoutTracker()

  const observedTimeout = {
    text: '',
    reason: 'timeout' as const,
    diagnostics: { copyObserved: true }
  }

  assert.equal(recordCaptureOutcome(observedTimeout, 'darwin', 2_000), false)
  assert.equal(recordCaptureOutcome(unobservedTimeout(), 'darwin', 3_000), true)
})

test('未启用复制事件观测的未知超时不得累计为 hiservices 故障', () => {
  resetCopyTimeoutTracker()

  const unknownTimeout = {
    text: '',
    reason: 'timeout' as const
  }

  assert.equal(recordCaptureOutcome(unknownTimeout, 'darwin', 1_000), false)
  assert.equal(recordCaptureOutcome(unknownTimeout, 'darwin', 2_000), false)
  assert.equal(recordCaptureOutcome(unknownTimeout, 'darwin', 3_000), false)
})

test('未知观测状态的超时不得触发 hiservices 自动修复', () => {
  resetCopyTimeoutTracker()

  const unknownTimeout = {
    text: '',
    reason: 'timeout' as const
  }

  assert.equal(recordCaptureOutcome(unknownTimeout, 'darwin', 2_000), false)
})
