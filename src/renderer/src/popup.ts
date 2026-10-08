import { LANGUAGES, langLabel } from '../../shared/langs'
import {
  isTranslationProviderAvailable,
  TRANSLATION_PROVIDERS,
  translationProviderLabel
} from '../../shared/translationProviders'
import {
  beginManualTranslation,
  canSubmitManualTranslation,
  clearManualTranslation,
  createManualTranslationState,
  failManualTranslation,
  updateManualDraft,
  validateManualTranslationText,
  type ManualTranslationState
} from '../../shared/manualTranslationBehavior'
import type { Settings, TranslatePayload } from '../../shared/types'
import { MANUAL_TRANSLATION_MAX_CHARS } from '../../shared/types'
import { POPUP_AUTO_SIZE_LIMITS } from '../../shared/popupAutoSize'
import {
  createSpeechController,
  type SpeechController,
  type SpeechSynthesisLike,
  type SpeechUtteranceLike
} from './speech'
import {
  createEdgePlaybackController,
  type EdgeAudioLike,
  type EdgePlaybackController
} from './edgeSpeechPlayback'
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

const sourceLangEl = document.getElementById('source-lang') as HTMLSelectElement
const targetLangEl = document.getElementById('target-lang') as HTMLSelectElement
const selectionViewEl = document.getElementById('selection-view') as HTMLElement
const manualViewEl = document.getElementById('manual-view') as HTMLElement
const resultEl = document.getElementById('result') as HTMLElement
const originalEl = document.getElementById('original') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement
const translationProviderEl = document.getElementById('translation-provider') as HTMLSelectElement
const copyBtn = document.getElementById('copy') as HTMLButtonElement
const manualCopyBtn = document.getElementById('manual-copy') as HTMLButtonElement
const manualModeBtn = document.getElementById('manual-mode') as HTMLButtonElement
const speakBtn = document.getElementById('speak') as HTMLButtonElement
const speakPlayIcon = speakBtn.querySelector('.speak-play-icon') as SVGElement
const speakStopIcon = speakBtn.querySelector('.speak-stop-icon') as SVGElement
const speakLabelEl = document.getElementById('speak-label') as HTMLElement
const manualSourceEl = document.getElementById('manual-source') as HTMLTextAreaElement
const manualClearBtn = document.getElementById('manual-clear') as HTMLButtonElement
const manualCountEl = document.getElementById('manual-count') as HTMLElement
const manualSubmitBtn = document.getElementById('manual-submit') as HTMLButtonElement
const manualResultEl = document.getElementById('manual-result') as HTMLElement
const manualStaleEl = document.getElementById('manual-stale') as HTMLElement
const ocrSourceEl = document.getElementById('ocr-source') as HTMLElement
const ocrSourceLabelEl = document.getElementById('ocr-source-label') as HTMLElement
const ocrSourceTextEl = document.getElementById('ocr-source-text') as HTMLElement
const ocrEngineBadgeEl = document.getElementById('ocr-engine-badge') as HTMLElement
const ocrCopyBtn = document.getElementById('ocr-copy') as HTMLButtonElement
const pinBtn = document.getElementById('pin') as HTMLButtonElement
const pinLabelEl = document.getElementById('pin-label') as HTMLElement
const webReaderBtn = document.getElementById('open-web-reader') as HTMLButtonElement
const settingsBtn = document.getElementById('open-settings') as HTMLButtonElement
const closeBtn = document.getElementById('close') as HTMLButtonElement

let lastTranslation = ''
let lastOriginal = ''
let lastOcrText = ''
let selectionStatus = ''
let selectionSourceLangCode: string | null = null
let selectionTargetLangCode = ''
let selectionProvider: TranslatePayload['provider'] | undefined
let currentSelectionOrigin: TranslatePayload['origin'] = 'selection'
let manualStatus = ''
let manualSourceLangCode: string | null = null
let manualTargetLangCode = ''
let manualProvider: TranslatePayload['provider'] | undefined
let statusTimer: ReturnType<typeof setTimeout> | null = null
let pinned = false
let currentSettings: Settings | null = null
let mode: 'selection' | 'manual' = 'selection'
let manualState: ManualTranslationState = createManualTranslationState()
let selectionSpeechLanguage = ''
let manualSpeechLanguage = ''
let speechOperationId = 0
let autoResizeTimer: ReturnType<typeof setTimeout> | null = null
let lastRequestedAutoSize = { width: 0, height: 0 }

const speechSynthesisApi: SpeechSynthesisLike | null = 'speechSynthesis' in window
  ? window.speechSynthesis as unknown as SpeechSynthesisLike
  : null
