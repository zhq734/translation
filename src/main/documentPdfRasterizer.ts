import type { DocumentBoundingBox } from '../shared/documentTypes.ts'

/** PDF 扫描页栅格化使用的默认渲染比例。 */
export const DOCUMENT_PDF_RENDER_SCALE = 2

/** 单页允许渲染的最大像素数，默认覆盖 A4 300 DPI 并限制内存峰值。 */
export const DOCUMENT_PDF_MAX_RENDER_PIXELS = 20_000_000

/** PDF 页面视口的最小结构。 */
export interface PdfRasterViewport {
  /** 视口宽度。 */
  width: number
  /** 视口高度。 */
  height: number
}

/** PDF 页面栅格化所需的最小接口。 */
export interface PdfRasterPage {
  /** 获取指定比例的页面视口。 */
  getViewport(options: { scale: number }): PdfRasterViewport
  /** 开始渲染页面。 */
  render(options: {
    canvasContext: unknown
    viewport: PdfRasterViewport
    background?: string
  }): {
    /** 渲染完成 Promise。 */
    promise: Promise<void>
    /** 取消渲染。 */
    cancel(): void
  }
}

/** 最小画布接口，便于测试替换原生 Canvas。 */
export interface PdfRasterCanvas {
  /** 画布宽度。 */
  width: number
  /** 画布高度。 */
  height: number
  /** 取得二维绘图上下文。 */
  getContext(type: '2d'): PdfRasterContext
  /** 编码为 PNG。 */
  toBuffer(type: 'image/png'): Uint8Array
}

/** 栅格化所需的二维上下文最小结构。 */
export interface PdfRasterContext {
  /** 创建用于写入原始像素的 ImageData。 */
  createImageData?(width: number, height: number): PdfRasterImageData
  /** 将原始 RGBA 像素写入画布。 */
  putImageData?(imageData: PdfRasterImageData, x: number, y: number): void
  /** 将源画布指定区域绘制到目标区域。 */
  drawImage(
    image: unknown,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number
  ): void
}

/** 画布 ImageData 的最小结构。 */
export interface PdfRasterImageData {
  /** 像素宽度。 */
  width: number
  /** 像素高度。 */
  height: number
  /** RGBA 像素数据。 */
  data: Uint8ClampedArray
}

/** PDF 栅格化器依赖。 */
export interface DocumentPdfRasterizerDependencies {
  /** 创建指定尺寸的画布。 */
  createCanvas(width: number, height: number): PdfRasterCanvas
  /** 可选的渲染比例。 */
  scale?: number
  /** 可选的单页像素上限。 */
  maxPixels?: number
  /** 可选取消信号。 */
  signal?: AbortSignal
}

/** PDF 整页与区域栅格化函数集合。 */
export interface DocumentPdfRasterizerBundle {
  /** 渲染完整页面并输出 PNG。 */
  renderPage(page: PdfRasterPage, pageIndex: number): Promise<Uint8Array | null>
  /** 复用整页渲染结果裁切指定区域并输出 PNG。 */
  renderRegion(
    page: PdfRasterPage,
    pageIndex: number,
    bbox: DocumentBoundingBox
  ): Promise<Uint8Array | null>
}

/**
 * 创建带取消语义的 AbortError。
 * @returns 取消异常。
 * @author zhenghq
 */
