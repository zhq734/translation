import { uIOhook, UiohookKey } from 'uiohook-napi'
import { screen } from 'electron'
import {
  createObservedPointerSample,
  getSelectionGesture,
  resolveWindowsPointerPoint,
  shouldTriggerSelectionGesture,
  type ScreenBounds,
  type SelectionGesture
} from '../shared/selectionBehavior'
import {
  isPrimaryMouseButton,
  resetPointerTrackingForWindowBlur,
  resolveDoubleClickSequence,
  resolvePointerDownTracking,
  type PointerDownResult,
  type PrimaryClickSample
} from '../shared/selectionInteraction'
import { copyShortcutGuard } from './copyShortcutState'
import {
  detachAutoTriggerHookListeners,
  startAutoTriggerLifecycle,
  type AutoTriggerHook,
  type AutoTriggerHookListeners
} from './autoTriggerLifecycle'

export interface AutoTriggerOptions {
  /** 最小拖动距离（像素），低于此值视为点击而非划词。 */
  minDragDistance: number
  /** 最小按住时长（毫秒），过滤瞬时点击。 */
  minHoldMs: number
  /** 最大时长（毫秒），超过视为长时间拖拽（如拖动文件）而非划词。 */
  maxHoldMs: number
}

const DEFAULTS: AutoTriggerOptions = {
  minDragDistance: 4,
  minHoldMs: 20,
  maxHoldMs: 10000
}

type MouseSample = {
  x: number
  y: number
  time: number
  /** 鼠标键编号：1=左键、2=右键、3=中键、4/5=侧键。 */
  button?: number
}

type KeyboardSample = {
  keycode: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

type SelectionCallback = (gesture: SelectionGesture) => void
/**
 * 鼠标按下分类回调。
 * @param point 屏幕坐标（DIP）。
 * @param button 鼠标键编号：1=左键、2=右键、3=中键、4/5=侧键；缺失按左键处理。
 *   非左键只允许做“隐藏按钮/取消选区”这类副作用，不得当作点击“译”按钮。
 */
export type PointerDownCallback = (
  point: { x: number; y: number },
  button?: number
) => PointerDownResult
type CopyShortcutCallback = () => void
type PasteShortcutCallback = () => void

let running = false
let callback: SelectionCallback | null = null
let pointerDownCallback: PointerDownCallback | null = null
let copyShortcutCallback: CopyShortcutCallback | null = null
let pasteShortcutCallback: PasteShortcutCallback | null = null

let downAt: MouseSample | null = null
let modifiersHeld = false
// 自维护双击判定所需的“上一次左键松开”样本；非左键事件与超时间隔都会清空它。
let lastPrimaryMouseUp: PrimaryClickSample | null = null
// 只在 mouseup 异常分支输出，用于排查修饰键残留导致的划词失效，不产生高频日志。
let lastModifierText = 'none'

/** 返回当前全局钩子实例的最小生命周期接口。 */
const autoTriggerHook = uIOhook as unknown as AutoTriggerHook

/**
 * 将全局钩子的鼠标坐标转换为 Electron 窗口定位使用的 DIP 坐标。
 * Windows 原生钩子返回物理像素且底层使用 16 位坐标，多屏或缩放场景异常时使用当前光标兜底。
 * @param e 全局鼠标事件坐标。
 * @returns 与 Electron screen、BrowserWindow 一致的坐标。
 * @author zhenghq
 */
function resolveMousePoint(e: MouseSample): { x: number; y: number } {
  const point = { x: e.x, y: e.y }
  if (process.platform !== 'win32') return point

  return resolveWindowsPointerPoint(
    point,
    screen.screenToDipPoint(point),
    screen.getCursorScreenPoint()
  )
}

/**
 * 将鼠标事件上的修饰键状态拼成便于检索的诊断文本。
 * @param e 含 ctrl/alt/meta 标志的事件对象。
 * @returns 形如 ctrl+alt 的修饰键文本；无修饰键时返回 none。
 * @author zhenghq
 */
function describeModifiers(e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.metaKey) parts.push('meta')
  return parts.length > 0 ? parts.join('+') : 'none'
}