const systemSpeechController: SpeechController = createSpeechController({
  synthesis: speechSynthesisApi,
  getMessage: (key: string) => t(key),
  createUtterance(text: string): SpeechUtteranceLike {
    return new SpeechSynthesisUtterance(text) as unknown as SpeechUtteranceLike
  },
  onSpeakingChange: () => syncSpeechButton(),
  onComplete: () => flashStatus(t('popup.speechCompleted')),
  onError: (message: string) => flashStatus(message)
})
const edgeSpeechController: EdgePlaybackController = createEdgePlaybackController({
  getMessage: (key: string) => t(key),
  synthesize: (text, language, signal) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    let aborted = signal?.aborted === true

    /**
     * 将 Renderer 内的取消信号转换为可跨 contextBridge 传递的请求标识。
     * @returns 无返回值。
     * @author zhenghq
     */
    const abort = (): void => {
      aborted = true
      window.api.cancelEdgeSpeech(requestId)
    }

    signal?.addEventListener('abort', abort, { once: true })
    if (aborted) return Promise.resolve({ ok: false, error: t('popup.edgeSpeechCancelled') })
    return window.api
      .synthesizeEdgeSpeech(text, language, requestId)
      .then((result) => aborted
        ? { ok: false, error: t('popup.edgeSpeechCancelled') }
        : result)
      .finally(() => signal?.removeEventListener('abort', abort))
  },
  createAudio(url: string): EdgeAudioLike {
    const audio = document.createElement('audio')
    audio.preload = 'auto'
    audio.volume = 1
    audio.muted = false
    audio.src = url
    document.body.append(audio)
    return audio as unknown as EdgeAudioLike
  },
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  createAudioContext: () => {
    try {
      return typeof AudioContext === 'function' ? new AudioContext() : null
    } catch {
      return null
    }
  },
  onSynthesisStart: () => flashStatus(t('popup.edgeSpeechRequesting'), 20_000),
  onAudioReady: (byteLength) => flashStatus(t('popup.edgeAudioReceived', { bytes: byteLength }), 5000),
  onPlaybackStart: () => flashStatus(t('popup.edgeSpeechPlaying'), 5000),
  onSpeakingChange: () => syncSpeechButton(),
  onComplete: () => flashStatus(t('popup.speechCompleted'))
})

/**
 * 判断系统或 Edge 语音控制器是否存在有效会话。
 * @returns 正在合成或播放时返回 true。
 * @author zhenghq
 */
function isSpeechPlaying(): boolean {
  return systemSpeechController.isSpeaking() || edgeSpeechController.isSpeaking()
}

/**
 * 初始化语言选择器、翻译 API 选择器和当前设置。
 * @returns 初始化完成后的 Promise。
 * @author zhenghq
 */
async function initializeSelectors(): Promise<void> {
  const sourceOptions = [{ code: 'auto', label: t('popup.autoDetect') }, ...LANGUAGES]
  const targetOptions = [{ code: 'auto', label: t('popup.autoBilingual') }, ...LANGUAGES]
  for (const language of sourceOptions) sourceLangEl.add(new Option(language.label, language.code))
  for (const language of targetOptions) targetLangEl.add(new Option(language.label, language.code))
  const settings = await window.api.getSettings()
  currentSettings = settings
  sourceLangEl.value = settings.sourceLang
  targetLangEl.value = settings.targetLang
  renderTranslationProviderOptions(settings)
  renderMode()
}

/**
 * 根据设置渲染翻译 API 选项并回显首选项。
 * @param settings 当前完整设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTranslationProviderOptions(settings: Settings): void {
  translationProviderEl.replaceChildren()
  translationProviderEl.add(new Option(t('popup.autoSelect'), 'auto'))
  for (const provider of TRANSLATION_PROVIDERS) {
    const available = isTranslationProviderAvailable(provider.id, settings)
    const providerLabel = translationProviderLabel(provider.id, localeRuntime.locale)
    const option = new Option(
      available ? providerLabel : t('popup.providerDisabledLabel', { provider: providerLabel }),
      provider.id
    )
    option.disabled = !available
    translationProviderEl.add(option)
  }
  translationProviderEl.value = settings.preferredTranslationProvider
  if (!translationProviderEl.value) translationProviderEl.value = 'auto'
  renderTranslationProviderResult()
}

/**
 * 显示首选翻译 API 与实际命中的翻译通道。
 * @param actualProvider 本次实际完成翻译的 API。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTranslationProviderResult(actualProvider?: TranslatePayload['provider']): void {
  const preferredProvider = currentSettings?.preferredTranslationProvider ?? 'auto'
  const selectedOption = translationProviderEl.selectedOptions[0]
  if (!selectedOption) return
  const preferredLabel = translationProviderLabel(preferredProvider, localeRuntime.locale)
  if (!actualProvider) {
    selectedOption.textContent = preferredLabel
    translationProviderEl.title = t('popup.providerPreferred', { provider: preferredLabel })
    return
  }
  const actualLabel = translationProviderLabel(actualProvider, localeRuntime.locale)
  if (preferredProvider === 'auto') {
    selectedOption.textContent = t('popup.providerAutoActualShort', { provider: actualLabel })
    translationProviderEl.title = t('popup.providerAutoActual', { provider: actualLabel })
  } else if (preferredProvider !== actualProvider) {
    selectedOption.textContent = `${preferredLabel} → ${actualLabel}`
    translationProviderEl.title = t('popup.providerFallbackActual', {
      preferred: preferredLabel,
      actual: actualLabel
    })
  } else {
    selectedOption.textContent = preferredLabel
    translationProviderEl.title = t('popup.providerPreferredActual', { provider: preferredLabel })
  }
}

/**
 * 在弹窗底部短暂显示操作状态。
 * @param message 需要展示的状态文本。
 * @returns 无返回值。
 * @author zhenghq
 */
function flashStatus(message: string, durationMs = 1400): void {
  statusEl.textContent = message
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    statusEl.textContent = mode === 'manual' ? manualStatus : selectionStatus
    statusTimer = null
  }, durationMs)
}

/**
 * 获取当前模式下可以朗读的有效译文。
 * @returns 有效译文；当前没有可朗读内容时返回空字符串。
 * @author zhenghq
 */
