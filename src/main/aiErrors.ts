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
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    options: AiErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AiError'
  }
}

/**
 * 根据 HTTP 状态码创建脱敏分类错误。
 * @param status HTTP 状态码。
 * @returns 不包含服务端原始详情和凭证的 AI 错误。
 * @author zhenghq
 */
export function createAiResponseError(status: number): AiError {
  if (status === 401 || status === 403) return new AiError('authentication', 'AI 鉴权失败，请检查 API Key')
  if (status === 429) return new AiError('rate-limit', 'AI 接口请求限流，请稍后重试')
  if (status === 404) return new AiError('not-found', 'AI 模型不存在或路径错误')
  if (status >= 500) return new AiError('service', 'AI 服务暂时不可用')
  return new AiError('service', `AI 服务返回错误（HTTP ${status}）`)
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
    return new AiError('timeout', 'AI 请求超时', { cause: error })
  }
  return new AiError('network', 'AI 网络连接失败', { cause: error })
}
