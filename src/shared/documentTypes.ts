/** 当前文档中间模型结构版本；结构不兼容变更时必须递增。 */
export const DOCUMENT_MODEL_SCHEMA_VERSION = 1

/** 首版文档工作台支持的文件格式。 */
export type DocumentFormat =
  | 'pdf'
  | 'docx'
  | 'epub'
  | 'html'
  | 'markdown'
  | 'txt'
  | 'json'
  | 'csv'
  | 'srt'
  | 'vtt'

/** 文档在翻译和导出阶段可以使用的格式能力。 */
export interface DocumentCapabilities {
  /** 是否能够提供页面级绝对版面信息。 */
  nativeLayout: boolean
  /** 是否需要对整页渲染图执行 OCR。 */
  ocrPageImages: boolean
  /** 是否需要识别文档包内嵌图片中的文字。 */
  ocrEmbeddedImages: boolean
  /** 是否能够可靠提取字体、字号、颜色等样式。 */
  preserveStyles: boolean
  /** 是否支持导出 PDF；首版所有支持格式均可导出。 */
  exportPdf: true
}

/** 文档中可定位的矩形区域，坐标单位为 PDF 点或页面像素。 */
export interface DocumentBoundingBox {
  /** 左上角横坐标。 */
  x: number
  /** 左上角纵坐标。 */
  y: number
  /** 区域宽度。 */
  width: number
  /** 区域高度。 */
  height: number
}

/** 文本片段的排版样式；缺失字段表示沿用区块或页面默认值。 */
export interface DocumentTextStyle {
  /** 字体族名称。 */
  fontFamily?: string
  /** 字号，单位为点。 */
  fontSize?: number
  /** 字重，例如 400 或 700。 */
  fontWeight?: number
  /** 文本颜色，使用 CSS 颜色字符串。 */
  color?: string
  /** 背景颜色，使用 CSS 颜色字符串。 */
  backgroundColor?: string
  /** 是否为斜体。 */
  italic?: boolean
  /** 是否带下划线。 */
  underline?: boolean
  /** 是否带删除线。 */
  strikethrough?: boolean
  /** 字间距，单位为点。 */
  letterSpacing?: number
  /** 行高，单位为点。 */
  lineHeight?: number
}

/** 文本块内的样式片段，翻译前后通过 runId 保持对应关系。 */
export interface DocumentTextRun {
  /** 页面内稳定的片段标识。 */
  runId: string
  /** 片段原文。 */
  text: string
  /** 片段排版样式。 */
  style?: DocumentTextStyle
  /** 是否必须原样保留，例如代码、公式或 URL。 */
  protected?: boolean
}

/** 文本块承载的语义角色。 */
export type DocumentTextRole =
  | 'heading'
  | 'subtitle'
  | 'paragraph'
  | 'quote'
  | 'list-item'
  | 'caption'
  | 'code'
  | 'other'

/** 文本对齐方式。 */
export type DocumentTextAlign = 'left' | 'center' | 'right' | 'justify'

/** 页面背景绘制描述。 */
export type DocumentPaint =
  | { kind: 'solid'; color: string }
  | { kind: 'image'; assetId: string; fit?: 'cover' | 'contain' | 'stretch' }

/** 所有文档区块共享的定位与语义字段。 */
export interface DocumentBlockBase {
  /** 页面内稳定的区块标识，不随数组顺序变化。 */
  blockId: string
  /** PDF 视觉同行分组标识；同一组的图片与文字应在横向保持同一基线。 */
  flowGroupId?: string
  /** 文档阅读顺序，从零开始递增。 */
  readingOrder: number
  /** 是否允许把区块文本送入翻译服务。 */
  translatable: boolean
  /** 区块在页面中的位置；流式格式可以省略。 */
  bbox?: DocumentBoundingBox
  /** 原始格式中可恢复的通用样式。 */
  style?: DocumentTextStyle
}

/** 普通文本区块。 */
export interface DocumentTextBlock extends DocumentBlockBase {
  kind: 'text'
  role: DocumentTextRole
  runs: DocumentTextRun[]
  /** PDF 代码区域的原始外框；译文代码块据此保持原横向范围和主题边框。 */
  codeFrame?: DocumentBoundingBox
  textAlign?: DocumentTextAlign
  language?: string
  /** PDF 目录项元数据；存在时页码与引导点应独立排版。 */
  toc?: {
    /** 目录页码；必须原样保留，不参与翻译。 */
    pageNumber: string
  }
  /** 字幕时间轴；仅字幕格式使用，不属于可翻译正文。 */
  timing?: string
  /** 字幕序号；仅字幕格式使用，不属于可翻译正文。 */
  sequence?: number
}

