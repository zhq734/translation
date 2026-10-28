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
  DocumentAssetResult,
  DocumentExportResult,
  DocumentRunRequest,
  DocumentRunResult,
  DocumentSourceResult,
  DocumentWorkspaceSnapshot
} from '../shared/documentWorkspace.ts'
import type { OcrRecognizeResult } from '../shared/ocrEngine.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
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
  /** 推送最终完成、部分完成、取消或失败快照。 */
  sendCompleted(snapshot: DocumentWorkspaceSnapshot): void
  /** 解析完整文档；第二个参数用于登记 PDF 等解析期生成的资源字节，第三个参数用于传递取消信号。 */
  parse(
    input: DocumentParseInput,
    registerAssetBytes?: (assetId: string, bytes: Uint8Array) => void,
    signal?: AbortSignal
  ): Promise<DocumentModel>
  /** 翻译单段文本，并通过 onDelta 推送当前片段的增量译文。 */
  translate(
    text: string,
    signal: AbortSignal,
    request: DocumentRunRequest,
    onDelta?: (delta: string) => void
  ): Promise<string>
  /** 识别图片文字。 */
  recognizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<OcrRecognizeResult>
  /** 读取解析器未直接缓存的资源字节。 */
  loadAssetBytes?(asset: DocumentAsset, input: DocumentParseInput): Promise<Uint8Array | null>
  /** 读取可嵌入 PDF 的 CJK 字体。 */
  loadFontBytes(): Promise<Uint8Array | null>
  /** 将译文模型导出为 PDF。 */
  exportPdf(model: DocumentModel, dependencies: {
    loadFontBytes(): Promise<Uint8Array | null>
    loadAssetBytes(assetId: string): Promise<Uint8Array | null>
  }): Promise<DocumentPdfExportResult>
  /** 显示 PDF 保存对话框。 */
  showSaveDialog(suggestedName: string): Promise<DocumentSaveDialogResult>
  /** 将 PDF 字节写入用户选择的位置。 */
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /**
   * 读取页面翻译使用的并发数，供文档批量翻译复用同一用户配置。
   * @returns 页面翻译并发数。
   * @author zhenghq
   */
  getTranslationConcurrency?(): number
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
  /** 最近一次翻译阶段失败、可再次请求的目标标识。 */
  failedTargetIds: string[]
  /** 资源字节缓存。 */
  assetBytes: Map<string, Uint8Array>
  /** 取消后是否允许迟到结果覆盖终态。 */
  cancelled: boolean
  /** 完成事件是否已经发送。 */
  settled: boolean
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
    if (this.starting || !job || !job.settled || job.task.status !== 'partial') {
      return { accepted: false, code: 'not-ready' }
    }
    if (!job.source || !job.translation || job.failedTargetIds.length === 0) {
      return { accepted: false, code: 'no-retryable-failures' }
    }

    job.generation = generation
    job.task = {
      ...createDocumentTaskState(job.jobId, generation),
      phase: 'translate',
      status: 'translating',
      progress: { completed: 0, total: job.failedTargetIds.length }
    }
    job.controller = new AbortController()
    job.cancelled = false
    job.settled = false
    this.highestGeneration = generation
    this.emitProgress(job, job.task)
    void this.retry(job)
    return { accepted: true, jobId: job.jobId }
  }

  /**
   * 读取当前任务模型中的图片资源；只允许已解析资源标识。
   * @param assetId 资源标识。
   * @returns 受控资源读取结果。
   * @author zhenghq
   */
  async getAsset(assetId: string): Promise<DocumentAssetResult> {
    const job = this.active
    if (!job || typeof assetId !== 'string' || !assetId || assetId.includes('/') || assetId.includes('\\') || assetId.includes('..')) {
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
   * 读取当前活动 PDF 或 HTML 任务的原始文件字节，供 Renderer 使用原生能力预览。
   * 不返回本地路径，其他格式统一返回 source-not-found。
   * @returns 受控源文件读取结果。
   * @author zhenghq
   */
  getSource(): DocumentSourceResult {
    const job = this.active
    if (!job) return { ok: false, code: 'source-not-found' }
    if (job.input.format === 'html') {
      return {
        ok: true,
        mimeType: 'text/html; charset=utf-8',
        bytes: new Uint8Array(job.input.bytes)
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
   * 将当前译文模型导出为 PDF，并交给用户选择保存位置。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  async exportPdf(): Promise<DocumentExportResult> {
    const job = this.active
    if (!job || !job.translation || job.cancelled) return { status: 'rejected', code: 'not-ready' }
    try {
      const save = await this.dependencies.showSaveDialog(
        `${job.input.fileName.replace(/\.[^.]+$/u, '')}-translated.pdf`
      )
      if (save.canceled || !save.filePath) return { status: 'cancelled' }
      const result = await this.dependencies.exportPdf(job.translation, {
        loadFontBytes: () => this.dependencies.loadFontBytes(),
        loadAssetBytes: async (assetId) => {
          const asset = job.translation?.assets.find((candidate) => candidate.assetId === assetId)
          return asset ? this.loadAsset(job, asset) : null
        }
      })
      await this.dependencies.writeFile(save.filePath, result.bytes)
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
    this.disposed = true
    this.active?.controller.abort()
    this.active = null
  }

  /**
   * 执行解析、OCR、翻译和版面合成。
   * @param job 当前任务。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async process(job: ActiveDocumentJob): Promise<void> {
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
          translate: (text, signal, onDelta) =>
            this.dependencies.translate(text, signal, job.request, onDelta),
          publishTranslation: (translation) => {
            if (job.cancelled || job.settled || job.controller.signal.aborted) return
            job.translation = translation
            this.emitProgress(job, job.task)
          },
          onProgress: (state) => {
            if (job.cancelled || job.settled) return
            job.task = state
            this.emitProgress(job, state)
          },
          concurrency: this.dependencies.getTranslationConcurrency?.()
        }
      )
      if (job.cancelled) {
        this.emitCompleted(job, requestDocumentTaskCancellation(job.task))
        return
      }
      job.task = result.task
      job.source = result.source
      job.translation = result.translation
      job.failedTargetIds = result.failedTargetIds ?? []
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
  private async retry(job: ActiveDocumentJob): Promise<void> {
    const source = job.source
    const translation = job.translation
    if (!source || !translation) {
      job.task = failDocumentTask(job.task, 'not-ready')
      this.emitCompleted(job, job.task)
      return
    }
    try {
      const result = await retryFailedDocumentTranslationPipeline(
        source,
        translation,
        job.failedTargetIds,
        job.task,
        job.controller.signal,
        {
          parse: async () => source,
          loadAssetBytes: (asset) => this.loadAsset(job, asset),
          recognizeImage: (bytes, signal) => this.dependencies.recognizeImage(bytes, signal),
          translate: (text, signal, onDelta) =>
            this.dependencies.translate(text, signal, job.request, onDelta),
          publishTranslation: (nextTranslation) => {
            if (job.cancelled || job.settled || job.controller.signal.aborted) return
            job.translation = nextTranslation
            this.emitProgress(job, job.task)
          },
          onProgress: (state) => {
            if (job.cancelled || job.settled) return
            job.task = state
            this.emitProgress(job, state)
          },
          concurrency: this.dependencies.getTranslationConcurrency?.()
        }
      )
      if (job.cancelled) {
        this.emitCompleted(job, requestDocumentTaskCancellation(job.task))
        return
      }
      job.task = result.task
      job.source = result.source
      job.translation = result.translation
      job.failedTargetIds = result.failedTargetIds ?? []
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
    return {
      jobId: job.jobId,
      generation: job.generation,
      task: { ...task, progress: { ...task.progress } },
      percent: calculateDocumentTaskProgress(task),
      ...(job.source ? { source: job.source } : {}),
      ...(job.translation ? { translation: job.translation } : {}),
      ...(job.failedTargetIds.length > 0
        ? { retryableFailedBlocks: job.failedTargetIds.length }
        : {}),
      ...(task.errorCode ? { errorCode: task.errorCode } : {})
    }
  }

  /**
   * 推送运行中进度。
   * @param job 当前任务。
   * @param task 当前状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitProgress(job: ActiveDocumentJob, task: DocumentTaskState): void {
    this.dependencies.sendProgress(this.snapshot(job, task))
  }

  /**
   * 推送终态事件；同一任务只发送一次。
   * @param job 当前任务。
   * @param task 当前状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private emitCompleted(job: ActiveDocumentJob, task: DocumentTaskState): void {
    if (job.settled) return
    job.settled = true
    job.task = task
    this.dependencies.sendCompleted(this.snapshot(job, task))
  }
}
