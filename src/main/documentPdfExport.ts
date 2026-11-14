import fontkit from '@pdf-lib/fontkit'
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage
} from 'pdf-lib'
import type {
  DocumentBlock,
  DocumentBoundingBox,
  DocumentImageBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentPage,
  DocumentTableBlock,
  DocumentTableCell,
  DocumentTextBlock,
  DocumentTextAlign,
  DocumentTextRun,
  DocumentTextStyle,
  DocumentWarning
} from '../shared/documentTypes.ts'
import {
  resolveDocumentOcrRegionFlowTop,
  resolveDocumentOcrTranslationHorizontalBounds,
  resolveOcrRegionFontSize,
  resolveOcrRegionLineHeight,
  resolveOcrRegionPadding,
  type DocumentOcrFlowRect
} from '../shared/documentOcrLayout.ts'
import {
  resolveTranslationFlowDecorationTop,
  resolveTranslationFlowGroupGeometry,
  type DocumentTranslationImageFlowRow
} from '../renderer/src/documentPdfLayout.ts'
import {
  resolveDocumentImageOverlayBounds
} from '../renderer/src/documentImageOverlayLayout.ts'
import { resolveDocumentImageStackBounds } from '../renderer/src/documentImageStackLayout.ts'
import {
  resolveDocumentImageStackContainedTexts,
  resolveDocumentImageStackGroups
} from '../shared/documentImageStacks.ts'
import { decodePng } from './pngCodec.ts'

/** PDF 导出稳定错误分类。 */
export type DocumentPdfExportErrorCode =
  | 'font-missing'
  | 'invalid-document'
  | 'asset-unavailable'
  | 'export-failed'

/** 文档 PDF 导出错误。 */
export class DocumentPdfExportError extends Error {
  /** 可供界面本地化的稳定错误分类。 */
  readonly code: DocumentPdfExportErrorCode

  /**
   * 创建 PDF 导出错误。
   * @param code 稳定错误分类。
   * @param message 内部脱敏错误说明。
   * @author zhenghq
   */
  constructor(code: DocumentPdfExportErrorCode, message: string) {
    super(message)
    this.name = 'DocumentPdfExportError'
    this.code = code
  }
}

/**
 * 创建 PDF 合成取消错误，避免被统一包装成导出失败。
 * @returns 名称为 AbortError 的错误。
 * @author zhenghq
 */
function createExportAbortError(): Error {
  const error = new Error('PDF export cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * 判断异常是否表示用户取消导出。
 * @param error 待判断的异常。
 * @returns 是否为 AbortError。
 * @author zhenghq
 */
function isExportAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

/** PDF 导出选项。 */
export interface DocumentPdfExportOptions {
  /** 为图片区块追加透明的 OCR 原文文字层，生成可检索的双层 PDF。 */
  includeOcrTextLayer?: boolean
  /** 取消导出时触发的中止信号。 */
  signal?: AbortSignal
  /** 每完成一页后上报的合成进度。 */
  onProgress?: (progress: { completedPages: number; totalPages: number }) => void
}

/** PDF 导出依赖。 */
export interface DocumentPdfExportDependencies {
  /** 读取支持 CJK 的字体字节；没有字体时返回 null。 */
  loadFontBytes(): Promise<Uint8Array | null>
  /** 读取文档资源字节；资源不存在时返回 null。 */
  loadAssetBytes(assetId: string): Promise<Uint8Array | null>
  /** 原始 PDF 字节；提供时保留原页面并只追加 OCR 透明文字层。 */
  sourcePdfBytes?: Uint8Array
}

/** PDF 导出成功结果；告警表示已生成的 PDF 存在可降级内容。 */
export interface DocumentPdfExportResult {
  /** 生成的 PDF 字节。 */
  bytes: Uint8Array
  /** 导出期间产生的可降级告警。 */
  warnings: DocumentWarning[]
}

/** 字体选择结果。 */
interface ResolvedFonts {
  /** 正文字体。 */
  regular: PDFFont
  /** 粗体字体；没有独立粗体时复用正文字体。 */
  bold: PDFFont
  /** 斜体字体；没有独立斜体时复用正文字体。 */
  italic: PDFFont
  /** 粗斜体字体；没有独立字体时优先复用粗体。 */
  boldItalic: PDFFont
}

/** PDF 绘制上下文。 */
interface DrawContext {
  /** 当前页面。 */
  page: PDFPage
  /** 正文字体。 */
  regular: PDFFont
  /** 粗体字体。 */
  bold: PDFFont
  /** 斜体字体。 */
  italic: PDFFont
  /** 粗斜体字体。 */
  boldItalic: PDFFont
  /** 已加载图片缓存。 */
  images: Map<string, PDFImage | null>
  /** 已读取图片字节缓存，避免遮罩采样重复访问资源存储。 */
  assetBytes: Map<string, Uint8Array | null>
  /** 已解码图片像素缓存，仅用于图内文字局部背景采样。 */
  maskImages: Map<string, PdfImageMaskImage | null>
  /** 导出期间收集的可降级告警。 */
  warnings: DocumentWarning[]
}

/** 图内文字遮罩采样使用的 RGBA 图片。 */
interface PdfImageMaskImage {
  /** 图片像素宽度。 */
  width: number
  /** 图片像素高度。 */
  height: number
  /** 按 RGBA 排列的像素数据。 */
  data: Uint8Array | Uint8ClampedArray
}

/** 图内文字遮罩采样矩形。 */
interface PdfImageMaskRect {
  /** 左边界。 */
  left: number
  /** 上边界。 */
  top: number
  /** 右边界。 */
  right: number
  /** 下边界。 */
  bottom: number
}

/** 文档页面排版器；负责按页底自动创建新页并维护纵向游标。 */
interface PageComposer {
  /** 当前 PDF 页面。 */
  page: PDFPage
  /** 当前页面模型，用于获取页面尺寸、标识与底色。 */
  pageModel: DocumentPage
  /** 页面顶部内容边距。 */
  readonly contentTop: number
  /** 页面底部内容边距。 */
  readonly contentBottom: number
  /** 当前流式排版游标，表示下一块内容可使用的页面顶部坐标。 */
  cursor: number
  /** 当前页面已绘制区块的原始底部坐标。 */
  sourceBottom: number
  /** 当前页最近一个占用普通流的区块原始顶部坐标。 */
  flowSourceTop: number
  /** 当前页最近一个占用普通流的区块实际顶部坐标。 */
  flowActualTop: number
  /** 当前页最近一个占用普通流的区块原始底部坐标。 */
  flowSourceBottom: number
  /** 当前页最近一个占用普通流的区块实际底部坐标。 */
  flowActualBottom: number
  /** 当前页最近一个占用普通流的区块在原始页面中的横向位置。 */
  flowLeft: number
  /** 当前页最近一个占用普通流的区块在原始页面中的宽度。 */
  flowWidth: number
  /** 上一个已绘制区块，用于沿用 PDF 原始段间距。 */
  previousBlock?: DocumentBlock
  /** 是否已有文本块在当前页序列中跨页续排。 */
  flowContinuationActive: boolean
  /** 当前源页面在流式排版中创建的全部物理页面，用于续绘跨页结构线。 */
  flowPages: PDFPage[]
  /** 已跨页的文本区块原始范围，用于识别哪些结构线需要续绘。 */
  continuationTextBlocks: DocumentBlock[]
  /** 已跨页文本在续页上的实际底部坐标，用于闭合结构竖线。 */
  continuationActualBottom: number
  /** 跨页正文之后的首个尾注是否已开始排版。 */
  continuationTailStarted: boolean
  /** 续页第一条细装饰线的原始顶部坐标；用于后续装饰线保留源间距。 */
  continuationDecorationSourceTop?: number
  /** 续页第一条细装饰线的实际顶部坐标。 */
  continuationDecorationActualTop?: number
  /** 续页最后一条结构水平线的实际顶部坐标，用于闭合结构竖线。 */
  continuationStructuralBottom?: number
}

/** 表格单元格在占用矩阵中的实际排版位置。 */
interface TableCellPlacement {
  /** 原始单元格。 */
  cell: DocumentTableCell
  /** 从零开始的物理行索引。 */
  rowIndex: number
  /** 从零开始的物理列索引。 */
  columnIndex: number
  /** 实际占用的行数。 */
  rowSpan: number
  /** 实际占用的列数。 */
  colSpan: number
}

/** 视觉文本行中保留原样式的文本片段。 */
interface FlowTextFragment {
  /** 原始文本片段，用于合并同一 run 的连续内容。 */
  run: DocumentTextRun
  /** 当前排版行中的文本。 */
  text: string
  /** 合并区块、单元格与 run 后的最终样式。 */
  style: DocumentTextStyle
  /** 当前片段使用的字体。 */
  font: PDFFont
  /** 当前片段字号。 */
  fontSize: number
  /** 当前片段行高。 */
  lineHeight: number
  /** 当前片段实际文本宽度。 */
  width: number
}

/** 文本流中的一个视觉文本行。 */
interface FlowTextLine {
  /** 该行按绘制顺序排列的文本片段。 */
  fragments: FlowTextFragment[]
  /** 整行文本总宽度，用于统一对齐。 */
  width: number
  /** 整行高度。 */
  height: number
  /** 整行最大字号，用于让混合字号片段共享基线。 */
  maxFontSize: number
}

/** CJK 字符探测表达式。 */
const CJK_TEXT_PATTERN = /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

/** PDF 结构框线统一线宽；预览侧同样把 1pt 以上框线渲染为结构线。 */
const PDF_STRUCTURAL_LINE_THICKNESS = 1.5

/** 跨页尾注在续页上的最大首段间距，避免继承旧页正文到签名的整段留白。 */
const PDF_CONTINUATION_TAIL_GAP_MAX = 12

/**
 * 判断文本是否包含需要 CJK 字体的字符。
 * @param text 待检查文本。
 * @returns 是否包含 CJK 字符。
 * @author zhenghq
 */
function containsCjk(text: string): boolean {
  return CJK_TEXT_PATTERN.test(text)
}

/**
 * 递归收集文档全部文本。
 * @param blocks 区块列表。
 * @param output 文本收集数组。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectBlockText(blocks: DocumentBlock[], output: string[]): void {
  for (const block of blocks) {
    if (block.kind === 'text') {
      output.push(block.runs.map((run) => run.text).join(''))
    } else if (block.kind === 'image') {
      for (const region of block.ocrRegions ?? []) {
        output.push(region.text)
        if (region.translatedText) output.push(region.translatedText)
      }
    } else if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) collectBlockText(cell.blocks, output)
      }
    } else if (block.kind === 'formula') {
      if (block.sourceText) output.push(block.sourceText)
      if (block.latex) output.push(block.latex)
    }
  }
}

/**
 * 判断文档是否需要 CJK 字体。
 * @param model 文档模型。
 * @returns 是否存在中文字符。
 * @author zhenghq
 */
function documentNeedsCjkFont(model: DocumentModel): boolean {
  const texts: string[] = []
  for (const page of model.pages) collectBlockText(page.blocks, texts)
  return texts.some(containsCjk)
}

/**
 * 加载正文字体；文档含 CJK 时只接受可嵌入的 CJK 字体。
 * @param document PDF 文档。
 * @param model 文档模型。
 * @param dependencies 导出依赖。
 * @returns 已嵌入字体。
 * @author zhenghq
 */
async function resolveFonts(
  document: PDFDocument,
  model: DocumentModel,
  dependencies: DocumentPdfExportDependencies
): Promise<ResolvedFonts> {
  const needsCjk = documentNeedsCjkFont(model)
  let fontBytes: Uint8Array | null = null
  try {
    fontBytes = await dependencies.loadFontBytes()
  } catch {
    fontBytes = null
  }
  if (fontBytes && fontBytes.byteLength > 0) {
    try {
      document.registerFontkit(fontkit)
      // 完整嵌入静态 TrueType 字体，避免 CFF/OTF 子集在部分查看器中丢失字形；
      // 禁用 locl，避免 ASCII 被替换为其他字形后导致 ToUnicode 文本层错位。
      const regular = await document.embedFont(fontBytes, {
        subset: false,
        features: { locl: false }
      })
      return { regular, bold: regular, italic: regular, boldItalic: regular }
    } catch {
      if (needsCjk) throw new DocumentPdfExportError('font-missing', 'CJK font cannot be embedded')
    }
  }
  if (needsCjk) throw new DocumentPdfExportError('font-missing', 'CJK font is unavailable')
  const regular = await document.embedFont(StandardFonts.Helvetica, { customName: 'Helvetica' })
  const bold = await document.embedFont(StandardFonts.HelveticaBold, { customName: 'Helvetica-Bold' })
  const italic = await document.embedFont(StandardFonts.HelveticaOblique, { customName: 'Helvetica-Oblique' })
  const boldItalic = await document.embedFont(StandardFonts.HelveticaBoldOblique, { customName: 'Helvetica-BoldOblique' })
  return { regular, bold, italic, boldItalic }
}

/**
 * 将 CSS 颜色转换为 PDF 颜色；无法识别时使用安全默认色。
 * @param value CSS 颜色字符串。
 * @param fallback 默认 RGB 分量。
 * @returns PDF RGB 颜色。
 * @author zhenghq
 */
function parseColor(value: string | undefined, fallback: [number, number, number] = [0.1, 0.12, 0.16]) {
  if (!value) return rgb(...fallback)
  const normalized = value.trim().toLowerCase()
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex
    return rgb(
      Number.parseInt(expanded.slice(0, 2), 16) / 255,
      Number.parseInt(expanded.slice(2, 4), 16) / 255,
      Number.parseInt(expanded.slice(4, 6), 16) / 255
    )
  }
  const rgbMatch = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u)
  if (rgbMatch) {
    return rgb(
      Math.min(255, Number(rgbMatch[1])) / 255,
      Math.min(255, Number(rgbMatch[2])) / 255,
      Math.min(255, Number(rgbMatch[3])) / 255
    )
  }
  return rgb(...fallback)
}

/**
 * 根据页面坐标计算 PDF 左下角 Y 坐标。
 * @param pageHeight 页面高度。
 * @param top 元素顶部坐标。
 * @param height 元素高度。
 * @returns PDF 坐标。
 * @author zhenghq
 */
function pdfY(pageHeight: number, top: number, height: number): number {
  return pageHeight - top - height
}

/**
 * 将文本安全地编码为当前字体支持的字符；无法编码字符替换为问号。
 * @param text 原始文本。
 * @param font 目标字体。
 * @returns 可绘制文本。
 * @author zhenghq
 */
function safeFontText(text: string, font: PDFFont): string {
  try {
    font.encodeText(text)
    return text
  } catch {
    let result = ''
    for (const char of text) {
      try {
        font.encodeText(char)
        result += char
      } catch {
        result += '?'
      }
    }
    return result
  }
}

