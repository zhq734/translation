import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule)
;(globalThis).pdfjsWorker = pdfjsWorker

const doc = await PDFDocument.create()
const page = doc.addPage([200, 200])
const font = await doc.embedFont(StandardFonts.Helvetica)
page.drawText('HIDDEN SOURCE', { x: 20, y: 100, size: 12, font, color: rgb(0,0,0), opacity: 0 })
page.drawText('VISIBLE TRANSLATION', { x: 20, y: 60, size: 12, font, color: rgb(0,0,0) })
const bytes = await doc.save()
const contents = page.node.Contents()
console.log('content stream:')
console.log(contents.toString())
const loaded = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
const tc = await (await loaded.getPage(1)).getTextContent()
console.log('extracted:', tc.items.map(i => i.str).join('|'))
await loaded.destroy()
