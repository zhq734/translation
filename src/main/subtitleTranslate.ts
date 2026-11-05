import type { DingTalkCredentials } from './dingtalkConfig'
import type { TranslateOutput } from './translate'
import type { Settings } from '../shared/types'

/** 字幕翻译结果对应的展示阶段。 */
export type SubtitleTranslationPhase = 'preview' | 'final'

/** 字幕翻译协调器依赖。 */
export interface SubtitleTranslationCoordinatorOptions {
  /** 读取当前设置快照。 */
  getSettings: () => Settings
  /** 读取钉钉凭证快照。 */
  getDingTalkCredentials: () => DingTalkCredentials | null
  /** 读取 AI API Key。 */
  getAiApiKey: () => string | null
  /** 读取 iTranslate API Key；为空时跳过该可选通道。 */
  getITranslateApiKey?: () => string | null
  /** 复用现有流式翻译运行时。 */
  translateStream: (
    text: string,
    settings: Settings,
    dingTalkCredentials: DingTalkCredentials | null,
    aiApiKey: string | null,
    options: {
      onDelta: (delta: string) => void
      signal?: AbortSignal
    },
    iTranslateApiKey?: string | null
  ) => Promise<TranslateOutput>
  /** 转发一段译文增量，并携带该任务对应的原文用于校验分段是否仍然有效。 */
  onDelta: (
    segmentId: string,
    delta: string,
    phase: SubtitleTranslationPhase,
    sourceText: string
  ) => void
  /** 标记段落翻译完成。 */
  onComplete: (segmentId: string) => void
  /** 报告单段 final 翻译失败，不得向识别链路抛出。 */
  onError: (segmentId: string, error: Error) => void
  /** 清空指定阶段的旧译文，避免内容变化后短暂展示过期结果。 */
  onReset?: (segmentId: string, phase: SubtitleTranslationPhase) => void
  /** partial 稳定多久后发起预翻译，默认 250ms。 */
  previewDebounceMs?: number
  /** partial 连续变化时最多等待多久就翻译最新草稿，默认 1000ms。 */
  previewMaxWaitMs?: number
  /** 两次预览翻译请求之间的最短间隔，默认 1500ms；设为 0 可关闭。 */
  previewMinIntervalMs?: number
  /** 预览翻译遇到限流后的冷却时长，默认 30000ms；设为 0 可关闭。 */
  previewRateLimitCooldownMs?: number
  /** final 翻译最大尝试次数（含首次），默认 3 次。 */
  finalMaxAttempts?: number
  /** final 翻译首次重试等待时间，默认 600ms，后续按指数退避。 */
  finalRetryBaseDelayMs?: number
  /** final 翻译从入队到结束的总时限，默认 45000ms。 */
  finalRequestDeadlineMs?: number
  /** 同时执行的 final 翻译请求上限，默认 2；兼容的预览翻译路径不受此限制。 */
  maxConcurrentFinalRequests?: number
  /** final 翻译等待队列上限，默认 12；需容纳一条长 final 拆出的多条 cue。 */
  maxQueuedFinalRequests?: number
  /** 当前时间读取函数，便于测试控制请求节流。 */
  nowFn?: () => number
  /** 定时器工厂，便于测试控制预翻译时机。 */
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown
  /** 清除定时器函数。 */
  clearTimeoutFn?: (handle: unknown) => void
}

/** 协调器内部翻译任务状态。 */
type SubtitleTranslationTaskStatus = 'scheduled' | 'running' | 'completed' | 'failed'

