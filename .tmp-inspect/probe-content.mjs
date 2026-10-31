import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
const doc = await PDFDocument.create()
const page = doc.addPage([200, 200])
const font = await doc.embedFont(StandardFonts.Helvetica)
page.drawText('HIDDEN SOURCE', { x: 20, y: 100, size: 12, font, color: rgb(0,0,0), opacity: 0 })
page.drawText('VISIBLE TRANSLATION', { x: 20, y: 60, size: 12, font, color: rgb(0,0,0) })
const bytes = await doc.save()
const loaded = await PDFDocument.load(bytes)
const p = loaded.getPage(0)
const streams = p.node.Contents().asArray().map(ref => loaded.context.lookup(ref))
for (const s of streams) {
  console.log('--- stream ---')
  console.log(JSON.stringify(s.getContentsString ? s.getContentsString() : s.contents))
}
