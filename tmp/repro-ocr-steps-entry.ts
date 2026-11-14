import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { createDocumentAdaptiveOcrFallbackImageBytes } from '../src/main/ocrImagePreprocess.ts'
import { createProductionPdfRasterizer } from '../src/main/documentPdfRuntime.ts'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import { OcrDispatcher } from '../src/main/ocrDispatcher.ts'
import { resolveBundledOcrModelAssets } from '../src/main/ocrModelAssets.ts'
import { PaddleOcrEngine } from '../src/main/paddleOcr.ts'
import type { DocumentBlock, DocumentImageBlock } from '../src/shared/documentTypes.ts'

const require = createRequire(import.meta.url)
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker
void require

function collectImages(blocks: readonly DocumentBlock[]): DocumentImageBlock[] {
  const out: DocumentImageBlock[] = []
  for (const block of blocks) {
    if (block.kind === 'image') out.push(block)
    else if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row.cells) out.push(...collectImages(cell.blocks))
    }
  }
  return out
}

function readPngDimensions(bytes: Uint8Array): string {
  if (bytes.byteLength < 24) return 'not-png'
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `${view.getUint32(16, false)}x${view.getUint32(20, false)}`
}

function memory(): string {
  const value = process.memoryUsage()
  return `rss=${(value.rss / 1024 / 1024).toFixed(1)}MB heap=${(value.heapUsed / 1024 / 1024).toFixed(1)}MB external=${(value.external / 1024 / 1024).toFixed(1)}MB`
}

async function run(): Promise<void> {
  const file = process.argv[2]!
  const imageIndex = Math.max(0, Number(process.argv[3] ?? 0))
  const bytes = new Uint8Array(readFileSync(file))
  const registered = new Map<string, Uint8Array>()
  const rasterizer = await createProductionPdfRasterizer()
  const source = await parsePdfDocument({
    path: file,
    fileName: file.split('/').pop()!,
    format: 'pdf',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes
  }, {
    renderPageToImage: rasterizer.renderPageToImage,
    renderPageRegionToImage: rasterizer.renderPageRegionToImage,
    renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
    registerAssetBytes: (assetId, value) => registered.set(assetId, value),
    maxPages: 1
  })
  const image = collectImages(source.pages[0]!.blocks)[imageIndex]!
  const original = registered.get(image.assetId)!
  console.log('image', { imageIndex, assetId: image.assetId, dimensions: readPngDimensions(original), bytes: original.byteLength, memory: memory() })

  const models = resolveBundledOcrModelAssets(process.cwd())
  const paddle = new PaddleOcrEngine(models.models ? { models: models.models } : undefined)
  const dispatcher = new OcrDispatcher({ platform: process.platform, engines: { paddle } })
  const recognize = (value: Uint8Array): Promise<{ text: string }> => dispatcher.recognize({
    imageBytes: value,
    language: 'zh-CN',
    timeoutMs: 30_000
  }, 'paddle')

  console.log('baseline: before recognize', memory())
  try {
    const baseline = await recognize(original)
    console.log('baseline: done', { textLength: baseline.text.length, memory: memory() })
  } catch (error) {
    console.log('baseline: error', error instanceof Error ? `${error.name}:${error.message}` : String(error), memory())
  }

  console.log('fallback: before preprocess', memory())
  const fallback = createDocumentAdaptiveOcrFallbackImageBytes(original, 1)
  console.log('fallback: preprocess done', {
    strategy: fallback.strategy,
    dimensions: readPngDimensions(fallback.imageBytes),
    bytes: fallback.imageBytes.byteLength,
    memory: memory()
  })
  console.log('fallback: before recognize', memory())
  const result = await recognize(fallback.imageBytes)
  console.log('fallback: done', { textLength: result.text.length, memory: memory() })
}

run().catch((error) => { console.error('FAILED', error); process.exit(1) })
