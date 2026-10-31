import type {
  DocumentAsset,
  DocumentImageBlock,
  DocumentModel
} from '../shared/documentTypes.ts'
import {
  createDocumentBlockId,
  createDocumentPageId
} from '../shared/documentTypes.ts'
import {
  createDocumentModel,
  hashDocumentBytes,
  readDocumentImageDimensions,
  DOCUMENT_MAX_IMAGE_PIXELS,
  type DocumentParseInput
} from './documentParserShared.ts'

/** 独立图片解析安全错误码。 */
export type DocumentImageSecurityErrorCode = 'image-pixel-limit-reached'

/** 独立图片超过安全限制时抛出的稳定错误。 */
export class DocumentImageSecurityError extends Error {
  /** 稳定安全错误分类。 */
  readonly code: DocumentImageSecurityErrorCode

  /**
   * 创建不包含文件名或路径的图片安全错误。
   * @param code 稳定安全错误分类。
   * @author zhenghq
   */
  constructor(code: DocumentImageSecurityErrorCode) {
    super(code === 'image-pixel-limit-reached'
      ? 'image exceeds pixel limit'
      : 'image exceeds safety limit')
    this.name = 'DocumentImageSecurityError'
    this.code = code
  }
}

/**
 * 根据文件字节猜测图片 MIME 类型。
 * @param bytes 图片字节。
 * @returns MIME 类型；无法识别时回退为 application/octet-stream。
 * @author zhenghq
 */
function detectImageMimeType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 6)))
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return 'application/octet-stream'
}

/**
 * 解析单张图片为统一文档模型，生成整页图片区块供后续 OCR 与翻译流水线使用。
 * @param input 图片解析输入，bytes 为完整图片字节。
 * @param registerAssetBytes 可选资源字节登记函数，用于把图片存入任务资源缓存。
 * @returns 包含单页图片区块的文档模型。
 * @author zhenghq
 */
export async function parseImageDocument(
  input: DocumentParseInput,
  registerAssetBytes?: (assetId: string, bytes: Uint8Array) => void
): Promise<DocumentModel> {
  const sha256 = hashDocumentBytes(input.bytes)
  const dimensions = readDocumentImageDimensions(input.bytes)
  if (dimensions && dimensions.width * dimensions.height > DOCUMENT_MAX_IMAGE_PIXELS) {
    throw new DocumentImageSecurityError('image-pixel-limit-reached')
  }
  const assetId = `asset-${sha256.slice(0, 16)}`
  registerAssetBytes?.(assetId, input.bytes)
  const pageId = createDocumentPageId(input.sha256, 0)
  const blockId = createDocumentBlockId(input.sha256, pageId, 0, 'image')
  const block: DocumentImageBlock = {
    kind: 'image',
    blockId,
    readingOrder: 0,
    translatable: false,
    assetId,
    bbox: {
      x: 0,
      y: 0,
      width: dimensions?.width ?? 1,
      height: dimensions?.height ?? 1
    }
  }
  const asset: DocumentAsset = {
    assetId,
    kind: 'image',
    mimeType: detectImageMimeType(input.bytes),
    sha256,
    byteLength: input.bytes.byteLength,
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {})
  }
  const model = createDocumentModel(input, {
    pageWidth: dimensions?.width ?? 1,
    pageHeight: dimensions?.height ?? 1,
    pageCount: 1
  })
  model.pages[0]!.blocks = [block]
  model.assets = [asset]
  return model
}
