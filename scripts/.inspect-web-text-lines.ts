import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')), verbosity: 0 }).promise
for (const pageNumber of [1, 2]) {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const pageHeight = viewport.height
  const lineBbox = (item: any) => ({ x: item.transform[4], y: pageHeight - item.transform[5] - (item.height ?? 0), width: item.width ?? 0, height: item.height ?? 0 })
  const items = (content.items as any[]).filter((item) => item.str?.trim()).map((item) => {
    return { str: item.str, ...lineBbox(item) }
  }).sort((left, right) => left.y - right.y || left.x - right.x)
  const lines: any[] = []
  for (const item of items) {
    const line = lines.find((candidate) => Math.abs(candidate.bbox.y - item.y) <= Math.max(2, Math.min(candidate.bbox.height, item.height) * 0.5))
    if (line) {
      line.items.push(item)
      line.bbox.x = Math.min(line.bbox.x, item.x)
      line.bbox.width = Math.max(line.bbox.x + line.bbox.width, item.x + item.width) - line.bbox.x
      line.bbox.height = Math.max(line.bbox.height, item.height)
    } else lines.push({ bbox: { x: item.x, y: item.y, width: item.width, height: item.height }, items: [item] })
  }
  console.log(`\nPAGE ${pageNumber}`)
  for (const line of lines) {
    const starts: number[] = []
    let clusterRight: number | undefined
    for (const item of [...line.items].sort((a, b) => a.x - b.x)) {
      const gap = clusterRight === undefined ? Infinity : item.x - clusterRight
      if (gap > Math.max(8, item.height * 1.8)) starts.push(+item.x.toFixed(1))
      clusterRight = Math.max(clusterRight ?? item.x, item.x + item.width)
    }
    console.log(JSON.stringify({ y: +line.bbox.y.toFixed(1), x: +line.bbox.x.toFixed(1), w: +line.bbox.width.toFixed(1), starts, text: line.items.map((item: any) => item.str).join('') }))
  }
}
