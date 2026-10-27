/**
 * 弹窗真实隐藏期间需要临时撤销 key window 候选资格的窗口能力。
 */
export interface SettingsWindowFocusTarget {
  /** 返回窗口是否已销毁。 */
  isDestroyed(): boolean
  /** 返回窗口当前是否可见。 */
  isVisible(): boolean
  /** 返回窗口当前是否持有键盘焦点。 */
  isFocused(): boolean
  /** 设置窗口是否可作为 key window。 */
  setFocusable(focusable: boolean): void
}

/**
 * 在翻译弹窗同步隐藏的极短窗口内撤销设置页的 key window 候选资格。
 *
 * macOS 在隐藏当前 key window 时，会从同一应用内重新选择下一个可聚焦窗口；
 * 设置页虽在后台可见，仍可能因此被系统提到最前。保护只覆盖 win.hide() 前后
 * 的同步调用栈，不参与取词生命周期，也不使用定时器或异步恢复，避免重新引入
 * 旧的全局焦点挂起竞态。
 * @param platform 当前运行平台。
 * @param target 可能被系统提升的设置窗口。
 * @returns 幂等的恢复函数；无需保护时返回空操作。
 * @author zhenghq
 */
export function suspendSettingsWindowFocusForPopupHide(
  platform: NodeJS.Platform,
  target: SettingsWindowFocusTarget | null
): () => void {
  if (
    platform !== 'darwin' ||
    !target ||
    target.isDestroyed() ||
    !target.isVisible() ||
    // 用户正在设置页输入时，窗口已经是当前 key window，不存在被系统重新
    // 选中的问题；此时撤销可聚焦性会抢走键盘输入，必须保持原状。
    target.isFocused()
  ) {
    return () => undefined
  }

  target.setFocusable(false)
  let restored = false
  return (): void => {
    if (restored) return
    restored = true
    if (target.isDestroyed()) return
    target.setFocusable(true)
  }
}
