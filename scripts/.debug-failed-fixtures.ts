import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

async function webTable(kind: 'frame' | 'row' | 'long' | 'segmented') {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  if (kind === 'segmented') {
    const cb = [51, 252, 452, 552]
    const rowTops = [608, 649, 690, 731]
    const rows = [['name','description','updated'],['alpha','first package','today'],['beta','second package','yesterday']]
    rows.forEach((texts, i) => { const y=drawY(rowTops[i]!+22); page.drawText(texts[0]!,{x:61,y,size:10,font}); page.drawText(texts[1]!,{x:262,y,size:10,font}); page.drawText(texts[2]!,{x:462,y,size:10,font}) })
    for(const y of rowTops) for(let i=0;i<3;i++) page.drawLine({start:{x:cb[i]!,y:drawY(y)},end:{x:cb[i+1]!,y:drawY(y)},thickness:.72})
    page.drawLine({start:{x:cb[0]!,y:drawY(rowTops[0]!)},end:{x:cb[0]!,y:drawY(rowTops[3]!)},thickness:.72})
    page.drawLine({start:{x:cb[3]!,y:drawY(rowTops[0]!)},end:{x:cb[3]!,y:drawY(rowTops[3]!)},thickness:.72})
  } else {
    const left=kind==='frame'?68:53, right=kind==='frame'?528:543, rowTops=[330,372,414,456]
    const first=kind==='long'?'requirements-desktop-verification':'docs'
    const rows=[[first,'Update docs','Last month'],[first,'Refactor parser','Last week'],[first,'Add coverage','Yesterday']]
    rows.forEach((texts,i)=>{const y=drawY(rowTops[i]!+22);page.drawText(texts[0]!,{x:kind==='frame'?78:74,y,size:10,font});page.drawText(texts[1]!,{x:kind==='frame'?220:212,y,size:10,font});page.drawText(texts[2]!,{x:kind==='frame'?455:445,y,size:10,font})})
    for(const y of rowTops) page.drawLine({start:{x:left,y:drawY(y)},end:{x:right,y:drawY(y)},thickness:.72})
    if(kind==='frame'){page.drawLine({start:{x:left,y:drawY(rowTops[0]!)},end:{x:left,y:drawY(rowTops[3]!)},thickness:.72});page.drawLine({start:{x:right,y:drawY(rowTops[0]!)},end:{x:right,y:drawY(rowTops[3]!)},thickness:.72})}
  }
  const model=await parsePdfDocument({path:'/tmp/debug.pdf',fileName:'debug.pdf',format:'pdf',sha256:'x',bytes:await document.save()})
  console.log(kind, JSON.stringify(model.pages[0]!.blocks.filter(b=>b.kind==='table').map(t=>t.kind==='table'?{bbox:t.bbox,rows:t.rows.map(r=>r.cells.map(c=>c.blocks.map(b=>b.kind==='text'?b.runs.map(r=>r.text).join(''):b.kind))),widths:t.columnWidths}:null)))
}
for(const kind of ['frame','row','long','segmented'] as const) await webTable(kind)
