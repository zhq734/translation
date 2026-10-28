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
  resolveOcrRegionFontSize,
  resolveOcrRegionGapBefore,
  resolveOcrRegionLineHeight,
  resolveOcrRegionPadding
} from '../shared/documentOcrLayout.ts'

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

/** PDF 导出依赖。 */
export interface DocumentPdfExportDependencies {
  /** 读取支持 CJK 的字体字节；没有字体时返回 null。 */
  loadFontBytes(): Promise<Uint8Array | null>
  /** 读取文档资源字节；资源不存在时返回 null。 */
  loadAssetBytes(assetId: string): Promise<Uint8Array | null>
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
  /** 导出期间收集的可降级告警。 */
  warnings: DocumentWarning[]
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
  /** 上一个已绘制区块，用于沿用 PDF 原始段间距。 */
  previousBlock?: DocumentBlock
}

/** CJK 字符探测表达式。 */
const CJK_TEXT_PATTERN = /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

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
    } else if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) collectBlockText(cell.blocks, output)
      }
    } else if (block.kind === 'formula') {
      if (block.sourceText) output.push(block.sourceText)
      if (block.latex) output.push(block.latex)
    } else if (block.kind === 'image') {
      for (const region of block.ocrRegions ?? []) {
        if (region.text) output.push(region.text)
        if (region.translatedText) output.push(region.translatedText)
      }
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
    sourceBottom: Math.max(0, firstGeometryTop)
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
  composer.cursor = composer.contentTop
  composer.sourceBottom = composer.contentTop
  return true
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
 * 计算 OCR 译文在图片内的横向边界；左对齐译文延伸到图片右边缘以减少逐字换行。
 * @param imageBox 图片原始边界。
 * @param region OCR 区域。
 * @returns 区域左边界、宽度和内容左边界。
 * @author zhenghq
 */
function ocrRegionHorizontalBounds(
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
  const width = region.textAlign === 'center' || region.textAlign === 'right'
    ? originalWidth
    : Math.max(1, imageBox.x + imageBox.width - left)
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
 * 将 OCR 区域译文绘制到图片对应位置；译文按实际行数扩展并顺延后续区域，避免裁切与覆盖。
 * @param context 绘制上下文。
 * @param imageBox 图片原始边界。
 * @param region OCR 区域。
 * @param regionTop 当前 OCR 区域顶部坐标；前序译文增高后可能大于原始坐标。
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
  composer?: PageComposer,
  document?: PDFDocument
): number {
  const translated = region.translatedText?.trim()
  if (!translated || (region.status !== 'recognized' && region.status !== 'skipped')) return regionTop
  const { left: regionX, width: regionWidth } = ocrRegionHorizontalBounds(imageBox, region)
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
    // 每行先铺纸张底色再写字，避免译文扩展后仍透出原扫描文字。
    context.page.drawRectangle({
      x: regionX,
      y: pdfY(context.page.getHeight(), y, lineHeight),
      width: regionWidth,
      height: lineHeight,
      color: rgb(1, 1, 1),
      opacity: 0.94
    })
    const lineWidth = Math.min(availableWidth, font.widthOfTextAtSize(line, fontSize))
    const lineX = alignedTextX(regionX + padding.x, availableWidth, lineWidth, region.textAlign)
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
 * 按阅读顺序绘制图片内全部 OCR 译文；每个区域使用实际换行高度并顺延后续区域。
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
  let previousRegion: DocumentOcrRegion | undefined
  let bottom = imageBox.y
  for (const region of orderedOcrRegions(block.ocrRegions ?? [])) {
    const translated = region.translatedText?.trim()
    if (!translated || (region.status !== 'recognized' && region.status !== 'skipped')) continue
    const sourceTop = ocrRegionSourceTop(imageBox, region)
    const sourceGap = resolveOcrRegionGapBefore(region, previousRegion, imageBox.height)
    // 首条译文从原 OCR 坐标开始；后续区域只顺延实际译文高度和原文行间空白。
    // 不能再次取 sourceTop，否则前序译文变短时会跳回原区域并留下大段空白。
    const regionTop = previousRegion
      ? bottom + sourceGap
      : Math.max(imageBox.y, sourceTop)
    bottom = drawOcrRegion(context, imageBox, region, regionTop, composer, document)
    previousRegion = region
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
 * 估算表格单元格中文本的实际排版高度，用于让表格行随译文换行增长。
 * @param context 绘制上下文，用于选择字体并测量文本宽度。
 * @param cell 表格单元格。
 * @param cellWidth 单元格宽度。
 * @returns 单元格文本内容所需高度。
 * @author zhenghq
 */
function tableCellContentHeight(
  context: DrawContext,
  cell: DocumentTableCell,
  cellWidth: number
): number {
  let height = 0
  const availableWidth = Math.max(1, cellWidth - 10)
  for (const child of cell.blocks) {
    if (child.kind !== 'text') continue
    for (const run of child.runs) {
      const style = { fontSize: 10, ...child.style, ...run.style }
      const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 10))
      const lineHeight = Math.max(fontSize, style.lineHeight ?? fontSize * 1.35)
      const font = selectFont(context, style)
      const lineCount = wrapText(run.text, font, fontSize, availableWidth).length
      height += lineCount * lineHeight
    }
  }
  return height
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
    for (const run of child.runs) {
      const style = { fontSize: 10, ...child.style, ...run.style }
      const fontSize = Math.max(6, Math.min(72, style.fontSize ?? 10))
      const font = selectFont(context, style)
      for (const line of safeFontText(run.text, font).split('\n')) {
        width = Math.max(width, font.widthOfTextAtSize(line, fontSize))
      }
    }
  }
  return width
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
  for (const row of block.rows) {
    for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
      const cell = row.cells[cellIndex]!
      const span = Math.max(1, Math.min(cell.colSpan, columnCount - cellIndex))
      const naturalWidth = tableCellNaturalWidth(context, cell) + 12
      const perColumnWidth = naturalWidth / span
      for (let offset = 0; offset < span; offset += 1) {
        contentWidths[cellIndex + offset] = Math.max(contentWidths[cellIndex + offset]!, perColumnWidth)
      }
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
    const bytes = await dependencies.loadAssetBytes(assetId)
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
  document?: PDFDocument
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
  return drawOcrRegions(context, block, page, composer, document)
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
  const blockTop = hasGeometry ? Math.max(bbox.y, cursor) : cursor
  const yOffset = blockTop - (composer?.contentTop ?? 0)
  let runTop = blockTop
  let drawnBottom = blockTop
  if (canDrawRunsAsSingleLine(context, block, bbox.width)) {
    if (composer && document) ensurePageSpace(composer, document, context, Math.max(1, bbox.height))
    runTop = composer?.cursor ?? blockTop
    const used = drawTextRunsInLine(context, block, bbox.x, runTop, bbox.width, composer, document)
    drawnBottom = (composer?.cursor ?? runTop + used)
    const bottom = Math.max(drawnBottom, cursor, hasGeometry ? bbox.y + bbox.height : 0)
    if (composer) {
      composer.cursor = bottom + (hasGeometry ? 10 : 12)
      composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
    }
    return composer?.cursor ?? bottom + (hasGeometry ? 10 : 12)
  }
  for (const run of block.runs) {
    const style = resolvedRunStyle(block, run)
    const used = drawTextRun(
      context,
      run,
      bbox.x,
      runTop,
      bbox.width,
      style,
      block.textAlign,
      composer,
      document,
      yOffset
    )
    // 单个 run 跨页时 composer 已指向新页实际游标，后续 run 必须从这里继续，不能沿用旧页坐标。
    runTop = composer?.cursor ?? runTop + used
    drawnBottom = composer?.cursor ?? runTop
  }
  const bottom = Math.max(drawnBottom, cursor, hasGeometry ? bbox.y + bbox.height : 0)
  if (composer) {
    composer.cursor = bottom + (hasGeometry ? 10 : 12)
    composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
  }
  return composer?.cursor ?? bottom + (hasGeometry ? 10 : 12)
}

/**
 * 绘制表格边框、列宽和单元格文本。
 * @param context 绘制上下文。
 * @param block 表格区块。
 * @param page 页面模型。
 * @param cursor 流式排版游标。
 * @param composer 页面排版器；传入后可按实际行高跨页。
 * @param document PDF 文档；传入排版器时必须提供。
 * @returns 新区块游标。
 * @author zhenghq
 */
function drawTableBlock(
  context: DrawContext,
  block: DocumentTableBlock,
  page: DocumentPage,
  cursor: number,
  composer?: PageComposer,
  document?: PDFDocument
): number {
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
  const columnCount = Math.max(1, ...block.rows.map((row) => row.cells.length))
  const widths = adaptiveTableColumnWidths(context, block, columnCount, bbox.width)
  const baseRowHeight = bbox.height / Math.max(1, block.rows.length)
  let currentRowTop = tableTop
  let hasTableText = false
  for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
    let cellX = bbox.x
    const row = block.rows[rowIndex]!
    // 行高必须覆盖最高的单元格；译文换行后不能继续沿用原表格行高。
    let rowHeight = baseRowHeight
    for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
      const cell = row.cells[cellIndex]!
      const cellWidth = widths
        .slice(cellIndex, cellIndex + Math.max(1, cell.colSpan))
        .reduce((sum, value) => sum + value, 0)
      rowHeight = Math.max(rowHeight, tableCellContentHeight(context, cell, cellWidth) + 10)
    }
    if (composer && document) {
      composer.cursor = currentRowTop
      const pageChanged = ensurePageSpace(composer, document, context, rowHeight)
      if (pageChanged) currentRowTop = composer.cursor
    }
    for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
      const cell = row.cells[cellIndex]!
      const cellWidth = widths.slice(cellIndex, cellIndex + Math.max(1, cell.colSpan)).reduce((sum, value) => sum + value, 0)
      const cellY = currentRowTop
      const pageHeight = context.page.getHeight()
      context.page.drawRectangle({
        x: cellX,
        y: pdfY(pageHeight, cellY, rowHeight),
        width: Math.max(1, cellWidth),
        height: Math.max(1, rowHeight),
        borderColor: rgb(0.72, 0.75, 0.79),
        borderWidth: 0.6
      })
      let textTop = cellY + 5
      let hasCellText = false
      for (const child of cell.blocks) {
        if (child.kind === 'text') {
          for (const run of child.runs) {
            // 表格相邻单元格之间补空格，避免复制出的可检索文本丢失词语边界。
            if (hasTableText && !hasCellText && run.text) {
              const spacerWidth = context.regular.widthOfTextAtSize(' ', 10)
              if (spacerWidth > 0 && cellX + 5 + spacerWidth <= cellX + cellWidth - 5) {
                context.page.drawText(' ', {
                  x: cellX + 5,
                  y: pdfY(context.page.getHeight(), textTop, 10),
                  size: 10,
                  font: context.regular,
                  color: rgb(0, 0, 0)
                })
              }
            }
            textTop += drawTextRun(
              context,
              run,
              cellX + 5,
              textTop,
              cellWidth - 10,
              { fontSize: 10 },
              child.textAlign
            )
            if (run.text) {
              hasTableText = true
              hasCellText = true
            }
          }
        }
      }
      cellX += cellWidth
    }
    currentRowTop += rowHeight
    if (composer) composer.cursor = currentRowTop
  }
  const bottom = Math.max(cursor, currentRowTop, tableTop + Math.max(bbox.height, block.rows.length * 28))
  if (composer) {
    composer.cursor = bottom + 10
    composer.sourceBottom = Math.max(composer.sourceBottom, bbox.y + bbox.height)
  }
  return composer?.cursor ?? bottom + 10
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
  document: PDFDocument
): Promise<void> {
  const composer = createPageComposer(document, context, pageModel)
  for (const block of pageModel.blocks) {
    if (block.kind === 'text') {
      composer.cursor = drawTextBlock(context, block, pageModel, composer.cursor, composer, document)
    } else if (block.kind === 'table') {
      composer.cursor = drawTableBlock(context, block, pageModel, composer.cursor, composer, document)
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
        pageModel,
        dependencies,
        composer,
        document
      )
      composer.sourceBottom = Math.max(
        composer.sourceBottom,
        bbox ? bbox.y + bbox.height : composer.cursor
      )
    } else if (block.kind === 'formula') {
      composer.cursor = drawFormulaBlock(context, block, pageModel, composer.cursor, composer, document)
    } else if (block.kind === 'shape' && block.bbox) {
      if (block.bbox.y > composer.cursor) composer.cursor = block.bbox.y
      const shapeTop = ensureGeometryBlockSpace(
        composer,
        document,
        context,
        composer.cursor,
        block.bbox.height,
        block.bbox.y,
        block.bbox.height
      )
      composer.cursor = shapeTop
      if (block.line?.orientation === 'horizontal') {
        const y = pdfY(context.page.getHeight(), shapeTop, 0)
        context.page.drawLine({
          start: { x: block.bbox.x, y },
          end: { x: block.bbox.x + block.bbox.width, y },
          thickness: Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
      } else if (block.line?.orientation === 'vertical') {
        const x = block.bbox.x
        context.page.drawLine({
          start: { x, y: pdfY(context.page.getHeight(), shapeTop, block.bbox.height) },
          end: { x, y: pdfY(context.page.getHeight(), shapeTop, 0) },
          thickness: Math.max(0.5, block.line.thickness ?? 1),
          color: parseColor(block.line.color, [0.8, 0.82, 0.85])
        })
      } else {
        context.page.drawRectangle({
          x: block.bbox.x,
          y: pdfY(context.page.getHeight(), shapeTop, block.bbox.height),
          width: block.bbox.width,
          height: block.bbox.height,
          borderColor: rgb(0.8, 0.82, 0.85),
          borderWidth: 0.5
        })
      }
      composer.cursor = shapeTop + block.bbox.height
      composer.sourceBottom = Math.max(composer.sourceBottom, block.bbox.y + block.bbox.height)
    }
    composer.previousBlock = block
  }
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
  dependencies: DocumentPdfExportDependencies
): Promise<DocumentPdfExportResult> {
  if (!model || !Array.isArray(model.pages) || model.pages.length === 0) {
    throw new DocumentPdfExportError('invalid-document', 'Document has no pages')
  }
  try {
    const document = await PDFDocument.create()
    document.setTitle(model.metadata.title ?? model.source.fileName)
    if (model.metadata.author) document.setAuthor(model.metadata.author)
    const fonts = await resolveFonts(document, model, dependencies)
    const images = new Map<string, PDFImage | null>()
    const warnings: DocumentWarning[] = []
    for (const pageModel of model.pages) {
      const page = createComposedPage(document, pageModel)
      await drawPageBlocks({
        page,
        regular: fonts.regular,
        bold: fonts.bold,
        italic: fonts.italic,
        boldItalic: fonts.boldItalic,
        images,
        warnings
      }, pageModel, dependencies, document)
    }
    return { bytes: await document.save(), warnings }
  } catch (error) {
    if (error instanceof DocumentPdfExportError) throw error
    throw new DocumentPdfExportError('export-failed', 'PDF export failed')
  }
}
