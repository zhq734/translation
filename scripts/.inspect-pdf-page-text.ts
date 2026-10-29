import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
for (let n = 1; n <= doc.numPages; n += 1) {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  const lines: string[] = []
  for (const item of content.items as any[]) {
    if (!item.str?.trim()) continue
    const x = item.transform?.[4] ?? 0
    const y = page.view[3] - (item.transform?.[5] ?? 0)
    lines.push(`${Math.round(x)},${Math.round(y)}:${item.str}`)
  }
  const text = lines.join(' | ')
  if (/证书份数|材料类型|流水号|软件著作权|登记申请/.test(text)) console.log(`PAGE ${n}\n${text}\n`)
}