/** 协调器内部翻译任务。 */
interface SubtitleTranslationTask {
  /** 段落标识。 */
  id: string
  /** 提交时的协调器代次。 */
  epoch: number
  /** 当前任务对应的原文。 */
  text: string
  /** 识别得到的源语言。 */
  sourceLang: string | undefined
  /** 当前任务用于预览还是最终校正。 */
  phase: SubtitleTranslationPhase
  /** 已发送到界面的译文。 */
  translatedText: string
  /** 翻译运行时的完整译文。 */
  resultText: string
  /** 任务生命周期状态。 */
  status: SubtitleTranslationTaskStatus
  /** 取消信号。 */
  controller: AbortController
  /** 尚未执行的预翻译稳定计时器。 */
  timer: unknown | null
  /** 当前草稿窗口首次出现时启动的最大等待计时器。 */
  maxWaitTimer: unknown | null
  /** 当前预翻译运行期间收到的最新原文；完成后用于追赶最新 partial。 */
  queuedText?: string
  /** 追赶原文对应的识别语言。 */
  queuedSourceLang?: string
  /** final 翻译已发起的尝试次数。 */
  attempt: number
  /** final 翻译允许继续尝试的绝对截止时间。 */
  deadlineAt: number
  /** final 重试等待计时器。 */
  retryTimer: unknown | null
  /** 用于在会话取消时提前结束 final 重试等待。 */
  retryResolve: (() => void) | null
  /** 当前任务是否占用 final 并发槽位；预览升级为 final 时不算新增请求。 */
  usingFinalSlot: boolean
}

const DEFAULT_PREVIEW_DEBOUNCE_MS = 250
const DEFAULT_PREVIEW_MAX_WAIT_MS = 1_000
const DEFAULT_PREVIEW_MIN_INTERVAL_MS = 1500
const DEFAULT_PREVIEW_RATE_LIMIT_COOLDOWN_MS = 30_000
const DEFAULT_FINAL_MAX_ATTEMPTS = 3
const DEFAULT_FINAL_RETRY_BASE_DELAY_MS = 600
const DEFAULT_FINAL_REQUEST_DEADLINE_MS = 45_000
const DEFAULT_MAX_CONCURRENT_FINAL_REQUESTS = 2
const DEFAULT_MAX_QUEUED_FINAL_REQUESTS = 12

/**
 * 调度 final 字幕翻译请求，支持有限并发、重试、排队和取消。
 * @author zhenghq
 */
export class SubtitleTranslationCoordinator {
  private epoch = 0
  private readonly pending = new Set<Promise<void>>()
  private readonly tasks = new Map<string, SubtitleTranslationTask>()
  /** 已进入 final 阶段的段落，禁止迟到的 partial 重新开启预览翻译。 */
  private readonly finalizedSegmentIds = new Set<string>()
  private readonly options: SubtitleTranslationCoordinatorOptions
  private readonly previewDebounceMs: number
  private readonly previewMaxWaitMs: number
  private readonly previewMinIntervalMs: number
  private readonly previewRateLimitCooldownMs: number
  private readonly finalMaxAttempts: number
  private readonly finalRetryBaseDelayMs: number
  private readonly finalRequestDeadlineMs: number
  private readonly maxConcurrentFinalRequests: number
  private readonly maxQueuedFinalRequests: number
  private readonly nowFn: () => number
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void
  /** 最近一次真正启动预览翻译请求的时间。 */
  private lastPreviewStartedAt: number | null = null
  /** 因最小请求间隔而等待启动的预览任务。 */
  private pacedPreviewTask: SubtitleTranslationTask | null = null
  /** 预览请求节流计时器。 */
  private paceTimer: unknown = null
  /** 预览翻译限流冷却截止时间；final 翻译不受此限制。 */
  private previewSuppressedUntil: number | null = null
  /** 正在执行的 final 翻译任务数量。 */
  private runningFinalRequests = 0
  /** 等待执行的 final 翻译任务，按提交顺序出队。 */
  private readonly finalQueue: SubtitleTranslationTask[] = []

