import type {
  DingTalkCheckStatus,
  MicrosoftCheckStatus,
  Settings,
  TranslationProviderId
} from '../shared/types'
import type { DingTalkCredentials } from './dingtalkConfig'
import { DingTalkError, toDingTalkCheckStatus } from './dingtalkErrors'
import { resolveDingTalkLanguagePair } from './dingtalkLanguage'
import { DingTalkTokenManager, type DingTalkFetch } from './dingtalkTokenManager'
import { DingTalkTranslationClient } from './dingtalkTranslation'
import { toMicrosoftCheckStatus } from './microsoftErrors'
import { resolveMicrosoftLanguagePair } from './microsoftLanguage'
import { MicrosoftTranslationClient } from './microsoftTranslation'

const PUBLIC_DEEPLX = 'https://api.deeplx.org/mRZmM06yhhNJw55Vx87G2CuVvw0FYNtaOAkzo5UQVYI/translate'
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get'
const DINGTALK_CHANNEL = '钉钉翻译'
const MICROSOFT_CHANNEL = '微软翻译'

const MAX_CHARS = 5000
const GOOGLE_MAX_CHARS = 2000
const MYMEMORY_MAX_CHARS = 500

export interface TranslateOutput {
  translation: string
  detectedLang?: string
  provider?: TranslationProviderId
  channel?: string
}

/** 翻译运行时依赖。 */
export interface TranslationRuntimeOptions {
  /** 已应用当前代理配置的网络请求函数。 */
  fetch: DingTalkFetch
  /** 可注入时钟，用于熔断和 Token 生命周期测试。 */
  now?: () => number
}

interface DeepLxResponse {
  code?: number
  message?: string
  data?: string
  source_lang?: string
}

interface MyMemoryResponse {
  responseData?: { translatedText?: string; detectedLanguage?: string }
  responseDetails?: string
  quotaFinished?: boolean
  matches?: { source?: string }[]
}

interface TranslationChannel {
  id: TranslationProviderId
  name: string
  cooldownMs: number
  run: () => Promise<TranslateOutput>
}

interface CachedTranslation extends TranslateOutput {
  provider: TranslationProviderId
  channel: string
}

/**
 * 封装翻译结果缓存、通道熔断、钉钉 Token、免订阅微软翻译和多通道自动降级编排。
 * @param options 网络和时钟依赖。
 * @returns 可独立测试和重置的翻译运行时实例。
 * @author zhenghq
 */
export class TranslationRuntime {
  private readonly cache = new Map<string, CachedTranslation>()
  private readonly breaker = new Map<string, number>()
  private readonly now: () => number
  private readonly dingTalkClient: DingTalkTranslationClient
  private readonly microsoftClient: MicrosoftTranslationClient

  constructor(private readonly options: TranslationRuntimeOptions) {
    this.now = options.now ?? Date.now
    const tokenManager = new DingTalkTokenManager({ fetch: options.fetch, now: this.now })
    this.dingTalkClient = new DingTalkTranslationClient({
      fetch: options.fetch,
      tokenManager
    })
    this.microsoftClient = new MicrosoftTranslationClient({ fetch: options.fetch, now: this.now })
  }

  /**
   * 按用户首选 API、默认顺序执行翻译并自动降级。
   * @param text 待翻译文本。
   * @param settings 当前公开设置快照。
   * @param dingTalkCredentials 主进程解密后的钉钉凭证快照。
   * @returns 首个成功通道的统一翻译结果。
   * @author zhenghq
   */
  async translate(
    text: string,
    settings: Settings,
    dingTalkCredentials: DingTalkCredentials | null = null
  ): Promise<TranslateOutput> {
    const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
    const key = this.cacheKey(
      input,
      settings.sourceLang,
      settings.targetLang,
      settings.preferredTranslationProvider
    )
    const hit = this.cache.get(key)
    if (hit) return { ...hit, channel: '缓存' }

    const channels = this.createChannels(input, settings, dingTalkCredentials)
    let lastError = '所有翻译通道均失败'
    for (const channel of channels) {
      if (this.isTripped(channel.name)) {
        console.warn(`[translate] 跳过 ${channel.name}（熔断中）`)
        continue
      }
      try {
        const output = await channel.run()
        this.resetBreaker(channel.name)
        const successful: CachedTranslation = {
          ...output,
          channel: channel.name,
          provider: channel.id
        }
        if (settings.preferredTranslationProvider === 'auto' ||
            settings.preferredTranslationProvider === channel.id) {
          this.cache.set(key, successful)
        }
        console.log(`[translate] 成功，通道 = ${channel.name}`)
        return successful
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        lastError = `${channel.name}: ${message}`
        this.trip(channel.name, channel.cooldownMs)
        console.warn(`[translate] ${lastError}`)
      }
    }
    throw new Error(lastError)
  }

