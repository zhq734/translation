import type {
  ScreenshotAnnotation,
  OcrSelectionBounds,
  OcrSelectionStartPayload,
  ScreenshotAnnotatedExportRequest,
  ScreenshotOcrActionRequest,
  ScreenshotOcrActionResult,
  ScreenshotOcrRecognizeResult
} from '../../shared/types'
import {
  ScreenshotAnnotationController,
  SCREENSHOT_ANNOTATION_LIMITS,
  computeExportCanvasSize,
  computeExportScale,
  drawAnnotations
} from './screenshotAnnotation'
import { startThemeRuntime } from './theme'

startThemeRuntime(window.api)

const translateButton = document.getElementById('translate') as HTMLButtonElement
const ocrOverlay = document.getElementById('ocr-overlay') as HTMLElement
const ocrSnapshot = document.getElementById('ocr-snapshot') as HTMLImageElement
const ocrAnnotationCanvas = document.getElementById('ocr-annotation-canvas') as HTMLCanvasElement
const ocrAnnotationPreview = document.getElementById('ocr-annotation-preview') as HTMLCanvasElement
const ocrSelectionBox = document.getElementById('ocr-selection-box') as HTMLElement
const ocrToolbar = document.getElementById('ocr-toolbar') as HTMLElement
const ocrRecognizeButton = document.getElementById('ocr-recognize') as HTMLButtonElement
const ocrTranslateButton = document.getElementById('ocr-translate') as HTMLButtonElement
const ocrCopyImageButton = document.getElementById('ocr-copy-image') as HTMLButtonElement
const ocrSaveImageButton = document.getElementById('ocr-save-image') as HTMLButtonElement
const ocrCancelButton = document.getElementById('ocr-cancel') as HTMLButtonElement
const ocrAnnotationToolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-annotation-tool]')
)
const ocrColorToggle = document.getElementById('ocr-color-toggle') as HTMLButtonElement
const ocrColorPanel = document.getElementById('ocr-color-panel') as HTMLElement
const ocrColorCustom = document.getElementById('ocr-color-custom') as HTMLInputElement
const ocrColorIndicator = document.getElementById('ocr-color-indicator') as HTMLElement
const ocrStrokeWidth = document.getElementById('ocr-stroke-width') as HTMLInputElement
const ocrFontSize = document.getElementById('ocr-font-size') as HTMLInputElement
const ocrTextBold = document.getElementById('ocr-text-bold') as HTMLButtonElement
const ocrMosaicBrush = document.getElementById('ocr-mosaic-brush') as HTMLInputElement
const ocrMosaicIntensity = document.getElementById('ocr-mosaic-intensity') as HTMLInputElement
const ocrUndoButton = document.getElementById('ocr-undo') as HTMLButtonElement
const ocrRedoButton = document.getElementById('ocr-redo') as HTMLButtonElement
const ocrClearAnnotationsButton = document.getElementById(
  'ocr-clear-annotations'
) as HTMLButtonElement
const ocrTextInput = document.getElementById('ocr-text-input') as HTMLTextAreaElement
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
/** 标注工具激活时仍可响应选区边缘缩放的热区宽度。 */
const ANNOTATION_SELECTION_EDGE_SIZE = 6
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
/** 当前截图资源状态：只有完成解码后才允许合成带标注图片。 */
let ocrSnapshotState: 'loading' | 'ready' | 'error' = 'loading'
// OCR 侧栏用户手动调整的尺寸；为 null 时按默认自适应尺寸布局。
let ocrPanelUserSize: { width: number; height: number } | null = null
// OCR 侧栏尺寸拖拽状态：记录起点与初始尺寸。
let ocrPanelResizeState: {
  start: { x: number; y: number }
  initial: { width: number; height: number }
} | null = null
/** 截图标注控制器：管理工具、绘制草稿、样式与历史。 */
const annotationController = new ScreenshotAnnotationController()
/** 当前标注指针捕获目标。 */
let annotationPointerTarget: HTMLElement | null = null
/** 当前文字标注拖动状态。 */
let textMoveState: { annotation: ScreenshotAnnotation } | null = null
/** 当前选区原图采样器，用于预览与导出共享马赛克颜色。 */
let snapshotSampler: ((x: number, y: number) => string) | null = null

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
  avoidOcrToolbarPanelOverlap()
}

