import { open } from 'node:fs/promises'
import type { UpdateProgress } from '../shared/types'
import type { UpdateDownloadFetch } from './manualMacUpdate'
import { createUpdateProgressReporter } from './updateDownloadProgress'
import type { DownloadResumeSegment } from './updateDownloadResume'

/** 分片并发上限，取固定小值避免对下载源造成过高压力或触发限流。 */
export const MAX_DOWNLOAD_CONCURRENCY = 4

/** 单个分片的最小体积，避免把小文件切成过多请求。 */
export const MINIMUM_SEGMENT_SIZE = 2 * 1024 * 1024

/** 单个分片默认最大重试次数。 */
const DEFAULT_MAX_RETRIES = 3

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
 * 将更新包总长度切分为互不重叠且完整覆盖的分片区间。
 * 总长度较小或分片过细时自动退化为更少的分片。
 * @param total 更新包总字节数。
 * @param concurrency 期望的分片数量上限。
 * @returns 起止偏移与初始进度均已就绪的分片列表。
 * @author zhenghq
 */
export function planDownloadSegments(
  total: number,
  concurrency: number
): DownloadResumeSegment[] {
  if (!Number.isFinite(total) || total <= 0) return []
  // 分片数量同时受并发上限与最小分片体积约束，过小的更新包退化为单流。
  const segmentCount = Math.max(
    1,
    Math.min(concurrency, Math.floor(total / MINIMUM_SEGMENT_SIZE))
  )
  const segmentSize = Math.ceil(total / segmentCount)
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
  /** 并发连接上限。 */
  concurrency?: number
  /** 单个分片最大重试次数。 */
  maxRetries?: number
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
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const rangeStart = segment.start + segment.completed
      if (rangeStart > segment.end) return
      if (options.signal?.aborted) throw new Error('下载已取消')
      try {
        const response = await options.fetch(options.url, {
          headers: { range: `bytes=${rangeStart}-${segment.end}` },
          signal: options.signal
        })
        if (response.status !== 206 && response.status !== 200) {
          throw new Error(`HTTP ${response.status}`)
        }
        let position = rangeStart
        if (response.body) {
          const reader = response.body.getReader()
          while (true) {
            if (options.signal?.aborted) throw new Error('下载已取消')
            const chunk = await reader.read()
            if (chunk.done) break
            if (!chunk.value) continue
            await fileHandle.write(chunk.value, 0, chunk.value.byteLength, position)
            position += chunk.value.byteLength
            segment.completed += chunk.value.byteLength
            reporter.add(chunk.value.byteLength)
          }
        } else {
          const content = new Uint8Array(await response.arrayBuffer())
          await fileHandle.write(content, 0, content.byteLength, position)
          segment.completed += content.byteLength
          reporter.add(content.byteLength)
        }
        return
      } catch (error) {
        lastError = error as Error
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
