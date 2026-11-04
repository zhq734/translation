import type { RealtimeSubtitleViewModel } from '../../shared/subtitleSession'
import type { RealtimeSubtitleDragHitArea } from '../../shared/types'
import { localizedLanguages } from '../../shared/langs'
import { startLocaleRuntime } from './locale'
import { startThemeRuntime } from './theme'

startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)
const root = document.getElementById('subtitle-root') as HTMLElement
const subtitleCard = document.querySelector('.subtitle-card') as HTMLElement
const status = document.getElementById('subtitle-status') as HTMLElement
const source = document.getElementById('subtitle-source') as HTMLElement
const target = document.getElementById('subtitle-target') as HTMLElement
const error = document.getElementById('subtitle-error') as HTMLElement
const close = document.getElementById('subtitle-close') as HTMLButtonElement
const dragHandle = document.getElementById('subtitle-drag-handle') as HTMLButtonElement
const toolbar = document.getElementById('subtitle-toolbar') as HTMLElement
const targetLanguage = document.getElementById('subtitle-target-lang') as HTMLSelectElement
let current: RealtimeSubtitleViewModel | null = null
let clickThrough = true
let currentTargetLang = 'auto'
let mouseInteractionActive = false
let dragPointerId: number | null = null
let dragPointerOffset = { x: 0, y: 0 }
let toolbarHideTimer: ReturnType<typeof setTimeout> | null = null
let lastDragHitAreaKey = ''

/**
 * 设置字幕窗局部鼠标交互状态，避免重复发送 IPC。
 * @param active 是否启用交互。
 * @returns 无返回值。
 * @author zhenghq
 */
function setMouseInteraction(active: boolean): void {
  if (mouseInteractionActive === active) return
  mouseInteractionActive = active
  window.api.setRealtimeSubtitleMouseInteraction(active, 'toolbar')
}

/**
 * 判断全局坐标是否位于元素矩形内。
 * @param event 指针事件。
 * @param element 待命中元素。
 * @returns 位于元素内时返回 true。
 * @author zhenghq
 */
function isPointInside(event: PointerEvent, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
}

/**
 * 将拖拽按钮的真实窗口内矩形同步给主进程。
 * 仅在矩形变化时发送，避免布局观察器高频触发 IPC。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncDragHitArea(): void {
  const rect = dragHandle.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const area: RealtimeSubtitleDragHitArea = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  }
  const key = `${area.x}:${area.y}:${area.width}:${area.height}`
  if (key === lastDragHitAreaKey) return
  lastDragHitAreaKey = key
  window.api.setRealtimeSubtitleDragHitArea(area)
}

/**
 * 显示工具栏并接管字幕窗鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function showToolbar(): void {
  if (toolbarHideTimer) {
    clearTimeout(toolbarHideTimer)
    toolbarHideTimer = null
  }
  root.dataset.toolbarVisible = 'true'
  setMouseInteraction(true)
}

/**
 * 在指针离开工具栏且内部没有焦点时隐藏工具栏并恢复点击穿透。
 * @returns 无返回值。
 * @author zhenghq
 */
function releaseToolbarInteractionIfInactive(): void {
  if (toolbar.matches(':hover') || toolbar.contains(document.activeElement)) return
  root.dataset.toolbarVisible = 'false'
  setMouseInteraction(false)
}

/**
 * 延迟检查工具栏是否仍处于交互区域，避免下拉框展开时被误判隐藏。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleToolbarHide(): void {
  if (toolbarHideTimer) clearTimeout(toolbarHideTimer)
  toolbarHideTimer = setTimeout(() => {
    toolbarHideTimer = null
    releaseToolbarInteractionIfInactive()
  }, 120)
}

/**
 * 按当前界面语言重建目标语言下拉选项。
 * @returns 无返回值。
 * @author zhenghq
 */
function populateTargetLanguages(): void {
  targetLanguage.textContent = ''
  targetLanguage.add(new Option(localeRuntime.translator.t('settings.targetLang.auto'), 'auto'))
  for (const language of localizedLanguages(localeRuntime.locale)) {
    targetLanguage.add(new Option(language.label, language.code))
  }
  targetLanguage.value = currentTargetLang
  if (!targetLanguage.value) targetLanguage.value = 'auto'
}

/**
 * 从主进程设置同步目标语言。
 * @param settings 最新完整设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncTargetLanguage(settings: { targetLang: string }): void {
  currentTargetLang = settings.targetLang || 'auto'
  targetLanguage.value = currentTargetLang
  if (!targetLanguage.value) {
    currentTargetLang = 'auto'
    targetLanguage.value = 'auto'
  }
}

/**
 * 将视图模型渲染为双行字幕。
 * @param viewModel 主进程推送的视图模型。
 * @returns 无返回值。
 * @author zhenghq
 */
