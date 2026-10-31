import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/转换套件产品接口文档 (1).pdf')), verbosity: 0 }).promise
const page = await doc.getPage(83)
const tc = await page.getTextContent()
for (const item of tc.items as any[]) {
  if (!item.str?.trim()) continue
  console.log(JSON.stringify({ s: item.str, t: item.transform, w: item.width, h: item.height, f: item.fontName }))
}
