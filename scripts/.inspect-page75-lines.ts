import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'

const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule) as any
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
const page = await document.getPage(75)
const viewport = page.getViewport({ scale: 1 })
const ops = await page.getOperatorList()
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([name, value]) => [value, name]))
for (let index = 0; index < ops.fnArray.length; index += 1) {
  const name = names[ops.fnArray[index]!]
  if (!['constructPath', 'transform', 'paintFormXObjectBegin', 'setStrokeRGBColor', 'setFillRGBColor', 'setLineWidth', 'setStrokeColor'].includes(name)) continue
  const args = ops.argsArray[index]
  if (name === 'constructPath') {
    const values = args[1] as number[]
    if (values.some((value) => value >= 70 && value <= 140 || value >= 700 && value <= 770)) {
      console.log(JSON.stringify({ index, name, viewport, args }))
    }
  } else {
    console.log(JSON.stringify({ index, name, args }))
  }
}
