import { LANGUAGES, langLabel } from '../../shared/langs'
import type {
  Settings,
  WebReaderState,
  WebTranslationMode,
  WebTranslationProgressPayload,
  WebTranslationRunPayload
} from '../../shared/types'
import { normalizeWebTranslationError } from '../../shared/webTranslationErrors'

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
  if (!progress.inputClosed) {
    setStatus(`正在边加载边翻译：已完成 ${progress.done} / 已发现 ${progress.discovered}${cacheHint}${failureHint}`)
    return
  }
  setStatus(`正在翻译：已完成 ${progress.done}/${progress.total}${cacheHint}${failureHint}`)
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
    if (result.progress.cancelled) setStatus('翻译已取消')
    else if (result.apply.mismatched > 0) {
      setStatus(`翻译已继续完成，${result.apply.mismatched} 项因页面变化暂未写回；已完成译文仍保留，可再次点击补译`)
    }
    else if (result.partial) setStatus(`仅翻译了部分网页内容${result.progress.failed ? `，失败 ${result.progress.failed} 项` : ''}；初始加载收集已结束，可再次点击补译`)
    else if (!result.progress.inputClosed) setStatus('翻译完成，初始加载收集仍在进行')
    else setStatus('翻译完成')
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
window.api.onWebReaderState(renderReaderState)
window.api.onWebTranslateProgress(renderProgress)
window.api.onWebTranslatePageUpdated((updated) => {
  if (updated && !translating) setStatus('页面有内容更新，已完成译文仍保留；可再次点击补译')
})
void window.api.getSettings().then((settings) => {
  populateLanguages(settings)
  modeSelect.value = settings.webTranslationDefaultMode === 'source' ? 'source' : 'target'
})
requestAnimationFrame(syncViewBounds)
