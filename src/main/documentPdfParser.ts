import { createRequire } from 'node:module'
import type {
  DocumentAsset,
  DocumentBlock,
  DocumentBoundingBox,
  DocumentFormulaBlock,
  DocumentImageBlock,
  DocumentLineStyle,
  DocumentModel,
  DocumentPage,
  DocumentTableBlock,
  DocumentTableCell,
  DocumentTableRow,
  DocumentTextBlock,
  DocumentTextAlign,
  DocumentTextRun,
  DocumentTextStyle,
  DocumentWarning
} from '../shared/documentTypes.ts'
import { createDocumentBlockId, createDocumentPageId } from '../shared/documentTypes.ts'
import {
  DOCUMENT_MAX_PAGES,
  DOCUMENT_MAX_IMAGES,
  createDocumentModelId,
  createDocumentWarning,
  createTableCellId,
  createTableRowId,
  createTextRunId,
  hashDocumentBytes,
  sanitizeDocumentText,
  type DocumentParseInput
} from './documentParserShared.ts'

/** PDF.js 文本项的最小结构。 */
interface PdfTextItem {
  /** 文本内容。 */
  str: string
  /** 操作符列表中记录的实际填充色。 */
  color?: string
  /** 文本方向。 */
  dir?: string
  /** 文本变换矩阵。 */
  transform?: number[]
  /** 文本宽度。 */
  width?: number
  /** 文本高度。 */
  height?: number
  /** PDF.js 字体标识。 */
  fontName?: string
  /** 是否跟随换行。 */
  hasEOL?: boolean
}

/** PDF.js 文本样式。 */
interface PdfTextStyle {
  /** 字体族。 */
  fontFamily?: string
  /** PDF.js 文本项使用的字体键，用于从 styles 映射中查找样式。 */
  key?: string
  /** PDF.js 字体对象中的规范名称，用于识别粗体、斜体与实际字体。 */
  fontName?: string
  /** 字体是否粗体。 */
  bold?: boolean
  /** 字体是否斜体。 */
  italic?: boolean
  /** 字体上升高度。 */
  ascent?: number
  /** 字体下降高度。 */
  descent?: number
  /** 是否竖排。 */
  vertical?: boolean
  /** PDF.js 字体对象提供的标准字重。 */
  fontWeight?: number
}

/** PDF.js 文本内容。 */
interface PdfTextContent {
  /** 文本项。 */
  items: PdfTextItem[]
  /** 字体样式映射。 */
  styles?: Record<string, PdfTextStyle>
}

/** PDF.js 页面。 */
export interface PdfPage {
  /** 获取页面视口。 */
  getViewport(options: { scale: number }): {
    /** 视口宽度。 */
    width: number
    /** 视口高度。 */
    height: number
    /** 页面坐标到视口坐标的变换矩阵。 */
    transform?: number[]
  }
  /** 获取文本内容。 */
  getTextContent(): Promise<PdfTextContent>
  /** PDF.js 页面共享对象存储，用于读取已加载字体与共享图片对象。 */
  commonObjs?: PdfObjectStore
  /** PDF.js 页面局部对象存储，用于读取页内图片的原始像素。 */
  objs?: PdfObjectStore
  /** 获取操作符列表。 */
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  /** 开始渲染页面。 */
  render(options: {
    canvasContext: unknown
    viewport: { width: number; height: number }
    background?: string
  }): {
    /** 渲染完成 Promise。 */
    promise: Promise<void>
    /** 取消渲染。 */
    cancel(): void
  }
}

/** PDF.js 对象存储的最小接口。 */
export interface PdfObjectStore {
  /** 获取指定对象；尚未加载时可能抛错。 */
  get(name: string): unknown
  /** 以回调方式等待指定对象加载完成。 */
  get(name: string, callback: (value: unknown) => void): null
  /** 判断对象是否已经加载。 */
  has?(name: string): boolean
}

/** PDF.js 文档。 */
interface PdfDocument {
  /** 页数。 */
  numPages: number
  /** 获取指定页。 */
  getPage(pageNumber: number): Promise<PdfPage>
  /** 释放资源。 */
  destroy(): Promise<void>
}

/** PDF.js 运行时。 */
interface PdfJsRuntime {
  /** 打开文档。 */
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> }
  /** 操作符常量。 */
  OPS: Record<string, number>
}

/** PDF.js 缓存画布条目的最小结构。 */
export interface PdfCanvasEntry {
  /** 原生画布。 */
  canvas: {
    /** 画布宽度。 */
    width: number
    /** 画布高度。 */
    height: number
    /** 取得二维绘图上下文。 */
    getContext(type: '2d'): unknown
  }
  /** 画布二维上下文。 */
  context: unknown
}

/** 原生 Canvas 模块的最小结构。 */
interface PdfCanvasModule {
  /** 创建指定尺寸的原生画布。 */
  createCanvas(width: number, height: number): PdfCanvasEntry['canvas']
}

/**
 * 创建与 Canvas 3 兼容的 PDF.js 画布工厂。
 * @returns PDF.js 可复用的画布工厂。
 * @author zhenghq
 */
function createPdfCanvasFactory() {
  const require = createRequire(import.meta.url)
  return {
    /**
     * 创建画布及二维上下文。
     * @param width 画布宽度。
     * @param height 画布高度。
     * @returns PDF.js 画布条目。
     * @author zhenghq
     */
    create(width: number, height: number): PdfCanvasEntry {
      const canvasModule = require('canvas') as PdfCanvasModule
      const canvas = canvasModule.createCanvas(width, height)
      return { canvas, context: canvas.getContext('2d') }
    },
    /**
     * 复用画布并调整尺寸。
     * @param entry PDF.js 画布条目。
     * @param width 新宽度。
     * @param height 新高度。
     * @returns 无返回值。
     * @author zhenghq
     */
    reset(entry: PdfCanvasEntry, width: number, height: number): void {
      entry.canvas.width = width
      entry.canvas.height = height
    },
    /**
     * 释放画布尺寸与上下文引用。
     * @param entry PDF.js 画布条目。
     * @returns 无返回值。
     * @author zhenghq
     */
    destroy(entry: PdfCanvasEntry): void {
      entry.canvas.width = 0
      entry.canvas.height = 0
      entry.context = null
    }
  }
}

/** PDF 解析选项。 */
export interface ParsePdfOptions {
  /** 可注入的页面栅格化适配器；未提供时扫描页保留 renderPending。 */
  renderPageToImage?: (page: PdfPage, pageIndex: number) => Promise<Uint8Array | null>
  /** 可注入的页面区域裁切适配器，用于提取 PDF 内嵌图片。 */
  renderPageRegionToImage?: (
    page: PdfPage,
    pageIndex: number,
    bbox: DocumentBoundingBox
  ) => Promise<Uint8Array | null>
  /** 可注入的 PDF 内嵌图片对象导出适配器，优先于整页裁切。 */
  renderEmbeddedImageToImage?: (
    page: PdfPage,
    pageIndex: number,
    objectId: string
  ) => Promise<Uint8Array | null>
  /** 登记解析期生成的图片字节，供后续 OCR 读取。 */
  registerAssetBytes?: (assetId: string, bytes: Uint8Array) => void
  /** 取消 PDF 解析与页面栅格化。 */
  signal?: AbortSignal
}

/** 单行聚合后的文本片段。 */
interface PdfLine {
  /** 文本项。 */
  items: PdfTextItem[]
  /** 行边界。 */
  bbox: DocumentBoundingBox
  /** PDF 页面坐标系中的原始文本基线。 */
  baseline: number
}

/** 按语义段落聚合后的 PDF 文本片段。 */
interface PdfParagraph extends PdfLine {
  /** 段落内视觉行统一使用的行高。 */
  lineHeight?: number
  /** 段落是否位于已识别的代码框内。 */
  codeFrame?: boolean
  /** 段落所属代码框在候选列表中的索引。 */
  codeFrameIndex?: number
}

/** PDF 仿射变换矩阵，顺序与 Canvas 的 a、b、c、d、e、f 一致。 */
type PdfMatrix = [number, number, number, number, number, number]

/** 页面内嵌图片的裁切区域。 */
interface PdfEmbeddedImageRegion {
  /** 页面视图坐标。 */
  bbox: DocumentBoundingBox
  /** PDF.js 图片对象标识；内联图片没有可复用对象标识时省略。 */
  objectId?: string
}

/** 已识别表格及其原始网格，用于把内嵌图片定位到对应单元格。 */
interface PdfTableGridTarget {
  /** 表格区块。 */
  table: DocumentTableBlock
  /** 表格原始网格。 */
  grid: PdfDetectedGrid
}

/** 从 PDF 操作符重建出的水平或垂直线段，坐标为页面视图坐标。 */
interface PdfGridLine {
  /** 线段方向。 */
  orientation: 'horizontal' | 'vertical'
  /** 线段起点坐标。 */
  start: number
  /** 线段终点坐标。 */
  end: number
  /** 与线段方向垂直的位置。 */
  position: number
  /** 原始描边颜色。 */
  color?: string
  /** 原始线宽。 */
  thickness?: number
}

/** 由闭合矢量网格推导出的表格区域。 */
interface PdfDetectedGrid {
  /** 表格外边界。 */
  bbox: DocumentBoundingBox
  /** 去重并排序后的列边界。 */
  columns: number[]
  /** 去重并排序后的行边界。 */
  rows: number[]
}

/** PDF 内嵌图片的最小可见尺寸，单位为页面点。 */
const PDF_MIN_IMAGE_SIZE = 8

/** PDF 内嵌图片的最小可见面积，单位为平方页面点。 */
const PDF_MIN_IMAGE_AREA = 64

/** 可参与表格识别的网格线最短长度，单位为页面点。 */
const PDF_MIN_TABLE_LINE_LENGTH = 8

/** 由细长填充矩形还原边框线时允许的最小短边长度，单位为页面点。 */
const PDF_MIN_FILLED_LINE_THICKNESS = 0.5

/** 由细长填充矩形还原边框线时允许的最大短边长度，单位为页面点。 */
const PDF_MAX_FILLED_LINE_THICKNESS = 2

/** 网格线坐标合并与闭合判定的容差，单位为页面点。 */
const PDF_TABLE_LINE_TOLERANCE = 2

/** 表格网格的最小宽高，单位为页面点。 */
const PDF_MIN_TABLE_SIZE = 16

/** 接近整页的闭合边框占页面宽高的最小比例，此类边框不是表格。 */
const PDF_PAGE_FRAME_MIN_RATIO = 0.9

/** PDF 路径中识别轴对齐矩形所需的坐标容差，单位为页面点。 */
const PDF_PATH_GEOMETRY_TOLERANCE = 0.1

/**
 * 从闭合路径的顶点判断它是否为一个轴对齐矩形。
 * @param points 路径按绘制顺序记录的顶点。
 * @param closed 路径是否显式闭合。
 * @returns 矩形边界；不是单个轴对齐矩形时返回 undefined。
 * @author zhenghq
 */
function pdfAxisAlignedRectangle(
  points: readonly { x: number; y: number }[],
  closed: boolean
): { left: number; right: number; top: number; bottom: number } | undefined {
  if (!closed || points.length !== 4) return undefined
  const uniqueX = points.map((point) => point.x).filter((value, index, values) =>
    values.findIndex((candidate) => Math.abs(candidate - value) <= PDF_PATH_GEOMETRY_TOLERANCE) === index)
  const uniqueY = points.map((point) => point.y).filter((value, index, values) =>
    values.findIndex((candidate) => Math.abs(candidate - value) <= PDF_PATH_GEOMETRY_TOLERANCE) === index)
  if (uniqueX.length !== 2 || uniqueY.length !== 2) return undefined
  const left = Math.min(...uniqueX)
  const right = Math.max(...uniqueX)
  const top = Math.min(...uniqueY)
  const bottom = Math.max(...uniqueY)
  if (right - left <= PDF_PATH_GEOMETRY_TOLERANCE || bottom - top <= PDF_PATH_GEOMETRY_TOLERANCE) {
    return undefined
  }
  return { left, right, top, bottom }
}

/**
 * 将细长轴对齐填充矩形转换为一条网格线。
 * PDF 中约 0.72pt 的灰色矩形常被用作表格线或代码框边线；只接受单边长度
 * 符合阈值且另一方向足够长的矩形，避免把背景和单元格底色拆成四条边框。
 * @param rectangle 页面视图坐标中的矩形边界。
 * @param color 矩形填充色。
 * @returns 可渲染的网格线；矩形不符合细线条件时返回 undefined。
 * @author zhenghq
 */
function pdfFilledLineFromRectangle(
  rectangle: { left: number; right: number; top: number; bottom: number },
  color?: string
): PdfGridLine | undefined {
  const width = rectangle.right - rectangle.left
  const height = rectangle.bottom - rectangle.top
  const thickness = Math.min(width, height)
  const length = Math.max(width, height)
  if (thickness < PDF_MIN_FILLED_LINE_THICKNESS ||
    thickness > PDF_MAX_FILLED_LINE_THICKNESS ||
    length < PDF_MIN_TABLE_LINE_LENGTH) {
    return undefined
  }
  // 填充矩形的起始边才是 PDF 原始线条位置；使用中心点会让 0.72pt 线宽
  // 在连续坐标中累计 0.36pt 偏移，最终导致表格列宽和代码框位置变化。
  return width >= height
    ? {
        orientation: 'horizontal',
        start: rectangle.left,
        end: rectangle.right,
        position: rectangle.top,
        ...(color ? { color } : {}),
        thickness
      }
    : {
        orientation: 'vertical',
        start: rectangle.top,
        end: rectangle.bottom,
        position: rectangle.left,
        ...(color ? { color } : {}),
        thickness
      }
}

/**
 * 从 PNG 的 IHDR 数据块读取像素宽高，供 OCR 坐标与字号换算使用。
 * @param bytes 图片字节。
 * @returns PNG 像素尺寸；不是有效 PNG 时返回 null。
 * @author zhenghq
 */
function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * 创建 PDF 解析取消异常。
 * @returns 名称为 AbortError 的异常。
 * @author zhenghq
 */
function createPdfAbortError(): Error {
  const error = new Error('PDF parsing was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * 判断异常是否由任务取消触发。
 * @param error 捕获的异常。
 * @returns 是否为取消异常。
 * @author zhenghq
 */
function isPdfAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 动态加载 PDF.js，避免文档能力禁用时初始化 PDF 运行时。
 * @returns PDF.js 运行时。
 * @author zhenghq
 */
async function loadPdfJs(): Promise<PdfJsRuntime> {
  const [module, workerModule] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.js'),
    import('pdfjs-dist/legacy/build/pdf.worker.js')
  ])
  const runtime = (module.default ?? module) as unknown as PdfJsRuntime
  if (!runtime.getDocument || !runtime.OPS) throw new Error('PDF runtime is unavailable')
  // PDF.js 的 ESM 测试产物无法使用 fake worker 内部的动态 require；显式注册
  // worker 处理器后，主线程模式不再依赖打包器保留 CommonJS require 语义。
  ;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = workerModule.default ?? workerModule
  return runtime
}

/**
 * 将 PDF.js 变换矩阵中的字号转换为页面点单位。
 * @param transform 文本变换矩阵。
 * @param fallbackHeight 文本项高度。
 * @returns 正数字号。
 * @author zhenghq
 */
function fontSizeFromTransform(transform: number[] | undefined, fallbackHeight = 12): number {
  if (!transform) return Math.max(1, fallbackHeight)
  const scaleX = Math.hypot(transform[0] ?? 0, transform[1] ?? 0)
  const scaleY = Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
  return Math.max(1, scaleY || scaleX || fallbackHeight)
}

/**
 * 将 PDF 颜色通道值规范化为 0 到 255 的整数；兼容 0-1 与 0-255 两种输入。
 * @param value 原始通道值。
 * @returns 规范化后的颜色通道值。
 * @author zhenghq
 */
function normalizePdfColorChannel(value: number): number {
  const scaled = value <= 1 ? value * 255 : value
  return Math.max(0, Math.min(255, Math.round(scaled)))
}

/**
 * 将规范化通道转换为 CSS 十六进制颜色。
 * @param channels 三个 RGB 通道值。
 * @returns 小写十六进制颜色。
 * @author zhenghq
 */
function pdfRgbColor(channels: readonly number[]): string {
  return `#${channels.map((value) => normalizePdfColorChannel(value).toString(16).padStart(2, '0')).join('')}`
}

/**
 * 从操作符参数中递归提取数字颜色通道，忽略颜色空间名称等非数值参数。
 * @param args 操作符参数。
 * @returns 按原始顺序排列的有限数字数组。
 * @author zhenghq
 */
function pdfColorComponents(args: readonly unknown[]): number[] {
  const components: number[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      components.push(value)
      return
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      for (const item of Array.from(value as ArrayLike<unknown>)) visit(item)
    }
  }
  for (const arg of args) visit(arg)
  return components
}

/**
 * 将 PDF 填充色操作符参数转换为 CSS 颜色。
 * @param operation PDF.js 操作符编号。
 * @param args 操作符参数。
 * @param runtime PDF.js 运行时。
 * @returns 可识别的纯色；图案、渐变或无效参数返回 undefined。
 * @author zhenghq
 */
function pdfFillColorFromOperator(
  operation: number,
  args: readonly unknown[],
  runtime: PdfJsRuntime
): string | undefined {
  const components = pdfColorComponents(args)
  if (operation === runtime.OPS['setFillGray'] && components.length >= 1) {
    return pdfRgbColor([components[0]!, components[0]!, components[0]!])
  }
  if (operation === runtime.OPS['setFillRGBColor'] && components.length >= 3) {
    return pdfRgbColor(components.slice(0, 3))
  }
  if (operation === runtime.OPS['setFillCMYKColor'] && components.length >= 4) {
    const [cyan = 0, magenta = 0, yellow = 0, black = 0] = components
    return pdfRgbColor([
      (1 - cyan) * (1 - black),
      (1 - magenta) * (1 - black),
      (1 - yellow) * (1 - black)
    ])
  }
  if ((operation === runtime.OPS['setFillColor'] || operation === runtime.OPS['setFillColorN']) &&
    (components.length === 1 || components.length === 3 || components.length === 4)) {
    return components.length === 1
      ? pdfRgbColor([components[0]!, components[0]!, components[0]!])
      : pdfRgbColor(components.slice(0, 3))
  }
  return undefined
}

/**
 * 将 PDF 描边色操作符参数转换为 CSS 颜色。
 * @param operation PDF.js 操作符编号。
 * @param args 操作符参数。
 * @param runtime PDF.js 运行时。
 * @returns 可识别的纯色；图案或无效参数返回 undefined。
 * @author zhenghq
 */
function pdfStrokeColorFromOperator(
  operation: number,
  args: readonly unknown[],
  runtime: PdfJsRuntime
): string | undefined {
  const components = pdfColorComponents(args)
  if (operation === runtime.OPS['setStrokeGray'] && components.length >= 1) {
    return pdfRgbColor([components[0]!, components[0]!, components[0]!])
  }
  if (operation === runtime.OPS['setStrokeRGBColor'] && components.length >= 3) {
    return pdfRgbColor(components.slice(0, 3))
  }
  if (operation === runtime.OPS['setStrokeCMYKColor'] && components.length >= 4) {
    const [cyan = 0, magenta = 0, yellow = 0, black = 0] = components
    return pdfRgbColor([
      (1 - cyan) * (1 - black),
      (1 - magenta) * (1 - black),
      (1 - yellow) * (1 - black)
    ])
  }
  if ((operation === runtime.OPS['setStrokeColor'] || operation === runtime.OPS['setStrokeColorN']) &&
    (components.length === 1 || components.length === 3 || components.length === 4)) {
    return components.length === 1
      ? pdfRgbColor([components[0]!, components[0]!, components[0]!])
      : pdfRgbColor(components.slice(0, 3))
  }
  return undefined
}

/**
 * 按 PDF 绘制顺序提取每次文本显示操作对应的填充色。
 * @param operatorList PDF.js 页面操作符列表。
 * @param runtime PDF.js 运行时。
 * @returns 与 showText 类操作一一对应的颜色数组。
 * @author zhenghq
 */
function extractPdfTextColors(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  runtime: PdfJsRuntime
): Array<string | undefined> {
  const colors: Array<string | undefined> = []
  const colorStack: Array<string | undefined> = []
  let currentColor: string | undefined
  const saveOperation = runtime.OPS['save']
  const restoreOperation = runtime.OPS['restore']
  const showTextOperations = new Set([
    runtime.OPS['showText'],
    runtime.OPS['showSpacedText'],
    runtime.OPS['nextLineShowText'],
    runtime.OPS['nextLineSetSpacingShowText']
  ].filter((value): value is number => typeof value === 'number'))

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index]!
    const args = operatorList.argsArray[index] ?? []
    if (operation === saveOperation) {
      colorStack.push(currentColor)
      continue
    }
    if (operation === restoreOperation) {
      currentColor = colorStack.pop()
      continue
    }
    const fillColor = pdfFillColorFromOperator(operation, args, runtime)
    if (fillColor) {
      currentColor = fillColor
      continue
    }
    if (showTextOperations.has(operation)) colors.push(currentColor)
  }
  return colors
}

/**
 * 判断 PDF 页面操作符列表是否包含可见文本、图片或矢量绘制内容。
 * 仅调整变换、保存或恢复状态不会产生可见内容，不能据此把页面当作扫描页。
 * @param operatorList PDF.js 页面操作符列表。
 * @param runtime PDF.js 运行时。
 * @returns 页面是否包含可见内容。
 * @author zhenghq
 */
