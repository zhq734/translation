import {
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  nativeImage,
  screen,
  type MenuItemConstructorOptions
} from 'electron'
import { writeFile } from 'node:fs/promises'
import {
  MAX_SCREENSHOT_PINS,
  clampPinBounds,
  clampPinOpacity,
  clampPinScale,
  fitPinScale,
  fitPinBounds,
  type PinBounds
} from '../shared/screenshotPin'
import type {
  ScreenshotPinContextMenuRequest,
  ScreenshotPinCreateRequest,
  ScreenshotPinCreateResult,
  ScreenshotPinDragRequest,
  ScreenshotPinInitPayload,
  ScreenshotPinWheelRequest
} from '../shared/types'
import { decodePng } from './pngCodec'
import { SCREENSHOT_EXPORT_LIMITS } from './screenshotExportPayload'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

/** 每次滚轮事件调整的缩放比例。 */
const PIN_WHEEL_SCALE_STEP = 0.08
/** 每次滚轮事件调整的透明度。 */
const PIN_WHEEL_OPACITY_STEP = 0.05

/** 贴图窗口管理器依赖。 */
export interface ScreenshotPinDependencies {
  /** 预加载脚本绝对路径。 */
  preloadPath: string
  /** 加载贴图 Renderer 页面。 */
  loadPage: (win: BrowserWindow) => void
  /** 生成贴图保存默认文件名。 */
  buildFileName: () => string
  /** 本地化文本查询。 */
  translate: (key: string, params?: Record<string, string | number>) => string
  /** 向用户展示提示，可指定停留时长与语义状态。 */
  showToast: (
    message: string,
    displayTimeMs?: number,
    kind?: 'success' | 'warning' | 'error'
  ) => void
}

/** 单个贴图窗口会话。 */
interface PinSession {
  /** 贴图实例标识。 */
  pinId: number
  /** 贴图窗口。 */
  win: BrowserWindow
  /** 原始 PNG 字节，供复制和另存使用。 */
  png: Buffer
  /** 图像物理宽度。 */
  pixelWidth: number
  /** 图像物理高度。 */
  pixelHeight: number
  /** 当前缩放倍率。 */
  scale: number
  /** 当前透明度。 */
  opacity: number
  /** 是否显示边框。 */
  bordered: boolean
  /** 渲染进程最近一次报告的指针在窗口内的偏移。 */
  pointerOffsetX: number
  pointerOffsetY: number
}

/** 贴图窗口管理器。 */
export interface ScreenshotPinWindowManager {
  /** 创建一张贴图。 */
  create(request: ScreenshotPinCreateRequest): Promise<ScreenshotPinCreateResult>
  /** 拖动指定贴图。 */
  drag(request: ScreenshotPinDragRequest): void
  /** 调整指定贴图的缩放或透明度。 */
  wheel(request: ScreenshotPinWheelRequest): void
  /** 关闭指定贴图。 */
  close(pinId: number): void
  /** 显示指定贴图的右键菜单。 */
  showContextMenu(request: ScreenshotPinContextMenuRequest): void
  /** 判断窗口是否属于贴图管理器。 */
  ownsWindow(win: BrowserWindow, pinId?: number): boolean
  /** 当前贴图数量。 */
  count(): number
  /** 释放全部贴图窗口。 */
  dispose(): void
}

