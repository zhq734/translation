import {
  createDocumentPdfRasterizerBundle,
  type DocumentPdfRasterizerDependencies,
  type PdfRasterCanvas,
  type PdfRasterContext,
  type PdfRasterImageData
} from './documentPdfRasterizer.ts'
import type { ParsePdfOptions, PdfObjectStore, PdfPage } from './documentPdfParser.ts'

/** PDF.js RGB 图片编码。 */
const PDF_IMAGE_KIND_RGB_24BPP = 2

/** PDF.js RGBA 图片编码。 */
const PDF_IMAGE_KIND_RGBA_32BPP = 3

/** PDF.js 解码后的图片对象最小结构。 */
export interface PdfEmbeddedImageObject {
  /** 像素宽度。 */
  width: number
  /** 像素高度。 */
  height: number
  /** PDF.js ImageKind 编码。 */
  kind?: number
  /** RGB、RGBA 或单色位图原始数据。 */
  data?: Uint8Array | Uint8ClampedArray
  /** 浏览器或原生运行时提供的已解码位图。 */
  bitmap?: unknown
}

/** 生产环境 PDF 栅格化函数集合。 */
export interface ProductionPdfRasterizer {
  /** 渲染整页供扫描页 OCR 使用。 */
  renderPageToImage: NonNullable<ParsePdfOptions['renderPageToImage']>
  /** 裁切页内图片区域供 OCR 使用。 */
  renderPageRegionToImage: NonNullable<ParsePdfOptions['renderPageRegionToImage']>
  /** 直接导出 PDF 内嵌图片对象，避免整页渲染缺陷破坏图片内容。 */
  renderEmbeddedImageToImage: NonNullable<ParsePdfOptions['renderEmbeddedImageToImage']>
}

/** 原生 Canvas 模块的最小结构。 */
interface NativeCanvasModule {
  /** 创建画布。 */
  createCanvas(width: number, height: number): PdfRasterCanvas
}

/** Path2D 补丁模块的最小结构。 */
interface Path2dPolyfillModule {
  /** 为 Node 全局对象补充 Path2D。 */
  polyfillPath2D(target: object): void
}

/** 已缓存的运行时能力。 */
interface PdfRuntimeCapabilities {
  /** 画布工厂。 */
  createCanvas(width: number, height: number): PdfRasterCanvas
}

let runtimePromise: Promise<PdfRuntimeCapabilities> | null = null

/**
 * 创建 PDF 渲染取消异常。
 * @returns 名称为 AbortError 的异常。
 * @author zhenghq
 */
