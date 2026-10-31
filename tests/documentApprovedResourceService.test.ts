import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { DocumentApprovedResourceService } from '../src/main/documentApprovedResourceService.ts'
import { hashDocumentBytes } from '../src/main/documentParserShared.ts'
import type { DocumentBoundingBox, DocumentModel } from '../src/shared/documentTypes.ts'
import type {
  DocumentApprovedAssetRequest,
  DocumentApprovedSourceRequest
} from '../src/shared/documentWorkspace.ts'

/**
 * 创建受控资源服务测试实例。
 * @param approvedPaths 允许读取的绝对路径集合。
 * @returns 资源服务实例。
 * @author zhenghq
 */
function createService(approvedPaths: Set<string>): DocumentApprovedResourceService {
  return new DocumentApprovedResourceService({
    isApprovedPath: (path) => approvedPaths.has(path)
  })
}

/**
 * 构造与文件内容一致的源请求。
 * @param path 源文件绝对路径。
 * @param bytes 源文件字节。
 * @param format 源文件格式。
 * @returns 源请求。
 * @author zhenghq
 */
function sourceRequest(
  path: string,
  bytes: Uint8Array,
  format: DocumentApprovedSourceRequest['format']
): DocumentApprovedSourceRequest {
  return {
    path,
    format,
    sourceSha256: hashDocumentBytes(bytes),
    sourceSize: bytes.byteLength
  }
}

/**
 * 构造资源请求。
 * @param source 已校验的源请求。
 * @param asset 资源元数据。
 * @returns 资源请求。
 * @author zhenghq
 */
function assetRequest(
  source: DocumentApprovedSourceRequest,
  asset: {
    assetId: string
    assetSha256: string
    assetByteLength: number
    storageKey?: string
    mimeType?: string
    pageIndex?: number
    bbox?: DocumentBoundingBox
  }
): DocumentApprovedAssetRequest {
  return { ...source, ...asset }
}

/**
 * 创建只含一张内嵌图片的 PDF 测试模型。
 * @param assetId 解析器生成的图片资源标识。
 * @param bytes 图片字节。
 * @param bbox 图片在页面中的位置。
 * @returns 可供恢复流程定位的 PDF 文档模型。
 * @author zhenghq
 */
function pdfImageModel(
  assetId: string,
  bytes: Uint8Array,
  bbox: DocumentBoundingBox
): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'approved-resource-pdf',
    source: {
      path: '/approved/sample.pdf',
      fileName: 'sample.pdf',
      format: 'pdf',
      sha256: 'a'.repeat(64),
      size: 128,
      pageCount: 1
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'pdf-page-0',
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        blockId: 'pdf-image-block',
        kind: 'image',
        readingOrder: 0,
        translatable: false,
        bbox,
        assetId,
        alt: 'Embedded PDF image'
      }]
    }],
    assets: [{
      assetId,
      kind: 'image',
      mimeType: 'image/png',
      sha256: hashDocumentBytes(bytes),
      byteLength: bytes.byteLength
    }],
    warnings: []
  }
}

/**
 * 创建可注入的 PDF 资源恢复服务。
 * @param approvedPaths 允许读取的绝对路径集合。
 * @param model 解析器应返回的文档模型。
 * @param imageBytes 解析器登记的资源字节。
 * @param onParse 可选的解析调用观察函数。
 * @returns 资源服务实例。
 * @author zhenghq
 */
function createPdfService(
  approvedPaths: Set<string>,
  model: DocumentModel,
  imageBytes: Uint8Array,
  onParse?: () => void
): DocumentApprovedResourceService {
  return new DocumentApprovedResourceService({
    isApprovedPath: (path) => approvedPaths.has(path),
    parsePdfDocument: async (_input, options) => {
      onParse?.()
      const image = model.assets[0]
      if (image) options.registerAssetBytes?.(image.assetId, imageBytes)
      return model
    },
    createProductionPdfRasterizer: async () => ({
      renderPageToImage: async () => null,
      renderPageRegionToImage: async () => null,
      renderEmbeddedImageToImage: async () => null
    })
  })
}

