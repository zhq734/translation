import assert from 'node:assert/strict'
import test from 'node:test'
import { StabilizedTextController } from '../src/shared/subtitleTextStabilizer.ts'

/** 字幕稳定器测试使用的手动计时器。 */
interface ManualTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
}

/**
 * 创建可逐项触发和校验的计时器集合。
 * @returns 计时器工厂、清理函数与计时器列表。
 * @author zhenghq
 */
function createManualTimers(): {
  timers: ManualTimer[]
  setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  clearTimeoutFn: (handle: unknown) => void
} {
  const timers: ManualTimer[] = []
  return {
    timers,
    setTimeoutFn: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn: (handle) => {
      ;(handle as ManualTimer).cleared = true
    }
  }
}

/**
 * 校验连续增长的字幕会等待短暂静止后再提交，并始终展示最新文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续文本变化应重置稳定计时并提交最新内容', () => {
  const manualTimers = createManualTimers()
  const committed: string[] = []
  const controller = new StabilizedTextController({
    settleMs: 180,
    maxWaitMs: 750,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    onCommit: (text) => committed.push(text)
  })

  controller.push('你', 'segment-1:source', false)
  controller.push('你好', 'segment-1:source', false)
  controller.push('你好啊', 'segment-1:source', false)

  assert.deepEqual(committed, ['你'], '新流键应立即可见')
  const firstSettle = manualTimers.timers.find(
    (timer) => timer.delayMs === 180 && !timer.cleared
  )
  assert.ok(firstSettle, '最新文本应安排稳定计时')
  firstSettle.callback()

  assert.deepEqual(committed, ['你', '你好啊'])
})

/**
 * 校验文本持续变化时仍会由最大等待计时器推进，避免字幕长时间冻结。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文本持续变化时应由最大等待时间强制提交', () => {
  const manualTimers = createManualTimers()
  const committed: string[] = []
  const controller = new StabilizedTextController({
    settleMs: 400,
    maxWaitMs: 1500,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    onCommit: (text) => committed.push(text)
  })

  controller.push('第一版', 'segment-1:target', false)
  controller.push('第一版译文', 'segment-1:target', false)
  const maxWait = manualTimers.timers.find((timer) => timer.delayMs === 1500)
  assert.ok(maxWait, '应安排最大等待计时器')

  controller.push('第一版译文继续', 'segment-1:target', false)
  maxWait.callback()

  assert.deepEqual(committed, ['第一版', '第一版译文继续'])
})

/**
 * 校验切换到新段落、空文本或强制提交时立即刷新且旧计时器不能回写。
 * @returns 无返回值。
 * @author zhenghq
 */
test('流键变化、空文本与立即提交应清空旧计时器', () => {
  const manualTimers = createManualTimers()
  const committed: string[] = []
  const controller = new StabilizedTextController({
    settleMs: 180,
    maxWaitMs: 750,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    onCommit: (text) => committed.push(text)
  })

  controller.push('旧句', 'segment-1:source', false)
  controller.push('旧句继续', 'segment-1:source', false)
  controller.push('新句', 'segment-2:source', false)
  controller.push('', 'segment-2:source', false)
  controller.push('终稿', 'segment-2:source', true)

  assert.deepEqual(committed, ['旧句', '新句', '', '终稿'])
  assert.ok(manualTimers.timers.length >= 2)
  assert.ok(manualTimers.timers.every((timer) => timer.cleared))
})

/**
 * 校验文本回退到当前已提交内容时取消未提交草稿。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文本回退到已提交内容时应取消待提交草稿', () => {
  const manualTimers = createManualTimers()
  const committed: string[] = []
  const controller = new StabilizedTextController({
    settleMs: 180,
    maxWaitMs: 750,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    onCommit: (text) => committed.push(text)
  })

  controller.push('Hello', 'segment-1:source', false)
  controller.push('Hello world', 'segment-1:source', false)
  controller.push('Hello', 'segment-1:source', false)
  controller.dispose()

  assert.deepEqual(committed, ['Hello'])
  assert.ok(manualTimers.timers.every((timer) => timer.cleared))
})
