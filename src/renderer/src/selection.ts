import type { OcrSelectionBounds, OcrSelectionStartPayload } from '../../shared/types'

const translateButton = document.getElementById('translate') as HTMLButtonElement
const ocrOverlay = document.getElementById('ocr-overlay') as HTMLElement
const ocrSnapshot = document.getElementById('ocr-snapshot') as HTMLImageElement
const ocrSelectionBox = document.getElementById('ocr-selection-box') as HTMLElement
const ocrToolbar = document.getElementById('ocr-toolbar') as HTMLElement
const ocrRecognizeButton = document.getElementById('ocr-recognize') as HTMLButtonElement
const ocrCancelButton = document.getElementById('ocr-cancel') as HTMLButtonElement
const ocrResizeHandles = Array.from(
  document.querySelectorAll<HTMLElement>('.ocr-resize-handle')
)

const MIN_SELECTION_SIZE = 8
type DragHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
type DragState = {
  type: 'draw' | 'move' | 'resize'
  start: { x: number; y: number }
  initial: OcrSelectionBounds
  handle?: DragHandle
}

let ocrMode = false
let dragState: DragState | null = null
let currentRect: OcrSelectionBounds | null = null

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
  translateButton.hidden = true
  renderOcrSnapshot(payload)
  ocrOverlay.hidden = false
  ocrRecognizeButton.disabled = false
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
  ocrOverlay.hidden = true
  ocrToolbar.hidden = true
  ocrSnapshot.removeAttribute('src')
  translateButton.hidden = false
  renderSelectionRect(null)
}

/**
 * 取消 OCR 框选并通知主进程关闭覆盖窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelOcrSelection(): void {
  if (!ocrMode) return
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
  const bounds = { ...currentRect }
  ocrRecognizeButton.disabled = true
  leaveOcrSelectionMode()
  window.api.submitOcrSelection(bounds)
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
  dragState = { type: 'draw', start: point, initial: { x: point.x, y: point.y, width: 0, height: 0 } }
  renderSelectionRect(buildSelectionRect(point, point))
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
ocrRecognizeButton.addEventListener('click', submitCurrentOcrSelection)
ocrCancelButton.addEventListener('click', cancelOcrSelection)
window.addEventListener('mouseup', handleOcrMouseUp)
window.addEventListener('keydown', handleKeyDown)
window.addEventListener('resize', () => {
  if (currentRect) renderSelectionRect(clampRectToOverlay(currentRect))
})
window.api.onOcrSelectionStart(enterOcrSelectionMode)
