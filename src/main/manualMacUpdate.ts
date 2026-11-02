import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { UpdateProgress } from '../shared/types'
import { compareSemanticVersions } from '../shared/updateAvailability'
import { MACOS_APPLICATION_PATH } from './macQuarantine'
import { translateMain } from './messages'
import { createUpdateProgressReporter } from './updateDownloadProgress'
import { createUpdateDownloadError } from './updateDownloadError'
import {
  clearDownloadResumeState,
  loadDownloadResumeState,
  resumeTemporaryPath,
  saveDownloadResumeState
} from './updateDownloadResume'
import type { DownloadResumeSegment } from './updateDownloadResume'
import {
  downloadSegments,
  parseRangeProbe,
  planDownloadSegments,
  MAX_DOWNLOAD_CONCURRENCY
} from './updateRangeDownload'

/** electron-updater 更新清单中的可下载文件。 */
export interface ManualMacUpdateFile {
  /** 文件下载地址。 */
  url: string
  /** 该文件的 base64 sha512 校验值。 */
  sha512?: string
  /** 该文件的字节长度。 */
  size?: number
}

/**
 * 更新包下载使用的最小 fetch 契约。
 * 只接受字符串地址，便于注入 Electron 会话的 fetch 实现。
 * @author zhenghq
 */
export type UpdateDownloadFetch = (url: string, init?: RequestInit) => Promise<Response>

/** 解析出的手动 macOS 更新下载目标。 */
export interface ManualMacUpdateTarget {
  /** DMG 下载地址。 */
  url: string
  /** 该 DMG 的 base64 sha512 校验值；地址由 ZIP 推导时不存在。 */
  sha512?: string
  /** 该 DMG 的字节长度；地址由 ZIP 推导时不存在。 */
  size?: number
}

/** 手动 macOS 更新包下载完成后的结果。 */
export interface ManualMacUpdateResult {
  /** 已保存到本地的 DMG 路径。 */
  path: string
  /** 是否已通过 sha512 完整性校验。 */
  verified: boolean
  /** 是否已将自动替换任务交给后台 helper。 */
  installScheduled?: boolean
}

/** 手动 macOS 更新服务的依赖和本地保存选项。 */
export interface ManualMacUpdateServiceOptions {
  /** 系统“下载”文件夹路径。 */
  downloadsDirectory: string
  /** 使用系统默认程序打开 DMG，返回空字符串表示成功。 */
  openPath: (path: string) => Promise<string>
  /** 网络请求函数，必须由调用方注入应用统一代理会话的 fetch。 */
  fetch: UpdateDownloadFetch
  /** 当前 CPU 架构，用于生成可读的文件名。 */
  architecture?: string
  /** 当前平台；默认读取 process.platform，测试可覆盖。 */
  platform?: NodeJS.Platform
  /** 固定安装目标应用包路径；默认 /Applications/划词翻译.app。 */
  applicationPath?: string
  /** 期望的应用 Bundle ID；默认 com.selection.translator。 */
  expectedBundleId?: string
  /** 执行系统命令的函数；必须使用参数数组，不能经过 shell。 */
  runCommand?: (command: string, args: string[]) => Promise<void>
  /** 读取命令标准输出的函数；用于 plutil 与 codesign 校验。 */
  readCommand?: (command: string, args: string[]) => Promise<string>
  /** 启动后台 helper 的函数；默认分离子进程并忽略标准流。 */
  launchHelper?: (command: string, args: string[]) => void
}

/** 自动安装固定 macOS 应用所需的配置。 */
interface AutomaticMacInstallConfig {
  platform: NodeJS.Platform
  applicationPath: string
  expectedBundleId: string
  runCommand: (command: string, args: string[]) => Promise<void>
  readCommand: (command: string, args: string[]) => Promise<string>
  launchHelper: (command: string, args: string[]) => void
}

