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
  const ops = await page.getOperatorList()
  const images: any[] = []
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i]
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject || fn === pdfjs.OPS.paintImageXObjectRepeat) images.push({ fn, args: ops.argsArray[i] })
  }
  if (images.length > 1 || images.some((x: any) => typeof x.args?.[0] === 'string' && !x.args[0].startsWith('img_p'))) console.log(JSON.stringify({ page: n, images }))
}
