import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const document = await PDFDocument.create()
const page = document.addPage([595.3, 841.9])
const font = await document.embedFont(StandardFonts.Courier)
const codeLines = ['public static void main(String[] args) {','  final HTTPAgent agent = new HTTPAgent("http://localhost");','  System.out.println(agent);','}']
codeLines.forEach((line, index) => page.drawText(line, { x: 102, y: 700 - index * 19, size: 9, font }))
const bytes = await document.save()
const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
const p = await pdf.getPage(1)
for (const opts of [undefined, { disableCombineTextItems: true }, { includeMarkedContent: true }]) {
  const tc = await p.getTextContent(opts)
  console.log('OPTS', JSON.stringify(opts), JSON.stringify(tc.items.map((i:any)=>({s:i.str,t:i.transform,w:i.width,h:i.height,e:i.hasEOL,font:i.fontName}))))
}
const ops = await p.getOperatorList()
for (let i=0;i<ops.fnArray.length;i++) {
  const fn=ops.fnArray[i]
  if (fn===pdfjs.OPS.showText || fn===pdfjs.OPS.showSpacedText || fn===pdfjs.OPS.nextLineShowText || fn===pdfjs.OPS.nextLineSetSpacingShowText) console.log('TEXT',i,fn,JSON.stringify(ops.argsArray[i]))
}
