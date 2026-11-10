import { ipcMain } from 'electron'

/** 自动更新 IPC 注册依赖。 */
export interface UpdaterIpcDependencies {
  /** 返回当前更新状态快照。 */
  getStatus(): unknown
  /** 检查更新。 */
  check(): unknown
  /** 下载更新。 */
  download(): unknown
  /** 取消下载。 */
  cancelDownload(): unknown
  /** 安装更新。 */
  install(): void
  /** 打开发布页。 */
  openReleasePage(): unknown
  /** 解除 macOS 隔离属性。 */
  removeQuarantine(): unknown
}

/**
 * 注册自动更新 IPC。
 * @param dependencies 更新管理器操作依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerUpdaterIpc(dependencies: UpdaterIpcDependencies): void {
  ipcMain.handle('updater:get-status', () => dependencies.getStatus())
  ipcMain.handle('updater:check', () => dependencies.check())
  ipcMain.handle('updater:download', () => dependencies.download())
  ipcMain.handle('updater:cancel-download', () => dependencies.cancelDownload())
  ipcMain.on('updater:install', () => dependencies.install())
  ipcMain.handle('updater:open-release', () => dependencies.openReleasePage())
  ipcMain.handle('updater:remove-quarantine', () => dependencies.removeQuarantine())
}
