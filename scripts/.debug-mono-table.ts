import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const page = document.addPage([595.3, 841.9])
const font = await document.embedFont(StandardFonts.Courier)
const drawY = (y: number): number => page.getHeight() - y
const left = 89.14
const right = 517.29
const columnX = [left, 230, right]
const rowY = [120, 160, 200, 240]
const cells = [
  ['Method', 'Description'],
  ['GET', '/api/users'],
  ['POST', '/api/users'],
  ['DELETE', '/api/users/{id}']
]
cells.forEach((row, rowIndex) => {
  page.drawText(row[0]!, { x: columnX[0]! + 12, y: drawY(rowY[rowIndex]! + 25), size: 10, font })
  page.drawText(row[1]!, { x: columnX[1]! + 12, y: drawY(rowY[rowIndex]! + 25), size: 10, font })
})
for (const y of rowY) {
  page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 1 })
}
for (const x of columnX) {
  page.drawLine({ start: { x, y: drawY(rowY[0]!) }, end: { x, y: drawY(rowY[rowY.length - 1]!) }, thickness: 1 })
}

const model = await parsePdfDocument({
  path: '/tmp/monospace-table.pdf',
  fileName: 'monospace-table.pdf',
  format: 'pdf',
  sha256: 'fixture-sha256',
  bytes: await document.save()
})
console.dir(model.pages[0]!.blocks, { depth: 8 })
