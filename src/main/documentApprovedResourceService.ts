import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  DocumentBoundingBox,
  DocumentFormat,
  DocumentImageBlock,
  DocumentModel,
  DocumentPage
} from '../shared/documentTypes.ts'
import type {
  DocumentApprovedAssetRequest,
  DocumentApprovedSourceRequest,
  DocumentAssetResult,
  DocumentSourceResult
} from '../shared/documentWorkspace.ts'
import { detectDocumentFormat } from '../shared/documentFormat.ts'
import {
  DOCUMENT_MAX_BLOCKS,
  DOCUMENT_MAX_IMAGES,
  decodeDocumentText,
  hashDocumentBytes,
  type DocumentParseInput
} from './documentParserShared.ts'
import {
  imageMimeTypeFromPath,
  loadSafeDocumentPackage,
  normalizePackagePath,
  readPackageBytes
} from './documentPackageShared.ts'
import { parsePdfDocument } from './documentPdfParser.ts'
import {
  createProductionPdfRasterizer,
  type ProductionPdfRasterizer
} from './documentPdfRuntime.ts'
import { sanitizeHtmlPreview } from './documentTextParser.ts'

/** PDF 图片恢复缓存最多保留的源文件数量。 */
const PDF_ASSET_CACHE_SOURCE_LIMIT = 4

/** 旧版 `pdf-image:page:readingOrder` 占位内容的最大长度。 */
const PDF_LEGACY_PLACEHOLDER_MAX_BYTES = 64

/** 快照 bbox 与重新解析 bbox 之间允许的 PDF 点误差。 */
const PDF_ASSET_BBOX_TOLERANCE = 1

/** 旧 PDF 内嵌图片占位资源的前缀。 */
const PDF_LEGACY_IMAGE_PREFIX = 'pdf-image:'

/** 已解析 PDF 的受控资源上下文。 */
interface PdfAssetContext {
  /** 当前源文件重新解析得到的文档模型。 */
  model: DocumentModel
  /** 解析期登记的真实图片字节。 */
  assetBytes: Map<string, Uint8Array>
  /** 按页面惰性构建的旧占位资源哈希集合。 */
  legacyPlaceholderHashes: Map<number, Set<string>>
}

/** PDF 图片在模型中的定位结果。 */
interface PdfImageLocation {
  /** 图片所在页面。 */
  page: DocumentPage
  /** 图片区块。 */
  block: DocumentImageBlock
}

/** 受控资源服务依赖；只允许读取当前文档窗口重新批准过的路径。 */
export interface DocumentApprovedResourceServiceDependencies {
  /** 判断绝对路径是否属于当前窗口的批准集合。 */
  isApprovedPath(path: string): boolean
  /** 可注入的 PDF 解析函数；生产环境使用真实解析器。 */
  parsePdfDocument?: typeof parsePdfDocument
  /** 可注入的 PDF 栅格化器工厂；测试环境可避免加载原生 Canvas。 */
  createProductionPdfRasterizer?: typeof createProductionPdfRasterizer
}

/**
 * 只读历史与恢复 Tab 的受控资源服务。
 *
 * 该服务不信任 Renderer 传入的路径、格式或资源哈希。每次读取都会重新确认
 * 路径已授权、源文件未变化，并在返回前校验资源内容，避免历史快照读取任意本地文件。
 * @author zhenghq
 */
export class DocumentApprovedResourceService {
  private readonly dependencies: DocumentApprovedResourceServiceDependencies

  /** 按源 SHA 缓存最近解析的 PDF 资源上下文。 */
  private readonly pdfAssetContexts = new Map<string, Promise<PdfAssetContext>>()

  /**
   * 创建受控资源服务。
   * @param dependencies 路径授权查询依赖。
   * @author zhenghq
   */
  constructor(dependencies: DocumentApprovedResourceServiceDependencies) {
    this.dependencies = {
      parsePdfDocument,
      createProductionPdfRasterizer,
      ...dependencies
    }
  }

