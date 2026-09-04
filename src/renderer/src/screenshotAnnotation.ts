import type {
  OcrSelectionBounds,
  ScreenshotAnnotation,
  ScreenshotAnnotationPoint,
  ScreenshotAnnotationRect,
  ScreenshotAnnotationStyle,
  ScreenshotAnnotationTool,
  ScreenshotArrowAnnotation,
  ScreenshotBrushAnnotation,
  ScreenshotMosaicAnnotation,
  ScreenshotShapeAnnotation,
  ScreenshotTextAnnotation
} from '../../shared/types'

/** 数值范围定义，统一描述最小值、最大值与默认值。 */
interface NumericRange {
  min: number
  max: number
  default: number
}

/** 截图标注数量、文本、笔迹点数与导出尺寸限制。 */
export const SCREENSHOT_ANNOTATION_LIMITS = {
  /** 单张截图允许保留的最大标注数量。 */
  maxAnnotations: 200,
  /** 单条画笔/马赛克笔迹允许保留的最大点数。 */
  maxBrushPoints: 800,
  /** 单条文字标注允许的最大字符数。 */
  maxTextLength: 200,
  /** 导出画布允许的最大像素数。 */
  maxExportPixels: 16_000_000,
  /** 导出 PNG 允许的最大字节数。 */
  maxExportBytes: 24 * 1024 * 1024,
  /** 形状与画笔线宽范围。 */
  strokeWidth: { min: 1, max: 16, default: 3 },
  /** 文字字号范围。 */
  fontSize: { min: 12, max: 48, default: 18 },
  /** 马赛克笔刷直径范围。 */
  mosaicBrushSize: { min: 12, max: 80, default: 28 },
  /** 马赛克像素块边长范围。 */
  mosaicBlockSize: { min: 4, max: 32, default: 10 }
} as const satisfies Record<string, number | NumericRange>

/** 截图标注预置颜色，保证默认颜色可用且全部为合法十六进制值。 */
export const SCREENSHOT_ANNOTATION_PRESET_COLORS = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#0a84ff',
  '#5e5ce6',
  '#ffffff',
  '#000000'
] as const

/** 截图标注默认样式。 */
export const DEFAULT_SCREENSHOT_ANNOTATION_STYLE: ScreenshotAnnotationStyle = {
  color: SCREENSHOT_ANNOTATION_PRESET_COLORS[0],
  strokeWidth: SCREENSHOT_ANNOTATION_LIMITS.strokeWidth.default,
  fontSize: SCREENSHOT_ANNOTATION_LIMITS.fontSize.default,
  bold: false,
  mosaicBrushSize: SCREENSHOT_ANNOTATION_LIMITS.mosaicBrushSize.default,
  mosaicBlockSize: SCREENSHOT_ANNOTATION_LIMITS.mosaicBlockSize.default
}

/** 判断两个标注点之间的最小距离，用于过滤空操作与抽稀。 */
const MIN_POINT_DISTANCE = 2

/**
 * 判断未知值是否为受支持的截图标注工具。
 * @param value 待校验的值。
 * @returns 是否为合法标注工具。
 * @author zhenghq
 */
export function isScreenshotAnnotationTool(value: unknown): value is ScreenshotAnnotationTool {
  return (
    value === 'rect' ||
    value === 'ellipse' ||
    value === 'arrow' ||
    value === 'brush' ||
    value === 'text' ||
    value === 'mosaic'
  )
}

/**
 * 将颜色归一化为小写十六进制颜色；非法输入回退默认颜色。
 * @param value 待归一化的颜色值。
 * @returns 小写十六进制颜色。
 * @author zhenghq
 */
export function normalizeAnnotationColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SCREENSHOT_ANNOTATION_STYLE.color
  const trimmed = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/u.test(trimmed)) return trimmed
  if (/^#[0-9a-f]{3}$/u.test(trimmed)) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return DEFAULT_SCREENSHOT_ANNOTATION_STYLE.color
}

/**
 * 按指定范围归一化数值，非法输入回退默认值，结果始终为整数。
 * @param value 待归一化的值。
 * @param range 数值范围。
 * @returns 归一化后的整数。
 * @author zhenghq
 */
function normalizeNumericValue(value: unknown, range: NumericRange): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return range.default
  return Math.round(Math.min(range.max, Math.max(range.min, numeric)))
}

/**
 * 归一化形状与画笔线宽。
 * @param value 待归一化的线宽。
 * @returns 合法线宽。
 * @author zhenghq
 */
export function normalizeStrokeWidth(value: unknown): number {
  return normalizeNumericValue(value, SCREENSHOT_ANNOTATION_LIMITS.strokeWidth)
}

/**
 * 归一化文字标注字号。
 * @param value 待归一化的字号。
 * @returns 合法字号。
 * @author zhenghq
 */
export function normalizeFontSize(value: unknown): number {
  return normalizeNumericValue(value, SCREENSHOT_ANNOTATION_LIMITS.fontSize)
}

/**
 * 归一化马赛克笔刷直径。
 * @param value 待归一化的笔刷直径。
 * @returns 合法笔刷直径。
 * @author zhenghq
 */
export function normalizeMosaicBrushSize(value: unknown): number {
  return normalizeNumericValue(value, SCREENSHOT_ANNOTATION_LIMITS.mosaicBrushSize)
}

