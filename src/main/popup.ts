import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { PopupAutoSizeRequest, TranslatePayload } from '../shared/types'
import {
  resolvePopupAutoSize,
  resolvePopupResizeBounds
} from '../shared/popupAutoSize'
import { shouldDismissPopupOnBlur } from '../shared/popupBehavior'
import { isPointInPopupDragRegion } from '../shared/popupDragBehavior'
import {
  POPUP_FOREGROUND_RESTORE_SETTLE_MS,
  POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS,
  POPUP_RESULT_ACTIVATION_SETTLE_MS
} from '../shared/popupForeground'
import { createWindowsForegroundTracker } from './windowsForeground'
import {
  beginInternalWindowTeardown,
  endInternalWindowTeardown,
  handBackFrontmostThen,
  rememberFrontmostAppBeforeActivation,
  restoreFrontmostAppForCapture,
  yieldFrontmostAppThen
} from './macForeground'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

const WINDOW_EDGE_GAP = 8
const CURSOR_GAP = 16
/** hide 事件未按预期派发时，强制结束内部窗口收尾抑制期的最长等待时间。 */
const POPUP_TEARDOWN_FALLBACK_MS = 1500
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
 * 正在「先交还前台、再隐藏窗口」的过程中。
 * macOS 上弹窗是应用内最后一个 key window，交还前台需要等待系统确认失活（数十毫秒），
 * 此期间弹窗仍可见但逻辑上已关闭：新请求必须按「未显示」处理，否则会复用即将隐藏的窗口。
 */
let hidingAfterFrontReturn = false
/** 正在为取词主动归还前台焦点的截止时间；此窗口内的 blur 属于内部动作，不关闭弹窗。 */
let restoringForegroundUntil = 0
/**
 * 程序化激活弹窗后的迟到失焦宽限截止时间。
 *
 * 结果弹窗激活时，之前交还前台的 `open -b` 可能尚未完全收尾，源应用接管
 * key window 会让弹窗收到一次迟到的 blur。宽限窗口内这次失焦属于内部动作，
 * 必须吸收而不是关闭弹窗。
 */
let resultActivationSettleUntil = 0
/** 宽限窗口内是否已吸收过迟到失焦；用于安排重新聚焦并识别后续 focus 事件。 */
let resultActivationBlurAbsorbed = false
/** 吸收迟到失焦后安排的重新聚焦定时器。 */
let resultActivationRefocusTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 按钮取词交还前台期间是否处于失焦抑制。
 * macOS 点击“译”按钮后本应用是最前应用，open -b 源应用会让刚非激活显示的
 * 读取弹窗收到 blur；此时不能用固定毫秒窗口兜底，否则慢速前台切换仍会
 * 被误判为用户点击外部并关闭弹窗。此标记覆盖整个交还与取词准备阶段。
 */
let captureForegroundRestoreActive = false
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
  resultActivationSettleUntil = 0
  resultActivationBlurAbsorbed = false
  clearResultActivationRefocus()
  captureForegroundRestoreActive = false
  selectionCaptureLoading = false
  suppressExternalPointerDismissUntil = 0
  suppressExternalPointerDismissOrigin = null
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
 * 清除尚未触发的迟到失焦重新聚焦定时器。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearResultActivationRefocus(): void {
  if (resultActivationRefocusTimer) {
    clearTimeout(resultActivationRefocusTimer)
    resultActivationRefocusTimer = null
  }
}

/**
 * 在程序化激活弹窗前开启迟到失焦宽限。
 *
 * 仅 macOS 的划词翻译结果存在「交还前台 → 激活弹窗」的异步竞态：手动翻译、
 * OCR 等其它来源没有这段前台交还，必须保持原有「激活后失焦即关闭」语义，
 * 否则会吞掉用户真实的点击外部。
 * @param enabled 本次激活是否来自 macOS 划词翻译结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function armResultActivationSettle(enabled: boolean): void {
  clearResultActivationRefocus()
  resultActivationBlurAbsorbed = false
  if (!enabled || process.platform !== 'darwin') {
    resultActivationSettleUntil = 0
    return
  }
  resultActivationSettleUntil = Date.now() + POPUP_RESULT_ACTIVATION_SETTLE_MS
}

/**
 * 判断本次激活的负载是否需要开启迟到失焦宽限。
 * 只有 macOS 上由划词取词触发的结果/错误弹窗才会与前台交还竞争。
 * @param payload 即将展示的翻译负载。
 * @returns 需要开启宽限时返回 true。
 * @author zhenghq
 */
