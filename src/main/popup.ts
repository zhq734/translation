import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { PopupAutoSizeRequest, TranslatePayload } from '../shared/types'
import {
  resolvePopupAutoSize,
  resolvePopupResizeBounds
} from '../shared/popupAutoSize'
import { shouldDismissPopupOnBlur } from '../shared/popupBehavior'
import { isPointInPopupDragRegion } from '../shared/popupDragBehavior'
import { createWindowsForegroundTracker } from './windowsForeground'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

const WINDOW_EDGE_GAP = 8
const CURSOR_GAP = 16
/**
 * 点击“译”按钮后忽略迟到外部按下的最长毫秒数。
 *
 * macOS 全局鼠标钩子可能重放或延迟派发同一次按钮按下的 mousedown：第一次事件
 * 已隐藏按钮并显示读取弹窗，迟到事件分类时按钮不可见，就会被当成外部点击关闭
 * 刚显示的弹窗。复制兜底超时为 800ms，抑制窗口必须覆盖该时长并留出余量，
 * 否则取词结果返回前到达的尾随按下仍会误关弹窗。抑制只对按钮原位置附近的
 * 按下生效，用户在其它位置的真实点击不受影响，仍会立即关闭弹窗。
 */
const EXTERNAL_POINTER_DISMISS_SUPPRESS_MS = 1000

/** 判定迟到按下是否仍属于同一次按钮点击的坐标容差（屏幕像素）。 */
const EXTERNAL_POINTER_DISMISS_SUPPRESS_RADIUS = 48

let win: BrowserWindow | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let closeVersion = 0
let pinned = false
let currentAutoHideMs = 0
let shownInactive = false
/**
 * 设置窗口打开期间是否保护翻译弹窗不被失焦关闭。
 *
 * 从翻译弹窗点击设置后，设置窗口会调用 show()/focus() 抢走焦点，弹窗因此收到
 * 一次 blur。该失焦来自应用内部窗口切换，不属于用户点击弹窗外部的自动关闭语义，
 * 必须抑制，否则用户会看到「打开设置时翻译弹窗一起关闭」。
 */
let settingsOpenGuardActive = false
/**
 * 选区取词是否处于加载态。
 *
 * 点击“译”后读取弹窗会切换为翻译加载态，此时结果尚未返回；macOS 的前台
 * 交还与输入法切换可能在此阶段派发迟到失焦。加载态期间不能按失焦关闭弹窗，
 * 真实的外部点击由全局按下兜底关闭，不依赖 blur。
 */
let selectionCaptureLoading = false
/**
 * 按钮点击后的外部按下关闭抑制截止时间。
 *
 * 只用于吞掉同一次按钮点击可能产生的迟到 / 重放全局按下，不改变弹窗正常的
 * blur 关闭语义。必须同时匹配按钮原位置附近的坐标：仅按时间窗口抑制会把
 * 用户在这段时间内其它位置的真实点击一并吞掉，重新引入“点空白不消失”。
 */
let suppressExternalPointerDismissUntil = 0
/** 触发抑制的按钮中心坐标；未记录时为 null，表示不做坐标匹配。 */
let suppressExternalPointerDismissOrigin: { x: number; y: number } | null = null
/**
 * 翻译弹窗自身显示 / 聚焦时的内部窗口通知回调。
 *
 * macOS 上弹窗 show() 会让该 panel 成为 key window，系统可能随之派发一次
 * 应用级 activate。该 activate 属于划词内部流程，调用方必须据此续期
 * “非 Dock 激活”抑制窗口，避免异步翻译结果上屏时把设置页误判为 Dock 激活。
 */
let onInternalWindowShown: (() => void) | null = null
/**
 * 源应用前台窗口跟踪器：弹窗激活前记录源窗口，取词前精确交还焦点。
 * Chromium 的 win.blur() 由系统按 Z-order 挑下一个前台窗口，不保证回到源应用。
 */
const foregroundTracker = createWindowsForegroundTracker({ platform: process.platform })
const pendingPayloads: TranslatePayload[] = []

/**
 * 创建翻译弹窗。
 * @param preloadPath 预加载脚本路径。
 * @param onWindowShown 弹窗自身显示 / 聚焦 / 隐藏时的内部窗口通知回调。
 * @returns 创建后的翻译弹窗。
 * @author zhenghq
 */
