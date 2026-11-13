import { randomUUID } from 'node:crypto'
import {
  DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
  type DocumentTranslationCacheEntry
} from '../shared/documentTranslation.ts'

/** 缓存 RPC 标识与键的最大长度。 */
const CACHE_RPC_IDENTIFIER_MAX_CHARS = 128
/** 缓存键最大长度。 */
const CACHE_RPC_KEY_MAX_CHARS = 4096
/** 单个缓存条目的最大序列化字节数，避免跨进程复制不可控载荷。 */
const CACHE_RPC_VALUE_MAX_BYTES = 1024 * 1024

/** worker 发往主进程的缓存读请求。 */
export interface DocumentWorkerCacheRpcReadRequest {
  /** 消息类型。 */
  type: 'cache-read-request'
  /** 本次请求标识。 */
  requestId: string
  /** 仅与本次请求匹配的响应令牌。 */
  responseToken: string
  /** 文档任务标识。 */
  jobId: string
  /** 文档任务代际。 */
  generation: number
  /** 完整翻译缓存键。 */
  key: string
}

/** worker 发往主进程的缓存写请求。 */
export interface DocumentWorkerCacheRpcWriteRequest {
  /** 消息类型。 */
  type: 'cache-write-request'
  /** 本次请求标识。 */
  requestId: string
  /** 仅与本次请求匹配的响应令牌。 */
  responseToken: string
  /** 文档任务标识。 */
  jobId: string
  /** 文档任务代际。 */
  generation: number
  /** 完整翻译缓存键。 */
  key: string
  /** 已完成的翻译缓存条目。 */
  value: DocumentTranslationCacheEntry
}

/** 主进程返回的缓存读取结果。 */
export interface DocumentWorkerCacheRpcReadResult {
  /** 消息类型。 */
  type: 'cache-read-result'
  /** 对应请求标识。 */
  requestId: string
  /** 原样回传的响应令牌。 */
  responseToken: string
  /** 命中条目或未命中。 */
  value: DocumentTranslationCacheEntry | null
}

/** 主进程返回的缓存写入结果。 */
export interface DocumentWorkerCacheRpcWriteResult {
  /** 消息类型。 */
  type: 'cache-write-result'
  /** 对应请求标识。 */
  requestId: string
  /** 原样回传的响应令牌。 */
  responseToken: string
  /** 是否写入成功。 */
  ok: boolean
}

/** 缓存 RPC 请求联合类型。 */
export type DocumentWorkerCacheRpcRequest =
  | DocumentWorkerCacheRpcReadRequest
  | DocumentWorkerCacheRpcWriteRequest

/** 缓存 RPC 响应联合类型。 */
export type DocumentWorkerCacheRpcResponse =
  | DocumentWorkerCacheRpcReadResult
  | DocumentWorkerCacheRpcWriteResult

/** worker 侧最小消息端口。 */
export interface DocumentWorkerCacheRpcClientPort {
  /**
   * 发送缓存请求。
   * @param message 已构造的请求消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  postMessage(message: DocumentWorkerCacheRpcRequest): void
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
export interface DocumentWorkerCacheRpcHostPort {
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
  postMessage(message: DocumentWorkerCacheRpcResponse): void
}

/** 主进程缓存 RPC 依赖。 */
export interface DocumentWorkerCacheRpcHostDependencies {
  /**
   * 判断请求是否仍属于当前任务代际。
   * @param jobId 文档任务标识。
   * @param generation 文档任务代际。
   * @returns 是否为当前任务。
   * @author zhenghq
   */
  isCurrent(jobId: string, generation: number): boolean
  /**
   * 读取主进程持久化缓存。
   * @param request 已校验读请求。
   * @returns 命中条目或未命中。
   * @author zhenghq
   */
  read(request: DocumentWorkerCacheRpcReadRequest): Promise<DocumentTranslationCacheEntry | null>
  /**
   * 写入主进程持久化缓存。
   * @param request 已校验写请求。
   * @returns 写入完成的 Promise。
   * @author zhenghq
   */
  write(request: DocumentWorkerCacheRpcWriteRequest): Promise<void>
}

/** worker 侧等待中的缓存请求。 */
interface PendingCacheRequest {
  /** 仅接受与该请求匹配的响应令牌。 */
  responseToken: string
  /** 请求完成函数。 */
  resolve(value: DocumentTranslationCacheEntry | null | boolean): void
  /** 请求失败函数。 */
  reject(error: Error): void
}

/** 缓存 RPC 全部消息类型。 */
const DOCUMENT_WORKER_CACHE_RPC_MESSAGE_TYPES = new Set([
  'cache-read-request',
  'cache-read-result',
  'cache-write-request',
  'cache-write-result'
])

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
 * 判断是否为不含控制字符的非空短标识。
 * @param value 待检查值。
 * @returns 是否为合法标识。
 * @author zhenghq
 */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= CACHE_RPC_IDENTIFIER_MAX_CHARS && !/[\u0000-\u001f\u007f]/u.test(value)
}

