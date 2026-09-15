import { isPointInsideBounds, type ScreenBounds } from './selectionBehavior'
// 底层全局钩子（uiohook-napi）在 macOS 上存在缺陷：input_hook.c 的 process_button_pressed
// 用全局 click_button/click_count 统计点击次数，且 kCGEventOtherMouseUp 分支错误地调用
// process_button_pressed，导致「右键按下 + 左键按下 + 左键松开」被上报为 clicks=2 的双击。
// 因此这里不再信任 hook 上报的 clicks，而是在 JS 侧按左键松开序列自维护双击判定；
// hook 上报的 clicks 仅作为提前判定信息使用。

/** 选区交互阶段。 */
export type SelectionInteractionState =
  | 'idle'
  | 'button-visible'
  | 'capturing'
  | 'translating'
  | 'ocr-selecting'

/** 鼠标按下事件的处理结果。 */
export type PointerDownResult = 'track' | 'ignore' | 'consume'

/** 选区交互状态快照。 */
export interface SelectionInteractionSnapshot {
  state: SelectionInteractionState
  token: number
}

/** Dock 激活判定输入。 */
export interface DockActivationContext {
  interactionState: SelectionInteractionState
  selectionButtonVisible: boolean
  popupVisible: boolean
  /** 弹窗是否正在交还 macOS 前台（可见但逻辑已关闭）。 */
  popupHandingBackFront: boolean
  /** macOS hiservices 修复原生对话框是否正在显示；其 activate 属于内部激活。 */
  hiServicesRepairPromptVisible: boolean
  ocrVisible: boolean
  listenerPausedForOcr: boolean
  internalActivationLeaseUntil: number
  /** 是否处于内部窗口收尾抑制期（交还前台 → 隐藏弹窗 → hide 生效）。 */
  internalWindowTeardown?: boolean
  now?: number
}

/** Dock 激活判定所依据的各检查项取值，供放行日志记录。 */
export interface DockActivationChecks {
  selectionInteractionActive: boolean
  selectionButtonVisible: boolean
  popupVisible: boolean
  popupHandingBackFront: boolean
  hiServicesRepairPromptVisible: boolean
  ocrVisible: boolean
  listenerPausedForOcr: boolean
  internalActivationLeaseActive: boolean
  internalWindowTeardown: boolean
}

/** Dock 激活判定结果。 */
export interface DockActivationDecision {
  allowed: boolean
  reason?: string
  /** 本次判定所依据的各检查项取值；放行与拦截时都会返回。 */
  checks?: DockActivationChecks
}

/** 鼠标按下分类输入。 */
export interface PointerDownContext {
  ocrActive: boolean
  selectionButtonHit: boolean
  popupHit: boolean
  focusedOwnWindowHit: boolean
}

/** 鼠标按下后的内部跟踪状态。 */
export interface PointerTrackingState {
  downAt: { x: number; y: number; time: number } | null
  modifiersHeld: boolean
}

/**
 * 管理选区交互的状态、token 和异步流程所有权。
 * @author zhenghq
 */
export class SelectionInteractionController {
  private state: SelectionInteractionState = 'idle'
  private token = 0

  /**
   * 开始展示选区按钮并创建新一轮交互 token。
   * @returns 新建的交互 token。
   * @author zhenghq
   */
  showButton(): number {
    this.token += 1
    this.state = 'button-visible'
    return this.token
  }

  /**
   * 取得按钮取词流程的唯一所有权。
   * @returns 当前 token；状态不允许开始取词时返回 null。
   * @author zhenghq
   */
  beginButtonCapture(): number | null {
    if (this.state !== 'button-visible') return null
    this.state = 'capturing'
    return this.token
  }

  /**
   * 开始一次自动翻译流程并创建新的交互 token。
   * @returns 新建的交互 token。
   * @author zhenghq
   */
  beginTranslation(): number {
    this.token += 1
    this.state = 'translating'
    return this.token
  }

