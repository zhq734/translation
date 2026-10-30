import { XMLParser } from 'fast-xml-parser'
import type {
  DocumentAsset,
  DocumentBlock,
  DocumentFormulaBlock,
  DocumentImageBlock,
  DocumentListInfo,
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
  /** 编号定义，按 numId 与层级查找。 */
  numbering: Map<string, DocxNumberingDefinition[]>
  /** 各编号序列当前计数。 */
  numberingCounters: Map<string, number[]>
  /** 文档默认样式与命名样式定义。 */
  styles: DocxStyles
}

/** DOCX 编号层级定义。 */
interface DocxNumberingDefinition {
  /** 层级索引。 */
  level: number
  /** 起始值。 */
  start: number
  /** OOXML 编号格式。 */
  format: string
  /** 层级文本模板。 */
  text: string
}

/** DOCX 段落编号引用。 */
interface DocxNumberingReference {
  /** 编号实例标识。 */
  numId: string
  /** 层级索引。 */
  level: number
}

/** DOCX 命名样式定义。 */
interface DocxStyleDefinition {
  /** 样式标识。 */
  id: string
  /** 样式类别。 */
  type: string
  /** 用户可见样式名。 */
  name?: string
  /** 父样式标识。 */
  basedOn?: string
  /** 段落属性节点。 */
  paragraphProperties?: OrderedNode
  /** 字符属性节点。 */
  runProperties?: OrderedNode
}

/** DOCX 样式集合。 */
interface DocxStyles {
  /** 文档默认字符属性。 */
  defaultRunProperties?: OrderedNode
  /** 文档默认段落属性。 */
  defaultParagraphProperties?: OrderedNode
  /** 段落样式。 */
  paragraphs: Map<string, DocxStyleDefinition>
  /** 字符样式。 */
  characters: Map<string, DocxStyleDefinition>
  /** 默认段落样式标识。 */
  defaultParagraphStyleId?: string
}

/** 段落内按 XML 顺序提取的内容事件。 */
type DocxParagraphEvent =
  | { kind: 'text'; text: string; style?: DocumentTextStyle }
  | { kind: 'formula'; node: OrderedNode }
  | { kind: 'image'; relationshipId: string }
  | { kind: 'page-break' }

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
 * 解析 OOXML 开关属性；缺省值按开启处理。
 * @param node 开关节点。
 * @returns 开关值；节点不存在时返回 undefined。
 * @author zhenghq
 */
function wordToggle(node: OrderedNode | null): boolean | undefined {
  if (!node) return undefined
  const value = attributesOf(node)['val']
  if (value === undefined) return true
  return !['0', 'false', 'off'].includes(value.toLowerCase())
}

/**
 * 将 OOXML 字符属性转换为文档文本样式。
 * @param properties `w:rPr` 节点。
 * @returns 已声明的文本样式字段；没有可识别属性时返回 undefined。
 * @author zhenghq
 */
function textStyleFromProperties(properties: OrderedNode | undefined): DocumentTextStyle | undefined {
  if (!properties) return undefined
  const children = childrenOf(properties)
  const style: DocumentTextStyle = {}
  const font = findFirstTag(children, 'rFonts')
  const fontAttributes = font ? attributesOf(font) : {}
  const fontFamily = fontAttributes['ascii'] ?? fontAttributes['hAnsi'] ?? fontAttributes['eastAsia']
  if (fontFamily) style.fontFamily = fontFamily
  const size = findFirstTag(children, 'sz')
  const fontSize = halfPointsToPoints(size ? attributesOf(size)['val'] : undefined)
  if (fontSize) style.fontSize = fontSize
  const bold = wordToggle(findFirstTag(children, 'b'))
  if (bold !== undefined) style.fontWeight = bold ? 700 : 400
  const italic = wordToggle(findFirstTag(children, 'i'))
  if (italic !== undefined) style.italic = italic
  const underline = wordToggle(findFirstTag(children, 'u'))
  if (underline !== undefined) style.underline = underline
  const strike = wordToggle(findFirstTag(children, 'strike')) ?? wordToggle(findFirstTag(children, 'dstrike'))
  if (strike !== undefined) style.strikethrough = strike
  const color = findFirstTag(children, 'color')
  const colorValue = color ? wordColor(attributesOf(color)['val']) : undefined
  if (colorValue) style.color = colorValue
  return Object.keys(style).length > 0 ? style : undefined
}

