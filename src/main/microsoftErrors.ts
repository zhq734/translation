import type { MicrosoftCheckStatus } from '../shared/types'
import { translateMain } from './messages'

/** 微软翻译内部错误分类。 */
export type MicrosoftErrorKind =
  | 'authentication'
  | 'rate-limit'
  | 'parameter'
  | 'network'
  | 'service'

/** MicrosoftError 的附加选项。 */
export interface MicrosoftErrorOptions {
  /** 原始异常，仅用于保留 cause，不会进入公开消息。 */
  cause?: unknown
}

/**
 * 表示已脱敏且分类后的微软翻译调用错误。
 * @param kind 错误分类。
 * @param message 不含网页 Token、Key 或完整地址的内部摘要。
 * @param options 原始异常信息。
 * @returns 微软翻译错误实例。
 * @author zhenghq
 */
export class MicrosoftError extends Error {
  constructor(
    readonly kind: MicrosoftErrorKind,
    message: string,
    options: MicrosoftErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MicrosoftError'
  }
}

/**
 * 根据 Bing 在线翻译 HTTP 状态创建脱敏分类错误。
 * @param status HTTP 状态码。
 * @returns 不包含网页响应详情、Token 或 Key 的微软翻译错误。
 * @author zhenghq
 */
export function createMicrosoftResponseError(status: number): MicrosoftError {
  if (status === 401 || status === 403) {
    return new MicrosoftError('authentication', translateMain('microsoft.error.authentication'))
  }
  if (status === 429) {
    return new MicrosoftError('rate-limit', translateMain('microsoft.error.rateLimit'))
  }
  if (status === 400) {
    return new MicrosoftError('parameter', translateMain('microsoft.error.parameter'))
  }
  return new MicrosoftError('service', translateMain('microsoft.error.serviceUnavailable'))
}

/**
 * 将未知网络异常转换为不泄露网页 Token、Key 和完整请求地址的错误。
 * @param error 捕获到的未知异常。
 * @returns 已分类的脱敏微软翻译错误。
 * @author zhenghq
 */
export function normalizeMicrosoftNetworkError(error: unknown): MicrosoftError {
  if (error instanceof MicrosoftError) return error
  const name = error instanceof Error ? error.name : ''
  const timeout = name === 'AbortError' || name === 'TimeoutError'
  return new MicrosoftError(
    'network',
    translateMain(timeout ? 'microsoft.error.timeout' : 'microsoft.error.network'),
    { cause: error }
  )
}

/**
 * 将内部微软翻译错误转换为设置页可展示的结构化脱敏状态。
 * @param error 微软翻译内部错误或未知异常。
 * @returns 不包含网页 Token、Key、完整地址和服务端原始详情的检测状态。
 * @author zhenghq
 */
export function toMicrosoftCheckStatus(error: unknown): MicrosoftCheckStatus {
  const normalized = error instanceof MicrosoftError
    ? error
    : normalizeMicrosoftNetworkError(error)
  switch (normalized.kind) {
    case 'authentication':
      return {
        ok: false,
        code: 'authentication',
        message: translateMain('microsoft.error.authenticationStatus')
      }
    case 'rate-limit':
      return {
        ok: false,
        code: 'rate-limit',
        message: translateMain('microsoft.error.rateLimitStatus')
      }
    case 'parameter':
      return {
        ok: false,
        code: 'parameter',
        message: translateMain('microsoft.error.parameterStatus')
      }
    case 'network':
      return { ok: false, code: 'network', message: normalized.message }
    default:
      return {
        ok: false,
        code: 'service',
        message: translateMain('microsoft.error.serviceStatus')
      }
  }
}
