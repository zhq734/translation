import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import {
  DOCUMENT_MAX_FILE_BYTES,
  DOCUMENT_ZIP_TAIL_BYTES,
  getDocumentZipCentralDirectoryRange,
  validateDocumentFile
} from '../shared/documentFormat.ts'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  createDocumentWorkerAssetResultMessage,
  createDocumentWorkerCancelledMessage,
  createDocumentWorkerFailureMessage,
  createDocumentWorkerProgressMessage,
  createDocumentWorkerResultMessage,
  createDocumentWorkerTranslationSnapshotMessage,
  createDocumentWorkerTranslationUpdateMessage,
  parseDocumentWorkerAssetResult,
  parseDocumentWorkerRequest,
  resolveDocumentWorkerErrorCode,
  sanitizeDocumentWorkerError,
  type DocumentWorkerAssetRequestMessage,
  type DocumentWorkerExportPayload,
  type DocumentWorkerRequestMessage,
  type DocumentWorkerResponseMessage
} from '../shared/documentWorkerProtocol.ts'
import {
  calculateDocumentTaskProgress,
  createDocumentTaskState,
  type DocumentTaskState
} from '../shared/documentTask.ts'
import {
  collectRetryableDocumentTargetIds,
  validateDocumentCompletionReport
} from '../shared/documentCompletion.ts'
import type { DocumentCompletionReport } from '../shared/documentCompletion.ts'
import type { DocumentLanguageResolution } from '../shared/documentLanguageDirection.ts'
import {
  buildPartialExportDocument,
  type DocumentPartialExportSummary
} from '../shared/documentPartialExport.ts'
import type { DocumentModel, DocumentWarning } from '../shared/documentTypes.ts'
import type { OcrRecognizeResult } from '../shared/ocrEngine.ts'
import type { DocumentRunRequest } from '../shared/documentWorkspace.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
import {
  retryFailedDocumentTranslationPipeline,
  runDocumentTranslationPipeline,
  type DocumentPipelineResult
} from './documentTranslationPipeline.ts'

/** worker 请求执行器；生产环境由解析、OCR、翻译与导出依赖组合实现。 */
export interface DocumentWorkerExecutor {
  /**
   * 执行一次 worker 请求，并通过 emit 发布进度与终态。
   * @param message 已校验请求。
   * @param signal 当前任务取消信号。
   * @param emit 响应发送函数；宿主会再次校验任务代际。
   * @returns 执行完成 Promise。
   * @author zhenghq
   */
  execute(
    message: DocumentWorkerRequestMessage,
    signal: AbortSignal,
    emit: (response: DocumentWorkerResponseMessage) => void
  ): Promise<void>
  /**
   * 读取当前任务已声明的资源字节。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @param assetId 已声明资源标识。
   * @returns 资源字节与 MIME，或稳定错误分类。
   * @author zhenghq
   */
  readAsset?(
    jobId: string,
    generation: number,
    assetId: string
  ): Promise<{ ok: true; mimeType?: string; bytes: Uint8Array } | { ok: false; code: string }>
}

/** worker 宿主当前任务快照。 */
interface ActiveWorkerRequest {
  /** 任务标识。 */
  jobId: string
  /** 任务代际。 */
  generation: number
  /** 取消控制器。 */
  controller: AbortController
  /** 是否已发送终态。 */
  settled: boolean
  /** 当前任务模型已声明的资源标识。 */
  assetIds: Set<string>
}

/**
 * 文档 worker 宿主，负责请求校验、代际隔离、取消和终态幂等。
 * @author zhenghq
 */
export class DocumentWorkerHost {
  private active: ActiveWorkerRequest | null = null
  private disposed = false

  /**
   * 创建 worker 宿主。
   * @param executor 实际重任务执行器。
   * @param send 向父进程发送响应的函数。
   * @author zhenghq
   */
  constructor(
    private readonly executor: DocumentWorkerExecutor,
    private readonly send: (response: DocumentWorkerResponseMessage) => void
  ) {}

