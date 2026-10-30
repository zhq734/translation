import type {
  DocumentBlock,
  DocumentBoundingBox,
  DocumentImageBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentTableBlock,
  DocumentTextBlock,
  DocumentTextAlign,
  DocumentTextStyle
} from '../shared/documentTypes.ts'
import {
  completeDocumentTask,
  completeDocumentTaskPhase,
  markDocumentTaskPartial,
  moveDocumentTaskToPhase,
  requestDocumentTaskCancellation,
  updateDocumentTaskProgress,
  type DocumentTaskState
} from '../shared/documentTask.ts'
import type { OcrRecognizeResult } from '../shared/ocrEngine.ts'
import {
  buildWebTranslationBatches,
  parseMergedTranslation,
  splitText,
  type WebTranslationBatch,
  type WebTranslationSegment
} from '../shared/webBlockSplitter.ts'
import {
  createDocumentModel,
  type DocumentParseInput
} from './documentParserShared.ts'
import type { DocumentWarning } from '../shared/documentTypes.ts'
import { DOCUMENT_OCR_UNIFORM_FONT_SIZE } from '../shared/documentOcrLayout.ts'
import {
  resolveDocumentLanguagePair,
  type DocumentLanguagePair,
  type DocumentLanguagePreference,
  type DocumentLanguageResolution
} from '../shared/documentLanguageDirection.ts'
import {
  evaluateDocumentCompletion,
  type DocumentCompletionReport,
  type DocumentCompletionTarget
} from '../shared/documentCompletion.ts'

/** 文档跨目标合并后单个请求的最大字符数，与页面翻译保持同一安全上限。 */
const DOCUMENT_TRANSLATION_MERGED_BATCH_MAX_CHARS = 1800

/** 文档翻译默认并发数，与页面翻译默认值保持一致。 */
const DOCUMENT_TRANSLATION_DEFAULT_CONCURRENCY = 3

/** 文档翻译允许的最大并发数。 */
const DOCUMENT_TRANSLATION_MAX_CONCURRENCY = 8

/** 单个批次最多覆盖的文档目标数；与页面翻译一样由字符上限优先控制请求大小。 */
const DOCUMENT_TRANSLATION_MAX_TARGETS_PER_BATCH = 50

/** 流式译文整页快照的最小发布间隔，避免每个 token 都复制并发送整份文档。 */
const DOCUMENT_TRANSLATION_PUBLISH_INTERVAL_MS = 80

/** 表格行内单元格之间使用的内部标记前缀，避免译文错位写入其他单元格。 */
const DOCUMENT_TABLE_CELL_MARKER_PREFIX = 'ST-DOC-CELL'

/** 装饰性页眉小图允许占页面宽高的最大比例。 */
const DOCUMENT_DECORATIVE_IMAGE_MAX_PAGE_RATIO = 0.08

/** 装饰性页眉小图允许距离页面顶部的最小和最大比例。 */
const DOCUMENT_DECORATIVE_IMAGE_TOP_MIN_RATIO = 0.01
const DOCUMENT_DECORATIVE_IMAGE_TOP_MAX_RATIO = 0.12

/** 相同装饰图布局至少重复出现的页数，避免误跳过普通正文截图。 */
const DOCUMENT_DECORATIVE_IMAGE_MIN_REPEAT_PAGES = 3

/** 未注入模型指纹依赖时使用的稳定默认值，便于测试与离线运行生成可复验报告。 */
const DOCUMENT_TRANSLATION_DEFAULT_MODEL_FINGERPRINT = 'document-translation-model'

/** 文档流水线结果。 */
export interface DocumentPipelineResult {
  /** 源文档模型。 */
  source: DocumentModel
  /** 翻译后的文档模型。 */
  translation: DocumentModel
  /** 最终任务状态。 */
  task: DocumentTaskState
  /** 翻译失败且仍可重新请求的目标标识。 */
  failedTargetIds?: string[]
  /** 包含失败、未完成与疑似未翻译目标的完整可重试集合。 */
  retryableTargetIds?: string[]
  /** 基于完整文档目标生成的完成报告。 */
  completionReport?: DocumentCompletionReport
  /** 用户选择的原始源语言偏好。 */
  sourcePreference?: string
  /** 用户选择的原始目标语言偏好。 */
  targetPreference?: string
  /** 本次任务冻结并在全部请求中复用的实际语言对。 */
  languagePair?: DocumentLanguagePair
  /** 本次任务冻结的完整语言解析结果，重试必须原样复用。 */
  languageResolution?: DocumentLanguageResolution
}

/** 文档流水线可注入依赖。 */
export interface DocumentPipelineDeps {
  /** 解析文档。 */
  parse(input: DocumentParseInput): Promise<DocumentModel>
  /** 读取文档资源字节。 */
  loadAssetBytes(asset: DocumentModel['assets'][number]): Promise<Uint8Array | null>
  /** 识别图片文字。 */
  recognizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<OcrRecognizeResult>
  /** 翻译单段文本，显式接收任务级语言对，并通过 onDelta 推送当前片段的增量译文。 */
  translate(
    text: string,
    signal: AbortSignal,
    languagePair: DocumentLanguagePair,
    onDelta?: (delta: string) => void
  ): Promise<string>
  /** 任务状态变化回调。 */
  onProgress(state: DocumentTaskState): void
  /** 可选的部分译文发布回调，用于界面流式展示。 */
  publishTranslation?(translation: DocumentModel): void
  /** 可选页面栅格化适配器，用于扫描 PDF。 */
  renderPage?: (pageIndex: number) => Promise<Uint8Array | null>
  /** 可选翻译并发数，未提供时使用默认值并限制在 1 到 8 之间。 */
  concurrency?: number
  /**
   * 读取当前翻译提供方与模型的稳定指纹，用于完成报告绑定。
   * @returns 不含凭据的模型指纹。
   * @author zhenghq
   */
  getModelFingerprint?(): string
}

/** 文本目标在页面区块树中的定位路径；表格描述符定位到单元格后继续使用区块索引。 */
type DocumentBlockPath = Array<number | { row: number; cell: number }>

/** 可翻译目标类型。 */
type TranslationTargetKind = 'text-block' | 'table-row' | 'ocr-region'

/** 文本块内参与同一个大段翻译的连续 run。 */
interface TranslationRunRange {
  /** 参与本次翻译的首个 run 标识。 */
  runId: string
  /** 参与本次翻译的全部 run 标识，按原文顺序排列。 */
  runIds: string[]
  /** 参与翻译 run 拼接后的原文。 */
  text: string
  /** 首个 run 的样式，用于写回聚合译文。 */
  style?: DocumentTextStyle
}

/** 表格行内一个待翻译单元格。 */
interface TranslationTableCellRange {
  /** 单元格在所属行中的索引。 */
  cellIndex: number
  /** 单元格文本区块路径。 */
  blockPath: DocumentBlockPath
  /** 单元格内参与翻译的文本块与 run 区间。 */
  blocks: Array<{ blockPath: DocumentBlockPath; runs: TranslationRunRange[] }>
  /** 单元格完整原文。 */
  text: string
}

/** 跨文本、OCR 与表格统一调度的翻译目标。 */
interface TranslationTarget {
  /** 稳定目标标识，用于分段与回填。 */
  targetId: string
  /** 目标类型。 */
  kind: TranslationTargetKind
  /** 目标所属页面索引。 */
  pageIndex: number
  /** 目标在页面区块树中的路径。 */
  path: DocumentBlockPath
  /** 文本 run 标识；OCR 目标不使用。 */
  runId?: string
  /** 文本块聚合目标覆盖的 run 标识；单 run 目标省略。 */
  runIds?: string[]
  /** 文本块聚合目标使用的首个 run 样式。 */
  runStyle?: DocumentTextStyle
  /** 表格行目标内的单元格映射。 */
  cells?: TranslationTableCellRange[]
  /** 表格行在所属表格中的索引；写回时不能从区块路径推断。 */
  tableRowIndex?: number
  /** OCR 区域索引；文本目标不使用。 */
  regionIndex?: number
  /** 待翻译原文，包含首尾空白。 */
  text: string
  /** 首部空白，合并翻译后需要恢复。 */
  leadingWhitespace: string
  /** 尾部空白，合并翻译后需要恢复。 */
  trailingWhitespace: string
}

/** 文档批量翻译分段，附带目标与目标内分段信息。 */
interface DocumentBatchSegment extends WebTranslationSegment {
  /** 所属翻译目标。 */
  target: TranslationTarget
  /** 目标内分段序号。 */
  pieceIndex: number
  /** 目标内分段总数。 */
  pieceTotal: number
}

/** 文档批量翻译工作项，保留批次与来源分段的一一对应关系。 */
interface DocumentTranslationBatch {
  /** 共享合并协议构造的批次。 */
  batch: WebTranslationBatch
  /** 当前批次覆盖的文档分段。 */
  segments: DocumentBatchSegment[]
  /** 是否为包含分段标记的合并请求。 */
  merged: boolean
}

/** 单个翻译目标的完成进度。 */
interface TargetTranslationState {
  /** 目标原文。 */
  target: TranslationTarget
  /** 已完成的译文片段。 */
  pieces: Array<string | undefined>
  /** 已完成片段数。 */
  completed: number
  /** 目标全部分段数。 */
  pieceTotal: number
  /** 是否已有任一片段失败。 */
  failed: boolean
  /** 目标是否已经成功或失败收尾，避免并发分段重复计数。 */
  finished: boolean
  /** 目标成功收尾后的完整译文。 */
  translation?: string
  /** 目标失败时保留的稳定原因。 */
  failureReason?: string
}

/** 单个分段应用后的目标级状态变化。 */
interface SegmentApplicationResult {
  /** 当前分段是否让目标完成收尾。 */
  finished: boolean
  /** 目标是否失败并保留原文。 */
  failed: boolean
  /** 目标完成时恢复首尾空白后的译文。 */
  translation?: string
  /** 表格行译文无法可靠拆回单元格，需要调用方逐单元格回退。 */
  needsTableRowFallback?: boolean
}

/** 合并批次中已经能够可靠识别的流式分段。 */
interface StreamedMergedSegment {
  /** 分段在批次中的顺序。 */
  index: number
  /** 当前已可展示的译文。 */
  translation: string
}

/** 文档译文流式发布器。 */
interface DocumentTranslationPublisher {
  /**
   * 在翻译阶段开始时立即发布原文占位，不消耗首个流式增量窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  publishInitial(): void
  /**
   * 请求发布当前译文快照；首个快照立即发布，后续请求在节流窗口内合并。
   * @returns 无返回值。
   * @author zhenghq
   */
  request(): void
  /**
   * 立即发布尚未发送的最新快照。
   * @returns 无返回值。
   * @author zhenghq
   */
  flush(): void
  /**
   * 丢弃尚未发送的流式快照，用于失败或取消后不再向界面推送旧状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancel(): void
}

/**
 * 创建译文流式发布器；第一帧立即发送以保证首段可见，之后按固定间隔合并。
 * @param publish 实际发布整份译文快照的回调。
 * @param isAborted 当前任务是否已取消。
 * @param intervalMs 合并窗口毫秒数。
 * @returns 可请求、强制刷新和取消的发布器。
 * @author zhenghq
 */
function createDocumentTranslationPublisher(
  publish: () => void,
  isAborted: () => boolean,
  intervalMs = DOCUMENT_TRANSLATION_PUBLISH_INTERVAL_MS
): DocumentTranslationPublisher {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  let hasPublished = false

  /**
   * 发送当前最新快照，并保留窗口内尚未发送的请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) return
    pending = false
    if (isAborted()) return
    hasPublished = true
    publish()
  }

  /**
   * 请求一次流式快照发布；首个请求同步发送，后续请求合并到窗口尾沿。
   * @returns 无返回值。
   * @author zhenghq
   */
  const request = (): void => {
    if (isAborted()) return
    pending = true
    if (!hasPublished) {
      flush()
      return
    }
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, Math.max(1, Math.floor(intervalMs)))
  }

