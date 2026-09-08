/** 常驻原生取词 helper 的 stdio 行分隔 JSON 协议定义与待定请求配对。 */

/** helper 直读状态：present 读到文本，empty 确认无选区，unknown 无法确认。 */
export type NativeReaderStatus = 'present' | 'empty' | 'unknown'

/** 发送给 helper 的取词请求。 */
export interface NativeReaderRequest {
  /** 请求标识，用于乱序响应配对。 */
  id: number
  /** 方法名，当前仅支持 readSelection。 */
  method: 'readSelection'
}

/** helper 返回的取词响应。 */
export interface NativeReaderResponse {
  /** 与请求对应的标识。 */
  id: number
  /** 直读状态。 */
  status: NativeReaderStatus
  /** 直读到的文本，仅 present 时非空。 */
  text?: string
  /** 失败原因（可选），供宿主降级判定。 */
  reason?: string
}

/** 不含 id 的响应载荷，即一次直读的结果。 */
export type NativeReaderResult = Omit<NativeReaderResponse, 'id'>

/**
 * 将取词请求编码为行分隔 JSON（末尾带换行）。
 * @param request 待发送的取词请求。
 * @returns 可直接写入 helper stdin 的一行 JSON。
 * @author zhenghq
 */
export function encodeNativeReaderRequest(request: NativeReaderRequest): string {
  return JSON.stringify(request) + '\n'
}

/**
 * 解析 helper stdout 的一行响应；空行与非法 JSON 返回 null，由宿主忽略。
 * @param line helper 输出的单行文本。
 * @returns 解析出的响应；无法解析时返回 null。
 * @author zhenghq
 */
export function parseNativeReaderResponseLine(line: string): NativeReaderResponse | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const raw = JSON.parse(trimmed) as Partial<NativeReaderResponse>
    if (typeof raw.id !== 'number') return null
    if (raw.status !== 'present' && raw.status !== 'empty' && raw.status !== 'unknown') {
      return null
    }
    const response: NativeReaderResponse = { id: raw.id, status: raw.status }
    if (typeof raw.text === 'string') response.text = raw.text
    if (typeof raw.reason === 'string') response.reason = raw.reason
    return response
  } catch {
    return null
  }
}

/** 待定请求的默认超时（毫秒）。 */
export const NATIVE_READER_REQUEST_TIMEOUT_MS = 1500

interface PendingRequest {
  resolve: (result: NativeReaderResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * 管理待定取词请求的配对：按 id 乱序解析、超时拒绝与崩溃时整体拒绝。
 * @author zhenghq
 */
export class NativeReaderRequestMatcher {
  private readonly pending = new Map<number, PendingRequest>()

  /** 当前待定请求数量。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 登记一个待定请求，返回等待其响应的 Promise。
   * @param id 请求标识。
   * @param timeoutMs 超时时间（毫秒）；超时后以 timeout 错误拒绝。
   * @returns 等待配对的 Promise。
   * @author zhenghq
   */
  track(id: number, timeoutMs = NATIVE_READER_REQUEST_TIMEOUT_MS): Promise<NativeReaderResult> {
    return new Promise<NativeReaderResult>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`native reader request ${id} timeout`))
      }, timeoutMs)
      this.pending.set(id, entry)
    })
  }

  /**
   * 用 helper 的一行响应配对待定请求；未知 id 直接忽略。
   * @param response 已解析的 helper 响应。
   * @returns 无返回值。
   * @author zhenghq
   */
  resolve(response: NativeReaderResponse): void {
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    if (entry.timer) clearTimeout(entry.timer)
    const result: NativeReaderResult = { status: response.status }
    if (response.text !== undefined) result.text = response.text
    if (response.reason !== undefined) result.reason = response.reason
    entry.resolve(result)
  }

  /**
   * helper 崩溃或退出时拒绝全部待定请求。
   * @param error 拒绝原因。
   * @returns 无返回值。
   * @author zhenghq
   */
  rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
