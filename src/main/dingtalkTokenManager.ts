import type { DingTalkCredentials } from './dingtalkConfig'
import {
  createDingTalkResponseError,
  DingTalkError,
  normalizeDingTalkNetworkError
} from './dingtalkErrors'
import { runDingTalkRequestWithTimeout } from './dingtalkRequest'

/** 可注入的翻译网络请求函数。 */
export type DingTalkFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

/** Token 管理器依赖。 */
export interface DingTalkTokenManagerOptions {
  /** 必须复用的翻译网络会话。 */
  fetch: DingTalkFetch
  /** 可注入时钟，默认使用 Date.now。 */
  now?: () => number
  /** Token 请求超时时间。 */
  timeoutMs?: number
  /** Token 到期前的刷新安全窗口。 */
  refreshWindowMs?: number
}

interface TokenResponse {
  access_token?: unknown
  expires_in?: unknown
  code?: unknown
}

/**
 * 管理钉钉 OAuth2 AccessToken 的缓存、提前刷新和并发请求合并。
 * @param options 网络、时钟和超时依赖。
 * @returns Token 管理器实例。
 * @author zhenghq
 */
export class DingTalkTokenManager {
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly refreshWindowMs: number
  private cachedToken: string | null = null
  private expiresAt = 0
  private credentialKey = ''
  private inFlight: Promise<string> | null = null
  private generation = 0

  constructor(private readonly options: DingTalkTokenManagerOptions) {
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 5000
    this.refreshWindowMs = options.refreshWindowMs ?? 60_000
  }

  /**
   * 获取当前配置对应的有效 Token，并合并同时发生的请求。
   * @param credentials 当前主进程凭证快照。
   * @returns 可用于钉钉翻译接口的 AccessToken。
   * @author zhenghq
   */
  async getToken(credentials: DingTalkCredentials): Promise<string> {
    const key = this.createCredentialKey(credentials)
    if (this.credentialKey && this.credentialKey !== key) this.reset()
    this.credentialKey = key

    if (this.cachedToken && this.now() < this.expiresAt - this.refreshWindowMs) {
      return this.cachedToken
    }
    if (this.inFlight) return this.inFlight

    const generation = this.generation
    const request = this.requestToken(credentials, key, generation)
    this.inFlight = request
    try {
      return await request
    } finally {
      if (this.inFlight === request) this.inFlight = null
    }
  }

  /**
   * 清除缓存 Token、到期时间和进行中的请求引用。
   * @returns 无返回值。
   * @author zhenghq
   */
  reset(): void {
    this.cachedToken = null
    this.expiresAt = 0
    this.credentialKey = ''
    this.inFlight = null
    this.generation += 1
  }

  /**
   * 调用 OAuth2 接口并在当前配置世代仍有效时缓存 Token。
   * @param credentials 当前凭证快照。
   * @param key 当前凭证内存键。
   * @param generation 请求开始时的配置世代。
   * @returns 新获取的 AccessToken。
   * @author zhenghq
   */
  private async requestToken(
    credentials: DingTalkCredentials,
    key: string,
    generation: number
  ): Promise<string> {
    try {
      return await runDingTalkRequestWithTimeout(this.timeoutMs, async (signal) => {
        const url = `https://api.dingtalk.com/v1.0/oauth2/${encodeURIComponent(credentials.corpId)}/token`
        const response = await this.options.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: 'client_credentials'
          }),
          signal
        })
        const payload = await this.readResponse(response)
        if (!response.ok) {
          const code = typeof payload.code === 'number' ? payload.code : undefined
          throw createDingTalkResponseError(response.status, code)
        }

        const token = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
        const expiresIn = Number(payload.expires_in)
        if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
          throw new DingTalkError('service', '钉钉 Token 响应格式无效')
        }
        if (generation === this.generation && key === this.credentialKey) {
          this.cachedToken = token
          this.expiresAt = this.now() + expiresIn * 1000
        }
        return token
      })
    } catch (error) {
      throw normalizeDingTalkNetworkError(error)
    }
  }

  /**
   * 安全解析 Token JSON 响应，解析失败时返回服务错误。
   * @param response Token 接口响应。
   * @returns Token 响应对象。
   * @author zhenghq
   */
  private async readResponse(response: Response): Promise<TokenResponse> {
    try {
      return (await response.json()) as TokenResponse
    } catch (error) {
      throw new DingTalkError('service', '钉钉 Token 响应无法解析', { cause: error })
    }
  }

  /**
   * 创建只保留在主进程内存中的凭证比较键。
   * @param credentials 当前凭证快照。
   * @returns 用于判断配置是否变化的内存键。
   * @author zhenghq
   */
  private createCredentialKey(credentials: DingTalkCredentials): string {
    return `${credentials.corpId}\u0000${credentials.clientId}\u0000${credentials.clientSecret}`
  }
}
