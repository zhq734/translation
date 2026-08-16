import type { DingTalkCheckStatus } from '../shared/types'

/** 钉钉内部错误分类。 */
export type DingTalkErrorKind =
  | 'configuration'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'parameter'
  | 'network'
  | 'service'

/** DingTalkError 的附加选项。 */
export interface DingTalkErrorOptions {
  /** 原始异常，仅用于保留 cause，不会进入公开消息。 */
  cause?: unknown
  /** 是否属于可通过刷新 Token 恢复的鉴权失效。 */
  authenticationInvalid?: boolean
}

/**
 * 表示已脱敏且分类后的钉钉调用错误。
 * @param kind 错误分类。
 * @param message 不含敏感值的内部摘要。
 * @param options 原因和鉴权失效标记。
 * @returns 钉钉错误实例。
 * @author zhenghq
 */
export class DingTalkError extends Error {
  readonly authenticationInvalid: boolean

  constructor(
    readonly kind: DingTalkErrorKind,
    message: string,
    options: DingTalkErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DingTalkError'
    this.authenticationInvalid = options.authenticationInvalid === true
  }
}

const AUTHENTICATION_CODES = new Set([40001, 40002, 40014, 42001])
const PERMISSION_CODES = new Set([43004, 50001, 60011, 60020])
const RATE_LIMIT_CODES = new Set([88, 90018, 130101])
const PARAMETER_CODES = new Set([40003, 40004, 40035])

/**
 * 根据 HTTP 状态和钉钉错误码创建脱敏分类错误。
 * @param status HTTP 状态码。
 * @param errorCode 钉钉业务错误码。
 * @returns 不包含服务端原始敏感信息的钉钉错误。
 * @author zhenghq
 */
export function createDingTalkResponseError(status: number, errorCode?: number): DingTalkError {
  if (status === 401 || AUTHENTICATION_CODES.has(errorCode ?? -1)) {
    return new DingTalkError('authentication', '钉钉鉴权失败', {
      authenticationInvalid: AUTHENTICATION_CODES.has(errorCode ?? -1)
    })
  }
  if (status === 403 || PERMISSION_CODES.has(errorCode ?? -1)) {
    return new DingTalkError('permission', '钉钉应用权限不足')
  }
  if (status === 429 || RATE_LIMIT_CODES.has(errorCode ?? -1)) {
    return new DingTalkError('rate-limit', '钉钉接口请求过于频繁')
  }
  if (status === 400 || PARAMETER_CODES.has(errorCode ?? -1)) {
    return new DingTalkError('parameter', '钉钉请求参数无效')
  }
  return new DingTalkError('service', '钉钉服务暂时不可用')
}

/**
 * 将未知网络异常转换为不泄露 URL、Token 或 Secret 的钉钉错误。
 * @param error 捕获到的未知异常。
 * @returns 已分类的脱敏钉钉错误。
 * @author zhenghq
 */
export function normalizeDingTalkNetworkError(error: unknown): DingTalkError {
  if (error instanceof DingTalkError) return error
  const name = error instanceof Error ? error.name : ''
  const timeout = name === 'AbortError' || name === 'TimeoutError'
  return new DingTalkError('network', timeout ? '钉钉请求超时' : '钉钉网络连接失败', {
    cause: error
  })
}

/**
 * 将内部钉钉错误转换为设置页可展示的结构化脱敏状态。
 * @param error 钉钉内部错误或未知异常。
 * @returns 不包含凭证、Token 和完整 URL 的检测状态。
 * @author zhenghq
 */
export function toDingTalkCheckStatus(error: unknown): DingTalkCheckStatus {
  const normalized = error instanceof DingTalkError
    ? error
    : normalizeDingTalkNetworkError(error)
  switch (normalized.kind) {
    case 'configuration':
      return { ok: false, code: 'incomplete', message: '钉钉配置不完整，请填写 CorpId、ClientId 和 ClientSecret' }
    case 'authentication':
      return { ok: false, code: 'authentication', message: '钉钉鉴权失败，请检查 CorpId、ClientId 和 ClientSecret' }
    case 'permission':
      return { ok: false, code: 'permission', message: '钉钉应用未获得文本翻译权限' }
    case 'rate-limit':
      return { ok: false, code: 'rate-limit', message: '钉钉接口请求过于频繁，请稍后重试' }
    case 'parameter':
      return { ok: false, code: 'parameter', message: '钉钉翻译请求参数不受支持' }
    case 'network':
      return { ok: false, code: 'network', message: normalized.message }
    default:
      return { ok: false, code: 'service', message: '钉钉服务暂时不可用，请稍后重试' }
  }
}
