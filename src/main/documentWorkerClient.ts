import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  parseDocumentWorkerAssetResult,
  parseDocumentWorkerRequest,
  parseDocumentWorkerResponse,
  type DocumentWorkerAssetResultMessage,
  type DocumentWorkerRequestMessage,
  type DocumentWorkerResponseMessage
} from '../shared/documentWorkerProtocol.ts'
import { isDocumentWorkerTranslationRpcMessage } from './documentWorkerTranslationRpc.ts'

/** utility process 的最小可注入接口，便于测试生命周期与消息校验。 */
export interface DocumentWorkerProcess {
  /** 向 worker 发送请求。 */
  postMessage(message: unknown): void
  /** 订阅 worker 消息或退出事件。 */
  on(event: 'message', listener: (message: unknown) => void): void
  /** 订阅 worker 退出事件。 */
  on(event: 'exit', listener: (code: number) => void): void
  /** 取消 worker 消息或退出订阅。 */
  off(event: 'message', listener: (message: unknown) => void): void
  /** 取消 worker 退出订阅。 */
  off(event: 'exit', listener: (code: number) => void): void
  /** 终止 worker。 */
  kill(): boolean
}

/** worker 客户端回调。 */
export interface DocumentWorkerClientOptions {
  /** 接收通过协议校验且属于当前任务的消息。 */
  onMessage(message: DocumentWorkerResponseMessage): void
  /** 接收通过协议校验且属于当前任务代际的资源结果。 */
  onAssetResult?(message: DocumentWorkerAssetResultMessage): void
  /** 接收 worker 内部或协议错误分类。 */
  onError?(code: string): void
}

/** 当前允许接收响应的任务代际。 */
interface ActiveWorkerTask {
  /** 任务标识。 */
  jobId: string
  /** 任务代际。 */
  generation: number
  /** 是否已收到终态。 */
  settled: boolean
  /** 是否已发送取消请求，等待 worker 回送取消终态。 */
  cancelRequested: boolean
}

/**
 * 主进程到文档 utility process 的受控消息客户端。
 * @author zhenghq
 */
export class DocumentWorkerClient {
  private active: ActiveWorkerTask | null = null
  private disposed = false
  private readonly messageListener: (message: unknown) => void
  private readonly exitListener: (code: number) => void

  /**
   * 创建 worker 客户端并订阅进程事件。
   * @param process utility process 或测试替身。
   * @param options 消息与错误回调。
   * @author zhenghq
   */
  constructor(
    private readonly process: DocumentWorkerProcess,
    private readonly options: DocumentWorkerClientOptions
  ) {
    this.messageListener = (message) => this.handleMessage(message)
    this.exitListener = (code) => this.handleExit(code)
    process.on('message', this.messageListener)
    process.on('exit', this.exitListener)
  }

  /**
   * 校验并发送一条 worker 请求。
   * @param message 候选请求。
   * @returns 是否已发送。
   * @author zhenghq
   */
  send(message: unknown): boolean {
    if (this.disposed) return false
    const request = parseDocumentWorkerRequest(message)
    if (!request) {
      this.reportError('invalid-request')
      return false
    }
    if (request.type === 'cancel') {
      if (!this.isCurrent(request.jobId, request.generation)) return false
    } else if (request.type === 'asset-request') {
      if (!this.isCurrent(request.jobId, request.generation)) return false
    } else {
      this.active = {
        jobId: request.jobId,
        generation: request.generation,
        settled: false,
        cancelRequested: false
      }
    }
    try {
      this.process.postMessage(request)
      return true
    } catch {
      this.reportError('worker-unavailable')
      return false
    }
  }

  /**
   * 取消当前任务；重复取消不重复发送。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否发送了取消请求。
   * @author zhenghq
   */
  cancel(jobId: string, generation: number): boolean {
    if (this.disposed || !this.isCurrent(jobId, generation)) return false
    const active = this.active
    if (!active || active.settled || active.cancelRequested) return false
    const sent = this.send({
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      jobId,
      generation
    } as DocumentWorkerRequestMessage)
    if (sent) active.cancelRequested = true
    return sent
  }

  /**
   * 停止接收消息并终止 worker；重复调用无副作用。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = null
    this.process.off('message', this.messageListener)
    this.process.off('exit', this.exitListener)
    this.process.kill()
  }

  /**
   * 校验并过滤 worker 响应，终态后丢弃迟到进度。
   * @param value 未信任消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleMessage(value: unknown): void {
    if (this.disposed) return
    if (isDocumentWorkerTranslationRpcMessage(value)) return
    const assetResult = parseDocumentWorkerAssetResult(value)
    if (assetResult) {
      if (this.isCurrent(assetResult.jobId, assetResult.generation)) {
        this.options.onAssetResult?.(assetResult)
      }
      return
    }
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'asset-result') {
      this.reportError('invalid-response')
      return
    }
    const response = parseDocumentWorkerResponse(value)
    if (!response) {
      this.reportError('invalid-response')
      return
    }
    if (!this.isCurrent(response.jobId, response.generation)) return
    const active = this.active
    if (!active || active.settled) return
    if (response.type === 'progress' || response.type === 'export-progress' ||
      response.type === 'translation-snapshot' || response.type === 'translation-update') {
      this.options.onMessage(response)
      return
    }
    active.settled = true
    this.options.onMessage(response)
  }

  /**
   * 处理 worker 退出并通知当前任务失败。
   * @param code 进程退出码。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleExit(code: number): void {
    if (this.disposed) return
    const active = this.active
    if (active && !active.settled) {
      active.settled = true
      this.options.onMessage({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'failure',
        jobId: active.jobId,
        generation: active.generation,
        payload: {
          code: 'worker-exited',
          message: 'worker operation failed'
        }
      })
    }
    this.reportError(code === 0 ? 'worker-exited' : 'worker-crashed')
  }

  /**
   * 判断任务标识与代际是否匹配当前活动任务。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否匹配。
   * @author zhenghq
   */
  private isCurrent(jobId: string, generation: number): boolean {
    return this.active?.jobId === jobId && this.active.generation === generation
  }

  /**
   * 调用可选错误回调。
   * @param code 稳定错误分类。
   * @returns 无返回值。
   * @author zhenghq
   */
  private reportError(code: string): void {
    this.options.onError?.(code)
  }
}
