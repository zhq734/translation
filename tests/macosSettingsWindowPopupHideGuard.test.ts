import assert from 'node:assert/strict'
import test from 'node:test'
import {
  forceRestoreSettingsWindowFocus,
  suspendSettingsWindowFocusForPopupHide
} from '../src/main/settingsWindowPopupHideGuard.ts'

/**
 * 创建设置窗口焦点保护测试替身。
 * @param options 测试窗口的销毁、可见与聚焦状态。
 * @returns 可记录 setFocusable 调用的窗口替身。
 * @author zhenghq
 */
function createFocusTarget(
  options: {
    destroyed?: boolean
    visible?: boolean
    focused?: boolean
  } = {}
) {
  let destroyed = options.destroyed ?? false
  const calls: boolean[] = []
  return {
    calls,
    target: {
      isDestroyed: () => destroyed,
      isVisible: () => options.visible ?? true,
      isFocused: () => options.focused ?? false,
      setFocusable: (focusable: boolean) => calls.push(focusable)
    },
    destroy: () => {
      destroyed = true
    }
  }
}

test('macOS 后台租约释放后必须保持不可聚焦，等待显式入口恢复', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  assert.deepEqual(fixture.calls, [false], '隐藏弹窗前必须撤销设置页可聚焦性')
  restore()
  assert.deepEqual(
    fixture.calls,
    [false],
    '后台收尾释放租约时不得调用 setFocusable(true)，否则 macOS 会重新选中设置页'
  )
  restore()
  assert.deepEqual(fixture.calls, [false], '重复释放必须保持幂等')
})

test('重复挂起设置页焦点保护时不得短暂恢复 key window 候选资格', () => {
  const fixture = createFocusTarget()
  const firstRestore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)
  const secondRestore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  // 弹窗关闭可能被多个入口重复触发。旧实现会在第二次挂起前先调用第一次的恢复函数，
  // 让设置页重新成为 key window 候选，正好给 macOS 一次把设置页顶到最前的机会。
  assert.deepEqual(fixture.calls, [false], '重复挂起必须保持设置页不可聚焦')

  firstRestore()
  assert.deepEqual(fixture.calls, [false], '旧恢复函数不得提前解除新的保护租约')

  secondRestore()
  assert.deepEqual(fixture.calls, [false], '最后一方释放也不得在后台自动恢复可聚焦性')
})

test('划词生命周期与弹窗关闭租约并存时只在显式入口恢复', () => {
  const fixture = createFocusTarget()
  const selectionRestore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)
  const popupCloseRestore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  assert.deepEqual(fixture.calls, [false], '两个生命周期只能撤销一次可聚焦性')

  popupCloseRestore()
  assert.deepEqual(fixture.calls, [false], '弹窗关闭租约释放后划词租约仍必须保持保护')

  selectionRestore()
  assert.deepEqual(fixture.calls, [false], '最后一方释放后仍不得在后台恢复设置页')

  forceRestoreSettingsWindowFocus('darwin', fixture.target)
  assert.deepEqual(fixture.calls, [false, true], '只有显式入口可以恢复设置页可聚焦性')
})

test('显式打开设置页必须立即强制恢复，迟到租约不得再次改变窗口状态', () => {
  const fixture = createFocusTarget()
  const selectionRestore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)
  const popupCloseRestore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  forceRestoreSettingsWindowFocus('darwin', fixture.target)
  assert.deepEqual(fixture.calls, [false, true], '显式入口必须立即恢复可聚焦性')

  selectionRestore()
  popupCloseRestore()
  assert.deepEqual(fixture.calls, [false, true], '强制恢复后的迟到释放必须保持幂等')
})

test('非 macOS 不得切换设置页可聚焦性', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide('win32', fixture.target)

  restore()
  assert.deepEqual(fixture.calls, [])
})

