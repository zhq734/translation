import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')), verbosity: 0 }).promise
for (const pageNumber of [1, 2]) {
  const page = await doc.getPage(pageNumber)
  const ops = await page.getOperatorList()
  const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([key, value]) => [value, key]))
  console.log(`PAGE ${pageNumber}`)
  for (let index = 0; index < ops.fnArray.length; index += 1) {
    const name = names[ops.fnArray[index]!] as string
    if (name !== 'constructPath') continue
    const args = ops.argsArray[index] as any
    const operations = args?.[0] as number[] | undefined
    const coords = args?.[1] as number[] | undefined
    if (!operations || !coords) continue
    if (operations.length === 1 && operations[0] === pdfjs.OPS.rectangle) {
      const [x, y, width, height] = coords
      const pageY = 842.88 - y - height
      if ((pageNumber === 1 && pageY >= 280 && pageY <= 540) || (pageNumber === 2 && pageY >= 580 && pageY <= 820)) {
        console.log(JSON.stringify({ index, x, y: pageY, width, height }))
      }
    }
  }
}