  /**
   * 开始 OCR 框选交互并创建新的交互 token。
   * @returns 新建的交互 token。
   * @author zhenghq
   */
  beginOcrSelection(): number {
    this.token += 1
    this.state = 'ocr-selecting'
    return this.token
  }

  /**
   * 判断指定 token 是否仍拥有当前交互流程。
   * @param token 待检查的交互 token。
   * @returns token 仍有效时返回 true。
   * @author zhenghq
   */
  isCurrent(token: number): boolean {
    return token === this.token
  }

  /**
   * 将当前 token 转换到指定状态。
   * @param token 当前流程 token。
   * @param state 目标状态。
   * @returns 转换成功时返回 true。
   * @author zhenghq
   */
  transition(token: number, state: SelectionInteractionState): boolean {
    if (!this.isCurrent(token)) return false
    this.state = state
    return true
  }

  /**
   * 释放当前 token 的流程所有权并回到空闲状态。
   * @param token 待释放的流程 token。
   * @returns 释放成功时返回 true。
   * @author zhenghq
   */
  release(token: number): boolean {
    if (!this.isCurrent(token)) return false
    this.state = 'idle'
    return true
  }

  /**
   * 使当前流程失效并回到空闲状态。
   * @returns 新的失效 token。
   * @author zhenghq
   */
  invalidate(): number {
    this.token += 1
    this.state = 'idle'
    return this.token
  }

  /**
   * 使普通选区流程失效，但不打断当前独占鼠标事件的 OCR 框选流程。
   * @returns 普通流程被失效时返回新 token；OCR 正在进行时返回 null。
   * @author zhenghq
   */
  invalidateSelectionFlow(): number | null {
    if (this.state === 'ocr-selecting') return null
    return this.invalidate()
  }

  /**
   * 返回当前选区交互状态快照。
   * @returns 当前状态和 token。
   * @author zhenghq
   */
  snapshot(): SelectionInteractionSnapshot {
    return { state: this.state, token: this.token }
  }
}

/**
 * 判断鼠标按下事件应由应用消费、忽略还是跟踪。
 * @param context 当前交互窗口命中情况。
 * @returns 标准化的鼠标按下结果。
 * @author zhenghq
 */
export function classifySelectionPointerDown(context: PointerDownContext): PointerDownResult {
  if (context.ocrActive || context.selectionButtonHit) return 'consume'
  if (context.popupHit || context.focusedOwnWindowHit) return 'ignore'
  return 'track'
}

/**
 * 根据鼠标按下分类结果计算全局监听器需要保存的拖拽状态。
 * @param result 鼠标按下处理结果。
 * @param point 鼠标屏幕坐标。
 * @param observedAt 事件观测时间。
 * @param hasModifier 是否按下系统修饰键。
 * @returns 供 mouseup 使用的内部跟踪状态。
 * @author zhenghq
 */
export function resolvePointerDownTracking(
  result: PointerDownResult,
  point: { x: number; y: number },
  observedAt: number,
  hasModifier: boolean
): PointerTrackingState {
  if (result !== 'track') return { downAt: null, modifiersHeld: false }
  if (hasModifier) return { downAt: null, modifiersHeld: true }
  return {
    downAt: { x: point.x, y: point.y, time: observedAt },
    modifiersHeld: false
  }
}

/**
 * 在自有窗口失焦时清理真正起始于该窗口内部的旧鼠标状态。
 * macOS 可能先把外部应用的全局 mousedown 送到钩子，再派发设置窗口 blur；
 * 因此不能在 blur 中无条件清空，否则用户切出设置页后的第一次划词会丢失起点。
 * @param state 当前全局鼠标跟踪状态。
 * @param windowBounds 刚刚失焦的自有窗口边界。
 * @returns 起点位于失焦窗口内时返回已清理状态，否则原样保留外部应用状态。
 * @author zhenghq
 */
