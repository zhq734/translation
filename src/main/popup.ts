import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { TranslatePayload } from '../shared/types'
import { shouldDismissPopupOnBlur } from '../shared/popupBehavior'
import { isPointInPopupDragRegion } from '../shared/popupDragBehavior'

const WINDOW_EDGE_GAP = 8
const CURSOR_GAP = 16

let win: BrowserWindow | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let closeVersion = 0
let pinned = false
let currentAutoHideMs = 0
const pendingPayloads: TranslatePayload[] = []

/**
 * 创建翻译弹窗。
 * @param preloadPath 预加载脚本路径。
 * @returns 创建后的翻译弹窗。
 * @author zhenghq
 */
export function createPopup(preloadPath: string): BrowserWindow {
  win = new BrowserWindow({
    width: 460,
    height: 360,
    minWidth: 360,
    minHeight: 260,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Edge 音频需要先等待网络合成，播放调用会晚于用户点击，不能依赖已失效的手势授权。
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setAudioMuted(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 默认点击弹窗外部时关闭；顶部原生拖拽与钉住状态均忽略失焦事件。
  win.on('blur', handlePopupBlur)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

/**
 * 处理弹窗失焦；未固定弹窗在顶部原生拖拽期间不会被误关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupBlur(): void {
  if (!win?.isVisible()) return
  const cursorInsideDragRegion = isPointInPopupDragRegion(
    screen.getCursorScreenPoint(),
    win.getBounds()
  )
  if (!cursorInsideDragRegion && shouldDismissPopupOnBlur(pinned)) hidePopup()
}

/**
 * 将翻译弹窗放置在指定锚点附近，并限制在当前屏幕工作区内。
 * @param anchor 优先使用的选区屏幕坐标，未提供时使用当前鼠标坐标。
 * @returns 无返回值。
 * @author zhenghq
 */
function positionNearAnchor(anchor?: { x: number; y: number }): void {
  if (!win) return
  const point = anchor ?? screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const workArea = display.workArea
  const [width, height] = win.getSize()

  let x = point.x + CURSOR_GAP
  let y = point.y + CURSOR_GAP
  if (x + width > workArea.x + workArea.width) x = point.x - width - CURSOR_GAP
  if (y + height > workArea.y + workArea.height) y = point.y - height - CURSOR_GAP
  x = Math.max(
    workArea.x + WINDOW_EDGE_GAP,
    Math.min(x, workArea.x + workArea.width - width - WINDOW_EDGE_GAP)
  )
  y = Math.max(
    workArea.y + WINDOW_EDGE_GAP,
    Math.min(y, workArea.y + workArea.height - height - WINDOW_EDGE_GAP)
  )

  win.setPosition(Math.round(x), Math.round(y))
}

/**
 * 向弹窗 Renderer 投递翻译负载；页面尚未加载完成时排队，避免首次打开丢消息。
 * @param payload 翻译状态或结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function deliverPopupPayload(payload: TranslatePayload): void {
  if (!win) return
  if (win.webContents.isLoadingMainFrame()) {
    pendingPayloads.push(payload)
    if (pendingPayloads.length === 1) {
      win.webContents.once('did-finish-load', () => {
        if (!win) return
        const queued = pendingPayloads.splice(0)
        for (const item of queued) win.webContents.send('translate:result', item)
        win.webContents.send('popup:pinned', pinned)
      })
    }
    return
  }
  win.webContents.send('translate:result', payload)
  win.webContents.send('popup:pinned', pinned)
}

/**
 * 显示或更新翻译弹窗；弹窗已打开时保持原位置不跳动。
 * @param payload 翻译状态或结果。
 * @param autoHideMs 自动隐藏毫秒数，0 表示不自动关闭。
 * @param anchor 首次打开时使用的选区锚点。
 * @returns 无返回值。
 * @author zhenghq
 */
export function showPopup(
  payload: TranslatePayload,
  autoHideMs: number,
  anchor?: { x: number; y: number }
): void {
  if (!win) return
  currentAutoHideMs = Math.max(0, autoHideMs)
  const alreadyVisible = win.isVisible()
  deliverPopupPayload(payload)
  // 异步翻译结果到达时若弹窗已经显示，仅更新内容，避免重复显示操作打断拖拽与焦点。
  if (!alreadyVisible) {
    positionNearAnchor(anchor)
    // 首次显示时获取焦点，确保用户点击其他应用时能够触发 blur 关闭。
    win.show()
  }
  scheduleHide(autoHideMs)
}

/**
 * 显示手动翻译界面，并在页面就绪后通知 Renderer 切换模式和聚焦输入框。
 * @returns 无返回值。
 * @author zhenghq
 */
export function showManualTranslationPopup(): void {
  if (!win) return
  currentAutoHideMs = 0
  clearHide()
  const alreadyVisible = win.isVisible()
  if (!alreadyVisible) {
    positionNearAnchor()
    win.show()
  } else {
    win.focus()
  }
  win.webContents.send('popup:pinned', pinned)
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send('manual-translate:open')
    })
  } else {
    win.webContents.send('manual-translate:open')
  }
}

/**
 * 显式关闭翻译弹窗，并使正在进行的旧翻译结果失效。
 * @returns 无返回值。
 * @author zhenghq
 */
export function hidePopup(): void {
  clearHide()
  closeVersion += 1
  pinned = false
  win?.webContents.send('popup:pinned', false)
  win?.hide()
}

/**
 * 设置翻译弹窗是否固定在桌面上。
 * @param value 是否固定弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
export function setPopupPinned(value: boolean): void {
  pinned = value
  if (pinned) {
    clearHide()
  } else if (win?.isVisible()) {
    scheduleHide(currentAutoHideMs)
  }
  win?.webContents.send('popup:pinned', pinned)
}

/**
 * 返回翻译弹窗当前是否已固定。
 * @returns 弹窗固定状态。
 * @author zhenghq
 */
export function isPopupPinned(): boolean {
  return pinned
}

/**
 * 返回翻译弹窗当前是否可见。
 * @returns 弹窗可见状态。
 * @author zhenghq
 */
export function isPopupVisible(): boolean {
  return Boolean(win?.isVisible())
}

/**
 * 返回弹窗关闭版本号，用于阻止关闭后的异步结果重新打开弹窗。
 * @returns 当前关闭版本号。
 * @author zhenghq
 */
export function getPopupCloseVersion(): number {
  return closeVersion
}

/**
 * 判断指定屏幕坐标是否位于翻译弹窗内部。
 * @param point 待判断的屏幕坐标。
 * @returns 坐标是否位于弹窗内部。
 * @author zhenghq
 */
export function isPointInsidePopup(point: { x: number; y: number }): boolean {
  if (!win?.isVisible()) return false
  const bounds = win.getBounds()
  return point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
}

/**
 * 根据配置安排弹窗自动隐藏；0 表示保持打开。
 * @param milliseconds 自动隐藏毫秒数。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleHide(milliseconds: number): void {
  clearHide()
  if (!pinned && milliseconds > 0) hideTimer = setTimeout(hidePopup, milliseconds)
}

/**
 * 清除已有的自动隐藏计时器。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}
