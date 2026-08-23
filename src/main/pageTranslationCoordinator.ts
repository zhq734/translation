import { splitWebTextBlocks, splitWebTextUnits, type WebTranslationSegment } from '../shared/webBlockSplitter'
import type {
  ExtractedWebTextBlock,
  ExtractedWebTextUnit,
  WebTranslationScope
} from '../shared/webPageTranslation'

/** 可注入的单段翻译函数。 */
export type PageTranslator = (text: string, sourceLang: string, targetLang: string) => Promise<{ translation: string; detectedLang?: string; provider?: string; channel?: string }>

/** 页面翻译任务代次。 */
export interface PageTranslationJob {
  /** 阅读器实例标识。 */
  readerId: string
  /** 当前页面递增版本。 */
  pageRevision: number
  /** 本次翻译任务标识。 */
  jobId: string
  /** 翻译范围。 */
  scope: WebTranslationScope
  /** 单段最大字符数。 */
  maxCharsPerSegment: number
  /** 最大翻译块数。 */
  maxBlocks?: number
  /** 最大总字符数。 */
  maxChars?: number
  /** 可选语言标签。 */
  locale?: string
  /** 源语言。 */
  sourceLang: string
  /** 目标语言。 */
  targetLang: string
}

/** 单个网页分段的翻译结果。 */
export interface PageTranslationResult {
  /** 来源块标识。 */
  blockId: string
  /** 来源文本单元标识。 */
  unitId: string
  /** 来源分段标识。 */
  segmentId: string
  /** 分段原文。 */
  text: string
  /** 译文，失败时不存在。 */
  translation?: string
  /** 失败原因。 */
  error?: string
  /** 翻译通道。 */
  channel?: string
  /** 翻译服务商。 */
  provider?: string
}

/** 页面翻译进度事件。 */
export interface PageTranslationProgress {
  /** 任务标识。 */
  jobId: string
  /** 页面版本。 */
  pageRevision: number
  /** 当前已经发现并接受的分段数。 */
  discovered: number
  /** 当前仍在等待处理的分段数。 */
  queued: number
  /** 已处理分段数。 */
  done: number
  /** 当前已发现分段总数，兼容原固定任务进度。 */
  total: number
  /** 失败分段数。 */
  failed: number
  /** 是否已取消。 */
  cancelled: boolean
  /** 是否因保护上限或失败产生不完整结果。 */
  partial: boolean
  /** 增量输入窗口是否已经关闭。 */
  inputClosed: boolean
}

/** 页面翻译运行结果。 */
export interface PageTranslationRunResult {
  /** 任务代次。 */
  readerId: string
  /** 页面版本。 */
  pageRevision: number
  /** 任务标识。 */
  jobId: string
  /** 已完成的翻译结果。 */
  results: PageTranslationResult[]
  /** 进度快照。 */
  progress: PageTranslationProgress
  /** 是否为部分翻译。 */
  partial: boolean
}

/** 协调器配置。 */
export interface PageTranslationCoordinatorOptions {
  /** 最大并发数，默认 3。 */
  concurrency?: number
  /** 注入单段翻译器。 */
  translate: PageTranslator
}

/** 流式批次入队统计。 */
export interface PageTranslationEnqueueResult {
  /** 实际接受的文本单元数量。 */
  accepted: number
  /** 因原文和锚点键重复而忽略的数量。 */
  duplicate: number
  /** 因块数或字符数保护上限而忽略的数量。 */
  truncated: number
}

/** 可追加、可关闭的页面翻译流。 */
export interface PageTranslationStream {
  /**
   * 追加新发现的网页文本单元。
   * @param units 新发现的文本单元。
   * @returns 入队、去重和截断统计。
   * @author zhenghq
   */
  enqueue(units: ExtractedWebTextUnit[]): PageTranslationEnqueueResult
  /**
   * 关闭输入，队列清空后任务完成。
   * @returns 无返回值。
   * @author zhenghq
   */
  closeInput(): void
  /** 最终任务结果。 */
  result: Promise<PageTranslationRunResult>
  /**
   * 返回当前进度快照。
   * @returns 当前动态进度。
   * @author zhenghq
   */
  getProgress(): PageTranslationProgress
}

/** 单个分段完成后的增量结果回调。 */
export type PageTranslationResultCallback = (
  result: PageTranslationResult,
  unitComplete: boolean,
  results: readonly PageTranslationResult[]
) => void | Promise<void>

/** 内部可取消流式任务。 */
interface ActivePageTranslationStream {
  /** 完整任务代次键。 */
  key: string
  /** 兼容旧调用的任务键。 */
  legacyKey: string
  /** 取消当前任务。 */
  cancel(): void
}

