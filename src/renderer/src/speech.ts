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
const DEFAULT_SPEECH_RATE = 0.9

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

interface SpeechControllerOptions {
  synthesis: SpeechSynthesisLike | null
  createUtterance(text: string): SpeechUtteranceLike
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
      if (!normalizedText) return { ok: false, error: '暂无可朗读的译文' }
      if (!options.synthesis) {
        const error = '当前环境不支持语音播放'
        options.onError?.(error)
        return { ok: false, error }
      }

      let voices: SpeechSynthesisVoice[]
      try {
        voices = options.synthesis.getVoices()
      } catch {
        const error = '读取系统语音失败，请检查系统语音设置'
        options.onError?.(error)
        return { ok: false, error }
      }
      const voice = findSpeechVoice(voices, language)
      if (!voice) {
        const error = '当前系统没有可用语音，请检查系统语音设置'
        options.onError?.(error)
        return { ok: false, error }
      }
      const chunks = splitSpeechText(normalizedText, options.maxChunkLength)
      if (chunks.length === 0) return { ok: false, error: '暂无可朗读的译文' }

      const currentSession = ++sessionId
      const speechCode = languageToSpeechCode(language) || voice.lang
      if (speaking) {
        try {
          options.synthesis.cancel()
        } catch {
          const error = '语音播放失败，请重试'
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
          utterance = options.createUtterance(chunks[index])
          utterance.lang = speechCode
          utterance.voice = voice
          utterance.volume = DEFAULT_SPEECH_VOLUME
          utterance.pitch = DEFAULT_SPEECH_PITCH
          utterance.rate = DEFAULT_SPEECH_RATE
          utterance.onend = () => playChunk(index + 1)
          utterance.onerror = () => failSession(currentSession, '语音播放失败，请重试')
          options.synthesis?.speak(utterance)
        } catch {
          failSession(currentSession, '语音播放失败，请重试')
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
