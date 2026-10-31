import type { DocumentOcrRegion } from './documentTypes.ts'

/** OCR 译文统一使用的字号，界面预览与 PDF 导出必须保持一致。 */
export const DOCUMENT_OCR_UNIFORM_FONT_SIZE = 12

/** OCR 区域缺少原文字号时使用的兼容默认值，始终与统一字号一致。 */
export const DOCUMENT_OCR_FALLBACK_FONT_SIZE = DOCUMENT_OCR_UNIFORM_FONT_SIZE

/** OCR 区域历史最小字号；仅为兼容旧调用保留，不再参与字号计算。 */
export const DOCUMENT_OCR_MIN_FONT_SIZE = 6

/** OCR 区域历史最大字号；仅为兼容旧调用保留，不再参与字号计算。 */
export const DOCUMENT_OCR_MAX_FONT_SIZE = 72

/** OCR 译文行高相对字号的固定比例；界面预览和 PDF 导出必须共用。 */
export const DOCUMENT_OCR_LINE_HEIGHT_RATIO = 1.15

/** OCR 透明文字区域的最小归一化边长，确保边界浮点误差不会产生不可选中的零尺寸元素。 */
export const DOCUMENT_OCR_MIN_REGION_SIZE = 0.001

/** 图片内 OCR 区域的归一化矩形。 */
export interface DocumentOcrNormalizedBox {
  /** 区域左边界，范围 0 到 1。 */
  x: number
  /** 区域上边界，范围 0 到 1。 */
  y: number
  /** 区域宽度，范围大于 0 且不超过剩余边界。 */
  width: number
  /** 区域高度，范围大于 0 且不超过剩余边界。 */
  height: number
}

/** OCR 译文在图片覆盖层中的实际二维占位。 */
export interface DocumentOcrFlowRect {
  /** 左边界，单位与覆盖层一致。 */
  left: number
  /** 右边界，单位与覆盖层一致。 */
  right: number
  /** 上边界，单位与覆盖层一致。 */
  top: number
  /** 下边界，单位与覆盖层一致。 */
  bottom: number
}

/** 图片在原始 bbox 内按自然宽高比缩放后的居中内容框。 */
export interface DocumentImageContentBox {
  /** 内容框左边界，相对图片区块。 */
  x: number
  /** 内容框上边界，相对图片区块。 */
  y: number
  /** 内容框宽度。 */
  width: number
  /** 内容框高度。 */
  height: number
}

/** OCR 译文在图片内可使用的横向位置与宽度，单位均为归一化坐标。 */
export interface DocumentOcrTranslationHorizontalBounds {
  /** 译文左边界，范围 0 到 1。 */
  x: number
  /** 译文可用宽度，范围大于 0 且不超过图片剩余宽度。 */
  width: number
}

/**
 * 计算图片在目标边界内按原始宽高比等比缩放后的居中内容框。
 * @param naturalWidth 图片自然宽度。
 * @param naturalHeight 图片自然高度。
 * @param targetWidth 图片区块目标宽度。
 * @param targetHeight 图片区块目标高度。
 * @returns 等比内容框；图片尺寸无效时回退到完整目标边界。
 * @author zhenghq
 */
export function resolveDocumentImageContentBox(
  naturalWidth: number,
  naturalHeight: number,
  targetWidth: number,
  targetHeight: number
): DocumentImageContentBox {
  const safeTargetWidth = Number.isFinite(targetWidth) && targetWidth > 0 ? targetWidth : 1
  const safeTargetHeight = Number.isFinite(targetHeight) && targetHeight > 0 ? targetHeight : 1
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 || naturalHeight <= 0) {
    return { x: 0, y: 0, width: safeTargetWidth, height: safeTargetHeight }
  }
  const scale = Math.min(safeTargetWidth / naturalWidth, safeTargetHeight / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return {
    x: (safeTargetWidth - width) / 2,
    y: (safeTargetHeight - height) / 2,
    width,
    height
  }
}

/**
 * 将 OCR 区域坐标归一化到图片范围内，并保证透明文字层始终具有可命中尺寸。
 * @param bbox OCR 引擎返回的原始区域坐标。
 * @returns 可直接用于百分比定位的安全矩形。
 * @author zhenghq
 */
