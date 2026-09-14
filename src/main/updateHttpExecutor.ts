import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DownloadOptions } from 'builder-util-runtime'
import type { AppUpdater, ProgressInfo } from 'electron-updater'
import type { UpdateDownloadFetch } from './manualMacUpdate'
import {
  clearDownloadResumeState,
  loadDownloadResumeState,
  resumeTemporaryPath,
  saveDownloadResumeState,
  type DownloadResumeRecord,
  type DownloadResumeSegment
} from './updateDownloadResume'
import {
  downloadSegments,
  parseRangeProbe,
  planDownloadSegments,
  MAX_DOWNLOAD_CONCURRENCY
} from './updateRangeDownload'

/** electron-updater httpExecutor.download 的函数契约。 */
type DownloadFile = (
  url: URL,
  destination: string,
  options: DownloadOptions
) => Promise<string>

/** electron-updater 运行时对象中未公开在类型声明里的 httpExecutor 字段。 */
type UpdaterWithHttpExecutor = AppUpdater & {
  httpExecutor: { download: DownloadFile } | null
}

/** 调用方包装后的 electron-updater 完整下载函数。 */
type FullDownload = (url: URL, destination: string, options: DownloadOptions) => Promise<string>

/** electron-updater 取消令牌中被分片下载适配器使用的最小契约。 */
interface CancellationTokenLike {
  createPromise<R>(
    callback: (
      resolve: (thenableOrResult: R | PromiseLike<R>) => void,
      reject: (error: Error) => void,
      onCancel: (callback: () => void) => void
    ) => void
  ): Promise<R>
}

/**
 * 将取消令牌适配为分片下载使用的 AbortSignal。
 * @param cancellationToken electron-updater 传入的取消令牌。
 * @returns 与取消令牌联动的取消信号。
 * @author zhenghq
 */
function createAbortSignalFromToken(cancellationToken: CancellationTokenLike): AbortSignal {
  const controller = new AbortController()
  cancellationToken.createPromise((_resolve, _reject, onCancel) => {
    onCancel(() => controller.abort())
  }).catch(() => undefined)
  return controller.signal
}

/**
 * 构造透传给下载源的请求头。
 * @param options electron-updater 传入的下载选项。
 * @returns 可直接交给 fetch 的字符串请求头。
 * @author zhenghq
 */
function buildFetchHeaders(options: DownloadOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value != null) headers[key] = String(value)
  }
  return headers
}

/**
 * 将项目内下载进度转换为 electron-updater 的进度事件格式。
 * @param progress 项目内聚合后的下载进度。
 * @param onProgress electron-updater 进度回调。
 * @returns 无返回值。
 * @author zhenghq
 */
function reportElectronProgress(
  progress: {
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  },
  onProgress: ((progress: ProgressInfo) => void) | undefined
): void {
  onProgress?.({
    total: progress.total,
    delta: 0,
    transferred: progress.transferred,
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond
  })
}

/**
 * 计算与 electron-updater 目标文件对应的稳定续传基准路径。
 *
 * electron-updater 每次下载前都会 unlink 目标临时文件，失败时还会清空整个
 * `pending` 目录，因此不能把断点文件放在目标文件旁。这里统一放到 `pending`
 * 同级的 `resume` 目录，既不会被清理，也能随目标文件一起定位。
 * @param destination electron-updater 提供的临时目标文件。
 * @returns 续传临时文件与进度记录的公共基准路径。
 * @author zhenghq
 */
function resolveResumeBasePath(destination: string): string {
  const pendingDirectory = dirname(destination)
  const fileName = basename(destination)
  // electron-updater 的标准布局是 <cache>/pending/<temp-file>，把断点放到
  // <cache>/resume 下即可躲开失败清理；非标准布局则退化为目标文件的同级
  // `<destination>.resume`，同样不会落在会被清空的 pending 目录内。
  return basename(pendingDirectory) === 'pending'
    ? join(dirname(pendingDirectory), 'resume', fileName)
    : `${destination}.resume`
}

/**
 * 清理续传目录中其他下载目标遗留的断点文件。
 *
 * 更新包文件名会随版本变化，每次版本升级都可能留下上一版的续传文件；这些文件
 * 已按总长度预分配，长期累积会占用可观磁盘空间。同一时刻只有一个更新下载，
 * 因此只保留本次目标对应的文件名。
 * @param resumeDirectory 续传文件所在目录。
 * @param keepFileName 本次下载需要保留的文件名。
 * @returns 清理完成后的 Promise。
 * @author zhenghq
 */
async function clearStaleResumeEntries(
  resumeDirectory: string,
  keepFileName: string
): Promise<void> {
  const entries = await readdir(resumeDirectory).catch(() => [])
  const keepFileNames = new Set([
    keepFileName,
    `${keepFileName}.json`,
    `${keepFileName}.json.tmp`
  ])
  await Promise.all(entries
    .filter((entry) => !keepFileNames.has(entry))
    .map((entry) => rm(join(resumeDirectory, entry), { recursive: true, force: true })
      .catch(() => undefined)))
}

