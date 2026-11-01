/** 长截图单行哈希。 */
type RowHash = number

/** 屏幕矩形，字段与 Electron Rectangle 保持兼容。 */
export interface Rect {
  /** 左上角横坐标。 */
  x: number
  /** 左上角纵坐标。 */
  y: number
  /** 矩形宽度。 */
  width: number
  /** 矩形高度。 */
  height: number
}

/** 长截图滚动定位结果。 */
export interface ScrollOffsetMatch {
  /** 是否找到可信的完整重叠区。 */
  confident: boolean
  /** 下一帧相对上一帧的滚动偏移；正数表示向下滚动。 */
  offset: number
  /** 上一帧中新增内容的起始行。 */
  start: number
  /** 上一帧中新增内容的结束行。 */
  end: number
}

/** 固定页眉页脚识别结果。 */
export interface FixedRegions {
  /** 顶部固定行数。 */
  top: number
  /** 底部固定行数。 */
  bottom: number
}

/** 固定区域识别选项。 */
export interface FixedRegionOptions {
  /** 连续相同的最小行数，默认 8。 */
  minFixedRows?: number
}

/** 长截图拼接选项。 */
export interface LongCaptureOptions extends FixedRegionOptions {
  /** 输出图像最大高度，默认 32768。 */
  maxHeight?: number
  /** 完整重叠区最低一致比例，默认 0.9。 */
  minMatchRatio?: number
}

/** 长截图拼接结果。 */
export interface LongCaptureResult {
  /** 拼接后的 RGBA 像素。 */
  data: Uint8ClampedArray
  /** 最终图像高度。 */
  height: number
  /** 最终保留的顶部固定行数。 */
  fixedTop: number
  /** 最终保留的底部固定行数。 */
  fixedBottom: number
}

/** 长截图实时预览缩放选项。 */
export interface LongCapturePreviewOptions {
  /** 预览最大宽度，默认 720。 */
  maxWidth?: number
  /** 预览最大高度，默认 1600。 */
  maxHeight?: number
  /** 预览最大像素数，默认 640000。 */
  maxPixels?: number
}

/** 长截图撤销快照。 */
interface LongCaptureHistoryEntry {
  /** 拼接主体像素。 */
  body: Uint8ClampedArray | null
  /** 拼接主体高度。 */
  bodyHeight: number
  /** 顶部固定区域像素。 */
  fixedTopData: Uint8ClampedArray | null
  /** 底部固定区域像素。 */
  fixedBottomData: Uint8ClampedArray | null
  /** 上一帧像素。 */
  lastFrame: Uint8ClampedArray | null
  /** 上一帧滚动偏移。 */
  offset: number
  /** 是否已触发最大高度限制。 */
  truncated: boolean
}

/** 默认最大输出高度。 */
const DEFAULT_MAX_HEIGHT = 32768
/** 默认固定区域最小行数。 */
const DEFAULT_MIN_FIXED_ROWS = 8
/** 默认完整重叠区最低一致比例。 */
const DEFAULT_MIN_MATCH_RATIO = 0.9
/** 可参与匹配的最小重叠行数。 */
const MIN_OVERLAP_ROWS = 4
/** 实时预览默认最大宽度。 */
const DEFAULT_PREVIEW_MAX_WIDTH = 720
/** 实时预览默认最大高度。 */
const DEFAULT_PREVIEW_MAX_HEIGHT = 1600
/** 实时预览默认最大像素数。 */
const DEFAULT_PREVIEW_MAX_PIXELS = 640_000
/** 长截图状态条首选高度。 */
const STATUS_BAR_PREFERRED_HEIGHT = 48
/** 长截图状态条最小可用高度；上下空间不足时缩到该值。 */
const STATUS_BAR_MIN_HEIGHT = 40
/** 长截图状态条首选宽度。 */
const STATUS_BAR_PREFERRED_WIDTH = 760
/** 长截图状态条最小宽度。 */
const STATUS_BAR_MIN_WIDTH = 320
/** 长截图侧边预览首选宽度。 */
const PREVIEW_PREFERRED_WIDTH = 240
/** 长截图侧边预览最小宽度。 */
const PREVIEW_MIN_WIDTH = 120
/** 长截图侧边预览最大高度。 */
const PREVIEW_MAX_HEIGHT = 560
/** 长截图窗口与选区之间的间距。 */
const LONG_CAPTURE_GAP = 8