function createAbortError(): Error {
  const error = new Error('PDF rendering was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * 判断取消信号是否已触发。
 * @param signal 可选取消信号。
 * @returns 是否已取消。
 * @author zhenghq
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * 创建 PDF 页面栅格化函数，扫描页会输出 PNG 字节供 OCR 使用。
 * @param dependencies 画布工厂、渲染比例、像素上限与取消信号。
 * @returns 页面栅格化函数；超过安全像素上限时返回 null。
 * @author zhenghq
 */
export function createDocumentPdfRasterizer(
  dependencies: DocumentPdfRasterizerDependencies
): (page: PdfRasterPage, pageIndex: number) => Promise<Uint8Array | null> {
  return createDocumentPdfRasterizerBundle(dependencies).renderPage
}

/**
 * 创建共享整页缓存的 PDF 栅格化器，供扫描页渲染和页内图片裁切复用。
 * @param dependencies 画布工厂、渲染比例、像素上限与取消信号。
 * @returns 整页与区域栅格化函数集合。
 * @author zhenghq
 */
export function createDocumentPdfRasterizerBundle(
  dependencies: DocumentPdfRasterizerDependencies
): DocumentPdfRasterizerBundle {
  const scale = Number.isFinite(dependencies.scale) && (dependencies.scale ?? 0) > 0
    ? dependencies.scale!
    : DOCUMENT_PDF_RENDER_SCALE
  const maxPixels = Number.isFinite(dependencies.maxPixels) && (dependencies.maxPixels ?? 0) > 0
    ? Math.floor(dependencies.maxPixels!)
    : DOCUMENT_PDF_MAX_RENDER_PIXELS
  let cachedPageIndex = -1
  let cachedPage: PdfRasterPage | null = null
  let cachedCanvas: PdfRasterCanvas | null = null
  let cachedPng: Uint8Array | null = null
  let pendingPageIndex = -1
  let pendingPage: PdfRasterPage | null = null
  let pendingRender: Promise<PdfRasterCanvas | null> | null = null

  /**
   * 释放不再需要的整页画布，降低连续处理多页时的内存峰值。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearCache = (): void => {
    cachedPageIndex = -1
    cachedPage = null
    cachedCanvas = null
    cachedPng = null
  }

  /**
   * 渲染并缓存单页画布；同一页的多个图片区域只触发一次 PDF 渲染。
   * @param page PDF 页面。
   * @param pageIndex 页面索引。
   * @returns 整页画布；超过像素上限时返回 null。
   * @author zhenghq
   */
  const getPageCanvas = async (page: PdfRasterPage, pageIndex: number): Promise<PdfRasterCanvas | null> => {
    if (isAborted(dependencies.signal)) throw createAbortError()
    if (cachedPage === page && cachedPageIndex === pageIndex) return cachedCanvas
    if (pendingRender && pendingPage === page && pendingPageIndex === pageIndex) {
      return pendingRender
    }
    clearCache()
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > maxPixels) {
      return null
    }
    pendingPage = page
    pendingPageIndex = pageIndex
    pendingRender = (async (): Promise<PdfRasterCanvas | null> => {
      const canvas = dependencies.createCanvas(width, height)
      const context = canvas.getContext('2d')
      let renderTask: ReturnType<PdfRasterPage['render']> | null = null
      const abortCleanup: Array<() => void> = []
      try {
        if (isAborted(dependencies.signal)) throw createAbortError()
        renderTask = page.render({ canvasContext: context, viewport, background: 'white' })
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (!dependencies.signal) return
          const onAbort = (): void => {
            renderTask?.cancel()
            reject(createAbortError())
          }
          dependencies.signal.addEventListener('abort', onAbort, { once: true })
          abortCleanup.push((): void => {
            dependencies.signal?.removeEventListener('abort', onAbort)
          })
        })
        await Promise.race([renderTask.promise, abortPromise])
        if (isAborted(dependencies.signal)) throw createAbortError()
        cachedPage = page
        cachedPageIndex = pageIndex
        cachedCanvas = canvas
        return canvas
      } finally {
        for (const cleanup of abortCleanup) cleanup()
        if (isAborted(dependencies.signal)) renderTask?.cancel()
        pendingPage = null
        pendingPageIndex = -1
        pendingRender = null
      }
    })()
    return pendingRender
  }

  /**
   * 输出整页 PNG，并缓存编码结果避免重复转换。
   * @param page PDF 页面。
   * @param pageIndex 页面索引。
   * @returns PNG 字节；超过像素上限时返回 null。
   * @author zhenghq
   */
  const renderPage = async (page: PdfRasterPage, pageIndex: number): Promise<Uint8Array | null> => {
    const canvas = await getPageCanvas(page, pageIndex)
    if (!canvas) return null
    if (cachedPng) return cachedPng
    const png = canvas.toBuffer('image/png')
    const bytes = png instanceof Uint8Array ? png : new Uint8Array(png)
    cachedPng = bytes
    return bytes
  }

  /**
   * 按页面点坐标裁切整页 PNG；区域超出页面时先裁剪到有效范围。
   * @param page PDF 页面。
   * @param pageIndex 页面索引。
   * @param bbox 页面视图坐标中的图片区域。
   * @returns 裁切后的 PNG 字节；无有效区域时返回 null。
   * @author zhenghq
   */
  const renderRegion = async (
    page: PdfRasterPage,
    pageIndex: number,
    bbox: DocumentBoundingBox
  ): Promise<Uint8Array | null> => {
    if (isAborted(dependencies.signal)) throw createAbortError()
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) ||
      !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height) ||
      bbox.width <= 0 || bbox.height <= 0) return null
    const unscaledViewport = page.getViewport({ scale: 1 })
    const left = Math.max(0, Math.min(unscaledViewport.width, bbox.x))
    const top = Math.max(0, Math.min(unscaledViewport.height, bbox.y))
    const right = Math.max(0, Math.min(unscaledViewport.width, bbox.x + bbox.width))
    const bottom = Math.max(0, Math.min(unscaledViewport.height, bbox.y + bbox.height))
    if (right <= left || bottom <= top) return null
    const canvas = await getPageCanvas(page, pageIndex)
    if (!canvas) return null
    if (isAborted(dependencies.signal)) throw createAbortError()
    const sourceX = Math.max(0, Math.floor(left * scale))
    const sourceY = Math.max(0, Math.floor(top * scale))
    const sourceRight = Math.min(canvas.width, Math.ceil(right * scale))
    const sourceBottom = Math.min(canvas.height, Math.ceil(bottom * scale))
    const width = sourceRight - sourceX
    const height = sourceBottom - sourceY
    if (width <= 0 || height <= 0) return null
    const target = dependencies.createCanvas(width, height)
    const context = target.getContext('2d')
    context.drawImage(canvas, sourceX, sourceY, width, height, 0, 0, width, height)
    if (isAborted(dependencies.signal)) throw createAbortError()
    const png = target.toBuffer('image/png')
    return png instanceof Uint8Array ? png : new Uint8Array(png)
  }

  return { renderPage, renderRegion }
}
