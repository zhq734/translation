import type { UpdateProgress } from '../shared/types'

/** 进度上报的默认最小间隔，避免逐块广播压垮 IPC 与界面重绘。 */
const DEFAULT_MINIMUM_INTERVAL_MS = 250

/** 瞬时速度默认采样窗口，约 3 秒可平滑抖动又能反映真实降速。 */
const DEFAULT_SAMPLE_WINDOW_MS = 3000

/** 创建下载进度聚合器所需的依赖与参数。 */
export interface UpdateProgressReporterOptions {
  /** 更新包总字节数，未知时传 0 并在获知后调用 setTotal。 */
  total: number
  /**
   * 向外发送合并后的下载进度。
   * @param progress 合并后的下载进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  onProgress?: (progress: UpdateProgress) => void
  /**
   * 读取当前时间，测试可注入确定性时钟。
   * @returns 当前毫秒时间戳。
   * @author zhenghq
   */
  now?: () => number
  /** 进度上报最小间隔（毫秒）。 */
  minimumIntervalMs?: number
  /** 瞬时速度采样窗口（毫秒）。 */
  sampleWindowMs?: number
}

/** 下载进度聚合器，负责节流上报与瞬时速度计算。 */
export interface UpdateProgressReporter {
  /**
   * 开始一次下载并立即上报初始进度。
   * @param initialTransferred 续传场景下已完成的字节数。
   * @returns 无返回值。
   * @author zhenghq
   */
  start(initialTransferred?: number): void
  /**
   * 累计新到达的字节数，并在超过最小间隔时上报进度。
   * @param bytes 本次新增的字节数。
   * @returns 无返回值。
   * @author zhenghq
   */
  add(bytes: number): void
  /**
   * 在获知更新包总长度后补充设置，用于计算百分比。
   * @param total 更新包总字节数。
   * @returns 无返回值。
   * @author zhenghq
   */
  setTotal(total: number): void
  /**
   * 结束下载并强制上报一次最终进度，避免节流吞掉完成状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  finish(): void
  /**
   * 读取当前累计已传输字节数。
   * @returns 已传输字节数。
   * @author zhenghq
   */
  getTransferred(): number
}

/** 用于计算瞬时速度的单个采样点。 */
interface ProgressSample {
  /** 采样时间戳。 */
  at: number
  /** 该时间点的累计已传输字节数。 */
  transferred: number
}

/**
 * 创建不依赖 Electron 的下载进度聚合器。
 * @param options 总长度、上报回调、时钟与节流参数。
 * @returns 可在单流与分片下载中共用的进度聚合器。
 * @author zhenghq
 */
export function createUpdateProgressReporter(
  options: UpdateProgressReporterOptions
): UpdateProgressReporter {
  const now = options.now ?? Date.now
  const minimumIntervalMs = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS
  const sampleWindowMs = options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS
  let total = Number.isFinite(options.total) && options.total > 0 ? options.total : 0
  let transferred = 0
  let lastReportedAt = 0
  let highestPercent = 0
  let samples: ProgressSample[] = []

  /**
   * 依据采样窗口内的首尾采样点计算瞬时下载速度。
   * @returns 每秒字节数；样本不足时返回 0。
   * @author zhenghq
   */
  const currentBytesPerSecond = (): number => {
    if (samples.length < 2) return 0
    const oldest = samples[0]
    const latest = samples[samples.length - 1]
    const elapsedMs = latest.at - oldest.at
    if (elapsedMs <= 0) return 0
    return (latest.transferred - oldest.transferred) / (elapsedMs / 1000)
  }

  /**
   * 生成当前进度快照，并保证百分比单调不减。
   * @returns 当前下载进度。
   * @author zhenghq
   */
  const buildProgress = (): UpdateProgress => {
    const rawPercent = total > 0 ? Math.min(100, transferred / total * 100) : 0
    highestPercent = Math.max(highestPercent, rawPercent)
    return {
      percent: highestPercent,
      transferred,
      total,
      bytesPerSecond: currentBytesPerSecond()
    }
  }

  /**
   * 记录采样点并丢弃超出采样窗口的历史数据。
   * @param at 采样时间戳。
   * @returns 无返回值。
   * @author zhenghq
   */
  const recordSample = (at: number): void => {
    samples.push({ at, transferred })
    const earliestAllowed = at - sampleWindowMs
    const firstInsideWindow = samples.findIndex((sample) => sample.at >= earliestAllowed)
    if (firstInsideWindow > 1) samples = samples.slice(firstInsideWindow - 1)
  }

  /**
   * 上报一次进度并记录上报时间。
   * @param at 上报时间戳。
   * @returns 无返回值。
   * @author zhenghq
   */
  const report = (at: number): void => {
    lastReportedAt = at
    options.onProgress?.(buildProgress())
  }

  return {
    start(initialTransferred = 0): void {
      transferred = Math.max(0, initialTransferred)
      highestPercent = 0
      samples = []
      const at = now()
      recordSample(at)
      report(at)
    },
    add(bytes: number): void {
      if (!Number.isFinite(bytes) || bytes <= 0) return
      transferred += bytes
      const at = now()
      recordSample(at)
      if (at - lastReportedAt >= minimumIntervalMs) report(at)
    },
    setTotal(value: number): void {
      if (Number.isFinite(value) && value > 0) total = value
    },
    finish(): void {
      const at = now()
      recordSample(at)
      report(at)
    },
    getTransferred(): number {
      return transferred
    }
  }
}