/**
 * 判断两个矩形是否相交；边缘刚好贴合不算相交。
 * @param a 第一个矩形。
 * @param b 第二个矩形。
 * @returns 两个矩形是否存在面积重叠。
 * @author zhenghq
 */
export function rectanglesOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
}

/**
 * 将矩形限制在指定工作区内。
 * @param rect 待约束矩形。
 * @param workArea 屏幕工作区。
 * @returns 不超出工作区边界的矩形。
 * @author zhenghq
 */
function clampRectToWorkArea(rect: Rect, workArea: Rect): Rect {
  const width = Math.max(1, Math.min(rect.width, workArea.width))
  const height = Math.max(1, Math.min(rect.height, workArea.height))
  return {
    x: Math.max(workArea.x, Math.min(rect.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(rect.y, workArea.y + workArea.height - height)),
    width,
    height
  }
}

/**
 * 计算长截图紧凑状态条位置：优先选区下方，其次上方，最后尝试左右侧边。
 * 状态条始终优先避开采集选区，空间不足时缩到 40px 高而不是覆盖选区。
 * @param selection 采集选区。
 * @param workArea 选区所在显示器工作区。
 * @returns 状态条边界。
 * @author zhenghq
 */
export function placeLongCaptureStatusBar(selection: Rect, workArea: Rect): Rect {
  const width = Math.max(1, Math.min(STATUS_BAR_PREFERRED_WIDTH, workArea.width))
  const x = Math.max(workArea.x, Math.min(selection.x, workArea.x + workArea.width - width))
  const belowSpace = workArea.y + workArea.height - (selection.y + selection.height)
  const aboveSpace = selection.y - workArea.y

  if (belowSpace >= STATUS_BAR_MIN_HEIGHT) {
    const height = Math.min(STATUS_BAR_PREFERRED_HEIGHT, belowSpace)
    const gap = belowSpace >= STATUS_BAR_PREFERRED_HEIGHT + LONG_CAPTURE_GAP ? LONG_CAPTURE_GAP : 0
    return { x, y: selection.y + selection.height + gap, width, height }
  }
  if (aboveSpace >= STATUS_BAR_MIN_HEIGHT) {
    const height = Math.min(STATUS_BAR_PREFERRED_HEIGHT, aboveSpace)
    const gap = aboveSpace >= STATUS_BAR_PREFERRED_HEIGHT + LONG_CAPTURE_GAP ? LONG_CAPTURE_GAP : 0
    return { x, y: selection.y - height - gap, width, height }
  }

  // 上下都被占满时，尝试把状态条缩窄放到左右侧边，仍保持至少 40px 可操作高度。
  const sideHeight = Math.min(STATUS_BAR_PREFERRED_HEIGHT, workArea.height)
  const rightSpace = workArea.x + workArea.width - (selection.x + selection.width)
  const leftSpace = selection.x - workArea.x
  if (sideHeight >= STATUS_BAR_MIN_HEIGHT && rightSpace >= PREVIEW_MIN_WIDTH) {
    const sideWidth = Math.min(STATUS_BAR_PREFERRED_WIDTH, rightSpace)
    return clampRectToWorkArea({
      x: selection.x + selection.width,
      y: selection.y,
      width: sideWidth,
      height: sideHeight
    }, workArea)
  }
  if (sideHeight >= STATUS_BAR_MIN_HEIGHT && leftSpace >= PREVIEW_MIN_WIDTH) {
    const sideWidth = Math.min(STATUS_BAR_PREFERRED_WIDTH, leftSpace)
    return clampRectToWorkArea({
      x: selection.x - sideWidth,
      y: selection.y,
      width: sideWidth,
      height: sideHeight
    }, workArea)
  }

  // 极端情况下工作区没有任何非选区空间，只能退化为最小宽度贴边放置。
  return {
    x: workArea.x,
    y: workArea.y,
    width: Math.max(1, Math.min(STATUS_BAR_MIN_WIDTH, workArea.width)),
    height: Math.max(1, Math.min(STATUS_BAR_MIN_HEIGHT, workArea.height))
  }
}

/**
 * 计算长截图实时预览位置：优先选区右侧，其次左侧；空间不足时隐藏预览。
 * @param selection 采集选区。
 * @param workArea 选区所在显示器工作区。
 * @returns 预览窗口边界；没有足够侧边空间时返回 null。
 * @author zhenghq
 */
export function placeLongCapturePreview(selection: Rect, workArea: Rect): Rect | null {
  const availableHeight = Math.max(0, workArea.height - LONG_CAPTURE_GAP * 2)
  const height = Math.min(PREVIEW_MAX_HEIGHT, availableHeight)
  if (height < PREVIEW_MIN_WIDTH) return null

  const rightSpace = workArea.x + workArea.width - (selection.x + selection.width) - LONG_CAPTURE_GAP
  const leftSpace = selection.x - workArea.x - LONG_CAPTURE_GAP
  const side = rightSpace >= PREVIEW_MIN_WIDTH
    ? { x: selection.x + selection.width + LONG_CAPTURE_GAP, space: rightSpace }
    : leftSpace >= PREVIEW_MIN_WIDTH
      ? { x: selection.x - LONG_CAPTURE_GAP - Math.min(PREVIEW_PREFERRED_WIDTH, leftSpace), space: leftSpace }
      : null
  if (!side) return null

  const width = Math.min(PREVIEW_PREFERRED_WIDTH, side.space)
  const preview = clampRectToWorkArea({
    x: side.x,
    y: selection.y,
    width,
    height
  }, workArea)
  return rectanglesOverlap(preview, selection) ? null : preview
}

/**
 * 计算单行 RGBA 的 FNV-1a 哈希。
 * @param data RGBA 像素。
 * @param width 图像宽度。
 * @param y 行号。
 * @returns 该行哈希值。
 * @author zhenghq
 */
function hashRow(data: Uint8ClampedArray, width: number, y: number): RowHash {
  let hash = 0x811c9dc5
  const start = y * width * 4
  const end = start + width * 4
  for (let index = start; index < end; index += 1) {
    hash ^= data[index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * 计算指定高度内所有行的哈希。
 * @param data RGBA 像素。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @returns 行哈希数组。
 * @author zhenghq
 */
function hashRows(data: Uint8ClampedArray, width: number, height: number): RowHash[] {
  return Array.from({ length: height }, (_, y) => hashRow(data, width, y))
}

/**
 * 判断两行像素是否完全一致。
 * @param previous 上一帧像素。
 * @param next 下一帧像素。
 * @param width 图像宽度。
 * @param previousY 上一帧行号。
 * @param nextY 下一帧行号。
 * @returns 两行是否一致。
 * @author zhenghq
 */
function rowsEqual(
  previous: Uint8ClampedArray,
  next: Uint8ClampedArray,
  width: number,
  previousY: number,
  nextY: number
): boolean {
  const rowBytes = width * 4
  const previousStart = previousY * rowBytes
  const nextStart = nextY * rowBytes
  for (let index = 0; index < rowBytes; index += 1) {
    if (previous[previousStart + index] !== next[nextStart + index]) return false
  }
  return true
}

/**
 * 校验帧尺寸是否与声明宽高一致。
 * @param data RGBA 像素。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @returns 尺寸是否有效。
 * @author zhenghq
 */
function hasValidDimensions(data: Uint8ClampedArray, width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    data.length === width * height * 4
}

/**
 * 计算两个滚动帧之间的完整重叠区偏移。
 * 仅当重叠区至少四行且一致比例达到阈值时返回可信结果。
 * @param previous 上一帧 RGBA 像素。
 * @param next 下一帧 RGBA 像素。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @param minMatchRatio 完整重叠区最低一致比例。
 * @returns 滚动偏移及上一帧新增内容范围。
 * @author zhenghq
 */
export function locateScrollOffset(
  previous: Uint8ClampedArray,
  next: Uint8ClampedArray,
  width: number,
  height: number,
  minMatchRatio = DEFAULT_MIN_MATCH_RATIO
): ScrollOffsetMatch {
  if (!hasValidDimensions(previous, width, height) || !hasValidDimensions(next, width, height)) {
    return { confident: false, offset: 0, start: height, end: height }
  }
  if (rowsEqual(previous, next, width, 0, 0) &&
    previous.every((value, index) => value === next[index])) {
    return { confident: true, offset: 0, start: height, end: height }
  }

  const previousHashes = hashRows(previous, width, height)
  const nextHashes = hashRows(next, width, height)
  let best: { offset: number; ratio: number; overlap: number } | null = null

  for (let offset = 1; offset < height; offset += 1) {
    const overlap = height - offset
    if (overlap < MIN_OVERLAP_ROWS) break
    let equalRows = 0
    for (let row = 0; row < overlap; row += 1) {
      const previousY = offset + row
      const nextY = row
      if (previousHashes[previousY] === nextHashes[nextY] &&
        rowsEqual(previous, next, width, previousY, nextY)) {
        equalRows += 1
      }
    }
    const ratio = equalRows / overlap
    if (ratio >= minMatchRatio &&
      (!best || ratio > best.ratio || (ratio === best.ratio && overlap > best.overlap))) {
      best = { offset, ratio, overlap }
    }
  }

  for (let offset = 1; offset < height; offset += 1) {
    const overlap = height - offset
    if (overlap < MIN_OVERLAP_ROWS) break
    let equalRows = 0
    for (let row = 0; row < overlap; row += 1) {
      const previousY = row
      const nextY = offset + row
      if (previousHashes[previousY] === nextHashes[nextY] &&
        rowsEqual(previous, next, width, previousY, nextY)) {
        equalRows += 1
      }
    }
    const ratio = equalRows / overlap
    if (ratio >= minMatchRatio &&
      (!best || ratio > best.ratio || (ratio === best.ratio && overlap > best.overlap))) {
      best = { offset: -offset, ratio, overlap }
    }
  }

  if (!best) return { confident: false, offset: 0, start: height, end: height }
  if (best.offset > 0) {
    return { confident: true, offset: best.offset, start: height - best.offset, end: height }
  }
  return { confident: true, offset: best.offset, start: 0, end: -best.offset }
}

/**
 * 识别两帧顶部和底部连续一致的固定区域。
 * @param previous 上一帧 RGBA 像素。
 * @param next 下一帧 RGBA 像素。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @param options 固定区域识别选项。
 * @returns 固定页眉页脚行数。
 * @author zhenghq
 */
export function detectFixedRegions(
  previous: Uint8ClampedArray,
  next: Uint8ClampedArray,
  width: number,
  height: number,
  options: FixedRegionOptions = {}
): FixedRegions {
  if (!hasValidDimensions(previous, width, height) || !hasValidDimensions(next, width, height)) {
    return { top: 0, bottom: 0 }
  }
  const minFixedRows = Math.max(1, Math.floor(options.minFixedRows ?? DEFAULT_MIN_FIXED_ROWS))
  let top = 0
  while (top < height && rowsEqual(previous, next, width, top, top)) top += 1
  let bottom = 0
  while (bottom < height - top && rowsEqual(previous, next, width, height - 1 - bottom, height - 1 - bottom)) {
    bottom += 1
  }
  return {
    top: top >= minFixedRows ? top : 0,
    bottom: bottom >= minFixedRows ? bottom : 0
  }
}

/**
 * 从指定起止行复制 RGBA 区域。
 * @param data 源像素。
 * @param width 图像宽度。
 * @param startRow 起始行（包含）。
 * @param endRow 结束行（不包含）。
 * @returns 复制后的像素。
 * @author zhenghq
 */
function sliceRows(data: Uint8ClampedArray, width: number, startRow: number, endRow: number): Uint8ClampedArray {
  const start = Math.max(0, startRow) * width * 4
  const end = Math.max(start, endRow * width * 4)
  return data.slice(start, end)
}

/**
 * 按行拼接多个 RGBA 区域。
 * @param parts 按从上到下顺序排列的像素区域。
 * @returns 拼接后的连续像素。
 * @author zhenghq
 */
function concatRows(parts: Uint8ClampedArray[]): Uint8ClampedArray {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8ClampedArray(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

/**
 * 将长截图结果按比例缩小为实时预览图；小于限制时原样返回，绝不放大。
 * 使用最近邻采样，避免预览生成在主进程额外承担双线性插值开销。
 * @param data 拼接后的 RGBA 像素。
 * @param width 原图宽度。
 * @param height 原图高度。
 * @param options 预览尺寸限制。
 * @returns 缩放后的 RGBA 图像。
 * @author zhenghq
 */
export function resizeLongCapturePreview(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: LongCapturePreviewOptions = {}
): { width: number; height: number; data: Uint8ClampedArray } {
  if (!hasValidDimensions(data, width, height)) {
    return { width: 0, height: 0, data: new Uint8ClampedArray(0) }
  }
  const maxWidth = Math.max(1, Math.floor(options.maxWidth ?? DEFAULT_PREVIEW_MAX_WIDTH))
  const maxHeight = Math.max(1, Math.floor(options.maxHeight ?? DEFAULT_PREVIEW_MAX_HEIGHT))
  const maxPixels = Math.max(1, Math.floor(options.maxPixels ?? DEFAULT_PREVIEW_MAX_PIXELS))
  const pixelScale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  const widthScale = Math.min(1, maxWidth / width)
  const heightScale = Math.min(1, maxHeight / height)
  const scale = Math.min(pixelScale, widthScale, heightScale)
  if (scale >= 1) return { width, height, data }

  const targetWidth = Math.max(1, Math.floor(width * scale))
  const targetHeight = Math.max(1, Math.floor(height * scale))
  const target = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / targetHeight))
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / targetWidth))
      const sourceOffset = (sourceY * width + sourceX) * 4
      const targetOffset = (y * targetWidth + x) * 4
      target[targetOffset] = data[sourceOffset]
      target[targetOffset + 1] = data[sourceOffset + 1]
      target[targetOffset + 2] = data[sourceOffset + 2]
      target[targetOffset + 3] = data[sourceOffset + 3]
    }
  }
  return { width: targetWidth, height: targetHeight, data: target }
}

