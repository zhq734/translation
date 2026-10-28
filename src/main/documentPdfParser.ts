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

/** PDF 仿射变换矩阵，顺序与 Canvas 的 a、b、c、d、e、f 一致。 */
type PdfMatrix = [number, number, number, number, number, number]

/** 页面内嵌图片的裁切区域。 */
interface PdfEmbeddedImageRegion {
  /** 页面视图坐标。 */
  bbox: DocumentBoundingBox
  /** PDF.js 图片对象标识；内联图片没有可复用对象标识时省略。 */
  objectId?: string
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

/** 网格线坐标合并与闭合判定的容差，单位为页面点。 */
const PDF_TABLE_LINE_TOLERANCE = 2

/** 表格网格的最小宽高，单位为页面点。 */
const PDF_MIN_TABLE_SIZE = 16

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
  const lineWidthOperation = runtime.OPS['setLineWidth']
  let strokeColor: string | undefined
  let strokeThickness = 1
  const graphicsStack: Array<{ color?: string; thickness: number }> = []

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
      lines.push({
        orientation: 'vertical',
        start: Math.min(start.y, end.y),
        end: Math.max(start.y, end.y),
        position: (start.x + end.x) / 2,
        ...(strokeColor ? { color: strokeColor } : {}),
        thickness: strokeThickness
      })
    } else if (dy <= tolerance && dx >= PDF_MIN_TABLE_LINE_LENGTH) {
      lines.push({
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
      graphicsStack.push({ color: strokeColor, thickness: strokeThickness })
      stack.push(current)
      continue
    }
    if (operation === restoreOperationValue) {
      const graphics = graphicsStack.pop()
      if (graphics) {
        strokeColor = graphics.color
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
    if (operation === lineWidthOperation) {
      const width = pdfColorComponents(args)[0]
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) strokeThickness = width
      continue
    }
    if (operation !== constructPathOperation) continue

    const pathOperations = Array.isArray(args[0]) ? args[0] : []
    const pathArguments = Array.isArray(args[1]) ? args[1] : []
    let argumentIndex = 0
    let cursor: { x: number; y: number } | undefined
    let subpathStart: { x: number; y: number } | undefined
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
      } else if (pathOperation === moveToOperation) {
        const x = pathArguments[argumentIndex]
        const y = pathArguments[argumentIndex + 1]
        argumentIndex += 2
        if (typeof x !== 'number' || typeof y !== 'number') continue
        cursor = point(x, y)
        subpathStart = cursor
      } else if (pathOperation === lineToOperation) {
        const x = pathArguments[argumentIndex]
        const y = pathArguments[argumentIndex + 1]
        argumentIndex += 2
        if (typeof x !== 'number' || typeof y !== 'number') continue
        const next = point(x, y)
        if (cursor) addLine(cursor, next)
        cursor = next
      } else if (pathOperation === closePathOperation) {
        if (cursor && subpathStart) addLine(cursor, subpathStart)
        cursor = subpathStart
      } else if (pathOperation === runtime.OPS['curveTo']) {
        argumentIndex += 6
        cursor = undefined
      } else if (pathOperation === runtime.OPS['curveTo2'] || pathOperation === runtime.OPS['curveTo3']) {
        argumentIndex += 4
        cursor = undefined
      }
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
 * 判断一条线段是否完全属于已识别的闭合表格网格，避免表格线与表格边框重复绘制。
 * @param line 候选线段。
 * @param grids 已识别表格网格。
 * @returns 是否被任一表格网格完整覆盖。
 * @author zhenghq
 */
function pdfLineInsideDetectedGrid(line: PdfGridLine, grids: readonly PdfDetectedGrid[]): boolean {
  return grids.some((grid) => {
    if (line.orientation === 'horizontal') {
      return line.position >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
        line.position <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE &&
        line.start >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
        line.end <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE
    }
    return line.position >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE &&
      line.position <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE &&
      line.start >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE &&
      line.end <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE
  })
}

/**
 * 将未落入表格网格的水平或垂直分隔线转换为可渲染的形状区块。
 * @param lines 页面全部去重线段。
 * @param grids 已识别表格网格。
 * @param pageId 页面标识。
 * @param fingerprint 文档指纹。
 * @returns 分隔线形状区块。
 * @author zhenghq
 */
function createPdfDividerBlocks(
  lines: readonly PdfGridLine[],
  grids: readonly PdfDetectedGrid[],
  pageId: string,
  fingerprint: string
): DocumentBlock[] {
  const dividers = lines.filter((line) => !pdfLineInsideDetectedGrid(line, grids))
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
            y: line.position - Math.max(0.5, (line.thickness ?? 1) / 2),
            width: Math.max(1, line.end - line.start),
            height: Math.max(1, line.thickness ?? 1)
          }
        : {
            x: line.position - Math.max(0.5, (line.thickness ?? 1) / 2),
            y: line.start,
            width: Math.max(1, line.thickness ?? 1),
            height: Math.max(1, line.end - line.start)
          },
      line: lineStyle
    }
  })
}

/**
 * 从闭合横纵网格中提取表格边界与行列分隔线。
 * 仅有一条横线或网格未闭合时返回空数组，避免把普通边框识别为表格。
 * @param lines 去重后的页面线段。
 * @returns 可命中的表格网格。
 * @author zhenghq
 */
