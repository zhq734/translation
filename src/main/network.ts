import { net, session, type Session } from 'electron'
import { ProxyAgent, WebSocket } from 'undici'
import { ReadableStream } from 'node:stream/web'
import { TextDecoder } from 'node:util'
import { buildProxyConfig } from '../shared/proxySettings'
import type { Settings } from '../shared/types'
import type { EdgeSpeechSocket, EdgeSpeechSocketHeaders } from './edgeSpeech'
import { edgeSpeechProxyUrl } from './networkProxy'
import { applyProxyToSessions } from './proxySessionApply'
import { translateMain } from './messages'

export { edgeSpeechProxyUrl } from './networkProxy'

let translationSession: Session | null = null
let updateDownloadSession: Session | null = null

/**
 * 获取翻译请求专用的 Electron 网络会话。
 * @returns 翻译网络会话。
 * @author zhenghq
 */
function getTranslationSession(): Session {
  if (!translationSession) {
    translationSession = session.fromPartition('translation-network')
  }
  return translationSession
}

/**
 * 获取 electron-updater 下载专用的 Electron 网络会话。
 * electron-updater 内部固定使用 `electron-updater` 具名分区，这里取到同一实例以便应用代理。
 * @returns 更新下载网络会话。
 * @author zhenghq
 */
function getUpdateDownloadSession(): Session {
  if (!updateDownloadSession) {
    updateDownloadSession = session.fromPartition('electron-updater')
  }
  return updateDownloadSession
}

/**
 * 将当前代理设置应用到翻译与更新下载网络会话，并关闭旧代理遗留的连接池。
 * @param settings 当前完整设置。
 * @returns 代理应用完成后的 Promise。
 * @author zhenghq
 */
export async function applyTranslationProxy(settings: Settings): Promise<void> {
  await applyProxyToSessions(
    [getTranslationSession(), getUpdateDownloadSession()],
    buildProxyConfig(settings)
  )
  console.log('[network] 代理模式已应用:', settings.proxyMode)
}

/**
 * 使用翻译专用会话和已配置的代理发送网络请求。
 * @param input 请求地址或 Request 对象。
 * @param init 请求参数。
 * @returns 网络响应。
 * @author zhenghq
 */
export function translationFetch(input: string | Request, init?: RequestInit): Promise<Response> {
  return createSessionFetch(getTranslationSession())(input, init)
}

/**
 * 使用 electron-updater 专用会话和已配置的代理发送更新包下载请求。
 * Windows 与 Linux 的并行下载会话必须与 electron-updater 原生下载一致，
 * 避免代理设置只应用到其中一个路径。
 * @param input 请求地址或 Request 对象。
 * @param init 请求参数。
 * @returns 网络响应。
 * @author zhenghq
 */
export function updateDownloadFetch(input: string | Request, init?: RequestInit): Promise<Response> {
  return createSessionFetch(getUpdateDownloadSession())(input, init)
}

/**
 * 将请求头规范化为普通字符串映射，供 Electron 22 的 net.request 使用。
 * @param headers 请求头来源。
 * @returns 小写键名与字符串值组成的对象。
 * @author zhenghq
 */
function normalizeRequestHeaders(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (Array.isArray(headers)) {
    for (const entry of headers as readonly (readonly [string, string])[]) {
      if (Array.isArray(entry) && entry.length >= 2) {
        result[String(entry[0]).toLowerCase()] = String(entry[1])
      }
    }
    return result
  }
  const headerLike = headers as {
    forEach?: (callback: (value: string, key: string) => void) => void
    [Symbol.iterator]?: () => Iterator<[string, string]>
  }
  if (typeof headerLike.forEach === 'function') {
    headerLike.forEach((value, key) => {
      result[key.toLowerCase()] = String(value)
    })
    return result
  }
  if (typeof headerLike[Symbol.iterator] === 'function') {
    const iterator = headerLike[Symbol.iterator]?.()
    for (const [key, value] of Array.from(iterator as unknown as Iterable<[string, string]>)) {
      result[key.toLowerCase()] = String(value)
    }
    return result
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    result[key.toLowerCase()] = Array.isArray(value) ? value.map(String).join(', ') : String(value)
  }
  return result
}

