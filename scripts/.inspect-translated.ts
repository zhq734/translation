import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品使用说明-translated.pdf'
const doc = await pdfjs.getDocument({data:new Uint8Array(readFileSync(path)),verbosity:0}).promise
console.log('pages', doc.numPages)
for (const n of [2,3]) {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  console.log('\nPAGE',n,page.getViewport({scale:1}).width,page.getViewport({scale:1}).height)
  for (const item of content.items as any[]) {
    if (!item.str?.trim()) continue
    if (n===2 || /软件|License|产品|前置|中间件/.test(item.str)) console.log(JSON.stringify({str:item.str,x:item.transform?.[4],y:item.transform?.[5],w:item.width,h:item.height,font:item.fontName}))
  }
}
