import type { AiProtocol } from '../shared/types'
import { AiError, createAiResponseError, normalizeAiNetworkError } from './aiErrors'
import {
  buildAiTranslationRequest,
  normalizeAiBaseUrl,
  extractAiTranslation,
  type AiBuiltRequest
} from './aiProtocol'
import { createAiStreamParser } from './aiStreamProtocol'
import { AiTranslationStreamSanitizer } from '../shared/aiTranslationStreamSanitize'
import { translateMain } from './messages'

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

/** 流式翻译回调与取消选项。 */
export interface AiStreamOptions {
  /** 收到一个安全译文增量时回调。 */
  onDelta: (delta: string) => void
  /** 外部取消信号；与客户端超时共同控制请求生命周期。 */
  signal?: AbortSignal
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
    const built = this.buildRequest(input, false)

    const headers: Record<string, string> = {}
    built.headers.forEach((value, key) => { headers[key] = value })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new AiError('timeout', translateMain('ai.error.timeout')))
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
      throw new AiError('service', translateMain('ai.error.nonJsonResponse'))
    }

    let data: Record<string, unknown>
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch (error) {
      throw new AiError('service', translateMain('ai.error.responseParse'), { cause: error })
    }

    const translation = extractAiTranslation(input.protocol, data)
    if (!translation) {
      throw new AiError('service', translateMain('ai.error.emptyTranslation'))
    }
    return translation
  }

  /**
   * 执行一次真实流式 AI 翻译请求，按安全片段回调并在结束时返回最终清洗译文。
   * @param input 协议、Base URL、模型、凭证和语言信息。
   * @param options 增量回调与取消信号。
   * @returns 最终清洗后的完整译文。
   * @author zhenghq
   */
  async stream(input: AiTranslateInput, options: AiStreamOptions): Promise<string> {
    const built = this.buildRequest(input, true)
    const headers: Record<string, string> = {}
    built.headers.forEach((value, key) => { headers[key] = value })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })
    if (options.signal?.aborted) controller.abort()

    let response: Response
    try {
      response = await this.options.fetch(built.url, {
        method: built.method,
        headers,
        body: built.body,
        signal: controller.signal
      })
    } catch (error) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
      throw normalizeAiNetworkError(error)
    }

    if (!response.ok) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
      throw createAiResponseError(response.status)
    }
    if (!response.body) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
      throw new AiError('service', translateMain('ai.error.emptyTranslation'))
    }

    const parser = createAiStreamParser(input.protocol)
    const sanitizer = new AiTranslationStreamSanitizer()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let finalTranslation = ''
    try {
      while (true) {
        if (controller.signal.aborted) throw new AiError('timeout', translateMain('ai.error.timeout'))
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const rawDelta of parser.push(text)) {
          const safe = sanitizer.push(rawDelta)
          if (safe) {
            finalTranslation += safe
            options.onDelta(safe)
          }
        }
      }
      for (const rawDelta of parser.finish()) {
        const safe = sanitizer.push(rawDelta)
        if (safe) {
          finalTranslation += safe
          options.onDelta(safe)
        }
      }
      finalTranslation = sanitizer.finish()
    } catch (error) {
      throw normalizeAiNetworkError(error)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
    }

    if (!finalTranslation) {
      throw new AiError('service', translateMain('ai.error.emptyTranslation'))
    }
    return finalTranslation
  }

  /**
   * 构造协议请求并统一转换构造错误。
   * @param input 协议、Base URL、模型、凭证和语言信息。
   * @param stream 是否构造流式请求。
   * @returns 可供网络请求使用的统一请求结构。
   * @author zhenghq
   */
  private buildRequest(input: AiTranslateInput, stream: boolean): AiBuiltRequest {
    try {
      return buildAiTranslationRequest({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        text: input.text,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        stream
      })
    } catch (error) {
      throw new AiError('service', translateMain('ai.error.requestBuild'), { cause: error })
    }
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