test('受控资源服务必须拒绝未批准路径和源文件变更', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.txt')
  const bytes = new TextEncoder().encode('hello')
  await writeFile(path, bytes)
  try {
    const service = createService(new Set())
    const request = sourceRequest(path, bytes, 'txt')
    assert.deepEqual(await service.getSource(request), {
      ok: false,
      code: 'source-not-approved'
    })

    const approvedService = createService(new Set([path]))
    assert.deepEqual(await approvedService.getSource({
      ...request,
      sourceSha256: '0'.repeat(64)
    }), { ok: false, code: 'source-changed' })
    assert.deepEqual(await approvedService.getSource({
      ...request,
      sourceSize: bytes.byteLength + 1
    }), { ok: false, code: 'source-changed' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('受控资源服务必须按实际内容识别 HTML 并返回净化结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.html')
  const bytes = new TextEncoder().encode(
    '<!doctype html><html><body><script>alert(1)</script><h1 onclick="x()">Hello</h1></body></html>'
  )
  await writeFile(path, bytes)
  try {
    const service = createService(new Set([path]))
    const result = await service.getSource(sourceRequest(path, bytes, 'html'))
    assert.equal(result.ok, true)
    assert.equal(result.mimeType, 'text/html; charset=utf-8')
    const html = new TextDecoder().decode(result.bytes)
    assert.match(html, /<h1>Hello<\/h1>/u)
    assert.doesNotMatch(html, /<script|onclick/iu)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('受控资源服务必须返回 PDF 原始字节', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const bytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  await writeFile(path, bytes)
  try {
    const service = createService(new Set([path]))
    const result = await service.getSource(sourceRequest(path, bytes, 'pdf'))
    assert.equal(result.ok, true)
    assert.equal(result.mimeType, 'application/pdf')
    assert.deepEqual(result.bytes, bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('独立图片文档必须直接返回源图片资源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'scan.png')
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await writeFile(path, bytes)
  try {
    const service = createService(new Set([path]))
    const source = sourceRequest(path, bytes, 'image')
    const result = await service.getAsset(assetRequest(source, {
      assetId: 'asset-source',
      assetSha256: hashDocumentBytes(bytes),
      assetByteLength: bytes.byteLength,
      mimeType: 'image/png'
    }))
    assert.equal(result.ok, true)
    assert.equal(result.mimeType, 'image/png')
    assert.deepEqual(result.bytes, bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('受控资源服务必须拒绝包路径穿越和资源哈希不一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.docx')
  const image = new Uint8Array([1, 2, 3, 4])
  const zip = new JSZip()
  zip.file('word/media/image1.png', image)
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  await writeFile(path, bytes)
  try {
    const service = createService(new Set([path]))
    const source = sourceRequest(path, bytes, 'docx')
    assert.deepEqual(await service.getAsset(assetRequest(source, {
      assetId: 'asset-escape',
      assetSha256: hashDocumentBytes(image),
      assetByteLength: image.byteLength,
      storageKey: '../outside.png',
      mimeType: 'image/png'
    })), { ok: false, code: 'asset-not-found' })

    assert.deepEqual(await service.getAsset(assetRequest(source, {
      assetId: 'asset-wrong-hash',
      assetSha256: '0'.repeat(64),
      assetByteLength: image.byteLength,
      storageKey: 'word/media/image1.png',
      mimeType: 'image/png'
    })), { ok: false, code: 'asset-unavailable' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史 PDF 旧占位资源必须通过已授权源重新解析并返回真实图片', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  const bbox = { x: 24, y: 32, width: 160, height: 80 }
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
  const placeholderContent = new TextEncoder().encode('pdf-image:0:0')
  const placeholderSha = hashDocumentBytes(placeholderContent)
  await writeFile(path, sourceBytes)
  try {
    let parseCount = 0
    const service = createPdfService(
      new Set([path]),
      pdfImageModel(imageAssetId, imageBytes, bbox),
      imageBytes,
      () => { parseCount += 1 }
    )
    const source = sourceRequest(path, sourceBytes, 'pdf')
    const request = assetRequest(source, {
      assetId: `asset-${placeholderSha.slice(0, 16)}`,
      assetSha256: placeholderSha,
      assetByteLength: placeholderContent.byteLength,
      mimeType: 'image/png',
      pageIndex: 0,
      bbox
    })
    const result = await service.getAsset(request)
    assert.equal(result.ok, true)
    assert.equal(result.mimeType, 'image/png')
    assert.deepEqual(result.bytes, imageBytes)

    const cachedResult = await service.getAsset(request)
    assert.equal(cachedResult.ok, true)
    assert.equal(parseCount, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史 PDF 真实图片资源必须严格校验资源标识、哈希与大小', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6])
  const bbox = { x: 12, y: 18, width: 120, height: 60 }
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
  await writeFile(path, sourceBytes)
  try {
    const service = createPdfService(
      new Set([path]),
      pdfImageModel(imageAssetId, imageBytes, bbox),
      imageBytes
    )
    const source = sourceRequest(path, sourceBytes, 'pdf')
    const baseAsset = {
      assetId: imageAssetId,
      assetSha256: imageSha,
      assetByteLength: imageBytes.byteLength,
      mimeType: 'image/png',
      pageIndex: 0,
      bbox
    }
    const result = await service.getAsset(assetRequest(source, baseAsset))
    assert.equal(result.ok, true)
    assert.deepEqual(result.bytes, imageBytes)

    assert.deepEqual(await service.getAsset(assetRequest(source, {
      ...baseAsset,
      assetSha256: '0'.repeat(64)
    })), { ok: false, code: 'asset-unavailable' })
    assert.deepEqual(await service.getAsset(assetRequest(source, {
      ...baseAsset,
      assetByteLength: imageBytes.byteLength + 1
    })), { ok: false, code: 'asset-unavailable' })
    assert.deepEqual(await service.getAsset(assetRequest(source, {
      ...baseAsset,
      assetId: 'asset-forged'
    })), { ok: false, code: 'asset-unavailable' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史 PDF 图片恢复必须拒绝缺少定位、越界位置与解析失败', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8])
  const bbox = { x: 10, y: 20, width: 100, height: 50 }
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
  await writeFile(path, sourceBytes)
  try {
    const service = createPdfService(
      new Set([path]),
      pdfImageModel(imageAssetId, imageBytes, bbox),
      imageBytes
    )
    const source = sourceRequest(path, sourceBytes, 'pdf')
    const baseAsset = {
      assetId: imageAssetId,
      assetSha256: imageSha,
      assetByteLength: imageBytes.byteLength,
      mimeType: 'image/png'
    }
    assert.deepEqual(await service.getAsset(assetRequest(source, baseAsset)), {
      ok: false,
      code: 'asset-not-found'
    })
    assert.deepEqual(await service.getAsset(assetRequest(source, {
      ...baseAsset,
      pageIndex: 0
    })), { ok: false, code: 'asset-not-found' })
    assert.deepEqual(await service.getAsset(assetRequest(source, {
      ...baseAsset,
      pageIndex: 1,
      bbox
    })), { ok: false, code: 'asset-not-found' })
    assert.deepEqual(await service.getAsset(assetRequest(source, {
      ...baseAsset,
      pageIndex: 0,
      bbox: { ...bbox, x: 200 }
    })), { ok: false, code: 'asset-not-found' })

    const failingService = new DocumentApprovedResourceService({
      isApprovedPath: (candidate) => candidate === path,
      parsePdfDocument: async () => { throw new Error('parse failed') },
      createProductionPdfRasterizer: async () => ({
        renderPageToImage: async () => null,
        renderPageRegionToImage: async () => null,
        renderEmbeddedImageToImage: async () => null
      })
    })
    assert.deepEqual(await failingService.getAsset(assetRequest(source, {
      ...baseAsset,
      pageIndex: 0,
      bbox
    })), { ok: false, code: 'asset-unavailable' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
