import type {
  OcrSelectionBounds,
  OcrSelectionStartPayload,
  ScreenshotOcrActionRequest,
  ScreenshotOcrActionResult,
  ScreenshotOcrRecognizeResult
} from '../../shared/types'

const translateButton = document.getElementById('translate') as HTMLButtonElement
const ocrOverlay = document.getElementById('ocr-overlay') as HTMLElement
const ocrSnapshot = document.getElementById('ocr-snapshot') as HTMLImageElement
const ocrSelectionBox = document.getElementById('ocr-selection-box') as HTMLElement
const ocrToolbar = document.getElementById('ocr-toolbar') as HTMLElement
const ocrRecognizeButton = document.getElementById('ocr-recognize') as HTMLButtonElement
const ocrTranslateButton = document.getElementById('ocr-translate') as HTMLButtonElement
const ocrCopyImageButton = document.getElementById('ocr-copy-image') as HTMLButtonElement
const ocrSaveImageButton = document.getElementById('ocr-save-image') as HTMLButtonElement
const ocrCancelButton = document.getElementById('ocr-cancel') as HTMLButtonElement
const ocrPanel = document.getElementById('ocr-panel') as HTMLElement
const ocrPanelStatus = document.getElementById('ocr-panel-status') as HTMLElement
const ocrPanelText = document.getElementById('ocr-panel-text') as HTMLTextAreaElement
const ocrTooltip = document.getElementById('ocr-tooltip') as HTMLElement
const ocrPanelResizeHandle = document.getElementById('ocr-panel-resize') as HTMLElement
const ocrResizeHandles = Array.from(
  document.querySelectorAll<HTMLElement>('.ocr-resize-handle')
)

const MIN_SELECTION_SIZE = 8
const OCR_PANEL_GAP = 12
/** 空白处按下后判定为新一次框选的最小拖动距离，避免单击误清旧选区。 */
const OCR_DRAW_THRESHOLD = 3
/** OCR 侧栏手动调整时的最小尺寸。 */
const OCR_PANEL_MIN_WIDTH = 160
const OCR_PANEL_MIN_HEIGHT = 120
type DragHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
type DragState = {
  type: 'draw' | 'move' | 'resize'
  start: { x: number; y: number }
  initial: OcrSelectionBounds
  handle?: DragHandle
  /** draw 类型是否已越过拖动阈值并真正开始绘制新选区。 */
  activated?: boolean
}

let ocrMode = false
let dragState: DragState | null = null
let currentRect: OcrSelectionBounds | null = null
// 截图“文字识别”进行中标记：防止同一识别请求重复提交。
let screenshotRecognizePending = false
// 当前截图动作请求 ID：仅响应当前请求的结果事件，丢弃旧回调。
let pendingScreenshotRequestId: string | null = null
// 截图动作请求自增序号，用于生成唯一请求 ID。
let screenshotRequestSeq = 0
// OCR 侧栏状态：pending 处理中 / ready 展示文本（成功或失败描述）。
let ocrPanelState: 'hidden' | 'pending' | 'ready' = 'hidden'
// OCR 侧栏用户手动调整的尺寸；为 null 时按默认自适应尺寸布局。
let ocrPanelUserSize: { width: number; height: number } | null = null
// OCR 侧栏尺寸拖拽状态：记录起点与初始尺寸。
let ocrPanelResizeState: {
  start: { x: number; y: number }
  initial: { width: number; height: number }
} | null = null

/**
 * 响应选区旁“译”按钮点击，并请求主进程捕获当前选中文字。
 * @returns 无返回值。
 * @author zhenghq
 */
function translateSelection(): void {
  window.api.translateSelection()
}

/**
 * 将数值限制在给定区间内。
 * @param value 待限制的数值。
 * @param min 最小值。
 * @param max 最大值。
 * @returns 限制后的数值。
 * @author zhenghq
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * 获取当前 OCR 覆盖层可用尺寸。
 * @returns 覆盖层宽高。
 * @author zhenghq
 */
function getOverlaySize(): { width: number; height: number } {
  return {
    width: Math.max(1, ocrOverlay.clientWidth || window.innerWidth),
    height: Math.max(1, ocrOverlay.clientHeight || window.innerHeight)
  }
}

