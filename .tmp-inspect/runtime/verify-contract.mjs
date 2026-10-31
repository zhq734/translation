import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from './documentPdfParser.js'
import { createProductionPdfRasterizer } from './documentPdfRuntime.js'

const sourcePath = '/Users/mac/Downloads/附件D10：采购合同-安柏.pdf'
const bytes = new Uint8Array(await readFile(sourcePath))
const assetBytes = new Map()
const rasterizer = await createProductionPdfRasterizer()
const model = await parsePdfDocument({
  path: sourcePath,
  fileName: '附件D10：采购合同-安柏.pdf',
  format: 'pdf',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes
}, {
  renderPageToImage: rasterizer.renderPageToImage,
  renderPageRegionToImage: rasterizer.renderPageRegionToImage,
  renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
  registerAssetBytes: (assetId, content) => assetBytes.set(assetId, content)
})
console.log(JSON.stringify({
  pages: model.pages.length,
  assets: model.assets.length,
  blockKinds: model.pages.map(page => page.blocks.map(block => block.kind)),
  imageBlocks: model.pages.flatMap(page => page.blocks.filter(block => block.kind === 'image').map(block => ({ bbox: block.bbox, regions: block.ocrRegions?.length ?? 0, renderPending: block.renderPending }))),
  warnings: model.warnings
}, null, 2))
await writeFile('.tmp-inspect/runtime/document-contract-model.json', JSON.stringify(model, null, 2))
console.log('assetBytes', assetBytes.size, [...assetBytes].map(([id, value]) => [id, value.length]))
