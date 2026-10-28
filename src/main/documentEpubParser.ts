import { XMLParser } from 'fast-xml-parser'
import {
  DOCUMENT_MODEL_SCHEMA_VERSION,
  createDocumentBlockId,
  createDocumentPageId,
  type DocumentAsset,
  type DocumentBlock,
  type DocumentImageBlock,
  type DocumentModel,
  type DocumentPage,
  type DocumentTextBlock
} from '../shared/documentTypes.ts'
import {
  DOCUMENT_MAX_IMAGES,
  createDocumentWarning,
  hashDocumentBytes,
  createDocumentModelId,
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
import { parseHtmlDocument } from './documentTextParser.ts'

/** EPUB XML 节点；非 preserveOrder 模式下可能是对象、数组或标量。 */
type EpubXmlNode = Record<string, unknown>

/** EPUB manifest 项。 */
interface EpubManifestItem {
  /** manifest 标识。 */
  id: string
  /** 包内相对路径。 */
  href: string
  /** MIME 类型。 */
  mediaType: string
  /** 可选的 EPUB 属性。 */
  properties?: string
}

/** EPUB 解析后的包描述。 */
interface EpubPackage {
  /** OPF 包内路径。 */
  opfPath: string
  /** 文档标题。 */
  title?: string
  /** 文档作者。 */
  author?: string
  /** 文档语言。 */
  language?: string
  /** manifest 映射。 */
  manifest: Map<string, EpubManifestItem>
  /** spine 阅读顺序。 */
  spine: string[]
  /** 目录页标识。 */
  navId?: string
}

/** EPUB XML 解析配置；不执行外部实体，不加载远程资源。 */
const EPUB_XML_OPTIONS = {
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  maxNestedTags: 100
} as const

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
 * 将 XML 子节点统一转换为数组。
 * @param value 单个节点或节点数组。
 * @returns 节点数组。
 * @author zhenghq
 */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * 读取 XML 节点文本，兼容 `#text` 和对象直接文本值。
 * @param value XML 节点。
 * @returns 清理后的文本。
 * @author zhenghq
 */
function xmlText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim()
    return text || undefined
  }
  if (isRecord(value) && typeof value['#text'] === 'string') {
    const text = value['#text'].trim()
    return text || undefined
  }
  return undefined
}

/**
 * 读取对象中第一个非空字符串字段。
 * @param value 待读取值。
 * @param keys 候选字段名。
 * @returns 找到的字符串或 undefined。
 * @author zhenghq
 */
function firstText(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return xmlText(value)
  for (const key of keys) {
    const text = xmlText(value[key])
    if (text) return text
  }
  return undefined
}

/**
 * 解析 container.xml，定位 OPF 包文件。
 * @param containerXml container.xml 内容。
 * @returns OPF 包内路径。
 * @author zhenghq
 */
function parseContainerPath(containerXml: string): string {
  const parser = new XMLParser(EPUB_XML_OPTIONS)
  const parsed = parser.parse(containerXml) as EpubXmlNode
  const container = isRecord(parsed.container) ? parsed.container : parsed
  const rootfiles = isRecord(container.rootfiles) ? container.rootfiles : undefined
  const rootfile = asArray(rootfiles?.rootfile)
    .find((item): item is EpubXmlNode => isRecord(item) && typeof item['full-path'] === 'string')
  const path = rootfile?.['full-path']
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('epub package is missing OPF rootfile')
  }
  const normalized = resolvePackagePath('', path)
  if (!normalized) throw new Error('epub package has an unsafe OPF path')
  return normalized
}

/**
 * 解析 OPF 元数据、manifest 与 spine。
 * @param opfXml OPF 内容。
 * @param opfPath OPF 包内路径。
 * @returns 包描述。
 * @author zhenghq
 */
