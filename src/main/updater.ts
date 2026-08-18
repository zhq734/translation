import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo
} from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { isMacOSDiskImageExecution } from './appLifecycle'
import {
  createManualMacUpdateService,
  resolveManualMacDmgUrl
} from './manualMacUpdate'
import {
  UpdateManager,
  isMacOSDeveloperIdApplicationSignature,
  resolveMacOSAppBundlePath,
  resolveUpdateInstallMode,
  type UpdateDriver,
  type UpdateDriverListeners
} from './updateManager'

const RELEASE_URL = 'https://github.com/zhq734/translation/releases/latest'
const RELEASE_DOWNLOAD_BASE_URL = `${RELEASE_URL}/download/`
const execFileAsync = promisify(execFile)

/**
 * 将 electron-updater 适配为可测试的最小更新驱动。
 * @author zhenghq
 */
class ElectronUpdateDriver implements UpdateDriver {
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
    autoUpdater.on('update-available', (info: UpdateInfo) => listeners.available({
      version: info.version,
      manualDownloadUrl: resolveMacOSManualDmgUrl(info)
    }))
    autoUpdater.on('update-not-available', (info: UpdateInfo) => listeners.notAvailable(info))
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
 * 从 electron-updater 更新清单中选择当前 macOS 架构对应的 DMG。
 * @param info electron-updater 返回的更新信息。
 * @returns 当前架构优先的 HTTPS DMG 地址；没有匹配文件时返回 undefined。
 * @author zhenghq
 */
function resolveMacOSManualDmgUrl(info: UpdateInfo): string | undefined {
  if (process.platform !== 'darwin') return undefined
  return resolveManualMacDmgUrl(info.files, process.arch, RELEASE_DOWNLOAD_BASE_URL)
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

  return new UpdateManager({
    driver: new ElectronUpdateDriver(),
    currentVersion: app.getVersion(),
    enabled: app.isPackaged,
    installMode,
    releaseUrl: RELEASE_URL,
    manualUpdate: process.platform === 'darwin'
      ? createManualMacUpdateService({
        downloadsDirectory: app.getPath('downloads'),
        openPath: (path) => shell.openPath(path)
      })
      : undefined,
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    onStatusChanged
  })
}
