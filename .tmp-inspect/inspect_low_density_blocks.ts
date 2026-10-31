import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'
const document = await PDFDocument.create()
const font = await document.embedFont(StandardFonts.Helvetica)
const page = document.addPage([600, 800])
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
const image = await document.embedPng(png)
page.drawImage(image, { x: 60, y: 80, width: 480, height: 640 })
page.drawText('Quarterly report', { x: 72, y: 760, size: 10, font })
page.drawText('1', { x: 294, y: 28, size: 10, font })
const model = await parsePdfDocument({ path: '/tmp/low.pdf', fileName: 'low.pdf', format: 'pdf', sha256: 'fixture', bytes: await document.save() }, { renderEmbeddedImageToImage: async () => new Uint8Array([137,80,78,71]) })
for (const b of model.pages[0]!.blocks) console.log(b.kind, b.bbox, b.kind === 'text' ? b.runs.map(r=>r.text).join('') : '')