/**
 * 将矩形限制在当前覆盖层内部。
 * @param rect 待限制的选区矩形。
 * @returns 限制后的选区矩形。
 * @author zhenghq
 */
function clampRectToOverlay(rect: OcrSelectionBounds): OcrSelectionBounds {
  const size = getOverlaySize()
  const width = Math.max(0, Math.min(rect.width, size.width))
  const height = Math.max(0, Math.min(rect.height, size.height))
  return {
    x: clamp(rect.x, 0, Math.max(0, size.width - width)),
    y: clamp(rect.y, 0, Math.max(0, size.height - height)),
    width,
    height
  }
}

/**
 * 根据拖拽起点和当前点计算规范化选区。
 * @param start 拖拽起点。
 * @param end 当前鼠标位置。
 * @returns 规范化后的选区。
 * @author zhenghq
 */
function buildSelectionRect(
  start: { x: number; y: number },
  end: { x: number; y: number }
): OcrSelectionBounds {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return clampRectToOverlay({
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  })
}

/**
 * 根据拖拽状态移动当前选区。
 * @param state 拖拽状态。
 * @param point 当前指针坐标。
 * @returns 移动后的选区。
 * @author zhenghq
 */
function moveSelectionRect(state: DragState, point: { x: number; y: number }): OcrSelectionBounds {
  const dx = point.x - state.start.x
  const dy = point.y - state.start.y
  return clampRectToOverlay({
    ...state.initial,
    x: state.initial.x + dx,
    y: state.initial.y + dy
  })
}

/**
 * 根据拖拽控制点缩放当前选区。
 * @param state 拖拽状态。
 * @param point 当前指针坐标。
 * @returns 缩放后的选区。
 * @author zhenghq
 */
function resizeSelectionRect(state: DragState, point: { x: number; y: number }): OcrSelectionBounds {
  const dx = point.x - state.start.x
  const dy = point.y - state.start.y
  const handle = state.handle ?? 'se'
  let left = state.initial.x
  let top = state.initial.y
  let right = state.initial.x + state.initial.width
  let bottom = state.initial.y + state.initial.height

  if (handle.includes('w')) left += dx
  if (handle.includes('e')) right += dx
  if (handle.includes('n')) top += dy
  if (handle.includes('s')) bottom += dy

  return buildSelectionRect({ x: left, y: top }, { x: right, y: bottom })
}

/**
 * 更新选区调整点显示状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateResizeHandlePositions(): void {
  const hidden = !currentRect
  for (const handle of ocrResizeHandles) {
    handle.hidden = hidden
  }
}

/**
 * 根据当前选区位置更新确认工具条。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrToolbar(): void {
  if (!currentRect || currentRect.width < MIN_SELECTION_SIZE || currentRect.height < MIN_SELECTION_SIZE) {
    ocrToolbar.hidden = true
    return
  }
  const size = getOverlaySize()
  const toolbarWidth = ocrToolbar.offsetWidth || 128
  const toolbarHeight = ocrToolbar.offsetHeight || 36
  const x = clamp(currentRect.x + currentRect.width - toolbarWidth, 8, Math.max(8, size.width - toolbarWidth - 8))
  const belowY = currentRect.y + currentRect.height + 8
  const aboveY = currentRect.y - toolbarHeight - 8
  const y = belowY + toolbarHeight <= size.height
    ? belowY
    : clamp(aboveY, 8, Math.max(8, size.height - toolbarHeight - 8))
  ocrToolbar.style.left = `${Math.round(x)}px`
  ocrToolbar.style.top = `${Math.round(y)}px`
  ocrToolbar.hidden = false
  layoutOcrPanel()
}

/**
 * 计算 OCR 侧栏位置：优先位于当前选区右侧，空间不足时回退左侧，
 * 仍不足时放置在覆盖层内部可用区域，并限制在可视范围内。
 * @returns 无返回值。
 * @author zhenghq
 */
