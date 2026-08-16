/**
 * 在统一的 AbortController 超时边界内执行钉钉网络请求。
 * @param timeoutMs 请求允许执行的最大毫秒数。
 * @param request 接收 AbortSignal 并执行网络请求的回调。
 * @returns 请求回调的异步结果。
 * @author zhenghq
 */
export async function runDingTalkRequestWithTimeout<T>(
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await request(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
