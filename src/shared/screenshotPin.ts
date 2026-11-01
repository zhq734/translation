/** 贴图实例数量上限。 */
export const MAX_SCREENSHOT_PINS = 20
/** 贴图最小缩放倍率。 */
const MIN_PIN_SCALE = 0.1
/** 贴图最大缩放倍率。 */
const MAX_PIN_SCALE = 8
/** 贴图最小透明度。 */
const MIN_PIN_OPACITY = 0.05
/** 贴图最大透明度。 */
const MAX_PIN_OPACITY = 1
/** 拖动时至少保留在工作区内的可抓取边长。 */
const MIN_VISIBLE_EDGE = 48

/** 屏幕矩形。 */
export interface PinBounds {
  /** 左上角 x。 */
  x: number
  /** 左上角 y。 */
  y: number
  /** 宽度。 */
  width: number
  /** 高度。 */
  height: number
}

/** 图像尺寸。 */
export interface PinSize {
  /** 图像宽度。 */
  width: number
  /** 图像高度。 */
  height: number
}

/** 贴图首次显示时的窗口尺寸与实际缩放倍率。 */
export interface PinInitialView {
  /** 窗口逻辑宽度。 */
  width: number
  /** 窗口逻辑高度。 */
  height: number
  /** 当前窗口逻辑尺寸相对 PNG 物理像素的缩放倍率。 */
  scale: number
}

/**
 * 将贴图缩放倍率限制在可用范围内。
 * @param scale 原始缩放倍率。
 * @returns 限制后的倍率。
 * @author zhenghq
 */
export function clampPinScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.max(MIN_PIN_SCALE, Math.min(MAX_PIN_SCALE, scale))
}

/**
 * 将贴图透明度限制在可用范围内。
 * @param opacity 原始透明度。
 * @returns 限制后的透明度。
 * @author zhenghq
 */
export function clampPinOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1
  return Math.max(MIN_PIN_OPACITY, Math.min(MAX_PIN_OPACITY, opacity))
}

/**
 * 计算贴图初次显示时相对原图的缩放倍率。
 * @param imageSize 原图尺寸。
 * @param workArea 目标显示器工作区。
 * @returns 不超过 1 的等比适配倍率。
 * @author zhenghq
 */
export function fitPinScale(imageSize: PinSize, workArea: PinSize): number {
  const imageWidth = Math.max(1, imageSize.width)
  const imageHeight = Math.max(1, imageSize.height)
  const maxWidth = Math.max(1, workArea.width)
  const maxHeight = Math.max(1, workArea.height)
  return Math.min(1, maxWidth / imageWidth, maxHeight / imageHeight)
}

/**
 * 将贴图图像等比缩放并居中到工作区。
 * @param imageBounds 原图尺寸；仅使用宽高。
 * @param workArea 目标显示器工作区。
 * @returns 适配后的窗口边界。
 * @author zhenghq
 */
export function fitPinBounds(imageBounds: PinBounds, workArea: PinBounds): PinBounds {
  const imageWidth = Math.max(1, imageBounds.width)
  const imageHeight = Math.max(1, imageBounds.height)
  const scale = fitPinScale(imageBounds, workArea)
  const width = Math.max(1, Math.round(imageWidth * scale))
  const height = Math.max(1, Math.round(imageHeight * scale))
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  }
}

/**
 * 按截图选区逻辑尺寸计算贴图初始窗口，避免 Retina 物理像素把图片放大。
 * @param pixelSize PNG 物理像素尺寸。
 * @param displaySize 截图选区逻辑尺寸。
 * @param workArea 目标显示器工作区。
 * @returns 首次显示尺寸以及相对 PNG 像素的缩放倍率。
 * @author zhenghq
 */
export function computePinInitialView(
  pixelSize: PinSize,
  displaySize: PinSize,
  workArea: PinSize
): PinInitialView {
  const logicalWidth = Math.max(1, displaySize.width)
  const logicalHeight = Math.max(1, displaySize.height)
  const fitScale = fitPinScale({ width: logicalWidth, height: logicalHeight }, workArea)
  const width = Math.max(1, Math.round(logicalWidth * fitScale))
  const height = Math.max(1, Math.round(logicalHeight * fitScale))
  const scaleX = width / Math.max(1, pixelSize.width)
  const scaleY = height / Math.max(1, pixelSize.height)
  return {
    width,
    height,
    scale: clampPinScale((scaleX + scaleY) / 2)
  }
}

/**
 * 将拖动后的贴图位置限制在工作区内，至少保留可抓取区域。
 * @param bounds 拖动后的窗口边界。
 * @param workArea 目标显示器工作区。
 * @returns 修正后的窗口边界。
 * @author zhenghq
 */
export function clampPinBounds(bounds: PinBounds, workArea: PinBounds): PinBounds {
  const visibleX = Math.min(MIN_VISIBLE_EDGE, bounds.width)
  const visibleY = Math.min(MIN_VISIBLE_EDGE, bounds.height)
  const minX = workArea.x - bounds.width + visibleX
  const maxX = workArea.x + workArea.width - visibleX
  const minY = workArea.y - bounds.height + visibleY
  const maxY = workArea.y + workArea.height - visibleY
  return {
    x: Math.max(minX, Math.min(maxX, bounds.x)),
    y: Math.max(minY, Math.min(maxY, bounds.y)),
    width: bounds.width,
    height: bounds.height
  }
}