export function createPopup(
  preloadPath: string,
  onWindowShown?: () => void
): BrowserWindow {
  shownInactive = false
  settingsOpenGuardActive = false
  selectionCaptureLoading = false
  suppressExternalPointerDismissUntil = 0
  suppressExternalPointerDismissOrigin = null
  onInternalWindowShown = onWindowShown ?? null
  win = new BrowserWindow({
    width: 520,
    height: 360,
    minWidth: 520,
    minHeight: 320,
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
    // macOS 上使用 nonactivating panel：show()/focus() 只让弹窗自身成为 key window，
    // 不激活整个应用，从而避免把同应用其它可见窗口一起带到最前。
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Edge 音频需要先等待网络合成，播放调用会晚于用户点击，不能依赖已失效的手势授权。
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
  win.webContents.setAudioMuted(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 默认点击弹窗外部时关闭；顶部原生拖拽与钉住状态均忽略失焦事件。
  win.on('blur', handlePopupBlur)
  win.on('focus', handlePopupFocus)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

/**
 * 通知调用方翻译弹窗刚完成一次自身显示或聚焦。
 *
 * 只用于内部 activate 抑制续期，不触发任何窗口置前、聚焦或应用级激活动作，
 * 因此不会把同应用其它窗口一起带到最前。
 * @returns 无返回值。
 * @author zhenghq
 */
function notifyInternalWindowShown(): void {
  onInternalWindowShown?.()
}

/**
 * 处理弹窗重新获得焦点。
 *
 * 弹窗重新拿到焦点后，取词读取阶段的「非激活显示」标记同步失效，
 * 否则用户点击弹窗后再点击外部时不会触发自动关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupFocus(): void {
  shownInactive = false
  notifyInternalWindowShown()
}

/**
 * 处理弹窗失焦；未固定弹窗在顶部原生拖拽期间不会被误关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupBlur(): void {
  if (!win?.isVisible()) return
  // 设置窗口抢焦点属于应用内部窗口切换，不能按“点击弹窗外部”关闭翻译弹窗。
  if (settingsOpenGuardActive) return
  const cursorInsideDragRegion = isPointInPopupDragRegion(
    screen.getCursorScreenPoint(),
    win.getBounds()
  )
  if (cursorInsideDragRegion) return
  // 取词读取阶段弹窗以 showInactive 显示，本就不持有 key window；此时任何
  // blur 都属于内部动作（结果切换、窗口显隐），不能误判为点击外部。
  if (shownInactive) return
  // 选区取词加载期间翻译结果尚未返回，输入法切换等可能派发迟到失焦；
  // 若据此关闭，用户表现为弹窗一闪即关。真实外部点击由全局按下兜底关闭。
  if (selectionCaptureLoading) return
  // panel 下窗口切换不再激活应用，blur 只可能是用户真的点了弹窗外或弹窗内
  // 的其它控件；拖拽区域与固定状态仍由 shouldDismissPopupOnBlur 过滤。
  if (shouldDismissPopupOnBlur(pinned, false)) {
    hidePopup()
  }
}

/**
 * 开启设置窗口打开期间的弹窗失焦保护。
 *
 * 必须在调用设置窗口 show()/focus() 之前开启，以覆盖 blur 事件早于 focus 事件
 * 到达的平台事件顺序；保护期间设置窗口导致的内部失焦不会关闭翻译弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
export function beginPopupSettingsOpenGuard(): void {
  settingsOpenGuardActive = true
}

/**
 * 解除设置窗口打开期间的弹窗失焦保护。
 *
 * 设置窗口失焦、隐藏、销毁或打开失败时必须解除，恢复正常的点击弹窗外部
 * 自动关闭语义。
 * @returns 无返回值。
 * @author zhenghq
 */
export function endPopupSettingsOpenGuard(): void {
  settingsOpenGuardActive = false
}

/**
 * 返回设置窗口打开期间的弹窗失焦保护是否处于激活状态。
 *
 * 主进程的全局鼠标按下判定需要复用同一份保护状态：设置窗口的 focus 事件
 * 可能晚于全局 mousedown 到达，仅依赖窗口焦点会把点击设置页误判为点击
 * 弹窗外部，从而错误关闭翻译弹窗。
 * @returns 处于设置打开保护期时返回 true。
 * @author zhenghq
 */
export function isPopupSettingsOpenGuardActive(): boolean {
  return settingsOpenGuardActive
}

/**
 * 开启点击“译”按钮后的迟到外部按下抑制。
 *
 * 点击按钮会立即隐藏按钮并显示读取弹窗；全局钩子若随后再次派发同一次按下的
 * mousedown，按钮已经不可见，会被误分类为外部点击并关闭刚显示的弹窗。这里用
 * 一个很短的截止时间吞掉这类迟到事件，保证弹窗至少存活到取词流程接管。
 * @returns 无返回值。
 * @author zhenghq
 */
export function suppressExternalPointerDismissForButtonClick(origin?: { x: number; y: number }): void {
  suppressExternalPointerDismissUntil = Date.now() + EXTERNAL_POINTER_DISMISS_SUPPRESS_MS
  suppressExternalPointerDismissOrigin = origin ?? null
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
 * 按 Renderer 上报的内容自然尺寸调整弹窗，并保证新窗口仍完整落在当前显示器工作区内。
 * @param size 渲染进程测量得到的目标尺寸。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resizePopup(size: PopupAutoSizeRequest): void {
  if (!win || win.isDestroyed()) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const resolved = resolvePopupAutoSize(size, display.workArea, { edgeGap: WINDOW_EDGE_GAP })
  const next = resolvePopupResizeBounds(bounds, resolved, display.workArea)
  if (next.width === bounds.width && next.height === bounds.height &&
      next.x === bounds.x && next.y === bounds.y) {
    return
  }
  win.setBounds(next)
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
 * @param activate 首次显示时是否激活窗口；取词前传 false 可避免抢走源应用焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
export function showPopup(
  payload: TranslatePayload,
  autoHideMs: number,
  anchor?: { x: number; y: number },
  activate = true
): void {
  if (!win) return
  currentAutoHideMs = Math.max(0, autoHideMs)
  selectionCaptureLoading = payload.origin === 'selection' && payload.loading === true
  const alreadyVisible = win.isVisible()
  deliverPopupPayload(payload)
  // 异步翻译结果到达时若弹窗已经显示，仅更新内容，避免重复显示操作打断拖拽与焦点。
  if (!alreadyVisible) {
    positionNearAnchor(anchor)
    // Windows 复制取词前使用非激活显示，避免弹窗抢走源应用焦点；取词完成后再激活。
    // 激活会让弹窗顶掉源应用的前台状态，激活前先记录源窗口以便取词时精确交还。
    if (activate) foregroundTracker.remember()
    // macOS panel 的 show()/focus() 只让弹窗自身成为 key window，不激活整个应用，
    // 因此不再需要记录/交还应用级前台；Windows 仍按原有 show/showInactive 语义处理。
    activate ? win.show() : win.showInactive()
    shownInactive = !activate
  } else if (activate && shownInactive) {
    foregroundTracker.remember()
    win.show()
    shownInactive = false
  } else if (!activate && !shownInactive && alreadyVisible) {
    // 弹窗已可见且已被激活，需要降级为非激活以归还前台焦点给源应用。
    win.showInactive()
    shownInactive = true
  }
  // 弹窗每次自身显隐 / 聚焦都可能让 macOS 派发一次应用级 activate；
  // 无条件续期抑制，确保该内部 activate 不会被误判为 Dock 点击。
  notifyInternalWindowShown()
  scheduleHide(autoHideMs)
}

/**
 * 显示手动翻译界面，并在页面就绪后通知 Renderer 切换模式和聚焦输入框。
 * @returns 无返回值。
 * @author zhenghq
 */
export function showManualTranslationPopup(): void {
  if (!win) return
  selectionCaptureLoading = false
  currentAutoHideMs = 0
  clearHide()
  const alreadyVisible = win.isVisible()
  if (!alreadyVisible) {
    positionNearAnchor()
    win.show()
  } else {
    win.focus()
  }
  shownInactive = false
  win.webContents.send('popup:pinned', pinned)
  notifyInternalWindowShown()
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send('manual-translate:open')
    })
  } else {
    win.webContents.send('manual-translate:open')
  }
}

/**
 * 处理全局鼠标按下判定的外部点击：主动关闭可见且未固定的弹窗。
 *
 * 只依赖窗口 blur 存在漏触发场景：读取状态与失败提示以 showInactive 显示，
 * 本就不持有 key window，此后用户点击外部不会再产生 blur，弹窗会一直留在屏上、
 * 前台也一直不归还，后续划词显示的“译”按钮会被应用级状态吞掉
 * （点弹窗关闭按钮才能恢复）。这里在全局按下阶段兜底关闭，保证归还流程一定执行。
 * 固定弹窗与取词主动交还前台的短窗口内不受影响。
 * @returns 本次是否已发起弹窗关闭。
 * @author zhenghq
 */
export function dismissPopupOnExternalPointerDown(point?: { x: number; y: number }): boolean {
  // 读取状态弹窗与失败提示以 showInactive 显示，不持有 key window，也不会再产生
  // blur；只看 isPopupActivated() 会漏掉这类弹窗，点击外部后它会一直留在屏上。
  if (!isPopupVisible()) return false
  // 按钮点击的迟到按下属于同一次交互，会被误分类为外部点击关闭读取弹窗；
  // 必须同时匹配抑制窗口与按钮原位置附近坐标，只吞掉同一次点击的迟到事件。
  // 仅按时间窗口短路会吞掉用户在这段时间内其它位置的真实点击，重新引入
  // “点空白不消失”；加载态只用于吸收迟到的 blur，不能在全局按下阶段短路。
  if (pinned || isSuppressedExternalPointerDismiss(point)) return false
  console.log('[popup] 外部点击主动关闭弹窗并归还前台')
  hidePopup()
  return true
}

/**
 * 判断一次全局按下是否属于按钮点击的迟到 / 重放事件。
 *
 * 时间窗口保证只覆盖同一次交互；坐标匹配保证只有按钮原位置附近的按下被吞掉，
 * 用户在弹窗之外其它位置的真实点击不会被误抑制。
 * @param point 本次全局按下的屏幕坐标；省略时退化为仅按时间窗口判定。
 * @returns 属于迟到按钮按下时返回 true。
 * @author zhenghq
 */
function isSuppressedExternalPointerDismiss(point?: { x: number; y: number }): boolean {
  if (Date.now() > suppressExternalPointerDismissUntil) return false
  const origin = suppressExternalPointerDismissOrigin
  if (!point || !origin) return true
  return Math.abs(point.x - origin.x) <= EXTERNAL_POINTER_DISMISS_SUPPRESS_RADIUS &&
    Math.abs(point.y - origin.y) <= EXTERNAL_POINTER_DISMISS_SUPPRESS_RADIUS
}

/**
 * 显式关闭翻译弹窗，并使正在进行的旧翻译结果失效。
 *
 * macOS 上弹窗是 nonactivating panel：隐藏窗口不会激活应用，也不会把同应用
 * 其它窗口提升到最前，因此直接 win.hide() 即可。Windows 仍保留弹窗失活以
 * 归还前台焦点，避免下一次取词的复制键落在弹窗上。
 * @returns 无返回值。
 * @author zhenghq
 */
export function hidePopup(): void {
  clearHide()
  closeVersion += 1
  pinned = false
  selectionCaptureLoading = false
  suppressExternalPointerDismissUntil = 0
  suppressExternalPointerDismissOrigin = null
  win?.webContents.send('popup:pinned', false)
  if (!win || win.isDestroyed()) return
  // Windows 上弹窗处于激活状态时必须先让出前台，否则下一次取词的 WM_COPY
  // 与注入的 Ctrl+C 会打在弹窗上；macOS panel 不存在应用级前台占用，直接隐藏。
  if (process.platform === 'win32' && !shownInactive) {
    foregroundTracker.restore()
  }
  shownInactive = false
  win.hide()
  // 隐藏 panel 后系统可能把同应用内下一个可见窗口提升为 key window，
  // 并派发一次应用级 activate；该 activate 同样属于内部流程，必须续期抑制。
  notifyInternalWindowShown()
}

/**
 * 只隐藏翻译弹窗自身，不影响应用内其它窗口。
 *
 * 从翻译弹窗打开设置页时，设置窗口会接管焦点；关闭弹窗不能触发任何应用级
 * 前台交还或整应用隐藏，否则用户已打开的设置页会被一起隐藏。panel 落地后
 * hidePopup() 已直接隐藏窗口，本入口保留独立语义以便调用方明确意图。
 * @returns 无返回值。
 * @author zhenghq
 */
export function hidePopupForInternalWindowSwitch(): void {
  hidePopup()
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
 * 返回翻译弹窗当前是否已激活（可见且非 showInactive 显示）。
 * 用于快捷键取词前判断弹窗是否抢占了前台焦点，需要先隐藏归还焦点。
 * @returns 弹窗可见且已被激活时返回 true。
 * @author zhenghq
 */
export function isPopupActivated(): boolean {
  return Boolean(win?.isVisible()) && !shownInactive
}

/**
 * 取词前把前台焦点归还给源应用（仅 Windows 生效）。
 *
 * Windows 上弹窗被上一次翻译结果的 show() 激活后会成为前台窗口，随后注入的
 * Ctrl+C 会落在弹窗上导致取词超时；必须在取词前用 SetForegroundWindow 精确
 * 交还给记录的源窗口。macOS panel 不激活应用，不存在该问题，直接返回 false。
 * @returns 本次是否实际交还了前台焦点。
 * @author zhenghq
 */
export function deactivatePopupForCapture(): boolean {
  if (process.platform !== 'win32') return false
  if (!win || !win.isVisible() || shownInactive) return false
  shownInactive = true
  // 记录缺失或交还失败时退回 blur，让系统挑选下一个前台窗口，
  // 至少弹窗不再持有焦点，避免复制键继续打在弹窗上。
  const restored = foregroundTracker.restore()
  if (!restored) win.blur()
  return true
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
  const target = win
  if (!target || !isPopupVisible()) return false
  const bounds = target.getBounds()
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
