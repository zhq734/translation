import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const document = await PDFDocument.create()
const page = document.addPage([595.3, 841.9])
const font = await document.embedFont(StandardFonts.Courier)
const codeLines = [
  'packet.metadata(Const.Meta.CUSTOM_DATA, en.getValue());',
  'final HTTPAgent agent = new HTTPAgent("http://192.168.31.5:9");',
  'agent.setConnectionTimeout(3000);'
]
codeLines.forEach((line, index) => page.drawText(line, { x: 102, y: 700 - index * 19, size: 9, font }))
const borderColor = rgb(0.81, 0.81, 0.81)
for (const bottom of [694, 675, 656]) {
  page.drawRectangle({ x: 89.14, y: bottom, width: 0.72, height: 19, color: borderColor })
  page.drawRectangle({ x: 517.29, y: bottom, width: 0.72, height: 19, color: borderColor })
}
for (const y of [713, 694, 675, 656]) {
  page.drawRectangle({ x: 89.14, y, width: 428.87, height: 0.72, color: borderColor })
}
const bytes = await document.save()
const runtime = await import('pdfjs-dist/legacy/build/pdf.js')
const worker = await import('pdfjs-dist/legacy/build/pdf.worker.js')
const pdfjs = ('default' in runtime ? runtime.default : runtime) as any
const workerModule = ('default' in worker ? worker.default : worker) as any
;(globalThis as any).pdfjsWorker = workerModule
const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
const pdfPage = await pdf.getPage(1)
const viewport = pdfPage.getViewport({ scale: 1 })
const textContent = await pdfPage.getTextContent()
console.log('TEXT ITEMS', textContent.items.map((item: any) => ({
  str: item.str,
  transform: item.transform,
  width: item.width,
  height: item.height
})))
const operatorList = await pdfPage.getOperatorList()
const lineFns = operatorList.fnArray.map((fn: number, index: number) => ({ fn, args: operatorList.argsArray[index] }))
console.log('RECT OPS', lineFns.filter((entry: any) => entry.fn === pdfjs.OPS.rectangle || entry.fn === pdfjs.OPS.fill))
const model = await parsePdfDocument({
  path: '/tmp/filled-multiline-code-frame.pdf',
  fileName: 'filled-multiline-code-frame.pdf',
  format: 'pdf',
  sha256: 'fixture-sha256',
  bytes
})
console.log(JSON.stringify(model.pages[0]!.blocks.map((block) => ({
  kind: block.kind,
  role: block.kind === 'text' ? block.role : undefined,
  bbox: block.bbox,
  text: block.kind === 'text' ? block.runs.map((run) => run.text).join('') : undefined,
  line: block.kind === 'shape' ? block.line : undefined
})), null, 2))