/**
 * 按可用宽度换行文本，同时保留显式换行。
 * @param text 原始文本。
 * @param font 字体。
 * @param fontSize 字号。
 * @param maxWidth 最大宽度。
 * @returns 行数组。
 * @author zhenghq
 */
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of safeFontText(text, font).split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let current = ''
    // 英文单词作为不可拆分单元，只有单词本身超宽时才退化为字符换行；中文仍按字符换行。
    const tokens = paragraph.match(/[\p{Script=Latin}\p{N}_'’-]+|\s+|./gu) ?? [paragraph]
    for (const token of tokens) {
      if (font.widthOfTextAtSize(current + token, fontSize) <= maxWidth) {
        current += token
        continue
      }
      if (current) {
        lines.push(current)
        current = ''
      }
      const trimmedToken = token.trimStart()
      if (!trimmedToken) continue
      if (font.widthOfTextAtSize(trimmedToken, fontSize) <= maxWidth) {
        current = trimmedToken
        continue
      }
      for (const char of trimmedToken) {
        if (current && font.widthOfTextAtSize(current + char, fontSize) > maxWidth) {
          lines.push(current)
          current = char
        } else {
          current += char
        }
      }
    }
    if (current) lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}

/**
 * 计算页面内容区的上下边距；短页面使用比例边距，正常页面使用固定留白。
 * @param height 页面高度。
 * @returns 内容区上下边距。
 * @author zhenghq
 */
function pageContentInsets(height: number): { top: number; bottom: number } {
  const inset = Math.max(12, Math.min(48, height * 0.06))
  return { top: inset, bottom: inset }
}

/**
 * 创建一个新的 PDF 页面，并复制源页面的底色。
 * @param document PDF 文档。
 * @param pageModel 源页面模型。
 * @returns 新建的 PDF 页面。
 * @author zhenghq
 */
function createComposedPage(document: PDFDocument, pageModel: DocumentPage): PDFPage {
  const width = Math.max(72, pageModel.width)
  const height = Math.max(72, pageModel.height)
  const page = document.addPage([width, height])
  if (pageModel.background?.kind === 'solid') {
    page.drawRectangle({ x: 0, y: 0, width, height, color: parseColor(pageModel.background.color, [1, 1, 1]) })
  }
  return page
}

/**
 * 创建页面排版器；分页 PDF 保留原始页，流式文档从首块坐标开始排版。
 * @param document PDF 文档。
 * @param context 绘制上下文。
 * @param pageModel 页面模型。
 * @returns 初始化后的页面排版器。
 * @author zhenghq
 */
function createPageComposer(
  document: PDFDocument,
  context: DrawContext,
  pageModel: DocumentPage
): PageComposer {
  const insets = pageContentInsets(pageModel.height)
  const geometryBlocks = pageModel.blocks.filter((block) => block.bbox !== undefined)
  const firstGeometryTop = geometryBlocks.length > 0
    ? Math.min(...geometryBlocks.map((block) => block.bbox!.y))
    : insets.top
  return {
    page: context.page,
    pageModel,
    contentTop: Math.max(0, Math.min(insets.top, firstGeometryTop)),
    contentBottom: insets.bottom,
    cursor: Math.max(0, firstGeometryTop),
    sourceBottom: Math.max(0, firstGeometryTop),
    flowSourceTop: Math.max(0, firstGeometryTop),
    flowActualTop: Math.max(0, firstGeometryTop),
    flowSourceBottom: Math.max(0, firstGeometryTop),
    flowActualBottom: Math.max(0, firstGeometryTop),
    // 首个流式区块绘制前没有可锚定对象，空横向范围避免原始页眉框被初始游标带动。
    flowLeft: 0,
    flowWidth: 0,
    flowContinuationActive: false,
    flowPages: [context.page],
    continuationTextBlocks: [],
    continuationActualBottom: Math.max(0, firstGeometryTop),
    continuationTailStarted: false
  }
}

/**
 * 确保当前页面剩余空间足以容纳指定高度；不足时新建同尺寸页面并重置游标。
 * @param composer 页面排版器。
 * @param document PDF 文档。
 * @param context 绘制上下文。
 * @param requiredHeight 当前区块至少需要的高度。
 * @returns 当前页是否发生了换页。
 * @author zhenghq
 */
function ensurePageSpace(
  composer: PageComposer,
  document: PDFDocument,
  context: DrawContext,
  requiredHeight: number
): boolean {
  const pageHeight = composer.page.getHeight()
  if (composer.cursor + requiredHeight <= pageHeight - composer.contentBottom) return false
  composer.page = createComposedPage(document, composer.pageModel)
  context.page = composer.page
  composer.flowPages.push(composer.page)
  composer.cursor = composer.contentTop
  composer.sourceBottom = composer.contentTop
  composer.flowSourceTop = composer.contentTop
  composer.flowActualTop = composer.contentTop
  composer.flowSourceBottom = composer.contentTop
  composer.flowActualBottom = composer.contentTop
  // 新页没有已绘制的流式内容；空横向范围可阻止页眉/页脚装饰线错误继承旧页锚点。
  composer.flowLeft = 0
  composer.flowWidth = 0
  return true
}

/**
 * 记录最近一个占用普通流区块的原始与实际纵向范围，供后续装饰线动态定位。
 * @param composer 页面排版器。
 * @param block 已绘制区块。
 * @param actualTop 区块实际顶部坐标。
 * @param actualBottom 区块实际内容底部坐标。
 * @author zhenghq
 */
function recordPdfFlowAnchor(
  composer: PageComposer,
  block: DocumentBlock,
  actualTop: number,
  actualBottom: number
): void {
  const bbox = block.bbox
  if (!bbox || !Number.isFinite(actualTop) || !Number.isFinite(actualBottom)) return
  composer.flowSourceTop = bbox.y
  composer.flowActualTop = actualTop
  composer.flowSourceBottom = bbox.y + bbox.height
  composer.flowActualBottom = actualBottom
  composer.flowLeft = bbox.x
  composer.flowWidth = Math.max(0, bbox.width)
}

/**
 * 计算水平装饰线相对最近前序流式区块的实际顶部位置。
 * 装饰线位于区块下方时沿用原始底边间距，位于区块内部时沿用原始相对偏移。
 * @param composer 页面排版器。
 * @param sourceTop 装饰线原始顶部坐标。
 * @returns 重定位后的顶部坐标；没有可用前序锚点时返回 undefined。
 * @author zhenghq
 */
function resolvePdfDecorationTop(
  composer: PageComposer,
  sourceTop: number
): number | undefined {
  if (composer.flowSourceBottom <= composer.flowSourceTop) return undefined
  return resolveTranslationFlowDecorationTop(sourceTop, [{
    sourceTop: composer.flowSourceTop,
    sourceBottom: composer.flowSourceBottom,
    actualTop: composer.flowActualTop,
    actualBottom: composer.flowActualBottom
  }], 1)
}

/**
 * 判断水平装饰线是否与最近前序流式区块横向相交。
 * 页眉框、页脚线和纸张外框常与表格纵向邻近，但横向位置不同，不能因此被表格锚点带走。
 * @param composer 页面排版器。
 * @param block 待绘制的形状区块。
 * @returns 两者存在实际横向重叠时返回 true。
 * @author zhenghq
 */
function pdfDecorationOverlapsFlow(
  composer: PageComposer,
  block: DocumentBlock
): boolean {
  const bbox = block.bbox
  if (!bbox || bbox.width <= 0) return false
  const left = Math.max(bbox.x, composer.flowLeft)
  const right = Math.min(bbox.x + bbox.width, composer.flowLeft + composer.flowWidth)
  return right > left
}

/**
 * 计算水平装饰线应使用的当前页顶部坐标。
 * 只有与前序流式区块横向相交时才启用动态锚定；分页后当前页没有有效锚点时保留原坐标。
 * @param composer 页面排版器。
 * @param block 待绘制的形状区块。
 * @param fallbackTop 原坐标与当前游标得到的回退顶部。
 * @returns 最终绘制顶部坐标。
 * @author zhenghq
 */
function resolvePdfHorizontalDecorationTop(
  composer: PageComposer,
  block: DocumentBlock,
  fallbackTop: number
): number {
  if (!pdfDecorationOverlapsFlow(composer, block)) return fallbackTop
  const sourceTop = block.bbox?.y ?? fallbackTop
  // 跨页正文内的细装饰线不能继续使用旧页绝对坐标；首条细线从续页正文实际底边开始，
  // 后续细线按原 PDF 中的相对间距顺延，保证正文下划线与签名区不会落回原页底部。
  if (composer.flowContinuationActive && !isPdfStructuralLine(block)) {
    if (composer.continuationDecorationSourceTop !== undefined &&
        composer.continuationDecorationActualTop !== undefined) {
      return composer.continuationDecorationActualTop +
        (sourceTop - composer.continuationDecorationSourceTop)
    }
    if (sourceTop <= composer.flowSourceBottom) {
      return composer.continuationActualBottom
    }
  }
  const resolved = resolvePdfDecorationTop(composer, sourceTop)
  return resolved !== undefined && Number.isFinite(resolved) ? resolved : fallbackTop
}

/**
 * 记录续页第一条细装饰线的源坐标与实际坐标，供后续细线按源间距顺延。
 * 结构水平线不参与该锚点，避免表格底边反向影响正文下划线的位置。
 * @param composer 页面排版器。
 * @param block 已绘制的水平装饰线。
 * @param actualTop 装饰线实际顶部坐标。
 * @author zhenghq
 */
function recordPdfContinuationDecorationAnchor(
  composer: PageComposer,
  block: DocumentBlock,
  actualTop: number
): void {
  if (!composer.flowContinuationActive || isPdfStructuralLine(block) || !block.bbox) return
  if (composer.continuationDecorationSourceTop !== undefined) return
  composer.continuationDecorationSourceTop = block.bbox.y
  composer.continuationDecorationActualTop = actualTop
}

/**
 * 判断 PDF 形状区块是否为需要与表格外边界统一的结构框线。
 * 原生表格外框通常为 1pt 以上，而原文下划线多为 0.5–0.75pt；仅统一前者，
 * 避免把正文中的细下划线误画成表格边界。
 * @param block 形状区块。
 * @returns 是否为结构框线。
 * @author zhenghq
 */
function isPdfStructuralLine(block: DocumentBlock): boolean {
  return block.kind === 'shape' && Boolean(block.line && (block.line.thickness ?? 1) >= 1)
}

/**
 * 判断区块是否为可跨页续绘的页面结构竖线，排除整页外框等非流式装饰。
 * @param block 待检查的区块。
 * @param pageHeight 当前物理页面高度。
 * @returns 是否为局部结构竖线。
 * @author zhenghq
 */
function isPdfStructuralVerticalLine(block: DocumentBlock, pageHeight: number): boolean {
  return block.kind === 'shape' &&
    block.bbox !== undefined &&
    block.line?.orientation === 'vertical' &&
    block.bbox.height > 0 &&
    block.bbox.height < pageHeight * 0.85
}

/**
 * 判断结构竖线是否与已跨页文本的原始范围相交。
 * @param block 结构竖线区块。
 * @param composer 页面排版器。
 * @returns 与任一跨页文本纵向相交时返回 true。
 * @author zhenghq
 */
function verticalLineIntersectsContinuationText(
  block: DocumentBlock,
  composer: PageComposer
): boolean {
  const lineBbox = block.bbox
  if (!lineBbox) return false
  return composer.continuationTextBlocks.some((textBlock) => {
    const textBbox = textBlock.bbox
    if (!textBbox) return false
    return lineBbox.y < textBbox.y + textBbox.height &&
      lineBbox.y + lineBbox.height > textBbox.y
  })
}

/**
 * 在指定页面按原始线宽与颜色绘制结构竖线。
 * @param page 目标物理页面。
 * @param block 结构竖线区块。
 * @param top 实际顶部坐标。
 * @param bottom 实际底部坐标。
 * @author zhenghq
 */
function drawStructuralVerticalLine(
  page: PDFPage,
  block: Extract<DocumentBlock, { kind: 'shape' }>,
  top: number,
  bottom: number
): void {
  if (!block.bbox || !block.line) return
  const pageHeight = page.getHeight()
  const lineHeight = Math.max(0.5, bottom - top)
  page.drawLine({
    start: { x: block.bbox.x, y: pdfY(pageHeight, top, lineHeight) },
    end: { x: block.bbox.x, y: pdfY(pageHeight, top, 0) },
    thickness: PDF_STRUCTURAL_LINE_THICKNESS,
    color: parseColor(block.line.color, [0.8, 0.82, 0.85])
  })
}

/**
 * 绘制页面中的结构竖线；正文跨页时，与跨页文本相交的竖线会在续页同步续绘。
 * @param pageModel 当前页面模型。
 * @param composer 页面排版器。
 * @author zhenghq
 */
function drawPdfStructuralVerticalLines(
  pageModel: DocumentPage,
  composer: PageComposer
): void {
  const lines = pageModel.blocks.filter((block): block is Extract<DocumentBlock, { kind: 'shape' }> =>
    isPdfStructuralVerticalLine(block, pageModel.height))
  if (lines.length === 0) return
  const firstPage = composer.flowPages[0] ?? composer.page
  const continuationPages = composer.flowContinuationActive && composer.flowPages.length > 1
    ? composer.flowPages.slice(1)
    : []
  const lastPage = composer.flowPages[composer.flowPages.length - 1]
  for (const line of lines) {
    const bbox = line.bbox!
    drawStructuralVerticalLine(firstPage, line, bbox.y, bbox.y + bbox.height)
    if (!continuationPages.length || !verticalLineIntersectsContinuationText(line, composer)) continue
    for (const page of continuationPages) {
      const isLastPage = page === lastPage
      const top = composer.contentTop
      const bottom = isLastPage
        ? Math.max(top, Math.min(
            page.getHeight(),
            composer.continuationStructuralBottom ?? composer.continuationActualBottom
          ))
        : page.getHeight() - composer.contentBottom
      drawStructuralVerticalLine(page, line, top, bottom)
    }
  }
}

/**
 * 在文本续页后按相邻区块的原文段间距，把区块接到续页实际底边之后。
 * @param composer 页面排版器。
 * @param sourceTop 区块原始顶部坐标。
 * @param fallbackTop 无可用续排锚点时的回退顶部坐标。
 * @returns 当前页实际顶部坐标。
 * @author zhenghq
 */
function resolvePdfContinuationTop(
  composer: PageComposer,
  sourceTop: number,
  fallbackTop: number
): number {
  if (!composer.flowContinuationActive) return fallbackTop
  if (!composer.previousBlock?.bbox) return Math.max(composer.cursor, fallbackTop)
  // 普通后续正文从续页内容顶部继续；只有仍紧邻跨页正文且位于源页物理范围内的尾注，
  // 才沿用原文相对间距，避免签名和日期被推回旧页底部或重复下推。
  const sourceGap = Math.max(0, sourceTop - composer.flowSourceBottom)
  const shortTailBlock = sourceTop >= composer.flowSourceBottom && sourceTop <= composer.page.getHeight()
  if (!shortTailBlock) return composer.contentTop
  // 源页底部的大段距属于旧页版式；只压缩跨页正文后的首个尾注，后续 ID、日期仍按原相对间距顺延。
  const isSourceTailArea = sourceTop >= composer.page.getHeight() * 0.75
  const isFirstContinuationTail = isSourceTailArea && !composer.continuationTailStarted
  const continuationGap = isFirstContinuationTail
    ? Math.min(sourceGap, PDF_CONTINUATION_TAIL_GAP_MAX)
    : sourceGap
  if (isFirstContinuationTail) composer.continuationTailStarted = true
  return composer.flowActualBottom + continuationGap
}

/**
 * 按原始页面坐标绘制图片或形状；仅当区块超出物理页面时才创建续页。
 * 内容区底部留白用于文本编辑，不应把仍完整位于原页内的整页图片误判为放不下。
 * @param composer 页面排版器。
 * @param document PDF 文档。
 * @param context 绘制上下文。
 * @param blockTop 区块当前顶部坐标。
 * @param blockHeight 区块高度。
 * @param sourceTop 区块原始顶部坐标。
 * @param sourceHeight 区块原始高度。
 * @returns 区块在当前页实际使用的顶部坐标。
 * @author zhenghq
 */
function ensureGeometryBlockSpace(
  composer: PageComposer,
  document: PDFDocument,
  context: DrawContext,
  blockTop: number,
  blockHeight: number,
  sourceTop: number,
  sourceHeight: number
): number {
  const pageHeight = composer.page.getHeight()
  const fitsOriginalPage = sourceTop >= 0 && sourceTop + sourceHeight <= pageHeight
  if (fitsOriginalPage && blockTop + blockHeight <= pageHeight) return blockTop
  const pageChanged = ensurePageSpace(composer, document, context, blockHeight)
  return pageChanged ? composer.cursor : blockTop
}

/**
 * 判断区块是否带有 PDF 原生几何坐标；有坐标时保留原页，无坐标时按流式文档分页。
 * @param block 文档区块。
 * @returns 是否带有原生几何坐标。
 * @author zhenghq
 */
function hasBlockGeometry(block: DocumentBlock): boolean {
  return block.bbox !== undefined
}

/**
 * 根据文件头识别常见图片格式，避免把 JPEG 等资源误当作 PNG 嵌入。
 * @param bytes 图片字节。
 * @returns 可交给 PDF 文档嵌入的格式；无法识别时返回 null。
 * @author zhenghq
 */
function detectImageFormat(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png'
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg'
  }
  return null
}

/**
 * 计算两个遮罩采样矩形的交集。
 * @param rect 待裁剪矩形。
 * @param bounds 图片实际绘制边界。
 * @returns 有效交集；完全不相交时返回 undefined。
 * @author zhenghq
 */
function intersectPdfImageMaskRect(
  rect: PdfImageMaskRect,
  bounds: PdfImageMaskRect
): PdfImageMaskRect | undefined {
  const intersection = {
    left: Math.max(rect.left, bounds.left),
    top: Math.max(rect.top, bounds.top),
    right: Math.min(rect.right, bounds.right),
    bottom: Math.min(rect.bottom, bounds.bottom)
  }
  return intersection.right > intersection.left && intersection.bottom > intersection.top
    ? intersection
    : undefined
}

/**
 * 将图片原图像素矩形换算为页面坐标。
 * @param rect 页面坐标矩形。
 * @param image 已解码图片尺寸。
 * @param imageBox 图片在页面中的实际绘制边界。
 * @returns 有面积的像素矩形；越界时返回 undefined。
 * @author zhenghq
 */
function resolvePdfImageMaskPixelRect(
  rect: PdfImageMaskRect,
  image: PdfImageMaskImage,
  imageBox: PdfImageMaskRect
): PdfImageMaskRect | undefined {
  const clipped = intersectPdfImageMaskRect(rect, imageBox)
  if (!clipped) return undefined
  const scaleX = image.width / Math.max(1, imageBox.right - imageBox.left)
  const scaleY = image.height / Math.max(1, imageBox.bottom - imageBox.top)
  return {
    left: Math.max(0, Math.floor((clipped.left - imageBox.left) * scaleX)),
    top: Math.max(0, Math.floor((clipped.top - imageBox.top) * scaleY)),
    right: Math.min(image.width, Math.ceil((clipped.right - imageBox.left) * scaleX)),
    bottom: Math.min(image.height, Math.ceil((clipped.bottom - imageBox.top) * scaleY))
  }
}

/**
 * 从图片文字 bbox 上下外侧采样完全透明之外的平均背景色。
 * 采样区刻意避开 bbox 内的原字形，避免把待遮盖文字混入遮罩颜色。
 * @param image 已解码图片像素。
 * @param textBox 原文字在页面中的实际边界。
 * @param imageBox 图片在页面中的实际绘制边界。
 * @returns 归一化 RGB 颜色；没有可采样的不透明像素时返回 undefined。
 * @author zhenghq
 */