function hasVisiblePdfPageContent(
  operatorList: { fnArray: number[] },
  runtime: PdfJsRuntime
): boolean {
  const visibleOperationNames = [
    'showText',
    'showSpacedText',
    'nextLineShowText',
    'nextLineSetSpacingShowText',
    'paintImageXObject',
    'paintInlineImageXObject',
    'paintInlineImageXObjectGroup',
    'paintImageXObjectRepeat',
    'paintImageMaskXObject',
    'paintImageMaskXObjectGroup',
    'paintImageMaskXObjectRepeat',
    'paintSolidColorImageMask',
    'fill',
    'eoFill',
    'fillStroke',
    'eoFillStroke',
    'closeFillStroke',
    'closeEOFillStroke',
    'stroke',
    'closeStroke',
    'shadingFill'
  ]
  const visibleOperations = new Set(visibleOperationNames
    .map((name) => runtime.OPS[name])
    .filter((value): value is number => typeof value === 'number'))
  return operatorList.fnArray.some((operation) => visibleOperations.has(operation))
}

/**
 * 将页面路径中的直线和矩形转换为水平、垂直线段。
 * 曲线、斜线以及过短装饰线会被忽略，避免把普通边框误判为表格网格。
 * @param operatorList PDF.js 操作符列表。
 * @param runtime PDF.js 运行时。
 * @param viewport 页面视口。
 * @returns 页面视图坐标中的候选网格线。
 * @author zhenghq
 */
function extractPdfGridLines(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  runtime: PdfJsRuntime,
  viewport: { width: number; height: number; transform?: number[] }
): PdfGridLine[] {
  const initial = asPdfMatrix(viewport.transform) ?? [1, 0, 0, -1, 0, viewport.height]
  let current = initial
  const stack: PdfMatrix[] = []
  const lines: PdfGridLine[] = []
  const saveOperation = runtime.OPS['save']
  const restoreOperation = runtime.OPS['restore']
  const transformOperation = runtime.OPS['transform']
  const formBeginOperation = runtime.OPS['paintFormXObjectBegin']
  const formEndOperation = runtime.OPS['paintFormXObjectEnd']
  const constructPathOperation = runtime.OPS['constructPath']
  const moveToOperation = runtime.OPS['moveTo']
  const lineToOperation = runtime.OPS['lineTo']
  const rectangleOperation = runtime.OPS['rectangle']
  const closePathOperation = runtime.OPS['closePath']
  const strokeOperations = new Set([
    runtime.OPS['stroke'],
    runtime.OPS['closeStroke']
  ].filter((value): value is number => typeof value === 'number'))
  const fillStrokeOperations = new Set([
    runtime.OPS['fillStroke'],
    runtime.OPS['eoFillStroke'],
    runtime.OPS['closeFillStroke'],
    runtime.OPS['closeEOFillStroke']
  ].filter((value): value is number => typeof value === 'number'))
  const fillOperations = new Set([
    runtime.OPS['fill'],
    runtime.OPS['eoFill']
  ].filter((value): value is number => typeof value === 'number'))
  const discardPathOperations = new Set([
    runtime.OPS['endPath'],
    runtime.OPS['clip'],
    runtime.OPS['eoClip']
  ].filter((value): value is number => typeof value === 'number'))
  const saveOperationValue = saveOperation
  const restoreOperationValue = restoreOperation
  const transformOperationValue = transformOperation
  const formBeginOperationValue = formBeginOperation
  const formEndOperationValue = formEndOperation
  const strokeColorOperations = new Set([
    runtime.OPS['setStrokeGray'],
    runtime.OPS['setStrokeRGBColor'],
    runtime.OPS['setStrokeCMYKColor'],
    runtime.OPS['setStrokeColor'],
    runtime.OPS['setStrokeColorN']
  ].filter((value): value is number => typeof value === 'number'))
  const fillColorOperations = new Set([
    runtime.OPS['setFillGray'],
    runtime.OPS['setFillRGBColor'],
    runtime.OPS['setFillCMYKColor'],
    runtime.OPS['setFillColor'],
    runtime.OPS['setFillColorN']
  ].filter((value): value is number => typeof value === 'number'))
  const lineWidthOperation = runtime.OPS['setLineWidth']
  let strokeColor: string | undefined
  let fillColor: string | undefined
  let strokeThickness = 1
  const graphicsStack: Array<{ strokeColor?: string; fillColor?: string; thickness: number }> = []
  // PDF 的路径本身不可见，只有后续 stroke/fillStroke 才产生线条；
  // 裁剪矩形和仅填充路径必须在路径结束操作处丢弃，否则会被误画成黑色边框。
  let pendingLines: PdfGridLine[] = []
  // 部分 PDF 使用短边约 0.72pt 的灰色填充矩形绘制表格或代码框边框，
  // 仅对单个细长矩形生成中线，普通背景和单元格底色不能转成可见线条。
  let pendingFilledLine: PdfGridLine | undefined
  let pendingPathHasNonRectangleGeometry = false

  /** 将用户空间点转换为页面视图坐标。 */
  const point = (x: number, y: number): { x: number; y: number } => ({
    x: current[0] * x + current[2] * y + current[4],
    y: current[1] * x + current[3] * y + current[5]
  })

  /** 保存一条仅水平或仅垂直的线段。 */
  const addLine = (start: { x: number; y: number }, end: { x: number; y: number }): void => {
    const dx = Math.abs(end.x - start.x)
    const dy = Math.abs(end.y - start.y)
    const tolerance = 0.75
    if (dx <= tolerance && dy >= PDF_MIN_TABLE_LINE_LENGTH) {
      pendingLines.push({
        orientation: 'vertical',
        start: Math.min(start.y, end.y),
        end: Math.max(start.y, end.y),
        position: (start.x + end.x) / 2,
        ...(strokeColor ? { color: strokeColor } : {}),
        thickness: strokeThickness
      })
    } else if (dy <= tolerance && dx >= PDF_MIN_TABLE_LINE_LENGTH) {
      pendingLines.push({
        orientation: 'horizontal',
        start: Math.min(start.x, end.x),
        end: Math.max(start.x, end.x),
        position: (start.y + end.y) / 2,
        ...(strokeColor ? { color: strokeColor } : {}),
        thickness: strokeThickness
      })
    }
  }

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index]!
    const args = operatorList.argsArray[index] ?? []
    if (operation === saveOperationValue) {
      graphicsStack.push({ strokeColor, fillColor, thickness: strokeThickness })
      stack.push(current)
      continue
    }
    if (operation === restoreOperationValue) {
      const graphics = graphicsStack.pop()
      if (graphics) {
        strokeColor = graphics.strokeColor
        fillColor = graphics.fillColor
        strokeThickness = graphics.thickness
      }
      current = stack.pop() ?? initial
      continue
    }
    if (operation === transformOperationValue) {
      const transform = asPdfMatrix(args)
      if (transform) current = multiplyPdfMatrix(current, transform)
      continue
    }
    if (operation === formBeginOperationValue) {
      stack.push(current)
      const transform = asPdfMatrix(args[0])
      if (transform) current = multiplyPdfMatrix(current, transform)
      continue
    }
    if (operation === formEndOperationValue) {
      current = stack.pop() ?? initial
      continue
    }
    if (strokeColorOperations.has(operation)) {
      const color = pdfStrokeColorFromOperator(operation, args, runtime)
      if (color) strokeColor = color
      continue
    }
    if (fillColorOperations.has(operation)) {
      const color = pdfFillColorFromOperator(operation, args, runtime)
      if (color) fillColor = color
      continue
    }
    if (operation === lineWidthOperation) {
      const width = pdfColorComponents(args)[0]
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) strokeThickness = width
      continue
    }
    if (discardPathOperations.has(operation)) {
      pendingLines = []
      pendingFilledLine = undefined
      pendingPathHasNonRectangleGeometry = false
      continue
    }
    if (fillOperations.has(operation)) {
      if (pendingFilledLine && !pendingPathHasNonRectangleGeometry) {
        lines.push(pendingFilledLine)
      }
      pendingLines = []
      pendingFilledLine = undefined
      pendingPathHasNonRectangleGeometry = false
      continue
    }
    if (strokeOperations.has(operation) || fillStrokeOperations.has(operation)) {
      lines.push(...pendingLines)
      pendingLines = []
      pendingFilledLine = undefined
      pendingPathHasNonRectangleGeometry = false
      continue
    }
    if (operation !== constructPathOperation) continue

    // 上一路径尚未遇到绘制操作时已被新路径替换，旧候选线不能提交。
    pendingLines = []
    pendingFilledLine = undefined
    pendingPathHasNonRectangleGeometry = false
    const pathOperations = Array.isArray(args[0]) ? args[0] : []
    const pathArguments = Array.isArray(args[1]) ? args[1] : []
    let argumentIndex = 0
    let cursor: { x: number; y: number } | undefined
    let subpathStart: { x: number; y: number } | undefined
    let pathClosed = false
    const pathPoints: Array<{ x: number; y: number }> = []
    for (const pathOperation of pathOperations) {
      if (pathOperation === rectangleOperation) {
        const x = pathArguments[argumentIndex]
        const y = pathArguments[argumentIndex + 1]
        const width = pathArguments[argumentIndex + 2]
        const height = pathArguments[argumentIndex + 3]
        argumentIndex += 4
        if ([x, y, width, height].some((value) => typeof value !== 'number' || !Number.isFinite(value))) continue
        const topLeft = point(x!, y!)
        const topRight = point(x! + width!, y!)
        const bottomLeft = point(x!, y! + height!)
        const bottomRight = point(x! + width!, y! + height!)
        addLine(topLeft, topRight)
        addLine(bottomLeft, bottomRight)
        addLine(topLeft, bottomLeft)
        addLine(topRight, bottomRight)
        cursor = topLeft
        subpathStart = topLeft
        pathPoints.push(topLeft, topRight, bottomRight, bottomLeft)
      } else if (pathOperation === moveToOperation) {
        const x = pathArguments[argumentIndex]
        const y = pathArguments[argumentIndex + 1]
        argumentIndex += 2
        if (typeof x !== 'number' || typeof y !== 'number') continue
        cursor = point(x, y)
        subpathStart = cursor
        pathPoints.push(cursor)
      } else if (pathOperation === lineToOperation) {
        const x = pathArguments[argumentIndex]
        const y = pathArguments[argumentIndex + 1]
        argumentIndex += 2
        if (typeof x !== 'number' || typeof y !== 'number') continue
        const next = point(x, y)
        if (cursor) addLine(cursor, next)
        cursor = next
        pathPoints.push(next)
      } else if (pathOperation === closePathOperation) {
        if (cursor && subpathStart) addLine(cursor, subpathStart)
        cursor = subpathStart
        pathClosed = true
      } else if (pathOperation === runtime.OPS['curveTo']) {
        pendingPathHasNonRectangleGeometry = true
        pendingFilledLine = undefined
        argumentIndex += 6
        cursor = undefined
      } else if (pathOperation === runtime.OPS['curveTo2'] || pathOperation === runtime.OPS['curveTo3']) {
        pendingPathHasNonRectangleGeometry = true
        pendingFilledLine = undefined
        argumentIndex += 4
        cursor = undefined
      }
    }
    if (!pendingPathHasNonRectangleGeometry &&
      pathOperations.length === 5 && pathOperations[4] === closePathOperation) {
      const rectangle = pdfAxisAlignedRectangle(pathPoints, pathClosed)
      pendingFilledLine = rectangle ? pdfFilledLineFromRectangle(rectangle, fillColor) : undefined
    } else if (!pendingPathHasNonRectangleGeometry &&
      pathOperations.length === 1 && pathOperations[0] === rectangleOperation) {
      const rectangle = pdfAxisAlignedRectangle(pathPoints, true)
      pendingFilledLine = rectangle ? pdfFilledLineFromRectangle(rectangle, fillColor) : undefined
    }
  }
  return lines
}

/**
 * 合并近似重合的网格线，并保留最完整的一条覆盖范围。
 * @param lines 原始线段。
 * @returns 去重后的线段。
 * @author zhenghq
 */
function mergePdfGridLines(lines: readonly PdfGridLine[]): PdfGridLine[] {
  const result: PdfGridLine[] = []
  for (const line of lines) {
    const existing = result.find((candidate) => candidate.orientation === line.orientation &&
      Math.abs(candidate.position - line.position) <= PDF_TABLE_LINE_TOLERANCE)
    if (!existing) {
      result.push({ ...line })
      continue
    }
    existing.start = Math.min(existing.start, line.start)
    existing.end = Math.max(existing.end, line.end)
    if (!existing.color && line.color) existing.color = line.color
    if (line.thickness !== undefined) {
      existing.thickness = Math.max(existing.thickness ?? 0, line.thickness)
    }
  }
  return result
}

/**
 * 从表格网格中裁剪一条线段，仅保留表格边界以外的部分。
 * 页面外框竖线可能与表单左右边线共线，不能因线段跨越表格就整条保留，
 * 否则它在流式译文中仍会占据表格的高度并造成表格线错位。
 * @param line 候选线段。
 * @param grid 已识别表格网格。
 * @returns 表格区间外仍可渲染的线段；完全位于表格内时返回空数组。
 * @author zhenghq
 */
function pdfLineOutsideDetectedGrid(
  line: PdfGridLine,
  grid: PdfDetectedGrid
): PdfGridLine[] {
  const gridLeft = grid.bbox.x - PDF_TABLE_LINE_TOLERANCE
  const gridRight = grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE
  const gridTop = grid.bbox.y - PDF_TABLE_LINE_TOLERANCE
  const gridBottom = grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE
  if (line.orientation === 'horizontal') {
    if (line.position < gridTop || line.position > gridBottom) return [{ ...line }]
    if (line.end <= gridLeft || line.start >= gridRight) return [{ ...line }]
    const segments: PdfGridLine[] = []
    if (line.start < gridLeft) {
      segments.push({ ...line, end: Math.min(line.end, gridLeft) })
    }
    if (line.end > gridRight) {
      segments.push({ ...line, start: Math.max(line.start, gridRight) })
    }
    return segments.filter((segment) => segment.end - segment.start >= PDF_MIN_TABLE_LINE_LENGTH)
  }
  if (line.position < gridLeft || line.position > gridRight) return [{ ...line }]
  if (line.end <= gridTop || line.start >= gridBottom) return [{ ...line }]
  const segments: PdfGridLine[] = []
  if (line.start < gridTop) {
    segments.push({ ...line, end: Math.min(line.end, gridTop) })
  }
  if (line.end > gridBottom) {
    segments.push({ ...line, start: Math.max(line.start, gridBottom) })
  }
  return segments.filter((segment) => segment.end - segment.start >= PDF_MIN_TABLE_LINE_LENGTH)
}

/**
 * 裁剪所有落在表格网格内的线段，避免表格边框与独立形状重复绘制。
 * @param lines 页面全部去重线段。
 * @param grids 已识别表格网格。
 * @returns 表格外仍需要作为形状绘制的线段。
 * @author zhenghq
 */
function clipPdfLinesOutsideDetectedGrids(
  lines: readonly PdfGridLine[],
  grids: readonly PdfDetectedGrid[]
): PdfGridLine[] {
  return lines.flatMap((line) => grids.reduce<PdfGridLine[]>((segments, grid) =>
    segments.flatMap((segment) => pdfLineOutsideDetectedGrid(segment, grid)), [line]))
}

/**
 * 判断线段是否属于整页装饰边框，避免把页面外框重复绘制成四个形状区块。
 * 只匹配已识别页面边框网格的四条边，不排除边框内部的普通分隔线。
 * @param line 候选线段。
 * @param pageFrameGrids 已识别的整页边框网格。
 * @returns 线段是否位于页面边框边线上。
 * @author zhenghq
 */
function pdfLineOnDetectedPageFrame(
  line: PdfGridLine,
  pageFrameGrids: readonly PdfDetectedGrid[]
): boolean {
  const tolerance = PDF_TABLE_LINE_TOLERANCE + 1
  return pageFrameGrids.some((grid) => {
    const right = grid.bbox.x + grid.bbox.width
    const bottom = grid.bbox.y + grid.bbox.height
    if (line.orientation === 'horizontal') {
      return (Math.abs(line.position - grid.bbox.y) <= tolerance ||
        Math.abs(line.position - bottom) <= tolerance) &&
        line.start >= grid.bbox.x - tolerance &&
        line.end <= right + tolerance
    }
    return (Math.abs(line.position - grid.bbox.x) <= tolerance ||
      Math.abs(line.position - right) <= tolerance) &&
      line.start >= grid.bbox.y - tolerance &&
      line.end <= bottom + tolerance
  })
}

/**
 * 判断线段是否为贴纸张边缘的整页装饰线。
 * 仅过滤贴近页面边缘且长度接近整页的横线或竖线，避免误删正常页眉、表格和签名线。
 * @param line 候选线段。
 * @param pageWidth 页面宽度。
 * @param pageHeight 页面高度。
 * @returns 线段是否为纸张外围装饰线。
 * @author zhenghq
 */
function isPdfPageEdgeDecoration(
  line: PdfGridLine,
  pageWidth: number,
  pageHeight: number
): boolean {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    return false
  }
  const edgeTolerance = PDF_TABLE_LINE_TOLERANCE
  const length = line.end - line.start
  if (line.orientation === 'vertical') {
    return (line.position <= edgeTolerance || line.position >= pageWidth - edgeTolerance) &&
      length >= pageHeight * PDF_PAGE_FRAME_MIN_RATIO
  }
  return (line.position <= edgeTolerance || line.position >= pageHeight - edgeTolerance) &&
    length >= pageWidth * PDF_PAGE_FRAME_MIN_RATIO
}

/**
 * 将未落入表格网格的水平或垂直分隔线转换为可渲染的形状区块。
 * @param lines 页面全部去重线段。
 * @param grids 已识别表格网格。
 * @param pageFrameGrids 已识别整页装饰边框网格。
 * @param codeFrameGrids 已识别代码框；其内部原始线段不应再逐条输出为形状。
 * @param pageWidth 页面宽度。
 * @param pageHeight 页面高度。
 * @param pageId 页面标识。
 * @param fingerprint 文档指纹。
 * @returns 分隔线形状区块。
 * @author zhenghq
 */
function createPdfDividerBlocks(
  lines: readonly PdfGridLine[],
  grids: readonly PdfDetectedGrid[],
  pageFrameGrids: readonly PdfDetectedGrid[],
  codeFrameGrids: readonly PdfDetectedGrid[],
  pageWidth: number,
  pageHeight: number,
  pageId: string,
  fingerprint: string
): DocumentBlock[] {
  // 代码框内部每行都可能带分隔线。外框由代码文本块自身绘制，这里只裁掉框内线段，
  // 既避免译文页出现多余黑线，也避免外框停留在原页坐标而与流式译文错位。
  const outsideCodeFrames = clipPdfLinesOutsideDetectedGrids(lines, codeFrameGrids)
  const dividers = clipPdfLinesOutsideDetectedGrids(outsideCodeFrames, grids)
    .filter((line) => !pdfLineOnDetectedPageFrame(line, pageFrameGrids))
    .filter((line) => !isPdfPageEdgeDecoration(line, pageWidth, pageHeight))
  return dividers.map((line, index) => {
    const lineStyle: DocumentLineStyle = {
      orientation: line.orientation,
      ...(line.color ? { color: line.color } : {}),
      ...(line.thickness !== undefined ? { thickness: line.thickness } : {})
    }
    return {
      kind: 'shape',
      blockId: createDocumentBlockId(fingerprint, pageId, index, 'shape'),
      readingOrder: index,
      translatable: false,
      bbox: line.orientation === 'horizontal'
        ? {
            x: line.start,
            y: line.position,
            width: Math.max(1, line.end - line.start),
            height: Math.max(1, line.thickness ?? 1)
          }
        : {
            x: line.position,
            y: line.start,
            width: Math.max(1, line.thickness ?? 1),
            height: Math.max(1, line.end - line.start)
          },
      line: lineStyle
    }
  })
}

/**
 * 判断两个 PDF 区块是否属于同一视觉行中的小图片与文字组合。
 * 只接受纵向明显重叠、横向紧邻且图片尺寸有限的组合，避免正文双栏被误合并。
 * @param left 左侧候选区块。
 * @param right 右侧候选区块。
 * @returns 是否应共享同行分组。
 * @author zhenghq
 */
function pdfBlocksShareVisualRow(left: DocumentBlock, right: DocumentBlock): boolean {
  if (!left.bbox || !right.bbox) return false
  if (!((left.kind === 'image' && right.kind === 'text') ||
    (left.kind === 'text' && right.kind === 'image'))) return false
  const image = left.kind === 'image' ? left : right
  const text = left.kind === 'text' ? left : right
  const imageBox = image.bbox!
  const textBox = text.bbox!
  if (imageBox.width > 80 || imageBox.height > 80) return false
  const overlap = Math.min(imageBox.y + imageBox.height, textBox.y + textBox.height) -
    Math.max(imageBox.y, textBox.y)
  const minHeight = Math.min(imageBox.height, textBox.height)
  if (overlap < minHeight * 0.35) return false
  const gap = left === image ? textBox.x - (imageBox.x + imageBox.width) : imageBox.x - (textBox.x + textBox.width)
  return gap >= -PDF_TABLE_LINE_TOLERANCE && gap <= Math.max(32, imageBox.height * 1.5)
}

/**
 * 将数值接近的坐标合并为一个边界，避免抗锯齿误差生成重复的零宽列。
 * @param values 待合并的坐标。
 * @returns 升序排列的边界坐标。
 * @author zhenghq
 */
