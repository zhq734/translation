import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const page = document.addPage([600, 800])
const font = await document.embedFont(StandardFonts.Helvetica)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64'
)
const image = await document.embedPng(png)
const drawY = (y: number): number => page.getHeight() - y
page.drawText('Certificate', { x: 82, y: drawY(105), size: 12, font })
page.drawText('Barcode', { x: 310, y: drawY(105), size: 12, font })
page.drawImage(image, { x: 360, y: drawY(150), width: 80, height: 40 })
for (const y of [70, 130, 190]) {
  page.drawLine({ start: { x: 72, y: drawY(y) }, end: { x: 528, y: drawY(y) }, thickness: 1 })
}
for (const x of [72, 300, 528]) {
  page.drawLine({ start: { x, y: drawY(190) }, end: { x, y: drawY(70) }, thickness: 1 })
}
const model = await parsePdfDocument({
  path: '/tmp/table-image.pdf',
  fileName: 'table-image.pdf',
  format: 'pdf',
  sha256: 'debug-table-grid',
  bytes: await document.save()
}, {
  renderEmbeddedImageToImage: async () => new Uint8Array(readFileSync('tests/fixtures/ocr-scaling/clear.png'))
})
const tables = model.pages[0]!.blocks.filter((block) => block.kind === 'table')
console.log(JSON.stringify({
  pageSize: [model.pages[0]!.width, model.pages[0]!.height],
  tables: tables.map((block) => block.kind === 'table' ? {
    bbox: block.bbox,
    rows: block.rows.map((row) => row.cells.map((cell) => cell.blocks.map((child) => child.kind))),
    columnWidths: block.columnWidths
  } : null),
  shapes: model.pages[0]!.blocks.filter((block) => block.kind === 'shape').map((block) => block.bbox)
}, null, 2))