function samplePdfImageTextMaskColor(
  image: PdfImageMaskImage,
  textBox: DocumentBoundingBox,
  imageBox: DocumentBoundingBox
): readonly [number, number, number] | undefined {
  if (image.width <= 0 || image.height <= 0) return undefined
  const textRect: PdfImageMaskRect = {
    left: textBox.x,
    top: textBox.y,
    right: textBox.x + textBox.width,
    bottom: textBox.y + textBox.height
  }
  const imageRect: PdfImageMaskRect = {
    left: imageBox.x,
    top: imageBox.y,
    right: imageBox.x + imageBox.width,
    bottom: imageBox.y + imageBox.height
  }
  const clippedText = intersectPdfImageMaskRect(textRect, imageRect)
  if (!clippedText) return undefined
  const horizontalPadding = Math.max(1, clippedText.right - clippedText.left) * 0.08
  const sampleLeft = clippedText.left + horizontalPadding
  const sampleRight = clippedText.right - horizontalPadding
  const textHeight = Math.max(1, clippedText.bottom - clippedText.top)
  const bandGap = Math.max(0.75, Math.min(1.5, textHeight * 0.15))
  const bandHeight = Math.max(1, Math.min(4, textHeight * 0.6))
  const bands: PdfImageMaskRect[] = [{
    left: sampleLeft,
    top: clippedText.top - bandGap - bandHeight,
    right: sampleRight,
    bottom: clippedText.top - bandGap
  }, {
    left: sampleLeft,
    top: clippedText.bottom + bandGap,
    right: sampleRight,
    bottom: clippedText.bottom + bandGap + bandHeight
  }]
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (const band of bands) {
    const pixelRect = resolvePdfImageMaskPixelRect(band, image, imageRect)
    if (!pixelRect) continue
    for (let y = pixelRect.top; y < pixelRect.bottom; y += 1) {
      for (let x = pixelRect.left; x < pixelRect.right; x += 1) {
        const offset = (y * image.width + x) * 4
        if (image.data[offset + 3] !== 255) continue
        red += image.data[offset] ?? 0
        green += image.data[offset + 1] ?? 0
        blue += image.data[offset + 2] ?? 0
        count += 1
      }
    }
  }
  if (count === 0) return undefined
  return [red / count / 255, green / count / 255, blue / count / 255]
}

/**
 * 按页面阅读顺序排列 OCR 区域；同一行内从左到右，坐标相同时保持引擎返回顺序。
 * @param regions OCR 区域列表。
 * @returns 已排序的区域副本。
 * @author zhenghq
 */
function orderedOcrRegions(regions: readonly DocumentOcrRegion[]): DocumentOcrRegion[] {
  return regions
    .map((region, index) => ({ region, index }))
    .sort((left, right) => {
      const topDifference = left.region.bbox.y - right.region.bbox.y
      if (Math.abs(topDifference) > 0.002) return topDifference
      const leftDifference = left.region.bbox.x - right.region.bbox.x
      return Math.abs(leftDifference) > 0.002 ? leftDifference : left.index - right.index
    })
    .map((entry) => entry.region)
}

/**
 * 计算 OCR 原识别框在图片内的横向边界，供透明原文文字层使用。
 * @param imageBox 图片原始边界。
 * @param region OCR 区域。
 * @returns 区域左边界、宽度和内容左边界。
 * @author zhenghq
 */
function ocrRegionSourceHorizontalBounds(
  imageBox: DocumentBoundingBox,
  region: DocumentOcrRegion
): { left: number; width: number; contentLeft: number } {
  const normalizedLeft = Math.max(0, Math.min(1, region.bbox.x))
  const normalizedRight = Math.max(
    normalizedLeft,
    Math.min(1, region.bbox.x + region.bbox.width)
  )
  const left = imageBox.x + normalizedLeft * imageBox.width
  const originalWidth = Math.max(1, (normalizedRight - normalizedLeft) * imageBox.width)
  // 透明原文层必须延续原文字层的可提取范围；左对齐长文本延伸到图片右边缘，
  // 避免因识别框过窄而拆成多个文本项，影响复制与检索。
  const width = region.textAlign === 'center' || region.textAlign === 'right'
    ? originalWidth
    : Math.max(1, imageBox.x + imageBox.width - left)
  return { left, width, contentLeft: left }
}

/**
 * 计算 OCR 译文在图片内的横向边界。
 * 左对齐译文可扩展到同行右侧区域之前，没有右侧邻居时延伸到图片右边缘；
 * 居中与右对齐译文保持原识别框宽度，确保对齐基准不漂移。
 * @param imageBox 图片原始边界。
 * @param region 当前 OCR 区域。
 * @param regions 图片内全部 OCR 区域。
 * @returns 译文左边界、宽度和内容左边界。
 * @author zhenghq
 */
function ocrRegionTranslationHorizontalBounds(
  imageBox: DocumentBoundingBox,
  region: DocumentOcrRegion,
  regions: readonly DocumentOcrRegion[]
): { left: number; width: number; contentLeft: number } {
  const bounds = resolveDocumentOcrTranslationHorizontalBounds(region, regions)
  const left = imageBox.x + bounds.x * imageBox.width
  const width = Math.max(1, bounds.width * imageBox.width)
  return { left, width, contentLeft: left }
}

/**
 * 计算 OCR 区域原始顶部坐标。
 * @param imageBox 图片原始边界。
 * @param region OCR 区域。
 * @returns 区域原始顶部坐标。
 * @author zhenghq
 */
function ocrRegionSourceTop(
  imageBox: DocumentBoundingBox,
  region: DocumentOcrRegion
): number {
  return imageBox.y + Math.max(0, Math.min(1, region.bbox.y)) * imageBox.height
}

/**
 * 将 OCR 原文以完全透明文字绘制到图片区域，形成可检索但不遮挡原图的文字层。
 * @param context 绘制上下文。
 * @param imageBox 图片原始边界。
 * @param region OCR 区域。
 * @returns 无返回值。
 * @author zhenghq
 */
function drawOcrTextRegion(
  context: DrawContext,
  imageBox: DocumentBoundingBox,
  region: DocumentOcrRegion
): void {
  const text = region.text?.trim()
  if (!text) return
  const { left: regionX, width: regionWidth } = ocrRegionSourceHorizontalBounds(imageBox, region)
  const padding = resolveOcrRegionPadding(imageBox.width, imageBox.height, region)
  const availableWidth = Math.max(1, regionWidth - padding.x * 2)
  const fontSize = resolveOcrRegionFontSize(region, imageBox.height)
  const font = selectFont(context, region.style)
  const lines = wrapText(text, font, fontSize, availableWidth)
  const lineHeight = resolveOcrRegionLineHeight(fontSize)
  const top = imageBox.y + Math.max(0, Math.min(1, region.bbox.y)) * imageBox.height
  let y = top
  for (const line of lines) {
    if (!line) {
      y += lineHeight
      continue
    }
    const lineWidth = Math.min(availableWidth, font.widthOfTextAtSize(line, fontSize))
    const lineX = alignedTextX(regionX + padding.x, availableWidth, lineWidth, region.textAlign)
    context.page.drawText(safeFontText(line, font), {
      x: lineX,
      y: pdfY(context.page.getHeight(), y + (lineHeight - fontSize) / 2, fontSize),
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
      opacity: 0
    })
    y += lineHeight
  }
}

/**
 * 绘制图片区块的透明 OCR 原文文字层，供双层 PDF 检索与复制。
 * @param context 绘制上下文。
 * @param block 图片区块。
 * @param page 页面模型。
 * @param imageBox 图片实际边界。
 * @returns 无返回值。
 * @author zhenghq
 */
function drawOcrTextLayer(
  context: DrawContext,
  block: DocumentImageBlock,
  page: DocumentPage,
  imageBox: DocumentBoundingBox
): void {
  for (const region of orderedOcrRegions(block.ocrRegions ?? [])) {
    if (!region.text?.trim()) continue
    drawOcrTextRegion(context, imageBox, region)
  }
}

/**
 * 递归收集页面中带 OCR 原文的图片区块，包含表格单元格内的嵌套图片。
 * @param blocks 待遍历区块。
 * @param output 收集结果。
 * @returns 带 OCR 原文的图片区块。
 * @author zhenghq
 */
function collectOcrImageBlocks(
  blocks: readonly DocumentBlock[],
  output: DocumentImageBlock[] = []
): DocumentImageBlock[] {
  for (const block of blocks) {
    if (block.kind === 'image') {
      if ((block.ocrRegions ?? []).some((region) => Boolean(region.text?.trim()))) output.push(block)
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) collectOcrImageBlocks(cell.blocks, output)
    }
  }
  return output
}

/**
 * 在保留的原始 PDF 页面上追加 OCR 透明文字层；不重绘、重排或新增原页面。
 * @param document 已加载的原始 PDF。
 * @param pageModel 当前页面模型。
 * @param context 绘制上下文。
 * @returns 无返回值。
 * @author zhenghq
 */
function appendSourcePdfOcrTextLayers(
  document: PDFDocument,
  pageModel: DocumentPage,
  context: DrawContext
): number {
  const sourcePage = document.getPage(pageModel.index)
  const rotation = sourcePage.getRotation().angle % 360
  if (rotation !== 0) {
    context.warnings.push({
      code: 'ocr-source-rotated-page',
      severity: 'warning',
      message: 'OCR text was skipped on a rotated source PDF page.',
      pageId: pageModel.pageId
    })
    return 0
  }
  let writtenTextCount = 0
  for (const block of collectOcrImageBlocks(pageModel.blocks)) {
    if (!block.bbox) {
      context.warnings.push({
        code: 'ocr-source-image-bbox-missing',
        severity: 'warning',
        message: 'OCR text was skipped because the source image has no reliable bounding box.',
        pageId: pageModel.pageId,
        blockId: block.blockId
      })
      continue
    }
    for (const region of orderedOcrRegions(block.ocrRegions ?? [])) {
      if (!region.text?.trim()) continue
      drawOcrTextRegion(context, block.bbox, region)
      writtenTextCount += 1
    }
  }
  return writtenTextCount
}

/**
 * 将 OCR 区域译文绘制到图片对应位置；译文按实际行数扩展并顺延后续区域，避免裁切与覆盖。
 * @param context 绘制上下文。
 * @param imageBox 图片原始边界。
 * @param region OCR 区域。
 * @param regionTop 当前 OCR 区域顶部坐标；前序译文增高后可能大于原始坐标。
 * @param regions 图片内全部 OCR 区域，用于限制左对齐译文的横向扩展范围。
 * @param composer 页面排版器；传入后可在页底续页。
 * @param document PDF 文档。
 * @returns 当前 OCR 区域实际占用后的底部坐标。
 * @author zhenghq
 */
function drawOcrRegion(
  context: DrawContext,
  imageBox: DocumentBoundingBox,
  region: DocumentOcrRegion,
  regionTop: number,
  regions: readonly DocumentOcrRegion[],
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const translated = region.translatedText?.trim()
  if (!translated || (region.status !== 'recognized' && region.status !== 'skipped')) return regionTop
  const { left: regionX, width: regionWidth } = ocrRegionTranslationHorizontalBounds(
    imageBox,
    region,
    regions
  )
  const padding = resolveOcrRegionPadding(imageBox.width, imageBox.height, region)
  const availableWidth = Math.max(1, regionWidth - padding.x * 2)
  // 未提供原文字号时使用共享可读默认值；整图回退区域的高度不能当作单行高度。
  const fontSize = resolveOcrRegionFontSize(region, imageBox.height)
  const font = selectFont(context, region.style)
  const lines = wrapText(translated, font, fontSize, availableWidth)
  const lineHeight = resolveOcrRegionLineHeight(fontSize)
  let y = regionTop
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line) continue
    if (composer && document && y + lineHeight > context.page.getHeight() - composer.contentBottom) {
      // OCR 译文可能远长于原区域；页底续页时保留原横向边界并继续绘制剩余行。
      ensurePageSpace(composer, document, context, lineHeight)
      y = composer.cursor
    }
    const lineWidth = Math.min(availableWidth, font.widthOfTextAtSize(line, fontSize))
    const lineX = alignedTextX(regionX + padding.x, availableWidth, lineWidth, region.textAlign)
    // 白底按当前译文行实际宽度绘制，不能继续沿用原文识别框而截断译文或漏出扫描原文。
    context.page.drawRectangle({
      x: lineX - padding.x,
      y: pdfY(context.page.getHeight(), y, lineHeight),
      width: Math.min(regionWidth, lineWidth + padding.x * 2),
      height: lineHeight,
      color: rgb(1, 1, 1),
      opacity: 0.94
    })
    context.page.drawText(line, {
      x: lineX,
      y: pdfY(context.page.getHeight(), y + (lineHeight - fontSize) / 2, fontSize),
      size: fontSize,
      font,
      color: parseColor(region.style?.color, [0.1, 0.12, 0.16])
    })
    y += lineHeight
    if (composer) composer.cursor = y
  }
  return y
}

/**
 * 按阅读顺序绘制图片内全部 OCR 译文。
 * 每个区域优先锚定原 OCR 顶部，只有与已绘制译文横向相交且会被覆盖时才向下避让。
 * @param context 绘制上下文。
 * @param block 图片区块。
 * @param page 页面模型。
 * @param composer 页面排版器；传入后可在页底续页。
 * @param document PDF 文档。
 * @returns 图片及其 OCR 译文实际占用后的底部坐标。
 * @author zhenghq
 */
function drawOcrRegions(
  context: DrawContext,
  block: DocumentImageBlock,
  page: DocumentPage,
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const imageBox = block.bbox ?? { x: 24, y: 24, width: page.width - 48, height: 240 }
  const regions = orderedOcrRegions(block.ocrRegions ?? [])
  const placedRegions: DocumentOcrFlowRect[] = []
  let bottom = imageBox.y
  for (const region of regions) {
    const translated = region.translatedText?.trim()
    if (!translated || (region.status !== 'recognized' && region.status !== 'skipped')) continue
    const sourceTop = ocrRegionSourceTop(imageBox, region)
    const horizontalBounds = ocrRegionTranslationHorizontalBounds(imageBox, region, regions)
    const regionTop = resolveDocumentOcrRegionFlowTop(
      sourceTop,
      {
        left: horizontalBounds.left,
        right: horizontalBounds.left + horizontalBounds.width
      },
      placedRegions
    )
    const regionBottom = drawOcrRegion(
      context,
      imageBox,
      region,
      regionTop,
      regions,
      composer,
      document
    )
    placedRegions.push({
      left: horizontalBounds.left,
      right: horizontalBounds.left + horizontalBounds.width,
      top: regionTop,
      bottom: regionBottom
    })
    bottom = Math.max(bottom, regionBottom)
  }
  return Math.max(imageBox.y + imageBox.height, bottom)
}

/**
 * 判断文本是否必须使用粗体字体。
 * @param style 文本样式。
 * @returns 是否粗体。
 * @author zhenghq
 */
function isBold(style: DocumentTextStyle | undefined): boolean {
  return (style?.fontWeight ?? 400) >= 600
}

/**
 * 根据文本样式选择最匹配的嵌入字体。
 * @param context 绘制上下文。
 * @param style 文本样式。
 * @returns 用于绘制文本的字体。
 * @author zhenghq
 */
function selectFont(context: DrawContext, style: DocumentTextStyle | undefined): PDFFont {
  const bold = isBold(style)
  if (bold && style?.italic) return context.boldItalic
  if (bold) return context.bold
  if (style?.italic) return context.italic
  return context.regular
}

/**
 * 根据对齐方式计算一行文本的实际左边界。
 * @param x 可用区域左边界。
 * @param width 可用区域宽度。
 * @param lineWidth 当前行文本宽度。
 * @param textAlign 对齐方式。
 * @returns 文本绘制左边界。
 * @author zhenghq
 */
function alignedTextX(
  x: number,
  width: number,
  lineWidth: number,
  textAlign: DocumentTextAlign | undefined
): number {
  if (textAlign === 'center') return x + Math.max(0, width - lineWidth) / 2
  if (textAlign === 'right') return x + Math.max(0, width - lineWidth)
  return x
}

/**
 * 计算文本片段在区块默认样式下使用的最终样式。
 * @param block 文本区块。
 * @param run 文本片段。
 * @returns 合并后的文本样式。
 * @author zhenghq
 */
function resolvedRunStyle(block: DocumentTextBlock, run: DocumentTextRun): DocumentTextStyle {
  const defaultSize = block.role === 'heading' ? 22 : block.role === 'subtitle' ? 16 : 12
  return { fontSize: defaultSize, ...block.style, ...run.style }
}

/**
 * 判断多个文本片段能否在同一行内完整绘制。
 * 只有单行且宽度总和不超过区块宽度时才允许连续排版，否则回退逐片段换行。
 * @param context 绘制上下文，用于选择已嵌入字体。
 * @param block 文本区块。
 * @param width 区块可用宽度。
 * @returns 是否可以按整行连续绘制。
 * @author zhenghq
 */
function canDrawRunsAsSingleLine(context: DrawContext, block: DocumentTextBlock, width: number): boolean {
  if (block.runs.length < 2 || block.textAlign === undefined) return false
  let totalWidth = 0
  for (const run of block.runs) {
    if (!run.text || run.text.includes('\n')) return false
    const style = resolvedRunStyle(block, run)
    const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 12))
    const font = selectFont(context, style)
    totalWidth += font.widthOfTextAtSize(safeFontText(run.text, font), fontSize)
  }
  return totalWidth <= Math.max(1, width)
}

/**
 * 绘制一个文本片段；保留字号、颜色、粗体和行高。
 * @param context 绘制上下文。
 * @param run 文本片段。
 * @param x 左边界。
 * @param top 顶部边界。
 * @param width 可用宽度。
 * @param fallbackStyle 区块级默认样式。
 * @param textAlign 文本对齐方式。
 * @param composer 页面排版器；传入后可在页底自动续页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @param yOffset 相对当前页内容区顶部的偏移；续页后继续使用该偏移。
 * @returns 消耗的高度。
 * @author zhenghq
 */
