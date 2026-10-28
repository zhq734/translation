import { XMLParser } from 'fast-xml-parser'
import type {
  DocumentAsset,
  DocumentBlock,
  DocumentFormulaBlock,
  DocumentImageBlock,
  DocumentModel,
  DocumentTableBlock,
  DocumentTableCell,
  DocumentTableRow,
  DocumentTextAlign,
  DocumentTextBlock,
  DocumentTextRole,
  DocumentTextRun,
  DocumentTextStyle
} from '../shared/documentTypes.ts'
import { createDocumentBlockId, createDocumentPageId } from '../shared/documentTypes.ts'
import {
  DOCUMENT_MAX_IMAGES,
  createDocumentModel,
  createDocumentWarning,
  createTableCellId,
  createTableRowId,
  createTextRunId,
  decodeHtmlEntities,
  hashDocumentBytes,
  limitDocumentBlocks,
  sanitizeDocumentText,
  type DocumentParseInput
} from './documentParserShared.ts'
import {
  imageMimeTypeFromPath,
  loadSafeDocumentPackage,
  packageDirectory,
  readPackageBytes,
  readPackageText,
  resolvePackagePath,
  type SafeDocumentPackage
} from './documentPackageShared.ts'

/** preserveOrder 模式下带属性的 XML 节点。 */
type OrderedNode = Record<string, unknown>

/** DOCX 关系项。 */
interface DocxRelationship {
  /** 关系标识。 */
  id: string
  /** 关系类型。 */
  type: string
  /** 关系目标。 */
  target: string
}

/** DOCX 解析上下文。 */
interface DocxContext {
  /** 解析输入。 */
  input: DocumentParseInput
  /** 文档模型。 */
  model: DocumentModel
  /** 图片关系。 */
  relationships: Map<string, DocxRelationship>
  /** 已读取资源。 */
  assets: Map<string, DocumentAsset>
  /** 资源字节。 */
  assetBytes: Map<string, Uint8Array>
  /** 当前页面区块。 */
  blocks: DocumentBlock[]
  /** 已校验的 DOCX 文档包，用于读取图片资源。 */
  package: SafeDocumentPackage
}

/** XML 解析器配置；保留节点顺序用于稳定阅读顺序。 */
const XML_OPTIONS = {
  ignoreAttributes: false,
  preserveOrder: true,
  removeNSPrefix: true,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  maxNestedTags: 100
} as const

/**
 * 判断未知值是否为普通对象。
 * @param value 待判断值。
 * @returns 是否为普通对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 获取 preserveOrder 节点中除属性和文本外的标签名。
 * @param node 有序节点。
 * @returns 标签名；纯文本节点返回 null。
 * @author zhenghq
 */
function tagNameOf(node: OrderedNode): string | null {
  return Object.keys(node).find((key) => key !== ':@' && key !== '#text') ?? null
}

/**
 * 获取有序节点的子节点数组。
 * @param node 有序节点。
 * @param tagName 标签名；省略时使用节点自身标签。
 * @returns 子节点数组。
 * @author zhenghq
 */
function childrenOf(node: OrderedNode, tagName?: string): OrderedNode[] {
  const name = tagName ?? tagNameOf(node)
  if (!name) return []
  const children = node[name]
  return Array.isArray(children) ? children.filter(isRecord) : []
}

/**
 * 获取有序节点的属性。
 * @param node 有序节点。
 * @returns 属性对象。
 * @author zhenghq
 */
function attributesOf(node: OrderedNode): Record<string, string> {
  const attributes = node[':@']
  if (!isRecord(attributes)) return {}
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)]))
}

/**
 * 递归查找第一个指定标签。
 * @param nodes 有序节点数组。
 * @param name 标签名。
 * @returns 匹配节点；不存在时返回 null。
 * @author zhenghq
 */
function findFirstTag(nodes: OrderedNode[], name: string): OrderedNode | null {
  for (const node of nodes) {
    const tag = tagNameOf(node)
    if (tag === name) return node
    if (tag) {
      const found = findFirstTag(childrenOf(node, tag), name)
      if (found) return found
    }
  }
  return null
}

/**
 * 递归查找所有指定标签。
 * @param nodes 有序节点数组。
 * @param name 标签名。
 * @returns 匹配节点数组。
 * @author zhenghq
 */