/**
 * 创建空的 DOCX 样式集合。
 * @returns 不包含任何命名样式的集合。
 * @author zhenghq
 */
function createEmptyDocxStyles(): DocxStyles {
  return { paragraphs: new Map(), characters: new Map() }
}

/**
 * 解析 DOCX 的文档默认样式、段落样式和字符样式。
 * @param xml `word/styles.xml` 文本。
 * @returns 样式集合；文件缺失或损坏时返回空集合。
 * @author zhenghq
 */
function parseDocxStyles(xml: string | null): DocxStyles {
  const styles = createEmptyDocxStyles()
  if (!xml) return styles
  let parsed: OrderedNode[]
  try {
    parsed = new XMLParser(XML_OPTIONS).parse(xml) as OrderedNode[]
  } catch {
    return styles
  }
  const defaults = findFirstTag(parsed, 'docDefaults')
  const runDefault = defaults ? findFirstTag(childrenOf(defaults), 'rPrDefault') : null
  const paragraphDefault = defaults ? findFirstTag(childrenOf(defaults), 'pPrDefault') : null
  styles.defaultRunProperties = runDefault ? findFirstTag(childrenOf(runDefault), 'rPr') ?? undefined : undefined
  styles.defaultParagraphProperties = paragraphDefault
    ? findFirstTag(childrenOf(paragraphDefault), 'pPr') ?? undefined
    : undefined
  for (const node of findAllTags(parsed, 'style')) {
    const attributes = attributesOf(node)
    const id = attributes['styleId']
    if (!id) continue
    const children = childrenOf(node)
    const nameNode = findFirstTag(children, 'name')
    const basedOnNode = findFirstTag(children, 'basedOn')
    const definition: DocxStyleDefinition = {
      id,
      type: attributes['type'] ?? 'paragraph',
      ...(nameNode ? { name: attributesOf(nameNode)['val'] } : {}),
      ...(basedOnNode ? { basedOn: attributesOf(basedOnNode)['val'] } : {}),
      ...(findFirstTag(children, 'pPr') ? { paragraphProperties: findFirstTag(children, 'pPr')! } : {}),
      ...(findFirstTag(children, 'rPr') ? { runProperties: findFirstTag(children, 'rPr')! } : {})
    }
    if (definition.type === 'character') styles.characters.set(id, definition)
    else if (definition.type === 'paragraph') styles.paragraphs.set(id, definition)
    if (definition.type === 'paragraph' && ['1', 'true', 'on'].includes((attributes['default'] ?? '').toLowerCase())) {
      styles.defaultParagraphStyleId = id
    }
  }
  return styles
}

/**
 * 按 `basedOn` 解析样式继承链，并阻止循环继承。
 * @param styleId 起始样式标识。
 * @param definitions 样式映射。
 * @returns 从最远父样式到当前样式的定义数组。
 * @author zhenghq
 */
function resolveStyleChain(
  styleId: string | undefined,
  definitions: Map<string, DocxStyleDefinition>
): DocxStyleDefinition[] {
  if (!styleId) return []
  const chain: DocxStyleDefinition[] = []
  const visited = new Set<string>()
  let current = definitions.get(styleId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    chain.unshift(current)
    current = current.basedOn ? definitions.get(current.basedOn) : undefined
  }
  return chain
}

