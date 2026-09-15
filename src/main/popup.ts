import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { TranslatePayload } from '../shared/types'
import { shouldDismissPopupOnBlur } from '../shared/popupBehavior'
import { isPointInPopupDragRegion } from '../shared/popupDragBehavior'
import { POPUP_FOREGROUND_RESTORE_SETTLE_MS } from '../shared/popupForeground'
import { createWindowsForegroundTracker } from './windowsForeground'
import {
  beginInternalWindowTeardown,
  endInternalWindowTeardown,
  handBackFrontmostThen,
  rememberFrontmostAppBeforeActivation,
  yieldFrontmostAppThen
} from './macForeground'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

const WINDOW_EDGE_GAP = 8
const CURSOR_GAP = 16
/** hide 事件未按预期派发时，强制结束内部窗口收尾抑制期的最长等待时间。 */
const POPUP_TEARDOWN_FALLBACK_MS = 1500

let win: BrowserWindow | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let closeVersion = 0
let pinned = false
let currentAutoHideMs = 0
let shownInactive = false
/**
 * 正在「先交还前台、再隐藏窗口」的过程中。
 * macOS 上弹窗是应用内最后一个 key window，交还前台需要等待系统确认失活（数十毫秒），
 * 此期间弹窗仍可见但逻辑上已关闭：新请求必须按「未显示」处理，否则会复用即将隐藏的窗口。
 */
let hidingAfterFrontReturn = false
/** 正在为取词主动归还前台焦点的截止时间；此窗口内的 blur 属于内部动作，不关闭弹窗。 */
let restoringForegroundUntil = 0
/**
 * 源应用前台窗口跟踪器：弹窗激活前记录源窗口，取词前精确交还焦点。
 * Chromium 的 win.blur() 由系统按 Z-order 挑下一个前台窗口，不保证回到源应用。
 */
const foregroundTracker = createWindowsForegroundTracker({ platform: process.platform })
const pendingPayloads: TranslatePayload[] = []

/**
 * 创建翻译弹窗。
 * @param preloadPath 预加载脚本路径。
 * @returns 创建后的翻译弹窗。
 * @author zhenghq
 */
