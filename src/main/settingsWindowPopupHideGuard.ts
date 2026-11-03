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

/** 设置页焦点挂起被跳过或实际执行的原因。 */
export type SettingsWindowFocusSuspendReason =
  | 'applied'
  | 'already-suspended'
  | 'unsupported-platform'
  | 'no-target'
  | 'destroyed'
  | 'invisible'
  | 'inactive-blocked'
  | 'focused'

/** 设置页焦点保护租约；除释放引用外，还携带本次调用是否真正取得保护。 */
export interface SettingsWindowFocusLease {
  /** 释放本次调用持有的引用；重复调用必须幂等。 */
  (): void
  /** 本次调用是否取得了有效租约；安全门禁跳过时为 false。 */
  readonly acquired: boolean
  /** 本次调用是否真正调用了 setFocusable(false)。 */
  readonly applied: boolean
  /** 本次调用的实际结果或跳过原因。 */
  readonly reason: SettingsWindowFocusSuspendReason
}

/** 当前设置页焦点保护租约；同一窗口重复挂起时复用，避免短暂恢复候选资格。 */
let activeFocusLease: {
  /** 保护所作用的设置窗口。 */
  target: SettingsWindowFocusTarget
  /** 当前尚未释放的挂起请求数。 */
  pendingSuspensions: number
  /** 是否已被显式恢复强制取消；取消后的迟到释放不得再改变窗口状态。 */
  cancelled: boolean
} | null = null

/** 已确认撤销可聚焦性、尚未恢复的窗口集合；避免同一保护周期重复调用系统接口。 */
const focusSuspendedTargets = new WeakSet<SettingsWindowFocusTarget>()

/** 撤销设置页焦点候选资格时可用的上下文。 */
export interface SettingsWindowFocusSuspendOptions {
  /** 本应用在挂起开始时是否仍处于最前；缺省按最前处理以保持旧调用语义。 */
  appActive?: boolean
  /**
   * 触发挂起的窗口生命周期来源。
   *
   * `window-blur` 表示设置窗口刚刚真实失去 key 状态，`selection` 表示首次划词
   * 发现了一个可见但从未聚焦的后台设置窗口。只有这两种已确认窗口不在接收用户
   * 输入的来源，才允许在应用激活事件已变为失活后撤销候选资格。
   */
  source?: 'popup-hide' | 'selection' | 'window-blur'
  /** 记录本次挂起是否实际执行，供真机日志确认系统能力写操作没有被门禁跳过。 */
  onDiagnostic?: (event: {
    /** 触发挂起的生命周期来源。 */
    source: 'popup-hide' | 'selection' | 'window-blur'
    /** 挂起开始时的应用激活事件状态。 */
    appActive: boolean
    /** 是否实际调用了 setFocusable(false)。 */
    applied: boolean
    /** 本次挂起实际执行或被跳过的具体原因。 */
    reason: SettingsWindowFocusSuspendReason
  }) => void
}

/**
 * 在划词生命周期或翻译弹窗隐藏期间撤销设置页的 key window 候选资格。
 *
 * macOS 在隐藏当前 key window 时，会从同一应用内重新选择下一个可聚焦窗口；
 * 设置页虽在后台可见，仍可能因此被系统提到最前。同一窗口的多个生命周期请求
 * 共用引用计数租约；最后一方释放时只解除租约，绝不在后台自动恢复可聚焦性。
 * 只有用户通过托盘、菜单、Dock、设置页内点击等显式入口操作时，才通过
 * `forceRestoreSettingsWindowFocus()` 恢复，避免 `setFocusable(true)` 重新选中
 * 后台设置页并造成闪现。
 * @param platform 当前运行平台。
 * @param target 可能被系统提升的设置窗口。
 * @param options 挂起上下文；通用弹窗关闭在应用失活时不得写入后台窗口状态。
 * @returns 幂等的保护租约；无需保护时返回 `acquired=false` 的空操作。
 * @author zhenghq
 */