/** 校验贴图创建请求的数值与 PNG。 */
function normalizeCreateRequest(value: unknown): {
  ok: true
  request: ScreenshotPinCreateRequest & { png: Buffer }
} | {
  ok: false
  error: string
} {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'invalid-pin-payload' }
  }
  const raw = value as Partial<ScreenshotPinCreateRequest>
  if (!Number.isInteger(raw.sessionId) || (raw.sessionId as number) <= 0 ||
      typeof raw.requestId !== 'string' || !raw.requestId.trim()) {
    return { ok: false, error: 'invalid-pin-payload' }
  }
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) ||
      (raw.width as number) <= 0 || (raw.height as number) <= 0 ||
      (raw.width as number) > SCREENSHOT_EXPORT_LIMITS.maxWidth ||
      (raw.height as number) > SCREENSHOT_EXPORT_LIMITS.maxHeight) {
    return { ok: false, error: 'invalid-pin-dimensions' }
  }
  const png = raw.png instanceof Uint8Array
    ? Buffer.from(raw.png)
    : Buffer.isBuffer(raw.png)
      ? raw.png
      : null
  if (!png || png.length < 8 || png.length > SCREENSHOT_EXPORT_LIMITS.maxBytes) {
    return { ok: false, error: 'invalid-pin-data' }
  }
  try {
    const decoded = decodePng(png)
    if (decoded.width !== Math.round(raw.width as number) ||
        decoded.height !== Math.round(raw.height as number)) {
      return { ok: false, error: 'invalid-pin-dimensions' }
    }
  } catch {
    return { ok: false, error: 'invalid-pin-data' }
  }
  return {
    ok: true,
    request: {
      sessionId: raw.sessionId as number,
      requestId: raw.requestId,
      width: Math.round(raw.width as number),
      height: Math.round(raw.height as number),
      png
    }
  }
}

/**
 * 将贴图窗口边界限制到其中心所在显示器的工作区。
 * @param bounds 待修正窗口边界。
 * @returns 修正后的边界。
 * @author zhenghq
 */
function clampToNearestDisplay(bounds: PinBounds): PinBounds {
  const workArea = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  }).workArea
  return clampPinBounds(bounds, workArea)
}

/**
 * 创建贴图窗口管理器。
 * @param dependencies 窗口、文件与提示依赖。
 * @returns 贴图窗口管理器。
 * @author zhenghq
 */