function getCurrentTranslation(): string {
  if (mode === 'manual') {
    if (
      !manualState.translation
      || manualState.loading
      || Boolean(manualState.error)
      || manualState.stale
    ) return ''
    return manualState.translation
  }
  return lastTranslation
}

/**
 * 获取当前译文对应的实际目标语言。
 * @returns 用于语音匹配的项目语言代码或语音语言代码。
 * @author zhenghq
 */
function getCurrentSpeechLanguage(): string {
  return mode === 'manual'
    ? manualSpeechLanguage || targetLangEl.value
    : selectionSpeechLanguage || targetLangEl.value
}

/**
 * 同步朗读按钮的禁用、按下、图标和无障碍状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncSpeechButton(): void {
  const translation = getCurrentTranslation()
  const speaking = isSpeechPlaying()
  const disabled = !translation
  speakBtn.disabled = disabled
  speakBtn.setAttribute('aria-pressed', String(speaking))
  // 按钮文字保持简短稳定，禁用或需要系统语音等细节通过 title 与 aria-label 表达。
  speakLabelEl.textContent = speaking ? t('popup.speechStop') : t('popup.speechRead')
  const label = speaking
    ? t('popup.speechStop')
    : disabled
      ? t('popup.speechUnavailable')
      : currentSettings?.speechProvider === 'edge'
        ? t('popup.speechEdgeHint')
        : systemSpeechController.canSpeak(getCurrentSpeechLanguage())
        ? t('popup.speechRead')
        : t('popup.speechSystemUnavailable')
  speakBtn.title = label
  speakBtn.setAttribute('aria-label', label)
  speakPlayIcon.toggleAttribute('hidden', speaking)
  speakStopIcon.toggleAttribute('hidden', !speaking)
}

/**
 * 停止当前语音会话并立即刷新朗读按钮状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopSpeech(): void {
  speechOperationId += 1
  if (!isSpeechPlaying()) {
    syncSpeechButton()
    return
  }
  systemSpeechController.stop()
  edgeSpeechController.stop()
  syncSpeechButton()
}

/**
 * 处理朗读按钮点击，在开始和停止之间切换当前语音会话。
 * @returns 无返回值。
 * @author zhenghq
 */
async function toggleSpeech(): Promise<void> {
  if (isSpeechPlaying()) {
    stopSpeech()
    flashStatus(t('popup.speechStopped'))
    return
  }
  const translation = getCurrentTranslation()
  if (!translation) {
    syncSpeechButton()
    return
  }
  const language = getCurrentSpeechLanguage()
  const operationId = ++speechOperationId
  if (currentSettings?.speechProvider === 'edge') {
    const result = await edgeSpeechController.start(translation, language)
    if (operationId === speechOperationId && !result.ok && result.error !== t('popup.edgeSpeechCancelled')) {
      flashStatus(t('popup.edgeSpeechUnavailableWithError', {
        error: result.error ?? t('common.unknownError')
      }), 8000)
      systemSpeechController.start(translation, language)
    }
  } else {
    systemSpeechController.start(translation, language)
  }
  syncSpeechButton()
}

/**
 * 将语言偏好回显到选择器，避免实际语言覆盖 auto 选项。
 * @param payload 翻译状态或结果负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncLanguageSelectors(payload: TranslatePayload): void {
  if (payload.sourcePreference) sourceLangEl.value = payload.sourcePreference
  if (payload.targetPreference) targetLangEl.value = payload.targetPreference
}

/**
 * 渲染划词翻译结果，并在手动模式下只更新隐藏的划词会话内容。
 * @param payload 划词翻译状态或结果负载。
 * @returns 无返回值。
 * @author zhenghq
 */

/**
 * 返回 OCR 引擎的中文显示名称。
 * @param engine OCR 引擎标识。
 * @returns 中文名称。
 * @author zhenghq
 */
function ocrEngineLabel(engine: string | undefined): string {
  if (engine === 'system') return t('popup.ocrSystem')
  if (engine === 'paddle') return 'PaddleOCR'
  if (engine === 'tesseract') return 'Tesseract'
  return 'OCR'
}

/**
 * 返回 OCR 原始识别文本；没有原始文本时回退清洗后的 OCR 文本。
 * @param payload 翻译结果负载。
 * @returns OCR 原始文本。
 * @author zhenghq
 */
function getOcrRawText(payload: TranslatePayload): string {
  return payload.ocrRawText ?? payload.ocrText ?? ''
}

