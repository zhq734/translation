import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo
} from 'electron-updater'
import type { BuildMetadata } from '../shared/buildMetadata'
import type { UpdateStatus } from '../shared/types'
import { isMacOSDiskImageExecution } from './appLifecycle'
import { readLocalBuildMetadata } from './localBuildMetadata'
import {
  createManualMacUpdateService,
  resolveManualMacDmgTarget
} from './manualMacUpdate'
import type { ManualMacUpdateTarget } from './manualMacUpdate'
import { translationFetch } from './network'
import {
  fetchRemoteBuildMetadata,
  type ReleaseBuildMetadataAsset
} from './remoteBuildMetadata'
import {
  validateReleaseChecksums,
  type ReleaseAssetDigest,
  type ReleaseChecksumStatus
} from './releaseChecksums'
import {
  UpdateManager,
  isMacOSDeveloperIdApplicationSignature,
  resolveMacOSAppBundlePath,
  resolveUpdateInstallMode,
  type UpdateDriver,
  type UpdateDriverInfo,
  type UpdateDriverListeners
} from './updateManager'

/** GitHub Release 资产快照条目，同时满足摘要校验与构建元数据校验所需字段。 */
type ReleaseReleaseAsset = ReleaseAssetDigest & ReleaseBuildMetadataAsset

const RELEASE_URL = 'https://github.com/zhq734/translation/releases/latest'
const RELEASE_DOWNLOAD_BASE_URL = `${RELEASE_URL}/download/`
const RELEASE_CHECKSUMS_URL = `${RELEASE_DOWNLOAD_BASE_URL}SHA256SUMS`
const RELEASE_API_URL = 'https://api.github.com/repos/zhq734/translation/releases/latest'
const execFileAsync = promisify(execFile)

/**
 * 将 electron-updater 适配为可测试的最小更新驱动。
 * @author zhenghq
 */
class ElectronUpdateDriver implements UpdateDriver {
  private releaseValidation: Promise<void> = Promise.resolve()

  /**
   * 创建 electron-updater 适配器。
   * @param localBuild 当前安装包内嵌的本地构建元数据；缺失时为 undefined。
   * @author zhenghq
   */
  constructor(private readonly localBuild?: BuildMetadata) {}

  /**
   * 配置下载策略并转发 electron-updater 生命周期事件。
   * @param listeners 自动更新事件监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners: UpdateDriverListeners): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.fullChangelog = false
    autoUpdater.on('checking-for-update', listeners.checking)
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.releaseValidation = this.resolveReleaseContext(info)
        .then((context) => listeners.available(context))
    })
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.releaseValidation = this.resolveReleaseContext(info)
        .then((context) => listeners.notAvailable(context))
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => listeners.progress(progress))
    autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => listeners.downloaded(info))
    autoUpdater.on('error', (error: Error) => listeners.error(error))
  }

  /**
   * 请求 electron-updater 检查 GitHub Release。
   * @returns 检查请求完成后的 Promise。
   * @author zhenghq
   */
  async checkForUpdates(): Promise<void> {
    await autoUpdater.checkForUpdates()
    await this.releaseValidation
  }

  /**
   * 读取一次 GitHub Release 资产快照，合并 SHA256SUMS 校验与远程构建身份校验结果。
   * 辅助构建元数据失败只会导致该项不可用，不影响 SemVer 更新结果。
   * @param info electron-updater 返回的更新信息。
   * @returns 更新驱动上报给状态管理器的完整上下文。
   * @author zhenghq
   */
  private async resolveReleaseContext(info: UpdateInfo): Promise<UpdateDriverInfo> {
    const manualTarget = resolveMacOSManualDmgTarget(info)
    const assets = await this.fetchReleaseAssets()
    const checksumStatus = await this.validateChecksums(info, assets)
    const remoteBuild = await this.resolveRemoteBuild(info, assets)
    return {
      version: info.version,
      manualDownloadUrl: manualTarget?.url,
      manualDownloadSha512: manualTarget?.sha512,
      manualDownloadSize: manualTarget?.size,
      checksumStatus,
      ...(this.localBuild ? { localBuild: this.localBuild } : {}),
      ...(remoteBuild.ok
        ? { remoteBuild: remoteBuild.metadata }
        : { buildMetadataUnavailableReason: remoteBuild.reason })
    }
  }