export function resetPointerTrackingForWindowBlur(
  state: PointerTrackingState,
  windowBounds: ScreenBounds
): PointerTrackingState {
  if (!state.downAt || !isPointInsideBounds(state.downAt, windowBounds)) return state
  return { downAt: null, modifiersHeld: false }
}

/**
 * 判断 macOS activate 是否应继续执行 Dock 入口逻辑。
 * @param context 当前交互窗口、状态和内部激活租约。
 * @returns 是否允许按 Dock 激活处理及被抑制原因。
 * @author zhenghq
 */
export function canTreatActivateAsDockLaunch(context: DockActivationContext): DockActivationDecision {
  const now = context.now ?? Date.now()
  const internalWindowTeardown = context.internalWindowTeardown === true
  // 收尾抑制期由内部窗口显隐确定性触发，是最高优先级的硬拦截：
  // 此时无需再逐项判定，直接按内部激活忽略即可。
  if (internalWindowTeardown) return { allowed: false, reason: 'internal-window-teardown' }
  const checks: DockActivationChecks = {
    selectionInteractionActive: context.interactionState !== 'idle',
    selectionButtonVisible: context.selectionButtonVisible,
    popupVisible: context.popupVisible,
    popupHandingBackFront: context.popupHandingBackFront,
    hiServicesRepairPromptVisible: context.hiServicesRepairPromptVisible,
    ocrVisible: context.ocrVisible,
    listenerPausedForOcr: context.listenerPausedForOcr,
    internalActivationLeaseActive: context.internalActivationLeaseUntil > now,
    internalWindowTeardown
  }
  const blockers: Array<[boolean, string]> = [
    [checks.selectionInteractionActive, 'selection-interaction-active'],
    [checks.selectionButtonVisible, 'selection-button-visible'],
    [checks.popupVisible, 'translation-popup-visible'],
    [checks.popupHandingBackFront, 'translation-popup-handing-back-front'],
    [checks.hiServicesRepairPromptVisible, 'hiservices-repair-prompt-visible'],
    [checks.ocrVisible, 'ocr-selection-visible'],
    [checks.listenerPausedForOcr, 'ocr-listener-paused'],
    [checks.internalActivationLeaseActive, 'internal-activation-lease']
  ]
  const blocked = blockers.find(([active]) => active)
  return blocked
    ? { allowed: false, reason: blocked[1], checks }
    : { allowed: true, checks }
}

/** 自维护双击判定的最大间隔（毫秒）；严格小于该值才算双击，短于 macOS 默认双击间隔 500ms。 */
export const DOUBLE_CLICK_MAX_INTERVAL_MS = 400

/** 自维护双击判定的最大位置漂移（像素），超过视为两次独立点击。 */
export const DOUBLE_CLICK_MAX_DRIFT_PX = 12

/** 单次“点击”允许的最大自身位移（像素）；超过说明这次按下是拖拽，不参与双击配对。 */
export const CLICK_MAX_SELF_TRAVEL_PX = 4

/** 一次左键松开样本，用于自维护双击判定。 */
export interface PrimaryClickSample {
  /** 鼠标键编号：1=左键、2=右键、3=中键、4/5=侧键；缺失时按左键处理。 */
  button?: number
  /** 按下位置到松开位置的位移（像素），用于判断本次是否属于“拖拽”而非“点击”。 */
  travel: number
  /** 屏幕横坐标。 */
  x: number
  /** 屏幕纵坐标。 */
  y: number
  /** 事件观测时间（毫秒）。 */
  time: number
}

/** 一次左键松开的双击判定结果。 */
export interface DoubleClickSequenceResult {
  /** 归一化后的点击次数：非双击固定为 1，双击为 2。 */
  clicks: number
  /**
   * 本次左键松开样本：只有本次属于“点击”（自身位移不超过 CLICK_MAX_SELF_TRAVEL_PX）
   * 时才返回样本供下一次判定；拖拽结束时返回 null，避免与后续点击拼成假双击。
   */
  sample: PrimaryClickSample | null
}