/**
 * 归一化马赛克像素块边长。
 * @param value 待归一化的像素块边长。
 * @returns 合法像素块边长。
 * @author zhenghq
 */
export function normalizeMosaicBlockSize(value: unknown): number {
  if (value === 'weak') return 6
  if (value === 'strong') return 16
  return normalizeNumericValue(value, SCREENSHOT_ANNOTATION_LIMITS.mosaicBlockSize)
}

/**
 * 将用户可感知的马赛克强度档位映射为像素块大小。
 * @param value 强度档位：weak / medium / strong，或直接数字。
 * @returns 有限范围内的像素块边长。
 * @author zhenghq
 */
export function normalizeMosaicIntensity(value: unknown): number {
  if (value === '1' || value === 1) return 6
  if (value === '2' || value === 2) return 10
  if (value === '3' || value === 3) return 16
  return normalizeMosaicBlockSize(value)
}

/**
 * 归一化标注样式对象，补齐缺失字段并限制所有样式值在合法范围内。
 * @param value 待归一化的样式对象。
 * @returns 完整且安全的样式对象。
 * @author zhenghq
 */
export function normalizeAnnotationStyle(value: unknown): ScreenshotAnnotationStyle {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ScreenshotAnnotationStyle>
  return {
    color: normalizeAnnotationColor(raw.color),
    strokeWidth: normalizeStrokeWidth(raw.strokeWidth),
    fontSize: normalizeFontSize(raw.fontSize),
    bold: Boolean(raw.bold),
    mosaicBrushSize: normalizeMosaicBrushSize(raw.mosaicBrushSize),
    mosaicBlockSize: normalizeMosaicBlockSize(raw.mosaicBlockSize)
  }
}

/**
 * 归一化文字标注内容，去除首尾空白并限制最大长度。
 * @param value 待归一化的文本。
 * @returns 合法文本；无效或空白输入返回空字符串。
 * @author zhenghq
 */
export function normalizeAnnotationText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.slice(0, SCREENSHOT_ANNOTATION_LIMITS.maxTextLength)
  return normalized.trim() ? normalized : ''
}

/**
 * 将任意拖拽起止点规范化为左上角原点、正宽高的矩形。
 * @param start 拖拽起点。
 * @param end 拖拽终点。
 * @returns 规范化矩形。
 * @author zhenghq
 */
export function normalizeRectFromPoints(
  start: ScreenshotAnnotationPoint,
  end: ScreenshotAnnotationPoint
): ScreenshotAnnotationRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

/**
 * 计算箭头头部两个端点，始终指向终点。
 * @param start 箭头起点。
 * @param end 箭头终点。
 * @param strokeWidth 当前线宽。
 * @returns 箭头头部两个端点。
 * @author zhenghq
 */
export function computeArrowHeadPoints(
  start: ScreenshotAnnotationPoint,
  end: ScreenshotAnnotationPoint,
  strokeWidth: number
): [ScreenshotAnnotationPoint, ScreenshotAnnotationPoint] {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length <= 0) {
    return [{ x: end.x, y: end.y }, { x: end.x, y: end.y }]
  }
  const headLength = Math.max(8, strokeWidth * 3)
  const unitX = dx / length
  const unitY = dy / length
  const baseX = end.x - unitX * headLength
  const baseY = end.y - unitY * headLength
  const halfWidth = headLength * 0.45
  const normalX = -unitY
  const normalY = unitX
  return [
    { x: baseX + normalX * halfWidth, y: baseY + normalY * halfWidth },
    { x: baseX - normalX * halfWidth, y: baseY - normalY * halfWidth }
  ]
}

/**
 * 抽稀连续笔迹点，丢弃过近的点、限制最大点数并保留首尾点。
 * @param points 原始点集合。
 * @returns 抽稀后的点集合。
 * @author zhenghq
 */
export function simplifyBrushPoints(
  points: ScreenshotAnnotationPoint[]
): ScreenshotAnnotationPoint[] {
  if (points.length <= 1) return points.map((point) => ({ ...point }))
  const simplified: ScreenshotAnnotationPoint[] = [{ ...points[0]! }]
  for (const point of points.slice(1)) {
    const last = simplified[simplified.length - 1]!
    if (Math.hypot(point.x - last.x, point.y - last.y) >= MIN_POINT_DISTANCE) {
      simplified.push({ ...point })
    }
  }
  const last = points[points.length - 1]!
  const simplifiedLast = simplified[simplified.length - 1]!
  if (simplifiedLast.x !== last.x || simplifiedLast.y !== last.y) {
    simplified.push({ ...last })
  }
  if (simplified.length <= SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints) return simplified
  const capped: ScreenshotAnnotationPoint[] = []
  const step = (simplified.length - 1) / (SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints - 1)
  for (let index = 0; index < SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints; index += 1) {
    capped.push({ ...simplified[Math.round(index * step)]! })
  }
  return capped
}

/**
 * 将覆盖层坐标转换为当前选区相对坐标。
 * @param point 覆盖层坐标。
 * @param selection 当前选区。
 * @returns 选区相对坐标。
 * @author zhenghq
 */
export function toSelectionRelativePoint(
  point: ScreenshotAnnotationPoint,
  selection: OcrSelectionBounds
): ScreenshotAnnotationPoint {
  return {
    x: point.x - selection.x,
    y: point.y - selection.y
  }
}

