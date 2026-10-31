import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/web-page-translated.pdf'
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]))
for (let n = 1; n <= 2; n += 1) {
  const page = await doc.getPage(n)
  const viewport = page.getViewport({ scale: 1 })
  const ops = await page.getOperatorList()
  console.log(`\n===== PAGE ${n} viewport=${viewport.width}x${viewport.height} ops=${ops.fnArray.length} =====`)
  let current = viewport.transform
  const stack: any[] = []
  let fillColor = ''
  let strokeColor = ''
  let lineWidth = 1
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const name = names[ops.fnArray[i]]
    const args = ops.argsArray[i]
    if (name === 'save') stack.push({current, fillColor, strokeColor, lineWidth})
    else if (name === 'restore') { const s = stack.pop(); if (s) ({current, fillColor, strokeColor, lineWidth} = s) }
    else if (name === 'transform') current = args[0]
    else if (name === 'paintFormXObjectBegin') { stack.push({current, fillColor, strokeColor, lineWidth}); if (args?.[0]) current = args[0] }
    else if (name === 'paintFormXObjectEnd') { const s = stack.pop(); if (s) ({current, fillColor, strokeColor, lineWidth} = s) }
    else if (name === 'setFillRGBColor') fillColor = `rgb(${args.join(',')})`
    else if (name === 'setStrokeRGBColor') strokeColor = `rgb(${args.join(',')})`
    else if (name === 'setFillGray') fillColor = `gray(${args[0]})`
    else if (name === 'setStrokeGray') strokeColor = `gray(${args[0]})`
    else if (name === 'setLineWidth') lineWidth = args[0]
    else if (['constructPath','stroke','closeStroke','fill','eoFill','fillStroke','closeFillStroke','eoFillStroke','closeEOFillStroke','endPath','clip','eoClip'].includes(name)) {
      console.log(i, name, JSON.stringify(args)?.slice(0, 1600), `fill=${fillColor} stroke=${strokeColor} lw=${lineWidth}`)
    }
  }
}
