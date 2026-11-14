import assert from 'node:assert/strict'
import { mkdtemp, readFile as defaultReadFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  scale,
  translate
} from 'pdf-lib'
import { DocumentApprovedResourceService } from '../src/main/documentApprovedResourceService.ts'
import { parseApprovedPdfAssetContext } from '../src/main/documentApprovedAssetParse.ts'
import {
  createWorkerPdfAssetParseRunner,
  type WorkerLike
} from '../src/main/documentApprovedAssetParseWorkerRunner.ts'
import { hashDocumentBytes } from '../src/main/documentParserShared.ts'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import { createProductionPdfRasterizer } from '../src/main/documentPdfRuntime.ts'
import type { DocumentBoundingBox, DocumentModel } from '../src/shared/documentTypes.ts'
import type {
  DocumentApprovedAssetRequest,
  DocumentApprovedSourceRequest
} from '../src/shared/documentWorkspace.ts'

const requireFromProject = createRequire(join(process.cwd(), 'package.json'))
const { createCanvas } = requireFromProject('@napi-rs/canvas') as {
  createCanvas(width: number, height: number): Parameters<typeof createProductionPdfRasterizer>[1] extends {
    createCanvas?: infer T
  } ? T : never
}

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

/**
 * 递归查找文档模型中的第一张图片区块。
 * @param model 待检查的文档模型。
 * @returns 图片区块；不存在时返回 undefined。
 * @author zhenghq
 */
function findImageBlock(model: DocumentModel) {
  const find = (blocks: DocumentModel['pages'][number]['blocks']): DocumentModel['pages'][number]['blocks'][number] | undefined => {
    for (const block of blocks) {
      if (block.kind === 'image') return block
      if (block.kind !== 'table') continue
      for (const row of block.rows) {
        for (const cell of row.cells) {
          const image = find(cell.blocks)
          if (image) return image
        }
      }
    }
    return undefined
  }
  for (const page of model.pages) {
    const image = find(page.blocks)
    if (image?.kind === 'image') return image
  }
  return undefined
}

/**
 * 递归收集文档模型中的全部图片区块。
 * @param model 待检查的文档模型。
 * @returns 按页面和阅读顺序排列的图片区块。
 * @author zhenghq
 */
function collectImageBlocks(model: DocumentModel): DocumentModel['pages'][number]['blocks'] {
  const images: DocumentModel['pages'][number]['blocks'] = []
  const collect = (blocks: DocumentModel['pages'][number]['blocks']): void => {
    for (const block of blocks) {
      if (block.kind === 'image') {
        images.push(block)
      } else if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) collect(cell.blocks)
        }
      }
    }
  }
  for (const page of model.pages) collect(page.blocks)
  return images
}

/**
 * 创建包含真实 ImageMask 图片的 PDF 测试文件。
 * @param count 页面中绘制的 ImageMask 数量。
 * @returns 页面含正文文本与指定数量 ImageMask 的 PDF 字节。
 * @author zhenghq
 */
async function createImageMaskPdf(count = 1): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Text before image mask', { x: 60, y: 720, size: 16, font })

  const mask = PDFRawStream.of(PDFDict.withContext(document.context), new Uint8Array([
    0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff
  ]))
  mask.dict.set(PDFName.of('Type'), PDFName.of('XObject'))
  mask.dict.set(PDFName.of('Subtype'), PDFName.of('Image'))
  mask.dict.set(PDFName.of('Width'), document.context.obj(8))
  mask.dict.set(PDFName.of('Height'), document.context.obj(8))
  mask.dict.set(PDFName.of('ImageMask'), PDFBool.True)
  mask.dict.set(PDFName.of('BitsPerComponent'), document.context.obj(1))

  const maskRef = document.context.register(mask)
  const maskName = page.node.newXObject('Mask', maskRef)
  for (let index = 0; index < count; index += 1) {
    const column = index % 2
    const row = Math.floor(index / 2)
    page.pushOperators(
      pushGraphicsState(),
      // 六行绘制仍须完整落在页面内，避免测试误把页面裁剪当成区域提取失败。
      translate(100 + column * 180, 420 - row * 60),
      scale(count === 1 ? 240 : 120, count === 1 ? 160 : 80),
      drawObject(maskName),
      popGraphicsState()
    )
  }
  return new Uint8Array(await document.save())
}

