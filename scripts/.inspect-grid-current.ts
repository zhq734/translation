import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const document = await PDFDocument.create()
const page = document.addPage([600, 800])
const font = await document.embedFont(StandardFonts.Helvetica)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
const image = await document.embedPng(png)
const drawY = (y: number): number => page.getHeight() - y
page.drawText('Certificate', { x: 82, y: drawY(105), size: 12, font })
page.drawText('Barcode', { x: 310, y: drawY(105), size: 12, font })
page.drawImage(image, { x: 360, y: drawY(150), width: 80, height: 40 })
for (const y of [70, 130, 190]) page.drawLine({ start: { x: 72, y: drawY(y) }, end: { x: 528, y: drawY(y) }, thickness: 1 })
for (const x of [72, 300, 528]) page.drawLine({ start: { x, y: drawY(190) }, end: { x, y: drawY(70) }, thickness: 1 })
const bytes = await document.save()
const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
const p = await pdf.getPage(1)
const ops = await p.getOperatorList()
for (let i=0;i<ops.fnArray.length;i++) {
 const name=Object.entries(pdfjs.OPS).find(([,v])=>v===ops.fnArray[i])?.[0]
 if (['constructPath','stroke','closeStroke','fillStroke','closeFillStroke','fill','eoFill','transform','paintFormXObjectBegin','paintFormXObjectEnd'].includes(name!)) console.log(i,name,JSON.stringify(ops.argsArray[i]))
}
