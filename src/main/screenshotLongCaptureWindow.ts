import { BrowserWindow, clipboard, dialog, nativeImage, screen } from 'electron'
import { writeFile } from 'node:fs/promises'
import {
  LongCaptureStitcher,
  placeLongCapturePreview,
  placeLongCaptureStatusBar,
  resizeLongCapturePreview
} from '../shared/screenshotLongCapture'
import type {
  OcrSelectionBounds,
  ScreenshotLongCaptureActionResult,
  ScreenshotLongCapturePreview,
  ScreenshotLongCaptureState
} from '../shared/types'
import { decodePng, encodePng } from './pngCodec'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

/** 长截图紧凑状态条首选高度。 */
const LONG_CAPTURE_STATUS_BAR_HEIGHT = 48
/** 自动采样间隔（毫秒）；与常驻抓帧 helper 配合，降低快速滚动时帧间无重叠的概率。 */
const LONG_CAPTURE_SAMPLE_INTERVAL_MS = 90
/** 实时预览生成间隔（毫秒）；整图缩放与 PNG 编码开销较大，无需跟随每次采样。 */
const LONG_CAPTURE_PREVIEW_INTERVAL_MS = 250

/** 长截图管理器依赖。 */
export interface ScreenshotLongCaptureDependencies {
  /** 预加载脚本绝对路径。 */
  preloadPath: string
  /** 采集指定全局屏幕区域的 PNG；长截图使用快速常驻抓帧实现。 */
  captureOcrSelectionPng: (bounds: OcrSelectionBounds) => Promise<Buffer>
  /** 加载状态条 Renderer 页面。 */
  loadPage: (win: BrowserWindow) => void
  /** 加载独立预览 Renderer 页面；缺省时预览直接嵌入状态条。 */
  loadPreviewPage?: (win: BrowserWindow) => void
  /** 生成截图默认文件名。 */
  buildFileName: () => string
  /** 本地化文本查询。 */
  translate: (key: string) => string
  /** 向用户展示提示。 */
  showToast: (message: string, displayTimeMs?: number, kind?: 'success' | 'warning' | 'error') => void
  /** 会话因窗口被外部关闭而结束时通知主进程收尾。 */
  onSessionEnded?: () => void
  /** 注册跨应用全局快捷键；返回是否注册成功。 */
  registerGlobalShortcut?: (accelerator: string, callback: () => void) => boolean
  /** 注销会话使用的全局快捷键。 */
  unregisterGlobalShortcut?: (accelerator: string) => void
}

/** 单个长截图会话。 */
interface LongCaptureSession {
  /** 当前会话标识。 */
  sessionId: number
  /** 固定采集视口（全局屏幕坐标）。 */
  bounds: OcrSelectionBounds
  /** 紧凑状态条窗口。 */
  win: BrowserWindow
  /** 独立实时预览窗口；侧边空间不足时为 null。 */
  previewWin: BrowserWindow | null
  /** 拼接器；首帧采集后创建。 */
  stitcher: LongCaptureStitcher | null
  /** 图像物理宽度。 */
  pixelWidth: number
  /** 图像物理高度。 */
  pixelHeight: number
  /** 已完成帧数。 */
  frameCount: number
  /** 是否正在采样。 */
  sampling: boolean
  /** 正在等待排队的强制补帧。 */
  forceSampling: boolean
  /** 自动采样定时器。 */
  timer: NodeJS.Timeout | null
  /** 实时预览节流定时器。 */
  previewTimer: NodeJS.Timeout | null
  /** 最近一次采样是否新增内容。 */
  appended: boolean
  /** 最近一次错误。 */
  error?: string
  /** 采样失败后是否已停止定时器。 */
  stopped: boolean
  /** 正在完成复制或保存，防止快捷键重复触发。 */
  finishing: boolean
  /** 本会话已注册的全局快捷键。 */
  registeredShortcuts: string[]
  /** 会话是否已完成收尾；保证窗口事件与显式关闭只执行一次。 */
  ended: boolean
}

/** 长截图控制窗口管理器。 */
export interface ScreenshotLongCaptureWindowManager {
  /** 启动或替换当前长截图会话。 */
  start(sessionId: number, bounds: OcrSelectionBounds): Promise<void>
  /** 立即采集一帧；force 会等待正在执行的采样后再补抓一帧。 */
  sample(sessionId: number, options?: { force?: boolean }): Promise<void>
  /** 撤销最近一次拼接。 */
  undo(sessionId: number): void
  /** 复制或保存当前拼接结果。 */
  finish(sessionId: number, action: 'copy' | 'save'): Promise<void>
  /** 取消并释放当前会话。 */
  cancel(sessionId: number): void
  /** 判断 IPC 是否来自当前长截图状态条窗口。 */
  ownsWindow(win: BrowserWindow): boolean
  /** 当前长截图会话标识；无会话时为 null。 */
  currentSessionId(): number | null
  /** 释放全部窗口与定时器。 */
  dispose(): void
}

