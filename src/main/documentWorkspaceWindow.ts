import { BrowserWindow, screen, type Rectangle } from 'electron'
import { handBackFrontmostThen, rememberFrontmostAppIfInactiveAsync } from './macForeground'
import {
  getDocumentPlatformCapability,
  type DocumentPlatformCapability
} from '../shared/documentPlatformCapability'
import { translateMain } from './messages'
import {
  resolveRestoredDocumentWindowBounds,
  type DocumentWindowBounds,
  type DocumentWindowDisplay
} from '../shared/documentWindowBounds'

/** 文档工作台窗口管理器依赖。 */
export interface DocumentWorkspaceManagerOptions {
  /** App preload 文件路径，仅注入本地文档工作台窗口。 */
  preloadPath: string
  /** 加载本地 Renderer 页面的函数。 */
  loadRenderer(window: BrowserWindow, html: string): void
  /** 查询当前平台是否允许启用文档翻译。 */
  getDocumentPlatformCapability?(): DocumentPlatformCapability
  /** 文档窗口打开或关闭时通知主进程刷新 Dock 状态。 */
  onWindowStateChanged?(open: boolean): void
  /** 文档窗口失去焦点、隐藏或关闭时通知主进程解除弹窗保护。 */
  onInternalWindowFocusLost?(): void
  /** 判断当前是否存在可见设置页；存在时关闭文档窗口不得触发应用级隐藏。 */
  hasVisibleSettingsWindow?(): boolean
  /** 通过统一窗口级入口把文档窗口置前。 */
  bringToFrontToOwnWindow?(window: BrowserWindow): void
  /** 读取上次保存的文档窗口边界。 */
  loadBounds?(): Rectangle | null
  /** 保存文档窗口边界；调用方负责持久化到本地配置。 */
  saveBounds?(bounds: Rectangle): void
}

/** 文档工作台默认尺寸，保持与网页阅读器一致的工作区比例。 */
const DOCUMENT_WINDOW_WIDTH = 1180
const DOCUMENT_WINDOW_HEIGHT = 780

/** 文档工作台最小尺寸，低于该尺寸时由 Renderer 切换为上下布局。 */
const DOCUMENT_WINDOW_MIN_WIDTH = 900
const DOCUMENT_WINDOW_MIN_HEIGHT = 620

/** 窗口移动或缩放后延迟持久化的时长，避免拖动过程中频繁写入配置。 */
const DOCUMENT_WINDOW_BOUNDS_SAVE_DELAY_MS = 300

/**
 * 管理独立文档翻译工作台窗口的生命周期。
 * 该窗口是普通可交互窗口，显式打开时复用并聚焦，关闭时按 macOS 前台交还约定收尾。
 * @author zhenghq
 */
export class DocumentWorkspaceManager {
  private readonly options: DocumentWorkspaceManagerOptions
  private window: BrowserWindow | null = null
  private closingWindow = false
  private allowWindowClose = false
  private boundsSaveTimer: NodeJS.Timeout | null = null

  /**
   * 创建文档工作台窗口管理器。
   * @param options 窗口依赖与生命周期回调。
   * @author zhenghq
   */
  constructor(options: DocumentWorkspaceManagerOptions) {
    this.options = options
  }

  /**
   * 打开或聚焦文档工作台；已有窗口时只复用，不创建重复实例。
   * @param options.bringToFront 是否通过统一窗口级入口置前。
   * @returns 打开完成后的 Promise。
   * @author zhenghq
   */
  async open(options: { bringToFront?: boolean } = {}): Promise<void> {
    const capability = this.getDocumentPlatformCapability()
    if (!capability.supported) {
      throw new Error(capability.reason === 'windows-7-unsupported'
        ? translateMain('document.error.windows7Unsupported')
        : translateMain('document.error.unsupportedPlatform'))
    }
    if (this.closingWindow) return
    await rememberFrontmostAppIfInactiveAsync()
    await this.ensureWindow()
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (options.bringToFront && this.options.bringToFrontToOwnWindow) {
      this.options.bringToFrontToOwnWindow(window)
    } else {
      window.show()
      window.focus()
    }
  }

  /**
   * 判断指定窗口是否为当前有效的文档工作台窗口。
   * @param window 待校验窗口。
   * @returns 属于当前有效文档窗口时返回 true。
   * @author zhenghq
   */
  ownsWindow(window: BrowserWindow): boolean {
    return this.window === window && !window.isDestroyed()
  }

  /**
   * 读取当前文档窗口；窗口尚未创建或已销毁时返回 null。
   * @returns 当前有效的 BrowserWindow 或 null。
   * @author zhenghq
   */
  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  /**
   * 向当前文档窗口发送受控事件；窗口不可用时静默返回 false。
   * @param channel 受控 IPC 通道名称。
   * @param payload 可结构化克隆的事件负载。
   * @returns 是否成功发送。
   * @author zhenghq
   */
  send(channel: string, payload: unknown): boolean {
    const window = this.getWindow()
    if (!window || window.webContents.isDestroyed()) return false
    window.webContents.send(channel, payload)
    return true
  }

  /**
   * 激活仍然存在的文档窗口，供内部 activate 回调复用。
   * @returns 已成功激活时返回 true；窗口不存在或已销毁时返回 false。
   * @author zhenghq
   */
  focusExistingWindow(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    if (this.window.isMinimized()) this.window.restore()
    if (this.window.isVisible() && !this.window.isMinimized()) return true
    this.window.show()
    this.window.focus()
    return true
  }

  /**
   * 通过显式用户入口打开或聚焦文档窗口。
   * @returns 窗口存在并已尝试置前时返回 true；窗口不存在或已销毁时返回 false。
   * @author zhenghq
   */
  focusOrOpenExistingWindow(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
    return true
  }

