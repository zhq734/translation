import { LANGUAGES, langLabel } from '../../shared/langs'
import type {
  Settings,
  WebReaderState,
  WebTranslationMode,
  WebTranslationProgressPayload,
  WebTranslationRunPayload
} from '../../shared/types'
import { normalizeWebTranslationError } from '../../shared/webTranslationErrors'
import { startThemeRuntime } from './theme'

startThemeRuntime(window.api)

const addressForm = document.getElementById('web-address-form') as HTMLFormElement
const address = document.getElementById('web-address') as HTMLInputElement
const backButton = document.getElementById('web-back') as HTMLButtonElement
const forwardButton = document.getElementById('web-forward') as HTMLButtonElement
const reloadButton = document.getElementById('web-reload') as HTMLButtonElement
const sourceLang = document.getElementById('web-source-lang') as HTMLSelectElement
const targetLang = document.getElementById('web-target-lang') as HTMLSelectElement
const translateButton = document.getElementById('web-translate') as HTMLButtonElement
const cancelButton = document.getElementById('web-cancel') as HTMLButtonElement
const modeSelect = document.getElementById('web-mode') as HTMLSelectElement
const viewSlot = document.getElementById('web-view-slot') as HTMLElement
const status = document.getElementById('web-status') as HTMLElement
const loadingProgress = document.getElementById('web-loading-progress') as HTMLElement
const readerTitlebar = document.getElementById('web-reader-titlebar') as HTMLElement
const windowMinimizeButton = document.getElementById('window-minimize') as HTMLButtonElement
const windowMaximizeButton = document.getElementById('window-maximize') as HTMLButtonElement
const windowCloseButton = document.getElementById('window-close') as HTMLButtonElement

let currentState: WebReaderState | null = null
let translating = false
let extractedRevision = -1
let translationGeneration = 0

/**
 * 将原生 WebContentsView 位置同步到 Renderer 占位区域。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncViewBounds(): void {
  const rect = viewSlot.getBoundingClientRect()
  window.api.webViewSetBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

/**
 * 根据窗口最大化状态更新阅读器标题栏图标和无障碍状态。
 * @param maximized 当前窗口是否已最大化。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderWindowMaximizedState(maximized: boolean): void {
  const ariaLabel = maximized ? '还原' : '最大化'
  windowMaximizeButton.ariaLabel = ariaLabel
  windowMaximizeButton.title = ariaLabel
  windowMaximizeButton.dataset.maximized = String(maximized)
  document.documentElement.dataset.maximized = String(maximized)
  windowMaximizeButton.innerHTML = maximized
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5h7v7H5z" /><path d="M3 11V3h8" /></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" /></svg>'
}

/**
 * 初始化网页阅读器自绘标题栏窗口控制和双击切换行为。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializeWindowTitlebar(): Promise<void> {
  windowMinimizeButton.addEventListener('click', () => window.api.windowMinimize())
  windowMaximizeButton.addEventListener('click', () => window.api.windowToggleMaximize())
  windowCloseButton.addEventListener('click', () => window.api.windowClose())
  readerTitlebar.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('.window-controls')) return
    window.api.windowToggleMaximize()
  })
  window.api.onWindowMaximizedChanged(renderWindowMaximizedState)
  renderWindowMaximizedState(await window.api.windowIsMaximized())
}

/**
 * 设置顶部状态提示。
 * @param message 状态提示文本。
 * @param error 是否显示错误状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function setStatus(message: string, error = false): void {
  status.textContent = message
  status.dataset.state = error ? 'error' : 'normal'
}

/**
 * 填充源语言和目标语言选项。
 * @param settings 当前应用设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function populateLanguages(settings: Settings): void {
  sourceLang.replaceChildren()
  targetLang.replaceChildren()
  sourceLang.add(new Option('自动检测', 'auto'))
  for (const language of LANGUAGES) {
    sourceLang.add(new Option(language.label, language.code))
    targetLang.add(new Option(language.label, language.code))
  }
  sourceLang.value = settings.sourceLang || 'auto'
  const configuredTarget = settings.targetLang?.trim()
  targetLang.value = configuredTarget && configuredTarget.toLowerCase() !== 'auto' ? configuredTarget : 'ZH'
  if (!targetLang.value) targetLang.value = 'ZH'
}

/**
 * 根据阅读器状态刷新导航、地址和加载提示。
 * @param state 最新阅读器状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderReaderState(state: WebReaderState): void {
  if (currentState && currentState.url !== state.url) {
    translationGeneration += 1
    translating = false
    extractedRevision = -1
    translateButton.disabled = false
    cancelButton.disabled = true
  }
  currentState = state
  loadingProgress.hidden = !state.loading
  loadingProgress.setAttribute('aria-valuenow', state.loading ? '50' : '100')
  if (document.activeElement !== address) address.value = state.url
  backButton.disabled = !state.canGoBack
  forwardButton.disabled = !state.canGoForward
  reloadButton.disabled = state.loading
  // 翻译进度属于当前前台操作，普通网页加载事件不能覆盖其状态文案。
  if (translating) return
  if (state.pageUpdated) setStatus('页面有内容更新，已完成译文仍保留；可再次点击补译')
  else if (state.translationWindowActive) {
    setStatus(`正在边加载边翻译：已完成 ${state.translationDone ?? 0} / 已发现 ${state.translationDiscovered ?? 0}`)
  }
  else if (state.loading) setStatus('正在加载网页…')
  else if (state.error) setStatus(state.error, true)
}

/**
 * 汇总图片 OCR 维度的进度提示。
 * @param images 图片进度汇总。
 * @returns 追加到状态文案后的图片提示，没有图片时返回空串。
 * @author zhenghq
 */
