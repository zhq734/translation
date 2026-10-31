import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  createDocumentWorkerAssetRequestMessage,
  type DocumentWorkerAssetResultMessage,
  type DocumentWorkerExportRequestMessage,
  type DocumentWorkerResponseMessage
} from '../shared/documentWorkerProtocol.ts'
import {
  calculateDocumentTaskProgress,
  completeDocumentTask,
  createDocumentTaskState,
  failDocumentTask,
  markDocumentTaskPartial,
  requestDocumentTaskCancellation,
  type DocumentTaskState
} from '../shared/documentTask.ts'
import {
  collectRetryableDocumentTargetIds,
  selectDocumentWorkspaceSnapshot
} from '../shared/documentCompletion.ts'
import type { DocumentLanguagePair } from '../shared/documentLanguageDirection.ts'
import type {
  DocumentAssetResult,
  DocumentExportProgress,
  DocumentExportRequest,
  DocumentExportResult,
  DocumentRunRequest,
  DocumentRunResult,
  DocumentSourceResult,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../shared/documentWorkspace.ts'
import {
  applyDocumentWorkspaceTranslationUpdate,
  createDocumentExportProgress
} from '../shared/documentWorkspace.ts'
import {
  DocumentWorkerClient,
  type DocumentWorkerProcess
} from './documentWorkerClient.ts'
import {
  DocumentWorkerTranslationRpcHost,
  type DocumentWorkerTranslationRpcRequest
} from './documentWorkerTranslationRpc.ts'
import type { DocumentWorkerStartOptions } from './documentWorkerProductionEntry.ts'
import { writeDocumentFileAtomically } from './documentAtomicFile.ts'

/** 保存对话框结果；由主进程注入，避免 Session 静态依赖 Electron。 */
export interface DocumentWorkerSaveDialogResult {
  /** 用户是否取消保存。 */
  canceled: boolean
  /** 用户选择的保存路径。 */
  filePath?: string
}

/** 文档 worker Session 的主进程依赖。 */
export interface DocumentWorkerSessionDependencies {
  /** 判断路径是否已由当前文档窗口批准。 */
  isApprovedPath(path: string): boolean
  /** 创建 utility process。 */
  createProcess(path: string): DocumentWorkerProcess
  /** 返回不含凭据的 worker 启动配置。 */
  startOptions(): DocumentWorkerStartOptions
  /** 推送运行中快照。 */
  sendProgress(snapshot: DocumentWorkspaceSnapshot): void
  /** 推送终态快照。 */
  sendCompleted(snapshot: DocumentWorkspaceSnapshot): void
  /** 推送可立即渲染的单个译文区块。 */
  sendTranslationUpdate?(update: DocumentWorkspaceTranslationUpdate): void
  /** 推送受控 PDF 导出进度。 */
  sendExportProgress?(progress: DocumentExportProgress): void
  /** 在系统文件管理器中定位最近一次成功导出的文件。 */
  openExportFolder?(filePath: string): Promise<void>
  /** 使用主进程凭据执行流式翻译。 */
  translate(
    request: DocumentWorkerTranslationRpcRequest,
    signal: AbortSignal,
    onDelta: (delta: string) => void
  ): Promise<string>
  /** 显示 PDF 保存对话框。 */
  showSaveDialog(suggestedName: string): Promise<DocumentWorkerSaveDialogResult>
  /** 将 PDF 字节写入用户选择的位置。 */
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** 将已完成的临时 PDF 原子替换为目标文件。 */
  rename(source: string, target: string): Promise<void>
  /** 清理写入或替换失败时遗留的临时文件。 */
  unlink(path: string): Promise<void>
  /** 读取主进程已缓存的资源字节。 */
  getAssetBytes(assetId: string): Promise<Uint8Array | null>
  /** 读取当前任务的源文件字节。 */
  getSourceBytes(): Promise<DocumentSourceResult>
}

/** Session 当前任务的最小状态。 */
interface SessionJob {
  /** 任务标识。 */
  jobId: string
  /** 当前代际。 */
  generation: number
  /** 最近一次接受的快照。 */
  snapshot: DocumentWorkspaceSnapshot
  /** 是否已收到终态。 */
  settled: boolean
  /** 导出请求等待器。 */
  exportRequest: PendingExport | null
  /** 本代际最近一次成功导出的文件路径。 */
  lastExportPath?: string
}

/** 当前等待 worker 返回的导出请求。 */
interface PendingExport {
  /** 对应任务标识。 */
  jobId: string
  /** 对应任务代际。 */
  generation: number
  /** 完成导出 Promise。 */
  resolve(result: DocumentExportResult): void
}

/** 当前等待 worker 返回的资源请求。 */
interface PendingAsset {
  /** 对应任务标识。 */
  jobId: string
  /** 对应任务代际。 */
  generation: number
  /** 对应资源标识。 */
  assetId: string
  /** 请求成功时返回 MIME 与字节，失败时返回稳定分类。 */
  resolve(result: DocumentAssetResult): void
}

/**
 * 主进程文档 worker 会话，负责进程生命周期、消息转换、翻译 RPC 与文件保存。
 * @author zhenghq
 */
export class DocumentWorkerSession {
  private readonly process: DocumentWorkerProcess
  private readonly client: DocumentWorkerClient
  private readonly translationHost: DocumentWorkerTranslationRpcHost
  private active: SessionJob | null = null
  private readonly pendingAssets = new Map<string, PendingAsset>()
  private highestGeneration = 0
  private disposed = false

  /**
   * 创建并启动 worker 会话。
   * @param dependencies 主进程注入依赖。
   * @author zhenghq
   */
  constructor(private readonly dependencies: DocumentWorkerSessionDependencies) {
    const moduleDirectory = typeof __dirname === 'string'
      ? __dirname
      : fileURLToPath(new URL('.', import.meta.url))
    this.process = dependencies.createProcess(join(moduleDirectory, 'documentWorker.js'))
    this.client = new DocumentWorkerClient(this.process, {
      onMessage: (message) => this.handleResponse(message),
      onAssetResult: (message) => this.handleAssetResult(message)
    })
    this.translationHost = new DocumentWorkerTranslationRpcHost(this.process, {
      isCurrent: (jobId, generation) => this.isCurrent(jobId, generation),
      translate: (request, signal, onDelta) => dependencies.translate(request, signal, onDelta)
    })
    this.process.postMessage({
      type: 'worker-start',
      options: dependencies.startOptions()
    })
  }

  /**
   * 接受并启动一次文档任务。
   * @param request Renderer 请求。
   * @returns 接受结果与任务标识。
   * @author zhenghq
   */
  async run(request: DocumentRunRequest): Promise<DocumentRunResult> {
    if (this.disposed) return { accepted: false, code: 'service-disposed' }
    if (!this.isValidRunRequest(request)) return { accepted: false, code: 'invalid-request' }
    if (request.generation <= this.highestGeneration) {
      return {
        accepted: false,
        code: 'generation-conflict',
        suggestedGeneration: this.highestGeneration + 1
      }
    }
    this.rejectPendingAssets('asset-unavailable')
    const jobId = randomUUID()
    const snapshot = this.createSnapshot(jobId, request.generation, createDocumentTaskState(jobId, request.generation))
    this.active = {
      jobId,
      generation: request.generation,
      snapshot,
      settled: false,
      exportRequest: null
    }
    this.highestGeneration = request.generation
    this.dependencies.sendProgress(snapshot)
    const sent = this.client.send({
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'run',
      jobId,
      generation: request.generation,
      request
    })
    if (!sent) {
      this.active = null
      return { accepted: false, code: 'worker-unavailable' }
    }
    return { accepted: true, jobId }
  }

  /**
   * 使用新代际重试当前任务的失败目标。
   * @param generation 新代际。
   * @returns 接受结果与任务标识。
   * @author zhenghq
   */
  retryFailed(generation: number): DocumentRunResult {
    if (this.disposed) return { accepted: false, code: 'service-disposed' }
    const job = this.active
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
    if (!job || !job.settled || !job.snapshot.source || !job.snapshot.translation ||
      !job.snapshot.languagePair) {
      return { accepted: false, code: 'not-ready' }
    }
    if ((job.snapshot.runMode ?? 'translation') === 'ocr') {
      return { accepted: false, code: 'no-retryable-failures' }
    }
    const retryableTargetIds = collectRetryableDocumentTargetIds(job.snapshot.completionReport)
    if (retryableTargetIds.length === 0) {
      return { accepted: false, code: 'no-retryable-failures' }
    }
    this.rejectPendingAssets('asset-unavailable')
    const request: DocumentRunRequest = {
      path: job.snapshot.source.source.path,
      generation,
      ...(job.snapshot.sourcePreference ? { sourceLang: job.snapshot.sourcePreference } : {}),
      ...(job.snapshot.targetPreference ? { targetLang: job.snapshot.targetPreference } : {}),
      ...(job.snapshot.runMode ? { mode: job.snapshot.runMode } : {})
    }
    const task = {
      ...createDocumentTaskState(job.jobId, generation),
      phase: 'translate' as const,
      status: 'translating' as const,
      progress: { completed: 0, total: retryableTargetIds.length }
    }
    const snapshot = this.createSnapshot(job.jobId, generation, task, {
      source: job.snapshot.source,
      translation: job.snapshot.translation,
      sourcePreference: job.snapshot.sourcePreference,
      targetPreference: job.snapshot.targetPreference,
      languagePair: job.snapshot.languagePair,
      runMode: job.snapshot.runMode
    })
    job.generation = generation
    job.snapshot = snapshot
    job.settled = false
    job.exportRequest = null
    job.lastExportPath = undefined
    this.highestGeneration = generation
    this.dependencies.sendProgress(snapshot)
    const sent = this.client.send({
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'retry',
      jobId: job.jobId,
      generation,
      request
    })
    return sent
      ? { accepted: true, jobId: job.jobId }
      : { accepted: false, code: 'worker-unavailable' }
  }

  /**
   * 请求取消当前任务。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否实际发送了取消请求。
   * @author zhenghq
   */
  cancel(jobId: string, generation: number): boolean {
    if (this.disposed || !this.isCurrent(jobId, generation)) return false
    const job = this.active
    if (!job || job.settled) return false
    const sent = this.client.cancel(jobId, generation)
    if (sent) {
      this.translationHost.cancelTask(jobId, generation)
      job.snapshot = this.createSnapshot(jobId, generation,
        requestDocumentTaskCancellation(job.snapshot.task), this.snapshotMetadata(job.snapshot))
      job.settled = true
      this.dependencies.sendCompleted(job.snapshot)
    }
    return sent
  }

  /**
   * 请求 worker 导出当前终态模型，并在主进程保存 PDF。
   * @param request 导出请求。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  async exportPdf(request: DocumentExportRequest): Promise<DocumentExportResult> {
    if (this.disposed) return { status: 'rejected', code: 'service-disposed' }
    if (!request || typeof request !== 'object' || typeof request.jobId !== 'string' ||
      !request.jobId.trim() || !Number.isInteger(request.generation) || request.generation < 1 ||
      (request.mode !== 'complete' && request.mode !== 'partial')) {
      return { status: 'rejected', code: 'invalid-request' }
    }
    const job = this.active
    if (!job || !job.settled || !job.snapshot.translation) {
      return { status: 'rejected', code: 'not-ready' }
    }
    if (!this.isCurrent(request.jobId, request.generation)) {
      return { status: 'rejected', code: 'completion-mismatch' }
    }
    if (!job.snapshot.completionReport) {
      return { status: 'rejected', code: 'completion-mismatch' }
    }
    if (job.exportRequest) return { status: 'rejected', code: 'export-in-progress' }
    const result = new Promise<DocumentExportResult>((resolve) => {
      job.exportRequest = { jobId: job.jobId, generation: job.generation, resolve }
    })
    const message: DocumentWorkerExportRequestMessage = {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'export',
      jobId: job.jobId,
      generation: job.generation,
      request: {
        mode: request.mode,
        layout: request.layout === 'bilingual' ? 'bilingual' : 'translation',
        ...(request.textLayer !== undefined ? { textLayer: request.textLayer } : {}),
        completionReport: job.snapshot.completionReport,
        ...(request.mode === 'partial' ? { confirmPartialExport: true } : {})
      }
    }
    if (!this.client.send(message)) {
      job.exportRequest = null
      return { status: 'rejected', code: 'worker-unavailable' }
    }
    return result
  }

  /**
   * 取消当前正在执行的 PDF 导出，不改变已完成任务的终态快照。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否向 worker 发送了取消请求。
   * @author zhenghq
   */
  cancelExport(jobId: string, generation: number): boolean {
    if (this.disposed || !this.isCurrent(jobId, generation)) return false
    const pending = this.active?.exportRequest
    if (!pending || pending.jobId !== jobId || pending.generation !== generation) return false
    return this.client.cancel(jobId, generation)
  }

  /**
   * 打开当前任务本会话最近一次成功导出的文件所在目录。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否成功调用系统文件管理器。
   * @author zhenghq
   */
  async openExportFolder(jobId: string, generation: number): Promise<boolean> {
    if (this.disposed || !this.isCurrent(jobId, generation)) return false
    const job = this.active
    if (!job?.lastExportPath || !this.dependencies.openExportFolder) return false
    try {
      await this.dependencies.openExportFolder(job.lastExportPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 读取当前任务已声明的资源字节。
   * @param assetId 资源标识。
   * @returns 受控资源结果。
   * @author zhenghq
   */
  async getAsset(assetId: string): Promise<DocumentAssetResult> {
    if (this.disposed || !this.isValidAssetId(assetId)) {
      return { ok: false, code: 'asset-not-found' }
    }
    const job = this.active
    const asset = job?.snapshot.source?.assets.find((candidate) => candidate.assetId === assetId) ??
      job?.snapshot.translation?.assets.find((candidate) => candidate.assetId === assetId)
    if (!job || !asset) return { ok: false, code: 'asset-not-found' }

    let cachedBytes: Promise<Uint8Array | null>
    try {
      cachedBytes = this.dependencies.getAssetBytes(assetId)
    } catch {
      cachedBytes = Promise.reject(new Error('asset cache read failed'))
    }
    const request = this.requestAsset(job, assetId)
    try {
      const bytes = await cachedBytes
      if (bytes) {
        this.pendingAssets.delete(request.requestId)
        return {
          ok: true,
          ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
          bytes
        }
      }
      const workerResult = await request.result
      if (workerResult.ok) return workerResult
      return {
        ok: false,
        code: workerResult.code === 'asset-unavailable' ? 'asset-unavailable' : 'asset-not-found'
      }
    } catch {
      this.pendingAssets.delete(request.requestId)
      return { ok: false, code: 'asset-unavailable' }
    }
  }

  /**
   * 读取当前任务源文件。
   * @returns 源文件字节或稳定错误分类。
   * @author zhenghq
   */
  async getSource(): Promise<DocumentSourceResult> {
    if (this.disposed || !this.active) return { ok: false, code: 'source-not-found' }
    try {
      return await this.dependencies.getSourceBytes()
    } catch {
      return { ok: false, code: 'source-unavailable' }
    }
  }

  /**
   * 释放翻译宿主、worker 客户端与进程；重复调用无副作用。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rejectPendingAssets('asset-unavailable')
    this.rejectPendingExport()
    this.translationHost.dispose()
    this.client.dispose()
    this.active = null
  }

  /**
   * 向 worker 请求已声明资源并等待匹配 requestId 的结果。
   * @param job 当前任务。
   * @param assetId 已声明资源标识。
   * @returns 请求标识与等待结果；调用方可在缓存命中时按标识丢弃等待。
   * @author zhenghq
   */
  private requestAsset(job: SessionJob, assetId: string): {
    requestId: string
    result: Promise<DocumentAssetResult>
  } {
    const requestId = randomUUID()
    const result = new Promise<DocumentAssetResult>((resolve) => {
      this.pendingAssets.set(requestId, {
        jobId: job.jobId,
        generation: job.generation,
        assetId,
        resolve
      })
      const sent = this.client.send(createDocumentWorkerAssetRequestMessage(
        job.jobId,
        job.generation,
        requestId,
        assetId
      ))
      if (!sent) {
        this.pendingAssets.delete(requestId)
        resolve({ ok: false, code: 'asset-unavailable' })
      }
    })
    return { requestId, result }
  }

  /**
   * 将资源结果关联到唯一 pending 请求；不匹配的结果直接丢弃。
   * @param message 已校验资源结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleAssetResult(message: DocumentWorkerAssetResultMessage): void {
    if (this.disposed) return
    const pending = this.pendingAssets.get(message.requestId)
    if (!pending || pending.jobId !== message.jobId ||
      pending.generation !== message.generation || pending.assetId !== message.assetId) return
    this.pendingAssets.delete(message.requestId)
    if (message.bytes) {
      pending.resolve({
        ok: true,
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
        bytes: message.bytes
      })
      return
    }
    pending.resolve({
      ok: false,
      code: message.code === 'asset-unavailable' ? 'asset-unavailable' : 'asset-not-found'
    })
  }

  /**
   * 以稳定分类拒绝所有等待中的资源请求。
   * @param code 稳定错误分类。
   * @returns 无返回值。
   * @author zhenghq
   */
  private rejectPendingAssets(code: 'asset-not-found' | 'asset-unavailable'): void {
    for (const pending of this.pendingAssets.values()) {
      pending.resolve({ ok: false, code })
    }
    this.pendingAssets.clear()
  }

  /**
   * 以稳定分类结束尚未完成的导出请求，避免关闭窗口后 Promise 永久悬挂。
   * @returns 无返回值。
   * @author zhenghq
   */
  private rejectPendingExport(): void {
    const pending = this.active?.exportRequest
    if (!pending) return
    this.active!.exportRequest = null
    pending.resolve({ status: 'rejected', code: 'service-disposed' })
  }

  /**
   * 处理 worker 响应并转换为工作台快照。
   * @param message 已校验响应。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleResponse(message: DocumentWorkerResponseMessage): void {
    const job = this.active
    if (!job || job.jobId !== message.jobId || job.generation !== message.generation) return
    if (message.type === 'export-progress') {
      if (!job.exportRequest) return
      this.dependencies.sendExportProgress?.(createDocumentExportProgress(
        message.jobId,
        message.generation,
        message.payload
      ))
      return
    }
    if (message.type === 'cancelled' && job.exportRequest) {
      const pending = job.exportRequest
      job.exportRequest = null
      pending.resolve({ status: 'cancelled' })
      return
    }
    // 导出是终态后的独立命令，其响应仍必须交付给等待中的导出 Promise。
    if (message.type === 'result' && message.payload.export) {
      void this.finishExport(job, message.payload.export)
      return
    }
    if (job.settled) return
    if (message.type === 'progress') {
      const task: DocumentTaskState = {
        ...job.snapshot.task,
        phase: message.payload.phase,
        status: this.statusForPhase(message.payload.phase),
        progress: {
          completed: message.payload.completed,
          total: message.payload.total
        },
        warningCount: message.payload.warningCount ?? job.snapshot.task.warningCount
      }
      const snapshot = this.createSnapshot(job.jobId, job.generation, task, {
        ...this.snapshotMetadata(job.snapshot),
        percent: message.payload.percent
      })
      const accepted = selectDocumentWorkspaceSnapshot(job.snapshot, snapshot)
      if (accepted === job.snapshot) return
      job.snapshot = accepted
      this.dependencies.sendProgress(accepted)
      return
    }
    if (message.type === 'translation-snapshot') {
      const payload = message.payload
      const task: DocumentTaskState = {
        ...job.snapshot.task,
        phase: 'translate',
        status: 'translating',
        ...(payload.completed !== undefined || payload.total !== undefined
          ? {
              progress: {
                completed: payload.completed ?? job.snapshot.task.progress.completed,
                total: payload.total ?? job.snapshot.task.progress.total
              }
            }
          : {})
      }
      const snapshot = this.createSnapshot(job.jobId, job.generation, task, {
        ...this.snapshotMetadata(job.snapshot),
        source: payload.source,
        translation: payload.translation,
        ...(payload.languageResolution?.sourcePreference !== undefined
          ? { sourcePreference: payload.languageResolution.sourcePreference }
          : {}),
        ...(payload.languageResolution?.targetPreference !== undefined
          ? { targetPreference: payload.languageResolution.targetPreference }
          : {}),
        ...(payload.languageResolution?.languagePair
          ? { languagePair: payload.languageResolution.languagePair }
          : {})
      })
      job.snapshot = snapshot
      this.dependencies.sendProgress(snapshot)
      return
    }
    if (message.type === 'translation-update') {
      const update: DocumentWorkspaceTranslationUpdate = {
        jobId: message.jobId,
        generation: message.generation,
        ...message.payload
      }
      const snapshot = applyDocumentWorkspaceTranslationUpdate(job.snapshot, update)
      if (snapshot === job.snapshot) return
      job.snapshot = snapshot
      this.dependencies.sendTranslationUpdate?.(update)
      this.dependencies.sendProgress(snapshot)
      return
    }
    if (message.type === 'result') {
      const payload = message.payload
      const task = this.terminalTask(job.snapshot.task, payload.status, payload.percent, payload.errorCode)
      const snapshot = this.createSnapshot(job.jobId, job.generation, task, {
        percent: payload.percent,
        source: payload.source,
        translation: payload.translation,
        sourcePreference: payload.languageResolution?.sourcePreference,
        targetPreference: payload.languageResolution?.targetPreference,
        languagePair: payload.languageResolution?.languagePair,
        completionReport: payload.completionReport,
        retryableFailedBlocks: payload.retryableTargetIds?.length,
        runMode: payload.runMode,
        errorCode: payload.errorCode
      })
      const accepted = selectDocumentWorkspaceSnapshot(job.snapshot, snapshot)
      job.snapshot = accepted
      job.settled = true
      this.dependencies.sendCompleted(accepted)
      return
    }
    if (message.type === 'failure') {
      const task = failDocumentTask(job.snapshot.task, message.payload.code)
      const snapshot = this.createSnapshot(job.jobId, job.generation, task, {
        ...this.snapshotMetadata(job.snapshot),
        errorCode: message.payload.code
      })
      job.snapshot = selectDocumentWorkspaceSnapshot(job.snapshot, snapshot)
      job.settled = true
      this.dependencies.sendCompleted(job.snapshot)
      return
    }
    const task = requestDocumentTaskCancellation(job.snapshot.task)
    const snapshot = this.createSnapshot(job.jobId, job.generation, task, this.snapshotMetadata(job.snapshot))
    job.snapshot = selectDocumentWorkspaceSnapshot(job.snapshot, snapshot)
    job.settled = true
    this.dependencies.sendCompleted(job.snapshot)
  }

  /**
   * 处理导出终态，显示保存对话框并写入 PDF。
   * @param job 当前任务。
   * @param payload worker 导出结果。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async finishExport(job: SessionJob, payload: NonNullable<
    Extract<DocumentWorkerResponseMessage, { type: 'result' }>['payload']['export']
  >): Promise<void> {
    const pending = job.exportRequest
    if (!pending) return
    job.exportRequest = null
    try {
      const save = await this.dependencies.showSaveDialog(this.suggestedExportName(job.snapshot))
      if (save.canceled || !save.filePath) {
        pending.resolve({ status: 'cancelled' })
        return
      }
      await writeDocumentFileAtomically(save.filePath, payload.bytes, {
        writeFile: (path, bytes) => this.dependencies.writeFile(path, bytes),
        rename: (source, target) => this.dependencies.rename(source, target),
        unlink: (path) => this.dependencies.unlink(path)
      })
      job.lastExportPath = save.filePath
      pending.resolve({
        status: 'saved',
        filePath: save.filePath,
        ...(payload.warnings.length > 0 ? { warnings: payload.warnings } : {})
      })
    } catch {
      pending.resolve({ status: 'rejected', code: 'write-failed' })
    }
  }

  /**
   * 创建带任务状态的快照。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @param task 任务状态。
   * @param metadata 可覆盖的快照字段。
   * @returns 工作台快照。
   * @author zhenghq
   */
  private createSnapshot(
    jobId: string,
    generation: number,
    task: DocumentTaskState,
    metadata: Partial<DocumentWorkspaceSnapshot> = {}
  ): DocumentWorkspaceSnapshot {
    const source = metadata.source
    const translation = metadata.translation
    const languagePair = metadata.languagePair
    return {
      jobId,
      generation,
      task: { ...task, progress: { ...task.progress } },
      percent: metadata.percent ?? calculateDocumentTaskProgress(task),
      ...(source ? { source } : {}),
      ...(translation ? { translation } : {}),
      ...(metadata.sourcePreference !== undefined ? { sourcePreference: metadata.sourcePreference } : {}),
      ...(metadata.targetPreference !== undefined ? { targetPreference: metadata.targetPreference } : {}),
      ...(languagePair ? { languagePair } : {}),
      ...(metadata.completionReport ? { completionReport: metadata.completionReport } : {}),
      ...(metadata.retryableFailedBlocks !== undefined
        ? { retryableFailedBlocks: metadata.retryableFailedBlocks }
        : {}),
      ...(metadata.runMode ? { runMode: metadata.runMode } : {}),
      ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {})
    }
  }

  /**
   * 从已有快照提取可复用的模型元数据。
   * @param snapshot 已有快照。
   * @returns 快照元数据。
   * @author zhenghq
   */
  private snapshotMetadata(snapshot: DocumentWorkspaceSnapshot): Partial<DocumentWorkspaceSnapshot> {
    return {
      ...(snapshot.source ? { source: snapshot.source } : {}),
      ...(snapshot.translation ? { translation: snapshot.translation } : {}),
      ...(snapshot.sourcePreference ? { sourcePreference: snapshot.sourcePreference } : {}),
      ...(snapshot.targetPreference ? { targetPreference: snapshot.targetPreference } : {}),
      ...(snapshot.languagePair ? { languagePair: snapshot.languagePair } : {}),
      ...(snapshot.completionReport ? { completionReport: snapshot.completionReport } : {}),
      ...(snapshot.retryableFailedBlocks !== undefined
        ? { retryableFailedBlocks: snapshot.retryableFailedBlocks }
        : {}),
      ...(snapshot.runMode ? { runMode: snapshot.runMode } : {})
    }
  }

  /**
   * 根据 worker 终态创建任务状态。
   * @param current 当前任务状态。
   * @param status worker 终态。
   * @param percent 总进度。
   * @param errorCode 失败分类。
   * @returns 终态任务状态。
   * @author zhenghq
   */
  private terminalTask(
    current: DocumentTaskState,
    status: 'completed' | 'partial' | 'failed',
    percent: number,
    errorCode?: string
  ): DocumentTaskState {
    if (status === 'completed') {
      return completeDocumentTask(current, {
        failedBlocks: 0,
        warningCount: current.warningCount
      })
    }
    if (status === 'partial') {
      return {
        ...markDocumentTaskPartial(current, {
          failedBlocks: 0,
          warningCount: current.warningCount
        }),
        phase: 'translate',
        progress: { completed: percent, total: 100 }
      }
    }
    return failDocumentTask(current, errorCode ?? 'worker-failed')
  }

  /**
   * 把 worker 阶段映射为任务运行状态。
   * @param phase worker 阶段。
   * @returns 对应运行状态。
   * @author zhenghq
   */
  private statusForPhase(phase: DocumentTaskState['phase']): DocumentTaskState['status'] {
    if (phase === 'validate') return 'validating'
    if (phase === 'parse') return 'parsing'
    if (phase === 'ocr') return 'ocr'
    if (phase === 'translate') return 'translating'
    if (phase === 'layout') return 'rendering'
    return 'exporting'
  }

  /**
   * 判断任务标识与代际是否匹配当前活动任务。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否匹配。
   * @author zhenghq
   */
  private isCurrent(jobId: string, generation: number): boolean {
    return Boolean(this.active && this.active.jobId === jobId && this.active.generation === generation)
  }

  /**
   * 校验运行请求。
   * @param request 未信任请求。
   * @returns 是否合法且路径已批准。
   * @author zhenghq
   */
  private isValidRunRequest(request: DocumentRunRequest): boolean {
    return Boolean(request) && typeof request === 'object' &&
      typeof request.path === 'string' && request.path.trim().length > 0 &&
      Number.isInteger(request.generation) && request.generation >= 1 &&
      (request.mode === undefined || request.mode === 'ocr' || request.mode === 'translation') &&
      (request.sourceLang === undefined || typeof request.sourceLang === 'string') &&
      (request.targetLang === undefined || typeof request.targetLang === 'string') &&
      this.dependencies.isApprovedPath(request.path)
  }

  /**
   * 校验资源标识，不接受路径片段。
   * @param assetId 未信任资源标识。
   * @returns 是否为受控标识。
   * @author zhenghq
   */
  private isValidAssetId(assetId: string): boolean {
    return typeof assetId === 'string' && assetId.length > 0 && assetId.length <= 128 &&
      !assetId.includes('/') && !assetId.includes('\\') && !assetId.includes('..') &&
      !assetId.includes('\u0000')
  }

  /**
   * 从源文件名推导 PDF 保存名称。
   * @param snapshot 当前终态快照。
   * @returns 安全的建议文件名。
   * @author zhenghq
   */
  private suggestedExportName(snapshot: DocumentWorkspaceSnapshot): string {
    const fileName = snapshot.source?.source.fileName ?? 'document'
    const base = fileName.replace(/\.[^.]+$/u, '').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    return `${base || 'document'}.pdf`
  }
}