/**
 * 通知主进程鼠标已按下，记录起点并过滤带修饰键的拖拽操作。
 * 非左键（右键、中键、侧键）不参与划词手势与双击判定，但仍要把按下事件透传给主进程：
 * 主进程依赖该回调在点击按钮外区域时隐藏“译”按钮并取消当前选区，
 * 若在这里直接 return，右键点击会留下悬空的旧按钮，点击它会错误触发取词。
 * @param e 全局鼠标按下事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function onMouseDown(e: MouseSample & { ctrlKey: boolean; altKey: boolean; metaKey: boolean }): void {
  const point = resolveMousePoint(e)
  lastModifierText = describeModifiers(e)
  let result: PointerDownResult = 'track'
  try {
    // 非左键也透传按下事件：主进程据此隐藏“译”按钮并取消旧选区，
    // 但会依据 button 判定它不是点击按钮，不会触发翻译。
    result = pointerDownCallback?.(point, e.button) ?? 'track'
  } catch (error) {
    // 单次窗口销毁/焦点竞态不应让全局钩子回调链进入半状态；本次事件安全忽略，后续事件仍可继续监听。
    result = 'ignore'
    console.warn('[autoTrigger] 鼠标按下分类异常，本次事件已忽略:', error)
  }
  if (!isPrimaryMouseButton(e.button)) {
    // 非左键：保留上面的主进程副作用（隐藏按钮/取消选区），但不建立左键跟踪状态，
    // 并清空上一次左键松开样本，避免右键交互与随后的左键拼接成假双击。
    resetPrimaryClickState()
    modifiersHeld = false
    downAt = null
    return
  }
  const tracking = resolvePointerDownTracking(
    result,
    point,
    Date.now(),
    e.ctrlKey || e.altKey || e.metaKey
  )
  modifiersHeld = tracking.modifiersHeld
  downAt = tracking.downAt
}

/**
 * 清空自维护双击序列，避免非左键事件或长间隔与后续左键拼接成双击。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetPrimaryClickState(): void {
  lastPrimaryMouseUp = null
}

/**
 * 判断鼠标拖拽是否达到划词阈值，并通知主进程新的选区锚点。
 * 只有左键松开才进入手势判定；连续点击次数以自维护的两次左键松开序列为准，
 * 不再采信底层 hook 上报的 clicks，避免 macOS 右键污染导致的假双击。
 * @param e 全局鼠标松开事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function onMouseUp(e: MouseSample): void {
  const start = downAt
  downAt = null
  const heldModifiers = modifiersHeld
  modifiersHeld = false
  if (!isPrimaryMouseButton(e.button)) {
    resetPrimaryClickState()
    return
  }
  // 按住修饰键（Cmd/Ctrl/Alt）的拖拽不参与划词；被拒绝的松开也要清空双击序列。
  if (heldModifiers || !start || !callback) {
    resetPrimaryClickState()
    return
  }

  const end = createObservedPointerSample(resolveMousePoint(e), Date.now())
  // 本次按下到松开的自身位移：位移过大说明是拖拽划词，不参与双击配对。
  const dragDx = end.x - start.x
  const dragDy = end.y - start.y
  const sequence = resolveDoubleClickSequence(lastPrimaryMouseUp, {
    button: e.button,
    travel: Math.sqrt(dragDx * dragDx + dragDy * dragDy),
    x: end.x,
    y: end.y,
    time: end.time
  })
  // 拖拽结束时 sample 为 null，显式清空避免与后续点击拼成假双击。
  lastPrimaryMouseUp = sequence.sample
  const clicks = sequence.clicks
  const gesture = getSelectionGesture(start, end, clicks)
  if (!shouldTriggerSelectionGesture(gesture, clicks, DEFAULTS)) return

  console.log(
    `[autoTrigger] 检测到选区 clicks=${clicks} distance=${Math.round(gesture.distance)} duration=${gesture.durationMs}ms button=${e.button ?? 1}`
  )
  callback(gesture)
}

/**
 * 观察用户按下的系统复制快捷键，让内部取词流程保留用户刚复制的剪贴板内容。
 * @param e 全局键盘按下事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function onKeyDown(e: KeyboardSample): void {
  const hasPrimaryModifier = e.ctrlKey || e.metaKey
  if (!hasPrimaryModifier || e.altKey || e.shiftKey) return
  if (e.keycode === UiohookKey.C) {
    if (copyShortcutGuard.observeCopyShortcut()) copyShortcutCallback?.()
    return
  }
  if (e.keycode === UiohookKey.V) {
    pasteShortcutCallback?.()
    return
  }
}

/**
 * 解绑全局钩子事件监听器，保证监听器注册状态与运行标记始终一致。
 * @returns 无返回值。
 * @author zhenghq
 */