/**
 * 重置 OCR 内容区域的辅助状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetOcrSourceState(): void {
  ocrSourceLabelEl.hidden = false
  ocrSourceTextEl.removeAttribute('role')
  ocrSourceTextEl.removeAttribute('aria-labelledby')
}

/**
 * 渲染 OCR 内容区域：有 OCR 文本或错误时展示，无时隐藏。
 * @param payload 翻译结果负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrSource(payload: TranslatePayload): void {
  resetOcrSourceState()
  const hasOcr = Boolean(payload.ocrText || payload.ocrRawText || payload.ocrEngine || payload.ocrCode)
  if (!hasOcr) {
    ocrSourceEl.hidden = true
    ocrSourceTextEl.textContent = ''
    ocrEngineBadgeEl.hidden = true
    ocrEngineBadgeEl.textContent = ''
    ocrCopyBtn.hidden = true
    return
  }
  ocrSourceEl.hidden = false
  if (payload.ocrCode === 'empty') {
    ocrSourceTextEl.textContent = t('popup.ocrEmpty')
    ocrSourceTextEl.className = 'ocr-source-text ocr-empty'
    ocrCopyBtn.hidden = true
  } else if (payload.ocrCode === 'noise') {
    ocrSourceTextEl.textContent = t('popup.ocrNoise')
    ocrSourceTextEl.className = 'ocr-source-text ocr-noise'
    ocrCopyBtn.hidden = true
  } else if (payload.ocrCode === 'permission') {
    ocrSourceTextEl.textContent = t('popup.ocrPermission')
    ocrSourceTextEl.className = 'ocr-source-text ocr-error'
    ocrCopyBtn.hidden = true
  } else if (payload.ocrCode === 'no-clipboard-image') {
    ocrSourceTextEl.textContent = t('popup.ocrNoClipboardImage')
    ocrSourceTextEl.className = 'ocr-source-text ocr-error'
    ocrCopyBtn.hidden = true
  } else if (payload.ocrCode === 'timeout') {
    ocrSourceTextEl.textContent = t('popup.ocrTimeout')
    ocrSourceTextEl.className = 'ocr-source-text ocr-error'
    ocrCopyBtn.hidden = true
  } else if (payload.ocrCode === 'engine-unavailable') {
    ocrSourceTextEl.textContent = t('popup.ocrEngineUnavailable')
    ocrSourceTextEl.className = 'ocr-source-text ocr-error'
    ocrCopyBtn.hidden = true
  } else if (payload.ocrText || payload.ocrRawText) {
    const ocrText = getOcrRawText(payload)
    ocrSourceTextEl.textContent = ocrText
    ocrSourceTextEl.className = 'ocr-source-text'
    ocrCopyBtn.hidden = !ocrText
  } else {
    ocrSourceEl.hidden = true
    return
  }
  if (payload.ocrEngine) {
    ocrEngineBadgeEl.textContent = ocrEngineLabel(payload.ocrEngine)
    ocrEngineBadgeEl.hidden = false
  } else {
    ocrEngineBadgeEl.hidden = true
  }
}

/**
 * 渲染 OCR 识别中的状态，确保截图后立即展示可见反馈。
 * @param payload OCR loading 负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrLoading(payload: TranslatePayload): void {
  resetOcrSourceState()
  ocrSourceEl.hidden = false
  ocrSourceTextEl.textContent = payload.original ?? t('popup.ocrRecognizing')
  ocrSourceTextEl.className = 'ocr-source-text ocr-loading'
  ocrEngineBadgeEl.textContent = 'OCR'
  ocrEngineBadgeEl.hidden = false
  ocrCopyBtn.hidden = true
}

/**
 * 渲染划词或 OCR 翻译的读取中、成功及失败状态。
 * @param payload 主进程发送的翻译状态负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSelection(payload: TranslatePayload): void {
  const visible = mode === 'selection'
  if (visible) syncLanguageSelectors(payload)
  currentSelectionOrigin = payload.origin ?? 'selection'
  if (payload.origin !== 'ocr' && payload.original !== undefined) lastOriginal = payload.original
  if (payload.origin === 'ocr') {
    const ocrText = payload.ocrText ?? payload.ocrRawText
    if (ocrText) lastOcrText = ocrText
  }
  if (payload.loading) {
    stopSpeech()
    lastTranslation = ''
    selectionSpeechLanguage = ''
    selectionProvider = undefined
    selectionSourceLangCode = null
    selectionTargetLangCode = payload.targetLang ?? ''
    selectionStatus = payload.loadingMessage ?? (payload.targetLang
      ? t('popup.translatingInto', { language: langLabel(payload.targetLang, localeRuntime.locale) })
      : t('popup.translating'))
    if (visible) renderTranslationProviderResult()
    resultEl.textContent = payload.origin === 'ocr'
      ? (payload.original ?? t('popup.ocrRecognizing'))
      : (payload.loadingMessage ?? t('popup.translating'))
    resultEl.classList.add('loading')
    originalEl.textContent = payload.origin === 'ocr' ? '' : payload.original ?? ''
    copyBtn.hidden = true
    if (payload.origin === 'ocr') {
      renderOcrLoading(payload)
    } else {
      renderOcrSource({} as TranslatePayload)
    }
    if (visible) statusEl.textContent = selectionStatus
    syncSpeechButton()
    requestAutoResize()
    return
  }
  resultEl.classList.remove('loading')
  if (!payload.ok) {
    stopSpeech()
    lastTranslation = ''
    selectionSpeechLanguage = ''
    selectionProvider = undefined
    selectionSourceLangCode = null
    selectionTargetLangCode = payload.targetLang ?? ''
    selectionStatus = t('popup.translationFailed')
    if (visible) renderTranslationProviderResult()
    resultEl.textContent = payload.error ?? t('common.unknownError')
    originalEl.textContent = payload.origin === 'ocr' ? '' : payload.original ?? ''
    copyBtn.hidden = true
    if (payload.origin === 'ocr') {
      renderOcrSource(payload)
    } else {
      renderOcrSource({} as TranslatePayload)
    }
    if (visible) statusEl.textContent = selectionStatus
    syncSpeechButton()
    requestAutoResize()
    return
  }
  stopSpeech()
  const sourceName = payload.detectedLang
    ? langLabel(payload.detectedLang, localeRuntime.locale)
    : payload.sourceLang === 'auto'
      ? t('popup.autoDetect')
      : langLabel(payload.sourceLang ?? '', localeRuntime.locale)
  const targetName = langLabel(payload.targetLang ?? '', localeRuntime.locale)
  selectionSourceLangCode = payload.detectedLang ?? payload.sourceLang ?? 'auto'
  selectionTargetLangCode = payload.targetLang ?? ''
  selectionProvider = payload.provider
  selectionStatus = `${sourceName} → ${targetName}`
  if (visible) renderTranslationProviderResult(selectionProvider)
  lastTranslation = payload.translation ?? ''
  selectionSpeechLanguage = payload.targetLang ?? targetLangEl.value
  resultEl.textContent = lastTranslation
  originalEl.textContent = payload.origin === 'ocr' ? '' : payload.original ?? ''
  copyBtn.hidden = !visible || !lastTranslation
  if (visible) statusEl.textContent = selectionStatus
  if (payload.origin === 'ocr') {
    renderOcrSource(payload)
  } else {
    renderOcrSource({} as TranslatePayload)
  }
  syncSpeechButton()
  requestAutoResize()
}

/**
 * 渲染手动翻译会话状态，并同步按钮可用性和字符计数。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderManualState(): void {
  const manualTranslationValid = Boolean(
    manualState.translation
    && !manualState.loading
    && !manualState.error
    && !manualState.stale
  )
  if (mode === 'manual' && !manualTranslationValid) stopSpeech()
  if (manualSourceEl.value !== manualState.draft) manualSourceEl.value = manualState.draft
  manualCountEl.textContent = `${manualState.draft.length} / ${MANUAL_TRANSLATION_MAX_CHARS}`
  manualClearBtn.disabled = !manualState.draft && !manualState.translation && !manualState.error
  manualSubmitBtn.disabled = !canSubmitManualTranslation(manualState, localeRuntime.translator)
  manualSubmitBtn.textContent = manualState.loading ? t('popup.translating') : t('popup.translate')
  manualResultEl.className = 'manual-result'
  if (manualState.loading) {
    manualResultEl.classList.add('loading')
    manualResultEl.textContent = t('popup.translating')
  } else if (manualState.error) {
    manualResultEl.classList.add('error')
    manualResultEl.textContent = manualState.error
  } else if (manualState.translation) {
    manualResultEl.textContent = manualState.translation
  } else {
    manualResultEl.classList.add('empty')
    manualResultEl.textContent = t('popup.translationPlaceholder')
  }
  manualStaleEl.hidden = !manualState.stale
  manualCopyBtn.hidden = mode !== 'manual'
    || !manualState.translation
    || manualState.loading
    || Boolean(manualState.error)
    || manualState.stale
  manualCopyBtn.disabled = manualCopyBtn.hidden
  syncSpeechButton()
  requestAutoResize()
}

/**
 * 根据当前模式切换两套视图，并保持两种模式的会话状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderMode(): void {
  const manual = mode === 'manual'
  manualViewEl.hidden = !manual
  selectionViewEl.hidden = manual
  manualModeBtn.setAttribute('aria-pressed', String(manual))
  manualModeBtn.title = manual ? t('popup.switchToSelection') : t('popup.manualMode')
  manualModeBtn.setAttribute('aria-label', manualModeBtn.title)
  copyBtn.hidden = manual || !lastTranslation
  manualCopyBtn.hidden = !manual || !manualState.translation || manualState.loading || Boolean(manualState.error) || manualState.stale
  translationProviderEl.disabled = false
  statusEl.textContent = manual ? manualStatus : selectionStatus
  renderTranslationProviderResult(manual ? manualProvider : selectionProvider)
  renderManualState()
  syncSpeechButton()
  requestAutoResize()
}

/**
 * 拼接元素的计算字体，供离屏画布测量文本行宽。
 * @param style 元素的计算样式。
 * @returns 可直接赋给 Canvas 上下文的 font 字符串。
 * @author zhenghq
 */
