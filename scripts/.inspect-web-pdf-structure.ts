import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')), verbosity: 0 }).promise
for (const n of [1, 2]) {
  const page = await doc.getPage(n)
  const viewport = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  console.log(`\n=== PAGE ${n} viewport ${viewport.width}x${viewport.height} ===`)
  const items = (tc.items as any[]).filter(i => i.str?.trim())
  const lines: any[] = []
  for (const item of items) {
    const bbox = { x: item.transform[4], y: viewport.height - item.transform[5] - (item.height ?? 0), width: item.width, height: item.height }
    const line = lines.find(l => Math.abs(l.bbox.y - bbox.y) <= Math.max(2, Math.min(l.bbox.height, bbox.height) * 0.5))
    if (line) { line.items.push({str:item.str,x:item.transform[4],w:item.width}); line.bbox.x=Math.min(line.bbox.x,bbox.x); line.bbox.width=Math.max(line.bbox.x+line.bbox.width,bbox.x+bbox.width)-line.bbox.x }
    else lines.push({items:[{str:item.str,x:item.transform[4],w:item.width}],bbox})
  }
  for (const line of lines) console.log('LINE', JSON.stringify(line))
  const ops = await page.getOperatorList()
  const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k,v])=>[v,k]))
  console.log('OPS paths of interest')
  for (let i=0;i<ops.fnArray.length;i++) {
    const name = names[ops.fnArray[i]]
    const args = ops.argsArray[i] as any
    if (!['constructPath','stroke','closeStroke','fill','eoFill','fillStroke','closeFillStroke','eoFillStroke','closeEOFillStroke'].includes(name)) continue
    if (name === 'constructPath') {
      const coords = args?.[1] as number[] | undefined
      if (!coords) continue
      // print paths likely around page 1 table y 250..500 / page 2 y 500..900
      if (coords.some((v:any)=>typeof v==='number' && v > 200 && v < 1000)) console.log(i,name,JSON.stringify(args).slice(0,700))
    }
  }
}