test('用户正在操作设置页时不得撤销其可聚焦性', () => {
  const fixture = createFocusTarget({ focused: true })
  const restore = suspendSettingsWindowFocusForPopupHide('darwin', fixture.target)

  restore()
  assert.deepEqual(
    fixture.calls,
    [],
    '设置页已持有焦点说明用户正在主动使用，不能为弹窗关闭强行抢走键盘输入能力'
  )
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

test('通用弹窗关闭路径在应用已失活时不得修改后台设置页的可聚焦性', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: false }
  )

  assert.deepEqual(
    fixture.calls,
    [],
    '应用失活时修改可聚焦性会触发 macOS 重排窗口，不能把后台设置页写回前台'
  )
  restore()
  assert.deepEqual(fixture.calls, [], '释放租约时同样不得写入后台窗口状态')
})

test('设置页真实失焦后即使应用已失活也必须撤销后台 key window 候选资格', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: false, source: 'window-blur' }
  )

  // macOS 会先派发 did-resign-active，再派发设置窗口 blur。若因 appActive=false
  // 跳过撤销，后台设置页会继续保留 key window 候选资格，后续按钮或弹窗显隐时
  // 被系统重新选中并闪到最前。真实 blur 已证明窗口不再持有用户输入焦点，可安全撤销。
  assert.deepEqual(
    fixture.calls,
    [false],
    '真实 blur 路径必须允许在应用失活后撤销后台设置页候选资格'
  )
  restore()
  assert.deepEqual(fixture.calls, [false], '释放后台租约时仍不得恢复可聚焦性')
})

test('首次划词发现未聚焦的后台设置页时必须在应用失活后补做撤销', () => {
  const fixture = createFocusTarget()
  const restore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: false, source: 'selection' }
  )

  // 启动时设置页可能只以 show({focus:false}) 上屏，从未获得焦点，也就不会派发
  // blur。首次划词是最后一个能确定窗口可见、未聚焦且不属于用户当前输入的时机。
  assert.deepEqual(
    fixture.calls,
    [false],
    '首次划词必须为从未失焦的后台设置页补做一次候选资格撤销'
  )
  restore()
  assert.deepEqual(fixture.calls, [false], '划词结束只释放引用，不得在后台恢复可聚焦性')
})

test('真实 blur 与首次划词也不得撤销正在聚焦的设置页', () => {
  for (const source of ['window-blur', 'selection'] as const) {
    const fixture = createFocusTarget({ focused: true })
    const restore = suspendSettingsWindowFocusForPopupHide(
      'darwin',
      fixture.target,
      { appActive: false, source }
    )

    assert.deepEqual(fixture.calls, [], `${source} 不得抢走设置页当前键盘焦点`)
    restore()
    assert.deepEqual(fixture.calls, [], `${source} 无需保护时恢复函数必须无副作用`)
  }
})

test('焦点保护必须上报是否实际撤销候选资格及来源', () => {
  const fixture = createFocusTarget()
  const events: Array<{ source: string; appActive: boolean; applied: boolean }> = []

  suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    {
      appActive: false,
      source: 'selection',
      onDiagnostic: (event) => events.push(event)
    }
  )()

  assert.deepEqual(events, [{ source: 'selection', appActive: false, applied: true }],
    '诊断必须准确记录真实 blur/首次划词是否实际执行了候选资格撤销')
})

test('连续快速划词复用租约时只能写入一次系统窗口能力', () => {
  const fixture = createFocusTarget()
  const blurRestore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: false, source: 'window-blur' }
  )
  const selectionRestore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: false, source: 'selection' }
  )
  const popupRestore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: false, source: 'popup-hide' }
  )

  assert.deepEqual(fixture.calls, [false], '多个生命周期共用租约时不得重复写窗口能力')

  blurRestore()
  selectionRestore()
  popupRestore()
  assert.deepEqual(fixture.calls, [false], '所有后台引用释放后仍不得自动恢复可聚焦性')
})

test('应用仍激活且设置页正在聚焦时不得撤销用户输入能力', () => {
  const fixture = createFocusTarget({ focused: true })
  const restore = suspendSettingsWindowFocusForPopupHide(
    'darwin',
    fixture.target,
    { appActive: true }
  )

  assert.deepEqual(fixture.calls, [], '用户正在设置页输入时不得抢走键盘焦点能力')
  restore()
  assert.deepEqual(fixture.calls, [], '无需保护时恢复函数必须保持无副作用')
})
