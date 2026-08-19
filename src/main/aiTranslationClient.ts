import type { AiProtocol } from '../shared/types'
import { AiError, createAiResponseError, normalizeAiNetworkError } from './aiErrors'
import {
  buildAiTranslationRequest,
  normalizeAiBaseUrl,
  extractAiTranslation,
  type AiBuiltRequest
} from './aiProtocol'

/** AI 翻译网络请求函数签名，复用主进程代理会话。 */
export type AiFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

/** AI 翻译客户端依赖。 */
export interface AiTranslationClientOptions {
  /** 已应用当前代理配置的网络请求函数。 */
  fetch: AiFetch
  /** 请求超时时间（毫秒）。 */
  timeoutMs?: number
}

/** 统一 AI 翻译请求输入。 */
export interface AiTranslateInput {
  /** AI 协议类型。 */
  protocol: AiProtocol
  /** Base URL。 */
  baseUrl: string
  /** AI 模型名称。 */
  model: string
  /** 主进程读取的 API Key，可能为 null。 */
  apiKey: string | null
  /** 待翻译文本。 */
  text: string
  /** 已解析的源语言。 */
  sourceLang: string
  /** 已解析的目标语言。 */
  targetLang: string
}

/**
 * 统一处理三种协议的 AI 翻译请求、超时、响应解析和错误分类。
 * @param options 网络和超时依赖。
 * @returns AI 翻译客户端实例。
 * @author zhenghq
 */
export class AiTranslationClient {
  private readonly timeoutMs: number

  constructor(private readonly options: AiTranslationClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  /**
   * 执行一次非流式 AI 翻译请求并返回统一译文。
 * @param input 协议、Base URL、模型、凭证和语言信息。
 * @returns 去除首尾空白后的译文。
 * @author zhenghq
   */
  async translate(input: AiTranslateInput): Promise<string> {
    let built: AiBuiltRequest
    try {
      built = buildAiTranslationRequest({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        text: input.text,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang
      })
    } catch (error) {
      throw new AiError('service', 'AI 请求构造失败', { cause: error })
    }

    const headers: Record<string, string> = {}
    built.headers.forEach((value, key) => { headers[key] = value })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new AiError('timeout', 'AI 请求超时'))
      })
    })
    let response: Response
    try {
      response = await Promise.race([
        this.options.fetch(built.url, {
          method: built.method,
          headers,
          body: built.body,
          signal: controller.signal
        }),
        abortPromise
      ])
    } catch (error) {
      clearTimeout(timer)
      throw normalizeAiNetworkError(error)
    }
    clearTimeout(timer)

    if (!response.ok) {
      throw createAiResponseError(response.status)
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('json')) {
      throw new AiError('service', 'AI 服务返回非 JSON 响应')
    }

    let data: Record<string, unknown>
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch (error) {
      throw new AiError('service', 'AI 服务响应解析失败', { cause: error })
    }

    const translation = extractAiTranslation(input.protocol, data)
    if (!translation) {
      throw new AiError('service', 'AI 返回译文为空')
    }
    return translation
  }

  /**
   * 规范化 Base URL，供外部复用。
 * @param baseUrl 原始 Base URL。
 * @returns 规范化后的 Base URL。
 * @author zhenghq
   */
  normalizeBaseUrl(baseUrl: string): string {
    return normalizeAiBaseUrl(baseUrl)
  }
}