function render(viewModel: RealtimeSubtitleViewModel): void {
  current = viewModel
  root.dataset.empty = String(viewModel.empty)
  root.dataset.state = viewModel.state
  root.dataset.status = viewModel.status
  source.textContent = viewModel.sourceText
  target.textContent = viewModel.translatedText
  error.textContent = viewModel.error
  error.hidden = !viewModel.error
  status.textContent = viewModel.state === 'paused'
    ? localeRuntime.translator.t('settings.realtimeSubtitle.paused')
    : viewModel.state === 'starting'
      ? localeRuntime.translator.t('settings.realtimeSubtitle.starting')
      : viewModel.audioActivity === 'speech-pending'
        ? localeRuntime.translator.t('settings.realtimeSubtitle.waitingForSpeech')
        : ''
  root.dataset.clickThrough = String(clickThrough)
  syncDragHitArea()
  window.requestAnimationFrame(syncDragHitArea)
}

/**
 * 应用字号、颜色与点击穿透设置。
 * @param appearance 主进程下发的外观设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyAppearance(appearance: {
  displayMode: RealtimeSubtitleViewModel['displayMode']
  fontSize: number
  textColor: string
  clickThrough: boolean
}): void {
  clickThrough = appearance.clickThrough
  root.style.setProperty('--subtitle-font-size', `${appearance.fontSize}px`)
  root.style.setProperty('--subtitle-text-color', appearance.textColor)
  root.dataset.displayMode = appearance.displayMode
  root.dataset.clickThrough = String(clickThrough)
  if (current) render(current)
}

close.addEventListener('click', () => window.api.stopRealtimeSubtitle())
targetLanguage.addEventListener('change', () => {
  const previousTargetLang = currentTargetLang
  currentTargetLang = targetLanguage.value
  void window.api.setSettings({ targetLang: currentTargetLang }).catch(() => {
    currentTargetLang = previousTargetLang
    targetLanguage.value = previousTargetLang
  })
  targetLanguage.blur()
})
toolbar.addEventListener('pointerenter', showToolbar)
toolbar.addEventListener('pointerleave', scheduleToolbarHide)
toolbar.addEventListener('focusin', showToolbar)
toolbar.addEventListener('focusout', (event) => {
  if (!toolbar.contains(event.relatedTarget as Node | null)) scheduleToolbarHide()
})
dragHandle.addEventListener('pointerenter', showToolbar)
dragHandle.addEventListener('pointermove', showToolbar)
dragHandle.addEventListener('pointerleave', scheduleToolbarHide)
subtitleCard.addEventListener('pointerenter', (event) => {
  if (isPointInside(event, toolbar)) showToolbar()
})
subtitleCard.addEventListener('pointermove', (event) => {
  if (isPointInside(event, toolbar)) showToolbar()
  else if (root.dataset.toolbarVisible === 'true') scheduleToolbarHide()
})
document.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Node && toolbar.contains(event.target)) {
    showToolbar()
    return
  }
  scheduleToolbarHide()
})
dragHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  dragPointerId = event.pointerId
  dragPointerOffset = { x: event.clientX, y: event.clientY }
  dragHandle.setPointerCapture(event.pointerId)
  showToolbar()
  event.preventDefault()
})
dragHandle.addEventListener('pointermove', (event) => {
  if (event.pointerId !== dragPointerId) return
  window.api.moveRealtimeSubtitleWindow({
    screenX: event.screenX,
    screenY: event.screenY,
    pointerOffsetX: dragPointerOffset.x,
    pointerOffsetY: dragPointerOffset.y
  })
})
dragHandle.addEventListener('pointerup', (event) => {
  if (event.pointerId !== dragPointerId) return
  if (dragHandle.hasPointerCapture(event.pointerId)) dragHandle.releasePointerCapture(event.pointerId)
  dragPointerId = null
  dragHandle.blur()
  scheduleToolbarHide()
})
dragHandle.addEventListener('pointercancel', () => {
  dragPointerId = null
  dragHandle.blur()
  scheduleToolbarHide()
})
window.addEventListener('pointerup', scheduleToolbarHide)
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.api.stopRealtimeSubtitle()
})
window.api.onRealtimeSubtitleViewModel(render)
window.api.onRealtimeSubtitleAppearance(applyAppearance)
window.api.onRealtimeSubtitlePointerPoint((point) => {
  if (point.insideDragArea) {
    showToolbar()
    return
  }
  scheduleToolbarHide()
})
window.api.onSettingsChanged(syncTargetLanguage)
void window.api.getSettings().then(syncTargetLanguage).catch(() => undefined)
localeRuntime.onLocaleChanged(() => {
  populateTargetLanguages()
  if (current) render(current)
  syncDragHitArea()
})
populateTargetLanguages()
const dragHitAreaObserver = new ResizeObserver(syncDragHitArea)
dragHitAreaObserver.observe(dragHandle)
dragHitAreaObserver.observe(subtitleCard)
window.addEventListener('resize', syncDragHitArea)
window.requestAnimationFrame(syncDragHitArea)
