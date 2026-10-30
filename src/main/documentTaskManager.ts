import type {
  DocumentAssetResult,
  DocumentExportRequest,
  DocumentExportResult,
  DocumentRunRequest,
  DocumentRunResult,
  DocumentSourceResult,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../shared/documentWorkspace.ts'

/** 会话向任务管理器上报事件的受控上下文。 */
export interface DocumentTaskSessionContext {
  /** 上报运行中快照。 */
  sendProgress(snapshot: DocumentWorkspaceSnapshot): void
  /** 上报可立即渲染的单个译文区块。 */
  sendTranslationUpdate(update: DocumentWorkspaceTranslationUpdate): void
  /** 上报终态快照。 */
  sendCompleted(snapshot: DocumentWorkspaceSnapshot): void
}

/** 文档任务会话对外暴露的最小生命周期契约。 */
export interface DocumentTaskSession {
  /** 接受并启动一次文档任务。 */
  run(request: DocumentRunRequest): Promise<DocumentRunResult>
  /** 使用更高代际重试当前任务。 */
  retryFailed(generation: number): DocumentRunResult
  /** 取消精确匹配的任务代际。 */
  cancel(jobId: string, generation: number): boolean
  /** 导出当前任务 PDF。 */
  exportPdf(request: DocumentExportRequest): Promise<DocumentExportResult>
  /** 读取当前任务资源。 */
  getAsset(assetId: string): Promise<DocumentAssetResult>
  /** 读取当前任务源文件。 */
  getSource(): Promise<DocumentSourceResult>
  /** 释放会话持有的 worker 与资源。 */
  dispose(): void
}

/** 会话工厂；任务管理器通过上下文过滤迟到事件。 */
export type DocumentTaskSessionFactory = (
  context: DocumentTaskSessionContext
) => DocumentTaskSession

/** 任务管理器依赖。 */
export interface DocumentTaskManagerDependencies {
  /** 为新一代际创建独立 worker 会话。 */
  createSession: DocumentTaskSessionFactory
  /** 转发当前任务的运行中快照。 */
  sendProgress?(snapshot: DocumentWorkspaceSnapshot): void
  /** 转发当前任务的块级译文增量。 */
  sendTranslationUpdate?(update: DocumentWorkspaceTranslationUpdate): void
  /** 转发当前任务的终态快照。 */
  sendCompleted?(snapshot: DocumentWorkspaceSnapshot): void
}

/** 任务管理器记录的当前任务。 */
interface CurrentTask {
  /** 当前任务标识。 */
  jobId: string
  /** 当前任务代际。 */
  generation: number
  /** 承载当前任务的会话。 */
  session: DocumentTaskSession
  /** 是否已经成功发送取消请求。 */
  cancelRequested: boolean
}

/** 会话接受前暂存的进度或终态事件。 */
interface PendingSnapshotEvent {
  /** 事件类型。 */
  type: 'progress' | 'completed'
  /** 待过滤的快照。 */
  snapshot: DocumentWorkspaceSnapshot
}

/** 会话接受前暂存的块级译文事件。 */
interface PendingTranslationEvent {
  /** 事件类型。 */
  type: 'block-translated'
  /** 待过滤的块级增量。 */
  update: DocumentWorkspaceTranslationUpdate
}

/** 会话接受前暂存的事件联合类型。 */
type PendingEvent = PendingSnapshotEvent | PendingTranslationEvent

/**
 * 文档任务生命周期管理器，负责会话切换、任务代际和迟到事件隔离。
 * @author zhenghq
 */
export class DocumentTaskManager {
  private readonly dependencies: DocumentTaskManagerDependencies
  private current: CurrentTask | null = null
  private highestGeneration = 0
  private starting = false
  private startingSession: DocumentTaskSession | null = null
  private disposed = false

  /**
   * 创建任务管理器。
   * @param dependencies 会话工厂与 IPC 事件发送能力。
   * @author zhenghq
   */
  constructor(dependencies: DocumentTaskManagerDependencies) {
    this.dependencies = dependencies
  }

  /**
   * 创建或切换文档任务；同代际重复启动返回 busy，旧代际返回冲突。
   * @param request Renderer 发起且已由主进程校验的任务请求。
   * @returns 任务接受结果与 jobId，或稳定拒绝分类。
   * @author zhenghq
   */
  async run(request: DocumentRunRequest): Promise<DocumentRunResult> {
    if (this.disposed) return { accepted: false, code: 'service-disposed' }
    if (!this.isValidRunRequest(request)) return { accepted: false, code: 'invalid-request' }
    if (this.starting) return { accepted: false, code: 'busy' }
    if (request.generation <= this.highestGeneration) {
      if (request.generation === this.highestGeneration) {
        return { accepted: false, code: 'busy' }
      }
      return {
        accepted: false,
        code: 'generation-conflict',
        suggestedGeneration: this.highestGeneration + 1
      }
    }

    this.starting = true
    this.releaseCurrentTask()
    const pending: PendingEvent[] = []
    try {
      const session = this.dependencies.createSession({
        sendProgress: (snapshot) => {
          if (!this.current) pending.push({ type: 'progress', snapshot })
          else this.forwardSnapshot('progress', snapshot)
        },
        sendTranslationUpdate: (update) => {
          if (!this.current) pending.push({ type: 'block-translated', update })
          else this.forwardTranslationUpdate(update)
        },
        sendCompleted: (snapshot) => {
          if (!this.current) pending.push({ type: 'completed', snapshot })
          else this.forwardSnapshot('completed', snapshot)
        }
      })
      this.startingSession = session

      let result: DocumentRunResult
      try {
        result = await session.run(request)
      } catch {
        if (this.startingSession === session) {
          this.startingSession = null
          session.dispose()
        }
        return { accepted: false, code: 'worker-unavailable' }
      }
      if (this.disposed || !result.accepted || !result.jobId) {
        if (this.startingSession === session) {
          this.startingSession = null
          session.dispose()
        }
        return this.disposed ? { accepted: false, code: 'service-disposed' } : result
      }

      this.startingSession = null
      this.current = {
        jobId: result.jobId,
        generation: request.generation,
        session,
        cancelRequested: false
      }
      this.highestGeneration = request.generation
      for (const event of pending) {
        if (event.type === 'block-translated') {
          this.forwardTranslationUpdate(event.update)
        } else {
          this.forwardSnapshot(event.type, event.snapshot)
        }
      }
      return result
    } catch {
      return { accepted: false, code: 'worker-unavailable' }
    } finally {
      this.startingSession = null
      this.starting = false
    }
  }

  /**
   * 使用更高代际重试当前任务的失败目标。
   * @param generation Renderer 生成的新任务代际。
   * @returns 重试接受结果或稳定拒绝分类。
   * @author zhenghq
   */
  retryFailed(generation: number): DocumentRunResult {
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
    const task = this.current
    if (!task) return { accepted: false, code: 'not-ready' }
    let result: DocumentRunResult
    try {
      result = task.session.retryFailed(generation)
    } catch {
      return { accepted: false, code: 'worker-unavailable' }
    }
    if (!result.accepted || !result.jobId) return result
    task.generation = generation
    task.jobId = result.jobId
    task.cancelRequested = false
    this.highestGeneration = generation
    return result
  }

  /**
   * 取消当前任务；只有 jobId 与代际精确匹配且尚未取消时生效。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否实际向会话发出了取消请求。
   * @author zhenghq
   */
  cancel(jobId: string, generation: number): boolean {
    const task = this.current
    if (this.disposed || !task || task.jobId !== jobId ||
      task.generation !== generation || task.cancelRequested) return false
    let sent: boolean
    try {
      sent = task.session.cancel(jobId, generation)
    } catch {
      return false
    }
    if (sent) task.cancelRequested = true
    return sent
  }

  /**
   * 导出当前任务 PDF。
   * @param request 导出请求。
   * @returns 导出结果；当前任务不匹配时返回 completion-mismatch。
   * @author zhenghq
   */
  async exportPdf(request: DocumentExportRequest): Promise<DocumentExportResult> {
    const task = this.current
    if (this.disposed) return { status: 'rejected', code: 'service-disposed' }
    if (!task || request.jobId !== task.jobId || request.generation !== task.generation) {
      return { status: 'rejected', code: 'completion-mismatch' }
    }
    try {
      return await task.session.exportPdf(request)
    } catch {
      return { status: 'rejected', code: 'export-failed' }
    }
  }

  /**
   * 读取当前任务资源。
   * @param assetId 受控资源标识。
   * @returns 资源读取结果。
   * @author zhenghq
   */
  async getAsset(assetId: string): Promise<DocumentAssetResult> {
    if (this.disposed || !this.current) return { ok: false, code: 'asset-not-found' }
    try {
      return await this.current.session.getAsset(assetId)
    } catch {
      return { ok: false, code: 'asset-unavailable' }
    }
  }

  /**
   * 读取当前任务源文件。
   * @returns 源文件读取结果。
   * @author zhenghq
   */
  async getSource(): Promise<DocumentSourceResult> {
    if (this.disposed || !this.current) return { ok: false, code: 'source-not-found' }
    try {
      return await this.current.session.getSource()
    } catch {
      return { ok: false, code: 'source-unavailable' }
    }
  }

  /**
   * 读取当前任务标识与代际，不暴露会话内部对象。
   * @returns 当前任务摘要；没有活动任务时返回 null。
   * @author zhenghq
   */
  currentTask(): { jobId: string; generation: number } | null {
    const task = this.current
    return task ? { jobId: task.jobId, generation: task.generation } : null
  }

  /**
   * 接收运行中快照并丢弃非当前任务或已释放状态的事件。
   * @param snapshot 待转发的快照。
   * @returns 是否已转发。
   * @author zhenghq
   */
  handleProgress(snapshot: DocumentWorkspaceSnapshot): boolean {
    return this.forwardSnapshot('progress', snapshot)
  }

  /**
   * 接收终态快照并丢弃非当前任务或已释放状态的事件。
   * @param snapshot 待转发的快照。
   * @returns 是否已转发。
   * @author zhenghq
   */
  handleCompleted(snapshot: DocumentWorkspaceSnapshot): boolean {
    return this.forwardSnapshot('completed', snapshot)
  }

  /**
   * 接收块级译文增量并丢弃非当前任务或已释放状态的事件。
   * @param update 待转发的块级增量。
   * @returns 是否已转发。
   * @author zhenghq
   */
  handleTranslationUpdate(update: DocumentWorkspaceTranslationUpdate): boolean {
    return this.forwardTranslationUpdate(update)
  }

  /**
   * 取消并释放当前会话；重复调用无副作用。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const startingSession = this.startingSession
    this.startingSession = null
    if (startingSession) {
      try {
        startingSession.dispose()
      } catch {
        // 启动中的会话可能尚未接受任务，仍必须释放 worker。
      }
    }
    this.releaseCurrentTask()
  }

  /**
   * 取消并释放旧任务，确保切换文件时旧 worker 不再存活。
   * @returns 无返回值。
   * @author zhenghq
   */
  private releaseCurrentTask(): void {
    const task = this.current
    if (!task) return
    this.current = null
    if (!task.cancelRequested) {
      try {
        task.session.cancel(task.jobId, task.generation)
      } catch {
        // 会话已失效时仍必须继续释放资源。
      }
    }
    try {
      task.session.dispose()
    } catch {
      // 释放失败不能阻止后续会话创建或窗口关闭。
    }
  }

  /**
   * 校验运行请求的最小安全字段；路径授权由具体会话负责。
   * @param request 未信任请求。
   * @returns 请求结构是否合法。
   * @author zhenghq
   */
  private isValidRunRequest(request: DocumentRunRequest): boolean {
    return Boolean(request) && typeof request === 'object' &&
      typeof request.path === 'string' && request.path.trim().length > 0 &&
      Number.isInteger(request.generation) && request.generation >= 1 &&
      (request.mode === undefined || request.mode === 'ocr' || request.mode === 'translation') &&
      (request.sourceLang === undefined || typeof request.sourceLang === 'string') &&
      (request.targetLang === undefined || typeof request.targetLang === 'string')
  }

  /**
   * 仅转发属于当前 jobId 与代际的快照。
   * @param type 事件类型。
   * @param snapshot 待过滤快照。
   * @returns 是否已转发。
   * @author zhenghq
   */
  private forwardSnapshot(type: PendingSnapshotEvent['type'], snapshot: DocumentWorkspaceSnapshot): boolean {
    const task = this.current
    if (this.disposed || !task || !snapshot || snapshot.jobId !== task.jobId ||
      snapshot.generation !== task.generation) return false
    if (type === 'progress') {
      this.dependencies.sendProgress?.(snapshot)
    } else {
      this.dependencies.sendCompleted?.(snapshot)
    }
    return true
  }

  /**
   * 仅转发属于当前 jobId 与代际的块级译文增量。
   * @param update 待过滤的块级增量。
   * @returns 是否已转发。
   * @author zhenghq
   */
  private forwardTranslationUpdate(update: DocumentWorkspaceTranslationUpdate): boolean {
    const task = this.current
    if (this.disposed || !task || !update || update.jobId !== task.jobId ||
      update.generation !== task.generation) return false
    this.dependencies.sendTranslationUpdate?.(update)
    return true
  }
}
