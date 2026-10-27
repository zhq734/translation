const DEFAULT_MAX_CHUNK_LENGTH = 240

const SPEECH_VOICE_QUALITY_KEYWORDS = [
  'natural',
  'neural',
  'premium',
  'enhanced',
  'advanced',
  '自然',
  '神经',
  '高级',
  '增强'
] as const

const PREFERRED_SPEECH_VOICE_NAMES: Readonly<Record<string, readonly string[]>> = {
  de: ['anna', 'microsoft katja', 'katja', 'microsoft hedda', 'hedda'],
  en: ['samantha', 'microsoft zira', 'zira', 'ava'],
  es: ['monica', 'microsoft elvira', 'elvira', 'microsoft helena', 'helena'],
  fr: ['audrey', 'amelie', 'microsoft denise', 'denise', 'microsoft hortense', 'hortense'],
  it: ['alice', 'microsoft elsa', 'elsa'],
  ja: ['kyoko', 'microsoft nanami', 'nanami', 'microsoft haruka', 'haruka'],
  ko: ['yuna', 'microsoft sunhi', 'sunhi', 'microsoft heami', 'heami'],
  pt: ['luciana', 'microsoft francisca', 'francisca', 'microsoft maria', 'maria'],
  zh: ['microsoft xiaoxiao', 'xiaoxiao', 'meijia', 'tingting', 'microsoft huihui', 'huihui']
}

const REGION_AGNOSTIC_PREFERRED_LANGUAGES = new Set(['zh'])

const LOW_FIDELITY_ENGLISH_VOICE_NAMES = new Set([
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'fred',
  'good news',
  'jester',
  'junior',
  'organ',
  'ralph',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox'
])

const DEFAULT_SPEECH_VOLUME = 1
const DEFAULT_SPEECH_PITCH = 1
const DEFAULT_SPEECH_RATE = 1

const SPEECH_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  AR: 'ar-SA',
  BG: 'bg-BG',
  CS: 'cs-CZ',
  DA: 'da-DK',
  DE: 'de-DE',
  EL: 'el-GR',
  EN: 'en-US',
  ES: 'es-ES',
  ET: 'et-EE',
  FI: 'fi-FI',
  FR: 'fr-FR',
  HU: 'hu-HU',
  ID: 'id-ID',
  IT: 'it-IT',
  JA: 'ja-JP',
  KO: 'ko-KR',
  LT: 'lt-LT',
  LV: 'lv-LV',
  NL: 'nl-NL',
  PL: 'pl-PL',
  PT: 'pt-BR',
  RO: 'ro-RO',
  RU: 'ru-RU',
  SK: 'sk-SK',
  SL: 'sl-SI',
  SV: 'sv-SE',
  TR: 'tr-TR',
  UK: 'uk-UA',
  ZH: 'zh-CN'
}

