import type { TriggerMode } from '../shared/types'

/** 全局划词监听暂停原因。 */
export type SelectionListenerPauseReason = 'ocr' | 'shutdown'

/** 监听控制器依赖。 */
export interface SelectionListenerControllerOptions {
  /** 按当前回调配置启动 uIOhook。 */
  start: () => boolean
  /** 停止 uIOhook 并解除回调。 */
  stop: () => void
  /** 记录监听状态诊断信息。 */
  log?: (message: string) => void
}

/**
 * 统一维护划词监听的期望状态、暂停原因和实际运行状态。
 * @author zhenghq
 */
export class SelectionListenerController {
  private mode: TriggerMode = 'hotkey'
  private readonly pauseReasons = new Set<SelectionListenerPauseReason>()
  private running = false

  /**
   * 创建监听生命周期控制器。
   * @param options 启停钩子和日志依赖。
   * @author zhenghq
   */
  constructor(private readonly options: SelectionListenerControllerOptions) {}

  /**
   * 更新触发模式并刷新监听目标状态。
   * @param mode 当前触发模式。
   * @returns 无返回值。
   * @author zhenghq
   */
  setMode(mode: TriggerMode): void {
    this.mode = mode
    this.refresh()
  }

  /**
   * 增加监听暂停原因并刷新实际状态。
   * @param reason 暂停原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  pause(reason: SelectionListenerPauseReason): void {
    const wasPaused = this.pauseReasons.has(reason)
    this.pauseReasons.add(reason)
    if (!wasPaused) this.refresh()
  }

  /**
   * 移除监听暂停原因并刷新实际状态。
   * @param reason 暂停原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  resume(reason: SelectionListenerPauseReason): void {
    if (!this.pauseReasons.delete(reason)) return
    this.refresh()
  }

  /**
   * 根据期望状态重新计算并应用监听目标。
   * @returns 无返回值。
   * @author zhenghq
   */
  refresh(): void {
    const shouldRun = this.mode !== 'hotkey' && this.pauseReasons.size === 0
    if (shouldRun) {
      // 已运行时保持幂等；启动失败时 running 为 false，后续 refresh 会重新尝试。
      if (!this.running) this.start()
      return
    }
    if (this.running) this.options.stop()
    this.running = false
  }

  /**
   * 停止监听并记录关闭暂停原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  stop(): void {
    this.pauseReasons.add('shutdown')
    if (this.running) this.options.stop()
    this.running = false
  }

  /**
   * 返回 OCR 是否暂停了普通划词监听。
   * @returns 存在 OCR 暂停原因时返回 true。
   * @author zhenghq
   */
  isPausedForOcr(): boolean {
    return this.pauseReasons.has('ocr')
  }

  /**
   * 返回全局钩子实际运行状态。
   * @returns 钩子正在运行时返回 true。
   * @author zhenghq
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * 启动一次全局划词监听并保留失败后的可重试状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private start(): void {
    const started = this.options.start()
    this.running = started
    if (!started) this.options.log?.('[selectionListener] 全局划词监听启动失败，后续 refresh 可重试')
  }
}
