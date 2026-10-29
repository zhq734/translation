import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')), verbosity: 0 }).promise
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([key, value]) => [value, key]))
const multiply = (left: number[], right: number[]) => [
  left[0]! * right[0]! + left[2]! * right[1]!,
  left[1]! * right[0]! + left[3]! * right[1]!,
  left[0]! * right[2]! + left[2]! * right[3]!,
  left[1]! * right[2]! + left[3]! * right[3]!,
  left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
  left[1]! * right[4]! + left[3]! * right[5]! + left[5]!
]
for (const pageNumber of [1, 2]) {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const ops = await page.getOperatorList()
  let ctm = viewport.transform as number[]
  const stack: number[][] = []
  let pending: Array<{ orientation: 'horizontal' | 'vertical'; start: number; end: number; position: number }> = []
  const point = (x: number, y: number) => ({ x: ctm[0]! * x + ctm[2]! * y + ctm[4]!, y: ctm[1]! * x + ctm[3]! * y + ctm[5]! })
  const addLine = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.abs(a.x - b.x); const dy = Math.abs(a.y - b.y)
    if (dx <= 0.75 && dy >= 8) pending.push({ orientation: 'vertical', start: Math.min(a.y, b.y), end: Math.max(a.y, b.y), position: (a.x + b.x) / 2 })
    else if (dy <= 0.75 && dx >= 8) pending.push({ orientation: 'horizontal', start: Math.min(a.x, b.x), end: Math.max(a.x, b.x), position: (a.y + b.y) / 2 })
  }
  const lines: any[] = []
  for (let index = 0; index < ops.fnArray.length; index += 1) {
    const name = names[ops.fnArray[index]!] as string
    const args = ops.argsArray[index] as any
    if (name === 'save') { stack.push([...ctm]); continue }
    if (name === 'restore') { ctm = stack.pop() ?? (viewport.transform as number[]); continue }
    if (name === 'transform') { ctm = multiply(ctm, Array.isArray(args[0]) ? args[0] : args); continue }
    if (name === 'paintFormXObjectBegin') { stack.push([...ctm]); if (args?.[0]) ctm = multiply(ctm, args[0]); continue }
    if (name === 'paintFormXObjectEnd') { ctm = stack.pop() ?? (viewport.transform as number[]); continue }
    if (name === 'stroke' || name === 'closeStroke' || name === 'fillStroke' || name === 'eoFillStroke' || name === 'closeFillStroke' || name === 'closeEOFillStroke') { lines.push(...pending); pending = []; continue }
    if (name !== 'constructPath') continue
    pending = []
    const operations = args?.[0] as number[] | undefined
    const coordinates = args?.[1] as number[] | undefined
    if (!operations || !coordinates) continue
    let offset = 0; let cursor: { x: number; y: number } | undefined
    for (const operation of operations) {
      if (operation === pdfjs.OPS.rectangle) {
        const [x, y, width, height] = coordinates.slice(offset, offset + 4) as number[]; offset += 4
        const p1 = point(x!, y!); const p2 = point(x! + width!, y!); const p3 = point(x! + width!, y! + height!); const p4 = point(x!, y! + height!)
        addLine(p1, p2); addLine(p2, p3); addLine(p3, p4); addLine(p4, p1)
      } else if (operation === pdfjs.OPS.moveTo) { cursor = point(coordinates[offset]!, coordinates[offset + 1]!); offset += 2 }
      else if (operation === pdfjs.OPS.lineTo) { const next = point(coordinates[offset]!, coordinates[offset + 1]!); offset += 2; if (cursor) addLine(cursor, next); cursor = next }
      else if (operation === pdfjs.OPS.closePath) { if (cursor) addLine(cursor, point(coordinates[0]!, coordinates[1]!)); cursor = undefined }
      else if (operation === pdfjs.OPS.curveTo) { offset += 6; cursor = undefined }
      else if (operation === pdfjs.OPS.curveTo2 || operation === pdfjs.OPS.curveTo3) { offset += 4; cursor = undefined }
    }
  }
  console.log(`\nPAGE ${pageNumber}`)
  const range = pageNumber === 1 ? [240, 820] : [580, 830]
  for (const line of lines.filter((item) => item.position >= range[0]! && item.position <= range[1]!)) {
    console.log(JSON.stringify({ ...line, start: +line.start.toFixed(2), end: +line.end.toFixed(2), position: +line.position.toFixed(2) }))
  }
}