  /**
   * 处理一条未信任消息；非法请求不启动执行器。
   * @param value 父进程传入的消息。
   * @returns 处理完成 Promise。
   * @author zhenghq
   */
  async handle(value: unknown): Promise<void> {
    if (this.disposed) return
    // 资源结果属于父进程对 worker 请求的答复，不得被当作新的执行任务。
    if (parseDocumentWorkerAssetResult(value)) return
    const message = parseDocumentWorkerRequest(value)
    if (!message) {
      const fallback = this.resolveInvalidEnvelope(value)
      this.send(createDocumentWorkerFailureMessage(fallback.jobId, fallback.generation, 'invalid-request'))
      return
    }
    if (message.type === 'cancel') {
      this.cancel(message.jobId, message.generation)
      return
    }
    if (message.type === 'asset-request') {
      await this.readAsset(message)
      return
    }
    await this.run(message)
  }

  /**
   * 释放宿主并取消活动任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active?.controller.abort()
    this.active = null
  }

  /**
   * 从非法消息中提取可用于回送错误的非敏感代际字段。
   * @param value 原始消息。
   * @returns 任务标识与代际；缺失时使用稳定占位值。
   * @author zhenghq
   */
  private resolveInvalidEnvelope(value: unknown): { jobId: string; generation: number } {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const jobId = typeof record.jobId === 'string' && record.jobId.trim()
      ? record.jobId.slice(0, 128)
      : 'invalid-job'
    const generation = Number.isInteger(record.generation) && Number(record.generation) >= 1
      ? Number(record.generation)
      : 1
    return { jobId, generation }
  }

  /**
   * 处理匹配当前任务的取消请求；重复取消不会再次发送终态。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 无返回值。
   * @author zhenghq
   */
  private cancel(jobId: string, generation: number): void {
    const active = this.active
    if (!active || active.jobId !== jobId || active.generation !== generation) return
    if (active.settled) return
    active.settled = true
    active.controller.abort()
    this.send(createDocumentWorkerCancelledMessage(jobId, generation))
  }

  /**
   * 处理当前任务已声明资源的读取请求，拒绝旧代际与未声明资源。
   * @param message 已校验资源请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async readAsset(message: DocumentWorkerAssetRequestMessage): Promise<void> {
    const active = this.active
    const allowed = Boolean(active &&
      active.jobId === message.jobId &&
      active.generation === message.generation &&
      active.assetIds.has(message.assetId) &&
      this.executor.readAsset)
    if (!allowed || !active || !this.executor.readAsset) {
      this.send(createDocumentWorkerAssetResultMessage(
        message.jobId,
        message.generation,
        message.requestId,
        message.assetId,
        { code: 'asset-not-found' }
      ))
      return
    }
    try {
      const result = await this.executor.readAsset(message.jobId, message.generation, message.assetId)
      if (this.disposed || this.active !== active || active.jobId !== message.jobId ||
        active.generation !== message.generation) return
      this.send(result.ok
        ? createDocumentWorkerAssetResultMessage(
            message.jobId,
            message.generation,
            message.requestId,
            message.assetId,
            { bytes: result.bytes, ...(result.mimeType ? { mimeType: result.mimeType } : {}) }
          )
        : createDocumentWorkerAssetResultMessage(
            message.jobId,
            message.generation,
            message.requestId,
            message.assetId,
            { code: result.code === 'asset-unavailable' ? result.code : 'asset-not-found' }
          ))
    } catch {
      if (this.disposed || this.active !== active) return
      this.send(createDocumentWorkerAssetResultMessage(
        message.jobId,
        message.generation,
        message.requestId,
        message.assetId,
        { code: 'asset-unavailable' }
      ))
    }
  }

  /**
   * 启动新请求；新任务会先取消旧任务，旧任务迟到响应被代际校验丢弃。
   * @param message 已校验的非取消请求。
   * @returns 执行完成 Promise。
   * @author zhenghq
   */
  private async run(message: Exclude<DocumentWorkerRequestMessage, { type: 'cancel' | 'asset-request' }>): Promise<void> {
    if (this.active && !this.active.settled) {
      this.active.controller.abort()
    }
    const active: ActiveWorkerRequest = {
      jobId: message.jobId,
      generation: message.generation,
      controller: new AbortController(),
      settled: false,
      assetIds: new Set()
    }
    this.active = active
    const emit = (response: DocumentWorkerResponseMessage): void => {
      if (!this.isCurrent(active, response)) return
      if (active.settled) return
      if (response.type !== 'progress' && response.type !== 'translation-snapshot' &&
        response.type !== 'translation-update') {
        active.settled = true
      }
      this.send(response)
    }
    try {
      const resourceAwareEmit = (response: DocumentWorkerResponseMessage): void => {
        if (response.type === 'result' && response.payload.source) {
          for (const asset of response.payload.source.assets) active.assetIds.add(asset.assetId)
          for (const asset of response.payload.translation?.assets ?? []) active.assetIds.add(asset.assetId)
        }
        emit(response)
      }
      await this.executor.execute(message, active.controller.signal, resourceAwareEmit)
      if (active.settled) return
      active.settled = true
      this.send(createDocumentWorkerFailureMessage(
        active.jobId,
        active.generation,
        'missing-terminal-message'
      ))
    } catch (error) {
      if (active.settled || this.active !== active) return
      active.settled = true
      if (active.controller.signal.aborted || resolveDocumentWorkerErrorCode(error) === 'cancelled') {
        this.send(createDocumentWorkerCancelledMessage(active.jobId, active.generation))
        return
      }
      this.send(createDocumentWorkerFailureMessage(
        active.jobId,
        active.generation,
        resolveDocumentWorkerErrorCode(error)
      ))
      // 保留脱敏函数调用，确保实现层始终经过统一错误信息策略。
      sanitizeDocumentWorkerError(error)
    }
  }

