import { open } from 'node:fs/promises'
import type { UpdateProgress } from '../shared/types'
import type { UpdateDownloadFetch } from './manualMacUpdate'
import { createUpdateProgressReporter } from './updateDownloadProgress'
import type { DownloadResumeSegment } from './updateDownloadResume'

/** 分片并发上限，用于提升慢速链路吞吐且避免过度触发下载源限流。 */
export const MAX_DOWNLOAD_CONCURRENCY = 8

/**
 * 动态分片任务的目标体积。分片数多于连接数时，先完成的连接会继续领取
 * 下一段，避免下载后期固定大分片陆续结束导致并发从 8 降到 1。
 */
export const TARGET_SEGMENT_SIZE = 8 * 1024 * 1024

/** 动态分片任务的最小体积，避免把小文件切成过多请求。 */
export const MINIMUM_SEGMENT_SIZE = 2 * 1024 * 1024

/** 动态分片任务队列相对并发连接数的倍数，用于保持下载后期的连接占用。 */
const SEGMENT_QUEUE_MULTIPLIER = 2

/** 单个分片默认最大重试次数。 */
const DEFAULT_MAX_RETRIES = 3

/** 下载源连续 Range 连接失败后，降低并发给网络恢复留出的等待时间。 */
const SEGMENT_RETRY_DELAY_MS = 1_000

/** 单个分片请求建立响应的默认超时时间，避免连接悬挂导致界面永远停在当前进度。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** 单个分片读取相邻数据块的默认超时时间，慢速链路下仍能及时中断死连接。 */
const DEFAULT_READ_TIMEOUT_MS = 15_000

/**
 * 续传进度落盘的最小字节增量。逐块写盘会拖慢下载，间隔过大则进程被强杀时
 * 丢失的进度过多；4MB 在两者之间取得平衡。
 */
const DEFAULT_CHECKPOINT_INTERVAL_BYTES = 4 * 1024 * 1024

/** Range 能力探测响应中与分片决策相关的字段。 */
export interface RangeProbeInput {
  /** 探测响应状态码。 */
  status: number
  /** 探测响应的 Accept-Ranges 头。 */
  acceptRanges: string | null
  /** 探测响应的 Content-Range 头。 */
  contentRange: string | null
  /** 更新清单声明的文件长度，作为总长度兜底。 */
  manifestSize?: number
}

/** Range 能力探测结论。 */
export interface RangeProbeResult {
  /** 下载源是否支持字节范围请求。 */
  supported: boolean
  /** 解析出的更新包总长度，无法确定时为 0。 */
  total: number
}

/**
 * 判断下载源是否支持字节范围请求，并解析可信的更新包总长度。
 * 只有状态码为 206、明确声明 `Accept-Ranges: bytes` 且能得到总长度时才启用分片。
 * @param input 探测响应中的状态码与相关响应头。
 * @returns 是否支持分片以及更新包总长度。
 * @author zhenghq
 */
export function parseRangeProbe(input: RangeProbeInput): RangeProbeResult {
  const declaresBytes = (input.acceptRanges ?? '').toLowerCase().includes('bytes')
  if (input.status !== 206 || !declaresBytes) return { supported: false, total: 0 }

  const rangeTotal = Number(/\/(\d+)\s*$/u.exec(input.contentRange ?? '')?.[1])
  const total = Number.isFinite(rangeTotal) && rangeTotal > 0
    ? rangeTotal
    : Number.isFinite(input.manifestSize) && (input.manifestSize as number) > 0
      ? (input.manifestSize as number)
      : 0
  return total > 0 ? { supported: true, total } : { supported: false, total: 0 }
}

/**
 * 将更新包总长度切分为互不重叠且完整覆盖的动态分片任务。
 * 任务数可以多于并发连接数：先完成的连接会继续领取后续分片，从而保持
 * 下载后期的连接占用，避免固定大分片导致的速度“先快后慢”。
 * 小文件会自动退化为更少的分片。
 * @param total 更新包总字节数。
 * @param concurrency 并发连接上限，用于计算动态任务队列的最小任务数。
 * @returns 起止偏移与初始进度均已就绪的分片列表。
 * @author zhenghq
 */
