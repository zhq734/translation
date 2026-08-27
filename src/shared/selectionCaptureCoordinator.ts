import { normalizeSelectedText } from './selectionText'

/** 选区按钮或快捷键翻译时使用的屏幕锚点。 */
export interface SelectionAnchor {
  x: number
  y: number
}

/** 取词失败的具体原因，用于上层区分空选区、超时、应用不支持与权限错误。 */
export type SelectionFailureReason =
  | 'empty'
  | 'timeout'
  | 'unsupported'
  | 'permission'
  | 'unknown'

/** 底层取词函数返回的结构化结果，包含文本、失败原因与图片选区标志。 */
export interface SelectionCaptureOutcome {
  /** 取到的选中文字，未取到时为空字符串。 */
  text: string
  /** 未取到文字时的失败原因。 */
  reason?: SelectionFailureReason
  /** 是否通过复制捕获到图片选区（仅图片、无可翻译文本）。 */
  hasImage?: boolean
}

/** 一次取词操作的结果，包含文字、锚点、失败原因、图片标志及可能发生的错误。 */
export interface SelectionCaptureResult {
  text: string
  anchor?: SelectionAnchor
  error?: Error
  /** 未取到文字时的失败原因，供上层选择对应提示。 */
  reason?: SelectionFailureReason
  /** 是否通过复制捕获到图片选区（仅图片、无可翻译文本）。 */
  hasImage?: boolean
}

type CaptureSelection = (signal: AbortSignal) => Promise<SelectionCaptureOutcome>

/**
 * 点击“译”按钮后等待尚未完成的只读预取的最长时间（毫秒）。
 * 该窗口必须远小于原生直读超时，保证按钮点击响应有界。
 */
export const PREPARED_PREFETCH_WAIT_MS = 60

/** 有界消费只读预取的结果状态。 */
export type PreparedConsumptionStatus =
  | 'hit'
  | 'empty'
  | 'absent'
  | 'timeout'
  | 'stale'

/** 一次有界消费只读预取的结果，用于按钮入口决定是否回退复制兜底。 */
export interface PreparedConsumption {
  /** 本次消费的判定状态。 */
  status: PreparedConsumptionStatus
  /** 命中时的预取结果；未命中时为 null。 */
  result: SelectionCaptureResult | null
  /** 实际等待预取的耗时（毫秒）。 */
  waitedMs: number
}

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
 * 在有界时间内等待尚未完成的只读预取，超时后立即返回而不取消预取。
 * @param pending 正在进行的预取 Promise。
 * @param waitMs 允许等待的最长时间（毫秒）。
 * @returns 预取在窗口内完成时返回 settled 为 true 及其结果，超时返回 settled 为 false。
 * @author zhenghq
 */
