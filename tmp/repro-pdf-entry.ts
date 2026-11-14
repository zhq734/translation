import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import { createProductionPdfRasterizer } from '../src/main/documentPdfRuntime.ts'
import type { DocumentBlock, DocumentImageBlock } from '../src/shared/documentTypes.ts'

const require = createRequire(import.meta.url)
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

function imageBlocks(blocks: DocumentBlock[]): DocumentImageBlock[] {
  const out: DocumentImageBlock[] = []
  for (const block of blocks) {
    if (block.kind === 'image') out.push(block)
    else if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row.cells) out.push(...imageBlocks(cell.blocks))
    }
  }
  return out
}

/**
 * 将解析阶段注册的图片资源写入临时目录，供真实界面复现脚本按 assetId 读取。
 * @param directory 资源输出目录。
 * @param source 已完成解析的文档模型。
 * @param registered 解析阶段登记的资源字节映射。
 * @returns 无返回值。
 * @author zhenghq
 */
function writeRegisteredAssets(
  directory: string,
  source: Awaited<ReturnType<typeof parsePdfDocument>>,
  registered: ReadonlyMap<string, Uint8Array>
): void {
  mkdirSync(directory, { recursive: true })
  for (const asset of source.assets) {
    const bytes = registered.get(asset.assetId)
    if (!bytes) continue
    writeFileSync(`${directory}/${asset.assetId}`, bytes)
  }
}

async function run(): Promise<void> {
  const file = process.argv[2]!
  const outputDirectory = process.argv[3]
  const bytes = new Uint8Array(readFileSync(file))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const registered = new Map<string, Uint8Array>()
  const rasterizer = await createProductionPdfRasterizer()
  const started = Date.now()
  const source = await parsePdfDocument({
    path: file,
    fileName: file.split('/').pop()!,
    format: 'pdf',
    sha256,
    bytes
  }, {
    renderPageToImage: rasterizer.renderPageToImage,
    renderPageRegionToImage: rasterizer.renderPageRegionToImage,
    registerAssetBytes: (assetId, b) => registered.set(assetId, b)
  })
  console.log('parseMs', Date.now() - started)
  console.log('pages', source.pages.length)
  console.log('assets', source.assets.length, 'registeredBytes', registered.size)
  let total = 0
  const sizes: number[] = []
  for (const asset of source.assets) {
    const b = registered.get(asset.assetId)
    if (b) { total += b.byteLength; sizes.push(b.byteLength) }
  }
  sizes.sort((a, b) => b - a)
  console.log('assetBytesTotalMB', (total / 1024 / 1024).toFixed(1))
  console.log('topAssetBytesMB', sizes.slice(0, 8).map((s) => (s / 1024 / 1024).toFixed(2)).join(', '))
  let allImages = 0
  const pendingPages: number[] = []
  for (const page of source.pages) {
    const imgs = imageBlocks(page.blocks)
    allImages += imgs.length
    if (imgs.some((i) => i.renderPending)) pendingPages.push(page.index + 1)
  }
  console.log('imageBlocks', allImages, 'maxOcrImagesBudget', 200)
  console.log('renderPendingPages', pendingPages.length)
  const page = source.pages[0]!
  console.log('page1 blocks', page.blocks.length, 'imageBlocks', imageBlocks(page.blocks).length)
  if (outputDirectory) {
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(`${outputDirectory}/model.json`, JSON.stringify(source))
    writeRegisteredAssets(`${outputDirectory}/assets`, source, registered)
    for (const page of source.pages.slice(0, Number(process.argv[4] ?? 3))) {
      const pdfPage = await (await pdfjs.getDocument({ data: bytes, disableWorker: true, isEvalSupported: false }).promise)
        .getPage(page.index + 1)
      const viewport = pdfPage.getViewport({ scale: 2 })
      const { createCanvas } = await import('@napi-rs/canvas')
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      await pdfPage.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        background: 'white'
      }).promise
      writeFileSync(`${outputDirectory}/page-${page.index + 1}.png`, canvas.toBuffer('image/png'))
    }
  }
  for (const b of page.blocks) {
    if (b.kind === 'image') {
      const asset = source.assets.find((a) => a.assetId === b.assetId)
      const size = asset ? registered.get(asset.assetId)?.byteLength ?? 0 : 0
      console.log('  img', b.blockId, 'pending', Boolean(b.renderPending), 'bytes', size, 'bbox', JSON.stringify(b.bbox), 'stack', b.stackGroupId ?? '-', b.stackOrder ?? '-')
    } else {
      console.log('  block', b.kind, b.blockId)
    }
  }
}

run().catch((error) => { console.error('FAILED', error); process.exit(1) })
