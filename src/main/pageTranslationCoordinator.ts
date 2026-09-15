import {
  buildWebTranslationBatches,
  parseMergedTranslation,
  splitWebTextBlocks,
  splitWebTextUnits,
  type WebTranslationBatch,
  type WebTranslationSegment
} from '../shared/webBlockSplitter'
import type {
  ExtractedWebTextBlock,
  ExtractedWebTextUnit,
  WebTranslationScope
} from '../shared/webPageTranslation'
import { createWebTextUnitKey } from '../shared/webPageTranslation'

/** 可注入的单段翻译函数。 */
export type PageTranslator = (text: string, sourceLang: string, targetLang: string) => Promise<{ translation: string; detectedLang?: string; provider?: string; channel?: string }>

/**
 * 跨块合并后单个请求的字符上限。
 * 取低于 Google 通道 2000 字上限的值，保证 AI 通道失败降级后合并批次仍可被下游通道接受。
 */
export const WEB_TRANSLATION_MERGED_BATCH_MAX_CHARS = 1800

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
  /** 是否把相邻短段落合并为一次翻译请求，默认关闭以保持既有逐段行为。 */
  mergeAcrossBlocks?: boolean
  /** 跨块合并时单批最多包含的分段数，未提供时使用默认值。 */
  maxSegmentsPerBatch?: number
  /** 源语言。 */
  sourceLang: string
  /** 目标语言。 */
  targetLang: string
}

/** 协调器内部的可翻译工作项，可能是单个分段或跨块合并批次。 */
interface WebTranslationWorkItem {
  /** 原始批量翻译请求，供拆分译文时校验分段数。 */
  batch: WebTranslationBatch
  /** 实际发送给翻译服务的文本。 */
  text: string
  /** 本次请求覆盖的全部网页分段，按原文顺序排列。 */
  segments: WebTranslationSegment[]
  /** 是否为包含分隔标记的跨块合并批次。 */
  merged: boolean
}

/** 单个网页分段的翻译结果。 */
export interface PageTranslationResult {
  /** 来源块标识。 */
  blockId: string
  /** 来源文本单元标识；按段落聚合时使用该段首个单元标识。 */
  unitId: string
  /** 当前翻译分段覆盖的全部文本单元标识。 */
  unitIds: string[]
  /** 来源分段标识。 */
  segmentId: string
  /** 当前来源段落拆分出的分段总数。 */
  segmentTotal: number
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
  /** 最大并发数或运行时读取函数，默认 3；允许用户设置变更后立即生效。 */
  concurrency?: number | (() => number)
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
  private readonly getConcurrency: () => number
  private readonly translate: PageTranslator
  private readonly invalidJobs = new Set<string>()
  private readonly activeStreams = new Set<ActivePageTranslationStream>()

