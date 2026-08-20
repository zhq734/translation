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
const manualSourceEl = document.getElementById('manual-source') as HTMLTextAreaElement
const manualClearBtn = document.getElementById('manual-clear') as HTMLButtonElement
const manualCountEl = document.getElementById('manual-count') as HTMLElement
const manualSubmitBtn = document.getElementById('manual-submit') as HTMLButtonElement
const manualResultEl = document.getElementById('manual-result') as HTMLElement
const manualStaleEl = document.getElementById('manual-stale') as HTMLElement
const pinBtn = document.getElementById('pin') as HTMLButtonElement
const settingsBtn = document.getElementById('open-settings') as HTMLButtonElement
const closeBtn = document.getElementById('close') as HTMLButtonElement

let lastTranslation = ''
let lastOriginal = ''
let selectionStatus = ''
let selectionProvider: TranslatePayload['provider'] | undefined
let manualStatus = ''
let manualProvider: TranslatePayload['provider'] | undefined
let statusTimer: ReturnType<typeof setTimeout> | null = null
let pinned = false
let currentSettings: Settings | null = null
let mode: 'selection' | 'manual' = 'selection'
let manualState: ManualTranslationState = createManualTranslationState()
let selectionSpeechLanguage = ''
let manualSpeechLanguage = ''
let speechOperationId = 0

const speechSynthesisApi: SpeechSynthesisLike | null = 'speechSynthesis' in window
  ? window.speechSynthesis as unknown as SpeechSynthesisLike
  : null
