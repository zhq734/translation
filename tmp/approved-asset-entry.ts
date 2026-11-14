import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { DocumentApprovedResourceService } from '../src/main/documentApprovedResourceService.ts'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import { createProductionPdfRasterizer } from '../src/main/documentPdfRuntime.ts'
import type { DocumentBlock, DocumentImageBlock } from '../src/shared/documentTypes.ts'

const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

function findImageBlock(blocks: DocumentBlock[]): DocumentImageBlock | null {
  for (const block of blocks) {
    if (block.kind === 'image' && block.assetId) return block
    if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row.cells) {
        const found = findImageBlock(cell.blocks)
        if (found) return found
      }
    }
  }
  return null
}

async function run(): Promise<void> {
  const pdfPath = process.argv[2]!
  const statePath = process.argv[3]!
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const tab = state.tabs[1]
  const translation = tab.translation
  const source = translation.source
  const selection = tab.selection
  let pageIndex = 0
  let block: DocumentImageBlock | null = null
  for (const page of translation.pages) {
    block = findImageBlock(page.blocks)
    if (block) break
    pageIndex += 1
  }
  const meta = (translation.assets ?? []).find((a: { assetId?: string }) => a.assetId === block?.assetId)
  const request = {
    path: source.path,
    format: source.format ?? 'pdf',
    sourceSha256: source.sha256 ?? selection.sha256,
    sourceSize: source.size ?? selection.size,
    assetId: block!.assetId!,
    assetSha256: meta?.sha256 ?? '',
    assetByteLength: meta?.byteLength ?? 0,
    pageIndex,
    bbox: block!.bbox
  }
  console.log('[entry] request:', JSON.stringify({
    ...request,
    sourceSha256: request.sourceSha256?.slice(0, 8),
    assetSha256: request.assetSha256.slice(0, 8)
  }))
  const service = new DocumentApprovedResourceService({ isApprovedPath: () => true })
  const t0 = Date.now()
  const result = await service.getAsset(request)
  console.log('[entry] getAsset:', Date.now() - t0, 'ms ok=', result.ok, 'code=', result.code, 'len=', result.bytes?.byteLength)
  if (!result.ok) {
    const bytes = new Uint8Array(readFileSync(pdfPath))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const registered = new Map<string, Uint8Array>()
    const rasterizer = await createProductionPdfRasterizer()
    const t1 = Date.now()
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
      registerAssetBytes: (assetId, assetBytes) => { registered.set(assetId, new Uint8Array(assetBytes)) }
    })
    console.log('[entry] parse:', Date.now() - t1, 'ms pages=', model.pages.length, 'assets=', model.assets.length)
    const parsed = model.assets.find(a => a.assetId === request.assetId)
    console.log('[entry] parsed asset exists:', !!parsed, parsed && { sha: parsed.sha256.slice(0, 8), len: parsed.byteLength, renderPending: block && 'blockRenderPending' in (block as object) ? (block as unknown as { renderPending?: boolean }).renderPending : undefined })
    const match = model.assets.filter(a => Math.abs((a.byteLength ?? 0) - request.assetByteLength) < 3)
    console.log('[entry] same-length assets:', match.slice(0, 3).map(a => ({ id: a.assetId, sha: a.sha256.slice(0, 8), len: a.byteLength })))
    const registeredRequested = registered.get(request.assetId)
    console.log('[entry] registered bytes for request:', registeredRequested?.byteLength)
  }
}

run().catch((error) => { console.error('[entry] fatal:', error); process.exit(1) })