/**
 * 预分配完整安装包文件，允许多个分片按各自偏移并发写入。
 *
 * electron-updater 会优先复用上一次未清理的临时文件；Windows 上该文件可能被
 * 安全软件、索引器或同步盘占用。若发生 EPERM/EACCES/EBUSY，说明当前无法安全
 * 复用该临时文件做随机写入；此时回退 electron-updater 原生下载，由其重新处理
 * 临时文件，而不是让整次更新直接失败。
 *
 * @param destination electron-updater 提供的临时目标文件。
 * @param total 安装包总字节数。
 * @param preserveExisting 为 true 时保留文件已有内容，仅把长度对齐到总字节数，
 * 供断点续传场景使用；为 false 时重新预分配空文件。
 * @returns 文件可用时返回 true；无法安全复用时返回 false。
 * @author zhenghq
 */
async function ensureFileSize(
  destination: string,
  total: number,
  preserveExisting = false
): Promise<boolean> {
  let fileHandle: FileHandle | undefined
  try {
    if (preserveExisting) {
      try {
        fileHandle = await open(destination, 'r+')
      } catch {
        fileHandle = await open(destination, 'w+')
      }
      const info = await fileHandle.stat()
      if (info.size !== total) await fileHandle.truncate(total)
    } else {
      fileHandle = await open(destination, 'w+')
      await fileHandle.truncate(total)
    }
    return true
  } catch (error) {
    if (!isTransientWindowsLockError(error)) throw error
    logElectronUpdaterWarning(
      `无法截断更新临时文件，将回退原生下载：${normalizeErrorMessage(error)}`
    )
    return false
  } finally {
    await fileHandle?.close().catch(() => undefined)
  }
}

/**
 * 判断错误是否为 Windows 上可能自动恢复的临时文件占用错误。
 * @param error 文件操作抛出的异常。
 * @returns 是否为可回退处理的文件占用错误。
 * @author zhenghq
 */
function isTransientWindowsLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /EPERM|EACCES|EBUSY/u.test(error.message)
}

/**
 * 将未知错误转换为安全的日志文本。
 * @param error 需要记录的异常。
 * @returns 去除首尾空白后的错误消息。
 * @author zhenghq
 */
function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error)
}

/**
 * 输出 electron-updater 可见的警告日志，便于诊断 Windows 临时文件占用。
 * @param message 需要记录的警告内容。
 * @returns 无返回值。
 * @author zhenghq
 */
function logElectronUpdaterWarning(message: string): void {
  console.warn(`[electron-updater] ${message}`)
}

/**
 * 计算并行下载结果的 base64 sha512 摘要。
 * @param path 已完成下载的文件路径。
 * @returns base64 编码的 sha512 字符串。
 * @author zhenghq
 */
async function computeFileSha512(path: string): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('base64')
}

/**
 * 计算并行下载结果的十六进制 sha256 摘要。
 * @param path 已完成下载的文件路径。
 * @returns 十六进制编码的 sha256 字符串。
 * @author zhenghq
 */