  /**
   * 创建字幕翻译协调器。
   * @param options 翻译运行时与回调依赖。
   * @author zhenghq
   */
  constructor(options: SubtitleTranslationCoordinatorOptions) {
    this.options = options
    const previewDebounceMs = options.previewDebounceMs ?? DEFAULT_PREVIEW_DEBOUNCE_MS
    this.previewDebounceMs = Number.isFinite(previewDebounceMs)
      ? Math.max(0, previewDebounceMs)
      : DEFAULT_PREVIEW_DEBOUNCE_MS
    const previewMaxWaitMs = options.previewMaxWaitMs ?? DEFAULT_PREVIEW_MAX_WAIT_MS
    this.previewMaxWaitMs = Number.isFinite(previewMaxWaitMs)
      ? Math.max(0, previewMaxWaitMs)
      : DEFAULT_PREVIEW_MAX_WAIT_MS
    const previewMinIntervalMs =
      options.previewMinIntervalMs ?? DEFAULT_PREVIEW_MIN_INTERVAL_MS
    this.previewMinIntervalMs = Number.isFinite(previewMinIntervalMs)
      ? Math.max(0, previewMinIntervalMs)
      : DEFAULT_PREVIEW_MIN_INTERVAL_MS
    const previewRateLimitCooldownMs =
      options.previewRateLimitCooldownMs ?? DEFAULT_PREVIEW_RATE_LIMIT_COOLDOWN_MS
    this.previewRateLimitCooldownMs = Number.isFinite(previewRateLimitCooldownMs)
      ? Math.max(0, previewRateLimitCooldownMs)
      : DEFAULT_PREVIEW_RATE_LIMIT_COOLDOWN_MS
    const finalMaxAttempts = options.finalMaxAttempts ?? DEFAULT_FINAL_MAX_ATTEMPTS
    this.finalMaxAttempts = Number.isFinite(finalMaxAttempts)
      ? Math.max(1, Math.floor(finalMaxAttempts))
      : DEFAULT_FINAL_MAX_ATTEMPTS
    const finalRetryBaseDelayMs =
      options.finalRetryBaseDelayMs ?? DEFAULT_FINAL_RETRY_BASE_DELAY_MS
    this.finalRetryBaseDelayMs = Number.isFinite(finalRetryBaseDelayMs)
      ? Math.max(0, finalRetryBaseDelayMs)
      : DEFAULT_FINAL_RETRY_BASE_DELAY_MS
    const finalRequestDeadlineMs =
      options.finalRequestDeadlineMs ?? DEFAULT_FINAL_REQUEST_DEADLINE_MS
    this.finalRequestDeadlineMs = Number.isFinite(finalRequestDeadlineMs)
      ? Math.max(0, finalRequestDeadlineMs)
      : DEFAULT_FINAL_REQUEST_DEADLINE_MS
    const maxConcurrentFinalRequests =
      options.maxConcurrentFinalRequests ?? DEFAULT_MAX_CONCURRENT_FINAL_REQUESTS
    this.maxConcurrentFinalRequests = Number.isFinite(maxConcurrentFinalRequests)
      ? Math.max(1, Math.floor(maxConcurrentFinalRequests))
      : DEFAULT_MAX_CONCURRENT_FINAL_REQUESTS
    const maxQueuedFinalRequests =
      options.maxQueuedFinalRequests ?? DEFAULT_MAX_QUEUED_FINAL_REQUESTS
    this.maxQueuedFinalRequests = Number.isFinite(maxQueuedFinalRequests)
      ? Math.max(0, Math.floor(maxQueuedFinalRequests))
      : DEFAULT_MAX_QUEUED_FINAL_REQUESTS
    this.nowFn = options.nowFn ?? (() => Date.now())
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /**
   * 提交一段稳定 partial 进行预翻译；内容变化时会取消旧请求和旧预览。
   * @param text 待翻译原文。
   * @param sourceLang 识别得到的源语言；未识别时沿用设置。
   * @param _generation 宿主会话代次；会话失效由协调器统一管理。
   * @param segmentId 宿主分配的稳定段落标识。
   * @returns 实际提交的段落标识。
   * @author zhenghq
   */
  preview(
    text: string,
    sourceLang: string | undefined,
    _generation: number,
    segmentId: string
  ): string {
    if (this.finalizedSegmentIds.has(segmentId)) return segmentId
    const existing = this.tasks.get(segmentId)
    if (existing && existing.epoch === this.epoch) {
      if (existing.phase === 'final') return segmentId
      if (existing.text === text) {
        existing.queuedText = undefined
        existing.queuedSourceLang = undefined
        return segmentId
      }
      if (existing.status === 'running') {
        // 上游 partial 每几百毫秒就会更新整句文本。立即中止在途请求会让
        // 翻译首字永远赶不上下一次 partial；这里只记录最新文本，等当前
        // 请求完成后再自动追赶，保证字幕能持续出现译文。
        existing.queuedText = text
        existing.queuedSourceLang = sourceLang
        return segmentId
      }
      if (existing.status === 'scheduled') {
        // 连续 partial 只重置稳定计时，草稿窗口首次创建的最大等待计时
        // 保持不变，避免持续口播让预翻译无限延后。
        existing.text = text
        existing.sourceLang = sourceLang
        existing.queuedText = undefined
        existing.queuedSourceLang = undefined
        this.clearStablePreviewTimer(existing)
        this.scheduleStablePreview(existing)
        return segmentId
      }
      this.cancelTask(existing)
    }
    if (!text.trim()) return segmentId

    const task = this.createTask(text, sourceLang, 'preview', segmentId)
    this.tasks.set(segmentId, task)
    this.schedulePreview(task)
    return segmentId
  }

  /**
   * 提交一段 final 原文；同文预翻译存在时复用，否则重新翻译。
   * @param text 待翻译原文。
   * @param sourceLang 识别得到的源语言；未识别时沿用设置。
   * @param _generation 宿主会话代次；会话失效由协调器统一管理。
   * @param segmentId 宿主分配的稳定段落标识。
   * @returns 实际提交的段落标识。
   * @author zhenghq
   */
  submit(
    text: string,
    sourceLang: string | undefined,
    _generation: number,
    segmentId: string
  ): string {
    this.finalizedSegmentIds.add(segmentId)
    const existing = this.tasks.get(segmentId)
    if (existing && existing.epoch === this.epoch && existing.text === text) {
      if (existing.phase === 'final') return segmentId
      if (existing.status === 'completed') {
        this.finishCompletedPreview(existing)
        return segmentId
      }
      if (existing.status !== 'failed') {
        this.promotePreview(existing)
        return segmentId
      }
      this.cancelTask(existing)
    } else if (existing) {
      this.cancelTask(existing)
    }

    const task = this.createTask(text, sourceLang, 'final', segmentId)
    this.tasks.set(segmentId, task)
    this.start(task)
    return segmentId
  }

  /**
   * 等待当前全部翻译任务结束。
   * @returns 全部任务完成后 resolve。
   * @author zhenghq
   */
  async idle(): Promise<void> {
    while (this.pending.size > 0 || this.runningFinalRequests > 0 || this.finalQueue.length > 0) {
      if (this.pending.size === 0) {
        // 等待队列中的任务依赖正在结束的请求释放槽位；让出一轮事件循环
        // 后重新检查，避免在空 Promise 集合上忙等。
        await new Promise((resolve) => setTimeout(resolve, 0))
        continue
      }
      await Promise.allSettled([...this.pending])
    }
  }

  /**
   * 使所有在途翻译与预翻译计时器失效，并取消网络请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  invalidate(): void {
    this.epoch += 1
    this.clearPaceTimer()
    this.lastPreviewStartedAt = null
    this.previewSuppressedUntil = null
    this.finalQueue.length = 0
    this.runningFinalRequests = 0
    for (const task of this.tasks.values()) {
      this.clearPreviewTimers(task)
      this.clearFinalRetry(task)
      task.controller.abort()
    }
    this.tasks.clear()
    this.finalizedSegmentIds.clear()
  }

  /**
   * 创建内部翻译任务。
   * @param text 待翻译原文。
   * @param sourceLang 识别得到的源语言。
   * @param phase 预翻译或最终校正阶段。
   * @param id 段落标识。
   * @returns 新建任务。
   * @author zhenghq
   */
  private createTask(
    text: string,
    sourceLang: string | undefined,
    phase: SubtitleTranslationPhase,
    id: string
  ): SubtitleTranslationTask {
    return {
      id,
      epoch: this.epoch,
      text,
      sourceLang,
      phase,
      translatedText: '',
      resultText: '',
      status: 'scheduled',
      controller: new AbortController(),
      timer: null,
      maxWaitTimer: null,
      attempt: 0,
      deadlineAt: this.nowFn() + this.finalRequestDeadlineMs,
      retryTimer: null,
      retryResolve: null,
      usingFinalSlot: false
    }
  }

  /**
   * 将已完成的 partial 预翻译提升为最终结果，并补发尚未显示的增量。
   * @param task 已完成预翻译任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private finishCompletedPreview(task: SubtitleTranslationTask): void {
    task.phase = 'final'
    task.queuedText = undefined
    task.queuedSourceLang = undefined
    this.reconcileResult(task, task.resultText)
    task.status = 'completed'
    if (this.tasks.get(task.id) === task) this.tasks.delete(task.id)
    this.options.onComplete(task.id)
  }

  /**
   * 将运行中或等待中的 partial 预翻译提升为 final 阶段。
   * @param task 预翻译任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private promotePreview(task: SubtitleTranslationTask): void {
    this.clearPreviewTimers(task)
    task.phase = 'final'
    task.queuedText = undefined
    task.queuedSourceLang = undefined
    this.clearPacedPreview(task)
    if (task.status === 'scheduled') {
      this.start(task)
      return
    }
    // 预览请求已经发出且无法撤回，直接让它作为 final 结果完成；这属于
    // 抢占式复用，不计入 final 并发槽位，避免同一段重复请求。
  }

  /**
   * 按防抖配置安排一次预翻译。
   * @param task 待启动的预翻译任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private schedulePreview(task: SubtitleTranslationTask): void {
    if (!this.isActive(task)) return
    if (this.previewDebounceMs === 0) {
      this.start(task)
      return
    }
    this.scheduleStablePreview(task)
    if (task.maxWaitTimer === null) {
      task.maxWaitTimer = this.setTimeoutFn(() => {
        task.maxWaitTimer = null
        this.clearStablePreviewTimer(task)
        this.start(task)
      }, this.previewMaxWaitMs)
    }
  }

  /**
   * 重置当前草稿窗口的稳定等待计时。
   * @param task 等待预翻译的任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private scheduleStablePreview(task: SubtitleTranslationTask): void {
    task.timer = this.setTimeoutFn(() => {
      task.timer = null
      this.clearMaxWaitPreviewTimer(task)
      this.start(task)
    }, this.previewDebounceMs)
  }

  /**
   * 清除当前草稿窗口的稳定等待计时。
   * @param task 等待预翻译的任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearStablePreviewTimer(task: SubtitleTranslationTask): void {
    if (task.timer !== null) this.clearTimeoutFn(task.timer)
    task.timer = null
  }

  /**
   * 清除当前草稿窗口的最大等待计时。
   * @param task 等待预翻译的任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearMaxWaitPreviewTimer(task: SubtitleTranslationTask): void {
    if (task.maxWaitTimer !== null) this.clearTimeoutFn(task.maxWaitTimer)
    task.maxWaitTimer = null
  }

  /**
   * 同时清除当前草稿窗口的稳定与最大等待计时。
   * @param task 等待预翻译的任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearPreviewTimers(task: SubtitleTranslationTask): void {
    this.clearStablePreviewTimer(task)
    this.clearMaxWaitPreviewTimer(task)
  }

  /**
   * 当前预翻译结束后，按运行期间收到的最新 partial 再启动一次预翻译。
   * @param task 已结束的预翻译任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private startQueuedPreview(task: SubtitleTranslationTask): void {
    const text = task.queuedText
    const sourceLang = task.queuedSourceLang
    if (!this.isActive(task) || !text || text === task.text) return
    const next = this.createTask(text, sourceLang, 'preview', task.id)
    if (task.translatedText) this.options.onReset?.(task.id, 'preview')
    this.tasks.set(task.id, next)
    // 该文本已在上一请求运行期间等待过，不再重复防抖，立即追赶以降低字幕延迟。
    this.start(next)
  }

  /**
   * 启动预翻译或 final 翻译任务。
   * @param task 待启动任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private start(task: SubtitleTranslationTask): void {
    if (task.status !== 'scheduled' || !this.isActive(task)) return
    this.clearPacedPreview(task)
    if (task.phase === 'preview' && this.shouldPacePreview()) {
      this.schedulePacedPreview(task)
      return
    }
    if (task.phase === 'final') {
      // final 是字幕质量的兜底，限制并发避免快速识别时把所有翻译通道
      // 同时打满；预览任务仍按原有节流逻辑独立运行。
      if (
        this.runningFinalRequests >= this.maxConcurrentFinalRequests ||
        this.finalQueue.length > 0
      ) {
        this.enqueueFinal(task)
        return
      }
      this.startFinal(task)
      return
    }
    task.status = 'running'
    this.lastPreviewStartedAt = this.nowFn()
    this.trackTask(task, this.run(task))
  }

  /**
   * 启动一个 final 翻译任务，并占用一个并发槽位。
   * @param task 已通过并发检查的 final 任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private startFinal(task: SubtitleTranslationTask): void {
    task.status = 'running'
    task.usingFinalSlot = true
    this.runningFinalRequests += 1
    const promise = this.run(task).finally(() => {
      this.pending.delete(promise)
      if (task.usingFinalSlot) {
        task.usingFinalSlot = false
        this.runningFinalRequests = Math.max(0, this.runningFinalRequests - 1)
      }
      if (
        this.tasks.get(task.id) === task &&
        (task.status === 'failed' || (task.phase === 'final' && task.status === 'completed'))
      ) {
        this.tasks.delete(task.id)
      }
      if (task.epoch === this.epoch) this.drainFinalQueue()
    })
    this.pending.add(promise)
  }

  /**
   * 将 final 任务放入等待队列；队列已满时只让当前段落失败。
   * @param task 等待执行的 final 任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private enqueueFinal(task: SubtitleTranslationTask): void {
    if (this.finalQueue.length >= this.maxQueuedFinalRequests) {
      task.status = 'failed'
      if (this.tasks.get(task.id) === task) this.tasks.delete(task.id)
      this.options.onError(task.id, new Error('subtitle translation queue is full'))
      return
    }
    this.finalQueue.push(task)
  }

  /**
   * 在并发槽位释放后按提交顺序启动等待中的 final 任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private drainFinalQueue(): void {
    while (
      this.runningFinalRequests < this.maxConcurrentFinalRequests &&
      this.finalQueue.length > 0
    ) {
      const task = this.finalQueue.shift()
      if (!task || !this.isActive(task)) continue
      this.startFinal(task)
    }
  }

  /**
   * 登记任务 Promise，确保 idle 能等待全部在途请求结束。
   * @param task 当前任务。
   * @param work 任务执行 Promise。
   * @returns 无返回值。
   * @author zhenghq
   */
  private trackTask(task: SubtitleTranslationTask, work: Promise<void>): void {
    const promise = work.finally(() => {
      this.pending.delete(promise)
      if (
        this.tasks.get(task.id) === task &&
        (task.status === 'failed' || (task.phase === 'final' && task.status === 'completed'))
      ) {
        this.tasks.delete(task.id)
      }
    })
    this.pending.add(promise)
  }

  /**
   * 执行单段翻译并仅在代次仍有效时转发结果。
   * @param task 内部任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async run(task: SubtitleTranslationTask): Promise<void> {
    // 延后一个事件循环启动，使同一批 final 的会话失效可以取消尚未发出的请求。
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (!this.isActive(task)) return

    const settingsSnapshot = this.options.getSettings()
    const settings: Settings = {
      ...settingsSnapshot,
      ...(task.sourceLang && task.sourceLang !== 'auto' ? { sourceLang: task.sourceLang } : {})
    }
    while (this.isActive(task)) {
      task.attempt += 1
      try {
        const output = await this.options.translateStream(
          task.text,
          settings,
          this.options.getDingTalkCredentials(),
          this.options.getAiApiKey(),
          {
            signal: task.controller.signal,
            onDelta: (delta) => {
              if (!this.isActive(task) || !delta) return
              this.emitDelta(task, delta)
            }
          },
          this.options.getITranslateApiKey?.() ?? null
        )
        if (!this.isActive(task)) return
        task.resultText = output.translation || task.translatedText
        if (task.phase === 'preview') {
          this.reconcileResult(task, task.resultText)
          task.status = 'completed'
          this.startQueuedPreview(task)
          return
        }

        this.reconcileResult(task, task.resultText)
        task.status = 'completed'
        this.options.onComplete(task.id)
        return
      } catch (error) {
        if (!this.isActive(task) || task.controller.signal.aborted) return
        task.status = 'failed'
        if (task.phase === 'preview') {
          this.suppressPreviewAfterRateLimit(error)
          if (task.translatedText) {
            this.options.onReset?.(task.id, 'preview')
            task.translatedText = ''
          }
          this.startQueuedPreview(task)
          return
        }
        const retryDelayMs = this.finalRetryDelayMs(task, error)
        if (retryDelayMs !== null) {
          await this.waitForFinalRetry(task, retryDelayMs)
          continue
        }
        this.options.onError(task.id, error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  }

  /**
   * 发送译文增量并累计当前阶段已展示的文本。
   * @param task 内部任务。
   * @param delta 新增译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitDelta(task: SubtitleTranslationTask, delta: string): void {
    if (!delta) return
    task.translatedText += delta
    this.options.onDelta(task.id, delta, task.phase, task.text)
  }

  /**
   * 将翻译运行时的完整结果校正到已发送的增量上。
   * @param task 内部任务。
   * @param resultText 完整译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  private reconcileResult(task: SubtitleTranslationTask, resultText: string): void {
    if (!resultText || resultText === task.translatedText) return
    if (resultText.startsWith(task.translatedText)) {
      this.emitDelta(task, resultText.slice(task.translatedText.length))
      return
    }
    if (task.translatedText) {
      this.options.onReset?.(task.id, task.phase)
      task.translatedText = ''
    }
    this.emitDelta(task, resultText)
  }

  /**
   * 取消任务、释放计时器，并在已有输出时通知宿主清空旧译文。
   * @param task 待取消任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private cancelTask(task: SubtitleTranslationTask): void {
    this.clearPreviewTimers(task)
    this.clearFinalRetry(task)
    this.clearPacedPreview(task)
    task.controller.abort()
    if (task.translatedText) {
      this.options.onReset?.(task.id, task.phase)
      task.translatedText = ''
    }
    if (this.tasks.get(task.id) === task) this.tasks.delete(task.id)
  }

  /**
   * 判断任务是否仍属于当前有效代次。
   * @param task 内部任务。
   * @returns 是否允许继续写入界面。
   * @author zhenghq
   */
  private isActive(task: SubtitleTranslationTask): boolean {
    return (
      task.epoch === this.epoch &&
      !task.controller.signal.aborted &&
      this.tasks.get(task.id) === task
    )
  }

  /**
   * 判断预览翻译是否需要等待最小请求间隔。
   * @returns 尚未达到最小间隔时返回 true。
   * @author zhenghq
   */
  private shouldPacePreview(): boolean {
    return this.previewStartDelayMs() > 0
  }

  /**
   * 按剩余最小间隔延后启动预览翻译。
   * @param task 等待启动的预览任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private schedulePacedPreview(task: SubtitleTranslationTask): void {
    const delayMs = this.previewStartDelayMs()
    this.clearPaceTimer()
    this.pacedPreviewTask = task
    this.paceTimer = this.setTimeoutFn(() => {
      this.paceTimer = null
      this.pacedPreviewTask = null
      this.start(task)
    }, delayMs)
  }

  /**
   * 计算下一次预览请求需要等待的时间。
   * @returns 同时满足最小请求间隔和限流冷却的剩余毫秒数。
   * @author zhenghq
   */
  private previewStartDelayMs(): number {
    const now = this.nowFn()
    let delayMs = 0
    if (this.previewMinIntervalMs > 0 && this.lastPreviewStartedAt !== null) {
      delayMs = Math.max(0, this.previewMinIntervalMs - (now - this.lastPreviewStartedAt))
    }
    if (this.previewSuppressedUntil !== null) {
      delayMs = Math.max(delayMs, this.previewSuppressedUntil - now)
    }
    return delayMs
  }

  /**
   * 预览翻译遇到限流时延长冷却结束时间。
   * @param error 预览翻译抛出的原始错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private suppressPreviewAfterRateLimit(error: unknown): void {
    if (this.previewRateLimitCooldownMs <= 0 || !this.isRateLimitError(error)) return
    const suggestedDelayMs = this.retryAfterMsFromError(error)
    const cooldownMs = suggestedDelayMs ?? this.previewRateLimitCooldownMs
    const until = this.nowFn() + cooldownMs
    this.previewSuppressedUntil = Math.max(this.previewSuppressedUntil ?? until, until)
  }

  /**
   * 读取翻译错误携带的服务端重试等待时间。
   * @param error 待读取的翻译错误。
   * @returns 有效的非负毫秒数；未提供时返回 undefined。
   * @author zhenghq
   */
  private retryAfterMsFromError(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('retryAfterMs' in error)) return undefined
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
    return Math.floor(value)
  }

