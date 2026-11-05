import type { RealtimeSubtitleViewModel } from '../../shared/subtitleSession'
import type { RealtimeSubtitleDragHitArea } from '../../shared/types'
import { localizedLanguages } from '../../shared/langs'
import { StabilizedTextController } from '../../shared/subtitleTextStabilizer'
import { startLocaleRuntime } from './locale'
import { startThemeRuntime } from './theme'

/** 原文停止增长后的稳定等待时间。 */
const SOURCE_SETTLE_MS = 180
/** 原文持续增长时的最长等待时间。 */
const SOURCE_MAX_WAIT_MS = 750
/** 译文停止增长后的稳定等待时间。 */
const TARGET_SETTLE_MS = 400
/** 译文持续增长时的最长等待时间。 */
const TARGET_MAX_WAIT_MS = 1500

startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)
const root = document.getElementById('subtitle-root') as HTMLElement
const subtitleCard = document.querySelector('.subtitle-card') as HTMLElement
const status = document.getElementById('subtitle-status') as HTMLElement
const history = document.getElementById('subtitle-history') as HTMLElement
const historySource = document.getElementById('subtitle-history-source') as HTMLElement
const historyTarget = document.getElementById('subtitle-history-target') as HTMLElement
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
let lastCardHitAreaKey = ''
let lastDragHitAreaKey = ''
let pendingViewModel: RealtimeSubtitleViewModel | null = null
let viewModelFrame: number | null = null
let dragHitAreaFrame: number | null = null
const sourceTextStabilizer = new StabilizedTextController({
  settleMs: SOURCE_SETTLE_MS,
  maxWaitMs: SOURCE_MAX_WAIT_MS,
  onCommit: (text) => updateText(source, text)
})
const targetTextStabilizer = new StabilizedTextController({
  settleMs: TARGET_SETTLE_MS,
  maxWaitMs: TARGET_MAX_WAIT_MS,
  onCommit: (text) => updateText(target, text)
})
const historySourceTextStabilizer = new StabilizedTextController({
  settleMs: SOURCE_SETTLE_MS,
  maxWaitMs: SOURCE_MAX_WAIT_MS,
  onCommit: (text) => updateText(historySource, text)
})
const historyTargetTextStabilizer = new StabilizedTextController({
  settleMs: TARGET_SETTLE_MS,
  maxWaitMs: TARGET_MAX_WAIT_MS,
  onCommit: (text) => updateText(historyTarget, text)
})

/**
 * 判断两个字幕视图模型是否需要触发 DOM 更新。
 * @param left 前一个视图模型。
 * @param right 后一个视图模型。
 * @returns 所有展示字段一致时返回 true。
 * @author zhenghq
 */
function isSameViewModel(
  left: RealtimeSubtitleViewModel | null,
  right: RealtimeSubtitleViewModel
): boolean {
  return Boolean(
    left &&
    left.state === right.state &&
    left.segmentId === right.segmentId &&
    left.displayMode === right.displayMode &&
    left.sourceText === right.sourceText &&
    left.translatedText === right.translatedText &&
    left.status === right.status &&
    left.audioActivity === right.audioActivity &&
    left.empty === right.empty &&
    left.error === right.error &&
    isSameSegment(left.committed, right.committed) &&
    isSameSegment(left.live, right.live)
  )
}

/**
 * 判断两条字幕轨是否需要触发 DOM 更新。
 * @param left 前一条字幕轨。
 * @param right 后一条字幕轨。
 * @returns 两条轨道完全一致时返回 true。
 * @author zhenghq
 */
function isSameSegment(
  left: RealtimeSubtitleViewModel['committed'] | undefined,
  right: RealtimeSubtitleViewModel['committed'] | undefined
): boolean {
  if (!left || !right) return (left ?? null) === (right ?? null)
  return left.segmentId === right.segmentId &&
    left.sourceText === right.sourceText &&
    left.translatedText === right.translatedText &&
    left.status === right.status
}

/**
 * 仅在文本内容变化时写入 DOM，避免高频更新替换相同文本节点。
 * @param element 目标元素。
 * @param value 最新文本。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}

/**
 * 为指定字幕轨道生成不会跨段落串写的稳定键。
 * @param viewModel 当前字幕视图模型。
 * @param lane 原文或译文轨道。
 * @returns 段落、显示模式与轨道组成的稳定键。
 * @author zhenghq
 */
function textStreamKey(
  viewModel: RealtimeSubtitleViewModel,
  segmentId: string | null,
  lane: 'source' | 'target'
): string {
  return `${segmentId ?? `session:${viewModel.state}`}:${viewModel.displayMode}:${lane}`
}

