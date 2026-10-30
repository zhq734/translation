import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import {
  DOCUMENT_MAX_FILE_BYTES,
  DOCUMENT_ZIP_TAIL_BYTES,
  getDocumentZipCentralDirectoryRange,
  validateDocumentFile
} from '../shared/documentFormat.ts'
import {
  calculateDocumentTaskProgress,
  createDocumentTaskState,
  failDocumentTask,
  requestDocumentTaskCancellation,
  type DocumentTaskState
} from '../shared/documentTask.ts'
import type {
  DocumentAsset,
  DocumentModel,
  DocumentWarning
} from '../shared/documentTypes.ts'
import type {
  DocumentLanguagePair,
  DocumentLanguageResolution
} from '../shared/documentLanguageDirection.ts'
import type { DocumentCompletionReport } from '../shared/documentCompletion.ts'
import {
  collectRetryableDocumentTargetIds,
  selectDocumentWorkspaceSnapshot,
  validateDocumentCompletionReport
} from '../shared/documentCompletion.ts'
import {
  buildPartialExportDocument,
  type DocumentPartialExportSummary
} from '../shared/documentPartialExport.ts'
import type {
  DocumentAssetResult,
  DocumentExportRequest,
  DocumentExportResult,
  DocumentHistoryEntry,
  DocumentRunRequest,
  DocumentRunResult,
  DocumentSourceResult,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../shared/documentWorkspace.ts'
import type { OcrRecognizeResult } from '../shared/ocrEngine.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
import { decodeDocumentText } from './documentParserShared.ts'
import { sanitizeHtmlPreview } from './documentTextParser.ts'
import {
  normalizePackagePath,
  readPackageBytes,
  loadSafeDocumentPackage
} from './documentPackageShared.ts'
import {
  retryFailedDocumentTranslationPipeline,
  runDocumentTranslationPipeline,
  type DocumentPipelineResult
} from './documentTranslationPipeline.ts'
import { DocumentPdfExportError } from './documentPdfExport.ts'
import { writeDocumentFileAtomically } from './documentAtomicFile.ts'

/** 文件头预检读取上限，与文件选择阶段保持一致。 */
const DOCUMENT_HEAD_BYTES = 8192

/** 任务服务保存对话框结果。 */
export interface DocumentSaveDialogResult {
  /** 用户是否取消保存。 */
  canceled: boolean
  /** 用户选择的保存路径。 */
  filePath?: string
}

/** 文档工作台任务服务依赖。 */
export interface DocumentWorkspaceTaskServiceDependencies {
  /** 判断路径是否已由当前文档窗口批准。 */
  isApprovedPath(path: string): boolean
  /** 推送运行中进度快照。 */
  sendProgress(snapshot: DocumentWorkspaceSnapshot): void
  /** 推送可立即原位合并的单个译文区块。 */
  sendTranslationUpdate?(update: DocumentWorkspaceTranslationUpdate): void
  /** 推送最终完成、部分完成、取消或失败快照。 */
  sendCompleted(snapshot: DocumentWorkspaceSnapshot): void
  /** 解析完整文档；第二个参数用于登记 PDF 等解析期生成的资源字节，第三个参数用于传递取消信号。 */
  parse(
    input: DocumentParseInput,
    registerAssetBytes?: (assetId: string, bytes: Uint8Array) => void,
    signal?: AbortSignal
  ): Promise<DocumentModel>
  /** 翻译单段文本，显式接收任务级语言对，并通过 onDelta 推送当前片段的增量译文。 */
  translate(
    text: string,
    signal: AbortSignal,
    request: DocumentRunRequest,
    languagePair: DocumentLanguagePair,
    onDelta?: (delta: string) => void
  ): Promise<string>
  /** 识别图片文字。 */
  recognizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<OcrRecognizeResult>
  /** 读取解析器未直接缓存的资源字节。 */
  loadAssetBytes?(asset: DocumentAsset, input: DocumentParseInput): Promise<Uint8Array | null>
  /** 读取可嵌入 PDF 的 CJK 字体。 */
  loadFontBytes(): Promise<Uint8Array | null>
  /** 将译文模型导出为 PDF；部分导出时携带回退摘要，双层导出时追加透明 OCR 文字层。 */
  exportPdf(model: DocumentModel, dependencies: {
    loadFontBytes(): Promise<Uint8Array | null>
    loadAssetBytes(assetId: string): Promise<Uint8Array | null>
  }, partialExport?: DocumentPartialExportSummary, textLayer?: boolean): Promise<DocumentPdfExportResult>
  /** 显示 PDF 保存对话框。 */
  showSaveDialog(suggestedName: string): Promise<DocumentSaveDialogResult>
  /** 将 PDF 字节写入用户选择的位置。 */
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** 将已完成的临时 PDF 原子替换为目标文件。 */
  rename(source: string, target: string): Promise<void>
  /** 清理写入或替换失败时遗留的临时文件。 */
  unlink(path: string): Promise<void>
  /**
   * 读取页面翻译使用的并发数，供文档批量翻译复用同一用户配置。
   * @returns 页面翻译并发数。
   * @author zhenghq
   */
  getTranslationConcurrency?(): number
  /**
   * 读取文档 OCR 并发数。
   * @returns 文档 OCR 并发数。
   * @author zhenghq
   */
  getOcrConcurrency?(): number
  /**
   * 读取当前翻译提供方与模型的稳定指纹，用于完成报告绑定。
   * @returns 不含凭据的模型指纹。
   * @author zhenghq
   */
  getModelFingerprint?(): string
}

/** 文档 PDF 导出器返回的字节与可降级告警。 */
export interface DocumentPdfExportResult {
  /** 已生成的 PDF 字节。 */
  bytes: Uint8Array
  /** 导出期间产生的可降级告警。 */
  warnings: DocumentWarning[]
}

/** 单个运行中任务的内部状态。 */
interface ActiveDocumentJob {
  /** 任务标识。 */
  jobId: string
  /** 请求代际。 */
  generation: number
  /** 原始运行请求。 */
  request: DocumentRunRequest
  /** 取消控制器。 */
  controller: AbortController
  /** 文件解析输入。 */
  input: DocumentParseInput
  /** 当前任务状态。 */
  task: DocumentTaskState
  /** 已解析源文档。 */
  source?: DocumentModel
  /** 翻译后的文档。 */
  translation?: DocumentModel
  /** 首次运行冻结的语言偏好与实际方向；重试必须原样复用。 */
  languageResolution?: DocumentLanguageResolution
  /** 最近一次翻译阶段失败、可再次请求的目标标识。 */
  failedTargetIds: string[]
  /** 失败、未完成与疑似未翻译目标组成的完整重试集合。 */
  retryableTargetIds: string[]
  /** 最近一次终态对应的完整完成报告。 */
  completionReport?: DocumentCompletionReport
  /** 资源字节缓存。 */
  assetBytes: Map<string, Uint8Array>
  /** HTML 源文净化预览缓存，避免流式更新期间重复净化同一文件。 */
  sanitizedHtmlSource?: Uint8Array
  /** 取消后是否允许迟到结果覆盖终态。 */
  cancelled: boolean
  /** 完成事件是否已经发送。 */
  settled: boolean
  /** 最近一次已经接受并发送的工作台快照。 */
  lastSnapshot?: DocumentWorkspaceSnapshot
}

/**
 * 计算文件内容 SHA-256。
 * @param bytes 完整文件字节。
 * @returns 小写十六进制摘要。
 * @author zhenghq
 */
function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 将内部错误映射为稳定错误分类，避免把路径或正文带到界面。
 * @param error 捕获的异常。
 * @param fallback 无法分类时使用的错误码。
 * @returns 稳定错误分类。
 * @author zhenghq
 */
function errorCode(error: unknown, fallback: string): string {
  if (error instanceof DocumentPdfExportError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return fallback
}

/**
 * 文档工作台任务服务，负责把文件校验、解析、OCR、翻译、进度和导出串成受控链路。
 * @author zhenghq
 */
export class DocumentWorkspaceTaskService {
  private readonly dependencies: DocumentWorkspaceTaskServiceDependencies
  private active: ActiveDocumentJob | null = null
  private highestGeneration = 0
  private starting = false
  private disposed = false
  /** 当前 Renderer 已创建但尚未返回 jobId 的启动请求，用于去重重复点击。 */
  private pendingGeneration: number | null = null

  /**
   * 创建任务服务。
   * @param dependencies 主进程能力与界面事件依赖。
   * @author zhenghq
   */
  constructor(dependencies: DocumentWorkspaceTaskServiceDependencies) {
    this.dependencies = dependencies
  }

  /**
   * 接受一个已批准文件的翻译任务并立即返回，后续通过事件推送进度。
   * @param request 文档运行请求。
   * @returns 接受结果或稳定拒绝分类。
   * @author zhenghq
   */
  async run(request: DocumentRunRequest): Promise<DocumentRunResult> {
    if (this.disposed) return { accepted: false, code: 'service-disposed' }
    if (!request || typeof request.path !== 'string' || !request.path.trim() ||
      !Number.isInteger(request.generation) || request.generation < 1) {
      return { accepted: false, code: 'invalid-request' }
    }
    if (!this.dependencies.isApprovedPath(request.path)) {
      return { accepted: false, code: 'path-not-approved' }
    }
    // 启动中的首个请求尚未完成文件读取，此时 highestGeneration 仍为旧值；
    // 同代际重复请求必须先识别为 busy，避免误返回可重试的代际冲突。
    if (request.generation <= this.highestGeneration &&
      !(this.starting && this.pendingGeneration === request.generation)) {
      return {
        accepted: false,
        code: 'generation-conflict',
        suggestedGeneration: this.highestGeneration + 1
      }
    }
    // Renderer 在 runDocument 返回 jobId 前无法区分自身重复启动；
    // 同一代际的重复请求只保留首个，避免同一文件被并发解析和翻译。
    if (this.starting && this.pendingGeneration === request.generation) {
      return { accepted: false, code: 'busy' }
    }
    if (this.starting || (this.active && !this.active.settled)) {
      return { accepted: false, code: 'busy' }
    }

    this.starting = true
    this.pendingGeneration = request.generation
    try {
      let fileStat: Awaited<ReturnType<typeof stat>>
      try {
        fileStat = await stat(request.path)
      } catch {
        return { accepted: false, code: 'unreadable' }
      }
      if (!fileStat.isFile()) return { accepted: false, code: 'unreadable' }
      if (fileStat.size === 0) return { accepted: false, code: 'empty-file' }
      if (fileStat.size > DOCUMENT_MAX_FILE_BYTES) return { accepted: false, code: 'too-large' }

      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await readFile(request.path))
      } catch {
        return { accepted: false, code: 'unreadable' }
      }
      if (bytes.byteLength !== fileStat.size) return { accepted: false, code: 'file-changed' }
      const tail = bytes.subarray(Math.max(0, bytes.byteLength - DOCUMENT_ZIP_TAIL_BYTES))
      const zipRange = getDocumentZipCentralDirectoryRange(tail, bytes.byteLength)
      const zipDirectory = zipRange
        ? bytes.subarray(zipRange.start, zipRange.end)
        : undefined
      const validation = validateDocumentFile({
        fileName: basename(request.path),
        size: bytes.byteLength,
        head: bytes.subarray(0, Math.min(bytes.byteLength, DOCUMENT_HEAD_BYTES)),
        tail,
        ...(zipDirectory ? { zipDirectory } : {}),
        readable: true
      })
      if (!validation.ok) return { accepted: false, code: validation.code }

      const jobId = randomUUID()
      const input: DocumentParseInput = {
        path: request.path,
        fileName: basename(request.path),
        format: validation.format,
        sha256: hashBytes(bytes),
        bytes
      }
      const job: ActiveDocumentJob = {
        jobId,
        generation: request.generation,
        request: { ...request },
        controller: new AbortController(),
        input,
        task: createDocumentTaskState(jobId, request.generation),
        failedTargetIds: [],
        retryableTargetIds: [],
        assetBytes: new Map(),
        cancelled: false,
        settled: false
      }
      this.highestGeneration = request.generation
      this.active = job
      this.emitProgress(job, job.task)
      void this.process(job)
      return { accepted: true, jobId }
    } finally {
      this.starting = false
      this.pendingGeneration = null
    }
  }

  /**
   * 请求取消当前任务；只有任务标识和代际同时匹配时才生效。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否实际发出了取消请求。
   * @author zhenghq
   */
  cancel(jobId: string, generation: number): boolean {
    const job = this.active
    if (!job || job.jobId !== jobId || job.generation !== generation || job.settled) return false
    job.cancelled = true
    job.task = requestDocumentTaskCancellation(job.task)
    job.controller.abort()
    this.emitCompleted(job, job.task)
    return true
  }

  /**
   * 使用新的代际重新翻译当前任务中失败的目标，不重新解析文档或执行 OCR。
   * @param generation Renderer 生成的新任务代际。
   * @returns 是否接受重试以及稳定拒绝分类。
   * @author zhenghq
   */
  retryFailed(generation: number): DocumentRunResult {
    const job = this.active
    if (this.disposed) return { accepted: false, code: 'service-disposed' }
    if ((job?.request.mode ?? 'translation') === 'ocr') {
      return { accepted: false, code: 'no-retryable-failures' }
    }
    if (!Number.isInteger(generation) || generation < 1) {
      return { accepted: false, code: 'invalid-request' }
    }
    if (generation <= this.highestGeneration) {
      return {
        accepted: false,
        code: 'generation-conflict',
        suggestedGeneration: this.highestGeneration + 1
      }
    }
    const retryableTargetIds = this.resolveRetryableTargetIds(job)
    const completionStatus = this.resolveCompletionStatus(job)
    const retryableTerminal = completionStatus
      ? completionStatus === 'partial' || completionStatus === 'failed'
      : job?.task.status === 'partial' ||
        (job?.task.status === 'failed' && retryableTargetIds.length > 0)
    if (this.starting || !job || !job.settled || !retryableTerminal) {
      return { accepted: false, code: 'not-ready' }
    }
    if (!job.source || !job.translation || !job.languageResolution ||
      retryableTargetIds.length === 0) {
      return { accepted: false, code: 'no-retryable-failures' }
    }

    job.generation = generation
    job.task = {
      ...createDocumentTaskState(job.jobId, generation),
      phase: 'translate',
      status: 'translating',
      progress: { completed: 0, total: retryableTargetIds.length }
    }
    // 新代际必须丢弃上一代际的可重试集合；否则即使本轮全部成功，快照仍会
    // 暴露旧的 retryableFailedBlocks，导致 completed 被界面误判为仍有失败块。
    job.retryableTargetIds = []
    job.completionReport = undefined
    // 新代际允许重新进入运行态；旧终态快照只用于拒绝旧事件，不能阻止本次重试。
    job.lastSnapshot = undefined
    job.controller = new AbortController()
    job.cancelled = false
    job.settled = false
    this.highestGeneration = generation
    this.emitProgress(job, job.task)
    void this.retry(job, retryableTargetIds)
    return { accepted: true, jobId: job.jobId }
  }

  /**
   * 读取当前任务最近一次终态的完成报告快照。
   * @returns 单条历史快照；尚无完成报告时返回空数组。
   * @author zhenghq
   */
  getHistory(): DocumentHistoryEntry[] {
    const job = this.active
    if (!job?.completionReport) return []
    return [{
      jobId: job.jobId,
      generation: job.generation,
      completionReport: job.completionReport
    }]
  }

  /**
   * 读取当前任务模型中的图片资源；只允许已解析资源标识。
   * @param assetId 资源标识。
   * @returns 受控资源读取结果。
   * @author zhenghq
   */
  async getAsset(assetId: string): Promise<DocumentAssetResult> {
    const job = this.active
    if (this.disposed || !job || typeof assetId !== 'string' || !assetId || assetId.includes('/') || assetId.includes('\\') || assetId.includes('..')) {
      return { ok: false, code: 'asset-not-found' }
    }
    const asset = job.source?.assets.find((candidate) => candidate.assetId === assetId) ??
      job.translation?.assets.find((candidate) => candidate.assetId === assetId)
    if (!asset) return { ok: false, code: 'asset-not-found' }
    try {
      const bytes = await this.loadAsset(job, asset)
      if (!bytes) return { ok: false, code: 'asset-not-found' }
      return { ok: true, mimeType: asset.mimeType, bytes }
    } catch {
      return { ok: false, code: 'asset-unavailable' }
    }
  }

  /**
   * 读取当前活动 PDF 的原始字节，或返回 HTML 的受控净化预览。
   * HTML 不返回原始脚本与远程资源，也不暴露本地路径；其他格式返回 source-not-found。
   * @returns 受控源文件读取结果。
   * @author zhenghq
   */
  getSource(): DocumentSourceResult {
    const job = this.active
    if (this.disposed || !job) return { ok: false, code: 'source-not-found' }
    if (job.input.format === 'html') {
      if (!job.sanitizedHtmlSource) {
        const sanitized = sanitizeHtmlPreview(decodeDocumentText(job.input.bytes)).html
        job.sanitizedHtmlSource = new TextEncoder().encode(sanitized)
      }
      return {
        ok: true,
        mimeType: 'text/html; charset=utf-8',
        bytes: new Uint8Array(job.sanitizedHtmlSource)
      }
    }
    if (job.input.format !== 'pdf') return { ok: false, code: 'source-not-found' }
    return {
      ok: true,
      mimeType: 'application/pdf',
      bytes: new Uint8Array(job.input.bytes)
    }
  }

  /**
   * 校验任务终态、代际和显式导出模式后，将当前译文或 OCR 原文模型导出为 PDF。
   * @param request 当前任务标识、代际、完整/部分导出模式及透明文字层选项。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  async exportPdf(request: DocumentExportRequest): Promise<DocumentExportResult> {
    if (this.disposed) return { status: 'rejected', code: 'service-disposed' }
    if (!request || typeof request !== 'object' ||
      typeof request.jobId !== 'string' || !request.jobId.trim() ||
      !Number.isInteger(request.generation) || request.generation < 1 ||
      (request.mode !== 'complete' && request.mode !== 'partial')) {
      return { status: 'rejected', code: 'invalid-request' }
    }
    const job = this.active
    if (!job || !job.settled || !job.translation) {
      return { status: 'rejected', code: 'not-ready' }
    }
    if (request.jobId !== job.jobId || request.generation !== job.generation) {
      return { status: 'rejected', code: 'completion-mismatch' }
    }
    if (!job.completionReport || !job.source) {
      return { status: 'rejected', code: 'completion-mismatch' }
    }
    // OCR 原文模式不产生翻译目标，但仍必须使用同一任务、代际、文档和模型指纹完成报告。
    const ocrOnly = (job.request.mode ?? 'translation') === 'ocr'
    const validation = validateDocumentCompletionReport(job.completionReport, {
      jobId: job.jobId,
      generation: job.generation,
      documentId: job.source.documentId,
      modelFingerprint: this.dependencies.getModelFingerprint?.() ??
        'document-translation-model',
      total: job.completionReport.total,
      translated: job.completionReport.translated,
      unchanged: job.completionReport.unchanged,
      failed: job.completionReport.failed,
      pending: job.completionReport.pending,
      suspectUntranslated: job.completionReport.suspectUntranslated
    })
    if (!validation.ok) {
      return { status: 'rejected', code: validation.code }
    }
    if (job.task.status === 'completed') {
      if (request.mode !== 'complete') {
        return { status: 'rejected', code: 'completion-mismatch' }
      }
      // completed 是面向用户的完整语义，必须与完成报告中的目标终态同时成立；
      // 仅校验计数不变量会放过“completed + failed/pending/suspect > 0”的伪造或陈旧报告。
      if (job.completionReport.status !== 'completed' ||
        job.completionReport.failed !== 0 ||
        job.completionReport.pending !== 0 ||
        job.completionReport.suspectUntranslated !== 0) {
        return { status: 'rejected', code: 'completion-mismatch' }
      }
    } else if (job.task.status === 'partial') {
      if (request.mode === 'complete') {
        return { status: 'rejected', code: 'partial-export-not-confirmed' }
      }
    } else if (!ocrOnly &&
      job.completionReport.translated + job.completionReport.unchanged === 0) {
      return { status: 'rejected', code: 'not-ready' }
    }
    try {
      // OCR 原文没有部分译文回退语义，直接导出已完成 OCR 的源模型。
      const exportDocument = !ocrOnly && request.mode === 'partial'
        ? buildPartialExportDocument(job.source, job.translation, job.completionReport)
        : undefined
      // 完整导出也必须先按源模型重建目标目录，避免伪造或过期的成功计数进入保存流程。
      if (!ocrOnly && !exportDocument) {
        buildPartialExportDocument(job.source, job.translation, job.completionReport)
      }
      const save = await this.dependencies.showSaveDialog(
        ocrOnly
          ? `${job.input.fileName.replace(/\.[^.]+$/u, '')}-ocr.pdf`
          : request.mode === 'partial'
          ? `${job.input.fileName.replace(/\.[^.]+$/u, '')}-partial-${exportDocument?.summary.reverted ?? 0}-reverted-translated.pdf`
          : `${job.input.fileName.replace(/\.[^.]+$/u, '')}-translated.pdf`
      )
      if (save.canceled || !save.filePath) return { status: 'cancelled' }
      // OCR 原文导出明确使用任务源模型，避免流水线返回结构变化时误把翻译模型写入双层 PDF。
      const exportModel = ocrOnly ? job.source : exportDocument?.model ?? job.translation
      const result = await this.dependencies.exportPdf(exportModel, {
        loadFontBytes: () => this.dependencies.loadFontBytes(),
        loadAssetBytes: async (assetId) => {
          const asset = exportModel.assets.find((candidate) => candidate.assetId === assetId)
          return asset ? this.loadAsset(job, asset) : null
        }
      }, exportDocument?.summary, request.textLayer)
      await writeDocumentFileAtomically(save.filePath, result.bytes, {
        writeFile: (path, bytes) => this.dependencies.writeFile(path, bytes),
        rename: (source, target) => this.dependencies.rename(source, target),
        unlink: (path) => this.dependencies.unlink(path)
      })
      return {
        status: 'saved',
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
      }
    } catch (error) {
      return { status: 'rejected', code: errorCode(error, 'export-failed') }
    }
  }

  /**
   * 释放当前任务并取消所有仍在运行的工作。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const job = this.active
    this.active = null
    if (job) {
      job.cancelled = true
      job.controller.abort()
      this.releaseJob(job)
    }
  }

  /**
   * 清空任务持有的模型、源文件、资源和快照引用，帮助关闭窗口后及时释放内存。
   * @param job 待释放任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private releaseJob(job: ActiveDocumentJob): void {
    job.source = undefined
    job.translation = undefined
    job.input.bytes = new Uint8Array(0)
    job.assetBytes.clear()
    job.sanitizedHtmlSource = undefined
    job.lastSnapshot = undefined
    job.completionReport = undefined
    job.failedTargetIds = []
    job.retryableTargetIds = []
  }

  /**
   * 执行解析、OCR、翻译和版面合成。
   * @param job 当前任务。
   * @param retryableTargetIds 本代际需要重试的目标快照。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async process(job: ActiveDocumentJob): Promise<void> {
    let previousTranslation: DocumentModel | undefined
    let translationCompleted = 0
    let translationTotal = 0
    try {
      const result: DocumentPipelineResult = await runDocumentTranslationPipeline(
        job.input,
        job.task,
        job.controller.signal,
        {
          parse: async (input) => {
            const parsed = await this.dependencies.parse(
              input,
              (assetId, bytes) => {
                job.assetBytes.set(assetId, bytes)
              },
              job.controller.signal
            )
            job.source = parsed
            return parsed
          },
          loadAssetBytes: (asset) => this.loadAsset(job, asset),
          recognizeImage: (bytes, signal) => this.dependencies.recognizeImage(bytes, signal),
          translate: (text, signal, languagePair, onDelta) =>
            this.dependencies.translate(text, signal, job.request, languagePair, onDelta),
          onProgress: (state) => {
            if (job.cancelled || job.settled) return
            if (state.phase === 'translate') {
              translationCompleted = state.progress.completed
              translationTotal = state.progress.total
            }
            job.task = state
            this.emitProgress(job, state)
          },
          publishTranslation: (translation) => {
            if (job.cancelled || job.settled || job.controller.signal.aborted) return
            job.translation = translation
            if (previousTranslation) {
              this.emitTranslationUpdates(
                job,
                previousTranslation,
                translation,
                translationCompleted,
                translationTotal
              )
            }
            previousTranslation = translation
            this.emitProgress(job, job.task)
          },
          concurrency: this.dependencies.getTranslationConcurrency?.(),
          ocrConcurrency: this.dependencies.getOcrConcurrency?.(),
          getModelFingerprint: this.dependencies.getModelFingerprint
        },
        {
          sourcePreference: job.request.sourceLang ?? 'auto',
          targetPreference: job.request.targetLang ?? 'auto'
        },
        job.request.mode ?? 'translation'
      )
      if (job.cancelled) {
        this.emitCompleted(job, requestDocumentTaskCancellation(job.task))
        return
      }
      job.task = result.task
      job.source = result.source
      job.translation = result.translation
      job.languageResolution = result.languageResolution
      job.completionReport = result.completionReport
      job.failedTargetIds = result.failedTargetIds ?? result.completionReport?.failedTargetIds ?? []
      job.retryableTargetIds = result.retryableTargetIds ?? job.failedTargetIds
      this.emitCompleted(job, result.task)
    } catch (error) {
      if (job.cancelled || job.controller.signal.aborted) {
        this.emitCompleted(job, requestDocumentTaskCancellation(job.task))
        return
      }
      const embeddedTask = error && typeof error === 'object' && 'task' in error
        ? (error as { task?: DocumentTaskState }).task
        : undefined
      job.task = embeddedTask ?? failDocumentTask(job.task, errorCode(error, 'run-failed'))
      this.emitCompleted(job, job.task)
    }
  }

  /**
   * 执行失败目标重试，并在完成后推送同一任务的新代际终态。
   * @param job 当前任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async retry(job: ActiveDocumentJob, retryableTargetIds: readonly string[]): Promise<void> {
    const source = job.source
    const translation = job.translation
    const languageResolution = job.languageResolution
    if (!source || !translation || !languageResolution) {
      job.task = failDocumentTask(job.task, 'not-ready')
      this.emitCompleted(job, job.task)
      return
    }
    let previousTranslation: DocumentModel | undefined
    let retryCompleted = 0
    let retryTotal = retryableTargetIds.length
    try {
      const result = await retryFailedDocumentTranslationPipeline(
        source,
        translation,
        retryableTargetIds,
        job.task,
        job.controller.signal,
        {
          parse: async () => source,
          loadAssetBytes: (asset) => this.loadAsset(job, asset),
          recognizeImage: (bytes, signal) => this.dependencies.recognizeImage(bytes, signal),
          translate: (text, signal, languagePair, onDelta) =>
            this.dependencies.translate(text, signal, job.request, languagePair, onDelta),
          onProgress: (state) => {
            if (job.cancelled || job.settled) return
            if (state.phase === 'translate') {
              retryCompleted = state.progress.completed
              retryTotal = state.progress.total
            }
            job.task = state
            this.emitProgress(job, state)
          },
          publishTranslation: (nextTranslation) => {
            if (job.cancelled || job.settled || job.controller.signal.aborted) return
            job.translation = nextTranslation
            if (previousTranslation) {
              this.emitTranslationUpdates(
                job,
                previousTranslation,
                nextTranslation,
                retryCompleted,
                retryTotal
              )
            }
            previousTranslation = nextTranslation
            this.emitProgress(job, job.task)
          },
          concurrency: this.dependencies.getTranslationConcurrency?.(),
          ocrConcurrency: this.dependencies.getOcrConcurrency?.(),
          getModelFingerprint: this.dependencies.getModelFingerprint
        },
        languageResolution
      )
      if (job.cancelled) {
        this.emitCompleted(job, requestDocumentTaskCancellation(job.task))
        return
      }
      job.task = result.task
      job.source = result.source
      job.translation = result.translation
      job.languageResolution = result.languageResolution ?? languageResolution
      job.completionReport = result.completionReport
      job.failedTargetIds = result.failedTargetIds ?? result.completionReport?.failedTargetIds ?? []
      job.retryableTargetIds = result.retryableTargetIds ?? job.failedTargetIds
      this.emitCompleted(job, result.task)
    } catch (error) {
      if (job.cancelled || job.controller.signal.aborted) {
        this.emitCompleted(job, requestDocumentTaskCancellation(job.task))
        return
      }
      const embeddedTask = error && typeof error === 'object' && 'task' in error
        ? (error as { task?: DocumentTaskState }).task
        : undefined
      job.task = embeddedTask ?? failDocumentTask(job.task, errorCode(error, 'run-failed'))
      this.emitCompleted(job, job.task)
    }
  }

  /**
   * 读取资源字节，优先使用任务缓存，再读取受控包内路径。
   * @param job 当前任务。
   * @param asset 资源模型。
   * @returns 资源字节或 null。
   * @author zhenghq
   */
  private async loadAsset(job: ActiveDocumentJob, asset: DocumentAsset): Promise<Uint8Array | null> {
    const cached = job.assetBytes.get(asset.assetId)
    if (cached) return cached
    if (this.dependencies.loadAssetBytes) {
      const loaded = await this.dependencies.loadAssetBytes(asset, job.input)
      if (loaded) {
        job.assetBytes.set(asset.assetId, loaded)
        return loaded
      }
    }
    if (!asset.storageKey || (job.input.format !== 'docx' && job.input.format !== 'epub')) return null
    const storageKey = normalizePackagePath(asset.storageKey)
    if (!storageKey) return null
    const packageInfo = await loadSafeDocumentPackage(job.input)
    const bytes = await readPackageBytes(packageInfo, storageKey)
    if (bytes) job.assetBytes.set(asset.assetId, bytes)
    return bytes
  }

  /**
   * 构造带源文档与译文的界面快照。
   * @param job 当前任务。
   * @param task 当前任务状态。
   * @returns 可安全发送给 Renderer 的快照。
   * @author zhenghq
   */
  private snapshot(job: ActiveDocumentJob, task: DocumentTaskState): DocumentWorkspaceSnapshot {
    const retryableTargetIds = this.resolveRetryableTargetIds(job)
    const completionStatus = this.resolveCompletionStatus(job)
    const effectiveTask = completionStatus ? { ...task, status: completionStatus } : task
    return {
      jobId: job.jobId,
      generation: job.generation,
      runMode: job.request.mode ?? 'translation',
      task: { ...effectiveTask, progress: { ...effectiveTask.progress } },
      percent: calculateDocumentTaskProgress(effectiveTask),
      ...(job.source ? { source: job.source } : {}),
      ...(job.translation ? { translation: job.translation } : {}),
      ...(job.languageResolution ? {
        sourcePreference: job.languageResolution.sourcePreference,
        targetPreference: job.languageResolution.targetPreference,
        languagePair: job.languageResolution.languagePair
      } : {}),
      ...(job.completionReport ? { completionReport: job.completionReport } : {}),
      ...(retryableTargetIds.length > 0
        ? { retryableFailedBlocks: retryableTargetIds.length }
        : {}),
      ...(effectiveTask.errorCode ? { errorCode: effectiveTask.errorCode } : {})
    }
  }

  /**
   * 读取与当前任务标识和代际严格匹配的完成报告状态。
   * @param job 当前任务；尚未创建时省略。
   * @returns 同代际完成报告状态；没有有效报告时返回 undefined。
   * @author zhenghq
   */
  private resolveCompletionStatus(
    job: ActiveDocumentJob | null | undefined
  ): DocumentCompletionReport['status'] | undefined {
    const report = job?.completionReport
    if (!job || !report || report.jobId !== job.jobId || report.generation !== job.generation) {
      return undefined
    }
    return report.status
  }

  /**
   * 解析当前任务需要重试的目标；完整完成报告优先，旧版冗余数组仅作兼容兜底。
   * @param job 当前任务；尚未创建时省略。
   * @returns 去重且保持稳定顺序的可重试目标标识。
   * @author zhenghq
   */
  private resolveRetryableTargetIds(job: ActiveDocumentJob | null | undefined): string[] {
    if (!job) return []
    const fromReport = collectRetryableDocumentTargetIds(job.completionReport)
    const candidates = fromReport.length > 0 ? fromReport : job.retryableTargetIds
    return [...new Set(candidates)]
  }

  /**
   * 推送运行中进度。
   * @param job 当前任务。
   * @param task 当前状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitProgress(job: ActiveDocumentJob, task: DocumentTaskState): void {
    if (this.disposed || this.active !== job) return
    const incoming = this.snapshot(job, task)
    const accepted = job.lastSnapshot
      ? selectDocumentWorkspaceSnapshot(job.lastSnapshot, incoming)
      : incoming
    if (accepted === job.lastSnapshot) return
    job.lastSnapshot = accepted
    this.dependencies.sendProgress(accepted)
  }

  /**
   * 比较前后两份译文快照并推送发生变化的顶层区块。
   * 仅发送当前未取消、未终结任务的区块，避免迟到结果覆盖新任务或终态。
   * @param job 当前任务。
   * @param previous 上一次已推送的译文快照。
   * @param current 当前最新译文快照。
   * @param completed 当前翻译阶段已完成目标数。
   * @param total 当前翻译阶段目标总数。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitTranslationUpdates(
    job: ActiveDocumentJob,
    previous: DocumentModel,
    current: DocumentModel,
    completed: number,
    total: number
  ): void {
    if (!this.dependencies.sendTranslationUpdate || job.cancelled || job.settled ||
      job.controller.signal.aborted || this.active !== job) {
      return
    }
    const previousPages = new Map(previous.pages.map((page) => [page.pageId, page]))
    for (const page of current.pages) {
      const previousPage = previousPages.get(page.pageId)
      if (!previousPage) continue
      const previousBlocks = new Map(previousPage.blocks.map((block) => [block.blockId, block]))
      for (const block of page.blocks) {
        const previousBlock = previousBlocks.get(block.blockId)
        if (!previousBlock || JSON.stringify(previousBlock) === JSON.stringify(block)) continue
        this.dependencies.sendTranslationUpdate({
          jobId: job.jobId,
          generation: job.generation,
          pageId: page.pageId,
          blockId: block.blockId,
          block,
          completed,
          total: Math.max(1, total)
        })
      }
    }
  }

  /**
   * 推送终态事件；同一任务只发送一次。
   * @param job 当前任务。
   * @param task 当前状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitCompleted(job: ActiveDocumentJob, task: DocumentTaskState): void {
    if (this.disposed || this.active !== job || job.settled) return
    job.settled = true
    job.task = task
    const incoming = this.snapshot(job, task)
    const accepted = job.lastSnapshot
      ? selectDocumentWorkspaceSnapshot(job.lastSnapshot, incoming)
      : incoming
    if (accepted === job.lastSnapshot) return
    job.lastSnapshot = accepted
    this.dependencies.sendCompleted(accepted)
  }
}