function layoutOcrPanel(): void {
  if (ocrPanelState === 'hidden' || !currentRect) return
  const size = getOverlaySize()
  const panelWidth = ocrPanelUserSize?.width ?? (ocrPanel.offsetWidth || 260)
  const panelHeight = ocrPanelUserSize?.height ?? (ocrPanel.offsetHeight || 200)
  // 用户手动调整过尺寸时优先使用该尺寸，并限制在覆盖层可视范围内。
  if (ocrPanelUserSize) {
    ocrPanel.style.width = `${Math.round(panelWidth)}px`
    ocrPanel.style.height = `${Math.round(panelHeight)}px`
  }
  const margin = 8
  const rightSpace = size.width - (currentRect.x + currentRect.width) - OCR_PANEL_GAP - margin
  const leftSpace = currentRect.x - OCR_PANEL_GAP - margin
  let x: number
  if (rightSpace >= panelWidth) {
    x = currentRect.x + currentRect.width + OCR_PANEL_GAP
  } else if (leftSpace >= panelWidth) {
    x = currentRect.x - OCR_PANEL_GAP - panelWidth
  } else {
    // 两侧均放不下时收缩面板宽度并放入覆盖层内部可用区域（不覆盖用户手动尺寸的高度）
    const innerWidth = Math.max(OCR_PANEL_MIN_WIDTH, Math.max(rightSpace, leftSpace, size.width - margin * 2))
    ocrPanel.style.width = `${Math.round(Math.min(panelWidth, innerWidth))}px`
    x = clamp(
      rightSpace >= leftSpace
        ? currentRect.x + currentRect.width + OCR_PANEL_GAP
        : currentRect.x - OCR_PANEL_GAP - panelWidth,
      margin,
      Math.max(margin, size.width - panelWidth - margin)
    )
  }
  const y = clamp(
    currentRect.y,
    margin,
    Math.max(margin, size.height - panelHeight - margin)
  )
  ocrPanel.style.left = `${Math.round(clamp(x, margin, Math.max(margin, size.width - panelWidth - margin)))}px`
  ocrPanel.style.top = `${Math.round(y)}px`
}

/**
 * 响应 OCR 侧栏调整手柄按下，开始手动调整识别结果区域大小。
 * @param event 鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrPanelResizeStart(event: MouseEvent): void {
  if (!ocrMode || event.button !== 0 || ocrPanelState === 'hidden') return
  const rect = ocrPanel.getBoundingClientRect()
  ocrPanelResizeState = {
    start: { x: event.clientX, y: event.clientY },
    initial: { width: rect.width, height: rect.height }
  }
  event.preventDefault()
  event.stopPropagation()
}

/**
 * 响应 OCR 侧栏调整手柄拖拽，实时更新用户自定义尺寸并重新布局。
 * @param event 鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrPanelResizeMove(event: MouseEvent): void {
  if (!ocrPanelResizeState) return
  const size = getOverlaySize()
  const width = clamp(
    ocrPanelResizeState.initial.width + event.clientX - ocrPanelResizeState.start.x,
    OCR_PANEL_MIN_WIDTH,
    Math.max(OCR_PANEL_MIN_WIDTH, size.width - 16)
  )
  const height = clamp(
    ocrPanelResizeState.initial.height + event.clientY - ocrPanelResizeState.start.y,
    OCR_PANEL_MIN_HEIGHT,
    Math.max(OCR_PANEL_MIN_HEIGHT, size.height - 16)
  )
  ocrPanelUserSize = { width, height }
  layoutOcrPanel()
  event.preventDefault()
}

/**
 * 响应 OCR 侧栏调整手柄抬起，结束本次手动调整。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrPanelResizeEnd(): void {
  ocrPanelResizeState = null
}

/**
 * 用户开始绘制新选区时丢弃当前 OCR 识别结果框：
 * 旧识别针对旧选区，继续展示会造成"选区消失但识别框残留"的不一致；
 * 同时复位识别请求状态，防止旧请求晚到结果写入新一轮识别面板。
 * @returns 无返回值。
 * @author zhenghq
 */
function discardOcrPanelForNewSelection(): void {
  if (ocrPanelState === 'hidden') return
  renderOcrPanel('hidden')
  screenshotRecognizePending = false
  pendingScreenshotRequestId = null
  ocrRecognizeButton.disabled = false
}

