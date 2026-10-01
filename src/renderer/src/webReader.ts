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
import { startLocaleRuntime } from './locale'

startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)

/**
 * 使用当前界面语言翻译词条。
 * @param key 语义化词条 key。
 * @param params 可选插值参数。
 * @returns 当前语言下的词条文本。
 * @author zhenghq
 */
function t(key: string, params?: Record<string, string | number>): string {
  return localeRuntime.translator.t(key, params)
}

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
/** 当前状态文案的重算工厂，供界面语言切换后立即刷新。 */
let statusFactory: (() => string) | null = null
/** 最近一次读取到的完整设置，供界面语言切换后重建语言下拉。 */
let currentSettings: Settings | null = null

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
  const ariaLabel = maximized ? t('webReader.restore') : t('webReader.maximize')
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
  statusFactory = null
  status.textContent = message
  status.dataset.state = error ? 'error' : 'normal'
}

/**
 * 使用可按当前语言重算的工厂设置状态提示。
 * @param factory 返回当前语言状态文案的函数。
 * @param error 是否显示错误状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function setLocalizedStatus(factory: () => string, error = false): void {
  statusFactory = factory
  status.textContent = factory()
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
  sourceLang.add(new Option(t('popup.autoDetect'), 'auto'))
  for (const language of LANGUAGES) {
    const label = langLabel(language.code, localeRuntime.locale)
    sourceLang.add(new Option(label, language.code))
    targetLang.add(new Option(label, language.code))
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
  if (state.pageUpdated) setLocalizedStatus(() => t('webReader.pageUpdated'))
  else if (state.translationWindowActive) {
    setLocalizedStatus(() => t('webReader.loadingAndTranslating', {
      done: state.translationDone ?? 0,
      discovered: state.translationDiscovered ?? 0
    }))
  }
  else if (state.loading) setLocalizedStatus(() => t('webReader.loadingPage'))
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
  const processed = t('webReader.imageProgress', {
    processed: images.imageProcessed,
    candidates: images.imageCandidates
  })
  const skipped = images.imageSkipped ? t('webReader.imageSkipped', { count: images.imageSkipped }) : ''
  const failed = images.imageFailed ? t('webReader.imageFailed', { count: images.imageFailed }) : ''
  return `${t('webReader.imageHintPrefix')}${processed}${skipped}${failed}`
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
    setLocalizedStatus(() => t('webReader.cancelled'))
    return
  }
  const cacheHint = progress.cacheHits ? t('webReader.cacheHits', { count: progress.cacheHits }) : ''
  const failureHint = progress.failed ? t('webReader.failureCount', { count: progress.failed }) : ''
  const imageHint = formatImageProgressHint(progress.images)
  if (!progress.inputClosed) {
    setLocalizedStatus(() => t('webReader.loadingAndTranslating', {
      done: progress.done,
      discovered: progress.discovered
    }) + cacheHint + failureHint + imageHint)
    return
  }
  setLocalizedStatus(() => t('webReader.translatingProgress', {
    done: progress.done,
    total: progress.total
  }) + cacheHint + failureHint + imageHint)
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
      setLocalizedStatus(() => t('webReader.extracting'))
      const extraction = await window.api.webTranslateExtract()
      if (generation !== translationGeneration) return
      extractedRevision = extraction.pageRevision
    }
    setLocalizedStatus(() => t('popup.translatingInto', {
      language: langLabel(targetLang.value, localeRuntime.locale)
    }))
    const result = await window.api.webTranslateRun({
      sourceLang: sourceLang.value,
      targetLang: targetLang.value
    }) as WebTranslationRunPayload
    if (generation !== translationGeneration) return
    translating = false
    translateButton.disabled = false
    cancelButton.disabled = true
    const imageHint = formatImageProgressHint(result.images ?? result.progress.images)
    if (result.progress.cancelled) setLocalizedStatus(() => t('webReader.cancelled'))
    else if (result.apply.mismatched > 0) {
      setLocalizedStatus(() => t('webReader.continuedWithMismatch', {
        count: result.apply.mismatched
      }) + imageHint)
    }
    else if (result.partial) {
      const failedHint = result.progress.failed
        ? t('webReader.failureCount', { count: result.progress.failed })
        : ''
      setLocalizedStatus(() => t('webReader.partialResult', { failed: failedHint, images: imageHint }))
    }
    else if (hasImagePartialResult(result.images ?? result.progress.images)) {
      setLocalizedStatus(() => t('webReader.completedImagesPartial', { images: imageHint }))
    }
    else if (!result.progress.inputClosed) {
      setLocalizedStatus(() => t('webReader.completedInputOpen', { images: imageHint }))
    }
    else setLocalizedStatus(() => t('webReader.completed', { images: imageHint }))
  } catch (error) {
    if (generation !== translationGeneration) return
    translating = false
    translateButton.disabled = false
    cancelButton.disabled = true
    setStatus(normalizeWebTranslationError(error, t('webReader.translationFailed')), true)
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
      const skippedHint = skipped > 0
        ? t('webReader.switchSkippedHint', { count: skipped })
        : ''
      // 只有翻译失败或锚点失配的块才提示补译，跳过块不作为失败报告。
      if (unrendered > 0) {
        setLocalizedStatus(() => t('webReader.switchedUnrendered', {
          count: unrendered
        }) + skippedHint)
      } else if (result.mismatched > 0) {
        setLocalizedStatus(() => t('webReader.switchedMismatched', {
          count: result.mismatched
        }) + skippedHint)
      } else {
        setLocalizedStatus(() => t('webReader.currentBilingual') + skippedHint)
      }
      return
    }
    if (result.mismatched > 0) setLocalizedStatus(() => t('webReader.partialContentChanged'))
    else setLocalizedStatus(() => mode === 'source' ? t('webReader.showingSource') : t('webReader.showingTarget'))
  } catch (error) {
    setStatus(normalizeWebTranslationError(error, t('webReader.switchModeFailed')), true)
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
  setLocalizedStatus(() => t('webReader.cancelled'))
}

addressForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = address.value.trim()
  if (!value) {
    setStatus(t('webReader.enterAddress'), true)
    return
  }
  setLocalizedStatus(() => t('webReader.loadingPage'))
  void window.api.navigateWebReader(value).catch((error: unknown) => {
    setStatus(normalizeWebTranslationError(error, t('webReader.invalidAddress')), true)
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
  if (updated && !translating) setLocalizedStatus(() => t('webReader.pageUpdated'))
})
void window.api.getSettings().then((settings) => {
  currentSettings = settings
  populateLanguages(settings)
  modeSelect.value = settings.webTranslationDefaultMode
  // 把设置页的默认显示同步给主进程，避免默认“对照”仍按原位译文渲染。
  void window.api.webTranslateSetMode(settings.webTranslationDefaultMode).catch(() => undefined)
})
localeRuntime.onLocaleChanged(() => {
  if (!currentSettings) return
  const sourceValue = sourceLang.value
  const targetValue = targetLang.value
  populateLanguages(currentSettings)
  sourceLang.value = sourceValue || 'auto'
  targetLang.value = targetValue || 'ZH'
  if (statusFactory) status.textContent = statusFactory()
  void window.api.windowIsMaximized().then(renderWindowMaximizedState)
})
requestAnimationFrame(syncViewBounds)
