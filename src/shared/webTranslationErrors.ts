/**
 * 判断错误是否来自远程网页主 Frame 在导航或销毁期间失效。
 * @param error 待判断的异常值。
 * @returns 如果属于 Frame 生命周期瞬态错误则返回 true。
 * @author zhenghq
 */
export function isDisposedWebFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /render frame was disposed|webframemain could not be accessed|frame was disposed|object has been destroyed|webcontents was destroyed/iu.test(message)
}

/**
 * 将 Electron IPC 调用包装的异常还原为面向用户的提示文本。
 * @param error IPC 调用或业务逻辑抛出的异常值。
 * @param fallback 无法提取有效错误文本时使用的兜底提示。
 * @returns 可直接显示在界面上的错误文本。
 * @author zhenghq
 */
export function normalizeWebTranslationError(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : ''
  const message = rawMessage
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/u, '')
    .trim()
  return message || fallback
}