function drawTextRun(
  context: DrawContext,
  run: DocumentTextRun,
  x: number,
  top: number,
  width: number,
  fallbackStyle: DocumentTextStyle | undefined,
  textAlign?: DocumentTextAlign,
  composer?: PageComposer,
  document?: PDFDocument,
  yOffset?: number
): number {
  const style = { ...fallbackStyle, ...run.style }
  const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 12))
  const lineHeight = Math.max(fontSize, style.lineHeight ?? fontSize * 1.35)
  const font = selectFont(context, style)
  const lines = wrapText(run.text, font, fontSize, Math.max(1, width))
  let y = top
  let drawnHeight = 0
  let firstLineX = x
  let firstLineTop = top
  let firstLinePageHeight = context.page.getHeight()
  let firstLinePage = context.page
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    if (composer && document && y + lineHeight > context.page.getHeight() - composer.contentBottom) {
      // 单个长文本块可能超过整页；续页时从内容区顶部继续绘制剩余行。
      ensurePageSpace(composer, document, context, lineHeight)
      y = composer.cursor
      if (lineIndex === 0) {
        firstLineTop = y
        firstLinePageHeight = context.page.getHeight()
        firstLinePage = context.page
      }
    }
    const lineWidth = Math.min(width, font.widthOfTextAtSize(line, fontSize))
    const lineX = alignedTextX(x, width, lineWidth, textAlign)
    if (lineIndex === 0) {
      firstLineX = lineX
    }
    context.page.drawText(line, {
      x: lineX,
      y: pdfY(context.page.getHeight(), y, fontSize),
      size: fontSize,
      font,
      color: parseColor(style.color)
    })
    y += lineHeight
    drawnHeight += lineHeight
    if (composer) composer.cursor = y
  }
  if (style.underline) {
    const firstLineWidth = Math.min(width, font.widthOfTextAtSize(lines[0] ?? '', fontSize))
    firstLinePage.drawLine({
      start: { x: firstLineX, y: pdfY(firstLinePageHeight, firstLineTop + fontSize + 1, 0) },
      end: { x: firstLineX + firstLineWidth, y: pdfY(firstLinePageHeight, firstLineTop + fontSize + 1, 0) },
      thickness: 0.6,
      color: parseColor(style.color)
    })
  }
  return drawnHeight
}

/**
 * 在同一行内连续绘制多个文本片段，保留每个片段的字体、字号、颜色和下划线。
 * 对齐以整行总宽度为基准，避免各片段分别居中后相互覆盖或中心漂移。
 * @param context 绘制上下文。
 * @param block 文本区块。
 * @param x 区块左边界。
 * @param top 区块顶部边界。
 * @param width 区块可用宽度。
 * @param composer 页面排版器；传入后可在页底自动续页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @returns 本行消耗的高度。
 * @author zhenghq
 */
function drawTextRunsInLine(
  context: DrawContext,
  block: DocumentTextBlock,
  x: number,
  top: number,
  width: number,
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const runs = block.runs.map((run) => {
    const style = resolvedRunStyle(block, run)
    const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 12))
    const font = selectFont(context, style)
    return { run, style, fontSize, font, text: safeFontText(run.text, font) }
  })
  const totalWidth = runs.reduce((sum, item) => sum + item.font.widthOfTextAtSize(item.text, item.fontSize), 0)
  const lineHeight = Math.max(...runs.map((item) => Math.max(item.fontSize, item.style.lineHeight ?? item.fontSize * 1.35)))
  let lineTop = top
  if (composer && document) {
    ensurePageSpace(composer, document, context, lineHeight)
    lineTop = composer.cursor
  }
  let currentX = alignedTextX(x, width, totalWidth, block.textAlign)
  for (const item of runs) {
    const textWidth = item.font.widthOfTextAtSize(item.text, item.fontSize)
    context.page.drawText(item.text, {
      x: currentX,
      y: pdfY(context.page.getHeight(), lineTop, item.fontSize),
      size: item.fontSize,
      font: item.font,
      color: parseColor(item.style.color)
    })
    if (item.style.underline) {
      context.page.drawLine({
        start: { x: currentX, y: pdfY(context.page.getHeight(), lineTop + item.fontSize + 1, 0) },
        end: { x: currentX + textWidth, y: pdfY(context.page.getHeight(), lineTop + item.fontSize + 1, 0) },
        thickness: 0.6,
        color: parseColor(item.style.color)
      })
    }
    currentX += textWidth
  }
  if (composer) composer.cursor = lineTop + lineHeight
  return lineHeight
}

/**
 * 计算表格单元格中文本片段合并后的样式；表格沿用 10pt 作为缺省字号。
 * @param block 单元格内的文本区块。
 * @param run 文本片段。
 * @returns 合并后的最终样式。
 * @author zhenghq
 */
function tableCellRunStyle(block: DocumentTextBlock, run: DocumentTextRun): DocumentTextStyle {
  return { fontSize: 10, ...block.style, ...run.style }
}

/**
 * 将单元格内容拆成可独立纵向排版的组；几何重叠或显式标记的图片合并为一组，
 * 相邻且具有相同原始 Y 坐标的文本子块也合并为视觉行。其余区块保持原始顺序并作为屏障。
 * @param blocks 单元格内的子块。
 * @returns 保持原始内容顺序的视觉行组。
 * @author zhenghq
 */
function groupTableCellBlocks(blocks: readonly DocumentBlock[]): DocumentBlock[][] {
  const stackByBlock = new Map<DocumentImageBlock, readonly DocumentImageBlock[]>()
  const textByStack = new Map<readonly DocumentImageBlock[], readonly DocumentTextBlock[]>()
  const stackedTexts = new Set<DocumentTextBlock>()
  for (const stack of resolveDocumentImageStackGroups(blocks)) {
    for (const block of stack.blocks) stackByBlock.set(block, stack.blocks)
    const texts = resolveDocumentImageStackContainedTexts(blocks, stack.blocks)
      .filter((text) => !stackedTexts.has(text))
    textByStack.set(stack.blocks, texts)
    for (const text of texts) stackedTexts.add(text)
  }
  const renderedStacks = new Set<readonly DocumentImageBlock[]>()
  const groups: Array<{ top: number; blocks: DocumentBlock[] }> = []
  for (const block of blocks) {
    if (block.kind === 'text' && stackedTexts.has(block)) continue
    const stack = block.kind === 'image' ? stackByBlock.get(block) : undefined
    if (stack) {
      if (renderedStacks.has(stack)) continue
      renderedStacks.add(stack)
      groups.push({ top: Number.NaN, blocks: [...stack, ...textByStack.get(stack) ?? []] })
      continue
    }
    const sourceTop = block.kind === 'text' && block.bbox ? block.bbox.y : undefined
    const previous = groups[groups.length - 1]
    // 只合并紧邻的同排文本；图片、无坐标文本及其后的内容必须保留原始顺序。
    if (sourceTop !== undefined && previous && Number.isFinite(previous.top) &&
      Math.abs(previous.top - sourceTop) <= 1) {
      previous.blocks.push(block)
    } else {
      groups.push({ top: sourceTop ?? Number.NaN, blocks: [block] })
    }
  }
  return groups.map((group) => group.blocks)
}

/**
 * 识别表格单元格中的图片叠放组，并拆出底图成员与图内原生文本。
 * @param group 已按原始顺序组合的单元格区块组。
 * @returns 至少包含两张图片的叠放内容；普通文本行单独处理时返回 undefined。
 * @author zhenghq
 */
function resolveTableCellImageStackContents(
  group: readonly DocumentBlock[]
): { images: DocumentImageBlock[]; texts: DocumentTextBlock[] } | undefined {
  const images = group.filter((block): block is DocumentImageBlock => block.kind === 'image')
  const texts = group.filter((block): block is DocumentTextBlock => block.kind === 'text')
  if (images.length < 2 || images.length + texts.length !== group.length) return undefined
  return { images, texts }
}

/**
 * 计算普通正文片段合并后的样式；正文沿用区块角色对应的默认字号。
 * @param block 文本区块。
 * @param run 文本片段。
 * @returns 合并后的最终样式。
 * @author zhenghq
 */
function flowTextRunStyle(block: DocumentTextBlock, run: DocumentTextRun): DocumentTextStyle {
  const defaultSize = block.role === 'heading' ? 22 : block.role === 'subtitle' ? 16 : 12
  return { fontSize: defaultSize, ...block.style, ...run.style }
}

/**
 * 将文本区块中的连续片段排版为视觉行。
 * 同一区块的片段共享文本流；显式换行、宽度不足时才产生新行，每个片段仍保留原样式。
 * @param context 绘制上下文，用于选择嵌入字体。
 * @param block 文本区块。
 * @param width 可用宽度。
 * @param resolveStyle 计算片段最终样式的函数。
 * @returns 按绘制顺序排列的视觉行。
 * @author zhenghq
 */
function layoutFlowTextLines(
  context: DrawContext,
  block: DocumentTextBlock,
  width: number,
  resolveStyle: (block: DocumentTextBlock, run: DocumentTextRun) => DocumentTextStyle
): FlowTextLine[] {
  const lines: FlowTextLine[] = []
  const availableWidth = Math.max(1, width)
  let current: FlowTextLine = {
    fragments: [],
    width: 0,
    height: 0,
    maxFontSize: 0
  }

  /** 结束当前视觉行；空行不写入，避免空 run 占用正文高度。 */
  const flushLine = (): void => {
    if (current.fragments.length > 0) lines.push(current)
    current = { fragments: [], width: 0, height: 0, maxFontSize: 0 }
  }

  /** 向当前行追加文本，并尽量合并同一 run 的连续片段。 */
  const appendText = (
    run: DocumentTextRun,
    style: DocumentTextStyle,
    font: PDFFont,
    fontSize: number,
    lineHeight: number,
    text: string
  ): void => {
    if (!text) return
    const textWidth = font.widthOfTextAtSize(text, fontSize)
    const last = current.fragments[current.fragments.length - 1]
    if (last && last.run === run) {
      last.text += text
      last.width += textWidth
    } else {
      current.fragments.push({ run, style, font, fontSize, lineHeight, text, width: textWidth })
    }
    current.width += textWidth
    current.height = Math.max(current.height, lineHeight)
    current.maxFontSize = Math.max(current.maxFontSize, fontSize)
  }

  for (const run of block.runs) {
    if (!run.text) continue
    const style = resolveStyle(block, run)
    const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 12))
    const lineHeight = Math.max(fontSize, style.lineHeight ?? fontSize * 1.35)
    const font = selectFont(context, style)
    const paragraphs = run.text.split('\n')
    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
      if (paragraphIndex > 0) flushLine()
      const paragraph = safeFontText(paragraphs[paragraphIndex]!, font)
      const tokens = paragraph.match(/[\p{Script=Latin}\p{N}_'’-]+|\s+|./gu) ?? []
      for (const originalToken of tokens) {
        if (!originalToken) continue
        if (!originalToken.trim()) {
          if (current.fragments.length > 0 &&
              font.widthOfTextAtSize(originalToken, fontSize) + current.width <= availableWidth) {
            appendText(run, style, font, fontSize, lineHeight, originalToken)
          }
          continue
        }
        let token = originalToken
        if (current.fragments.length > 0 &&
            current.width + font.widthOfTextAtSize(token, fontSize) > availableWidth) {
          flushLine()
          token = token.trimStart()
        }
        if (!token) continue
        if (current.fragments.length === 0 && font.widthOfTextAtSize(token, fontSize) > availableWidth) {
          for (const char of token) {
            if (current.fragments.length > 0 &&
                current.width + font.widthOfTextAtSize(char, fontSize) > availableWidth) {
              flushLine()
            }
            appendText(run, style, font, fontSize, lineHeight, char)
          }
          continue
        }
        appendText(run, style, font, fontSize, lineHeight, token)
      }
    }
  }
  flushLine()
  return lines
}

/**
 * 绘制文本流中的视觉行；每行独立换行并保持整行对齐、片段样式和统一基线。
 * @param context 绘制上下文。
 * @param block 文本区块。
 * @param lines 已排版的视觉行。
 * @param x 可用区域左边界。
 * @param top 首行顶部坐标。
 * @param width 可用区域宽度。
 * @param composer 页面排版器；传入后可在页底按视觉行续页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @returns 实际绘制消耗的总高度。
 * @author zhenghq
 */
function drawFlowTextLines(
  context: DrawContext,
  block: DocumentTextBlock,
  lines: readonly FlowTextLine[],
  x: number,
  top: number,
  width: number,
  composer?: PageComposer,
  document?: PDFDocument
): number {
  let lineTop = top
  let drawnHeight = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    const lineHeight = Math.max(1, line.height)
    // PDF 原生区块的首行如果仍完整位于物理页面内，应保留原始页脚坐标；
    // 编辑安全区只约束后续正文，不能把页脚日期强制推到下一页。
    const nativeFirstLineFitsPage = lineIndex === 0 &&
      block.bbox !== undefined &&
      (Math.abs(lineTop - block.bbox.y) < 0.01 || composer?.flowContinuationActive === true) &&
      block.bbox.y + lineHeight <= context.page.getHeight() &&
      lineTop + lineHeight <= context.page.getHeight()
    if (composer && document &&
      !nativeFirstLineFitsPage &&
      lineTop + lineHeight > context.page.getHeight() - composer.contentBottom) {
      ensurePageSpace(composer, document, context, lineHeight)
      lineTop = composer.cursor
    }
    let currentX = alignedTextX(x, width, line.width, block.textAlign)
    // 同一视觉行统一使用最大字号计算基线，混合字号片段才能保持底部对齐。
    const baselineY = pdfY(context.page.getHeight(), lineTop, line.maxFontSize)
    for (const fragment of line.fragments) {
      context.page.drawText(fragment.text, {
        x: currentX,
        y: baselineY,
        size: fragment.fontSize,
        font: fragment.font,
        color: parseColor(fragment.style.color)
      })
      if (fragment.style.underline) {
        context.page.drawLine({
          start: { x: currentX, y: baselineY - 1 },
          end: { x: currentX + fragment.width, y: baselineY - 1 },
          thickness: 0.6,
          color: parseColor(fragment.style.color)
        })
      }
      currentX += fragment.width
    }
    lineTop += lineHeight
    drawnHeight += lineHeight
    if (composer) composer.cursor = lineTop
  }
  return drawnHeight
}

/**
 * 将表格单元格内的连续文本片段排版为视觉行。
 * 同一文本区块中的片段共享文本流，只有显式换行或宽度不足时才产生新行；
 * 每个片段仍保留自己的字体、字号、颜色和下划线。
 * @param context 绘制上下文，用于选择嵌入字体。
 * @param block 单元格内的文本区块。
 * @param width 单元格内容可用宽度。
 * @returns 按绘制顺序排列的视觉行。
 * @author zhenghq
 */
function layoutTableCellTextLines(
  context: DrawContext,
  block: DocumentTextBlock,
  width: number
): FlowTextLine[] {
  return layoutFlowTextLines(context, block, width, tableCellRunStyle)
}

/**
 * 绘制表格单元格文本区块，并让同一视觉行内的片段共享基线和整行对齐边界。
 * @param context 绘制上下文。
 * @param block 单元格内的文本区块。
 * @param x 单元格内容区左边界。
 * @param top 单元格内容区顶部坐标。
 * @param width 单元格内容区宽度。
 * @returns 文本区块实际占用的高度。
 * @author zhenghq
 */
function drawTableCellTextBlock(
  context: DrawContext,
  block: DocumentTextBlock,
  x: number,
  top: number,
  width: number
): number {
  const lines = layoutTableCellTextLines(context, block, width)
  return drawFlowTextLines(context, block, lines, x, top, width)
}

/**
 * 绘制 PDF 目录项；标题自然换行，页码固定在可用区域右侧，引导线只画最后一行。
 * @param context 绘制上下文。
 * @param block 目录文本区块。
 * @param x 目录项左边界。
 * @param top 目录项顶部边界。
 * @param width 目录项可用宽度。
 * @param composer 页面排版器；传入后可在页底续页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @returns 目录项实际消耗的底部坐标。
 * @author zhenghq
 */
function drawTableOfContentsBlock(
  context: DrawContext,
  block: DocumentTextBlock,
  x: number,
  top: number,
  width: number,
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const titleRun = block.runs.find((run) => run.protected !== true)
  const style = resolvedRunStyle(block, titleRun ?? { runId: `${block.blockId}-toc-title`, text: '' })
  const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 12))
  const lineHeight = Math.max(fontSize, style.lineHeight ?? fontSize * 1.35)
  const font = selectFont(context, style)
  const pageNumber = block.toc?.pageNumber ?? ''
  const pageNumberWidth = font.widthOfTextAtSize(safeFontText(pageNumber, font), fontSize)
  // 页码与标题之间保留一个稳定间距；标题只使用剩余宽度，避免页码被换到独立一行。
  const pageGap = Math.max(4, fontSize * 0.35)
  const titleWidth = Math.max(1, width - pageNumberWidth - pageGap)
  const title = block.runs
    .filter((run) => run.protected !== true)
    .map((run) => run.text)
    .join('')
  const lines = wrapText(title, font, fontSize, titleWidth)
  let lineTop = top
  if (composer && document) {
    ensurePageSpace(composer, document, context, lineHeight)
    lineTop = composer.cursor
  }
  let drawnBottom = lineTop
  for (const line of lines) {
    if (composer && document && lineTop + lineHeight > context.page.getHeight() - composer.contentBottom) {
      ensurePageSpace(composer, document, context, lineHeight)
      lineTop = composer.cursor
    }
    context.page.drawText(safeFontText(line, font), {
      x,
      y: pdfY(context.page.getHeight(), lineTop, fontSize),
      size: fontSize,
      font,
      color: parseColor(style.color)
    })
    drawnBottom = lineTop + lineHeight
    lineTop += lineHeight
    if (composer) composer.cursor = drawnBottom
  }
  const lastLineTop = Math.max(top, lineTop - lineHeight)
  if (pageNumber) {
    const pageNumberX = x + width - pageNumberWidth
    context.page.drawText(safeFontText(pageNumber, font), {
      x: pageNumberX,
      y: pdfY(context.page.getHeight(), lastLineTop, fontSize),
      size: fontSize,
      font,
      color: parseColor(style.color)
    })
    // 引导点使用最后一行标题末端到页码左侧的矢量点线，不进入 PDF 文本层。
    const lastLine = lines[lines.length - 1] ?? ''
    const lastLineWidth = Math.min(titleWidth, font.widthOfTextAtSize(safeFontText(lastLine, font), fontSize))
    const leaderStart = Math.min(pageNumberX, x + lastLineWidth + pageGap)
    const leaderY = pdfY(context.page.getHeight(), lastLineTop + fontSize * 0.82, 0)
    if (leaderStart < pageNumberX) {
      context.page.drawLine({
        start: { x: leaderStart, y: leaderY },
        end: { x: pageNumberX, y: leaderY },
        thickness: 0.65,
        color: parseColor(style.color),
        dashArray: [1.2, 2.4]
      })
    }
  }
  if (composer) composer.cursor = drawnBottom
  return drawnBottom
}

