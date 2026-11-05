import type { BrowserWindow, Rectangle } from 'electron'
import type {
  RealtimeSubtitlePointerPoint,
  RealtimeSubtitleViewModel,
  RealtimeSubtitleWindowAppearance
} from '../shared/subtitleSession'
import type {
  RealtimeSubtitleDragHitArea,
  RealtimeSubtitleWindowMoveRequest
} from '../shared/types'
import {
  resolveRestoredDocumentWindowBounds,
  type DocumentWindowDisplay
} from '../shared/documentWindowBounds'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

/** 字幕窗最小宽度。 */
const SUBTITLE_WINDOW_MIN_WIDTH = 360
/** 字幕窗最小高度。 */
const SUBTITLE_WINDOW_MIN_HEIGHT = 120
/** 移动或缩放后延迟保存，避免拖动过程中频繁写盘。 */
const SUBTITLE_WINDOW_BOUNDS_SAVE_DELAY_MS = 300
/** 点击穿透时转发指针位置的轮询间隔。 */
const SUBTITLE_TOOLBAR_POINTER_POLL_MS = 80
/** 临时接管鼠标后，指针离开工具栏多久自动恢复点击穿透。 */
const SUBTITLE_INTERACTION_RELEASE_DELAY_MS = 300
/** 拖拽按钮命中区的容差，避免亚像素边界导致悬停闪烁。 */
const SUBTITLE_DRAG_HIT_PADDING = 4

/**
 * 判断两个字幕视图模型的全部渲染字段是否一致。
 * @param left 前一个视图模型。
 * @param right 后一个视图模型。
 * @returns 所有展示字段均相同时返回 true。
 * @author zhenghq
 */
function isSameSubtitleViewModel(
  left: RealtimeSubtitleViewModel | null,
  right: RealtimeSubtitleViewModel
): boolean {
  return Boolean(
    left &&
    left.state === right.state &&
    left.displayMode === right.displayMode &&
    left.sourceText === right.sourceText &&
    left.translatedText === right.translatedText &&
    left.status === right.status &&
    left.audioActivity === right.audioActivity &&
    left.empty === right.empty &&
    left.error === right.error
  )
}

/** 字幕窗口创建依赖。 */
export interface SubtitleWindowOptions {
  /** 预加载脚本路径。 */
  preloadPath: string
  /** 加载字幕页。 */
  loadPage: (win: BrowserWindow) => void
  /** 读取当前视图模型。 */
  getViewModel: () => RealtimeSubtitleViewModel
  /** 创建浏览器窗口。 */
  createWindow: (options: ConstructorParameters<typeof BrowserWindow>[0]) => BrowserWindow
  /** 读取窗口定位显示器。 */
  getDisplay: () => { workArea: { x: number; y: number; width: number; height: number } }
  /** 读取全部显示器工作区，用于恢复跨屏位置。 */
  getDisplays?: () => readonly DocumentWindowDisplay[]
  /** 读取上次保存的字幕窗边界。 */
  loadBounds?: () => Rectangle | null
  /** 保存字幕窗边界。 */
  saveBounds?: (bounds: Rectangle) => void
  /** 读取全局指针位置，用于点击穿透时检测拖拽命中区。 */
  getCursorPoint?: () => { x: number; y: number }
  /** 覆盖指针轮询间隔，主要用于自动化测试。 */
  pointerPollIntervalMs?: number
  /** 覆盖临时鼠标交互的自动释放延迟，主要用于自动化测试。 */
  interactionReleaseDelayMs?: number
}