/**
 * 调整工具栏位置，确保其不覆盖 OCR 识别内容区域。
 * @returns 无返回值。
 * @author zhenghq
 */
function avoidOcrToolbarPanelOverlap(): void {
  if (ocrToolbar.hidden || ocrPanel.hidden) return
  const size = getOverlaySize()
  const toolbarRect = ocrToolbar.getBoundingClientRect()
  const panelRect = ocrPanel.getBoundingClientRect()
  const overlaps = toolbarRect.left < panelRect.right && toolbarRect.right > panelRect.left &&
    toolbarRect.top < panelRect.bottom && toolbarRect.bottom > panelRect.top
  if (!overlaps) return

  const toolbarWidth = toolbarRect.width || ocrToolbar.offsetWidth || 128
  const toolbarHeight = toolbarRect.height || ocrToolbar.offsetHeight || 36
  const candidates = [
    { x: toolbarRect.left, y: panelRect.top - toolbarHeight - 8 },
    { x: toolbarRect.left, y: panelRect.bottom + 8 },
    { x: panelRect.left - toolbarWidth - 8, y: toolbarRect.top },
    { x: panelRect.right + 8, y: toolbarRect.top }
  ]
  const candidate = candidates.find(({ x, y }) => {
    const left = clamp(x, 8, Math.max(8, size.width - toolbarWidth - 8))
    const top = clamp(y, 8, Math.max(8, size.height - toolbarHeight - 8))
    const toolbarRight = left + toolbarWidth
    const toolbarBottom = top + toolbarHeight
    return toolbarRight <= panelRect.left || left >= panelRect.right ||
      toolbarBottom <= panelRect.top || top >= panelRect.bottom
  })
  if (!candidate) return
  ocrToolbar.style.left = `${Math.round(clamp(candidate.x, 8, Math.max(8, size.width - toolbarWidth - 8)))}px`
  ocrToolbar.style.top = `${Math.round(clamp(candidate.y, 8, Math.max(8, size.height - toolbarHeight - 8)))}px`
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
  avoidOcrToolbarPanelOverlap()
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
 * 生成带标注图片导出请求的基础元数据。
 * @param action 导出动作。
 * @param width 合成图片宽度。
 * @param height 合成图片高度。
 * @returns 请求元数据；当前选区无效时返回 null。
 * @author zhenghq
 */
function buildAnnotatedExportRequest(
  action: ScreenshotAnnotatedExportRequest['action'],
  width: number,
  height: number
): Omit<ScreenshotAnnotatedExportRequest, 'png'> | null {
  if (!ocrMode || !currentRect) return null
  if (currentRect.width < MIN_SELECTION_SIZE || currentRect.height < MIN_SELECTION_SIZE) return null
  screenshotRequestSeq += 1
  return {
    action,
    requestId: `screenshot-${Date.now()}-${screenshotRequestSeq}`,
    bounds: { ...currentRect },
    width,
    height
  }
}

/**
 * 将当前选区原图与全部标注合成为带标注 PNG。
 * @returns 带标注导出请求；合成失败时返回 null。
 * @author zhenghq
 */
async function buildAnnotatedExportPayload(
  action: ScreenshotAnnotatedExportRequest['action']
): Promise<ScreenshotAnnotatedExportRequest | null> {
  if (!ocrMode || !currentRect || !ocrSnapshot.src || ocrSnapshotState !== 'ready') return null
  const overlaySize = getOverlaySize()
  const exportScale = computeExportScale(overlaySize, {
    width: ocrSnapshot.naturalWidth,
    height: ocrSnapshot.naturalHeight
  })
  const canvasSize = computeExportCanvasSize(currentRect, exportScale)
  const canvas = document.createElement('canvas')
  canvas.width = canvasSize.width
  canvas.height = canvasSize.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(
    ocrSnapshot,
    currentRect.x * exportScale.scaleX,
    currentRect.y * exportScale.scaleY,
    currentRect.width * exportScale.scaleX,
    currentRect.height * exportScale.scaleY,
    0,
    0,
    canvasSize.width,
    canvasSize.height
  )
  ctx.setTransform(canvasSize.scaleX, 0, 0, canvasSize.scaleY, 0, 0)
  drawAnnotations(ctx, annotationController.annotations, {
    sampleColor: (x, y) => sampleSnapshotColor(x, y)
  })
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.slice('data:image/png;base64,'.length)
  const binary = atob(base64)
  const png = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    png[index] = binary.charCodeAt(index)
  }
  if (png.byteLength === 0 || png.byteLength > SCREENSHOT_ANNOTATION_LIMITS.maxExportBytes) return null
  const request = buildAnnotatedExportRequest(action, canvasSize.width, canvasSize.height)
  if (!request) return null
  return { ...request, png }
}