  /**
   * 读取历史快照对应的源文件，并返回与当前任务一致的安全预览字节。
   * @param request 已重新授权文件的路径、大小、SHA 与格式。
   * @returns PDF 原始字节、HTML 净化预览或稳定错误分类。
   * @author zhenghq
   */
  async getSource(request: DocumentApprovedSourceRequest): Promise<DocumentSourceResult> {
    const loaded = await this.loadApprovedSource(request)
    if (!loaded.ok) return loaded
    if (loaded.format === 'html') {
      const sanitized = sanitizeHtmlPreview(decodeDocumentText(loaded.bytes)).html
      return {
        ok: true,
        mimeType: 'text/html; charset=utf-8',
        bytes: new TextEncoder().encode(sanitized)
      }
    }
    if (loaded.format === 'pdf') {
      return { ok: true, mimeType: 'application/pdf', bytes: loaded.bytes }
    }
    return { ok: false, code: 'source-not-found' }
  }

  /**
   * 读取历史快照引用的图片资源。
   * @param request 源文件与资源快照元数据。
   * @returns 校验通过的图片字节或稳定错误分类。
   * @author zhenghq
   */
  async getAsset(request: DocumentApprovedAssetRequest): Promise<DocumentAssetResult> {
    if (!request || typeof request !== 'object' || typeof request.assetId !== 'string' ||
      !request.assetId || request.assetId.length > 512 ||
      typeof request.assetSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(request.assetSha256) ||
      !Number.isSafeInteger(request.assetByteLength) || request.assetByteLength < 1) {
      return { ok: false, code: 'asset-not-found' }
    }
    const loaded = await this.loadApprovedSource(request)
    if (!loaded.ok) return loaded

    if (loaded.format === 'pdf') {
      return this.getPdfAsset(request, loaded.input)
    }

    let bytes: Uint8Array | null = null
    let mimeType = request.mimeType?.trim() || 'application/octet-stream'
    if (loaded.format === 'image') {
      // 独立图片文档的唯一资源就是源图片本身；不接受 Renderer 指定其他包内路径。
      if (request.assetSha256.toLowerCase() !== loaded.sha256) {
        return { ok: false, code: 'asset-unavailable' }
      }
      bytes = loaded.bytes
      mimeType = detectImageMimeType(loaded.bytes, request.mimeType)
    } else if (loaded.format === 'docx' || loaded.format === 'epub') {
      if (!request.storageKey) return { ok: false, code: 'asset-not-found' }
      const storageKey = normalizePackagePath(request.storageKey)
      if (!storageKey) return { ok: false, code: 'asset-not-found' }
      try {
        const packageInfo = await loadSafeDocumentPackage(loaded.input)
        bytes = await readPackageBytes(packageInfo, storageKey)
      } catch {
        return { ok: false, code: 'asset-unavailable' }
      }
      if (!bytes) return { ok: false, code: 'asset-not-found' }
      mimeType = request.mimeType?.trim() || imageMimeTypeFromPath(storageKey)
    } else {
      return { ok: false, code: 'asset-not-found' }
    }

    if (bytes.byteLength !== request.assetByteLength ||
      hashDocumentBytes(bytes) !== request.assetSha256.toLowerCase()) {
      return { ok: false, code: 'asset-unavailable' }
    }
    return { ok: true, mimeType, bytes }
  }