  /**
   * 取消待发送快照，避免任务结束后继续推送流式内容。
   * @returns 无返回值。
   * @author zhenghq
   */
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = false
  }

  /**
   * 立即发送初始占位快照，并保持首个流式增量仍可同步发布。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishInitial = (): void => {
    if (isAborted()) return
    pending = true
    flush()
    hasPublished = false
  }

  return { publishInitial, request, flush, cancel }
}

/**
 * 去掉流式响应中尚未接收完整的分段标记，同时保留标记后的正文。
 * @param text 当前累计的合并批次响应。
 * @returns 不含残缺尾部标记的文本。
 * @author zhenghq
 */
function stripIncompleteSegmentMarker(text: string): string {
  // 仅处理响应尾部仍可能继续增长为 ST-SEG 的片段，正文中的完整方括号不受影响。
  return text.replace(/\[\[\[\s*(?:S(?:T(?:-(?:S(?:E(?:G(?:-\d*)?)?)?)?)?)?)?\s*\]*$/u, '')
}

/**
 * 从合并批次流式响应中读取当前可发布的分段译文。
 * @param translation 当前累计的完整响应。
 * @param segmentCount 批次包含的分段总数。
 * @returns 按分段顺序排列且已可安全展示的译文。
 * @author zhenghq
 */
function readStreamedMergedSegments(
  translation: string,
  segmentCount: number
): StreamedMergedSegment[] {
  const pattern = /\[\[\[\s*ST-SEG-(\d+)\s*\]\]\]/gu
  const markers: Array<{ index: number; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(translation)) !== null) {
    markers.push({ index: Number(match[1]), start: match.index, end: match.index + match[0].length })
  }

  const streamed: StreamedMergedSegment[] = []
  let expectedIndex = 0
  let segmentStart = 0
  for (const marker of markers) {
    if (marker.index !== expectedIndex || expectedIndex >= segmentCount) break
    const part = translation.slice(segmentStart, marker.start).trim()
    if (part) streamed.push({ index: expectedIndex, translation: part })
    expectedIndex += 1
    segmentStart = marker.end
  }
  if (expectedIndex < segmentCount) {
    const current = stripIncompleteSegmentMarker(translation.slice(segmentStart)).trim()
    if (current) streamed.push({ index: expectedIndex, translation: current })
  }
  return streamed
}

/**
 * 判断异常是否由主动取消引起。
 * @param error 待判断异常。
 * @param signal 当前取消信号。
 * @returns 是否属于取消。
 * @author zhenghq
 */
function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

/**
 * 发送当前任务进度。
 * @param state 当前任务状态。
 * @param deps 流水线依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
function emitProgress(state: DocumentTaskState, deps: DocumentPipelineDeps): void {
  deps.onProgress({ ...state, progress: { ...state.progress } })
}

/**
 * 构造取消终态结果，并保留取消前已经完成的源模型与译文页面。
 * @param source 已完成解析和 OCR 的源文档。
 * @param translation 取消前已经合成的译文文档。
 * @param state 当前任务状态。
 * @param deps 流水线依赖。
 * @returns 可直接返回给任务服务的取消结果。
 * @author zhenghq
 */
function createCancelledResult(
  source: DocumentModel,
  translation: DocumentModel,
  state: DocumentTaskState,
  deps: DocumentPipelineDeps,
  languageResolution: Pick<DocumentPipelineResult, 'sourcePreference' | 'targetPreference' | 'languagePair'>,
  failedTargetIds?: string[],
  targetStates?: Map<string, TargetTranslationState>
): DocumentPipelineResult {
  const cancelled = requestDocumentTaskCancellation(state)
  emitProgress(cancelled, deps)
  const completionReport = buildDocumentCompletionReport(
    source,
    translation,
    cancelled,
    targetStates,
    deps,
    languageResolution,
    true
  )
  return {
    source,
    translation,
    task: cancelled,
    completionReport,
    retryableTargetIds: collectRetryableTargetIds(completionReport),
    ...languageResolution,
    languageResolution: {
      sourcePreference: languageResolution.sourcePreference ?? 'auto',
      targetPreference: languageResolution.targetPreference ?? 'auto',
      languagePair: languageResolution.languagePair ?? { sourceLang: 'auto', targetLang: 'auto' }
    },
    ...(failedTargetIds ? { failedTargetIds: [...failedTargetIds] } : {})
  }
}

/**
 * 完成指定翻译目标后的布局与导出阶段，并生成可继续重试的任务状态。
 * @param source 已完成解析与 OCR 的源文档。
 * @param translation 已合并成功译文、仍保留失败原文的译文文档。
 * @param state 已完成翻译阶段的任务状态。
 * @param failedTargetIds 本轮仍失败的目标标识。
 * @param failedBlockCount 包含 OCR 与翻译在内的失败块总数。
 * @param deps 流水线依赖。
 * @returns 可返回给任务服务的完整流水线结果。
 * @author zhenghq
 */
function finalizeTranslationResult(
  source: DocumentModel,
  translation: DocumentModel,
  state: DocumentTaskState,
  failedTargetIds: string[],
  ocrFailedCount: number,
  deps: DocumentPipelineDeps,
  languageResolution: Pick<DocumentPipelineResult, 'sourcePreference' | 'targetPreference' | 'languagePair'>,
  targetStates?: Map<string, TargetTranslationState>
): DocumentPipelineResult {
  const completionReport = buildDocumentCompletionReport(
    source,
    translation,
    state,
    targetStates,
    deps,
    languageResolution
  )
  const retryableTargetIds = collectRetryableTargetIds(completionReport)
  const failedBlockCount = retryableTargetIds.length + Math.max(0, ocrFailedCount)
  let layoutState = moveDocumentTaskToPhase(state, 'layout')
  layoutState = completeDocumentTaskPhase(layoutState)
  emitProgress(layoutState, deps)
  let exportState = moveDocumentTaskToPhase(layoutState, 'export')
  exportState = completeDocumentTaskPhase(exportState)
  emitProgress(exportState, deps)
  // 没有成功译文时任务必须保持 failed 以阻止完整导出；可重试目标由任务服务
  // 单独记录，不能为了让按钮可用而把无可用结果的任务伪装成 partial。
  const finalState = completionReport.status === 'failed'
    ? {
        ...exportState,
        status: 'failed' as const,
        errorCode: 'translation-failed',
        failedBlocks: failedBlockCount,
        warningCount: translation.warnings.length
      }
    : completionReport.status === 'cancelled'
      ? requestDocumentTaskCancellation(exportState)
      : completionReport.status === 'partial' || ocrFailedCount > 0
    ? markDocumentTaskPartial(exportState, {
        failedBlocks: failedBlockCount,
        warningCount: translation.warnings.length
      })
    : completeDocumentTask(exportState, {
        failedBlocks: 0,
        warningCount: translation.warnings.length
      })
  emitProgress(finalState, deps)
  return {
    source,
    translation,
    task: finalState,
    failedTargetIds: [...completionReport.failedTargetIds],
    retryableTargetIds,
    completionReport,
    ...languageResolution,
    languageResolution: {
      sourcePreference: languageResolution.sourcePreference ?? 'auto',
      targetPreference: languageResolution.targetPreference ?? 'auto',
      languagePair: languageResolution.languagePair ?? { sourceLang: 'auto', targetLang: 'auto' }
    }
  }
}

/**
 * 提取文本首尾空白，供合并翻译拆回后恢复原有排版。
 * @param text 原始文本。
 * @returns 首部与尾部空白。
 * @author zhenghq
 */
function splitBoundaryWhitespace(text: string): { leading: string; trailing: string } {
  const leading = text.match(/^\s*/u)?.[0] ?? ''
  const trailing = text.match(/\s*$/u)?.[0] ?? ''
  return {
    leading,
    trailing: text.length > leading.length ? trailing : ''
  }
}

/**
 * 在异步翻译返回后确认任务仍可继续，主动取消时抛出标准 AbortError。
 * @param signal 当前取消信号。
 * @returns 无返回值。
 * @author zhenghq
 */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('Document translation aborted')
  error.name = 'AbortError'
  throw error
}

/**
 * 将文本块中的连续可翻译 run 聚合为大段，受保护 run 作为边界保留原位置。
 * @param block 待聚合的文本区块。
 * @returns 按原文顺序排列的连续 run 区间。
 * @author zhenghq
 */
function collectTextRunRanges(block: DocumentTextBlock): TranslationRunRange[] {
  const ranges: TranslationRunRange[] = []
  let current: TranslationRunRange | undefined
  for (const run of block.runs) {
    if (run.protected || !run.text.trim()) {
      if (current) ranges.push(current)
      current = undefined
      continue
    }
    // 样式变化会改变字号、颜色或粗细；合并翻译会让译文全部继承首 run，必须在此切段。
    if (current && !sameDocumentTextStyle(current.style, run.style)) {
      ranges.push(current)
      current = undefined
    }
    if (!current) {
      current = {
        runId: run.runId,
        runIds: [],
        text: '',
        ...(run.style ? { style: { ...run.style } } : {})
      }
    }
    current.runIds.push(run.runId)
    current.text += run.text
  }
  if (current) ranges.push(current)
  return ranges
}

/**
 * 比较两个文本 run 的有效样式是否一致；缺失字段与显式默认值视为不同，以保留原始排版意图。
 * @param left 前一个 run 样式。
 * @param right 后一个 run 样式。
 * @returns 样式是否可直接合并翻译。
 * @author zhenghq
 */
function sameDocumentTextStyle(
  left: DocumentTextStyle | undefined,
  right: DocumentTextStyle | undefined
): boolean {
  if (!left || !right) return left === right
  const keys: Array<keyof DocumentTextStyle> = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'color',
    'backgroundColor',
    'italic',
    'underline',
    'strikethrough',
    'letterSpacing',
    'lineHeight'
  ]
  return keys.every((key) => left[key] === right[key])
}

/**
 * 判断两个连续 run 是否需要保留空白边界，避免翻译前把单词直接粘连。
 * @param previousText 前一个 run 的末尾文本。
 * @param nextText 后一个 run 的开头文本。
 * @returns 是否应插入一个空格。
 * @author zhenghq
 */
function needsRunSeparator(previousText: string, nextText: string): boolean {
  if (!previousText || !nextText) return false
  if (/\s$/u.test(previousText) || /^\s/u.test(nextText)) return false
  return /[A-Za-z0-9]$/u.test(previousText) && /^[A-Za-z0-9]/u.test(nextText)
}

/**
 * 收集表格单元格内所有文本 run，并把同一文本块内的连续 run 聚合成大段。
 * @param blocks 单元格子区块。
 * @param path 当前子区块路径。
 * @returns 按阅读顺序排列的文本区块路径与 run 区间。
 * @author zhenghq
 */
function collectCellTextRanges(
  blocks: DocumentBlock[],
  path: DocumentBlockPath = []
): Array<{ blockPath: DocumentBlockPath; runs: TranslationRunRange[] }> {
  const output: Array<{ blockPath: DocumentBlockPath; runs: TranslationRunRange[] }> = []
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!
    const blockPath = [...path, blockIndex]
    if (block.kind === 'text' && block.translatable) {
      const runs = collectTextRunRanges(block)
      if (runs.length > 0) output.push({ blockPath, runs })
      continue
    }
    if (block.kind === 'table') {
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        for (let cellIndex = 0; cellIndex < block.rows[rowIndex]!.cells.length; cellIndex += 1) {
          output.push(...collectCellTextRanges(
            block.rows[rowIndex]!.cells[cellIndex]!.blocks,
            [...blockPath, { row: rowIndex, cell: cellIndex }]
          ))
        }
      }
    }
  }
  return output
}