export interface SpeechUtteranceLike {
  text: string
  lang: string
  voice: SpeechSynthesisVoice | null
  volume?: number
  pitch?: number
  rate?: number
  onend: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

export interface SpeechSynthesisLike {
  /** 播放一个语音片段。 */
  speak(utterance: SpeechUtteranceLike): void
  /** 取消当前语音及后续队列。 */
  cancel(): void
  /** 返回当前系统语音列表。 */
  getVoices(): SpeechSynthesisVoice[]
}

export interface SpeechController {
  /** 开始播放指定文本。 */
  start(text: string, language: string): SpeechStartResult
  /** 停止当前播放会话。 */
  stop(): void
  /** 判断当前环境是否存在目标语言对应的系统语音。 */
  canSpeak(language: string): boolean
  /** 返回当前是否正在播放。 */
  isSpeaking(): boolean
}

export interface SpeechStartResult {
  ok: boolean
  error?: string
}

/** 带实际朗读语言的一段文本。 */
export interface SpeechSegment {
  text: string
  language: string
}

interface SpeechControllerOptions {
  synthesis: SpeechSynthesisLike | null
  createUtterance(text: string): SpeechUtteranceLike
  /** 解析当前界面语言下的用户可见文案；缺省时回退英文。 */
  getMessage?(key: string, params?: Record<string, string | number>): string
  maxChunkLength?: number
  onSpeakingChange?(speaking: boolean): void
  onComplete?(): void
  onError?(message: string): void
}

/**
 * 将项目语言代码转换为常用的 BCP 47 语音语言代码。
 * @param language 项目语言代码或已经规范化的语音语言代码。
 * @returns 可用于语音合成的语言代码，未知语言返回原值。
 * @author zhenghq
 */
export function languageToSpeechCode(language: string): string {
  const normalized = language.trim()
  if (!normalized || normalized.toLowerCase() === 'auto') return ''
  return SPEECH_LANGUAGE_CODES[normalized.toUpperCase()] ?? normalized
}

/**
 * 解析实际朗读语言；明确语言保持不变，自动检测时按文本脚本推断主要语言。
 * @param text 待朗读文本。
 * @param language 翻译结果提供的源语言或目标语言。
 * @returns 可用于 Edge 和系统语音的稳定语言代码。
 * @author zhenghq
 */
export function resolveSpeechLanguage(text: string, language: string): string {
  const explicitLanguage = language.trim()
  if (explicitLanguage && explicitLanguage.toLowerCase() !== 'auto') return explicitLanguage

  const normalizedText = text.trim()
  if (!normalizedText) return explicitLanguage || 'auto'
  if (/[\u3040-\u30ff\u31f0-\u31ff]/u.test(normalizedText)) return 'JA'
  if (/[\uac00-\ud7af\u1100-\u11ff]/u.test(normalizedText)) return 'KO'
  if (/[\u0400-\u04ff]/u.test(normalizedText)) return 'RU'

  const hanCount = (normalizedText.match(/[\u3400-\u9fff]/gu) ?? []).length
  const latinCount = (normalizedText.match(/[A-Za-z]/gu) ?? []).length
  if (hanCount > 0 && hanCount >= latinCount) return 'ZH'
  if (/[\u0600-\u06ff]/u.test(normalizedText)) return 'AR'
  if (/[\u0370-\u03ff]/u.test(normalizedText)) return 'EL'
  if (latinCount > 0) return 'EN'
  if (hanCount > 0) return 'ZH'
  return 'auto'
}

/**
 * 判断单个字符属于中文或英文的强脚本字符。
 * @param character 待判断的单个字符。
 * @returns 中文返回 ZH，拉丁字母返回 EN，标点、空白和数字返回 null。
 * @author zhenghq
 */
function speechScriptForCharacter(character: string): 'ZH' | 'EN' | null {
  if (/\p{Script=Han}/u.test(character)) return 'ZH'
  if (/\p{Script=Latin}/u.test(character)) return 'EN'
  return null
}

/**
 * 将中英文混排文本切成连续脚本片段，标点和空白跟随其前一个片段。
 * @param text 已清理首尾空白的待朗读文本。
 * @returns 保持原顺序和完整字符的脚本片段。
 * @author zhenghq
 */
function splitBilingualSpeechText(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  let current: SpeechSegment | null = null
  let pendingNeutralText = ''

  for (const character of text) {
    const script = speechScriptForCharacter(character)
    if (!script) {
      if (current) {
        current.text += character
      } else {
        pendingNeutralText += character
      }
      continue
    }
    if (current && current.language === script) {
      current.text += character
      continue
    }
    current = { text: `${pendingNeutralText}${character}`, language: script }
    pendingNeutralText = ''
    segments.push(current)
  }

  if (segments.length === 0) return [{ text, language: 'auto' }]
  return segments
}

/**
 * 按实际语言切分朗读文本；中英文混排时为每个脚本片段选择对应语言。
 * @param text 待朗读文本。
 * @param language 翻译结果提供的源语言或目标语言。
 * @param maxLength 单个语音片段最大字符数。
 * @returns 带语言信息且保持原顺序的语音片段。
 * @author zhenghq
 */
export function splitSpeechSegments(
  text: string,
  language: string,
  maxLength = DEFAULT_MAX_CHUNK_LENGTH
): SpeechSegment[] {
  const normalizedText = text.trim()
  if (!normalizedText) return []
  const resolvedLanguage = resolveSpeechLanguage(normalizedText, language)
  const speechPrefix = languageToSpeechCode(resolvedLanguage).split('-')[0].toLowerCase()
  if (speechPrefix !== 'zh' && speechPrefix !== 'en') {
    return [{ text: normalizedText, language: resolvedLanguage }]
  }

  const scriptSegments = splitBilingualSpeechText(normalizedText)
  const hasFragmentedLanguageSwitch = scriptSegments.some((segment, index) => {
    const previous = scriptSegments[index - 1]
    const next = scriptSegments[index + 1]
    const trimmed = segment.text.trim()
    return segment.language === 'EN'
      && previous?.language === 'ZH'
      && next?.language === 'ZH'
      && /^[A-Za-z]+$/u.test(trimmed)
      && trimmed.length <= 8
      && previous.text.trim().length <= 3
      && next.text.trim().length <= 3
  })
  // 极短混排拆成多次请求会产生明显停顿和音色跳变，交给同一音色连续朗读更自然。
  const shouldUseSingleVoice = scriptSegments.length >= 3
    && normalizedText.length <= 16
    && hasFragmentedLanguageSwitch
    && !scriptSegments.some((segment) => (
      segment.language !== (speechPrefix === 'zh' ? 'ZH' : 'EN')
        && segment.text.trim().length > 8
    ))
  if (shouldUseSingleVoice) return [{ text: normalizedText, language: resolvedLanguage }]
  const hasChinese = scriptSegments.some((segment) => segment.language === 'ZH')
  const hasEnglish = scriptSegments.some((segment) => segment.language === 'EN')
  const chineseLanguage = speechPrefix === 'zh'
    ? resolvedLanguage
    : hasEnglish ? 'ZH' : resolvedLanguage
  const englishLanguage = speechPrefix === 'en'
    ? resolvedLanguage
    : hasChinese ? 'EN' : resolvedLanguage
  const safeMaxLength = Math.max(1, Math.floor(maxLength))
  return scriptSegments.flatMap((segment) => {
    const segmentLanguage = segment.language === 'ZH'
      ? chineseLanguage
      : segment.language === 'EN' ? englishLanguage : resolvedLanguage
    return splitSpeechChunkPreservingEdges(segment.text, safeMaxLength).map((chunk) => ({
      text: chunk,
      language: segmentLanguage
    }))
  })
}

/**
 * 按句和长度切分 Edge 朗读文本，并让所有片段固定使用同一个主音色语言。
 * @param text 待朗读文本。
 * @param language 翻译结果提供的源语言或目标语言。
 * @param maxLength 单个语音片段最大字符数。
 * @returns 保持原顺序且语言一致的语音片段。
 * @author zhenghq
 */
export function splitSpeechSegmentsWithSingleVoice(
  text: string,
  language: string,
  maxLength = DEFAULT_MAX_CHUNK_LENGTH
): SpeechSegment[] {
  const normalizedText = text.trim()
  if (!normalizedText) return []
  const resolvedLanguage = resolveSpeechLanguage(normalizedText, language)
  return splitSpeechText(normalizedText, maxLength).map((chunk) => ({
    text: chunk,
    language: resolvedLanguage
  }))
}

/**
 * 按最大长度切分脚本片段，同时保留首尾空白以维持原文本完整顺序。
 * @param text 待切分的脚本片段。
 * @param maxLength 单个片段允许的最大字符数。
 * @returns 保持原文顺序和首尾空白的片段。
 * @author zhenghq
 */
function splitSpeechChunkPreservingEdges(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maxLength)
    if (end < text.length) {
      const candidate = text.slice(offset, end + 1)
      const whitespaceIndex = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\t'))
      if (whitespaceIndex > 0 && whitespaceIndex <= maxLength) end = offset + whitespaceIndex + 1
    }
    const chunk = text.slice(offset, end)
    if (chunk) chunks.push(chunk)
    offset = end
  }
  return chunks
}

