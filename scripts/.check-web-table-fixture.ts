import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const page = document.addPage([595.92, 842.88])
const font = await document.embedFont(StandardFonts.Helvetica)
const drawY = (y: number): number => page.getHeight() - y
const left = 68
const right = 528
const rowTops = [330, 372, 414, 456]
for (const [row, texts] of [
  ['docs', 'Update docs', 'Last month'],
  ['src', 'Refactor parser', 'Last week'],
  ['tests', 'Add coverage', 'Yesterday']
].entries()) {
  const y = drawY(rowTops[row]! + 22)
  page.drawText(texts[0]!, { x: 78, y, size: 10, font })
  page.drawText(texts[1]!, { x: 220, y, size: 10, font })
  page.drawText(texts[2]!, { x: 455, y, size: 10, font })
}
for (const y of rowTops) {
  page.drawLine({ start: { x: left, y: drawY(y) }, end: { x: right, y: drawY(y) }, thickness: 0.72 })
}
page.drawLine({ start: { x: left, y: drawY(rowTops[0]!) }, end: { x: left, y: drawY(rowTops[rowTops.length - 1]!) }, thickness: 0.72 })
page.drawLine({ start: { x: right, y: drawY(rowTops[0]!) }, end: { x: right, y: drawY(rowTops[rowTops.length - 1]!) }, thickness: 0.72 })

const model = await parsePdfDocument({
  path: '/tmp/web-table-fixture.pdf', fileName: 'web-table-fixture.pdf', format: 'pdf', sha256: 'web-table-fixture', bytes: await document.save()
})
console.log(JSON.stringify(model.pages[0]!.blocks.map((b) => b.kind === 'table'
  ? { kind: b.kind, bbox: b.bbox, widths: b.columnWidths, rows: b.rows.map((r) => r.cells.map((c) => c.blocks.flatMap((x) => x.kind === 'text' ? [x.runs.map((y) => y.text).join('')] : []))) }
  : { kind: b.kind, bbox: b.bbox, text: b.kind === 'text' ? b.runs.map((r) => r.text).join('') : undefined }), null, 2))
