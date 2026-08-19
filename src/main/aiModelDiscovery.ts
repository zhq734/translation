import type { AiModelListResult, AiProtocol } from '../shared/types'
import { normalizeAiNetworkError } from './aiErrors'
import { normalizeAiBaseUrl } from './aiProtocol'

/** 模型发现网络请求函数签名。 */
export type AiModelFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

/** 模型发现服务依赖。 */
export interface AiModelDiscoveryOptions {
  /** 已应用当前代理配置的网络请求函数。 */
  fetch: AiModelFetch
  /** 请求超时时间（毫秒）。 */
  timeoutMs?: number
}

/** 模型发现请求输入。 */
export interface AiModelListInput {
  /** AI 协议类型。 */
  protocol: AiProtocol
  /** Base URL。 */
  baseUrl: string
  /** 主进程读取的 API Key，可能为 null。 */
  apiKey: string | null
}

/**
 * 根据协议发现模型列表，失败时返回脱敏状态且不阻止手动输入。
 * @param options 网络和超时依赖。
 * @returns 模型发现服务实例。
 * @author zhenghq
 */
export class AiModelDiscoveryService {
  private readonly timeoutMs: number
  private readonly cache = new Map<string, AiModelListResult>()

  constructor(private readonly options: AiModelDiscoveryOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /**
   * 调用协议模型列表接口并返回去空、去重、排序后的模型名称。
 * @param input 协议、Base URL 和凭证信息。
 * @returns 结构化脱敏模型列表结果。
 * @author zhenghq
   */
  async listModels(input: AiModelListInput): Promise<AiModelListResult> {
    const cacheKey = this.cacheKey(input)
    const cached = this.cache.get(cacheKey)
    if (cached && cached.state === 'success') return cached

    const baseUrl = normalizeAiBaseUrl(input.baseUrl)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (input.apiKey) {
      if (input.protocol === 'openai') headers['Authorization'] = `Bearer ${input.apiKey}`
      else if (input.protocol === 'claude-code') {
        headers['x-api-key'] = input.apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
    }
    const url = this.modelsUrl(input.protocol, baseUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
    })

    let response: Response
    try {
      response = await Promise.race([
        this.options.fetch(url, { method: 'GET', headers, signal: controller.signal }),
        abortPromise
      ])
    } catch (error) {
      clearTimeout(timer)
      return { state: 'error', models: [], message: this.toUserMessage(error) }
    }
    clearTimeout(timer)

    if (!response.ok) {
      if (input.protocol === 'claude-code' && response.status === 404) {
        return { state: 'unsupported', models: [], message: '当前服务不支持模型列表，请手动输入模型名称' }
      }
      return { state: 'error', models: [], message: this.statusMessage(response.status) }
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('json')) {
      if (input.protocol === 'claude-code') {
        return { state: 'unsupported', models: [], message: '当前服务不支持模型列表，请手动输入模型名称' }
      }
      return { state: 'error', models: [], message: '模型列表响应格式不受支持' }
    }

    let data: Record<string, unknown>
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      return { state: 'error', models: [], message: '模型列表解析失败' }
    }

    const models = this.extractModels(input.protocol, data)
    const result: AiModelListResult = { state: 'success', models }
    this.cache.set(cacheKey, result)
    return result
  }

  /**
   * 清理协议、Base URL 或 API Key 变化后的模型列表缓存。
 * @returns 无返回值。
 * @author zhenghq
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * 构造模型列表缓存键。
 * @param input 模型发现请求输入。
 * @returns 缓存键。
 * @author zhenghq
   */
  private cacheKey(input: AiModelListInput): string {
    return `${input.protocol}|${normalizeAiBaseUrl(input.baseUrl)}|${input.apiKey ? 'key' : 'none'}`
  }

  /**
   * 根据协议构造模型列表请求 URL。
 * @param protocol AI 协议类型。
 * @param baseUrl 规范化后的 Base URL。
 * @returns 模型列表请求 URL。
 * @author zhenghq
   */
  private modelsUrl(protocol: AiProtocol, baseUrl: string): string {
    switch (protocol) {
      case 'ollama': return `${baseUrl}/api/tags`
      case 'openai': return `${baseUrl}/models`
      case 'claude-code': return `${baseUrl}/v1/models`
      default: return `${baseUrl}/models`
    }
  }

  /**
   * 根据协议从响应中提取、去空、去重、排序模型名称。
 * @param protocol AI 协议类型。
 * @param data 已解析的 JSON 对象。
 * @returns 规范化后的模型名称列表。
 * @author zhenghq
   */
  private extractModels(protocol: AiProtocol, data: Record<string, unknown>): string[] {
    let raw: unknown[] = []
    if (protocol === 'ollama') {
      raw = (data.models as Array<{ name?: unknown }>) ?? []
      raw = raw.map((item) => (item as { name?: unknown }).name)
    } else {
      raw = (data.data as Array<{ id?: unknown }>) ?? []
      raw = raw.map((item) => (item as { id?: unknown }).id)
    }
    const names = raw
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim())
    return Array.from(new Set(names)).sort()
  }

  /**
   * 将网络异常转换为脱敏用户提示。
 * @param error 捕获到的异常。
 * @returns 不含 URL、API Key 的提示。
 * @author zhenghq
   */
  private toUserMessage(error: unknown): string {
    const normalized = normalizeAiNetworkError(error)
    return normalized.message
  }

  /**
   * 根据 HTTP 状态码返回脱敏提示。
 * @param status HTTP 状态码。
 * @returns 脱敏提示文本。
 * @author zhenghq
   */
  private statusMessage(status: number): string {
    if (status === 401 || status === 403) return '模型列表鉴权失败，请检查 API Key'
    if (status === 429) return '模型列表请求过于频繁，请稍后重试'
    return '模型列表加载失败'
  }
}
