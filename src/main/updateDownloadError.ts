/**
 * 更新下载流程中与界面语言无关的稳定错误码。
 *
 * 分片下载、手动 DMG 下载与 electron-updater 适配层都会抛出面向用户的
 * 错误文案；文案本身需要跟随界面语言，但重试、续传、取消等控制流必须依赖
 * 与语言无关的稳定标识。该模块用错误码承担控制流语义，文案只负责展示。
 * @author zhenghq
 */
export type UpdateDownloadErrorCode =
  | 'cancelled'
  | 'network-interrupted'
  | 'request-timeout'
  | 'read-timeout'
  | 'segment-failed'
  | 'write-failed'
  | 'http-error'
  | 'length-mismatch'
  | 'checksum-mismatch'
  | 'invalid-url'
  | 'insecure-url'
  | 'not-dmg'
  | 'redirect-missing-location'
  | 'too-many-redirects'
  | 'download-http-failed'
  | 'integrity-failed'
  | 'open-failed'
  | 'unknown'

/**
 * 携带稳定错误码的更新下载异常。
 * @author zhenghq
 */
export class UpdateDownloadError extends Error {
  /** 与界面语言无关的稳定错误码。 */
  readonly code: UpdateDownloadErrorCode

  /**
   * 创建带错误码的更新下载异常。
   * @param code 稳定错误码，用于重试、续传与取消判定。
   * @param message 当前界面语言下的用户可见文案。
   * @author zhenghq
   */
  constructor(code: UpdateDownloadErrorCode, message: string) {
    super(message)
    this.name = 'UpdateDownloadError'
    this.code = code
  }
}

/**
 * 构造带错误码的更新下载异常。
 * @param code 稳定错误码。
 * @param message 当前界面语言下的用户可见文案。
 * @returns 新的更新下载异常。
 * @author zhenghq
 */
export function createUpdateDownloadError(
  code: UpdateDownloadErrorCode,
  message: string
): UpdateDownloadError {
  return new UpdateDownloadError(code, message)
}

/**
 * 读取异常携带的更新下载错误码。
 * @param error 待检查的异常。
 * @returns 命中时返回错误码，否则返回 undefined。
 * @author zhenghq
 */
export function getUpdateDownloadErrorCode(
  error: unknown
): UpdateDownloadErrorCode | undefined {
  return error instanceof UpdateDownloadError ? error.code : undefined
}

/**
 * 判断异常是否属于指定的更新下载错误码。
 * @param error 待检查的异常。
 * @param code 期望匹配的错误码。
 * @returns 错误码一致时返回 true。
 * @author zhenghq
 */
export function isUpdateDownloadErrorCode(
  error: unknown,
  code: UpdateDownloadErrorCode
): boolean {
  return getUpdateDownloadErrorCode(error) === code
}

/**
 * 判断异常是否表示可自动重试并续传的连接中断。
 * @param error 待检查的异常。
 * @returns 属于可续传网络故障时返回 true。
 * @author zhenghq
 */
export function isResumableUpdateDownloadError(error: unknown): boolean {
  const code = getUpdateDownloadErrorCode(error)
  return (
    code === 'network-interrupted' ||
    code === 'request-timeout' ||
    code === 'read-timeout' ||
    code === 'segment-failed'
  )
}

/**
 * 判断异常是否表示用户主动取消下载。
 * @param error 待检查的异常。
 * @returns 属于用户取消时返回 true。
 * @author zhenghq
 */
export function isCancelledUpdateDownloadError(error: unknown): boolean {
  return getUpdateDownloadErrorCode(error) === 'cancelled'
}

/**
 * 判断异常是否表示下载连接超时。
 * @param error 待检查的异常。
 * @returns 属于超时类错误时返回 true。
 * @author zhenghq
 */
export function isTimeoutUpdateDownloadError(error: unknown): boolean {
  const code = getUpdateDownloadErrorCode(error)
  return code === 'request-timeout' || code === 'read-timeout'
}