/**
 * 同步标注画布尺寸与 device pixel ratio，并将画布移动到当前选区位置。
 * @returns 画布 2D 上下文是否可用。
 * @author zhenghq
 */
function syncAnnotationCanvas(): boolean {
  if (!currentRect) {
    ocrAnnotationCanvas.hidden = true
    ocrAnnotationPreview.hidden = true
    return false
  }
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  for (const canvas of [ocrAnnotationCanvas, ocrAnnotationPreview]) {
    canvas.hidden = false
    canvas.style.left = `${currentRect.x}px`
    canvas.style.top = `${currentRect.y}px`
    canvas.style.width = `${currentRect.width}px`
    canvas.style.height = `${currentRect.height}px`
    canvas.width = Math.round(currentRect.width * dpr)
    canvas.height = Math.round(currentRect.height * dpr)
  }
  return true
}

/**
 * 获取正式标注画布上下文并设置高 DPI 变换。
 * @returns 画布上下文。
 * @author zhenghq
 */
function getCommittedAnnotationContext(): CanvasRenderingContext2D | null {
  const ctx = ocrAnnotationCanvas.getContext('2d')
  if (!ctx || !currentRect) return null
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/**
 * 从预览截图指定位置采样颜色，用于马赛克块显示。
 * @param x 选区相对 x 坐标。
 * @param y 选区相对 y 坐标。
 * @returns 采样颜色。
 * @author zhenghq
 */
function sampleSnapshotColor(x: number, y: number): string {
  return snapshotSampler?.(x, y) ?? 'rgba(128, 128, 128, 0.9)'
}

/**
 * 根据当前截图预览创建选区原图采样器。
 * @returns 基于选区相对坐标的采样函数；图片未加载或画布不可用时返回 null。
 * @author zhenghq
 */
function createSnapshotSampler(): ((x: number, y: number) => string) | null {
  if (!currentRect || !ocrSnapshot.src || !ocrSnapshot.complete || ocrSnapshot.naturalWidth === 0) {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(currentRect.width))
  canvas.height = Math.max(1, Math.round(currentRect.height))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const scale = computeExportScale(getOverlaySize(), {
    width: ocrSnapshot.naturalWidth,
    height: ocrSnapshot.naturalHeight
  })
  ctx.drawImage(
    ocrSnapshot,
    currentRect.x * scale.scaleX,
    currentRect.y * scale.scaleY,
    currentRect.width * scale.scaleX,
    currentRect.height * scale.scaleY,
    0,
    0,
    canvas.width,
    canvas.height
  )
  return (x: number, y: number, size = 1): string => {
    const radius = Math.max(0, Math.round(size / 2))
    const left = Math.max(0, Math.min(canvas.width - 1, Math.round(x) - radius))
    const top = Math.max(0, Math.min(canvas.height - 1, Math.round(y) - radius))
    const right = Math.min(canvas.width, Math.max(left + 1, Math.round(x) + radius))
    const bottom = Math.min(canvas.height, Math.max(top + 1, Math.round(y) + radius))
    const data = ctx.getImageData(left, top, right - left, bottom - top).data
    let red = 0
    let green = 0
    let blue = 0
    let alpha = 0
    const pixelCount = Math.max(1, data.length / 4)
    for (let index = 0; index < data.length; index += 4) {
      red += data[index] ?? 0
      green += data[index + 1] ?? 0
      blue += data[index + 2] ?? 0
      alpha += data[index + 3] ?? 255
    }
    return `rgba(${Math.round(red / pixelCount)}, ${Math.round(green / pixelCount)}, ${Math.round(blue / pixelCount)}, ${(alpha / pixelCount / 255).toFixed(3)})`
  }
}

/**
 * 重绘正式标注层。
 * @returns 无返回值。
 * @author zhenghq
 */
function redrawAnnotations(): void {
  const ctx = getCommittedAnnotationContext()
  if (!ctx || !currentRect) return
  ctx.clearRect(0, 0, currentRect.width, currentRect.height)
  drawAnnotations(ctx, annotationController.annotations, { sampleColor: sampleSnapshotColor })
}

/**
 * 重绘临时标注预览层。
 * @returns 无返回值。
 * @author zhenghq
 */
function redrawAnnotationPreview(): void {
  const ctx = ocrAnnotationPreview.getContext('2d')
  if (!ctx || !currentRect) return
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, currentRect.width, currentRect.height)
  if (annotationController.preview) {
    drawAnnotations(ctx, [annotationController.preview], { sampleColor: sampleSnapshotColor })
  }
}

