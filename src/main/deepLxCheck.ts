import type { DeepLxStatus } from '../shared/types'
import { parseDeepLxUrls } from './translate'

/** DeepLX 在线检测使用的网络请求类型。 */
export type DeepLxCheckFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

/** DeepLX 在线检测依赖。 */
export interface DeepLxCheckDependencies {
  /** 可注入的网络请求实现。 */
  fetch: DeepLxCheckFetch
  /** 单个地址的超时时间，单位毫秒。 */
  timeoutMs?: number
}

/** 单个 DeepLX 地址的内部检测结果。 */
interface DeepLxEndpointCheckResult {
  /** 地址是否可用。 */
  online: boolean
  /** 脱敏后的失败原因。 */
  message?: string
}

/**
 * 分别检测并汇总多个自建 DeepLX 地址，不向渲染进程暴露地址。
 * @author zhenghq
 */
export class DeepLxCheckService {
  private readonly timeoutMs: number

  constructor(private readonly dependencies: DeepLxCheckDependencies) {
    this.timeoutMs = dependencies.timeoutMs ?? 3000
  }

  /**
   * 检测中英文逗号分隔的所有 DeepLX 地址。
   * @param value DeepLX 地址列表。
   * @returns 多地址汇总在线状态。
   * @author zhenghq
   */
  async check(value: string): Promise<DeepLxStatus> {
    const urls = parseDeepLxUrls(value)
    if (urls.length === 0) return { url: '', online: false, message: '未配置地址' }

    const results = await Promise.all(urls.map((url) => this.checkEndpoint(url)))
    const onlineCount = results.filter((result) => result.online).length
    const summary = `${onlineCount}/${urls.length} 个服务在线`
    if (onlineCount > 0) return { url: '', online: true, message: summary }

    const reason = results.find((result) => result.message)?.message
    return {
      url: '',
      online: false,
      message: reason ? `${summary}：${reason}` : summary
    }
  }

  /**
   * 检测一个 DeepLX 翻译端点并将错误转换为脱敏提示。
   * @param url 单个 DeepLX 翻译端点。
   * @returns 单地址内部检测结果。
   * @author zhenghq
   */
  private async checkEndpoint(url: string): Promise<DeepLxEndpointCheckResult> {
    try {
      const response = await this.dependencies.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'ping', source_lang: 'en', target_lang: 'zh' }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      let code: number | undefined
      try {
        const body = await response.json() as { code?: number }
        code = body.code
      } catch {
        // 非 JSON 响应按 HTTP 状态归类，避免向界面透传第三方响应内容。
      }
      if (response.ok && code === 200) return { online: true }
      return { online: false, message: `HTTP ${response.status}` }
    } catch (error) {
      if (this.isTimeoutError(error)) return { online: false, message: '连接超时' }
      return { online: false, message: '网络连接失败' }
    }
  }

  /**
   * 判断请求异常是否由超时或中止引起。
   * @param error 捕获到的未知异常。
   * @returns 是超时异常时返回 true。
   * @author zhenghq
   */
  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.name === 'TimeoutError'
      || error.name === 'AbortError'
      || /abort|timeout/iu.test(error.message)
  }
}
