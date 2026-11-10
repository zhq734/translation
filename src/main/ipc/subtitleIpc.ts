import { BrowserWindow, ipcMain, shell } from 'electron'
import type { RealtimeSubtitleController } from '../realtimeSubtitleController'
import type { SubtitleWindowController } from '../subtitleWindow'
import type { RealtimeSubtitleSnapshot } from '../../shared/subtitleSession'
import type { RealtimeSubtitlePlatformCapability } from '../../shared/realtimeSubtitlePlatform'
import type {
  RealtimeSubtitleDragHitArea,
  RealtimeSubtitleWindowMoveRequest
} from '../../shared/types'

/** 实时字幕 IPC 注册依赖。 */
export interface SubtitleIpcDependencies {
  /** 当前运行平台是否为 macOS。 */
  isMac: boolean
  /** 等待服务就绪后返回字幕控制器。 */
  getReadyRealtimeSubtitleController(): Promise<RealtimeSubtitleController | null>
  /** 返回当前字幕控制器。 */
  getRealtimeSubtitleController(): RealtimeSubtitleController | null
  /** 返回不支持平台时缓存的稳定快照。 */
  getUnsupportedRealtimeSubtitleSnapshot(): RealtimeSubtitleSnapshot | null
  /** 返回当前平台字幕能力。 */
  getRealtimeSubtitleCapability(): RealtimeSubtitlePlatformCapability
  /** 创建空闲状态快照。 */
  createIdleRealtimeSubtitleSnapshot(): RealtimeSubtitleSnapshot
  /** 创建不支持平台状态快照。 */
  createUnsupportedRealtimeSubtitleSnapshot(
    reason: 'unsupported-platform' | 'macos-version-unsupported'
  ): RealtimeSubtitleSnapshot
  /** 返回当前字幕窗口控制器。 */
  getSubtitleWindow(): SubtitleWindowController | null
}

/**
 * 注册实时字幕控制、窗口拖拽与命中区域 IPC。
 * @param dependencies 字幕控制器、窗口和能力查询依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerSubtitleIpc(dependencies: SubtitleIpcDependencies): void {
  /**
   * 启动实时字幕；非支持平台直接返回稳定错误，不触发 sidecar。
   * @returns 启动后的快照。
   * @author zhenghq
   */
  ipcMain.handle('subtitle:start', async () => {
    const controller = await dependencies.getReadyRealtimeSubtitleController()
    if (!controller) {
      return dependencies.getUnsupportedRealtimeSubtitleSnapshot() ??
        dependencies.createUnsupportedRealtimeSubtitleSnapshot('unsupported-platform')
    }
    return controller.start()
  })
  /**
   * 停止实时字幕并释放音频资源。
   * @returns 停止后的快照。
   * @author zhenghq
   */
  ipcMain.handle('subtitle:stop', async () => {
    const controller = await dependencies.getReadyRealtimeSubtitleController()
    if (!controller) {
      return dependencies.getUnsupportedRealtimeSubtitleSnapshot() ??
        dependencies.createUnsupportedRealtimeSubtitleSnapshot('unsupported-platform')
    }
    return controller.stop()
  })
  /**
   * 暂停实时字幕识别。
   * @returns 暂停后的快照。
   * @author zhenghq
   */
  ipcMain.handle('subtitle:pause', async () => {
    const controller = await dependencies.getReadyRealtimeSubtitleController()
    if (!controller) {
      return dependencies.getUnsupportedRealtimeSubtitleSnapshot() ??
        dependencies.createUnsupportedRealtimeSubtitleSnapshot('unsupported-platform')
    }
    return controller.pause()
  })
  /**
   * 恢复实时字幕识别。
   * @returns 恢复后的快照。
   * @author zhenghq
   */
  ipcMain.handle('subtitle:resume', async () => {
    const controller = await dependencies.getReadyRealtimeSubtitleController()
    if (!controller) {
      return dependencies.getUnsupportedRealtimeSubtitleSnapshot() ??
        dependencies.createUnsupportedRealtimeSubtitleSnapshot('unsupported-platform')
    }
    return controller.resume()
  })
  /**
   * 查询实时字幕当前快照。
   * @returns 当前快照。
   * @author zhenghq
   */
  ipcMain.handle('subtitle:get-status', async () => {
    const capability = dependencies.getRealtimeSubtitleCapability()
    return dependencies.getRealtimeSubtitleController()?.snapshot() ??
      dependencies.getUnsupportedRealtimeSubtitleSnapshot() ??
      (capability.supported
        ? dependencies.createIdleRealtimeSubtitleSnapshot()
        : dependencies.createUnsupportedRealtimeSubtitleSnapshot(capability.reason ?? 'unsupported-platform'))
  })
  /**
   * 打开 macOS 屏幕录制权限设置页，便于开发态 Electron 完成 TCC 授权。
   * @returns 打开完成后的 Promise。
   * @author zhenghq
   */
  ipcMain.handle('subtitle:open-screen-recording-settings', async () => {
    if (!dependencies.isMac) return
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
  /**
   * 切换字幕窗鼠标交互；仅允许字幕窗自身在点击穿透模式下临时接收事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  ipcMain.on('subtitle:mouse-interaction', (event, active: unknown, scope: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const subtitleWindow = dependencies.getSubtitleWindow()
    if (!senderWindow || !subtitleWindow?.ownsWindow(senderWindow)) return
    const normalizedScope = scope === 'window' ? 'window' : 'toolbar'
    if (normalizedScope !== 'toolbar' && normalizedScope !== 'window') return
    subtitleWindow.setMouseInteraction(active === true)
  })
  /**
   * 移动字幕窗；只接受字幕窗自身发送的拖拽请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  ipcMain.on('subtitle:move-window', (event, request: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const subtitleWindow = dependencies.getSubtitleWindow()
    if (!senderWindow || !subtitleWindow?.ownsWindow(senderWindow)) return
    if (!request || typeof request !== 'object') return
    subtitleWindow.moveWindow(request as RealtimeSubtitleWindowMoveRequest)
  })
  /**
   * 接收字幕窗拖拽按钮的真实矩形，用于点击穿透模式下的精确鼠标命中。
   * @returns 无返回值。
   * @author zhenghq
   */
  ipcMain.on('subtitle:drag-hit-area', (event, area: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const subtitleWindow = dependencies.getSubtitleWindow()
    if (!senderWindow || !subtitleWindow?.ownsWindow(senderWindow)) return
    if (!area || typeof area !== 'object') return
    subtitleWindow.setDragHitArea(area as RealtimeSubtitleDragHitArea)
  })
  /**
   * 接收字幕卡片真实矩形，使透明外围在普通模式下也能点击穿透。
   * @returns 无返回值。
   * @author zhenghq
   */
  ipcMain.on('subtitle:card-hit-area', (event, area: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const subtitleWindow = dependencies.getSubtitleWindow()
    if (!senderWindow || !subtitleWindow?.ownsWindow(senderWindow)) return
    if (!area || typeof area !== 'object') return
    subtitleWindow.setCardHitArea(area as RealtimeSubtitleDragHitArea)
  })
}