function detachHookListeners(): void {
  detachAutoTriggerHookListeners(autoTriggerHook, getHookListeners())
}

/**
 * 返回需要注册到全局钩子的固定事件监听器集合。
 * @returns 鼠标按下、鼠标松开和键盘按下监听器。
 * @author zhenghq
 */
function getHookListeners(): AutoTriggerHookListeners {
  return {
    mousedown: onMouseDown as AutoTriggerHookListeners['mousedown'],
    mouseup: onMouseUp as AutoTriggerHookListeners['mouseup'],
    keydown: onKeyDown as AutoTriggerHookListeners['keydown']
  }
}

/**
 * 清空全局钩子持有的业务回调状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearAutoTriggerCallbacks(): void {
  callback = null
  pointerDownCallback = null
  copyShortcutCallback = null
  pasteShortcutCallback = null
}

/**
 * 启动全局鼠标监听，用于发现跨应用的划词动作。
 * @param cb 发现有效划词后的回调。
 * @param onPointerDown 发现鼠标按下时的回调，返回 track、ignore 或 consume。
 * @param onCopyShortcut 发现用户复制快捷键时的回调，用于中止剪贴板取词。
 * @param onPasteShortcut 发现用户粘贴快捷键时的回调，用于中止剪贴板取词。
 * @returns 钩子成功启动时返回 true，启动失败时返回 false。
 * @author zhenghq
 */
export function startAutoTrigger(
  cb: SelectionCallback,
  onPointerDown?: PointerDownCallback,
  onCopyShortcut?: CopyShortcutCallback,
  onPasteShortcut?: PasteShortcutCallback
): boolean {
  stopAutoTrigger()
  callback = cb
  pointerDownCallback = onPointerDown ?? null
  copyShortcutCallback = onCopyShortcut ?? null
  pasteShortcutCallback = onPasteShortcut ?? null
  const started = startAutoTriggerLifecycle({
    hook: autoTriggerHook,
    listeners: getHookListeners(),
    clearCallbackState: clearAutoTriggerCallbacks,
    logFailure: (error) => {
      console.warn('[selection-translator] 划词监听启动失败:', (error as Error).message)
    }
  })
  running = started
  if (started) {
    console.log('[autoTrigger] 划词监听已启动')
    return true
  }
  return false
}

/**
 * 停止全局鼠标监听并清理当前拖拽状态。
 * @returns 无返回值。
 * @author zhenghq
 */
export function stopAutoTrigger(): void {
  detachHookListeners()
  if (running) {
    try {
      uIOhook.stop()
    } catch {
      /* ignore */
    }
  }
  running = false
  clearAutoTriggerCallbacks()
  downAt = null
  modifiersHeld = false
  resetPrimaryClickState()
}

/**
 * 清理当前全局鼠标手势的按下状态。
 * 失焦时只清理起始于该窗口内部的旧手势，避免晚到的 blur 清除已经发生的外部 mousedown。
 * 双击序列同一同清空：焦点切换可能漏发 mouseup，残留的左键松开样本会与切换后的
 * 一次左键松开拼接成假双击。
 * @param blurredWindowBounds 刚刚失焦的自有窗口边界；省略时无条件清理。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetAutoTriggerPointerState(blurredWindowBounds?: ScreenBounds): void {
  resetPrimaryClickState()
  if (!blurredWindowBounds) {
    downAt = null
    modifiersHeld = false
    return
  }

  const previousStart = downAt
  const next = resetPointerTrackingForWindowBlur(
    { downAt, modifiersHeld },
    blurredWindowBounds
  )
  downAt = next.downAt
  modifiersHeld = next.modifiersHeld
  if (!previousStart) return
  console.log(
    next.downAt
      ? '[autoTrigger] 设置窗口失焦发生在外部 mousedown 之后，保留当前划词起点'
      : '[autoTrigger] 设置窗口失焦，清理窗口内遗留的鼠标按下状态'
  )
}

/**
 * 返回全局划词监听是否正在运行。
 * @returns 监听运行状态。
 * @author zhenghq
 */
export function isAutoTriggerRunning(): boolean {
  return running
}