/**
 * 将单元格内的多个文本块拼接为翻译原文，并在块边界补充必要空白。
 * @param blocks 单元格内文本块及 run 区间。
 * @returns 单元格待翻译原文。
 * @author zhenghq
 */
function joinCellTextRanges(
  blocks: Array<{ blockPath: DocumentBlockPath; runs: TranslationRunRange[] }>
): string {
  let output = ''
  for (const block of blocks) {
    // PDF 等格式会把同一单元格的视觉行拆成独立文本块，翻译前必须保留块间换行。
    if (output && block.runs.length > 0) output += '\n'
    for (const run of block.runs) {
      if (needsRunSeparator(output, run.text)) output += ' '
      output += run.text
    }
  }
  return output
}

/**
 * 构造表格行内单元格之间的稳定分隔标记。
 * @param index 单元格在行内的顺序。
 * @returns 可被翻译服务原样保留的标记。
 * @author zhenghq
 */
function tableCellMarker(index: number): string {
  return `\n[[[${DOCUMENT_TABLE_CELL_MARKER_PREFIX}-${index}]]]\n`
}

/**
 * 把表格行的单元格拼接为一个待翻译大块。
 * @param cells 当前行的单元格。
 * @returns 带内部单元格标记的原文。
 * @author zhenghq
 */
function joinTableRowCells(cells: TranslationTableCellRange[]): string {
  return cells.map((cell, index) =>
    `${index === 0 ? '' : tableCellMarker(index - 1)}${cell.text}`).join('')
}

/**
 * 按内部单元格标记拆回表格行译文；标记缺失或顺序错误时返回 null。
 * @param target 表格行目标。
 * @param translated 模型返回的整行译文。
 * @returns 与单元格一一对应的译文；无法可靠拆分时返回 null。
 * @author zhenghq
 */
function parseTableRowTranslation(target: TranslationTarget, translated: string): string[] | null {
  const cells = target.cells ?? []
  if (cells.length === 0) return null
  if (cells.length === 1) return [translated.trim()]
  const pattern = new RegExp(`\\[\\[\\[\\s*${DOCUMENT_TABLE_CELL_MARKER_PREFIX}-(\\d+)\\s*\\]\\]\\]`, 'gu')
  const markers: Array<{ index: number; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(translated)) !== null) {
    markers.push({ index: Number(match[1]), start: match.index, end: match.index + match[0].length })
  }
  if (markers.length !== cells.length - 1) return null
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index]!.index !== index) return null
  }
  const parts: string[] = []
  let lastIndex = 0
  for (const marker of markers) {
    parts.push(translated.slice(lastIndex, marker.start).trim())
    lastIndex = marker.end
  }
  parts.push(translated.slice(lastIndex).trim())
  return parts.every((part) => part.length > 0) ? parts : null
}

/**
 * 判断完整表格行译文是否仍保留足够的单元格分隔标记。
 * @param target 待校验的翻译目标。
 * @param translated 模型返回的完整行译文。
 * @returns 单单元格或可可靠拆分的多单元格行返回 true。
 * @author zhenghq
 */
function isTableRowTranslationValid(target: TranslationTarget, translated: string): boolean {
  if (target.kind !== 'table-row' || (target.cells?.length ?? 0) <= 1) return true
  return parseTableRowTranslation(target, translated) !== null
}

/**
 * 将逐单元格译文按协议标记重新拼接为表格行译文。
 * @param target 表格行目标。
 * @param translatedCells 与目标单元格顺序一致的译文。
 * @returns 可被现有表格行写回逻辑拆分的译文。
 * @author zhenghq
 */
function composeTableRowTranslation(
  target: TranslationTarget,
  translatedCells: string[]
): string {
  const cells = target.cells ?? []
  return cells.map((_cell, index) =>
    `${index === 0 ? '' : tableCellMarker(index - 1)}${translatedCells[index] ?? ''}`).join('')
}

/**
 * 在整行翻译无法可靠拆分时逐单元格请求翻译，作为表格行的确定性回退。
 * @param target 表格行目标。
 * @param signal 当前取消信号。
 * @param deps 流水线依赖。
 * @returns 重组后的表格行译文；任一单元格翻译为空时返回 null。
 * @author zhenghq
 */
async function translateTableRowCells(
  target: TranslationTarget,
  signal: AbortSignal,
  deps: DocumentPipelineDeps,
  languagePair: DocumentLanguagePair
): Promise<string | null> {
  const cells = target.cells ?? []
  if (cells.length === 0) return null
  const translatedCells: string[] = []
  for (const cell of cells) {
    throwIfAborted(signal)
    const parts = splitText(cell.text.trim(), DOCUMENT_TRANSLATION_MERGED_BATCH_MAX_CHARS)
    const translatedParts: string[] = []
    for (const part of parts) {
      const translated = await deps.translate(part, signal, languagePair)
      throwIfAborted(signal)
      if (!translated.trim()) return null
      translatedParts.push(translated.trim())
    }
    translatedCells.push(translatedParts.join(''))
  }
  return composeTableRowTranslation(target, translatedCells)
}

/**
 * 递归收集页面区块中的文本 run、OCR 区域与表格单元格文本目标。
 * @param blocks 待遍历区块。
 * @param pageIndex 页面索引。
 * @param path 当前区块路径。
 * @param targets 目标收集数组。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectBlockTargets(
  blocks: DocumentBlock[],
  pageIndex: number,
  path: DocumentBlockPath,
  targets: TranslationTarget[]
): void {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!
    const blockPath = [...path, blockIndex]
    if (block.kind === 'text' && block.translatable) {
      const ranges = collectTextRunRanges(block)
      for (const range of ranges) {
        const whitespace = splitBoundaryWhitespace(range.text)
        targets.push({
          targetId: `${pageIndex}:${blockPath.join('.')}:text:${range.runId}`,
          kind: 'text-block',
          pageIndex,
          path: blockPath,
          runId: range.runId,
          ...(range.runIds.length > 1 ? { runIds: range.runIds } : {}),
          ...(range.style ? { runStyle: range.style } : {}),
          text: range.text,
          leadingWhitespace: whitespace.leading,
          trailingWhitespace: whitespace.trailing
        })
      }
      continue
    }
    if (block.kind === 'image' && block.ocrRegions) {
      for (let regionIndex = 0; regionIndex < block.ocrRegions.length; regionIndex += 1) {
        const region = block.ocrRegions[regionIndex]!
        if (region.status !== 'recognized' || !region.text.trim()) continue
        const whitespace = splitBoundaryWhitespace(region.text)
        targets.push({
          targetId: `${pageIndex}:${blockPath.join('.')}:ocr:${region.regionId}`,
          kind: 'ocr-region',
          pageIndex,
          path: blockPath,
          regionIndex,
          text: region.text,
          leadingWhitespace: whitespace.leading,
          trailingWhitespace: whitespace.trailing
        })
      }
      continue
    }
    if (block.kind === 'table') {
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex]!
        const cells: TranslationTableCellRange[] = []
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
          const cell = row.cells[cellIndex]!
          const cellPath = [...blockPath, { row: rowIndex, cell: cellIndex }]
          const cellBlocks = collectCellTextRanges(cell.blocks)
          const text = joinCellTextRanges(cellBlocks)
          if (!text.trim()) continue
          cells.push({
            cellIndex,
            blockPath: cellPath,
            blocks: cellBlocks,
            text
          })
        }
        if (cells.length > 0) {
          const text = joinTableRowCells(cells)
          const whitespace = splitBoundaryWhitespace(text)
          targets.push({
            targetId: `${pageIndex}:${blockPath.join('.')}:row:${row.rowId}`,
            kind: 'table-row',
            pageIndex,
            path: blockPath,
            cells,
            tableRowIndex: rowIndex,
            text,
            leadingWhitespace: whitespace.leading,
            trailingWhitespace: whitespace.trailing
          })
        }
      }
    }
  }
}

/**
 * 收集文档中的全部可翻译目标。
 * @param model 文档模型。
 * @returns 按阅读顺序排列的翻译目标。
 * @author zhenghq
 */
function collectTranslationTargets(model: DocumentModel): TranslationTarget[] {
  const targets: TranslationTarget[] = []
  for (let pageIndex = 0; pageIndex < model.pages.length; pageIndex += 1) {
    collectBlockTargets(model.pages[pageIndex]!.blocks, pageIndex, [], targets)
  }
  return targets
}

/**
 * 将翻译目标拆成可合并批次的分段；超长目标先按句边界拆分。
 * @param targets 按阅读顺序排列的翻译目标。
 * @returns 带目标元数据的分段列表。
 * @author zhenghq
 */
function createDocumentBatchSegments(targets: TranslationTarget[]): DocumentBatchSegment[] {
  const segments: DocumentBatchSegment[] = []
  for (const target of targets) {
    const parts = splitText(target.text.trim(), DOCUMENT_TRANSLATION_MERGED_BATCH_MAX_CHARS)
    parts.forEach((part, index) => {
      segments.push({
        unitId: target.targetId,
        blockId: target.targetId,
        unitIds: [target.targetId],
        segmentId: `${target.targetId}:${index}`,
        index,
        segmentTotal: parts.length,
        text: part,
        target,
        pieceIndex: index,
        pieceTotal: parts.length
      })
    })
  }
  return segments
}

/**
 * 规范化文档翻译并发数。
 * @param concurrency 可选并发数。
 * @returns 1 到 8 之间的整数。
 * @author zhenghq
 */
function normalizeTranslationConcurrency(concurrency: number | undefined): number {
  if (!Number.isFinite(concurrency)) return DOCUMENT_TRANSLATION_DEFAULT_CONCURRENCY
  return Math.min(
    DOCUMENT_TRANSLATION_MAX_CONCURRENCY,
    Math.max(1, Math.floor(concurrency as number))
  )
}

/**
 * 还原目标译文的首尾空白；空译文回退为原文。
 * @param state 目标翻译状态。
 * @param translated 合并后的译文。
 * @returns 可写回模型的最终译文。
 * @author zhenghq
 */
function restoreTargetWhitespace(state: TargetTranslationState, translated: string): string {
  if (!translated.trim()) return state.target.text
  if (state.target.kind === 'table-row') return translated
  return `${state.target.leadingWhitespace}${translated.trim()}${state.target.trailingWhitespace}`
}

/**
 * 从已完成 OCR 与翻译的模型读取单个目标当前译文。
 * @param model 当前译文模型。
 * @param target 待读取的稳定目标。
 * @returns 目标译文；目标无法定位或表格映射损坏时返回 undefined。
 * @author zhenghq
 */
function readTargetTranslation(
  model: DocumentModel,
  target: TranslationTarget
): string | undefined {
  const page = model.pages[target.pageIndex]
  if (!page) return undefined
  const block = resolveTargetBlock(page.blocks, target.path)
  if (!block) return undefined
  if (target.kind === 'text-block' && block.kind === 'text') {
    const runIds = new Set(target.runIds ?? (target.runId ? [target.runId] : []))
    const translatedRuns = block.runs.filter((run) => runIds.has(run.runId))
    if (translatedRuns.length === 0) return undefined
    return translatedRuns.map((run) => run.text).join('')
  }
  if (target.kind === 'ocr-region' && block.kind === 'image') {
    const region = block.ocrRegions?.[target.regionIndex ?? -1]
    return region?.translatedText
  }
  if (target.kind === 'table-row' && block.kind === 'table') {
    return readTableRowTranslation(block, target)
  }
  return undefined
}