/** 手动 macOS 更新服务接口，供更新管理器和测试替换实现。 */
export interface ManualMacUpdateService {
  /**
   * 下载指定 DMG、校验完整性、保存到本地并打开安装界面。
   * @param url 已从更新清单获取的 DMG 下载地址。
   * @param version 更新版本号。
   * @param onProgress 下载进度回调。
   * @param integrity 更新清单提供的 sha512 校验值与文件长度。
   * @param signal 可选的取消信号；触发后下载中断并保留断点续传记录。
   * @returns 下载文件路径与校验结果的 Promise。
   * @author zhenghq
   */
  downloadAndOpen(
    url: string,
    version: string,
    onProgress?: (progress: UpdateProgress) => void,
    integrity?: { sha512?: string; size?: number },
    signal?: AbortSignal
  ): Promise<ManualMacUpdateResult>
  /**
   * 下载、校验并调度后台替换固定 macOS 应用；未满足安全条件时不得自动覆盖。
   * @param url 已从更新清单获取的 DMG 下载地址。
   * @param version 更新版本号。
   * @param currentVersion 当前应用版本。
   * @param onProgress 下载进度回调。
   * @param integrity 更新清单提供的 sha512 校验值与文件长度。
   * @param signal 可选的取消信号。
   * @returns 下载与安装调度结果；无法安全自动安装时返回 installScheduled=false。
   * @author zhenghq
   */
  downloadAndInstall?(
    url: string,
    version: string,
    currentVersion: string,
    onProgress?: (progress: UpdateProgress) => void,
    integrity?: { sha512?: string; size?: number },
    signal?: AbortSignal
  ): Promise<ManualMacUpdateResult>
}

/**
 * 将更新清单中的绝对地址或相对地址解析为可下载的 HTTPS URL。
 * @param rawUrl 更新清单中的原始文件地址。
 * @param baseUrl 解析相对地址时使用的 HTTPS 下载基准地址。
 * @returns 可下载的 HTTPS URL；地址无效、协议不安全或缺少相对地址基准时返回 undefined。
 * @author zhenghq
 */
function resolveHttpsUpdateFileUrl(rawUrl: string, baseUrl?: string): URL | undefined {
  try {
    const parsedUrl = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)
    return parsedUrl.protocol === 'https:' ? parsedUrl : undefined
  } catch {
    return undefined
  }
}

/**
 * 从更新清单中选择当前架构的 DMG 下载目标；清单只列 ZIP 时按同名规则推导 DMG 地址。
 * 只有命中清单中真实的 DMG 条目才携带 sha512 与 size，推导地址不携带校验信息。
 * @param files 更新清单中的文件列表。
 * @param architecture 当前 CPU 架构。
 * @param baseUrl 解析更新清单相对地址时使用的 HTTPS 下载基准地址。
 * @returns 当前架构优先的下载目标；没有可用 macOS 包时返回 undefined。
 * @author zhenghq
 */