export function normalizeDocumentOcrRegionBox(
  bbox: DocumentOcrNormalizedBox
): DocumentOcrNormalizedBox {
  const maximumOrigin = 1 - DOCUMENT_OCR_MIN_REGION_SIZE
  const normalizeValue = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
  const x = normalizeValue(Number.isFinite(bbox.x)
    ? Math.max(0, Math.min(maximumOrigin, bbox.x))
    : 0)
  const y = normalizeValue(Number.isFinite(bbox.y)
    ? Math.max(0, Math.min(maximumOrigin, bbox.y))
    : 0)
  const availableWidth = Math.max(0, 1 - x)
  const availableHeight = Math.max(0, 1 - y)
  const rawWidth = Number.isFinite(bbox.width) ? Math.max(0, bbox.width) : 0
  const rawHeight = Number.isFinite(bbox.height) ? Math.max(0, bbox.height) : 0
  return {
    x,
    y,
    width: normalizeValue(Math.min(availableWidth, Math.max(DOCUMENT_OCR_MIN_REGION_SIZE, rawWidth))),
    height: normalizeValue(Math.min(availableHeight, Math.max(DOCUMENT_OCR_MIN_REGION_SIZE, rawHeight)))
  }
}

/**
 * 计算 OCR 遮罩和可见译文共用的安全覆盖框。
 * 两者必须使用完全相同的边界，避免遮罩仍覆盖原文时译文已扩展到相邻插图。
 * @param bbox OCR 引擎返回的原始区域坐标。
 * @returns 已收敛到图片范围内的统一覆盖矩形。
 * @author zhenghq
 */
export function resolveDocumentOcrOverlayBox(
  bbox: DocumentOcrNormalizedBox
): DocumentOcrNormalizedBox {
  return normalizeDocumentOcrRegionBox(bbox)
}

/**
 * 计算左对齐 OCR 译文的横向可用宽度。
 * 中文译文通常比英文原文更长，若继续沿用窄识别框会逐字折行并把后续区域不断下推；
 * 因此扩展到同一行右侧最近区域的起点，没有同行邻居时止于图片右边界。
 * 居中、右对齐译文必须保持原识别框宽度，否则会改变对齐基准。
 * @param region 当前 OCR 区域。
 * @param regions 图片内全部 OCR 区域，用于识别同一行右侧的内容。
 * @returns 归一化后的译文左边界与可用宽度。
 * @author zhenghq
 */
export function resolveDocumentOcrTranslationHorizontalBounds(
  region: DocumentOcrRegion,
  regions: readonly DocumentOcrRegion[]
): DocumentOcrTranslationHorizontalBounds {
  const box = normalizeDocumentOcrRegionBox(region.bbox)
  if (region.textAlign === 'center' || region.textAlign === 'right') {
    return { x: box.x, width: box.width }
  }

  const currentTop = box.y
  const currentBottom = box.y + box.height
  // 同一行不同识别框可能存在数像素的基线误差，允许半行高度且限制在图片高度的 0.6% 内。
  const rowTolerance = Math.min(0.006, Math.max(0.001, box.height / 2))
  let right = 1
  for (const candidate of regions) {
    if (candidate === region || candidate.regionId === region.regionId) continue
    const candidateBox = normalizeDocumentOcrRegionBox(candidate.bbox)
    if (candidateBox.x <= box.x + 0.000001) continue
    const candidateBottom = candidateBox.y + candidateBox.height
    const sharesRow = candidateBox.y <= currentBottom + rowTolerance &&
      candidateBottom >= currentTop - rowTolerance
    if (sharesRow) right = Math.min(right, candidateBox.x)
  }
  return {
    x: box.x,
    width: Math.round(Math.max(box.width, right - box.x) * 1_000_000) / 1_000_000
  }
}

/**
 * 计算 OCR 原识别框占扩宽译文框的宽度比例。
 * 可见译文元素会向右扩展以容纳中文，但白底只能覆盖原识别框；
 * CSS 渐变百分比相对译文元素自身宽度，因此不能直接使用图片归一化宽度。
 * @param sourceBox 已归一化的原 OCR 识别框。
 * @param horizontalBounds 译文元素实际使用的横向范围。
 * @returns 白底渐变终点相对译文元素宽度的比例，范围为 0 到 1。
 * @author zhenghq
 */
export function resolveDocumentOcrSourceWidthRatio(
  sourceBox: Pick<DocumentOcrNormalizedBox, 'width'>,
  horizontalBounds: Pick<DocumentOcrTranslationHorizontalBounds, 'width'>
): number {
  const sourceWidth = Number.isFinite(sourceBox.width) ? Math.max(0, sourceBox.width) : 0
  const elementWidth = Number.isFinite(horizontalBounds.width) ? horizontalBounds.width : 0
  if (elementWidth <= 0) return 1
  return Math.min(1, Math.max(0, sourceWidth / elementWidth))
}