function shouldArmResultActivationSettle(payload: TranslatePayload): boolean {
  return process.platform === 'darwin' && payload.origin === 'selection'
}

/**
 * 判断当前失焦是否属于程序化激活弹窗后的迟到内部失焦。
 * 宽限窗口内一律按内部失焦处理并重新聚焦；窗口结束后恢复正常关闭语义。
 * 源应用接管 key window 与输入法切换可能连续派发多次失焦，因此同一宽限
 * 窗口内不能只吸收一次，否则后续失焦仍会关闭刚显示的弹窗。
 * @returns 应当吸收时返回 true。
 * @author zhenghq
 */
function shouldAbsorbResultActivationBlur(): boolean {
  if (Date.now() > resultActivationSettleUntil) return false
  resultActivationBlurAbsorbed = true
  return true
}

/**
 * 吸收迟到失焦后重新聚焦弹窗，恢复后续点击外部自动关闭的能力。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleResultActivationRefocus(): void {
  clearResultActivationRefocus()
  resultActivationRefocusTimer = setTimeout(() => {
    resultActivationRefocusTimer = null
    // 必须按逻辑可见性判断：正在「先交还前台、再隐藏」的弹窗窗口仍然物理可见，
    // 若只看 win.isVisible() 会在这里把它重新 show() 出来，导致外部点击关不掉。
    // 用户真的点了外部时，全局按下已同步进入关闭收尾，这里自然会跳过。
    if (!win || win.isDestroyed() || !isPopupVisible() || win.isFocused()) return
    win.show()
  }, POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS)
  resultActivationRefocusTimer.unref?.()
}

/**
 * 处理弹窗重新获得焦点：记录迟到失焦后的重新聚焦，但保留宽限窗口。
 *
 * 重新聚焦只说明弹窗暂时夺回 key window；源应用或输入法切换仍可能在随后
 * 再次派发失焦。宽限窗口必须按截止时间自然结束，否则后续失焦会关闭弹窗。
 * 真实的外部点击由全局按下兜底关闭，不依赖提前结束宽限。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupFocus(): void {
  // 只有吸收过迟到失焦后的这次重新聚焦才结束重新聚焦任务：首次 win.show()
  // 也会触发 focus，此时宽限窗口仍需保留以覆盖后续迟到失焦。
  if (!resultActivationBlurAbsorbed) return
  // 弹窗重新拿到焦点后，取词读取阶段的「非激活显示」标记同步失效，
  // 否则用户点击弹窗后再点击外部时不会触发自动关闭。
  shownInactive = false
  resultActivationBlurAbsorbed = false
  clearResultActivationRefocus()
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
  if (cursorInsideDragRegion) return
  // 取词读取阶段弹窗以 showInactive 显示，本就不持有 key window；此时任何
  // blur 都属于内部动作（交还前台、结果切换），不能误判为点击外部。
  if (shownInactive) return
  // 选区取词加载期间翻译结果尚未返回，前台交还与输入法切换可能派发迟到失焦；
  // 若据此关闭，用户表现为弹窗一闪即关。真实外部点击由全局按下兜底关闭。
  if (selectionCaptureLoading) return
  // 结果弹窗刚激活时，之前的 open -b 可能仍在收尾，源应用接管 key window
  // 会产生一次迟到失焦；宽限窗口内吸收并重新聚焦，避免弹窗一闪即关。
  if (shouldAbsorbResultActivationBlur()) {
    scheduleResultActivationRefocus()
    return
  }
  if (shouldDismissPopupOnBlur(pinned, isRestoringForeground())) {
    hidePopup()
  }
}

/**
 * 返回当前是否处于为取词主动归还前台焦点的短窗口内。
 * @returns 处于归还焦点窗口内时返回 true。
 * @author zhenghq
 */
function isRestoringForeground(): boolean {
  return captureForegroundRestoreActive ||
    Date.now() <= restoringForegroundUntil
}

/**
 * 让已激活的翻译弹窗主动退出前台，把焦点归还给源应用以便随后取词。
 * Windows 对已处于前台的窗口调用 showInactive 不会交还焦点，必须显式 blur；
 * macOS 上翻译结果弹窗同样会激活本应用，需按记录的源应用精确交还前台，
 * 否则第二次快捷键取词的复制键与 AX 焦点读取都会落在弹窗上。
 * 归还期间的失焦事件由 handlePopupBlur 短路，不会关闭弹窗。
 * @returns 实际执行了失活时返回 true；弹窗不可见或本就非激活时返回 false。
 * @author zhenghq
 */