export function resolveManualMacDmgTarget(
  files: ManualMacUpdateFile[],
  architecture: string,
  baseUrl?: string
): ManualMacUpdateTarget | undefined {
  const dmgFiles = files.filter((file) => /\.dmg(?:$|[?#])/iu.test(file.url))
  const architecturePattern = architecture === 'arm64'
    ? /(?:arm64|aarch64)/iu
    : /(?:x64|x86_64|amd64)/iu

  /**
   * 将清单中的真实 DMG 条目转换为携带校验信息的下载目标。
   * @param file 清单中的 DMG 条目。
   * @returns 下载目标；地址不可用时返回 undefined。
   * @author zhenghq
   */
  const buildVerifiedTarget = (file: ManualMacUpdateFile): ManualMacUpdateTarget | undefined => {
    const url = resolveHttpsUpdateFileUrl(file.url, baseUrl)?.toString()
    if (!url) return undefined
    const target: ManualMacUpdateTarget = { url }
    if (file.sha512) target.sha512 = file.sha512
    if (Number.isFinite(file.size) && (file.size as number) > 0) target.size = file.size
    return target
  }

  const directDmg = dmgFiles.find((file) => architecturePattern.test(file.url))
  if (directDmg) return buildVerifiedTarget(directDmg)

  const zipFiles = files.filter((file) => /\.zip(?:$|[?#])/iu.test(file.url))
  const zipFile = zipFiles.find((file) => architecturePattern.test(file.url)) ??
    (dmgFiles.length === 0 ? zipFiles[0] : undefined)
  if (!zipFile) {
    const fallbackDmg = dmgFiles[0]
    return fallbackDmg ? buildVerifiedTarget(fallbackDmg) : undefined
  }

  const parsedUrl = resolveHttpsUpdateFileUrl(zipFile.url, baseUrl)
  if (!parsedUrl) return undefined
  parsedUrl.pathname = parsedUrl.pathname.replace(/\.zip$/iu, '.dmg')
  // 推导出的 DMG 与 ZIP 校验值不对应，因此不携带 sha512 与 size。
  return { url: parsedUrl.toString() }
}

/**
 * 从更新清单中选择当前架构的 DMG 下载地址。
 * @param files 更新清单中的文件列表。
 * @param architecture 当前 CPU 架构。
 * @param baseUrl 解析更新清单相对地址时使用的 HTTPS 下载基准地址。
 * @returns 当前架构优先的 DMG 地址；没有可用 macOS 包时返回 undefined。
 * @author zhenghq
 */
export function resolveManualMacDmgUrl(
  files: ManualMacUpdateFile[],
  architecture: string,
  baseUrl?: string
): string | undefined {
  return resolveManualMacDmgTarget(files, architecture, baseUrl)?.url
}

/**
 * 校验下载地址并限制为 HTTPS，避免把不安全的资源交给下载器。
 * @param rawUrl 待校验的原始地址。
 * @returns 规范化后的 HTTPS URL。
 * @throws 地址格式或协议不符合要求时抛出异常。
 * @author zhenghq
 */
function validateHttpsUrl(rawUrl: string): URL {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw createUpdateDownloadError(
      'invalid-url',
      translateMain('update.downloadError.invalidUrl')
    )
  }
  if (parsedUrl.protocol !== 'https:') {
    throw createUpdateDownloadError(
      'insecure-url',
      translateMain('update.downloadError.insecureUrl')
    )
  }
  return parsedUrl
}

/**
 * 校验初始手动更新地址必须指向 DMG 文件。
 * @param rawUrl 待校验的原始地址。
 * @returns 规范化后的 HTTPS DMG 地址。
 * @throws 地址格式、协议或扩展名不符合要求时抛出异常。
 * @author zhenghq
 */
function validateDmgUrl(rawUrl: string): string {
  const parsedUrl = validateHttpsUrl(rawUrl)
  if (!parsedUrl.pathname.toLowerCase().endsWith('.dmg')) {
    throw createUpdateDownloadError(
      'not-dmg',
      translateMain('update.downloadError.notDmg')
    )
  }
  return parsedUrl.toString()
}

/**
 * 将版本号转换为安全的本地文件名片段，阻止路径穿越并保留可读性。
 * @param value 原始版本号或架构名。
 * @returns 可安全拼接到文件名中的文本。
 * @author zhenghq
 */
function sanitizeFileNamePart(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/\.{2,}/gu, '_')
    .replace(/^\.+/u, '_')
  return sanitized || 'unknown'
}

/**
 * 为当前版本生成固定且不会逃逸 Downloads 目录的 DMG 路径。
 * @param downloadsDirectory 系统“下载”文件夹路径。
 * @param version 更新版本号。
 * @param architecture 当前 CPU 架构。
 * @returns DMG 目标路径。
 * @author zhenghq
 */
function buildDmgPath(downloadsDirectory: string, version: string, architecture: string): string {
  const filename = `SelectionTranslator-${sanitizeFileNamePart(version)}-mac-${sanitizeFileNamePart(architecture)}.dmg`
  return join(downloadsDirectory, basename(filename))
}

/**
 * 计算本地文件的 base64 sha512 摘要。
 * @param path 待计算的文件路径。
 * @returns base64 编码的 sha512 摘要。
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
 * 从响应头解析更新包总长度，优先使用 Content-Range 中的完整长度。
 * @param response 网络响应。
 * @param alreadyCompleted 续传场景下已完成的字节数。
 * @returns 更新包总字节数；无法解析时返回 0。
 * @author zhenghq
 */
function resolveResponseTotal(response: Response, alreadyCompleted: number): number {
  const contentRange = response.headers.get('content-range')
  const rangeTotal = contentRange ? Number(/\/(\d+)\s*$/u.exec(contentRange)?.[1]) : Number.NaN
  if (Number.isFinite(rangeTotal) && rangeTotal > 0) return rangeTotal
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (!Number.isFinite(contentLength) || contentLength <= 0) return 0
  return contentLength + alreadyCompleted
}

/**
 * 按顺序跟随 HTTPS 重定向发起下载请求。
 * @param fetcher 注入的网络请求函数。
 * @param initialUrl 初始下载地址。
 * @param headers 请求头，包含续传使用的 Range。
 * @param signal 可选的取消信号，透传给 fetch 以中断网络请求。
 * @returns 最终响应。
 * @throws 重定向缺少目标地址、次数过多或响应失败时抛出异常。
 * @author zhenghq
 */
async function requestWithRedirects(
  fetcher: UpdateDownloadFetch,
  initialUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<Response> {
  let currentUrl = initialUrl
  let response: Response | undefined
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetcher(currentUrl, { redirect: 'manual', headers, signal })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    if (!location) {
      throw createUpdateDownloadError(
        'redirect-missing-location',
        translateMain('update.downloadError.redirectMissingLocation')
      )
    }
    currentUrl = validateHttpsUrl(new URL(location, currentUrl).toString()).toString()
    if (redirectCount === 5) {
      throw createUpdateDownloadError(
        'too-many-redirects',
        translateMain('update.downloadError.tooManyRedirects')
      )
    }
  }
  if (!response || !response.ok) {
    throw createUpdateDownloadError(
      'download-http-failed',
      translateMain('update.downloadError.downloadHttpFailed', {
        status: response?.status ?? translateMain('update.downloadError.unknownStatus')
      })
    )
  }
  return response
}

/**
 * 将响应体写入临时文件，支持从已完成偏移追加写入。
 * @param response 网络响应。
 * @param temporaryPath 临时文件路径。
 * @param startOffset 写入起始偏移，续传时为已完成字节数。
 * @param reporter 进度聚合器。
 * @param signal 可选的取消信号，触发后中断读取循环。
 * @returns 写入完成后的 Promise。
 * @author zhenghq
 */
async function writeResponseToTemporaryFile(
  response: Response,
  temporaryPath: string,
  startOffset: number,
  reporter: ReturnType<typeof createUpdateProgressReporter>,
  signal?: AbortSignal
): Promise<void> {
  const fileHandle = await open(temporaryPath, startOffset > 0 ? 'r+' : 'w')
  let position = startOffset
  try {
    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        if (signal?.aborted) {
          throw createUpdateDownloadError(
            'cancelled',
            translateMain('update.downloadError.cancelled')
          )
        }
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value) continue
        await fileHandle.write(chunk.value, 0, chunk.value.byteLength, position)
        position += chunk.value.byteLength
        reporter.add(chunk.value.byteLength)
      }
    } else {
      const content = new Uint8Array(await response.arrayBuffer())
      await fileHandle.write(content, 0, content.byteLength, position)
      position += content.byteLength
      reporter.add(content.byteLength)
    }
  } finally {
    await fileHandle.close().catch(() => undefined)
  }
}

/**
 * 探测下载源是否支持字节范围请求，用于决定能否分片并发下载。
 * 探测请求本身失败时视为不支持，调用方回退单流下载。
 * @param fetcher 注入的网络请求函数。
 * @param url 更新包下载地址。
 * @param manifestSize 更新清单声明的文件长度。
 * @returns 是否支持分片以及可信的更新包总长度。
 * @author zhenghq
 */
async function probeRangeSupport(
  fetcher: UpdateDownloadFetch,
  url: string,
  manifestSize?: number
): Promise<{ supported: boolean; total: number }> {
  try {
    const response = await fetcher(url, { headers: { range: 'bytes=0-0' } })
    // 读完响应体避免连接悬挂。
    await response.arrayBuffer().catch(() => undefined)
    return parseRangeProbe({
      status: response.status,
      acceptRanges: response.headers.get('accept-ranges'),
      contentRange: response.headers.get('content-range'),
      manifestSize
    })
  } catch {
    return { supported: false, total: 0 }
  }
}

/**
 * 为临时文件预分配到指定长度，便于分片按偏移写入。
 * @param temporaryPath 临时文件路径。
 * @param total 更新包总字节数。
 * @returns 预分配完成后的 Promise。
 * @author zhenghq
 */
async function ensureTemporaryFileSize(temporaryPath: string, total: number): Promise<void> {
  const fileHandle = await open(temporaryPath, 'a+')
  try {
    await fileHandle.truncate(total)
  } finally {
    await fileHandle.close().catch(() => undefined)
  }
}

/**
 * 完成下载收尾：校验摘要、原子替换目标文件、清理进度记录并打开安装界面。
 * 单流与分片两条下载路径共用该逻辑。
 * @param params 目标路径、临时文件路径、期望摘要与打开器。
 * @returns 下载结果，包含最终路径与是否已通过完整性校验。
 * @throws 摘要不匹配或无法打开 DMG 时抛出异常。
 * @author zhenghq
 */
async function finalizeDownload(params: {
  destination: string
  temporaryPath: string
  sha512?: string
  openPath: (path: string) => Promise<string>
}): Promise<ManualMacUpdateResult> {
  if (params.sha512) {
    const actualSha512 = await computeFileSha512(params.temporaryPath)
    if (actualSha512 !== params.sha512) {
      await clearDownloadResumeState(params.destination)
      await rm(params.destination, { force: true }).catch(() => undefined)
      throw createUpdateDownloadError(
        'integrity-failed',
        translateMain('update.downloadError.integrityFailed')
      )
    }
  }

  await rename(params.temporaryPath, params.destination)
  await clearDownloadResumeState(params.destination)

  const openError = await params.openPath(params.destination)
  if (openError) {
    throw createUpdateDownloadError(
      'open-failed',
      translateMain('update.downloadError.openFailed', { message: openError })
    )
  }
  return { path: params.destination, verified: Boolean(params.sha512) }
}

/**
 * 下载并校验 macOS DMG，按更新清单声明的大小与摘要复用断点续传记录。
 * @param params 下载地址、版本、下载目录、架构、进度、完整性与取消信号。
 * @returns 已保存并通过可选完整性校验的 DMG 结果。
 * @throws 地址无效、下载失败或摘要不匹配时抛出异常。
 * @author zhenghq
 */
async function downloadVerifiedMacDmg(params: {
  url: string
  version: string
  onProgress?: (progress: UpdateProgress) => void
  integrity?: { sha512?: string; size?: number }
  signal?: AbortSignal
  downloadsDirectory: string
  architecture: string
  fetcher: UpdateDownloadFetch
}): Promise<ManualMacUpdateResult> {
  // 取消信号到达时主动中断后续网络与写入流程。
  const throwIfAborted = (): void => {
    if (params.signal?.aborted) {
      throw createUpdateDownloadError(
        'cancelled',
        translateMain('update.downloadError.cancelled')
      )
    }
  }
  throwIfAborted()
  const validatedUrl = validateDmgUrl(params.url)
  const destination = buildDmgPath(params.downloadsDirectory, params.version, params.architecture)
  const temporaryPath = resumeTemporaryPath(destination)
  await mkdir(params.downloadsDirectory, { recursive: true })

  // 只有版本、总长度与校验值三者一致时才复用上次下载进度。
  const expectedTotal = params.integrity?.size ?? 0
  const resumeRecord = expectedTotal > 0
    ? await loadDownloadResumeState(destination, {
      version: params.version,
      total: expectedTotal,
      sha512: params.integrity?.sha512
    })
    : undefined
  const completedBytes = resumeRecord
    ? resumeRecord.segments.reduce((sum, segment) => sum + segment.completed, 0)
    : 0
  if (!resumeRecord) await clearDownloadResumeState(destination)

  const headers: Record<string, string> = {}
  if (completedBytes > 0) headers['range'] = `bytes=${completedBytes}-`

  // 只有更新包大到能切出多个分片时才值得探测 Range，避免为小文件多付一次往返。
  const plannedSegments = planDownloadSegments(expectedTotal, MAX_DOWNLOAD_CONCURRENCY)
  const probe = plannedSegments.length > 1
    ? await probeRangeSupport(params.fetcher, validatedUrl, expectedTotal)
    : { supported: false, total: 0 }

  if (probe.supported && probe.total > 0) {
    const segments: DownloadResumeSegment[] = resumeRecord?.segments.length
      ? resumeRecord.segments
      : probe.total === expectedTotal
        ? plannedSegments
        : planDownloadSegments(probe.total, MAX_DOWNLOAD_CONCURRENCY)
    await ensureTemporaryFileSize(temporaryPath, probe.total)
    try {
      await downloadSegments({
        url: validatedUrl,
        temporaryPath,
        total: probe.total,
        segments,
        concurrency: MAX_DOWNLOAD_CONCURRENCY,
        fetch: params.fetcher,
        onProgress: params.onProgress,
        signal: params.signal
      })
    } catch (error) {
      // 保留各分片已完成偏移，供用户重试时继续下载。
      await saveDownloadResumeState(destination, {
        version: params.version,
        total: probe.total,
        ...(params.integrity?.sha512 ? { sha512: params.integrity.sha512 } : {}),
        segments
      })
      throw error
    }
    return finalizeDownload({
      destination,
      temporaryPath,
      sha512: params.integrity?.sha512,
      openPath: async () => ''
    })
  }

  const reporter = createUpdateProgressReporter({
    total: expectedTotal,
    onProgress: params.onProgress
  })
  reporter.start(completedBytes)

  // 请求失败时保留临时文件与进度记录，供用户重试时继续下载。
  const response = await requestWithRedirects(
    params.fetcher,
    validatedUrl,
    headers,
    params.signal
  )

  // 服务端忽略 Range 时会返回 200 并重新发送整包，此时必须从头写入。
  const startOffset = completedBytes > 0 && response.status === 206 ? completedBytes : 0
  if (startOffset === 0 && completedBytes > 0) {
    reporter.start(0)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  reporter.setTotal(resolveResponseTotal(response, startOffset))

  try {
    await writeResponseToTemporaryFile(
      response,
      temporaryPath,
      startOffset,
      reporter,
      params.signal
    )
  } catch (error) {
    const total = expectedTotal > 0 ? expectedTotal : 0
    const written = await stat(temporaryPath).then((info) => info.size).catch(() => 0)
    if (total > 0 && written > 0) {
      await saveDownloadResumeState(destination, {
        version: params.version,
        total,
        ...(params.integrity?.sha512 ? { sha512: params.integrity.sha512 } : {}),
        segments: [{ start: 0, end: total - 1, completed: written }]
      })
    } else {
      await clearDownloadResumeState(destination)
    }
    throw error
  }

  reporter.setTotal(reporter.getTransferred())
  reporter.finish()
  return finalizeDownload({
    destination,
    temporaryPath,
    sha512: params.integrity?.sha512,
    openPath: async () => ''
  })
}

/**
 * 生成后台安装 helper 的固定 shell 脚本。
 * 脚本只接收已校验的固定路径，使用参数数组调用，不拼接外部输入。
 * @returns 可交给 /bin/sh 执行的安装脚本。
 * @author zhenghq
 */
export function buildMacOSAutomaticInstallScript(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'parent_pid="$1"',
    'staged_app="$2"',
    'target_app="$3"',
    'backup_app="$4"',
    'while kill -0 "$parent_pid" 2>/dev/null; do sleep 1; done',
    'if [ -e "$backup_app" ]; then rm -rf "$backup_app"; fi',
    'restore() {',
    '  if [ -e "$backup_app" ] && [ ! -e "$target_app" ]; then mv "$backup_app" "$target_app"; fi',
    '}',
    'trap restore EXIT HUP INT TERM',
    'if [ -e "$target_app" ]; then mv "$target_app" "$backup_app"; fi',
    'mv "$staged_app" "$target_app"',
    'trap - EXIT HUP INT TERM',
    '/usr/bin/xattr -dr com.apple.quarantine "$target_app" >/dev/null 2>&1 || true',
    '/usr/bin/open "$target_app"',
    'rm -rf "$backup_app"'
  ].join('\n')
}

/**
 * 在临时目录创建可执行的安装 helper 脚本。
 * @returns helper 脚本路径。
 * @author zhenghq
 */
async function createMacOSAutomaticInstallHelper(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-update-'))
  const helperPath = join(directory, 'install-update.sh')
  const { writeFile, chmod } = await import('node:fs/promises')
  await writeFile(helperPath, buildMacOSAutomaticInstallScript(), { mode: 0o700 })
  await chmod(helperPath, 0o700)
  return helperPath
}

/**
 * 默认执行命令并等待成功退出。
 * @param command 命令绝对路径。
 * @param args 参数数组。
 * @returns 命令成功后的 Promise。
 * @author zhenghq
 */
async function runSystemCommand(command: string, args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)(command, args)
}