  /**
   * 通过已授权源 PDF 重新解析内嵌图片，并按快照定位与校验资源。
   * @param request 包含页面索引、bbox 与资源元数据的恢复请求。
   * @param input 已校验的 PDF 解析输入。
   * @returns 真实图片字节或稳定错误分类。
   * @author zhenghq
   */
  private async getPdfAsset(
    request: DocumentApprovedAssetRequest,
    input: DocumentParseInput
  ): Promise<DocumentAssetResult> {
    if (!Number.isSafeInteger(request.pageIndex) || (request.pageIndex as number) < 0 ||
      !isValidBoundingBox(request.bbox)) {
      return { ok: false, code: 'asset-not-found' }
    }
    let context: PdfAssetContext
    try {
      context = await this.loadPdfAssetContext(input)
    } catch {
      return { ok: false, code: 'asset-unavailable' }
    }
    const location = findPdfImageLocation(
      context.model,
      request.pageIndex as number,
      request.bbox as DocumentBoundingBox
    )
    if (!location) return { ok: false, code: 'asset-not-found' }
    const bytes = context.assetBytes.get(location.block.assetId)
    if (!bytes || location.block.renderPending) {
      return { ok: false, code: 'asset-unavailable' }
    }
    const parsedAsset = context.model.assets.find((asset) =>
      asset.assetId === location.block.assetId)
    if (!parsedAsset || parsedAsset.kind !== 'image' || parsedAsset.byteLength !== bytes.byteLength ||
      parsedAsset.sha256.toLowerCase() !== hashDocumentBytes(bytes)) {
      return { ok: false, code: 'asset-unavailable' }
    }

    const requestedHash = request.assetSha256.toLowerCase()
    const parsedHash = parsedAsset.sha256.toLowerCase()
    const isCurrentAsset = request.assetId === parsedAsset.assetId &&
      requestedHash === parsedHash &&
      request.assetByteLength === parsedAsset.byteLength
    const isLegacyPlaceholder = request.assetByteLength > PDF_LEGACY_IMAGE_PREFIX.length &&
      request.assetByteLength <= PDF_LEGACY_PLACEHOLDER_MAX_BYTES &&
      request.assetId === `asset-${requestedHash.slice(0, 16)}` &&
      isLegacyPdfImagePlaceholderHash(
        requestedHash,
        request.pageIndex as number,
        context,
        location.page
      )
    if (!isCurrentAsset && !isLegacyPlaceholder) {
      return { ok: false, code: 'asset-unavailable' }
    }
    return { ok: true, mimeType: 'image/png', bytes }
  }

  /**
   * 取得或创建指定源 PDF 的解析资源上下文，并限制缓存源数量。
   * @param input 已校验的 PDF 解析输入。
   * @returns 可复用的 PDF 资源上下文。
   * @author zhenghq
   */
  private async loadPdfAssetContext(input: DocumentParseInput): Promise<PdfAssetContext> {
    const cached = this.pdfAssetContexts.get(input.sha256)
    if (cached) {
      // 重新插入可让 Map 保持最近使用顺序。
      this.pdfAssetContexts.delete(input.sha256)
      this.pdfAssetContexts.set(input.sha256, cached)
      return cached
    }
    const pending = this.parsePdfAssetContext(input)
    this.pdfAssetContexts.set(input.sha256, pending)
    while (this.pdfAssetContexts.size > PDF_ASSET_CACHE_SOURCE_LIMIT) {
      const oldestKey = this.pdfAssetContexts.keys().next().value as string | undefined
      if (!oldestKey) break
      this.pdfAssetContexts.delete(oldestKey)
    }
    try {
      return await pending
    } catch (error) {
      if (this.pdfAssetContexts.get(input.sha256) === pending) {
        this.pdfAssetContexts.delete(input.sha256)
      }
      throw error
    }
  }

  /**
   * 使用生产或注入的 PDF 栅格化器重新解析整份源文件并登记图片字节。
   * @param input 已校验的 PDF 解析输入。
   * @returns 解析模型与资源字节上下文。
   * @author zhenghq
   */
  private async parsePdfAssetContext(input: DocumentParseInput): Promise<PdfAssetContext> {
    const rasterizer = await this.dependencies.createProductionPdfRasterizer!()
    const assetBytes = new Map<string, Uint8Array>()
    const model = await this.dependencies.parsePdfDocument!(input, {
      renderPageToImage: rasterizer.renderPageToImage,
      renderPageRegionToImage: rasterizer.renderPageRegionToImage,
      renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
      registerAssetBytes: (assetId, bytes) => {
        if (assetId && bytes.byteLength > 0) assetBytes.set(assetId, new Uint8Array(bytes))
      }
    })
    return { model, assetBytes, legacyPlaceholderHashes: new Map() }
  }