/**
 * 有状态长截图拼接器。
 * 首次追加建立画布，后续帧通过完整重叠区定位并追加新增行。
 * @author zhenghq
 */
export class LongCaptureStitcher {
  /** 图像宽度。 */
  private readonly width: number
  /** 视口高度。 */
  private readonly viewportHeight: number
  /** 拼接选项。 */
  private readonly options: Required<LongCaptureOptions>
  /** 去重后的主体像素。 */
  private body: Uint8ClampedArray | null = null
  /** 当前主体高度。 */
  private bodyHeight = 0
  /** 已识别的顶部固定像素。 */
  private fixedTopData: Uint8ClampedArray | null = null
  /** 已识别的底部固定像素。 */
  private fixedBottomData: Uint8ClampedArray | null = null
  /** 最近一次原始帧，用于固定区域检测。 */
  private lastFrame: Uint8ClampedArray | null = null
  /** 最近一次可信滚动偏移。 */
  offset = 0
  /** 是否曾因最大高度限制而截断或触顶。 */
  truncated = false
  /** 可撤销的历史快照栈。 */
  private history: LongCaptureHistoryEntry[] = []

  /**
   * 创建长截图拼接器。
   * @param width 图像宽度。
   * @param height 视口高度。
   * @param options 拼接选项。
   * @author zhenghq
   */
  constructor(width: number, height: number, options: LongCaptureOptions = {}) {
    this.width = width
    this.viewportHeight = height
    this.options = {
      minFixedRows: Math.max(1, Math.floor(options.minFixedRows ?? DEFAULT_MIN_FIXED_ROWS)),
      maxHeight: Math.max(1, Math.floor(options.maxHeight ?? DEFAULT_MAX_HEIGHT)),
      minMatchRatio: Math.min(1, Math.max(0.5, options.minMatchRatio ?? DEFAULT_MIN_MATCH_RATIO))
    }
  }