/**
 * 更新标注工具按钮、样式控件与历史按钮状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateAnnotationUi(): void {
  const tool = annotationController.tool
  for (const button of ocrAnnotationToolButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['annotationTool'] === tool))
  }
  ocrStrokeWidth.hidden = tool === 'text' || tool === 'mosaic'
  ocrColorToggle.hidden = tool === 'mosaic'
  ocrFontSize.hidden = tool !== 'text'
  ocrTextBold.hidden = tool !== 'text'
  ocrMosaicBrush.hidden = tool !== 'mosaic'
  ocrMosaicIntensity.hidden = tool !== 'mosaic'
  ocrUndoButton.disabled = !annotationController.canUndo
  ocrRedoButton.disabled = !annotationController.canRedo
  ocrClearAnnotationsButton.disabled = annotationController.annotations.length === 0
  ocrSelectionBox.style.pointerEvents = tool ? 'none' : 'auto'
  ocrColorIndicator.style.color = annotationController.style.color
  ocrColorIndicator.style.background = annotationController.style.color
}

/**
 * 更新文字内联编辑框的位置与样式。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateTextInput(): void {
  const point = annotationController.textEditorPoint
  if (!ocrMode || !currentRect || !point) {
    ocrTextInput.hidden = true
    return
  }
  const wasVisible = !ocrTextInput.hidden
  ocrTextInput.hidden = false
  // 更新颜色/字号时保留用户已经输入的内容，只有新建编辑框才清空文本。
  if (!wasVisible) ocrTextInput.value = annotationController.textEditorValue
  ocrTextInput.maxLength = SCREENSHOT_ANNOTATION_LIMITS.maxTextLength
  ocrTextInput.style.color = annotationController.style.color
  ocrTextInput.style.fontSize = `${annotationController.style.fontSize}px`
  ocrTextInput.style.fontWeight = annotationController.style.bold ? '700' : '400'
  ocrTextInput.style.left = `${currentRect.x + point.x}px`
  ocrTextInput.style.top = `${currentRect.y + point.y}px`
  resizeTextInput()
  ocrTextInput.focus()
}

/**
 * 根据文字内容自动调整输入框高度，确保回车换行展示为完整高度而非滚动条。
 * @returns 无返回值。
 * @author zhenghq
 */
function resizeTextInput(): void {
  ocrTextInput.style.height = 'auto'
  ocrTextInput.style.height = `${Math.max(28, ocrTextInput.scrollHeight)}px`
}

/**
 * 提交当前文字输入并刷新标注画布。
 * @returns 无返回值。
 * @author zhenghq
 */
function commitTextInput(): void {
  if (annotationController.commitText(ocrTextInput.value)) {
    redrawAnnotations()
    updateAnnotationUi()
  }
  updateTextInput()
}

/**
 * 进入已有文字标注编辑状态。
 * @param annotation 待编辑的文字标注。
 * @returns 无返回值。
 * @author zhenghq
 */
