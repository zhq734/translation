import { normalizeSelectedText } from './selectionText'

/** 选区按钮或快捷键翻译时使用的屏幕锚点。 */
export interface SelectionAnchor {
  x: number
  y: number
}

/** 一次取词操作的结果，包含文字、锚点及可能发生的错误。 */
export interface SelectionCaptureResult {
  text: string
  anchor?: SelectionAnchor
  error?: Error
}

type CaptureSelection = (signal: AbortSignal) => Promise<string>

/**
 * 在不阻塞主线程的前提下等待选区稳定，并支持请求失效时立即结束等待。
 * @param delayMs 等待时长（毫秒）。
 * @param signal 当前取词请求的取消信号。
 * @returns 等待完成后的 Promise。
 * @author zhenghq
 */
function waitForCaptureDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    const timer = setTimeout(finish, delayMs)

    /**
     * 结束选区稳定等待并清理定时器与取消监听。
     * @returns 无返回值。
     * @author zhenghq
     */
    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }

    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/**
 * 串行协调选中文字的捕获，并支持在按钮显示后后台预取文字。
 * @author zhenghq
 */
export class SelectionCaptureCoordinator {
  private latestRequestId = 0
  private captureChain: Promise<void> = Promise.resolve()
  private preparedSelection: SelectionCaptureResult | null = null
  private pendingPreparation: Promise<SelectionCaptureResult | null> | null = null
  private activeCaptureController: AbortController | null = null

  /**
   * 创建选中文字捕获协调器。
   * @param captureSelection 实际执行系统取词的异步函数。
   * @author zhenghq
   */
  constructor(private readonly captureSelection: CaptureSelection) {}

  /**
   * 在显示“译”按钮后后台捕获当前选中文字，并缓存结果供按钮点击时消费。
   * @param anchor 当前选区右上角锚点。
   * @param delayMs 开始系统取词前等待选区稳定的时长（毫秒）。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  prepare(anchor: SelectionAnchor, delayMs = 0): Promise<SelectionCaptureResult | null> {
    this.preparedSelection = null
    const pending = this.enqueue(anchor, true, delayMs)
    this.pendingPreparation = pending
    void pending.then(() => {
      if (this.pendingPreparation === pending) this.pendingPreparation = null
    })
    return pending
  }

  /**
   * 捕获一次需要立即翻译的选中文字。
   * @param anchor 翻译弹窗使用的选区锚点。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  capture(anchor?: SelectionAnchor): Promise<SelectionCaptureResult | null> {
    this.preparedSelection = null
    return this.enqueue(anchor, false, 0)
  }

  /**
   * 消费按钮显示后已经缓存的选中文字，避免点击按钮后选区失效。
   * @returns 已缓存的捕获结果；没有可用缓存时返回 null。
   * @author zhenghq
   */
  consumePrepared(): SelectionCaptureResult | null {
    const result = this.preparedSelection
    this.preparedSelection = null
    return result
  }

  /**
   * 消费已经完成的预取结果；预取仍在执行时等待其完成，确保快速点击不会中止原选区取词。
   * @returns 当前预取结果；没有可消费结果或已被其他点击消费时返回 null。
   * @author zhenghq
   */
  async consumePreparedOrWait(): Promise<SelectionCaptureResult | null> {
    const prepared = this.consumePrepared()
    if (prepared) return prepared
    const pending = this.pendingPreparation
    if (!pending) return null
    await pending
    return this.consumePrepared()
  }

  /**
   * 使当前及尚未完成的选区捕获请求失效。
   * @returns 无返回值。
   * @author zhenghq
   */
  invalidate(): void {
    this.latestRequestId += 1
    this.preparedSelection = null
    this.pendingPreparation = null
    this.abortActiveCapture()
  }

  /**
   * 中止正在进行的系统取词，让粘贴或外部点击可以立即取回原剪贴板。
   * @returns 无返回值。
   * @author zhenghq
   */
  private abortActiveCapture(): void {
    this.activeCaptureController?.abort()
    this.activeCaptureController = null
  }

  /**
   * 将取词请求串行排队，并只保留最新一次请求的结果。
   * @param anchor 当前请求的选区锚点。
   * @param prepare 是否把捕获结果保存为按钮点击时使用的缓存。
   * @param delayMs 开始系统取词前等待选区稳定的时长（毫秒）。
   * @returns 排队后的取词 Promise。
   * @author zhenghq
   */
  private enqueue(
    anchor: SelectionAnchor | undefined,
    prepare: boolean,
    delayMs: number
  ): Promise<SelectionCaptureResult | null> {
    const requestId = ++this.latestRequestId
    this.abortActiveCapture()
    const task = this.captureChain
      .catch(() => undefined)
      .then(async () => {
        if (requestId !== this.latestRequestId) return null

        const controller = new AbortController()
        this.activeCaptureController = controller
        let text = ''
        let error: Error | undefined
        try {
          await waitForCaptureDelay(delayMs, controller.signal)
          if (controller.signal.aborted || requestId !== this.latestRequestId) return null
          text = normalizeSelectedText(await this.captureSelection(controller.signal))
        } catch (cause) {
          error = cause instanceof Error ? cause : new Error(String(cause))
        } finally {
          if (this.activeCaptureController === controller) {
            this.activeCaptureController = null
          }
        }

        if (requestId !== this.latestRequestId || controller.signal.aborted) return null
        const result: SelectionCaptureResult = { text }
        if (anchor) result.anchor = anchor
        if (error) result.error = error
        if (prepare) this.preparedSelection = result
        return result
      })

    this.captureChain = task.then(() => undefined)
    return task
  }
}