/**
 * 判断点是否位于当前选区内部。
 * @param point 覆盖层坐标。
 * @param selection 当前选区。
 * @returns 是否位于选区内部。
 * @author zhenghq
 */
export function isPointInsideSelection(
  point: ScreenshotAnnotationPoint,
  selection: OcrSelectionBounds
): boolean {
  return (
    point.x >= selection.x &&
    point.x <= selection.x + selection.width &&
    point.y >= selection.y &&
    point.y <= selection.y + selection.height
  )
}

/**
 * 将选区相对坐标裁剪到选区边界内。
 * @param point 选区相对坐标。
 * @param selection 当前选区。
 * @returns 裁剪后的相对坐标。
 * @author zhenghq
 */
export function clampPointToSelection(
  point: ScreenshotAnnotationPoint,
  selection: Pick<OcrSelectionBounds, 'width' | 'height'>
): ScreenshotAnnotationPoint {
  return {
    x: Math.min(selection.width, Math.max(0, point.x)),
    y: Math.min(selection.height, Math.max(0, point.y))
  }
}

/**
 * 计算导出时从覆盖层逻辑尺寸到原图像素尺寸的缩放比例。
 * @param logicalSize 覆盖层逻辑尺寸。
 * @param naturalSize 原始截图自然尺寸。
 * @returns 横纵缩放比例；非法输入回退为 1。
 * @author zhenghq
 */
export function computeExportScale(
  logicalSize: { width: number; height: number },
  naturalSize: { width: number; height: number }
): { scaleX: number; scaleY: number } {
  const scaleX = naturalSize.width / logicalSize.width
  const scaleY = naturalSize.height / logicalSize.height
  return {
    scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
    scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1
  }
}

/**
 * 按导出比例计算导出画布尺寸，并限制在最大像素数范围内。
 * @param bounds 当前选区逻辑矩形。
 * @param scale 导出缩放比例。
 * @returns 导出画布尺寸与实际使用的比例。
 * @author zhenghq
 */
export function computeExportCanvasSize(
  bounds: Pick<OcrSelectionBounds, 'width' | 'height'>,
  scale: { scaleX: number; scaleY: number }
): { width: number; height: number; scaleX: number; scaleY: number } {
  let width = Math.max(1, Math.round(bounds.width * scale.scaleX))
  let height = Math.max(1, Math.round(bounds.height * scale.scaleY))
  const pixels = width * height
  if (pixels > SCREENSHOT_ANNOTATION_LIMITS.maxExportPixels) {
    const shrink = Math.sqrt(SCREENSHOT_ANNOTATION_LIMITS.maxExportPixels / pixels)
    width = Math.max(1, Math.floor(width * shrink))
    height = Math.max(1, Math.floor(height * shrink))
  }
  return {
    width,
    height,
    scaleX: width / bounds.width,
    scaleY: height / bounds.height
  }
}

/**
 * 创建矩形或椭圆标注，规范化边界并冻结当前样式。
 * @param type 标注类型。
 * @param start 拖拽起点（选区相对坐标）。
 * @param end 拖拽终点（选区相对坐标）。
 * @param style 当前标注样式。
 * @returns 新标注；位移过小时返回 null。
 * @author zhenghq
 */
export function createShapeAnnotation(
  type: 'rect' | 'ellipse',
  start: ScreenshotAnnotationPoint,
  end: ScreenshotAnnotationPoint,
  style: ScreenshotAnnotationStyle
): ScreenshotShapeAnnotation | null {
  const bounds = normalizeRectFromPoints(start, end)
  if (bounds.width < MIN_POINT_DISTANCE || bounds.height < MIN_POINT_DISTANCE) return null
  return {
    type,
    bounds,
    color: style.color,
    strokeWidth: style.strokeWidth
  }
}

/**
 * 创建箭头标注，冻结当前颜色与线宽。
 * @param start 箭头起点（选区相对坐标）。
 * @param end 箭头终点（选区相对坐标）。
 * @param style 当前标注样式。
 * @returns 新标注；位移过小时返回 null。
 * @author zhenghq
 */
export function createArrowAnnotation(
  start: ScreenshotAnnotationPoint,
  end: ScreenshotAnnotationPoint,
  style: ScreenshotAnnotationStyle
): ScreenshotArrowAnnotation | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_POINT_DISTANCE) return null
  return {
    type: 'arrow',
    start: { ...start },
    end: { ...end },
    color: style.color,
    strokeWidth: style.strokeWidth
  }
}

/**
 * 创建画笔标注，抽稀点集合并冻结当前颜色与笔刷粗细。
 * @param points 笔迹点集合。
 * @param style 当前标注样式。
 * @returns 新标注；空笔迹返回 null。
 * @author zhenghq
 */
export function createBrushAnnotation(
  points: ScreenshotAnnotationPoint[],
  style: ScreenshotAnnotationStyle
): ScreenshotBrushAnnotation | null {
  const simplified = simplifyBrushPoints(points)
  if (simplified.length === 0) return null
  return {
    type: 'brush',
    points: simplified,
    color: style.color,
    strokeWidth: style.strokeWidth
  }
}

/**
 * 创建文字标注，归一化文本并冻结当前文字样式。
 * @param position 文字位置（选区相对坐标）。
 * @param text 用户输入文本。
 * @param style 当前标注样式。
 * @returns 新标注；空文本返回 null。
 * @author zhenghq
 */
