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
  const alreadyCompleted = options.segments.reduce((sum, segment) => sum + segment.completed, 0)
  const reporter = createUpdateProgressReporter({
    total: options.total,
    onProgress: options.onProgress
  })
  reporter.start(alreadyCompleted)

  const fileHandle = await open(options.temporaryPath, 'r+').catch(() => open(options.temporaryPath, 'w+'))
  let nextSegmentIndex = 0

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
        } finally {
          if (!response) cleanupRequestResources()
        }
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
          let chunkLoopCompleted = false
          try {
            resetReadTimeout()
            while (true) {
              if (options.signal?.aborted) throw new Error('下载已取消')
              const chunk = await reader.read()
              if (chunk.done) break
              if (!chunk.value) continue
              resetReadTimeout()
              await fileHandle.write(chunk.value, 0, chunk.value.byteLength, position)
              position += chunk.value.byteLength
              segment.completed += chunk.value.byteLength
              reporter.add(chunk.value.byteLength)
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
            await fileHandle.write(content, 0, content.byteLength, position)
            segment.completed += content.byteLength
            reporter.add(content.byteLength)
            arrayBufferCompleted = true
          } finally {
            cleanupRequestResources()
            // 此分支表示运行时未暴露 body，只能依赖 arrayBuffer 的失败路径清理。
          }
        }
        return
      } catch (error) {
        lastError = error as Error
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
  return /ERR_(?:CONNECTION|TIMED_OUT|NETWORK)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|分片(?:请求|读取)超时/u
    .test(error.message)
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