/**
 * 估算表格单元格内容的实际排版高度，用于让表格行随译文和图片增长。
 * @param context 绘制上下文，用于选择字体并测量文本宽度。
 * @param cell 表格单元格。
 * @param cellWidth 单元格宽度。
 * @param dependencies 导出依赖，用于读取单元格内图片尺寸。
 * @returns 单元格内容所需高度。
 * @author zhenghq
 */
async function tableCellContentHeight(
  context: DrawContext,
  cell: DocumentTableCell,
  cellWidth: number,
  dependencies: DocumentPdfExportDependencies
): Promise<number> {
  let height = 0
  const availableWidth = Math.max(1, cellWidth - 10)
  for (const group of groupTableCellBlocks(cell.blocks)) {
    const stack = resolveTableCellImageStackContents(group)
    if (stack) {
      height += tableCellImageStackHeight(stack.images, availableWidth)
      continue
    }
    let groupHeight = 0
    for (const child of group) {
      if (child.kind === 'text') {
        // 同一视觉行内的多个文本区块并排绘制，高度只能取最大值。
        const textHeight = layoutTableCellTextLines(context, child, availableWidth)
          .reduce((sum, line) => sum + line.height, 0)
        groupHeight = Math.max(groupHeight, textHeight)
      } else if (child.kind === 'image') {
        const image = await loadImage(context, child.assetId, dependencies)
        groupHeight = Math.max(groupHeight, tableCellImageHeight(child, image, availableWidth))
      }
    }
    height += groupHeight
  }
  return height
}

/**
 * 计算表格单元格图片叠放组在列宽缩放后的普通流高度。
 * @param blocks 同一叠放组内的图片区块。
 * @param availableWidth 单元格内容可用宽度。
 * @returns 按组并集宽高比换算后的高度；缺少边界时使用单图高度兜底。
 * @author zhenghq
 */
function tableCellImageStackHeight(blocks: readonly DocumentImageBlock[], availableWidth: number): number {
  const bounds = resolveDocumentImageStackBounds(blocks)
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    return Math.max(1, availableWidth * bounds.height / bounds.width)
  }
  return Math.max(1, ...blocks.map((block) => block.bbox?.height ?? availableWidth))
}

/**
 * 计算表格图片在单元格可用宽度内等比缩放后的高度。
 * @param block 图片区块，资源缺失时使用原始 bbox 宽高比兜底。
 * @param image 已加载的 PDF 图片；缺失时为 null。
 * @param availableWidth 单元格内可用宽度。
 * @returns 图片绘制高度。
 * @author zhenghq
 */
function tableCellImageHeight(
  block: DocumentImageBlock,
  image: PDFImage | null,
  availableWidth: number
): number {
  const width = Math.max(1, availableWidth)
  const sourceWidth = image?.width ?? block.bbox?.width ?? width
  const sourceHeight = image?.height ?? block.bbox?.height ?? width
  return sourceWidth > 0 && sourceHeight > 0
    ? Math.max(1, width * sourceHeight / sourceWidth)
    : Math.max(1, block.bbox?.height ?? width)
}

/**
 * 在表格单元格内绘制图片，强制限制在内容区内且不改变原始宽高比。
 * @param context 绘制上下文。
 * @param block 图片区块。
 * @param page 页面模型，用于记录资源缺失告警。
 * @param x 单元格内容区左边界。
 * @param top 图片顶部坐标。
 * @param width 单元格内容区宽度。
 * @param dependencies 导出依赖。
 * @returns 图片实际占用高度。
 * @author zhenghq
 */
async function drawTableCellImage(
  context: DrawContext,
  block: DocumentImageBlock,
  page: DocumentPage,
  x: number,
  top: number,
  width: number,
  dependencies: DocumentPdfExportDependencies,
  includeOcrTextLayer = false
): Promise<number> {
  const drawWidth = Math.max(1, width)
  const image = await loadImage(context, block.assetId, dependencies)
  const drawHeight = tableCellImageHeight(block, image, drawWidth)
  if (image) {
    const imageBox = {
      x,
      y: top,
      width: drawWidth,
      height: drawHeight
    }
    context.page.drawImage(image, {
      x,
      y: pdfY(context.page.getHeight(), top, drawHeight),
      width: drawWidth,
      height: drawHeight
    })
    if (includeOcrTextLayer) {
      drawOcrTextLayer(context, block, page, imageBox)
    }
  } else {
    context.warnings.push({
      code: 'image-asset-unavailable',
      severity: 'warning',
      message: 'A table image asset could not be embedded and was replaced with a placeholder.',
      pageId: page.pageId,
      blockId: block.blockId
    })
    context.page.drawRectangle({
      x,
      y: pdfY(context.page.getHeight(), top, drawHeight),
      width: drawWidth,
      height: drawHeight,
      borderColor: rgb(0.75, 0.78, 0.82),
      borderWidth: 0.8
    })
  }
  return drawHeight
}

/**
 * 在表格单元格内按叠放组并集坐标缩放并绘制多张图片。
 * 所有成员共享一次纵向排版高度，先按原始叠放顺序铺底图，再统一绘制 OCR 文字层。
 * @param context 绘制上下文。
 * @param blocks 同一叠放组内的图片区块。
 * @param texts 完全位于叠放组并集内的原生文本区块。
 * @param page 页面模型，用于记录资源缺失告警。
 * @param x 单元格内容区左边界。
 * @param top 叠放组顶部坐标。
 * @param width 单元格内容区宽度。
 * @param dependencies 导出依赖。
 * @param includeOcrTextLayer 是否写入透明 OCR 原文文字层。
 * @returns 叠放组实际占用高度。
 * @author zhenghq
 */
async function drawTableCellImageStack(
  context: DrawContext,
  blocks: readonly DocumentImageBlock[],
  texts: readonly DocumentTextBlock[],
  page: DocumentPage,
  x: number,
  top: number,
  width: number,
  dependencies: DocumentPdfExportDependencies,
  includeOcrTextLayer = false
): Promise<number> {
  const bounds = resolveDocumentImageStackBounds(blocks)
  if (!bounds) {
    let bottom = top
    for (const block of blocks) {
      bottom += await drawTableCellImage(
        context,
        block,
        page,
        x,
        bottom,
        width,
        dependencies,
        includeOcrTextLayer
      )
    }
    return bottom - top
  }
  const scale = width / bounds.width
  const stackHeight = Math.max(1, bounds.height * scale)
  const members: Array<{
    block: DocumentImageBlock
    imageBox: DocumentBoundingBox
  }> = []
  for (const block of blocks) {
    const bbox = block.bbox ?? bounds
    const memberBox = {
      x: x + (bbox.x - bounds.x) * scale,
      y: top + (bbox.y - bounds.y) * scale,
      width: Math.max(1, bbox.width * scale),
      height: Math.max(1, bbox.height * scale)
    }
    const image = await loadImage(context, block.assetId, dependencies)
    if (!image) {
      context.warnings.push({
        code: 'image-asset-unavailable',
        severity: 'warning',
        message: 'A table image asset could not be embedded and was replaced with a placeholder.',
        pageId: page.pageId,
        blockId: block.blockId
      })
      context.page.drawRectangle({
        x: memberBox.x,
        y: pdfY(context.page.getHeight(), memberBox.y, memberBox.height),
        width: memberBox.width,
        height: memberBox.height,
        borderColor: rgb(0.75, 0.78, 0.82),
        borderWidth: 0.8
      })
      continue
    }
    const imageBox = fitImageWithinBox(image, memberBox)
    members.push({ block, imageBox })
    context.page.drawImage(image, {
      x: imageBox.x,
      y: pdfY(context.page.getHeight(), imageBox.y, imageBox.height),
      width: imageBox.width,
      height: imageBox.height
    })
    if (includeOcrTextLayer) drawOcrTextLayer(context, block, page, memberBox)
  }
  for (const text of texts) {
    if (!text.bbox) continue
    const textBox = {
      x: x + (text.bbox.x - bounds.x) * scale,
      y: top + (text.bbox.y - bounds.y) * scale,
      width: Math.max(1, text.bbox.width * scale),
      height: Math.max(1, text.bbox.height * scale)
    }
    let maskColor: readonly [number, number, number] | undefined
    // 按原始叠放顺序从顶到底寻找首个可在文字 bbox 外侧采样的图片。
    for (let index = members.length - 1; index >= 0; index -= 1) {
      const member = members[index]!
      const maskImage = await loadMaskImage(context, member.block.assetId, dependencies)
      if (!maskImage) continue
      maskColor = samplePdfImageTextMaskColor(maskImage, textBox, member.imageBox)
      if (maskColor) break
    }
    const padding = Math.max(1, textBox.height * 0.15)
    const resolvedMaskColor = maskColor ?? [1, 1, 1] as const
    // 图片像素通常已烘焙原文；必须在译文前用局部背景色覆盖，否则导出 PDF 会重影。
    context.page.drawRectangle({
      x: textBox.x - padding,
      y: pdfY(context.page.getHeight(), textBox.y - padding, textBox.height + padding * 2),
      width: textBox.width + padding * 2,
      height: textBox.height + padding * 2,
      color: rgb(...resolvedMaskColor)
    })
    // 图内文本只覆盖在图片上方，不推进普通流，否则会把单元格后续内容再次向下推。
    drawTableCellTextBlock(context, text, textBox.x, textBox.y, textBox.width)
  }
  return stackHeight
}

/**
 * 按 contain 语义把图片等比放入目标边界。
 * @param image 已加载的 PDF 图片。
 * @param box 目标边界。
 * @returns 居中后的图片绘制边界。
 * @author zhenghq
 */
function fitImageWithinBox(
  image: PDFImage,
  box: DocumentBoundingBox
): DocumentBoundingBox {
  const sourceRatio = image.width / image.height
  const boxRatio = box.width / box.height
  const width = sourceRatio > boxRatio ? box.width : box.height * sourceRatio
  const height = sourceRatio > boxRatio ? box.width / sourceRatio : box.height
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height
  }
}

/**
 * 将表格列宽按表格边界归一化，确保异常列宽不会把后续列推出页面。
 * @param columnWidths 原始列宽；缺失或非正数时按等分处理。
 * @param columnCount 实际列数。
 * @param tableWidth 表格可用总宽度。
 * @returns 与列数一致、总和等于表格宽度的安全列宽。
 * @author zhenghq
 */
function normalizeTableColumnWidths(
  columnWidths: readonly number[] | undefined,
  columnCount: number,
  tableWidth: number
): number[] {
  const count = Math.max(1, columnCount)
  const width = Math.max(1, tableWidth)
  const validWidths = columnWidths?.length === count
    ? columnWidths.map((value) => Number.isFinite(value) && value > 0 ? value : 0)
    : []
  const total = validWidths.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return Array.from({ length: count }, () => width / count)
  return validWidths.map((value) => value / total * width)
}

/**
 * 计算单元格中单行文本的自然宽度，供译文表格列宽按内容扩展。
 * @param context 绘制上下文。
 * @param cell 表格单元格。
 * @returns 单元格内容最长一行的文本宽度。
 * @author zhenghq
 */
function tableCellNaturalWidth(context: DrawContext, cell: DocumentTableCell): number {
  let width = 0
  for (const child of cell.blocks) {
    if (child.kind !== 'text') continue
    let paragraphWidth = 0
    for (const run of child.runs) {
      const style = tableCellRunStyle(child, run)
      const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 10))
      const font = selectFont(context, style)
      safeFontText(run.text, font).split('\n').forEach((line, lineIndex) => {
        if (lineIndex > 0) {
          width = Math.max(width, paragraphWidth)
          paragraphWidth = 0
        }
        paragraphWidth += font.widthOfTextAtSize(line, fontSize)
      })
    }
    width = Math.max(width, paragraphWidth)
  }
  return width
}

/**
 * 计算表格真实列数；同时参考原始列宽和每行跨列总数。
 * @param block 表格区块。
 * @returns 至少为一的物理列数。
 * @author zhenghq
 */
function tableColumnCount(block: DocumentTableBlock): number {
  const rowColumnCounts = block.rows.map((row) =>
    row.cells.reduce((sum, cell) => sum + Math.max(1, cell.colSpan), 0))
  return Math.max(1, block.columnWidths?.length ?? 0, ...rowColumnCounts)
}

/**
 * 按 HTML 表格语义把单元格放入行列占用矩阵，跳过前序跨行单元格占用的位置。
 * @param rows 待排版的表格行。
 * @param columnCount 物理列数。
 * @returns 每个单元格对应的真实行列位置与实际跨距。
 * @author zhenghq
 */
function layoutTableCells(
  rows: readonly DocumentTableBlock['rows'][number][],
  columnCount: number
): TableCellPlacement[] {
  const count = Math.max(1, columnCount)
  const occupied = Array.from({ length: rows.length }, () =>
    Array.from({ length: count }, () => false))
  const placements: TableCellPlacement[] = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    let columnIndex = 0
    for (const cell of rows[rowIndex]!.cells) {
      while (columnIndex < count && occupied[rowIndex]![columnIndex]) columnIndex += 1
      if (columnIndex >= count) break
      const colSpan = Math.max(1, Math.min(cell.colSpan, count - columnIndex))
      const rowSpan = Math.max(1, Math.min(cell.rowSpan, rows.length - rowIndex))
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < colSpan; columnOffset += 1) {
          occupied[rowIndex + rowOffset]![columnIndex + columnOffset] = true
        }
      }
      placements.push({ cell, rowIndex, columnIndex, rowSpan, colSpan })
      columnIndex += colSpan
    }
  }
  return placements
}

/**
 * 计算单元格跨越的实际宽度。
 * @param widths 各物理列宽度。
 * @param placement 单元格排版位置。
 * @returns 单元格总宽度。
 * @author zhenghq
 */
function tableCellPlacementWidth(
  widths: readonly number[],
  placement: TableCellPlacement
): number {
  return widths
    .slice(placement.columnIndex, placement.columnIndex + placement.colSpan)
    .reduce((sum, value) => sum + value, 0)
}

/**
 * 计算表格各行高度，并保证跨行单元格的覆盖高度足以容纳其内容。
 * @param context 绘制上下文。
 * @param placements 已定位的单元格。
 * @param rowCount 表格行数。
 * @param widths 各物理列宽度。
 * @param dependencies 导出依赖。
 * @returns 每个物理行最终使用的高度。
 * @author zhenghq
 */
async function tableRowHeights(
  context: DrawContext,
  block: DocumentTableBlock,
  placements: readonly TableCellPlacement[],
  rowCount: number,
  widths: readonly number[],
  dependencies: DocumentPdfExportDependencies
): Promise<number[]> {
  const sourceRowBands = sourceTableRowBands(block)
  // PDF 原生表格保留原始单元格坐标形成的行带；无坐标的 DOCX/Markdown 表格按内容自适应。
  // 不能把整表 bbox 平均分摊给所有行，否则空行会获得虚假高度并挤走后续正文。
  const heights = Array.from({ length: rowCount }, (_, rowIndex) =>
    sourceRowBands[rowIndex]?.height ?? 1)
  const requiredHeights = new Map<TableCellPlacement, number>()
  for (const placement of placements) {
    requiredHeights.set(
      placement,
      await tableCellContentHeight(
        context,
        placement.cell,
        tableCellPlacementWidth(widths, placement),
        dependencies
      ) + 10
    )
  }
  // 单行单元格先扩展自身行；跨行单元格再补齐覆盖区间，避免行高反复振荡。
  for (const placement of placements.filter((candidate) => candidate.rowSpan === 1)) {
    heights[placement.rowIndex] = Math.max(
      heights[placement.rowIndex]!,
      requiredHeights.get(placement) ?? 0
    )
  }
  for (const placement of placements
    .filter((candidate) => candidate.rowSpan > 1)
    .sort((left, right) => left.rowIndex - right.rowIndex || left.rowSpan - right.rowSpan)) {
    const endRow = placement.rowIndex + placement.rowSpan
    const coveredHeight = heights
      .slice(placement.rowIndex, endRow)
      .reduce((sum, value) => sum + value, 0)
    const missing = (requiredHeights.get(placement) ?? 0) - coveredHeight
    if (missing > 0) heights[endRow - 1] = heights[endRow - 1]! + missing
  }
  return heights
}