/**
 * 创建长截图控制窗管理器。
 * @param dependencies 窗口、采集与提示依赖。
 * @returns 长截图管理器。
 * @author zhenghq
 */
export function createScreenshotLongCaptureWindowManager(
  dependencies: ScreenshotLongCaptureDependencies
): ScreenshotLongCaptureWindowManager {
  let session: LongCaptureSession | null = null
  let nextSessionId = 0

  /** 向状态条发送事件；窗口销毁后静默忽略。 */
  const send = (channel: string, payload: unknown): void => {
    if (!session || session.win.isDestroyed()) return
    session.win.webContents.send(channel, payload)
  }

  /** 构造状态负载。 */
  const state = (current: LongCaptureSession): ScreenshotLongCaptureState => ({
    sessionId: current.sessionId,
    frameCount: current.frameCount,
    height: current.stitcher?.height ?? 0,
    width: current.pixelWidth,
    canUndo: current.stitcher?.canUndo ?? false,
    truncated: current.stitcher?.truncated ?? false,
    offset: current.stitcher?.offset ?? 0,
    locateFailures: current.stitcher?.locateFailures ?? 0,
    appended: current.appended,
    sampling: current.sampling,
    ...(current.error ? { error: current.error } : {})
  })

  /** 发布状态。 */
  const publishState = (current: LongCaptureSession): void => {
    send('screenshot-long-capture:state', state(current))
  }

  /** 向独立预览窗口发布当前降采样预览；没有预览窗口时完全跳过图像编码。 */
  const publishPreview = (current: LongCaptureSession): void => {
    current.previewTimer = null
    const previewWin = current.previewWin
    if (!previewWin || previewWin.isDestroyed() || !current.stitcher) return
    const result = current.stitcher.result()
    const previewImage = resizeLongCapturePreview(result.data, current.pixelWidth, result.height)
    const png = encodePng({
      width: previewImage.width,
      height: previewImage.height,
      data: new Uint8Array(previewImage.data.buffer, previewImage.data.byteOffset, previewImage.data.byteLength)
    })
    const preview: ScreenshotLongCapturePreview = {
      sessionId: current.sessionId,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: previewImage.width,
      height: previewImage.height
    }
    previewWin.webContents.send('screenshot-long-capture:preview', preview)
  }

  /** 清理实时预览节流定时器。 */
  const clearPreviewTimer = (current: LongCaptureSession): void => {
    if (current.previewTimer) clearTimeout(current.previewTimer)
    current.previewTimer = null
  }

  /** 按固定间隔安排预览刷新；无独立预览窗或已有待执行任务时不重复编码。 */
  const schedulePreview = (current: LongCaptureSession): void => {
    if (
      session !== current ||
      current.ended ||
      !current.stitcher ||
      !current.previewWin ||
      current.previewWin.isDestroyed() ||
      current.previewTimer
    ) return
    current.previewTimer = setTimeout(() => {
      if (session !== current || current.ended) return
      publishPreview(current)
    }, LONG_CAPTURE_PREVIEW_INTERVAL_MS)
  }

  /** 清理定时器。 */
  const clearTimer = (current: LongCaptureSession): void => {
    if (current.timer) clearInterval(current.timer)
    current.timer = null
  }

  /** 启动自动采样定时器；会话结束时立即失效。 */
  const startTimer = (current: LongCaptureSession): void => {
    if (session !== current || current.win.isDestroyed() || current.stopped || current.finishing) return
    clearTimer(current)
    current.timer = setInterval(() => void sample(current.sessionId), LONG_CAPTURE_SAMPLE_INTERVAL_MS)
  }

  /** 注销会话注册的全部全局快捷键。 */
  const unregisterSessionShortcuts = (current: LongCaptureSession): void => {
    for (const accelerator of current.registeredShortcuts) {
      try {
        dependencies.unregisterGlobalShortcut?.(accelerator)
      } catch {
        // 窗口退出阶段系统可能已经释放快捷键，注销失败不应阻断会话清理。
      }
    }
    current.registeredShortcuts = []
  }

  /** 注册长截图跨应用快捷键；不可用时不阻断状态条按钮操作。 */
  const registerSessionShortcuts = (current: LongCaptureSession): void => {
    if (!dependencies.registerGlobalShortcut) return
    const shortcuts: Array<[string, () => void]> = [
      ['Return', () => void finishSession(current, 'copy')],
      ['Escape', () => cancelSession(current)],
      ['CommandOrControl+Z', () => undoSession(current)]
    ]
    for (const [accelerator, callback] of shortcuts) {
      try {
        if (dependencies.registerGlobalShortcut(accelerator, callback)) {
          current.registeredShortcuts.push(accelerator)
        }
      } catch {
        // 快捷键被其它应用占用时保留窗口内键盘操作。
      }
    }
  }

  /** 销毁会话窗口；收尾状态由 endSession 统一维护。 */
  const destroyWindows = (current: LongCaptureSession): void => {
    const win = current.win
    const previewWin = current.previewWin
    if (!previewWin?.isDestroyed()) previewWin?.destroy()
    if (!win.isDestroyed()) win.destroy()
  }

  /**
   * 统一结束会话并清理全部资源。
   * @param current 待结束会话。
   * @param notify 是否通知主进程恢复普通划词监听；替换会话时传 false。
   * @returns 无返回值。
   * @author zhenghq
   */
  const endSession = (current: LongCaptureSession, notify: boolean): void => {
    if (current.ended) return
    current.ended = true
    clearTimer(current)
    clearPreviewTimer(current)
    unregisterSessionShortcuts(current)
    if (session === current) session = null
    destroyWindows(current)
    // 仅外部关闭需要通知；取消、完成和替换会话由调用方负责后续状态。
    if (notify) dependencies.onSessionEnded?.()
  }

  /** 关闭并清空当前会话，不触发外部关闭通知。 */
  const disposeSession = (): void => {
    if (!session) return
    endSession(session, false)
  }

  /** 等待当前正在执行的采样结束。 */
  const waitForSamplingToFinish = async (current: LongCaptureSession): Promise<void> => {
    while (session === current && current.sampling) {
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
  }

  /** 执行一次采样；强制采样会串行等待并保证补抓一帧。 */
  const sample = async (sessionId: number, options: { force?: boolean } = {}): Promise<void> => {
    const current = session
    if (!current || current.sessionId !== sessionId || current.win.isDestroyed() || current.stopped) return
    if (current.sampling) {
      if (!options.force) return
      if (current.forceSampling) return
      current.forceSampling = true
      await waitForSamplingToFinish(current)
      current.forceSampling = false
      if (session !== current || current.win.isDestroyed() || current.stopped) return
    }
    current.sampling = true
    current.error = undefined
    publishState(current)
    try {
      const png = await dependencies.captureOcrSelectionPng(current.bounds)
      if (session !== current || current.win.isDestroyed()) return
      // 拼接器统一消费 RGBA；不能直接使用 nativeImage.toBitmap()，该接口在部分平台返回 BGRA。
      const image = decodePng(png)
      if (!image.width || !image.height) throw new Error(dependencies.translate('screenshot.longCapture.captureFailed'))
      if (!current.stitcher) {
        current.pixelWidth = image.width
        current.pixelHeight = image.height
        current.stitcher = new LongCaptureStitcher(image.width, image.height)
      } else if (image.width !== current.pixelWidth || image.height !== current.pixelHeight) {
        current.stopped = true
        clearTimer(current)
        throw new Error(dependencies.translate('screenshot.longCapture.dimensionsChanged'))
      }
      const data = new Uint8ClampedArray(
        image.data.buffer,
        image.data.byteOffset,
        image.data.byteLength
      )
      current.appended = current.stitcher.appendFrame(data, image.height)
      if (current.appended) current.frameCount += 1
      publishState(current)
      if (current.appended) schedulePreview(current)
    } catch (error) {
      if (session !== current) return
      current.error = error instanceof Error ? error.message : dependencies.translate('screenshot.longCapture.captureFailed')
      publishState(current)
    } finally {
      if (session === current) {
        current.sampling = false
        publishState(current)
      }
    }
  }

  /** 撤销指定会话最近一次有效拼接。 */
  const undoSession = (current: LongCaptureSession): void => {
    if (session !== current || current.win.isDestroyed() || current.finishing || !current.stitcher) return
    current.appended = false
    current.error = undefined
    current.stitcher.undo()
    current.frameCount = Math.max(0, current.frameCount - 1)
    publishState(current)
    // 撤销是用户主动操作，立即刷新而不是等待下一次节流窗口。
    clearPreviewTimer(current)
    publishPreview(current)
  }

  /** 取消指定会话；只在仍是当前会话时执行。 */
  const cancelSession = (current: LongCaptureSession): void => {
    if (session !== current || current.finishing) return
    disposeSession()
  }

  /** 发布完成动作结果。 */
  const publishAction = (result: ScreenshotLongCaptureActionResult): void => {
    send('screenshot-long-capture:action', result)
  }

  /** 完成复制或保存；完成期间停止采样并防止快捷键重复进入。 */
  const finishSession = async (current: LongCaptureSession, action: 'copy' | 'save'): Promise<void> => {
    if (session !== current || current.finishing || current.win.isDestroyed()) return
    if (!current.stitcher || current.stitcher.height <= 0) {
      publishAction({
        sessionId: current.sessionId,
        action,
        ok: false,
        error: current.error ?? dependencies.translate('screenshot.longCapture.finishFailed')
      })
      return
    }
    current.finishing = true
    clearTimer(current)
    try {
      await waitForSamplingToFinish(current)
      await sample(current.sessionId, { force: true })
      if (session !== current || current.win.isDestroyed()) return
      if (current.stopped) {
        publishAction({
          sessionId: current.sessionId,
          action,
          ok: false,
          error: current.error ?? dependencies.translate('screenshot.longCapture.finishFailed')
        })
        current.finishing = false
        startTimer(current)
        return
      }
      const result = current.stitcher.result()
      const png = encodePng({
        width: current.pixelWidth,
        height: result.height,
        data: new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)
      })
      if (action === 'copy') {
        clipboard.writeImage(nativeImage.createFromBuffer(png))
        publishAction({ sessionId: current.sessionId, action, ok: true })
        dependencies.showToast(dependencies.translate('toast.copiedToClipboard'))
        disposeSession()
        return
      }
      const save = await dialog.showSaveDialog(current.win, {
        defaultPath: dependencies.buildFileName(),
        filters: [{ name: dependencies.translate('screenshot.pngFilter'), extensions: ['png'] }]
      })
      if (session !== current) return
      if (save.canceled || !save.filePath) {
        publishAction({ sessionId: current.sessionId, action, ok: true, canceled: true })
        current.finishing = false
        startTimer(current)
        return
      }
      await writeFile(save.filePath, png)
      if (session !== current) return
      publishAction({ sessionId: current.sessionId, action, ok: true, filePath: save.filePath })
      dependencies.showToast(dependencies.translate('toast.savedToDisk'))
      disposeSession()
    } catch (error) {
      if (session !== current) return
      publishAction({
        sessionId: current.sessionId,
        action,
        ok: false,
        error: error instanceof Error ? error.message : dependencies.translate('screenshot.longCapture.finishFailed')
      })
      current.finishing = false
      startTimer(current)
    }
  }

  return {
    async start(requestedSessionId, bounds) {
      disposeSession()
      nextSessionId += 1
      const display = screen.getDisplayNearestPoint({
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2)
      })
      const placement = placeLongCaptureStatusBar(bounds, display.workArea)
      const previewPlacement = placeLongCapturePreview(bounds, display.workArea)
      const win = new BrowserWindow({
        ...placement,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: dependencies.preloadPath,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      const previewWin = previewPlacement && dependencies.loadPreviewPage
        ? new BrowserWindow({
          ...previewPlacement,
          show: false,
          frame: false,
          transparent: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          focusable: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          hasShadow: false,
          backgroundColor: '#00000000',
          webPreferences: {
            preload: dependencies.preloadPath,
            contextIsolation: true,
            nodeIntegration: false
          }
        })
        : null
      if (previewWin) {
        previewWin.setAlwaysOnTop(true, 'floating')
        previewWin.setIgnoreMouseEvents(true, { forward: true })
        previewWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      }

      session = {
        sessionId: requestedSessionId > 0 ? requestedSessionId : nextSessionId,
        bounds,
        win,
        previewWin,
        stitcher: null,
        pixelWidth: 0,
        pixelHeight: 0,
        frameCount: 0,
        sampling: false,
        forceSampling: false,
        timer: null,
        previewTimer: null,
        appended: false,
        stopped: false,
        finishing: false,
        registeredShortcuts: [],
        ended: false
      }
      const current = session
      registerSessionShortcuts(current)
      win.on('closed', () => {
        // 窗口可能由系统或用户直接关闭；幂等收尾避免显式取消后重复恢复划词监听。
        endSession(current, true)
      })
      dependencies.loadPage(win)
      if (previewWin && dependencies.loadPreviewPage) dependencies.loadPreviewPage(previewWin)
      win.once('ready-to-show', () => {
        if (session !== current || win.isDestroyed()) return
        win.showInactive()
        if (previewWin && !previewWin.isDestroyed()) previewWin.showInactive()
        publishState(current)
        // 首次采样必须等覆盖层隐藏并把前台交还目标应用后再执行。
        setTimeout(() => void sample(current.sessionId), 120)
        startTimer(current)
      })
    },
    sample,
    undo(sessionId) {
      if (session?.sessionId === sessionId) undoSession(session)
    },
    async finish(sessionId, action) {
      const current = session
      if (!current || current.sessionId !== sessionId) return
      await finishSession(current, action)
    },
    cancel(sessionId) {
      if (session?.sessionId === sessionId) disposeSession()
    },
    ownsWindow(win) {
      return Boolean(session && session.win === win && !win.isDestroyed())
    },
    currentSessionId() {
      return session?.sessionId ?? null
    },
    dispose() {
      disposeSession()
    }
  }
}