function buildCanvasFont(style: CSSStyleDeclaration): string {
  const weight = style.fontWeight || '400'
  const size = style.fontSize || '14px'
  const family = style.fontFamily || 'sans-serif'
  return `${weight} ${size} ${family}`
}

/**
 * 测量一段文本在指定字体下的最大单行宽度。
 * @param text 待测量文本，可包含换行。
 * @param font Canvas 使用的字体描述。
 * @returns 最宽一行的像素宽度。
 * @author zhenghq
 */
function measureTextLineWidth(text: string, font: string): number {
  if (!text) return 0
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return 0
  context.font = font
  let widest = 0
  for (const line of text.split('\n')) {
    widest = Math.max(widest, context.measureText(line).width)
  }
  return widest
}

/**
 * 测量当前内容需要的弹窗自然尺寸。
 * 宽度取可见文本最宽单行加内边距，并限制在舒适阅读宽度内；
 * 高度则在临时套用目标宽度后放开高度约束读取，保证换行结果与最终窗口一致。
 * @returns 测量得到的宽高，单位逻辑像素。
 * @author zhenghq
 */
function measureAutoSize(): { width: number; height: number } {
  const popupEl = document.getElementById('popup') as HTMLElement
  const sourceTexts = mode === 'manual'
    ? [manualState.draft, manualState.translation ?? '']
    : [lastOriginal, lastTranslation, lastOcrText]
  const sourceFont = buildCanvasFont(getComputedStyle(originalEl))
  const resultFont = buildCanvasFont(getComputedStyle(resultEl))
  const widestText = sourceTexts.reduce((widest, text) => Math.max(
    widest,
    measureTextLineWidth(text, sourceFont),
    measureTextLineWidth(text, resultFont)
  ), 0)
  // 水平方向额外预留左右内边距、透明宿主边距与边框。
  const horizontalChrome = 60
  // 文本过长时不再继续撑宽窗口，避免出现难以阅读的超长行。
  const comfortMaxWidth = Math.min(POPUP_AUTO_SIZE_LIMITS.maxWidth, 640)
  const desiredWidth = Math.max(
    POPUP_AUTO_SIZE_LIMITS.minWidth,
    Math.min(comfortMaxWidth, Math.ceil(widestText + horizontalChrome))
  )

  const previousWidth = popupEl.style.width
  // 窗口比 #popup 多出透明宿主左右内边距，测量宽度需扣除后才能与最终换行一致。
  const bodyStyle = getComputedStyle(document.body)
  const hostHorizontalPadding =
    Number.parseFloat(bodyStyle.paddingLeft || '0') +
    Number.parseFloat(bodyStyle.paddingRight || '0')
  popupEl.style.width = `${Math.max(0, desiredWidth - hostHorizontalPadding)}px`
  popupEl.classList.add('auto-size-measuring')
  // scrollHeight 不含弹窗边框与透明宿主的上下内边距，需一并计入窗口高度。
  const verticalChrome =
    popupEl.offsetHeight - popupEl.clientHeight +
    Number.parseFloat(bodyStyle.paddingTop || '0') +
    Number.parseFloat(bodyStyle.paddingBottom || '0')
  const naturalHeight = popupEl.scrollHeight + verticalChrome
  popupEl.classList.remove('auto-size-measuring')
  popupEl.style.width = previousWidth
  return {
    width: desiredWidth,
    height: Math.max(naturalHeight, POPUP_AUTO_SIZE_LIMITS.minHeight)
  }
}

