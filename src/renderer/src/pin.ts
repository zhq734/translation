import type { ScreenshotPinInitPayload } from '../../shared/types'
import { startLocaleRuntime } from './locale'
import { applyWin7CompatibilityAttribute } from './runtimeCompatibility'
import { startThemeRuntime } from './theme'

applyWin7CompatibilityAttribute()
startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)

const root = document.getElementById('pin-root') as HTMLElement
const image = document.getElementById('pin-image') as HTMLImageElement
let currentPinId: number | null = null
let dragPointerId: number | null = null
let pointerOffsetX = 0
let pointerOffsetY = 0

/**
 * 使用当前界面语言翻译词条。
 * @param key 语义化词条 key。
 * @returns 当前语言下的文本。
 * @author zhenghq
 */
function t(key: string): string {
  return localeRuntime.translator.t(key)
}

/**
 * 同步贴图窗口的无障碍名称。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyAccessibleTitle(): void {
  const title = t('screenshot.pin.windowTitle')
  image.alt = title
  root.setAttribute('aria-label', title)
}

/**
 * 应用主进程下发的贴图初始化状态。
 * @param payload 贴图初始化负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyInit(payload: ScreenshotPinInitPayload): void {
  currentPinId = payload.pinId
  if (image.src !== payload.dataUrl) image.src = payload.dataUrl
  root.dataset.bordered = String(payload.bordered)
  root.dataset.scale = String(payload.scale)
  root.style.opacity = String(payload.opacity)
  applyAccessibleTitle()
}

/**
 * 发送拖动请求；主进程负责屏幕边界约束。
 * @param event 指针移动事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function drag(event: PointerEvent): void {
  if (currentPinId === null || event.pointerId !== dragPointerId) return
  window.api.dragScreenshotPin({
    pinId: currentPinId,
    screenX: event.screenX,
    screenY: event.screenY,
    pointerOffsetX,
    pointerOffsetY
  })
}

/**
 * 关闭当前贴图。
 * @returns 无返回值。
 * @author zhenghq
 */
function closePin(): void {
  if (currentPinId === null) return
  window.api.closeScreenshotPin(currentPinId)
}

root.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || currentPinId === null) return
  dragPointerId = event.pointerId
  pointerOffsetX = event.clientX
  pointerOffsetY = event.clientY
  root.setPointerCapture(event.pointerId)
  event.preventDefault()
})
root.addEventListener('pointermove', drag)
root.addEventListener('pointerup', (event) => {
  if (event.pointerId !== dragPointerId) return
  if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId)
  dragPointerId = null
})
root.addEventListener('pointercancel', () => {
  dragPointerId = null
})
root.addEventListener('dblclick', closePin)
root.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (currentPinId !== null) window.api.showScreenshotPinContextMenu({ pinId: currentPinId })
})
root.addEventListener('wheel', (event) => {
  event.preventDefault()
  if (currentPinId === null) return
  window.api.wheelScreenshotPin({
    pinId: currentPinId,
    deltaY: event.deltaY,
    modifier: event.ctrlKey || event.metaKey
  })
}, { passive: false })
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePin()
  }
})
window.addEventListener('beforeunload', () => {
  dragPointerId = null
})
window.api.onScreenshotPinInit(applyInit)
localeRuntime.onLocaleChanged(applyAccessibleTitle)