  /**
   * 读取并校验已批准源文件，按实际内容重新识别格式。
   * @param request 历史快照中的源文件元数据。
   * @returns 已校验源字节及解析输入，或稳定错误分类。
   * @author zhenghq
   */
  private async loadApprovedSource(
    request: DocumentApprovedSourceRequest
  ): Promise<
    | { ok: true; bytes: Uint8Array; sha256: string; format: DocumentFormat; input: DocumentParseInput }
    | { ok: false; code: 'source-not-approved' | 'source-changed' | 'source-not-found' }
  > {
    if (!request || typeof request !== 'object' || typeof request.path !== 'string' ||
      !isAbsolute(request.path) || !this.dependencies.isApprovedPath(request.path)) {
      return { ok: false, code: 'source-not-approved' }
    }
    if (typeof request.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(request.sourceSha256) ||
      !Number.isSafeInteger(request.sourceSize) || request.sourceSize < 1) {
      return { ok: false, code: 'source-changed' }
    }
    try {
      const fileStat = await stat(request.path)
      if (!fileStat.isFile() || fileStat.size !== request.sourceSize) {
        return { ok: false, code: 'source-changed' }
      }
      const bytes = new Uint8Array(await readFile(request.path))
      const sha256 = hashDocumentBytes(bytes)
      if (bytes.byteLength !== request.sourceSize || sha256 !== request.sourceSha256.toLowerCase()) {
        return { ok: false, code: 'source-changed' }
      }
      const tail = bytes.subarray(Math.max(0, bytes.byteLength - 1024 * 1024))
      const detected = detectDocumentFormat(request.path, bytes.subarray(0, 8192), tail)
      let format: DocumentFormat
      if (detected.ok) {
        format = detected.format
      } else if ((request.format === 'docx' || request.format === 'epub') &&
        bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
        // 极简 OOXML/EPUB 夹具或部分生成器可能省略标准标记条目。此时只接受
        // 能通过安全解包的 ZIP 容器，并沿用扩展名声明的包格式；其他格式仍按内容识别。
        try {
          await loadSafeDocumentPackage({
            path: request.path,
            fileName: request.path.split(/[\\/]/u).pop() ?? request.path,
            format: request.format,
            sha256,
            bytes
          })
          format = request.format
        } catch {
          return { ok: false, code: 'source-changed' }
        }
      } else {
        return { ok: false, code: 'source-changed' }
      }
      const input: DocumentParseInput = {
        path: request.path,
        fileName: request.path.split(/[\\/]/u).pop() ?? request.path,
        format,
        sha256,
        bytes
      }
      return { ok: true, bytes, sha256, format, input }
    } catch {
      return { ok: false, code: 'source-not-found' }
    }
  }
}

/**
 * 按文件头识别独立图片 MIME；未知时保留快照声明，再回退为通用二进制。
 * @param bytes 图片字节。
 * @param declaredMimeType 快照声明的 MIME。
 * @returns 可交给 Blob 的 MIME 类型。
 * @author zhenghq
 */
function detectImageMimeType(bytes: Uint8Array, declaredMimeType?: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 6)))
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return declaredMimeType?.trim() || 'application/octet-stream'
}

/**
 * 判断请求 bbox 是否为有限、正尺寸的页面区域。
 * @param bbox 未信任的快照边界。
 * @returns 结构有效时返回 true。
 * @author zhenghq
 */
function isValidBoundingBox(bbox: DocumentBoundingBox | undefined): bbox is DocumentBoundingBox {
  return bbox !== undefined && typeof bbox === 'object' &&
    Number.isFinite(bbox.x) && Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.width) && Number.isFinite(bbox.height) &&
    bbox.width > 0 && bbox.height > 0
}

/**
 * 判断两个 PDF 图片边界是否在允许误差内一致。
 * @param left 快照边界。
 * @param right 重新解析边界。
 * @returns 四个坐标均在容差内时返回 true。
 * @author zhenghq
 */
