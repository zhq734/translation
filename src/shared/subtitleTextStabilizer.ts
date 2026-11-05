/** 字幕文本稳定器配置。 */
export interface StabilizedTextControllerOptions {
  /** 文本停止变化多久后提交，单位毫秒。 */
  settleMs: number
  /** 从首次出现待提交文本起最长等待多久，单位毫秒。 */
  maxWaitMs: number
  /** 提交稳定文本。 */
  onCommit: (text: string) => void
  /** 定时器工厂，便于测试控制提交时机。 */
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown
  /** 清除定时器函数。 */
  clearTimeoutFn?: (handle: unknown) => void
}

/**
 * 将高频增长的字幕文本转换为稳定快照，避免逐 token 改写界面。
 * @author zhenghq
 */
export class StabilizedTextController {
  private readonly settleMs: number
  private readonly maxWaitMs: number
  private readonly onCommit: (text: string) => void
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void
  private streamKey: string | null = null
  private committedText = ''
  private pendingText: string | null = null
  private settleTimer: unknown = null
  private maxWaitTimer: unknown = null

  /**
   * 创建字幕文本稳定器。
   * @param options 稳定时长、提交回调与定时器依赖。
   * @author zhenghq
   */
  constructor(options: StabilizedTextControllerOptions) {
    this.settleMs = Number.isFinite(options.settleMs) ? Math.max(0, options.settleMs) : 0
    this.maxWaitMs = Number.isFinite(options.maxWaitMs) ? Math.max(0, options.maxWaitMs) : 0
    this.onCommit = options.onCommit
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /**
   * 接收一版字幕文本，并在稳定或达到最大等待时间后提交。
   * @param text 最新字幕文本。
   * @param streamKey 当前段落、显示模式与文本轨道组成的流标识。
   * @param immediate 是否跳过稳定等待立即提交。
   * @returns 无返回值。
   * @author zhenghq
   */
  push(text: string, streamKey: string, immediate = false): void {
    const streamChanged = streamKey !== this.streamKey
    if (streamChanged) {
      this.clearTimers()
      this.streamKey = streamKey
      this.pendingText = null
    }

    // 新段落、空文本和状态落定必须立即刷新，不能继续展示上一版内容。
    if (streamChanged || immediate || text.length === 0) {
      this.commit(text)
      return
    }
    if (text === this.pendingText) return
    if (text === this.committedText) {
      this.pendingText = null
      this.clearTimers()
      return
    }

    this.pendingText = text
    if (this.settleTimer !== null) this.clearTimeoutFn(this.settleTimer)
    this.settleTimer = this.setTimeoutFn(() => {
      this.settleTimer = null
      this.commitPending(streamKey)
    }, this.settleMs)
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = this.setTimeoutFn(() => {
        this.maxWaitTimer = null
        this.commitPending(streamKey)
      }, this.maxWaitMs)
    }
  }

  /**
   * 清理全部待提交文本与计时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    this.clearTimers()
    this.pendingText = null
    this.streamKey = null
  }

  /**
   * 在流标识仍有效时提交等待中的最新文本。
   * @param streamKey 安排计时器时的流标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private commitPending(streamKey: string): void {
    if (streamKey !== this.streamKey || this.pendingText === null) return
    const text = this.pendingText
    this.pendingText = null
    this.clearTimers()
    this.commit(text)
  }

  /**
   * 提交文本并避免重复刷新相同内容。
   * @param text 待提交文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  private commit(text: string): void {
    this.pendingText = null
    this.clearTimers()
    if (text === this.committedText) return
    this.committedText = text
    this.onCommit(text)
  }

  /**
   * 清除稳定计时与最大等待计时。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearTimers(): void {
    if (this.settleTimer !== null) {
      this.clearTimeoutFn(this.settleTimer)
      this.settleTimer = null
    }
    if (this.maxWaitTimer !== null) {
      this.clearTimeoutFn(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
  }
}
