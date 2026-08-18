import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { UpdateProgress } from '../shared/types'

/** electron-updater 更新清单中的可下载文件。 */
export interface ManualMacUpdateFile {
  /** 文件下载地址。 */
  url: string
}

/** 手动 macOS 更新包下载完成后的结果。 */
export interface ManualMacUpdateResult {
  /** 已保存到本地的 DMG 路径。 */
  path: string
}

/** 手动 macOS 更新服务的依赖和本地保存选项。 */
export interface ManualMacUpdateServiceOptions {
  /** 系统“下载”文件夹路径。 */
  downloadsDirectory: string
  /** 使用系统默认程序打开 DMG，返回空字符串表示成功。 */
  openPath: (path: string) => Promise<string>
  /** 可注入的网络请求函数，生产环境默认使用全局 fetch。 */
  fetch?: typeof fetch
  /** 当前 CPU 架构，用于生成可读的文件名。 */
  architecture?: string
}

/** 手动 macOS 更新服务接口，供更新管理器和测试替换实现。 */
export interface ManualMacUpdateService {
  /**
   * 下载指定 DMG、保存到本地并打开安装界面。
   * @param url 已从更新清单获取的 DMG 下载地址。
   * @param version 更新版本号。
   * @param onProgress 下载进度回调。
   * @returns 下载文件路径的 Promise。
   * @author zhenghq
   */
  downloadAndOpen(
    url: string,
    version: string,
    onProgress?: (progress: UpdateProgress) => void
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
 * 从更新清单中选择当前架构的 DMG；清单只列 ZIP 时按同名规则推导 DMG 地址。
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
  const dmgFiles = files.filter((file) => /\.dmg(?:$|[?#])/iu.test(file.url))
  const architecturePattern = architecture === 'arm64'
    ? /(?:arm64|aarch64)/iu
    : /(?:x64|x86_64|amd64)/iu
  const directDmg = dmgFiles.find((file) => architecturePattern.test(file.url))
  if (directDmg) return resolveHttpsUpdateFileUrl(directDmg.url, baseUrl)?.toString()

  const zipFiles = files.filter((file) => /\.zip(?:$|[?#])/iu.test(file.url))
  const zipFile = zipFiles.find((file) => architecturePattern.test(file.url)) ??
    (dmgFiles.length === 0 ? zipFiles[0] : undefined)
  if (!zipFile) {
    const fallbackDmg = dmgFiles[0]
    return fallbackDmg
      ? resolveHttpsUpdateFileUrl(fallbackDmg.url, baseUrl)?.toString()
      : undefined
  }
  const parsedUrl = resolveHttpsUpdateFileUrl(zipFile.url, baseUrl)
  if (!parsedUrl) return undefined
  parsedUrl.pathname = parsedUrl.pathname.replace(/\.zip$/iu, '.dmg')
  return parsedUrl.toString()
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
    throw new Error('DMG 下载地址格式无效')
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('DMG 下载只支持 HTTPS 地址')
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
    throw new Error('更新下载地址必须是 DMG 文件')
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
    .replace(/[^a-zA-Z0-9._-]+/gu, '_')
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
 * 根据响应流写入临时文件，完成后再原子替换为最终 DMG 文件。
 * @param response 网络响应。
 * @param temporaryPath 临时文件路径。
 * @param destination 最终文件路径。
 * @param onProgress 下载进度回调。
 * @returns 写入完成后的 Promise。
 * @author zhenghq
 */
async function writeResponseToFile(
  response: Response,
  temporaryPath: string,
  destination: string,
  onProgress?: (progress: UpdateProgress) => void
): Promise<void> {
  const totalHeader = Number(response.headers.get('content-length') ?? 0)
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0
  const startedAt = Date.now()
  let transferred = 0
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined

  /**
   * 根据当前已写入字节数上报下载速度和完成百分比。
   * @returns 无返回值。
   * @author zhenghq
   */
  const reportProgress = (): void => {
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
    const bytesPerSecond = transferred / elapsedSeconds
    const percent = total > 0 ? Math.min(100, transferred / total * 100) : transferred > 0 ? 100 : 0
    onProgress?.({ percent, transferred, total, bytesPerSecond })
  }

  try {
    fileHandle = await open(temporaryPath, 'w')
    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value) continue
        await fileHandle.write(chunk.value)
        transferred += chunk.value.byteLength
        reportProgress()
      }
    } else {
      const content = new Uint8Array(await response.arrayBuffer())
      await fileHandle.write(content)
      transferred = content.byteLength
      reportProgress()
    }
    await fileHandle.close()
    fileHandle = undefined
    await rename(temporaryPath, destination)
  } catch (error) {
    await fileHandle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 创建手动 macOS DMG 下载、保存和打开服务。
 * @param options 下载目录、打开器和网络请求依赖。
 * @returns 可注入更新管理器的手动更新服务。
 * @author zhenghq
 */
export function createManualMacUpdateService(
  options: ManualMacUpdateServiceOptions
): ManualMacUpdateService {
  const fetcher = options.fetch ?? globalThis.fetch
  const architecture = options.architecture ?? process.arch

  return {
    /**
     * 下载指定 DMG、保存到 Downloads 并交给 Finder 打开。
     * @param url 已从更新清单获取的 DMG 下载地址。
     * @param version 更新版本号。
     * @param onProgress 下载进度回调。
     * @returns 下载文件路径的 Promise。
     * @author zhenghq
     */
    async downloadAndOpen(
      url: string,
      version: string,
      onProgress?: (progress: UpdateProgress) => void
    ): Promise<ManualMacUpdateResult> {
      let currentUrl = validateDmgUrl(url)
      let response: Response | undefined
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        response = await fetcher(currentUrl, { redirect: 'manual' })
        if (response.status < 300 || response.status >= 400) break
        const location = response.headers.get('location')
        if (!location) throw new Error('DMG 下载重定向缺少目标地址')
        currentUrl = validateHttpsUrl(new URL(location, currentUrl).toString()).toString()
        if (redirectCount === 5) throw new Error('DMG 下载重定向次数过多')
      }

      if (!response || !response.ok) {
        throw new Error(`DMG 下载失败（HTTP ${response?.status ?? '未知状态'}）`)
      }

      const destination = buildDmgPath(options.downloadsDirectory, version, architecture)
      const temporaryPath = `${destination}.part`
      await mkdir(options.downloadsDirectory, { recursive: true })
      onProgress?.({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
      await writeResponseToFile(response, temporaryPath, destination, onProgress)

      const openError = await options.openPath(destination)
      if (openError) throw new Error(`无法打开已下载的 DMG：${openError}`)
      return { path: destination }
    }
  }
}
