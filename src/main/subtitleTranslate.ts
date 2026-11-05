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
  /** 转发一段译文增量。 */
  onDelta: (segmentId: string, delta: string, phase: SubtitleTranslationPhase) => void
  /** 标记段落翻译完成。 */
  onComplete: (segmentId: string) => void
  /** 报告单段 final 翻译失败，不得向识别链路抛出。 */
  onError: (segmentId: string, error: Error) => void
  /** 清空指定阶段的旧译文，避免内容变化后短暂展示过期结果。 */
  onReset?: (segmentId: string, phase: SubtitleTranslationPhase) => void
  /** partial 稳定多久后发起预翻译，默认 300ms。 */
  previewDebounceMs?: number
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
  /** 尚未执行的预翻译防抖计时器。 */
  timer: unknown | null
  /** 当前预翻译运行期间收到的最新原文；完成后用于追赶最新 partial。 */
  queuedText?: string
  /** 追赶原文对应的识别语言。 */
  queuedSourceLang?: string
}

const DEFAULT_PREVIEW_DEBOUNCE_MS = 300

/**
 * 将稳定 partial 提前接入流式翻译，并在 final 到达时复用或校正结果。
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
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void

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
        if (existing.timer !== null) this.clearTimeoutFn(existing.timer)
        existing.timer = null
        existing.text = text
        existing.sourceLang = sourceLang
        existing.queuedText = undefined
        existing.queuedSourceLang = undefined
        this.schedulePreview(existing)
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
    while (this.pending.size > 0) {
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
    for (const task of this.tasks.values()) {
      if (task.timer !== null) this.clearTimeoutFn(task.timer)
      task.timer = null
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
      timer: null
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
    if (task.timer !== null) {
      this.clearTimeoutFn(task.timer)
      task.timer = null
    }
    task.phase = 'final'
    task.queuedText = undefined
    task.queuedSourceLang = undefined
    if (task.status === 'scheduled') this.start(task)
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
    task.timer = this.setTimeoutFn(() => {
      task.timer = null
      this.start(task)
    }, this.previewDebounceMs)
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
    task.status = 'running'
    const promise = this.run(task).finally(() => {
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
    } catch (error) {
      if (!this.isActive(task) || task.controller.signal.aborted) return
      task.status = 'failed'
      if (task.phase === 'preview') {
        if (task.translatedText) {
          this.options.onReset?.(task.id, 'preview')
          task.translatedText = ''
        }
        this.startQueuedPreview(task)
        return
      }
      this.options.onError(task.id, error instanceof Error ? error : new Error(String(error)))
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
    this.options.onDelta(task.id, delta, task.phase)
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
    if (task.timer !== null) this.clearTimeoutFn(task.timer)
    task.timer = null
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
}