/**
 * 渲染 OCR 结果侧栏：处理中、成功、空结果与错误状态。
 * @param state 侧栏状态。
 * @param text 展示的文本内容。
 * @param status 状态描述。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrPanel(state: 'hidden' | 'pending' | 'ready', text = '', status = ''): void {
  ocrPanelState = state
  if (state === 'hidden') {
    ocrPanel.hidden = true
    ocrPanelStatus.textContent = ''
    ocrPanelText.value = ''
    return
  }
  ocrPanel.hidden = false
  ocrPanelStatus.textContent = status
  ocrPanelText.value = text
  ocrPanelText.hidden = state === 'pending'
  layoutOcrPanel()
}

/**
 * 在截图窗口内展示工具条按钮的自定义悬停提示。
 * 截图窗口为透明无边框窗口，系统原生 title 提示绘制在窗口透明区域外会被裁剪，
 * 因此改为窗口内 tooltip 元素，跟随按钮位置并限制在可视范围内。
 * @param button 当前悬停或聚焦的工具条按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
function showOcrTooltip(button: HTMLButtonElement): void {
  if (button.disabled) return
  const label = button.getAttribute('aria-label') || button.title
  if (!label) return
  ocrTooltip.textContent = label
  ocrTooltip.hidden = false
  const size = getOverlaySize()
  const rect = button.getBoundingClientRect()
  const tipWidth = ocrTooltip.offsetWidth || 64
  const tipHeight = ocrTooltip.offsetHeight || 26
  const x = clamp(rect.left + rect.width / 2 - tipWidth / 2, 4, Math.max(4, size.width - tipWidth - 4))
  const aboveY = rect.top - tipHeight - 6
  const belowY = rect.bottom + 6
  const y = aboveY >= 4 ? aboveY : clamp(belowY, 4, Math.max(4, size.height - tipHeight - 4))
  ocrTooltip.style.left = `${Math.round(x)}px`
  ocrTooltip.style.top = `${Math.round(y)}px`
}

/**
 * 隐藏工具条按钮的自定义悬停提示。
 * @returns 无返回值。
 * @author zhenghq
 */
function hideOcrTooltip(): void {
  ocrTooltip.hidden = true
}

/**
 * 响应工具条按钮悬停或聚焦，展示对应按钮提示。
 * @param event 鼠标或焦点事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrTooltipHover(event: Event): void {
  const button = (event.target as HTMLElement).closest('#ocr-toolbar button') as HTMLButtonElement | null
  if (button) showOcrTooltip(button)
}

/**
 * 响应鼠标移出工具条按钮，隐藏按钮提示。
 * @param event 鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrTooltipLeave(event: MouseEvent): void {
  const from = (event.target as HTMLElement).closest('#ocr-toolbar button')
  const to = (event.relatedTarget as HTMLElement | null)?.closest?.('#ocr-toolbar button')
  if (from && from !== to) hideOcrTooltip()
}

/**
 * 生成截图动作请求负载，绑定当前选区矩形与唯一请求 ID。
 * @param action 动作类型。
 * @returns 请求负载；当前选区无效时返回 null。
 * @author zhenghq
 */
function buildScreenshotActionRequest(
  action: ScreenshotOcrActionRequest['action']
): ScreenshotOcrActionRequest | null {
  if (!ocrMode || !currentRect) return null
  if (currentRect.width < MIN_SELECTION_SIZE || currentRect.height < MIN_SELECTION_SIZE) return null
  screenshotRequestSeq += 1
  return {
    action,
    requestId: `screenshot-${Date.now()}-${screenshotRequestSeq}`,
    bounds: { ...currentRect }
  }
}

