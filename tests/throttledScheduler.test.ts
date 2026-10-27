import assert from 'node:assert/strict'
import test from 'node:test'
import { createThrottledScheduler } from '../src/shared/throttledScheduler.ts'

/**
 * 创建可手动推进的假定时器，用于验证节流调度在连续请求下的触发节奏。
 * @returns 注入用定时器接口与时钟推进函数。
 * @author zhenghq
 */
function createFakeTimers() {
  let now = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; handler: () => void }>()

  const timers = {
    setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
      const id = nextId
      nextId += 1
      scheduled.set(id, { at: now + Math.max(0, ms), handler })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
      scheduled.delete(handle as unknown as number)
    }
  }

  /**
   * 推进假时钟并按到期顺序触发定时器回调。
   * @param ms 推进的毫秒数。
   * @returns 无返回值。
   * @author zhenghq
   */
  function advance(ms: number): void {
    const target = now + ms
    for (;;) {
      let dueId: number | null = null
      let dueAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of scheduled) {
        if (entry.at <= target && entry.at < dueAt) {
          dueAt = entry.at
          dueId = id
        }
      }
      if (dueId === null) break
      const entry = scheduled.get(dueId)
      scheduled.delete(dueId)
      now = dueAt
      entry?.handler()
    }
    now = target
  }

  return { timers, advance }
}

test('单次请求应在间隔到期后触发一次回调', () => {
  const { timers, advance } = createFakeTimers()
  let calls = 0
  const scheduler = createThrottledScheduler(() => { calls += 1 }, 60, timers)

  scheduler.request()
  advance(59)
  assert.equal(calls, 0)
  advance(1)
  assert.equal(calls, 1)
  advance(1000)
  assert.equal(calls, 1)
})

test('持续高频请求应周期性触发而不是被无限推迟', () => {
  const { timers, advance } = createFakeTimers()
  let calls = 0
  const scheduler = createThrottledScheduler(() => { calls += 1 }, 60, timers)

  for (let i = 0; i < 60; i += 1) {
    scheduler.request()
    advance(16)
  }

  assert.ok(calls >= 10, `预期流式期间多次触发测量，实际仅 ${calls} 次`)
})

test('取消调度后不应再触发回调', () => {
  const { timers, advance } = createFakeTimers()
  let calls = 0
  const scheduler = createThrottledScheduler(() => { calls += 1 }, 60, timers)

  scheduler.request()
  scheduler.cancel()
  advance(1000)
  assert.equal(calls, 0)
})