  /** 当前拼接图像高度。 */
  get height(): number {
    return (this.fixedTopData?.length ?? 0) / (this.width * 4) +
      this.bodyHeight +
      (this.fixedBottomData?.length ?? 0) / (this.width * 4)
  }

  /** 当前是否存在可撤销的拼接步骤。 */
  get canUndo(): boolean {
    return this.history.length > 0
  }

  /**
   * 返回当前拼接图像快照。
   * @returns 包含固定页眉页脚与主体的 RGBA 像素。
   * @author zhenghq
   */
  snapshot(): Uint8ClampedArray {
    if (!this.body) return new Uint8ClampedArray(0)
    return concatRows([
      this.fixedTopData ?? new Uint8ClampedArray(0),
      this.body,
      this.fixedBottomData ?? new Uint8ClampedArray(0)
    ])
  }

  /**
   * 返回最终拼接结果。
   * @returns 最终像素、高度与固定区域信息。
   * @author zhenghq
   */
  result(): LongCaptureResult {
    const data = this.snapshot()
    return {
      data,
      height: data.length / (this.width * 4),
      fixedTop: (this.fixedTopData?.length ?? 0) / (this.width * 4),
      fixedBottom: (this.fixedBottomData?.length ?? 0) / (this.width * 4)
    }
  }

