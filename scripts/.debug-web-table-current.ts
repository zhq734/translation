import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'
for (const variant of ['sides','rowonly','long','segments'] as const) {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const rowTops = variant === 'segments' ? [608, 649, 690, 731] : [330, 372, 414, 456]
  const left = variant === 'segments' ? 51 : variant === 'rowonly' || variant === 'long' ? 53 : 68
  const right = variant === 'segments' ? 552 : variant === 'rowonly' || variant === 'long' ? 543 : 528
  const rows = variant === 'long'
    ? [['requirements-desktop-verification','Main','Last month'],['requirements-desktop-verification','Docs','Last week'],['requirements-desktop-verification','Tests','Yesterday']]
    : [['docs','Update docs','Last month'],['src','Refactor parser','Last week'],['tests','Add coverage','Yesterday']]
  const xs = variant === 'segments' ? [61,262,462] : variant === 'rowonly' || variant === 'long' ? [74,212,445] : [78,220,455]
  rows.forEach((texts,rowIndex)=>{const y=drawY(rowTops[rowIndex]!+22);texts.forEach((text,i)=>page.drawText(text,{x:xs[i]!,y,size:10,font}))})
  if (variant === 'segments') {
    const bs=[51,252,452,552]
    for(const y of rowTops) for(let i=0;i<bs.length-1;i++) page.drawLine({start:{x:bs[i]!,y:drawY(y)},end:{x:bs[i+1]!,y:drawY(y)},thickness:.72})
    page.drawLine({start:{x:bs[0]!,y:drawY(rowTops[0]!)},end:{x:bs[0]!,y:drawY(rowTops.at(-1)!)},thickness:.72})
    page.drawLine({start:{x:bs.at(-1)!,y:drawY(rowTops[0]!)},end:{x:bs.at(-1)!,y:drawY(rowTops.at(-1)!)},thickness:.72})
  } else {
    for(const y of rowTops) page.drawLine({start:{x:left,y:drawY(y)},end:{x:right,y:drawY(y)},thickness:.72})
    if(variant==='sides') { page.drawLine({start:{x:left,y:drawY(rowTops[0]!)},end:{x:left,y:drawY(rowTops.at(-1)!)},thickness:.72}); page.drawLine({start:{x:right,y:drawY(rowTops[0]!)},end:{x:right,y:drawY(rowTops.at(-1)!)},thickness:.72}) }
  }
  const model=await parsePdfDocument({path:`/tmp/${variant}.pdf`,fileName:`${variant}.pdf`,format:'pdf',sha256:variant,bytes:await document.save()})
  const tables=model.pages[0]!.blocks.filter(b=>b.kind==='table')
  console.log('\nVARIANT',variant,'tables',tables.length)
  for(const table of tables) if(table.kind==='table') console.log(JSON.stringify({bbox:table.bbox,widths:table.columnWidths,rows:table.rows.map(r=>r.cells.map(c=>c.blocks.map(b=>b.kind==='text'?b.runs.map(r=>r.text).join(''):b.kind)))},null,2))
  console.log('shapes',model.pages[0]!.blocks.filter(b=>b.kind==='shape').length)
}