/**
 * 规范化系统语音名称，便于跨平台匹配固定首选音色。
 * @param name 系统返回的语音名称。
 * @returns 转换为小写并移除重音符号后的名称。
 * @author zhenghq
 */
function normalizeSpeechVoiceName(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase()
}

/**
 * 判断语音是否属于已知低保真的英文实验音色。
 * @param voice 待检查的系统语音。
 * @returns 属于英文实验音色时返回 true，否则返回 false。
 * @author zhenghq
 */
function isLowFidelityEnglishVoice(voice: SpeechSynthesisVoice): boolean {
  const languagePrefix = voice.lang.toLowerCase().split('-')[0]
  return languagePrefix === 'en'
    && LOW_FIDELITY_ENGLISH_VOICE_NAMES.has(normalizeSpeechVoiceName(voice.name))
}

/**
 * 判断语音名称是否带有增强质量标签。
 * @param voice 待检查的系统语音。
 * @returns 名称包含增强质量标签时返回 true，否则返回 false。
 * @author zhenghq
 */
function hasSpeechVoiceQualityLabel(voice: SpeechSynthesisVoice): boolean {
  const name = normalizeSpeechVoiceName(voice.name)
  return SPEECH_VOICE_QUALITY_KEYWORDS.some((keyword) => name.includes(keyword))
}

