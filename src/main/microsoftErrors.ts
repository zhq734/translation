import type { MicrosoftCheckStatus } from '../shared/types'

/** 微软翻译内部错误分类。 */
export type MicrosoftErrorKind =
  | 'configuration'
  | 'authentication'
  | 'permission'
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
 * @param message 不含订阅密钥的内部摘要。
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
 * 根据 HTTP 状态创建脱敏分类错误。
 * @param status HTTP 状态码。
 * @returns 不包含 Azure 响应详情或订阅密钥的微软翻译错误。
 * @author zhenghq
 */
export function createMicrosoftResponseError(status: number): MicrosoftError {
  if (status === 401) return new MicrosoftError('authentication', '微软翻译订阅密钥或区域无效')
  if (status === 403) return new MicrosoftError('permission', '微软翻译资源无访问权限')
  if (status === 429) return new MicrosoftError('rate-limit', '微软翻译接口请求过于频繁')
  if (status === 400) return new MicrosoftError('parameter', '微软翻译请求参数无效')
  return new MicrosoftError('service', '微软翻译服务暂时不可用')
}

/**
 * 将未知网络异常转换为不泄露 Azure 订阅密钥和完整请求地址的错误。
 * @param error 捕获到的未知异常。
 * @returns 已分类的脱敏微软翻译错误。
 * @author zhenghq
 */
export function normalizeMicrosoftNetworkError(error: unknown): MicrosoftError {
  if (error instanceof MicrosoftError) return error
  const name = error instanceof Error ? error.name : ''
  const timeout = name === 'AbortError' || name === 'TimeoutError'
  return new MicrosoftError('network', timeout ? '微软翻译请求超时' : '微软翻译网络连接失败', {
    cause: error
  })
}

/**
 * 将内部微软翻译错误转换为设置页可展示的结构化脱敏状态。
 * @param error 微软翻译内部错误或未知异常。
 * @returns 不包含订阅密钥、请求地址和服务端原始详情的检测状态。
 * @author zhenghq
 */
export function toMicrosoftCheckStatus(error: unknown): MicrosoftCheckStatus {
  const normalized = error instanceof MicrosoftError
    ? error
    : normalizeMicrosoftNetworkError(error)
  switch (normalized.kind) {
    case 'configuration':
      return { ok: false, code: 'incomplete', message: '微软翻译配置不完整，请填写订阅密钥' }
    case 'authentication':
      return { ok: false, code: 'authentication', message: '微软翻译订阅密钥或区域无效，请检查配置' }
    case 'permission':
      return { ok: false, code: 'permission', message: '微软翻译资源无访问权限，请检查 Azure 资源权限' }
    case 'rate-limit':
      return { ok: false, code: 'rate-limit', message: '微软翻译接口请求过于频繁，请稍后重试' }
    case 'parameter':
      return { ok: false, code: 'parameter', message: '微软翻译请求参数不受支持' }
    case 'network':
      return { ok: false, code: 'network', message: normalized.message }
    default:
      return { ok: false, code: 'service', message: '微软翻译服务暂时不可用，请稍后重试' }
  }
}