/**
 * 判断目标在译文模型中是否仍保留可可靠读回的表格结构。
 * @param model 当前译文模型。
 * @param target 待检查的翻译目标。
 * @returns 目标不是表格行或表格结构完整时返回 true。
 * @author zhenghq
 */
function isTargetTableMappingValid(model: DocumentModel, target: TranslationTarget): boolean {
  if (target.kind !== 'table-row' || (target.cells?.length ?? 0) <= 1) return true
  const page = model.pages[target.pageIndex]
  if (!page) return false
  const block = resolveTargetBlock(page.blocks, target.path)
  return block?.kind === 'table' && readTableRowTranslation(block, target) !== undefined
}

/**
 * 生成基于完整文档目标的完成报告，供终态、快照和重试复用。
 * @param source 已完成 OCR 的源文档。
 * @param translation 当前完整译文模型。
 * @param state 当前任务状态，用于绑定任务标识与代际。
 * @param targetStates 本代际参与翻译的目标状态；重试时只包含本轮目标。
 * @param deps 流水线依赖，用于读取模型指纹。
 * @param languageResolution 本任务冻结的语言偏好与实际语言对。
 * @param cancelled 是否由取消终态触发。
 * @returns 覆盖全部可翻译目标的完成报告。
 * @author zhenghq
 */
function buildDocumentCompletionReport(
  source: DocumentModel,
  translation: DocumentModel,
  state: DocumentTaskState,
  targetStates: Map<string, TargetTranslationState> | undefined,
  deps: DocumentPipelineDeps,
  languageResolution: Pick<DocumentPipelineResult, 'sourcePreference' | 'targetPreference' | 'languagePair'>,
  cancelled = false
): DocumentCompletionReport {
  const targets: DocumentCompletionTarget[] = collectTranslationTargets(source).map((target) => {
    const targetState = targetStates?.get(target.targetId)
    const translatedText = readTargetTranslation(translation, target)
    if (targetState?.finished) {
      if (targetState.failed) {
        return {
          targetId: target.targetId,
          sourceText: target.text,
          state: 'failed',
          failureReason: targetState.failureReason ?? 'translation-failed'
        }
      }
      return {
        targetId: target.targetId,
        sourceText: target.text,
        ...(targetState.translation !== undefined
          ? { translatedText: targetState.translation }
          : translatedText !== undefined ? { translatedText } : {}),
        state: 'translated',
        tableMappingValid: isTargetTableMappingValid(translation, target)
      }
    }
    if (targetState) {
      return {
        targetId: target.targetId,
        sourceText: target.text,
        state: 'pending'
      }
    }
    // 重试时已成功目标不在本轮 targetStates 中，必须从完整译文模型读回。
    if (translatedText === undefined) {
      return {
        targetId: target.targetId,
        sourceText: target.text,
        state: 'pending'
      }
    }
    return {
      targetId: target.targetId,
      sourceText: target.text,
      translatedText,
      state: 'translated',
      tableMappingValid: isTargetTableMappingValid(translation, target)
    }
  })
  const sourcePreference = languageResolution.sourcePreference ?? 'auto'
  const targetPreference = languageResolution.targetPreference ?? 'auto'
  const languagePair = languageResolution.languagePair ?? { sourceLang: 'auto', targetLang: 'auto' }
  return evaluateDocumentCompletion({
    jobId: state.jobId,
    generation: state.generation,
    documentId: source.documentId,
    modelFingerprint: deps.getModelFingerprint?.() ?? DOCUMENT_TRANSLATION_DEFAULT_MODEL_FINGERPRINT,
    sourcePreference,
    targetPreference,
    languagePair,
    targets,
    cancelled
  })
}

/**
 * 从完成报告中提取需要用户重试的全部目标，保持稳定顺序。
 * @param report 当前完成报告。
 * @returns 失败、未完成与疑似未翻译目标标识。
 * @author zhenghq
 */
function collectRetryableTargetIds(report: DocumentCompletionReport): string[] {
  return [
    ...report.failedTargetIds,
    ...report.pendingTargetIds,
    ...report.suspectUntranslatedTargetIds
  ]
}

/**
 * 沿区块路径定位目标所在区块，支持表格单元格中的嵌套区块。
 * @param blocks 当前区块树。
 * @param path 目标区块路径。
 * @returns 定位到的区块；路径无效时返回 undefined。
 * @author zhenghq
 */
function resolveTargetBlock(
  blocks: DocumentBlock[],
  path: DocumentBlockPath
): DocumentBlock | undefined {
  const [head, ...rest] = path
  if (head === undefined) return undefined
  if (typeof head === 'number') {
    const block = blocks[head]
    if (!block || rest.length === 0) return block
    const [cellRef, ...cellRest] = rest
    if (!cellRef || typeof cellRef === 'number' || block.kind !== 'table') return undefined
    const cell = block.rows[cellRef.row]?.cells[cellRef.cell]
    return cell ? resolveNestedBlock(cell.blocks, cellRest) : undefined
  }
  return undefined
}

/**
 * 从译文模型表格行重组目标译文，并验证单元格标记仍可可靠拆分。
 * @param table 当前译文表格区块。
 * @param target 表格行目标。
 * @returns 重组后的行译文；无法可靠映射时返回 undefined。
 * @author zhenghq
 */
function readTableRowTranslation(
  table: DocumentTableBlock,
  target: TranslationTarget
): string | undefined {
  const row = table.rows[target.tableRowIndex ?? -1]
  const cells = target.cells ?? []
  if (!row || cells.length === 0) return undefined
  const translatedCells: string[] = []
  for (const cellRange of cells) {
    const cell = row.cells[cellRange.cellIndex]
    if (!cell) return undefined
    const translated = readCellTranslation(cell.blocks, cellRange)
    if (translated === undefined) return undefined
    translatedCells.push(translated)
  }
  const translated = composeTableRowTranslation(target, translatedCells)
  return isTableRowTranslationValid(target, translated) ? translated : undefined
}

/**
 * 从单元格子区块中按目标 run 映射读取聚合译文。
 * @param blocks 单元格子区块。
 * @param cellRange 目标单元格映射。
 * @returns 单元格译文；映射缺失时返回 undefined。
 * @author zhenghq
 */
function readCellTranslation(
  blocks: DocumentBlock[],
  cellRange: TranslationTableCellRange
): string | undefined {
  const translatedBlocks: string[] = []
  for (const range of cellRange.blocks) {
    const block = resolveNestedBlock(blocks, range.blockPath)
    if (!block || block.kind !== 'text') return undefined
    const runIds = new Set(range.runs.flatMap((run) => run.runIds))
    const translated = block.runs
      .filter((run) => runIds.has(run.runId))
      .map((run) => run.text)
      .join('')
    if (!translated) return undefined
    translatedBlocks.push(translated)
  }
  return translatedBlocks.join('\n')
}

/**
 * 按数字与表格单元格引用组成的路径读取嵌套区块。
 * @param blocks 当前区块树。
 * @param path 嵌套区块路径。
 * @returns 定位到的区块；路径无效时返回 undefined。
 * @author zhenghq
 */
function resolveNestedBlock(
  blocks: DocumentBlock[],
  path: DocumentBlockPath
): DocumentBlock | undefined {
  const [head, ...rest] = path
  if (head === undefined) return undefined
  if (typeof head === 'number') {
    const block = blocks[head]
    if (!block) return undefined
    if (rest.length === 0) return block
    const [cellRef, ...cellRest] = rest
    if (!cellRef || typeof cellRef === 'number' || block.kind !== 'table') return undefined
    const cell = block.rows[cellRef.row]?.cells[cellRef.cell]
    return cell ? resolveNestedBlock(cell.blocks, cellRest) : undefined
  }
  return undefined
}

/**
 * 把文档分段转换为网页批处理器可识别的稳定分段标识。
 * @param segment 文档分段。
 * @returns 网页翻译分段。
 * @author zhenghq
 */
function toWebSegment(segment: DocumentBatchSegment): WebTranslationSegment {
  return {
    unitId: segment.unitId,
    blockId: segment.blockId,
    unitIds: segment.unitIds,
    segmentId: segment.segmentId,
    index: segment.index,
    segmentTotal: segment.segmentTotal,
    text: segment.text
  }
}

/**
 * 将文档分段构造成合并批次，并把批次结果映射回原分段。
 * @param segments 文档翻译分段。
 * @returns 有序的文档翻译批次。
 * @author zhenghq
 */
function buildDocumentTranslationBatches(segments: DocumentBatchSegment[]): DocumentTranslationBatch[] {
  const webSegments = segments.map(toWebSegment)
  const segmentsById = new Map(segments.map((segment) => [segment.segmentId, segment]))
  const batches = buildWebTranslationBatches(webSegments, {
    maxChars: DOCUMENT_TRANSLATION_MERGED_BATCH_MAX_CHARS,
    maxBlocksPerBatch: DOCUMENT_TRANSLATION_MAX_TARGETS_PER_BATCH
  })
  return batches.map((batch) => {
    const sourceSegments = batch.segments.map((webSegment) => segmentsById.get(webSegment.segmentId))
      .filter((segment): segment is DocumentBatchSegment => segment !== undefined)
    return {
      batch,
      segments: sourceSegments,
      merged: batch.mergeable
    }
  })
}

/**
 * 将单个分段的译文记录到目标状态；全部分段完成后返回最终译文。
 * @param targetStates 全部目标状态。
 * @param segment 已完成分段。
 * @param translated 分段译文。
 * @returns 目标完成时返回恢复空白后的译文，否则返回 undefined。
 * @author zhenghq
 */
function applySegmentTranslation(
  targetStates: Map<string, TargetTranslationState>,
  segment: DocumentBatchSegment,
  translated: string
): SegmentApplicationResult {
  const state = targetStates.get(segment.target.targetId)
  if (!state || state.finished) return { finished: false, failed: false }
  if (state.pieces[segment.pieceIndex] !== undefined) return { finished: false, failed: false }
  const piece = translated.trim()
  if (!piece) {
    state.failed = true
    state.finished = true
    state.failureReason = 'empty-translation'
    return { finished: true, failed: true }
  }
  const pieces = state.pieces.slice()
  pieces[segment.pieceIndex] = piece
  const completed = state.completed + 1
  if (completed < state.pieceTotal) {
    state.pieces = pieces
    state.completed = completed
    return { finished: false, failed: false }
  }
  const translation = restoreTargetWhitespace(state, (pieces as string[]).join(''))
  if (!isTableRowTranslationValid(state.target, translation)) {
    return { finished: false, failed: false, needsTableRowFallback: true }
  }
  state.pieces = pieces
  state.completed = completed
  state.finished = true
  state.translation = translation
  return {
    finished: true,
    failed: false,
    translation
  }
}

/**
 * 将逐单元格回退得到的完整表格行译文直接标记为成功，并返回可写回结果。
 * @param targetStates 全部目标状态。
 * @param segment 触发表格行回退的分段。
 * @param translation 已重组单元格标记的完整表格行译文。
 * @returns 目标完成结果；目标已收尾时返回未完成状态。
 * @author zhenghq
 */