async function computeFileSha2(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/**
 * 判断 electron-updater 提供的 sha512 是否采用十六进制编码。
 * @param sha512 更新清单中的 sha512 期望值。
 * @returns 是否应按十六进制摘要比较。
 * @author zhenghq
 */
function isHexSha512(sha512: string): boolean {
  return sha512.length === 128 &&
    !sha512.includes('+') &&
    !sha512.includes('Z') &&
    !sha512.includes('=')
}

/**
 * 校验并行下载文件摘要，防止分片聚合结果绕过 electron-updater 的完整性检查。
 * @param destination 已完成下载的文件路径。
 * @param options electron-updater 传入的期望摘要。
 * @param expectedSize 下载源声明的更新包长度。
 * @returns 无返回值。
 * @throws 文件长度或摘要不匹配时抛出异常。
 * @author zhenghq
 */
async function verifyParallelDownload(
  destination: string,
  options: DownloadOptions,
  expectedSize: number
): Promise<void> {
  const actualSize = await stat(destination).then((info) => info.size).catch(() => 0)
  if (actualSize !== expectedSize) {
    throw new Error(`更新包长度校验失败，期望 ${expectedSize} 字节，实际 ${actualSize} 字节`)
  }
  if (options.sha512 != null) {
    const actual = await computeFileSha512(destination)
    const expected = options.sha512
    const matches = isHexSha512(expected)
      ? actual === Buffer.from(expected, 'hex').toString('base64')
      : actual === expected
    if (!matches) throw new Error('sha512 checksum mismatch')
  } else if (options.sha2 != null) {
    if (await computeFileSha2(destination) !== options.sha2) {
      throw new Error('sha256 checksum mismatch')
    }
  }
}

/**
 * 探测下载源是否支持字节范围请求。
 * @param fetcher 网络请求函数。
 * @param url 安装包下载地址。
 * @param headers electron-updater 要求的请求头。
 * @returns 是否支持分片以及安装包总字节数。
 * @author zhenghq
 */
async function probeRangeSupport(
  fetcher: UpdateDownloadFetch,
  url: URL,
  headers: Record<string, string>
): Promise<{ supported: boolean; total: number }> {
  try {
    const response = await fetcher(url.toString(), {
      headers: { ...headers, range: 'bytes=0-0' }
    })
    // 尽快关闭探测响应体。若服务器忽略 Range 并返回 200，不能把完整安装包
    // 消费一遍后再回退单流下载，否则会重现“下载完成后又重新下载”的体验。
    if (response.body) {
      await response.body.cancel().catch(() => undefined)
    } else {
      await response.arrayBuffer().catch(() => undefined)
    }
    return parseRangeProbe({
      status: response.status,
      acceptRanges: response.headers.get('accept-ranges'),
      contentRange: response.headers.get('content-range')
    })
  } catch {
    return { supported: false, total: 0 }
  }
}

/**
 * 为 electron-updater 安装 Range 分片并发下载。
 * 只有下载源明确支持字节范围时才并发；否则回退 electron-updater 原生单流下载。
 * @param updater 当前平台的 electron-updater 实例。
 * @param fetcher 网络请求函数，使用已应用代理设置的更新下载会话。
 * @returns 无返回值。
 * @author zhenghq
 */
export function installParallelUpdateDownload(
  updater: AppUpdater,
  fetcher: UpdateDownloadFetch
): void {
  const updaterWithExecutor = updater as UpdaterWithHttpExecutor
  const executor = updaterWithExecutor.httpExecutor
  if (!executor?.download) return

  const fullDownload: FullDownload = executor.download.bind(executor)
  executor.download = async (
    url: URL,
    destination: string,
    options: DownloadOptions
  ): Promise<string> => {
    const headers = buildFetchHeaders(options)
    const probe = await probeRangeSupport(fetcher, url, headers)
    if (!probe.supported || probe.total <= 0) {
      return fullDownload(url, destination, options)
    }
    const plannedSegments = planDownloadSegments(probe.total, MAX_DOWNLOAD_CONCURRENCY)
    if (plannedSegments.length <= 1) {
      return fullDownload(url, destination, options)
    }

    // electron-updater 会在每次下载前删除 destination，并把失败后的 pending
    // 目录整体清空，因此断点必须落在独立的 resume 目录中才能跨进程保留。
    const resumeBasePath = resolveResumeBasePath(destination)
    const resumePath = resumeTemporaryPath(resumeBasePath)
    await mkdir(dirname(resumePath), { recursive: true })
    await clearStaleResumeEntries(dirname(resumePath), basename(resumePath))
    const resumeRecord = await loadDownloadResumeState(resumeBasePath, {
      total: probe.total,
      ...(options.sha512 != null ? { sha512: options.sha512 } : {}),
      ...(options.sha2 != null ? { sha2: options.sha2 } : {})
    })
    const segments = resumeRecord?.segments ?? plannedSegments
    if (!resumeRecord) await clearDownloadResumeState(resumeBasePath)

    const fileReady = await ensureFileSize(resumePath, probe.total, resumeRecord != null)
    if (!fileReady) {
      // 续传文件被安全软件或索引器短暂占用时回退原生单流下载，但保留已有断点，
      // 下次重试仍可继续；直接删除会让用户丢掉已经下载的字节。
      return fullDownload(url, destination, options)
    }

    const resumeRecordForWrite = (): DownloadResumeRecord => ({
      total: probe.total,
      ...(options.sha512 != null ? { sha512: options.sha512 } : {}),
      ...(options.sha2 != null ? { sha2: options.sha2 } : {}),
      segments
    })

    try {
      await downloadSegments({
        url: url.toString(),
        temporaryPath: resumePath,
        total: probe.total,
        segments,
        concurrency: MAX_DOWNLOAD_CONCURRENCY,
        fetch: fetcher,
        headers,
        signal: createAbortSignalFromToken(options.cancellationToken),
        onProgress: (progress) => reportElectronProgress(progress, options.onProgress),
        onCheckpoint: () => saveDownloadResumeState(resumeBasePath, resumeRecordForWrite())
      })
      await verifyParallelDownload(resumePath, options, probe.total)
      // 校验通过后才把稳定续传文件交给 electron-updater 期望的目标路径，
      // 避免校验失败的半成品被 electron-updater 当作已完成下载复用。
      await rm(destination, { force: true }).catch(() => undefined)
      await rename(resumePath, destination)
      await clearDownloadResumeState(resumeBasePath)
    } catch (error) {
      // 保留续传文件与进度记录，用户重试时从已完成偏移继续；校验失败说明
      // 已有字节不可信，此时必须整体丢弃后重新下载。
      if (error instanceof Error && /checksum mismatch|更新包长度校验失败/u.test(error.message)) {
        await clearDownloadResumeState(resumeBasePath)
      } else {
        await saveDownloadResumeState(resumeBasePath, resumeRecordForWrite()).catch(() => undefined)
      }
      throw error
    }
    return destination
  }
}