function findAllTags(nodes: OrderedNode[], name: string): OrderedNode[] {
  const result: OrderedNode[] = []
  for (const node of nodes) {
    const tag = tagNameOf(node)
    if (tag === name) result.push(node)
    if (tag) result.push(...findAllTags(childrenOf(node, tag), name))
  }
  return result
}

/**
 * 读取有序节点的直接文本内容。
 * @param node 有序节点。
 * @returns 文本内容。
 * @author zhenghq
 */
function nodeText(node: OrderedNode): string {
  return childrenOf(node).map((child) => {
    if (typeof child['#text'] === 'string') return child['#text']
    const tag = tagNameOf(child)
    return tag ? nodeText(child) : ''
  }).join('')
}

/**
 * 提取 `w:t` 文本，并保留制表符与换行。
 * @param nodes 当前节点的有序子节点。
 * @returns 文本内容。
 * @author zhenghq
 */
function textOfRuns(nodes: OrderedNode[]): string {
  let result = ''
  for (const node of nodes) {
    const tag = tagNameOf(node)
    if (tag === 't') {
      result += nodeText(node)
    } else if (tag === 'tab') {
      result += '\t'
    } else if (tag === 'br' || tag === 'cr') {
      result += '\n'
    } else if (tag) {
      result += textOfRuns(childrenOf(node, tag))
    }
  }
  return result
}

/**
 * 将 OOXML 半磅字号转换为点。
 * @param value 半磅字号文本。
 * @returns 点字号；非法值返回 undefined。
 * @author zhenghq
 */
function halfPointsToPoints(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 2 : undefined
}

/**
 * 将 OOXML 颜色值转换为 CSS 颜色。
 * @param value 六位或自动颜色值。
 * @returns CSS 颜色；auto 或非法值返回 undefined。
 * @author zhenghq
 */
function wordColor(value: string | undefined): string | undefined {
  if (!value || value.toLowerCase() === 'auto') return undefined
  return /^[0-9a-f]{6}$/iu.test(value) ? `#${value}` : undefined
}

/**
 * 从 run 属性解析字体、字号、粗体、斜体、下划线、删除线和颜色。
 * @param runNode `w:r` 有序节点。
 * @returns 文本样式；无可用样式时返回 undefined。
 * @author zhenghq
 */
function runStyle(runNode: OrderedNode): DocumentTextStyle | undefined {
  const runProperties = findFirstTag(childrenOf(runNode), 'rPr')
  if (!runProperties) return undefined
  const children = childrenOf(runProperties)
  const style: DocumentTextStyle = {}
  const font = findFirstTag(children, 'rFonts')
  const fontAttributes = font ? attributesOf(font) : {}
  const fontFamily = fontAttributes['ascii'] ?? fontAttributes['hAnsi'] ?? fontAttributes['eastAsia']
  if (fontFamily) style.fontFamily = fontFamily
  const size = findFirstTag(children, 'sz')
  const fontSize = halfPointsToPoints(size ? attributesOf(size)['val'] : undefined)
  if (fontSize) style.fontSize = fontSize
  if (findFirstTag(children, 'b')) style.fontWeight = 700
  if (findFirstTag(children, 'i')) style.italic = true
  if (findFirstTag(children, 'u')) style.underline = true
  if (findFirstTag(children, 'strike') || findFirstTag(children, 'dstrike')) style.strikethrough = true
  const color = findFirstTag(children, 'color')
  const colorValue = color ? wordColor(attributesOf(color)['val']) : undefined
  if (colorValue) style.color = colorValue
  return Object.keys(style).length > 0 ? style : undefined
}

/**
 * 根据段落样式名推断语义角色。
 * @param styleName 段落样式名。
 * @returns 语义角色。
 * @author zhenghq
 */
function paragraphRole(styleName: string | undefined): DocumentTextRole {
  const normalized = styleName?.toLowerCase() ?? ''
  if (/heading|标题/u.test(normalized)) return 'heading'
  if (/subtitle|副标题/u.test(normalized)) return 'subtitle'
  if (/list|列表/u.test(normalized)) return 'list-item'
  if (/caption|题注/u.test(normalized)) return 'caption'
  return 'paragraph'
}

/**
 * 从段落属性解析对齐方式。
 * @param paragraphNode `w:p` 有序节点。
 * @returns 对齐方式。
 * @author zhenghq
 */
