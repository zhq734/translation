import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'

const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise

for (const pageNumber of [5, 6, 72, 75, 77, 78, 79]) {
  const page = await document.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const operatorList = await page.getOperatorList()
  const imageOps: unknown[] = []
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index]
    if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintInlineImageXObject &&
      fn !== pdfjs.OPS.paintImageMaskXObject && fn !== pdfjs.OPS.paintImageXObjectRepeat) continue
    imageOps.push({ index, fn, args: operatorList.argsArray[index] })
  }
  const text = await page.getTextContent()
  const textBboxes = text.items.filter((item: any) => item.str.trim()).map((item: any) => {
    const tx = pdfjs.Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    const width = item.width * viewport.scale
    return { text: item.str, x: tx[4], y: tx[5] - fontHeight, width, height: fontHeight }
  })
  console.log(`\nPAGE ${pageNumber} viewport=${viewport.width}x${viewport.height}`)
  console.log(JSON.stringify({ imageOps, textBboxes }, null, 2))
}
