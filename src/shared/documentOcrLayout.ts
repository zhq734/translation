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