function completeTableRowFallback(
  targetStates: Map<string, TargetTranslationState>,
  segment: DocumentBatchSegment,
  translation: string
): SegmentApplicationResult {
  const state = targetStates.get(segment.target.targetId)
  if (!state || state.finished) return { finished: false, failed: false }
  if (!isTableRowTranslationValid(state.target, translation)) {
    return { finished: false, failed: false, needsTableRowFallback: true }
  }
  state.pieces = state.pieces.map((_piece, index) => index === segment.pieceIndex ? translation : undefined)
  state.completed = state.pieceTotal
  state.finished = true
  state.translation = translation
  return { finished: true, failed: false, translation }
}

/**
 * 用目标译文替换页面区块树中的对应文本或 OCR 区域，并返回新的区块树。
 * @param blocks 原区块树。
 * @param path 目标路径。
 * @param target 翻译目标。
 * @param translatedText 已恢复空白的译文。
 * @returns 更新后的区块树。
 * @author zhenghq
 */
function replaceTargetInBlocks(
  blocks: DocumentBlock[],
  path: DocumentBlockPath,
  target: TranslationTarget,
  translatedText: string
): DocumentBlock[] {
  const [head, ...rest] = path
  if (head === undefined) return blocks
  if (typeof head === 'number') {
    const block = blocks[head]
    if (!block) return blocks
    let updated = block
    if (rest.length === 0) {
      if (target.kind === 'text-block' && block.kind === 'text') {
        const participatingRunIds = new Set(target.runIds ?? (target.runId ? [target.runId] : []))
        let translatedRunAssigned = false
        updated = {
          ...block,
          runs: block.runs.map((run) => {
            if (!participatingRunIds.has(run.runId)) return run
            if (!translatedRunAssigned) {
              translatedRunAssigned = true
              return { ...run, text: translatedText }
            }
            return { ...run, text: '' }
          })
        }
      } else if (target.kind === 'ocr-region' && block.kind === 'image' && block.ocrRegions) {
        updated = {
          ...block,
          ocrRegions: block.ocrRegions.map((region, index) => index === target.regionIndex
            ? { ...region, translatedText }
            : region)
        }
      } else if (target.kind === 'table-row' && block.kind === 'table') {
        const translatedCells = parseTableRowTranslation(target, translatedText)
        if (!translatedCells) return blocks
        updated = replaceTableRowTarget(block, target.tableRowIndex ?? -1, target, translatedCells)
      }
    } else if (block.kind === 'table' && typeof rest[0] === 'object') {
      const cellRef = rest[0]
      const row = block.rows[cellRef.row]
      const cell = row?.cells[cellRef.cell]
      if (row && cell) {
        const updatedChildBlocks = replaceTargetInBlocks(
          cell.blocks,
          rest.slice(1),
          target,
          translatedText
        )
        const updatedTable: DocumentTableBlock = {
          ...block,
          rows: block.rows.map((candidateRow, rowIndex) => rowIndex === cellRef.row
            ? {
                ...candidateRow,
                cells: candidateRow.cells.map((candidateCell, cellIndex) => cellIndex === cellRef.cell
                  ? { ...candidateCell, blocks: updatedChildBlocks }
                  : candidateCell)
              }
            : candidateRow)
        }
        updated = updatedTable
      }
    }
    if (updated === block) return blocks
    return blocks.map((candidate, index) => index === head ? updated : candidate)
  }
  return blocks
}

/**
 * 将表格行译文按单元格和文本块映射写回，并保留未参与翻译的子区块。
 * @param table 原表格区块。
 * @param rowIndex 目标行索引。
 * @param target 表格行目标。
 * @param translatedCells 已拆分并与单元格顺序一致的译文。
 * @returns 更新后的表格区块；无法定位行时返回原表格。
 * @author zhenghq
 */
function replaceTableRowTarget(
  table: DocumentTableBlock,
  rowIndex: number,
  target: TranslationTarget,
  translatedCells: string[]
): DocumentTableBlock {
  const row = table.rows[rowIndex]
  if (!row) return table
  const cells = target.cells ?? []
  const translatedByCell = new Map(cells.map((cell, index) => [cell.cellIndex, translatedCells[index] ?? '']))
  return {
    ...table,
    rows: table.rows.map((candidateRow, index) => {
      if (index !== rowIndex) return candidateRow
      return {
        ...candidateRow,
        cells: candidateRow.cells.map((cell, cellIndex) => {
          const translated = translatedByCell.get(cellIndex)
          const cellRange = cells.find((candidate) => candidate.cellIndex === cellIndex)
          if (translated === undefined || !cellRange) return cell
          return { ...cell, blocks: replaceCellBlocks(cell.blocks, cellRange.blocks, translated) }
        })
      }
    })
  }
}

/**
 * 将单个单元格译文写回其首个文本 run，并清空同一单元格内其他参与 run。
 * @param blocks 单元格子区块。
 * @param ranges 参与翻译的文本块路径。
 * @param translated 单元格译文。
 * @returns 更新后的子区块。
 * @author zhenghq
 */
function replaceCellBlocks(
  blocks: DocumentBlock[],
  ranges: TranslationTableCellRange['blocks'],
  translated: string
): DocumentBlock[] {
  const rangeByPath = new Map(ranges.map((range) => [range.blockPath.join('.'), range]))
  let translatedAssigned = false
  /**
   * 递归写回单元格内文本，同时保持图片、公式和嵌套表格的原有位置。
   * @param candidates 当前子区块。
   * @param path 当前路径。
   * @returns 更新后的子区块。
   * @author zhenghq
   */
  const visit = (candidates: DocumentBlock[], path: DocumentBlockPath): DocumentBlock[] =>
    candidates.map((block, blockIndex) => {
      const blockPath = [...path, blockIndex]
      if (block.kind === 'text') {
        const range = rangeByPath.get(blockPath.join('.'))
        if (!range) return block
        const runIds = new Set(range.runs.flatMap((run) => run.runIds))
        return {
          ...block,
          runs: block.runs.map((run) => {
            if (!runIds.has(run.runId)) return run
            if (!translatedAssigned) {
              translatedAssigned = true
              return { ...run, text: translated }
            }
            return { ...run, text: '' }
          })
        }
      }
      if (block.kind === 'table') {
        return {
          ...block,
          rows: block.rows.map((row, rowIndex) => ({
            ...row,
            cells: row.cells.map((cell, cellIndex) => ({
              ...cell,
              blocks: visit(cell.blocks, [...blockPath, { row: rowIndex, cell: cellIndex }])
            }))
          }))
        }
      }
      return block
    })
  return visit(blocks, [])
}

/**
 * 将 OCR 引擎返回的图片像素边界归一化为图片相对坐标。
 * @param box 引擎文本行边界。
 * @param block 图片区块；缺少像素尺寸时以其版面边界作为基准。
 * @param asset 图片资源；存在真实像素尺寸时优先使用。
 * @returns 相对图片左上角且取值在 0 到 1 之间的边界。
 * @author zhenghq
 */
function normalizeOcrBoundingBox(
  box: DocumentBoundingBox | undefined,
  block: DocumentImageBlock,
  asset?: DocumentModel['assets'][number]
): DocumentBoundingBox {
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
    return { x: 0, y: 0, width: 1, height: 1 }
  }
  const sourceWidth = asset?.width && asset.width > 0 ? asset.width : block.bbox?.width
  const sourceHeight = asset?.height && asset.height > 0 ? asset.height : block.bbox?.height
  if (!sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: 1, height: 1 }
  }
  const normalize = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
  const left = normalize(Math.max(0, Math.min(1, box.x / sourceWidth)))
  const top = normalize(Math.max(0, Math.min(1, box.y / sourceHeight)))
  const right = normalize(Math.max(left, Math.min(1, (box.x + box.width) / sourceWidth)))
  const bottom = normalize(Math.max(top, Math.min(1, (box.y + box.height) / sourceHeight)))
  if (right <= left || bottom <= top) return { x: 0, y: 0, width: 1, height: 1 }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 根据 OCR 文本行在图片中的位置推断对齐方式。
 * @param bbox 归一化后的 OCR 边界。
 * @returns 推断出的对齐方式；普通左对齐文本返回 undefined。
 * @author zhenghq
 */
function inferOcrTextAlignment(bbox: DocumentBoundingBox): DocumentTextAlign | undefined {
  const leftGap = bbox.x
  const rightGap = Math.max(0, 1 - bbox.x - bbox.width)
  // 归一化坐标存在浮点误差，边界值需要按同一容差比较，避免 5% 右边距被判成左对齐。
  const alignmentTolerance = 0.000001
  if (bbox.width >= 0.82) return undefined
  if (leftGap >= 0.08 && rightGap >= 0.08 &&
    Math.abs(leftGap - rightGap) <= 0.04 + alignmentTolerance) return 'center'
  if (rightGap <= 0.05 + alignmentTolerance && leftGap >= 0.12) return 'right'
  return undefined
}

/**
 * 创建 OCR 区域；区域坐标使用图片相对坐标，便于不同显示尺寸下稳定覆盖。
 * @param block 图片区块。
 * @param index 区域序号。
 * @param text OCR 文本。
 * @param confidence 可选置信度。
 * @param bbox 可选图片像素边界。
 * @param asset 可选图片资源，用于读取真实像素尺寸。
 * @returns OCR 区域。
 * @author zhenghq
 */
function createOcrRegion(
  block: DocumentImageBlock,
  index: number,
  text: string,
  confidence?: number,
  bbox?: DocumentBoundingBox,
  asset?: DocumentModel['assets'][number]
): DocumentOcrRegion {
  const normalizedBbox = normalizeOcrBoundingBox(bbox, block, asset)
  const textAlign = inferOcrTextAlignment(normalizedBbox)
  return {
    regionId: `${block.blockId}-ocr-${index}`,
    bbox: normalizedBbox,
    text,
    // OCR 原文识别框高度差异较大，译文统一字号可避免标题、表格和短文本忽大忽小。
    style: { fontSize: DOCUMENT_OCR_UNIFORM_FONT_SIZE },
    ...(textAlign ? { textAlign } : {}),
    status: 'recognized',
    ...(confidence === undefined ? {} : { confidence })
  }
}

/**
 * 将 OCR 结果转换为图片区块的识别区域；无文字时保留可展示的跳过状态。
 * @param block 原始图片区块。
 * @param result OCR 识别结果。
 * @param asset 可选图片资源，用于把 OCR 像素边界归一化。
 * @returns 带 OCR 区域的图片区块。
 * @author zhenghq
 */
function imageBlockWithOcrResult(
  block: DocumentImageBlock,
  result: OcrRecognizeResult,
  asset?: DocumentModel['assets'][number]
): DocumentImageBlock {
  const text = result.text.trim()
  const textLines = result.lines
    .map((line) => ({ ...line, text: line.text.trim() }))
    .filter((line) => line.text.length > 0)
  if (!text && textLines.length === 0) {
    return { ...block, ocrRegions: [{
      regionId: `${block.blockId}-ocr-0`,
      bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
      text: '',
      status: 'skipped',
      reason: 'no-text'
    }] }
  }
  if (textLines.length > 0) {
    return {
      ...block,
      ocrRegions: textLines.map((line, index) =>
        createOcrRegion(block, index, line.text, line.confidence, line.box, asset))
    }
  }
  const confidence = result.lines[0]?.confidence
  return { ...block, ocrRegions: [createOcrRegion(block, 0, text, confidence, undefined, asset)] }
}

/**
 * 构造装饰性页眉小图布局键；仅使用归一化位置和尺寸，不依赖每页重新编码的图片哈希。
 * @param block 待判断的图片区块。
 * @param page 图片所属页面。
 * @returns 可跨页比较的布局键；不符合页眉小图条件时返回 null。
 * @author zhenghq
 */