/**
 * 判断是否为缓存键。
 * @param value 待检查值。
 * @returns 是否为长度有效的非空键。
 * @author zhenghq
 */
function isCacheKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= CACHE_RPC_KEY_MAX_CHARS && !value.includes('\u0000')
}

/**
 * 判断是否为合法任务代际。
 * @param value 待检查值。
 * @returns 是否为正安全整数。
 * @author zhenghq
 */
function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * 判断对象是否只包含指定字段。
 * @param value 待检查对象。
 * @param allowedKeys 允许字段集合。
 * @returns 是否未包含未知字段。
 * @author zhenghq
 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

/**
 * 校验缓存条目结构与载荷大小。
 * @param value 未信任值。
 * @returns 是否为可安全跨进程传输的完成条目。
 * @author zhenghq
 */
function parseCacheValue(value: unknown): DocumentTranslationCacheEntry | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sourceSha256',
    'translationProtocolVersion',
    'languagePair',
    'glossaryVersion',
    'protectionRulesVersion',
    'status',
    'translation',
    'suspectUntranslated',
    'incomplete'
  ])) return null
  if (!isRecord(value.languagePair) || !hasOnlyKeys(value.languagePair, ['sourceLang', 'targetLang'])) {
    return null
  }
  if (!isIdentifier(value.sourceSha256) ||
    value.translationProtocolVersion !== DOCUMENT_TRANSLATION_PROTOCOL_VERSION ||
    typeof value.languagePair.sourceLang !== 'string' || !value.languagePair.sourceLang ||
    value.languagePair.sourceLang.length > 32 ||
    typeof value.languagePair.targetLang !== 'string' || !value.languagePair.targetLang ||
    value.languagePair.targetLang.length > 32 ||
    typeof value.glossaryVersion !== 'string' || value.glossaryVersion.length > 256 ||
    typeof value.protectionRulesVersion !== 'string' ||
    value.protectionRulesVersion.length > 128 ||
    value.status !== 'completed' ||
    typeof value.translation !== 'string' || !value.translation.trim() ||
    (value.suspectUntranslated !== undefined && value.suspectUntranslated !== false) ||
    (value.incomplete !== undefined && value.incomplete !== false)) return null
  const entry: DocumentTranslationCacheEntry = {
    sourceSha256: value.sourceSha256,
    translationProtocolVersion: DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
    languagePair: {
      sourceLang: value.languagePair.sourceLang,
      targetLang: value.languagePair.targetLang
    },
    glossaryVersion: value.glossaryVersion,
    protectionRulesVersion: value.protectionRulesVersion,
    status: 'completed',
    translation: value.translation
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
  return serializedBytes <= CACHE_RPC_VALUE_MAX_BYTES ? entry : null
}

/**
 * 解析缓存读请求。
 * @param value 未信任消息。
 * @returns 合法请求或 null。
 * @author zhenghq
 */
function parseReadRequest(value: unknown): DocumentWorkerCacheRpcReadRequest | null {
  if (!isRecord(value) || value.type !== 'cache-read-request' ||
    !hasOnlyKeys(value, ['type', 'requestId', 'responseToken', 'jobId', 'generation', 'key'])) return null
  if (!isIdentifier(value.requestId) || !isIdentifier(value.responseToken) || !isIdentifier(value.jobId) ||
    !isGeneration(value.generation) || !isCacheKey(value.key)) return null
  return {
    type: 'cache-read-request',
    requestId: value.requestId,
    responseToken: value.responseToken,
    jobId: value.jobId,
    generation: value.generation,
    key: value.key
  }
}

/**
 * 解析缓存写请求。
 * @param value 未信任消息。
 * @returns 合法请求或 null。
 * @author zhenghq
 */
