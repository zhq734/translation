import { readFileSync } from 'node:fs'
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.js')
const worker = await import('pdfjs-dist/legacy/build/pdf.worker.js')
globalThis.pdfjsWorker = worker.default ?? worker
const runtime = pdfjs.default ?? pdfjs
const bytes = new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf'))
const doc = await runtime.getDocument({ data: bytes, useSystemFonts: false, isEvalSupported: false }).promise
const page = await doc.getPage(2)
const textContent = await page.getTextContent()
const styles = textContent.styles ?? {}
for (const key of ['g_d0_f62','g_d0_f73','g_d0_f112','g_d0_f113']) {
  const s = styles[key]
  console.log(key, '=>', JSON.stringify(s))
}
// 也直接看 commonObjs
for (const key of ['g_d0_f62','g_d0_f73']) {
  try {
    const o = await page.commonObjs.get(key)
    console.log('commonObjs', key, '=>', JSON.stringify({name:o?.name, loadedName:o?.loadedName, fontFamily:o?.fontFamily, fallbackName:o?.fallbackName}))
  } catch(e) { console.log('err', key, e.message) }
}