/** 表格单元格；单元格可继续承载文本、图片等区块。 */
export interface DocumentTableCell {
  /** 单元格稳定标识。 */
  cellId: string
  /** 向下合并的行数。 */
  rowSpan: number
  /** 向右合并的列数。 */
  colSpan: number
  /** 单元格内容区块。 */
  blocks: DocumentBlock[]
}

/** 表格行。 */
export interface DocumentTableRow {
  /** 行稳定标识。 */
  rowId: string
  /** 当前行中的单元格。 */
  cells: DocumentTableCell[]
}

/** 表格区块。 */
export interface DocumentTableBlock extends DocumentBlockBase {
  kind: 'table'
  rows: DocumentTableRow[]
  columnWidths?: number[]
  headerRows?: number
}

/** 图片 OCR 区域，保留识别文本与置信度以便局部重试。 */
export interface DocumentOcrRegion {
  /** 区域稳定标识。 */
  regionId: string
  /** 相对图片左上角的归一化坐标，x、y、width、height 均在 0 到 1 之间。 */
  bbox: DocumentBoundingBox
  /** OCR 原文。 */
  text: string
  /** OCR 原文的字体、字号与颜色等样式。 */
  style?: DocumentTextStyle
  /** OCR 原文在图片区域内的对齐方式。 */
  textAlign?: DocumentTextAlign
  /** 0 到 1 的置信度；引擎不提供时省略。 */
  confidence?: number
  /** 识别状态。 */
  status: 'pending' | 'recognized' | 'failed' | 'skipped'
  /** 失败或跳过的脱敏原因。 */
  reason?: string
  /** OCR 原文对应的译文；翻译失败时省略并保留原文。 */
  translatedText?: string
}

/** 图片区块。 */
export interface DocumentImageBlock extends DocumentBlockBase {
  kind: 'image'
  assetId: string
  alt?: string
  ocrRegions?: DocumentOcrRegion[]
  /** 扫描页尚未完成本机栅格化时为 true，OCR 阶段必须先补齐资源。 */
  renderPending?: boolean
}

/** 公式区块；首版默认不翻译，优先保留原图或 LaTeX/MathML 表达。 */
export interface DocumentFormulaBlock extends DocumentBlockBase {
  kind: 'formula'
  latex?: string
  mathml?: string
  assetId?: string
  sourceText?: string
}

/** 可从原始文档恢复的直线装饰；坐标由区块 bbox 描述。 */
export interface DocumentLineStyle {
  /** 直线方向；水平线绘制在 bbox 顶部，垂直线绘制在 bbox 左侧。 */
  orientation: 'horizontal' | 'vertical'
  /** CSS 颜色字符串。 */
  color?: string
  /** 线宽，单位为 PDF 点。 */
  thickness?: number
}

/** 形状或矢量装饰区块；无法重建时以资源方式保留。 */
export interface DocumentShapeBlock extends DocumentBlockBase {
  kind: 'shape'
  assetId?: string
  vectorPath?: string
  label?: string
  line?: DocumentLineStyle
}

/** 显式分页、分栏或分节标记。 */
export interface DocumentBreakBlock extends DocumentBlockBase {
  kind: 'break'
  breakType: 'page' | 'column' | 'section'
}

/** 统一文档区块联合类型。 */
export type DocumentBlock =
  | DocumentTextBlock
  | DocumentTableBlock
  | DocumentImageBlock
  | DocumentFormulaBlock
  | DocumentShapeBlock
  | DocumentBreakBlock

/** 文档页面或流式章节。 */
export interface DocumentPage {
  /** 页面稳定标识。 */
  pageId: string
  /** 从零开始的页面或章节索引。 */
  index: number
  /** 页面宽度；流式格式使用归一化宽度。 */
  width: number
  /** 页面高度；流式格式使用估算高度。 */
  height: number
  /** 页面标题，用于章节导航。 */
  title?: string
  /** 页面背景。 */
  background?: DocumentPaint
  /** 从 PDF 推断出的正文内容区；用于译文复用原文左右页边距。 */
  contentArea?: DocumentContentArea
  /** 页面内按阅读顺序排列的区块。 */
  blocks: DocumentBlock[]
}