/**
 * 触发截图“文字识别”：保持截图窗口打开，在侧栏展示识别结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function recognizeCurrentOcrSelection(): void {
  if (screenshotRecognizePending) return
  const request = buildScreenshotActionRequest('recognize')
  if (!request) return
  screenshotRecognizePending = true
  pendingScreenshotRequestId = request.requestId
  ocrRecognizeButton.disabled = true
  renderOcrPanel('pending', '', '正在识别选区文字…')
  window.api.recognizeOcrSelection(request)
}

/**
 * 处理主进程回传的截图文字识别结果，仅响应当前请求。
 * @param result 识别结果事件负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrRecognizeResult(result: ScreenshotOcrRecognizeResult): void {
  if (result.requestId !== pendingScreenshotRequestId) return
  screenshotRecognizePending = false
  pendingScreenshotRequestId = null
  ocrRecognizeButton.disabled = false
  if (result.ok && result.text) {
    renderOcrPanel('ready', result.text, `识别完成${result.engine ? `（${result.engine}）` : ''}`)
  } else if (result.code === 'empty') {
    renderOcrPanel('ready', '', '未识别到文字')
  } else {
    renderOcrPanel('ready', '', result.error || '识别失败，请重试')
  }
}

/**
 * 触发截图“翻译”：沿用现有截图 OCR 翻译流程并关闭截图窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function translateCurrentOcrSelection(): void {
  const request = buildScreenshotActionRequest('translate')
  if (!request) return
  leaveOcrSelectionMode()
  window.api.translateOcrSelection(request)
}

/**
 * 触发截图“复制图片”：将当前选区图片写入系统剪贴板，成功后由主进程退出截图。
 * @returns 无返回值。
 * @author zhenghq
 */
function copyCurrentOcrSelectionImage(): void {
  const request = buildScreenshotActionRequest('copy-image')
  if (!request) return
  pendingScreenshotRequestId = request.requestId
  ocrCopyImageButton.disabled = true
  window.api.copyOcrSelectionImage(request)
}

/**
 * 触发截图“保存到本地”：弹出保存对话框，确认后写入 PNG，成功后由主进程退出截图。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveCurrentOcrSelectionImage(): void {
  const request = buildScreenshotActionRequest('save-image')
  if (!request) return
  pendingScreenshotRequestId = request.requestId
  ocrSaveImageButton.disabled = true
  window.api.saveOcrSelectionImage(request)
}

/**
 * 处理主进程回传的图片复制/保存动作反馈：
 * 恢复按钮状态、给出非阻塞提示，并在成功后延迟退出截图。
 * @param result 动作反馈事件负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrActionResult(result: ScreenshotOcrActionResult): void {
  if (result.requestId !== pendingScreenshotRequestId) return
  pendingScreenshotRequestId = null
  if (result.action === 'copy-image') {
    ocrCopyImageButton.disabled = false
    if (result.ok) {
      // 提示由主进程独立 toast 窗口展示，截图窗口仅负责自身淡出关闭。
      scheduleScreenshotAutoClose()
      return
    }
    // 复制失败：通过独立提示窗口展示错误，截图窗口保持打开。
    window.api.showScreenshotToast({ message: result.error || '复制图片失败', displayTimeMs: 3000 })
    return
  }
  ocrSaveImageButton.disabled = false
  if (result.canceled) return
  if (result.ok) {
    // 保存成功提示由主进程独立 toast 窗口展示。
    window.api.showScreenshotToast({ message: '已保存到本地' })
  } else {
    window.api.showScreenshotToast({ message: result.error || '保存图片失败', displayTimeMs: 3000 })
  }
  if (result.ok) scheduleScreenshotAutoClose()
}

/**
 * 复制/保存成功后延迟退出截图：先给覆盖窗口加淡出动画，
 * 动画结束后通过取消 IPC 让主进程隐藏窗口；toast 独立停留不受影响。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleScreenshotAutoClose(): void {
  ocrOverlay.classList.add('closing')
  window.setTimeout(() => {
    cancelOcrSelection()
  }, 260)
}

/**
 * 将当前选区渲染为覆盖层中的可视矩形。
 * @param rect 待渲染的选区。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSelectionRect(rect: OcrSelectionBounds | null): void {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    ocrSelectionBox.hidden = true
    currentRect = null
    updateResizeHandlePositions()
    renderOcrToolbar()
    return
  }
  currentRect = rect
  ocrSelectionBox.hidden = false
  ocrSelectionBox.style.left = `${rect.x}px`
  ocrSelectionBox.style.top = `${rect.y}px`
  ocrSelectionBox.style.width = `${rect.width}px`
  ocrSelectionBox.style.height = `${rect.height}px`
  updateResizeHandlePositions()
  renderOcrToolbar()
}

/**
 * 渲染 OCR 框选使用的屏幕快照。
 * @param payload 主进程传入的快照数据。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrSnapshot(payload: OcrSelectionStartPayload): void {
  ocrSnapshot.src = payload.imageDataUrl
}

/**
 * 进入 OCR 框选模式，隐藏普通翻译按钮并显示屏幕快照覆盖层。
 * @param payload 屏幕快照数据。
 * @returns 无返回值。
 * @author zhenghq
 */