export function planDownloadSegments(
  total: number,
  concurrency: number
): DownloadResumeSegment[] {
  if (!Number.isFinite(total) || total <= 0) return []

  const safeConcurrency = Math.max(
    1,
    Math.floor(Number.isFinite(concurrency) ? concurrency : MAX_DOWNLOAD_CONCURRENCY)
  )
  const maximumSegmentCount = Math.max(1, Math.floor(total / MINIMUM_SEGMENT_SIZE))
  const targetCount = Math.ceil(total / TARGET_SEGMENT_SIZE)
  const queueSegmentCount = Math.min(
    safeConcurrency * SEGMENT_QUEUE_MULTIPLIER,
    maximumSegmentCount
  )
  const finalCount = Math.max(targetCount, queueSegmentCount, 1)
  const segmentSize = Math.ceil(total / finalCount)
  const segments: DownloadResumeSegment[] = []
  for (let start = 0; start < total; start += segmentSize) {
    segments.push({ start, end: Math.min(start + segmentSize, total) - 1, completed: 0 })
  }
  return segments
}

/** 分片并发下载所需的依赖与参数。 */
export interface DownloadSegmentsOptions {
  /** 更新包下载地址。 */
  url: string
  /** 写入目标的临时文件路径。 */
  temporaryPath: string
  /** 更新包总字节数。 */
  total: number
  /** 需要下载的分片列表，函数会就地更新各分片的已完成字节数。 */
  segments: DownloadResumeSegment[]
  /** 下载源要求的额外请求头；Range 头会始终覆盖同名请求头。 */
  headers?: Record<string, string>
  /** 并发连接上限。 */
  concurrency?: number
  /** 单个分片最大重试次数。 */
  maxRetries?: number
  /** 等待响应头到达的超时时间（毫秒）。 */
  requestTimeoutMs?: number
  /** 等待响应体相邻数据块到达的超时时间（毫秒）。 */
  readTimeoutMs?: number
  /** 注入的网络请求函数。 */
  fetch: UpdateDownloadFetch
  /**
   * 接收合并后的下载进度。
   * @param progress 当前下载进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  onProgress?: (progress: UpdateProgress) => void
  /**
   * 周期性接收各分片已完成字节，用于把续传进度持久化到磁盘。
   * 进程被强制结束等无法进入 catch 的场景，只能依靠该回调保留断点。
   * @param segments 各分片当前已完成字节。
   * @returns 落盘完成后的 Promise。
   * @author zhenghq
   */
  onCheckpoint?: (segments: DownloadResumeSegment[]) => void | Promise<void>
  /** 触发一次续传进度落盘所需的累计字节增量，默认 4MB。 */
  checkpointIntervalBytes?: number
  /** 可选的取消信号；触发后各分片下载中断。 */
  signal?: AbortSignal
}

/**
 * 以受限并发下载各分片，并按偏移写入同一临时文件。
 * 单个分片失败只重试该分片剩余部分；重试耗尽时抛出错误并保留已完成分片进度。
 * @param options 下载地址、临时文件、分片列表与并发重试参数。
 * @returns 全部分片写入完成后的 Promise。
 * @throws 某个分片重试耗尽时抛出说明分片区间的错误。
 * @author zhenghq
 */
