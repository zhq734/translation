import type { DocumentLanguagePair } from '../shared/documentLanguageDirection.ts'

/** worker 向主进程发起的翻译请求。 */
export interface DocumentWorkerTranslationRpcRequest {
  /** 消息类型。 */
  type: 'translation-request'
  /** 本次翻译请求标识。 */
  requestId: string
  /** 当前文档任务标识。 */
  jobId: string
  /** 当前文档任务代际。 */
  generation: number
  /** 待翻译文本。 */
  text: string
  /** 已冻结的语言对。 */
  languagePair: DocumentLanguagePair
}

/** worker 向主进程发送的翻译取消消息。 */
export interface DocumentWorkerTranslationRpcCancel {
  /** 消息类型。 */
  type: 'translation-cancel'
  /** 要取消的翻译请求标识。 */
  requestId: string
}

/** 主进程返回的翻译增量消息。 */
export interface DocumentWorkerTranslationRpcDelta {
  /** 消息类型。 */
  type: 'translation-delta'
  /** 对应翻译请求标识。 */
  requestId: string
  /** 可安全展示的译文增量。 */
  delta: string
}

/** 主进程返回的翻译成功消息。 */
export interface DocumentWorkerTranslationRpcResult {
  /** 消息类型。 */
  type: 'translation-result'
  /** 对应翻译请求标识。 */
  requestId: string
  /** 完整译文。 */
  translation: string
}

/** 主进程返回的脱敏翻译失败消息。 */
export interface DocumentWorkerTranslationRpcFailure {
  /** 消息类型。 */
  type: 'translation-failure'
  /** 对应翻译请求标识。 */
  requestId: string
  /** 稳定错误分类。 */
  code: string
}

/** 翻译 RPC 主进程响应联合类型。 */
export type DocumentWorkerTranslationRpcResponse =
  | DocumentWorkerTranslationRpcDelta
  | DocumentWorkerTranslationRpcResult
  | DocumentWorkerTranslationRpcFailure

/** 翻译 RPC 消息类型集合；用于与文档任务协议消息区分。 */
const DOCUMENT_WORKER_TRANSLATION_RPC_MESSAGE_TYPES = new Set([
  'translation-request',
  'translation-cancel',
  'translation-delta',
  'translation-result',
  'translation-failure'
])