function formatImageProgressHint(images?: WebTranslationProgressPayload['images']): string {
  if (!images || images.imageCandidates <= 0) return ''
  const processed = `图片 ${images.imageProcessed}/${images.imageCandidates}`
  const skipped = images.imageSkipped ? `，跳过 ${images.imageSkipped}` : ''
  const failed = images.imageFailed ? `，失败 ${images.imageFailed}` : ''
  return `，${processed}${skipped}${failed}`
}

/**
 * 判断图片维度是否存在失败或跳过，用于“部分翻译”语义提示。
 * @param images 图片进度汇总。
 * @returns 是否存在未完成或失败的图片。
 * @author zhenghq
 */
function hasImagePartialResult(images?: WebTranslationProgressPayload['images']): boolean {
  return Boolean(images && (images.imageFailed > 0 || images.imageSkipped > 0))
}

/**
 * 根据翻译进度刷新状态栏。
 * @param progress 最新翻译进度。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderProgress(progress: WebTranslationProgressPayload): void {
  if (progress.cancelled) {
    translating = false
    translateButton.disabled = false
    cancelButton.disabled = true
    setStatus('翻译已取消')
    return
  }
  const cacheHint = progress.cacheHits ? `，缓存命中 ${progress.cacheHits} 项` : ''
  const failureHint = progress.failed ? `，失败 ${progress.failed} 项` : ''
  const imageHint = formatImageProgressHint(progress.images)
  if (!progress.inputClosed) {
    setStatus(`正在边加载边翻译：已完成 ${progress.done} / 已发现 ${progress.discovered}${cacheHint}${failureHint}${imageHint}`)
    return
  }
  setStatus(`正在翻译：已完成 ${progress.done}/${progress.total}${cacheHint}${failureHint}${imageHint}`)
}

/**
 * 执行当前网页的提取、翻译和原位写回流程。
 * @param extractFresh 是否重新提取网页快照。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translatePage(extractFresh = true): Promise<void> {
  const generation = ++translationGeneration
  window.api.webTranslateCancel()
  translating = true
  translateButton.disabled = true
  cancelButton.disabled = false
  try {
    if (extractFresh || extractedRevision < 0) {
      setStatus('正在提取网页文本…')
      const extraction = await window.api.webTranslateExtract()
      if (generation !== translationGeneration) return
      extractedRevision = extraction.pageRevision
    }
    setStatus(`正在翻译为${langLabel(targetLang.value)}…`)
    const result = await window.api.webTranslateRun({
      sourceLang: sourceLang.value,
      targetLang: targetLang.value
    }) as WebTranslationRunPayload
    if (generation !== translationGeneration) return
    translating = false
    translateButton.disabled = false
    cancelButton.disabled = true
    const imageHint = formatImageProgressHint(result.images ?? result.progress.images)
    if (result.progress.cancelled) setStatus('翻译已取消')
    else if (result.apply.mismatched > 0) {
      setStatus(`翻译已继续完成，${result.apply.mismatched} 项因页面变化暂未写回；已完成译文仍保留，可再次点击补译${imageHint}`)
    }
    else if (result.partial) {
      const failedHint = result.progress.failed ? `，失败 ${result.progress.failed} 项` : ''
      setStatus(`仅翻译了部分网页内容${failedHint}${imageHint}；初始加载收集已结束，可再次点击补译`)
    }
    else if (hasImagePartialResult(result.images ?? result.progress.images)) {
      setStatus(`翻译完成，图片部分未处理${imageHint}`)
    }
    else if (!result.progress.inputClosed) setStatus(`翻译完成，初始加载收集仍在进行${imageHint}`)
    else setStatus(`翻译完成${imageHint}`)
  } catch (error) {
    if (generation !== translationGeneration) return
    translating = false
    translateButton.disabled = false
    cancelButton.disabled = true
    setStatus(normalizeWebTranslationError(error, '网页翻译失败'), true)
  }
}

/**
 * 切换远程网页原文或译文。
 * @returns 模式切换完成后的 Promise。
 * @author zhenghq
 */