  /**
   * 创建页面翻译协调器。
   * @param options 并发数量与单段翻译器。
   * @author zhenghq
   */
  constructor(options: PageTranslationCoordinatorOptions) {
    const configured = options.concurrency
    const read = typeof configured === 'function' ? configured : () => configured ?? 3
    this.getConcurrency = () => {
      const numeric = Number(read())
      if (!Number.isFinite(numeric)) return 3
      return Math.max(1, Math.min(8, Math.floor(numeric)))
    }
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
    const queue: WebTranslationWorkItem[] = []
    const results: PageTranslationResult[] = []
    const seenUnits = new Set<string>()
    const unitSegmentTotals = new Map<string, number>()
    const unitSegmentDone = new Map<string, number>()
    let acceptedUnits = 0
    let acceptedChars = 0
    let active = 0
    let pendingWriteBacks = 0
    let writeBackChain: Promise<void> = Promise.resolve()
    let done = 0
    let failed = 0
    let truncated = false
    let cancelled = false
    let inputClosed = false
    let settled = false
    // 非 AI 通道通常不会原样保留分段标记；一旦发现就停止合并，避免每批都多付一次无效请求。
    let mergeUnsupported = false
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
      // 取消后立即提交结果，不再等待慢速写回，避免用户点击取消后仍被 DOM 写回阻塞。
      if (settled || !inputClosed || active > 0 || queue.length > 0) return
      if (!cancelled && pendingWriteBacks > 0) return
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
     * 将一次翻译结果写入结果集合并触发增量写回。
     * @param completed 当前分段完成结果。
     * @returns 无返回值。
     * @author zhenghq
     */
    const commitResult = (completed: PageTranslationResult): void => {
      results.push(completed)
      let allUnitsComplete = true
      for (const unitId of completed.unitIds) {
        const completedCount = (unitSegmentDone.get(unitId) ?? 0) + 1
        unitSegmentDone.set(unitId, completedCount)
        if (completedCount < (unitSegmentTotals.get(unitId) ?? 1)) allUnitsComplete = false
      }
      emit()
      // 写回回调与翻译并发解耦：网络请求完成后立即释放槽位，慢速 DOM 写回不再阻塞后续翻译。
      if (!onResult) return
      const finished = completed
      const snapshot = results.slice()
      pendingWriteBacks += 1
      writeBackChain = writeBackChain.then(async () => {
        try {
          await onResult(finished, allUnitsComplete, snapshot)
        } catch {
          // 单次增量写回失败不应中断整页翻译，最终结果仍由调用方按锚点失配统计。
        }
      }).then(() => {
        pendingWriteBacks -= 1
        finishIfReady()
      })
    }

    /**
     * 逐段翻译一个合并批次，用于模型未保留分隔标记时的兜底。
     * @param item 需要回退的合并批次。
     * @returns 按分段顺序排列的逐段翻译结果，单段失败时该段保留错误。
     * @author zhenghq
     */
    const fallbackSegments = async (item: WebTranslationWorkItem): Promise<PageTranslationResult[]> => {
      const output: PageTranslationResult[] = []
      for (const segment of item.segments) {
        try {
          const single = await this.translate(segment.text, job.sourceLang, job.targetLang)
          if (isStale()) return []
          output.push(this.success(segment, single))
        } catch (error) {
          if (isStale()) return []
          output.push({ ...segment, error: error instanceof Error ? error.message : '翻译失败' })
        }
      }
      return output
    }

    /**
     * 处理一个翻译工作项；合并批次拆分失败时自动回退为逐段请求。
     * @param item 当前工作项，可能是单分段或跨块合并批次。
     * @returns 当前工作项处理完成后的 Promise。
     * @author zhenghq
     */
    const processWorkItem = async (item: WebTranslationWorkItem): Promise<void> => {
      let completedResults: PageTranslationResult[] = []
      try {
        if (item.merged && mergeUnsupported) {
          const fallback = await fallbackSegments(item)
          failed += fallback.filter((result) => result.error).length
          completedResults = fallback
        } else {
          const output = await this.translate(item.text, job.sourceLang, job.targetLang)
          if (!isStale()) {
            if (item.merged) {
              const parts = parseMergedTranslation(item.batch, output.translation)
              // 拆分出的任一段译文为空都视为不可用，回退逐段以避免写入空译文导致原文丢失。
              if (parts && parts.every((part) => part !== '')) {
                completedResults = item.segments.map((segment, index) => this.success(segment, output, parts[index]))
              } else {
                // 非 AI 通道未按约定保留标记时，后续批次不再发送注定无效的合并请求。
                if (output.provider !== undefined && output.provider !== 'ai') mergeUnsupported = true
                const fallback = await fallbackSegments(item)
                failed += fallback.filter((result) => result.error).length
                completedResults = fallback
              }
            } else {
              completedResults = item.segments.map((segment) => this.success(segment, output))
            }
          }
        }
      } catch (error) {
        if (!isStale()) {
          if (item.merged) {
            // 合并批次整体失败时回退逐段请求，避免下游通道字符上限更小时整批失败。
            const fallback = await fallbackSegments(item)
            failed += fallback.filter((result) => result.error).length
            completedResults = fallback
          } else {
            failed += 1
            const message = error instanceof Error ? error.message : '翻译失败'
            completedResults = item.segments.map((segment) => ({ ...segment, error: message }))
          }
        }
      }
      if (!isStale()) {
        // 进度按实际发出的请求数统计，跨块合并后用户看到的待翻译数才会真实下降；
        // 先累加再提交，保证每次进度事件里的 done 与 total 处于同一时刻。
        done += 1
        for (const completed of completedResults) commitResult(completed)
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
      const concurrency = this.getConcurrency()
      while (active < concurrency && queue.length > 0) {
        const item = queue.shift() as WebTranslationWorkItem
        active += 1
        void processWorkItem(item)
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
        const blockUnits = new Map<string, ExtractedWebTextUnit[]>()
        for (const unit of units) {
          if (job.scope === 'body' && unit.category !== 'body') continue
          const unitKey = createWebTextUnitKey(unit)
          if (seenUnits.has(unitKey)) {
            stats.duplicate += 1
            continue
          }
          seenUnits.add(unitKey)
          const grouped = blockUnits.get(unit.blockId)
          if (grouped) grouped.push(unit)
          else blockUnits.set(unit.blockId, [unit])
        }
        // 先按块拆分，再把相邻短分段合并成更少的请求，最后统一入队。
        const pendingSegments: WebTranslationSegment[] = []
        for (const groupedUnits of blockUnits.values()) {
          const primary = groupedUnits[0]
          if (acceptedUnits >= Math.max(0, job.maxBlocks ?? Number.MAX_SAFE_INTEGER)) {
            stats.truncated += 1
            truncated = true
            continue
          }
          const segments = splitWebTextUnits(groupedUnits, { maxChars: job.maxCharsPerSegment, locale: job.locale })
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
          for (const groupedUnit of groupedUnits) {
            unitSegmentTotals.set(groupedUnit.id, (unitSegmentTotals.get(groupedUnit.id) ?? 0) + segments.length)
          }
          // 只在完整段落之间插入分隔标记，避免把标记插进长段落被拆开的句子中间。
          if (job.mergeAcrossBlocks && segments.length === 1) {
            pendingSegments.push(...segments)
          } else {
            for (const segment of segments) {
              queue.push({
                batch: { batchId: segment.segmentId, segments: [segment], text: segment.text, mergeable: false },
                text: segment.text,
                segments: [segment],
                merged: false
              })
            }
          }
        }
        if (pendingSegments.length > 0) {
          const batches = buildWebTranslationBatches(pendingSegments, {
            maxChars: Math.min(job.maxCharsPerSegment, WEB_TRANSLATION_MERGED_BATCH_MAX_CHARS),
            maxBlocksPerBatch: job.maxSegmentsPerBatch
          })
          for (const batch of batches) {
            queue.push({ batch, text: batch.text, segments: batch.segments, merged: batch.mergeable })
          }
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
   * @param translation 可选的本段译文，用于跨块合并后按标记拆分的结果。
   * @returns 结构化网页翻译结果。
   * @author zhenghq
   */
  private success(
    segment: WebTranslationSegment,
    output: Awaited<ReturnType<PageTranslator>>,
    translation?: string
  ): PageTranslationResult {
    return {
      unitId: segment.unitId,
      unitIds: segment.unitIds,
      blockId: segment.blockId,
      segmentId: segment.segmentId,
      segmentTotal: segment.segmentTotal,
      text: segment.text,
      translation: translation ?? output.translation,
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
  const unitsByBlock = new Map<string, ExtractedWebTextUnit[]>()
  for (const unit of units) {
    const list = unitsByBlock.get(unit.blockId)
    if (list) list.push(unit)
    else unitsByBlock.set(unit.blockId, [unit])
  }

  const translations = new Map<string, string>()
  const errors = new Map<string, string>()
  for (const [blockId, blockUnits] of unitsByBlock) {
    const positionByUnitId = new Map(blockUnits.map((unit, index) => [unit.id, index]))
    const blockUnitIds = new Set(positionByUnitId.keys())
    const blockResults = results.filter((result) => {
      const coveredIds = result.unitIds?.length ? result.unitIds : [result.unitId]
      return coveredIds.some((unitId) => blockUnitIds.has(unitId))
    })
    const failure = blockResults.find((result) => result.error)
    if (failure?.error) {
      for (const unit of blockUnits) errors.set(unit.id, failure.error)
      continue
    }
    const covered = new Set<string>()
    const indexesByBatch = new Map<string, Set<number>>()
    const totalsByBatch = new Map<string, number>()
    for (const result of blockResults) {
      const coveredIds = result.unitIds?.length ? result.unitIds : [result.unitId]
      for (const unitId of coveredIds) covered.add(unitId)
      const batchKey = result.unitId
      totalsByBatch.set(batchKey, Math.max(totalsByBatch.get(batchKey) ?? 1, result.segmentTotal ?? 1))
      const segmentIndex = Number(result.segmentId.split(':').pop() ?? Number.NaN)
      if (!Number.isFinite(segmentIndex)) continue
      const indexes = indexesByBatch.get(batchKey) ?? new Set<number>()
      indexes.add(segmentIndex)
      indexesByBatch.set(batchKey, indexes)
    }
    // 段落内全部文本单元都有对应分段结果时，才认为整段翻译完成。
    if (!blockUnits.every((unit) => covered.has(unit.id))) continue
    // 每个来源批次必须收齐从 0 开始、连续到 segmentTotal - 1 的全部分段，避免长段落漏译。
    let complete = true
    for (const [batchKey, total] of totalsByBatch) {
      const indexes = indexesByBatch.get(batchKey) ?? new Set<number>()
      for (let index = 0; index < total; index += 1) {
        if (!indexes.has(index)) { complete = false; break }
      }
      if (!complete) break
    }
    if (!complete) continue
    const ordered = blockResults.slice().sort((left, right) => {
      const leftCovered = left.unitIds?.length ? left.unitIds : [left.unitId]
      const rightCovered = right.unitIds?.length ? right.unitIds : [right.unitId]
      const leftPosition = Math.min(...leftCovered.map((unitId) => positionByUnitId.get(unitId) ?? Number.MAX_SAFE_INTEGER))
      const rightPosition = Math.min(...rightCovered.map((unitId) => positionByUnitId.get(unitId) ?? Number.MAX_SAFE_INTEGER))
      if (leftPosition !== rightPosition) return leftPosition - rightPosition
      const leftIndex = Number(left.segmentId.split(':').pop() ?? 0)
      const rightIndex = Number(right.segmentId.split(':').pop() ?? 0)
      return leftIndex - rightIndex
    })
    const translation = ordered.map((result) => result.translation ?? '').join('')
    // 段落级译文只挂在首个文本单元，其余单元写空串，避免原位或对照模式重复展示。
    translations.set(blockUnits[0].id, translation)
    for (let index = 1; index < blockUnits.length; index += 1) {
      translations.set(blockUnits[index].id, '')
    }
  }

  return units.map((unit) => {
    const error = errors.get(unit.id)
    if (error !== undefined) return { ...unit, error }
    const translation = translations.get(unit.id)
    return translation === undefined ? { ...unit } : { ...unit, translation }
  })
}