function parseOpfPackage(opfXml: string, opfPath: string): EpubPackage {
  const parser = new XMLParser(EPUB_XML_OPTIONS)
  const parsed = parser.parse(opfXml) as EpubXmlNode
  const packageNode = isRecord(parsed.package) ? parsed.package : parsed
  const metadata = isRecord(packageNode.metadata) ? packageNode.metadata : {}
  const manifestNode = isRecord(packageNode.manifest) ? packageNode.manifest : {}
  const spineNode = isRecord(packageNode.spine) ? packageNode.spine : {}
  const manifest = new Map<string, EpubManifestItem>()
  let navId: string | undefined
  for (const item of asArray(manifestNode.item)) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const href = typeof item.href === 'string' ? item.href.trim() : ''
    if (!id || !href) continue
    const mediaType = typeof item['media-type'] === 'string' ? item['media-type'] : ''
    const properties = typeof item.properties === 'string' ? item.properties : undefined
    manifest.set(id, { id, href, mediaType, ...(properties ? { properties } : {}) })
    if (properties?.split(/\s+/u).includes('nav')) navId = id
  }
  const spine = asArray(spineNode.itemref)
    .filter(isRecord)
    .map((item) => typeof item.idref === 'string' ? item.idref.trim() : '')
    .filter((id) => Boolean(id) && manifest.has(id))
  if (spine.length === 0) throw new Error('epub package has no readable spine items')
  return {
    opfPath,
    ...(firstText(metadata.title, ['title', '#text']) ? { title: firstText(metadata.title, ['title', '#text']) } : {}),
    ...(firstText(metadata.creator, ['creator', '#text']) ? { author: firstText(metadata.creator, ['creator', '#text']) } : {}),
    ...(firstText(metadata.language, ['language', '#text']) ? { language: firstText(metadata.language, ['language', '#text']) } : {}),
    manifest,
    spine,
    ...(navId ? { navId } : {})
  }
}

/**
 * 按 OPF spine 顺序解析 EPUB，章节 HTML 只在本地转换为安全区块。
 * @param input 解析输入。
 * @returns EPUB 文档模型。
 * @author zhenghq
 */
export async function parseEpubDocument(input: DocumentParseInput): Promise<DocumentModel> {
  const packageInfo = await loadSafeDocumentPackage(input)
  const containerXml = await readPackageText(packageInfo, 'META-INF/container.xml')
  if (!containerXml) throw new Error('epub package is missing META-INF/container.xml')
  const opfPath = parseContainerPath(containerXml)
  const opfXml = await readPackageText(packageInfo, opfPath)
  if (!opfXml) throw new Error('epub package is missing OPF document')
  const epubPackage = parseOpfPackage(opfXml, opfPath)
  const baseDirectory = packageDirectory(opfPath)
  const pages: DocumentPage[] = []
  const assets: DocumentAsset[] = []
  const warnings = [...packageInfo.warnings]

  for (let index = 0; index < epubPackage.spine.length; index += 1) {
    const item = epubPackage.manifest.get(epubPackage.spine[index]!)!
    const chapterPath = resolvePackagePath(baseDirectory, item.href)
    if (!chapterPath) {
      warnings.push(createDocumentWarning('unsafe-epub-chapter', 'An EPUB chapter with an unsafe path was skipped.'))
      continue
    }
    const chapterXml = await readPackageText(packageInfo, chapterPath)
    if (!chapterXml) {
      warnings.push(createDocumentWarning('missing-epub-chapter', 'An EPUB chapter file was missing and was skipped.'))
      continue
    }
    const chapterModel = parseHtmlDocument({
      ...input,
      sha256: `${input.sha256}#chapter:${index}`,
      bytes: new TextEncoder().encode(chapterXml)
    })
    const pageId = createDocumentPageId(input.sha256, pages.length)
    const chapterPage = chapterModel.pages[0]!
    // 章节 HTML 若包含分页扫描结构，仍需合并全部页面，避免只保留第一页正文。
    let blocks = remapChapterBlocks(
      chapterModel.pages.flatMap((page) => page.blocks),
      input.sha256,
      pageId
    )
    blocks = await collectEpubImages(
      packageInfo,
      chapterPath,
      chapterXml,
      input.sha256,
      assets,
      warnings,
      pageId,
      blocks
    )
    const title = chapterModel.metadata.title ?? firstBlockHeading(blocks)
    pages.push({
      pageId,
      index: pages.length,
      width: chapterPage.width,
      height: chapterPage.height,
      ...(title ? { title } : {}),
      blocks
    })
    warnings.push(...chapterModel.warnings.map((warning) => ({ ...warning, pageId })))
  }

  if (pages.length === 0) throw new Error('epub package has no readable chapters')
  return {
    schemaVersion: DOCUMENT_MODEL_SCHEMA_VERSION,
    documentId: createDocumentModelId(input.sha256),
    source: {
      path: input.path,
      fileName: input.fileName,
      format: 'epub',
      sha256: input.sha256,
      size: input.bytes.byteLength,
      pageCount: pages.length
    },
    metadata: {
      direction: 'auto',
      ...(epubPackage.title ? { title: epubPackage.title } : {}),
      ...(epubPackage.author ? { author: epubPackage.author } : {}),
      ...(epubPackage.language ? { language: epubPackage.language } : {})
    },
    pages,
    assets,
    warnings
  }
}

/**
 * 将章节临时模型中的区块重新映射到最终 EPUB 页面标识。
 * @param blocks 章节区块。
 * @param fingerprint 最终文档指纹。
 * @param pageId 最终页面标识。
 * @returns 稳定标识已重映射的区块。
 * @author zhenghq
 */
