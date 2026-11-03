import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isChromiumLikeExecutablePath } from '../shared/platformCapture'

const execFileP = promisify(execFile)

/** 进程可执行文件探测的最长耗时，避免异常进程拖慢取词入口。 */
export const CHROMIUM_PROCESS_DETECTION_TIMEOUT_MS = 120

/** 已知 Chromium/Electron 应用 bundle id；仅用于跳过额外的进程路径探测。 */
const CHROMIUM_LIKE_BUNDLE_ID_PATTERN =
  /^(?:com\.google\.chrome(?:\.canary|\.beta|\.dev|\.for\.testing)?|com\.microsoft\.edgemac(?:\.(?:beta|dev|canary))?|com\.brave\.browser(?:\.(?:beta|dev|nightly))?|org\.chromium\.Chromium|com\.microsoft\.VSCode(?:Insiders)?|com\.tinyspeck\.slackmacgap|com\.cursor\.Cursor|com\.anthropic\.claude|com\.postmanlabs\.Postman|com\.discordapp\.Discord|notion\.id|md\.obsidian|com\.figma\.Figma|company\.thebrowser\.Browser|com\.vivaldi\.Vivaldi|com\.operasoftware\.Opera(?:Next)?)$/iu

/** 应用包内可用于识别 Chromium/Electron 内核的 Framework 目录名。 */
const CHROMIUM_FRAMEWORK_DIRECTORY_NAMES = [
  'Electron Framework.framework',
  'Google Chrome Framework.framework',
  'Chromium Framework.framework',
  'Microsoft Edge Framework.framework',
  'Brave Browser Framework.framework'
] as const

/**
 * 判断 bundle id 是否属于已知的 Chromium/Electron 应用。
 * 该判断只用于增强 AX 的快速路径，不用于 Chromium 专用复制门禁。
 * @param bundleId 目标应用 bundle id。
 * @returns 命中已知 Chromium/Electron 应用时返回 true。
 * @author zhenghq
 */
export function isChromiumLikeBundleId(bundleId?: string): boolean {
  return Boolean(bundleId && CHROMIUM_LIKE_BUNDLE_ID_PATTERN.test(bundleId))
}

/**
 * 从 macOS 应用可执行文件路径解析 `.app` 包根目录。
 * @param executablePath 可执行文件绝对路径。
 * @returns 应用包根目录；路径不属于标准 `.app` 结构时返回 null。
 * @author zhenghq
 */
export function resolveMacosAppBundlePath(executablePath: string): string | null {
  const marker = '/Contents/MacOS/'
  const markerIndex = executablePath.indexOf(marker)
  if (markerIndex <= 0) return null
  const bundlePath = executablePath.slice(0, markerIndex)
  return bundlePath.endsWith('.app') ? bundlePath : null
}

/**
 * 通过 `ps` 读取 macOS 目标进程的可执行文件路径。
 * @param pid 目标进程号。
 * @returns 可执行文件路径；命令失败时抛错，由检测器决定不缓存该失败。
 * @author zhenghq
 */
async function probeMacosExecutablePath(pid: number): Promise<string> {
  const { stdout } = await execFileP(
    'ps',
    ['-p', String(pid), '-o', 'comm='],
    { timeout: CHROMIUM_PROCESS_DETECTION_TIMEOUT_MS, windowsHide: true }
  )
  return String(stdout ?? '').trim()
}

/** Chromium/Electron 进程检测器依赖注入配置。 */
export interface ChromiumProcessDetectorOptions {
  /** 当前平台，默认取 process.platform。 */
  platform?: NodeJS.Platform
  /** 读取目标进程可执行文件路径；默认使用 macOS `ps`。 */
  probeExecutablePath?: (pid: number) => Promise<string>
  /** 判断应用包内文件是否存在；默认使用 fs.existsSync。 */
  fileExists?: (path: string) => boolean
}

/** 按 PID 缓存的 Chromium/Electron 进程检测器。 */
export interface ChromiumProcessDetector {
  /**
   * 判断目标进程是否属于 Chromium/Electron 系应用。
   * @param bundleId 目标应用 bundle id。
   * @param pid 目标进程号。
   * @returns 命中时返回 true；无法确认或探测失败时返回 false。
   * @author zhenghq
   */
  isChromiumLikeProcess(bundleId?: string, pid?: number): Promise<boolean>
}

/**
 * 创建 Chromium/Electron 进程检测器。
 *
 * 已知 bundle id 直接命中；未知应用只探测一次可执行文件路径，并检查应用包内
 * 是否包含 Chromium/Electron Framework。成功探测结果按 PID 缓存，命令失败不缓存，
 * 避免瞬时权限或进程状态问题永久禁用某个应用的 AX 增强。
 * @param options 依赖注入配置。
 * @returns 可按 PID 查询的检测器。
 * @author zhenghq
 */
export function createChromiumProcessDetector(
  options: ChromiumProcessDetectorOptions = {}
): ChromiumProcessDetector {
  const platform = options.platform ?? process.platform
  const probeExecutablePath = options.probeExecutablePath ?? probeMacosExecutablePath
  const fileExists = options.fileExists ?? existsSync
  const cachedResults = new Map<number, boolean>()
  const inFlightRequests = new Map<number, Promise<boolean>>()

  /**
   * 检查应用包内是否存在 Chromium/Electron Framework。
   * @param executablePath 目标进程可执行文件路径。
   * @returns 存在任一已知 Framework 时返回 true。
   * @author zhenghq
   */
  function hasChromiumFramework(executablePath: string): boolean {
    const bundlePath = resolveMacosAppBundlePath(executablePath)
    if (!bundlePath) return false
    const frameworksPath = join(bundlePath, 'Contents', 'Frameworks')
    return CHROMIUM_FRAMEWORK_DIRECTORY_NAMES.some((directoryName) =>
      fileExists(join(frameworksPath, directoryName))
    )
  }

  /**
   * 实际探测单个进程；仅对可确认结果写入缓存。
   * @param pid 目标进程号。
   * @returns 是否属于 Chromium/Electron 系应用。
   * @author zhenghq
   */
  async function detectProcess(pid: number): Promise<boolean> {
    try {
      const executablePath = await probeExecutablePath(pid)
      if (!executablePath) return false
      const detected = isChromiumLikeExecutablePath(executablePath) ||
        hasChromiumFramework(executablePath)
      cachedResults.set(pid, detected)
      return detected
    } catch {
      return false
    }
  }

  return {
    async isChromiumLikeProcess(bundleId?: string, pid?: number): Promise<boolean> {
      if (platform !== 'darwin' || pid === undefined || !Number.isInteger(pid) || pid <= 0) {
        return false
      }
      if (isChromiumLikeBundleId(bundleId)) return true

      const cached = cachedResults.get(pid)
      if (cached !== undefined) return cached
      const inFlight = inFlightRequests.get(pid)
      if (inFlight) return inFlight

      const request = detectProcess(pid)
      inFlightRequests.set(pid, request)
      try {
        return await request
      } finally {
        inFlightRequests.delete(pid)
      }
    }
  }
}

/** 主进程共享的 Chromium/Electron 进程检测器。 */
export const chromiumProcessDetector = createChromiumProcessDetector()