/** worker 侧最小消息端口。 */
export interface DocumentWorkerTranslationRpcClientPort {
  /**
   * 发送请求。
   * @param message 已构造的 RPC 消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  postMessage(message: DocumentWorkerTranslationRpcRequest | DocumentWorkerTranslationRpcCancel): void
  /**
   * 订阅主进程消息。
   * @param event 固定消息事件。
   * @param listener 消息监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  on(event: 'message', listener: (message: unknown) => void): void
  /**
   * 注销主进程消息订阅。
   * @param event 固定消息事件。
   * @param listener 已注册的消息监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  off(event: 'message', listener: (message: unknown) => void): void
}

/** 主进程侧最小消息端口。 */
export interface DocumentWorkerTranslationRpcHostPort {
  /**
   * 订阅 worker 消息。
   * @param event 固定消息事件。
   * @param listener 消息监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  on(event: 'message', listener: (message: unknown) => void): void
  /**
   * 注销 worker 消息订阅。
   * @param event 固定消息事件。
   * @param listener 已注册的消息监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  off(event: 'message', listener: (message: unknown) => void): void
  /**
   * 向 worker 发送响应。
   * @param message 已构造的响应消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  postMessage(message: DocumentWorkerTranslationRpcResponse): void
}

/** 主进程 RPC 依赖。 */
export interface DocumentWorkerTranslationRpcHostDependencies {
  /**
   * 判断请求是否属于当前任务代际。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否为当前任务。
   * @author zhenghq
   */
  isCurrent(jobId: string, generation: number): boolean
  /**
   * 使用主进程凭据执行流式翻译。
   * @param request 已校验请求。
   * @param signal 取消信号。
   * @param onDelta 译文增量回调。
   * @returns 完整译文。
   * @author zhenghq
   */
  translate(
    request: DocumentWorkerTranslationRpcRequest,
    signal: AbortSignal,
    onDelta: (delta: string) => void
  ): Promise<string>
}

/** 客户端待处理翻译。 */
interface PendingTranslation {
  /** 完整译文完成函数。 */
  resolve(translation: string): void
  /** 失败完成函数。 */
  reject(error: Error): void
  /** 增量回调。 */
  onDelta: (delta: string) => void
  /** 取消信号清理函数。 */
  cleanup(): void
}

/** worker 翻译 RPC 客户端的非敏感运行时配置。 */
export interface DocumentWorkerTranslationRpcClientOptions {
  /** 主进程公开的翻译提供方与模型指纹。 */
  modelFingerprint: string
  /** 文档页面翻译并发数。 */
  translationConcurrency: number
}

/** 主进程活动翻译。 */
interface ActiveTranslation {
  /** 取消控制器。 */
  controller: AbortController
  /** 请求任务标识。 */
  jobId: string
  /** 请求任务代际。 */
  generation: number
  /** 是否已结束。 */
  settled: boolean
}

/**
 * 判断值是否为普通对象。
 * @param value 待检查值。
 * @returns 是否为普通对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 判断消息是否属于翻译 RPC 命名空间。
 * @param value 未信任消息。
 * @returns 是否为翻译 RPC 消息。
 * @author zhenghq
 */
export function isDocumentWorkerTranslationRpcMessage(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' &&
    DOCUMENT_WORKER_TRANSLATION_RPC_MESSAGE_TYPES.has(value.type)
}

/**
 * 判断是否为非空短字符串。
 * @param value 待检查值。
 * @returns 是否为合法标识。
 * @author zhenghq
 */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\u0000')
}

/**
 * 解析 worker 翻译请求。
 * @param value 未信任消息。
 * @returns 合法请求或 null。
 * @author zhenghq
 */
function parseTranslationRequest(value: unknown): DocumentWorkerTranslationRpcRequest | null {
  if (!isRecord(value) || value.type !== 'translation-request') return null
  const allowedKeys = new Set(['type', 'requestId', 'jobId', 'generation', 'text', 'languagePair'])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null
  if (!isRecord(value.languagePair)) return null
  const languagePairKeys = new Set(['sourceLang', 'targetLang'])
  if (Object.keys(value.languagePair).some((key) => !languagePairKeys.has(key))) return null
  if (!isIdentifier(value.requestId) || !isIdentifier(value.jobId) ||
    !Number.isInteger(value.generation) || Number(value.generation) < 1 ||
    typeof value.text !== 'string' || !value.text || value.text.length > 50_000 ||
    typeof value.languagePair.sourceLang !== 'string' ||
    typeof value.languagePair.targetLang !== 'string') return null
  return {
    type: 'translation-request',
    requestId: value.requestId,
    jobId: value.jobId,
    generation: Number(value.generation),
    text: value.text,
    languagePair: {
      sourceLang: value.languagePair.sourceLang,
      targetLang: value.languagePair.targetLang
    }
  }
}

/**
 * 解析 worker 翻译取消消息。
 * @param value 未信任消息。
 * @returns 合法取消消息或 null。
 * @author zhenghq
 */
function parseTranslationCancel(value: unknown): DocumentWorkerTranslationRpcCancel | null {
  if (!isRecord(value) || value.type !== 'translation-cancel' || !isIdentifier(value.requestId)) {
    return null
  }
  return { type: 'translation-cancel', requestId: value.requestId }
}

/**
 * 解析主进程翻译响应。
 * @param value 未信任消息。
 * @returns 合法响应或 null。
 * @author zhenghq
 */
function parseTranslationResponse(value: unknown): DocumentWorkerTranslationRpcResponse | null {
  if (!isRecord(value) || !isIdentifier(value.requestId)) return null
  if (value.type === 'translation-delta' && typeof value.delta === 'string') {
    return { type: value.type, requestId: value.requestId, delta: value.delta }
  }
  if (value.type === 'translation-result' && typeof value.translation === 'string') {
    return { type: value.type, requestId: value.requestId, translation: value.translation }
  }
  if (value.type === 'translation-failure' && isIdentifier(value.code)) {
    return { type: value.type, requestId: value.requestId, code: value.code }
  }
  return null
}

/**
 * 把未知错误转换为不含原始文本的稳定分类。
 * @param error 捕获异常。
 * @returns 稳定错误分类。
 * @author zhenghq
 */
function resolveRpcErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
    return 'cancelled'
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code) {
    return error.code.replace(/[^a-z0-9-]+/giu, '-').slice(0, 64) || 'translation-failed'
  }
  return 'translation-failed'
}