/**
 * 默认执行命令并返回标准输出。
 * @param command 命令绝对路径。
 * @param args 参数数组。
 * @returns 命令标准输出。
 * @author zhenghq
 */
async function readSystemCommand(command: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const result = await promisify(execFile)(command, args)
  return result.stdout
}

/**
 * 默认分离启动 helper，确保父应用退出后脚本继续运行。
 * @param command helper 命令。
 * @param args helper 参数数组。
 * @returns 无返回值。
 * @author zhenghq
 */
function launchDetachedHelper(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

/**
 * 从挂载的 DMG 中寻找唯一可自动安装的 .app 应用包。
 * @param mountPath DMG 挂载目录。
 * @returns 唯一 .app 的绝对路径。
 * @throws 找不到或多个 .app 时抛出异常。
 * @author zhenghq
 */
async function resolveMountedApplication(mountPath: string): Promise<string> {
  const entries = await readdir(mountPath, { withFileTypes: true })
  const apps = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => join(mountPath, entry.name))
  if (apps.length !== 1) {
    throw createUpdateDownloadError(
      'install-failed',
      translateMain('update.downloadError.installFailedUniqueApp')
    )
  }
  return apps[0]
}

/**
 * 校验 DMG 内应用包的身份、版本与代码签名。
 * @param appPath 挂载点内的应用包路径。
 * @param version 期望的更新版本。
 * @param currentVersion 当前应用版本。
 * @param config 固定安装配置。
 * @returns 校验完成后的 Promise。
 * @throws 应用身份、版本或签名不符合要求时抛出异常。
 * @author zhenghq
 */