/**
 * Electron 22 回退路径使用的最小响应头集合，避免依赖旧运行时可能缺失的全局 Headers。
 * @author zhenghq
 */
class NetResponseHeaders {
  private readonly values = new Map<string, string[]>()

  /**
   * 创建响应头集合。
   * @param record Electron IncomingMessage 的响应头。
   * @author zhenghq
   */
  constructor(record: Record<string, string | string[]>) {
    for (const [key, value] of Object.entries(record)) {
      this.values.set(key.toLowerCase(), Array.isArray(value) ? value.map(String) : [String(value)])
    }
  }

  /** 读取字段值。 */
  get(name: string): string | null {
    return this.values.get(name.toLowerCase())?.join(', ') ?? null
  }

  /** 判断字段是否存在。 */
  has(name: string): boolean {
    return this.values.has(name.toLowerCase())
  }

  /** 写入字段值。 */
  set(name: string, value: string): void {
    this.values.set(name.toLowerCase(), [value])
  }

  /** 追加字段值。 */
  append(name: string, value: string): void {
    const key = name.toLowerCase()
    this.values.set(key, [...(this.values.get(key) ?? []), value])
  }

  /** 删除字段值。 */
  delete(name: string): void {
    this.values.delete(name.toLowerCase())
  }

  /** 返回 Set-Cookie 字段的独立值。 */
  getSetCookie(): string[] {
    return [...(this.values.get('set-cookie') ?? [])]
  }

  /** 遍历全部字段。 */
  forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
    for (const [key, values] of this.values) {
      callback.call(thisArg, values.join(', '), key, this as unknown as Headers)
    }
  }

  /** 返回字段名迭代器。 */
  keys(): IterableIterator<string> {
    return this.values.keys()
  }

  /** 返回字段值迭代器。 */
  valuesIterator(): IterableIterator<string> {
    return Array.from(this.values.values(), (items) => items.join(', ')).values()
  }

  /** 返回字段条目迭代器。 */
  entries(): IterableIterator<[string, string]> {
    return Array.from(this.values, ([key, values]) => [key, values.join(', ')] as [string, string]).values()
  }

  /** 支持 for...of 遍历响应头。 */
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }
}

/**
 * 创建与 fetch 一致的 AbortError。
 * @param message 错误说明。
 * @returns 名称为 AbortError 的异常。
 * @author zhenghq
 */
