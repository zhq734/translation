import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

const BUTTON_SIZE = 36
const EDGE_GAP = 8

let win: BrowserWindow | null = null

/**
 * 创建选区旁的“译”图标窗口。
 * @param preloadPath 预加载脚本路径。
 * @returns 创建后的图标窗口。
 * @author zhenghq
 */
export function createSelectionButton(preloadPath: string): BrowserWindow {
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

  win.setPosition(Math.round(x), Math.round(y))
  win.showInactive()
}

/**
 * 隐藏选区旁的“译”图标。
 * @returns 无返回值。
 * @author zhenghq
 */
export function hideSelectionButton(): void {
  win?.hide()
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