function paragraphAlignment(paragraphNode: OrderedNode): DocumentTextAlign | undefined {
  const paragraphProperties = findFirstTag(childrenOf(paragraphNode), 'pPr')
  const justification = paragraphProperties
    ? findFirstTag(childrenOf(paragraphProperties), 'jc')
    : null
  const value = justification ? attributesOf(justification)['val'] : undefined
  if (value === 'center' || value === 'right' || value === 'both' || value === 'distribute') {
    return value === 'both' || value === 'distribute' ? 'justify' : value
  }
  return value === 'left' ? 'left' : undefined
}

/**
 * 判断段落是否包含显式分页。
 * @param paragraphNode `w:p` 有序节点。
 * @returns 是否包含分页符。
 * @author zhenghq
 */
function paragraphHasPageBreak(paragraphNode: OrderedNode): boolean {
  const breaks = findAllTags(childrenOf(paragraphNode), 'br')
  return breaks.some((node) => attributesOf(node)['type'] === 'page') ||
    findFirstTag(childrenOf(paragraphNode), 'lastRenderedPageBreak') !== null
}

/**
 * 提取段落中的普通文本 run，跳过公式和图片内部文本。
 * @param paragraphNode `w:p` 有序节点。
 * @returns 文本片段。
 * @author zhenghq
 */
function paragraphRuns(paragraphNode: OrderedNode): Array<Omit<DocumentTextRun, 'runId'>> {
  const runs: Array<Omit<DocumentTextRun, 'runId'>> = []
  for (const child of childrenOf(paragraphNode)) {
    const tag = tagNameOf(child)
    if (tag !== 'r') continue
    if (findFirstTag(childrenOf(child), 'oMath')) continue
    const text = textOfRuns(childrenOf(child))
    if (text.length === 0) continue
    const style = runStyle(child)
    runs.push({ text: sanitizeDocumentText(text), ...(style ? { style } : {}) })
  }
  return runs
}

/**
 * 提取段落内的 OMML 公式文本。
 * @param paragraphNode `w:p` 有序节点。
 * @returns 公式节点数组。
 * @author zhenghq
 */
function paragraphFormulas(paragraphNode: OrderedNode): OrderedNode[] {
  return findAllTags(childrenOf(paragraphNode), 'oMath')
}

/**
 * 提取段落内的图片关系标识。
 * @param paragraphNode `w:p` 有序节点。
 * @returns 关系标识数组。
 * @author zhenghq
 */
function paragraphImageRelationshipIds(paragraphNode: OrderedNode): string[] {
  const blips = findAllTags(childrenOf(paragraphNode), 'blip')
  return blips.map((blip) => attributesOf(blip)['embed']).filter((value): value is string => Boolean(value))
}

/**
 * 解析 DOCX 关系文件。
 * @param xml 关系 XML。
 * @returns 关系映射。
 * @author zhenghq
 */
function parseRelationships(xml: string): Map<string, DocxRelationship> {
  const parser = new XMLParser(XML_OPTIONS)
  const parsed = parser.parse(xml) as OrderedNode[]
  const relationships = new Map<string, DocxRelationship>()
  for (const node of findAllTags(parsed, 'Relationship')) {
    const attributes = attributesOf(node)
    if (!attributes['Id'] || !attributes['Target']) continue
    relationships.set(attributes['Id'], {
      id: attributes['Id'],
      type: attributes['Type'] ?? '',
      target: attributes['Target']
    })
  }
  return relationships
}

/**
 * 读取并登记 DOCX 图片资源。
 * @param context 解析上下文。
 * @param relationshipId 图片关系标识。
 * @returns 资源标识；关系不存在时返回 null。
 * @author zhenghq
 */