function mergePdfGridCoordinates(values: readonly number[]): number[] {
  const result: number[] = []
  for (const value of [...values].sort((left, right) => left - right)) {
    const previous = result[result.length - 1]
    if (previous === undefined || value - previous > PDF_TABLE_LINE_TOLERANCE) result.push(value)
  }
  return result
}

/**
 * 修正被表单外框拉长的候选表格底边。
 * 数据表内部列线应在最后一行结束；若底部横线只由左右外框竖线继续支撑，
 * 说明它是表单容器底边而不是表格行线，表格范围应止于内部列线终点。
 * @param grid 候选表格网格。
 * @param lines 页面全部去重线段。
 * @param textLines 页面文本行；最后一行仍有文本时不能裁掉该行。
 * @returns 修正底边后的网格；无需修正时返回原网格。
 * @author zhenghq
 */
function trimPdfFormContainerBottom(
  grid: PdfDetectedGrid,
  lines: readonly PdfGridLine[],
  textLines: readonly PdfLine[] = []
): PdfDetectedGrid {
  const bottom = grid.bbox.y + grid.bbox.height
  if (grid.rows.length < 2) return grid
  const vertical = lines.filter((line) => line.orientation === 'vertical')
  const gridRight = grid.bbox.x + grid.bbox.width
  const interiorLines = vertical.filter((line) =>
    line.position > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE &&
    line.position < gridRight - PDF_TABLE_LINE_TOLERANCE &&
    line.start <= grid.bbox.y + PDF_TABLE_LINE_TOLERANCE &&
    line.end < bottom - PDF_TABLE_LINE_TOLERANCE)
  if (interiorLines.length === 0) return grid
  const interiorBottom = Math.min(...interiorLines.map((line) => line.end))
  if (interiorBottom >= bottom - PDF_TABLE_LINE_TOLERANCE) return grid
  const borderLines = vertical.filter((line) =>
    (Math.abs(line.position - grid.bbox.x) <= PDF_TABLE_LINE_TOLERANCE ||
      Math.abs(line.position - (grid.bbox.x + grid.bbox.width)) <= PDF_TABLE_LINE_TOLERANCE) &&
    line.end >= bottom - PDF_TABLE_LINE_TOLERANCE)
  if (borderLines.length < 2) return grid
  // 表单容器底部可能同时包含真实的最后一行数据。只要候选底边内仍有文本中心
  // 落在待裁掉的行中，就必须保留该行；否则会把最后一行单元格和边框一起删除。
  const hasTextInTrimmedRows = textLines.some((line) => {
    const centerY = line.bbox.y + line.bbox.height / 2
    return centerY > interiorBottom + PDF_TABLE_LINE_TOLERANCE &&
      centerY < bottom - PDF_TABLE_LINE_TOLERANCE &&
      line.bbox.x + line.bbox.width >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
      line.bbox.x <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE
  })
  if (hasTextInTrimmedRows) return grid
  const rows = grid.rows.filter((row) => row <= interiorBottom + PDF_TABLE_LINE_TOLERANCE)
  if (rows.length < 2) return grid
  const nextBottom = rows[rows.length - 1]!
  return {
    bbox: { ...grid.bbox, height: nextBottom - grid.bbox.y },
    columns: [...grid.columns],
    rows
  }
}

/**
 * 判断水平网格线两端是否与竖线相接。
 * 表格行线必须在左右边界处闭合，签名区等只覆盖部分页面的横线不能把表格向下扩展。
 * @param line 待校验的水平线。
 * @param verticalLines 页面全部竖直线。
 * @returns 两端都能找到相接竖线时返回 true。
 * @author zhenghq
 */
function pdfHorizontalLineHasVerticalSupports(
  line: PdfGridLine,
  verticalLines: readonly PdfGridLine[]
): boolean {
  const hasSupportAt = (x: number): boolean => verticalLines.some((vertical) =>
    Math.abs(vertical.position - x) <= PDF_TABLE_LINE_TOLERANCE &&
    vertical.start <= line.position + PDF_TABLE_LINE_TOLERANCE &&
    vertical.end >= line.position - PDF_TABLE_LINE_TOLERANCE)
  return hasSupportAt(line.start) && hasSupportAt(line.end)
}

/**
 * 判断候选表格的内部列线是否延伸到底边。
 * 表单外框左右竖线会一直延伸到容器底部，即使内部列线早已结束，
 * 也能为容器底线提供端点支撑；因此不能只凭左右边框判定底边闭合。
 * @param columns 候选表格的列边界。
 * @param left 候选表格左边界。
 * @param right 候选表格右边界。
 * @param bottom 候选表格底边。
 * @param verticalLines 页面全部竖直线。
 * @returns 无内部列线或至少一条内部列线到达底边时返回 true。
 * @author zhenghq
 */
function pdfGridInteriorColumnReachesBottom(
  columns: readonly number[],
  left: number,
  right: number,
  bottom: number,
  verticalLines: readonly PdfGridLine[]
): boolean {
  const interiorColumns = columns.filter((column) =>
    column > left + PDF_TABLE_LINE_TOLERANCE &&
    column < right - PDF_TABLE_LINE_TOLERANCE)
  if (interiorColumns.length === 0) return true
  return interiorColumns.some((column) => verticalLines.some((line) =>
    Math.abs(line.position - column) <= PDF_TABLE_LINE_TOLERANCE &&
    line.end >= bottom - PDF_TABLE_LINE_TOLERANCE))
}

/**
 * 从闭合横纵网格中提取表格边界与行列分隔线。
 * 仅有一条横线或网格未闭合时返回空数组，避免把普通边框识别为表格。
 * 表头分隔线可能只覆盖部分列，因此同时从横线端点和贯穿竖线恢复列边界。
 * @param lines 去重后的页面线段。
 * @param textLines 页面文本行，用于避免裁掉仍有数据的最后一行。
 * @returns 所有候选表格网格，调用方负责排除页面外框并过滤嵌套网格。
 * @author zhenghq
 */
function detectPdfTableGrids(
  lines: readonly PdfGridLine[],
  textLines: readonly PdfLine[] = []
): PdfDetectedGrid[] {
  const horizontal = lines.filter((line) => line.orientation === 'horizontal')
  const vertical = lines.filter((line) => line.orientation === 'vertical')
  if (horizontal.length < 2 || vertical.length < 2) return []
  const grids: PdfDetectedGrid[] = []
  for (const top of horizontal) {
    for (const bottom of horizontal) {
      if (bottom.position <= top.position + PDF_TABLE_LINE_TOLERANCE) continue
      const rowLines = horizontal.filter((line) =>
        line.position >= top.position - PDF_TABLE_LINE_TOLERANCE &&
        line.position <= bottom.position + PDF_TABLE_LINE_TOLERANCE &&
        line.start <= Math.min(top.start, bottom.start) + PDF_TABLE_LINE_TOLERANCE &&
        line.end >= Math.max(top.end, bottom.end) - PDF_TABLE_LINE_TOLERANCE &&
        pdfHorizontalLineHasVerticalSupports(line, vertical))
      if (rowLines.length < 2) continue
      const left = Math.min(top.start, bottom.start)
      const right = Math.max(top.end, bottom.end)
      const columnLines = vertical.filter((line) =>
        line.position >= left - PDF_TABLE_LINE_TOLERANCE &&
        line.position <= right + PDF_TABLE_LINE_TOLERANCE &&
        line.start <= bottom.position + PDF_TABLE_LINE_TOLERANCE &&
        line.end >= top.position - PDF_TABLE_LINE_TOLERANCE)
      const borderColumnLines = columnLines.filter((line) =>
        line.start <= top.position + PDF_TABLE_LINE_TOLERANCE &&
        line.end >= bottom.position - PDF_TABLE_LINE_TOLERANCE)
      if (borderColumnLines.length < 2) continue
      const columns = mergePdfGridCoordinates([
        left,
        right,
        ...borderColumnLines.map((line) => line.position),
        ...columnLines
          .filter((line) => !borderColumnLines.includes(line))
          .map((line) => line.position)
      ])
      const rows = mergePdfGridCoordinates(rowLines.map((line) => line.position))
      if (columns.length < 2 || rows.length < 2) continue
      const topPosition = rows[0]!
      const bottomPosition = rows[rows.length - 1]!
      if (!pdfGridInteriorColumnReachesBottom(columns, left, right, bottomPosition, vertical)) continue
      const bbox = {
        x: left,
        y: topPosition,
        width: right - left,
        height: bottomPosition - topPosition
      }
      if (bbox.width < PDF_MIN_TABLE_SIZE || bbox.height < PDF_MIN_TABLE_SIZE) continue
      const duplicate = grids.some((grid) =>
        Math.abs(grid.bbox.x - bbox.x) <= PDF_TABLE_LINE_TOLERANCE &&
        Math.abs(grid.bbox.y - bbox.y) <= PDF_TABLE_LINE_TOLERANCE &&
        Math.abs(grid.bbox.width - bbox.width) <= PDF_TABLE_LINE_TOLERANCE &&
        Math.abs(grid.bbox.height - bbox.height) <= PDF_TABLE_LINE_TOLERANCE)
      if (duplicate) continue
      grids.push({ bbox, columns, rows })
    }
  }
  // 表单外框裁剪必须等共享边界的候选合并后再执行。否则表头候选会被先裁成
  // 单行网格，后续无法再与同一表格的正文候选组成完整区域。
  return grids
}

/**
 * 按页面纵坐标把原始水平线段归入同一行边界。
 * 网页表格常为每个单元格单独绘制一段底边，合并线段前必须保留这些分段端点。
 * @param lines 页面原始水平线段。
 * @param grid 待精修的单列网格。
 * @returns 位于网格范围内、按纵坐标分组后的水平线段。
 * @author zhenghq
 */
function groupPdfGridRowSegments(
  lines: readonly PdfGridLine[],
  grid: PdfDetectedGrid
): PdfGridLine[][] {
  const bottom = grid.bbox.y + grid.bbox.height
  const groups: PdfGridLine[][] = []
  const horizontal = lines.filter((line) =>
    line.orientation === 'horizontal' &&
    line.position >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
    line.position <= bottom + PDF_TABLE_LINE_TOLERANCE &&
    line.end >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
    line.start <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE)
    .sort((left, right) => left.position - right.position)
  for (const line of horizontal) {
    const group = groups.find((candidate) =>
      Math.abs(candidate[0]!.position - line.position) <= PDF_TABLE_LINE_TOLERANCE)
    if (group) group.push(line)
    else groups.push([line])
  }
  return groups
}

/**
 * 从网页表格每个单元格的分段横线端点恢复列边界。
 * 只有端点至少在两个不同行边界重复出现时才采用，避免把装饰线端点误当成列线。
 * @param rawLines 未合并的页面原始线段。
 * @param grid 待精修的单列网格。
 * @returns 恢复后的列边界；没有可靠分段端点时返回空数组。
 * @author zhenghq
 */
function inferPdfGridColumnsFromRowSegments(
  rawLines: readonly PdfGridLine[],
  grid: PdfDetectedGrid
): number[] {
  const endpointClusters: Array<{ position: number; rows: Set<number> }> = []
  let segmentedRowCount = 0
  for (const segments of groupPdfGridRowSegments(rawLines, grid)) {
    const rowEndpoints = mergePdfGridCoordinates(segments.flatMap((segment) => [
      Math.max(grid.bbox.x, segment.start),
      Math.min(grid.bbox.x + grid.bbox.width, segment.end)
    ])).filter((position) =>
      position >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
      position <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE)
    if (rowEndpoints.length < 3) continue
    segmentedRowCount += 1
    const rowIndex = segmentedRowCount
    for (const position of rowEndpoints) {
      const cluster = endpointClusters.find((candidate) =>
        Math.abs(candidate.position - position) <= PDF_TABLE_LINE_TOLERANCE)
      if (cluster) {
        cluster.rows.add(rowIndex)
      } else {
        endpointClusters.push({ position, rows: new Set([rowIndex]) })
      }
    }
  }
  if (segmentedRowCount < 2) return []
  const columns = mergePdfGridCoordinates([
    grid.bbox.x,
    grid.bbox.x + grid.bbox.width,
    ...endpointClusters
      .filter((cluster) => cluster.rows.size >= 2)
      .map((cluster) => cluster.position)
  ])
  return columns.length >= 3 ? columns : []
}

/**
 * 从表格内原始文本项中收集至少两行重复出现的左起点。
 * 同一行内相邻文本项可能是长文本被 PDF.js 拆出的片段，因此只有
 * 与上一片段存在真实列间距时才建立新起点，避免把单词内部拆成列。
 * @param grid 待分析的表格网格。
 * @param textLines 页面全部视觉文本行。
 * @param pageHeight 页面高度。
 * @returns 稳定的文本列起点，以及每行可用的文本片段范围。
 * @author zhenghq
 */
function pdfStableTextColumnStarts(
  grid: PdfDetectedGrid,
  textLines: readonly PdfLine[],
  pageHeight: number
): {
  starts: number[]
  rows: Array<{ starts: number[]; clusters: PdfTextColumnCluster[] }>
} {
  const startClusters: Array<{ position: number; rows: Set<number> }> = []
  const rows: Array<{ starts: number[]; clusters: PdfTextColumnCluster[] }> = []
  const left = grid.bbox.x + PDF_TABLE_LINE_TOLERANCE
  const right = grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE
  for (const line of textLines) {
    if (!pdfLineCenterInsideGrid(line, grid)) continue
    const clusters = pdfTextLineColumnClusters(line, pageHeight).filter((cluster) =>
      cluster.start >= left && cluster.start <= right)
    const itemStarts = pdfTextItemColumnStarts(line, pageHeight).filter((start) =>
      start >= left && start <= right)
    if (clusters.length === 0) continue
    const rowIndex = rows.length
    rows.push({ starts: clusters.map((cluster) => cluster.start), clusters })
    for (const position of mergePdfGridCoordinates([...clusters.map((cluster) => cluster.start), ...itemStarts])) {
      const existing = startClusters.find((candidate) =>
        Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2))
      if (existing) existing.rows.add(rowIndex)
      else startClusters.push({ position, rows: new Set([rowIndex]) })
    }
  }
  return {
    starts: mergePdfGridCoordinates(startClusters
      .filter((cluster) => cluster.rows.size >= 2)
      .map((cluster) => cluster.position)),
    rows
  }
}

/**
 * 判断候选列边界是否有足够的文本或分段横线支持。
 * 左右外框、文本起点和分段线端点会分别提供证据；只有真实边界才应保留，
 * 否则局部横线端点会在长文本中间生成没有内容的窄列。
 * @param position 候选边界。
 * @param grid 表格网格。
 * @param textStarts 稳定文本起点。
 * @param segmentColumns 分段横线恢复的列边界。
 * @returns 候选边界有支持时返回 true。
 * @author zhenghq
 */
function pdfGridColumnBoundaryIsSupported(
  position: number,
  grid: PdfDetectedGrid,
  textStarts: readonly number[],
  segmentColumns: readonly number[]
): boolean {
  const left = grid.bbox.x
  const right = grid.bbox.x + grid.bbox.width
  if (Math.abs(position - left) <= PDF_TABLE_LINE_TOLERANCE ||
    Math.abs(position - right) <= PDF_TABLE_LINE_TOLERANCE) return true
  const tolerance = Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2)
  if (textStarts.some((start) => Math.abs(start - position) <= tolerance)) return true
  return segmentColumns.some((column) => Math.abs(column - position) <= tolerance)
}

/**
 * 合并文本起点与分段线端点，并过滤无文本支持的伪列边界。
 * 对于长首列文本，边界必须靠近下一列起点而不是落在首列内容内部；
 * 对分段横线表格，端点与下一列文本起点应形成同一列边界。
 * @param grid 待精修网格。
 * @param textLines 页面全部视觉文本行。
 * @param pageHeight 页面高度。
 * @param segmentColumns 分段横线恢复的边界。
 * @returns 可用于表格的列边界；证据不足时返回空数组。
 * @author zhenghq
 */
function inferPdfGridColumnsFromEvidence(
  grid: PdfDetectedGrid,
  textLines: readonly PdfLine[],
  pageHeight: number,
  segmentColumns: readonly number[]
): number[] {
  const textEvidence = pdfStableTextColumnStarts(grid, textLines, pageHeight)
  const left = grid.bbox.x
  const right = grid.bbox.x + grid.bbox.width
  const textColumns = inferPdfGridColumnsFromText(grid, textLines, pageHeight)
  const textBoundaries = textColumns.length >= 2
    ? textColumns.slice(1, -1)
    : textEvidence.starts.slice(1).map((start, index, starts) => {
        const previous = index === 0 ? textEvidence.starts[0]! : starts[index - 1]!
        return Math.min(start - Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2),
          (previous + start) / 2 + Math.max(8, (start - previous) * 0.35))
      })
  const candidates = mergePdfGridCoordinates([
    left,
    right,
    ...textBoundaries,
    ...segmentColumns.filter((column) =>
      column > left + PDF_TABLE_LINE_TOLERANCE &&
      column < right - PDF_TABLE_LINE_TOLERANCE)
  ]).filter((position) => pdfGridColumnBoundaryIsSupported(
    position,
    grid,
    textEvidence.starts,
    segmentColumns
  ))
  // 分段横线端点通常与下一列文本起点重合，此时保留端点作为真实列边界。
  const merged = mergePdfGridCoordinates([
    left,
    right,
    ...candidates.filter((position) =>
      position > left + PDF_TABLE_LINE_TOLERANCE &&
      position < right - PDF_TABLE_LINE_TOLERANCE)
  ])
  if (merged.length < 3) return []
  const minimumWidth = Math.max(PDF_TABLE_LINE_TOLERANCE * 2, grid.bbox.width * 0.04)
  const valid = merged.every((position, index) =>
    index === 0 || position - merged[index - 1]! >= minimumWidth)
  return valid ? merged : []
}

/** 同一视觉行中横向连续的一段文本及其页面边界。 */
interface PdfTextColumnCluster {
  /** 片段最左边界。 */
  start: number
  /** 片段最右边界。 */
  end: number
}

/**
 * 将同一视觉行中横向连续的文本项聚合为单元格内容片段。
 * 同时保留片段左右边界，供列分隔线优先放在单元格真实空白区域中。
 * @param line PDF 视觉行。
 * @param pageHeight 页面高度。
 * @returns 按左边界排序的文本片段。
 * @author zhenghq
 */
function pdfTextLineColumnClusters(line: PdfLine, pageHeight: number): PdfTextColumnCluster[] {
  const items = line.items
    .filter((item) => item.str.trim().length > 0)
    .map((item) => ({ item, bbox: textItemBoundingBox(item, pageHeight) }))
    .sort((left, right) => left.bbox.x - right.bbox.x)
  const clusters: PdfTextColumnCluster[] = []
  let current: PdfTextColumnCluster | undefined
  for (const entry of items) {
    const fontSize = fontSizeFromTransform(entry.item.transform, entry.item.height)
    const allowedGap = Math.max(PDF_MIN_TABLE_LINE_LENGTH, fontSize * 1.8)
    const right = entry.bbox.x + entry.bbox.width
    if (!current || entry.bbox.x - current.end > allowedGap) {
      current = { start: entry.bbox.x, end: right }
      clusters.push(current)
    } else {
      current.end = Math.max(current.end, right)
    }
  }
  return clusters
}

/**
 * 从同一视觉行中读取每个原始文本项的左边界，并按列间距拆分为候选起点。
 * 与按覆盖范围聚类不同，这里不丢弃被长文本覆盖的后续文本项，用于识别
 * 首列长文本与下一列起点重叠的真实表格。
 * @param line PDF 视觉行。
 * @param pageHeight 页面高度。
 * @returns 至少两个文本项时才返回按左边界排序的起点。
 * @author zhenghq
 */
function pdfTextItemColumnStarts(line: PdfLine, pageHeight: number): number[] {
  const items = line.items
    .filter((item) => item.str.trim().length > 0)
    .map((item) => ({ item, bbox: textItemBoundingBox(item, pageHeight) }))
    .sort((left, right) => left.bbox.x - right.bbox.x)
  if (items.length < 2) return []
  const starts: number[] = []
  let previous: (typeof items)[number] | undefined
  for (const entry of items) {
    if (!previous) {
      starts.push(entry.bbox.x)
    } else {
      const fontSize = Math.max(
        fontSizeFromTransform(previous.item.transform, previous.item.height),
        fontSizeFromTransform(entry.item.transform, entry.height)
      )
      const previousRight = previous.bbox.x + previous.bbox.width
      // 同一单元格中的单词通常连续；只有出现明显间距或起点回退到前一项
      // 覆盖范围内部时才说明 PDF.js 已切换到下一个单元格。
      if (entry.bbox.x - previousRight > Math.max(4, fontSize * 0.35) ||
        entry.bbox.x < previous.bbox.x + previous.bbox.width - fontSize * 0.5) {
        starts.push(entry.bbox.x)
      }
    }
    previous = entry
  }
  return starts.length >= 2 ? mergePdfGridCoordinates(starts) : []
}

/**
 * 将同一视觉行中横向连续的文本项聚合为单元格内容片段。
 * @param line PDF 视觉行。
 * @param pageHeight 页面高度。
 * @returns 每个片段最左侧的文本起点。
 * @author zhenghq
 */
function pdfTextLineColumnStarts(line: PdfLine, pageHeight: number): number[] {
  return pdfTextLineColumnClusters(line, pageHeight).map((cluster) => cluster.start)
}

