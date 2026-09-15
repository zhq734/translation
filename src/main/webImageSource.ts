/**
 * 网页图片取图模块。
 *
 * 为页面图片 OCR 提供受控取图能力：优先通过阅读器独立 Session 请求图片地址，
 * 在跨域受限、内联资源、Canvas 或请求失败时回退到远程页面区域截图。
 * 取图过程受字节数、像素数与取消信号约束，失败时返回跳过结果而不抛错，
 * 保证单张图片的问题不会中断整页翻译。
 *
 * @author zhenghq
 */

import type { WebImageCandidate } from '../shared/webPageTranslation'
import { selectWebImageSourceStrategy } from '../shared/webImageOcr'

/** 取图失败原因。 */
export type WebImageFetchReason =
  | 'cancelled'
  | 'request-failed'
  | 'capture-failed'
  | 'too-large'

/** 取图结果。 */
export interface WebImageFetchResult {
  /** 是否成功取得图片字节。 */
  ok: boolean
  /** 实际使用的取图策略。 */
  strategy: 'session' | 'capture'
  /** 成功时的图片字节。 */
  bytes?: Buffer
  /** 失败时的跳过原因。 */
  reason?: WebImageFetchReason
}

/** 会话请求返回的图片响应。 */
export interface WebImageResponse {
  /** 图片字节。 */
  bytes: Buffer | Uint8Array
  /** 响应内容类型。 */
  contentType?: string
  /** 解码后的像素宽度。 */
  width?: number
  /** 解码后的像素高度。 */
  height?: number
}

/** 图片取图依赖，便于测试注入。 */
export interface WebImageSourceDeps {
  /**
   * 通过阅读器 Session 请求图片地址。
   * @param url 图片地址。
   * @param signal 取消信号。
   * @returns 图片响应。
   */
  requestImage(url: string, signal?: AbortSignal): Promise<WebImageResponse>
  /**
   * 对远程页面区域截图，矩形使用视口 DIP 坐标。
   * @param rect 视口内截取矩形。
   * @param signal 取消信号。
   * @returns 图片字节。
   */
  captureRegion(rect: { x: number; y: number; width: number; height: number }, signal?: AbortSignal): Promise<Buffer | Uint8Array>
  /** 单图最大字节数。 */
  maxBytes: number
  /** 单图最大像素数。 */
  maxPixels: number
  /**
   * 读取远程页面当前滚动位置与视口尺寸，用于把文档坐标换算为视口坐标。
   * 未提供时按无滚动处理。
   * @returns 滚动位置与视口尺寸。
   */
  resolveViewport?(): Promise<{ scrollX: number; scrollY: number; width: number; height: number }>
  /**
   * 将视口外候选滚动到可见区域。
   * @param rect 候选的文档坐标矩形。
   * @returns 是否滚动成功。
   */
  scrollIntoView?(rect: { x: number; y: number; width: number; height: number }): Promise<boolean>
  /**
   * 取图完成后恢复原始滚动位置。
   * @param scrollX 原始横向滚动位置。
   * @param scrollY 原始纵向滚动位置。
   * @returns 恢复完成后的 Promise。
   */
  restoreScroll?(scrollX: number, scrollY: number): Promise<void>
  /** 保留字段：截图矩形本身使用 DIP 坐标，无需按设备像素比换算。 */
  devicePixelRatio?: number
  /** 任务取消信号。 */
  signal?: AbortSignal
}

/** 图片取图器。 */
export interface WebImageSource {
  /**
   * 取得候选图片字节。
   * @param candidate 图片候选。
   * @returns 取图结果；失败时返回跳过原因而不抛错。
   */
  fetch(candidate: WebImageCandidate): Promise<WebImageFetchResult>
}

/**
 * 判断取消信号是否已触发。
 * @param signal 取消信号。
 * @returns 是否已取消。
 * @author zhenghq
 */
function isAborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
}

/** OCR 引擎可直接解码的位图内容类型；矢量图等需回退区域截图。 */
const RASTER_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif'
])

/**
 * 判断响应内容类型是否为 OCR 可直接解码的位图。
 *
 * 未声明内容类型时保持宽容（交由字节与尺寸校验决定），
 * 但 `image/svg+xml`、`text/*` 等矢量或非位图内容必须回退区域截图，
 * 否则 OCR 引擎会因无法解码而整张图片失败。
 *
 * @param contentType 响应内容类型。
 * @returns 是否可直接用于 OCR。
 * @author zhenghq
 */
function isRasterImageContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase()
  if (!normalized) return true
  return RASTER_IMAGE_CONTENT_TYPES.has(normalized)
}

/**
 * 判断响应是否为可用的图片字节。
 * @param response 会话请求响应。
 * @param maxBytes 单图最大字节数。
 * @param maxPixels 单图最大像素数。
 * @returns 是否通过校验。
 * @author zhenghq
 */
