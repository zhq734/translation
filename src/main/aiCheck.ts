import type { AiCheckStatus, Settings } from '../shared/types'
import { AiError } from './aiErrors'
import { AiTranslationClient, type AiFetch } from './aiTranslationClient'

/** 配置检测网络请求函数签名。 */
export type AiCheckFetch = AiFetch

/** 配置检测服务依赖。 */
export interface AiCheckOptions {
  /** 已应用当前代理配置的网络请求函数。 */
  fetch: AiCheckFetch
  /** 请求超时时间（毫秒）。 */
  timeoutMs?: number
}

/** 配置检测请求输入。 */
export interface AiCheckInput {
  /** 当前公开设置快照。 */
  settings: Settings
  /** 主进程读取的 API Key，可能为 null。 */
  apiKey: string | null
}

/**
 * 执行最小 AI 翻译请求以检测配置可用性，返回脱敏结构化状态且不污染普通翻译缓存。
 * @param options 网络和超时依赖。
 * @returns AI 配置检测服务实例。
 * @author zhenghq
 */
export class AiCheckService {
  private readonly client: AiTranslationClient

  constructor(options: AiCheckOptions) {
    this.client = new AiTranslationClient({ fetch: options.fetch, timeoutMs: options.timeoutMs })
  }

  /**
   * 检测当前 AI 配置能否完成一次最小翻译请求。
 * @param input 当前设置和 API Key。
 * @returns 结构化脱敏检测状态。
 * @author zhenghq
   */
  async check(input: AiCheckInput): Promise<AiCheckStatus> {
    const { settings, apiKey } = input
    if (!settings.aiBaseUrl.trim() || !settings.aiModel.trim()) {
      return { ok: false, code: 'incomplete', message: 'AI 配置不完整，请填写 Base URL 和模型' }
    }
    try {
      const translation = await this.client.translate({
        protocol: settings.aiProtocol,
        baseUrl: settings.aiBaseUrl,
        model: settings.aiModel,
        apiKey,
        text: 'hello',
        sourceLang: 'EN',
        targetLang: 'ZH'
      })
      if (!translation) {
        return { ok: false, code: 'service', message: 'AI 返回译文为空' }
      }
      return { ok: true, code: 'available', message: 'AI 翻译配置可用' }
    } catch (error) {
      return this.toCheckStatus(error)
    }
  }

  /**
   * 将内部 AI 错误转换为设置页可展示的结构化脱敏状态。
 * @param error AI 内部错误或未知异常。
 * @returns 不包含 API Key、鉴权 URL 和完整请求头的检测状态。
 * @author zhenghq
   */
  private toCheckStatus(error: unknown): AiCheckStatus {
    if (error instanceof AiError) {
      switch (error.kind) {
        case 'authentication': return { ok: false, code: 'authentication', message: 'AI 鉴权失败，请检查 API Key' }
        case 'permission': return { ok: false, code: 'permission', message: 'AI 应用权限不足' }
        case 'rate-limit': return { ok: false, code: 'rate-limit', message: 'AI 接口请求过于频繁，请稍后重试' }
        case 'not-found': return { ok: false, code: 'not-found', message: 'AI 模型不存在或路径错误' }
        case 'network': return { ok: false, code: 'network', message: error.message }
        case 'timeout': return { ok: false, code: 'timeout', message: error.message }
        default: return { ok: false, code: 'service', message: 'AI 服务暂时不可用，请稍后重试' }
      }
    }
    return { ok: false, code: 'network', message: 'AI 网络连接失败' }
  }
}