function detectPdfTableGrids(lines: readonly PdfGridLine[]): PdfDetectedGrid[] {
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
        line.end >= Math.max(top.end, bottom.end) - PDF_TABLE_LINE_TOLERANCE)
      if (rowLines.length < 2) continue
      const columnLines = vertical.filter((line) =>
        line.start <= top.position + PDF_TABLE_LINE_TOLERANCE &&
        line.end >= bottom.position - PDF_TABLE_LINE_TOLERANCE)
      if (columnLines.length < 2) continue
      const columns = [...new Set(columnLines.map((line) => Math.round(line.position * 100) / 100))].sort((a, b) => a - b)
      const rows = [...new Set(rowLines.map((line) => Math.round(line.position * 100) / 100))].sort((a, b) => a - b)
      if (columns.length < 2 || rows.length < 2) continue
      const left = columns[0]!
      const right = columns[columns.length - 1]!
      const topPosition = rows[0]!
      const bottomPosition = rows[rows.length - 1]!
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
  // 同一组横纵线会组合出多个只覆盖部分行的候选网格；只保留最大的闭合区域，
  // 避免把一张两行表拆成两个单行表，也避免重复翻译同一批文本。
  return grids.filter((grid, index) => !grids.some((candidate, candidateIndex) =>
    candidateIndex !== index &&
    candidate.bbox.x <= grid.bbox.x + PDF_TABLE_LINE_TOLERANCE &&
    candidate.bbox.y <= grid.bbox.y + PDF_TABLE_LINE_TOLERANCE &&
    candidate.bbox.x + candidate.bbox.width >= grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE &&
    candidate.bbox.y + candidate.bbox.height >= grid.bbox.y + grid.bbox.height - PDF_TABLE_LINE_TOLERANCE &&
    (candidate.bbox.width > grid.bbox.width + PDF_TABLE_LINE_TOLERANCE ||
      candidate.bbox.height > grid.bbox.height + PDF_TABLE_LINE_TOLERANCE)
  ))
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
  const rightCounts = new Map<number, number>()
  for (const line of lines) {
    if (line.bbox.width <= 0) continue
    const left = Math.round(line.bbox.x)
    const right = Math.round(line.bbox.x + line.bbox.width)
    leftCounts.set(left, (leftCounts.get(left) ?? 0) + 1)
    rightCounts.set(right, (rightCounts.get(right) ?? 0) + 1)
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
  const right = mostFrequent(rightCounts)
  if (left === undefined || right === undefined || right - left < pageWidth * 0.25) return undefined
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
  const rightGap = Math.max(0, pageWidth - bbox.x - bbox.width)
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
  if (bbox.width < pageWidth * 0.82 && leftGap > pageWidth * 0.12 && rightGap < leftGap * 0.6) return 'right'
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
  contentArea?: { left: number; right: number; center: number }
): DocumentTextBlock {
  const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, 'text')
  const runs: DocumentTextRun[] = items.map((item, index) => {
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

  return ordered.map(({ block }, readingOrder) => {
    const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, block.kind)
    if (block.kind === 'text') {
      return {
        ...block,
        blockId,
        readingOrder,
        runs: block.runs.map((run, index) => ({ ...run, runId: createTextRunId(blockId, index) }))
      }
    }
    if (block.kind === 'table') {
      return {
        ...block,
        blockId,
        readingOrder,
        rows: block.rows.map((row, rowIndex) => ({
          ...row,
          rowId: createTableRowId(blockId, rowIndex),
          cells: row.cells.map((cell, cellIndex) => {
            const cellId = createTableCellId(fingerprint, pageId, blockId, rowIndex, cellIndex)
            return {
              ...cell,
              cellId,
              blocks: cell.blocks.map((child, childIndex) => {
                if (child.kind !== 'text') return child
                const childBlockId = createPdfTableCellBlockId(cellId, childIndex)
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
    return { ...block, blockId, readingOrder }
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
      if (hasNativeText) {
        applyPdfTextColors(textContent.items, extractPdfTextColors(operatorList, runtime))
        const styles = enrichPdfFontStyles(page, textContent.items, textContent.styles ?? {})
        const lines = groupPdfTextItems(textContent.items, viewport.height)
        const bodyFontSize = inferPdfBodyFontSize(lines)
        const lineHeights = inferPdfLineHeights(lines)
        const contentArea = inferPdfContentArea(lines, viewport.width)
        const gridLines = mergePdfGridLines(extractPdfGridLines(operatorList, runtime, viewport))
        const grids = detectPdfTableGrids(gridLines)
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
            remainingLines = parsed.remainingLines
          }
        }
        blocks.push(...tableBlocks, ...createPdfDividerBlocks(gridLines, grids, pageId, input.sha256), ...remainingLines.map((line, readingOrder) =>
          createPdfTextBlock(
            line.items,
            pageId,
            input.sha256,
            readingOrder,
            line.bbox,
            viewport.width,
            bodyFontSize,
            styles,
            lineHeights.get(line),
            contentArea
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
        const regions = extractPdfImageRegions(operatorList, runtime, viewport)
        const availableImageSlots = Math.max(0, DOCUMENT_MAX_IMAGES - assets.length)
        const acceptedRegions = regions.slice(0, availableImageSlots)
        if (regions.length > acceptedRegions.length) {
          warnings.push(createDocumentWarning('image-limit-reached', 'The PDF image limit was reached; remaining images were skipped.', { pageId }))
        }
        const assetBytesById = new Map<string, Uint8Array>()
        for (let regionIndex = 0; regionIndex < acceptedRegions.length; regionIndex += 1) {
          if (options.signal?.aborted) throw createPdfAbortError()
          const image = await createEmbeddedImageBlock(
            page,
            pageIndex,
            input.sha256,
            blocks.length + regionIndex,
            acceptedRegions[regionIndex]!.bbox,
            acceptedRegions[regionIndex]!.objectId,
            options.renderEmbeddedImageToImage,
            options.renderPageRegionToImage,
            options.registerAssetBytes,
            assetBytesById
          )
          blocks.push(image.block)
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