function parseWriteRequest(value: unknown): DocumentWorkerCacheRpcWriteRequest | null {
  if (!isRecord(value) || value.type !== 'cache-write-request' ||
    !hasOnlyKeys(value, ['type', 'requestId', 'responseToken', 'jobId', 'generation', 'key', 'value'])) return null
  if (!isIdentifier(value.requestId) || !isIdentifier(value.responseToken) || !isIdentifier(value.jobId) ||
    !isGeneration(value.generation) || !isCacheKey(value.key)) return null
  const cacheValue = parseCacheValue(value.value)
  return cacheValue ? {
    type: 'cache-write-request',
    requestId: value.requestId,
    responseToken: value.responseToken,
    jobId: value.jobId,
    generation: value.generation,
    key: value.key,
    value: cacheValue
  } : null
}

/**
 * 解析主进程缓存响应。
 * @param value 未信任消息。
 * @returns 合法响应或 null。
 * @author zhenghq
 */
function parseResponse(value: unknown): DocumentWorkerCacheRpcResponse | null {
  if (!isRecord(value) || !isIdentifier(value.requestId) || !isIdentifier(value.responseToken)) return null
  if (value.type === 'cache-read-result' &&
    hasOnlyKeys(value, ['type', 'requestId', 'responseToken', 'value'])) {
    const parsedValue = value.value === null ? null : parseCacheValue(value.value)
    if (value.value !== null && !parsedValue) return null
    return {
      type: 'cache-read-result',
      requestId: value.requestId,
      responseToken: value.responseToken,
      value: parsedValue
    }
  }
  if (value.type === 'cache-write-result' &&
    hasOnlyKeys(value, ['type', 'requestId', 'responseToken', 'ok']) && typeof value.ok === 'boolean') {
    return {
      type: 'cache-write-result',
      requestId: value.requestId,
      responseToken: value.responseToken,
      ok: value.ok
    }
  }
  return null
}

/**
 * 创建请求中止错误。
 * @returns 名称为 AbortError 的错误。
 * @author zhenghq
 */
function createAbortError(): Error {
  const error = new Error('cache-rpc-disposed')
  error.name = 'AbortError'
  return error
}

/**
 * 判断消息是否属于缓存 RPC 命名空间。
 * @param value 未信任消息。
 * @returns 是否为缓存 RPC 消息。
 * @author zhenghq
 */
export function isDocumentWorkerCacheRpcMessage(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' &&
    DOCUMENT_WORKER_CACHE_RPC_MESSAGE_TYPES.has(value.type)
}

/**
 * worker 侧缓存 RPC 客户端，按 requestId 关联并发读写。
 * @author zhenghq
 */
export class DocumentWorkerCacheRpcClient {
  private readonly pending = new Map<string, PendingCacheRequest>()
  private readonly listener: (message: unknown) => void
  private disposed = false

  /**
   * 创建客户端并订阅主进程缓存结果。
   * @param port 父进程消息端口。
   * @author zhenghq
   */
  constructor(private readonly port: DocumentWorkerCacheRpcClientPort) {
    this.listener = (message) => this.handleMessage(message)
    port.on('message', this.listener)
  }

  /**
   * 读取当前任务的持久化缓存。
   * @param jobId 文档任务标识。
   * @param generation 文档任务代际。
   * @param key 完整缓存键。
   * @returns 命中条目；未命中、异常或已释放时返回 null。
   * @author zhenghq
   */
  read(jobId: string, generation: number, key: string): Promise<DocumentTranslationCacheEntry | null> {
    return this.request('cache-read-request', jobId, generation, key) as Promise<DocumentTranslationCacheEntry | null>
  }

  /**
   * 写入当前任务的持久化缓存。
   * @param jobId 文档任务标识。
   * @param generation 文档任务代际。
   * @param key 完整缓存键。
   * @param value 已完成缓存条目。
   * @returns 是否写入成功；异常或已释放时返回 false。
   * @author zhenghq
   */
  write(
    jobId: string,
    generation: number,
    key: string,
    value: DocumentTranslationCacheEntry
  ): Promise<boolean> {
    return this.request('cache-write-request', jobId, generation, key, value) as Promise<boolean>
  }