/**
 * 从多行文本的稳定左起点推断无内部竖线表格的列边界。
 * 只有同一文本起点至少在两个视觉行出现时才视为一列，随后以相邻起点中点
 * 作为分隔线，并限制过窄列，避免把单元格内部换行误判成新增列。
 * @param grid 待精修的单列网格。
 * @param textLines 页面全部文本行。
 * @param pageHeight 页面高度。
 * @returns 推断出的列边界；证据不足时返回空数组。
 * @author zhenghq
 */
function inferPdfGridColumnsFromText(
  grid: PdfDetectedGrid,
  textLines: readonly PdfLine[],
  pageHeight: number
): number[] {
  const starts: Array<{ position: number; rows: Set<number> }> = []
  const boundaryClusters: Array<{ position: number; rows: Set<number> }> = []
  let multiItemRowCount = 0
  for (const line of textLines) {
    if (!pdfLineCenterInsideGrid(line, grid)) continue
    const lineClusters = pdfTextLineColumnClusters(line, pageHeight).filter((cluster) =>
      cluster.start > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE &&
      cluster.start < grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE)
    const lineStarts = lineClusters.map((cluster) => cluster.start)
    if (lineStarts.length < 2) continue
    multiItemRowCount += 1
    const rowIndex = multiItemRowCount
    for (const position of lineStarts) {
      const cluster = starts.find((candidate) =>
        Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2))
      if (cluster) cluster.rows.add(rowIndex)
      else starts.push({ position, rows: new Set([rowIndex]) })
    }
  }
  if (multiItemRowCount < 2) return []
  const columnStarts = mergePdfGridCoordinates(starts
    .filter((start) => start.rows.size >= 2)
    .map((start) => start.position))
  if (columnStarts.length < 2) return []
  // 列分隔线应落在两列文本之间的真实空白区域，而不是两个文本起点之间的中点。
  // 长首列文本可能一直延伸到下一列起点附近，使用中点会把同一单元格拆成两列。
  const boundaryCandidates: Array<{ position: number; rows: Set<number> }> = []
  let boundaryRowIndex = 0
  for (const line of textLines) {
    if (!pdfLineCenterInsideGrid(line, grid)) continue
    const lineClusters = pdfTextLineColumnClusters(line, pageHeight).filter((cluster) =>
      cluster.start > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE &&
      cluster.start < grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE)
    if (lineClusters.length < 2) continue
    boundaryRowIndex += 1
    for (let index = 0; index < lineClusters.length - 1; index += 1) {
      const left = lineClusters[index]!
      const right = lineClusters[index + 1]!
      if (right.start - left.end <= PDF_TABLE_LINE_TOLERANCE) continue
      const position = (left.end + right.start) / 2
      const cluster = boundaryCandidates.find((candidate) =>
        Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2))
      if (cluster) cluster.rows.add(boundaryRowIndex)
      else boundaryCandidates.push({ position, rows: new Set([boundaryRowIndex]) })
    }
  }
  const stableBoundaries = mergePdfGridCoordinates(boundaryCandidates
    .filter((boundary) => boundary.rows.size >= 2)
    .map((boundary) => boundary.position))
  const left = grid.bbox.x
  const right = grid.bbox.x + grid.bbox.width
  const boundaries = [left]
  for (let index = 0; index < columnStarts.length - 1; index += 1) {
    const nextStart = columnStarts[index + 1]!
    const textBoundary = stableBoundaries
      .filter((position) => position > columnStarts[index]! && position < nextStart)
      .sort((first, second) => Math.abs(second - nextStart) - Math.abs(first - nextStart))[0]
    boundaries.push(textBoundary ?? (columnStarts[index]! + nextStart) / 2)
  }
  boundaries.push(right)
  const minimumWidth = grid.bbox.width / columnStarts.length * 0.66
  for (let index = 1; index < boundaries.length - 1; index += 1) {
    boundaries[index] = Math.max(boundaries[index]!, boundaries[index - 1]! + minimumWidth)
  }
  for (let index = boundaries.length - 2; index > 0; index -= 1) {
    boundaries[index] = Math.min(boundaries[index]!, boundaries[index + 1]! - minimumWidth)
  }
  const columns = mergePdfGridCoordinates(boundaries)
  const valid = columns.length === columnStarts.length + 1 && columns.every((column, index) =>
    index === 0 || column - columns[index - 1]! > PDF_TABLE_LINE_TOLERANCE)
  return valid ? columns : []
}

/**
 * 使用原始分段横线或稳定文本起点精修单列表格候选的列边界。
 * 网页转出的 PDF 常缺少贯穿竖线，若只依赖合并后的网格会把多个单元格挤成一列。
 * @param grid 已识别的候选网格。
 * @param rawLines 未合并的页面原始线段。
 * @param textLines 页面全部文本行。
 * @param pageHeight 页面高度。
 * @returns 列边界更完整的网格；无法可靠恢复时返回原网格。
 * @author zhenghq
 */
function refinePdfSingleColumnGrid(
  grid: PdfDetectedGrid,
  rawLines: readonly PdfGridLine[],
  textLines: readonly PdfLine[],
  pageHeight: number
): PdfDetectedGrid {
  if (grid.columns.length !== 2 || grid.rows.length < 3) return grid
  const segmentColumns = inferPdfGridColumnsFromRowSegments(rawLines, grid)
  // 分段横线端点和稳定文本起点必须交叉校验：端点描述真实单元格边界，
  // 文本起点证明该列确实存在内容，二者单独使用都会产生伪列或粘连。
  const columns = inferPdfGridColumnsFromEvidence(
    grid,
    textLines,
    pageHeight,
    segmentColumns
  )
  return columns.length >= 3 ? { ...grid, columns } : grid
}

/** 由稳定水平行线聚类得到的候选表格区域。 */
interface PdfRowLineCluster {
  /** 行线中心纵坐标。 */
  position: number
  /** 行线左边界。 */
  left: number
  /** 行线右边界。 */
  right: number
  /** 同一条边界上的原始线段数量。 */
  segmentCount: number
}

/**
 * 将原始水平线段按纵坐标聚类，并保留每行的实际横向范围。
 * 网页表格常逐单元格绘制横线，不能先按最长线段合并，否则会丢失列边界证据。
 * @param rawLines 页面原始线段。
 * @returns 按纵坐标排序的行线聚类。
 * @author zhenghq
 */
function groupPdfRawHorizontalRowLines(rawLines: readonly PdfGridLine[]): PdfRowLineCluster[] {
  const groups: Array<{ positions: number[]; lines: PdfGridLine[] }> = []
  for (const line of rawLines.filter((candidate) => candidate.orientation === 'horizontal')) {
    const group = groups.find((candidate) =>
      Math.abs(candidate.positions[0]! - line.position) <= PDF_TABLE_LINE_TOLERANCE)
    if (group) {
      group.positions.push(line.position)
      group.lines.push(line)
    } else {
      groups.push({ positions: [line.position], lines: [line] })
    }
  }
  return groups.map((group) => ({
    position: group.positions.reduce((sum, position) => sum + position, 0) / group.positions.length,
    left: Math.min(...group.lines.map((line) => line.start)),
    right: Math.max(...group.lines.map((line) => line.end)),
    segmentCount: group.lines.length
  })).sort((left, right) => left.position - right.position)
}

/**
 * 判断一组水平行线是否具有表格所需的规则纵向间距。
 * 至少需要三行边界和两个高度接近的行高，避免把章节分隔线组合成表格。
 * @param rows 按纵坐标排序的行线聚类。
 * @returns 行距稳定时返回 true。
 * @author zhenghq
 */
function pdfRowLineClustersAreRegular(rows: readonly PdfRowLineCluster[]): boolean {
  if (rows.length < 3) return false
  const gaps = rows.slice(1).map((row, index) => row.position - rows[index]!.position)
    .filter((gap) => gap > PDF_TABLE_LINE_TOLERANCE)
  if (gaps.length < 2) return false
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  if (average < PDF_MIN_TABLE_SIZE) return false
  const maximumDeviation = Math.max(...gaps.map((gap) => Math.abs(gap - average)))
  return maximumDeviation <= Math.max(PDF_TABLE_LINE_TOLERANCE * 2, average * 0.3)
}

/**
 * 从稳定水平行线与稳定文本列恢复没有竖线的网页表格。
 * 仅在有规则行线、至少三个多列文本行和两个稳定列起点时生成候选，
 * 避免把普通段落、代码块或章节分隔线误判为表格。
 * @param rawLines 页面原始线段。
 * @param textLines 页面全部文本行。
 * @param pageWidth 页面宽度。
 * @param pageHeight 页面高度。
 * @returns 根据文本行证据恢复的候选网格。
 * @author zhenghq
 */
function detectPdfTextRowTableGrids(
  rawLines: readonly PdfGridLine[],
  textLines: readonly PdfLine[],
  pageWidth: number,
  pageHeight: number
): PdfDetectedGrid[] {
  const rowLines = groupPdfRawHorizontalRowLines(rawLines)
  if (rowLines.length < 3) return []
  // 同一张网页表格的横线通常连续且等距。按连续区段一次性生成候选，
  // 避免枚举所有子区间后让同一表格产生大量重叠候选并重复占行。
  const groups: PdfRowLineCluster[][] = []
  for (const row of rowLines) {
    const previousGroup = groups[groups.length - 1]
    const previous = previousGroup?.[previousGroup.length - 1]
    if (previous && Math.abs(row.position - previous.position) <= PDF_MIN_TABLE_SIZE * 3) {
      previousGroup!.push(row)
    } else {
      groups.push([row])
    }
  }
  const candidates: PdfDetectedGrid[] = []
  for (const rows of groups) {
    if (!pdfRowLineClustersAreRegular(rows)) continue
    const left = Math.min(...rows.map((row) => row.left))
    const right = Math.max(...rows.map((row) => row.right))
    if (right - left < PDF_MIN_TABLE_SIZE) continue
    const top = rows[0]!.position
    const lastLine = rows[rows.length - 1]!.position
    const textRows = textLines.filter((line) => {
      const centerY = line.bbox.y + line.bbox.height / 2
      return centerY >= top - PDF_TABLE_LINE_TOLERANCE && centerY <= lastLine + PDF_TABLE_LINE_TOLERANCE &&
        line.bbox.x + line.bbox.width >= left - PDF_TABLE_LINE_TOLERANCE &&
        line.bbox.x <= right + PDF_TABLE_LINE_TOLERANCE
    })
    const multiColumnRows = textRows.filter((line) =>
      pdfTextLineColumnClusters(line, pageHeight).filter((cluster) =>
        cluster.start >= left - PDF_TABLE_LINE_TOLERANCE &&
        cluster.start <= right + PDF_TABLE_LINE_TOLERANCE).length >= 2)
    if (multiColumnRows.length < 3) continue
    const candidate: PdfDetectedGrid = {
      bbox: { x: left, y: top, width: right - left, height: lastLine - top },
      columns: [left, right],
      rows: rows.map((row) => row.position)
    }
    const columns = inferPdfGridColumnsFromText(candidate, textLines, pageHeight)
    if (columns.length < 3) continue
    // 行线通常位于每行单元格底边。只有最后一行文本实际越过末条线时才补虚拟底边，
    // 否则会生成没有内容的额外行，导致表格底部多出一条黑线。
    const textBottom = textRows.length > 0
      ? Math.max(...textRows.map((line) => line.bbox.y + line.bbox.height))
      : lastLine
    const bottom = textBottom > lastLine + PDF_TABLE_LINE_TOLERANCE
      ? Math.min(pageHeight, textBottom + PDF_TABLE_LINE_TOLERANCE)
      : lastLine
    const grid: PdfDetectedGrid = {
      bbox: { x: left, y: top, width: right - left, height: Math.min(pageHeight, bottom) - top },
      columns,
      rows: mergePdfGridCoordinates(rows.map((row) => row.position))
    }
    if (grid.bbox.width >= pageWidth * PDF_PAGE_FRAME_MIN_RATIO &&
      grid.bbox.height >= pageHeight * PDF_PAGE_FRAME_MIN_RATIO) continue
    candidates.push(grid)
  }
  return candidates
}

/**
 * 移除被精修后的多列网格覆盖的同边界单列候选。
 * 单列候选可能先被代码框规则选中，并把同一区域的多列表格一起过滤掉，
 * 因此必须在代码框判定前优先保留列数更多的候选。
 * @param grids 页面候选网格。
 * @returns 已去除冗余单列候选的网格数组。
 * @author zhenghq
 */
function preferPdfMultiColumnGrids(grids: readonly PdfDetectedGrid[]): PdfDetectedGrid[] {
  return grids.filter((grid) => !(grid.columns.length === 2 && grids.some((candidate) =>
    candidate !== grid &&
    candidate.columns.length > grid.columns.length &&
    pdfGridContainedBy(grid, candidate))))
}

/**
 * 判断两个候选网格是否共享一致的左右边界。
 * @param left 左侧候选网格。
 * @param right 右侧候选网格。
 * @returns 左右边界均在表格线容差内时返回 true。
 * @author zhenghq
 */
function pdfTableGridsShareHorizontalBounds(
  left: PdfDetectedGrid,
  right: PdfDetectedGrid
): boolean {
  return Math.abs(left.bbox.x - right.bbox.x) <= PDF_TABLE_LINE_TOLERANCE &&
    Math.abs(
      left.bbox.x + left.bbox.width - right.bbox.x - right.bbox.width
    ) <= PDF_TABLE_LINE_TOLERANCE
}

/**
 * 判断两个候选网格是否在纵向上相邻、重叠或仅存在微小间隙。
 * 只允许很短的间隙，避免把页面中宽度相同但语义独立的上下表格误合并。
 * @param top 上方候选网格。
 * @param bottom 下方候选网格。
 * @returns 纵向间距不超过容差时返回 true。
 * @author zhenghq
 */
function pdfTableGridsAreVerticallyAdjacent(
  top: PdfDetectedGrid,
  bottom: PdfDetectedGrid
): boolean {
  const topBottom = top.bbox.y + top.bbox.height
  const bottomTop = bottom.bbox.y
  return bottomTop - topBottom <= PDF_TABLE_LINE_TOLERANCE * 2
}

/**
 * 合并共享左右边界且纵向相邻的表格候选。
 * 部分 PDF 会把表头和数据区绘制成两个闭合网格，并让左右外框在接缝处
 * 短暂断开；不合并会让表头单独成为表格，数据区和外框线残留为普通文本或形状。
 * @param grids 已排除代码框的候选网格。
 * @returns 合并后的表格候选。
 * @author zhenghq
 */