function enterOcrSelectionMode(payload: OcrSelectionStartPayload): void {
  ocrMode = true
  dragState = null
  currentRect = null
  screenshotRecognizePending = false
  pendingScreenshotRequestId = null
  translateButton.hidden = true
  renderOcrSnapshot(payload)
  // 进入新会话时重置上次关闭动画与提示状态，避免残留。
  ocrOverlay.classList.remove('closing')
  ocrOverlay.hidden = false
  ocrRecognizeButton.disabled = false
  ocrCopyImageButton.disabled = false
  ocrSaveImageButton.disabled = false
  renderOcrPanel('hidden')
  hideOcrTooltip()
  ocrPanelUserSize = null
  ocrPanelResizeState = null
  ocrPanel.style.width = ''
  ocrPanel.style.height = ''
  renderSelectionRect(null)
}

/**
 * 退出 OCR 框选模式并恢复普通选区按钮状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function leaveOcrSelectionMode(): void {
  ocrMode = false
  dragState = null
  currentRect = null
  screenshotRecognizePending = false
  pendingScreenshotRequestId = null
  ocrOverlay.hidden = true
  ocrToolbar.hidden = true
  renderOcrPanel('hidden')
  ocrOverlay.classList.remove('closing')
  hideOcrTooltip()
  ocrPanelUserSize = null
  ocrPanelResizeState = null
  ocrPanel.style.width = ''
  ocrPanel.style.height = ''
  ocrSnapshot.removeAttribute('src')
  // OCR 使用独立窗口，退出时窗口随后会隐藏；不要恢复共用页面中的“译”按钮，避免关闭动画期间闪现。
  renderSelectionRect(null)
}

/**
 * 取消 OCR 框选并通知主进程关闭覆盖窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelOcrSelection(): void {
  // 不能因本地 ocrMode 已复位而提前返回：主进程收不到取消通知时，
  // 会把全局划词监听一直留在暂停状态，导致划词与双击都不再显示“译”按钮。
  leaveOcrSelectionMode()
  window.api.cancelOcrSelection()
}

/**
 * 提交当前 OCR 选区，点击识别后才开始主进程 OCR。
 * @returns 无返回值。
 * @author zhenghq
 */
function submitCurrentOcrSelection(): void {
  if (!ocrMode || !currentRect) return
  if (currentRect.width < MIN_SELECTION_SIZE || currentRect.height < MIN_SELECTION_SIZE) return
  // Enter/空格快捷键沿用既有翻译语义：提交当前选区进入现有 OCR 翻译流程。
  translateCurrentOcrSelection()
}

/**
 * 获取鼠标事件在窗口内的坐标。
 * @param event 鼠标事件。
 * @returns 当前坐标。
 * @author zhenghq
 */
function getEventPoint(event: MouseEvent): { x: number; y: number } {
  return {
    x: clamp(event.clientX, 0, getOverlaySize().width),
    y: clamp(event.clientY, 0, getOverlaySize().height)
  }
}