  /**
   * 追加一帧并尝试去重拼接。
   * @param data 当前视口 RGBA 像素。
   * @param height 当前视口高度。
   * @returns 是否追加了新的内容。
   * @author zhenghq
   */
  appendFrame(data: Uint8ClampedArray, height: number): boolean {
    if (!hasValidDimensions(data, this.width, height) || height !== this.viewportHeight) return false
    if (!this.lastFrame || !this.body) {
      this.history.push(this.createHistoryEntry())
      this.body = data.slice()
      this.bodyHeight = height
      this.lastFrame = data.slice()
      return true
    }

    const historyEntry = this.createHistoryEntry()
    let fixedTop = (this.fixedTopData?.length ?? 0) / (this.width * 4)
    let fixedBottom = (this.fixedBottomData?.length ?? 0) / (this.width * 4)
    // 完全相同的帧没有任何滚动信息，不能据此推断固定页眉页脚；否则整屏会被误判为页眉。
    if (!this.fixedTopData && !this.fixedBottomData &&
      !(rowsEqual(this.lastFrame, data, this.width, 0, 0) &&
        this.lastFrame.every((value, index) => value === data[index]))) {
      const detected = detectFixedRegions(this.lastFrame, data, this.width, height, {
        minFixedRows: this.options.minFixedRows
      })
      if (detected.top > 0 || detected.bottom > 0) {
        fixedTop = detected.top
        fixedBottom = detected.bottom
        this.fixedTopData = detected.top > 0
          ? sliceRows(this.body, this.width, 0, detected.top)
          : null
        this.fixedBottomData = detected.bottom > 0
          ? sliceRows(this.body, this.width, height - detected.bottom, height)
          : null
        this.body = sliceRows(this.body, this.width, detected.top, height - detected.bottom)
        this.bodyHeight = this.body.length / (this.width * 4)
      }
    }

    const previousBody = sliceRows(this.lastFrame, this.width, fixedTop, height - fixedBottom)
    const nextBody = sliceRows(data, this.width, fixedTop, height - fixedBottom)
    const match = locateScrollOffset(
      previousBody,
      nextBody,
      this.width,
      previousBody.length / (this.width * 4),
      this.options.minMatchRatio
    )
    this.lastFrame = data.slice()
    if (!match.confident || match.offset === 0) return false
    this.history.push(historyEntry)
    this.offset = match.offset

    if (match.offset > 0) {
      this.body = concatRows([this.body, sliceRows(nextBody, this.width, match.start, match.end)])
    } else {
      this.body = concatRows([sliceRows(nextBody, this.width, match.start, match.end), this.body])
    }
    this.bodyHeight = this.body.length / (this.width * 4)
    this.enforceMaxHeight(match.offset > 0)
    return true
  }

