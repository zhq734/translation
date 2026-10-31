import {
  enhanceRgbaForOcr,
  MAX_OCR_PIXELS,
  resizeRgbaForOcr
} from '../shared/imagePreprocess'
import { decodePng, encodePng } from './pngCodec'

/** 适度放大候选期望达到的像素数，约为 1MP。 */
export const OCR_FALLBACK_TARGET_PIXELS = 1000000
/** 放大候选相对原图必须达到的最小有效倍率。 */
export const OCR_FALLBACK_MIN_EFFECTIVE_SCALE = 1.15

/** OCR 自适应备用图片使用的唯一处理策略。 */
export type AdaptiveOcrFallbackStrategy = 'moderate-scale' | 'contrast-enhance'

/** OCR 自适应备用候选选择结果。 */
export interface AdaptiveOcrFallbackSelection {
  /** 选中的单一图片处理策略。 */
  strategy: AdaptiveOcrFallbackStrategy
  /** 经过 1～3 范围约束的用户最大尝试倍率。 */
  requestedScale: number
  /** 像素预算和目标像素共同约束后的实际倍率。 */
  actualScale: number
}

/** 已编码的 OCR 自适应备用图片及其策略信息。 */
export interface AdaptiveOcrFallbackImage extends AdaptiveOcrFallbackSelection {
  /** 从原始解码像素生成的 PNG 字节。 */
  imageBytes: Buffer
}

/**
 * 从 PNG 字节的 IHDR 数据块读取尺寸，不展开像素数据。
 * @param imageBytes PNG 图片字节。
 * @returns 图片尺寸；不是有效 PNG 时返回 null。
 * @author zhenghq
 */