const systemSpeechController: SpeechController = createSpeechController({
  synthesis: speechSynthesisApi,
  createUtterance(text: string): SpeechUtteranceLike {
    return new SpeechSynthesisUtterance(text) as unknown as SpeechUtteranceLike
  },
  onSpeakingChange: () => syncSpeechButton(),
  onComplete: () => flashStatus('朗读完成'),
  onError: (message: string) => flashStatus(message)
})
const edgeSpeechController: EdgePlaybackController = createEdgePlaybackController({
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
    if (aborted) return Promise.resolve({ ok: false, error: 'Edge 语音请求已取消' })
    return window.api
      .synthesizeEdgeSpeech(text, language, requestId)
      .then((result) => aborted
        ? { ok: false, error: 'Edge 语音请求已取消' }
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
  onSynthesisStart: () => flashStatus('正在请求 Edge 语音…', 20_000),
  onAudioReady: (byteLength) => flashStatus(`已收到 Edge 音频（${byteLength} 字节）`, 5000),
  onPlaybackStart: () => flashStatus('正在播放 Edge 语音…', 5000),
  onSpeakingChange: () => syncSpeechButton(),
  onComplete: () => flashStatus('朗读完成')
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
  const sourceOptions = [{ code: 'auto', label: '自动检测' }, ...LANGUAGES]
  const targetOptions = [{ code: 'auto', label: '自动中英互译' }, ...LANGUAGES]
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
  translationProviderEl.add(new Option('自动选择', 'auto'))
  for (const provider of TRANSLATION_PROVIDERS) {
    const available = isTranslationProviderAvailable(provider.id, settings)
    const option = new Option(available ? provider.label : `${provider.label}（未启用）`, provider.id)
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
  const preferredLabel = translationProviderLabel(preferredProvider)
  if (!actualProvider) {
    selectedOption.textContent = preferredLabel
    translationProviderEl.title = `首选翻译 API：${preferredLabel}`
    return
  }
  const actualLabel = translationProviderLabel(actualProvider)
  if (preferredProvider === 'auto') {
    selectedOption.textContent = `自动 · ${actualLabel}`
    translationProviderEl.title = `自动选择，实际使用：${actualLabel}`
  } else if (preferredProvider !== actualProvider) {
    selectedOption.textContent = `${preferredLabel} → ${actualLabel}`
    translationProviderEl.title = `首选 ${preferredLabel} 已熔断或不可用，实际使用：${actualLabel}`
  } else {
    selectedOption.textContent = preferredLabel
    translationProviderEl.title = `首选并实际使用：${preferredLabel}`
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
  const label = speaking
    ? '停止朗读'
    : disabled
      ? '暂无可朗读的译文'
      : currentSettings?.speechProvider === 'edge'
        ? '使用 Edge 在线语音朗读译文'
        : systemSpeechController.canSpeak(getCurrentSpeechLanguage())
        ? '朗读译文'
        : '朗读译文（需要系统语音）'
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
    flashStatus('已停止朗读')
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
    if (operationId === speechOperationId && !result.ok && result.error !== 'Edge 语音请求已取消') {
      flashStatus(`Edge 在线语音暂不可用：${result.error ?? '未知错误'}，已切换到系统语音`, 8000)
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
function renderSelection(payload: TranslatePayload): void {
  const visible = mode === 'selection'
  if (visible) syncLanguageSelectors(payload)
  if (payload.original !== undefined) lastOriginal = payload.original
  if (payload.loading) {
    stopSpeech()
    lastTranslation = ''
    selectionSpeechLanguage = ''
    selectionProvider = undefined
    selectionStatus = payload.targetLang
      ? `正在翻译为${langLabel(payload.targetLang)}…`
      : '正在翻译…'
    if (visible) renderTranslationProviderResult()
    resultEl.textContent = '正在翻译…'
    resultEl.classList.add('loading')
    originalEl.textContent = payload.original ?? lastOriginal
    copyBtn.hidden = true
    if (visible) statusEl.textContent = selectionStatus
    syncSpeechButton()
    return
  }
  resultEl.classList.remove('loading')
  if (!payload.ok) {
    stopSpeech()
    lastTranslation = ''
    selectionSpeechLanguage = ''
    selectionProvider = undefined
    selectionStatus = '翻译失败'
    if (visible) renderTranslationProviderResult()
    resultEl.textContent = payload.error ?? '未知错误'
    originalEl.textContent = lastOriginal
    copyBtn.hidden = true
    if (visible) statusEl.textContent = selectionStatus
    syncSpeechButton()
    return
  }
  stopSpeech()
  const sourceName = payload.detectedLang
    ? langLabel(payload.detectedLang)
    : payload.sourceLang === 'auto' ? '自动检测' : langLabel(payload.sourceLang ?? '')
  const targetName = langLabel(payload.targetLang ?? '')
  selectionProvider = payload.provider
  selectionStatus = `${sourceName} → ${targetName}`
  if (visible) renderTranslationProviderResult(selectionProvider)
  lastTranslation = payload.translation ?? ''
  selectionSpeechLanguage = payload.targetLang ?? targetLangEl.value
  resultEl.textContent = lastTranslation
  originalEl.textContent = payload.original ?? lastOriginal
  copyBtn.hidden = !visible || !lastTranslation
  if (visible) statusEl.textContent = selectionStatus
  syncSpeechButton()
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
  manualSubmitBtn.disabled = !canSubmitManualTranslation(manualState)
  manualSubmitBtn.textContent = manualState.loading ? '翻译中…' : '翻译'
  manualResultEl.className = 'manual-result'
  if (manualState.loading) {
    manualResultEl.classList.add('loading')
    manualResultEl.textContent = '正在翻译…'
  } else if (manualState.error) {
    manualResultEl.classList.add('error')
    manualResultEl.textContent = manualState.error
  } else if (manualState.translation) {
    manualResultEl.textContent = manualState.translation
  } else {
    manualResultEl.classList.add('empty')
    manualResultEl.textContent = '翻译结果将显示在这里'
  }
  manualStaleEl.hidden = !manualState.stale
  manualCopyBtn.hidden = mode !== 'manual'
    || !manualState.translation
    || manualState.loading
    || Boolean(manualState.error)
    || manualState.stale
  manualCopyBtn.disabled = manualCopyBtn.hidden
  syncSpeechButton()
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
  manualModeBtn.title = manual ? '切换划词翻译' : '切换手动翻译'
  manualModeBtn.setAttribute('aria-label', manualModeBtn.title)
  copyBtn.hidden = manual || !lastTranslation
  manualCopyBtn.hidden = !manual || !manualState.translation || manualState.loading || Boolean(manualState.error) || manualState.stale
  translationProviderEl.disabled = false
  statusEl.textContent = manual ? manualStatus : selectionStatus
  renderTranslationProviderResult(manual ? manualProvider : selectionProvider)
  renderManualState()
  syncSpeechButton()
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
  const validationError = validateManualTranslationText(manualState.draft)
  if (validationError) {
    manualState = { ...manualState, error: validationError }
    renderManualState()
    return
  }
  if (!canSubmitManualTranslation(manualState)) return
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
    manualState = failManualTranslation(manualState, manualState.requestId, '翻译请求失败，请重试')
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
      flashStatus('语言设置保存失败')
    } finally {
      sourceLangEl.disabled = false
      targetLangEl.disabled = false
    }
    return
  }
  if (!lastOriginal) return
  sourceLangEl.disabled = true
  targetLangEl.disabled = true
  try {
    await window.api.retranslate(sourceLangEl.value, targetLangEl.value)
  } catch {
    flashStatus('重新翻译失败')
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
      flashStatus(`已优先使用${translationProviderLabel(currentSettings.preferredTranslationProvider)}`)
    }
  } catch {
    translationProviderEl.value = previousProvider
    flashStatus('翻译 API 切换失败')
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
  flashStatus('已复制')
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
  pinBtn.title = value ? '取消固定弹窗' : '固定弹窗'
  pinBtn.setAttribute('aria-label', pinBtn.title)
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
      manualStatus = payload.targetLang
        ? `正在翻译为${langLabel(payload.targetLang)}…`
        : '正在翻译…'
      if (manualVisible) statusEl.textContent = manualStatus
    } else if (!payload.ok) {
      // 校验错误可能没有经过“加载中”负载；只要原文仍对应当前提交，就接受主进程返回的请求序号。
      if (payload.original !== undefined && payload.original !== manualState.submittedText) return
      stopSpeech()
      manualSpeechLanguage = ''
      if (payload.requestId !== undefined) manualState = { ...manualState, requestId: payload.requestId }
      manualState = failManualTranslation(manualState, manualState.requestId, payload.error ?? '翻译失败')
      manualProvider = undefined
      manualStatus = '翻译失败'
      if (manualVisible) statusEl.textContent = '翻译失败'
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
      if (manualVisible) renderTranslationProviderResult(payload.provider)
      const sourceName = payload.detectedLang
        ? langLabel(payload.detectedLang)
        : payload.sourceLang === 'auto' ? '自动检测' : langLabel(payload.sourceLang ?? '')
      manualStatus = `${sourceName} → ${langLabel(payload.targetLang ?? '')}`
      if (manualVisible) statusEl.textContent = manualStatus
    }
    renderManualState()
    return
  }
  if (payload.origin === 'selection' || payload.origin === undefined) renderSelection(payload)
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
pinBtn.addEventListener('click', togglePinned)
settingsBtn.addEventListener('click', openSettings)
closeBtn.addEventListener('click', closePopup)
document.addEventListener('keydown', handleKeydown)
window.api.onManualTranslateOpen(handleManualOpen)
window.api.onPinnedChanged(renderPinnedState)
window.api.onSettingsChanged(syncSettings)
if ('speechSynthesis' in window) {
  window.speechSynthesis.addEventListener('voiceschanged', syncSpeechButton)
}
renderPinnedState(false)
renderMode()
syncSpeechButton()
void initializeSelectors()