export function deactivatePopupForCapture(): boolean {
  if (!win || !win.isVisible() || shownInactive) return false
  restoringForegroundUntil = Date.now() + POPUP_FOREGROUND_RESTORE_SETTLE_MS
  shownInactive = true
  // 先把焦点精确交还给记录的源应用：Windows 用 SetForegroundWindow 恢复 HWND，
  // macOS 用 open -b 重新激活源应用（blur 只放弃焦点，不保证系统挑回源应用）。
  const restored = process.platform === 'darwin'
    ? restoreFrontmostAppForCapture()
    : foregroundTracker.restore()
  // 记录缺失或交还失败时退回 blur，让系统挑选下一个前台窗口，至少弹窗不再持有焦点。
  if (!restored) win.blur()
  return true
}

/**
 * 进入按钮取词的弹窗失焦抑制，覆盖 macOS 交还前台与随后取词的整个阶段。
 *
 * 点击“译”按钮会让本应用成为最前应用，读取弹窗以非激活方式显示后，
 * 精确交还源应用会触发弹窗 blur。若不抑制，handlePopupBlur 会误判为用户
 * 点击外部并调用 hidePopup，表现为弹窗一闪即关。
 * @returns 无返回值。
 * @author zhenghq
 */
export function beginPopupForegroundRestoreForCapture(): void {
  captureForegroundRestoreActive = true
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
 * 解除按钮取词的弹窗失焦抑制，恢复点击外部自动关闭的语义。
 * @returns 无返回值。
 * @author zhenghq
 */
export function endPopupForegroundRestoreForCapture(): void {
  captureForegroundRestoreActive = false
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
    if (activate) armResultActivationSettle(shouldArmResultActivationSettle(payload))
    activate ? win.show() : win.showInactive()
    shownInactive = !activate
    if (activate) restoringForegroundUntil = 0
  } else if (activate && shownInactive) {
    rememberFrontmostAppBeforeActivation()
    foregroundTracker.remember()
    armResultActivationSettle(shouldArmResultActivationSettle(payload))
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
  if (pinned || isRestoringForeground() ||
      isSuppressedExternalPointerDismiss(point)) return false
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
  selectionCaptureLoading = false
  suppressExternalPointerDismissUntil = 0
  restoringForegroundUntil = 0
  resultActivationSettleUntil = 0
  resultActivationBlurAbsorbed = false
  clearResultActivationRefocus()
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
  /**
   * 隐藏弹窗并结束收尾抑制期。
   * @param force 为 true 时无条件执行隐藏，不因 `isVisible()` 短路。
   * @returns 无返回值。
   * @author zhenghq
   */
  const hideAndEndTeardown = (force = false): void => {
    // app.hide() 生效期间弹窗 isVisible() 同样为 false，若据此短路会跳过真正的
    // win.hide()，随后的 app.show() 再把弹窗恢复可见，表现为「点关闭关不掉」。
    // 安全让出分支必须传 force=true 走真实隐藏。
    if (!win || win.isDestroyed() || (!force && !win.isVisible())) {
      finishPopupTeardown()
      return
    }
    // win.hide() 只在可见性发生跳变时派发 hide 事件：安全让出期间窗口已被 app.hide()
    // 置为不可见，强制隐藏不会产生跳变。此时必须立即收尾，否则要等 1500ms 兜底定时器，
    // 期间用户对 Dock 的正常激活会被当成内部事件吞掉。
    const wasVisible = win.isVisible()
    // 记住本次收尾的窗口对象：模块级 win 可能被后续 createPopup() 替换，
    // 摘监听器必须针对本次真正隐藏的窗口。
    teardownTarget = win
    win.once('hide', finishPopupTeardown)
    // 窗口在 hide 事件前被销毁时也必须退出抑制期，避免状态永久卡住。
    win.once('closed', finishPopupTeardown)
    win?.hide()
    if (!wasVisible) {
      finishPopupTeardown()
      return
    }
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
    void yieldFrontmostAppThen(() => hideAndEndTeardown(true)).catch(() => {
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
  // 复用逻辑可见性：正在「先交还前台、再隐藏」的弹窗仍处于物理可见状态，
  // 但它已经在关闭收尾中，不能再把随后的划词手势判定为落在弹窗内部而吞掉。
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