/** 字幕窗口控制器。 */
export interface SubtitleWindowController {
  /** 显示或隐藏字幕窗。 */
  setVisible(visible: boolean): void
  /** 更新显示模式、字号、颜色与点击穿透。 */
  setAppearance(appearance: RealtimeSubtitleWindowAppearance): void
  /** 在点击穿透模式下临时启用鼠标交互。 */
  setMouseInteraction(active: boolean): void
  /** 按屏幕坐标移动窗口。 */
  moveWindow(request: RealtimeSubtitleWindowMoveRequest): void
  /** 更新 Renderer 上报的拖拽按钮命中区。 */
  setDragHitArea(area: RealtimeSubtitleDragHitArea): void
  /** 检测点击穿透状态下的工具栏命中区。 */
  pollPointerInteraction(): void
  /** 广播最新视图模型。 */
  render(viewModel: RealtimeSubtitleViewModel): void
  /** 当前窗口是否可见。 */
  isVisible(): boolean
  /** 判断窗口是否由字幕控制器持有。 */
  ownsWindow(win: BrowserWindow): boolean
  /** 关闭并释放窗口。 */
  dispose(): void
}

/**
 * 创建不抢焦点、透明置顶的字幕窗。
 * @param options 创建依赖。
 * @returns 字幕窗控制器。
 * @author zhenghq
 */