export function createTextAnnotation(
  position: ScreenshotAnnotationPoint,
  text: string,
  style: ScreenshotAnnotationStyle
): ScreenshotTextAnnotation | null {
  const normalized = normalizeAnnotationText(text)
  if (!normalized) return null
  return {
    type: 'text',
    position: { ...position },
    text: normalized,
    color: style.color,
    fontSize: style.fontSize,
    bold: style.bold
  }
}

/**
 * 计算文字标注的命中区域。
 * @param annotation 文字标注。
 * @param measureLine 可选的单行宽度测量函数；未提供时使用字符数估算。
 * @returns 覆盖全部文字行的矩形。
 * @author zhenghq
 */
export function getTextAnnotationBounds(
  annotation: ScreenshotTextAnnotation,
  measureLine: (line: string) => number = (line) => line.length * annotation.fontSize * 0.75
): ScreenshotAnnotationRect {
  const lines = annotation.text.split('\n')
  return {
    x: annotation.position.x,
    y: annotation.position.y,
    width: Math.max(1, ...lines.map((line) => measureLine(line))),
    height: Math.max(1, lines.length * annotation.fontSize * 1.3)
  }
}

/**
 * 创建马赛克标注，抽稀轨迹点并冻结当前笔刷与像素块设置。
 * @param points 马赛克轨迹点集合。
 * @param style 当前标注样式。
 * @returns 新标注；空轨迹返回 null。
 * @author zhenghq
 */
export function createMosaicAnnotation(
  points: ScreenshotAnnotationPoint[],
  style: ScreenshotAnnotationStyle
): ScreenshotMosaicAnnotation | null {
  const simplified = simplifyBrushPoints(points)
  if (simplified.length === 0) return null
  return {
    type: 'mosaic',
    points: simplified,
    brushSize: style.mosaicBrushSize,
    blockSize: style.mosaicBlockSize
  }
}

/**
 * 标注历史存储，负责正式标注集合、撤销与重做。
 * @author zhenghq
 */
export class ScreenshotAnnotationStore {
  private undoStack: ScreenshotAnnotation[][] = []
  private redoStack: ScreenshotAnnotation[][] = []
  private items: ScreenshotAnnotation[] = []

  /**
   * 获取当前正式标注集合。
   * @returns 当前标注数组。
   */
  get annotations(): ScreenshotAnnotation[] {
    return this.items
  }

  /**
   * 获取当前是否可撤销。
   * @returns 是否可撤销。
   */
  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  /**
   * 获取当前是否可重做。
   * @returns 是否可重做。
   */
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /**
   * 判断当前是否没有任何标注。
   * @returns 是否为空。
   */
  isEmpty(): boolean {
    return this.items.length === 0
  }

  /**
   * 添加一条标注并清空重做栈。
   * @param annotation 待添加的标注。
   * @returns 无返回值。
   */
  add(annotation: ScreenshotAnnotation): void {
    if (this.items.length >= SCREENSHOT_ANNOTATION_LIMITS.maxAnnotations) return
    this.undoStack.push(this.snapshot())
    this.items = [...this.items, annotation]
    this.redoStack = []
  }

  /**
   * 替换指定标注并记录撤销历史。
   * @param index 标注索引。
   * @param annotation 新标注。
   * @returns 是否替换成功。
   * @author zhenghq
   */
  replace(index: number, annotation: ScreenshotAnnotation): boolean {
    if (index < 0 || index >= this.items.length) return false
    this.undoStack.push(this.snapshot())
    this.items = this.items.map((item, itemIndex) => itemIndex === index ? annotation : item)
    this.redoStack = []
    return true
  }

  /**
   * 记录外部已经完成的标注变更，供拖动等连续交互建立单次撤销记录。
   * @param previous 变更前的标注快照。
   * @returns 无返回值。
   * @author zhenghq
   */
  commitExternalChange(previous: ScreenshotAnnotation[]): void {
    this.undoStack.push(previous)
    this.redoStack = []
  }

  /**
   * 撤销最近一次标注变更。
   * @returns 是否执行了撤销。
   */
  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.redoStack.push(this.snapshot())
    this.items = previous
    return true
  }

  /**
   * 重做最近一次被撤销的标注变更。
   * @returns 是否执行了重做。
   */
  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push(this.snapshot())
    this.items = next
    return true
  }

  /**
   * 清空全部标注，支持通过撤销恢复。
   * @returns 是否实际清空了标注。
   */
  clear(): boolean {
    if (this.items.length === 0) return false
    this.undoStack.push(this.snapshot())
    this.items = []
    this.redoStack = []
    return true
  }

  /**
   * 重置标注存储，用于新截图会话或重新框选。
   * @returns 无返回值。
   */
  reset(): void {
    this.items = []
    this.undoStack = []
    this.redoStack = []
  }

  /**
   * 创建当前标注集合的快照，避免历史记录被后续数组修改污染。
   * @returns 标注数组快照。
   */
  private snapshot(): ScreenshotAnnotation[] {
    return [...this.items]
  }
}

/** Canvas 马赛克渲染可选配置。 */
export interface AnnotationRenderOptions {
  /** 从原图采样指定区域颜色的函数；未提供时使用默认马赛克填充色。 */
  sampleColor?: (x: number, y: number, size?: number) => string
}

