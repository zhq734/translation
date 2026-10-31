import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { PDFDocument, rgb } from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import { createProductionPdfRasterizer } from '../src/main/documentPdfRuntime.ts'
import { exportDocumentToPdf } from '../src/main/documentPdfExport.ts'
import type { DocumentImageBlock, DocumentTextBlock } from '../src/shared/documentTypes.ts'

const require = createRequire(import.meta.url)
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

/**
 * 判断字节是否以 PNG 文件签名开头。
 * @param bytes 待检查字节。
 * @returns 是否为 PNG。
 * @author zhenghq
 */
function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  return signature.every((value, index) => bytes[index] === value)
}

/**
 * 验证 Canvas 矢量填充颜色未在 Electron 原生运行时中退化为黑色。
 * @returns 实际读取到的 RGBA 颜色字符串。
 * @author zhenghq
 */
function verifyCanvasColorRendering(): string {
  const canvasModule = require('@napi-rs/canvas') as {
    createCanvas(width: number, height: number): {
      getContext(type: '2d'): {
        fillStyle: string
        fillRect(x: number, y: number, width: number, height: number): void
        getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
      }
    }
  }
  const canvas = canvasModule.createCanvas(2, 2)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(255, 0, 0)'
  context.fillRect(0, 0, 2, 2)
  const pixel = [...context.getImageData(0, 0, 1, 1).data]
  assert.deepEqual(pixel, [255, 0, 0, 255], 'Canvas 矢量填充颜色必须保持为红色，不能退化为黑色')
  return `rgba(${pixel.join(', ')})`
}

/**
 * 拼接 PDF 页面可检索文本。
 * @param document 已打开的 PDF.js 文档。
 * @returns 全部页面文本。
 * @author zhenghq
 */
async function extractPdfText(document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>): Promise<string> {
  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => 'str' in item ? item.str : '').join(''))
  }
  return pages.join('\n')
}

/**
 * 运行真实 PDF 解析、扫描页栅格化、OCR 译文导出与回读验证。
 * @returns 无返回值；任一步失败时抛出异常。
 * @author zhenghq
 */