async function validateMountedApplication(
  appPath: string,
  version: string,
  currentVersion: string,
  config: AutomaticMacInstallConfig
): Promise<void> {
  const infoPlist = join(appPath, 'Contents', 'Info.plist')
  const bundleId = (await config.readCommand('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist
  ])).trim()
  const appVersion = (await config.readCommand('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist
  ])).trim()
  if (bundleId !== config.expectedBundleId) {
    throw createUpdateDownloadError(
      'install-failed',
      translateMain('update.downloadError.installFailedBundleId')
    )
  }
  if (compareSemanticVersions(appVersion, currentVersion) !== 1 || appVersion !== version) {
    throw createUpdateDownloadError(
      'install-failed',
      translateMain('update.downloadError.installFailedVersion')
    )
  }
  await config.runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}

/**
 * 下载并自动安装固定 macOS 应用。
 * @param params 下载地址、版本、当前版本、进度、完整性与取消信号。
 * @param config 固定安装配置。
 * @returns 自动安装调度结果。
 * @throws 下载、校验或调度失败时抛出异常。
 * @author zhenghq
 */
async function downloadAndScheduleMacOSInstall(params: {
  url: string
  version: string
  currentVersion: string
  onProgress?: (progress: UpdateProgress) => void
  integrity?: { sha512?: string; size?: number }
  signal?: AbortSignal
  downloadsDirectory: string
  architecture: string
  fetcher: UpdateDownloadFetch
}, config: AutomaticMacInstallConfig): Promise<ManualMacUpdateResult> {
  if (config.platform !== 'darwin') {
    throw createUpdateDownloadError(
      'install-failed',
      translateMain('update.downloadError.installFailedUnsupportedPlatform')
    )
  }
  if (config.applicationPath !== MACOS_APPLICATION_PATH) {
    throw createUpdateDownloadError(
      'install-failed',
      translateMain('update.downloadError.installFailedUnsupportedPath', {
        path: MACOS_APPLICATION_PATH
      })
    )
  }
  if (!params.integrity?.sha512) {
    throw createUpdateDownloadError(
      'integrity-failed',
      translateMain('update.downloadError.integrityFailed')
    )
  }
  const download = await downloadVerifiedMacDmg(params)

  const mountPath = await mkdtemp(join(tmpdir(), 'selection-translator-dmg-'))
  try {
    await config.runCommand('/usr/bin/hdiutil', [
      'attach', '-nobrowse', '-readonly', '-mountpoint', mountPath, download.path
    ])
    const mountedApp = await resolveMountedApplication(mountPath)
    await validateMountedApplication(mountedApp, params.version, params.currentVersion, config)
    const targetStem = config.applicationPath.replace(/\.app$/u, '')
    const stagedApp = `${targetStem}.update-staged.app`
    const backupApp = `${targetStem}.update-backup.app`
    await rm(stagedApp, { recursive: true, force: true })
    await config.runCommand('/usr/bin/ditto', [mountedApp, stagedApp])
    const helperPath = await createMacOSAutomaticInstallHelper()
    config.launchHelper('/bin/sh', [
      helperPath,
      String(process.pid),
      stagedApp,
      config.applicationPath,
      backupApp
    ])
    return { path: download.path, verified: true, installScheduled: true }
  } finally {
    await config.runCommand('/usr/bin/hdiutil', ['detach', mountPath]).catch(() => undefined)
    await rm(mountPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 创建手动 macOS DMG 下载、校验、保存和打开服务。
 * @param options 下载目录、打开器和网络请求依赖。
 * @returns 可注入更新管理器的手动更新服务。
 * @author zhenghq
 */
export function createManualMacUpdateService(
  options: ManualMacUpdateServiceOptions
): ManualMacUpdateService {
  const fetcher = options.fetch
  const architecture = options.architecture ?? process.arch
  const platform = options.platform ?? process.platform
  const applicationPath = options.applicationPath ?? MACOS_APPLICATION_PATH
  const expectedBundleId = options.expectedBundleId ?? 'com.selection.translator'
  const runCommand = options.runCommand ?? runSystemCommand
  const readCommand = options.readCommand ?? readSystemCommand
  const launchHelper = options.launchHelper ?? launchDetachedHelper
  let installScheduled = false
  let scheduledResult: ManualMacUpdateResult | undefined

  return {
    /**
     * 下载指定 DMG、校验完整性、保存到 Downloads 并交给 Finder 打开。
     * @param url 已从更新清单获取的 DMG 下载地址。
     * @param version 更新版本号。
    * @param onProgress 下载进度回调。
     * @param integrity 更新清单提供的 sha512 校验值与文件长度。
     * @param signal 可选的取消信号；触发后下载中断并保留断点续传记录。
     * @returns 下载文件路径与校验结果的 Promise。
     * @author zhenghq
     */
    async downloadAndOpen(
      url: string,
      version: string,
      onProgress?: (progress: UpdateProgress) => void,
      integrity?: { sha512?: string; size?: number },
      signal?: AbortSignal
    ): Promise<ManualMacUpdateResult> {
      const download = await downloadVerifiedMacDmg({
        url,
        version,
        onProgress,
        integrity,
        signal,
        downloadsDirectory: options.downloadsDirectory,
        architecture,
        fetcher
      })
      const openError = await options.openPath(download.path)
      if (openError) {
        throw createUpdateDownloadError(
          'open-failed',
          translateMain('update.downloadError.openFailed', { message: openError })
        )
      }
      return download
    },

    /**
     * 下载、校验并调度后台替换固定 Applications 应用。
     * @param url 已从更新清单获取的 DMG 下载地址。
     * @param version 更新版本号。
     * @param currentVersion 当前应用版本。
     * @param onProgress 下载进度回调。
     * @param integrity 更新清单提供的 sha512 校验值与文件长度。
     * @param signal 可选的取消信号。
     * @returns 自动安装调度结果。
     * @author zhenghq
     */
    async downloadAndInstall(
      url: string,
      version: string,
      currentVersion: string,
      onProgress?: (progress: UpdateProgress) => void,
      integrity?: { sha512?: string; size?: number },
      signal?: AbortSignal
    ): Promise<ManualMacUpdateResult> {
      if (installScheduled && scheduledResult) return scheduledResult
      const result = await downloadAndScheduleMacOSInstall({
        url,
        version,
        currentVersion,
        onProgress,
        integrity,
        signal,
        downloadsDirectory: options.downloadsDirectory,
        architecture,
        fetcher
      }, {
        platform,
        applicationPath,
        expectedBundleId,
        runCommand,
        readCommand,
        launchHelper
      })
      if (result.installScheduled) {
        installScheduled = true
        scheduledResult = result
      }
      return result
    }
  }
}
