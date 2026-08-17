import {
  createMicrosoftResponseError,
  MicrosoftError,
  normalizeMicrosoftNetworkError
} from './microsoftErrors'
import type { SupportedMicrosoftLanguagePair } from './microsoftLanguage'
import type { DingTalkFetch } from './dingtalkTokenManager'

const BING_TRANSLATOR_PAGE = 'https://www.bing.com/translator'
const AUTH_EXPIRY_SAFETY_MARGIN_MS = 60_000
const MAX_CHARS_PER_REQUEST = 1000
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0'

/** Bing 翻译页面提供的短期防滥用参数。 */
interface BingAuthentication {
  /** 请求查询参数 IG。 */
  ig: string
  /** 请求查询参数 IID。 */
  iid: string
  /** 表单防滥用 Key。 */
  key: string
  /** 表单短期 Token。 */
  token: string
  /** 实际 Bing 区域站点来源。 */
  origin: string
  /** 实际 Bing 翻译页面地址。 */
  pageUrl: string
  /** 本地缓存失效时间戳。 */
  expiresAt: number
}

/** 微软翻译客户端依赖。 */
export interface MicrosoftTranslationClientOptions {
  /** 必须复用的翻译网络会话。 */
  fetch: DingTalkFetch
  /** 可注入时钟，用于鉴权缓存生命周期测试。 */
  now?: () => number
  /** 单次网络请求超时时间。 */
  timeoutMs?: number
}

/** Bing 翻译单项响应。 */
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
 * 调用无需 Azure 订阅的 Bing 在线翻译接口。
 * @param options 网络、时钟和超时依赖。
 * @returns 微软翻译客户端实例。
 * @author zhenghq
 */
export class MicrosoftTranslationClient {
  private readonly now: () => number
  private readonly timeoutMs: number
  private cachedAuthentication: BingAuthentication | null = null
  private authenticationPromise: Promise<BingAuthentication> | null = null

  constructor(private readonly options: MicrosoftTranslationClientOptions) {
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 6000
  }

  /**
   * 翻译文本；网页会话失效时清理鉴权并自动重试一次。
   * @param text 待翻译文本。
   * @param pair 已验证受支持的微软语言对。
   * @returns 微软翻译结果。
   * @author zhenghq
   */
  async translate(
    text: string,
    pair: SupportedMicrosoftLanguagePair
  ): Promise<MicrosoftTranslationResult> {
    try {
      return await this.translateChunks(text, pair)
    } catch (error) {
      const normalized = normalizeMicrosoftNetworkError(error)
      if (normalized.kind !== 'authentication') throw normalized
      this.reset()
      try {
        return await this.translateChunks(text, pair)
      } catch (retryError) {
        throw normalizeMicrosoftNetworkError(retryError)
      }
    }
  }

  /**
   * 清理已缓存的 Bing 页面鉴权和并发获取状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset(): void {
    this.cachedAuthentication = null
    this.authenticationPromise = null
  }

  /**
   * 将长文本拆成最多 1000 字符的分块并发翻译，再按原顺序合并结果。
   * @param text 待翻译文本。
   * @param pair 已验证的语言对。
   * @returns 合并后的翻译结果。
   * @author zhenghq
   */
  private async translateChunks(
    text: string,
    pair: SupportedMicrosoftLanguagePair
  ): Promise<MicrosoftTranslationResult> {
    const chunks = this.splitText(text)
    if (chunks.length === 0) throw new MicrosoftError('parameter', '微软翻译文本不能为空')

    const results = await Promise.all(chunks.map((chunk) => this.requestTranslation(chunk, pair)))
    const translation = results.map((result) => result.translation).join('')
    if (!translation) throw new MicrosoftError('service', '微软翻译响应为空')
    return {
      translation,
      detectedLang: results.find((result) => result.detectedLang)?.detectedLang
    }
  }

  /**
   * 按 Bing 单次请求上限切分文本，并保留全部原始字符。
   * @param text 待切分文本。
   * @returns 按原顺序排列的非空文本分块。
   * @author zhenghq
   */
  private splitText(text: string): string[] {
    const chunks: string[] = []
    for (let start = 0; start < text.length; start += MAX_CHARS_PER_REQUEST) {
      chunks.push(text.slice(start, start + MAX_CHARS_PER_REQUEST))
    }
    return chunks
  }

  /**
   * 获取仍在安全有效期内的 Bing 页面鉴权，并合并并发获取请求。
   * @returns 可用于翻译表单的短期鉴权参数。
   * @author zhenghq
   */
  private getAuthentication(): Promise<BingAuthentication> {
    if (this.cachedAuthentication && this.cachedAuthentication.expiresAt > this.now()) {
      return Promise.resolve(this.cachedAuthentication)
    }
    if (this.authenticationPromise) return this.authenticationPromise

    this.authenticationPromise = this.loadAuthentication()
      .then((authentication) => {
        this.cachedAuthentication = authentication
        return authentication
      })
      .finally(() => {
        this.authenticationPromise = null
      })
    return this.authenticationPromise
  }