/**
 * 合并多个文本样式，后者覆盖前者已声明字段。
 * @param styles 按优先级从低到高排列的样式。
 * @returns 合并后的样式；全部为空时返回 undefined。
 * @author zhenghq
 */
function mergeTextStyles(...styles: Array<DocumentTextStyle | undefined>): DocumentTextStyle | undefined {
  const merged = Object.assign({}, ...styles.filter((style): style is DocumentTextStyle => Boolean(style))) as DocumentTextStyle
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * 读取段落直接声明的样式标识，未声明时使用默认段落样式。
 * @param paragraphNode `w:p` 有序节点。
 * @param styles 文档样式集合。
 * @returns 段落样式标识。
 * @author zhenghq
 */
function paragraphStyleName(paragraphNode: OrderedNode, styles: DocxStyles): string | undefined {
  const paragraphProperties = findFirstTag(childrenOf(paragraphNode), 'pPr')
  const styleNode = paragraphProperties ? findFirstTag(childrenOf(paragraphProperties), 'pStyle') : null
  return (styleNode ? attributesOf(styleNode)['val'] : undefined) ?? styles.defaultParagraphStyleId
}

/**
 * 读取段落样式在样式表中的用户可见名称，用于语义角色推断。
 * @param styleId 段落样式标识。
 * @param styles 文档样式集合。
 * @returns 样式标识与名称的组合文本。
 * @author zhenghq
 */
function paragraphStyleLabel(styleId: string | undefined, styles: DocxStyles): string | undefined {
  const definition = styleId ? styles.paragraphs.get(styleId) : undefined
  return definition ? `${definition.id} ${definition.name ?? ''}` : styleId
}

/**
 * 从 run 属性及其段落、字符样式继承链解析文本样式。
 * @param runNode `w:r` 有序节点。
 * @param styles 文档样式集合。
 * @param paragraphStyleId 当前段落样式标识。
 * @returns 文本样式；没有可识别样式时返回 undefined。
 * @author zhenghq
 */
function runStyle(
  runNode: OrderedNode,
  styles: DocxStyles,
  paragraphStyleId: string | undefined
): DocumentTextStyle | undefined {
  const runProperties = findFirstTag(childrenOf(runNode), 'rPr')
  const characterStyleNode = runProperties ? findFirstTag(childrenOf(runProperties), 'rStyle') : null
  const characterStyleId = characterStyleNode ? attributesOf(characterStyleNode)['val'] : undefined
  const paragraphStyles = resolveStyleChain(paragraphStyleId, styles.paragraphs)
    .map((definition) => textStyleFromProperties(definition.runProperties))
  const characterStyles = resolveStyleChain(characterStyleId, styles.characters)
    .map((definition) => textStyleFromProperties(definition.runProperties))
  return mergeTextStyles(
    textStyleFromProperties(styles.defaultRunProperties),
    ...paragraphStyles,
    ...characterStyles,
    textStyleFromProperties(runProperties ?? undefined)
  )
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
 * 读取段落编号引用，包含段落样式继承的编号。
 * @param paragraphNode `w:p` 有序节点。
 * @param styles 文档样式集合。
 * @param paragraphStyleId 当前段落样式标识。
 * @returns 编号引用；普通段落返回 null。
 * @author zhenghq
 */
function paragraphNumbering(
  paragraphNode: OrderedNode,
  styles: DocxStyles,
  paragraphStyleId: string | undefined
): DocxNumberingReference | null {
  const paragraphProperties = findFirstTag(childrenOf(paragraphNode), 'pPr')
  const directNumberingProperties = paragraphProperties ? findFirstTag(childrenOf(paragraphProperties), 'numPr') : null
  const styleNumberingProperties = resolveStyleChain(paragraphStyleId, styles.paragraphs)
    .map((definition) => definition.paragraphProperties)
    .reverse()
    .map((properties) => properties ? findFirstTag(childrenOf(properties), 'numPr') : null)
    .find((node): node is OrderedNode => Boolean(node))
  const numberingProperties = directNumberingProperties ?? styleNumberingProperties
  if (!numberingProperties) return null
  const children = childrenOf(numberingProperties)
  const numIdNode = findFirstTag(children, 'numId')
  const directLevelNode = findFirstTag(children, 'ilvl')
  const inheritedLevelNode = resolveStyleChain(paragraphStyleId, styles.paragraphs)
    .map((definition) => definition.paragraphProperties)
    .reverse()
    .map((properties) => properties ? findFirstTag(childrenOf(properties), 'numPr') : null)
    .filter((node): node is OrderedNode => Boolean(node))
    .map((node) => findFirstTag(childrenOf(node), 'ilvl'))
    .find((node): node is OrderedNode => Boolean(node))
  const levelNode = directLevelNode ?? inheritedLevelNode
  const numId = numIdNode ? attributesOf(numIdNode)['val'] : undefined
  if (!numId || numId === '0') return null
  const parsedLevel = Number(levelNode ? attributesOf(levelNode)['val'] : 0)
  return { numId, level: Number.isInteger(parsedLevel) && parsedLevel >= 0 ? parsedLevel : 0 }
}

/**
 * 解析 DOCX 编号定义文件。
 * @param xml `word/numbering.xml` 文本。
 * @returns 按 numId 索引的层级定义。
 * @author zhenghq
 */
function parseDocxNumbering(xml: string | null): Map<string, DocxNumberingDefinition[]> {
  const numbering = new Map<string, DocxNumberingDefinition[]>()
  if (!xml) return numbering
  const parser = new XMLParser(XML_OPTIONS)
  const parsed = parser.parse(xml) as OrderedNode[]
  const abstractDefinitions = new Map<string, DocxNumberingDefinition[]>()
  for (const abstractNode of findAllTags(parsed, 'abstractNum')) {
    const abstractId = attributesOf(abstractNode)['abstractNumId']
    if (!abstractId) continue
    const levels: DocxNumberingDefinition[] = []
    for (const levelNode of childrenOf(abstractNode).filter((node) => tagNameOf(node) === 'lvl')) {
      const level = Number(attributesOf(levelNode)['ilvl'])
      const children = childrenOf(levelNode)
      const startNode = findFirstTag(children, 'start')
      const formatNode = findFirstTag(children, 'numFmt')
      const textNode = findFirstTag(children, 'lvlText')
      levels.push({
        level: Number.isInteger(level) && level >= 0 ? level : 0,
        start: Math.max(1, Number(startNode ? attributesOf(startNode)['val'] : 1) || 1),
        format: formatNode ? attributesOf(formatNode)['val'] ?? 'decimal' : 'decimal',
        text: textNode ? attributesOf(textNode)['val'] ?? `%${level + 1}.` : `%${level + 1}.`
      })
    }
    levels.sort((left, right) => left.level - right.level)
    abstractDefinitions.set(abstractId, levels)
  }
  for (const numNode of findAllTags(parsed, 'num')) {
    const numId = attributesOf(numNode)['numId']
    const abstractIdNode = findFirstTag(childrenOf(numNode), 'abstractNumId')
    const abstractId = abstractIdNode ? attributesOf(abstractIdNode)['val'] : undefined
    if (!numId) continue
    numbering.set(numId, abstractDefinitions.get(abstractId ?? '') ?? [])
  }
  return numbering
}

/**
 * 将计数格式化为列表标记。
 * @param value 当前计数。
 * @param format OOXML 编号格式。
 * @returns 用户可见标记文本。
 * @author zhenghq
 */
function formatListCounter(value: number, format: string): string {
  if (format === 'lowerLetter') return String.fromCharCode(97 + Math.max(0, (value - 1) % 26))
  if (format === 'upperLetter') return String.fromCharCode(65 + Math.max(0, (value - 1) % 26))
  if (format === 'lowerRoman') return toRoman(value).toLowerCase()
  if (format === 'upperRoman') return toRoman(value)
  if (format === 'none') return ''
  return String(value)
}

/**
 * 将正整数转换为罗马数字。
 * @param value 待转换数值。
 * @returns 罗马数字；超出常见范围时回退为十进制。
 * @author zhenghq
 */
function toRoman(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 3999) return String(value)
  const numerals: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ]
  let remaining = value
  let result = ''
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      result += numeral
      remaining -= amount
    }
  }
  return result
}