/**
 * 判断鼠标键编号是否为主键（左键）。
 * 全局钩子缺失 button 字段时按左键处理，保证旧行为兼容；
 * 2=右键、3=中键、4/5=侧键一律视为非左键，不参与划词手势与双击判定。
 * @param button 全局鼠标事件上报的键编号；1=左键、2=右键、3=中键、4/5=侧键。
 * @returns 缺失或等于 1 时返回 true，其余键返回 false。
 * @author zhenghq
 */
export function isPrimaryMouseButton(button: number | undefined | null): boolean {
  if (button === undefined || button === null) return true
  return button === 1
}

/**
 * 归一化全局钩子上报的连续点击次数。
 * 底层 hook 的计数在 macOS 上会被非左键事件污染，因此缺失、非有限值、0、负数与 1
 * 一律归一为 1，其余取值按“至少两次点击”处理为不小于 2。
 * @param clicks 全局钩子上报的连续点击次数。
 * @returns 归一化后的点击次数，最小为 1。
 * @author zhenghq
 */
export function normalizeReportedClicks(clicks: number | undefined | null): number {
  if (clicks === undefined || clicks === null) return 1
  if (!Number.isFinite(clicks) || clicks <= 1) return 1
  return Math.max(2, Math.trunc(clicks))
}

/**
 * 根据上一次与本次左键松开样本判定本次是否构成双击。
 * 判定以两次左键松开的间隔、位置漂移与各自自身位移为准：两次都必须为左键，
 * 且各自都必须是“点击”（按下到松开的位移不超过 CLICK_MAX_SELF_TRAVEL_PX），
 * 时间间隔必须严格小于 DOUBLE_CLICK_MAX_INTERVAL_MS，位置漂移不得超过 DOUBLE_CLICK_MAX_DRIFT_PX。
 * 拖拽结束时返回的 sample 为 null，从根上阻断“拖拽划词 + 随后单击”被拼成假双击。
 * @param previous 上一次左键松开样本；没有历史样本（或历史已被清空）时传入 null。
 * @param current 本次左键松开样本。
 * @returns 本次点击次数（1 或 2）与供下次判定使用的样本。
 * @author zhenghq
 */
export function resolveDoubleClickSequence(
  previous: PrimaryClickSample | null,
  current: PrimaryClickSample
): DoubleClickSequenceResult {
  const sample: PrimaryClickSample = {
    button: current.button,
    travel: current.travel,
    x: current.x,
    y: current.y,
    time: current.time
  }
  // 本次按下到松开自身发生位移，说明这是一次拖拽（划词）而非点击，不得参与双击配对。
  // 否则“拖拽划词后紧接着在原落点附近单击”会被拼成假双击。
  if (!(current.travel <= CLICK_MAX_SELF_TRAVEL_PX)) return { clicks: 1, sample: null }
  if (!previous) return { clicks: 1, sample }
  if (!isPrimaryMouseButton(previous.button) || !isPrimaryMouseButton(current.button)) {
    return { clicks: 1, sample }
  }
  // 上一次松开若本身也是拖拽，同样不能与本次点击拼成双击。
  if (!(previous.travel <= CLICK_MAX_SELF_TRAVEL_PX)) return { clicks: 1, sample }
  const interval = current.time - previous.time
  // 必须严格小于阈值；负间隔（时间回退）同样不构成双击。
  if (!(interval >= 0) || interval >= DOUBLE_CLICK_MAX_INTERVAL_MS) return { clicks: 1, sample }
  const dx = current.x - previous.x
  const dy = current.y - previous.y
  if (Math.sqrt(dx * dx + dy * dy) > DOUBLE_CLICK_MAX_DRIFT_PX) return { clicks: 1, sample }
  return { clicks: 2, sample }
}