async function ensureDocxImageAsset(
  context: DocxContext,
  relationshipId: string
): Promise<string | null> {
  const relationship = context.relationships.get(relationshipId)
  if (!relationship || !relationship.type.toLowerCase().includes('/image')) return null
  const path = resolvePackagePath(packageDirectory('word/document.xml'), relationship.target)
  if (!path) return null
  const existing = context.assets.get(path)
  if (existing) return existing.assetId
  if (context.assets.size >= DOCUMENT_MAX_IMAGES) {
    if (!context.model.warnings.some((warning) => warning.code === 'image-limit-reached')) {
      context.model.warnings.push(createDocumentWarning('image-limit-reached', 'The document image limit was reached; remaining images were skipped.'))
    }
    return null
  }
  const bytes = await readPackageBytes(context.package, path)
  if (!bytes) return null
  const sha256 = hashDocumentBytes(bytes)
  const asset: DocumentAsset = {
    assetId: `asset-${sha256.slice(0, 16)}`,
    kind: 'image',
    mimeType: imageMimeTypeFromPath(path),
    sha256,
    byteLength: bytes.byteLength,
    storageKey: path
  }
  context.assets.set(path, asset)
  context.assetBytes.set(asset.assetId, bytes)
  context.model.assets.push(asset)
  return asset.assetId
}

/**
 * 解析 DOCX 表格为统一表格区块。
 * @param tableNode `w:tbl` 有序节点。
 * @param context 解析上下文。
 * @returns 表格区块。
 * @author zhenghq
 */
async function parseDocxTable(tableNode: OrderedNode, context: DocxContext): Promise<DocumentTableBlock> {
  const tableIndex = context.blocks.length
  const pageId = context.model.pages[context.model.pages.length - 1]!.pageId
  const blockId = createDocumentBlockId(context.input.sha256, pageId, tableIndex, 'table')
  const rowNodes = childrenOf(tableNode).filter((node) => tagNameOf(node) === 'tr')
  const rows: DocumentTableRow[] = []
  for (let rowIndex = 0; rowIndex < rowNodes.length; rowIndex += 1) {
    const rowNode = rowNodes[rowIndex]!
    const cellNodes = childrenOf(rowNode).filter((node) => tagNameOf(node) === 'tc')
    const cells: DocumentTableCell[] = []
    for (let cellIndex = 0; cellIndex < cellNodes.length; cellIndex += 1) {
      const cellNode = cellNodes[cellIndex]!
      const cellProperties = findFirstTag(childrenOf(cellNode), 'tcPr')
      const gridSpan = cellProperties ? findFirstTag(childrenOf(cellProperties), 'gridSpan') : null
      const verticalMerge = cellProperties ? findFirstTag(childrenOf(cellProperties), 'vMerge') : null
      const verticalMergeValue = verticalMerge ? attributesOf(verticalMerge)['val'] : undefined
      const blocks: DocumentBlock[] = []
      for (const paragraphNode of childrenOf(cellNode).filter((node) => tagNameOf(node) === 'p')) {
        const text = textOfRuns(childrenOf(paragraphNode)).trim()
        if (!text) continue
        const paragraphBlock = createTextBlockFromRuns(
          context,
          pageId,
          tableIndex + rowIndex * 1000 + cellIndex * 100 + blocks.length,
          paragraphRuns(paragraphNode),
          paragraphRole(undefined)
        )
        blocks.push(paragraphBlock)
      }
      cells.push({
        cellId: createTableCellId(context.input.sha256, pageId, blockId, rowIndex, cellIndex),
        rowSpan: verticalMerge ? 2 : 1,
        colSpan: Math.max(1, Number(gridSpan ? attributesOf(gridSpan)['val'] : 1) || 1),
        blocks
      })
      if (verticalMergeValue === 'restart') {
        cells[cells.length - 1]!.rowSpan = 2
      }
    }
    rows.push({ rowId: createTableRowId(blockId, rowIndex), cells })
  }
  return {
    kind: 'table',
    blockId,
    readingOrder: tableIndex,
    translatable: true,
    rows,
    headerRows: 1
  }
}

/**
 * 从 DOCX run 创建文本块。
 * @param context 解析上下文。
 * @param pageId 页面标识。
 * @param readingOrder 阅读顺序。
 * @param runs run 数组。
 * @param role 语义角色。
 * @returns 文本块。
 * @author zhenghq
 */
function createTextBlockFromRuns(
  context: DocxContext,
  pageId: string,
  readingOrder: number,
  runs: Array<Omit<DocumentTextRun, 'runId'>>,
  role: DocumentTextRole
): DocumentTextBlock {
  const blockId = createDocumentBlockId(context.input.sha256, pageId, readingOrder, 'text')
  const normalizedRuns = runs.map((run, index) => ({
    ...run,
    runId: createTextRunId(blockId, index)
  }))
  return {
    kind: 'text',
    blockId,
    readingOrder,
    translatable: normalizedRuns.some((run) => run.text.trim().length > 0 && run.protected !== true),
    role,
    runs: normalizedRuns
  }
}