async function runSmoke(): Promise<void> {
  const canvasVectorColor = verifyCanvasColorRendering()
  const fixtureBytes = readFileSync('tests/fixtures/document/sample.pdf')
  // 共享 fixture 的第二页保持空白，供空白页语义测试使用；冒烟在此临时加入可见矢量内容，
  // 以真实覆盖“无文本层但需要 OCR”的扫描页路径。
  const smokeDocument = await PDFDocument.load(fixtureBytes)
  const scannedPage = smokeDocument.getPage(1)
  scannedPage.drawRectangle({
    x: 48,
    y: 48,
    width: 504,
    height: 696,
    borderColor: rgb(0.7, 0.72, 0.76),
    borderWidth: 1
  })
  scannedPage.drawLine({
    start: { x: 72, y: 640 },
    end: { x: 528, y: 640 },
    thickness: 1,
    color: rgb(0.75, 0.77, 0.8)
  })
  const sourceBytes = await smokeDocument.save()
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  const registeredAssets = new Map<string, Uint8Array>()
  const rasterizer = await createProductionPdfRasterizer()
  const source = await parsePdfDocument({
    path: 'tests/fixtures/document/sample.pdf',
    fileName: 'sample.pdf',
    format: 'pdf',
    sha256: sourceSha256,
    bytes: sourceBytes
  }, {
    renderPageToImage: rasterizer.renderPageToImage,
    renderPageRegionToImage: rasterizer.renderPageRegionToImage,
    registerAssetBytes: (assetId, bytes) => registeredAssets.set(assetId, bytes)
  })

  assert.equal(source.pages.length, 2, '样本 PDF 应解析为 2 页')
  const nativeTextBlocks = source.pages[0]!.blocks.filter(
    (block): block is DocumentTextBlock => block.kind === 'text'
  )
  assert.ok(nativeTextBlocks.length > 0, '第 1 页应保留原生文本层')
  assert.match(nativeTextBlocks.map((block) => block.runs.map((run) => run.text).join('')).join('\n'), /Native text page/u)

  const scannedImage = source.pages[1]!.blocks.find(
    (block): block is DocumentImageBlock => block.kind === 'image'
  )
  assert.ok(scannedImage, '第 2 页应生成扫描页图片')
  assert.equal(scannedImage.renderPending, false, '扫描页应已完成栅格化')
  const scannedBytes = registeredAssets.get(scannedImage.assetId)
  assert.ok(scannedBytes, '扫描页资源应登记到任务缓存')
  assert.equal(isPng(scannedBytes), true, '扫描页资源应为 PNG')
  assert.ok(scannedBytes.byteLength > 1_000, '扫描页 PNG 应包含有效图像数据')
  assert.equal(source.warnings.some((warning) => warning.code === 'ocr-required'), false)

  const translation = structuredClone(source)
  for (const page of translation.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'text') {
        block.runs = block.runs.map((run) => ({ ...run, text: '文档翻译能力验证' }))
      }
    }
  }
  const translatedScan = translation.pages[1]!.blocks.find(
    (block): block is DocumentImageBlock => block.kind === 'image'
  )
  assert.ok(translatedScan)
  translatedScan.bbox = {
    x: 24,
    y: 24,
    width: translation.pages[1]!.width - 48,
    height: translation.pages[1]!.height - 48
  }
  translatedScan.ocrRegions = [{
    regionId: 'smoke-ocr-region',
    bbox: { x: 0.08, y: 0.08, width: 0.84, height: 0.16 },
    text: 'Scanned page source text',
    translatedText: '扫描页 OCR 译文',
    confidence: 0.99,
    status: 'recognized'
  }]

  const fontBytes = readFileSync('assets/fonts/NotoSansSC-Regular.ttf')
  const exported = await exportDocumentToPdf(translation, {
    loadFontBytes: async () => fontBytes,
    loadAssetBytes: async (assetId) => registeredAssets.get(assetId) ?? null
  })
  assert.equal(new TextDecoder().decode(exported.bytes.subarray(0, 5)), '%PDF-')
  assert.ok(exported.bytes.byteLength > 10_000)
  assert.deepEqual(exported.warnings, [])

  const reopened = await pdfjs.getDocument({
    data: exported.bytes,
    isEvalSupported: false,
    verbosity: 0
  }).promise
  let exportedText = ''
  try {
    assert.equal(reopened.numPages, 2, '导出页数必须与源文档一致，不能因整页图片产生空白页')
    exportedText = await extractPdfText(reopened)
  } finally {
    await reopened.destroy()
  }
  assert.match(exportedText, /文档翻译能力验证/u)
  assert.match(exportedText, /扫描页 OCR 译文/u)

  const canvasPackage = require('@napi-rs/canvas/package.json') as { version: string }
  const pdfjsPackage = require('pdfjs-dist/package.json') as { version: string }
  process.stdout.write(JSON.stringify({
    ok: true,
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      modules: process.versions.modules,
      canvas: canvasPackage.version,
      pdfjs: pdfjsPackage.version
    },
    canvasVectorColor,
    parse: {
      pages: source.pages.length,
      blocks: source.pages.reduce((total, page) => total + page.blocks.length, 0),
      assets: source.assets.length,
      nativeText: true,
      scannedPngBytes: scannedBytes.byteLength,
      warnings: source.warnings.map((warning) => warning.code)
    },
    export: {
      bytes: exported.bytes.byteLength,
      pages: reopened.numPages,
      translatedTextSearchable: /文档翻译能力验证/u.test(exportedText),
      ocrTextSearchable: /扫描页 OCR 译文/u.test(exportedText)
    },
    font: {
      bytes: fontBytes.byteLength,
      sha256: createHash('sha256').update(fontBytes).digest('hex')
    }
  }) + '\n')
}

await runSmoke()