export function createScreenshotPinWindowManager(
  dependencies: ScreenshotPinDependencies
): ScreenshotPinWindowManager {
  const sessions = new Map<number, PinSession>()
  let nextPinId = 0

  /** 构造贴图初始化负载。 */
  const buildInitPayload = (session: PinSession): ScreenshotPinInitPayload => ({
    pinId: session.pinId,
    dataUrl: `data:image/png;base64,${session.png.toString('base64')}`,
    width: session.pixelWidth,
    height: session.pixelHeight,
    scale: session.scale,
    opacity: session.opacity,
    bordered: session.bordered
  })

  /** 向贴图窗口发送初始化负载。 */
  const sendInit = (session: PinSession): void => {
    if (session.win.isDestroyed()) return
    session.win.webContents.send('screenshot-pin:init', buildInitPayload(session))
  }

  /** 关闭单个贴图并从管理器移除。 */
  const closeSession = (pinId: number): void => {
    const session = sessions.get(pinId)
    if (!session) return
    sessions.delete(pinId)
    if (!session.win.isDestroyed()) session.win.destroy()
  }

  /** 复制指定贴图 PNG。 */
  const copyPin = (session: PinSession): void => {
    clipboard.writeImage(nativeImage.createFromBuffer(session.png))
    dependencies.showToast(dependencies.translate('toast.copiedToClipboard'))
  }

  /** 保存指定贴图 PNG。 */
  const savePin = async (session: PinSession): Promise<void> => {
    try {
      const result = await dialog.showSaveDialog(session.win, {
        defaultPath: dependencies.buildFileName(),
        filters: [{ name: dependencies.translate('screenshot.pngFilter'), extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return
      await writeFile(result.filePath, session.png)
      dependencies.showToast(dependencies.translate('toast.savedToDisk'))
    } catch (error) {
      dependencies.showToast(
        dependencies.translate('screenshot.pin.saveFailed', {
          message: error instanceof Error ? error.message : dependencies.translate('common.unknownError')
        }),
        3000,
        'error'
      )
    }
  }

  /** 打开指定贴图的右键菜单。 */
  const showContextMenu = (session: PinSession): void => {
    const template: MenuItemConstructorOptions[] = [
      { label: dependencies.translate('screenshot.pin.copy'), click: () => copyPin(session) },
      { label: dependencies.translate('screenshot.pin.save'), click: () => void savePin(session) },
      { type: 'separator' },
      {
        label: dependencies.translate('screenshot.pin.toggleBorder'),
        type: 'checkbox',
        checked: session.bordered,
        click: () => {
          session.bordered = !session.bordered
          sendInit(session)
        }
      },
      { type: 'separator' },
      { label: dependencies.translate('screenshot.pin.close'), click: () => closeSession(session.pinId) },
      { label: dependencies.translate('screenshot.pin.closeAll'), click: () => manager.dispose() }
    ]
    Menu.buildFromTemplate(template).popup({ window: session.win })
  }

  const manager: ScreenshotPinWindowManager = {
    async create(value) {
      const normalized = normalizeCreateRequest(value)
      if (!normalized.ok) {
        return {
          ok: false,
          count: sessions.size,
          error: dependencies.translate('screenshot.pin.invalidPayload')
        }
      }
      if (sessions.size >= MAX_SCREENSHOT_PINS) {
        return {
          ok: false,
          count: sessions.size,
          error: dependencies.translate('screenshot.pin.limitReached', { count: MAX_SCREENSHOT_PINS })
        }
      }
      const request = normalized.request
      nextPinId += 1
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const bounds = fitPinBounds(
        { x: 0, y: 0, width: request.width, height: request.height },
        display.workArea
      )
      const win = new BrowserWindow({
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
          preload: dependencies.preloadPath,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const session: PinSession = {
        pinId: nextPinId,
        win,
        png: request.png,
        pixelWidth: request.width,
        pixelHeight: request.height,
        scale: clampPinScale(fitPinScale(request, display.workArea)),
        opacity: 1,
        bordered: true,
        pointerOffsetX: 0,
        pointerOffsetY: 0
      }
      sessions.set(session.pinId, session)
      win.on('closed', () => sessions.delete(session.pinId))
      dependencies.loadPage(win)
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return
        sendInit(session)
        win.showInactive()
      })
      return { ok: true, count: sessions.size }
    },
    drag(request) {
      const session = sessions.get(request.pinId)
      if (!session || session.win.isDestroyed()) return
      if (!Number.isFinite(request.screenX) || !Number.isFinite(request.screenY)) return
      const offsetX = Number.isFinite(request.pointerOffsetX) ? request.pointerOffsetX! : 0
      const offsetY = Number.isFinite(request.pointerOffsetY) ? request.pointerOffsetY! : 0
      const current = session.win.getBounds()
      const bounds = clampToNearestDisplay({
        x: Math.round(request.screenX - offsetX),
        y: Math.round(request.screenY - offsetY),
        width: current.width,
        height: current.height
      })
      session.win.setPosition(bounds.x, bounds.y)
    },
    wheel(request) {
      const session = sessions.get(request.pinId)
      if (!session || session.win.isDestroyed() || !Number.isFinite(request.deltaY)) return
      const direction = request.deltaY > 0 ? -1 : 1
      if (request.modifier) {
        session.opacity = clampPinOpacity(session.opacity + direction * PIN_WHEEL_OPACITY_STEP)
      } else {
        session.scale = clampPinScale(session.scale * (1 + direction * PIN_WHEEL_SCALE_STEP))
        const current = session.win.getBounds()
        const width = Math.max(1, Math.round(session.pixelWidth * session.scale))
        const height = Math.max(1, Math.round(session.pixelHeight * session.scale))
        const bounds = clampToNearestDisplay({
          x: current.x + Math.round((current.width - width) / 2),
          y: current.y + Math.round((current.height - height) / 2),
          width,
          height
        })
        session.win.setBounds(bounds)
      }
      sendInit(session)
    },
    close(pinId) {
      closeSession(pinId)
    },
    showContextMenu(request) {
      const session = sessions.get(request.pinId)
      if (session && !session.win.isDestroyed()) showContextMenu(session)
    },
    ownsWindow(win, pinId) {
      return Array.from(sessions.values()).some((session) =>
        session.win === win &&
        !win.isDestroyed() &&
        (pinId === undefined || session.pinId === pinId)
      )
    },
    count() {
      return sessions.size
    },
    dispose() {
      for (const pinId of Array.from(sessions.keys())) closeSession(pinId)
    }
  }
  return manager
}