  /**
   * 判断翻译错误是否表示服务端限流。
   * @param error 待判断的翻译错误。
   * @returns 属于 429 或限流语义时返回 true。
   * @author zhenghq
   */
  private isRateLimitError(error: unknown): boolean {
    if (
      typeof error === 'object' &&
      error !== null &&
      'kind' in error &&
      (error as { kind?: unknown }).kind === 'rate-limit'
    ) {
      return true
    }
    const message = error instanceof Error ? error.message : String(error)
    return /\b429\b|rate.?limit|too many requests|限流|请求(?:过于)?频繁/iu.test(message)
  }

  /**
   * 计算 final 下一次重试前的退避时间。
   * @param task 当前 final 任务。
   * @param error 本次尝试失败的原因。
   * @returns 可重试时返回等待毫秒数，否则返回 null。
   * @author zhenghq
   */
  private finalRetryDelayMs(task: SubtitleTranslationTask, error: unknown): number | null {
    if (
      task.attempt >= this.finalMaxAttempts ||
      !this.isRetryableFinalError(error)
    ) {
      return null
    }
    const backoffMs = this.finalRetryBaseDelayMs * 2 ** (task.attempt - 1)
    const delayMs = Math.max(backoffMs, this.retryAfterMsFromError(error) ?? 0)
    if (this.nowFn() + delayMs >= task.deadlineAt) return null
    return delayMs
  }

