import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createProductionPdfRasterizer } from './documentPdfRuntime.js'
import { parsePdfDocument } from './documentPdfParser.js'
import { PaddleOcrEngine } from '../../../out/main/index.js'

const sourcePath = '/Users/mac/Downloads/用户中心-20261012.pdf'
const bytes = new Uint8Array(await readFile(sourcePath))
const assets = new Map()
const rasterizer = await createProductionPdfRasterizer()
const model = await parsePdfDocument({
  path: sourcePath,
  fileName: '用户中心-20261012.pdf',
  format: 'pdf',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes
}, {
  renderPageToImage: rasterizer.renderPageToImage,
  renderPageRegionToImage: rasterizer.renderPageRegionToImage,
  renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
  registerAssetBytes: (assetId, content) => assets.set(assetId, content)
})

const image = model.pages[0].blocks[0].rows[0].cells[1].blocks[0]
console.log('image', JSON.stringify({ blockId: image.blockId, bbox: image.bbox, assetId: image.assetId, bytes: assets.get(image.assetId)?.length }, null, 2))
const imagePath = '.tmp-inspect/runtime/user-logo.png'
await writeFile(imagePath, assets.get(image.assetId))

const engine = new PaddleOcrEngine({
  models: {
    detection: './assets/ocr/ppocrv6_tiny/det.onnx',
    recognition: './assets/ocr/ppocrv6_tiny/rec.onnx',
    characters: './assets/ocr/ppocrv6_tiny/dict.txt'
  }
})
try {
  const result = await engine.recognize({
    imageBytes: assets.get(image.assetId),
    language: 'zh-CN',
    timeoutMs: 30_000,
    signal: new AbortController().signal
  })
  console.log('result', JSON.stringify(result, null, 2))
} catch (error) {
  console.error('ocr error', error)
} finally {
  engine.dispose?.()
}