export function createSubtitleWindow(options: SubtitleWindowOptions): SubtitleWindowController {
  let win: BrowserWindow | null = null
  let clickThrough = true
  let mouseInteraction = false
  let desiredVisible = false
  let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null
  let pointerPollTimer: ReturnType<typeof setInterval> | null = null
  let interactionReleaseTimer: ReturnType<typeof setTimeout> | null = null
  let lastPointerPoint: RealtimeSubtitlePointerPoint | null = null
  let pointerInsideDragArea = false
  let dragHitArea: RealtimeSubtitleDragHitArea | null = null
  let mousePassthrough: boolean | null = null
  let latestViewModel = options.getViewModel()
  let lastSentViewModel: RealtimeSubtitleViewModel | null = null
  let appearance: RealtimeSubtitleWindowAppearance = {
    displayMode: 'bilingual',
    fontSize: 20,
    textColor: '#ffffff',
    clickThrough: true
  }
  const pointerPollIntervalMs = options.pointerPollIntervalMs &&
    Number.isFinite(options.pointerPollIntervalMs) &&
    options.pointerPollIntervalMs > 0
    ? options.pointerPollIntervalMs
    : SUBTITLE_TOOLBAR_POINTER_POLL_MS
  const interactionReleaseDelayMs = options.interactionReleaseDelayMs &&
    Number.isFinite(options.interactionReleaseDelayMs) &&
    options.interactionReleaseDelayMs > 0
    ? options.interactionReleaseDelayMs
    : SUBTITLE_INTERACTION_RELEASE_DELAY_MS

  /**
   * 仅在窗口穿透状态实际变化时调用 Electron 原生接口。
   * @param target 字幕窗。
   * @param ignore 是否忽略鼠标事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const setWindowIgnoreMouseEvents = (target: BrowserWindow, ignore: boolean): void => {
    if (mousePassthrough === ignore) return
    mousePassthrough = ignore
    target.setIgnoreMouseEvents(ignore, { forward: true })
  }

  /**
   * 清理尚未触发的鼠标交互自动释放定时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearInteractionReleaseTimer = (): void => {
    if (!interactionReleaseTimer) return
    clearTimeout(interactionReleaseTimer)
    interactionReleaseTimer = null
  }

  /**
   * 创建窗口并按当前显示器工作区定位到底部。
   * @returns 新窗口。
   * @author zhenghq
   */
  const ensureWindow = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win
    const display = options.getDisplay()
    const { x, y, width, height } = display.workArea
    const windowWidth = Math.max(480, Math.min(1100, Math.round(width * 0.72)))
    const windowHeight = Math.max(130, Math.min(260, Math.round(height * 0.2)))
    const defaultX = x + Math.round((width - windowWidth) / 2)
    const defaultY = y + height - windowHeight - 56
    const displays = options.getDisplays?.() ?? [{ workArea: display.workArea }]
    const restored = resolveRestoredDocumentWindowBounds(
      options.loadBounds?.() ?? null,
      displays,
      { width: SUBTITLE_WINDOW_MIN_WIDTH, height: SUBTITLE_WINDOW_MIN_HEIGHT },
      { width: windowWidth, height: windowHeight }
    )
    const maxDisplayWidth = Math.max(...displays.map((item) => item.workArea.width), width)
    const maxDisplayHeight = Math.max(...displays.map((item) => item.workArea.height), height)
    const created = options.createWindow({
      width: restored.width,
      height: restored.height,
      x: restored.x ?? defaultX,
      y: restored.y ?? defaultY,
      minWidth: SUBTITLE_WINDOW_MIN_WIDTH,
      minHeight: SUBTITLE_WINDOW_MIN_HEIGHT,
      maxWidth: Math.round(maxDisplayWidth * 0.96),
      maxHeight: Math.round(maxDisplayHeight * 0.5),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    created.setAlwaysOnTop(true, 'floating')
    created.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
    mousePassthrough = null
    setWindowIgnoreMouseEvents(created, clickThrough && !mouseInteraction)
    created.on('move', () => scheduleBoundsSave(created))
    created.on('resize', () => scheduleBoundsSave(created))
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.once('ready-to-show', () => {
      if (!created.isDestroyed() && desiredVisible) created.showInactive()
    })
    created.webContents.on?.('did-finish-load', () => {
      if (created.isDestroyed()) return
      created.webContents.send('subtitle:appearance', appearance)
      created.webContents.send('subtitle:view-model', latestViewModel)
      lastSentViewModel = { ...latestViewModel }
    })
    created.on('closed', () => {
      clearBoundsSaveTimer()
      clearInteractionReleaseTimer()
      if (win === created) {
        stopPointerPolling()
        mousePassthrough = null
        win = null
        lastSentViewModel = null
      }
    })
    options.loadPage(created)
    win = created
    return created
  }

  /**
   * 将全局指针位置转发给 Renderer，由页面按拖拽按钮真实边界判断命中。
   * @param target 字幕窗。
   * @param point 全局指针坐标及拖拽命中状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  const forwardPointerPoint = (
    target: BrowserWindow,
    point: RealtimeSubtitlePointerPoint
  ): void => {
    if (
      lastPointerPoint?.x === point.x &&
      lastPointerPoint.y === point.y &&
      lastPointerPoint.insideDragArea === point.insideDragArea
    ) return
    lastPointerPoint = { ...point }
    target.webContents.send('subtitle:pointer-point', point)
  }

  /**
   * 判断全局指针是否位于 Renderer 上报的拖拽按钮命中区。
   * @param target 字幕窗。
   * @param point 全局指针坐标。
   * @returns 位于命中区时返回 true。
   * @author zhenghq
   */
  const isPointerInsideDragArea = (
    target: BrowserWindow,
    point: { x: number; y: number }
  ): boolean => {
    const bounds = target.getBounds()
    const area = dragHitArea
    return area !== null &&
      point.x >= bounds.x + area.x - SUBTITLE_DRAG_HIT_PADDING &&
      point.x <= bounds.x + area.x + area.width + SUBTITLE_DRAG_HIT_PADDING &&
      point.y >= bounds.y + area.y - SUBTITLE_DRAG_HIT_PADDING &&
      point.y <= bounds.y + area.y + area.height + SUBTITLE_DRAG_HIT_PADDING
  }

  /**
   * 按指针是否位于工具栏命中区更新点击穿透状态。
   * @param target 字幕窗。
   * @param inside 指针是否位于工具栏命中区。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyPointerPassthrough = (target: BrowserWindow, inside: boolean): void => {
    pointerInsideDragArea = inside
    if (mouseInteraction) return
    setWindowIgnoreMouseEvents(target, clickThrough && !inside)
  }

  /**
   * 清除临时鼠标交互并恢复窗口配置对应的穿透状态。
   * @param target 字幕窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  const resetMouseInteraction = (target: BrowserWindow | null): void => {
    mouseInteraction = false
    pointerInsideDragArea = false
    clearInteractionReleaseTimer()
    if (target && !target.isDestroyed()) setWindowIgnoreMouseEvents(target, clickThrough)
  }

  /**
   * 在自定义释放延迟后复核指针位置；仍离开工具栏时自动恢复点击穿透。
   * @param target 字幕窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  const scheduleInteractionRelease = (target: BrowserWindow): void => {
    if (interactionReleaseTimer || !mouseInteraction || !clickThrough) return
    interactionReleaseTimer = setTimeout(() => {
      interactionReleaseTimer = null
      if (!mouseInteraction || !clickThrough || target.isDestroyed()) return
      const point = options.getCursorPoint?.()
      if (!point) return
      const inside = isPointerInsideDragArea(target, point)
      forwardPointerPoint(target, { ...point, insideDragArea: inside })
      if (inside) {
        applyPointerPassthrough(target, true)
        return
      }
      resetMouseInteraction(target)
    }, interactionReleaseDelayMs)
  }

  /**
   * 处理一次全局指针位置，并按当前交互状态决定放行或安排自动释放。
   * @param target 字幕窗。
   * @param point 全局指针坐标。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handlePointerPoint = (
    target: BrowserWindow,
    point: { x: number; y: number }
  ): void => {
    const inside = isPointerInsideDragArea(target, point)
    forwardPointerPoint(target, { ...point, insideDragArea: inside })
    if (mouseInteraction) {
      if (!clickThrough) return
      if (inside) clearInteractionReleaseTimer()
      else scheduleInteractionRelease(target)
      return
    }
    applyPointerPassthrough(target, inside)
  }

  /**
   * 启动点击穿透时的指针位置轮询。
   * @returns 无返回值。
   * @author zhenghq
   */
  const startPointerPolling = (): void => {
    if (pointerPollTimer || !options.getCursorPoint || !clickThrough) return
    pointerPollTimer = setInterval(() => {
      const target = win
      if (!target || target.isDestroyed()) return
      const point = options.getCursorPoint?.()
      if (!point) return
      handlePointerPoint(target, point)
    }, pointerPollIntervalMs)
  }

  /**
   * 停止指针命中轮询并清空命中状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  const stopPointerPolling = (): void => {
    if (pointerPollTimer) clearInterval(pointerPollTimer)
    pointerPollTimer = null
    clearInteractionReleaseTimer()
    lastPointerPoint = null
    pointerInsideDragArea = false
  }

  /**
   * 立即保存窗口当前边界。
   * @param target 目标窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flushBounds = (target: BrowserWindow | null): void => {
    if (!target || target.isDestroyed() || !options.saveBounds) return
    options.saveBounds(target.getBounds())
  }

  /**
   * 清理尚未触发的边界保存定时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearBoundsSaveTimer = (): void => {
    if (!boundsSaveTimer) return
    clearTimeout(boundsSaveTimer)
    boundsSaveTimer = null
  }

  /**
   * 安排一次防抖边界保存。
   * @param target 目标窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  const scheduleBoundsSave = (target: BrowserWindow): void => {
    if (!options.saveBounds) return
    clearBoundsSaveTimer()
    boundsSaveTimer = setTimeout(() => {
      boundsSaveTimer = null
      flushBounds(target)
    }, SUBTITLE_WINDOW_BOUNDS_SAVE_DELAY_MS)
  }

  return {
    /**
     * 显示或隐藏字幕窗口；显示始终使用 showInactive，避免抢走视频焦点。
     * @param visible 是否显示。
     * @returns 无返回值。
     * @author zhenghq
     */
    setVisible(visible: boolean): void {
      desiredVisible = visible
      if (!visible) {
        stopPointerPolling()
        const target = win && !win.isDestroyed() ? win : null
        resetMouseInteraction(target)
        target?.hide()
        return
      }
      const target = ensureWindow()
      if (clickThrough) startPointerPolling()
      if (!target.webContents.isLoading()) {
        target.showInactive()
      }
    },

    /**
     * 更新字幕窗视觉参数与鼠标穿透。
     * @param next 最新外观设置。
     * @returns 无返回值。
     * @author zhenghq
     */
    setAppearance(next: RealtimeSubtitleWindowAppearance): void {
      appearance = { ...next }
      clickThrough = next.clickThrough
      if (!win || win.isDestroyed()) return
      pointerInsideDragArea = false
      if (!clickThrough) {
        resetMouseInteraction(win)
        stopPointerPolling()
      } else {
        setWindowIgnoreMouseEvents(win, !mouseInteraction)
        startPointerPolling()
      }
      win.webContents.send('subtitle:appearance', appearance)
    },

    /**
     * 在点击穿透模式下临时启用或恢复鼠标穿透。
     * @param active 是否让窗口接收鼠标事件。
     * @returns 无返回值。
     * @author zhenghq
     */
    setMouseInteraction(active: boolean): void {
      if (!win || win.isDestroyed()) {
        mouseInteraction = active
        return
      }
      if (!active) {
        resetMouseInteraction(win)
        if (clickThrough) startPointerPolling()
        else stopPointerPolling()
        return
      }
      mouseInteraction = true
      pointerInsideDragArea = false
      clearInteractionReleaseTimer()
      setWindowIgnoreMouseEvents(win, false)
      if (!clickThrough) {
        stopPointerPolling()
        return
      }
      startPointerPolling()
      const point = options.getCursorPoint?.()
      if (point) handlePointerPoint(win, point)
    },

    /**
     * 按拖拽手柄上报的屏幕坐标移动窗口。
     * @param request 窗口拖动请求。
     * @returns 无返回值。
     * @author zhenghq
     */
    moveWindow(request: RealtimeSubtitleWindowMoveRequest): void {
      if (!win || win.isDestroyed()) return
      if (![request.screenX, request.screenY, request.pointerOffsetX, request.pointerOffsetY].every(Number.isFinite)) return
      win.setPosition(
        Math.round(request.screenX - request.pointerOffsetX),
        Math.round(request.screenY - request.pointerOffsetY)
      )
    },

    /**
     * 保存 Renderer 上报的拖拽按钮矩形，并立即按当前指针重新计算穿透状态。
     * @param area 相对字幕窗口内容区的矩形。
     * @returns 无返回值。
     * @author zhenghq
     */
    setDragHitArea(area: RealtimeSubtitleDragHitArea): void {
      if (![area.x, area.y, area.width, area.height].every(Number.isFinite)) return
      if (area.width <= 0 || area.height <= 0) return
      dragHitArea = { x: area.x, y: area.y, width: area.width, height: area.height }
      if (!win || win.isDestroyed()) return
      const point = options.getCursorPoint?.()
      if (!point) {
        pointerInsideDragArea = false
        if (!mouseInteraction) setWindowIgnoreMouseEvents(win, clickThrough)
        return
      }
      handlePointerPoint(win, point)
    },

    /** 立即转发一次全局指针位置，便于测试和窗口刚显示时快速命中。 */
    pollPointerInteraction(): void {
      const target = win
      if (!target || target.isDestroyed() || !options.getCursorPoint) return
      const point = options.getCursorPoint()
      handlePointerPoint(target, point)
    },

    /**
     * 向字幕页推送最新视图模型。
     * @param viewModel 当前视图模型。
     * @returns 无返回值。
     * @author zhenghq
     */
    render(viewModel: RealtimeSubtitleViewModel): void {
      latestViewModel = viewModel
      const target = win
      if (!target || target.isDestroyed()) return
      if (target.webContents.isLoading()) return
      if (isSameSubtitleViewModel(lastSentViewModel, viewModel)) return
      target.webContents.send('subtitle:view-model', viewModel)
      lastSentViewModel = { ...viewModel }
    },

    /** 返回字幕窗口当前是否可见。 */
    isVisible(): boolean {
      return Boolean(win && !win.isDestroyed() && win.isVisible())
    },

    /** 判断窗口是否由字幕窗持有。 */
    ownsWindow(candidate: BrowserWindow): boolean {
      return candidate === win
    },

    /**
     * 销毁字幕窗口。
     * @returns 无返回值。
     * @author zhenghq
     */
    dispose(): void {
      desiredVisible = false
      stopPointerPolling()
      const target = win
      flushBounds(target)
      clearBoundsSaveTimer()
      win = null
      if (target && !target.isDestroyed()) target.destroy()
    }
  }
}