/**
 * 将 ImageData 按像素块大小原地像素化，每个块填充块内平均颜色。
 * @param data RGBA 像素数据。
 * @param width 图片宽度。
 * @param height 图片高度。
 * @param blockSize 像素块边长。
 * @returns 无返回值。
 * @author zhenghq
 */
export function pixelateImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  blockSize: number
): void {
  const size = Math.max(1, Math.round(blockSize))
  for (let blockY = 0; blockY < height; blockY += size) {
    for (let blockX = 0; blockX < width; blockX += size) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let y = blockY; y < Math.min(height, blockY + size); y += 1) {
        for (let x = blockX; x < Math.min(width, blockX + size); x += 1) {
          const offset = (y * width + x) * 4
          r += data[offset] ?? 0
          g += data[offset + 1] ?? 0
          b += data[offset + 2] ?? 0
          a += data[offset + 3] ?? 255
          count += 1
        }
      }
      const averageR = Math.round(r / count)
      const averageG = Math.round(g / count)
      const averageB = Math.round(b / count)
      const averageA = Math.round(a / count)
      for (let y = blockY; y < Math.min(height, blockY + size); y += 1) {
        for (let x = blockX; x < Math.min(width, blockX + size); x += 1) {
          const offset = (y * width + x) * 4
          data[offset] = averageR
          data[offset + 1] = averageG
          data[offset + 2] = averageB
          data[offset + 3] = averageA
        }
      }
    }
  }
}

/**
 * 将一组标注绘制到 Canvas 上下文。
 * @param ctx Canvas 2D 上下文。
 * @param annotations 待绘制的标注集合。
 * @param options 马赛克采样配置。
 * @returns 无返回值。
 * @author zhenghq
 */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: ScreenshotAnnotation[],
  options: AnnotationRenderOptions = {}
): void {
  for (const annotation of annotations) {
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    switch (annotation.type) {
      case 'rect':
        ctx.strokeStyle = annotation.color
        ctx.lineWidth = annotation.strokeWidth
        ctx.beginPath()
        ctx.rect(
          annotation.bounds.x,
          annotation.bounds.y,
          annotation.bounds.width,
          annotation.bounds.height
        )
        ctx.stroke()
        break
      case 'ellipse':
        ctx.strokeStyle = annotation.color
        ctx.lineWidth = annotation.strokeWidth
        ctx.beginPath()
        ctx.ellipse(
          annotation.bounds.x + annotation.bounds.width / 2,
          annotation.bounds.y + annotation.bounds.height / 2,
          annotation.bounds.width / 2,
          annotation.bounds.height / 2,
          0,
          0,
          Math.PI * 2
        )
        ctx.stroke()
        break
      case 'arrow': {
        ctx.strokeStyle = annotation.color
        ctx.lineWidth = annotation.strokeWidth
        ctx.beginPath()
        ctx.moveTo(annotation.start.x, annotation.start.y)
        ctx.lineTo(annotation.end.x, annotation.end.y)
        const [left, right] = computeArrowHeadPoints(
          annotation.start,
          annotation.end,
          annotation.strokeWidth
        )
        ctx.moveTo(annotation.end.x, annotation.end.y)
        ctx.lineTo(left.x, left.y)
        ctx.moveTo(annotation.end.x, annotation.end.y)
        ctx.lineTo(right.x, right.y)
        ctx.stroke()
        break
      }
      case 'brush':
        ctx.strokeStyle = annotation.color
        ctx.fillStyle = annotation.color
        ctx.lineWidth = annotation.strokeWidth
        ctx.beginPath()
        if (annotation.points.length === 1) {
          const point = annotation.points[0]!
          ctx.arc(point.x, point.y, annotation.strokeWidth / 2, 0, Math.PI * 2)
          ctx.fill()
          break
        }
        ctx.moveTo(annotation.points[0]!.x, annotation.points[0]!.y)
        for (const point of annotation.points.slice(1)) {
          ctx.lineTo(point.x, point.y)
        }
        ctx.stroke()
        break
      case 'text':
        ctx.fillStyle = annotation.color
        ctx.font = `${annotation.bold ? '700' : '400'} ${annotation.fontSize}px -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif`
        ctx.textBaseline = 'top'
        // Canvas 的 fillText 不会解释换行符，按行绘制才能让输入框中的换行原样导出。
        annotation.text.split('\n').forEach((line, index) => {
          ctx.fillText(
            line,
            annotation.position.x,
            annotation.position.y + index * annotation.fontSize * 1.3
          )
        })
        break
      case 'mosaic':
        drawMosaicAnnotation(ctx, annotation, options)
        break
    }
    ctx.restore()
  }
}

/**
 * 计算马赛克笔刷轨迹覆盖到的像素块集合。
 * @param points 笔刷轨迹点集合。
 * @param brushSize 笔刷直径。
 * @param blockSize 马赛克像素块边长。
 * @returns 去重后的像素块左上角坐标集合。
 * @author zhenghq
 */
