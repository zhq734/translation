import assert from 'node:assert/strict'
import test from 'node:test'
import { suspendSettingsWindowFocusForPopupHide } from '../src/main/settingsWindowPopupHideGuard.ts'

/**
 * 创建设置窗口焦点保护测试替身。
 * @param options 测试窗口的销毁与可见状态。
 * @returns 可记录 setFocusable 调用的窗口替身。
 * @author zhenghq
 */
function createFocusTarget(options: { destroyed?: boolean; visible?: boolean } = {}) {
  let destroyed = options.destroyed ?? false
  const calls: boolean[] = []
  return {
    calls,
    target: {
      isDestroyed: () => destroyed,
      isVisible: () => options.visible ?? true,
      setFocusable: (focusable: boolean) => calls.push(focusable)
    },
    destroy: () => {
      destroyed = true
    }
  }
}

test('macOS 可见设置页只在弹窗隐藏期间退出 key window 候选集合', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  assert.deepEqual(fixture.calls, [false], '隐藏弹窗前必须撤销设置页可聚焦性')
  restore()
  assert.deepEqual(fixture.calls, [false, true], '真实隐藏后必须恢复设置页可聚焦性')
  restore()
  assert.deepEqual(fixture.calls, [false, true], '重复恢复必须保持幂等')
})

test('非 macOS 不得切换设置页可聚焦性', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide('win32', fixture.target)

  restore()
  assert.deepEqual(fixture.calls, [])
})

test('不可见、已销毁或缺失的设置页无需焦点保护', () => {
  const hidden = createFocusTarget({ visible: false })
  const destroyed = createFocusTarget({ destroyed: true })

  suspendSettingsWindowFocusForPopupHide('darwin', hidden.target)()
  suspendSettingsWindowFocusForPopupHide('darwin', destroyed.target)()
  suspendSettingsWindowFocusForPopupHide('darwin', null)()

  assert.deepEqual(hidden.calls, [])
  assert.deepEqual(destroyed.calls, [])
})

test('设置页在恢复前销毁时不得继续调用已销毁窗口', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  fixture.destroy()
  restore()

  assert.deepEqual(fixture.calls, [false], '销毁后的窗口不得再调用 setFocusable')
})