  /**
   * 判断响应是否仍属于当前活动任务。
   * @param active 当前活动请求。
   * @param response 待发送响应。
   * @returns 是否允许发送。
   * @author zhenghq
   */
  private isCurrent(active: ActiveWorkerRequest, response: DocumentWorkerResponseMessage): boolean {
    return this.active === active &&
      response.version === DOCUMENT_WORKER_PROTOCOL_VERSION &&
      response.jobId === active.jobId &&
      response.generation === active.generation
  }
}

/**
 * 创建 Electron utility process 消息桥，把父端口消息交给宿主处理。
 * @param host worker 宿主。
 * @param port 父端口最小接口。
 * @returns 注销函数。
 * @author zhenghq
 */
export function connectDocumentWorkerPort(
  host: DocumentWorkerHost,
  port: {
    on(event: 'message', listener: (event: { data: unknown }) => void): void
    off(event: 'message', listener: (event: { data: unknown }) => void): void
    postMessage(message: DocumentWorkerResponseMessage): void
  }
): () => void {
  const listener = (event: { data: unknown }): void => {
    void host.handle(event.data)
  }
  port.on('message', listener)
  return () => {
    port.off('message', listener)
    host.dispose()
  }
}


/** worker 生产执行器的文件解析、OCR、翻译、字体与 PDF 导出依赖。 */
export interface DocumentWorkerProductionDependencies {
  /**
   * 读取并解析已校验文档；输入中的路径只在本进程内使用。
   * @param input 已校验的解析输入。
   * @param signal 取消信号。
   * @param registerAssetBytes 解析器生成资源字节时的登记回调，供重试与导出复用。
   * @returns 统一文档模型。
   * @author zhenghq
   */
  parse(
    input: DocumentParseInput,
    signal: AbortSignal,
    registerAssetBytes?: (assetId: string, bytes: Uint8Array) => void
  ): Promise<DocumentModel>
  /** 读取文档资源字节。 */
  loadAssetBytes(asset: DocumentModel['assets'][number]): Promise<Uint8Array | null>
  /** 识别图片文字。 */
  recognizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<OcrRecognizeResult>
  /** 使用冻结语言对翻译单段文本。 */
  translate(
    text: string,
    signal: AbortSignal,
    languagePair: DocumentLanguageResolution['languagePair'],
    onDelta: ((delta: string) => void) | undefined,
    context: {
      /** 当前任务标识。 */
      jobId: string
      /** 当前任务代际。 */
      generation: number
    }
  ): Promise<string>
  /** 读取可嵌入 PDF 的字体字节。 */
  loadFontBytes(): Promise<Uint8Array | null>
  /** 将完整或部分导出模型写入 PDF 字节。 */
  exportPdf(model: DocumentModel, dependencies: {
    /** 读取字体字节。 */
    loadFontBytes(): Promise<Uint8Array | null>
    /** 按资源标识读取图片字节。 */
    loadAssetBytes(assetId: string): Promise<Uint8Array | null>
  }, partialExport?: DocumentPartialExportSummary, textLayer?: boolean): Promise<{
    /** PDF 字节。 */
    bytes: Uint8Array
    /** 可降级告警。 */
    warnings: DocumentWarning[]
  }>
  /** 获取当前翻译提供方与模型的稳定指纹。 */
  getModelFingerprint?(): string
  /** 获取页面翻译并发数。 */
  getTranslationConcurrency?(): number
  /**
   * 获取文档 OCR 并发数。
   * @returns 文档 OCR 并发数。
   * @author zhenghq
   */
  getOcrConcurrency?(): number
}