/** PDF 正文内容区边界；坐标单位为原始 PDF 点。 */
export interface DocumentContentArea {
  /** 正文区左边界。 */
  left: number
  /** 正文区右边界。 */
  right: number
  /** 正文区水平中心线。 */
  center: number
}

/** 文档内可复用的图片、字体或其他二进制资源。 */
export interface DocumentAsset {
  /** 资源稳定标识。 */
  assetId: string
  /** 资源种类。 */
  kind: 'image' | 'font' | 'file'
  /** 资源 MIME 类型。 */
  mimeType?: string
  /** 资源内容哈希。 */
  sha256: string
  /** 资源字节数。 */
  byteLength: number
  /** 图片像素宽度。 */
  width?: number
  /** 图片像素高度。 */
  height?: number
  /** 资源在本机临时目录中的相对标识，不进入日志。 */
  storageKey?: string
}

/** 文档元数据。 */
export interface DocumentMetadata {
  /** 文档标题。 */
  title?: string
  /** 文档作者。 */
  author?: string
  /** 主要文字方向。 */
  direction: 'ltr' | 'rtl' | 'auto'
  /** 原始文档声明的语言。 */
  language?: string
}

/** 文档源文件描述。 */
export interface DocumentSource {
  /** 用户选择的本地绝对路径；不得写入普通日志。 */
  path: string
  /** 面向界面的文件名。 */
  fileName: string
  /** 探测后的格式。 */
  format: DocumentFormat
  /** 文件内容 SHA-256。 */
  sha256: string
  /** 文件字节数。 */
  size: number
  /** PDF 等分页格式的页数。 */
  pageCount?: number
}

/** 文档告警级别。 */
export type DocumentWarningSeverity = 'info' | 'warning' | 'error'

/** 解析、OCR 或导出阶段的可展示告警。 */
export interface DocumentWarning {
  /** 告警分类。 */
  code: string
  /** 告警级别。 */
  severity: DocumentWarningSeverity
  /** 解析器提供的英文兜底说明；界面优先按 code 本地化。 */
  message: string
  /** 关联页面。 */
  pageId?: string
  /** 关联区块。 */
  blockId?: string
}

/** 解析、翻译与导出共用的统一文档模型。 */
export interface DocumentModel {
  /** 中间模型结构版本。 */
  schemaVersion: number
  /** 当前任务内的文档标识。 */
  documentId: string
  /** 源文件描述。 */
  source: DocumentSource
  /** 文档元数据。 */
  metadata: DocumentMetadata
  /** 页面或流式章节。 */
  pages: DocumentPage[]
  /** 文档资源索引。 */
  assets: DocumentAsset[]
  /** 解析阶段产生的告警。 */
  warnings: DocumentWarning[]
}

/** 文档任务整体状态。 */
export type DocumentTaskStatus =
  | 'idle'
  | 'validating'
  | 'parsing'
  | 'ocr'
  | 'translating'
  | 'rendering'
  | 'exporting'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed'

/** 文档任务阶段，供进度聚合和恢复使用。 */
export type DocumentTaskPhase =
  | 'validate'
  | 'parse'
  | 'ocr'
  | 'translate'
  | 'layout'
  | 'export'

/**
 * 计算稳定的短哈希，避免在共享层依赖 Node.js crypto，便于 Renderer 与 worker 复用。
 * @param value 参与哈希的稳定字符串。
 * @returns 16 位小写十六进制哈希。
 * @author zhenghq
 */
function stableShortHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
  }
  return (first >>> 0).toString(16).padStart(8, '0') +
    (second >>> 0).toString(16).padStart(8, '0')
}

/**
 * 根据文件内容哈希和页索引生成稳定页面标识。
 * @param documentFingerprint 文件内容哈希或等价稳定指纹。
 * @param pageIndex 从零开始的页面索引。
 * @returns 页面稳定标识。
 * @author zhenghq
 */
export function createDocumentPageId(documentFingerprint: string, pageIndex: number): string {
  return `page-${stableShortHash(`${documentFingerprint}\u0000${pageIndex}`).slice(0, 12)}`
}

/**
 * 根据文档、页面、顺序和区块种类生成稳定区块标识。
 * @param documentFingerprint 文件内容哈希或等价稳定指纹。
 * @param pageId 页面稳定标识。
 * @param readingOrder 页面内阅读顺序。
 * @param kind 区块种类。
 * @returns 区块稳定标识。
 * @author zhenghq
 */