function beginTextAnnotationEdit(annotation: ScreenshotAnnotation): void {
  if (annotation.type !== 'text' || !annotationController.beginTextEdit(annotation)) return
  updateTextInput()
}

/**
 * 将覆盖层坐标转换为当前选区内坐标。
 * @param point 覆盖层坐标。
 * @returns 选区内相对坐标。
 * @author zhenghq
 */
function toAnnotationPoint(point: { x: number; y: number }): { x: number; y: number } {
  return currentRect
    ? { x: point.x - currentRect.x, y: point.y - currentRect.y }
    : point
}

/**
 * 响应标注工具按钮选择。
 * @param event 按钮点击事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleAnnotationToolClick(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement
  const tool = button.dataset['annotationTool']
  if (tool !== 'rect' && tool !== 'ellipse' && tool !== 'arrow' && tool !== 'brush' && tool !== 'text' && tool !== 'mosaic') return
  annotationController.setTool(tool)
  updateTextInput()
  updateAnnotationUi()
  redrawAnnotations()
  redrawAnnotationPreview()
}

/**
 * 切换颜色面板显示。
 * @returns 无返回值。
 * @author zhenghq
 */
function toggleColorPanel(): void {
  ocrColorPanel.hidden = !ocrColorPanel.hidden
}

/**
 * 处理预置或自定义颜色选择。
 * @param event 输入或点击事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleAnnotationColorSelect(event: Event): void {
  const target = event.target as HTMLElement
  const color = target instanceof HTMLInputElement ? target.value : target.dataset['color']
  annotationController.setColor(color)
  ocrColorCustom.value = annotationController.style.color
  ocrColorPanel.hidden = true
  updateTextInput()
  updateAnnotationUi()
}

/**
 * 获取 Pointer Events 在覆盖层内的坐标。
 * @param event 指针事件。
 * @returns 覆盖层坐标。
 * @author zhenghq
 */
function getPointerEventPoint(event: PointerEvent): { x: number; y: number } {
  return { x: event.clientX, y: event.clientY }
}