/**
 * 按固定规则从同一音色族中选择一个稳定版本。
 * @param voices 同一音色族或同一回退等级的候选语音。
 * @param preferEnhanced 是否优先选择该音色的增强版本。
 * @returns 排序后的首个稳定候选；候选为空时返回 null。
 * @author zhenghq
 */
function selectStableSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferEnhanced: boolean
): SpeechSynthesisVoice | null {
  return [...voices].sort((left, right) => {
    if (preferEnhanced) {
      const qualityDifference = Number(hasSpeechVoiceQualityLabel(right))
        - Number(hasSpeechVoiceQualityLabel(left))
      if (qualityDifference !== 0) return qualityDifference
    }
    const localDifference = Number(Boolean(right.localService)) - Number(Boolean(left.localService))
    if (localDifference !== 0) return localDifference
    const defaultDifference = Number(Boolean(right.default)) - Number(Boolean(left.default))
    if (defaultDifference !== 0) return defaultDifference
    const leftName = normalizeSpeechVoiceName(left.name)
    const rightName = normalizeSpeechVoiceName(right.name)
    if (leftName < rightName) return -1
    if (leftName > rightName) return 1
    const leftLanguage = left.lang.toLowerCase()
    const rightLanguage = right.lang.toLowerCase()
    if (leftLanguage < rightLanguage) return -1
    if (leftLanguage > rightLanguage) return 1
    return 0
  })[0] ?? null
}

/**
 * 从候选语音中按照固定名称映射选择稳定音色，缺失时再使用普通语音回退。
 * @param voices 候选系统语音。
 * @param languagePrefix 当前目标语言前缀。
 * @returns 固定首选或稳定回退语音；候选为空时返回 null。
 * @author zhenghq
 */
function selectPreferredSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  languagePrefix: string
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const namedPreferredVoice = findNamedPreferredSpeechVoice(voices, languagePrefix)
  if (namedPreferredVoice) return namedPreferredVoice

  const safeVoices = voices.filter((voice) => !isLowFidelityEnglishVoice(voice))
  const ordinaryVoices = safeVoices.filter((voice) => !hasSpeechVoiceQualityLabel(voice))
  return selectStableSpeechVoice(ordinaryVoices, false)
    ?? selectStableSpeechVoice(safeVoices, false)
    ?? selectStableSpeechVoice(voices, false)
}

/**
 * 从候选语音中查找固定名称的首选音色，不执行普通语音回退。
 * @param voices 候选系统语音。
 * @param languagePrefix 当前目标语言前缀。
 * @returns 找到固定首选音色时返回该语音，否则返回 null。
 * @author zhenghq
 */
function findNamedPreferredSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  languagePrefix: string
): SpeechSynthesisVoice | null {
  const preferredNames = PREFERRED_SPEECH_VOICE_NAMES[languagePrefix] ?? []
  for (const preferredName of preferredNames) {
    const matched = voices.filter((voice) => (
      normalizeSpeechVoiceName(voice.name).includes(preferredName)
    ))
    const stablePreferredVoice = selectStableSpeechVoice(matched, true)
    if (stablePreferredVoice) return stablePreferredVoice
  }
  return null
}

/**
 * 根据目标语言从系统语音列表中选择最匹配的语音。
 * @param voices 当前系统可用语音。
 * @param language 项目目标语言或 BCP 47 语言代码。
 * @returns 完整代码、语言前缀或系统默认语音，无法匹配时返回 null。
 * @author zhenghq
 */