  /**
   * 请求 Bing 翻译网页并解析短期防滥用参数。
   * @returns 带本地安全失效时间的鉴权参数。
   * @author zhenghq
   */
  private async loadAuthentication(): Promise<BingAuthentication> {
    const response = await this.fetchWithTimeout(BING_TRANSLATOR_PAGE, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': EDGE_USER_AGENT
      }
    })
    if (!response.ok) throw createMicrosoftResponseError(response.status)

    let html: string
    try {
      html = await response.text()
    } catch (error) {
      throw new MicrosoftError('service', '微软翻译网页响应无法读取', { cause: error })
    }
    const pageContext = this.resolvePageContext(response.url)
    return this.parseAuthentication(html, pageContext)
  }

  /**
   * 解析跟随重定向后的 Bing 区域站点，并阻止向非 Bing 域名发送临时参数。
   * @param responseUrl fetch 最终响应地址；测试响应可能为空。
   * @returns 规范化后的 Bing 来源和翻译页面地址。
   * @author zhenghq
   */
  private resolvePageContext(responseUrl: string): Pick<BingAuthentication, 'origin' | 'pageUrl'> {
    let parsed: URL
    try {
      parsed = new URL(responseUrl || BING_TRANSLATOR_PAGE)
    } catch {
      throw new MicrosoftError('service', '微软翻译网页重定向地址无效')
    }
    const hostname = parsed.hostname.toLowerCase()
    const trustedHost = hostname === 'bing.com' || hostname.endsWith('.bing.com')
    if (parsed.protocol !== 'https:' || !trustedHost) {
      throw new MicrosoftError('service', '微软翻译网页重定向地址无效')
    }
    return {
      origin: parsed.origin,
      pageUrl: new URL('/translator', parsed.origin).toString()
    }
  }

  /**
   * 从 Bing 翻译网页 HTML 中提取 Key、Token、TTL、IG 和 IID。
   * @param html Bing 翻译网页 HTML。
   * @param pageContext 实际 Bing 区域站点上下文。
   * @returns 可缓存的短期鉴权参数。
   * @author zhenghq
   */
  private parseAuthentication(
    html: string,
    pageContext: Pick<BingAuthentication, 'origin' | 'pageUrl'>
  ): BingAuthentication {
    const prevention = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/u.exec(html)
    const ig = /IG\s*:\s*"([A-Fa-f0-9]+)"/u.exec(html)?.[1]
    const iid = /data-iid\s*=\s*"([^"]+)"/u.exec(html)?.[1]
    if (!prevention || !ig || !iid) {
      throw new MicrosoftError('service', '微软翻译网页鉴权参数无法解析')
    }

    const ttlMs = Number(prevention[3])
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new MicrosoftError('service', '微软翻译网页鉴权有效期无效')
    }
    return {
      ...pageContext,
      ig,
      iid,
      key: prevention[1],
      token: prevention[2],
      expiresAt: this.now() + Math.max(0, ttlMs - AUTH_EXPIRY_SAFETY_MARGIN_MS)
    }
  }

  /**
   * 使用短期网页鉴权发送一次 Bing 表单翻译请求。
   * @param text 不超过 1000 字符的待翻译分块。
   * @param pair 已验证的语言对。
   * @returns 单个分块的翻译结果。
   * @author zhenghq
   */
  private async requestTranslation(
    text: string,
    pair: SupportedMicrosoftLanguagePair
  ): Promise<MicrosoftTranslationResult> {
    const authentication = await this.getAuthentication()
    const query = new URLSearchParams({
      isVertical: '1',
      IG: authentication.ig,
      IID: authentication.iid
    })
    const form = new URLSearchParams({
      text,
      fromLang: pair.sourceLanguage ?? 'auto-detect',
      to: pair.targetLanguage,
      token: authentication.token,
      key: authentication.key
    })
    const endpoint = new URL('/ttranslatev3', authentication.origin)
    endpoint.search = query.toString()
    const response = await this.fetchWithTimeout(endpoint.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: authentication.origin,
        Referer: authentication.pageUrl,
        'User-Agent': EDGE_USER_AGENT
      },
      body: form.toString()
    })
    if (!response.ok) throw createMicrosoftResponseError(response.status)
    return this.readResponse(response, pair)
  }

  /**
   * 使用应用翻译网络会话发送带超时的 Bing 请求。
   * @param url 请求地址。
   * @param init 请求参数。
   * @returns 网络响应。
   * @author zhenghq
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.options.fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 安全解析 Bing 翻译 JSON 响应，禁止将原始响应放入错误消息。
   * @param response Bing 翻译接口响应。
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
      ? item.translations[0].text
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
   * @param language Bing 在线翻译返回或请求使用的语言代码。
   * @returns 应用内部大写语言代码。
   * @author zhenghq
   */
  private normalizeDetectedLanguage(language: string): string {
    const normalized = language.toLowerCase()
    if (normalized.startsWith('zh')) return 'ZH'
    return normalized.split('-')[0].toUpperCase()
  }
}