function isValidImageResponse(response: WebImageResponse, maxBytes: number, maxPixels: number): boolean {
  const bytes = response.bytes
  if (!bytes || bytes.length === 0) return false
  if (bytes.length > maxBytes) return false
  if (!isRasterImageContentType(response.contentType ?? '')) return false
  const width = Number(response.width) || 0
  const height = Number(response.height) || 0
  if (width > 0 && height > 0 && width * height > maxPixels) return false
  return true
}

/**
 * 创建图片取图器。
 * @param deps 取图依赖。
 * @returns 图片取图器。
 * @author zhenghq
 */
export function createWebImageSource(deps: WebImageSourceDeps): WebImageSource {
  const maxBytes = Math.max(1, Math.floor(deps.maxBytes))
  const maxPixels = Math.max(1, Math.floor(deps.maxPixels))

  /**
   * 归一化截取矩形，保证宽高至少为 1 DIP。
   * @param rect 文档或视口坐标矩形。
   * @returns 取整后的截图矩形。
   * @author zhenghq
   */
  const normalizeRect = (rect: WebImageCandidate['rect']): { x: number; y: number; width: number; height: number } => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  })

  /**
   * 判断矩形是否与视口存在可见交集。
   * @param rect 视口坐标矩形。
   * @param viewport 当前视口尺寸。
   * @returns 是否有可见交集。
   * @author zhenghq
   */
  const isWithinViewport = (
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number }
  ): boolean => rect.x < viewport.width && rect.y < viewport.height &&
    rect.x + rect.width > 0 && rect.y + rect.height > 0

  return {
    async fetch(candidate: WebImageCandidate): Promise<WebImageFetchResult> {
      const strategy = selectWebImageSourceStrategy(candidate)
      if (isAborted(deps.signal)) return { ok: false, strategy, reason: 'cancelled' }

      if (strategy === 'session' && candidate.src) {
        try {
          const response = await deps.requestImage(candidate.src, deps.signal)
          if (isAborted(deps.signal)) return { ok: false, strategy, reason: 'cancelled' }
          if (isValidImageResponse(response, maxBytes, maxPixels)) {
            return { ok: true, strategy, bytes: Buffer.from(response.bytes) }
          }
          if (response.bytes && response.bytes.length > maxBytes) {
            return { ok: false, strategy: 'capture', reason: 'too-large' }
          }
        } catch {
          // 请求失败统一回退区域截图，不向调用方抛错。
        }
      }

      if (isAborted(deps.signal)) return { ok: false, strategy: 'capture', reason: 'cancelled' }

      const originalViewport = deps.resolveViewport
        ? await deps.resolveViewport().catch(() => null)
        : null
      let viewportRect = normalizeRect(candidate.rect)
      let scrolled = false
      if (originalViewport) {
        viewportRect = {
          ...viewportRect,
          x: viewportRect.x - Math.round(originalViewport.scrollX),
          y: viewportRect.y - Math.round(originalViewport.scrollY)
        }
        if (!isWithinViewport(viewportRect, originalViewport)) {
          if (!deps.scrollIntoView) return { ok: false, strategy: 'capture', reason: 'capture-failed' }
          let scrolledOk = false
          try {
            scrolledOk = await deps.scrollIntoView(normalizeRect(candidate.rect))
          } catch {
            scrolledOk = false
          }
          if (!scrolledOk) return { ok: false, strategy: 'capture', reason: 'capture-failed' }
          scrolled = true
          const scrolledViewport = await deps.resolveViewport?.().catch(() => null) ?? null
          if (!scrolledViewport) return { ok: false, strategy: 'capture', reason: 'capture-failed' }
          viewportRect = {
            ...normalizeRect(candidate.rect),
            x: normalizeRect(candidate.rect).x - Math.round(scrolledViewport.scrollX),
            y: normalizeRect(candidate.rect).y - Math.round(scrolledViewport.scrollY)
          }
          if (!isWithinViewport(viewportRect, scrolledViewport)) {
            await deps.restoreScroll?.(originalViewport.scrollX, originalViewport.scrollY).catch(() => undefined)
            return { ok: false, strategy: 'capture', reason: 'capture-failed' }
          }
        }
      }

      try {
        const bytes = await deps.captureRegion(viewportRect, deps.signal)
        if (isAborted(deps.signal)) return { ok: false, strategy: 'capture', reason: 'cancelled' }
        if (!bytes || bytes.length === 0) return { ok: false, strategy: 'capture', reason: 'capture-failed' }
        if (bytes.length > maxBytes) return { ok: false, strategy: 'capture', reason: 'too-large' }
        return { ok: true, strategy: 'capture', bytes: Buffer.from(bytes) }
      } catch {
        return { ok: false, strategy: 'capture', reason: 'capture-failed' }
      } finally {
        if (scrolled && originalViewport) {
          await deps.restoreScroll?.(originalViewport.scrollX, originalViewport.scrollY).catch(() => undefined)
        }
      }
    }
  }
}
