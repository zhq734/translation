import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const page = document.addPage([595.3, 841.9])
const font = await document.embedFont(StandardFonts.Courier)
const drawY = (y: number): number => page.getHeight() - y
const left = 89.14
const right = 517.29
for (const [index, line] of ['public interface Converter {', '  String convert(String value);', '}'].entries()) {
  page.drawText(line, { x: 102, y: drawY(535 + index * 18), size: 9, font })
}
page.drawLine({ start: { x: left, y: drawY(82) }, end: { x: left, y: drawY(703) }, thickness: 1 })
page.drawLine({ start: { x: right, y: drawY(82) }, end: { x: right, y: drawY(703) }, thickness: 1 })
page.drawLine({ start: { x: left, y: drawY(81.1) }, end: { x: right, y: drawY(81.1) }, thickness: 1 })
page.drawLine({ start: { x: left, y: drawY(125.75) }, end: { x: right, y: drawY(125.75) }, thickness: 1 })
page.drawLine({ start: { x: left, y: drawY(496.45) }, end: { x: right, y: drawY(496.45) }, thickness: 1 })
page.drawLine({ start: { x: left, y: drawY(540.25) }, end: { x: right, y: drawY(540.25) }, thickness: 1 })
const model = await parsePdfDocument({ path: '/tmp/open-code-container.pdf', fileName: 'open-code-container.pdf', format: 'pdf', sha256: 'fixture-sha256', bytes: await document.save() })
console.log(JSON.stringify(model.pages[0]!.blocks, null, 2))