/**
 * 计算 OCR 译文的最终顶部位置：优先保持原文坐标，只有横向相交且前序译文越过时才向下避让。
 * 该规则避免同一排的多个短区域被前一项的实际高度逐级推偏，同时保证长译文不会互相覆盖。
 * @param sourceTop 当前区域由 OCR 坐标换算出的原始顶部位置。
 * @param horizontalRange 当前区域的横向范围。
 * @param previousRegions 已完成排版的全部前序区域。
 * @param gap 需要避让时与前序区域之间保留的间距。
 * @returns 当前区域最终使用的顶部位置。
 * @author zhenghq
 */
export function resolveDocumentOcrRegionFlowTop(
  sourceTop: number,
  horizontalRange: Pick<DocumentOcrFlowRect, 'left' | 'right'>,
  previousRegions: readonly DocumentOcrFlowRect[],
  gap = 0
): number {
  const safeTop = Number.isFinite(sourceTop) ? Math.max(0, sourceTop) : 0
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0
  const left = Math.min(horizontalRange.left, horizontalRange.right)
  const right = Math.max(horizontalRange.left, horizontalRange.right)
  let top = safeTop
  for (const previous of previousRegions) {
    const previousLeft = Math.min(previous.left, previous.right)
    const previousRight = Math.max(previous.left, previous.right)
    // 横向完全错开的区域属于不同列，不能因为前一项译文变长而整体下移。
    if (right <= previousLeft || left >= previousRight) continue
    if (!Number.isFinite(previous.bottom)) continue
    top = Math.max(top, previous.bottom + safeGap)
  }
  return Math.round(top * 1000) / 1000
}

/** OCR 译文水平内边距上限，单位为页面点或预览逻辑像素。 */
const OCR_PADDING_X_LIMIT = 3

/** OCR 译文垂直内边距上限，单位为页面点或预览逻辑像素。 */
const OCR_PADDING_Y_LIMIT = 2

/**
 * 计算 OCR 区域译文使用的统一字号。
 * @param region OCR 区域。
 * @param imageHeight 图片原始高度，保留参数用于兼容调用方语义。
 * @returns 固定统一字号，不随区域原文字号或图片高度变化。
 * @author zhenghq
 */
export function resolveOcrRegionFontSize(
  region: DocumentOcrRegion,
  imageHeight: number
): number {
  // OCR 译文按整页统一字号排版，避免标题、表格和短文本因识别框高度不同而忽大忽小。
  void region
  void imageHeight
  return DOCUMENT_OCR_UNIFORM_FONT_SIZE
}

/**
 * 计算 OCR 区域译文行高。
 * @param fontSize 已解析的字号。
 * @returns 行高，单位为页面点或预览逻辑像素。
 * @author zhenghq
 */
export function resolveOcrRegionLineHeight(fontSize: number): number {
  return Math.max(1, fontSize) * DOCUMENT_OCR_LINE_HEIGHT_RATIO
}

/**
 * 计算 OCR 区域译文内边距。
 * @param imageWidth 图片原始宽度。
 * @param imageHeight 图片原始高度。
 * @param region OCR 区域。
 * @returns 横向和纵向内边距。
 * @author zhenghq
 */
export function resolveOcrRegionPadding(
  imageWidth: number,
  imageHeight: number,
  region: DocumentOcrRegion
): { x: number; y: number } {
  const normalized = normalizeDocumentOcrRegionBox(region.bbox)
  const normalizedWidth = normalized.width
  const normalizedHeight = normalized.height
  const regionWidth = Math.max(1, normalizedWidth * Math.max(1, imageWidth))
  const regionHeight = Math.max(1, normalizedHeight * Math.max(1, imageHeight))
  return {
    x: Math.min(OCR_PADDING_X_LIMIT, regionWidth / 8),
    y: Math.min(OCR_PADDING_Y_LIMIT, regionHeight / 8)
  }
}

/**
 * 计算当前 OCR 区域相对上一可见区域原始底边的纵向间距。
 * 只保留原文行间空白；译文实际高度变化交给流式布局处理。
 * @param region 当前 OCR 区域。
 * @param previousRegion 上一可见 OCR 区域。
 * @param imageHeight 图片原始高度。
 * @returns 区域间距，单位为页面点或预览逻辑像素。
 * @author zhenghq
 */
export function resolveOcrRegionGapBefore(
  region: DocumentOcrRegion,
  previousRegion: DocumentOcrRegion | undefined,
  imageHeight: number
): number {
  const height = Math.max(1, imageHeight)
  if (!previousRegion) {
    return Math.max(0, Math.min(1, region.bbox.y)) * height
  }
  const previousBottom = previousRegion.bbox.y + previousRegion.bbox.height
  // 归一化坐标可能产生 29.999999999999993 一类误差，统一保留三位小数让界面和 PDF 得到稳定值。
  return Math.round(Math.max(0, region.bbox.y - previousBottom) * height * 1000) / 1000
}
