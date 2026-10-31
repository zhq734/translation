import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const font = await document.embedFont(StandardFonts.Helvetica)
const page = document.addPage([600, 800])
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
const image = await document.embedPng(png)
const body = 'A complete paragraph remains in the native text layer and must not be replaced by whole-page OCR.'
page.drawImage(image, { x: 60, y: 80, width: 480, height: 560 })
page.drawText(body, { x: 72, y: 720, size: 12, font })
const model = await parsePdfDocument({ path: '/tmp/text-with-large-image.pdf', fileName: 'text-with-large-image.pdf', format: 'pdf', sha256: 'fixture-sha256', bytes: await document.save() }, {
  renderEmbeddedImageToImage: async () => new Uint8Array([137, 80, 78, 71, 8, 8])
})
for (const block of model.pages[0]!.blocks) {
  console.log(JSON.stringify({ kind: block.kind, bbox: block.bbox, text: block.kind === 'text' ? block.runs.map((run) => run.text).join('') : undefined }, null, 2))
}
console.log('warnings', model.warnings)