export async function downloadSegments(options: DownloadSegmentsOptions): Promise<void> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? MAX_DOWNLOAD_CONCURRENCY, MAX_DOWNLOAD_CONCURRENCY))
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const readTimeoutMs = Math.max(1, options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS)
  const checkpointIntervalBytes = Math.max(
    1,
    options.checkpointIntervalBytes ?? DEFAULT_CHECKPOINT_INTERVAL_BYTES
  )
  const alreadyCompleted = options.segments.reduce((sum, segment) => sum + segment.completed, 0)
  const reporter = createUpdateProgressReporter({
    total: options.total,
    onProgress: options.onProgress
  })
  reporter.start(alreadyCompleted)

  const fileHandle = await open(options.temporaryPath, 'r+').catch(() => open(options.temporaryPath, 'w+'))
  let nextSegmentIndex = 0
  let bytesSinceCheckpoint = 0
  let checkpointChain: Promise<void> = Promise.resolve()

  /**
   * 把当前分片进度串行落盘，避免并发检查点互相覆盖同一个 sidecar 记录。
   * 单次落盘失败只影响断点精度，不应中断仍在进行的下载。
   * @returns 无返回值。
   * @author zhenghq
   */
  const requestCheckpoint = (): void => {
    const onCheckpoint = options.onCheckpoint
    if (!onCheckpoint) return
    checkpointChain = checkpointChain
      .then(() => onCheckpoint(options.segments))
      .catch(() => undefined)
  }

  /**
   * 按偏移完整写入一个数据块，兼容底层文件写入只落盘部分字节的情况。
   * @param chunk 待写入的数据块。
   * @param position 写入的起始偏移。
   * @returns 实际写入的字节数。
   * @author zhenghq
   */
  const writeChunkAt = async (chunk: Uint8Array, position: number): Promise<number> => {
    let written = 0
    while (written < chunk.byteLength) {
      const result = await fileHandle.write(
        chunk,
        written,
        chunk.byteLength - written,
        position + written
      )
      if (result.bytesWritten <= 0) throw new Error('写入更新临时文件失败')
      written += result.bytesWritten
    }
    return written
  }

  /**
   * 累计新写入字节，并在达到阈值时触发一次续传进度落盘。
   * @param bytes 本次写入的字节数。
   * @returns 无返回值。
   * @author zhenghq
   */
  const recordWrittenBytes = (bytes: number): void => {
    bytesSinceCheckpoint += bytes
    if (bytesSinceCheckpoint < checkpointIntervalBytes) return
    bytesSinceCheckpoint = 0
    requestCheckpoint()
  }

  /**
   * 下载单个分片剩余字节，并把数据写入其在目标文件中的偏移。
   * @param segment 待下载的分片。
   * @returns 分片写入完成后的 Promise。
   * @author zhenghq
   */