function waitForPendingPreparation(
  pending: Promise<SelectionCaptureResult | null>,
  waitMs: number
): Promise<{ settled: boolean; result: SelectionCaptureResult | null }> {
  if (waitMs <= 0) return Promise.resolve({ settled: false, result: null })

  return new Promise((resolve) => {
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      resolve({ settled: false, result: null })
    }, waitMs)

    void pending.then(
      (result) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve({ settled: true, result })
      },
      () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve({ settled: true, result: null })
      }
    )
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
   * @param prefetchSelection 按钮显示期间执行只读预取的异步函数；不注入复制键、不写剪贴板。
   * @param buttonCaptureSelection 点击“译”按钮后执行的专用取词函数；macOS/Windows 优先复制，避免再次等待原生直读。
   * @author zhenghq
   */
  constructor(
    private readonly captureSelection: CaptureSelection,
    private readonly prefetchSelection?: CaptureSelection,
    private readonly buttonCaptureSelection?: CaptureSelection
  ) {}

  /**
   * 在显示“译”按钮后后台捕获当前选中文字，并缓存结果供按钮点击时消费。
   * @param anchor 当前选区右上角锚点。
   * @param delayMs 开始系统取词前等待选区稳定的时长（毫秒）。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  prepare(anchor: SelectionAnchor, delayMs = 0): Promise<SelectionCaptureResult | null> {
    this.preparedSelection = null
    const pending = this.enqueue(anchor, true, delayMs, true)
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
   * 取消仍在进行的只读预取，并执行点击按钮专用取词，避免 AX/UIA 直读超时让选区过期。
   * @param anchor 翻译弹窗使用的选区锚点。
   * @returns 当前请求的捕获结果；如果请求已被更新则返回 null。
   * @author zhenghq
   */
  captureFromButton(anchor?: SelectionAnchor): Promise<SelectionCaptureResult | null> {
    this.preparedSelection = null
    this.pendingPreparation = null
    return this.enqueue(anchor, false, 0, false, true)
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
   * 在有界时间内消费只读预取结果，避免快速点击“译”按钮时丢弃即将完成的原生取词。
   * 已完成且含文本的缓存立即命中；预取仍在进行时最多等待 waitMs，超时后仅返回未命中，
   * 由调用方继续执行按钮专用取词，等待过程不会取消预取也不会无界阻塞按钮点击。
   * @param waitMs 允许等待进行中预取的最长时间（毫秒），默认 PREPARED_PREFETCH_WAIT_MS。
   * @returns 本次消费的判定状态、命中的预取结果与实际等待耗时。
   * @author zhenghq
   */
  async consumePreparedBounded(
    waitMs = PREPARED_PREFETCH_WAIT_MS
  ): Promise<PreparedConsumption> {
    const startedAt = Date.now()
    const requestId = this.latestRequestId

    const prepared = this.consumePrepared()
    if (prepared?.text) return { status: 'hit', result: prepared, waitedMs: 0 }
    if (prepared) return { status: 'empty', result: null, waitedMs: 0 }

    const pending = this.pendingPreparation
    if (!pending) return { status: 'absent', result: null, waitedMs: 0 }

    const { settled } = await waitForPendingPreparation(pending, waitMs)
    const waitedMs = Date.now() - startedAt

    // 等待期间发生新的手势、复制、粘贴或显式失效时，过期预取结果一律丢弃。
    if (requestId !== this.latestRequestId) {
      this.preparedSelection = null
      return { status: 'stale', result: null, waitedMs }
    }

    const late = this.consumePrepared()
    if (late?.text) return { status: 'hit', result: late, waitedMs }
    if (settled) return { status: late ? 'empty' : 'absent', result: null, waitedMs }
    return { status: 'timeout', result: null, waitedMs }
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
   * @param usePrefetch 是否使用按钮显示期间的只读预取函数。
   * @param useButtonCapture 是否使用点击“译”按钮后的专用取词函数。
   * @returns 排队后的取词 Promise。
   * @author zhenghq
   */
  private enqueue(
    anchor: SelectionAnchor | undefined,
    prepare: boolean,
    delayMs: number,
    usePrefetch = false,
    useButtonCapture = false
  ): Promise<SelectionCaptureResult | null> {
    const requestId = ++this.latestRequestId
    this.abortActiveCapture()
    const task = this.captureChain
      .catch(() => undefined)
      .then(async () => {
        if (requestId !== this.latestRequestId) return null

        const controller = new AbortController()
        this.activeCaptureController = controller
        let outcome: SelectionCaptureOutcome = { text: '' }
        let error: Error | undefined
        try {
          await waitForCaptureDelay(delayMs, controller.signal)
          if (controller.signal.aborted || requestId !== this.latestRequestId) return null
          const capture = usePrefetch && this.prefetchSelection
            ? this.prefetchSelection
            : useButtonCapture && this.buttonCaptureSelection
              ? this.buttonCaptureSelection
              : this.captureSelection
          const raw = await capture(controller.signal)
          // 兼容返回纯字符串的底层实现，同时支持携带失败原因的结构化结果。
          if (typeof raw === 'string') {
            outcome = { text: normalizeSelectedText(raw) }
          } else {
            outcome = {
              text: normalizeSelectedText(raw?.text ?? ''),
              reason: raw?.reason,
              hasImage: Boolean(raw?.hasImage)
            }
          }
        } catch (cause) {
          error = cause instanceof Error ? cause : new Error(String(cause))
        } finally {
          if (this.activeCaptureController === controller) {
            this.activeCaptureController = null
          }
        }

        if (requestId !== this.latestRequestId || controller.signal.aborted) return null
        const result: SelectionCaptureResult = { text: outcome.text }
        if (outcome.reason) result.reason = outcome.reason
        if (outcome.hasImage) result.hasImage = true
        if (anchor) result.anchor = anchor
        if (error) result.error = error
        if (prepare) this.preparedSelection = result
        return result
      })

    this.captureChain = task.then(() => undefined)
    return task
  }
}