function decorativeHeaderLayoutKey(
  block: DocumentImageBlock,
  page: DocumentModel['pages'][number]
): string | null {
  const bbox = block.bbox
  if (!bbox || page.width <= 0 || page.height <= 0) return null
  const widthRatio = bbox.width / page.width
  const heightRatio = bbox.height / page.height
  const topRatio = bbox.y / page.height
  if (widthRatio <= 0 || heightRatio <= 0) return null
  if (widthRatio > DOCUMENT_DECORATIVE_IMAGE_MAX_PAGE_RATIO ||
    heightRatio > DOCUMENT_DECORATIVE_IMAGE_MAX_PAGE_RATIO) return null
  if (topRatio < DOCUMENT_DECORATIVE_IMAGE_TOP_MIN_RATIO ||
    topRatio > DOCUMENT_DECORATIVE_IMAGE_TOP_MAX_RATIO) return null
  // 按 0.5% 页面尺寸量化，容忍不同页面的轻微像素取整差异。
  const quantize = (value: number): number => Math.round(value * 200)
  return [
    quantize(bbox.x / page.width),
    quantize(bbox.y / page.height),
    quantize(bbox.width / page.width),
    quantize(bbox.height / page.height)
  ].join(':')
}

/**
 * 收集在多页重复出现的页眉小图布局，用于跳过无正文价值的装饰图标 OCR。
 * @param pages 文档页面。
 * @returns 至少重复出现在配置页数上的布局键集合。
 * @author zhenghq
 */
function collectDecorativeHeaderLayoutKeys(
  pages: DocumentModel['pages']
): Set<string> {
  const pageIndexesByLayout = new Map<string, Set<number>>()
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'image') continue
      const key = decorativeHeaderLayoutKey(block, page)
      if (!key) continue
      const pageIndexes = pageIndexesByLayout.get(key) ?? new Set<number>()
      pageIndexes.add(page.index)
      pageIndexesByLayout.set(key, pageIndexes)
    }
  }
  return new Set([...pageIndexesByLayout]
    .filter(([, pageIndexes]) => pageIndexes.size >= DOCUMENT_DECORATIVE_IMAGE_MIN_REPEAT_PAGES)
    .map(([key]) => key))
}

/**
 * 将图片标记为无需 OCR 的重复页眉装饰图。
 * @param block 原始图片区块。
 * @returns 带 skipped OCR 区域的图片区块。
 * @author zhenghq
 */
function skipDecorativeImageOcr(block: DocumentImageBlock): DocumentImageBlock {
  return {
    ...block,
    ocrRegions: [{
      regionId: `${block.blockId}-ocr-0`,
      bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
      text: '',
      status: 'skipped',
      reason: 'decorative-image'
    }]
  }
}

/**
 * 递归处理区块中的图片 OCR；返回新的区块，不修改源模型。
 * @param block 原始区块。
 * @param assets 文档资源。
 * @param deps 流水线依赖。
 * @param signal 取消信号。
 * @param onFailure 单块失败回调。
 * @returns 处理后的区块。
 * @author zhenghq
 */
async function recognizeBlock(
  block: DocumentBlock,
  assets: DocumentModel['assets'],
  deps: DocumentPipelineDeps,
  signal: AbortSignal,
  onFailure: () => void,
  page?: DocumentModel['pages'][number],
  decorativeLayoutKeys?: ReadonlySet<string>,
  ocrResultCache?: Map<string, Promise<OcrRecognizeResult | null>>
): Promise<DocumentBlock> {
  if (block.kind === 'image') {
    if (block.ocrRegions && block.ocrRegions.length > 0) return block
    if (page && decorativeLayoutKeys) {
      const layoutKey = decorativeHeaderLayoutKey(block, page)
      if (layoutKey && decorativeLayoutKeys.has(layoutKey)) return skipDecorativeImageOcr(block)
    }
    const asset = assets.find((candidate) => candidate.assetId === block.assetId)
    if (!asset) {
      onFailure()
      return { ...block, ocrRegions: [{
        regionId: `${block.blockId}-ocr-0`,
        bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
        text: '',
        status: 'failed',
        reason: 'asset-missing'
      }] }
    }
    let bytes: Uint8Array | null = null
    const cacheKey = asset.sha256
    let recognizePromise = ocrResultCache?.get(cacheKey)
    if (!recognizePromise) {
      try {
        bytes = await deps.loadAssetBytes(asset)
      } catch {
        bytes = null
      }
      if (bytes && ocrResultCache) {
        recognizePromise = deps.recognizeImage(bytes, signal).catch((error: unknown) => {
          if (isAbortError(error, signal)) throw error
          return null
        })
        ocrResultCache.set(cacheKey, recognizePromise)
      }
    }
    if (!bytes) {
      if (recognizePromise) {
        const cachedResult = await recognizePromise
        if (!cachedResult) {
          onFailure()
          return { ...block, ocrRegions: [{
            regionId: `${block.blockId}-ocr-0`,
            bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
            text: '',
            status: 'failed',
            reason: 'ocr-failed'
          }] }
        }
        return imageBlockWithOcrResult(block, cachedResult, asset)
      }
      onFailure()
      return { ...block, ocrRegions: [{
        regionId: `${block.blockId}-ocr-0`,
        bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
        text: '',
        status: 'failed',
        reason: 'asset-unavailable'
      }] }
    }
    try {
      const result = recognizePromise
        ? await recognizePromise
        : await deps.recognizeImage(bytes, signal)
      if (!result) {
        onFailure()
        return { ...block, ocrRegions: [{
          regionId: `${block.blockId}-ocr-0`,
          bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
          text: '',
          status: 'failed',
          reason: 'ocr-failed'
        }] }
      }
      return imageBlockWithOcrResult(block, result, asset)
    } catch (error) {
      if (isAbortError(error, signal)) throw error
      onFailure()
      return { ...block, ocrRegions: [{
        regionId: `${block.blockId}-ocr-0`,
        bbox: block.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
        text: '',
        status: 'failed',
        reason: 'ocr-failed'
      }] }
    }
  }
  if (block.kind === 'table') {
    const rows = []
    for (const row of block.rows) {
      const cells = []
      for (const cell of row.cells) {
        const blocks: DocumentBlock[] = []
        for (const child of cell.blocks) {
          blocks.push(await recognizeBlock(
            child,
            assets,
            deps,
            signal,
            onFailure,
            page,
            decorativeLayoutKeys,
            ocrResultCache
          ))
        }
        cells.push({ ...cell, blocks })
      }
      rows.push({ ...row, cells })
    }
    return { ...block, rows }
  }
  return block
}

/**
 * 统计流水线解析阶段已知的文本翻译单元；OCR 单元在识别完成后另行追加。
 * @param model 文档模型。
 * @returns 文本 run 与表格文本 run 的总数。
 * @author zhenghq
 */
function countPipelineUnits(model: DocumentModel): { textRuns: number } {
  return {
    textRuns: collectTranslationTargets(model).filter((target) =>
      target.kind === 'text-block' || target.kind === 'table-row').length
  }
}

/**
 * 递归收集图片区块中的 OCR 失败或空结果告警。
 * @param block 已完成 OCR 的区块。
 * @param pageId 区块所属页面标识。
 * @param warnings 告警收集数组。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectOcrWarnings(
  block: DocumentBlock,
  pageId: string,
  warnings: DocumentWarning[]
): void {
  if (block.kind === 'image') {
    for (const region of block.ocrRegions ?? []) {
      if (region.status === 'failed') {
        warnings.push({
          code: 'ocr-failed',
          severity: 'error',
          message: 'Text recognition failed for an image on this page.',
          pageId,
          blockId: block.blockId
        })
        return
      }
      if (region.status === 'skipped' && region.reason === 'no-text') {
        warnings.push({
          code: 'ocr-no-text',
          severity: 'info',
          message: 'No text was recognized in an image on this page.',
          pageId,
          blockId: block.blockId
        })
        return
      }
    }
    return
  }
  if (block.kind === 'table') {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) collectOcrWarnings(child, pageId, warnings)
      }
    }
  }
}

/**
 * 执行完整的文档解析、OCR、翻译与版面合成流水线。
 * @param input 解析输入。
 * @param initialState 初始任务状态。
 * @param signal 取消信号。
 * @param deps 可注入依赖。
 * @returns 源文档、译文文档和最终状态。
 * @author zhenghq
 */