/** worker 内按任务缓存的结果，重试与导出不得重新解析或 OCR。 */
interface CachedWorkerJob {
  /** 任务标识。 */
  jobId: string
  /** 最近一次已接受的代际。 */
  generation: number
  /** 原始运行请求，保留语言偏好。 */
  request: DocumentRunRequest
  /** 解析输入。 */
  input: DocumentParseInput
  /** 解析后的源文档。 */
  source: DocumentModel
  /** 当前译文模型。 */
  translation: DocumentModel
  /** 冻结的语言方向。 */
  languageResolution: DocumentLanguageResolution
  /** 最近一次完成报告。 */
  completionReport: DocumentCompletionReport
  /** 最近一次流水线终态，用于计算与阶段一致的最终百分比。 */
  task: DocumentTaskState
  /** 可重试目标集合。 */
  retryableTargetIds: string[]
  /** 资源字节缓存。 */
  assetBytes: Map<string, Uint8Array>
}

/** 导出授权错误，携带稳定错误分类。 */
class DocumentWorkerExportError extends Error {
  /**
   * 创建导出授权错误。
   * @param code 稳定错误分类。
   * @author zhenghq
   */
  constructor(readonly code: string) {
    super(code)
    this.name = 'DocumentWorkerExportError'
  }
}

/**
 * 将错误映射为 worker 可回送的稳定分类。
 * @param error 捕获的异常。
 * @param fallback 未识别时的分类。
 * @returns 稳定错误分类。
 * @author zhenghq
 */
function resolveProductionErrorCode(error: unknown, fallback: string): string {
  if (error instanceof DocumentWorkerExportError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return resolveDocumentWorkerErrorCode(error) === 'worker-failed'
    ? fallback
    : resolveDocumentWorkerErrorCode(error)
}

/**
 * 读取并校验 worker 请求中的本地文件，生成与主进程一致的安全解析输入。
 * @param request 已通过消息校验的运行请求。
 * @param signal 取消信号。
 * @returns 文档解析输入。
 * @author zhenghq
 */
async function loadWorkerInput(
  request: DocumentRunRequest,
  signal: AbortSignal
): Promise<DocumentParseInput> {
  if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
  const fileStat = await stat(request.path)
  if (!fileStat.isFile() || fileStat.size === 0) throw Object.assign(new Error('invalid-file'), { code: 'invalid-file' })
  if (fileStat.size > DOCUMENT_MAX_FILE_BYTES) throw Object.assign(new Error('too-large'), { code: 'too-large' })
  const bytes = new Uint8Array(await readFile(request.path))
  if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
  if (bytes.byteLength !== fileStat.size) throw Object.assign(new Error('file-changed'), { code: 'file-changed' })
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - DOCUMENT_ZIP_TAIL_BYTES))
  const zipRange = getDocumentZipCentralDirectoryRange(tail, bytes.byteLength)
  const zipDirectory = zipRange ? bytes.subarray(zipRange.start, zipRange.end) : undefined
  const validation = validateDocumentFile({
    fileName: basename(request.path),
    size: bytes.byteLength,
    head: bytes.subarray(0, Math.min(bytes.byteLength, 8192)),
    tail,
    ...(zipDirectory ? { zipDirectory } : {}),
    readable: true
  })
  if (!validation.ok) throw Object.assign(new Error(validation.code), { code: validation.code })
  return {
    path: request.path,
    fileName: basename(request.path),
    format: validation.format,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes
  }
}