function createAbortError(message = 'The operation was aborted.'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/**
 * 读取请求体并转换为 Buffer，兼容字符串、Buffer、ArrayBuffer 与 Blob。
 * @param body 请求体。
 * @returns 可写入 ClientRequest 的 Buffer；无请求体时返回 null。
 * @author zhenghq
 */
async function normalizeRequestBody(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return Buffer.from(body.toString())
  const blobLike = body as { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof blobLike.arrayBuffer === 'function') return Buffer.from(await blobLike.arrayBuffer())
  throw new TypeError('Unsupported request body in the Electron 22 compatibility path')
}

/**
 * 构造兼容 fetch 语义的响应对象，供 Electron 22 的 session.fetch 回退路径使用。
 * @param request net.request 返回的响应。
 * @param finalUrl 请求最终地址。
 * @param clientRequest 用于取消底层响应的请求对象。
 * @param signal 请求取消信号。
 * @param originalUrl 原始请求地址。
 * @returns 支持 text/json/arrayBuffer/body.getReader 的 Response 兼容对象。
 * @author zhenghq
 */
function createNetResponse(
  response: Electron.IncomingMessage,
  finalUrl: string,
  clientRequest: Electron.ClientRequest,
  signal: AbortSignal | undefined,
  originalUrl: string
): Response {
  const headers = new NetResponseHeaders(response.headers) as unknown as Headers
  const status = response.statusCode ?? 0
  const statusText = response.statusMessage ?? ''
  let finished = false
  let bodyUsed = false
  let onData: (chunk: Buffer) => void = () => undefined
  let onEnd: () => void = () => undefined
  let onError: (error: Error) => void = () => undefined
  let onAborted: () => void = () => undefined
  let onAbort: () => void = () => undefined
  const cleanup = (): void => {
    response.removeListener('data', onData)
    response.removeListener('end', onEnd)
    response.removeListener('error', onError)
    response.removeListener('aborted', onAborted)
    signal?.removeEventListener('abort', onAbort)
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      /**
       * 将响应数据块写入 Web 流。
       * @param chunk 响应字节块。
       * @returns 无返回值。
       * @author zhenghq
       */
      onData = (chunk: Buffer): void => {
        if (finished) return
        try {
          controller.enqueue(new Uint8Array(chunk))
        } catch {
          finish()
          clientRequest.abort()
        }
      }

      /**
       * 在响应结束时关闭 Web 流。
       * @returns 无返回值。
       * @author zhenghq
       */
      onEnd = (): void => {
        if (finished) return
        finished = true
        cleanup()
        controller.close()
      }

      /**
       * 将底层响应错误转发给 Web 流。
       * @param error 底层网络异常。
       * @returns 无返回值。
       * @author zhenghq
       */
      onError = (error: Error): void => {
        if (finished) return
        finished = true
        cleanup()
        controller.error(error)
      }

      /**
       * 将底层响应中止转发给 Web 流。
       * @returns 无返回值。
       * @author zhenghq
       */
      onAborted = (): void => {
        onError(createAbortError())
      }

      /**
       * 在调用方取消请求时同步中止底层网络请求。
       * @returns 无返回值。
       * @author zhenghq
       */
      onAbort = (): void => {
        if (finished) return
        finished = true
        cleanup()
        clientRequest.abort()
        controller.error(createAbortError())
      }
      response.on('data', onData)
      response.on('end', onEnd)
      response.on('error', onError)
      response.on('aborted', onAborted)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    },
    cancel() {
      if (finished) return
      finished = true
      cleanup()
      clientRequest.abort()
    }
  }) as unknown as ReadableStream<Uint8Array>

  /**
   * 一次性读取完整响应体。
   * @returns 响应体字节。
   * @author zhenghq
   */
  const readBody = async (): Promise<Uint8Array> => {
    if (bodyUsed || body.locked) throw new TypeError('Body is unusable')
    bodyUsed = true
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        const chunk = result.value
        chunks.push(chunk)
        total += chunk.byteLength
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }
  const result = {
    get status() { return status },
    get statusText() { return statusText },
    get ok() { return status >= 200 && status < 300 },
    get url() { return finalUrl },
    get redirected() { return finalUrl !== originalUrl },
    get type() { return 'basic' as const },
    get headers() { return headers },
    get body() { return body as unknown as BodyInit },
    get bodyUsed() { return bodyUsed || body.locked },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const bytes = await readBody()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
    async text(): Promise<string> {
      return new TextDecoder().decode(await readBody())
    },
    async json(): Promise<unknown> {
      return JSON.parse(await new TextDecoder().decode(await readBody())) as unknown
    },
    clone(): Response {
      throw new TypeError('Response.clone is unavailable in the Electron 22 compatibility path')
    }
  }
  return result as unknown as Response
}

/**
 * 将 Request 与 init 合并为 net.request 所需的普通请求参数。
 * @param input 请求地址或 Request 对象。
 * @param init 显式请求参数。
 * @returns 合并后的请求地址与参数。
 * @author zhenghq
 */
async function resolveRequestInit(
  input: string | Request,
  init?: RequestInit
): Promise<{ url: string; init: RequestInit }> {
  if (typeof input === 'string') return { url: input, init: init ?? {} }
  const request = input
  let body = init?.body
  if (body === undefined && request.body) {
    body = new Uint8Array(await request.arrayBuffer())
  }
  return {
    url: request.url,
    init: {
      method: init?.method ?? request.method,
      headers: init?.headers ?? request.headers,
      body,
      redirect: init?.redirect ?? request.redirect,
      signal: init?.signal ?? request.signal
    }
  }
}

/**
 * 使用 Electron net.request 模拟 session.fetch，兼容 Electron 22。
 * @param session 请求使用的 Session。
 * @param input 请求地址或 Request 对象。
 * @param init 请求参数。
 * @returns 与 fetch 语义一致的响应。
 * @author zhenghq
 */
