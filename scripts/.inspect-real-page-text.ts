import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'

const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
const worker: any = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
for (const pageNumber of [72, 75, 78]) {
  const page = await document.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const lines = new Map<number, Array<{ x: number; y: number; text: string; width: number }>>()
  for (const item of content.items as any[]) {
    if (!item.str?.trim()) continue
    const tx = pdfjs.Util.transform(viewport.transform, item.transform)
    const y = Math.round(tx[5] * 10) / 10
    const key = Math.round(y / 2) * 2
    const entries = lines.get(key) ?? []
    entries.push({ x: Math.round(tx[4] * 10) / 10, y, text: item.str, width: Math.round(item.width * 10) / 10 })
    lines.set(key, entries)
  }
  console.log(`\nPAGE ${pageNumber}`)
  for (const entries of [...lines.values()].sort((left, right) => left[0]!.y - right[0]!.y)) {
    console.log(entries.map((entry) => `${entry.x},${entry.y}:${entry.text}`).join(' | '))
  }
}