function createRuntimeAbortError(): Error {
  const error = new Error('PDF image export was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * 判断取消信号是否已触发。
 * @param signal 可选取消信号。
 * @returns 是否已取消。
 * @author zhenghq
 */
function isRuntimeAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * 从 PDF.js 对象存储读取图片对象，并等待尚未完成的解码任务。
 * @param store PDF.js 对象存储。
 * @param objectId 图片对象标识。
 * @param signal 可选取消信号。
 * @returns 已解码图片对象。
 * @author zhenghq
 */
async function getPdfImageObject(
  store: PdfObjectStore | undefined,
  objectId: string,
  signal: AbortSignal | undefined
): Promise<PdfEmbeddedImageObject> {
  if (!store) throw new Error('PDF image object store is unavailable')
  if (isRuntimeAborted(signal)) throw createRuntimeAbortError()
  if (store.has?.(objectId)) {
    return store.get(objectId) as PdfEmbeddedImageObject
  }
  return new Promise<PdfEmbeddedImageObject>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(createRuntimeAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    store.get(objectId, (value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(value as PdfEmbeddedImageObject)
    })
  })
}

/**
 * 将 PDF.js 图片对象转换为 RGBA ImageData。
 * @param image 已解码图片对象。
 * @param context 目标画布上下文。
 * @returns 可直接写入画布的 RGBA 像素。
 * @author zhenghq
 */
function createPdfImageData(
  image: PdfEmbeddedImageObject,
  context: PdfRasterContext
): PdfRasterImageData {
  if (!context.createImageData || !context.putImageData) {
    throw new Error('PDF canvas does not support raw image data')
  }
  const imageData = context.createImageData(image.width, image.height)
  const source = image.data
  if (!source) throw new Error('PDF image pixel data is unavailable')
  const expectedRgbaLength = image.width * image.height * 4
  if (image.kind === PDF_IMAGE_KIND_RGBA_32BPP) {
    if (source.byteLength < expectedRgbaLength) throw new Error('PDF RGBA image data is truncated')
    imageData.data.set(source.subarray(0, expectedRgbaLength))
    return imageData
  }
  if (image.kind === PDF_IMAGE_KIND_RGB_24BPP) {
    const expectedRgbLength = image.width * image.height * 3
    if (source.byteLength < expectedRgbLength) throw new Error('PDF RGB image data is truncated')
    let sourceOffset = 0
    let targetOffset = 0
    while (sourceOffset < expectedRgbLength) {
      imageData.data[targetOffset] = source[sourceOffset]!
      imageData.data[targetOffset + 1] = source[sourceOffset + 1]!
      imageData.data[targetOffset + 2] = source[sourceOffset + 2]!
      imageData.data[targetOffset + 3] = 255
      sourceOffset += 3
      targetOffset += 4
    }
    return imageData
  }
  throw new Error(`Unsupported PDF image kind: ${String(image.kind)}`)
}

/**
 * 创建 PDF 内嵌图片导出函数，直接使用 PDF.js 解码后的图片像素。
 * @param createCanvas 画布工厂。
 * @param signal 可选取消信号。
 * @returns PDF 解析器可使用的内嵌图片导出函数。
 * @author zhenghq
 */
export function createPdfEmbeddedImageExporter(
  createCanvas: (width: number, height: number) => PdfRasterCanvas,
  signal?: AbortSignal
): NonNullable<ParsePdfOptions['renderEmbeddedImageToImage']> {
  return async (page: PdfPage, _pageIndex: number, objectId: string): Promise<Uint8Array | null> => {
    if (isRuntimeAborted(signal)) throw createRuntimeAbortError()
    const store = objectId.startsWith('g_') ? page.commonObjs : page.objs
    const image = await getPdfImageObject(store, objectId, signal)
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width <= 0 || image.height <= 0) return null
    // PDF.js 的 1 位 ImageMask 只有透明度语义，不能按不透明黑白位图导出，
    // 否则页面中大量掩码会被渲染成黑块；这类图片交由整页区域裁切回退。
    if (image.kind === 1) return null
    if (isRuntimeAborted(signal)) throw createRuntimeAbortError()
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    if (image.bitmap) {
      context.drawImage(image.bitmap, 0, 0, image.width, image.height, 0, 0, image.width, image.height)
    } else {
      const imageData = createPdfImageData(image, context)
      context.putImageData?.(imageData, 0, 0)
    }
    if (isRuntimeAborted(signal)) throw createRuntimeAbortError()
    const png = canvas.toBuffer('image/png')
    return png instanceof Uint8Array ? png : new Uint8Array(png)
  }
}

/**
 * 动态加载原生 Canvas，并为 PDF.js 补充 Path2D。
 * @returns 可创建画布的运行时能力。
 * @author zhenghq
 */
async function loadPdfRuntime(): Promise<PdfRuntimeCapabilities> {
  const canvasModule = await import('canvas') as unknown as NativeCanvasModule
  if (typeof canvasModule.createCanvas !== 'function') {
    throw new Error('PDF canvas runtime is unavailable')
  }
  try {
    const polyfillModule = await import('path2d-polyfill') as unknown as Path2dPolyfillModule
    polyfillModule.polyfillPath2D(globalThis)
  } catch {
    // Path2D 只影响包含矢量路径的页面；缺失时仍允许基础文本与图片页面渲染。
  }
  return { createCanvas: (width, height) => canvasModule.createCanvas(width, height) }
}

/**
 * 取得已缓存的 PDF 原生运行时，避免每个页面重复加载模块。
 * @returns 运行时能力。
 * @author zhenghq
 */
function getPdfRuntime(): Promise<PdfRuntimeCapabilities> {
  runtimePromise ??= loadPdfRuntime()
  return runtimePromise
}

/**
 * 创建生产环境 PDF 栅格化适配器；原生模块只在首次处理 PDF 时加载。
 * @param signal 可选任务取消信号。
 * @param dependencies 可选测试替换项。
 * @returns PDF 解析器可使用的整页与区域栅格化函数。
 * @author zhenghq
 */
export async function createProductionPdfRasterizer(
  signal?: AbortSignal,
  dependencies: Partial<DocumentPdfRasterizerDependencies> = {}
): Promise<ProductionPdfRasterizer> {
  const runtime = dependencies.createCanvas
    ? { createCanvas: dependencies.createCanvas }
    : await getPdfRuntime()
  const rasterizer = createDocumentPdfRasterizerBundle({
    ...dependencies,
    createCanvas: runtime.createCanvas,
    ...(signal ? { signal } : {})
  })
  return {
    renderPageToImage: rasterizer.renderPage,
    renderPageRegionToImage: rasterizer.renderRegion,
    renderEmbeddedImageToImage: createPdfEmbeddedImageExporter(runtime.createCanvas, signal)
  }
}

/**
 * 清除已缓存的 PDF 运行时，供测试或运行时升级后重新探测能力。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetProductionPdfRuntime(): void {
  runtimePromise = null
}