/**
 * 推进编号计数并生成当前列表项信息。
 * @param context 解析上下文。
 * @param reference 段落编号引用。
 * @returns 列表信息；定义缺失时仍返回降级标记。
 * @author zhenghq
 */
function nextListInfo(context: DocxContext, reference: DocxNumberingReference): DocumentListInfo {
  const definitions = context.numbering.get(reference.numId) ?? []
  const definition = definitions.find((item) => item.level === reference.level)
  const counters = [...(context.numberingCounters.get(reference.numId) ?? [])]
  // 首次访问某一层级时直接使用其起始值；重复访问同一层级才递增。
  const hasSeenLevel = counters[reference.level] !== undefined
  counters[reference.level] = hasSeenLevel
    ? (counters[reference.level] ?? 1) + 1
    : (definition?.start ?? 1)
  for (let level = reference.level + 1; level < counters.length; level += 1) counters[level] = 1
  context.numberingCounters.set(reference.numId, counters)
  const format = definition?.format ?? 'decimal'
  const template = definition?.text ?? `%${reference.level + 1}.`
  const marker = template.replace(/%(\d+)/gu, (_match, levelText: string) => {
    const level = Math.max(0, Number(levelText) - 1)
    const levelDefinition = definitions.find((item) => item.level === level)
    return formatListCounter(counters[level] ?? levelDefinition?.start ?? 1, levelDefinition?.format ?? 'decimal')
  })
  return { level: reference.level, marker, ordered: format !== 'bullet' && format !== 'none' }
}