/**
 * 以动画帧为边界合并拖拽命中区测量，避免每次翻译增量都触发布局计算。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleDragHitAreaSync(): void {
  if (dragHitAreaFrame !== null) return
  dragHitAreaFrame = window.requestAnimationFrame(() => {
    dragHitAreaFrame = null
    syncCardHitArea()
    syncDragHitArea()
  })
}

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
 * 将字幕卡片的真实窗口内矩形同步给主进程。
 * 仅在矩形变化时发送，避免布局观察器高频触发 IPC。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncCardHitArea(): void {
  const rect = subtitleCard.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const area: RealtimeSubtitleDragHitArea = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  }
  const key = `${area.x}:${area.y}:${area.width}:${area.height}`
  if (key === lastCardHitAreaKey) return
  lastCardHitAreaKey = key
  window.api.setRealtimeSubtitleCardHitArea(area)
}

/**
 * 将工具栏的真实窗口内矩形同步给主进程。
 * 仅在矩形变化时发送，避免布局观察器高频触发 IPC。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncDragHitArea(): void {
  const rect = toolbar.getBoundingClientRect()
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
 * 合并同一动画帧内的视图更新，只渲染最新一帧字幕。
 * @param viewModel 主进程推送的最新视图模型。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleViewModelRender(viewModel: RealtimeSubtitleViewModel): void {
  pendingViewModel = viewModel
  if (viewModelFrame !== null) return
  viewModelFrame = window.requestAnimationFrame(() => {
    viewModelFrame = null
    const latest = pendingViewModel
    pendingViewModel = null
    if (latest) render(latest)
  })
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
 * 立即隐藏工具栏并恢复字幕窗点击穿透。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetToolbarInteraction(): void {
  if (toolbarHideTimer) {
    clearTimeout(toolbarHideTimer)
    toolbarHideTimer = null
  }
  root.dataset.toolbarVisible = 'false'
  setMouseInteraction(false)
}

/**
 * 在指针离开工具栏且内部没有焦点时隐藏工具栏并恢复点击穿透。
 * @returns 无返回值。
 * @author zhenghq
 */
function releaseToolbarInteractionIfInactive(): void {
  if (toolbar.matches(':hover') || toolbar.contains(document.activeElement)) return
  resetToolbarInteraction()
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
 * @param force 是否强制重渲染，用于界面语言切换等需要刷新文案的场景。
 * @returns 无返回值。
 * @author zhenghq
 */
function render(viewModel: RealtimeSubtitleViewModel, force = false): void {
  if (!force && isSameViewModel(current, viewModel)) return
  current = viewModel
  const committed = viewModel.committed ?? null
  const live = viewModel.live ?? null
  const mainSegmentId = live?.segmentId ?? viewModel.segmentId
  const mainSourceText = live?.sourceText ?? viewModel.sourceText
  const mainTranslatedText = live?.translatedText ?? viewModel.translatedText
  const mainStatus = live?.status ?? viewModel.status
  root.dataset.empty = String(viewModel.empty)
  root.dataset.state = viewModel.state
  root.dataset.status = mainStatus
  history.hidden = committed === null
  historySourceTextStabilizer.push(
    committed?.sourceText ?? '',
    textStreamKey(viewModel, committed?.segmentId ?? null, 'source'),
    !committed || committed.status !== 'partial' || committed.sourceText.length === 0
  )
  historyTargetTextStabilizer.push(
    committed?.translatedText ?? '',
    textStreamKey(viewModel, committed?.segmentId ?? null, 'target'),
    !committed || committed.status === 'translated' || committed.status === 'error' ||
      committed.translatedText.length === 0
  )
  const sourceImmediate = viewModel.state !== 'running' ||
    mainStatus !== 'partial' ||
    mainSourceText.length === 0
  sourceTextStabilizer.push(
    mainSourceText,
    textStreamKey(viewModel, mainSegmentId, 'source'),
    sourceImmediate
  )
  const targetImmediate = viewModel.state !== 'running' ||
    mainStatus === 'translated' ||
    mainStatus === 'error' ||
    mainStatus === 'empty' ||
    mainTranslatedText.length === 0
  targetTextStabilizer.push(
    mainTranslatedText,
    textStreamKey(viewModel, mainSegmentId, 'target'),
    targetImmediate
  )
  updateText(error, viewModel.error)
  error.hidden = !viewModel.error
  updateText(status, viewModel.state === 'paused'
    ? localeRuntime.translator.t('settings.realtimeSubtitle.paused')
    : viewModel.state === 'starting'
      ? localeRuntime.translator.t('settings.realtimeSubtitle.starting')
      : viewModel.audioActivity === 'speech-pending'
        ? localeRuntime.translator.t('settings.realtimeSubtitle.waitingForSpeech')
        : '')
  root.dataset.clickThrough = String(clickThrough)
  scheduleDragHitAreaSync()
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
  if (current) render(current, true)
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
window.addEventListener('blur', resetToolbarInteraction)
document.addEventListener('mouseleave', resetToolbarInteraction)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetToolbarInteraction()
})
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.api.stopRealtimeSubtitle()
})
window.api.onRealtimeSubtitleViewModel(scheduleViewModelRender)
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
  if (current) render(current, true)
  else scheduleDragHitAreaSync()
})
populateTargetLanguages()
const dragHitAreaObserver = new ResizeObserver(scheduleDragHitAreaSync)
dragHitAreaObserver.observe(toolbar)
dragHitAreaObserver.observe(subtitleCard)
window.addEventListener('resize', scheduleDragHitAreaSync)
window.addEventListener('beforeunload', () => {
  sourceTextStabilizer.dispose()
  targetTextStabilizer.dispose()
})
scheduleDragHitAreaSync()