/**
 * 根据单元格内文本的原始 Y 坐标推导表格行带；连续多行文本归入同一条视觉行。
 * @param block 表格区块。
 * @returns 每个表格行对应的原始顶部与高度；无可用坐标时返回空数组。
 * @author zhenghq
 */
function sourceTableRowBands(block: DocumentTableBlock): Array<{ top: number; height: number }> {
  if (!block.bbox) return []
  const rowTops = block.rows.map((row) => {
    const tops: number[] = []
    for (const cell of row.cells) {
      for (const child of cell.blocks) {
        if (child.kind !== 'text' || !child.bbox) continue
        tops.push(child.bbox.y)
      }
    }
    return tops.length > 0 ? Math.min(...tops) : undefined
  })
  const bands = rowTops.map((top, rowIndex) => {
    if (top === undefined) return undefined
    const nextTop = rowTops
      .slice(rowIndex + 1)
      .find((candidate): candidate is number => candidate !== undefined)
    return {
      top,
      height: nextTop === undefined
        ? Math.max(1, block.bbox!.y + block.bbox!.height - top)
        : Math.max(1, nextTop - top)
    }
  })
  // 空单元格行没有文字坐标，沿用前一条行带高度；首尾无坐标时使用相邻行带兜底。
  const knownHeights = bands
    .map((band) => band?.height)
    .filter((height): height is number => height !== undefined)
  if (knownHeights.length === 0) return []
  const fallbackHeight = knownHeights.reduce((sum, height) => sum + height, 0) / knownHeights.length
  return bands.map((band, rowIndex) => {
    if (band) return band
    const previous = bands
      .slice(0, rowIndex)
      .reverse()
      .find((candidate): candidate is { top: number; height: number } => candidate !== undefined)
    const top = previous
      ? previous.top + previous.height
      : block.bbox!.y
    return { top, height: fallbackHeight }
  })
}

/**
 * 根据原列宽和译文内容计算自适应列宽，保证每列至少保留原文比例。
 * @param context 绘制上下文。
 * @param block 表格区块。
 * @param columnCount 列数。
 * @param tableWidth 表格总宽度。
 * @returns 总和等于表格宽度的自适应列宽。
 * @author zhenghq
 */
function adaptiveTableColumnWidths(
  context: DrawContext,
  block: DocumentTableBlock,
  columnCount: number,
  tableWidth: number
): number[] {
  const baseWidths = normalizeTableColumnWidths(block.columnWidths, columnCount, tableWidth)
  const contentWidths = Array.from({ length: columnCount }, () => 0)
  for (const placement of layoutTableCells(block.rows, columnCount)) {
    const naturalWidth = tableCellNaturalWidth(context, placement.cell) + 12
    const perColumnWidth = naturalWidth / placement.colSpan
    for (let offset = 0; offset < placement.colSpan; offset += 1) {
      const index = placement.columnIndex + offset
      contentWidths[index] = Math.max(contentWidths[index]!, perColumnWidth)
    }
  }
  // 原列宽作为下限；内容需求超出时按比例吸收剩余宽度，避免任一列因原文太窄而逐字换行。
  const desiredWidths = baseWidths.map((width, index) => Math.max(width, contentWidths[index] ?? 0))
  const desiredTotal = desiredWidths.reduce((sum, value) => sum + value, 0)
  if (desiredTotal <= tableWidth) {
    const extra = tableWidth - desiredTotal
    return desiredWidths.map((value) => value + extra * value / desiredTotal)
  }
  return desiredWidths.map((value) => value / desiredTotal * tableWidth)
}

/**
 * 读取并缓存图片原始字节，供 PDF 嵌入与文字遮罩采样共享。
 * @param context 绘制上下文。
 * @param assetId 资源标识。
 * @param dependencies 导出依赖。
 * @returns 图片字节；资源不存在或读取失败时返回 null。
 * @author zhenghq
 */
async function loadAssetBytes(
  context: DrawContext,
  assetId: string,
  dependencies: DocumentPdfExportDependencies
): Promise<Uint8Array | null> {
  if (context.assetBytes.has(assetId)) return context.assetBytes.get(assetId) ?? null
  let bytes: Uint8Array | null = null
  try {
    bytes = await dependencies.loadAssetBytes(assetId)
  } catch {
    bytes = null
  }
  context.assetBytes.set(assetId, bytes)
  return bytes
}

/**
 * 读取并缓存图片资源。
 * @param context 绘制上下文。
 * @param assetId 资源标识。
 * @param dependencies 导出依赖。
 * @returns PDF 图片或 null。
 * @author zhenghq
 */
async function loadImage(
  context: DrawContext,
  assetId: string,
  dependencies: DocumentPdfExportDependencies
): Promise<PDFImage | null> {
  if (context.images.has(assetId)) return context.images.get(assetId) ?? null
  let image: PDFImage | null = null
  try {
    const bytes = await loadAssetBytes(context, assetId, dependencies)
    if (bytes) {
      const format = detectImageFormat(bytes)
      if (format === 'png') image = await context.page.doc.embedPng(bytes)
      else if (format === 'jpg') image = await context.page.doc.embedJpg(bytes)
    }
  } catch {
    image = null
  }
  context.images.set(assetId, image)
  return image
}

/**
 * 解码 PNG 资源供图内文字遮罩局部采样；JPEG 等格式无法无依赖解码时保留白色兜底。
 * @param context 绘制上下文。
 * @param assetId 资源标识。
 * @param dependencies 导出依赖。
 * @returns 可采样的 RGBA 图片；资源缺失、格式不支持或解码失败时返回 null。
 * @author zhenghq
 */
async function loadMaskImage(
  context: DrawContext,
  assetId: string,
  dependencies: DocumentPdfExportDependencies
): Promise<PdfImageMaskImage | null> {
  if (context.maskImages.has(assetId)) return context.maskImages.get(assetId) ?? null
  let maskImage: PdfImageMaskImage | null = null
  try {
    const bytes = await loadAssetBytes(context, assetId, dependencies)
    if (bytes && detectImageFormat(bytes) === 'png') maskImage = decodePng(bytes)
  } catch {
    maskImage = null
  }
  context.maskImages.set(assetId, maskImage)
  return maskImage
}

/**
 * 绘制图片；失败时绘制可辨认的占位框。
 * @param context 绘制上下文。
 * @param block 图片区块。
 * @param page 页面模型。
 * @param dependencies 导出依赖。
 * @param composer 页面排版器；传入后可在页底续页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @returns 图片和 OCR 译文实际占用后的底部坐标。
 * @author zhenghq
 */
async function drawImageBlock(
  context: DrawContext,
  block: DocumentImageBlock,
  page: DocumentPage,
  dependencies: DocumentPdfExportDependencies,
  composer?: PageComposer,
  document?: PDFDocument,
  includeOcrTextLayer = false,
  drawOcrTranslations = true
): Promise<number> {
  const bbox = block.bbox ?? { x: 24, y: 24, width: page.width - 48, height: 240 }
  const image = await loadImage(context, block.assetId, dependencies)
  if (!image) {
    context.warnings.push({
      code: 'image-asset-unavailable',
      severity: 'warning',
      message: 'An image asset could not be embedded and was replaced with a placeholder.',
      pageId: page.pageId,
      blockId: block.blockId
    })
  }
  if (image) {
    context.page.drawImage(image, {
      x: bbox.x,
      y: pdfY(page.height, bbox.y, bbox.height),
      width: Math.max(1, bbox.width),
      height: Math.max(1, bbox.height)
    })
    if (includeOcrTextLayer) {
      drawOcrTextLayer(context, block, page, bbox)
    }
  } else {
    context.page.drawRectangle({
      x: bbox.x,
      y: pdfY(page.height, bbox.y, bbox.height),
      width: Math.max(1, bbox.width),
      height: Math.max(1, bbox.height),
      borderColor: rgb(0.75, 0.78, 0.82),
      borderWidth: 0.8
    })
    context.page.drawText(safeFontText('Image unavailable', context.regular), {
      x: bbox.x + 8,
      y: pdfY(page.height, bbox.y + Math.min(24, bbox.height / 2), 10),
      size: 10,
      font: context.regular,
      color: rgb(0.45, 0.48, 0.52)
    })
  }
  return drawOcrTranslations
    ? drawOcrRegions(context, block, page, composer, document)
    : bbox.y + bbox.height
}

/**
 * 绘制文本区块；流式文档没有 bbox 时按当前纵向游标排版。
 * @param context 绘制上下文。
 * @param block 文本区块。
 * @param page 页面模型。
 * @param cursor 流式排版游标。
 * @param composer 页面排版器；传入后按实际内容高度跨页。
 * @param document PDF 文档。
 * @returns 新区块游标。
 * @author zhenghq
 */
function drawTextBlock(
  context: DrawContext,
  block: DocumentTextBlock,
  page: DocumentPage,
  cursor: number,
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const hasGeometry = block.bbox !== undefined
  const bbox = block.bbox ?? {
    x: 56,
    y: cursor,
    width: Math.max(80, page.width - 112),
    height: Math.max(20, block.runs.length * 18)
  }
  const blockRight = bbox.x + bbox.width
  const contentRight = Math.max(
    blockRight,
    Math.min(page.width, page.contentArea?.right ?? blockRight)
  )
  const contentLeft = Math.min(
    bbox.x,
    Math.max(0, page.contentArea?.left ?? bbox.x)
  )
  const blockCenter = bbox.x + bbox.width / 2
  // 居中短标题的原文 bbox 通常只覆盖中文标题本身；译文变长时围绕原中心线向正文区两侧扩展，
  // 既避免英文标题按短 bbox 提前换行，也不会像整页铺排那样改变标题中心和右侧页边距。
  const centeredWidth = Math.max(bbox.width, Math.min(
    contentRight - contentLeft,
    Math.min(blockCenter - contentLeft, contentRight - blockCenter) * 2
  ))
  const flowWidth = block.textAlign === 'center'
    ? centeredWidth
    : block.textAlign === 'right'
      ? bbox.width
      : Math.max(bbox.width, contentRight - bbox.x)
  const flowX = block.textAlign === 'center'
    ? blockCenter - flowWidth / 2
    : bbox.x
  const absoluteTop = hasGeometry ? Math.max(bbox.y, cursor) : cursor
  const blockTop = resolvePdfContinuationTop(composer ?? {
    page: context.page,
    pageModel: page,
    contentTop: 0,
    contentBottom: 0,
    cursor,
    sourceBottom: 0,
    flowSourceTop: 0,
    flowActualTop: 0,
    flowSourceBottom: 0,
    flowActualBottom: 0,
    flowLeft: 0,
    flowWidth: 0,
    flowContinuationActive: false,
    flowPages: [],
    continuationTextBlocks: [],
    continuationActualBottom: 0,
    continuationTailStarted: false
  }, bbox.y, absoluteTop)
  if (block.toc) {
    if (composer && document) ensurePageSpace(composer, document, context, Math.max(1, bbox.height))
    const tocTop = composer?.cursor ?? blockTop
    const tocBottom = drawTableOfContentsBlock(
      context,
      block,
      flowX,
      tocTop,
      flowWidth,
      composer,
      document
    )
    const bottom = Math.max(tocBottom, cursor, hasGeometry ? bbox.y + bbox.height : 0)
    if (composer) {
      composer.cursor = bottom + (hasGeometry ? 10 : 12)
      composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
      recordPdfFlowAnchor(composer, block, tocTop, tocBottom)
    }
    return composer?.cursor ?? bottom + (hasGeometry ? 10 : 12)
  }
  // 普通正文与表格一样按视觉行排版；同一区块内的碎片 run 属于连续文本流，
  // 不能逐个 run 单独换行，否则中文 PDF 会退化为逐字竖排并产生大量空白页。
  const pageCountBeforeText = composer?.flowPages.length ?? 0
  const lines = layoutFlowTextLines(context, block, flowWidth, flowTextRunStyle)
  if (composer) composer.cursor = blockTop
  const used = drawFlowTextLines(
    context,
    block,
    lines,
    flowX,
    blockTop,
    flowWidth,
    composer,
    document
  )
  const drawnBottom = composer?.cursor ?? blockTop + used
  const continuedAcrossPages = composer !== undefined && composer.flowPages.length > pageCountBeforeText
  // 续页后后续区块已按新页流式坐标重排，不能再让旧页绝对底边参与最小值计算。
  const continuationWasActive = composer?.flowContinuationActive ?? false
  const bottom = continuationWasActive
    ? drawnBottom
    : Math.max(drawnBottom, cursor, hasGeometry ? bbox.y + bbox.height : 0)
  if (composer) {
    composer.cursor = bottom + (hasGeometry ? 10 : 12)
    if (!continuationWasActive) {
      composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
    }
    recordPdfFlowAnchor(composer, block, blockTop, drawnBottom)
    if (continuedAcrossPages) {
      composer.flowContinuationActive = true
      composer.continuationTextBlocks.push(block)
      composer.continuationActualBottom = drawnBottom
    }
    if (composer.flowContinuationActive) {
      composer.continuationActualBottom = Math.max(composer.continuationActualBottom, drawnBottom)
    }
    // 一旦发生续排，后续区块必须沿新页实际底边继续，不能再回填旧页坐标。
    if (composer.cursor > context.page.getHeight() - composer.contentBottom) {
      composer.flowContinuationActive = true
    }
  }
  return composer?.cursor ?? bottom + (hasGeometry ? 10 : 12)
}

/**
 * 绘制共享 flowGroupId 的同行图片与文字；图片保持原横向位置，文字从同一顶部带开始绘制。
 * 组内文本使用正文区右边界扩展可用宽度，避免译文因原始短 bbox 过早换行。
 * @param context 绘制上下文。
 * @param blocks 同组区块，按阅读顺序排列。
 * @param page 页面模型。
 * @param dependencies 导出依赖。
 * @param composer 页面排版器。
 * @param document PDF 文档。
 * @param includeOcrTextLayer 是否写入透明 OCR 原文文字层。
 * @returns 同组实际占用后的纵向底部坐标。
 * @author zhenghq
 */