export function suspendSettingsWindowFocusForPopupHide(
  platform: NodeJS.Platform,
  target: SettingsWindowFocusTarget | null,
  options: SettingsWindowFocusSuspendOptions = {}
): SettingsWindowFocusLease {
  const appActive = options.appActive ?? true
  const source = options.source ?? 'popup-hide'
  // did-resign-active 通常早于设置窗口 blur 到达。真实 blur 与首次划词已证明
  // 设置窗口不在接收用户输入，此时撤销候选资格是阻止 macOS 后续重选后台窗口
  // 的必要动作。其它来源在应用失活后写窗口能力仍可能触发重排，必须保持门禁。
  const canSuspendWhileAppInactive = source === 'window-blur' || source === 'selection'
  let skipReason: SettingsWindowFocusSuspendReason | null = null
  if (platform !== 'darwin') {
    skipReason = 'unsupported-platform'
  } else if (!target) {
    skipReason = 'no-target'
  } else if (target.isDestroyed()) {
    skipReason = 'destroyed'
  } else if (!target.isVisible()) {
    skipReason = 'invisible'
  } else if (!appActive && !canSuspendWhileAppInactive) {
    skipReason = 'inactive-blocked'
  } else if (
    // 用户正在设置页输入时，窗口已经是当前 key window，不存在被系统重新
    // 选中的问题；此时撤销可聚焦性会抢走键盘输入，必须保持原状。
    target.isFocused()
  ) {
    skipReason = 'focused'
  }
  if (skipReason || !target) {
    const reason = skipReason ?? 'no-target'
    options.onDiagnostic?.({ source, appActive, applied: false, reason })
    const skippedLease = (() => undefined) as SettingsWindowFocusLease
    return Object.assign(skippedLease, {
      acquired: false,
      applied: false,
      reason
    })
  }

  // 同一次弹窗关闭可能被多个生命周期回调重复触发。重复挂起必须复用当前租约，
  // 不能先恢复再挂起：即使恢复与挂起位于同一同步栈，macOS 也可能在中间重选
  // key window，把后台设置页短暂提升到最前。
  // 只有仍在持有中的租约可以复用。上一轮已经释放的闭包不可撤销，不能把新的
  // 挂起请求绑定到它，否则新请求会立即失去引用计数。
  const reusableLease = activeFocusLease?.target === target &&
    !activeFocusLease.cancelled &&
    activeFocusLease.pendingSuspensions > 0
    ? activeFocusLease
    : null
  const lease = reusableLease ?? { target, pendingSuspensions: 0, cancelled: false }
  let applied = false
  let reason: SettingsWindowFocusSuspendReason = 'already-suspended'
  if (!reusableLease) {
    if (!focusSuspendedTargets.has(target)) {
      target.setFocusable(false)
      focusSuspendedTargets.add(target)
      applied = true
      reason = 'applied'
    }
    activeFocusLease = lease
  }
  options.onDiagnostic?.({ source, appActive, applied, reason })
  lease.pendingSuspensions += 1
  let restored = false
  const restore = (): void => {
    if (restored || lease.cancelled) return
    restored = true
    lease.pendingSuspensions = Math.max(0, lease.pendingSuspensions - 1)
    if (lease.pendingSuspensions > 0) return
    if (activeFocusLease === lease) activeFocusLease = null
    // 后台收尾只结束保护引用，不恢复 key window 候选资格。macOS 可能在
    // setFocusable(true) 的同步调用中重新选择设置页；恢复必须由显式用户入口驱动。
  }
  return Object.assign(restore, {
    acquired: true,
    applied,
    reason
  })
}

/**
 * 强制恢复设置页的 key window 候选资格，并取消当前焦点保护租约。
 *
 * 该入口只用于用户显式打开设置页：此时必须立即恢复可聚焦性，同时让所有已经
 * 发出的迟到恢复函数失效，避免它们在异步弹窗收尾阶段再次把窗口切回不可聚焦。
 * @param platform 当前运行平台。
 * @param target 需要恢复的设置窗口；省略时使用当前活动租约的目标窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
export function forceRestoreSettingsWindowFocus(
  platform: NodeJS.Platform,
  target: SettingsWindowFocusTarget | null
): void {
  if (platform !== 'darwin') return
  const lease = activeFocusLease
  if (lease) {
    // 先取消并摘除租约，再恢复窗口。这样即使恢复触发同步窗口事件并重入本模块，
    // 也不会重新复用旧租约或让旧闭包在稍后再次修改可聚焦性。
    lease.cancelled = true
    lease.pendingSuspensions = 0
    if (activeFocusLease === lease) activeFocusLease = null
  }
  const restoreTarget = target ?? lease?.target
  if (!restoreTarget || restoreTarget.isDestroyed()) return
  restoreTarget.setFocusable(true)
  focusSuspendedTargets.delete(restoreTarget)
}
