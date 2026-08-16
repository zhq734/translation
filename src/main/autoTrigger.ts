import { uIOhook, UiohookKey } from 'uiohook-napi'
import {
  createObservedPointerSample,
  getSelectionGesture,
  isSelectAllShortcut,
  shouldTriggerSelectionGesture,
  type SelectionGesture
} from '../shared/selectionBehavior'
import { copyShortcutGuard } from './copyShortcutState'

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
  clicks?: number
}

type KeyboardSample = {
  keycode: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

type SelectionCallback = (gesture: SelectionGesture) => void
type PointerDownCallback = (point: { x: number; y: number }) => void
type PasteShortcutCallback = () => void
type SelectAllShortcutCallback = () => void

let running = false
let callback: SelectionCallback | null = null
let pointerDownCallback: PointerDownCallback | null = null
let pasteShortcutCallback: PasteShortcutCallback | null = null
let selectAllShortcutCallback: SelectAllShortcutCallback | null = null

let downAt: MouseSample | null = null
let modifiersHeld = false
let selectAllShortcutHeld = false

/**
 * 通知主进程鼠标已按下，记录起点并过滤带修饰键的拖拽操作。
 * @param e 全局鼠标按下事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function onMouseDown(e: MouseSample & { ctrlKey: boolean; altKey: boolean; metaKey: boolean }): void {
  pointerDownCallback?.({ x: e.x, y: e.y })

  // 带修饰键的拖拽通常属于复制、窗口操作或快捷操作，不作为普通划词。
  if (e.ctrlKey || e.altKey || e.metaKey) {
    modifiersHeld = true
    downAt = null
    return
  }
  modifiersHeld = false
  downAt = createObservedPointerSample(e, Date.now())
}

/**
 * 判断鼠标拖拽是否达到划词阈值，并通知主进程新的选区锚点。
 * @param e 全局鼠标松开事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function onMouseUp(e: MouseSample): void {
  const start = downAt
  downAt = null
  if (modifiersHeld || !start || !callback) {
    modifiersHeld = false
    return
  }
  modifiersHeld = false

  const gesture = getSelectionGesture(start, createObservedPointerSample(e, Date.now()))
  if (!shouldTriggerSelectionGesture(gesture, e.clicks ?? 1, DEFAULTS)) return

  console.log(
    `[autoTrigger] 检测到选区 clicks=${e.clicks ?? 1} distance=${Math.round(gesture.distance)} duration=${gesture.durationMs}ms`
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
    copyShortcutGuard.observeCopyShortcut()
    return
  }
  if (e.keycode === UiohookKey.V) {
    pasteShortcutCallback?.()
    return
  }
  if (!isSelectAllShortcut(e, UiohookKey.A) || selectAllShortcutHeld) return
  selectAllShortcutHeld = true
  selectAllShortcutCallback?.()
}

/**
 * 在全选快捷键释放后重置按住状态，避免系统按键连发重复触发取词。
 * @param e 全局键盘松开事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function onKeyUp(e: KeyboardSample): void {
  if (e.keycode === UiohookKey.A) selectAllShortcutHeld = false
}

/**
 * 启动全局鼠标监听，用于发现跨应用的划词动作。
 * @param cb 发现有效划词后的回调。
 * @param onPointerDown 发现鼠标按下时的回调，用于立即使旧选区状态失效。
 * @param onPasteShortcut 发现用户粘贴快捷键时的回调，用于中止剪贴板取词。
 * @param onSelectAllShortcut 发现用户全选快捷键时的回调，用于触发当前选区翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
export function startAutoTrigger(
  cb: SelectionCallback,
  onPointerDown?: PointerDownCallback,
  onPasteShortcut?: PasteShortcutCallback,
  onSelectAllShortcut?: SelectAllShortcutCallback
): void {
  stopAutoTrigger()
  callback = cb
  pointerDownCallback = onPointerDown ?? null
  pasteShortcutCallback = onPasteShortcut ?? null
  selectAllShortcutCallback = onSelectAllShortcut ?? null
  uIOhook.on('mousedown', onMouseDown)
  uIOhook.on('mouseup', onMouseUp)
  uIOhook.on('keydown', onKeyDown)
  uIOhook.on('keyup', onKeyUp)
  try {
    uIOhook.start()
    running = true
    console.log('[autoTrigger] 划词监听已启动')
  } catch (e) {
    console.warn('[selection-translator] 划词监听启动失败:', (e as Error).message)
  }
}

/**
 * 停止全局鼠标监听并清理当前拖拽状态。
 * @returns 无返回值。
 * @author zhenghq
 */
export function stopAutoTrigger(): void {
  uIOhook.off('mousedown', onMouseDown)
  uIOhook.off('mouseup', onMouseUp)
  uIOhook.off('keydown', onKeyDown)
  uIOhook.off('keyup', onKeyUp)
  if (running) {
    try {
      uIOhook.stop()
    } catch {
      /* ignore */
    }
  }
  running = false
  callback = null
  pointerDownCallback = null
  pasteShortcutCallback = null
  selectAllShortcutCallback = null
  downAt = null
  modifiersHeld = false
  selectAllShortcutHeld = false
}

/**
 * 返回全局划词监听是否正在运行。
 * @returns 监听运行状态。
 * @author zhenghq
 */
export function isAutoTriggerRunning(): boolean {
  return running
}
