import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { recognizeAdaptiveOcr } from '../src/main/adaptiveOcr.ts'
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
const sharp = require('sharp') as (input: Buffer) => {
  resize(options: { width: number; height: number; fit: 'fill' }): {
    png(): { toBuffer(): Promise<Buffer> }
  }
}
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

async function resizeToPixelCap(bytes: Uint8Array, cap: number): Promise<Uint8Array> {
  if (cap <= 0 || bytes.byteLength < 24) return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  const pixels = width * height
  if (pixels <= cap) return bytes
  const ratio = Math.sqrt(cap / pixels)
  const output = await sharp(Buffer.from(bytes))
    .resize({ width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), fit: 'fill' })
    .png()
    .toBuffer()
  return new Uint8Array(output)
}

function memory(): string {
  const value = process.memoryUsage()
  return `rss=${(value.rss / 1024 / 1024).toFixed(1)}MB heap=${(value.heapUsed / 1024 / 1024).toFixed(1)}MB external=${(value.external / 1024 / 1024).toFixed(1)}MB`
}

async function run(): Promise<void> {
  const file = process.argv[2]!
  const maxPages = Math.max(1, Number(process.argv[3] ?? 1))
  const maxImages = Math.max(1, Number(process.argv[4] ?? 4))
  const profile = process.argv[5] === 'screenshot' ? 'screenshot' as const : 'document' as const
  const maxScale = Number(process.argv[6] ?? 1)
  const pixelCap = Number(process.argv[7] ?? 0)
  const startIndex = Math.max(0, Number(process.argv[8] ?? 0))
  const disableOrtMemoryArena = process.argv[9] === 'arena-off'
  const bytes = new Uint8Array(readFileSync(file))
  const registered = new Map<string, Uint8Array>()
  const rasterizer = await createProductionPdfRasterizer()
  const started = Date.now()
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
    maxPages
  })
  console.log('parsed', { pages: source.pages.length, assets: source.assets.length, parseMs: Date.now() - started, memory: memory() })

  const models = resolveBundledOcrModelAssets(process.cwd())
  console.log('models', { ready: models.ready, dir: models.modelDir, missing: models.missingFiles })
  const paddle = new PaddleOcrEngine(models.models
    ? {
        models: models.models,
        ...(disableOrtMemoryArena
          ? {
              createOcrNode: async (options) => {
                const module = await import('@gutenye/ocr-node')
                const Ocr = ('default' in module ? module.default : module) as {
                  create(options: unknown): Promise<{ detect(path: string): Promise<never[]> }>
                }
                return Ocr.create({
                  ...options,
                  onnxOptions: {
                    ...(options?.onnxOptions ?? {}),
                    enableCpuMemArena: false,
                    enableMemPattern: false
                  }
                })
              }
            }
          : {})
      }
    : undefined)
  const dispatcher = new OcrDispatcher({ platform: process.platform, engines: { paddle } })
  const allImages = source.pages.flatMap((page) => collectImages(page.blocks).map((block) => ({ page, block })))
  const images = allImages.slice(startIndex, startIndex + maxImages)
  console.log('images', allImages.length, 'probing', images.length, 'startIndex', startIndex, 'profile', profile, 'maxScale', maxScale, 'pixelCap', pixelCap, memory())

  for (const [index, entry] of images.entries()) {
    const asset = source.assets.find((candidate) => candidate.assetId === entry.block.assetId)
    const rawImageBytes = asset ? registered.get(asset.assetId) : undefined
    if (rawImageBytes && process.env.DUMP_IMAGES) {
      const output = `${process.env.DUMP_IMAGES}/pdf-image-${String(index).padStart(2, '0')}-${entry.block.assetId}.png`
      writeFileSync(output, rawImageBytes)
      console.log('dumped', output)
    }
    const imageBytes = rawImageBytes ? await resizeToPixelCap(rawImageBytes, pixelCap) : undefined
    if (!imageBytes) {
      console.log('skip', index, entry.block.assetId, 'bytes unavailable')
      continue
    }
    console.log('start', {
      index,
      page: entry.page.index + 1,
      assetId: entry.block.assetId,
      dimensions: readPngDimensions(imageBytes),
      bytes: imageBytes.byteLength,
      bbox: entry.block.bbox,
      memory: memory()
    })
    const startedAt = Date.now()
    const controller = new AbortController()
    try {
      const result = await recognizeAdaptiveOcr({
        imageBytes,
        maxScale,
        language: 'zh-CN',
        preprocessingProfile: profile
      }, {
        recognize: (preparedImageBytes) => dispatcher.recognize({
          imageBytes: preparedImageBytes,
          language: 'zh-CN',
          timeoutMs: 30_000,
          signal: controller.signal
        }, 'paddle'),
        logger: (event) => console.log('adaptive', { index, event, memory: memory() })
      })
      console.log('done', { index, elapsedMs: Date.now() - startedAt, textLength: result.text.length, memory: memory() })
    } catch (error) {
      console.log('error', {
        index,
        elapsedMs: Date.now() - startedAt,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        memory: memory()
      })
    }
  }
}

run().catch((error) => { console.error('FAILED', error); process.exit(1) })