function mergeAdjacentPdfTableGrids(
  grids: readonly PdfDetectedGrid[]
): PdfDetectedGrid[] {
  const sorted = [...grids].sort((left, right) =>
    left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
  const groups: PdfDetectedGrid[][] = []
  for (const grid of sorted) {
    const group = groups.find((candidateGroup) => candidateGroup.some((candidate) =>
      pdfTableGridsShareHorizontalBounds(candidate, grid) &&
      (pdfTableGridsAreVerticallyAdjacent(candidate, grid) ||
        pdfTableGridsAreVerticallyAdjacent(grid, candidate))))
    if (group) group.push(grid)
    else groups.push([grid])
  }
  return groups.map((group) => {
    if (group.length === 1) return group[0]!
    const left = Math.min(...group.map((grid) => grid.bbox.x))
    const top = Math.min(...group.map((grid) => grid.bbox.y))
    const right = Math.max(...group.map((grid) => grid.bbox.x + grid.bbox.width))
    const bottom = Math.max(...group.map((grid) => grid.bbox.y + grid.bbox.height))
    return {
      bbox: { x: left, y: top, width: right - left, height: bottom - top },
      columns: mergePdfGridCoordinates(group.flatMap((grid) => grid.columns)),
      rows: mergePdfGridCoordinates(group.flatMap((grid) => grid.rows))
    }
  })
}

/**
 * 判断单行网格是否只是包裹页眉 logo 的图片框。
 * 这类框没有数据行语义，若作为表格会让 logo 脱离普通流并把公司名挤进窄单元格。
 * @param grid 候选网格。
 * @param imageRegions 页面内嵌图片区域。
 * @returns 单行且包含小图片时返回 true。
 * @author zhenghq
 */
function isPdfHeaderImageGrid(
  grid: PdfDetectedGrid,
  imageRegions: readonly PdfEmbeddedImageRegion[]
): boolean {
  if (grid.rows.length !== 2) return false
  return imageRegions.some((region) => {
    const bbox = region.bbox
    const centerX = bbox.x + bbox.width / 2
    const centerY = bbox.y + bbox.height / 2
    const inside = centerX >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
      centerX <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE &&
      centerY >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
      centerY <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE
    return inside && bbox.width <= 80 && bbox.height <= 80
  })
}

/**
 * 判断文本是否位于指定网格内部。
 * @param line PDF 文本行。
 * @param grid 候选网格。
 * @returns 文本行与网格相交时返回 true。
 * @author zhenghq
 */
function pdfLineIntersectsGrid(line: PdfLine, grid: PdfDetectedGrid): boolean {
  return line.bbox.x + line.bbox.width >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
    line.bbox.x <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE &&
    line.bbox.y + line.bbox.height >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
    line.bbox.y <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE
}

/**
 * 判断字体名称是否明确指向等宽或代码字体。
 * @param fontFamily PDF.js 提供的字体名称。
 * @returns 字体名称具有等宽或代码语义时返回 true。
 * @author zhenghq
 */
function isPdfMonospaceFontFamily(fontFamily: string | undefined): boolean {
  return Boolean(fontFamily && /(?:mono|courier|consolas|menlo|monaco|code|lucida\s*console)/iu.test(fontFamily))
}

/**
 * 判断单列闭合网格是否实际是代码框，而不是无边框表格。
 * 代码框通常由左右边线和顶底横线组成，内部没有列分隔线；部分 PDF 只有外框，
 * 不会为每一行生成内部横线。只有多行、等宽字体或代码符号密集时才排除，
 * 避免把真正的单列表格误判为代码。
 * @param grid 候选闭合网格。
 * @param lines 页面全部文本行。
 * @param styles PDF.js 字体样式映射。
 * @returns 单列网格具有代码框特征时返回 true。
 * @author zhenghq
 */
function isPdfCodeFrameGrid(
  grid: PdfDetectedGrid,
  lines: readonly PdfLine[],
  styles: Record<string, PdfTextStyle>
): boolean {
  if (grid.columns.length !== 2) return false
  const insideLines = lines.filter((line) => pdfLineIntersectsGrid(line, grid))
  if (insideLines.length < 2) return false
  const items = insideLines.flatMap((line) => line.items)
  const text = items.map((item) => item.str).join('')
  if (!text.trim()) return false
  const monospace = items.some((item) => {
    const style = item.fontName ? styles[item.fontName] : undefined
    return isPdfMonospaceFontFamily(item.fontName) ||
      isPdfMonospaceFontFamily(style?.fontName) ||
      isPdfMonospaceFontFamily(style?.fontFamily)
  })
  const codeSymbols = text.match(/[{}()[\];=<>./\\:_$@#]/gu)?.length ?? 0
  const symbolDensity = codeSymbols / Math.max(1, text.length)
  const hasCodeShape = /(?:=>|::|;\s*$|[{}]\s*$)/mu.test(text)
  return monospace || symbolDensity >= 0.06 || (hasCodeShape && codeSymbols >= 3)
}

/**
 * 从页面网格中排除代码框，避免其被表格接管后丢失边框。
 * @param grids 已识别候选网格。
 * @param lines 页面全部文本行。
 * @param styles PDF.js 字体样式映射。
 * @returns 排除代码框后的表格网格。
 * @author zhenghq
 */
function filterPdfCodeFrameGrids(
  grids: readonly PdfDetectedGrid[],
  lines: readonly PdfLine[],
  styles: Record<string, PdfTextStyle>
): PdfDetectedGrid[] {
  const codeFrames = selectPdfCodeFrames(grids, lines, styles)
  return grids.filter((grid) => !codeFrames.some((frame) =>
    grid === frame || pdfGridContainedBy(frame, grid)))
}

/**
 * 判断单列网格是否只是开放章节或代码容器的局部横线区域。
 * 真实 PDF 的开放容器左右边线会越过候选网格的上下边界，内部只有少量分隔横线；
 * 这种结构没有逐行闭合语义，不能按单列表格接管正文，否则长竖线会残留在译文中。
 * @param grid 候选网格。
 * @param lines 页面全部去重线段。
 * @returns 网格是开放容器的局部区域时返回 true。
 * @author zhenghq
 */
function isPdfOpenContainerGrid(
  grid: PdfDetectedGrid,
  lines: readonly PdfGridLine[]
): boolean {
  if (grid.columns.length !== 2) return false
  const top = grid.bbox.y
  const bottom = top + grid.bbox.height
  const left = grid.bbox.x
  const right = left + grid.bbox.width
  const vertical = lines.filter((line) => line.orientation === 'vertical')
  const leftBorder = vertical.some((line) =>
    Math.abs(line.position - left) <= PDF_TABLE_LINE_TOLERANCE &&
    line.start <= top + PDF_TABLE_LINE_TOLERANCE &&
    line.end > bottom + PDF_TABLE_LINE_TOLERANCE)
  const rightBorder = vertical.some((line) =>
    Math.abs(line.position - right) <= PDF_TABLE_LINE_TOLERANCE &&
    line.start <= top + PDF_TABLE_LINE_TOLERANCE &&
    line.end > bottom + PDF_TABLE_LINE_TOLERANCE)
  return leftBorder && rightBorder
}

/**
 * 从表格候选中移除开放容器的局部网格。
 * 开放容器不是表格，保留它会让左右贯穿竖线进入形状层并与译文行高错位。
 * @param grids 已识别候选网格。
 * @param lines 页面全部去重线段。
 * @returns 移除开放容器后的表格候选。
 * @author zhenghq
 */
function filterPdfOpenContainerGrids(
  grids: readonly PdfDetectedGrid[],
  lines: readonly PdfGridLine[]
): PdfDetectedGrid[] {
  return grids.filter((grid) => !isPdfOpenContainerGrid(grid, lines))
}

/**
 * 收敛重叠的代码框候选，仅保留最外层代码框。
 * 真实 PDF 会为同一个代码框生成完整外框和多个逐行局部网格；若全部保留，
 * 局部网格的上下边会被重复补成外框，造成译文页内部黑线。
 * @param grids 已识别候选网格。
 * @param lines 页面全部文本行。
 * @param styles PDF.js 字体样式映射。
 * @returns 去重且仅保留最外层的代码框。
 * @author zhenghq
 */
function selectPdfCodeFrames(
  grids: readonly PdfDetectedGrid[],
  lines: readonly PdfLine[],
  styles: Record<string, PdfTextStyle>
): PdfDetectedGrid[] {
  const codeFrames = grids.filter((grid) => isPdfCodeFrameGrid(grid, lines, styles))
  // 同一代码框的完整外框与逐行局部候选会覆盖相同文本行，保留覆盖范围最大的
  // 候选即可；随后只合并真正相邻但互不重叠的逐行候选。
  const completeFrames = codeFrames.filter((grid) => !codeFrames.some((candidate) =>
    candidate !== grid &&
    pdfGridContainedBy(candidate, grid) &&
    lines.filter((line) => pdfLineCenterInsideGrid(line, candidate)).length >=
      lines.filter((line) => pdfLineCenterInsideGrid(line, grid)).length))
  return mergeAdjacentPdfCodeFrameRows(completeFrames, lines)
}

/**
 * 按代码框候选覆盖的文本区域合并逐行网格。
 * 部分 PDF 的逐行横线会与相邻行边界重合，导致候选框彼此相交而无法仅靠
 * 几何关系区分。这里把横向范围一致、文本纵向连续且都属于代码风格的候选
 * 归入同一代码区域。
 * @param grids 已识别代码框候选。
 * @param lines 页面文本行。
 * @returns 合并后的代码框。
 * @author zhenghq
 */
function mergePdfCodeFrameRows(
  grids: readonly PdfDetectedGrid[],
  lines: readonly PdfLine[]
): PdfDetectedGrid[] {
  const sorted = [...grids].sort((left, right) => left.bbox.y - right.bbox.y)
  // 同一代码框的局部候选会覆盖不同的文本行范围。保留覆盖行数最多的候选，
  // 并合并与它共享文本行的所有局部候选，避免它们各自生成代码块。
  const selected: PdfDetectedGrid[] = []
  // 先按覆盖行数从多到少处理，完整外框会吸收所有逐行局部候选。
  for (const grid of [...sorted].sort((left, right) =>
    lines.filter((line) => pdfLineCenterInsideGrid(line, right)).length -
    lines.filter((line) => pdfLineCenterInsideGrid(line, left)).length)) {
    const gridLines = lines.filter((line) => pdfLineCenterInsideGrid(line, grid))
    const overlapping = selected.find((candidate) => {
      const candidateLines = lines.filter((line) => pdfLineCenterInsideGrid(line, candidate))
      return candidateLines.some((line) => gridLines.includes(line))
    })
    if (!overlapping) selected.push(grid)
  }
  return selected
}

/**
 * 合并相邻的逐行代码框候选。
 * @param grids 已识别代码框候选。
 * @param lines 页面文本行。
 * @returns 合并后的代码框。
 * @author zhenghq
 */
function mergeAdjacentPdfCodeFrameRows(
  grids: readonly PdfDetectedGrid[],
  lines: readonly PdfLine[]
): PdfDetectedGrid[] {
  const sorted = [...grids].sort((left, right) => left.bbox.y - right.bbox.y)
  const groups: PdfDetectedGrid[][] = []
  for (const grid of sorted) {
    const containingGroup = groups.find((group) => group.some((candidate) =>
      pdfCodeGridsShareTextFlow(candidate, grid, lines)))
    if (containingGroup) containingGroup.push(grid)
    else groups.push([grid])
  }
  return groups.map((group) => {
    const left = Math.min(...group.map((grid) => grid.bbox.x))
    const top = Math.min(...group.map((grid) => grid.bbox.y))
    const right = Math.max(...group.map((grid) => grid.bbox.x + grid.bbox.width))
    const bottom = Math.max(...group.map((grid) => grid.bbox.y + grid.bbox.height))
    return {
      bbox: { x: left, y: top, width: right - left, height: bottom - top },
      columns: mergePdfGridCoordinates(group.flatMap((grid) => grid.columns)),
      rows: mergePdfGridCoordinates(group.flatMap((grid) => grid.rows))
    }
  })
}

/**
 * 判断两个代码框候选是否具有一致的横向边界。
 * @param left 左侧候选。
 * @param right 右侧候选。
 * @returns 左右边界均在解析容差内时返回 true。
 * @author zhenghq
 */
function pdfGridsShareHorizontalCodeBounds(
  left: PdfDetectedGrid,
  right: PdfDetectedGrid
): boolean {
  const tolerance = PDF_TABLE_LINE_TOLERANCE
  return Math.abs(left.bbox.x - right.bbox.x) <= tolerance &&
    Math.abs(left.bbox.x + left.bbox.width - right.bbox.x - right.bbox.width) <= tolerance
}

/**
 * 判断代码框候选是否覆盖至少两条文本行。
 * @param grid 代码框候选。
 * @param lines 页面文本行。
 * @returns 覆盖两条及以上文本行时返回 true。
 * @author zhenghq
 */
function pdfGridContainsMultipleTextLines(
  grid: PdfDetectedGrid,
  lines: readonly PdfLine[]
): boolean {
  return lines.filter((line) => pdfLineInsideGrid(line, grid)).length >= 2
}

/**
 * 判断两个逐行代码框候选是否属于同一连续文本流。
 * @param left 左侧候选。
 * @param right 右侧候选。
 * @param lines 页面文本行。
 * @returns 两个候选横向对齐且文本行间距连续时返回 true。
 * @author zhenghq
 */
function pdfCodeGridsShareTextFlow(
  left: PdfDetectedGrid,
  right: PdfDetectedGrid,
  lines: readonly PdfLine[]
): boolean {
  // 逐行候选的外框可能因 0.72pt 线宽和浮点误差而彼此不完全相接，
  // 因此不要求网格几何相交，只要求横向范围和文本行距连续。
  const horizontalTolerance = Math.max(3, PDF_TABLE_LINE_TOLERANCE * 1.5)
  if (Math.abs(left.bbox.x - right.bbox.x) > horizontalTolerance) return false
  if (Math.abs(left.bbox.x + left.bbox.width - right.bbox.x - right.bbox.width) >
    horizontalTolerance) return false
  // 代码行文本通常只占框内一小段宽度，不能用“完整落入网格”判断归属；
  // 应使用文本中心点，与表格单元格的归属规则保持一致。
  const leftLines = lines.filter((line) => pdfLineCenterInsideGrid(line, left))
  const rightLines = lines.filter((line) => pdfLineCenterInsideGrid(line, right))
  if (leftLines.length === 0 || rightLines.length === 0) return false
  // 逐行候选可能只覆盖一条文本行，且外框高度彼此重叠。若两者共用同一条
  // 内部横线，也应视为同一代码框的相邻行。
  const sharesRowBoundary = left.rows.some((row) => right.rows.some((candidate) =>
    Math.abs(row - candidate) <= PDF_TABLE_LINE_TOLERANCE))
  if (sharesRowBoundary) return true
  const leftBottom = Math.max(...leftLines.map((line) => line.bbox.y + line.bbox.height))
  const rightTop = Math.min(...rightLines.map((line) => line.bbox.y))
  const fontSize = Math.max(leftLines[0]!.items[0]?.height ?? 0, rightLines[0]!.items[0]?.height ?? 0)
  return rightTop - leftBottom <= Math.max(fontSize * 3, PDF_TABLE_LINE_TOLERANCE * 3)
}

/**
 * 判断视觉行中心是否位于网格内部。
 * @param line PDF 视觉行。
 * @param grid 目标网格。
 * @returns 行中心位于网格内时返回 true。
 * @author zhenghq
 */
function pdfLineCenterInsideGrid(line: PdfLine, grid: PdfDetectedGrid): boolean {
  const centerX = line.bbox.x + line.bbox.width / 2
  const centerY = line.bbox.y + line.bbox.height / 2
  return centerX >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
    centerX <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE &&
    centerY >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
    centerY <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE
}

/**
 * 判断两个网格是否相交或边界相接。
 * @param left 左侧网格。
 * @param right 右侧网格。
 * @returns 两个网格存在交叠或相邻时返回 true。
 * @author zhenghq
 */
function pdfGridsOverlapOrTouch(left: PdfDetectedGrid, right: PdfDetectedGrid): boolean {
  const tolerance = PDF_TABLE_LINE_TOLERANCE
  return left.bbox.x <= right.bbox.x + right.bbox.width + tolerance &&
    left.bbox.x + left.bbox.width >= right.bbox.x - tolerance &&
    left.bbox.y <= right.bbox.y + right.bbox.height + tolerance &&
    left.bbox.y + left.bbox.height >= right.bbox.y - tolerance
}

/**
 * 判断两个网格边界是否在解析容差内相同。
 * @param left 左侧网格。
 * @param right 右侧网格。
 * @returns 四条边界均接近时返回 true。
 * @author zhenghq
 */
function pdfGridsHaveSameBounds(left: PdfDetectedGrid, right: PdfDetectedGrid): boolean {
  const tolerance = PDF_TABLE_LINE_TOLERANCE
  return Math.abs(left.bbox.x - right.bbox.x) <= tolerance &&
    Math.abs(left.bbox.y - right.bbox.y) <= tolerance &&
    Math.abs(left.bbox.width - right.bbox.width) <= tolerance &&
    Math.abs(left.bbox.height - right.bbox.height) <= tolerance
}

/**
 * 按代码框内片段几何间距恢复源码空格。
 * 纯空白文本项会被 PDF 文本分组过滤，因此只能利用相邻片段之间的实际水平间隔判断。
 * @param line 代码框内的视觉行。
 * @param contentLeft 代码框内所有可见行的最左基准，用于恢复 PDF.js 丢弃的行首空格。
 * @returns 补齐空格后的文本项副本。
 * @author zhenghq
 */
function restorePdfCodeLineSpacing(line: PdfLine, contentLeft = line.bbox.x): PdfTextItem[] {
  const result: PdfTextItem[] = []
  const leadingItem = line.items.find((item) => item.str)
  const leadingIndent = leadingItem
    ? Math.max(0, (leadingItem.transform?.[4] ?? contentLeft) - contentLeft)
    : 0
  // PDF.js 可能把行首单词与后续片段拆开；空白片段会被过滤，因此首片段
  // 也需要和紧随其后的片段比较间距，否则 `final HTTPAgent` 会粘成
  // `finalHTTPAgent`。首片段按原顺序先收集，再统一补齐片段间空格。
  for (const item of line.items) {
    if (!item.str) {
      result.push(item)
      continue
    }
    let previous: PdfTextItem | undefined
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index]!.str) {
        previous = result[index]
        break
      }
    }
    if (!previous) {
      // PDF.js 会丢弃纯空白文本项，行首缩进只能根据首个可见片段相对代码内容左基准恢复。
      const indent = item === leadingItem && leadingIndent > Math.max(0.5, (item.height ?? 0) * 0.25)
        ? ' '.repeat(Math.max(1, Math.round(leadingIndent / Math.max(1, (item.height ?? 1) * 0.5))))
        : ''
      result.push(indent ? { ...item, str: `${indent}${item.str}` } : item)
      continue
    }
    const previousRight = (previous.transform?.[4] ?? 0) + (previous.width ?? 0)
    const gap = (item.transform?.[4] ?? 0) - previousRight
    const fontSize = Math.max(previous.height ?? 0, item.height ?? 0)
    const needsSpace = gap > Math.max(0.5, fontSize * 0.15) &&
      !/[\s([{]$/u.test(previous.str) &&
      !/^[\s,.;:)\]}]/u.test(item.str)
    result.push(needsSpace ? { ...item, str: ` ${item.str}` } : item)
  }
  return result
}

/**
 * 判断视觉行是否完整位于代码框内部。
 * @param line PDF 视觉行。
 * @param codeFrames 已识别的代码框。
 * @returns 行边界完整落在任一代码框内时返回 true。
 * @author zhenghq
 */
function isPdfLineInsideCodeFrame(
  line: PdfLine,
  codeFrames: readonly PdfDetectedGrid[]
): boolean {
  return codeFrames.some((frame) => pdfLineCenterInsideGrid(line, frame))
}

/**
 * 判断候选网格是否完整位于另一个网格内部。
 * 代码框会同时产生完整外框和逐行单列表格候选，必须按外框整体排除内部候选。
 * @param container 外层候选网格。
 * @param candidate 待检查的内层候选网格。
 * @returns 内层网格边界全部位于外层网格内时返回 true。
 * @author zhenghq
 */
function pdfGridContainedBy(
  container: PdfDetectedGrid,
  candidate: PdfDetectedGrid
): boolean {
  const tolerance = PDF_TABLE_LINE_TOLERANCE
  return candidate.bbox.x >= container.bbox.x - tolerance &&
    candidate.bbox.y >= container.bbox.y - tolerance &&
    candidate.bbox.x + candidate.bbox.width <=
      container.bbox.x + container.bbox.width + tolerance &&
    candidate.bbox.y + candidate.bbox.height <=
      container.bbox.y + container.bbox.height + tolerance
}

/**
 * 移除被其他候选网格完整包含的局部网格。
 * @param grids 候选网格。
 * @returns 仅保留最外层候选的网格数组。
 * @author zhenghq
 */
function filterNestedPdfTableGrids(grids: readonly PdfDetectedGrid[]): PdfDetectedGrid[] {
  return grids.filter((grid, index) => !grids.some((candidate, candidateIndex) =>
    candidateIndex !== index &&
    // 表单外框候选可能比内部数据表更高；只有候选在内部列线终点处仍闭合时才允许覆盖。
    candidate.rows.includes(grid.rows[grid.rows.length - 1]!) &&
    candidate.bbox.x <= grid.bbox.x + PDF_TABLE_LINE_TOLERANCE &&
    candidate.bbox.y <= grid.bbox.y + PDF_TABLE_LINE_TOLERANCE &&
    candidate.bbox.x + candidate.bbox.width >= grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE &&
    candidate.bbox.y + candidate.bbox.height >= grid.bbox.y + grid.bbox.height - PDF_TABLE_LINE_TOLERANCE &&
    (candidate.bbox.width > grid.bbox.width + PDF_TABLE_LINE_TOLERANCE ||
      candidate.bbox.height > grid.bbox.height + PDF_TABLE_LINE_TOLERANCE)
  ))
}

/**
 * 判断闭合网格是否只是覆盖整页的页面边框。
 * @param grid 已识别的闭合网格。
 * @param pageWidth 页面宽度。
 * @param pageHeight 页面高度。
 * @returns 网格宽高都接近整页时返回 true。
 * @author zhenghq
 */
function isPdfPageFrameGrid(
  grid: PdfDetectedGrid,
  pageWidth: number,
  pageHeight: number
): boolean {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    return false
  }
  return grid.bbox.width >= pageWidth * PDF_PAGE_FRAME_MIN_RATIO &&
    grid.bbox.height >= pageHeight * PDF_PAGE_FRAME_MIN_RATIO
}

/**
 * 过滤空文本项后，将绘制颜色按顺序绑定到实际可见的文本项。
 * @param items PDF.js 文本项。
 * @param colors 文本显示操作对应的颜色。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyPdfTextColors(items: PdfTextItem[], colors: readonly (string | undefined)[]): void {
  let colorIndex = 0
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue
    const color = colors[colorIndex]
    colorIndex += 1
    if (color) item.color = color
  }
}

/**
 * 构造 PDF 文本片段样式。
 * @param item 文本项。
 * @param style PDF.js 字体样式。
 * @returns 文本样式。
 * @author zhenghq
 */
function pdfTextStyle(item: PdfTextItem, style: PdfTextStyle | undefined): DocumentTextStyle {
  const fontFlags = pdfFontStyleFlags(item.fontName, style)
  return {
    fontSize: fontSizeFromTransform(item.transform, item.height),
    ...(item.color ? { color: item.color } : {}),
    ...(style?.fontName
      ? { fontFamily: style.fontName }
      : style?.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(fontFlags.fontWeight ? { fontWeight: fontFlags.fontWeight } : {}),
    ...(fontFlags.italic ? { italic: true } : {})
  }
}

/**
 * 从 PDF.js 字体对象或字体名称推断粗体与斜体。
 * @param fontName PDF.js 文本项使用的字体键。
 * @param style PDF.js 字体样式；部分版本会附加字体对象。
 * @returns 可写入统一模型的字重与斜体标记。
 * @author zhenghq
 */
function pdfFontStyleFlags(
  fontName: string | undefined,
  style: PdfTextStyle | undefined
): { fontWeight?: number; italic?: boolean } {
  const fontObject = style as (PdfTextStyle & {
    bold?: unknown
    italic?: unknown
    name?: unknown
  }) | undefined
  const descriptor = [
    typeof fontObject?.name === 'string' ? fontObject.name : '',
    typeof fontObject?.fontFamily === 'string' ? fontObject.fontFamily : '',
    fontName ?? ''
  ].join(' ')
  const bold = fontObject?.bold === true || style?.fontWeight === 700 ||
    /bold|black|heavy|semibold|demi/iu.test(descriptor)
  const italic = fontObject?.italic === true || /italic|oblique/iu.test(descriptor)
  return {
    ...(bold ? { fontWeight: 700 } : {}),
    ...(italic ? { italic: true } : {})
  }
}

/**
 * 根据文本项变换矩阵计算页面坐标。
 * @param item 文本项。
 * @param pageHeight 页面高度。
 * @returns 页面坐标边界框。
 * @author zhenghq
 */
function textItemBoundingBox(item: PdfTextItem, pageHeight: number): DocumentBoundingBox {
  const transform = item.transform ?? []
  const x = transform[4] ?? 0
  const baseline = transform[5] ?? pageHeight
  const fontSize = fontSizeFromTransform(transform, item.height)
  return {
    x,
    y: Math.max(0, pageHeight - baseline - fontSize),
    width: Math.max(1, item.width ?? 1),
    height: Math.max(1, item.height ?? fontSize)
  }
}

/**
 * 读取文本项在 PDF 页面坐标系中的原始基线。
 * @param item 文本项。
 * @param pageHeight 页面高度。
 * @returns 自页面顶部向下的基线坐标。
 * @author zhenghq
 */
function textItemBaseline(item: PdfTextItem, pageHeight: number): number {
  const transform = item.transform ?? []
  const baseline = transform[5] ?? pageHeight
  return pageHeight - baseline
}

/**
 * 合并相邻且基线接近的 PDF 文本项，恢复阅读顺序与行边界。
 * @param items PDF 文本项。
 * @param pageHeight 页面高度。
 * @returns 按行分组的文本片段。
 * @author zhenghq
 */
function groupPdfTextItems(items: PdfTextItem[], pageHeight: number): PdfLine[] {
  const lines: PdfLine[] = []
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue
    const bbox = textItemBoundingBox(item, pageHeight)
    const last = lines[lines.length - 1]
    const sameLine = last && Math.abs(last.bbox.y - bbox.y) <= Math.max(2, Math.min(last.bbox.height, bbox.height) * 0.5)
    if (sameLine) {
      // 此处只按原始片段顺序合并。表格单元格不能凭空获得前导空格；
      // 代码框会在识别后根据片段几何间距单独恢复源码空格。
      last.items.push(item)
      const right = Math.max(last.bbox.x + last.bbox.width, bbox.x + bbox.width)
      const top = Math.min(last.bbox.y, bbox.y)
      const bottom = Math.max(last.bbox.y + last.bbox.height, bbox.y + bbox.height)
      last.bbox = { x: Math.min(last.bbox.x, bbox.x), y: top, width: right - Math.min(last.bbox.x, bbox.x), height: bottom - top }
      last.baseline = Math.min(last.baseline, textItemBaseline(item, pageHeight))
    } else {
      lines.push({ items: [item], bbox, baseline: textItemBaseline(item, pageHeight) })
    }
  }
  return lines
}

/**
 * 从相邻行基线推进估算正文行高，过滤跨段落的大间距和异常跳跃。
 * @param lines 页面内按阅读顺序分组的文本行。
 * @returns 正文字号到行高的推荐映射。
 * @author zhenghq
 */
function inferPdfLineHeights(lines: readonly PdfLine[]): Map<PdfLine, number> {
  const result = new Map<PdfLine, number>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const size = fontSizeFromTransform(line.items[0]?.transform, line.items[0]?.height)
    let nextBaseline: number | undefined
    const next = lines[index + 1]
    if (next) {
      const nextSize = fontSizeFromTransform(next.items[0]?.transform, next.items[0]?.height)
      const advance = next.baseline - line.baseline
      const sameLeftEdge = Math.abs(next.bbox.x - line.bbox.x) <= Math.max(2, size * 0.25)
      if (sameLeftEdge && Math.abs(nextSize - size) <= Math.max(1.5, size * 0.2) &&
        advance >= size * 1.02 && advance <= size * 3) {
        nextBaseline = advance
      }
    }
    if (nextBaseline !== undefined) {
      result.set(line, Math.round(nextBaseline * 100) / 100)
    }
  }
  return result
}

