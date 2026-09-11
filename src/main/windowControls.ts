import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'

/** 窗口控制 IPC 注册选项。 */
export interface WindowControlRegistrationOptions {
  /** 判断窗口是否允许由 Renderer 控制。 */
  isAllowedWindow(window: BrowserWindow): boolean
}

/** 已绑定最大化状态监听的 Renderer 及其清理方法。 */
const stateListenerCleanups = new WeakMap<WebContents, () => void>()

/**
 * 根据 IPC 发送者解析受信任窗口。
 * @param event IPC 事件，仅使用其发送者定位窗口。
 * @param isAllowedWindow 窗口白名单校验函数。
 * @returns 合法且仍有效的窗口，否则返回 null。
 * @author zhenghq
 */
function resolveAllowedWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
  isAllowedWindow: WindowControlRegistrationOptions['isAllowedWindow']
): BrowserWindow | null {
  if (event.sender.isDestroyed()) return null
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || !isAllowedWindow(window)) return null
  return window
}

/**
 * 为受信任窗口绑定最大化状态通知，并保证窗口销毁后解除监听。
 * @param window 已通过白名单校验的窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function bindMaximizedState(window: BrowserWindow): void {
  const webContents = window.webContents
  if (stateListenerCleanups.has(webContents)) return

  const sendState = (): void => {
    if (window.isDestroyed() || webContents.isDestroyed()) return
    webContents.send('window:maximized-changed', window.isMaximized())
  }
  const cleanup = (): void => {
    window.removeListener('maximize', sendState)
    window.removeListener('unmaximize', sendState)
    window.removeListener('closed', cleanup)
    webContents.removeListener('destroyed', cleanup)
    stateListenerCleanups.delete(webContents)
  }

  stateListenerCleanups.set(webContents, cleanup)
  window.on('maximize', sendState)
  window.on('unmaximize', sendState)
  window.on('closed', cleanup)
  webContents.on('destroyed', cleanup)
}

/**
 * 注册设置页与网页阅读器共用的受限窗口控制 IPC。
 * @param options 注册选项，提供允许控制的窗口白名单。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerWindowControls(options: WindowControlRegistrationOptions): void {
  const resolveWindow = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null => {
    const window = resolveAllowedWindow(event, options.isAllowedWindow)
    if (window) bindMaximizedState(window)
    return window
  }

  ipcMain.on('window:minimize', (event) => {
    resolveWindow(event)?.minimize()
  })
  ipcMain.on('window:toggle-maximize', (event) => {
    const window = resolveWindow(event)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on('window:close', (event) => {
    resolveWindow(event)?.close()
  })
  ipcMain.handle('window:is-maximized', (event) => resolveWindow(event)?.isMaximized() ?? false)
}