  /**
   * 不经过普通翻译缓存检测钉钉 Token 和文本翻译链路。
   * @param credentials 当前主进程凭证快照。
   * @returns 设置页可展示的结构化脱敏状态。
   * @author zhenghq
   */
  async checkDingTalk(credentials: DingTalkCredentials | null): Promise<DingTalkCheckStatus> {
    if (!credentials) {
      return toDingTalkCheckStatus(new DingTalkError('configuration', '钉钉配置不完整'))
    }
    try {
      await this.dingTalkClient.translate('你好', {
        supported: true,
        sourceLanguage: 'zh',
        targetLanguage: 'en'
      }, credentials)
      return { ok: true, code: 'available', message: '钉钉翻译在线且可用' }
    } catch (error) {
      return toDingTalkCheckStatus(error)
    }
  }

  /**
   * 不经过普通翻译结果缓存检测免订阅微软文本翻译链路。
   * @returns 设置页可展示的结构化脱敏状态。
   * @author zhenghq
   */
  async checkMicrosoft(): Promise<MicrosoftCheckStatus> {
    try {
      await this.microsoftClient.translate('你好', {
        supported: true,
        sourceLanguage: 'zh-Hans',
        targetLanguage: 'en'
      })
      return { ok: true, code: 'available', message: '微软翻译在线且可用' }
    } catch (error) {
      return toMicrosoftCheckStatus(error)
    }
  }

  /**
   * 在微软启用状态变化后清理结果缓存、网页鉴权和微软熔断状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetMicrosoftRuntime(): void {
    this.cache.clear()
    this.microsoftClient.reset()
    this.resetBreaker(MICROSOFT_CHANNEL)
  }

  /**
   * 在钉钉配置变化后清理全部结果缓存、Token/Promise 和钉钉熔断状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetDingTalkRuntime(): void {
    this.cache.clear()
    this.dingTalkClient.reset()
    this.resetBreaker(DINGTALK_CHANNEL)
  }

  /**
   * 根据配置和语言对构建本次翻译通道列表。
   * @param text 已截断的待翻译文本。
   * @param settings 当前公开设置。
   * @param dingTalkCredentials 当前主进程钉钉凭证快照。
   * @returns 按优先级排列的翻译通道。
   * @author zhenghq
   */
  private createChannels(
    text: string,
    settings: Settings,
    dingTalkCredentials: DingTalkCredentials | null
  ): TranslationChannel[] {
    const channels: TranslationChannel[] = []
    if (settings.dingTalkEnabled &&
        settings.dingTalkCorpId &&
        settings.dingTalkClientId &&
        settings.dingTalkSecretConfigured &&
        dingTalkCredentials) {
      const pair = resolveDingTalkLanguagePair(text, settings.sourceLang, settings.targetLang)
      if (pair.supported) {
        channels.push({
          id: 'dingtalk',
          name: DINGTALK_CHANNEL,
          cooldownMs: 60_000,
          run: () => this.dingTalkClient.translate(text, pair, dingTalkCredentials)
        })
      }
    }

    if (settings.microsoftEnabled) {
      const pair = resolveMicrosoftLanguagePair(settings.sourceLang, settings.targetLang)
      if (pair.supported) {
        channels.push({
          id: 'microsoft',
          name: MICROSOFT_CHANNEL,
          cooldownMs: 60_000,
          run: () => this.microsoftClient.translate(text, pair)
        })
      }
    }

    const selfHost = settings.deepLxUrl.trim()
    if (selfHost) {
      channels.push({
        id: 'deeplx-self',
        name: '自建 DeepLX',
        cooldownMs: 15_000,
        run: () => this.deepLxChannel(selfHost, text, settings, 2500)
      })
    }
    channels.push({
      id: 'deeplx-public',
      name: '公共 DeepLX',
      cooldownMs: 120_000,
      run: () => this.deepLxChannel(PUBLIC_DEEPLX, text, settings, 3000)
    })
    channels.push({
      id: 'google',
      name: 'Google',
      cooldownMs: 60_000,
      run: () => this.googleChannel(text, settings)
    })
    channels.push({
      id: 'mymemory',
      name: 'MyMemory',
      cooldownMs: 60_000,
      run: () => this.myMemoryChannel(text, settings)
    })
    const preferred = settings.preferredTranslationProvider
    if (preferred === 'auto') return channels
    const preferredIndex = channels.findIndex((channel) => channel.id === preferred)
    if (preferredIndex <= 0) return channels
    const [preferredChannel] = channels.splice(preferredIndex, 1)
    channels.unshift(preferredChannel)
    return channels
  }

