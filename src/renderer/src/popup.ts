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
import type {
  PronunciationDefinition,
  PronunciationResult,
  PronunciationVariant,
  Settings,
  TranslateDeltaPayload,
  TranslatePayload
} from '../../shared/types'
import { MANUAL_TRANSLATION_MAX_CHARS } from '../../shared/types'
import { POPUP_AUTO_SIZE_LIMITS } from '../../shared/popupAutoSize'
import { createThrottledScheduler } from '../../shared/throttledScheduler'
import {
  parsePronunciationWord,
  splitPronunciationText
} from '../../shared/pronunciationWord'
import {
  appendProgressiveText,
  createProgressiveRevealState,
  finalizeProgressiveText,
  nextRevealLength,
  resolveRevealStepMs,
  settleProgressiveText,
  shouldPreservePartialReveal,
  type ProgressiveRevealState
} from '../../shared/progressiveReveal'
import {
  createSpeechController,
  resolveSpeechLanguage,
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
import { applyWin7CompatibilityAttribute } from './runtimeCompatibility'
import {
  beginPronunciationLookup,
  closePronunciationCard,
  createPronunciationCardState,
  settlePronunciationLookup,
  type PronunciationCardContext,
  type PronunciationCardState
} from './pronunciationCard'
import {
  createPronunciationClickGate,
  shouldLookupPronunciationWord
} from './pronunciationInteraction'
import {
  createPronunciationPlaybackCoordinator,
  type PronunciationPlaybackLease,
  type PronunciationPlaybackTarget
} from './pronunciationPlayback'
import { startPronunciationSpeechFallback } from './pronunciationSpeechFallback'

applyWin7CompatibilityAttribute()
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
const sourceSectionHeadEl = document.getElementById('source-section-head') as HTMLElement
const resultEl = document.getElementById('result') as HTMLElement
const originalEl = document.getElementById('original') as HTMLElement
const readOriginalBtn = document.getElementById('read-original') as HTMLButtonElement
const pronunciationCardEl = document.getElementById('pronunciation-card') as HTMLElement
const translationPronunciationCardEl = document.getElementById('translation-pronunciation-card') as HTMLElement
/** 音标卡在原文插槽中的原始父元素，切换到译文后关闭时需要归还。 */
const sourcePronunciationCardSlot = pronunciationCardEl.parentElement
const pronunciationWordEl = document.getElementById('pronunciation-word') as HTMLElement
const pronunciationVariantsEl = document.getElementById('pronunciation-variants') as HTMLElement
const pronunciationCloseBtn = document.getElementById('pronunciation-close') as HTMLButtonElement
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
/** 原文朗读使用的源语言快照，严格按 detectedLang ?? sourceLang 取值。 */
let selectionOriginalSpeechLanguage = 'auto'
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
let lastRequestedAutoSize = { width: 0, height: 0 }
/** 划词结果的渐进展示状态。 */
let selectionReveal: ProgressiveRevealState = createProgressiveRevealState()
/** 手动翻译结果的渐进展示状态。 */
let manualReveal: ProgressiveRevealState = createProgressiveRevealState()
let revealTimer: ReturnType<typeof setTimeout> | null = null
let revealTarget: 'selection' | 'manual' | null = null
let revealSequence = 0
/** 当前划词渐进展示状态所属的请求序号，用于失败时只保留本请求的片段。 */
let selectionRevealRequestId = 0
/** 音标卡当前状态。 */
let pronunciationCard: PronunciationCardState = createPronunciationCardState()
/** 当前音标查询序号；关闭或切换单词后旧结果会被丢弃。 */
let pronunciationLookupSequence = 0
/** 当前音标查询对应的主进程请求 ID。 */
let pronunciationLookupRequestId = ''
/** 当前单词音频下载对应的主进程请求 ID。 */
let pronunciationAudioRequestId = ''
/** 当前单词播放的临时音频与 Blob URL。 */
let wordAudio: HTMLAudioElement | null = null
let wordAudioUrl = ''
/** 当前单词播放对应的会话租约，用于忽略迟到音频。 */
let wordPlaybackLease: PronunciationPlaybackLease | null = null
/** 当前正在播放的音标变体 ID，用于同步发音按钮的可访问状态。 */
let activeVariantId: string | null = null
/** 指针按下位置，用于区分单击与拖拽。 */
let originalPointerStart: { x: number; y: number } | null = null
/** 最近一次原文指针移动距离；超过阈值后禁止本次 click 触发查词。 */
let originalPointerTravel = 0
/** 原文单击/双击门控，避免双击第一次 click 提前查词。 */
const originalClickGate = createPronunciationClickGate({
  delayMs: 250,
  schedule: (callback) => window.setTimeout(callback, 250),
  cancel: (timer) => window.clearTimeout(timer as number)
})
/** 译文单击/双击门控，避免双击第一次 click 提前查词。 */
const translationClickGate = createPronunciationClickGate({
  delayMs: 250,
  schedule: (callback) => window.setTimeout(callback, 250),
  cancel: (timer) => window.clearTimeout(timer as number)
})
/** 译文区指针按下位置，用于区分单击与拖拽。 */
let translationPointerStart: { x: number; y: number } | null = null
/** 最近一次译文指针移动距离。 */
let translationPointerTravel = 0

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
  synthesize: (text, language, signal, ipa) => {
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
      .synthesizeEdgeSpeech(text, language, requestId, ipa)
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
 * 释放单词词典音频对象与临时 Blob URL。
 * @returns 无返回值。
 * @author zhenghq
 */
function releaseWordAudio(): void {
  wordPlaybackLease = null
  if (wordAudio) {
    wordAudio.onended = null
    wordAudio.onerror = null
    wordAudio.pause()
    wordAudio.removeAttribute('src')
    wordAudio.load()
    wordAudio.remove()
    wordAudio = null
  }
  if (wordAudioUrl) {
    URL.revokeObjectURL(wordAudioUrl)
    wordAudioUrl = ''
  }
}

/**
 * 取消当前单词音频下载并清空请求 ID。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelPronunciationAudioRequest(): void {
  if (pronunciationAudioRequestId) {
    window.api.cancelPronunciationRequest(pronunciationAudioRequestId)
    pronunciationAudioRequestId = ''
  }
}

/**
 * 取消当前音标查询并清空请求 ID。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelPronunciationLookup(): void {
  if (pronunciationLookupRequestId) {
    window.api.cancelPronunciationRequest(pronunciationLookupRequestId)
    pronunciationLookupRequestId = ''
  }
}

/**
 * 停止所有播放目标并释放音频、语音和渐进资源。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopPronunciationPlayback(): void {
  pronunciationPlayback.stop()
}

/**
 * 创建统一播放协调器，并在切换目标时释放对应的音频或语音资源。
 * @returns 无返回值。
 * @author zhenghq
 */
const pronunciationPlayback = createPronunciationPlaybackCoordinator({
  onStop: (target: PronunciationPlaybackTarget) => {
    if (target === 'word') {
      activeVariantId = null
      cancelPronunciationAudioRequest()
      releaseWordAudio()
      systemSpeechController.stop()
      edgeSpeechController.stop()
      renderPronunciationCard()
    }
    if (target === 'source') {
      stopTextPlayback()
    }
    if (target === 'translation') {
      stopSpeech()
      return
    }
    syncSpeechButton()
    syncSourceSpeechButton()
  }
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
  const speaking =
    pronunciationPlayback.activeTarget() === 'translation' &&
    isSpeechPlaying()
  const disabled = !translation && !speaking
  speakBtn.disabled = disabled
  speakBtn.setAttribute('aria-pressed', String(pronunciationPlayback.activeTarget() === 'translation'))
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
 * 同步原文朗读按钮的可用、按下和无障碍状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncSourceSpeechButton(): void {
  const available = canUseSourcePronunciation() && Boolean(lastOriginal.trim())
  const active = pronunciationPlayback.activeTarget() === 'source'
  readOriginalBtn.hidden = !available
  readOriginalBtn.disabled = !available
  readOriginalBtn.setAttribute('aria-pressed', String(active))
  const label = active ? t('popup.speechStop') : t('popup.readOriginal')
  readOriginalBtn.title = label
  readOriginalBtn.setAttribute('aria-label', label)
}

/**
 * 在播放自然结束或失败后结束对应协调器会话，并刷新三个播放入口。
 * @param target 已结束的播放目标。
 * @param lease 结束回调所属的播放会话租约。
 * @returns 无返回值。
 * @author zhenghq
 */
function finishPronunciationPlayback(
  target: PronunciationPlaybackTarget,
  lease: PronunciationPlaybackLease
): void {
  if (!lease.isCurrent() || pronunciationPlayback.activeTarget() !== target) return
  pronunciationPlayback.stop()
  if (target === 'word') activeVariantId = null
  renderPronunciationCard()
  syncSpeechButton()
  syncSourceSpeechButton()
}

/**
 * 使当前文本朗读会话失效，并同时停止 Edge 与系统语音。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopTextPlayback(): void {
  speechOperationId += 1
  systemSpeechController.stop()
  edgeSpeechController.stop()
}

/**
 * 停止当前语音会话并立即刷新朗读按钮状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopSpeech(): void {
  stopTextPlayback()
  syncSpeechButton()
}

/**
 * 设置音标交互状态；打开卡片时暂停自动隐藏，关闭后恢复原有计时。
 * @param active 是否正在查看或操作音标卡。
 * @returns 无返回值。
 * @author zhenghq
 */
function setPronunciationInteraction(active: boolean): void {
  window.api.setPronunciationInteraction(active)
}

/**
 * 判断当前模式是否允许展示原文音标和原文朗读。
 * @returns 划词模式且不是 OCR 原文时返回 true。
 * @author zhenghq
 */
function canUseSourcePronunciation(): boolean {
  return mode === 'selection' && currentSelectionOrigin !== 'ocr'
}

/**
 * 根据当前音标卡状态渲染卡片结构、加载态、空态和发音按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPronunciationCard(): void {
  const sourceSlot = sourcePronunciationCardSlot
  const targetSlot = pronunciationCard.context === 'translation'
    ? translationPronunciationCardEl
    : sourceSlot
  if (targetSlot && pronunciationCardEl.parentElement !== targetSlot) {
    targetSlot.append(pronunciationCardEl)
  }
  const visible = mode === 'selection'
    && currentSelectionOrigin !== 'ocr'
    && pronunciationCard.status !== 'hidden'
  pronunciationCardEl.hidden = !visible
  setPronunciationInteraction(visible)
  if (!visible) {
    requestAutoResize()
    return
  }

  pronunciationWordEl.textContent = pronunciationCard.word
  pronunciationVariantsEl.replaceChildren()
  const definitions = pronunciationCard.definitions
  if (pronunciationCard.status === 'loading') {
    const loading = document.createElement('span')
    loading.className = 'pronunciation-status'
    loading.textContent = t('popup.pronunciationLoading')
    pronunciationVariantsEl.append(loading)
    renderPronunciationDefinitions(definitions)
    requestAutoResize()
    return
  }
  if (pronunciationCard.status !== 'available' || pronunciationCard.variants.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'pronunciation-status'
    empty.textContent = t('popup.pronunciationUnavailable')
    const fallback = createPronunciationWordPlayButton()
    const emptyRow = document.createElement('span')
    emptyRow.className = 'pronunciation-empty-row'
    emptyRow.append(empty, fallback)
    pronunciationVariantsEl.append(emptyRow)
    renderPronunciationDefinitions(definitions)
    requestAutoResize()
    return
  }

  for (const variant of pronunciationCard.variants) {
    const item = document.createElement('span')
    item.className = 'pronunciation-variant'
    item.dataset.variantId = variant.id
    const accent = document.createElement('span')
    accent.className = 'pronunciation-accent'
    accent.textContent = variant.accent === 'US'
      ? t('popup.pronunciationUS')
      : variant.accent === 'UK'
        ? t('popup.pronunciationUK')
        : t('popup.pronunciationOther')
    const ipa = document.createElement('span')
    ipa.className = 'pronunciation-ipa'
    ipa.textContent = variant.ipa
    item.append(accent, ipa)
    const play = document.createElement('button')
    play.type = 'button'
    play.className = 'pronunciation-play'
    play.dataset.variantId = variant.id
    const playing = pronunciationPlayback.activeTarget() === 'word' && activeVariantId === variant.id
    play.setAttribute('aria-pressed', String(playing))
    play.setAttribute('aria-label', playing
      ? t('popup.pronunciationPlayVariantPlaying', {
          word: pronunciationCard.word,
          accent: accent.textContent ?? ''
        })
      : t('popup.pronunciationPlayVariant', {
          word: pronunciationCard.word,
          accent: accent.textContent ?? ''
        }))
    play.textContent = playing ? '■' : '▶'
    item.append(play)
    pronunciationVariantsEl.append(item)
  }
  renderPronunciationDefinitions(definitions)
  requestAutoResize()
}

/**
 * 创建无音标时仍可触发单词 TTS 的播放按钮。
 * @returns 可访问的单词播放按钮。
 * @author zhenghq
 */
function createPronunciationWordPlayButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'pronunciation-play pronunciation-play-word'
  const playing = pronunciationPlayback.activeTarget() === 'word' && !activeVariantId
  button.setAttribute('aria-pressed', String(playing))
  button.setAttribute('aria-label', playing
    ? t('popup.pronunciationPlayWordPlaying', { word: pronunciationCard.word })
    : t('popup.pronunciationPlayWord', { word: pronunciationCard.word }))
  button.textContent = playing ? '■' : '▶'
  return button
}

/**
 * 把当前单词释义渲染到音标卡，没有释义时不创建空节点。
 * @param definitions 当前单词释义列表。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPronunciationDefinitions(definitions: PronunciationDefinition[]): void {
  const existing = pronunciationCardEl.querySelector('.pronunciation-definitions')
  existing?.remove()
  if (!Array.isArray(definitions) || definitions.length === 0) return
  const list = document.createElement('div')
  list.className = 'pronunciation-definitions'
  for (const definition of definitions) {
    list.append(createPronunciationDefinition(definition))
  }
  pronunciationCardEl.append(list)
}

/**
 * 创建单条释义节点，并区分词性和中英文来源。
 * @param definition 主进程返回的释义。
 * @returns 释义节点。
 * @author zhenghq
 */
function createPronunciationDefinition(definition: PronunciationDefinition): HTMLElement {
  const item = document.createElement('div')
  item.className = 'pronunciation-definition'
  item.lang = definition.language
  if (definition.partOfSpeech) {
    const pos = document.createElement('span')
    pos.className = 'pronunciation-definition-pos'
    pos.textContent = definition.partOfSpeech
    item.append(pos)
  }
  const text = document.createElement('span')
  text.className = 'pronunciation-definition-text'
  text.textContent = definition.text
  item.append(text)
  return item
}

/**
 * 关闭音标卡并清理当前查询、播放和自动隐藏交互状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function closePronunciation(): void {
  pronunciationLookupSequence += 1
  cancelPronunciationLookup()
  cancelPronunciationAudioRequest()
  pronunciationCard = closePronunciationCard(pronunciationCard)
  if (pronunciationPlayback.activeTarget() === 'word') pronunciationPlayback.stop()
  activeVariantId = null
  releaseWordAudio()
  renderPronunciationCard()
}

/**
 * 查询并展示指定英文单词的音标；旧请求结果不会覆盖新单词。
 * @param word 待查询的英文单词。
 * @returns 查询完成后的 Promise。
 * @author zhenghq
 */
async function lookupPronunciation(
  word: string,
  context: PronunciationCardContext = 'source'
): Promise<void> {
  if (context === 'source' && !canUseSourcePronunciation()) return
  if (context === 'translation' && (mode !== 'selection' || currentSelectionOrigin === 'ocr')) return
  const parsed = parsePronunciationWord(word)
  if (!parsed) return
  if (
    pronunciationCard.word === parsed.word
    && pronunciationCard.context === context
    && pronunciationCard.status !== 'hidden'
  ) {
    renderPronunciationCard()
    return
  }
  stopPronunciationPlayback()
  const requestId = ++pronunciationLookupSequence
  cancelPronunciationLookup()
  const apiRequestId = `pronunciation-lookup-${requestId}`
  pronunciationLookupRequestId = apiRequestId
  pronunciationCard = beginPronunciationLookup(pronunciationCard, parsed.word, requestId, context)
  renderPronunciationCard()
  try {
    const result = await window.api.lookupPronunciation(parsed.word, apiRequestId)
    if (pronunciationLookupRequestId !== apiRequestId) return
    if (pronunciationLookupRequestId === apiRequestId) pronunciationLookupRequestId = ''
    if (requestId !== pronunciationLookupSequence) return
    pronunciationCard = settlePronunciationLookup(pronunciationCard, requestId, result)
    renderPronunciationCard()
  } catch {
    if (pronunciationLookupRequestId !== apiRequestId) return
    if (pronunciationLookupRequestId === apiRequestId) pronunciationLookupRequestId = ''
    if (requestId !== pronunciationLookupSequence) return
    const unavailable: PronunciationResult = {
      status: 'unavailable',
      word: parsed.word,
      language: 'en',
      variants: [],
      source: 'dictionaryapi'
    }
    pronunciationCard = settlePronunciationLookup(pronunciationCard, requestId, unavailable)
    renderPronunciationCard()
  }
}

/**
 * 将原文中的英文单词渲染为可点击片段，查询由用户点击后按需触发。
 * @param text 当前原文。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOriginalPronunciation(text: string): void {
  originalEl.textContent = text
  syncSourceSpeechButton()
  if (!canUseSourcePronunciation() || !text) return
  const segments = splitPronunciationText(text)
  if (!segments.some((segment) => segment.kind === 'word')) return
  originalEl.replaceChildren()
  for (const segment of segments) {
    if (segment.kind === 'text') {
      originalEl.append(document.createTextNode(segment.text))
      continue
    }
    const word = document.createElement('span')
    word.className = 'pronunciation-word-token'
    word.dataset.pronunciationWord = segment.word.word
    word.textContent = segment.text
    originalEl.append(word)
  }
}

/**
 * 将划词译文中的英文单词渲染为可点击片段，中文、数字和链接保持纯文本。
 * @param text 已稳定展示的完整译文。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTranslationPronunciation(text: string): void {
  if (mode !== 'selection' || currentSelectionOrigin === 'ocr') {
    resultEl.textContent = text
    return
  }
  const segments = splitPronunciationText(text)
  if (!segments.some((segment) => segment.kind === 'word')) {
    resultEl.textContent = text
    return
  }
  const fragment = document.createDocumentFragment()
  for (const segment of segments) {
    if (segment.kind === 'text') {
      fragment.append(document.createTextNode(segment.text))
      continue
    }
    const word = document.createElement('span')
    word.className = 'pronunciation-word-token translation-pronunciation-word'
    word.dataset.pronunciationWord = segment.word.word
    word.textContent = segment.text
    fragment.append(word)
  }
  resultEl.replaceChildren(fragment)
}

/**
 * 从事件目标中提取可查询的原文单词元素。
 * @param target 指针或点击事件目标。
 * @returns 单词元素；目标不是可查询词片段时返回 null。
 * @author zhenghq
 */
function getPronunciationWordTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const element = target.closest('.pronunciation-word-token, [data-pronunciation-word]')
  return element instanceof HTMLElement ? element : null
}

/**
 * 记录原文区指针按下位置，用于区分单击与拖拽选择。
 * @param event 原文区指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOriginalPointerDown(event: PointerEvent): void {
  originalPointerTravel = 0
  originalPointerStart = event.button === 0
    ? { x: event.clientX, y: event.clientY }
    : null
}

/**
 * 计算原文区指针移动距离，并在抬起时更新拖拽判定所需状态。
 * @param event 原文区指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOriginalPointerUp(event: PointerEvent): void {
  if (!originalPointerStart) return
  originalPointerTravel = Math.hypot(
    event.clientX - originalPointerStart.x,
    event.clientY - originalPointerStart.y
  )
}

/**
 * 在原文区按需查询被单击的英文单词，同时保留选择和复制行为。
 * @param event 原文区点击事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOriginalClick(event: MouseEvent): void {
  const wordTarget = getPronunciationWordTarget(event.target)
  const start = originalPointerStart
  const pointerTravel = start
    ? Math.max(originalPointerTravel, Math.hypot(event.clientX - start.x, event.clientY - start.y))
    : originalPointerTravel
  originalPointerStart = null
  const word = wordTarget?.dataset.pronunciationWord?.trim()
  if (!word) return
  if (!shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: Boolean(window.getSelection()?.toString().trim()),
    pointerTravel,
    clickCount: event.detail
  })) return
  originalClickGate.click(() => void lookupPronunciation(word, 'source'))
}

/**
 * 记录译文区指针按下位置，用于区分单击与拖拽选择。
 * @param event 译文区指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTranslationPointerDown(event: PointerEvent): void {
  translationPointerTravel = 0
  translationPointerStart = event.button === 0
    ? { x: event.clientX, y: event.clientY }
    : null
}

/**
 * 计算译文区指针移动距离，并更新拖拽判定状态。
 * @param event 译文区指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTranslationPointerUp(event: PointerEvent): void {
  if (!translationPointerStart) return
  translationPointerTravel = Math.hypot(
    event.clientX - translationPointerStart.x,
    event.clientY - translationPointerStart.y
  )
}

/**
 * 在译文区按需查询被单击的英文单词，同时保留选择和复制行为。
 * @param event 译文区点击事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTranslationClick(event: MouseEvent): void {
  const translationPronunciationWordTarget = getPronunciationWordTarget(event.target)
  const start = translationPointerStart
  const pointerTravel = start
    ? Math.max(translationPointerTravel, Math.hypot(event.clientX - start.x, event.clientY - start.y))
    : translationPointerTravel
  translationPointerStart = null
  const word = translationPronunciationWordTarget?.dataset.pronunciationWord?.trim()
  if (!word) return
  if (!shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: Boolean(window.getSelection()?.toString().trim()),
    pointerTravel,
    clickCount: event.detail
  })) return
  translationClickGate.click(() => void lookupPronunciation(word, 'translation'))
}

/**
 * 处理朗读按钮点击，在开始和停止之间切换当前语音会话。
 * @returns 无返回值。
 * @author zhenghq
 */
async function toggleSpeech(): Promise<void> {
  const toggle = pronunciationPlayback.toggle('translation')
  if (toggle.action === 'stop') {
    flashStatus(t('popup.speechStopped'))
    return
  }
  const lease = toggle.lease
  if (!lease) return
  const translation = getCurrentTranslation()
  if (!translation) {
    pronunciationPlayback.stop()
    syncSpeechButton()
    return
  }
  await startTranslationPlayback(translation, lease)
}
/**
 * 使用当前语音设置播放译文，并在会话失效时停止迟到播放。
 * @param text 待朗读译文。
 * @param lease 统一播放会话租约。
 * @returns 播放完成后的 Promise。
 * @author zhenghq
 */
async function startTranslationPlayback(text: string, lease: PronunciationPlaybackLease): Promise<void> {
  const language = getCurrentSpeechLanguage()
  await startTextPlayback(text, language, 'translation', lease)
}

/**
 * 按当前语音设置朗读文本；Edge 失败时回退系统语音，并同步结束对应播放会话。
 * @param text 待朗读文本。
 * @param language 文本实际语言。
 * @param target 当前播放目标。
 * @param lease 统一播放会话租约。
 * @returns 播放完成后的 Promise。
 * @author zhenghq
 */
async function startTextPlayback(
  text: string,
  language: string,
  target: 'translation' | 'source',
  lease: PronunciationPlaybackLease
): Promise<void> {
  const operationId = ++speechOperationId
  const resolvedLanguage = resolveSpeechLanguage(text, language)
  if (currentSettings?.speechProvider === 'edge') {
    const result = await edgeSpeechController.start(text, resolvedLanguage)
    if (!lease.isCurrent()) return
    if (result.ok) {
      finishPronunciationPlayback(target, lease)
      return
    }
    if (result.error !== t('popup.edgeSpeechCancelled')) {
      flashStatus(t('popup.edgeSpeechUnavailableWithError', {
        error: result.error ?? t('common.unknownError')
      }), 8000)
      if (operationId !== speechOperationId) return
    } else {
      finishPronunciationPlayback(target, lease)
      return
    }
  }
  const result = systemSpeechController.start(text, resolvedLanguage)
  if (result.ok) {
    const timer = window.setInterval(() => {
      if (!lease.isCurrent()) {
        window.clearInterval(timer)
        return
      }
      if (!systemSpeechController.isSpeaking()) {
        window.clearInterval(timer)
        finishPronunciationPlayback(target, lease)
      }
    }, 150)
  } else if (lease.isCurrent()) {
    pronunciationPlayback.stop()
  }
  syncSpeechButton()
  syncSourceSpeechButton()
}

/**
 * 切换原文整段朗读；使用原文和检测到的源语言，不读取译文或目标语言。
 * @returns 无返回值。
 * @author zhenghq
 */
function toggleSourcePlayback(): void {
  const text = lastOriginal.trim()
  if (!text) return
  const toggle = pronunciationPlayback.toggle('source')
  if (toggle.action === 'stop') return
  const lease = toggle.lease
  if (!lease) return
  const language = selectionOriginalSpeechLanguage
  syncSourceSpeechButton()
  void startTextPlayback(text, language, 'source', lease)
}

/**
 * 切换当前音标词发音；优先请求词典音频，失败时回退系统 TTS。
 * @param variantId 用户点击的音标变体标识；缺省时回退到第一个可用变体。
 * @returns 播放完成后的 Promise。
 * @author zhenghq
 */
async function toggleWordPlayback(variantId?: string): Promise<void> {
  const word = pronunciationCard.word
  if (!word || pronunciationCard.status === 'hidden') return
  const toggle = pronunciationPlayback.toggle('word')
  if (toggle.action === 'stop') {
    activeVariantId = null
    renderPronunciationCard()
    return
  }
  const lease = toggle.lease
  if (!lease) return
  wordPlaybackLease = lease
  const variant = variantId
    ? pronunciationCard.variants.find((candidate) => candidate.id === variantId)
    : pronunciationCard.variants.find((candidate) => candidate.hasAudio)
  activeVariantId = variant?.id ?? null
  renderPronunciationCard()
  if (variant) {
    cancelPronunciationAudioRequest()
    const audioRequestId = `pronunciation-audio-${pronunciationLookupSequence}-${variant.id}`
    pronunciationAudioRequestId = audioRequestId
    try {
      const result = await window.api.fetchPronunciationAudio(word, variant.id, audioRequestId)
      if (pronunciationAudioRequestId !== audioRequestId) return
      if (pronunciationAudioRequestId === audioRequestId) pronunciationAudioRequestId = ''
      if (!lease.isCurrent()) return
      if (result.ok) {
        await playWordAudio(result.audio, result.mimeType, lease, variant)
        return
      }
    } catch {
      if (pronunciationAudioRequestId !== audioRequestId) return
      if (pronunciationAudioRequestId === audioRequestId) pronunciationAudioRequestId = ''
      if (!lease.isCurrent()) return
    }
  }
  if (!lease.isCurrent()) return
  const started = await startPronunciationSpeechFallback(word, {
    speechProvider: currentSettings?.speechProvider,
    variant,
    edge: edgeSpeechController,
    system: systemSpeechController
  })
  if (!lease.isCurrent()) return
  if (started.status === 'failed') {
    pronunciationPlayback.stop()
    activeVariantId = null
    renderPronunciationCard()
    return
  }
  // start() 已确认会话建立；后续轮询只负责识别自然结束，不能在启动瞬间用瞬时状态取消。
  const timer = window.setInterval(() => {
    if (!lease.isCurrent()) {
      window.clearInterval(timer)
      return
    }
    if (!isSpeechPlaying()) {
      window.clearInterval(timer)
      finishPronunciationPlayback('word', lease)
    }
  }, 150)
}

/**
 * 将词典音频字节转为 Blob URL 并播放，结束后释放资源。
 * @param bytes 音频字节。
 * @param mimeType 音频 MIME 类型。
 * @param lease 当前单词播放会话租约。
 * @param variant 当前点击的音标变体；词典音频播放失败时保留其 IPA。
 * @returns 播放结束后的 Promise。
 * @author zhenghq
 */
function playWordAudio(
  bytes: Uint8Array,
  mimeType: string,
  lease: PronunciationPlaybackLease,
  variant?: PronunciationVariant
): Promise<void> {
  return new Promise((resolve) => {
    if (!lease.isCurrent()) {
      resolve()
      return
    }
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
    const audio = document.createElement('audio')
    wordAudioUrl = url
    wordAudio = audio
    audio.src = url
    audio.preload = 'auto'
    const finish = (): void => {
      if (wordAudio === audio) releaseWordAudio()
      finishPronunciationPlayback('word', lease)
      resolve()
    }
    audio.onended = finish
    audio.onerror = () => {
      if (!lease.isCurrent()) {
        finish()
        return
      }
      releaseWordAudio()
      void fallbackWordSpeech(pronunciationCard.word, lease, variant)
      resolve()
    }
    audio.play().catch(() => {
      if (lease.isCurrent()) {
        releaseWordAudio()
        void fallbackWordSpeech(pronunciationCard.word, lease, variant)
      }
      resolve()
    })
  })
}

/**
 * 词典音频无法播放时按当前语音偏好回退 TTS，并监听自然结束。
 * @param word 待朗读的英文单词。
 * @param lease 当前单词播放会话租约。
 * @param variant 当前点击的音标变体；用于选择口音和 IPA。
 * @returns 播放启动完成后的 Promise。
 * @author zhenghq
 */
async function fallbackWordSpeech(
  word: string,
  lease: PronunciationPlaybackLease,
  variant?: PronunciationVariant
): Promise<void> {
  const started = await startPronunciationSpeechFallback(word, {
    speechProvider: currentSettings?.speechProvider,
    variant,
    edge: edgeSpeechController,
    system: systemSpeechController
  })
  if (!lease.isCurrent()) return
  if (started.status === 'failed') {
    pronunciationPlayback.stop()
    return
  }
  const timer = window.setInterval(() => {
    if (!lease.isCurrent()) {
      window.clearInterval(timer)
      return
    }
    if (!isSpeechPlaying()) {
      window.clearInterval(timer)
      finishPronunciationPlayback('word', lease)
    }
  }, 150)
}

/**
 * 根据统一播放目标切换对应入口。
 * @param target 译文、原文或单词播放目标。
 * @returns 无返回值。
 * @author zhenghq
 */
function togglePronunciationPlayback(
  target: PronunciationPlaybackTarget,
  variantId?: string
): void {
  if (target === 'translation') {
    void toggleSpeech()
  } else if (target === 'source') {
    toggleSourcePlayback()
  } else {
    void toggleWordPlayback(variantId)
  }
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
  if (payload.requestId !== undefined) latestSelectionRequestId = payload.requestId
  currentSelectionOrigin = payload.origin ?? 'selection'
  sourceSectionHeadEl.hidden = payload.origin === 'ocr'
  if (payload.origin !== 'ocr' && payload.original !== undefined) {
    if (lastOriginal !== payload.original) {
      stopPronunciationPlayback()
      closePronunciation()
    }
    lastOriginal = payload.original
  }
  if (payload.origin === 'ocr') {
    const ocrText = payload.ocrText ?? payload.ocrRawText
    if (ocrText) lastOcrText = ocrText
  }
  if (payload.loading) {
    closePronunciation()
    stopProgressiveReveal()
    selectionReveal = createProgressiveRevealState()
    lastTranslation = ''
    selectionSpeechLanguage = ''
    selectionProvider = undefined
    selectionSourceLangCode = null
    selectionOriginalSpeechLanguage = 'auto'
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
    if (payload.origin !== 'ocr' && payload.original !== undefined) {
      renderOriginalPronunciation(payload.original)
    }
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
    closePronunciation()
    // 首个安全片段已经展示后当前通道失败：保留已揭示内容并提示重试，
    // 不得静默清空用户已经看到的译文。
    // 仅当失败属于当前请求且已经展示过安全片段时才保留，避免旧请求错误污染新结果。
    if (payload.requestId !== undefined
      && payload.requestId === selectionRevealRequestId
      && shouldPreservePartialReveal(selectionReveal)) {
      stopProgressiveReveal()
      selectionReveal = settleProgressiveText(selectionReveal)
      renderRevealText('selection')
      copyBtn.hidden = true
      selectionStatus = `${t('popup.translationFailed')}：${payload.error ?? t('common.unknownError')}`
      originalEl.textContent = payload.origin === 'ocr' ? '' : payload.original ?? ''
      if (payload.origin !== 'ocr' && payload.original !== undefined) {
        renderOriginalPronunciation(payload.original)
      }
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
    stopProgressiveReveal()
    selectionReveal = createProgressiveRevealState()
    lastTranslation = ''
    selectionSpeechLanguage = ''
    selectionProvider = undefined
    selectionSourceLangCode = null
    selectionOriginalSpeechLanguage = 'auto'
    selectionTargetLangCode = payload.targetLang ?? ''
    selectionStatus = t('popup.translationFailed')
    if (visible) renderTranslationProviderResult()
    resultEl.textContent = payload.error ?? t('common.unknownError')
    originalEl.textContent = payload.origin === 'ocr' ? '' : payload.original ?? ''
    if (payload.origin !== 'ocr' && payload.original !== undefined) {
      renderOriginalPronunciation(payload.original)
    }
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
  closePronunciation()
  const sourceName = payload.detectedLang
    ? langLabel(payload.detectedLang, localeRuntime.locale)
    : payload.sourceLang === 'auto'
      ? t('popup.autoDetect')
      : langLabel(payload.sourceLang ?? '', localeRuntime.locale)
  const targetName = langLabel(payload.targetLang ?? '', localeRuntime.locale)
  selectionSourceLangCode = payload.detectedLang ?? payload.sourceLang ?? 'auto'
  selectionOriginalSpeechLanguage = payload.detectedLang ?? payload.sourceLang ?? 'auto'
  selectionTargetLangCode = payload.targetLang ?? ''
  selectionProvider = payload.provider
  selectionStatus = `${sourceName} → ${targetName}`
  if (visible) renderTranslationProviderResult(selectionProvider)
  const finalTranslation = payload.translation ?? ''
  lastTranslation = finalTranslation
  selectionSpeechLanguage = payload.targetLang ?? targetLangEl.value
  startProgressiveReveal('selection', finalTranslation, payload.channel === t('translate.channel.cached'))
  originalEl.textContent = payload.origin === 'ocr' ? '' : payload.original ?? ''
  if (payload.origin !== 'ocr' && payload.original !== undefined) {
    renderOriginalPronunciation(payload.original)
  }
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
 * 开始一次渐进展示；先立即显示已揭示前缀，再按计时器推进。
 * @param target 展示目标区域。
 * @param fullText 完整最终译文。
 * @param cached 是否为缓存命中。
 * @returns 无返回值。
 * @author zhenghq
 */
function startProgressiveReveal(target: 'selection' | 'manual', fullText: string, cached = false): void {
  stopProgressiveReveal()
  const state = target === 'selection' ? selectionReveal : manualReveal
  const settled = finalizeProgressiveText(state, fullText, cached)
  if (target === 'selection') selectionReveal = settled
  else manualReveal = settled
  renderRevealText(target)
  revealTarget = target
  const step = Math.max(1, Math.ceil(fullText.length / 400))
  const stepMs = resolveRevealStepMs(fullText.length, cached)
  revealSequence += 1
  const sequence = revealSequence
  const tick = (): void => {
    if (sequence !== revealSequence || revealTarget !== target) return
    const current = target === 'selection' ? selectionReveal : manualReveal
    if (current.visibleLength >= current.fullText.length) {
      revealTimer = null
      renderRevealText(target)
      return
    }
    const next = nextRevealLength(current, step)
    if (target === 'selection') selectionReveal = next
    else manualReveal = next
    renderRevealText(target)
    revealTimer = setTimeout(tick, stepMs)
  }
  revealTimer = setTimeout(tick, stepMs)
}

/**
 * 停止当前渐进展示并递增序号，防止旧计时器继续修改界面。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopProgressiveReveal(): void {
  revealSequence += 1
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  revealTarget = null
}

/**
 * 立即结束当前正在进行的渐进展示，把已确定内容一次性完整揭示。
 * 切换模式或关闭窗口前调用，避免切回时停留在中间态。
 * @returns 无返回值。
 * @author zhenghq
 */
function settleActiveReveal(): void {
  if (revealTarget === 'selection') {
    selectionReveal = settleProgressiveText(selectionReveal)
    renderRevealText('selection')
  } else if (revealTarget === 'manual') {
    manualReveal = settleProgressiveText(manualReveal)
    renderRevealText('manual')
  }
}

/**
 * 将渐进展示状态渲染到对应结果区域。
 * @param target 展示目标区域。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderRevealText(target: 'selection' | 'manual'): void {
  const state = target === 'selection' ? selectionReveal : manualReveal
  const text = state.fullText.slice(0, state.visibleLength)
  const element = target === 'selection' ? resultEl : manualResultEl
  if (
    target === 'selection'
    && state.visibleLength >= state.fullText.length
  ) {
    renderTranslationPronunciation(text)
  } else {
    element.textContent = text
  }
  element.classList.toggle('streaming-cursor', state.visibleLength < state.fullText.length)
  if (target === 'selection') {
    copyBtn.hidden = !text || mode !== 'selection'
    syncSpeechButton()
  } else {
    manualCopyBtn.hidden = !state.fullText || manualState.loading || Boolean(manualState.error) || manualState.stale
    manualCopyBtn.disabled = manualCopyBtn.hidden
    syncSpeechButton()
  }
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
  if (manualSourceEl.value !== manualState.draft) manualSourceEl.value = manualState.draft
  manualCountEl.textContent = `${manualState.draft.length} / ${MANUAL_TRANSLATION_MAX_CHARS}`
  manualClearBtn.disabled = !manualState.draft && !manualState.translation && !manualState.error
  manualSubmitBtn.disabled = !canSubmitManualTranslation(manualState, localeRuntime.translator)
  manualSubmitBtn.textContent = manualState.loading ? t('popup.translating') : t('popup.translate')
  manualResultEl.className = 'manual-result'
  if (manualState.loading) {
    // 流式片段已经到达时继续展示已揭示前缀，避免加载态重渲染清空正在生长的译文。
    if (manualReveal.fullText) {
      renderRevealText('manual')
    } else {
      manualResultEl.classList.add('loading')
      manualResultEl.textContent = t('popup.translating')
    }
  } else if (manualState.error) {
    // 流式片段已经展示后当前请求失败：保留已收到的部分译文，
    // 错误提示继续由状态行展示，避免整段译文被错误文本替换。
    if (shouldPreservePartialReveal(manualReveal)) {
      manualReveal = settleProgressiveText(manualReveal)
      renderRevealText('manual')
    } else {
      manualResultEl.classList.add('error')
      manualResultEl.textContent = manualState.error
    }
  } else if (manualState.translation) {
    if (manualReveal.fullText !== manualState.translation) {
      startProgressiveReveal('manual', manualState.translation)
    } else {
      renderRevealText('manual')
    }
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
  // 流式展示期间最终译文尚未写回 lastTranslation/manualState.translation，
  // 宽度测量必须纳入当前已揭示的译文前缀，否则窗口宽度只会等全部返回后才变化。
  const selectionRevealText = selectionReveal.fullText.slice(0, selectionReveal.visibleLength)
  const manualRevealText = manualReveal.fullText.slice(0, manualReveal.visibleLength)
  const sourceTexts = mode === 'manual'
    ? [manualState.draft, manualState.translation ?? '', manualRevealText]
    : [lastOriginal, lastTranslation, lastOcrText, selectionRevealText]
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
 * 内容变化时测量并上报自适应尺寸。
 *
 * 使用节流（而非去抖）调度：流式打字机每 16ms 就触发一次尺寸请求，去抖会
 * 被持续重置导致回调被无限推迟，只有流式结束才真正测量一次。节流保证在
 * 流式过程中按固定间隔周期性测量，窗口随内容增长平滑变大。
 * @returns 无返回值。
 * @author zhenghq
 */
const requestAutoResize = createThrottledScheduler((): void => {
  const size = measureAutoSize()
  if (size.width === lastRequestedAutoSize.width && size.height === lastRequestedAutoSize.height) return
  lastRequestedAutoSize = size
  window.api.resizePopup(size)
}, 60)

/**
 * 进入手动模式并请求主进程固定弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
function enterManualMode(): void {
  stopPronunciationPlayback()
  closePronunciation()
  stopSpeech()
  settleActiveReveal()
  stopProgressiveReveal()
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
  stopPronunciationPlayback()
  closePronunciation()
  stopSpeech()
  settleActiveReveal()
  stopProgressiveReveal()
  mode = 'selection'
  renderMode()
}

/**
 * 响应主进程手动打开通知并把焦点放到原文输入框。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleManualOpen(): void {
  stopPronunciationPlayback()
  closePronunciation()
  stopSpeech()
  mode = 'manual'
  renderMode()
  manualSourceEl.focus()
  manualSourceEl.setSelectionRange(manualSourceEl.value.length, manualSourceEl.value.length)
}

/**
 * 响应主进程划词 / OCR 打开通知，把界面切回划词视图。
 *
 * 手动模式不会因划词流程自动退出：用户可能先在手动翻译里输入了内容，
 * 再按划词快捷键。此时必须显式切回划词视图，否则翻译负载虽已到达，
 * 界面仍停留在手动输入区，表现为「划词快捷键打开的依旧是手动翻译」。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionOpen(): void {
  if (mode === 'selection') return
  stopPronunciationPlayback()
  closePronunciation()
  stopSpeech()
  settleActiveReveal()
  stopProgressiveReveal()
  mode = 'selection'
  renderMode()
}

/**
 * 响应主进程完成弹窗隐藏的通知，清理所有可能脱离界面的播放资源。
 *
 * 弹窗也可能因失焦、外部点击或自动隐藏关闭，这些路径不会执行关闭按钮，
 * 因此必须在这里统一停止系统语音、Edge 音频和词典音频。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupHidden(): void {
  stopPronunciationPlayback()
  closePronunciation()
  stopSpeech()
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
  manualSpeechLanguage = ''
  // 新请求必须丢弃上一次的流式累积与打字机状态，避免旧译文被追加到新结果前。
  stopProgressiveReveal()
  manualReveal = createProgressiveRevealState()
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
  stopPronunciationPlayback()
  closePronunciation()
  stopSpeech()
  settleActiveReveal()
  stopProgressiveReveal()
  window.api.hide()
}

/**
 * 处理手动原文输入框的键盘操作：Enter 直接提交，Shift+Enter 等仍保留换行。
 *
 * 手动翻译全程使用键盘输入，用户输完后顺手按回车是最自然的提交方式；
 * 要求移动鼠标去点翻译按钮会打断输入节奏。带修饰键的组合也一并支持，
 * 方便习惯 ⌘/Ctrl + Enter 的用户。
 * @param event 当前键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleManualSourceKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  // 修饰键组合交给通用快捷键处理，避免与浏览器 / 系统快捷键抢键。
  if (event.metaKey || event.ctrlKey) {
    if (document.activeElement === manualSourceEl) {
      event.preventDefault()
      void submitManualTranslation()
    }
    return
  }
  // Shift + Enter 退化为换行，其余组合键同样保留默认行为。
  if (event.shiftKey || event.altKey) return
  event.preventDefault()
  void submitManualTranslation()
}

/**
 * 处理弹窗级 Escape 关闭。
 * @param event 当前键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closePopup()
    return
  }
}

window.api.onResult((payload) => {
  if (payload.origin === 'manual') {
    const manualVisible = mode === 'manual'
    if (payload.original !== undefined && payload.loading && payload.original !== manualState.submittedText) return
    if (payload.loading) {
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
      manualSpeechLanguage = ''
      if (payload.requestId !== undefined) manualState = { ...manualState, requestId: payload.requestId }
      manualState = failManualTranslation(
        manualState,
        manualState.requestId,
        payload.error ?? t('popup.translationFailed')
      )
      manualStatus = t('popup.translationFailed')
      manualProvider = undefined
      manualSourceLangCode = null
      manualTargetLangCode = payload.targetLang ?? ''
      manualStatus = t('popup.translationFailed')
      if (manualVisible) statusEl.textContent = t('popup.translationFailed')
    } else {
      if (payload.requestId !== undefined && payload.requestId !== manualState.requestId) return
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

/**
 * 处理主进程推送的流式翻译增量，将安全片段追加到对应渐进展示状态。
 * @param payload 流式增量负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTranslateDelta(payload: TranslateDeltaPayload): void {
  if (payload.origin === 'manual') {
    if (payload.requestId !== manualState.requestId) return
    if (!manualState.loading) return
    if (manualReveal.fullText.length === 0) {
      stopProgressiveReveal()
      manualReveal = createProgressiveRevealState()
      manualState = { ...manualState, translation: '', error: '' }
      renderManualState()
      revealTarget = 'manual'
      revealSequence += 1
    }
    manualReveal = appendProgressiveText(manualReveal, payload.delta)
    scheduleStreamingReveal('manual')
    return
  }
  if (payload.requestId !== latestSelectionRequestId) return
  if (selectionReveal.fullText.length === 0) {
    stopProgressiveReveal()
    selectionReveal = createProgressiveRevealState()
    selectionRevealRequestId = payload.requestId
    resultEl.classList.remove('loading')
    revealTarget = 'selection'
    revealSequence += 1
  }
  selectionReveal = appendProgressiveText(selectionReveal, payload.delta)
  scheduleStreamingReveal('selection')
}

/**
 * 为流式片段安排下一帧渐进揭示，避免高频片段直接抖动界面。
 * @param target 展示目标区域。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleStreamingReveal(target: 'selection' | 'manual'): void {
  if (revealTarget !== target || revealTimer !== null) return
  const sequence = revealSequence
  const tick = (): void => {
    if (sequence !== revealSequence || revealTarget !== target) return
    const current = target === 'selection' ? selectionReveal : manualReveal
    if (current.visibleLength >= current.fullText.length) {
      revealTimer = null
      renderRevealText(target)
      return
    }
    const next = nextRevealLength(current, 1)
    if (target === 'selection') selectionReveal = next
    else manualReveal = next
    renderRevealText(target)
    revealTimer = setTimeout(tick, 16)
  }
  revealTimer = setTimeout(tick, 16)
}

/** 最近一次划词翻译请求序号，用于丢弃迟到增量。 */
let latestSelectionRequestId = 0

sourceLangEl.addEventListener('change', () => void retranslateWithCurrentLanguages())
targetLangEl.addEventListener('change', () => void retranslateWithCurrentLanguages())
translationProviderEl.addEventListener('change', () => void changeTranslationProvider())
manualModeBtn.addEventListener('click', () => mode === 'manual' ? leaveManualMode() : enterManualMode())
speakBtn.addEventListener('click', () => togglePronunciationPlayback('translation'))
readOriginalBtn.addEventListener('click', () => togglePronunciationPlayback('source'))
pronunciationCloseBtn.addEventListener('click', closePronunciation)
pronunciationVariantsEl.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const play = event.target.closest('.pronunciation-play')
  if (!(play instanceof HTMLElement)) return
  const variantId = play.dataset.variantId
  if (variantId) {
    togglePronunciationPlayback('word', variantId)
  } else {
    togglePronunciationPlayback('word')
  }
})
originalEl.addEventListener('pointerdown', handleOriginalPointerDown)
originalEl.addEventListener('pointerup', handleOriginalPointerUp)
originalEl.addEventListener('click', handleOriginalClick)
originalEl.addEventListener('dblclick', () => originalClickGate.doubleClick())
resultEl.addEventListener('pointerdown', handleTranslationPointerDown)
resultEl.addEventListener('pointerup', handleTranslationPointerUp)
resultEl.addEventListener('click', handleTranslationClick)
resultEl.addEventListener('dblclick', () => translationClickGate.doubleClick())
manualSourceEl.addEventListener('input', () => {
  manualState = updateManualDraft(manualState, manualSourceEl.value)
  renderManualState()
})
manualClearBtn.addEventListener('click', () => {
  stopSpeech()
  manualSpeechLanguage = ''
  // 清空原文即取消当前会话，停止旧打字机并丢弃其累积状态。
  stopProgressiveReveal()
  manualReveal = createProgressiveRevealState()
  manualState = clearManualTranslation(manualState)
  renderManualState()
  manualSourceEl.focus()
})
manualSubmitBtn.addEventListener('click', () => void submitManualTranslation())
manualSourceEl.addEventListener('keydown', handleManualSourceKeydown)
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
window.api.onSelectionMode(handleSelectionOpen)
window.api.onTranslateDelta(handleTranslateDelta)
window.api.onPinnedChanged(renderPinnedState)
window.api.onPopupHidden(handlePopupHidden)
window.api.onSettingsChanged(syncSettings)
localeRuntime.onLocaleChanged(handleLocaleChanged)
if ('speechSynthesis' in window) {
  window.speechSynthesis.addEventListener('voiceschanged', syncSpeechButton)
}
renderPinnedState(false)
renderMode()
syncSpeechButton()
void initializeSelectors()