export function computeMosaicBlocks(
  points: ScreenshotAnnotationPoint[],
  brushSize: number,
  blockSize: number
): ScreenshotAnnotationPoint[] {
  const normalizedBlockSize = Math.max(1, Math.round(blockSize))
  const radius = Math.max(1, brushSize) / 2
  const blocks = new Map<string, { x: number; y: number }>()
  for (const point of points) {
    const minX = Math.floor((point.x - radius) / normalizedBlockSize)
    const maxX = Math.floor((point.x + radius) / normalizedBlockSize)
    const minY = Math.floor((point.y - radius) / normalizedBlockSize)
    const maxY = Math.floor((point.y + radius) / normalizedBlockSize)
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const blockCenterX = x * normalizedBlockSize + normalizedBlockSize / 2
        const blockCenterY = y * normalizedBlockSize + normalizedBlockSize / 2
        if (Math.hypot(blockCenterX - point.x, blockCenterY - point.y) > radius) continue
        blocks.set(`${x}:${y}`, {
          x: x * normalizedBlockSize,
          y: y * normalizedBlockSize
        })
      }
    }
  }
  return Array.from(blocks.values())
}

/**
 * 绘制马赛克标注，只处理笔刷覆盖到的像素块。
 * @param ctx Canvas 2D 上下文。
 * @param annotation 马赛克标注。
 * @param options 马赛克采样配置。
 * @returns 无返回值。
 * @author zhenghq
 */
function drawMosaicAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: ScreenshotMosaicAnnotation,
  options: AnnotationRenderOptions
): void {
  const blockSize = Math.max(1, Math.round(annotation.blockSize))
  const blocks = computeMosaicBlocks(annotation.points, annotation.brushSize, blockSize)
  // 马赛克必须是不透明覆盖层，否则底层文字会透过半透明颜色重新显现。
  ctx.globalAlpha = 1
  for (const block of blocks) {
    ctx.fillStyle = options.sampleColor?.(
      block.x + blockSize / 2,
      block.y + blockSize / 2,
      blockSize
    ) ?? 'rgba(128, 128, 128, 1)'
    ctx.fillRect(block.x, block.y, blockSize, blockSize)
  }
}

/** 进行中的笔迹状态。 */
type StrokeDraft =
  | {
      tool: 'rect' | 'ellipse' | 'arrow'
      start: ScreenshotAnnotationPoint
      current: ScreenshotAnnotationPoint
    }
  | {
      tool: 'brush' | 'mosaic'
      points: ScreenshotAnnotationPoint[]
    }

/**
 * 截图标注控制器，维护工具状态、绘制预览、文字编辑与历史。
 * @author zhenghq
 */
export class ScreenshotAnnotationController {
  private readonly store = new ScreenshotAnnotationStore()
  private selection: OcrSelectionBounds | null = null
  private activeTool: ScreenshotAnnotationTool | null = null
  private draft: StrokeDraft | null = null
  private textPoint: ScreenshotAnnotationPoint | null = null
  private textEditingIndex: number | null = null
  private textMoveIndex: number | null = null
  private textMoveOriginal: ScreenshotAnnotation[] | null = null
  private currentStyle: ScreenshotAnnotationStyle = { ...DEFAULT_SCREENSHOT_ANNOTATION_STYLE }
  preview: ScreenshotAnnotation | null = null

  /**
   * 获取当前激活的标注工具。
   * @returns 当前工具；未激活时为 null。
   */
  get tool(): ScreenshotAnnotationTool | null {
    return this.activeTool
  }

  /**
   * 获取当前正式标注集合。
   * @returns 当前标注数组。
   */
  get annotations(): ScreenshotAnnotation[] {
    return this.store.annotations
  }

  /**
   * 查找命中指定坐标的文字标注，按绘制顺序从上层向下层匹配。
   * @param point 选区内相对坐标。
   * @returns 命中的文字标注；未命中时返回 null。
   * @author zhenghq
   */
  findTextAt(point: ScreenshotAnnotationPoint): ScreenshotTextAnnotation | null {
    for (const annotation of [...this.store.annotations].reverse()) {
      if (annotation.type !== 'text') continue
      const bounds = getTextAnnotationBounds(annotation)
      if (point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
          point.y >= bounds.y && point.y <= bounds.y + bounds.height) return annotation
    }
    return null
  }

  /**
   * 获取当前样式状态。
   * @returns 当前样式。
   */
  get style(): ScreenshotAnnotationStyle {
    return this.currentStyle
  }

  /**
   * 获取文字编辑框当前位置。
   * @returns 文字编辑位置；未编辑时为 null。
   */
  get textEditorPoint(): ScreenshotAnnotationPoint | null {
    return this.textPoint
  }

  /**
   * 获取当前文字编辑框的初始内容。
   * @returns 正在编辑的文字；新建文字时返回空字符串。
   * @author zhenghq
   */
  get textEditorValue(): string {
    if (this.textEditingIndex === null) return ''
    return this.store.annotations[this.textEditingIndex]?.type === 'text'
      ? this.store.annotations[this.textEditingIndex].text
      : ''
  }

  /**
   * 获取当前是否可撤销。
   * @returns 是否可撤销。
   */
  get canUndo(): boolean {
    return this.store.canUndo
  }

  /**
   * 获取当前是否可重做。
   * @returns 是否可重做。
   */
  get canRedo(): boolean {
    return this.store.canRedo
  }

  /**
   * 更新当前选区，选区移动时标注保持相对坐标不变。
   * @param selection 当前选区。
   * @returns 无返回值。
   */
  setSelection(selection: OcrSelectionBounds | null): void {
    this.selection = selection ? { ...selection } : null
  }