  /**
   * 获取最新 Release 的资产快照，供摘要校验与构建元数据校验共同复用。
   * @returns Release 资产列表；请求失败时返回 undefined。
   * @author zhenghq
   */
  private async fetchReleaseAssets(): Promise<ReleaseReleaseAsset[] | undefined> {
    try {
      const response = await translationFetch(RELEASE_API_URL, {
        headers: { accept: 'application/vnd.github+json' }
      })
      if (!response.ok) return undefined
      const assets = (await response.json() as { assets?: ReleaseReleaseAsset[] }).assets
      return Array.isArray(assets) ? assets : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 使用已获取的资产快照校验安装包 SHA256SUMS。
   * @param info electron-updater 返回的更新信息。
   * @param assets Release 资产快照。
   * @returns SHA256SUMS 校验状态。
   * @author zhenghq
   */
  private async validateChecksums(
    info: UpdateInfo,
    assets: ReleaseReleaseAsset[] | undefined
  ): Promise<ReleaseChecksumStatus> {
    if (!assets) return 'unreachable'
    try {
      const result = await validateReleaseChecksums({
        manifestUrl: RELEASE_CHECKSUMS_URL,
        assetNames: info.files.map((file) => file.url),
        assets,
        fetch: async (url) => translationFetch(url)
      })
      return result.status
    } catch {
      return 'unreachable'
    }
  }

  /**
   * 下载并校验 Release 中的远程构建元数据。
   * @param info electron-updater 返回的更新信息。
   * @param assets Release 资产快照。
   * @returns 远程构建元数据校验结果。
   * @author zhenghq
   */
  private async resolveRemoteBuild(
    info: UpdateInfo,
    assets: ReleaseReleaseAsset[] | undefined
  ): Promise<Awaited<ReturnType<typeof fetchRemoteBuildMetadata>>> {
    if (!assets) return { ok: false, reason: 'download-failed' }
    return fetchRemoteBuildMetadata({
      assets,
      expectedVersion: info.version,
      fallbackDownloadBaseUrl: RELEASE_DOWNLOAD_BASE_URL,
      fetch: async (url, init) => translationFetch(url, init)
    })
  }

  /**
   * 下载 electron-updater 已发现的更新包。
   * @returns 下载完成后的 Promise。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<void> {
    await autoUpdater.downloadUpdate()
  }

  /**
   * 退出应用、安装更新并在安装完成后重新启动。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void {
    autoUpdater.quitAndInstall(false, true)
  }
}

/**
 * 从 electron-updater 更新清单中选择当前 macOS 架构对应的 DMG 下载目标。
 * @param info electron-updater 返回的更新信息。
 * @returns 当前架构优先的下载目标（含可用的 sha512 与 size）；没有匹配文件时返回 undefined。
 * @author zhenghq
 */
function resolveMacOSManualDmgTarget(info: UpdateInfo): ManualMacUpdateTarget | undefined {
  if (process.platform !== 'darwin') return undefined
  return resolveManualMacDmgTarget(info.files, process.arch, RELEASE_DOWNLOAD_BASE_URL)
}

/**
 * 检查当前 macOS `.app` 是否具有可验证的 Developer ID Application 正式签名。
 * @param executablePath 当前应用可执行文件路径。
 * @returns 代码签名有效且适合自动更新时返回 true。
 * @author zhenghq
 */
async function isMacOSApplicationSigned(executablePath: string): Promise<boolean> {
  const appBundlePath = resolveMacOSAppBundlePath(executablePath)
  if (!appBundlePath) return false
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundlePath])
    const { stderr } = await execFileAsync(
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', appBundlePath]
    )
    return isMacOSDeveloperIdApplicationSignature(stderr)
  } catch {
    return false
  }
}

/**
 * 创建与当前应用打包状态、平台和签名情况匹配的自动更新管理器。
 * @param onStatusChanged 自动更新状态变化回调。
 * @returns 已连接 electron-updater 的自动更新管理器。
 * @author zhenghq
 */
export async function createApplicationUpdateManager(
  onStatusChanged: (status: UpdateStatus) => void
): Promise<UpdateManager> {
  const macSigned = process.platform === 'darwin' && app.isPackaged
    ? await isMacOSApplicationSigned(process.execPath)
    : false
  const installMode = resolveUpdateInstallMode(
    process.platform,
    app.isPackaged,
    Boolean(process.env['APPIMAGE']),
    macSigned,
    isMacOSDiskImageExecution(process.platform, process.execPath)
  )

  const localBuild = await readLocalBuildMetadata({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    expectedVersion: app.getVersion()
  })

  return new UpdateManager({
    driver: new ElectronUpdateDriver(localBuild),
    currentVersion: app.getVersion(),
    enabled: app.isPackaged,
    installMode,
    releaseUrl: RELEASE_URL,
    manualUpdate: process.platform === 'darwin'
      ? createManualMacUpdateService({
        downloadsDirectory: app.getPath('downloads'),
        fetch: translationFetch,
        openPath: (path) => shell.openPath(path)
      })
      : undefined,
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    onStatusChanged
  })
}