function remapChapterBlocks(
  blocks: DocumentBlock[],
  fingerprint: string,
  pageId: string
): DocumentBlock[] {
  const visit = (sourceBlocks: DocumentBlock[], prefix: string, readingOffset = 0): DocumentBlock[] => sourceBlocks.map((block, index) => {
    const readingOrder = readingOffset + index
    const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, block.kind)
    if (block.kind === 'text') {
      const textBlock: DocumentTextBlock = {
        ...block,
        blockId,
        readingOrder,
        runs: block.runs.map((run, runIndex) => ({ ...run, runId: `${blockId}-run-${runIndex}` }))
      }
      return textBlock
    }
    if (block.kind === 'table') {
      return {
        ...block,
        blockId,
        readingOrder,
        rows: block.rows.map((row, rowIndex) => ({
          ...row,
          rowId: `${blockId}-row-${rowIndex}`,
          cells: row.cells.map((cell, cellIndex) => ({
            ...cell,
            cellId: `${blockId}-cell-${rowIndex}-${cellIndex}`,
            blocks: visit(cell.blocks, `cell-${rowIndex}-${cellIndex}-`, (rowIndex * 1000 + cellIndex * 100))
          }))
        }))
      }
    }
    return { ...block, blockId, readingOrder }
  })
  return visit(blocks, '')
}

/**
 * 读取章节标题作为页面导航名称。
 * @param blocks 页面区块。
 * @returns 第一个标题区块文本。
 * @author zhenghq
 */
function firstBlockHeading(blocks: DocumentBlock[]): string | undefined {
  const heading = blocks.find((block): block is DocumentTextBlock => block.kind === 'text' && block.role === 'heading')
  return heading?.runs.map((run) => run.text).join('').trim() || undefined
}

/**
 * 登记 EPUB 章节引用的包内图片，供后续本机 OCR 使用。
 * @param packageInfo 已校验文档包。
 * @param chapterPath 章节包内路径。
 * @param chapterXml 章节 HTML。
 * @param fingerprint 文档指纹。
 * @param assets 资源输出数组。
 * @param warnings 告警输出数组。
 * @param pageId 当前章节页面标识。
 * @param blocks 当前章节区块数组。
 * @returns 已追加图片区块的章节区块。
 * @author zhenghq
 */
async function collectEpubImages(
  packageInfo: SafeDocumentPackage,
  chapterPath: string,
  chapterXml: string,
  fingerprint: string,
  assets: DocumentAsset[],
  warnings: ReturnType<typeof createDocumentWarning>[],
  pageId: string,
  blocks: DocumentBlock[]
): Promise<DocumentBlock[]> {
  const sources = [...chapterXml.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/giu)]
    .map((match) => match[1] ?? match[2] ?? '')
  const imageBlocks: DocumentImageBlock[] = []
  for (const source of sources) {
    if (!source || /^(?:[a-z]+:|\/\/|data:)/iu.test(source)) continue
    const assetPath = resolvePackagePath(packageDirectory(chapterPath), source)
    if (!assetPath) continue
    const existing = assets.find((asset) => asset.storageKey === assetPath)
    if (existing) {
      const readingOrder = blocks.length + imageBlocks.length
      imageBlocks.push({
        kind: 'image',
        blockId: createDocumentBlockId(fingerprint, pageId, readingOrder, 'image'),
        readingOrder,
        translatable: false,
        assetId: existing.assetId
      })
      continue
    }
    if (assets.length >= DOCUMENT_MAX_IMAGES) {
      if (!warnings.some((warning) => warning.code === 'image-limit-reached')) {
        warnings.push(createDocumentWarning('image-limit-reached', 'The EPUB image limit was reached; remaining images were skipped.'))
      }
      break
    }
    const bytes = await readPackageBytes(packageInfo, assetPath)
    if (!bytes) continue
    const sha256 = hashDocumentBytes(bytes)
    const asset: DocumentAsset = {
      assetId: `asset-${sha256.slice(0, 16)}`,
      kind: 'image',
      mimeType: imageMimeTypeFromPath(assetPath),
      sha256,
      byteLength: bytes.byteLength,
      storageKey: assetPath
    }
    assets.push(asset)
    const readingOrder = blocks.length + imageBlocks.length
    imageBlocks.push({
      kind: 'image',
      blockId: createDocumentBlockId(fingerprint, pageId, readingOrder, 'image'),
      readingOrder,
      translatable: false,
      assetId: asset.assetId
    })
  }
  return [...blocks, ...imageBlocks]
}