/**
 * 管理网页分块的并发翻译、流式追加、取消、失败标记与任务代次校验。
 * @author zhenghq
 */
export class PageTranslationCoordinator {
  private readonly concurrency: number
  private readonly translate: PageTranslator
  private readonly invalidJobs = new Set<string>()
  private readonly activeStreams = new Set<ActivePageTranslationStream>()

  /**
   * 创建页面翻译协调器。
   * @param options 并发数量与单段翻译器。
   * @author zhenghq
   */
  constructor(options: PageTranslationCoordinatorOptions) {
    this.concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 3)))
    this.translate = options.translate
  }

  /**
   * 使指定任务失效，迟到的网络结果不会再写入当前页面。
   * @param readerId 阅读器标识。
   * @param pageRevision 页面版本。
   * @param jobId 任务标识。
   * @param sourceLang 可选源语言，用于精确失效语言方向。
   * @param targetLang 可选目标语言，用于精确失效语言方向。
   * @returns 无返回值。
   * @author zhenghq
   */
  invalidate(readerId: string, pageRevision: number, jobId: string, sourceLang?: string, targetLang?: string): void {
    const exact = this.key(readerId, pageRevision, jobId, sourceLang, targetLang)
    const legacy = this.key(readerId, pageRevision, jobId)
    this.invalidJobs.add(exact)
    if (!sourceLang && !targetLang) this.invalidJobs.add(legacy)
    for (const stream of this.activeStreams) {
      if (stream.key === exact || stream.legacyKey === legacy) stream.cancel()
    }
  }

  /**
   * 创建可在页面加载期间持续追加文本单元的翻译任务。
   * @param job 页面任务代次与保护配置。
   * @param onProgress 动态进度回调。
   * @param signal 外部取消信号。
   * @param onResult 单个分段完成回调。
   * @returns 可追加、关闭并等待最终结果的流式任务。
   * @author zhenghq
   */
  createStream(
    job: PageTranslationJob,
    onProgress?: (progress: PageTranslationProgress) => void,
    signal?: AbortSignal,
    onResult?: PageTranslationResultCallback
  ): PageTranslationStream {
    const key = this.key(job.readerId, job.pageRevision, job.jobId, job.sourceLang, job.targetLang)
    const legacyKey = this.key(job.readerId, job.pageRevision, job.jobId)
    this.invalidJobs.delete(key)
    this.invalidJobs.delete(legacyKey)
    const queue: WebTranslationSegment[] = []
    const results: PageTranslationResult[] = []
    const seenUnits = new Set<string>()
    const unitSegmentTotals = new Map<string, number>()
    const unitSegmentDone = new Map<string, number>()
    let acceptedUnits = 0
    let acceptedChars = 0
    let active = 0
    let done = 0
    let failed = 0
    let truncated = false
    let cancelled = false
    let inputClosed = false
    let settled = false
    let resolveResult: (result: PageTranslationRunResult) => void = () => undefined
    const result = new Promise<PageTranslationRunResult>((resolve) => { resolveResult = resolve })

    /**
     * 判断当前流式任务是否已失效。
     * @returns 当前任务是否不可继续处理。
     * @author zhenghq
     */
    const isStale = (): boolean => cancelled || signal?.aborted === true || this.invalidJobs.has(key) || this.invalidJobs.has(legacyKey)

    /**
     * 创建动态进度快照。
     * @returns 当前任务进度。
     * @author zhenghq
     */
    const snapshot = (): PageTranslationProgress => ({
      jobId: job.jobId,
      pageRevision: job.pageRevision,
      discovered: done + active + queue.length,
      queued: queue.length,
      done,
      total: done + active + queue.length,
      failed,
      cancelled,
      partial: truncated || failed > 0 || cancelled,
      inputClosed
    })

    /**
     * 向调用方发送动态进度。
     * @returns 无返回值。
     * @author zhenghq
     */
    const emit = (): void => {
      if (!this.invalidJobs.has(key) && !this.invalidJobs.has(legacyKey)) onProgress?.(snapshot())
    }

    /**
     * 在输入关闭且全部工作结束后提交最终结果。
     * @returns 无返回值。
     * @author zhenghq
     */
    const finishIfReady = (): void => {
      if (settled || !inputClosed || active > 0 || queue.length > 0) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      this.activeStreams.delete(activeStream)
      const progress = snapshot()
      resolveResult({
        readerId: job.readerId,
        pageRevision: job.pageRevision,
        jobId: job.jobId,
        results: results.slice(),
        progress,
        partial: progress.partial
      })
    }

    /**
     * 取消流式任务并丢弃尚未开始的分段。
     * @returns 无返回值。
     * @author zhenghq
     */
    const cancel = (): void => {
      if (settled || cancelled) return
      cancelled = true
      inputClosed = true
      queue.splice(0)
      emit()
      finishIfReady()
    }

    /**
     * 处理一个翻译分段并在完成后继续调度。
     * @param segment 当前翻译分段。
     * @returns 当前分段处理完成后的 Promise。
     * @author zhenghq
     */
    const processSegment = async (segment: WebTranslationSegment): Promise<void> => {
      let completed: PageTranslationResult | undefined
      try {
        const output = await this.translate(segment.text, job.sourceLang, job.targetLang)
        if (!isStale()) completed = this.success(segment, output)
      } catch (error) {
        if (!isStale()) {
          failed += 1
          completed = { ...segment, error: error instanceof Error ? error.message : '翻译失败' }
        }
      }
      if (completed && !isStale()) {
        results.push(completed)
        done += 1
        const completedCount = (unitSegmentDone.get(segment.unitId) ?? 0) + 1
        unitSegmentDone.set(segment.unitId, completedCount)
        emit()
        await onResult?.(completed, completedCount === unitSegmentTotals.get(segment.unitId), results.slice())
      }
      active -= 1
      if (isStale()) cancel()
      pump()
      finishIfReady()
    }

    /**
     * 按并发上限从队列调度翻译分段。
     * @returns 无返回值。
     * @author zhenghq
     */
    const pump = (): void => {
      if (isStale()) {
        cancel()
        return
      }
      while (active < this.concurrency && queue.length > 0) {
        const segment = queue.shift() as WebTranslationSegment
        active += 1
        void processSegment(segment)
      }
      emit()
      finishIfReady()
    }

    const activeStream: ActivePageTranslationStream = { key, legacyKey, cancel }
    this.activeStreams.add(activeStream)
    signal?.addEventListener('abort', cancel, { once: true })

    return {
      enqueue: (units: ExtractedWebTextUnit[]): PageTranslationEnqueueResult => {
        const stats: PageTranslationEnqueueResult = { accepted: 0, duplicate: 0, truncated: 0 }
        if (inputClosed || isStale()) return stats
        for (const unit of units) {
          if (job.scope === 'body' && unit.category !== 'body') continue
          const unitKey = `${unit.anchor.parentSelector}|${unit.anchor.textNodeIndex}|${unit.anchor.sourceFingerprint}|${unit.sourceText}`
          if (seenUnits.has(unitKey)) {
            stats.duplicate += 1
            continue
          }
          seenUnits.add(unitKey)
          if (acceptedUnits >= Math.max(0, job.maxBlocks ?? Number.MAX_SAFE_INTEGER)) {
            stats.truncated += 1
            truncated = true
            continue
          }
          const segments = splitWebTextUnits([unit], { maxChars: job.maxCharsPerSegment, locale: job.locale })
          const segmentChars = segments.reduce((sum, segment) => sum + segment.text.length, 0)
          if (segments.length === 0) continue
          if (acceptedChars + segmentChars > Math.max(0, job.maxChars ?? Number.MAX_SAFE_INTEGER)) {
            stats.truncated += 1
            truncated = true
            continue
          }
          acceptedUnits += 1
          acceptedChars += segmentChars
          stats.accepted += 1
          unitSegmentTotals.set(unit.id, segments.length)
          queue.push(...segments)
        }
        emit()
        pump()
        return stats
      },
      closeInput: (): void => {
        if (inputClosed) return
        inputClosed = true
        emit()
        finishIfReady()
      },
      result,
      getProgress: snapshot
    }
  }

  /**
   * 按正文范围筛选网页块并执行固定批次并发翻译。
   * @param job 页面任务代次与保护配置。
   * @param blocks 提取出的网页文本块或文本单元。
   * @param onProgress 进度回调。
   * @param signal 外部取消信号。
   * @param onResult 单个分段完成回调，并标记所属文本单元是否已经完整。
   * @returns 页面翻译结果和最终进度。
   * @author zhenghq
   */
  async run(
    job: PageTranslationJob,
    blocks: ExtractedWebTextBlock[] | ExtractedWebTextUnit[],
    onProgress?: (progress: PageTranslationProgress) => void,
    signal?: AbortSignal,
    onResult?: PageTranslationResultCallback
  ): Promise<PageTranslationRunResult> {
    const isUnitList = blocks.length === 0 || 'sourceText' in blocks[0]
    if (isUnitList) {
      let lastReportedDone = -1
      const stream = this.createStream(job, (progress) => {
        if (progress.done === lastReportedDone) return
        lastReportedDone = progress.done
        if (progress.done > 0) onProgress?.(progress)
      }, signal, onResult)
      stream.enqueue(blocks as ExtractedWebTextUnit[])
      stream.closeInput()
      return stream.result
    }

    const selected = job.scope === 'body' ? blocks.filter((block) => block.category === 'body') : blocks
    const limitedBlocks = selected.slice(0, Math.max(0, job.maxBlocks ?? Number.MAX_SAFE_INTEGER)) as ExtractedWebTextBlock[]
    const segments = splitWebTextBlocks(limitedBlocks, { maxChars: job.maxCharsPerSegment, locale: job.locale })
    const limitedSegments = this.limitChars(segments, job.maxChars)
    const syntheticUnits: ExtractedWebTextUnit[] = limitedSegments.map((segment, index) => ({
      id: `${segment.unitId}:fixed-${index}`,
      blockId: segment.blockId,
      sourceText: segment.text,
      text: segment.text,
      category: limitedBlocks.find((block) => block.id === segment.blockId)?.category ?? 'body',
      anchor: { parentSelector: `#fixed-${index}`, textNodeIndex: 0, sourceFingerprint: segment.segmentId }
    }))
    const stream = this.createStream({ ...job, maxBlocks: syntheticUnits.length, maxChars: undefined, maxCharsPerSegment: job.maxCharsPerSegment }, onProgress, signal, onResult)
    stream.enqueue(syntheticUnits)
    if (limitedBlocks.length !== selected.length || limitedSegments.length !== segments.length) {
      // 通过一个超限空单元让流式结果保持 partial 语义。
      stream.enqueue([{ ...syntheticUnits[0], id: '__truncated__', text: 'x', sourceText: 'x', anchor: { parentSelector: '#truncated', textNodeIndex: 0, sourceFingerprint: 'truncated' } }])
    }
    stream.closeInput()
    return stream.result
  }

  /**
   * 按总字符数保护截取分段。
   * @param segments 已拆分的分段。
   * @param maxChars 最大总字符数。
   * @returns 未超出总字符上限的前缀分段。
   * @author zhenghq
   */
  private limitChars(segments: WebTranslationSegment[], maxChars?: number): WebTranslationSegment[] {
    if (maxChars === undefined || !Number.isFinite(maxChars)) return segments
    const limit = Math.max(0, Math.floor(maxChars))
    let used = 0
    const output: WebTranslationSegment[] = []
    for (const segment of segments) {
      if (used + segment.text.length > limit) break
      output.push(segment)
      used += segment.text.length
    }
    return output
  }

  /**
   * 将翻译服务输出映射为网页结果。
   * @param segment 原始分段。
   * @param output 翻译服务输出。
   * @returns 结构化网页翻译结果。
   * @author zhenghq
   */
  private success(segment: WebTranslationSegment, output: Awaited<ReturnType<PageTranslator>>): PageTranslationResult {
    return {
      unitId: segment.unitId,
      blockId: segment.blockId,
      segmentId: segment.segmentId,
      text: segment.text,
      translation: output.translation,
      provider: output.provider,
      channel: output.channel
    }
  }

  /**
   * 创建任务代次键。
   * @param readerId 阅读器标识。
   * @param pageRevision 页面版本。
   * @param jobId 任务标识。
   * @param sourceLang 可选源语言。
   * @param targetLang 可选目标语言。
   * @returns 内部键。
   * @author zhenghq
   */
  private key(readerId: string, pageRevision: number, jobId: string, sourceLang = '', targetLang = ''): string {
    return `${readerId}:${pageRevision}:${jobId}:${sourceLang}:${targetLang}`
  }
}

/**
 * 将分段翻译按文本单元顺序聚合，失败单元不生成译文。
 * @param units 原始文本单元。
 * @param results 已完成的分段翻译结果。
 * @returns 按原文本单元顺序排列的聚合结果。
 * @author zhenghq
 */
export function aggregatePageTranslationUnits(
  units: ExtractedWebTextUnit[],
  results: PageTranslationResult[]
): Array<ExtractedWebTextUnit & { translation?: string; error?: string }> {
  return units.map((unit) => {
    const related = results.filter((result) => result.unitId === unit.id).sort((left, right) => {
      const leftIndex = Number(left.segmentId.split(':').pop() ?? 0)
      const rightIndex = Number(right.segmentId.split(':').pop() ?? 0)
      return leftIndex - rightIndex
    })
    const failure = related.find((result) => result.error)
    return {
      ...unit,
      ...(failure ? { error: failure.error } : related.length ? { translation: related.map((result) => result.translation ?? '').join('') } : {})
    }
  })
}
