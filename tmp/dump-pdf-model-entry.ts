import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import { createProductionPdfRasterizer } from '../src/main/documentPdfRuntime.ts'

// 与 DocumentApprovedResourceService.parsePdfAssetContext 保持完全一致的解析参数，
// 保证导出的图片资源标识与恢复态重新解析结果一致。
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

async function run(): Promise<void> {
  const pdfPath = process.argv[2]!
  const outputDirectory = process.argv[3]!
  const bytes = new Uint8Array(readFileSync(pdfPath))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const registered = new Map<string, Uint8Array>()
  const rasterizer = await createProductionPdfRasterizer()
  const started = Date.now()
  const model = await parsePdfDocument({
    path: pdfPath,
    fileName: pdfPath.split('/').pop()!,
    format: 'pdf',
    sha256,
    bytes
  }, {
    renderPageToImage: rasterizer.renderPageToImage,
    renderPageRegionToImage: rasterizer.renderPageRegionToImage,
    renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
    registerAssetBytes: (assetId, assetBytes) => {
      if (assetId && assetBytes.byteLength > 0) registered.set(assetId, new Uint8Array(assetBytes))
    }
  })
  mkdirSync(outputDirectory, { recursive: true })
  writeFileSync(join(outputDirectory, 'model.json'), JSON.stringify(model))
  writeFileSync(join(outputDirectory, 'timings.txt'),
    `parse ${Date.now() - started}ms pages ${model.pages.length} assets ${model.assets.length} registered ${registered.size}`)
  console.log('parse', Date.now() - started, 'ms pages', model.pages.length, 'assets', model.assets.length)
}

run().catch((error) => { console.error(error); process.exit(1) })
