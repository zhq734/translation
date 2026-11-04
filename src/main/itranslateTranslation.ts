/** iTranslate v2 网络请求函数，复用主进程已应用代理的 fetch。 */
export type ITranslateFetch = (
  input: string | Request,
  init?: RequestInit
) => Promise<Response>

/** iTranslate 翻译客户端依赖。 */
export interface ITranslateTranslationClientOptions {
  /** 已应用代理配置的网络请求函数。 */
  fetch: ITranslateFetch
  /** 请求超时时间，默认 8 秒。 */
  timeoutMs?: number
}

/** iTranslate 语言对；auto 等不支持的语言不会创建客户端请求。 */
export interface ITranslateLanguagePair {
  /** 规范化后的源语言。 */
  source: string
  /** 规范化后的目标语言。 */
  target: string
}

/** iTranslate v2 响应中的最小字段。 */
interface ITranslateResponse {
  /** 翻译结果。 */
  translation?: unknown
  /** 可选的耗时信息，仅用于兼容官方响应。 */
  times?: unknown
}

/**
 * 将应用语言代码规范化为 iTranslate 使用的主语言代码。
 * @param value 应用设置中的语言代码。
 * @returns 小写主语言代码；auto 或空值返回 null。
 * @author zhenghq
 */
export function normalizeITranslateLanguage(value: string): string | null {
  const normalized = value.trim().toLowerCase().split(/[-_]/u)[0]
  if (!normalized || normalized === 'auto') return null
  return normalized
}

/**
 * 解析 iTranslate 支持的语言对，源或目标为 auto 时明确返回不支持。
 * @param sourceLang 应用源语言代码。
 * @param targetLang 应用目标语言代码。
 * @returns 可发送的语言对；不支持时返回 null。
 * @author zhenghq
 */
export function resolveITranslateLanguagePair(
  sourceLang: string,
  targetLang: string
): ITranslateLanguagePair | null {
  const source = normalizeITranslateLanguage(sourceLang)
  const target = normalizeITranslateLanguage(targetLang)
  if (!source || !target || source === target) return null
  return { source, target }
}

/**
 * iTranslate 官方 v2 翻译客户端。
 * @author zhenghq
 */
export class ITranslateTranslationClient {
  private readonly timeoutMs: number

  /**
   * 创建 iTranslate 客户端。
   * @param options 网络请求与超时配置。
   * @author zhenghq
   */
  constructor(private readonly options: ITranslateTranslationClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 8_000
  }

  /**
   * 使用官方 v2 接口翻译一段文本。
   * @param text 待翻译文本。
   * @param pair 已解析的源/目标语言对。
   * @param apiKey 主进程安全存储中的 iTranslate Key。
   * @param signal 可选外部取消信号。
   * @returns 译文与检测到的源语言。
   * @author zhenghq
   */
  async translate(
    text: string,
    pair: ITranslateLanguagePair,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<{ translation: string; detectedLang: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const forwardAbort = (): void => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      const response = await this.options.fetch('https://dev-api.itranslate.com/translation/v2/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: { dialect: pair.source, text },
          target: { dialect: pair.target }
        }),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`iTranslate HTTP ${response.status}`)
      const body = await response.json() as ITranslateResponse
      const translation = typeof body.translation === 'string' ? body.translation.trim() : ''
      if (!translation) throw new Error('iTranslate returned an empty translation')
      return {
        translation,
        detectedLang: pair.source.toUpperCase()
      }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
