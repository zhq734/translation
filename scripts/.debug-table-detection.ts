import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument, detectPdfTextRowTableGrids, groupPdfRawHorizontalRowLines } from '../src/main/documentPdfParser'
const document=await PDFDocument.create();const page=document.addPage([595.92,842.88]);const font=await document.embedFont(StandardFonts.Helvetica);const drawY=(y:number)=>page.getHeight()-y
const left=68,right=528,rowTops=[330,372,414,456];const rows=[['docs','Update docs','Last month'],['src','Refactor parser','Last week'],['tests','Add coverage','Yesterday']]
rows.forEach((t,i)=>{const y=drawY(rowTops[i]!+22);page.drawText(t[0]!,{x:78,y,size:10,font});page.drawText(t[1]!,{x:220,y,size:10,font});page.drawText(t[2]!,{x:455,y,size:10,font})})
for(const y of rowTops)page.drawLine({start:{x:left,y:drawY(y)},end:{x:right,y:drawY(y)},thickness:.72})
page.drawLine({start:{x:left,y:drawY(rowTops[0]!)},end:{x:left,y:drawY(rowTops[3]!)},thickness:.72});page.drawLine({start:{x:right,y:drawY(rowTops[0]!)},end:{x:right,y:drawY(rowTops[3]!)},thickness:.72})
const m=await parsePdfDocument({path:'/tmp/x.pdf',fileName:'x.pdf',format:'pdf',sha256:'a'.repeat(64),bytes:await document.save()});console.dir(m.pages[0]!.blocks,{depth:1})