export function createDocumentBlockId(
  documentFingerprint: string,
  pageId: string,
  readingOrder: number,
  kind: DocumentBlock['kind']
): string {
  return `block-${stableShortHash(`${documentFingerprint}\u0000${pageId}\u0000${readingOrder}\u0000${kind}`).slice(0, 12)}`
}

/**
 * 判断未知值是否为普通对象。
 * @param value 待判断值。
 * @returns 是否为非数组对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验字段为非空字符串。
 * @param value 待校验值。
 * @param field 用于错误信息的字段路径。
 * @returns 无返回值，失败时抛出异常。
 * @author zhenghq
 */
function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`document ${field} must be a non-empty string`)
  }
}

/**
 * 校验字段为有限数值。
 * @param value 待校验值。
 * @param field 用于错误信息的字段路径。
 * @param allowZero 是否允许零值。
 * @returns 无返回值，失败时抛出异常。
 * @author zhenghq
 */
function assertFiniteNumber(value: unknown, field: string, allowZero = true): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!allowZero && value <= 0)) {
    throw new Error(`document ${field} must be a finite number`)
  }
}

/**
 * 校验可选矩形区域结构。
 * @param value 待校验值。
 * @param field 用于错误信息的字段路径。
 * @returns 无返回值，失败时抛出异常。
 * @author zhenghq
 */
function assertBoundingBox(value: unknown, field: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error(`document ${field} must be an object`)
  assertFiniteNumber(value.x, `${field}.x`)
  assertFiniteNumber(value.y, `${field}.y`)
  assertFiniteNumber(value.width, `${field}.width`, false)
  assertFiniteNumber(value.height, `${field}.height`, false)
}

/**
 * 校验文本片段数组。
 * @param value 待校验值。
 * @param field 用于错误信息的字段路径。
 * @returns 无返回值，失败时抛出异常。
 * @author zhenghq
 */
function assertTextRuns(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`document ${field} must be an array`)
  value.forEach((run, index) => {
    if (!isRecord(run)) throw new Error(`document ${field}[${index}] must be an object`)
    assertNonEmptyString(run.runId, `${field}[${index}].runId`)
    if (typeof run.text !== 'string') throw new Error(`document ${field}[${index}].text must be a string`)
  })
}

/**
 * 递归校验单个文档区块结构。
 * @param value 待校验值。
 * @param field 用于错误信息的字段路径。
 * @returns 无返回值，失败时抛出异常。
 * @author zhenghq
 */
function assertDocumentBlock(value: unknown, field: string): void {
  if (!isRecord(value)) throw new Error(`document ${field} must be a block object`)
  const validKinds = new Set(['text', 'table', 'image', 'formula', 'shape', 'break'])
  if (typeof value.kind !== 'string' || !validKinds.has(value.kind)) {
    throw new Error(`document ${field}.kind is not a supported block kind`)
  }
  assertNonEmptyString(value.blockId, `${field}.blockId`)
  if (value.flowGroupId !== undefined) {
    assertNonEmptyString(value.flowGroupId, `${field}.flowGroupId`)
  }
  assertFiniteNumber(value.readingOrder, `${field}.readingOrder`)
  if (typeof value.translatable !== 'boolean') {
    throw new Error(`document ${field}.translatable must be a boolean`)
  }
  assertBoundingBox(value.bbox, `${field}.bbox`)

  if (value.kind === 'text') {
    assertTextRuns(value.runs, `${field}.runs`)
    if (value.codeFrame !== undefined) {
      assertBoundingBox(value.codeFrame, `${field}.codeFrame`)
    }
    if (value.toc !== undefined) {
      if (!isRecord(value.toc)) throw new Error(`document ${field}.toc must be an object`)
      assertNonEmptyString(value.toc.pageNumber, `${field}.toc.pageNumber`)
    }
  }
  if (value.kind === 'table') {
    if (!Array.isArray(value.rows)) throw new Error(`document ${field}.rows must be an array`)
    value.rows.forEach((row, rowIndex) => {
      if (!isRecord(row)) throw new Error(`document ${field}.rows[${rowIndex}] must be an object`)
      assertNonEmptyString(row.rowId, `${field}.rows[${rowIndex}].rowId`)
      if (!Array.isArray(row.cells)) throw new Error(`document ${field}.rows[${rowIndex}].cells must be an array`)
      row.cells.forEach((cell, cellIndex) => {
        if (!isRecord(cell)) throw new Error(`document ${field}.rows[${rowIndex}].cells[${cellIndex}] must be an object`)
        assertNonEmptyString(cell.cellId, `${field}.rows[${rowIndex}].cells[${cellIndex}].cellId`)
        if (!Array.isArray(cell.blocks)) {
          throw new Error(`document ${field}.rows[${rowIndex}].cells[${cellIndex}].blocks must be an array`)
        }
        cell.blocks.forEach((block, blockIndex) => assertDocumentBlock(
          block,
          `${field}.rows[${rowIndex}].cells[${cellIndex}].blocks[${blockIndex}]`
        ))
      })
    })
  }
  if (value.kind === 'image') assertNonEmptyString(value.assetId, `${field}.assetId`)
  if (value.kind === 'shape' && value.line !== undefined) {
    if (!isRecord(value.line)) throw new Error(`document ${field}.line must be an object`)
    if (!['horizontal', 'vertical'].includes(String(value.line.orientation))) {
      throw new Error(`document ${field}.line.orientation is not supported`)
    }
    if (value.line.color !== undefined && typeof value.line.color !== 'string') {
      throw new Error(`document ${field}.line.color must be a string`)
    }
    if (value.line.thickness !== undefined) {
      assertFiniteNumber(value.line.thickness, `${field}.line.thickness`, false)
    }
  }
  if (value.kind === 'break' && !['page', 'column', 'section'].includes(String(value.breakType))) {
    throw new Error(`document ${field}.breakType is not supported`)
  }
}