/**
 * 在内容或模式变化后去抖上报自适应尺寸，避免频繁触发布局。
 * @returns 无返回值。
 * @author zhenghq
 */
function requestAutoResize(): void {
  if (autoResizeTimer) clearTimeout(autoResizeTimer)
  autoResizeTimer = setTimeout(() => {
    autoResizeTimer = null
    const size = measureAutoSize()
    if (size.width === lastRequestedAutoSize.width && size.height === lastRequestedAutoSize.height) return
    lastRequestedAutoSize = size
    window.api.resizePopup(size)
  }, 60)
}

/**
 * 进入手动模式并请求主进程固定弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
function enterManualMode(): void {
  stopSpeech()
  mode = 'manual'
  renderMode()
  window.api.openManualTranslate()
}

/**
 * 切回划词翻译模式，不改变当前固定状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function leaveManualMode(): void {
  stopSpeech()
  mode = 'selection'
  renderMode()
}

/**
 * 响应主进程手动打开通知并把焦点放到原文输入框。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleManualOpen(): void {
  stopSpeech()
  mode = 'manual'
  renderMode()
  manualSourceEl.focus()
  manualSourceEl.setSelectionRange(manualSourceEl.value.length, manualSourceEl.value.length)
}

/**
 * 提交手动翻译请求，避免空文本和加载期间重复提交。
 * @returns 翻译请求完成后的 Promise。
 * @author zhenghq
 */
async function submitManualTranslation(): Promise<void> {
  const validationError = validateManualTranslationText(manualState.draft, localeRuntime.translator)
  if (validationError) {
    manualState = { ...manualState, error: validationError }
    renderManualState()
    return
  }
  if (!canSubmitManualTranslation(manualState, localeRuntime.translator)) return
  stopSpeech()
  manualSpeechLanguage = ''
  manualState = beginManualTranslation(manualState)
  renderManualState()
  try {
    await window.api.translateManual({
      text: manualState.submittedText,
      sourceLang: sourceLangEl.value,
      targetLang: targetLangEl.value
    })
  } catch {
    manualState = failManualTranslation(
      manualState,
      manualState.requestId,
      t('popup.translationRequestFailed')
    )
    renderManualState()
  }
}

/**
 * 保存语言变化；手动模式仅标记结果过期，划词模式继续自动重译。
 * @returns 语言设置保存或重译完成后的 Promise。
 * @author zhenghq
 */
async function retranslateWithCurrentLanguages(): Promise<void> {
  stopSpeech()
  if (mode === 'manual') {
    sourceLangEl.disabled = true
    targetLangEl.disabled = true
    try {
      currentSettings = await window.api.setSettings({
        sourceLang: sourceLangEl.value,
        targetLang: targetLangEl.value
      })
      if (manualState.translation) manualState = { ...manualState, stale: true }
      manualSpeechLanguage = ''
      renderManualState()
    } catch {
      flashStatus(t('popup.languageSaveFailed'))
    } finally {
      sourceLangEl.disabled = false
      targetLangEl.disabled = false
    }
    return
  }
  const currentText = currentSelectionOrigin === 'ocr' ? lastOcrText : lastOriginal
  if (!currentText) return
  sourceLangEl.disabled = true
  targetLangEl.disabled = true
  try {
    await window.api.retranslate(sourceLangEl.value, targetLangEl.value, currentSelectionOrigin)
  } catch {
    flashStatus(t('popup.retranslationFailed'))
  } finally {
    sourceLangEl.disabled = false
    targetLangEl.disabled = false
  }
}

