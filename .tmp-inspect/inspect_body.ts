import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'
const document = await PDFDocument.create(); const font = await document.embedFont(StandardFonts.Helvetica); const page = document.addPage([600,800])
const lines=['The first body line contains enough text to establish a normal text layer.','The second body line continues the report with meaningful document content.','The third body line keeps the page readable without invoking OCR.','The fourth body line closes the paragraph for this layout fixture.']
page.drawText('Quarterly report',{x:72,y:760,size:10,font}); lines.forEach((line,i)=>page.drawText(line,{x:72,y:700-i*24,size:12,font})); page.drawText('1',{x:294,y:28,size:10,font})
const model=await parsePdfDocument({path:'/tmp/x.pdf',fileName:'x.pdf',format:'pdf',sha256:'x',bytes:await document.save()})
for(const b of model.pages[0]!.blocks) console.log(b.kind,b.bbox,b.kind==='text'?b.runs.map(r=>r.text).join(''):'')