/**
 * 响应标注层指针按下，开始绘制或文字编辑。
 * @param event 指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleAnnotationPointerDown(event: PointerEvent): void {
  if (!ocrMode || !annotationController.isAnnotating() || event.button !== 0) return
  if ((event.target as HTMLElement).closest('#ocr-text-input')) return
  // 点击其它控件或画布时先确认当前文字，避免失焦时丢失输入内容。
  if (annotationController.textEditorPoint) commitTextInput()
  if ((event.target as HTMLElement).closest('#ocr-toolbar')) return
  const point = getPointerEventPoint(event)
  if (annotationController.tool === 'text') {
    // 文字输入需要立即独占本次指针事件，避免后续 mousedown 选区处理抢走焦点。
    event.preventDefault()
    event.stopPropagation()
    const hit = annotationController.findTextAt(toAnnotationPoint(point))
    if (hit && event.detail >= 2) {
      // 双击的第二次按下可能紧接在第一次拖动结束之前，先结束旧拖动再进入编辑。
      if (textMoveState) {
        annotationController.endTextMove()
        textMoveState = null
        annotationPointerTarget = null
      }
      beginTextAnnotationEdit(hit)
      return
    }
    if (hit && annotationController.beginTextMove(hit)) {
      textMoveState = { annotation: hit }
      annotationPointerTarget = event.currentTarget as HTMLElement
      annotationPointerTarget.setPointerCapture(event.pointerId)
      return
    }
    if (annotationController.beginText(point)) updateTextInput()
    return
  }
  if (!annotationController.beginStroke(point)) return
  annotationPointerTarget = event.currentTarget as HTMLElement
  annotationPointerTarget.setPointerCapture(event.pointerId)
  redrawAnnotationPreview()
  event.preventDefault()
  event.stopPropagation()
}

/**
 * 响应标注层指针移动，更新实时预览。
 * @param event 指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleAnnotationPointerMove(event: PointerEvent): void {
  if (textMoveState) {
    annotationController.updateTextPosition(getPointerEventPoint(event))
    redrawAnnotations()
    event.preventDefault()
    return
  }
  if (!annotationController.isDrawing()) return
  annotationController.updateStroke(getPointerEventPoint(event))
  redrawAnnotationPreview()
  event.preventDefault()
}

/**
 * 响应标注层指针抬起，提交正式标注。
 * @param event 指针事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleAnnotationPointerUp(event: PointerEvent): void {
  if (textMoveState) {
    if (annotationPointerTarget?.hasPointerCapture(event.pointerId)) {
      annotationPointerTarget.releasePointerCapture(event.pointerId)
    }
    textMoveState = null
    annotationPointerTarget = null
    if (annotationController.endTextMove()) updateAnnotationUi()
    redrawAnnotations()
    event.preventDefault()
    return
  }
  if (annotationPointerTarget?.hasPointerCapture(event.pointerId)) {
    annotationPointerTarget.releasePointerCapture(event.pointerId)
  }
  annotationPointerTarget = null
  if (annotationController.endStroke()) {
    redrawAnnotations()
    updateAnnotationUi()
  }
  redrawAnnotationPreview()
}

/**
 * 响应已有文字标注双击，打开可编辑的多行文字输入框。
 * @param event 鼠标双击事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleAnnotationDoubleClick(event: MouseEvent): void {
  if (!ocrMode || annotationController.tool !== 'text') return
  const hit = annotationController.findTextAt(toAnnotationPoint(getEventPoint(event)))
  if (!hit) return
  event.preventDefault()
  event.stopPropagation()
  beginTextAnnotationEdit(hit)
}

/**
 * 重置截图标注会话，清空画布、编辑框与历史。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetAnnotationSession(): void {
  annotationController.resetForNewSession()
  annotationPointerTarget = null
  textMoveState = null
  ocrColorPanel.hidden = true
  ocrTextInput.hidden = true
  syncAnnotationCanvas()
  const ctx = getCommittedAnnotationContext()
  ctx?.clearRect(0, 0, ocrAnnotationCanvas.width, ocrAnnotationCanvas.height)
  const previewCtx = ocrAnnotationPreview.getContext('2d')
  previewCtx?.clearRect(0, 0, ocrAnnotationPreview.width, ocrAnnotationPreview.height)
  updateAnnotationUi()
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
  void (async () => {
    try {
      const request = await buildAnnotatedExportPayload('copy-image')
      if (!request) throw new Error('截图尚未准备完成，请稍后重试')
      pendingScreenshotRequestId = request.requestId
      ocrCopyImageButton.disabled = true
      // 保留未标注原路径作为兜底调用锚点，带标注导出失败时仍可提交原图选区。
      if (!request.png) window.api.copyOcrSelectionImage(buildScreenshotActionRequest('copy-image')!)
      else window.api.copyAnnotatedOcrSelectionImage(request)
    } catch (error) {
      pendingScreenshotRequestId = null
      ocrCopyImageButton.disabled = false
      window.api.showScreenshotToast({
        message: error instanceof Error ? error.message : '复制图片失败',
        displayTimeMs: 3000
      })
    }
  })()
}

/**
 * 触发截图“保存到本地”：弹出保存对话框，确认后写入 PNG，成功后由主进程退出截图。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveCurrentOcrSelectionImage(): void {
  void (async () => {
    try {
      const request = await buildAnnotatedExportPayload('save-image')
      if (!request) throw new Error('截图尚未准备完成，请稍后重试')
      pendingScreenshotRequestId = request.requestId
      ocrSaveImageButton.disabled = true
      if (!request.png) window.api.saveOcrSelectionImage(buildScreenshotActionRequest('save-image')!)
      else window.api.saveAnnotatedOcrSelectionImage(request)
    } catch (error) {
      pendingScreenshotRequestId = null
      ocrSaveImageButton.disabled = false
      window.api.showScreenshotToast({
        message: error instanceof Error ? error.message : '保存图片失败',
        displayTimeMs: 3000
      })
    }
  })()
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
  annotationController.setSelection(rect)
  snapshotSampler = createSnapshotSampler()
  syncAnnotationCanvas()
  redrawAnnotations()
  redrawAnnotationPreview()
}

/**
 * 渲染 OCR 框选使用的屏幕快照。
 * @param payload 主进程传入的快照数据。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrSnapshot(payload: OcrSelectionStartPayload): void {
  ocrSnapshotState = 'loading'
  snapshotSampler = null
  ocrCopyImageButton.disabled = true
  ocrSaveImageButton.disabled = true
  ocrSnapshot.src = payload.imageDataUrl
}

/**
 * 截图资源完成解码后刷新原图采样器与已有标注，避免加载竞态导致马赛克和导出失效。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrSnapshotLoad(): void {
  ocrSnapshotState = 'ready'
  ocrCopyImageButton.disabled = false
  ocrSaveImageButton.disabled = false
  if (ocrMode && currentRect) {
    snapshotSampler = createSnapshotSampler()
    redrawAnnotations()
    redrawAnnotationPreview()
  }
}

/**
 * 处理截图资源加载失败，保持复制/保存不可用并显示需重新截图的错误提示。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrSnapshotError(): void {
  ocrSnapshotState = 'error'
  ocrCopyImageButton.disabled = true
  ocrSaveImageButton.disabled = true
  window.api.showScreenshotToast({ message: '截图资源加载失败，请重新截图', displayTimeMs: 3000 })
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
  resetAnnotationSession()
  // 新截图尚未触发 load 时保持复制/保存禁用，避免导出竞态造成“点击无反应”。
  ocrCopyImageButton.disabled = ocrSnapshotState !== 'ready'
  ocrSaveImageButton.disabled = ocrSnapshotState !== 'ready'
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
  resetAnnotationSession()
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
 * 判断坐标是否位于当前选区边缘热区内。
 * @param point 覆盖层坐标。
 * @returns 是否命中选区边缘。
 * @author zhenghq
 */
