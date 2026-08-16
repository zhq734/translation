/** 鼠标位置与事件时间。 */
export interface PointerSample {
  x: number
  y: number
  time: number
}

/**
 * 使用 JavaScript 观测时间创建鼠标样本，避免不同系统原生事件时间单位不一致。
 * @param point 原生鼠标事件坐标及其原始时间。
 * @param observedAt JavaScript 收到事件时的毫秒时间戳。
 * @returns 使用统一毫秒时间的鼠标样本。
 * @author zhenghq
 */
export function createObservedPointerSample(
  point: { x: number; y: number; time?: number },
  observedAt: number
): PointerSample {
  return { x: point.x, y: point.y, time: observedAt }
}

/** 一次划词拖拽的几何信息。 */
export interface SelectionGesture {
  start: PointerSample
  end: PointerSample
  distance: number
  durationMs: number
  /** 用于放置“译”按钮的选区右上角近似坐标。 */
  anchor: { x: number; y: number }
}

import type { TriggerMode } from './types'

/** 全局键盘事件中用于判断选区快捷键的字段。 */
export interface SelectionShortcutSample {
  keycode: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * 判断当前键盘事件是否为未叠加其他修饰键的 Ctrl+A 或 Command+A。
 * @param event 全局键盘事件的修饰键和键码信息。
 * @param selectAllKeycode 当前平台 A 键对应的 uiohook 键码。
 * @returns 是否应触发全选后的选区处理。
 * @author zhenghq
 */
export function isSelectAllShortcut(
  event: SelectionShortcutSample,
  selectAllKeycode: number
): boolean {
  return event.keycode === selectAllKeycode &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
}

/** 划词完成后主进程需要执行的动作。 */
export type SelectionAction = 'show-button' | 'translate' | 'ignore'

/**
 * 根据拖拽起点和终点生成划词几何信息。
 * @param start 鼠标按下位置。
 * @param end 鼠标松开位置。
 * @returns 拖拽距离、持续时间及选区右上角锚点。
 * @author zhenghq
 */
export function getSelectionGesture(start: PointerSample, end: PointerSample): SelectionGesture {
  const dx = end.x - start.x
  const dy = end.y - start.y
  return {
    start,
    end,
    distance: Math.sqrt(dx * dx + dy * dy),
    durationMs: Math.max(0, end.time - start.time),
    anchor: {
      x: Math.max(start.x, end.x),
      y: Math.min(start.y, end.y)
    }
  }
}

/**
 * 划词手势判定阈值。
 * @author zhenghq
 */
export interface SelectionGestureTriggerOptions {
  minDragDistance: number
  minHoldMs: number
  maxHoldMs: number
}

/**
 * 判断鼠标动作是否应进入选区捕获，双击选词无需达到拖拽距离与按住时长。
 * @param gesture 当前鼠标动作的几何与时长信息。
 * @param clicks 当前鼠标事件的连续点击次数。
 * @param options 划词拖拽判定阈值。
 * @returns 是否应捕获当前选区。
 * @author zhenghq
 */
export function shouldTriggerSelectionGesture(
  gesture: SelectionGesture,
  clicks: number,
  options: SelectionGestureTriggerOptions
): boolean {
  if (clicks >= 2) return true
  if (gesture.distance < options.minDragDistance) return false
  return gesture.durationMs >= options.minHoldMs && gesture.durationMs <= options.maxHoldMs
}

/**
 * 根据触发方式决定本次划词是显示按钮、直接翻译还是等待快捷键。
 * 按钮模式不受翻译弹窗可见状态影响，每次划词都必须等待用户点击“译”按钮。
 * @param popupVisible 翻译弹窗是否仍然打开，保留此参数用于统一决策接口。
 * @param triggerMode 用户选择的触发方式。
 * @returns 当前划词动作。
 * @author zhenghq
 */
export function decideSelectionAction(
  popupVisible: boolean,
  triggerMode: TriggerMode
): SelectionAction {
  void popupVisible
  if (triggerMode === 'hotkey') return 'ignore'
  if (triggerMode === 'auto') return 'translate'
  return 'show-button'
}

/**
 * 判断文本是否更接近中文内容，用于自动选择中英文目标语言。
 * @param text 待判断的文本。
 * @returns 文本是否以中文为主。
 * @author zhenghq
 */
function isChineseText(text: string): boolean {
  const chineseCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length
  return chineseCount > 0 && chineseCount >= latinCount
}

/**
 * 根据用户偏好和文本内容解析本次翻译实际使用的语言对。
 * @param text 待翻译文本。
 * @param sourcePreference 源语言偏好，auto 表示自动检测。
 * @param targetPreference 目标语言偏好，auto 表示自动中英互译。
 * @returns 本次请求使用的源语言和目标语言。
 * @author zhenghq
 */
export function resolveLanguagePair(
  text: string,
  sourcePreference: string,
  targetPreference: string
): { sourceLang: string; targetLang: string } {
  const sourceLang = sourcePreference || 'auto'
  if (targetPreference && targetPreference.toLowerCase() !== 'auto') {
    return { sourceLang, targetLang: targetPreference.toUpperCase() }
  }

  const sourceIsChinese = sourceLang.toUpperCase() === 'ZH' ||
    (sourceLang.toLowerCase() === 'auto' && isChineseText(text))
  return {
    sourceLang,
    targetLang: sourceIsChinese ? 'EN' : 'ZH'
  }
}