  /**
   * 等待 final 重试，并在等待开始时清理上一次尝试残留的译文。
   * @param task 当前 final 任务。
   * @param delayMs 指数退避等待时间。
   * @returns 计时结束或会话取消后 resolve。
   * @author zhenghq
   */
  private waitForFinalRetry(task: SubtitleTranslationTask, delayMs: number): Promise<void> {
    if (task.translatedText) {
      this.options.onReset?.(task.id, 'final')
      task.translatedText = ''
    }
    task.resultText = ''
    return new Promise<void>((resolve) => {
      task.retryResolve = resolve
      task.retryTimer = this.setTimeoutFn(() => {
        task.retryTimer = null
        task.retryResolve = null
        resolve()
      }, delayMs)
    })
  }

  /**
   * 清除 final 重试计时器并解除等待，避免停止会话后遗留异步任务。
   * @param task 待清理的翻译任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearFinalRetry(task: SubtitleTranslationTask): void {
    if (task.retryTimer !== null) this.clearTimeoutFn(task.retryTimer)
    task.retryTimer = null
    const resolve = task.retryResolve
    task.retryResolve = null
    resolve?.()
  }

  /**
   * 判断 final 翻译错误是否值得自动重试。
   * @param error 本次尝试失败的原因。
   * @returns 网络、限流或服务错误返回 true；鉴权、配置和参数错误返回 false。
   * @author zhenghq
   */
  private isRetryableFinalError(error: unknown): boolean {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return false
    }
    if (typeof error === 'object' && error !== null && 'kind' in error) {
      const kind = (error as { kind?: unknown }).kind
      return !new Set(['authentication', 'permission', 'configuration', 'parameter', 'not-found']).has(
        String(kind)
      )
    }
    return true
  }

  /**
   * 清除指定预览任务的节流等待；任务不匹配时保留其他任务的计时器。
   * @param task 可能处于等待状态的预览任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearPacedPreview(task: SubtitleTranslationTask): void {
    if (this.pacedPreviewTask !== task) return
    this.clearPaceTimer()
  }

  /**
   * 清除预览请求节流计时器与等待任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearPaceTimer(): void {
    if (this.paceTimer !== null) this.clearTimeoutFn(this.paceTimer)
    this.paceTimer = null
    this.pacedPreviewTask = null
  }
}
