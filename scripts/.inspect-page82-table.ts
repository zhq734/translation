import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const model = await parsePdfDocument({ path, fileName: 'doc.pdf', format: 'pdf', sha256: 'inspect', bytes: readFileSync(path) })
const page = model.pages[81]!
console.log('PAGE BLOCKS')
for (const block of page.blocks) {
  if (block.kind === 'table') {
    console.log(JSON.stringify({ kind: block.kind, bbox: block.bbox, columns: block.columnWidths, rows: block.rows.map((row) => row.cells.map((cell) => ({ bbox: cell.bbox, spans: [cell.colSpan, cell.rowSpan], blocks: cell.blocks.map((child) => ({ kind: child.kind, bbox: child.bbox, text: child.kind === 'text' ? child.runs.map((r) => r.text).join('') : undefined })) }))) }, null, 2))
  } else {
    console.log(JSON.stringify({ kind: block.kind, bbox: block.bbox, line: block.kind === 'shape' ? block.line : undefined, text: block.kind === 'text' ? block.runs.map((r) => r.text).join('') : undefined, assetId: block.kind === 'image' ? block.assetId : undefined }))
  }
}
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
const pdfPage = await doc.getPage(82)
const ops = await pdfPage.getOperatorList()
const imageOps = ops.fnArray.map((fn: number, i: number) => ({ fn, args: ops.argsArray[i] })).filter((entry: any) => entry.fn === pdfjs.OPS.paintImageXObject || entry.fn === pdfjs.OPS.paintInlineImageXObject || entry.fn === pdfjs.OPS.paintImageMaskXObject)
console.log('IMAGE OPS', JSON.stringify(imageOps.map((entry: any) => ({ fn: entry.fn, args: entry.args })), null, 2).slice(0, 12000))