function readPngDimensions(
  imageBytes: Uint8Array | Buffer
): { width: number; height: number } | null {
  if (imageBytes.byteLength < 24 ||
    imageBytes[0] !== 0x89 ||
    imageBytes[1] !== 0x50 ||
    imageBytes[2] !== 0x4e ||
    imageBytes[3] !== 0x47) {
    return null
  }
  const view = new DataView(
    imageBytes.buffer,
    imageBytes.byteOffset,
    imageBytes.byteLength
  )
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * 将用户倍率约束到兼容的 1～3 范围。
 * @param scale 用户设置的最大尝试倍率。
 * @returns 安全的最大尝试倍率。
 * @author zhenghq
 */
function normalizeOcrScale(scale: number): number {
  return Math.min(3, Math.max(1, Number(scale) || 1))
}

/**
 * 根据原图尺寸、目标像素、统一预算和配置上限选择唯一备用策略。
 * @param width 原始图片宽度。
 * @param height 原始图片高度。
 * @param maxScale 用户配置的最大尝试倍率。
 * @returns 确定性的备用候选策略及实际倍率。
 * @author zhenghq
 */
export function selectAdaptiveOcrFallback(
  width: number,
  height: number,
  maxScale: number
): AdaptiveOcrFallbackSelection {
  const requestedScale = normalizeOcrScale(maxScale)
  const sourcePixels = Math.max(0, width) * Math.max(0, height)
  if (sourcePixels <= 0 || sourcePixels >= OCR_FALLBACK_TARGET_PIXELS) {
    return { strategy: 'contrast-enhance', requestedScale, actualScale: 1 }
  }
  const targetScale = Math.sqrt(OCR_FALLBACK_TARGET_PIXELS / sourcePixels)
  const budgetScale = Math.sqrt(MAX_OCR_PIXELS / sourcePixels)
  const actualScale = Math.min(requestedScale, targetScale, budgetScale)
  if (actualScale < OCR_FALLBACK_MIN_EFFECTIVE_SCALE) {
    return { strategy: 'contrast-enhance', requestedScale, actualScale: 1 }
  }
  return { strategy: 'moderate-scale', requestedScale, actualScale }
}

/**
 * 从原始 PNG 生成固定 1× 且遵守统一像素预算的基线图片。
 * 解码失败时保留原字节，由 OCR 引擎沿用既有错误处理。
 * @param imageBytes 原始 PNG 图片字节。
 * @returns 1× 基线 PNG 字节。
 * @author zhenghq
 */
export function preprocessOcrBaselineImageBytes(
  imageBytes: Uint8Array | Buffer
): Buffer {
  return preprocessOcrImageBytes(imageBytes, 1)
}

/**
 * 从 PDF 扫描页原始 PNG 生成固定 1× 文档基线，不应用截图 OCR 的通用像素预算。
 * PDF 栅格化器已单独限制页面尺寸，二次降采样会显著破坏小字号 PaddleOCR 识别。
 * @param imageBytes 原始 PNG 图片字节。
 * @returns 保持原始栅格尺寸的基线 PNG 字节。
 * @author zhenghq
 */
export function preprocessDocumentOcrBaselineImageBytes(
  imageBytes: Uint8Array | Buffer
): Buffer {
  return Buffer.from(imageBytes)
}

/**
 * 从原始 PNG 的解码像素生成单一自适应备用图片。
 * 适度放大与 1× 对比度增强互斥，不会缩放已编码基线或叠加处理策略。
 * @param imageBytes 原始 PNG 图片字节。
 * @param maxScale 用户配置的最大尝试倍率。
 * @returns 备用 PNG 字节及实际采用的策略。
 * @throws 原图无法解码时抛出解码错误，由协调器隔离处理。
 * @author zhenghq
 */
export function createAdaptiveOcrFallbackImageBytes(
  imageBytes: Uint8Array | Buffer,
  maxScale: number
): AdaptiveOcrFallbackImage {
  const image = decodePng(imageBytes)
  const selection = selectAdaptiveOcrFallback(image.width, image.height, maxScale)
  const candidate = selection.strategy === 'moderate-scale'
    ? resizeRgbaForOcr(image, selection.actualScale)
    : enhanceRgbaForOcr(resizeRgbaForOcr(image, 1))
  return { ...selection, imageBytes: encodePng(candidate) }
}

/**
 * 从 PDF 扫描页原始 PNG 生成单一文档自适应备用图片。
 * 备用候选同样不应用截图 OCR 的通用像素预算，避免增强阶段再次缩小扫描页。
 * @param imageBytes 原始 PNG 图片字节。
 * @param maxScale 用户配置的最大尝试倍率。
 * @returns 备用 PNG 字节及实际采用的策略。
 * @throws 原图无法解码时抛出解码错误，由协调器隔离处理。
 * @author zhenghq
 */
export function createDocumentAdaptiveOcrFallbackImageBytes(
  imageBytes: Uint8Array | Buffer,
  maxScale: number
): AdaptiveOcrFallbackImage {
  const dimensions = readPngDimensions(imageBytes)
  const image = decodePng(imageBytes)
  const selection = selectAdaptiveOcrFallback(
    dimensions?.width ?? image.width,
    dimensions?.height ?? image.height,
    maxScale
  )
  const candidate = selection.strategy === 'moderate-scale'
    ? resizeRgbaForOcr(image, selection.actualScale)
    : enhanceRgbaForOcr(image)
  return { ...selection, imageBytes: encodePng(candidate) }
}

/**
 * 对 OCR 输入 PNG 字节做统一尺寸约束，避免超大截图或剪贴板图片直接进入 OCR 引擎。
 * 解码失败时返回原始字节，由后续引擎按自身错误处理。
 * @param imageBytes PNG 图片字节。
 * @param scale OCR 放大倍率。
 * @returns 预处理后的 PNG 字节。
 * @author zhenghq
 */
export function preprocessOcrImageBytes(imageBytes: Uint8Array | Buffer, scale: number): Buffer {
  try {
    const image = decodePng(imageBytes)
    const resized = resizeRgbaForOcr(image, scale)
    if (resized === image) return Buffer.from(imageBytes)
    return encodePng(resized)
  } catch {
    return Buffer.from(imageBytes)
  }
}
