import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { exportDocumentToPdf } from '../src/main/documentPdfExport.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'

const require = createRequire(import.meta.url)
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

const reproRoot = '/tmp/translation-pdf-repro-current'
const model = JSON.parse(readFileSync(`${reproRoot}/model.json`, 'utf8')) as DocumentModel
const targetPage = model.pages.find((page) => page.pageId === 'page-7bde9159df0d')
if (!targetPage) throw new Error('找不到目标第 7 页模型')

const exported = await exportDocumentToPdf(model, {
  loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
  loadAssetBytes: async (assetId) => {
    try {
      return readFileSync(`${reproRoot}/assets/${assetId}`)
    } catch {
      return null
    }
  }
})
const pdfPath = `${reproRoot}/table-stack-export.pdf`
writeFileSync(pdfPath, exported.bytes)

const pdf = await pdfjs.getDocument({
  data: exported.bytes,
  isEvalSupported: false,
  verbosity: 0
}).promise
try {
  let targetPageNumber = 0
  let targetText = ''
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const candidate = await pdf.getPage(pageNumber)
    const candidateContent = await candidate.getTextContent()
    const candidateText = candidateContent.items
      .filter((item): item is typeof item & { str: string } => 'str' in item)
      .map((item) => item.str)
      .join('')
    if (candidateText.includes('进入下一阶段前必须满足的条件')) {
      targetPageNumber = pageNumber
      targetText = candidateText
      break
    }
  }
  if (targetPageNumber === 0) throw new Error('导出 PDF 中找不到表格叠图所在页面')

  const page = await pdf.getPage(targetPageNumber)
  const operatorList = await page.getOperatorList()
  const imageOperations = operatorList.fnArray.filter(
    (operation) => operation === pdfjs.OPS.paintImageXObject || operation === pdfjs.OPS.paintInlineImageXObject
  ).length
  const imageIndices = operatorList.fnArray
    .map((operation, index) => operation === pdfjs.OPS.paintImageXObject ? index : -1)
    .filter((index) => index >= 0)
  const lastImageIndex = imageIndices.at(-1) ?? -1
  const textIndex = operatorList.fnArray
    .slice(lastImageIndex + 1)
    .findIndex((operation) => operation === pdfjs.OPS.showText) + lastImageIndex + 1
  const maskColors = operatorList.fnArray
    .slice(lastImageIndex + 1, textIndex)
    .map((operation, offset) => ({
      operation,
      index: lastImageIndex + 1 + offset
    }))
    .filter((entry) => entry.operation === pdfjs.OPS.setFillRGBColor)
    .map((entry) => operatorList.argsArray[entry.index])

  const viewport = page.getViewport({ scale: 2 })
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    background: 'white'
  }).promise
  writeFileSync(`${reproRoot}/table-stack-export-page-7.png`, canvas.toBuffer('image/png'))

  const cropLeft = 45 * 2
  const cropTop = 180 * 2
  const cropWidth = 500 * 2
  const cropHeight = 440 * 2
  const crop = createCanvas(cropWidth, cropHeight)
  crop.getContext('2d').drawImage(canvas, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  writeFileSync(`${reproRoot}/table-stack-export-cell.png`, crop.toBuffer('image/png'))

  process.stdout.write(JSON.stringify({
    pdfPath,
    bytes: exported.bytes.byteLength,
    sha256: createHash('sha256').update(exported.bytes).digest('hex'),
    pages: pdf.numPages,
    targetPageNumber,
    imageOperations,
    maskColors,
    targetTextPresent: targetText.includes('进入下一阶段前必须满足的条件，不满足就停下来'),
    targetText,
    screenshots: [
      `${reproRoot}/table-stack-export-page-7.png`,
      `${reproRoot}/table-stack-export-cell.png`
    ],
    warnings: exported.warnings
  }, null, 2) + '\n')
} finally {
  await pdf.destroy()
}