/**
 * 创建取消错误。
 * @returns AbortError。
 * @author zhenghq
 */
function createAbortError(): Error {
  const error = new Error('cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * worker 侧翻译 RPC 客户端，负责请求关联、增量转发和取消清理。
 * @author zhenghq
 */
export class DocumentWorkerTranslationRpcClient {
  private readonly pending = new Map<string, PendingTranslation>()
  private readonly listener: (message: unknown) => void
  private disposed = false
  private readonly options: DocumentWorkerTranslationRpcClientOptions

  /**
   * 创建客户端并订阅主进程响应。
   * @param port 父进程消息端口。
   * @param options 非敏感模型指纹与并发配置。
   * @author zhenghq
   */
  constructor(
    private readonly port: DocumentWorkerTranslationRpcClientPort,
    options: DocumentWorkerTranslationRpcClientOptions = {
      modelFingerprint: 'document-translation-model',
      translationConcurrency: 1
    }
  ) {
    this.options = { ...options }
    this.listener = (message) => this.handleMessage(message)
    port.on('message', this.listener)
  }

  /**
   * 获取主进程公开的翻译模型指纹。
   * @returns 不含凭据的模型指纹。
   * @author zhenghq
   */
  getModelFingerprint(): string {
    return this.options.modelFingerprint
  }

  /**
   * 获取文档页面翻译并发数。
   * @returns 已校验的正整数并发数。
   * @author zhenghq
   */
  getTranslationConcurrency(): number {
    return this.options.translationConcurrency
  }

  /**
   * 发起翻译请求并等待完整结果。
   * @param request 不含凭据的请求。
   * @param signal 取消信号。
   * @param onDelta 增量回调。
   * @returns 完整译文。
   * @author zhenghq
   */
  translate(
    request: DocumentWorkerTranslationRpcRequest,
    signal: AbortSignal,
    onDelta: (delta: string) => void = () => undefined
  ): Promise<string> {
    if (this.disposed) return Promise.reject(createAbortError())
    if (signal.aborted) return Promise.reject(createAbortError())
    if (this.pending.has(request.requestId)) {
      return Promise.reject(Object.assign(new Error('duplicate-request'), { code: 'duplicate-request' }))
    }
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.has(request.requestId)) return
        this.pending.delete(request.requestId)
        try {
          this.port.postMessage({ type: 'translation-cancel', requestId: request.requestId })
        } catch {
          // 端口已关闭时仍需结束本地等待，避免任务悬挂。
        }
        reject(createAbortError())
      }
      this.pending.set(request.requestId, {
        resolve,
        reject,
        onDelta,
        cleanup: () => signal.removeEventListener('abort', onAbort)
      })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.port.postMessage(request)
      } catch {
        const pending = this.pending.get(request.requestId)
        this.pending.delete(request.requestId)
        pending?.cleanup()
        reject(Object.assign(new Error('translation-rpc-unavailable'), { code: 'translation-rpc-unavailable' }))
      }
    })
  }

  /**
   * 释放全部等待并注销响应订阅。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.off('message', this.listener)
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(createAbortError())
    }
    this.pending.clear()
  }

  /**
   * 处理主进程响应，未知或已取消请求的消息直接丢弃。
   * @param value 未信任消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleMessage(value: unknown): void {
    if (this.disposed) return
    const response = parseTranslationResponse(value)
    if (!response) return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    if (response.type === 'translation-delta') {
      pending.onDelta(response.delta)
      return
    }
    this.pending.delete(response.requestId)
    pending.cleanup()
    if (response.type === 'translation-result') {
      pending.resolve(response.translation)
      return
    }
    pending.reject(Object.assign(new Error(response.code), { code: response.code }))
  }
}

/**
 * 主进程侧翻译 RPC 宿主，负责代际校验、增量转发和取消隔离。
 * @author zhenghq
 */