/**
 * 从段落属性解析对齐方式。
 * @param paragraphNode `w:p` 有序节点。
 * @returns 对齐方式。
 * @author zhenghq
 */
function paragraphAlignment(
  paragraphNode: OrderedNode,
  styles: DocxStyles,
  paragraphStyleId: string | undefined
): DocumentTextAlign | undefined {
  const paragraphProperties = findFirstTag(childrenOf(paragraphNode), 'pPr')
  const directJustification = paragraphProperties ? findFirstTag(childrenOf(paragraphProperties), 'jc') : null
  const styleJustification = resolveStyleChain(paragraphStyleId, styles.paragraphs)
    .map((definition) => definition.paragraphProperties)
    .reverse()
    .map((properties) => properties ? findFirstTag(childrenOf(properties), 'jc') : null)
    .find((node): node is OrderedNode => Boolean(node))
  const justification = directJustification ?? styleJustification ??
    (styles.defaultParagraphProperties ? findFirstTag(childrenOf(styles.defaultParagraphProperties), 'jc') : null)
  const value = justification ? attributesOf(justification)['val'] : undefined
  if (value === 'center' || value === 'right' || value === 'both' || value === 'distribute') {
    return value === 'both' || value === 'distribute' ? 'justify' : value
  }
  return value === 'left' ? 'left' : undefined
}

/**
 * 将 OMML 公式转换为受控 MathML 子集，保留分式、上下标、根式和普通文本。
 * @param formulaNode `m:oMath` 有序节点。
 * @returns MathML 字符串；结构不可识别时仅保留转义后的公式文本。
 * @author zhenghq
 */