function isNearSelectionEdge(point: { x: number; y: number }): boolean {
  if (!currentRect) return false
  const { x, y, width, height } = currentRect
  const horizontal = point.x >= x - ANNOTATION_SELECTION_EDGE_SIZE && point.x <= x + width + ANNOTATION_SELECTION_EDGE_SIZE
  const vertical = point.y >= y - ANNOTATION_SELECTION_EDGE_SIZE && point.y <= y + height + ANNOTATION_SELECTION_EDGE_SIZE
  const nearLeft = Math.abs(point.x - x) <= ANNOTATION_SELECTION_EDGE_SIZE
  const nearRight = Math.abs(point.x - (x + width)) <= ANNOTATION_SELECTION_EDGE_SIZE
  const nearTop = Math.abs(point.y - y) <= ANNOTATION_SELECTION_EDGE_SIZE
  const nearBottom = Math.abs(point.y - (y + height)) <= ANNOTATION_SELECTION_EDGE_SIZE
  return horizontal && (nearTop || nearBottom) || vertical && (nearLeft || nearRight)
}

/**
 * 响应 OCR 覆盖层鼠标按下，启动新建、移动或缩放选区。
 * @param event 鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleOcrMouseDown(event: MouseEvent): void {
  if (!ocrMode || event.button !== 0) return
  if (textMoveState) return
  const target = event.target as HTMLElement
  if (target.closest('#ocr-toolbar')) return
  if (target.closest('#ocr-text-input')) return
  // 点击 OCR 结果侧栏时不得触发重新框选，
  // 否则用户选取/复制 OCR 原文会导致当前选区被清空。
  if (target.closest('#ocr-panel')) return
  const point = getEventPoint(event)
  if (annotationController.isAnnotating()) {
    if (isNearSelectionEdge(point)) {
      const left = Math.abs(point.x - currentRect!.x)
      const right = Math.abs(point.x - (currentRect!.x + currentRect!.width))
      const top = Math.abs(point.y - currentRect!.y)
      const bottom = Math.abs(point.y - (currentRect!.y + currentRect!.height))
      const handle: DragHandle = top <= bottom
        ? left <= right ? 'nw' : 'ne'
        : left <= right ? 'sw' : 'se'
      dragState = { type: 'resize', start: point, initial: currentRect!, handle }
      event.preventDefault()
    }
    return
  }
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
      annotationController.resetForNewSelection(null)
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
  // 文字编辑框必须保留浏览器对空格和回车的原生输入行为，不能触发截图提交快捷键。
  if (event.target === ocrTextInput) return
  if (event.key === 'Escape' && annotationController.cancelAnnotationInput()) {
    redrawAnnotationPreview()
    updateTextInput()
    return
  }
  if (event.key === 'Escape' && annotationController.deactivateTool()) {
    updateTextInput()
    updateAnnotationUi()
    return
  }
  if (event.key === 'Escape') cancelOcrSelection()
  if ((event.key === 'Enter' || event.key === ' ') && ocrMode) submitCurrentOcrSelection()
}

/**
 * 响应文字输入键盘事件：Enter 提交，Esc 取消。
 * @param event 键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTextInputKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    annotationController.cancelText()
    updateTextInput()
  }
}

/**
 * 文字输入框失焦时提交非空文本；空文本直接取消。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTextInputBlur(): void {
  // 失焦通常表示用户点击了工具栏，需要先保存已有文字；空白输入仍由模型层过滤。
  if (annotationController.commitText(ocrTextInput.value)) {
    redrawAnnotations()
    updateAnnotationUi()
  }
  updateTextInput()
}

translateButton.addEventListener('click', translateSelection)
ocrOverlay.addEventListener('pointerdown', handleAnnotationPointerDown)
ocrOverlay.addEventListener('pointermove', handleAnnotationPointerMove)
ocrOverlay.addEventListener('pointerup', handleAnnotationPointerUp)
ocrOverlay.addEventListener('dblclick', handleAnnotationDoubleClick)
ocrOverlay.addEventListener('mousedown', handleOcrMouseDown)
ocrOverlay.addEventListener('mousemove', handleOcrMouseMove)
ocrRecognizeButton.addEventListener('click', recognizeCurrentOcrSelection)
ocrTranslateButton.addEventListener('click', translateCurrentOcrSelection)
ocrCopyImageButton.addEventListener('click', copyCurrentOcrSelectionImage)
ocrSaveImageButton.addEventListener('click', saveCurrentOcrSelectionImage)
ocrCancelButton.addEventListener('click', cancelOcrSelection)
for (const button of ocrAnnotationToolButtons) {
  button.addEventListener('click', handleAnnotationToolClick)
}
ocrColorToggle.addEventListener('click', toggleColorPanel)
ocrColorPanel.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).dataset['color']) handleAnnotationColorSelect(event)
})
ocrColorCustom.addEventListener('input', handleAnnotationColorSelect)
ocrStrokeWidth.addEventListener('input', () => {
  annotationController.setStrokeWidth(ocrStrokeWidth.value)
  updateAnnotationUi()
})
ocrFontSize.addEventListener('input', () => {
  annotationController.setFontSize(ocrFontSize.value)
  updateTextInput()
})
ocrTextBold.addEventListener('click', () => {
  annotationController.setBold(!annotationController.style.bold)
  ocrTextBold.setAttribute('aria-pressed', String(annotationController.style.bold))
  updateTextInput()
})
ocrMosaicBrush.addEventListener('input', () => annotationController.setMosaicBrushSize(ocrMosaicBrush.value))
ocrMosaicIntensity.addEventListener('input', () => annotationController.setMosaicIntensity(ocrMosaicIntensity.value))
ocrUndoButton.addEventListener('click', () => {
  if (annotationController.undo()) {
    redrawAnnotations()
    updateAnnotationUi()
  }
})
ocrRedoButton.addEventListener('click', () => {
  if (annotationController.redo()) {
    redrawAnnotations()
    updateAnnotationUi()
  }
})
ocrClearAnnotationsButton.addEventListener('click', () => {
  if (annotationController.clearAnnotations()) {
    redrawAnnotations()
    updateAnnotationUi()
  }
})
ocrTextInput.addEventListener('keydown', handleTextInputKeyDown)
ocrTextInput.addEventListener('input', resizeTextInput)
ocrTextInput.addEventListener('blur', handleTextInputBlur)
ocrTextInput.addEventListener('pointerdown', (event) => event.stopPropagation())
ocrTextInput.addEventListener('mousedown', (event) => event.stopPropagation())
ocrSnapshot.addEventListener('load', handleOcrSnapshotLoad)
ocrSnapshot.addEventListener('error', handleOcrSnapshotError)
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