  /**
   * 撤销最近一次成功追加，并恢复对应的拼接状态。
   * @returns 是否执行了撤销。
   * @author zhenghq
   */
  undo(): boolean {
    const previous = this.history.pop()
    if (!previous) return false
    this.body = previous.body?.slice() ?? null
    this.bodyHeight = previous.bodyHeight
    this.fixedTopData = previous.fixedTopData?.slice() ?? null
    this.fixedBottomData = previous.fixedBottomData?.slice() ?? null
    this.lastFrame = previous.lastFrame?.slice() ?? null
    this.offset = previous.offset
    this.truncated = previous.truncated
    return true
  }

  /**
   * 创建当前拼接状态的不可变撤销快照。
   * @returns 当前拼接状态快照。
   * @author zhenghq
   */
  private createHistoryEntry(): LongCaptureHistoryEntry {
    return {
      body: this.body?.slice() ?? null,
      bodyHeight: this.bodyHeight,
      fixedTopData: this.fixedTopData?.slice() ?? null,
      fixedBottomData: this.fixedBottomData?.slice() ?? null,
      lastFrame: this.lastFrame?.slice() ?? null,
      offset: this.offset,
      truncated: this.truncated
    }
  }

  /**
   * 将拼接高度限制在最大输出高度内。
   * @param appendedDown 本次是否向下追加；用于决定优先保留哪一端。
   * @returns 无返回值。
   * @author zhenghq
   */
  private enforceMaxHeight(appendedDown: boolean): void {
    const totalHeight = this.height
    if (totalHeight < this.options.maxHeight) return
    this.truncated = true
    if (totalHeight <= this.options.maxHeight) return
    const fixedTop = (this.fixedTopData?.length ?? 0) / (this.width * 4)
    const fixedBottom = (this.fixedBottomData?.length ?? 0) / (this.width * 4)
    const allowedBody = Math.max(0, this.options.maxHeight - fixedTop - fixedBottom)
    const remove = this.bodyHeight - allowedBody
    if (remove <= 0 || !this.body) return
    this.body = appendedDown
      ? sliceRows(this.body, this.width, 0, allowedBody)
      : sliceRows(this.body, this.width, remove, this.bodyHeight)
    this.bodyHeight = this.body.length / (this.width * 4)
  }
}