  /**
   * 选择或取消标注工具；再次选择同一工具时取消标注模式。
   * @param tool 待激活工具。
   * @returns 无返回值。
   */
  setTool(tool: ScreenshotAnnotationTool | null): void {
    this.cancelAnnotationInput()
    this.activeTool = this.activeTool === tool ? null : tool
  }

  /**
   * 重置当前截图会话的工具状态并清理标注数据。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetForNewSession(): void {
    this.cancelAnnotationInput()
    this.activeTool = null
    this.resetForNewSelection(null)
  }

  /**
   * 退出当前标注工具，但保留已有标注与样式。
   * @returns 是否成功退出工具。
   * @author zhenghq
   */
  deactivateTool(): boolean {
    if (!this.activeTool) return false
    this.cancelAnnotationInput()
    this.activeTool = null
    return true
  }

  /**
   * 判断当前是否处于标注交互模式。
   * @returns 是否接管指针输入。
   */
  isAnnotating(): boolean {
    return this.activeTool !== null
  }

  /**
   * 判断当前是否存在正在进行的绘制草稿，即使起点和终点尚未形成有效预览。
   * @returns 是否正在绘制。
   * @author zhenghq
   */
  isDrawing(): boolean {
    return this.draft !== null
  }

  /**
   * 更新当前标注颜色。
   * @param value 待设置颜色。
   * @returns 无返回值。
   */
  setColor(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      color: normalizeAnnotationColor(value)
    }
  }

  /**
   * 更新当前线宽或画笔粗细。
   * @param value 待设置线宽。
   * @returns 无返回值。
   */
  setStrokeWidth(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      strokeWidth: normalizeStrokeWidth(value)
    }
  }

  /**
   * 更新当前文字字号。
   * @param value 待设置字号。
   * @returns 无返回值。
   */
  setFontSize(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      fontSize: normalizeFontSize(value)
    }
  }

  /**
   * 更新当前文字加粗状态。
   * @param value 是否加粗。
   * @returns 无返回值。
   */
  setBold(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      bold: Boolean(value)
    }
  }

  /**
   * 更新马赛克笔刷直径。
   * @param value 待设置笔刷直径。
   * @returns 无返回值。
   */
  setMosaicBrushSize(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      mosaicBrushSize: normalizeMosaicBrushSize(value)
    }
  }

  /**
   * 更新马赛克像素块边长。
   * @param value 待设置像素块边长。
   * @returns 无返回值。
   */
  setMosaicBlockSize(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      mosaicBlockSize: normalizeMosaicBlockSize(value)
    }
  }

  /**
   * 更新当前马赛克强度档位。
   * @param value weak / medium / strong 或数字强度值。
   * @returns 无返回值。
   * @author zhenghq
   */
  setMosaicIntensity(value: unknown): void {
    this.currentStyle = {
      ...this.currentStyle,
      mosaicBlockSize: normalizeMosaicIntensity(value)
    }
  }

  /**
   * 开始一次形状、箭头、画笔或马赛克绘制。
   * @param point 覆盖层坐标。
   * @returns 是否成功开始绘制。
   */
  beginStroke(point: ScreenshotAnnotationPoint): boolean {
    if (!this.selection || !this.activeTool || this.activeTool === 'text') return false
    if (!isPointInsideSelection(point, this.selection)) return false
    const relative = toSelectionRelativePoint(point, this.selection)
    const clamped = clampPointToSelection(relative, this.selection)
    if (this.activeTool === 'brush' || this.activeTool === 'mosaic') {
      this.draft = { tool: this.activeTool, points: [clamped] }
    } else {
      this.draft = { tool: this.activeTool, start: clamped, current: clamped }
    }
    this.preview = this.buildPreview()
    return true
  }

  /**
   * 更新进行中的绘制预览。
   * @param point 当前覆盖层坐标。
   * @returns 无返回值。
   */
  updateStroke(point: ScreenshotAnnotationPoint): void {
    if (!this.selection || !this.draft) return
    const relative = toSelectionRelativePoint(point, this.selection)
    const clamped = clampPointToSelection(relative, this.selection)
    const draft = this.draft
    if (draft.tool === 'brush' || draft.tool === 'mosaic') {
      const last = draft.points[draft.points.length - 1]
      if (!last || Math.hypot(clamped.x - last.x, clamped.y - last.y) >= 0.5) {
        draft.points.push(clamped)
      }
    } else if (draft.tool === 'rect' || draft.tool === 'ellipse' || draft.tool === 'arrow') {
      draft.current = clamped
    }
    this.preview = this.buildPreview()
  }

  /**
   * 结束当前绘制并提交正式标注。
   * @returns 是否提交了标注。
   */
  endStroke(): boolean {
    const annotation = this.buildPreview()
    this.draft = null
    this.preview = null
    if (!annotation) return false
    this.store.add(annotation)
    return true
  }

  /**
   * 取消当前未完成的绘制预览。
   * @returns 是否存在被取的绘制。
   */
  cancelStroke(): boolean {
    if (!this.draft && !this.preview) return false
    this.draft = null
    this.preview = null
    return true
  }

  /**
   * 在指定位置开始文字标注编辑。
   * @param point 覆盖层坐标。
   * @returns 是否成功进入文字编辑。
   */
  beginText(point: ScreenshotAnnotationPoint): boolean {
    if (!this.selection || this.activeTool !== 'text') return false
    if (!isPointInsideSelection(point, this.selection)) return false
    const relative = toSelectionRelativePoint(point, this.selection)
    this.textPoint = clampPointToSelection(relative, this.selection)
    this.textEditingIndex = null
    return true
  }

  /**
   * 开始编辑已有文字标注。
   * @param annotation 待编辑的文字标注。
   * @returns 是否成功进入编辑状态。
   * @author zhenghq
   */
  beginTextEdit(annotation: ScreenshotTextAnnotation): boolean {
    if (!this.selection || this.activeTool !== 'text') return false
    const index = this.store.annotations.indexOf(annotation)
    if (index < 0) return false
    this.textPoint = { ...annotation.position }
    this.textEditingIndex = index
    return true
  }

  /**
   * 提交文字标注。
   * @param value 用户输入文本。
   * @returns 是否提交了标注。
   */
  commitText(value: string): boolean {
    if (!this.textPoint) return false
    const annotation = createTextAnnotation(this.textPoint, value, this.currentStyle)
    if (!annotation) {
      this.textPoint = null
      this.textEditingIndex = null
      return false
    }
    if (this.textEditingIndex === null) {
      this.store.add(annotation)
    } else {
      const existing = this.store.annotations[this.textEditingIndex]
      if (existing?.type === 'text') {
        this.store.replace(this.textEditingIndex, { ...existing, text: annotation.text })
      }
    }
    this.textPoint = null
    this.textEditingIndex = null
    return true
  }

  /**
   * 开始拖动已有文字标注。
   * @param annotation 待拖动的文字标注。
   * @returns 是否成功开始拖动。
   * @author zhenghq
   */
  beginTextMove(annotation: ScreenshotTextAnnotation): boolean {
    const index = this.store.annotations.indexOf(annotation)
    if (index < 0) return false
    this.textMoveIndex = index
    this.textMoveOriginal = this.store.annotations.map((item) => item.type === 'text'
      ? { ...item, position: { ...item.position } }
      : item)
    return true
  }

  /**
   * 更新正在拖动的文字标注位置。
   * @param point 覆盖层中的目标坐标。
   * @returns 无返回值。
   * @author zhenghq
   */
  updateTextPosition(point: ScreenshotAnnotationPoint): void {
    if (!this.selection || this.textMoveIndex === null) return
    const annotation = this.store.annotations[this.textMoveIndex]
    if (!annotation || annotation.type !== 'text') return
    const relative = clampPointToSelection(toSelectionRelativePoint(point, this.selection), this.selection)
    annotation.position = relative
  }

  /**
   * 结束文字拖动并记录一次撤销历史。
   * @returns 是否发生了位置变化。
   * @author zhenghq
   */
  endTextMove(): boolean {
    if (this.textMoveIndex === null || !this.textMoveOriginal) return false
    const index = this.textMoveIndex
    const current = this.store.annotations[index]
    const original = this.textMoveOriginal[index]
    const changed = Boolean(current && original && current.type === 'text' && original.type === 'text' &&
      (current.position.x !== original.position.x || current.position.y !== original.position.y))
    if (changed) this.store.commitExternalChange(this.textMoveOriginal)
    this.textMoveIndex = null
    this.textMoveOriginal = null
    return changed
  }

  /**
   * 取消当前文字标注编辑。
   * @returns 是否存在被取消的文字编辑。
   */
  cancelText(): boolean {
    if (!this.textPoint) return false
    this.textPoint = null
    this.textEditingIndex = null
    return true
  }

  /**
   * 取消所有未完成的标注输入，包括绘制预览与文字编辑。
   * @returns 是否存在被取消的输入。
   */
  cancelAnnotationInput(): boolean {
    const canceled = this.cancelStroke() || this.cancelText()
    return canceled
  }

  /**
   * 撤销最近一次标注变更。
   * @returns 是否执行了撤销。
   */
  undo(): boolean {
    return this.store.undo()
  }

  /**
   * 重做最近一次被撤销的标注变更。
   * @returns 是否执行了重做。
   */
  redo(): boolean {
    return this.store.redo()
  }

  /**
   * 清空全部标注，支持撤销恢复。
   * @returns 是否实际清空了标注。
   */
  clearAnnotations(): boolean {
    return this.store.clear()
  }

  /**
   * 为重新框选重置标注状态。
   * @param selection 新选区。
   * @returns 无返回值。
   */
  resetForNewSelection(selection: OcrSelectionBounds | null): void {
    this.selection = selection ? { ...selection } : null
    this.draft = null
    this.preview = null
    this.textPoint = null
    this.textEditingIndex = null
    this.textMoveIndex = null
    this.textMoveOriginal = null
    this.store.reset()
  }

  /**
   * 构建当前绘制草稿对应的预览标注。
   * @returns 预览标注；草稿为空或无效时返回 null。
   */
  private buildPreview(): ScreenshotAnnotation | null {
    if (!this.draft) return null
    const draft = this.draft
    if (draft.tool === 'rect' || draft.tool === 'ellipse') {
      return createShapeAnnotation(draft.tool, draft.start, draft.current, this.currentStyle)
    }
    if (draft.tool === 'arrow') {
      return createArrowAnnotation(draft.start, draft.current, this.currentStyle)
    }
    if (draft.tool === 'brush') {
      return createBrushAnnotation(draft.points, this.currentStyle)
    }
    if (draft.tool === 'mosaic') {
      return createMosaicAnnotation(draft.points, this.currentStyle)
    }
    return null
  }
}