/**
 * 解析并校验未知值是否为当前版本的文档模型。
 * @param value 来自 JSON、IPC 或缓存的未知值。
 * @returns 通过结构校验的文档模型。
 * @author zhenghq
 */
export function parseDocumentModel(value: unknown): DocumentModel {
  if (!isRecord(value)) throw new Error('document model must be an object')
  if (value.schemaVersion !== DOCUMENT_MODEL_SCHEMA_VERSION) {
    throw new Error(`document schema version ${String(value.schemaVersion)} is not supported`)
  }
  assertNonEmptyString(value.documentId, 'documentId')
  if (!isRecord(value.source)) throw new Error('document source must be an object')
  assertNonEmptyString(value.source.path, 'source.path')
  assertNonEmptyString(value.source.fileName, 'source.fileName')
  assertNonEmptyString(value.source.sha256, 'source.sha256')
  assertFiniteNumber(value.source.size, 'source.size')
  if (!Array.isArray(value.pages)) throw new Error('document pages must be an array')
  value.pages.forEach((page, pageIndex) => {
    if (!isRecord(page)) throw new Error(`document pages[${pageIndex}] must be an object`)
    assertNonEmptyString(page.pageId, `pages[${pageIndex}].pageId`)
    assertFiniteNumber(page.index, `pages[${pageIndex}].index`)
    assertFiniteNumber(page.width, `pages[${pageIndex}].width`, false)
    assertFiniteNumber(page.height, `pages[${pageIndex}].height`, false)
    if (page.contentArea !== undefined) {
      if (!isRecord(page.contentArea)) {
        throw new Error(`document pages[${pageIndex}].contentArea must be an object`)
      }
      assertFiniteNumber(page.contentArea.left, `pages[${pageIndex}].contentArea.left`)
      assertFiniteNumber(page.contentArea.right, `pages[${pageIndex}].contentArea.right`)
      assertFiniteNumber(page.contentArea.center, `pages[${pageIndex}].contentArea.center`)
      if (page.contentArea.right <= page.contentArea.left) {
        throw new Error(`document pages[${pageIndex}].contentArea.right must be greater than left`)
      }
    }
    if (!Array.isArray(page.blocks)) throw new Error(`document pages[${pageIndex}].blocks must be an array`)
    page.blocks.forEach((block, blockIndex) => assertDocumentBlock(
      block,
      `pages[${pageIndex}].blocks[${blockIndex}]`
    ))
  })
  if (!Array.isArray(value.assets)) throw new Error('document assets must be an array')
  if (!Array.isArray(value.warnings)) throw new Error('document warnings must be an array')
  return value as unknown as DocumentModel
}

/**
 * 校验并序列化文档模型，确保缓存与 IPC 中不会写入损坏结构。
 * @param model 待序列化文档模型。
 * @returns JSON 字符串。
 * @author zhenghq
 */
export function serializeDocumentModel(model: DocumentModel): string {
  return JSON.stringify(parseDocumentModel(model))
}