async function changeMode(): Promise<void> {
  try {
    const mode = modeSelect.value as WebTranslationMode
    const result = await window.api.webTranslateSetMode(mode)
    if (mode === 'bilingual') {
      const unrendered = result.unrendered ?? 0
      const skipped = result.bilingualSkipped ?? 0
      const skippedHint = skipped > 0 ? `，另有 ${skipped} 个短文本/交互块按设计跳过对照` : ''
      // 只有翻译失败或锚点失配的块才提示补译，跳过块不作为失败报告。
      if (unrendered > 0) setStatus(`已切换对照显示，${unrendered} 个块未对照；可再次点击补译${skippedHint}`)
      else if (result.mismatched > 0) setStatus(`已切换对照显示，${result.mismatched} 项因页面变化未对照；可再次点击补译${skippedHint}`)
      else setStatus(`当前显示对照${skippedHint}`)
      return
    }
    if (result.mismatched > 0) setStatus('部分内容已变化，未受影响的译文仍保留；可再次点击补译')
    else setStatus(mode === 'source' ? '当前显示原文' : '当前显示译文')
  } catch (error) {
    setStatus(normalizeWebTranslationError(error, '切换网页显示失败'), true)
  }
}

/**
 * 切换语言时取消旧任务，恢复原文并用新语言重译。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleLanguageChange(): void {
  if (!currentState?.url) return
  void translatePage(false)
}

/**
 * 取消当前 Renderer 翻译代次并恢复可操作状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelTranslation(): void {
  translationGeneration += 1
  translating = false
  translateButton.disabled = false
  cancelButton.disabled = true
  window.api.webTranslateCancel()
  setStatus('翻译已取消')
}

addressForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = address.value.trim()
  if (!value) {
    setStatus('请输入网页地址', true)
    return
  }
  setStatus('正在加载网页…')
  void window.api.navigateWebReader(value).catch((error: unknown) => {
    setStatus(normalizeWebTranslationError(error, '网页地址无效'), true)
  })
})
backButton.addEventListener('click', () => window.api.webViewBack())
forwardButton.addEventListener('click', () => window.api.webViewForward())
reloadButton.addEventListener('click', () => window.api.webViewReload())
translateButton.addEventListener('click', () => void translatePage(true))
cancelButton.addEventListener('click', cancelTranslation)
modeSelect.addEventListener('change', () => void changeMode())
sourceLang.addEventListener('change', handleLanguageChange)
targetLang.addEventListener('change', handleLanguageChange)

const resizeObserver = new ResizeObserver(syncViewBounds)
resizeObserver.observe(viewSlot)
window.addEventListener('resize', syncViewBounds)
window.addEventListener('beforeunload', () => resizeObserver.disconnect())
void initializeWindowTitlebar()
window.api.onWebReaderState(renderReaderState)
window.api.onWebTranslateProgress(renderProgress)
window.api.onWebTranslatePageUpdated((updated) => {
  if (updated && !translating) setStatus('页面有内容更新，已完成译文仍保留；可再次点击补译')
})
void window.api.getSettings().then((settings) => {
  populateLanguages(settings)
  modeSelect.value = settings.webTranslationDefaultMode
  // 把设置页的默认显示同步给主进程，避免默认“对照”仍按原位译文渲染。
  void window.api.webTranslateSetMode(settings.webTranslationDefaultMode).catch(() => undefined)
})
requestAnimationFrame(syncViewBounds)