async function drawFlowGroup(
  context: DrawContext,
  blocks: readonly DocumentBlock[],
  page: DocumentPage,
  dependencies: DocumentPdfExportDependencies,
  composer: PageComposer,
  document: PDFDocument,
  includeOcrTextLayer = false
): Promise<number> {
  const geometryTops = blocks
    .map((block) => block.bbox?.y)
    .filter((top): top is number => top !== undefined && Number.isFinite(top))
  const groupTop = geometryTops.length > 0 ? Math.min(...geometryTops) : composer.cursor
  const groupStartCursor = composer.cursor
  composer.cursor = Math.max(composer.cursor, groupTop)
  let groupBottom = composer.cursor
  const groupGeometry = resolveTranslationFlowGroupGeometry(blocks, page.blocks, page.width, page.contentArea)
  const flowGroupPage: DocumentPage = {
    ...page,
    contentArea: {
      left: Math.min(groupGeometry.left, page.contentArea?.left ?? groupGeometry.left),
      right: groupGeometry.left + groupGeometry.width,
      center: groupGeometry.left + groupGeometry.width / 2
    }
  }

  // 先绘制非文本区块，确保 logo 的原位置不受文字排版游标影响。
  for (const block of blocks) {
    if (block.kind === 'text') continue
    if (block.kind === 'image') {
      const bbox = block.bbox
      if (!bbox) continue
      const imageTop = Math.max(bbox.y, groupStartCursor)
      const imageBlock = { ...block, bbox: { ...bbox, y: imageTop } }
      const bottom = await drawImageBlock(
        context,
        imageBlock,
        page,
        dependencies,
        composer,
        document,
        includeOcrTextLayer
      )
      groupBottom = Math.max(groupBottom, bottom, imageTop + bbox.height)
      composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
      continue
    }
    if (block.kind === 'table') {
      composer.cursor = Math.max(composer.cursor, groupTop)
      composer.cursor = await drawTableBlock(
        context,
        block,
        page,
        composer.cursor,
        dependencies,
        composer,
        document,
        includeOcrTextLayer
      )
      groupBottom = Math.max(groupBottom, composer.cursor)
      continue
    }
    if (block.kind === 'formula') {
      composer.cursor = Math.max(composer.cursor, groupTop)
      composer.cursor = drawFormulaBlock(context, block, page, composer.cursor, composer, document)
      groupBottom = Math.max(groupBottom, composer.cursor)
      continue
    }
    if (block.kind === 'shape' && block.bbox) {
      const isVertical = block.line?.orientation === 'vertical'
      const fitsSourcePage = block.bbox.y >= 0 &&
        block.bbox.y + block.bbox.height <= context.page.getHeight()
      const fallbackTop = isVertical && fitsSourcePage
        ? block.bbox.y
        : Math.max(block.bbox.y, groupTop)
      const shapeTop = fallbackTop
      if (block.line?.orientation === 'horizontal') {
        context.page.drawLine({
          start: { x: block.bbox.x, y: pdfY(context.page.getHeight(), shapeTop, 0) },
          end: { x: block.bbox.x + block.bbox.width, y: pdfY(context.page.getHeight(), shapeTop, 0) },
          thickness: Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
      } else if (block.line?.orientation === 'vertical') {
        context.page.drawLine({
          start: { x: block.bbox.x, y: pdfY(context.page.getHeight(), shapeTop, block.bbox.height) },
          end: { x: block.bbox.x, y: pdfY(context.page.getHeight(), shapeTop, 0) },
          thickness: Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
      }
      // 竖线通常是页面外框或分栏边界，必须固定原始页面坐标，不能推进同组文本流。
      if (!isVertical) groupBottom = Math.max(groupBottom, shapeTop + block.bbox.height)
      composer.sourceBottom = Math.max(composer.sourceBottom, block.bbox.y + block.bbox.height)
    }
  }

  // 文本必须从组顶部带开始，不能继承图片绘制后下移的游标。
  for (const block of blocks) {
    if (block.kind !== 'text') continue
    composer.cursor = Math.max(groupTop, groupStartCursor)
    const bottom = drawTextBlock(context, block, flowGroupPage, composer.cursor, composer, document)
    groupBottom = Math.max(groupBottom, bottom)
  }
  composer.cursor = groupBottom
  composer.previousBlock = blocks[blocks.length - 1]
  return groupBottom
}

/**
 * 绘制同一 stackGroupId 下的叠放图片。
 * 整组只进行一次纵向排版，全部底图先按 stackOrder 覆盖绘制，再统一绘制各成员 OCR 译文，
 * 避免上层图片遮住底层 OCR，也避免第二张图片把后续正文再次下推。
 * @param context 绘制上下文。
 * @param blocks 同一叠放组内的图片区块。
 * @param page 页面模型。
 * @param dependencies 导出依赖。
 * @param composer 页面排版器。
 * @param document PDF 文档。
 * @param includeOcrTextLayer 是否写入透明 OCR 原文文字层。
 * @returns 叠放组实际占用后的纵向底部坐标。
 * @author zhenghq
 */
async function drawImageStack(
  context: DrawContext,
  blocks: readonly DocumentImageBlock[],
  page: DocumentPage,
  dependencies: DocumentPdfExportDependencies,
  composer: PageComposer,
  document: PDFDocument,
  includeOcrTextLayer = false
): Promise<number> {
  const bounds = blocks
    .map((block) => block.bbox)
    .filter((bbox): bbox is NonNullable<DocumentImageBlock['bbox']> => bbox !== undefined)
  if (bounds.length === 0) return composer.cursor
  const left = Math.min(...bounds.map((bbox) => bbox.x))
  const top = Math.min(...bounds.map((bbox) => bbox.y))
  const stackBounds = {
    x: left,
    y: top,
    width: Math.max(1, Math.max(...bounds.map((bbox) => bbox.x + bbox.width)) - left),
    height: Math.max(1, Math.max(...bounds.map((bbox) => bbox.y + bbox.height)) - top)
  }
  if (stackBounds.y > composer.cursor) composer.cursor = stackBounds.y
  const stackTop = ensureGeometryBlockSpace(
    composer,
    document,
    context,
    composer.cursor,
    stackBounds.height,
    stackBounds.y,
    stackBounds.height
  )
  const orderedBlocks = [...blocks].sort((leftBlock, rightBlock) =>
    (leftBlock.stackOrder ?? 0) - (rightBlock.stackOrder ?? 0))
  const positionedBlocks = orderedBlocks.map((block) => ({
    block,
    drawBbox: block.bbox
      ? {
          ...block.bbox,
          y: stackTop + Math.max(0, block.bbox.y - stackBounds.y)
        }
      : { ...stackBounds, y: stackTop }
  }))
  let stackBottom = stackTop + stackBounds.height
  // 先铺完全部底图，再绘制 OCR，保证底层图片的译文不会被上层图片覆盖。
  for (const entry of positionedBlocks) {
    stackBottom = Math.max(stackBottom, await drawImageBlock(
      context,
      { ...entry.block, bbox: entry.drawBbox },
      page,
      dependencies,
      composer,
      document,
      includeOcrTextLayer,
      false
    ))
  }
  for (const entry of positionedBlocks) {
    stackBottom = Math.max(
      stackBottom,
      drawOcrRegions(
        context,
        { ...entry.block, bbox: entry.drawBbox },
        page,
        composer,
        document
      )
    )
  }
  composer.cursor = stackBottom
  composer.sourceBottom = Math.max(composer.sourceBottom, stackBounds.y + stackBounds.height)
  recordPdfFlowAnchor(
    composer,
    { ...orderedBlocks[0]!, bbox: stackBounds },
    stackTop,
    stackBottom
  )
  return stackBottom
}

/**
 * 在图片覆盖组的原始位置绘制图内原生文字。
 * 文字从原顶部开始排版，原始 bbox 只作为起始位置；译文行盒更高时仍完整绘制，
 * 且不传排版器以确保文字不会推进覆盖组普通流游标。
 * @param context 绘制上下文。
 * @param block 原生文字区块。
 * @param page 页面模型。
 * @param bbox 覆盖组内换算后的文字 bbox。
 * @returns 无返回值。
 * @author zhenghq
 */
function drawImageOverlayText(
  context: DrawContext,
  block: DocumentTextBlock,
  page: DocumentPage,
  bbox: DocumentBoundingBox
): void {
  // 不传排版器：图内文字只覆盖在原位，不允许触发换页或改变覆盖组普通流高度。
  // 不能按原 bbox 裁切，否则译文行盒比原始单行 bbox 高时，每行上下都会被截断。
  drawTextBlock(context, { ...block, bbox }, page, bbox.y)
}

/**
 * 绘制图片覆盖组：先按 stackOrder 铺完全部底图，再把图内原生译文绝对绘制到原始位置。
 * 整组只占一次普通流高度；后续正文只从图片与 OCR 译文的实际底边继续。
 * @param context 绘制上下文。
 * @param images 覆盖组内的图片区块。
 * @param texts 覆盖组内的原生文字区块。
 * @param page 页面模型。
 * @param dependencies 导出依赖。
 * @param composer 页面排版器。
 * @param document PDF 文档。
 * @param includeOcrTextLayer 是否写入透明 OCR 原文文字层。
 * @param alignedImageRow 同一原文行首个覆盖组的原始锚点与实际落位。
 * @returns 覆盖组实际占用后的纵向底部坐标。
 * @author zhenghq
 */
async function drawImageOverlayGroup(
  context: DrawContext,
  images: readonly DocumentImageBlock[],
  texts: readonly DocumentTextBlock[],
  page: DocumentPage,
  dependencies: DocumentPdfExportDependencies,
  composer: PageComposer,
  document: PDFDocument,
  includeOcrTextLayer = false,
  alignedImageRow?: DocumentTranslationImageFlowRow
): Promise<number> {
  const bounds = resolveDocumentImageOverlayBounds(images, texts)
  if (!bounds) return composer.cursor
  if (bounds.y > composer.cursor) composer.cursor = bounds.y
  const alignsWithImageRow = alignedImageRow !== undefined &&
    Math.abs(bounds.y - alignedImageRow.sourceTop) <= 0.5
  const desiredTop = alignsWithImageRow
    ? Math.max(bounds.y, alignedImageRow.actualTop)
    : composer.cursor
  const overlayTop = ensureGeometryBlockSpace(
    composer,
    document,
    context,
    desiredTop,
    bounds.height,
    bounds.y,
    bounds.height
  )
  const orderedImages = [...images].sort((left, right) =>
    (left.stackOrder ?? 0) - (right.stackOrder ?? 0))
  const positionedImages = orderedImages.map((block) => ({
    block,
    drawBbox: block.bbox
      ? { ...block.bbox, y: overlayTop + Math.max(0, block.bbox.y - bounds.y) }
      : { ...bounds, y: overlayTop }
  }))
  let overlayBottom = overlayTop + Math.max(0, bounds.height)
  // 先铺完全部底图，再统一绘制 OCR，避免底层图片的译文被上层图片覆盖。
  for (const entry of positionedImages) {
    const imageBottom = await drawImageBlock(
      context,
      { ...entry.block, bbox: entry.drawBbox },
      page,
      dependencies,
      composer,
      document,
      includeOcrTextLayer,
      false
    )
    overlayBottom = Math.max(overlayBottom, imageBottom)
  }
  for (const entry of positionedImages) {
    overlayBottom = Math.max(
      overlayBottom,
      drawOcrRegions(
        context,
        { ...entry.block, bbox: entry.drawBbox },
        page,
        composer,
        document
      )
    )
  }
  for (const block of texts) {
    if (!block.bbox) continue
    drawImageOverlayText(context, block, page, {
      ...block.bbox,
      y: overlayTop + (block.bbox.y - bounds.y)
    })
  }
  composer.cursor = overlayBottom
  composer.sourceBottom = Math.max(composer.sourceBottom, bounds.y + bounds.height)
  recordPdfFlowAnchor(
    composer,
    { ...(orderedImages[0] ?? texts[0]!), bbox: bounds },
    overlayTop,
    overlayBottom
  )
  return overlayBottom
}

/**
 * 绘制表格边框、列宽和单元格内容。
 * @param context 绘制上下文。
 * @param block 表格区块。
 * @param page 页面模型。
 * @param cursor 流式排版游标。
 * @param dependencies 导出依赖，用于读取单元格内图片。
 * @param composer 页面排版器；传入后可按实际行高跨页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @param includeOcrTextLayer 是否写入透明 OCR 原文文字层。
 * @returns 新区块游标。
 * @author zhenghq
 */
async function drawTableBlock(
  context: DrawContext,
  block: DocumentTableBlock,
  page: DocumentPage,
  cursor: number,
  dependencies: DocumentPdfExportDependencies,
  composer?: PageComposer,
  document?: PDFDocument,
  includeOcrTextLayer = false
): Promise<number> {
  const hasGeometry = block.bbox !== undefined
  const bbox = block.bbox ?? {
    x: 48,
    y: cursor,
    width: Math.max(120, page.width - 96),
    height: Math.max(24, block.rows.length * 28)
  }
  let tableTop = hasGeometry ? Math.max(bbox.y, cursor) : cursor
  if (composer && document) {
    const pageChanged = ensurePageSpace(composer, document, context, Math.max(24, bbox.height))
    // 表格整体放不下时会先换页；换页后必须从新页内容区顶部开始，不能沿用旧页坐标。
    if (pageChanged) tableTop = composer.cursor
  }
  const columnCount = tableColumnCount(block)
  const widths = adaptiveTableColumnWidths(context, block, columnCount, bbox.width)
  const placements = layoutTableCells(block.rows, columnCount)
  const rowHeights = await tableRowHeights(
    context,
    block,
    placements,
    block.rows.length,
    widths,
    dependencies
  )
  const headerCount = Math.max(0, Math.min(
    block.headerRows ?? 0,
    block.rows.length
  ))
  const headerPlacements = headerCount > 0
    ? layoutTableCells(block.rows.slice(0, headerCount), columnCount)
    : []
  const headerHeight = rowHeights.slice(0, headerCount).reduce((sum, value) => sum + value, 0)
  let currentRowTop = tableTop
  const textState = { hasTableText: false }
  for (let headerRowIndex = 0; headerRowIndex < headerCount; headerRowIndex += 1) {
    currentRowTop = await drawTableRowPlacements(
      context,
      headerPlacements.filter((placement) => placement.rowIndex === headerRowIndex),
      currentRowTop,
      rowHeights.slice(0, headerCount),
      widths,
      bbox.x,
      page,
      dependencies,
      includeOcrTextLayer,
      textState
    )
    if (composer) composer.cursor = currentRowTop
  }
  for (let rowIndex = headerCount; rowIndex < block.rows.length; rowIndex += 1) {
    const rowPlacements = placements.filter((placement) => placement.rowIndex === rowIndex)
    const requiredHeight = Math.max(
      rowHeights[rowIndex]!,
      ...rowPlacements.map((placement) => rowHeights
        .slice(rowIndex, rowIndex + placement.rowSpan)
        .reduce((sum, value) => sum + value, 0))
    )
    if (composer && document) {
      composer.cursor = currentRowTop
      const pageChanged = ensurePageSpace(
        composer,
        document,
        context,
        requiredHeight + (rowIndex > headerCount ? headerHeight : 0)
      )
      if (pageChanged) {
        currentRowTop = composer.cursor
        // 新页没有上一页单元格的文本状态，避免重复表头首格多出一个前导空格。
        textState.hasTableText = false
        // 数据行跨页时重新绘制表头；表头自身不参与数据行循环，避免重复计数。
        if (headerCount > 0) {
          for (let headerRowIndex = 0; headerRowIndex < headerCount; headerRowIndex += 1) {
            currentRowTop = await drawTableRowPlacements(
              context,
              headerPlacements.filter((placement) => placement.rowIndex === headerRowIndex),
              currentRowTop,
              rowHeights.slice(0, headerCount),
              widths,
              bbox.x,
              page,
              dependencies,
              includeOcrTextLayer,
              textState
            )
          }
          composer.cursor = currentRowTop
        }
      }
    }
    currentRowTop = await drawTableRowPlacements(
      context,
      rowPlacements,
      currentRowTop,
      rowHeights,
      widths,
      bbox.x,
      page,
      dependencies,
      includeOcrTextLayer,
      textState
    )
    if (composer) composer.cursor = currentRowTop
  }
  // 单元格内容已经形成表格的真实底边；原 bbox 高度只用于保留表格之后的源间距，
  // 不能再次作为最小高度叠加，否则紧凑表格会把后续正文无故推下并制造额外分页。
  const sourceSpacing = hasGeometry
    ? Math.max(0, bbox.y + bbox.height - currentRowTop)
    : 0
  const bottom = Math.max(cursor, currentRowTop + sourceSpacing)
  if (composer) {
    composer.cursor = bottom + 10
    composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
    recordPdfFlowAnchor(composer, block, tableTop, currentRowTop)
  }
  return composer?.cursor ?? bottom + 10
}

/**
 * 绘制一行中从当前物理行开始的表格单元格，并返回下一行的顶部坐标。
 * @param context 绘制上下文。
 * @param placements 当前行开始的单元格位置。
 * @param rowTop 当前行顶部坐标。
 * @param rowHeights 当前表格的全部行高；表头重复时传入表头行高。
 * @param widths 各物理列宽度。
 * @param tableLeft 表格左边界。
 * @param page 页面模型，用于记录资源告警。
 * @param dependencies 导出依赖，用于读取单元格内图片。
 * @param includeOcrTextLayer 是否写入透明 OCR 原文文字层。
 * @param textState 表格文本状态，用于在相邻单元格之间补空格。
 * @returns 当前行实际底边坐标。
 * @author zhenghq
 */
async function drawTableRowPlacements(
  context: DrawContext,
  placements: readonly TableCellPlacement[],
  rowTop: number,
  rowHeights: readonly number[],
  widths: readonly number[],
  tableLeft: number,
  page: DocumentPage,
  dependencies: DocumentPdfExportDependencies,
  includeOcrTextLayer: boolean,
  textState: { hasTableText: boolean }
): Promise<number> {
  for (const placement of placements) {
    const cellWidth = tableCellPlacementWidth(widths, placement)
    const cellX = tableLeft + widths
      .slice(0, placement.columnIndex)
      .reduce((sum, value) => sum + value, 0)
    const cellHeight = rowHeights
      .slice(placement.rowIndex, placement.rowIndex + placement.rowSpan)
      .reduce((sum, value) => sum + value, 0)
    const pageHeight = context.page.getHeight()
    context.page.drawRectangle({
      x: cellX,
      y: pdfY(pageHeight, rowTop, cellHeight),
      width: Math.max(1, cellWidth),
      height: Math.max(1, cellHeight),
      borderColor: rgb(0.72, 0.75, 0.79),
      borderWidth: 0.6
    })
    let contentTop = rowTop + 5
    let hasCellText = false
    const textGroups = groupTableCellBlocks(placement.cell.blocks)
    for (const group of textGroups) {
      let groupHeight = 0
      const stack = resolveTableCellImageStackContents(group)
      if (stack) {
        groupHeight = await drawTableCellImageStack(
          context,
          stack.images,
          stack.texts,
          page,
          cellX + 5,
          contentTop,
          cellWidth - 10,
          dependencies,
          includeOcrTextLayer
        )
        contentTop += groupHeight
        continue
      }
      for (const child of group) {
        if (child.kind === 'text') {
          // 表格相邻单元格之间补空格，避免复制出的可检索文本丢失词语边界。
          const hasText = child.runs.some((run) => run.text.length > 0)
          if (textState.hasTableText && !hasCellText && hasText) {
            const spacerWidth = context.regular.widthOfTextAtSize(' ', 10)
            if (spacerWidth > 0 && cellX + 5 + spacerWidth <= cellX + cellWidth - 5) {
              context.page.drawText(' ', {
                x: cellX + 5,
                y: pdfY(context.page.getHeight(), contentTop, 10),
                size: 10,
                font: context.regular,
                color: rgb(0, 0, 0)
              })
            }
          }
          groupHeight = Math.max(groupHeight, drawTableCellTextBlock(
            context,
            child,
            cellX + 5,
            contentTop,
            cellWidth - 10
          ))
          if (hasText) {
            textState.hasTableText = true
            hasCellText = true
          }
        } else if (child.kind === 'image') {
          groupHeight = Math.max(groupHeight, await drawTableCellImage(
            context,
            child,
            page,
            cellX + 5,
            contentTop,
            cellWidth - 10,
            dependencies,
            includeOcrTextLayer
          ))
        }
      }
      contentTop += groupHeight
    }
  }
  const rowHeight = rowHeights[placements[0]?.rowIndex ?? 0] ?? 0
  return rowTop + rowHeight
}

/**
 * 绘制公式文本；首版保持原始表达而不改写语义。
 * @param context 绘制上下文。
 * @param block 公式区块。
 * @param page 页面模型。
 * @param cursor 流式排版游标。
 * @returns 新区块游标。
 * @author zhenghq
 */
function drawFormulaBlock(
  context: DrawContext,
  block: Extract<DocumentBlock, { kind: 'formula' }>,
  page: DocumentPage,
  cursor: number,
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const text = block.sourceText ?? block.latex ?? block.mathml ?? '[formula]'
  const hasGeometry = block.bbox !== undefined
  const bbox = block.bbox ?? { x: 56, y: cursor, width: page.width - 112, height: 28 }
  let formulaTop = hasGeometry ? Math.max(bbox.y, cursor) : cursor
  if (composer && document) {
    const pageChanged = ensurePageSpace(composer, document, context, bbox.height)
    // 公式整体放不下时会先换页；换页后必须从新页内容区顶部开始，不能沿用旧页坐标。
    if (pageChanged) formulaTop = composer.cursor
  }
  const pageHeight = context.page.getHeight()
  context.page.drawRectangle({
    x: bbox.x,
    y: pdfY(pageHeight, formulaTop, bbox.height),
    width: bbox.width,
    height: bbox.height,
    color: rgb(0.96, 0.97, 0.98)
  })
  context.page.drawText(safeFontText(text, context.regular), {
    x: bbox.x + 8,
    y: pdfY(pageHeight, formulaTop + 8, 11),
    size: 11,
    font: context.regular,
    color: rgb(0.2, 0.22, 0.26)
  })
  const bottom = Math.max(cursor, formulaTop + bbox.height)
  if (composer) {
    composer.cursor = bottom + 10
    composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
    recordPdfFlowAnchor(composer, block, formulaTop, formulaTop + bbox.height)
  }
  return composer?.cursor ?? bottom + 10
}

/**
 * 绘制单页全部区块。
 * @param context 绘制上下文。
 * @param pageModel 页面模型。
 * @param dependencies 导出依赖。
 * @param document PDF 文档。
 * @returns 绘制 Promise。
 * @author zhenghq
 */
async function drawPageBlocks(
  context: DrawContext,
  pageModel: DocumentPage,
  dependencies: DocumentPdfExportDependencies,
  document: PDFDocument,
  includeOcrTextLayer = false,
  transform?: {
    /** 绘制区域横向偏移，单位为 PDF 点。 */
    offsetX: number
    /** 绘制区域最大宽度，单位为 PDF 点。 */
    width: number
  }
): Promise<void> {
  const pageModelForDraw = transform
    ? {
        ...pageModel,
        width: transform.width,
        blocks: pageModel.blocks.map((block) => ({
          ...block,
          ...(block.bbox
            ? { bbox: { ...block.bbox, x: block.bbox.x + transform.offsetX } }
            : {})
        }))
      }
    : pageModel
  const composer = createPageComposer(document, context, pageModelForDraw)
  const imageStackBlocks = new Map<string, DocumentImageBlock[]>()
  const imageOverlayImages = new Map<string, DocumentImageBlock[]>()
  const imageOverlayTexts = new Map<string, DocumentTextBlock[]>()
  for (const block of pageModelForDraw.blocks) {
    if (block.kind === 'image') {
      if (block.stackGroupId) {
        const stackBlocks = imageStackBlocks.get(block.stackGroupId) ?? []
        stackBlocks.push(block)
        imageStackBlocks.set(block.stackGroupId, stackBlocks)
      }
      if (block.overlayGroupId) {
        const overlayImages = imageOverlayImages.get(block.overlayGroupId) ?? []
        overlayImages.push(block)
        imageOverlayImages.set(block.overlayGroupId, overlayImages)
      }
      continue
    }
    if (block.kind === 'text' && block.overlayGroupId) {
      const overlayTexts = imageOverlayTexts.get(block.overlayGroupId) ?? []
      overlayTexts.push(block)
      imageOverlayTexts.set(block.overlayGroupId, overlayTexts)
    }
  }
  const drawnImageStackIds = new Set<string>()
  const drawnImageOverlayIds = new Set<string>()
  let alignedImageRow: DocumentTranslationImageFlowRow | undefined
  for (let blockIndex = 0; blockIndex < pageModel.blocks.length; blockIndex += 1) {
    const block = pageModelForDraw.blocks[blockIndex]!
    const overlayGroupId = block.overlayGroupId
    const overlayImages = overlayGroupId ? imageOverlayImages.get(overlayGroupId) ?? [] : []
    const overlayTexts = overlayGroupId ? imageOverlayTexts.get(overlayGroupId) ?? [] : []
    const hasOverlay = overlayGroupId !== undefined && overlayImages.length > 0
    if (hasOverlay) {
      // 覆盖组已按图片和组内原生文字整体绘制，后续成员必须跳过，避免文字被重复排到图片下方。
      if (drawnImageOverlayIds.has(overlayGroupId)) continue
      drawnImageOverlayIds.add(overlayGroupId)
      composer.cursor = await drawImageOverlayGroup(
        context,
        overlayImages,
        overlayTexts,
        pageModelForDraw,
        dependencies,
        composer,
        document,
        includeOcrTextLayer,
        alignedImageRow
      )
      const overlayBounds = resolveDocumentImageOverlayBounds(overlayImages, overlayTexts)
      alignedImageRow = overlayBounds
        ? { sourceTop: overlayBounds.y, actualTop: composer.flowActualTop }
        : undefined
      composer.previousBlock = overlayTexts[overlayTexts.length - 1] ?? overlayImages[overlayImages.length - 1] ?? block
      continue
    }
    if (block.kind === 'image' && block.stackGroupId) {
      if (drawnImageStackIds.has(block.stackGroupId)) continue
      drawnImageStackIds.add(block.stackGroupId)
      const stackBlocks = imageStackBlocks.get(block.stackGroupId) ?? [block]
      composer.cursor = await drawImageStack(
        context,
        stackBlocks,
        pageModelForDraw,
        dependencies,
        composer,
        document,
        includeOcrTextLayer
      )
      composer.previousBlock = stackBlocks[stackBlocks.length - 1] ?? block
      continue
    }
    if (block.flowGroupId) {
      const group: DocumentBlock[] = [block]
      let nextIndex = blockIndex + 1
      while (nextIndex < pageModelForDraw.blocks.length &&
        pageModelForDraw.blocks[nextIndex]?.flowGroupId === block.flowGroupId) {
        group.push(pageModelForDraw.blocks[nextIndex]!)
        nextIndex += 1
      }
      if (group.length > 1) {
        await drawFlowGroup(
          context,
          group,
          pageModelForDraw,
          dependencies,
          composer,
          document,
          includeOcrTextLayer
        )
        blockIndex = nextIndex - 1
        continue
      }
    }
    if (block.kind === 'text') {
      composer.cursor = drawTextBlock(context, block, pageModelForDraw, composer.cursor, composer, document)
    } else if (block.kind === 'table') {
      composer.cursor = await drawTableBlock(
        context,
        block,
        pageModelForDraw,
        composer.cursor,
        dependencies,
        composer,
        document,
        includeOcrTextLayer
      )
    } else if (block.kind === 'image') {
      const bbox = block.bbox
      if (bbox && bbox.y > composer.cursor) composer.cursor = bbox.y
      const imageTop = bbox
        ? ensureGeometryBlockSpace(
          composer,
          document,
          context,
          composer.cursor,
          bbox.height,
          bbox.y,
          bbox.height
        )
        : composer.cursor
      composer.cursor = imageTop
      const imageBlock = bbox ? { ...block, bbox: { ...bbox, y: imageTop } } : block
      composer.cursor = await drawImageBlock(
        context,
        imageBlock,
        pageModelForDraw,
        dependencies,
        composer,
        document,
        includeOcrTextLayer
      )
      if (bbox) recordPdfFlowAnchor(composer, imageBlock, imageTop, composer.cursor)
      composer.sourceBottom = Math.max(
        composer.sourceBottom,
        bbox ? bbox.y + bbox.height : composer.cursor
      )
    } else if (block.kind === 'formula') {
      composer.cursor = drawFormulaBlock(context, block, pageModelForDraw, composer.cursor, composer, document)
    } else if (block.kind === 'shape' && block.bbox) {
      const isVertical = block.line?.orientation === 'vertical'
      // 局部结构竖线统一在页面末尾绘制，正文跨页时才能判断是否需要续绘。
      if (isVertical && isPdfStructuralVerticalLine(block, context.page.getHeight())) {
        composer.previousBlock = block
        continue
      }
      if (isVertical && composer.flowContinuationActive) {
        composer.previousBlock = block
        continue
      }
      if (block.bbox.y > composer.cursor && !composer.flowContinuationActive) {
        composer.cursor = block.bbox.y
      }
      const fitsSourcePage = block.bbox.y >= 0 &&
        block.bbox.y + block.bbox.height <= context.page.getHeight()
      const fallbackTop = isVertical && fitsSourcePage
        ? block.bbox.y
        : block.line?.orientation === 'horizontal' && composer.flowContinuationActive
          // 续排后的水平线已由流式锚点重定位，不能先用旧页游标触发一次换页。
          ? Math.max(block.bbox.y, composer.cursor)
          : ensureGeometryBlockSpace(
              composer,
              document,
              context,
              composer.cursor,
              block.bbox.height,
              block.bbox.y,
              block.bbox.height
            )
      const shapeTop = block.line?.orientation === 'horizontal'
        ? resolvePdfHorizontalDecorationTop(composer, block, fallbackTop)
        : fallbackTop
      // 装饰线移动后仍可能越过当前页底，必须在绘制前重新检查一次可用空间。
      const finalTop = shapeTop > fallbackTop &&
          !(block.line?.orientation === 'horizontal' && composer.flowContinuationActive)
        ? ensureGeometryBlockSpace(
            composer,
            document,
            context,
            shapeTop,
            block.bbox.height,
            block.bbox.y,
            block.bbox.height
          )
        : shapeTop
      const physicalBottom = context.page.getHeight()
      if (block.line?.orientation === 'horizontal' &&
          composer.flowContinuationActive &&
          finalTop + block.bbox.height > physicalBottom) {
        // 续排后的底边可能刚好越过物理页底；原线仍完整位于源页面内时，
        // 只夹紧到页底，不能因此再生成一张只有框线的空白页。
        const clampedTop = Math.max(0, physicalBottom - block.bbox.height)
        context.page.drawLine({
          start: { x: block.bbox.x, y: pdfY(physicalBottom, clampedTop, 0) },
          end: { x: block.bbox.x + block.bbox.width, y: pdfY(physicalBottom, clampedTop, 0) },
          thickness: isPdfStructuralLine(block)
            ? PDF_STRUCTURAL_LINE_THICKNESS
            : Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
        composer.cursor = Math.max(composer.cursor, physicalBottom)
        recordPdfContinuationDecorationAnchor(composer, block, clampedTop)
        if (isPdfStructuralLine(block)) {
          composer.continuationStructuralBottom = Math.max(
            composer.continuationStructuralBottom ?? 0,
            clampedTop + block.bbox.height
          )
        }
        composer.previousBlock = block
        continue
      }
      if (block.line?.orientation === 'horizontal' && composer.flowContinuationActive) {
        // 续排后的尾注和底边已经脱离原页坐标；只要其实际位置仍在物理页内，
        // 就不能再因为编辑安全区留白而创建空白第三页。
        if (finalTop + block.bbox.height <= physicalBottom) {
          composer.cursor = Math.max(composer.cursor, finalTop + block.bbox.height)
        } else {
          const clampedTop = Math.max(0, physicalBottom - block.bbox.height)
          context.page.drawLine({
            start: { x: block.bbox.x, y: pdfY(physicalBottom, clampedTop, 0) },
            end: { x: block.bbox.x + block.bbox.width, y: pdfY(physicalBottom, clampedTop, 0) },
            thickness: isPdfStructuralLine(block)
              ? PDF_STRUCTURAL_LINE_THICKNESS
              : Math.max(0.5, block.line.thickness ?? 1),
            color: parseColor(block.line.color, [0.8, 0.82, 0.85])
          })
          composer.cursor = Math.max(composer.cursor, physicalBottom)
          recordPdfContinuationDecorationAnchor(composer, block, clampedTop)
          if (isPdfStructuralLine(block)) {
            composer.continuationStructuralBottom = Math.max(
              composer.continuationStructuralBottom ?? 0,
              clampedTop + block.bbox.height
            )
          }
          composer.previousBlock = block
          continue
        }
      }
      if (!isVertical) composer.cursor = finalTop
      if (block.line?.orientation === 'horizontal') {
        const y = pdfY(context.page.getHeight(), finalTop, 0)
        context.page.drawLine({
          start: { x: block.bbox.x, y },
          end: { x: block.bbox.x + block.bbox.width, y },
          thickness: isPdfStructuralLine(block)
            ? PDF_STRUCTURAL_LINE_THICKNESS
            : Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
        recordPdfContinuationDecorationAnchor(composer, block, finalTop)
        if (isPdfStructuralLine(block)) {
          composer.continuationStructuralBottom = Math.max(
            composer.continuationStructuralBottom ?? 0,
            finalTop + block.bbox.height
          )
        }
      } else if (block.line?.orientation === 'vertical') {
        const x = block.bbox.x
        context.page.drawLine({
          start: { x, y: pdfY(context.page.getHeight(), finalTop, block.bbox.height) },
          end: { x, y: pdfY(context.page.getHeight(), finalTop, 0) },
          thickness: Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
      } else {
        context.page.drawRectangle({
          x: block.bbox.x,
          y: pdfY(context.page.getHeight(), finalTop, block.bbox.height),
          width: block.bbox.width,
          height: block.bbox.height,
          borderColor: rgb(0.8, 0.82, 0.85),
          borderWidth: 0.5
        })
      }
      // 竖线是页面装饰而非普通流内容；推进游标会让后续正文错误换页。
      if (!isVertical) composer.cursor = finalTop + block.bbox.height
      if (!composer.flowContinuationActive) {
        composer.sourceBottom = Math.max(composer.sourceBottom, block.bbox.y + block.bbox.height)
      }
    }
    composer.previousBlock = block
  }
  drawPdfStructuralVerticalLines(pageModelForDraw, composer)
}

/**
 * 将统一文档模型导出为 PDF。
 * @param model 翻译后的文档模型。
 * @param dependencies 字体与资源读取依赖。
 * @returns PDF 字节与可降级告警。
 * @author zhenghq
 */
export async function exportDocumentToPdf(
  model: DocumentModel,
  dependencies: DocumentPdfExportDependencies,
  options: DocumentPdfExportOptions = {}
): Promise<DocumentPdfExportResult> {
  if (options.signal?.aborted) throw createExportAbortError()
  if (!model || !Array.isArray(model.pages) || model.pages.length === 0) {
    throw new DocumentPdfExportError('invalid-document', 'Document has no pages')
  }
  try {
    const sourcePdfBytes = dependencies.sourcePdfBytes
    const document = sourcePdfBytes
      ? await PDFDocument.load(sourcePdfBytes, { updateMetadata: false })
      : await PDFDocument.create()
    if (!sourcePdfBytes) {
      document.setTitle(model.metadata.title ?? model.source.fileName)
      if (model.metadata.author) document.setAuthor(model.metadata.author)
    }
    const fonts = await resolveFonts(document, model, dependencies)
    const images = new Map<string, PDFImage | null>()
    const warnings: DocumentWarning[] = []
    const totalPages = model.pages.length
    if (sourcePdfBytes) {
      const sourcePageCount = document.getPageCount()
      if (sourcePageCount !== model.pages.length) {
        warnings.push({
          code: 'ocr-source-page-count-mismatch',
          severity: 'warning',
          message: 'The source PDF page count differs from the OCR model; original pages were preserved.'
        })
      }
      const pagesByIndex = new Map(model.pages.map((page) => [page.index, page]))
      let writtenOcrTextCount = 0
      for (let pageIndex = 0; pageIndex < sourcePageCount; pageIndex += 1) {
        if (options.signal?.aborted) throw createExportAbortError()
        const pageModel = pagesByIndex.get(pageIndex)
        if (!pageModel) continue
      const page = document.getPage(pageIndex)
      writtenOcrTextCount += appendSourcePdfOcrTextLayers(document, pageModel, {
          page,
          regular: fonts.regular,
          bold: fonts.bold,
          italic: fonts.italic,
          boldItalic: fonts.boldItalic,
          images,
          assetBytes: new Map(),
          maskImages: new Map(),
          warnings
        })
      }
      if (writtenOcrTextCount === 0) {
        warnings.push({
          code: 'ocr-source-text-layer-empty',
          severity: 'warning',
          message: 'No OCR text was available to write into the source PDF text layer.'
        })
      }
      if (options.signal?.aborted) throw createExportAbortError()
      const bytes = await document.save()
      if (options.signal?.aborted) throw createExportAbortError()
      options.onProgress?.({ completedPages: totalPages, totalPages })
      return { bytes, warnings }
    }
    for (let pageIndex = 0; pageIndex < model.pages.length; pageIndex += 1) {
      if (options.signal?.aborted) throw createExportAbortError()
      const pageModel = model.pages[pageIndex]!
      const page = createComposedPage(document, pageModel)
      const context: DrawContext = {
        page,
        regular: fonts.regular,
        bold: fonts.bold,
        italic: fonts.italic,
        boldItalic: fonts.boldItalic,
        images,
        assetBytes: new Map(),
        maskImages: new Map(),
        warnings
      }
      await drawPageBlocks(context, pageModel, dependencies, document, options.includeOcrTextLayer)
      if (options.signal?.aborted) throw createExportAbortError()
      options.onProgress?.({ completedPages: pageIndex + 1, totalPages })
    }
    if (options.signal?.aborted) throw createExportAbortError()
    const bytes = await document.save()
    if (options.signal?.aborted) throw createExportAbortError()
    return { bytes, warnings }
  } catch (error) {
    if (isExportAbortError(error)) throw error
    if (error instanceof DocumentPdfExportError) throw error
    throw new DocumentPdfExportError('export-failed', 'PDF export failed')
  }
}