export async function runDocumentTranslationPipeline(
  input: DocumentParseInput,
  initialState: DocumentTaskState,
  signal: AbortSignal,
  deps: DocumentPipelineDeps,
  languagePreference: DocumentLanguagePreference = {
    sourcePreference: 'auto',
    targetPreference: 'auto'
  }
): Promise<DocumentPipelineResult> {
  let state = initialState
  emitProgress(state, deps)

  let source: DocumentModel
  try {
    state = moveDocumentTaskToPhase(state, 'parse')
    emitProgress(state, deps)
    source = await deps.parse(input)
    if (signal.aborted) {
      const emptySource = createDocumentModel(input)
      return createCancelledResult(
        emptySource,
        emptySource,
        state,
        deps,
        resolveDocumentLanguagePair(emptySource, languagePreference)
      )
    }
    state = completeDocumentTaskPhase(state)
    state = updateDocumentTaskProgress(state, { completed: source.pages.length, total: source.pages.length })
    emitProgress(state, deps)
  } catch (error) {
    if (isAbortError(error, signal)) {
      const emptySource = createDocumentModel(input)
      return createCancelledResult(
        emptySource,
        emptySource,
        state,
        deps,
        resolveDocumentLanguagePair(emptySource, languagePreference)
      )
    }
    const failed = { ...state, status: 'failed' as const, errorCode: 'parse-failed' }
    emitProgress(failed, deps)
    throw Object.assign(new Error('Document parse failed'), { task: failed })
  }

  const counts = countPipelineUnits(source)
  let stats = { completed: 0, total: counts.textRuns, failed: 0 }
  let ocrState = moveDocumentTaskToPhase(state, 'ocr')
  emitProgress(ocrState, deps)
  const ocrBlocksByPage: DocumentBlock[][] = []
  const decorativeLayoutKeys = source.source.format === 'pdf'
    ? collectDecorativeHeaderLayoutKeys(source.pages)
    : new Set<string>()
  const ocrResultCache = new Map<string, Promise<OcrRecognizeResult | null>>()
  try {
    for (let pageIndex = 0; pageIndex < source.pages.length; pageIndex += 1) {
      const page = source.pages[pageIndex]!
      const blocks: DocumentBlock[] = []
      ocrBlocksByPage[pageIndex] = blocks
      for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex += 1) {
        const block = page.blocks[blockIndex]!
        blocks.push(await recognizeBlock(block, source.assets, deps, signal, () => {
          stats.failed += 1
        }, page, decorativeLayoutKeys, ocrResultCache))
        ocrBlocksByPage[pageIndex] = [...blocks, ...page.blocks.slice(blockIndex + 1)]
        if (signal.aborted) {
          const partialSource: DocumentModel = {
            ...source,
            pages: source.pages.map((sourcePage, index) => ({
              ...sourcePage,
              blocks: ocrBlocksByPage[index] ?? sourcePage.blocks
            }))
          }
          return createCancelledResult(
            partialSource,
            partialSource,
            ocrState,
            deps,
            resolveDocumentLanguagePair(partialSource, languagePreference)
          )
        }
      }
      ocrBlocksByPage[pageIndex] = blocks
      ocrState = updateDocumentTaskProgress(ocrState, {
        completed: pageIndex + 1,
        total: source.pages.length
      })
      emitProgress(ocrState, deps)
    }
    ocrState = completeDocumentTaskPhase(ocrState)
    emitProgress(ocrState, deps)
  } catch (error) {
    if (isAbortError(error, signal)) {
      const partialSource: DocumentModel = {
        ...source,
        pages: source.pages.map((page, index) => ({
          ...page,
          blocks: ocrBlocksByPage[index] ?? page.blocks
        }))
      }
      return createCancelledResult(
        partialSource,
        partialSource,
        ocrState,
        deps,
        resolveDocumentLanguagePair(partialSource, languagePreference)
      )
    }
    const failed = { ...ocrState, status: 'failed' as const, errorCode: 'ocr-failed' }
    emitProgress(failed, deps)
    throw Object.assign(new Error('Document OCR failed'), { task: failed })
  }

  const ocrWarnings: DocumentWarning[] = []
  const ocrPages: DocumentModel['pages'] = source.pages.map((page, index) => {
    const blocks = ocrBlocksByPage[index] ?? page.blocks
    for (const block of blocks) collectOcrWarnings(block, page.pageId, ocrWarnings)
    return { ...page, blocks }
  })
  const ocrSource: DocumentModel = {
    ...source,
    pages: ocrPages,
    warnings: [
      ...source.warnings.filter((warning) => warning.code !== 'ocr-required'),
      ...ocrWarnings
    ]
  }
  // 解析和 OCR 全部完成后只解析一次方向，后续所有请求共享同一个冻结语言对。
  const languageResolution = resolveDocumentLanguagePair(ocrSource, languagePreference)
  const languagePair = languageResolution.languagePair
  const ocrFailedCount = stats.failed
  const targets = collectTranslationTargets(ocrSource)
  const totalTranslationUnits = targets.length
  stats = { completed: 0, total: totalTranslationUnits, failed: 0 }
  const failedTargetIds = new Set<string>()
  let translateState = moveDocumentTaskToPhase(ocrState, 'translate')
  emitProgress(translateState, deps)
  const translatedPages: DocumentModel['pages'] = ocrSource.pages.map((page) => ({
    ...page,
    blocks: [...page.blocks]
  }))
  /**
   * 发布当前完整译文快照，未处理目标继续保留原文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishTranslation = (): void => {
    if (signal.aborted) return
    deps.publishTranslation?.({
      ...ocrSource,
      pages: translatedPages.map((translatedPage) => ({
        ...translatedPage,
        blocks: [...translatedPage.blocks]
      }))
    })
  }
  const translationPublisher = createDocumentTranslationPublisher(
    publishTranslation,
    () => signal.aborted
  )

  // 翻译阶段一开始先发布完整原文占位，避免首个慢请求期间译文栏保持空白。
  translationPublisher.publishInitial()

  /**
   * 将完成目标写回其所属页面，并请求发布最新快照。
   * @param target 已完成翻译的目标。
   * @param translatedText 已完成译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const commitTarget = (target: TranslationTarget, translatedText: string): void => {
    const page = translatedPages[target.pageIndex]
    if (!page) return
    translatedPages[target.pageIndex] = {
      ...page,
      blocks: replaceTargetInBlocks(page.blocks, target.path, target, translatedText)
    }
    translationPublisher.request()
  }

  /**
   * 更新并发布翻译阶段进度；并发任务完成时只做一次状态提交。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishProgress = (): void => {
    if (signal.aborted) return
    translateState = updateDocumentTaskProgress(translateState, {
      completed: stats.completed,
      total: stats.total
    })
    emitProgress(translateState, deps)
  }

  /**
   * 预览合并批次中已完整接收的分段，最终校验前不推进统计。
   * @param item 当前翻译批次。
   * @param translation 当前累计响应。
   * @returns 无返回值。
   * @author zhenghq
   */
  const previewMergedTranslation = (
    item: DocumentTranslationBatch,
    translation: string
  ): void => {
    if (signal.aborted) return
    for (const streamed of readStreamedMergedSegments(translation, item.segments.length)) {
      const segment = item.segments[streamed.index]
      if (!segment) continue
      const state = targetStates.get(segment.target.targetId)
      if (!state || state.finished) continue
      // 多分段目标只在全部分段完成后拼接，流式阶段避免展示不完整的拼接结果。
      if (segment.pieceTotal !== 1) continue
      commitTarget(segment.target, restoreTargetWhitespace(state, streamed.translation))
    }
  }

  const targetStates = new Map<string, TargetTranslationState>(targets.map((target) => {
    const pieceTotal = splitText(target.text, DOCUMENT_TRANSLATION_MERGED_BATCH_MAX_CHARS).length
    return [target.targetId, {
      target,
      pieces: Array.from({ length: pieceTotal }, () => undefined),
      completed: 0,
      pieceTotal,
      failed: false,
      finished: false
    }]
  }))
  const batches = buildDocumentTranslationBatches(createDocumentBatchSegments(targets))

  /**
   * 应用单个分段译文；目标完成或失败时同步统计与写回。
   * @param segment 已完成分段。
   * @param translated 分段译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyTranslation = (segment: DocumentBatchSegment, translated: string): void => {
    const applied = applySegmentTranslation(targetStates, segment, translated)
    if (!applied.finished) return
    stats.completed += 1
    if (applied.failed) stats.failed += 1
    if (applied.translation !== undefined) commitTarget(segment.target, applied.translation)
    publishProgress()
  }

  /**
   * 应用一个完整分段译文；表格行结构异常时逐单元格重新翻译。
   * @param segment 已完成分段。
   * @param translated 分段译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyOrFallbackTranslation = async (
    segment: DocumentBatchSegment,
    translated: string
  ): Promise<void> => {
    const applied = applySegmentTranslation(targetStates, segment, translated)
    if (applied.needsTableRowFallback) {
      try {
        const fallback = await translateTableRowCells(segment.target, signal, deps, languagePair)
        if (!fallback) {
          failTarget(segment)
          return
        }
        const completedFallback = completeTableRowFallback(targetStates, segment, fallback)
        if (!completedFallback.finished) {
          if (completedFallback.needsTableRowFallback) failTarget(segment)
          return
        }
        stats.completed += 1
        if (completedFallback.translation !== undefined) {
          commitTarget(segment.target, completedFallback.translation)
        }
        publishProgress()
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        failTarget(segment)
      }
      return
    }
    if (!applied.finished) return
    stats.completed += 1
    if (applied.failed) stats.failed += 1
    if (applied.translation !== undefined) commitTarget(segment.target, applied.translation)
    publishProgress()
  }

  /**
   * 标记目标失败并保留原文；目标已收尾时不重复统计。
   * @param segment 失败分段。
   * @returns 无返回值。
   * @author zhenghq
   */
  const failTarget = (segment: DocumentBatchSegment): void => {
    const state = targetStates.get(segment.target.targetId)
    if (!state || state.finished) return
    state.failed = true
    state.finished = true
    state.failureReason = 'translation-failed'
    stats.completed += 1
    stats.failed += 1
    failedTargetIds.add(segment.target.targetId)
    commitTarget(segment.target, segment.target.text)
    publishProgress()
  }

  /**
   * 合并批次失败或无法拆回时逐段翻译；单个分段失败只影响所属目标。
   * @param item 需要回退的批次。
   * @returns 无返回值。
   * @author zhenghq
   */
  const fallbackBatch = async (item: DocumentTranslationBatch): Promise<void> => {
    for (const segment of item.segments) {
      throwIfAborted(signal)
      if (segment.target.kind === 'table-row' && (segment.target.cells?.length ?? 0) > 1) {
        try {
          const translated = await translateTableRowCells(segment.target, signal, deps, languagePair)
          if (!translated) {
            failTarget(segment)
            continue
          }
          const completedFallback = completeTableRowFallback(targetStates, segment, translated)
          if (!completedFallback.finished) {
            if (completedFallback.needsTableRowFallback) failTarget(segment)
            continue
          }
          stats.completed += 1
          if (completedFallback.translation !== undefined) {
            commitTarget(segment.target, completedFallback.translation)
          }
          publishProgress()
        } catch (error) {
          if (isAbortError(error, signal)) throw error
          failTarget(segment)
        }
        continue
      }
      try {
        const translated = await deps.translate(segment.text, signal, languagePair)
        throwIfAborted(signal)
        applyTranslation(segment, translated)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        failTarget(segment)
      }
    }
  }

  /**
   * 处理一个翻译批次；合并结果无效或请求失败时自动逐段回退。
   * @param item 当前翻译批次。
   * @returns 批次处理完成的 Promise。
   * @author zhenghq
   */
  const processBatch = async (item: DocumentTranslationBatch): Promise<void> => {
    throwIfAborted(signal)
    if (!item.merged) {
      const segment = item.segments[0]
      if (!segment) return
      let streamed = ''
      try {
        const translated = await deps.translate(segment.text, signal, languagePair, segment.pieceTotal === 1
          ? (delta) => {
              if (signal.aborted) return
              streamed += delta
              const state = targetStates.get(segment.target.targetId)
              if (!state || state.finished || !streamed.trim()) return
              commitTarget(segment.target, restoreTargetWhitespace(state, streamed))
            }
          : undefined)
        throwIfAborted(signal)
        await applyOrFallbackTranslation(segment, translated)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        failTarget(segment)
      }
      return
    }
    try {
      let streamed = ''
      const translated = await deps.translate(item.batch.text, signal, languagePair, (delta) => {
        if (signal.aborted) return
        streamed += delta
        previewMergedTranslation(item, streamed)
      })
      throwIfAborted(signal)
      const parts = parseMergedTranslation(item.batch, translated)
      if (!parts || parts.length !== item.segments.length || parts.some((part) => !part.trim())) {
        await fallbackBatch(item)
        return
      }
      for (let index = 0; index < item.segments.length; index += 1) {
        await applyOrFallbackTranslation(item.segments[index]!, parts[index]!)
      }
    } catch (error) {
      if (isAbortError(error, signal)) throw error
      await fallbackBatch(item)
    }
  }
  try {
    const concurrency = normalizeTranslationConcurrency(deps.concurrency)
    let nextBatchIndex = 0
    /**
     * 从共享队列领取批次并执行，保证活跃请求数不超过配置上限。
     * @returns 工作线程完成的 Promise。
     * @author zhenghq
     */
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = nextBatchIndex
        nextBatchIndex += 1
        if (index >= batches.length) return
        await processBatch(batches[index]!)
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, batches.length) },
      () => worker()
    ))
    throwIfAborted(signal)
    translationPublisher.flush()
    translateState = completeDocumentTaskPhase(translateState)
    publishProgress()
  } catch (error) {
    if (isAbortError(error, signal)) {
      translationPublisher.cancel()
      return createCancelledResult(
        ocrSource,
        // 取消后 onDelta 已因 signal.aborted 被丢弃；这里只快照取消前已接受的译文，
        // 不能从原始页面重建，否则会抹掉取消前已成功提交的目标。
        { ...ocrSource, pages: translatedPages },
        translateState,
        deps,
        languageResolution,
        undefined,
        targetStates
      )
    }
    translationPublisher.cancel()
    const failed = { ...translateState, status: 'failed' as const, errorCode: 'translation-failed' }
    emitProgress(failed, deps)
    throw Object.assign(new Error('Document translation failed'), { task: failed })
  }
  translationPublisher.flush()

  const completionReport = buildDocumentCompletionReport(
    ocrSource,
    {
      ...ocrSource,
      pages: translatedPages,
      warnings: ocrSource.warnings
    },
    translateState,
    targetStates,
    deps,
    languageResolution
  )
  const hasTranslationFailures = completionReport.failed + completionReport.pending +
    completionReport.suspectUntranslated > 0
  const translation: DocumentModel = {
    ...ocrSource,
    pages: translatedPages,
    warnings: [
      ...ocrSource.warnings,
      ...(hasTranslationFailures ? [{
        code: 'translation-partial',
        severity: 'warning' as const,
        message: 'Some content could not be translated and was kept in the source language.'
      }] : [])
    ]
  }
  return finalizeTranslationResult(
    ocrSource,
    translation,
    translateState,
    [...failedTargetIds],
    ocrFailedCount,
    deps,
    languageResolution,
    targetStates
  )
}