export function findSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: string
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const speechCode = languageToSpeechCode(language).toLowerCase()
  if (!speechCode) {
    const defaultVoices = voices.filter((voice) => voice.default)
    return selectPreferredSpeechVoice(defaultVoices, '')
  }
  const languagePrefix = speechCode.split('-')[0]
  const prefixMatches = voices.filter(
    (voice) => voice.lang.toLowerCase().split('-')[0] === languagePrefix
  )
  if (REGION_AGNOSTIC_PREFERRED_LANGUAGES.has(languagePrefix)) {
    const regionAgnosticPreferredVoice = findNamedPreferredSpeechVoice(prefixMatches, languagePrefix)
    if (regionAgnosticPreferredVoice) return regionAgnosticPreferredVoice
  }
  const exact = voices.filter((voice) => voice.lang.toLowerCase() === speechCode)
  if (exact.length > 0) return selectPreferredSpeechVoice(exact, languagePrefix)
  return selectPreferredSpeechVoice(prefixMatches, languagePrefix)
    ?? selectPreferredSpeechVoice(voices.filter((voice) => voice.default), '')
}

/**
 * 把单个过长语音片段切分到最大长度以内，优先在空白处分割。
 * @param text 待切分的语音片段。
 * @param maxLength 单个片段允许的最大字符数。
 * @returns 顺序保持不变的非空片段。
 * @author zhenghq
 */
function splitLongSpeechChunk(text: string, maxLength: number): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1)
    const whitespaceIndex = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\t'))
    const punctuationIndex = candidate.search(/[。！？.!?]/u)
    const cutIndex = whitespaceIndex > 0
      ? whitespaceIndex
      : punctuationIndex >= maxLength
        ? punctuationIndex + 1
        : maxLength
    const chunk = remaining.slice(0, cutIndex).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(cutIndex).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/**
 * 按换行和中英文句末标点拆分朗读文本，并限制单段长度。
 * @param text 待朗读文本。
 * @param maxLength 单个语音片段最大字符数。
 * @returns 已清理空白且保持原顺序的语音片段。
 * @author zhenghq
 */
export function splitSpeechText(
  text: string,
  maxLength = DEFAULT_MAX_CHUNK_LENGTH
): string[] {
  const safeMaxLength = Math.max(1, Math.floor(maxLength))
  const sentenceChunks = text
    .replace(/\r\n?/gu, '\n')
    .split(/(?<=[。！？.!?])|\n+/gu)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
  return sentenceChunks.flatMap((chunk) => splitLongSpeechChunk(chunk, safeMaxLength))
}

/**
 * 创建可注入浏览器语音实现的播放控制器。
 * @param options 语音引擎、语音片段工厂和状态回调。
 * @returns 支持开始、停止和状态查询的语音控制器。
 * @author zhenghq
 */
