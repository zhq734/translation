import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const require = createRequire(import.meta.url)
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const bytes = readFileSync(path)
const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
const page = await doc.getPage(83)
const content = await page.getTextContent()
const styles = content.styles
for (const item of content.items as any[]) {
  if (!item.str?.trim()) continue
  const style = styles[item.fontName]
  console.log(JSON.stringify({str:item.str, fontName:item.fontName, style, y:item.transform?.[5], x:item.transform?.[4], w:item.width,h:item.height}))
}
