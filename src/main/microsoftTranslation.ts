import type { MicrosoftCredentials } from './microsoftConfig'
import {
  createMicrosoftResponseError,
  MicrosoftError,
  normalizeMicrosoftNetworkError
} from './microsoftErrors'
import type { SupportedMicrosoftLanguagePair } from './microsoftLanguage'
import type { DingTalkFetch } from './dingtalkTokenManager'

const MICROSOFT_TRANSLATOR_ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate'

/** 微软翻译客户端依赖。 */
export interface MicrosoftTranslationClientOptions {
  /** 必须复用的翻译网络会话。 */
  fetch: DingTalkFetch
  /** 翻译请求超时时间。 */
  timeoutMs?: number
}

/** 微软 Translator 单项翻译响应。 */
interface MicrosoftTranslationResponseItem {
  detectedLanguage?: { language?: unknown }
  translations?: Array<{ text?: unknown }>
}

/** 微软翻译成功结果。 */
export interface MicrosoftTranslationResult {
  translation: string
  detectedLang?: string
}

/**
 * 调用微软 Translator Text v3 文本翻译接口。
 * @param options 网络和超时依赖。
 * @returns 微软翻译客户端实例。
 * @author zhenghq
 */
export class MicrosoftTranslationClient {
  private readonly timeoutMs: number

  constructor(private readonly options: MicrosoftTranslationClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 6000
  }

  /**
   * 翻译文本，源语言未指定时交由微软服务自动检测。
   * @param text 待翻译文本。
   * @param pair 已验证受支持的微软语言对。
   * @param credentials 当前主进程凭证快照。
   * @returns 微软翻译结果。
   * @author zhenghq
   */
  async translate(
    text: string,
    pair: SupportedMicrosoftLanguagePair,
    credentials: MicrosoftCredentials
  ): Promise<MicrosoftTranslationResult> {
    try {
      return await this.requestTranslation(text, pair, credentials)
    } catch (error) {
      throw normalizeMicrosoftNetworkError(error)
    }
  }

  /**
   * 使用指定订阅密钥发送一次 Translator v3 翻译请求。
   * @param text 待翻译文本。
   * @param pair 已验证的语言对。
   * @param credentials 当前订阅密钥和可选区域。
   * @returns 单次翻译结果。
   * @author zhenghq
   */
  private async requestTranslation(
    text: string,
    pair: SupportedMicrosoftLanguagePair,
    credentials: MicrosoftCredentials
  ): Promise<MicrosoftTranslationResult> {
    const query = new URLSearchParams({
      'api-version': '3.0',
      to: pair.targetLanguage
    })
    if (pair.sourceLanguage) query.set('from', pair.sourceLanguage)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      'Ocp-Apim-Subscription-Key': credentials.subscriptionKey
    }
    if (credentials.region.trim()) {
      headers['Ocp-Apim-Subscription-Region'] = credentials.region.trim()
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.options.fetch(`${MICROSOFT_TRANSLATOR_ENDPOINT}?${query.toString()}`, {
        method: 'POST',
        headers,
        body: JSON.stringify([{ Text: text }]),
        signal: controller.signal
      })
      if (!response.ok) throw createMicrosoftResponseError(response.status)
      return await this.readResponse(response, pair)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 安全解析微软翻译 JSON 响应，禁止将原始响应放入错误消息。
   * @param response 微软翻译接口响应。
   * @param pair 本次请求语言对，用于显式源语言的统一回显。
   * @returns 解析后的统一翻译结果。
   * @author zhenghq
   */
  private async readResponse(
    response: Response,
    pair: SupportedMicrosoftLanguagePair
  ): Promise<MicrosoftTranslationResult> {
    let payload: MicrosoftTranslationResponseItem[]
    try {
      payload = (await response.json()) as MicrosoftTranslationResponseItem[]
    } catch (error) {
      throw new MicrosoftError('service', '微软翻译响应无法解析', { cause: error })
    }

    const item = Array.isArray(payload) ? payload[0] : undefined
    const translation = typeof item?.translations?.[0]?.text === 'string'
      ? item.translations[0].text.trim()
      : ''
    if (!translation) throw new MicrosoftError('service', '微软翻译响应为空')

    const detected = typeof item?.detectedLanguage?.language === 'string'
      ? item.detectedLanguage.language
      : pair.sourceLanguage
    return {
      translation,
      detectedLang: detected ? this.normalizeDetectedLanguage(detected) : undefined
    }
  }

  /**
   * 规范化微软语言代码为应用内部展示代码。
   * @param language 微软 Translator 返回或请求使用的语言代码。
   * @returns 应用内部大写语言代码。
   * @author zhenghq
   */
  private normalizeDetectedLanguage(language: string): string {
    const normalized = language.toLowerCase()
    if (normalized.startsWith('zh')) return 'ZH'
    return normalized.split('-')[0].toUpperCase()
  }
}