/**
 * 创建生产文档 worker 执行器，缓存解析与 OCR 结果并在 worker 内完成翻译和导出。
 * @param dependencies 解析、OCR、翻译、字体与 PDF 导出能力。
 * @returns 可交给 DocumentWorkerHost 的执行器。
 * @author zhenghq
 */
export function createDocumentWorkerExecutor(
  dependencies: DocumentWorkerProductionDependencies
): DocumentWorkerExecutor {
  const jobs = new Map<string, CachedWorkerJob>()
  const modelFingerprint = dependencies.getModelFingerprint?.() ?? 'document-translation-model'

  /**
   * 比较前后两份译文快照并发送发生变化的顶层区块。
   * 流水线原位替换页面区块树，发送完整区块可同时覆盖表格和图片 OCR 区域，
   * 又不会重复传输未变化的页面与资源。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @param previous 上一次已发送的译文快照。
   * @param current 当前最新译文快照。
   * @param completed 当前阶段已完成目标数。
   * @param total 当前阶段目标总数。
   * @param emit 响应发送函数。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishTranslationDelta = (
    jobId: string,
    generation: number,
    previous: DocumentModel,
    current: DocumentModel,
    completed: number,
    total: number,
    emit: (response: DocumentWorkerResponseMessage) => void
  ): void => {
    const previousPages = new Map(previous.pages.map((page) => [page.pageId, page]))
    for (const page of current.pages) {
      const previousPage = previousPages.get(page.pageId)
      if (!previousPage) continue
      const previousBlocks = new Map(previousPage.blocks.map((block) => [block.blockId, block]))
      for (const block of page.blocks) {
        const previousBlock = previousBlocks.get(block.blockId)
        if (!previousBlock || JSON.stringify(previousBlock) === JSON.stringify(block)) continue
        emit(createDocumentWorkerTranslationUpdateMessage(jobId, generation, {
          pageId: page.pageId,
          blockId: block.blockId,
          block,
          completed,
          total
        }))
      }
    }
  }

  /**
   * 发布首次翻译骨架；后续变化只发送顶层区块增量。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @param source 已完成解析与 OCR 的源文档。
   * @param translation 翻译开始时的完整译文骨架。
   * @param languageResolution 本任务冻结的语言方向。
   * @param completed 当前翻译阶段已完成目标数。
   * @param total 当前翻译阶段目标总数。
   * @param emit 响应发送函数。
   * @returns 无返回值。
   * @author zhenghq
   */
  const publishTranslationSnapshot = (
    jobId: string,
    generation: number,
    source: DocumentModel,
    translation: DocumentModel,
    languageResolution: DocumentLanguageResolution,
    completed: number,
    total: number,
    emit: (response: DocumentWorkerResponseMessage) => void
  ): void => {
    emit(createDocumentWorkerTranslationSnapshotMessage(jobId, generation, {
      source,
      translation,
      languageResolution,
      completed,
      total
    }))
  }

  /**
   * 将流水线结果转换为缓存快照。
   * @param job 当前缓存任务。
   * @param result 流水线结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  const commitResult = (job: CachedWorkerJob, result: DocumentPipelineResult): void => {
    job.generation = result.task.generation
    job.task = result.task
    job.source = result.source
    job.translation = result.translation
    job.languageResolution = result.languageResolution ?? job.languageResolution
    if (result.completionReport) job.completionReport = result.completionReport
    job.retryableTargetIds = result.retryableTargetIds ??
      collectRetryableDocumentTargetIds(job.completionReport)
  }

  /**
   * 构造成功终态载荷。
   * @param job 当前任务。
   * @returns 可安全发送的终态载荷。
   * @author zhenghq
   */
  const resultPayload = (job: CachedWorkerJob): {
    status: 'completed' | 'partial' | 'failed'
    percent: number
    errorCode?: string
    source: DocumentModel
    translation: DocumentModel
    languageResolution: DocumentLanguageResolution
    completionReport: DocumentCompletionReport
    retryableTargetIds: string[]
    runMode: 'translation' | 'ocr'
  } => ({
    status: job.completionReport.status === 'completed'
      ? 'completed'
      : job.completionReport.status === 'partial' ? 'partial' : 'failed',
    percent: calculateDocumentTaskProgress({
      ...job.task,
      status: job.task.status === 'cancelled'
        ? 'failed'
        : job.completionReport.status === 'completed' ? 'completed' : 'partial'
    }),
    ...(job.completionReport.status === 'failed' ? { errorCode: 'translation-failed' } : {}),
    source: job.source,
    translation: job.translation,
    languageResolution: job.languageResolution,
    completionReport: job.completionReport,
    retryableTargetIds: [...job.retryableTargetIds],
    runMode: job.request.mode ?? 'translation'
  })

  /**
   * 执行一次完整翻译并发送终态。
   * @param message 已校验运行请求。
   * @param signal 取消信号。
   * @param emit 响应发送函数。
   * @returns 无返回值。
   * @author zhenghq
   */
  const run = async (
    message: Extract<DocumentWorkerRequestMessage, { type: 'run' }>,
    signal: AbortSignal,
    emit: (response: DocumentWorkerResponseMessage) => void
  ): Promise<void> => {
    const input = await loadWorkerInput(message.request, signal)
    // 流水线开始前先建立资源缓存，解析与 OCR 期间读取到的资源才能立即登记；
    // 后续创建任务快照时直接复用同一 Map，避免重试或导出再次读取文件。
    const assetBytes = new Map<string, Uint8Array>()
    const task = createDocumentTaskState(message.jobId, message.generation)
    let sourceSnapshot: DocumentModel | null = null
    let languageResolution: DocumentLanguageResolution | null = null
    let previousTranslation: DocumentModel | null = null
    let translationCompleted = 0
    let translationTotal = 0
    const pipeline = await runDocumentTranslationPipeline(input, task, signal, {
      parse: async (parseInput) => {
        const parsed = await dependencies.parse(parseInput, signal, (assetId, bytes) => {
          assetBytes.set(assetId, bytes)
        })
        sourceSnapshot = parsed
        return parsed
      },
      loadAssetBytes: async (asset) => {
        const cached = assetBytes.get(asset.assetId)
        if (cached) return cached
        const loaded = await dependencies.loadAssetBytes(asset)
        if (loaded) {
          assetBytes.set(asset.assetId, loaded)
        }
        return loaded
      },
      recognizeImage: (bytes, ocrSignal) => dependencies.recognizeImage(bytes, ocrSignal),
      translate: (text, translateSignal, languagePair, onDelta) =>
        dependencies.translate(text, translateSignal, languagePair, onDelta, {
          jobId: message.jobId,
          generation: message.generation
        }),
      onProgress: (state) => {
        if (state.phase === 'translate') {
          translationCompleted = state.progress.completed
          translationTotal = state.progress.total
        }
        emit(createDocumentWorkerProgressMessage(message.jobId, message.generation, {
          percent: calculateDocumentTaskProgress(state),
          phase: state.phase,
          completed: state.progress.completed,
          total: state.progress.total,
          warningCount: state.warningCount
        }))
      },
      publishLanguageResolution: (resolution) => {
        languageResolution = resolution
      },
      publishTranslation: (translation) => {
        if (!previousTranslation) {
          if (!sourceSnapshot || !languageResolution) return
          publishTranslationSnapshot(
            message.jobId,
            message.generation,
            sourceSnapshot,
            translation,
            languageResolution,
            translationCompleted,
            translationTotal,
            emit
          )
        } else {
          publishTranslationDelta(
            message.jobId,
            message.generation,
            previousTranslation,
            translation,
            translationCompleted,
            translationTotal,
            emit
          )
        }
        previousTranslation = translation
      },
      concurrency: dependencies.getTranslationConcurrency?.(),
      ocrConcurrency: dependencies.getOcrConcurrency?.(),
      getModelFingerprint: () => modelFingerprint
    }, {
      sourcePreference: message.request.sourceLang ?? 'auto',
      targetPreference: message.request.targetLang ?? 'auto'
    }, message.request.mode ?? 'translation')
    languageResolution = pipeline.languageResolution ?? {
      sourcePreference: message.request.sourceLang ?? 'auto',
      targetPreference: message.request.targetLang ?? 'auto',
      languagePair: pipeline.languagePair ?? { sourceLang: 'auto', targetLang: 'ZH' }
    }
    const job: CachedWorkerJob = {
      jobId: message.jobId,
      generation: message.generation,
      request: { ...message.request },
      input,
      source: pipeline.source,
      translation: pipeline.translation,
      languageResolution,
      completionReport: pipeline.completionReport!,
      task: pipeline.task,
      retryableTargetIds: pipeline.retryableTargetIds ?? [],
      assetBytes
    }
    if (!job.completionReport) throw new Error('completion-report-missing')
    jobs.set(message.jobId, job)
    emit(createDocumentWorkerResultMessage(message.jobId, message.generation, resultPayload(job)))
  }

  /**
   * 使用缓存源文重试失败、未完成与疑似未翻译目标。
   * @param message 已校验重试请求。
   * @param signal 取消信号。
   * @param emit 响应发送函数。
   * @returns 无返回值。
   * @author zhenghq
   */
  const retry = async (
    message: Extract<DocumentWorkerRequestMessage, { type: 'retry' }>,
    signal: AbortSignal,
    emit: (response: DocumentWorkerResponseMessage) => void
  ): Promise<void> => {
    const job = jobs.get(message.jobId)
    if (!job) throw new DocumentWorkerExportError('job-not-found')
    if (message.generation <= job.generation) throw new DocumentWorkerExportError('generation-conflict')
    const task = {
      ...createDocumentTaskState(job.jobId, message.generation),
      phase: 'translate' as const,
      status: 'translating' as const,
      progress: { completed: 0, total: job.retryableTargetIds.length }
    }
    let previousTranslation: DocumentModel | null = null
    let retryCompleted = 0
    let retryTotal = task.progress.total
    const result = await retryFailedDocumentTranslationPipeline(
      job.source,
      job.translation,
      job.retryableTargetIds,
      task,
      signal,
      {
        parse: async () => job.source,
        loadAssetBytes: async (asset) => job.assetBytes.get(asset.assetId) ?? null,
        recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
        translate: (text, translateSignal, languagePair, onDelta) =>
          dependencies.translate(text, translateSignal, languagePair, onDelta, {
            jobId: message.jobId,
            generation: message.generation
          }),
        onProgress: (state) => {
          retryCompleted = state.progress.completed
          retryTotal = state.progress.total
          emit(createDocumentWorkerProgressMessage(message.jobId, message.generation, {
            percent: calculateDocumentTaskProgress(state),
            phase: state.phase,
            completed: state.progress.completed,
            total: state.progress.total,
            warningCount: state.warningCount
          }))
        },
        publishTranslation: (translation) => {
          if (!previousTranslation) {
            publishTranslationSnapshot(
              message.jobId,
              message.generation,
              job.source,
              translation,
              job.languageResolution,
              retryCompleted,
              retryTotal,
              emit
            )
          } else {
            publishTranslationDelta(
              message.jobId,
              message.generation,
              previousTranslation,
              translation,
              retryCompleted,
              retryTotal,
              emit
            )
          }
          previousTranslation = translation
        },
        concurrency: dependencies.getTranslationConcurrency?.(),
        ocrConcurrency: dependencies.getOcrConcurrency?.(),
        getModelFingerprint: () => modelFingerprint
      },
      job.languageResolution
    )
    commitResult(job, result)
    emit(createDocumentWorkerResultMessage(message.jobId, message.generation, resultPayload(job)))
  }

  /**
   * 复验完成报告并按显式完整/部分模式导出 PDF。
   * @param message 已校验导出请求。
   * @param signal 取消信号。
   * @param emit 响应发送函数。
   * @returns 无返回值。
   * @author zhenghq
   */
  const exportPdf = async (
    message: Extract<DocumentWorkerRequestMessage, { type: 'export' }>,
    signal: AbortSignal,
    emit: (response: DocumentWorkerResponseMessage) => void
  ): Promise<void> => {
    const job = jobs.get(message.jobId)
    if (!job) throw new DocumentWorkerExportError('job-not-found')
    if (message.generation !== job.generation) throw new DocumentWorkerExportError('completion-mismatch')
    if (message.request.mode === 'partial' && message.request.confirmPartialExport !== true) {
      throw new DocumentWorkerExportError('partial-export-not-confirmed')
    }
    const currentReport = job.completionReport
    const requestedReport = message.request.completionReport
    if (!requestedReport) throw new DocumentWorkerExportError('completion-mismatch')
    const validation = validateDocumentCompletionReport(requestedReport, {
      jobId: job.jobId,
      generation: job.generation,
      documentId: job.source.documentId,
      modelFingerprint: currentReport.modelFingerprint,
      total: currentReport.total,
      translated: currentReport.translated,
      unchanged: currentReport.unchanged,
      failed: currentReport.failed,
      pending: currentReport.pending,
      suspectUntranslated: currentReport.suspectUntranslated
    })
    if (!validation.ok) throw new DocumentWorkerExportError(validation.code)
    if (message.request.mode === 'complete') {
      if (currentReport.status !== 'completed' || currentReport.failed > 0 ||
        currentReport.pending > 0 || currentReport.suspectUntranslated > 0) {
        throw new DocumentWorkerExportError('completion-mismatch')
      }
    }
    const ocrOnly = (job.request.mode ?? 'translation') === 'ocr'
    const partial = !ocrOnly && message.request.mode === 'partial'
      ? buildPartialExportDocument(job.source, job.translation, currentReport)
      : undefined
    // OCR 原文直接导出已完成 OCR 的源模型，不能为满足翻译计数而伪造部分译文目录。
    if (!ocrOnly && !partial) {
      buildPartialExportDocument(job.source, job.translation, currentReport)
    }
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    // OCR 原文导出明确使用已完成识别的源模型，确保底图与透明文字层来自同一任务快照。
    const exportModel = ocrOnly ? job.source : partial?.model ?? job.translation
    const output = await dependencies.exportPdf(exportModel, {
      loadFontBytes: () => dependencies.loadFontBytes(),
      loadAssetBytes: async (assetId) => job.assetBytes.get(assetId) ?? null
    }, partial?.summary, message.request.textLayer)
    const payload: DocumentWorkerExportPayload = {
      bytes: output.bytes,
      warnings: output.warnings,
      ...(partial ? { partial: partial.summary } : {})
    }
    emit(createDocumentWorkerResultMessage(message.jobId, message.generation, {
      status: currentReport.status === 'completed' ? 'completed' : 'partial',
      percent: 100,
      source: job.source,
      translation: job.translation,
      languageResolution: job.languageResolution,
      completionReport: currentReport,
      retryableTargetIds: [...job.retryableTargetIds],
      export: payload
    }))
  }

  /**
   * 读取当前任务已声明资源，优先复用内存缓存，未命中时按资源元数据加载并缓存。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @param assetId 已声明资源标识。
   * @returns 资源字节与 MIME，或稳定错误分类。
   * @author zhenghq
   */
  const readAsset = async (
    jobId: string,
    generation: number,
    assetId: string
  ): Promise<{ ok: true; mimeType?: string; bytes: Uint8Array } | { ok: false; code: string }> => {
    const job = jobs.get(jobId)
    if (!job || job.generation !== generation) return { ok: false, code: 'asset-not-found' }
    const asset = job.source.assets.find((candidate) => candidate.assetId === assetId) ??
      job.translation.assets.find((candidate) => candidate.assetId === assetId)
    if (!asset) return { ok: false, code: 'asset-not-found' }
    try {
      const cached = job.assetBytes.get(assetId)
      if (cached) {
        return { ok: true, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}), bytes: cached }
      }
      const bytes = await dependencies.loadAssetBytes(asset)
      if (!bytes) return { ok: false, code: 'asset-not-found' }
      job.assetBytes.set(assetId, bytes)
      return { ok: true, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}), bytes }
    } catch {
      return { ok: false, code: 'asset-unavailable' }
    }
  }

  return {
    async execute(message, signal, emit): Promise<void> {
      try {
        if (message.type === 'asset-request') return
        if (message.type === 'run') return await run(message, signal, emit)
        if (message.type === 'retry') return await retry(message, signal, emit)
        if (message.type === 'export') return await exportPdf(message, signal, emit)
      } catch (error) {
        if (signal.aborted || resolveDocumentWorkerErrorCode(error) === 'cancelled') {
          throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        }
        throw Object.assign(new Error(resolveProductionErrorCode(error, 'worker-failed')), {
          code: resolveProductionErrorCode(error, 'worker-failed')
        })
      }
    },
    readAsset
  }
}
