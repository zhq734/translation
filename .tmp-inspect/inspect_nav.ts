import { PDFDocument, StandardFonts } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const font = await document.embedFont(StandardFonts.Helvetica)
const page = document.addPage([600, 800])
const items = ['Code', 'Issues', 'Pull requests', 'Actions', 'Projects']
const positions = [54, 98, 148, 280, 350]
items.forEach((item, index) => page.drawText(item, { x: positions[index]!, y: 730, size: 10, font }))
const bytes = await document.save()
const model = await parsePdfDocument({ path:'/tmp/x.pdf', fileName:'x.pdf', format:'pdf', sha256:'fixture-sha256', bytes })
for (const b of model.pages[0].blocks) {
  if (b.kind !== 'text') continue
  console.log('x=', Math.round(b.bbox.x*10)/10, 'w=', Math.round(b.bbox.width*10)/10, 'flow=', b.flowGroupId, 'text=', b.runs.map(r=>r.text).join(''))
}