/**
 * 将 PDF 字体资源名规范化为可比较的基础字体族，忽略子集前缀、样式后缀和标点差异。
 * @param fontFamily PDF.js 提供的字体资源名或字体族。
 * @returns 用于段落样式比较的小写字体族；没有字体信息时返回空字符串。
 * @author zhenghq
 */
function normalizePdfParagraphFontFamily(fontFamily: string | undefined): string {
  if (!fontFamily) return ''
  return fontFamily
    .replace(/^[A-Z]{6}\+/u, '')
    .replace(/[,_+\s-]+/gu, '')
    .replace(/(?:bold|black|heavy|semibold|demi|italic|oblique)$/u, '')
    .toLowerCase()
}

/**
 * 读取 PDF 视觉行的主导文本样式，用于判断相邻行是否属于同一段落。
 * 行首数字、项目符号或短强调片段通常只占少量字符，不能代表整行的正文样式。
 * @param line PDF 视觉行。
 * @param styles PDF.js 字体样式映射。
 * @returns 行内按有效字符数加权后的主导样式；行内没有文本时返回 undefined。
 * @author zhenghq
 */
function pdfLineDominantStyle(
  line: PdfLine,
  styles: Record<string, PdfTextStyle>
): DocumentTextStyle | undefined {
  const candidates = line.items.map((item, index) => {
    const normalized = item.str.replace(/\s/gu, '')
    const marker = /^(?:[•●▪◦·*\uF0B7\uFFFD-]|\d+[.)、．]|[A-Za-z][.)])/u.exec(normalized)?.[0] ?? ''
    const trailingPunctuation = normalized.endsWith('。') || normalized.endsWith('.')
      ? 1
      : 0
    return {
      item,
      index,
      weight: normalized.length - marker.length - trailingPunctuation
    }
  }).filter((candidate) => candidate.weight > 0)
  if (candidates.length === 0) return undefined

  const dominant = candidates.reduce((best, candidate) => {
    const bestStyle = pdfTextStyle(best.item, best.item.fontName ? styles[best.item.fontName] : undefined)
    const candidateStyle = pdfTextStyle(candidate.item, candidate.item.fontName ? styles[candidate.item.fontName] : undefined)
    if (candidate.weight !== best.weight) return candidate.weight > best.weight ? candidate : best
    return samePdfParagraphStyle(candidateStyle, bestStyle) ? best : candidate.index < best.index ? candidate : best
  })
  const fontStyle = dominant.item.fontName ? styles[dominant.item.fontName] : undefined
  return pdfTextStyle(dominant.item, {
    ...fontStyle,
    ...(dominant.item.fontName ? { key: dominant.item.fontName } : {})
  })
}

/**
 * 判断两段 PDF 文本样式是否足够一致，避免把正文与强调、标题或不同颜色内容粘成一段。
 * @param left 前一个文本样式。
 * @param right 后一个文本样式。
 * @returns 可视为同一段落样式时返回 true。
 * @author zhenghq
 */
function samePdfParagraphStyle(
  left: DocumentTextStyle | undefined,
  right: DocumentTextStyle | undefined
): boolean {
  if (!left || !right) return left === right
  const leftSize = left.fontSize ?? 0
  const rightSize = right.fontSize ?? 0
  return Math.abs(leftSize - rightSize) <= Math.max(0.25, leftSize * 0.03) &&
    normalizePdfParagraphFontFamily(left.fontFamily) === normalizePdfParagraphFontFamily(right.fontFamily) &&
    left.fontWeight === right.fontWeight &&
    left.color === right.color &&
    left.italic === right.italic
}

/**
 * 判断视觉行是否以条款、章节或列表编号开头，这些行必须开启新的翻译段落。
 * @param text 视觉行文本。
 * @returns 是语义段落起始行时返回 true。
 * @author zhenghq
 */
function startsPdfSemanticParagraph(text: string): boolean {
  const normalized = text.trim()
  return /^(?:第[〇零一二三四五六七八九十百千万两\d]+(?:条|章|节|款|项)|[（(][〇零一二三四五六七八九十百千万两\d]+[）)]|[〇零一二三四五六七八九十百千万两\d]+[、.．]|[•●▪◦·*\uF0B7\uFFFD-]\s*|\d+[.)、．]\s*|[A-Za-z][.)]\s*)/u
    .test(normalized)
}

/** PDF 目录行中拆分出的标题、引导点与页码。 */
interface PdfTableOfContentsEntry {
  /** 可翻译的目录标题。 */
  title: string
  /** 原样保留的引导点。 */
  leader: string
  /** 原样保留的目录页码。 */
  pageNumber: string
}

/**
 * 识别 PDF 目录行并拆分标题、引导点和页码。
 * 引导点至少连续八个，避免把正文中的普通省略号误判成目录。
 * @param text 同一视觉行的完整文本。
 * @returns 目录项信息；不是目录行时返回 undefined。
 * @author zhenghq
 */
function parsePdfTableOfContentsLine(text: string): PdfTableOfContentsEntry | undefined {
  const match = /^(.+?)(\s*(?:[.…·]\s*){8,})(\d{1,4})\s*$/u.exec(text)
  if (!match) return undefined
  const title = match[1]?.trim() ?? ''
  const leader = match[2]?.replace(/\s/gu, '') ?? ''
  const pageNumber = match[3]?.trim() ?? ''
  if (!title || !pageNumber || !/^[.…·]{8,}$/u.test(leader)) return undefined
  return { title, leader, pageNumber }
}

/**
 * 移除 PDF 列表标记，返回列表正文起始位置，用于判断悬挂缩进是否属于正文列。
 * @param text 视觉行文本。
 * @returns 列表正文起始字符索引；不是列表行时返回 undefined。
 * @author zhenghq
 */
function pdfSemanticParagraphContentStart(text: string): number | undefined {
  const match = /^(?:[•●▪◦·*\uF0B7\uFFFD-]|\d+[.)、．]|[A-Za-z][.)])\s*/u.exec(text)
  return match ? match[0].length : undefined
}

/**
 * 判断视觉行是否以完整句末标点结束，用于识别悬挂缩进位置上的新自然段。
 * @param text 视觉行文本。
 * @returns 去除句末引号或右括号后仍以句末标点结束时返回 true。
 * @author zhenghq
 */
function endsPdfSemanticSentence(text: string): boolean {
  const normalized = text.trimEnd().replace(/[”’」』】）)\]]+$/u, '')
  return /[。！？!?…]$/u.test(normalized) || /\.$/u.test(normalized)
}

/**
 * 判断两行在水平方向是否有足够重叠，避免把双栏或左右并排内容合并为一段。
 * @param previous 前一视觉行。
 * @param current 当前视觉行。
 * @returns 水平重叠达到较短行宽四分之一时返回 true。
 * @author zhenghq
 */
function pdfLinesHaveHorizontalOverlap(previous: PdfLine, current: PdfLine): boolean {
  const overlap = Math.min(
    previous.bbox.x + previous.bbox.width,
    current.bbox.x + current.bbox.width
  ) - Math.max(previous.bbox.x, current.bbox.x)
  const shorterWidth = Math.min(previous.bbox.width, current.bbox.width)
  return overlap > 0 && overlap >= Math.max(2, shorterWidth * 0.25)
}

/**
 * 判断相邻视觉行之间是否需要补空格，英文单词换行补空格，中文换行直接拼接。
 * @param previousText 前一视觉行文本。
 * @param currentText 当前视觉行文本。
 * @returns 需要插入一个空格时返回 true。
 * @author zhenghq
 */
function needsPdfLineSeparator(previousText: string, currentText: string): boolean {
  const previous = previousText.trimEnd()
  const current = currentText.trimStart()
  if (!previous || !current) return false
  const previousCharacter = previous.at(-1) ?? ''
  const currentCharacter = current[0] ?? ''
  if (/\s/u.test(previousCharacter) || /\s/u.test(currentCharacter)) return false
  const hasCjkBoundary = /[\u3400-\u9fff]/u.test(previousCharacter) ||
    /[\u3400-\u9fff]/u.test(currentCharacter)
  if (hasCjkBoundary) return false
  if (/[.,;:!?%)\]}]/u.test(currentCharacter)) return false
  return !/[(\[{/-]$/u.test(previousCharacter)
}

/**
 * 判断当前视觉行能否并入上一段落。
 * @param paragraph 当前已聚合段落。
 * @param previous 段落内最后一个视觉行。
 * @param current 当前视觉行。
 * @param pageWidth 页面宽度。
 * @param bodyFontSize 页面正文主字号。
 * @param styles PDF.js 字体样式映射。
 * @param contentArea 页面正文内容区。
 * @returns 可继续合并时返回 true。
 * @author zhenghq
 */
function canMergePdfParagraphLine(
  paragraph: PdfParagraph,
  previous: PdfLine,
  current: PdfLine,
  pageWidth: number,
  bodyFontSize: number,
  styles: Record<string, PdfTextStyle>,
  contentArea?: { left: number; right: number; center: number }
): boolean {
  const previousStyle = pdfLineDominantStyle(previous, styles)
  const currentStyle = pdfLineDominantStyle(current, styles)
  if (!samePdfParagraphStyle(previousStyle, currentStyle)) return false
  const previousSize = previousStyle?.fontSize ?? 0
  const currentSize = currentStyle?.fontSize ?? 0
  const headingThreshold = Math.max(14, bodyFontSize * 1.2)
  if (previousSize >= headingThreshold || currentSize >= headingThreshold) return false
  const previousAlign = inferPdfTextAlignment(
    previous.bbox,
    pageWidth,
    previousSize,
    bodyFontSize,
    contentArea
  )
  const currentAlign = inferPdfTextAlignment(
    current.bbox,
    pageWidth,
    currentSize,
    bodyFontSize,
    contentArea
  )
  if (previousAlign === 'center' || previousAlign === 'right' ||
    currentAlign === 'center' || currentAlign === 'right') return false
  const baselineAdvance = current.baseline - previous.baseline
  const minimumAdvance = Math.max(1, Math.max(previousSize, currentSize) * 1.02)
  const maximumAdvance = Math.max(previousSize, currentSize) * 3
  if (baselineAdvance < minimumAdvance || baselineAdvance > maximumAdvance) return false
  if (paragraph.lineHeight !== undefined &&
    Math.abs(baselineAdvance - paragraph.lineHeight) > Math.max(1, currentSize * 0.25)) return false
  if (!pdfLinesHaveHorizontalOverlap(previous, current)) return false
  const previousText = previous.items.map((item) => item.str).join('')
  const currentText = current.items.map((item) => item.str).join('')
  // 目录项必须逐行独立翻译，否则相邻条目或后续正文会被并进同一个目录块。
  if (parsePdfTableOfContentsLine(previousText) || parsePdfTableOfContentsLine(currentText)) {
    return false
  }
  // 当前行开启新的列表或条款时必须分段。
  if (startsPdfSemanticParagraph(currentText)) return false
  const indentation = current.bbox.x - previous.bbox.x
  if (indentation > Math.max(8, currentSize * 0.8)) {
    const previousStartsParagraph = startsPdfSemanticParagraph(previousText)
    const markerWidth = previousStartsParagraph ? previous.items[0]?.width : undefined
    const previousBodyX = previous.items[1]?.transform?.[4] ??
      (markerWidth === undefined ? previous.bbox.x : previous.bbox.x + markerWidth)
    if (Math.abs(current.bbox.x - previousBodyX) > Math.max(2, currentSize * 0.25)) return false
    // 悬挂缩进既可能是列表续行，也可能是列表后的新自然段；上一行已经完整结束句时不能继续吞并。
    if (previousStartsParagraph && endsPdfSemanticSentence(previousText)) return false
  }
  return true
}

/**
 * 将 PDF 视觉行聚合为语义段落，供翻译链路按完整段落处理，避免句子被行边界截断。
 * @param lines 表格识别后剩余的视觉行。
 * @param pageWidth 页面宽度。
 * @param bodyFontSize 页面正文主字号。
 * @param styles PDF.js 字体样式映射。
 * @param lineHeights 视觉行行高映射。
 * @param contentArea 页面正文内容区。
 * @param codeFrames 已识别代码框；框内文本需保持代码行边界。
 * @returns 按阅读顺序排列的段落。
 * @author zhenghq
 */
function groupPdfParagraphs(
  lines: readonly PdfLine[],
  pageWidth: number,
  bodyFontSize: number,
  styles: Record<string, PdfTextStyle>,
  lineHeights: ReadonlyMap<PdfLine, number>,
  contentArea?: { left: number; right: number; center: number },
  codeFrames: readonly PdfDetectedGrid[] = []
): PdfParagraph[] {
  const paragraphs: PdfParagraph[] = []
  let previousLine: PdfLine | undefined
  const codeContentLefts = codeFrames.map((frame) => {
    const frameLines = lines.filter((line) => pdfLineCenterInsideGrid(line, frame))
    return frameLines.length > 0
      ? Math.min(...frameLines.map((line) => line.bbox.x))
      : frame.bbox.x
  })
  for (const line of lines) {
    const current = paragraphs[paragraphs.length - 1]
    const codeFrameIndex = codeFrames.findIndex((frame) =>
      pdfLineCenterInsideGrid(line, frame))
    const insideCodeFrame = codeFrameIndex >= 0
    const codeContentLeft = codeFrameIndex >= 0
      ? codeContentLefts[codeFrameIndex]
      : undefined
    const continuesCodeFrame = insideCodeFrame &&
      current?.codeFrameIndex === codeFrameIndex
    // 同一代码框内的连续视觉行都属于源码正文，不能再用自然段、缩进或
    // 标点规则拆开；只有跨代码框或离开代码框时才需要重新分段。
    const cannotContinue = insideCodeFrame
      ? !continuesCodeFrame
      : Boolean(current?.codeFrame) || (previousLine !== undefined && !canMergePdfParagraphLine(
        current!,
        previousLine,
        line,
        pageWidth,
        bodyFontSize,
        styles,
        contentArea
      ))
    if (!current || !previousLine || cannotContinue) {
      const lineHeight = lineHeights.get(line)
      paragraphs.push({
        items: insideCodeFrame
          ? restorePdfCodeLineSpacing(line, codeContentLeft)
          : [...line.items],
        bbox: { ...line.bbox },
        baseline: line.baseline,
        ...(lineHeight === undefined ? {} : { lineHeight }),
        ...(insideCodeFrame ? { codeFrame: true, codeFrameIndex } : {})
      })
      previousLine = line
      continue
    }

    if (continuesCodeFrame) {
      // 同一代码框的每个视觉行都是独立源码行，不能用段落空格拼接成一行。
      const lineItems = restorePdfCodeLineSpacing({
        ...line,
        items: line.items
      }, codeContentLeft)
      current.items.push({ ...lineItems[0]!, str: `\n${lineItems[0]!.str}` })
      current.items.push(...lineItems.slice(1))
    } else {
      const previousText = current.items.map((item) => item.str).join('')
      const currentText = line.items.map((item) => item.str).join('')
      const separator = needsPdfLineSeparator(previousText, currentText) ? ' ' : ''
      line.items.forEach((item, index) => {
        current.items.push(index === 0 && separator
          ? { ...item, str: `${separator}${item.str}` }
          : item)
      })
    }
    const right = Math.max(current.bbox.x + current.bbox.width, line.bbox.x + line.bbox.width)
    const bottom = Math.max(current.bbox.y + current.bbox.height, line.bbox.y + line.bbox.height)
    current.bbox = {
      x: Math.min(current.bbox.x, line.bbox.x),
      y: Math.min(current.bbox.y, line.bbox.y),
      width: right - Math.min(current.bbox.x, line.bbox.x),
      height: bottom - Math.min(current.bbox.y, line.bbox.y)
    }
    const baselineAdvance = line.baseline - previousLine.baseline
    if (current.lineHeight === undefined) {
      current.lineHeight = Math.round(baselineAdvance * 100) / 100
    }
    previousLine = line
  }
  return paragraphs
}

/**
 * 判断视觉行是否完整位于指定网格内部。
 * @param line PDF 视觉行。
 * @param grid 目标网格。
 * @returns 行边界完整落在网格内时返回 true。
 * @author zhenghq
 */
function pdfLineInsideGrid(line: PdfLine, grid: PdfDetectedGrid): boolean {
  const tolerance = PDF_TABLE_LINE_TOLERANCE
  return line.bbox.x >= grid.bbox.x - tolerance &&
    line.bbox.y >= grid.bbox.y - tolerance &&
    line.bbox.x + line.bbox.width <= grid.bbox.x + grid.bbox.width + tolerance &&
    line.bbox.y + line.bbox.height <= grid.bbox.y + grid.bbox.height + tolerance
}

/**
 * 估算页面正文内容区左右边界，供居中判定使用，避免整页坐标或少量标题干扰。
 * @param lines 页面内按阅读顺序分组的文本行。
 * @param pageWidth 页面宽度。
 * @returns 正文内容区中心线与左右边界；样本不足时返回 undefined。
 * @author zhenghq
 */
function inferPdfContentArea(
  lines: readonly PdfLine[],
  pageWidth: number
): { left: number; right: number; center: number } | undefined {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || lines.length < 3) return undefined
  const leftCounts = new Map<number, number>()
  for (const line of lines) {
    if (line.bbox.width <= 0) continue
    const left = Math.round(line.bbox.x)
    leftCounts.set(left, (leftCounts.get(left) ?? 0) + 1)
  }
  const mostFrequent = (counts: Map<number, number>): number | undefined => {
    let selected: number | undefined
    let selectedCount = 0
    for (const [value, count] of counts) {
      if (count > selectedCount) {
        selected = value
        selectedCount = count
      }
    }
    return selected
  }
  const left = mostFrequent(leftCounts)
  if (left === undefined) return undefined
  // 真实 PDF 的正文行通常自然换行，右边界不会像左边界那样逐行重合。
  // 以正文行最大右边界作为内容区右边界，既保留原有页边距，也避免短标题只能按自身宽度换行。
  const bodyRightEdges = lines
    .filter((line) => Math.abs(line.bbox.x - left) <= Math.max(3, pageWidth * 0.012))
    .map((line) => line.bbox.x + line.bbox.width)
    .filter((right) => Number.isFinite(right) && right > left && right <= pageWidth)
    .sort((a, b) => a - b)
  if (bodyRightEdges.length < 3) return undefined
  const right = bodyRightEdges[bodyRightEdges.length - 1]!
  if (right - left < pageWidth * 0.25) return undefined
  return { left, right, center: (left + right) / 2 }
}

/**
 * 按字符数估算页面正文主字号，用于区分标题与普通正文。
 * @param lines 页面内按行分组的文本片段。
 * @returns 正文字号；页面仅有一行且无法判断正文基准时返回 0。
 * @author zhenghq
 */
function inferPdfBodyFontSize(lines: readonly PdfLine[]): number {
  if (lines.length <= 1) return 0
  const weights = new Map<number, number>()
  for (const line of lines) {
    const item = line.items.find((candidate) => candidate.str.trim().length > 0)
    if (!item) continue
    const fontSize = Math.round(fontSizeFromTransform(item.transform, item.height) * 10) / 10
    if (fontSize <= 0) continue
    const textLength = line.items.reduce((sum, candidate) => sum + candidate.str.replace(/\s/gu, '').length, 0)
    weights.set(fontSize, (weights.get(fontSize) ?? 0) + Math.max(1, textLength))
  }
  let bodyFontSize = 0
  let bodyWeight = -1
  for (const [fontSize, weight] of weights) {
    // 字符数相同时选择较小字号，避免少量大标题覆盖正文基准。
    if (weight > bodyWeight || (weight === bodyWeight && fontSize < bodyFontSize)) {
      bodyFontSize = fontSize
      bodyWeight = weight
    }
  }
  return bodyFontSize
}

/**
 * 根据文本行在页面中的左右留白推断对齐方式，避免把普通左对齐正文误判为居中。
 * @param bbox 文本行边界。
 * @param pageWidth 页面宽度。
 * @param fontSize 当前文本行字号。
 * @param bodyFontSize 页面按字符数估算的正文主字号。
 * @param contentArea 页面正文内容区；无法可靠推断时为空。
 * @returns 推断出的对齐方式；无法可靠判断时返回 undefined。
 * @author zhenghq
 */
function inferPdfTextAlignment(
  bbox: DocumentBoundingBox,
  pageWidth: number,
  fontSize: number,
  bodyFontSize = 0,
  contentArea?: { left: number; right: number; center: number }
): DocumentTextAlign | undefined {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || bbox.width <= 0) return undefined
  const leftGap = Math.max(0, bbox.x)
  // 保留未截断的右边距：文本溢出页面时不能把负值归零后误判为贴右边缘。
  const rawRightGap = pageWidth - bbox.x - bbox.width
  const rightGap = Math.max(0, rawRightGap)
  const centerGap = Math.abs(leftGap - rightGap)
  // 居中标题通常严格落在页面中线上；短正文的左右留白可能碰巧接近，不能使用过宽容差。
  const horizontalTolerance = Math.max(2, pageWidth * 0.008)
  const contentCenterGap = contentArea
    ? Math.abs(bbox.x + bbox.width / 2 - contentArea.center)
    : Number.POSITIVE_INFINITY
  const pageCenterlineGap = Math.abs(bbox.x + bbox.width / 2 - pageWidth / 2)
  // 标题常因字体侧边距或人工排版相对页面中线偏移数点，使用独立的标题容差。
  const headingCenterTolerance = Math.max(3, pageWidth * 0.012)
  const isCentered = centerGap <= horizontalTolerance || contentCenterGap <= horizontalTolerance
  const hasBalancedMargin = Math.min(leftGap, rightGap) > Math.max(2, pageWidth * 0.015)
  const isAlignedToContentLeft = contentArea !== undefined &&
    Math.abs(bbox.x - contentArea.left) <= Math.max(3, pageWidth * 0.012)
  const isAlignedToContentRight = contentArea !== undefined &&
    Math.abs(bbox.x + bbox.width - contentArea.right) <= Math.max(3, pageWidth * 0.012)
  const isOnPageCenter = centerGap <= horizontalTolerance
  const isOnContentCenter = contentCenterGap <= horizontalTolerance
  const contentWidth = contentArea ? contentArea.right - contentArea.left : 0
  // 正文字号且接近正文栏宽的行通常是左对齐正文（可能带首行缩进），
  // 其几何中心会偶然接近内容区中线，不能据此覆盖左对齐。
  const isBodySized = bodyFontSize > 0 && fontSize <= bodyFontSize * 1.1
  const isNearFullContentWidth = contentWidth > 0 && bbox.width >= contentWidth * 0.8
  if (isBodySized && isNearFullContentWidth) return undefined
  const isHeadingSized = bodyFontSize > 0 && fontSize >= Math.max(14, bodyFontSize * 1.2)
  const isHeadingOnCenter = pageCenterlineGap <= headingCenterTolerance ||
    contentCenterGap <= headingCenterTolerance
  if (isHeadingSized && isHeadingOnCenter && hasBalancedMargin) return 'center'
  const isShortCenteredContent = contentArea !== undefined &&
    (isOnPageCenter || isOnContentCenter) && !isAlignedToContentLeft &&
    !isAlignedToContentRight && bbox.width < contentWidth * 0.9
  if (isShortCenteredContent) return 'center'
  if (isCentered && hasBalancedMargin && bodyFontSize > 0) {
    // 普通正文与标题共用字号时没有可靠语义，宁可保持左对齐，也不把短行错误居中。
    if (fontSize >= Math.max(14, bodyFontSize * 1.2)) return 'center'
  }
  if (isCentered && hasBalancedMargin && bodyFontSize <= 0 && fontSize >= 14) {
    // 单行封面等无法估算正文主字号的页面仍允许识别较大的居中标题。
    return 'center'
  }
  // 右对齐页脚通常贴近右侧页边距；双栏右栏正文也可能远离左页边距，
  // 仅凭左右留白比例会把整栏正文误判为右对齐，因此必须使用固定页边距阈值。
  const isNearRightPageEdge = rawRightGap >= 0 && rawRightGap <= Math.max(3, pageWidth * 0.12)
  if (bbox.width < pageWidth * 0.82 && leftGap > pageWidth * 0.12 &&
    rightGap < leftGap * 0.6 && isNearRightPageEdge) return 'right'
  return undefined
}

