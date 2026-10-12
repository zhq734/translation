import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'
import { logCandidateProbe } from '../shared/activateDiagnostics'

const BUTTON_SIZE = 36
const EDGE_GAP = 8

let win: BrowserWindow | null = null
let rendererReady = false
let pendingAnchor: { x: number; y: number } | null = null
/**
 * 选区按钮自身隐藏时的内部窗口通知回调。
 *
 * 真机证据表明放行的 activate 并非由空操作 hide 派发（空 hide 与 activate 只是
 * 同一次外部 mousedown 的并发后果），因此这里属于纵深防御：真实隐藏
 * nonactivating panel 后，系统仍可能把同应用内下一个可见窗口提升为 key window
 * 并派发一次应用级 activate。调用方据此续期“非 Dock 激活”抑制窗口，可进一步
 * 降低误判为 Dock 点击的概率。
 */
let onInternalWindowHiddenCallback: (() => void) | null = null

/**
 * 通知调用方选区按钮已真正隐藏，用于续期内部 activate 抑制。
 * @returns 无返回值。
 * @author zhenghq
 */
function notifyInternalWindowHidden(): void {
  onInternalWindowHiddenCallback?.()
}

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

  win.setPosition(Math.round(x), Math.round(y))
  logCandidateProbe('selection-button-show-inactive', win.isVisible())
  win.showInactive()
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.moveTop()
}

/**
 * 按最近一次待处理的选区锚点恢复显示“译”图标。
 *
 * macOS 安全让出前台时会调用 app.hide() 隐藏整个应用，按钮窗口随之被隐藏；
 * 若此时划词刚触发 showInactive，显示动作会被整应用隐藏吞掉。待处理锚点保留到
 * 用户真正点击“译”或取消划词为止，应用恢复可见后据此重放显示。
 * @returns 无返回值。
 * @author zhenghq
 */
export function restoreSelectionButtonIfPending(): void {
  if (!pendingAnchor) return
  showReadySelectionButton(pendingAnchor)
}

/**
 * 创建选区旁的“译”图标窗口。
 * @param preloadPath 预加载脚本路径。
 * @param onInternalWindowHidden 图标窗口隐藏时的内部窗口通知回调。
 * @returns 创建后的图标窗口。
 * @author zhenghq
 */
export function createSelectionButton(
  preloadPath: string,
  onInternalWindowHidden?: () => void
): BrowserWindow {
  rendererReady = false
  pendingAnchor = null
  onInternalWindowHiddenCallback = onInternalWindowHidden ?? null
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
    // macOS 上使用 nonactivating panel：点击“译”按钮不应激活整个应用，
    // 否则系统会把同应用内可聚焦的可见设置页提升为 key window 带到最前。
    // 按钮本就 focusable:false + showInactive()，panel 只补齐“不激活应用”语义。
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
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
  const wasVisible = Boolean(win?.isVisible())
  logCandidateProbe('selection-button-hide', wasVisible)
  win?.hide()
  // 只有真实隐藏 panel 才续期：hideSelectionButton() 会在每次外部 mousedown
  // 被调用，按钮本就不可见时 win.hide() 是空操作，若也无条件续期，用户点击
  // Dock 的那次 mousedown 会把真实 Dock 激活一起吞掉。真实隐藏后系统可能把
  // 同应用内下一个可见窗口提升为 key window 并派发应用级 activate，续期必须
  // 紧随这次 hide()，才能覆盖该迟到 activate。
  if (wasVisible) notifyInternalWindowHidden()
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
