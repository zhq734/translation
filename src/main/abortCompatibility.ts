/**
 * Electron 22 / Node 16 可用的请求取消兼容层。
 *
 * 旧运行时没有 `AbortSignal.timeout()`，这里用普通 AbortController 组合父信号，
 * 并提供可主动清理的轻量超时信号，避免超时定时器与监听器长期占用资源。
 *
 * @author zhenghq
 */

/** 超时信号及清理函数。 */
export interface TimeoutSignal {
  /** 与父信号联动的请求信号。 */
  signal: AbortSignal
  /** 清理定时器和父信号监听器；调用后超时信号保持原状态，不再继续变更。 */
  dispose(): void
}

/**
 * 创建带超时与可选父信号联动的请求信号。
 * @param timeoutMs 超时毫秒数。
 * @param parentSignal 可选父取消信号。
 * @returns 请求信号与幂等清理函数。
 * @author zhenghq
 */
export function createTimeoutSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal
): TimeoutSignal {
  const controller = new AbortController()
  let disposed = false
  const abortFromParent = (): void => controller.abort(parentSignal?.reason)
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason)
    else parentSignal.addEventListener('abort', abortFromParent, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs))
  // 超时定时器不应单独阻止 Node 进程退出。
  timer.unref?.()
  const nativeSignal = controller.signal
  // 原生 AbortSignal 的 aborted 一旦变为 true 就无法复位；对外代理在清理后报告未中止，
  // 同时仍把 addEventListener、throwIfAborted 等方法绑定到原生信号以保留真实取消能力。
  const signal = new Proxy(nativeSignal, {
    get(target, property): unknown {
      if (property === 'aborted' && disposed) return false
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as AbortSignal
  return {
    signal,
    dispose(): void {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }
}