/**
 * 将 PDF 文本行转换为统一文本区块。
 * @param items 同一行文本项。
 * @param pageId 页面标识。
 * @param fingerprint 文档指纹。
 * @param readingOrder 阅读顺序。
 * @param bbox 行边界。
 * @param pageWidth 页面宽度，用于推断对齐方式。
 * @param bodyFontSize 页面正文主字号。
 * @param styles PDF.js 字体样式映射。
 * @param lineHeight 段落行高。
 * @param contentArea 页面正文内容区。
 * @param role 文本语义角色；代码框文本使用 code，避免译文丢失换行。
 * @param codeFrame 代码框原始边界；仅代码文本块需要携带。
 * @returns 文本区块。
 * @author zhenghq
 */
function createPdfTextBlock(
  items: PdfTextItem[],
  pageId: string,
  fingerprint: string,
  readingOrder: number,
  bbox: DocumentBoundingBox,
  pageWidth: number,
  bodyFontSize: number,
  styles: Record<string, PdfTextStyle>,
  lineHeight?: number,
  contentArea?: { left: number; right: number; center: number },
  role: DocumentTextBlock['role'] = 'paragraph',
  codeFrame?: DocumentBoundingBox
): DocumentTextBlock {
  const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, 'text')
  const itemRuns: DocumentTextRun[] = items.map((item, index) => {
    const fontStyle = item.fontName ? styles[item.fontName] : undefined
    const style = pdfTextStyle(item, {
      ...fontStyle,
      ...(item.fontName ? { key: item.fontName } : {})
    })
    return {
      runId: createTextRunId(blockId, index),
      text: sanitizeDocumentText(item.str),
      style: lineHeight === undefined ? style : { ...style, lineHeight }
    }
  })
  const tocEntry = role === 'code'
    ? undefined
    : parsePdfTableOfContentsLine(items.map((item) => item.str).join(''))
  const runs: DocumentTextRun[] = tocEntry
    ? [
        {
          runId: createTextRunId(blockId, 0),
          text: tocEntry.title,
          ...(itemRuns[0]?.style ? { style: { ...itemRuns[0].style } } : {})
        },
        {
          runId: createTextRunId(blockId, 1),
          text: tocEntry.leader,
          ...(itemRuns[0]?.style ? { style: { ...itemRuns[0].style } } : {}),
          protected: true
        },
        {
          runId: createTextRunId(blockId, 2),
          text: tocEntry.pageNumber,
          ...(itemRuns[0]?.style ? { style: { ...itemRuns[0].style } } : {}),
          protected: true
        }
      ]
    : itemRuns
  const primaryFontSize = runs[0]?.style?.fontSize ?? 0
  const textAlign = inferPdfTextAlignment(bbox, pageWidth, primaryFontSize, bodyFontSize, contentArea)
  return {
    kind: 'text',
    blockId,
    readingOrder,
    translatable: true,
    role,
    bbox,
    ...(textAlign ? { textAlign } : {}),
    runs,
    ...(tocEntry ? { toc: { pageNumber: tocEntry.pageNumber } } : {}),
    ...(codeFrame ? { codeFrame } : {})
  }
}

/**
 * 判断文本项是否位于指定矩形区域内。
 * @param item PDF 文本项。
 * @param bbox 文本项页面边界。
 * @param region 目标矩形区域。
 * @returns 文本中心是否落在区域内。
 * @author zhenghq
 */
function pdfTextItemInsideRegion(
  item: PdfTextItem,
  bbox: DocumentBoundingBox,
  region: DocumentBoundingBox
): boolean {
  if (!item.str.trim()) return false
  const centerX = bbox.x + bbox.width / 2
  const centerY = bbox.y + bbox.height / 2
  return centerX >= region.x - PDF_TABLE_LINE_TOLERANCE &&
    centerX <= region.x + region.width + PDF_TABLE_LINE_TOLERANCE &&
    centerY >= region.y - PDF_TABLE_LINE_TOLERANCE &&
    centerY <= region.y + region.height + PDF_TABLE_LINE_TOLERANCE
}

/**
 * 将 PDF 网格及其内部文本转换为统一表格区块。
 * @param grid 已识别的闭合网格。
 * @param lines 页面文本行。
 * @param pageId 页面标识。
 * @param fingerprint 文档指纹。
 * @param pageHeight 页面高度。
 * @param pageWidth 页面宽度。
 * @param bodyFontSize 页面正文主字号。
 * @param styles 字体样式映射。
 * @param lineHeights 文本行行高映射。
 * @param contentArea 页面正文内容区。
 * @returns 表格区块与未落入网格的文本行。
 * @author zhenghq
 */
function createPdfTableBlock(
  grid: PdfDetectedGrid,
  lines: readonly PdfLine[],
  pageId: string,
  fingerprint: string,
  pageHeight: number,
  pageWidth: number,
  bodyFontSize: number,
  styles: Record<string, PdfTextStyle>,
  lineHeights: ReadonlyMap<PdfLine, number>,
  contentArea?: { left: number; right: number; center: number }
): { table: DocumentTableBlock; remainingLines: PdfLine[] } {
  const tableId = createDocumentBlockId(fingerprint, pageId, 0, 'table')
  const rowCount = Math.max(1, grid.rows.length - 1)
  const columnCount = Math.max(1, grid.columns.length - 1)
  const cellItems = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => [] as Array<{ item: PdfTextItem; bbox: DocumentBoundingBox }>)
  )
  const remainingLines: PdfLine[] = []

  for (const line of lines) {
    const intersectsGrid = line.bbox.x + line.bbox.width >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
      line.bbox.x <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE &&
      line.bbox.y + line.bbox.height >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
      line.bbox.y <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE
    if (!intersectsGrid) {
      remainingLines.push(line)
      continue
    }
    let matchedItem = false
    for (const item of line.items) {
      const itemBbox = textItemBoundingBox(item, pageHeight)
      if (!pdfTextItemInsideRegion(item, itemBbox, grid.bbox)) continue
      const centerX = itemBbox.x + itemBbox.width / 2
      const centerY = itemBbox.y + itemBbox.height / 2
      const columnIndex = grid.columns.findIndex((left, index) =>
        index < grid.columns.length - 1 &&
        centerX >= left - PDF_TABLE_LINE_TOLERANCE &&
        centerX <= grid.columns[index + 1]! + PDF_TABLE_LINE_TOLERANCE)
      const rowIndex = grid.rows.findIndex((top, index) =>
        index < grid.rows.length - 1 &&
        centerY >= top - PDF_TABLE_LINE_TOLERANCE &&
        centerY <= grid.rows[index + 1]! + PDF_TABLE_LINE_TOLERANCE)
      if (columnIndex < 0 || rowIndex < 0) continue
      cellItems[rowIndex]![columnIndex]!.push({ item, bbox: itemBbox })
      matchedItem = true
    }
    // 只要行内有文本项落入网格，整行就由表格接管，避免同一单元格文本重复输出。
    if (!matchedItem && pdfTextItemInsideRegion(line.items[0] ?? { str: '' }, line.bbox, grid.bbox)) {
      remainingLines.push(line)
    }
  }

  const rows: DocumentTableRow[] = cellItems.map((cells, rowIndex) => ({
    rowId: createTableRowId(tableId, rowIndex),
    cells: cells.map((entries, cellIndex) => {
      const cellId = createTableCellId(fingerprint, pageId, tableId, rowIndex, cellIndex)
      const cellLeft = grid.columns[cellIndex]!
      const cellRight = grid.columns[cellIndex + 1]!
      const cellTop = grid.rows[rowIndex]!
      const cellBottom = grid.rows[rowIndex + 1]!
      const sortedEntries = [...entries].sort((left, right) =>
        left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
      const childBlocks: DocumentTextBlock[] = []
      let currentEntries: typeof sortedEntries = []
      let currentLine: PdfLine | undefined
      for (const entry of sortedEntries) {
        const sourceLine = lines.find((line) => line.items.includes(entry.item))
        if (currentLine && sourceLine !== currentLine) {
          childBlocks.push(createPdfTableCellTextBlock(
            currentEntries,
            cellId,
            childBlocks.length,
            currentLine,
            pageWidth,
            bodyFontSize,
            styles,
            lineHeights,
            contentArea,
            cellLeft,
            cellRight,
            cellTop,
            cellBottom
          ))
          currentEntries = []
        }
        currentEntries.push(entry)
        currentLine = sourceLine
      }
      if (currentEntries.length > 0 && currentLine) {
        childBlocks.push(createPdfTableCellTextBlock(
          currentEntries,
          cellId,
          childBlocks.length,
          currentLine,
          pageWidth,
          bodyFontSize,
          styles,
          lineHeights,
          contentArea,
          cellLeft,
          cellRight,
          cellTop,
          cellBottom
        ))
      }
      return { cellId, rowSpan: 1, colSpan: 1, blocks: childBlocks }
    })
  }))

  return {
    table: {
      kind: 'table',
      blockId: tableId,
      readingOrder: 0,
      translatable: true,
      bbox: grid.bbox,
      rows,
      columnWidths: grid.columns.slice(1).map((right, index) =>
        Math.round((right - grid.columns[index]!) * 100) / 100),
      headerRows: rowCount > 1 ? 1 : 0
    },
    remainingLines
  }
}

/**
 * 根据图片与单元格的最大重叠面积确定其所属的表格行列。
 * @param grid 已识别的表格网格。
 * @param region 页面内嵌图片区域。
 * @returns 图片所属的行列索引；图片未与网格有效重叠时返回 undefined。
 * @author zhenghq
 */
function pdfTableCellIndexForRegion(
  grid: PdfDetectedGrid,
  region: PdfEmbeddedImageRegion
): { rowIndex: number; cellIndex: number } | undefined {
  const left = region.bbox.x
  const right = region.bbox.x + region.bbox.width
  const top = region.bbox.y
  const bottom = region.bbox.y + region.bbox.height
  let best: { rowIndex: number; cellIndex: number; overlap: number } | undefined
  for (let rowIndex = 0; rowIndex < grid.rows.length - 1; rowIndex += 1) {
    const cellTop = grid.rows[rowIndex]!
    const cellBottom = grid.rows[rowIndex + 1]!
    for (let cellIndex = 0; cellIndex < grid.columns.length - 1; cellIndex += 1) {
      const cellLeft = grid.columns[cellIndex]!
      const cellRight = grid.columns[cellIndex + 1]!
      const overlapWidth = Math.max(0, Math.min(right, cellRight) - Math.max(left, cellLeft))
      const overlapHeight = Math.max(0, Math.min(bottom, cellBottom) - Math.max(top, cellTop))
      const overlap = overlapWidth * overlapHeight
      if (overlap > 0 && (!best || overlap > best.overlap)) {
        best = { rowIndex, cellIndex, overlap }
      }
    }
  }
  return best ? { rowIndex: best.rowIndex, cellIndex: best.cellIndex } : undefined
}

/**
 * 将图片区块按页面坐标插入表格单元格，并保持单元格内阅读顺序。
 * @param table 目标表格。
 * @param rowIndex 目标行索引。
 * @param cellIndex 目标列索引。
 * @param block 待插入的图片区块。
 * @returns 成功插入时返回 true。
 * @author zhenghq
 */
function appendPdfTableCellBlock(
  table: DocumentTableBlock,
  rowIndex: number,
  cellIndex: number,
  block: DocumentBlock
): boolean {
  const cell = table.rows[rowIndex]?.cells[cellIndex]
  if (!cell) return false
  cell.blocks.push(block)
  cell.blocks.sort((left, right) => {
    const leftY = left.bbox?.y ?? Number.POSITIVE_INFINITY
    const rightY = right.bbox?.y ?? Number.POSITIVE_INFINITY
    if (leftY !== rightY) return leftY - rightY
    return (left.bbox?.x ?? Number.POSITIVE_INFINITY) -
      (right.bbox?.x ?? Number.POSITIVE_INFINITY)
  })
  return true
}

/**
 * 根据所属单元格与单元格内顺序生成文本区块标识。
 * @param cellId 单元格稳定标识。
 * @param readingOrder 单元格内阅读顺序。
 * @returns 单元格内唯一的文本区块标识。
 * @author zhenghq
 */
function createPdfTableCellBlockId(cellId: string, readingOrder: number): string {
  return `${cellId}-block-${readingOrder}`
}

/**
 * 从单元格内的文本片段创建文本区块，并保留其原始对齐、字号与行高。
 * @param entries 单元格内的文本项及边界。
 * @param cellId 单元格标识。
 * @param readingOrder 单元格内阅读顺序。
 * @param line 文本项所属的原始行。
 * @param pageWidth 页面宽度。
 * @param bodyFontSize 页面正文主字号。
 * @param styles 字体样式映射。
 * @param lineHeights 行高映射。
 * @param contentArea 页面正文内容区。
 * @param cellLeft 单元格左边界。
 * @param cellRight 单元格右边界。
 * @param cellTop 单元格上边界。
 * @param cellBottom 单元格下边界。
 * @returns 单元格文本区块。
 * @author zhenghq
 */
function createPdfTableCellTextBlock(
  entries: ReadonlyArray<{ item: PdfTextItem; bbox: DocumentBoundingBox }>,
  cellId: string,
  readingOrder: number,
  line: PdfLine,
  pageWidth: number,
  bodyFontSize: number,
  styles: Record<string, PdfTextStyle>,
  lineHeights: ReadonlyMap<PdfLine, number>,
  contentArea: { left: number; right: number; center: number } | undefined,
  cellLeft: number,
  cellRight: number,
  cellTop: number,
  cellBottom: number
): DocumentTextBlock {
  const blockId = createPdfTableCellBlockId(cellId, readingOrder)
  const lineHeight = lineHeights.get(line)
  const runs: DocumentTextRun[] = entries.map(({ item }, index) => {
    const fontStyle = item.fontName ? styles[item.fontName] : undefined
    const style = pdfTextStyle(item, {
      ...fontStyle,
      ...(item.fontName ? { key: item.fontName } : {})
    })
    return {
      runId: createTextRunId(blockId, index),
      text: sanitizeDocumentText(item.str),
      style: lineHeight === undefined ? style : { ...style, lineHeight }
    }
  })
  const bbox = {
    x: Math.max(cellLeft, Math.min(...entries.map((entry) => entry.bbox.x))),
    y: Math.max(cellTop, Math.min(...entries.map((entry) => entry.bbox.y))),
    width: Math.max(1, Math.min(cellRight, Math.max(...entries.map((entry) => entry.bbox.x + entry.bbox.width))) -
      Math.max(cellLeft, Math.min(...entries.map((entry) => entry.bbox.x)))),
    height: Math.max(1, Math.min(cellBottom, Math.max(...entries.map((entry) => entry.bbox.y + entry.bbox.height))) -
      Math.max(cellTop, Math.min(...entries.map((entry) => entry.bbox.y))))
  }
  const primaryFontSize = runs[0]?.style?.fontSize ?? 0
  const textAlign = inferPdfTextAlignment(bbox, pageWidth, primaryFontSize, bodyFontSize, contentArea)
  return {
    kind: 'text',
    blockId,
    readingOrder,
    translatable: true,
    role: 'paragraph',
    bbox,
    ...(textAlign ? { textAlign } : {}),
    runs
  }
}

/**
 * 读取 PDF.js 已加载字体对象的粗细与斜体信息并合并到文本样式映射。
 * @param page PDF.js 页面。
 * @param items 页面文本项。
 * @param styles PDF.js 返回的字体样式映射。
 * @returns 补齐字体名称、粗细与斜体后的新样式映射。
 * @author zhenghq
 */
function enrichPdfFontStyles(
  page: PdfPage,
  items: readonly PdfTextItem[],
  styles: Record<string, PdfTextStyle>
): Record<string, PdfTextStyle> {
  const result: Record<string, PdfTextStyle> = {}
  for (const [key, style] of Object.entries(styles)) {
    let font: unknown
    try {
      font = page.commonObjs?.get(key)
    } catch {
      font = undefined
    }
    const candidate = font && typeof font === 'object'
      ? font as {
        name?: unknown
        bold?: unknown
        italic?: unknown
        loadedName?: unknown
        cssFontInfo?: { fontWeight?: unknown; italicAngle?: unknown }
      }
      : undefined
    const fontName = typeof candidate?.name === 'string' && candidate.name.trim()
      ? candidate.name
      : typeof candidate?.loadedName === 'string' && candidate.loadedName.trim()
        ? candidate.loadedName
        : typeof style.fontFamily === 'string' ? style.fontFamily : key
    const cssWeight = candidate?.cssFontInfo?.fontWeight
    const cssItalicAngle = candidate?.cssFontInfo?.italicAngle
    const fontWeight = cssWeight === 'bold' || cssWeight === '700' ||
      (typeof cssWeight === 'number' && cssWeight >= 600) ? 700 : undefined
    const flags = pdfFontStyleFlags(key, {
      ...style,
      fontName,
      ...(fontWeight ? { fontWeight } : {}),
      ...(typeof candidate?.bold === 'boolean' ? { bold: candidate.bold } : {}),
      ...(typeof candidate?.italic === 'boolean' ? { italic: candidate.italic } : {}),
      ...(typeof cssItalicAngle === 'number' && cssItalicAngle !== 0 ? { italic: true } : {})
    } as PdfTextStyle)
    result[key] = {
      ...style,
      key,
      fontName,
      ...(flags.fontWeight ? { fontWeight: flags.fontWeight } : {}),
      ...(flags.italic ? { italic: true } : {})
    }
  }
  // 某些 PDF.js 版本只在文本项中暴露字体键；仍按名称补全，保证粗斜体可恢复。
  for (const item of items) {
    if (!item.fontName || result[item.fontName]) continue
    const flags = pdfFontStyleFlags(item.fontName, undefined)
    result[item.fontName] = {
      key: item.fontName,
      fontName: item.fontName,
      ...(flags.fontWeight ? { fontWeight: flags.fontWeight } : {}),
      ...(flags.italic ? { italic: true } : {})
    }
  }
  return result
}

/**
 * 创建扫描页图像资源；未注入栅格化器时保留待渲染状态。
 * @param page 页面。
 * @param pageIndex 页面索引。
 * @param fingerprint 文档指纹。
 * @param renderPageToImage 可选栅格化适配器。
 * @returns 图像区块与资源。
 * @author zhenghq
 */