test('读取 PDF 源预览时必须后台预热图片资源上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3, 4, 5, 6])
  const bbox = { x: 4, y: 8, width: 32, height: 24 }
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
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

    // 读取源预览就应触发后台预热，不能等到第一张图片请求才开始解析。
    const preview = await service.getSource(source)
    assert.equal(preview.ok, true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(parseCount, 1)

    const request = assetRequest(source, {
      assetId: imageAssetId,
      assetSha256: imageSha,
      assetByteLength: imageBytes.byteLength,
      mimeType: 'image/png',
      pageIndex: 0,
      bbox
    })
    const result = await service.getAsset(request)
    assert.equal(result.ok, true)
    assert.equal(parseCount, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('同一源文件的受控资源读取必须复用源文件校验缓存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8])
  const bbox = { x: 8, y: 16, width: 64, height: 48 }
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
  await writeFile(path, sourceBytes)
  try {
    let readCount = 0
    const service = new DocumentApprovedResourceService({
      isApprovedPath: (candidate) => candidate === path,
      readFile: async (target) => {
        readCount += 1
        return defaultReadFile(target)
      },
      parsePdfDocument: async (_input, options) => {
        options.registerAssetBytes?.(imageAssetId, imageBytes)
        return pdfImageModel(imageAssetId, imageBytes, bbox)
      },
      createProductionPdfRasterizer: async () => ({
        renderPageToImage: async () => null,
        renderPageRegionToImage: async () => null,
        renderEmbeddedImageToImage: async () => null
      })
    })
    const source = sourceRequest(path, sourceBytes, 'pdf')
    const request = assetRequest(source, {
      assetId: imageAssetId,
      assetSha256: imageSha,
      assetByteLength: imageBytes.byteLength,
      mimeType: 'image/png',
      pageIndex: 0,
      bbox
    })

    const first = await service.getAsset(request)
    assert.equal(first.ok, true)
    assert.equal(readCount, 1)

    // 第二次读取同一源文件时必须命中校验缓存，避免逐图重复读盘与哈希。
    const second = await service.getAsset(request)
    assert.equal(second.ok, true)
    assert.equal(readCount, 1)

    // 源文件被替换后缓存必须失效，并重新执行读取与哈希校验。
    await writeFile(path, new TextEncoder().encode('%PDF-1.7\nchanged-content'))
    assert.deepEqual(await service.getAsset(request), { ok: false, code: 'source-changed' })

    await writeFile(path, sourceBytes)
    const restored = await service.getAsset(request)
    assert.equal(restored.ok, true)
    assert.equal(readCount, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

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

test('重启后必须能从真实 PDF 重新解析并恢复内嵌图片', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'embedded-image.pdf')
  const imageCanvas = createCanvas(24, 16)
  const imageContext = imageCanvas.getContext('2d')
  imageContext.fillStyle = '#e11d48'
  imageContext.fillRect(0, 0, 24, 16)
  const imageBytes = new Uint8Array(imageCanvas.toBuffer('image/png'))
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Text before embedded image', { x: 60, y: 720, size: 16, font })
  const embedded = await document.embedPng(imageBytes)
  page.drawImage(embedded, { x: 100, y: 420, width: 240, height: 160 })
  const sourceBytes = new Uint8Array(await document.save())
  await writeFile(path, sourceBytes)
  try {
    const rasterizer = await createProductionPdfRasterizer(undefined, { createCanvas })
    const registeredAssets = new Map<string, Uint8Array>()
    const model = await parsePdfDocument({
      path,
      fileName: 'embedded-image.pdf',
      format: 'pdf',
      sha256: hashDocumentBytes(sourceBytes),
      bytes: sourceBytes
    }, {
      renderPageToImage: rasterizer.renderPageToImage,
      renderPageRegionToImage: rasterizer.renderPageRegionToImage,
      renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
      registerAssetBytes: (assetId, bytes) => registeredAssets.set(assetId, bytes)
    })
    const imageBlock = findImageBlock(model)
    assert.ok(imageBlock, '真实 PDF 解析结果必须包含内嵌图片区块')
    const imagePage = model.pages.find((candidate) => candidate.blocks.includes(imageBlock))
    assert.ok(imagePage, '图片区块必须位于解析页面中')
    assert.ok(imageBlock.bbox, '图片区块必须保留页面定位边界')
    assert.equal(imageBlock.renderPending, false, '真实内嵌图片不能保留 renderPending')
    assert.ok(registeredAssets.has(imageBlock.assetId), '首次解析必须登记真实图片字节')
    const asset = model.assets.find((candidate) => candidate.assetId === imageBlock.assetId)
    assert.ok(asset, '解析模型必须包含图片资源元数据')
    const restartedService = new DocumentApprovedResourceService({
      isApprovedPath: (candidate) => candidate === path,
      createProductionPdfRasterizer: async () => createProductionPdfRasterizer(
        undefined,
        { createCanvas }
      ),
      parsePdfDocument: async (input, options) => {
        return parsePdfDocument(input, options)
      }
    })
    const result = await restartedService.getAsset(assetRequest(
      sourceRequest(path, sourceBytes, 'pdf'),
      {
        assetId: imageBlock.assetId,
        assetSha256: asset.sha256,
        assetByteLength: asset.byteLength,
        mimeType: asset.mimeType,
        pageIndex: imagePage.index,
        bbox: imageBlock.bbox
      }
    ))
    assert.equal(result.ok, true)
    assert.equal(result.ok ? result.mimeType : '', 'image/png')
    assert.ok(result.ok && result.bytes.byteLength > 8)
    // PDF.js 可能以 Buffer 返回图片字节；只比较实际内容，避免把容器原型差异误判为资源恢复失败。
    assert.deepEqual(
      new Uint8Array(result.ok ? result.bytes : []),
      new Uint8Array(registeredAssets.get(imageBlock.assetId) ?? [])
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('重启后必须能恢复真实 PDF ImageMask 图片区域', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'image-mask.pdf')
  const sourceBytes = await createImageMaskPdf()
  await writeFile(path, sourceBytes)
  try {
    const rasterizer = await createProductionPdfRasterizer(undefined, { createCanvas })
    const registeredAssets = new Map<string, Uint8Array>()
    const model = await parsePdfDocument({
      path,
      fileName: 'image-mask.pdf',
      format: 'pdf',
      sha256: hashDocumentBytes(sourceBytes),
      bytes: sourceBytes
    }, {
      renderPageToImage: rasterizer.renderPageToImage,
      renderPageRegionToImage: rasterizer.renderPageRegionToImage,
      renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
      registerAssetBytes: (assetId, bytes) => registeredAssets.set(assetId, bytes)
    })
    const imageBlock = findImageBlock(model)
    assert.ok(imageBlock, 'ImageMask 页面必须生成图片区块')
    assert.deepEqual(imageBlock.bbox, { x: 100, y: 220, width: 240, height: 160 })
    assert.equal(imageBlock.renderPending, false, 'ImageMask 必须通过页面区域栅格化生成资源')
    const imagePage = model.pages.find((candidate) => candidate.blocks.includes(imageBlock))
    assert.ok(imagePage)
    const asset = model.assets.find((candidate) => candidate.assetId === imageBlock.assetId)
    assert.ok(asset)
    assert.ok(registeredAssets.has(imageBlock.assetId))

    const restartedService = new DocumentApprovedResourceService({
      isApprovedPath: (candidate) => candidate === path,
      createProductionPdfRasterizer: async () => createProductionPdfRasterizer(
        undefined,
        { createCanvas }
      )
    })
    const result = await restartedService.getAsset(assetRequest(
      sourceRequest(path, sourceBytes, 'pdf'),
      {
        assetId: imageBlock.assetId,
        assetSha256: asset.sha256,
        assetByteLength: asset.byteLength,
        mimeType: asset.mimeType,
        pageIndex: imagePage.index,
        bbox: imageBlock.bbox
      }
    ))
    assert.equal(result.ok, true)
    assert.equal(result.ok ? result.mimeType : '', 'image/png')
    assert.ok(result.ok && result.bytes.byteLength > 8)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('重启后必须能恢复 PDF.js 合并的重复 ImageMask 图片区域', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'repeated-image-mask.pdf')
  const sourceBytes = await createImageMaskPdf(12)
  await writeFile(path, sourceBytes)
  try {
    const rasterizer = await createProductionPdfRasterizer(undefined, { createCanvas })
    const model = await parsePdfDocument({
      path,
      fileName: 'repeated-image-mask.pdf',
      format: 'pdf',
      sha256: hashDocumentBytes(sourceBytes),
      bytes: sourceBytes
    }, {
      renderPageToImage: rasterizer.renderPageToImage,
      renderPageRegionToImage: rasterizer.renderPageRegionToImage,
      renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage
    })
    const imageBlocks = collectImageBlocks(model)
    assert.equal(imageBlocks.length, 12, '重复 ImageMask 的每个绘制区域都必须保留')
    assert.ok(imageBlocks.every((block) => block.renderPending === false),
      '重复 ImageMask 必须通过页面区域栅格化生成资源')
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

test('PDF 资源解析必须通过注入的解析运行器执行，避免阻塞主进程事件循环', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approved-resource-'))
  const path = join(directory, 'sample.pdf')
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 10, 11, 12])
  const bbox = { x: 4, y: 8, width: 32, height: 24 }
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
  await writeFile(path, sourceBytes)
  try {
    let runnerCount = 0
    let inProcessCount = 0
    const service = new DocumentApprovedResourceService({
      isApprovedPath: (candidate) => candidate === path,
      // 注入的解析运行器代表独立线程执行；主进程内的解析器不应再被调用。
      parsePdfAsset: async (input) => {
        runnerCount += 1
        assert.equal(input.sha256, hashDocumentBytes(sourceBytes))
        return {
          model: pdfImageModel(imageAssetId, imageBytes, bbox),
          assetBytes: new Map([[imageAssetId, imageBytes]]),
          assetHashes: new Map([[imageAssetId, imageSha]])
        }
      },
      parsePdfDocument: async () => {
        inProcessCount += 1
        throw new Error('主进程内解析不应被调用')
      },
      createProductionPdfRasterizer: async () => {
        throw new Error('主进程内栅格化器不应被创建')
      }
    })
    const source = sourceRequest(path, sourceBytes, 'pdf')
    const preview = await service.getSource(source)
    assert.equal(preview.ok, true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await service.getAsset(assetRequest(source, {
      assetId: imageAssetId,
      assetSha256: imageSha,
      assetByteLength: imageBytes.byteLength,
      mimeType: 'image/png',
      pageIndex: 0,
      bbox
    }))
    assert.equal(result.ok, true)
    assert.equal(runnerCount, 1)
    assert.equal(inProcessCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Worker 解析运行器必须复制源字节并在完成后终止 worker', async () => {
  const sourceBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 14, 15, 16])
  const imageSha = hashDocumentBytes(imageBytes)
  const imageAssetId = `asset-${imageSha.slice(0, 16)}`
  const model = pdfImageModel(imageAssetId, imageBytes, { x: 1, y: 2, width: 3, height: 4 })
  let posted: Array<{ value: unknown; transferList?: unknown[] }> = []
  class FakeWorker implements WorkerLike {
    terminated = false
    private readonly listeners = new Map<string, Array<(payload: unknown) => void>>()
    on(event: string, listener: (payload: unknown) => void): void {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
    }
    postMessage(value: unknown, transferList?: unknown[]): void {
      posted.push({ value, transferList })
    }
    terminate(): Promise<number> {
      this.terminated = true
      return Promise.resolve(0)
    }
    emit(event: string, payload: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(payload)
    }
  }
  const workers: FakeWorker[] = []
  const runner = createWorkerPdfAssetParseRunner({
    createWorker: (workerPath) => {
      assert.ok(workerPath.endsWith('documentApprovedAssetParseWorker.cjs'))
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }
  })
  const input = {
    path: '/tmp/sample.pdf',
    fileName: 'sample.pdf',
    format: 'pdf' as const,
    sha256: hashDocumentBytes(sourceBytes),
    bytes: sourceBytes
  }
  const pending = runner(input)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(workers.length, 1)
  assert.equal(posted.length, 1)
  const message = posted[0].value as {
    requestId: string
    input: { sha256: string; bytes: Uint8Array }
  }
  assert.equal(message.input.sha256, input.sha256)
  assert.deepEqual(Array.from(message.input.bytes), Array.from(sourceBytes))
  // 源字节必须复制后传输，主进程持有的原字节不能被转移分离。
  assert.notEqual((message.input.bytes as Uint8Array).buffer, sourceBytes.buffer)
  workers[0].emit('message', {
    requestId: message.requestId,
    model,
    assetBytes: [[imageAssetId, imageBytes]],
    assetHashes: [[imageAssetId, imageSha]]
  })
  const result = await pending
  assert.equal(result.model, model)
  assert.deepEqual(result.assetBytes.get(imageAssetId), imageBytes)
  assert.equal(result.assetHashes.get(imageAssetId), imageSha)
  assert.equal(workers[0].terminated, true)
})

test('Worker 解析运行器在 worker 加载失败时必须回退到进程内解析', async () => {
  const sourceBytes = new Uint8Array([9, 8, 7, 6])
  const model = pdfImageModel('asset-fallback', sourceBytes, { x: 1, y: 2, width: 3, height: 4 })
  let fallbackCount = 0
  const runner = createWorkerPdfAssetParseRunner({
    createWorker: () => {
      throw new Error('worker bundle missing')
    },
    inProcessParse: async (input) => {
      fallbackCount += 1
      assert.equal(input.sha256, hashDocumentBytes(sourceBytes))
      return { model, assetBytes: new Map(), assetHashes: new Map() }
    }
  })
  const result = await runner({
    path: '/tmp/sample.pdf',
    fileName: 'sample.pdf',
    format: 'pdf',
    sha256: hashDocumentBytes(sourceBytes),
    bytes: sourceBytes
  })
  assert.equal(result.model, model)
  assert.equal(fallbackCount, 1)
})