export function createPopup(preloadPath: string): BrowserWindow {
  shownInactive = false
  hidingAfterFrontReturn = false
  restoringForegroundUntil = 0
  win = new BrowserWindow({
    width: 460,
    height: 360,
    minWidth: 360,
    minHeight: 260,
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
  if (!cursorInsideDragRegion &&
      shouldDismissPopupOnBlur(pinned, isRestoringForeground())) {
    hidePopup()
  }
}

/**
 * 返回当前是否处于为取词主动归还前台焦点的短窗口内。
 * @returns 处于归还焦点窗口内时返回 true。
 * @author zhenghq
 */
function isRestoringForeground(): boolean {
  return Date.now() <= restoringForegroundUntil
}

/**
 * 让已激活的翻译弹窗主动退出前台，把焦点归还给源应用以便随后取词。
 * Windows 对已处于前台的窗口调用 showInactive 不会交还焦点，必须显式 blur；
 * 归还期间的失焦事件由 handlePopupBlur 短路，不会关闭弹窗。
 * @returns 实际执行了失活时返回 true；弹窗不可见或本就非激活时返回 false。
 * @author zhenghq
 */
export function deactivatePopupForCapture(): boolean {
  if (!win || !win.isVisible() || shownInactive) return false
  restoringForegroundUntil = Date.now() + POPUP_FOREGROUND_RESTORE_SETTLE_MS
  shownInactive = true
  // 先把焦点精确交还给记录的源应用窗口；SetForegroundWindow 成功时源应用立即回到前台。
  const restored = foregroundTracker.restore()
  // 记录缺失或交还失败时退回 blur，让系统挑选下一个前台窗口，至少弹窗不再持有焦点。
  if (!restored) win.blur()
  return true
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
  const alreadyVisible = win.isVisible() && !hidingAfterFrontReturn
  deliverPopupPayload(payload)
  // 异步翻译结果到达时若弹窗已经显示，仅更新内容，避免重复显示操作打断拖拽与焦点。
  if (!alreadyVisible) {
    positionNearAnchor(anchor)
    // Windows 复制取词前使用非激活显示，避免弹窗抢走源应用焦点；取词完成后再激活。
    // 激活会让弹窗顶掉源应用的前台状态，激活前先记录源窗口以便取词时精确交还。
    // 同步补记源应用：上一轮结果弹窗已激活本应用时，异步的
    // rememberFrontmostAppIfInactive() 会因应用内已有焦点窗口而跳过，
    // 导致本次收尾没有可交还目标，只能落到不稳定的 app.hide()→app.show() 兜底。
    if (activate) rememberFrontmostAppBeforeActivation()
    if (activate) foregroundTracker.remember()
    activate ? win.show() : win.showInactive()
    shownInactive = !activate
    if (activate) restoringForegroundUntil = 0
  } else if (activate && shownInactive) {
    rememberFrontmostAppBeforeActivation()
    foregroundTracker.remember()
    win.show()
    shownInactive = false
    restoringForegroundUntil = 0
  } else if (!activate && !shownInactive && alreadyVisible) {
    // 弹窗已可见且已被激活，需要降级为非激活以归还前台焦点给源应用。
    win.showInactive()
    shownInactive = true
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
  shownInactive = false
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
 *
 * macOS 上弹窗通常是应用内最后一个 key window：直接隐藏会让系统把应用内下一个窗口
 * （设置页）提升为 key window 并顶到其它应用之上，用户表现为「弹窗消失后设置页弹到最前」。
 * 因此先把前台交还给用户原本在用的应用，确认本应用失活后再隐藏窗口。
 * 交还期间弹窗逻辑上已关闭，新请求不会复用即将隐藏的窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
export function hidePopup(): void {
  clearHide()
  closeVersion += 1
  pinned = false
  shownInactive = false
  restoringForegroundUntil = 0
  win?.webContents.send('popup:pinned', false)
  if (!win || win.isDestroyed() || hidingAfterFrontReturn) return
  hidingAfterFrontReturn = true
  // 进入收尾抑制期：覆盖「交还前台 → 隐藏弹窗 → hide 真正生效」整段窗口期。
  // 期间到达的 macOS activate 属于内部窗口显隐引发的事件，不能被当成 Dock 启动
  // 去激活网页阅读器或设置页。
  beginInternalWindowTeardown()
  // 交还前把这段失焦标记为内部动作：激活源应用会让弹窗失焦，
  // 不能被 handlePopupBlur 当成用户点击外部而重复关闭。
  restoringForegroundUntil = Date.now() + POPUP_FOREGROUND_RESTORE_SETTLE_MS

  // win.hide() 异步生效：必须等 hide 事件真正到达后再退出抑制期，
  // 否则 hide 生效瞬间派发的内部事件会看到抑制期已结束而被误放行。
  let teardownTarget: BrowserWindow | null = null
  const hideAndEndTeardown = (): void => {
    if (!win || win.isDestroyed() || !win.isVisible()) {
      finishPopupTeardown()
      return
    }
    // 记住本次收尾的窗口对象：模块级 win 可能被后续 createPopup() 替换，
    // 摘监听器必须针对本次真正隐藏的窗口。
    teardownTarget = win
    win.once('hide', finishPopupTeardown)
    // 窗口在 hide 事件前被销毁时也必须退出抑制期，避免状态永久卡住。
    win.once('closed', finishPopupTeardown)
    win?.hide()
    // 非 macOS 平台不存在「隐藏 key window 会提升应用内其它窗口」的问题，
    // 保持原有同步收尾语义，不引入额外的逻辑关闭窗口期。
    if (process.platform !== 'darwin') {
      finishPopupTeardown()
      return
    }
    // 最后一道兜底：hide 事件因平台差异未派发时，抑制期必须自行结束，
    // 否则 Dock 激活会被永久拦截。
    const teardownFallback = setTimeout(finishPopupTeardown, POPUP_TEARDOWN_FALLBACK_MS)
    teardownFallback.unref?.()
  }

  // hide 事件与 closed 事件共用同一收尾，且函数声明会提升，
  // 保证「先隐藏窗口，再退出抑制期并解除逻辑关闭标记」的先后语义。
  let popupTeardownFinished = false
  function finishPopupTeardown(): void {
    if (popupTeardownFinished) return
    popupTeardownFinished = true
    // 收尾完成后立即摘掉另一个事件的监听，避免窗口复用时累积监听器。
    if (teardownTarget && !teardownTarget.isDestroyed()) {
      teardownTarget.removeListener('hide', finishPopupTeardown)
      teardownTarget.removeListener('closed', finishPopupTeardown)
    }
    endInternalWindowTeardown()
    hidingAfterFrontReturn = false
  }

  handBackFrontmostThen(win, () => {
    hideAndEndTeardown()
  }, () => {
    // 拿不到源应用（快照读取失败、源应用已退出，或弹窗激活前本应用已是最前）时
    // 不能直接隐藏：本应用此时仍是最前应用，隐藏应用内 key window 会让系统把应用内
    // 下一个窗口提升为 key window，正在后台打开的网页阅读器会被顶到用户应用之上。
    // 改用安全让出序列：隐藏应用等待失活后收尾，再非激活恢复应用内其它窗口。
    void yieldFrontmostAppThen(hideAndEndTeardown).catch(() => {
      // 让出序列自身失败时兜底退出抑制期，不能把状态永久留在收尾中。
      popupTeardownFinished = true
      endInternalWindowTeardown()
      hidingAfterFrontReturn = false
    })
  })
}

/**
 * 在翻译弹窗真正隐藏之后执行回调；弹窗已隐藏或已销毁时立即执行。
 *
 * 取词失败提示的交互租约必须在弹窗隐藏收尾完成后才释放：提前清零会让
 * 收尾期间到达的内部 activate 失去时间维度防线，把设置页或阅读器顶到最前。
 * @param callback 弹窗隐藏后执行的回调。
 * @returns 取消注册的函数；回调已立即执行时为空操作。
 * @author zhenghq
 */
export function whenPopupHidden(callback: () => void): () => void {
  if (!win || win.isDestroyed() || !win.isVisible()) {
    callback()
    return () => {}
  }
  const target = win
  target.once('hide', callback)
  // 取词失败可能连续发生：调用方需要能撤销注册，
  // 否则长期复用的弹窗会不断累积 hide 监听器。
  return () => {
    if (!target.isDestroyed()) target.removeListener('hide', callback)
  }
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
  return Boolean(win?.isVisible()) && !hidingAfterFrontReturn
}

/**
 * 返回翻译弹窗是否正在执行「先交还前台、再隐藏」的收尾流程。
 *
 * 此期间弹窗窗口仍然可见，但逻辑上已关闭：既不能被当成普通可见弹窗参与交互判定，
 * 也要抑制 macOS 在交还前台过程中产生的内部 activate，
 * 否则应用会把网页翻译或设置页当作 Dock 启动重新激活并顶到最前。
 * @returns 正在交还前台时返回 true。
 * @author zhenghq
 */
export function isPopupHandingBackFront(): boolean {
  return hidingAfterFrontReturn
}

/**
 * 返回翻译弹窗当前是否已激活（可见且非 showInactive 显示）。
 * 用于快捷键取词前判断弹窗是否抢占了前台焦点，需要先隐藏归还焦点。
 * @returns 弹窗可见且已被激活时返回 true。
 * @author zhenghq
 */
export function isPopupActivated(): boolean {
  return Boolean(win?.isVisible()) && !shownInactive && !hidingAfterFrontReturn
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
