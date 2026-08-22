import { cropRgba, resizeRgbaForOcr } from '../shared/imagePreprocess'
import { decodePng, encodePng } from './pngCodec'

/** 屏幕坐标矩形。 */
export interface CaptureBounds {
  /** 左上角 x（全局屏幕坐标）。 */
  x: number
  /** 左上角 y（全局屏幕坐标）。 */
  y: number
  /** 宽度。 */
  width: number
  /** 高度。 */
  height: number
}

/** 显示器信息（与 Electron screen 模块结构对齐，便于注入测试）。 */
export interface DisplayInfo {
  /** 显示器 id。 */
  id: number
  /** 显示器在全局屏幕中的位置与尺寸。 */
  bounds: CaptureBounds
  /** 显示器缩放因子。 */
  scaleFactor: number
}

/** 采集缩略图最小结构（Electron NativeImage 结构兼容）。 */
export interface CaptureThumbnail {
  /** 是否为空图。 */
  isEmpty(): boolean
  /** 导出 PNG 字节。 */
  toPNG(): Buffer
}

/** desktopCapturer 返回的屏幕源。 */
export interface ScreenSource {
  /** 所属显示器 id（字符串或数字）。 */
  display_id?: string | number
  /** 屏幕缩略图。 */
  thumbnail: CaptureThumbnail
}

/** 屏幕采集可注入依赖，默认由 Electron 提供。 */
export interface ScreenCaptureDeps {
  /** 获取屏幕源列表。 */
  getSources(options: {
    types: string[]
    thumbnailSize: { width: number; height: number }
  }): Promise<ScreenSource[]>
  /** 按坐标查找最近显示器。 */
  getDisplayNearestPoint(point: { x: number; y: number }): DisplayInfo | null
  /** 获取主显示器。 */
  getPrimaryDisplay(): DisplayInfo
  /** 当前运行平台，用于权限错误分类。 */
  platform?: NodeJS.Platform
}

/** 屏幕采集错误分类。 */
export type ScreenCaptureCode = 'permission' | 'out-of-bounds' | 'no-source'

/** 屏幕采集错误，携带细分错误码。 */
export class ScreenCaptureError extends Error {
  /** 错误分类码。 */
  readonly code: ScreenCaptureCode

  /**
   * 创建屏幕采集错误。
   * @param code 错误分类码。
   * @param message 面向用户的描述。
   * @author zhenghq
   */
  constructor(code: ScreenCaptureCode, message: string) {
    super(message)
    this.name = 'ScreenCaptureError'
    this.code = code
  }
}

/** 屏幕采集结果。 */
export interface ScreenCaptureResult {
  /** 选区截图 PNG 字节（已按设置放大）。 */
  png: Buffer
  /** 裁剪后、放大前的尺寸（图像像素）。 */
  sourceSize: { width: number; height: number }
  /** 放大后的尺寸（图像像素）。 */
  ocrSize: { width: number; height: number }
  /** 实际使用的显示器 id。 */
  displayId: number
}

/**
 * 计算两个矩形的交集。
 * @param a 矩形 a。
 * @param b 矩形 b。
 * @returns 交集矩形；不相交时宽高为 0。
 * @author zhenghq
 */
export function intersectBounds(a: CaptureBounds, b: CaptureBounds): CaptureBounds {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1)
  }
}

/**
 * 按选区中心点选择所属显示器，找不到时回退主显示器。
 * @param bounds 选区矩形（全局屏幕坐标）。
 * @param deps 屏幕依赖。
 * @returns 选区所属显示器。
 * @author zhenghq
 */
export function getDisplayForBounds(bounds: CaptureBounds, deps: ScreenCaptureDeps): DisplayInfo {
  const point = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  }
  return deps.getDisplayNearestPoint(point) || deps.getPrimaryDisplay()
}