export class DocumentWorkerTranslationRpcHost {
  private readonly active = new Map<string, ActiveTranslation>()
  private readonly listener: (message: unknown) => void
  private disposed = false

  /**
   * 创建宿主并订阅 worker 请求。
   * @param port worker 消息端口。
   * @param dependencies 当前任务校验与翻译实现。
   * @author zhenghq
   */
  constructor(
    private readonly port: DocumentWorkerTranslationRpcHostPort,
    private readonly dependencies: DocumentWorkerTranslationRpcHostDependencies
  ) {
    this.listener = (message) => this.handleMessage(message)
    port.on('message', this.listener)
  }

  /**
   * 取消当前任务的全部翻译请求。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelTask(jobId: string, generation: number): void {
    for (const [requestId, active] of this.active) {
      if (active.jobId !== jobId || active.generation !== generation) continue
      this.active.delete(requestId)
      active.controller.abort()
    }
  }

  /**
   * 释放宿主并终止全部翻译。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.off('message', this.listener)
    for (const active of this.active.values()) active.controller.abort()
    this.active.clear()
  }

  /**
   * 分发一条 worker 消息。
   * @param value 未信任消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleMessage(value: unknown): void {
    if (this.disposed) return
    const cancel = parseTranslationCancel(value)
    if (cancel) {
      const active = this.active.get(cancel.requestId)
      if (active) {
        this.active.delete(cancel.requestId)
        active.controller.abort()
      }
      return
    }
    const request = parseTranslationRequest(value)
    if (!request) return
    void this.translate(request)
  }

  /**
   * 校验代际并执行一次翻译。
   * @param request 已解析请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async translate(request: DocumentWorkerTranslationRpcRequest): Promise<void> {
    if (this.active.has(request.requestId)) {
      this.sendFailure(request.requestId, 'duplicate-request')
      return
    }
    if (!this.dependencies.isCurrent(request.jobId, request.generation)) {
      this.sendFailure(request.requestId, 'generation-conflict')
      return
    }
    const active: ActiveTranslation = {
      controller: new AbortController(),
      jobId: request.jobId,
      generation: request.generation,
      settled: false
    }
    this.active.set(request.requestId, active)
    try {
      const translation = await this.dependencies.translate(request, active.controller.signal, (delta) => {
        if (active.settled || this.active.get(request.requestId) !== active) return
        this.port.postMessage({ type: 'translation-delta', requestId: request.requestId, delta })
      })
      if (active.settled || this.active.get(request.requestId) !== active) return
      active.settled = true
      this.active.delete(request.requestId)
      this.port.postMessage({ type: 'translation-result', requestId: request.requestId, translation })
    } catch (error) {
      if (active.settled || this.active.get(request.requestId) !== active) return
      active.settled = true
      this.active.delete(request.requestId)
      this.sendFailure(request.requestId, resolveRpcErrorCode(error))
    }
  }

  /**
   * 发送脱敏失败响应。
   * @param requestId 请求标识。
   * @param code 稳定错误分类。
   * @returns 无返回值。
   * @author zhenghq
   */
  private sendFailure(requestId: string, code: string): void {
    this.port.postMessage({ type: 'translation-failure', requestId, code })
  }
}
