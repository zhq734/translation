import assert from 'node:assert/strict'
import test from 'node:test'
import {
  startAutoTriggerLifecycle,
  type AutoTriggerHook,
  type AutoTriggerHookEvent,
  type AutoTriggerHookListener
} from '../src/main/autoTriggerLifecycle.ts'

interface HookHarness {
  hook: AutoTriggerHook
  listenerCount: (event: AutoTriggerHookEvent) => number
  allowStart: () => void
}

/**
 * 创建可控制启动失败的全局钩子测试夹具。
 * @returns 钩子替身、监听器数量读取器和允许启动的控制函数。
 * @author zhenghq
 */
function createHookHarness(): HookHarness {
  const listeners = new Map<AutoTriggerHookEvent, Set<AutoTriggerHookListener>>()
  let shouldThrow = true
  const hook: AutoTriggerHook = {
    on: (event, listener) => {
      const eventListeners = listeners.get(event) ?? new Set<AutoTriggerHookListener>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener)
    },
    start: () => {
      if (shouldThrow) throw new Error('mock start failure')
    }
  }
  return {
    hook,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    allowStart: () => {
      shouldThrow = false
    }
  }
}

test('全局钩子启动失败应清理监听器与回调状态，并允许下一次重新启动', () => {
  const harness = createHookHarness()
  let callbackAttached = true
  const listeners = {
    mousedown: () => undefined,
    mouseup: () => undefined,
    keydown: () => undefined
  }

  const firstStarted = startAutoTriggerLifecycle({
    hook: harness.hook,
    listeners,
    clearCallbackState: () => {
      callbackAttached = false
    },
    logFailure: () => undefined
  })

  assert.equal(firstStarted, false)
  assert.equal(callbackAttached, false)
  assert.equal(harness.listenerCount('mousedown'), 0)
  assert.equal(harness.listenerCount('mouseup'), 0)
  assert.equal(harness.listenerCount('keydown'), 0)

  callbackAttached = true
  harness.allowStart()
  const secondStarted = startAutoTriggerLifecycle({
    hook: harness.hook,
    listeners,
    clearCallbackState: () => {
      callbackAttached = false
    },
    logFailure: () => undefined
  })

  assert.equal(secondStarted, true)
  assert.equal(callbackAttached, true)
  assert.equal(harness.listenerCount('mousedown'), 1)
  assert.equal(harness.listenerCount('mouseup'), 1)
  assert.equal(harness.listenerCount('keydown'), 1)
})