  /**
   * 使用已配置代理的翻译网络会话发送带超时请求。
   * @param url 请求地址。
   * @param init 请求参数。
   * @param timeoutMs 超时时间（毫秒）。
   * @returns 网络响应。
   * @author zhenghq
   */
  private fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return this.options.fetch(url, { ...init, signal: controller.signal })
      .finally(() => clearTimeout(timer))
  }

  /**
   * 执行公共或自建 DeepLX 翻译。
   * @param baseUrl DeepLX 翻译地址。
   * @param text 待翻译文本。
   * @param settings 当前语言设置。
   * @param timeoutMs 请求超时时间。
   * @returns DeepLX 翻译结果。
   * @author zhenghq
   */
  private async deepLxChannel(
    baseUrl: string,
    text: string,
    settings: Settings,
    timeoutMs: number
  ): Promise<TranslateOutput> {
    const response = await this.fetchWithTimeout(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source_lang: settings.sourceLang,
        target_lang: settings.targetLang
      })
    }, timeoutMs)
    const json = (await response.json()) as DeepLxResponse
    if (json.code === 200 && json.data) {
      return { translation: json.data, detectedLang: json.source_lang || undefined }
    }
    throw new Error(json.code === 429 ? '限流 (429)' : json.message || `HTTP ${response.status}`)
  }

  /**
   * 执行 Google 非官方翻译接口请求。
   * @param text 待翻译文本。
   * @param settings 当前语言设置。
   * @returns Google 翻译结果。
   * @author zhenghq
   */
  private async googleChannel(text: string, settings: Settings): Promise<TranslateOutput> {
    const target = this.toIsoLang(settings.targetLang)
    const source = settings.sourceLang === 'auto' ? 'auto' : this.toIsoLang(settings.sourceLang)
    const query = text.length > GOOGLE_MAX_CHARS ? text.slice(0, GOOGLE_MAX_CHARS) : text
    const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(query)}`
    const response = await this.fetchWithTimeout(url, { method: 'GET' }, 3500)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('json')) throw new Error('被拦截（非 JSON 响应）')

    const data = (await response.json()) as unknown[]
    const segments = Array.isArray(data?.[0]) ? (data[0] as unknown[][]) : []
    const translation = segments
      .map((segment) => (segment?.[0] ? String(segment[0]) : ''))
      .join('')
      .trim()
    if (!translation) throw new Error('返回为空')
    const detected = data?.[2] ? String(data[2]) : ''
    return { translation, detectedLang: this.normalizeDetected(detected) }
  }

  /**
   * 执行 MyMemory 免费兜底翻译请求。
   * @param text 待翻译文本。
   * @param settings 当前语言设置。
   * @returns MyMemory 翻译结果。
   * @author zhenghq
   */
  private async myMemoryChannel(text: string, settings: Settings): Promise<TranslateOutput> {
    const target = this.toIsoLang(settings.targetLang)
    const source = settings.sourceLang === 'auto' ? 'Autodetect' : this.toIsoLang(settings.sourceLang)
    const query = text.length > MYMEMORY_MAX_CHARS ? text.slice(0, MYMEMORY_MAX_CHARS) : text
    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(query)}&langpair=${encodeURIComponent(
      `${source}|${target}`
    )}&mt=1`
    const response = await this.fetchWithTimeout(url, { method: 'GET' }, 6000)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as MyMemoryResponse
    if (data.quotaFinished) throw new Error('免费额度已用完')
    const translation = data.responseData?.translatedText?.trim()
    if (!translation) throw new Error(data.responseDetails || '无结果')
    const detected = data.responseData?.detectedLanguage || data.matches?.[0]?.source
    return {
      translation,
      detectedLang: detected ? this.normalizeDetected(detected) : undefined
    }
  }

  /**
   * 创建普通翻译结果缓存键。
   * @param text 待翻译文本。
   * @param source 源语言。
   * @param target 目标语言。
   * @param preferredProvider 用户选择的首选翻译 API。
   * @returns 缓存键。
   * @author zhenghq
   */
  private cacheKey(
    text: string,
    source: string,
    target: string,
    preferredProvider: Settings['preferredTranslationProvider']
  ): string {
    return `${preferredProvider}|${source}|${target}|${text}`
  }

  /**
   * 将内部语言代码转换为 Google/MyMemory 使用的 ISO 代码。
   * @param code 内部语言代码。
   * @returns 外部接口语言代码。
   * @author zhenghq
   */
  private toIsoLang(code: string): string {
    const normalized = code.toUpperCase()
    return normalized === 'ZH' ? 'zh-CN' : normalized.toLowerCase()
  }

  /**
   * 规范化外部接口返回的检测语言。
   * @param detected 外部检测语言代码。
   * @returns 应用内部大写语言代码。
   * @author zhenghq
   */
  private normalizeDetected(detected: string): string {
    const normalized = detected.toLowerCase()
    if (normalized.startsWith('zh')) return 'ZH'
    return normalized.split('-')[0].toUpperCase()
  }

  /**
   * 判断通道当前是否处于熔断冷却期。
   * @param name 通道名称。
   * @returns 是否应跳过该通道。
   * @author zhenghq
   */
  private isTripped(name: string): boolean {
    const until = this.breaker.get(name)
    return until != null && this.now() < until
  }

  /**
   * 将失败通道置于指定时长的熔断冷却期。
   * @param name 通道名称。
   * @param cooldownMs 冷却毫秒数。
   * @returns 无返回值。
   * @author zhenghq
   */
  private trip(name: string, cooldownMs: number): void {
    this.breaker.set(name, this.now() + cooldownMs)
  }

  /**
   * 清除指定通道的熔断状态。
   * @param name 通道名称。
   * @returns 无返回值。
   * @author zhenghq
   */
  private resetBreaker(name: string): void {
    this.breaker.delete(name)
  }
}

