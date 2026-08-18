import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

const BUTTON_SIZE = 36
const EDGE_GAP = 8

let win: BrowserWindow | null = null
let rendererReady = false
let pendingAnchor: { x: number; y: number } | null = null

/**
 * 计算“译”图标位置并显示已经完成渲染的窗口。
 * @param anchor 选区右上角的屏幕坐标。
 * @returns 无返回值。
 * @author zhenghq
 */
function showReadySelectionButton(anchor: { x: number; y: number }): void {
  if (!win || !rendererReady) return
  const display = screen.getDisplayNearestPoint(anchor)
  const workArea = display.workArea
  const preferredX = anchor.x + 6
  const preferredY = anchor.y - BUTTON_SIZE - 4
  const x = Math.max(
    workArea.x + EDGE_GAP,
    Math.min(preferredX, workArea.x + workArea.width - BUTTON_SIZE - EDGE_GAP)
  )
  const y = Math.max(
    workArea.y + EDGE_GAP,
    Math.min(preferredY, workArea.y + workArea.height - BUTTON_SIZE - EDGE_GAP)
  )

  pendingAnchor = null
  win.setPosition(Math.round(x), Math.round(y))
  win.showInactive()
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.moveTop()
}

/**
 * 创建选区旁的“译”图标窗口。
 * @param preloadPath 预加载脚本路径。
 * @returns 创建后的图标窗口。
 * @author zhenghq
 */
export function createSelectionButton(preloadPath: string): BrowserWindow {
  rendererReady = false
  pendingAnchor = null
  win = new BrowserWindow({
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.once('did-finish-load', () => {
    rendererReady = true
    if (pendingAnchor) showReadySelectionButton(pendingAnchor)
  })
  win.on('closed', () => {
    win = null
    rendererReady = false
    pendingAnchor = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/selection.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/selection.html'))
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

/**
 * 在选中文字右上角附近显示“译”图标，并保证图标处于当前屏幕工作区内。
 * @param anchor 选区右上角的屏幕坐标。
 * @returns 无返回值。
 * @author zhenghq
 */
export function showSelectionButton(anchor: { x: number; y: number }): void {
  if (!win) return
  pendingAnchor = anchor
  showReadySelectionButton(anchor)
}

/**
 * 隐藏选区旁的“译”图标。
 * @returns 无返回值。
 * @author zhenghq
 */
export function hideSelectionButton(): void {
  pendingAnchor = null
  win?.hide()
}

/**
 * 返回选区旁“译”图标窗口当前是否可见。
 * @returns 图标窗口是否可见。
 * @author zhenghq
 */
export function isSelectionButtonVisible(): boolean {
  return Boolean(win?.isVisible())
}

/**
 * 判断指定屏幕坐标是否位于“译”图标窗口内部。
 * @param point 待判断的屏幕坐标。
 * @returns 坐标是否位于图标窗口内部。
 * @author zhenghq
 */
export function isPointInsideSelectionButton(point: { x: number; y: number }): boolean {
  if (!win?.isVisible()) return false
  const bounds = win.getBounds()
  return point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
}