async function createScannedPageImage(
  page: PdfPage,
  pageIndex: number,
  fingerprint: string,
  renderPageToImage: ParsePdfOptions['renderPageToImage'],
  registerAssetBytes?: ParsePdfOptions['registerAssetBytes']
): Promise<{ block: DocumentImageBlock; asset: DocumentAsset }> {
  const pageId = createDocumentPageId(fingerprint, pageIndex)
  const blockId = createDocumentBlockId(fingerprint, pageId, 0, 'image')
  const bytes = renderPageToImage ? await renderPageToImage(page, pageIndex) : null
  const content = bytes ?? new Uint8Array()
  const dimensions = bytes ? readPngDimensions(bytes) : null
  const viewport = page.getViewport({ scale: 1 })
  const sha256 = hashDocumentBytes(content)
  const assetId = `asset-${sha256.slice(0, 16)}`
  if (bytes) registerAssetBytes?.(assetId, bytes)
  return {
    block: {
      kind: 'image',
      blockId,
      readingOrder: 0,
      translatable: false,
      assetId,
      bbox: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      renderPending: bytes === null
    },
    asset: {
      assetId,
      kind: 'image',
      mimeType: 'image/png',
      sha256,
      byteLength: content.byteLength,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {})
    }
  }
}

/**
 * 按 Canvas 语义右乘两个仿射变换矩阵。
 * @param left 当前变换矩阵。
 * @param right 新应用的变换矩阵。
 * @returns 组合后的变换矩阵。
 * @author zhenghq
 */
function multiplyPdfMatrix(left: PdfMatrix, right: PdfMatrix): PdfMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ]
}

/**
 * 将未知长度的数字数组转换为仿射变换矩阵。
 * @param value 待检查值。
 * @returns 合法的六元矩阵；无效时返回 null。
 * @author zhenghq
 */
function asPdfMatrix(value: unknown): PdfMatrix | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null
  const values = Array.from(value as ArrayLike<unknown>)
  if (values.length !== 6 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    return null
  }
  return values as PdfMatrix
}

/**
 * 将单位正方形经当前变换矩阵映射为页面视图坐标。
 * @param matrix 图片绘制时的完整变换矩阵。
 * @param pageWidth 页面宽度。
 * @param pageHeight 页面高度。
 * @returns 裁切后的页面边界框。
 * @author zhenghq
 */
function transformedImageBoundingBox(
  matrix: PdfMatrix,
  pageWidth: number,
  pageHeight: number
): DocumentBoundingBox {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => ({
    x: matrix[0] * x! + matrix[2] * y! + matrix[4],
    // PDF.js 视口矩阵已经完成左下角原点到页面视图左上角的转换；
    // 此处只能应用图片操作符矩阵，不能再翻转一次，否则图片会上下颠倒。
    y: matrix[1] * x! + matrix[3] * y! + matrix[5]
  }))
  const left = Math.max(0, Math.min(pageWidth, Math.min(...points.map((point) => point.x))))
  const top = Math.max(0, Math.min(pageHeight, Math.min(...points.map((point) => point.y))))
  const right = Math.max(0, Math.min(pageWidth, Math.max(...points.map((point) => point.x))))
  const bottom = Math.max(0, Math.min(pageHeight, Math.max(...points.map((point) => point.y))))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * 从 PDF 操作符列表中提取图片绘制区域，并跟踪 save/restore 与 Form XObject 变换。
 * @param operatorList PDF.js 操作符列表。
 * @param runtime PDF.js 运行时。
 * @param viewport 页面视口。
 * @returns 去重后的图片区域。
 * @author zhenghq
 */
function extractPdfImageRegions(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  runtime: PdfJsRuntime,
  viewport: { width: number; height: number; transform?: number[] }
): PdfEmbeddedImageRegion[] {
  const initial = asPdfMatrix(viewport.transform) ?? [1, 0, 0, -1, 0, viewport.height]
  let current = initial
  const stack: PdfMatrix[] = []
  const regions: PdfEmbeddedImageRegion[] = []
  const seen = new Set<string>()
  const saveOperation = runtime.OPS['save']
  const restoreOperation = runtime.OPS['restore']
  const transformOperation = runtime.OPS['transform']
  const formBeginOperation = runtime.OPS['paintFormXObjectBegin']
  const formEndOperation = runtime.OPS['paintFormXObjectEnd']
  const imageOperations = new Set([
    runtime.OPS['paintImageXObject'],
    runtime.OPS['paintInlineImageXObject']
  ].filter((value): value is number => typeof value === 'number'))
  const repeatOperation = runtime.OPS['paintImageXObjectRepeat']
  const inlineGroupOperation = runtime.OPS['paintInlineImageXObjectGroup']

  const addRegion = (matrix: PdfMatrix, objectId?: string): void => {
    const bbox = transformedImageBoundingBox(matrix, viewport.width, viewport.height)
    if (bbox.width < PDF_MIN_IMAGE_SIZE || bbox.height < PDF_MIN_IMAGE_SIZE ||
      bbox.width * bbox.height < PDF_MIN_IMAGE_AREA) return
    const key = [bbox.x, bbox.y, bbox.width, bbox.height]
      .map((value) => value.toFixed(2))
      .join(':')
    if (seen.has(key)) return
    seen.add(key)
    regions.push({ bbox, ...(objectId ? { objectId } : {}) })
  }

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index]!
    const args = operatorList.argsArray[index] ?? []
    if (operation === saveOperation) {
      stack.push(current)
    } else if (operation === restoreOperation) {
      current = stack.pop() ?? initial
    } else if (operation === transformOperation) {
      // PDF.js 将 transform 的 a、b、c、d、e、f 六个参数平铺在 argsArray 中，
      // 而不是包装成一个数组；直接解析 args 才能还原绘制时的完整矩阵。
      const transform = asPdfMatrix(args)
      if (transform) current = multiplyPdfMatrix(current, transform)
    } else if (operation === formBeginOperation) {
      stack.push(current)
      const transform = asPdfMatrix(args[0])
      if (transform) current = multiplyPdfMatrix(current, transform)
    } else if (operation === formEndOperation) {
      current = stack.pop() ?? initial
    } else if (imageOperations.has(operation)) {
      const objectId = operation === runtime.OPS['paintImageXObject'] && typeof args[0] === 'string'
        ? args[0]
        : undefined
      addRegion(current, objectId)
    } else if (operation === repeatOperation) {
      const scaleX = typeof args[1] === 'number' ? args[1] : 1
      const scaleY = typeof args[2] === 'number' ? args[2] : 1
      const positions = Array.from(args[3] as ArrayLike<unknown> | undefined ?? [])
      const objectId = typeof args[0] === 'string' ? args[0] : undefined
      for (let position = 0; position + 1 < positions.length; position += 2) {
        const x = positions[position]
        const y = positions[position + 1]
        if (typeof x !== 'number' || typeof y !== 'number') continue
        addRegion(multiplyPdfMatrix(current, [scaleX, 0, 0, scaleY, x, y]), objectId)
      }
    } else if (operation === inlineGroupOperation && Array.isArray(args[1])) {
      for (const entry of args[1]) {
        if (!entry || typeof entry !== 'object' || !('transform' in entry)) continue
        const transform = asPdfMatrix((entry as { transform?: unknown }).transform)
        if (transform) addRegion(multiplyPdfMatrix(current, transform))
      }
    }
  }
  return regions
}

/**
 * 创建 PDF 内嵌图片区块并登记裁切后的 PNG 资源。
 * @param page 页面。
 * @param pageIndex 页面索引。
 * @param fingerprint 文档指纹。
 * @param readingOrder 阅读顺序。
 * @param bbox 图片页面区域。
 * @param objectId PDF.js 图片对象标识。
 * @param renderEmbeddedImageToImage 可选内嵌图片对象导出函数。
 * @param renderPageRegionToImage 可选区域栅格化函数。
 * @param registerAssetBytes 可选资源字节登记函数。
 * @param assetBytesById 当前已登记的资源字节。
 * @returns 图片区块与资源。
 * @author zhenghq
 */
async function createEmbeddedImageBlock(
  page: PdfPage,
  pageIndex: number,
  fingerprint: string,
  readingOrder: number,
  bbox: DocumentBoundingBox,
  objectId: string | undefined,
  renderEmbeddedImageToImage: ParsePdfOptions['renderEmbeddedImageToImage'],
  renderPageRegionToImage: ParsePdfOptions['renderPageRegionToImage'],
  registerAssetBytes: ParsePdfOptions['registerAssetBytes'],
  assetBytesById: Map<string, Uint8Array>
): Promise<{ block: DocumentImageBlock; asset: DocumentAsset }> {
  const pageId = createDocumentPageId(fingerprint, pageIndex)
  let bytes: Uint8Array | null = null
  if (objectId && renderEmbeddedImageToImage) {
    try {
      bytes = await renderEmbeddedImageToImage(page, pageIndex, objectId)
    } catch (error) {
      if (isPdfAbortError(error)) throw error
      // 个别图片对象可能使用暂不支持的编码，继续尝试整页区域裁切。
    }
  }
  if (!bytes && renderPageRegionToImage) {
    bytes = await renderPageRegionToImage(page, pageIndex, bbox)
  }
  const content = bytes ?? new TextEncoder().encode(`pdf-image:${pageIndex}:${readingOrder}`)
  const dimensions = bytes ? readPngDimensions(bytes) : null
  const sha256 = hashDocumentBytes(content)
  const assetId = `asset-${sha256.slice(0, 16)}`
  if (bytes) {
    assetBytesById.set(assetId, bytes)
    registerAssetBytes?.(assetId, bytes)
  }
  return {
    block: {
      kind: 'image',
      blockId: createDocumentBlockId(fingerprint, pageId, readingOrder, 'image'),
      readingOrder,
      translatable: false,
      bbox,
      assetId,
      alt: 'Embedded PDF image',
      renderPending: bytes === null
    },
    asset: {
      assetId,
      kind: 'image',
      mimeType: 'image/png',
      sha256,
      byteLength: content.byteLength,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {})
    }
  }
}

/**
 * 按页面坐标合并排序文本与图片区块，并同步重建阅读顺序相关标识。
 * @param blocks 当前页提取出的全部区块。
 * @param pageId 页面稳定标识。
 * @param fingerprint 文档指纹。
 * @returns 按从上到下、从左到右排列的区块数组。
 * @author zhenghq
 */
function orderPdfPageBlocks(
  blocks: readonly DocumentBlock[],
  pageId: string,
  fingerprint: string
): DocumentBlock[] {
  const ordered = blocks
    .map((block, sourceIndex) => ({ block, sourceIndex }))
    .sort((left, right) => {
      const leftY = left.block.bbox?.y ?? Number.POSITIVE_INFINITY
      const rightY = right.block.bbox?.y ?? Number.POSITIVE_INFINITY
      if (leftY !== rightY) return leftY - rightY
      const leftX = left.block.bbox?.x ?? Number.POSITIVE_INFINITY
      const rightX = right.block.bbox?.x ?? Number.POSITIVE_INFINITY
      if (leftX !== rightX) return leftX - rightX
      return left.sourceIndex - right.sourceIndex
    })

  // 仅将页面顶部的小图片与紧邻文字归为同一视觉行，避免正文双栏或表格被误合并。
  let flowGroupIndex = 0
  const flowGroups = new Map<number, string>()
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!
    const next = ordered[index + 1]
    if (!next || !pdfBlocksShareVisualRow(current.block, next.block)) continue
    const groupId = `flow-${createDocumentBlockId(fingerprint, pageId, index, 'shape')}-${flowGroupIndex}`
      .replace(/^flow-block-/u, 'flow-')
    flowGroups.set(index, groupId)
    flowGroups.set(index + 1, groupId)
    flowGroupIndex += 1
    index += 1
  }

  return ordered.map(({ block }, readingOrder) => {
    const flowGroupId = flowGroups.get(readingOrder)
    const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, block.kind)
    if (block.kind === 'text') {
      return {
        ...block,
        blockId,
        readingOrder,
        ...(flowGroupId ? { flowGroupId } : {}),
        runs: block.runs.map((run, index) => ({ ...run, runId: createTextRunId(blockId, index) }))
      }
    }
    if (block.kind === 'table') {
      return {
        ...block,
        blockId,
        readingOrder,
        ...(flowGroupId ? { flowGroupId } : {}),
        rows: block.rows.map((row, rowIndex) => ({
          ...row,
          rowId: createTableRowId(blockId, rowIndex),
          cells: row.cells.map((cell, cellIndex) => {
            const cellId = createTableCellId(fingerprint, pageId, blockId, rowIndex, cellIndex)
            return {
              ...cell,
              cellId,
              blocks: cell.blocks.map((child, childIndex) => {
                const childBlockId = createPdfTableCellBlockId(cellId, childIndex)
                if (child.kind === 'image') {
                  return { ...child, blockId: childBlockId, readingOrder: childIndex }
                }
                if (child.kind !== 'text') return child
                return {
                  ...child,
                  blockId: childBlockId,
                  runs: child.runs.map((run, runIndex) => ({
                    ...run,
                    runId: createTextRunId(childBlockId, runIndex)
                  }))
                }
              })
            }
          })
        }))
      }
    }
    return { ...block, blockId, readingOrder, ...(flowGroupId ? { flowGroupId } : {}) }
  })
}

/**
 * 解析 PDF 文档；优先读取原生文本层，扫描页生成待 OCR 图像区块。
 * @param input 解析输入。
 * @param options 可选页面栅格化适配器。
 * @returns PDF 文档模型。
 * @author zhenghq
 */
export async function parsePdfDocument(
  input: DocumentParseInput,
  options: ParsePdfOptions = {}
): Promise<DocumentModel> {
  const runtime = await loadPdfJs()
  const pdfBytes = input.bytes instanceof Uint8Array && !Buffer.isBuffer(input.bytes)
    ? input.bytes
    : new Uint8Array(input.bytes)
  const loadingTask = runtime.getDocument({
    data: pdfBytes,
    canvasFactory: createPdfCanvasFactory(),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0
  })
  const document = await loadingTask.promise
  try {
    const pageCount = Math.min(document.numPages, DOCUMENT_MAX_PAGES)
    const pages: DocumentPage[] = []
    const assets: DocumentAsset[] = []
    const warnings: DocumentWarning[] = []
    if (document.numPages > DOCUMENT_MAX_PAGES) {
      warnings.push(createDocumentWarning('page-limit-reached', 'The PDF page limit was reached; remaining pages were skipped.'))
    }
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      if (options.signal?.aborted) throw createPdfAbortError()
      const page = await document.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: 1 })
      const pageId = createDocumentPageId(input.sha256, pageIndex)
      const textContent = await page.getTextContent()
      const hasNativeText = textContent.items.some((item) => item.str.trim().length > 0)
      const blocks: DocumentBlock[] = []
      const operatorList = await page.getOperatorList()
      const imageRegions = extractPdfImageRegions(operatorList, runtime, viewport)
      let contentArea: { left: number; right: number; center: number } | undefined
      const tableGridTargets: PdfTableGridTarget[] = []
      if (hasNativeText) {
        applyPdfTextColors(textContent.items, extractPdfTextColors(operatorList, runtime))
        const styles = enrichPdfFontStyles(page, textContent.items, textContent.styles ?? {})
        const lines = groupPdfTextItems(textContent.items, viewport.height)
        const bodyFontSize = inferPdfBodyFontSize(lines)
        const lineHeights = inferPdfLineHeights(lines)
        contentArea = inferPdfContentArea(lines, viewport.width)
        const rawGridLines = extractPdfGridLines(operatorList, runtime, viewport)
        const gridLines = mergePdfGridLines(rawGridLines)
        const detectedGrids = preferPdfMultiColumnGrids([
          ...detectPdfTableGrids(gridLines, lines),
          ...detectPdfTextRowTableGrids(rawGridLines, lines, viewport.width, viewport.height)
        ].map((grid) => refinePdfSingleColumnGrid(grid, rawGridLines, lines, viewport.height)))
          .filter((grid) => !isPdfHeaderImageGrid(grid, imageRegions))
        // 页面装饰边框会形成整页闭合网格，不能作为表格接管正文，也不能过滤边框内的普通分隔线。
        const pageFrameGrids = detectedGrids.filter((grid) =>
          isPdfPageFrameGrid(grid, viewport.width, viewport.height))
        const codeFrameGrids = selectPdfCodeFrames(
          detectedGrids.filter((grid) => !pageFrameGrids.includes(grid)),
          lines,
          styles
        )
        const tableCandidates = filterPdfCodeFrameGrids(
          detectedGrids.filter((grid) => !pageFrameGrids.includes(grid)),
          lines,
          styles
        )
        // 先在原始候选上合并表头、数据区等相邻网格，再统一裁剪表单容器底边。
        // 若提前裁剪，表头候选会失去与正文候选共享的完整纵向范围。
        const mergedGrids = mergeAdjacentPdfTableGrids(
          filterPdfOpenContainerGrids(tableCandidates, gridLines)
        ).map((grid) =>
          trimPdfFormContainerBottom(grid, gridLines, lines))
        const grids = filterNestedPdfTableGrids(mergedGrids)
        let remainingLines = [...lines]
        const tableBlocks: DocumentTableBlock[] = []
        for (const grid of grids) {
          const parsed = createPdfTableBlock(
            grid,
            remainingLines,
            pageId,
            input.sha256,
            viewport.height,
            viewport.width,
            bodyFontSize,
            styles,
            lineHeights,
            contentArea
          )
          if (parsed.table.rows.some((row) => row.cells.some((cell) => cell.blocks.length > 0))) {
            tableBlocks.push(parsed.table)
            tableGridTargets.push({ table: parsed.table, grid })
            remainingLines = parsed.remainingLines
          }
        }
        const paragraphs = groupPdfParagraphs(
          remainingLines,
          viewport.width,
          bodyFontSize,
          styles,
          lineHeights,
          contentArea,
          codeFrameGrids
        )
        blocks.push(...tableBlocks, ...createPdfDividerBlocks(
          gridLines,
          grids,
          pageFrameGrids,
          codeFrameGrids,
          viewport.width,
          viewport.height,
          pageId,
          input.sha256
        ), ...paragraphs.map((paragraph, readingOrder) =>
          createPdfTextBlock(
            paragraph.items,
            pageId,
            input.sha256,
            readingOrder,
            paragraph.bbox,
            viewport.width,
            bodyFontSize,
            styles,
            paragraph.lineHeight,
            contentArea,
            paragraph.codeFrame ? 'code' : 'paragraph',
            paragraph.codeFrameIndex === undefined
              ? undefined
              : codeFrameGrids[paragraph.codeFrameIndex]?.bbox
          )))
      }
      const isBlankPage = blocks.length === 0 && !hasVisiblePdfPageContent(operatorList, runtime)
      if (blocks.length === 0 && !isBlankPage) {
        const scanned = await createScannedPageImage(
          page,
          pageIndex,
          input.sha256,
          options.renderPageToImage,
          options.registerAssetBytes
        )
        blocks.push(scanned.block)
        assets.push(scanned.asset)
        if (scanned.block.renderPending) {
          warnings.push(createDocumentWarning(
            'ocr-required',
            'A scanned page requires local rendering before OCR.',
            { pageId, blockId: scanned.block.blockId }
          ))
        }
      } else if (blocks.length > 0) {
        const regions = imageRegions
        const availableImageSlots = Math.max(0, DOCUMENT_MAX_IMAGES - assets.length)
        const acceptedRegions = regions.slice(0, availableImageSlots)
        if (regions.length > acceptedRegions.length) {
          warnings.push(createDocumentWarning('image-limit-reached', 'The PDF image limit was reached; remaining images were skipped.', { pageId }))
        }
        const assetBytesById = new Map<string, Uint8Array>()
        for (let regionIndex = 0; regionIndex < acceptedRegions.length; regionIndex += 1) {
          if (options.signal?.aborted) throw createPdfAbortError()
          const region = acceptedRegions[regionIndex]!
          const image = await createEmbeddedImageBlock(
            page,
            pageIndex,
            input.sha256,
            blocks.length + regionIndex,
            region.bbox,
            region.objectId,
            options.renderEmbeddedImageToImage,
            options.renderPageRegionToImage,
            options.registerAssetBytes,
            assetBytesById
          )
          const tableTarget = tableGridTargets.find((target) =>
            pdfTableCellIndexForRegion(target.grid, region) !== undefined)
          const cellIndex = tableTarget
            ? pdfTableCellIndexForRegion(tableTarget.grid, region)
            : undefined
          if (!tableTarget || !cellIndex || !appendPdfTableCellBlock(
            tableTarget.table,
            cellIndex.rowIndex,
            cellIndex.cellIndex,
            image.block
          )) {
            blocks.push(image.block)
          }
          if (!assets.some((asset) => asset.assetId === image.asset.assetId)) assets.push(image.asset)
        }
        if (acceptedRegions.length > 0) {
          warnings.push(createDocumentWarning('embedded-image-ocr-required', 'The PDF page contains images whose text will be recognized during OCR.', { pageId }))
        }
      }
      pages.push({
        pageId,
        index: pageIndex,
        width: viewport.width,
        height: viewport.height,
        ...(contentArea ? { contentArea } : {}),
        ...(isBlankPage ? { background: { kind: 'solid' as const, color: '#ffffff' } } : {}),
        blocks: orderPdfPageBlocks(blocks, pageId, input.sha256)
      })
      if (options.signal?.aborted) throw createPdfAbortError()
    }
    return {
      schemaVersion: 1,
      documentId: createDocumentModelId(input.sha256),
      source: {
        path: input.path,
        fileName: input.fileName,
        format: 'pdf',
        sha256: input.sha256,
        size: input.bytes.byteLength,
        pageCount: pages.length
      },
      metadata: { direction: 'auto' },
      pages,
      assets,
      warnings
    }
  } finally {
    await document.destroy()
  }
}