const downloadSegment = async (segment: DownloadResumeSegment): Promise<void> => {
    let lastError: Error | undefined
    let consecutiveNetworkFailures = 0
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const rangeStart = segment.start + segment.completed
      if (rangeStart > segment.end) return
      if (options.signal?.aborted) throw new Error('下载已取消')
      try {
        const requestAbortController = new AbortController()
        const abortRequest = (): void => requestAbortController.abort()
        options.signal?.addEventListener('abort', abortRequest, { once: true })
        let timeoutKind: 'request' | 'read' | undefined
        const requestTimer = setTimeout(() => {
          if (!requestAbortController.signal.aborted) {
            timeoutKind = 'request'
            abortRequest()
          }
        }, requestTimeoutMs)
        let readTimer: NodeJS.Timeout | undefined

        /**
         * 重置响应体数据块的读取超时计时器。
         * @returns 无返回值。
         * @author zhenghq
         */
        const resetReadTimeout = (): void => {
          if (readTimer) clearTimeout(readTimer)
          readTimer = setTimeout(() => {
            if (!requestAbortController.signal.aborted) {
              timeoutKind = 'read'
              abortRequest()
            }
          }, readTimeoutMs)
        }

        /**
         * 释放请求超时、读取超时与取消信号监听。
         * @returns 无返回值。
         * @author zhenghq
         */
        const cleanupRequestResources = (): void => {
          clearTimeout(requestTimer)
          if (readTimer) clearTimeout(readTimer)
          options.signal?.removeEventListener('abort', abortRequest)
        }

        let response: Response | undefined
        try {
          response = await options.fetch(options.url, {
            headers: {
              ...options.headers,
              range: `bytes=${rangeStart}-${segment.end}`
            },
            signal: requestAbortController.signal
          })
        } catch (error) {
          // fetch 被中止时，Electron 抛出的原始 abort 错误不带超时语义，
          // 这里结合计时器状态还原真实原因，保证重试判断与提示都准确。
          if (options.signal?.aborted) throw new Error('下载已取消')
          if (timeoutKind === 'request') throw new Error('分片请求超时')
          if (isAbortLikeError(error)) throw new Error('网络连接被中断')
          throw error
        } finally {
          if (!response) cleanupRequestResources()
        }
        // 请求超时只约束“收到响应头”这一段。响应已经建立后，慢速链路的
        // 总传输时长不应继续受该计时器约束，数据停滞改由读取超时检测。
        clearTimeout(requestTimer)
        if (timeoutKind === 'request') throw new Error('分片请求超时')
        // 分片响应必须是 206。若服务器忽略 Range 返回 200，响应体会从文件
        // 开头开始，不能继续按分片偏移写入，否则会得到错位的损坏文件。
        if (response.status !== 206) {
          throw new Error(`HTTP ${response.status}`)
        }
        let position = rangeStart
        const body = response.body
        if (body) {
          const reader = body.getReader()

          /**
           * 读取下一个响应体数据块，并在取消信号或读取超时触发时立即中断等待。
           * 某些 fetch 实现对已经建立的死响应流不会自动拒绝 reader.read()，
           * 因此需要显式监听 AbortSignal，避免分片永远卡在读取阶段。
           * @returns 下一个响应体数据块读取结果。
           * @author zhenghq
           */
          const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
            return new Promise((resolve, reject) => {
              const onAbort = (): void => {
                requestAbortController.signal.removeEventListener('abort', onAbort)
                // 用户取消优先于超时：调用方信号触发时不能误报为分片超时。
                if (options.signal?.aborted) {
                  reject(new Error('下载已取消'))
                } else {
                  reject(new Error(timeoutKind === 'read' ? '分片读取超时' : '分片请求超时'))
                }
              }

              if (requestAbortController.signal.aborted) {
                onAbort()
                return
              }

              requestAbortController.signal.addEventListener('abort', onAbort, { once: true })
              reader.read().then(
                (chunk) => {
                  requestAbortController.signal.removeEventListener('abort', onAbort)
                  resolve(chunk)
                },
                (error) => {
                  requestAbortController.signal.removeEventListener('abort', onAbort)
                  reject(error)
                }
              )
            })
          }

          let chunkLoopCompleted = false
          try {
            resetReadTimeout()
            while (true) {
              if (options.signal?.aborted) throw new Error('下载已取消')
              const chunk = await readChunk()
              if (chunk.done) break
              if (!chunk.value) continue
              resetReadTimeout()
              const written = await writeChunkAt(chunk.value, position)
              position += written
              segment.completed += written
              reporter.add(written)
              recordWrittenBytes(written)
            }
            if (timeoutKind === 'read') throw new Error('分片读取超时')
            chunkLoopCompleted = true
          } finally {
            cleanupRequestResources()
            if (!chunkLoopCompleted) await reader.cancel().catch(() => undefined)
          }
        } else {
          let arrayBufferCompleted = false
          try {
            resetReadTimeout()
            const content = new Uint8Array(await response.arrayBuffer())
            if (timeoutKind === 'read') throw new Error('分片读取超时')
            const written = await writeChunkAt(content, position)
            segment.completed += written
            reporter.add(written)
            recordWrittenBytes(written)
            arrayBufferCompleted = true
          } finally {
            cleanupRequestResources()
            // 此分支表示运行时未暴露 body，只能依赖 arrayBuffer 的失败路径清理。
          }
        }
        return
      } catch (error) {
        lastError = normalizeSegmentError(error, options.signal)
        if (isNetworkError(lastError)) {
          consecutiveNetworkFailures += 1
          if (attempt < maxRetries) {
            await sleep(SEGMENT_RETRY_DELAY_MS, options.signal)
          }
        } else {
          consecutiveNetworkFailures = 0
        }
      }
    }
    throw new Error(
      `分片下载失败（字节 ${segment.start}-${segment.end}）：${lastError?.message ?? '未知错误'}`
    )
  }

  /**
   * 持续领取未下载的分片，实现固定上限的并发调度。
   * @returns 该工作协程结束后的 Promise。
   * @author zhenghq
   */
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextSegmentIndex
      nextSegmentIndex += 1
      const segment = options.segments[index]
      if (!segment) return
      await downloadSegment(segment)
    }
  }

  try {
    const workerCount = Math.min(concurrency, options.segments.length)
    const results = await Promise.allSettled(
      Array.from({ length: workerCount }, () => runWorker())
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure && failure.status === 'rejected') throw failure.reason as Error
    reporter.finish()
  } finally {
    // 确保已排队的检查点全部落盘后再关闭文件，避免成功清理后又被迟到写入复活记录。
    await checkpointChain.catch(() => undefined)
    await fileHandle.close().catch(() => undefined)
  }
}