/**
 * 保存翻译 API 变化；手动模式等待用户显式提交。
 * @returns 翻译 API 设置保存完成后的 Promise。
 * @author zhenghq
 */
async function changeTranslationProvider(): Promise<void> {
  stopSpeech()
  const previousProvider = currentSettings?.preferredTranslationProvider ?? 'auto'
  translationProviderEl.disabled = true
  try {
    currentSettings = await window.api.setSettings({
      preferredTranslationProvider: translationProviderEl.value as Settings['preferredTranslationProvider']
    })
    renderTranslationProviderOptions(currentSettings)
    if (mode === 'manual') {
      if (manualState.translation) manualState = { ...manualState, stale: true }
      manualSpeechLanguage = ''
      renderManualState()
    } else if (lastOriginal) {
      await retranslateWithCurrentLanguages()
    } else {
      flashStatus(t('popup.providerPreferredApplied', {
        provider: translationProviderLabel(
          currentSettings.preferredTranslationProvider,
          localeRuntime.locale
        )
      }))
    }
  } catch {
    translationProviderEl.value = previousProvider
    flashStatus(t('popup.providerSwitchFailed'))
  } finally {
    translationProviderEl.disabled = false
  }
}

/**
 * 同步主进程广播的设置变化，并在手动模式标记现有译文过期。
 * @param settings 主进程广播的最新设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncSettings(settings: Settings): void {
  const previousSettings = currentSettings
  const speechProviderChanged = currentSettings?.speechProvider !== settings.speechProvider
  if (speechProviderChanged) stopSpeech()
  currentSettings = settings
  sourceLangEl.value = settings.sourceLang
  targetLangEl.value = settings.targetLang
  renderTranslationProviderOptions(settings)
  const translationSettingsChanged = !previousSettings
    || previousSettings.sourceLang !== settings.sourceLang
    || previousSettings.targetLang !== settings.targetLang
    || previousSettings.preferredTranslationProvider !== settings.preferredTranslationProvider
  if (translationSettingsChanged && mode === 'manual' && manualState.translation) {
    manualState = { ...manualState, stale: true }
    manualSpeechLanguage = ''
  }
  renderMode()
}

/**
 * 界面语言切换后刷新动态文案，同时保留译文、草稿与选择状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleLocaleChanged(): void {
  const sourceValue = sourceLangEl.value
  const targetValue = targetLangEl.value
  const providerValue = translationProviderEl.value
  sourceLangEl.replaceChildren()
  targetLangEl.replaceChildren()
  sourceLangEl.add(new Option(t('popup.autoDetect'), 'auto'))
  targetLangEl.add(new Option(t('popup.autoBilingual'), 'auto'))
  for (const language of LANGUAGES) {
    const label = langLabel(language.code, localeRuntime.locale)
    sourceLangEl.add(new Option(label, language.code))
    targetLangEl.add(new Option(label, language.code))
  }
  sourceLangEl.value = sourceValue || 'auto'
  targetLangEl.value = targetValue || 'auto'
  if (currentSettings) renderTranslationProviderOptions(currentSettings)
  if (providerValue) translationProviderEl.value = providerValue
  if (selectionSourceLangCode || selectionTargetLangCode) {
    const sourceName = selectionSourceLangCode === 'auto' || !selectionSourceLangCode
      ? t('popup.autoDetect')
      : langLabel(selectionSourceLangCode, localeRuntime.locale)
    selectionStatus = selectionTargetLangCode
      ? `${sourceName} → ${langLabel(selectionTargetLangCode, localeRuntime.locale)}`
      : selectionStatus
  }
  if (manualSourceLangCode || manualTargetLangCode) {
    const sourceName = manualSourceLangCode === 'auto' || !manualSourceLangCode
      ? t('popup.autoDetect')
      : langLabel(manualSourceLangCode, localeRuntime.locale)
    manualStatus = manualTargetLangCode
      ? `${sourceName} → ${langLabel(manualTargetLangCode, localeRuntime.locale)}`
      : manualStatus
  }
  renderMode()
  renderPinnedState(pinned)
}

/**
 * 复制当前模式下的成功译文。
 * @returns 无返回值。
 * @author zhenghq
 */
function copyTranslation(): void {
  if (mode === 'manual') {
    if (!manualState.translation || manualState.loading || manualState.error || manualState.stale) return
    window.api.copy(manualState.translation)
  } else {
    if (!lastTranslation) return
    window.api.copy(lastTranslation)
  }
  flashStatus(t('popup.copied'))
}

/**
 * 更新固定按钮的视觉和无障碍状态。
 * @param value 当前固定状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPinnedState(value: boolean): void {
  pinned = value
  pinBtn.setAttribute('aria-pressed', String(value))
  pinBtn.title = value ? t('popup.unpinWindow') : t('popup.pin')
  pinBtn.setAttribute('aria-label', pinBtn.title)
  pinLabelEl.textContent = pinBtn.title
}

/**
 * 切换翻译弹窗固定状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function togglePinned(): void {
  renderPinnedState(!pinned)
  window.api.setPinned(pinned)
}

/**
 * 打开应用设置页面。
 * @returns 无返回值。
 * @author zhenghq
 */