function ommlToMathml(formulaNode: OrderedNode): string {
  /**
   * 转义 XML 文本，防止公式内容注入标记。
   * @param value 原始文本。
   * @returns 安全文本。
   * @author zhenghq
   */
  const escapeXml = (value: string): string => value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')

  /**
   * 转换单个 OMML 节点。
   * @param node 当前节点。
   * @returns MathML 片段。
   * @author zhenghq
   */
  const convert = (node: OrderedNode): string => {
    const tag = tagNameOf(node)
    if (!tag) return typeof node['#text'] === 'string' ? escapeXml(node['#text']) : ''
    const children = childrenOf(node)
    if (tag === 't') return escapeXml(nodeText(node))
    if (tag === 'r' || tag === 'oMath' || tag === 'oMathPara' || tag === 'e' || tag === 'num' || tag === 'den' ||
      tag === 'sup' || tag === 'sub' || tag === 'deg' || tag === 'fName') {
      return children.map(convert).join('')
    }
    if (tag === 'f') {
      const numerator = children.find((child) => tagNameOf(child) === 'num')
      const denominator = children.find((child) => tagNameOf(child) === 'den')
      return `<mfrac>${numerator ? `<mrow>${convert(numerator)}</mrow>` : '<mrow></mrow>'}` +
        `${denominator ? `<mrow>${convert(denominator)}</mrow>` : '<mrow></mrow>'}</mfrac>`
    }
    if (tag === 'sSup') {
      const base = children.find((child) => tagNameOf(child) === 'e')
      const exponent = children.find((child) => tagNameOf(child) === 'sup')
      return `<msup>${base ? `<mrow>${convert(base)}</mrow>` : '<mrow></mrow>'}` +
        `${exponent ? `<mrow>${convert(exponent)}</mrow>` : '<mrow></mrow>'}</msup>`
    }
    if (tag === 'sSub') {
      const base = children.find((child) => tagNameOf(child) === 'e')
      const subscript = children.find((child) => tagNameOf(child) === 'sub')
      return `<msub>${base ? `<mrow>${convert(base)}</mrow>` : '<mrow></mrow>'}` +
        `${subscript ? `<mrow>${convert(subscript)}</mrow>` : '<mrow></mrow>'}</msub>`
    }
    if (tag === 'rad') {
      const degree = children.find((child) => tagNameOf(child) === 'deg')
      const radicand = children.find((child) => tagNameOf(child) === 'e')
      const degreeMarkup = degree ? `<mrow>${convert(degree)}</mrow>` : ''
      return `<mroot>${radicand ? `<mrow>${convert(radicand)}</mrow>` : '<mrow></mrow>'}` +
        `${degreeMarkup || '<mrow></mrow>'}</mroot>`
    }
    if (tag === 'd') {
      return `<mrow>${children.map(convert).join('')}</mrow>`
    }
    return children.map(convert).join('')
  }

  const body = childrenOf(formulaNode).map(convert).join('')
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow>${body}</mrow></math>`
}

/**
 * 提取段落中的普通文本 run，跳过公式和图片内部文本。
 * @param paragraphNode `w:p` 有序节点。
 * @param styles 文档样式集合。
 * @param paragraphStyleId 当前段落样式标识。
 * @returns 文本片段。
 * @author zhenghq
 */
function paragraphRuns(
  paragraphNode: OrderedNode,
  styles: DocxStyles,
  paragraphStyleId: string | undefined
): Array<Omit<DocumentTextRun, 'runId'>> {
  const runs: Array<Omit<DocumentTextRun, 'runId'>> = []
  for (const child of childrenOf(paragraphNode)) {
    const tag = tagNameOf(child)
    if (tag !== 'r') continue
    if (findFirstTag(childrenOf(child), 'oMath')) continue
    const text = textOfRuns(childrenOf(child))
    if (text.length === 0) continue
    const style = runStyle(child, styles, paragraphStyleId)
    runs.push({ text: sanitizeDocumentText(text), ...(style ? { style } : {}) })
  }
  return runs
}

/**
 * 按 XML 顺序提取段落内的文本、公式、图片和显式分页事件。
 * @param paragraphNode `w:p` 有序节点。
 * @param styles 文档样式集合。
 * @param paragraphStyleId 当前段落样式标识。
 * @returns 段落内容事件数组。
 * @author zhenghq
 */
function paragraphEvents(
  paragraphNode: OrderedNode,
  styles: DocxStyles,
  paragraphStyleId: string | undefined
): DocxParagraphEvent[] {
  const events: DocxParagraphEvent[] = []
  for (const child of childrenOf(paragraphNode)) {
    const tag = tagNameOf(child)
    if (tag === 'r') {
      let text = ''
      for (const runChild of childrenOf(child)) {
        const runTag = tagNameOf(runChild)
        if (runTag === 'oMath' || runTag === 'oMathPara') {
          if (text.length > 0) {
            const style = runStyle(child, styles, paragraphStyleId)
            events.push({ kind: 'text', text: sanitizeDocumentText(text), ...(style ? { style } : {}) })
            text = ''
          }
          for (const formula of findAllTags([runChild], 'oMath')) events.push({ kind: 'formula', node: formula })
          continue
        }
        if (runTag === 'drawing' || runTag === 'pict') {
          if (text.length > 0) {
            const style = runStyle(child, styles, paragraphStyleId)
            events.push({ kind: 'text', text: sanitizeDocumentText(text), ...(style ? { style } : {}) })
            text = ''
          }
          for (const blip of findAllTags([runChild], 'blip')) {
            const relationshipId = attributesOf(blip)['embed']
            if (relationshipId) events.push({ kind: 'image', relationshipId })
          }
          continue
        }
        if (runTag === 'br' && attributesOf(runChild)['type'] === 'page') {
          if (text.length > 0) {
            const style = runStyle(child, styles, paragraphStyleId)
            events.push({ kind: 'text', text: sanitizeDocumentText(text), ...(style ? { style } : {}) })
            text = ''
          }
          events.push({ kind: 'page-break' })
          continue
        }
        text += textOfRuns([runChild])
      }
      if (text.length > 0) {
        const style = runStyle(child, styles, paragraphStyleId)
        events.push({ kind: 'text', text: sanitizeDocumentText(text), ...(style ? { style } : {}) })
      }
      continue
    }
    if (tag === 'oMath' || tag === 'oMathPara') {
      for (const formula of findAllTags([child], 'oMath')) events.push({ kind: 'formula', node: formula })
    }
  }
  return events
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
  /** 正在向下合并的单元格，键为起始列索引。 */
  const activeVerticalMerges = new Map<number, { cell: DocumentTableCell; startRow: number }>()
  for (let rowIndex = 0; rowIndex < rowNodes.length; rowIndex += 1) {
    const rowNode = rowNodes[rowIndex]!
    const cellNodes = childrenOf(rowNode).filter((node) => tagNameOf(node) === 'tc')
    const cells: DocumentTableCell[] = []
    let columnIndex = 0
    for (let cellIndex = 0; cellIndex < cellNodes.length; cellIndex += 1) {
      const cellNode = cellNodes[cellIndex]!
      const cellProperties = findFirstTag(childrenOf(cellNode), 'tcPr')
      const gridSpan = cellProperties ? findFirstTag(childrenOf(cellProperties), 'gridSpan') : null
      const verticalMerge = cellProperties ? findFirstTag(childrenOf(cellProperties), 'vMerge') : null
      const verticalMergeValue = verticalMerge ? attributesOf(verticalMerge)['val'] : undefined
      const colSpan = Math.max(1, Number(gridSpan ? attributesOf(gridSpan)['val'] : 1) || 1)
      if (verticalMerge && verticalMergeValue !== 'restart') {
        const active = activeVerticalMerges.get(columnIndex)
        if (active) {
          active.cell.rowSpan = rowIndex - active.startRow + 1
          columnIndex += colSpan
          continue
        }
      }
      const blocks: DocumentBlock[] = []
      for (const paragraphNode of childrenOf(cellNode).filter((node) => tagNameOf(node) === 'p')) {
        const styleId = paragraphStyleName(paragraphNode, context.styles)
        const runs = paragraphRuns(paragraphNode, context.styles, styleId)
        const text = runs.map((run) => run.text).join('').trim()
        if (!text) continue
        const paragraphBlock = createTextBlockFromRuns(
          context,
          pageId,
          tableIndex + rowIndex * 1000 + cellIndex * 100 + blocks.length,
          runs,
          paragraphRole(paragraphStyleLabel(styleId, context.styles))
        )
        paragraphBlock.textAlign = paragraphAlignment(paragraphNode, context.styles, styleId)
        blocks.push(paragraphBlock)
      }
      const cell: DocumentTableCell = {
        cellId: createTableCellId(context.input.sha256, pageId, blockId, rowIndex, cellIndex),
        rowSpan: 1,
        colSpan,
        blocks
      }
      cells.push(cell)
      if (verticalMergeValue === 'restart') activeVerticalMerges.set(columnIndex, { cell, startRow: rowIndex })
      else if (verticalMerge) activeVerticalMerges.delete(columnIndex)
      columnIndex += colSpan
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
  const numberingXml = await readPackageText(packageInfo, 'word/numbering.xml')
  const stylesXml = await readPackageText(packageInfo, 'word/styles.xml')
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
    package: packageInfo,
    numbering: parseDocxNumbering(numberingXml),
    numberingCounters: new Map(),
    styles: parseDocxStyles(stylesXml)
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
      const styleId = paragraphStyleName(child, context.styles)
      const numberingReference = paragraphNumbering(child, context.styles, styleId)
      const role = numberingReference ? 'list-item' : paragraphRole(paragraphStyleLabel(styleId, context.styles))
      const textAlign = paragraphAlignment(child, context.styles, styleId)
      /** 当前段落尚未写入的连续文本事件。 */
      let pendingRuns: Array<Omit<DocumentTextRun, 'runId'>> = []

      /**
       * 将连续文本事件合并成一个文本块，保留分页和媒体边界。
       * @returns 无返回值。
       * @author zhenghq
       */
      const flushText = (): void => {
        if (pendingRuns.every((run) => run.text.trim().length === 0)) {
          pendingRuns = []
          return
        }
        const pageId = model.pages[model.pages.length - 1]!.pageId
        const textBlock = createTextBlockFromRuns(context, pageId, context.blocks.length, pendingRuns, role)
        textBlock.textAlign = textAlign
        if (numberingReference) textBlock.list = nextListInfo(context, numberingReference)
        context.blocks.push(textBlock)
        pendingRuns = []
      }

      for (const event of paragraphEvents(child, context.styles, styleId)) {
        if (event.kind === 'text') {
          pendingRuns.push({ text: event.text, ...(event.style ? { style: event.style } : {}) })
          continue
        }
        flushText()
        if (event.kind === 'page-break') {
          flushPage()
          continue
        }
        const pageId = model.pages[model.pages.length - 1]!.pageId
        if (event.kind === 'formula') {
          const blockId = createDocumentBlockId(input.sha256, pageId, context.blocks.length, 'formula')
          context.blocks.push({
            kind: 'formula',
            blockId,
            readingOrder: context.blocks.length,
            translatable: false,
            sourceText: textOfRuns(childrenOf(event.node)).trim(),
            mathml: ommlToMathml(event.node)
          })
          continue
        }
        const assetId = await ensureDocxImageAsset(context, event.relationshipId)
        if (!assetId) continue
        const blockId = createDocumentBlockId(input.sha256, pageId, context.blocks.length, 'image')
        context.blocks.push({
          kind: 'image',
          blockId,
          readingOrder: context.blocks.length,
          translatable: false,
          assetId
        })
      }
      flushText()
      if (findFirstTag(childrenOf(child), 'lastRenderedPageBreak')) flushPage()
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