/**
 * 响应 OCR 覆盖层鼠标按下，启动新建、移动或缩放选区。
 * @param event 鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrMouseDown(event: MouseEvent): void {
  if (!ocrMode || event.button !== 0) return
  const target = event.target as HTMLElement
  if (target.closest('#ocr-toolbar')) return
  // 点击 OCR 结果侧栏时不得触发重新框选，
  // 否则用户选取/复制 OCR 原文会导致当前选区被清空。
  if (target.closest('#ocr-panel')) return
  const point = getEventPoint(event)
  const handle = target.dataset['handle'] as DragHandle | undefined
  if (handle && currentRect) {
    dragState = { type: 'resize', start: point, initial: currentRect, handle }
    event.preventDefault()
    return
  }
  if (currentRect && ocrSelectionBox.contains(target)) {
    dragState = { type: 'move', start: point, initial: currentRect }
    event.preventDefault()
    return
  }
  // 空白处按下时先不渲染新选区：单击（无拖动）应保留旧选区与识别结果框，
  // 只有拖出超过阈值的距离才真正开始绘制新选区。
  dragState = { type: 'draw', start: point, initial: { x: point.x, y: point.y, width: 0, height: 0 }, activated: false }
  event.preventDefault()
}

/**
 * 响应 OCR 覆盖层鼠标移动，更新选区预览。
 * @param event 鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrMouseMove(event: MouseEvent): void {
  if (!ocrMode || !dragState) return
  const point = getEventPoint(event)
  if (dragState.type === 'draw') {
    // 单击（未越过拖动阈值）不开始新框选，避免误清旧选区；
    // 一旦越过阈值真正开始绘制新选区，同步丢弃旧识别结果框。
    if (!dragState.activated) {
      const moved = Math.max(
        Math.abs(point.x - dragState.start.x),
        Math.abs(point.y - dragState.start.y)
      )
      if (moved < OCR_DRAW_THRESHOLD) return
      dragState.activated = true
      discardOcrPanelForNewSelection()
    }
    renderSelectionRect(buildSelectionRect(dragState.start, point))
  } else if (dragState.type === 'move') {
    renderSelectionRect(moveSelectionRect(dragState, point))
  } else {
    renderSelectionRect(resizeSelectionRect(dragState, point))
  }
  event.preventDefault()
}

/**
 * 响应 OCR 覆盖层鼠标抬起，结束当前调整动作但不自动提交识别。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrMouseUp(): void {
  if (!ocrMode || !dragState) return
  dragState = null
  renderOcrToolbar()
}

/**
 * 处理键盘取消操作。
 * @param event 键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') cancelOcrSelection()
  if ((event.key === 'Enter' || event.key === ' ') && ocrMode) submitCurrentOcrSelection()
}

translateButton.addEventListener('click', translateSelection)
ocrOverlay.addEventListener('mousedown', handleOcrMouseDown)
ocrOverlay.addEventListener('mousemove', handleOcrMouseMove)
ocrRecognizeButton.addEventListener('click', recognizeCurrentOcrSelection)
ocrTranslateButton.addEventListener('click', translateCurrentOcrSelection)
ocrCopyImageButton.addEventListener('click', copyCurrentOcrSelectionImage)
ocrSaveImageButton.addEventListener('click', saveCurrentOcrSelectionImage)
ocrCancelButton.addEventListener('click', cancelOcrSelection)
window.addEventListener('mouseup', handleOcrMouseUp)
window.addEventListener('keydown', handleKeyDown)
ocrOverlay.addEventListener('mouseover', handleOcrTooltipHover)
ocrOverlay.addEventListener('focusin', handleOcrTooltipHover)
ocrOverlay.addEventListener('mouseout', handleOcrTooltipLeave)
ocrOverlay.addEventListener('focusout', hideOcrTooltip)
ocrOverlay.addEventListener('mousedown', hideOcrTooltip)
ocrPanelResizeHandle.addEventListener('mousedown', handleOcrPanelResizeStart)
window.addEventListener('mousemove', handleOcrPanelResizeMove)
window.addEventListener('mouseup', handleOcrPanelResizeEnd)
window.addEventListener('resize', () => {
  if (currentRect) renderSelectionRect(clampRectToOverlay(currentRect))
  hideOcrTooltip()
  layoutOcrPanel()
})
window.api.onOcrSelectionStart(enterOcrSelectionMode)
window.api.onOcrRecognizeResult(handleOcrRecognizeResult)
window.api.onOcrActionResult(handleOcrActionResult)
