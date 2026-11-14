const fs = require('node:fs')
const pdfjs = require('/Users/mac/E/github/translation/node_modules/pdfjs-dist/legacy/build/pdf.js')

const file = process.argv[2]

;(async () => {
  const data = new Uint8Array(fs.readFileSync(file))
  const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise
  console.log('pages:', doc.numPages)
  const limit = Math.min(doc.numPages, Number(process.argv[3] || 6))
  let totalText = 0
  let totalImages = 0
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    let textLen = 0
    if (i <= limit) {
      const tc = await page.getTextContent()
      textLen = tc.items.reduce((n, it) => n + (typeof it.str === 'string' ? it.str.length : 0), 0)
      totalText += textLen
    }
    let images = 0
    if (i <= limit) {
      const ops = await page.getOperatorList()
      for (const fn of ops.fnArray) {
        if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) images += 1
      }
      totalImages += images
    }
    if (i <= limit) console.log(`page ${i}: ${Math.round(vp.width)}x${Math.round(vp.height)}pt textLen=${textLen} images=${images}`)
    if (i % 20 === 0) console.log(`... scanned ${i} pages`)
  }
  console.log(`first ${limit} pages: textLen=${totalText} images=${totalImages}`)
})().catch((e) => { console.error('FAILED', e.message); process.exit(1) })
