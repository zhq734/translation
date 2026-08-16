import type { DingTalkCredentials } from './dingtalkConfig'
import {
  createDingTalkResponseError,
  DingTalkError,
  normalizeDingTalkNetworkError
} from './dingtalkErrors'
import type { SupportedDingTalkLanguagePair } from './dingtalkLanguage'
import { runDingTalkRequestWithTimeout } from './dingtalkRequest'
import type { DingTalkFetch } from './dingtalkTokenManager'

/** 翻译客户端所需的 Token 管理最小接口。 */
export interface DingTalkTokenProvider {
  /** 获取当前凭证对应的 Token。 */
  getToken(credentials: DingTalkCredentials): Promise<string>
  /** 清除 Token 和进行中请求。 */
  reset(): void
}

/** 钉钉文本翻译客户端依赖。 */
export interface DingTalkTranslationClientOptions {
  /** 必须复用的翻译网络会话。 */
  fetch: DingTalkFetch
  /** Token 管理器。 */
  tokenManager: DingTalkTokenProvider
  /** 翻译请求超时时间。 */
  timeoutMs?: number
}

/** 钉钉翻译成功结果。 */
export interface DingTalkTranslationResult {
  translation: string
  detectedLang: string
}

interface DingTalkTranslationResponse {
  errcode?: unknown
  result?: unknown
}

/**
 * 调用钉钉 TOPAPI 文本翻译接口，并在 Token 明确失效时最多刷新重试一次。
 * @param options 网络、Token 和超时依赖。
 * @returns 钉钉文本翻译客户端实例。
 * @author zhenghq
 */
export class DingTalkTranslationClient {
  private readonly timeoutMs: number

  constructor(private readonly options: DingTalkTranslationClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 6000
  }

  /**
   * 翻译文本，首次请求明确鉴权失效时刷新 Token 后重试一次。
   * @param text 待翻译文本。
   * @param pair 已验证受支持的钉钉语言对。
   * @param credentials 当前主进程凭证快照。
   * @returns 钉钉翻译结果。
   * @author zhenghq
   */
  async translate(
    text: string,
    pair: SupportedDingTalkLanguagePair,
    credentials: DingTalkCredentials
  ): Promise<DingTalkTranslationResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.options.tokenManager.getToken(credentials)
      try {
        return await this.requestTranslation(text, pair, token)
      } catch (error) {
        const normalized = normalizeDingTalkNetworkError(error)
        if (attempt === 0 && normalized.authenticationInvalid) {
          this.options.tokenManager.reset()
          continue
        }
        throw normalized
      }
    }
    throw new DingTalkError('authentication', '钉钉鉴权失败')
  }

  /**
   * 清除客户端持有的 Token 运行时状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset(): void {
    this.options.tokenManager.reset()
  }

  /**
   * 使用指定 Token 发送一次 TOPAPI 文本翻译请求。
   * @param text 待翻译文本。
   * @param pair 已验证的语言对。
   * @param token 当前 AccessToken。
   * @returns 单次翻译结果。
   * @author zhenghq
   */
  private async requestTranslation(
    text: string,
    pair: SupportedDingTalkLanguagePair,
    token: string
  ): Promise<DingTalkTranslationResult> {
    return runDingTalkRequestWithTimeout(this.timeoutMs, async (signal) => {
      const url = `https://oapi.dingtalk.com/topapi/ai/mt/translate?access_token=${encodeURIComponent(token)}`
      const response = await this.options.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          source_language: pair.sourceLanguage,
          target_language: pair.targetLanguage
        }),
        signal
      })
      const payload = await this.readResponse(response)
      const errorCode = Number(payload.errcode)
      if (!response.ok || !Number.isFinite(errorCode) || errorCode !== 0) {
        throw createDingTalkResponseError(
          response.status,
          Number.isFinite(errorCode) ? errorCode : undefined
        )
      }
      const translation = typeof payload.result === 'string' ? payload.result.trim() : ''
      if (!translation) throw new DingTalkError('service', '钉钉翻译响应为空')
      return {
        translation,
        detectedLang: pair.sourceLanguage.toUpperCase()
      }
    })
  }

  /**
   * 安全解析翻译 JSON 响应，禁止将原始响应或 URL 放入错误消息。
   * @param response 钉钉翻译接口响应。
   * @returns 解析后的响应对象。
   * @author zhenghq
   */
  private async readResponse(response: Response): Promise<DingTalkTranslationResponse> {
    try {
      return (await response.json()) as DingTalkTranslationResponse
    } catch (error) {
      throw new DingTalkError('service', '钉钉翻译响应无法解析', { cause: error })
    }
  }
}
