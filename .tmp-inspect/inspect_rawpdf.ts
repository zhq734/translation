import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const bytes = new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf'))
const doc = await getDocument({ data: bytes, useSystemFonts: false, isEvalSupported: false }).promise
const page = await doc.getPage(2) // page index 1 => 1-based 2
const textContent = await page.getTextContent()
console.log('STYLES KEYS:')
for (const [k, v] of Object.entries(textContent.styles ?? {})) {
  const s: any = v
  console.log(JSON.stringify({ key: k, fontFamily: s.fontFamily, fontName: s.fontName, name: s.name, bold: s.bold, loadedName: s.loadedName }))
}
console.log('--- items with style ---')
for (const item of textContent.items as any[]) {
  console.log(JSON.stringify({ str: item.str.slice(0,20), fontName: item.fontName }))
}