export function createSpeechController(options: SpeechControllerOptions): SpeechController {
  /**
   * 解析当前界面语言下的用户可见文案。
   * @param key 语义化词条 key。
   * @returns 当前界面语言下的文案。
   * @author zhenghq
   */
  const message = (key: string): string => options.getMessage?.(key) ?? key

  let speaking = false
  let sessionId = 0

  /**
   * 更新播放状态并通知界面。
   * @param value 最新播放状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  function setSpeaking(value: boolean): void {
    if (speaking === value) return
    speaking = value
    options.onSpeakingChange?.(value)
  }

  /**
   * 以错误状态结束指定播放会话。
   * @param currentSession 当前回调所属会话序号。
   * @param message 面向用户的错误提示。
   * @returns 无返回值。
   * @author zhenghq
   */
  function failSession(currentSession: number, message: string): void {
    if (currentSession !== sessionId) return
    sessionId += 1
    setSpeaking(false)
    options.onError?.(message)
  }

  /**
   * 判断语音引擎是否支持指定语言，并安全处理语音列表读取异常。
   * @param language 项目目标语言或 BCP 47 语言代码。
   * @returns 存在可匹配语音时返回 true，否则返回 false。
   * @author zhenghq
   */
  function canSpeak(language: string): boolean {
    if (!options.synthesis) return false
    try {
      return findSpeechVoice(options.synthesis.getVoices(), language) !== null
    } catch {
      return false
    }
  }

  return {
    /**
     * 开始播放文本；新会话会替换当前播放会话。
     * @param text 待朗读译文。
     * @param language 译文目标语言。
     * @returns 播放是否成功启动及可选错误信息。
     * @author zhenghq
     */
    start(text: string, language: string): SpeechStartResult {
      const normalizedText = text.trim()
      if (!normalizedText) return { ok: false, error: message('rendererSpeech.error.noText') }
      if (!options.synthesis) {
        const error = message('rendererSpeech.error.unsupported')
        options.onError?.(error)
        return { ok: false, error }
      }

      let voices: SpeechSynthesisVoice[]
      try {
        voices = options.synthesis.getVoices()
      } catch {
        const error = message('rendererSpeech.error.voiceListFailed')
        options.onError?.(error)
        return { ok: false, error }
      }
      const resolvedLanguage = resolveSpeechLanguage(normalizedText, language)
      const fallbackVoice = findSpeechVoice(voices, resolvedLanguage)
      if (!fallbackVoice) {
        const error = message('rendererSpeech.error.noVoice')
        options.onError?.(error)
        return { ok: false, error }
      }
      const defaultVoice: SpeechSynthesisVoice = fallbackVoice
      const chunks = splitSpeechSegments(normalizedText, resolvedLanguage, options.maxChunkLength)
      if (chunks.length === 0) return { ok: false, error: message('rendererSpeech.error.noText') }

      const currentSession = ++sessionId
      const voicesByLanguage = new Map<string, SpeechSynthesisVoice>([
        [resolvedLanguage, defaultVoice]
      ])
      if (speaking) {
        try {
          options.synthesis.cancel()
        } catch {
          const error = message('rendererSpeech.error.playFailed')
          failSession(currentSession, error)
          return { ok: false, error }
        }
      }
      setSpeaking(true)

      /**
       * 播放当前会话中的指定片段。
       * @param index 待播放片段索引。
       * @returns 无返回值。
       * @author zhenghq
       */
      function playChunk(index: number): void {
        if (currentSession !== sessionId) return
        if (index >= chunks.length) {
          sessionId += 1
          setSpeaking(false)
          options.onComplete?.()
          return
        }
        let utterance: SpeechUtteranceLike
        try {
          const chunk = chunks[index]
          const cachedVoice = voicesByLanguage.get(chunk.language)
          const matchedVoice = findSpeechVoice(voices, chunk.language)
          let voice: SpeechSynthesisVoice
          if (cachedVoice) {
            voice = cachedVoice
          } else if (matchedVoice) {
            voice = matchedVoice
            voicesByLanguage.set(chunk.language, voice)
          } else {
            voice = defaultVoice
            voicesByLanguage.set(chunk.language, voice)
          }
          const requestedSpeechCode = languageToSpeechCode(chunk.language)
          const requestedPrefix = requestedSpeechCode.split('-')[0].toLowerCase()
          const voicePrefix = voice.lang.toLowerCase().split('-')[0]
          const speechCode = requestedPrefix && requestedPrefix === voicePrefix
            ? requestedSpeechCode
            : voice.lang
          utterance = options.createUtterance(chunk.text)
          utterance.lang = speechCode
          utterance.voice = voice
          utterance.volume = DEFAULT_SPEECH_VOLUME
          utterance.pitch = DEFAULT_SPEECH_PITCH
          utterance.rate = DEFAULT_SPEECH_RATE
          utterance.onend = () => playChunk(index + 1)
          utterance.onerror = () => failSession(currentSession, message('rendererSpeech.error.playFailed'))
          options.synthesis?.speak(utterance)
        } catch {
          failSession(currentSession, message('rendererSpeech.error.playFailed'))
        }
      }

      playChunk(0)
      return { ok: true }
    },

    /**
     * 停止当前语音队列并使旧回调失效。
     * @returns 无返回值。
     * @author zhenghq
     */
    stop(): void {
      sessionId += 1
      try {
        options.synthesis?.cancel()
      } finally {
        setSpeaking(false)
      }
    },

    /**
     * 判断当前环境是否存在目标语言对应的系统语音。
     * @param language 项目目标语言或 BCP 47 语言代码。
     * @returns 存在可用语音时返回 true，否则返回 false。
     * @author zhenghq
     */
    canSpeak,

    /**
     * 返回控制器当前是否处于播放状态。
     * @returns 当前播放状态。
     * @author zhenghq
     */
    isSpeaking(): boolean {
      return speaking
    }
  }
}