async function sessionNetFetch(
  targetSession: Session,
  input: string | Request,
  init?: RequestInit
): Promise<Response> {
  const resolved = await resolveRequestInit(input, init)
  const requestInput = resolved.url
  const requestInit = resolved.init
  const method = (requestInit?.method ?? 'GET').toUpperCase()
  const headers = normalizeRequestHeaders(requestInit?.headers)
  const body = await normalizeRequestBody(requestInit?.body)
  const signal = requestInit?.signal ?? undefined
  const redirect = requestInit?.redirect === 'error'
    ? 'error'
    : requestInit?.redirect === 'manual' ? 'manual' : 'follow'

  return await new Promise<Response>((resolve, reject) => {
    let settled = false
    let finalUrl = requestInput
    const request = net.request({
      url: requestInput,
      method,
      session: targetSession,
      useSessionCookies: true,
      redirect
    })
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abortRequest)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abortRequest = (): void => {
      request.abort()
      fail(createAbortError())
    }
    signal?.addEventListener('abort', abortRequest, { once: true })
    if (signal?.aborted) {
      abortRequest()
      return
    }
    if (redirect === 'follow') {
      request.on('redirect', (_statusCode, _method, redirectUrl) => {
        finalUrl = redirectUrl
        request.followRedirect()
      })
    }
    request.on('response', (response) => {
      settled = true
      cleanup()
      resolve(createNetResponse(response, finalUrl, request, signal, requestInput))
    })
    request.on('error', (error) => fail(error))
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    if (body) request.write(body)
    request.end()
  })
}

/**
 * 创建优先使用 session.fetch、旧 Electron 回退 net.request 的请求函数。
 * @param targetSession 请求使用的 Session。
 * @returns fetch 兼容函数。
 * @author zhenghq
 */
function createSessionFetch(
  session: Session
): (input: string | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    if (typeof session.fetch === 'function') {
      return await session.fetch(input, init) as unknown as Response
    }
    return await sessionNetFetch(session, input, init)
  }
}

/**
 * 使用翻译专用 Electron Session 的代理解析结果创建 Edge WebSocket。
 * @param url Edge WebSocket 握手地址。
 * @param headers 模拟 Edge 浏览器扩展的握手请求头。
 * @returns 已应用当前代理策略的 WebSocket 兼容对象。
 * @author zhenghq
 */
export async function createTranslationWebSocket(
  url: string,
  headers: EdgeSpeechSocketHeaders
): Promise<EdgeSpeechSocket> {
  const proxyResult = await getTranslationSession().resolveProxy(url.replace(/^wss:/u, 'https:'))
  const proxyUrl = edgeSpeechProxyUrl(proxyResult)
  if (proxyUrl === undefined) throw new Error(translateMain('speech.error.proxyUnsupported'))
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null
  const socket = new WebSocket(url, dispatcher ? { dispatcher, headers } : { headers })
  socket.binaryType = 'arraybuffer'
  return {
    get readyState() {
      return socket.readyState
    },
    get binaryType() {
      return socket.binaryType
    },
    set binaryType(value: string) {
      socket.binaryType = value === 'arraybuffer' ? 'arraybuffer' : 'blob'
    },
    get onopen() {
      return socket.onopen as (() => void) | null
    },
    set onopen(handler: (() => void) | null) {
      socket.onopen = handler
    },
    get onmessage() {
      return socket.onmessage as ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null
    },
    set onmessage(handler: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null) {
      socket.onmessage = handler as typeof socket.onmessage
    },
    get onerror() {
      return socket.onerror as (() => void) | null
    },
    set onerror(handler: (() => void) | null) {
      socket.onerror = handler
    },
    get onclose() {
      return socket.onclose as (() => void) | null
    },
    set onclose(handler: (() => void) | null) {
      socket.onclose = handler
    },
    send(data: string): void {
      socket.send(data)
    },
    close(): void {
      socket.close()
    },
    dispose(): void {
      if (dispatcher) void dispatcher.close()
    }
  }
}