/**
 * 判断异常是否来自网络连接建立、传输或超时。
 * @param error 分片下载过程中抛出的异常。
 * @returns 是否应按网络故障执行退避重试。
 * @author zhenghq
 */
function isNetworkError(error: Error): boolean {
  // 除 Node 侧错误码外，Electron 会把底层失败包装成 `net::ERR_*` 形式的
  // Chromium 网络层错误码（如 ERR_INCOMPLETE_CHUNKED_ENCODING、
  // ERR_CONTENT_LENGTH_MISMATCH）；这类错误都可重试并从断点继续。
  return /net::ERR_|ERR_(?:CONNECTION|TIMED_OUT|NETWORK|ABORTED)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|分片(?:请求|读取)超时|网络(?:连接)?被中断/u
    .test(error.message)
}

/**
 * 判断异常是否为 Chromium/Electron 在连接被中断时抛出的原始 abort 错误。
 *
 * Electron 的 `net.fetch` 在请求被中止时不一定抛出标准 `AbortError`，而是抛出
 * 消息为 `This operation was aborted`、名称为 `Error` 的 Chromium 原始异常；
 * 这类异常若不识别，会被当作确定性失败直接展示给用户且不触发重试。
 * @param error 分片下载过程中抛出的异常。
 * @returns 属于可重试的连接中断错误时返回 true。
 * @author zhenghq
 */
function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  return /this operation was aborted|operation aborted|the operation was aborted|request aborted|net::ERR_ABORTED/iu
    .test(error.message)
}

/**
 * 把各运行时抛出的中断异常归一化为可重试且可展示的中文错误。
 *
 * 调用方主动取消时保留“下载已取消”语义，避免把用户操作误报成网络故障；
 * 其余中断统一转换为“网络连接被中断”，使重试判断与最终提示都能正确处理。
 * @param error 底层 fetch 或读取流程抛出的异常。
 * @param signal 调用方传入的取消信号，用于区分用户取消与网络中断。
 * @returns 归一化后的异常。
 * @author zhenghq
 */
function normalizeSegmentError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new Error('下载已取消')
  if (isAbortLikeError(error)) return new Error('网络连接被中断')
  // Chromium 的 `net::ERR_*` 错误码属于网络层失败，统一转成可重试且可展示
  // 的中文提示，避免英文错误码直接暴露在设置页。
  if (error instanceof Error && /net::ERR_/u.test(error.message)) {
    return new Error('网络连接被中断')
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 在分片重试之间等待，给 Windows 网络栈和下载源连接队列恢复时间。
 * @param duration 等待毫秒数。
 * @param signal 外层取消信号。
 * @returns 等待完成或取消后抛出取消错误的 Promise。
 * @author zhenghq
 */
function sleep(duration: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('下载已取消'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, duration)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new Error('下载已取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
