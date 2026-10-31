import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const bytes=readFileSync('/Users/mac/Downloads/转换套件产品接口文档 (1).pdf')
const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0}).promise
const page=await doc.getPage(83)
const content=await page.getTextContent()
for (const item of content.items) {
  if (!('str' in item)) continue
  const s=item.str
  if (s.includes('HTTPAgent') || s.includes('final') || s.includes('new') || s.includes('agent') || s.trim()==='') console.log(JSON.stringify({str:s,transform:item.transform,width:item.width,height:item.height,fontName:item.fontName}))
}