  /**
   * 更新文档工作台窗口标题，供界面语言切换时同步系统标题。
   * @param title 新的窗口标题。
   * @returns 无返回值。
   * @author zhenghq
   */
  setTitle(title: string): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.setTitle(title)
  }

  /**
   * 返回文档窗口当前可见的屏幕区域，供划词监听排除应用内鼠标操作。
   * @returns 窗口可见时返回其屏幕区域，不可见或已销毁时返回 null。
   * @author zhenghq
   */
  getVisibleBounds(): Rectangle | null {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return null
    return this.window.getBounds()
  }

  /**
   * 返回文档窗口当前是否持有焦点，供划词监听区分前台与后台窗口。
   * @returns 窗口存在且持有焦点时返回 true。
   * @author zhenghq
   */
  isWindowFocused(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    return this.window.isFocused()
  }

  /**
   * 关闭文档窗口，并在必要时先交还 macOS 前台。
   * @returns 无返回值。
   * @author zhenghq
   */
  close(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.flushBounds()
    if (this.closingWindow) return
    this.closingWindow = true
    if (this.options.hasVisibleSettingsWindow?.()) {
      this.closingWindow = false
      this.allowWindowClose = true
      window.close()
      return
    }
    handBackFrontmostThen(window, () => {
      this.closingWindow = false
      if (window.isDestroyed()) return
      this.allowWindowClose = true
      window.close()
    })
  }

  /**
   * 应用退出时立即销毁文档窗口，不再交还前台。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    const window = this.window
    this.flushBounds()
    this.clearBoundsSaveTimer()
    if (!window || window.isDestroyed()) return
    this.allowWindowClose = true
    this.closingWindow = false
    window.destroy()
  }

  /**
   * 查询文档平台能力，缺省时读取当前运行时。
   * @returns 平台能力结果。
   * @author zhenghq
   */
  getDocumentPlatformCapability(): DocumentPlatformCapability {
    return this.options.getDocumentPlatformCapability?.() ?? getDocumentPlatformCapability()
  }

  /**
   * 创建文档工作台窗口并绑定生命周期。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    const bounds = this.resolveInitialBounds()
    const window = new BrowserWindow({
      ...bounds,
      minWidth: DOCUMENT_WINDOW_MIN_WIDTH,
      minHeight: DOCUMENT_WINDOW_MIN_HEIGHT,
      title: translateMain('document.windowTitle'),
      frame: false,
      resizable: true,
      maximizable: true,
      fullscreenable: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true
      }
    })
    this.window = window
    this.allowWindowClose = false
    this.closingWindow = false
    this.options.onWindowStateChanged?.(true)
    window.on('close', (event) => {
      if (this.allowWindowClose) return
      event.preventDefault()
      this.close()
    })
    window.on('blur', () => this.options.onInternalWindowFocusLost?.())
    window.on('move', () => this.scheduleBoundsSave())
    window.on('resize', () => this.scheduleBoundsSave())
    // HTML 原文只在隔离 guest 中加载，并移除任何继承的 preload 与 Node 能力。
    window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.webviewTag = false
      if (!/^file:/iu.test(params.src ?? '')) event.preventDefault()
    })
    // 原始 HTML 中的新窗口请求不应创建未受控的 Electron 窗口。
    window.webContents.on('did-attach-webview', (_event, contents) => {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    })
    window.on('closed', () => {
      this.options.onInternalWindowFocusLost?.()
      this.clearBoundsSaveTimer()
      if (this.window !== window) return
      this.window = null
      this.allowWindowClose = false
      this.closingWindow = false
      this.options.onWindowStateChanged?.(false)
    })
    this.options.loadRenderer(window, 'document.html')
  }

  /**
   * 解析文档窗口初始边界；无历史值时使用默认尺寸并由系统居中。
   * @returns 可直接传入 BrowserWindow 的边界。
   * @author zhenghq
   */
  private resolveInitialBounds(): Rectangle {
    const fallback = {
      width: DOCUMENT_WINDOW_WIDTH,
      height: DOCUMENT_WINDOW_HEIGHT
    }
    const saved = this.options.loadBounds?.() ?? null
    const displays: DocumentWindowDisplay[] = screen.getAllDisplays().map((display) => ({
      workArea: display.workArea
    }))
    return resolveRestoredDocumentWindowBounds(
      saved,
      displays,
      { width: DOCUMENT_WINDOW_MIN_WIDTH, height: DOCUMENT_WINDOW_MIN_HEIGHT },
      fallback
    ) as DocumentWindowBounds
  }

  /**
   * 安排一次防抖窗口边界保存。
   * @returns 无返回值。
   * @author zhenghq
   */
  private scheduleBoundsSave(): void {
    if (!this.options.saveBounds) return
    this.clearBoundsSaveTimer()
    this.boundsSaveTimer = setTimeout(() => {
      this.boundsSaveTimer = null
      this.flushBounds()
    }, DOCUMENT_WINDOW_BOUNDS_SAVE_DELAY_MS)
  }

  /**
   * 立即保存当前窗口边界；窗口已销毁或未配置保存回调时跳过。
   * @returns 无返回值。
   * @author zhenghq
   */
  private flushBounds(): void {
    const window = this.window
    if (!window || window.isDestroyed() || !this.options.saveBounds) return
    this.options.saveBounds(window.getBounds())
  }

  /**
   * 清理尚未触发的边界保存定时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearBoundsSaveTimer(): void {
    if (!this.boundsSaveTimer) return
    clearTimeout(this.boundsSaveTimer)
    this.boundsSaveTimer = null
  }
}