  /**
   * 释放等待中的请求并注销消息订阅。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.off('message', this.listener)
    for (const pending of this.pending.values()) pending.reject(createAbortError())
    this.pending.clear()
  }

  /**
   * 发送缓存请求并等待匹配结果。
   * @param type 请求类型。
   * @param jobId 文档任务标识。
   * @param generation 文档任务代际。
   * @param key 完整缓存键。
   * @param value 写请求缓存条目。
   * @returns 读请求返回条目或 null，写请求返回布尔值。
   * @author zhenghq
   */
  private request(
    type: 'cache-read-request' | 'cache-write-request',
    jobId: string,
    generation: number,
    key: string,
    value?: DocumentTranslationCacheEntry
  ): Promise<DocumentTranslationCacheEntry | null | boolean> {
    if (this.disposed) {
      return type === 'cache-read-request' ? Promise.resolve(null) : Promise.resolve(false)
    }
    if (!isIdentifier(jobId) || !isGeneration(generation) || !isCacheKey(key) ||
      (type === 'cache-write-request' && (!value || !parseCacheValue(value)))) {
      return type === 'cache-read-request' ? Promise.resolve(null) : Promise.resolve(false)
    }
    const requestId = randomUUID()
    const responseToken = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { responseToken, resolve, reject })
      const message: DocumentWorkerCacheRpcRequest = type === 'cache-read-request'
        ? { type, requestId, responseToken, jobId, generation, key }
        : { type, requestId, responseToken, jobId, generation, key, value: value! }
      try {
        this.port.postMessage(message)
      } catch {
        this.pending.delete(requestId)
        resolve(type === 'cache-read-request' ? null : false)
      }
    })
  }

  /**
   * 处理主进程缓存结果，未知与重复响应直接丢弃。
   * @param value 未信任消息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleMessage(value: unknown): void {
    if (this.disposed) return
    const response = parseResponse(value)
    if (!response) return
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.responseToken !== response.responseToken) return
    this.pending.delete(response.requestId)
    pending.resolve(response.type === 'cache-read-result' ? response.value : response.ok)
  }
}

/**
 * 主进程侧缓存 RPC 宿主，负责严格校验、代际隔离与缓存异常降级。
 * @author zhenghq
 */
export class DocumentWorkerCacheRpcHost {
  private readonly listener: (message: unknown) => void
  private disposed = false

  /**
   * 创建宿主并订阅 worker 缓存请求。
   * @param port worker 消息端口。
   * @param dependencies 代际校验与持久化缓存实现。
   * @author zhenghq
   */
  constructor(
    private readonly port: DocumentWorkerCacheRpcHostPort,
    private readonly dependencies: DocumentWorkerCacheRpcHostDependencies
  ) {
    this.listener = (message) => void this.handleMessage(message)
    port.on('message', this.listener)
  }

  /**
   * 释放宿主并停止回复后续请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.off('message', this.listener)
  }

  /**
   * 分发一条缓存 RPC 请求。
   * @param value 未信任消息。
   * @returns 处理完成 Promise。
   * @author zhenghq
   */
  private async handleMessage(value: unknown): Promise<void> {
    if (this.disposed) return
    const read = parseReadRequest(value)
    if (read) {
      await this.handleRead(read)
      return
    }
    const write = parseWriteRequest(value)
    if (write) await this.handleWrite(write)
  }

  /**
   * 执行缓存读取并发送稳定结果。
   * @param request 已校验读请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async handleRead(request: DocumentWorkerCacheRpcReadRequest): Promise<void> {
    let value: DocumentTranslationCacheEntry | null = null
    if (this.dependencies.isCurrent(request.jobId, request.generation)) {
      try {
        const candidate = await this.dependencies.read(request)
        value = parseCacheValue(candidate)
      } catch {
        value = null
      }
    }
    if (this.disposed) return
    this.send({
      type: 'cache-read-result',
      requestId: request.requestId,
      responseToken: request.responseToken,
      value
    })
  }

  /**
   * 执行缓存写入并发送稳定结果。
   * @param request 已校验写请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async handleWrite(request: DocumentWorkerCacheRpcWriteRequest): Promise<void> {
    let ok = false
    if (this.dependencies.isCurrent(request.jobId, request.generation)) {
      try {
        await this.dependencies.write(request)
        ok = true
      } catch {
        ok = false
      }
    }
    if (this.disposed) return
    this.send({
      type: 'cache-write-result',
      requestId: request.requestId,
      responseToken: request.responseToken,
      ok
    })
  }

  /**
   * 发送响应并吞掉已关闭端口的错误。
   * @param response 已校验响应。
   * @returns 无返回值。
   * @author zhenghq
   */
  private send(response: DocumentWorkerCacheRpcResponse): void {
    try {
      this.port.postMessage(response)
    } catch {
      // 端口已关闭时无需向上游泄漏底层错误。
    }
  }
}