/**
 * 将选区矩形换算为缩略图像素坐标的裁剪矩形，
 * 按缩略图与显示器的实际比例对齐并夹取到图像边界内。
 * @param bounds 选区矩形（全局屏幕坐标）。
 * @param displayBounds 显示器矩形（全局屏幕坐标）。
 * @param imageWidth 缩略图实际宽度（像素）。
 * @param imageHeight 缩略图实际高度（像素）。
 * @returns 裁剪矩形（缩略图像素坐标）。
 * @author zhenghq
 */
export function computeCropRect(
  bounds: CaptureBounds,
  displayBounds: CaptureBounds,
  imageWidth: number,
  imageHeight: number
): CaptureBounds {
  const clipped = intersectBounds(bounds, displayBounds)
  if (clipped.width < 4 || clipped.height < 4) {
    throw new ScreenCaptureError('out-of-bounds', '选区不在当前屏幕内')
  }
  const scaleX = displayBounds.width > 0 ? imageWidth / displayBounds.width : 1
  const scaleY = displayBounds.height > 0 ? imageHeight / displayBounds.height : 1
  const rect = {
    x: Math.max(0, Math.round((clipped.x - displayBounds.x) * scaleX)),
    y: Math.max(0, Math.round((clipped.y - displayBounds.y) * scaleY)),
    width: Math.max(1, Math.round(clipped.width * scaleX)),
    height: Math.max(1, Math.round(clipped.height * scaleY))
  }
  rect.width = Math.min(rect.width, imageWidth - rect.x)
  rect.height = Math.min(rect.height, imageHeight - rect.y)
  return rect
}

/**
 * 从屏幕源列表中挑选目标显示器对应的源；
 * 优先按 display_id 匹配，其次取首个非空缩略图。
 * @param sources 屏幕源列表。
 * @param displayId 目标显示器 id。
 * @returns 匹配的屏幕源；无可用源时返回 null。
 * @author zhenghq
 */
export function pickDisplaySource(sources: ScreenSource[], displayId: number): ScreenSource | null {
  const byId = sources.find((source) => String(source.display_id ?? '') === String(displayId))
  if (byId) return byId
  const nonEmpty = sources.find((source) => source.thumbnail && !source.thumbnail.isEmpty())
  return nonEmpty ?? sources[0] ?? null
}

/**
 * 采集屏幕选区为 PNG：获取显示器缩略图、按缩放对齐裁剪、可选放大。
 * macOS 上缩略图为空通常表示缺少屏幕录制权限（TCC），会归类为 permission 错误。
 * @param bounds 选区矩形（全局屏幕坐标）。
 * @param options 采集选项。
 * @param options.ocrScale OCR 前放大倍率，默认 1。
 * @param deps 屏幕采集依赖（测试可注入）。
 * @returns 采集结果，含 PNG 字节与尺寸信息。
 * @author zhenghq
 */
export async function captureRegionAsPng(
  bounds: CaptureBounds,
  options: { ocrScale?: number } = {},
  deps: ScreenCaptureDeps
): Promise<ScreenCaptureResult> {
  const display = getDisplayForBounds(bounds, deps)
  const scaleFactor = display.scaleFactor || 1
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
  }
  const sources = await deps.getSources({ types: ['screen'], thumbnailSize })
  if (!sources.length) {
    throw new ScreenCaptureError(
      (deps.platform ?? process.platform) === 'darwin' ? 'permission' : 'no-source',
      '无法获取屏幕截图'
    )
  }
  const source = pickDisplaySource(sources, display.id)
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    const code: ScreenCaptureCode =
      (deps.platform ?? process.platform) === 'darwin' ? 'permission' : 'no-source'
    throw new ScreenCaptureError(code, code === 'permission' ? '需要屏幕录制权限' : '无法获取屏幕截图')
  }

  const fullImage = decodePng(source.thumbnail.toPNG())
  const cropRect = computeCropRect(bounds, display.bounds, fullImage.width, fullImage.height)
  const cropped = cropRgba(fullImage, cropRect)
  const scaled = resizeRgbaForOcr(cropped, options.ocrScale ?? 1)
  return {
    png: encodePng(scaled),
    sourceSize: { width: cropped.width, height: cropped.height },
    ocrSize: { width: scaled.width, height: scaled.height },
    displayId: display.id
  }
}
