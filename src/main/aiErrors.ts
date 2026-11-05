import { translateMain } from './messages'

/** 服务端 Retry-After 的安全上限，避免异常值让字幕长时间停止更新。 */
export const MAX_RETRY_AFTER_MS = 60_000

/** AI 翻译内部错误分类。 */
export type AiErrorKind =
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'not-found'
  | 'network'
  | 'timeout'
  | 'service'

/** AiError 的附加选项。 */
export interface AiErrorOptions {
  /** 原始异常，仅用于保留 cause，不会进入公开消息。 */
  cause?: unknown
  /** 服务端建议的限流重试等待时间（毫秒）。 */
  retryAfterMs?: number
}

/**
 * 表示已脱敏且分类后的 AI 翻译调用错误。
 * @param kind 错误分类。
 * @param message 不含 API Key、鉴权 URL 或完整请求头部的内部摘要。
 * @param options 原始异常信息。
 * @returns AI 翻译错误实例。
 * @author zhenghq
 */
export class AiError extends Error {
  /** 服务端建议的限流重试等待时间（毫秒）。 */
  readonly retryAfterMs?: number

  constructor(
    readonly kind: AiErrorKind,
    message: string,
    options: AiErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AiError'
    this.retryAfterMs = options.retryAfterMs
  }
}

/**
 * 将 HTTP Retry-After 响应头解析为毫秒等待时间。
 * @param value Retry-After 原始值，支持秒数或 HTTP 日期。
 * @param nowMs 当前时间戳，用于计算 HTTP 日期差值。
 * @returns 非负等待毫秒数；缺失或格式非法时返回 undefined。
 * @author zhenghq
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (/^\d+$/u.test(normalized)) {
    return Math.min(Number(normalized) * 1_000, MAX_RETRY_AFTER_MS)
  }
  const retryAt = Date.parse(normalized)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.min(Math.max(0, retryAt - nowMs), MAX_RETRY_AFTER_MS)
}

/**
 * 根据 HTTP 状态码创建脱敏分类错误。
 * @param status HTTP 状态码。
 * @param retryAfter Retry-After 响应头。
 * @returns 不包含服务端原始详情和凭证的 AI 错误。
 * @author zhenghq
 */
export function createAiResponseError(status: number, retryAfter?: string | null): AiError {
  if (status === 401 || status === 403) return new AiError('authentication', translateMain('ai.error.authentication'))
  if (status === 429) {
    return new AiError('rate-limit', translateMain('ai.error.rateLimit'), {
      retryAfterMs: parseRetryAfterMs(retryAfter)
    })
  }
  if (status === 404) return new AiError('not-found', translateMain('ai.error.notFound'))
  if (status >= 500) return new AiError('service', translateMain('ai.error.serviceUnavailable'))
  return new AiError('service', translateMain('ai.error.httpStatus', { status }))
}

/**
 * 将未知网络异常转换为不泄露 API Key、URL 和完整请求头的脱敏错误。
 * @param error 捕获到的未知异常。
 * @returns 已分类的脱敏 AI 错误。
 * @author zhenghq
 */
export function normalizeAiNetworkError(error: unknown): AiError {
  if (error instanceof AiError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new AiError('timeout', translateMain('ai.error.timeout'), { cause: error })
  }
  return new AiError('network', translateMain('ai.error.network'), { cause: error })
}