/**
 * 重新翻译指定失败目标；不重新解析文档、不执行 OCR，也不请求已成功目标。
 * @param source 已完成解析与 OCR 的源文档。
 * @param translation 当前已包含成功译文的文档。
 * @param failedTargetIds 待重试的稳定目标标识。
 * @param initialState 重试任务的初始状态；调用方应使用新的代际。
 * @param signal 取消信号。
 * @param deps 可注入依赖。
 * @returns 合并重试结果后的译文与最终状态。
 * @author zhenghq
 */
export async function retryFailedDocumentTranslationPipeline(
  source: DocumentModel,
  translation: DocumentModel,
  failedTargetIds: readonly string[],
  initialState: DocumentTaskState,
  signal: AbortSignal,
  deps: DocumentPipelineDeps,
  languageResolution: DocumentLanguageResolution
): Promise<DocumentPipelineResult> {
  const languagePair = languageResolution.languagePair
  const requestedIds = new Set(failedTargetIds)
  const targets = collectTranslationTargets(source).filter((target) => requestedIds.has(target.targetId))
  const translatedPages: DocumentModel['pages'] = translation.pages.map((page) => ({
    ...page,
    blocks: [...page.blocks]
  }))
  let translateState: DocumentTaskState = {
    ...initialState,
    phase: 'translate',
    status: 'translating',
    progress: { completed: 0, total: targets.length },
    cancellationRequested: false,
    failedBlocks: 0,
    warningCount: 0,
    errorCode: undefined,
    phaseCompleted: false
  }
  emitProgress(translateState, deps)

  /**
   * 发布当前完整译文快照，让界面在重试期间继续显示已成功内容。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishTranslation = (): void => {
    if (signal.aborted) return
    deps.publishTranslation?.({
      ...translation,
      pages: translatedPages.map((page) => ({ ...page, blocks: [...page.blocks] }))
    })
  }
  const translationPublisher = createDocumentTranslationPublisher(
    publishTranslation,
    () => signal.aborted
  )
  translationPublisher.publishInitial()

  /**
   * 将成功重试的目标写回页面并请求发布最新快照。
   * @param target 重试成功的目标。
   * @param translatedText 已完成译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const commitTarget = (target: TranslationTarget, translatedText: string): void => {
    const page = translatedPages[target.pageIndex]
    if (!page) return
    translatedPages[target.pageIndex] = {
      ...page,
      blocks: replaceTargetInBlocks(page.blocks, target.path, target, translatedText)
    }
    translationPublisher.request()
  }

  const targetStates = new Map<string, TargetTranslationState>(targets.map((target) => {
    const pieceTotal = splitText(target.text, DOCUMENT_TRANSLATION_MERGED_BATCH_MAX_CHARS).length
    return [target.targetId, {
      target,
      pieces: Array.from({ length: pieceTotal }, () => undefined),
      completed: 0,
      pieceTotal,
      failed: false,
      finished: false
    }]
  }))
  const batches = buildDocumentTranslationBatches(createDocumentBatchSegments(targets))
  const retryFailedIds = new Set<string>()
  let completed = 0

  /**
   * 更新重试阶段进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishProgress = (): void => {
    if (signal.aborted) return
    translateState = updateDocumentTaskProgress(translateState, {
      completed,
      total: targets.length
    })
    emitProgress(translateState, deps)
  }

  /**
   * 预览重试合并批次中的流式分段；最终校验完成前不推进重试统计。
   * @param item 当前重试批次。
   * @param translation 当前累计响应。
   * @returns 无返回值。
   * @author zhenghq
   */
  const previewRetriedMergedTranslation = (
    item: DocumentTranslationBatch,
    translation: string
  ): void => {
    if (signal.aborted) return
    for (const streamed of readStreamedMergedSegments(translation, item.segments.length)) {
      const segment = item.segments[streamed.index]
      if (!segment) continue
      const state = targetStates.get(segment.target.targetId)
      if (!state || state.finished) continue
      // 多分段目标只在全部分段完成后拼接，流式阶段避免展示不完整的拼接结果。
      if (segment.pieceTotal !== 1) continue
      commitTarget(segment.target, restoreTargetWhitespace(state, streamed.translation))
    }
  }

  /**
   * 应用成功分段，并在目标全部分段完成后写回。
   * @param segment 已完成分段。
   * @param translated 分段译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyTranslation = (segment: DocumentBatchSegment, translated: string): void => {
    const applied = applySegmentTranslation(targetStates, segment, translated)
    if (!applied.finished) return
    completed += 1
    if (applied.failed) retryFailedIds.add(segment.target.targetId)
    if (applied.translation !== undefined) commitTarget(segment.target, applied.translation)
    publishProgress()
  }

  /**
   * 应用重试分段译文；表格行结构异常时逐单元格重新翻译。
   * @param segment 已完成分段。
   * @param translated 分段译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyOrFallbackTranslation = async (
    segment: DocumentBatchSegment,
    translated: string
  ): Promise<void> => {
    const applied = applySegmentTranslation(targetStates, segment, translated)
    if (applied.needsTableRowFallback) {
      try {
        const fallback = await translateTableRowCells(segment.target, signal, deps, languagePair)
        if (!fallback) {
          failTarget(segment)
          return
        }
        const completedFallback = completeTableRowFallback(targetStates, segment, fallback)
        if (!completedFallback.finished) {
          if (completedFallback.needsTableRowFallback) failTarget(segment)
          return
        }
        completed += 1
        if (completedFallback.translation !== undefined) {
          commitTarget(segment.target, completedFallback.translation)
        }
        publishProgress()
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        failTarget(segment)
      }
      return
    }
    if (!applied.finished) return
    completed += 1
    if (applied.failed) retryFailedIds.add(segment.target.targetId)
    if (applied.translation !== undefined) commitTarget(segment.target, applied.translation)
    publishProgress()
  }

  /**
   * 标记重试目标仍失败，并继续保留原译文或原文。
   * @param segment 失败分段。
   * @returns 无返回值。
   * @author zhenghq
   */
  const failTarget = (segment: DocumentBatchSegment): void => {
    const state = targetStates.get(segment.target.targetId)
    if (!state || state.finished) return
    state.failed = true
    state.finished = true
    state.failureReason = 'translation-failed'
    completed += 1
    retryFailedIds.add(segment.target.targetId)
    publishProgress()
  }

  /**
   * 合并批次失败或无法拆回时逐段重试。
   * @param item 需要回退的批次。
   * @returns 无返回值。
   * @author zhenghq
   */
  const fallbackBatch = async (item: DocumentTranslationBatch): Promise<void> => {
    for (const segment of item.segments) {
      throwIfAborted(signal)
      if (segment.target.kind === 'table-row' && (segment.target.cells?.length ?? 0) > 1) {
        try {
          const translated = await translateTableRowCells(segment.target, signal, deps, languagePair)
          if (!translated) {
            failTarget(segment)
            continue
          }
          const completedFallback = completeTableRowFallback(targetStates, segment, translated)
          if (!completedFallback.finished) {
            if (completedFallback.needsTableRowFallback) failTarget(segment)
            continue
          }
          completed += 1
          if (completedFallback.translation !== undefined) {
            commitTarget(segment.target, completedFallback.translation)
          }
          publishProgress()
        } catch (error) {
          if (isAbortError(error, signal)) throw error
          failTarget(segment)
        }
        continue
      }
      try {
        const translated = await deps.translate(segment.text, signal, languagePair)
        throwIfAborted(signal)
        applyTranslation(segment, translated)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        failTarget(segment)
      }
    }
  }

  /**
   * 执行单个重试批次；合并结果异常时回退为逐段请求。
   * @param item 当前批次。
   * @returns 批次处理完成的 Promise。
   * @author zhenghq
   */
  const processBatch = async (item: DocumentTranslationBatch): Promise<void> => {
    throwIfAborted(signal)
    if (!item.merged) {
      const segment = item.segments[0]
      if (!segment) return
      let streamed = ''
      try {
        const translated = await deps.translate(segment.text, signal, languagePair, segment.pieceTotal === 1
          ? (delta) => {
              if (signal.aborted) return
              streamed += delta
              const state = targetStates.get(segment.target.targetId)
              if (!state || state.finished || !streamed.trim()) return
              commitTarget(segment.target, restoreTargetWhitespace(state, streamed))
            }
          : undefined)
        throwIfAborted(signal)
        await applyOrFallbackTranslation(segment, translated)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        failTarget(segment)
      }
      return
    }
    try {
      let streamed = ''
      const translated = await deps.translate(item.batch.text, signal, languagePair, (delta) => {
        if (signal.aborted) return
        streamed += delta
        previewRetriedMergedTranslation(item, streamed)
      })
      throwIfAborted(signal)
      const parts = parseMergedTranslation(item.batch, translated)
      if (!parts || parts.length !== item.segments.length || parts.some((part) => !part.trim())) {
        await fallbackBatch(item)
        return
      }
      for (let index = 0; index < item.segments.length; index += 1) {
        await applyOrFallbackTranslation(item.segments[index]!, parts[index]!)
      }
    } catch (error) {
      if (isAbortError(error, signal)) throw error
      await fallbackBatch(item)
    }
  }

  try {
    const concurrency = normalizeTranslationConcurrency(deps.concurrency)
    let nextBatchIndex = 0
    /**
     * 从共享队列领取重试批次，保证请求并发受配置限制。
     * @returns 工作线程完成的 Promise。
     * @author zhenghq
     */
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = nextBatchIndex
        nextBatchIndex += 1
        if (index >= batches.length) return
        await processBatch(batches[index]!)
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, batches.length) },
      () => worker()
    ))
    throwIfAborted(signal)
    translationPublisher.flush()
    translateState = completeDocumentTaskPhase(translateState)
    emitProgress(translateState, deps)
  } catch (error) {
    if (isAbortError(error, signal)) {
      translationPublisher.cancel()
      return createCancelledResult(
        source,
        { ...translation, pages: translatedPages },
        translateState,
        deps,
        languageResolution,
        [...retryFailedIds],
        targetStates
      )
    }
    translationPublisher.cancel()
    const failed = { ...translateState, status: 'failed' as const, errorCode: 'translation-failed' }
    emitProgress(failed, deps)
    throw Object.assign(new Error('Document translation retry failed'), { task: failed })
  }
  translationPublisher.flush()

  const completionReport = buildDocumentCompletionReport(
    source,
    {
      ...translation,
      pages: translatedPages,
      warnings: translation.warnings
    },
    translateState,
    targetStates,
    deps,
    languageResolution
  )
  const hasTranslationFailures = completionReport.failed + completionReport.pending +
    completionReport.suspectUntranslated > 0
  const retryFailed = [...retryFailedIds]
  const remainingWarnings = translation.warnings.filter((warning) => warning.code !== 'translation-partial')
  const retriedTranslation: DocumentModel = {
    ...translation,
    pages: translatedPages,
    warnings: hasTranslationFailures
      ? [...remainingWarnings, {
          code: 'translation-partial',
          severity: 'warning' as const,
          message: 'Some content could not be translated and was kept in the source language.'
        }]
      : remainingWarnings
  }
  return finalizeTranslationResult(
    source,
    retriedTranslation,
    translateState,
    completionReport.failedTargetIds,
    0,
    deps,
    languageResolution,
    targetStates
  )
}