function openSettings(): void { window.api.openSettings() }

/**
 * 打开内置网页全文翻译阅读器。
 * @returns 无返回值。
 * @author zhenghq
 */
function openWebReader(): void { window.api.openWebReader() }

/**
 * 关闭翻译弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
function closePopup(): void {
  stopSpeech()
  window.api.hide()
}

/**
 * 处理 Escape 关闭和手动模式 Command/Ctrl+Enter 提交。
 * @param event 当前键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closePopup()
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && document.activeElement === manualSourceEl) {
    event.preventDefault()
    void submitManualTranslation()
  }
}

window.api.onResult((payload) => {
  if (payload.origin === 'manual') {
    const manualVisible = mode === 'manual'
    if (payload.original !== undefined && payload.loading && payload.original !== manualState.submittedText) return
    if (payload.loading) {
      stopSpeech()
      manualSpeechLanguage = ''
      manualState = {
        ...manualState,
        loading: true,
        error: '',
        requestId: payload.requestId ?? manualState.requestId
      }
      manualProvider = undefined
      manualSourceLangCode = null
      manualTargetLangCode = payload.targetLang ?? ''
      manualStatus = payload.targetLang
        ? t('popup.translatingInto', { language: langLabel(payload.targetLang, localeRuntime.locale) })
        : t('popup.translating')
      if (manualVisible) statusEl.textContent = manualStatus
    } else if (!payload.ok) {
      // 校验错误可能没有经过“加载中”负载；只要原文仍对应当前提交，就接受主进程返回的请求序号。
      if (payload.original !== undefined && payload.original !== manualState.submittedText) return
      stopSpeech()
      manualSpeechLanguage = ''
      if (payload.requestId !== undefined) manualState = { ...manualState, requestId: payload.requestId }
      manualState = failManualTranslation(
        manualState,
        manualState.requestId,
        payload.error ?? t('popup.translationFailed')
      )
      manualProvider = undefined
      manualSourceLangCode = null
      manualTargetLangCode = payload.targetLang ?? ''
      manualStatus = t('popup.translationFailed')
      if (manualVisible) statusEl.textContent = t('popup.translationFailed')
    } else {
      if (payload.requestId !== undefined && payload.requestId !== manualState.requestId) return
      stopSpeech()
      manualState = {
        ...manualState,
        loading: false,
        error: '',
        translation: payload.translation ?? '',
        stale: manualState.stale || manualState.draft !== manualState.submittedText
      }
      manualSpeechLanguage = payload.targetLang ?? targetLangEl.value
      manualProvider = payload.provider
      manualSourceLangCode = payload.detectedLang ?? payload.sourceLang ?? 'auto'
      manualTargetLangCode = payload.targetLang ?? ''
      if (manualVisible) renderTranslationProviderResult(payload.provider)
      const sourceName = payload.detectedLang
        ? langLabel(payload.detectedLang, localeRuntime.locale)
        : payload.sourceLang === 'auto'
          ? t('popup.autoDetect')
          : langLabel(payload.sourceLang ?? '', localeRuntime.locale)
      manualStatus = `${sourceName} → ${langLabel(payload.targetLang ?? '', localeRuntime.locale)}`
      if (manualVisible) statusEl.textContent = manualStatus
    }
    renderManualState()
    return
  }
  if (payload.origin === 'selection' || payload.origin === 'ocr' || payload.origin === undefined) {
    renderSelection(payload)
  }
})

sourceLangEl.addEventListener('change', () => void retranslateWithCurrentLanguages())
targetLangEl.addEventListener('change', () => void retranslateWithCurrentLanguages())
translationProviderEl.addEventListener('change', () => void changeTranslationProvider())
manualModeBtn.addEventListener('click', () => mode === 'manual' ? leaveManualMode() : enterManualMode())
speakBtn.addEventListener('click', () => void toggleSpeech())
manualSourceEl.addEventListener('input', () => {
  manualState = updateManualDraft(manualState, manualSourceEl.value)
  renderManualState()
})
manualClearBtn.addEventListener('click', () => {
  stopSpeech()
  manualSpeechLanguage = ''
  manualState = clearManualTranslation(manualState)
  renderManualState()
  manualSourceEl.focus()
})
manualSubmitBtn.addEventListener('click', () => void submitManualTranslation())
copyBtn.addEventListener('click', copyTranslation)
manualCopyBtn.addEventListener('click', copyTranslation)
ocrCopyBtn.addEventListener('click', () => {
  const text = ocrSourceTextEl.textContent ?? ''
  if (text) window.api.copy(text)
  if (text) flashStatus(t('popup.ocrCopied'))
})
pinBtn.addEventListener('click', togglePinned)
webReaderBtn.addEventListener('click', openWebReader)
settingsBtn.addEventListener('click', openSettings)
closeBtn.addEventListener('click', closePopup)
document.addEventListener('keydown', handleKeydown)
window.api.onManualTranslateOpen(handleManualOpen)
window.api.onPinnedChanged(renderPinnedState)
window.api.onSettingsChanged(syncSettings)
localeRuntime.onLocaleChanged(handleLocaleChanged)
if ('speechSynthesis' in window) {
  window.speechSynthesis.addEventListener('voiceschanged', syncSpeechButton)
}
renderPinnedState(false)
renderMode()
syncSpeechButton()
void initializeSelectors()