let defaultRuntime = new TranslationRuntime({
  fetch: (input, init) => globalThis.fetch(input, init)
})

/**
 * 配置主进程当前代理网络会话，避免共享 Settings 或渲染进程接触凭证。
 * @param fetch 当前已应用代理的网络请求函数。
 * @returns 无返回值。
 * @author zhenghq
 */
export function configureTranslationFetch(fetch: DingTalkFetch): void {
  defaultRuntime = new TranslationRuntime({ fetch })
}

/**
 * 使用应用默认翻译运行时执行多通道翻译。
 * @param text 待翻译文本。
 * @param settings 当前公开设置快照。
 * @param dingTalkCredentials 主进程解密后的钉钉凭证快照。
 * @returns 翻译结果。
 * @author zhenghq
 */
export function translate(
  text: string,
  settings: Settings,
  dingTalkCredentials: DingTalkCredentials | null = null
): Promise<TranslateOutput> {
  return defaultRuntime.translate(text, settings, dingTalkCredentials)
}

/**
 * 使用默认运行时执行不污染普通翻译缓存的钉钉配置检测。
 * @param credentials 当前主进程凭证快照。
 * @returns 结构化脱敏检测状态。
 * @author zhenghq
 */
export function checkDingTalk(credentials: DingTalkCredentials | null): Promise<DingTalkCheckStatus> {
  return defaultRuntime.checkDingTalk(credentials)
}

/**
 * 清理默认翻译运行时中的结果缓存、钉钉 Token/Promise 和熔断状态。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetDingTalkTranslationRuntime(): void {
  defaultRuntime.resetDingTalkRuntime()
}

/**
 * 使用默认运行时执行不污染普通翻译结果缓存的免订阅微软可用性检测。
 * @returns 结构化脱敏检测状态。
 * @author zhenghq
 */
export function checkMicrosoft(): Promise<MicrosoftCheckStatus> {
  return defaultRuntime.checkMicrosoft()
}

/**
 * 清理默认翻译运行时中的结果缓存和微软熔断状态。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetMicrosoftTranslationRuntime(): void {
  defaultRuntime.resetMicrosoftRuntime()
}