function pdfBoundingBoxesMatch(
  left: DocumentBoundingBox,
  right: DocumentBoundingBox
): boolean {
  return Math.abs(left.x - right.x) <= PDF_ASSET_BBOX_TOLERANCE &&
    Math.abs(left.y - right.y) <= PDF_ASSET_BBOX_TOLERANCE &&
    Math.abs(left.width - right.width) <= PDF_ASSET_BBOX_TOLERANCE &&
    Math.abs(left.height - right.height) <= PDF_ASSET_BBOX_TOLERANCE
}

/**
 * 递归查找与快照页面、bbox 对应的图片区块。
 * @param blocks 页面区块。
 * @param bbox 快照图片边界。
 * @returns 匹配的图片区块；不存在时返回 undefined。
 * @author zhenghq
 */
function findPdfImageBlock(
  blocks: DocumentModel['pages'][number]['blocks'],
  bbox: DocumentBoundingBox
): DocumentImageBlock | undefined {
  for (const block of blocks) {
    if (block.kind === 'image') {
      if (block.bbox && pdfBoundingBoxesMatch(block.bbox, bbox)) return block
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const image = findPdfImageBlock(cell.blocks, bbox)
        if (image) return image
      }
    }
  }
  return undefined
}

/**
 * 在重新解析的 PDF 模型中定位快照图片，并校验 bbox 未超出页面范围。
 * @param model 重新解析的 PDF 模型。
 * @param pageIndex 快照页面索引。
 * @param bbox 快照图片边界。
 * @returns 页面与图片区块；越界或未匹配时返回 undefined。
 * @author zhenghq
 */
function findPdfImageLocation(
  model: DocumentModel,
  pageIndex: number,
  bbox: DocumentBoundingBox
): PdfImageLocation | undefined {
  const page = model.pages.find((candidate) => candidate.index === pageIndex)
  if (!page || bbox.x < -PDF_ASSET_BBOX_TOLERANCE || bbox.y < -PDF_ASSET_BBOX_TOLERANCE ||
    bbox.x + bbox.width > page.width + PDF_ASSET_BBOX_TOLERANCE ||
    bbox.y + bbox.height > page.height + PDF_ASSET_BBOX_TOLERANCE) {
    return undefined
  }
  const block = findPdfImageBlock(page.blocks, bbox)
  return block ? { page, block } : undefined
}

/**
 * 判断哈希是否对应指定页面的旧版 PDF 图片占位内容。
 * @param hash 快照资源哈希。
 * @param pageIndex 图片页面索引。
 * @param context 已解析 PDF 上下文，用于缓存候选哈希。
 * @param page 重新解析的页面。
 * @returns 哈希由 `pdf-image:page:readingOrder` 生成时返回 true。
 * @author zhenghq
 */
function isLegacyPdfImagePlaceholderHash(
  hash: string,
  pageIndex: number,
  context: PdfAssetContext,
  page: DocumentPage
): boolean {
  let hashes = context.legacyPlaceholderHashes.get(pageIndex)
  if (!hashes) {
    hashes = new Set<string>()
    const blockCount = countDocumentBlocks(page.blocks)
    const candidateLimit = Math.min(
      DOCUMENT_MAX_BLOCKS + DOCUMENT_MAX_IMAGES,
      Math.max(blockCount + DOCUMENT_MAX_IMAGES, 1)
    )
    for (let readingOrder = 0; readingOrder < candidateLimit; readingOrder += 1) {
      hashes.add(hashDocumentBytes(new TextEncoder().encode(
        `${PDF_LEGACY_IMAGE_PREFIX}${pageIndex}:${readingOrder}`
      )))
    }
    context.legacyPlaceholderHashes.set(pageIndex, hashes)
  }
  return hashes.has(hash)
}

/**
 * 统计页面内所有顶层与表格单元格区块数量。
 * @param blocks 待统计区块。
 * @returns 区块总数。
 * @author zhenghq
 */
function countDocumentBlocks(blocks: DocumentModel['pages'][number]['blocks']): number {
  let count = 0
  for (const block of blocks) {
    if (block.kind === 'break') continue
    count += 1
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) count += countDocumentBlocks(cell.blocks)
    }
  }
  return count
}
