import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')), verbosity: 0 }).promise
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([key, value]) => [value, key]))
for (const pageNumber of [1, 2]) {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const ops = await page.getOperatorList()
  const state = { ctm: viewport.transform as number[] }
  const stack: Array<{ ctm: number[] }> = []
  const paths: any[] = []
  let currentSubpath: Array<{ x: number; y: number }> = []
  let currentPath: Array<{ x: number; y: number }> = []
  const multiply = (left: number[], right: number[]) => [
    left[0]! * right[0]! + left[2]! * right[1]!,
    left[1]! * right[0]! + left[3]! * right[1]!,
    left[0]! * right[2]! + left[2]! * right[3]!,
    left[1]! * right[2]! + left[3]! * right[3]!,
    left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
    left[1]! * right[4]! + left[3]! * right[5]! + left[5]!
  ]
  const transformPoint = (x: number, y: number) => {
    const m = state.ctm
    return { x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! }
  }
  const pushPath = (operation: number, args: number[]) => {
    if (operation === pdfjs.OPS.rectangle) {
      const [x, y, width, height] = args
      const p1 = transformPoint(x!, y!)
      const p2 = transformPoint(x! + width!, y! + height!)
      paths.push({ pageNumber, x1: Math.min(p1.x, p2.x), x2: Math.max(p1.x, p2.x), y1: Math.min(p1.y, p2.y), y2: Math.max(p1.y, p2.y), op: 'rectangle' })
      currentPath = [p1, transformPoint(x! + width!, y!), p2, transformPoint(x!, y! + height!)]
    } else if (operation === pdfjs.OPS.moveTo) {
      const p = transformPoint(args[0]!, args[1]!)
      currentSubpath = [p]
      currentPath = [p]
    } else if (operation === pdfjs.OPS.lineTo) {
      const p = transformPoint(args[0]!, args[1]!)
      currentSubpath.push(p)
      currentPath.push(p)
      if (currentSubpath.length === 2) {
        const [a, b] = currentSubpath
        paths.push({ pageNumber, x1: Math.min(a!.x, b!.x), x2: Math.max(a!.x, b!.x), y1: Math.min(a!.y, b!.y), y2: Math.max(a!.y, b!.y), op: 'line' })
        currentSubpath = [b!]
      }
    } else if (operation === pdfjs.OPS.closePath) {
      const first = currentSubpath[0]
      const last = currentSubpath[currentSubpath.length - 1]
      if (first && last) {
        paths.push({ pageNumber, x1: Math.min(first.x, last.x), x2: Math.max(first.x, last.x), y1: Math.min(first.y, last.y), y2: Math.max(first.y, last.y), op: 'close' })
      }
      currentSubpath = []
    }
  }

  for (let index = 0; index < ops.fnArray.length; index += 1) {
    const name = names[ops.fnArray[index]!] as string
    const args = ops.argsArray[index] as any
    if (name === 'save') stack.push({ ctm: [...state.ctm] })
    else if (name === 'restore') { const saved = stack.pop(); if (saved) state.ctm = saved.ctm }
    else if (name === 'transform') state.ctm = multiply(state.ctm, Array.isArray(args[0]) ? args[0] : args)
    else if (name === 'paintFormXObjectBegin') { stack.push({ ctm: [...state.ctm] }); if (args?.[0]) state.ctm = multiply(state.ctm, args[0]) }
    else if (name === 'paintFormXObjectEnd') { const saved = stack.pop(); if (saved) state.ctm = saved.ctm }
    else if (name === 'constructPath') {
      const operations = args?.[0] as number[] | undefined
      const coordinates = args?.[1] as number[] | undefined
      if (!operations || !coordinates) continue
      let offset = 0
      for (const operation of operations) {
        if (operation === pdfjs.OPS.rectangle) { pushPath(operation, coordinates.slice(offset, offset + 4)); offset += 4 }
        else if (operation === pdfjs.OPS.moveTo || operation === pdfjs.OPS.lineTo) { pushPath(operation, coordinates.slice(offset, offset + 2)); offset += 2 }
        else if (operation === pdfjs.OPS.curveTo) { offset += 6; currentSubpath = [] }
        else if (operation === pdfjs.OPS.curveTo2 || operation === pdfjs.OPS.curveTo3) { offset += 4; currentSubpath = [] }
        else if (operation === pdfjs.OPS.closePath) pushPath(operation, [])
      }
    }
  }
  const range = pageNumber === 1 ? [240, 530] : [500, 830]
  console.log(`\nPAGE ${pageNumber} horizontal in y ${range.join('..')}`)
  for (const path of paths.filter((item) => item.y1 === item.y2 && item.y1 >= range[0]! && item.y1 <= range[1]! && item.x2 - item.x1 >= 5)) {
    console.log(JSON.stringify({ ...path, x1: +path.x1.toFixed(2), x2: +path.x2.toFixed(2), y1: +path.y1.toFixed(2) }))
  }
  console.log(`PAGE ${pageNumber} vertical in x 0..600, y ${range.join('..')}`)
  for (const path of paths.filter((item) => item.x1 === item.x2 && item.y1 >= range[0]! && item.y2 <= range[1]! && item.y2 - item.y1 >= 5)) {
    console.log(JSON.stringify({ ...path, x1: +path.x1.toFixed(2), y1: +path.y1.toFixed(2), y2: +path.y2.toFixed(2) }))
  }
}
