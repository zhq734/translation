/**
 * 节流调度器依赖的定时器接口。
 *
 * 抽出接口是为了让纯逻辑单元测试注入假定时器，避免依赖真实时间。
 * @author zhenghq
 */
export interface ThrottledSchedulerTimers {
  /**
   * 安排一次延时回调。
   * @param handler 到点执行的回调。
   * @param ms 延时毫秒数。
   * @returns 可用于取消的定时器句柄。
   * @author zhenghq
   */
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>
  /**
   * 取消一次已安排的延时回调。
   * @param handle 定时器句柄。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

/**
 * 节流调度器句柄。
 *
 * 本身可直接当作函数调用以请求一次调度，并附带 request/cancel 便于显式表达
 * 意图或取消。
 * @author zhenghq
 */
export interface ThrottledScheduler {
  /**
   * 请求一次调度；在节流窗口内多次请求只会合并为一次回调。
   * @returns 无返回值。
   * @author zhenghq
   */
  (): void
  /**
   * 请求一次调度，语义等同直接调用调度器本身。
   * @returns 无返回值。
   * @author zhenghq
   */
  request(): void
  /**
   * 取消尚未触发的调度，用于窗口关闭等场景。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancel(): void
}

/**
 * 默认基于宿主环境的定时器实现。
 * @author zhenghq
 */
const defaultTimers: ThrottledSchedulerTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle)
}

/**
 * 创建带尾沿触发的节流调度器。
 *
 * 与去抖（debounce）不同：连续高频请求**不会**重置计时器，因此回调会按固定
 * 间隔周期性触发，而不是被后续请求无限推迟。窗口结束时的最后一次请求由尾沿
 * 回调兜底触发，保证停止请求后仍会执行一次，不会丢失最终状态。
 * @param callback 到期执行的回调，通常为测量并上报尺寸。
 * @param intervalMs 节流窗口毫秒数，取值下限为 1。
 * @param timers 可注入的定时器实现，默认使用宿主环境定时器。
 * @returns 节流调度器句柄。
 * @author zhenghq
 */
export function createThrottledScheduler(
  callback: () => void,
  intervalMs: number,
  timers: ThrottledSchedulerTimers = defaultTimers
): ThrottledScheduler {
  const interval = Math.max(1, Math.floor(intervalMs))
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false

  /**
   * 节流窗口到期时执行回调，并处理窗口内累计的请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flush = (): void => {
    timer = null
    if (!pending) return
    pending = false
    callback()
    // 回调执行期间到达的新请求需要开启下一个窗口，避免被吞掉。
    if (pending) request()
  }

  /**
   * 请求一次调度。
   * @returns 无返回值。
   * @author zhenghq
   */
  function request(): void {
    pending = true
    if (timer !== null) return
    timer = timers.setTimeout(flush, interval)
  }

  /**
   * 取消尚未触发的调度。
   * @returns 无返回值。
   * @author zhenghq
   */
  function cancel(): void {
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
    pending = false
  }

  const scheduler = (() => request()) as ThrottledScheduler
  scheduler.request = request
  scheduler.cancel = cancel
  return scheduler
}