/**
 * 解析 DOCX 文档；保留段落、样式、表格、图片关系、OMML 公式和显式分页。
 * @param input 解析输入。
 * @returns DOCX 文档模型。
 * @author zhenghq
 */
export async function parseDocxDocument(input: DocumentParseInput): Promise<DocumentModel> {
  const packageInfo = await loadSafeDocumentPackage(input)
  const documentXml = await readPackageText(packageInfo, 'word/document.xml')
  if (!documentXml) throw new Error('document package is missing word/document.xml')
  const relationshipXml = await readPackageText(packageInfo, 'word/_rels/document.xml.rels')
  const parser = new XMLParser(XML_OPTIONS)
  const parsed = parser.parse(documentXml) as OrderedNode[]
  const body = findFirstTag(parsed, 'body')
  if (!body) throw new Error('document package is missing document body')
  const model = createDocumentModel(input)
  model.warnings.push(...packageInfo.warnings)
  const context: DocxContext = {
    input,
    model,
    relationships: relationshipXml ? parseRelationships(relationshipXml) : new Map(),
    assets: new Map(),
    assetBytes: new Map(),
    blocks: [],
    package: packageInfo
  }

  /**
   * 把当前累计区块写入页面，并开启新页面。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flushPage = (): void => {
    if (context.blocks.length === 0) return
    if (model.pages.length >= 2000) {
      model.warnings.push(createDocumentWarning('page-limit-reached', 'The document page limit was reached; remaining pages were skipped.'))
      return
    }
    const page = model.pages[model.pages.length - 1]!
    page.blocks = limitDocumentBlocks(context.blocks, model.warnings)
    context.blocks = []
    model.pages.push({
      pageId: createDocumentPageId(input.sha256, model.pages.length),
      index: model.pages.length,
      width: page.width,
      height: page.height,
      blocks: []
    })
  }

  for (const child of childrenOf(body)) {
    const tag = tagNameOf(child)
    if (tag === 'p') {
      const paragraphProperties = findFirstTag(childrenOf(child), 'pPr')
      const styleNode = paragraphProperties ? findFirstTag(childrenOf(paragraphProperties), 'pStyle') : null
      const styleName = styleNode ? attributesOf(styleNode)['val'] : undefined
      const runs = paragraphRuns(child)
      const formulas = paragraphFormulas(child)
      const imageIds = paragraphImageRelationshipIds(child)
      const text = runs.map((run) => run.text).join('')
      if (text.trim().length > 0) {
        const role = paragraphRole(styleName)
        const textBlock = createTextBlockFromRuns(context, model.pages[model.pages.length - 1]!.pageId, context.blocks.length, runs, role)
        textBlock.textAlign = paragraphAlignment(child)
        context.blocks.push(textBlock)
      }
      for (const formulaNode of formulas) {
        const sourceText = textOfRuns(childrenOf(formulaNode)).trim()
        const blockId = createDocumentBlockId(
          input.sha256,
          model.pages[model.pages.length - 1]!.pageId,
          context.blocks.length,
          'formula'
        )
        const formula: DocumentFormulaBlock = {
          kind: 'formula',
          blockId,
          readingOrder: context.blocks.length,
          translatable: false,
          sourceText,
          mathml: sourceText
        }
        context.blocks.push(formula)
      }
      for (const relationshipId of imageIds) {
        const assetId = await ensureDocxImageAsset(context, relationshipId)
        if (!assetId) continue
        const blockId = createDocumentBlockId(
          input.sha256,
          model.pages[model.pages.length - 1]!.pageId,
          context.blocks.length,
          'image'
        )
        const image: DocumentImageBlock = {
          kind: 'image',
          blockId,
          readingOrder: context.blocks.length,
          translatable: false,
          assetId
        }
        context.blocks.push(image)
      }
      if (paragraphHasPageBreak(child)) flushPage()
    } else if (tag === 'tbl') {
      const table = await parseDocxTable(child, context)
      context.blocks.push(table)
    }
  }
  model.pages[model.pages.length - 1]!.blocks = limitDocumentBlocks(context.blocks, model.warnings)
  model.source.pageCount = model.pages.length
  model.metadata.direction = 'ltr'
  return model
}
