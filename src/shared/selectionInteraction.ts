import { isPointInsideBounds, type ScreenBounds } from './selectionBehavior'

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
  ocrVisible: boolean
  listenerPausedForOcr: boolean
  internalActivationLeaseUntil: number
  now?: number
}

/** Dock 激活判定结果。 */
export interface DockActivationDecision {
  allowed: boolean
  reason?: string
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
  const checks: Array<[boolean, string]> = [
    [context.interactionState !== 'idle', 'selection-interaction-active'],
    [context.selectionButtonVisible, 'selection-button-visible'],
    [context.popupVisible, 'translation-popup-visible'],
    [context.ocrVisible, 'ocr-selection-visible'],
    [context.listenerPausedForOcr, 'ocr-listener-paused'],
    [context.internalActivationLeaseUntil > now, 'internal-activation-lease']
  ]
  const blocked = checks.find(([active]) => active)
  return blocked ? { allowed: false, reason: blocked[1] } : { allowed: true }
}
