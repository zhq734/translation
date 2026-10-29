import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const bytes = readFileSync('/Users/mac/Downloads/转换套件产品接口文档 (1).pdf')
const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  const text = content.items.map((item: any) => 'str' in item ? item.str : '').join('')
  if (/证书份数|材料类型|流水号|登记申请表/.test(text)) {
    const viewport = page.getViewport({ scale: 1 })
    const ops = await page.getOperatorList()
    console.log(JSON.stringify({ pageNumber, width: viewport.width, height: viewport.height, text: text.slice(0, 500) }))
  }
}
