import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'

const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)

for (const variant of ['sides', 'rowonly', 'long', 'segments'] as const) {
  const document = await PDFDocument.create()
  const page = document.addPage([595.92, 842.88])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const drawY = (y: number): number => page.getHeight() - y
  const rowTops = variant === 'segments' ? [608, 649, 690, 731] : [330, 372, 414, 456]
  const left = variant === 'segments' ? 51 : variant === 'rowonly' || variant === 'long' ? 53 : 68
  const right = variant === 'segments' ? 552 : variant === 'rowonly' || variant === 'long' ? 543 : 528
  const rows = variant === 'long'
    ? [['requirements-desktop-verification', 'Main', 'Last month'], ['requirements-desktop-verification', 'Docs', 'Last week'], ['requirements-desktop-verification', 'Tests', 'Yesterday']]
    : [['docs', 'Update docs', 'Last month'], ['src', 'Refactor parser', 'Last week'], ['tests', 'Add coverage', 'Yesterday']]
  const xs = variant === 'segments' ? [61, 262, 462] : variant === 'rowonly' || variant === 'long' ? [74, 212, 445] : [78, 220, 455]
  rows.forEach((texts, index) => {
    const y = drawY(rowTops[index]! + 22)
    texts.forEach((text, column) => page.drawText(text, { x: xs[column]!, y, size: 10, font }))
  })
  const bytes = await document.save()
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
  const parsedPage = await pdf.getPage(1)
  const viewport = parsedPage.getViewport({ scale: 1 })
  const content = await parsedPage.getTextContent()
  console.log(`\n${variant}`)
  for (const item of content.items as any[]) {
    if (!item.str?.trim()) continue
    const y = viewport.height - item.transform[5] - (item.height ?? 0)
    console.log(JSON.stringify({ text: item.str, x: +item.transform[4].toFixed(2), y: +y.toFixed(2), width: +item.width.toFixed(2), end: +(item.transform[4] + item.width).toFixed(2) }))
  }
}
